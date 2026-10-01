import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Matrix4, Vector3, Quaternion, Euler } from '../vendor/three/three.module.js';

const root = path.resolve(import.meta.dirname, '..');
const assets = path.join(root, 'assets');
const reference = path.join(assets, 'source/blocky-reference');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const canonicalFile = path.join(assets, 'roblox-cage.json');
const bodyFile = path.join(assets, 'r15-body.json');
const canonical = read(canonicalFile).inner;
const body = read(bodyFile);
const uvReference = read(path.join(reference, 'blocky-cage-uv-map.json'));
const source = read(path.join(reference, 'BlockyCharacter.fbx.extracted.json'));
const sourceBinary = path.join(reference, 'BlockyCharacter.fbx');
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const bounds = (positions) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  positions.forEach((v, i) => { const a = i % 3; min[a] = Math.min(min[a], v); max[a] = Math.max(max[a], v); });
  return { min, max, center: min.map((v, i) => (v + max[i]) * 0.5), size: min.map((v, i) => max[i] - v) };
};
const average = (points) => [0, 1, 2].map((axis) => points.reduce((sum, p) => sum + p[axis], 0) / points.length);
const rotate = ([x, y, z]) => [-x, y, -z]; // Proper 180° rotation around Y; determinant +1.
const offset = uvReference.normalizationOffset;
const modelMap = new Map(source.models.map((m) => [m.id, m]));
const matrices = new Map();
function world(id) {
  if (matrices.has(id)) return matrices.get(id);
  const model = modelMap.get(id);
  if (!model) return new Matrix4();
  const p = model.properties;
  const t = p['Lcl Translation'] || [0, 0, 0], r = (p['Lcl Rotation'] || [0, 0, 0]).map((v) => v * Math.PI / 180), s = p['Lcl Scaling'] || [1, 1, 1];
  let matrix = new Matrix4().compose(new Vector3(...t), new Quaternion().setFromEuler(new Euler(...r, 'ZYX')), new Vector3(...s));
  const parent = source.connections.find((c) => c[0] === 'OO' && c[1] === id && modelMap.has(c[2]));
  if (parent) matrix = world(parent[2]).clone().multiply(matrix);
  matrices.set(id, matrix); return matrix;
}

const targetParts = new Map(body.parts.map((p) => [p.name, p]));
const sourceBodyBounds = new Map();
for (const geometry of source.geometries) {
  const connection = source.connections.find((c) => c[0] === 'OO' && c[1] === geometry.id && modelMap.has(c[2]));
  const model = modelMap.get(connection?.[2]);
  if (!model?.name.endsWith('_Geo')) continue;
  const name = model.name.replace(/_Geo$/, '');
  if (!targetParts.has(name)) continue;
  const matrix = world(model.id), point = new Vector3(), positions = [];
  for (let i = 0; i < geometry.positions.length; i += 3) {
    point.fromArray(geometry.positions, i).applyMatrix4(matrix);
    const rotated = rotate([point.x + offset[0], point.y + offset[1], point.z + offset[2]]);
    positions.push(...rotated);
  }
  sourceBodyBounds.set(name, bounds(positions));
}
if (sourceBodyBounds.size !== 15) throw new Error(`Expected 15 reference body geometries, got ${sourceBodyBounds.size}`);

const alignments = Object.create(null);
for (const [name, sourceBounds] of sourceBodyBounds) {
  const target = bounds(targetParts.get(name).positions);
  const scale = target.size.map((v, axis) => v / sourceBounds.size[axis]);
  alignments[name] = { sourceBodyBounds: sourceBounds, targetBodyBounds: target, scale, paddingPolicy: 'Affine transform based on body geometry, applied to the cage. Source cage offsets from the body are preserved in normalized body coordinates.' };
}
function fitPart(point, name) {
  const alignment = alignments[name], rotated = rotate(point);
  return rotated.map((v, axis) => alignment.targetBodyBounds.center[axis] + (v - alignment.sourceBodyBounds.center[axis]) * alignment.scale[axis]);
}

