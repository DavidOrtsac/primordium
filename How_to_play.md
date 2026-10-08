# Primordium — Manual

Primordium is an artificial chemistry: a 2D world filled with thousands
of atoms drifting in Brownian motion. Every atom has a **type**
(`a`–`f`, `w`, `p`), a numeric **state**, and can form **bonds** with
neighbors. Whenever atoms bump into each other, a small table of
reaction rules fires: each rule pattern-matches on the atoms' types,
states and existing bonds, then flips states and creates or breaks
bonds — sometimes only with a probability.

That is all the physics there is. What makes it special is what that
chemistry *produces*:

- **Membranes emerge.** `a` atoms polymerize into chains; when a chain
  closes into a loop it becomes a physical container — membrane
  elasticity sheds atoms when crumpled and absorbs free soup atoms when
  stretched.
- **Genes are matter.** A genome is a literal strand of bonded atoms
  (`e-b-b-a-c-b-d-f`) tethered to the membrane. A free `d` atom acts as
  a polymerase: it lands on the strand start (`e`), walks the template
  base by base and builds a copy — replication is mechanical, not a
  scripted "reproduce" call.
- **Cells divide.** When the polymerase reaches the strand end (`f`), a
  reaction cascade splits the cell into two daughters. The whole life
  cycle — membrane growth, genome copying, division — falls out of a
  few dozen local reaction rules.
- **Evolution is real.** Noise sliders inject copy misfires, decay and
  bond failures; mutated strands produce different cells, and cells
  compete for soup atoms. Documented emergent behavior already goes
  beyond the published research — see the spontaneously formed
  meta-membrane enclosing whole cell clusters in `samples/`.
- **Nothing is hardcoded as "a cell".** There is no cell object in the
  engine — a cell is a self-maintaining pattern in the bond graph. You
  can watch one be born, copy its genome, split, starve, be eaten by a
  predator or dissolved by lysin.

The sim doubles as a research instrument: pause anywhere, inspect any
structure atom-by-atom, rewrite the chemistry live in the Lab, and
export exact, bit-identical save states.

This manual mirrors the in-app docs (controls panel, shortcuts card,
atom dictionary).

## Getting started

1. Build and serve the project over HTTP (workers need an origin):
   `bash run.sh` builds and serves for you; for the manual variant run
   `npm run build` once, then `python3 -m http.server 9131` and open
   `http://localhost:9131/`.
2. The sim starts with a seeded soup. Watch protocells emerge on their
   own — or open the **Controls** panel (`M` / ☰ button) to intervene.
3. First time? Click the **?** button (top right) or **🎓 Tutorial** in
   the panel — a guided tour with real tasks on the field: it only
   advances once you have paused the sim, selected atoms, opened the
   inspector, painted soup and water, released lysin and entered play
   mode. A scripted demo pastes a real protocell mid-tour, and the tour
   ends inside the game — you can just keep steering.

### The manual in-game

The same documentation is built into the app — you never have to leave it:

- `M` (or the ☰ button) opens the **Controls** panel: every section card
  carries inline hints, and the **Shortcuts** card lists all keybinds.
- The **⚗️ Custom chemistry editor** button (Lab section of the panel)
  opens the Lab modal; its **📖 Dictionary** tab explains every atom in
  plain English — custom atoms included.

### Learn the physics

