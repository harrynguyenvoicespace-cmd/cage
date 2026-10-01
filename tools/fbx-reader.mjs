import fs from 'node:fs';
import zlib from 'node:zlib';
import { Matrix4, Vector3, Vector2, Quaternion, Euler, ShapeUtils } from '../vendor/three/three.module.js';

// This module has no import-time I/O. It preserves FBX control points and polygon
// corner UVs; render loaders may duplicate vertices at seams and cannot be used
// to establish the original Roblox cage control-point correspondence.
export function readFbx(filename) {
  const bytes = fs.readFileSync(filename);
  if (bytes.subarray(0, 23).toString('binary') !== 'Kaydara FBX Binary  \0\x1a\0') throw new Error('Expected binary FBX');
  const version = bytes.readUInt32LE(23), wide = version >= 7500, headerSize = wide ? 25 : 13;
  let offset = 27;
  const need = count => { if (offset + count > bytes.length) throw new Error(`Truncated FBX at ${offset}`); };
  const safe = value => { const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error('FBX integer exceeds exact JavaScript range'); return n; };
  function integer() { need(wide ? 8 : 4); const value = wide ? safe(bytes.readBigUInt64LE(offset)) : bytes.readUInt32LE(offset); offset += wide ? 8 : 4; return value; }
  function property() {
    need(1); const type = String.fromCharCode(bytes[offset++]);
    const scalar = { Y: ['readInt16LE', 2], C: ['readUInt8', 1], I: ['readInt32LE', 4], F: ['readFloatLE', 4], D: ['readDoubleLE', 8], L: ['readBigInt64LE', 8] };
    if (scalar[type]) { const [reader, size] = scalar[type]; need(size); let value = bytes[reader](offset); offset += size; if (type === 'L') value = safe(value); if (type === 'C') value = Boolean(value); return value; }
    if (type === 'S' || type === 'R') { need(4); const size = bytes.readUInt32LE(offset); offset += 4; need(size); const value = bytes.subarray(offset, offset + size); offset += size; return type === 'S' ? value.toString('utf8') : value.toString('base64'); }
    if ('fdlibc'.includes(type)) {
      need(12); const count = bytes.readUInt32LE(offset), encoding = bytes.readUInt32LE(offset + 4), size = bytes.readUInt32LE(offset + 8); offset += 12; need(size);
      let data = bytes.subarray(offset, offset + size); offset += size;
      if (encoding === 1) data = zlib.inflateSync(data); else if (encoding !== 0) throw new Error(`Unknown FBX array encoding ${encoding}`);
      const sizes = { f: 4, d: 8, l: 8, i: 4, b: 1, c: 1 }, readers = { f: 'readFloatLE', d: 'readDoubleLE', l: 'readBigInt64LE', i: 'readInt32LE', b: 'readUInt8', c: 'readUInt8' };
      if (data.length !== count * sizes[type]) throw new Error('FBX array byte count differs from its declared length');
      return Array.from({ length: count }, (_, index) => type === 'l' ? safe(data[readers[type]](index * sizes[type])) : data[readers[type]](index * sizes[type]));
    }
    throw new Error(`Unsupported FBX property ${type} at ${offset - 1}`);
  }
  function node() {
    need(headerSize); const end = integer(), count = integer(), propertySize = integer(), nameLength = bytes[offset++];
    if (!end) { if (count || propertySize || nameLength) throw new Error('Malformed FBX null record'); return null; }
    if (end <= offset || end > bytes.length) throw new Error(`Invalid FBX node extent ${end}`);
    need(nameLength); const name = bytes.toString('utf8', offset, offset + nameLength); offset += nameLength;
    const start = offset, props = Array.from({ length: count }, property);
    if (offset !== start + propertySize) throw new Error(`FBX ${name} property length mismatch`);
    const children = [];
    while (offset < end - headerSize) { const child = node(); if (!child) break; children.push(child); }
    if (offset > end) throw new Error(`FBX ${name} exceeded node extent`);
    offset = end; return { name, props, children };
  }
  const nodes = []; while (offset < bytes.length - headerSize) { const next = node(); if (!next) break; nodes.push(next); }
  return { version, nodes };
}
const one = (node, name) => node?.children.find(child => child.name === name);
const many = (node, name) => node?.children.filter(child => child.name === name) ?? [];
const value = (node, name) => one(node, name)?.props[0];
const properties70 = node => Object.fromEntries(many(one(node, 'Properties70'), 'P').map(child => [child.props[0], child.props.slice(4)]));
const cleanName = name => String(name).split('\0')[0];
export function extract(filename) {
  const tree = readFbx(filename), objects = tree.nodes.find(node => node.name === 'Objects'), connections = tree.nodes.find(node => node.name === 'Connections');
  return {
    version: tree.version, settings: properties70(tree.nodes.find(node => node.name === 'GlobalSettings')),
    geometries: many(objects, 'Geometry').map(node => ({ id: node.props[0], name: cleanName(node.props[1]), type: node.props[2], positions: value(node, 'Vertices'), polygonIndices: value(node, 'PolygonVertexIndex'),
      uvLayers: many(node, 'LayerElementUV').map(uv => ({ name: value(uv, 'Name'), mapping: value(uv, 'MappingInformationType'), reference: value(uv, 'ReferenceInformationType'), uv: value(uv, 'UV'), uvIndices: value(uv, 'UVIndex') })),
    })),
    models: many(objects, 'Model').map(node => ({ id: node.props[0], name: cleanName(node.props[1]), type: node.props[2], properties: properties70(node) })),
    deformers: many(objects, 'Deformer').map(node => ({ id: node.props[0], name: cleanName(node.props[1]), type: node.props[2], indices: value(node, 'Indexes'), weights: value(node, 'Weights'), transform: value(node, 'Transform'), transformLink: value(node, 'TransformLink') })),
    connections: many(connections, 'C').map(node => node.props),
    poses: many(objects, 'Pose').map(node => ({ id: node.props[0], name: cleanName(node.props[1]), type: value(node, 'Type'), nodes: many(node, 'PoseNode').map(pose => ({ id: value(pose, 'Node'), matrix: value(pose, 'Matrix') })) })),
  };
}
const vectorProperty = (properties, name, fallback) => properties[name] ?? fallback;
const rotationOrder = ['ZYX', 'YZX', 'XZY', 'ZXY', 'YXZ', 'XYZ']; // FBX extrinsic orders -> Three intrinsic orders.
function rotation(values, order = 'ZYX') {
  return new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromEuler(new Euler(...values.map(value => value * Math.PI / 180), order)));
}
function translation(values) { return new Matrix4().makeTranslation(...values); }
function scaling(values) { return new Matrix4().makeScale(...values); }
/** FBX pivot composition for the RSrs (InheritType 1) convention in these files.
 * Unsupported inheritance modes fail explicitly instead of silently applying TRS.
 */
