// Original webcam data travels only to the loopback recording endpoint.
export function createLocalRecorder({fetchImpl=fetch,Recorder=globalThis.MediaRecorder,onStatus=()=>{},maxPendingBytes=16*1024*1024}={}) {
 let recorder=null,session=null,chain=Promise.resolve(),pending=0,index=0,failed=false,generation=0,starting=false;
 async function request(url,options){const response=await fetchImpl(url,options);if(!response.ok)throw new Error('local_recording_write_failed');return response.json();}
 function fail(){if(failed)return;failed=true;onStatus({status:'failed',code:'local_recording_write_failed'});if(recorder&&recorder.state!=='inactive')recorder.stop();}
 return {
   async start(stream){if(recorder||starting)throw new Error('recording_already_started');if(typeof Recorder!=='function'||!Recorder.isTypeSupported('video/webm')){onStatus({status:'unavailable',code:'recording_format_unavailable'});return false;}
     const token=++generation;starting=true;let opened;try{opened=await request('/api/recordings/start',{method:'POST'});}finally{starting=false;}
     if(token!==generation){await request(`/api/recordings/${opened.sessionId}/stop`,{method:'POST'}).catch(()=>{});return false;}session=opened.sessionId;index=0;failed=false;pending=0;chain=Promise.resolve();
     try{recorder=new Recorder(stream,{mimeType:'video/webm',videoBitsPerSecond:1500000});
       recorder.ondataavailable=event=>{if(!event.data?.size||failed)return;pending+=event.data.size;if(pending>maxPendingBytes){fail();return;}
         const chunk=event.data,number=index++;chain=chain.then(()=>request(`/api/recordings/${session}/chunks/${number}`,{method:'POST',headers:{'Content-Type':'video/webm'},body:chunk})).catch(fail).finally(()=>{pending-=chunk.size;});};
       recorder.onerror=fail;recorder.start(2000);onStatus({status:'recording',sessionId:session});return true;
     }catch{fail();recorder=null;await request(`/api/recordings/${session}/stop`,{method:'POST'}).catch(()=>{});return false;}
   },
   pause(){if(recorder?.state==='recording')recorder.pause();},
   resume(){if(recorder?.state==='paused')recorder.resume();},
   async stop(){generation++;const current=recorder;if(!current)return;
     if(current.state!=='inactive')await new Promise(resolve=>{current.addEventListener('stop',resolve,{once:true});current.stop();});
     await chain;await request(`/api/recordings/${session}/stop`,{method:'POST'}).catch(fail);recorder=null;
     if(!failed)onStatus({status:'saved',sessionId:session});
   }
 };
}
