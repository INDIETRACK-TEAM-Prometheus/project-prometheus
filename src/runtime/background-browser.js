import {buildDepthArtifact} from '../spatial/depth-artifact.js';
import {maskDigest} from './live-tracking.js';

const text = value => typeof value === 'string' && value.trim().length > 0;
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function frameOf(value) { return value?.frame ?? value; }

function requireFrame(value, expected, now) {
  const frame = frameOf(value);
  if (!frame || frame.frameId !== expected.frameId || frame.observedAt !== expected.observedAt || !time(frame.processedAt) || frame.processedAt < frame.observedAt || frame.processedAt > now || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width * frame.height > 1048576 || typeof frame.imageData !== 'string' || frame.imageData.length > 6000000) throw new TypeError('captured frame mismatch');
  return frame;
}

function requireResponseFrame(value, frame) {
  const resultFrame = value?.frame;
  if (!resultFrame || resultFrame.frameId !== frame.frameId || resultFrame.observedAt !== frame.observedAt) throw new TypeError('provider frame mismatch');
}

function unwrap(value) {
  if (value?.status === 'ok' && value.result && typeof value.result === 'object') return value.result;
  if (value?.status && value.status !== 'ok') throw new Error('provider unavailable');
  return value;
}

function validBounds(bounds, frame) {
  return bounds && typeof bounds === 'object' && !Array.isArray(bounds) && Object.keys(bounds).sort().join(',') === 'bottom,left,right,top' && ['left','top','right','bottom'].every(key => Number.isInteger(bounds[key])) && bounds.left >= 0 && bounds.top >= 0 && bounds.right <= frame.width && bounds.bottom <= frame.height && bounds.right > bounds.left && bounds.bottom > bounds.top;
}

const DEFAULT_DEPTH_POLICY = Object.freeze({manifestId:'live-depth-v1', minValidFraction:0.5, maxDepthM:20, includeRelations:true});

// Compact, prompt-sized view of a depth artifact: per linked object foreground statistics only, never the map.
function depthEvidence(built) {
  const a = built.artifact;
  return {artifactSha256:built.sha256, modelId:a.model.id, modelSha256:a.model.sha256, observedAtMs:a.observedAtMs, availableAtMs:a.availableAtMs, units:'m', convention:'axial_z', depthSource:a.depthSource,
    objects:a.objects.map(o=>({objectId:o.objectId, status:o.status, validFraction:o.validFraction, medianDepthM:o.medianDepthM, q1M:o.q1M, q3M:o.q3M, ...(o.missingReason ? {missingReason:o.missingReason} : {})})),
    relations:a.relations.map(r=>({nearObjectId:r.nearObjectId, farObjectId:r.farObjectId})), gazeDepthM:a.gaze.depthM ?? null};
}

