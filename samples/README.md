# Sample saves — meta-membrane formation

These are full simulation states (atoms, bonds, droplets, RNG state, all
parameters) captured at three iterations of a single seeded run, all from
seed = 1. They document a phenomenon that does not appear in Hutton's
2002 or 2007 Squirm3 papers: **a closed `a`-`a` membrane loop spontaneously
forming around a cluster of already-existing protocells, each with their
own intact membrane**. The Squirm3 polymerization rule is scale-agnostic,
so this is consistent with the chemistry — it just requires the soup
density and run length to be high enough for a larger ring to close around
an existing cluster.

## Sequence

The three files capture the same outer membrane growing over time and
accumulating inner protocells:

| File | Iteration | Outer loop | Inner protocells |
|------|-----------|------------|------------------|
| `meta-membrane-iter117632-seed1.json` | 117,632 | (forming) | 1 |
| `meta-membrane-iter140920-seed1.json` | 140,920 | 69 atoms  | 2 |
| `meta-membrane-iter157068-seed1.json` | 157,068 | 78 atoms  | 4 |

For comparison, a typical single-cell membrane in the same run is
14–30 atoms, so the outer loop is structurally distinct, not just a
larger-than-average single cell.

## Reproducing

1. Open the live demo: https://davidortsac.github.io/primordium/
2. Click **Load** in the controls bar and pick any of the three JSON files.
3. The simulation rebuilds the exact state, including the PRNG cursor, so
   future evolution is bit-identical to what was originally observed.

## Verifying the structure

To confirm the meta-membrane structure is in the bond graph (not a render
artifact), run the analysis script:

```bash
node scripts/analyze-save.mjs samples/meta-membrane-iter157068-seed1.json
```

The script walks the bond graph, finds every closed `a`-`a` chain, and
runs a point-in-polygon containment test to identify which loops
geometrically enclose other loops' centroids.
