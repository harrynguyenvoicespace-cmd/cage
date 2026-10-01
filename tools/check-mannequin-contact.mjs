import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createR15GarmentFit, createSurface, deformWithCage, meshBounds } from '../src/cage-engine.js';
import { createMannequinGarmentFit } from '../src/mannequin-fit.js';
import { createStableMannequinBindings } from '../src/mannequin-binding.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const file = name => path.join(root, name.startsWith('assets/') ? name : `assets/${name}`);
const load = name => JSON.parse(fs.readFileSync(file(name), 'utf8'));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hashFile = name => sha(fs.readFileSync(name));
const finite = values => Array.from(values).every(Number.isFinite);
const xyz = (positions, vertex) => Array.from(positions.slice(vertex * 3, vertex * 3 + 3));
const minus = (a, b) => a.map((value, index) => value - b[index]);
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => Math.hypot(...a);
const difference = (a, b) => {
  assert.equal(a.length, b.length);
  return a.reduce((maximum, value, index) => Math.max(maximum, Math.abs(value - b[index])), 0);
};
const directions = [[1, .3719, .1273], [.2171, 1, .4133], [.3197, .1739, 1]];
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);

function topology(indices, vertexCount) {
  const edges = new Map(), parents = Array.from({ length: vertexCount }, (_, index) => index);
  const find = index => parents[index] === index ? index : (parents[index] = find(parents[index]));
  for (let index = 0; index < indices.length; index += 3) {
    const ids = Array.from(indices.slice(index, index + 3));
    for (let edge = 0; edge < 3; edge++) {
      const a = ids[edge], b = ids[(edge + 1) % 3], key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const record = edges.get(key) || { count: 0, orientation: 0 };
      record.count++; record.orientation += a < b ? 1 : -1; edges.set(key, record);
      parents[find(b)] = find(a);
    }
  }
  return { edges, componentOf: Array.from({ length: vertexCount }, (_, index) => find(index)), boundaryEdges: [...edges.values()].filter(edge => edge.count === 1).length, nonmanifoldEdges: [...edges.values()].filter(edge => edge.count > 2).length, inconsistentEdges: [...edges.values()].filter(edge => edge.count !== 2 || edge.orientation !== 0).length };
}

function windingNumber(p, positions, indices) {
  let angle = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index] * 3, b = indices[index + 1] * 3, c = indices[index + 2] * 3;
    const ax = positions[a] - p[0], ay = positions[a + 1] - p[1], az = positions[a + 2] - p[2];
    const bx = positions[b] - p[0], by = positions[b + 1] - p[1], bz = positions[b + 2] - p[2];
    const cx = positions[c] - p[0], cy = positions[c + 1] - p[1], cz = positions[c + 2] - p[2];
    const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz), lc = Math.hypot(cx, cy, cz);
    angle += 2 * Math.atan2(ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx),
      la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (bx * cx + by * cy + bz * cz) * la + (cx * ax + cy * ay + cz * az) * lb);
  }
  return angle / (4 * Math.PI);
}

/** Independent union classification: open facial holes cannot make points
 * outside a part's bounds become body penetrations through odd ray parity. */
