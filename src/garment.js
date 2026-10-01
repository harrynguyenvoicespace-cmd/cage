/** Independent T-shirt authored around BloxLab's actual R15 body dimensions.
 * No cage points or cage topology are used to construct this mesh.
 */
const length = (v) => Math.hypot(v[0], v[1], v[2]);
const normalize = (v) => { const l = length(v) || 1; return v.map((x) => x / l); };
const subtract = (a, b) => a.map((x, i) => x - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const smoothMin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };

function roundedBox(p, min, max, radius) {
  const q = p.map((v, i) => Math.abs(v - (min[i] + max[i]) * 0.5) - (max[i] - min[i]) * 0.5 + radius);
  return Math.hypot(...q.map((v) => Math.max(v, 0))) + Math.min(Math.max(...q), 0) - radius;
}

function surface(field, min, max, step) {
  const dims = min.map((v, i) => Math.ceil((max[i] - v) / step));
  const spacing = min.map((v, i) => (max[i] - v) / dims[i]);
  const sx = dims[0] + 1, sy = dims[1] + 1;
  const id = (x, y, z) => x + sx * (y + sy * z);
  const samples = new Float64Array(sx * sy * (dims[2] + 1));
  const point = (x, y, z) => [min[0] + x * spacing[0], min[1] + y * spacing[1], min[2] + z * spacing[2]];
  for (let z = 0; z <= dims[2]; z++) for (let y = 0; y <= dims[1]; y++) for (let x = 0; x <= dims[0]; x++) samples[id(x, y, z)] = field(point(x, y, z));
  const vertices = [], faces = [], edgeVertices = new Map();
  const corner = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const tetrahedra = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]];
  const tetraEdges = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
  const gradient = (p) => normalize([0, 1, 2].map((axis) => { const a = [...p], b = [...p]; a[axis] += 0.001; b[axis] -= 0.001; return field(a) - field(b); }));
  for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
    const ids = corner.map(([cx, cy, cz]) => id(x + cx, y + cy, z + cz));
    if (ids.every((i) => samples[i] > 0) || ids.every((i) => samples[i] < 0)) continue;
    const points = corner.map(([cx, cy, cz]) => point(x + cx, y + cy, z + cz));
    for (const tet of tetrahedra) {
      const polygon = [];
      for (const [ea, eb] of tetraEdges) {
        const a = tet[ea], b = tet[eb], fa = samples[ids[a]], fb = samples[ids[b]];
        if ((fa < 0) === (fb < 0)) continue;
        const key = ids[a] < ids[b] ? `${ids[a]}:${ids[b]}` : `${ids[b]}:${ids[a]}`;
        let vertex = edgeVertices.get(key);
        if (vertex === undefined) {
          const t = fa / (fa - fb);
          vertex = vertices.length;
          vertices.push(points[a].map((v, i) => v + (points[b][i] - v) * t));
          edgeVertices.set(key, vertex);
        }
        polygon.push(vertex);
      }
      if (polygon.length < 3) continue;
      const center = [0, 1, 2].map((axis) => polygon.reduce((s, i) => s + vertices[i][axis], 0) / polygon.length);
      const normal = gradient(center), u = normalize(subtract(vertices[polygon[0]], center)), v = cross(normal, u);
      polygon.sort((a, b) => Math.atan2(dot(subtract(vertices[a], center), v), dot(subtract(vertices[a], center), u)) - Math.atan2(dot(subtract(vertices[b], center), v), dot(subtract(vertices[b], center), u)));
      for (let i = 1; i < polygon.length - 1; i++) {
        const triangle = [polygon[0], polygon[i], polygon[i + 1]];
        const n = cross(subtract(vertices[triangle[1]], vertices[triangle[0]]), subtract(vertices[triangle[2]], vertices[triangle[0]]));
        if (dot(n, normal) < 0) triangle.reverse();
        if (length(n) > 1e-10) faces.push(triangle);
      }
    }
  }
  return { vertices, faces };
}

