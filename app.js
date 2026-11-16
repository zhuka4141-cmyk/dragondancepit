/* =============================================================
   FKU RJ · 3D 数字档案 — three.js 查看器
   - STEP(Z-up) 模型已离线转成 GLB，这里只负责渲染与交互
   - 所有资源使用相对路径，可直接放 GitHub Pages 的项目子目录
   ============================================================= */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const MODEL_URL = './model/fku_rj.glb';
const $ = (id) => document.getElementById(id);

const state = {
  autoRotate: true,
  wireframe: false,
  grid: true,
  edges: false,
};

/* ---------------- 渲染器 ---------------- */
const stage = $('stage');
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
stage.appendChild(renderer.domElement);

/* ---------------- 场景 / 相机 ---------------- */
const scene = new THREE.Scene();
const initialAspect = window.innerWidth / window.innerHeight;
const camera = new THREE.OrthographicCamera(-5 * initialAspect, 5 * initialAspect, 5, -5, 0.01, 20000);
camera.position.set(5, 4, 7);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

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

/* ---------------- 控制器 ---------------- */
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.rotateSpeed = 0.85;
controls.zoomSpeed = 0.9;
controls.panSpeed = 0.8;
controls.screenSpacePanning = true;
controls.minPolarAngle = 0;
controls.maxPolarAngle = Math.PI;      // 允许看到底面，360° 无死角
controls.autoRotate = state.autoRotate;
controls.autoRotateSpeed = 0.9;
controls.target.set(0, 0, 0);

/* ---------------- 模型容器 ---------------- */
const modelRoot = new THREE.Group();   // 用于局部坐标修正
const modelInner = new THREE.Group();  // 用于居中 / 缩放
modelRoot.add(modelInner);
scene.add(modelRoot);

const grid = new THREE.GridHelper(10, 20, 0x3a5f8f, 0x233247);
grid.material.transparent = true;
grid.material.opacity = 0.55;
grid.visible = state.grid;
scene.add(grid);

/* ---------------- 状态量 ---------------- */
let homeDir = new THREE.Vector3(1, 0.75, 1).normalize();
let homeDist = 10;
const homeTarget = new THREE.Vector3();
let modelRadius = 3;
let tween = null;
let edgesGroup = null;
let lastTime = performance.now();

/* ---------------- 加载 ---------------- */
let creep = 0;
let creepTimer = setInterval(() => {
  if (creep < 88) {
    creep += Math.max(0.4, (88 - creep) * 0.05);
    setProgress(creep);
  }
}, 180);

function setProgress(v) {
  const p = Math.max(0, Math.min(100, v));
  $('bar').style.width = p + '%';
  $('pct').textContent = Math.round(p) + '%';
}

new GLTFLoader().load(
  MODEL_URL,
  onLoaded,
  (evt) => {
    if (evt.lengthComputable && evt.total > 0) {
      setProgress((evt.loaded / evt.total) * 90);
    }
  },
  (err) => {
    clearInterval(creepTimer);
    console.error(err);
    $('loader').classList.add('hidden');
    $('err').style.display = 'block';
    $('err-msg').textContent = `${MODEL_URL} — ${err?.message || 'network error'}`;
  }
);

