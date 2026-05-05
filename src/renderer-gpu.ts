// WebGPU renderer for the snapshot protocol. Replaces every CPU-bound Canvas 2D
// pass with GPU-accelerated equivalents:
//   • Background gradient        → fullscreen quad fragment shader
//   • Cell membrane fill         → polygon vertices uploaded per frame, DIC gradient in fragment shader
//   • Soup particles             → instanced billboard quads, SDF blob/bubble fragment shader
//   • Stretchy membrane outline  → per-segment quads (vertex shader expands to width), shaded by stretch attribute
//   • Organelle blobs            → instanced billboard quads, soft radial fragment shader
//   • Vignette                   → fullscreen quad fragment shader
//
// HUD/legend stays Canvas 2D as a sibling overlay element.

import { RADIUS } from './cell';
import { STRIDE, unpackType, unpackState } from './snapshot';

// ── EMA smoothing (same constants as 2D renderer) ───────────────────────────
const EMA_DEFAULT   = 0.28;
const EMA_ORGANELLE = 0.07;
const EMA_MEMBRANE  = 0.12;
const TELEPORT_THRESHOLD2 = 400;

// Visual tuning knobs ported from 2D renderer
const LOOP_SMOOTH_MICRO = 5;
const LOOP_SMOOTH_EDU   = 1;
const LOOP_INFLATE_MICRO = 2.2;

// Runtime constant — TS DOM lib doesn't always expose these as values, so
// we declare it locally with the WebGPU spec values.
const GPUBufferUsage = {
  VERTEX:  0x0020,
  UNIFORM: 0x0040,
  COPY_DST: 0x0008,
} as const;

// Caps
const MAX_ATOMS_GPU     = 80_000;
const MAX_TRI_VERTS     = 60_000;
const MAX_SEG_INSTANCES = 20_000;

// ── Internal state ──────────────────────────────────────────────────────────
let _device: GPUDevice | null = null;
let _ctx: GPUCanvasContext | null = null;
let _format: GPUTextureFormat = 'bgra8unorm';
let _pipelines: ReturnType<typeof buildPipelines> | null = null;
let _buffers: ReturnType<typeof buildBuffers> | null = null;
let _displayX = new Float32Array(0);
let _displayY = new Float32Array(0);
let _displayInit: Uint8Array = new Uint8Array(0);
let _emaEpoch = -1;
let _canvasW = 0;
let _canvasH = 0;

// Reusable CPU-side scratch
const MAX_LOOP = 600;
const _ptsA = new Float64Array(MAX_LOOP * 2);
const _ptsB = new Float64Array(MAX_LOOP * 2);

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

function smoothPositions(atoms: Float32Array, n: number): void {
  for (let i = 0; i < n; i++) {
    const o = i * STRIDE;
    const x = atoms[o + 0];
    const y = atoms[o + 1];
    const flags = atoms[o + 3] | 0;
    const isMembrane = (flags & 4) !== 0;
    const isBonded   = (flags & 1) !== 0;
    if (!_displayInit[i]) {
      _displayX[i] = x; _displayY[i] = y; _displayInit[i] = 1; continue;
    }
    const dx = x - _displayX[i];
    const dy = y - _displayY[i];
    if (dx * dx + dy * dy > TELEPORT_THRESHOLD2) {
      _displayX[i] = x; _displayY[i] = y; continue;
    }
    const ema = isMembrane ? EMA_MEMBRANE : (isBonded ? EMA_ORGANELLE : EMA_DEFAULT);
    _displayX[i] += dx * ema;
    _displayY[i] += dy * ema;
  }
}

// ── Common WGSL prelude ─────────────────────────────────────────────────────
// All shaders use the same uniform layout. Camera in world space; zoom maps
// world → screen via screen_xy = (world_xy - camera) * zoom.
const PRELUDE = `
struct Uniforms {
  resolution: vec2f,
  view: u32, _pad0: u32,
  camera: vec2f,
  zoom: f32, _pad1: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
fn worldToClip(p: vec2f) -> vec2f {
  let screen = (p - u.camera) * u.zoom;
  return vec2f((screen.x / u.resolution.x) * 2. - 1., 1. - (screen.y / u.resolution.y) * 2.);
}
`;

// ── WGSL shader sources ─────────────────────────────────────────────────────
const SHADER_BG = PRELUDE + `
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 6>(
    vec2f(-1.,-1.), vec2f(1.,-1.), vec2f(1.,1.),
    vec2f(-1.,-1.), vec2f(1.,1.), vec2f(-1.,1.));
  return vec4f(p[vi], 0., 1.);
}
@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  if (u.view == 1u) {
    let cx = u.resolution * 0.5;
    let d  = distance(frag.xy, cx) / (max(u.resolution.x, u.resolution.y) * 0.6);
    let t  = clamp(d, 0., 1.);
    let c0 = vec3f(0.847, 0.847, 0.847);
    let c1 = vec3f(0.722, 0.722, 0.722);
    return vec4f(mix(c0, c1, t), 1.);
  }
  return vec4f(1., 1., 1., 1.);
}
`;

