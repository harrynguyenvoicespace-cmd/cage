import { createSurface, deformWithCage, diagnoseMesh } from './cage-engine.js';
import { solveCageContacts } from './cage-contact.js';

/** Shared rest-fit policy; clothing openings and authored meshes stay intact. */
export const MANNEQUIN_CONTACT_POLICY = Object.freeze({
  gridSize: 33, xFraction: .85, yLow: .10, yHigh: .85,
  maximumProbeDepth: .15, maximumProbeClearance: .25,
  iterations: 16, clearance: .035, maximumControlStep: .04,
  maximumControlDisplacement: .18, maximumProjection: .35,
  regularization: .10, smoothing: .12, linearIterations: 32,
  maximumP95Increase: 1.15, maximumStretchIncrease: 1.3,
  minimumSignedShellRatio: .10, minimumTriangleAreaRatio: .05,
});
const xyz = (p, i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
const sub = (a, b) => a.map((value, axis) => value - b[axis]);
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const compact = d => ({ penetrationSamples: d.penetrationSamples, sampleCount: d.sampleCount, maximumPenetration: d.maximumPenetration, minimumClearance: d.minimumClearance, invalidSamples: d.invalidSamples, passed: d.passed });

/** Virtual probe coordinates interpolate actual existing garment triangles.
 * They augment solver rows only: the displayed clothing mesh gains no vertices.
 * A ray hitting a distant back panel across a neckline/front opening is skipped.
 */
function surfaceProbeBindings(bindings, rawGarment, garment, bodyAsset) {
  const torso = bodyAsset.parts.find(part => part.name === 'UpperTorso');
  if (!torso) return { bindings, added: 0 };
  const bounds = torso.bounds, body = createSurface(torso);
  const cloth = createSurface({ positions: rawGarment, indices: garment.indices });
  const vertices = [...bindings.vertices], sourcePositions = [...bindings.sourcePositions];
  const policy = MANNEQUIN_CONTACT_POLICY;
  let added = 0;
  for (let y = 0; y < policy.gridSize; y++) for (let x = 0; x < policy.gridSize; x++) {
    const p = [bounds.center[0] + (x / (policy.gridSize - 1) * 2 - 1) * bounds.size[0] * .5 * policy.xFraction,
      bounds.min[1] + bounds.size[1] * (policy.yLow + (policy.yHigh - policy.yLow) * y / (policy.gridSize - 1)), bounds.min[2] - 1];
    const bodyHit = body.ray(p, [0, 0, 1])[0], clothHit = cloth.ray(p, [0, 0, 1])[0];
    if (!bodyHit || !clothHit || clothHit.distance - bodyHit.distance > policy.maximumProbeDepth
      || bodyHit.distance - clothHit.distance > policy.maximumProbeClearance) continue;
    const coefficients = new Map(), source = [0, 0, 0];
    for (let corner = 0; corner < 3; corner++) {
      const vertex = clothHit.triangle.ids[corner], weight = clothHit.bary[corner];
      for (const record of bindings.vertices[vertex]) coefficients.set(record.id, (coefficients.get(record.id) || 0) + record.weight * weight);
      for (let axis = 0; axis < 3; axis++) source[axis] += bindings.sourcePositions[vertex * 3 + axis] * weight;
    }
    vertices.push([...coefficients].map(([id, weight]) => ({ id, weight })));
    sourcePositions.push(...source); added++;
  }
  return { bindings: { ...bindings, vertices, sourcePositions: Float32Array.from(sourcePositions) }, added };
}

/** Guard paired fabric layers and triangle areas against the raw transfer. */
export function mannequinContactQuality(raw, current, garment) {
  let minimumSignedShellRatio = Infinity, reversedShellPairs = 0;
  const paired = garment.stats?.outsideVertexCount;
  if (paired && paired * 2 === raw.length / 3) for (let vertex = 0; vertex < paired; vertex++) {
    const before = sub(xyz(raw, vertex + paired), xyz(raw, vertex));
    const after = sub(xyz(current, vertex + paired), xyz(current, vertex));
    const denominator = dot(before, before);
    if (denominator < 1e-12) continue;
    const ratio = dot(before, after) / denominator;
    minimumSignedShellRatio = Math.min(minimumSignedShellRatio, ratio);
    if (ratio <= 0) reversedShellPairs++;
  }
  let minimumTriangleAreaRatio = Infinity, collapsedTriangles = 0, reorientedTriangles = 0;
  let area = 0, reorientedArea = 0;
  const componentAreas = new Map(), components = garment.design?.components || [];
  for (let triangle = 0; triangle < garment.indices.length; triangle += 3) {
    const ids = garment.indices.slice(triangle, triangle + 3);
    const normal = positions => cross(sub(xyz(positions, ids[1]), xyz(positions, ids[0])), sub(xyz(positions, ids[2]), xyz(positions, ids[0])));
    const before = normal(raw), after = normal(current), oldArea = Math.hypot(...before), newArea = Math.hypot(...after);
    if (oldArea < 1e-8) continue;
    const ratio = newArea / oldArea;
    minimumTriangleAreaRatio = Math.min(minimumTriangleAreaRatio, ratio);
    if (ratio < MANNEQUIN_CONTACT_POLICY.minimumTriangleAreaRatio) collapsedTriangles++;
    area += oldArea;
    if (dot(before, after) < 0) { reorientedTriangles++; reorientedArea += oldArea; }
    const vertex = paired ? ids[0] % paired : ids[0];
    const component = components.find(item => vertex >= item.outsideVertexStart && vertex < item.outsideVertexStart + item.outsideVertexCount)?.name || 'garment';
    const totals = componentAreas.get(component) || { before: 0, after: 0 };
    totals.before += oldArea; totals.after += newArea; componentAreas.set(component, totals);
  }
  const componentAreaRatios = Object.fromEntries([...componentAreas].map(([name, values]) => [name, values.after / values.before]));
  const passed = reversedShellPairs === 0 && minimumSignedShellRatio >= MANNEQUIN_CONTACT_POLICY.minimumSignedShellRatio
    && collapsedTriangles === 0 && Object.values(componentAreaRatios).every(ratio => ratio >= .5);
  return { passed, minimumSignedShellRatio, reversedShellPairs, minimumTriangleAreaRatio, collapsedTriangles,
    reorientedTriangles, reorientedAreaFraction: reorientedArea / Math.max(area, 1e-12), componentAreaRatios };
}

export function fitMannequinRestContacts(bindings, rawInner, garment, bodyAsset, bodySurface, cageIndices) {
  const rawGarment = deformWithCage(bindings, rawInner);
  const probes = surfaceProbeBindings(bindings, rawGarment, garment, bodyAsset);
  const begin = performance.now();
  const solve = solveCageContacts(probes.bindings, rawInner, garment.indices, bodySurface, {
    ...MANNEQUIN_CONTACT_POLICY, cageIndices,
  });
  const correctedGarment = deformWithCage(bindings, solve.inner);
  const quality = mannequinContactQuality(rawGarment, correctedGarment, garment);
  const accepted = quality.passed && solve.inner.every(Number.isFinite);
  const applied = accepted && solve.diagnostics.maximumControlDisplacement > 1e-7;
  const inner = accepted ? solve.inner : Float32Array.from(rawInner);
  const positions = accepted ? correctedGarment : rawGarment;
  return { inner, garment: positions, report: {
    method: 'rest-body-contact-constrained-shared-affine-cage-controls',
    targetDependent: true, stage: 'rest-before-demo-pose', accepted, applied,
    rejectionReason: accepted ? null : 'Fabric shell or triangle area guard rejected the cage correction.',
    policy: MANNEQUIN_CONTACT_POLICY, virtualSurfaceProbes: probes.added,
    addedGarmentVertices: 0, sourceBindingsChanged: false,
    elapsedMilliseconds: performance.now() - begin,
    before: compact(diagnoseMesh({ positions: rawGarment, indices: garment.indices }, bodySurface, { robust: true })),
    after: compact(diagnoseMesh({ positions, indices: garment.indices }, bodySurface, { robust: true })),
    quality, solver: solve.diagnostics, history: solve.history,
  } };
}
