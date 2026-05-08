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

import { ControlMsg, SnapshotMsg, BurnProgressMsg, BurnDoneMsg, SaveStateMsg, LoadResultMsg, EventLogChunkMsg, SelectionExportMsg, SelectionState, SaveState, STRIDE } from './snapshot';
import { draw2D, draw2DClassic, drawHUD2D, drawArenaBorder } from './renderer-2d';
import { initGPU, drawGPU } from './renderer-gpu';

// Big arena (~13× the original area). The canvas itself is viewport-sized;
// we render only what the camera sees. Pan with mouse drag, zoom with wheel.
const GRID_W = 5000;
const GRID_H = 3000;
// Canvas internal resolution. Default landscape (1400×800) for desktop. On
// mobile portrait we swap to portrait (800×1400) so the canvas naturally
// uses the available vertical real estate of the phone screen. The arena
// (GRID_W × GRID_H) doesn't change — the camera just frames a different
// shape of window into it.
const _isMobilePortrait = window.matchMedia('(max-width: 900px) and (orientation: portrait), (pointer: coarse) and (orientation: portrait)').matches;
const VIEW_W = _isMobilePortrait ? 800 : 1400;
const VIEW_H = _isMobilePortrait ? 1400 : 800;

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

// Canvas internal-pixel offset from a viewport client coordinate.
// CRITICAL: on mobile (and any case where CSS scales the canvas), the
// display rect is smaller than canvas.width / canvas.height. Touch events
// give clientX in CSS pixels, but the camera math operates in canvas
// internal pixels. Without this scaling, drag/brush land at the wrong
// position because we'd be feeding CSS pixels into a transform expecting
// canvas pixels. On desktop the scale is 1 (display === internal) so
// behavior is unchanged.
function clientToCanvas(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = (clientX - rect.left) * (canvas.width  / rect.width);
  const sy = (clientY - rect.top)  * (canvas.height / rect.height);
  return { x: sx, y: sy };
}
function screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
  const c = clientToCanvas(clientX, clientY);
  return { x: c.x / camera.zoom + camera.x, y: c.y / camera.zoom + camera.y };
}
// Convert a client-pixel delta (e.g., dx from a drag) to a world-units
// delta. Same scale correction as above; equals delta/zoom on desktop.
function clientDeltaToWorld(dx: number, dy: number): { dx: number; dy: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    dx: dx * (canvas.width  / rect.width)  / camera.zoom,
    dy: dy * (canvas.height / rect.height) / camera.zoom,
  };
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
    const d = clientDeltaToWorld(e.clientX - lastMx, e.clientY - lastMy);
    camera.x -= d.dx;
    camera.y -= d.dy;
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
  const c = clientToCanvas(e.clientX, e.clientY);
  const worldX = c.x / camera.zoom + camera.x;
  const worldY = c.y / camera.zoom + camera.y;
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * factor));
  camera.x = worldX - c.x / newZoom;
  camera.y = worldY - c.y / newZoom;
  camera.zoom = newZoom;
}, { passive: false });

// ── Touch handlers — mobile support ───────────────────────────────────────
// Single finger: pan or brush (mirrors mouse drag).
// Two fingers: pinch-zoom around the midpoint, NEVER triggers brushing.
// All preventDefault so the page doesn't scroll/zoom while interacting
// with the canvas.
let pinchStartDist = 0;
let pinchStartZoom = 1;
let pinchStartCamX = 0;
let pinchStartCamY = 0;
let pinchStartMidX = 0; // screen-space midpoint at pinch start
let pinchStartMidY = 0;
let activeGesture: 'none' | 'single' | 'pinch' = 'none';

function touchDist(t0: Touch, t1: Touch): number {
  const dx = t0.clientX - t1.clientX;
  const dy = t0.clientY - t1.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

canvas.addEventListener('touchstart', (e: TouchEvent) => {
  if (e.touches.length === 1) {
    const t = e.touches[0];
    activeGesture = 'single';
    dragging = true;
    lastMx = t.clientX;
    lastMy = t.clientY;
    if (brushMode !== 'pan') {
      applyBrushAt(t.clientX, t.clientY);
    }
  } else if (e.touches.length === 2) {
    activeGesture = 'pinch';
    dragging = false;
    pinchStartDist = touchDist(e.touches[0], e.touches[1]);
    pinchStartZoom = camera.zoom;
    pinchStartCamX = camera.x;
    pinchStartCamY = camera.y;
    // Convert pinch midpoint to canvas-internal pixel space so the
    // anchor math in touchmove works regardless of CSS scale.
    const midClient = {
      x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
      y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
    };
    const c = clientToCanvas(midClient.x, midClient.y);
    pinchStartMidX = c.x;
    pinchStartMidY = c.y;
  }
  e.preventDefault();
}, { passive: false });

canvas.addEventListener('touchmove', (e: TouchEvent) => {
  if (activeGesture === 'pinch' && e.touches.length === 2) {
    // Two-finger gesture: pinch zoom AND pan together. The world point
    // originally grabbed at the midpoint stays glued to the *current*
    // midpoint, so moving both fingers translates the camera while
    // spreading them zooms — same anchor for both.
    const newDist = touchDist(e.touches[0], e.touches[1]);
    const newMidCanvas = clientToCanvas(
      (e.touches[0].clientX + e.touches[1].clientX) / 2,
      (e.touches[0].clientY + e.touches[1].clientY) / 2,
    );
    if (pinchStartDist > 0 && newDist > 0) {
      const scale = newDist / pinchStartDist;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchStartZoom * scale));
      const worldX = pinchStartMidX / pinchStartZoom + pinchStartCamX;
      const worldY = pinchStartMidY / pinchStartZoom + pinchStartCamY;
      camera.x = worldX - newMidCanvas.x / newZoom;
      camera.y = worldY - newMidCanvas.y / newZoom;
      camera.zoom = newZoom;
    }
  } else if (activeGesture === 'single' && e.touches.length === 1 && dragging) {
    const t = e.touches[0];
    if (brushMode === 'pan') {
      const d = clientDeltaToWorld(t.clientX - lastMx, t.clientY - lastMy);
      camera.x -= d.dx;
      camera.y -= d.dy;
      lastMx = t.clientX; lastMy = t.clientY;
    } else {
      const dx = t.clientX - lastMx, dy = t.clientY - lastMy;
      if (dx * dx + dy * dy >= 6 * 6) {
        applyBrushAt(t.clientX, t.clientY);
        lastMx = t.clientX; lastMy = t.clientY;
      }
    }
  }
  e.preventDefault();
}, { passive: false });

