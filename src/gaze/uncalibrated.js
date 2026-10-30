const finite = value => Number.isFinite(value);
const clamp = value => Math.max(0, Math.min(1 - Number.EPSILON, value));

function irisOffset(eye) {
  const [a, b] = eye?.corners ?? [];
  const iris = eye?.iris;
  if (eye?.valid !== true || eye.corners?.length !== 2 || !a || !b || !iris || ![a.x, a.y, b.x, b.y, iris.x, iris.y].every(finite)) return null;
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  if (span < 1) return null;
  return {x:(iris.x - (a.x + b.x) / 2) / span, y:(iris.y - (a.y + b.y) / 2) / span, upperLidDeltaY:finite(eye.upperLidDeltaY)?eye.upperLidDeltaY:null};
}

// The session-relative upper-lid cue and screen gains are fixed assumptions,
// not a calibrated or accuracy-validated gaze model.
export function estimateUncalibratedGaze({leftEye, rightEye} = {}) {
  const observations=[['left',irisOffset(leftEye)],['right',irisOffset(rightEye)]].filter(([,offset])=>offset);
  if (!observations.length) return {status:'unavailable', calibrationStatus:'uncalibrated', reason:'visible_eye_iris_landmarks_required', point:null};
  const irisY=observations.reduce((sum,[,offset])=>sum+offset.y,0)/observations.length;
  const upperLidObservations=observations.filter(([,offset])=>finite(offset.upperLidDeltaY));
  const upperLidDeltaY=upperLidObservations.length?upperLidObservations.reduce((sum,[,offset])=>sum+offset.upperLidDeltaY,0)/upperLidObservations.length:null;
  const verticalY=observations.reduce((sum,[,offset])=>sum+offset.y+(finite(offset.upperLidDeltaY)?offset.upperLidDeltaY:0),0)/observations.length;
  const feature = {x:observations.reduce((sum,[,offset])=>sum+offset.x,0)/observations.length, y:verticalY};
  const usesUpperLid=upperLidObservations.length>0;
  return {
    status:'uncalibrated_estimate',
    calibrationStatus:'uncalibrated',
    method:usesUpperLid?(observations.length===1?'single_eye_iris_plus_upper_lid_session_delta':'iris_plus_upper_lid_session_delta'):(observations.length===1?'single_eye_iris_relative_to_eye_corners':'iris_relative_to_eye_corners'),
    eyesUsed:observations.map(([side])=>side),
    feature,
    verticalCue:{irisY,upperLidDeltaY,upperLidEyes:upperLidObservations.map(([side])=>side),combination:usesUpperLid?'iris_plus_session_delta':'iris_only'},
    // Raw front-camera x runs opposite to viewer screen x; fitted calibration learns its own direction.
    point:{x:clamp(.5 - 2 * feature.x), y:clamp(.5 + 4 * feature.y)}
  };
}

// Freshness and canvas checks are demo-only. Callback timestamps stay explicitly
// distinct from browser capture estimates and neither kind passes a timing gate.
export function selectProvisionalIrisGaze({estimate, sample, frame, canvasRect, viewport, stableAfterMs, nowMs, maxSampleProcessingLagMs=250, maxProcessingAgeMs=100} = {}) {
  if (sample?.faceDetected !== true) return {status:'withheld',reason:'face_not_detected'};
  if (estimate?.status !== 'uncalibrated_estimate' || !finite(estimate.point?.x) || !finite(estimate.point?.y) || estimate.point.x < 0 || estimate.point.x >= 1 || estimate.point.y < 0 || estimate.point.y >= 1) return {status:'withheld',reason:'uncalibrated_iris_estimate_required'};
  if (!['browser_capture_estimate','callback_time_not_capture'].includes(sample.timestampKind) || !finite(sample.timestampMs) || !finite(sample.processedMs) || sample.timestampMs < 0 || sample.processedMs < sample.timestampMs) return {status:'withheld',reason:'sample_time_unavailable'};
  if (!frame?.frameId || !Number.isInteger(frame.width) || frame.width < 1 || !Number.isInteger(frame.height) || frame.height < 1) return {status:'withheld',reason:'frozen_frame_unavailable'};
  if (![canvasRect?.left,canvasRect?.top,canvasRect?.width,canvasRect?.height,viewport?.width,viewport?.height,stableAfterMs,nowMs,maxSampleProcessingLagMs,maxProcessingAgeMs].every(finite) || canvasRect.width <= 0 || canvasRect.height <= 0 || viewport.width <= 0 || viewport.height <= 0 || maxSampleProcessingLagMs < 0 || maxProcessingAgeMs < 0) return {status:'withheld',reason:'invalid_provisional_window'};
  const sampleProcessingLagMs=sample.processedMs-sample.timestampMs, processingAgeMs=nowMs-sample.processedMs;
  if (sample.timestampMs < stableAfterMs || sample.processedMs < stableAfterMs) return {status:'withheld',reason:'sample_before_stable_window'};
  if (sampleProcessingLagMs < 0 || sampleProcessingLagMs > maxSampleProcessingLagMs || processingAgeMs < 0 || processingAgeMs > maxProcessingAgeMs) return {status:'withheld',reason:'sample_stale_or_lagged'};
  const screenPoint={x:estimate.point.x*viewport.width,y:estimate.point.y*viewport.height};
  if (screenPoint.x < canvasRect.left || screenPoint.x >= canvasRect.left+canvasRect.width || screenPoint.y < canvasRect.top || screenPoint.y >= canvasRect.top+canvasRect.height) return {status:'withheld',reason:'gaze_outside_frozen_scene'};
  return {
    status:'ready',
    calibrationStatus:'uncalibrated',
    method:estimate.method,
    eyesUsed:estimate.eyesUsed,
    frameId:frame.frameId,
    point:{x:(screenPoint.x-canvasRect.left)/canvasRect.width,y:(screenPoint.y-canvasRect.top)/canvasRect.height},
    sampleAtMs:sample.timestampMs,
    processedAtMs:sample.processedMs,
    sampleProcessingLagMs,
    maxSampleProcessingLagMs,
    processingAgeMs,
    maxAcceptedProcessingAgeMs:maxProcessingAgeMs,
    timestampKind:sample.timestampKind,
    timingStatus:sample.timestampKind==='browser_capture_estimate'?'provisional_browser_capture_estimate':'provisional_callback_time_not_capture'
  };
}