export function modelLocalMatrix(properties = {}) {
  const inherit = properties.InheritType?.[0] ?? 0;
  if (inherit !== 1) throw new Error(`Unsupported FBX transform InheritType ${inherit}; requires a complete FBX SDK evaluator`);
  const order = rotationOrder[properties.RotationOrder?.[0] ?? 0];
  if (!order) throw new Error('Unsupported spherical FBX rotation order');
  const zero = [0, 0, 0], rPivot = vectorProperty(properties, 'RotationPivot', zero), sPivot = vectorProperty(properties, 'ScalingPivot', zero);
  return translation(vectorProperty(properties, 'Lcl Translation', zero))
    .multiply(translation(vectorProperty(properties, 'RotationOffset', zero)))
    .multiply(translation(rPivot)).multiply(rotation(vectorProperty(properties, 'PreRotation', zero)))
    .multiply(rotation(vectorProperty(properties, 'Lcl Rotation', zero), order))
    .multiply(rotation(vectorProperty(properties, 'PostRotation', zero)).invert()).multiply(translation(rPivot.map(value => -value)))
    .multiply(translation(vectorProperty(properties, 'ScalingOffset', zero)))
    .multiply(translation(sPivot)).multiply(scaling(vectorProperty(properties, 'Lcl Scaling', [1, 1, 1])))
    .multiply(translation(sPivot.map(value => -value)));
}
export function geometricMatrix(properties = {}) {
  return translation(vectorProperty(properties, 'GeometricTranslation', [0, 0, 0]))
    .multiply(rotation(vectorProperty(properties, 'GeometricRotation', [0, 0, 0])))
    .multiply(scaling(vectorProperty(properties, 'GeometricScaling', [1, 1, 1])));
}
/** Return a proper basis change into right-handed +Y-up, +Z-authored-front.
 * FBX numerical unit metadata is returned separately; mesh applications choose
 * their application scale rather than this reader silently treating studs as cm.
 */
