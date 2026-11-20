const DEAD_ZONE = 0.12;
const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

export function createCameraStick(button, { onStart, onEnd }) {
  const direction = { x: 0, y: 0 };
  const keys = new Set();
  let pointerId = null;
  let origin;

  function isActive() {
    return pointerId !== null || keys.size > 0;
  }

  function positionStick(x, y) {
    const distance = Math.hypot(x, y);
    const magnitude = Math.min(distance, 1);
    const speed = distance > DEAD_ZONE ? (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE) / distance : 0;
    direction.x = x * speed;
    direction.y = y * speed;
    const travel = button.clientWidth * 0.31 / Math.max(distance, 1);
    button.style.setProperty('--stick-x', `${x * travel}px`);
    button.style.setProperty('--stick-y', `${y * travel}px`);
  }

  function reset() {
    if (!isActive()) return;
    const capturedId = pointerId;
    pointerId = null;
    origin = undefined;
    keys.clear();
    positionStick(0, 0);
    button.classList.remove('is-held');
    if (capturedId !== null && button.hasPointerCapture(capturedId)) button.releasePointerCapture(capturedId);
    onEnd();
  }

  function move(event) {
    positionStick((event.clientX - origin.x) / origin.radius, (event.clientY - origin.y) / origin.radius);
  }

  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || isActive() || !onStart()) return;
    event.preventDefault();
    if (event.pointerType === 'mouse') button.focus({ preventScroll: true });
    pointerId = event.pointerId;
    const { width, height, left, top } = button.getBoundingClientRect();
    origin = { x: left + width / 2, y: top + height / 2, radius: Math.max(1, width * 0.31) };
    button.classList.add('is-held');
    try {
      button.setPointerCapture(pointerId);
    } catch (error) {
      reset();
      if (error.name !== 'NotFoundError') throw error;
      return;
    }
    move(event);
  });
  button.addEventListener('pointermove', (event) => {
    if (event.pointerId === pointerId) move(event);
  });
  function endPointer(event) {
    if (event.pointerId === pointerId) reset();
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);
  button.addEventListener('lostpointercapture', endPointer);

  function moveFromKeys() {
    const x = Number(keys.has('ArrowRight')) - Number(keys.has('ArrowLeft'));
    const y = Number(keys.has('ArrowDown')) - Number(keys.has('ArrowUp'));
    const scale = 0.65 / Math.max(1, Math.hypot(x, y));
    positionStick(x * scale, y * scale);
  }
  button.addEventListener('keydown', (event) => {
    if (!ARROWS.has(event.key)) return;
    event.preventDefault();
    if (pointerId !== null || (!keys.size && !onStart())) return;
    keys.add(event.key);
    button.classList.add('is-held');
    moveFromKeys();
  });
  button.addEventListener('keyup', (event) => {
    if (!keys.has(event.key)) return;
    event.preventDefault();
    if (keys.size === 1) reset();
    else {
      keys.delete(event.key);
      moveFromKeys();
    }
  });
  button.addEventListener('blur', () => {
    if (keys.size) reset();
  });
  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) reset();
  });

  return { direction, isActive, reset };
}
