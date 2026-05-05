// Wild mode — open-ended artificial chemistry.
// Hybrid approach: a small "primer" of guaranteed-useful reactions (bond
// formation, elasticity, sticking) + a much larger pile of random reactions.
// Pre-bonded proto-cell seeds give the chemistry substrates to chew on so
// rerolls produce visible behavior instead of inert soup.

import { Grid } from './grid';
import { Cell, RADIUS } from './cell';
import { r2, r3, Reaction } from './reaction';

// 'p' (lysin/orange) is excluded — it has no Wild-mode meaning and its render
// alpha makes it visually dominate. Bias toward 'a' so chains/rings can form,
// matching the soup mix the rigged sim uses.
const TYPES_BIASED = ['a', 'a', 'a', 'a', 'a', 'b', 'c', 'd', 'e', 'f'];
const TYPES_PLAIN  = ['a', 'b', 'c', 'd', 'e', 'f'];

const MAX_INPUT_STATE  = 12;
const MAX_OUTPUT_STATE = 30;
const CASE_BUCKETS     = [1, 1, 2, 5, 10, 20];

function pickType():     string { return TYPES_PLAIN[Math.floor(Math.random() * TYPES_PLAIN.length)]; }
function pickBiased():   string { return TYPES_BIASED[Math.floor(Math.random() * TYPES_BIASED.length)]; }
function pickInState():  number { return Math.floor(Math.random() * MAX_INPUT_STATE); }
function pickOutState(): number { return Math.floor(Math.random() * MAX_OUTPUT_STATE); }
function pickCases():    number { return CASE_BUCKETS[Math.floor(Math.random() * CASE_BUCKETS.length)]; }
function flip():         boolean { return Math.random() < 0.5; }

function randomR2(): Reaction {
  const curBond = flip();
  return r2(
    pickType(), pickInState(), curBond,
    pickType(), pickInState(),
    pickOutState(), flip(), pickOutState(),
    false,
    pickCases(),
  );
}

function randomR3(): Reaction {
  return r3(
    pickType(), pickInState(), flip(),
    pickType(), pickInState(), flip(),
    pickType(), pickInState(), flip(),
    pickOutState(), flip(),
    pickOutState(), flip(),
    pickOutState(), flip(),
    pickCases(),
  );
}

// Primer reactions — always added, regardless of reroll. These are stripped of
// any specific story; they just give the chemistry the basic building blocks
// (sticking, elasticity, splitting) so visible structures can form.
function addPrimer(grid: Grid): void {
  const c = grid.getChemistry();
  // Stretch: bonded a-a chain absorbs a free a-atom → membrane growth
  c.add(r3('a', 0, true, 'a', 0, false, 'a', 0, false, 0, false, 0, true, 0, true, 50));
  // Crumple: overcrowded a-a-a triangle sheds the third atom
  c.add(r3('a', 0, true, 'a', 0, true, 'a', 0, false, 0, false, 0, false, 0, true, 100));
  // Sticky pairing — generic "any free atom can bond to any free atom of the same type"
  // cases=200 so this is rare, prevents instant gelling
  c.add(r2('a', 0, false, 'a', 0, 0, true, 0, false, 200));
  c.add(r2('b', 0, false, 'b', 0, 0, true, 0, false, 200));
  c.add(r2('c', 0, false, 'c', 0, 0, true, 0, false, 200));
  // Cross-type weak bonds — let chains decorate themselves
  c.add(r2('a', 0, false, 'b', 0, 0, true, 0, false, 400));
  c.add(r2('a', 0, false, 'c', 0, 0, true, 0, false, 400));
  // Spontaneous debond (chemical fatigue) — keeps things from freezing solid
  c.add(r2('a', 0, true, 'a', 0, 0, false, 0, false, 800));
  c.add(r2('a', 0, true, 'b', 0, 0, false, 0, false, 600));
}

export function generateRandomChemistry(grid: Grid, count = 120): void {
  const c = grid.getChemistry();
  c.clear();
  addPrimer(grid);
  for (let i = 0; i < count; i++) {
    c.add(Math.random() < 0.75 ? randomR2() : randomR3());
  }
}

