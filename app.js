/* Dragondance Viewer — 静态 Three.js 赛车查看器 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createPaintTools } from './paint-tools.js?v=paint-stick-1';
import { createCameraStick } from './camera-stick.js?v=paint-stick-1';
import { createExplodedView, EXPLODE_DURATION_MS } from './exploded-view.js?v=surface-tools-1';

const MODEL_URL = new URL('./model/dragondance.glb', import.meta.url);
// Fallback for static HTTP previews where Web Crypto is unavailable.
const BUNDLED_SHA256 = '63c48f80d51933dad5ac333e2b63c164e5562f2c526f888bede1af435505be4b';
const $ = (id) => document.getElementById(id);
const viewButtons = document.querySelectorAll('[data-view]');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const state = {
  autoRotate: !reducedMotion.matches && !window.matchMedia('(pointer: coarse)').matches,
  wireframe: false,
  grid: true,
  panel: null,
};
function press(button, pressed) {
  button.setAttribute('aria-pressed', String(pressed));
}

/* ---------------- 渲染器、场景与相机 ---------------- */
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
});
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearAlpha(0);
renderer.autoClear = false;
const surface = renderer.domElement;
surface.addEventListener('webglcontextrestored', invalidate);
stage.prepend(surface);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.01, 20000);
camera.position.set(5, 4, 7);
const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
scene.environment = pmrem.fromScene(room, 0.04).texture;
room.dispose();
pmrem.dispose();

const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
keyLight.position.set(6, 10, 7);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x9dc4ff, 1.2);
fillLight.position.set(-8, -3, -6);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffffff, 0.9);
rimLight.position.set(-2, 6, -9);
scene.add(rimLight);
scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x1b2433, 0.7));

const controls = new OrbitControls(camera, surface);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.rotateSpeed = 0.85;
controls.zoomSpeed = 0.9;
controls.panSpeed = 0.8;
controls.autoRotateSpeed = 0.9;
controls.minZoom = 0.1;
controls.maxZoom = 20;
controls.addEventListener('change', invalidate);
press($('btn-rotate'), state.autoRotate);

const model = new THREE.Group();
scene.add(model);
const grid = new THREE.GridHelper(10, 20, 0x3a5f8f, 0x233247);
grid.material.transparent = true;
grid.material.opacity = 0.55;
scene.add(grid);

// 模型经过 Z-up 转换后，鼻锥朝向 -X，车手左手侧朝向 +Z。
const VIEW_DIRS = {
  front: new THREE.Vector3(-1, 0, 0), back: new THREE.Vector3(1, 0, 0),
  left: new THREE.Vector3(0, 0, 1), right: new THREE.Vector3(0, 0, -1),
  top: new THREE.Vector3(0, 1, 0.0015), bottom: new THREE.Vector3(0, -1, 0.0015),
  iso: new THREE.Vector3(1, 1, 1),
};
const selectedGroups = new Set();
const materials = new Set();
let triangleCount = 0;
let viewWidth = 1;
let viewHeight = 1;
let framingRadius = 3;
let assembledRadius = 3;
let explosion = null;
let paintTools = null;
let viewTween = null;
let frameTween = null;
let outline = null;
let dirty = true;

function invalidate() { dirty = true; }

/* ---------------- 加载 ---------------- */
let progress = 0;
function setProgress(value) {
  progress = Math.min(100, Math.max(progress, value));
  $('bar').style.width = `${progress}%`;
  $('pct').textContent = `${Math.round(progress)}%`;
}
const progressTimer = setInterval(() => {
  if (progress < 88) setProgress(progress + (88 - progress) * 0.05);
}, 180);

async function loadModel() {
  const data = await new THREE.FileLoader().setResponseType('arraybuffer').loadAsync(MODEL_URL.href, (event) => {
    if (event.lengthComputable && event.total > 0) setProgress(event.loaded / event.total * 90);
  });
  const [gltf, digest] = await Promise.all([
    new GLTFLoader().parseAsync(data, new URL('.', MODEL_URL).href),
    globalThis.crypto?.subtle?.digest('SHA-256', data),
  ]);
  const modelKey = digest
    ? Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    : BUNDLED_SHA256;
  onLoaded(gltf, modelKey);
}