const SHADER_PARTICLE = PRELUDE + `
struct Instance {
  @location(0) pos: vec2f,
  @location(1) radius: f32,
  @location(4) style: f32,        // 0=blob, 1=bubble, 2=organelle
  @location(3) color: vec4f,      // rgba
};

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) style: f32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, inst: Instance) -> VOut {
  var quad = array<vec2f, 6>(
    vec2f(-1.,-1.), vec2f(1.,-1.), vec2f(1.,1.),
    vec2f(-1.,-1.), vec2f(1.,1.), vec2f(-1.,1.));
  let q = quad[vi];
  let world = inst.pos + q * inst.radius;
  var o: VOut;
  o.clip  = vec4f(worldToClip(world), 0., 1.);
  o.uv    = q;
  o.color = inst.color;
  o.style = inst.style;
  return o;
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let d = length(in.uv);
  if (d > 1.) { discard; }
  // 0 = hard disk · 1 = bubble · 2 = soft blob · 3 = organelle · 4 = water droplet
  if (in.style < 0.5) {
    return vec4f(in.color.rgb, in.color.a);
  } else if (in.style < 1.5) {
    let ring = smoothstep(0.78, 0.84, d) * (1. - smoothstep(0.92, 1.0, d));
    if (ring < 0.02) { discard; }
    return vec4f(in.color.rgb, ring * in.color.a);
  } else if (in.style < 2.5) {
    let a = (1. - smoothstep(0.0, 1.0, d)) * in.color.a;
    return vec4f(in.color.rgb, a);
  } else if (in.style < 3.5) {
    let a = (1. - smoothstep(0.2, 1.0, d)) * in.color.a;
    return vec4f(in.color.rgb, a);
  } else {
    // Water droplet — appearance depends on view
    if (u.view == 1u) {
      // Microscope: barely-there. Just a faint dim ring at the edge — no
      // bright meniscus, no visible interior. Reads like a phase shift, not
      // a literal circle.
      let interior = (1. - smoothstep(0.0, 0.94, d)) * 0.02;
      let rim      = smoothstep(0.94, 0.99, d) * (1. - smoothstep(0.99, 1.0, d)) * 0.18;
      let a = interior + rim;
      return vec4f(0.42, 0.50, 0.58, a);
    }
    // Educational: visible bright meniscus
    let interior  = (1. - smoothstep(0.7, 0.94, d)) * 0.06;
    let meniscus  = smoothstep(0.94, 0.97, d) * (1. - smoothstep(0.97, 0.995, d));
    let halo      = smoothstep(0.96, 1.0, d) * 0.20;
    let a = interior + meniscus * 0.50 + halo;
    let cool = vec3f(0.78, 0.86, 0.94);
    return vec4f(mix(cool, vec3f(0.93, 0.97, 1.0), meniscus), a);
  }
}
`;

// Stretchy membrane segment shader — instance-per-segment, expanded to a quad
// in the vertex shader using a perpendicular vector and per-instance width.
const SHADER_SEG = PRELUDE + `
struct Seg {
  @location(0) p0: vec2f,
  @location(1) p1: vec2f,
  @location(2) width: f32,
  @location(3) color: vec4f,
};

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec4f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, s: Seg) -> VOut {
  let dir   = normalize(s.p1 - s.p0);
  let perp  = vec2f(-dir.y, dir.x) * (s.width * 0.5);
  // 6 verts per quad: (p0+perp, p0-perp, p1+perp, p0-perp, p1-perp, p1+perp)
  var idx = array<u32,6>(0u,1u,2u, 1u,3u,2u);
  var p: vec2f;
  let i = idx[vi];
  if (i == 0u) { p = s.p0 + perp; }
  else if (i == 1u) { p = s.p0 - perp; }
  else if (i == 2u) { p = s.p1 + perp; }
  else { p = s.p1 - perp; }
  var o: VOut;
  o.clip  = vec4f(worldToClip(p), 0., 1.);
  o.color = s.color;
  return o;
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  return in.color;
}
`;

