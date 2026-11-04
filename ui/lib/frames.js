// Frames for analysis are copied straight from the <video> element (not the screen), so letterboxing and overlays never
// reach SAM, RT-DETR or depth.

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

const images = new Map();
function loadImage(src) {
  if (!images.has(src)) {
    images.set(src, new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; }));
    while (images.size > 8) images.delete(images.keys().next().value);
  }
  return images.get(src);
}

// Numbered crops in one grid image for the vision model: each crop keeps its aspect ratio with some context around it.
export async function cropGrid(entries, {tile = 200, columns = 3, margin = .15} = {}) {
  const cols = Math.min(columns, entries.length), rows = Math.ceil(entries.length / cols);
  const canvas = document.createElement('canvas');
  canvas.width = cols * tile; canvas.height = rows * tile;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const [index, entry] of entries.entries()) {
    const image = await loadImage(entry.src), b = entry.bounds;
    const w = b.right - b.left, h = b.bottom - b.top, side = Math.max(w, h) * (1 + 2 * margin);
    const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2, sx = image.naturalWidth / entry.width, sy = image.naturalHeight / entry.height;
    const x = (index % cols) * tile, y = Math.floor(index / cols) * tile;
    ctx.drawImage(image, (cx - side / 2) * sx, (cy - side / 2) * sy, side * sx, side * sy, x, y, tile, tile);
    ctx.fillStyle = '#000'; ctx.fillRect(x, y, 30, 28);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 20px sans-serif'; ctx.fillText(String(index + 1), x + 8, y + 21);
  }
  return canvas.toDataURL('image/jpeg', .85);
}

// The frame Muse Spark predicts from, with what the detectors found drawn on it: the SAM 3.1 segment at the gaze
// (green, tag G), the gaze point, and every RT-DETR box (white, numbered like the objects list it gets as text).
export async function annotateFrame(frame, {gaze, gazeBounds, boxes}) {
  const image = await loadImage(frame.dataUrl), canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d'), sx = canvas.width / frame.sourceWidth, sy = canvas.height / frame.sourceHeight;
  ctx.drawImage(image, 0, 0);
  const tag = (text, x, y, color) => {
    ctx.font = 'bold 13px sans-serif';
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = color; ctx.fillRect(x, Math.max(0, y - 16), w, 16);
    ctx.fillStyle = '#000'; ctx.fillText(text, x + 4, Math.max(12, y - 4));
  };
  boxes.forEach((b, i) => {
    ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(b.left * sx, b.top * sy, (b.right - b.left) * sx, (b.bottom - b.top) * sy);
    tag(String(i + 1), b.left * sx, b.top * sy, '#ffffff');
  });
  if (gazeBounds) {
    ctx.lineWidth = 3; ctx.strokeStyle = '#41d7a2';
    ctx.strokeRect(gazeBounds.left * sx, gazeBounds.top * sy, (gazeBounds.right - gazeBounds.left) * sx, (gazeBounds.bottom - gazeBounds.top) * sy);
    tag('G', gazeBounds.left * sx, gazeBounds.top * sy, '#41d7a2');
  }
  if (gaze) { ctx.fillStyle = '#41d7a2'; ctx.beginPath(); ctx.arc(gaze.x * canvas.width, gaze.y * canvas.height, 6, 0, Math.PI * 2); ctx.fill(); }
  return canvas.toDataURL('image/jpeg', .8);
}

// Two rows of keyframes for place comparison: the remembered place on top, the current recording below.
export async function keyframeGrid(top, bottom, {tile = 256} = {}) {
  const cols = Math.max(top.length, bottom.length), canvas = document.createElement('canvas');
  canvas.width = cols * tile; canvas.height = 2 * tile;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const [row, frames] of [top, bottom].entries()) for (const [col, src] of frames.entries()) ctx.drawImage(await loadImage(src), col * tile, row * tile, tile, tile);
  ctx.fillStyle = '#41d7a2'; ctx.fillRect(0, tile - 2, canvas.width, 4);
  return canvas.toDataURL('image/jpeg', .8);
}
