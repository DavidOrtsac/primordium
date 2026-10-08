// Primordium — central render theme.
//
// THE place to tune the visuals: atom colors, translucency levels and the
// three 'a'-membrane alphas (closed loop / open chain / free soup). Both
// renderers (Canvas-2D educational + WebGPU) read from this file — change
// a value here, rebuild, done. The Classic view keeps its own Squirm3-era
// palette on purpose; the microscope/DIC look is intentionally separate.

/** Atom colors, RGB floats 0..1. Canonical form; 2D converts via helpers. */
export const ATOM_COLORS: Record<string, [number, number, number]> = {
  a: [0.910, 0.839, 0.541], // pale yellow — membrane unit
  b: [0.533, 0.533, 0.533], // grey — common gene base
  c: [0.0,   0.867, 0.867], // cyan — rare gene base
  d: [0.2,   0.4,   1.0  ], // blue — polymerase
  e: [1.0,   0.2,   0.2  ], // red — gene start
  f: [0.2,   1.0,   0.2  ], // green — gene end
  p: [1.0,   0.467, 0.0  ], // orange — lysin
  w: [0.4,   0.8,   1.0  ], // light blue — water
};

/** Fallback color for atoms without an entry (custom/lab types). */
export const FALLBACK_COLOR: [number, number, number] = [1.0, 0.2, 0.2]; // red

/** Membrane bond-line colors (educational outlines + open chains). */
export const MEMBRANE_LINE:  [number, number, number] = [0.784, 0.659, 0.0];   // gold
export const PREDATOR_LINE:  [number, number, number] = [0.784, 0.118, 0.0];   // red
export const PLAYER_LINE:    [number, number, number] = [0.196, 0.863, 0.627]; // green

/**
 * Translucency levels (0..1).
 * The 'a' atom has THREE alphas depending on where it sits:
 *   aInLoop  — member of a closed membrane loop (a finished cell wall)
 *   aInChain — bonded 'a' in an open chain (loose building material)
 *   aFree    — free 'a' drifting in the soup (the bulk of all atoms)
 */
export const ALPHA = {
  soup:      0.10, // free soup atoms (state 0)
  soupLysin: 0.34, // free 'p' — slightly stronger so the killer is visible
  organelle: 0.80, // reacted/bonded non-membrane atoms (gene strand etc.)
  aFree:     0.10, // free 'a' in the soup
  aInLoop:   0.20, // 'a' bonded as part of a closed membrane loop
  aInChain:  0.80, // 'a' in an open membrane chain
} as const;

/** Predator membrane units get this tint instead of the 'a' color. */
export const PREDATOR_UNIT: [number, number, number] = [0.886, 0.463, 0.353];

/** Color of the canvas area outside the arena bounds (visible on the
 *  right/bottom edge when the zoomed-out view is larger than the grid). */
export const MARGIN: [number, number, number] = [0.72, 0.72, 0.75];

// ── helpers ─────────────────────────────────────────────────────────────────

/** rgb floats → '#rrggbb' */
export function rgbHex([r, g, b]: [number, number, number]): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** alpha 0..1 → two-digit hex suffix for '#rrggbbAA' strings */
export function alphaHex(a: number): string {
  return Math.round(a * 255).toString(16).padStart(2, '0');
}

/** rgb floats + alpha → 'rgba(r,g,b,a)' canvas string */
export function rgba([r, g, b]: [number, number, number], a: number): string {
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
}
