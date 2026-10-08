// Lysin dart — the game-mode projectile shared by the physics worker and
// the dev micro-simulation (dev/dart-sim.ts). A bonded cluster of 'p'
// atoms is already the perfect ammunition: inert to every rule except
// the lysin reaction, and nothing in the chemistry can break p–p bonds
// (the lysin rule dissolves the *target's* S–S bond, not p's own).

import { Grid } from './grid';
import { Cell, RADIUS, MAX_VELOCITY } from './cell';

export const FIRE_COOLDOWN_TICKS  = 720;   // ~1.5 s between shots at 480 it/s
export const DART_FUEL_TICKS      = 600;   // thrust burn, then the dart drifts
const DART_SPEED                  = MAX_VELOCITY * 0.5; // cruise speed —
                                           // half the global cap so the
                                           // flight stays readable and
                                           // dodgeable
const DART_THRUST                 = 0.10;  // per-step kick — steers the
                                           // flight path; the speed clamp
                                           // in updateDarts caps cruise
export const DART_ATOMS           = 5;     // lysin payload atoms per dart —
                                           // also the ammo cost per shot
// Terminal guidance — a dart veers toward nearby enemy membrane material
// so near-misses curve into hits. Short range and a gentle turn rate
// keep it an assist, not a lock-on.
const DART_HOMING_RANGE           = 200;   // world units — ~33 atom radii
const DART_HOMING_BLEND           = 0.10;  // thrust vector pull per tick
const DART_FUSE_TICKS             = 12;    // burrow time after membrane contact —
                                           // ~14 u at cruise, past the rim, so the
                                           // lysin burst lands inside the ring
const DART_SPAWN_CLEARANCE        = 5;     // × RADIUS beyond the outermost player
                                           // atom on the fire axis — the cluster's
                                           // innermost satellite (1.6R behind the
                                           // core) still clears REACTION_RANGE (2.5R),
                                           // so the shot can't dissolve its own ring

// Build and arm a dart launched from just outside a membrane ring at
// (cx,cy) with outer radius ringRadius, flying along (ux,uy). Returns
// the bonded cluster and the spawn position for logging.
export function spawnDart(
  grid: Grid, cx: number, cy: number, ringRadius: number,
  ux: number, uy: number, now: number,
): { cluster: Cell[]; x: number; y: number } {
  const sx = cx + ux * (ringRadius + RADIUS * DART_SPAWN_CLEARANCE);
  const sy = cy + uy * (ringRadius + RADIUS * DART_SPAWN_CLEARANCE);
  const px = Math.max(RADIUS * 2, Math.min(grid.width  - RADIUS * 2, sx));
  const py = Math.max(RADIUS * 2, Math.min(grid.height - RADIUS * 2, sy));
  // Compact cluster: a core atom with the payload bonded around it —
  // the dart holds together mid-flight and grinds the target membrane
  // from multiple contact points at once.
  const core = grid.createCell(px, py, 'p', 0);
  const cluster: Cell[] = [core];
  for (let k = 0; k < DART_ATOMS - 1; k++) {
    const ang = (k / (DART_ATOMS - 1)) * Math.PI * 2;
    const a = grid.createCell(
      px + Math.cos(ang) * RADIUS * 1.6,
      py + Math.sin(ang) * RADIUS * 1.6,
      'p', 0);
    a.bondTo(core);
    cluster.push(a);
  }
  for (const a of cluster) {
    a.thrustX = ux * DART_THRUST;
    a.thrustY = uy * DART_THRUST;
    a.thrustUntilIter = now + DART_FUEL_TICKS;
    // Launch straight at cruise speed so the shot reads instantly
    // instead of spooling up.
    a.vel.x = ux * DART_SPEED;
    a.vel.y = uy * DART_SPEED;
  }
  return { cluster, x: px, y: py };
}

// Dart lifecycle. First contact with a bonded non-player 'a' atom —
// bonded 'a' only exists inside membrane rings — lights a short fuse:
// the cluster keeps thrusting into the ring, then bursts, breaking the
// p–p bonds and scattering the payload as a lysin cloud that keeps
// grinding the breach; a rim-level pop would scatter outward and let
// the ring reseal. The player's own ring does not trigger the fuse,
// though the armed lysin can still eat it — firing into your own wake
// is a real risk. Returns the detonating atom for logging, else null.
// `homing` gates terminal guidance — darts fly straight until the
// worker unlocks it (first confirmed detonation in a match).
export function updateDarts(grid: Grid, clusters: Cell[][], now: number, homing: boolean): Cell | null {
  for (let i = clusters.length - 1; i >= 0; i--) {
    const cluster = clusters[i];
    if (cluster[0].detonateAtIter > 0 && now >= cluster[0].detonateAtIter) {
      // Fuse burned down — burst the payload as a lysin cloud inside
      // the ring the cluster burrowed into.
      for (const a of cluster) {
        a.breakAllBonds();
        a.thrustUntilIter = now;
      }
      clusters.splice(i, 1);
      return cluster[0];
    }
    if (cluster[0].thrustUntilIter <= now) {
      clusters.splice(i, 1); // fuel spent — drifts as loose lysin now
      continue;
    }
    // Terminal guidance — pull the shared thrust vector toward the
    // nearest enemy membrane atom inside homing range.
    if (homing) {
      let cx = 0, cy = 0;
      for (const a of cluster) { cx += a.loc.x; cy += a.loc.y; }
      cx /= cluster.length; cy /= cluster.length;
      const near = grid.getAllWithinRadius(cx, cy, DART_HOMING_RANGE);
      let best: Cell | null = null, bestD = Infinity;
      for (const c of near) {
        if (c.type !== 'a' || c.playerControlled || c.bonds.size === 0) continue;
        const d = Math.hypot(c.loc.x - cx, c.loc.y - cy);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (best) {
        const tx = (best.loc.x - cx) / bestD;
        const ty = (best.loc.y - cy) / bestD;
        const head = cluster[0];
        let hx = head.thrustX + (tx * DART_THRUST - head.thrustX) * DART_HOMING_BLEND;
        let hy = head.thrustY + (ty * DART_THRUST - head.thrustY) * DART_HOMING_BLEND;
        const hm = Math.hypot(hx, hy) || 1;
        hx = hx / hm * DART_THRUST;
        hy = hy / hm * DART_THRUST;
        for (const a of cluster) { a.thrustX = hx; a.thrustY = hy; }
      }
    }
    // Cruise clamp — the constant kick would otherwise accumulate to
    // MAX_VELOCITY; hold the cluster at DART_SPEED instead.
    for (const a of cluster) {
      const s = Math.hypot(a.vel.x, a.vel.y);
      if (s > DART_SPEED) {
        a.vel.x *= DART_SPEED / s;
        a.vel.y *= DART_SPEED / s;
      }
    }
    for (const atom of cluster) {
      const near = grid.getAllWithinRadius(atom.loc.x, atom.loc.y, RADIUS * 2.4);
      const hit = near.some((c) =>
        c.type === 'a' && !c.playerControlled && c.bonds.size > 0);
      if (hit && cluster[0].detonateAtIter === 0) {
        // Rim contact — light the fuse; the burst happens after the
        // cluster has burrowed DART_FUSE_TICKS deeper.
        cluster[0].detonateAtIter = now + DART_FUSE_TICKS;
      }
    }
  }
  return null;
}
