const finite3 = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const norm = value => Math.hypot(...value);
const sub = (a, b) => a.map((value, i) => value - b[i]);
const addScaled = (origin, direction, scale) => origin.map((value, i) => value + direction[i] * scale);
const unavailable = reason => ({status:'unavailable', pointM:null, normalized:null, reason});

// Inputs must be measured 3D rays and a screen plane in one metric world frame.
// This helper does not infer eye origins or gaze directions from image landmarks.
export function intersectBinocularRaysWithScreen({leftRay, rightRay, screen} = {}) {
  const {centerM, right, up, widthM, heightM} = screen ?? {};
  if (!finite3(centerM) || !finite3(right) || !finite3(up) || !Number.isFinite(widthM) || widthM <= 0 || !Number.isFinite(heightM) || heightM <= 0) return unavailable('invalid_screen_geometry');
  if (Math.abs(norm(right) - 1) > 1e-6 || Math.abs(norm(up) - 1) > 1e-6 || Math.abs(dot(right, up)) > 1e-6) return unavailable('invalid_screen_basis');

  const normal = [right[1] * up[2] - right[2] * up[1], right[2] * up[0] - right[0] * up[2], right[0] * up[1] - right[1] * up[0]];
  const intersect = (ray, side) => {
    if (!finite3(ray?.originM) || !finite3(ray?.direction)) return {reason:`invalid_${side}_ray`};
    const directionLength = norm(ray.direction);
    if (directionLength < 1e-12) return {reason:`invalid_${side}_ray`};
    const direction = ray.direction.map(value => value / directionLength);
    const denominator = dot(direction, normal);
    if (Math.abs(denominator) < 1e-9) return {reason:`${side}_ray_parallel_to_screen`};
    const rangeM = dot(sub(centerM, ray.originM), normal) / denominator;
    if (!Number.isFinite(rangeM) || rangeM <= 0) return {reason:`${side}_screen_intersection_not_forward`};
    const pointM = addScaled(ray.originM, direction, rangeM);
    const offset = sub(pointM, centerM);
    const normalized = {x:0.5 + dot(offset, right) / widthM, y:0.5 - dot(offset, up) / heightM};
    return {pointM, rangeM, normalized, insideScreen:normalized.x >= 0 && normalized.x <= 1 && normalized.y >= 0 && normalized.y <= 1};
  };

  const left = intersect(leftRay, 'left');
  if (left.reason) return unavailable(left.reason);
  const rightEye = intersect(rightRay, 'right');
  if (rightEye.reason) return unavailable(rightEye.reason);
  const normalized = {x:(left.normalized.x + rightEye.normalized.x) / 2, y:(left.normalized.y + rightEye.normalized.y) / 2};
  const pointM = left.pointM.map((value, i) => (value + rightEye.pointM[i]) / 2);
  const binocularDisagreementM = norm(sub(left.pointM, rightEye.pointM));
  const insideScreen = left.insideScreen && rightEye.insideScreen;
  return {
    status:insideScreen ? 'ok' : 'outside_screen',
    pointM,
    normalized,
    binocularDisagreementM,
    eyeHits:{left, right:rightEye}
  };
}