canvas.addEventListener('touchend', (e: TouchEvent) => {
  if (e.touches.length === 0) {
    activeGesture = 'none';
    dragging = false;
  } else if (e.touches.length === 1 && activeGesture === 'pinch') {
    // Lifted one finger of a pinch — transition into single-finger pan
    // without firing a brush stroke.
    activeGesture = 'single';
    dragging = true;
    lastMx = e.touches[0].clientX;
    lastMy = e.touches[0].clientY;
  }
  e.preventDefault();
}, { passive: false });

canvas.addEventListener('touchcancel', () => {
  activeGesture = 'none';
  dragging = false;
}, { passive: true });

// ── Worker ──────────────────────────────────────────────────────────────────
// Cache-bust the worker URL on every page load so iOS Safari and other
// aggressive caches can't pin old physics code in memory. Bundle.js is
// busted separately by the inline loader in index.html. Cost is one
// extra worker.js fetch per session — irrelevant for a sim that runs
// for minutes/hours.
const worker = new Worker('dist/worker.js?v=' + Date.now());
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

type WorkerMsg = SnapshotMsg | BurnProgressMsg | BurnDoneMsg | SaveStateMsg | LoadResultMsg | EventLogChunkMsg | SelectionExportMsg;

worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
  const data = e.data;
  if (data.type === 'snapshot') {
    if (lastSnapshot) {
      sendTransfer(
        { type: 'reuse', atoms: lastSnapshot.atoms, atomIds: lastSnapshot.atomIds, loops: lastSnapshot.loops, bonds: lastSnapshot.bonds, droplets: lastSnapshot.droplets },
        [lastSnapshot.atoms.buffer, lastSnapshot.atomIds.buffer, lastSnapshot.loops.buffer, lastSnapshot.bonds.buffer, lastSnapshot.droplets.buffer],
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
  if (data.type === 'eventLogChunk'){ onEventLogChunk(data); return; }
  if (data.type === 'selectionExport') { onSelectionExport(data); return; }
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
// Autosave is separate from quicksave: it runs on a timer so the user can
// close the tab/browser and reopen the page later with their sim restored
// automatically. Independent localStorage slot so manual quicksaves aren't
// clobbered. Hoisted here so the startup IIFE below can reference them
// without tripping TS's "used before declaration" check.
const AUTOSAVE_KEY = 'primordium-autosave-v1';
const AUTOSAVE_INTERVAL_MS = 15_000;

(async () => {
  useGPU = await initGPU(canvas);
  if (!useGPU) {
    ctx2d = canvas.getContext('2d');
    showStatus('Canvas 2D fallback (WebGPU unavailable in this browser)');
  } else {
    showStatus('WebGPU · physics in worker · larger arena');
  }
  send({ type: 'init', gridW: GRID_W, gridH: GRID_H, mode: 'rigged' });
  // Autosave restore — if the previous session was saved before close,
  // load it on top of the fresh init. Skipped silently if absent or
  // corrupt; the user just gets a default sim in that case.
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) {
      const state = JSON.parse(raw) as SaveState;
      if (state && state.magic === 'primordium-save') {
        send({ type: 'loadSave', state });
        logStatus(`⏪ Restored your previous session · iter ${state.iterations.toLocaleString()} · seed ${state.seed}`);
      }
    }
  } catch { /* malformed autosave — ignore and keep fresh sim */ }
  // Periodic autosave so a closed/reloaded tab returns to nearly the
  // same state. Skipped while paused (no progress to lose).
  setInterval(() => {
    if (!paused) requestAutosave();
  }, AUTOSAVE_INTERVAL_MS);
  // Flush an autosave whenever the tab is hidden or about to unload.
  // pagehide is the most reliable cross-browser signal on mobile —
  // visibilitychange covers tab switches; both call requestAutosave so
  // the next snapshot persists. Best-effort: if the worker doesn't
  // respond before the page dies, the prior periodic save still wins.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && !paused) requestAutosave();
  });
  window.addEventListener('pagehide', () => { if (!paused) requestAutosave(); });
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
const resetBtn        = document.getElementById('reset-btn')       as HTMLButtonElement | null;
const csvBtn          = document.getElementById('csv-btn')         as HTMLButtonElement;
const csvClearBtn     = document.getElementById('csv-clear-btn')   as HTMLButtonElement;
const csvCount        = document.getElementById('csv-count')!;
const noiseBtn        = document.getElementById('noise-btn')         as HTMLButtonElement;
const noiseSlidersRow = document.getElementById('noise-sliders')     as HTMLSpanElement;
const noiseCopySlider  = document.getElementById('noise-copy-slider')  as HTMLInputElement;
const noiseDecaySlider = document.getElementById('noise-decay-slider') as HTMLInputElement;
const noiseBondSlider  = document.getElementById('noise-bond-slider')  as HTMLInputElement;
const noiseCopyVal     = document.getElementById('noise-copy-val')!;
const noiseDecayVal    = document.getElementById('noise-decay-val')!;
const noiseBondVal     = document.getElementById('noise-bond-val')!;
const eventsDlBtn      = document.getElementById('events-dl-btn')      as HTMLButtonElement;
const eventsClearBtn   = document.getElementById('events-clear-btn')   as HTMLButtonElement;
const eventsCount      = document.getElementById('events-count')!;
const hydroBtn          = document.getElementById('hydro-btn')           as HTMLButtonElement;
const hydroSlidersRow   = document.getElementById('hydro-sliders')       as HTMLSpanElement;
const hydroRateSlider   = document.getElementById('hydro-rate-slider')   as HTMLInputElement;
const hydroDensitySlider= document.getElementById('hydro-density-slider')as HTMLInputElement;
const hydroRateVal      = document.getElementById('hydro-rate-val')!;
const hydroDensityVal   = document.getElementById('hydro-density-val')!;
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
  // Overlay used to be hidden in microscope mode for visual cleanliness.
  // Now the arena boundary lives on the overlay in every mode, so keep
  // it visible. Microscope filter only applies to canvas#canvas, so the
  // boundary on the overlay stays sharp and unfiltered, which reads as
  // a clean HUD-style indicator over the blurred microscope view.
  overlay.classList.remove('hidden');
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
// Save flow now multiplexes by reason: 'download' (existing), 'quicksave'
// (in-memory slot, no file), or 'snapshot' (auto-captured to ring before
// a notable change like toggling noise). The worker doesn't know which is
// which — it just produces a SaveState. The reason queue is FIFO so
// requests are matched in order.
type SaveReason = 'download' | 'quicksave' | 'snapshot' | 'autosave';
const _saveReasons: { reason: SaveReason; label?: string }[] = [];

// Quicksave / quickload — single in-memory slot, persists to localStorage
// so it survives page reloads. Hotkeys: [ saves, ] loads. No file dialog.
const QUICKSAVE_KEY = 'primordium-quicksave-v1';
let quicksaveSlot: SaveState | null = (() => {
  try {
    const raw = localStorage.getItem(QUICKSAVE_KEY);
    return raw ? JSON.parse(raw) as SaveState : null;
  } catch { return null; }
})();

// Snapshot ring — auto-captures state before each notable toggle (noise on/off,
// hydrolysis on/off, big slider changes). Up to 5 entries, oldest first dropped.
const SNAPSHOT_RING_MAX = 5;
const snapshotRing: { state: SaveState; label: string; capturedAt: number }[] = [];

function onSaveState(msg: SaveStateMsg): void {
  const job = _saveReasons.shift() ?? { reason: 'download' as SaveReason };
  if (job.reason === 'download') {
    const blob = new Blob([JSON.stringify(msg.state)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const tag  = `iter${msg.state.iterations}-seed${msg.state.seed}`;
    a.href = url;
    a.download = `primordium-${tag}-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    logStatus(`Saved · iter ${msg.state.iterations.toLocaleString()} · ${msg.state.cellX.length.toLocaleString()} atoms · ${msg.state.bonds.length / 2} bonds · ${msg.state.dropX.length} droplets`);
    return;
  }
  if (job.reason === 'quicksave') {
    quicksaveSlot = msg.state;
    try { localStorage.setItem(QUICKSAVE_KEY, JSON.stringify(msg.state)); }
    catch (err: unknown) {
      const m = err instanceof Error ? err.message : 'unknown';
      logStatus(`Quicksave warning: localStorage failed (${m}) — slot kept in memory only`);
    }
    logStatus(`⚡ Quicksaved · iter ${msg.state.iterations.toLocaleString()} · press ] to restore`);
    return;
  }
  if (job.reason === 'snapshot') {
    snapshotRing.push({ state: msg.state, label: job.label ?? 'auto', capturedAt: Date.now() });
    while (snapshotRing.length > SNAPSHOT_RING_MAX) snapshotRing.shift();
    // Quiet entry — don't flash status for every auto-snapshot.
    return;
  }
  if (job.reason === 'autosave') {
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(msg.state)); }
    catch { /* quota / private mode — silent, autosave is best-effort */ }
    return;
  }
}
function requestAutosave(): void {
  // Avoid stacking pending autosaves if the worker is slow.
  for (const j of _saveReasons) { if (j.reason === 'autosave') return; }
  _saveReasons.push({ reason: 'autosave' });
  send({ type: 'requestSave' });
}
function clearAutosave(): void {
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* ignore */ }
}
function requestSave(): void {
  _saveReasons.push({ reason: 'download' });
  send({ type: 'requestSave' });
  logStatus('Preparing save…');
}
function quickSave(): void {
  _saveReasons.push({ reason: 'quicksave' });
  send({ type: 'requestSave' });
}
function quickLoad(): void {
  if (!quicksaveSlot) {
    logStatus('No quicksave to restore — press [ first to save current state');
    return;
  }
  send({ type: 'loadSave', state: quicksaveSlot });
  logStatus(`⏪ Quickload · iter ${quicksaveSlot.iterations.toLocaleString()} · seed ${quicksaveSlot.seed}`);
}
function captureAutoSnapshot(label: string): void {
  _saveReasons.push({ reason: 'snapshot', label });
  send({ type: 'requestSave' });
}

// ── Selection inspector ───────────────────────────────────────────────────
// The inspector overlays the sim with a frozen render of the user's current
// selection (one connected bond-graph component). Sim keeps running below
// — this modal does NOT pause physics, just shows a snapshot. Save the
// selection as JSON to study mutations across runs; load JSON to paste a
// previously captured structure back into the sim.
const inspectorModal       = document.getElementById('inspector')           as HTMLDivElement | null;
const inspectorCanvas      = document.getElementById('inspector-canvas')    as HTMLCanvasElement | null;
const inspectorStats       = document.getElementById('inspector-stats')     as HTMLDivElement | null;
const inspectorClose       = document.getElementById('inspector-close')     as HTMLButtonElement | null;
const inspectorDownload    = document.getElementById('inspector-download')  as HTMLButtonElement | null;
const inspectorLoad        = document.getElementById('inspector-load')      as HTMLButtonElement | null;
const inspectBtn           = document.getElementById('inspect-btn')         as HTMLButtonElement | null;
const pasteBtn             = document.getElementById('paste-btn')           as HTMLButtonElement | null;
const selectionCountEl     = document.getElementById('selection-count')     as HTMLSpanElement | null;

let lastSelection: SelectionState | null = null;
let pendingPaste: SelectionState | null = null;

// Hidden file input — single instance, reused for selection JSON loads.
const selectionFileInput = document.createElement('input');
selectionFileInput.type = 'file';
selectionFileInput.accept = 'application/json,.json';
selectionFileInput.style.display = 'none';
document.body.appendChild(selectionFileInput);
selectionFileInput.addEventListener('change', async () => {
  const file = selectionFileInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const sel = JSON.parse(text) as SelectionState;
    if (sel.magic !== 'primordium-selection' || !Array.isArray(sel.cellX)) {
      logStatus(`Not a Primordium selection file (${file.name})`);
      selectionFileInput.value = '';
      return;
    }
    pendingPaste = sel;
    lastSelection = sel;
    renderInspector(sel);
    if (inspectorModal && inspectorModal.classList.contains('shown')) {
      logStatus(`Loaded "${file.name}" · ${sel.atomCount} atoms · close inspector then click Paste to drop into sim`);
    } else {
      logStatus(`Loaded "${file.name}" · ${sel.atomCount} atoms · click 📥 Paste to drop at view center`);
    }
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : 'unknown';
    logStatus(`Selection load failed: ${m}`);
  }
  selectionFileInput.value = '';
});

function openInspector(): void {
  if (!inspectorModal) return;
  // Ask the worker for a fresh export of the current selection. We render
  // when the response arrives.
  send({ type: 'exportSelection' });
  inspectorModal.classList.add('shown');
  inspectorModal.setAttribute('aria-hidden', 'false');
}
function closeInspector(): void {
  if (!inspectorModal) return;
  inspectorModal.classList.remove('shown');
  inspectorModal.setAttribute('aria-hidden', 'true');
}
function isInspectorOpen(): boolean {
  return !!inspectorModal && inspectorModal.classList.contains('shown');
}

function onSelectionExport(msg: SelectionExportMsg): void {
  lastSelection = msg.selection;
  renderInspector(msg.selection);
}

// Render selection into the inspector canvas + stats panel. Centroid →
// canvas center, scaled to fit with margin. Bonds drawn first, then atoms
// on top so coloring is dominant.
const ATOM_COLORS: Record<string, string> = {
  a: '#8a6d3b', b: '#7fb069', c: '#dca54c', d: '#d96d6d',
  e: '#c97df7', f: '#5db8d8', w: '#66ccff', p: '#ff8844',
};
function renderInspector(sel: SelectionState): void {
  if (!inspectorCanvas || !inspectorStats) return;
  const ctx = inspectorCanvas.getContext('2d');
  if (!ctx) return;
  const W = inspectorCanvas.width, H = inspectorCanvas.height;
  ctx.clearRect(0, 0, W, H);

  if (sel.atomCount === 0) {
    inspectorStats.textContent = 'Empty selection — pick something with the Select brush first.';
    return;
  }
  // Compute bounding box for fit-to-canvas scaling.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < sel.atomCount; i++) {
    if (sel.cellX[i] < minX) minX = sel.cellX[i];
    if (sel.cellY[i] < minY) minY = sel.cellY[i];
    if (sel.cellX[i] > maxX) maxX = sel.cellX[i];
    if (sel.cellY[i] > maxY) maxY = sel.cellY[i];
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const span = Math.max(20, Math.max(maxX - minX, maxY - minY));
  const scale = (Math.min(W, H) - 32) / span;
  const tx = (x: number) => (x - cx) * scale + W / 2;
  const ty = (y: number) => (y - cy) * scale + H / 2;
  const r = Math.max(2.5, 6 * scale);

  // Bonds underlay.
  ctx.lineWidth = Math.max(1, r * 0.45);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
  for (let k = 0; k + 1 < sel.bonds.length; k += 2) {
    const i = sel.bonds[k], j = sel.bonds[k + 1];
    ctx.beginPath();
    ctx.moveTo(tx(sel.cellX[i]), ty(sel.cellY[i]));
    ctx.lineTo(tx(sel.cellX[j]), ty(sel.cellY[j]));
    ctx.stroke();
  }
  // Atoms.
  for (let i = 0; i < sel.atomCount; i++) {
    const t = sel.cellType[i];
    ctx.fillStyle = ATOM_COLORS[t] ?? '#cccccc';
    ctx.beginPath();
    ctx.arc(tx(sel.cellX[i]), ty(sel.cellY[i]), r, 0, Math.PI * 2);
    ctx.fill();
    // Tiny type label for high-zoom legibility.
    if (r >= 5) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.font = `${Math.max(8, r * 0.9)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t, tx(sel.cellX[i]), ty(sel.cellY[i]));
    }
  }

  // Stats: type histogram + bond count + a small JSON peek.
  const hist: Record<string, number> = {};
  for (const t of sel.cellType) hist[t] = (hist[t] ?? 0) + 1;
  const histLine = Object.entries(hist)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, n]) => `${t}:${n}`)
    .join('  ');
  const lines = [
    `Atoms:  ${sel.atomCount}`,
    `Bonds:  ${sel.bonds.length / 2}`,
    `Types:  ${histLine}`,
    `Saved:  ${sel.savedAt}`,
  ];
  inspectorStats.textContent = lines.join('\n');
}