function cutSurface(mesh, cuts) {
  const { vertices } = mesh;
  let faces = mesh.faces;
  cuts.forEach((field, cut) => {
    const edgeMap = new Map(), next = [];
    for (const face of faces) {
      const polygon = [];
      for (let i = 0; i < face.length; i++) {
        const a = face[i], b = face[(i + 1) % face.length], fa = field(vertices[a]), fb = field(vertices[b]);
        if (fa >= 0) polygon.push(a);
        if ((fa >= 0) !== (fb >= 0)) {
          const key = a < b ? `${a}:${b}` : `${b}:${a}`;
          let index = edgeMap.get(key);
          if (index === undefined) {
            let low = 0, high = 1;
            for (let pass = 0; pass < 22; pass++) {
              const t = (low + high) * 0.5, p = vertices[a].map((v, axis) => v + (vertices[b][axis] - v) * t);
              if ((field(p) >= 0) === (fa >= 0)) low = t; else high = t;
            }
            const t = (low + high) * 0.5;
            index = vertices.length; vertices.push(vertices[a].map((v, axis) => v + (vertices[b][axis] - v) * t)); edgeMap.set(key, index);
          }
          polygon.push(index);
        }
      }
      for (let i = 1; i < polygon.length - 1; i++) {
        const tri = [polygon[0], polygon[i], polygon[i + 1]];
        if (length(cross(subtract(vertices[tri[1]], vertices[tri[0]]), subtract(vertices[tri[2]], vertices[tri[0]]))) > 1e-10) next.push(tri);
      }
    }
    faces = next;
  });
  return { vertices, faces };
}

function compact(mesh) {
  const used = new Map(), vertices = [], faces = mesh.faces.map((face) => face.map((index) => {
    if (!used.has(index)) { used.set(index, vertices.length); vertices.push(mesh.vertices[index]); }
    return used.get(index);
  }));
  return { vertices, faces };
}

// Remove only interior points whose entire one-ring is in the same plane.
// This retains rounded shoulders, all openings and the boundary vertex order.
function reducePlanar(mesh) {
  const { vertices } = mesh, faces = mesh.faces.map((f) => [...f]);
  const alive = faces.map(() => true), incident = vertices.map(() => new Set());
  const normals = [];
  const addNormal = (face) => normalize(cross(subtract(vertices[face[1]], vertices[face[0]]), subtract(vertices[face[2]], vertices[face[0]])));
  faces.forEach((face, i) => { normals[i] = addNormal(face); face.forEach((v) => incident[v].add(i)); });
  const order = vertices.map((_, i) => i).sort((a, b) => (((a * 2654435761) >>> 0) - ((b * 2654435761) >>> 0)));
  for (let pass = 0; pass < 2; pass++) for (const vertex of order) {
    const ringFaces = [...incident[vertex]].filter((i) => alive[i]);
    if (ringFaces.length < 3 || ringFaces.length > 20) continue;
    const normal = normals[ringFaces[0]];
    if (ringFaces.some((i) => dot(normal, normals[i]) < 0.999999)) continue;
    const links = new Map(); let valid = true;
    for (const i of ringFaces) {
      const face = faces[i], index = face.indexOf(vertex), a = face[(index + 1) % 3], b = face[(index + 2) % 3];
      if (links.has(a)) { valid = false; break; } links.set(a, b);
      if (Math.abs(dot(subtract(vertices[a], vertices[vertex]), normal)) > 0.000002) valid = false;
    }
    if (!valid) continue;
    const first = links.keys().next().value, ring = [first]; let next = links.get(first);
    while (next !== first && next !== undefined && ring.length <= links.size) { ring.push(next); next = links.get(next); }
    if (next !== first || ring.length !== links.size) continue;
    let replacement = null, best = -Infinity;
    for (let root = 0; root < ring.length; root++) {
      const rotated = [...ring.slice(root), ...ring.slice(0, root)], triangles = []; let minimumArea = Infinity;
      for (let i = 1; i < rotated.length - 1; i++) {
        const tri = [rotated[0], rotated[i], rotated[i + 1]];
        const area = dot(cross(subtract(vertices[tri[1]], vertices[tri[0]]), subtract(vertices[tri[2]], vertices[tri[0]])), normal);
        if (area < 1e-10) { minimumArea = -Infinity; break; }
        minimumArea = Math.min(minimumArea, area); triangles.push(tri);
      }
      if (minimumArea > best) { best = minimumArea; replacement = triangles; }
    }
    if (!replacement || best === -Infinity) continue;
    ringFaces.forEach((i) => { alive[i] = false; faces[i].forEach((v) => incident[v].delete(i)); });
    replacement.forEach((face) => { const i = faces.length; faces.push(face); alive.push(true); normals.push(addNormal(face)); face.forEach((v) => incident[v].add(i)); });
  }
  return compact({ vertices, faces: faces.filter((_, i) => alive[i]) });
}

