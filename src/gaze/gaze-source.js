// Where the perception loops get gaze, the camera pose, camera rays and depth anchors for the scene video, in
// normalised scene-video coordinates. A recorded track (scripts/aria/export_gaze_video.py) provides all of them; a
// dataset converted into the same track format plugs in unchanged.

import {gazeAt, poseAt, rayAt, anchorsAt} from './gaze-replay.js';

export function recordedSource(track) {
  return {kind:'recorded', track, gaze:t => gazeAt(track, t), pose:t => poseAt(track, t), ray:(x, y) => rayAt(track, x, y), anchors:t => anchorsAt(track, t)};
}
