// Primordium — physics worker.
// Copyright (C) 2026 David Castro · GPL v3 (see LICENSE)
// Squirm3 chemistry/physics by Tim Hutton (2007), GPL v3.
//
// Physics worker — owns the Grid, runs grid.step() in a tight loop, and
// streams atom snapshots back to the main thread via Transferable buffers.
//
// All Cell objects, the bond graph, and the chemistry stay here. The main
// thread never sees any of that — it only sees flat typed-array snapshots.

// Worker globals — provided by the runtime (esbuild bundles for the worker).
// We avoid the WebWorker lib entirely (it conflicts with the DOM lib used by main).
declare const self: {
  onmessage: ((this: unknown, e: MessageEvent<unknown>) => void) | null;
  postMessage: (msg: unknown, transferables?: Transferable[]) => void;
};
declare function setTimeout(handler: () => void, ms: number): number;
declare const performance: { now(): number };

import { Grid } from './grid';
import { Cell } from './cell';
import { initSimple, buildCell, seedLysin, removeLysin, seedPredatorCells, removePredatorCells, seedSoup, Q } from './init';
import { initWild, generateRandomChemistry, wildTick } from './wild';
import {
  ControlMsg, SnapshotMsg, STRIDE,
  packTypeState, allocAtomsBuffer, allocLoopsBuffer, allocBondsBuffer, allocDropletsBuffer,
  MAX_ATOMS, MAX_LOOP_VERTS_TOTAL, MAX_BONDS, MAX_DROPLETS,
} from './snapshot';

type Mode = 'rigged' | 'wild';

// Tunables — scaled up for the much larger arena (~13× original area).
const WILD_ATOM_COUNT     = 14_000;
const LYSIN_COUNT         = 1500;
const PREDATOR_CELL_COUNT = 8;
const DENSITY             = 200 / (200 * 200);

let grid = new Grid();
let mode: Mode = 'rigged';
let gridW = 0;
let gridH = 0;
let stepsPerFrame = 8;
let paused = false;
let inGame = false;
const SOUP_RESPAWN_INTERVAL   = 700;   // ticks between soup waves
const SOUP_RESPAWN_PATCHES    = 5;
const SOUP_RESPAWN_PER_PATCH  = 90;    // 5 × 90 = 450 atoms per wave
const WATER_RESPAWN_INTERVAL  = 4250;  // ticks between water drops + merge passes
const LYSIN_RESPAWN_INTERVAL  = 10000; // ticks between lysin micro-spots
const LYSIN_PER_SPOT          = 35;
const WIN_NO_ENEMY_TICKS      = 2400;  // ~5 sec at default 480 steps/sec
let gameStatus = 0;        // 0 playing, 1 won, 2 lost
let noEnemyStartIter = -1; // -1 = enemies present; otherwise iteration when they vanished
let lastLoopCounts = { player: 0, enemy: 0 };

// Buffer pool — three quadruplets so we never starve while one is rendered and
// one is in transit. Main returns each used set via a 'reuse' message.
const atomsPool:    Float32Array[] = [allocAtomsBuffer(),    allocAtomsBuffer(),    allocAtomsBuffer()];
const loopsPool:    Uint32Array[]  = [allocLoopsBuffer(),    allocLoopsBuffer(),    allocLoopsBuffer()];
const bondsPool:    Uint32Array[]  = [allocBondsBuffer(),    allocBondsBuffer(),    allocBondsBuffer()];
const dropletsPool: Float32Array[] = [allocDropletsBuffer(), allocDropletsBuffer(), allocDropletsBuffer()];

// Drop a tight micro-cluster of lysin atoms at a single random spot. Used in
// game mode to add scarce-but-deadly tools rather than blanket coverage.
function spawnLysinSpot(): void {
  const cx = gridW * (0.18 + Math.random() * 0.64);
  const cy = gridH * (0.18 + Math.random() * 0.64);
  for (let n = 0; n < LYSIN_PER_SPOT; n++) {
    const ang = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 55;
    grid.createCell(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, 'p', 0);
  }
}

// Drop one random water droplet somewhere on the slide and immediately run
// surface-tension merging — if it lands on an existing droplet they fuse.
// Used in game mode only.
function spawnRandomWaterDrop(): void {
  if (grid.droplets.length >= MAX_DROPLETS) return;
  grid.droplets.push({
    x: gridW * (0.12 + Math.random() * 0.76),
    y: gridH * (0.12 + Math.random() * 0.76),
    r: 280 + Math.random() * 240,
  });
  mergeDroplets();
}

