/** Fixed-direction, regularized collision repair. This module does not alter
 * triangle indices, UVs, or topology and does not implement Roblox WrapLayer. */
const point = (a, i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
const write = (a, i, p) => { for (let k = 0; k < 3; k++) a[i * 3 + k] = p[k]; };
const add = (a, b) => a.map((v, k) => v + b[k]);
const sub = (a, b) => a.map((v, k) => v - b[k]);
const mul = (a, s) => a.map(v => v * s);
const dot = (a, b) => a.reduce((s, v, k) => s + v * b[k], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(...a);
const unit = a => { const n = length(a); return n > 1e-10 ? mul(a, 1 / n) : [0, 0, 0]; };
const samples = [[1 / 3, 1 / 3, 1 / 3], [.5, .5, 0], [0, .5, .5], [.5, 0, .5]];

function neighborsAndNormals(mesh, positions) {
  const near = Array.from({ length: positions.length / 3 }, () => new Set()), normals = new Float32Array(positions.length);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ids = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    const vertices = ids.map(id => point(positions, id)), n = cross(sub(vertices[1], vertices[0]), sub(vertices[2], vertices[0]));
    for (const id of ids) for (let k = 0; k < 3; k++) normals[id * 3 + k] += n[k];
    for (let j = 0; j < 3; j++) near[ids[j]].add(ids[(j + 1) % 3]).add(ids[(j + 2) % 3]);
  }
  for (let i = 0; i < normals.length / 3; i++) write(normals, i, unit(point(normals, i)));
  return { near: near.map(set => [...set]), normals };
}

function shapeQuality(rest, positions, indices) {
  let maxStretch = 0, minStretch = Infinity, collapsedFaces = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const ids = [indices[i], indices[i + 1], indices[i + 2]];
    const old = ids.map(id => point(rest, id)), p = ids.map(id => point(positions, id));
    const oldArea = length(cross(sub(old[1], old[0]), sub(old[2], old[0]))), area = length(cross(sub(p[1], p[0]), sub(p[2], p[0])));
    if (oldArea > 1e-8 && area / oldArea < .01) collapsedFaces++;
    for (let j = 0; j < 3; j++) {
      const before = length(sub(old[j], old[(j + 1) % 3]));
      if (before < 1e-8) continue;
      const ratio = length(sub(p[j], p[(j + 1) % 3])) / before;
      maxStretch = Math.max(maxStretch, ratio); minStretch = Math.min(minStretch, ratio);
    }
  }
  return { maxStretch, minStretch, collapsedFaces, finite: positions.every(Number.isFinite) };
}

/** Ray along one immutable direction until it clears the union, then binary
 * search the first crossing. This intentionally does not choose whichever body
 * part normal happens to be closest at the current iteration. */
function exitAlong(point, direction, body, clearance, maxDistance) {
  if (body.distance(point, { robust: true }).signed >= clearance) return { point, movement: 0, unresolved: false };
  let low = 0, high = Math.max(clearance, .015), found = false;
  while (high <= maxDistance + 1e-9) {
    const q = add(point, mul(direction, high));
    if (body.distance(q, { robust: true }).signed >= clearance) { found = true; break; }
    low = high; high = Math.min(maxDistance, high * 1.45 + .006);
    if (high <= low + 1e-8) break;
  }
  if (!found) return { point, movement: 0, unresolved: true };
  for (let i = 0; i < 10; i++) {
    const middle = (low + high) / 2;
    if (body.distance(add(point, mul(direction, middle)), { robust: true }).signed >= clearance) high = middle;
    else low = middle;
  }
  return { point: add(point, mul(direction, high)), movement: high, unresolved: false };
}

/** sourcePositions are optional undeformed anchors. preferredNormals should be
 * normals transported from the clean source garment if the raw fit already
 * contains spikes. Otherwise smooth normals of the fitted mesh are used. */
