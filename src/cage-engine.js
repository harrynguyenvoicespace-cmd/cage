/**
 * Template cage laboratory: all positions are flat xyz arrays in world space.
 * Cage indices and UVs are never rewritten. This is an independently implemented
 * surface-coordinate deformation, informed by the surface-deform workflow, not
 * Roblox's proprietary WrapLayer solver or a copy of Blender source code.
 */
import {bindMls,deformMls} from './cage-mls.js';
const EPS = 1e-10;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const xyz = (a, i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.sqrt(dot(a, a));
const normal = a => mul(a, 1 / Math.max(length(a), EPS));
const dist2 = (a, b) => dot(sub(a, b), sub(a, b));
const write = (a, i, p) => { a[i * 3] = p[0]; a[i * 3 + 1] = p[1]; a[i * 3 + 2] = p[2]; };

export function meshBounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let j = 0; j < 3; j++) {
    min[j] = Math.min(min[j], positions[i + j]); max[j] = Math.max(max[j], positions[i + j]);
  }
  return { min, max, center: min.map((v, i) => (v + max[i]) / 2), size: min.map((v, i) => max[i] - v) };
}

export function vertexNormals(positions, indices) {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const ids = [indices[i], indices[i + 1], indices[i + 2]];
    const n = cross(sub(xyz(positions, ids[1]), xyz(positions, ids[0])), sub(xyz(positions, ids[2]), xyz(positions, ids[0])));
    for (const id of ids) for (let k = 0; k < 3; k++) out[id * 3 + k] += n[k];
  }
  for (let i = 0; i < positions.length / 3; i++) write(out, i, normal(xyz(out, i)));
  return out;
}

/** Closest point and barycentric coordinates, including edges and vertices. */
export function closestTriangle(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  let bary;
  if (d1 <= 0 && d2 <= 0) bary = [1, 0, 0];
  else {
    const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) bary = [0, 1, 0];
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / Math.max(d1 - d3, EPS); bary = [1 - v, v, 0]; }
      else {
        const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
        if (d6 >= 0 && d5 <= d6) bary = [0, 0, 1];
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / Math.max(d2 - d6, EPS); bary = [1 - w, 0, w]; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / Math.max(d4 - d3 + d5 - d6, EPS); bary = [0, 1 - w, w];
            } else {
              const denom = va + vb + vc;
              if (Math.abs(denom) < EPS) bary = [1, 0, 0];
              else { const v = vb / denom, w = vc / denom; bary = [1 - v - w, v, w]; }
            }
          }
        }
      }
    }
  }
  const point = add(add(mul(a, bary[0]), mul(b, bary[1])), mul(c, bary[2]));
  return { point, bary, distance2: dist2(p, point) };
}

function boxDistance2(p, box) {
  let v = 0;
  for (let i = 0; i < 3; i++) { const d = Math.max(box.min[i] - p[i], 0, p[i] - box.max[i]); v += d * d; }
  return v;
}

