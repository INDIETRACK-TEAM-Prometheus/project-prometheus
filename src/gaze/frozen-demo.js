const finite = value => Number.isFinite(value);

export function createFrozenGazeAutomation({run, now=()=>performance.now(), setTimer=setTimeout, clearTimer=clearTimeout, intervalMs=5000}={}) {
  if(typeof run!=='function'||typeof now!=='function'||typeof setTimer!=='function'||typeof clearTimer!=='function'||!finite(intervalMs)||intervalMs<=0) throw new TypeError('invalid frozen gaze automation');
  let active=false,timer=null,generation=0,lastRunAt=-Infinity;
  function schedule(token) {
    if(!active||token!==generation)return;
    const current=now();if(!finite(current)){active=false;return;}
    const delay=Number.isFinite(lastRunAt)?Math.max(0,lastRunAt+intervalMs-current):0;
    timer=setTimer(()=>{timer=null;if(!active||token!==generation)return;lastRunAt=now();let result;try{result=run();}catch{schedule(token);return;}if(result&&typeof result.then==='function')Promise.resolve(result).then(()=>schedule(token),()=>schedule(token));else schedule(token);},delay);
  }
  return {
    start(){if(active)return false;active=true;schedule(++generation);return true;},
    stop(){active=false;generation++;if(timer!==null)clearTimer(timer);timer=null;},
    status(){return {active,timerPending:timer!==null};}
  };
}

// This admits a recent browser sample within a frozen-scene window; it does not
// estimate or certify physical camera/display synchronization.
export function selectFrozenSceneGaze({sample, frame, canvasRect, frozenAtMs, stableAfterMs, nowMs, maxCaptureProcessingLagMs=250, maxProcessingAgeMs=100}) {
  if (!sample?.valid || sample.timestampKind!=='browser_capture_estimate' || !finite(sample.timestampMs) || !finite(sample.processedMs) || !finite(nowMs)) return {status:'withheld',reason:'capture_estimate_required'};
  if (!frame?.frameId || !Number.isInteger(frame.width) || frame.width<1 || !Number.isInteger(frame.height) || frame.height<1) return {status:'withheld',reason:'frozen_frame_unavailable'};
  if (![frozenAtMs,stableAfterMs,canvasRect?.left,canvasRect?.top,canvasRect?.width,canvasRect?.height].every(finite) || stableAfterMs<frozenAtMs || canvasRect.width<=0 || canvasRect.height<=0) return {status:'withheld',reason:'invalid_frozen_window'};
  const captureProcessingLagMs=sample.processedMs-sample.timestampMs, processingAgeMs=nowMs-sample.processedMs;
  if (sample.timestampMs<stableAfterMs || sample.processedMs<stableAfterMs) return {status:'withheld',reason:'sample_before_stable_window'};
  if (captureProcessingLagMs<0 || captureProcessingLagMs>maxCaptureProcessingLagMs || processingAgeMs<0 || processingAgeMs>maxProcessingAgeMs) return {status:'withheld',reason:'sample_stale_or_lagged'};
  const point=sample.rawScreenXY;
  if (!finite(point?.x) || !finite(point?.y) || point.x<canvasRect.left || point.x>=canvasRect.left+canvasRect.width || point.y<canvasRect.top || point.y>=canvasRect.top+canvasRect.height) return {status:'withheld',reason:'gaze_outside_frozen_scene'};
  return {status:'ready',frameId:frame.frameId,point:{x:(point.x-canvasRect.left)/canvasRect.width,y:(point.y-canvasRect.top)/canvasRect.height},captureAtMs:sample.timestampMs,processedAtMs:sample.processedMs,captureProcessingLagMs,maxCaptureProcessingLagMs,processingAgeMs,maxAcceptedProcessingAgeMs:maxProcessingAgeMs,maxAcceptedSampleAgeMs:maxCaptureProcessingLagMs+maxProcessingAgeMs,timingStatus:'unverified_frozen_scene_window',opticalTimingUncertaintyMs:null};
}
