import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {adapterGaps,buildPromptInput,generateComparison,parseProviderResult,planComparison,prepareDecision,toReasonerAdapterInput,validateDecision,verifyLedgerText,GENESIS_HASH,chainLine} from '../src/evaluation/generator.js';
import {canonicalJson,conditionSpecs,v2Conditions,manifestHash} from '../src/evaluation/manifest.js';
import {main as generateMain} from '../scripts/generate-comparison.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const pngMagic=Buffer.from([137,80,78,71,13,10,26,10]);
const png=tag=>Buffer.concat([pngMagic,Buffer.from(`synthetic-${tag}`)]);
const image=(id,tag,t=10)=>{const bytes=png(tag);return {id,sha256:sha(bytes),observedAtMs:t,processedAtMs:t+1,mediaType:'image/png',base64:bytes.toString('base64')};};
const json=(id,body,t=10)=>{const text=JSON.stringify(body);return {id,sha256:sha(text),observedAtMs:t,processedAtMs:t+1,mediaType:'application/json',text};};
const objs=['o1','o2','o3'];
const bounds=i=>({left:10*i,top:10,right:10*i+8,bottom:30});
const gaze=(sampleId,t,tag)=>({sampleId,x:.4,y:.5,observedAtMs:t,processedAtMs:t+1,crop:image(`crop-${sampleId}`,tag??sampleId,t),rect:{left:.3,top:.4,right:.5,bottom:.6}});
const maskList=tag=>objs.map((objectId,i)=>({objectId,areaPx:100+i,bounds:bounds(i),mask:image(`mask-${tag}-${objectId}`,`${tag}-${objectId}`)}));
const crops=(tag,size=16)=>objs.map(objectId=>({objectId,widthPx:size,heightPx:size,areaPx:size*size,artifact:image(`crop-${tag}-${objectId}`,`${tag}-${objectId}`)}));

function decision(id='dec1',{cutoff=100}={}){
 return {
  decisionId:id,participantId:'p1',sessionId:'s1',frameId:`frame-${id}`,observedUntilMs:cutoff,issuedAtMs:cutoff+20,renderLatencyMs:15,
  candidates:objs.map((objectId,i)=>({objectId,bounds:bounds(i)})),
  scene:image(`scene-${id}`,`scene-${id}`,cutoff-20),
  gaze:gaze('g3',cutoff-10),
  gazeControls:{shuffled:gaze('g1',cutoff-60),timeShifted:gaze('g0',cutoff-60,'shift'),oracle:gaze('gOracle',cutoff-10,'oracle')},
  samObjects:maskList('sam'),
  samInputs:{bboxCrop:crops('bbox'),maskForeground:crops('fg')},
  depth:{source:'depth_anything_v2_metric',artifact:json('depth-1',{objects:[{objectId:'o1',medianM:1.2,iqrM:.1,validFraction:.9}]})},
  history:[{id:'h1',text:'fixated o2 for 400 ms',observedAtMs:cutoff-80,processedAtMs:cutoff-79},{id:'h2',text:'fixated o1 for 300 ms',observedAtMs:cutoff-40,processedAtMs:cutoff-39}],
  spatialMemory:[{id:'sm1',objectId:'o3',x:1.5,y:-.2,z:null,stateVersion:4,relations:[{relation:'left_of',objectId:'o1'}],retrieval:{method:'last_seen',rank:0},observedAtMs:cutoff-70,processedAtMs:cutoff-69}],
  proactive:[{id:'pro1',text:'user usually reaches for o2 next',observedAtMs:cutoff-30,processedAtMs:cutoff-29}],
  oracle:{mask:maskList('oracle'),depth:{source:'engine_ground_truth',artifact:json('oracle-depth',{objects:[{objectId:'o1',medianM:1.25}]})}}
 };
}
const base=()=>({
 schemaVersion:1,kind:'prometheus_study_manifest',studyId:'gen-study',thresholdVersion:'thr-1',
 conditions:[...v2Conditions],horizons:[1000],
 endpoints:{next_look_onset:{definition:'first_fixation_onset_in_window',minFixationMs:100}},
 primaryEndpoint:{endpoint:'next_look_onset',horizonMs:1000,metric:'anticipation_success'},primaryContrast:{candidate:'depth_context',reference:'sam_object_context'},
 practicalDelta:.05,noninferiorityMargins:{coverage:.1},coverageFloor:.5,deadlineMs:800,maxResultAgeMs:1500,
 samplePlan:{minSessions:6,minEligibleDecisions:20,maxSessions:12,bootstrapIterations:400,seed:7},stoppingRule:{kind:'fixed_sample'},
 exclusionRules:{sessionEndRule:'censor_when_window_exceeds_session_end',trackingLostRule:'exclude_and_report',gazeQualityMinValidFraction:.8},
 multiplicityPolicy:{method:'holm',alpha:.05,confirmatory:[{candidate:'depth_context',reference:'sam_object_context'}]},
 annotationPolicy:{independentAnnotators:2,lookSource:'known_target_task',interactionSource:'user_input',labelsBoundAfterLedgerClose:true},
 calibration:{bins:10,minSamples:20},controls:{gazeShuffleSeed:'ctl-1',minGazeTimeShiftMs:20}
});
const okProvider=async()=>({scenarios:[],nextGaze:{rankedTargetIds:['o2','o1']},provider:'Meta',model:'muse-spark-1.3',requestId:'req_1',latencyMs:5,usage:{inputTokens:10,outputTokens:5,cachedInputTokens:0},estimatedCostUsd:0.002});

