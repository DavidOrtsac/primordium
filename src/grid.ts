import { Cell, RADIUS, MAX_VELOCITY } from './cell';
import { Chemistry } from './chemistry';

const PHYS_RANGE = RADIUS * 2.0;
const PHYS_RANGE2 = PHYS_RANGE * PHYS_RANGE;
const REACTION_RANGE = RADIUS * 2.5;
export const REACTION_RANGE2 = REACTION_RANGE * REACTION_RANGE;
const SLOT_SIZE = RADIUS * 5.0;

// Maximum extent for octagon fast-reject (avoids sqrt)
const XY_DIST = 2.0 * Math.sqrt(Math.max(PHYS_RANGE2, REACTION_RANGE2));

function computeRepulsion(r2: number): number {
  if (r2 > 0 && r2 < PHYS_RANGE2) {
    return 0.4 * (PHYS_RANGE / Math.sqrt(r2) - 1.0);
  }
  return 0;
}

function springForce(r2: number): number {
  const RANGE = 2.0 * RADIUS;
  const RANGE2 = RANGE * RANGE;
  if (r2 > RANGE2) {
    return 0.4 * (Math.sqrt(r2) / RANGE - 1.0);
  }
  return 0;
}

export class Grid {
  width = 0;
  height = 0;
  thermalScale  = 0.60; // free-atom speed as fraction of MAX_VELOCITY
  bondedDamping = 1.00; // velocity multiplier applied to bonded atoms each step
  energyEnabled = false;
  energyDecay   = 0.0008; // per-step drain when wild metabolism is on

  // ── Player input bias ────────────────────────────────────────────────────
  // WASD writes to these from the worker. Each step, every playerControlled
  // atom gets a *biased random kick* — a tiny random unit vector blended with
  // the input direction. Over many steps this produces net drift toward the
  // input (biased Brownian motion), but each individual step is still random,
  // so movement feels organic and not like constant propulsion.
  playerInputX = 0;
  playerInputY = 0;
  private PLAYER_KICK = 0.018;  // per-step magnitude — very small
  private PLAYER_BIAS = 0.28;   // 0 = pure random, 1 = pure directed

  // ── Water droplets ───────────────────────────────────────────────────────
  // When non-empty, only atoms inside a droplet receive thermal motion.
  // Atoms inside droplets near the boundary feel an inward surface tension
  // force; bonded clusters of many atoms experience cumulatively stronger
  // containment, while a single free atom occasionally beats the tension via
  // a random thermal kick — exactly the leakage the user asked for.
  droplets: { x: number; y: number; r: number }[] = [];
  // Tunables — kept local to this class so the worker can't drift them
  private TENSION_K     = 0.08; // peak inward acceleration at boundary
  private TENSION_WIDTH = 10.0; // grid units of tension band inside the rim
  // Outside-water thermal magnitude as a fraction of the in-water value.
  // Small but nonzero — the dry slide still feels alive (faint shimmer of
  // dust motes) but no random walk is fast enough to do meaningful chemistry.
  private DRY_THERMAL_FACTOR = 0.07;
  private slotsX = 0;
  private slotsY = 0;
  private slots: Cell[][][] = [];
  protected cells: Cell[] = [];
  protected chemistry = new Chemistry();
  private _iterations = 0;
  private _epoch = 0;
  private readonly _nearby: Cell[] = [];
  private readonly _candidates: Cell[] = [];

  get iterations(): number { return this._iterations; }
  get epoch(): number { return this._epoch; }

  create(width: number, height: number): void {
    this._epoch++;
    this.width = width;
    this.height = height;
    this.slotsX = Math.ceil(width / SLOT_SIZE);
    this.slotsY = Math.ceil(height / SLOT_SIZE);
    this.slots = Array.from({ length: this.slotsX }, () =>
      Array.from({ length: this.slotsY }, () => [])
    );
    this.cells = [];
    this._iterations = 0;
  }

  getCells(): Cell[] { return this.cells; }
  getChemistry(): Chemistry { return this.chemistry; }

