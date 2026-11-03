// Calls to the local server: clip list, YOLO, SAM 3.1, depth and Muse Spark. Each throws on a failed response.

async function post(url, body, signal) {
  const response = await fetch(url, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body), signal});
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) throw Object.assign(new Error(data?.code ?? data?.providerCode ?? data?.error ?? `http_${response.status}`), {status:response.status});
  return data;
}

export async function listClips() {
  const response = await fetch('/api/demo/clips');
  if (!response.ok) throw new Error('clips_unavailable');
  return (await response.json()).clips;
}

export const detect = (frame, signal) => post('/api/detect', {frame:{frameId:frame.frameId, observedAt:frame.observedAt, width:frame.width, height:frame.height}, imageDataUrl:frame.dataUrl}, signal);

// SAM 3.1 point prompt at the gaze point (the format the Meta API takes for a single positive point).
export function samPointPrompt(frame, gaze) {
  return `<0f>1<|point;x=${Math.min(frame.width - 1, Math.floor(gaze.x * frame.width))};y=${Math.min(frame.height - 1, Math.floor(gaze.y * frame.height))};w=${frame.width};h=${frame.height}|>`;
}
export const segment = (frame, prompt, signal) => post('/api/sam/segment', {frame:{frameId:frame.frameId, observedAt:frame.observedAt}, imageDataUrl:frame.dataUrl, prompt}, signal);

export async function estimateDepth(frame, signal) {
  const result = await post('/api/depth/estimate', {frame:{frameId:frame.frameId, observedAt:frame.observedAt, width:frame.width, height:frame.height}, imageDataUrl:frame.dataUrl}, signal);
  const d = result.depth;
  return {width:d.width, height:d.height, values:d.values, validMask:d.validMask, model:result.model?.id ?? null};
}

export const reason = (body, signal) => post('/api/reason-provisional', body, signal);

export const nameObjects = (imageDataUrl, tiles, signal) => post('/api/name-objects', {imageDataUrl, tiles}, signal);
export const predict = (body, signal) => post('/api/predict', body, signal);
