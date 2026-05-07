import { Cell } from './cell';
import { Reaction } from './reaction';
import { dist2 } from './vec2';
import { NoiseConfig, EventLog, applyCopyMisfire, applyBondFail, DEFAULT_NOISE } from './noise';

// x, y, z are wildcard type tokens — they match any atom type.
// If the same letter appears in two positions (e.g. aType='x' and bType='x'),
// the two atoms must share the same concrete type.
const WILDCARDS = new Set(['x', 'y', 'z']);

function typeMatches(rType: string, cellType: string): boolean {
  // Water atoms ('w') never match wildcard rules — only explicit 'w' rules.
  // Otherwise water gets pulled into unrelated reactions (gene templating,
  // membrane elasticity, etc.) which would corrupt living chemistry.
  if (cellType === 'w') return rType === 'w';
  return WILDCARDS.has(rType) || rType === cellType;
}

function sameWildcard(t1: string, t2: string): boolean {
  return WILDCARDS.has(t1) && t1 === t2;
}

function testProb(cases: number): boolean {
  return cases <= 1 || Math.random() < 1 / cases;
}

// Per-reaction noise context — module-scoped because applyBond is a
// nested helper inside tryReaction and threading the context through
// every signature would just be visual noise. Set at the top of react()
// and read inside applyBond.
let _ctxCfg:  NoiseConfig = DEFAULT_NOISE;
let _ctxLog:  EventLog | null = null;
let _ctxIter = 0;

function applyBond(a: Cell, b: Cell, current: boolean, future: boolean): void {
  if (current === future) return;
  // Bond-failure hook: with probability bondFailRate, the requested bond
  // change does NOT occur. State changes from the reaction itself still
  // commit (the chemistry "tried" but the bond didn't take), which mirrors
  // a real partial-reaction event. Logged for later analysis.
  let actual = future;
  if (_ctxLog !== null) {
    actual = applyBondFail(_ctxCfg, _ctxLog, _ctxIter, a, b, current, future);
  }
  if (actual === current) return;
  if (current && !actual) a.debond(b);
  else if (!current && actual) a.bondTo(b);
}

function tryReaction(
  cell: Cell,
  nearby: Cell[],
  r: Reaction,
  reactionRange2: number,
): boolean {
  if (!typeMatches(r.aType, cell.type)) return false;
  if (r.aState !== cell.state) return false;

  for (const b of nearby) {
    if (b === cell) continue;
    if (r.bState !== b.state) continue;
    if (!typeMatches(r.bType, b.type)) continue;
    if (sameWildcard(r.bType, r.aType) && b.type !== cell.type) continue;

    const hasAbBond = cell.bonds.has(b);
    if (r.currentAbBond !== hasAbBond) continue;

    if (r.nInputs === 3) {
      for (const c of nearby) {
        if (c === b || c === cell) continue;
        if (r.cState !== c.state) continue;
        if (!typeMatches(r.cType, c.type)) continue;
        if (sameWildcard(r.cType, r.aType) && c.type !== cell.type) continue;
        if (sameWildcard(r.cType, r.bType) && c.type !== b.type) continue;

        if (r.currentAcBond !== cell.bonds.has(c)) continue;
        if (r.currentBcBond !== b.bonds.has(c)) continue;
        if (dist2(c.loc, b.loc) >= reactionRange2) continue;
        if (!testProb(r.cases)) continue;

        cell.state = r.futureAState;
        b.state = r.futureBState;
        c.state = r.futureCState;
        applyBond(cell, b, r.currentAbBond, r.futureAbBond);
        applyBond(b, c, r.currentBcBond, r.futureBcBond);
        applyBond(cell, c, r.currentAcBond, r.futureAcBond);
        return true;
      }
    } else {
      if (!testProb(r.cases)) continue;
      cell.state = r.futureAState;
      b.state = r.futureBState;
      applyBond(cell, b, r.currentAbBond, r.futureAbBond);
      return true;
    }
  }
  return false;
}