function downloadSelection(): void {
  if (!lastSelection) {
    logStatus('No selection to download yet — click Open inspector first');
    return;
  }
  const blob = new Blob([JSON.stringify(lastSelection)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `primordium-selection-${lastSelection.atomCount}atoms-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  logStatus(`Saved selection · ${lastSelection.atomCount} atoms · ${lastSelection.bonds.length / 2} bonds`);
}

function pastePendingSelection(): void {
  if (!pendingPaste) {
    selectionFileInput.click();
    return;
  }
  // Drop atoms at the world point currently at the center of the visible
  // canvas — predictable, no extra click needed.
  const wx = camera.x + (canvas.width / 2) / camera.zoom;
  const wy = camera.y + (canvas.height / 2) / camera.zoom;
  send({ type: 'pasteSelection', x: wx, y: wy, selection: pendingPaste });
  logStatus(`📥 Pasted ${pendingPaste.atomCount} atoms at view center · bonds preserved`);
  pendingPaste = null;
}

if (inspectorClose) inspectorClose.addEventListener('click', closeInspector);
if (inspectorDownload) inspectorDownload.addEventListener('click', downloadSelection);
if (inspectorLoad) inspectorLoad.addEventListener('click', () => selectionFileInput.click());
if (inspectBtn) inspectBtn.addEventListener('click', openInspector);
if (pasteBtn) pasteBtn.addEventListener('click', pastePendingSelection);
// Freeze — the panic button. Pause the sim, zero all noise sliders (without
// losing their slider positions), and quicksave. One key for "I see something
// interesting, capture it now and stop the world from changing."
function freezeAndCapture(): void {
  if (!paused) { paused = true; pauseBtn.textContent = 'Resume'; send({ type: 'pause', paused: true }); }
  // Zero noise without changing slider positions — just push a state with
  // all rates clamped to 0. Toggling noise off entirely would break the
  // user's slider settings. Restoring is just toggling noise back on.
  if (noiseOn) {
    noiseOn = false;
    noiseBtn.textContent = '🧬 Noise: OFF';
    noiseBtn.classList.toggle('active', false);
    noiseSlidersRow.classList.toggle('shown', false);
    pushNoiseState();
  }
  if (hydroOn) {
    hydroOn = false;
    hydroBtn.textContent = '💧🧪 Hydrolysis: OFF';
    hydroBtn.classList.toggle('active', false);
    hydroSlidersRow.classList.toggle('shown', false);
    pushHydroState();
  }
  quickSave();
  logStatus('🧊 FREEZE — paused, all noise/hydrolysis off, quicksaved. Press F to resume + reload settings.');
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

// ── Noise + event log ─────────────────────────────────────────────────────
// Slider values are 0..1000 representing log-spaced probability 0..1e-2.
// 0 → 0.0, 1000 → 1e-2. We use log scale because the interesting regimes
// (1e-5 .. 1e-3) span four orders of magnitude — a linear slider would
// crowd them all into the bottom 1% of travel.
function sliderToProb(v: number): number {
  if (v <= 0) return 0;
  // Map [1, 1000] log-space → [1e-6, 1e-2]
  const t = v / 1000;
  return Math.pow(10, -6 + 4 * t);
}
function fmtProb(p: number): string {
  if (p <= 0) return '0';
  if (p >= 1e-3) return p.toExponential(1);
  return p.toExponential(0);
}

let noiseOn = false;
function pushNoiseState(): void {
  // When OFF, hard-zero everything regardless of slider positions so
  // reproducibility is never accidentally broken by a stray slider value.
  if (!noiseOn) {
    send({ type: 'setNoise', enabled: false, copyFidelity: 0, decayRate: 0, bondFailRate: 0 });
    return;
  }
  send({
    type: 'setNoise',
    enabled: true,
    copyFidelity: sliderToProb(parseInt(noiseCopySlider.value)  || 0),
    decayRate:    sliderToProb(parseInt(noiseDecaySlider.value) || 0),
    bondFailRate: sliderToProb(parseInt(noiseBondSlider.value)  || 0),
  });
}
function refreshNoiseLabels(): void {
  noiseCopyVal.textContent  = fmtProb(sliderToProb(parseInt(noiseCopySlider.value)  || 0));
  noiseDecayVal.textContent = fmtProb(sliderToProb(parseInt(noiseDecaySlider.value) || 0));
  noiseBondVal.textContent  = fmtProb(sliderToProb(parseInt(noiseBondSlider.value)  || 0));
}
function toggleNoise(): void {
  // Auto-snapshot the pre-toggle state so a one-click rewind is available
  // if the toggle ruins something interesting.
  captureAutoSnapshot(noiseOn ? 'before-noise-off' : 'before-noise-on');
  noiseOn = !noiseOn;
  noiseBtn.textContent = noiseOn ? '🧬 Noise: ON' : '🧬 Noise: OFF';
  noiseBtn.classList.toggle('active', noiseOn);
  noiseSlidersRow.classList.toggle('shown', noiseOn);
  pushNoiseState();
  if (noiseOn) {
    logStatus(`Noise ON — copy ${fmtProb(sliderToProb(+noiseCopySlider.value))} · decay ${fmtProb(sliderToProb(+noiseDecaySlider.value))} · bond ${fmtProb(sliderToProb(+noiseBondSlider.value))}`);
  } else {
    logStatus('Noise OFF — chemistry deterministic again');
  }
}
noiseCopySlider.addEventListener('input', () => {
  refreshNoiseLabels();
  if (noiseOn) pushNoiseState();
});
noiseDecaySlider.addEventListener('input', () => {
  refreshNoiseLabels();
  if (noiseOn) pushNoiseState();
});
noiseBondSlider.addEventListener('input', () => {
  refreshNoiseLabels();
  if (noiseOn) pushNoiseState();
});
refreshNoiseLabels();

// Event log accumulator. Worker auto-flushes its 64K-entry ring buffer
// every snapshot; main concatenates chunks here so the user can download
// the entire run regardless of buffer wraparound. Capped at 5M events
// (~80MB in memory, ~120MB CSV) to avoid runaway browser memory growth.
type EventRow = {
  iter: number;
  kind: number;        // 0=copy_misfire, 1=decay, 2=bond_fail, 3=rule_flip
  atomA: number;
  atomB: number;
  before: number;
  after: number;
};
const eventRows: EventRow[] = [];
let eventTotalEverFired = 0;
let eventDroppedTotal = 0;
const EVENT_ROW_CAP = 5_000_000;

function onEventLogChunk(chunk: EventLogChunkMsg): void {
  for (let i = 0; i < chunk.n; i++) {
    eventRows.push({
      iter:   chunk.iters[i],
      kind:   chunk.kinds[i],
      atomA:  chunk.atomA[i],
      atomB:  chunk.atomB[i],
      before: chunk.before[i],
      after:  chunk.after[i],
    });
  }
  eventTotalEverFired = chunk.totalEverFired;
  eventDroppedTotal += chunk.droppedSinceLast;
  if (eventRows.length > EVENT_ROW_CAP) {
    eventRows.splice(0, eventRows.length - EVENT_ROW_CAP);
  }
  updateEventsCount();
}
function updateEventsCount(): void {
  let label = `${eventRows.length.toLocaleString()} events`;
  if (eventDroppedTotal > 0) label += ` (+${eventDroppedTotal.toLocaleString()} dropped)`;
  eventsCount.textContent = label;
}
function unpackTypeChar(packed: number): string {
  return String.fromCharCode((packed >>> 16) & 0xffff);
}
function unpackStateNum(packed: number): number {
  return packed & 0xffff;
}
const KIND_NAMES = ['copy_misfire', 'decay', 'bond_fail', 'rule_flip', 'hydrolysis', 'water_used'];

function downloadEventsCSV(): void {
  // Force-flush any buffered events on the worker first so the download
  // is current. The chunk arrives async, so we delay ~50ms to let it land.
  send({ type: 'requestEventLog' });
  setTimeout(() => {
    if (eventRows.length === 0) {
      logStatus('No events recorded — turn on Noise and let the sim run');
      return;
    }
    const header = 'iter,kind,atomA_id,atomB_id,before_type,before_state,after_type,after_state';
    const lines: string[] = [header];
    for (const r of eventRows) {
      const kindName = KIND_NAMES[r.kind] ?? String(r.kind);
      let bt = '', bs = '', at = '', as = '';
      if (r.kind === 2) {
        // Bond events: before/after are 0/1 flags, no type/state.
        bt = '';     bs = String(r.before);
        at = '';     as = String(r.after);
      } else {
        bt = unpackTypeChar(r.before);
        bs = String(unpackStateNum(r.before));
        at = unpackTypeChar(r.after);
        as = String(unpackStateNum(r.after));
      }
      lines.push(`${r.iter},${kindName},${r.atomA},${r.atomB},${bt},${bs},${at},${as}`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `primordium-events-${Date.now()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    logStatus(`Exported ${eventRows.length.toLocaleString()} events · ${eventTotalEverFired.toLocaleString()} fired total · ${eventDroppedTotal} dropped`);
  }, 50);
}
function clearEvents(): void {
  eventRows.length = 0;
  eventDroppedTotal = 0;
  updateEventsCount();
  logStatus('Event buffer cleared');
}
updateEventsCount();

// ── Hydrolysis (water-driven decomposition) ───────────────────────────────
// Two parameters: rate multiplier (0.1× to 10× the per-bond-type defaults)
// and water density (atoms per square grid unit when generating). Toggle
// gates everything — when OFF, no water is generated and the worker's
// hydrolysis sweep returns immediately, so the base sim is bit-identical.
function hydroRateFromSlider(v: number): number {
  // Slider 0..1000 maps to 0.1× .. 10× on log scale (10^(-1 + 2*t)).
  const t = v / 1000;
  return Math.pow(10, -1 + 2 * t);
}
function hydroDensityFromSlider(v: number): number {
  // Slider 1..100 maps linearly to 0.0001 .. 0.01.
  return v * 1e-4;
}
let hydroOn = false;
function pushHydroState(): void {
  send({
    type: 'setHydrolysis',
    enabled: hydroOn,
    baseRate:     hydroRateFromSlider(parseInt(hydroRateSlider.value) || 500),
    waterDensity: hydroDensityFromSlider(parseInt(hydroDensitySlider.value) || 10),
  });
}
function refreshHydroLabels(): void {
  hydroRateVal.textContent    = hydroRateFromSlider(parseInt(hydroRateSlider.value) || 500).toFixed(2);
  hydroDensityVal.textContent = hydroDensityFromSlider(parseInt(hydroDensitySlider.value) || 10).toFixed(4);
}
function toggleHydro(): void {
  captureAutoSnapshot(hydroOn ? 'before-hydro-off' : 'before-hydro-on');
  hydroOn = !hydroOn;
  hydroBtn.textContent = hydroOn ? '💧🧪 Hydrolysis: ON' : '💧🧪 Hydrolysis: OFF';
  hydroBtn.classList.toggle('active', hydroOn);
  hydroSlidersRow.classList.toggle('shown', hydroOn);
  pushHydroState();
  if (hydroOn) {
    logStatus(`Hydrolysis ON — water atoms generated in every droplet, base rate ${hydroRateFromSlider(+hydroRateSlider.value).toFixed(2)}× · density ${hydroDensityFromSlider(+hydroDensitySlider.value).toFixed(4)}`);
  } else {
    logStatus('Hydrolysis OFF — water atoms removed, base sim restored');
  }
}
hydroRateSlider.addEventListener('input', () => {
  refreshHydroLabels();
  if (hydroOn) pushHydroState();
});
hydroDensitySlider.addEventListener('input', () => {
  refreshHydroLabels();
  if (hydroOn) pushHydroState();
});
refreshHydroLabels();

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
if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    const ok = window.confirm(
      'Reset the simulation?\n\nThis will wipe the current arena, clear your auto-saved progress, and start a fresh sim. This cannot be undone (use Save first if you want to keep this run).',
    );
    if (!ok) return;
    clearAutosave();
    statsRows.length = 0;
    updateCsvCount();
    snapshotRing.length = 0;
    send({ type: 'init', gridW: GRID_W, gridH: GRID_H, mode: 'rigged' });
    logStatus('♻️ Simulation reset — fresh arena, autosave cleared');
  });
}
csvBtn.addEventListener('click', downloadCSV);
csvClearBtn.addEventListener('click', clearStats);
noiseBtn.addEventListener('click', toggleNoise);
hydroBtn.addEventListener('click', toggleHydro);