  createCell(x: number, y: number, type: string, state: number): Cell {
    const cell = new Cell(x, y, type, state);
    const [sx, sy] = this.slotOf(x, y);
    this.slots[sx][sy].push(cell);
    this.cells.push(cell);
    return cell;
  }

  step(): void {
    this.computeVelocitiesAndReact();
    this.moveCells();
    this._iterations++;
  }

  // ------------------------------------------------------------------ private

  private slotOf(x: number, y: number): [number, number] {
    const sx = Math.max(0, Math.min(this.slotsX - 1, Math.floor(x / SLOT_SIZE)));
    const sy = Math.max(0, Math.min(this.slotsY - 1, Math.floor(y / SLOT_SIZE)));
    return [sx, sy];
  }

  getAllWithinRadius(x: number, y: number, r: number): Cell[] {
    const r2 = r * r;
    const [cx, cy] = this.slotOf(x, y);
    const sr = Math.ceil(r / SLOT_SIZE);
    const result: Cell[] = [];
    for (let i = Math.max(0, cx - sr); i <= Math.min(this.slotsX - 1, cx + sr); i++) {
      for (let j = Math.max(0, cy - sr); j <= Math.min(this.slotsY - 1, cy + sr); j++) {
        for (const c of this.slots[i][j]) {
          const dx = c.loc.x - x;
          const dy = c.loc.y - y;
          if (dx * dx + dy * dy < r2) result.push(c);
        }
      }
    }
    return result;
  }

  // Hot-path count-only variant — avoids allocating a result array. Returns
  // exactly the same count getAllWithinRadius would produce. The inner-loop
  // crowding check only needs the count, never the cells themselves.
  private countWithinRadius(x: number, y: number, r: number, capAt: number): number {
    const r2 = r * r;
    const [cx, cy] = this.slotOf(x, y);
    const sr = Math.ceil(r / SLOT_SIZE);
    let n = 0;
    for (let i = Math.max(0, cx - sr); i <= Math.min(this.slotsX - 1, cx + sr); i++) {
      for (let j = Math.max(0, cy - sr); j <= Math.min(this.slotsY - 1, cy + sr); j++) {
        const slot = this.slots[i][j];
        for (let k = 0; k < slot.length; k++) {
          const c = slot[k];
          const dx = c.loc.x - x;
          const dy = c.loc.y - y;
          if (dx * dx + dy * dy < r2) {
            n++;
            if (n > capAt) return n;
          }
        }
      }
    }
    return n;
  }