async function withTmp(fn){const dir=await mkdtemp(join(tmpdir(),'prom-gen-'));try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
const leak=(mutate,code='LABEL_LEAK')=>{const d=decision();mutate(d);assert.throws(()=>validateDecision(d),error=>error.code===code);};

test('dry-run planning is deterministic, hashes every prompt and never needs a provider',async()=>{
 const decisions=[decision('dec1'),decision('dec2',{cutoff:200})];
 const a=await planComparison({manifest:base(),decisions}),b=await planComparison({manifest:base(),decisions:structuredClone(decisions)});
 assert.equal(a.providerCalled,false);
 assert.equal(a.cells.length,2*1*1*v2Conditions.length);
 assert.deepEqual(a.cells.map(c=>c.promptSha256),b.cells.map(c=>c.promptSha256));
 assert.equal(new Set(a.cells.filter(c=>c.decisionId==='dec1').map(c=>c.promptSha256)).size>10,true);
 assert.equal(a.manifestSha256,manifestHash(base()));
 const sceneOnly=a.cells.find(c=>c.condition==='scene_only'&&c.decisionId==='dec1');
 assert.deepEqual(sceneOnly.evidenceKinds,['scene']);
});

test('condition inputs: A02 matched history, A03 matched crops, oracle arms flagged, controls recorded',async()=>{
 const prepared=await prepareDecision(decision());const m=base();
 const build=c=>buildPromptInput(prepared,c,1000,'next_look_onset',m);
 const kinds=c=>build(c).promptInput.evidence.map(e=>e.kind);
 assert.deepEqual(kinds('scene_only'),['scene']);
 assert.equal(build('scene_only').meta.gazeSourceSampleId,null);
 assert.ok(kinds('spatial_memory_context').includes('spatial_memory'));
 assert.ok(!kinds('history_only_matched').includes('spatial_memory'));
 const hist=c=>build(c).promptInput.evidence.filter(e=>e.kind==='history');
 assert.deepEqual(hist('history_only_matched'),hist('spatial_memory_context'));
 assert.equal(hist('history_only_matched').length,2);
 const spatial=build('spatial_memory_context').promptInput.evidence.find(e=>e.kind==='spatial_memory');
 assert.deepEqual(JSON.parse(spatial.text),{objectId:'o3',relations:[{objectId:'o1',relation:'left_of'}],retrieval:{method:'last_seen',rank:0},stateVersion:4,x:1.5,y:-.2,z:null});
 const bbox=build('sam_bbox_crop'),fg=build('sam_mask_foreground');
 assert.equal(bbox.promptInput.images.length,3);assert.equal(fg.promptInput.images.length,3);
 const sizes=x=>JSON.parse(x.promptInput.evidence.find(e=>e.kind.startsWith('sam_')&&e.kind!=='sam_objects').text).objects.map(o=>[o.objectId,o.widthPx,o.heightPx,o.areaPx]);
 assert.deepEqual(sizes(bbox),sizes(fg));
 assert.notEqual(bbox.promptInput.images[0].dataUrl,fg.promptInput.images[0].dataUrl);
 assert.ok(kinds('depth_context').includes('depth'));
 assert.equal(build('depth_context').promptInput.evidence.find(e=>e.kind==='depth').text,JSON.stringify({objects:[{objectId:'o1',medianM:1.2,iqrM:.1,validFraction:.9}]}));
 for(const c of ['oracle_mask','oracle_depth','oracle_gaze'])assert.equal(conditionSpecs[c].diagnostic,true);
 assert.ok(build('oracle_mask').promptInput.evidence.some(e=>e.kind==='oracle_mask'&&e.causalStatus==='oracle_diagnostic'));
 assert.ok(build('oracle_depth').promptInput.evidence.some(e=>e.kind==='oracle_depth'&&e.causalStatus==='oracle_diagnostic'));
 assert.deepEqual(build('oracle_gaze').meta.gazeTransform,{method:'oracle_gaze'});
 assert.equal(build('oracle_gaze').meta.gazeSourceSampleId,'gOracle');
  assert.equal(build('gaze_shuffled').meta.gazeSourceSampleId,'g1');
 assert.deepEqual(build('gaze_shuffled').meta.gazeTransform,{method:'shuffle',seed:'ctl-1'});
 assert.deepEqual(build('gaze_time_shifted').meta.gazeTransform,{method:'backward_time_shift',shiftMs:50});
 assert.equal(build('gaze_time_shifted').meta.gazeSourceSampleId,'g0');
 assert.equal(build('gaze_crop').promptInput.task,'next_look_onset');
 // depth/history/proactive factorial arms add exactly their own evidence
 assert.deepEqual([...new Set(kinds('depth_proactive'))].sort(),['depth','gaze_crop','proactive','sam_objects','scene']);
 assert.deepEqual([...new Set(kinds('history_proactive'))].sort(),['gaze_crop','history','proactive','sam_objects','scene']);
});

test('A03 refuses bbox/foreground inputs that differ in size or area',async()=>{
 const d=decision();d.samInputs.maskForeground=crops('fg',24);
 const prepared=await prepareDecision(d);
 assert.throws(()=>buildPromptInput(prepared,'sam_bbox_crop',1000,'next_look_onset',base()),error=>error.code==='CROP_MISMATCH');
 assert.throws(()=>buildPromptInput(prepared,'sam_mask_foreground',1000,'next_look_onset',base()),error=>error.code==='CROP_MISMATCH');
});

test('labels and future annotations cannot enter prompt inputs',()=>{
 leak(d=>{d.nextTargetLabel={targetId:'o1'};});
 leak(d=>{d.candidates[0].groundTruth=true;});
 leak(d=>{d.history[0].future='o2';});
 leak(d=>{d.samObjects[0].label='cup';});
 leak(d=>{d.proactive[0].answer='o1';});
 leak(d=>{d.oracle.target='o1';});
 leak(d=>{d.gaze.annotation='x';});
 leak(d=>{d.spatialMemory[0].relations[0].outcome='x';});
 assert.doesNotThrow(()=>validateDecision(decision()));
});

test('inputs observed or processed after the cutoff are rejected',()=>{
 leak(d=>{d.history[0].processedAtMs=d.observedUntilMs+1;},'FUTURE_INPUT');
 leak(d=>{d.scene.observedAtMs=d.observedUntilMs+1;d.scene.processedAtMs=d.observedUntilMs+2;},'FUTURE_INPUT');
 leak(d=>{d.gazeControls.shuffled.processedAtMs=d.observedUntilMs+5;},'FUTURE_INPUT');
 leak(d=>{d.depth.artifact.processedAtMs=d.observedUntilMs+1;},'FUTURE_INPUT');
 leak(d=>{d.issuedAtMs=d.observedUntilMs-1;},'DECISION_INVALID');
 leak(d=>{d.unexpected=1;},'DECISION_INVALID');
});

test('every artifact is re-hashed; a changed file, bad inline bytes or path escape is refused',async()=>{
 await withTmp(async dir=>{
  const bytes=png('on-disk'),d=decision();
  await writeFile(join(dir,'scene.png'),bytes);
  d.scene={id:'scene-file',sha256:sha(bytes),observedAtMs:80,processedAtMs:81,mediaType:'image/png',path:'scene.png'};
  await prepareDecision(d,{baseDir:dir});
  await writeFile(join(dir,'scene.png'),png('tampered'));
  await assert.rejects(prepareDecision(d,{baseDir:dir}),error=>error.code==='ARTIFACT_HASH_MISMATCH');
  const e=decision();e.scene.sha256=sha('other');
  await assert.rejects(prepareDecision(e),error=>error.code==='ARTIFACT_HASH_MISMATCH');
  const f=decision();f.depth.artifact.text='{"objects":[]}';
  await assert.rejects(prepareDecision(f),error=>error.code==='ARTIFACT_HASH_MISMATCH');
  const g=decision();delete g.scene.base64;g.scene.path='../outside.png';
  await assert.rejects(prepareDecision(g,{baseDir:dir}),error=>error.code==='ARTIFACT_PATH_ESCAPE');
  const notImage=decision();const junk=Buffer.from('not an image');notImage.scene={id:'junk',sha256:sha(junk),observedAtMs:80,processedAtMs:81,mediaType:'image/png',base64:junk.toString('base64')};
  await assert.rejects(prepareDecision(notImage),error=>error.code==='ARTIFACT_INVALID');
  const clash=decision();clash.gaze.crop={...clash.gaze.crop,id:clash.scene.id};
  await assert.rejects(prepareDecision(clash),error=>error.code==='ARTIFACT_ID_CONFLICT');
 });
});

test('generation refuses missing consent, limits or an existing ledger file',async()=>{
 await withTmp(async dir=>{
  const common={manifest:base(),decisions:[decision()],callProvider:okProvider,ledgerPath:join(dir,'l.jsonl'),maxCalls:100,budgetUsd:10,provenance:'synthetic'};
  for(const patch of [{externalTransfer:false},{externalTransfer:true,maxCalls:0},{externalTransfer:true,budgetUsd:0},{externalTransfer:true,provenance:'real'},{externalTransfer:true,callProvider:null}])
   await assert.rejects(generateComparison({...common,...patch}),error=>error.code==='EXECUTION_CONSENT_REQUIRED');
  await assert.rejects(readFile(join(dir,'l.jsonl')),{code:'ENOENT'});
  await generateComparison({...common,externalTransfer:true});
  await assert.rejects(generateComparison({...common,externalTransfer:true}),{code:'EEXIST'});
 });
});

test('sequential generation writes a chained ledger with hashes, timing and the full denominator',async()=>{
 await withTmp(async dir=>{
  const decisions=[decision('dec1'),decision('dec2',{cutoff:300})],calls=[];let active=0,maxActive=0,tick=0;
  const provider=async(promptInput,{signal,endpoint})=>{
   active++;maxActive=Math.max(maxActive,active);calls.push({promptInput,endpoint,hasSignal:signal instanceof AbortSignal});
   await new Promise(r=>setTimeout(r,1));active--;return okProvider();
  };
  const rawDir=join(dir,'raw');
  const result=await generateComparison({manifest:base(),decisions,callProvider:provider,ledgerPath:join(dir,'l.jsonl'),maxCalls:1000,budgetUsd:100,provenance:'synthetic',externalTransfer:true,rawResponseDir:rawDir,now:()=>(tick+=40),wallNow:()=>1700000000000});
  assert.equal(maxActive,1);
  assert.equal(result.plannedCells,2*v2Conditions.length);
  assert.equal(calls.length,result.plannedCells);
  assert.ok(calls.every(c=>c.hasSignal&&c.endpoint==='next_look_onset'));
  const ledger=verifyLedgerText(await readFile(join(dir,'l.jsonl'),'utf8'));
  assert.equal(ledger.tailHash,result.tailHash);
  assert.equal(ledger.header.manifestSha256,manifestHash(base()));
  assert.equal(ledger.header.provenance,'synthetic');
  assert.equal(ledger.records.length,result.plannedCells);
  const rec=ledger.records.find(r=>r.decisionId==='dec1'&&r.condition==='depth_context');
  assert.equal(rec.status,'ok');
  const index=ledger.records.indexOf(rec);
  assert.equal(rec.promptSha256,sha(canonicalJson(calls[index].promptInput)));
  assert.ok(calls[index].promptInput.evidence.some(e=>e.kind==='depth'));
  assert.equal(rec.issuedAtMs,120);assert.equal(rec.latencyMs,40);assert.equal(rec.availableAtMs,160);assert.equal(rec.renderedAtMs,175);
  assert.deepEqual(rec.result,{abstained:false,rankedTargetIds:['o2','o1'],probabilities:null});
  assert.equal(rec.costUsd,0.002);assert.equal(rec.costSource,'provider_estimate');
  assert.match(rec.responseSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(rec.usage,{inputTokens:10,outputTokens:5,cachedInputTokens:0});
  assert.ok(rec.artifacts.length>0&&rec.artifacts.every(a=>/^[a-f0-9]{64}$/.test(a.sha256)));
  assert.equal(rec.newestInputObservedAtMs<=rec.observedUntilMs,true);
  assert.deepEqual((await readdir(rawDir)).length>0,true);
  // the ledger record's prompt hash matches the dry-run plan for the same input
  const plan=await planComparison({manifest:base(),decisions});
  assert.equal(plan.cells.find(c=>c.decisionId==='dec1'&&c.condition==='depth_context').promptSha256,rec.promptSha256);
  // no provider-facing input carries label-like keys or condition names
  for(const c of calls){assert.ok(!/label|target|future|groundTruth/i.test(Object.keys(c.promptInput).join(',')));assert.ok(!JSON.stringify(c.promptInput.evidence).includes('depth_history_proactive'));}
 });
});

test('budget cap and max calls are enforced before each call; remaining cells stay in the ledger',async()=>{
 await withTmp(async dir=>{
  let called=0;
  const provider=async()=>{called++;return okProvider();};
  const r1=await generateComparison({manifest:base(),decisions:[decision()],callProvider:provider,ledgerPath:join(dir,'a.jsonl'),maxCalls:5,budgetUsd:100,provenance:'synthetic',externalTransfer:true});
  assert.equal(called,5);assert.equal(r1.statusCounts.ok,5);assert.equal(r1.statusCounts.budget_exhausted,v2Conditions.length-5);
  const ledger=verifyLedgerText(await readFile(join(dir,'a.jsonl'),'utf8'));
  const exhausted=ledger.records.filter(r=>r.status==='budget_exhausted');
  assert.equal(exhausted.length,v2Conditions.length-5);
  assert.ok(exhausted.every(r=>r.result===null&&r.availableAtMs===null&&r.issuedAtMs===null&&r.costUsd===0));
  called=0;
  const expensive=async()=>{called++;return {...(await okProvider()),estimatedCostUsd:0.4};};
  const r2=await generateComparison({manifest:base(),decisions:[decision()],callProvider:expensive,ledgerPath:join(dir,'b.jsonl'),maxCalls:100,budgetUsd:1,estimatedCallUsd:0.3,provenance:'synthetic',externalTransfer:true});
  assert.equal(called,2);assert.ok(Math.abs(r2.spentUsd-0.8)<1e-9);assert.equal(r2.statusCounts.budget_exhausted,v2Conditions.length-2);
 });
});

test('timeouts, parse failures and provider failures are kept as ledger rows with no availability',async()=>{
 await withTmp(async dir=>{
  let n=0;
  const provider=async(_,{signal})=>{
   n++;
   if(n===1)return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('x'),{code:'REASONER_CANCELLED'}))));
   if(n===2)return {nextGaze:{rankedTargetIds:['not_a_candidate']}};
   if(n===3)throw Object.assign(Error('x'),{code:'PROVIDER_RATE_LIMITED'});
   if(n===4)throw Object.assign(Error('x'),{code:'REASONER_JSON_INVALID'});
   if(n===5)return {nextGaze:{rankedTargetIds:['unknown']}};
   if(n===6)return new Promise(()=>{});
   return okProvider();
  };
  const result=await generateComparison({manifest:base(),decisions:[decision()],callProvider:provider,ledgerPath:join(dir,'l.jsonl'),maxCalls:100,budgetUsd:100,timeoutMs:25,provenance:'synthetic',externalTransfer:true});
  const ledger=verifyLedgerText(await readFile(join(dir,'l.jsonl'),'utf8'));
  const byOrder=ledger.records.slice(0,7);
  assert.deepEqual(byOrder.map(r=>r.status),['timeout','parse_failed','provider_failed','parse_failed','ok','timeout','ok']);
  assert.equal(byOrder[0].errorCode,'GENERATOR_TIMEOUT');assert.equal(byOrder[2].errorCode,'PROVIDER_RATE_LIMITED');
  assert.ok(byOrder.filter(r=>r.status!=='ok').every(r=>r.result===null&&r.availableAtMs===null&&r.issuedAtMs===120));
  assert.deepEqual(byOrder[4].result,{abstained:true,rankedTargetIds:[],probabilities:null});
  assert.equal(result.statusCounts.timeout,2);assert.equal(ledger.records.length,v2Conditions.length);
  assert.ok(ledger.records.every(r=>r.costUsd>0));
 });
});

