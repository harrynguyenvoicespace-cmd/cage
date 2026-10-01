import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as engine from '../src/cage-engine.js';
import { createR15Poser, posePoints } from '../src/r15-pose.js';

const { createDemoFit, rebindWithCorrespondence, deformWithCage, createSurface, meshBounds } = engine;

const root = path.resolve(import.meta.dirname, '..');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (process.argv.includes('--all-variants')) {
  const variantFiles = ['r15-shirt', 'r15-long-shirt', 'r15-wide-sweater', 'r15-jacket'];
  const reports = [];
  const codeFiles = ['src/cage-engine.js', 'src/cage-mls.js', 'src/r15-pose.js', 'src/garment.js'];
  const allHashesBefore = Object.fromEntries(codeFiles.map(file => [file, sha256(path.join(root, file))]));
  const startedAt = new Date().toISOString();
  for (const asset of variantFiles) {
    const filename = `independent-${asset}-check.json`;
    const args = [path.join(root, 'tools/check-fit.mjs'), `--garment=${asset}`, `--output=${filename}`];
    if (process.argv.includes('--heuristic')) args.push('--heuristic');
    const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    const reportFile = path.join(root, 'evidence', filename);
    if (!fs.existsSync(reportFile)) throw new Error(`Variant audit did not produce ${filename}.`);
    reports.push(JSON.parse(fs.readFileSync(reportFile)));
    if (result.status !== 0) console.error(`Variant ${asset} detected changed inputs or invalid geometry.`);
  }
  const states = reports.flatMap(report => report.states.map(state => ({ garmentAsset: report.garmentAsset, ...state })));
  const combined = {
    schemaVersion: 1, startedAt, completedAt: new Date().toISOString(),
    algorithmPolicy: 'All four independent garment meshes use exactly the same cage seed, factory options, binding and pose algorithms. There are no per-style fitting parameters.',
    factoryOptions: reports.map(report => ({ garmentAsset: report.garmentAsset, options: report.factoryOptions })),
    sharedAlgorithmCodeHashes: allHashesBefore,
    codeUnchangedAcrossAllVariants: codeFiles.every(file => allHashesBefore[file] === sha256(path.join(root, file))),
    allInputsStable: reports.every(report => report.codeUnchangedDuringCheck && report.assetsUnchangedDuringCheck && report.runtimeUnchangedDuringCheck),
    sourceHashes: Object.fromEntries(reports.map(report => [report.garmentAsset, report.sourceHashes])),
    runtimeHashesAtStart: reports[0].runtimeHashesAtStart,
    variants: reports.map(report => ({ garmentAsset: report.garmentAsset, bindingIdentity: report.bindingIdentity, topology: report.topology, initialFitQuality: report.initialFitQuality, summary: report.summary })),
    states,
    summary: {
      garmentCount: reports.length, testedStates: states.length,
      nonfiniteStates: states.filter(s => s.garment.nonfiniteCoordinates || s.inner.nonfiniteCoordinates || s.outerQuality.nonfiniteCoordinates).length,
      bodyPenetrationStates: states.filter(s => s.body.penetrationSamples).length,
      worstPenetrationPercent: Math.max(...states.map(s => s.body.penetrationPercent)),
      worstIndividualPartDepth: Math.max(...states.map(s => s.body.maximumIndividualPartDepth)),
      envelopeCoverageFailureStates: states.filter(s => s.outer.windingOutsideVertices).length,
      worstOutsidePercent: Math.max(...states.map(s => s.outer.windingOutsidePercent)),
      maximumWindingOutsideDistance: Math.max(...states.map(s => s.outer.maximumWindingOutsideDistance)),
      statesWithDegenerateGarmentTriangles: states.filter(s => s.garment.degenerateTriangles).length,
      statesWithRelativeCollapsedTriangles: states.filter(s => s.garment.collapsedRelativeTriangles).length,
    },
  };
  fs.writeFileSync(path.join(root, 'evidence/independent-all-variants-check.json'), JSON.stringify(combined, null, 2));
  console.log(JSON.stringify(combined.summary, null, 2));
  if (!combined.codeUnchangedAcrossAllVariants || !combined.allInputsStable || combined.summary.nonfiniteStates) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}
