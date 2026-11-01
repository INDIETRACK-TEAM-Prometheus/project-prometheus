import { sha256Hex } from './depth-artifact.js';

// Engine ground-truth depth for a retained frame. This is an ENGINE ORACLE: it is
// labelled `engine_oracle`/`engine_geometry` and is never Depth Anything output.
// Pixel (i,j) of the export samples the centre of its block at continuous
// coordinate ((i+0.5)*f, (j+0.5)*f) for downsample factor f (partial edge blocks use
// their own centre). Axial z = rayRangeM / |[(x-cx)/fx, (y-cy)/fy, 1]|.
export const ENGINE_DEPTH_SCHEMA = 'prometheus_engine_depth_gt';
export const DEPTH_MAP_SCHEMA = 'prometheus_depth_map';
export const DEPTH_MAP_VERSION = 1;
const MAX_PIXELS = 1_048_576;
const bad = (message, code) => { throw Object.assign(new TypeError(`world depth export: ${message}`), code ? { code } : {}); };

export function exportEngineDepth({ world, frame, downsample = 1, maxDepthM = 20, maxPixels = MAX_PIXELS } = {}) {
  if (typeof world?.raycastFrame !== 'function') bad('world.raycastFrame required');
  const vp = frame?.viewport, K = frame?.intrinsics;
  if (typeof frame?.frameId !== 'string' || !frame.frameId || !Number.isFinite(frame.renderTsMs) || !vp || !Number.isInteger(vp.width) || !Number.isInteger(vp.height) || vp.width < 1 || vp.height < 1) bad('invalid frame');
  if (![K?.fx, K?.fy, K?.cx, K?.cy].every(Number.isFinite) || K.fx <= 0 || K.fy <= 0) bad('frame intrinsics required');
  if (!Number.isInteger(downsample) || downsample < 1 || downsample > 64) bad('downsample must be an integer in [1,64]');
  if (!Number.isFinite(maxDepthM) || maxDepthM <= 0) bad('invalid maxDepthM');
  const width = Math.ceil(vp.width / downsample), height = Math.ceil(vp.height / downsample);
  if (width * height > maxPixels) bad('export exceeds pixel budget; raise downsample');
  const values = new Float32Array(width * height), validMask = new Uint8Array(width * height);
  let hitCount = 0, noHitCount = 0, outOfRangeCount = 0, maxAxialDiff = 0;
  for (let j = 0; j < height; j++) {
    const y = j * downsample + Math.min(downsample, vp.height - j * downsample) / 2;
    for (let i = 0; i < width; i++) {
      const x = i * downsample + Math.min(downsample, vp.width - i * downsample) / 2;
      const hit = world.raycastFrame(frame, x, y);
      if (hit?.status === 'unavailable') bad(`raycast unavailable (${hit.reason ?? 'unknown'})`, 'ENGINE_DEPTH_UNAVAILABLE');
      if (hit?.status === 'no_hit') { noHitCount++; continue; }
      if (hit?.status !== 'hit' || !Number.isFinite(hit.rayRangeM) || hit.rayRangeM <= 0) bad('unexpected raycast result');
      const a = (x - K.cx) / K.fx, b = (y - K.cy) / K.fy;
      const z = hit.rayRangeM / Math.sqrt(1 + a * a + b * b);
      if (Number.isFinite(hit.axialZM)) maxAxialDiff = Math.max(maxAxialDiff, Math.abs(hit.axialZM - z));
      if (!(z > 0 && z <= maxDepthM)) { outOfRangeCount++; continue; }
      values[j * width + i] = z; validMask[j * width + i] = 1; hitCount++;
    }
  }
  return {
    schema: ENGINE_DEPTH_SCHEMA, label: 'engine_oracle', oracle: true, synthetic: true,
    modelOutput: false, depthSource: 'engine_geometry', units: 'm', convention: 'axial_z',
    frame: { frameId: frame.frameId, renderTsMs: frame.renderTsMs, viewportWidth: vp.width, viewportHeight: vp.height },
    intrinsics: { fx: K.fx, fy: K.fy, cx: K.cx, cy: K.cy }, cameraToWorld: [...(frame.cameraToWorld ?? [])],
    downsample, width, height, maxDepthM, values, validMask,
    counts: { hit: hitCount, noHit: noHitCount, outOfRange: outOfRangeCount },
    // Informational: world.axialZM is point_z - translation_z (only axial for an unrotated camera).
    worldAxialZMaxAbsDiffM: maxAxialDiff,
  };
}

const b64 = typed => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64');

/** JSON-safe encoding (same base64 layout as the depth worker protocol). */
export function encodeDepthMap(map) {
  const { values, validMask, width, height } = map ?? {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || !values || !validMask || values.length !== width * height || validMask.length !== width * height) bad('invalid map');
  const v = Float32Array.from(values), m = Uint8Array.from(validMask);
  for (let i = 0; i < m.length; i++) if (m[i] !== 0 && m[i] !== 1) bad('validMask must be 0/1');
  const { values: _v, validMask: _m, ...meta } = map;
  return { ...meta, mapSchema: DEPTH_MAP_SCHEMA, mapVersion: DEPTH_MAP_VERSION, valuesF32LE: b64(v), validMaskU8: b64(m), valuesSha256: sha256Hex(Buffer.from(v.buffer)), validMaskSha256: sha256Hex(Buffer.from(m.buffer)) };
}

export function decodeDepthMap(json) {
  if (!json || json.mapSchema !== DEPTH_MAP_SCHEMA || json.mapVersion !== DEPTH_MAP_VERSION) bad('unsupported depth map JSON');
  const { width, height } = json;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) bad('invalid dimensions');
  const vb = Buffer.from(json.valuesF32LE ?? '', 'base64'), mb = Buffer.from(json.validMaskU8 ?? '', 'base64');
  if (vb.length !== width * height * 4 || mb.length !== width * height) bad('map payload size mismatch');
  if (sha256Hex(vb) !== json.valuesSha256 || sha256Hex(mb) !== json.validMaskSha256) bad('map payload hash mismatch');
  const values = new Float32Array(width * height);
  for (let i = 0; i < values.length; i++) values[i] = vb.readFloatLE(i * 4);
  const validMask = Uint8Array.from(mb);
  for (const m of validMask) if (m !== 0 && m !== 1) bad('validMask must be 0/1');
  const { valuesF32LE, validMaskU8, ...meta } = json;
  return { ...meta, values, validMask };
}
