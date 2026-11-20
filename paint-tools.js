import * as THREE from 'three';
import { createSurfaceDrawing, DrawingError } from './drawing.js?v=local-eraser-1';
import { t, onLanguageChange } from './i18n.js';

const COLORS = [
  ['#f7c948', 'viewer.color.gold'], ['#f26a4f', 'viewer.color.coral'], ['#e85d75', 'viewer.color.rose'],
  ['#a9d18e', 'viewer.color.green'], ['#57b6c9', 'viewer.color.cyan'], ['#5271ff', 'viewer.color.blue'],
  ['#9b6cff', 'viewer.color.purple'], ['#f1f3f5', 'viewer.color.white'], ['#202a33', 'viewer.color.darkGray'],
];
const MODE_HINT = {
  auto: 'viewer.paint.hintAuto',
  orbit: 'viewer.paint.hintOrbit',
  paint: 'viewer.paint.hintPaint',
};
const $ = (id) => document.getElementById(id);
const press = (button, value) => button.setAttribute('aria-pressed', String(value));

function drawingStorage(modelKey, reportError) {
  const key = `dragondance-surface-paint:${modelKey}`;
  let pending;
  let timer;
  let queue = Promise.resolve();

  function transact(mode, operation) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('dragondance-paint', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('drawings');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('drawings', mode);
        const request = operation(tx.objectStore('drawings'));
        tx.oncomplete = () => { db.close(); resolve(request.result); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }

  function flush() {
    clearTimeout(timer);
    if (!pending) return;
    const snapshot = { savedAt: Date.now(), data: pending() };
    pending = null;
    let localSaved = false;
    try {
      localStorage.setItem(key, JSON.stringify(snapshot));
      localSaved = true;
    } catch {
      // IndexedDB provides the larger fallback.
    }
    queue = queue.then(() => transact('readwrite', (store) => store.put(snapshot, key)))
      .catch(() => { if (!localSaved) reportError(); });
  }

  return {
    flush,
    schedule(serialize) {
      pending = serialize;
      clearTimeout(timer);
      timer = setTimeout(flush, 300);
    },
    async read() {
      let local, indexed;
      try { local = JSON.parse(localStorage.getItem(key)); } catch { /* unavailable */ }
      try { indexed = await transact('readonly', (store) => store.get(key)); } catch { /* unavailable */ }
      return ((indexed?.savedAt ?? 0) > (local?.savedAt ?? 0) ? indexed : local)?.data;
    },
  };
}

export function createPaintTools({ surface, camera, controls, model, meshes, modelKey, modelRadius, partForMesh, onStrokeStart, invalidate }) {
  let visible = false;
  let navigating = false;
  let ready = false;
  let mode = 'auto';
  let tool = 'brush';
  let soft = true;
  let pointerId = null;
  let stroke;
  let frame;
  let samples = [];
  let importRevision = 0;
  const orbitPointers = new Set();
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const colorInput = $('brush-color');
  const widthInput = $('brush-width');
  const opacityInput = $('brush-opacity');
  const pressureInput = $('pen-pressure');
  const fileInput = $('paint-file');
  const cursor = $('brush-cursor');
  const swatches = [];

  let currentStatus = { key: 'viewer.paint.localStorage', isError: false };

  function updateStatus() {
    const { key, isError, params, nestedKeys } = currentStatus;
    const values = { ...params };
    for (const [name, messageKey] of Object.entries(nestedKeys ?? {})) values[name] = t(messageKey, params);
    const element = $('paint-status');
    element.textContent = t(key, values);
    element.toggleAttribute('data-error', isError);
  }

  function status(key, isError = false, params, nestedKeys) {
    currentStatus = { key, isError, params, nestedKeys };
    updateStatus();
  }

  const storage = drawingStorage(modelKey, () => status('viewer.paint.saveFailed', true));
  const drawing = createSurfaceDrawing({
    meshes,
    modelKey,
    onChange({ hasStrokes, canUndo, canRedo }) {
      $('btn-undo').disabled = !canUndo;
      $('btn-redo').disabled = !canRedo;
      $('btn-clear').disabled = !hasStrokes;
      $('btn-export-paint').disabled = !hasStrokes;
      if (ready) storage.schedule(() => drawing.serialize());
      invalidate();
    },
  });

  function usesPointer(event) {
    return visible && (mode === 'paint' || (mode === 'auto' && event.pointerType === 'pen'));
  }

  function updateControlState() {
    controls.enabled = !navigating && pointerId === null && !(visible && mode === 'paint');
    surface.classList.toggle('is-painting', visible && mode === 'paint');
  }

  function setMode(value) {
    endStroke();
    mode = value;
    cursor.hidden = true;
    for (const button of document.querySelectorAll('[data-paint-mode]')) {
      press(button, button.dataset.paintMode === value);
    }
    updateHint();
    updateControlState();
  }

  function setTool(value) {
    tool = value;
    press($('tool-brush'), value === 'brush');
    press($('tool-eraser'), value === 'eraser');
    updateHint();
  }

  function updateHint() {
    const key = tool === 'eraser' && mode !== 'orbit' ? 'viewer.paint.eraserHint' : MODE_HINT[mode];
    $('paint-hint').textContent = t(key);
  }

  function setColor(value) {
    colorInput.value = value;
    for (const { button } of swatches) press(button, button.dataset.color === value);
  }

  for (const [color, labelKey] of COLORS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.color = color;
    button.style.setProperty('--swatch', color);
    button.addEventListener('click', () => setColor(color));
    swatches.push({ button, labelKey });
    $('paint-swatches').append(button);
  }
  setColor(colorInput.value);

  function updateEdgeText() {
    const button = $('tool-soft');
    button.textContent = t(soft ? 'viewer.paint.softEdge' : 'viewer.paint.hardEdge');
    button.setAttribute('aria-label', t(soft ? 'viewer.paint.softBrush' : 'viewer.paint.hardBrush'));
  }

  function translatePaintTools() {
    for (const { button, labelKey } of swatches) {
      const label = t(labelKey);
      button.setAttribute('aria-label', label);
      button.title = label;
    }
    updateHint();
    updateEdgeText();
    updateStatus();
  }

  onLanguageChange(translatePaintTools);
  translatePaintTools();

  // The brush diameter is set relative to the model. Zoom changes only the cursor preview.
  function brushDiameter() {
    return modelRadius * (0.003 + 0.16 * Math.pow(widthInput.valueAsNumber / 100, 1.25));
  }

  function pointFrom(event, fallbackPressure) {
    const pressure = event.pointerType === 'pen' && pressureInput.checked
      ? (event.pressure > 0 ? THREE.MathUtils.clamp(event.pressure, 0.08, 1) : fallbackPressure ?? 0.65)
      : null;
    return { x: event.clientX, y: event.clientY, pressure };
  }

  function diameterScale(pressure) {
    return pressure === null ? 1 : 0.4 + 0.9 * pressure;
  }

  function worldPerPixel(rect) {
    return (camera.top - camera.bottom) / (camera.zoom * rect.height);
  }

  function updateCursor(event) {
    cursor.hidden = navigating || !usesPointer(event) || event.pointerType === 'touch';
    if (cursor.hidden) return;
    const rect = surface.getBoundingClientRect();
    const pixels = Math.max(5, brushDiameter() * diameterScale(pointFrom(event).pressure) / worldPerPixel(rect));
    cursor.style.left = `${event.clientX}px`;
    cursor.style.top = `${event.clientY}px`;
    cursor.style.width = cursor.style.height = `${Math.min(pixels, 160)}px`;
    cursor.style.setProperty('--brush-color', tool === 'eraser' ? '#fff' : colorInput.value);
  }

  function stamp(point, rect) {
    const x = (point.x - rect.left) / rect.width;
    const y = (point.y - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    ndc.set(2 * x - 1, 1 - 2 * y);
    raycaster.setFromCamera(ndc, camera);
    const hit = drawing.hitTest(raycaster);
    if (!hit) return;
    const diameter = stroke.diameter * diameterScale(point.pressure);
    const opacity = stroke.opacity * (point.pressure === null ? 1 : 0.35 + 0.65 * point.pressure);
    drawing.add(hit, diameter, opacity);
    const part = partForMesh(hit.mesh);
    if (part && part !== stroke.lastPart) {
      stroke.lastPart = part;
      status(tool === 'eraser' ? 'viewer.paint.erasing' : 'viewer.paint.drawing', false,
        { number: part.number }, { part: part.labelKey });
    }
  }

  function flushSamples() {
    cancelAnimationFrame(frame);
    frame = undefined;
    if (!stroke || !samples.length) return;
    const queued = samples;
    samples = [];
    const rect = surface.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    camera.updateMatrixWorld();
    model.updateMatrixWorld(true);
    const spacing = THREE.MathUtils.clamp(stroke.diameter / worldPerPixel(rect) * 0.28, 0.9, 8);
    for (const point of queued) {
      const last = stroke.last;
      if (!last) {
        stroke.last = point;
        stamp(point, rect);
        continue;
      }
      const distance = Math.hypot(point.x - last.x, point.y - last.y);
      if (distance < spacing * 0.8) continue;
      const steps = Math.min(48, Math.ceil(distance / spacing));
      for (let i = 1; i <= steps; i++) {
        const amount = i / steps;
        stamp({
          x: THREE.MathUtils.lerp(last.x, point.x, amount),
          y: THREE.MathUtils.lerp(last.y, point.y, amount),
          pressure: last.pressure === null || point.pressure === null
            ? point.pressure : THREE.MathUtils.lerp(last.pressure, point.pressure, amount),
        }, rect);
      }
      stroke.last = point;
    }
    invalidate();
  }

  function queueSamples(event) {
    const events = event.getCoalescedEvents?.();
    for (const sample of events?.length ? events : [event]) samples.push(pointFrom(sample, stroke.last?.pressure));
    if (frame === undefined) frame = requestAnimationFrame(flushSamples);
  }

  function endStroke() {
    if (pointerId === null) return;
    flushSamples();
    drawing.end();
    const id = pointerId;
    pointerId = null;
    stroke = undefined;
    if (surface.hasPointerCapture(id)) surface.releasePointerCapture(id);
    updateControlState();
    invalidate();
  }

  surface.addEventListener('pointerdown', (event) => {
    if (navigating) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!usesPointer(event) && pointerId === null) {
      orbitPointers.add(event.pointerId);
      return;
    }
    // Capture before OrbitControls can treat an active stylus as a mouse drag.
    event.stopImmediatePropagation();
    if (event.button !== 0 || pointerId !== null || orbitPointers.size || !ready) return;
    event.preventDefault();
    if (!onStrokeStart()) {
      status('viewer.paint.waitForParts');
      return;
    }
    pointerId = event.pointerId;
    updateControlState();
    try { surface.setPointerCapture(pointerId); } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
    }
    stroke = { diameter: brushDiameter(), opacity: opacityInput.valueAsNumber / 100 };
    drawing.begin({ tool, soft, opacity: stroke.opacity, color: colorInput.value });
    queueSamples(event);
    updateCursor(event);
  }, true);
  surface.addEventListener('pointermove', (event) => {
    updateCursor(event);
    if (event.pointerId === pointerId) queueSamples(event);
  });
  surface.addEventListener('pointerleave', () => { cursor.hidden = true; });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    window.addEventListener(type, (event) => {
      orbitPointers.delete(event.pointerId);
      if (event.pointerId !== pointerId) return;
      if (type === 'pointerup') queueSamples(event);
      endStroke();
      if (event.pointerType !== 'mouse') cursor.hidden = true;
    });
  }
  function settleAndSave() {
    orbitPointers.clear();
    endStroke();
    cursor.hidden = true;
    storage.flush();
  }
  window.addEventListener('blur', settleAndSave);
  window.addEventListener('pagehide', settleAndSave);
  document.addEventListener('visibilitychange', () => { if (document.hidden) settleAndSave(); });

  for (const button of document.querySelectorAll('[data-paint-mode]')) {
    button.addEventListener('click', () => setMode(button.dataset.paintMode));
  }
  colorInput.addEventListener('input', () => setColor(colorInput.value));
  widthInput.addEventListener('input', () => { $('brush-size').value = widthInput.value; });
  opacityInput.addEventListener('input', () => { $('opacity-value').value = `${opacityInput.value}%`; });
  $('tool-brush').addEventListener('click', () => setTool('brush'));
  $('tool-eraser').addEventListener('click', () => setTool('eraser'));
  $('tool-soft').addEventListener('click', (event) => {
    soft = !soft;
    press(event.currentTarget, soft);
    updateEdgeText();
  });
  $('btn-undo').addEventListener('click', () => { endStroke(); drawing.undo(); status('viewer.paint.undone'); });
  $('btn-redo').addEventListener('click', () => { endStroke(); drawing.redo(); status('viewer.paint.redone'); });
  $('btn-clear').addEventListener('click', () => { endStroke(); drawing.clear(); status('viewer.paint.cleared'); });
  $('btn-export-paint').addEventListener('click', () => {
    endStroke();
    const url = URL.createObjectURL(new Blob([JSON.stringify(drawing.serialize())], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'dragondance-painting.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('viewer.paint.exported');
  });
  $('btn-import-paint').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const [file] = fileInput.files;
    fileInput.value = '';
    if (!file) return;
    const revision = ++importRevision;
    try {
      const data = JSON.parse(await file.text());
      if (revision !== importRevision) return;
      endStroke();
      drawing.restore(data);
      status('viewer.paint.imported');
    } catch (error) {
      if (revision !== importRevision) return;
      if (error instanceof DrawingError) status(error.key, true);
      else if (error instanceof SyntaxError) status('viewer.paint.invalidJson', true);
      else {
        console.error(error);
        status('viewer.paint.importFailed', true);
      }
    }
  });

  return {
    setVisible(value) {
      endStroke();
      visible = value;
      cursor.hidden = true;
      updateControlState();
    },
    setNavigating(value) {
      navigating = value;
      cursor.hidden = true;
      updateControlState();
    },
    endStroke,
    isDrawing: () => pointerId !== null,
    async restoreLocal() {
      status('viewer.paint.readingLocal');
      try {
        const saved = await storage.read();
        if (saved) drawing.restore(saved);
        status(saved ? 'viewer.paint.restoredLocal' : 'viewer.paint.localStorage');
      } catch (error) {
        if (error instanceof DrawingError) {
          status('viewer.paint.restoreFailedWithReason', true, undefined, { reason: error.key });
        } else {
          console.error(error);
          status('viewer.paint.restoreFailed', true);
        }
      } finally {
        ready = true;
        $('btn-import-paint').disabled = false;
      }
    },
  };
}
