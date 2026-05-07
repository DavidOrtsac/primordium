// Noise injection + event log for Primordium.
// All primitive-level noise sources land here so the chemistry/grid stay
// clean and the event log has a single producer. Three sources ship in v1:
//   • copy misfire — perturb a product after a reaction fires
//   • background decay — random atom perturbation per tick
//   • bond failure — suppress an intended bond change
// Rule mutation (Fork B) is reserved as kind=3 but not implemented.
//
// Reproducibility: every Math.random() call below is the worker's seeded
// mulberry32, so a fixed seed + fixed config produces a bit-identical run
// (including which mutations fire, in which order).

import { Cell } from './cell';

export type NoiseKind = 0 | 1 | 2 | 3 | 4 | 5;
export const KIND_COPY_MISFIRE   = 0;
export const KIND_DECAY          = 1;
export const KIND_BOND_FAIL      = 2;
export const KIND_RULE_FLIP      = 3; // reserved
export const KIND_HYDROLYSIS = 4;
export const KIND_WATER_USED = 5; // mass-conserving: water transitions to state=1, not deleted

// Concrete atom alphabet for random perturbation. We exclude wildcard
// tokens 'x','y','z' (used by the rule matcher) and 'p' (lysin — flipping
// to lysin would dissolve adjacent membranes via the seeded p-rule, which
// is a corruption the user should explicitly opt into, not a default).
export const TYPE_ALPHABET = 'abcdef';
export const MAX_STATE = 50;

export interface NoiseConfig {
  enabled: boolean;
  copyFidelity: number; // P(copy misfire | reaction fires)
  decayRate:    number; // P(decay     | atom × tick)
  bondFailRate: number; // P(bond fail | bond change requested)
}

export const DEFAULT_NOISE: NoiseConfig = {
  enabled: false,
  copyFidelity: 0,
  decayRate:    0,
  bondFailRate: 0,
};

// Pack (typeCode<<16) | state for compact `before`/`after` capture.
function pack(typeCharCode: number, state: number): number {
  return ((typeCharCode & 0xffff) << 16) | (state & 0xffff);
}

// Random in-place perturbation. With prob 0.5 flip the atom's type to
// another letter from the alphabet; otherwise nudge state by ±1, clamped.
function perturbAtomInPlace(cell: Cell): void {
  if (Math.random() < 0.5) {
    let t = TYPE_ALPHABET[Math.floor(Math.random() * TYPE_ALPHABET.length)];
    if (t === cell.type) {
      // Force a real flip rather than a no-op.
      const idx = (TYPE_ALPHABET.indexOf(cell.type) + 1) % TYPE_ALPHABET.length;
      t = TYPE_ALPHABET[idx];
    }
    cell.type = t;
  } else {
    const delta = Math.random() < 0.5 ? -1 : 1;
    cell.state = Math.max(0, Math.min(MAX_STATE, cell.state + delta));
  }
}

// ── Ring-buffer event log ─────────────────────────────────────────────────
// Six parallel Uint32Arrays for cache-friendly bulk copies and zero
// per-event allocation. Capacity is power-of-two so head%cap is a mask.
//
// v2 ring semantics: when full, oldest events are overwritten. Main thread
// can poll for chunks (auto-flush is wired in the worker) so events aren't
// lost as long as the polling cadence is faster than the fill rate.

export interface EventChunk {
  n: number;
  totalEverFired: number;
  droppedSinceLast: number;
  iters:  Uint32Array;
  kinds:  Uint32Array;
  atomA:  Uint32Array;
  atomB:  Uint32Array;
  before: Uint32Array;
  after:  Uint32Array;
}

export class EventLog {
  private readonly cap: number;
  private readonly mask: number;
  private head = 0;       // monotonic write counter
  private tail = 0;       // monotonic read counter
  private readonly iters:  Uint32Array;
  private readonly kinds:  Uint32Array;
  private readonly atomA:  Uint32Array;
  private readonly atomB:  Uint32Array;
  private readonly before: Uint32Array;
  private readonly after:  Uint32Array;
  totalEverFired = 0;
  // Events overwritten by the ring before being drained. Surfaces in the
  // chunk so main can warn the user that the polling cadence is too slow.
  droppedSinceLastDrain = 0;

  constructor(capPow2 = 16) {
    this.cap  = 1 << capPow2;
    this.mask = this.cap - 1;
    this.iters  = new Uint32Array(this.cap);
    this.kinds  = new Uint32Array(this.cap);
    this.atomA  = new Uint32Array(this.cap);
    this.atomB  = new Uint32Array(this.cap);
    this.before = new Uint32Array(this.cap);
    this.after  = new Uint32Array(this.cap);
  }

