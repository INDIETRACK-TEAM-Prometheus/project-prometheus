import test from 'node:test';
import assert from 'node:assert/strict';
import {intersectBinocularRaysWithScreen, closestApproachOfRays, vergenceDepthUncertainty, binocularScreenUncertainty} from '../src/gaze/binocular-screen.js';

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

// ---- G1-D closest approach, vergence, and uncertainty propagation ---------------------------------------------
const norm3 = v => Math.hypot(...v), dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], sub3 = (a, b) => a.map((v, i) => v - b[i]);
const eyes = {l:[-0.032,0,0], r:[0.032,0,0]};
const fixate = target => ({leftRay:rayTo(eyes.l,target), rightRay:rayTo(eyes.r,target)});
const onAxis = {originM:eyes.l, direction:[0,0,1]};

test('closest approach recovers a fixation point, vergence angle and depth for exact rays', () => {
  const target = [0.02,0.01,0.6], result = closestApproachOfRays(fixate(target));
  assert.equal(result.status,'ok'); assert.equal(result.reason,null);
  assert.ok(norm3(sub3(result.midpointM,target)) < 1e-12); assert.ok(result.rayDistanceM < 1e-12);
  assert.ok(Math.abs(result.vergenceDepthM - norm3(target)) < 1e-12);
  const dl = sub3(target,eyes.l), dr = sub3(target,eyes.r);
  assert.ok(Math.abs(result.vergenceRad - Math.acos(dot3(dl,dr) / (norm3(dl) * norm3(dr)))) < 1e-12);
  assert.ok(Math.abs(result.leftRangeM - norm3(dl)) < 1e-12 && Math.abs(result.rightRangeM - norm3(dr)) < 1e-12);
  assert.equal(result.depthKind,'binocular_vergence');
});

test('closest approach of skew rays gives a segment perpendicular to both and reports ray distance', () => {
  const skew = {leftRay:{originM:eyes.l,direction:[0.032,0.004,0.6]}, rightRay:{originM:eyes.r,direction:[-0.032,-0.004,0.6]}};
  const result = closestApproachOfRays(skew,{maxRayDistanceM:0.05});
  assert.equal(result.status,'ok');
  const seg = sub3(result.leftPointM,result.rightPointM);
  assert.ok(Math.abs(dot3(seg,[0.032,0.004,0.6])) < 1e-12); assert.ok(Math.abs(dot3(seg,[-0.032,-0.004,0.6])) < 1e-12);
  assert.ok(result.rayDistanceM > 0.001 && Math.abs(result.rayDistanceM - norm3(seg)) < 1e-15);
  assert.ok(result.midpointM.every((v,i) => Math.abs(v - (result.leftPointM[i] + result.rightPointM[i]) / 2) < 1e-15));
  assert.equal(closestApproachOfRays(skew,{maxRayDistanceM:1e-4}).reason,'excessive_ray_disparity');
});

test('closest approach reports unavailable with a reason: parallel, near-parallel, behind origin, disparity, depth range, invalid', () => {
  assert.equal(closestApproachOfRays({leftRay:onAxis,rightRay:{originM:eyes.r,direction:[0,0,1]}}).reason,'rays_near_parallel');
  const near = closestApproachOfRays(fixate([0,0,20]));
  assert.equal(near.reason,'rays_near_parallel'); assert.ok(near.vergenceRad > 0 && near.vergenceRad < 0.5 * Math.PI / 180);
  assert.equal(near.midpointM,null); assert.equal(near.vergenceDepthM,null);
  const diverging = closestApproachOfRays({leftRay:{originM:eyes.l,direction:[-0.1,0,1]},rightRay:{originM:eyes.r,direction:[0.1,0,1]}});
  assert.equal(diverging.reason,'closest_point_behind_origin'); assert.equal(diverging.midpointM,null);
  assert.equal(closestApproachOfRays({leftRay:{originM:eyes.l,direction:[0.032,0.2,0.6]},rightRay:{originM:eyes.r,direction:[-0.032,-0.2,0.6]}}).reason,'excessive_ray_disparity');
  assert.equal(closestApproachOfRays(fixate([0,0,6])).reason,'vergence_depth_out_of_range');
  assert.equal(closestApproachOfRays(fixate([0,0,0.03]),{minVergenceRad:0}).reason,'vergence_depth_out_of_range');
  assert.equal(closestApproachOfRays({leftRay:{originM:[NaN,0,0],direction:[0,0,1]},rightRay:onAxis}).reason,'invalid_left_ray');
  assert.equal(closestApproachOfRays({leftRay:onAxis,rightRay:{originM:eyes.r,direction:[0,0,0]}}).reason,'invalid_right_ray');
  assert.equal(closestApproachOfRays().reason,'invalid_left_ray');
  assert.throws(() => closestApproachOfRays(fixate([0,0,1]),{maxRayDistanceM:-1}),TypeError);
});

