import { createHash } from 'node:crypto';
import { pixelRay } from './geometry.js';

// Deterministic, versioned per-object depth artifact for the LLM input path
// (docs/COMPARISON_PROTOCOL.md, "What the LLM receives"). Depth comes ONLY from a
// monocular metric estimate; engine ground truth is rejected. Pixel convention:
// map index (u,v) is sampled at continuous coordinate (u+0.5, v+0.5), the same
// convention used by world-depth-export.js.
export const DEPTH_ARTIFACT_SCHEMA = 'prometheus_depth_artifact';
export const DEPTH_ARTIFACT_VERSION = 1;
export const DEPTH_TRANSFORM_REVISION = 'depth-artifact-1';

const MAX_SIDE = 4096;
const MAX_PIXELS = 1_048_576;
const MAX_MASKS = 100;
const MAX_DEPTH_M = 20;
const bad = message => { throw new TypeError(`depth artifact: ${message}`); };
const r6 = v => Math.round(v * 1e6) / 1e6;
const isId = v => typeof v === 'string' && v.length > 0 && v.length <= 128;

export function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) bad('non-finite number cannot be serialized');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => { if (item === undefined) bad('undefined array item'); return canonicalize(item); }).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return bad('unsupported value type');
}

export const sha256Hex = data => createHash('sha256').update(data).digest('hex');

export function hashDepthArtifact(artifact) {
  const canonicalJson = canonicalize(artifact);
  return { canonicalJson, sha256: sha256Hex(canonicalJson) };
}

export function verifyDepthArtifact(artifact, sha256) {
  return hashDepthArtifact(artifact).sha256 === sha256;
}

function validateRasterMask(mask) {
  const b = mask?.bounds;
  return mask && Number.isInteger(mask.sourceWidth) && mask.sourceWidth > 0 && mask.sourceWidth <= MAX_SIDE &&
    Number.isInteger(mask.sourceHeight) && mask.sourceHeight > 0 && mask.sourceHeight <= MAX_SIDE &&
    Number.isInteger(mask.width) && mask.width > 0 && Number.isInteger(mask.height) && mask.height > 0 &&
    mask.width * mask.height <= MAX_PIXELS && (Array.isArray(mask.raster) || ArrayBuffer.isView(mask.raster)) &&
    mask.raster.length === mask.width * mask.height && Array.prototype.every.call(mask.raster, v => v === 0 || v === 1) && b &&
    [b.left, b.top, b.right, b.bottom].every(Number.isInteger) && b.left >= 0 && b.top >= 0 &&
    b.right <= mask.sourceWidth && b.bottom <= mask.sourceHeight && b.right > b.left && b.bottom > b.top;
}

/**
 * Expand a SAM raster mask (mask-association.js layout: raster over `bounds`,
 * source-pixel-centre sampling) to a full-frame 0/1 Uint8Array. Only raster
 * foreground pixels are set, never the whole bounding box.
 */
export function rasterizeMask(mask, width, height) {
  if (!validateRasterMask(mask)) bad('invalid raster mask');
  if (mask.sourceWidth !== width || mask.sourceHeight !== height) bad('mask source dimensions differ from depth map');
  const out = new Uint8Array(width * height), b = mask.bounds;
  const bw = b.right - b.left, bh = b.bottom - b.top;
  for (let y = b.top; y < b.bottom; y++) {
    const my = Math.floor((y + 0.5 - b.top) * mask.height / bh);
    for (let x = b.left; x < b.right; x++) {
      const mx = Math.floor((x + 0.5 - b.left) * mask.width / bw);
      if (mask.raster[my * mask.width + mx] === 1) out[y * width + x] = 1;
    }
  }
  return out;
}

function validateDepth(depth, maxDepthM) {
  if (!depth || typeof depth !== 'object') bad('depth map required');
  const { width, height, values, validMask } = depth;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) bad('invalid depth dimensions');
  const n = width * height;
  if (!(Array.isArray(values) || ArrayBuffer.isView(values)) || values.length !== n || !(Array.isArray(validMask) || ArrayBuffer.isView(validMask)) || validMask.length !== n) bad('depth values/mask length mismatch');
  if (depth.units !== 'm') bad('depth units must be m (never relative depth)');
  if (depth.convention !== 'axial_z') bad('depth convention must be axial_z');
  if (depth.depthSource !== 'monocular_estimated_depth') bad('depthSource must be monocular_estimated_depth (engine geometry is not model output)');
  for (let i = 0; i < n; i++) {
    const m = validMask[i];
    if (m !== 0 && m !== 1) bad('validMask must be 0/1');
    if (m === 1 && !(Number.isFinite(values[i]) && values[i] > 0 && values[i] <= maxDepthM)) bad('valid pixel outside (0, maxDepthM]');
  }
  return { width, height, values, validMask };
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const median = sorted => quantile(sorted, 0.5);

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') bad('manifest required');
  const { minValidFraction } = manifest;
  if (!Number.isFinite(minValidFraction) || minValidFraction <= 0 || minValidFraction > 1) bad('manifest.minValidFraction must be in (0,1]');
  const maxDepthM = manifest.maxDepthM ?? MAX_DEPTH_M;
  if (!Number.isFinite(maxDepthM) || maxDepthM <= 0 || maxDepthM > MAX_DEPTH_M) bad('manifest.maxDepthM must be in (0,20]');
  if (manifest.manifestId !== undefined && !isId(manifest.manifestId)) bad('manifest.manifestId invalid');
  return { minValidFraction, maxDepthM, manifestId: manifest.manifestId ?? null, includeRelations: manifest.includeRelations !== false };
}

