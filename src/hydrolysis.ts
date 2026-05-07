// Hydrolysis decomposition for Primordium.
// Water becomes a real atom type ('w'). Hydrolysis is implemented as a
// per-tick sweep where each FRESH water atom (state 0) can break ONE
// nearby non-protected bond per tick. On firing, the water transitions
// to state 1 ("spent" — chemically it has been incorporated into the
// broken bond as H and OH groups, but we lump that into a state change
// to preserve mass exactly. No atom is ever deleted by hydrolysis.)
//
// Mass conservation: total atom count is preserved across hydrolysis
// events. Spent water (state 1) remains in the droplet and accumulates
// over time, so droplets visibly "saturate" as they do work. Fresh water
// production requires user intervention (paint more water, drip-feed).
//
// Living cells are protected via a live-cell-graph rule: bonds whose
// endpoints are both part of a closed `a-a-a` loop with `e/f` endpoints
// (or transitively bonded to one) are exempt. Models the protection that
// real cells get from active membrane maintenance, which Squirm3 doesn't
// simulate explicitly.
//
// Reproducibility: every Math.random() goes through the worker's seeded
// mulberry32. When the hydrolysis toggle is OFF, no water is generated
// and the sweep returns immediately, so the sim is bit-identical to
// pre-hydrolysis behavior.

import { Cell, RADIUS } from './cell';
import { Grid } from './grid';
import { EventLog, KIND_HYDROLYSIS, KIND_WATER_USED } from './noise';

export interface HydrolysisConfig {
  enabled: boolean;
  baseRate:    number; // multiplier on per-bond-pair hydrolysis probability
  waterDensity: number; // water atoms per square grid unit when generating
}

export const DEFAULT_HYDROLYSIS: HydrolysisConfig = {
  enabled: false,
  baseRate: 1.0,
  // Default density chosen to balance decomposition capacity vs perf.
  // 0.001 atoms per square unit → ~320 water atoms in a r=320 droplet,
  // ~1600 total in a 5-drop default sim. Enough to decompose several
  // dozen-atom corpses before saturating.
  waterDensity: 0.001,
};

// Per-bond-type-pair hydrolysis probability per encounter. Lipid (a-a)
// most stable, gene chain bonds least stable, anchors (a-e, a-f) middle.
const BOND_RATES: Record<string, number> = {
  'a-a': 1e-4,
  'a-e': 5e-4,
  'a-f': 5e-4,
  'e-b': 1e-3,
  'b-b': 1e-3,
  'b-c': 1e-3,
  'b-d': 1e-3,
  'c-d': 1e-3,
  'd-f': 1e-3,
};
const DEFAULT_BOND_RATE = 5e-4;

function bondPairRate(typeA: string, typeB: string): number {
  const key = typeA < typeB ? `${typeA}-${typeB}` : `${typeB}-${typeA}`;
  return BOND_RATES[key] ?? DEFAULT_BOND_RATE;
}

// Water atom states (kept separate from chemistry state spaces).
export const W_FRESH = 0;
export const W_SPENT = 1;

// ── Water atom generation ─────────────────────────────────────────────────
export function generateWaterForDroplet(
  grid: Grid, x: number, y: number, r: number, density: number,
): number {
  const area = Math.PI * r * r;
  const targetCount = Math.max(1, Math.floor(area * density));
  let made = 0;
  for (let i = 0; i < targetCount; i++) {
    const u = Math.random();
    const ang = Math.random() * Math.PI * 2;
    const rad = r * Math.sqrt(u);
    const wx = x + Math.cos(ang) * rad;
    const wy = y + Math.sin(ang) * rad;
    if (wx >= 0 && wx <= grid.width && wy >= 0 && wy <= grid.height) {
      grid.createCell(wx, wy, 'w', W_FRESH);
      made++;
    }
  }
  return made;
}

export function generateWaterForAllDroplets(grid: Grid, density: number): number {
  let total = 0;
  for (const d of grid.droplets) {
    total += generateWaterForDroplet(grid, d.x, d.y, d.r, density);
  }
  return total;
}

export function removeAllWater(grid: Grid): number {
  const cells = grid.getCells();
  const water: Cell[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].type === 'w') water.push(cells[i]);
  }
  for (const w of water) grid.removeCell(w);
  return water.length;
}

// ── Live-cell graph marking ───────────────────────────────────────────────
// BFS from every closed `a-a-a` loop with both `e` and `f` endpoints
// (the alive-marker). Marks reachable atoms; bonds where both endpoints
// are marked are exempt from hydrolysis. Models the protection that real
// living cells get from continuous membrane maintenance.
//
// Reset is via an epoch counter rather than per-cell flag clearing — this
// avoids the O(n) reset pass when running every tick. Each cell stores
// its last "marked-live" tick, and protection check is "live-tick == now."