/** Small BVH, rebuilt only when the body/cage geometry changes. */
export function createSurface(mesh) {
  const positions = mesh.positions, indices = mesh.indices;
  if (!positions || !indices || positions.length % 3 || indices.length % 3) throw new Error('Expected flat triangle mesh arrays.');
  for(const v of positions)if(!Number.isFinite(v))throw new Error('Mesh contains a non-finite coordinate.');
  const triangles = [];
  for (let i = 0; i < indices.length; i += 3) {
    const ids = [indices[i], indices[i + 1], indices[i + 2]];
    const points = ids.map(id => xyz(positions, id));
    const e1 = sub(points[1], points[0]), e2 = sub(points[2], points[0]);
    const area = length(cross(e1, e2));
    if (area < EPS) continue;
    const bounds = meshBounds(points.flat());
    triangles.push({ index: i / 3, ids, points, normal: normal(cross(e1, e2)), area, ...bounds, group: mesh.triangleGroups?.[i / 3] });
  }
  if (!triangles.length) throw new Error('Mesh has no nondegenerate triangles.');
  function build(items) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const t of items) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], t.min[k]); max[k] = Math.max(max[k], t.max[k]); }
    const node = { min, max };
    if (items.length <= 12) node.items = items;
    else {
      const spans = max.map((v, i) => v - min[i]), axis = spans.indexOf(Math.max(...spans));
      items.sort((a, b) => a.center[axis] - b.center[axis]);
      const mid = Math.floor(items.length / 2);
      node.left = build(items.slice(0, mid)); node.right = build(items.slice(mid));
    }
    return node;
  }
  const root = build(triangles.slice());
  // A closest point on an edge needs the edge/vertex pseudonormal, not the
  // normal of whichever incident triangle happened to win the BVH query.
  // GLB splits vertices at hard normals, so weld positions only for this lookup.
  const welded = new Map(), vertexKeys = [];
  for (let i = 0; i < positions.length / 3; i++) {
    const key = xyz(positions, i).map(v => Math.round(v * 1e5)).join(':');
    vertexKeys.push(key); if (!welded.has(key)) welded.set(key, [0, 0, 0]);
  }
  for (const t of triangles) for (const id of t.ids) {
    const current = welded.get(vertexKeys[id]);
    for (let k = 0; k < 3; k++) current[k] += t.normal[k] * t.area;
  }
  const pseudoNormals = vertexKeys.map(key => normal(welded.get(key)));
  const partSurfaces = mesh.parts?.map(part => ({ name: part.name, surface: createSurface(part) }));
  function closest(point, count = 1, allowedGroups = null) {
    const best = [];
    function visit(node) {
      if (best.length >= count && boxDistance2(point, node) > best.at(-1).distance2) return;
      if (node.items) for (const t of node.items) {
        if (allowedGroups && !allowedGroups.includes(t.group)) continue;
        const hit = { ...closestTriangle(point, ...t.points), triangle: t };
        hit.normal = normal(t.ids.reduce((n, id, k) => add(n, mul(pseudoNormals[id], hit.bary[k])), [0, 0, 0]));
        if (best.length < count || hit.distance2 < best.at(-1).distance2) {
          best.push(hit); best.sort((a, b) => a.distance2 - b.distance2);
          if (best.length > count) best.pop();
        }
      } else {
        const first = boxDistance2(point, node.left) <= boxDistance2(point, node.right) ? node.left : node.right;
        visit(first); visit(first === node.left ? node.right : node.left);
      }
    }
    visit(root);
    return count === 1 ? best[0] : best;
  }
  function ray(origin, direction, maxDistance = Infinity) {
    const hits = [];
    function boxRay(n) {
      let lo = 0, hi = maxDistance;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(direction[k]) < EPS) { if (origin[k] < n.min[k] || origin[k] > n.max[k]) return false; }
        else {
          let a = (n.min[k] - origin[k]) / direction[k], b = (n.max[k] - origin[k]) / direction[k];
          if (a > b) [a, b] = [b, a]; lo = Math.max(lo, a); hi = Math.min(hi, b); if (lo > hi) return false;
        }
      }
      return true;
    }
    function visit(n) {
      if (!boxRay(n)) return;
      if (n.items) for (const t of n.items) {
        const [a, b, c] = t.points, e1 = sub(b, a), e2 = sub(c, a), h = cross(direction, e2), det = dot(e1, h);
        if (Math.abs(det) < EPS) continue;
        const inv = 1 / det, s = sub(origin, a), u = inv * dot(s, h);
        if (u < -EPS || u > 1 + EPS) continue;
        const q = cross(s, e1), v = inv * dot(direction, q);
        if (v < -EPS || u + v > 1 + EPS) continue;
        const d = inv * dot(e2, q);
        if (d > 1e-7 && d <= maxDistance) hits.push({ distance: d, point: add(origin, mul(direction, d)), triangle: t, bary: [1 - u - v, u, v] });
      } else { visit(n.left); visit(n.right); }
    }
    visit(root); hits.sort((a, b) => a.distance - b.distance);
    return hits.filter((h, i) => i === 0 || h.distance - hits[i - 1].distance > 1e-6);
  }
  function distance(point, { robust = false, groups = null } = {}) {
    if (partSurfaces) {
      // R15 pieces overlap at joints. The union is inside when ANY piece is
      // inside; global ray parity over overlapping solids gives a wrong answer.
      let best;
      const candidates = partSurfaces.filter(part => !groups || groups.includes(part.name))
        .map(part => ({ ...part, lower: boxDistance2(point, part.surface.bounds) }))
        .sort((a, b) => a.lower - b.lower);
      for (const part of candidates) {
        if (best && ((best.signed < 0 && part.lower > 1e-10) || (best.signed >= 0 && part.lower > best.distance2))) continue;
        const hit = part.surface.distance(point, { robust });
        if (!best || hit.signed < best.signed) best = { ...hit, part: part.name };
      }
      if (best) return best;
    }
    const hit = closest(point, 1, groups);
    if (!hit) return { signed: Infinity, distance: Infinity, point, normal: [0, 0, 0] };
    const d = Math.sqrt(hit.distance2);
    let inside = dot(sub(point, hit.point), hit.normal) < -1e-8;
    if (robust && d > 1e-6) inside = ray(point, normal([1, 0.3719, 0.1273])).length % 2 === 1;
    return { ...hit, signed: inside ? -d : d, distance: d, inside };
  }
  function project(point,clearance=0.02,preferredDirection=null) {
    const hit=distance(point);
    if(hit.signed>=clearance)return point;
    const simple=add(hit.point,mul(hit.normal,clearance));
    if(!partSurfaces||distance(simple).signed>=clearance*.85)return simple;
    if(preferredDirection)for(const exit of ray(point,preferredDirection,1.2)) {
      const candidate=add(exit.point,mul(preferredDirection,clearance+0.005));
      if(distance(candidate).signed>=clearance*.85)return candidate;
    }
    // Closest exits of two touching R15 pieces can face one another. Search a
    // real exit from their union rather than alternating between those faces.
    let best=null,bestDistance=Infinity;
    const directions=[hit.normal,[0,0,1],[0,0,-1],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0]];
    for(const direction of directions)for(const exit of ray(point,direction,1.2)) {
      const candidate=add(exit.point,mul(direction,clearance+0.005)),d=dist2(point,candidate);
      if(d>=bestDistance)continue;
      if(distance(candidate).signed>=clearance*.85){best=candidate;bestDistance=d;break;}
    }
    return best||simple;
  }
  return { positions, indices, root, triangles, bounds: meshBounds(positions), closest, ray, distance, project };
}

/**
 * Bind each garment point once. Multiple nearby triangles blend local frames to
 * reduce discontinuities at cage edges. Tangential coordinates follow triangle
 * stretch; the normal offset is transported by the target triangle's normal.
 */
export function bindToCage(garmentPositions, cageMesh, { neighbors = 4, falloff = 3, normalScale = false, vertexGroups=null } = {}) {
  const cage = cageMesh.closest ? cageMesh : createSurface(cageMesh);
  const vertices = [];
  for (let i = 0; i < garmentPositions.length / 3; i++) {
    const p = xyz(garmentPositions, i), allowed=vertexGroups?.[i]||null;
    let hits = cage.closest(p, neighbors,allowed);
    if(!hits.length)hits=cage.closest(p,neighbors);
    const records = [];
    const nearestNormal = hits[0].triangle.normal;
    for (const hit of hits) {
      const t = hit.triangle;
      // Reject the opposite side of a narrow sleeve, arm or torso.
      if (dot(t.normal, nearestNormal) < -0.1) continue;
      const [a, b, c] = t.points, e1 = sub(b, a), e2 = sub(c, a), v = sub(p, a);
      const aa = dot(e1, e1), bb = dot(e2, e2), ab = dot(e1, e2), va = dot(v, e1), vb = dot(v, e2);
      const denom = aa * bb - ab * ab;
      const u = (va * bb - vb * ab) / denom, w = (vb * aa - va * ab) / denom;
      const distance = Math.sqrt(hit.distance2), regularizer = Math.sqrt(t.area) * 0.075;
      const weight = 1 / Math.pow(distance + regularizer + 1e-6, falloff);
      const tangent=normal(e1),bitangent=normal(cross(t.normal,tangent)),residual=sub(p,hit.point);
      records.push({ ids: t.ids, u, v: w, bary:hit.bary, tangentOffset:[dot(residual,tangent),dot(residual,bitangent)], edgeLength:length(e1),offset: dot(v, t.normal), area: t.area, weight });
    }
    const total = records.reduce((n, r) => n + r.weight, 0);
    for (const r of records) r.weight /= total;
    vertices.push(records);
  }
  return { vertices, normalScale, sourceVertexCount: cage.positions.length / 3, sourcePositions: Float32Array.from(garmentPositions) };
}

