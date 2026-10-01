import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Matrix4 } from '../vendor/three/three.module.js';
import { extract, meshTransforms, transformPositions, bounds, triangulate, cornerUv } from './fbx-reader.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_OUTPUT = path.join(ROOT, 'assets/mannequins');
const definitions = [
  { id: 'classic', label: 'Classic Mannequin', caged: 'ClassicMannequin_With-Cages.fbx' },
  { id: 'rthro', label: 'Rthro Mannequin', caged: 'RthroMannequin_With-Cages.fbx', uncaged: 'RthroMannequin.fbx' },
  { id: 'rthro-slender', label: 'Rthro Slender Mannequin', caged: 'RthroSlenderMannequin_With-Cages.fbx', uncaged: 'RthroSlenderMannequin.fbx' },
];
const parents = {
  HumanoidRootPart: null, LowerTorso: 'HumanoidRootPart', UpperTorso: 'LowerTorso', Head: 'UpperTorso',
  LeftUpperArm: 'UpperTorso', LeftLowerArm: 'LeftUpperArm', LeftHand: 'LeftLowerArm',
  RightUpperArm: 'UpperTorso', RightLowerArm: 'RightUpperArm', RightHand: 'RightLowerArm',
  LeftUpperLeg: 'LowerTorso', LeftLowerLeg: 'LeftUpperLeg', LeftFoot: 'LeftLowerLeg',
  RightUpperLeg: 'LowerTorso', RightLowerLeg: 'RightUpperLeg', RightFoot: 'RightLowerLeg',
};
const standardParts = Object.keys(parents).filter(name => name !== 'HumanoidRootPart');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const arrayHash = values => crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
const uvKey = values => values.map(value => value.toFixed(6)).join(',');
const distance = (a, b) => Math.hypot(...a.map((value, axis) => value - b[axis]));
const average = values => [0, 1, 2].map(axis => values.reduce((sum, point) => sum + point[axis], 0) / values.length);
const assetPath = file => path.relative(ROOT, file).split(path.sep).join('/');
function sourcePath(sourceDir, wanted) {
  const candidates = fs.readdirSync(sourceDir).filter(name => name === wanted || name.replace(/^\d+-/, '') === wanted);
  assert.equal(candidates.length, 1, `Need one source ${wanted} in ${sourceDir}`);
  return path.join(sourceDir, candidates[0]);
}
function loadSource(file) {
  const extracted = extract(file);
  const meshes = meshTransforms(extracted).map(mesh => ({ ...mesh, positions: transformPositions(mesh.geometry.positions, mesh.matrix) }));
  assert.equal(extracted.deformers.filter(deformer => deformer.type === 'Cluster').length, 0, 'These imported mannequin templates are static, not authored skinned rigs');
  assert.equal(extracted.models.filter(model => ['LimbNode', 'Root'].includes(model.type)).length, 0, 'Unexpected authored skeleton; update this importer rather than inferring a rig');
  return { extracted, meshes, source: { file: path.basename(file).replace(/^\d+-/, ''), sha256: sha256(file), byteLength: fs.statSync(file).size, binaryVersion: extracted.version } };
}
function outputMesh(mesh, normalizationMatrix) {
  const positions = transformPositions(mesh.positions, normalizationMatrix), geometry = mesh.geometry;
  const topology = triangulate(geometry.polygonIndices, positions.length / 3, positions);
  const uv = geometry.uvLayers[0];
  cornerUv(geometry); // Validate complete corner indexing while preserving original UV arrays.
  return {
    name: mesh.model.name, positions, ...topology, polygonIndices: geometry.polygonIndices,
    uv: uv.uv, uvIndices: uv.uvIndices ?? [], uvMapping: uv.mapping, uvReference: uv.reference,
    bounds: bounds(positions), vertexCount: positions.length / 3, polygonCount: topology.polygons.length, triangleCount: topology.indices.length / 3,
    source: { geometryId: geometry.id, geometryName: geometry.name, modelId: mesh.model.id, modelName: mesh.model.name, properties: mesh.model.properties,
      modelWorldMatrix: mesh.worldMatrix.toArray(), geometricMatrix: mesh.geometricMatrix.toArray(), geometryToSceneMatrix: mesh.matrix.toArray(), determinant: mesh.matrix.determinant() },
  };
}
function canonicalKeys(canonical) {
  const keys = Array.from({ length: canonical.vertexCount }, () => new Map());
  canonical.polygonIndices.forEach((raw, corner) => {
    const id = raw < 0 ? -raw - 1 : raw, uvId = canonical.uvIndices[corner], uv = canonical.uv.slice(uvId * 2, uvId * 2 + 2);
    keys[id].set(uvKey(uv), uv);
  });
  return keys;
}
function sourceUvMap(mesh) {
  const byUv = new Map();
  cornerUv({ ...mesh, uvLayers: [{ uv: mesh.uv, uvIndices: mesh.uvIndices, mapping: mesh.uvMapping, reference: mesh.uvReference }] }).forEach((uv, corner) => {
    const raw = mesh.polygonIndices[corner], id = raw < 0 ? -raw - 1 : raw, key = uvKey(uv);
    if (!byUv.has(key)) byUv.set(key, new Map());
    byUv.get(key).set(id, { id, uv, position: mesh.positions.slice(id * 3, id * 3 + 3) });
  });
  return byUv;
}
function canonicalFaceKey(polygon) {
  const first = polygon.indexOf(Math.min(...polygon));
  return [...polygon.slice(first), ...polygon.slice(0, first)].join(',');
}
function canonicalTarget(canonical, inner, partCages, provenance) {
  const keys = canonicalKeys(canonical), byUv = sourceUvMap(inner);
  const sourceVertexIds = [], positions = [], originalToCanonical = new Map();
  const mergedCanonicalVertexIds = [], duplicateDetails = []; let maximumDuplicateSpread = 0, maximumUvResidual = 0;
  keys.forEach((vertexKeys, vertex) => {
    const candidates = new Map();
    for (const [key, canonicalUV] of vertexKeys) {
      const records = byUv.get(key); assert.ok(records?.size, `Missing canonical UV ${key} for vertex ${vertex}`);
      for (const [id, record] of records) { candidates.set(id, record); maximumUvResidual = Math.max(maximumUvResidual, Math.hypot(...record.uv.map((value, axis) => value - canonicalUV[axis]))); }
    }
    const records = [...candidates.values()], points = records.map(record => record.position), ids = records.map(record => record.id).sort((a, b) => a - b);
    assert.ok(points.length, `Canonical vertex ${vertex} has no source control point`);
    let spread = 0; for (const a of points) for (const b of points) spread = Math.max(spread, distance(a, b));
    maximumDuplicateSpread = Math.max(maximumDuplicateSpread, spread);
    if (ids.length > 1) { mergedCanonicalVertexIds.push(vertex); duplicateDetails.push({ canonicalVertexId: vertex, sourceVertexIds: ids, sourcePositions: points, spread, policy: 'Arithmetic mean of actual source control points sharing the same canonical cage UV vertex. Original split control points remain intact in the cages asset.' }); }
    positions.push(...average(points)); sourceVertexIds.push(ids);
    for (const id of ids) { assert.ok(!originalToCanonical.has(id) || originalToCanonical.get(id) === vertex, 'Source control point maps to distinct canonical vertices'); originalToCanonical.set(id, vertex); }
  });
  assert.equal(originalToCanonical.size, inner.vertexCount, 'Every original cage control point must have explicit correspondence');
  const sourceFaces = inner.polygons.map(polygon => canonicalFaceKey(polygon.map(id => originalToCanonical.get(id)))).sort();
  const canonicalFaces = canonical.polygons.map(canonicalFaceKey).sort();
  assert.deepEqual(sourceFaces, canonicalFaces, 'UV remapping must also preserve the complete oriented canonical polygon topology');
  assert.ok(maximumUvResidual < 1e-6, 'Canonical correspondence UV residual is too large');

  const ownershipByUv = new Map();
  for (const cage of partCages) {
    const name = cage.name.replace(/_OuterCage$/, ''); assert.ok(standardParts.includes(name), `Unknown part cage owner ${name}`);
    for (const [key, records] of sourceUvMap(cage)) {
      if (!ownershipByUv.has(key)) ownershipByUv.set(key, new Map());
      ownershipByUv.get(key).set(name, [...records.values()].map(record => record.position));
    }
  }
  let maximumPartCageCoordinateResidual = 0;
  const sourcePartNames = keys.map((vertexKeys, vertex) => {
    const owners = new Set();
    for (const key of vertexKeys.keys()) for (const [name, ownerPoints] of ownershipByUv.get(key) ?? []) {
      owners.add(name);
      for (const point of ownerPoints) maximumPartCageCoordinateResidual = Math.max(maximumPartCageCoordinateResidual, distance(point, positions.slice(vertex * 3, vertex * 3 + 3)));
    }
    assert.ok(owners.size, `No authored segment owner for canonical vertex ${vertex}`);
    return [...owners].sort();
  });
  const influences = sourcePartNames.map(names => names.map(name => ({ name, weight: 1 / names.length })));
  return {
    schemaVersion: 1, name: `${provenance.id}_authored_mannequin_cage_target`, units: 'stud', axis: 'Y-up', facing: '-Z', positions, influences,
    canonicalUv: canonical.uv, canonicalIndices: canonical.indices, canonicalVertexCount: canonical.vertexCount, sourceVertexIds, sourcePartNames,
    canonicalTopologyPolicy: 'Positions and named influences are explicitly reordered by canonical polygon-corner UV correspondence. Canonical original indices, UVs, and vertex order remain unchanged. Source oriented polygon sets are independently checked after remapping.',
    provenance: { ...provenance, method: 'canonical-uv-correspondence; original full inner cage control points with segment ownership from same-named authored part outer cages',
      ownershipMethod: 'Exact canonical polygon-corner UV ownership; equal weights only at shared authored part cage seams. No inferred nearest-body influence fallback.',
      canonicalTopology: { vertexCount: canonical.vertexCount, indicesSha256: arrayHash(canonical.indices), uvSha256: arrayHash(canonical.uv) },
    },
    fallbackVertexIds: [], mergedCanonicalVertexIds, duplicateDetails,
    diagnostics: { vertexCount: canonical.vertexCount, sourceControlPointCount: inner.vertexCount, uvMatchedVertices: canonical.vertexCount, matchedVertexCount: canonical.vertexCount,
      interpolatedVertices: 0, fallbackVertices: 0, ownershipMatchedVertices: canonical.vertexCount, ownershipFallbackVertices: 0,
      mergedCanonicalVertices: mergedCanonicalVertexIds.length, maximumDuplicateSpread, maximumUvResidual, maximumPartCageCoordinateResidual,
      orientedCanonicalPolygonTopologyVerified: true, influenceWeightsNormalized: true, targetBounds: bounds(positions),
    },
  };
}
function inferredJoints(parts, target) {
  const names = Object.keys(parents), nodeIds = new Map(names.map((name, index) => [name, index]));
  const lowerTorso = parts.find(part => part.name === 'LowerTorso');
  return names.map(name => {
    const parent = parents[name];
    let position, sourceCanonicalVertexIds = [], source;
    if (name === 'HumanoidRootPart' || name === 'LowerTorso') {
      position = [...lowerTorso.bounds.center]; source = 'Inferred pelvis center from LowerTorso authored mesh bounds; no authored skeletal root exists in this FBX.';
    } else {
      sourceCanonicalVertexIds = target.sourcePartNames.flatMap((owners, vertex) => owners.includes(name) && owners.includes(parent) ? [vertex] : []);
      assert.ok(sourceCanonicalVertexIds.length, `Missing authored cage seam for joint ${name} -> ${parent}`);
      position = average(sourceCanonicalVertexIds.map(vertex => target.positions.slice(vertex * 3, vertex * 3 + 3)));
      source = 'Inferred centroid of the canonical vertices shared by the two authored part outer cages; a demo motion pivot, not an authored FBX bone.';
    }
    return { name, nodeIndex: nodeIds.get(name), parentNodeIndex: parent ? nodeIds.get(parent) : null, parent, position, source, sourceCanonicalVertexIds };
  });
}
function compareBodyPair(caged, uncaged) {
  const a = caged.meshes.filter(mesh => mesh.model.name.endsWith('_Geo')), b = uncaged.meshes.filter(mesh => mesh.model.name.endsWith('_Geo'));
  assert.equal(a.length, 15); assert.equal(b.length, 15); let maximumWorldPositionDifference = 0;
  const parts = a.map(mesh => {
    const other = b.find(candidate => candidate.model.name === mesh.model.name); assert.ok(other, `Body pair missing ${mesh.model.name}`);
    assert.deepEqual(mesh.geometry.positions, other.geometry.positions, `Caged source changed raw vertices for ${mesh.model.name}`);
    assert.deepEqual(mesh.geometry.polygonIndices, other.geometry.polygonIndices, `Caged source changed topology for ${mesh.model.name}`);
    assert.deepEqual(mesh.geometry.uvLayers, other.geometry.uvLayers, `Caged source changed UVs for ${mesh.model.name}`);
    const difference = Math.max(...mesh.positions.map((value, index) => Math.abs(value - other.positions[index])));
    maximumWorldPositionDifference = Math.max(maximumWorldPositionDifference, difference);
    return { name: mesh.model.name.replace(/_Geo$/, ''), rawPositionsEqual: true, polygonTopologyEqual: true, uvLayersEqual: true, maximumWorldPositionDifference: difference };
  });
  assert.ok(maximumWorldPositionDifference < 1e-6, 'Caged and uncaged mannequin world geometry differs beyond export rounding tolerance');
  return { cagedSource: caged.source, uncagedSource: uncaged.source, partCount: 15, rawPositionsEqual: true, polygonTopologyEqual: true, uvLayersEqual: true, maximumWorldPositionDifference, worldPositionComparisonTolerance: 1e-6, worldPositionsEquivalentWithinExportRounding: true, parts };
}

