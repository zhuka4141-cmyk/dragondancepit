/* Surface annotations live in the same local coordinates as their source mesh. */
import * as THREE from 'three';

const FORMAT = 'dragondance-surface-drawing';
const MAX_STROKES = 10_000;
const MAX_STAMPS = 100_000;
const MAX_VERTICES = 3_000_000;
const MAX_HISTORY = 100;
const BRUSH_ALIGNMENT = 0.55;
const VERTEX_STRIDE = 9; // local position, local normal, brush UV, sample opacity
const COLOR = /^#[0-9a-f]{6}$/i;
const opacityIsValid = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const vectorIsValid = (value) => value && Number.isFinite(value.x) &&
  Number.isFinite(value.y) && Number.isFinite(value.z);

function readTriangle(index, face, a, b, c) {
  const offset = face * 3;
  a.fromBufferAttribute(index.position, index.vertices[offset]);
  b.fromBufferAttribute(index.position, index.vertices[offset + 1]);
  c.fromBufferAttribute(index.position, index.vertices[offset + 2]);
}

function readNormal(index, face, normal) {
  return normal.fromArray(index.faceNormals, face * 3);
}

// One local-space BVH serves both ray picking and brush projection. The model's
// part transforms never affect the index, and meshes can share a geometry.
function buildIndex(geometry, box, weldDistance) {
  const position = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  const sourceIndex = geometry.index;
  const count = Math.floor((sourceIndex?.count ?? position.count) / 3);
  const vertices = new Uint32Array(count * 3);
  const faceNormals = new Float32Array(count * 3);
  const order = new Uint32Array(count);
  const bounds = new Float64Array(count * 6);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const index = { position, normals, vertices, faceNormals, order, box, weldDistance };
  for (let offset = 0; offset < vertices.length; offset++) {
    vertices[offset] = sourceIndex ? sourceIndex.getX(offset) : offset;
  }
  for (let face = 0; face < count; face++) {
    order[face] = face;
    readTriangle(index, face, a, b, c);
    normal.subVectors(b, a).cross(edge.subVectors(c, a)).normalize().toArray(faceNormals, face * 3);
    const offset = face * 6;
    bounds[offset] = Math.min(a.x, b.x, c.x);
    bounds[offset + 1] = Math.min(a.y, b.y, c.y);
    bounds[offset + 2] = Math.min(a.z, b.z, c.z);
    bounds[offset + 3] = Math.max(a.x, b.x, c.x);
    bounds[offset + 4] = Math.max(a.y, b.y, c.y);
    bounds[offset + 5] = Math.max(a.z, b.z, c.z);
  }

  function split(start, end, depth) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const offset = order[i] * 6;
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], bounds[offset + axis]);
        max[axis] = Math.max(max[axis], bounds[offset + axis + 3]);
      }
    }
    const node = { min, max, start, end };
    if (end - start <= 12) return node;
    let axis = 0;
    for (let i = 1; i < 3; i++) {
      if (max[i] - min[i] > max[axis] - min[axis]) axis = i;
    }
    const middle = min[axis] + max[axis];
    let pivot = start;
    if (depth < 32) {
      for (let i = start; i < end; i++) {
        const offset = order[i] * 6 + axis;
        if (bounds[offset] + bounds[offset + 3] >= middle) continue;
        const face = order[i];
        order[i] = order[pivot];
        order[pivot++] = face;
      }
    }
    if (pivot === start || pivot === end) pivot = start + ((end - start) >> 1);
    node.left = split(start, pivot, depth + 1);
    node.right = split(pivot, end, depth + 1);
    return node;
  }

  index.root = count ? split(0, count, 0) : null;
  index.welded = new Int32Array(position.count).fill(-1);
  index.weldKeys = new Map();
  return index;
}

function rayEntry(node, origin, direction, near, far) {
  for (let axis = 0; axis < 3; axis++) {
    const o = origin[axis];
    const d = direction[axis];
    if (d === 0) {
      if (o < node.min[axis] || o > node.max[axis]) return Infinity;
      continue;
    }
    const a = (node.min[axis] - o) / d;
    const b = (node.max[axis] - o) / d;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (far < near) return Infinity;
  }
  return near;
}

