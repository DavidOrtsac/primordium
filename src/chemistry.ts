import { Cell } from './cell';
import { Reaction } from './reaction';
import { dist2 } from './vec2';

// x, y, z are wildcard type tokens — they match any atom type.
// If the same letter appears in two positions (e.g. aType='x' and bType='x'),
// the two atoms must share the same concrete type.
const WILDCARDS = new Set(['x', 'y', 'z']);

function typeMatches(rType: string, cellType: string): boolean {
  return WILDCARDS.has(rType) || rType === cellType;
}

function sameWildcard(t1: string, t2: string): boolean {
  return WILDCARDS.has(t1) && t1 === t2;
}

function testProb(cases: number): boolean {
  return cases <= 1 || Math.random() < 1 / cases;
}

function applyBond(a: Cell, b: Cell, current: boolean, future: boolean): void {
  if (current && !future) a.debond(b);
  else if (!current && future) a.bondTo(b);
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

export class Chemistry {
  private reactions: Reaction[] = [];
  mutationRate = 0; // wild-mode: prob a successful reaction also flips one product state

  add(r: Reaction): void {
    this.reactions.push(r);
  }

  clear(): void {
    this.reactions.length = 0;
  }

  react(cell: Cell, nearby: Cell[], reactionRange2: number): boolean {
    for (const rxn of this.reactions) {
      if (tryReaction(cell, nearby, rxn, reactionRange2)) {
        if (this.mutationRate > 0 && Math.random() < this.mutationRate) {
          mutate(cell, rxn.nInputs);
        }
        return true;
      }
    }
    return false;
  }
}

function mutate(cell: Cell, _nInputs: 2 | 3): void {
  // Drift one of the participating atom states by ±1 (small mutation, can compound)
  const delta = Math.random() < 0.5 ? -1 : 1;
  cell.state = Math.max(0, Math.min(50, cell.state + delta));
}
