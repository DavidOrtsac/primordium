import { Cell, RADIUS } from './cell';
import { Q } from './init';

const CELL_COLORS: Record<string, string> = {
  e: '#ff3333',   // red    — genome start marker
  f: '#33ff33',   // green  — genome end marker
  b: '#888888',   // gray   — genome base B
  c: '#00dddd',   // cyan   — genome base C
  d: '#3366ff',   // blue   — enzyme (walks the gene during replication)
  p: '#ff7700',   // orange — lysin (catalyzes membrane dissolution)
};

const LEGEND: { color: string; label: string; isLine?: boolean }[] = [
  { color: '#c8a800', label: 'a  prey membrane (bond line)',     isLine: true },
  { color: '#c81e00', label: 'a  predator membrane (bond line)', isLine: true },
  { color: '#888888', label: 'b  genome base' },
  { color: '#00dddd', label: 'c  genome base' },
  { color: '#3366ff', label: 'd  enzyme (mid-walk = bouncing)' },
  { color: '#ff3333', label: 'e  genome start' },
  { color: '#33ff33', label: 'f  genome end' },
  { color: '#ff7700', label: 'p  lysin (dissolves membranes)' },
];

function cellColor(type: string): string {
  return CELL_COLORS[type] ?? '#ff3333';
}

function isMembraneAtom(cell: Cell): boolean {
  return cell.type === 'a';
}

function isPredatorMem(cell: Cell): boolean {
  return cell.type === 'a' && cell.state >= Q;
}

// EMA factor — higher = snappier (less smoothing), lower = smoother (more lag).
// Membranes use a slower EMA than free atoms so cell walls glide gracefully
// while soup particles still feel alive and reactive.
const DISPLAY_EMA_DEFAULT   = 0.28; // ≈ 3-frame visual lag for free atoms
const DISPLAY_EMA_ORGANELLE = 0.07; // ≈ 14-frame lag for cytoplasm contents — drift, not dash
const DISPLAY_EMA_MEMBRANE  = 0.12; // ≈ 8-frame lag for cell walls — visibly calmer
const TELEPORT_THRESHOLD2 = 400;

function updateDisplayPositions(cells: Cell[]): void {
  for (const c of cells) {
    if (!c.displayInit) {
      c.displayX = c.loc.x;
      c.displayY = c.loc.y;
      c.displayInit = true;
      continue;
    }
    const dx = c.loc.x - c.displayX;
    const dy = c.loc.y - c.displayY;
    if (dx * dx + dy * dy > TELEPORT_THRESHOLD2) {
      c.displayX = c.loc.x;
      c.displayY = c.loc.y;
    } else {
      const ema = c.type === 'a'
        ? DISPLAY_EMA_MEMBRANE
        : (c.bonds.size > 0 ? DISPLAY_EMA_ORGANELLE : DISPLAY_EMA_DEFAULT);
      c.displayX += dx * ema;
      c.displayY += dy * ema;
    }
  }
}

// Bounding box of a loop in canvas pixels — used for DIC-style gradient anchoring.
function loopBounds(loop: Cell[], scale: number): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of loop) {
    const x = c.displayX * scale;
    const y = c.displayY * scale;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

// Spatial Laplacian smoothing of a closed loop's display positions. Each pass:
// p[i] ← 0.5·p[i] + 0.25·p[i-1] + 0.25·p[i+1]. After K iterations the polygon
// converges toward its average shape — capsules turn into capsules, lopsided
// blobs round out, but the loop never collapses to a point because endpoints
// wrap. Underlying atom positions (cell.loc / displayX/Y) are NEVER modified.
function smoothLoopPositions(loop: Cell[], iterations: number): Float64Array {
  const n = loop.length;
  let buf = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    buf[i * 2]     = loop[i].displayX;
    buf[i * 2 + 1] = loop[i].displayY;
  }
  if (iterations <= 0) return buf;

  let next = new Float64Array(n * 2);
  for (let k = 0; k < iterations; k++) {
    for (let i = 0; i < n; i++) {
      const prev = (i - 1 + n) % n;
      const nxt  = (i + 1) % n;
      next[i * 2]     = 0.5 * buf[i * 2]     + 0.25 * buf[prev * 2]     + 0.25 * buf[nxt * 2];
      next[i * 2 + 1] = 0.5 * buf[i * 2 + 1] + 0.25 * buf[prev * 2 + 1] + 0.25 * buf[nxt * 2 + 1];
    }
    [buf, next] = [next, buf];
  }
  return buf;
}

