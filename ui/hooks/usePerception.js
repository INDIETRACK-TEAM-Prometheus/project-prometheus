import {useEffect, useRef} from 'react';
import {detect, segment, samPointPrompt, estimateDepth, reason} from '../lib/api.js';
import {captureVideo, boxIou, scaleBounds} from '../lib/frames.js';
import {gazeAt, poseAt, rayAt, anchorsAt} from '../../src/gaze/gaze-replay.js';
import {worldPoint, maskCentroid, maskDepthMedian, boxDepthMedian, relativeTo, depthScale} from '../../src/spatial/object-memory.js';

// Three loops over the playing glasses video, each as fast as its model allows and none waiting for another:
//   YOLO (local CPU, ~0.15 s)      class names and boxes for the whole frame
//   SAM 3.1 + depth (~1 s)         the object at the gaze point, its depth, and its place in the 3D memory
//   Muse Spark (~5-8 s)            next-action predictions from the latest gaze result and the memory
// Results live in a ref (read every animation frame by the overlay), not in React state.

const sleep = (ms, signal) => new Promise(resolve => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, {once:true}); });
const LABEL_IOU = .25;

export function emptyLive() {
  return {detections:null, segment:null, depth:null, spark:null, timings:{}, errors:{}, busy:{}};
}

// The YOLO detection naming a SAM mask: best box overlap, else the smallest box around the gaze point.
function nameMask(maskBounds, gaze, detections, frame) {
  if (!detections?.list?.length) return null;
  const sx = frame.width / detections.frame.width, sy = frame.height / detections.frame.height;
  const boxes = detections.list.map(item => ({...item, bounds:scaleBounds(item.bounds, sx, sy)}));
  let best = null, bestIou = LABEL_IOU;
  if (maskBounds) for (const box of boxes) { const iou = boxIou(box.bounds, maskBounds); if (iou > bestIou) { best = box; bestIou = iou; } }
  if (best) return best;
  const x = gaze.x * frame.width, y = gaze.y * frame.height;
  const around = boxes.filter(b => x >= b.bounds.left && x <= b.bounds.right && y >= b.bounds.top && y <= b.bounds.bottom);
  return around.sort((a, b) => (a.bounds.right - a.bounds.left) * (a.bounds.bottom - a.bounds.top) - (b.bounds.right - b.bounds.left) * (b.bounds.bottom - b.bounds.top))[0] ?? null;
}

