// Primordium — main thread.
// Copyright (C) 2026 David Castro
// Based on Squirm3 by Tim Hutton (2007), https://github.com/timhutton/squirm3
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License v3 (or any later version)
// as published by the Free Software Foundation. See LICENSE for full terms.
//
// squirm3-pro main thread:
//   • Owns the canvas + UI controls
//   • Spawns the physics worker, sends control messages, receives snapshots
//   • Picks WebGPU renderer when available, falls back to optimized Canvas 2D
//   • The HUD/legend (educational view) renders into a sibling 2D overlay canvas
//
// No physics state lives here.

import { ControlMsg, SnapshotMsg, BurnProgressMsg, BurnDoneMsg, SaveStateMsg, LoadResultMsg, SaveState, STRIDE } from './snapshot';
import { draw2D, draw2DClassic, drawHUD2D } from './renderer-2d';
import { initGPU, drawGPU } from './renderer-gpu';

// Big arena (~13× the original area). The canvas itself is viewport-sized;
// we render only what the camera sees. Pan with mouse drag, zoom with wheel.
const GRID_W = 5000;
const GRID_H = 3000;
const VIEW_W = 1400;
const VIEW_H = 800;

// ── Canvases ────────────────────────────────────────────────────────────────
const canvas  = document.getElementById('canvas')  as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
canvas.width  = VIEW_W;
canvas.height = VIEW_H;
overlay.width  = VIEW_W;
overlay.height = VIEW_H;
canvas.style.width  = VIEW_W + 'px';
canvas.style.height = VIEW_H + 'px';
overlay.style.width  = canvas.style.width;
overlay.style.height = canvas.style.height;

let ctx2d: CanvasRenderingContext2D | null = null;
const overlayCtx = overlay.getContext('2d')!;

// ── Camera ──────────────────────────────────────────────────────────────────
// Convention: screen_xy = (world_xy - camera_xy) * zoom
// Initial: fit arena to viewport (we let user zoom in from there).
const fitZoom = Math.min(VIEW_W / GRID_W, VIEW_H / GRID_H);
const camera = {
  x: (GRID_W - VIEW_W / fitZoom) / 2,
  y: (GRID_H - VIEW_H / fitZoom) / 2,
  zoom: fitZoom,
};
const MIN_ZOOM = fitZoom * 0.5;
const MAX_ZOOM = 6;

// Mouse interactivity — behavior depends on brushMode (declared later but
// referenced via closure that reads the mutable variable each event).
let dragging = false;
let lastMx = 0, lastMy = 0;

function screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  return { x: sx / camera.zoom + camera.x, y: sy / camera.zoom + camera.y };
}

function applyBrushAt(clientX: number, clientY: number): void {
  const w = screenToWorld(clientX, clientY);
  if (brushMode === 'soup') {
    send({ type: 'paintSoup', x: w.x, y: w.y, radius: SOUP_BRUSH_RADIUS, count: SOUP_BRUSH_RATE });
  } else if (brushMode === 'water') {
    send({ type: 'paintWater', x: w.x, y: w.y, radius: WATER_BRUSH_RADIUS });
  } else if (brushMode === 'select') {
    // Pick the closest atom within 30 world units of the click. Worker pins
    // a stable Cell reference; subsequent snapshots flag that atom so the
    // halo follows it as it moves.
    send({ type: 'selectAt', x: w.x, y: w.y, radius: 30 });
  }
}

canvas.addEventListener('mousedown', (e) => {
  dragging = true; lastMx = e.clientX; lastMy = e.clientY;
  if (brushMode === 'pan') {
    canvas.style.cursor = 'grabbing';
  } else {
    applyBrushAt(e.clientX, e.clientY);
  }
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  if (brushMode === 'pan') {
    const dx = e.clientX - lastMx, dy = e.clientY - lastMy;
    camera.x -= dx / camera.zoom;
    camera.y -= dy / camera.zoom;
    lastMx = e.clientX; lastMy = e.clientY;
  } else {
    // For continuous brushing, fire on each move event. Water gets one droplet
    // per move (sparse — surface tension makes overlapping ones still distinct);
    // soup paints a steady stream of atoms.
    const dx = e.clientX - lastMx, dy = e.clientY - lastMy;
    if (dx * dx + dy * dy >= 6 * 6) { // ~6px movement threshold
      applyBrushAt(e.clientX, e.clientY);
      lastMx = e.clientX; lastMy = e.clientY;
    }
  }
});
window.addEventListener('mouseup', () => {
  dragging = false;
  canvas.style.cursor = brushMode === 'pan' ? 'grab' : 'crosshair';
});
canvas.style.cursor = 'grab';