function onLoaded(gltf, modelKey) {
  const rawSize = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3()).multiplyScalar(1000);
  const orient = new THREE.Group();
  orient.rotation.x = -Math.PI / 2;
  orient.add(gltf.scene);
  model.add(orient);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const scale = 6 / (Math.max(size.x, size.y, size.z) || 1);
  model.scale.setScalar(scale);
  model.position.copy(box.getCenter(new THREE.Vector3())).multiplyScalar(-scale);
  model.updateMatrixWorld(true);

  const fitted = new THREE.Box3().setFromObject(model);
  const fittedSize = fitted.getSize(new THREE.Vector3());
  grid.scale.setScalar(Math.max(fittedSize.x, fittedSize.z) / 10 + 0.15);
  grid.position.y = fitted.min.y;
  const sphere = fitted.getBoundingSphere(new THREE.Sphere());
  explosion = createExplodedView(gltf, sphere.center);
  assembledRadius = sphere.radius || 3;
  framingRadius = assembledRadius;
  const distance = explosion.explodedBounds.getBoundingSphere(new THREE.Sphere()).radius * 3;
  camera.near = Math.max(distance / 5000, 0.001);
  camera.far = distance * 60;
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(VIEW_DIRS.iso.clone().normalize(), distance);
  camera.lookAt(controls.target);
  sizeRenderer();

  for (const mesh of explosion.meshes) {
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      if (!material || materials.has(material)) continue;
      materials.add(material);
      if (!material.isMeshStandardMaterial) continue;
      material.envMapIntensity = 1.15;
      if (!Number.isFinite(material.metalness) || material.metalness > 0.9) material.metalness = 0.35;
      if (!Number.isFinite(material.roughness) || material.roughness > 0.95) material.roughness = 0.42;
      material.side = THREE.FrontSide;
      material.flatShading = false;
      material.needsUpdate = true;
    }
    const { geometry } = mesh;
    triangleCount += Math.floor((geometry.index?.count ?? geometry.attributes.position.count) / 3);
  }

  paintTools = createPaintTools({
    surface, camera, controls, model, meshes: explosion.meshes, modelKey,
    modelRadius: assembledRadius,
    nameForMesh: (mesh) => explosion.partForMesh(mesh)?.name,
    onStrokeStart() {
      if (explosion.parts.some((part) => part.progress !== part.target)) return false;
      setAutoRotate(false);
      viewTween = frameTween = null;
      return true;
    },
    invalidate,
  });
  paintTools.restoreLocal();
  buildGroupButtons();
  updateAssemblyUI();

  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  $('m-size').textContent = `${fmt(Math.max(rawSize.x, rawSize.y))} × ${fmt(Math.min(rawSize.x, rawSize.y))} × ${fmt(rawSize.z)} mm`;
  $('m-parts').textContent = fmt(explosion.parts.length);
  $('m-tris').textContent = fmt(triangleCount);
  for (const button of document.querySelectorAll('#views button, #dock button')) button.disabled = false;
  $('btn-explode').disabled = !explosion.categories.length;
  if (state.autoRotate) selectView(null);
  clearInterval(progressTimer);
  setProgress(100);
  $('loader').classList.add('hidden');
  document.body.classList.add('ready');
}

/* ---------------- 视角与取景 ---------------- */
function sizeRenderer() {
  const width = Math.max(1, stage.clientWidth);
  const height = Math.max(1, stage.clientHeight);
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  if (width !== viewWidth || height !== viewHeight || ratio !== renderer.getPixelRatio()) {
    cameraStick.reset();
    paintTools?.endStroke();
    viewWidth = width;
    viewHeight = height;
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height);
  }
  fitOrthographicCamera();
  invalidate();
}

