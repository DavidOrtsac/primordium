// Canvas 2D renderer for the snapshot protocol. Phase-1 optimized:
//   • Soup particles batched into 2 draw calls per frame
//   • All Float64Array hot-path allocations eliminated (pre-allocated pools)
//   • smoothLoopPositions cached once per loop per frame
//   • Organelle blobs rendered via a pre-baked drawImage stamp (GPU blit)
//   • findMembraneLoops eliminated entirely — loops come pre-computed from worker

import { RADIUS } from './cell';
import { STRIDE, unpackType, unpackState } from './snapshot';

// ── Visual constants ────────────────────────────────────────────────────────
const COLORS: Record<string, string> = {
  e: '#ff3333', f: '#33ff33', b: '#888888', c: '#00dddd',
  d: '#3366ff', p: '#ff7700', w: '#66ccff',
};

const LEGEND: { color: string; label: string; isLine?: boolean }[] = [
  { color: '#c8a800', label: 'a  membrane (bond line)', isLine: true },
  { color: '#888888', label: 'b  genome base' },
  { color: '#00dddd', label: 'c  genome base' },
  { color: '#3366ff', label: 'd  enzyme (mid-walk = bouncing)' },
  { color: '#ff3333', label: 'e  genome start' },
  { color: '#33ff33', label: 'f  genome end' },
  { color: '#ff7700', label: 'p  lysin (dissolves membranes)' },
];

const Q_STATE = 42;

// EMA factors (visual smoothing, applied here so worker stays pure)
const EMA_DEFAULT   = 0.28;
const EMA_ORGANELLE = 0.07;
const EMA_MEMBRANE  = 0.12;
const TELEPORT_THRESHOLD2 = 400;

// ── Pre-allocated reusable buffers (zero hot-path allocation) ───────────────
const MAX_LOOP = 600;
const _ptsA = new Float64Array(MAX_LOOP * 2);
const _ptsB = new Float64Array(MAX_LOOP * 2);
const _segs = new Float64Array(MAX_LOOP);

// Persistent display position arrays — index aligned with snapshot atom index
let _displayX = new Float32Array(0);
let _displayY = new Float32Array(0);
let _displayInit: Uint8Array = new Uint8Array(0);
let _emaEpoch = -1;

function ensureDisplay(n: number, epoch: number): void {
  if (epoch !== _emaEpoch) {
    _displayX = new Float32Array(n);
    _displayY = new Float32Array(n);
    _displayInit = new Uint8Array(n);
    _emaEpoch = epoch;
    return;
  }
  if (n > _displayX.length) {
    const oldX = _displayX, oldY = _displayY, oldI = _displayInit;
    const cap = Math.max(n, _displayX.length * 2);
    _displayX = new Float32Array(cap); _displayX.set(oldX);
    _displayY = new Float32Array(cap); _displayY.set(oldY);
    _displayInit = new Uint8Array(cap); _displayInit.set(oldI);
  }
}

// ── Organelle stamp (offscreen canvas, pre-rendered once) ───────────────────
let _stampDense: HTMLCanvasElement | null = null;
let _stampLight: HTMLCanvasElement | null = null;
let _stampDebris: HTMLCanvasElement | null = null;

function makeStamp(stops: [number, string][], size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const cx = c.getContext('2d')!;
  const half = size / 2;
  const grad = cx.createRadialGradient(half, half, 0, half, half, half);
  for (const [s, color] of stops) grad.addColorStop(s, color);
  cx.fillStyle = grad;
  cx.fillRect(0, 0, size, size);
  return c;
}

