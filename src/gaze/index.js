// Provider-independent gaze primitives. No camera is opened by this module.
const finite = n => Number.isFinite(n);
const point = p => p && finite(p.x) && finite(p.y);
const rect = r => r && finite(r.x) && finite(r.y) && finite(r.width) && finite(r.height) && r.width > 0 && r.height > 0;

export const LANDMARK_RESIDUAL_FIT_ATTEMPTS = 18;

// Least-squares affine regression over caller-supplied features, with an intercept.
// Modified Gram-Schmidt avoids squaring the condition number of normal equations.
export function fitCalibration(samples) {
  if (!Array.isArray(samples) || !samples.length) throw new Error('training samples required');
  const dimension = samples[0].features?.length;
  if (!Number.isInteger(dimension) || dimension < 1 || samples.length < dimension + 1) throw new Error('insufficient samples');
  const ids = new Set();
  for (const s of samples) {
    if (typeof s.id !== 'string' || !s.id || ids.has(s.id) || !Array.isArray(s.features) || s.features.length !== dimension || !s.features.every(finite) || !point(s.target)) throw new Error('invalid training sample');
    ids.add(s.id);
  }
  const rows = samples.map(s => [1, ...s.features]);
  const n = dimension + 1, q = [], r = Array.from({length:n}, () => Array(n).fill(0));
  for (let j = 0; j < n; j++) {
    const v = rows.map(row => row[j]);
    for (let i = 0; i < j; i++) { r[i][j] = q[i].reduce((sum, value, k) => sum + value * v[k], 0); for (let k = 0; k < v.length; k++) v[k] -= r[i][j] * q[i][k]; }
    r[j][j] = Math.hypot(...v);
    if (r[j][j] < 1e-10) throw new Error('degenerate calibration');
    q.push(v.map(value => value / r[j][j]));
  }
  function solve(axis) {
    const rhs = q.map(col => col.reduce((sum, value, k) => sum + value * samples[k].target[axis], 0));
    const result = Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) { let v = rhs[i]; for (let j = i + 1; j < n; j++) v -= r[i][j] * result[j]; result[i] = v / r[i][i]; }
    return result;
  }
  return {dimension, x:solve('x'), y:solve('y'), trainingIds:[...ids], featureBounds:Array.from({length:dimension},(_,i)=>({min:Math.min(...samples.map(s=>s.features[i])),max:Math.max(...samples.map(s=>s.features[i]))}))};
}

// Bounding-box guard is necessary but does not prove interpolation in the
// training convex hull or ensure tracking quality.
export function withinCalibrationBounds(model, features) {
  return Array.isArray(features) && features.length === model.dimension && Array.isArray(model.featureBounds) && model.featureBounds.length === model.dimension && features.every((v,i)=>finite(v) && finite(model.featureBounds[i]?.min) && finite(model.featureBounds[i]?.max) && v >= model.featureBounds[i].min && v <= model.featureBounds[i].max);
}

export function predictCalibration(model, features) {
  if (!Array.isArray(features) || features.length !== model.dimension || !features.every(finite)) throw new Error('invalid features');
  const input = [1, ...features];
  return {x:input.reduce((a, v, i) => a + v * model.x[i], 0), y:input.reduce((a, v, i) => a + v * model.y[i], 0)};
}

// Compact MediaPipe iris/lid cues; raw landmarks stay inside the worker.
export function landmarkGazeFeatures(landmarks, width, height) {
  if (!Array.isArray(landmarks) || !finite(width) || !finite(height) || width < 1 || height < 1) return null;
  const pixel = index => {
    const p = landmarks[index];
    const quality = p && ['visibility','presence'].every(key => p[key] === undefined || (finite(p[key]) && p[key] >= .5 && p[key] <= 1));
    return quality && finite(p.x) && finite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1
      ? {x:p.x * width, y:p.y * height}
      : null;
  };
  const eyes = [
    {corners:[263,362], iris:473, lids:[385,386,387]},
    {corners:[33,133], iris:468, lids:[158,159,160]}
  ];
  const offsets = eyes.map(({corners, iris, lids}) => {
    const [a,b] = corners.map(pixel), center = pixel(iris), upper = lids.map(pixel);
    if (!a || !b || !center || upper.some(p => !p)) return null;
    const span = Math.hypot(b.x-a.x,b.y-a.y), dx=b.x-a.x;
    if (span < 4 || Math.abs(dx) < 1e-6) return null;
    const baselineY = x => a.y + (x-a.x)*(b.y-a.y)/dx;
    return [
      (center.x-(a.x+b.x)/2)/span,
      (center.y-baselineY(center.x))/span,
      upper.reduce((sum,p)=>sum+p.y-baselineY(p.x),0)/(upper.length*span)
    ];
  });
  if (offsets.some(values => !values)) return null;
  const features = [0,1,2].map(index => (offsets[0][index]+offsets[1][index])/2);
  return features.every(value => finite(value) && Math.abs(value) <= 1) ? features : null;
}

