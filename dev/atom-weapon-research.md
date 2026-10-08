# Atom-Complex Weapon — Research & Design

Goal: a player-launched projectile — a small bonded atom complex with
its own propulsion — that carries lysin to enemy membranes and dissolves
them, giving game mode an *active* win mechanic instead of the current
passive lysin-wait.

## Research summary

### What exists upstream (David Castro / DavidOrtsac)

- **Repo description & README** — game mode is documented as exactly:
  "WASD biases your cell's Brownian motion, with periodic soup/water/
  lysin spawns and win/lose detection". No weapon, no attack rule,
  no projectile concept anywhere.
- **dabbycastro.com** — the Primordium project entry focuses on the
  engine port (Web Worker physics, WebGPU, seeded determinism, save/
  replay, Tim Hutton confirming emergent bounding membranes). Nothing
  about gameplay mechanics beyond what the README says.
- **x.com/davidortsac** — not machine-readable; no public posts found
  describing a designed win mechanic. The repo owner additionally
  tried reaching David Castro directly via X from
  [https://x.com/reubwo](https://x.com/reubwo) (account @reubwo) —
  no reply received at the time of writing.
- **Conclusion:** no evidence of an intended-but-unfinished attack
  mechanic upstream. The open question in
  `dev/open-gameplay-questions.md` stands — we're designing new.

### Related projects

- **timhutton/squirm3** (original, GPL v3) — pure artificial chemistry;
  lysin `p` atoms already exist as ambient hazards that dissolve S–S
  membrane bonds. No combat steering.
- **Tim Hutton's Squirm worlds** (squirm2/3/4) + paper *Evolvable
  Self-Reproducing Cells in a 2D Artificial Chemistry* (ALife 13(1),
  2007) — chemistry-only, no directed propulsion.
- **primordial (ese-llc.com)** — unrelated micro-organism evolution
  game; lunge/bite combat. Inspiration at most.
- **pplmx/primordium** — unrelated terminal alife sim sharing the name.

## What the code gives us

| Piece | Where | Relevance |
|---|---|---|
| Lysin rule `a,S–a,S + p,0 → breaks S–S (cases=10)` | init.ts:104 | `p` is already the weapon payload — dissolves ANY S membrane, player included |
| Predator attack `a,S–a,S + a,Q → FREED (cases=3)` | init.ts:118 | proves contact-based killing works; Q is sandbox-only, not spawned in matches |
| `bondedDamping = 1.0` | grid.ts:39 | bonded clusters keep velocity — a thrust kick accumulates until `MAX_VELOCITY` (2.4/step) |
| Player steering = biased random kick on `playerControlled` atoms | grid.ts:498 | the exact propulsion pattern to reuse for the projectile |
| Free atoms re-randomize velocity each step | grid.ts:471 | projectile MUST be a bonded cluster or it can't hold a course |
| `REACTION_RANGE = 2.5·RADIUS` (15 units) | grid.ts:8 | spawn clearance needed so the shot doesn't dissolve the player's own ring |
| `spawnLysinSpot()` / respawn timers | physics-worker.ts:231 | spawn-pattern precedent for game-mode-only entities |

## Design: the "lysin dart"

**Payload choice.** A bonded cluster of `p` atoms is already the
perfect ammunition — inert to every rule except the lysin reaction,
nothing in the chemistry can break `p–p` bonds (the lysin rule breaks
the *target's* S–S bond, not p's). Adding a shaft of `a,0` atoms would
just feed enemy membranes (stretch rule absorbs free `a`) — cosmetic,
skip for v1. Pure-`p` cluster of ~5 atoms.

**Self-damage problem.** `p` dissolves the player's own membrane on
the way out. Two options:

- *Sheathed state:* spawn `p` in state 45 (no rule references 45, so
  it's inert to every wildcard too), arm to state 0 after a delay.
  Extra machinery.
- *Spawn clearance (chosen):* place the cluster just *outside* the
  player's membrane ring — `loopRadius + 4·RADIUS` > `REACTION_RANGE` —
  flying outward. Armed immediately; steering back into your own shot
  is a real, fair risk. Zero new states, zero chemistry changes.

**Propulsion.** New per-atom thrust fields (`thrustX/Y`,
`thrustUntilIter`) applied in the same motion pass as the player bias —
constant direction, stronger kick than PLAYER_KICK (it's a dart, not a
nudge), capped by `MAX_VELOCITY` like everything else. Fuel ~600 ticks,
then it drifts as loose armed lysin — a lingering hazard for everyone.

**Firing.** `fire {dx,dy}` message → worker finds the player loop
centroid, spawns the cluster at rim + clearance along `dir`, sets thrust
fields. Cooldown (~600 ticks ≈ 1.25 s) exported in the snapshot so the
HUD can show reload state.

**UI.** Circular fire pad top-left inside `#scope-frame` (DOM, so it
works on touch): press position from center = fire direction, needle
visual + conic-gradient cooldown sweep. Sits under the game HUD that
already replaced the sandbox legend in that corner.

## Implementation outcome (verified)

**Architecture:** `src/dart.ts` owns spawn + lifecycle, shared by the
worker and the dev probe — `spawnDart()` builds the bonded p-cluster,
`updateDarts()` runs detonation/expiry. The worker (`fireDart`) only
computes aim (player centroid + outer ring radius), enforces the
720-iter cooldown, and tracks clusters; `runOneStep` calls
`updateDarts` per tick.

**Detonation fix from testing:** the first micro-sim showed a grazing
dart only shaved the ring (~87% bonds, resealing) — contact time was
too short. `updateDarts` now detonates on first contact with a bonded
non-player 'a' atom: the cluster's p–p bonds break and the payload
scatters as a lysin cloud that keeps grinding the breach. With
detonation, `dev/dart-sim.ts` reports: detonation at iter 58, enemy
loop gone from iter ~100 and never resealed, player loop intact for
the full 800 iters.

**UI:** `#fire-pad` (88 px, top-left under the stats box) replaces the
sandbox legend in game mode. Press offset from center = launch
direction; gold needle marks aim, conic sweep drains the cooldown.
HUD shows `dart: READY|x.xs · N out`. Cooldown mirror is updated in
`loop()` unconditionally (drawHud only runs in educational+visible).

**Bug found along the way:** `#scope-frame` was `overflow:hidden` —
a scroll container. Clicking a closed-panel button let Chromium
auto-scroll `scrollLeft` to 380, dragging canvas + pad off-screen.
Fixed with `overflow: clip` (clips identically, never scrolls).

**Verified:** `dev/dart-sim.ts` PASS · Playwright `fire-pad.spec.js`
(pad visibility, dir mapping dir(1.00,0.00)→needle 90°, worker fire
log, cooldown blocks immediate re-press, reload re-arms, pad hides on
exit) · tutorial.spec.js still green · tsc + build + 14/14 smoke tests.

## Iteration 2 — tracers, homing, kill feed

- **Tracer rendering:** snapshot flag bit5 marks atoms still under
  thrust; the 2D renderer draws them as bright gold discs with a white
  rim, the GPU renderer as bright 1.4× discs. Shots are now clearly
  visible in flight instead of blending into ambient lysin soup.
- **Terminal guidance:** inside 150 units a cluster blends its shared
  thrust vector 8%/tick toward the nearest bonded non-player 'a' atom.
  Short range + gentle turn = aim assist, not lock-on. Verified in
  `dart-sim.ts` with the enemy placed 40 units off the firing line:
  the dart curved from y=250 to y≈264 and detonated at iter 52.
- **Kill feed:** `☠ Enemy down — N left` in the status line whenever
  the enemy loop count drops mid-match. Reports only new minimums —
  enemies replicate mid-match, so a bounce down after a division
  (5→6→5) is not a kill; a drop below the running minimum is.

## Iteration 3 — ammo economy, enemy threat, authoritative rejects

### Ammunition economy

- Darts cost **5 lysin atoms** (`DART_ATOMS`), drawn from a worker-side
  magazine. The match starts with **15 atoms = 3 darts**
  (`DART_AMMO_START`, shared via `snapshot.ts`), magazine capped at 50
  (`DART_AMMO_MAX` = 10 darts).
- **Pickup:** flying through ambient orange `p` atoms within
  `RADIUS × 2.2` of a player-controlled atom banks them (removed from
  the soup). Lysin spots become a strategic resource instead of pure
  scenery.
- The HUD dart line shows the magazine (`dart: READY · ammo 15`, or
  `dart: no lysin (N)` in red below 5); the pad gains an `empty` class
  (dimmed) when it can't fire.

### Enemy threat

- Enemies seek the player: enemy membrane atoms within 700 units get
  a weak per-tick velocity pull toward the player centroid
  (`ENEMY_SEEK_KICK 0.004`, evaluated every 10 iterations) — well below
  the steering bias, so the player can always outrun a pursuer.
- Contact damages the player: player membrane atoms with a bonded
  enemy `a` within `RADIUS × 2.5` roll a bite each check
  (`BITE_CASES 120`) — a hit debonds one S–S pair and frees the atom
  back to soup, the same breach lysin causes. Rare per tick, lethal
  on a sustained hug — the match now has real stakes, not just a
  shooting gallery.

### Authoritative rejection channel

- The fire gate lives in the worker. A mirrored client-side check can
  lag a snapshot — the first Playwright failures were presses swallowed
  by a stale `lysinAmmo = 0` from pre-match sandbox snapshots.
- Fix: the worker answers real rejects with a `fireRejected` message
  (`reason: 'ammo' | 'cooldown'`); the status line explains
  `Out of lysin — fly through orange p-atoms to rearm` or
  `Reloading…`. The main thread keeps the cooldown mirror only as a
  fast-path for the pad sweep — never as the gate.

### Test fixes discovered here

- `fire-pad.spec.js` waits on the pad's `--cd` CSS var (mirrors the
  live cooldown fraction). The snapshot lags the worker's `[WEAPON]`
  console line, so after each confirmed shot the test first waits for
  the reload to *engage* (non-zero) and only then for `0.000` —
  otherwise it reads the stale zero and presses into the real
  cooldown.
- Kill feed assert moved off the status text (transient, overwritten
  by other feeds) onto the deterministic worker log line.

## Iteration 4 — damage and hit feedback

- **`playerHit` message:** every successful enemy bite posts to the
  main thread, which drives a decaying red vignette
  (`damageFlash` 1→0 over ~400 ms, drawn fullscreen inside
  `drawGameHUD2D`) and a throttled `⚠ membrane breached — break
  contact!` status (max once per 2 s — bites arrive in bursts during
  a sustained hug).
- **`dartHit` message:** a dart detonation on enemy membrane posts
  `☄ direct hit — lysin cloud released` — before this, a shot that
  hit but didn't kill gave the player no confirmation at all.
- Verified: tsc, build, fire-pad spec green, 14/14 smoke tests,
  mobile-build BUILD SUCCESSFUL.

## Iteration 5 — enemy bearing tick

- The snapshot now carries `enemyDirX/Y` + `enemyDist`: the unit vector
  and distance from the player centroid to the nearest bonded enemy
  membrane atom.
- The fire pad renders it as a small glowing red tick on the rim
  (`#fire-enemy`), rotated with the same convention as the aim needle
  — lining a press up with the tick fires straight at the closest
  threat, including offscreen ones. Hidden when no enemy exists.
- Turns the pad into a real instrument instead of a blind trigger —
  pairs naturally with the 150-unit terminal homing window.
- Playwright asserts the tick is `shown` with a rotation once a match
  starts; verified visually (tick at bottom-left rim, needle aimed
  west, cooldown sweep draining).

## Iteration 6 — threat balancing, measured not guessed

`dev/playwright/threat-probe.cjs` starts a real match, never steers and
counts `[GAME]` bite logs + the end overlay — the live balance probe.

- **First tuning was two orders of magnitude too weak:** a 0.004 kick
  every 10 iterations produced **0 bites in 90 s** — thermal noise and
  bond springs ate the pull entirely.
- **The naive fix overshot:** a 0.005 kick every iteration killed the
  idle player in ~5 s. Root cause: bonded atoms keep their velocity
  (`bondedDamping = 1.0`), so ANY constant kick accumulates until
  `MAX_VELOCITY` (2.4/step) — kick magnitude only sets the spin-up
  time, enemies zoom at full speed either way.
- **Drag-seek model instead:** every iteration, each enemy membrane
  atom's velocity blends toward a small pursuit vector
  (`ENEMY_SEEK_SPEED 0.12` units/step, `ENEMY_SEEK_BLEND 0.003`).
  Velocity converges exponentially on a slow creep that noise can't
  defeat — and a steered player still outruns it.
- **Measured result:** idle player — first bite ~55 s, death ~60 s
  under bite cascade (the normal predator chemistry keeps grinding
  once the ring is breached). Passivity is punished, kiting survives.
- The 700-unit range gate was removed with the rewrite — enemies hunt
  across the whole arena.
- **Startup flicker fix:** the kill feed's `minEnemyCount` now seeds
  only after a 2.5 s warmup; loop detection can count a spawning cell
  as an extra loop for a frame and used to emit a false
  `☠ Enemy down` seconds into every match.
- Telemetry: `[GAME] nearest enemy N units` logs every 1200 iterations
  while a match runs, so approach speed stays observable.

## Iteration 7 — the full loop: lysin bearing + nearby supply drops

The fight probe (`fight-probe.cjs`) plays the real game loop: kite the
red bearing tick, fire along it when reloaded, steer to the amber dot
when the magazine is dry.

- **Lysin bearing:** snapshot adds `lysinDirX/Y` + `lysinDist` — the
  nearest *free* lysin atom (supply spots AND spent dart payloads both
  count; armed darts don't). Rendered as an amber rim dot
  (`#fire-lysin`): the pad is now a real compass — red = threat,
  amber = ammo, gold = aim.
- **Supply drops near the player:** `spawnLysinSpot()` used to drop
  35 atoms at a random arena position every 10k iters — unreachable
  while kiting (the fight probe never rearmed and died dry at ~70 s).
  Spots now land 300–800 units from the player centroid — still a
  risky dive (lysin eats your own membrane) but reachable.
- **Measured result (bot, crude aim):** 3 darts → 2 kills in the first
  ~15 s, rearm flythroughs net +1–2 atoms per pass (pickup radius is
  deliberately small), magazine rebuilt to 9, zero bites in ~90 s —
  the match is now winnable instead of a countdown.
- **Bug caught by the probe:** a `cnt`/`pcnt` typo in the bearing code
  crashed the worker's first in-game snapshot — the pad looked alive
  but the match was frozen (esbuild only; tsc caught it instantly).
  Lesson reinforced: tsc before every browser probe.

## Iteration 8 — end-of-match restart

The death/victory overlay was a dead end: `pointer-events: none`, no
buttons, and the only way out was the G shortcut (exit to sandbox,
then re-enter) — invisible to anyone who didn't know it.

- The overlay now carries **↻ play again** (primary) and **✕ sandbox**
  inside `#game-overlay-buttons` — the only clickable elements in the
  still click-through overlay.
- `restartMatch()` re-runs the worker's `startGame` path (fresh world,
  fresh magazine, follow re-armed, feed warmup reset) — identical to
  the first match start. Enter triggers it while the overlay is up.
- Verified with `restart-probe.cjs`: passive death → overlay with both
  buttons → Enter → overlay closes, enemy tick returns, new match live.

## Iteration 9 — bite grace

Probe data: first bite ~45 s → dead ~51 s. Once breached, the ring
couldn't realistically reseal — the worker-side bite rolls kept
compounding the hole faster than the normal reseal chemistry, so one
bite was effectively a death sentence.

- `BITE_GRACE_TICKS 240` (~0.5 s): after a successful bite the entire
  bite pass is skipped for the window. Breaking contact now pays off —
  the ring gets a real chance to reseal before the next breach lands.
  Sustained contact still kills through the normal predator chemistry
  (grace stops the *accelerant*, not the threat).
- `lastBiteIter` resets on match start and save-load like the other
  match clocks.

## Iteration 10 — win-ability tuning + proximity pulse

Two more probes refined the picture: a fully aggressive bot (hunt the
bearing to contact) dies in ~19 s — head-on approaches are suicide —
while the kiting fight bot's bottleneck was ammo throughput, not
survival (rearm→fire cycle ~45 s per dart, +1–2 atoms per flythrough).

- **Pickup radius** `RADIUS × 2.2 → ×3.5`: one spot flythrough now
  banks ~3 atoms (measured +3/pass), roughly a dart per pass instead
  of a dart per three passes.
- **Homing** 150 → 200 units, blend 8 % → 10 %/tick: long shots waste
  less of the scarce magazine — the probe scored 3 kills on 4 darts.
- **Proximity pulse:** the enemy bearing tick gets `data-dist` plus a
  `close` class below 220 units → the red tick blinks as the threat
  closes in (bite range is close behind). Also exposes distance to
  probes/tests.
- Balance readout so far: idle ~60 s · pure kiting ~50–90 s (swarm
  encircles) · fight+kite+rearm 90 s+ alive with 3 kills on a crude
  bot — hard but winnable; a human aims better than bearing-blind
  shots.
- `win-probe.cjs` / `fight-probe.cjs` stay in dev/playwright as the
  balance harnesses for future tuning.

## Iteration 11 — half-speed darts

Player feedback: the projectile crossed the screen too fast to read.
Physics subtlety — `DART_THRUST` is a constant per-step kick and
`bondedDamping` is 1.0, so the kick accumulates until the global
`MAX_VELOCITY` cap: the dart cruised at full cap regardless of thrust
size. The launch velocity `MAX_VELOCITY × 0.5` was already "half",
it just spooled up afterwards.

- `DART_SPEED = MAX_VELOCITY × 0.5` (1.2 u/step at RADIUS 6) is the
  new cruise target; `updateDarts` clamps cluster speed to it every
  tick while fuel lasts. Homing still steers the thrust vector — the
  clamp only caps magnitude, so turn authority is unchanged.
- dart-sim verifies: detonation iter 52 → 90 (~half speed over the
  ~170-unit approach incl. homing curve), enemy ring still destroyed,
  player intact. Effective range per fuel burn halves (~700 u) — still
  covers the fight space.

## Iteration 12 — doubled fire pad + mobile panel fix

Player feedback: the round fire pad was too small to aim comfortably.

- Pad 88 → 176 px; needle, enemy tick, lysin dot and center pip scaled
  proportionally (transform origins recomputed for the new radius).
  Direction math is radius-agnostic (atan2 on the press offset), so no
  code change was needed.
- Fix found while probing at a touch-width viewport: the control panel
  opens as a modal over `#panel-backdrop` on narrow screens, and the
  backdrop kept covering the pad after pressing Play — presses never
  reached it. `applyGameModeUI` now closes the panel on match start
  when the backdrop is shown (desktop docked panel is untouched).

## Iteration 13 — homing earned, move shimmer, arrow keys, burrow fuse

Player feedback: homing felt like a freebie — it should be earned or
cost extra lysin. Implemented the unlock path (costing ammo would
starve the already-tight economy):

- **Homing gate:** `homingUnlocked` starts false each match — darts fly
  dead straight until the FIRST confirmed detonation, then guidance
  goes online for the rest of the match (`updateDarts(…, homing)`).
  Snapshot carries `homingOn`; HUD dart line shows `· unguided` vs
  `· homing`, and a rising-edge status announces the unlock. Resets on
  startGame and save-load like the other match state.
- **Burrow fuse:** halving dart speed exposed a lethality regression —
  rim-level bursts scattered the lysin cloud *outward* and the ring
  resealed (one sim run: hit at the rim, ring intact 700 ticks later).
  Now first contact sets `detonateAtIter` (12-tick fuse ≈ 14 units at
  cruise), the cluster keeps thrusting into the membrane, and the burst
  erupts inside the ring. ~75 % single-dart kill rate in the seeded
  sim — not every hit kills, which is good design tension anyway.
- **Deterministic dart-sim:** monkey-patches `Math.random` with the
  same mulberry32 the worker uses — the lysin grind after a burst is
  reproducible now (seed 0xC0FFEE → PASS).
- **Movement shimmer:** `#fire-move` — a green conic wedge on the pad
  rim rotated to the live steering input (`--mdeg`, needle convention).
  `setMoveGlow` is called from both input funnels (`pushPlayerInput`,
  `pushSteerInput`), so WASD, arrows and canvas hold all light it; it
  clears the moment input stops or the steer target is reached.
- **Arrow keys:** `MOVE_KEYS` maps Arrows onto the same four direction
  flags as WASD (W+ArrowUp = one "up"), `preventDefault` stops page
  scroll. Hint + button help text updated.

### Why the cell crawls outside water (explanation)

Steering is *biased Brownian*, not a propulsion force: every step each
player atom gets a `PLAYER_KICK = 0.018` kick along 28 % input + 72 %
random direction. Outside a water droplet the kick is multiplied by
`DRY_THERMAL_FACTOR = 0.07` — ~14× weaker, by design ("dry = sluggish").
Inside a droplet the biased kicks accumulate (bondedDamping 1.0) toward
the cap in ~1 s; outside the same accumulation needs ~14 s and is
mostly drowned by random thermal kicks. That is why the dry arena feels
almost unsteerable and puddles feel normal. If the game arena should
be fair regardless of water, the dry factor for `playerControlled`
atoms could be raised — a design choice, not a bug.

## Iteration 14 — dry steering relief, panel order, first-visit intro

- **Dry steering:** the player kick got its own
  `DRY_PLAYER_FACTOR = 0.3` instead of sharing the ambient
  `DRY_THERMAL_FACTOR = 0.07`. Both factors only apply OUTSIDE a water
  droplet — inside water every kick is always full strength (×1.0), so
  the honest comparison for the player is dry 0.3 vs wet 1.0: steering
  on dry ground is now ~4× stronger than the old 0.07 yet still ~3×
  slower than swimming, keeping puddles tactically valuable. The 0.07
  ambient factor never touches the player anymore — it only calms soup
  jitter on dry land. Hand-tuned: 0.5 felt nearly wet-fast; 0.3 keeps
  dry ground honest while clearly responsive.
- **Panel order:** the Play Mode card moved above the Brushes card and
  is `always-visible` — game mode is the primary action, not a
  collapsed extra on mobile.
- **First-visit intro (DRY):** the game-over overlay doubles as a
  start choice — `overlayShownStatus = 3` swaps title/sub and relabels
  the same two buttons (`▶ start game`, `🧬 simulation`). `blocking`
  makes it a real modal; clicking the dim backdrop equals "simulation"
  (standard click-outside dismiss), Enter starts the game. The choice
  persists in `localStorage` (`evoloom-intro-v1`) — the overlay only
  reappears at game over/win. `restartMatch`/`toggleGame` handlers are
  context-aware on the shared buttons.
- **Spec isolation:** `dev/playwright/storage-state.json` pre-seeds the
  intro flag via `storageState` in the config — specs and CI never see
  the modal.

## Test plan

- Playwright: enter game mode → dispatch fire → assert projectile atoms
  exist, move outward in the fired direction, and reach an enemy ring;
  debug `console.log('[FIRE] …')` + `[WEAPON]` worker logs behind a
  debug flag for trajectory tracing.
- Small-sim unit probe via worker messages (spawn 2 cells close
  together, fire at point-blank, watch enemy loop count drop).

## Iteration 15 — lysovirus naming, membrane-edge spawn, steering ring

- **UI rename:** the weapon is presented to the player as the
  *lysovirus* — it injects lysin into an enemy membrane and lyses it
  from inside, matching the biological metaphor. HUD, tooltips,
  aria-labels and log lines updated; internal identifiers stay `dart`.
- **HUD readout is two lines:** `lysovirus: READY|reload Ns|no lysin`
  and `ammo N · unguided|homing · M in flight` — the cryptic `N out`
  atom counter is now a plain count of shots in flight.
- **Directional spawn edge:** `fireDart` projects BONDED player atoms
  inside a ±3.5R corridor around the aim ray onto the aim axis
  (`fireEdge`) — torn-off membrane scraps keep the player flag and
  skewed both centroid and edge, and the widest radius in any
  direction pushed spawns far past the aimed membrane edge. Clearance
  is 5×RADIUS so the innermost cluster satellite still clears
  REACTION_RANGE; a sideways-sliver ring falls back to the widest
  projection.
- **Steering ring:** the fire pad (176→229 px, moved below the stats
  box) now sits inside a `#steer-ring` annulus — a virtual joystick.
  Holding the ring sends the direction from pad center as a fixed
  `setPlayerInput` vector; while held it wins over WASD and canvas
  hold, releasing restores them. Steering and firing share one spot —
  ring for movement, pad for shots.

## Iteration 16 — only living enemy loops are dangerous

- **Problem:** seek, bite and the red bearing tick keyed on any bonded
  non-player `a` atom. Broken membrane scraps and empty husks left
  after a kill kept drifting toward the player, could still bite, and
  pulled the compass — dead material acted alive.
- **Fix:** `findMembraneLoopsAndPack` already decides which chains are
  living predators (closed ring + both `e`/`f` gene endpoints). It now
  also fills `liveEnemyAtoms` — the atom set of exactly those loops —
  on every snapshot. `updateEnemySeek`, `updateEnemyThreat` (bite
  roll) and the snapshot's nearest-enemy bearing all require
  membership, so loop-less scraps are inert: they don't hunt, don't
  bite and don't attract the tick. Win counting was already loop-based
  and stays consistent — the atoms of a killed cell stop being
  dangerous the same snapshot its loop stops counting.
- **Probe:** `ram-probe.cjs` steers continuously at the enemy bearing
  — a live loop rammed head-on still bites and kills (bite at ~17s,
  death ~21s), while husks drifting through the player interior deal
  no damage and no longer seek.
