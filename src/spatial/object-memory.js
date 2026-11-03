// 3D memory of the objects the wearer looked at. Each SAM 3.1 segmentation at the gaze point becomes a world point:
// the mask centroid's camera ray (Aria fisheye ray grid) scaled to the mask's median depth (Depth Anything, axial metres),
// moved into the world frame with the MPS camera pose. Repeated sightings of the same label close together merge, so the
// memory keeps one place per object while the wearer walks around.

const finite = Number.isFinite;

// Row-major 3x4 camera-to-world pose, camera-frame unit ray, axial depth (along the camera's +z) -> world point.
export function worldPoint(pose, ray, axialDepthM) {
  if (!Array.isArray(pose) || pose.length !== 12 || !pose.every(finite) || !Array.isArray(ray) || ray.length !== 3 || !ray.every(finite) || !(ray[2] > 0.05) || !(axialDepthM > 0)) return null;
  const scale = axialDepthM / ray[2], p = ray.map(value => value * scale);
  return [0, 1, 2].map(row => pose[row * 4] * p[0] + pose[row * 4 + 1] * p[1] + pose[row * 4 + 2] * p[2] + pose[row * 4 + 3]);
}

export function cameraPosition(pose) { return Array.isArray(pose) && pose.length === 12 ? [pose[3], pose[7], pose[11]] : null; }

// Where a remembered point is from the current camera: straight-line distance and a coarse bearing on the floor plane
// (MPS world frames are gravity aligned with +z up).
export function relativeTo(pose, point) {
  const origin = cameraPosition(pose);
  if (!origin || !Array.isArray(point) || !point.every(finite)) return null;
  const d = point.map((value, i) => value - origin[i]), forward = [pose[2], pose[6], 0], distanceM = Math.hypot(...d);
  const angle = Math.atan2(forward[0] * d[1] - forward[1] * d[0], forward[0] * d[0] + forward[1] * d[1]) * 180 / Math.PI;
  const bearing = Math.abs(angle) <= 30 ? 'ahead' : Math.abs(angle) >= 135 ? 'behind' : angle > 0 ? 'left' : 'right';
  return {distanceM:Math.round(distanceM * 100) / 100, bearing};
}

// SAM mask raster cells (mask.width x mask.height over mask.bounds, values 0/1) in frame pixels.
function* maskPixels(mask) {
  const b = mask?.bounds;
  if (!b || !Array.isArray(mask.raster) || mask.raster.length !== mask.width * mask.height) return;
  const cw = (b.right - b.left) / mask.width, ch = (b.bottom - b.top) / mask.height;
  for (let row = 0; row < mask.height; row++) for (let col = 0; col < mask.width; col++) if (mask.raster[row * mask.width + col]) yield [b.left + (col + .5) * cw, b.top + (row + .5) * ch];
}

// Centroid of the mask, normalised to the frame.
export function maskCentroid(mask, frame) {
  let x = 0, y = 0, n = 0;
  for (const [px, py] of maskPixels(mask)) { x += px; y += py; n++; }
  return n && frame?.width > 0 && frame?.height > 0 ? {x:x / n / frame.width, y:y / n / frame.height, pixels:n} : null;
}

