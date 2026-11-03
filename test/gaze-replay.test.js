import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGazeTrack, gazeAt, videoPointToClient, createGazeReplayController} from '../src/gaze/gaze-replay.js';

const track = parseGazeTrack({version:1, source:'project-aria-mps-eye-gaze', width:1024, height:1024, fps:10,
  samples:[{t:0, x:.5, y:.5}, {t:.1, x:.6, y:.4}, {t:.2}, {t:.3, x:.2, y:.9}, {t:1.5, x:.1, y:.1}]});

test('gaze tracks are validated and samples without gaze stay as gaps', () => {
  assert.equal(track.samples.length, 5);
  assert.deepEqual(track.samples[2], {t:.2});
  assert.throws(() => parseGazeTrack({version:2, samples:[{t:0}]}));
  assert.throws(() => parseGazeTrack({version:1, samples:[{x:.5, y:.5}]}));
});

test('the gaze at a video time is the nearest sample, null for gaps or far-away samples', () => {
  assert.deepEqual(gazeAt(track, .11), {x:.6, y:.4});
  assert.equal(gazeAt(track, .2), null);            // blink / tracking loss
  assert.deepEqual(gazeAt(track, .32), {x:.2, y:.9});
  assert.equal(gazeAt(track, .9), null);            // nearest sample is 0.6 s away
});

test('video points map through the letterbox the scene draws', () => {
  const video = {videoWidth:1024, videoHeight:1024};
  // 2000x1000 canvas at (100,50): the square video is a 1000x1000 pillarbox in the middle
  const rect = {left:100, top:50, width:2000, height:1000};
  assert.deepEqual(videoPointToClient({x:.5, y:.5}, video, rect), {x:1100, y:550});
  assert.deepEqual(videoPointToClient({x:0, y:0}, video, rect), {x:600, y:50});
  assert.deepEqual(videoPointToClient({x:1, y:1}, video, rect), {x:1600, y:1050});
  assert.equal(videoPointToClient({x:.5, y:.5}, {videoWidth:0, videoHeight:0}, rect), null);
});

test('the replay controller emits valid samples at the gaze point and none of the camera work', async () => {
  const samples = [], video = {videoWidth:1024, videoHeight:1024, currentTime:.1, play:async () => {}, pause() {}};
  const controller = createGazeReplayController({track, video, getSceneRect:() => ({left:0, top:0, width:1000, height:1000}), getViewport:() => ({width:1000, height:1000}),
    onSample:sample => samples.push(sample), clockNow:() => 5, hz:100});
  assert.equal(controller.replay, true); assert.equal(controller.calibrated, false);
  await controller.start({userInitiated:true, cameraConsent:true});
  assert.equal(controller.calibrated, true);
  await new Promise(resolve => setTimeout(resolve, 40));
  video.currentTime = .2;
  await new Promise(resolve => setTimeout(resolve, 40));
  controller.stop();
  const open = samples.find(sample => sample.valid);
  assert.ok(open);
  assert.ok(Math.abs(open.rawScreenXY.x - 600) < 1e-9 && Math.abs(open.rawScreenXY.y - 400) < 1e-9);
  assert.equal(open.gazeSource, 'project-aria-mps-eye-gaze');
  assert.ok(samples.some(sample => !sample.valid));   // the gap at t=0.2
  const count = samples.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(samples.length, count);              // nothing after stop
});