// capture must return an immutable copy of the requested rendered frame; no world pause is used.
// tracker (required, injected) must expose async ingest(); a per-camera-session LiveTracking supplies persistent local IDs from decoded SAM masks.
// depth (optional) runs in parallel with SAM on the same frame; its result is used only if it arrives within depthWaitMs after SAM.
export function createBackgroundBrowserWork({capture, sam, reason, tracker, depth = null, depthWaitMs = 1500, depthPolicy = DEFAULT_DEPTH_POLICY, now = () => performance.now()} = {}) {
  if (typeof capture !== 'function' || typeof sam !== 'function' || typeof reason !== 'function' || typeof now !== 'function' || typeof tracker?.ingest !== 'function') throw new TypeError('capture, sam, reason callbacks and tracker required');
  if ((depth !== null && typeof depth !== 'function') || !time(depthWaitMs)) throw new TypeError('invalid depth configuration');
  return async function work(snapshot, {signal, mark, invalidate} = {}) {
    if (!snapshot?.frame || !snapshot.dependencies || signal?.aborted) throw new TypeError('causal snapshot required');
    const captured = await capture(structuredClone(snapshot), {signal});
    if (signal?.aborted) throw new Error('background work cancelled');
    const at = now();
    if (!time(at)) throw new TypeError('invalid clock');
    const frame = requireFrame(captured, snapshot.frame, at);
    const gaze = snapshot.gaze == null ? null : structuredClone(snapshot.gaze);
    if (gaze && (!text(gaze.frameId) || gaze.frameId !== frame.frameId || !time(gaze.observedAt) || !time(gaze.processedAt) || gaze.observedAt > snapshot.observedUntil || gaze.processedAt < gaze.observedAt || gaze.processedAt > snapshot.processedAt)) throw new TypeError('frame and gaze do not match');

    // Availability time is taken when the depth result actually arrives, never backdated to the frame.
    const depthPending = depth ? Promise.resolve().then(() => depth(structuredClone(frame), {signal})).then(result => ({result, availableAtMs:now()}), error => ({error:typeof error?.code === 'string' ? error.code : 'depth_failed'})) : null;
    const rawMasks = await sam(structuredClone(frame), {signal, gaze:structuredClone(gaze), observedUntil:snapshot.observedUntil});
    if (signal?.aborted) throw new Error('background work cancelled');
    const masks = unwrap(rawMasks);
    requireResponseFrame(masks, frame);
    if (!Array.isArray(masks.masks)) throw new TypeError('SAM masks required');
    mark?.('samDone');
    const boxes = masks.masks.slice(0,10).map(mask=>mask?.bounds).filter(bounds=>validBounds(bounds,frame));

    // Decoded raster masks (not bounds) drive identity; masks without a valid raster are never tracked or offered as candidates.
    const tracked = await tracker.ingest({scope:{sessionId:snapshot.sessionId ?? null, mapId:snapshot.dependencies.mapId, mapVersion:snapshot.dependencies.mapVersion}, frameId:frame.frameId, observedAt:frame.observedAt, processedAt:frame.processedAt, width:frame.width, height:frame.height, masks:masks.masks, sam:{model:masks.model, provider:masks.provider, requestId:masks.requestId}});
    if (signal?.aborted) throw new Error('background work cancelled');
    // Reported immediately so cache dependencies are invalidated even if reasoning later fails or is cancelled.
    if (typeof invalidate === 'function') for (const change of tracked.changes) invalidate({type:change.type, objectId:change.objectId});
    const tracks = tracked.tracks.map(track=>({objectId:track.objectId, identityStatus:track.identityStatus, maskDigest:track.maskDigest, area:track.area, bounds:structuredClone(track.bounds), candidateObjectIds:[...track.candidateObjectIds], firstSeenFrameId:track.firstSeenFrameId, observations:track.observations}));
    const linked = tracks.filter(track=>track.identityStatus === 'linked').slice(0,10);
    const candidates = linked.map(track=>({objectId:track.objectId, bounds:structuredClone(track.bounds)}));
    const provenance = {frameId:frame.frameId, observedAt:frame.observedAt, samModel:tracked.provenance.samModel, samRequestId:tracked.provenance.samRequestId};

    let depthInput = null, depthStatus = {status:'not_requested', reason:null};
    if (depthPending) {
      let timer;
      const outcome = await Promise.race([depthPending, new Promise(resolve => { timer = setTimeout(() => resolve({late:true}), depthWaitMs); })]);
      clearTimeout(timer);
      if (signal?.aborted) throw new Error('background work cancelled');
      if (outcome.late) depthStatus = {status:'withheld', reason:'depth_late'};
      else if (outcome.error) depthStatus = {status:'withheld', reason:outcome.error};
      else {
        try {
          const d = outcome.result?.depth;
          if (outcome.result?.frame?.frameId !== frame.frameId || outcome.result?.frame?.observedAt !== frame.observedAt) throw new Error('depth frame mismatch');
          const byDigest = new Map();
          for (const mask of masks.masks) { try { byDigest.set(await maskDigest(mask), mask); } catch {} }
          const objectMasks = linked.filter(track => byDigest.has(track.maskDigest)).map(track => ({objectId:track.objectId, mask:byDigest.get(track.maskDigest)}));
          const built = buildDepthArtifact({frame:{frameId:frame.frameId, observedAtMs:frame.observedAt}, depth:{width:d.width, height:d.height, values:d.values, validMask:d.validMask, units:d.units, convention:d.convention, depthSource:d.depthSource, frameId:d.frameId, observedAt:d.observedAt}, model:outcome.result.model, availableAtMs:outcome.availableAtMs, masks:objectMasks, gazePixel:gaze ? [gaze.x * d.width, gaze.y * d.height] : null, manifest:depthPolicy});
          depthInput = depthEvidence(built);
          depthStatus = {status:'ok', reason:null, artifactSha256:built.sha256, availableAtMs:outcome.availableAtMs, objectCount:objectMasks.length};
        } catch {
          depthStatus = {status:'withheld', reason:'depth_artifact_invalid'};
        }
      }
      mark?.('depthDone');
    }

    const input = {frame:{frameId:frame.frameId, observedAt:frame.observedAt, processedAt:frame.processedAt, width:frame.width, height:frame.height, imageData:frame.imageData}, gaze, masks:boxes.map(bounds=>({bounds:structuredClone(bounds)})), observedUntil:snapshot.observedUntil, dependencies:structuredClone(snapshot.dependencies), candidates:structuredClone(candidates), tracks:structuredClone(tracks), provenance:structuredClone(provenance), events:structuredClone(snapshot.events ?? []), context:structuredClone(snapshot.context ?? {memory:[]}), depth:depthInput, depthStatus:structuredClone(depthStatus)};
    const rawHypotheses = await reason(input, {signal, firstByte:()=>mark?.('reasonFirstByte')});
    if (signal?.aborted) throw new Error('background work cancelled');
    const hypotheses = unwrap(rawHypotheses);
    requireResponseFrame(hypotheses, frame);
    if (!Array.isArray(hypotheses.scenarios)) throw new TypeError('hypotheses required');
    const candidateSpace = candidates.length ? {frameId:frame.frameId, observedAt:frame.observedAt, candidates:linked.map(track=>({objectId:track.objectId, bounds:structuredClone(track.bounds), maskDigest:track.maskDigest, identityStatus:'linked', area:track.area})), provenance:{...provenance, samModel:provenance.samModel ?? null, samRequestId:provenance.samRequestId ?? null}} : null;
    return {scenarios:structuredClone(hypotheses.scenarios), ...(Object.hasOwn(hypotheses, 'nextGaze') ? {nextGaze:structuredClone(hypotheses.nextGaze)} : {}), ...(candidateSpace ? {candidateSpace} : {}), ...(depthPending ? {depth:structuredClone(depthStatus)} : {}), objectDependencies:{objectIds:linked.map(track=>track.objectId), objectVersions:Object.fromEntries(linked.map(track=>[track.objectId, track.maskDigest]))}};
  };
}