New to artificial chemistries? [Organic Builder](https://github.com/rubo77/OrganicBuilder)
is a free step-by-step tutorial app that teaches this exact
atom/state/bond reaction model through small, playable challenges —
the fastest way to understand what Primordium's soup is doing.

## Views

`V` cycles three render modes:

- **Educational** — legend + bonds + bezier membranes (default)
- **Microscope** — microscope-styled render pass
- **Classic** — Squirm3-style classic look

## Controls panel

### View · Playback
- **Pause** (`Space`) — pause/resume the sim
- **View** (`V`) — cycle render mode
- **● REC** (`R`) — record the canvas as a video

### Brushes · Tools
- **Soup brush** (`B`) — paint free soup atoms into the world
- **Water brush** (`W`) — paint water droplets
- **Clear water** (`C`) — remove all water
- **Select atom** — click an atom to select; `Del` deletes it
- **Lysin** (`P`) — seed/remove lysin; membranes dissolve on contact

### World · Replenishment
- **Drip** — periodic replenishment; sliders set intervals in ticks
  (soup 100–3000, default 700 · water 500–15000, default 4250)
- **Seed** — reseed the PRNG and restart

### Physics
- **speed** — simulation rate (5–100%, default 100%); lower values
  stretch steps into smooth slow motion
- **soup** — soup density (0–100%, default 60)
- **damp** — bonded-atom damping (0.50–1.00)

### Lab
- **Noise** (`N`) — mutagenic noise sliders: `copy` (copy misfires),
  `decay` (random decay), `bond` (bond failures), 0–1000 each
- **Hydrolysis** (`H`) — water-driven bond cleavage; `rate` multiplier
  and `density` threshold
- **Open inspector** (`I`) — frozen view of the current selection
- **Paste from JSON** — drop a saved selection at view center
- **Custom chemistry editor** — define your own atoms and rules

### Archive · Export
- **Save / Load** — full sim state as JSON (atoms, bonds, droplets,
  RNG state, parameters — reload is bit-identical, PRNG cursor included)
- **Reset simulation** — wipe and restart
- **stats CSV** — population/loop statistics log, exportable
- **events CSV** — event log (noise misfires, bond failures, …)

## Play mode — steer a microbe

`G` toggles the game mode: you control a green microbe.

- **Press & hold on the canvas** steers the microbe toward the pointer
  — works with mouse or touch
- **WASD / arrow keys** provide the same steering bias as a desktop
  alternative — a nudge, not propulsion
- Periodic **soup/water spawns** keep you fed; **lysin micro-spots**
  appear every ~10,000 ticks and dissolve membranes on contact
- A membrane loop counts as **yours** when ≥ 40 % of its atoms are
  player-controlled
- **Win** 🏆 — no *fully alive* enemy cells (closed membrane with both
  gene endpoints bonded) survive for ~5 seconds
- **Lose** ☠ — all your cells are lysed

### The command pad (steering + firing in one spot)

The circle top-center replaces the sandbox legend while playing:

- **Inner pad = fire.** Press anywhere inside it — the press position
  is the aim: pressing its right edge fires right, its top fires up.
  A thin **needle** shows the last aim, and a radial **cooldown sweep**
  covers the pad while reloading (~1.5 s); the pad dims when you run
  out of lysin.
- **Outer ring = steer.** The recessed groove around the pad is a
  second joystick: hold it and the microbe swims toward that direction
  — two fingers can steer and fire at once. The translucent **marble**
  rolling in the groove marks your current movement direction (WASD,
  arrows and canvas holds move it too).
- **Red tick = nearest living enemy**, bearing only — it blinks faster
  once a foe closes under ~220 units. **Amber dot = nearest free
  lysin** for rearming. A press aligned with the tick fires straight
  at that enemy.
- **Green wedge** = the direction your cell is actually moving.

### Lysoviruses — your weapon

Your ammunition is **lysin** (`p` atoms): each shot packs 5 of them
into a bonded **lysovirus** that bursts a membrane open like a
real phage lysing a cell.

- A shot costs **5 lysin**; you start with **15** (3 shots), magazine
  cap **50** (10 shots). Fly through loose orange `p` atoms to rearm —
  including the payload of missed shots, which stays collectable.
- The lysovirus launches just outside your membrane, straight along
  your aim, burns for ~1.25 s, then drifts on. On membrane contact it
  **burrows in for a moment, then detonates inside the ring** —
  releasing lysin where it dissolves the cell from within.
- **Homing unlocks on your first confirmed kill**: from then on every
  shot curves gently toward enemy membrane within ~200 units. Until
  then shots fly unguided, so aim along the red tick.
- Enemies fight back: only a *complete* enemy — a closed membrane loop
  carrying both gene endpoints — hunts you and can bite. Contact can
  break one of your membrane bonds (a red vignette flashes; a ~0.5 s
  grace follows each bite). Broken membrane scraps are inert — they
  drift, but can't chase, bite, or attract the red tick.

### HUD lines & timers (top left)

```
enemies: 4                     ← living enemy loops (win target)
you:      128 atoms            ← your cell's atom count
membrane: ██████░░ 78%         ← sealed fraction — green ≥66%, amber
                                 ≥33%, red below; drops the moment a
                                 bite tears the ring
lysovirus: reload 0.8s         ← READY / reload countdown / no lysin
ammo 10 · homing · 1 in flight ← lysin atoms · guidance · shots out
victory in 3.2s                ← status line, see below
```

The bottom **status line** carries the match clocks:

- `wipe out every enemy` — normal state
- `victory in Ns` — every enemy loop is gone; survive the last ~5 s
  for the win (a new enemy division resets the clock)
- `membrane down — reseal in Ns!` — your loop is broken; you have ~1 s
  to let it reseal before you're counted as lysed

All countdowns follow the **speed slider** — slow motion stretches
them along with the sim.

## Atom dictionary

Built-in atoms (`a`–`f`, `w`, `p`) — wildcards `x`/`y`/`z` are reserved
for rule matching:

| Atom | Role |
|------|------|
| `a` | **Membrane unit** — structural building block of cell walls. A closed loop of `a` atoms *is* the membrane. Lysin (`p`) and water break `a`-`a` bonds. In state 38 it doubles as a gene base. Analogue: peptidoglycan. |
| `b` | **Common gene base** — most frequent base in the genome strand (template `e-b-b-a-c-b-d-f`). The polymerase walks past it. Analogue: adenine/thymine. |
| `c` | **Rare gene base** — appears once in the default template; functionally identical to `b` but rarer. Analogue: cytosine/guanine. |
| `d` | **Polymerase enzyme** — walks a gene strand (state 41) copying it base-by-base; releases at `f`. `d` is both the enzyme and a residue of the gene encoding it — like real DNA polymerase. |
| `e` | **Gene start** — marks one strand end, anchored to a T-tagged membrane atom (chromosome tethered to the wall, like oriC). Replication starts here. |
| `f` | **Gene end** — marks the other end, anchored opposite. Polymerase reaching `f` releases the strand and triggers division into two daughter cells. Analogue: ter site + FtsZ divisome. |
| `w` | **Water** — droplets held by surface tension. Fresh water (state 0) can cleave one non-protected bond per tick, then becomes spent (state 1). Mass-conserving; live-cell membranes are immune. |
| `p` | **Lysin** — catalyst that cleaves `a`-`a` membrane bonds while free; never consumed. Only active when *unbonded* — force-bonded lysin is inert. Analogue: lysozyme / phage endolysin. |

## Selection inspector

Select an atom (`Select atom` brush), then open with `I`:

- Read-only frozen view with stats; sim keeps running underneath
- **Edit** mode — tools to `＋ Add`, `⎯ Bond`, `✕ Delete` atoms with a
  type palette and state input; edits apply to the live sim
- **Replace** — swap every atom of a source type in the entire sim
- **Download / Load JSON** — save selections, reload in future runs,
  paste via `📥 Paste` (drops at view center, bonds preserved)

## Custom chemistry editor (⚗️ Lab)

- **Custom atoms** — `a`–`f`, `w`, `p`, `x`–`z` are reserved; new atoms
  get an uppercase letter or digit. Without rules they are inert.
- **Custom rules** — fire *after* built-in chemistry; they can never
  override or remove seeded reactions. 2-input or 3-input reactants;
  `Cases` is the probability denominator (1 = always, 100 ≈ 1 % per
  encounter). Rules can flip states and create/break bonds.
- **Dictionary tab** — every atom explained in plain English; custom
  atoms get auto-generated descriptions from your rules.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `M` | open / close the controls panel |
| `Space` | pause / resume |
| `V` | cycle view (Educational → Microscope → Classic) |
| `B` | soup brush |
| `W` | water brush |
| `C` | clear all water |
| `P` | lysin on / off |
| `R` | record video |
| `G` | play mode (steer a microbe) |
| `WASD` / arrows | steer the microbe (play mode) |
| `N` | noise on / off |
| `H` | hydrolysis on / off |
| `,` | quicksave |
| `.` | quickload |
| `Q` | freeze (pause + zero noise + quicksave) |
| `Del` | delete selected atom (in Select mode) |
| `Esc` | close panel / back to pan |
| drag | pan camera |
| wheel | zoom under cursor |
| 2-finger | pinch to zoom (touch) |

## Persistence

- **Autosave** — periodic snapshots to `localStorage`; a closed tab
  returns to nearly the same state (skipped while paused)
- **Save files** — full sim state JSON; reload produces bit-identical
  evolution from the stored PRNG cursor
- **Samples** — `samples/` contains a documented meta-membrane
  formation sequence (see `samples/README.md`)
