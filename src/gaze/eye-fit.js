// G1-C/G1-D eye geometry estimation from caller-supplied metric 3D data. Nothing here infers 3D from a 2D image:
// a sphere fit explains the points it is given, and kappa is only as good as the optical axes and target directions it receives.
import {createEyeSphere} from './eye-sphere.js';

const finite = Number.isFinite;
const vec = v => Array.isArray(v) && v.length === 3 && v.every(finite);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = v => Math.hypot(v[0], v[1], v[2]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = v => { const n = norm(v); return n < 1e-12 ? null : [v[0] / n, v[1] / n, v[2] / n]; };
const median = values => { const s = [...values].sort((a, b) => a - b), i = (s.length - 1) / 2; return (s[Math.floor(i)] + s[Math.ceil(i)]) / 2; };

// Gaussian elimination with partial pivoting; null when singular or ill-conditioned.
function solve(matrix, rhs) {
  const n = rhs.length, a = matrix.map((row, i) => [...row, rhs[i]]), scale = Math.max(1e-300, ...matrix.map((row, i) => Math.abs(row[i])));
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-13 * scale) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = c + 1; r < n; r++) { const f = a[r][c] / a[c][c]; for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k]; }
  }
  const x = Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let v = a[r][n]; for (let k = r + 1; k < n; k++) v -= a[r][k] * x[k]; x[r] = v / a[r][r]; }
  return x;
}
function invert(matrix) {
  const n = matrix.length, columns = [];
  for (let c = 0; c < n; c++) { const x = solve(matrix, Array.from({length:n}, (_, i) => i === c ? 1 : 0)); if (!x) return null; columns.push(x); }
  return matrix.map((_, r) => columns.map(col => col[r]));
}

export function rotationMatrixFromAxisAngle(axis, angleRad) {
  const u = vec(axis) ? unit(axis) : null;
  if (!u || !finite(angleRad)) throw new TypeError('axis and angle required');
  const c = Math.cos(angleRad), s = Math.sin(angleRad), t = 1 - c, [x, y, z] = u;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}
export const rotateVector = (matrix, v) => [dot(matrix.slice(0, 3), v), dot(matrix.slice(3, 6), v), dot(matrix.slice(6, 9), v)];
export const angleBetweenRad = (a, b) => Math.atan2(norm(cross(a, b)), dot(a, b));