// Membrane interior fill — triangle list, with DIC-style linear gradient applied
// in fragment shader using per-vertex bbox+predator hint.
const SHADER_FILL = PRELUDE + `
struct VIn {
  @location(0) pos: vec2f,
  @location(1) bboxMin: vec2f,
  @location(2) bboxMax: vec2f,
  @location(3) flags: f32,    // 0 = prey, 1 = predator
};
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec2f,
  @location(1) bboxMin: vec2f,
  @location(2) bboxMax: vec2f,
  @location(3) flags: f32,
};

@vertex fn vs(in: VIn) -> VOut {
  var o: VOut;
  o.clip = vec4f(worldToClip(in.pos), 0., 1.);
  o.world = in.pos;
  o.bboxMin = in.bboxMin;
  o.bboxMax = in.bboxMax;
  o.flags = in.flags;
  return o;
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let extent = max(in.bboxMax - in.bboxMin, vec2f(1., 1.));
  let t = clamp((in.world - in.bboxMin) / extent, vec2f(0.), vec2f(1.));
  let g = (t.x + t.y) * 0.5;
  var c: vec3f;
  // kind: 0=prey, 1=predator, 2=player
  if (in.flags > 1.5) {
    // Player — greenish-sepia DIC
    if (g < 0.45) { c = mix(vec3f(0.765, 0.863, 0.686), vec3f(0.451, 0.588, 0.373), g/0.45); }
    else          { c = mix(vec3f(0.451, 0.588, 0.373), vec3f(0.118, 0.216, 0.098), (g-0.45)/0.55); }
  } else if (in.flags > 0.5) {
    // Predator — cooler red-shifted sepia
    if (g < 0.45) { c = mix(vec3f(0.824, 0.725, 0.608), vec3f(0.549, 0.412, 0.333), g/0.45); }
    else          { c = mix(vec3f(0.549, 0.412, 0.333), vec3f(0.216, 0.098, 0.078), (g-0.45)/0.55); }
  } else {
    // Prey — neutral sepia
    if (g < 0.45) { c = mix(vec3f(0.882, 0.804, 0.667), vec3f(0.608, 0.510, 0.392), g/0.45); }
    else          { c = mix(vec3f(0.608, 0.510, 0.392), vec3f(0.216, 0.157, 0.098), (g-0.45)/0.55); }
  }
  return vec4f(c, 0.90);
}
`;

const SHADER_VIGNETTE = PRELUDE + `
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 6>(
    vec2f(-1.,-1.), vec2f(1.,-1.), vec2f(1.,1.),
    vec2f(-1.,-1.), vec2f(1.,1.), vec2f(-1.,1.));
  return vec4f(p[vi], 0., 1.);
}
@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let cx = u.resolution * 0.5;
  let d = distance(frag.xy, cx) / (max(u.resolution.x, u.resolution.y) * 0.5);
  if (d < 0.55) { discard; }
  let t = smoothstep(0.55, 1.0, d);
  return vec4f(0., 0., 0., t * 0.55);
}
`;

// ── Pipeline + buffer setup ─────────────────────────────────────────────────
function buildPipelines(device: GPUDevice, format: GPUTextureFormat) {
  const blendOver: GPUBlendState = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };

  const bgModule = device.createShaderModule({ code: SHADER_BG });
  const partModule = device.createShaderModule({ code: SHADER_PARTICLE });
  const segModule = device.createShaderModule({ code: SHADER_SEG });
  const fillModule = device.createShaderModule({ code: SHADER_FILL });
  const vigModule = device.createShaderModule({ code: SHADER_VIGNETTE });

  const bg = device.createRenderPipeline({
    layout: 'auto',
    vertex:   { module: bgModule, entryPoint: 'vs' },
    fragment: { module: bgModule, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });

  const particle = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: partModule, entryPoint: 'vs',
      buffers: [{
        // Stride 32 bytes: pos(8) + radius(4) + styleAlpha(4) + color(16) = 32; we drop styleAlpha and read style as separate (4) → total 40
        // We use: pos(8) + radius(4) + style(4) + color(16) = 32 with packed style.
        arrayStride: 32, stepMode: 'instance',
        attributes: [
          { shaderLocation: 0, offset: 0,  format: 'float32x2' }, // pos
          { shaderLocation: 1, offset: 8,  format: 'float32'   }, // radius
          { shaderLocation: 4, offset: 12, format: 'float32'   }, // style
          { shaderLocation: 3, offset: 16, format: 'float32x4' }, // color rgba
        ],
      }],
    },
    fragment: { module: partModule, entryPoint: 'fs', targets: [{ format, blend: blendOver }] },
    primitive: { topology: 'triangle-list' },
  });

  const seg = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: segModule, entryPoint: 'vs',
      buffers: [{
        arrayStride: 36, stepMode: 'instance',
        attributes: [
          { shaderLocation: 0, offset: 0,  format: 'float32x2' }, // p0
          { shaderLocation: 1, offset: 8,  format: 'float32x2' }, // p1
          { shaderLocation: 2, offset: 16, format: 'float32'   }, // width
          { shaderLocation: 3, offset: 20, format: 'float32x4' }, // color rgba
        ],
      }],
    },
    fragment: { module: segModule, entryPoint: 'fs', targets: [{ format, blend: blendOver }] },
    primitive: { topology: 'triangle-list' },
  });

  const fill = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: fillModule, entryPoint: 'vs',
      buffers: [{
        arrayStride: 28, stepMode: 'vertex',
        attributes: [
          { shaderLocation: 0, offset: 0,  format: 'float32x2' }, // pos
          { shaderLocation: 1, offset: 8,  format: 'float32x2' }, // bboxMin
          { shaderLocation: 2, offset: 16, format: 'float32x2' }, // bboxMax
          { shaderLocation: 3, offset: 24, format: 'float32'   }, // flags
        ],
      }],
    },
    fragment: { module: fillModule, entryPoint: 'fs', targets: [{ format, blend: blendOver }] },
    primitive: { topology: 'triangle-list' },
  });

  const vignette = device.createRenderPipeline({
    layout: 'auto',
    vertex:   { module: vigModule, entryPoint: 'vs' },
    fragment: { module: vigModule, entryPoint: 'fs', targets: [{ format, blend: blendOver }] },
    primitive: { topology: 'triangle-list' },
  });

  return { bg, particle, seg, fill, vignette };
}

