import test from 'node:test';
import assert from 'node:assert/strict';
import {assertManifestHash,baselineIds,canonicalJson,conditionSpecs,factorialCells,manifestHash,requiredConditions,v1Conditions,v2Conditions,validateManifest} from '../src/evaluation/manifest.js';

const primary={candidate:'depth_context',reference:'sam_object_context'};
const manifest=()=>({
 schemaVersion:1,kind:'prometheus_study_manifest',studyId:'synthetic-study',thresholdVersion:'thr-1',
 conditions:[...v2Conditions],horizons:[1000,3000],
 endpoints:{next_look_onset:{definition:'first_fixation_onset_in_window',minFixationMs:100},next_interaction:{definition:'first_user_interaction_in_window'}},
 primaryEndpoint:{endpoint:'next_look_onset',horizonMs:3000,metric:'anticipation_success'},primaryContrast:{...primary},
 practicalDelta:.05,noninferiorityMargins:{coverage:.1,deadlineAccuracy:.1},coverageFloor:.5,deadlineMs:800,maxResultAgeMs:1500,
 samplePlan:{minSessions:6,minEligibleDecisions:20,maxSessions:12,bootstrapIterations:400,seed:7},stoppingRule:{kind:'fixed_sample'},
 exclusionRules:{sessionEndRule:'censor_when_window_exceeds_session_end',trackingLostRule:'exclude_and_report',gazeQualityMinValidFraction:.8},
 multiplicityPolicy:{method:'holm',alpha:.05,confirmatory:[{...primary}]},
 annotationPolicy:{independentAnnotators:2,lookSource:'known_target_task',interactionSource:'user_input',labelsBoundAfterLedgerClose:true},
 calibration:{bins:10,minSamples:20},controls:{gazeShuffleSeed:'ctl-1',minGazeTimeShiftMs:200}
});
const rejects=(mutate,code='MANIFEST_INVALID')=>{const m=manifest();mutate(m);assert.throws(()=>validateManifest(m),error=>error.code===code);};

test('valid manifest is accepted, frozen and hashed canonically',()=>{
 const validated=validateManifest(manifest());
 assert.ok(Object.isFrozen(validated)&&Object.isFrozen(validated.samplePlan));
 const hash=manifestHash(manifest());
 assert.match(hash,/^[a-f0-9]{64}$/);
 const reordered=Object.fromEntries(Object.entries(manifest()).reverse());
 assert.equal(manifestHash(reordered),hash);
 const changed=manifest();changed.practicalDelta=.04;
 assert.notEqual(manifestHash(changed),hash);
});

test('every audit-required manifest field must be present and unknown fields are rejected',()=>{
 for(const key of ['primaryEndpoint','primaryContrast','practicalDelta','noninferiorityMargins','coverageFloor','deadlineMs','maxResultAgeMs','samplePlan','stoppingRule','exclusionRules','multiplicityPolicy','annotationPolicy','thresholdVersion','horizons','endpoints','conditions','calibration'])rejects(m=>{delete m[key];});
 rejects(m=>{m.extra=1;});
 rejects(m=>{m.samplePlan.extra=1;});
 rejects(m=>{m.annotationPolicy.labelsBoundAfterLedgerClose=false;});
});

test('condition set must contain the nine v1 arms plus the A02/A03 controls; oracle arms are diagnostic only',()=>{
 for(const id of v1Conditions)assert.ok(requiredConditions.includes(id));
 for(const id of ['spatial_memory_context','history_only_matched','sam_bbox_crop','sam_mask_foreground'])assert.ok(requiredConditions.includes(id));
 for(const id of ['oracle_mask','oracle_gaze','oracle_depth'])assert.equal(conditionSpecs[id].diagnostic,true);
 assert.equal(conditionSpecs.depth_context.diagnostic,false);
 assert.equal(Object.keys(factorialCells).length,8);
 for(const id of Object.keys(factorialCells))assert.ok(v2Conditions.includes(id));
 rejects(m=>{m.conditions=m.conditions.filter(c=>c!=='history_only_matched');});
 rejects(m=>{m.conditions.push('not_a_condition');});
 rejects(m=>{m.conditions.push('gaze_crop');});
 const optional=manifest();optional.conditions=optional.conditions.filter(c=>!c.startsWith('oracle_')&&!['depth_history','depth_proactive','history_proactive'].includes(c));
 assert.doesNotThrow(()=>validateManifest(optional));
 // the two matched controls share history but differ in spatial evidence
 assert.deepEqual(conditionSpecs.history_only_matched.kinds,conditionSpecs.spatial_memory_context.kinds.filter(k=>k!=='spatial_memory'));
 assert.equal(conditionSpecs.history_only_matched.matchedTo,'spatial_memory_context');
});