// Mouse wheel → zoom around cursor
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const worldX = mx / camera.zoom + camera.x;
  const worldY = my / camera.zoom + camera.y;
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * factor));
  camera.x = worldX - mx / newZoom;
  camera.y = worldY - my / newZoom;
  camera.zoom = newZoom;
}, { passive: false });

// ── Worker ──────────────────────────────────────────────────────────────────
const worker = new Worker('dist/worker.js');
function send(msg: ControlMsg): void { worker.postMessage(msg); }
function sendTransfer(msg: ControlMsg, transferables: Transferable[]): void {
  worker.postMessage(msg, transferables);
}

// Latest snapshot held by main thread for rendering.
// Because rAF and onmessage cannot interleave (JS single-threaded), it's safe
// to immediately ship the previous snapshot's buffers back to the worker the
// moment a new one arrives — no pendingReturn queue needed (and that queue
// caused a deadlock when the worker only had 2 buffers in its pool).
let lastSnapshot: SnapshotMsg | null = null;

type WorkerMsg = SnapshotMsg | BurnProgressMsg | BurnDoneMsg | SaveStateMsg | LoadResultMsg;

worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
  const data = e.data;
  if (data.type === 'snapshot') {
    if (lastSnapshot) {
      sendTransfer(
        { type: 'reuse', atoms: lastSnapshot.atoms, loops: lastSnapshot.loops, bonds: lastSnapshot.bonds, droplets: lastSnapshot.droplets },
        [lastSnapshot.atoms.buffer, lastSnapshot.loops.buffer, lastSnapshot.bonds.buffer, lastSnapshot.droplets.buffer],
      );
    }
    lastSnapshot = data;
    if (statsRecording) recordStatsRow(data);
    return;
  }
  if (data.type === 'burnProgress') { onBurnProgress(data); return; }
  if (data.type === 'burnDone')     { onBurnDone(data);     return; }
  if (data.type === 'saveState')    { onSaveState(data);    return; }
  if (data.type === 'loadResult')   { onLoadResult(data);   return; }
};

// ── State (UI-only) ─────────────────────────────────────────────────────────
type Brush = 'pan' | 'soup' | 'water' | 'select';
type ViewMode = 'educational' | 'microscope' | 'classic';
let brushMode: Brush = 'pan';
let paused = false;
let lysinActive = false;
let viewMode: ViewMode = 'educational';
let bacteriaView = false; // mirror of viewMode === 'microscope', used by GPU/2D draw paths
let useGPU = false;
let stepsPerFrame = 8;
let gameMode = false;

// Brush settings — controllable via UI later if needed
const SOUP_BRUSH_RADIUS = 60;     // world units
const SOUP_BRUSH_RATE   = 25;     // atoms per drag-step
const WATER_BRUSH_RADIUS = 180;   // world units

// ── Boot — WebGPU is the default. If the browser doesn't have WebGPU we
// fall back to the optimized Canvas 2D renderer (also visually 1:1 with the
// original). Either way physics runs in the worker.
(async () => {
  useGPU = await initGPU(canvas);
  if (!useGPU) {
    ctx2d = canvas.getContext('2d');
    showStatus('Canvas 2D fallback (WebGPU unavailable in this browser)');
  } else {
    showStatus('WebGPU · physics in worker · larger arena');
  }
  send({ type: 'init', gridW: GRID_W, gridH: GRID_H, mode: 'rigged' });
})();

// Status line — central log surface. logStatus() is the action-feedback
// channel; every meaningful UI action calls it so the user always sees what
// just happened. The 'flash' class brightens the text briefly so the eye
// catches new messages even at a glance.
const statusEl = document.getElementById('status');
let statusFlashTimer: number | null = null;
function showStatus(msg: string): void {
  if (statusEl) statusEl.textContent = msg;
}
function logStatus(msg: string): void {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.classList.add('flash');
  if (statusFlashTimer !== null) clearTimeout(statusFlashTimer);
  statusFlashTimer = window.setTimeout(() => {
    statusEl.classList.remove('flash');
    statusFlashTimer = null;
  }, 600);
  // Also mirror to console so power users can scroll the history.
  console.log('[primordium]', msg);
}

