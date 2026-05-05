/**
 * Faithful port of SquirmGrid::InitSimple() from Tim Hutton's squirm3.
 * Seeds the grid with 47 reactions and one hand-built self-replicating cell.
 *
 * Atom types:  a (membrane), b/c (genome bases), d (enzyme), e (genome start), f (genome end)
 * Key states:  S=39 (standard membrane), T=40 (tagged membrane end), E=41 (enzyme walk state)
 *
 * Original paper: Hutton T.J. (2007) Artificial Life 13(1):11–30
 * Original code:  https://github.com/timhutton/squirm3  (GPL v3)
 */

import { Grid } from './grid';
import { Cell, RADIUS } from './cell';
import { r2, r3 } from './reaction';

const S   = 39; // prey membrane resting state
const T   = 40; // prey membrane tagged terminal
const E   = 41; // enzyme walk state
export const Q   = 42; // predator membrane resting state
const FREED      = 44; // freed prey membrane atom — predator stretch prioritises this

export function initSimple(
  grid: Grid,
  cellCenters: [number, number][],
  backgroundCount: number,
): void {
  const c = grid.getChemistry();

  // ── Membrane elasticity ──────────────────────────────────────────────────
  // Crumpled membrane sheds an atom
  c.add(r3('a', S, true,  'a', S, true,  'a', S, false, S, false, 0, false, S, true,  100));
  // Stretched membrane acquires a free atom
  c.add(r3('a', S, true,  'a', S, false, 'a', 0, false, S, false, S, true,  S, true,  100));
  // Variants allowing T-tagged sites
  c.add(r3('a', S, true,  'a', T, false, 'a', 0, false, S, false, T, true,  S, true));
  c.add(r3('a', T, true,  'a', T, false, 'a', 0, false, T, false, T, true,  S, true));

  // ── Enzyme production ────────────────────────────────────────────────────
  // Start reading the gene: an active (state 35) gene atom + nearby free d-atom
  c.add(r3('x', 35, true, 'y', 17, false, 'd', 0, false,  1, true, 38, true, E, false));
  // Step the enzyme along: d walks the template, reading a/b/c
  c.add(r3('d', E, true,  'a', 38, true,  'y', 17, false, E, false, 1, true, 38, true));
  c.add(r3('d', E, true,  'b', 38, true,  'y', 17, false, E, false, 1, true, 38, true));
  c.add(r3('d', E, true,  'c', 38, true,  'y', 17, false, E, false, 1, true, 38, true));
  // End of gene: enzyme releases and resets
  c.add(r3('d', E, true,  'd', 38, false, 'd', 0, false,  E, false, 35, false, E, true));
  c.add(r2('d', E, true,  'f', 38,        0, false, 1, false));

  // ── DNA replication (template zippering) ─────────────────────────────────
  c.add(r2('x', 2, true,  'y', 1,  7, true,  4, false));
  c.add(r2('x', 4, false, 'y', 3,  5, true,  7, false));
  c.add(r2('x', 5, false, 'x', 0,  6, true,  6, false));
  c.add(r2('x', 6, false, 'y', 7,  3, true,  4, false));
  c.add(r2('x', 6, true,  'y', 4,  1, false, 2, false));
  c.add(r2('x', 7, true,  'y', 1,  2, true,  2, false));

  // ── Strand splitting ─────────────────────────────────────────────────────
  c.add(r2('x', 2, true,  'y', 8,  9, true,  1, false));
  c.add(r2('x', 9, true,  'y', 9,  8, false, 8, false));

  // ── Start duplication ────────────────────────────────────────────────────
  c.add(r2('a', T, true,  'e', 1,  10, true, 5,  false));
  c.add(r2('a', 10, false,'e', 6,  T,  true, 3,  false));
  c.add(r2('e', 6, true,  'e', 3,  2,  true, 3,  false));

  // ── Start splitting ──────────────────────────────────────────────────────
  c.add(r2('f', 2, true,  'a', T,  9,  true, 11, false));
  c.add(r2('a', 11, false,'f', 3,  11, true, 9,  false));

  // ── Start cell division ──────────────────────────────────────────────────
  c.add(r2('a', 11, true, 'a', S,  11, true, 12, false));
  c.add(r2('f', 1, false, 'a', 12, 13, true, T,  false));

  // ── Pulling sequence ─────────────────────────────────────────────────────
  c.add(r2('x', 13, true, 'y', 1,  14, true, 15, false));
  c.add(r2('a', 11, false,'x', 15, 11, true, 16, false));
  c.add(r2('x', 14, true, 'y', 16, 29, true, 16, false)); // borrows state 29
  c.add(r2('x', 29, true, 'a', 11, 17, false,11, false));
  c.add(r2('x', 17, true, 'y', 16, 17, true, 13, false));
  c.add(r2('x', 13, true, 'e', 8,  14, true, 15, false));

  // ── Finish cell division ─────────────────────────────────────────────────
  c.add(r2('e', 13, true, 'a', T,  18, true, 19, false));
  c.add(r2('e', 13, true, 'a', 19, 18, true, 20, false));
  c.add(r2('a', 20, false,'a', 11, 21, true, 22, false));
  c.add(r2('e', 18, true, 'a', 22, 35, false,23, false)); // borrows state 35
  c.add(r2('e', 18, true, 'a', 21, 35, false,24, false));
  c.add(r2('a', 23, true, 'a', T,  25, true, 26, false));
  c.add(r2('a', 25, true, 'a', T,  27, true, 26, false));
  c.add(r2('a', 24, false,'a', 26, 28, true, 29, false));
  c.add(r2('a', 29, true, 'a', 27, T,  false,30, false));
  c.add(r2('a', 30, true, 'a', 26, 31, true, T,  false));
  c.add(r2('a', 28, true, 'a', S,  32, true, 33, false));
  c.add(r2('a', 32, true, 'a', S,  34, true, 33, false));
  c.add(r2('a', 33, false,'a', 31, S,  true, 36, false));
  c.add(r2('a', 34, true, 'a', S,  35, false,S,  false));
  c.add(r2('a', 35, true, 'a', 33, 37, true, S,  false));
  c.add(r2('a', 37, true, 'a', 36, T,  false,T,  false));

  // ── Lysin reaction ───────────────────────────────────────────────────────
  // A free 'p' (lysin) atom catalyzes the breaking of a membrane S–S bond.
  // p stays state 0 (pure catalyst); one membrane atom is shed back to soup.
  // cases=10 so lysis is dangerous but not instantly lethal.
  c.add(r3('a', S, true, 'a', S, false, 'p', 0, false, S, false, 0, false, 0, false, 10));

  // ── Predator membrane elasticity ─────────────────────────────────────────
  // Predators have NO division and NO gene — avoids cross-reactions with prey
  // division machinery (shared gene state spaces 1–9 caused prey membrane to
  // spontaneously appear inside predators).
  // Stretch absorbs soup atoms (survival) and FREED prey atoms (feeding bonus).
  c.add(r3('a', Q, true, 'a', Q, false, 'a', 0,     false, Q, false, Q, true, Q, true, 100));
  c.add(r3('a', Q, true, 'a', Q, false, 'a', FREED,  false, Q, false, Q, true, Q, true, 50));

  // ── Predator attack — contact-dependent killing ───────────────────────────
  // Predator Q-membrane atom adjacent to a prey S–S bond → break the bond.
  // Freed prey atom gets state FREED (44) — only predator stretch absorbs it.
  // cases=3: fires ~33% per contact encounter. Aggressive but survivable for prey.
  c.add(r3('a', S, true, 'a', S, false, 'a', Q, false, S, false, FREED, false, Q, false, 3));

  // ── Build cells at each requested center position ───────────────────────
  for (const [cx, cy] of cellCenters) {
    buildCell(grid, cx, cy);
  }

  // ── Background soup ──────────────────────────────────────────────────────
  const TYPES = 'aaaaabcdef'; // biased toward 'a' to match original
  for (let i = 0; i < backgroundCount; i++) {
    grid.createCell(
      Math.random() * grid.width,
      Math.random() * grid.height,
      TYPES[Math.floor(Math.random() * TYPES.length)],
      0,
    );
  }
}

