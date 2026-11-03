// Frames for analysis are copied straight from the <video> element (not the screen), so letterboxing and overlays never
// reach SAM, YOLO or depth.

let serial = 0;

export function captureVideo(video, maxSide, {quality = .85} = {}) {
  if (!video || video.readyState < 2 || !video.videoWidth) return null;
  const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return {frameId:`f${++serial}`, observedAt:performance.now(), videoTime:video.currentTime, width:canvas.width, height:canvas.height, dataUrl:canvas.toDataURL('image/jpeg', quality)};
}

// The rectangle the video content occupies inside its box with object-fit: contain.
export function contentRect(video, box) {
  const vw = video?.videoWidth, vh = video?.videoHeight;
  if (!vw || !vh || !box?.width || !box?.height) return null;
  const scale = Math.min(box.width / vw, box.height / vh), width = vw * scale, height = vh * scale;
  return {left:(box.width - width) / 2, top:(box.height - height) / 2, width, height};
}

export function boxIou(a, b) {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)), h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const inter = w * h, union = (a.right - a.left) * (a.bottom - a.top) + (b.right - b.left) * (b.bottom - b.top) - inter;
  return union > 0 ? inter / union : 0;
}

export function scaleBounds(b, sx, sy) {
  return {left:Math.round(b.left * sx), top:Math.round(b.top * sy), right:Math.round(b.right * sx), bottom:Math.round(b.bottom * sy)};
}

// SAM raster mask -> an offscreen canvas of the mask grid (drawn stretched over its bounds).
export function maskCanvas(mask, color) {
  const canvas = document.createElement('canvas');
  canvas.width = mask.width; canvas.height = mask.height;
  const ctx = canvas.getContext('2d'), image = ctx.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.raster.length; i++) if (mask.raster[i]) { image.data[i * 4] = color[0]; image.data[i * 4 + 1] = color[1]; image.data[i * 4 + 2] = color[2]; image.data[i * 4 + 3] = color[3]; }
  ctx.putImageData(image, 0, 0);
  return canvas;
}
