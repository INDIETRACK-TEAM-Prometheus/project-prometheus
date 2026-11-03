// Which segmented object is the user looking at? Webcam gaze is off by roughly 10% of the screen, so instead of trusting
// the single pixel under the gaze point, objects are ranked by the distance from the fixation to their box (0 when the
// point is inside; the smaller box wins among boxes that contain it), and only objects within `radius` qualify.

const finite = Number.isFinite;

// Fraction of the frame diagonal; about the median webcam gaze error measured in this project's recordings.
export const GAZE_TARGET_RADIUS = .12;

function distanceToBox(x, y, box) {
  const dx = Math.max(box.left - x, 0, x - box.right), dy = Math.max(box.top - y, 0, y - box.bottom);
  return Math.hypot(dx, dy);
}

// point: normalised [0,1) frame coordinates; candidates: [{objectId, bounds:{left,top,right,bottom}}] in frame pixels.
export function rankGazeTargets(point, candidates, frame, {radius = GAZE_TARGET_RADIUS} = {}) {
  if (!finite(point?.x) || !finite(point?.y) || !Number.isInteger(frame?.width) || !Number.isInteger(frame?.height) || frame.width < 1 || frame.height < 1 || !Array.isArray(candidates) || !finite(radius) || radius <= 0) return [];
  const x = point.x * frame.width, y = point.y * frame.height, diagonal = Math.hypot(frame.width, frame.height);
  return candidates
    .map(candidate => {
      const b = candidate?.bounds;
      if (typeof candidate?.objectId !== 'string' || ![b?.left, b?.top, b?.right, b?.bottom].every(finite)) return null;
      return {objectId:candidate.objectId, distance:distanceToBox(x, y, b) / diagonal, area:Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top)};
    })
    .filter(entry => entry && entry.distance <= radius)
    .sort((a, b) => a.distance - b.distance || a.area - b.area)
    .map(({objectId, distance}) => ({objectId, distance:Math.round(distance * 10000) / 10000}));
}
