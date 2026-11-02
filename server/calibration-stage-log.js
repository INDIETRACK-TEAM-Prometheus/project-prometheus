import {appendFile,copyFile,mkdir,rm,stat} from 'node:fs/promises';
import path from 'node:path';

const events=new Set([
  'calibration_adapt_start','calibration_adapt_complete','calibration_adapt_error',
  'adaptation_serialize_start','adaptation_serialize_complete','adaptation_serialize_error',
  'profile_save_start','profile_save_complete','profile_save_error',
  'calibration_verdict'
]);
const verdictKeys=['passed','validCount','attempts','p95Bp'];
const sessionPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sanitizeCalibrationStageEvent(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['event','sessionId','durationMs','count',...verdictKeys].includes(key)))return null;
  const isVerdict=value?.event==='calibration_verdict';
  if(!isVerdict&&verdictKeys.some(key=>Object.hasOwn(value,key)))return null;
  if(!events.has(value.event)||typeof value.sessionId!=='string'||!sessionPattern.test(value.sessionId))return null;
  if(Object.hasOwn(value,'durationMs')&&(!Number.isSafeInteger(value.durationMs)||value.durationMs<0||value.durationMs>600000))return null;
  if(Object.hasOwn(value,'count')&&(!Number.isSafeInteger(value.count)||value.count<0||value.count>27))return null;
  if(isVerdict){
    // Aggregate outcome only: whether the independent check passed, how many of the 27 targets were usable, and p95 in basis points of the screen diagonal.
    if(typeof value.passed!=='boolean'||!Number.isSafeInteger(value.validCount)||value.validCount<0||value.validCount>27||!Number.isSafeInteger(value.attempts)||value.attempts<1||value.attempts>27||value.validCount>value.attempts)return null;
    if(Object.hasOwn(value,'p95Bp')&&(!Number.isSafeInteger(value.p95Bp)||value.p95Bp<0||value.p95Bp>100000))return null;
  }
  return {event:value.event,sessionId:value.sessionId,...(isVerdict?{passed:value.passed,validCount:value.validCount,attempts:value.attempts,...(Object.hasOwn(value,'p95Bp')?{p95Bp:value.p95Bp}:{})}:{}),...(Object.hasOwn(value,'durationMs')?{durationMs:value.durationMs}:{}),...(Object.hasOwn(value,'count')?{count:value.count}:{})};
}

export function createCalibrationStageLog({root,maxBytes=256*1024,now=()=>new Date()}={}){
  if(typeof root!=='string'||!path.isAbsolute(root))throw new TypeError('absolute diagnostics root required');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<512)throw new TypeError('diagnostics limit must be at least 512 bytes');
  const file=path.join(root,'calibration-stages.jsonl'),backup=`${file}.1`;
  let queue=Promise.resolve();
  const serial=fn=>{const task=queue.then(fn);queue=task.catch(()=>{});return task;};
  return {append:value=>serial(async()=>{
    const event=sanitizeCalibrationStageEvent(value);if(!event)return false;
    const line=JSON.stringify({...event,recordedAtUtc:now().toISOString()})+'\n';
    const bytes=Buffer.byteLength(line);await mkdir(root,{recursive:true});
    let size=0;try{size=(await stat(file)).size;}catch(error){if(error.code!=='ENOENT')throw error;}
    if(size+bytes>maxBytes){
      await rm(backup,{force:true});
      if(size<=maxBytes){await copyFile(file,backup);await rm(file);}else await rm(file,{force:true});
    }
    await appendFile(file,line,{encoding:'utf8',mode:0o600});
    return true;
  })};
}
