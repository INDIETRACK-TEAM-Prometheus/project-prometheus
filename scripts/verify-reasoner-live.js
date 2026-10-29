import { writeFile, mkdir, open } from 'node:fs/promises';
import { createLocalServer } from '../server.js';
import { makeScene } from './sam-scene.js';
const scene=makeScene();
const report={schemaVersion:1,description:'Synthetic image and synthetic gaze through local SAM and Spark pipeline',startedAtUtc:new Date().toISOString(),inputSha256:scene.sha256,clock:'synthetic monotonic millisecond values; not wall time',criteria:{samModel:'sam-3.1',reasonerModel:'muse-spark-1.3',maxScenarios:5,groundingEvidenceIds:['synthetic-frame','synthetic-event','synthetic-memory']},status:'not_run'};
await mkdir('docs/evidence',{recursive:true});
const output=new URL('../docs/evidence/reasoner-live-v4.json',import.meta.url);
const reserved=await open(output,'wx'); await reserved.close();
const save=()=>writeFile(output,JSON.stringify(report,null,2)+'\n');
await save();
const frame={frameId:'synthetic-frame',observedAt:1000,processedAt:1001,imageData:`data:image/png;base64,${scene.png.toString('base64')}`,causalStatus:'online_causal',provenanceKind:'synthetic',sceneText:'Synthetic colored shapes on a plain background.'};
const input={frame,gaze:{x:.28,y:.34,observedAt:1000,processedAt:1001},events:[{eventId:'synthetic-event',type:'fixated',observedAt:800,endAt:990,dwellValidMs:190,x:.28,y:.34,processedAt:1001}],context:{memory:[{evidenceId:'synthetic-memory',text:'Earlier, the gaze crossed the left side of this scene.',observedAt:600,processedAt:700,causalStatus:'online_causal'}]},dependencies:{mapId:'synthetic-map',mapVersion:1,objectIds:[],evidenceIds:['synthetic-frame','synthetic-event','synthetic-memory'],expiresAt:5000}};
report.syntheticInput={gaze:input.gaze,events:input.events,memory:input.context.memory,prompt:'red square',imageIncluded:true};
await save();
const server=createLocalServer();
try {
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const start=performance.now();
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/analyze`,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(110000),body:JSON.stringify({input,prompt:'red square'})});
 report.httpStatus=response.status;report.latencyMs=Math.round(performance.now()-start);
 const body=await response.json();
 if(!response.ok){report.status='failed';report.errorCode=typeof body?.error==='string' && /^[a-z_]{1,64}$/.test(body.error)?body.error:'request_failed';report.upstreamStatus=Number.isInteger(body?.upstreamStatus)&&body.upstreamStatus>=400&&body.upstreamStatus<=599?body.upstreamStatus:null;report.providerCode=['REASONER_INCOMPLETE','REASONER_WRONG_MODEL','REASONER_LANE_INVALID','REASONER_JSON_INVALID','REASONER_GROUNDING_INVALID','REASONER_INVALID_RESPONSE'].includes(body.providerCode)?body.providerCode:null; const d=body.diagnostic; report.diagnostic=d?{responseStatus:['completed','incomplete','failed','in_progress','cancelled'].includes(d.responseStatus)?d.responseStatus:'unknown',incompleteReason:['max_output_tokens','content_filter','other'].includes(d.incompleteReason)?d.incompleteReason:null,outputTypes:Array.isArray(d.outputTypes)?d.outputTypes.slice(0,10).map(x=>['message','reasoning'].includes(x)?x:'other'):[],textLength:Number.isInteger(d.textLength)&&d.textLength>=0&&d.textLength<=262144?d.textLength:null}:null;}
 else {
  const scenarios=body.scenarios;
  const valid=Array.isArray(scenarios)&&scenarios.length<=5&&scenarios.every(s=>Array.isArray(s.grounding_refs)&&s.grounding_refs.length>0&&s.grounding_refs.every(id=>report.criteria.groundingEvidenceIds.includes(id)));
  report.status=body.sam?.model===report.criteria.samModel&&body.reasoner?.model===report.criteria.reasonerModel&&valid?'passed':'failed';
  report.scenarioGenerationDemonstrated=valid && scenarios.length>0;
  report.result={frame:body.frame,sam:body.sam,reasoner:body.reasoner,scenarios};
 }
} catch {report.status='failed';report.errorCode='local_or_network_failure';}
finally {report.finishedAtUtc=new Date().toISOString();await save();if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
console.log(`Reasoner pipeline probe: ${report.status}; see docs/evidence/reasoner-live-v4.json`);
if(report.status!=='passed')process.exitCode=1;
