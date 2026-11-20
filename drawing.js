/* Surface annotations live in the same local coordinates as their source mesh. */
import * as THREE from 'three';
import { t } from './i18n.js';

export class DrawingError extends Error {
  constructor(key) {
    super(t(key));
    this.key = key;
  }
}

const FORMAT = 'dragondance-surface-drawing';
const MAX_HISTORY = 100;
const ERASER_SIDES = 48;
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
  if (polygon.length < 3) return false;
  const [x0, y0] = polygon[0];
  let area = 0;
  for (let i = 1; i < polygon.length - 1; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[i + 1];
    area += (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
  }
  if (Math.abs(area) <= radius * radius * 1e-14) return false;
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
function projectStamp(index, record, stamp, facesOnly = false) {
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
  const triangleFaces = [];
  if (facesOnly) {
    const faces = new Set();
    for (const entry of entries) if (root(entry) === component) faces.add(entry.face);
    return { face, sign, faces, tangent, bitangent, radius, depth };
  }
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
    const { polygon } = entry;
    for (let i = 1; i < polygon.length - 1; i++) {
      if (!touchesDisk([polygon[0], polygon[i], polygon[i + 1]], radius)) continue;
      emit(polygon[0]);
      emit(polygon[i]);
      emit(polygon[i + 1]);
      triangleFaces.push(entry.face);
    }
  }
  return { face, sign, values: Float64Array.from(values), triangleFaces: Uint32Array.from(triangleFaces) };
}

const eraserSides = Array.from({ length: ERASER_SIDES }, (_, i) => {
  const angle = (i + 0.5) * 2 * Math.PI / ERASER_SIDES;
  return [Math.cos(angle), Math.sin(angle), 0, Math.cos(Math.PI / ERASER_SIDES)];
});

function eraserPlanes(patch, sample) {
  const { tangent, bitangent, radius, depth } = patch;
  return [...eraserSides.map(([x, y, z, limit]) => [x, y, z, radius * limit]),
    [0, 0, 1, depth], [0, 0, -1, depth]].map(([x, y, z, limit]) => {
    const direction = tangent.clone().multiplyScalar(x).addScaledVector(bitangent, y).addScaledVector(sample.normal, z);
    return [direction.x, direction.y, direction.z, limit];
  });
}

// Keep the polygon outside each plane, and pass only its inside region to the
// next plane. All attributes follow the same interpolation at each cut edge.
function subtractPolygon(vertices, planes, origin) {
  const outside = [];
  for (const [x, y, z, limit] of planes) {
    const tolerance = limit * 1e-10 + Number.EPSILON * Math.max(Math.abs(origin.x), Math.abs(origin.y), Math.abs(origin.z));
    const distances = vertices.map((v) => {
      const distance = x * (v[0] - origin.x) + y * (v[1] - origin.y) + z * (v[2] - origin.z) - limit;
      return Math.abs(distance) <= tolerance ? 0 : distance;
    });
    if (distances.every((d) => d >= 0)) return null;
    if (distances.every((d) => d <= 0)) continue;
    const inside = [];
    const piece = [];
    let previous = vertices.length - 1;
    for (let i = 0; i < vertices.length; i++) {
      const a = distances[previous];
      const b = distances[i];
      if ((a > 0 && b < 0) || (a < 0 && b > 0)) {
        const ratio = a / (a - b);
        const cut = vertices[previous].map((value, j) => value + (vertices[i][j] - value) * ratio);
        inside.push(cut);
        piece.push(cut);
      }
      if (b <= 0) inside.push(vertices[i]);
      if (b >= 0) piece.push(vertices[i]);
      previous = i;
    }
    outside.push(piece);
    vertices = inside;
  }
  // The fragment shader already discards everything outside the paint disk.
  const uv = (polygon) => polygon.map((v) => [v[6] - 0.5, v[7] - 0.5]);
  return touchesDisk(uv(vertices), 0.5) ? outside.filter((part) => touchesDisk(uv(part), 0.5)) : null;
}

