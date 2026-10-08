// Snapshot protocol shared between physics worker and main thread renderer.
// We use Transferable typed arrays via postMessage — no SharedArrayBuffer
// (which would require COOP/COEP headers). Each tick the worker fills two
// pooled buffers and transfers them; main returns them after rendering so
// the worker can reuse them, eliminating per-tick allocation.

// Per-atom layout in `atoms` Float32Array (stride = 4 floats = 16 bytes):
//   [0] x
//   [1] y
//   [2] packed: (typeCharCode << 16) | state    (read as f32 bit-pattern? — no, store as-is)
//   [3] flags: bit0 = bonded, bit1 = predator-membrane (state>=Q && type=='a'),
//        bit2 = 'a' atom, bit3 = playerControlled, bit4 = selected,
//        bit5 = propelled dart atom (lysin shot still under thrust)
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
  loseCountdownIter: number; // iterations remaining before death is declared (0 while a live player loop exists)
  playerMembraneFrac: number; // share of player 'a' atoms sealed in a closed loop (1 = intact, drops on breach)
  itersPerSec: number;        // current effective iterations/s (varies with adaptive pacing and the speed slider)
  fireCooldownIter: number;   // iterations until the lysin dart can fire again (0 = ready)
  fireCooldownFrac: number;   // 0..1 fraction of cooldown remaining (1 = just fired)
  projectileCount: number;    // dart atoms still under thrust this snapshot
  lysinAmmo: number;          // lysin atoms banked for darts (DART_ATOMS per shot)
  homingOn: boolean;          // terminal guidance earned — true after the first confirmed dart hit
  enemyDirX: number;          // unit vector player → nearest enemy membrane atom (0,0 when none)
  enemyDirY: number;
  enemyDist: number;          // distance to that atom (0 when no enemy membrane exists)
  lysinDirX: number;          // unit vector player → nearest free lysin atom (0,0 when none)
  lysinDirY: number;
  lysinDist: number;          // distance to it (0 when no free lysin exists)
};

// Lysin atoms banked at match start — shared by the worker (authoritative
// magazine) and the main thread (seed value for the mirrored count).
export const DART_AMMO_START = 15;

export type ControlMsg =
  | { type: 'init'; gridW: number; gridH: number; mode: 'rigged' | 'wild' }
  | { type: 'pause'; paused: boolean }
  | { type: 'setStepsPerFrame'; n: number }
  | { type: 'setSimRate'; v: number }
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
  | { type: 'fire'; x: number; y: number }
  | { type: 'setDripFeed'; on: boolean; soupInterval: number; waterInterval: number }
  | { type: 'burn'; targetIters: number }
  | { type: 'abortBurn' }
  | { type: 'setSeed'; seed: number }
  | { type: 'requestSave' }
  | { type: 'loadSave'; state: SaveState }
  | { type: 'selectAt'; x: number; y: number; radius: number }
  | { type: 'selectBox'; x0: number; y0: number; x1: number; y1: number }
  | { type: 'deselectAll' }
  | { type: 'deleteSelected' }
  | { type: 'exportSelection' }
  | { type: 'pasteSelection'; x: number; y: number; selection: SelectionState }
  | { type: 'editAddAtom'; x: number; y: number; atomType: string; state: number }
  | { type: 'editDeleteAtom'; atomId: number }
  | { type: 'editToggleBond'; atomIdA: number; atomIdB: number }
  | { type: 'replaceAtomType'; fromType: string; toType: string }
  | { type: 'setCustomAtoms'; atoms: CustomAtomDef[] }
  | { type: 'setCustomRules'; rules: CustomRuleSpec[] }
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

// User-defined atom — purely a label + cosmetic record. Behavior comes
// from custom rules that reference this type. Built-in alphabet
// (a/b/c/d/e/f/w/p) and wildcards (x/y/z) are reserved and rejected.
export type CustomAtomDef = {
  type: string;          // single character symbol, e.g. 'A', 'Z', '0'
  name: string;          // human-readable label
  color: string;         // hex like '#aabbcc'
  defaultState: number;  // shown in the palette state input when picked
};

// Wire-format spec for a user-defined reaction. Compiled into a Reaction
// object on the worker via r2/r3. nInputs = 2 or 3. The shape mirrors
// reaction.ts but lives in the protocol so JSON travels cleanly.
export type CustomRuleSpec = {
  id: string;            // stable client-side ID for diffing in the UI
  name: string;          // human-readable label, shown in the editor list
  nInputs: 2 | 3;
  // Reactants
  aType: string; aState: number; currentAbBond: boolean;
  bType: string; bState: number;
  cType?: string; cState?: number;
  currentBcBond?: boolean; currentAcBond?: boolean;
  // Products
  futureAState: number; futureAbBond: boolean;
  futureBState: number; futureBcBond?: boolean;
  futureCState?: number; futureAcBond?: boolean;
  cases: number;         // probability denominator (1 = always, 100 = ~1%)
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
  // Stable atom IDs from the worker, parallel to cellX/Y. Lets the
  // inspector address specific atoms when issuing live edits (delete,
  // bond toggle). Optional in saved JSON for back-compat — when absent
  // (loaded from older files) edits are disabled until re-selected.
  cellId?: number[];
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

// Posted when a 'fire' control message is rejected — the UI can explain
// why (a mirrored cooldown can lag a frame, so rejects need a channel
// back rather than a client-side gate alone).
export type FireRejectedMsg = {
  type: 'fireRejected';
  reason: 'ammo' | 'cooldown';
};

// One-shot game events the HUD should react to — enemy bites that
// breached the player's membrane and dart detonations on a target.
export type PlayerHitMsg = { type: 'playerHit' };
export type DartHitMsg   = { type: 'dartHit' };

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
