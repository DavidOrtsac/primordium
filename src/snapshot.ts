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
  | { type: 'reuse'; atoms: Float32Array; loops: Uint32Array; bonds: Uint32Array; droplets: Float32Array };

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
