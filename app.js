/* Dragondance Viewer — 静态 Three.js 赛车查看器 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createDrawingLayer } from './drawing.js';
import { createExplodedView, EXPLODE_DURATION_MS } from './exploded-view.js';

const MODEL_URL = './model/dragondance.glb';
const $ = (id) => document.getElementById(id);
const viewButtons = document.querySelectorAll('[data-view]');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const state = {
  autoRotate: !reducedMotion.matches && !window.matchMedia('(pointer: coarse)').matches,
  wireframe: false,
  grid: true,
  drawing: false,
};

function press(button, pressed) {
  button.setAttribute('aria-pressed', String(pressed));
}

/* ---------------- 渲染器与绘画层 ---------------- */
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearAlpha(0);
renderer.autoClear = false;
const surface = renderer.domElement;
$('stage').prepend(surface);

const brushColor = $('brush-color');
const brushWidth = $('brush-width');
const drawing = createDrawingLayer({
  canvas: $('drawing-canvas'),
  onChange(hasStrokes) {
    $('btn-undo').disabled = !hasStrokes;
    $('btn-clear').disabled = !hasStrokes;
  },
});
drawing.setColor(brushColor.value);
drawing.setWidth(brushWidth.valueAsNumber);

/* ---------------- 场景 / 相机 ---------------- */
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
press($('btn-rotate'), state.autoRotate);

const model = new THREE.Group();
scene.add(model);
const grid = new THREE.GridHelper(10, 20, 0x3a5f8f, 0x233247);
grid.material.transparent = true;
grid.material.opacity = 0.55;
scene.add(grid);

// 模型经过 Z-up 转换后，鼻锥朝向 -X，车手左手侧朝向 +Z。
const VIEW_DIRS = {
  front: new THREE.Vector3(-1, 0, 0),
  back: new THREE.Vector3(1, 0, 0),
  left: new THREE.Vector3(0, 0, 1),
  right: new THREE.Vector3(0, 0, -1),
  top: new THREE.Vector3(0, 1, 0.0015),
  bottom: new THREE.Vector3(0, -1, 0.0015),
  iso: new THREE.Vector3(1, 1, 1),
};
const homeTarget = new THREE.Vector3();
const materials = new Set();
let triangleCount = 0;
let framingRadius = 3;
let assembledRadius = 3;
let explodedRadius = 3;
let explosion = null;
let hasExplodedParts = false;
let viewTween = null;
let frameTween = null;
let outline = null;

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

new GLTFLoader().loadAsync(MODEL_URL, (event) => {
  if (event.lengthComputable && event.total > 0) setProgress(event.loaded / event.total * 90);
}).then(onLoaded).catch((error) => {
  clearInterval(progressTimer);
  console.error(error);
  $('loader').classList.add('hidden');
  $('err').style.display = 'block';
  $('err-msg').textContent = `${MODEL_URL} — ${error?.message || 'network error'}`;
});

function onLoaded(gltf) {
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
  homeTarget.copy(sphere.center);
  explosion = createExplodedView(gltf, homeTarget);
  assembledRadius = sphere.radius || 3;
  framingRadius = assembledRadius;
  const expanded = fitted.clone().union(explosion.explodedBounds);
  explodedRadius = new THREE.Vector3(
    Math.max(homeTarget.x - expanded.min.x, expanded.max.x - homeTarget.x),
    Math.max(homeTarget.y - expanded.min.y, expanded.max.y - homeTarget.y),
    Math.max(homeTarget.z - expanded.min.z, expanded.max.z - homeTarget.z),
  ).length() || assembledRadius;
  const distance = explodedRadius * 3;
  camera.near = Math.max(distance / 5000, 0.001);
  camera.far = distance * 60;
  fitOrthographicCamera();
  controls.target.copy(homeTarget);
  camera.position.copy(homeTarget).addScaledVector(VIEW_DIRS.iso.clone().normalize(), distance);
  camera.lookAt(homeTarget);

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

  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  $('m-size').textContent = `${fmt(Math.max(rawSize.x, rawSize.y))} × ${fmt(Math.min(rawSize.x, rawSize.y))} × ${fmt(rawSize.z)} mm`;
  $('m-parts').textContent = fmt(explosion.parts.length);
  $('m-tris').textContent = fmt(triangleCount);
  for (const button of document.querySelectorAll('#views button, #dock button')) button.disabled = false;
  $('btn-explode').disabled = explosion.parts.length < 2;
  if (state.autoRotate) selectView(null);
  clearInterval(progressTimer);
  setProgress(100);
  $('loader').classList.add('hidden');
  document.body.classList.add('ready');
}