function ensureStamps(): void {
  if (_stampDense) return;
  const SZ = 64;
  _stampDense = makeStamp([
    [0, 'rgba(22, 13,  6, 0.80)'],
    [0.45, 'rgba(45, 28, 14, 0.45)'],
    [1, 'rgba(70, 50, 30, 0.00)'],
  ], SZ);
  _stampLight = makeStamp([
    [0, 'rgba(52, 36, 18, 0.65)'],
    [0.55, 'rgba(70, 52, 32, 0.30)'],
    [1, 'rgba(80, 62, 40, 0.00)'],
  ], SZ);
  _stampDebris = makeStamp([
    [0, 'rgba(70, 55, 40, 0.38)'],
    [0.7, 'rgba(70, 55, 40, 0.07)'],
    [1, 'rgba(70, 55, 40, 0.00)'],
  ], SZ);
}

function atomHash32(idx: number, type: number, state: number): number {
  return ((type * 73856093) ^ (state * 19349663) ^ (idx * 83492791)) >>> 0;
}

// ── EMA smoothing ───────────────────────────────────────────────────────────
function smoothPositions(atoms: Float32Array, n: number, flagsCol = 3): void {
  for (let i = 0; i < n; i++) {
    const o = i * STRIDE;
    const x = atoms[o + 0];
    const y = atoms[o + 1];
    const flags = atoms[o + flagsCol] | 0;
    const isMembrane = (flags & 4) !== 0;
    const isBonded   = (flags & 1) !== 0;

    if (!_displayInit[i]) {
      _displayX[i] = x;
      _displayY[i] = y;
      _displayInit[i] = 1;
      continue;
    }
    const dx = x - _displayX[i];
    const dy = y - _displayY[i];
    if (dx * dx + dy * dy > TELEPORT_THRESHOLD2) {
      _displayX[i] = x;
      _displayY[i] = y;
      continue;
    }
    const ema = isMembrane ? EMA_MEMBRANE : (isBonded ? EMA_ORGANELLE : EMA_DEFAULT);
    _displayX[i] += dx * ema;
    _displayY[i] += dy * ema;
  }
}

// ── Loop polygon helpers (operate on display positions via atom indices) ────
function smoothLoopFromIndices(loops: Uint32Array, vertOffset: number, vertCount: number, iters: number, out: Float64Array): void {
  for (let i = 0; i < vertCount; i++) {
    const idx = loops[vertOffset + i];
    out[i * 2]     = _displayX[idx];
    out[i * 2 + 1] = _displayY[idx];
  }
  if (iters <= 0) return;
  let buf: Float64Array = out;
  let next: Float64Array = _ptsB;
  for (let k = 0; k < iters; k++) {
    for (let i = 0; i < vertCount; i++) {
      const prev = (i - 1 + vertCount) % vertCount;
      const nxt  = (i + 1) % vertCount;
      next[i * 2]     = 0.5 * buf[i * 2]     + 0.25 * buf[prev * 2]     + 0.25 * buf[nxt * 2];
      next[i * 2 + 1] = 0.5 * buf[i * 2 + 1] + 0.25 * buf[prev * 2 + 1] + 0.25 * buf[nxt * 2 + 1];
    }
    const tmp = buf; buf = next; next = tmp;
  }
  if (buf !== out) {
    for (let i = 0; i < vertCount * 2; i++) out[i] = buf[i];
  }
}

function inflateLoop(pts: Float64Array, n: number, amount: number): void {
  if (amount === 0) return;
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += pts[i * 2]; cy += pts[i * 2 + 1]; }
  cx /= n; cy /= n;
  for (let i = 0; i < n; i++) {
    const dx = pts[i * 2] - cx, dy = pts[i * 2 + 1] - cy;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    pts[i * 2]     += (dx / len) * amount;
    pts[i * 2 + 1] += (dy / len) * amount;
  }
}

function tracePath(ctx: CanvasRenderingContext2D, pts: Float64Array, n: number, scale: number): void {
  const lastX = pts[(n - 1) * 2], lastY = pts[(n - 1) * 2 + 1];
  const firstX = pts[0],          firstY = pts[1];
  ctx.moveTo(((lastX + firstX) / 2) * scale, ((lastY + firstY) / 2) * scale);
  for (let i = 0; i < n; i++) {
    const cx = pts[i * 2], cy = pts[i * 2 + 1];
    const nxt = (i + 1) % n;
    const nxtX = pts[nxt * 2], nxtY = pts[nxt * 2 + 1];
    ctx.quadraticCurveTo(cx * scale, cy * scale, ((cx + nxtX) / 2) * scale, ((cy + nxtY) / 2) * scale);
  }
  ctx.closePath();
}

