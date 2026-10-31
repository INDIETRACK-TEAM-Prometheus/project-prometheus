import { munkres } from '../../node_modules/munkres/dist/munkres.mjs';

const MAX_MASKS = 100;
const MAX_SOURCE_SIDE = 4096;
const MAX_RASTER_PIXELS = 1_048_576;
const BUDGET_EXCEEDED = Symbol('mask association budget exceeded');

const noMatches = (previousTracks, detections, status, reason) => ({
  status,
  ...(reason ? { reason } : {}),
  matches: [],
  proposedMatches: [],
  ambiguous: [],
  candidates: detections.map((_, detectionIndex) => ({ detectionIndex, candidates: [] })),
  newDetectionIndices: detections.map((_, index) => index),
  unmatchedDetectionIndices: detections.map((_, index) => index),
  unmatchedObjectIds: previousTracks.map(track => track.objectId)
});

function validateMask(mask) {
  const b = mask?.bounds;
  return mask && Number.isInteger(mask.sourceWidth) && mask.sourceWidth > 0 && mask.sourceWidth <= MAX_SOURCE_SIDE &&
    Number.isInteger(mask.sourceHeight) && mask.sourceHeight > 0 && mask.sourceHeight <= MAX_SOURCE_SIDE &&
    Number.isInteger(mask.width) && mask.width > 0 && Number.isInteger(mask.height) && mask.height > 0 &&
    mask.width * mask.height <= MAX_RASTER_PIXELS && Array.isArray(mask.raster) && mask.raster.length === mask.width * mask.height &&
    mask.raster.every(value => value === 0 || value === 1) && b &&
    [b.left, b.top, b.right, b.bottom].every(Number.isInteger) && b.left >= 0 && b.top >= 0 &&
    b.right <= mask.sourceWidth && b.bottom <= mask.sourceHeight && b.right > b.left && b.bottom > b.top;
}

const maskOf = value => value?.mask ?? value;
const appearanceOf = value => value?.appearance;
const validAppearance = value => value === undefined || value === null ||
  (Array.isArray(value) && value.length === 3 && value.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 255));

// Pixel boundary for a mask-grid cell boundary, preserving source pixel-center sampling.
function sourceBoundary(start, span, cells, cellBoundary, end) {
  const numerator = 2 * cellBoundary * span - cells;
  const denominator = 2 * cells;
  return Math.max(start, Math.min(end, start - Math.floor(-numerator / denominator)));
}

function summarize(mask) {
  const b = mask.bounds, boxWidth = b.right - b.left, boxHeight = b.bottom - b.top;
  const rows = Array.from({ length: mask.height }, () => []);
  for (let y = 0; y < mask.height; y++) {
    let start = -1;
    for (let x = 0; x <= mask.width; x++) {
      const foreground = x < mask.width && mask.raster[y * mask.width + x] === 1;
      if (foreground && start < 0) start = x;
      if (!foreground && start >= 0) {
        const left = sourceBoundary(b.left, boxWidth, mask.width, start, b.right);
        const right = sourceBoundary(b.left, boxWidth, mask.width, x, b.right);
        if (left < right) rows[y].push([left, right]);
        start = -1;
      }
    }
  }
  let area = 0;
  for (let y = b.top; y < b.bottom; y++) {
    const row = Math.floor((y + 0.5 - b.top) * mask.height / boxHeight);
    for (const [left, right] of rows[row]) area += right - left;
  }
  return { mask, rows, area };
}

function maskIoU(a, b, consumeWork) {
  const ab = a.mask.bounds, bb = b.mask.bounds;
  const top = Math.max(ab.top, bb.top), bottom = Math.min(ab.bottom, bb.bottom);
  const left = Math.max(ab.left, bb.left), right = Math.min(ab.right, bb.right);
  if (top >= bottom || left >= right || !a.area || !b.area) return 0;

  let intersection = 0;
  for (let y = top; y < bottom; y++) {
    const ar = a.rows[Math.floor((y + 0.5 - ab.top) * a.mask.height / (ab.bottom - ab.top))];
    const br = b.rows[Math.floor((y + 0.5 - bb.top) * b.mask.height / (bb.bottom - bb.top))];
    let i = 0, j = 0;
    while (i < ar.length && j < br.length) {
      consumeWork();
      const lo = Math.max(ar[i][0], br[j][0]), hi = Math.min(ar[i][1], br[j][1]);
      if (hi > lo) intersection += hi - lo;
      if (ar[i][1] < br[j][1]) i++;
      else if (ar[i][1] > br[j][1]) j++;
      else { i++; j++; }
    }
  }
  const union = a.area + b.area - intersection;
  return union ? intersection / union : 0;
}