function cutStamp(record, stamp, sample, footprint, planes) {
  const original = stamp.patch;
  if (original.sign !== footprint.sign || stamp.normal.dot(sample.normal) < BRUSH_ALIGNMENT) return null;
  const { values, triangleFaces } = original;
  const origin = sample.point.clone().addScaledVector(stamp.normal, record.offset);
  let changed = false;
  const retained = [];
  const faces = [];
  for (let i = 0; i < triangleFaces.length; i++) {
    const start = i * VERTEX_STRIDE * 3;
    const vertex = (j) => values.subarray(start + j * VERTEX_STRIDE, start + (j + 1) * VERTEX_STRIDE);
    const face = triangleFaces[i];
    const pieces = footprint.faces.has(face) && subtractPolygon([vertex(0), vertex(1), vertex(2)], planes, origin);
    if (pieces) changed = true;
    for (const polygon of pieces || [[vertex(0), vertex(1), vertex(2)]]) {
      for (let j = 1; j < polygon.length - 1; j++) {
        retained.push(...polygon[0], ...polygon[j], ...polygon[j + 1]);
        faces.push(face);
      }
    }
  }
  if (!changed) return null;
  return { values: Float64Array.from(retained), triangleFaces: Uint32Array.from(faces), sign: original.sign,
    masks: { sample, previous: original.masks } };
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
  return { color, opacity, soft, order, stamps: [], batches: new Map(), paintCount: 0, material: null };
}

function appendValues(batch, values) {
  const count = batch.count + values.length / VERTEX_STRIDE;
  if (!values.length) return;
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
  batch.buffer.array.set(values, offset);
  batch.buffer.addUpdateRange(offset, values.length);
  batch.buffer.needsUpdate = true;
  batch.count = count;
  batch.decal.geometry.setDrawRange(0, count);
  const vertex = new THREE.Vector3();
  for (let i = offset; i < count * VERTEX_STRIDE; i += VERTEX_STRIDE) {
    batch.box.expandByPoint(vertex.fromArray(batch.buffer.array, i));
  }
  batch.box.getBoundingSphere(batch.sphere);
}

// Keep ordinary strokes batched, and split long strokes into bounded GPU buffers.
const BATCH_VERTICES = 16_384;

function appendPatch(stroke, record, patch, stamp, attach) {
  let batches = stroke.batches.get(record);
  if (!batches) stroke.batches.set(record, batches = []);
  let batch = batches.at(-1);
  const additional = patch.values.length / VERTEX_STRIDE;
  if (!batch || batch.count + additional > BATCH_VERTICES) {
    stroke.material ??= brushMaterial(stroke.color, stroke.soft);
    const decal = new THREE.Mesh(new THREE.BufferGeometry(), stroke.material);
    decal.renderOrder = 21 + stroke.order;
    decal.name = 'Surface drawing';
    decal.layers.mask = record.mesh.layers.mask;
    decal.raycast = () => {};
    batch = { decal, count: 0, capacity: 0, stamps: [], box: new THREE.Box3(), sphere: new THREE.Sphere() };
    batches.push(batch);
  }
  appendValues(batch, patch.values);
  if (attach && batch.count && !batch.decal.parent) record.mesh.add(batch.decal);
  stamp.patch = patch;
  stamp.batch = batch;
  batch.stamps.push(stamp);
  stroke.stamps.push(stamp);
  if (additional) stroke.paintCount++;
}

function rebuildBatch(batch, record, attach) {
  batch.count = 0;
  batch.box.makeEmpty();
  batch.buffer?.clearUpdateRanges();
  for (const stamp of batch.stamps) appendValues(batch, stamp.patch.values);
  if (batch.count) {
    if (attach && !batch.decal.parent) record.mesh.add(batch.decal);
  } else {
    batch.decal.geometry.setDrawRange(0, 0);
    batch.decal.removeFromParent();
  }
}

function setAttached(stroke, attached) {
  for (const [record, batches] of stroke.batches) for (const { decal, count } of batches) {
    if (attached && count && decal.parent !== record.mesh) record.mesh.add(decal);
    else if (!attached) decal.removeFromParent();
  }
}