export function deformWithCage(bindings, targetPositions, output = new Float32Array(bindings.vertices.length * 3)) {
  if(bindings.method==='weighted-affine-cage-coordinates')return deformMls(bindings,targetPositions,output);
  if (targetPositions.length / 3 !== bindings.sourceVertexCount) throw new Error('Target cage topology does not match the bound template.');
  for (let i = 0; i < bindings.vertices.length; i++) {
    let p = [0, 0, 0];
    for (const r of bindings.vertices[i]) {
      const [a, b, c] = r.ids.map(id => xyz(targetPositions, id));
      const e1 = sub(b, a), e2 = sub(c, a), areaNormal = cross(e1, e2), n = normal(areaNormal);
      const scale = bindings.normalScale ? clamp(Math.sqrt(length(areaNormal) / r.area), 0.35, 3) : 1;
      const anchor=add(add(mul(a,r.bary[0]),mul(b,r.bary[1])),mul(c,r.bary[2]));
      const tangent=normal(e1),bitangent=normal(cross(n,tangent)),tangentScale=1;
      const q=add(add(add(anchor,mul(tangent,r.tangentOffset[0]*tangentScale)),mul(bitangent,r.tangentOffset[1]*tangentScale)),mul(n,r.offset*scale));
      p = add(p, mul(q, r.weight));
    }
    write(output, i, p);
  }
  return output;
}

export const buildGarmentBindings = bindToCage;
export const deformGarment = deformWithCage;

/** Keep the canonical source→cage face correspondence after a rest-fit repair. */
export function rebindWithCorrespondence(bindings, restCagePositions, repairedGarmentPositions) {
  if(bindings.method==='weighted-affine-cage-coordinates')return bindings;
  if(repairedGarmentPositions.length!==bindings.vertices.length*3)throw new Error('Repaired garment topology does not match its canonical bindings.');
  const vertices=bindings.vertices.map((records,i)=>records.map(record=> {
    const [a,b,c]=record.ids.map(id=>xyz(restCagePositions,id)),e1=sub(b,a),e2=sub(c,a),n=normal(cross(e1,e2)),tangent=normal(e1),bitangent=normal(cross(n,tangent));
    const anchor=add(add(mul(a,record.bary[0]),mul(b,record.bary[1])),mul(c,record.bary[2]));
    const residual=sub(xyz(repairedGarmentPositions,i),anchor);
    return {...record,offset:dot(residual,n),tangentOffset:[dot(residual,tangent),dot(residual,bitangent)],area:length(cross(e1,e2)),edgeLength:length(e1)};
  }));
  return {...bindings,vertices,sourcePositions:Float32Array.from(repairedGarmentPositions)};
}

export function adjacency(vertexCount, indices) {
  const sets = Array.from({ length: vertexCount }, () => new Set());
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
    sets[a].add(b).add(c); sets[b].add(a).add(c); sets[c].add(a).add(b);
  }
  return sets.map(set => [...set]);
}

export function alignBounds(sourcePositions, targetPositions, { isotropic = false } = {}) {
  const a = meshBounds(sourcePositions), b = meshBounds(targetPositions);
  const scales = a.size.map((v, i) => b.size[i] / Math.max(v, EPS));
  if (isotropic) scales.fill(scales[1]);
  const out = new Float32Array(sourcePositions.length);
  for (let i = 0; i < sourcePositions.length / 3; i++) write(out, i, xyz(sourcePositions, i).map((v, k) => (v - a.center[k]) * scales[k] + b.center[k]));
  return out;
}

/**
 * Constrained fitting: nearest surface anchors, displacement smoothing rather
 * than destructive position smoothing, then vertex + face-sample collision
 * projection. Optional per-vertex group lists keep armpits on the intended part.
 */
export function fitCageToBody(template, bodyMesh, options = {}) {
  const body = bodyMesh.closest ? bodyMesh : createSurface(Array.isArray(bodyMesh) ? mergeBodyParts(bodyMesh) : bodyMesh);
  const initial = Float32Array.from(options.initialPositions || alignBounds(template.positions, body.positions));
  const result = Float32Array.from(initial), anchors = new Float32Array(initial.length);
  const clearance = options.clearance ?? 0.025, iterations = options.iterations ?? 12;
  const smoothing = options.smoothing ?? 0.18, strength = options.strength ?? 0.82;
  const neighbors = adjacency(initial.length / 3, template.indices), history = [];
  for (let i = 0; i < initial.length / 3; i++) {
    const p = xyz(initial, i), groups = options.vertexGroups?.[i] || null;
    const hit = body.distance(p, { groups });
    write(anchors, i, add(hit.point, mul(hit.normal, clearance)));
    write(result, i, add(mul(p, 1 - strength), mul(xyz(anchors, i), strength)));
  }
  for (let step = 0; step < iterations; step++) {
    const next = Float32Array.from(result);
    for (let i = 0; i < result.length / 3; i++) {
      const p0 = xyz(initial, i), p = xyz(result, i), near = neighbors[i];
      if (!near.length) continue;
      let averageDisplacement = [0, 0, 0];
      for (const j of near) averageDisplacement = add(averageDisplacement, sub(xyz(result, j), xyz(initial, j)));
      averageDisplacement = mul(averageDisplacement, 1 / near.length);
      let candidate = add(mul(p, 1 - smoothing), mul(add(p0, averageDisplacement), smoothing));
      candidate = add(mul(candidate, 0.78), mul(xyz(anchors, i), 0.22));
      const hit = body.distance(candidate, { groups: options.vertexGroups?.[i] || null });
      if (hit.signed < clearance) candidate = add(hit.point, mul(hit.normal, clearance));
      write(next, i, candidate);
    }
    result.set(next);
    const corrections = projectTriangleCollisions(result, template.indices, body, { clearance, relaxation: 0.65, sampleEdges: true });
    history.push({ iteration: step + 1, correctedSamples: corrections.correctedSamples, maximumCorrection: corrections.maximumCorrection });
  }
  return { positions: result, indices: template.indices, uv: template.uv, history, diagnostics: diagnoseMesh({ positions: result, indices: template.indices }, body, { clearance: clearance * 0.4 }), preservedTopology: true };
}

const TRIANGLE_SAMPLES = [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]];

/** Catch face/edge penetration that checking vertices alone misses. */
export function projectTriangleCollisions(positions, indices, bodyMesh, { clearance = 0.02, relaxation = 0.9, sampleEdges = true, robust = false,triangleSurfaces=null } = {}) {
  const body = bodyMesh.closest ? bodyMesh : createSurface(bodyMesh);
  const delta = new Float32Array(positions.length), weights = new Float32Array(positions.length / 3);
  let correctedSamples = 0, maximumCorrection = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const collider=triangleSurfaces?.[i/3]||body;
    const ids = [indices[i], indices[i + 1], indices[i + 2]], vertices = ids.map(id => xyz(positions, id));
    for (const bary of (sampleEdges ? TRIANGLE_SAMPLES : TRIANGLE_SAMPLES.slice(0, 1))) {
      const p = add(add(mul(vertices[0], bary[0]), mul(vertices[1], bary[1])), mul(vertices[2], bary[2]));
      const hit = collider.distance(p, { robust });
      if (hit.signed >= clearance) continue;
      const distance = clearance - hit.signed;
      if (distance > 0.7) continue; // Bad global alignment must not explode a local projection.
      const correction = mul(sub(collider.project(p,clearance),p),relaxation);
      correctedSamples++; maximumCorrection = Math.max(maximumCorrection, distance);
      for (let j = 0; j < 3; j++) if (bary[j] > 0) {
        weights[ids[j]] += bary[j];
        for (let k = 0; k < 3; k++) delta[ids[j] * 3 + k] += correction[k] * bary[j];
      }
    }
  }
  for (let i = 0; i < weights.length; i++) if (weights[i] > 0) for (let k = 0; k < 3; k++) positions[i * 3 + k] += delta[i * 3 + k] / weights[i];
  return { correctedSamples, maximumCorrection };
}