// ── UI buttons ───────────────────────────────────────────────────────────────
const pauseBtn       = document.getElementById('pause-btn')      as HTMLButtonElement;
const lysinBtn       = document.getElementById('lysin-btn')      as HTMLButtonElement;
const recBtn         = document.getElementById('rec-btn')        as HTMLButtonElement;
const viewBtn        = document.getElementById('view-btn')       as HTMLButtonElement;
const soupBrushBtn   = document.getElementById('soup-brush-btn') as HTMLButtonElement;
const waterBrushBtn  = document.getElementById('water-brush-btn') as HTMLButtonElement;
const selectBtn      = document.getElementById('select-btn')      as HTMLButtonElement;
const clearWaterBtn  = document.getElementById('clear-water-btn') as HTMLButtonElement;
const gameBtn        = document.getElementById('game-btn')        as HTMLButtonElement;
const dripBtn        = document.getElementById('drip-btn')        as HTMLButtonElement;
const burnBtn        = document.getElementById('burn-btn')        as HTMLButtonElement;
const burnIters      = document.getElementById('burn-iters')      as HTMLInputElement;
const dripSlidersRow = document.getElementById('drip-sliders')    as HTMLDivElement;
const dripSoupSlider  = document.getElementById('drip-soup-slider') as HTMLInputElement;
const dripWaterSlider = document.getElementById('drip-water-slider') as HTMLInputElement;
const dripSoupVal     = document.getElementById('drip-soup-val')!;
const dripWaterVal    = document.getElementById('drip-water-val')!;
const seedInput       = document.getElementById('seed-input')      as HTMLInputElement;
const seedApplyBtn    = document.getElementById('seed-apply-btn')  as HTMLButtonElement;
const saveBtn         = document.getElementById('save-btn')        as HTMLButtonElement;
const loadBtn         = document.getElementById('load-btn')        as HTMLButtonElement;
const csvBtn          = document.getElementById('csv-btn')         as HTMLButtonElement;
const csvClearBtn     = document.getElementById('csv-clear-btn')   as HTMLButtonElement;
const csvCount        = document.getElementById('csv-count')!;
const scopeFrame     = document.getElementById('scope-frame')    as HTMLDivElement;

function togglePause(): void {
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  send({ type: 'pause', paused });
  logStatus(paused ? 'Simulation paused' : 'Simulation resumed');
}
function toggleLysin(): void {
  lysinActive = !lysinActive;
  lysinBtn.textContent = lysinActive ? 'Lysin: ON' : 'Lysin: OFF';
  lysinBtn.classList.toggle('active', lysinActive);
  send({ type: 'toggleLysin', on: lysinActive });
  logStatus(lysinActive ? 'Lysin seeded — membranes will dissolve on contact' : 'Lysin removed');
}
// Cycle: Educational → Microscope → Classic → Educational
function toggleView(): void {
  viewMode = viewMode === 'educational' ? 'microscope'
           : viewMode === 'microscope'  ? 'classic'
           :                              'educational';
  bacteriaView = viewMode === 'microscope';
  const label = viewMode === 'educational' ? 'Educational'
              : viewMode === 'microscope'  ? 'Microscope'
              :                              'Classic';
  viewBtn.textContent = `View: ${label}`;
  viewBtn.classList.toggle('active', viewMode !== 'educational');
  // Microscope CSS effects only apply in microscope mode
  canvas.classList.toggle('microscope', viewMode === 'microscope');
  scopeFrame.classList.toggle('microscope', viewMode === 'microscope');
  // Overlay holds the HUD (educational) and the whole classic render. Hide
  // it only in microscope mode where the main canvas owns the visuals.
  overlay.classList.toggle('hidden', viewMode === 'microscope');
  // Wipe the overlay on every mode change so a stale classic frame can't
  // bleed into educational/microscope before the next render fires.
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  const desc = viewMode === 'educational' ? 'legend + bonds + bezier membranes'
             : viewMode === 'microscope'  ? 'phase contrast (microscope slide)'
             :                              "Hutton's 2002 squares + straight bond lines";
  logStatus(`View → ${label} (${desc})`);
}

function setBrush(next: Brush): void {
  const prev = brushMode;
  brushMode = brushMode === next ? 'pan' : next;
  soupBrushBtn.classList.toggle('active', brushMode === 'soup');
  waterBrushBtn.classList.toggle('active', brushMode === 'water');
  selectBtn.classList.toggle('active', brushMode === 'select');
  canvas.style.cursor = brushMode === 'pan' ? 'grab' : 'crosshair';
  // Leaving select mode → drop any current selection so the halo disappears.
  if (prev === 'select' && brushMode !== 'select') send({ type: 'deselectAll' });
  if (prev !== brushMode) {
    if (brushMode === 'pan')    logStatus('Brush off — drag pans the camera');
    if (brushMode === 'soup')   logStatus('Soup brush ON — click & drag to seed atoms');
    if (brushMode === 'water')  logStatus('Water brush ON — click to drop water (touching droplets fuse)');
    if (brushMode === 'select') logStatus('Select ON — click an atom to highlight it · Delete/Backspace removes it');
  }
}
function clearWater(): void {
  send({ type: 'clearWater' });
  logStatus('Cleared all water droplets');
}

