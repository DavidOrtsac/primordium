import type { Vec2 } from './vec2';

export const RADIUS = 6.0;
export const MAX_VELOCITY = RADIUS * 0.4;

export class Cell {
  loc: Vec2;
  vel: Vec2;
  type: string;
  state: number;
  bonds: Set<Cell>;
  wasFree = false; // true if this atom was also free the previous step
  energy = 1.0; // wild-mode metabolism — ignored when grid.energyEnabled is false
  playerControlled = false; // true → WASD bias force applies to this atom each step
  // Cached crowding count — atoms within RADIUS*1.5, capped at 3.
  // Precomputed once per tick at the top of computeVelocitiesAndReact so the
  // inner pair loop can read it in O(1) instead of re-querying the spatial
  // hash for every candidate. Safe because positions don't change between
  // precompute and the pair loop (moveCells runs after).
  crowdingCount = 0;
  // Render-only smoothed position (EMA toward loc). Physics never reads these.
  displayX = 0;
  displayY = 0;
  displayInit = false;

  constructor(x: number, y: number, type: string, state: number) {
    this.loc = { x, y };
    this.vel = randomVelocity();
    this.type = type;
    this.state = state;
    this.bonds = new Set();
  }

  bondTo(other: Cell): void {
    this.bonds.add(other);
    other.bonds.add(this);
  }

  debond(other: Cell): void {
    this.bonds.delete(other);
    other.bonds.delete(this);
  }

  breakAllBonds(): void {
    for (const other of this.bonds) {
      other.bonds.delete(this);
    }
    this.bonds.clear();
  }

  randomizeVelocity(): void {
    const v = randomVelocity();
    this.vel.x = v.x;
    this.vel.y = v.y;
  }
}

function randomVelocity(): Vec2 {
  const angle = Math.random() * 2 * Math.PI;
  return {
    x: MAX_VELOCITY * Math.cos(angle),
    y: MAX_VELOCITY * Math.sin(angle),
  };
}
