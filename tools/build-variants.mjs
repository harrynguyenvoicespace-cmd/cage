import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createR15Garment } from '../src/garment.js';
import { GARMENT_CATALOG } from '../src/garment-catalog.js';
import { createSurface, mergeBodyParts, diagnoseMesh } from '../src/cage-engine.js';

const root = path.resolve(import.meta.dirname, '..');
const assetDir = path.join(root, 'assets');
const body = JSON.parse(fs.readFileSync(path.join(assetDir, 'r15-body.json')));
const originalFile = path.join(assetDir, 'r15-shirt.json');
const originalBytes = fs.readFileSync(originalFile);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bodySurface = createSurface(mergeBodyParts(body.parts));
const rows = [];
const baselineFiles = new Set(['r15-shirt.json', 'r15-long-shirt.json', 'r15-wide-sweater.json', 'r15-jacket.json']);
fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });

function inspect(mesh) {
  assert.ok(mesh.positions.every(Number.isFinite));
  const count = mesh.positions.length / 3;
  assert.equal(mesh.uv.length, count * 2);
  assert.equal(mesh.vertexGroups.length, count);
  assert.ok(mesh.indices.every(index => Number.isInteger(index) && index >= 0 && index < count));
  const edges = new Map();
  for (let i = 0; i < mesh.indices.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = mesh.indices[i + j], b = mesh.indices[i + (j + 1) % 3];
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  const boundaryEdges = [...edges.values()].filter(count => count === 1).length;
  const nonmanifoldEdges = [...edges.values()].filter(count => count !== 2).length;
  assert.equal(boundaryEdges, 0, 'A fabric shell must have sewn rims.');
  assert.equal(nonmanifoldEdges, 0, 'Fabric must be a closed two-manifold.');
  const rest = diagnoseMesh(mesh, bodySurface, { robust: true });
  const groups = {};
  for (const group of mesh.vertexGroups) groups[group.join('+')] = (groups[group.join('+')] ?? 0) + 1;
  return { vertices: count, triangles: mesh.indices.length / 3, edges: edges.size, boundaryEdges, nonmanifoldEdges, sourceBodyPenetrationSamples: rest.penetrationSamples, sourceBodyMaximumDepth: rest.maximumPenetration, sourceBodyMinimumClearance: rest.minimumClearance, sampleCount: rest.sampleCount, groups };
}

for (const entry of GARMENT_CATALOG) {
  const { style, filename } = entry;
  // Retain the four published baselines for a fair comparison with new designs.
  const mesh = baselineFiles.has(filename)
    ? JSON.parse(fs.readFileSync(path.join(assetDir, filename)))
    : createR15Garment(body, { style });
  const inspection = inspect(mesh);
  if (!baselineFiles.has(filename)) fs.writeFileSync(path.join(assetDir, filename), JSON.stringify(mesh));
  const row = { ...entry, name: mesh.name, sha256: sha256(fs.readFileSync(path.join(assetDir, filename))), design: mesh.design, ...inspection };
  rows.push(row);
  console.log(JSON.stringify(row));
}
assert.deepEqual(fs.readFileSync(originalFile), originalBytes, 'The earlier tested reference tee was changed.');
fs.writeFileSync(path.join(assetDir, 'garment-variants.json'), JSON.stringify({ schemaVersion: 1, factory: 'src/garment.js:createR15Garment', sourceBody: body.source, algorithmParametersShared: true, variants: rows }, null, 2));
const sourcesFile = path.join(assetDir, 'sources.json');
const sources = JSON.parse(fs.readFileSync(sourcesFile));
sources.clothModels.variants = rows.map(row => ({ label: row.label, file: row.filename, sha256: row.sha256, triangles: row.triangles }));
fs.writeFileSync(sourcesFile, JSON.stringify(sources, null, 2));
fs.writeFileSync(path.join(root, 'evidence', 'source-variant-check.json'), JSON.stringify({ generatedAt: new Date().toISOString(), originalTeePreserved: true, originalTeeSha256: sha256(originalBytes), variants: rows }, null, 2));
