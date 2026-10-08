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

// Injected by esbuild at build time from package.json "version"
// (--define:APP_VERSION in the build script) so the credits modal
// always shows the version that was actually bundled.
declare const APP_VERSION: string;

import { ControlMsg, SnapshotMsg, BurnProgressMsg, BurnDoneMsg, SaveStateMsg, LoadResultMsg, EventLogChunkMsg, SelectionExportMsg, FireRejectedMsg, PlayerHitMsg, DartHitMsg, SelectionState, CustomAtomDef, CustomRuleSpec, SaveState, STRIDE } from './snapshot';
import { setCustomAtomColor as setGPUCustomColor } from './renderer-gpu';
import { setClassicAtomColor, setEducationalAtomColor } from './renderer-2d';
import { draw2D, draw2DClassic, drawHUD2D, drawGameHUD2D, drawArenaBorder, HUD_STATS_RECT } from './renderer-2d';
import { initGPU, drawGPU } from './renderer-gpu';
import { startTutorial, observeControl } from './tutorial';

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
  x: Math.max(0, (GRID_W - VIEW_W / fitZoom) / 2),
  y: Math.max(0, (GRID_H - VIEW_H / fitZoom) / 2),
  zoom: fitZoom,
};
// The arena always fills the viewport — zooming out past fit would
// show empty margin around the grid. MIN_ZOOM tracks the canvas size:
// resizeCanvasToDisplay recomputes it when the internal resolution
// follows a window resize.
let MIN_ZOOM = fitZoom;
const MAX_ZOOM = 6;

// Clamp a camera position into the arena at the given zoom: top-left on
// the axis where the view is larger than the grid (margin collects on
// the right or bottom edge), clamped on the axis where it is smaller.
function clampCamXY(x: number, y: number, zoom: number): { x: number; y: number } {
  const vw = canvas.width / zoom;
  const vh = canvas.height / zoom;
  return {
    x: vw >= GRID_W ? 0 : Math.max(0, Math.min(GRID_W - vw, x)),
    y: vh >= GRID_H ? 0 : Math.max(0, Math.min(GRID_H - vh, y)),
  };
}
function clampCameraToArena(): void {
  const c = clampCamXY(camera.x, camera.y, camera.zoom);
  camera.x = c.x;
  camera.y = c.y;
}

// ── Fit snap ──────────────────────────────────────────────────────────
// Hitting the zoom floor eases the camera into the fully-fitted,
// top-left-pinned position over ~0.5 s instead of jumping. Any manual
// camera move (pan, wheel-in, pinch, follow, scripted focus) cancels
// the tween.
const SNAP_MS = 500;
let camSnap: {
  t0: number;
  fx: number; fy: number; fz: number;
  tx: number; ty: number; tz: number;
} | null = null;

function snapCameraToFit(): void {
  const t = clampCamXY(camera.x, camera.y, MIN_ZOOM);
  camSnap = {
    t0: performance.now(),
    fx: camera.x, fy: camera.y, fz: camera.zoom,
    tx: t.x, ty: t.y, tz: MIN_ZOOM,
  };
}

// Called once per frame from the render loop.
function snapTick(): void {
  if (!camSnap) return;
  const t = Math.min(1, (performance.now() - camSnap.t0) / SNAP_MS);
  const e = 1 - (1 - t) * (1 - t) * (1 - t); // ease-out cubic
  camera.x    = camSnap.fx + (camSnap.tx - camSnap.fx) * e;
  camera.y    = camSnap.fy + (camSnap.ty - camSnap.fy) * e;
  camera.zoom = camSnap.fz + (camSnap.tz - camSnap.fz) * e;
  if (t >= 1) camSnap = null;
}

// ── Fluid canvas sizing ───────────────────────────────────────────────
// On landscape layouts the canvas display box fills the window width
// and the height left under the page chrome (see the FLUID CANVAS media
// queries in index.html). The internal resolution tracks the box 1:1,
// so resizing only reframes the arena — nothing stretches. Portrait
// mobile is excluded: it keeps the fixed 800×1400 internal resolution
// with CSS aspect scaling.
const FILL_MQ = '(min-width: 901px) and (pointer: fine), (orientation: landscape)';
function resizeCanvasToDisplay(): void {
  if (!window.matchMedia(FILL_MQ).matches) return;
  const w = Math.max(1, Math.round(canvas.clientWidth));
  const h = Math.max(1, Math.round(canvas.clientHeight));
  if (w === canvas.width && h === canvas.height) return;
  camSnap = null;
  canvas.width = overlay.width = w;
  canvas.height = overlay.height = h;
  // A camera sitting at the old minimum stays fully zoomed out on the
  // new box; a zoomed-in camera keeps its zoom unless it now exceeds
  // the allowed range.
  const wasFullyOut = camera.zoom <= MIN_ZOOM + 1e-9;
  MIN_ZOOM = Math.min(w / GRID_W, h / GRID_H);
  camera.zoom = wasFullyOut ? MIN_ZOOM
    : Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom));
  clampCameraToArena();
}
resizeCanvasToDisplay();
let _resizeRaf = 0;
window.addEventListener('resize', () => {
  if (_resizeRaf) return;
  _resizeRaf = requestAnimationFrame(() => {
    _resizeRaf = 0;
    resizeCanvasToDisplay();
    // The HUD toggle's docked position is in canvas-internal px —
    // recompute it whenever the display scale changes.
    applyHudVisibility();
  });
});

// ── Camera follow — tracks a captured set of atoms by ID ──────────────────
// On activation the atom IDs of the current selection (snapshot flag bit4)
// are captured; from then on the centroid of *those atoms* is followed, so
// clearing the selection afterwards does not drop the track. Pure
// main-thread work — no extra worker messages needed.
let followIds: Set<number> | null = null;
// Game start pre-selects a player atom in the worker — this flag arms
// follow as soon as that selection arrives in a snapshot.
let armFollowOnSelection = false;
const followBtn = document.getElementById('follow-btn') as HTMLButtonElement | null;

function setFollow(on: boolean): void {
  if (on) {
    const snap = lastSnapshot;
    followIds = new Set<number>();
    if (snap) {
      for (let i = 0; i < snap.atomCount; i++) {
        if (((snap.atoms[i * STRIDE + 3] | 0) & 16) !== 0) followIds.add(snap.atomIds[i]);
      }
    }
    if (followIds.size === 0) {
      followIds = null;
      logStatus('⚠ Follow: nothing selected — select atoms first (🎯 tool)');
    }
  } else {
    followIds = null;
  }
  const followState = followBtn?.querySelector<HTMLElement>('.brush-state');
  if (followState) followState.textContent = followIds ? 'ON' : 'OFF';
}
if (followBtn) followBtn.addEventListener('click', () => setFollow(!followIds));

// Called once per rendered frame while following. The centroid is
// re-sampled at most every SNAP_MS and reached via the snap tween — the
// camera glides to each sample instead of jittering frame-by-frame.
function followTick(snap: SnapshotMsg): void {
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < snap.atomCount; i++) {
    if (!followIds!.has(snap.atomIds[i])) continue;
    sx += snap.atoms[i * STRIDE];
    sy += snap.atoms[i * STRIDE + 1];
    n++;
  }
  if (n === 0) {
    setFollow(false);
    logStatus('[CAM] follow stopped — tracked atoms gone');
    return;
  }
  const now = performance.now();
  if (camSnap && now - camSnap.t0 < SNAP_MS) return;
  const c = clampCamXY(
    sx / n - canvas.width  / camera.zoom / 2,
    sy / n - canvas.height / camera.zoom / 2,
    camera.zoom,
  );
  camSnap = {
    t0: now,
    fx: camera.x, fy: camera.y, fz: camera.zoom,
    tx: c.x, ty: c.y, tz: camera.zoom,
  };
}

// Center the camera on a world point at a zoom that fits `radius` snugly —
// used by scripted focuses (tutorial demos).
function focusOn(x: number, y: number, radius: number): void {
  camSnap = null;
  const z = 0.8 * Math.min(canvas.width, canvas.height) / (2 * radius);
  camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  camera.x = x - canvas.width / camera.zoom / 2;
  camera.y = y - canvas.height / camera.zoom / 2;
  clampCameraToArena();
}

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
  }
  // Note: select mode is handled via the dedicated drag-rectangle path
  // below. A no-drag click (mouseup at the same spot as mousedown) fires
  // a single-atom selectAt; otherwise the drag becomes a selectBox.
}

// Selection drag-rectangle state. Anchor + cursor in WORLD coordinates so
// the box stays glued to the world while the camera moves underneath.
// Both null when not dragging in select mode.
let selectBoxStart: { x: number; y: number } | null = null;
let selectBoxEnd:   { x: number; y: number } | null = null;
// Screen-space anchor used to distinguish a no-drag click from a drag.
// Recorded at mousedown; if mouseup happens within SELECT_CLICK_THRESHOLD
// pixels of this point, treat it as a single-atom click.
let selectAnchorScreen: { x: number; y: number } | null = null;
const SELECT_CLICK_THRESHOLD = 6;
function finishSelect(clientX: number, clientY: number): void {
  if (!selectBoxStart || !selectAnchorScreen) {
    selectBoxStart = null; selectBoxEnd = null; selectAnchorScreen = null;
    return;
  }
  const dx = clientX - selectAnchorScreen.x;
  const dy = clientY - selectAnchorScreen.y;
  const movedFar = dx * dx + dy * dy > SELECT_CLICK_THRESHOLD * SELECT_CLICK_THRESHOLD;
  if (movedFar && selectBoxEnd) {
    send({
      type: 'selectBox',
      x0: selectBoxStart.x, y0: selectBoxStart.y,
      x1: selectBoxEnd.x,   y1: selectBoxEnd.y,
    });
  } else {
    // Treat as a click on the anchor point — single-atom select.
    send({ type: 'selectAt', x: selectBoxStart.x, y: selectBoxStart.y, radius: 30 });
  }
  selectBoxStart = null;
  selectBoxEnd = null;
  selectAnchorScreen = null;
}

canvas.addEventListener('mousedown', (e) => {
  dragging = true; lastMx = e.clientX; lastMy = e.clientY;
  if (brushMode === 'pan') {
    if (gameMode) {
      // Press & hold steers the microbe toward the pointer.
      steerTarget = screenToWorld(e.clientX, e.clientY);
    } else {
      canvas.style.cursor = 'grabbing';
    }
  } else if (brushMode === 'select') {
    const w = screenToWorld(e.clientX, e.clientY);
    selectBoxStart = { x: w.x, y: w.y };
    selectBoxEnd   = { x: w.x, y: w.y };
    selectAnchorScreen = { x: e.clientX, y: e.clientY };
  } else {
    applyBrushAt(e.clientX, e.clientY);
  }
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  if (brushMode === 'pan') {
    if (gameMode) {
      // Steering, not panning — the press point follows the pointer.
      if (steerTarget) steerTarget = screenToWorld(e.clientX, e.clientY);
      return;
    }
    if (followIds !== null) setFollow(false); // user takes the camera back
    camSnap = null;
    const d = clientDeltaToWorld(e.clientX - lastMx, e.clientY - lastMy);
    camera.x -= d.dx;
    camera.y -= d.dy;
    lastMx = e.clientX; lastMy = e.clientY;
  } else if (brushMode === 'select') {
    if (selectBoxStart) {
      const w = screenToWorld(e.clientX, e.clientY);
      selectBoxEnd = { x: w.x, y: w.y };
    }
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
window.addEventListener('mouseup', (e) => {
  if (dragging && brushMode === 'select') finishSelect(e.clientX, e.clientY);
  dragging = false;
  endSteer();
  canvas.style.cursor = brushMode === 'pan' ? 'grab' : 'crosshair';
});
canvas.style.cursor = 'grab';

// Mouse wheel → zoom around cursor
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const c = clientToCanvas(e.clientX, e.clientY);
  // Follow mode survives zooming: the tracked atoms stay centered, so
  // the zoom pivots on the view center instead of the cursor.
  const following = followIds !== null;
  const worldX = following
    ? camera.x + canvas.width / camera.zoom / 2
    : c.x / camera.zoom + camera.x;
  const worldY = following
    ? camera.y + canvas.height / camera.zoom / 2
    : c.y / camera.zoom + camera.y;
  const ax = following ? canvas.width / 2 : c.x;
  const ay = following ? canvas.height / 2 : c.y;
  // Proportional zoom: scale with the wheel delta so one mouse notch
  // (~100 px) is a gentle ~5 % step and high-resolution trackpad deltas
  // glide instead of jumping. deltaMode 1 (lines) is normalized to px.
  const deltaPx = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
  const factor = Math.exp(-deltaPx * 0.0005);
  const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * factor));
  if (newZoom <= MIN_ZOOM) {
    snapCameraToFit();
  } else {
    camSnap = null;
    camera.x = worldX - ax / newZoom;
    camera.y = worldY - ay / newZoom;
    camera.zoom = newZoom;
  }
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
    if (brushMode === 'select') {
      const w = screenToWorld(t.clientX, t.clientY);
      selectBoxStart = { x: w.x, y: w.y };
      selectBoxEnd   = { x: w.x, y: w.y };
      selectAnchorScreen = { x: t.clientX, y: t.clientY };
    } else if (brushMode !== 'pan') {
      applyBrushAt(t.clientX, t.clientY);
    } else if (gameMode) {
      // Press & hold steers the microbe toward the touch point.
      steerTarget = screenToWorld(t.clientX, t.clientY);
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
      if (newZoom <= MIN_ZOOM) {
        snapCameraToFit();
      } else {
        camSnap = null;
        // Follow mode survives pinch zoom — pivot on the view center
        // (tracked atoms) instead of the finger midpoint.
        const following = followIds !== null;
        const worldX = following
          ? pinchStartCamX + canvas.width / pinchStartZoom / 2
          : pinchStartMidX / pinchStartZoom + pinchStartCamX;
        const worldY = following
          ? pinchStartCamY + canvas.height / pinchStartZoom / 2
          : pinchStartMidY / pinchStartZoom + pinchStartCamY;
        const ax = following ? canvas.width / 2 : newMidCanvas.x;
        const ay = following ? canvas.height / 2 : newMidCanvas.y;
        camera.x = worldX - ax / newZoom;
        camera.y = worldY - ay / newZoom;
        camera.zoom = newZoom;
      }
    }
  } else if (activeGesture === 'single' && e.touches.length === 1 && dragging) {
    const t = e.touches[0];
    if (brushMode === 'pan') {
      if (gameMode) {
        // Steering, not panning — the press point follows the finger.
        if (steerTarget) steerTarget = screenToWorld(t.clientX, t.clientY);
      } else {
        if (followIds !== null) setFollow(false); // user takes the camera back
        camSnap = null;
        const d = clientDeltaToWorld(t.clientX - lastMx, t.clientY - lastMy);
        camera.x -= d.dx;
        camera.y -= d.dy;
        lastMx = t.clientX; lastMy = t.clientY;
      }
    } else if (brushMode === 'select') {
      if (selectBoxStart) {
        const w = screenToWorld(t.clientX, t.clientY);
        selectBoxEnd = { x: w.x, y: w.y };
      }
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
    if (brushMode === 'select' && selectBoxStart) {
      // changedTouches has the finger that just lifted — use it as the
      // release point for the click-vs-drag decision.
      const t = e.changedTouches[0];
      if (t) finishSelect(t.clientX, t.clientY);
    }
    activeGesture = 'none';
    dragging = false;
    endSteer();
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
  endSteer();
}, { passive: true });