/** Resolve a garment after deformation; retain the cage-derived result as anchor. */
export function resolveGarmentCollisions(garment, bodyMesh, { clearance = 0.035, iterations = 8, smoothing = 0.16, robust = false, referencePositions=null, targetScale=2.0, maximumStretch=1.65, preferredDirections=null } = {}) {
  const body = bodyMesh.closest ? bodyMesh : createSurface(bodyMesh);
  const positions = Float32Array.from(garment.positions), base = Float32Array.from(positions);
  const near = adjacency(positions.length / 3, garment.indices), history = [];
  const edges=[];
  if(referencePositions)for(let i=0;i<near.length;i++)for(const j of near[i])if(j>i)edges.push({i,j,maximum:Math.max(.025,Math.sqrt(dist2(xyz(referencePositions,i),xyz(referencePositions,j))))*targetScale*maximumStretch});
  for (let step = 0; step < iterations; step++) {
    const next = Float32Array.from(positions);
    let correctedVertices = 0;
    for (let i = 0; i < positions.length / 3; i++) {
      let p = xyz(positions, i);
      if (step > 0 && near[i].length) {
        let d = [0, 0, 0];
        for (const j of near[i]) d = add(d, sub(xyz(positions, j), xyz(base, j)));
        const relaxed = add(xyz(base, i), mul(d, 1 / near[i].length));
        p = add(mul(p, 1 - smoothing), mul(relaxed, smoothing));
      }
      const hit = body.distance(p, { robust });
      if (hit.signed < clearance && hit.signed > -0.7) { p = body.project(p,clearance,preferredDirections?.[i]); correctedVertices++; }
      write(next, i, p);
    }
    positions.set(next);
    const corrections = projectTriangleCollisions(positions, garment.indices, body, { clearance, relaxation: 0.8, sampleEdges: true, robust });
    for(let pass=0;pass<3;pass++)for(const edge of edges) {
      const a=xyz(positions,edge.i),b=xyz(positions,edge.j),d=sub(b,a),len=length(d);
      if(len>edge.maximum) {
        const correction=mul(d,(len-edge.maximum)/len*.32);
        write(positions,edge.i,add(a,correction));write(positions,edge.j,sub(b,correction));
      }
    }
    history.push({ iteration: step + 1, correctedVertices, ...corrections });
  }
  return { positions, indices: garment.indices, history, diagnostics: diagnoseMesh({ positions, indices: garment.indices }, body, { clearance: clearance * 0.25, robust }) };
}

/** Outer cage envelopes the garment, with the same vertex/face/UV identity. */
export function fitOuterCage(inner, garmentMesh, { thickness = 0.045, influence = null, maximumExpansion = 0.5, iterations = 8 } = {}) {
  const garment = garmentMesh.closest ? garmentMesh : createSurface(garmentMesh);
  const normals = vertexNormals(inner.positions, inner.indices), positions = Float32Array.from(inner.positions);
  for (let i = 0; i < positions.length / 3; i++) {
    const p = xyz(inner.positions, i), n = xyz(normals, i), factor = influence ? influence[i] : 1;
    if (factor <= 0) continue;
    const origin = sub(p, mul(n, 0.005)), hits = garment.ray(origin, n, maximumExpansion);
    let expansion = thickness * factor;
    if (hits.length) expansion = Math.min(maximumExpansion, hits.at(-1).distance + thickness * factor);
    else {
      const nearest = garment.closest(p), offset = dot(sub(nearest.point, p), n);
      if (nearest.distance2 < maximumExpansion ** 2 && offset > 0) expansion = Math.min(maximumExpansion, offset + thickness * factor);
    }
    write(positions, i, add(p, mul(n, expansion)));
  }
  // A regularized expansion field avoids spikes around cuffs and shoulders.
  const near = adjacency(positions.length / 3, inner.indices);
  for (let step = 0; step < iterations; step++) {
    const next = Float32Array.from(positions);
    for (let i = 0; i < positions.length / 3; i++) {
      const factor = influence ? influence[i] : 1;
      if (factor <= 0 || !near[i].length) continue;
      const p0 = xyz(inner.positions, i), n = xyz(normals, i);
      const own = dot(sub(xyz(positions, i), p0), n);
      const average = near[i].reduce((s, j) => s + Math.max(0, dot(sub(xyz(positions, j), xyz(inner.positions, j)), xyz(normals, j))), 0) / near[i].length;
      write(next, i, add(p0, mul(n, Math.max(own, average * 0.8 * factor))));
    }
    positions.set(next);
  }
  // Each garment vertex constrains its nearest cage triangle. A ray from the
  // cage alone can miss collars/cuffs between sparse cage vertices.
  for(let step=0;step<iterations;step++) {
    const surface=createSurface({positions,indices:inner.indices});
    const correction=new Float32Array(positions.length),counts=new Float32Array(positions.length/3);
    let outside=0;
    for(let j=0;j<garment.positions.length/3;j++) {
      const p=xyz(garment.positions,j),hit=surface.distance(p);
      if(hit.signed<=-thickness*.6)continue;
      const depth=hit.signed+thickness;
      if(depth<0||depth>maximumExpansion)continue;
      outside++;
      for(const id of hit.triangle.ids) {
        if(influence&&influence[id]<=0)continue;
        // Normal displacement leaves tangential cage spacing intact.
        const n=xyz(normals,id),alignment=dot(n,hit.normal);
        if(alignment<.20)continue;
        const factor=influence?influence[id]:1;
        const amount=Math.max(0,hit.signed+thickness*factor)/Math.max(alignment,.35)*.70;
        counts[id]++;
        for(let k=0;k<3;k++)correction[id*3+k]+=n[k]*amount;
      }
    }
    if(!outside)break;
    for(let i=0;i<counts.length;i++)if(counts[i]) {
      let p=add(xyz(positions,i),mul(xyz(correction,i),1/counts[i]));
      const d=sub(p,xyz(inner.positions,i)),l=length(d);
      if(l>maximumExpansion)p=add(xyz(inner.positions,i),mul(d,maximumExpansion/l));
      write(positions,i,p);
    }
  }
  return { positions, indices: inner.indices, uv: inner.uv, preservedTopology: true };
}

