// Fixation estimate for downstream scene analysis: the per-axis median of the recent gaze points. A single webcam gaze
// sample can be off by 10-30% of the screen; while the user looks at one place the samples cluster, and the median
// keeps that cluster without being dragged by single outliers or blinks.

const finite = Number.isFinite;

export const FIXATION_WINDOW_MS = 800;
export const FIXATION_MAX_SAMPLES = 64;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function createFixationBuffer({windowMs = FIXATION_WINDOW_MS, maxSamples = FIXATION_MAX_SAMPLES} = {}) {
  if (!finite(windowMs) || windowMs <= 0 || !Number.isInteger(maxSamples) || maxSamples < 1) throw new TypeError('invalid fixation buffer');
  const samples = [];
  return {
    // point: screen pixels; atMs: when the sample became available (same clock as `now` below).
    add(point, atMs) {
      if (!finite(point?.x) || !finite(point?.y) || !finite(atMs)) return;
      samples.push({x:point.x, y:point.y, atMs});
      while (samples.length > maxSamples) samples.shift();
    },
    clear() { samples.length = 0; },
    // Median of the samples from the last windowMs, with how many there were and how widely they spread (median
    // absolute distance from the median, in pixels). Null when fewer than minSamples are recent.
    estimate(now, {minSamples = 1} = {}) {
      const recent = samples.filter(sample => sample.atMs <= now && now - sample.atMs <= windowMs);
      if (recent.length < minSamples || !recent.length) return null;
      const x = median(recent.map(sample => sample.x)), y = median(recent.map(sample => sample.y));
      return {x, y, count:recent.length, spread:median(recent.map(sample => Math.hypot(sample.x - x, sample.y - y))), latestAtMs:Math.max(...recent.map(sample => sample.atMs))};
    }
  };
}