function addShell(mesh, thickness) {
  const { vertices, faces } = compact(mesh), normals = vertices.map(() => [0, 0, 0]), edgeMap = new Map();
  for (const face of faces) {
    const normal = cross(subtract(vertices[face[1]], vertices[face[0]]), subtract(vertices[face[2]], vertices[face[0]]));
    face.forEach((i) => normal.forEach((v, axis) => { normals[i][axis] += v; }));
    for (let i = 0; i < 3; i++) {
      const a = face[i], b = face[(i + 1) % 3], key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (edgeMap.has(key)) edgeMap.delete(key); else edgeMap.set(key, [a, b]);
    }
  }
  const count = vertices.length;
  normals.forEach((n, i) => { const normal = normalize(n); vertices.push(vertices[i].map((v, axis) => v - normal[axis] * thickness)); });
  const outFaces = [...faces, ...faces.map(([a, b, c]) => [c + count, b + count, a + count])];
  for (const [a, b] of edgeMap.values()) outFaces.push([b, a, a + count], [b, a + count, b + count]);
  return { vertices, faces: outFaces, boundaryEdges: edgeMap.size, outsideVertexCount: count };
}

export function createR15Shirt(bodyAsset, { resolution = 0.28, thickness = 0.035 } = {}) {
  const body = Object.fromEntries(bodyAsset.parts.map((part) => [part.name, part]));
  const torso = body.UpperTorso.bounds, lower = body.LowerTorso.bounds;
  const side = Math.max(Math.abs(torso.min[0]), Math.abs(torso.max[0]));
  const depth = Math.max(Math.abs(torso.min[2]), Math.abs(torso.max[2]));
  const top = torso.max[1] + 0.105;
  const hem = lower.min[1] + 0.12;
  // End the sleeve above the full lower-arm overlap, leaving room for elbow
  // sweep when the cage is animated. R15 mesh parts overlap around this joint.
  const cuff = Math.max(body.LeftLowerArm.bounds.max[1], body.RightLowerArm.bounds.max[1]) + 0.12;
  const outerTorsoMin = [-side - 0.115, hem - 0.14, -depth - 0.115];
  const outerTorsoMax = [side + 0.115, top, depth + 0.115];
  const sleeves = ['LeftUpperArm', 'RightUpperArm'].map((name) => {
    const bounds = body[name].bounds;
    return { name, min: [bounds.min[0] - 0.115, cuff - 0.14, -depth - 0.115], max: [bounds.max[0] + 0.115, top, depth + 0.115] };
  });
  const field = (p) => sleeves.reduce((distance, sleeve) => smoothMin(distance, roundedBox(p, sleeve.min, sleeve.max, 0.12), 0.13), roundedBox(p, outerTorsoMin, outerTorsoMax, 0.12));
  const min = [sleeves[0].min[0] - 0.05, outerTorsoMin[1] - 0.05, outerTorsoMin[2] - 0.05];
  const max = [sleeves[1].max[0] + 0.05, top + 0.05, outerTorsoMax[2] + 0.05];
  // A blocky R15 head is almost full-width at its lower edge. Lower the neck
  // front/back below that edge and leave a wider, rounded shoulder opening.
  const collarX = 0.70, collarZ = 0.70, neckline = body.Head.bounds.min[1] - 0.07;
  const raw = surface(field, min, max, resolution);
  // Linear interpolation of a coarse grid cuts rounded corners inward. Refine
  // each extracted point on the analytic garment surface before making seams.
  raw.vertices.forEach((p) => {
    for (let pass = 0; pass < 8; pass++) {
      const distance = field(p);
      if (Math.abs(distance) < 0.0000001) break;
      const gradient = [0, 1, 2].map((axis) => { const a = [...p], b = [...p]; a[axis] += 0.0005; b[axis] -= 0.0005; return (field(a) - field(b)) / 0.001; });
      const scale = distance / (dot(gradient, gradient) || 1);
      gradient.forEach((v, axis) => { p[axis] -= v * scale; });
    }
  });
  const clipped = cutSurface(raw, [
    (p) => p[1] - hem,
    (p) => Math.max((Math.abs(p[0] / collarX) ** 8 + Math.abs(p[2] / collarZ) ** 8) ** (1 / 8) - 1, neckline - p[1]),
    (p) => Math.max(side + 0.155 - Math.abs(p[0]), p[1] - cuff),
    // In this exact R15 rest pose the forearms and torso share a boundary at
    // x=±1. A narrow sewn side vent avoids placing cloth inside those arms.
    (p) => Math.max(p[1] - cuff - 0.025, side - 0.09 - Math.abs(p[0]), Math.abs(p[2]) - depth - 0.095),
  ]);
  const reduced = reducePlanar(compact(clipped));
  const shell = addShell(reduced, thickness);
  const positions = shell.vertices.flat(), indices = shell.faces.flat(), uv = [], vertexGroups = [], vertexParts = [];
  shell.vertices.forEach(([x, y, z]) => {
    const arm = x < 0 ? 'LeftUpperArm' : 'RightUpperArm';
    const dominant = Math.abs(x) > side + 0.12 && y > cuff - 0.07 ? arm : y < torso.min[1] + 0.05 ? 'LowerTorso' : 'UpperTorso';
    const group = dominant.includes('Arm') ? [arm] : [dominant];
    if (Math.abs(x) > side - 0.18 && Math.abs(x) < side + 0.32 && y > cuff - 0.07) group.push(dominant.includes('Arm') ? 'UpperTorso' : arm);
    vertexParts.push(dominant); vertexGroups.push(group);
    uv.push((x / (max[0] - min[0]) + 0.5) * 0.95 + (z < 0 ? 0.025 : 0), (y - hem) / (top - hem));
  });
  return {
    schemaVersion: 1, name: 'CageLab_R15_TShirt', positions, indices, uv, vertexGroups, vertexParts,
    source: { kind: 'independent-parametric-garment', authoredAgainst: bodyAsset.source.file, method: 'Rounded signed-distance torso and sleeve union; trimmed neck, hem and cuffs; narrow underarm vents for touching R15 rest limbs; inward shell and sewn rims. No cage vertices used.' },
    design: { resolution, thickness, hem, cuff, top, neckline, collarRadii: [collarX, collarZ], bodyClearance: 0.08, underarmVents: true },
    stats: { vertexCount: positions.length / 3, triangleCount: indices.length / 3, outsideVertexCount: shell.outsideVertexCount, rimEdges: shell.boundaryEdges },
  };
}

