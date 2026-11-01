import { rasterizeMask } from '../spatial/depth-artifact.js';

// G2-B depth accuracy metrics. Raw metric output is compared with GT as-is: no scale
// or shift is fitted on the evaluated GT. Pixels the model did not produce count
// against coverage; they are never silently dropped from the denominator.
export const DEPTH_METRICS_SCHEMA = 'prometheus_depth_metrics';
export const DEPTH_METRICS_VERSION = 1;

const MAX_PIXELS = 1_048_576;
const bad = message => { throw new TypeError(`depth metrics: ${message}`); };
const isArr = v => Array.isArray(v) || ArrayBuffer.isView(v);

function checkMap(name, map, n) {
  if (!map || !isArr(map.values) || !isArr(map.validMask) || map.values.length !== n || map.validMask.length !== n) bad(`${name} values/validMask must have width*height entries`);
  for (let i = 0; i < n; i++) if (map.validMask[i] !== 0 && map.validMask[i] !== 1) bad(`${name} validMask must be 0/1`);
}

function boundaryBand(masks, width, height, band) {
  const edge = new Uint8Array(width * height);
  for (const m of masks) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!m[i]) continue;
      if ((x > 0 && !m[i - 1]) || (x < width - 1 && !m[i + 1]) || (y > 0 && !m[i - width]) || (y < height - 1 && !m[i + width])) edge[i] = 1;
    }
  }
  // Chebyshev dilation of the mask-edge pixels by `band`: covers both sides of the contour.
  const horiz = new Uint8Array(width * height), out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = new Int32Array(width + 1);
    for (let x = 0; x < width; x++) row[x + 1] = row[x] + edge[y * width + x];
    for (let x = 0; x < width; x++) horiz[y * width + x] = row[Math.min(width, x + band + 1)] - row[Math.max(0, x - band)] > 0 ? 1 : 0;
  }
  for (let x = 0; x < width; x++) {
    const col = new Int32Array(height + 1);
    for (let y = 0; y < height; y++) col[y + 1] = col[y] + horiz[y * width + x];
    for (let y = 0; y < height; y++) out[y * width + x] = col[Math.min(height, y + band + 1)] - col[Math.max(0, y - band)] > 0 ? 1 : 0;
  }
  return out;
}

const emptyStats = gtValidCount => ({ gtValidCount, predValidCount: 0, missingCount: gtValidCount, coverage: gtValidCount ? 0 : null, evaluatedCount: 0, mae: null, rmse: null, absRel: null, delta125: null, delta125OverGtValid: gtValidCount ? 0 : null });

function statsFor(region, predOk, p, gtOk, g) {
  let gtValidCount = 0, evaluated = 0, abs = 0, sq = 0, rel = 0, pass = 0;
  for (let i = 0; i < region.length; i++) {
    if (!region[i] || !gtOk[i]) continue;
    gtValidCount++;
    if (!predOk[i]) continue;
    evaluated++;
    const d = Math.abs(p[i] - g[i]);
    abs += d; sq += d * d; rel += d / g[i];
    if (Math.max(p[i] / g[i], g[i] / p[i]) < 1.25) pass++;
  }
  if (!evaluated) return emptyStats(gtValidCount);
  return {
    gtValidCount, predValidCount: evaluated, missingCount: gtValidCount - evaluated, coverage: evaluated / gtValidCount, evaluatedCount: evaluated,
    mae: abs / evaluated, rmse: Math.sqrt(sq / evaluated), absRel: rel / evaluated,
    delta125: pass / evaluated,
    // Missing predictions count as failures here, so a model cannot raise it by abstaining.
    delta125OverGtValid: pass / gtValidCount,
  };
}

function fullMask(mask, width, height) {
  if (ArrayBuffer.isView(mask) && mask.length === width * height) return Uint8Array.from(mask, v => (v ? 1 : 0));
  return rasterizeMask(mask, width, height);
}

/**
 * @param width,height map size shared by prediction and GT
 * @param pred {values, validMask}  model map (invalid => missing)
 * @param gt   {values, validMask}  GT map; only valid, positive, <= maxDepthM pixels are scored
 * @param foregroundMasks [{objectId, mask}] SAM raster masks (or full-size 0/1 arrays)
 * @param gaze {pixel:[x,y], radiusPx} continuous pixel coordinates, optional
 * @param boundaryBandPx half-width of the band around each foreground mask contour
 * @param scaleCorrection optional frozen correction from fitScaleCorrection (calibration split only)
 * @param evaluationSampleId optional id; refused if it was used to fit the scaleCorrection
 */
