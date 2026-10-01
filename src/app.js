import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { GLTFLoader } from '../vendor/three/GLTFLoader.js';
import { createDemoFit, createR15GarmentFit, rebindWithCorrespondence, deformWithCage, createSurface, mergeBodyParts, diagnoseMesh, meshBounds } from './cage-engine.js';
import { createR15Poser, posePoints } from './r15-pose.js';
import { windingNumbers } from './diagnostics.js';
import { solveCageContacts } from './cage-contact.js';
import { GARMENT_CATALOG } from './garment-catalog.js';
import { createMannequinGarmentFit } from './mannequin-fit.js';

const $ = id => document.getElementById(id);
const host = $('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#e5eaf0');
scene.fog = new THREE.Fog('#e5eaf0', 16, 38);
const camera = new THREE.PerspectiveCamera(35, 1, .05, 100);
camera.position.set(6.2, 4.9, -10.5);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.domElement.setAttribute('aria-label', 'Mannequin mặc áo và cage 3D. Kéo để xoay, cuộn để zoom.');
renderer.domElement.tabIndex = 0;
host.prepend(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 2.6, 0);
controls.enableDamping = true; controls.dampingFactor = .08;
controls.minDistance = 6; controls.maxDistance = 22; controls.maxPolarAngle = Math.PI * .52;
scene.add(new THREE.HemisphereLight(0xffffff, 0x9baabc, 2.0));
const key = new THREE.DirectionalLight(0xffffff, 3.5); key.position.set(-5, 10, -7); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048); key.shadow.camera.left = -7; key.shadow.camera.right = 7;
key.shadow.camera.top = 7; key.shadow.camera.bottom = -7; key.shadow.normalBias = .04; key.shadow.bias = -.0002;
scene.add(key);
const fill = new THREE.DirectionalLight(0xd4efff, 1.8); fill.position.set(5, 5, 6); scene.add(fill);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: '#e2e7ed', roughness: 1 }));
floor.rotation.x = -Math.PI / 2; floor.position.y = -.035; floor.receiveShadow = true; scene.add(floor);
const grid = new THREE.GridHelper(36, 36, '#b8c4d0', '#c9d2dc'); grid.position.y = -.032; grid.material.transparent = true; grid.material.opacity = .48; scene.add(grid);
const bodyGroup = new THREE.Group(), cageGroup = new THREE.Group(); scene.add(bodyGroup, cageGroup);
const bodyMeshes = new Map();
let originalHeadMaterial;
const importedHeadMaterial = new THREE.MeshStandardMaterial({ color: '#c0cbd6', roughness: .88 });
let garmentMesh, innerWire, outerWire, demo, poser, assetCage, assetShirt, assetBody, garmentAssets, targetSeed, restBindings, sourceBody, sourceSeed;
const mannequinAssets = new Map(), sourceFits = new Map(), mannequinFits = new Map();
let current = null, metrics = null, ready = false, fitting = false, frameNumber = 0, lastTime = 0, walkStarted = 0, fitVersion = 16;
const state = { mannequin: 'r15', width: 1, pose: 'stand', garment: 'r15', fitContacts: true, contact: false, projection: new URL(location.href).searchParams.get('projection') === 'regional' ? 'regional' : 'union', fitted: true, playing: true };
const garmentColors = { ...Object.fromEntries(GARMENT_CATALOG.map(entry => [entry.id, entry.color])), roblox:'#078d96' };
const garmentEntry = () => GARMENT_CATALOG.find(entry => entry.id === state.garment);
const fitOptions = () => ({ targetSeed, projectionMode: state.projection });
const mannequinEntry = () => mannequinAssets.get(state.mannequin);
function makeFit() {
  if (state.garment === 'roblox') return createDemoFit(assetCage, assetShirt, assetBody, fitOptions());
  const key = `${state.garment}:${state.projection}`;
  if (!sourceFits.has(key)) sourceFits.set(key, createR15GarmentFit(assetCage, assetShirt, sourceBody, { targetSeed: sourceSeed, projectionMode: state.projection }));
  const sourceFit = sourceFits.get(key);
  if (state.mannequin === 'r15') return sourceFit;
  const targetKey = `${state.mannequin}:${key}:${state.fitContacts}`;
  if (!mannequinFits.has(targetKey)) mannequinFits.set(targetKey, createMannequinGarmentFit(assetCage, assetShirt, sourceBody, assetBody, {
    ...fitOptions(), sourceSeed, sourceFit, sourceId: 'r15', targetId: state.mannequin, fitContacts: state.fitContacts,
  }));
  return mannequinFits.get(targetKey);
}