test('screen intersection keeps screen-surface depth and vergence depth as separate fields', () => {
  const at = target => intersectBinocularRaysWithScreen({...fixate(target),screen});
  const near = at([0,0,0.8]);
  assert.equal(near.vergence.status,'ok'); assert.ok(Math.abs(near.vergence.vergenceDepthM - 0.8) < 1e-12);
  assert.ok(Math.abs(near.screenDepthM - 1.5) < 0.02); assert.ok(Math.abs(near.screenDepthM - near.vergence.vergenceDepthM) > 0.5);
  assert.ok(near.binocularDisagreementM > 0.05);
  const onScreen = at([0.1,0.02,1.5]);
  assert.ok(Math.abs(onScreen.vergence.vergenceDepthM - norm3([0.1,0.02,1.5])) < 1e-12);
  const parallel = {originM:[0,0,0],direction:[1,0,0]};
  assert.equal(intersectBinocularRaysWithScreen({leftRay:parallel,rightRay:parallel,screen}).vergence,undefined);
});

test('vergence depth uncertainty: Monte Carlo and Jacobian agree with the small-angle analytic std', () => {
  const rays = fixate([0,0,0.6]), sigma = 0.2 * Math.PI / 180, baseline = 0.064;
  const analytic = 0.6 ** 2 / baseline * Math.SQRT2 * sigma;
  const options = {...rays,leftSigmaRad:sigma,rightSigmaRad:sigma};
  const jac = vergenceDepthUncertainty({...options,method:'jacobian'}), mc = vergenceDepthUncertainty({...options,samples:20000,seed:5});
  assert.equal(jac.status,'ok'); assert.equal(mc.status,'ok');
  assert.ok(Math.abs(jac.stdM - analytic) / analytic < 0.05,`${jac.stdM} vs ${analytic}`);
  assert.ok(Math.abs(mc.stdM - jac.stdM) / jac.stdM < 0.1,`${mc.stdM} vs ${jac.stdM}`);
  assert.ok(Math.abs(mc.depthM - 0.6) < 1e-12); assert.ok(mc.p05M < mc.meanM && mc.meanM < mc.p95M); assert.ok(mc.validFraction > 0.99);
  assert.deepEqual(vergenceDepthUncertainty({...options,seed:5}),vergenceDepthUncertainty({...options,seed:5}));
  const bigger = vergenceDepthUncertainty({...rays,leftSigmaRad:2 * sigma,rightSigmaRad:2 * sigma,method:'jacobian'});
  assert.ok(Math.abs(bigger.stdM / jac.stdM - 2) < 0.01);
  assert.ok(vergenceDepthUncertainty({...rays,leftSigmaRad:0,rightSigmaRad:0,originSigmaM:0.002,method:'jacobian'}).stdM > 0);
  assert.equal(vergenceDepthUncertainty({...rays,leftSigmaRad:0,rightSigmaRad:0,method:'jacobian'}).stdM,0);
  // The tangent axes are [vertical-ish, horizontal-ish] here: pitch noise barely moves vergence depth, yaw noise carries it.
  const pitchOnly = vergenceDepthUncertainty({...rays,leftSigmaRad:[sigma,0],rightSigmaRad:[sigma,0],method:'jacobian'});
  const yawOnly = vergenceDepthUncertainty({...rays,leftSigmaRad:[0,sigma],rightSigmaRad:[0,sigma],method:'jacobian'});
  assert.ok(pitchOnly.stdM < 0.02 * jac.stdM); assert.ok(Math.abs(yawOnly.stdM - jac.stdM) / jac.stdM < 0.02);
});

