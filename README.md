# Primordium

A high-performance fork of Tim Hutton's **Squirm3** artificial-life system,
with a microbe-steering game mode, water/soup brushes, surface-tension
droplet physics, and WebGPU rendering.

**Live version:** <https://primordium.transcendiant.net/>

See [How_to_play.md](./How_to_play.md) for the full manual (controls,
play mode, atom dictionary, shortcuts) — deutsche Version:
[How_to_play_de.md](./How_to_play_de.md).

## Credits

- **This fork (Primordium):** David Castro, 2026 — <https://github.com/DavidOrtsac/primordium>
- **Original Squirm3:** Tim Hutton, 2007 — <https://github.com/timhutton/squirm3>

## Relationship to the original Squirm3

This repository is a complete TypeScript port of Hutton's original
C++/SDL codebase — **not a git fork**. The physics/chemistry semantics follow the original.

- Original repo: <https://github.com/timhutton/squirm3>
- Original live demo (Emscripten/WASM build): <https://timhutton.github.io/squirm3>
- Primordium repo (this repository's `origin` remote): <https://github.com/DavidOrtsac/primordium>
- Primordium live demo: <https://davidortsac.github.io/primordium/>

## References

- Hutton T.J. (2007) _Evolvable Self-Reproducing Cells in a
  Two-Dimensional Artificial Chemistry._ Artificial Life 13(1): 11–30.
  [PDF](http://www.sq3.org.uk/papers/cells2007.pdf)
- Hutton T.J. (2004) _A Functional Self-Reproducing Cell in a
  Two-Dimensional Artificial Chemistry._ Artificial Life IX, MIT Press.
- Hutton T.J. (2002) _Evolvable Self-Replicating Molecules in an
  Artificial Chemistry._ Artificial Life 8(4): 341–356.
  [PubMed](https://pubmed.ncbi.nlm.nih.gov/12650644/) ·
  [PDF](https://faculty.cc.gatech.edu/~turk/bio_sim/articles/hutton_rep_molecules.pdf)

## License

This program is free software: you can redistribute it and/or modify it
under the terms of the **GNU General Public License v3** as published by the
Free Software Foundation. See [LICENSE](./LICENSE) for the full text.

The original Squirm3 is GPL-3.0; this derivative work inherits that license.

## What's added on top of Squirm3

- TypeScript port of the C++/SDL original
- Physics moved into a Web Worker (decoupled from the render loop)
- WebGPU renderer with a Canvas 2D fallback
- Water droplets with surface tension, merging, and dry/wet thermal gating
- Soup and water brushes (mouse-painted)
- Camera pan + wheel zoom over a larger arena
- Microbe-steering game mode: WASD biases your cell's Brownian motion,
  with periodic soup/water/lysin spawns and win/lose detection

## Build

```bash
npm install
npm run build
# serve locally (workers need an HTTP origin):
python3 -m http.server 9131
# open http://localhost:9131/
```