// ── Mobile collapse toggle for the control bar ─────────────────────────────
// Visible only via the @media query in index.html (.ctl-toggle is display:
// none on desktop). On touch / narrow screens, tapping it expands the full
// control bar; tapping again collapses it back to just the always-visible
// brush/view/select row. Default state is "collapsed" so first paint on
// mobile shows the canvas large.
const ctlToggle = document.getElementById('ctl-toggle') as HTMLButtonElement | null;
const controlBar = document.getElementById('control-bar') as HTMLDivElement;
function isMobileLayout(): boolean {
  // Same condition as the @media query — narrow OR coarse pointer.
  return window.matchMedia('(max-width: 900px), (pointer: coarse)').matches;
}
// The legacy below-canvas hamburger toggle is no longer the primary
// control opener — the new floating panel takes over. Keep this wired
// only as a no-op safety net so removing the element doesn't break older
// cached HTML during deploy transitions.
if (ctlToggle && controlBar) {
  ctlToggle.addEventListener('click', () => {
    const collapsed = controlBar.classList.toggle('collapsed');
    ctlToggle.textContent = collapsed ? '☰ Controls' : '✕ Hide';
  });
}

// ── CONTROL PANEL — primary in-canvas overlay UI ─────────────────────────
// Slides in from the right; overlays the canvas (canvas stays put, panel
// covers right ~30% on desktop or the full screen on mobile). Designed
// to STAY OPEN through every interaction so the user can switch brushes,
// adjust sliders, toggle modes, and brush on the canvas without ever
// having to reopen. Closes only on explicit dismiss: × button, M key,
// Esc, or backdrop tap on mobile.
//
// Defensive: every querySelector is null-checked, every localStorage call
// is wrapped in try/catch, key handlers ignore typing in inputs.