function fitOrthographicCamera() {
  const aspect = viewWidth / viewHeight;
  const halfHeight = framingRadius * 1.12 / Math.min(aspect, 1);
  camera.left = -halfHeight * aspect;
  camera.right = halfHeight * aspect;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.updateProjectionMatrix();
}

function selectView(view) {
  for (const button of viewButtons) press(button, button.dataset.view === view);
}

function setAutoRotate(enabled) {
  state.autoRotate = enabled;
  press($('btn-rotate'), enabled);
  if (enabled) selectView(null);
  invalidate();
}

/* ---------------- 绘画视角摇杆 ---------------- */
const paintCamera = $('paint-camera');
const stickOffset = new THREE.Vector3();
const stickAngles = new THREE.Spherical();

function preparePaintCamera() {
  if (state.panel !== 'paint' || paintTools.isDrawing() || pointersDown.size) return false;
  setAutoRotate(false);
  controls.autoRotate = false;
  viewTween = frameTween = null;

  // Consume pending orbit damping while keeping the current camera pose.
  const position = camera.position.clone();
  const target = controls.target.clone();
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = damping;
  controls.target.copy(target);
  camera.position.copy(position);
  camera.lookAt(target);
  return true;
}

const cameraStick = createCameraStick($('camera-stick'), {
  onStart() {
    if (!preparePaintCamera()) return false;
    selectView(null);
    paintTools.setNavigating(true);
    return true;
  },
  onEnd() { paintTools.setNavigating(false); },
});

function orbitFromStick(dt) {
  const { x, y } = cameraStick.direction;
  if (!x && !y) return;
  stickOffset.subVectors(camera.position, controls.target);
  stickAngles.setFromVector3(stickOffset);
  stickAngles.theta -= x * 2.25 * dt;
  stickAngles.phi -= y * 1.7 * dt;
  stickAngles.phi = THREE.MathUtils.clamp(stickAngles.phi, controls.minPolarAngle, controls.maxPolarAngle);
  stickAngles.makeSafe();
  camera.position.setFromSpherical(stickAngles).add(controls.target);
  camera.lookAt(controls.target);
  invalidate();
}

function zoomPaintCamera(factor) {
  if (cameraStick.isActive() || !preparePaintCamera()) return;
  camera.zoom = THREE.MathUtils.clamp(camera.zoom * factor, controls.minZoom, controls.maxZoom);
  camera.updateProjectionMatrix();
  invalidate();
}

const explosionDistance = $('explode-distance');
function selectionSphere() {
  return explosion.getBounds(selectedGroups, explosionDistance.valueAsNumber / 100).getBoundingSphere(new THREE.Sphere());
}

function moveView(view, reset = false) {
  cameraStick.reset();
  paintTools.endStroke();
  setAutoRotate(false);
  selectView(view);
  const from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
  const to = new THREE.Spherical().setFromVector3(VIEW_DIRS[view]);
  const angle = THREE.MathUtils.euclideanModulo(to.theta - from.theta + Math.PI, 2 * Math.PI) - Math.PI;
  const start = performance.now();
  const sphere = reset ? selectionSphere() : null;
  viewTween = {
    from, phi: to.phi, angle, start,
    fromTarget: controls.target.clone(),
    toTarget: sphere ? sphere.center : null,
    duration: reducedMotion.matches ? 0 : 600,
  };
  if (sphere) reframe(sphere, start, false);
  if (reducedMotion.matches) updateCamera(start);
}

function reframe(sphere, start, center = true) {
  frameTween = {
    fromRadius: framingRadius / camera.zoom,
    toRadius: sphere.radius || assembledRadius,
    fromTarget: controls.target.clone(),
    toTarget: center ? sphere.center : null,
    start,
    duration: reducedMotion.matches ? 0 : EXPLODE_DURATION_MS,
  };
}