export function fitLandmarkResidualCalibration(attempts, screen) {
  if (!rect({x:0,y:0,width:screen?.width,height:screen?.height}) || !Array.isArray(attempts) || attempts.length !== LANDMARK_RESIDUAL_FIT_ATTEMPTS) return null;
  const samples = attempts.map(sample => {
    if (sample?.valid === false || !Array.isArray(sample?.features) || sample.features.length !== 2 || !sample.features.every(value => finite(value) && value >= 0 && value <= 1) || !Array.isArray(sample.landmarkFeatures) || sample.landmarkFeatures.length !== 3 || !sample.landmarkFeatures.every(value => finite(value) && Math.abs(value) <= 1) || !point(sample.target) || sample.target.x < 0 || sample.target.x > screen.width || sample.target.y < 0 || sample.target.y > screen.height) return null;
    return {
      id:sample.id,
      features:sample.landmarkFeatures,
      target:{x:sample.target.x/screen.width-sample.features[0],y:sample.target.y/screen.height-sample.features[1]}
    };
  });
  if (samples.some(sample => !sample)) return null;
  try { return fitCalibration(samples); } catch { return null; }
}

export function predictLandmarkResidual(model, baselineFeatures, landmarkFeatures) {
  if (!model || !Array.isArray(baselineFeatures) || baselineFeatures.length !== 2 || !baselineFeatures.every(value => finite(value) && value >= 0 && value <= 1) || !withinCalibrationBounds(model,landmarkFeatures)) return null;
  const residual = predictCalibration(model,landmarkFeatures);
  const corrected = [baselineFeatures[0]+residual.x,baselineFeatures[1]+residual.y];
  return corrected.every(value => finite(value) && value >= 0 && value <= 1) ? corrected : null;
}

export function landmarkResidualMetrics(model, attempts, screen) {
  if (!rect({x:0,y:0,width:screen?.width,height:screen?.height}) || !Array.isArray(attempts) || !attempts.length) throw new Error('screen and attempts required');
  const errors=[];
  let correctedCount=0;
  for (const sample of attempts) {
    if (sample?.valid === false) continue;
    if (!point(sample?.target) || !Array.isArray(sample.features) || sample.features.length !== 2 || !sample.features.every(value => finite(value) && value >= 0 && value <= 1)) throw new Error('invalid validation sample');
    const predicted = predictLandmarkResidual(model,sample.features,sample.landmarkFeatures) ?? sample.features;
    if (predicted[0] !== sample.features[0] || predicted[1] !== sample.features[1]) correctedCount++;
    errors.push(Math.hypot((predicted[0]-sample.target.x/screen.width)*screen.width,(predicted[1]-sample.target.y/screen.height)*screen.height)/Math.hypot(screen.width,screen.height));
  }
  errors.sort((a,b)=>a-b);
  return {attempts:attempts.length,validCount:errors.length,validRate:errors.length/attempts.length,p50:percentile(errors,.5),p95:percentile(errors,.95),correctedCount,unit:'screen_diagonal_fraction'};
}

export function landmarkResidualPassesSelection(basePassed, model, baseline, candidate) {
  return basePassed === true && !!model && finite(baseline?.p95) && finite(candidate?.p95) && candidate.p95 < baseline.p95 && candidate.p95 <= .05 && candidate.validRate >= .8 && candidate.correctedCount > 0 && candidate.correctedCount >= Math.ceil(.8*candidate.validCount);
}

function percentile(sorted, p) { if (!sorted.length) return null; const i = (sorted.length - 1) * p, low = Math.floor(i), high = Math.ceil(i); return sorted[low] + (sorted[high] - sorted[low]) * (i - low); }
// The denominator includes invalid attempts; callers must supply all attempts.
export function calibrationMetrics(model, attempts, screen, {independent = true} = {}) {
  if (!rect(screen) || !Array.isArray(attempts) || !attempts.length) throw new Error('screen and attempts required');
  const seen = new Set();
  const errors = [];
  for (const s of attempts) {
    if (typeof s.id !== 'string' || !s.id || seen.has(s.id)) throw new Error('unique sample ids required');
    seen.add(s.id);
    if (independent && model.trainingIds.includes(s.id)) throw new Error('validation sample overlaps training');
    if (s.valid === false) continue;
    if (!point(s.target)) throw new Error('invalid target');
    const p = predictCalibration(model, s.features);
    errors.push(Math.hypot(p.x - s.target.x, p.y - s.target.y) / Math.hypot(screen.width, screen.height));
  }
  errors.sort((a,b) => a-b);
  return {attempts:attempts.length, validCount:errors.length, validRate:errors.length / attempts.length, p50:percentile(errors, .5), p95:percentile(errors, .95), unit:'screen_diagonal_fraction'};
}

