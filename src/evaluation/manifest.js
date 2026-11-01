import {createHash} from 'node:crypto';

export const v1Conditions=Object.freeze(['scene_only','gaze_crop','sam_object_context','depth_context','history_context','proactive_context','depth_history_proactive','gaze_shuffled','gaze_time_shifted']);
const spec=(kinds,extra={})=>Object.freeze({kinds:Object.freeze(kinds),diagnostic:false,...extra});
const base=['scene','gaze_crop','sam_objects'];
export const conditionSpecs=Object.freeze({
 scene_only:spec(['scene']),
 gaze_crop:spec(['scene','gaze_crop']),
 sam_object_context:spec(base),
 depth_context:spec([...base,'depth']),
 history_context:spec([...base,'history']),
 proactive_context:spec([...base,'proactive']),
 depth_history_proactive:spec([...base,'depth','history','proactive']),
 gaze_shuffled:spec(['scene','gaze_crop'],{gazeSource:'shuffled'}),
 gaze_time_shifted:spec(['scene','gaze_crop'],{gazeSource:'timeShifted'}),
 spatial_memory_context:spec([...base,'history','spatial_memory']),
 history_only_matched:spec([...base,'history'],{matchedTo:'spatial_memory_context'}),
 sam_bbox_crop:spec(['scene','gaze_crop','sam_bbox_crop']),
 sam_mask_foreground:spec(['scene','gaze_crop','sam_mask_foreground']),
 oracle_mask:spec(['scene','gaze_crop','oracle_mask'],{diagnostic:true,analog:'sam_mask_foreground'}),
 oracle_gaze:spec(base,{diagnostic:true,gazeSource:'oracle',analog:'sam_object_context'}),
 oracle_depth:spec([...base,'oracle_depth'],{diagnostic:true,analog:'depth_context'}),
 depth_history:spec([...base,'depth','history']),
 depth_proactive:spec([...base,'depth','proactive']),
 history_proactive:spec([...base,'history','proactive'])
});
export const v2Conditions=Object.freeze(Object.keys(conditionSpecs));
export const requiredConditions=Object.freeze([...v1Conditions,'spatial_memory_context','history_only_matched','sam_bbox_crop','sam_mask_foreground']);
// [depth,history,proactive] levels of the 2^3 factorial; interaction is claimable only with all eight cells.
export const factorialCells=Object.freeze({sam_object_context:[0,0,0],depth_context:[1,0,0],history_context:[0,1,0],proactive_context:[0,0,1],depth_history:[1,1,0],depth_proactive:[1,0,1],history_proactive:[0,1,1],depth_history_proactive:[1,1,1]});
export const factorNames=Object.freeze(['depth','history','proactive']);
export const horizonChoices=Object.freeze([1000,3000,5000]);
export const endpointNames=Object.freeze(['next_look_onset','next_interaction']);
export const baselineIds=Object.freeze(['baseline_current_hold','baseline_markov']);
export const noninferiorityMetrics=Object.freeze(['coverage','deadlineAccuracy','endToEndAccuracy']);

export function fail(code,detail){const error=new Error(detail===undefined?code:`${code}: ${detail}`);error.code=code;return error;}

export function canonicalJson(value){
 const walk=v=>{
  if(v===null||typeof v==='string'||typeof v==='boolean')return v;
  if(typeof v==='number'){if(!Number.isFinite(v))throw fail('NON_CANONICAL_VALUE','non-finite number');return v;}
  if(Array.isArray(v))return v.map(walk);
  if(typeof v==='object'){
   const proto=Object.getPrototypeOf(v);if(proto!==Object.prototype&&proto!==null)throw fail('NON_CANONICAL_VALUE','non-plain object');
   return Object.fromEntries(Object.keys(v).sort().map(key=>[key,walk(v[key])]));
  }
  throw fail('NON_CANONICAL_VALUE',typeof v);
 };
 return JSON.stringify(walk(value));
}
export const sha256Hex=value=>createHash('sha256').update(value).digest('hex');

const idPattern=/^[A-Za-z0-9_-]{1,64}$/;
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(o,keys)=>isObject(o)&&Object.keys(o).length===keys.length&&keys.every(key=>Object.hasOwn(o,key));
const uint=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isInteger(v)&&v>=min&&v<=max;
const ratio=(v,lo,hi,loOpen=false)=>Number.isFinite(v)&&(loOpen?v>lo:v>=lo)&&v<=hi;
const manifestKeys=['schemaVersion','kind','studyId','thresholdVersion','conditions','horizons','endpoints','primaryEndpoint','primaryContrast','practicalDelta','noninferiorityMargins','coverageFloor','deadlineMs','maxResultAgeMs','samplePlan','stoppingRule','exclusionRules','multiplicityPolicy','annotationPolicy','calibration','controls'];

function deepFreeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const key of Object.keys(value))deepFreeze(value[key]);}return value;}

