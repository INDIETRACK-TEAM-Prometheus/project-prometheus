// The WebEyeTrack package's own worker (WebEyeTrackWorker in webeyetrack 0.0.2), message for message, with one change:
// the tracker keeps more calibration points. The package worker builds `new WebEyeTrack()`, whose default maxPoints is 5,
// so only the last 5 clicks ever count; the count comes from the init payload here.
importScripts('/vendor/webeyetrack.js');

let tracker = null;
let status = 'idle';
const setStatus = value => { status = value; self.postMessage({type:'statusUpdate', status}); };

self.onmessage = async event => {
  const {type, payload} = event.data ?? {};
  if (type === 'init') {
    const maxPoints = Number.isInteger(payload?.maxPoints) && payload.maxPoints >= 5 && payload.maxPoints <= 200 ? payload.maxPoints : 5;
    tracker = new self.WebEyeTrack(maxPoints);
    await tracker.initialize();
    self.postMessage({type:'ready'});
    status = 'idle';
  } else if (type === 'step') {
    if (status !== 'idle' || !tracker) return;
    setStatus('inference');
    const result = await tracker.step(payload.frame, payload.timestamp);
    self.postMessage({type:'stepResult', result});
    setStatus('idle');
  } else if (type === 'click') {
    if (!tracker) return;
    setStatus('calib');
    tracker.handleClick(payload.x, payload.y);
    setStatus('idle');
  } else {
    console.warn(`[WebEyeTrackWorker] Unknown message type: ${type}`);
  }
};
