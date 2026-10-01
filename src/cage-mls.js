/** Weighted affine cage coordinates (moving least squares).
 * Cloth is driven only by existing cage points. Indices and UVs are untouched.
 * Exact affine reproduction avoids transporting offsets along normals that
 * flip when a cage triangle folds or stretches. Negative affine coordinates
 * are allowed, and their size is exposed in diagnostics. */
const xyz = (a, i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const norm = a => Math.hypot(...a);
const groupsOf = group => typeof group === 'string' ? [group] : Array.isArray(group) ? group : [];
const smoothstep = (a, b, value) => { const t = Math.max(0, Math.min(1, (value - a) / (b - a))); return t * t * (3 - 2 * t); };
const isArm = name => /(?:UpperArm|LowerArm|Hand)$/.test(name);

function garmentGraph(positions, indices, pairedVertexOffset, config) {
  const count = positions.length / 3, near = Array.from({ length: count }, () => new Set());
  const parents = Array.from({ length: count }, (_, i) => i);
  const find = i => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; };
  const join = (a, b) => { const x = find(a), y = find(b); if (x !== y) parents[y] = x; };
  if (indices) for (let i = 0; i < indices.length; i += 3) for (let j = 0; j < 3; j++) {
    near[indices[i + j]].add(indices[i + (j + 1) % 3]).add(indices[i + (j + 2) % 3]);
    const a = indices[i + j], b = indices[i + (j + 1) % 3];
    if (norm(sub(xyz(positions, a), xyz(positions, b))) < (config.coincidentRadius ?? .008)) join(a, b);
  }
  // OBJ seams and garment panels can duplicate points without sharing indices.
  // Coordinate their semantic fields as well as sewn inner/outer vertex pairs.
  const radius = config.coincidentRadius ?? .008, cells = new Map();
  if (radius > 0) for (let i = 0; i < count; i++) {
    const p = xyz(positions, i), cell = p.map(v => Math.floor(v / radius));
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      const list = cells.get(`${cell[0] + x},${cell[1] + y},${cell[2] + z}`) ?? [];
      for (const j of list) if (norm(sub(p, xyz(positions, j))) < radius) join(i, j);
    }
    const key = cell.join(','); if (!cells.has(key)) cells.set(key, []); cells.get(key).push(i);
  }
  if (pairedVertexOffset && pairedVertexOffset * 2 === count) for (let i = 0; i < pairedVertexOffset; i++) { near[i].add(i + pairedVertexOffset); near[i + pairedVertexOffset].add(i); join(i, i + pairedVertexOffset); }
  const clusters = new Map();
  for (let i = 0; i < count; i++) { const key = find(i); if (!clusters.has(key)) clusters.set(key, []); clusters.get(key).push(i); }
  return { near, clusters: [...clusters.values()] };
}

