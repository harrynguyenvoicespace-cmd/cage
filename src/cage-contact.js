import { createSurface, adjacency, deformWithCage, diagnoseMesh, deformationDiagnostics } from './cage-engine.js';

const xyz = (positions, vertex) => [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]];
const norm = (p) => Math.hypot(...p);
const dot = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i] * b[i]; return sum; };
const FACE_SAMPLES = [[1 / 3, 1 / 3, 1 / 3], [.5, .5, 0], [0, .5, .5], [.5, 0, .5]];
const compactDiagnosis = (d) => ({ penetrationSamples: d.penetrationSamples, sampleCount: d.sampleCount, maximumPenetration: d.maximumPenetration, minimumClearance: d.minimumClearance, invalidSamples: d.invalidSamples, passed: d.passed });

function contactSamples(bindings, indices, includeEdges) {
  const samples = [];
  function add(vertices, bary) {
    const map = new Map();
    vertices.forEach((vertex, i) => bindings.vertices[vertex].forEach(({ id, weight }) => map.set(id, (map.get(id) ?? 0) + weight * bary[i])));
    const records = [...map].filter(([, weight]) => Math.abs(weight) > 1e-12);
    const ids = Uint32Array.from(records.map(([id]) => id)), alpha = Float64Array.from(records.map(([, weight]) => weight));
    samples.push({ vertices, bary, ids, alpha, squaredNorm: dot(alpha, alpha) });
  }
  for (let i = 0; i < bindings.vertices.length; i++) add([i], [1]);
  for (let i = 0; i < indices.length; i += 3) {
    const vertices = [indices[i], indices[i + 1], indices[i + 2]];
    for (const bary of includeEdges ? FACE_SAMPLES : FACE_SAMPLES.slice(0, 1)) add(vertices, bary);
  }
  return samples;
}

function constraints(samples, garment, body, options) {
  const rows = []; let maximumProjection = 0, penetrationEnergy = 0;
  for (const sample of samples) {
    const p = [0, 0, 0];
    sample.vertices.forEach((vertex, i) => { for (let axis = 0; axis < 3; axis++) p[axis] += garment[vertex * 3 + axis] * sample.bary[i]; });
    const hit = body.distance(p, { robust: options.robust });
    if (!Number.isFinite(hit.signed)) continue;
    const depth = Math.max(0, -hit.signed - .002); penetrationEnergy += depth * depth;
    if (hit.signed >= options.clearance) continue;
    const projected = body.project(p, options.clearance);
    const delta = projected.map((v, axis) => v - p[axis]), distance = norm(delta);
    if (!distance || distance > options.maximumProjection || sample.squaredNorm < 1e-12) continue;
    rows.push({ ...sample, delta }); maximumProjection = Math.max(maximumProjection, distance);
  }
  return { rows, maximumProjection, penetrationEnergy };
}

/** Solve the common sparse normal equations in control space with PCG.
 * Each row is a cloth vertex/face sample's existing MLS cage coordinates.
 * Regularization anchors unchanged controls; the optional Laplacian smooths
 * only displacement, preserving the posed cage's existing anatomical shape.
 */