export function fixAlongNormals(garmentMesh, bodySurface, {
  sourcePositions = null, preferredNormals = null, clearance = .06,
  iterations = 14, smoothing = .22, normalSmoothing = 2,
  maxDistance = 1.8, maximumStep = .10, faceSamples = true,
  avoidTouchingArmpits = true,
} = {}) {
  if (!bodySurface?.distance) throw new Error('A body surface with a union-aware distance() is required.');
  const base = Float32Array.from(garmentMesh.positions), positions = Float32Array.from(base);
  const source = sourcePositions && sourcePositions.length === base.length ? sourcePositions : base;
  const { near, normals } = neighborsAndNormals(garmentMesh, source);
  const directions = Float32Array.from(preferredNormals?.length === base.length ? preferredNormals : normals);
  const bounds = bodySurface.bounds;
  const centerZ = bounds ? (bounds.min[2] + bounds.max[2]) / 2 : 0;
  const centerX = bounds ? (bounds.min[0] + bounds.max[0]) / 2 : 0;
  const height = bounds ? bounds.size[1] : 5.1, width = bounds ? bounds.size[0] : 4;
  // Orient first, then smooth immutable directions. At touching arms/body the
  // lateral normal points into another solid, so bias the sleeve seam toward
  // its already existing front/back side instead of growing alternating fins.
  for (let i = 0; i < base.length / 3; i++) {
    const p = point(base, i), n = point(directions, i), radial = [p[0] - centerX, 0, p[2] - centerZ];
    if (dot(n, radial) < 0 && Math.abs(n[1]) < .75) for (let k = 0; k < 3; k++) n[k] *= -1;
    if (length(n) < 1e-8) n.splice(0, 3, ...unit(radial));
    const inCorridor = avoidTouchingArmpits && Math.abs(p[0] - centerX) > width * .21 && Math.abs(p[0] - centerX) < width * .43 && p[1] > height * .44 && p[1] < height * .75 && Math.abs(p[2] - centerZ) < bounds.size[2] * .58;
    if (inCorridor && Math.abs(n[1]) < .70) {
      const outwardZ = p[2] >= centerZ ? 1 : -1;
      n[0] *= .12; n[2] += outwardZ * .9;
    }
    write(directions, i, unit(n));
  }
  for (let step = 0; step < normalSmoothing; step++) {
    const next = Float32Array.from(directions);
    for (let i = 0; i < base.length / 3; i++) {
      const own = point(directions, i); let average = mul(own, 2), count = 2;
      for (const j of near[i]) {
        const n = point(directions, j);
        if (dot(n, own) < .1) continue;
        average = add(average, n); count++;
      }
      write(next, i, unit(mul(average, 1 / count)));
    }
    directions.set(next);
  }

  const history = [];
  for (let step = 0; step < iterations; step++) {
    const next = Float32Array.from(positions);
    let correctedVertices = 0, correctedSamples = 0, unresolvedSamples = 0, maximumCorrection = 0;
    for (let i = 0; i < base.length / 3; i++) {
      let p = point(positions, i);
      if (step && near[i].length) {
        let displacement = [0, 0, 0];
        for (const j of near[i]) displacement = add(displacement, sub(point(positions, j), point(base, j)));
        const relaxed = add(point(base, i), mul(displacement, 1 / near[i].length));
        p = add(mul(p, 1 - smoothing), mul(relaxed, smoothing));
      }
      const hit = exitAlong(p, point(directions, i), bodySurface, clearance, maxDistance);
      if (hit.unresolved) unresolvedSamples++;
      if (hit.movement > 0) {
        p = add(p, mul(point(directions, i), Math.min(hit.movement, maximumStep)));
        correctedVertices++; maximumCorrection = Math.max(maximumCorrection, hit.movement);
      }
      write(next, i, p);
    }
    positions.set(next);
    if (faceSamples) {
      const deltas = new Float32Array(base.length), counts = new Float32Array(base.length / 3);
      for (let face = 0; face < garmentMesh.indices.length; face += 3) {
        const ids = [garmentMesh.indices[face], garmentMesh.indices[face + 1], garmentMesh.indices[face + 2]];
        for (const bary of samples) {
          const p = [0, 0, 0], n = [0, 0, 0];
          for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) { p[k] += positions[ids[j] * 3 + k] * bary[j]; n[k] += directions[ids[j] * 3 + k] * bary[j]; }
          const direction = unit(n), hit = exitAlong(p, direction, bodySurface, clearance * .8, maxDistance);
          if (hit.unresolved) unresolvedSamples++;
          if (!hit.movement) continue;
          correctedSamples++; maximumCorrection = Math.max(maximumCorrection, hit.movement);
          const denominator = dot(bary, bary), movement = Math.min(hit.movement * .65, maximumStep * .7);
          for (let j = 0; j < 3; j++) if (bary[j]) {
            const id = ids[j]; counts[id]++;
            for (let k = 0; k < 3; k++) deltas[id * 3 + k] += direction[k] * movement * bary[j] / denominator;
          }
        }
      }
      for (let i = 0; i < counts.length; i++) if (counts[i]) for (let k = 0; k < 3; k++) positions[i * 3 + k] += deltas[i * 3 + k] / counts[i];
    }
    history.push({ iteration: step + 1, correctedVertices, correctedSamples, unresolvedSamples, maximumCorrection });
  }
  return { positions, indices: garmentMesh.indices, history, directions, quality: shapeQuality(base, positions, garmentMesh.indices) };
}