function seamField(positions, groups, graph, config) {
  const count = positions.length / 3, field = new Float64Array(count), { near, clusters } = graph;
  const lockedTorso = new Uint8Array(count),lockedArm=new Uint8Array(count), distances = new Float64Array(count); distances.fill(Infinity);
  const metricRadius=config.metricRadius??Math.max(.24,((config.armEnd??1.2)-(config.torsoStart??.9))*1.25);
  const edgeLength=(a,b)=>norm(sub(xyz(positions,a),xyz(positions,b)));
  const queue = [];
  for (let i = 0; i < count; i++) {
    const labels = groupsOf(groups?.[i]), p = xyz(positions, i), arm = labels.some(isArm), torso = labels.some(name => /Torso/.test(name));
    lockedTorso[i] = labels.length === 1 && labels[0] === 'LowerTorso' ? 1 : 0;
    lockedArm[i]=arm&&!torso&&Math.abs(p[0])>(config.pureArmBoundary??1.32)?1:0;
    field[i] = arm ? (torso ? smoothstep(config.torsoStart ?? .9, config.armEnd ?? 1.2, Math.abs(p[0])) : 1) : 0;
    if (arm && torso) { distances[i] = 0; queue.push(i); }
  }
  // Geodesic distance in model units, rather than a count of mesh edges.
  // A long planar triangle must not make a cuff one "hop" from the torso.
  const pending=new Set(queue);
  while(pending.size) {
    let i=-1,best=Infinity;
    for(const candidate of pending)if(distances[candidate]<best){i=candidate;best=distances[candidate];}
    pending.delete(i);
    if(best>=metricRadius)continue;
    for(const j of near[i]) {
      const candidate=best+edgeLength(i,j);
      if(candidate<=metricRadius&&candidate<distances[j]){distances[j]=candidate;pending.add(j);}
    }
  }
  const pairAverage = () => {
    for (const cluster of clusters) {
      // A shirt hem authored solely for LowerTorso never follows an arm. Apply
      // the same lock to its sewn inner/outer pair and coincident rim points.
      const weight = cluster.some(i => lockedTorso[i]) ? 0 :cluster.some(i=>lockedArm[i])?1: cluster.reduce((sum, i) => sum + field[i], 0) / cluster.length;
      for (const i of cluster) field[i] = weight;
    }
  };
  const shoulderField = () => {
    for (let i = 0; i < count; i++) {
      if (lockedTorso[i]) { field[i] = 0; continue; }
      if(lockedArm[i]){field[i]=1;continue;}
      const p = xyz(positions, i), gate = smoothstep(config.shoulderStart ?? 3.65, config.shoulderEnd ?? 3.95, p[1]);
      if (gate && Math.abs(p[0]) > .75) field[i] = field[i] * (1 - gate) + smoothstep(config.torsoStart ?? .9, config.armEnd ?? 1.2, Math.abs(p[0])) * gate;
    }
  };
  for (let step = 0; step < (config.graphIterations ?? 12); step++) {
    const next = Float64Array.from(field);
    for (let i = 0; i < count; i++) if (!lockedTorso[i]&&!lockedArm[i] && distances[i] <=metricRadius && near[i].size) {
      let sum = 0, total = 0;
      for (const j of near[i]) {
        const length=edgeLength(i,j);
        if(length>metricRadius)continue;
        const weight=1/Math.max(length,config.minimumEdgeLength??.04);
        sum += field[j]*weight; total+=weight;
      }
      if(total)next[i] = field[i] * .35 + sum / total * .65;
    }
    field.set(next); shoulderField(); pairAverage();
  }
  shoulderField(); pairAverage();
  return field;
}

function jointPositions(joints, cagePoints) {
  const map = new Map();
  if (Array.isArray(joints)) joints.forEach(joint => { if (joint.name && joint.position) map.set(joint.name, joint.position); });
  else if (joints && typeof joints === 'object') Object.entries(joints).forEach(([name, joint]) => map.set(name, joint.position ?? joint));
  const center = points => points.length ? [0, 1, 2].map(axis => points.reduce((sum, point) => sum + point[axis], 0) / points.length) : null;
  for (const side of ['Left', 'Right']) {
    const upper = `${side}UpperArm`, lower = `${side}LowerArm`, hand = `${side}Hand`;
    if (!map.has(lower)) {
      const shared = cagePoints.filter(q => q.weights.some(w => w.name === upper && w.weight > .1) && q.weights.some(w => w.name === lower && w.weight > .1));
      let point = center(shared.map(q => q.point));
      if (!point) {
        const top = cagePoints.filter(q => q.labels.includes(upper)).map(q => q.point), bottom = cagePoints.filter(q => q.labels.includes(lower)).map(q => q.point);
        const a = center(top), b = center(bottom);
        if (a && b) point = [0, 1, 2].map(axis => (a[axis] + b[axis]) / 2);
      }
      if (point) map.set(lower, point);
    }
    if (!map.has(hand)) {
      const shared = cagePoints.filter(q => q.weights.some(w => w.name === lower && w.weight > .1) && q.weights.some(w => w.name === hand && w.weight > .1));
      const point = center(shared.map(q => q.point)) ?? center(cagePoints.filter(q => q.labels.includes(hand)).map(q => q.point));
      if (point) map.set(hand, point);
    }
  }
  return map;
}