// Buttons that are HIDDEN while in microbe-steering mode — controls that
// don't fit a "you-vs-them" game (sandbox tools).
const GAME_HIDDEN_BTN_IDS = ['pause-btn', 'soup-brush-btn', 'water-brush-btn', 'clear-water-btn', 'lysin-btn', 'drip-btn', 'burn-btn', 'burn-iters'];

// ── Drip feed (sandbox passive replenishment) ──────────────────────────────
let dripOn = false;
function pushDripState(): void {
  send({
    type: 'setDripFeed',
    on: dripOn,
    soupInterval:  parseInt(dripSoupSlider.value),
    waterInterval: parseInt(dripWaterSlider.value),
  });
}
function toggleDrip(): void {
  dripOn = !dripOn;
  dripBtn.textContent = dripOn ? '💧 Drip: ON' : '💧 Drip: OFF';
  dripBtn.classList.toggle('active', dripOn);
  dripSlidersRow.classList.toggle('shown', dripOn);
  pushDripState();
  logStatus(dripOn
    ? `Drip feed ON — soup every ${dripSoupSlider.value} ticks · water every ${dripWaterSlider.value} ticks`
    : 'Drip feed OFF');
}
dripSoupSlider.addEventListener('input', () => {
  dripSoupVal.textContent = dripSoupSlider.value;
  if (dripOn) {
    pushDripState();
    logStatus(`Drip soup interval → every ${dripSoupSlider.value} ticks`);
  }
});
dripWaterSlider.addEventListener('input', () => {
  dripWaterVal.textContent = dripWaterSlider.value;
  if (dripOn) {
    pushDripState();
    logStatus(`Drip water interval → every ${dripWaterSlider.value} ticks`);
  }
});

// ── Headless burn ──────────────────────────────────────────────────────────
let burning = false;
let burnStartIter = 0;
let burnTargetIter = 0;
const burnDefaultLabel = 'Start';
let burnWallStart = 0;

function startBurn(): void {
  if (burning) { send({ type: 'abortBurn' }); logStatus('Aborting burn…'); return; }
  const requested = Math.max(1000, Math.floor(parseInt(burnIters.value) || 100000));
  const startIter = lastSnapshot?.iterations ?? 0;
  burnStartIter  = startIter;
  burnTargetIter = startIter + requested;
  burnWallStart  = performance.now();
  burning = true;
  burnBtn.classList.add('recording');
  burnBtn.textContent = '✕ Cancel (0%)';
  send({ type: 'burn', targetIters: burnTargetIter });
  logStatus(`Burn started → +${requested.toLocaleString()} iters (target ${burnTargetIter.toLocaleString()})`);
}

function onBurnProgress(p: BurnProgressMsg): void {
  if (!burning) return;
  const span = burnTargetIter - burnStartIter;
  const done = p.iterations - burnStartIter;
  const pct  = span > 0 ? Math.min(100, Math.round((done / span) * 100)) : 100;
  burnBtn.textContent = `✕ Cancel (${pct}%)`;
  // Estimate ETA from current rate.
  const remaining = Math.max(0, burnTargetIter - p.iterations);
  const etaSec = p.stepsPerSec > 0 ? Math.round(remaining / p.stepsPerSec) : 0;
  showStatus(
    `Burning · iter ${p.iterations.toLocaleString()} / ${p.target.toLocaleString()} ` +
    `(${pct}%) · ${p.stepsPerSec.toLocaleString()} steps/sec · ETA ${etaSec}s`
  );
}

function onBurnDone(d: BurnDoneMsg): void {
  burning = false;
  burnBtn.classList.remove('recording');
  burnBtn.textContent = burnDefaultLabel;
  const wallSec = (performance.now() - burnWallStart) / 1000;
  const itersDone = d.iterations - burnStartIter;
  const rate = wallSec > 0 ? Math.round(itersDone / wallSec) : 0;
  if (d.aborted) {
    logStatus(`Burn cancelled @ iter ${d.iterations.toLocaleString()} · processed ${itersDone.toLocaleString()} iters in ${wallSec.toFixed(1)}s (${rate.toLocaleString()} steps/sec)`);
  } else {
    logStatus(`Burn complete @ iter ${d.iterations.toLocaleString()} · ${itersDone.toLocaleString()} iters in ${wallSec.toFixed(1)}s (${rate.toLocaleString()} steps/sec)`);
  }
}