// Quadratic bezier through atom midpoints — smooth closed polygon from discrete chain.
// Control points = atom positions; on-curve points = midpoints between atoms.
// inflate: grid units to push each point outward from the loop centroid (0 = no change).
function traceSmoothLoop(
  ctx: CanvasRenderingContext2D,
  loop: Cell[],
  scale: number,
  smoothing = 0,
  inflate = 0,
): void {
  const n = loop.length;
  const pts = smoothLoopPositions(loop, smoothing);

  if (inflate !== 0) {
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += pts[i * 2]; cy += pts[i * 2 + 1]; }
    cx /= n; cy /= n;
    for (let i = 0; i < n; i++) {
      const dx = pts[i * 2] - cx, dy = pts[i * 2 + 1] - cy;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      pts[i * 2]     += (dx / len) * inflate;
      pts[i * 2 + 1] += (dy / len) * inflate;
    }
  }

  const lastX = pts[(n - 1) * 2], lastY = pts[(n - 1) * 2 + 1];
  const firstX = pts[0],          firstY = pts[1];
  ctx.moveTo(((lastX + firstX) / 2) * scale, ((lastY + firstY) / 2) * scale);
  for (let i = 0; i < n; i++) {
    const curX  = pts[i * 2];
    const curY  = pts[i * 2 + 1];
    const nxt   = (i + 1) % n;
    const nxtX  = pts[nxt * 2];
    const nxtY  = pts[nxt * 2 + 1];
    ctx.quadraticCurveTo(
      curX * scale, curY * scale,
      ((curX + nxtX) / 2) * scale,
      ((curY + nxtY) / 2) * scale,
    );
  }
  ctx.closePath();
}

// Draw a membrane loop where each segment's lineWidth and opacity scale with
// how stretched it is relative to the loop's mean segment length.
// Segments are batched into BUCKETS style groups to minimise GPU draw calls.
function drawStretchyLoop(
  ctx: CanvasRenderingContext2D,
  loop: Cell[],
  scale: number,
  smoothing: number,
  inflate: number,
  baseWidth: number,
  baseRgb: [number, number, number],
  baseAlpha: number,
): void {
  const BUCKETS = 4;
  const n = loop.length;
  const pts = smoothLoopPositions(loop, smoothing);

  if (inflate !== 0) {
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += pts[i * 2]; cy += pts[i * 2 + 1]; }
    cx /= n; cy /= n;
    for (let i = 0; i < n; i++) {
      const dx = pts[i * 2] - cx, dy = pts[i * 2 + 1] - cy;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      pts[i * 2]     += (dx / len) * inflate;
      pts[i * 2 + 1] += (dy / len) * inflate;
    }
  }

  // Compute per-segment lengths and mean
  const segs = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = pts[j * 2] - pts[i * 2], dy = pts[j * 2 + 1] - pts[i * 2 + 1];
    segs[i] = Math.sqrt(dx * dx + dy * dy);
    total += segs[i];
  }
  const mean = total / n || 1;

  // Bucket each segment by stretch level, then draw all segments in a bucket
  // as one path to keep draw calls low.
  for (let b = 0; b < BUCKETS; b++) {
    const t = (b + 0.5) / BUCKETS;           // 0 = compressed end, 1 = stretched end
    const widthMul  = 1.5 - t * 1.2;         // 1.5 (compressed) → 0.3 (very stretched)
    const alphaMul  = 1.0 - t * 0.72;        // 1.0 → 0.28
    const [r, g, bl] = baseRgb;

    let drew = false;
    ctx.lineWidth   = baseWidth * widthMul;
    ctx.strokeStyle = `rgba(${r},${g},${bl},${(baseAlpha * alphaMul).toFixed(2)})`;
    ctx.beginPath();

    for (let i = 0; i < n; i++) {
      const stretch = segs[i] / mean;
      // Map stretch to t: [0.6 … 1.8] → [0 … 1]
      const segT  = Math.max(0, Math.min(1, (stretch - 0.6) / 1.2));
      const bucket = Math.min(BUCKETS - 1, Math.floor(segT * BUCKETS));
      if (bucket !== b) continue;

      const prevI = (i - 1 + n) % n;
      const j     = (i + 1) % n;
      const mPrevX = (pts[prevI * 2]     + pts[i * 2])     / 2;
      const mPrevY = (pts[prevI * 2 + 1] + pts[i * 2 + 1]) / 2;
      const mNextX = (pts[i * 2]     + pts[j * 2])     / 2;
      const mNextY = (pts[i * 2 + 1] + pts[j * 2 + 1]) / 2;

      ctx.moveTo(mPrevX * scale, mPrevY * scale);
      ctx.quadraticCurveTo(pts[i * 2] * scale, pts[i * 2 + 1] * scale, mNextX * scale, mNextY * scale);
      drew = true;
    }
    if (drew) ctx.stroke();
  }
}

