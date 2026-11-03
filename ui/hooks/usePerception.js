import {useEffect, useRef} from 'react';
import {detect, segment, samPointPrompt, estimateDepth, predict, nameObjects} from '../lib/api.js';
import {captureVideo, boxIou, scaleBounds, cropGrid} from '../lib/frames.js';
import {gazeAt, poseAt, rayAt, anchorsAt} from '../../src/gaze/gaze-replay.js';
import {worldPoint, maskCentroid, maskDepthMedian, boxDepthMedian, relativeTo, depthScale} from '../../src/spatial/object-memory.js';

// Three loops over the playing glasses video, each as fast as its model allows and none waiting for another:
//   YOLO (local CPU, ~0.15 s)      class names and boxes for the whole frame
//   depth (~1-2 s, local CPU)     a metric depth map (scaled by SLAM points) for distances and the 3D memory
//   SAM 3.1 (~0.5 s)               the object at the gaze point, published at once, placed in the 3D memory
//   Muse Spark naming (~5 s)       looks at the crops YOLO and SAM cut out and names them ("gray suitcase")
//   Muse Spark (~1.5 s)            next-action predictions from the latest gaze result and the memory
// Results live in a ref (read every animation frame by the overlay), not in React state.

const sleep = (ms, signal) => new Promise(resolve => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, {once:true}); });
const LABEL_IOU = .25, NAME_TTL_MS = 8000, NAME_IOU = .3;
const clean = label => typeof label === 'string' ? label.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 40) || null : null;