// Drop a few small random soup patches across the arena. Used in game mode
// only, fired periodically so the player never runs out of food.
function spawnRandomSoupPatches(): void {
  const TYPES = 'aaaaabcdef';
  for (let p = 0; p < SOUP_RESPAWN_PATCHES; p++) {
    const cx = gridW * (0.10 + Math.random() * 0.80);
    const cy = gridH * (0.10 + Math.random() * 0.80);
    for (let n = 0; n < SOUP_RESPAWN_PER_PATCH; n++) {
      const ang = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 80;
      grid.createCell(
        cx + Math.cos(ang) * r,
        cy + Math.sin(ang) * r,
        TYPES[Math.floor(Math.random() * TYPES.length)],
        0,
      );
    }
  }
}

function setupGame(): void {
  grid = new Grid();
  grid.create(gridW, gridH);
  grid.getChemistry().clear();
  grid.energyEnabled = false;
  // Re-register the chemistry rules from initSimple, but pass NO cell centers
  // and NO background — we'll seed our own scattered world below.
  initSimple(grid, [], 0);

  // Player cell at the center
  const beforePlayer = grid.getCells().length;
  buildCell(grid, gridW * 0.5, gridH * 0.5);
  const afterPlayer = grid.getCells().length;
  for (let i = beforePlayer; i < afterPlayer; i++) {
    grid.getCells()[i].playerControlled = true;
  }

  // 5 opponent cells scattered around (avoiding the very center)
  for (let k = 0; k < 5; k++) {
    const angle = (k / 5) * Math.PI * 2 + Math.random() * 0.4;
    const dist  = Math.min(gridW, gridH) * 0.32;
    const x = gridW * 0.5 + Math.cos(angle) * dist;
    const y = gridH * 0.5 + Math.sin(angle) * dist;
    buildCell(grid, x, y);
  }

  // Random water droplets — small, scattered. Surface tension will merge any
  // that happen to overlap into single bigger pools.
  const W_DROPS = 5;
  for (let k = 0; k < W_DROPS; k++) {
    grid.droplets.push({
      x: gridW * (0.15 + Math.random() * 0.7),
      y: gridH * (0.15 + Math.random() * 0.7),
      r: 320 + Math.random() * 200,
    });
  }

  // Soup patches — small clusters distributed across the arena, not laggy.
  // ~10 patches × 60 atoms = 600 atoms total (well under arena defaults).
  const TYPES = 'aaaaabcdef';
  for (let patch = 0; patch < 10; patch++) {
    const cx = gridW * (0.10 + Math.random() * 0.80);
    const cy = gridH * (0.10 + Math.random() * 0.80);
    for (let n = 0; n < 60; n++) {
      const ang = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 90;
      grid.createCell(
        cx + Math.cos(ang) * r,
        cy + Math.sin(ang) * r,
        TYPES[Math.floor(Math.random() * TYPES.length)],
        0,
      );
    }
  }
}

function setupRigged(): void {
  grid = new Grid();
  grid.create(gridW, gridH);
  grid.getChemistry().clear();
  grid.energyEnabled = false;
  grid.getChemistry().mutationRate = 0;
  const midY = gridH / 2;
  // Six cells spread across the wider arena (was 3 in original 1400-wide grid)
  initSimple(grid, [
    [gridW * 0.12, midY],
    [gridW * 0.28, midY],
    [gridW * 0.44, midY],
    [gridW * 0.60, midY],
    [gridW * 0.76, midY],
    [gridW * 0.92, midY],
  ], 0);
}

function setupWild(): void {
  grid = new Grid();
  grid.create(gridW, gridH);
  initWild(grid, WILD_ATOM_COUNT);
}

// ── Loop detection (membrane closed cycles via 'a'-'a' bond chains) ────────
// Runs in the worker so the main thread never has to traverse the bond graph.
type LoopInfo = { vertCount: number; isPredator: boolean; firstVertOffset: number };

