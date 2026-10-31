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

// capture must return an immutable copy of the requested rendered frame; no world pause is used.
export function createBackgroundBrowserWork({capture, sam, reason, now = () => performance.now()} = {}) {
  if (typeof capture !== 'function' || typeof sam !== 'function' || typeof reason !== 'function' || typeof now !== 'function') throw new TypeError('capture, sam, and reason callbacks required');
  return async function work(snapshot, {signal} = {}) {
    if (!snapshot?.frame || !snapshot.dependencies || signal?.aborted) throw new TypeError('causal snapshot required');
    const captured = await capture(structuredClone(snapshot), {signal});
    if (signal?.aborted) throw new Error('background work cancelled');
    const at = now();
    if (!time(at)) throw new TypeError('invalid clock');
    const frame = requireFrame(captured, snapshot.frame, at);
    const gaze = snapshot.gaze == null ? null : structuredClone(snapshot.gaze);
    if (gaze && (!text(gaze.frameId) || gaze.frameId !== frame.frameId || !time(gaze.observedAt) || !time(gaze.processedAt) || gaze.observedAt > snapshot.observedUntil || gaze.processedAt < gaze.observedAt || gaze.processedAt > snapshot.processedAt)) throw new TypeError('frame and gaze do not match');

    const rawMasks = await sam(structuredClone(frame), {signal, gaze:structuredClone(gaze), observedUntil:snapshot.observedUntil});
    if (signal?.aborted) throw new Error('background work cancelled');
    const masks = unwrap(rawMasks);
    requireResponseFrame(masks, frame);
    if (!Array.isArray(masks.masks)) throw new TypeError('SAM masks required');

    const input = {frame:{frameId:frame.frameId, observedAt:frame.observedAt, processedAt:frame.processedAt, width:frame.width, height:frame.height, imageData:frame.imageData}, gaze, masks:structuredClone(masks.masks), observedUntil:snapshot.observedUntil, dependencies:structuredClone(snapshot.dependencies), candidates:structuredClone(snapshot.candidates ?? snapshot.scene?.candidates ?? []), events:structuredClone(snapshot.events ?? []), context:structuredClone(snapshot.context ?? {memory:[]})};
    const rawHypotheses = await reason(input, {signal});
    if (signal?.aborted) throw new Error('background work cancelled');
    const hypotheses = unwrap(rawHypotheses);
    requireResponseFrame(hypotheses, frame);
    if (!Array.isArray(hypotheses.scenarios)) throw new TypeError('hypotheses required');
    return {scenarios:structuredClone(hypotheses.scenarios), ...(Object.hasOwn(hypotheses, 'nextGaze') ? {nextGaze:structuredClone(hypotheses.nextGaze)} : {})};
  };
}