const PANEL_STATE_KEY = 'primordium-panel-open-v1';
const menuToggleBtn = document.getElementById('menu-toggle')   as HTMLButtonElement | null;
const panelCloseBtn = document.getElementById('panel-close')   as HTMLButtonElement | null;
const controlPanel  = document.getElementById('control-panel') as HTMLElement | null;
const panelBackdrop = document.getElementById('panel-backdrop') as HTMLDivElement | null;

function isPanelOpen(): boolean {
  return !!controlPanel && controlPanel.classList.contains('open');
}
function openPanel(): void {
  if (!controlPanel) return;
  controlPanel.classList.add('open');
  controlPanel.setAttribute('aria-hidden', 'false');
  if (panelBackdrop) panelBackdrop.classList.add('shown');
  if (menuToggleBtn) menuToggleBtn.classList.add('active');
  try { localStorage.setItem(PANEL_STATE_KEY, '1'); } catch { /* private mode etc. */ }
}
function closePanel(): void {
  if (!controlPanel) return;
  controlPanel.classList.remove('open');
  controlPanel.setAttribute('aria-hidden', 'true');
  if (panelBackdrop) panelBackdrop.classList.remove('shown');
  if (menuToggleBtn) menuToggleBtn.classList.remove('active');
  try { localStorage.setItem(PANEL_STATE_KEY, '0'); } catch { /* ignore */ }
}
function togglePanel(): void {
  if (isPanelOpen()) closePanel(); else openPanel();
}

