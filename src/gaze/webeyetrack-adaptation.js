export const WEBEYETRACK_CALIBRATION_POINTS = 27;

export function createWebEyeTrackCalibrationAdapter(tracker, maxPoints = WEBEYETRACK_CALIBRATION_POINTS) {
  if (typeof tracker?.adapt !== 'function' || !Number.isInteger(maxPoints) || maxPoints < 1) throw new Error('valid WebEyeTrack adapter required');
  const samples = [];
  let completed = false;
  return (result, target) => {
    if (completed || samples.length >= maxPoints) throw new Error('calibration sample limit reached');
    samples.push({
      eyePatch:result.eyePatch,
      headVector:result.headVector,
      faceOrigin3D:result.faceOrigin3D,
      target:[target.x,target.y]
    });
    const points = samples.length;
    if (points < maxPoints) return points;
    tracker.adapt(
      samples.map(sample=>sample.eyePatch),
      samples.map(sample=>sample.headVector),
      samples.map(sample=>sample.faceOrigin3D),
      samples.map(sample=>sample.target)
    );
    samples.length = 0;
    completed = true;
    return points;
  };
}
