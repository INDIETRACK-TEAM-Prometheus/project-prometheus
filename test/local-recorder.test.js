import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalRecorder,listLocalRecordings,deleteLocalRecordings} from '../src/gaze/local-recorder.js';
test('recording stop drains last chunk before server finalization',async()=>{
 const urls=[];class Recorder extends EventTarget{static isTypeSupported(){return true;}state='inactive';start(){this.state='recording';}stop(){this.ondataavailable({data:new Blob(['last'])});this.state='inactive';this.dispatchEvent(new Event('stop'));}}
 const r=createLocalRecorder({Recorder,fetchImpl:async url=>{urls.push(url);return {ok:true,json:async()=>({sessionId:'abc'})};}});
 await r.start({});await r.stop();assert.deepEqual(urls,['/api/recordings/start','/api/recordings/abc/chunks/0','/api/recordings/abc/stop']);
});
test('stopping while session opens cannot start a late camera recording',async()=>{
 let release,constructed=0;class Recorder{static isTypeSupported(){return true;}constructor(){constructed++;}}
 const urls=[];const r=createLocalRecorder({Recorder,fetchImpl:async url=>{urls.push(url);if(url.endsWith('start'))await new Promise(resolve=>release=resolve);return {ok:true,json:async()=>({sessionId:'abc'})};}});
 const opening=r.start({});await r.stop();release();assert.equal(await opening,false);assert.equal(constructed,0);assert.equal(urls.at(-1),'/api/recordings/abc/stop');
});
test('recording list and delete helpers call the loopback endpoint and surface failures',async()=>{
 const calls=[];const ok=body=>async(url,options)=>{calls.push([url,options.method]);return {ok:true,json:async()=>body};};
 assert.deepEqual(await listLocalRecordings({fetchImpl:ok({recordings:[],totalBytes:0})}),{recordings:[],totalBytes:0});
 assert.deepEqual((await deleteLocalRecordings({fetchImpl:ok({deleted:[],failed:[],skippedActive:[],freedBytes:0})})).deleted,[]);
 assert.deepEqual(calls,[['/api/recordings','GET'],['/api/recordings','DELETE']]);
 await assert.rejects(deleteLocalRecordings({fetchImpl:async()=>({ok:false})}),/local_recording_delete_failed/);
});
