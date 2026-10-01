import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createR15Garment, GARMENT_STYLES } from '../src/garment.js';
import { createR15GarmentFit, deformWithCage, rebindWithCorrespondence, createSurface, mergeBodyParts, diagnoseMesh } from '../src/cage-engine.js';
import { createR15Poser, posePoints } from '../src/r15-pose.js';

const load = name => JSON.parse(fs.readFileSync(new URL(`../assets/${name}.json`, import.meta.url), 'utf8'));
const catalog = load('garment-variants'), body = load('r15-body'), cage = load('roblox-cage');
const targetSeed = load('blocky-cage-target');
const bodySurface = createSurface(mergeBodyParts(body.parts));
const poser = createR15Poser(body);
const requiredNewStyles = ['longline-shirt', 'hoodie-classic', 'hoodie-oversized', 'hoodie-up', 'hoodie-zip'];
const newStyles = new Set(requiredNewStyles);
const partNames = new Set(body.parts.map(part => part.name));
const point = (positions, id) => positions.slice(id * 3, id * 3 + 3);
const subtract = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((total, value, i) => total + value * b[i], 0);
const finite = positions => positions.every(Number.isFinite);
const difference = (a, b) => a.reduce((maximum, value, i) => Math.max(maximum, Math.abs(value - b[i])), 0);

assert.deepEqual(catalog.variants.map(variant => variant.style).sort(), Object.keys(GARMENT_STYLES).sort(), 'Catalog must include every supported geometry recipe exactly once.');
for (const style of requiredNewStyles) assert.ok(GARMENT_STYLES[style], `Missing requested garment style: ${style}`);
assert.equal(catalog.algorithmParametersShared, true, 'Shape recipes must share the cage fitting algorithm.');

function checkClosedShell(mesh, label) {
  assert.ok(mesh.positions.length > 0 && mesh.positions.length % 3 === 0 && finite(mesh.positions), `${label}: finite XYZ positions required.`);
  assert.ok(mesh.indices.length > 0 && mesh.indices.length % 3 === 0, `${label}: indexed triangles required.`);
  const vertexCount = mesh.positions.length / 3, outside = mesh.stats.outsideVertexCount;
  assert.equal(outside * 2, vertexCount, `${label}: shell inner vertices must use the global outer-vertex offset.`);
  assert.equal(mesh.vertexGroups.length, vertexCount);
  assert.equal(mesh.vertexParts.length, vertexCount);
  assert.equal(mesh.uv.length, vertexCount * 2);
  for (let i = 0; i < outside; i++) {
    if (newStyles.has(label)) {
      assert.deepEqual(mesh.vertexGroups[i], mesh.vertexGroups[i + outside], `${label}: paired shell groups must match.`);
      assert.equal(mesh.vertexParts[i], mesh.vertexParts[i + outside], `${label}: paired shell ownership must match.`);
    }
    assert.ok(mesh.vertexGroups[i].length && mesh.vertexGroups[i].every(name => partNames.has(name)), `${label}: groups must name actual R15 body parts.`);
    const offset = Math.hypot(...subtract(point(mesh.positions, i), point(mesh.positions, i + outside)));
    assert.ok(offset > 1e-5 && offset < .1, `${label}: paired inner vertex must be a nearby inward shell point.`);
  }
  const edges = new Map(), parents = Array.from({ length: vertexCount }, (_, i) => i);
  const find = i => parents[i] === i ? i : (parents[i] = find(parents[i]));
  const join = (a, b) => { parents[find(b)] = find(a); };
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ids = mesh.indices.slice(i, i + 3);
    assert.ok(ids.every(id => Number.isInteger(id) && id >= 0 && id < vertexCount), `${label}: triangle index out of range.`);
    const points = ids.map(id => point(mesh.positions, id));
    assert.ok(Math.hypot(...cross(subtract(points[1], points[0]), subtract(points[2], points[0]))) > 1e-10, `${label}: source triangle must have positive area.`);
    for (let edge = 0; edge < 3; edge++) {
      const a = ids[edge], b = ids[(edge + 1) % 3], key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const record = edges.get(key) ?? { count: 0, orientation: 0 };
      record.count++; record.orientation += a < b ? 1 : -1;
      edges.set(key, record); join(a, b);
    }
  }
  assert.ok([...edges.values()].every(edge => edge.count === 2 && edge.orientation === 0), `${label}: each shell edge must have two oppositely oriented incident triangles.`);
  const volumes = new Map();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ids = mesh.indices.slice(i, i + 3), points = ids.map(id => point(mesh.positions, id)), component = find(ids[0]);
    volumes.set(component, (volumes.get(component) ?? 0) + dot(points[0], cross(points[1], points[2])) / 6);
  }
  assert.ok([...volumes.values()].every(volume => volume > 1e-6), `${label}: every sewn component must have positive enclosed volume.`);
  return { vertexCount, triangles: mesh.indices.length / 3, components: volumes.size };
}