// ── Worker ──────────────────────────────────────────────────────────────────
// Cache-bust the worker URL on every page load so iOS Safari and other
// aggressive caches can't pin old physics code in memory. Bundle.js is
// busted separately by the inline loader in index.html. Cost is one
// extra worker.js fetch per session — irrelevant for a sim that runs
// for minutes/hours.
const worker = new Worker('dist/worker.js?v=' + Date.now());
function send(msg: ControlMsg): void { observeControl(msg); worker.postMessage(msg); }
function sendTransfer(msg: ControlMsg, transferables: Transferable[]): void {
  worker.postMessage(msg, transferables);
}

// Latest snapshot held by main thread for rendering.
// Because rAF and onmessage cannot interleave (JS single-threaded), it's safe
// to immediately ship the previous snapshot's buffers back to the worker the
// moment a new one arrives — no pendingReturn queue needed (and that queue
// caused a deadlock when the worker only had 2 buffers in its pool).
let lastSnapshot: SnapshotMsg | null = null;

type WorkerMsg = SnapshotMsg | BurnProgressMsg | BurnDoneMsg | SaveStateMsg | LoadResultMsg | EventLogChunkMsg | SelectionExportMsg | FireRejectedMsg | PlayerHitMsg | DartHitMsg;

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
  if (data.type === 'fireRejected') {
    // The worker is the authority on both gates — a stale mirrored
    // cooldown or magazine can let a press through that still needs
    // a visible explanation.
    logStatus(data.reason === 'cooldown' ? 'Reloading…' : 'Out of lysin — fly through orange p-atoms to rearm');
    return;
  }
  if (data.type === 'playerHit') {
    lastBiteAt = performance.now();
    // Bites can land in bursts during a sustained hug — the red flash
    // fires every time, the status line only every couple of seconds.
    if (performance.now() - lastBiteStatusAt > 2000) {
      lastBiteStatusAt = performance.now();
      logStatus('⚠ membrane breached — break contact!');
    }
    return;
  }
  if (data.type === 'dartHit') {
    logStatus('☄ direct hit — lysin cloud released');
    return;
  }
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

// ── Button help hints in the status line ────────────────────────────────────
// Every control button carries a data-help description. Hovering (or
// long-pressing on touch) previews that text in the status line without
// firing the control; leaving restores whatever was there before. A real
// logStatus() landing while a hint is visible wins — the restore only
// runs while the hint text is still showing.
let helpBackup: string | null = null;
let helpShownFor: Element | null = null;
let helpTouchTimer = 0;
let helpSuppressClick = false;
function showHelpHint(el: Element): void {
  const help = el.getAttribute('data-help');
  if (!help || !statusEl) return;
  if (helpShownFor === null) helpBackup = statusEl.textContent;
  helpShownFor = el;
  statusEl.textContent = help;
}
function hideHelpHint(el: Element): void {
  if (helpShownFor !== el || !statusEl) return;
  if (statusEl.textContent === el.getAttribute('data-help')) {
    statusEl.textContent = helpBackup;
  }
  helpShownFor = null;
  helpBackup = null;
}
// Delegated mouse hover — mouseover/mouseout bubble, closest() resolves
// the hint owner for lazy or nested content (e.g. kbd badges).
document.addEventListener('mouseover', (e) => {
  const el = (e.target as Element).closest?.('[data-help]');
  if (el && helpShownFor !== el) showHelpHint(el);
});
document.addEventListener('mouseout', (e) => {
  const el = (e.target as Element).closest?.('[data-help]');
  if (!el) return;
  // Moving onto a child inside the same hint element is not a leave.
  const to = (e.relatedTarget as Element | null)?.closest?.('[data-help]');
  if (to !== el) hideHelpHint(el);
});
// Touch has no hover: a 450ms press shows the hint and swallows the
// synthetic click so the control itself does not fire; releasing hides
// it again. Short taps pass through untouched.
document.addEventListener('touchstart', (e) => {
  window.clearTimeout(helpTouchTimer);
  helpSuppressClick = false;
  const el = (e.target as Element).closest?.('[data-help]');
  if (!el) return;
  helpTouchTimer = window.setTimeout(() => {
    helpSuppressClick = true;
    showHelpHint(el);
  }, 450);
}, { passive: true });
document.addEventListener('touchmove', () => {
  window.clearTimeout(helpTouchTimer);
}, { passive: true });
document.addEventListener('touchend', (e) => {
  window.clearTimeout(helpTouchTimer);
  const el = (e.target as Element).closest?.('[data-help]');
  if (el) hideHelpHint(el);
}, { passive: true });
document.addEventListener('touchcancel', () => {
  window.clearTimeout(helpTouchTimer);
  helpSuppressClick = false;
}, { passive: true });
document.addEventListener('click', (e) => {
  if (!helpSuppressClick) return;
  helpSuppressClick = false;
  e.preventDefault();
  e.stopPropagation();
}, true);

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
  // The ‹/› HUD toggle only docks inside the stats box in educational
  // view — re-dock it for the new mode.
  applyHudVisibility();
  logStatus(`View → ${label} (${desc})`);
}

function setBrush(next: Brush): void {
  const prev = brushMode;
  brushMode = brushMode === next ? 'pan' : next;
  soupBrushBtn.classList.toggle('active', brushMode === 'soup');
  waterBrushBtn.classList.toggle('active', brushMode === 'water');
  selectBtn.classList.toggle('active', brushMode === 'select');
  // ON/OFF suffix in the label so users see the button toggles back to pan
  soupBrushBtn.querySelector('.brush-state')!.textContent = brushMode === 'soup' ? 'ON' : 'OFF';
  waterBrushBtn.querySelector('.brush-state')!.textContent = brushMode === 'water' ? 'ON' : 'OFF';
  selectBtn.querySelector('.brush-state')!.textContent = brushMode === 'select' ? 'ON' : 'OFF';
  canvas.style.cursor = brushMode === 'pan' ? 'grab' : 'crosshair';
  // Leaving select mode → drop any current selection so the halo disappears.
  if (prev === 'select' && brushMode !== 'select') send({ type: 'deselectAll' });
  if (prev !== brushMode) {
    if (brushMode === 'pan')    logStatus('Brush off — drag pans the camera');
    if (brushMode === 'soup')   logStatus('Soup brush ON — click & drag to seed atoms');
    if (brushMode === 'water')  logStatus('Water brush ON — click to drop water (touching droplets fuse)');
    if (brushMode === 'select') logStatus('Select ON — drag a box to grab atoms inside · click a single atom for individual select · Delete removes selection');
  }
}
function clearWater(): void {
  send({ type: 'clearWater' });
  logStatus('Cleared all water droplets');
}

// Buttons that are HIDDEN while in microbe-steering mode — controls that
// don't fit a "you-vs-them" game (sandbox tools).
const GAME_HIDDEN_BTN_IDS = ['soup-brush-btn', 'water-brush-btn', 'clear-water-btn', 'lysin-btn', 'drip-btn', 'burn-btn', 'burn-iters'];

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

// The spinner steps adapt to the current order of magnitude — one tenth
// of it (1000 → ±100, 10000 → ±1000, 500 → ±10). The browser applies
// whatever `step` is set at click time, so it is recomputed on input.
const BURN_ITERS_MIN = 100;
function burnStepFor(v: number): number {
  const order = Math.floor(Math.log10(Math.max(BURN_ITERS_MIN, v)));
  return Math.max(1, Math.pow(10, order - 1));
}
function syncBurnStep(): void {
  burnIters.step = String(burnStepFor(parseInt(burnIters.value) || 0));
}
burnIters.addEventListener('input', syncBurnStep);
// The browser reads `step` before dispatching `input` — a value changed
// without an input event (or whose last input fired at a smaller
// magnitude) would step with a stale step. Arrow keys and spinner
// clicks sync on the earlier keydown/pointerdown instead.
burnIters.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') syncBurnStep();
});
burnIters.addEventListener('pointerdown', syncBurnStep);
burnIters.addEventListener('change', () => {
  // Snap typed values onto the current step grid — an off-grid value
  // would trigger the browser's step-mismatch warning on the next
  // spinner press.
  const v = Math.floor(parseInt(burnIters.value) || 0);
  if (v > 0) {
    const step = burnStepFor(v);
    burnIters.value = String(Math.max(BURN_ITERS_MIN, Math.round(v / step) * step));
  }
  syncBurnStep();
});
syncBurnStep();

function startBurn(): void {
  if (burning) { send({ type: 'abortBurn' }); logStatus('Stopping burn…'); return; }
  const requested = Math.max(BURN_ITERS_MIN, Math.floor(parseInt(burnIters.value) || 1000));
  const startIter = lastSnapshot?.iterations ?? 0;
  burnStartIter  = startIter;
  burnTargetIter = startIter + requested;
  burnWallStart  = performance.now();
  burning = true;
  burnBtn.classList.add('recording');
  burnBtn.textContent = '✕ Stop (0.00%)';
  send({ type: 'burn', targetIters: burnTargetIter });
  logStatus(`Burn started → +${requested.toLocaleString()} iters (target ${burnTargetIter.toLocaleString()})`);
}

function onBurnProgress(p: BurnProgressMsg): void {
  if (!burning) return;
  const span = burnTargetIter - burnStartIter;
  const done = p.iterations - burnStartIter;
  const pct  = span > 0 ? Math.min(100, (done / span) * 100) : 100;
  const pctStr = pct.toFixed(2);
  burnBtn.textContent = `✕ Stop (${pctStr}%)`;
  // Estimate ETA from current rate.
  const remaining = Math.max(0, burnTargetIter - p.iterations);
  const etaSec = p.stepsPerSec > 0 ? Math.round(remaining / p.stepsPerSec) : 0;
  showStatus(
    `Burning · iter ${p.iterations.toLocaleString()} / ${p.target.toLocaleString()} ` +
    `(${pctStr}%) · ${p.stepsPerSec.toLocaleString()} steps/sec · ETA ${etaSec}s`
  );
}

