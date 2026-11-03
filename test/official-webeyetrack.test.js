import test from 'node:test';
import assert from 'node:assert/strict';
import {officialSample} from '../src/gaze/official-webeyetrack.js';

test('official WebEyeTrack results map to screen points like the demo app', () => {
  const viewport = {width:1000, height:500};
  const open = officialSample({normPog:[.25, -.5], gazeState:'open', durations:{total:4}}, {frameId:3, receivedAt:120, viewport});
  assert.equal(open.valid, true);
  assert.deepEqual(open.features, [.75, 0]);
  assert.deepEqual(open.rawScreenXY, {x:750, y:0});
  assert.equal(open.frameId, 3);
  const closed = officialSample({normPog:[0, 0], gazeState:'closed'}, {frameId:4, receivedAt:130, viewport});
  assert.equal(closed.valid, false);
  assert.equal(closed.invalidReason, 'eyes_closed');
  const none = officialSample(null, {frameId:5, receivedAt:140, viewport});
  assert.equal(none.valid, false);
  assert.equal(none.invalidReason, 'face_not_detected');
  const beyond = officialSample({normPog:[.9, .7], gazeState:'open'}, {frameId:6, receivedAt:150, viewport});
  assert.deepEqual(beyond.features, [1, 1]);
  assert.ok(beyond.rawScreenXY.x < 1000 && beyond.rawScreenXY.y < 500);
});

test('clicks on controls are never counted as gaze calibration points', async () => {
  const {NON_GAZE_CLICK_TARGETS} = await import('../src/gaze/official-webeyetrack.js');
  for (const tag of ['button', 'input', 'label', 'select', 'a', 'summary']) assert.ok(NON_GAZE_CLICK_TARGETS.split(',').includes(tag), tag);
  assert.equal(NON_GAZE_CLICK_TARGETS.split(',').includes('canvas'), false);
});