function rebuildBody(body) {
  for (const part of body.parts) {
    const mesh = bodyMeshes.get(part.name);
    if (!mesh) throw new Error(`Không tìm thấy phần body: ${part.name}`);
    mesh.geometry.dispose(); mesh.geometry = geometryOf(part);
    if (part.name === 'Head') mesh.material = body === sourceBody ? originalHeadMaterial : importedHeadMaterial;
  }
  assetBody = body; poser = createR15Poser(body);
}

function geometryOf(mesh) {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
  g.setIndex(Array.from(mesh.indices)); if (mesh.uv?.length === mesh.positions.length / 3 * 2) g.setAttribute('uv', new THREE.Float32BufferAttribute(mesh.uv, 2));
  g.computeVertexNormals(); return g;
}
function updateGeometry(mesh, positions) { mesh.geometry.attributes.position.array.set(positions); mesh.geometry.attributes.position.needsUpdate = true; mesh.geometry.computeVertexNormals(); mesh.geometry.computeBoundingSphere(); }
function makeWire(mesh, color) {
  const edges = [], seen = new Set();
  const polygons = mesh.polygons || Array.from({ length: mesh.indices.length / 3 }, (_, i) => Array.from(mesh.indices.slice(i * 3, i * 3 + 3)));
  for (const p of polygons) for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], id = `${Math.min(a, b)}:${Math.max(a, b)}`;
    if (!seen.has(id)) { seen.add(id); edges.push(a, b); }
  }
  const positions = new Float32Array(edges.length * 3);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const wire = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: .62, depthWrite: false }));
  wire.userData.edges = edges; wire.frustumCulled = false; cageGroup.add(wire); return wire;
}
function updateWire(wire, positions) {
  const target = wire.geometry.attributes.position.array;
  wire.userData.edges.forEach((id, i) => { target[i * 3] = positions[id * 3]; target[i * 3 + 1] = positions[id * 3 + 1]; target[i * 3 + 2] = positions[id * 3 + 2]; });
  wire.geometry.attributes.position.needsUpdate = true;
}
function visibility() {
  bodyGroup.visible = $('show-body').checked;
  if (garmentMesh) garmentMesh.visible = $('show-garment').checked;
  if (innerWire) innerWire.visible = $('show-inner').checked;
  if (outerWire) outerWire.visible = $('show-outer').checked;
}
function labels() {
  $('state-label').textContent = `${garmentEntry()?.label || 'Áo Roblox'} · ${mannequinEntry()?.label || 'R15'}${state.width > 1.01 ? ' rộng' : ''} · ${state.fitted ? 'Sau fit' : 'Trước fit'} · ${state.pose === 'arms' ? 'Giơ tay' : state.pose === 'walk' ? 'Đi bộ' : 'Đứng'}`;
  $('mannequin-type').value = state.mannequin;
  $('mannequin-note').textContent = state.mannequin === 'r15' ? 'Body R15 ban đầu.' : 'Body và cage từ FBX bạn gửi. Tư thế dùng khớp mô phỏng.';
  $('garment-type').querySelector('option[value="roblox"]').disabled = state.mannequin !== 'r15';
  $('body-width-value').value = state.width.toFixed(2) + '×'; $('body-width').value = state.width;
  document.querySelectorAll('[data-body]').forEach(b => b.classList.toggle('selected', b.dataset.body === (state.width > 1.01 ? 'wide' : 'original')));
  document.querySelectorAll('[data-pose]').forEach(b => b.classList.toggle('selected', b.dataset.pose === state.pose));
  $('before').classList.toggle('selected', !state.fitted); $('after').classList.toggle('selected', state.fitted);
  $('toggle-play').hidden = state.pose !== 'walk'; $('toggle-play').textContent = state.playing ? 'Tạm dừng' : 'Chạy tiếp';
  $('contact-fix').disabled = state.garment === 'roblox' || (state.pose === 'walk' && state.playing);
  $('contact-fix').checked = state.contact;
  $('fit-body-contact-option').hidden = $('fit-body-contact-note').hidden = state.mannequin === 'r15';
  $('fit-body-contact').checked = state.fitContacts;
  $('fit-body-contact').disabled = fitting || state.mannequin === 'r15';
}
function frameScene() {
  if (!current || camera.aspect <= 0) return;
  const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
  for (const positions of [current.garment, current.inner, ...current.posed.parts.map(p => p.positions)]) for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], positions[i+k]); max[k] = Math.max(max[k], positions[i+k]); }
  const center = new THREE.Vector3((min[0]+max[0])/2,(min[1]+max[1])/2,(min[2]+max[2])/2);
  const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const distance = Math.max((max[1]-min[1])/(2*tangent), Math.hypot(max[0]-min[0],max[2]-min[2])/(2*tangent*camera.aspect))*1.13;
  const direction = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(center); camera.position.copy(center).addScaledVector(direction,distance);
  controls.minDistance = distance*.38; controls.maxDistance = distance*2.4; controls.update();
}
function renderState(time = 0, measure = false) {
  if (!ready) return;
  const posed = poser.getState({ width: state.width, pose: state.pose, time });
  for (const part of posed.parts) updateGeometry(bodyMeshes.get(part.name), part.positions);
  const originalFit = sourceFits.get(`${state.garment}:${state.projection}`);
  let inner = state.fitted ? posePoints(demo.innerPositions, demo.influences, posed) : Float32Array.from(originalFit?.innerPositions || demo.sourceCage.positions);
  const outer = state.fitted ? posePoints(demo.outerPositions, demo.outerInfluences || demo.influences, posed) : Float32Array.from(originalFit?.outerPositions || demo.sourceCage.positions);
  let garment = state.fitted ? deformWithCage(restBindings, inner) : Float32Array.from(demo.sourceGarment.positions), contactReport = null;
  if (state.fitted && state.contact && state.garment !== 'roblox') {
    const baseInner = inner;
    const correction = solveCageContacts(restBindings, inner, assetShirt.indices, mergeBodyParts(posed.parts), { cageIndices: assetCage.inner.indices });
    inner = correction.inner; garment = correction.garment;
    for (let i = 0; i < outer.length; i++) outer[i] += inner[i] - baseInner[i];
    contactReport = { diagnostics: correction.diagnostics, history: correction.history };
  }
  updateGeometry(garmentMesh, garment); updateWire(innerWire, inner); updateWire(outerWire, outer);
  current = { posed, inner, outer, garment, time, contactReport };
  if (measure) measureCurrent();
}
function measureCurrent() {
  if (!current) return;
  const surface = createSurface(mergeBodyParts(current.posed.parts));
  const checked = diagnoseMesh({ positions: current.garment, indices: assetShirt.indices }, surface, { robust: true });
  const cageSurface = createSurface({ positions: current.outer, indices: assetCage.outer.indices });
  let outside = 0, overlap = 0, parityOutside = 0;
  const winding = windingNumbers(current.garment, current.outer, assetCage.outer.indices);
  for (let i = 0; i < current.garment.length; i += 3) {
    const p = [current.garment[i], current.garment[i + 1], current.garment[i + 2]];
    const distance = cageSurface.distance(p, { robust: true });
    if (distance.signed > .003) parityOutside++;
    if (distance.distance > .003 && Math.abs(winding[i / 3]) < .5) outside++;
    if (Math.abs(winding[i / 3]) > 1.5) overlap++;
  }
  metrics = { ...checked, distances: undefined, badVertices: undefined, penetrationPercent: checked.penetrationSamples / checked.sampleCount * 100, outsideVertices: outside, overlapVertices: overlap, parityOutsideVertices: parityOutside, enclosureMethod: 'generalized winding; abs(w)>0.5 inside; abs(w)>1.5 overlapping volumes; 0.003 stud surface tolerance', garmentVertices: current.garment.length / 3, outsidePercent: outside / (current.garment.length / 3) * 100, overlapPercent: overlap / (current.garment.length / 3) * 100, cageVertices: current.inner.length / 3, topologyPreserved: current.inner.length === assetCage.inner.positions.length };
  $('penetration').textContent = metrics.penetrationPercent.toFixed(2) + '%'; $('penetration').className = checked.penetrationSamples === 0 ? 'ok' : 'bad';
  $('outside').textContent = metrics.outsidePercent.toFixed(1) + '%'; $('outside').className = outside === 0 ? 'ok' : 'bad';
  $('overlap').textContent = metrics.overlapPercent.toFixed(1) + '%'; $('overlap').className = overlap === 0 ? 'ok' : 'bad';
  $('topology').textContent = metrics.cageVertices.toLocaleString('en-US') + ' · giữ nguyên';
  const mannequinNote = demo.transfer?.collisionRepairApplied
    ? 'Cage FBX ghép bằng UV; đã xử lý tiếp xúc body khi fit. Mesh và UV áo giữ nguyên.'
    : demo.restContact?.accepted === false
      ? 'Chống xuyên làm méo áo nên chưa áp dụng; đang giữ kết quả chuyển cage gốc.'
      : 'Cage FBX ghép bằng UV; giữ nguyên mesh áo, dùng liên kết MLS nguồn đã ổn định.';
  $('algorithm-note').textContent = state.fitted ? (state.garment !== 'roblox' ? (state.mannequin === 'r15' ? 'Cage blocky ghép bằng UV; cùng thuật toán MLS cho mọi kiểu áo.' : mannequinNote) : `Retarget áo Roblox: ${demo.history.length} bước tối ưu. Còn lỗi fit ở vai.`) : (state.garment === 'roblox' ? 'Áo Roblox và cage mẫu giữ vị trí nguồn.' : 'Áo và cage giữ vị trí nguồn R15 trước khi chuyển sang body đã chọn.');
}
function toast(text) { $('toast').textContent = text; $('toast').classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').classList.remove('visible'), 3200); }
function setView(side) {
  const directions = { front: [0, 3.8, -12], side: [12, 3.8, 0], back: [0, 3.8, 12], reset: [6.2, 4.9, -10.5] };
  camera.position.set(...directions[side]); controls.target.set(0, 2.6, 0); controls.update();
  frameScene();
}
function mannequinData() { return { id: state.mannequin, label: mannequinEntry().label, bodyFile: mannequinEntry().bodyFile || 'assets/r15-body.json', source: assetBody.source, normalization: assetBody.normalization, rigSource: assetBody.rigSource || 'original R15 joints', transfer: demo.transfer || null }; }
function snapshotData() { return { state: { ...state, time: current.time }, mannequin: mannequinData(), metrics, fitVersion, initialization: demo.initialization, targetSeedProvenance: demo.targetSeedProvenance, bindingStatistics: demo.bindings.statistics, contactReport: current.contactReport, diagnostics: { before: demo.diagnostics.before, after: demo.diagnostics.after, topology: demo.diagnostics.topology }, history: demo.history }; }
async function capture() {
  if (!ready) return;
  if (state.pose === 'walk') { state.playing = false; labels(); }
  measureCurrent(); renderer.render(scene, camera);
  const name = `round-${String(fitVersion).padStart(2, '0')}-${state.mannequin}-${state.garment}-${state.fitContacts ? 'rest-on' : 'rest-off'}-${state.contact ? 'pose-on' : 'pose-off'}-${state.fitted ? 'fit' : 'source'}-${state.pose}-${Math.round(state.width * 100)}`;
  const response = await fetch('/api/evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, image: renderer.domElement.toDataURL('image/png'), ...snapshotData() }) });
  if (!response.ok) throw new Error('Không lưu được ảnh');
  toast(`Đã lưu evidence/${name}.png`);
}
async function download() {
  if (state.pose === 'walk') { state.playing = false; labels(); }
  measureCurrent();
  const output = { schemaVersion: 1, source: assetCage.source, mannequin: mannequinData(), targetSeedProvenance: demo.targetSeedProvenance, contactReport: current.contactReport || null, units: 'stud', axis: 'Y-up', state: { ...state, time: current.time }, authoredInner: demo.authoredInnerPositions ? { ...assetCage.inner, positions: Array.from(demo.authoredInnerPositions), bounds: meshBounds(demo.authoredInnerPositions) } : null, inner: { ...assetCage.inner, positions: Array.from(current.inner), bounds: meshBounds(current.inner) }, outer: { ...assetCage.outer, positions: Array.from(current.outer), bounds: meshBounds(current.outer) }, garment: { ...assetShirt, positions: Array.from(current.garment), bounds: meshBounds(current.garment) }, metrics };
  const response = await fetch('/api/export', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(output) });
  if (!response.ok) throw new Error('Không xuất được snapshot');
  const saved = await response.json();
  $('export-link').href = saved.url; $('export-link').download = saved.name; $('export-link').hidden = false;
  toast(`Đã lưu exports/${saved.name}`);
}
async function refit(prepare = null) {
  if (fitting) return;
  fitting = true;
  for (const id of ['auto-fit','capture','download','garment-type','mannequin-type','fit-body-contact']) $(id).disabled = true;
  document.querySelectorAll('[data-body],[data-pose],#body-width,#before,#after,#contact-fix').forEach(control => { control.disabled = true; });
  $('auto-fit').textContent = 'Đang tối ưu…';
  try {
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (prepare) prepare();
    $('export-link').hidden = true;
    demo = makeFit();
    restBindings = state.garment !== 'roblox' ? demo.bindings : rebindWithCorrespondence(demo.bindings, demo.innerPositions, demo.garmentPositions);
    garmentMesh.geometry.dispose(); garmentMesh.geometry = geometryOf({ ...assetShirt, positions: demo.garmentPositions });
    garmentMesh.material.color.set(garmentColors[state.garment]);
    state.fitted = true; labels(); renderState(lastTime, true); frameScene();
    toast('Đã fit cage và cập nhật trang phục');
  } finally {
    fitting = false;
    for (const id of ['auto-fit','capture','download','garment-type','mannequin-type']) $(id).disabled = false;
    document.querySelectorAll('[data-body],[data-pose],#body-width,#before,#after').forEach(control => { control.disabled = false; });
    labels();
    $('auto-fit').textContent = 'Tự fit cage';
  }
}
async function init() {
  const filenames = ['roblox-cage.json', 'roblox-tshirt.json', 'r15-body.json', 'blocky-cage-target.json', ...GARMENT_CATALOG.map(entry => entry.filename)];
  const [cage, originalShirt, body, seed, ...garments] = await Promise.all(filenames.map(filename => fetch(`/assets/${filename}`).then(r => { if (!r.ok) throw new Error(filename + ' không tải được'); return r.json(); })));
  assetCage = cage; assetBody = sourceBody = body; targetSeed = sourceSeed = seed;
  const catalog = await fetch('/assets/mannequins/catalog.json').then(r => { if (!r.ok) throw new Error('Không tải được danh sách mannequin'); return r.json(); });
  mannequinAssets.set('r15', { id: 'r15', label: 'R15 ban đầu', body, seed });
  await Promise.all(catalog.entries.map(async entry => {
    const [targetBody, cageSeed] = await Promise.all([entry.bodyFile, entry.targetSeedFile].map(filename => fetch('/' + filename).then(r => { if (!r.ok) throw new Error(filename + ' không tải được'); return r.json(); })));
    mannequinAssets.set(entry.id, { ...entry, body: targetBody, seed: cageSeed });
  }));
  $('mannequin-type').replaceChildren(new Option('R15 ban đầu', 'r15'), ...catalog.entries.map(entry => new Option(entry.label, entry.id)));
  garmentAssets = { ...Object.fromEntries(GARMENT_CATALOG.map((entry, i) => [entry.id, garments[i]])), roblox: originalShirt }; assetShirt = garmentAssets.r15;
  const families = new Map();
  for (const entry of GARMENT_CATALOG) {
    if (!families.has(entry.family)) { const group = document.createElement('optgroup'); group.label = entry.family; families.set(entry.family, group); }
    families.get(entry.family).append(new Option(entry.label, entry.id));
  }
  const experiment = document.createElement('optgroup'); experiment.label = 'Thử nghiệm';
  experiment.append(new Option('Áo Roblox · retarget thử nghiệm', 'roblox'));
  $('garment-type').replaceChildren(...families.values(), experiment);
  const gltf = await new GLTFLoader().loadAsync('/assets/r15.glb');
  let bodyMaterial; gltf.scene.traverse(obj => { if (obj.isMesh && !bodyMaterial) bodyMaterial = obj.material.clone(); });
  if (bodyMaterial) { bodyMaterial.roughness = .86; bodyMaterial.metalness = 0; }
  else bodyMaterial = new THREE.MeshStandardMaterial({ color: '#b9c6d3', roughness: .9 });
  originalHeadMaterial = bodyMaterial;
  for (const part of assetBody.parts) { const material = part.name === 'Head' ? bodyMaterial : new THREE.MeshStandardMaterial({ color: /Leg|Foot/.test(part.name) ? '#65758a' : '#c0cbd6', roughness: .88 }); const mesh = new THREE.Mesh(geometryOf(part), material); mesh.name = part.name; mesh.castShadow = true; mesh.receiveShadow = true; bodyGroup.add(mesh); bodyMeshes.set(part.name, mesh); }
  gltf.scene.traverse(obj => { if (obj.isMesh) obj.geometry.dispose(); });
  demo = makeFit();
  poser = createR15Poser(assetBody);
  restBindings = demo.bindings;
  garmentMesh = new THREE.Mesh(geometryOf({ ...assetShirt, positions: demo.garmentPositions }), new THREE.MeshStandardMaterial({ color: '#078d96', roughness: .78, metalness: 0, side: THREE.DoubleSide }));
  garmentMesh.castShadow = true; garmentMesh.receiveShadow = true; garmentMesh.frustumCulled = false; scene.add(garmentMesh);
  innerWire = makeWire(assetCage.inner, '#287fd5'); outerWire = makeWire(assetCage.outer, '#ed922b');
  ready = true; $('loading').classList.add('hidden'); $('auto-fit').disabled = false; $('capture').disabled = false; $('download').disabled = false; $('garment-type').disabled = false; $('mannequin-type').disabled = false;
  $('garment-note').textContent = `Mesh mới độc lập · ${Math.round(assetShirt.indices.length / 3).toLocaleString('en-US')} tam giác.`;
  renderState(0, true); visibility(); labels(); frameScene();
}
document.querySelectorAll('[data-body]').forEach(button => button.addEventListener('click', () => { state.width = button.dataset.body === 'wide' ? 1.4 : 1; labels(); renderState(lastTime, true); frameScene(); }));
document.querySelectorAll('[data-pose]').forEach(button => button.addEventListener('click', () => { state.pose = button.dataset.pose; state.playing = true; if (state.pose === 'walk') state.contact = false; walkStarted = performance.now() / 1000; lastTime = 0; labels(); renderState(0, true); frameScene(); if (state.pose === 'walk') { for (const id of ['penetration','outside','overlap']) $(id).textContent = '—'; $('algorithm-note').textContent = 'Dừng hoặc chụp để đo tư thế hiện tại.'; } }));
for (const id of ['show-body', 'show-garment', 'show-inner', 'show-outer']) $(id).addEventListener('change', visibility);
$('before').addEventListener('click', () => { state.fitted = false; labels(); renderState(lastTime, true); frameScene(); });
$('after').addEventListener('click', () => { state.fitted = true; labels(); renderState(lastTime, true); frameScene(); });
$('body-width').addEventListener('input', event => { state.width = Number(event.target.value); labels(); renderState(lastTime, false); frameScene(); clearTimeout(measureCurrent.timer); measureCurrent.timer = setTimeout(measureCurrent, 250); });
$('capture').addEventListener('click', () => capture().catch(e => toast(e.message)));
$('auto-fit').addEventListener('click', () => refit().catch(e => toast(e.message)));
$('garment-type').addEventListener('change', event => { if (!ready) return; state.garment = event.target.value; if (state.garment === 'roblox') state.contact = false; assetShirt = garmentAssets[state.garment]; $('garment-note').textContent = state.garment !== 'roblox' ? `${garmentEntry().description} ${Math.round(assetShirt.indices.length / 3).toLocaleString('en-US')} tam giác.` : 'Mesh mẫu Roblox; thử retarget sang body khối.'; refit().catch(e => toast(e.message)); });
$('mannequin-type').addEventListener('change', event => {
  if (!ready) return;
  const id = event.target.value;
  refit(() => {
    state.mannequin = id; state.contact = false;
    if (id !== 'r15' && state.garment === 'roblox') {
      state.garment = 'r15'; assetShirt = garmentAssets.r15; $('garment-type').value = 'r15';
      $('garment-note').textContent = garmentEntry().description;
    }
    const selected = mannequinAssets.get(id); targetSeed = selected.seed; rebuildBody(selected.body);
  }).catch(e => toast(e.message));
});
$('download').addEventListener('click', () => download().catch(e => toast(e.message)));
$('contact-fix').addEventListener('change', () => { state.contact = $('contact-fix').checked; labels(); renderState(lastTime,true); frameScene(); });
$('fit-body-contact').addEventListener('change', () => { state.fitContacts = $('fit-body-contact').checked; refit().catch(e => toast(e.message)); });
$('reset-view').addEventListener('click', () => setView('reset'));
for (const side of ['front', 'side', 'back']) $('view-' + side).addEventListener('click', () => setView(side));
$('toggle-play').addEventListener('click', () => { state.playing = !state.playing; if (state.playing) { state.contact = false; walkStarted = performance.now() / 1000 - lastTime; for (const id of ['penetration','outside','overlap']) $(id).textContent = '—'; $('algorithm-note').textContent = 'Dừng hoặc chụp để đo tư thế hiện tại.'; } else measureCurrent(); labels(); });
renderer.domElement.addEventListener('keydown', event => { if (event.key === 'Home') setView('reset'); });
new ResizeObserver(() => { const { width, height } = host.getBoundingClientRect(); if (!width || !height) return; renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); frameScene(); }).observe(host);
renderer.setAnimationLoop(time => {
  if (ready && state.pose === 'walk' && state.playing && frameNumber++ % 2 === 0) { lastTime = time / 1000 - walkStarted; renderState(lastTime, false); }
  controls.update(); renderer.render(scene, camera);
});
init().catch(error => { console.error(error); $('loading').textContent = `Không tải được demo: ${error.message}`; });
