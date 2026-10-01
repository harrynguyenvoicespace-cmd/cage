import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createR15GarmentFit, createSurface, deformWithCage, diagnoseMesh, mergeBodyParts } from '../src/cage-engine.js';
import { createMannequinGarmentFit, validateMannequinSeed } from '../src/mannequin-fit.js';
import { createStableMannequinBindings } from '../src/mannequin-binding.js';
import { createR15Poser, posePoints } from '../src/r15-pose.js';
import { Matrix4 } from '../vendor/three/three.module.js';
import { extract, meshTransforms, transformPositions, triangulate, cornerUv } from './fbx-reader.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const assetPath = filename => path.join(root, filename.startsWith('assets/') ? filename : `assets/${filename}`);
const load = filename => JSON.parse(fs.readFileSync(assetPath(filename), 'utf8'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashFile = filename => sha(fs.readFileSync(filename));
const finite = values => [...values].every(Number.isFinite);
const difference = (a, b) => {
  assert.equal(a.length, b.length);
  return a.reduce((maximum, value, index) => Math.max(maximum, Math.abs(value - b[index])), 0);
};
const point = (positions, index) => positions.slice(index * 3, index * 3 + 3);
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const magnitude = point => Math.hypot(...point);
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const worker = option('worker');
const runId = option('run-id') || crypto.randomUUID();
const poseStates = [
  { width: 1, pose: 'arms', time: 0 },
  { width: 1.4, pose: 'stand', time: 0 },
  { width: 1.4, pose: 'walk', time: .4 },
];
const catalog = load('mannequins/catalog.json');
const variants = load('garment-variants.json').variants;
const cage = load('roblox-cage.json');
const sourceBody = load('r15-body.json');
const sourceSeed = load('blocky-cage-target.json');
// Broad compatibility limits catch exploding triangle edges. Ordinary contact,
// envelope coverage and small triangle collapse remain measured quality results.
const compatibilityLimits = {
  rest: { maximumEdgeStretch: 8, maximumEdgeLengthGrowth: .5 },
  posed: { maximumEdgeStretch: 16, maximumEdgeLengthGrowth: .8 },
};
const expectedSourceHashes = {
  'RthroSlenderMannequin_With-Cages.fbx': 'e1f92f00e37e98095a0e14e4254a35d1f87c190c780c447f0c684eff9694b532',
  'RthroSlenderMannequin.fbx': '995a0a4af01e5299be8e77d96f75c11bd48b5d88ae65568e0f4bb523b6e28a1a',
  'RthroMannequin_With-Cages.fbx': 'e8519448131dde042830bce938cca86f211ef535ad80713b1938d3512320b249',
  'RthroMannequin.fbx': 'e6db9e67326b9f5adc8ac47cf62903217d82e4554d19a65eca4281c4f104d838',
  'ClassicMannequin_With-Cages.fbx': '72eb65745962a377d9e78500eb2961f4abe3f1b0f4be74ef20cd346435c76ef1',
};

function sourceMeshData(sourceFile) {
  const data = extract(assetPath(sourceFile));
  const transformed = meshTransforms(data);
  return { data, transformed, body: transformed.filter(record => record.model.name.endsWith('_Geo')) };
}

function polygonKey(ids) {
  return ids.map((_, start) => [...ids.slice(start), ...ids.slice(0, start)].join(':')).sort()[0];
}

function uvFields(mesh) {
  const fields = Array.from({ length: mesh.positions.length / 3 }, () => new Set());
  const uvs = cornerUv({ polygonIndices: mesh.polygonIndices, uvLayers: [{ uv: mesh.uv, uvIndices: mesh.uvIndices, mapping: mesh.uvMapping, reference: mesh.uvReference }] });
  mesh.polygonIndices.forEach((raw, corner) => fields[raw < 0 ? -raw - 1 : raw].add(uvs[corner].join(':')));
  return fields;
}

function verifyImportedSource(entry, body, seed, originalCages) {
  assert.equal(body.source.sha256, expectedSourceHashes[path.basename(body.source.file)]);
  assert.equal(seed.provenance.sourceSha256, body.source.sha256);
  assert.equal(originalCages.source.sha256, body.source.sha256);
  assert.equal(seed.provenance.canonicalCageSha256, hashFile(assetPath('roblox-cage.json')));
  assert.equal(body.rigMetadata.authoredBoneCount, 0);
  assert.equal(body.rigMetadata.authoredSkinClusterCount, 0);
  assert.equal(body.rigMetadata.inferredDemoJointCount, 16);
  assert.match(body.rigSource, /inferred.*no skin clusters or skeleton/i);
  assert.equal(body.normalization.scale, 1, 'Imported bodies must keep their actual authored dimensions.');
  assert.equal(body.normalization.determinant, 1, 'Orientation conversion must use a proper rotation.');
  assert.equal(body.normalization.rotationDegrees, 180);
  assert.ok(finite(body.normalization.matrix) && body.normalization.matrix.length === 16);
  const normalized = new Matrix4().fromArray(body.normalization.matrix);
  const source = sourceMeshData(body.source.file);
  assert.equal(source.body.length, 15);
  assert.equal(source.data.models.filter(model => model.type === 'LimbNode').length, 0);
  assert.equal(source.data.deformers.filter(deformer => deformer.type === 'Cluster').length, 0);
  const bySourceId = new Map(source.transformed.map(record => [record.geometry.id, record]));
  for (const mesh of [...body.parts, originalCages.inner, originalCages.outer, ...originalCages.parts]) {
    const record = bySourceId.get(mesh.source.geometryId);
    assert.ok(record, 'Every imported mesh must refer to a retained FBX source geometry.');
    const positions = transformPositions(record.geometry.positions, normalized.clone().multiply(record.matrix));
    assert.ok(difference(mesh.positions, positions) < 1e-9, 'Imported control points must match actual FBX object transforms and one recorded normalization.');
    assert.deepEqual(mesh.polygonIndices, record.geometry.polygonIndices, 'Original FBX polygon corner topology must remain intact.');
    assert.deepEqual(mesh.indices, triangulate(record.geometry.polygonIndices, positions.length / 3, positions).indices);
  }
  let pairing = { available: false };
  if (entry.sourceFiles.length === 2) {
    const uncagedFile = entry.sourceFiles.find(file => file.file !== body.source.file);
    const uncaged = sourceMeshData(uncagedFile.file), byName = new Map(uncaged.body.map(record => [record.model.name, record]));
    assert.equal(uncaged.body.length, 15);
    let maximumWorldPositionDifference = 0;
    for (const record of source.body) {
      const peer = byName.get(record.model.name);
      assert.ok(peer);
      assert.deepEqual(record.geometry.positions, peer.geometry.positions);
      assert.deepEqual(record.geometry.polygonIndices, peer.geometry.polygonIndices);
      assert.deepEqual(record.geometry.uvLayers, peer.geometry.uvLayers);
      const a = transformPositions(record.geometry.positions, record.matrix), b = transformPositions(peer.geometry.positions, peer.matrix);
      maximumWorldPositionDifference = Math.max(maximumWorldPositionDifference, difference(a, b));
    }
    assert.ok(maximumWorldPositionDifference < 1e-6, 'Caged and uncaged FBX bodies may differ only by recorded exporter rounding.');
    assert.equal(body.pairing.rawPositionsEqual, true);
    assert.equal(body.pairing.polygonTopologyEqual, true);
    assert.equal(body.pairing.uvLayersEqual, true);
    pairing = { available: true, rawPositionsEqual: true, polygonTopologyEqual: true, uvLayersEqual: true, maximumWorldPositionDifference, worldComparisonTolerance: 1e-6 };
  } else assert.equal(body.pairing.available, false, 'Classic has no uploaded uncaged counterpart.');

  const canonicalUvs = uvFields(cage.inner), sourceUvs = uvFields(originalCages.inner);
  const inverse = new Map(), merged = [];
  let maximumDuplicateSpread = 0;
  assert.equal(seed.sourceVertexIds.length, 1358);
  for (let vertex = 0; vertex < 1358; vertex++) {
    const ids = seed.sourceVertexIds[vertex];
    assert.ok(ids.length && ids.every(id => Number.isInteger(id) && id >= 0 && id < sourceUvs.length));
    const points = ids.map(id => point(originalCages.inner.positions, id));
    const mean = [0, 1, 2].map(axis => points.reduce((sum, p) => sum + p[axis], 0) / points.length);
    assert.ok(difference(mean, point(seed.positions, vertex)) < 1e-12, 'Canonical positions must equal the recorded original FBX control-point mean.');
    for (const id of ids) {
      assert.ok(!inverse.has(id), 'An original cage control point may not map to unrelated canonical vertices.');
      inverse.set(id, vertex);
      assert.ok([...sourceUvs[id]].some(uv => canonicalUvs[vertex].has(uv)), 'Canonical cage mapping must use exact polygon-corner UV correspondence.');
    }
    if (ids.length > 1) {
      merged.push(vertex);
      let spread = 0;
      for (const a of points) for (const b of points) spread = Math.max(spread, magnitude(subtract(a, b)));
      maximumDuplicateSpread = Math.max(maximumDuplicateSpread, spread);
      const detail = seed.duplicateDetails.find(detail => detail.canonicalVertexId === vertex);
      assert.ok(detail && /Arithmetic mean/.test(detail.policy));
      assert.deepEqual(detail.sourceVertexIds, ids);
      assert.ok(Math.abs(detail.spread - spread) < 1e-12);
    }
  }
  assert.equal(inverse.size, originalCages.inner.positions.length / 3, 'Every original full-cage control point must retain an explicit canonical correspondence.');
  assert.deepEqual(merged, seed.mergedCanonicalVertexIds);
  assert.equal(merged.length, entry.id === 'classic' ? 4 : 0);
  assert.equal(originalCages.inner.positions.length / 3, entry.id === 'classic' ? 1362 : 1358);
  assert.equal(originalCages.outer.positions.length / 3, entry.id === 'classic' ? 1362 : 1358);
  assert.ok(Math.abs(maximumDuplicateSpread - seed.diagnostics.maximumDuplicateSpread) < 1e-12);
  assert.equal(seed.diagnostics.maximumUvResidual, 0);
  assert.equal(seed.diagnostics.fallbackVertices, 0);
  assert.deepEqual(seed.fallbackVertexIds, []);
  const mappedPolygons = originalCages.inner.polygons.map(ids => polygonKey(ids.map(id => inverse.get(id)))).sort();
  const canonicalPolygons = triangulate(cage.inner.polygonIndices, 1358, cage.inner.positions).polygons.map(polygonKey).sort();
  assert.deepEqual(mappedPolygons, canonicalPolygons, 'The imported full cage must preserve oriented canonical polygon topology after UV correspondence.');
  for (const joint of body.joints) {
    assert.match(joint.source, /inferred/i);
    if (joint.sourceCanonicalVertexIds.length) {
      const points = joint.sourceCanonicalVertexIds.map(vertex => point(seed.positions, vertex));
      const centroid = [0, 1, 2].map(axis => points.reduce((sum, p) => sum + p[axis], 0) / points.length);
      assert.ok(difference(joint.position, centroid) < 1e-9, 'Inferred motion pivots must match the documented authored cage-seam centroid.');
    }
  }
  return { pairing, originalCageVertices: originalCages.inner.positions.length / 3, canonicalVertices: 1358, sourceControlPointsVerified: inverse.size, mergedCanonicalVertices: merged.length, maximumDuplicateSpread, exactUvCorrespondence: true, orientedPolygonTopologyPreserved: true, actualFbxTransformsVerified: true };
}

function validateMesh(mesh, label) {
  assert.ok(mesh.positions.length > 0 && mesh.positions.length % 3 === 0 && finite(mesh.positions), `${label}: finite XYZ geometry required.`);
  assert.ok(mesh.indices.length > 0 && mesh.indices.length % 3 === 0, `${label}: indexed triangles required.`);
  const vertices = mesh.positions.length / 3;
  assert.ok(mesh.indices.every(index => Number.isInteger(index) && index >= 0 && index < vertices), `${label}: triangle index out of range.`);
  return { vertices, triangles: mesh.indices.length / 3 };
}

function validateWeights(weights, names, count, label) {
  assert.equal(weights.length, count, `${label}: one named influence field per vertex required.`);
  for (const field of weights) {
    assert.ok(field.length && field.every(weight => names.has(weight.name) && Number.isFinite(weight.weight) && weight.weight > 0), `${label}: missing part or invalid weight.`);
    assert.ok(Math.abs(field.reduce((total, weight) => total + weight.weight, 0) - 1) < 1e-5, `${label}: influence field must sum to one.`);
  }
}

function triangleQuality(rest, current, indices, isRest = true) {
  const ratios = [], stretches = [], seen = new Set();
  let degenerateTriangles = 0, collapsedRelativeTriangles = 0;
  let maximumEdgeLength = 0, maximumEdgeLengthGrowth = 0, grossSpikeEdges = 0;
  const firstGrossSpikeEdges = [], limits = isRest ? compatibilityLimits.rest : compatibilityLimits.posed;
  for (let index = 0; index < indices.length; index += 3) {
    const ids = indices.slice(index, index + 3);
    const a = ids.map(id => point(rest, id)), b = ids.map(id => point(current, id));
    const before = magnitude(cross(subtract(a[1], a[0]), subtract(a[2], a[0])));
    const after = magnitude(cross(subtract(b[1], b[0]), subtract(b[2], b[0])));
    if (after < 1e-8) degenerateTriangles++;
    if (before > 1e-8) { ratios.push(after / before); if (after / before < .01) collapsedRelativeTriangles++; }
    for (let edge = 0; edge < 3; edge++) {
      const from = ids[edge], to = ids[(edge + 1) % 3], key = `${Math.min(from, to)}:${Math.max(from, to)}`;
      if (seen.has(key)) continue; seen.add(key);
      const old = magnitude(subtract(point(rest, to), point(rest, from)));
      const length = magnitude(subtract(point(current, to), point(current, from)));
      const growth = length - old;
      maximumEdgeLength = Math.max(maximumEdgeLength, length);
      maximumEdgeLengthGrowth = Math.max(maximumEdgeLengthGrowth, growth);
      if (old > 1e-8) {
        const stretch = length / old;
        stretches.push(stretch);
        if (stretch > limits.maximumEdgeStretch && growth > limits.maximumEdgeLengthGrowth) {
          grossSpikeEdges++;
          if (firstGrossSpikeEdges.length < 12) firstGrossSpikeEdges.push({ from, to, sourceLength: old, targetLength: length, stretch, growth });
        }
      }
    }
  }
  const range = values => {
    values.sort((a, b) => a - b);
    return { min: values[0], median: values[Math.floor(values.length * .5)], p95: values[Math.floor(values.length * .95)], max: values.at(-1) };
  };
  return { degenerateTriangles, collapsedRelativeTriangles, areaRatio: range(ratios), edgeStretch: range(stretches), maximumEdgeLength, maximumEdgeLengthGrowth, grossSpikeEdges, firstGrossSpikeEdges };
}

// Scalar solid-angle evaluation avoids allocating millions of temporary vectors.
// Absolute winding handles a cage's orientation, and avoids even ray parity when
// animated cage regions overlap. It does not certify surface self-intersection.
function windingNumber(p, positions, indices) {
  let angle = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const ia = indices[index] * 3, ib = indices[index + 1] * 3, ic = indices[index + 2] * 3;
    const ax = positions[ia] - p[0], ay = positions[ia + 1] - p[1], az = positions[ia + 2] - p[2];
    const bx = positions[ib] - p[0], by = positions[ib + 1] - p[1], bz = positions[ib + 2] - p[2];
    const cx = positions[ic] - p[0], cy = positions[ic + 1] - p[1], cz = positions[ic + 2] - p[2];
    const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz), lc = Math.hypot(cx, cy, cz);
    const numerator = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    const denominator = la * lb * lc + (ax * bx + ay * by + az * bz) * lc
      + (bx * cx + by * cy + bz * cz) * la + (cx * ax + cy * ay + cz * az) * lb;
    angle += 2 * Math.atan2(numerator, denominator);
  }
  return angle / (4 * Math.PI);
}