test('provider output parsing validates ranking, sentinels and full probability vectors',()=>{
 const ids=['o1','o2','o3'];
 assert.deepEqual(parseProviderResult({nextGaze:{rankedTargetIds:['o2','o3']}},'next_look_onset',ids),{abstained:false,rankedTargetIds:['o2','o3'],probabilities:null});
 assert.deepEqual(parseProviderResult({nextInteraction:{rankedTargetIds:['outside_view']}},'next_interaction',ids).rankedTargetIds,['outside_view']);
 assert.equal(parseProviderResult({nextGaze:{rankedTargetIds:[]}},'next_look_onset',ids).abstained,true);
 assert.deepEqual(parseProviderResult({nextGaze:{rankedTargetIds:['o1'],probabilities:[.6,.3,.1]}},'next_look_onset',ids).probabilities,[.6,.3,.1]);
 const bad=raw=>assert.throws(()=>parseProviderResult(raw,'next_look_onset',ids),error=>error.code==='RESPONSE_PARSE_FAILED');
 bad({nextGaze:null});bad({});bad(null);bad({nextGaze:{rankedTargetIds:['o9']}});bad({nextGaze:{rankedTargetIds:['o1','o1']}});
 bad({nextGaze:{rankedTargetIds:['o1','o2','o3','unknown']}});bad({nextGaze:{rankedTargetIds:['o1'],extra:1}});
 bad({nextGaze:{rankedTargetIds:['o1'],probabilities:[.5,.5]}});bad({nextGaze:{rankedTargetIds:['o1'],probabilities:[.2,.5,.3]}});bad({nextGaze:{rankedTargetIds:['o1'],probabilities:[.9,.2,.2]}});
 bad({nextInteraction:{rankedTargetIds:['o1']}});
});