function onBurnDone(d: BurnDoneMsg): void {
  burning = false;
  burnBtn.classList.remove('recording');
  burnBtn.textContent = burnDefaultLabel;
  const wallSec = (performance.now() - burnWallStart) / 1000;
  // A world rebuild can abort a burn with the counter already back at
  // 0 — the delta would report negative iters otherwise.
  const itersDone = Math.max(0, d.iterations - burnStartIter);
  const rate = wallSec > 0 ? Math.round(itersDone / wallSec) : 0;
  if (d.aborted) {
    logStatus(`Burn stopped @ iter ${d.iterations.toLocaleString()} · processed ${itersDone.toLocaleString()} iters in ${wallSec.toFixed(1)}s (${rate.toLocaleString()} steps/sec)`);
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
  // WASD steers the player in game mode — the Select shortcut badge is
  // hidden while it has no effect, and the shortcuts card explains the
  // steering keys instead.
  const wasdHint = document.getElementById('wasd-hint');
  if (wasdHint) wasdHint.style.display = gameMode ? 'contents' : 'none';
  const selectBadge = selectBtn?.querySelector<HTMLElement>('.kbd-badge');
  if (selectBadge) selectBadge.style.display = gameMode ? 'none' : '';
  // The worker suspends sandbox noise/hydrolysis while a match runs —
  // the buttons mirror the suspended OFF state and are disabled so no
  // mid-game click can re-enable hazards the game does not own. On exit
  // they show the user's sandbox setting again (noiseOn/hydroOn are
  // unchanged).
  noiseBtn.textContent = (!gameMode && noiseOn) ? '🧬 Noise: ON' : '🧬 Noise: OFF';
  noiseBtn.classList.toggle('active', !gameMode && noiseOn);
  noiseSlidersRow.classList.toggle('shown', !gameMode && noiseOn);
  noiseBtn.disabled = gameMode;
  hydroBtn.textContent = (!gameMode && hydroOn) ? '💧🧪 Hydrolysis: ON' : '💧🧪 Hydrolysis: OFF';
  hydroBtn.classList.toggle('active', !gameMode && hydroOn);
  hydroSlidersRow.classList.toggle('shown', !gameMode && hydroOn);
  hydroBtn.disabled = gameMode;
  // Lysin dart fire pad replaces the top-left legend while a match runs.
  fireWrap?.classList.toggle('shown', gameMode);
  firePad?.classList.toggle('shown', gameMode);
  // On touch layouts the control panel opens as a modal over a backdrop
  // that would cover the fire pad — dismiss it when a match starts.
  if (gameMode && panelBackdrop?.classList.contains('shown')) closePanel();
  hideGameOverlay();
}

// UI-side match exit without sending 'endGame' — used both when the
// user toggles play mode off and when a loaded save silently ends the
// match on the worker (its inGame flag is reset on every load while
// the loaded world must be kept, not rebuilt like endGame does).
function exitGameModeUI(): void {
  gameMode = false;
  gameBtn.textContent = '🦠 Steer a microbe';
  gameBtn.classList.remove('active');
  armFollowOnSelection = false;
  setFollow(false);
  keyState.w = keyState.a = keyState.s = keyState.d = false;
  steerTarget = null;
  ringDir = null;
  steerRing?.classList.remove('steering');
  send({ type: 'setPlayerInput', x: 0, y: 0 });
  applyGameModeUI();
}

function toggleGame(): void {
  if (gameMode) {
    send({ type: 'endGame' });
    exitGameModeUI();
    logStatus('Play mode OFF — sandbox restored');
    return;
  }
  gameMode = true;
  matchStartAt = performance.now();
  gameBtn.textContent = '🦠 Exit game';
  gameBtn.classList.add('active');
  send({ type: 'startGame' });
  // The worker pre-selects a player atom in setupGame; the snapshot
  // loop arms follow once that flag arrives.
  armFollowOnSelection = true;
  applyGameModeUI();
  logStatus('Play mode ON — press & hold on the canvas to steer your microbe (WASD works too)');
}

// ── Lysin dart fire pad ─────────────────────────────────────────────
// Game-mode replacement for the legend block: the press position vs.
// the pad's center is the launch direction, so it works identically on
// mouse and touch. The needle marks the aim; the conic --cd sweep shows
// reload, drained each frame from the worker's snapshot fields.
const fireWrap = document.getElementById('fire-wrap') as HTMLElement | null;
const steerRing = document.getElementById('steer-ring') as HTMLElement | null;
const firePad = document.getElementById('fire-pad') as HTMLElement | null;
const fireNeedle = document.getElementById('fire-needle') as HTMLElement | null;
const fireEnemy = document.getElementById('fire-enemy') as HTMLElement | null;
const fireLysin = document.getElementById('fire-lysin') as HTMLElement | null;
let lastFireCooldownIter = 0; // worker-side reload, mirrored per snapshot
let minEnemyCount = -1; // lowest enemy loop count seen this match (-1 outside a match)
let homingSeen = false; // snapshot mirror of the worker's guidance unlock — rising edge logs once per match
let matchStartAt = -1e9; // performance.now() of match start — suppresses the kill-feed during loop-detection warmup
let lastBiteAt = -1e9;        // performance.now() of the last enemy bite (drives the damage flash)
let lastBiteStatusAt = -1e9;  // throttles the 'membrane breached' status text

if (firePad) {
  firePad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = firePad.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const mag = Math.hypot(dx, dy);
    if (mag < 4) return; // dead center — no direction to launch along
    // The needle turns to the aim regardless of reload — it doubles as
    // the last-shot marker. 0deg is straight up, so offset by 90°.
    const deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;
    if (fireNeedle) fireNeedle.style.transform = `rotate(${deg}deg)`;
    // The mirrored magazine is a fast-path hint only — when it is stale
    // the 'fire' message still reaches the worker, which answers a real
    // shortage with 'fireRejected' and the status line explains it.
    if (lastFireCooldownIter > 0) return; // still reloading
    send({ type: 'fire', x: dx, y: dy });
    console.log(`[FIRE] lysovirus requested dir(${(dx / mag).toFixed(2)},${(dy / mag).toFixed(2)})`);
  });
}

// Steering ring — the annulus around the fire pad. Holding the ring is a
// virtual joystick: the direction from the pad center is the swim
// direction, pushed as a fixed setPlayerInput vector (unlike the canvas
// hold, which steers toward a world position). While the ring is held it
// wins over WASD and canvas steering; releasing restores them.
let ringDir: { x: number; y: number } | null = null;

function pushRingInput(): void {
  if (!gameMode || !ringDir) return;
  send({ type: 'setPlayerInput', x: ringDir.x, y: ringDir.y });
  setMoveGlow(ringDir.x, ringDir.y);
}

function updateRingDir(e: PointerEvent): void {
  if (!steerRing) return;
  const r = steerRing.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);
  const mag = Math.hypot(dx, dy);
  if (mag < 1) return;
  ringDir = { x: dx / mag, y: dy / mag };
  pushRingInput();
}

function endRingSteer(): void {
  if (!ringDir) return;
  ringDir = null;
  steerRing?.classList.remove('steering');
  pushPlayerInput(); // restores WASD / canvas-hold state
}

if (steerRing) {
  steerRing.addEventListener('pointerdown', (e) => {
    if (!gameMode) return;
    e.preventDefault();
    steerRing.setPointerCapture(e.pointerId);
    steerRing.classList.add('steering');
    updateRingDir(e);
  });
  steerRing.addEventListener('pointermove', (e) => { if (ringDir) updateRingDir(e); });
  steerRing.addEventListener('pointerup', endRingSteer);
  steerRing.addEventListener('pointercancel', endRingSteer);
}

// ── HUD hide/show ─────────────────────────────────────────────────────────
// The stats + legend block in the top-left corner can be collapsed to a
// small arrow so it never obstructs the sim. While the HUD is drawn
// (educational view) the arrow docks inside the stats box's top-right
// corner; collapsed it floats in the canvas corner on its own. The
// choice persists across sessions.
const HUD_STATE_KEY = 'primordium-hud-v1';
const hudToggleBtn = document.getElementById('hud-toggle') as HTMLButtonElement | null;
let hudVisible = ((): boolean => {
  try { return localStorage.getItem(HUD_STATE_KEY) !== '0'; } catch { return true; }
})();
function positionHudToggle(): void {
  if (!hudToggleBtn || !hudVisible || viewMode !== 'educational') return;
  // Docked left-aligned inside the stats box, vertically centered next
  // to the text. Convert internal px into CSS px — the button is fixed
  // 26 CSS px while the canvas may be scaled (portrait mobile).
  const s = (canvas.clientWidth || canvas.width) / canvas.width;
  hudToggleBtn.style.left = `${(HUD_STATS_RECT.x + 8) * s}px`;
  hudToggleBtn.style.top  = `${(HUD_STATS_RECT.y + HUD_STATS_RECT.h / 2) * s - 13}px`;
}
function applyHudVisibility(): void {
  if (!hudToggleBtn) return;
  hudToggleBtn.textContent = hudVisible ? '‹' : '›';
  const docked = hudVisible && viewMode === 'educational';
  // Docked inside the dark stats box the backdrop-blend turns the button
  // almost black — the .docked style gives it the same perceived color
  // and transparency as when it floats over the bright canvas.
  hudToggleBtn.classList.toggle('docked', docked);
  if (docked) {
    positionHudToggle();
  } else {
    hudToggleBtn.style.left = '8px';
    hudToggleBtn.style.top  = '8px';
  }
}
if (hudToggleBtn) {
  hudToggleBtn.addEventListener('click', () => {
    hudVisible = !hudVisible;
    try { localStorage.setItem(HUD_STATE_KEY, hudVisible ? '1' : '0'); } catch { /* private mode */ }
    applyHudVisibility();
  });
}
applyHudVisibility();

// ── Win/Lose overlay ───────────────────────────────────────────────────────
const overlayEl = document.getElementById('game-overlay') as HTMLDivElement;
const overlayTitle = document.getElementById('game-overlay-title') as HTMLDivElement;
const overlaySub   = document.getElementById('game-overlay-sub')   as HTMLDivElement;
const gameAgainBtn = document.getElementById('game-again') as HTMLButtonElement;
const gameExitBtn  = document.getElementById('game-exit')  as HTMLButtonElement;
// overlayShownStatus: 0 hidden, 1 won, 2 lost, 3 first-visit intro.
let overlayShownStatus = 0;
const INTRO_SEEN_KEY = 'evoloom-intro-v1';

function showGameOverlay(status: number): void {
  if (overlayShownStatus === status) return;
  overlayShownStatus = status;
  overlayEl.classList.remove('blocking');
  gameAgainBtn.innerHTML = '↻ play again <kbd>↵</kbd>';
  gameExitBtn.textContent = '✕ sandbox';
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
  overlayEl.classList.remove('blocking');
  overlayEl.style.display = 'none';
}

// First-visit intro — same overlay shell as game over, but a modal
// choice between jumping into play mode or exploring the sandbox.
// localStorage remembers the visit; only the win/lose states reuse
// the overlay afterwards.
function showIntroOverlay(): void {
  overlayShownStatus = 3;
  overlayEl.classList.add('blocking');
  overlayTitle.textContent = 'EVOLOOM';
  overlayTitle.style.color = '#d4a64f';
  overlaySub.textContent = 'An artificial chemistry — steer a living cell against the swarm, or just watch the soup evolve.';
  gameAgainBtn.textContent = '▶ start game';
  gameExitBtn.textContent = '🧬 simulation';
  overlayEl.style.display = 'flex';
}
function dismissIntro(): void {
  try { localStorage.setItem(INTRO_SEEN_KEY, '1'); } catch { /* private mode — intro returns next visit */ }
  hideGameOverlay();
}
function introSeen(): boolean {
  try { return localStorage.getItem(INTRO_SEEN_KEY) === '1'; } catch { return true; }
}

// End-of-match actions — the overlay blocks nothing else, so the only
// way forward used to be the G shortcut. "again" re-runs the same
// worker start path as the first match; "sandbox" is the normal exit.
function restartMatch(): void {
  matchStartAt = performance.now();
  send({ type: 'startGame' });
  armFollowOnSelection = true;
  hideGameOverlay();
}
gameAgainBtn?.addEventListener('click', () => {
  if (overlayShownStatus === 3) { dismissIntro(); if (!gameMode) toggleGame(); }
  else restartMatch();
});
gameExitBtn?.addEventListener('click', () => {
  if (overlayShownStatus === 3) { dismissIntro(); return; }
  if (gameMode) toggleGame();
});
// Clicking the dimmed backdrop of the intro equals choosing the
// sandbox — standard click-outside-dismiss for a modal choice.
overlayEl?.addEventListener('click', (e) => {
  if (overlayShownStatus === 3 && e.target === overlayEl) dismissIntro();
});

// ── WASD/arrow input → biased Brownian. We track which of the eight
// steering keys are down and send a normalized direction vector to the
// worker whenever the set changes.
const keyState = { w: false, a: false, s: false, d: false };
// Arrow keys share the WASD state flags — four direction slots, not
// eight, so W+ArrowUp still read as one held "up".
const MOVE_KEYS: Record<string, 'w' | 'a' | 's' | 'd'> = {
  KeyW: 'w', ArrowUp: 'w',
  KeyA: 'a', ArrowLeft: 'a',
  KeyS: 's', ArrowDown: 's',
  KeyD: 'd', ArrowRight: 'd',
};

// Press-to-steer (game mode, no tool selected): while the pointer is held
// on the canvas, the microbe swims toward the pointer's world position.
// The direction is recomputed every frame because the player keeps moving.
let steerTarget: { x: number; y: number } | null = null;
let steerLastX = 0, steerLastY = 0;
// Dead zone around the target in world units — inside it the microbe is
// close enough that steering stops, avoiding jitter on the spot.
const STEER_ARRIVE_RADIUS = 15;