function evenlySpaced(count, limit) {
  const size = Math.min(count, limit);
  return Array.from({ length: size }, (_, index) => size === 1 ? 0 : Math.floor(index * (count - 1) / (size - 1)));
}

function summarizeBody(diagnostics) {
  assert.equal(diagnostics.invalidSamples, 0, 'Body diagnostics may not suppress non-finite samples.');
  return {
    sampleCount: diagnostics.sampleCount,
    penetrationSamples: diagnostics.penetrationSamples,
    penetrationPercent: diagnostics.penetrationSamples / diagnostics.sampleCount * 100,
    maximumPenetration: diagnostics.maximumPenetration,
    minimumClearance: diagnostics.minimumClearance,
  };
}

function measureState(mesh, fit, posed, settings, sourcePositions, restDiagnostics = null) {
  const inner = posePoints(fit.innerPositions, fit.influences, posed);
  const outer = posePoints(fit.outerPositions, fit.outerInfluences || fit.influences, posed);
  const garment = deformWithCage(fit.bindings, inner);
  assert.equal(garment.length, mesh.positions.length);
  assert.ok(finite(inner) && finite(outer) && finite(garment), 'Posed cage and transferred garment must remain finite.');
  for (const part of posed.parts) assert.ok(finite(part.positions), 'Posed body geometry must remain finite.');
  let bodyDiagnostics = restDiagnostics;
  if (!bodyDiagnostics) {
    // All garment vertices plus four interior/edge probes on 128 evenly spaced
    // faces. Rest fit diagnostics already test all vertices and all faces.
    const faces = evenlySpaced(mesh.indices.length / 3, 128);
    const selectedIndices = faces.flatMap(face => mesh.indices.slice(face * 3, face * 3 + 3));
    bodyDiagnostics = diagnoseMesh({ positions: garment, indices: selectedIndices }, createSurface(mergeBodyParts(posed.parts)), { robust: true });
  }
  const envelope = createSurface({ positions: outer, indices: cage.outer.indices });
  const samples = evenlySpaced(garment.length / 3, 256);
  let outsideVertices = 0, maximumOutsideDistance = 0;
  for (const vertex of samples) {
    const p = point(garment, vertex), nearestDistance = Math.sqrt(envelope.closest(p).distance2);
    if (nearestDistance > .003 && Math.abs(windingNumber(p, outer, cage.outer.indices)) < .5) {
      outsideVertices++; maximumOutsideDistance = Math.max(maximumOutsideDistance, nearestDistance);
    }
  }
  const quality = triangleQuality(sourcePositions, garment, mesh.indices, settings.width === 1 && settings.pose === 'stand');
  if (settings.width !== 1 || settings.pose !== 'stand') {
    assert.ok(difference(garment, fit.garmentPositions) > 1e-4, 'Changing the imported body pose/width must move the original garment.');
    if (settings.pose === 'stand') {
      const expected = fit.garmentPositions.map((value, index) => index % 3 === 0 ? value * settings.width : value);
      assert.ok(difference(garment, expected) < 3e-5, 'The original affine bindings must follow imported-body width scaling.');
    }
  } else assert.ok(difference(garment, fit.garmentPositions) < 1e-6, 'Pose pipeline rest identity must match transferred rest geometry.');
  return {
    ...settings,
    body: summarizeBody(bodyDiagnostics),
    outer: { sampledGarmentVertices: samples.length, totalGarmentVertices: garment.length / 3, outsideVertices, outsidePercent: outsideVertices / samples.length * 100, maximumOutsideDistance },
    garment: quality,
  };
}

