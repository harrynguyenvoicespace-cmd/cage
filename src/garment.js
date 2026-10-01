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
  'longline-shirt': { name: 'CageLab_R15_LonglineShirt', label: 'Áo dài thân', sleeve: 'long', padding: .14, depthPadding: .17, radius: .14, shoulderBlend: .16, topEase: .12, hemEase: -.28, collarX: .71, collarZ: .71, frontGap: 0, resolution: .34 },
  'hoodie-classic': { name: 'CageLab_R15_ClassicHoodie', label: 'Hoodie cổ điển', sleeve: 'long', padding: .16, depthPadding: .16, radius: .15, shoulderBlend: .18, topEase: .13, hemEase: .08, collarX: .72, collarZ: .72, frontGap: 0, hood: 'down', pocket: 'kangaroo', resolution: .34 },
  'hoodie-oversized': { name: 'CageLab_R15_OversizedHoodie', label: 'Hoodie oversized', sleeve: 'long', padding: .25, depthPadding: .23, radius: .20, shoulderBlend: .25, topEase: .17, hemEase: -.12, collarX: .75, collarZ: .75, frontGap: 0, hood: 'down', hoodScale: 1.12, pocket: 'kangaroo', resolution: .37 },
  'hoodie-up': { name: 'CageLab_R15_RaisedHoodie', label: 'Hoodie đội mũ', sleeve: 'long', padding: .17, depthPadding: .17, radius: .16, shoulderBlend: .19, topEase: .13, hemEase: .08, collarX: .73, collarZ: .73, frontGap: 0, hood: 'up', pocket: 'kangaroo', resolution: .36 },
  'hoodie-zip': { name: 'CageLab_R15_ZipHoodie', label: 'Hoodie khóa kéo', sleeve: 'long', padding: .17, depthPadding: .17, radius: .16, shoulderBlend: .19, topEase: .13, hemEase: .06, collarX: .72, collarZ: .72, frontGap: .055, hood: 'down', pocket: 'split', resolution: .35 },
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
  const garment = {
    schemaVersion: 1, name: config.name, style, label: config.label, positions, indices, uv, vertexGroups, vertexParts,
    source: { kind: 'independent-parametric-garment', authoredAgainst: bodyAsset.source.file, method: 'Shared rounded implicit torso and sleeve union; neck, hem, cuffs and optional open-front cuts; inward fabric shell with sewn rims. No cage positions or topology used.' },
    design: { style, resolution: config.resolution, thickness, hem, cuff, top, neckline, collarRadii: [config.collarX, config.collarZ], padding: config.padding, depthPadding: config.depthPadding, shoulderBlend: config.shoulderBlend, frontGap: config.frontGap, handGap: .12, sleeve: config.sleeve, underarmVents: true },
    stats: { vertexCount: positions.length / 3, triangleCount: indices.length / 3, outsideVertexCount: shell.outsideVertexCount, rimEdges: shell.boundaryEdges },
  };
  if (config.hood) return addHoodieDetails(garment, bodyAsset, config);
  if (style === 'longline-shirt') {
    // Both faces of a fabric vertex share a texture coordinate and region.
    // Retain earlier recipes byte-for-byte while keeping new shells paired.
    const count = shell.outsideVertexCount;
    garment.uv = [...uv.slice(0, count * 2), ...uv.slice(0, count * 2)];
    garment.vertexGroups = [...vertexGroups.slice(0, count), ...vertexGroups.slice(0, count).map(group => [...group])];
    garment.vertexParts = [...vertexParts.slice(0, count), ...vertexParts.slice(0, count)];
  }
  return garment;
}

/** Detail panels are authored from avatar measurements like the main cloth.
 * Each panel has its own inward shell and sewn rim. Merging preserves the
 * global outer/inner vertex pairing used by the common cage binding. */