export function importMannequins({ sourceDir = path.join(DEFAULT_OUTPUT, 'source'), outputDir = DEFAULT_OUTPUT } = {}) {
  const canonicalFile = path.join(ROOT, 'assets/roblox-cage.json'), canonical = JSON.parse(fs.readFileSync(canonicalFile, 'utf8')).inner;
  assert.equal(canonical.vertexCount, 1358);
  fs.mkdirSync(outputDir, { recursive: true }); fs.mkdirSync(path.join(outputDir, 'source'), { recursive: true });
  const sourceFiles = [...new Set(definitions.flatMap(definition => [definition.caged, definition.uncaged].filter(Boolean)))];
  for (const filename of sourceFiles) {
    const original = sourcePath(sourceDir, filename), destination = path.join(outputDir, 'source', filename);
    if (path.resolve(original) !== path.resolve(destination)) {
      if (fs.existsSync(destination)) assert.equal(sha256(destination), sha256(original), `Refusing to overwrite different source ${destination}`); else fs.copyFileSync(original, destination);
    }
  }
  const entries = [], importReports = [];
  for (const definition of definitions) {
    const cagedFile = path.join(outputDir, 'source', definition.caged), caged = loadSource(cagedFile);
    const uncaged = definition.uncaged ? loadSource(path.join(outputDir, 'source', definition.uncaged)) : null;
    const pairing = uncaged ? compareBodyPair(caged, uncaged) : { available: false, reason: 'No separate uncaged ClassicMannequin.fbx was supplied; the 15 body meshes are extracted directly from the caged file.' };
    const sourceBody = caged.meshes.filter(mesh => mesh.model.name.endsWith('_Geo'));
    assert.equal(sourceBody.length, 15, `${definition.id} must have all fifteen actual mannequin body meshes`);
    const rawBounds = bounds(sourceBody.flatMap(mesh => mesh.positions));
    // Roblox reference meshes use numerical stud coordinates despite meter-like
    // FBX metadata. Preserve all original dimensions; no per-body rescale occurs.
    // The source Left parts are +X/front+Z; a proper Y180 rotation aligns them to
    // the existing Cage Lab Left=-X/front=-Z convention without a reflection.
    const floorCenterOffset = [-rawBounds.center[0], -rawBounds.min[1], -rawBounds.center[2]];
    const matrix = new Matrix4().makeRotationY(Math.PI).multiply(new Matrix4().makeTranslation(...floorCenterOffset));
    const normalization = { offsetBeforeRotation: floorCenterOffset, rotationAxis: 'Y', rotationDegrees: 180, scale: 1, matrix: matrix.toArray(), determinant: matrix.determinant(), originalBounds: rawBounds,
      unitsPolicy: 'Preserve authored Roblox reference numerical dimensions as Cage Lab stud coordinates. FBX UnitScaleFactor is retained as source metadata, not applied as an undocumented physical scale.',
      inputUnitScaleFactor: caged.extracted.settings.UnitScaleFactor?.[0], originalUnitScaleFactor: caged.extracted.settings.OriginalUnitScaleFactor?.[0], inputAxes: caged.extracted.settings,
    };
    const meshes = caged.meshes.map(mesh => outputMesh(mesh, matrix));
    const parts = meshes.filter(mesh => mesh.name.endsWith('_Geo')).map(mesh => ({ ...mesh, name: mesh.name.replace(/_Geo$/, '') }));
    assert.deepEqual(parts.map(part => part.name).sort(), [...standardParts].sort());
    assert.ok(parts.find(part => part.name === 'LeftUpperArm').bounds.center[0] < 0);
    assert.ok(parts.find(part => part.name === 'RightUpperArm').bounds.center[0] > 0);
    const inner = meshes.find(mesh => mesh.name === 'ClothingName_InnerCage' || mesh.name === '_InnerCage');
    const outer = meshes.find(mesh => mesh.name === 'ClothingName_OuterCage' || mesh.name === '_OuterCage');
    const partCages = meshes.filter(mesh => mesh.name.endsWith('_OuterCage') && mesh !== outer);
    assert.ok(inner && outer); assert.equal(partCages.length, 15);
    assert.deepEqual(inner.polygonIndices, outer.polygonIndices); assert.deepEqual(inner.uv, outer.uv); assert.deepEqual(inner.uvIndices, outer.uvIndices); assert.deepEqual(inner.positions, outer.positions);
    const provenance = { id: definition.id, sourceFile: assetPath(cagedFile), sourceSha256: caged.source.sha256, canonicalCageFile: assetPath(canonicalFile), canonicalCageSha256: sha256(canonicalFile), normalization };
    const target = canonicalTarget(canonical, inner, partCages, provenance);
    const joints = inferredJoints(parts, target), normalizedBounds = bounds(parts.flatMap(part => part.positions));
    assert.ok(Math.abs(normalizedBounds.min[1]) < 1e-12);
    const rigSource = 'inferred-from-authored-part-cage-seams; FBX contains no skin clusters or skeleton';
    const rigMetadata = { authoredBoneCount: 0, authoredSkinClusterCount: 0, authoredBindPoseCount: caged.extracted.poses.length, inferredDemoJointCount: joints.length,
      policy: 'Named cage-seam centroids provide R15 demonstration pivots only. This does not import authored skin weights or skeletal animations.',
    };
    const body = { schemaVersion: 1, id: definition.id, name: definition.label, units: 'stud', axis: 'Y-up', facing: '-Z', parts, joints, bounds: normalizedBounds, normalization, source: { ...caged.source, file: assetPath(cagedFile) }, rigSource, rigMetadata, pairing };
    const cages = { schemaVersion: 1, id: definition.id, name: definition.label, units: 'stud', axis: 'Y-up', facing: '-Z', source: body.source, normalization,
      inner, outer, parts: partCages, topologyPolicy: 'Original source control-point counts, polygon indices, UV corner arrays, and split vertices are preserved. These original FBX cages must not be confused with the separately generated canonical1358 target.',
      diagnostics: { actualFullInnerControlPoints: inner.vertexCount, actualFullOuterControlPoints: outer.vertexCount, originalBodyPartCageCount: partCages.length, fullInnerOuterIdentical: true, canonicalCorrespondence: target.diagnostics },
    };
    const files = { bodyFile: path.join(outputDir, `${definition.id}-body.json`), targetSeedFile: path.join(outputDir, `${definition.id}-cage-target.json`), cagesFile: path.join(outputDir, `${definition.id}-cages.json`) };
    fs.writeFileSync(files.bodyFile, JSON.stringify(body)); fs.writeFileSync(files.targetSeedFile, JSON.stringify(target)); fs.writeFileSync(files.cagesFile, JSON.stringify(cages));
    const diagnostics = { ...target.diagnostics, bodyParts: parts.length, bodyVertices: parts.reduce((sum, part) => sum + part.vertexCount, 0), bodyTriangles: parts.reduce((sum, part) => sum + part.triangleCount, 0), bodyBounds: normalizedBounds, rigSource, pairingValidated: Boolean(uncaged) };
    const entry = { id: definition.id, label: definition.label, ...Object.fromEntries(Object.entries(files).map(([key, file]) => [key, assetPath(file)])),
      sourceFiles: [definition.caged, definition.uncaged].filter(Boolean).map(filename => ({ file: assetPath(path.join(outputDir, 'source', filename)), sha256: sha256(path.join(outputDir, 'source', filename)) })), diagnostics };
    entries.push(entry);
    importReports.push({ ...entry, normalization, rigMetadata, bodyPairValidation: pairing, sourceModels: caged.extracted.models, meshes: meshes.map(mesh => ({ name: mesh.name, vertexCount: mesh.vertexCount, polygonCount: mesh.polygonCount, triangleCount: mesh.triangleCount, bounds: mesh.bounds, source: mesh.source })),
      duplicateDetails: target.duplicateDetails, inferredJoints: joints, outputSha256: Object.fromEntries(Object.entries(files).map(([key, file]) => [key, sha256(file)])) });
    console.log(JSON.stringify({ id: definition.id, files: Object.fromEntries(Object.entries(files).map(([key, file]) => [key, assetPath(file)])), diagnostics }));
  }
  const catalog = { schemaVersion: 1, entries, sourceFileCount: sourceFiles.length, generatedBy: 'tools/import-mannequins.mjs', importPolicy: 'Use the actual 15 source body meshes. Import all source cages without modifying topology; canonical targets are reordered by verified polygon-corner UV correspondence. No authored rig is present; motion is a Cage Lab inferred-joint demonstration.' };
  fs.writeFileSync(path.join(outputDir, 'catalog.json'), JSON.stringify(catalog, null, 2));
  fs.writeFileSync(path.join(outputDir, 'import-report.json'), JSON.stringify({ schemaVersion: 1, sourceFileCount: sourceFiles.length, canonicalSourceSha256: sha256(canonicalFile), generatedBy: catalog.generatedBy, mannequins: importReports }, null, 2));
  return catalog;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); let sourceDir, outputDir;
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!value || !['--source-dir', '--output-dir'].includes(name)) throw new Error('Usage: node tools/import-mannequins.mjs [--source-dir <FBX directory>] [--output-dir <asset directory>]');
    if (name === '--source-dir') sourceDir = path.resolve(value); else outputDir = path.resolve(value);
  }
  importMannequins({ sourceDir, outputDir });
}
