const finite3 = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const norm = value => Math.hypot(...value);
const sub = (a, b) => a.map((value, i) => value - b[i]);
const addScaled = (origin, direction, scale) => origin.map((value, i) => value + direction[i] * scale);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unavailable = reason => ({status:'unavailable', pointM:null, normalized:null, reason});

// Inputs must be measured 3D rays and a screen plane in one metric world frame.
// This helper does not infer eye origins or gaze directions from image landmarks.
export function intersectBinocularRaysWithScreen({leftRay, rightRay, screen} = {}) {
  const {centerM, right, up, widthM, heightM} = screen ?? {};
  if (!finite3(centerM) || !finite3(right) || !finite3(up) || !Number.isFinite(widthM) || widthM <= 0 || !Number.isFinite(heightM) || heightM <= 0) return unavailable('invalid_screen_geometry');
  if (Math.abs(norm(right) - 1) > 1e-6 || Math.abs(norm(up) - 1) > 1e-6 || Math.abs(dot(right, up)) > 1e-6) return unavailable('invalid_screen_basis');

  const normal = cross(right, up);
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
    eyeHits:{left, right:rightEye},
    // Screen-surface range and binocular vergence depth are different quantities; vergence may be unavailable.
    screenDepthM:(left.rangeM + rightEye.rangeM) / 2,
    vergence:closestApproachOfRays({leftRay, rightRay})
  };
}

// Closest approach of two forward rays r_L(t)=o_L+t d_L, r_R(s)=o_R+s d_R with t,s>=0. Never clamps: a solution that needs
// t<0 or s<0 is reported unavailable, as are near-parallel rays and excessive ray-to-ray disparity.
export function closestApproachOfRays({leftRay, rightRay} = {}, {minVergenceRad = 0.5 * Math.PI / 180, maxRayDistanceM = 0.03, minDepthM = 0.05, maxDepthM = 5} = {}) {
  const none = (reason, extra = {}) => ({status:'unavailable', reason, midpointM:null, leftPointM:null, rightPointM:null, rayDistanceM:null, vergenceRad:null, vergenceDepthM:null, leftRangeM:null, rightRangeM:null, ...extra});
  if (![minVergenceRad, minDepthM].every(Number.isFinite) || Number.isNaN(maxRayDistanceM) || Number.isNaN(maxDepthM) || minVergenceRad < 0 || maxRayDistanceM <= 0 || minDepthM < 0 || maxDepthM <= minDepthM) throw new TypeError('invalid closest-approach limits');
  const unitRay = (ray, side) => {
    if (!finite3(ray?.originM) || !finite3(ray?.direction)) return {reason:`invalid_${side}_ray`};
    const length = norm(ray.direction);
    return length < 1e-12 ? {reason:`invalid_${side}_ray`} : {o:ray.originM, d:ray.direction.map(value => value / length)};
  };
  const L = unitRay(leftRay, 'left'), R = unitRay(rightRay, 'right');
  if (L.reason || R.reason) return none(L.reason ?? R.reason);
  const b = dot(L.d, R.d), vergenceRad = Math.atan2(norm(cross(L.d, R.d)), b), w0 = sub(L.o, R.o), d = dot(L.d, w0), e = dot(R.d, w0), denominator = 1 - b * b;
  if (vergenceRad < minVergenceRad || denominator < 1e-12) return none('rays_near_parallel', {vergenceRad});
  const t = (b * e - d) / denominator, s = (e - b * d) / denominator;
  const leftPointM = addScaled(L.o, L.d, t), rightPointM = addScaled(R.o, R.d, s), rayDistanceM = norm(sub(leftPointM, rightPointM));
  if (t < 0 || s < 0) return none('closest_point_behind_origin', {vergenceRad, rayDistanceM, leftRangeM:t, rightRangeM:s});
  if (rayDistanceM > maxRayDistanceM) return none('excessive_ray_disparity', {vergenceRad, rayDistanceM, leftRangeM:t, rightRangeM:s});
  const midpointM = leftPointM.map((value, i) => (value + rightPointM[i]) / 2), eyeMidpoint = L.o.map((value, i) => (value + R.o[i]) / 2), vergenceDepthM = norm(sub(midpointM, eyeMidpoint));
  if (vergenceDepthM < minDepthM || vergenceDepthM > maxDepthM) return none('vergence_depth_out_of_range', {vergenceRad, rayDistanceM, vergenceDepthM, leftRangeM:t, rightRangeM:s});
  return {status:'ok', reason:null, midpointM, leftPointM, rightPointM, rayDistanceM, vergenceRad, vergenceDepthM, leftRangeM:t, rightRangeM:s, depthKind:'binocular_vergence'};
}