// Restore previous open/closed state. Default closed on first visit so
// the simulation is the focal element for new users.
try {
  if (localStorage.getItem(PANEL_STATE_KEY) === '1') openPanel();
} catch { /* private mode — leave closed */ }

// First-visit discoverability pulse: if the user has never opened the
// panel before (no localStorage entry exists), add a one-time breathing
// glow to the ☰ Controls button so they know it's there. The pulse
// auto-stops after a few cycles (CSS animation iteration count) and is
// also cleared the moment the user opens the panel for the first time.
try {
  const seenBefore = localStorage.getItem(PANEL_STATE_KEY) !== null;
  if (!seenBefore && menuToggleBtn) {
    menuToggleBtn.classList.add('menu-pulse');
    // Remove the pulse class once the animation finishes so it doesn't
    // re-trigger on subsequent class changes.
    const stopPulse = () => menuToggleBtn.classList.remove('menu-pulse');
    menuToggleBtn.addEventListener('animationend', stopPulse, { once: true });
    // Belt-and-suspenders: also clear after a fixed timeout in case the
    // animationend event doesn't fire (some old WebKit edge cases).
    setTimeout(stopPulse, 8000);
  }
} catch { /* private mode — pulse always shown, harmless */
  if (menuToggleBtn) menuToggleBtn.classList.add('menu-pulse');
}

