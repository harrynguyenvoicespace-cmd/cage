import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { Matrix4, Vector3, Quaternion, Euler } from '../vendor/three/three.module.js';

const assets = path.resolve(import.meta.dirname, '../assets');
const destination = path.join(assets, 'source/tshirt-reference');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const caged = read(path.join(destination, 'Tshirt-caged.fbx.extracted.json'));
const uncaged = read(path.join(assets, 'source/tshirt-fbx-extracted.json'));
const canonical = read(path.join(assets, 'roblox-cage.json')).inner;
const targetSeed = read(path.join(assets, 'blocky-cage-target.json'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const uvKey = (u, v) => `${u.toFixed(6)},${v.toFixed(6)}`;
const bounds = positions => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  positions.forEach((v, i) => { const axis = i % 3; min[axis] = Math.min(min[axis], v); max[axis] = Math.max(max[axis], v); });
  return { min, max, size: min.map((v, i) => max[i] - v), center: min.map((v, i) => (v + max[i]) / 2) };
};
const modelMap = new Map(caged.models.map(m => [m.id, m])), matrices = new Map();
function world(id) {
  if (matrices.has(id)) return matrices.get(id);
  const model = modelMap.get(id); if (!model) return new Matrix4();
  const p = model.properties, t = p['Lcl Translation'] ?? [0, 0, 0], r = (p['Lcl Rotation'] ?? [0, 0, 0]).map(v => v * Math.PI / 180), s = p['Lcl Scaling'] ?? [1, 1, 1];
  let matrix = new Matrix4().compose(new Vector3(...t), new Quaternion().setFromEuler(new Euler(...r, 'ZYX')), new Vector3(...s));
  const parent = caged.connections.find(c => c[0] === 'OO' && c[1] === id && modelMap.has(c[2]));
  if (parent) matrix = world(parent[2]).clone().multiply(matrix);
  matrices.set(id, matrix); return matrix;
}
function mesh(name) {
  const model = caged.models.find(m => m.name === name);
  const connection = caged.connections.find(c => c[0] === 'OO' && c[2] === model.id && caged.geometries.some(g => g.id === c[1]));
  const geometry = caged.geometries.find(g => g.id === connection[1]);
  const matrix = world(model.id), point = new Vector3(), positions = [];
  for (let i = 0; i < geometry.positions.length; i += 3) { point.fromArray(geometry.positions, i).applyMatrix4(matrix); positions.push(point.x, point.y, point.z); }
  return { model, geometry, positions };
}
function polygonsAndTriangles(polygonIndices) {
  const polygons = [], indices = [], triangleCorners = []; let polygon = [], corners = [];
  polygonIndices.forEach((raw, corner) => {
    polygon.push(raw < 0 ? -raw - 1 : raw); corners.push(corner);
    if (raw < 0) {
      polygons.push(polygon);
      for (let i = 1; i < polygon.length - 1; i++) { indices.push(polygon[0], polygon[i], polygon[i + 1]); triangleCorners.push(corners[0], corners[i], corners[i + 1]); }
      polygon = []; corners = [];
    }
  });
  return { polygons, indices, triangleCorners };
}
function canonicalCage(meshData) {
  const { geometry, positions } = meshData, uv = geometry.uvLayers[0];
  const byUV = new Map();
  geometry.polygonIndices.forEach((raw, corner) => {
    const id = raw < 0 ? -raw - 1 : raw, uvId = uv.uvIndices[corner], key = uvKey(uv.uv[uvId * 2], uv.uv[uvId * 2 + 1]);
    if (!byUV.has(key)) byUV.set(key, new Set()); byUV.get(key).add(id);
  });
  const candidates = Array.from({ length: 1358 }, () => new Set());
  canonical.polygonIndices.forEach((raw, corner) => {
    const id = raw < 0 ? -raw - 1 : raw, uvId = canonical.uvIndices[corner], key = uvKey(canonical.uv[uvId * 2], canonical.uv[uvId * 2 + 1]);
    for (const sourceId of byUV.get(key) ?? []) candidates[id].add(sourceId);
  });
  const output = [], sourceVertexIds = [], unmatched = []; let maximumCandidateSpread = 0;
  candidates.forEach((ids, vertex) => {
    const values = [...ids]; if (!values.length) { unmatched.push(vertex); return; }
    const points = values.map(id => positions.slice(id * 3, id * 3 + 3));
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) maximumCandidateSpread = Math.max(maximumCandidateSpread, Math.hypot(...points[i].map((v, axis) => v - points[j][axis])));
    output.push(...[0, 1, 2].map(axis => points.reduce((sum, p) => sum + p[axis], 0) / points.length)); sourceVertexIds.push(values);
  });
  assert.equal(unmatched.length, 0, 'Exact source cage must cover every canonical UV vertex');
  return { name: meshData.model.name, positions: output, indices: canonical.indices, uv: canonical.uv, uvIndices: canonical.uvIndices, polygonIndices: canonical.polygonIndices, polygons: canonical.polygons, triangleCorners: canonical.triangleCorners, vertexCount: 1358, triangleCount: canonical.indices.length / 3, sourceVertexIds, diagnostics: { matchedVertices: 1358, unmatchedVertexIds: unmatched, maximumCandidateSpread }, bounds: bounds(output) };
}