// ── Stretchy line — bucketed batched stroke (Phase 1 already, kept) ─────────
function drawStretchy(
  ctx: CanvasRenderingContext2D,
  pts: Float64Array,
  n: number,
  scale: number,
  baseW: number,
  baseR: number, baseG: number, baseB: number, baseA: number,
): void {
  const BUCKETS = 4;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = pts[j * 2] - pts[i * 2], dy = pts[j * 2 + 1] - pts[i * 2 + 1];
    _segs[i] = Math.sqrt(dx * dx + dy * dy);
    total += _segs[i];
  }
  const mean = total / n || 1;

  for (let b = 0; b < BUCKETS; b++) {
    const t = (b + 0.5) / BUCKETS;
    const widthMul = 1.5 - t * 1.2;
    const alphaMul = 1.0 - t * 0.72;
    let drew = false;
    ctx.lineWidth = baseW * widthMul;
    ctx.strokeStyle = `rgba(${baseR},${baseG},${baseB},${(baseA * alphaMul).toFixed(2)})`;
    ctx.beginPath();

    for (let i = 0; i < n; i++) {
      const stretch = _segs[i] / mean;
      const segT = Math.max(0, Math.min(1, (stretch - 0.6) / 1.2));
      const bucket = Math.min(BUCKETS - 1, Math.floor(segT * BUCKETS));
      if (bucket !== b) continue;

      const prev = (i - 1 + n) % n, next = (i + 1) % n;
      const mPrevX = (pts[prev * 2] + pts[i * 2]) / 2;
      const mPrevY = (pts[prev * 2 + 1] + pts[i * 2 + 1]) / 2;
      const mNextX = (pts[i * 2] + pts[next * 2]) / 2;
      const mNextY = (pts[i * 2 + 1] + pts[next * 2 + 1]) / 2;
      ctx.moveTo(mPrevX * scale, mPrevY * scale);
      ctx.quadraticCurveTo(pts[i * 2] * scale, pts[i * 2 + 1] * scale, mNextX * scale, mNextY * scale);
      drew = true;
    }
    if (drew) ctx.stroke();
  }
}

// ── Public draw ─────────────────────────────────────────────────────────────
export type Camera = { x: number; y: number; zoom: number };