test('tampered, reordered, truncated or extended ledgers are detected',async()=>{
 await withTmp(async dir=>{
  await generateComparison({manifest:base(),decisions:[decision()],callProvider:okProvider,ledgerPath:join(dir,'l.jsonl'),maxCalls:100,budgetUsd:100,provenance:'synthetic',externalTransfer:true});
  const text=await readFile(join(dir,'l.jsonl'),'utf8'),lines=text.slice(0,-1).split('\n');
  assert.doesNotThrow(()=>verifyLedgerText(text));
  const code=(t,c,opts)=>assert.throws(()=>verifyLedgerText(t,opts),error=>error.code===c,c);
  const edited=[...lines];edited[3]=edited[3].replace('"status":"ok"','"status":"timeout"');code(edited.join('\n')+'\n','LEDGER_TAMPERED');
  const costEdit=[...lines];costEdit[4]=costEdit[4].replace(/"costUsd":[0-9.]+/,'"costUsd":0');code(costEdit.join('\n')+'\n','LEDGER_TAMPERED');
  code([...lines.slice(0,3),...lines.slice(4)].join('\n')+'\n','LEDGER_TAMPERED');
  const swapped=[...lines];[swapped[2],swapped[3]]=[swapped[3],swapped[2]];code(swapped.join('\n')+'\n','LEDGER_TAMPERED');
  code(lines.slice(0,-1).join('\n')+'\n','LEDGER_UNCLOSED');
  assert.doesNotThrow(()=>verifyLedgerText(lines.slice(0,-1).join('\n')+'\n',{allowOpen:true}));
  code(text.slice(0,-5),'LEDGER_TAMPERED');
  code(text+lines[2]+'\n','LEDGER_TAMPERED');
  const rewritten=lines.map((l,i)=>{if(i!==2)return l;const row=JSON.parse(l);row.payload.status='timeout';return JSON.stringify(row);});code(rewritten.join('\n')+'\n','LEDGER_TAMPERED');
  // a forger who recomputes every hash still cannot change the tail anchor
  let prev=GENESIS_HASH;const forged=[];lines.forEach((l,i)=>{const row=JSON.parse(l);if(i===2)row.payload.costUsd=0;const built=chainLine(i,row.type,prev,row.payload);prev=built.hash;forged.push(built.text);});
  const forgedLedger=verifyLedgerText(forged.join('\n')+'\n');
  assert.notEqual(forgedLedger.tailHash,verifyLedgerText(text).tailHash);
 });
});