// Robust sphere fit: algebraic start, then Levenberg-Marquardt/IRLS on geometric residuals d_i=|p_i-c|-r with a Huber loss
// and optional Gaussian priors on radius (and centre). `status`:
//   ok          data alone constrain centre and radius within the ambiguity bounds
//   ambiguous   best estimate returned, but radius/centre rest on the prior (e.g. points from a small cap); do not call it measured
//   unavailable too few / degenerate / non-finite geometry
export function fitSphere(points, {prior = null, huberK = 1.345, maxIterations = 100, pointSigmaFloorM = 1e-5, ambiguityRadiusStdM = null, ambiguityCenterStdM = null} = {}) {
  if (!Array.isArray(points)) throw new TypeError('points array required');
  const pts = points.map(p => Array.isArray(p) ? p : p?.positionM);
  if (!pts.every(vec)) throw new TypeError('every point must be a finite [x,y,z] or {positionM}');
  if (prior !== null && (!finite(prior?.radiusM) || prior.radiusM <= 0 || !finite(prior.radiusSigmaM) || prior.radiusSigmaM <= 0 || (prior.centerM !== undefined && (!vec(prior.centerM) || !finite(prior.centerSigmaM) || prior.centerSigmaM <= 0)))) throw new TypeError('invalid prior');
  if (![huberK, pointSigmaFloorM].every(v => finite(v) && v > 0) || !Number.isInteger(maxIterations) || maxIterations < 1) throw new TypeError('invalid fit options');
  const unavailable = reason => ({status:'unavailable', reason, measured:false, centerM:null, radiusM:null, residualsM:[], pointCount:pts.length});
  if (pts.length < 4) return unavailable('too_few_points');
  const n = pts.length, centroid = [0, 1, 2].map(k => pts.reduce((s, p) => s + p[k], 0) / n), q = pts.map(p => sub(p, centroid));
  // Algebraic start: |q|^2 = 2 q.c + k.
  const ata = Array.from({length:4}, () => Array(4).fill(0)), atb = Array(4).fill(0);
  for (const v of q) { const row = [2 * v[0], 2 * v[1], 2 * v[2], 1], b = dot(v, v); for (let i = 0; i < 4; i++) { atb[i] += row[i] * b; for (let j = 0; j < 4; j++) ata[i][j] += row[i] * row[j]; } }
  const algebraic = solve(ata, atb);
  let c = [...centroid], r = prior?.radiusM ?? (pts.reduce((s, p) => s + norm(sub(p, centroid)), 0) / n || 1e-3);
  if (algebraic) { const r2 = algebraic[3] + algebraic[0] ** 2 + algebraic[1] ** 2 + algebraic[2] ** 2; if (r2 > 0) { c = [0, 1, 2].map(k => centroid[k] + algebraic[k]); r = Math.sqrt(r2); } }
  else if (!prior) return unavailable('degenerate_point_geometry');
  if (!c.every(finite) || !finite(r) || r <= 0) return unavailable('degenerate_point_geometry');

  const distances = center => pts.map(p => norm(sub(p, center)));
  const start = distances(c).map(d => d - r);
  let sigma0 = Math.max(1.4826 * median(start.map(d => Math.abs(d - median(start)))), pointSigmaFloorM);
  const rho = u => Math.abs(u) <= huberK ? u * u / 2 : huberK * (Math.abs(u) - huberK / 2), weight = u => Math.abs(u) <= huberK ? 1 : huberK / Math.abs(u);
  const priorCost = ([cx, cy, cz, rad]) => (prior ? ((rad - prior.radiusM) / prior.radiusSigmaM) ** 2 / 2 : 0) + (prior?.centerM ? ([cx, cy, cz].reduce((s, v, k) => s + (v - prior.centerM[k]) ** 2, 0) / prior.centerSigmaM ** 2) / 2 : 0);
  const cost = theta => distances(theta.slice(0, 3)).reduce((s, d) => s + rho((d - theta[3]) / sigma0), 0) + priorCost(theta);
  const linearise = theta => {
    const center = theta.slice(0, 3), H = Array.from({length:4}, () => Array(4).fill(0)), g = Array(4).fill(0), W = Array.from({length:4}, () => Array(4).fill(0)), weights = [];
    for (const p of pts) {
      const offset = sub(center, p), dist = norm(offset), d = dist - theta[3], w = weight(d / sigma0);
      weights.push(w);
      const J = dist < 1e-12 ? [0, 0, 0, -1] : [offset[0] / dist, offset[1] / dist, offset[2] / dist, -1];
      for (let i = 0; i < 4; i++) { g[i] += w * d * J[i] / sigma0 ** 2; for (let j = 0; j < 4; j++) { H[i][j] += w * J[i] * J[j] / sigma0 ** 2; W[i][j] += w * J[i] * J[j]; } }
    }
    if (prior) { H[3][3] += 1 / prior.radiusSigmaM ** 2; g[3] += (theta[3] - prior.radiusM) / prior.radiusSigmaM ** 2; }
    if (prior?.centerM) for (let k = 0; k < 3; k++) { H[k][k] += 1 / prior.centerSigmaM ** 2; g[k] += (theta[k] - prior.centerM[k]) / prior.centerSigmaM ** 2; }
    return {H, g, W, weights};
  };

  let theta = [...c, r], current = cost(theta), mu = 1e-3, iterations = 0, converged = false;
  for (; iterations < maxIterations && !converged; iterations++) {
    const {H, g} = linearise(theta);
    let accepted = false;
    for (let attempt = 0; attempt < 30 && !accepted; attempt++) {
      const damped = H.map((row, i) => row.map((v, j) => i === j ? v + mu * Math.max(v, 1e-12) : v)), delta = solve(damped, g.map(v => -v));
      if (!delta) { mu *= 10; continue; }
      const next = theta.map((v, i) => v + delta[i]);
      if (next[3] <= 0) { mu *= 10; continue; }
      const nextCost = cost(next);
      if (nextCost <= current) { accepted = true; converged = Math.hypot(...delta.slice(0, 3), delta[3]) < 1e-12 + 1e-9 * theta[3] || current - nextCost < 1e-14 * Math.max(1, current); theta = next; current = nextCost; mu = Math.max(mu / 3, 1e-12); }
      else mu *= 4;
    }
    if (!accepted) { converged = true; break; }
  }
  const center = theta.slice(0, 3), radius = theta[3];
  if (!center.every(finite) || !finite(radius) || radius <= 0) return unavailable('fit_diverged');
  const residualsM = distances(center).map(d => d - radius), med = median(residualsM);
  const sigmaFinal = Math.max(1.4826 * median(residualsM.map(d => Math.abs(d - med))), pointSigmaFloorM);
  sigma0 = sigmaFinal; // posterior and data-only covariances share one noise scale
  const {H, W, weights} = linearise(theta), posterior = invert(H), dataInverse = invert(W);
  const stdOf = (cov, scale) => cov ? {centerM:[0, 1, 2].map(k => Math.sqrt(Math.max(0, cov[k][k])) * scale), radiusM:Math.sqrt(Math.max(0, cov[3][3])) * scale} : {centerM:[Infinity, Infinity, Infinity], radiusM:Infinity};
  const dataStd = stdOf(dataInverse, sigmaFinal), posteriorStd = stdOf(posterior, 1);
  const radiusBound = ambiguityRadiusStdM ?? 0.25 * (prior?.radiusM ?? radius), centerBound = ambiguityCenterStdM ?? 0.5 * (prior?.radiusM ?? radius);
  let status = 'ok', reason = null;
  if (!(dataStd.radiusM <= radiusBound)) { status = 'ambiguous'; reason = 'radius_not_constrained_by_data'; }
  else if (!(Math.max(...dataStd.centerM) <= centerBound)) { status = 'ambiguous'; reason = 'center_not_constrained_by_data'; }
  if (status === 'ambiguous' && !prior) { status = 'unavailable'; }
  if (status === 'unavailable') return {...unavailable(reason), dataStd};
  return {
    status, reason, measured:status === 'ok', centerM:center, radiusM:radius, residualsM, rmsM:Math.sqrt(residualsM.reduce((s, d) => s + d * d, 0) / n),
    medianAbsResidualM:median(residualsM.map(Math.abs)), scaleM:sigmaFinal, weights, inlierCount:residualsM.filter(d => Math.abs(d - med) <= 3 * sigmaFinal).length, pointCount:n,
    dataStd, posteriorStd, priorUsed:prior !== null, iterations, converged, units:'m'
  };
}