function findMembraneLoopsAndPack(cells: Cell[], indexMap: Map<Cell, number>, loopsBuf: Uint32Array): { loopCount: number; usedLen: number; playerLoops: number; enemyLoops: number } {
  const visited = new Set<Cell>();
  const headers: LoopInfo[] = [];
  let writeIdx = 1;
  let totalVerts = 0;
  let playerLoops = 0;
  let enemyLoops  = 0;

  for (const start of cells) {
    if (start.type !== 'a' || visited.has(start)) continue;

    // Find two 'a' bond neighbours
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

    if (curr === start && chain.length >= 4) {
      if (totalVerts + chain.length > MAX_LOOP_VERTS_TOTAL) break;
      for (const c of chain) visited.add(c);
      // Loop "ownership" model:
      //   • count how many atoms are player-controlled and how many are predator
      //   • if >= 40% are player → this is a player loop:
      //       - mark every atom in it as player (so soup atoms absorbed into
      //         the membrane via elasticity inherit your ownership; this also
      //         makes daughter cells stay tinted after division because their
      //         mostly-player composition keeps them above threshold)
      //   • if NOT a player loop → strip the player flag from any stragglers
      //     in this loop (so a single absorbed player atom can't tint an
      //     opponent, AND so opponents you absorb stop showing as player)
      let playerCount = 0;
      let predatorCount = 0;
      for (const c of chain) {
        if (c.playerControlled) playerCount++;
        if (c.type === 'a' && c.state >= Q) predatorCount++;
      }
      const isPlayerLoop = playerCount * 5 >= chain.length * 2; // >= 40%
      if (isPlayerLoop) {
        for (const c of chain) c.playerControlled = true;
      } else {
        for (const c of chain) c.playerControlled = false;
      }
      let kind = 0;
      if (predatorCount > 0) kind = 1;
      if (isPlayerLoop) kind = 2;
      const firstVert = writeIdx + 2;
      if (writeIdx + 2 + chain.length > loopsBuf.length) break;
      loopsBuf[writeIdx++] = chain.length;
      loopsBuf[writeIdx++] = kind;
      for (const c of chain) loopsBuf[writeIdx++] = indexMap.get(c)!;
      headers.push({ vertCount: chain.length, isPredator: kind === 1, firstVertOffset: firstVert });
      totalVerts += chain.length;
      // "Alive" = the closed membrane has BOTH gene endpoints bonded to it:
      //   • 'e' = genome-start marker
      //   • 'f' = genome-end marker
      // A cell missing either one can't run its replication chemistry — it's
      // effectively dead, even if a stray gene fragment is still tethered.
      // Empty skins and zombies-with-half-a-gene both fail this check and
      // therefore don't count toward the enemy total or the player's life.
      let hasE = false, hasF = false;
      for (const c of chain) {
        for (const b of c.bonds) {
          if (b.type === 'e') hasE = true;
          else if (b.type === 'f') hasF = true;
        }
        if (hasE && hasF) break;
      }
      if (hasE && hasF) {
        if (kind === 2) playerLoops++; else enemyLoops++;
      }
    }
  }

  loopsBuf[0] = headers.length;
  return { loopCount: headers.length, usedLen: writeIdx, playerLoops, enemyLoops };
}