function buildBuffers(device: GPUDevice) {
  const uniformBuf = device.createBuffer({
    size: 32, // resolution(8) + view+pad(8) + camera(8) + zoom+pad(8)
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const particleBuf = device.createBuffer({
    size: MAX_ATOMS_GPU * 32,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  const organelleBuf = device.createBuffer({
    size: MAX_ATOMS_GPU * 32,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  const waterBuf = device.createBuffer({
    size: 500 * 32, // up to MAX_DROPLETS instances at 32 bytes each
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  const segBuf = device.createBuffer({
    size: MAX_SEG_INSTANCES * 36,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  const fillBuf = device.createBuffer({
    size: MAX_TRI_VERTS * 28,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  return { uniformBuf, particleBuf, organelleBuf, waterBuf, segBuf, fillBuf };
}

// ── Public init ─────────────────────────────────────────────────────────────
export async function initGPU(canvas: HTMLCanvasElement): Promise<boolean> {
  if (!('gpu' in navigator)) return false;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return false;
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
  if (!ctx) return false;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });
  _device = device;
  _ctx = ctx;
  _format = format;
  _pipelines = buildPipelines(device, format);
  _buffers = buildBuffers(device);
  _canvasW = canvas.width;
  _canvasH = canvas.height;
  return true;
}

// Bind groups cached per pipeline so we don't allocate them every frame.
const _bindCache = new WeakMap<GPURenderPipeline, GPUBindGroup>();
function bindGroupFor(pipeline: GPURenderPipeline): GPUBindGroup {
  let bg = _bindCache.get(pipeline);
  if (!bg) {
    bg = _device!.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: _buffers!.uniformBuf } }],
    });
    _bindCache.set(pipeline, bg);
  }
  return bg;
}

// ── Helpers for loop polygon prep (ported from 2D path) ─────────────────────
function smoothLoopFromIndices(loops: Uint32Array, vertOffset: number, vertCount: number, iters: number, out: Float64Array): void {
  for (let i = 0; i < vertCount; i++) {
    const idx = loops[vertOffset + i];
    out[i * 2]     = _displayX[idx];
    out[i * 2 + 1] = _displayY[idx];
  }
  if (iters <= 0) return;
  let buf: Float64Array = out, next: Float64Array = _ptsB;
  for (let k = 0; k < iters; k++) {
    for (let i = 0; i < vertCount; i++) {
      const prev = (i - 1 + vertCount) % vertCount;
      const nxt  = (i + 1) % vertCount;
      next[i * 2]     = 0.5 * buf[i * 2]     + 0.25 * buf[prev * 2]     + 0.25 * buf[nxt * 2];
      next[i * 2 + 1] = 0.5 * buf[i * 2 + 1] + 0.25 * buf[prev * 2 + 1] + 0.25 * buf[nxt * 2 + 1];
    }
    const tmp = buf; buf = next; next = tmp;
  }
  if (buf !== out) for (let i = 0; i < vertCount * 2; i++) out[i] = buf[i];
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

// Pre-allocated CPU staging
const _particleStage  = new Float32Array(MAX_ATOMS_GPU * 8);
const _organelleStage = new Float32Array(MAX_ATOMS_GPU * 8);
const _waterStage     = new Float32Array(500 * 8);
const _segStage       = new Float32Array(MAX_SEG_INSTANCES * 9);
const _fillStage      = new Float32Array(MAX_TRI_VERTS * 7);

function atomHash32(idx: number, type: number, state: number): number {
  return ((type * 73856093) ^ (state * 19349663) ^ (idx * 83492791)) >>> 0;
}

// ── Main draw ───────────────────────────────────────────────────────────────
export type GPUCamera = { x: number; y: number; zoom: number };

export function drawGPU(
  atoms: Float32Array,
  atomCount: number,
  loops: Uint32Array,
  bonds: Uint32Array,
  droplets: Float32Array,
  bacteriaView: boolean,
  epoch: number,
  camera: GPUCamera,
): void {
  if (!_device || !_ctx || !_pipelines || !_buffers) return;
  const device = _device;
  const ctx = _ctx;

  ensureDisplay(atomCount, epoch);
  smoothPositions(atoms, atomCount);

  const view = ctx.getCurrentTexture().createView();
  const cmd = device.createCommandEncoder();

  // Uniforms: resolution + view + camera + zoom (32 bytes)
  const u = new ArrayBuffer(32);
  const uF = new Float32Array(u);
  const uU = new Uint32Array(u);
  uF[0] = _canvasW; uF[1] = _canvasH;
  uU[2] = bacteriaView ? 1 : 0;
  // _pad0 at uU[3]
  uF[4] = camera.x; uF[5] = camera.y;
  uF[6] = camera.zoom;
  // _pad1 at uF[7]
  device.queue.writeBuffer(_buffers.uniformBuf, 0, u);

  // ── Stage soup particles + organelles ─────────────────────────────────────
  const r = RADIUS * 0.8;
  let pCount = 0; // soup
  let oCount = 0; // organelle/colored

  for (let i = 0; i < atomCount; i++) {
    const o = i * STRIDE;
    const flags = atoms[o + 3] | 0;
    const isMembrane = (flags & 4) !== 0;
    if (isMembrane) continue;
    const state = unpackState(atoms[o + 2]);
    const type  = unpackType(atoms[o + 2]);
    const px = _displayX[i], py = _displayY[i];
    const isFree = state === 0;

    if (isFree) {
      // Soup particle
      const so = pCount * 8;
      if (bacteriaView) {
        const h = atomHash32(i, type, state);
        const sizeMul = 0.25 + (h % 600) / 1000;
        const pr = r * sizeMul;
        const isBubble = (h >>> 20) % 3 === 0;
        _particleStage[so + 0] = px;
        _particleStage[so + 1] = py;
        _particleStage[so + 2] = pr;
        _particleStage[so + 3] = isBubble ? 1.0 : 2.0; // 1=bubble, 2=soft blob
        if (isBubble) { _particleStage[so + 4] = 0.235; _particleStage[so + 5] = 0.176; _particleStage[so + 6] = 0.118; _particleStage[so + 7] = 0.28; }
        else          { _particleStage[so + 4] = 0.314; _particleStage[so + 5] = 0.235; _particleStage[so + 6] = 0.157; _particleStage[so + 7] = 0.20; }
      } else {
        // Educational: hard-edged colored disc, full size
        const ch = String.fromCharCode(type);
        const c = colorFor(ch);
        _particleStage[so + 0] = px;
        _particleStage[so + 1] = py;
        _particleStage[so + 2] = r;
        _particleStage[so + 3] = 0.0;  // hard disc
        _particleStage[so + 4] = c[0]; _particleStage[so + 5] = c[1]; _particleStage[so + 6] = c[2];
        _particleStage[so + 7] = ch === 'p' ? 0.34 : 0.10;
      }
      pCount++;
    } else {
      // Active organelle / colored atom
      const h = atomHash32(i, type, state);
      const sizeMul = 1.1 + (h % 900) / 1000;
      const pr = r * sizeMul;
      const so = oCount * 8;
      _organelleStage[so + 0] = px;
      _organelleStage[so + 1] = py;
      _organelleStage[so + 2] = pr;
      if (bacteriaView) {
        const ch = String.fromCharCode(type);
        const isDense = ch === 'd' || ch === 'e' || ch === 'f';
        const isBonded = (flags & 1) !== 0;
        _organelleStage[so + 3] = 2.0; // organelle blob style
        if (!isBonded) { _organelleStage[so + 4] = 0.275; _organelleStage[so + 5] = 0.216; _organelleStage[so + 6] = 0.157; _organelleStage[so + 7] = 0.38; }
        else if (isDense) { _organelleStage[so + 4] = 0.086; _organelleStage[so + 5] = 0.051; _organelleStage[so + 6] = 0.024; _organelleStage[so + 7] = 0.80; }
        else              { _organelleStage[so + 4] = 0.204; _organelleStage[so + 5] = 0.141; _organelleStage[so + 6] = 0.071; _organelleStage[so + 7] = 0.65; }
      } else {
        const ch = String.fromCharCode(type);
        const c = colorFor(ch);
        _organelleStage[so + 3] = 0.0; // soft blob
        _organelleStage[so + 4] = c[0]; _organelleStage[so + 5] = c[1]; _organelleStage[so + 6] = c[2];
        _organelleStage[so + 7] = 0.80;
      }
      oCount++;
    }
    if (pCount >= MAX_ATOMS_GPU || oCount >= MAX_ATOMS_GPU) break;
  }
  if (pCount > 0) device.queue.writeBuffer(_buffers.particleBuf, 0, _particleStage.buffer, 0, pCount * 32);
  if (oCount > 0) device.queue.writeBuffer(_buffers.organelleBuf, 0, _organelleStage.buffer, 0, oCount * 32);

  // Stage water droplets — same instance layout as particles, style=4
  const dropCount = Math.min(droplets[0] | 0, 500);
  for (let i = 0; i < dropCount; i++) {
    const so = i * 8;
    _waterStage[so + 0] = droplets[1 + i * 3];
    _waterStage[so + 1] = droplets[2 + i * 3];
    _waterStage[so + 2] = droplets[3 + i * 3];
    _waterStage[so + 3] = 4.0; // water style
    _waterStage[so + 4] = 0.78; _waterStage[so + 5] = 0.86; _waterStage[so + 6] = 0.94;
    _waterStage[so + 7] = 1.0;
  }
  if (dropCount > 0) device.queue.writeBuffer(_buffers.waterBuf, 0, _waterStage.buffer, 0, dropCount * 32);

  // ── Stage cell membrane fills + outlines ──────────────────────────────────
  const loopSmoothing = bacteriaView ? LOOP_SMOOTH_MICRO : LOOP_SMOOTH_EDU;
  const loopInflate   = bacteriaView ? LOOP_INFLATE_MICRO : 0;
  const loopCount = loops[0];

  let fillVerts = 0;
  let segCount  = 0;
  let cursor = 1;

  for (let li = 0; li < loopCount; li++) {
    const vertCount = loops[cursor++];
    const kind      = loops[cursor++] | 0;  // 0=prey, 1=predator, 2=player
    const vertOffset = cursor;
    cursor += vertCount;
    if (vertCount > MAX_LOOP || vertCount < 3) continue;

    smoothLoopFromIndices(loops, vertOffset, vertCount, loopSmoothing, _ptsA);
    inflateLoop(_ptsA, vertCount, loopInflate);

    // Compute bbox + centroid
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let cx = 0, cy = 0;
    for (let i = 0; i < vertCount; i++) {
      const x = _ptsA[i * 2], y = _ptsA[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      cx += x; cy += y;
    }
    cx /= vertCount; cy /= vertCount;

    // Triangle fan from centroid (works for star-convex polygons; cells qualify)
    if (fillVerts + vertCount * 3 < MAX_TRI_VERTS) {
      for (let i = 0; i < vertCount; i++) {
        const j = (i + 1) % vertCount;
        const ax = _ptsA[i * 2], ay = _ptsA[i * 2 + 1];
        const bx = _ptsA[j * 2], by = _ptsA[j * 2 + 1];
        const v0 = fillVerts * 7;
        // tri: (cx,cy), (ax,ay), (bx,by)
        _fillStage[v0 + 0] = cx;   _fillStage[v0 + 1] = cy;
        _fillStage[v0 + 2] = minX; _fillStage[v0 + 3] = minY;
        _fillStage[v0 + 4] = maxX; _fillStage[v0 + 5] = maxY;
        _fillStage[v0 + 6] = kind;
        const v1 = (fillVerts + 1) * 7;
        _fillStage[v1 + 0] = ax;   _fillStage[v1 + 1] = ay;
        _fillStage[v1 + 2] = minX; _fillStage[v1 + 3] = minY;
        _fillStage[v1 + 4] = maxX; _fillStage[v1 + 5] = maxY;
        _fillStage[v1 + 6] = kind;
        const v2 = (fillVerts + 2) * 7;
        _fillStage[v2 + 0] = bx;   _fillStage[v2 + 1] = by;
        _fillStage[v2 + 2] = minX; _fillStage[v2 + 3] = minY;
        _fillStage[v2 + 4] = maxX; _fillStage[v2 + 5] = maxY;
        _fillStage[v2 + 6] = kind;
        fillVerts += 3;
      }
    }

    // Stretchy segments — microscope uses stretch-bucketed layered DIC outline,
    // educational uses uniform 2.5-px stroke. Both tessellate the per-atom
    // quadratic bezier (as the 2D path does via traceSmoothLoop) so the
    // outline reads as a smooth curve, not a polygon of straight sides.
    if (bacteriaView) {
      let total = 0;
      for (let i = 0; i < vertCount; i++) {
        const j = (i + 1) % vertCount;
        const dx = _ptsA[j * 2] - _ptsA[i * 2];
        const dy = _ptsA[j * 2 + 1] - _ptsA[i * 2 + 1];
        const d = Math.sqrt(dx * dx + dy * dy);
        _ptsB[i] = d; total += d;
      }
      const mean = total / vertCount || 1;

      const isPlayer = kind === 2;
      for (let layer = 0; layer < 3; layer++) {
        const offX = layer === 0 ? 1.2 : (layer === 1 ? -1.0 : 0);
        const offY = layer === 0 ? 1.2 : (layer === 1 ? -1.0 : 0);
        let baseW: number, baseR: number, baseG: number, baseB: number, baseA: number;
        if (layer === 0)      { baseW = 1.1; baseR = (isPlayer ? 12 : 20)/255; baseG = (isPlayer ? 30 : 12)/255; baseB = (isPlayer ? 14 : 6)/255;   baseA = 0.55; }
        else if (layer === 1) { baseW = 0.8; baseR = 255/255; baseG = 245/255; baseB = 215/255; baseA = 0.65; }
        else                  { baseW = 0.65; baseR = (isPlayer ? 22 : 35)/255; baseG = (isPlayer ? 60 : 22)/255; baseB = (isPlayer ? 28 : 12)/255;  baseA = 0.70; }

        for (let i = 0; i < vertCount; i++) {
          const stretch = _ptsB[i] / mean;
          const segT = Math.max(0, Math.min(1, (stretch - 0.6) / 1.2));
          const widthMul = 1.5 - segT * 1.2;
          const alphaMul = 1.0 - segT * 0.72;
          tessellateBezier(i, vertCount, _ptsA, offX, offY,
            baseW * widthMul, baseR, baseG, baseB, baseA * alphaMul);
        }
      }
    } else {
      // Educational outline: prey yellow, predator red, player cyan-green
      let cR: number, cG: number, cB: number;
      if      (kind === 1) { cR = 200/255; cG = 30/255;  cB = 0;       }
      else if (kind === 2) { cR = 50/255;  cG = 220/255; cB = 160/255; }
      else                 { cR = 200/255; cG = 168/255; cB = 0;       }
      for (let i = 0; i < vertCount; i++) {
        tessellateBezier(i, vertCount, _ptsA, 0, 0, 2.5, cR, cG, cB, 0.92);
      }
    }
  }

  // Bezier helper closes over segCount/_segStage so it stays inside drawGPU.
  function tessellateBezier(
    i: number, vertCount: number, pts: Float64Array,
    offX: number, offY: number,
    width: number, R: number, G: number, B: number, A: number,
  ): void {
    const TESS = 5; // straight segments per bezier curve
    const prev = (i - 1 + vertCount) % vertCount;
    const next = (i + 1) % vertCount;
    const sx = (pts[prev * 2]     + pts[i * 2])     * 0.5;
    const sy = (pts[prev * 2 + 1] + pts[i * 2 + 1]) * 0.5;
    const cx = pts[i * 2];
    const cy = pts[i * 2 + 1];
    const ex = (pts[i * 2]     + pts[next * 2])     * 0.5;
    const ey = (pts[i * 2 + 1] + pts[next * 2 + 1]) * 0.5;
    let prevX = sx, prevY = sy;
    for (let k = 1; k <= TESS; k++) {
      const t = k / TESS;
      const u = 1 - t;
      const x = u * u * sx + 2 * u * t * cx + t * t * ex;
      const y = u * u * sy + 2 * u * t * cy + t * t * ey;
      if (segCount >= MAX_SEG_INSTANCES) return;
      const so = segCount * 9;
      _segStage[so + 0] = prevX + offX;
      _segStage[so + 1] = prevY + offY;
      _segStage[so + 2] = x     + offX;
      _segStage[so + 3] = y     + offY;
      _segStage[so + 4] = width;
      _segStage[so + 5] = R; _segStage[so + 6] = G; _segStage[so + 7] = B; _segStage[so + 8] = A;
      segCount++;
      prevX = x; prevY = y;
    }
  }

  // ── Stage open membrane chains + non-membrane bond network ────────────────
  // Build inLoop bit-vector
  const inLoop = new Uint8Array(atomCount);
  {
    let c2 = 1;
    for (let li = 0; li < loops[0]; li++) {
      const vc = loops[c2++];
      c2 += 1; // kind
      for (let i = 0; i < vc; i++) inLoop[loops[c2 + i]] = 1;
      c2 += vc;
    }
  }

  const bondCount = bonds[0];
  for (let bi = 0; bi < bondCount; bi++) {
    if (segCount >= MAX_SEG_INSTANCES) break;
    const ai = bonds[1 + bi * 2];
    const bj = bonds[2 + bi * 2];
    const af = atoms[ai * STRIDE + 3] | 0;
    const bf = atoms[bj * STRIDE + 3] | 0;
    const aIsMem = (af & 4) !== 0;
    const bIsMem = (bf & 4) !== 0;
    const aIsPred = (af & 2) !== 0;
    const bIsPred = (bf & 2) !== 0;

    let baseW = 0, R = 0, G = 0, B = 0, A = 0;
    if (aIsMem && bIsMem) {
      // Membrane bond — draw only if NOT both endpoints in a closed loop.
      if (inLoop[ai] && inLoop[bj]) continue;
      const isPredBond = aIsPred || bIsPred;
      if (bacteriaView) {
        if (isPredBond) { baseW = 1.0; R = 60/255;  G = 25/255;  B = 20/255;  A = 0.85; }
        else            { baseW = 1.0; R = 50/255;  G = 40/255;  B = 30/255;  A = 0.78; }
      } else {
        if (isPredBond) { baseW = 2.5; R = 200/255; G = 30/255;  B = 0/255;   A = 0.92; }
        else            { baseW = 2.5; R = 200/255; G = 168/255; B = 0/255;   A = 0.92; }
      }
    } else {
      // Non-membrane bond — only drawn in educational view
      if (bacteriaView) continue;
      baseW = 1.0; R = 0; G = 0; B = 0; A = 0.22;
    }

    const so = segCount * 9;
    _segStage[so + 0] = _displayX[ai];
    _segStage[so + 1] = _displayY[ai];
    _segStage[so + 2] = _displayX[bj];
    _segStage[so + 3] = _displayY[bj];
    _segStage[so + 4] = baseW;
    _segStage[so + 5] = R;
    _segStage[so + 6] = G;
    _segStage[so + 7] = B;
    _segStage[so + 8] = A;
    segCount++;
  }

  if (fillVerts > 0) device.queue.writeBuffer(_buffers.fillBuf, 0, _fillStage.buffer, 0, fillVerts * 28);
  if (segCount  > 0) device.queue.writeBuffer(_buffers.segBuf,  0, _segStage.buffer,  0, segCount  * 36);

  // ── Render passes ─────────────────────────────────────────────────────────
  const pass = cmd.beginRenderPass({
    colorAttachments: [{ view, clearValue: { r: 1, g: 1, b: 1, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
  });

  // 1. Background
  pass.setPipeline(_pipelines.bg);
  pass.setBindGroup(0, bindGroupFor(_pipelines.bg));
  pass.draw(6);

  // 1b. Water droplets — drawn before atoms so atoms appear ON TOP of water
  if (dropCount > 0) {
    pass.setPipeline(_pipelines.particle);
    pass.setBindGroup(0, bindGroupFor(_pipelines.particle));
    pass.setVertexBuffer(0, _buffers.waterBuf);
    pass.draw(6, dropCount);
  }

  // 2. Cell fills — only in microscope view (DIC fill is the look). Educational
  //    mode previously used a barely-visible 0.07 alpha tint — skipping reads
  //    near-identically without introducing a second fill shader.
  if (bacteriaView && fillVerts > 0) {
    pass.setPipeline(_pipelines.fill);
    pass.setBindGroup(0, bindGroupFor(_pipelines.fill));
    pass.setVertexBuffer(0, _buffers.fillBuf);
    pass.draw(fillVerts);
  }

  // 3. Soup particles (instanced)
  if (pCount > 0) {
    pass.setPipeline(_pipelines.particle);
    pass.setBindGroup(0, bindGroupFor(_pipelines.particle));
    pass.setVertexBuffer(0, _buffers.particleBuf);
    pass.draw(6, pCount);
  }

  // 4. Membrane segments (instanced)
  if (segCount > 0) {
    pass.setPipeline(_pipelines.seg);
    pass.setBindGroup(0, bindGroupFor(_pipelines.seg));
    pass.setVertexBuffer(0, _buffers.segBuf);
    pass.draw(6, segCount);
  }

  // 5. Organelle blobs (instanced)
  if (oCount > 0) {
    pass.setPipeline(_pipelines.particle);
    pass.setBindGroup(0, bindGroupFor(_pipelines.particle));
    pass.setVertexBuffer(0, _buffers.organelleBuf);
    pass.draw(6, oCount);
  }

  // 6. Vignette (microscope only)
  if (bacteriaView) {
    pass.setPipeline(_pipelines.vignette);
    pass.setBindGroup(0, bindGroupFor(_pipelines.vignette));
    pass.draw(6);
  }

  pass.end();
  device.queue.submit([cmd.finish()]);
}

function colorFor(type: string): [number, number, number] {
  switch (type) {
    case 'e': return [1.0, 0.2, 0.2];
    case 'f': return [0.2, 1.0, 0.2];
    case 'b': return [0.533, 0.533, 0.533];
    case 'c': return [0.0, 0.867, 0.867];
    case 'd': return [0.2, 0.4, 1.0];
    case 'p': return [1.0, 0.467, 0.0];
    default:  return [1.0, 0.2, 0.2];
  }
}

// silence unused-warning so noUnusedLocals doesn't complain
void _format;