/** Reports sample evidence, not a claim of Roblox Marketplace validation. */
export function diagnoseMesh(mesh, bodyMesh, { clearance = 0, robust = false, includeFaces = true } = {}) {
  const body = bodyMesh.closest ? bodyMesh : createSurface(bodyMesh);
  let penetrationSamples = 0, clearanceFailures = 0, sampleCount = 0, minimumClearance = Infinity, maximumPenetration = 0, invalidSamples=0;
  const badVertices = [], distances = new Float32Array(mesh.positions.length / 3);
  function sample(p, vertex = null) {
    if(!p.every(Number.isFinite)){sampleCount++;invalidSamples++;return;}
    const signed = body.distance(p, { robust }).signed;
    sampleCount++; minimumClearance = Math.min(minimumClearance, signed);
    if (signed < -0.002) { penetrationSamples++; maximumPenetration = Math.max(maximumPenetration, -signed); if (vertex !== null) badVertices.push(vertex); }
    if (signed < clearance) clearanceFailures++;
    if (vertex !== null) distances[vertex] = signed;
  }
  for (let i = 0; i < mesh.positions.length / 3; i++) sample(xyz(mesh.positions, i), i);
  if (includeFaces) for (let i = 0; i < mesh.indices.length; i += 3) {
    const verts = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]].map(id => xyz(mesh.positions, id));
    for (const b of TRIANGLE_SAMPLES) sample(add(add(mul(verts[0], b[0]), mul(verts[1], b[1])), mul(verts[2], b[2])));
  }
  return { penetrationSamples, clearanceFailures, sampleCount, minimumClearance, maximumPenetration, badVertices, distances, invalidSamples, passed: penetrationSamples === 0&&invalidSamples===0 };
}

export function deformationDiagnostics(source, target, indices) {
  const seen = new Set(), ratios = []; let maximumStretch = 0, minimumStretch = Infinity;
  for (let i = 0; i < indices.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = indices[i + j], b = indices[i + (j + 1) % 3], key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    if (seen.has(key)) continue; seen.add(key);
    const before = Math.sqrt(dist2(xyz(source, a), xyz(source, b)));
    if (before < 1e-7) continue;
    const ratio = Math.sqrt(dist2(xyz(target, a), xyz(target, b))) / before;
    ratios.push(ratio); maximumStretch = Math.max(maximumStretch, ratio); minimumStretch = Math.min(minimumStretch, ratio);
  }
  ratios.sort((a, b) => a - b);
  return { edgeCount: ratios.length, minimumStretch, maximumStretch, medianStretch: ratios[Math.floor(ratios.length / 2)] || 0, p95Stretch: ratios[Math.floor(ratios.length * 0.95)] || 0 };
}

/** Transfer up to four existing body bone weights through cage surface bindings. */
export function transferSkinWeights(bindings, cageBoneIndices, cageBoneWeights, influences = 4) {
  const indices = new Uint16Array(bindings.vertices.length * influences), weights = new Float32Array(indices.length);
  for (let i = 0; i < bindings.vertices.length; i++) {
    const map = new Map();
    for (const bind of bindings.vertices[i]) {
      const bary = [1 - bind.u - bind.v, bind.u, bind.v].map(v => Math.max(0, v));
      const sum = bary.reduce((a, b) => a + b, 0);
      for (let j = 0; j < 3; j++) for (let k = 0; k < influences; k++) {
        const at = bind.ids[j] * influences + k, bone = cageBoneIndices[at], value = cageBoneWeights[at] * bary[j] / sum * bind.weight;
        map.set(bone, (map.get(bone) || 0) + value);
      }
    }
    const chosen = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, influences), sum = chosen.reduce((s, x) => s + x[1], 0);
    for (let j = 0; j < chosen.length; j++) { indices[i * influences + j] = chosen[j][0]; weights[i * influences + j] = chosen[j][1] / Math.max(sum, EPS); }
  }
  return { indices, weights };
}

export function linearBlendSkinning(positions, skinIndices, skinWeights, boneMatrices, { influences = 4, output = new Float32Array(positions.length) } = {}) {
  for (let i = 0; i < positions.length / 3; i++) {
    const p = xyz(positions, i); let q = [0, 0, 0];
    for (let j = 0; j < influences; j++) {
      const at = i * influences + j, weight = skinWeights[at]; if (!weight) continue;
      const m = boneMatrices[skinIndices[at]]?.elements || boneMatrices[skinIndices[at]];
      if (!m || m.length !== 16) throw new Error('Bone transform must be a column-major 4×4 matrix.');
      q = add(q, mul([m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]], weight));
    }
    write(output, i, q);
  }
  return output;
}

export function prepareCage(mesh) {
  return { ...mesh, positions: Float32Array.from(mesh.positions), indices: Uint32Array.from(mesh.indices), normals: vertexNormals(mesh.positions, mesh.indices) };
}

export function mergeBodyParts(parts) {
  const positions = [], indices = [], triangleGroups = [];
  for (const part of parts) {
    const offset = positions.length / 3;
    positions.push(...part.positions);
    for (const index of part.indices) indices.push(index + offset);
    triangleGroups.push(...Array.from({ length: part.indices.length / 3 }, () => part.name));
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), triangleGroups, parts };
}

/** Independent Roblox example garment, placed on the template's mannequin. */
export function placeTshirtOnCage(shirt, cage, { hem = 0.495, shoulder = 0.815, ease = 1.025 } = {}) {
  const c = meshBounds(cage.positions), s = meshBounds(shirt.positions), positions = new Float32Array(shirt.positions.length);
  const height = c.size[1] * (shoulder - hem), scaleY = height / s.size[1];
  // The example is authored around a slim Roblox mannequin. Preserve its fabric
  // width and depth, then let the cage fit it to the independent block R15 body.
  const centerZ = -c.size[2] * 0.04;
  for (let i = 0; i < positions.length / 3; i++) {
    const p = xyz(shirt.positions, i);
    write(positions, i, [(p[0] - s.center[0]) * ease, c.min[1] + c.size[1] * hem + (p[1] - s.min[1]) * scaleY, (p[2] - s.center[2]) * ease + centerZ]);
  }
  return { ...shirt, positions, indices: Uint32Array.from(shirt.indices) };
}