export function bodyContactSamples(mesh, positions, bodyAsset) {
  assert.equal(positions.length, mesh.positions.length);
  assert.ok(finite(positions));
  const parts = bodyAsset.parts.map(part => {
    const meshTopology = topology(part.indices, part.positions.length / 3);
    return { ...part, surface: createSurface(part), bounds: meshBounds(part.positions), closed: meshTopology.boundaryEdges === 0 && meshTopology.nonmanifoldEdges === 0 };
  });
  const report = { sampleCount: 0, penetrationSamples: 0, closedBodyPenetrationSamples: 0, openPartPenetrationSamples: 0, maximumDepth: 0, byBodyPart: {}, outerShellPenetrationSamples: 0, upperTorsoPenetrationSamples: 0, ambiguousOpenPartSamples: 0, firstPenetrations: [], classifier: 'per-part AABB; three-ray majority for closed parts; generalized winding for open parts', openBodyParts: parts.filter(part => !part.closed).map(part => part.name) };
  const sample = (p, ids, kind, triangle = null) => {
    report.sampleCount++;
    let deepest = null;
    for (const part of parts) {
      if (p.some((value, axis) => value < part.bounds.min[axis] || value > part.bounds.max[axis])) continue;
      const nearest = part.surface.closest(p), depth = Math.sqrt(nearest.distance2);
      if (depth <= .002) continue;
      let inside;
      if (part.closed) inside = directions.reduce((votes, direction) => votes + Number(part.surface.ray(p, direction).length % 2 === 1), 0) >= 2;
      else {
        const winding = Math.abs(windingNumber(p, part.positions, part.indices));
        if (winding > .45 && winding < .55) report.ambiguousOpenPartSamples++;
        inside = winding > .55;
      }
      if (inside && (!deepest || depth > deepest.depth)) deepest = { bodyPart: part.name, depth, closed: part.closed };
    }
    if (!deepest) return;
    report.penetrationSamples++; report.maximumDepth = Math.max(report.maximumDepth, deepest.depth);
    if (deepest.closed) report.closedBodyPenetrationSamples++; else report.openPartPenetrationSamples++;
    report.byBodyPart[deepest.bodyPart] = (report.byBodyPart[deepest.bodyPart] || 0) + 1;
    if (deepest.bodyPart === 'UpperTorso') report.upperTorsoPenetrationSamples++;
    if (ids.every(vertex => vertex < mesh.stats.outsideVertexCount)) report.outerShellPenetrationSamples++;
    if (report.firstPenetrations.length < 12) report.firstPenetrations.push({ ...deepest, point: p, kind, triangle, vertices: ids });
  };
  for (let vertex = 0; vertex < positions.length / 3; vertex++) sample(xyz(positions, vertex), [vertex], 'vertex');
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const ids = mesh.indices.slice(index, index + 3), points = ids.map(vertex => xyz(positions, vertex));
    for (const [kind, bary] of [['center', [1 / 3, 1 / 3, 1 / 3]], ['edge01', [.5, .5, 0]], ['edge12', [0, .5, .5]], ['edge20', [.5, 0, .5]]]) {
      const p = [0, 1, 2].map(axis => points.reduce((sum, point, vertex) => sum + point[axis] * bary[vertex], 0));
      sample(p, ids.filter((_, vertex) => bary[vertex] > 0), kind, index / 3);
    }
  }
  assert.equal(report.sampleCount, positions.length / 3 + mesh.indices.length / 3 * 4, 'Every triangle center and edge midpoint must be tested.');
  return report;
}

/** Off-grid visibility probes catch curved chest intersections between the
 * cloth's vertices, triangle centers and edge midpoints. The top neckline and
 * intended face opening are excluded from the central chest region. */
export function frontChestCoverage(mesh, positions, bodyAsset, { nx = 29, ny = 23, xFraction = .65, yLow = .25, yHigh = .8 } = {}) {
  const torso = bodyAsset.parts.find(part => part.name === 'UpperTorso');
  const head = bodyAsset.parts.find(part => part.name === 'Head');
  const b = meshBounds(torso.positions), body = createSurface(torso), garment = createSurface({ positions, indices: mesh.indices });
  // A hoodie deliberately leaves the neck opening below the head. This uniform
  // anatomical limit follows actual head height instead of treating a squat
  // avatar's neckline as uncovered chest just because it is below 80% of torso.
  const neckOpeningAllowance = .1;
  const actualYHigh = Math.min(yHigh, (meshBounds(head.positions).min[1] - neckOpeningAllowance - b.min[1]) / b.size[1]);
  assert.ok(actualYHigh > yLow);
  const report = { samples: 0, exposedSamples: 0, missingClothSamples: 0, maximumBodyBeforeCloth: 0, minimumClearance: Infinity, grid: { nx, ny, xFraction, yLow, yHigh, actualYHigh, neckOpeningAllowance }, firstExposed: [] };
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const x = b.center[0] + (ix / (nx - 1) * 2 - 1) * b.size[0] / 2 * xFraction;
    const y = b.min[1] + b.size[1] * (yLow + (actualYHigh - yLow) * iy / (ny - 1));
    const origin = [x, y, b.min[2] - 1], direction = [0, 0, 1];
    const bodyHit = body.ray(origin, direction)[0]; if (!bodyHit) continue;
    const garmentHit = garment.ray(origin, direction)[0]; report.samples++;
    const clearance = garmentHit ? bodyHit.distance - garmentHit.distance : -Infinity;
    if (!garmentHit) report.missingClothSamples++;
    if (Number.isFinite(clearance)) { report.minimumClearance = Math.min(report.minimumClearance, clearance); report.maximumBodyBeforeCloth = Math.max(report.maximumBodyBeforeCloth, -clearance); }
    if (clearance < -.002) {
      report.exposedSamples++;
      if (report.firstExposed.length < 12) report.firstExposed.push({ x, y, bodyPoint: bodyHit.point, garmentPoint: garmentHit?.point || null, clearance: Number.isFinite(clearance) ? clearance : null });
    }
  }
  assert.ok(report.samples > 0);
  return report;
}