async function checkTarget(entry) {
  const startedAt = new Date().toISOString();
  const body = load(entry.bodyFile), seed = load(entry.targetSeedFile), originalCages = load(entry.cagesFile);
  const bodyNames = new Set(body.parts.map(part => part.name));
  assert.equal(body.parts.length, 15);
  assert.equal(bodyNames.size, 15);
  assert.equal(body.joints.length, 16);
  for (const part of body.parts) validateMesh(part, `${entry.id}/${part.name}`);
  const jointNodes = new Set(body.joints.map(joint => joint.nodeIndex));
  assert.equal(jointNodes.size, body.joints.length);
  for (const joint of body.joints) {
    assert.ok(bodyNames.has(joint.name) || joint.name === 'HumanoidRootPart');
    assert.ok(joint.position.length === 3 && finite(joint.position));
    assert.ok(joint.parentNodeIndex === null || joint.parentNodeIndex === undefined || jointNodes.has(joint.parentNodeIndex), 'Inferred joint parent must exist.');
  }
  const importVerification = verifyImportedSource(entry, body, seed, originalCages);
  const correspondence = validateMannequinSeed(cage, seed, body);
  assert.deepEqual(seed.canonicalIndices, cage.inner.indices);
  assert.deepEqual(seed.canonicalUv, cage.inner.uv);
  assert.equal(seed.positions.length / 3, 1358);
  validateWeights(seed.influences, bodyNames, 1358, entry.id);
  const poser = createR15Poser(body), rest = poser.getState({ width: 1, pose: 'stand', time: 0 });
  const reports = [];
  for (const variant of variants) {
    const assetFile = path.join(root, 'assets', variant.filename), bytes = fs.readFileSync(assetFile), mesh = JSON.parse(bytes);
    assert.equal(sha(bytes), variant.sha256, 'Authored garment asset hash must match its original catalog.');
    const originalMesh = JSON.stringify(mesh);
    validateMesh(mesh, variant.id);
    const sourceFit = createR15GarmentFit(cage, mesh, sourceBody, { targetSeed: sourceSeed });
    const originalCoefficientHash = sha(JSON.stringify(sourceFit.bindings.vertices));
    const unstabilizedRestQuality = triangleQuality(mesh.positions, deformWithCage(sourceFit.bindings, Float32Array.from(seed.positions)), mesh.indices);
    const stableSource = createStableMannequinBindings(sourceFit, mesh, sourceBody);
    const coefficientsSha256 = sha(JSON.stringify(stableSource.bindings.vertices));
    assert.equal(stableSource.bindings.sourceVertexCount, 1358);
    assert.equal(stableSource.bindings.vertices.length, mesh.positions.length / 3);
    let maximumAbsoluteWeight = 0, maximumL1Mass = 0;
    for (const records of stableSource.bindings.vertices) {
      assert.ok(records.length);
      assert.ok(records.every(record => Number.isInteger(record.id) && record.id >= 0 && record.id < 1358 && Number.isFinite(record.weight)));
      assert.ok(Math.abs(records.reduce((sum, record) => sum + record.weight, 0) - 1) < 1e-6, 'Stable affine coefficients must preserve constant coordinates.');
      maximumAbsoluteWeight = Math.max(maximumAbsoluteWeight, ...records.map(record => Math.abs(record.weight)));
      maximumL1Mass = Math.max(maximumL1Mass, records.reduce((sum, record) => sum + Math.abs(record.weight), 0));
    }
    assert.ok(maximumAbsoluteWeight <= 2 && maximumL1Mass <= 8, 'Source volumetric support must bound dangerous affine extrapolation.');
    assert.ok(difference(deformWithCage(stableSource.bindings, sourceFit.innerPositions), sourceFit.sourceGarment.positions) <= 1e-6, 'Shared stabilized coefficients must reproduce the original authored garment on its source cage.');
    const fit = createMannequinGarmentFit(cage, mesh, sourceBody, body, { sourceSeed, targetSeed: seed, sourceFit, sourceId: 'r15', targetId: entry.id });
    assert.equal(fit.bindings, stableSource.bindings, 'Every target must use the coefficient object computed from the source before reading the target.');
    assert.equal(fit.bindings, fit.stableSourceBindings);
    assert.equal(createStableMannequinBindings(sourceFit, mesh, sourceBody), stableSource, 'Target fitting must preserve the source coefficient cache.');
    assert.equal(sha(JSON.stringify(fit.bindings.vertices)), coefficientsSha256, 'Imported-body fitting must preserve the shared stabilized source coefficients.');
    assert.equal(fit.transfer.bindingStabilization.sourceOnly, true);
    assert.equal(fit.transfer.bindingStabilization.targetDependent, false);
    assert.ok(Math.abs(fit.transfer.bindingStabilization.stabilized.maximumAbsoluteWeight - maximumAbsoluteWeight) < 1e-12);
    assert.ok(Math.abs(fit.transfer.bindingStabilization.stabilized.maximumL1Mass - maximumL1Mass) < 1e-12);
    assert.equal(fit.sourceGarment, sourceFit.sourceGarment);
    assert.deepEqual([...fit.sourceGarment.indices], mesh.indices);
    assert.equal(fit.sourceGarment.uv, mesh.uv);
    assert.equal(fit.transferredGarment.indices, mesh.indices);
    assert.equal(fit.transferredGarment.uv, mesh.uv);
    assert.equal(fit.transferredGarment.vertexGroups, mesh.vertexGroups);
    assert.equal(fit.transfer.regeneratedGarment, false);
    assert.equal(fit.transfer.collisionRepairApplied, false);
    assert.equal(fit.transfer.originalBindingsReused, false);
    assert.equal(fit.transfer.sourceBindingsReusedAcrossTargets, true);
    assert.equal(fit.initialization, 'uploaded-canonical-uv-transfer');
    assert.ok(fit.transfer.maximumDisplacement > .01, 'Real uploaded body proportions must affect the original garment.');
    assert.ok(difference(fit.innerPositions, Float32Array.from(seed.positions)) < 1e-6);
    assert.ok(difference(fit.garmentPositions, deformWithCage(stableSource.bindings, Float32Array.from(seed.positions))) < 1e-6);
    validateWeights(fit.outerInfluences, bodyNames, 1358, `${entry.id}/${variant.id}/outer`);
    const states = [measureState(mesh, fit, rest, { width: 1, pose: 'stand', time: 0 }, mesh.positions, fit.diagnostics.after)];
    if (variant.family === 'Hoodie') {
      for (const settings of poseStates) states.push(measureState(mesh, fit, poser.getState(settings), settings, mesh.positions));
    }
    assert.equal(JSON.stringify(mesh), originalMesh, 'Transfer must not rewrite source garment data in memory.');
    assert.equal(hashFile(assetFile), variant.sha256, 'Transfer must not rewrite source garment files.');
    assert.equal(sha(JSON.stringify(fit.bindings.vertices)), coefficientsSha256, 'Pose evaluation must not rewrite the stabilized source coefficients.');
    assert.equal(sha(JSON.stringify(sourceFit.bindings.vertices)), originalCoefficientHash, 'Stabilization must keep the existing base R15 fitting coefficients intact.');
    reports.push({ garmentId: variant.id, sourceSha256: variant.sha256, originalCoefficientsSha256: originalCoefficientHash, coefficientsSha256, unstabilizedRestQuality, transfer: fit.transfer, states });
  }
  return { runId, id: entry.id, startedAt, completedAt: new Date().toISOString(), importVerification, correspondence, garments: reports };
}

