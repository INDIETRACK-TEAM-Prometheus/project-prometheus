import {mkdir,writeFile,readFile,stat,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export function createRecordingStore({root,maxSessionBytes=1024*1024*1024,maxTotalBytes=5*1024*1024*1024}={}) {
  if(typeof root!=='string'||!path.isAbsolute(root))throw new TypeError('absolute recording root required');
  const sessions=new Map();let total=0,initialized=false,queue=Promise.resolve();
  const serial=fn=>{const task=queue.then(fn);queue=task.catch(()=>{});return task;};
  const folders=async()=>(await readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&/^[-a-f0-9]{36}$/.test(entry.name)).map(entry=>entry.name);
  // Counts video chunks only, matching the per-append quota accounting.
  async function folderBytes(id){let bytes=0;for(const f of await readdir(path.join(root,id))){if(!/^\d{8}\.webm$/.test(f))continue;const s=await stat(path.join(root,id,f));if(s.isFile())bytes+=s.size;}return bytes;}
  async function initialize(){if(initialized)return;await mkdir(root,{recursive:true});
    for(const id of await folders())total+=await folderBytes(id);
    initialized=true;
  }
  return {
    start:()=>serial(async()=>{await initialize();if(total>=maxTotalBytes)throw new Error('recording_quota_exceeded');const id=randomUUID(),folder=path.join(root,id);await mkdir(folder);const meta={version:1,sessionId:id,createdAtUtc:new Date().toISOString(),source:'local_webcam',chunks:0,bytes:0};await writeFile(path.join(folder,'manifest.json'),JSON.stringify(meta));sessions.set(id,{folder,meta,closed:false});return {sessionId:id,maxSessionBytes};}),
    append:(id,index,bytes)=>serial(async()=>{const session=sessions.get(id);if(!session||session.closed||!Number.isSafeInteger(index)||index!==session.meta.chunks||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>8*1024*1024)throw new Error('invalid_recording_chunk');
      if(session.meta.bytes+bytes.length>maxSessionBytes||total+bytes.length>maxTotalBytes)throw new Error('recording_quota_exceeded');
      await writeFile(path.join(session.folder,`${String(index).padStart(8,'0')}.webm`),bytes,{flag:'wx'});session.meta.bytes+=bytes.length;session.meta.chunks++;total+=bytes.length;await writeFile(path.join(session.folder,'manifest.json'),JSON.stringify(session.meta));return {chunks:session.meta.chunks,bytes:session.meta.bytes};}),
    stop:id=>serial(async()=>{const session=sessions.get(id);if(!session)throw new Error('unknown_recording');session.meta.closedAtUtc=new Date().toISOString();await writeFile(path.join(session.folder,'manifest.json'),JSON.stringify(session.meta));session.closed=true;sessions.delete(id);return {sessionId:id,chunks:session.meta.chunks,bytes:session.meta.bytes};}),
    // Byte counts come from the files on disk; an unreadable manifest is reported, not hidden.
    list:()=>serial(async()=>{await initialize();const recordings=[];
      for(const id of await folders()){let meta=null;try{meta=JSON.parse(await readFile(path.join(root,id,'manifest.json'),'utf8'));}catch{}
        recordings.push({sessionId:id,createdAtUtc:typeof meta?.createdAtUtc==='string'?meta.createdAtUtc:null,closedAtUtc:typeof meta?.closedAtUtc==='string'?meta.closedAtUtc:null,active:sessions.has(id),bytes:await folderBytes(id),manifest:meta?'ok':'unreadable'});}
      return {recordings,totalBytes:recordings.reduce((sum,r)=>sum+r.bytes,0)};}),
    // Active sessions are never removed underneath an open recorder; the caller stops it first.
    deleteAll:()=>serial(async()=>{await initialize();const deleted=[],failed=[],skippedActive=[];let freedBytes=0;
      for(const id of await folders()){if(sessions.has(id)){skippedActive.push(id);continue;}
        let bytes=0;try{bytes=await folderBytes(id);await rm(path.join(root,id),{recursive:true});deleted.push(id);freedBytes+=bytes;}catch{failed.push(id);}}
      total=0;for(const id of await folders())total+=await folderBytes(id);
      return {deleted,failed,skippedActive,freedBytes};})
  };
}
