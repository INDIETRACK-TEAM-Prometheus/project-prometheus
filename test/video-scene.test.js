import test from 'node:test';
import assert from 'node:assert/strict';
import {fitVideo} from '../src/spatial/video-scene.js';

test('video is letterboxed or pillarboxed inside the canvas without distortion', () => {
  assert.deepEqual(fitVideo(1920, 1080, 1920, 1080), {x:1, y:1});
  const wideCanvas = fitVideo(1280, 720, 2000, 720);       // pillarbox: full height, narrower width
  assert.equal(wideCanvas.y, 1); assert.ok(Math.abs(wideCanvas.x - .64) < 1e-12);
  const tallCanvas = fitVideo(1280, 720, 1280, 1440);      // letterbox: full width, half height
  assert.equal(tallCanvas.x, 1); assert.ok(Math.abs(tallCanvas.y - .5) < 1e-12);
  assert.equal(fitVideo(0, 720, 100, 100), null);
});