export function computeDepthMetrics({ width, height, pred, gt, foregroundMasks = [], gaze = null, boundaryBandPx = 2, maxDepthM = 20, scaleCorrection = null, evaluationSampleId = null } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) bad('invalid dimensions');
  if (!Number.isFinite(maxDepthM) || maxDepthM <= 0) bad('invalid maxDepthM');
  if (!Number.isInteger(boundaryBandPx) || boundaryBandPx < 1 || boundaryBandPx > 64) bad('boundaryBandPx must be an integer in [1,64]');
  const n = width * height;
  checkMap('pred', pred, n); checkMap('gt', gt, n);
  if (!Array.isArray(foregroundMasks)) bad('foregroundMasks must be an array');
  if (gaze !== null && !(Array.isArray(gaze.pixel) && gaze.pixel.length === 2 && gaze.pixel.every(Number.isFinite) && Number.isFinite(gaze.radiusPx) && gaze.radiusPx > 0)) bad('gaze needs pixel [x,y] and radiusPx > 0');

  let scale = 1, experiment = 'raw_metric_no_fit';
  if (scaleCorrection !== null) {
    if (scaleCorrection.fitSplit !== 'calibration' || !Number.isFinite(scaleCorrection.scale) || scaleCorrection.scale <= 0 || !Array.isArray(scaleCorrection.sampleIds)) bad('scaleCorrection must come from a calibration split (fitScaleCorrection)');
    if (evaluationSampleId !== null && scaleCorrection.sampleIds.includes(evaluationSampleId)) bad('scaleCorrection was fitted on the evaluated sample');
    scale = scaleCorrection.scale; experiment = 'scale_corrected_calibration_split';
  }

  const gtOk = new Uint8Array(n), predOk = new Uint8Array(n), p = new Float64Array(n), g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    g[i] = gt.values[i];
    gtOk[i] = gt.validMask[i] === 1 && Number.isFinite(g[i]) && g[i] > 0 && g[i] <= maxDepthM ? 1 : 0;
    p[i] = pred.values[i] * scale;
    predOk[i] = pred.validMask[i] === 1 && Number.isFinite(p[i]) && p[i] > 0 ? 1 : 0;
  }

  const all = new Uint8Array(n).fill(1);
  const objects = foregroundMasks.map((item, k) => {
    const objectId = item?.objectId ?? item?.mask?.objectId ?? `mask-${k}`;
    return { objectId, raster: fullMask(item?.mask ?? item, width, height) };
  });
  if (new Set(objects.map(o => o.objectId)).size !== objects.length) bad('duplicate foreground objectId');
  const union = new Uint8Array(n);
  for (const o of objects) for (let i = 0; i < n; i++) if (o.raster[i]) union[i] = 1;

  const regions = { all_valid: statsFor(all, predOk, p, gtOk, g) };
  if (objects.length) {
    regions.foreground = statsFor(union, predOk, p, gtOk, g);
    regions.boundary_band = statsFor(boundaryBand(objects.map(o => o.raster), width, height, boundaryBandPx), predOk, p, gtOk, g);
  } else {
    regions.foreground = { status: 'not_configured' }; regions.boundary_band = { status: 'not_configured' };
  }
  if (gaze) {
    const roi = new Uint8Array(n), r2 = gaze.radiusPx * gaze.radiusPx;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - gaze.pixel[0], dy = y + 0.5 - gaze.pixel[1];
      if (dx * dx + dy * dy <= r2) roi[y * width + x] = 1;
    }
    regions.gaze_roi = statsFor(roi, predOk, p, gtOk, g);
  } else regions.gaze_roi = { status: 'not_configured' };

  return {
    schema: DEPTH_METRICS_SCHEMA, version: DEPTH_METRICS_VERSION, experiment,
    scaleCorrection: scaleCorrection === null ? null : { method: scaleCorrection.method, scale, fitSplit: 'calibration', fittedPixelCount: scaleCorrection.pixelCount },
    units: 'm', width, height, maxDepthM, boundaryBandPx,
    definitions: {
      gtValid: 'gt validMask=1, finite, 0 < z <= maxDepthM; the only scored pixels',
      coverage: 'model-valid / gt-valid pixels in the region; model-missing pixels are counted, not excluded',
      errors: 'mae/rmse/absRel/delta125 are over pixels where both model and GT are valid (see coverage)',
      delta125: 'fraction with max(pred/gt, gt/pred) < 1.25 among evaluated pixels',
      delta125OverGtValid: 'same threshold, but model-missing pixels count as failures',
      boundaryBand: 'pixels within boundaryBandPx (Chebyshev) of any foreground-mask contour pixel, both sides',
      gazeRoi: 'pixel centres within radiusPx of the gaze pixel',
    },
    regions,
    foregroundObjects: objects.map(o => ({ objectId: o.objectId, ...statsFor(o.raster, predOk, p, gtOk, g) })),
  };
}

/**
 * Fit a single multiplicative scale (median of gt/pred) from CALIBRATION-split pairs only.
 * pairs: [{sampleId, pred, gt}] with width*height maps. Result must be frozen and reported
 * as a separate experiment; computeDepthMetrics refuses it for the sample it was fitted on.
 */
export function fitScaleCorrection(pairs, { maxDepthM = 20, split = 'calibration' } = {}) {
  if (split !== 'calibration') bad('scale may only be fitted on the calibration split');
  if (!Array.isArray(pairs) || !pairs.length) bad('no calibration pairs');
  const ratios = [], ids = [];
  for (const { sampleId, pred, gt } of pairs) {
    if (typeof sampleId !== 'string' || !sampleId) bad('calibration pair needs sampleId');
    const n = gt?.values?.length;
    checkMap('pred', pred, n); checkMap('gt', gt, n);
    ids.push(sampleId);
    for (let i = 0; i < n; i++) {
      const gv = gt.values[i], pv = pred.values[i];
      if (gt.validMask[i] === 1 && pred.validMask[i] === 1 && Number.isFinite(gv) && gv > 0 && gv <= maxDepthM && Number.isFinite(pv) && pv > 0) ratios.push(gv / pv);
    }
  }
  if (!ratios.length) bad('no jointly valid calibration pixels');
  ratios.sort((a, b) => a - b);
  const mid = ratios.length >> 1;
  const scale = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  return { method: 'median_gt_over_pred_scale_only', scale, pixelCount: ratios.length, fitSplit: 'calibration', sampleIds: ids };
}
