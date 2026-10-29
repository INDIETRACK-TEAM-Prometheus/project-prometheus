const finite = value => Number.isFinite(value);
const clamp = value => Math.max(0, Math.min(1 - Number.EPSILON, value));

function irisOffset(eye) {
  const [a, b] = eye?.corners ?? [];
  const iris = eye?.iris;
  if (eye?.valid !== true || eye.corners?.length !== 2 || !a || !b || !iris || ![a.x, a.y, b.x, b.y, iris.x, iris.y].every(finite)) return null;
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  if (span < 1) return null;
  return {x:(iris.x - (a.x + b.x) / 2) / span, y:(iris.y - (a.y + b.y) / 2) / span};
}

// A demo-only heuristic: it uses iris position relative to the eye corners,
// with arbitrary gains; it is not a calibrated or accuracy-validated gaze model.
export function estimateUncalibratedGaze({leftEye, rightEye} = {}) {
  const left = irisOffset(leftEye), right = irisOffset(rightEye);
  if (!left || !right) return {status:'unavailable', calibrationStatus:'uncalibrated', reason:'both_eye_iris_landmarks_required', point:null};
  const feature = {x:(left.x + right.x) / 2, y:(left.y + right.y) / 2};
  return {
    status:'uncalibrated_estimate',
    calibrationStatus:'uncalibrated',
    method:'iris_relative_to_eye_corners',
    feature,
    point:{x:clamp(.5 + 2 * feature.x), y:clamp(.5 + 4 * feature.y)}
  };
}
