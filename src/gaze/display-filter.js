const finite = Number.isFinite;

const alpha = (cutoffHz, dtSeconds) => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
};

const validPoint = point => finite(point?.x) && finite(point?.y) &&
  point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;

// Causal One-Euro filter for normalized screen coordinates. Invalid samples are
// withheld and reset so stale gaze is never presented as a current measurement.
export function createCausalDisplayFilter({minCutoff = 1.2, beta = 0.02, derivativeCutoff = 1, minDeltaMs = 1, maxDeltaMs = 250} = {}) {
  if (![minCutoff, beta, derivativeCutoff, minDeltaMs, maxDeltaMs].every(finite) || minCutoff <= 0 || beta < 0 || derivativeCutoff <= 0 || minDeltaMs <= 0 || maxDeltaMs < minDeltaMs) throw new Error('invalid One-Euro filter settings');

  let previousRaw = null, previousFiltered = null, previousDerivative = null, previousTimestampMs = null;

  function reset() {
    previousRaw = previousFiltered = previousDerivative = previousTimestampMs = null;
  }

  function update(point, timestampMs, {valid = true} = {}) {
    if (valid !== true || !validPoint(point)) {
      reset();
      return {status:'withheld',point:null,rawPoint:null,filtered:false,reason:valid !== true ? 'sample_invalid' : 'point_invalid'};
    }
    if (!finite(timestampMs) || timestampMs < 0) {
      reset();
      return {status:'withheld',point:null,rawPoint:{...point},filtered:false,reason:'timestamp_invalid'};
    }

    const rawPoint = {x:point.x,y:point.y};
    if (previousTimestampMs === null) {
      previousRaw = rawPoint;
      previousFiltered = rawPoint;
      previousDerivative = {x:0,y:0};
      previousTimestampMs = timestampMs;
      return {status:'ready',point:{...rawPoint},rawPoint,filtered:false,reset:false,reason:null};
    }

    const dtMs = timestampMs - previousTimestampMs;
    if (dtMs <= 0 || dtMs < minDeltaMs) {
      reset();
      return {status:'withheld',point:null,rawPoint,filtered:false,reason:dtMs <= 0 ? 'timestamp_not_increasing' : 'dt_too_small'};
    }
    if (dtMs > maxDeltaMs) {
      reset();
      previousRaw = rawPoint;
      previousFiltered = rawPoint;
      previousDerivative = {x:0,y:0};
      previousTimestampMs = timestampMs;
      return {status:'ready',point:{...rawPoint},rawPoint,filtered:false,reset:true,reason:'time_gap_reset'};
    }

    const dtSeconds = dtMs / 1000, derivativeAlpha = alpha(derivativeCutoff,dtSeconds);
    const filteredPoint = {};
    const filteredDerivative = {};
    for (const axis of ['x','y']) {
      const derivative = (rawPoint[axis] - previousRaw[axis]) / dtSeconds;
      filteredDerivative[axis] = derivativeAlpha * derivative + (1 - derivativeAlpha) * previousDerivative[axis];
      const cutoff = minCutoff + beta * Math.abs(filteredDerivative[axis]);
      const pointAlpha = alpha(cutoff,dtSeconds);
      filteredPoint[axis] = pointAlpha * rawPoint[axis] + (1 - pointAlpha) * previousFiltered[axis];
    }

    previousRaw = rawPoint;
    previousFiltered = filteredPoint;
    previousDerivative = filteredDerivative;
    previousTimestampMs = timestampMs;
    return {status:'ready',point:{...filteredPoint},rawPoint,filtered:true,reset:false,reason:null};
  }

  return {update,reset};
}