// Median valid depth under the mask; depth: {width, height, values, validMask} over the same frame at its own size.
export function maskDepthMedian(mask, frame, depth) {
  if (!depth || !(frame?.width > 0) || !(frame?.height > 0)) return null;
  const sx = depth.width / frame.width, sy = depth.height / frame.height, values = [];
  for (const [px, py] of maskPixels(mask)) {
    const index = Math.min(depth.height - 1, Math.floor(py * sy)) * depth.width + Math.min(depth.width - 1, Math.floor(px * sx));
    if (depth.validMask[index] && finite(depth.values[index])) values.push(depth.values[index]);
  }
  if (values.length < 3) return null;
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

// Median valid depth inside a box (frame pixels), for YOLO detections.
export function boxDepthMedian(bounds, frame, depth) {
  if (!depth || !bounds || !(frame?.width > 0)) return null;
  const sx = depth.width / frame.width, sy = depth.height / frame.height, values = [];
  // the central half of the box: edges of a box are mostly background
  const w = bounds.right - bounds.left, h = bounds.bottom - bounds.top;
  const x0 = Math.floor((bounds.left + w / 4) * sx), x1 = Math.ceil((bounds.right - w / 4) * sx), y0 = Math.floor((bounds.top + h / 4) * sy), y1 = Math.ceil((bounds.bottom - h / 4) * sy);
  for (let y = Math.max(0, y0); y < Math.min(depth.height, y1); y++) for (let x = Math.max(0, x0); x < Math.min(depth.width, x1); x++) {
    const index = y * depth.width + x;
    if (depth.validMask[index] && finite(depth.values[index])) values.push(depth.values[index]);
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

// Metric scale for a monocular depth map: the median of anchor depth / map depth at the anchors (MPS SLAM points),
// or null with fewer than minAnchors usable anchors. anchors: [[x, y, axial depth m]] in normalised frame coordinates.
export function depthScale(anchors, depth, {minAnchors = 6} = {}) {
  if (!Array.isArray(anchors) || !depth) return null;
  const ratios = [];
  for (const [x, y, z] of anchors) {
    const index = Math.min(depth.height - 1, Math.floor(y * depth.height)) * depth.width + Math.min(depth.width - 1, Math.floor(x * depth.width));
    const value = depth.values[index];
    if (depth.validMask[index] && finite(value) && value > 0) ratios.push(z / value);
  }
  if (ratios.length < minAnchors) return null;
  ratios.sort((a, b) => a - b);
  return ratios[ratios.length >> 1];
}

export function createObjectMemory({mergeDistanceM = .6, maxObjects = 60} = {}) {
  const objects = [];
  let serial = 0;
  return {
    // label may be null (SAM segmented something YOLO has no class for); unlabelled sightings merge only very close by.
    observe({label = null, point, t, depthM = null}) {
      if (!Array.isArray(point) || point.length !== 3 || !point.every(finite) || !finite(t)) return null;
      const limit = label ? mergeDistanceM : mergeDistanceM / 2;
      let best = null, bestDistance = Infinity;
      for (const object of objects) {
        if (object.label !== label && object.label && label) continue;
        const distance = Math.hypot(...object.position.map((value, i) => value - point[i]));
        if (distance <= limit && distance < bestDistance) { best = object; bestDistance = distance; }
      }
      if (best) {
        // running mean, so a single bad depth does not move a well-seen object far
        best.position = best.position.map((value, i) => (value * best.count + point[i]) / (best.count + 1));
        best.count++; best.lastT = t; best.label ??= label; best.depthM = depthM;
        if (best.recalled) best.seenAgain = true;
        return best;
      }
      const object = {id:`obj-${++serial}`, label, position:[...point], count:1, firstT:t, lastT:t, depthM};
      objects.push(object);
      if (objects.length > maxObjects) objects.splice(objects.indexOf(objects.reduce((a, b) => a.lastT <= b.lastT ? a : b)), 1);
      return object;
    },
    // Objects recalled from a remembered place (same world frame): they keep their position and name, and count as
    // seen again once a new sighting merges into them.
    seed(recalled, from) {
      for (const object of recalled ?? []) {
        if (!Array.isArray(object?.position) || object.position.length !== 3 || !object.position.every(finite)) continue;
        objects.push({id:`obj-${++serial}`, label:object.label ?? null, position:[...object.position], count:object.count ?? 1, firstT:-1, lastT:-1, depthM:null, recalled:true, seenAgain:false, from:from ?? null});
      }
      while (objects.length > maxObjects) objects.shift();
    },
    forget(id) {
      const index = objects.findIndex(item => item.id === id);
      if (index < 0) return false;
      objects.splice(index, 1); return true;
    },
    // A name from the vision model replaces the detector's class for this object.
    rename(id, label) {
      const object = objects.find(item => item.id === id);
      if (!object || typeof label !== 'string' || !label) return false;
      object.label = label; return true;
    },
    list() { return objects.map(object => ({...object, position:[...object.position]})); },
    clear() { objects.length = 0; }
  };
}
