# Evoloom: Game, Enemy and HUD Logic

> **Bottom line (open gameplay decision):** For a truly playable goal system, Evoloom still needs a deliberate way for the player to eliminate enemies — currently the S-membrane enemies only die passively from the periodic lysin spots. An active player weapon (e.g. placing/carrying lysin deliberately, or a new attack rule) would improve the game significantly.

## 1. Foundations

Evoloom is based on the Squirm3 reaction chemistry. The physics runs in a Web Worker. `dist/worker.js` is build output, not the actual source file. The relevant logic lives in the worker source. Chemistry initialization happens in `src/init.ts`.

## 2. Player cell

The player cell has a closed membrane made of atoms of type `a`.

| Atom type | State | Alias | Meaning |
|---|---:|---|---|
| `a` | 39 | `S` | normal player/prey membrane |
| `a` | 40 | `T` | tagged player membrane end |
| `d` | 41 | `E` | enzyme walk state |
| `a` | 42 | `Q` | normal predator membrane |
| `a` | 43 | `T_Q` | tagged predator membrane end |
| `a` | 44 | `FREED` | membrane atom freed from a prey membrane |
| `p` | 0 | | Lysin |

The player cell contains the gene chain `e b b a c b d f`.

## 3. Predator / enemy

Predators have a membrane of `a` atoms with `Q = 42` and a tagged end `T_Q = 43`. They only exist in the sandbox (predator toggle) — `setupGame()` spawns the five match enemies via `buildCell()`, i.e. normal prey cells with an `S` membrane and a gene chain, not `buildPredatorCell()` Q-predators.

Note: `buildPredatorCell()` also builds the gene chain `e b b a c b d f`, even though a comment in `init.ts` says predators should have no gene — an inconsistency between the comment and the code.

The enemy count is not simply the number of Q atoms (and there are no Q atoms in a match anyway). An enemy cell is recognized by cell detection as a closed ring with the required gene markers — in game mode, every living ring that is not ≥40 % player-owned counts as an enemy (see `findMembraneLoopsAndPack`).

## 4. How a predator damages the player

The key reaction is:

```text
a,S + a,S + a,Q -> S,FREED,Q
```

It breaks an S–S bond in the player membrane. One player membrane atom becomes `a,FREED`. The predator's Q atom is preserved. This rule only matters in the sandbox — no Q atoms exist during a match.

Predators can additionally absorb free `a` atoms and `a,FREED` atoms.

## 5. Can the player membrane damage a predator?

No — not with the current reaction chemistry.

The existing predator attack rule is one-sided: `S + S + Q -> S + FREED + Q`. It destroys an S–S bond of the player membrane. The Q atom stays unchanged.

There is no corresponding rule in `init.ts` that breaks a Q–Q bond.

## 6. Can lysin destroy a predator?

No.

The lysin reaction targets S-membrane bonds:

```text
a,S + a,S + p,0
```

Lysin (`p,0`) catalyzes the breaking of an S–S bond. The reaction does not contain a Q.

Therefore:

```text
lysin -> damages S membranes
lysin -> does not damage Q membranes
```

In game mode this cuts the other way: since the enemies are S-membrane prey cells, lysin dissolves their membranes just as it does the player's.

## 7. What can destroy a membrane in a match?

No cell-versus-cell attack rule exists. The membrane hazards in a match are:

1. Lysin spots spawned every `10000` ticks (~21 s) via `spawnLysinSpot` — they break S–S bonds of **any** prey cell, player or enemy.
2. Nothing else: noise and hydrolysis are suspended for the duration of a match.

Enemies are therefore eliminated by lysin exposure, not by a player attack. The player has no active weapon — survival and victory are passive.

## 8. Win condition

The worker logic counts the currently detected enemies.

When `enemyCount === 0`, the win countdown starts. It uses `2400` iterations, roughly five seconds at the intended tick rate.

If an enemy is detected again during that time, the countdown resets. Only after the full duration is `gameStatus = 1` set.

**Winning = eliminate all enemies and then have no enemy for about five seconds.**