/** Anatomical source landmarks identify the region before fitting changes shape. */
function sourceRegion(p, cageBounds) {
  const h = cageBounds.size[1], y = (p[1] - cageBounds.min[1]) / h, x = Math.abs(p[0]), side = p[0] < 0 ? 'Left' : 'Right';
  if (y > 0.85 || (y > 0.82 && x < .30*h/5.495)) return ['Head'];
  const anatomicalY=y*5.495181225,armThreshold=sourceArmThreshold(anatomicalY)*h/5.495181225;
  if(x>armThreshold&&y>.465&&y<.815) {
    if(y<.56)return [`${side}Hand`,`${side}LowerArm`];
    if(y<.655)return [`${side}LowerArm`,`${side}UpperArm`];
    return [`${side}UpperArm`,'UpperTorso'];
  }
  if (y < 0.49) {
    if (y < 0.072) return [`${side}Foot`, `${side}LowerLeg`];
    if (y < 0.245) return [`${side}LowerLeg`, `${side}Foot`, `${side}UpperLeg`];
    return [`${side}UpperLeg`, `${side}LowerLeg`, 'LowerTorso'];
  }
  return y < 0.555 ? ['LowerTorso', 'UpperTorso'] : ['UpperTorso', 'LowerTorso'];
}

export function assignCageInfluences(sourceCage, fittedPositions, parts) {
  const c = meshBounds(sourceCage.positions), surfaces = new Map(parts.map(p => [p.name, createSurface(p)]));
  const influences = [];
  for (let i = 0; i < fittedPositions.length / 3; i++) {
    const p = xyz(fittedPositions, i), allowed = sourceRegion(xyz(sourceCage.positions, i), c);
    const records = allowed.map(name => {
      const hit = surfaces.get(name)?.closest(p);
      return { name, distance: hit ? Math.sqrt(hit.distance2) : Infinity };
    }).filter(r => Number.isFinite(r.distance));
    // Limit cross-joint support to a small overlap band. Non-neighbor bones do
    // not affect an arm merely because it is resting against the body.
    const closest = Math.min(...records.map(r => r.distance));
    let sum = 0;
    for (const r of records) { r.weight = r.distance <= closest + 0.20 ? 1 / (0.055 + r.distance) ** 2 : 0; sum += r.weight; }
    influences.push(records.filter(r => r.weight > 0).map(({ name, weight }) => ({ name, weight: weight / sum })));
  }
  return influences;
}

function interpolateTable(value, rows, column) {
  if (value <= rows[0][0]) return rows[0][column];
  for (let i = 1; i < rows.length; i++) if (value <= rows[i][0]) {
    const t = (value - rows[i - 1][0]) / (rows[i][0] - rows[i - 1][0]);
    return rows[i - 1][column] * (1 - t) + rows[i][column] * t;
  }
  return rows.at(-1)[column];
}
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function sourceArmThreshold(y) {
  // Torso side x≈.5 at y3.0 is NOT an arm: template arms are at x≈1.4 there.
  return interpolateTable(y,[[2.60,1.15],[2.95,1.15],[3.30,1.04],[3.55,.85],[3.8,.68],[4.10,.53],[4.30,.46],[4.54,.42]],1);
}

/**
 * Pose-aware initialization for Roblox's slim arms-down template and block R15.
 * Limb centerlines are mapped first; radial coordinates are then expanded to
 * target cross sections. This avoids an arm vertex jumping onto the torso just
 * because the two parts are close in the rest pose.
 */
export function initializeR15Cage(sourceCage, bodyParts,{smoothHips=false}={}) {
  const positions = new Float32Array(sourceCage.positions.length), bounds = meshBounds(sourceCage.positions);
  const h = bounds.size[1], scale = 5.495181225 / h;
  const byName = new Map(bodyParts.map(p => [p.name, p.bounds || meshBounds(p.positions)]));
  const bodyHeight = meshBounds(mergeBodyParts(bodyParts).positions).size[1];
  const torso = byName.get('UpperTorso'), torsoX = torso.size[0] / 2, torsoZ = torso.size[2] / 2;
  const torsoRows = [[2.6,.46,.28], [2.9,.48,.35], [3.3,.50,.35], [3.8,.55,.32], [4.15,.62,.31], [4.4,.54,.30], [4.55,.26,.29]];
  function squircle(u,v,rx,rz) {
    const r=Math.sqrt(u*u+v*v), denominator=Math.max(r,.35);
    // n=8 superellipse follows the block R15 corners while remaining continuous.
    return [Math.sign(u)*Math.pow(Math.abs(u)/denominator,.25)*rx,Math.sign(v)*Math.pow(Math.abs(v)/denominator,.25)*rz];
  }
  function legPosition(x,y,z,side) {
    const cx=side*interpolateTable(y,[[0,.50],[.4,.49],[1.3,.39],[2.58,.30]],1);
    const cz=interpolateTable(y,[[0,.10],[.4,-.13],[1.3,-.12],[2.58,-.04]],1);
    const rz=interpolateTable(y,[[0,.33],[.4,.18],[1.3,.17],[2.58,.24]],1),rx=interpolateTable(y,[[0,.31],[.4,.25],[1.3,.26],[2.58,.31]],1);
    const radial=squircle((x-cx)/rx,(z-cz)/rz,.59,.59);
    return[side*.5+radial[0],y/2.58*2.15,radial[1]];
  }
  function torsoPosition(x,y,z) {
    const rx=interpolateTable(y,torsoRows,1),rz=interpolateTable(y,torsoRows,2),radial=squircle(x/rx,(z+.04)/rz,torsoX*1.14,torsoZ*1.16);
    return[radial[0],2.0+(y-2.6)/1.90*2.0,radial[1]];
  }
  function limbPoint(p,sourceNodes,targetNodes,radii) {
    let chosen;
    for(let j=0;j<sourceNodes.length-1;j++) {
      const a=sourceNodes[j],b=sourceNodes[j+1],edge=sub(b,a),t=clamp(dot(sub(p,a),edge)/dot(edge,edge),0,1),center=add(a,mul(edge,t)),d=dist2(p,center);
      if(!chosen||d<chosen.d)chosen={j,t,center,d,axis:normal(edge)};
    }
    const {j,t,center,axis}=chosen, targetCenter=add(mul(targetNodes[j],1-t),mul(targetNodes[j+1],t));
    // The source limb is diagonal. Its transverse x axis includes a y component.
    const right=normal([ -axis[1],axis[0],0]), forward=normal(cross(axis,right));
    const offset=sub(p,center),radius=radii[j].map((v,k)=>v*(1-t)+radii[j+1][k]*t);
    const u=dot(offset,right)/radius[0],v=dot(offset,forward)/radius[1];
    const radial=squircle(u,v,.59,.59);
    return [targetCenter[0]+radial[0],targetCenter[1],targetCenter[2]+radial[1]];
  }
  for (let i = 0; i < positions.length / 3; i++) {
    const p = xyz(sourceCage.positions, i), x = p[0] * scale, y = (p[1] - bounds.min[1]) * scale, z = p[2] * scale, side = x < 0 ? -1 : 1;
    let q;
    if (y >= 4.54) {
      const head = byName.get('Head'), center = head.min.map((v,k)=>(v+head.max[k])/2);
      const u=x/.28,v=(z-.04)/.31,radial=squircle(u,v,head.size[0]*.59,head.size[2]*.59);
      q = [center[0]+radial[0], head.min[1] + (y - 4.54) / (5.495 - 4.54) * head.size[1], center[2]+radial[1]];
    } else if (y < 2.58) {
      q=legPosition(x,y,z,side);
    } else {
      const torsoPoint=torsoPosition(x,y,z);
      const armPosition = limbPoint([Math.abs(x),y,z],[[.62,4.28,-.09],[1.08,3.52,-.06],[1.42,2.93,.14],[1.54,2.65,.18]],[[1.50,3.96,0],[1.50,3.04,0],[1.50,2.275,0],[1.50,2.03,0]],[[.17,.14],[.15,.12],[.13,.14],[.18,.18]]);
      armPosition[0]*=side;
      const armThreshold=sourceArmThreshold(y);
      const armFactor = smoothstep(armThreshold-.03,armThreshold+.12,Math.abs(x))*(1-smoothstep(4.35,4.54,y));
      q = add(mul(torsoPoint,1-armFactor),mul(armPosition,armFactor));
    }
    if(smoothHips&&y>2.35&&y<2.9&&Math.abs(x)<.9) {
      const factor=smoothstep(2.35,2.9,y);
      q=add(mul(legPosition(x,y,z,side),1-factor),mul(torsoPosition(x,y,z),factor));
    }
    q[1] *= bodyHeight / 5.10121008;
    write(positions,i,q);
  }
  return positions;
}