// ── Build one self-replicating cell centered at (cx, cy) ──────────────────
export function buildCell(grid: Grid, cx: number, cy: number): void {
  const D  = RADIUS * 2;
  // SX/SY: top-left corner of the gene strand, offset so the structure
  // is centered at (cx, cy)
  const SX = Math.round(cx - 4.5 * D); // gene is 8 atoms wide → center at atom 4.5
  const SY = Math.round(cy);

  // Gene strand:  e – b – b – a – c – b – d – f  (all in state 1)
  const gene = ['e', 'b', 'b', 'a', 'c', 'b', 'd', 'f'].map((t, i) =>
    grid.createCell(SX + (i + 1) * D, SY, t, 1)
  );
  for (let i = 0; i < gene.length - 1; i++) gene[i].bondTo(gene[i + 1]);
  const eEnd = gene[0];
  const fEnd = gene[gene.length - 1];

  // Membrane: a closed loop of 'a' atoms enclosing the gene
  const memLen = 2;
  const memWid = 8;
  const sx = SX;
  const sy = SY - D;

  const memStart = grid.createCell(sx, sy, 'a', T);
  memStart.bondTo(eEnd);
  let prev = memStart;

  for (let i = 0; i < memLen; i++) {
    const c = grid.createCell(sx, sy + (i + 1) * D, 'a', S);
    c.bondTo(prev); prev = c;
  }
  for (let i = 0; i < memWid; i++) {
    const isLast = i === memWid - 1;
    const c = grid.createCell(sx + (i + 1) * D, sy + memLen * D, 'a', isLast ? T : S);
    if (isLast) c.bondTo(fEnd);
    c.bondTo(prev); prev = c;
  }
  for (let i = memLen - 1; i >= 0; i--) {
    const c = grid.createCell(sx + (memWid + 1) * D, sy + (i + 1) * D, 'a', S);
    c.bondTo(prev); prev = c;
  }
  for (let i = memWid; i >= 0; i--) {
    const c = grid.createCell(sx + (i + 1) * D, sy, 'a', S);
    c.bondTo(prev); prev = c;
  }
  prev.bondTo(memStart); // close the loop
}

