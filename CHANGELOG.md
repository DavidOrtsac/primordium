# Changelog

All notable changes to this project are documented here.
This fork continues development of upstream Primordium.

## [Unreleased]

### Game mode
- **Press-to-steer**: press-and-hold on the canvas (mouse or touch)
  steers the microbe toward the pointer; WASD stays as a desktop
  alternative. Two-finger pinch still pans/zooms.
- **Game HUD** replaces the sandbox stats while a match runs: enemy
  count, player size (playerControlled atoms), a membrane-integrity
  bar (share of player `a` atoms sealed in the closed ring), and
  color-coded win/lose countdowns. The worker now exports
  `loseCountdownIter` and `playerMembraneFrac`.
- Pause stays visible during a match; match hazards are isolated from
  sandbox toggles; a 480-tick grace window covers transient membrane
  openings.
- Saves loaded outside a match no longer resurrect player-tinted atoms
  (autosave reload bug).
 
### Camera & UI
- Camera follow mode (`F`) with eased tweens; game start auto-selects
  an atom and arms follow; wheel/pinch no longer releases follow.
- Collapsible stats/legend HUD with a corner toggle; hover/long-press
  help hints; floating popups (info, tutorial) rise to top z-layer.
- Canvas fills the full window width; zoomed-out arena pins top-left
  with a gray margin; zoom can't go past arena fit.
 
### Tutorial & learning
- Interactive step-by-step tutorial, evolved into a task-gated guided
  tour (protocell drop selects, pauses, zooms, follows).
- Learn card: tutorial + atom dictionary, teach-the-dictionary flow.
- German manual translation (`How_to_play_de.md`).
 
### Mobile / packaging
- Capacitor wrapper for Android/iOS, `mobile-build.sh`, `run.sh`, and
  Node smoke tests for the Capacitor pipeline.
- Mobile polish: full-width canvas in portrait, pinned control panel,
  menu-integrated fullscreen/tutorial, hidden keyboard hints.
 
### Performance & sandbox
- ~3x faster physics (crowding pass shares the slot gather).
- Speed slider is now a sim-rate control with adaptive pacing;
  burn progress reports inside chunks and restarts extend it.
- Select brush on `S`, ON/OFF badges on soup/water brushes, `,`/`.`
  quicksave/quickload rebinding for QWERTZ keyboards.