function elbowFields(positions, groups, graph, joints, config) {
  const count = positions.length / 3, result = Object.create(null);
  for (const side of ['Left', 'Right']) {
    const upper = `${side}UpperArm`, lower = `${side}LowerArm`, hand = `${side}Hand`;
    const pivot = joints.get(lower), child = joints.get(hand);
    if (!pivot || !child) continue;
    const axis = sub(child, pivot), length = norm(axis); if (length < 1e-6) continue;
    const direction = axis.map(v => v / length), radius = config.elbowRadius ?? Math.min(.25, Math.max(.12, length * .28));
    const field = new Float64Array(count), active = new Uint8Array(count), fixed = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const labels = groupsOf(groups?.[i]), p = xyz(positions, i);
      const arm = labels.some(name => name.startsWith(side) && isArm(name));
      const mixed = labels.includes(upper) && labels.includes(lower);
      const distance = dot(sub(p, pivot), direction);
      field[i] = smoothstep(-radius, radius, distance);
      active[i] = arm && (mixed || Math.abs(distance) < radius * 1.35) ? 1 : 0;
      fixed[i] = !active[i] ? 1 : 0;
      if (!arm) field[i] = 0;
      if (labels.includes(hand) && !labels.includes(upper)) { field[i] = 1; fixed[i] = 1; }
    }
    const coherent = () => {
      for (const cluster of graph?.clusters ?? []) {
        const armMembers = cluster.filter(i => groupsOf(groups?.[i]).some(name => name.startsWith(side) && isArm(name)));
        if (!armMembers.length) continue;
        const weight = armMembers.reduce((sum, i) => sum + field[i], 0) / armMembers.length;
        for (const i of cluster) field[i] = weight;
      }
    };
    for (let step = 0; step < (config.elbowGraphIterations ?? config.graphIterations ?? 12); step++) {
      const next = Float64Array.from(field);
      for (let i = 0; i < count; i++) if (!fixed[i] && graph?.near[i].size) {
        const neighbors = [...graph.near[i]].filter(j => groupsOf(groups?.[j]).some(name => name.startsWith(side) && isArm(name)));
        if (!neighbors.length) continue;
        let sum=0,total=0;
        for(const j of neighbors) {
          const length=norm(sub(xyz(positions,i),xyz(positions,j)));
          if(length>radius*2)continue;
          const weight=1/Math.max(length,config.minimumEdgeLength??.04);
          sum+=field[j]*weight;total+=weight;
        }
        if(!total)continue;
        const average=sum/total;
        // Anchor to the joint-space field to prevent a dense cuff or tiny
        // clipped triangle from moving the anatomical elbow transition.
        const distance = dot(sub(xyz(positions, i), pivot), direction);
        next[i] = smoothstep(-radius, radius, distance) * .55 + field[i] * .15 + average * .30;
      }
      field.set(next); coherent();
    }
    coherent(); result[side] = { field, pivot, axis: direction, radius };
  }
  return result;
}

function inverseSymmetric(m) {
  const [a, b, c, , d, e, , , f] = m;
  const aa = d * f - e * e, bb = c * e - b * f, cc = b * e - c * d;
  const dd = a * f - c * c, ee = b * c - a * e, ff = a * d - b * b;
  const determinant = a * aa + b * bb + c * cc;
  const trace = a + d + f;
  if (!(determinant > 1e-18) || !(trace > 0)) return null;
  return { matrix: [aa, bb, cc, bb, dd, ee, cc, ee, ff].map(v => v / determinant), normalizedDeterminant: determinant / trace ** 3 };
}

function calculateCoordinates(p, chosen) {
  let weightSum = 0;
  const center = [0, 0, 0];
  for (const q of chosen) { q.localWeight = 1 / (q.distance2 + .025 ** 2) ** 1.5; weightSum += q.localWeight; }
  for (const q of chosen) { q.localWeight /= weightSum; for (let k = 0; k < 3; k++) center[k] += q.point[k] * q.localWeight; }
  const covariance = Array(9).fill(0);
  for (const q of chosen) {
    const d = sub(q.point, center);
    for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) covariance[j * 3 + k] += q.localWeight * d[j] * d[k];
  }
  const inverse = inverseSymmetric(covariance);
  if (!inverse) return null;
  const offset = sub(p, center), correction = [0, 1, 2].map(j => dot(inverse.matrix.slice(j * 3, j * 3 + 3), offset));
  const records = chosen.map(q => ({ id: q.id, weight: q.localWeight * (1 + dot(correction, sub(q.point, center))) }));
  const sum = records.reduce((s, q) => s + q.weight, 0);
  for (const q of records) q.weight /= sum;
  const reproduced = [0, 0, 0];
  for (let i = 0; i < records.length; i++) for (let k = 0; k < 3; k++) reproduced[k] += records[i].weight * chosen[i].point[k];
  return { records, identityError: norm(sub(reproduced, p)), normalizedDeterminant: inverse.normalizedDeterminant };
}