function onLoaded(gltf) {
  clearInterval(creepTimer);
  setProgress(100);

  const root = gltf.scene;

  /* GLB 使用米；交付模型已恢复 Z-up，界面显示时换算 mm。 */
  const rawBox = new THREE.Box3().setFromObject(root);
  const rawSize = rawBox.getSize(new THREE.Vector3()).multiplyScalar(1000);

  /* STEP 是 Z-up，three.js 是 Y-up → 绕 X 轴转 -90° */
  const orient = new THREE.Group();
  orient.rotation.x = -Math.PI / 2;
  orient.add(root);
  modelInner.add(orient);
  modelInner.updateMatrixWorld(true);

  /* 居中 + 归一化缩放（最大边 → 6 个单位） */
  const box = new THREE.Box3().setFromObject(modelInner);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 6 / maxDim;
  modelInner.scale.setScalar(scale);
  modelInner.position.copy(center).multiplyScalar(-scale);
  modelInner.updateMatrixWorld(true);

  /* 落地网格贴合底面 */
  const fitted = new THREE.Box3().setFromObject(modelInner);
  const fittedSize = fitted.getSize(new THREE.Vector3());
  grid.scale.setScalar(Math.max(fittedSize.x, fittedSize.z) / 10 + 0.15);
  grid.position.y = fitted.min.y;

  /* 相机包围球 */
  const sphere = fitted.getBoundingSphere(new THREE.Sphere());
  modelRadius = sphere.radius;
  homeDist = modelRadius * 3;
  camera.zoom = 1;
  fitOrthographicCamera();

  camera.near = Math.max(homeDist / 5000, 0.001);
  camera.far = homeDist * 60;
  camera.updateProjectionMatrix();

  controls.minZoom = 0.1;
  controls.maxZoom = 20;
  homeTarget.copy(sphere.center);
  controls.target.copy(homeTarget);

  camera.position.copy(sphere.center).addScaledVector(homeDir, homeDist);
  camera.lookAt(controls.target);
  controls.update();

  /* 材质规范化 + 统计 */
  let tris = 0;
  let meshes = 0;
  const seen = new Set();

  modelInner.traverse((obj) => {
    if (!obj.isMesh) return;
    meshes++;

    const matList = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of matList) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      if (m.isMeshStandardMaterial) {
        m.envMapIntensity = 1.15;
        if (!Number.isFinite(m.metalness) || m.metalness > 0.9) m.metalness = 0.35;
        if (!Number.isFinite(m.roughness) || m.roughness > 0.95) m.roughness = 0.42;
        m.side = THREE.FrontSide;
        m.flatShading = false;
        m.needsUpdate = true;
      }
    }

    const g = obj.geometry;
    if (g) {
      const count = g.index ? g.index.count : g.attributes.position.count;
      tris += Math.floor(count / 3);
    }
  });

  /* 写档案信息：Z 向尺寸即高度，X/Y 为长宽 */
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const w = Math.max(rawSize.x, rawSize.y);
  const d = Math.min(rawSize.x, rawSize.y);
  const h = rawSize.z;
  $('m-size').textContent = `${fmt(w)} × ${fmt(d)} × ${fmt(h)} mm`;
  $('m-parts').textContent = meshes.toLocaleString('en-US');
  $('m-tris').textContent = tris.toLocaleString('en-US');

  $('loader').classList.add('hidden');
  document.body.classList.add('ready');

  console.log(`[viewer] meshes=${meshes} triangles=${tris} units(step)=${w}x${d}x${h}`);
}

/* 正交投影消除近大远小；按短边适配模型，兼容手机竖屏。 */
function fitOrthographicCamera() {
  const aspect = window.innerWidth / window.innerHeight;
  const halfHeight = modelRadius * 1.12 / Math.min(aspect, 1);
  const halfWidth = halfHeight * aspect;
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.updateProjectionMatrix();
}

/* ---------------- 视角飞行 ---------------- */
function flyTo(dir, duration = 750) {
  const to = dir.clone().normalize().multiplyScalar(homeDist).add(controls.target);
  tween = {
    from: camera.position.clone(),
    to,
    t: 0,
    duration,
  };
  controls.autoRotate = false;
}

function updateTween(dt) {
  if (!tween) return;
  tween.t += dt * 1000;
  const k = Math.min(tween.t / tween.duration, 1);
  const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  camera.position.lerpVectors(tween.from, tween.to, e);
  camera.lookAt(controls.target);
  if (k >= 1) {
    tween = null;
    controls.autoRotate = state.autoRotate;
  }
}

const VIEW_DIRS = {
  front: new THREE.Vector3(0, 0, 1),
  back: new THREE.Vector3(0, 0, -1),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
  top: new THREE.Vector3(0, 1, 0.0015),
  bottom: new THREE.Vector3(0, -1, 0.0015),
  iso: new THREE.Vector3(1, 0.75, 1),
};

/* ---------------- 线框 / 轮廓 ---------------- */
const matCache = [];
function collectMaterials() {
  if (matCache.length) return;
  const seen = new Set();
  modelInner.traverse((o) => {
    if (!o.isMesh) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      if (m && !seen.has(m)) {
        seen.add(m);
        matCache.push(m);
      }
    }
  });
}

function applyWireframe() {
  collectMaterials();
  for (const m of matCache) m.wireframe = state.wireframe;
}