function forFacesInBox(index, min, max, callback) {
  if (!index.root) return;
  const stack = [index.root];
  while (stack.length) {
    const node = stack.pop();
    if (node.max[0] < min.x || node.min[0] > max.x ||
        node.max[1] < min.y || node.min[1] > max.y ||
        node.max[2] < min.z || node.min[2] > max.z) continue;
    if (node.left) stack.push(node.right, node.left);
    else for (let i = node.start; i < node.end; i++) callback(index.order[i]);
  }
}

function materialForFace(mesh, face) {
  const offset = face * 3;
  const { start, count } = mesh.geometry.drawRange;
  if (offset < start || offset + 2 >= start + count) return undefined;
  if (!Array.isArray(mesh.material)) return mesh.material;
  const group = mesh.geometry.groups.find((g) => offset >= g.start && offset + 2 < g.start + g.count);
  return group && mesh.material[group.materialIndex];
}

function pickFace(index, mesh, ray, near, far) {
  if (!index.root) return null;
  const origin = ray.origin.toArray();
  const direction = ray.direction.toArray();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const point = new THREE.Vector3();
  const localHit = new THREE.Vector3();
  const normal = new THREE.Vector3();
  let closest = far;
  let selected = -1;

  function visit(node, entry) {
    if (entry === Infinity || entry > closest) return;
    if (node.left) {
      const left = rayEntry(node.left, origin, direction, near, closest);
      const right = rayEntry(node.right, origin, direction, near, closest);
      if (left <= right) {
        visit(node.left, left);
        visit(node.right, right);
      } else {
        visit(node.right, right);
        visit(node.left, left);
      }
      return;
    }
    for (let i = node.start; i < node.end; i++) {
      const face = index.order[i];
      const material = materialForFace(mesh, face);
      if (!material?.visible) continue;
      readTriangle(index, face, a, b, c);
      const hit = material.side === THREE.BackSide
        ? ray.intersectTriangle(c, b, a, true, point)
        : ray.intersectTriangle(a, b, c, material.side !== THREE.DoubleSide, point);
      if (!hit) continue;
      const distance = ray.origin.distanceTo(point);
      if (distance < near || distance > closest ||
          (distance === closest && selected >= 0 && face > selected)) continue;
      selected = face;
      closest = distance;
      localHit.copy(point);
      readNormal(index, face, normal);
      if (normal.dot(ray.direction) > 0) normal.negate();
    }
  }

  visit(index.root, rayEntry(index.root, origin, direction, near, far));
  return selected < 0 ? null : { face: selected, point: localHit, normal, distance: closest };
}

function weldedVertex(index, vertex) {
  if (index.welded[vertex] >= 0) return index.welded[vertex];
  const { box, position, weldDistance, weldKeys } = index;
  const x = Math.round((position.getX(vertex) - box.min.x) / weldDistance);
  const y = Math.round((position.getY(vertex) - box.min.y) / weldDistance);
  const z = Math.round((position.getZ(vertex) - box.min.z) / weldDistance);
  const key = `${x},${y},${z}`;
  if (!weldKeys.has(key)) weldKeys.set(key, weldKeys.size);
  return (index.welded[vertex] = weldKeys.get(key));
}

function clipPolygon(input, axis, sign, limit) {
  if (!input.some((vertex) => sign * vertex[axis] > limit)) return input;
  const output = [];
  let previous = input.at(-1);
  let previousDistance = sign * previous[axis] - limit;
  for (const current of input) {
    const distance = sign * current[axis] - limit;
    if ((distance > 0) !== (previousDistance > 0)) {
      const fraction = previousDistance / (previousDistance - distance);
      output.push(previous.map((value, i) => value + (current[i] - value) * fraction));
    }
    if (distance <= 0) output.push(current);
    previous = current;
    previousDistance = distance;
  }
  return output;
}

