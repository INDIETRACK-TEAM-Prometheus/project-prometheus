import test from 'node:test';
import assert from 'node:assert/strict';
import { reasonScenarios } from '../server/reasoner-adapter.js';
import { ProviderPolicy } from '../server/provider-policy.js';
const oldFetch = globalThis.fetch, oldKey = process.env.META_API_KEY;
test.after(() => { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.META_API_KEY; else process.env.META_API_KEY = oldKey; });
const input = {policy:new ProviderPolicy({minIntervalMs:0,maxCallsPerMinute:100,maxCostPerMinute:10}),observedUntil:10,issuedAt:12,evidence:[{id:'frame',kind:'scene',text:'cup on table',observedAt:10,processedAt:11,causalStatus:'online_causal'}]};
const scenario = {scenario_id:'s1',possible_next_action:'move the cup',horizon_ms:1000,grounding_refs:['frame'],assumptions:[],status:'active'};
function reply(scenarios, extra={}) { return new Response(JSON.stringify({status:'completed',model:'muse-spark-1.3',id:'resp_123',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({scenarios})}]}],...extra})); }
test('sends constrained request and returns grounded scenarios', async () => {
  process.env.META_API_KEY='test-secret'; globalThis.fetch=async (url,options) => { const body=JSON.parse(options.body); assert.equal(url,'https://api.meta.ai/v1/responses'); assert.equal(options.redirect,'error'); assert.equal(body.model,'muse-spark-1.3'); assert.equal(body.store,false); assert.equal(body.text.format.type,'json_schema'); assert.equal(body.text.format.strict,true); assert.deepEqual(body.text.format.schema.properties.scenarios.items.properties.horizon_ms,{type:'number'}); assert.equal(body.tools,undefined); return reply([scenario]); };
  const result=await reasonScenarios(input); assert.deepEqual(result.scenarios,[scenario]); assert.equal(result.model,'muse-spark-1.3');
});
test('rejects future, noncausal and unlisted input before network', async () => {
  globalThis.fetch=async () => { throw Error('unexpected network'); };
  for (const evidence of [[{...input.evidence[0],observedAt:11}], [{...input.evidence[0],processedAt:13}], [{...input.evidence[0],causalStatus:'offline_assisted'}], [{...input.evidence[0],future:'hidden'}]]) await assert.rejects(reasonScenarios({...input,evidence}),{code:'REASONER_INVALID_INPUT'});
});
test('accepts explicitly tagged provisional evidence without presenting it as causal',async()=>{
 const evidence=[{...input.evidence[0],causalStatus:'provisional'}];let body;
 globalThis.fetch=async(_url,options)=>{body=JSON.parse(options.body);return reply([]);};
 const result=await reasonScenarios({...input,evidence,timingStatus:'provisional'});
 assert.equal(result.timingStatus,'provisional');assert.equal(body.input[0].content.includes('Timing is provisional'),true);assert.equal(JSON.parse(body.input[1].content).timingStatus,'provisional');
 globalThis.fetch=async()=>{throw Error('unexpected network');};
 await assert.rejects(reasonScenarios({...input,evidence}),{code:'REASONER_INVALID_INPUT'});
 await assert.rejects(reasonScenarios({...input,evidence,timingStatus:'verified'}),{code:'REASONER_INVALID_INPUT'});
});
test('rejects unknown grounding, malformed and wrong model; allows abstention', async () => {
  for (const [response,code] of [[reply([{...scenario,grounding_refs:['unknown']}]),'REASONER_GROUNDING_INVALID'],[reply(Array(6).fill(scenario)),'REASONER_JSON_INVALID'],[reply([scenario],{model:'other'}),'REASONER_WRONG_MODEL'],[reply([scenario],{output:[null]}),'REASONER_LANE_INVALID']]) { globalThis.fetch=async()=>response; await assert.rejects(reasonScenarios(input),{code}); }
  globalThis.fetch=async()=>reply([]); assert.deepEqual((await reasonScenarios(input)).scenarios,[]);
});
test('sanitizes provider errors and handles cancellation', async () => {
  globalThis.fetch=async()=>{ throw Error('test-secret'); }; await assert.rejects(reasonScenarios(input),{message:'PROVIDER_NETWORK_ERROR'});
  const controller=new AbortController(); controller.abort(); await assert.rejects(reasonScenarios({...input,signal:controller.signal}),{code:'REASONER_CANCELLED'});
});

 test('sends validated scene image alongside typed evidence and rejects arbitrary URLs', async()=>{
  const imageDataUrl='data:image/png;base64,iVBORw0KGgo=';
  globalThis.fetch=async (_url,options)=>{const body=JSON.parse(options.body);assert.deepEqual(body.input[1].content,[{type:'input_text',text:JSON.stringify({observedUntil:input.observedUntil,issuedAt:input.issuedAt,evidence:input.evidence})},{type:'input_image',image_url:imageDataUrl}]);return reply([]);};
  await reasonScenarios({...input,policy:new ProviderPolicy({minIntervalMs:0}),imageDataUrl});
  await assert.rejects(reasonScenarios({...input,imageDataUrl:'https://example.com/image.png'}),{code:'REASONER_INVALID_INPUT'});
 });