/** cageGroups is an optional per-cage-vertex semantic label/list. Otherwise
 * dominant influence names are used. Cloth groups preferentially use cage
 * vertices with at least 95% weight inside the complete allowed group set.
 * A torso/upper-arm seam therefore excludes lower-arm and head support, while
 * a single arm group excludes every other bone. */
export function bindMls(garmentPositions, cagePositions, {
  vertexGroups = null, cageGroups = null, influences = null, neighbors = 32,
  maximumNeighbors = 192, purity = .95, seamBlend = false,
  garmentIndices = null, pairedVertexOffset = null,
  joints = null, bodyJoints = null,
} = {}) {
  const cageCount = cagePositions.length / 3;
  if (garmentPositions.length % 3 || cagePositions.length % 3) throw new Error('Expected flat XYZ position arrays.');
  const cagePoints = Array.from({ length: cageCount }, (_, id) => {
    const weights = influences?.[id] ?? [];
    const dominant = [...weights].sort((a, b) => b.weight - a.weight)[0];
    const labels = cageGroups?.length === cageCount ? groupsOf(cageGroups[id]) : dominant ? [dominant.name] : [];
    return { id, point: xyz(cagePositions, id), labels, weights };
  });
  const seamConfig = typeof seamBlend === 'object' ? seamBlend : {};
  const graph = seamBlend ? garmentGraph(garmentPositions, garmentIndices, pairedVertexOffset, seamConfig) : null;
  const coherentSeamWeights = seamBlend && seamConfig.graph ? seamField(garmentPositions, vertexGroups, graph, seamConfig) : null;
  const jointMap = jointPositions(joints ?? bodyJoints, cagePoints);
  const hasLowerArm = vertexGroups?.some(group => groupsOf(group).some(name => /LowerArm$/.test(name))) ?? false;
  const elbows = seamBlend && hasLowerArm ? elbowFields(garmentPositions, vertexGroups, graph, jointMap, { ...seamConfig, elbowGraphIterations: seamConfig.graph ? seamConfig.elbowGraphIterations ?? seamConfig.graphIterations ?? 12 : 0 }) : {};
  const vertices = [], statistics = { maximumIdentityError: 0, maximumAbsoluteWeight: 0, minimumSupportCount: Infinity, maximumSupportCount: 0, lowPurityVertices: 0, expandedNeighborhoods: 0, illConditionedVertices: 0, minimumNormalizedDeterminant: Infinity };
  const regionCache = new Map(), regionWeights = new Array(garmentPositions.length / 3);
  function regionCoordinates(p, group, vertex) {
    if (!regionCache.has(group)) {
      const candidates = cagePoints.filter(q => q.labels.includes(group) || q.weights.some(w => w.name === group && w.weight > 0));
      const pure = candidates.filter(q => !influences || q.weights.some(w => w.name === group && w.weight >= purity));
      regionCache.set(group, pure.length >= 8 ? pure : candidates);
    }
    const support = regionCache.get(group).map(q => ({ ...q, distance2: dot(sub(q.point, p), sub(q.point, p)) })).sort((a, b) => a.distance2 - b.distance2);
    const maximum = Math.min(support.length, Math.max(neighbors, maximumNeighbors));
    let count = Math.min(support.length, Math.max(8, neighbors)), coordinate;
    while (true) {
      coordinate = calculateCoordinates(p, support.slice(0, count));
      if (coordinate && coordinate.identityError < 1e-7 && coordinate.normalizedDeterminant > 1e-7) break;
      if (count >= maximum) break;
      count = Math.min(maximum, count + 16);
    }
    if (!coordinate) throw new Error(`No affine cage support for seam vertex ${vertex}, group ${group}.`);
    if (count > neighbors) statistics.expandedNeighborhoods++;
    if (coordinate.normalizedDeterminant <= 1e-7 || coordinate.identityError >= 1e-7) statistics.illConditionedVertices++;
    statistics.maximumIdentityError = Math.max(statistics.maximumIdentityError, coordinate.identityError);
    statistics.minimumNormalizedDeterminant = Math.min(statistics.minimumNormalizedDeterminant, coordinate.normalizedDeterminant);
    statistics.minimumSupportCount = Math.min(statistics.minimumSupportCount, count); statistics.maximumSupportCount = Math.max(statistics.maximumSupportCount, count);
    return coordinate;
  }
  function semanticWeights(p, groups, vertex) {
    const armLabels = groups.filter(isArm), torsoLabels = groups.filter(name => /Torso$/.test(name));
    if (!seamBlend) return null;
    let armWeight = coherentSeamWeights?.[vertex] ?? (armLabels.length ? (torsoLabels.length ? smoothstep(seamConfig.torsoStart ?? .7, seamConfig.armEnd ?? 1.25, Math.abs(p[0])) : 1) : 0);
    if (!armLabels.length && armWeight <= 1e-6) return null;
    const map = new Map(), put = (name, weight) => { if (weight > 1e-8) map.set(name, (map.get(name) ?? 0) + weight); };
    const side = armLabels.find(name => /^(Left|Right)/.test(name))?.startsWith('Right') ? 'Right' : armLabels.length ? 'Left' : p[0] < 0 ? 'Left' : 'Right';
    const upper = `${side}UpperArm`, lower = `${side}LowerArm`, hand = `${side}Hand`;
    if (p[1] > (seamConfig.capHeight ?? 3.8) && seamConfig.capBias) armWeight = seamConfig.capBias + (1 - seamConfig.capBias) * armWeight;
    if (armWeight < 1 - 1e-8) put(torsoLabels[0] ?? 'UpperTorso', 1 - armWeight);
    if (armWeight > 1e-8) {
      const sideLabels = armLabels.filter(name => name.startsWith(side));
      if (sideLabels.length === 1 && sideLabels[0] === hand) put(hand, armWeight);
      else {
        // A short sleeve without any authored LowerArm groups keeps the tested
        // shoulder-only field. Longer garments share the same joint-space elbow
        // transition, including explicit Torso/LowerArm and triple seams.
        let lowerWeight = elbows[side]?.field[vertex] ?? (sideLabels.includes(lower) ? 1 : 0);
        if (!hasLowerArm) lowerWeight = 0;
        let handWeight = 0;
        if (sideLabels.includes(hand) && jointMap.has(hand) && elbows[side]) {
          const distance = dot(sub(p, jointMap.get(hand)), elbows[side].axis);
          handWeight = smoothstep(-.12, .12, distance);
        }
        put(upper, armWeight * (1 - lowerWeight) * (1 - handWeight));
        put(lower, armWeight * lowerWeight * (1 - handWeight));
        put(hand, armWeight * handWeight);
      }
    }
    const total = [...map.values()].reduce((sum, weight) => sum + weight, 0);
    if (!(total > 0)) return null;
    return [...map].map(([name, weight]) => ({ name, weight: weight / total }));
  }
  for (let i = 0; i < regionWeights.length; i++) regionWeights[i] = semanticWeights(xyz(garmentPositions, i), groupsOf(vertexGroups?.[i]), i);
  for (const cluster of graph?.clusters ?? []) {
    if (cluster.length < 2) continue;
    if (cluster.some(i => { const labels = groupsOf(vertexGroups?.[i]); return labels.length === 1 && labels[0] === 'LowerTorso'; })) {
      for (const i of cluster) regionWeights[i] = [{ name: 'LowerTorso', weight: 1 }];
      continue;
    }
    if (!cluster.some(i => regionWeights[i])) continue;
    const common = new Map();
    for (const i of cluster) {
      const labels = groupsOf(vertexGroups?.[i]);
      const weights = regionWeights[i] ?? labels.map(name => ({ name, weight: 1 / labels.length }));
      for (const weight of weights) common.set(weight.name, (common.get(weight.name) ?? 0) + weight.weight / cluster.length);
    }
    const total = [...common.values()].reduce((sum, value) => sum + value, 0);
    if (total > 0) for (const i of cluster) regionWeights[i] = [...common].filter(([, weight]) => weight > 1e-8).map(([name, weight]) => ({ name, weight: weight / total }));
  }
  for (let vertex = 0; vertex < garmentPositions.length / 3; vertex++) {
    const p = xyz(garmentPositions, vertex); let groups = groupsOf(vertexGroups?.[vertex]);
    const semantic = regionWeights[vertex];
    if (semantic) {
      const map = new Map();
      for (const region of semantic) {
        const coordinate = regionCoordinates(p, region.name, vertex);
        coordinate.records.forEach(record => map.set(record.id, (map.get(record.id) ?? 0) + record.weight * region.weight));
      }
      const records = [...map].map(([id, weight]) => ({ id, weight }));
      for (const record of records) statistics.maximumAbsoluteWeight = Math.max(statistics.maximumAbsoluteWeight, Math.abs(record.weight));
      vertices.push(records);
      continue;
    }
    let candidates = cagePoints.filter(q => !groups.length || q.labels.some(name => groups.includes(name)));
    if (!candidates.length) throw new Error(`No cage support for cloth vertex ${vertex}: ${groups.join(', ')}.`);
    if (groups.length && influences) {
      const pure = candidates.filter(q => q.weights.reduce((sum, w) => sum + (groups.includes(w.name) ? w.weight : 0), 0) >= purity);
      if (pure.length >= 8) candidates = pure;
      else statistics.lowPurityVertices++;
    }
    candidates = candidates.map(q => ({ ...q, distance2: dot(sub(q.point, p), sub(q.point, p)) })).sort((a, b) => a.distance2 - b.distance2);
    const upperLimit = Math.min(candidates.length, Math.max(neighbors, maximumNeighbors));
    let count = Math.min(candidates.length, Math.max(8, neighbors)), coordinates;
    while (true) {
      coordinates = calculateCoordinates(p, candidates.slice(0, count));
      if (coordinates && coordinates.identityError < 1e-7 && coordinates.normalizedDeterminant > 1e-7) break;
      if (count >= upperLimit) break;
      count = Math.min(upperLimit, count + 16);
    }
    if (!coordinates) throw new Error(`Cage neighborhood for cloth vertex ${vertex} is coplanar.`);
    if (count > neighbors) statistics.expandedNeighborhoods++;
    if (coordinates.normalizedDeterminant <= 1e-7 || coordinates.identityError >= 1e-7) statistics.illConditionedVertices++;
    statistics.maximumIdentityError = Math.max(statistics.maximumIdentityError, coordinates.identityError);
    statistics.minimumNormalizedDeterminant = Math.min(statistics.minimumNormalizedDeterminant, coordinates.normalizedDeterminant);
    for (const record of coordinates.records) statistics.maximumAbsoluteWeight = Math.max(statistics.maximumAbsoluteWeight, Math.abs(record.weight));
    statistics.minimumSupportCount = Math.min(statistics.minimumSupportCount, count); statistics.maximumSupportCount = Math.max(statistics.maximumSupportCount, count);
    vertices.push(coordinates.records);
  }
  return { vertices, sourceVertexCount: cageCount, sourcePositions: Float32Array.from(garmentPositions), statistics, seamWeights: coherentSeamWeights, regionWeights, elbowFields: Object.fromEntries(Object.entries(elbows).map(([side, value]) => [side, value.field])), method: 'weighted-affine-cage-coordinates' };
}

export function deformMls(bindings, targetCagePositions, output = new Float32Array(bindings.vertices.length * 3)) {
  if (targetCagePositions.length / 3 !== bindings.sourceVertexCount) throw new Error('Cage topology changed since MLS binding.');
  for (let i = 0; i < bindings.vertices.length; i++) {
    const p = [0, 0, 0];
    for (const record of bindings.vertices[i]) for (let k = 0; k < 3; k++) p[k] += targetCagePositions[record.id * 3 + k] * record.weight;
    for (let k = 0; k < 3; k++) output[i * 3 + k] = p[k];
  }
  return output;
}
