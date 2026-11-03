// Recorded eye gaze (Project Aria MPS, exported by scripts/aria/export_gaze_video.py) replayed in step with the video
// scene, through the same controller interface as live webcam gaze. The demo then shows real smart-glasses gaze driving
// SAM 3.1, depth and Muse Spark, with no webcam or gaze GPU involved.

import {officialSample} from './official-webeyetrack.js';
import {fitVideo} from '../spatial/video-scene.js';

const finite = Number.isFinite;
const MAX_SAMPLES = 200000;
// A gaze sample further than this from the video time counts as missing (blink or tracking loss).
const MAX_GAP_S = .12;

export function parseGazeTrack(value) {
  const track = typeof value === 'string' ? JSON.parse(value) : value;
  if (track?.version !== 1 || !Array.isArray(track.samples) || !track.samples.length || track.samples.length > MAX_SAMPLES) throw new Error('not a gaze track (version 1)');
  const samples = [];
  for (const sample of track.samples) {
    if (!finite(sample?.t) || sample.t < 0) throw new Error('gaze track sample without a time');
    const has = finite(sample.x) && finite(sample.y) && sample.x >= 0 && sample.x <= 1 && sample.y >= 0 && sample.y <= 1;
    samples.push(has ? {t:sample.t, x:sample.x, y:sample.y} : {t:sample.t});
  }
  samples.sort((a, b) => a.t - b.t);
  return {source:typeof track.source === 'string' ? track.source.slice(0, 80) : 'recorded-gaze', sequence:typeof track.sequence === 'string' ? track.sequence.slice(0, 120) : null,
    width:finite(track.width) ? track.width : null, height:finite(track.height) ? track.height : null, fps:finite(track.fps) ? track.fps : null, samples};
}

// Gaze at video time t (normalised to the video frame), or null when the nearest sample is missing or too far away.
export function gazeAt(track, t) {
  const samples = track?.samples;
  if (!samples?.length || !finite(t)) return null;
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (samples[mid].t < t) lo = mid + 1; else hi = mid; }
  const nearest = [samples[lo], samples[lo - 1]].filter(Boolean).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
  return nearest && finite(nearest.x) && Math.abs(nearest.t - t) <= MAX_GAP_S ? {x:nearest.x, y:nearest.y} : null;
}

// Point in the video frame -> client (window) pixels, following the letterbox the video scene draws into the canvas.
export function videoPointToClient(point, video, rect) {
  const fit = fitVideo(video?.videoWidth, video?.videoHeight, rect?.width, rect?.height);
  if (!fit || !point) return null;
  return {x:rect.left + rect.width * (.5 + (point.x - .5) * fit.x), y:rect.top + rect.height * (.5 + (point.y - .5) * fit.y)};
}

export function createGazeReplayController({track, video, getSceneRect, onSample = () => {}, onDiagnostic = () => {}, getViewport = () => ({width:innerWidth, height:innerHeight}),
  clockNow = () => performance.now(), hz = 30} = {}) {
  if (!track?.samples?.length || !video || typeof getSceneRect !== 'function') throw new Error('gaze track, video and scene required');
  let timer = null, running = false, paused = false, frameId = 0;
  const diagnose = code => { try { onDiagnostic(code); } catch {} };
  function tick() {
    if (!running || paused) return;
    const viewport = getViewport(), client = videoPointToClient(gazeAt(track, video.currentTime), video, getSceneRect());
    const result = client && viewport.width > 0 && viewport.height > 0 ? {normPog:[client.x / viewport.width - .5, client.y / viewport.height - .5], gazeState:'open', durations:{}} : null;
    const sample = officialSample(result, {frameId:++frameId, receivedAt:clockNow(), viewport});
    try { onSample({...sample, gazeSource:track.source}); } catch {}
  }
  return {
    replay:true,
    // Recorded gaze needs no calibration gate (the glasses' own eye tracking produced it).
    official:true,
    get calibrated() { return running; },
    async start({userInitiated = false, cameraConsent = false} = {}) {
      if (!userInitiated || !cameraConsent) throw new Error('explicit start and consent required');
      if (running) throw new Error('already started');
      running = true; paused = false;
      void video.play?.().catch(() => {});
      timer = setInterval(tick, 1000 / hz);
      diagnose('gaze_replay_started');
      return {width:track.width, height:track.height, frameRate:track.fps};
    },
    click() { return false; },
    pause() { if (running) { paused = true; video.pause?.(); } },
    resume() { if (running) { paused = false; void video.play?.().catch(() => {}); } },
    telemetry() { return null; },
    setTimingCalibration() {},
    cancelCalibration() {},
    stop() { running = false; paused = false; clearInterval(timer); timer = null; diagnose('gaze_replay_stopped'); }
  };
}