// The vision model's name for a YOLO box: a box it named recently with the same class that overlaps this one.
export function visionName(item, frame, named, now) {
  if (!named?.list?.length || now - named.at > NAME_TTL_MS) return null;
  const sx = frame.width / named.frame.width, sy = frame.height / named.frame.height;
  let best = null, bestIou = NAME_IOU;
  for (const entry of named.list) {
    if (!entry.name || entry.yolo !== item.label) continue;
    const iou = boxIou(scaleBounds(entry.bounds, sx, sy), item.bounds);
    if (iou > bestIou) { best = entry; bestIou = iou; }
  }
  return best?.name ?? null;
}

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

    // Depth runs on its own: SAM never waits for it. Each SAM result uses the newest depth map (at most a few seconds old).
    async function depthLoop() {
      while (!signal.aborted) {
        if (!playing()) { await sleep(150, signal); continue; }
        const small = captureVideo(video(), 320);
        if (!small) { await sleep(150, signal); continue; }
        const started = performance.now();
        state.busy.depth = true;
        try {
          const map = metric(await estimateDepth(small, signal), small.videoTime);
          state.depth = {map, frame:small, at:performance.now()};
          state.timings.depth = performance.now() - started; delete state.errors.depth;
        } catch (error) { if (signal.aborted) return; state.errors.depth = error.message; await sleep(1000, signal); }
        finally { state.busy.depth = false; }
      }
    }

    // SAM 3.1 at the gaze point, published as soon as it answers: Spark naming and prediction start from it at once.
    async function gazeLoop() {
      while (!signal.aborted) {
        if (!playing()) { await sleep(100, signal); continue; }
        const frame = captureVideo(video(), 640), preview = captureVideo(video(), 448, {quality:.8});
        const gaze = frame && gazeAt(track, frame.videoTime);
        if (!frame || !gaze || gaze.x >= 1 || gaze.y >= 1) { await sleep(100, signal); continue; }
        const pose = poseAt(track, frame.videoTime), started = performance.now();
        state.busy.sam = true;
        let masks = [];
        try { masks = (await segment(frame, samPointPrompt(frame, gaze), signal)).masks ?? []; state.timings.sam = performance.now() - started; delete state.errors.sam; }
        catch (error) { if (signal.aborted) return; state.errors.sam = error.message; await sleep(500, signal); continue; }
        finally { state.busy.sam = false; }
        const mask = masks[0] ?? null;
        const named = nameMask(mask?.bounds ?? null, gaze, state.detections, frame);
        const depth = state.depth && performance.now() - state.depth.at < 4000 ? state.depth.map : null;
        const depthM = mask && depth ? maskDepthMedian(mask, frame, depth) : named && depth ? boxDepthMedian(named.bounds, frame, depth) : null;
        const centroid = mask ? maskCentroid(mask, frame) : null;
        const point = centroid && pose && depthM ? worldPoint(pose, rayAt(track, centroid.x, centroid.y), depthM) : null;
        // the memory keeps the vision model's names only; until one arrives the object stays unnamed there
        const remembered = point ? memory.observe({label:null, point, t:frame.videoTime, depthM}) : null;
        if (remembered) onMemory();
        state.segment = {frame, preview, gaze, pose, mask, label:remembered?.label ?? named?.label ?? null, visionNamed:!!remembered?.label, yoloLabel:named?.label ?? null, score:named?.score ?? null, depthM, memoryId:remembered?.id ?? null, at:performance.now()};
        if (!mask) await sleep(200, signal);
      }
    }

    async function namingLoop() {
      let lastFrameId = null;
      while (!signal.aborted) {
        const seg = state.segment, det = state.detections;
        if (!seg?.mask || seg.frame.frameId === lastFrameId || !playing()) { await sleep(250, signal); continue; }
        lastFrameId = seg.frame.frameId;
        const boxes = (det?.list ?? []).filter(item => item.score >= .35).slice(0, 5);
        const entries = [{src:seg.frame.dataUrl, width:seg.frame.width, height:seg.frame.height, bounds:seg.mask.bounds},
          ...boxes.map(item => ({src:det.frame.dataUrl, width:det.frame.width, height:det.frame.height, bounds:item.bounds}))];
        const started = performance.now();
        state.busy.naming = true;
        try {
          const grid = await cropGrid(entries);
          const {names} = await nameObjects(grid, entries.length, signal);
          state.timings.naming = performance.now() - started; delete state.errors.naming;
          if (names[0] && seg.memoryId && memory.rename(seg.memoryId, names[0])) onMemory();
          if (names[0] && state.segment?.memoryId === seg.memoryId) Object.assign(state.segment, {label:names[0], visionNamed:true});
          state.named = {frame:det?.frame ?? seg.frame, at:performance.now(), list:boxes.map((item, i) => ({bounds:item.bounds, yolo:item.label, name:names[i + 1] ?? null}))};
        } catch (error) { if (signal.aborted) return; state.errors.naming = error.message; await sleep(2000, signal); }
        finally { state.busy.naming = false; }
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
          return {label:clean(visionName({...item, bounds}, frame, state.named, performance.now()) ?? item.label) ?? 'object', score:item.score, depthM:d ? Math.round(d * 100) / 100 : null, bounds};
        }).filter(o => o.bounds.right > o.bounds.left && o.bounds.bottom > o.bounds.top);
        const memoryNow = seg.pose ? memory.list().filter(o => o.label && o.id !== seg.memoryId).sort((a, b) => b.lastT - a.lastT).slice(0, 8)
          .map(o => ({label:clean(o.label) ?? 'object', ...relativeTo(seg.pose, o.position), secondsAgo:Math.max(0, Math.round((frame.videoTime - o.lastT) * 10) / 10)}))
          .filter(o => Number.isFinite(o.distanceM)) : [];
        // the prediction sees a smaller copy of the same frame (fewer image tokens, same view)
        const body = {frame:{width:frame.width, height:frame.height}, imageDataUrl:seg.preview?.dataUrl ?? frame.dataUrl, gazePoint:{x:seg.gaze.x, y:seg.gaze.y},
          sceneObjects:{gazeObject:seg.mask ? {label:clean(seg.label), depthM:seg.depthM ? Math.round(seg.depthM * 100) / 100 : null, bounds:seg.mask.bounds} : null, objects, memory:memoryNow}};
        const started = performance.now();
        state.busy.spark = true;
        try {
          const result = await predict(body, signal);
          state.spark = {scenarios:result.predictions, label:seg.label, frameId:frame.frameId, videoTime:frame.videoTime, at:performance.now()};
          state.timings.spark = performance.now() - started; delete state.errors.spark;
        } catch (error) { if (signal.aborted) return; state.errors.spark = error.message; await sleep(3000, signal); }
        finally { state.busy.spark = false; }
      }
    }

    void yoloLoop(); void depthLoop(); void gazeLoop(); void namingLoop(); void sparkLoop();
    return () => controller.abort();
  }, [running, track, videoRef, memory, onMemory]);

  return live;
}