const read = name => JSON.parse(fs.readFileSync(path.join(root, 'assets', name + '.json')));
const requestedGarment = process.argv.find(arg => arg.startsWith('--garment='))?.slice('--garment='.length);
const garmentAsset = requestedGarment ?? (fs.existsSync(path.join(root, 'assets', 'r15-shirt.json')) && !process.argv.includes('--legacy') ? 'r15-shirt' : 'roblox-tshirt');
const cage = read('roblox-cage'), shirt = read(garmentAsset), body = read('r15-body');
const targetSeed = !process.argv.includes('--heuristic') && garmentAsset !== 'roblox-tshirt' && fs.existsSync(path.join(root, 'assets/blocky-cage-target.json')) ? read('blocky-cage-target') : null;
const factoryOptions = targetSeed ? { targetSeed } : {};
const engineFile = path.join(root, 'src', 'cage-engine.js');
const engineHash = sha256(engineFile);
const codeFiles = { engine: engineFile, mls: path.join(root, 'src/cage-mls.js'), pose: path.join(root, 'src/r15-pose.js') };
const codeHashesAtStart = Object.fromEntries(Object.entries(codeFiles).map(([name, file]) => [name, sha256(file)]));
const assetFiles = { cage: path.join(root, 'assets/roblox-cage.json'), shirt: path.join(root, 'assets', garmentAsset + '.json'), body: path.join(root, 'assets/r15-body.json') };
const assetHashesAtStart = Object.fromEntries(Object.entries(assetFiles).map(([name, file]) => [name, sha256(file)]));
function allFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? allFiles(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
const runtimeFiles = [path.join(root, 'index.html'), ...allFiles(path.join(root, 'src')), ...allFiles(path.join(root, 'vendor')), ...fs.readdirSync(path.join(root, 'assets')).filter(name => /\.(json|glb)$/.test(name)).map(name => path.join(root, 'assets', name))];
const runtimeHashesAtStart = Object.fromEntries(runtimeFiles.map(file => [path.relative(root, file).replaceAll('\\', '/'), sha256(file)]));
const quick = process.argv.includes('--quick');
const point = (p, i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
const minus = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => Math.sqrt(dot(a, a));
const unit = a => a.map(v => v / norm(a));
const dirs = [[1, .3719, .1273], [.2271, 1, .4397], [.3137, .2739, 1]].map(unit);
const percentile = (sorted, p) => sorted[Math.floor((sorted.length - 1) * p)] ?? null;
const equal = (a, b) => a?.length === b?.length && a.every((v, i) => v === b[i]);

/** Independent closed-solid predicate. The union is inside ANY individual R15
 * part. Three non-axis-aligned rays avoid coincident face/edge ray accidents;
 * bounding boxes cheaply reject distant points. No global overlapping-solid
 * parity is used. Signed depth is an individual-part depth, not a claim to have
 * solved the closest boundary of the Boolean union. */
function bodyUnion(parts) {
  const surfaces = parts.map(part => ({ name: part.name, surface: createSurface(part), bounds: meshBounds(part.positions) }));
  return p => {
    let inside = false, deepestPartDepth = 0, nearestDistance = Infinity, ambiguous = false, deepestPart = null;
    const containingParts = [];
    for (const { name, surface, bounds } of surfaces) {
      const hit = surface.closest(p);
      const distance = Math.sqrt(hit.distance2);
      nearestDistance = Math.min(nearestDistance, distance);
      if (p.some((v, k) => v < bounds.min[k] - 1e-7 || v > bounds.max[k] + 1e-7) || distance < 1e-7) continue;
      const votes = dirs.map(dir => surface.ray(p, dir).length % 2);
      if (votes.some(v => v !== votes[0])) ambiguous = true;
      if (votes.reduce((a, b) => a + b, 0) >= 2) {
        inside = true;
        containingParts.push({ name, depth: distance });
        if (distance > deepestPartDepth) { deepestPartDepth = distance; deepestPart = name; }
      }
    }
    return { inside, deepestPartDepth, deepestPart, nearestDistance, ambiguous, containingParts };
  };
}

function samplePositions(positions, indices) {
  const out = [];
  for (let i = 0; i < positions.length / 3; i++) out.push({ p: point(positions, i), vertex: i });
  for (let i = 0; i < indices.length; i += 3) {
    const ids = [indices[i], indices[i + 1], indices[i + 2]];
    const points = ids.map(id => point(positions, id));
    for (const bary of [[1 / 3, 1 / 3, 1 / 3], [.5, .5, 0], [0, .5, .5], [.5, 0, .5]]) {
      out.push({ p: [0, 1, 2].map(k => points.reduce((s, p, j) => s + p[k] * bary[j], 0)), face: i / 3, bary, ids });
    }
  }
  return out;
}

function triangleQuality(rest, current, indices) {
  const areas = [], edgeRatios = [], seen = new Set();
  let nonfiniteCoordinates = 0, degenerateTriangles = 0, collapsedRelativeTriangles = 0;
  for (const value of current) if (!Number.isFinite(value)) nonfiniteCoordinates++;
  for (let i = 0; i < indices.length; i += 3) {
    const ids = [indices[i], indices[i + 1], indices[i + 2]];
    const before = ids.map(id => point(rest, id)), after = ids.map(id => point(current, id));
    const a = norm(cross(minus(before[1], before[0]), minus(before[2], before[0])));
    const b = norm(cross(minus(after[1], after[0]), minus(after[2], after[0])));
    if (b < 1e-8) degenerateTriangles++;
    if (a > 1e-8) { areas.push(b / a); if (b / a < .01) collapsedRelativeTriangles++; }
    for (let j = 0; j < 3; j++) {
      const from = ids[j], to = ids[(j + 1) % 3], id = `${Math.min(from, to)}:${Math.max(from, to)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const old = norm(minus(point(rest, to), point(rest, from)));
      if (old > 1e-8) edgeRatios.push(norm(minus(point(current, to), point(current, from))) / old);
    }
  }
  areas.sort((a, b) => a - b); edgeRatios.sort((a, b) => a - b);
  const range = values => ({ min: values[0], p01: percentile(values, .01), p05: percentile(values, .05), median: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99), max: values.at(-1) });
  return { nonfiniteCoordinates, degenerateTriangles, collapsedRelativeTriangles, areaRatio: range(areas), edgeStretch: range(edgeRatios) };
}

function topology(mesh) {
  const edges = new Map();
  for (let i = 0; i < mesh.indices.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = mesh.indices[i + j], b = mesh.indices[i + (j + 1) % 3];
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  return { vertices: mesh.positions.length / 3, triangles: mesh.indices.length / 3, edges: edges.size, boundaryEdges: [...edges.values()].filter(n => n === 1).length, nonmanifoldEdges: [...edges.values()].filter(n => n > 2).length, eulerCharacteristic: mesh.positions.length / 3 - edges.size + mesh.indices.length / 3 };
}

/** Generalized winding number via summed oriented triangle solid angles. Unlike
 * a single ray, small eye/mouth boundary loops do not turn an otherwise interior
 * torso point into an outside point. Strong deviations still expose foldovers,
 * self-overlap, and genuinely unenclosed garment points. */
function windingNumber(p, positions, indices) {
  let angle = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = minus(point(positions, indices[i]), p), b = minus(point(positions, indices[i + 1]), p), c = minus(point(positions, indices[i + 2]), p);
    const numerator = dot(a, cross(b, c));
    const la = norm(a), lb = norm(b), lc = norm(c);
    const denominator = la * lb * lc + dot(a, b) * lc + dot(b, c) * la + dot(c, a) * lb;
    angle += 2 * Math.atan2(numerator, denominator);
  }
  return angle / (4 * Math.PI);
}

const demo = garmentAsset !== 'roblox-tshirt' ? engine.createR15GarmentFit(cage, shirt, body, factoryOptions) : createDemoFit(cage, shirt, body);
const restBindings = rebindWithCorrespondence(demo.bindings, demo.innerPositions, demo.garmentPositions);
const reproducedRest = deformWithCage(restBindings, demo.innerPositions);
let maximumRestReproductionError = 0;
for (let i = 0; i < reproducedRest.length / 3; i++) maximumRestReproductionError = Math.max(maximumRestReproductionError, norm(minus(point(reproducedRest, i), point(demo.garmentPositions, i))));
const poser = createR15Poser(body);
const states = [];
for (const width of (quick ? [1] : [1, 1.4])) for (const [pose, time] of (quick ? [['stand', 0]] : [['stand', 0], ['arms', 0], ['walk', 0], ['walk', .4], ['walk', .9]])) {
  const posed = poser.getState({ width, pose, time });
  const inner = posePoints(demo.innerPositions, demo.influences, posed);
  const outer = posePoints(demo.outerPositions, demo.outerInfluences ?? demo.influences, posed);
  const garment = deformWithCage(restBindings, inner);
  const classify = bodyUnion(posed.parts);
  const samples = samplePositions(garment, shirt.indices);
  let penetrations = 0, maxDepth = 0, minimumOutsideDistance = Infinity, ambiguousBodySamples = 0;
  let regionalPenetrations = 0, regionalMaxDepth = 0;
  const penetrationParts = {}, badSamples = [];
  for (const sample of samples) {
    const hit = classify(sample.p);
    const sampleIds = sample.vertex !== undefined ? [sample.vertex] : sample.ids;
    const ownerNames = new Set(sampleIds.flatMap(id => shirt.vertexGroups?.[id] ?? shirt.vertexParts?.[id] ?? ['UpperTorso', 'LowerTorso', 'LeftUpperArm', 'RightUpperArm']));
    const regionalHits = hit.containingParts.filter(part => ownerNames.has(part.name) && part.depth > .002);
    if (regionalHits.length) { regionalPenetrations++; regionalMaxDepth = Math.max(regionalMaxDepth, ...regionalHits.map(hit => hit.depth)); }
    if (hit.ambiguous) ambiguousBodySamples++;
    if (hit.inside && hit.deepestPartDepth > .002) {
      penetrations++; maxDepth = Math.max(maxDepth, hit.deepestPartDepth);
      penetrationParts[hit.deepestPart] = (penetrationParts[hit.deepestPart] ?? 0) + 1;
      if (badSamples.length < 12) badSamples.push({ ...sample, depth: hit.deepestPartDepth, part: hit.deepestPart });
    } else if (!hit.inside) minimumOutsideDistance = Math.min(minimumOutsideDistance, hit.nearestDistance);
  }
  const envelope = createSurface({ positions: outer, indices: cage.outer.indices });
  let outsideVertices = 0, maxOutsideDistance = 0, ambiguousEnvelopeVertices = 0, windingOutsideVertices = 0, parityWindingDisagreements = 0;
  let maximumWindingOutsideDistance = 0;
  let minimumAbsWinding = Infinity, maximumAbsWinding = 0;
  const windingMultiplicity = {}, firstWindingOutsideVertices = [];
  for (let i = 0; i < garment.length / 3; i++) {
    const p = point(garment, i), nearest = envelope.closest(p), distance = Math.sqrt(nearest.distance2);
    const votes = dirs.map(dir => envelope.ray(p, dir).length % 2);
    if (votes.some(v => v !== votes[0])) ambiguousEnvelopeVertices++;
    const outside = distance > .003 && votes.reduce((a, b) => a + b, 0) < 2;
    const winding = Math.abs(windingNumber(p, outer, cage.outer.indices));
    minimumAbsWinding = Math.min(minimumAbsWinding, winding); maximumAbsWinding = Math.max(maximumAbsWinding, winding);
    const multiplicity = Math.round(winding);
    windingMultiplicity[multiplicity] = (windingMultiplicity[multiplicity] ?? 0) + 1;
    const windingOutside = distance > .003 && winding < .5;
    if (outside !== windingOutside) parityWindingDisagreements++;
    if (windingOutside) {
      windingOutsideVertices++;
      maximumWindingOutsideDistance = Math.max(maximumWindingOutsideDistance, distance);
      if (firstWindingOutsideVertices.length < 12) firstWindingOutsideVertices.push({ vertex: i, position: p, nearestDistance: distance, winding });
    }
    if (outside) { outsideVertices++; maxOutsideDistance = Math.max(maxOutsideDistance, distance); }
  }
  const state = {
    width, pose, time,
    body: { sampleCount: samples.length, penetrationSamples: penetrations, penetrationPercent: 100 * penetrations / samples.length, maximumIndividualPartDepth: maxDepth, minimumOutsideDistance, ambiguousParitySamples: ambiguousBodySamples, penetrationParts, firstBadSamples: badSamples },
    intendedRegion: { sampleCount: samples.length, penetrationSamples: regionalPenetrations, penetrationPercent: 100 * regionalPenetrations / samples.length, maximumIndividualPartDepth: regionalMaxDepth, note: 'Secondary diagnostic against source vertex ownership only. The ALL-body union metric remains the actual collision result.' },
    outer: { garmentVertices: garment.length / 3, outsideVertices, outsidePercent: 100 * outsideVertices / (garment.length / 3), maximumOutsideDistance: maxOutsideDistance, ambiguousParityVertices: ambiguousEnvelopeVertices, windingOutsideVertices, windingOutsidePercent: 100 * windingOutsideVertices / (garment.length / 3), maximumWindingOutsideDistance, parityWindingDisagreements, minimumAbsWinding, maximumAbsWinding, windingMultiplicity, firstWindingOutsideVertices },
    garment: triangleQuality(demo.garmentPositions, garment, shirt.indices),
    inner: triangleQuality(demo.innerPositions, inner, cage.inner.indices),
    outerQuality: triangleQuality(demo.outerPositions, outer, cage.outer.indices),
  };
  states.push(state);
  console.log(JSON.stringify({ width, pose, time, penetrationSamples: penetrations, maximumDepth: maxDepth, outsideVertices, maximumOutsideDistance: maxOutsideDistance, garmentMinArea: state.garment.areaRatio.min, garmentMaxStretch: state.garment.edgeStretch.max }));
}

const report = {
  generatedAt: new Date().toISOString(),
  garmentAsset,
  factoryOptions: { targetSeed: targetSeed ? 'assets/blocky-cage-target.json' : null, targetSeedSha256: targetSeed ? sha256(path.join(root, 'assets/blocky-cage-target.json')) : null, bindingMode: 'shared default', projectionMode: 'shared default', outerInfluencePolicy: demo.outerInfluences ? 'garment-region weights from the shared fitting pipeline' : 'same body weights as inner cage' },
  engineHash, engineUnchangedDuringCheck: engineHash === sha256(engineFile),
  codeHashesAtStart,
  codeUnchangedDuringCheck: Object.entries(codeFiles).every(([name, file]) => codeHashesAtStart[name] === sha256(file)),
  assetsUnchangedDuringCheck: Object.entries(assetFiles).every(([name, file]) => assetHashesAtStart[name] === sha256(file)),
  runtimeHashesAtStart,
  runtimeUnchangedDuringCheck: runtimeFiles.every(file => runtimeHashesAtStart[path.relative(root, file).replaceAll('\\', '/')] === sha256(file)),
  notes: [
    'Body inside predicate is the union of separately closed R15 pieces, using a majority of three independent ray-parity directions. Counts use vertices plus centroid and three edge-midpoint samples per triangle.',
    'Penetration depth is the deepest containing individual part; it is not the exact nearest exit distance of the Boolean union. Sampling does not prove complete absence of all triangle crossings.',
    'Outer coverage is tested per garment vertex. Generalized winding from oriented triangle solid angles is the primary envelope predicate; three-ray parity is retained separately because overlapping cage regions can give even counts. Winding multiplicity is reported to expose those overlaps. These results do not certify Roblox Marketplace compliance.',
    'Maximum winding-outside distance is the exact closest-triangle distance for the sampled vertices classified outside. It does not bound unsampled points inside garment faces.',
    'Garment is independently rebound to the fitted inner cage once using the original source face correspondence and subsequently follows the posed cage; no garment vertex skinning or per-frame collision repair is applied.',
  ],
  sourceHashes: assetHashesAtStart,
  topology: {
    sourceInner: topology(cage.inner), sourceOuter: topology(cage.outer), sourceGarment: topology(shirt),
    matchingInnerOuterIndices: equal(cage.inner.indices, cage.outer.indices), matchingInnerOuterUV: equal(cage.inner.uv, cage.outer.uv), matchingInnerOuterUVIndices: equal(cage.inner.uvIndices, cage.outer.uvIndices),
    enginePreservesSourceIndices: equal(cage.inner.indices, demo.sourceCage.indices), enginePreservesSourceUV: equal(cage.inner.uv, demo.sourceCage.uv), enginePreservesSourceUVIndices: equal(cage.inner.uvIndices, demo.sourceCage.uvIndices),
    fittedVertexCountsPreserved: demo.innerPositions.length === cage.inner.positions.length && demo.outerPositions.length === cage.outer.positions.length,
    bodyParts: body.parts.map(part => ({ name: part.name, ...topology(part) })),
  },
  bindingIdentity: { maximumRestReproductionError, maximumAllowedError: 1e-5, passed: maximumRestReproductionError < 1e-5 },
  initialFitQuality: { garment: triangleQuality(demo.sourceGarment.positions, demo.garmentPositions, shirt.indices), cage: triangleQuality(cage.inner.positions, demo.innerPositions, cage.inner.indices) },
  states,
};
report.summary = {
  testedStates: states.length,
  nonfiniteStates: states.filter(s => s.garment.nonfiniteCoordinates || s.inner.nonfiniteCoordinates || s.outerQuality.nonfiniteCoordinates).length,
  bodyPenetrationStates: states.filter(s => s.body.penetrationSamples).length,
  envelopeCoverageFailureStates: states.filter(s => s.outer.windingOutsideVertices).length,
  parityCoverageFailureStates: states.filter(s => s.outer.outsideVertices).length,
  statesWithDegenerateGarmentTriangles: states.filter(s => s.garment.degenerateTriangles).length,
  worstPenetrationPercent: Math.max(...states.map(s => s.body.penetrationPercent)),
  worstIndividualPartDepth: Math.max(...states.map(s => s.body.maximumIndividualPartDepth)),
  worstOutsidePercent: Math.max(...states.map(s => s.outer.windingOutsidePercent)),
  worstParityOutsidePercent: Math.max(...states.map(s => s.outer.outsidePercent)),
  maximumWindingOutsideDistance: Math.max(...states.map(s => s.outer.maximumWindingOutsideDistance)),
};
const requestedOutput = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length);
if (requestedOutput && requestedOutput !== path.basename(requestedOutput)) throw new Error('Audit output must be a filename within evidence.');
fs.writeFileSync(path.join(root, 'evidence', requestedOutput ?? (quick ? 'independent-quick-check.json' : 'independent-fit-check.json')), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary, null, 2));
if (!report.codeUnchangedDuringCheck || !report.assetsUnchangedDuringCheck || report.summary.nonfiniteStates) process.exitCode = 1;