export function usePerception({videoRef, track, running, memory, onMemory}) {
  const live = useRef(emptyLive());

  useEffect(() => {
    live.current = emptyLive();
    if (!running || !track) return;
    const controller = new AbortController(), {signal} = controller, state = live.current;
    // Depth Anything's metric scale is off on the fisheye; MPS SLAM points visible in the frame fix it (smoothed).
    let scale = null;
    const metric = (map, videoTime) => {
      const measured = depthScale(anchorsAt(track, videoTime), map);
      if (measured) scale = scale ? scale * .7 + measured * .3 : measured;
      if (!scale) return map;
      state.depthScale = scale;
      return {...map, values:map.values.map(value => value * scale)};
    };
    const video = () => videoRef.current;
    const playing = () => video() && !video().paused && !video().ended && video().readyState >= 2;

    async function yoloLoop() {
      while (!signal.aborted) {
        if (!playing()) { await sleep(150, signal); continue; }
        const frame = captureVideo(video(), 640);
        if (!frame) { await sleep(150, signal); continue; }
        const started = performance.now();
        state.busy.yolo = true;
        try {
          const result = await detect(frame, signal);
          // distances come from the latest depth map (about a second old at most)
          const depth = state.depth?.map;
          state.detections = {frame, list:result.detections.map(item => ({...item, depthM:depth ? boxDepthMedian(item.bounds, frame, depth) : null})), at:performance.now()};
          state.timings.yolo = performance.now() - started; delete state.errors.yolo;
        } catch (error) { if (signal.aborted) return; state.errors.yolo = error.message; await sleep(800, signal); }
        finally { state.busy.yolo = false; }
      }
    }

    async function gazeLoop() {
      while (!signal.aborted) {
        if (!playing()) { await sleep(150, signal); continue; }
        const frame = captureVideo(video(), 640), small = captureVideo(video(), 320);
        const gaze = frame && gazeAt(track, frame.videoTime);
        if (!frame || !small || !gaze || gaze.x >= 1 || gaze.y >= 1) { await sleep(150, signal); continue; }
        const pose = poseAt(track, frame.videoTime), started = performance.now();
        state.busy.sam = state.busy.depth = true;
        const depthJob = estimateDepth({...small, frameId:`${frame.frameId}d`}, signal).then(map => { state.timings.depth = performance.now() - started; delete state.errors.depth; return metric(map, small.videoTime); },
          error => { state.errors.depth = error.message; return null; }).finally(() => { state.busy.depth = false; });
        let masks = [];
        try { masks = (await segment(frame, samPointPrompt(frame, gaze), signal)).masks ?? []; state.timings.sam = performance.now() - started; delete state.errors.sam; }
        catch (error) { if (signal.aborted) return; state.errors.sam = error.message; }
        finally { state.busy.sam = false; }
        const depth = await depthJob;
        if (signal.aborted) return;
        if (depth) state.depth = {map:depth, frame:small, at:performance.now()};
        const mask = masks[0] ?? null;
        const named = nameMask(mask?.bounds ?? null, gaze, state.detections, frame);
        const depthM = mask && depth ? maskDepthMedian(mask, frame, depth) : named && depth ? boxDepthMedian(named.bounds, frame, depth) : null;
        const centroid = mask ? maskCentroid(mask, frame) : null;
        const point = centroid && pose && depthM ? worldPoint(pose, rayAt(track, centroid.x, centroid.y), depthM) : null;
        const remembered = point ? memory.observe({label:named?.label ?? null, point, t:frame.videoTime, depthM}) : null;
        if (remembered) onMemory();
        state.segment = {frame, gaze, pose, mask, label:named?.label ?? null, score:named?.score ?? null, depthM, memoryId:remembered?.id ?? null, at:performance.now()};
        if (!mask) await sleep(300, signal);
      }
    }

    async function sparkLoop() {
      let lastFrameId = null;
      while (!signal.aborted) {
        const seg = state.segment;
        if (!seg || seg.frame.frameId === lastFrameId || !playing()) { await sleep(250, signal); continue; }
        lastFrameId = seg.frame.frameId;
        const {frame} = seg, depth = state.depth?.map ?? null, sx = state.depth ? state.depth.frame.width : 0;
        const detections = state.detections;
        const objects = (detections?.list ?? []).slice(0, 8).map(item => {
          const bounds = scaleBounds(item.bounds, frame.width / detections.frame.width, frame.height / detections.frame.height);
          const d = depth && sx ? boxDepthMedian(bounds, frame, depth) : null;
          return {label:item.label.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 40) || 'object', score:item.score, depthM:d ? Math.round(d * 100) / 100 : null, bounds};
        }).filter(o => o.bounds.right > o.bounds.left && o.bounds.bottom > o.bounds.top);
        const memoryNow = seg.pose ? memory.list().filter(o => o.label && o.id !== seg.memoryId).sort((a, b) => b.lastT - a.lastT).slice(0, 8)
          .map(o => ({label:o.label, ...relativeTo(seg.pose, o.position), secondsAgo:Math.max(0, Math.round((frame.videoTime - o.lastT) * 10) / 10)}))
          .filter(o => Number.isFinite(o.distanceM)) : [];
        const body = {consentScope:'provisional_spark', timingStatus:'provisional', frame:{frameId:frame.frameId, observedAt:frame.observedAt, width:frame.width, height:frame.height}, imageDataUrl:frame.dataUrl,
          gazePoint:{x:seg.gaze.x, y:seg.gaze.y, sampleAtMs:frame.observedAt, processedAtMs:frame.observedAt, timestampKind:'browser_capture_estimate', estimateStatus:'validated_calibration_estimate'},
          issuedAtMs:performance.now(), masks:seg.mask ? [seg.mask.bounds] : [],
          sceneObjects:{gazeObject:seg.mask ? {label:seg.label, depthM:seg.depthM ? Math.round(seg.depthM * 100) / 100 : null, bounds:seg.mask.bounds} : null, objects, memory:memoryNow}};
        const started = performance.now();
        state.busy.spark = true;
        try {
          const result = await reason(body, signal);
          state.spark = {scenarios:result.scenarios.map(s => s.possible_next_action).filter(Boolean), label:seg.label, frameId:frame.frameId, videoTime:frame.videoTime, at:performance.now()};
          state.timings.spark = performance.now() - started; delete state.errors.spark;
        } catch (error) { if (signal.aborted) return; state.errors.spark = error.message; await sleep(3000, signal); }
        finally { state.busy.spark = false; }
      }
    }

    void yoloLoop(); void gazeLoop(); void sparkLoop();
    return () => controller.abort();
  }, [running, track, videoRef, memory, onMemory]);

  return live;
}
