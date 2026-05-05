# Primordium

A high-performance fork of Tim Hutton's **Squirm3** artificial-life system,
with a microbe-steering game mode, water/soup brushes, surface-tension
droplet physics, and WebGPU rendering.

## Credits

- **This fork (Primordium):** David Castro, 2026
- **Original Squirm3:** Tim Hutton, 2007 — <https://github.com/timhutton/squirm3>
- **Reference paper:** Hutton T.J. (2007) _Evolvable Self-Reproducing Cells in
  a Two-Dimensional Artificial Chemistry._ Artificial Life 13(1): 11–30.

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