/** One coherent dataset used by the viewer and quantitative checks. */
export function createDemoFit(cageAsset, shirtAsset, bodyAsset, options = {}) {
  const sourceCage = prepareCage(cageAsset.inner || cageAsset);
  const placedGarment = placeTshirtOnCage(shirtAsset, sourceCage, options.placement);
  const sourceGarment = placedGarment;
  const bodyMesh = mergeBodyParts(bodyAsset.parts || bodyAsset), body = createSurface(bodyMesh);
  const initial = initializeR15Cage(sourceCage, bodyAsset.parts || bodyAsset);
  const bounds = meshBounds(sourceCage.positions);
  const vertexGroups = Array.from({ length: sourceCage.positions.length / 3 }, (_, i) => sourceRegion(xyz(sourceCage.positions, i), bounds));
  const fit = fitCageToBody(sourceCage, body, { initialPositions: initial, vertexGroups, clearance: 0.07, iterations: 0, smoothing: 0.03, strength: 0, ...options.fit });
  const bindings = bindToCage(sourceGarment.positions, sourceCage, { neighbors: 4, normalScale: false });
  const rawGarment = deformWithCage(bindings, fit.positions);
  const preferredDirections=Array.from({length:sourceGarment.positions.length/3},(_,i)=>[0,0,sourceGarment.positions[i*3+2]+.04>=0?1:-1]);
  const garment = resolveGarmentCollisions({ positions: rawGarment, indices: sourceGarment.indices }, body, { clearance: options.clearance ?? 0.06, iterations: options.garmentIterations ?? 24, smoothing: 0.14, referencePositions:sourceGarment.positions,preferredDirections });
  const inner = { ...sourceCage, positions: fit.positions };
  const outer = fitOuterCage(inner, garment, { thickness: 0.045, maximumExpansion: 0.55 });
  const influences = assignCageInfluences(sourceCage, fit.positions, bodyAsset.parts || bodyAsset);
  return {
    sourceCage, sourceGarment, bindings, bodyMesh, body,
    innerPositions: fit.positions, outerPositions: outer.positions,
    rawGarmentPositions: rawGarment, garmentPositions: garment.positions,
    influences, vertexGroups, history: [...fit.history, ...garment.history],
    diagnostics: {
      before: diagnoseMesh({ positions: rawGarment, indices: sourceGarment.indices }, body),
      source: diagnoseMesh(sourceGarment,sourceCage),
      after: garment.diagnostics,
      cage: fit.diagnostics,
      stretch: deformationDiagnostics(sourceGarment.positions, garment.positions, sourceGarment.indices),
      topology: { vertexCount: sourceCage.positions.length / 3, triangleCount: sourceCage.indices.length / 3, preserved: true },
    },
  };
}

export const prepareDemo = createDemoFit;

/**
 * Garment-first workflow: an independently modeled R15 garment already fits its
 * mannequin. Bind it to a retargeted official cage, preserving the source cloth,
 * then drive proportion and pose changes exclusively through cage coordinates.
 */
