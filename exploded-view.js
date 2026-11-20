import * as THREE from 'three';

export const EXPLODE_DURATION_MS = 680;
const MAX_EXPLOSION = 1.5;
const CATEGORIES = [
  { id: 'frontWing', label: '前翼', detail: '车头翼面' },
  { id: 'rearWing', label: '后翼', detail: '尾部翼面' },
  { id: 'wheels', label: '轮子', detail: '四轮与轮毂' },
  { id: 'supports', label: '轮子支撑', detail: '前后支撑与圆形挡板' },
  { id: 'halo', label: 'Halo', detail: '座舱保护架' },
];
const LABELS = new Map([
  ['前挡板 (1)', '前挡板'],
  ['=>[0:1:1:9]', '车身'],
  ['=>[0:1:1:15]', '前支撑'],
  ['halo', 'Halo'],
]);
const CAD_GROUPS = new Map([
  ['前翼', 'frontWing'],
  ['尾翼', 'rearWing'],
  ['后车轮', 'wheels'],
  ['前车轮(镜像)', 'wheels'],
  ['前支撑', 'supports'],
  ['后支撑', 'supports'],
  ['前挡板', 'supports'],
  ['后挡板', 'supports'],
  ['Halo', 'halo'],
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

    // GLTFLoader can put multiple material primitives under a shared CAD node.
    // Move the outermost owner once so its primitives stay together.
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

function copyTriangles(source, indices) {
  const geometry = new THREE.BufferGeometry();
  const remap = new Map();
  const vertices = [];
  geometry.setIndex(indices.map((index) => {
    if (!remap.has(index)) {
      remap.set(index, vertices.length);
      vertices.push(index);
    }
    return remap.get(index);
  }));
  for (const [name, attribute] of Object.entries(source.attributes)) {
    const { array, itemSize, normalized } = attribute;
    const stride = attribute.isInterleavedBufferAttribute ? attribute.data.stride : itemSize;
    const offset = attribute.isInterleavedBufferAttribute ? attribute.offset : 0;
    const values = new array.constructor(vertices.length * itemSize);
    vertices.forEach((index, destination) => {
      const start = index * stride + offset;
      for (let component = 0; component < itemSize; component++) {
        values[destination * itemSize + component] = array[start + component];
      }
    });
    geometry.setAttribute(name, new THREE.BufferAttribute(values, itemSize, normalized));
  }
  geometry.computeBoundingBox();
  return geometry;
}

function splitWheelPair(object, group, name, centerZ, length) {
  if (group.meshes.length !== 1 || group.meshes[0] !== object ||
      !object.parent || object.children.length || !object.isMesh || object.isSkinnedMesh) return null;
  const { geometry, parent } = object;
  const position = geometry.getAttribute('position');
  const { index, drawRange } = geometry;
  if (!index || index.count % 3 || geometry.groups.length || drawRange.start !== 0 ||
      drawRange.count < index.count || Object.keys(geometry.morphAttributes).length) return null;

  // Each Dragondance axle's wheel primitive contains two disconnected sides.
  // Classify vertices in fitted coordinates and split only across a proven empty seam.
  const tolerance = length * 1e-6;
  const sides = new Int8Array(position.count);
  const point = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    const z = point.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld).z - centerZ;
    sides[i] = z > tolerance ? 1 : z < -tolerance ? -1 : 0;
  }
  const left = [];
  const right = [];
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    const side = sides[a];
    if (!side || sides[b] !== side || sides[c] !== side) return null;
    (side > 0 ? left : right).push(a, b, c);
  }
  if (!left.length || !right.length) return null;

  const axle = name.startsWith('前') ? '前轮' : '后轮';
  function makeSide(indices, side, sideLabel, suffix) {
    const mesh = object.clone(false);
    mesh.name = `${object.name}_${suffix}`;
    mesh.geometry = copyTriangles(geometry, indices);
    parent.add(mesh);
    mesh.updateWorldMatrix(false, false);
    const bounds = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    return { object: mesh, meshes: [mesh], bounds, name: `${sideLabel}${axle}`, side };
  }
  // Use a fixed side order for stable surface-paint mesh indices.
  const pieces = [makeSide(left, 1, '左', 'left'), makeSide(right, -1, '右', 'right')];
  object.removeFromParent();
  return pieces;
}