/* ---------------- 视角与取景 ---------------- */
function fitOrthographicCamera() {
  const aspect = window.innerWidth / Math.max(1, window.innerHeight);
  const halfHeight = framingRadius * 1.12 / Math.max(0.01, Math.min(aspect, 1));
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
}

function moveView(view, reset = false) {
  setAutoRotate(false);
  selectView(view);
  const from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
  const to = new THREE.Spherical().setFromVector3(VIEW_DIRS[view]);
  const angle = THREE.MathUtils.euclideanModulo(to.theta - from.theta + Math.PI, 2 * Math.PI) - Math.PI;
  const start = performance.now();
  viewTween = {
    from,
    phi: to.phi,
    angle,
    fromTarget: controls.target.clone(),
    toTarget: reset ? homeTarget : controls.target.clone(),
    start,
    duration: reducedMotion.matches ? 0 : 600,
  };
  if (reset) reframe(hasExplodedParts ? explodedRadius : assembledRadius, start);
  if (reducedMotion.matches) updateCamera(start);
}

function reframe(radius, start) {
  frameTween = {
    fromRadius: framingRadius / camera.zoom,
    toRadius: radius,
    start,
    duration: reducedMotion.matches ? 0 : EXPLODE_DURATION_MS,
  };
}

function updateCamera(now) {
  if (viewTween) {
    const { from, phi, angle, fromTarget, toTarget, start, duration } = viewTween;
    const t = duration ? THREE.MathUtils.clamp((now - start) / duration, 0, 1) : 1;
    const eased = t * t * (3 - 2 * t);
    controls.target.lerpVectors(fromTarget, toTarget, eased);
    camera.position.setFromSphericalCoords(from.radius, THREE.MathUtils.lerp(from.phi, phi, eased), from.theta + angle * eased);
    camera.position.add(controls.target);
    camera.lookAt(controls.target);
    if (t === 1) viewTween = null;
  }
  if (frameTween) {
    const { fromRadius, toRadius, start, duration } = frameTween;
    const t = duration ? THREE.MathUtils.clamp((now - start) / duration, 0, 1) : 1;
    framingRadius = THREE.MathUtils.lerp(fromRadius, toRadius, t);
    camera.zoom = 1;
    fitOrthographicCamera();
    if (t === 1) frameTween = null;
  }
}

/* ---------------- 爆炸图和点选 ---------------- */
const explodeButton = $('btn-explode');
function syncModeUI(restoredPart) {
  const status = $('explode-status');
  const remaining = explosion.parts.filter((part) => part.target === 1).length;
  hasExplodedParts = remaining > 0;
  press(explodeButton, hasExplodedParts);
  explodeButton.querySelector('span').textContent = hasExplodedParts ? '全部还原' : '爆炸图';
  explodeButton.title = hasExplodedParts ? '全部还原 (X)' : '展开部件 (X)';
  const message = restoredPart ? `还原 ${restoredPart}。` : '';
  status.textContent = hasExplodedParts ? `${message}点击展开的部件可还原 · 剩余 ${remaining} 件` : message;
  status.hidden = state.drawing || !status.textContent;
  $('drawing-tools').hidden = !state.drawing;
  $('tool-panel').hidden = $('drawing-tools').hidden && status.hidden;
}