// Walk bond chains to find closed membrane loops.
// Only follows 'a'→'a' bonds so gene attachments don't break the traversal.
function findMembraneLoops(cells: Cell[]): { loop: Cell[]; isPredator: boolean }[] {
  const visited = new Set<Cell>();
  const result: { loop: Cell[]; isPredator: boolean }[] = [];

  for (const start of cells) {
    if (start.type !== 'a' || visited.has(start)) continue;

    // Find two 'a'-type bond neighbors without spreading the Set
    let first: Cell | undefined, second: Cell | undefined;
    for (const b of start.bonds) {
      if (b.type !== 'a') continue;
      if (!first) first = b; else { second = b; break; }
    }
    if (!first || !second) continue;

    const chain: Cell[] = [start];
    let prev = start;
    let curr = first;

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
      chain.forEach(c => visited.add(c));
      result.push({ loop: chain, isPredator: chain[0].state >= Q });
    }
  }

  return result;
}

// Cheap deterministic per-atom hash so each organelle stays visually consistent
// across frames (no flickering shape). Uses the atom's identity, not its
// position, so the blob "follows" the atom as it moves.
function atomHash(cell: Cell): number {
  // Mix type char code, state, and a stable identity proxy (initial position
  // baked into displayInit). Cheap and stable.
  return (cell.type.charCodeAt(0) * 73856093) ^ (cell.state * 19349663);
}

