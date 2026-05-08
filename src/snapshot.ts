// Snapshot protocol shared between physics worker and main thread renderer.
// We use Transferable typed arrays via postMessage — no SharedArrayBuffer
// (which would require COOP/COEP headers). Each tick the worker fills two
// pooled buffers and transfers them; main returns them after rendering so
// the worker can reuse them, eliminating per-tick allocation.

// Per-atom layout in `atoms` Float32Array (stride = 4 floats = 16 bytes):
//   [0] x
//   [1] y
//   [2] packed: (typeCharCode << 16) | state    (read as f32 bit-pattern? — no, store as-is)
//   [3] flags: bit0 = bonded, bit1 = predator-membrane (state>=Q && type=='a')
//
// We store packed data as Float32 by reinterpreting bits via a helper view —
// see encodePack/decodePack below.

export const STRIDE = 4;

// Loop layout in `loops` Uint32Array, stream of records:
//   [vertCount, isPredator, atomIdx0, atomIdx1, ...]
//   Header at offset 0: [loopCount]

export type SnapshotMsg = {
  type: 'snapshot';
  iterations: number;
  atomCount: number;
  epoch: number; // increments on grid reset — main thread uses this to flush EMA state
  atoms:    Float32Array;
  atomIds:  Uint32Array;   // parallel to atoms: stable monotonic ID per atom (0 in unused slots)
  loops:    Uint32Array;
  bonds:    Uint32Array;
  droplets: Float32Array;  // [count, x, y, r, x, y, r, ...]
  // Game-mode state. Only meaningful when 'inGame' on the worker side is true.
  gameStatus: number;        // 0 = playing, 1 = won, 2 = lost
  enemyCount:  number;       // # of full enemy loops on screen this snapshot
  playerCount: number;       // # of full player loops
  winCountdownIter: number;  // iterations remaining before win is awarded (0 if not currently winning)
};

export type ControlMsg =
  | { type: 'init'; gridW: number; gridH: number; mode: 'rigged' | 'wild' }
  | { type: 'pause'; paused: boolean }
  | { type: 'setStepsPerFrame'; n: number }
  | { type: 'setThermalScale'; v: number }
  | { type: 'setBondedDamping'; v: number }
  | { type: 'toggleLysin'; on: boolean }
  | { type: 'togglePredators'; on: boolean }
  | { type: 'addSoup' }
  | { type: 'rerollWild' }
  | { type: 'setMode'; mode: 'rigged' | 'wild' }
  | { type: 'paintSoup'; x: number; y: number; radius: number; count: number }
  | { type: 'paintWater'; x: number; y: number; radius: number }
  | { type: 'clearWater' }
  | { type: 'startGame' }
  | { type: 'endGame' }
  | { type: 'setPlayerInput'; x: number; y: number }
  | { type: 'setDripFeed'; on: boolean; soupInterval: number; waterInterval: number }
  | { type: 'burn'; targetIters: number }
  | { type: 'abortBurn' }
  | { type: 'setSeed'; seed: number }
  | { type: 'requestSave' }
  | { type: 'loadSave'; state: SaveState }
  | { type: 'selectAt'; x: number; y: number; radius: number }
  | { type: 'deselectAll' }
  | { type: 'deleteSelected' }
  | { type: 'exportSelection' }
  | { type: 'pasteSelection'; x: number; y: number; selection: SelectionState }
  | { type: 'setNoise'; enabled: boolean; copyFidelity: number; decayRate: number; bondFailRate: number }
  | { type: 'setHydrolysis'; enabled: boolean; baseRate: number; waterDensity: number }
  | { type: 'requestEventLog' }
  | { type: 'reuse'; atoms: Float32Array; atomIds: Uint32Array; loops: Uint32Array; bonds: Uint32Array; droplets: Float32Array };

