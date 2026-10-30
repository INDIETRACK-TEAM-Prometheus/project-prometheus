import test from 'node:test';
import assert from 'node:assert/strict';
import {intersectBinocularRaysWithScreen} from '../src/gaze/binocular-screen.js';

const screen = {centerM:[0,0,1.5],right:[1,0,0],up:[0,1,0],widthM:1,heightM:0.6};
const rayTo = (originM, targetM) => ({originM, direction:targetM.map((value, i) => value - originM[i])});

test('projects two measured rays to their common screen fixation', () => {
  const target = [0.12,0.03,1.5];
  const result = intersectBinocularRaysWithScreen({
    leftRay:rayTo([-0.032,0,0],target),
    rightRay:rayTo([0.032,0,0],target),
    screen
  });
  assert.equal(result.status,'ok');
  assert.ok(Math.abs(result.normalized.x - 0.62) < 1e-12);
  assert.ok(Math.abs(result.normalized.y - 0.45) < 1e-12);
  assert.ok(result.binocularDisagreementM < 1e-12);
});

test('reports parallel rays as unavailable', () => {
  const parallel = {originM:[0,0,0],direction:[1,0,0]};
  assert.deepEqual(intersectBinocularRaysWithScreen({leftRay:parallel,rightRay:parallel,screen}), {
    status:'unavailable',pointM:null,normalized:null,reason:'left_ray_parallel_to_screen'
  });
});

test('rejects screen intersections behind the eyes', () => {
  const backward = {originM:[0,0,0],direction:[0,0,-1]};
  assert.equal(intersectBinocularRaysWithScreen({leftRay:backward,rightRay:backward,screen}).reason,'left_screen_intersection_not_forward');
});

test('reports binocular disagreement and does not clamp off-screen projections', () => {
  const result = intersectBinocularRaysWithScreen({
    leftRay:rayTo([-0.032,0,0],[0.7,0,1.5]),
    rightRay:rayTo([0.032,0,0],[0.7,0,1.5]),
    screen
  });
  assert.equal(result.status,'outside_screen');
  assert.ok(result.normalized.x > 1);
  assert.ok(result.binocularDisagreementM < 1e-12);
});

test('screen distance is explicit and changes projection for the same measured rays', () => {
  const target = [0.12,0.03,1.5];
  const rays = {
    leftRay:rayTo([-0.032,0,0],target),
    rightRay:rayTo([0.032,0,0],target)
  };
  const at = depth => intersectBinocularRaysWithScreen({...rays,screen:{...screen,centerM:[0,0,depth]}});
  assert.ok(Math.abs(at(1.5).normalized.x - at(1).normalized.x) > 0.03);
  assert.ok(Math.abs(at(1.5).normalized.x - at(2).normalized.x) > 0.03);
});