function byScore(items, key) {
  return items.sort((a, b) => b.iou - a.iou || String(a[key]).localeCompare(String(b[key])));
}

function isClear(candidate, row, column, minIoU, ambiguityMargin) {
  const rowCandidates = row.filter(item => item.iou >= minIoU).sort((a, b) => b.iou - a.iou || a.trackIndex - b.trackIndex);
  const columnCandidates = column.filter(item => item.iou >= minIoU).sort((a, b) => b.iou - a.iou || a.detectionIndex - b.detectionIndex);
  if (rowCandidates[0]?.trackIndex !== candidate.trackIndex || columnCandidates[0]?.detectionIndex !== candidate.detectionIndex) return false;
  if (rowCandidates[1] && rowCandidates[0].iou - rowCandidates[1].iou <= ambiguityMargin) return false;
  if (columnCandidates[1] && columnCandidates[0].iou - columnCandidates[1].iou <= ambiguityMargin) return false;
  return true;
}

/**
 * Associate observed SAM raster masks to recent local tracks by mask IoU.
 * The provider's per-image objectId is deliberately ignored; only objectId on
 * a caller-owned previous track can be carried forward.
 */
export function associateMasks(previousTracks, detections, {
  minIoU = 0.1,
  ambiguityMargin = 0.05,
  maxAppearanceDistance = 0.35,
  maxComparisons = 20_000_000,
  maxRasterPixels = 4_194_304
} = {}) {
  if (!Array.isArray(previousTracks) || !Array.isArray(detections) || previousTracks.length > MAX_MASKS || detections.length > MAX_MASKS ||
      !Number.isFinite(minIoU) || minIoU <= 0 || minIoU > 1 || !Number.isFinite(ambiguityMargin) || ambiguityMargin < 0 || ambiguityMargin > 1 ||
      !Number.isFinite(maxAppearanceDistance) || maxAppearanceDistance < 0 || maxAppearanceDistance > 1 ||
      !Number.isSafeInteger(maxComparisons) || maxComparisons < 1 || !Number.isSafeInteger(maxRasterPixels) || maxRasterPixels < 1) {
    throw new TypeError('invalid mask association input');
  }
  const normalizedTracks = previousTracks.map(track => ({objectId:track?.objectId,mask:maskOf(track),appearance:appearanceOf(track)}));
  const normalizedDetections = detections.map(detection => ({mask:maskOf(detection),appearance:appearanceOf(detection)}));
  if (normalizedTracks.some(track => typeof track.objectId !== 'string' || !track.objectId || !validateMask(track.mask) || !validAppearance(track.appearance)) ||
      new Set(normalizedTracks.map(track => track.objectId)).size !== normalizedTracks.length ||
      normalizedDetections.some(detection => !validateMask(detection.mask) || !validAppearance(detection.appearance))) {
    throw new TypeError('invalid mask association input');
  }

  const sourceMasks = [...normalizedTracks.map(track => track.mask), ...normalizedDetections.map(detection => detection.mask)];
  if (sourceMasks.some(mask => mask.sourceWidth !== sourceMasks[0]?.sourceWidth || mask.sourceHeight !== sourceMasks[0]?.sourceHeight)) {
    return noMatches(previousTracks, detections, 'reset', 'source_dimensions_changed');
  }
  const rasterPixels = sourceMasks.reduce((sum, mask) => sum + mask.width * mask.height, 0);
  if (rasterPixels > maxRasterPixels) return noMatches(previousTracks, detections, 'withheld', 'raster_budget_exceeded');
  if (!previousTracks.length || !detections.length) {
    return {
      status: 'ok', matches: [], proposedMatches: [], ambiguous: [],
      candidates: detections.map((_, detectionIndex) => ({ detectionIndex, candidates: [] })),
      newDetectionIndices: detections.map((_, index) => index),
      unmatchedDetectionIndices: detections.map((_, index) => index),
      unmatchedObjectIds: previousTracks.map(track => track.objectId)
    };
  }

  const tracks = normalizedTracks.map(track => ({ objectId: track.objectId, appearance:track.appearance ?? null, ...summarize(track.mask) }));
  const current = normalizedDetections.map(detection => ({ appearance:detection.appearance ?? null, ...summarize(detection.mask) }));
  let comparisons = 0;
  const consumeWork = () => { if (++comparisons > maxComparisons) throw BUDGET_EXCEEDED; };
  let ious;
  try { ious = current.map(detection => tracks.map(track => {
    if (detection.appearance && track.appearance) {
      const distance = Math.hypot(...detection.appearance.map((channel, index) => channel - track.appearance[index])) / 441.673;
      if (distance > maxAppearanceDistance) return 0;
    }
    return maskIoU(detection, track, consumeWork);
  })); }
  catch (error) {
    if (error !== BUDGET_EXCEEDED) throw error;
    return noMatches(previousTracks, detections, 'withheld', 'comparison_budget_exceeded');
  }

  const candidates = current.map((_, detectionIndex) => ({
    detectionIndex,
    candidates: byScore(ious[detectionIndex].flatMap((iou, trackIndex) => iou >= minIoU ? [{ objectId: tracks[trackIndex].objectId, iou, trackIndex }] : []), 'objectId')
      .map(({ objectId, iou }) => ({ objectId, iou }))
  }));
  const size = tracks.length + current.length;
  const costs = Array.from({ length: size }, () => Array(size).fill(0));
  for (let detectionIndex = 0; detectionIndex < current.length; detectionIndex++) {
    for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
      costs[trackIndex][detectionIndex] = ious[detectionIndex][trackIndex] >= minIoU ? -ious[detectionIndex][trackIndex] : Infinity;
    }
  }
  const assigned = munkres(costs).flatMap(([trackIndex, detectionIndex]) =>
    trackIndex < tracks.length && detectionIndex < current.length && Number.isFinite(costs[trackIndex][detectionIndex])
      ? [{ trackIndex, detectionIndex, iou: ious[detectionIndex][trackIndex] }]
      : []);
  const row = tracks.map((_, trackIndex) => current.map((__, detectionIndex) => ({ trackIndex, detectionIndex, iou: ious[detectionIndex][trackIndex] })));
  const column = current.map((_, detectionIndex) => tracks.map((__, trackIndex) => ({ trackIndex, detectionIndex, iou: ious[detectionIndex][trackIndex] })));
  const clear = assigned.filter(pair => isClear(pair, column[pair.detectionIndex], row[pair.trackIndex], minIoU, ambiguityMargin));
  const matches = clear.map(({ trackIndex, detectionIndex, iou }) => ({ objectId: tracks[trackIndex].objectId, detectionIndex, iou }));
  const proposedMatches = assigned.map(({ trackIndex, detectionIndex, iou }) => ({ objectId: tracks[trackIndex].objectId, detectionIndex, iou }));
  const matchedDetections = new Set(matches.map(match => match.detectionIndex));
  const matchedObjects = new Set(matches.map(match => match.objectId));
  const ambiguous = detections.flatMap((_, detectionIndex) => {
    const choices = candidates[detectionIndex].candidates;
    if (matchedDetections.has(detectionIndex) || !choices.length) return [];
    return [{ detectionIndex, candidateObjectIds: choices.map(choice => choice.objectId) }];
  });
  return {
    status: 'ok', matches, proposedMatches, ambiguous, candidates,
    newDetectionIndices: candidates.flatMap(({ detectionIndex, candidates: choices }) => choices.length ? [] : [detectionIndex]),
    unmatchedDetectionIndices: detections.flatMap((_, index) => matchedDetections.has(index) ? [] : [index]),
    unmatchedObjectIds: tracks.flatMap(track => matchedObjects.has(track.objectId) ? [] : [track.objectId])
  };
}