export function shellGeometry(mesh, positions, rawPositions = positions) {
  const structure = topology(mesh.indices, positions.length / 3), volumes = new Map();
  let degenerateTriangles = 0, relativeCollapsedTriangles = 0;
  let maximumStretch = 0, maximumEdgeGrowth = 0, grossSpikeEdges = 0;
  const seen = new Set();
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const ids = mesh.indices.slice(index, index + 3), source = ids.map(vertex => xyz(mesh.positions, vertex)), current = ids.map(vertex => xyz(positions, vertex));
    const beforeArea = norm(cross(minus(source[1], source[0]), minus(source[2], source[0])));
    const afterArea = norm(cross(minus(current[1], current[0]), minus(current[2], current[0])));
    if (afterArea < 1e-8) degenerateTriangles++;
    if (beforeArea > 1e-8 && afterArea / beforeArea < .01) relativeCollapsedTriangles++;
    const component = structure.componentOf[ids[0]];
    volumes.set(component, (volumes.get(component) || 0) + dot(current[0], cross(current[1], current[2])) / 6);
    for (let edge = 0; edge < 3; edge++) {
      const a = ids[edge], b = ids[(edge + 1) % 3], key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      if (seen.has(key)) continue; seen.add(key);
      const before = norm(minus(xyz(mesh.positions, a), xyz(mesh.positions, b))), after = norm(minus(xyz(positions, a), xyz(positions, b)));
      const stretch = after / Math.max(before, 1e-8), growth = after - before;
      maximumStretch = Math.max(maximumStretch, stretch); maximumEdgeGrowth = Math.max(maximumEdgeGrowth, growth);
      if (stretch > 8 && growth > .5) grossSpikeEdges++;
    }
  }
  const paired = mesh.stats.outsideVertexCount;
  let shellDirectionFlips = 0, minimumShellThickness = Infinity, minimumRelativeShellThickness = Infinity;
  for (let vertex = 0; vertex < paired; vertex++) {
    const raw = minus(xyz(rawPositions, vertex), xyz(rawPositions, vertex + paired));
    const current = minus(xyz(positions, vertex), xyz(positions, vertex + paired));
    const beforeLength = norm(raw), afterLength = norm(current);
    minimumShellThickness = Math.min(minimumShellThickness, afterLength);
    if (beforeLength > 1e-6) {
      minimumRelativeShellThickness = Math.min(minimumRelativeShellThickness, afterLength / beforeLength);
      if (dot(raw, current) <= 0) shellDirectionFlips++;
    }
  }
  const componentVolumes = mesh.design.components.map(component => ({ name: component.name, volume: volumes.get(structure.componentOf[component.outsideVertexStart]) }));
  return { boundaryEdges: structure.boundaryEdges, nonmanifoldEdges: structure.nonmanifoldEdges, inconsistentEdges: structure.inconsistentEdges, componentVolumes, degenerateTriangles, relativeCollapsedTriangles, maximumStretch, maximumEdgeGrowth, grossSpikeEdges, shellDirectionFlips, minimumShellThickness, minimumRelativeShellThickness };
}

export function assessContactGeometry(mesh, positions, bodyAsset, rawPositions = positions) {
  return { body: bodyContactSamples(mesh, positions, bodyAsset), chest: frontChestCoverage(mesh, positions, bodyAsset), shell: shellGeometry(mesh, positions, rawPositions) };
}