test('reasoner adapter bridge: supported shapes map, unsupported inputs and endpoints are named',async()=>{
 const prepared=await prepareDecision(decision());const m=base();
 const mapped=toReasonerAdapterInput(buildPromptInput(prepared,'depth_context',1000,'next_look_onset',m).promptInput);
 assert.deepEqual(Object.keys(mapped).sort(),['candidates','evidence','horizonMs','imageDataUrl','issuedAt','observedUntil']);
 assert.deepEqual([...new Set(mapped.evidence.map(e=>e.kind))].sort(),['gaze','mask','memory','scene']);
 assert.ok(mapped.evidence.find(e=>e.text.startsWith('[depth] ')));
 assert.throws(()=>toReasonerAdapterInput(buildPromptInput(prepared,'sam_bbox_crop',1000,'next_look_onset',m).promptInput),error=>error.code==='ADAPTER_UNSUPPORTED_INPUT');
 assert.throws(()=>toReasonerAdapterInput(buildPromptInput(prepared,'oracle_depth',1000,'next_look_onset',m).promptInput),error=>error.code==='ADAPTER_UNSUPPORTED_INPUT');
 const gaps=adapterGaps(m);
 assert.ok(gaps.some(g=>g.includes('sam_bbox_crop'))&&gaps.some(g=>g.includes('oracle_mask')));
 assert.ok(adapterGaps({...m,endpoints:{...m.endpoints,next_interaction:{definition:'first_user_interaction_in_window'}}}).some(g=>g.startsWith('endpoint:next_interaction')));
});

