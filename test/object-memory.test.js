import test from 'node:test';
import assert from 'node:assert/strict';
import {worldPoint, relativeTo, maskCentroid, maskDepthMedian, boxDepthMedian, createObjectMemory} from '../src/spatial/object-memory.js';
import {parseGazeTrack, poseAt, rayAt} from '../src/gaze/gaze-replay.js';

const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0];

test('a ray and an axial depth become a world point through the pose', () => {
  assert.deepEqual(worldPoint(identity, [0, 0, 1], 2), [0, 0, 2]);
  const moved = [1,0,0,5, 0,1,0,1, 0,0,1,0];
  const p = worldPoint(moved, [.6, 0, .8], 2);
  assert.ok(Math.abs(p[0] - 6.5) < 1e-9 && p[1] === 1 && Math.abs(p[2] - 2) < 1e-9);
  assert.equal(worldPoint(identity, [1, 0, 0], 2), null);
  assert.equal(worldPoint(identity, [0, 0, 1], 0), null);
});

test('bearing is measured on the floor plane from the camera forward axis', () => {
  // camera at origin looking along world +x (third column of R = forward)
  const pose = [0,0,1,0, 0,1,0,0, -1,0,0,0];
  assert.deepEqual(relativeTo(pose, [3, 0, 0]), {distanceM:3, bearing:'ahead'});
  assert.equal(relativeTo(pose, [-3, 0, 0]).bearing, 'behind');
  assert.equal(relativeTo(pose, [0, 3, 0]).bearing, 'left');
  assert.equal(relativeTo(pose, [0, -3, 0]).bearing, 'right');
});

test('mask centroid and median depth follow the raster', () => {
  const frame = {width:100, height:100};
  const mask = {bounds:{left:10, top:20, right:30, bottom:40}, width:2, height:2, raster:[1, 0, 0, 1]};
  const c = maskCentroid(mask, frame);
  assert.ok(Math.abs(c.x - .2) < 1e-9 && Math.abs(c.y - .3) < 1e-9 && c.pixels === 2);
  const depth = {width:10, height:10, values:Array(100).fill(2), validMask:Array(100).fill(1)};
  assert.equal(maskDepthMedian({...mask, raster:[1, 1, 1, 1]}, frame, depth), 2);
  assert.equal(maskDepthMedian(mask, frame, depth), null); // fewer than 3 valid cells
  assert.equal(boxDepthMedian({left:0, top:0, right:100, bottom:100}, frame, depth), 2);
});

test('sightings of one label close together merge; other labels and far points do not', () => {
  const memory = createObjectMemory({mergeDistanceM:.5});
  const a = memory.observe({label:'chair', point:[1, 0, 0], t:1});
  const b = memory.observe({label:'chair', point:[1.2, 0, 0], t:2});
  assert.equal(a.id, b.id);
  assert.equal(b.count, 2);
  assert.ok(Math.abs(b.position[0] - 1.1) < 1e-9);
  memory.observe({label:'cup', point:[1.1, 0, 0], t:3});
  memory.observe({label:'chair', point:[5, 0, 0], t:4});
  assert.equal(memory.list().length, 3);
  memory.clear();
  assert.equal(memory.list().length, 0);
});

test('gaze tracks keep camera poses and the fisheye ray grid', () => {
  const track = parseGazeTrack({version:1, samples:[{t:0, x:.5, y:.5, pose:identity}, {t:1, x:.5, y:.5}],
    rays:{size:2, values:[[0, 0, 1], [0, 0, 1], [0, 0, 1], null]}});
  assert.deepEqual(poseAt(track, .05), identity);
  assert.equal(poseAt(track, 1), null);
  assert.deepEqual(rayAt(track, 0, 0), [0, 0, 1]);
  assert.equal(rayAt(track, .9, .9), null);
});

test('SLAM anchors set the metric scale of a monocular depth map', async () => {
  const {depthScale} = await import('../src/spatial/object-memory.js');
  const depth = {width:4, height:4, values:Array(16).fill(3), validMask:Array(16).fill(1)};
  const anchors = Array.from({length:8}, (_, i) => [(i % 4) / 4 + .1, Math.floor(i / 4) / 4 + .1, 1.5]);
  assert.equal(depthScale(anchors, depth), .5);
  assert.equal(depthScale(anchors.slice(0, 3), depth), null);
});

test('a vision-model name replaces the detector class in memory', () => {
  const memory = createObjectMemory();
  const object = memory.observe({label:null, point:[0, 0, 0], t:0});
  assert.equal(memory.rename(object.id, 'gray suitcase'), true);
  assert.equal(memory.list()[0].label, 'gray suitcase');
  assert.equal(memory.rename('missing', 'x'), false);
});

test('recalled objects keep their place and count as seen again when a sighting merges', () => {
  const memory = createObjectMemory();
  memory.seed([{label:'gray sofa', position:[1, 2, 0], count:3}], 'Walking through the house');
  assert.equal(memory.list()[0].recalled, true);
  assert.equal(memory.list()[0].seenAgain, false);
  memory.observe({label:null, point:[1.1, 2, 0], t:5});
  assert.equal(memory.list().length, 1);
  assert.equal(memory.list()[0].seenAgain, true);
  assert.equal(memory.list()[0].count, 4);
});