function playerCenterWorld(): { x: number; y: number } | null {
  const snap = lastSnapshot;
  if (!snap) return null;
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < snap.atomCount; i++) {
    // Atom flags bit3 = playerControlled (see packSnapshot in the worker).
    if (((snap.atoms[i * STRIDE + 3] | 0) & 8) !== 0) {
      sx += snap.atoms[i * STRIDE];
      sy += snap.atoms[i * STRIDE + 1];
      n++;
    }
  }
  return n > 0 ? { x: sx / n, y: sy / n } : null;
}

function pushSteerInput(): void {
  if (!gameMode || !steerTarget || ringDir) return;
  let dx = 0, dy = 0;
  const c = playerCenterWorld();
  if (c) {
    dx = steerTarget.x - c.x;
    dy = steerTarget.y - c.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > STEER_ARRIVE_RADIUS) { dx /= len; dy /= len; }
    else { dx = 0; dy = 0; }
  }
  if (dx !== steerLastX || dy !== steerLastY) {
    steerLastX = dx; steerLastY = dy;
    send({ type: 'setPlayerInput', x: dx, y: dy });
  }
  setMoveGlow(dx, dy);
}

function endSteer(): void {
  if (!steerTarget) return;
  steerTarget = null;
  steerLastX = steerLastY = 0;
  pushPlayerInput(); // restores the WASD state (usually 0,0)
}

function pushPlayerInput(): void {
  if (!gameMode) return;
  if (ringDir) { pushRingInput(); return; }
  if (steerTarget) { pushSteerInput(); return; }
  let dx = 0, dy = 0;
  if (keyState.d) dx += 1;
  if (keyState.a) dx -= 1;
  if (keyState.s) dy += 1;
  if (keyState.w) dy -= 1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len > 0) { dx /= len; dy /= len; }
  send({ type: 'setPlayerInput', x: dx, y: dy });
  setMoveGlow(dx, dy);
}