// All rectangles and points use the same unmirrored CSS-pixel screen space.
export function mapCoordinates(screenPoint, screen, app, worldInApp) {
  if (!point(screenPoint) || !rect(screen) || !rect(app) || !rect(worldInApp)) throw new Error('invalid geometry');
  const within = (p, r) => p.x >= r.x && p.x < r.x+r.width && p.y >= r.y && p.y < r.y+r.height;
  const screenXY = {x:(screenPoint.x-screen.x)/screen.width, y:(screenPoint.y-screen.y)/screen.height};
  const appXY = {x:screenPoint.x-app.x, y:screenPoint.y-app.y};
  const insideScreen = within(screenPoint, screen), insideApp = within(screenPoint, app);
  const inWorld = insideScreen && insideApp && within(appXY, worldInApp);
  return {screenXY, appXY, viewportXY:inWorld ? {x:(appXY.x-worldInApp.x)/worldInApp.width, y:(appXY.y-worldInApp.y)/worldInApp.height} : null, inWorld};
}

// Continuous coordinates over [0,width], not integer pixel indices.
export function mirrorPoint(p, width) { if (!point(p) || !finite(width) || width <= 0) throw new Error('invalid point or width'); return {x:width-p.x, y:p.y}; }
export function mirrorRect(r, width) { if (!rect(r) || !finite(width) || width <= 0) throw new Error('invalid rectangle or width'); return {...r, x:width-r.x-r.width}; }

// Crop uses the corners only, never the moving iris, and clips to the source frame.
export function eyeCrop(cornerA, cornerB, frame, {widthScale = 1.5, heightScale = .8} = {}) {
  if (!point(cornerA) || !point(cornerB) || !rect(frame) || !finite(widthScale) || !finite(heightScale) || widthScale <= 0 || heightScale <= 0) throw new Error('invalid crop parameters');
  const distance = Math.hypot(cornerB.x-cornerA.x, cornerB.y-cornerA.y);
  if (!distance) throw new Error('coincident eye corners');
  const cx = (cornerA.x+cornerB.x)/2, cy = (cornerA.y+cornerB.y)/2;
  const left = Math.max(frame.x, cx-distance*widthScale/2), right = Math.min(frame.x+frame.width, cx+distance*widthScale/2);
  const top = Math.max(frame.y, cy-distance*heightScale/2), bottom = Math.min(frame.y+frame.height, cy+distance*heightScale/2);
  return right > left && bottom > top ? {x:left, y:top, width:right-left, height:bottom-top} : null;
}

// Expand only the display crop upward so the preview can include brows; tracker crops stay unchanged.
export function eyePreviewCrop(crop, frame, eyeSpan) {
  if (!crop || !rect(crop) || !rect(frame) || !finite(eyeSpan) || eyeSpan <= 0) return null;
  const bottom = Math.min(frame.y+frame.height,crop.y+crop.height);
  const top = Math.max(frame.y,crop.y-eyeSpan*.55);
  return bottom > top ? {...crop,y:top,height:bottom-top} : null;
}

// Never carries forward a previous position. Quality thresholds are caller policy.
export function trackingSample({captureMs, faceDetected, leftEye, rightEye, degradedReason, rawScreenXY, calibrationValid}) {
  if (!finite(captureMs)) throw new Error('capture timestamp required');
  const eyeValid = eye => eye?.valid === true && eye.occluded !== true && eye.blink !== true;
  let reason = !faceDetected ? 'face_not_detected' : (!eyeValid(leftEye) || !eyeValid(rightEye)) ? 'eye_invalid' : degradedReason ? 'degraded' : !calibrationValid ? 'calibration_required' : !point(rawScreenXY) ? 'gaze_unavailable' : null;
  return {captureMs, valid:reason === null, invalidReason:reason, degradedReason:degradedReason || null, leftEye, rightEye, rawScreenXY:reason ? null : {...rawScreenXY}};
}

// Explicit start authorization is required before a provider can see a frame.
export function createLandmarkSession(provider) {
  if (!provider || typeof provider.detect !== 'function') throw new Error('injected landmark provider required');
  let started = false;
  return {
    start({userInitiated = false, cameraConsent = false} = {}) { if (!userInitiated || !cameraConsent) throw new Error('explicit start and consent required'); started = true; },
    async detect(frame, metadata) { if (!started) throw new Error('session not started'); return provider.detect(frame, metadata); },
    stop() { started = false; }
  };
}