test('CLI: dry-run is the default, execute needs consent flags, default adapter is refused for unsupported manifests',async()=>{
 await withTmp(async dir=>{
  await writeFile(join(dir,'manifest.json'),JSON.stringify(base()));
  await writeFile(join(dir,'decisions.json'),JSON.stringify([decision()]));
  const lines=[],out=line=>lines.push(line);
  const plan=await generateMain(['--manifest',join(dir,'manifest.json'),'--decisions',join(dir,'decisions.json'),'--output',join(dir,'plan.json')],{stdout:out,importProvider:()=>{throw Error('provider must not be imported in a dry run');}});
  assert.equal(plan.providerCalled,false);assert.match(lines[0],/Dry run: 1 decisions/);
  assert.equal(JSON.parse(await readFile(join(dir,'plan.json'),'utf8')).cells.length,v2Conditions.length);
  await assert.rejects(generateMain(['--manifest',join(dir,'manifest.json'),'--decisions',join(dir,'decisions.json'),'--output',join(dir,'plan.json')],{stdout:out}),{code:'EEXIST'});
  const args=['--manifest',join(dir,'manifest.json'),'--decisions',join(dir,'decisions.json')];
  await assert.rejects(generateMain([...args,'--execute'],{stdout:out}),/requires --external-transfer/);
  await assert.rejects(generateMain([...args,'--execute','--external-transfer','--max-calls','5','--budget-usd','1'],{stdout:out}),/requires --external-transfer/);
  await assert.rejects(generateMain([...args,'--execute','--dry-run'],{stdout:out}),/mutually exclusive/);
  let imported=false;
  await assert.rejects(generateMain([...args,'--execute','--external-transfer','--max-calls','5','--budget-usd','1','--ledger',join(dir,'x.jsonl')],{stdout:out,importProvider:()=>{imported=true;return {};}}),error=>error.code==='ADAPTER_UNSUPPORTED');
  assert.equal(imported,false);
  await assert.rejects(readFile(join(dir,'x.jsonl')),{code:'ENOENT'});
  await assert.rejects(generateMain([...args,'--execute','--external-transfer','--max-calls','5','--budget-usd','1','--ledger',join(dir,'y.jsonl'),'--provider-module',join(dir,'provider.mjs')],{stdout:out}),/--provenance/);
  await writeFile(join(dir,'provider.mjs'),`export async function callProvider(){return {nextGaze:{rankedTargetIds:['o1']},estimatedCostUsd:0.001};}\n`);
  const result=await generateMain([...args,'--execute','--external-transfer','--max-calls','1000','--budget-usd','5','--ledger',join(dir,'y.jsonl'),'--provider-module',join(dir,'provider.mjs'),'--provenance','synthetic'],{stdout:out});
  assert.equal(result.provenance,'synthetic');assert.equal(result.calls,v2Conditions.length);
  assert.equal(verifyLedgerText(await readFile(join(dir,'y.jsonl'),'utf8')).header.provenance,'synthetic');
 });
});