function spawnTarget(entry) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), `--worker=${entry.id}`, `--run-id=${runId}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ id: entry.id, exitCode: null, error: error.message }));
    child.on('close', exitCode => {
      if (exitCode) return resolve({ id: entry.id, exitCode, stderr: stderr.slice(-6000) });
      try { resolve({ id: entry.id, exitCode, report: JSON.parse(stdout) }); }
      catch (error) { resolve({ id: entry.id, exitCode, error: error.message, stdout: stdout.slice(-1000), stderr: stderr.slice(-1000) }); }
    });
  });
}

if (worker) {
  const entry = catalog.entries.find(entry => entry.id === worker);
  assert.ok(entry, `Unknown mannequin worker ${worker}.`);
  console.log(JSON.stringify(await checkTarget(entry)));
} else {
  const startedAt = new Date().toISOString();
  const protectedFiles = [
    'roblox-cage.json', 'r15-body.json', 'blocky-cage-target.json', 'garment-variants.json',
    ...variants.map(variant => variant.filename),
    'mannequins/catalog.json',
    ...catalog.entries.flatMap(entry => [entry.bodyFile, entry.targetSeedFile, entry.cagesFile, ...entry.sourceFiles.map(source => source.file)]),
  ];
  assert.equal(catalog.entries.length, 3);
  const sources = catalog.entries.flatMap(entry => entry.sourceFiles);
  assert.equal(sources.length, 5);
  assert.equal(new Set(sources.map(source => source.file)).size, 5);
  for (const source of sources) {
    assert.equal(source.sha256, expectedSourceHashes[path.basename(source.file)], 'Catalog must record the exact uploaded FBX hash.');
    assert.equal(hashFile(assetPath(source.file)), source.sha256, 'Retained FBX bytes must match the original upload.');
  }
  const before = Object.fromEntries(protectedFiles.map(filename => [filename, hashFile(assetPath(filename))]));
  const runtimeFiles = ['src/cage-engine.js', 'src/cage-mls.js', 'src/cage-contact.js', 'src/mannequin-binding.js', 'src/mannequin-contact.js', 'src/mannequin-fit.js', 'src/r15-pose.js', 'tools/fbx-reader.mjs', 'tools/check-mannequins.mjs'];
  const runtimeBefore = Object.fromEntries(runtimeFiles.map(filename => [filename, hashFile(path.join(root, filename))]));
  const results = await Promise.all(catalog.entries.map(spawnTarget));
  const reports = results.filter(result => result.report).map(result => result.report);
  const states = reports.flatMap(report => report.garments.flatMap(garment => garment.states.map(state => ({ ...state, target: report.id, garmentId: garment.garmentId }))));
  const failures = results.filter(result => result.exitCode !== 0 || !result.report);
  const hashesPreserved = protectedFiles.every(filename => hashFile(assetPath(filename)) === before[filename]);
  const runtimeHashesPreserved = runtimeFiles.every(filename => hashFile(path.join(root, filename)) === runtimeBefore[filename]);
  const sameSourceCoefficientsAcrossTargets = variants.every(variant => {
    const hashes = reports.map(report => report.garments.find(garment => garment.garmentId === variant.id)?.coefficientsSha256);
    return hashes.length === 3 && hashes.every(hash => hash && hash === hashes[0]);
  });
  const executionIntegrityPassed = !failures.length && hashesPreserved && runtimeHashesPreserved && sameSourceCoefficientsAcrossTargets && reports.length === 3
    && reports.every(report => report.runId === runId && report.garments.length === 9)
    && states.length === 63;
  const excessiveStretchStates = states.filter(state => state.garment.grossSpikeEdges > 0).map(state => ({ targetId: state.target, garmentId: state.garmentId, width: state.width, pose: state.pose, time: state.time, grossSpikeEdges: state.garment.grossSpikeEdges, firstGrossSpikeEdges: state.garment.firstGrossSpikeEdges }));
  const compatibilityPassed = executionIntegrityPassed && excessiveStretchStates.length === 0;
  const integrityPassed = executionIntegrityPassed && compatibilityPassed;
  const summary = {
    stateCount: states.length,
    restFits: reports.reduce((total, report) => total + report.garments.length, 0),
    hoodiePoseStates: states.filter(state => state.pose !== 'stand' || state.width !== 1).length,
    bodyPenetrationStates: states.filter(state => state.body.penetrationSamples > 0).length,
    sampledEnvelopeFailureStates: states.filter(state => state.outer.outsideVertices > 0).length,
    relativeCollapseStates: states.filter(state => state.garment.collapsedRelativeTriangles > 0).length,
    maximumBodyPenetrationPercent: Math.max(0, ...states.map(state => state.body.penetrationPercent)),
    maximumBodyDepth: Math.max(0, ...states.map(state => state.body.maximumPenetration)),
    maximumSampledOutsidePercent: Math.max(0, ...states.map(state => state.outer.outsidePercent)),
    maximumSampledOutsideDistance: Math.max(0, ...states.map(state => state.outer.maximumOutsideDistance)),
    maximumEdgeStretch: Math.max(0, ...states.map(state => state.garment.edgeStretch.max)),
    maximumRestEdgeStretch: Math.max(0, ...states.filter(state => state.width === 1 && state.pose === 'stand').map(state => state.garment.edgeStretch.max)),
    maximumPosedEdgeStretch: Math.max(0, ...states.filter(state => state.width !== 1 || state.pose !== 'stand').map(state => state.garment.edgeStretch.max)),
    maximumEdgeLength: Math.max(0, ...states.map(state => state.garment.maximumEdgeLength)),
    maximumEdgeLengthGrowth: Math.max(0, ...states.map(state => state.garment.maximumEdgeLengthGrowth)),
    grossSpikeStates: excessiveStretchStates.length,
    unstabilizedRestGrossSpikeStates: reports.reduce((total, report) => total + report.garments.filter(garment => garment.unstabilizedRestQuality.grossSpikeEdges > 0).length, 0),
  };
  const report = {
    schemaVersion: 1, runId, startedAt, completedAt: new Date().toISOString(),
    validation: { integrityPassed, executionIntegrityPassed, compatibilityPassed, geometryPassed: integrityPassed && !summary.bodyPenetrationStates && !summary.sampledEnvelopeFailureStates && !summary.relativeCollapseStates, hashesPreserved, runtimeHashesPreserved, sameSourceCoefficientsAcrossTargets, failedWorkers: failures, compatibilityLimits, excessiveStretchStates },
    summary, originalUploadedSourceHashes: expectedSourceHashes, protectedAssetSha256: before, runtimeSha256: runtimeBefore, mannequins: reports,
    limitations: [
      'Transferred garment coordinates are calculated from the original R15 mesh and one stabilized coefficient set computed only from its source cage/body; the same coefficient hash is verified on all three targets. No garment recipe is regenerated for the imported body.',
      'Rest penetration checks include every garment vertex and four samples on every triangle. Posed penetration checks include every vertex and four samples on 128 evenly spaced triangles.',
      'Outer coverage uses exact closest-triangle distance and absolute generalized winding on 256 evenly spaced garment vertices per state; unsampled vertices and faces are not certified.',
      'Uploaded FBX mannequins are static. Poses use explicitly inferred demonstration joints rather than an imported FBX animation rig.',
      'Geometry quality failures are retained as measured limitations. Passing integrity does not imply every outfit fits every body or that Roblox Marketplace checks will pass.',
      'The gross-spike regression fails if an edge simultaneously exceeds 8x its original length and grows by more than 0.5 stud in rest, or exceeds 16x and grows by more than 0.8 stud in a posed demonstration. Smaller proportional distortions remain reported quality limitations. These permissive limits do not certify fabric stretch or fit quality.',
    ],
  };
  fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(root, 'evidence', 'mannequin-check.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ validation: report.validation, summary }, null, 2));
  if (!integrityPassed) process.exitCode = 1;
}
