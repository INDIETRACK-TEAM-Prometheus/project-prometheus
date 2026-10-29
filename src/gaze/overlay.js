export function gazeViewportPoint(sample, rect) {
  const p = sample?.rawScreenXY;
  if (sample?.valid !== true || !Number.isFinite(p?.x) || !Number.isFinite(p?.y) || !Number.isFinite(rect?.left) || !Number.isFinite(rect?.top) || !Number.isFinite(rect?.width) || !Number.isFinite(rect?.height) || rect.width <= 0 || rect.height <= 0) return null;
  const right = rect.right ?? rect.left + rect.width, bottom = rect.bottom ?? rect.top + rect.height;
  if (p.x < rect.left || p.x >= right || p.y < rect.top || p.y >= bottom) return null;
  return {x: (p.x - rect.left) / rect.width, y: (p.y - rect.top) / rect.height};
}

export function gazeMarkerPosition(point, {active = false, paused = false, calibrating = false} = {}) {
  if (!active || paused || calibrating || !Number.isFinite(point?.x) || !Number.isFinite(point?.y) || point.x < 0 || point.x >= 1 || point.y < 0 || point.y >= 1) return null;
  return {left: `${point.x * 100}%`, top: `${point.y * 100}%`};
}