// Wire interactions
if (menuToggleBtn) menuToggleBtn.addEventListener('click', togglePanel);
if (panelCloseBtn) panelCloseBtn.addEventListener('click', closePanel);
if (panelBackdrop) panelBackdrop.addEventListener('click', closePanel);

// Stop touch/click events inside the panel from bubbling to the canvas
// underneath (which would otherwise trigger brushing through the panel).
if (controlPanel) {
  const stop = (e: Event) => e.stopPropagation();
  controlPanel.addEventListener('touchstart', stop, { passive: true });
  controlPanel.addEventListener('mousedown',  stop);
}

// ── Orientation change → reload so canvas internal resolution swaps ───────
// Switching VIEW_W/VIEW_H mid-flight would require recreating the WebGPU
// pipeline, the 2D context, the camera, and the snapshot pool. A page
// reload achieves the same end state with zero edge cases. Only triggers
// on actual orientation flip, not every resize, so it's quiet on desktop.
let _lastIsPortrait = window.matchMedia('(orientation: portrait)').matches;
window.addEventListener('resize', () => {
  if (!isMobileLayout()) return;
  const nowPortrait = window.matchMedia('(orientation: portrait)').matches;
  if (nowPortrait !== _lastIsPortrait) {
    // Debounce a moment so iOS doesn't fire mid-rotation.
    setTimeout(() => location.reload(), 250);
  }
});

// ── Fullscreen toggle (works on iPhone via CSS pseudo-fullscreen) ─────────
// The Fullscreen API is unreliable on iPhone Safari (only <video> elements
// can request true fullscreen). Pseudo-fullscreen via a body class hides
// everything except the canvas frame and makes it fill 100vw/100vh —
// works on every platform including iPhone PWA mode.
const fsToggle = document.getElementById('fs-toggle') as HTMLButtonElement | null;
function toggleFullscreen(): void {
  const body = document.body;
  const goingFs = !body.classList.contains('canvas-fullscreen');
  // Try native fullscreen first (desktop, Android, iPad). If it works,
  // great; if it fails (iPhone), the CSS class still gives us pseudo-FS.
  if (goingFs) {
    const el = document.getElementById('scope-frame');
    if (el && (el as HTMLElement).requestFullscreen) {
      (el as HTMLElement).requestFullscreen().catch(() => { /* fall through to CSS */ });
    }
    body.classList.add('canvas-fullscreen');
    if (fsToggle) fsToggle.textContent = '✕';
  } else {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => { /* ignore */ });
    }
    body.classList.remove('canvas-fullscreen');
    if (fsToggle) fsToggle.textContent = '⛶';
  }
}
if (fsToggle) {
  fsToggle.addEventListener('click', toggleFullscreen);
}
// Sync the body class if user exits via Esc / native exit.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('canvas-fullscreen')) {
    // User exited native fullscreen. Drop pseudo-FS too.
    document.body.classList.remove('canvas-fullscreen');
    if (fsToggle) fsToggle.textContent = '⛶';
  }
});
eventsDlBtn.addEventListener('click', downloadEventsCSV);
eventsClearBtn.addEventListener('click', clearEvents);
recBtn.addEventListener('click', toggleRecording);