export function draw2D(
  ctx: CanvasRenderingContext2D,
  atoms: Float32Array,
  atomCount: number,
  loops: Uint32Array,
  bonds: Uint32Array,
  droplets: Float32Array,
  bacteriaView: boolean,
  epoch: number,
  camera: Camera,
): void {
  ensureDisplay(atomCount, epoch);
  smoothPositions(atoms, atomCount);
  ensureStamps();

  const { canvas } = ctx;
  // Internal scale is 1 (we draw in world coords). The ctx.setTransform below
  // handles all zoom + pan conversion to screen space.
  const scale = 1;

  // Background fills full screen — render in screen space, then apply camera
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (bacteriaView) {
    const grad = ctx.createRadialGradient(
      canvas.width / 2, canvas.height / 2, 0,
      canvas.width / 2, canvas.height / 2, Math.max(canvas.width, canvas.height) * 0.6,
    );
    grad.addColorStop(0,   '#d8d8d8');
    grad.addColorStop(1,   '#b8b8b8');
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = '#ffffff';
  }
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // World→screen transform: screen_xy = (world_xy - camera) * zoom
  const z = camera.zoom;
  ctx.setTransform(z, 0, 0, z, -camera.x * z, -camera.y * z);

  // ── Water droplets — drawn first so atoms render ON TOP of water ────────
  const dropCount = droplets[0] | 0;
  for (let i = 0; i < dropCount; i++) {
    const dx = droplets[1 + i * 3];
    const dy = droplets[2 + i * 3];
    const dr = droplets[3 + i * 3];
    const grad = ctx.createRadialGradient(dx, dy, 0, dx, dy, dr);
    if (bacteriaView) {
      // Microscope: barely-there phase shift. Slight darkening at the edge,
      // almost-imperceptible interior. No visible "circle" — just a region
      // that *feels* slightly different from the dry slide around it.
      grad.addColorStop(0.0,  'rgba(140, 160, 180, 0.025)');
      grad.addColorStop(0.85, 'rgba(140, 160, 180, 0.04)');
      grad.addColorStop(0.97, 'rgba( 60,  75,  90, 0.10)');
      grad.addColorStop(1.0,  'rgba(140, 160, 180, 0.0)');
    } else {
      // Educational: visible cool lens with bright meniscus
      grad.addColorStop(0.00, 'rgba(170, 200, 220, 0.05)');
      grad.addColorStop(0.85, 'rgba(170, 200, 220, 0.10)');
      grad.addColorStop(0.96, 'rgba(220, 235, 245, 0.50)');
      grad.addColorStop(1.00, 'rgba(120, 150, 180, 0.18)');
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(dx, dy, dr, 0, Math.PI * 2);
    ctx.fill();
  }

  const r = scale * RADIUS * 0.8;
  const loopSmoothing = bacteriaView ? 5 : 1;
  const loopInflate   = bacteriaView ? 2.2 : 0;
  const loopCount = loops[0];

  // ── Cell membrane interior fill (DIC gradient in microscope) ──────────────
  let cursor = 1;
  const loopOffsets: { vert: number; n: number; kind: number }[] = [];
  for (let li = 0; li < loopCount; li++) {
    const vertCount = loops[cursor++];
    const kind      = loops[cursor++] | 0; // 0=prey, 1=predator, 2=player
    const vertOffset = cursor;
    cursor += vertCount;
    if (vertCount > MAX_LOOP) continue;
    loopOffsets.push({ vert: vertOffset, n: vertCount, kind });

    smoothLoopFromIndices(loops, vertOffset, vertCount, loopSmoothing, _ptsA);
    inflateLoop(_ptsA, vertCount, loopInflate);

    ctx.beginPath();
    tracePath(ctx, _ptsA, vertCount, scale);

    if (bacteriaView) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < vertCount; i++) {
        const x = _ptsA[i * 2] * scale, y = _ptsA[i * 2 + 1] * scale;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const pad = 8;
      const grad2 = ctx.createLinearGradient(minX - pad, minY - pad, maxX + pad, maxY + pad);
      if (kind === 1) {
        grad2.addColorStop(0,    'rgba(210, 185, 155, 0.90)');
        grad2.addColorStop(0.45, 'rgba(140, 105,  85, 0.85)');
        grad2.addColorStop(1,    'rgba( 55,  25,  20, 0.92)');
      } else if (kind === 2) {
        // Player — greenish-sepia under microscope. Subtle but identifiable.
        grad2.addColorStop(0,    'rgba(195, 220, 175, 0.90)');
        grad2.addColorStop(0.45, 'rgba(115, 150,  95, 0.85)');
        grad2.addColorStop(1,    'rgba( 30,  55,  25, 0.92)');
      } else {
        grad2.addColorStop(0,    'rgba(225, 205, 170, 0.90)');
        grad2.addColorStop(0.45, 'rgba(155, 130, 100, 0.85)');
        grad2.addColorStop(1,    'rgba( 55,  40,  25, 0.92)');
      }
      ctx.fillStyle = grad2;
    } else {
      ctx.fillStyle = kind === 1 ? 'rgba(200, 30, 0, 0.07)'
                    : kind === 2 ? 'rgba(50, 220, 160, 0.10)'
                    :              'rgba(200, 168, 0, 0.07)';
    }
    ctx.fill();
  }

  // ── Soup particles (state 0, non-membrane) — BATCHED ──────────────────────
  // Phase 1 win: collect all filled and all stroked into 2 draw calls.
  if (bacteriaView) {
    // Filled specks pass
    ctx.fillStyle = 'rgba(80, 60, 40, 0.20)';
    ctx.beginPath();
    for (let i = 0; i < atomCount; i++) {
      const o = i * STRIDE;
      const flags = atoms[o + 3] | 0;
      const isMembrane = (flags & 4) !== 0;
      const state = unpackState(atoms[o + 2]);
      if (state !== 0 || isMembrane) continue;
      const h = atomHash32(i, unpackType(atoms[o + 2]), state);
      if ((h >>> 20) % 3 === 0) continue; // bubble bucket
      const pr = r * (0.25 + (h % 600) / 1000);
      const px = _displayX[i] * scale, py = _displayY[i] * scale;
      ctx.moveTo(px + pr, py);
      ctx.arc(px, py, pr, 0, Math.PI * 2);
    }
    ctx.fill();

    // Bubble pass (stroke-only)
    ctx.strokeStyle = 'rgba(60, 45, 30, 0.28)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let i = 0; i < atomCount; i++) {
      const o = i * STRIDE;
      const flags = atoms[o + 3] | 0;
      const isMembrane = (flags & 4) !== 0;
      const state = unpackState(atoms[o + 2]);
      if (state !== 0 || isMembrane) continue;
      const h = atomHash32(i, unpackType(atoms[o + 2]), state);
      if ((h >>> 20) % 3 !== 0) continue;
      const pr = r * (0.25 + (h % 600) / 1000);
      const px = _displayX[i] * scale, py = _displayY[i] * scale;
      ctx.moveTo(px + pr, py);
      ctx.arc(px, py, pr, 0, Math.PI * 2);
    }
    ctx.stroke();
  } else {
    // Educational: per-type colored fill, also batched per color
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < atomCount; i++) {
      const o = i * STRIDE;
      const flags = atoms[o + 3] | 0;
      const isMembrane = (flags & 4) !== 0;
      const state = unpackState(atoms[o + 2]);
      const type = String.fromCharCode(unpackType(atoms[o + 2]));
      // Water always renders via soup style regardless of state (fresh
      // and spent water are the same molecule visually).
      const isWater = type === 'w';
      if ((state !== 0 && !isWater) || isMembrane) continue;
      const alpha = type === 'p' ? '55' : '1a';
      const key = (COLORS[type] ?? '#ff3333') + alpha;
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(i);
    }
    for (const [color, indices] of buckets) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const i of indices) {
        const px = _displayX[i] * scale, py = _displayY[i] * scale;
        ctx.moveTo(px + r, py);
        ctx.arc(px, py, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  // ── Build inLoop bit-vector so we don't redraw closed-loop membrane bonds ─
  const inLoop = new Uint8Array(atomCount);
  {
    let c2 = 1;
    for (let li = 0; li < loopCount; li++) {
      const vc = loops[c2++];
      c2 += 1; // kind
      for (let i = 0; i < vc; i++) inLoop[loops[c2 + i]] = 1;
      c2 += vc;
    }
  }

  // ── Membrane outlines ─────────────────────────────────────────────────────
  ctx.lineJoin = 'round';
  if (bacteriaView) {
    for (const { vert, n, kind } of loopOffsets) {
      smoothLoopFromIndices(loops, vert, n, loopSmoothing, _ptsA);
      inflateLoop(_ptsA, n, loopInflate);
      // Player gets a slightly green-tinted shadow + body so it stands out
      // even in microscope without breaking the DIC aesthetic.
      const shadowR = kind === 2 ? 12 : 20, shadowG = kind === 2 ? 30 : 12, shadowB = kind === 2 ? 14 : 6;
      const bodyR   = kind === 2 ? 22 : 35, bodyG   = kind === 2 ? 60 : 22, bodyB   = kind === 2 ? 28 : 12;
      ctx.save();
      ctx.translate(1.2, 1.2);
      drawStretchy(ctx, _ptsA, n, scale, 1.1, shadowR, shadowG, shadowB, 0.55);
      ctx.restore();
      ctx.save();
      ctx.translate(-1.0, -1.0);
      drawStretchy(ctx, _ptsA, n, scale, 0.8, 255, 245, 215, 0.65);
      ctx.restore();
      drawStretchy(ctx, _ptsA, n, scale, 0.65, bodyR, bodyG, bodyB, 0.70);
    }
  } else {
    ctx.lineWidth = 2.5;
    for (const { vert, n, kind } of loopOffsets) {
      smoothLoopFromIndices(loops, vert, n, loopSmoothing, _ptsA);
      ctx.strokeStyle = kind === 1 ? 'rgba(200, 30, 0, 0.92)'
                       : kind === 2 ? 'rgba(50, 220, 160, 0.95)'
                       :              'rgba(200, 168, 0, 0.92)';
      ctx.beginPath();
      tracePath(ctx, _ptsA, n, scale);
      ctx.stroke();
    }
  }

  // ── Open membrane chains + non-membrane bond network (educational) ───────
  const bondCount = bonds[0];

  // Prey open membrane chains
  ctx.strokeStyle = bacteriaView ? 'rgba(50, 40, 30, 0.78)' : 'rgba(200, 168, 0, 0.92)';
  ctx.lineWidth = bacteriaView ? 1.0 : 2.5;
  ctx.beginPath();
  for (let bi = 0; bi < bondCount; bi++) {
    const ai = bonds[1 + bi * 2];
    const bj = bonds[2 + bi * 2];
    const af = atoms[ai * STRIDE + 3] | 0;
    const bf = atoms[bj * STRIDE + 3] | 0;
    if (!(af & 4) || !(bf & 4)) continue;
    if ((af & 2) || (bf & 2)) continue;
    if (inLoop[ai] && inLoop[bj]) continue;
    ctx.moveTo(_displayX[ai] * scale, _displayY[ai] * scale);
    ctx.lineTo(_displayX[bj] * scale, _displayY[bj] * scale);
  }
  ctx.stroke();

  // Predator open membrane chains
  ctx.strokeStyle = bacteriaView ? 'rgba(60, 25, 20, 0.85)' : 'rgba(200, 30, 0, 0.92)';
  ctx.beginPath();
  for (let bi = 0; bi < bondCount; bi++) {
    const ai = bonds[1 + bi * 2];
    const bj = bonds[2 + bi * 2];
    const af = atoms[ai * STRIDE + 3] | 0;
    const bf = atoms[bj * STRIDE + 3] | 0;
    if (!(af & 4) || !(bf & 4)) continue;
    if (!(af & 2)) continue;
    if (inLoop[ai] && inLoop[bj]) continue;
    ctx.moveTo(_displayX[ai] * scale, _displayY[ai] * scale);
    ctx.lineTo(_displayX[bj] * scale, _displayY[bj] * scale);
  }
  ctx.stroke();

  // Non-membrane bond network (gene strand, enzyme attachments) — educational only
  if (!bacteriaView) {
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let bi = 0; bi < bondCount; bi++) {
      const ai = bonds[1 + bi * 2];
      const bj = bonds[2 + bi * 2];
      const af = atoms[ai * STRIDE + 3] | 0;
      const bf = atoms[bj * STRIDE + 3] | 0;
      if ((af & 4) && (bf & 4)) continue; // both membrane → drawn above
      ctx.moveTo(_displayX[ai] * scale, _displayY[ai] * scale);
      ctx.lineTo(_displayX[bj] * scale, _displayY[bj] * scale);
    }
    ctx.stroke();
  }

  // ── Active non-membrane atoms (organelles/colored particles) ──────────────
  if (bacteriaView) {
    for (let i = 0; i < atomCount; i++) {
      const o = i * STRIDE;
      const flags = atoms[o + 3] | 0;
      const isMembrane = (flags & 4) !== 0;
      const state = unpackState(atoms[o + 2]);
      const type = String.fromCharCode(unpackType(atoms[o + 2]));
      // Water never renders via the organelle path. It's always small,
      // soft, and water-colored regardless of state.
      if (state === 0 || isMembrane || type === 'w') continue;
      const isBonded = (flags & 1) !== 0;
      const isDense = type === 'd' || type === 'e' || type === 'f';

      const h = atomHash32(i, unpackType(atoms[o + 2]), state);
      const sizeMul = 1.1 + (h % 900) / 1000;
      const blobR = r * sizeMul;

      const px = _displayX[i] * scale, py = _displayY[i] * scale;
      const stamp = !isBonded ? _stampDebris! : (isDense ? _stampDense! : _stampLight!);
      // drawImage is a GPU blit — far cheaper than createRadialGradient + arc + fill
      ctx.drawImage(stamp, px - blobR, py - blobR, blobR * 2, blobR * 2);
    }
  } else {
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < atomCount; i++) {
      const o = i * STRIDE;
      const flags = atoms[o + 3] | 0;
      const isMembrane = (flags & 4) !== 0;
      const state = unpackState(atoms[o + 2]);
      const type = String.fromCharCode(unpackType(atoms[o + 2]));
      // Water atoms always render via the soup-style path even at state>0
      // (spent water). Skip them here so they don't get bumped into the
      // large saturated organelle visual.
      if (state === 0 || isMembrane || type === 'w') continue;
      const key = (COLORS[type] ?? '#ff3333') + 'cc';
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(i);
    }
    for (const [color, indices] of buckets) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const i of indices) {
        const px = _displayX[i] * scale, py = _displayY[i] * scale;
        ctx.moveTo(px + r, py);
        ctx.arc(px, py, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }
}

