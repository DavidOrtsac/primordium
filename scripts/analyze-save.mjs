// Analyze a Primordium save file: count atoms / bonds / droplets, detect every
// closed `a`-`a` membrane loop in the bond graph, and check which loops
// geometrically enclose the centroids of other loops (i.e. meta-membrane
// formation — one closed membrane wrapping a cluster of intact protocells).
//
// Usage:  node scripts/analyze-save.mjs samples/meta-membrane-iter157068-seed1.json
import { readFileSync } from 'fs';
const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/analyze-save.mjs <save.json>');
  process.exit(1);
}
const s = JSON.parse(readFileSync(path, 'utf8'));
console.log('=== Save metadata ===');
console.log(`magic=${s.magic} version=${s.version} savedAt=${s.savedAt}`);
console.log(`iter=${s.iterations} seed=${s.seed} grid=${s.gridW}x${s.gridH}`);
console.log(`atoms=${s.cellX.length} bonds=${s.bonds.length/2} droplets=${s.dropX.length}`);

// Build adjacency for membrane atoms only ('a' atoms with state >= some threshold,
// but in Squirm3 membrane atoms are type 'a' and bonded — let's just look at 'a' atoms)
const N = s.cellX.length;
const adj = Array.from({length: N}, () => []);
for (let b = 0; b < s.bonds.length; b += 2) {
  const i = s.bonds[b], j = s.bonds[b+1];
  adj[i].push(j); adj[j].push(i);
}

// Find closed `a-a` loops, just like the worker's findMembraneLoopsAndPack does.
// An atom is on a membrane loop if it's type 'a' and has exactly 2 'a' neighbors.
const isA = i => s.cellType[i] === 'a';
const visited = new Set();
const loops = []; // each loop is an array of atom indices, ordered around the chain

for (let start = 0; start < N; start++) {
  if (!isA(start) || visited.has(start)) continue;
  // Find two 'a' neighbors
  const aNeighbors = adj[start].filter(isA);
  if (aNeighbors.length !== 2) continue;

  const chain = [start];
  let prev = start, curr = aNeighbors[0];
  while (curr !== start && chain.length < 5000) {
    chain.push(curr);
    const nexts = adj[curr].filter(n => isA(n) && n !== prev);
    if (nexts.length === 0) break;
    prev = curr;
    curr = nexts[0];
  }
  if (curr === start && chain.length >= 4) {
    for (const c of chain) visited.add(c);
    loops.push(chain);
  }
}

console.log(`\n=== Membrane loops detected ===`);
console.log(`total loops: ${loops.length}`);
loops.forEach((loop, i) => {
  // Bounding box
  let xmin=1e9,ymin=1e9,xmax=-1e9,ymax=-1e9;
  for (const idx of loop) {
    const x = s.cellX[idx], y = s.cellY[idx];
    if (x<xmin) xmin=x; if (x>xmax) xmax=x;
    if (y<ymin) ymin=y; if (y>ymax) ymax=y;
  }
  const cx = (xmin+xmax)/2, cy = (ymin+ymax)/2;
  const w = xmax-xmin, h = ymax-ymin;
  console.log(`  loop ${i}: ${loop.length} atoms · bbox center (${cx.toFixed(0)},${cy.toFixed(0)}) · size ${w.toFixed(0)}×${h.toFixed(0)}`);
});

// Containment check: ray-casting point-in-polygon for each loop's center
// against every other loop's polygon.
function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i=0, j=poly.length-1; i<poly.length; j=i++) {
    const xi=poly[i][0], yi=poly[i][1];
    const xj=poly[j][0], yj=poly[j][1];
    const intersect = ((yi>py) !== (yj>py)) && (px < (xj-xi)*(py-yi)/(yj-yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

const polys = loops.map(loop => loop.map(idx => [s.cellX[idx], s.cellY[idx]]));
const centers = loops.map(loop => {
  let sx=0, sy=0; for (const idx of loop) { sx += s.cellX[idx]; sy += s.cellY[idx]; }
  return [sx/loop.length, sy/loop.length];
});

console.log(`\n=== Hierarchical containment check ===`);
let foundAny = false;
for (let outer = 0; outer < loops.length; outer++) {
  const contained = [];
  for (let inner = 0; inner < loops.length; inner++) {
    if (inner === outer) continue;
    if (pointInPolygon(centers[inner][0], centers[inner][1], polys[outer])) {
      contained.push(inner);
    }
  }
  if (contained.length > 0) {
    foundAny = true;
    console.log(`  ★ Loop ${outer} (${loops[outer].length} atoms) ENCLOSES loops: [${contained.join(', ')}] (${contained.length} inner protocells)`);
  }
}
if (!foundAny) console.log('  No loop contains the centroid of another loop.');