function worldOffsetFor(category, side, length) {
  // The reference's front (+Z) and lateral (X) directions map to -X and Z here.
  // Axle supports span both sides. Their matching guards travel below the chassis with them.
  switch (category) {
    case 'frontWing': return new THREE.Vector3(-0.25, 0.015, 0).multiplyScalar(length);
    case 'rearWing': return new THREE.Vector3(0.24, 0.10, 0).multiplyScalar(length);
    case 'wheels': return new THREE.Vector3(0, 0, side * 0.24).multiplyScalar(length);
    case 'supports': return new THREE.Vector3(0, -0.09, 0).multiplyScalar(length);
    case 'halo': return new THREE.Vector3(0, 0.32, 0).multiplyScalar(length);
    default: return new THREE.Vector3();
  }
}

function clampAmount(amount) {
  return Number.isFinite(amount) ? THREE.MathUtils.clamp(amount, 0, MAX_EXPLOSION) : 0;
}

/** Create after the model has been oriented, centered, and scaled. Times share the RAF clock. */
export function createExplodedView(gltf, fittedCenter) {
  gltf.scene.updateWorldMatrix(true, true);
  const groups = collectParts(gltf);
  const assembledBounds = new THREE.Box3();
  for (const { bounds } of groups.values()) assembledBounds.union(bounds);
  const size = assembledBounds.getSize(new THREE.Vector3());
  const length = Math.max(size.x, size.y, size.z);
  const center = fittedCenter ?? assembledBounds.getCenter(new THREE.Vector3());
  const parts = [];
  const meshes = [];
  const byMesh = new Map();
  const motions = new Map();
  const inverseParent = new THREE.Matrix3();

  for (const [object, group] of groups) {
    const label = String(object.userData.name || object.name).replace(/:\d+$/, '');
    const name = LABELS.get(label) ?? (label || `部件 ${parts.length + 1}`);
    const category = CAD_GROUPS.get(name) ?? null;
    const split = category === 'wheels' ? splitWheelPair(object, group, name, center.z, length) : null;
    const side = Math.sign(group.bounds.getCenter(new THREE.Vector3()).z - center.z) || 1;
    for (const piece of split ?? [{ ...group, object, name, side }]) {
      const worldOffset = worldOffsetFor(category, piece.side, length);
      const offset = worldOffset.clone();
      // A displacement uses the inverse linear transform, with no parent translation.
      if (piece.object.parent) {
        inverseParent.setFromMatrix4(piece.object.parent.matrixWorld).invert();
        offset.applyMatrix3(inverseParent);
      }
      const origin = piece.object.matrixAutoUpdate
        ? piece.object.position.clone()
        : new THREE.Vector3().setFromMatrixPosition(piece.object.matrix);
      const part = { name: piece.name, object: piece.object, meshes: piece.meshes, category, progress: 0, target: 0 };
      parts.push(part);
      motions.set(part, { origin, offset, worldOffset, bounds: piece.bounds, from: 0, startedAt: 0, duration: 0 });
      for (const mesh of part.meshes) {
        meshes.push(mesh);
        byMesh.set(mesh, part);
      }
    }
  }
  const availableIds = new Set(parts.map(({ category }) => category));
  const categories = CATEGORIES.filter(({ id }) => availableIds.has(id));

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

  function setGroups(selectedIds, amount, now = performance.now(), instant = false) {
    const selected = new Set(selectedIds);
    const distance = clampAmount(amount);
    for (const [part, motion] of motions) {
      const target = part.category && selected.has(part.category) ? distance : 0;
      if (part.target === target && !instant) continue;
      // Sample the outgoing animation at the event time, even between rendered frames.
      advance(part, motion, now);
      motion.from = part.progress;
      motion.startedAt = now;
      motion.duration = instant ? 0 : Math.abs(target - motion.from) * EXPLODE_DURATION_MS;
      part.target = target;
      if (instant) advance(part, motion, now);
    }
  }

  function update(now = performance.now()) {
    for (const [part, motion] of motions) advance(part, motion, now);
  }

  function getBounds(selectedIds, amount) {
    const selected = new Set(selectedIds);
    const distance = clampAmount(amount);
    const result = new THREE.Box3();
    const box = new THREE.Box3();
    const displacement = new THREE.Vector3();
    for (const [part, { bounds, worldOffset }] of motions) {
      if (distance && selected.has(part.category)) {
        result.union(box.copy(bounds).translate(displacement.copy(worldOffset).multiplyScalar(distance)));
      } else {
        result.union(bounds);
      }
    }
    return result;
  }

  return {
    categories,
    parts,
    meshes,
    partForMesh: (mesh) => byMesh.get(mesh),
    setGroups,
    update,
    getBounds,
    explodedBounds: getBounds(availableIds, MAX_EXPLOSION),
  };
}
