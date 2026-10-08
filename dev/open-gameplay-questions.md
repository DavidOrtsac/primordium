# Open gameplay questions for the original developer

This is not implementation documentation — it is a review of the game mode
from someone who analyzed the worker logic while building the game HUD.
Did I read this correctly? And was the game maybe left unfinished, without
a real way to win by playing?

## What I think the win/lose rules are

- A cell counts as **alive** only when it is a closed `a`-membrane ring
  (≥4 atoms) with both gene markers `e` and `f` bonded to it.
- A ring is **yours** when ≥40 % of its atoms carry the `playerControlled`
  flag; every other living ring counts as an enemy.
- **Win:** `enemyCount === 0` for 2400 iterations (~5 s). Any enemy
  reappearing resets the timer.
- **Lose:** no living player ring for 480 iterations (~1 s grace for
  membranes opening during division).
- Dictionary check: `S=39` prey membrane, `T=40` tagged end, `E=41`
  enzyme, `Q=42`/`T_Q=43` predator membrane, `FREED=44` torn-off prey
  atom, `p,0` lysin — consistent with what `init.ts` actually registers.

## What the HUD shows now

`enemies: N` — `you: K atoms` (playerControlled count) —
`membrane: ██░ P%` (share of player `a` atoms inside the closed ring) —
status line for the win countdown / membrane-down timer / end state.

## How you can actually win right now

As far as I can tell: **only passively**. `setupGame()` spawns the five
enemies via `buildCell()` — S-membrane prey cells identical to yours.
There are no Q-predators in a match, and no rule lets one prey cell
attack another. The only lethal agent is the lysin spot that spawns
every ~21 s, and it breaks S–S bonds of **every** prey cell equally —
yours included. So the game is: survive the same lysin that slowly
dissolves the enemies, and hope they die before you do.

## What looks missing or questionable

1. **No player weapon.** No reaction targets enemy membranes, and lysin
   cannot be carried, aimed, or produced by the player. Was an attack
   mechanic planned and never finished?
2. **Enemies replicate.** They carry the full `e b b a c b d f` gene —
   so they can divide and raise `enemyCount` again. Can lysin plausibly
   outpace their replication, or is a match sometimes unwinnable?
3. **Dead chemistry in game mode.** The whole Q/T_Q/FREED predator
   machinery exists in `init.ts` but never spawns in a match —
   leftover from an earlier design?
4. **`buildPredatorCell()` builds a gene** even though the comment says
   predators should have none — inconsistency or intentional?
5. **The ≥40 % ownership flip** converts an enemy ring into a player
   ring. Designed mechanic (feeding atoms to assimilate enemies) or an
   emergent side effect?
6. **Balance:** is `LOSE_NO_PLAYER_TICKS = 480` (~1 s) fair when one
   lysin spot can dissolve large membrane sections at once?

Ideas in case the game is indeed unfinished: a player-produced enzyme
that lyses S–S bonds (lysin that only the player benefits from),
steerable/carriable lysin packets, or enemies that are actual
Q-predators with a counter-rule the player can trigger.