// Movement shimmer — a green wedge on the fire pad rim rotated to the
// live steering direction (same convention as the needle: 0deg = up).
// Instant feedback for key/hold input, gone the moment input stops.
function setMoveGlow(dx: number, dy: number): void {
  if (!firePad) return;
  if (dx === 0 && dy === 0) { firePad.classList.remove('moving'); return; }
  firePad.classList.add('moving');
  firePad.style.setProperty('--mdeg', `${(Math.atan2(dy, dx) * 180 / Math.PI + 90).toFixed(1)}deg`);
  // The marble rolls to mid-groove in the steer direction — every input
  // source lands here, so WASD moves it exactly like the ring press.
  steerRing?.style.setProperty('--bx', `${(dx * 128).toFixed(1)}px`);
  steerRing?.style.setProperty('--by', `${(dy * 128).toFixed(1)}px`);
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

// Speed is a rate limit, not a step multiplier — 100% lets the worker's
// auto-pacing run flat out, lower values stretch steps across ticks for
// smooth slow motion without tearing the frame rate.
// Browsers restore range inputs to their last value on reload without
// firing 'input', so the model and label must come from the DOM, not a
// hard-coded default — otherwise the slider could show 5% while the sim
// runs at 100%.
let simRate = parseInt(speedSlider.value) / 100;
speedVal.textContent = speedSlider.value + '%';
send({ type: 'setSimRate', v: simRate });
speedSlider.addEventListener('input', () => {
  simRate = parseInt(speedSlider.value) / 100;
  speedVal.textContent = speedSlider.value + '%';
  send({ type: 'setSimRate', v: simRate });
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
    const tag  = `iter${msg.state.iterations}-seed${msg.state.seed}`;
    const suggested = `primordium-${tag}`;
    const raw = window.prompt('Name your save file (no extension):', suggested);
    if (raw === null) {
      logStatus('Save cancelled');
      return;
    }
    // Sanitize: strip path separators and any trailing .json the user typed.
    let name = raw.trim().replace(/[\\/]/g, '_').replace(/\.json$/i, '');
    if (!name) name = suggested;
    const blob = new Blob([JSON.stringify(msg.state)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${name}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    logStatus(`Saved "${name}.json" · iter ${msg.state.iterations.toLocaleString()} · ${msg.state.cellX.length.toLocaleString()} atoms · ${msg.state.bonds.length / 2} bonds`);
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
    logStatus('No quicksave to restore — press , first to save current state');
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

// Floating popups race for the topmost layer: whichever was clicked last
// wins. #tutorial-overlay is created lazily by the tutorial module, so
// clicks are delegated on document and resolved at event time. The
// tutorial card lives inside that overlay's stacking context, so its
// click raises the overlay. .inspector is a context-free wrapper: its
// .inspector-card is raised on click while the .inspector-backdrop keeps
// its low base z — pinning the tutorial overlay just under the card
// leaves it above the dim/blur layer instead of buried beneath it.
let popupZ = 400;
document.addEventListener('pointerdown', (e) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  if (target.closest('#tutorial-card')) {
    const overlay = document.getElementById('tutorial-overlay');
    if (overlay) overlay.style.zIndex = String(++popupZ);
    return;
  }
  const popup = target.closest('.inspector');
  if (popup instanceof HTMLElement) {
    const card = popup.querySelector('.inspector-card');
    if (card instanceof HTMLElement) card.style.zIndex = String(++popupZ);
    const overlay = document.getElementById('tutorial-overlay');
    if (overlay) overlay.style.zIndex = String(popupZ - 1);
  }
});
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
// Inspector view transform — saved here so the click handlers can reverse
// canvas pixels back to world coords (for "where did the user click?")
// and forward atoms to canvas coords (for hit-testing).
let inspectorTx: { cx: number; cy: number; scale: number; W: number; H: number; r: number } | null = null;

function renderInspector(sel: SelectionState): void {
  if (!inspectorCanvas || !inspectorStats) return;
  const ctx = inspectorCanvas.getContext('2d');
  if (!ctx) return;
  const W = inspectorCanvas.width, H = inspectorCanvas.height;
  ctx.clearRect(0, 0, W, H);

  if (sel.atomCount === 0) {
    inspectorStats.textContent = editMode
      ? 'Empty canvas — click anywhere to drop your first atom.'
      : 'Empty selection — pick something with the Select brush first.';
    inspectorTx = editMode ? { cx: GRID_W / 2, cy: GRID_H / 2, scale: 1, W, H, r: 6 } : null;
    return;
  }
  // Compute bounding box for fit-to-canvas scaling. Pad by atom radius so
  // outermost atoms aren't clipped at the canvas edge.
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
  inspectorTx = { cx, cy, scale, W, H, r };

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
  const suggested = `primordium-selection-${lastSelection.atomCount}atoms`;
  const raw = window.prompt('Name your selection file (no extension):', suggested);
  if (raw === null) { logStatus('Selection save cancelled'); return; }
  let name = raw.trim().replace(/[\\/]/g, '_').replace(/\.json$/i, '');
  if (!name) name = suggested;
  const blob = new Blob([JSON.stringify(lastSelection)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  logStatus(`Saved "${name}.json" · ${lastSelection.atomCount} atoms · ${lastSelection.bonds.length / 2} bonds`);
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

// ── Inspector edit mode ───────────────────────────────────────────────────
// Toggle between read-only study view and an active CAD-style editor.
// In edit mode the user can drop new atoms from a palette, draw bonds,
// and delete atoms — every change goes through the worker so the live
// sim reflects the edit immediately. After each edit we re-request the
// selection export to pull fresh IDs/positions back into the inspector.
type EditTool = 'add' | 'bond' | 'delete';
let editMode = false;
let editTool: EditTool = 'add';
let editAtomType = 'a';
// First-click atom in a Bond gesture. Cleared on second click or Esc.
let bondPendingId: number | null = null;

const editToggleBtn  = document.getElementById('inspector-edit-toggle') as HTMLButtonElement | null;
const editorPanel    = document.getElementById('inspector-editor')      as HTMLDivElement | null;
const atomStateInput = document.getElementById('atom-state')            as HTMLInputElement | null;
const editorStatus   = document.getElementById('editor-status')         as HTMLSpanElement | null;
const toolBtns       = document.querySelectorAll<HTMLButtonElement>('.editor-tool');
const paletteBtns    = document.querySelectorAll<HTMLButtonElement>('.palette-btn');

// Per-type sensible default state. Snaps the state input when the user
// picks a palette atom — they can still override for advanced edits.
const DEFAULT_STATE: Record<string, number> = {
  a: 1, b: 0, c: 0, d: 0, e: 0, f: 0, w: 0, p: 0,
};

function setEditorStatus(msg: string): void {
  if (editorStatus) editorStatus.textContent = msg;
}
function refreshEditorStatus(): void {
  if (!editMode) return;
  if (editTool === 'add') {
    setEditorStatus(`Click empty space to drop "${editAtomType}" (state ${atomStateInput?.value ?? 0}).`);
  } else if (editTool === 'bond') {
    setEditorStatus(bondPendingId === null
      ? 'Click first atom for a bond.'
      : 'Click second atom (same atom or Esc to cancel).');
  } else if (editTool === 'delete') {
    setEditorStatus('Click an atom to remove it from the sim.');
  }
}
function setEditTool(t: EditTool): void {
  editTool = t;
  bondPendingId = null;
  toolBtns.forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  refreshEditorStatus();
}
function setPaletteAtom(t: string): void {
  editAtomType = t;
  paletteBtns.forEach(b => b.classList.toggle('active', b.dataset.atom === t));
  if (atomStateInput && DEFAULT_STATE[t] !== undefined) {
    atomStateInput.value = String(DEFAULT_STATE[t]);
  }
  refreshEditorStatus();
}
function setEditMode(on: boolean): void {
  editMode = on;
  if (editToggleBtn) {
    editToggleBtn.textContent = on ? '✏️ Edit: ON' : '✏️ Edit: OFF';
    editToggleBtn.classList.toggle('active', on);
  }
  if (editorPanel) editorPanel.hidden = !on;
  if (inspectorCanvas) inspectorCanvas.style.cursor = on ? 'crosshair' : 'default';
  bondPendingId = null;
  if (on) {
    refreshEditorStatus();
    // Re-render so the empty-state hint switches to the edit-friendly
    // copy if there's no current selection.
    if (lastSelection) renderInspector(lastSelection);
    else renderInspector(emptySelection());
  } else {
    setEditorStatus('');
  }
}

function emptySelection(): SelectionState {
  return {
    magic: 'primordium-selection',
    version: 1,
    savedAt: new Date().toISOString(),
    atomCount: 0,
    cellX: [], cellY: [], cellType: [], cellState: [], cellId: [], bonds: [],
  };
}

// Map an inspector-canvas pixel back to world coordinates using the
// transform captured during the last render. Returns null if no atoms
// have been rendered yet (transform unknown).
function inspectorPixelToWorld(px: number, py: number): { x: number; y: number } | null {
  if (!inspectorTx) return null;
  const { cx, cy, scale, W, H } = inspectorTx;
  return { x: (px - W / 2) / scale + cx, y: (py - H / 2) / scale + cy };
}
// Find the atom under an inspector pixel (within a hit radius). Returns
// the index into lastSelection arrays, or -1 if nothing is close enough.
function hitAtomInInspector(px: number, py: number): number {
  if (!inspectorTx || !lastSelection) return -1;
  const { cx, cy, scale, W, H, r } = inspectorTx;
  const hitR = Math.max(8, r + 4);
  const hitR2 = hitR * hitR;
  let best = -1, bestD2 = Infinity;
  for (let i = 0; i < lastSelection.atomCount; i++) {
    const ax = (lastSelection.cellX[i] - cx) * scale + W / 2;
    const ay = (lastSelection.cellY[i] - cy) * scale + H / 2;
    const dx = px - ax, dy = py - ay;
    const d2 = dx * dx + dy * dy;
    if (d2 < hitR2 && d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return best;
}
// After every edit, re-request the selection so the inspector view
// (and stats) reflect the new state. The worker pushes back via
// onSelectionExport, which calls renderInspector.
function refreshSelectionFromWorker(): void {
  send({ type: 'exportSelection' });
}

if (inspectorCanvas) {
  inspectorCanvas.addEventListener('click', (e) => {
    if (!editMode) return;
    const rect = inspectorCanvas.getBoundingClientRect();
    // Account for CSS scaling — canvas internal is 320, displayed size may differ on small screens.
    const px = (e.clientX - rect.left) * (inspectorCanvas.width / rect.width);
    const py = (e.clientY - rect.top)  * (inspectorCanvas.height / rect.height);

    if (editTool === 'add') {
      const w = inspectorPixelToWorld(px, py);
      if (!w) {
        setEditorStatus('Cannot resolve world coordinates yet — try after a selection exists.');
        return;
      }
      const state = Math.max(0, Math.min(50, parseInt(atomStateInput?.value ?? '0', 10) || 0));
      send({ type: 'editAddAtom', x: w.x, y: w.y, atomType: editAtomType, state });
      refreshSelectionFromWorker();
      setEditorStatus(`Added "${editAtomType}" (state ${state}).`);
      return;
    }
    if (editTool === 'delete') {
      const idx = hitAtomInInspector(px, py);
      if (idx < 0 || !lastSelection || !lastSelection.cellId) {
        setEditorStatus('No atom under cursor.'); return;
      }
      const id = lastSelection.cellId[idx];
      send({ type: 'editDeleteAtom', atomId: id });
      refreshSelectionFromWorker();
      setEditorStatus(`Deleted atom #${id}.`);
      return;
    }
    if (editTool === 'bond') {
      const idx = hitAtomInInspector(px, py);
      if (idx < 0 || !lastSelection || !lastSelection.cellId) {
        setEditorStatus('No atom under cursor.'); return;
      }
      const id = lastSelection.cellId[idx];
      if (bondPendingId === null) {
        bondPendingId = id;
        setEditorStatus(`Picked atom #${id} — click a second atom to toggle the bond (Esc cancels).`);
        return;
      }
      if (bondPendingId === id) {
        bondPendingId = null;
        setEditorStatus('Bond gesture cancelled.');
        return;
      }
      send({ type: 'editToggleBond', atomIdA: bondPendingId, atomIdB: id });
      const a = bondPendingId; bondPendingId = null;
      refreshSelectionFromWorker();
      setEditorStatus(`Toggled bond #${a} ↔ #${id}.`);
      return;
    }
  });
}

if (editToggleBtn) editToggleBtn.addEventListener('click', () => setEditMode(!editMode));
toolBtns.forEach(b => b.addEventListener('click', () => setEditTool(b.dataset.tool as EditTool)));
paletteBtns.forEach(b => b.addEventListener('click', () => setPaletteAtom(b.dataset.atom ?? 'a')));
if (atomStateInput) atomStateInput.addEventListener('input', refreshEditorStatus);

// ── Inspector: bulk type replacement ──────────────────────────────────────
// Sweep the entire sim, swap every atom of the From type into the To type.
// State, bonds, position, ID all preserved — only the type label changes.
// Built into the Inspector modal because it's a study-tool operation
// (e.g., "what happens if every lysin atom were a 'b' instead?").
const ATOM_LABELS: Record<string, string> = {
  a: 'a — membrane / peptidoglycan',
  b: 'b — common gene base',
  c: 'c — rare gene base',
  d: 'd — polymerase enzyme',
  e: 'e — gene start (oriC)',
  f: 'f — gene end (ter)',
  w: 'w — water',
  p: 'p — lysin',
};
const replaceFromSel = document.getElementById('replace-from') as HTMLSelectElement | null;
const replaceToSel   = document.getElementById('replace-to')   as HTMLSelectElement | null;
const replaceApplyBtn = document.getElementById('replace-apply') as HTMLButtonElement | null;
const replaceStatusEl = document.getElementById('replace-status') as HTMLSpanElement | null;
function populateReplaceSelects(): void {
  if (!replaceFromSel || !replaceToSel) return;
  for (const sel of [replaceFromSel, replaceToSel]) {
    sel.innerHTML = '';
    for (const [t, label] of Object.entries(ATOM_LABELS)) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = label;
      sel.appendChild(opt);
    }
  }
  replaceFromSel.value = 'p';
  replaceToSel.value = 'b';
}
populateReplaceSelects();
if (replaceApplyBtn) {
  replaceApplyBtn.addEventListener('click', () => {
    if (!replaceFromSel || !replaceToSel) return;
    const from = replaceFromSel.value;
    const to = replaceToSel.value;
    if (from === to) {
      if (replaceStatusEl) replaceStatusEl.textContent = 'From and To are the same — no change.';
      return;
    }
    const ok = window.confirm(
      `Replace EVERY "${from}" atom in the entire sim with "${to}"?\n\n` +
      `This sweeps the whole arena, not just your selection. State, bonds, and IDs are preserved.`,
    );
    if (!ok) return;
    send({ type: 'replaceAtomType', fromType: from, toType: to });
    if (replaceStatusEl) replaceStatusEl.textContent = `Replaced all "${from}" → "${to}".`;
    logStatus(`Bulk replace: every "${from}" → "${to}" (sim-wide)`);
    // Refresh the inspector view in case the selection contains affected atoms.
    if (isInspectorOpen()) refreshSelectionFromWorker();
  });
}

// ── Lab: custom atoms + custom rules ──────────────────────────────────────
// User-defined chemistry layer. Atoms are visual + symbolic; rules drive
// behavior. Built-ins are never modified — custom rules append on top of
// the seeded chemistry, so a bad rule list can't ever break the demo sim.
// Persisted to localStorage so a closed tab returns to the same chemistry.
const CUSTOM_ATOMS_KEY = 'primordium-custom-atoms-v1';
const CUSTOM_RULES_KEY = 'primordium-custom-rules-v1';
const RESERVED_LABELS  = new Set(['a','b','c','d','e','f','w','p','x','y','z']);

let customAtoms: CustomAtomDef[] = [];
let customRules: CustomRuleSpec[] = [];

function loadCustomFromStorage(): void {
  try {
    const a = localStorage.getItem(CUSTOM_ATOMS_KEY);
    const r = localStorage.getItem(CUSTOM_RULES_KEY);
    if (a) customAtoms = JSON.parse(a);
    if (r) customRules = JSON.parse(r);
  } catch { /* corrupt — start fresh */ customAtoms = []; customRules = []; }
}
function saveCustomToStorage(): void {
  try {
    localStorage.setItem(CUSTOM_ATOMS_KEY, JSON.stringify(customAtoms));
    localStorage.setItem(CUSTOM_RULES_KEY, JSON.stringify(customRules));
  } catch { /* private mode etc — soft-fail */ }
}
loadCustomFromStorage();

function pushCustomChemistry(): void {
  send({ type: 'setCustomAtoms', atoms: customAtoms });
  send({ type: 'setCustomRules', rules: customRules });
  // Apply colors to every renderer path so custom atoms look the same in
  // educational, classic, and microscope views.
  for (const a of customAtoms) {
    const rgb = hexToRgb01(a.color);
    setGPUCustomColor(a.type, rgb);
    setClassicAtomColor(a.type, a.color);
    setEducationalAtomColor(a.type, a.color);
  }
  saveCustomToStorage();
  refreshCustomSummary();
  refreshCustomLists();
  refreshRuleTypeSelectors();
  rebuildInspectorPalette();
  rebuildReplaceTypeSelects();
}

// Rebuild the Inspector edit-mode palette so user-defined atoms show up
// alongside the 8 built-ins. Each palette button gets the atom's color
// and label, and clicking it sets editAtomType. The state input snaps
// to the atom's defaultState (built-ins use the static DEFAULT_STATE
// table; customs use whatever the user picked in the Lab).
function rebuildInspectorPalette(): void {
  const palette = document.querySelector<HTMLDivElement>('.editor-palette');
  if (!palette) return;
  // Wipe and rebuild — simpler than diffing for a small palette size.
  palette.innerHTML = '';
  const builtins: Array<{ t: string; color: string }> = [
    { t: 'a', color: '#8a6d3b' }, { t: 'b', color: '#7fb069' },
    { t: 'c', color: '#dca54c' }, { t: 'd', color: '#d96d6d' },
    { t: 'e', color: '#c97df7' }, { t: 'f', color: '#5db8d8' },
    { t: 'w', color: '#66ccff' }, { t: 'p', color: '#ff8844' },
  ];
  const all: Array<{ t: string; color: string; defaultState: number }> = [
    ...builtins.map(b => ({ ...b, defaultState: DEFAULT_STATE[b.t] ?? 0 })),
    ...customAtoms.map(a => ({ t: a.type, color: a.color, defaultState: a.defaultState })),
  ];
  for (const a of all) {
    const btn = document.createElement('button');
    btn.className = 'palette-btn';
    btn.dataset.atom = a.t;
    btn.textContent = a.t;
    btn.style.setProperty('--atom-color', a.color);
    if (a.t === editAtomType) btn.classList.add('active');
    btn.addEventListener('click', () => {
      editAtomType = a.t;
      DEFAULT_STATE[a.t] = a.defaultState;
      // Update the .active class across the live palette.
      palette.querySelectorAll('.palette-btn').forEach(b => b.classList.toggle('active', (b as HTMLElement).dataset.atom === a.t));
      if (atomStateInput) atomStateInput.value = String(a.defaultState);
      refreshEditorStatus();
    });
    palette.appendChild(btn);
  }
}

// The bulk replace-type selects also need the latest custom atoms so the
// user can swap any atom into any other (built-in ↔ custom).
function rebuildReplaceTypeSelects(): void {
  if (!replaceFromSel || !replaceToSel) return;
  // Add custom-atom options if not already present.
  for (const sel of [replaceFromSel, replaceToSel]) {
    const prev = sel.value;
    sel.innerHTML = '';
    for (const [t, label] of Object.entries(ATOM_LABELS)) {
      const opt = document.createElement('option');
      opt.value = t; opt.textContent = label;
      sel.appendChild(opt);
    }
    for (const a of customAtoms) {
      const opt = document.createElement('option');
      opt.value = a.type; opt.textContent = `${a.type} — ${a.name}`;
      sel.appendChild(opt);
    }
    if (prev) sel.value = prev;
  }
}
function hexToRgb01(hex: string): [number, number, number] {
  const m = hex.replace('#', '');
  const n = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}
function refreshCustomSummary(): void {
  const el = document.getElementById('custom-summary');
  if (el) el.textContent = `${customAtoms.length} custom atom${customAtoms.length === 1 ? '' : 's'} · ${customRules.length} custom rule${customRules.length === 1 ? '' : 's'}`;
}

// ── Custom atom CRUD UI ───────────────────────────────────────────────────
const caSymbolEl = document.getElementById('ca-symbol') as HTMLInputElement | null;
const caNameEl   = document.getElementById('ca-name')   as HTMLInputElement | null;
const caColorEl  = document.getElementById('ca-color')  as HTMLInputElement | null;
const caStateEl  = document.getElementById('ca-state')  as HTMLInputElement | null;
const caAddBtn   = document.getElementById('ca-add')    as HTMLButtonElement | null;
const caRandomBtn = document.getElementById('ca-random') as HTMLButtonElement | null;
const customAtomListEl = document.getElementById('custom-atom-list') as HTMLDivElement | null;

function refreshCustomAtomList(): void {
  if (!customAtomListEl) return;
  customAtomListEl.innerHTML = '';
  if (customAtoms.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lab-section-hint';
    empty.textContent = 'No custom atoms yet.';
    customAtomListEl.appendChild(empty);
    return;
  }
  for (const a of customAtoms) {
    const row = document.createElement('div');
    row.className = 'lab-list-item';
    const swatch = document.createElement('div');
    swatch.className = 'lab-list-swatch';
    swatch.style.background = a.color;
    const text = document.createElement('div');
    text.className = 'lab-list-text';
    text.textContent = `${a.type} — ${a.name} · default state ${a.defaultState}`;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Delete this custom atom';
    del.addEventListener('click', () => {
      customAtoms = customAtoms.filter(x => x.type !== a.type);
      // Drop any rules that referenced the deleted atom — silently, so
      // nothing in the worker ends up referencing a phantom type.
      customRules = customRules.filter(r =>
        r.aType !== a.type && r.bType !== a.type && r.cType !== a.type,
      );
      pushCustomChemistry();
    });
    row.append(swatch, text, del);
    customAtomListEl.appendChild(row);
  }
}

function nextAvailableSymbol(): string {
  const used = new Set([...RESERVED_LABELS, ...customAtoms.map(a => a.type)]);
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
    if (!used.has(ch)) return ch;
  }
  return '';
}
function randomAtomName(): string {
  const prefixes = ['Glob', 'Pyr', 'Quor', 'Mure', 'Nex', 'Hel', 'Zeph', 'Lum', 'Vor', 'Astr', 'Cryo', 'Phlog'];
  const suffixes = ['ium', 'ase', 'one', 'ide', 'ane', 'in', 'on', 'ate', 'yl', 'ene'];
  return prefixes[Math.floor(Math.random() * prefixes.length)] + suffixes[Math.floor(Math.random() * suffixes.length)];
}
function randomNiceColor(): string {
  // Avoid super-dark colors that vanish against the dark canvas. Generate
  // HSL with high saturation and mid lightness, then convert to hex.
  const h = Math.floor(Math.random() * 360);
  const s = 0.6 + Math.random() * 0.3;
  const l = 0.55 + Math.random() * 0.15;
  return hslToHex(h, s, l);
}
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if      (h < 60)  { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else              { r = c; b = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

if (caRandomBtn) caRandomBtn.addEventListener('click', () => {
  if (!caSymbolEl || !caNameEl || !caColorEl || !caStateEl) return;
  caSymbolEl.value = nextAvailableSymbol();
  caNameEl.value   = randomAtomName();
  caColorEl.value  = randomNiceColor();
  caStateEl.value  = String(Math.floor(Math.random() * 6));
});
if (caAddBtn) caAddBtn.addEventListener('click', () => {
  if (!caSymbolEl || !caNameEl || !caColorEl || !caStateEl) return;
  const sym = caSymbolEl.value.toUpperCase().trim();
  if (!sym || sym.length !== 1 || !/[A-Z0-9]/.test(sym)) {
    logStatus('Custom atom symbol must be a single uppercase letter or digit.');
    return;
  }
  if (RESERVED_LABELS.has(sym.toLowerCase())) {
    logStatus(`"${sym}" is reserved by the built-in chemistry. Pick another.`);
    return;
  }
  if (customAtoms.some(a => a.type === sym)) {
    logStatus(`Atom "${sym}" already exists. Delete it first to redefine.`);
    return;
  }
  customAtoms.push({
    type: sym,
    name: caNameEl.value.trim() || sym,
    color: caColorEl.value || '#cccccc',
    defaultState: Math.max(0, Math.min(50, parseInt(caStateEl.value, 10) || 0)),
  });
  caSymbolEl.value = '';
  caNameEl.value = '';
  pushCustomChemistry();
  logStatus(`Added custom atom "${sym}".`);
});

// ── Custom rule CRUD UI ───────────────────────────────────────────────────
const crNameEl    = document.getElementById('cr-name')    as HTMLInputElement | null;
const crInputsEl  = document.getElementById('cr-inputs')  as HTMLSelectElement | null;
const crCasesEl   = document.getElementById('cr-cases')   as HTMLInputElement | null;
const crATypeEl   = document.getElementById('cr-a-type')  as HTMLSelectElement | null;
const crAStateEl  = document.getElementById('cr-a-state') as HTMLInputElement | null;
const crABBondEl  = document.getElementById('cr-ab-bond') as HTMLInputElement | null;
const crAFutureEl = document.getElementById('cr-a-future') as HTMLInputElement | null;
const crABFutureEl= document.getElementById('cr-ab-future')as HTMLInputElement | null;
const crBTypeEl   = document.getElementById('cr-b-type')  as HTMLSelectElement | null;
const crBStateEl  = document.getElementById('cr-b-state') as HTMLInputElement | null;
const crBFutureEl = document.getElementById('cr-b-future') as HTMLInputElement | null;
const crCRow      = document.getElementById('cr-c-row')   as HTMLDivElement | null;
const crCTypeEl   = document.getElementById('cr-c-type')  as HTMLSelectElement | null;
const crCStateEl  = document.getElementById('cr-c-state') as HTMLInputElement | null;
const crBCBondEl  = document.getElementById('cr-bc-bond') as HTMLInputElement | null;
const crACBondEl  = document.getElementById('cr-ac-bond') as HTMLInputElement | null;
const crCFutureEl = document.getElementById('cr-c-future') as HTMLInputElement | null;
const crBCFutureEl= document.getElementById('cr-bc-future')as HTMLInputElement | null;
const crACFutureEl= document.getElementById('cr-ac-future')as HTMLInputElement | null;
const crAddBtn    = document.getElementById('cr-add')     as HTMLButtonElement | null;
const crRandomBtn = document.getElementById('cr-random')  as HTMLButtonElement | null;
const crClearBtn  = document.getElementById('cr-clear-all') as HTMLButtonElement | null;
const customRuleListEl = document.getElementById('custom-rule-list') as HTMLDivElement | null;

function refreshRuleTypeSelectors(): void {
  // Populate the three reactant <select>s with built-ins + customs + wildcards.
  const opts: { value: string; label: string }[] = [
    { value: 'a', label: 'a (membrane)' },
    { value: 'b', label: 'b (gene base)' },
    { value: 'c', label: 'c (gene base)' },
    { value: 'd', label: 'd (enzyme)' },
    { value: 'e', label: 'e (gene start)' },
    { value: 'f', label: 'f (gene end)' },
    { value: 'w', label: 'w (water)' },
    { value: 'p', label: 'p (lysin)' },
    { value: 'x', label: 'x (wildcard)' },
    { value: 'y', label: 'y (wildcard)' },
    { value: 'z', label: 'z (wildcard)' },
  ];
  for (const a of customAtoms) opts.push({ value: a.type, label: `${a.type} (${a.name})` });
  for (const sel of [crATypeEl, crBTypeEl, crCTypeEl]) {
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = '';
    for (const o of opts) {
      const el = document.createElement('option');
      el.value = o.value; el.textContent = o.label;
      sel.appendChild(el);
    }
    if (prev && opts.some(o => o.value === prev)) sel.value = prev;
  }
}
function refreshCRowVisibility(): void {
  if (!crCRow || !crInputsEl) return;
  crCRow.style.display = crInputsEl.value === '3' ? '' : 'none';
}
if (crInputsEl) crInputsEl.addEventListener('change', refreshCRowVisibility);
refreshCRowVisibility();

function refreshCustomRuleList(): void {
  if (!customRuleListEl) return;
  customRuleListEl.innerHTML = '';
  if (customRules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lab-section-hint';
    empty.textContent = 'No custom rules yet.';
    customRuleListEl.appendChild(empty);
    return;
  }
  for (const rule of customRules) {
    const row = document.createElement('div');
    row.className = 'lab-list-item';
    const text = document.createElement('div');
    text.className = 'lab-list-text';
    const reactants = rule.nInputs === 3
      ? `${rule.aType}(${rule.aState})${rule.currentAbBond ? '⎯' : '·'}${rule.bType}(${rule.bState}) + ${rule.cType}(${rule.cState ?? 0})`
      : `${rule.aType}(${rule.aState})${rule.currentAbBond ? '⎯' : '·'}${rule.bType}(${rule.bState})`;
    const products = rule.nInputs === 3
      ? `${rule.aType}(${rule.futureAState})${rule.futureAbBond ? '⎯' : '·'}${rule.bType}(${rule.futureBState}) + ${rule.cType}(${rule.futureCState ?? 0})`
      : `${rule.aType}(${rule.futureAState})${rule.futureAbBond ? '⎯' : '·'}${rule.bType}(${rule.futureBState})`;
    text.textContent = `${rule.name || '(unnamed)'} · ${reactants} → ${products} · cases=${rule.cases}`;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Delete rule';
    del.addEventListener('click', () => {
      customRules = customRules.filter(r => r.id !== rule.id);
      pushCustomChemistry();
    });
    row.append(text, del);
    customRuleListEl.appendChild(row);
  }
}

function refreshCustomLists(): void {
  refreshCustomAtomList();
  refreshCustomRuleList();
}

function readRuleFormSpec(): CustomRuleSpec | null {
  if (!crInputsEl || !crATypeEl || !crBTypeEl) return null;
  const nInputs = (crInputsEl.value === '3' ? 3 : 2) as 2 | 3;
  const cases = Math.max(1, parseInt(crCasesEl?.value ?? '1', 10) || 1);
  const spec: CustomRuleSpec = {
    id: 'r' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
    name: crNameEl?.value.trim() || 'rule',
    nInputs,
    aType: crATypeEl.value,
    aState: parseInt(crAStateEl?.value ?? '0', 10) || 0,
    currentAbBond: !!crABBondEl?.checked,
    bType: crBTypeEl.value,
    bState: parseInt(crBStateEl?.value ?? '0', 10) || 0,
    futureAState: parseInt(crAFutureEl?.value ?? '0', 10) || 0,
    futureAbBond: !!crABFutureEl?.checked,
    futureBState: parseInt(crBFutureEl?.value ?? '0', 10) || 0,
    cases,
  };
  if (nInputs === 3) {
    spec.cType = crCTypeEl?.value ?? 'a';
    spec.cState = parseInt(crCStateEl?.value ?? '0', 10) || 0;
    spec.currentBcBond = !!crBCBondEl?.checked;
    spec.currentAcBond = !!crACBondEl?.checked;
    spec.futureCState  = parseInt(crCFutureEl?.value ?? '0', 10) || 0;
    spec.futureBcBond  = !!crBCFutureEl?.checked;
    spec.futureAcBond  = !!crACFutureEl?.checked;
  }
  return spec;
}
if (crAddBtn) crAddBtn.addEventListener('click', () => {
  const spec = readRuleFormSpec();
  if (!spec) return;
  customRules.push(spec);
  pushCustomChemistry();
  logStatus(`Added custom rule "${spec.name}" (${customRules.length} total).`);
});
if (crRandomBtn) crRandomBtn.addEventListener('click', () => {
  // Random fill — every field gets a sensible random value, then the user
  // can review and Add.
  if (!crNameEl || !crInputsEl || !crCasesEl) return;
  crNameEl.value = randomAtomName().toLowerCase() + 'ation';
  const allTypes = ['a','b','c','d','e','f','w','p', ...customAtoms.map(a => a.type)];
  const randType = () => allTypes[Math.floor(Math.random() * allTypes.length)];
  const randState = () => Math.floor(Math.random() * 51);
  const randBool = () => Math.random() < 0.5;
  const nInputs = Math.random() < 0.4 ? '3' : '2';
  crInputsEl.value = nInputs;
  refreshCRowVisibility();
  crCasesEl.value = String(1 + Math.floor(Math.random() * 100));
  if (crATypeEl) crATypeEl.value = randType();
  if (crBTypeEl) crBTypeEl.value = randType();
  if (crCTypeEl) crCTypeEl.value = randType();
  if (crAStateEl)  crAStateEl.value  = String(randState());
  if (crBStateEl)  crBStateEl.value  = String(randState());
  if (crCStateEl)  crCStateEl.value  = String(randState());
  if (crABBondEl)  crABBondEl.checked  = randBool();
  if (crBCBondEl)  crBCBondEl.checked  = randBool();
  if (crACBondEl)  crACBondEl.checked  = randBool();
  if (crAFutureEl) crAFutureEl.value = String(randState());
  if (crBFutureEl) crBFutureEl.value = String(randState());
  if (crCFutureEl) crCFutureEl.value = String(randState());
  if (crABFutureEl) crABFutureEl.checked = randBool();
  if (crBCFutureEl) crBCFutureEl.checked = randBool();
  if (crACFutureEl) crACFutureEl.checked = randBool();
});
if (crClearBtn) crClearBtn.addEventListener('click', () => {
  if (customRules.length === 0) return;
  if (!window.confirm(`Delete all ${customRules.length} custom rules?`)) return;
  customRules = [];
  pushCustomChemistry();
  logStatus('Cleared all custom rules.');
});

// ── Lab modal open/close ──────────────────────────────────────────────────
const labModal   = document.getElementById('lab-modal') as HTMLDivElement | null;
const labOpenBtn = document.getElementById('lab-open-btn') as HTMLButtonElement | null;
const labCloseBtn = document.getElementById('lab-close')   as HTMLButtonElement | null;
const dictBtn    = document.getElementById('dict-btn')    as HTMLButtonElement | null;
function openLab(tab: 'editor' | 'dictionary' = 'editor'): void {
  if (!labModal) return;
  refreshCustomLists();
  refreshRuleTypeSelectors();
  refreshCRowVisibility();
  labModal.classList.add('shown');
  labModal.setAttribute('aria-hidden', 'false');
  showLabTab(tab);
}
function closeLab(): void {
  if (!labModal) return;
  labModal.classList.remove('shown');
  labModal.setAttribute('aria-hidden', 'true');
}
function isLabOpen(): boolean {
  return !!labModal && labModal.classList.contains('shown');
}
function isDictionaryOpen(): boolean {
  return isLabOpen() && !!labTabDictionary && !labTabDictionary.hidden;
}
if (labOpenBtn) labOpenBtn.addEventListener('click', () => openLab('editor'));
if (dictBtn) dictBtn.addEventListener('click', () => openLab('dictionary'));
if (labCloseBtn) labCloseBtn.addEventListener('click', closeLab);

// ── Credits modal ────────────────────────────────────────────────────
const creditsModal   = document.getElementById('credits-modal')    as HTMLElement | null;
const creditsOpenBtn = document.getElementById('credits-open')     as HTMLButtonElement | null;
const creditsClose   = document.getElementById('credits-close')    as HTMLButtonElement | null;
const creditsVersion = document.getElementById('credits-version')  as HTMLElement | null;
function openCredits(): void {
  if (!creditsModal) return;
  creditsModal.classList.add('shown');
  creditsModal.setAttribute('aria-hidden', 'false');
}
function closeCredits(): void {
  if (!creditsModal) return;
  creditsModal.classList.remove('shown');
  creditsModal.setAttribute('aria-hidden', 'true');
}
function isCreditsOpen(): boolean {
  return !!creditsModal && creditsModal.classList.contains('shown');
}
if (creditsOpenBtn) creditsOpenBtn.addEventListener('click', openCredits);
if (creditsClose) creditsClose.addEventListener('click', closeCredits);
if (creditsVersion) creditsVersion.textContent = `Evoloom ${APP_VERSION}`;

// ── Lab tabs (Editor / Dictionary) ────────────────────────────────────────
const labTabs = document.querySelectorAll<HTMLButtonElement>('.lab-tab');
const labTabEditor = document.getElementById('lab-tab-editor');
const labTabDictionary = document.getElementById('lab-tab-dictionary');
function showLabTab(name: string): void {
  labTabs.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (labTabEditor)     labTabEditor.hidden     = name !== 'editor';
  if (labTabDictionary) labTabDictionary.hidden = name !== 'dictionary';
  if (name === 'dictionary') rebuildDictionary();
}
labTabs.forEach(b => b.addEventListener('click', () => showLabTab(b.dataset.tab ?? 'editor')));

// ── Dictionary: rule-to-English compiler ──────────────────────────────────
// Templated translation, no LLM. Reads a CustomRuleSpec and emits a plain
// sentence describing what the rule does. Built-in atoms get hand-written
// dictionary entries; custom atoms get auto-generated descriptions built
// from the rules that reference them.

const BUILTIN_DICTIONARY: Record<string, { name: string; color: string; description: string }> = {
  a: {
    name: 'Membrane unit (a)',
    color: '#c8a800',
    description:
      'The structural building block of cell walls. When many "a" atoms bond into a closed loop, that loop IS the cell membrane — it physically holds the cell together. Lysin (p) breaks a-a bonds, splitting the wall open. Water (w) hydrolyzes them too, slowly digesting dead cells. In a special state (38), an "a" atom doubles as a gene base inside DNA strands. Closest real-world analogue: peptidoglycan, the rigid polymer in bacterial cell walls.',
  },
  b: {
    name: 'Common gene base (b)',
    color: '#888888',
    description:
      'The most frequent base in the genome strand. Appears three times in the seeded gene template (e-b-b-a-c-b-d-f). The polymerase enzyme (d) walks past it without doing anything special — it\'s the cheap filler base. Closest real-world analogue: adenine or thymine in DNA.',
  },
  c: {
    name: 'Rare gene base (c)',
    color: '#00dddd',
    description:
      'A less common gene base. Appears once in the default gene template, alongside the "b" filler. Functionally identical to "b" from the chemistry\'s perspective — the polymerase reads it the same way — but rarer. Closest real-world analogue: cytosine or guanine.',
  },
  d: {
    name: 'Polymerase enzyme (d)',
    color: '#3366ff',
    description:
      'A walking molecular machine. Free "d" atoms float in the soup. When one bumps into a gene start, it enters "walking" state (state 41) and steps along the template, copying state forward base-by-base. Releases when it hits the gene end (f). Note: "d" is BOTH the enzyme AND a residue inside the gene that encodes itself — exactly like real DNA polymerase, which is encoded in the chromosome it replicates.',
  },
  e: {
    name: 'Gene start, anchored to membrane (e)',
    color: '#ff3333',
    description:
      'Marks one end of the gene strand and is bonded to a special "T-tagged" membrane atom. This bond physically tethers the chromosome to the cell wall — the same way bacterial chromosomes are anchored to the membrane at the origin of replication (oriC). When replication starts, it starts here.',
  },
  f: {
    name: 'Gene end, division trigger (f)',
    color: '#33ff33',
    description:
      'Marks the other end of the gene strand and anchors to the opposite side of the membrane. When the polymerase reaches an "f", it releases the strand AND triggers the cascade of reactions that splits one cell into two daughter cells. Closest real-world analogue: the ter site + FtsZ divisome in bacteria.',
  },
  w: {
    name: 'Water (w)',
    color: '#a8d8ff',
    description:
      'Free H2O. Confined to droplets by an invisible surface tension. When fresh (state 0), water can break ONE non-protected bond per tick, then transitions to spent (state 1) and can never hydrolyze again. Mass-conserving: no atom is ever deleted, water just gets chemically incorporated into the broken bond as the cleaved -OH and H groups. Cells protected by their live-cell membrane signature are immune.',
  },
  p: {
    name: 'Lysin (p)',
    color: '#ff7700',
    description:
      'A catalyst enzyme that cleaves membrane (a-a) bonds when free. Stays state 0 always — never consumed, just speeds up the reaction. Crucial detail: lysin is ONLY active when unbonded. Force-bonding lysin to a membrane atom (or to other lysins) makes it a catalytically inert ornament. Closest real-world analogue: lysozyme in tears + saliva, or phage endolysin used in modern enzybiotic research.',
  },
};

function atomShortName(t: string): string {
  if ('xyz'.includes(t)) return `any-atom-${t}`;
  if (BUILTIN_DICTIONARY[t]) {
    const m = BUILTIN_DICTIONARY[t].name.match(/^(.*?)\s*\(/);
    return (m ? m[1] : BUILTIN_DICTIONARY[t].name).toLowerCase();
  }
  const c = customAtoms.find(a => a.type === t);
  return c ? c.name : t;
}
function probabilityWord(cases: number): string {
  if (cases <= 1) return 'every single time';
  const pct = 100 / cases;
  if (pct >= 50) return `very often (~${pct.toFixed(0)}% per encounter)`;
  if (pct >= 10) return `often (~${pct.toFixed(0)}% per encounter)`;
  if (pct >= 1)  return `occasionally (~${pct.toFixed(0)}% per encounter)`;
  if (pct >= 0.1) return `rarely (~${pct.toFixed(2)}% per encounter)`;
  return `extremely rarely (~${pct.toFixed(3)}% per encounter)`;
}
function describeStateChange(t: string, before: number, after: number): string | null {
  if (before === after) return null;
  return `the ${atomShortName(t)} flips from state <strong>${before}</strong> to state <strong>${after}</strong>`;
}
function translateRule(rule: CustomRuleSpec): string {
  const aShort = atomShortName(rule.aType);
  const bShort = atomShortName(rule.bType);
  const probability = probabilityWord(rule.cases);

  const triggerParts: string[] = [];
  triggerParts.push(`a <strong>${aShort}</strong> in state <strong>${rule.aState}</strong>`);
  triggerParts.push(rule.currentAbBond ? `is BONDED to` : `is right next to`);
  triggerParts.push(`a <strong>${bShort}</strong> in state <strong>${rule.bState}</strong>`);
  let trigger = triggerParts.join(' ');

  if (rule.nInputs === 3 && rule.cType) {
    const cShort = atomShortName(rule.cType);
    const bondNotes: string[] = [];
    if (rule.currentAcBond) bondNotes.push('is bonded to the first');
    if (rule.currentBcBond) bondNotes.push('is bonded to the second');
    if (bondNotes.length === 0) bondNotes.push('is unbonded to either');
    trigger += `, AND a <strong>${cShort}</strong> in state <strong>${rule.cState ?? 0}</strong> nearby (${bondNotes.join(' and ')})`;
  }

  const changes: string[] = [];
  const aChange = describeStateChange(rule.aType, rule.aState, rule.futureAState);
  if (aChange) changes.push(aChange);
  const bChange = describeStateChange(rule.bType, rule.bState, rule.futureBState);
  if (bChange) changes.push(bChange);
  if (rule.currentAbBond !== rule.futureAbBond) {
    changes.push(rule.futureAbBond ? `they FORM a new bond` : `their bond BREAKS`);
  }
  if (rule.nInputs === 3 && rule.cType) {
    const cChange = describeStateChange(rule.cType, rule.cState ?? 0, rule.futureCState ?? 0);
    if (cChange) changes.push(cChange);
    if ((rule.currentBcBond ?? false) !== (rule.futureBcBond ?? false)) {
      changes.push(rule.futureBcBond
        ? `the second and third FORM a bond`
        : `the second–third bond BREAKS`);
    }
    if ((rule.currentAcBond ?? false) !== (rule.futureAcBond ?? false)) {
      changes.push(rule.futureAcBond
        ? `the first and third FORM a bond`
        : `the first–third bond BREAKS`);
    }
  }

  if (changes.length === 0) {
    return `Whenever ${trigger}, ${probability}, <em>nothing actually changes</em>. (This rule is a no-op — review it.)`;
  }
  return `Whenever ${trigger}, ${probability}, ${changes.join(', and ')}.`;
}

function reactivitySummary(t: string): string {
  // Aggregate how many custom rules reference this atom and roughly what
  // they do. Lets the dictionary entry say "X reacts with Y in 3 ways"
  // without listing every rule individually.
  const partners = new Set<string>();
  let count = 0;
  for (const r of customRules) {
    const types = [r.aType, r.bType, r.cType].filter(x => x !== undefined) as string[];
    if (types.includes(t)) {
      count++;
      for (const p of types) if (p !== t) partners.add(p);
    }
  }
  if (count === 0) return `Currently inert — no custom rule references this atom yet.`;
  const partnerList = Array.from(partners).map(p => atomShortName(p)).join(', ');
  return `Participates in ${count} custom rule${count === 1 ? '' : 's'} alongside: <strong>${partnerList || 'itself'}</strong>.`;
}

function rebuildDictionary(): void {
  const list = document.getElementById('dictionary-list');
  if (!list) return;
  list.innerHTML = '';

  // Built-in atoms first, in chemistry-defined order.
  const order = ['a', 'b', 'c', 'd', 'e', 'f', 'w', 'p'];
  for (const t of order) {
    const entry = BUILTIN_DICTIONARY[t];
    if (!entry) continue;
    list.appendChild(buildDictEntry(t, entry.name, entry.color, 'builtin', entry.description));
  }

  // Custom atoms — auto-generated descriptions from their rules.
  for (const a of customAtoms) {
    const ruleLines = customRules
      .filter(r => r.aType === a.type || r.bType === a.type || r.cType === a.type)
      .map(translateRule);
    const summary = reactivitySummary(a.type);
    const description = `${a.name} — a user-defined atom. Symbol: <strong>${a.type}</strong>. Default state: <strong>${a.defaultState}</strong>. ${summary}`;
    list.appendChild(buildDictEntry(a.type, a.name, a.color, 'custom', description, ruleLines));
  }

  if (customAtoms.length === 0) {
    const tip = document.createElement('div');
    tip.className = 'lab-section-hint';
    tip.style.marginTop = '14px';
    tip.textContent = 'Add custom atoms in the Editor tab — they\'ll appear here with auto-generated rule explanations.';
    list.appendChild(tip);
  }
}

function buildDictEntry(symbol: string, name: string, color: string, kind: 'builtin' | 'custom', description: string, customRuleDescriptions: string[] = []): HTMLDivElement {
  const entry = document.createElement('div');
  entry.className = 'dict-entry';

  const icon = document.createElement('div');
  icon.className = 'dict-icon';
  icon.style.background = color;
  icon.textContent = symbol;

  const meta = document.createElement('div');
  meta.className = 'dict-meta';

  const nameRow = document.createElement('div');
  nameRow.className = 'dict-name';
  nameRow.textContent = name;
  const tag = document.createElement('span');
  tag.className = `dict-tag ${kind}`;
  tag.textContent = kind === 'builtin' ? 'Built-in' : 'Custom';
  nameRow.appendChild(tag);

  const desc = document.createElement('div');
  desc.className = 'dict-desc';
  desc.innerHTML = description;

  meta.append(nameRow, desc);

  // For custom atoms only, inline the translated rule list. Built-in
  // descriptions are already complete prose so they don't need this block.
  if (kind === 'custom') {
    const rulesBlock = document.createElement('div');
    rulesBlock.className = 'dict-rules';
    const rulesTitle = document.createElement('div');
    rulesTitle.className = 'dict-rules-title';
    rulesTitle.textContent = `Rules involving ${symbol}`;
    rulesBlock.appendChild(rulesTitle);
    if (customRuleDescriptions.length === 0) {
      const none = document.createElement('div');
      none.className = 'dict-rule';
      none.innerHTML = '<span class="none">No rules reference this atom yet — it will sit inert in the sim until you write one.</span>';
      rulesBlock.appendChild(none);
    } else {
      for (const line of customRuleDescriptions) {
        const r = document.createElement('div');
        r.className = 'dict-rule';
        r.innerHTML = line;
        rulesBlock.appendChild(r);
      }
    }
    meta.appendChild(rulesBlock);
  }

  entry.append(icon, meta);
  return entry;
}

// Initial push so the worker has the persisted custom chemistry from disk.
// Deferred via setTimeout so the worker has finished init() first; the
// worker itself ignores the message until then anyway, but this avoids
// queueing it before the worker exists.
setTimeout(() => { pushCustomChemistry(); }, 100);
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
  logStatus('🧊 FREEZE — paused, all noise/hydrolysis off, quicksaved. Press Q to resume + reload settings.');
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
    // The worker resets inGame on every load — exit the match UI too or
    // the sandbox would show the game HUD over a world with no match.
    if (gameMode) {
      exitGameModeUI();
      logStatus('Play mode OFF — world loaded');
    }
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
  if (gameMode) return; // hazard toggles are suspended while a match runs
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
  if (gameMode) return; // hazard toggles are suspended while a match runs
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
  // The display box changes with the fullscreen class — let the internal
  // resolution follow on layouts that track the display size, and move
  // the docked HUD toggle with it.
  requestAnimationFrame(() => { resizeCanvasToDisplay(); applyHudVisibility(); });
}
if (fsToggle) {
  fsToggle.addEventListener('click', toggleFullscreen);
}
const fsBtn = document.getElementById('fs-btn') as HTMLButtonElement | null;
if (fsBtn) fsBtn.addEventListener('click', toggleFullscreen);
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
  const isShortcutKey = /^Key[A-Z]$|^Comma$|^Period$/.test(e.code);
  if (isTyping && isShortcutKey) return;

  // In game mode, WASD/arrows are reserved for the player — arrows would
  // otherwise scroll the page. Other shortcuts stay live.
  const moveKey = MOVE_KEYS[e.code];
  if (gameMode && moveKey) {
    e.preventDefault();
    keyState[moveKey] = true;
    pushPlayerInput();
    return;
  }
  // Enter on the first-visit intro means "start game".
  if (e.code === 'Enter' && overlayShownStatus === 3) {
    e.preventDefault();
    dismissIntro();
    if (!gameMode) toggleGame();
    return;
  }
  // Enter on the end-of-match overlay restarts immediately — the
  // overlay's ↻ button advertises the same shortcut.
  if (gameMode && e.code === 'Enter' && overlayShownStatus !== 0) {
    e.preventDefault();
    restartMatch();
    return;
  }
  // Esc: pending bond → lab → inspector → panel → reset brush.
  if (e.code === 'Escape') {
    if (isInspectorOpen() && bondPendingId !== null) {
      bondPendingId = null;
      setEditorStatus('Bond gesture cancelled.');
      return;
    }
    if (isCreditsOpen()) { closeCredits(); return; }
    if (isLabOpen()) { closeLab(); return; }
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
  if (e.code === 'KeyS')  { setBrush('select'); }
  if (e.code === 'KeyC')  { clearWater(); }
  if (e.code === 'KeyV')  { toggleView(); }
  if (e.code === 'KeyG')  { toggleGame(); }
  if (e.code === 'KeyN')  { toggleNoise(); }
  if (e.code === 'KeyH')  { toggleHydro(); }
  if (e.code === 'KeyM')  { e.preventDefault(); togglePanel(); }
  if (e.code === 'Comma')        { e.preventDefault(); quickSave(); }
  if (e.code === 'Period')       { e.preventDefault(); quickLoad(); }
  if (e.code === 'KeyF')         { e.preventDefault(); setFollow(!followIds); }
  if (e.code === 'KeyQ')         { e.preventDefault(); freezeAndCapture(); }
  if ((e.code === 'Delete' || e.code === 'Backspace') && brushMode === 'select') {
    e.preventDefault();
    send({ type: 'deleteSelected' });
    logStatus('Selection deleted — observe the response (works while paused)');
  }
});
document.addEventListener('keyup', (e) => {
  if (!gameMode) return;
  const moveKey = MOVE_KEYS[e.code];
  if (moveKey) { keyState[moveKey] = false; pushPlayerInput(); }
});

// ── Interactive tutorial ────────────────────────────────────────────────────
// Thin adapters over the existing toggles — tutorial.ts stays free of UI
// internals, and setBrush/setPaused/setLysin get idempotent semantics here.
const tutorialBtn  = document.getElementById('tutorial-btn');
const tutorialBtn2 = document.getElementById('tutorial-btn2');
function launchTutorial(): void {
  startTutorial({
    send,
    logStatus,
    isPanelOpen,
    openPanel,
    closePanel,
    setBrush: (b) => { if (brushMode !== b) setBrush(b); },
    setPaused: (p) => { if (p !== paused) togglePause(); },
    isPaused: () => paused,
    openInspector,
    closeInspector,
    isInspectorOpen,
    isLabOpen,
    closeLab,
    isDictionaryOpen,
    viewCenterWorld: () => {
      const rect = canvas.getBoundingClientRect();
      return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
    getBrush: () => brushMode,
    // Slide the viewport ~35 % toward the nearest horizontal arena edge —
    // used before scripted drops so pasted content lands in open space
    // instead of on top of whatever the user was inspecting at center.
    panTowardEdge: () => {
      camSnap = null;
      const vw = canvas.width / camera.zoom;
      const cx = camera.x + vw / 2;
      const dir = cx < GRID_W / 2 ? -1 : 1;
      camera.x = Math.max(0, Math.min(GRID_W - vw, camera.x + dir * vw * 0.35));
    },
    focusOn: (x, y, r) => focusOn(x, y, r),
    setFollow: (on) => setFollow(on),
    isFollowing: () => followIds !== null,
    setRate: (f) => {
      simRate = Math.max(0, Math.min(1, f));
      speedSlider.value = String(Math.round(simRate * 100));
      speedVal.textContent = speedSlider.value + '%';
      send({ type: 'setSimRate', v: simRate });
    },
    getRate: () => simRate,
    setLysin: (on) => { if (on !== lysinActive) toggleLysin(); },
    isGameMode: () => gameMode,
    toggleGame,
  });
}
if (tutorialBtn) tutorialBtn.addEventListener('click', launchTutorial);
if (tutorialBtn2) tutorialBtn2.addEventListener('click', launchTutorial);

// ── Render loop ─────────────────────────────────────────────────────────────
// In game mode the top-left HUD swaps the sandbox stats for match state:
// enemies left, own cells/size and how close the win/lose timers are.
function drawHud(ctx: CanvasRenderingContext2D, snap: SnapshotMsg): void {
  if (gameMode) {
    drawGameHUD2D(ctx, snap.atoms, snap.atomCount, {
      playerCells: snap.playerCount,
      enemyCells: snap.enemyCount,
      membraneFrac: snap.playerMembraneFrac,
      itersPerSec: snap.itersPerSec,
      winIters: snap.winCountdownIter,
      loseIters: snap.loseCountdownIter,
      gameStatus: snap.gameStatus,
      fireIters: snap.fireCooldownIter,
      dartCount: snap.projectileCount,
      ammo: snap.lysinAmmo,
      homingOn: snap.homingOn,
      damageFlash: Math.max(0, 1 - (performance.now() - lastBiteAt) / 400),
    });
  } else {
    drawHUD2D(ctx, snap.iterations, snap.atomCount, snap.atoms);
  }
}

function loop(): void {
  snapTick();
  const snap = lastSnapshot;
  if (snap) {
    // Pending game-start arm: as soon as the pre-selected player atom
    // shows up in a snapshot, capture it for camera follow.
    if (armFollowOnSelection && followIds === null) {
      for (let i = 0; i < snap.atomCount; i++) {
        if (((snap.atoms[i * STRIDE + 3] | 0) & 16) !== 0) {
          setFollow(true);
          armFollowOnSelection = false;
          break;
        }
      }
    }
    if (followIds) followTick(snap);
    if (gameMode && steerTarget) pushSteerInput();
    if (gameMode) {
      if (snap.gameStatus === 1 || snap.gameStatus === 2) showGameOverlay(snap.gameStatus);
      else hideGameOverlay();
      // Dart reload mirror for the fire pad — updated unconditionally
      // (drawHud only runs in educational view with the HUD visible).
      lastFireCooldownIter = snap.fireCooldownIter;
      firePad?.style.setProperty('--cd', snap.fireCooldownFrac.toFixed(3));
      firePad?.classList.toggle('empty', snap.lysinAmmo < 5);
      // Homing unlock — rising edge only; a fresh match clears the flag
      // worker-side, which resets this mirror automatically.
      if (snap.homingOn && !homingSeen) {
        logStatus('◎ homing guidance online — lysoviruses now curve toward enemies');
      }
      homingSeen = snap.homingOn;
      // Enemy bearing tick — same angle convention as the aim needle
      // (0deg = up), so a press aligned with the tick fires at the
      // nearest enemy.
      if (fireEnemy) {
        if (snap.enemyDist > 0) {
          fireEnemy.classList.add('shown');
          fireEnemy.dataset.dist = snap.enemyDist.toFixed(0);
          // Proximity pulse — the tick blinks faster as the threat closes.
          fireEnemy.classList.toggle('close', snap.enemyDist < 220);
          const deg = Math.atan2(snap.enemyDirY, snap.enemyDirX) * 180 / Math.PI + 90;
          fireEnemy.style.transform = `rotate(${deg}deg)`;
        } else {
          fireEnemy.classList.remove('shown', 'close');
          delete fireEnemy.dataset.dist;
        }
      }
      if (fireLysin) {
        if (snap.lysinDist > 0) {
          fireLysin.classList.add('shown');
          const deg = Math.atan2(snap.lysinDirY, snap.lysinDirX) * 180 / Math.PI + 90;
          fireLysin.style.transform = `rotate(${deg}deg)`;
        } else {
          fireLysin.classList.remove('shown');
        }
      }
      // Kill feed — enemies replicate mid-match, so only a drop below
      // the running minimum counts as a real loss; a bounce back down
      // after a division is not a kill. Loop detection flickers during
      // the first seconds of a match (a spawning cell can count as an
      // extra loop for a frame), so the feed stays silent until the
      // detector has settled.
      if (snap.gameStatus === 0) {
        if (performance.now() - matchStartAt > 2500) {
          if (minEnemyCount < 0) minEnemyCount = snap.enemyCount;
          else if (snap.enemyCount < minEnemyCount) {
            minEnemyCount = snap.enemyCount;
            logStatus(`☠ Enemy down — ${snap.enemyCount} left`);
          }
        }
      } else {
        minEnemyCount = -1; // match ended — the next one seeds fresh
      }
    } else if (minEnemyCount !== -1) {
      minEnemyCount = -1;
    }
    if (viewMode === 'classic') {
      // Classic mode renders entirely onto the overlay canvas (which always
      // has a 2D context, regardless of whether main is WebGPU or 2D). The
      // overlay's opaque white fill covers whatever the main canvas last had.
      draw2DClassic(overlayCtx, snap.atoms, snap.atomCount, snap.bonds, snap.droplets, camera, GRID_W, GRID_H);
      // Arena boundary — drawn last on top of the white classic surface.
      // Uses a darker variant so it reads on white. Camera transform is
      // already set by draw2DClassic.
      const z = camera.zoom;
      overlayCtx.setTransform(z, 0, 0, z, -camera.x * z, -camera.y * z);
      drawArenaBorder(overlayCtx, GRID_W, GRID_H, z);
    } else if (useGPU) {
      drawGPU(snap.atoms, snap.atomCount, snap.loops, snap.bonds, snap.droplets, bacteriaView, snap.epoch, camera, GRID_W, GRID_H);
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
      if (viewMode === 'educational' && hudVisible) {
        drawHud(overlayCtx, snap);
        // The stats box width tracks its text — re-dock the toggle each
        // frame so it stays pinned to the box's top-right corner.
        positionHudToggle();
      }
    } else if (ctx2d) {
      draw2D(ctx2d, snap.atoms, snap.atomCount, snap.loops, snap.bonds, snap.droplets, bacteriaView, snap.epoch, camera, GRID_W, GRID_H);
      // Arena boundary on the 2D fallback canvas. Skipped in microscope.
      if (viewMode !== 'microscope') {
        const z = camera.zoom;
        ctx2d.setTransform(z, 0, 0, z, -camera.x * z, -camera.y * z);
        drawArenaBorder(ctx2d, GRID_W, GRID_H, z);
      }
      if (viewMode === 'educational' && hudVisible) {
        // HUD always in screen space — reset transform first
        ctx2d.setTransform(1, 0, 0, 1, 0, 0);
        drawHud(ctx2d, snap);
        positionHudToggle();
      }
    }
    // Selection halo — draws the yellow ring on whichever surface is
    // currently visible (overlay for GPU/Classic, main for 2D), so the
    // highlighted atom is always visible regardless of view mode.
    drawSelectionHalo(snap);
    // In-progress selection rectangle (drawn while the user is dragging).
    drawSelectionBox();
  }
  requestAnimationFrame(loop);
}

// Find the selected atom (flag bit 4) and draw a halo at its current
// world position. Drawn on whichever 2D context is currently on top:
//   • Classic view  → overlay (already opaque)
//   • GPU view      → overlay (sits over the GPU canvas)
//   • 2D view       → main ctx2d (since the overlay is empty/cleared)
//   • Microscope    → overlay (and we force-unhide it below)
function drawSelectionBox(): void {
  if (!selectBoxStart || !selectBoxEnd) return;
  const useOverlay = viewMode !== 'educational' || useGPU;
  const ctx = useOverlay ? overlayCtx : ctx2d;
  if (!ctx) return;
  const z = camera.zoom;
  ctx.setTransform(z, 0, 0, z, -camera.x * z, -camera.y * z);
  const x0 = Math.min(selectBoxStart.x, selectBoxEnd.x);
  const y0 = Math.min(selectBoxStart.y, selectBoxEnd.y);
  const w  = Math.abs(selectBoxEnd.x - selectBoxStart.x);
  const h  = Math.abs(selectBoxEnd.y - selectBoxStart.y);
  ctx.fillStyle = 'rgba(255, 220, 60, 0.10)';
  ctx.fillRect(x0, y0, w, h);
  ctx.lineWidth = Math.max(0.6, 1.2 / z);
  ctx.strokeStyle = 'rgba(255, 220, 60, 0.85)';
  ctx.setLineDash([4 / z, 3 / z]);
  ctx.strokeRect(x0, y0, w, h);
  ctx.setLineDash([]);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

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
  // Follow needs a selection to capture; while a track is already live
  // the button stays enabled so the user can release it.
  if (followBtn) followBtn.disabled = xs.length === 0 && followIds === null;
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
  ctx.lineWidth = Math.max(0.6, 1.2 / z);
  ctx.strokeStyle = `rgba(255, 220, 60, ${(pulse * 0.45).toFixed(3)})`;
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
// First visit only — the intro offers play mode vs. sandbox up front;
// afterwards the overlay is reserved for match end states.
if (!introSeen()) showIntroOverlay();