function applyGameModeUI(): void {
  for (const id of GAME_HIDDEN_BTN_IDS) {
    const el = document.getElementById(id);
    if (el) (el as HTMLElement).style.display = gameMode ? 'none' : '';
  }
  // Brush state cannot persist into game mode (no brush tools available).
  if (gameMode) brushMode = 'pan';
  hideGameOverlay();
}

function toggleGame(): void {
  gameMode = !gameMode;
  gameBtn.textContent = gameMode ? '🦠 Exit game' : '🦠 Steer a microbe';
  gameBtn.classList.toggle('active', gameMode);
  send({ type: gameMode ? 'startGame' : 'endGame' });
  keyState.w = keyState.a = keyState.s = keyState.d = false;
  send({ type: 'setPlayerInput', x: 0, y: 0 });
  applyGameModeUI();
  logStatus(gameMode
    ? 'Play mode ON — WASD biases your green microbe (Brownian, not propulsion)'
    : 'Play mode OFF — sandbox restored');
}

// ── Win/Lose overlay ───────────────────────────────────────────────────────
const overlayEl = document.getElementById('game-overlay') as HTMLDivElement;
const overlayTitle = document.getElementById('game-overlay-title') as HTMLDivElement;
const overlaySub   = document.getElementById('game-overlay-sub')   as HTMLDivElement;
let overlayShownStatus = 0;

function showGameOverlay(status: number): void {
  if (overlayShownStatus === status) return;
  overlayShownStatus = status;
  if (status === 1) {
    overlayTitle.textContent = '🏆 You won';
    overlayTitle.style.color = '#5edca0';
    overlaySub.textContent = 'No enemy cells survived for 5 seconds.';
  } else {
    overlayTitle.textContent = '☠ You died';
    overlayTitle.style.color = '#ff6464';
    overlaySub.textContent = 'All your cells were lysed.';
  }
  overlayEl.style.display = 'flex';
}
function hideGameOverlay(): void {
  overlayShownStatus = 0;
  overlayEl.style.display = 'none';
}

// ── WASD input → biased Brownian. We track which of W/A/S/D are down and
// send a normalized direction vector to the worker whenever the set changes.
const keyState = { w: false, a: false, s: false, d: false };
function pushPlayerInput(): void {
  if (!gameMode) return;
  let dx = 0, dy = 0;
  if (keyState.d) dx += 1;
  if (keyState.a) dx -= 1;
  if (keyState.s) dy += 1;
  if (keyState.w) dy -= 1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len > 0) { dx /= len; dy /= len; }
  send({ type: 'setPlayerInput', x: dx, y: dy });
}