function resolveTransform(transform, width, height) {
  const t = transform ?? { originalWidth: width, originalHeight: height, cropLeft: 0, cropTop: 0, cropWidth: width, cropHeight: height };
  const { originalWidth: ow, originalHeight: oh, cropLeft, cropTop, cropWidth, cropHeight } = t;
  if (![ow, oh, cropLeft, cropTop, cropWidth, cropHeight].every(Number.isInteger) || ow < 1 || oh < 1 || cropLeft < 0 || cropTop < 0 || cropWidth < 1 || cropHeight < 1 || cropLeft + cropWidth > ow || cropTop + cropHeight > oh) bad('invalid resize/crop transform');
  return { originalWidth: ow, originalHeight: oh, cropLeft, cropTop, cropWidth, cropHeight, depthWidth: width, depthHeight: height, mapping: 'original = crop + (index + 0.5) * crop/depth', identity: ow === width && oh === height && cropWidth === width && cropHeight === height };
}

function componentMedian(points) {
  return [0, 1, 2].map(axis => r6(median(Float64Array.from(points, p => p[axis]).sort())));
}

/**
 * Build the artifact. Inputs (all same frame):
 *  frame {frameId, observedAtMs}; depth {width,height,values,validMask,units,convention,depthSource};
 *  model {id, sha256}; availableAtMs (when the depth actually became available);
 *  masks [{objectId, mask}] or flat SAM masks with objectId; gazePixel [x,y]|null (continuous coords);
 *  manifest {minValidFraction, maxDepthM?, manifestId?, includeRelations?} frozen before scoring;
 *  intrinsics {fx,fy,cx,cy} + cameraToWorld (16, row-major) + imageTransform => XYZ, otherwise withheld.
 * Returns {artifact, canonicalJson, sha256}.
 */
