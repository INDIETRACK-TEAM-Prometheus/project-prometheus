// Isolate the upstream UMD/global and local MediaPipe wiring so it can be
// verified with synthetic classes without loading camera or model assets.
export async function initializeWebEyeTrack({WebEyeTrack, FaceLandmarkerClient, vision, wasmRoot='/vendor', modelAssetPath='/vendor/face_landmarker.task', maxPoints=27} = {}) {
  if (typeof WebEyeTrack !== 'function' || typeof FaceLandmarkerClient !== 'function') throw new Error('WebEyeTrack UMD globals are unavailable');
  if (!vision?.FilesetResolver?.forVisionTasks || !vision?.FaceLandmarker?.createFromOptions) throw new Error('local MediaPipe module is unavailable');

  FaceLandmarkerClient.prototype.initialize = async function initializeLocalFaceLandmarker() {
    const files = await vision.FilesetResolver.forVisionTasks(wasmRoot);
    this.faceLandmarker = await vision.FaceLandmarker.createFromOptions(files, {
      baseOptions:{modelAssetPath},
      outputFaceBlendshapes:true,
      outputFacialTransformationMatrixes:true,
      runningMode:'IMAGE',
      numFaces:1
    });
  };

  const tracker = new WebEyeTrack(maxPoints);
  await tracker.initialize();
  return tracker;
}