async function checkTarget(entry, runId) {
  const cage = load('roblox-cage.json'), sourceBody = load('r15-body.json'), sourceSeed = load('blocky-cage-target.json');
  const body = load(entry.bodyFile), targetSeed = load(entry.targetSeedFile), bodyJson = JSON.stringify(body);
  const variants = load('garment-variants.json').variants.filter(variant => variant.family === 'Hoodie');
  const reports = [];
  for (const variant of variants) {
    const mesh = load(variant.filename), meshJson = JSON.stringify(mesh), sourceFit = createR15GarmentFit(cage, mesh, sourceBody, { targetSeed: sourceSeed });
    const source = createStableMannequinBindings(sourceFit, mesh, sourceBody), coefficientsSha256 = sha(JSON.stringify(source.bindings.vertices));
    const rawInner = Float32Array.from(targetSeed.positions), rawGarment = deformWithCage(source.bindings, rawInner);
    const fit = createMannequinGarmentFit(cage, mesh, sourceBody, body, { sourceSeed, targetSeed, sourceFit, sourceId: 'r15', targetId: entry.id, fitContacts: true });
    assert.equal(fit.bindings, source.bindings);
    assert.equal(sha(JSON.stringify(fit.bindings.vertices)), coefficientsSha256);
    assert.equal(fit.transfer.regeneratedGarment, false);
    assert.ok(fit.restContact, 'The requested contact stage must be explicit in exported provenance.');
    assert.equal(fit.transfer.restContact, fit.restContact);
    assert.equal(fit.transfer.collisionRepairApplied, fit.restContact.applied);
    assert.ok(difference(fit.rawInnerPositions, rawInner) < 1e-6);
    assert.ok(difference(fit.authoredInnerPositions, rawInner) < 1e-6);
    assert.ok(difference(fit.rawGarmentPositions, rawGarment) < 1e-6);
    if (fit.restContact.applied) assert.ok(difference(fit.innerPositions, rawInner) > 1e-6);
    assert.deepEqual(Array.from(fit.sourceGarment.indices), mesh.indices);
    assert.equal(fit.sourceGarment.uv, mesh.uv);
    assert.equal(fit.transferredGarment.indices, mesh.indices);
    assert.equal(fit.transferredGarment.uv, mesh.uv);
    assert.equal(fit.transferredGarment.vertexGroups, mesh.vertexGroups);
    assert.equal(fit.innerPositions.length, cage.inner.positions.length);
    assert.equal(fit.outerPositions.length, cage.outer.positions.length);
    assert.ok(finite(fit.innerPositions) && finite(fit.outerPositions) && finite(fit.garmentPositions));
    assert.ok(difference(deformWithCage(fit.bindings, fit.innerPositions), fit.garmentPositions) < 1e-6, 'Displayed clothing must be exactly the original source bindings deformed by the corrected inner cage.');
    assert.equal(JSON.stringify(mesh), meshJson, 'Contact correction must preserve original authored mesh data.');
    assert.equal(JSON.stringify(body), bodyJson, 'The source body must remain visible at its original geometry.');
    assert.equal(hashFile(file(variant.filename)), variant.sha256);
    const before = assessContactGeometry(mesh, rawGarment, body);
    const after = assessContactGeometry(mesh, fit.garmentPositions, body, rawGarment);
    assert.equal(sha(JSON.stringify(fit.bindings.vertices)), coefficientsSha256, 'Contact solving must not change the shared source binding coefficients.');
    const failures = [];
    if (after.shell.boundaryEdges || after.shell.nonmanifoldEdges || after.shell.inconsistentEdges) failures.push('Contact correction changed the closed oriented shell topology.');
    if (after.shell.componentVolumes.some(component => !(component.volume > 0))) failures.push('A garment component has nonpositive enclosed volume.');
    if (after.shell.degenerateTriangles) failures.push('Contact correction produced degenerate triangles.');
    if (after.shell.grossSpikeEdges) failures.push('Contact correction produced gross edge explosions.');
    if (after.shell.shellDirectionFlips) failures.push('Contact correction flipped outer/inner shell pair directions relative to raw transfer.');
    if (variant.id === 'hoodie-up') {
      if (after.body.closedBodyPenetrationSamples) failures.push('Raised hoodie still intersects actual closed body parts in rest.');
      if (after.chest.exposedSamples || after.chest.missingClothSamples) failures.push('Raised hoodie still exposes central chest skin in rest.');
    }
    reports.push({ garmentId: variant.id, sourceSha256: variant.sha256, coefficientsSha256, before, after, contactProvenance: fit.transfer, failures });
  }
  return { runId, id: entry.id, garments: reports };
}