const vertexCount = canonical.positions.length / 3;
if (uvReference.canonicalVertexCandidates.length !== vertexCount) throw new Error('Canonical vertex count does not match reference UV map');
const positions = new Array(vertexCount * 3);
const influences = new Array(vertexCount);
const sourcePartNames = new Array(vertexCount);
const matchedIds = [], fallbackIds = [];
let maximumSourceDuplicateSpread = 0, maximumAlignedJointSpread = 0;
for (let vertex = 0; vertex < vertexCount; vertex++) {
  const records = uvReference.canonicalVertexCandidates[vertex];
  if (!records.length) { fallbackIds.push(vertex); continue; }
  const owners = new Map();
  for (const record of records) {
    if (!alignments[record.part]) throw new Error(`Unknown cage owner ${record.part}`);
    (owners.get(record.part) || (owners.set(record.part, []), owners.get(record.part))).push(record.position);
  }
  const ownerTargets = [], names = [...owners.keys()].sort();
  for (const name of names) {
    const points = owners.get(name);
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) maximumSourceDuplicateSpread = Math.max(maximumSourceDuplicateSpread, Math.hypot(...points[i].map((v, axis) => v - points[j][axis])));
    ownerTargets.push(fitPart(average(points), name));
  }
  for (let i = 0; i < ownerTargets.length; i++) for (let j = i + 1; j < ownerTargets.length; j++) maximumAlignedJointSpread = Math.max(maximumAlignedJointSpread, Math.hypot(...ownerTargets[i].map((v, axis) => v - ownerTargets[j][axis])));
  const target = average(ownerTargets);
  positions.splice(vertex * 3, 3, ...target);
  influences[vertex] = names.map((name) => ({ name, weight: 1 / names.length }));
  sourcePartNames[vertex] = names;
  matchedIds.push(vertex);
}

function inverse3(a) {
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = a;
  const c00 = a11 * a22 - a12 * a21, c01 = a02 * a21 - a01 * a22, c02 = a01 * a12 - a02 * a11;
  const c10 = a12 * a20 - a10 * a22, c11 = a00 * a22 - a02 * a20, c12 = a02 * a10 - a00 * a12;
  const c20 = a10 * a21 - a11 * a20, c21 = a01 * a20 - a00 * a21, c22 = a00 * a11 - a01 * a10;
  const determinant = a00 * c00 + a01 * c10 + a02 * c20;
  if (Math.abs(determinant) < 1e-14) return null;
  return [c00, c01, c02, c10, c11, c12, c20, c21, c22].map((v) => v / determinant);
}
const headMatches = matchedIds.filter((id) => sourcePartNames[id].includes('Head'));
const headSourceBounds = bounds(headMatches.flatMap((id) => canonical.positions.slice(id * 3, id * 3 + 3)));
const headTargetBounds = bounds(headMatches.flatMap((id) => positions.slice(id * 3, id * 3 + 3)));
const fallbackDetails = [];
for (const vertex of fallbackIds) {
  const query = canonical.positions.slice(vertex * 3, vertex * 3 + 3);
  const neighbors = headMatches.map((id) => {
    const sourcePoint = canonical.positions.slice(id * 3, id * 3 + 3);
    return { id, sourcePoint, targetPoint: positions.slice(id * 3, id * 3 + 3), distance2: sourcePoint.reduce((sum, v, axis) => sum + (v - query[axis]) ** 2, 0) };
  }).sort((a, b) => a.distance2 - b.distance2).slice(0, 28);
  let total = 0, sourceCenter = [0, 0, 0], targetCenter = [0, 0, 0];
  for (const neighbor of neighbors) {
    neighbor.weight = 1 / (neighbor.distance2 + 0.012 ** 2) ** 1.5; total += neighbor.weight;
    for (let axis = 0; axis < 3; axis++) { sourceCenter[axis] += neighbor.sourcePoint[axis] * neighbor.weight; targetCenter[axis] += neighbor.targetPoint[axis] * neighbor.weight; }
  }
  sourceCenter = sourceCenter.map((v) => v / total); targetCenter = targetCenter.map((v) => v / total);
  const covariance = new Array(9).fill(0), crossCovariance = new Array(9).fill(0);
  for (const neighbor of neighbors) for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
    const weight = neighbor.weight / total;
    covariance[row * 3 + column] += weight * (neighbor.sourcePoint[row] - sourceCenter[row]) * (neighbor.sourcePoint[column] - sourceCenter[column]);
    crossCovariance[row * 3 + column] += weight * (neighbor.targetPoint[row] - targetCenter[row]) * (neighbor.sourcePoint[column] - sourceCenter[column]);
  }
  const regularization = Math.max(1e-8, (covariance[0] + covariance[4] + covariance[8]) * 0.0001);
  covariance[0] += regularization; covariance[4] += regularization; covariance[8] += regularization;
  const inverse = inverse3(covariance);
  let method = 'weighted-affine-MLS-28-head-neighbors', target;
  if (inverse) {
    const map = new Array(9).fill(0);
    for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) for (let k = 0; k < 3; k++) map[row * 3 + column] += crossCovariance[row * 3 + k] * inverse[k * 3 + column];
    target = targetCenter.map((v, row) => v + [0, 1, 2].reduce((sum, column) => sum + map[row * 3 + column] * (query[column] - sourceCenter[column]), 0));
  } else {
    method = 'bounded-head-bbox';
    // Canonical source and target faces have opposite X/Z orientation.
    target = query.map((v, axis) => {
      const t = (v - headSourceBounds.min[axis]) / Math.max(headSourceBounds.size[axis], 1e-8);
      const directed = axis === 1 ? t : 1 - t;
      return headTargetBounds.min[axis] + directed * headTargetBounds.size[axis];
    });
  }
  const unbounded = [...target];
  target = target.map((v, axis) => Math.min(headTargetBounds.max[axis] + 0.035, Math.max(headTargetBounds.min[axis] - 0.035, v)));
  if (!target.every(Number.isFinite)) throw new Error(`Invalid head fallback ${vertex}`);
  positions.splice(vertex * 3, 3, ...target);
  influences[vertex] = [{ name: 'Head', weight: 1 }]; sourcePartNames[vertex] = ['Head'];
  fallbackDetails.push({ vertexId: vertex, method, neighborVertexIds: neighbors.map((n) => n.id), regularization, bounded: target.some((v, axis) => v !== unbounded[axis]) });
}
if (positions.length !== 4074 || !positions.every(Number.isFinite)) throw new Error('Target must contain 4074 finite coordinates');
if (influences.some((weights) => Math.abs(weights.reduce((sum, w) => sum + w.weight, 0) - 1) > 1e-12)) throw new Error('Invalid influence normalization');