// Serialized full simulation state for save/load round-trip. Designed so
// loading is bit-identical (same seed + same RNG state + same atoms/bonds/
// droplets/iter counter → same future). Schema-versioned so we can evolve
// the format later without silently corrupting old saves.
export type SaveState = {
  magic: 'primordium-save';
  version: 1;
  savedAt: string;          // ISO 8601 — informational only
  // Grid metadata
  gridW: number;
  gridH: number;
  iterations: number;
  // Reproducibility
  seed: number;
  rngState: number;
  // Sim parameters
  thermalScale: number;
  bondedDamping: number;
  // Drip-feed config
  dripFeed: boolean;
  dripSoupInterval: number;
  dripWaterInterval: number;
  // Noise config — preserved so a reproducible run replays the exact same
  // mutation sequence. Optional for back-compat with v1 saves missing them.
  noiseEnabled?: boolean;
  noiseCopyFidelity?: number;
  noiseDecayRate?: number;
  noiseBondFailRate?: number;
  // Hydrolysis config — same reproducibility logic. Water atoms ('w') are
  // saved like any other atom in the cell arrays.
  hydrolysisEnabled?: boolean;
  hydrolysisBaseRate?: number;
  hydrolysisWaterDensity?: number;
  // Atom ID counter — restored so post-load creations don't collide with
  // pre-save IDs. Optional for back-compat.
  nextAtomId?: number;
  // Cells (parallel arrays for compact JSON)
  cellX:    number[];
  cellY:    number[];
  cellVx:   number[];
  cellVy:   number[];
  cellType: string[];        // single-character per cell
  cellState:  number[];
  cellEnergy: number[];
  cellPlayer: number[];      // 0/1
  // Per-cell stable ID. Optional for back-compat with v1 saves; when
  // missing, loader assigns fresh sequential IDs.
  cellId?:    number[];
  // Bonds — flat [i0, j0, i1, j1, ...] with i < j
  bonds: number[];
  // Water droplets
  dropX: number[];
  dropY: number[];
  dropR: number[];
};

// Selection export — a portable subgraph of atoms + their internal bonds.
// Lighter than SaveState (no RNG / sim params) since it represents a
// study artifact that can be pasted into any running sim, not a full
// world restore. Bond indices are local to the cell arrays.
export type SelectionState = {
  magic: 'primordium-selection';
  version: 1;
  savedAt: string;
  atomCount: number;
  cellX: number[];
  cellY: number[];
  cellType: string[];
  cellState: number[];
  bonds: number[]; // flat [i0,j0, i1,j1, ...] with i < j
};

export type SelectionExportMsg = {
  type: 'selectionExport';
  selection: SelectionState;
};

export type SaveStateMsg = {
  type: 'saveState';
  state: SaveState;
};
export type LoadResultMsg = {
  type: 'loadResult';
  ok: boolean;
  error?: string;
  iterations?: number;
  cellCount?: number;
  seed?: number;
};

// Worker → main messages other than 'snapshot'.
export type BurnProgressMsg = {
  type: 'burnProgress';
  iterations: number;
  target: number;
  stepsPerSec: number;
};
export type BurnDoneMsg = {
  type: 'burnDone';
  iterations: number;
  aborted: boolean;
};

// Chunk of noise events drained from the worker's ring buffer. Six
// parallel Uint32Arrays keep wire format compact and transferable.
// kinds: 0=copy_misfire, 1=decay, 2=bond_fail, 3=rule_flip(reserved).
// before/after: packed (typeCharCode<<16)|state (atom events) or
// 0/1 (bond events: 1=was bonded).
export type EventLogChunkMsg = {
  type: 'eventLogChunk';
  n: number;
  totalEverFired: number;
  droppedSinceLast: number;
  iters:  Uint32Array;
  kinds:  Uint32Array;
  atomA:  Uint32Array;
  atomB:  Uint32Array;
  before: Uint32Array;
  after:  Uint32Array;
};

// Pack typeCharCode + state into a single f32 bit-pattern.
// We use Uint32 bit reinterpretation through a tiny aliased view.
const _packView   = new ArrayBuffer(4);
const _packF32    = new Float32Array(_packView);
const _packU32    = new Uint32Array(_packView);
export function packTypeState(typeCode: number, state: number): number {
  _packU32[0] = ((typeCode & 0xffff) << 16) | (state & 0xffff);
  return _packF32[0];
}
export function unpackType(packed: number): number {
  _packF32[0] = packed;
  return (_packU32[0] >>> 16) & 0xffff;
}
export function unpackState(packed: number): number {
  _packF32[0] = packed;
  return _packU32[0] & 0xffff;
}

// Buffer sizing. We pick generous limits so reallocation is rare.
export const MAX_ATOMS = 80_000;
export const MAX_LOOP_VERTS_TOTAL = 20_000;
export const MAX_BONDS = 50_000;
export const MAX_DROPLETS = 500;

export function allocAtomsBuffer(): Float32Array {
  return new Float32Array(MAX_ATOMS * STRIDE);
}
export function allocAtomIdsBuffer(): Uint32Array {
  return new Uint32Array(MAX_ATOMS);
}
export function allocLoopsBuffer(): Uint32Array {
  // Header (1) + per-loop header (2: vertCount, isPredator) * up to 2000 loops + verts
  return new Uint32Array(1 + 2 * 2000 + MAX_LOOP_VERTS_TOTAL);
}
export function allocBondsBuffer(): Uint32Array {
  return new Uint32Array(1 + MAX_BONDS * 2);
}
export function allocDropletsBuffer(): Float32Array {
  return new Float32Array(1 + MAX_DROPLETS * 3);
}