  push(iter: number, kind: number, atomA: number, atomB: number, before: number, after: number): void {
    const i = this.head & this.mask;
    this.iters[i]  = iter >>> 0;
    this.kinds[i]  = kind;
    this.atomA[i]  = atomA >>> 0;
    this.atomB[i]  = atomB >>> 0;
    this.before[i] = before >>> 0;
    this.after[i]  = after >>> 0;
    this.head++;
    this.totalEverFired++;
    // If the writer has lapped the reader, the oldest unread event was
    // overwritten just now. Advance the reader and tally a drop.
    if (this.head - this.tail > this.cap) {
      this.tail = this.head - this.cap;
      this.droppedSinceLastDrain++;
    }
  }

  size(): number { return this.head - this.tail; }
  fillRatio(): number { return this.size() / this.cap; }

  // Drain all unread events into a fresh chunk. Returned arrays are
  // freshly allocated so the caller can safely transfer them to main.
  drain(): EventChunk {
    const n = this.size();
    const out: EventChunk = {
      n,
      totalEverFired: this.totalEverFired,
      droppedSinceLast: this.droppedSinceLastDrain,
      iters:  new Uint32Array(n),
      kinds:  new Uint32Array(n),
      atomA:  new Uint32Array(n),
      atomB:  new Uint32Array(n),
      before: new Uint32Array(n),
      after:  new Uint32Array(n),
    };
    let r = this.tail;
    for (let i = 0; i < n; i++) {
      const idx = r & this.mask;
      out.iters[i]  = this.iters[idx];
      out.kinds[i]  = this.kinds[idx];
      out.atomA[i]  = this.atomA[idx];
      out.atomB[i]  = this.atomB[idx];
      out.before[i] = this.before[idx];
      out.after[i]  = this.after[idx];
      r++;
    }
    this.tail = this.head;
    this.droppedSinceLastDrain = 0;
    return out;
  }
}

// ── Injection helpers ─────────────────────────────────────────────────────

// Called after a reaction commits its product states. With probability
// equal to copyFidelity, perturbs one of the product cells' type/state.
export function applyCopyMisfire(
  cfg: NoiseConfig, log: EventLog, iter: number, products: Cell[],
): void {
  if (!cfg.enabled || cfg.copyFidelity <= 0 || products.length === 0) return;
  if (Math.random() >= cfg.copyFidelity) return;
  const c = products[Math.floor(Math.random() * products.length)];
  const before = pack(c.type.charCodeAt(0), c.state);
  perturbAtomInPlace(c);
  const after = pack(c.type.charCodeAt(0), c.state);
  log.push(iter, KIND_COPY_MISFIRE, c.id, 0, before, after);
}

// Called once per tick BEFORE chemistry. Sweeps every atom; with
// probability decayRate, perturbs that atom (background radiation analog).
// Uses geometric skip-counting when rate is small to avoid n random calls.
//
// Water atoms ('w') are exempt — they are chemical substrate, not
// chemistry participants. Real H2O doesn't get transmuted by background
// radiation into peptide-like molecules. Skipping water also prevents
// the visible "water becomes random food atoms" bug at high decay rates.
export function applyDecaySweep(
  cfg: NoiseConfig, log: EventLog, iter: number, cells: Cell[],
): void {
  if (!cfg.enabled || cfg.decayRate <= 0 || cells.length === 0) return;
  const r = cfg.decayRate;
  const n = cells.length;
  if (r >= 0.05) {
    // Dense regime — direct per-atom check is cheaper than geometric math.
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      if (c.type === 'w') continue;
      if (Math.random() < r) decayOne(c, log, iter);
    }
  } else {
    // Sparse regime — geometric skip. E[skip] = 1/r. log(1-u)/log(1-r) is
    // the inverse-CDF sample; floor + 1 ensures forward progress.
    const denom = Math.log(1 - r);
    let i = Math.floor(Math.log(1 - Math.random()) / denom);
    while (i < n) {
      const c = cells[i];
      if (c.type !== 'w') decayOne(c, log, iter);
      const skip = Math.floor(Math.log(1 - Math.random()) / denom);
      i += 1 + skip;
    }
  }
}

function decayOne(c: Cell, log: EventLog, iter: number): void {
  const before = pack(c.type.charCodeAt(0), c.state);
  perturbAtomInPlace(c);
  const after = pack(c.type.charCodeAt(0), c.state);
  log.push(iter, KIND_DECAY, c.id, 0, before, after);
}

// Called from inside chemistry.applyBond when a bond change is requested.
// Returns the *actual* future-bonded state — caller uses it instead of the
// intended value. Logs every suppressed change.
export function applyBondFail(
  cfg: NoiseConfig, log: EventLog, iter: number,
  a: Cell, b: Cell, current: boolean, intended: boolean,
): boolean {
  if (current === intended) return intended;
  if (!cfg.enabled || cfg.bondFailRate <= 0) return intended;
  if (Math.random() >= cfg.bondFailRate) return intended;
  const flag = current ? 1 : 0;
  log.push(iter, KIND_BOND_FAIL, a.id, b.id, flag, flag);
  return current;
}