export function sceneAxisMatrix(settings = {}) {
  const number = (name, fallback) => settings[name]?.[0] ?? fallback;
  const axes = [number('CoordAxis', 0), number('UpAxis', 1), number('FrontAxis', 2)], signs = [number('CoordAxisSign', 1), number('UpAxisSign', 1), number('FrontAxisSign', 1)];
  if (new Set(axes).size !== 3 || axes.some(value => ![0, 1, 2].includes(value)) || signs.some(value => ![-1, 1].includes(value))) throw new Error('Invalid FBX scene axes');
  const rows = axes.map((axis, index) => [0, 1, 2].map(value => value === axis ? signs[index] : 0));
  const matrix = new Matrix4().set(...rows[0], 0, ...rows[1], 0, ...rows[2], 0, 0, 0, 0, 1);
  if (matrix.determinant() < 0) throw new Error('Left-handed FBX axes require explicit winding conversion');
  return matrix;
}
export function meshTransforms(data) {
  const models = new Map(data.models.map(model => [model.id, model])), worlds = new Map(), resolving = new Set();
  function world(id) {
    if (worlds.has(id)) return worlds.get(id);
    const model = models.get(id); if (!model) return new Matrix4();
    if (resolving.has(id)) throw new Error('FBX model-parent cycle'); resolving.add(id);
    const parent = data.connections.find(connection => connection[0] === 'OO' && connection[1] === id && models.has(connection[2]));
    const matrix = (parent ? world(parent[2]).clone() : new Matrix4()).multiply(modelLocalMatrix(model.properties));
    if (!matrix.elements.every(Number.isFinite) || matrix.determinant() <= 0) throw new Error(`Invalid/reflected FBX transform for ${model.name}`);
    worlds.set(id, matrix); resolving.delete(id); return matrix;
  }
  return data.geometries.filter(geometry => geometry.type === 'Mesh').map(geometry => {
    const connection = data.connections.find(connection => connection[0] === 'OO' && connection[1] === geometry.id && models.has(connection[2]));
    if (!connection) throw new Error(`Geometry ${geometry.id} is not connected to a model`);
    const model = models.get(connection[2]);
    return { geometry, model, worldMatrix: world(model.id), geometricMatrix: geometricMatrix(model.properties), matrix: sceneAxisMatrix(data.settings).multiply(world(model.id)).multiply(geometricMatrix(model.properties)) };
  });
}
export function transformPositions(positions, matrix) {
  if (!positions || positions.length % 3) throw new Error('Invalid FBX control-point array');
  const point = new Vector3(), output = [];
  for (let index = 0; index < positions.length; index += 3) { point.fromArray(positions, index).applyMatrix4(matrix); output.push(point.x, point.y, point.z); }
  if (!output.every(Number.isFinite)) throw new Error('FBX mesh has non-finite positions');
  return output;
}
export function bounds(positions) {
  if (!positions.length || positions.length % 3 || !positions.every(Number.isFinite)) throw new Error('Cannot bound invalid mesh');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  positions.forEach((value, index) => { const axis = index % 3; min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value); });
  return { min, max, size: max.map((value, axis) => value - min[axis]), center: min.map((value, axis) => (value + max[axis]) / 2) };
}
export function triangulate(polygonIndices, vertexCount, positions = null) {
  const polygons = [], indices = [], triangleCorners = []; let polygon = [], corners = [];
  polygonIndices.forEach((raw, corner) => {
    const vertex = raw < 0 ? -raw - 1 : raw;
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= vertexCount) throw new Error('FBX polygon contains invalid control-point index');
    polygon.push(vertex); corners.push(corner);
    if (raw < 0) {
      if (polygon.length < 3) throw new Error('FBX polygon has fewer than three corners');
      polygons.push(polygon);
      if (polygon.length > 4) {
        if (!positions) throw new Error('FBX n-gon triangulation requires control-point positions');
        const points = polygon.map(vertex => positions.slice(vertex * 3, vertex * 3 + 3)), normal = [0, 0, 0];
        points.forEach((point, index) => { const next = points[(index + 1) % points.length]; normal[0] += (point[1] - next[1]) * (point[2] + next[2]); normal[1] += (point[2] - next[2]) * (point[0] + next[0]); normal[2] += (point[0] - next[0]) * (point[1] + next[1]); });
        const drop = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs))), axes = [0, 1, 2].filter(axis => axis !== drop);
        const triangles = ShapeUtils.triangulateShape(points.map(point => new Vector2(point[axes[0]], point[axes[1]])), []);
        if (triangles.length !== polygon.length - 2) throw new Error('FBX polygon cannot be completely triangulated');
        for (let triangle of triangles) {
          const [a, b, c] = triangle.map(index => new Vector3(...points[index]));
          const triNormal = b.sub(a).cross(c.sub(a));
          if (triNormal.dot(new Vector3(...normal)) < 0) triangle = [triangle[0], triangle[2], triangle[1]];
          indices.push(...triangle.map(index => polygon[index])); triangleCorners.push(...triangle.map(index => corners[index]));
        }
      } else for (let index = 1; index < polygon.length - 1; index++) { indices.push(polygon[0], polygon[index], polygon[index + 1]); triangleCorners.push(corners[0], corners[index], corners[index + 1]); }
      polygon = []; corners = [];
    }
  });
  if (polygon.length) throw new Error('Unterminated FBX polygon');
  return { polygons, indices, triangleCorners };
}
export function cornerUv(geometry, layer = geometry.uvLayers[0]) {
  if (!layer?.uv) throw new Error(`Missing cage UVs for ${geometry.name}`);
  if (!['ByPolygonVertex', 'ByVertice', 'ByVertex'].includes(layer.mapping)) throw new Error(`Unsupported UV mapping ${layer.mapping}`);
  if (!['Direct', 'IndexToDirect', 'Index'].includes(layer.reference)) throw new Error(`Unsupported UV reference ${layer.reference}`);
  return geometry.polygonIndices.map((raw, corner) => {
    const mappingIndex = layer.mapping === 'ByPolygonVertex' ? corner : raw < 0 ? -raw - 1 : raw;
    const uvId = layer.reference === 'Direct' ? mappingIndex : layer.uvIndices[mappingIndex];
    const uv = layer.uv.slice(uvId * 2, uvId * 2 + 2);
    if (uv.length !== 2 || !uv.every(Number.isFinite)) throw new Error('Invalid FBX UV corner');
    return uv;
  });
}