export function createR15GarmentFit(cageAsset,garmentAsset,bodyAsset,options={}) {
  const sourceCage=prepareCage(cageAsset.inner||cageAsset),parts=bodyAsset.parts||bodyAsset;
  const bodyMesh=mergeBodyParts(parts),body=createSurface(bodyMesh);
  const targetSeed=options.initialization==='heuristic'?null:options.targetSeed||cageAsset.targetSeed||bodyAsset.cageTargetSeed;
  if(targetSeed&&(targetSeed.positions?.length!==sourceCage.positions.length||targetSeed.influences?.length!==sourceCage.positions.length/3))throw new Error('Canonical UV target seed does not match the standard cage vertex count.');
  const innerPositions=targetSeed?Float32Array.from(targetSeed.positions):initializeR15Cage(sourceCage,parts,{smoothHips:options.smoothHips});
  const initialCageDiagnostics=diagnoseMesh({positions:innerPositions,indices:sourceCage.indices},body,{robust:true});
  let vertexSurfaces=null,triangleSurfaces=null;
  if(options.projectionMode==='regional') {
    const bounds=meshBounds(sourceCage.positions),surfaceCache=new Map();
    const groups=Array.from({length:sourceCage.positions.length/3},(_,i)=>sourceRegion(xyz(sourceCage.positions,i),bounds));
    const forGroups=names=> {
      const unique=[...new Set(names)].sort(),key=unique.join('|');
      if(!surfaceCache.has(key))surfaceCache.set(key,createSurface(mergeBodyParts(parts.filter(part=>unique.includes(part.name)))));
      return surfaceCache.get(key);
    };
    vertexSurfaces=groups.map(forGroups);
    triangleSurfaces=Array.from({length:sourceCage.indices.length/3},(_,i)=>forGroups([0,1,2].flatMap(j=>groups[sourceCage.indices[i*3+j]])));
  }
  // Resolve the zero-width armpit corridor at the cage level. R15's separate
  // block parts touch: choosing the inner arm's -x face would enter the torso.
  // A fixed front/back exit keeps that correspondence on the external union.
  for(let step=0;step<(options.cageProjectionIterations??(targetSeed?0:3));step++) {
    for(let i=0;i<innerPositions.length/3;i++) {
      const p=xyz(innerPositions,i);
      const collider=vertexSurfaces?.[i]||body;
      if(collider.distance(p).signed<.025)write(innerPositions,i,collider.project(p,.035,[0,0,p[2]>=0?1:-1]));
    }
    projectTriangleCollisions(innerPositions,sourceCage.indices,body,{clearance:.015,relaxation:.55,sampleEdges:true,triangleSurfaces});
  }
  const influences=targetSeed?targetSeed.influences.map(weights=>weights.map(weight=>({...weight}))):assignCageInfluences(sourceCage,innerPositions,parts);
  const triangleGroups=[];
  for(let i=0;i<sourceCage.indices.length;i+=3) {
    const votes=new Map();
    for(let j=0;j<3;j++)for(const weight of influences[sourceCage.indices[i+j]])votes.set(weight.name,(votes.get(weight.name)||0)+weight.weight);
    triangleGroups.push([...votes].sort((a,b)=>b[1]-a[1])[0][0]);
  }
  const fittedInner={...sourceCage,positions:innerPositions,triangleGroups};
  const sourceGarment={...garmentAsset,positions:Float32Array.from(garmentAsset.positions),indices:Uint32Array.from(garmentAsset.indices)};
  const vertexGroups=garmentAsset.vertexGroups||garmentAsset.vertexParts?.map(name=>Array.isArray(name)?name:[name]);
  const bindings=options.bindingMode==='surface'
    ?bindToCage(sourceGarment.positions,fittedInner,{neighbors:4,vertexGroups,normalScale:false})
    :bindMls(sourceGarment.positions,innerPositions,{
      vertexGroups,influences,neighbors:32,
      joints:bodyAsset.joints,
      garmentIndices:sourceGarment.indices,
      pairedVertexOffset:garmentAsset.stats?.outsideVertexCount,
      seamBlend:{graph:true,torsoStart:.9,armEnd:1.2,graphRings:6,graphIterations:24},
    });
  const garmentPositions=deformWithCage(bindings,innerPositions);
  const garmentSurface=createSurface({positions:garmentPositions,indices:sourceGarment.indices});
  const partNames=new Set(parts.map(part=>part.name)),jointByNode=new Map((bodyAsset.joints||[]).map(joint=>[joint.nodeIndex,joint]));
  const neighborsByPart=new Map(parts.map(part=>[part.name,new Set()]));
  for(const joint of bodyAsset.joints||[]) {
    const parent=jointByNode.get(joint.parentNodeIndex);
    if(parent&&partNames.has(joint.name)&&partNames.has(parent.name)) {
      neighborsByPart.get(joint.name).add(parent.name);neighborsByPart.get(parent.name).add(joint.name);
    }
  }
  const outerInfluence=Float32Array.from(influences.map((weights,i)=> {
    const nearest=garmentSurface.closest(xyz(innerPositions,i)),proximity=Math.sqrt(nearest.distance2);
    if(proximity>=.32)return 0;
    const owners=new Set(nearest.triangle.ids.flatMap(id=>vertexGroups?.[id]||[]));
    const related=owners.size?weights.reduce((sum,weight)=> {
      const owned=owners.has(weight.name),adjacent=[...(neighborsByPart.get(weight.name)||[])].some(name=>owners.has(name));
      return sum+weight.weight*(owned?1:adjacent?0.5:0);
    },0):1;
    if(related===0)return 0;
    return related*(1-smoothstep(.10,.32,proximity));
  }));
  const outer=fitOuterCage(fittedInner,{positions:garmentPositions,indices:sourceGarment.indices},{thickness:.045,maximumExpansion:.60,iterations:12,influence:outerInfluence});
  // Outer cages describe the clothed surface. Transfer its local material skin
  // field from the garment, while the inner cage retains the avatar's field.
  // This never drives garment geometry directly; garment poses still use MLS.
  const normalizeWeights=map=> {
    const entries=[...map].filter(([,weight])=>weight>1e-8).sort((a,b)=>b[1]-a[1]).slice(0,4);
    const sum=entries.reduce((total,[,weight])=>total+weight,0);
    return entries.map(([name,weight])=>({name,weight:weight/sum}));
  };
  const garmentInfluences=bindings.vertices.map((records,i)=> {
    const region=bindings.regionWeights?.[i];
    if(region?.length)return region.map(weight=>({...weight}));
    const map=new Map();
    for(const record of records) {
      const controls=record.id!==undefined?[[record.id,record.weight]]:record.ids.map((id,j)=>[id,record.weight*record.bary[j]]);
      for(const[id,coefficient]of controls)for(const weight of influences[id])map.set(weight.name,(map.get(weight.name)||0)+coefficient*weight.weight);
    }
    return normalizeWeights(map);
  });
  const outerInfluences=influences.map((weights,i)=> {
    if(outerInfluence[i]<=0||options.transferOuterSkin===false)return weights.map(weight=>({...weight}));
    const nearest=garmentSurface.closest(xyz(outer.positions,i)),map=new Map();
    for(let j=0;j<3;j++)for(const weight of garmentInfluences[nearest.triangle.ids[j]])map.set(weight.name,(map.get(weight.name)||0)+nearest.bary[j]*weight.weight);
    return map.size?normalizeWeights(map):weights.map(weight=>({...weight}));
  });
  const before=diagnoseMesh(sourceGarment,body,{robust:true}),after=diagnoseMesh({positions:garmentPositions,indices:sourceGarment.indices},body,{robust:true});
  return {
    sourceCage,sourceGarment,bindings,bodyMesh,body,innerPositions,outerPositions:outer.positions,
    garmentPositions,rawGarmentPositions:Float32Array.from(sourceGarment.positions),influences,outerInfluences,garmentInfluences,vertexGroups,triangleGroups,outerInfluence,
    history:[],initialization:targetSeed?'canonical-uv-target':'heuristic',targetSeedProvenance:targetSeed?.provenance||null,
    diagnostics:{before,after,cageBefore:initialCageDiagnostics,cage:diagnoseMesh(fittedInner,body,{robust:true}),stretch:deformationDiagnostics(sourceGarment.positions,garmentPositions,sourceGarment.indices),topology:{vertexCount:innerPositions.length/3,triangleCount:sourceCage.indices.length/3,preserved:true},targetSeed:targetSeed?{matched:targetSeed.diagnostics?.matchedVertexCount??1358-(targetSeed.fallbackVertexIds?.length||0),fallbackVertexIds:targetSeed.fallbackVertexIds||[]}:null},
  };
}