test('caps serialized evidence and reports only bounded usage and estimated cost',async()=>{
 const policy=new ProviderPolicy({minIntervalMs:0,maxCostPerMinute:10});
 const evidence=Array.from({length:10},(_,i)=>({...input.evidence[0],id:`id${i}`,text:'x'.repeat(1800)}));
 await assert.rejects(reasonScenarios({...input,policy,evidence}),{code:'REASONER_INVALID_INPUT'});
 globalThis.fetch=async()=>reply([],{usage:{input_tokens:1000,output_tokens:200,input_tokens_details:{cached_tokens:400},secret:'test-secret'}});
 const result=await reasonScenarios({...input,policy});
 assert.deepEqual(result.usage,{inputTokens:1000,outputTokens:200,cachedInputTokens:400});
 assert.equal(result.estimatedCostUsd,(600*1.25+400*.15+200*4.25)/1e6);
 assert.equal(JSON.stringify(result).includes('test-secret'),false);
 globalThis.fetch=async()=>reply([],{usage:{input_tokens:10,output_tokens:2}});
 assert.equal((await reasonScenarios({...input,policy})).estimatedCostUsd,null);
});

test('incomplete diagnostics contain only bounded fixed values',async()=>{
 const policy=new ProviderPolicy({minIntervalMs:0,maxCostPerMinute:10});
 globalThis.fetch=async()=>reply([],{status:'incomplete',incomplete_details:{reason:'max_output_tokens',secret:'test-secret'},output:[{type:'reasoning',secret:'test-secret'}]});
 await assert.rejects(reasonScenarios({...input,policy}),err=>{assert.equal(err.code,'REASONER_INCOMPLETE');assert.deepEqual(err.diagnostic,{responseStatus:'incomplete',incompleteReason:'max_output_tokens',outputTypes:['reasoning'],textLength:null});assert.equal(JSON.stringify(err.diagnostic).includes('test-secret'),false);return true;});
});

test('optional evaluation horizon constrains the request and response',async()=>{
 let body, calls=0; const policy=new ProviderPolicy({minIntervalMs:0,maxCostPerMinute:10});
 globalThis.fetch=async (_url,options)=>{calls++;body=JSON.parse(options.body);return reply([{...scenario,horizon_ms:3000}]);};
 const result=await reasonScenarios({...input,policy,horizonMs:3000});
 assert.equal(result.scenarios[0].horizon_ms,3000);
 assert.deepEqual(body.text.format.schema.properties.scenarios.items.properties.horizon_ms,{type:'number',enum:[3000]});
 assert.match(body.input[0].content,/3000 milliseconds/);
 assert.equal(JSON.parse(body.input[1].content).horizonMs,undefined);
 globalThis.fetch=async()=>reply([scenario]);
 await assert.rejects(reasonScenarios({...input,policy,horizonMs:3000}),{code:'REASONER_JSON_INVALID'});
 globalThis.fetch=async()=>{calls++;throw Error('unexpected fetch');};
 for(const horizonMs of [0,2000,10000,'1000',null]) await assert.rejects(reasonScenarios({...input,policy,horizonMs}),{code:'REASONER_INVALID_INPUT'});
 assert.equal(calls,1);
});


test('next gaze is separate and constrained to current candidates',async()=>{
 const candidates=[{objectId:'p1:0:object-1',bounds:{left:0,top:0,right:2,bottom:2}}];
 const policy=new ProviderPolicy({minIntervalMs:0,maxCostPerMinute:10});
 let prediction={rankedTargetIds:['p1:0:object-1','outside_view']};
 globalThis.fetch=async (_url,options)=>{
  const body=JSON.parse(options.body);
  assert.deepEqual(body.text.format.schema.properties.nextGaze.properties.rankedTargetIds.items.enum,['p1:0:object-1','unknown','outside_view']);
  assert.deepEqual(JSON.parse(body.input[1].content).candidates,candidates);
  return new Response(JSON.stringify({status:'completed',model:'muse-spark-1.3',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({scenarios:[],nextGaze:prediction})}]}]}));
 };
 assert.deepEqual((await reasonScenarios({...input,policy,candidates})).nextGaze,prediction);
 prediction={rankedTargetIds:['fabricated']};
 await assert.rejects(reasonScenarios({...input,policy,candidates}),{code:'REASONER_JSON_INVALID'});
 prediction={rankedTargetIds:[]};
 assert.deepEqual((await reasonScenarios({...input,policy,candidates})).nextGaze,prediction);
});

test('reasoner model and effort default to Spark 1.3 at minimal and accept only known values', async () => {
  const {reasonerSettings} = await import('../server/reasoner-adapter.js');
  assert.deepEqual(reasonerSettings({}), {model:'muse-spark-1.3', effort:'minimal'});
  assert.deepEqual(reasonerSettings({PROMETHEUS_SPARK_MODEL:'muse-spark-1.1', PROMETHEUS_SPARK_EFFORT:'low'}), {model:'muse-spark-1.1', effort:'low'});
  assert.deepEqual(reasonerSettings({PROMETHEUS_SPARK_MODEL:'gpt-x', PROMETHEUS_SPARK_EFFORT:'none'}), {model:'muse-spark-1.3', effort:'minimal'});
});