export function validateManifest(input){
 const bad=detail=>{throw fail('MANIFEST_INVALID',detail);};
 if(!exact(input,manifestKeys))bad('fields');
 const m=structuredClone(input);
 if(m.schemaVersion!==1||m.kind!=='prometheus_study_manifest'||!idPattern.test(m.studyId)||!idPattern.test(m.thresholdVersion))bad('identity');
 if(!Array.isArray(m.conditions)||new Set(m.conditions).size!==m.conditions.length||m.conditions.some(c=>!Object.hasOwn(conditionSpecs,c))||requiredConditions.some(c=>!m.conditions.includes(c)))bad('conditions');
 if(!Array.isArray(m.horizons)||!m.horizons.length||new Set(m.horizons).size!==m.horizons.length||m.horizons.some(h=>!horizonChoices.includes(h)))bad('horizons');
 if(!isObject(m.endpoints)||!Object.keys(m.endpoints).length||Object.keys(m.endpoints).some(k=>!endpointNames.includes(k)))bad('endpoints');
 if(m.endpoints.next_look_onset!==undefined&&(!exact(m.endpoints.next_look_onset,['definition','minFixationMs'])||m.endpoints.next_look_onset.definition!=='first_fixation_onset_in_window'||!uint(m.endpoints.next_look_onset.minFixationMs,1,5000)))bad('endpoints.next_look_onset');
 if(m.endpoints.next_interaction!==undefined&&(!exact(m.endpoints.next_interaction,['definition'])||m.endpoints.next_interaction.definition!=='first_user_interaction_in_window'))bad('endpoints.next_interaction');
 const pe=m.primaryEndpoint;
 if(!exact(pe,['endpoint','horizonMs','metric'])||!Object.hasOwn(m.endpoints,pe.endpoint)||!m.horizons.includes(pe.horizonMs)||pe.metric!=='anticipation_success')bad('primaryEndpoint');
 const arm=(id,{reference})=>m.conditions.includes(id)&&!conditionSpecs[id].diagnostic||(reference&&baselineIds.includes(id));
 const contrast=c=>exact(c,['candidate','reference'])&&arm(c.candidate,{reference:false})&&arm(c.reference,{reference:true})&&c.candidate!==c.reference;
 if(!contrast(m.primaryContrast))bad('primaryContrast (diagnostic arms cannot carry a primary claim)');
 if(!ratio(m.practicalDelta,0,1,true))bad('practicalDelta');
 const nim=m.noninferiorityMargins;
 if(!isObject(nim)||!Object.keys(nim).length||Object.keys(nim).some(k=>!noninferiorityMetrics.includes(k)||!ratio(nim[k],0,1)||nim[k]>=1))bad('noninferiorityMargins');
 if(!ratio(m.coverageFloor,0,1,true)||!uint(m.deadlineMs,1,60000)||!uint(m.maxResultAgeMs,1,600000))bad('coverageFloor/deadlineMs/maxResultAgeMs');
 const sp=m.samplePlan;
 if(!exact(sp,['minSessions','minEligibleDecisions','maxSessions','bootstrapIterations','seed'])||!uint(sp.minSessions,2,100000)||!uint(sp.minEligibleDecisions,1)||!uint(sp.maxSessions,sp.minSessions,100000)||!uint(sp.bootstrapIterations,200,20000)||!uint(sp.seed,0,0xffffffff))bad('samplePlan');
 if(!exact(m.stoppingRule,['kind'])||m.stoppingRule.kind!=='fixed_sample')bad('stoppingRule');
 const ex=m.exclusionRules;
 if(!exact(ex,['sessionEndRule','trackingLostRule','gazeQualityMinValidFraction'])||ex.sessionEndRule!=='censor_when_window_exceeds_session_end'||ex.trackingLostRule!=='exclude_and_report'||!ratio(ex.gazeQualityMinValidFraction,0,1))bad('exclusionRules');
 const mp=m.multiplicityPolicy;
 if(!exact(mp,['method','alpha','confirmatory'])||!['holm','none'].includes(mp.method)||!ratio(mp.alpha,0,.5,true)||!Array.isArray(mp.confirmatory)||!mp.confirmatory.length||mp.confirmatory.length>20||!mp.confirmatory.every(contrast)||new Set(mp.confirmatory.map(c=>`${c.candidate}>${c.reference}`)).size!==mp.confirmatory.length||!mp.confirmatory.some(c=>c.candidate===m.primaryContrast.candidate&&c.reference===m.primaryContrast.reference)||(mp.method==='none'&&mp.confirmatory.length!==1))bad('multiplicityPolicy');
 const ap=m.annotationPolicy;
 if(!exact(ap,['independentAnnotators','lookSource','interactionSource','labelsBoundAfterLedgerClose'])||!uint(ap.independentAnnotators,1,10)||!['known_target_task','independent_sensor'].includes(ap.lookSource)||!['user_input','independent_video'].includes(ap.interactionSource)||ap.labelsBoundAfterLedgerClose!==true)bad('annotationPolicy');
 if(!exact(m.calibration,['bins','minSamples'])||!uint(m.calibration.bins,2,50)||!uint(m.calibration.minSamples,1))bad('calibration');
 if(!exact(m.controls,['gazeShuffleSeed','minGazeTimeShiftMs'])||!idPattern.test(m.controls.gazeShuffleSeed)||!uint(m.controls.minGazeTimeShiftMs,1))bad('controls');
 return deepFreeze(m);
}

export function manifestHash(manifest){return sha256Hex(canonicalJson(validateManifest(manifest)));}

// Scoring must refuse a report whose manifest differs from the one frozen in the ledger header.
export function assertManifestHash(manifest,frozenSha256){
 const actual=manifestHash(manifest);
 if(typeof frozenSha256!=='string'||actual!==frozenSha256)throw fail('MANIFEST_HASH_MISMATCH',`manifest ${actual} != frozen ${frozenSha256}`);
 return actual;
}