// ---- uncertainty propagation -----------------------------------------------------------------------------------
function seededRandom(seed) { // mulberry32
  let a = Number.isSafeInteger(seed) && seed >= 0 ? seed >>> 0 : 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gaussian = random => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
function tangentBasis(d) {
  const u = cross(d, Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]), un = norm(u), uu = u.map(value => value / un);
  return [uu, cross(d, uu)];
}
// Small-angle tangent perturbation (tan-angle semantics): d' = normalize(d + a u + b v).
function perturbed(ray, a, b, originOffset = [0, 0, 0]) {
  const length = norm(ray.direction), d = ray.direction.map(value => value / length), [u, v] = tangentBasis(d), raw = d.map((value, i) => value + a * u[i] + b * v[i]), n = norm(raw);
  return {originM:ray.originM.map((value, i) => value + originOffset[i]), direction:raw.map(value => value / n)};
}
const sigmaPair = (sigma, name) => {
  const pair = Array.isArray(sigma) ? sigma : [sigma, sigma];
  if (pair.length !== 2 || !pair.every(value => Number.isFinite(value) && value >= 0)) throw new TypeError(`${name} must be a non-negative number or [a,b] tangent sigmas in radians`);
  return pair;
};
const quantile = (sorted, p) => { const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };

// Propagate direction (and optional origin) noise into vergence depth. method 'monte_carlo' applies the same limits to every draw and
// reports the valid fraction; 'jacobian' linearises with central differences. Status 'uncertain' means the depth exists but its
// relative spread exceeds maxRelativeStd, so it must not be shown as a precise measurement.
export function vergenceDepthUncertainty({leftRay, rightRay, leftSigmaRad, rightSigmaRad, originSigmaM = 0, method = 'monte_carlo', samples = 4000, seed = 1, maxRelativeStd = 0.25, minValidFraction = 0.9, limits = {}} = {}) {
  const sl = sigmaPair(leftSigmaRad, 'leftSigmaRad'), sr = sigmaPair(rightSigmaRad, 'rightSigmaRad');
  if (!Number.isFinite(originSigmaM) || originSigmaM < 0 || !['monte_carlo', 'jacobian'].includes(method) || !Number.isInteger(samples) || samples < 100 || !Number.isFinite(maxRelativeStd) || maxRelativeStd <= 0) throw new TypeError('invalid uncertainty options');
  const nominal = closestApproachOfRays({leftRay, rightRay}, limits);
  if (nominal.status !== 'ok') return {status:'unavailable', reason:nominal.reason, method, nominal, depthM:null, stdM:null, relativeStd:null};
  const out = extra => ({method, nominal, depthM:nominal.vergenceDepthM, ...extra});
  const finish = stdM => {
    const relativeStd = stdM / nominal.vergenceDepthM, ok = relativeStd <= maxRelativeStd;
    return {stdM, relativeStd, status:ok ? 'ok' : 'uncertain', reason:ok ? null : 'depth_relative_std_exceeds_limit'};
  };
  if (method === 'jacobian') {
    const wide = {minVergenceRad:0, maxRayDistanceM:Infinity, minDepthM:0, maxDepthM:Infinity}, step = 1e-6;
    const depthAt = x => { const r = closestApproachOfRays({leftRay:perturbed(leftRay, x[0], x[1], x.slice(4, 7)), rightRay:perturbed(rightRay, x[2], x[3], x.slice(7, 10))}, wide); return r.status === 'ok' ? r.vergenceDepthM : NaN; };
    const sigmas = [sl[0], sl[1], sr[0], sr[1], ...Array(6).fill(originSigmaM)];
    let variance = 0;
    for (let k = 0; k < 10; k++) {
      if (sigmas[k] === 0) continue;
      const plus = Array(10).fill(0), minus = Array(10).fill(0);
      plus[k] = step; minus[k] = -step;
      const derivative = (depthAt(plus) - depthAt(minus)) / (2 * step);
      if (!Number.isFinite(derivative)) return out({status:'unavailable', reason:'jacobian_unavailable', stdM:null, relativeStd:null});
      variance += (derivative * sigmas[k]) ** 2;
    }
    return out({...finish(Math.sqrt(variance)), samples:null, validFraction:null});
  }
  const random = seededRandom(seed), depths = [];
  for (let i = 0; i < samples; i++) {
    const offsetL = originSigmaM ? [0, 0, 0].map(() => gaussian(random) * originSigmaM) : undefined, offsetR = originSigmaM ? [0, 0, 0].map(() => gaussian(random) * originSigmaM) : undefined;
    const left = perturbed(leftRay, gaussian(random) * sl[0], gaussian(random) * sl[1], offsetL), right = perturbed(rightRay, gaussian(random) * sr[0], gaussian(random) * sr[1], offsetR);
    const r = closestApproachOfRays({leftRay:left, rightRay:right}, limits);
    if (r.status === 'ok') depths.push(r.vergenceDepthM);
  }
  const validFraction = depths.length / samples;
  if (depths.length < 10 || validFraction < minValidFraction) return out({status:'unavailable', reason:'depth_mostly_unavailable_under_noise', samples, validFraction, stdM:null, relativeStd:null});
  depths.sort((a, b) => a - b);
  const meanM = depths.reduce((s, v) => s + v, 0) / depths.length, stdM = Math.sqrt(depths.reduce((s, v) => s + (v - meanM) ** 2, 0) / (depths.length - 1));
  return out({...finish(stdM), samples, validFraction, meanM, p05M:quantile(depths, .05), p95M:quantile(depths, .95)});
}