function touchesDisk(polygon, radius) {
  let positive = false;
  let negative = false;
  let previous = polygon.at(-1);
  for (const point of polygon) {
    const dx = point[0] - previous[0];
    const dy = point[1] - previous[1];
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq ? THREE.MathUtils.clamp(-(previous[0] * dx + previous[1] * dy) / lengthSq, 0, 1) : 0;
    const x = previous[0] + dx * t;
    const y = previous[1] + dy * t;
    if (x * x + y * y <= radius * radius) return true;
    const cross = previous[0] * point[1] - previous[1] * point[0];
    if (cross > 0) positive = true;
    if (cross < 0) negative = true;
    previous = point;
  }
  return !(positive && negative); // the origin is inside this convex polygon
}

function anchorFace(index, record, point, normal, hint) {
  const triangle = new THREE.Triangle();
  const closest = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();
  let anchor = null;

  function check(face) {
    if (anchor || !Number.isInteger(face) || face < 0 || face * 3 >= index.vertices.length) return;
    const material = materialForFace(record.mesh, face);
    if (!material) return;
    const alignment = readNormal(index, face, faceNormal).dot(normal);
    if (Math.abs(alignment) < BRUSH_ALIGNMENT ||
        (alignment > 0 && material.side === THREE.BackSide) ||
        (alignment < 0 && material.side === THREE.FrontSide)) return;
    readTriangle(index, face, triangle.a, triangle.b, triangle.c);
    triangle.closestPointToPoint(point, closest);
    if (closest.distanceToSquared(point) <= record.epsilon ** 2) {
      anchor = { face, sign: Math.sign(alignment) };
    }
  }

  if (hint !== undefined) check(hint);
  else {
    const epsilon = new THREE.Vector3().setScalar(record.epsilon);
    forFacesInBox(index, point.clone().sub(epsilon), point.clone().add(epsilon), check);
  }
  return anchor;
}