export default createR15Shirt;

/** Geometry recipes share the same implicit surface, clipping, planar
 * reduction, shell and rim construction. Parameters describe clothes, never
 * the cage fitting algorithm. The previously tested short tee is preserved. */
export const GARMENT_STYLES = {
  'short-shirt': { name: 'CageLab_R15_TShirt', label: 'Áo ngắn tay', sleeve: 'short', padding: .115, depthPadding: .115, radius: .12, shoulderBlend: .13, topEase: .105, hemEase: .12, collarX: .70, collarZ: .70, frontGap: 0, resolution: .28 },
  'long-shirt': { name: 'CageLab_R15_LongShirt', label: 'Áo dài tay', sleeve: 'long', padding: .115, depthPadding: .115, radius: .12, shoulderBlend: .13, topEase: .105, hemEase: .12, collarX: .70, collarZ: .70, frontGap: 0, resolution: .30 },
  'wide-sweater': { name: 'CageLab_R15_WideSweater', label: 'Sweater rộng', sleeve: 'long', padding: .20, depthPadding: .18, radius: .18, shoulderBlend: .22, topEase: .13, hemEase: .10, collarX: .73, collarZ: .73, frontGap: 0, resolution: .32 },
  jacket: { name: 'CageLab_R15_OpenJacket', label: 'Jacket mở phía trước', sleeve: 'long', padding: .15, depthPadding: .15, radius: .145, shoulderBlend: .17, topEase: .12, hemEase: .08, collarX: .72, collarZ: .72, frontGap: .21, resolution: .31 },
};