// ── Classic view (Hutton's 2002/2007 aesthetic) ────────────────────────────
// Renders atoms as pixel-aligned filled squares, bonds as thin straight gray
// lines, on a white background. No bezier curves on membranes — the membrane
// outline is just the chain of `a`-`a` bond lines, exactly as in the original.
// Free state-0 atoms render at low alpha so the eye separates "active
// chemistry" (bonded / charged) from "background soup."
//
// Drawn into the OVERLAY canvas so it works regardless of whether the main
// canvas is using WebGPU or Canvas 2D. The overlay is opaque white and sits
// on top of whatever the main canvas last rendered.
const CLASSIC_COLORS: Record<string, string> = {
  a: '#c8a800', b: '#888888', c: '#00dddd', d: '#3366ff',
  e: '#ff3333', f: '#33ff33', p: '#ff7700', w: '#a8d8ff',
};

export function draw2DClassic(
  ctx: CanvasRenderingContext2D,
  atoms: Float32Array,
  atomCount: number,
  bonds: Uint32Array,
  droplets: Float32Array,
  camera: Camera,
): void {
  const { canvas } = ctx;

  // Opaque white background covers whatever the main canvas had.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // World→screen camera transform, same convention as draw2D.
  const z = camera.zoom;
  ctx.setTransform(z, 0, 0, z, -camera.x * z, -camera.y * z);

  // Faint water droplet hint — Primordium-only feature, kept very subtle so
  // the classic look stays close to Hutton's. Set to 0 alpha if you want
  // perfect Hutton fidelity.
  const dropCount = droplets[0] | 0;
  ctx.fillStyle = 'rgba(190, 215, 235, 0.18)';
  for (let i = 0; i < dropCount; i++) {
    const dx = droplets[1 + i * 3];
    const dy = droplets[2 + i * 3];
    const dr = droplets[3 + i * 3];
    ctx.beginPath();
    ctx.arc(dx, dy, dr, 0, Math.PI * 2);
    ctx.fill();
  }

  // Bonds — thin straight lines between bonded atom centers. Single batched
  // path for performance. lineWidth scales inversely with zoom so it stays
  // ~1px on screen regardless of zoom level.
  const bondCount = bonds[0] | 0;
  ctx.strokeStyle = 'rgba(60, 60, 60, 0.55)';
  ctx.lineWidth = Math.max(0.4, 0.8 / z);
  ctx.beginPath();
  for (let bi = 0; bi < bondCount; bi++) {
    const i = bonds[1 + bi * 2];
    const j = bonds[1 + bi * 2 + 1];
    const oi = i * STRIDE;
    const oj = j * STRIDE;
    ctx.moveTo(atoms[oi + 0], atoms[oi + 1]);
    ctx.lineTo(atoms[oj + 0], atoms[oj + 1]);
  }
  ctx.stroke();

  // Atoms as squares. Two passes (faint soup first, solid foreground second)
  // so we set globalAlpha exactly twice instead of per-atom.
  const sq = RADIUS * 1.5;
  const half = sq / 2;

  // Pass 1: free state-0 atoms (soup) — faint pastel squares.
  ctx.globalAlpha = 0.22;
  for (let i = 0; i < atomCount; i++) {
    const o = i * STRIDE;
    const flags = atoms[o + 3] | 0;
    const isBonded = (flags & 1) !== 0;
    if (isBonded) continue;
    const packed = atoms[o + 2];
    const state = unpackState(packed);
    if (state !== 0) continue;
    const type = String.fromCharCode(unpackType(packed));
    ctx.fillStyle = CLASSIC_COLORS[type] || '#444444';
    ctx.fillRect(atoms[o + 0] - half, atoms[o + 1] - half, sq, sq);
  }

  // Pass 2: bonded or active atoms — solid squares (the visually "alive" set).
  ctx.globalAlpha = 1;
  for (let i = 0; i < atomCount; i++) {
    const o = i * STRIDE;
    const flags = atoms[o + 3] | 0;
    const isBonded = (flags & 1) !== 0;
    const packed = atoms[o + 2];
    const state = unpackState(packed);
    if (!isBonded && state === 0) continue;
    const type = String.fromCharCode(unpackType(packed));
    ctx.fillStyle = CLASSIC_COLORS[type] || '#444444';
    ctx.fillRect(atoms[o + 0] - half, atoms[o + 1] - half, sq, sq);
  }
  ctx.globalAlpha = 1;
}