// Build a per-eye model from a fit: >=30 modeled surface nodes plus (optionally) the observed points as separately flagged nodes.
export function eyeSphereFromFit({fit, eye, coordinateFrameId, observedAt, count = 32, rotationMatrix, points = null} = {}) {
  if (!fit || !['ok', 'ambiguous'].includes(fit.status)) return {status:'unavailable', reason:fit?.reason ?? 'fit_unavailable', measured:false, sphere:null};
  const sphere = createEyeSphere({eye, centerM:fit.centerM, radiusM:fit.radiusM, rotationMatrix, count, coordinateFrameId, observedAt});
  const observed = [];
  if (points) {
    if (!Array.isArray(points) || points.length !== fit.pointCount) throw new TypeError('points must match the fitted points');
    points.forEach((p, i) => {
      const positionM = Array.isArray(p) ? p : p.positionM, normal = unit(sub(positionM, fit.centerM));
      if (normal) observed.push({id:`${eye}:observed:${i}`, eye, source:'observed_point', observed:true, positionM:[...positionM], normal, residualM:fit.residualsM[i]});
    });
  }
  return {status:fit.status, reason:fit.reason, measured:fit.measured, sphere:{...sphere, nodes:[...sphere.nodes, ...observed], fit:{status:fit.status, rmsM:fit.rmsM, radiusStdM:fit.dataStd.radiusM, centerStdM:fit.dataStd.centerM, priorUsed:fit.priorUsed, measured:fit.measured}}};
}

// Optical axis -> visual axis offset (kappa) as two angles in a gaze-aligned frame built from a fixed `upHint`
// (default +Y). alpha is horizontal (+ toward +x of that frame), beta vertical. observations: [{opticalAxis, targetDirection}] where
// targetDirection is the unit direction from the eye centre to a known calibration target, in the same frame as the optical axis.
export function gazeFrame(opticalAxis, upHint = [0, 1, 0]) {
  const z = vec(opticalAxis) ? unit(opticalAxis) : null, up = vec(upHint) ? unit(upHint) : null;
  if (!z || !up) return null;
  const x = unit(cross(up, z));
  return x && norm(cross(up, z)) > 1e-3 ? {x, y:cross(z, x), z} : null;
}
const localDirection = ({alpha, beta}) => [Math.cos(beta) * Math.sin(alpha), Math.sin(beta), Math.cos(beta) * Math.cos(alpha)];
export function applyKappa(opticalAxis, kappa, {upHint = [0, 1, 0]} = {}) {
  const frame = gazeFrame(opticalAxis, upHint);
  if (!frame || !finite(kappa?.alphaRad) || !finite(kappa?.betaRad)) return null;
  const l = localDirection({alpha:kappa.alphaRad, beta:kappa.betaRad});
  return [0, 1, 2].map(k => frame.x[k] * l[0] + frame.y[k] * l[1] + frame.z[k] * l[2]);
}