// Clip source triangles against the brush box, keeping the connected patch
// touched by the ray. Welding duplicate positions keeps smooth CAD seams closed.
function projectStamp(index, record, stamp, vertexLimit, facesOnly = false) {
  const { point, normal, diameter, opacity } = stamp;
  const anchor = anchorFace(index, record, point, normal, stamp.face);
  if (!anchor) return null;
  const { face, sign } = anchor;
  const radius = diameter / 2;
  const depth = radius * 0.6;
  const tangent = new THREE.Vector3(Math.abs(normal.x) < 0.8 ? 1 : 0, Math.abs(normal.x) < 0.8 ? 0 : 1, 0)
    .cross(normal).normalize();
  const bitangent = new THREE.Vector3().crossVectors(normal, tangent);
  const extent = new THREE.Vector3();
  for (let axis = 0; axis < 3; axis++) {
    extent.setComponent(axis, (Math.abs(tangent.getComponent(axis)) +
      Math.abs(bitangent.getComponent(axis))) * radius + Math.abs(normal.getComponent(axis)) * depth);
  }
  const vertex = new THREE.Vector3();
  const vertexNormal = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();
  const entries = [];
  const edges = new Map();
  let anchorEntry;

  function root(entry) {
    while (entry.parent !== entry) {
      entry.parent = entry.parent.parent;
      entry = entry.parent;
    }
    return entry;
  }

  forFacesInBox(index, point.clone().sub(extent), point.clone().add(extent), (candidate) => {
    readNormal(index, candidate, faceNormal).multiplyScalar(sign);
    if (faceNormal.dot(normal) < BRUSH_ALIGNMENT) return;
    const material = materialForFace(record.mesh, candidate);
    if (!material || material.side === (sign > 0 ? THREE.BackSide : THREE.FrontSide)) return;
    const ids = [];
    let polygon = [];
    for (let i = 0; i < 3; i++) {
      const id = index.vertices[candidate * 3 + (sign > 0 ? i : 2 - i)];
      ids.push(id);
      vertex.fromBufferAttribute(index.position, id).sub(point);
      if (index.normals) vertexNormal.fromBufferAttribute(index.normals, id).multiplyScalar(sign);
      if (!index.normals || !(vertexNormal.dot(faceNormal) > 0)) vertexNormal.copy(faceNormal);
      polygon.push([vertex.dot(tangent), vertex.dot(bitangent), vertex.dot(normal),
        vertexNormal.x, vertexNormal.y, vertexNormal.z]);
    }
    for (let axis = 0; axis < 3; axis++) {
      const limit = axis === 2 ? depth : radius;
      polygon = clipPolygon(polygon, axis, 1, limit);
      if (polygon.length < 3) return;
      polygon = clipPolygon(polygon, axis, -1, limit);
      if (polygon.length < 3) return;
    }
    if (!touchesDisk(polygon, radius)) return;
    const entry = { face: candidate, polygon };
    entry.parent = entry;
    entries.push(entry);
    if (candidate === face) anchorEntry = entry;
    const weld = ids.map((id) => weldedVertex(index, id));
    for (let i = 0; i < 3; i++) {
      const a = weld[i];
      const b = weld[(i + 1) % 3];
      if (a === b) continue;
      const key = Math.min(a, b) * index.position.count + Math.max(a, b);
      const neighbor = edges.get(key);
      if (neighbor) root(entry).parent = root(neighbor);
      else edges.set(key, entry);
    }
  });
  if (!anchorEntry) return null;

  const component = root(anchorEntry);
  const values = [];
  const faces = [];
  // Shift the entire patch along the hit normal, so shared triangle edges stay together.
  const origin = point.clone().addScaledVector(normal, record.offset);
  const projected = new THREE.Vector3();
  function emit([x, y, z, nx, ny, nz]) {
    projected.copy(origin).addScaledVector(tangent, x).addScaledVector(bitangent, y).addScaledVector(normal, z);
    values.push(projected.x, projected.y, projected.z, nx, ny, nz,
      0.5 + x / diameter, 0.5 + y / diameter, opacity);
  }

  for (const entry of entries) {
    if (root(entry) !== component) continue;
    faces.push(entry.face);
    if (facesOnly) continue;
    const { polygon } = entry;
    if (values.length / VERTEX_STRIDE + (polygon.length - 2) * 3 > vertexLimit) return null;
    for (let i = 1; i < polygon.length - 1; i++) {
      emit(polygon[0]);
      emit(polygon[i]);
      emit(polygon[i + 1]);
    }
  }
  faces.sort((a, b) => a - b);
  return { face, faces, values };
}

function brushMaterial(color, soft) {
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.82,
    metalness: 0,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  material.onBeforeCompile = (shader) => {
    const varyings = 'varying vec2 vBrushUv;\nvarying float vBrushOpacity;\n';
    shader.vertexShader = 'attribute float brushOpacity;\n' + varyings + shader.vertexShader.replace(
      '#include <uv_vertex>', '#include <uv_vertex>\nvBrushUv = uv;\nvBrushOpacity = brushOpacity;',
    );
    shader.fragmentShader = varyings + shader.fragmentShader.replace(
      '#include <alphatest_fragment>', `
        #include <alphatest_fragment>
        float radius = length(vBrushUv * 2.0 - 1.0);
        float edge = clamp(fwidth(radius), 0.0001, 0.5);
        float brushAlpha = 1.0 - smoothstep(1.0 - edge, 1.0, radius);
        ${soft ? 'brushAlpha *= 1.0 - smoothstep(0.5, 1.0, radius);' : ''}
        diffuseColor.a *= vBrushOpacity * brushAlpha;
        if (diffuseColor.a <= 0.0) discard;
      `,
    );
  };
  material.customProgramCacheKey = () => soft ? 'dragondance-soft-brush' : 'dragondance-hard-brush';
  return material;
}

function newStroke(color, opacity, soft, order) {
  return { color, opacity, soft, order, stamps: [], batches: new Map(), vertexCount: 0, material: null };
}