function controlStep(rows, controlCount, near, options) {
  const size = controlCount * 3, rhs = new Float64Array(size), diagonal = new Float64Array(controlCount);
  const meanSupport = rows.length / Math.max(controlCount, 1);
  const anchor = options.regularization * Math.max(meanSupport, .25);
  const smoothing = options.smoothing * Math.max(meanSupport, .25);
  diagonal.fill(anchor);
  for (const row of rows) {
    const inverse = 1 / row.squaredNorm;
    for (let j = 0; j < row.ids.length; j++) {
      const id = row.ids[j], alpha = row.alpha[j]; diagonal[id] += alpha * alpha * inverse;
      for (let axis = 0; axis < 3; axis++) rhs[id * 3 + axis] += alpha * row.delta[axis] * inverse;
    }
  }
  if (near) near.forEach((neighbors, i) => { diagonal[i] += smoothing * neighbors.length; });
  function multiply(vector) {
    const output = Float64Array.from(vector, v => v * anchor);
    if (near) for (let i = 0; i < controlCount; i++) for (const j of near[i]) for (let axis = 0; axis < 3; axis++) output[i * 3 + axis] += smoothing * (vector[i * 3 + axis] - vector[j * 3 + axis]);
    for (const row of rows) {
      const value = [0, 0, 0];
      for (let j = 0; j < row.ids.length; j++) for (let axis = 0; axis < 3; axis++) value[axis] += vector[row.ids[j] * 3 + axis] * row.alpha[j];
      for (let j = 0; j < row.ids.length; j++) for (let axis = 0; axis < 3; axis++) output[row.ids[j] * 3 + axis] += row.alpha[j] * value[axis] / row.squaredNorm;
    }
    return output;
  }
  const solution = new Float64Array(size), residual = Float64Array.from(rhs);
  let preconditioned = Float64Array.from(residual, (v, i) => v / Math.max(diagonal[Math.floor(i / 3)], 1e-12));
  let direction = Float64Array.from(preconditioned), rz = dot(residual, preconditioned);
  const initialResidual = Math.sqrt(dot(residual, residual)); let iterations = 0;
  for (; iterations < options.linearIterations && initialResidual > 1e-12; iterations++) {
    const product = multiply(direction), denominator = dot(direction, product);
    if (!(denominator > 1e-20)) break;
    const alpha = rz / denominator;
    for (let i = 0; i < size; i++) { solution[i] += alpha * direction[i]; residual[i] -= alpha * product[i]; }
    if (Math.sqrt(dot(residual, residual)) <= initialResidual * options.linearTolerance) { iterations++; break; }
    preconditioned = Float64Array.from(residual, (v, i) => v / Math.max(diagonal[Math.floor(i / 3)], 1e-12));
    const nextRz = dot(residual, preconditioned), beta = nextRz / Math.max(rz, 1e-30);
    for (let i = 0; i < size; i++) direction[i] = preconditioned[i] + beta * direction[i];
    rz = nextRz;
  }
  return { solution, linearIterations: iterations, relativeResidual: Math.sqrt(dot(residual, residual)) / Math.max(initialResidual, 1e-12) };
}

function displace(base, current, step, scale, options) {
  const output = Float32Array.from(current); let maximumStep = 0, maximumDisplacement = 0;
  for (let i = 0; i < current.length; i += 3) {
    const delta = [step[i] * scale, step[i + 1] * scale, step[i + 2] * scale], distance = norm(delta);
    const limit = distance > options.maximumControlStep ? options.maximumControlStep / distance : 1;
    const displacement = [0, 1, 2].map(axis => current[i + axis] + delta[axis] * limit - base[i + axis]);
    const length = norm(displacement), clamp = length > options.maximumControlDisplacement ? options.maximumControlDisplacement / length : 1;
    for (let axis = 0; axis < 3; axis++) output[i + axis] = base[i + axis] + displacement[axis] * clamp;
    maximumStep = Math.max(maximumStep, norm([output[i] - current[i], output[i + 1] - current[i + 1], output[i + 2] - current[i + 2]]));
    maximumDisplacement = Math.max(maximumDisplacement, norm([output[i] - base[i], output[i + 1] - base[i + 1], output[i + 2] - base[i + 2]]));
  }
  return { positions: output, maximumStep, maximumDisplacement };
}

/** Optional post-pose contact trial; this module is not enabled in the runtime.
 * Every cloth point is still deformWithCage(bindings, correctedInner). No cloth
 * coordinates, indices, UVs, or bone skinning are independently edited.
 */