// ── Recording ───────────────────────────────────────────────────────────────
let mediaRecorder: MediaRecorder | null = null;
let recChunks: Blob[] = [];
let recTimer: number | null = null;
let recStart = 0;
function bestMime(): string {
  const order = ['video/mp4;codecs=avc1','video/mp4','video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'];
  return order.find(t => MediaRecorder.isTypeSupported(t)) ?? 'video/webm';
}
function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function toggleRecording(): void {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') { mediaRecorder.stop(); return; }
  const mime = bestMime();
  const stream = canvas.captureStream(30);
  mediaRecorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  recChunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recChunks.push(e.data); };
  mediaRecorder.onstart = () => {
    recStart = Date.now();
    recBtn.classList.add('recording');
    recTimer = window.setInterval(() => { recBtn.textContent = `■ ${fmtTime(Date.now() - recStart)}`; }, 500);
  };
  mediaRecorder.onstop = () => {
    if (recTimer !== null) { clearInterval(recTimer); recTimer = null; }
    recBtn.classList.remove('recording');
    recBtn.textContent = '● REC';
    const ext  = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const blob = new Blob(recChunks, { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `primordium-${Date.now()}.${ext}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  mediaRecorder.start(200);
}

// ── Sliders ─────────────────────────────────────────────────────────────────
const speedSlider = document.getElementById('speed-slider') as HTMLInputElement;
const speedVal    = document.getElementById('speed-val')!;
const soupSlider  = document.getElementById('soup-slider') as HTMLInputElement;
const soupVal     = document.getElementById('soup-val')!;
const dampSlider  = document.getElementById('damp-slider') as HTMLInputElement;
const dampVal     = document.getElementById('damp-val')!;

speedSlider.addEventListener('input', () => {
  stepsPerFrame = parseInt(speedSlider.value);
  speedVal.textContent = speedSlider.value;
  send({ type: 'setStepsPerFrame', n: stepsPerFrame });
});
soupSlider.addEventListener('input', () => {
  const v = parseInt(soupSlider.value) / 100;
  soupVal.textContent = soupSlider.value + '%';
  send({ type: 'setThermalScale', v });
});
dampSlider.addEventListener('input', () => {
  const v = parseInt(dampSlider.value) / 100;
  dampVal.textContent = v.toFixed(2);
  send({ type: 'setBondedDamping', v });
});

// ── Seed / reproducibility ─────────────────────────────────────────────────
function applySeed(): void {
  const s = Math.max(0, Math.floor(parseFloat(seedInput.value) || 1));
  seedInput.value = String(s);
  send({ type: 'setSeed', seed: s });
  // Reseed implies a fresh sim — wipe stats and burn state on the main side.
  statsRows.length = 0;
  updateCsvCount();
  logStatus(`Seed → ${s} · simulation reset to deterministic initial layout`);
}

// ── Save / Load ─────────────────────────────────────────────────────────────
function onSaveState(msg: SaveStateMsg): void {
  const blob = new Blob([JSON.stringify(msg.state)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const tag  = `iter${msg.state.iterations}-seed${msg.state.seed}`;
  a.href = url;
  a.download = `primordium-${tag}-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  logStatus(`Saved · iter ${msg.state.iterations.toLocaleString()} · ${msg.state.cellX.length.toLocaleString()} atoms · ${msg.state.bonds.length / 2} bonds · ${msg.state.dropX.length} droplets`);
}
function requestSave(): void {
  send({ type: 'requestSave' });
  logStatus('Preparing save…');
}

const loadFileInput = document.createElement('input');
loadFileInput.type = 'file';
loadFileInput.accept = 'application/json,.json';
loadFileInput.style.display = 'none';
document.body.appendChild(loadFileInput);
loadFileInput.addEventListener('change', async () => {
  const file = loadFileInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const state = JSON.parse(text) as SaveState;
    if (state.magic !== 'primordium-save') {
      logStatus(`Load failed: not a Primordium save file (${file.name})`);
      loadFileInput.value = '';
      return;
    }
    send({ type: 'loadSave', state });
    logStatus(`Loading "${file.name}"…`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    logStatus(`Load failed: ${msg}`);
  }
  loadFileInput.value = '';
});
function pickAndLoad(): void { loadFileInput.click(); }

function onLoadResult(msg: LoadResultMsg): void {
  if (msg.ok) {
    statsRows.length = 0;
    updateCsvCount();
    if (typeof msg.seed === 'number') seedInput.value = String(msg.seed);
    logStatus(`Loaded · iter ${(msg.iterations ?? 0).toLocaleString()} · ${(msg.cellCount ?? 0).toLocaleString()} atoms · sim resumed deterministically from saved RNG state`);
  } else {
    logStatus(`Load error: ${msg.error ?? 'unknown'}`);
  }
}

// ── Telemetry / CSV ────────────────────────────────────────────────────────
// Sample snapshots into a typed row buffer. Sampling cadence: every Nth
// snapshot (the worker emits one snapshot per fixed-rate tick = ~60/sec at
// default speed; sampling 1-of-30 gives ~2 rows/sec, manageable for a CSV).
type StatsRow = {
  iter: number;
  atoms: number;
  bonded: number;
  cells: number;          // closed membrane loops
  meanGeneLen: number;
  maxGeneLen: number;
  droplets: number;
};
const statsRows: StatsRow[] = [];
let statsRecording = true;
const STATS_SAMPLE_EVERY = 30;
let statsSampleCounter = 0;

function recordStatsRow(snap: SnapshotMsg): void {
  statsSampleCounter++;
  if (statsSampleCounter < STATS_SAMPLE_EVERY) return;
  statsSampleCounter = 0;

  // bonded count
  let bonded = 0;
  for (let i = 0; i < snap.atomCount; i++) {
    if ((snap.atoms[i * STRIDE + 3] | 0) & 1) bonded++;
  }
  // loop stats — loops layout: header[0]=count, then per-loop [vertCount, kind, ...verts]
  const loopCount = snap.loops[0] | 0;
  let cursor = 1;
  let totalVerts = 0, maxVerts = 0;
  for (let li = 0; li < loopCount; li++) {
    const v = snap.loops[cursor] | 0;
    cursor += 2 + v;
    totalVerts += v;
    if (v > maxVerts) maxVerts = v;
  }
  const meanLen = loopCount > 0 ? totalVerts / loopCount : 0;
  const dropCount = snap.droplets[0] | 0;

  statsRows.push({
    iter: snap.iterations,
    atoms: snap.atomCount,
    bonded,
    cells: loopCount,
    meanGeneLen: +meanLen.toFixed(2),
    maxGeneLen: maxVerts,
    droplets: dropCount,
  });
  // Cap memory — keep at most 100k rows (a long burn could otherwise bloat).
  if (statsRows.length > 100_000) statsRows.splice(0, statsRows.length - 100_000);
  updateCsvCount();
}
function updateCsvCount(): void {
  csvCount.textContent = `${statsRows.length.toLocaleString()} rows`;
}
function downloadCSV(): void {
  if (statsRows.length === 0) { logStatus('No stats recorded yet — let the sim run first'); return; }
  const header = 'iteration,atoms,bonded_atoms,cells,mean_gene_length,max_gene_length,droplets';
  const lines: string[] = [header];
  for (const r of statsRows) {
    lines.push(`${r.iter},${r.atoms},${r.bonded},${r.cells},${r.meanGeneLen},${r.maxGeneLen},${r.droplets}`);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `primordium-stats-${Date.now()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  logStatus(`Exported ${statsRows.length.toLocaleString()} stats rows to CSV`);
}
function clearStats(): void {
  statsRows.length = 0;
  updateCsvCount();
  logStatus('Stats buffer cleared');
}
updateCsvCount();

// ── Hooks ───────────────────────────────────────────────────────────────────
pauseBtn.addEventListener('click', togglePause);
lysinBtn.addEventListener('click', toggleLysin);
viewBtn.addEventListener('click', toggleView);
soupBrushBtn.addEventListener('click', () => setBrush('soup'));
waterBrushBtn.addEventListener('click', () => setBrush('water'));
selectBtn.addEventListener('click', () => setBrush('select'));
clearWaterBtn.addEventListener('click', clearWater);
gameBtn.addEventListener('click', toggleGame);
dripBtn.addEventListener('click', toggleDrip);
burnBtn.addEventListener('click', startBurn);
seedApplyBtn.addEventListener('click', applySeed);
seedInput.addEventListener('keydown', (e) => { if (e.code === 'Enter') applySeed(); });
saveBtn.addEventListener('click', requestSave);
loadBtn.addEventListener('click', pickAndLoad);
csvBtn.addEventListener('click', downloadCSV);
csvClearBtn.addEventListener('click', clearStats);
recBtn.addEventListener('click', toggleRecording);

document.addEventListener('keydown', (e) => {
  // In game mode, WASD is reserved for the player. We still allow other shortcuts.
  if (gameMode && (e.code === 'KeyW' || e.code === 'KeyA' || e.code === 'KeyS' || e.code === 'KeyD')) {
    if (e.code === 'KeyW') keyState.w = true;
    if (e.code === 'KeyA') keyState.a = true;
    if (e.code === 'KeyS') keyState.s = true;
    if (e.code === 'KeyD') keyState.d = true;
    pushPlayerInput();
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  if (e.code === 'KeyP')  { toggleLysin(); }
  if (e.code === 'KeyR')  { toggleRecording(); }
  if (e.code === 'KeyB')  { setBrush('soup'); }
  if (e.code === 'KeyW')  { setBrush('water'); }
  if (e.code === 'KeyC')  { clearWater(); }
  if (e.code === 'KeyV')  { toggleView(); }
  if (e.code === 'KeyG')  { toggleGame(); }
  if (e.code === 'Escape') { setBrush('pan'); }
  if ((e.code === 'Delete' || e.code === 'Backspace') && brushMode === 'select') {
    e.preventDefault();
    send({ type: 'deleteSelected' });
    logStatus('Selected atom deleted — observe the cell\'s response');
  }
});
document.addEventListener('keyup', (e) => {
  if (!gameMode) return;
  if (e.code === 'KeyW') { keyState.w = false; pushPlayerInput(); }
  if (e.code === 'KeyA') { keyState.a = false; pushPlayerInput(); }
  if (e.code === 'KeyS') { keyState.s = false; pushPlayerInput(); }
  if (e.code === 'KeyD') { keyState.d = false; pushPlayerInput(); }
});

// ── Render loop ─────────────────────────────────────────────────────────────
function loop(): void {
  const snap = lastSnapshot;
  if (snap) {
    if (gameMode) {
      if (snap.gameStatus === 1 || snap.gameStatus === 2) showGameOverlay(snap.gameStatus);
      else hideGameOverlay();
    }
    if (viewMode === 'classic') {
      // Classic mode renders entirely onto the overlay canvas (which always
      // has a 2D context, regardless of whether main is WebGPU or 2D). The
      // overlay's opaque white fill covers whatever the main canvas last had.
      draw2DClassic(overlayCtx, snap.atoms, snap.atomCount, snap.bonds, snap.droplets, camera);
    } else if (useGPU) {
      drawGPU(snap.atoms, snap.atomCount, snap.loops, snap.bonds, snap.droplets, bacteriaView, snap.epoch, camera);
      // Reset the overlay transform before clearing — clearRect honors the
      // current transform, so leftover camera scale from classic-mode would
      // cause it to clear only a tiny world-space rect and leave the rest
      // of the overlay frozen on top of the live render beneath.
      overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
      if (viewMode === 'educational') drawHUD2D(overlayCtx, snap.iterations, snap.atomCount, snap.atoms);
    } else if (ctx2d) {
      draw2D(ctx2d, snap.atoms, snap.atomCount, snap.loops, snap.bonds, snap.droplets, bacteriaView, snap.epoch, camera);
      if (viewMode === 'educational') {
        // HUD always in screen space — reset transform first
        ctx2d.setTransform(1, 0, 0, 1, 0, 0);
        drawHUD2D(ctx2d, snap.iterations, snap.atomCount, snap.atoms);
      }
    }
    // Selection halo — draws the yellow ring on whichever surface is
    // currently visible (overlay for GPU/Classic, main for 2D), so the
    // highlighted atom is always visible regardless of view mode.
    drawSelectionHalo(snap);
  }
  // also keep stepsPerFrame in sync (so worker has it after init)
  void stepsPerFrame;
  requestAnimationFrame(loop);
}

// Find the selected atom (flag bit 4) and draw a halo at its current
// world position. Drawn on whichever 2D context is currently on top:
//   • Classic view  → overlay (already opaque)
//   • GPU view      → overlay (sits over the GPU canvas)
//   • 2D view       → main ctx2d (since the overlay is empty/cleared)
//   • Microscope    → overlay (and we force-unhide it below)
function drawSelectionHalo(snap: SnapshotMsg): void {
  // Find the selected atom in this snapshot. There's at most one.
  let sx = -1, sy = -1;
  for (let i = 0; i < snap.atomCount; i++) {
    const flags = snap.atoms[i * STRIDE + 3] | 0;
    if (flags & 16) {
      sx = snap.atoms[i * STRIDE + 0];
      sy = snap.atoms[i * STRIDE + 1];
      break;
    }
  }
  // If hidden by microscope CSS, force-unhide so the halo is visible during selection.
  const microscope = viewMode === 'microscope';
  if (microscope) {
    overlay.classList.toggle('hidden', sx < 0); // hidden when nothing selected
  }
  if (sx < 0) return;

  // Pick the right context. In the pure-2D view the overlay is empty and the
  // main ctx2d holds the world; everywhere else the overlay sits on top.
  const useOverlay = viewMode !== 'educational' || useGPU || microscope;
  const ctx = useOverlay ? overlayCtx : ctx2d;
  if (!ctx) return;

  // World→screen camera transform, same convention as the renderers.
  const z = camera.zoom;
  ctx.setTransform(z, 0, 0, z, -camera.x * z, -camera.y * z);

  // Pulsing yellow halo. Period ~1.2s. Phase from wallclock so it animates
  // even if the sim is paused.
  const t = (performance.now() / 1000) * 2 * Math.PI / 1.2;
  const pulse = 0.6 + 0.4 * (Math.sin(t) * 0.5 + 0.5);
  ctx.lineWidth = Math.max(1.0, 2.5 / z);
  ctx.strokeStyle = `rgba(255, 220, 60, ${pulse.toFixed(3)})`;
  ctx.beginPath();
  ctx.arc(sx, sy, 14, 0, Math.PI * 2);
  ctx.stroke();
  // Inner crosshair so the user can see the exact center even at low zoom.
  ctx.strokeStyle = `rgba(255, 240, 120, ${(pulse * 0.7).toFixed(3)})`;
  ctx.lineWidth = Math.max(0.6, 1.0 / z);
  ctx.beginPath();
  ctx.moveTo(sx - 8, sy); ctx.lineTo(sx + 8, sy);
  ctx.moveTo(sx, sy - 8); ctx.lineTo(sx, sy + 8);
  ctx.stroke();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
requestAnimationFrame(loop);