export function buildDepthArtifact({ frame, depth, model, availableAtMs, masks = [], gazePixel = null, manifest, intrinsics, cameraToWorld, imageTransform } = {}) {
  const policy = validateManifest(manifest);
  const { width, height, values, validMask } = validateDepth(depth, policy.maxDepthM);
  if (!frame || !isId(frame.frameId) || !Number.isFinite(frame.observedAtMs) || frame.observedAtMs < 0) bad('invalid frame');
  if (depth.frameId !== undefined && depth.frameId !== frame.frameId) bad('depth frame ID differs from frame');
  if (depth.observedAt !== undefined && depth.observedAt !== frame.observedAtMs) bad('depth observation time differs from frame');
  if (!Number.isFinite(availableAtMs) || availableAtMs < frame.observedAtMs) bad('availableAtMs must be finite and not earlier than observation (never backdated)');
  if (!model || !isId(model.id) || !/^[0-9a-f]{64}$/.test(model.sha256 ?? '')) bad('model id and sha256 required');
  if (!Array.isArray(masks) || masks.length > MAX_MASKS) bad('invalid masks');
  if (gazePixel !== null && !(Array.isArray(gazePixel) && gazePixel.length === 2 && gazePixel.every(Number.isFinite))) bad('invalid gazePixel');

  const calibrated = intrinsics !== undefined && cameraToWorld !== undefined;
  let transform = null;
  if (calibrated) {
    if (pixelRay([0, 0], intrinsics, cameraToWorld).status !== 'ok') bad('invalid intrinsics or camera-to-world pose');
    transform = resolveTransform(imageTransform, width, height);
  }
  const worldPoint = (u, v, z) => {
    const ou = transform.cropLeft + (u + 0.5) * transform.cropWidth / width;
    const ov = transform.cropTop + (v + 0.5) * transform.cropHeight / height;
    const c = [(ou - intrinsics.cx) / intrinsics.fx * z, (ov - intrinsics.cy) / intrinsics.fy * z, z];
    const m = cameraToWorld;
    return { camera: c, world: [0, 1, 2].map(i => m[i * 4] * c[0] + m[i * 4 + 1] * c[1] + m[i * 4 + 2] * c[2] + m[i * 4 + 3]) };
  };

  const seen = new Set();
  const objects = [], objectPoints = new Map();
  for (const item of masks) {
    const mask = item?.mask ?? item, objectId = item?.objectId ?? mask?.objectId;
    if (!isId(objectId) || seen.has(objectId)) bad('mask objectId missing or duplicated');
    seen.add(objectId);
    const fg = rasterizeMask(mask, width, height);
    let foregroundPixelCount = 0;
    const valid = [], coords = [];
    for (let i = 0; i < fg.length; i++) {
      if (!fg[i]) continue;
      foregroundPixelCount++;
      if (validMask[i] === 1) { valid.push(values[i]); if (calibrated) coords.push(i); }
    }
    const validFraction = foregroundPixelCount ? valid.length / foregroundPixelCount : 0;
    const entry = { objectId, foregroundPixelCount, validPixelCount: valid.length, validFraction: r6(validFraction) };
    if (!foregroundPixelCount || validFraction < policy.minValidFraction) {
      Object.assign(entry, { status: 'missing', missingReason: foregroundPixelCount ? 'valid_fraction_below_minimum' : 'empty_foreground', medianDepthM: null, q1M: null, q3M: null, iqrM: null });
    } else {
      const sorted = Float64Array.from(valid).sort();
      const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75);
      Object.assign(entry, { status: 'ok', medianDepthM: r6(median(sorted)), q1M: r6(q1), q3M: r6(q3), iqrM: r6(q3 - q1) });
      if (calibrated) objectPoints.set(objectId, coords.map(i => worldPoint(i % width, Math.floor(i / width), values[i])));
    }
    objects.push(entry);
  }
  objects.sort((a, b) => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0));

  // Near/far only when the interquartile intervals are disjoint (map spread, not confidence).
  const relations = [];
  if (policy.includeRelations) {
    const ok = objects.filter(o => o.status === 'ok');
    for (const a of ok) for (const b of ok) {
      if (a !== b && a.q3M < b.q1M) relations.push({ nearObjectId: a.objectId, farObjectId: b.objectId, basis: 'iqr_intervals_disjoint' });
    }
  }

  let gaze = { pixel: null, depthM: null, reason: 'no_gaze' };
  let gazeXyz = null;
  if (gazePixel !== null) {
    const u = Math.floor(gazePixel[0]), v = Math.floor(gazePixel[1]);
    gaze = { pixel: [r6(gazePixel[0]), r6(gazePixel[1])], depthM: null, reason: 'gaze_outside_frame' };
    if (u >= 0 && v >= 0 && u < width && v < height) {
      const i = v * width + u;
      if (validMask[i] === 1) {
        gaze = { pixel: gaze.pixel, depthM: r6(values[i]), source: 'single_pixel_monocular_estimate', note: 'scene surface depth, not binocular fixation depth' };
        if (calibrated) { const p = worldPoint(u, v, values[i]); gazeXyz = { pointCameraM: p.camera.map(r6), pointWorldM: p.world.map(r6) }; }
      } else gaze.reason = 'gaze_pixel_invalid_depth';
    }
  }

  let xyz = { status: 'withheld', reason: 'intrinsics_and_camera_pose_required' };
  if (calibrated) {
    xyz = {
      status: 'ok', formula: 'X_cam = z * inverse(K) * [u,v,1]; X_world = cameraToWorld * X_cam', depthConvention: 'axial_z',
      pointStatistic: 'componentwise_median_of_valid_foreground_pixels',
      intrinsics: { fx: intrinsics.fx, fy: intrinsics.fy, cx: intrinsics.cx, cy: intrinsics.cy }, cameraToWorld: [...cameraToWorld], transform,
      objects: objects.filter(o => o.status === 'ok').map(o => { const pts = objectPoints.get(o.objectId); return { objectId: o.objectId, pointCameraM: componentMedian(pts.map(p => p.camera)), pointWorldM: componentMedian(pts.map(p => p.world)) }; }),
      gaze: gazeXyz,
    };
  }

  const artifact = {
    schema: DEPTH_ARTIFACT_SCHEMA, version: DEPTH_ARTIFACT_VERSION, transformRevision: DEPTH_TRANSFORM_REVISION,
    units: 'm', convention: 'axial_z', depthSource: 'monocular_estimated_depth',
    model: { id: model.id, sha256: model.sha256 },
    frame: { frameId: frame.frameId, width, height },
    observedAtMs: frame.observedAtMs, availableAtMs,
    policy: { manifestId: policy.manifestId, minValidFraction: policy.minValidFraction, maxDepthM: policy.maxDepthM, sampling: 'foreground_mask_pixels', statistic: 'median_and_iqr_type7', relations: policy.includeRelations ? 'iqr_intervals_disjoint' : 'none' },
    objects, relations, gaze, xyz,
  };
  return { artifact, ...hashDepthArtifact(artifact) };
}

/** Causal gate: depth that became available after the decision cutoff must not be shown. */
export function depthForDecision(artifact, decisionCutoffMs) {
  if (!artifact || artifact.schema !== DEPTH_ARTIFACT_SCHEMA || !Number.isFinite(decisionCutoffMs)) bad('invalid artifact or cutoff');
  return artifact.availableAtMs <= decisionCutoffMs
    ? { status: 'ok', artifact }
    : { status: 'withheld', reason: 'depth_available_after_cutoff', availableAtMs: artifact.availableAtMs, decisionCutoffMs };
}