  private computeVelocitiesAndReact(): void {
    const searchSlots = Math.ceil(REACTION_RANGE / SLOT_SIZE) + 1;
    const nearby     = this._nearby;
    const candidates = this._candidates;

    for (let cx = 0; cx < this.slotsX; cx++) {
      for (let cy = 0; cy < this.slotsY; cy++) {
        const centralCells = this.slots[cx][cy];
        if (centralCells.length === 0) continue;

        // Reuse pre-allocated buffer — no allocation per slot
        nearby.length = 0;
        for (let i = Math.max(0, cx - searchSlots); i <= Math.min(this.slotsX - 1, cx + searchSlots); i++) {
          for (let j = Math.max(0, cy - searchSlots); j <= Math.min(this.slotsY - 1, cy + searchSlots); j++) {
            for (const c of this.slots[i][j]) nearby.push(c);
          }
        }

        // Snapshot length only — iterating by index is allocation-free and
        // safe even if reactions push to or rearrange the slot mid-loop, since
        // we only visit indices [0, snapshotLen). Cells appended during the
        // loop won't be visited this slot pass; cells that swap-pop out via
        // moveCells() are visited but cheaply (their slot membership is
        // snapshotted, the loop just sees their then-current location).
        const snapshotLen = centralCells.length;
        for (let ci = 0; ci < snapshotLen; ci++) {
          const cell = centralCells[ci];
          let fx = 0;
          let fy = 0;
          candidates.length = 0;

          // Only bonded cells participate in forces and trigger reactions
          if (cell.bonds.size > 0) {
            for (const other of nearby) {
              if (other === cell) continue;

              const dx = cell.loc.x - other.loc.x;
              const dy = cell.loc.y - other.loc.y;

              // Octagon fast-reject before computing r²
              if (Math.abs(dx) + Math.abs(dy) > XY_DIST) continue;

              const r2 = dx * dx + dy * dy;

              // Reaction candidate: within reaction range and not overcrowded.
              if (r2 < REACTION_RANGE2) {
                const n = this.countWithinRadius(other.loc.x, other.loc.y, RADIUS * 1.5, 2);
                if (n <= 1) candidates.push(other);
              }

              // No repulsion against unbonded state-0 atoms (free soup)
              if (other.bonds.size === 0 && other.state === 0) continue;

              // Repulsion
              const rep = computeRepulsion(r2);
              if (rep > 0) {
                fx += dx * rep;
                fy += dy * rep;
              }
            }
          }

          // Spring attraction from each bonded partner (no-op for free atoms)
          for (const other of cell.bonds) {
            const dx = other.loc.x - cell.loc.x;
            const dy = other.loc.y - cell.loc.y;
            const r2 = dx * dx + dy * dy;
            const s = springForce(r2);
            if (s > 0) {
              fx += dx * s;
              fy += dy * s;
            }
          }

          // Wall repulsion — all atoms, accumulated into fx/fy before vel update
          const w = RADIUS;
          if (cell.loc.x > 0 && cell.loc.x < w)
            fx += cell.loc.x * (w / cell.loc.x - 1.0);
          if (cell.loc.x < this.width && cell.loc.x > this.width - w) {
            const d = this.width - cell.loc.x;
            fx += (cell.loc.x - this.width) * (w / d - 1.0);
          }
          if (cell.loc.y > 0 && cell.loc.y < w)
            fy += cell.loc.y * (w / cell.loc.y - 1.0);
          if (cell.loc.y < this.height && cell.loc.y > this.height - w) {
            const d = this.height - cell.loc.y;
            fy += (cell.loc.y - this.height) * (w / d - 1.0);
          }

          cell.vel.x += fx;
          cell.vel.y += fy;

          // Cap speed so atoms can't tunnel through each other
          const speed = Math.sqrt(cell.vel.x * cell.vel.x + cell.vel.y * cell.vel.y);
          if (speed > MAX_VELOCITY) {
            const sc = MAX_VELOCITY / speed;
            cell.vel.x *= sc;
            cell.vel.y *= sc;
          }

          // Skip chemistry for free atoms — no candidates means react is always
          // a no-op; skipping saves ~47 wasted checks per free atom per step.
          if (cell.bonds.size > 0) {
            candidates.push(cell);
            this.chemistry.react(cell, candidates, REACTION_RANGE2);
          }
        }
      }
    }
  }