document.addEventListener('keydown', (e) => {
  // Ignore letter / bracket shortcuts when the user is typing in an input
  // field (seed, burn iters). Otherwise typing 'b' in the seed input would
  // fire the soup brush — a real footgun in the previous version.
  const target = e.target as HTMLElement | null;
  const isTyping = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as HTMLElement).isContentEditable);
  const isShortcutKey = /^Key[A-Z]$|^Bracket(Left|Right)$/.test(e.code);
  if (isTyping && isShortcutKey) return;

  // In game mode, WASD is reserved for the player. We still allow other shortcuts.
  if (gameMode && (e.code === 'KeyW' || e.code === 'KeyA' || e.code === 'KeyS' || e.code === 'KeyD')) {
    if (e.code === 'KeyW') keyState.w = true;
    if (e.code === 'KeyA') keyState.a = true;
    if (e.code === 'KeyS') keyState.s = true;
    if (e.code === 'KeyD') keyState.d = true;
    pushPlayerInput();
    return;
  }
  // Esc: close the inspector first, then panel, then reset brush.
  if (e.code === 'Escape') {
    if (isInspectorOpen()) { closeInspector(); return; }
    if (isPanelOpen()) { closePanel(); return; }
    setBrush('pan');
    return;
  }
  if (e.code === 'KeyI') { e.preventDefault(); openInspector(); }
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  if (e.code === 'KeyP')  { toggleLysin(); }
  if (e.code === 'KeyR')  { toggleRecording(); }
  if (e.code === 'KeyB')  { setBrush('soup'); }
  if (e.code === 'KeyW')  { setBrush('water'); }
  if (e.code === 'KeyC')  { clearWater(); }
  if (e.code === 'KeyV')  { toggleView(); }
  if (e.code === 'KeyG')  { toggleGame(); }
  if (e.code === 'KeyN')  { toggleNoise(); }
  if (e.code === 'KeyH')  { toggleHydro(); }
  if (e.code === 'KeyM')  { e.preventDefault(); togglePanel(); }
  if (e.code === 'BracketLeft')  { e.preventDefault(); quickSave(); }
  if (e.code === 'BracketRight') { e.preventDefault(); quickLoad(); }
  if (e.code === 'KeyF')         { e.preventDefault(); freezeAndCapture(); }
  if ((e.code === 'Delete' || e.code === 'Backspace') && brushMode === 'select') {
    e.preventDefault();
    send({ type: 'deleteSelected' });
    logStatus('Selection deleted — observe the response (works while paused)');
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
      // Arena boundary — drawn last on top of the white classic surface.
      // Uses a darker variant so it reads on white. Camera transform is
      // already set by draw2DClassic.
      const z = camera.zoom;
      overlayCtx.setTransform(z, 0, 0, z, -camera.x * z, -camera.y * z);
      drawArenaBorder(overlayCtx, GRID_W, GRID_H, z);
    } else if (useGPU) {
      drawGPU(snap.atoms, snap.atomCount, snap.loops, snap.bonds, snap.droplets, bacteriaView, snap.epoch, camera);
      // Reset the overlay transform before clearing — clearRect honors the
      // current transform, so leftover camera scale from classic-mode would
      // cause it to clear only a tiny world-space rect and leave the rest
      // of the overlay frozen on top of the live render beneath.
      overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
      // Arena boundary on the overlay. Skipped in microscope mode to
      // preserve the raw-slide aesthetic (no UI elements over the blur).
      if (viewMode !== 'microscope') {
        const z = camera.zoom;
        overlayCtx.setTransform(z, 0, 0, z, -camera.x * z, -camera.y * z);
        drawArenaBorder(overlayCtx, GRID_W, GRID_H, z);
        overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
      }
      if (viewMode === 'educational') drawHUD2D(overlayCtx, snap.iterations, snap.atomCount, snap.atoms);
    } else if (ctx2d) {
      draw2D(ctx2d, snap.atoms, snap.atomCount, snap.loops, snap.bonds, snap.droplets, bacteriaView, snap.epoch, camera);
      // Arena boundary on the 2D fallback canvas. Skipped in microscope.
      if (viewMode !== 'microscope') {
        const z = camera.zoom;
        ctx2d.setTransform(z, 0, 0, z, -camera.x * z, -camera.y * z);
        drawArenaBorder(ctx2d, GRID_W, GRID_H, z);
      }
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
  // Selection is now a multi-atom set (cluster select via bond BFS in
  // the worker). Collect every atom carrying flag bit 4 and ring each
  // one. Also drives the panel's "N atoms selected" indicator.
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < snap.atomCount; i++) {
    const flags = snap.atoms[i * STRIDE + 3] | 0;
    if (flags & 16) {
      xs.push(snap.atoms[i * STRIDE + 0]);
      ys.push(snap.atoms[i * STRIDE + 1]);
    }
  }
  if (selectionCountEl) {
    selectionCountEl.textContent = xs.length === 0
      ? 'No selection · use the Select brush, then click any atom'
      : `${xs.length} atom${xs.length === 1 ? '' : 's'} selected · press I or click Open inspector`;
  }
  const microscope = viewMode === 'microscope';
  if (xs.length === 0) return;

  // Pick the right context. In the pure-2D view the overlay is empty and the
  // main ctx2d holds the world; everywhere else the overlay sits on top.
  const useOverlay = viewMode !== 'educational' || useGPU || microscope;
  const ctx = useOverlay ? overlayCtx : ctx2d;
  if (!ctx) return;

  // World→screen camera transform, same convention as the renderers.
  const z = camera.zoom;
  ctx.setTransform(z, 0, 0, z, -camera.x * z, -camera.y * z);

  // Pulsing yellow halo. Period ~1.2s. Phase from wallclock so it animates
  // even if the sim is paused. Drawn for every selected atom so a
  // cluster reads as a glowing constellation rather than a single dot.
  const t = (performance.now() / 1000) * 2 * Math.PI / 1.2;
  const pulse = 0.6 + 0.4 * (Math.sin(t) * 0.5 + 0.5);
  ctx.lineWidth = Math.max(1.0, 2.5 / z);
  ctx.strokeStyle = `rgba(255, 220, 60, ${pulse.toFixed(3)})`;
  for (let i = 0; i < xs.length; i++) {
    ctx.beginPath();
    ctx.arc(xs[i], ys[i], 14, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Crosshair: only on a single-atom selection, otherwise the visual
  // gets noisy with N crosshairs across a cluster.
  if (xs.length === 1) {
    const sx = xs[0], sy = ys[0];
    ctx.strokeStyle = `rgba(255, 240, 120, ${(pulse * 0.7).toFixed(3)})`;
    ctx.lineWidth = Math.max(0.6, 1.0 / z);
    ctx.beginPath();
    ctx.moveTo(sx - 8, sy); ctx.lineTo(sx + 8, sy);
    ctx.moveTo(sx, sy - 8); ctx.lineTo(sx, sy + 8);
    ctx.stroke();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
requestAnimationFrame(loop);