const frameTarget = new THREE.Vector3();
function updateCamera(now) {
  if (viewTween) {
    const { from, phi, angle, fromTarget, toTarget, start, duration } = viewTween;
    const t = duration ? THREE.MathUtils.clamp((now - start) / duration, 0, 1) : 1;
    const eased = t * t * (3 - 2 * t);
    if (toTarget) controls.target.lerpVectors(fromTarget, toTarget, eased);
    camera.position.setFromSphericalCoords(from.radius, THREE.MathUtils.lerp(from.phi, phi, eased), from.theta + angle * eased);
    camera.position.add(controls.target);
    camera.lookAt(controls.target);
    if (t === 1) viewTween = null;
    invalidate();
  }
  if (frameTween) {
    const { fromRadius, toRadius, fromTarget, toTarget, start, duration } = frameTween;
    const t = duration ? THREE.MathUtils.clamp((now - start) / duration, 0, 1) : 1;
    framingRadius = THREE.MathUtils.lerp(fromRadius, toRadius, t);
    if (toTarget) {
      frameTarget.lerpVectors(fromTarget, toTarget, t);
      camera.position.sub(controls.target).add(frameTarget);
      controls.target.copy(frameTarget);
      camera.lookAt(controls.target);
    }
    camera.zoom = 1;
    fitOrthographicCamera();
    if (t === 1) frameTween = null;
    invalidate();
  }
}

/* ---------------- 分组拆解和点选 ---------------- */
const groupButtons = new Map();
const explodeButton = $('btn-explode');
const drawButton = $('btn-draw');
function showPanel(panel) {
  cameraStick.reset();
  state.panel = panel;
  paintTools.setVisible(panel === 'paint');
  paintCamera.hidden = panel !== 'paint';
  if (panel) {
    document.body.dataset.tools = panel;
    setAutoRotate(false);
    $('tools-title').textContent = panel === 'parts' ? '部件拆解' : '表面绘画';
  } else {
    delete document.body.dataset.tools;
  }
  $('tool-panel').hidden = !panel;
  $('parts-tools').hidden = panel !== 'parts';
  $('drawing-tools').hidden = panel !== 'paint';
  press(explodeButton, panel === 'parts');
  press(drawButton, panel === 'paint');
  sizeRenderer();
}

function buildGroupButtons() {
  for (const { id, label, detail } of explosion.categories) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'part-button';
    button.dataset.group = id;
    button.setAttribute('aria-label', label);
    const name = document.createElement('span');
    name.textContent = label;
    const description = document.createElement('small');
    description.textContent = detail;
    name.append(description);
    const action = document.createElement('span');
    action.className = 'part-action';
    button.append(name, action);
    button.addEventListener('click', () => toggleGroup(id));
    $('part-groups').append(button);
    groupButtons.set(id, { button, action });
  }
}

function updateAssemblyUI() {
  const distance = explosionDistance.valueAsNumber;
  for (const [id, { button, action }] of groupButtons) {
    const selected = selectedGroups.has(id);
    press(button, selected);
    action.textContent = selected ? '复位' : '拆开';
  }
  $('assembly-state').textContent = selectedGroups.size && distance > 0 ? `${selectedGroups.size} 组拆开` : '已装配';
  $('distance-value').value = `${distance}%`;
  $('btn-assemble-all').disabled = !selectedGroups.size;
  $('btn-separate-all').disabled = selectedGroups.size === groupButtons.size && distance > 0;
  explodeButton.querySelector('span').textContent = selectedGroups.size && distance > 0 ? '爆炸图 · 已拆' : '爆炸图';
}

function changeExplosion() {
  paintTools.endStroke();
  setAutoRotate(false);
  const now = performance.now();
  viewTween = null;
  explosion.setGroups(selectedGroups, explosionDistance.valueAsNumber / 100, now, reducedMotion.matches);
  reframe(selectionSphere(), now);
  updateAssemblyUI();
}