  // Returns true if the point is inside any droplet, and accumulates the
  // surface tension acceleration for atoms within the boundary band.
  // Tension direction is always toward the droplet's center.
  private dropletInfluence(x: number, y: number, out: { fx: number; fy: number }): boolean {
    out.fx = 0; out.fy = 0;
    let inside = false;
    const drops = this.droplets;
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      const dx = x - d.x;
      const dy = y - d.y;
      const dist2 = dx * dx + dy * dy;
      if (dist2 >= d.r * d.r) continue;
      inside = true;
      const dist = Math.sqrt(dist2) || 0.0001;
      const penetration = d.r - dist; // distance from outer rim
      if (penetration < this.TENSION_WIDTH) {
        // 0 at TENSION_WIDTH-deep, peaks 1 at the rim
        const t = 1 - penetration / this.TENSION_WIDTH;
        const mag = this.TENSION_K * t;
        out.fx -= (dx / dist) * mag;
        out.fy -= (dy / dist) * mag;
      }
    }
    return inside;
  }

  private moveCells(): void {
    const dropOut = { fx: 0, fy: 0 };

    for (const cell of this.cells) {
      const [oldSx, oldSy] = this.slotOf(cell.loc.x, cell.loc.y);

      // Position update with current velocity (surface tension + thermal kick
      // applied AFTER the move so they bias the *next* step instead of being
      // wiped by re-randomization).
      const nx = cell.loc.x + cell.vel.x;
      const ny = cell.loc.y + cell.vel.y;
      // Default: outside water. Becomes true only if we're inside a droplet.
      let inDrop = false;

      if (nx >= 0 && nx <= this.width && ny >= 0 && ny <= this.height) {
        cell.loc.x = nx;
        cell.loc.y = ny;
      } else {
        cell.loc.x = Math.max(0, Math.min(this.width, nx));
        cell.loc.y = Math.max(0, Math.min(this.height, ny));
        cell.vel.x = 0;
        cell.vel.y = 0;
      }

      const [newSx, newSy] = this.slotOf(cell.loc.x, cell.loc.y);
      if (oldSx !== newSx || oldSy !== newSy) {
        const oldSlot = this.slots[oldSx][oldSy];
        const idx = oldSlot.indexOf(cell);
        if (idx >= 0) {
          oldSlot[idx] = oldSlot[oldSlot.length - 1];
          oldSlot.pop();
        }
        this.slots[newSx][newSy].push(cell);
      }

      // Wild-mode metabolism — atoms slowly burn energy; flatlined atoms recycle
      if (this.energyEnabled) {
        cell.energy -= this.energyDecay;
        if (cell.energy <= 0) {
          if (cell.bonds.size > 0) cell.breakAllBonds();
          cell.state = 0;
          cell.energy = 0.5 + Math.random() * 0.5; // respawn with fresh charge
        }
      }

      // Determine droplet membership at the new location for the thermal pass.
      // Always run this — the simulation is "dry by default", so an atom only
      // gets full Brownian motion if it's actually inside a water droplet.
      if (this.droplets.length > 0) {
        inDrop = this.dropletInfluence(cell.loc.x, cell.loc.y, dropOut);
      }

      // Thermal: free atoms get the random Brownian kick. Outside water the
      // kick magnitude is tiny (~7%) — the slide feels alive but mostly still.
      if (cell.bonds.size === 0) {
        if (cell.wasFree) {
          const dryFactor = inDrop ? 1.0 : this.DRY_THERMAL_FACTOR;
          const angle = Math.random() * 2 * Math.PI;
          const speed = this.thermalScale * MAX_VELOCITY * dryFactor;
          cell.vel.x = speed * Math.cos(angle);
          cell.vel.y = speed * Math.sin(angle);
        }
        cell.wasFree = true;
      } else {
        cell.wasFree = false;
        cell.vel.x *= this.bondedDamping;
        cell.vel.y *= this.bondedDamping;
      }

      // Surface tension applied AFTER thermal randomization so it survives
      // and biases the next step. Only inside a droplet.
      if (inDrop) {
        cell.vel.x += dropOut.fx;
        cell.vel.y += dropOut.fy;
      }

      // Player input — true biased Brownian motion, NOT a propulsion force.
      // Each step samples a random unit vector, blends it with the input
      // direction (28% bias), normalizes, and applies a tiny per-step kick.
      // Magnitude scales with water like everything else: outside water you
      // can barely steer (faint motion), inside water you bias normally.
      if (cell.playerControlled && (this.playerInputX !== 0 || this.playerInputY !== 0)) {
        const dryFactor = inDrop ? 1.0 : this.DRY_THERMAL_FACTOR;
        const angle = Math.random() * Math.PI * 2;
        const rx = Math.cos(angle), ry = Math.sin(angle);
        const dxRaw = (1 - this.PLAYER_BIAS) * rx + this.PLAYER_BIAS * this.playerInputX;
        const dyRaw = (1 - this.PLAYER_BIAS) * ry + this.PLAYER_BIAS * this.playerInputY;
        const m = Math.sqrt(dxRaw * dxRaw + dyRaw * dyRaw) || 1;
        cell.vel.x += (dxRaw / m) * this.PLAYER_KICK * dryFactor;
        cell.vel.y += (dyRaw / m) * this.PLAYER_KICK * dryFactor;
      }
    }
  }
}