function toggleEdges() {
  if (edgesGroup) {
    scene.remove(edgesGroup);
    edgesGroup.traverse((o) => o.geometry && o.geometry.dispose());
    edgesGroup = null;
    return false;
  }
  let tris = 0;
  modelInner.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  });
  if (tris > 1_200_000) return 'too-many';

  edgesGroup = new THREE.Group();
  const cacheGeom = new Map();
  modelInner.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    let eg = cacheGeom.get(o.geometry);
    if (!eg) {
      try {
        eg = new THREE.EdgesGeometry(o.geometry, 28);
      } catch (e) {
        return;
      }
      cacheGeom.set(o.geometry, eg);
    }
    const line = new THREE.LineSegments(
      eg,
      new THREE.LineBasicMaterial({ color: 0x8ec5ff, transparent: true, opacity: 0.55 })
    );
    o.updateWorldMatrix(true, false);
    line.applyMatrix4(o.matrixWorld);
    edgesGroup.add(line);
  });
  scene.add(edgesGroup);
  return true;
}

/* ---------------- 截图 ---------------- */
function screenshot() {
  renderer.clear();
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  const a = document.createElement('a');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  a.href = url;
  a.download = `fku-rj-${stamp}.png`;
  a.click();
}

/* ---------------- 坐标轴指示器 ---------------- */
const gizmoScene = new THREE.Scene();
const gizmoCam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
gizmoCam.position.set(0, 0, 4.2);
gizmoCam.lookAt(0, 0, 0);

const gizmoObj = new THREE.Group();
gizmoObj.add(new THREE.AxesHelper(1.25));
const gizmoBall = new THREE.Mesh(
  new THREE.SphereGeometry(0.09, 12, 10),
  new THREE.MeshBasicMaterial({ color: 0xffffff })
);
gizmoScene.add(gizmoObj);
gizmoObj.add(gizmoBall);

function renderGizmo() {
  // setViewport/setScissor 接收 CSS 像素；renderer 会应用 pixelRatio。
  const s = 104;
  const pad = 18;
  gizmoObj.quaternion.copy(camera.quaternion).invert();

  renderer.setScissorTest(true);
  renderer.setViewport(window.innerWidth - s - pad, pad, s, s);
  renderer.setScissor(window.innerWidth - s - pad, pad, s, s);
  renderer.clearDepth();
  renderer.render(gizmoScene, gizmoCam);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
}

/* ---------------- 主循环 ---------------- */
function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  updateTween(dt);
  controls.autoRotate = tween ? false : state.autoRotate;
  controls.update(dt);

  renderer.clear();
  renderer.render(scene, camera);
  renderGizmo();
}
requestAnimationFrame(animate);

/* ---------------- 交互绑定 ---------------- */
document.querySelectorAll('[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const dir = VIEW_DIRS[btn.dataset.view];
    if (dir) flyTo(dir);
  });
});

$('btn-rotate').addEventListener('click', (e) => {
  state.autoRotate = !state.autoRotate;
  e.currentTarget.classList.toggle('on', state.autoRotate);
});

$('btn-wire').addEventListener('click', (e) => {
  state.wireframe = !state.wireframe;
  applyWireframe();
  e.currentTarget.classList.toggle('on', state.wireframe);
});

$('btn-grid').addEventListener('click', (e) => {
  state.grid = !state.grid;
  grid.visible = state.grid;
  e.currentTarget.classList.toggle('on', state.grid);
});

$('btn-edges').addEventListener('click', (e) => {
  const ok = toggleEdges();
  if (ok === 'too-many') {
    alert('模型面数较多（>120 万三角面），轮廓线可能导致卡顿，已跳过。');
    return;
  }
  state.edges = !!edgesGroup;
  e.currentTarget.classList.toggle('on', state.edges);
});

$('btn-reset').addEventListener('click', () => {
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  controls.target.copy(homeTarget);
  flyTo(homeDir, 800);
});

$('btn-shot').addEventListener('click', screenshot);

$('btn-full').addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen?.();
    } else {
      await document.exitFullscreen?.();
    }
  } catch (err) {
    console.warn('当前浏览器未允许全屏:', err);
  }
});

/* ---------------- 快捷键 ---------------- */
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'r') $('btn-rotate').click();
  else if (k === 'w') $('btn-wire').click();
  else if (k === 'g') $('btn-grid').click();
  else if (k === 'e') $('btn-edges').click();
  else if (k === '0') $('btn-reset').click();
  else if (k === 'f') $('btn-full').click();
  else if (k === 's') screenshot();
});

/* ---------------- 自适应 ---------------- */
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  fitOrthographicCamera();
  controls.update();
});

/* 触屏设备默认关闭自动旋转，避免误触 */
if (window.matchMedia('(pointer: coarse)').matches) {
  state.autoRotate = false;
  $('btn-rotate').classList.remove('on');
}