// Real surface tension fuses droplets the moment they touch. We loop until
// no more merges happen so chains of touching droplets collapse into one.
// Fused droplet conserves "area" (πr² = πa² + πb²) and centers on the
// area-weighted midpoint — two equal droplets merge to one of √2 × radius.
function mergeDroplets(): void {
  const drops = grid.droplets;
  let pass = 0;
  while (pass < 50) {                // safety cap, just in case
    let mergedThisPass = false;
    for (let i = 0; i < drops.length; i++) {
      for (let j = i + 1; j < drops.length; j++) {
        const a = drops[i], b = drops[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const distSq = dx * dx + dy * dy;
        const sumR = a.r + b.r;
        if (distSq < sumR * sumR) { // touch (or overlap) → fuse
          const wa = a.r * a.r;
          const wb = b.r * b.r;
          const newR = Math.sqrt(wa + wb);
          const newX = (a.x * wa + b.x * wb) / (wa + wb);
          const newY = (a.y * wa + b.y * wb) / (wa + wb);
          drops[i] = { x: newX, y: newY, r: newR };
          drops.splice(j, 1);
          mergedThisPass = true;
          j = i; // restart inner scan against the merged droplet
        }
      }
    }
    if (!mergedThisPass) break;
    pass++;
  }
}

function packDroplets(buf: Float32Array): void {
  const drops = grid.droplets;
  const n = Math.min(drops.length, MAX_DROPLETS);
  buf[0] = n;
  for (let i = 0; i < n; i++) {
    const d = drops[i];
    buf[1 + i * 3]     = d.x;
    buf[1 + i * 3 + 1] = d.y;
    buf[1 + i * 3 + 2] = d.r;
  }
}

function packSnapshot(atomsBuf: Float32Array, loopsBuf: Uint32Array, bondsBuf: Uint32Array, dropletsBuf: Float32Array): { atomCount: number } {
  const cells = grid.getCells();
  const n = Math.min(cells.length, MAX_ATOMS);
  const indexMap = new Map<Cell, number>();
  for (let i = 0; i < n; i++) indexMap.set(cells[i], i);

  for (let i = 0; i < n; i++) {
    const c = cells[i];
    const o = i * STRIDE;
    atomsBuf[o + 0] = c.loc.x;
    atomsBuf[o + 1] = c.loc.y;
    // pack type charcode + state into one f32 bit pattern
    atomsBuf[o + 2] = packTypeState(c.type.charCodeAt(0), c.state);
    // flags: bit0=bonded, bit1=predator-mem, bit2=membrane-a, bit3=playerControlled
    let flags = 0;
    if (c.bonds.size > 0) flags |= 1;
    if (c.type === 'a' && c.state >= Q) flags |= 2;
    if (c.type === 'a') flags |= 4;
    if (c.playerControlled) flags |= 8;
    atomsBuf[o + 3] = flags;
  }

  const loopRes = findMembraneLoopsAndPack(cells, indexMap, loopsBuf);
  lastLoopCounts.player = loopRes.playerLoops;
  lastLoopCounts.enemy  = loopRes.enemyLoops;
  if (inGame && gameStatus === 0) {
    if (loopRes.playerLoops === 0) {
      gameStatus = 2; // lose
    } else if (loopRes.enemyLoops === 0) {
      if (noEnemyStartIter < 0) noEnemyStartIter = grid.iterations;
      if (grid.iterations - noEnemyStartIter >= WIN_NO_ENEMY_TICKS) gameStatus = 1;
    } else {
      noEnemyStartIter = -1;
    }
  }

  // Pack bonds: emit each undirected pair once (only when partner index > self).
  let bw = 1;
  let bondCount = 0;
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    for (const other of c.bonds) {
      const j = indexMap.get(other);
      if (j === undefined || j <= i) continue;
      if (bw + 2 > bondsBuf.length || bondCount >= MAX_BONDS) break;
      bondsBuf[bw++] = i;
      bondsBuf[bw++] = j;
      bondCount++;
    }
  }
  bondsBuf[0] = bondCount;

  packDroplets(dropletsBuf);
  return { atomCount: n };
}

function postSnapshot(): void {
  if (atomsPool.length === 0 || loopsPool.length === 0 || bondsPool.length === 0 || dropletsPool.length === 0) return;
  const atoms    = atomsPool.shift()!;
  const loops    = loopsPool.shift()!;
  const bonds    = bondsPool.shift()!;
  const droplets = dropletsPool.shift()!;

  const { atomCount } = packSnapshot(atoms, loops, bonds, droplets);

  const winCountdown = (inGame && noEnemyStartIter >= 0)
    ? Math.max(0, WIN_NO_ENEMY_TICKS - (grid.iterations - noEnemyStartIter))
    : 0;
  const msg: SnapshotMsg = {
    type: 'snapshot',
    iterations: grid.iterations,
    atomCount,
    epoch: grid.epoch,
    atoms,
    loops,
    bonds,
    droplets,
    gameStatus,
    playerCount: lastLoopCounts.player,
    enemyCount:  lastLoopCounts.enemy,
    winCountdownIter: winCountdown,
  };
  self.postMessage(msg, [
    atoms.buffer as Transferable,
    loops.buffer as Transferable,
    bonds.buffer as Transferable,
    droplets.buffer as Transferable,
  ]);
}

// ── Fixed-cadence physics loop ─────────────────────────────────────────────
// Target rate = 60 ticks/sec so simulation speed feels identical to the
// original rAF-driven loop. Each tick runs `stepsPerFrame` physics steps and
// emits one snapshot. We use a self-correcting delay (target_time - now) so
// drift doesn't accumulate when individual ticks run long.
const TARGET_HZ = 60;
const TARGET_DT_MS = 1000 / TARGET_HZ;
let nextTickAt = 0;