export function solveCageContacts(bindings, posedInner, garmentIndices, posedBodyMesh, options = {}) {
  if (bindings.method !== 'weighted-affine-cage-coordinates') throw new Error('Cage contacts require linear affine MLS cage bindings.');
  if (posedInner.length / 3 !== bindings.sourceVertexCount) throw new Error('Posed cage control count does not match bindings.');
  const config = {
    iterations: 8, clearance: .008, relaxation: .85, maximumProjection: .35,
    maximumControlStep: .035, maximumControlDisplacement: .18,
    regularization: .08, smoothing: .035, linearIterations: 28, linearTolerance: 1e-4,
    includeEdges: true, robust: true, cageIndices: null,
    maximumP95Increase: 1.06, maximumStretchIncrease: 1.20,
    ...options,
  };
  const body = posedBodyMesh.closest ? posedBodyMesh : createSurface(posedBodyMesh);
  const base = Float32Array.from(posedInner), rawGarment = deformWithCage(bindings, base);
  const before = diagnoseMesh({ positions: rawGarment, indices: garmentIndices }, body, { robust: config.robust });
  const reference = bindings.sourcePositions ?? rawGarment;
  const strainBefore = deformationDiagnostics(reference, rawGarment, garmentIndices), history = [];
  const near = config.cageIndices ? adjacency(bindings.sourceVertexCount, config.cageIndices) : null;
  let current = base, best = base, garment = rawGarment, after = before, strainAfter = strainBefore;
  let bestScore = before.penetrationSamples + before.maximumPenetration * before.sampleCount * .5;
  let maximumDisplacement = 0;
  if (!before.passed) {
    const samples = contactSamples(bindings, garmentIndices, config.includeEdges);
    for (let iteration = 0; iteration < config.iterations; iteration++) {
      const rawContact = constraints(samples, deformWithCage(bindings, current), body, config);
      if (!rawContact.rows.length) break;
      const linear = controlStep(rawContact.rows, bindings.sourceVertexCount, near, config);
      let accepted = null;
      for (const lineScale of [config.relaxation, config.relaxation * .5]) {
        const candidate = displace(base, current, linear.solution, lineScale, config);
        const cloth = deformWithCage(bindings, candidate.positions);
        const diagnosis = diagnoseMesh({ positions: cloth, indices: garmentIndices }, body, { robust: config.robust });
        const strain = deformationDiagnostics(reference, cloth, garmentIndices);
        const strainAllowed = strain.p95Stretch <= Math.max(1, strainBefore.p95Stretch) * config.maximumP95Increase && strain.maximumStretch <= Math.max(1, strainBefore.maximumStretch) * config.maximumStretchIncrease;
        const score = diagnosis.penetrationSamples + diagnosis.maximumPenetration * diagnosis.sampleCount * .5;
        if (strainAllowed && diagnosis.invalidSamples === 0 && (!accepted || score < accepted.score)) accepted = { ...candidate, garment: cloth, diagnosis, strain, score, lineScale };
      }
      if (!accepted) { history.push({ iteration: iteration + 1, contactRows: rawContact.rows.length, accepted: false, reason: 'Strain guard rejected the control step.', ...linear, solution: undefined }); break; }
      current = accepted.positions;
      const improved = accepted.score < bestScore && accepted.diagnosis.penetrationSamples <= before.penetrationSamples;
      history.push({ iteration: iteration + 1, contactRows: rawContact.rows.length, accepted: true, selectedAsBest: improved, lineScale: accepted.lineScale, maximumProjection: rawContact.maximumProjection, maximumControlStep: accepted.maximumStep, maximumControlDisplacement: accepted.maximumDisplacement, linearIterations: linear.linearIterations, relativeResidual: linear.relativeResidual, collisions: compactDiagnosis(accepted.diagnosis), strain: accepted.strain });
      if (improved) { best = current; garment = accepted.garment; after = accepted.diagnosis; strainAfter = accepted.strain; bestScore = accepted.score; maximumDisplacement = accepted.maximumDisplacement; }
      if (accepted.diagnosis.passed) break;
    }
  }
  // Regenerate once more to make the returned cage-to-cloth dependency exact.
  garment = deformWithCage(bindings, best);
  return {
    inner: best, positions: best, garment, garmentPositions: garment,
    diagnostics: { before: compactDiagnosis(before), after: compactDiagnosis(after), strainBefore, strainAfter, maximumControlDisplacement: maximumDisplacement, improvedCollisions: after.penetrationSamples < before.penetrationSamples, topologyPreserved: best.length === posedInner.length, method: 'body-contact-constrained-affine-cage-controls' },
    history,
  };
}

export default solveCageContacts;