function appendPatch(stroke, record, patch, stamp, attach) {
  let batch = stroke.batches.get(record);
  const additional = patch.values.length / VERTEX_STRIDE;
  if (!batch) {
    stroke.material ??= brushMaterial(stroke.color, stroke.soft);
    const decal = new THREE.Mesh(new THREE.BufferGeometry(), stroke.material);
    decal.renderOrder = 21 + stroke.order;
    decal.name = 'Surface drawing';
    decal.layers.mask = record.mesh.layers.mask;
    decal.raycast = () => {};
    batch = { decal, count: 0, capacity: 0, stamps: [], box: new THREE.Box3(), sphere: new THREE.Sphere() };
    stroke.batches.set(record, batch);
    if (attach) record.mesh.add(decal);
  }

  const count = batch.count + additional;
  if (count > batch.capacity) {
    // Three's WebGL buffers cannot resize in place. Grow geometrically and release the old allocation.
    batch.capacity = Math.max(count, 128, batch.capacity * 2);
    const values = new Float32Array(batch.capacity * VERTEX_STRIDE);
    if (batch.buffer) values.set(batch.buffer.array.subarray(0, batch.count * VERTEX_STRIDE));
    const buffer = new THREE.InterleavedBuffer(values, VERTEX_STRIDE).setUsage(THREE.DynamicDrawUsage);
    // The first upload writes the entire buffer and otherwise leaves its ranges queued.
    buffer.onUpload(() => buffer.clearUpdateRanges());
    batch.buffer = buffer;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(batch.buffer, 3, 0));
    geometry.setAttribute('normal', new THREE.InterleavedBufferAttribute(batch.buffer, 3, 3));
    geometry.setAttribute('uv', new THREE.InterleavedBufferAttribute(batch.buffer, 2, 6));
    geometry.setAttribute('brushOpacity', new THREE.InterleavedBufferAttribute(batch.buffer, 1, 8));
    geometry.boundingBox = batch.box;
    geometry.boundingSphere = batch.sphere;
    batch.decal.geometry.dispose();
    batch.decal.geometry = geometry;
  }
  const offset = batch.count * VERTEX_STRIDE;
  batch.buffer.array.set(patch.values, offset);
  batch.buffer.addUpdateRange(offset, patch.values.length);
  batch.buffer.needsUpdate = true;
  batch.count = count;
  batch.decal.geometry.setDrawRange(0, count);
  const vertex = new THREE.Vector3();
  for (let i = offset; i < count * VERTEX_STRIDE; i += VERTEX_STRIDE) {
    batch.box.expandByPoint(vertex.fromArray(batch.buffer.array, i));
  }
  batch.box.getBoundingSphere(batch.sphere);
  stamp.face = patch.face;
  stamp.faces = patch.faces;
  batch.stamps.push(stamp);
  stroke.stamps.push(stamp);
  stroke.vertexCount += additional;
}

function setAttached(stroke, attached) {
  for (const [record, { decal }] of stroke.batches) {
    if (attached && decal.parent !== record.mesh) record.mesh.add(decal);
    else if (!attached) decal.removeFromParent();
  }
}

function disposeStroke(stroke) {
  setAttached(stroke, false);
  for (const { decal } of stroke.batches.values()) decal.geometry.dispose();
  stroke.material?.dispose();
}

function shareFace(a, b) {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) return true;
    if (a[i] < b[j]) i++;
    else j++;
  }
  return false;
}

function validLocation(record, point, diameter) {
  return vectorIsValid(point) && record.paddedBox.containsPoint(point) &&
    Number.isFinite(diameter) && diameter >= record.minDiameter && diameter <= record.maxDiameter;
}