function tick(): void {
  const now = performance.now();
  if (!paused && gridW > 0) {
    for (let i = 0; i < stepsPerFrame; i++) {
      grid.step();
      if (mode === 'wild') wildTick(grid);
      if (inGame && gameStatus === 0 && grid.iterations > 0) {
        if (grid.iterations % SOUP_RESPAWN_INTERVAL  === 0) spawnRandomSoupPatches();
        if (grid.iterations % WATER_RESPAWN_INTERVAL === 0) spawnRandomWaterDrop();
        if (grid.iterations % LYSIN_RESPAWN_INTERVAL === 0) spawnLysinSpot();
      }
    }
    postSnapshot();
  }
  // Schedule the next tick relative to the *target* cadence. If physics took
  // longer than the budget we fire immediately (delay = 0) to catch up, but
  // never run faster than 60 Hz when atom counts are tiny.
  if (nextTickAt === 0) nextTickAt = now;
  nextTickAt += TARGET_DT_MS;
  const delay = Math.max(0, nextTickAt - performance.now());
  // If we've fallen way behind, snap nextTickAt forward instead of trying to
  // catch up by running 100 ticks back-to-back.
  if (delay === 0 && performance.now() - nextTickAt > TARGET_DT_MS * 4) {
    nextTickAt = performance.now();
  }
  setTimeout(tick, delay);
}

// ── Control message handler ───────────────────────────────────────────────
self.onmessage = (e: MessageEvent<unknown>) => {
  const msg = e.data as ControlMsg;
  switch (msg.type) {
    case 'init':
      gridW = msg.gridW;
      gridH = msg.gridH;
      mode  = msg.mode;
      if (mode === 'rigged') setupRigged(); else setupWild();
      tick();
      return;
    case 'pause':
      paused = msg.paused;
      return;
    case 'setStepsPerFrame':
      stepsPerFrame = msg.n;
      return;
    case 'setThermalScale':
      grid.thermalScale = msg.v;
      return;
    case 'setBondedDamping':
      grid.bondedDamping = msg.v;
      return;
    case 'toggleLysin':
      if (msg.on) seedLysin(grid, LYSIN_COUNT); else removeLysin(grid);
      return;
    case 'togglePredators':
      if (msg.on) {
        const midY = gridH / 2;
        const positions: [number, number][] = Array.from(
          { length: PREDATOR_CELL_COUNT },
          (_, i) => [gridW * ((i + 0.5) / PREDATOR_CELL_COUNT), midY - 120] as [number, number],
        );
        seedPredatorCells(grid, positions);
      } else {
        removePredatorCells(grid);
      }
      return;
    case 'addSoup': {
      if (mode !== 'rigged') return;
      const burst = Math.floor(gridW * gridH * DENSITY * 0.25);
      seedSoup(grid, burst);
      return;
    }
    case 'rerollWild':
      if (mode !== 'wild') return;
      generateRandomChemistry(grid);
      return;
    case 'setMode':
      mode = msg.mode;
      if (mode === 'rigged') setupRigged(); else setupWild();
      return;
    case 'paintSoup': {
      // Spray `count` soup atoms uniformly inside a disc at (x, y) with radius.
      // Clipped to grid bounds. Each atom gets a biased-random type.
      const TYPES = 'aaaaabcdef';
      for (let i = 0; i < msg.count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rad = Math.sqrt(Math.random()) * msg.radius;
        const x = Math.max(0, Math.min(gridW, msg.x + Math.cos(ang) * rad));
        const y = Math.max(0, Math.min(gridH, msg.y + Math.sin(ang) * rad));
        grid.createCell(x, y, TYPES[Math.floor(Math.random() * TYPES.length)], 0);
      }
      return;
    }
    case 'paintWater':
      if (grid.droplets.length < MAX_DROPLETS) {
        grid.droplets.push({ x: msg.x, y: msg.y, r: msg.radius });
        mergeDroplets();
      }
      return;
    case 'clearWater':
      grid.droplets.length = 0;
      return;
    case 'startGame':
      inGame = true;
      gameStatus = 0;
      noEnemyStartIter = -1;
      setupGame();
      return;
    case 'endGame':
      inGame = false;
      gameStatus = 0;
      noEnemyStartIter = -1;
      setupRigged();
      return;
    case 'setPlayerInput':
      grid.playerInputX = msg.x;
      grid.playerInputY = msg.y;
      return;
    case 'reuse':
      atomsPool.push(msg.atoms);
      loopsPool.push(msg.loops);
      bondsPool.push(msg.bonds);
      dropletsPool.push(msg.droplets);
      return;
  }
};
