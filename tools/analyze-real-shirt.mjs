import fs from 'node:fs';
import path from 'node:path';
import { createSurface, placeTshirtOnCage } from '../src/cage-engine.js';

const root = path.resolve(import.meta.dirname, '..');
const shirt = JSON.parse(fs.readFileSync(path.join(root, 'assets/roblox-tshirt.json')));
const cage = JSON.parse(fs.readFileSync(path.join(root, 'assets/roblox-cage.json'))).inner;
const seed = JSON.parse(fs.readFileSync(path.join(root, 'assets/blocky-cage-target.json')));
const allowed = ['UpperTorso', 'LowerTorso', 'LeftUpperArm', 'RightUpperArm'];
const groups = [];
for (let face = 0; face < cage.indices.length; face += 3) {
  const votes = new Map();
  for (let j = 0; j < 3; j++) for (const weight of seed.influences[cage.indices[face + j]]) votes.set(weight.name, (votes.get(weight.name) ?? 0) + weight.weight);
  groups.push([...votes].sort((a, b) => b[1] - a[1])[0][0]);
}
const surface = createSurface({ ...cage, triangleGroups: groups });
const placed = placeTshirtOnCage(shirt, cage);
const baseline = [], rows = [];
for (let i = 0; i < placed.positions.length / 3; i++) {
  const p = Array.from(placed.positions.slice(i * 3, i * 3 + 3));
  const hits = surface.closest(p, 4, allowed), votes = new Map();
  for (const hit of hits) {
    const influence = 1 / (Math.sqrt(hit.distance2) + .015) ** 2;
    hit.triangle.ids.forEach((id, corner) => seed.influences[id].forEach(weight => {
      if (allowed.includes(weight.name)) votes.set(weight.name, (votes.get(weight.name) ?? 0) + influence * hit.bary[corner] * weight.weight);
    }));
  }
  const sorted = [...votes].sort((a, b) => b[1] - a[1]), total = sorted.reduce((sum, [, weight]) => sum + weight, 0);
  baseline.push({ id: i, sourcePosition: p, dominant: sorted[0][0], groups: sorted.filter(([, weight]) => weight / total > .20).map(([name]) => name), ownership: sorted.map(([name, weight]) => ({ name, weight: weight / total })) });
}
for (const xScale of [1, 1.05, 1.10, 1.15, 1.20]) for (const yOffset of [-.06, 0, .06]) {
  const distances = { torso: [], sleeves: [] }, negatives = { torso: 0, sleeves: 0 };
  for (const vertex of baseline) {
    const p = vertex.sourcePosition.map((v, axis) => axis === 0 ? v * xScale : axis === 1 ? v + yOffset : v);
    const sleeve = vertex.dominant.includes('Arm'), hit = surface.closest(p, 1, sleeve ? [vertex.dominant] : ['UpperTorso', 'LowerTorso']);
    const signed = p.reduce((sum, v, axis) => sum + (v - hit.point[axis]) * hit.normal[axis], 0);
    const key = sleeve ? 'sleeves' : 'torso';
    distances[key].push(signed); if (signed < -.002) negatives[key]++;
  }
  const summary = values => { const sorted = values.sort((a, b) => a - b); return { samples: sorted.length, min: sorted[0], p10: sorted[Math.floor(sorted.length * .1)], median: sorted[Math.floor(sorted.length * .5)] }; };
  rows.push({ xScale, yOffset, negativeVertices: negatives, sleeveClearance: summary(distances.sleeves), torsoClearance: summary(distances.torso) });
}
const report = { sourceVertices: shirt.positions.length / 3, sourceTriangles: shirt.indices.length / 3, interpretation: 'Nearest canonical source-cage surface normals and UV-target owner labels provide registration diagnostics. This proxy is not the original authoring mannequin and does not prove physical source-body clearance.', baselineGroups: baseline.reduce((counts, vertex) => (counts[vertex.dominant] = (counts[vertex.dominant] ?? 0) + 1, counts), {}), candidateRegistration: rows, vertexOwnership: baseline };
fs.writeFileSync(path.join(root, 'evidence/real-shirt-source-analysis.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ baselineGroups: report.baselineGroups, candidates: rows }, null, 2));