const reports = [];
// The expensive independent audit owns the full width/pose/time matrix and
// enclosure metrics. These focused regressions check authored geometry and
// transport only, so npm test remains useful during ordinary development.
const transportStates = [{ width: 1.4, pose: 'stand', time: 0 }, { width: 1, pose: 'arms', time: 0 }, { width: 1.4, pose: 'walk', time: .4 }];
const options = { targetSeed };
for (const entry of catalog.variants) {
  assert.match(entry.filename, /^[a-z0-9-]+\.json$/);
  const file = new URL(`../assets/${entry.filename}`, import.meta.url);
  const contents = fs.readFileSync(file), mesh = JSON.parse(contents);
  assert.equal(crypto.createHash('sha256').update(contents).digest('hex'), entry.sha256, `${entry.style}: asset hash must match its catalog entry.`);
  assert.equal(mesh.source.kind, 'independent-parametric-garment');
  const topology = checkClosedShell(mesh, entry.style);
  const report = { style: entry.style, ...topology };
  if (newStyles.has(entry.style)) {
    const generated = createR15Garment(body, { style: entry.style });
    assert.deepEqual(generated, mesh, `${entry.style}: checked-in mesh must reproduce the body-authored geometry recipe.`);
    const clearance = diagnoseMesh(mesh, bodySurface, { robust: true });
    assert.equal(clearance.invalidSamples, 0);
    assert.equal(clearance.penetrationSamples, 0, `${entry.style}: authored vertices, edge and face samples must clear the entire source body union.`);
    report.sourceBodySamples = clearance.sampleCount;
    report.minimumSourceBodyClearance = clearance.minimumClearance;
    if (mesh.design.hood === 'up') {
      assert.ok(mesh.vertexGroups.some(group => group.length === 1 && group[0] === 'Head'), `${entry.style}: raised hood must attach to the head region.`);
      assert.ok(mesh.vertexGroups.some(group => group.includes('Head') && group.includes('UpperTorso')), `${entry.style}: raised hood neckline must blend head and torso regions.`);
    } else if (mesh.design.hood === 'down') {
      assert.ok(mesh.vertexGroups.every(group => !group.includes('Head')), `${entry.style}: lowered hood must follow the torso.`);
    }
    const fit = createR15GarmentFit(cage, mesh, body, options);
    assert.equal(fit.initialization, 'canonical-uv-target');
    assert.equal(fit.bindings.method, 'weighted-affine-cage-coordinates');
    assert.deepEqual([...fit.sourceCage.indices], cage.inner.indices);
    assert.deepEqual([...fit.sourceGarment.indices], mesh.indices);
    assert.equal(fit.innerPositions.length, cage.inner.positions.length);
    assert.equal(fit.outerPositions.length, cage.outer.positions.length);
    assert.ok(finite(fit.innerPositions) && finite(fit.outerPositions) && finite(fit.garmentPositions));
    assert.ok(difference(fit.garmentPositions, mesh.positions) < 1e-6, `${entry.style}: shared fit must preserve authored rest geometry.`);
    const bindings = rebindWithCorrespondence(fit.bindings, fit.innerPositions, fit.garmentPositions);
    assert.ok(difference(deformWithCage(bindings, fit.innerPositions), fit.garmentPositions) < 1e-6, `${entry.style}: cage rest identity must reproduce the garment.`);
    for (const settings of transportStates) {
      const state = poser.getState(settings), posedInner = posePoints(fit.innerPositions, fit.influences, state);
      const posedOuter = posePoints(fit.outerPositions, fit.outerInfluences, state);
      const garment = deformWithCage(bindings, posedInner);
      assert.equal(garment.length, mesh.positions.length);
      assert.ok(finite(posedInner) && finite(posedOuter) && finite(garment), `${entry.style}: ${settings.pose} width ${settings.width} transport must remain finite.`);
      assert.ok(difference(garment, fit.garmentPositions) > .05, `${entry.style}: changing actual cage/body width or pose must move the garment.`);
      if (settings.pose === 'stand') {
        const expected = mesh.positions.map((value, i) => i % 3 === 0 ? value * settings.width : value);
        assert.ok(difference(garment, expected) < 2e-5, `${entry.style}: affine cage transport must follow shared body width scaling.`);
      }
    }
    report.sharedTransportStates = transportStates.length;
  }
  reports.push(report);
}
console.log(`${catalog.variants.length} garment shell/catalog checks passed; ${newStyles.size} new variants reproduce their recipes, clear the source body and pass ${transportStates.length} shared cage transport states.`);
console.log(JSON.stringify(reports, null, 2));