const output = {
  schemaVersion: 1, name: 'Official_Blocky_R15_UV_Target', positions, influences, sourcePartNames,
  canonicalVertexCount: vertexCount,
  canonicalTopologyPolicy: 'Only positions and named body influences are supplied. Original roblox-cage.json UVs, polygon indices, render indices and vertex order must remain unchanged.',
  provenance: {
    sourceUrl: 'https://prod.docsiteassets.roblox.com/assets/avatar/dynamic-heads/reference-files/BlockyCharacter.fbx',
    sourceDocs: 'https://create.roblox.com/docs/avatar/resources', sourceSha256: hash(sourceBinary),
    canonicalCageSha256: hash(canonicalFile), targetBodySha256: hash(bodyFile),
    sourceNormalizationOffset: offset, orientation: { rotationAxis: 'Y', rotationDegrees: 180, determinant: 1, reflection: false },
    alignment: 'Same-named official body geometry bbox to actual BloxLab R15 part bbox, then apply that affine transform to the part cage. Average source duplicate UV candidates per owner and joint candidates equally across owners.',
  },
  partAlignments: alignments,
  fallbackVertexIds: fallbackIds, fallbackDetails,
  diagnostics: {
    uvMatchedVertices: matchedIds.length, fallbackVertices: fallbackIds.length, vertexCount,
    uvMatchFraction: matchedIds.length / vertexCount, maximumSourceDuplicateSpread,
    maximumAlignedJointSpread, headNeighborsAvailable: headMatches.length,
    targetBounds: bounds(positions), influenceWeightsNormalized: true,
  },
};
const serialized = JSON.stringify(output);
const destination = path.join(assets, 'blocky-cage-target.json');
fs.writeFileSync(destination, serialized);
console.log(JSON.stringify({ file: destination, sha256: crypto.createHash('sha256').update(serialized).digest('hex'), diagnostics: output.diagnostics, fallbackVertexIds: fallbackIds, partScale: Object.fromEntries(Object.entries(alignments).map(([name, a]) => [name, a.scale])) }, null, 2));