function spawnTarget(entry, runId) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), `--worker=${entry.id}`, `--run-id=${runId}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ id: entry.id, exitCode: null, error: error.message }));
    child.on('close', exitCode => {
      try { resolve({ id: entry.id, exitCode, report: exitCode === 0 ? JSON.parse(stdout) : null, stderr: stderr.slice(-5000) }); }
      catch (error) { resolve({ id: entry.id, exitCode, error: error.message, stderr: stderr.slice(-5000) }); }
    });
  });
}

async function main() {
  const catalog = load('mannequins/catalog.json'), runId = option('run-id') || crypto.randomUUID(), worker = option('worker');
  if (worker) {
    const entry = catalog.entries.find(entry => entry.id === worker); assert.ok(entry);
    console.log(JSON.stringify(await checkTarget(entry, runId))); return;
  }
  const startedAt = new Date().toISOString(), variants = load('garment-variants.json').variants;
  const protectedFiles = ['assets/roblox-cage.json', 'assets/r15-body.json', 'assets/blocky-cage-target.json', 'assets/garment-variants.json', ...variants.map(variant => `assets/${variant.filename}`), 'assets/mannequins/catalog.json', ...catalog.entries.flatMap(entry => [entry.bodyFile, entry.targetSeedFile, entry.cagesFile, ...entry.sourceFiles.map(source => source.file)])];
  const runtimeFiles = ['src/cage-engine.js', 'src/cage-mls.js', 'src/cage-contact.js', 'src/mannequin-binding.js', 'src/mannequin-contact.js', 'src/mannequin-fit.js', 'tools/check-mannequin-contact.mjs'];
  const inputHashes = Object.fromEntries([...protectedFiles, ...runtimeFiles].map(name => [name, hashFile(path.join(root, name))]));
  const results = await Promise.all(catalog.entries.map(entry => spawnTarget(entry, runId)));
  const reports = results.filter(result => result.report).map(result => result.report), garments = reports.flatMap(report => report.garments.map(garment => ({ ...garment, targetId: report.id })));
  const failures = [...results.filter(result => result.exitCode !== 0 || !result.report), ...garments.filter(garment => garment.failures.length).map(garment => ({ targetId: garment.targetId, garmentId: garment.garmentId, failures: garment.failures }))];
  const hashesPreserved = Object.entries(inputHashes).every(([name, hash]) => hashFile(path.join(root, name)) === hash);
  const sameSourceCoefficientsAcrossTargets = variants.filter(variant => variant.family === 'Hoodie').every(variant => {
    const hashes = reports.map(report => report.garments.find(garment => garment.garmentId === variant.id)?.coefficientsSha256);
    return hashes.length === 3 && hashes.every(hash => hash && hash === hashes[0]);
  });
  const passed = hashesPreserved && sameSourceCoefficientsAcrossTargets && !failures.length && garments.length === 12 && reports.every(report => report.runId === runId);
  const raised = garments.filter(garment => garment.garmentId === 'hoodie-up');
  const report = { schemaVersion: 1, runId, startedAt, completedAt: new Date().toISOString(), validation: { passed, hashesPreserved, sameSourceCoefficientsAcrossTargets, failures }, summary: { restFits: garments.length, raisedHoodieMandatoryCases: raised.length, rawRaisedChestExposedSamples: raised.reduce((sum, garment) => sum + garment.before.chest.exposedSamples, 0), correctedRaisedChestExposedSamples: raised.reduce((sum, garment) => sum + garment.after.chest.exposedSamples, 0), rawRaisedBodyPenetrationSamples: raised.reduce((sum, garment) => sum + garment.before.body.penetrationSamples, 0), correctedRaisedBodyPenetrationSamples: raised.reduce((sum, garment) => sum + garment.after.body.penetrationSamples, 0), correctedRaisedClosedBodyPenetrationSamples: raised.reduce((sum, garment) => sum + garment.after.body.closedBodyPenetrationSamples, 0), correctedRaisedOpenHeadWarnings: raised.reduce((sum, garment) => sum + garment.after.body.openPartPenetrationSamples, 0) }, inputSha256: inputHashes, mannequins: reports, limitations: ['All garment vertices, every triangle center and all three edge midpoints are sampled against the body union. These samples do not prove complete continuous surface separation.', 'Independent front visibility uses a 29 by 23 chest grid, separate from solver constraints, covering 25–80% of torso height and 65% of torso width. Its upper bound is additionally capped 0.10 stud below the actual head so the intended neckline and face opening stay excluded for every body.', 'Closed body parts use three-ray majority parity with an AABB rejection. Open facial geometry uses absolute generalized winding above 0.55; ambiguous 0.45–0.55 cases and open-head contact warnings are reported separately.', 'Raised hoodie rest cases must clear all closed body parts and the chest grid. Open-head warnings, other hoodie contact counts and relative triangle collapse remain measured quality limitations; these checks do not certify every moving pose.'] };
  fs.mkdirSync(path.join(root, 'evidence'), { recursive: true }); fs.writeFileSync(path.join(root, 'evidence/mannequin-contact-check.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ validation: report.validation, summary: report.summary }, null, 2)); if (!passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