// Draw all active non-membrane atoms individually in microscope mode.
// Each atom gets a stable per-identity size jitter (0.5×–2.0×) so the
// population looks biological — a mix of small granules and large inclusions.
function drawOrganelles(
  ctx: CanvasRenderingContext2D,
  cells: Cell[],
  scale: number,
  r: number,
): void {
  for (const cell of cells) {
    if (cell.state === 0 || isMembraneAtom(cell)) continue;

    const h = atomHash(cell);
    // Size varies 0.5×–2.0× base radius, stable per atom identity
    const sizeMul = 1.1 + ((h >>> 0) % 900) / 1000;
    const blobR   = r * sizeMul;

    const px = cell.displayX * scale;
    const py = cell.displayY * scale;

    const grad = ctx.createRadialGradient(px, py, 0, px, py, blobR);
    const isDense = cell.type === 'd' || cell.type === 'e' || cell.type === 'f';
    if (isDense) {
      grad.addColorStop(0,    'rgba(22, 13,  6, 0.80)');
      grad.addColorStop(0.45, 'rgba(45, 28, 14, 0.45)');
      grad.addColorStop(1,    'rgba(70, 50, 30, 0.00)');
    } else if (cell.bonds.size > 0) {
      grad.addColorStop(0,    'rgba(52, 36, 18, 0.65)');
      grad.addColorStop(0.55, 'rgba(70, 52, 32, 0.30)');
      grad.addColorStop(1,    'rgba(80, 62, 40, 0.00)');
    } else {
      // Free debris — fainter
      grad.addColorStop(0,   'rgba(70, 55, 40, 0.38)');
      grad.addColorStop(0.7, 'rgba(70, 55, 40, 0.07)');
      grad.addColorStop(1,   'rgba(70, 55, 40, 0.00)');
    }

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, blobR, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function draw(
  ctx: CanvasRenderingContext2D,
  cells: Cell[],
  scale: number,
  bacteriaView = false,
): void {
  const { canvas } = ctx;
  if (bacteriaView) {
    // Microscope slide: gentle radial gradient mimics condenser-lens illumination
    // falling off toward the edges, even before the CSS vignette layers on.
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

  // Update render-only smoothed positions before drawing anything
  updateDisplayPositions(cells);

  const r = scale * RADIUS * 0.8; // circle radius

  // Compute loops once — used for fill, smooth outline, and open-chain fallback
  const loops = findMembraneLoops(cells);
  const inClosedLoop = new Set<Cell>();
  for (const { loop } of loops) for (const c of loop) inClosedLoop.add(c);

  // ── Pass 0: membrane interior shading (smooth bezier fill) ──────────────
  // Microscope view uses DIC-style directional gradient: each cell is lit from
  // upper-left and shaded toward lower-right, producing the pseudo-3D embossed
  // relief of real Nomarski differential interference contrast imaging.
  // Loop smoothing: heavy in microscope (capsule shape), light in educational.
  const loopSmoothing = bacteriaView ? 5 : 1;
  const loopInflate   = bacteriaView ? 2.2 : 0;
  for (const { loop, isPredator } of loops) {
    ctx.beginPath();
    traceSmoothLoop(ctx, loop, scale, loopSmoothing, loopInflate);
    if (bacteriaView) {
      const b = loopBounds(loop, scale);
      // Stretch the gradient slightly past the bounds so the highlight/shadow
      // actually peak inside the cell instead of clipping at its edges
      const pad = 8;
      const grad = ctx.createLinearGradient(
        b.minX - pad, b.minY - pad,
        b.maxX + pad, b.maxY + pad,
      );
      if (isPredator) {
        // Predator cells: cooler sepia, slightly red-shifted in the shadow
        grad.addColorStop(0,    'rgba(210, 185, 155, 0.90)');
        grad.addColorStop(0.45, 'rgba(140, 105,  85, 0.85)');
        grad.addColorStop(1,    'rgba( 55,  25,  20, 0.92)');
      } else {
        grad.addColorStop(0,    'rgba(225, 205, 170, 0.90)');
        grad.addColorStop(0.45, 'rgba(155, 130, 100, 0.85)');
        grad.addColorStop(1,    'rgba( 55,  40,  25, 0.92)');
      }
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = isPredator ? 'rgba(200, 30, 0, 0.07)' : 'rgba(200, 168, 0, 0.07)';
    }
    ctx.fill();
  }

  // ── Pass 1: free non-membrane atoms (state 0) — faint background soup ──
  for (const cell of cells) {
    if (cell.state !== 0 || isMembraneAtom(cell)) continue;
    if (bacteriaView) {
      const h = atomHash(cell);
      const pr = r * (0.25 + ((h >>> 0) % 600) / 1000); // 0.25×–0.85× size variance
      const px = cell.displayX * scale;
      const py = cell.displayY * scale;
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, Math.PI * 2);
      if ((h >>> 20) % 3 === 0) {
        // ~33% rendered as hollow bubbles
        ctx.strokeStyle = 'rgba(60, 45, 30, 0.28)';
        ctx.lineWidth = 0.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(80, 60, 40, 0.20)';
        ctx.fill();
      }
    } else {
      const alpha = cell.type === 'p' ? '55' : '1a';
      ctx.fillStyle = cellColor(cell.type) + alpha;
      ctx.beginPath();
      ctx.arc(cell.displayX * scale, cell.displayY * scale, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Pass 2: membrane outlines ────────────────────────────────────────────
  ctx.lineJoin = 'round';

  if (bacteriaView) {
    // DIC double-pass: shadow rim offset toward lower-right, highlight rim
    // offset toward upper-left. This cheap trick reads as 3D embossing — the
    // same illusion DIC microscopes produce with Wollaston prisms.
    for (const { loop } of loops) {
      // Shadow rim — stretched segments go thin and faint
      ctx.save();
      ctx.translate(1.2, 1.2);
      drawStretchyLoop(ctx, loop, scale, loopSmoothing, loopInflate, 1.1, [20, 12, 6],   0.55);
      ctx.restore();

      // Highlight rim
      ctx.save();
      ctx.translate(-1.0, -1.0);
      drawStretchyLoop(ctx, loop, scale, loopSmoothing, loopInflate, 0.8, [255, 245, 215], 0.65);
      ctx.restore();

      // Body outline
      drawStretchyLoop(ctx, loop, scale, loopSmoothing, loopInflate, 0.65, [35, 22, 12],  0.70);
    }
  } else {
    ctx.lineWidth = 2.5;
    for (const { loop, isPredator } of loops) {
      ctx.strokeStyle = isPredator ? 'rgba(200, 30, 0, 0.92)' : 'rgba(200, 168, 0, 0.92)';
      ctx.beginPath();
      traceSmoothLoop(ctx, loop, scale, loopSmoothing);
      ctx.stroke();
    }
  }

  // Open chains (mid-division / torn): straight bonds for atoms not in a closed loop
  ctx.beginPath();
  ctx.strokeStyle = bacteriaView ? 'rgba(50, 40, 30, 0.78)' : 'rgba(200, 168, 0, 0.92)';
  for (const cell of cells) {
    if (!isMembraneAtom(cell) || isPredatorMem(cell) || inClosedLoop.has(cell)) continue;
    for (const other of cell.bonds) {
      if (other > cell || !isMembraneAtom(other) || isPredatorMem(other)) continue;
      ctx.moveTo(cell.displayX * scale, cell.displayY * scale);
      ctx.lineTo(other.displayX * scale, other.displayY * scale);
    }
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.strokeStyle = bacteriaView ? 'rgba(60, 25, 20, 0.85)' : 'rgba(200, 30, 0, 0.92)';
  for (const cell of cells) {
    if (!isPredatorMem(cell) || inClosedLoop.has(cell)) continue;
    for (const other of cell.bonds) {
      if (other > cell || !isMembraneAtom(other)) continue;
      ctx.moveTo(cell.displayX * scale, cell.displayY * scale);
      ctx.lineTo(other.displayX * scale, other.displayY * scale);
    }
  }
  ctx.stroke();

  // All other bonds: thin dark lines (skipped entirely in bacteria-view —
  // the cytoplasm haze hides the wireframe of the gene strand)
  if (!bacteriaView) {
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const cell of cells) {
      for (const other of cell.bonds) {
        if (other > cell) continue;
        if (isMembraneAtom(cell) && isMembraneAtom(other)) continue; // already drawn
        ctx.moveTo(cell.displayX * scale, cell.displayY * scale);
        ctx.lineTo(other.displayX * scale, other.displayY * scale);
      }
    }
    ctx.stroke();
  }

  // ── Pass 3: active non-membrane atoms ────────────────────────────────────
  if (bacteriaView) {
    drawOrganelles(ctx, cells, scale, r);
  } else {
    for (const cell of cells) {
      if (cell.state === 0 || isMembraneAtom(cell)) continue;
      ctx.fillStyle = cellColor(cell.type) + 'cc';
      ctx.beginPath();
      ctx.arc(cell.displayX * scale, cell.displayY * scale, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function drawHUD(
  ctx: CanvasRenderingContext2D,
  iterations: number,
  cells: Cell[],
): void {
  const bonded = cells.filter(c => c.bonds.size > 0).length;

  // ── Stats ────────────────────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(6, 6, 220, 42);
  ctx.fillStyle = '#ffffff';
  ctx.font = '12px monospace';
  ctx.fillText(`iter:   ${iterations.toLocaleString()}`, 14, 22);
  ctx.fillText(`bonded: ${bonded}   free: ${cells.length - bonded}`, 14, 38);

  // ── Legend ───────────────────────────────────────────────────────────────
  const PAD = 10;
  const SZ  = 10;
  const ROW = 18;
  const W   = 240;
  const H   = PAD * 2 + LEGEND.length * ROW - 2;
  const lx  = 6;
  const ly  = 56;

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
