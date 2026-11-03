import test from 'node:test';
import assert from 'node:assert/strict';
import {rankGazeTargets} from '../src/spatial/gaze-target.js';
import {createFixationBuffer} from '../src/gaze/fixation.js';

const frame = {width:1000, height:500};
const boxes = [
  {objectId:'left', bounds:{left:100, top:100, right:300, bottom:400}},
  {objectId:'right', bounds:{left:700, top:100, right:900, bottom:400}},
  {objectId:'small-inside-left', bounds:{left:150, top:150, right:200, bottom:200}}
];

test('the object containing the fixation wins, the smaller box first when boxes overlap', () => {
  assert.deepEqual(rankGazeTargets({x:.175, y:.35}, boxes, frame).map(entry => entry.objectId), ['small-inside-left', 'left']);
  assert.deepEqual(rankGazeTargets({x:.25, y:.5}, boxes, frame).map(entry => entry.objectId), ['left', 'small-inside-left']);   // the small box is 6% of the diagonal away, inside the radius
});

test('a fixation just outside an object still picks it within the radius, and nothing beyond it', () => {
  const near = rankGazeTargets({x:.33, y:.5}, boxes, frame);   // 30 px right of "left"
  assert.equal(near[0].objectId, 'left');
  assert.ok(near[0].distance > 0 && near[0].distance < .03);
  assert.deepEqual(rankGazeTargets({x:.5, y:.95}, boxes, frame), []);   // between and below both, > 12% of the diagonal away
  assert.deepEqual(rankGazeTargets({x:.5, y:.5}, boxes, frame, {radius:.5}).map(entry => entry.objectId).slice(0, 2).sort(), ['left', 'right']);
});

test('invalid input ranks nothing', () => {
  assert.deepEqual(rankGazeTargets(null, boxes, frame), []);
  assert.deepEqual(rankGazeTargets({x:.2, y:.2}, boxes, {width:0, height:1}), []);
  assert.deepEqual(rankGazeTargets({x:.2, y:.2}, [{objectId:'x', bounds:{}}], frame), []);
});

test('the fixation is the median of the recent window and ignores a single outlier', () => {
  const buffer = createFixationBuffer({windowMs:800});
  for (const [x, t] of [[100, 0], [102, 100], [98, 200], [900, 300], [101, 400]]) buffer.add({x, y:50}, t);
  const fix = buffer.estimate(500, {minSamples:3});
  assert.equal(fix.x, 101);
  assert.equal(fix.count, 5);
  assert.equal(buffer.estimate(2000, {minSamples:1}), null);   // all samples are older than the window
  buffer.clear();
  assert.equal(buffer.estimate(500), null);
});