export function estimateKappa(observations, {upHint = [0, 1, 0], minObservations = 6, minOpticalSpreadRad = 5 * Math.PI / 180, maxMagnitudeRad = 15 * Math.PI / 180, trimSigmas = 3, maxTrimPasses = 3} = {}) {
  if (!Array.isArray(observations)) throw new TypeError('observations array required');
  const unavailable = (reason, extra = {}) => ({status:'unavailable', reason, ...extra});
  const rows = observations.map(o => {
    const optical = vec(o?.opticalAxis) ? unit(o.opticalAxis) : null, target = vec(o?.targetDirection) ? unit(o.targetDirection) : null;
    if (!optical || !target) throw new TypeError('observations need finite non-zero opticalAxis and targetDirection');
    const frame = gazeFrame(optical, upHint);
    return frame ? {optical, local:[dot(target, frame.x), dot(target, frame.y), dot(target, frame.z)]} : null;
  }).map((row, index) => row && {...row, index});
  let kept = rows.filter(Boolean);
  if (kept.length < minObservations) return unavailable('too_few_usable_observations', {usable:kept.length});
  const mean = optical => unit(optical.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]));
  const centre = mean(kept.map(k => k.optical)), spread = Math.max(...kept.map(k => angleBetweenRad(k.optical, centre)));
  if (!centre || spread < minOpticalSpreadRad) return unavailable('insufficient_optical_axis_spread', {opticalSpreadRad:spread});
  const estimate = list => { const m = unit(list.reduce((s, k) => [s[0] + k.local[0], s[1] + k.local[1], s[2] + k.local[2]], [0, 0, 0])); return m && {alpha:Math.atan2(m[0], m[2]), beta:Math.atan2(m[1], Math.hypot(m[0], m[2])), direction:m}; };
  const residual = (k, e) => angleBetweenRad(k.local, e.direction);
  let e = estimate(kept);
  for (let pass = 0; e && pass < maxTrimPasses; pass++) {
    const res = kept.map(k => residual(k, e)), scale = Math.max(1.4826 * median(res.map(v => Math.abs(v - median(res)))), 1e-4);
    const next = kept.filter((k, i) => res[i] <= median(res) + trimSigmas * scale);
    if (next.length === kept.length || next.length < minObservations) break;
    kept = next; e = estimate(kept);
  }
  if (!e) return unavailable('degenerate_observations');
  const res = kept.map(k => residual(k, e)), rms = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / res.length), magnitude = angleBetweenRad([0, 0, 1], e.direction);
  if (magnitude > maxMagnitudeRad) return unavailable('kappa_outside_plausible_range', {diagnostic:{alphaRad:e.alpha, betaRad:e.beta, magnitudeRad:magnitude}});
  const kept_ = new Set(kept.map(k => k.index)), local = localDirection({alpha:e.alpha, beta:e.beta});
  return {
    status:'ok', alphaRad:e.alpha, betaRad:e.beta, magnitudeRad:magnitude, rotationMatrix:rotationBetween([0, 0, 1], local), usedObservations:kept.length, totalObservations:observations.length,
    outlierIndices:observations.map((_, i) => i).filter(i => !kept_.has(i)), residualRad:{rms, max:Math.max(...res)}, stdRad:{alpha:rms / Math.sqrt(kept.length), beta:rms / Math.sqrt(kept.length)}, opticalSpreadRad:spread, frame:'gaze_aligned_up_hint'
  };
}

// Minimal rotation taking unit a to unit b.
export function rotationBetween(a, b) {
  const ua = vec(a) ? unit(a) : null, ub = vec(b) ? unit(b) : null;
  if (!ua || !ub) throw new TypeError('non-zero vectors required');
  const axis = cross(ua, ub), s = norm(axis), c = dot(ua, ub);
  if (s < 1e-12) {
    if (c > 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    return rotationMatrixFromAxisAngle(unit(cross(ua, Math.abs(ua[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), Math.PI);
  }
  return rotationMatrixFromAxisAngle(axis, Math.atan2(s, c));
}