export function drawHUD2D(ctx: CanvasRenderingContext2D, iterations: number, atomCount: number, atoms: Float32Array): void {
  let bonded = 0;
  for (let i = 0; i < atomCount; i++) {
    if ((atoms[i * STRIDE + 3] | 0) & 1) bonded++;
  }
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(6, 6, 220, 42);
  ctx.fillStyle = '#ffffff';
  ctx.font = '12px monospace';
  ctx.fillText(`iter:   ${iterations.toLocaleString()}`, 14, 22);
  ctx.fillText(`bonded: ${bonded}   free: ${atomCount - bonded}`, 14, 38);

  const PAD = 10, SZ = 10, ROW = 18, W = 240;
  const H = PAD * 2 + LEGEND.length * ROW - 2;
  const lx = 6, ly = 56;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(lx, ly, W, H);
  ctx.font = '11px monospace';
  LEGEND.forEach(({ color, label, isLine }, i) => {
    const y = ly + PAD + i * ROW;
    if (isLine) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(lx + PAD, y + SZ / 2);
      ctx.lineTo(lx + PAD + SZ, y + SZ / 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = color + 'cc';
      ctx.beginPath();
      ctx.arc(lx + PAD + SZ / 2, y + SZ / 2, SZ / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#dddddd';
    ctx.fillText(label, lx + PAD + SZ + 8, y + SZ - 1);
  });
}

// silence unused-warning for Q_STATE in case lint complains
void Q_STATE;