function disposeStroke(stroke) {
  setAttached(stroke, false);
  for (const batches of stroke.batches.values()) for (const { decal } of batches) decal.geometry.dispose();
  stroke.material?.dispose();
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
    setAttached(stroke, showing);
  }

  function discardExpiredStrokes() {
    const retained = new Set(visible);
    for (const item of history) for (const stroke of item.strokes) retained.add(stroke);
    for (const stroke of known) {
      if (retained.has(stroke)) continue;
      disposeStroke(stroke);
      known.delete(stroke);
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
    notify();
  }

  function end() {
    if (!current) return false;
    const gesture = current;
    current = null;
    if (gesture.erased) {
      if (!gesture.erased.size) return false;
      const changes = Array.from(gesture.erased.values());
      commit({ strokes: Array.from(new Set(changes.map(({ stroke }) => stroke))), changes });
    } else {
      if (!gesture.stroke.stamps.length) return false;
      known.add(gesture.stroke);
      setVisible(gesture.stroke, true);
      commit({ strokes: [gesture.stroke], added: true });
    }
    return true;
  }

  function begin({ color = '#ffcb66', opacity = 1, soft = true, tool = 'brush' } = {}) {
    end();
    if (tool === 'erase' || tool === 'eraser') current = { erased: new Map() };
    else {
      if (typeof color !== 'string' || !COLOR.test(color) || !opacityIsValid(opacity)) return false;
      current = { stroke: newStroke(color.toLowerCase(), opacity, Boolean(soft), nextOrder++) };
    }
    return true;
  }

  function erase(record, stamp) {
    if (!visible.size) return false;
    const footprint = projectStamp(indexFor(record), record, stamp, true);
    if (!footprint) return false;
    stamp.face = footprint.face;
    const planes = eraserPlanes(footprint, stamp);
    const updates = [];
    for (const stroke of visible) {
      for (const batch of stroke.batches.get(record) ?? []) {
        // The projected prism is contained in this sphere, including its depth.
        if (!batch.count || batch.box.distanceToPoint(stamp.point) > Math.hypot(footprint.radius, footprint.depth) + record.offset) continue;
        for (const paint of batch.stamps) {
          if (!paint.patch.values.length || paint.point.distanceToSquared(stamp.point) >
              (0.5 * Math.hypot(1, 0.6) * (paint.diameter + stamp.diameter)) ** 2) continue;
          const after = cutStamp(record, paint, stamp, footprint, planes);
          if (!after) continue;
          const change = current.erased.get(paint) ?? { stroke, paint, before: paint.patch };
          change.after = after;
          current.erased.set(paint, change);
          updates.push(change);
        }
      }
    }
    applyErasures(updates, 'after');
    return updates.length > 0;
  }

  function applyErasures(changes, side) {
    const dirty = new Map();
    const strokes = new Set();
    for (const { stroke, paint, [side]: patch } of changes) {
      stroke.paintCount += Number(patch.values.length > 0) - Number(paint.patch.values.length > 0);
      paint.patch = patch;
      dirty.set(paint.batch, records[paint.mesh]);
      strokes.add(stroke);
    }
    for (const [batch, record] of dirty) rebuildBatch(batch, record, true);
    for (const stroke of strokes) setVisible(stroke, stroke.paintCount > 0);
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
    if (!opacityIsValid(opacity) || opacity === 0) return false;
    const patch = projectStamp(indexFor(record), record, stamp);
    if (!patch?.values.length) return false;
    stamp.face = patch.face;
    appendPatch(stroke, record, patch, stamp, true);
    return true;
  }

  function undo() {
    end();
    const action = history.pop();
    if (!action) return false;
    if (action.changes) applyErasures(action.changes, 'before');
    else for (const stroke of action.strokes) setVisible(stroke, !action.added);
    future.push(action);
    notify();
    return true;
  }

  function redo() {
    end();
    const action = future.pop();
    if (!action) return false;
    if (action.changes) applyErasures(action.changes, 'after');
    else for (const stroke of action.strokes) setVisible(stroke, action.added);
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
    const erasers = [];
    const ids = new Map();
    const location = (sample) => ({
      mesh: sample.mesh, face: sample.face, p: vector(sample.point), n: vector(sample.normal), diameter: sample.diameter,
    });
    const strokes = Array.from(visible).sort((a, b) => a.order - b.order).map((stroke) => ({
      color: stroke.color,
      opacity: stroke.opacity,
      soft: stroke.soft,
      stamps: stroke.stamps.filter((stamp) => stamp.patch.values.length).map((stamp) => {
        const saved = { ...location(stamp), opacity: stamp.opacity };
        if (stamp.patch.masks) {
          const masks = [];
          for (let entry = stamp.patch.masks; entry; entry = entry.previous) masks.push(entry.sample);
          saved.masks = masks.reverse().map((sample) => {
            if (!ids.has(sample)) {
              ids.set(sample, erasers.length);
              erasers.push(location(sample));
            }
            return ids.get(sample);
          });
        }
        return saved;
      }),
    }));
    return { kind: FORMAT, version: 1, modelKey, strokes, ...(erasers.length ? { erasers } : {}) };
  }

  function validate(data) {
    if (data?.kind !== FORMAT || data.version !== 1) throw new DrawingError('viewer.drawing.invalidVersion');
    if (data.modelKey !== modelKey) throw new DrawingError('viewer.drawing.wrongModel');
    if (!Array.isArray(data.strokes)) throw new DrawingError('viewer.drawing.invalidStrokes');
    const isTriple = (value) => Array.isArray(value) && value.length === 3 && [...value].every(Number.isFinite);
    function location(sample) {
      const record = Number.isInteger(sample?.mesh) && records[sample.mesh];
      if (!record) throw new DrawingError('viewer.drawing.missingPart');
      const { geometry } = record.mesh;
      const vertexLimit = geometry.index?.count ?? geometry.getAttribute('position').count;
      if (!isTriple(sample.p) || !isTriple(sample.n) || !Number.isInteger(sample.face) || sample.face < 0 ||
          sample.face * 3 + 2 >= vertexLimit) throw new DrawingError('viewer.drawing.invalidCoordinates');
      const point = new THREE.Vector3().fromArray(sample.p);
      const normal = new THREE.Vector3().fromArray(sample.n);
      if (!validLocation(record, point, sample.diameter) || Math.abs(normal.lengthSq() - 1) > 1e-5) {
        throw new DrawingError('viewer.drawing.outsideModel');
      }
      return { mesh: record.id, face: sample.face, point, normal, diameter: sample.diameter };
    }
    const invalidMask = () => new DrawingError('viewer.drawing.invalidCoordinates');
    if ('erasers' in data && !Array.isArray(data.erasers)) throw invalidMask();
    const erasers = Array.from(data.erasers ?? [], location);
    const strokes = Array.from(data.strokes, (saved, order) => {
      if (typeof saved?.color !== 'string' || !COLOR.test(saved.color) || typeof saved.soft !== 'boolean' ||
          !opacityIsValid(saved.opacity) || !Array.isArray(saved.stamps) || !saved.stamps.length) {
        throw new DrawingError('viewer.drawing.invalidBrushStroke');
      }
      const stamps = Array.from(saved.stamps, (stamp) => {
        const sample = location(stamp);
        if (!opacityIsValid(stamp.opacity) || stamp.opacity === 0) throw invalidMask();
        if ('masks' in stamp && !Array.isArray(stamp.masks)) throw invalidMask();
        const masks = Array.from(stamp.masks ?? [], (id) => {
          if (!Number.isSafeInteger(id) || id < 0 || erasers[id]?.mesh !== sample.mesh) throw invalidMask();
          return erasers[id];
        });
        return { ...sample, opacity: stamp.opacity, masks };
      });
      return { stroke: newStroke(saved.color, saved.opacity, saved.soft, order), stamps };
    });
    return { strokes, erasers };
  }

  function restore(data) {
    const { strokes: prepared, erasers } = validate(data);
    // Build detached meshes first. A corrupt stamp cannot remove the current work or history.
    const footprints = new Map();
    try {
      for (const sample of erasers) {
        const record = records[sample.mesh];
        const footprint = projectStamp(indexFor(record), record, sample, true);
        if (!footprint) throw new DrawingError('viewer.drawing.invalidSurface');
        footprints.set(sample, { footprint, planes: eraserPlanes(footprint, sample) });
      }
      for (const { stroke, stamps } of prepared) {
        for (const { masks, ...stamp } of stamps) {
          const record = records[stamp.mesh];
          stamp.patch = projectStamp(indexFor(record), record, stamp);
          if (!stamp.patch?.values.length) throw new DrawingError('viewer.drawing.invalidSurface');
          for (const sample of masks) {
            const { footprint, planes } = footprints.get(sample);
            stamp.patch = cutStamp(record, stamp, sample, footprint, planes) ?? stamp.patch;
          }
          if (stamp.patch.values.length) appendPatch(stroke, record, stamp.patch, stamp, false);
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
    nextOrder = prepared.length;
    for (const { stroke } of prepared) {
      if (!stroke.paintCount) continue;
      known.add(stroke);
      setVisible(stroke, true);
      history.push({ strokes: [stroke], added: true });
    }
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    notify();
    return true;
  }

  return { hitTest, begin, add, end, undo, redo, clear, serialize, restore };
}
