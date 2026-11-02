import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createLocalServer} from '../server.js';
import {createCalibrationStageLog} from '../server/calibration-stage-log.js';

test('calibration stage route accepts only fixed local diagnostic fields',async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),'prometheus-calibration-log-'));
 const logRoot=path.join(temp,'diagnostics');
 const calibrationStageLog=createCalibrationStageLog({root:logRoot,now:()=>new Date('2026-11-01T00:00:00.000Z')});
 const server=createLocalServer({calibrationStageLog});server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=(value,headers={})=>fetch(`${base}/api/diagnostics/calibration-stage`,{method:'POST',headers:{'content-type':'application/json',origin:base,...headers},body:JSON.stringify(value)});
 try{
   const sessionId=randomUUID();
   assert.equal((await fetch(`${base}/api/diagnostics/calibration-stage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'calibration_adapt_start',sessionId})})).status,403);
   assert.equal((await post({event:'calibration_adapt_start',sessionId},{origin:'https://attacker.invalid'})).status,403);
   assert.equal((await post({event:'calibration_adapt_start',sessionId},{'content-type':'text/plain'})).status,415);
   assert.equal((await post({padding:'x'.repeat(2048)})).status,413);
   for(const invalid of [
     {event:'unknown_stage',sessionId},
     {event:'profile_save_error',sessionId,error:'PRIVATE_SENTINEL'},
     {event:'profile_save_complete',sessionId,durationMs:600001},
     {event:'calibration_adapt_complete',sessionId,count:28},
     {event:'calibration_adapt_complete',sessionId:'not-a-uuid'}
   ]) assert.equal((await post(invalid)).status,400);
   assert.equal((await post({event:'calibration_adapt_complete',sessionId,durationMs:1234,count:27})).status,202);
   const records=(await readFile(path.join(logRoot,'calibration-stages.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
   assert.deepEqual(records,[{event:'calibration_adapt_complete',sessionId,durationMs:1234,count:27,recordedAtUtc:'2026-11-01T00:00:00.000Z'}]);
   assert.equal(JSON.stringify(records).includes('PRIVATE_SENTINEL'),false);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});}
});

test('calibration stage log rotates at its fixed size bound',async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),'prometheus-calibration-rotation-'));
 const maxBytes=512,log=createCalibrationStageLog({root:temp,maxBytes}),sessionId=randomUUID();
 try{
   for(let index=0;index<20;index++)await log.append({event:'adaptation_serialize_complete',sessionId,durationMs:index,count:27});
   const current=path.join(temp,'calibration-stages.jsonl'),backup=`${current}.1`;
   assert.ok((await stat(current)).size<=maxBytes);
   assert.ok((await stat(backup)).size<=maxBytes);
   assert.deepEqual((await readdir(temp)).sort(),['calibration-stages.jsonl','calibration-stages.jsonl.1']);
 }finally{await rm(temp,{recursive:true,force:true});}
});

test('calibration verdict event carries only aggregate outcome numbers',async()=>{
 const {sanitizeCalibrationStageEvent}=await import('../server/calibration-stage-log.js');
 const sessionId=randomUUID(),base={event:'calibration_verdict',sessionId,count:27};
 assert.deepEqual(sanitizeCalibrationStageEvent({...base,passed:false,validCount:26,attempts:27,p95Bp:742}),{event:'calibration_verdict',sessionId,count:27,passed:false,validCount:26,attempts:27,p95Bp:742});
 assert.deepEqual(sanitizeCalibrationStageEvent({...base,passed:true,validCount:0,attempts:27}),{event:'calibration_verdict',sessionId,count:27,passed:true,validCount:0,attempts:27});
 for(const invalid of [
   {...base},                                                             // outcome missing
   {...base,passed:'no',validCount:1,attempts:27},
   {...base,passed:true,validCount:28,attempts:27},
   {...base,passed:true,validCount:20,attempts:10},                      // more valid than attempted
   {...base,passed:true,validCount:1,attempts:0},
   {...base,passed:true,validCount:1,attempts:27,p95Bp:-1},
   {...base,passed:true,validCount:1,attempts:27,p95Bp:100001},
   {...base,passed:true,validCount:1,attempts:27,p95Bp:1.5},
   {...base,passed:true,validCount:1,attempts:27,note:'PRIVATE'},
   {event:'calibration_adapt_complete',sessionId,passed:true,validCount:1,attempts:27}  // verdict numbers only on the verdict event
 ]) assert.equal(sanitizeCalibrationStageEvent(invalid),null,JSON.stringify(invalid));
});