let _liveEpoch = 0;
export function markLiveCellAtoms(cells: Cell[], iter: number): void {
  // Use the iter as the epoch. Cells' inLiveCell flag is "are you live
  // as of iter X?" via the _liveCheckedAt field. Skipping the reset pass
  // saves O(n) per tick (no inLiveCell=false sweep needed).
  _liveEpoch = iter >>> 0 | 0;

  const visitedLoopAtom = new Set<Cell>();
  for (const start of cells) {
    if (start.type !== 'a' || visitedLoopAtom.has(start)) continue;

    let first: Cell | undefined, second: Cell | undefined;
    for (const b of start.bonds) {
      if (b.type !== 'a') continue;
      if (!first) first = b; else { second = b; break; }
    }
    if (!first || !second) continue;

    const chain: Cell[] = [start];
    let prev = start;
    let curr: Cell = first;
    while (curr !== start && chain.length < 500) {
      chain.push(curr);
      let next: Cell | undefined;
      for (const b of curr.bonds) {
        if (b.type === 'a' && b !== prev) { next = b; break; }
      }
      if (!next) break;
      prev = curr;
      curr = next;
    }
    if (curr !== start || chain.length < 4) continue;

    let hasE = false, hasF = false;
    for (const c of chain) {
      for (const b of c.bonds) {
        if (b.type === 'e') hasE = true;
        else if (b.type === 'f') hasF = true;
      }
      if (hasE && hasF) break;
    }
    if (!(hasE && hasF)) {
      for (const c of chain) visitedLoopAtom.add(c);
      continue;
    }

    const queue: Cell[] = [];
    for (const c of chain) {
      visitedLoopAtom.add(c);
      if (c.liveCheckedAt !== _liveEpoch) {
        c.liveCheckedAt = _liveEpoch;
        queue.push(c);
      }
    }
    while (queue.length > 0) {
      const c = queue.shift()!;
      for (const b of c.bonds) {
        if (b.liveCheckedAt !== _liveEpoch) {
          b.liveCheckedAt = _liveEpoch;
          queue.push(b);
        }
      }
    }
  }
}

function isLive(c: Cell): boolean {
  return c.liveCheckedAt === _liveEpoch;
}

// ── Hydrolysis sweep ──────────────────────────────────────────────────────
// Each FRESH water atom (state 0) attempts ONE bond hydrolysis per tick.
// On success, the water transitions to state 1 (spent) — mass conserved.
// Spent water never catalyzes again until externally reset (e.g., user
// repaints water, which removes existing droplet population and creates
// new fresh water).
//
// Performance: only iterates fresh water atoms (state 0). Spent water
// is no-op. Over time as a droplet does work, fewer atoms participate
// in the sweep, so per-tick cost falls naturally.

export function applyHydrolysisSweep(
  grid: Grid, cfg: HydrolysisConfig, log: EventLog, iter: number,
): void {
  if (!cfg.enabled) return;
  const cells = grid.getCells();
  if (cells.length === 0) return;

  // Refresh live-cell flags via epoch increment (cheap, no reset pass).
  markLiveCellAtoms(cells, iter);

  // Collect fresh water atoms only. Spent water (state 1) is skipped.
  // Allocating a small array per tick is fine — it's bounded by water
  // count and we'd iterate them anyway.
  let waterCount = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c.type === 'w' && c.state === W_FRESH) waterCount++;
  }
  if (waterCount === 0) return;

  const SEARCH_R = RADIUS * 2.5;
  const baseRate = cfg.baseRate;

  for (let i = 0; i < cells.length; i++) {
    const w = cells[i];
    if (w.type !== 'w' || w.state !== W_FRESH) continue;

    // Find nearest non-protected bonded pair.
    const nearby = grid.getAllWithinRadius(w.loc.x, w.loc.y, SEARCH_R);
    let bestA: Cell | null = null;
    let bestB: Cell | null = null;
    let bestD2 = Infinity;
    for (const a of nearby) {
      if (a === w) continue;
      if (a.type === 'w') continue;
      if (a.bonds.size === 0) continue;
      if (isLive(a)) continue;
      for (const b of a.bonds) {
        if (b.type === 'w') continue;
        if (isLive(b)) continue;
        const mx = (a.loc.x + b.loc.x) * 0.5;
        const my = (a.loc.y + b.loc.y) * 0.5;
        const dx = mx - w.loc.x, dy = my - w.loc.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (bestA === null || bestB === null) continue;

    const rate = bondPairRate(bestA.type, bestB.type) * baseRate;
    if (Math.random() >= rate) continue;

    // Hydrolysis fires. Break bond, denature both atoms, mark water spent.
    // No deletion — total atom count is preserved.
    const aId = bestA.id, bId = bestB.id;
    bestA.debond(bestB);
    bestA.state = 0;
    bestB.state = 0;
    w.state = W_SPENT;
    log.push(iter, KIND_HYDROLYSIS, aId, bId, 1, 0);
    log.push(iter, KIND_WATER_USED, w.id, 0, W_FRESH, W_SPENT);
  }
}