test('diagnostic arms cannot carry a primary or confirmatory claim; baselines only as references',()=>{
 rejects(m=>{m.primaryContrast={candidate:'oracle_depth',reference:'depth_context'};});
 rejects(m=>{m.primaryContrast={candidate:'depth_context',reference:'oracle_depth'};});
 rejects(m=>{m.multiplicityPolicy.confirmatory.push({candidate:'oracle_mask',reference:'sam_mask_foreground'});});
 rejects(m=>{m.primaryContrast={candidate:'baseline_markov',reference:'sam_object_context'};});
 const m=manifest();m.primaryContrast={candidate:'sam_object_context',reference:'baseline_current_hold'};m.multiplicityPolicy.confirmatory=[{...m.primaryContrast}];
 assert.doesNotThrow(()=>validateManifest(m));
 assert.deepEqual([...baselineIds],['baseline_current_hold','baseline_markov']);
 rejects(m=>{m.primaryContrast={candidate:'depth_context',reference:'depth_context'};});
});

test('horizons, endpoints, thresholds and policies are validated',()=>{
 rejects(m=>{m.horizons=[2000];});
 rejects(m=>{m.horizons=[];});
 rejects(m=>{m.horizons=[1000,1000];});
 rejects(m=>{m.primaryEndpoint.horizonMs=5000;});
 rejects(m=>{m.primaryEndpoint.endpoint='next_gaze';});
 rejects(m=>{m.endpoints={};});
 rejects(m=>{m.endpoints.next_look_onset.minFixationMs=0;});
 rejects(m=>{m.practicalDelta=0;});
 rejects(m=>{m.practicalDelta=1.5;});
 rejects(m=>{m.noninferiorityMargins={speed:.1};});
 rejects(m=>{m.noninferiorityMargins={};});
 rejects(m=>{m.coverageFloor=0;});
 rejects(m=>{m.deadlineMs=0;});
 rejects(m=>{m.samplePlan.minSessions=1;});
 rejects(m=>{m.samplePlan.maxSessions=3;});
 rejects(m=>{m.samplePlan.bootstrapIterations=10;});
 rejects(m=>{m.stoppingRule={kind:'sequential_peek'};});
 rejects(m=>{m.multiplicityPolicy.method='bonferroni';});
 rejects(m=>{m.multiplicityPolicy.confirmatory=[{candidate:'gaze_crop',reference:'scene_only'}];});
 rejects(m=>{m.multiplicityPolicy.method='none';m.multiplicityPolicy.confirmatory.push({candidate:'gaze_crop',reference:'scene_only'});});
 rejects(m=>{m.calibration.bins=1;});
 rejects(m=>{m.exclusionRules.sessionEndRule='keep_all';});
 rejects(m=>{m.annotationPolicy.interactionSource='model_output';});
});

test('canonical JSON is key-order independent and refuses non-canonical values',()=>{
 assert.equal(canonicalJson({b:1,a:{d:[2,{z:1,y:2}],c:null}}),'{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
 for(const bad of [{a:undefined},{a:NaN},{a:Infinity},{a:()=>1},{a:new Date()},{a:1n}])assert.throws(()=>canonicalJson(bad),error=>error.code==='NON_CANONICAL_VALUE'||error instanceof TypeError);
});

test('threshold changed after seeing results is detected by hash comparison',()=>{
 const frozen=manifestHash(manifest());
 assert.equal(assertManifestHash(manifest(),frozen),frozen);
 const relaxed=manifest();relaxed.practicalDelta=.01;
 assert.throws(()=>assertManifestHash(relaxed,frozen),error=>error.code==='MANIFEST_HASH_MISMATCH');
 const coverage=manifest();coverage.coverageFloor=.3;
 assert.throws(()=>assertManifestHash(coverage,frozen),error=>error.code==='MANIFEST_HASH_MISMATCH');
 assert.throws(()=>assertManifestHash(manifest(),null),error=>error.code==='MANIFEST_HASH_MISMATCH');
});
