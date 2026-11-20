import * as THREE from 'three';

export const EXPLODE_DURATION_MS = 680;
const LABELS = new Map([
  ['前挡板 (1)', '前挡板'],
  ['=>[0:1:1:9]', '车身'],
  ['=>[0:1:1:15]', '前支撑'],
]);

// 世界坐标位移。现有模型的最长边为 6，前后挡板、车轮和支撑在原位几乎同心。
const CAD_OFFSETS = new Map([
  ['虚拟货物', [-0.05, 1.79, 1.72]],
  ['后车轮', [1.08, -0.32, 1.80]],
  ['后挡板', [0.25, 1.94, -2.42]],
  ['前挡板', [-0.32, 1.91, -0.05]],
  ['尾翼', [1.32, 0.52, -0.35]],
  ['车身', [0, -0.43, 0]],
  ['前翼', [-1.75, 0.10, 0.45]],
  ['头盔', [0.24, 3.12, -0.60]],
  ['halo', [0.03, 1.62, -0.85]],
  ['前车轮(镜像)', [-0.72, -0.28, 1.75]],
  ['前支撑', [-0.40, -2.19, 0.48]],
  ['后支撑', [0.68, -1.30, -1.25]],
  ['co2气瓶', [0.36, 2.39, 1.00]],
  ['鱼钩', [-0.05, -2.98, 0.20]],
]);

function collectParts({ scene, parser }) {
  const groups = new Map();
  const associations = parser?.associations;
  const nodeDefs = parser?.json?.nodes;
  const scratchBox = new THREE.Box3();
  scene.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.geometry?.getAttribute('position')?.count) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox.isEmpty()) return;

    // GLTFLoader 为多材质网格生成共享同一 mesh 索引的容器。
    // 选择最外层网格所有者，避免部件叠加继承两次位移。
    let owner = mesh;
    for (let parent = mesh.parent; parent && parent !== scene; parent = parent.parent) {
      const association = associations?.get(parent);
      const node = nodeDefs?.[association?.nodes];
      if (parent.isMesh || association?.meshes !== undefined || node?.mesh !== undefined) {
        owner = parent;
      }
    }

    if (!groups.has(owner)) groups.set(owner, { meshes: [], bounds: new THREE.Box3() });
    const group = groups.get(owner);
    group.meshes.push(mesh);
    group.bounds.union(scratchBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
  });
  return groups;
}

/** Create after the model has been oriented, centered, and scaled. Times share the RAF clock. */
export function createExplodedView(gltf, fittedCenter) {
  gltf.scene.updateWorldMatrix(true, true);
  const groups = collectParts(gltf);
  const assembledBounds = new THREE.Box3();
  for (const { bounds } of groups.values()) assembledBounds.union(bounds);
  const size = assembledBounds.getSize(new THREE.Vector3());
  const spreadScale = Math.max(size.x, size.y, size.z) / 6;
  const center = fittedCenter ?? assembledBounds.getCenter(new THREE.Vector3());

  const parts = [];
  const meshes = [];
  const byMesh = new Map();
  const motions = new Map();
  const explodedBounds = new THREE.Box3();
  const inverseParent = new THREE.Matrix3();

  for (const [object, group] of groups) {
    const label = String(object.userData.name || object.name).replace(/:\d+$/, '');
    const name = LABELS.get(label) ?? (label || `部件 ${parts.length + 1}`);
    const authoredOffset = CAD_OFFSETS.get(name);
    const worldOffset = new THREE.Vector3();
    if (authoredOffset) {
      worldOffset.fromArray(authoredOffset).multiplyScalar(spreadScale);
    } else {
      group.bounds.getCenter(worldOffset).sub(center);
      if (worldOffset.lengthSq() < 1e-12) {
        const angle = parts.length * Math.PI * (3 - Math.sqrt(5));
        worldOffset.set(Math.cos(angle), 0.35, Math.sin(angle));
      }
      worldOffset.normalize().multiplyScalar(1.6 * spreadScale);
    }

    // A displacement uses the inverse linear transform: no parent translation or normalization.
    const offset = worldOffset.clone();
    if (object.parent) {
      inverseParent.setFromMatrix4(object.parent.matrixWorld).invert();
      offset.applyMatrix3(inverseParent);
    }
    const origin = object.matrixAutoUpdate
      ? object.position.clone()
      : new THREE.Vector3().setFromMatrixPosition(object.matrix);
    const part = { name, object, meshes: group.meshes, progress: 0, target: 0 };
    parts.push(part);
    motions.set(part, { origin, offset, from: 0, startedAt: 0, duration: 0 });
    for (const mesh of group.meshes) {
      meshes.push(mesh);
      byMesh.set(mesh, part);
    }
    explodedBounds.union(group.bounds.clone().translate(worldOffset));
  }

  function advance(part, motion, now) {
    if (part.progress === part.target) return;
    const elapsed = Math.max(0, now - motion.startedAt);
    part.progress = elapsed >= motion.duration
      ? part.target
      : THREE.MathUtils.lerp(motion.from, part.target, elapsed / motion.duration);
    const { object } = part;
    object.position.copy(motion.origin);
    if (part.progress > 0) object.position.addScaledVector(motion.offset, part.progress);
    if (!object.matrixAutoUpdate) {
      object.matrix.setPosition(object.position);
      object.matrixWorldNeedsUpdate = true;
    }
  }

  function setPart(part, exploded, now = performance.now(), instant = false) {
    const motion = motions.get(part);
    if (!motion) return;
    const target = exploded ? 1 : 0;
    if (part.target === target && !instant) return;
    // Sample the outgoing animation at the event time, even between rendered frames.
    advance(part, motion, now);
    motion.from = part.progress;
    motion.startedAt = now;
    motion.duration = instant ? 0 : Math.abs(target - motion.from) * EXPLODE_DURATION_MS;
    part.target = target;
    if (instant) advance(part, motion, now);
  }

  function setAll(exploded, now = performance.now(), instant = false) {
    for (const part of parts) setPart(part, exploded, now, instant);
  }

  function update(now = performance.now()) {
    for (const [part, motion] of motions) advance(part, motion, now);
  }

  return { parts, meshes, partForMesh: (mesh) => byMesh.get(mesh), setAll, setPart, update, explodedBounds };
}