// Track which atoms participated in the most recent reaction so the
// copy-misfire hook has a candidate list to perturb. Cleared at top of
// each react() call. Sized 3 because reactions are at most ternary.
const _lastProducts: Cell[] = [];

function tryReactionWithProducts(
  cell: Cell, nearby: Cell[], r: Reaction, reactionRange2: number,
): boolean {
  if (!typeMatches(r.aType, cell.type)) return false;
  if (r.aState !== cell.state) return false;

  for (const b of nearby) {
    if (b === cell) continue;
    if (r.bState !== b.state) continue;
    if (!typeMatches(r.bType, b.type)) continue;
    if (sameWildcard(r.bType, r.aType) && b.type !== cell.type) continue;

    const hasAbBond = cell.bonds.has(b);
    if (r.currentAbBond !== hasAbBond) continue;

    if (r.nInputs === 3) {
      for (const c of nearby) {
        if (c === b || c === cell) continue;
        if (r.cState !== c.state) continue;
        if (!typeMatches(r.cType, c.type)) continue;
        if (sameWildcard(r.cType, r.aType) && c.type !== cell.type) continue;
        if (sameWildcard(r.cType, r.bType) && c.type !== b.type) continue;

        if (r.currentAcBond !== cell.bonds.has(c)) continue;
        if (r.currentBcBond !== b.bonds.has(c)) continue;
        if (dist2(c.loc, b.loc) >= reactionRange2) continue;
        if (!testProb(r.cases)) continue;

        cell.state = r.futureAState;
        b.state = r.futureBState;
        c.state = r.futureCState;
        applyBond(cell, b, r.currentAbBond, r.futureAbBond);
        applyBond(b, c, r.currentBcBond, r.futureBcBond);
        applyBond(cell, c, r.currentAcBond, r.futureAcBond);
        _lastProducts.length = 0;
        _lastProducts.push(cell, b, c);
        return true;
      }
    } else {
      if (!testProb(r.cases)) continue;
      cell.state = r.futureAState;
      b.state = r.futureBState;
      applyBond(cell, b, r.currentAbBond, r.futureAbBond);
      _lastProducts.length = 0;
      _lastProducts.push(cell, b);
      return true;
    }
  }
  return false;
}

export class Chemistry {
  private reactions: Reaction[] = [];
  mutationRate = 0; // legacy wild-mode knob; superseded by NoiseConfig

  add(r: Reaction): void {
    this.reactions.push(r);
  }

  clear(): void {
    this.reactions.length = 0;
  }

  react(
    cell: Cell, nearby: Cell[], reactionRange2: number,
    noise?: NoiseConfig, log?: EventLog, iter?: number,
  ): boolean {
    // Set the module-scoped context so applyBond can see noise refs.
    _ctxCfg  = noise ?? DEFAULT_NOISE;
    _ctxLog  = log ?? null;
    _ctxIter = iter ?? 0;
    for (const rxn of this.reactions) {
      const fired = (noise && log)
        ? tryReactionWithProducts(cell, nearby, rxn, reactionRange2)
        : tryReaction(cell, nearby, rxn, reactionRange2);
      if (fired) {
        // Legacy mutation knob (kept for back-compat with wild mode rerolls).
        if (this.mutationRate > 0 && Math.random() < this.mutationRate) {
          legacyMutate(cell);
        }
        // Primitive-level copy misfire — the principled noise source.
        if (noise && log && _lastProducts.length > 0) {
          applyCopyMisfire(noise, log, iter ?? 0, _lastProducts);
        }
        _ctxLog = null;
        return true;
      }
    }
    _ctxLog = null;
    return false;
  }
}

function legacyMutate(cell: Cell): void {
  // Drift one of the participating atom states by ±1 (small mutation, can compound)
  const delta = Math.random() < 0.5 ? -1 : 1;
  cell.state = Math.max(0, Math.min(50, cell.state + delta));
}