// Monte Carlo propagation of direction noise to the binocular screen hit (normalised coordinates, plus metres across the screen).
export function binocularScreenUncertainty({leftRay, rightRay, screen, leftSigmaRad, rightSigmaRad, samples = 2000, seed = 1} = {}) {
  const sl = sigmaPair(leftSigmaRad, 'leftSigmaRad'), sr = sigmaPair(rightSigmaRad, 'rightSigmaRad');
  if (!Number.isInteger(samples) || samples < 100) throw new TypeError('samples >= 100 required');
  const nominal = intersectBinocularRaysWithScreen({leftRay, rightRay, screen});
  if (nominal.status === 'unavailable') return {status:'unavailable', reason:nominal.reason, nominal};
  const random = seededRandom(seed), xs = [], ys = [];
  for (let i = 0; i < samples; i++) {
    const r = intersectBinocularRaysWithScreen({leftRay:perturbed(leftRay, gaussian(random) * sl[0], gaussian(random) * sl[1]), rightRay:perturbed(rightRay, gaussian(random) * sr[0], gaussian(random) * sr[1]), screen});
    if (r.status !== 'unavailable') { xs.push(r.normalized.x); ys.push(r.normalized.y); }
  }
  const validFraction = xs.length / samples;
  if (xs.length < 10) return {status:'unavailable', reason:'screen_hit_mostly_unavailable_under_noise', validFraction, nominal};
  const std = values => { const m = values.reduce((s, v) => s + v, 0) / values.length; return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1)); };
  const stdNormalized = {x:std(xs), y:std(ys)};
  return {status:'ok', nominal, samples, validFraction, stdNormalized, stdM:{x:stdNormalized.x * screen.widthM, y:stdNormalized.y * screen.heightM}};
}