## 9. Lose condition

The player's own cell consists of the S/T membrane. Lysin can break S–S bonds (in the sandbox, predator attacks too). If the player's cell is damaged so badly that no valid player cell is detected any more, the lose state is entered — after a 480-iteration grace window, since membranes open transiently while dividing or reshaping.

## 10. Values for the HUD

The worker provides these values in every snapshot:

```text
playerCount           living player cells
enemyCount            living enemy cells
winCountdownIter      remaining iterations of the win timer
loseCountdownIter     remaining iterations of the 480-tick death window
playerMembraneFrac    share of player 'a' atoms inside the closed ring, 0..1
gameStatus            0 playing, 1 won, 2 lost
```

The enemy count must not be computed from atom types — it comes straight from the worker's loop detection.

## 11. HUD

Top left, the HUD shows the actual goal and the immediate danger (`drawGameHUD2D` in `renderer-2d.ts`):

```text
enemies:  5
you:      142 atoms
membrane: ██████░░ 74%
victory in 4.1s
```

`enemyCount` is displayed once. The player's size is the count of `playerControlled` atoms — growth the player can see. The membrane bar renders `playerMembraneFrac` color-coded: torn-off membrane atoms keep the player flag outside the closed ring, so the sealed fraction drops as the cell is breached, well before the loop is gone. The status line shows the victory countdown, the "membrane down" death timer, or the end state.

## 12. Key design finding

The chemistry is asymmetric for sandbox predators:

```text
PREDATOR
    |
    | attacks
    v
PLAYER MEMBRANE
    S-S -> damaged
```

but not the other way around:

```text
PLAYER
    |
    X
    |
    v
PREDATOR MEMBRANE
    Q-Q -> no existing destruction rule
```

Lysin also attacks S, not Q. In game mode there is no direct attack at all in either direction — the only lethal agent is lysin, and it hits every prey cell equally.

So if the player is supposed to actively eliminate enemies, Evoloom needs an additional mechanic or reaction rule.

## 13. Possible new mechanic

If the goal should be "survive, grow and eliminate all enemies", the player needs a way to damage enemy membranes.

A direct counter-reaction could conceptually be something like:

```text
S + S + <player enzyme> -> S + FREED + <player enzyme>
```

a player-side catalyst that breaks S–S bonds — lysin-like, but produced or carried by the player cell. It would be a **new game mechanic**, not part of the current `init.ts` chemistry, and would need to be designed so that it does not eat the player's own membrane or make every contact mutually destructive.

## 14. Data flow

```text
Reaction chemistry
      |
      v
Physics worker
      |
      v
Cell detection
      |
      +---- playerCount
      +---- enemyCount
      +---- winCountdownIter
      +---- loseCountdownIter
      +---- playerMembraneFrac
      +---- gameStatus
      |
      v
Frontend / HUD
```

The game-status logic lives exclusively in the worker; the frontend only renders the snapshot fields.

## 15. Key takeaways

1. `S = 39` is the normal player/prey membrane.
2. `Q = 42` is the normal predator membrane — sandbox only, no Q atoms spawn in a match.
3. Predator attacks destroy S–S bonds.
4. Lysin also destroys S–S bonds — including enemy membranes in game mode.
5. No reaction destroys a Q–Q bond.
6. In game mode there is no cell-versus-cell attack rule at all.
7. The enemy count is determined via detected living cells, not atom counts.
8. `enemyCount === 0` starts the 2400-iteration (~5 s) win countdown.
9. Losing all player loops starts the 480-iteration (~1 s) death grace window.
10. `gameStatus = 1` / `2` signals victory / defeat.
11. The HUD renders the worker's snapshot fields directly — nothing is recomputed in the frontend.
12. For a truly playable goal system Evoloom still needs a deliberate way to eliminate enemies — currently S-membrane enemies only die passively from the periodic lysin spots. An active player weapon (e.g. placing/carrying lysin deliberately, or a new attack rule) would improve the game significantly. (OPEN — gameplay design decision)