function toggleExplosion() {
  const opening = !hasExplodedParts;
  const now = performance.now();
  setAutoRotate(false);
  explosion.setAll(opening, now, reducedMotion.matches);
  if (opening) {
    // 以模型中心取景，保证从已平移或放大过的视图也能看到所有部件。
    const delta = homeTarget.clone().sub(controls.target);
    controls.target.add(delta);
    camera.position.add(delta);
    viewTween = null;
  }
  reframe(opening ? explodedRadius : assembledRadius, now);
  syncModeUI();
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function restorePartAt(event) {
  if (!hasExplodedParts || state.drawing) return;
  const rect = surface.getBoundingClientRect();
  pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
  if (Math.abs(pointer.x) > 1 || Math.abs(pointer.y) > 1) return;
  camera.updateMatrixWorld();
  model.updateMatrixWorld(true);
  raycaster.setFromCamera(pointer, camera);
  const [hit] = raycaster.intersectObjects(explosion.meshes, false);
  const part = hit && explosion.partForMesh(hit.object);
  if (!part || !part.target) return;
  const now = performance.now();
  explosion.setPart(part, false, now, reducedMotion.matches);
  syncModeUI(part.name);
  if (!hasExplodedParts) reframe(assembledRadius, now);
}

const pointersDown = new Set();
let scenePress = null;
surface.addEventListener('pointerdown', (event) => {
  pointersDown.add(event.pointerId);
  scenePress = pointersDown.size === 1 && event.button === 0 ? event : null;
  if (pointersDown.size > 1 || event.button !== 0) {
    viewTween = null;
    selectView(null);
  }
});
window.addEventListener('pointermove', (event) => {
  if (!scenePress || event.pointerId !== scenePress.pointerId) return;
  if (Math.hypot(event.clientX - scenePress.clientX, event.clientY - scenePress.clientY) <= 6) return;
  scenePress = null;
  viewTween = null;
  selectView(null);
});
window.addEventListener('pointerup', (event) => {
  pointersDown.delete(event.pointerId);
  if (!scenePress || event.pointerId !== scenePress.pointerId) return;
  if (Math.hypot(event.clientX - scenePress.clientX, event.clientY - scenePress.clientY) <= 6) restorePartAt(event);
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
}

function screenshot() {
  renderer.clear();
  renderer.render(scene, camera);
  const image = document.createElement('canvas');
  image.width = surface.width;
  image.height = surface.height;
  const context = image.getContext('2d');
  context.drawImage(surface, 0, 0);
  drawing.drawTo(context, image.width, image.height);
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  image.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `dragondance-${stamp}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

/* ---------------- 坐标轴指示器与主循环 ---------------- */
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
  renderer.setViewport(window.innerWidth - size - pad, pad, size, size);
  renderer.setScissor(window.innerWidth - size - pad, pad, size, size);
  renderer.clearDepth();
  renderer.render(gizmoScene, gizmoCam);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
}

let lastTime = performance.now();
function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(Math.max(0, now - lastTime) / 1000, 0.05);
  lastTime = now;
  if (explosion) {
    explosion.update(now);
    controls.autoRotate = !state.drawing && !viewTween && state.autoRotate;
    if (!state.drawing) controls.update(dt);
    updateCamera(now);
  }
  renderer.clear();
  renderer.render(scene, camera);
  renderGizmo();
}
requestAnimationFrame(animate);

/* ---------------- 工具栏、快捷键和窗口大小 ---------------- */
for (const button of viewButtons) button.addEventListener('click', () => moveView(button.dataset.view));
explodeButton.addEventListener('click', toggleExplosion);
$('btn-draw').addEventListener('click', () => {
  state.drawing = !state.drawing;
  if (state.drawing) {
    setAutoRotate(false);
    const settled = performance.now() + EXPLODE_DURATION_MS;
    explosion.update(settled);
    updateCamera(settled);
  }
  drawing.setActive(state.drawing);
  controls.enabled = !state.drawing;
  press($('btn-draw'), state.drawing);
  $('btn-draw').querySelector('span').textContent = state.drawing ? '退出绘画' : '绘画';
  $('btn-draw').title = state.drawing ? '退出绘画 (Esc)' : '绘画 (D)';
  explodeButton.disabled = state.drawing || explosion.parts.length < 2;
  $('btn-rotate').disabled = state.drawing;
  $('btn-reset').disabled = state.drawing;
  for (const button of viewButtons) button.disabled = state.drawing;
  syncModeUI();
});
brushColor.addEventListener('input', () => drawing.setColor(brushColor.value));
brushWidth.addEventListener('input', () => {
  drawing.setWidth(brushWidth.valueAsNumber);
  $('brush-size').value = brushWidth.value;
});
$('btn-undo').addEventListener('click', () => drawing.undo());
$('btn-clear').addEventListener('click', () => drawing.clear());
$('btn-rotate').addEventListener('click', () => setAutoRotate(!state.autoRotate));
$('btn-wire').addEventListener('click', (event) => {
  state.wireframe = !state.wireframe;
  for (const material of materials) material.wireframe = state.wireframe;
  press(event.currentTarget, state.wireframe);
});
$('btn-grid').addEventListener('click', (event) => {
  state.grid = !state.grid;
  grid.visible = state.grid;
  press(event.currentTarget, state.grid);
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
  if (state.drawing && key === 'escape') {
    $('btn-draw').click();
    return;
  }
  if (event.repeat || event.altKey || event.target.matches?.('textarea, [contenteditable], input:not([type="color"]):not([type="range"])')) return;
  if ((event.ctrlKey || event.metaKey) && key === 'z' && !event.shiftKey && state.drawing) {
    event.preventDefault();
    drawing.undo();
    return;
  }
  if (!event.target.matches?.('input') && !event.ctrlKey && !event.metaKey && Object.hasOwn(shortcuts, key)) {
    $(`btn-${shortcuts[key]}`).click();
  }
});
window.addEventListener('resize', () => {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  fitOrthographicCamera();
});