test('far or noisy fixations are flagged uncertain/unavailable instead of given a confident depth', () => {
  const far = fixate([0,0,3]), sigma = 0.5 * Math.PI / 180;
  const jac = vergenceDepthUncertainty({...far,leftSigmaRad:sigma,rightSigmaRad:sigma,method:'jacobian'});
  assert.equal(jac.status,'uncertain'); assert.equal(jac.reason,'depth_relative_std_exceeds_limit'); assert.ok(jac.relativeStd > 0.25);
  const mc = vergenceDepthUncertainty({...far,leftSigmaRad:sigma,rightSigmaRad:sigma});
  assert.notEqual(mc.status,'ok'); assert.ok(['uncertain','unavailable'].includes(mc.status));
  const hopeless = vergenceDepthUncertainty({...fixate([0,0,4]),leftSigmaRad:0.03,rightSigmaRad:0.03});
  assert.equal(hopeless.status,'unavailable'); assert.equal(hopeless.reason,'depth_mostly_unavailable_under_noise'); assert.ok(hopeless.validFraction < 0.9);
  const parallel = vergenceDepthUncertainty({leftRay:onAxis,rightRay:{originM:eyes.r,direction:[0,0,1]},leftSigmaRad:0.001,rightSigmaRad:0.001});
  assert.equal(parallel.status,'unavailable'); assert.equal(parallel.reason,'rays_near_parallel'); assert.equal(parallel.depthM,null);
  assert.throws(() => vergenceDepthUncertainty({...far,leftSigmaRad:-1,rightSigmaRad:0}),TypeError);
  assert.throws(() => vergenceDepthUncertainty({...far,leftSigmaRad:[1],rightSigmaRad:0}),TypeError);
  assert.throws(() => vergenceDepthUncertainty({...far,leftSigmaRad:0,rightSigmaRad:0,method:'nope'}),TypeError);
  assert.throws(() => vergenceDepthUncertainty({...far,leftSigmaRad:0,rightSigmaRad:0,samples:10}),TypeError);
});

test('screen-hit uncertainty scales with direction noise and range, and fails closed for unusable rays', () => {
  const rays = fixate([0.1,0.02,1.5]), deg = Math.PI / 180;
  const run = sigma => binocularScreenUncertainty({...rays,screen,leftSigmaRad:sigma,rightSigmaRad:sigma,samples:6000,seed:3});
  const a = run(0.2 * deg), b = run(0.4 * deg);
  assert.equal(a.status,'ok');
  const expectedX = 1.5 * Math.tan(0.2 * deg) / screen.widthM / Math.SQRT2, expectedY = 1.5 * Math.tan(0.2 * deg) / screen.heightM / Math.SQRT2;
  assert.ok(Math.abs(a.stdNormalized.x - expectedX) / expectedX < 0.12,`${a.stdNormalized.x} vs ${expectedX}`);
  assert.ok(Math.abs(a.stdNormalized.y - expectedY) / expectedY < 0.12);
  assert.ok(Math.abs(a.stdM.x - a.stdNormalized.x * screen.widthM) < 1e-15);
  assert.ok(Math.abs(b.stdNormalized.x / a.stdNormalized.x - 2) < 0.05);
  assert.deepEqual(run(0.01),run(0.01));
  const parallel = {originM:[0,0,0],direction:[1,0,0]};
  assert.equal(binocularScreenUncertainty({leftRay:parallel,rightRay:parallel,screen,leftSigmaRad:0.01,rightSigmaRad:0.01}).status,'unavailable');
  assert.throws(() => binocularScreenUncertainty({...rays,screen,leftSigmaRad:'x',rightSigmaRad:0}),TypeError);
});