export function createSurfaceDrawing({ meshes, modelKey, onChange = () => {} }) {
  const records = meshes.map((mesh, id) => {
    const { geometry } = mesh;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox.clone();
    const diagonal = box.getSize(new THREE.Vector3()).length();
    const epsilon = Math.max(diagonal * 1e-5, 1e-9);
    return {
      id, mesh, box, paddedBox: box.clone().expandByScalar(epsilon), epsilon,
      offset: Math.max(diagonal * 1e-5, 1e-9),
      minDiameter: Math.max(diagonal * 1e-6, 1e-9),
      maxDiameter: diagonal * 4,
    };
  });
  const byMesh = new Map(records.map((record) => [record.mesh, record]));
  const indices = new WeakMap();
  const hitFaces = new WeakMap();
  const inverse = new THREE.Matrix4();
  const inverseLinear = new THREE.Matrix3();
  const localRay = new THREE.Ray();
  const scratch = new THREE.Vector3();
  let current = null;
  let nextOrder = 0;
  let stampCount = 0;
  let vertexCount = 0;
  let retainedStamps = 0;
  let retainedVertices = 0;
  const known = new Set();
  const visible = new Set();
  const history = [];
  const future = [];

  function indexFor(record) {
    const { geometry } = record.mesh;
    if (!indices.has(geometry)) {
      indices.set(geometry, buildIndex(geometry, record.box, Math.max(record.epsilon * 0.01, 1e-10)));
    }
    return indices.get(geometry);
  }

  function hitTest(raycaster) {
    let best = null;
    let far = raycaster.far;
    for (const record of records) {
      const { mesh } = record;
      if (!raycaster.layers.test(mesh.layers)) continue;
      let object = mesh;
      while (object?.visible) object = object.parent;
      if (object) continue;
      mesh.updateWorldMatrix(true, false);
      inverse.copy(mesh.matrixWorld).invert();
      localRay.origin.copy(raycaster.ray.origin).applyMatrix4(inverse);
      localRay.direction.copy(raycaster.ray.direction).applyMatrix3(inverseLinear.setFromMatrix4(inverse));
      const scale = localRay.direction.length();
      if (!Number.isFinite(scale) || scale <= 0) continue;
      localRay.direction.multiplyScalar(1 / scale);
      if (!localRay.intersectBox(record.box, scratch)) continue;
      const hit = pickFace(indexFor(record), mesh, localRay, raycaster.near * scale, far * scale);
      if (!hit) continue;
      const distance = hit.distance / scale;
      if (best && distance >= far) continue;
      far = distance;
      best = { mesh, point: hit.point, normal: hit.normal, distance };
      hitFaces.set(best, hit.face);
    }
    return best;
  }

  function notify() {
    onChange({ hasStrokes: visible.size > 0, canUndo: history.length > 0, canRedo: future.length > 0 });
  }

  function setVisible(stroke, showing) {
    if (showing === visible.has(stroke)) return;
    if (showing) visible.add(stroke);
    else visible.delete(stroke);
    stampCount += stroke.stamps.length * (showing ? 1 : -1);
    vertexCount += stroke.vertexCount * (showing ? 1 : -1);
    setAttached(stroke, showing);
  }

  function remember(stroke) {
    known.add(stroke);
    retainedStamps += stroke.stamps.length;
    retainedVertices += stroke.vertexCount;
  }

  function discardExpiredStrokes() {
    const retained = new Set(visible);
    for (const item of history) for (const stroke of item.strokes) retained.add(stroke);
    for (const stroke of known) {
      if (retained.has(stroke)) continue;
      disposeStroke(stroke);
      known.delete(stroke);
      retainedStamps -= stroke.stamps.length;
      retainedVertices -= stroke.vertexCount;
    }
  }

  function commit(action) {
    history.push(action);
    const trim = history.length > MAX_HISTORY;
    if (trim) history.shift();
    if (trim || future.length) {
      future.length = 0;
      discardExpiredStrokes();
    }
    // Keep one full drawing's worth of mesh data for undo in addition to visible work.
    while (history.length > 1 && (retainedStamps - stampCount > MAX_STAMPS ||
           retainedVertices - vertexCount > MAX_VERTICES)) {
      history.shift();
      discardExpiredStrokes();
    }
    notify();
  }

  function end() {
    if (!current) return false;
    const gesture = current;
    current = null;
    if (gesture.erased) {
      if (!gesture.erased.size) return false;
      const strokes = Array.from(gesture.erased);
      for (const stroke of strokes) setVisible(stroke, false);
      commit({ strokes, added: false });
    } else {
      if (!gesture.stroke.stamps.length) return false;
      remember(gesture.stroke);
      setVisible(gesture.stroke, true);
      commit({ strokes: [gesture.stroke], added: true });
    }
    return true;
  }

  function begin({ color = '#ffcb66', opacity = 1, soft = true, tool = 'brush' } = {}) {
    end();
    if (tool === 'erase' || tool === 'eraser') current = { erased: new Set() };
    else {
      if (typeof color !== 'string' || !COLOR.test(color) || !opacityIsValid(opacity)) return false;
      current = { stroke: newStroke(color.toLowerCase(), opacity, Boolean(soft), nextOrder++) };
    }
    return true;
  }

  function erase(record, stamp) {
    if (!visible.size) return false;
    const patch = projectStamp(indexFor(record), record, stamp, 0, true);
    if (!patch) return false;
    let target = null;
    for (const stroke of visible) {
      if (current.erased.has(stroke) || (target && target.order > stroke.order)) continue;
      const batch = stroke.batches.get(record);
      if (batch?.stamps.some((paint) => paint.point.distanceToSquared(stamp.point) <=
          ((paint.diameter + stamp.diameter) / 2) ** 2 &&
          paint.normal.dot(stamp.normal) > BRUSH_ALIGNMENT && shareFace(paint.faces, patch.faces))) target = stroke;
    }
    if (!target) return false;
    current.erased.add(target);
    setAttached(target, false);
    return true;
  }

  function add(hit, worldDiameter, opacity = current?.stroke?.opacity ?? 1) {
    const record = byMesh.get(hit?.mesh);
    if (!current || !record || !vectorIsValid(hit.normal) || !Number.isFinite(worldDiameter) || worldDiameter <= 0) return false;
    record.mesh.getWorldScale(scratch);
    const worldScale = Math.max(Math.abs(scratch.x), Math.abs(scratch.y), Math.abs(scratch.z));
    const diameter = Math.min(worldDiameter / worldScale, record.maxDiameter);
    if (!(worldScale > 0) || !validLocation(record, hit.point, diameter)) return false;
    const normal = new THREE.Vector3().copy(hit.normal).normalize();
    if (!vectorIsValid(normal) || normal.lengthSq() < 0.5) return false;
    const stamp = { point: new THREE.Vector3().copy(hit.point), normal, diameter, opacity, face: hitFaces.get(hit), mesh: record.id };
    if (current.erased) return erase(record, stamp);
    const { stroke } = current;
    if (!opacityIsValid(opacity) || opacity === 0 || visible.size >= MAX_STROKES ||
        stampCount + stroke.stamps.length >= MAX_STAMPS) return false;
    const patch = projectStamp(indexFor(record), record, stamp, MAX_VERTICES - vertexCount - stroke.vertexCount);
    if (!patch) return false;
    appendPatch(stroke, record, patch, stamp, true);
    return true;
  }

  function undo() {
    end();
    const action = history.pop();
    if (!action) return false;
    for (const stroke of action.strokes) setVisible(stroke, !action.added);
    future.push(action);
    notify();
    return true;
  }

  function redo() {
    end();
    const action = future.pop();
    if (!action) return false;
    for (const stroke of action.strokes) setVisible(stroke, action.added);
    history.push(action);
    notify();
    return true;
  }

  function clear() {
    end();
    if (!visible.size) return false;
    const strokes = Array.from(visible);
    for (const stroke of strokes) setVisible(stroke, false);
    commit({ strokes, added: false });
    return true;
  }

  function serialize() {
    const vector = (value) => value.toArray().map((component) => Object.is(component, -0) ? 0 : component);
    return {
      kind: FORMAT,
      version: 1,
      modelKey,
      strokes: Array.from(visible).sort((a, b) => a.order - b.order).map((stroke) => ({
        color: stroke.color,
        opacity: stroke.opacity,
        soft: stroke.soft,
        stamps: stroke.stamps.map((stamp) => ({
          mesh: stamp.mesh,
          face: stamp.face,
          p: vector(stamp.point),
          n: vector(stamp.normal),
          diameter: stamp.diameter,
          opacity: stamp.opacity,
        })),
      })),
    };
  }

  function validate(data) {
    if (data?.kind !== FORMAT || data.version !== 1) throw new Error('涂鸦文件版本不兼容。');
    if (data.modelKey !== modelKey) throw new Error('涂鸦文件与当前模型不匹配。');
    if (!Array.isArray(data.strokes) || data.strokes.length > MAX_STROKES) throw new Error('涂鸦笔画数据不正确。');
    let total = 0;
    const isTriple = (value) => Array.isArray(value) && value.length === 3 && [...value].every(Number.isFinite);
    return Array.from(data.strokes, (saved, order) => {
      if (typeof saved?.color !== 'string' || !COLOR.test(saved.color) || typeof saved.soft !== 'boolean' ||
          !opacityIsValid(saved.opacity) || !Array.isArray(saved.stamps) || !saved.stamps.length) {
        throw new Error('涂鸦笔画或笔刷数据不正确。');
      }
      total += saved.stamps.length;
      if (total > MAX_STAMPS) throw new Error('涂鸦文件的笔刷采样过多。');
      const stamps = Array.from(saved.stamps, (stamp) => {
        const record = Number.isInteger(stamp?.mesh) && records[stamp.mesh];
        if (!record) throw new Error('涂鸦文件引用了不存在的零件。');
        const { geometry } = record.mesh;
        const vertexLimit = geometry.index?.count ?? geometry.getAttribute('position').count;
        if (!isTriple(stamp.p) || !isTriple(stamp.n) || !Number.isInteger(stamp.face) || stamp.face < 0 ||
            stamp.face * 3 + 2 >= vertexLimit || !opacityIsValid(stamp.opacity) || stamp.opacity === 0) {
          throw new Error('涂鸦坐标或笔刷数据不正确。');
        }
        const point = new THREE.Vector3().fromArray(stamp.p);
        const normal = new THREE.Vector3().fromArray(stamp.n);
        if (!validLocation(record, point, stamp.diameter) || Math.abs(normal.lengthSq() - 1) > 1e-5) {
          throw new Error('涂鸦坐标或笔刷尺寸超出模型范围。');
        }
        return { mesh: record.id, face: stamp.face, point, normal, diameter: stamp.diameter, opacity: stamp.opacity };
      });
      return { stroke: newStroke(saved.color, saved.opacity, saved.soft, order), stamps };
    });
  }

  function restore(data) {
    const prepared = validate(data);
    // Build detached meshes first. A corrupt stamp cannot remove the current work or history.
    let vertices = 0;
    try {
      for (const { stroke, stamps } of prepared) {
        for (const stamp of stamps) {
          const record = records[stamp.mesh];
          const patch = projectStamp(indexFor(record), record, stamp, MAX_VERTICES - vertices);
          if (!patch) throw new Error('涂鸦位置不在模型表面，或涂鸦细节过多。');
          appendPatch(stroke, record, patch, stamp, false);
          vertices += patch.values.length / VERTEX_STRIDE;
        }
      }
    } catch (error) {
      for (const { stroke } of prepared) disposeStroke(stroke);
      throw error;
    }
    if (current?.stroke) disposeStroke(current.stroke);
    current = null;
    for (const stroke of known) disposeStroke(stroke);
    known.clear();
    visible.clear();
    history.length = 0;
    future.length = 0;
    stampCount = 0;
    vertexCount = 0;
    retainedStamps = 0;
    retainedVertices = 0;
    nextOrder = prepared.length;
    for (const { stroke } of prepared) {
      remember(stroke);
      setVisible(stroke, true);
      history.push({ strokes: [stroke], added: true });
    }
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    notify();
    return true;
  }

  return { hitTest, begin, add, end, undo, redo, clear, serialize, restore };
}