function addHoodieDetails(garment, bodyAsset, config) {
  const body = Object.fromEntries(bodyAsset.parts.map(part => [part.name, part]));
  const { top, hem, cuff, neckline } = garment.design;
  const torso = body.UpperTorso.bounds, head = body.Head.bounds;
  const depth = Math.max(Math.abs(torso.min[2]), Math.abs(torso.max[2]));
  const side = Math.max(Math.abs(torso.min[0]), Math.abs(torso.max[0]));
  const clothDepth = depth + config.depthPadding;
  const components = [{
    shell: { vertices: Array.from({ length: garment.stats.vertexCount }, (_, i) => garment.positions.slice(i * 3, i * 3 + 3)), faces: Array.from({ length: garment.stats.triangleCount }, (_, i) => garment.indices.slice(i * 3, i * 3 + 3)), outsideVertexCount: garment.stats.outsideVertexCount, boundaryEdges: garment.stats.rimEdges },
    groups: [...garment.vertexGroups.slice(0, garment.stats.outsideVertexCount), ...garment.vertexGroups.slice(0, garment.stats.outsideVertexCount).map(group => [...group])],
    parts: [...garment.vertexParts.slice(0, garment.stats.outsideVertexCount), ...garment.vertexParts.slice(0, garment.stats.outsideVertexCount)],
    uv: [...garment.uv.slice(0, garment.stats.outsideVertexCount * 2), ...garment.uv.slice(0, garment.stats.outsideVertexCount * 2)],
    name: 'body-and-sleeves', thickness: config.thickness,
  }];
  const add = (name, mesh, groups, thickness = config.thickness) => {
    const shell = addShell(compact(mesh), thickness);
    const outerGroups = shell.vertices.slice(0, shell.outsideVertexCount).map(p => typeof groups === 'function' ? groups(p) : [...groups]);
    const vertexGroups = [...outerGroups, ...outerGroups.map(group => [...group])];
    const outerUV = shell.vertices.slice(0, shell.outsideVertexCount).flatMap(([x, y]) => [.5 + x / 5, (y - hem) / (head.max[1] + .25 - hem)]);
    components.push({ name, shell, groups: vertexGroups, parts: vertexGroups.map(group => group[0]), uv: [...outerUV, ...outerUV], thickness });
  };
  // Raised hoods retain their real open face and lower neck opening. A lowered
  // hood is a hollow folded pouch behind the neck, with an open upper rim.
  const scale = config.hoodScale ?? 1;
  const hoodMin = config.hood === 'up' ? [-.81, neckline - .10, -.81] : [-.82 * scale, top - .82 * scale, clothDepth - .015];
  const hoodMax = config.hood === 'up' ? [.81, head.max[1] + .20, .81] : [.82 * scale, top + .07, clothDepth + .61 * scale];
  const hoodRadius = config.hood === 'up' ? .21 : .23 * scale;
  const hoodField = p => roundedBox(p, hoodMin, hoodMax, hoodRadius);
  const hoodRaw = surface(hoodField, hoodMin.map(v => v - .025), hoodMax.map(v => v + .025), config.resolution * 1.03);
  refineSurface(hoodRaw, hoodField);
  const hoodCuts = config.hood === 'up' ? [
    p => p[1] - torso.max[1] - .045,
    p => Math.max((Math.abs(p[0] / .675) ** 8 + Math.abs((p[1] - (head.min[1] + head.max[1]) * .5 + .055) / .755) ** 8) ** (1 / 8) - 1, p[2] + .20),
  ] : [p => top - .045 - p[1]];
  add('hood', reducePlanar(compact(cutSurface(hoodRaw, hoodCuts))), p => config.hood === 'up' ? p[1] < torso.max[1] + .22 ? ['Head', 'UpperTorso'] : ['Head'] : ['UpperTorso']);

  // Parametric grids make pockets and rib bands visibly raised without an
  // extra dense implicit grid. The front of this avatar faces negative Z.
  const panel = (point, columns = 8, rows = 3, front = true) => {
    const vertices = [], faces = [];
    for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) vertices.push(point(column / columns, row / rows));
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const a = row * (columns + 1) + column, b = a + 1, c = a + columns + 1, d = c + 1;
      faces.push(...(front ? [[a, c, b], [b, c, d]] : [[a, b, c], [b, d, c]]));
    }
    return { vertices, faces };
  };
  const pocketBottom = hem + .34, pocketTop = Math.min(hem + 1.00, top - .77);
  const pocket = (center, width) => panel((u, v) => {
    const taper = 1 - .28 * Math.max(0, (v - .6) / .4);
    return [center + (u * 2 - 1) * width * taper, pocketBottom + (pocketTop - pocketBottom) * v, -clothDepth - .065 - .04 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v)];
  }, config.pocket === 'split' ? 4 : 8, 3);
  if (config.pocket === 'split') {
    add('left-pocket', pocket(-.39, .28), ['UpperTorso']);
    add('right-pocket', pocket(.39, .28), ['UpperTorso']);
  } else add('kangaroo-pocket', pocket(0, .65 * (config.hoodScale ?? 1)), ['UpperTorso']);

  const tube = (centers, radius, segments = 6) => {
    const vertices = centers.flatMap(center => Array.from({ length: segments }, (_, i) => { const angle = i / segments * Math.PI * 2; return [center[0] + Math.cos(angle) * radius, center[1], center[2] + Math.sin(angle) * radius]; }));
    const faces = [];
    for (let row = 0; row < centers.length - 1; row++) for (let column = 0; column < segments; column++) {
      const a = row * segments + column, b = row * segments + (column + 1) % segments, c = a + segments, d = b + segments;
      faces.push([a, b, c], [b, d, c]);
    }
    return { vertices, faces };
  };
  for (const direction of [-1, 1]) {
    const cord = Array.from({ length: 4 }, (_, row) => { const t = row / 3; return [direction * (.25 + .035 * t + .024 * Math.sin(Math.PI * t)), top - .19 - .69 * t, -clothDepth - .105 - .008 * Math.sin(Math.PI * t)]; });
    add(`${direction < 0 ? 'left' : 'right'}-drawcord`, tube(cord, .021), ['UpperTorso'], Math.min(config.thickness, .007));
  }
  if (config.pocket === 'split') {
    const zipper = Array.from({ length: 5 }, (_, i) => [0, top - .28 - (top - hem - .43) * i / 4, -clothDepth - .026]);
    add('zipper', tube(zipper, .022, 4), ['UpperTorso'], Math.min(config.thickness, .008));
  }
  // R15 arms touch the torso at rest. Bands cover each visible cuff panel;
  // wrapping a full ring through that touching inner side would hit the body.
  for (const direction of [-1, 1]) {
    const sideName = direction < 0 ? 'Left' : 'Right';
    const arm = body[`${sideName}LowerArm`].bounds;
    const edge = Math.max(Math.abs(arm.min[0]), Math.abs(arm.max[0])) + config.padding;
    for (const front of [true, false]) add(`${sideName.toLowerCase()}-cuff-${front ? 'front' : 'back'}`, panel((u, v) => {
      const x = direction * (side + .18 + (edge - side - .22) * u);
      return [x, cuff + .04 + .12 * v, (front ? -1 : 1) * (clothDepth + .012 + .006 * Math.sin(u * Math.PI * 16) ** 2)];
    }, 8, 1, front !== (direction < 0)), [`${sideName}LowerArm`], Math.min(config.thickness, .012));
  }
  for (const front of [true, false]) add(`hem-${front ? 'front' : 'back'}`, panel((u, v) => [(u * 2 - 1) * (side - .12), hem + .025 + .125 * v, (front ? -1 : 1) * (clothDepth + .012 + .006 * Math.sin(u * Math.PI * 20) ** 2)], 10, 1, front), ['LowerTorso'], Math.min(config.thickness, .012));

  const outsideCount = components.reduce((sum, component) => sum + component.shell.outsideVertexCount, 0);
  const positions = [], indices = [], vertexGroups = [], vertexParts = [], uv = [];
  for (const inner of [false, true]) for (const component of components) {
    const count = component.shell.outsideVertexCount, begin = inner ? count : 0;
    positions.push(...component.shell.vertices.slice(begin, begin + count).flat());
    vertexGroups.push(...component.groups.slice(begin, begin + count));
    vertexParts.push(...component.parts.slice(begin, begin + count));
    uv.push(...component.uv.slice(begin * 2, (begin + count) * 2));
  }
  let outsideOffset = 0;
  const componentMetadata = [];
  for (const { shell, name, thickness } of components) {
    const count = shell.outsideVertexCount;
    indices.push(...shell.faces.flatMap(face => face.map(index => index < count ? index + outsideOffset : index - count + outsideOffset + outsideCount)));
    componentMetadata.push({ name, outsideVertexStart: outsideOffset, outsideVertexCount: count, innerVertexStart: outsideOffset + outsideCount, thickness });
    outsideOffset += count;
  }
  return {
    ...garment, positions, indices, vertexGroups, vertexParts, uv,
    source: { ...garment.source, method: `${garment.source.method} Body-authored hollow ${config.hood} hood, sewn pocket panels, drawcord tubes and ribbed cuff/hem panels; globally paired fabric shells.` },
    design: { ...garment.design, hood: config.hood, hoodBounds: { min: hoodMin, max: hoodMax }, faceOpening: config.hood === 'up', pocket: config.pocket, componentCount: components.length, components: componentMetadata, details: components.slice(1).map(component => component.name) },
    stats: { vertexCount: positions.length / 3, triangleCount: indices.length / 3, outsideVertexCount: outsideCount, rimEdges: components.reduce((sum, component) => sum + component.shell.boundaryEdges, 0) },
  };
}

function refineSurface(mesh, field) {
  mesh.vertices.forEach(p => {
    for (let pass = 0; pass < 8; pass++) {
      const distance = field(p);
      if (Math.abs(distance) < 1e-7) break;
      const gradient = [0, 1, 2].map(axis => { const a = [...p], b = [...p]; a[axis] += .0005; b[axis] -= .0005; return (field(a) - field(b)) / .001; });
      const scale = distance / (dot(gradient, gradient) || 1);
      gradient.forEach((v, axis) => { p[axis] -= v * scale; });
    }
  });
}
