/* Screen-space annotations for the viewer's transparent overlay canvas. */
export function createDrawingLayer({ canvas, onChange = () => {} }) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to initialize the drawing canvas.');

  const strokes = [];
  let active = false;
  let pointerId = null;
  let brushColor = '#ffcb66';
  let brushWidth = 4;
  let viewWidth = 0;
  let viewHeight = 0;
  let frame = null;

  function drawTo(target, width, height) {
    if (!strokes.length || !viewWidth || !viewHeight || width <= 0 || height <= 0) return;

    target.save();
    target.setTransform(width / viewWidth, 0, 0, height / viewHeight, 0, 0);
    target.lineCap = 'round';
    target.lineJoin = 'round';

    for (const { color, width: lineWidth, points } of strokes) {
      const path = new Path2D();
      const [first] = points;
      if (points.length === 1) {
        path.arc(first.x * viewWidth, first.y * viewHeight, lineWidth / 2, 0, Math.PI * 2);
        target.fillStyle = color;
        target.fill(path);
      } else {
        path.moveTo(first.x * viewWidth, first.y * viewHeight);
        for (let i = 1; i < points.length; i++) {
          path.lineTo(points[i].x * viewWidth, points[i].y * viewHeight);
        }
        target.strokeStyle = color;
        target.lineWidth = lineWidth;
        target.stroke(path);
      }
    }

    target.restore();
  }

  function redraw() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawTo(context, canvas.width, canvas.height);
  }

  function queueRedraw() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      redraw();
    });
  }

  function resize() {
    const { width, height } = canvas.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;

    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(width * scale));
    const pixelHeight = Math.max(1, Math.round(height * scale));
    if (width === viewWidth && height === viewHeight &&
        pixelWidth === canvas.width && pixelHeight === canvas.height) return;

    viewWidth = width;
    viewHeight = height;
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    redraw();
  }

  // Normalized positions survive a change in viewport shape. Brush widths are in CSS pixels.
  function pointFrom(event, rect) {
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  function appendSamples(event) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const { points } = strokes.at(-1);
    const sampleCountBefore = points.length;
    const coalesced = event.getCoalescedEvents?.();
    for (const sample of coalesced?.length ? coalesced : [event]) {
      const point = pointFrom(sample, rect);
      const last = points.at(-1);
      if (point.x !== last.x || point.y !== last.y) points.push(point);
    }
    if (points.length !== sampleCountBefore) queueRedraw();
  }

  function finishStroke() {
    if (pointerId === null) return;

    const id = pointerId;
    pointerId = null;
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!active || pointerId !== null || event.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    event.preventDefault();
    pointerId = event.pointerId;
    strokes.push({ color: brushColor, width: brushWidth, points: [pointFrom(event, rect)] });
    try {
      canvas.setPointerCapture(pointerId);
    } catch (error) {
      // A synthetic pointer event has no active browser pointer to capture.
      if (error.name !== 'NotFoundError') throw error;
    }
    queueRedraw();
    onChange(true);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerId === pointerId) appendSamples(event);
  });

  canvas.addEventListener('pointerup', (event) => {
    if (event.pointerId !== pointerId) return;
    appendSamples(event);
    finishStroke();
  });

  // Keep the portion already drawn if the browser interrupts a gesture.
  for (const type of ['pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(type, (event) => {
      if (event.pointerId === pointerId) finishStroke();
    });
  }

  window.addEventListener('resize', resize);
  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(canvas);
  resize();
  onChange(false);

  return {
    setActive(value) {
      active = Boolean(value);
      canvas.classList.toggle('is-drawing', active);
      if (!active) finishStroke();
    },
    setColor(value) {
      if (typeof value !== 'string') return;
      context.save();
      context.strokeStyle = brushColor;
      context.strokeStyle = value;
      brushColor = context.strokeStyle;
      context.restore();
    },
    setWidth(value) {
      if (Number.isFinite(value) && value > 0) brushWidth = value;
    },
    undo() {
      if (!strokes.length) return;
      finishStroke();
      strokes.pop();
      queueRedraw();
      onChange(strokes.length > 0);
    },
    clear() {
      if (!strokes.length) return;
      finishStroke();
      strokes.length = 0;
      queueRedraw();
      onChange(false);
    },
    resize,
    drawTo,
  };
}