const shirt = mesh('TShirt_TyeDye_001'), inner = canonicalCage(mesh('TShirt_TyeDye_001_InnerCage')), outer = canonicalCage(mesh('TShirt_TyeDye_001_OuterCage'));
const original = uncaged.geometries[0];
assert.deepEqual(shirt.geometry.positions, original.positions, 'Caged reference must contain the original 487 source vertices');
assert.deepEqual(shirt.geometry.polygonIndices, original.polygonIndices, 'Original polygon topology must remain unchanged');
const topology = polygonsAndTriangles(original.polygonIndices), sourceUV = original.uvLayers[0];
const skinInfluences = Array.from({ length: 487 }, () => []), bindMatrices = Object.create(null);
for (const deformer of caged.deformers.filter(d => d.type === 'Cluster')) {
  const name = deformer.name === 'HumanoidRootNode' ? 'HumanoidRootPart' : deformer.name;
  if (deformer.transformLink) bindMatrices[name] = deformer.transformLink;
  if (!deformer.indices) continue;
  deformer.indices.forEach((vertex, i) => { if (deformer.weights[i] > 0) skinInfluences[vertex].push({ name, weight: deformer.weights[i] }); });
}
let maximumSkinWeightSumError = 0;
skinInfluences.forEach(weights => {
  const sum = weights.reduce((s, w) => s + w.weight, 0); maximumSkinWeightSumError = Math.max(maximumSkinWeightSumError, Math.abs(sum - 1));
  assert.ok(sum > 0); weights.forEach(w => { w.weight /= sum; }); weights.sort((a, b) => b.weight - a.weight);
});
const vertexParts = skinInfluences.map(weights => weights[0].name);
const vertexGroups = skinInfluences.map(weights => {
  const largest = weights[0].weight;
  return weights.filter(w => w.weight >= .12 && w.weight >= largest * .22).map(w => w.name);
});
const standard = new Set(['HumanoidRootPart', 'LowerTorso', 'UpperTorso', 'Head', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand', 'RightUpperArm', 'RightLowerArm', 'RightHand', 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot']);
const joints = Object.entries(bindMatrices).filter(([name]) => standard.has(name)).map(([name, matrix]) => ({ name, position: matrix.slice(12, 15), worldMatrix: matrix, source: 'FBX Cluster.TransformLink authored bind matrix' }));
const joint = name => joints.find(j => j.name === name).position;
const ownerStatistics = Object.create(null);
for (const name of new Set(vertexParts)) {
  const ids = vertexParts.flatMap((part, i) => part === name ? [i] : []), positions = ids.flatMap(i => shirt.positions.slice(i * 3, i * 3 + 3));
  ownerStatistics[name] = { count: ids.length, bounds: bounds(positions), vertexIds: ids };
}
const arms = ['Left', 'Right'].map(side => {
  const shoulder = joint(`${side}UpperArm`), elbow = joint(`${side}LowerArm`), wrist = joint(`${side}Hand`);
  const direction = elbow.map((v, i) => v - shoulder[i]), length = Math.hypot(...direction);
  return { side, shoulder, elbow, wrist, upperArmDirection: direction.map(v => v / length), angleFromVerticalDownDegrees: Math.acos(-direction[1] / length) * 180 / Math.PI };
});
const edgeCounts = new Map();
topology.polygons.forEach(poly => poly.forEach((a, i) => { const b = poly[(i + 1) % poly.length], key = a < b ? `${a}:${b}` : `${b}:${a}`; edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1); }));
const garment = { name: 'TShirt_TyeDye_001', positions: shirt.positions, indices: topology.indices, uv: sourceUV.uv, uvIndices: sourceUV.uvIndices, polygonIndices: original.polygonIndices, polygons: topology.polygons, triangleCorners: topology.triangleCorners, vertexCount: 487, triangleCount: topology.indices.length / 3, vertexGroups, vertexParts, bounds: bounds(shirt.positions) };
const result = {
  schemaVersion: 1, name: 'Exact_authored_Roblox_Tshirt_reference', garment, inner, outer, skinInfluences,
  cageInfluences: targetSeed.influences.map(weights => weights.map(w => ({ ...w }))), joints,
  source: { url: 'https://prod.docsiteassets.roblox.com/assets/accessories/reference-files/Tshirt-caged.fbx', docs: 'https://create.roblox.com/docs/art/accessories/rig-and-cage-existing-models', sha256: sha(path.join(destination, 'Tshirt-caged.fbx')), originalUncagedSha256: sha(path.join(assets, 'source/Tshirt-model.fbx')), canonicalCageSha256: sha(path.join(assets, 'roblox-cage.json')) },
  registration: {
    coordinateSpace: 'Authored caged FBX world coordinates. No floor/depth translation, rescale, or orientation change applied to any object.',
    sourceToBloxLabOrientation: { axis: 'Y', degrees: 180, determinant: 1, applyTo: 'All source garment, inner/outer cage positions and joints together, if using BloxLab negative-X LeftArm conventions.' },
    sourceLowerTorsoPivot: joint('LowerTorso'), sourceUpperTorsoPivot: joint('UpperTorso'), sourceNeckPivot: joint('Head'),
    unitMetadata: { uncagedUnitScaleFactor: uncaged.settings.UnitScaleFactor, cagedUnitScaleFactor: caged.settings.UnitScaleFactor, warning: 'Raw mesh positions are identical despite different FBX unit metadata. Keep all authored caged scene objects in one consistent numerical coordinate space.' },
    originalRawVerticesUnchanged: true, originalPolygonTopologyUnchanged: true,
    originalGarmentUVsPreserved: true,
    authoredGarmentObjectTransform: shirt.model.properties,
    priorUncagedObjectTransform: uncaged.models[0].properties,
  },
  cageInfluenceProvenance: 'Body part ownership transferred through canonical UV correspondence from the official BlockyCharacter body cages. The source caged clothing FBX does not skin its inner/outer cages.',
  landmarks: { arms, torso: ownerStatistics, lowestHemY: garment.bounds.min[1], highestCollarY: garment.bounds.max[1], interiorCapVertexIds: [456, 457] },
  diagnostics: {
    sourceVertices: 487, sourcePolygons: topology.polygons.length, sourceTriangles: topology.indices.length / 3,
    garmentBoundaryEdges: [...edgeCounts.values()].filter(n => n === 1).length,
    garmentNonmanifoldEdges: [...edgeCounts.values()].filter(n => n > 2).length,
    garmentEulerCharacteristic: 487 - edgeCounts.size + topology.polygons.length,
    canonicalUVMatchedInnerVertices: inner.diagnostics.matchedVertices, canonicalUVMatchedOuterVertices: outer.diagnostics.matchedVertices,
    maximumSkinWeightSumError,
    closedInteriorCapWarning: 'This original source shirt is a closed genus-0 volume. Vertices 456 and 457 seal interior regions. Forcing every original cloth sample outside a body changes authored interior caps into fins; visible exterior fit and authored hidden caps must be assessed separately.',
  },
};
for (const mesh of [garment, inner, outer]) assert.ok(mesh.positions.every(Number.isFinite));
const filename = path.join(destination, 'tshirt-authored-reference.json');
fs.writeFileSync(filename, JSON.stringify(result));
const report = { source: result.source, registration: result.registration, garmentBounds: garment.bounds, cageBounds: inner.bounds, arms, dominantOwnerCounts: Object.fromEntries(Object.entries(ownerStatistics).map(([name, values]) => [name, values.count])), diagnostics: result.diagnostics };
fs.writeFileSync(path.join(destination, 'tshirt-registration-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ filename, ...report }, null, 2));
