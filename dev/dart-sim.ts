// Micro-simulation probe for the lysin dart mechanic.
// Spawns a player cell and an enemy cell on a small grid, fires a dart
// using the exact same spawnDart/updateDarts code as the worker, then
// steps the grid and reports:
//   - dart trajectory (does thrust carry it to the target?)
//   - enemy loop survival (does the payload destroy the ring?)
//   - player loop survival (self-damage check)
// Build+run:  npx esbuild dev/dart-sim.ts --bundle --platform=node \
//               --format=esm --outfile=/var/tmp/devin/dart-sim.mjs \
//             && node /var/tmp/devin/dart-sim.mjs

import { Grid } from '../src/grid';
import { Cell } from '../src/cell';
import { initSimple, buildCell } from '../src/init';
import { spawnDart, updateDarts } from '../src/dart';

// Deterministic RNG — same mulberry32 patch the worker applies, so the
// lysin grind after a burst is reproducible instead of flaky.
let rngState = 0xC0FFEE;
Math.random = () => {
  rngState = (rngState + 0x6D2B79F5) | 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const W = 800, H = 500;
const PLAYER = { x: 500, y: 250 };
// The enemy sits 40 units off the firing line — without terminal
// guidance the dart would graze past; the homing blend must curve it
// into contact for this probe to pass.
const ENEMY  = { x: 250, y: 290 };

const grid = new Grid();
grid.create(W, H);
grid.energyEnabled = false;
initSimple(grid, [], 0);

const pStart = grid.getCells().length;
buildCell(grid, PLAYER.x, PLAYER.y);
const pEnd = grid.getCells().length;
for (let i = pStart; i < pEnd; i++) grid.getCells()[i].playerControlled = true;

const eStart = grid.getCells().length;
buildCell(grid, ENEMY.x, ENEMY.y);
const eEnd = grid.getCells().length;

// ── fireDart's aim math (player centroid + outer reach) ─────────────
const ux = -1, uy = 0; // fire straight west toward the enemy
let cx = 0, cy = 0;
for (let i = pStart; i < pEnd; i++) {
  const c = grid.getCells()[i];
  cx += c.loc.x; cy += c.loc.y;
}
cx /= (pEnd - pStart); cy /= (pEnd - pStart);
let maxR = 0;
for (let i = pStart; i < pEnd; i++) {
  const c = grid.getCells()[i];
  maxR = Math.max(maxR, Math.hypot(c.loc.x - cx, c.loc.y - cy));
}

const clusters: Cell[][] = [];
const shot = spawnDart(grid, cx, cy, maxR, ux, uy, 0);
clusters.push(shot.cluster);

// ── metrics ──────────────────────────────────────────────────────────
// Closed-loop detection on a subset of atoms — same chain-walk logic as
// renderer.ts → findMembraneLoops, restricted to the given index range
// so each cell gets its own verdict. A live ring = intact membrane.
function hasClosedLoop(start: number, end: number): boolean {
  const set = new Set<Cell>();
  for (let i = start; i < end; i++) set.add(grid.getCells()[i]);
  for (const s of set) {
    if (s.type !== 'a') continue;
    let first: Cell | undefined, second: Cell | undefined;
    for (const b of s.bonds) {
      if (b.type !== 'a' || !set.has(b)) continue;
      if (!first) first = b; else { second = b; break; }
    }
    if (!first || !second) continue;
    const chain = [s];
    let prev = s, curr = first;
    while (curr !== s && chain.length < 500) {
      chain.push(curr);
      let next: Cell | undefined;
      for (const b of curr.bonds) {
        if (b.type === 'a' && b !== prev && set.has(b)) { next = b; break; }
      }
      if (!next) break;
      prev = curr; curr = next;
    }
    if (curr === s && chain.length >= 4) return true;
  }
  return false;
}

function dartCentroid(): { x: number; y: number } {
  let x = 0, y = 0, n = 0;
  for (const cl of clusters) for (const a of cl) { x += a.loc.x; y += a.loc.y; n++; }
  return n === 0 ? { x: -1, y: -1 } : { x: x / n, y: y / n };
}

console.log(`[DART-SIM] player@${PLAYER.x},${PLAYER.y} enemy@${ENEMY.x},${ENEMY.y} dart@(${shot.x.toFixed(0)},${shot.y.toFixed(0)})`);
const STEPS = 800;
let detonated = false;
for (let s = 1; s <= STEPS; s++) {
  grid.step();
  if (clusters.length > 0) {
    // homing=true — this probe exists to verify the guidance curve
    // (the worker gates it behind the first confirmed hit).
    const hit = updateDarts(grid, clusters, s, true);
    if (hit) {
      detonated = true;
      console.log(`[DART-SIM] iter ${s} — DETONATION at (${hit.loc.x.toFixed(0)},${hit.loc.y.toFixed(0)})`);
    }
  }
  if (s % 50 === 0) {
    const d = dartCentroid();
    console.log(`[DART-SIM] iter ${String(s).padStart(3)} — dart(${d.x.toFixed(0)},${d.y.toFixed(0)}) enemy-loop ${hasClosedLoop(eStart, eEnd)} player-loop ${hasClosedLoop(pStart, pEnd)}`);
  }
}
const eAlive = hasClosedLoop(eStart, eEnd);
const pAlive = hasClosedLoop(pStart, pEnd);
console.log(`[DART-SIM] RESULT detonated=${detonated} enemy-loop ${eAlive} player-loop ${pAlive}`);
console.log(detonated && !eAlive && pAlive
  ? '[DART-SIM] PASS — enemy ring destroyed, player intact'
  : '[DART-SIM] FAIL');