// Drop a small pre-bonded ring of 'a' atoms — a bare proto-cell that the
// random chemistry can either stabilize, mutate, or destroy. Seeds give the
// sim something to watch even before reactions self-organize.
export function seedProtoCell(grid: Grid, cx: number, cy: number, ringSize = 8): void {
  const D = RADIUS * 2;
  const ring: Cell[] = [];
  for (let i = 0; i < ringSize; i++) {
    const angle = (i / ringSize) * Math.PI * 2;
    const x = cx + Math.cos(angle) * D * 1.4;
    const y = cy + Math.sin(angle) * D * 1.4;
    const cell = grid.createCell(x, y, 'a', 0);
    cell.energy = 1.0;
    ring.push(cell);
  }
  for (let i = 0; i < ringSize; i++) ring[i].bondTo(ring[(i + 1) % ringSize]);

  // A sprinkle of inner contents so the ring isn't empty
  for (let i = 0; i < 3; i++) {
    const inner = grid.createCell(
      cx + (Math.random() - 0.5) * D,
      cy + (Math.random() - 0.5) * D,
      pickBiased(),
      Math.floor(Math.random() * MAX_INPUT_STATE),
    );
    inner.energy = 1.0;
  }
}

export function initWild(grid: Grid, atomCount: number, reactionCount = 120): void {
  generateRandomChemistry(grid, reactionCount);

  // Inoculate the dish with proto-cell seeds spread across the arena
  const SEED_COLS = 5;
  const SEED_ROWS = 3;
  for (let i = 0; i < SEED_COLS; i++) {
    for (let j = 0; j < SEED_ROWS; j++) {
      const cx = grid.width  * ((i + 0.5) / SEED_COLS);
      const cy = grid.height * ((j + 0.5) / SEED_ROWS);
      seedProtoCell(grid, cx, cy);
    }
  }

  // Fill the rest with biased free soup
  for (let i = 0; i < atomCount; i++) {
    const type  = pickBiased();
    const state = Math.random() < 0.7 ? 0 : Math.floor(Math.random() * MAX_INPUT_STATE);
    const cell  = grid.createCell(
      Math.random() * grid.width,
      Math.random() * grid.height,
      type,
      state,
    );
    cell.energy = 0.5 + Math.random() * 0.5;
  }

  grid.energyEnabled = true;
  grid.getChemistry().mutationRate = 0.02;
}

// Continuous "nutrient drip" — call once per frame from the main loop while in
// Wild mode. Every few hundred iterations, sprinkles fresh atoms in a corner of
// the arena and occasionally drops a brand-new proto-cell. Prevents the sim
// from settling into dead equilibrium and keeps surprise on tap.
const SPRINKLE_INTERVAL  = 120;   // iterations between fresh-atom drops
const SPRINKLE_COUNT     = 40;
const PROTO_CELL_INTERVAL = 1500; // iterations between brand-new proto-cells
const POPULATION_CAP     = 3500;  // skip drips above this so the dish doesn't gel

export function wildTick(grid: Grid): void {
  const it = grid.iterations;
  if (grid.getCells().length >= POPULATION_CAP) return;
  if (it % SPRINKLE_INTERVAL === 0 && it > 0) {
    for (let i = 0; i < SPRINKLE_COUNT; i++) {
      const cell = grid.createCell(
        Math.random() * grid.width,
        Math.random() * grid.height,
        pickBiased(),
        Math.random() < 0.7 ? 0 : Math.floor(Math.random() * MAX_INPUT_STATE),
      );
      cell.energy = 0.5 + Math.random() * 0.5;
    }
  }
  if (it % PROTO_CELL_INTERVAL === 0 && it > 0) {
    seedProtoCell(
      grid,
      grid.width  * (0.1 + Math.random() * 0.8),
      grid.height * (0.1 + Math.random() * 0.8),
      6 + Math.floor(Math.random() * 6), // ring size 6–11 — varies the seed shape
    );
  }
}