// ── Build one predator cell centered at (cx, cy) ─────────────────────────────
// Same geometry as prey but membrane atoms use Q/T_Q states instead of S/T.
export function buildPredatorCell(grid: Grid, cx: number, cy: number): void {
  const T_Q = 43; // predator membrane tagged terminal
  const D  = RADIUS * 2;
  const SX = Math.round(cx - 4.5 * D);
  const SY = Math.round(cy);

  const gene = ['e', 'b', 'b', 'a', 'c', 'b', 'd', 'f'].map((t, i) =>
    grid.createCell(SX + (i + 1) * D, SY, t, 1)
  );
  for (let i = 0; i < gene.length - 1; i++) gene[i].bondTo(gene[i + 1]);
  const eEnd = gene[0];
  const fEnd = gene[gene.length - 1];

  const memLen = 2;
  const memWid = 8;
  const sx = SX;
  const sy = SY - D;

  const memStart = grid.createCell(sx, sy, 'a', T_Q);
  memStart.bondTo(eEnd);
  let prev = memStart;

  for (let i = 0; i < memLen; i++) {
    const mc = grid.createCell(sx, sy + (i + 1) * D, 'a', Q);
    mc.bondTo(prev); prev = mc;
  }
  for (let i = 0; i < memWid; i++) {
    const isLast = i === memWid - 1;
    const mc = grid.createCell(sx + (i + 1) * D, sy + memLen * D, 'a', isLast ? T_Q : Q);
    if (isLast) mc.bondTo(fEnd);
    mc.bondTo(prev); prev = mc;
  }
  for (let i = memLen - 1; i >= 0; i--) {
    const mc = grid.createCell(sx + (memWid + 1) * D, sy + (i + 1) * D, 'a', Q);
    mc.bondTo(prev); prev = mc;
  }
  for (let i = memWid; i >= 0; i--) {
    const mc = grid.createCell(sx + (i + 1) * D, sy, 'a', Q);
    mc.bondTo(prev); prev = mc;
  }
  prev.bondTo(memStart);
}

export function seedPredatorCells(grid: Grid, positions: [number, number][]): void {
  for (const [cx, cy] of positions) buildPredatorCell(grid, cx, cy);
}

export function removePredatorCells(grid: Grid): void {
  for (const cell of grid.getCells()) {
    if (isPredatorMem(cell)) {
      cell.breakAllBonds();
      cell.state = 0;
    }
  }
}

function isPredatorMem(cell: Cell): boolean {
  return cell.type === 'a' && cell.state >= Q;
}

// ── Lysin management ──────────────────────────────────────────────────────────

// Sprinkle background "soup" atoms — same biased mix as initSimple's background.
export function seedSoup(grid: Grid, count: number): void {
  const TYPES = 'aaaaabcdef';
  for (let i = 0; i < count; i++) {
    grid.createCell(
      Math.random() * grid.width,
      Math.random() * grid.height,
      TYPES[Math.floor(Math.random() * TYPES.length)],
      0,
    );
  }
}

export function seedLysin(grid: Grid, count: number): void {
  for (let i = 0; i < count; i++) {
    grid.createCell(
      Math.random() * grid.width,
      Math.random() * grid.height,
      'p',
      0,
    );
  }
}

export function removeLysin(grid: Grid): void {
  for (const cell of grid.getCells()) {
    if (cell.type === 'p') cell.type = 'b'; // harmless free base atom
  }
}
