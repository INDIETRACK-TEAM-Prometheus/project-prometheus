export const WEBEYETRACK_CALIBRATION_POINTS = 27;

export function createWebEyeTrackCalibrationAdapter(tracker, maxPoints = WEBEYETRACK_CALIBRATION_POINTS) {
  if (typeof tracker?.adapt !== 'function' || !Number.isInteger(maxPoints) || maxPoints < 1) throw new Error('valid WebEyeTrack adapter required');
  const samples = [];
  let completed = false;
  return async (result, target) => {
    if (completed || samples.length >= maxPoints) throw new Error('calibration sample limit reached');
    samples.push({
      eyePatch:result.eyePatch,
      headVector:result.headVector,
      faceOrigin3D:result.faceOrigin3D,
      target:[target.x,target.y]
    });
    const points = samples.length;
    if (points < maxPoints) return points;
    try {
      await tracker.adapt(
        samples.map(sample=>sample.eyePatch),
        samples.map(sample=>sample.headVector),
        samples.map(sample=>sample.faceOrigin3D),
        samples.map(sample=>sample.target)
      );
    } catch (error) {
      samples.length = 0;
      throw error;
    }
    samples.length = 0;
    completed = true;
    return points;
  };
}

export async function handleWebEyeTrackAdaptation(tracker, addCalibrationSample, target, requestId) {
  try {
    const result = tracker?.latestGazeResult;
    if (!result || result.gazeState !== 'open' || !result.eyePatch || !Array.isArray(result.headVector) || !Array.isArray(result.faceOrigin3D)) throw new Error('fresh open-eye WebEyeTrack result required');
    const points = await addCalibrationSample(result,target);
    return {type:'adapted',requestId,points};
  } catch {
    return {type:'adaptError',requestId,code:'worker_adaptation_failed',step:'worker_adaptation'};
  }
}
