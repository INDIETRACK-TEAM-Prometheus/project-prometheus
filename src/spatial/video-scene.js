// A recorded video as the observed scene, drawn into the same WebGL canvas as the synthetic world and offering the same
// frame interface (getFrame, history, pins), so gaze mapping, SAM, depth and Spark run unchanged on real-world footage.
// A video has no scene geometry: raycasts and engine depth report "unavailable" and depth comes only from the model.

const VERTEX = 'attribute vec2 position; attribute vec2 uv; varying vec2 v; void main(){v=uv;gl_Position=vec4(position,0.,1.);}';
const FRAGMENT = 'precision mediump float; varying vec2 v; uniform sampler2D frame; void main(){gl_FragColor=texture2D(frame,v);}';

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`WebGL shader: ${gl.getShaderInfoLog(shader)}`);
  return shader;
}

// Largest rectangle with the video's aspect ratio inside the canvas, in clip space (letterbox / pillarbox).
export function fitVideo(videoWidth, videoHeight, canvasWidth, canvasHeight) {
  if (![videoWidth, videoHeight, canvasWidth, canvasHeight].every(value => Number.isFinite(value) && value > 0)) return null;
  const scale = Math.min(canvasWidth / videoWidth, canvasHeight / videoHeight);
  return {x:videoWidth * scale / canvasWidth, y:videoHeight * scale / canvasHeight};
}

export function createVideoScene(canvas, video, {maxFrameHistory = 300, maxFramePins = 4} = {}) {
  const gl = canvas?.getContext('webgl', {preserveDrawingBuffer:true, antialias:true});
  if (!gl) throw new Error('WebGL unavailable');
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX), fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram(); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`WebGL program: ${gl.getProgramInfoLog(program)}`);
  const buffer = gl.createBuffer(), texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  for (const [name, value] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, name, value);
  let serial = 0, currentFrame = null, frameWidth = 0, frameHeight = 0, disposed = false;
  const frames = new Map(), pins = new Map();

  function render(timeMs = performance.now()) {
    if (disposed) throw new Error('video scene disposed');
    const width = canvas.width, height = canvas.height;
    if (!width || !height) throw new Error('empty canvas');
    gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 1); gl.disable(gl.DEPTH_TEST); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const fit = video.readyState >= 2 ? fitVideo(video.videoWidth, video.videoHeight, width, height) : null;
    if (!fit) { currentFrame = null; return null; }   // nothing to analyse until the video has a frame
    gl.useProgram(program);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // two triangles: position (clip space) + uv
    const data = new Float32Array([-fit.x, -fit.y, 0, 0, fit.x, -fit.y, 1, 0, -fit.x, fit.y, 0, 1, -fit.x, fit.y, 0, 1, fit.x, -fit.y, 1, 0, fit.x, fit.y, 1, 1]);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    for (const [name, offset] of [['position', 0], ['uv', 8]]) { const loc = gl.getAttribLocation(program, name); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 16, offset); }
    gl.uniform1i(gl.getUniformLocation(program, 'frame'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    serial++; frameWidth = width; frameHeight = height;
    currentFrame = Object.freeze({frameId:`video-${serial}`, renderTsMs:timeMs, image:canvas, intrinsics:null, cameraToWorld:null,
      viewport:Object.freeze({width, height}), depthSource:'none', provenance:'video_file', videoTimeS:video.currentTime, presentTsEstimateMs:null, displayUncertaintyMs:null});
    frames.set(currentFrame.frameId, currentFrame);
    while (frames.size > maxFrameHistory) frames.delete(frames.keys().next().value);
    return currentFrame;
  }
  function getFrame() { return currentFrame && canvas.width === frameWidth && canvas.height === frameHeight ? currentFrame : null; }
  function getHistoricalFrame(frameId) { return pins.get(frameId)?.frame ?? frames.get(frameId) ?? null; }
  function markPresented({presentMs, displayUncertaintyMs} = {}) {
    const frame = getFrame();
    if (!frame || !Number.isFinite(presentMs) || presentMs < frame.renderTsMs || !Number.isFinite(displayUncertaintyMs) || displayUncertaintyMs <= 0) return {status:'unavailable', reason:'invalid_presentation_estimate'};
    currentFrame = Object.freeze({...frame, presentTsEstimateMs:presentMs, displayUncertaintyMs}); frames.set(currentFrame.frameId, currentFrame);
    return {status:'ok', frame:currentFrame};
  }
  function pinFrame(frame) {
    const snapshot = frame && (pins.get(frame.frameId)?.frame ?? frames.get(frame.frameId));
    if (!snapshot || snapshot.renderTsMs !== frame.renderTsMs || disposed) return {status:'unavailable', reason:'frame_unavailable_or_evicted'};
    const pin = pins.get(snapshot.frameId); if (pin) { pin.count++; return {status:'ok'}; }
    if (pins.size >= maxFramePins) return {status:'unavailable', reason:'pin_limit'};
    pins.set(snapshot.frameId, {frame:snapshot, count:1}); return {status:'ok'};
  }
  function releaseFrame(frame) {
    const pin = frame && pins.get(frame.frameId); if (!pin || pin.frame.renderTsMs !== frame.renderTsMs) return false;
    if (--pin.count === 0) pins.delete(frame.frameId); return true;
  }
  const noGeometry = {status:'unavailable', point:null, reason:'video_scene_has_no_geometry'};
  return {
    kind:'video', render, getFrame, getHistoricalFrame, markPresented, pinFrame, releaseFrame,
    raycastFrame:() => noGeometry, raycast:() => noGeometry,
    getDepthAt:() => ({status:'unavailable', value:null, reason:'video_scene_has_no_geometry'}),
    project:() => ({status:'unavailable', pixel:null, reason:'video_scene_has_no_geometry'}),
    samplePinnedDepth:() => null, samplePinnedSurface:() => null,
    dispose() { disposed = true; frames.clear(); pins.clear(); currentFrame = null; gl.deleteBuffer(buffer); gl.deleteTexture(texture); gl.deleteProgram(program); gl.deleteShader(vs); gl.deleteShader(fs); }
  };
}
