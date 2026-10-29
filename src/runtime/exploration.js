// Exploration never queues behind a gaze request.
export function createExploration({allowed, pipeline, snapshot, now, intervalMs=5000, onStatus=()=>{}}) {
  let last=-Infinity;
  return {tick() {
    if (!allowed()) return {accepted:false,reason:'disabled'};
    const current=pipeline(), time=now();
    if (!current || current.status().running || current.status().pending) return {accepted:false,reason:'busy'};
    if (!Number.isFinite(time) || time-last<intervalMs) return {accepted:false,reason:'rate_limited'};
    const frame=snapshot();
    if (!frame || !allowed() || current!==pipeline()) return {accepted:false,reason:'frame_unavailable'};
    const result=current.submit({frame,gaze:null,event:null});
    if(result.accepted) {last=time;onStatus(result);}
    return result;
  }};
}