function toggleGroup(id) {
  if (selectedGroups.has(id)) selectedGroups.delete(id);
  else {
    selectedGroups.add(id);
    if (!explosionDistance.valueAsNumber) explosionDistance.value = '100';
  }
  changeExplosion();
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function selectPartAt(event) {
  if (!explosion || state.panel === 'paint' || (!selectedGroups.size && state.panel !== 'parts')) return;
  const rect = surface.getBoundingClientRect();
  pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
  if (Math.abs(pointer.x) > 1 || Math.abs(pointer.y) > 1) return;
  camera.updateMatrixWorld();
  model.updateMatrixWorld(true);
  raycaster.setFromCamera(pointer, camera);
  const [hit] = raycaster.intersectObjects(explosion.meshes, false);
  const part = hit && explosion.partForMesh(hit.object);
  if (part?.category && (selectedGroups.has(part.category) || state.panel === 'parts')) toggleGroup(part.category);
}

const pointersDown = new Set();
let scenePress = null;
surface.addEventListener('pointerdown', (event) => {
  pointersDown.add(event.pointerId);
  scenePress = pointersDown.size === 1 && event.button === 0 ? event : null;
  if (pointersDown.size > 1 || event.button !== 0) {
    viewTween = frameTween = null;
    selectView(null);
  }
});
window.addEventListener('pointermove', (event) => {
  if (!scenePress || event.pointerId !== scenePress.pointerId) return;
  if (Math.hypot(event.clientX - scenePress.clientX, event.clientY - scenePress.clientY) <= 6) return;
  scenePress = null;
  viewTween = frameTween = null;
  selectView(null);
});
window.addEventListener('pointerup', (event) => {
  pointersDown.delete(event.pointerId);
  if (!scenePress || event.pointerId !== scenePress.pointerId) return;
  if (Math.hypot(event.clientX - scenePress.clientX, event.clientY - scenePress.clientY) <= 6) selectPartAt(event);
  scenePress = null;
});
window.addEventListener('pointercancel', (event) => {
  pointersDown.delete(event.pointerId);
  if (event.pointerId === scenePress?.pointerId) scenePress = null;
});
window.addEventListener('blur', () => {
  pointersDown.clear();
  scenePress = null;
});

/* ---------------- 轮廓 / 截图 ---------------- */
function toggleOutline() {
  if (outline) {
    for (const line of outline.lines) line.removeFromParent();
    for (const geometry of outline.geometries.values()) geometry.dispose();
    outline.material.dispose();
    outline = null;
  } else {
    if (triangleCount > 1_200_000) {
      alert('模型面数较多（>120 万三角面），轮廓线可能导致卡顿，已跳过。');
      return;
    }
    const geometries = new Map();
    const material = new THREE.LineBasicMaterial({ color: 0x8ec5ff, transparent: true, opacity: 0.55 });
    const lines = explosion.meshes.map((mesh) => {
      if (!geometries.has(mesh.geometry)) geometries.set(mesh.geometry, new THREE.EdgesGeometry(mesh.geometry, 28));
      const line = new THREE.LineSegments(geometries.get(mesh.geometry), material);
      mesh.add(line);
      return line;
    });
    outline = { geometries, material, lines };
  }
  press($('btn-edges'), Boolean(outline));
  invalidate();
}

function screenshot() {
  renderer.clear();
  renderer.render(scene, camera);
  surface.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    link.href = url;
    link.download = `dragondance-${stamp}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
  invalidate();
}

/* ---------------- 坐标轴与按需渲染 ---------------- */
const gizmoScene = new THREE.Scene();
const gizmoCam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
gizmoCam.position.set(0, 0, 4.2);
const gizmo = new THREE.AxesHelper(1.25);
gizmoScene.add(gizmo);

function renderGizmo() {
  if (window.innerWidth <= 760) return;
  const size = 104;
  const pad = 18;
  gizmo.quaternion.copy(camera.quaternion).invert();
  renderer.setScissorTest(true);
  renderer.setViewport(viewWidth - size - pad, pad, size, size);
  renderer.setScissor(viewWidth - size - pad, pad, size, size);
  renderer.clearDepth();
  renderer.render(gizmoScene, gizmoCam);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, viewWidth, viewHeight);
}

let lastTime = performance.now();
function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(Math.max(0, now - lastTime) / 1000, 0.05);
  lastTime = now;
  if (explosion) {
    if (explosion.parts.some((part) => part.progress !== part.target)) {
      explosion.update(now);
      invalidate();
    }
    const holdingStick = cameraStick.isActive();
    const drawing = paintTools.isDrawing();
    controls.autoRotate = !holdingStick && !drawing && !viewTween && state.autoRotate;
    if (holdingStick) orbitFromStick(dt);
    else if (!drawing) controls.update(dt);
    updateCamera(now);
  }
  if (!dirty) return;
  dirty = false;
  renderer.clear();
  renderer.render(scene, camera);
  renderGizmo();
}
requestAnimationFrame(animate);

/* ---------------- 工具栏与快捷键 ---------------- */
for (const button of viewButtons) button.addEventListener('click', () => moveView(button.dataset.view));
explodeButton.addEventListener('click', () => showPanel(state.panel === 'parts' ? null : 'parts'));
drawButton.addEventListener('click', () => showPanel(state.panel === 'paint' ? null : 'paint'));
const paintZoomStep = 1.25;
$('paint-zoom-in').addEventListener('click', () => zoomPaintCamera(paintZoomStep));
$('paint-zoom-out').addEventListener('click', () => zoomPaintCamera(1 / paintZoomStep));
$('btn-close-tools').addEventListener('click', () => {
  const opener = state.panel === 'parts' ? explodeButton : drawButton;
  showPanel(null);
  opener.focus();
});
$('btn-separate-all').addEventListener('click', () => {
  for (const id of groupButtons.keys()) selectedGroups.add(id);
  if (!explosionDistance.valueAsNumber) explosionDistance.value = '100';
  changeExplosion();
});
$('btn-assemble-all').addEventListener('click', () => {
  selectedGroups.clear();
  changeExplosion();
});
explosionDistance.addEventListener('input', changeExplosion);
$('btn-rotate').addEventListener('click', () => setAutoRotate(!state.autoRotate));
$('btn-wire').addEventListener('click', (event) => {
  state.wireframe = !state.wireframe;
  for (const material of materials) material.wireframe = state.wireframe;
  press(event.currentTarget, state.wireframe);
  invalidate();
});
$('btn-grid').addEventListener('click', (event) => {
  state.grid = !state.grid;
  grid.visible = state.grid;
  press(event.currentTarget, state.grid);
  invalidate();
});
$('btn-edges').addEventListener('click', toggleOutline);
$('btn-reset').addEventListener('click', () => moveView('iso', true));
$('btn-shot').addEventListener('click', screenshot);
$('btn-full').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen?.();
    else await document.documentElement.requestFullscreen?.();
  } catch (error) {
    console.warn('当前浏览器未允许全屏:', error);
  }
});

const shortcuts = { r: 'rotate', w: 'wire', g: 'grid', e: 'edges', '0': 'reset', f: 'full', s: 'shot', d: 'draw', x: 'explode' };
window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (state.panel && key === 'escape') {
    $('btn-close-tools').click();
    return;
  }
  if (event.repeat || event.altKey || event.target.matches?.('textarea, [contenteditable], input[type="text"]')) return;
  if (state.panel === 'paint' && (event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y')) {
    event.preventDefault();
    $(key === 'y' || event.shiftKey ? 'btn-redo' : 'btn-undo').click();
    return;
  }
  if (!event.target.matches?.('input') && !event.ctrlKey && !event.metaKey && Object.hasOwn(shortcuts, key)) {
    $(`btn-${shortcuts[key]}`).click();
  }
});
window.addEventListener('resize', sizeRenderer);
sizeRenderer();
loadModel().catch((error) => {
  clearInterval(progressTimer);
  console.error(error);
  $('loader').classList.add('hidden');
  $('err').style.display = 'block';
  $('err-msg').textContent = `${MODEL_URL.pathname} — ${error?.message || 'network error'}`;
});