export function createR15Garment(bodyAsset, { style = 'short-shirt', thickness = .035, resolution = null, ...geometry } = {}) {
  const recipe = GARMENT_STYLES[style];
  if (!recipe) throw new Error(`Unknown independent garment style: ${style}`);
  // Do not change the reference tee used in the earlier proof. Its exact JSON
  // can remain in assets while this factory reproduces that original geometry.
  if (style === 'short-shirt') return createR15Shirt(bodyAsset, { thickness, resolution: resolution ?? recipe.resolution });
  const config = { ...recipe, ...geometry, thickness, resolution: resolution ?? recipe.resolution };
  const body = Object.fromEntries(bodyAsset.parts.map(part => [part.name, part]));
  const torso = body.UpperTorso.bounds, lower = body.LowerTorso.bounds;
  const side = Math.max(Math.abs(torso.min[0]), Math.abs(torso.max[0]));
  const depth = Math.max(Math.abs(torso.min[2]), Math.abs(torso.max[2]));
  const top = torso.max[1] + config.topEase, hem = lower.min[1] + config.hemEase;
  const cuff = Math.max(body.LeftHand.bounds.max[1], body.RightHand.bounds.max[1]) + .12;
  const outerTorsoMin = [-side - config.padding, hem - .14, -depth - config.depthPadding];
  const outerTorsoMax = [side + config.padding, top, depth + config.depthPadding];
  const sleeves = ['Left', 'Right'].map(sideName => {
    const upper = body[`${sideName}UpperArm`].bounds, forearm = body[`${sideName}LowerArm`].bounds;
    return {
      side: sideName,
      min: [Math.min(upper.min[0], forearm.min[0]) - config.padding, cuff - .14, -depth - config.depthPadding],
      max: [Math.max(upper.max[0], forearm.max[0]) + config.padding, top, depth + config.depthPadding],
    };
  });
  const field = p => sleeves.reduce((distance, sleeve) => smoothMin(distance, roundedBox(p, sleeve.min, sleeve.max, config.radius), config.shoulderBlend), roundedBox(p, outerTorsoMin, outerTorsoMax, config.radius));
  const min = [sleeves[0].min[0] - .05, outerTorsoMin[1] - .05, outerTorsoMin[2] - .05];
  const max = [sleeves[1].max[0] + .05, top + .05, outerTorsoMax[2] + .05];
  const raw = surface(field, min, max, config.resolution);
  raw.vertices.forEach(p => {
    for (let pass = 0; pass < 8; pass++) {
      const distance = field(p);
      if (Math.abs(distance) < 1e-7) break;
      const gradient = [0, 1, 2].map(axis => { const a = [...p], b = [...p]; a[axis] += .0005; b[axis] -= .0005; return (field(a) - field(b)) / .001; });
      const scale = distance / (dot(gradient, gradient) || 1);
      gradient.forEach((v, axis) => { p[axis] -= v * scale; });
    }
  });
  const neckline = body.Head.bounds.min[1] - .07;
  const cuts = [
    p => p[1] - hem,
    p => Math.max((Math.abs(p[0] / config.collarX) ** 8 + Math.abs(p[2] / config.collarZ) ** 8) ** (1 / 8) - 1, neckline - p[1]),
    p => Math.max(side + .155 - Math.abs(p[0]), p[1] - cuff),
    // The wrist ends above the hand, and a sewn side vent below it avoids the
    // touching torso/hand volumes of this reference R15 rest pose.
    p => Math.max(p[1] - cuff - .025, side - .09 - Math.abs(p[0]), Math.abs(p[2]) - depth - config.depthPadding + .020),
  ];
  if (config.frontGap > 0) cuts.push(p => Math.max(Math.abs(p[0]) - config.frontGap, p[2] + .015));
  const reduced = reducePlanar(compact(cutSurface(raw, cuts))), shell = addShell(reduced, thickness);
  const positions = shell.vertices.flat(), indices = shell.faces.flat(), uv = [], vertexGroups = [], vertexParts = [];
  const elbow = Object.fromEntries(['Left', 'Right'].map(name => [name, bodyAsset.joints.find(joint => joint.name === `${name}LowerArm`)?.position[1] ?? 3.035]));
  shell.vertices.forEach(([x, y, z]) => {
    const sideName = x < 0 ? 'Left' : 'Right', upperName = `${sideName}UpperArm`, lowerName = `${sideName}LowerArm`;
    const armName = y < elbow[sideName] ? lowerName : upperName;
    const torsoName = y < torso.min[1] + .05 ? 'LowerTorso' : 'UpperTorso';
    const inSleeve = Math.abs(x) > side + .12 && y > cuff - .07;
    const dominant = inSleeve ? armName : torsoName;
    const group = [dominant];
    if (inSleeve && Math.abs(y - elbow[sideName]) < .16) group.push(armName === upperName ? lowerName : upperName);
    if (Math.abs(x) > side - .18 && Math.abs(x) < side + .32 && y > cuff - .07) {
      if (!group.includes(torsoName)) group.push(torsoName);
      if (!group.includes(armName)) group.push(armName);
      if (Math.abs(y - elbow[sideName]) < .16) { if (!group.includes(upperName)) group.push(upperName); if (!group.includes(lowerName)) group.push(lowerName); }
    }
    vertexParts.push(dominant); vertexGroups.push(group);
    uv.push((x / (max[0] - min[0]) + .5) * .95 + (z < 0 ? .025 : 0), (y - hem) / (top - hem));
  });
  return {
    schemaVersion: 1, name: config.name, style, label: config.label, positions, indices, uv, vertexGroups, vertexParts,
    source: { kind: 'independent-parametric-garment', authoredAgainst: bodyAsset.source.file, method: 'Shared rounded implicit torso and sleeve union; neck, hem, cuffs and optional open-front cuts; inward fabric shell with sewn rims. No cage positions or topology used.' },
    design: { style, resolution: config.resolution, thickness, hem, cuff, top, neckline, collarRadii: [config.collarX, config.collarZ], padding: config.padding, depthPadding: config.depthPadding, shoulderBlend: config.shoulderBlend, frontGap: config.frontGap, handGap: .12, sleeve: config.sleeve, underarmVents: true },
    stats: { vertexCount: positions.length / 3, triangleCount: indices.length / 3, outsideVertexCount: shell.outsideVertexCount, rimEdges: shell.boundaryEdges },
  };
}
