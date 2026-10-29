import {MemoryService,IndexedDBStorage} from './index.js';
import {ProviderJournal} from '../runtime/provider-journal.js';

async function deleteSlot(storage, sessionId) {
 const ids=[sessionId,`provider-journal:${sessionId}`];
 if(typeof storage.deleteMany==='function') await storage.deleteMany(ids);
 else for(const id of ids) await storage.delete(id);
}

// A held browser lock prevents two tabs from overwriting one snapshot.
export async function openDurableSession({sessionId,mode='create',retentionConsent,retentionMs,locks=globalThis.navigator?.locks,storage=new IndexedDBStorage(),pageNow=()=>performance.now(),wallNow=()=>Date.now()}={}) {
 if(retentionConsent!==true || !Number.isFinite(retentionMs) || retentionMs<=0 || !locks?.request || !['create','reopen'].includes(mode) || typeof sessionId!=='string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId))throw Error('durable consent, duration, identity and exclusive lock required');
 let release,opened,fail;const acquired=new Promise((resolve,reject)=>{opened=resolve;fail=reject;});
 const held=new Promise(resolve=>{release=resolve;});
 const operation=locks.request(`prometheus-session-${sessionId}`,{ifAvailable:true},async lock=>{if(!lock){fail(Error('session is open elsewhere'));return;}opened();await held;});
 operation.catch(fail);await acquired;
 try {
  let saved=await storage.load(sessionId),expired=false;
  const retentionNow=wallNow();
  if(saved && Number.isSafeInteger(saved.expiresAt) && retentionNow>=saved.expiresAt){await MemoryService.open({sessionId,storage:{durable:storage.durable,load:id=>storage.load(id),delete:()=>deleteSlot(storage,sessionId)},retentionConsent,retentionMs,clock:pageNow,retentionClock:()=>retentionNow});saved=null;expired=true;}
  if(!saved && !expired) await storage.delete(`provider-journal:${sessionId}`);
  if(mode==='create' && saved)throw Error('session already exists');
  if(mode==='reopen' && (!saved || !Number.isSafeInteger(saved.expiresAt) || wallNow()>=saved.expiresAt))throw Error('session unavailable or expired');
  let offset=0;const memory=await MemoryService.open({sessionId,storage,retentionConsent,retentionMs,clock:()=>pageNow()+offset,retentionClock:wallNow});
  if(memory.checkpointWallMs!=null){const elapsed=wallNow()-memory.checkpointWallMs;if(!Number.isFinite(elapsed)||elapsed<0)throw Error('wall clock rollback');offset=Math.max(0,memory.checkpointMonotonicMs+elapsed+1-pageNow());}
  await memory.advanceTime(pageNow()+offset);
  const journal=await ProviderJournal.open({storage,sessionId,retentionConsent,expiresAt:memory.expiresAt,now:wallNow});
  let closed=false,memoryClosed=false;
  return {memory,journal,offset,sessionId,async close({remove=false}={}){if(closed)throw Error('session already closed');await journal.close();if(!memoryClosed){await memory.close();memoryClosed=true;}if(remove)await deleteSlot(storage,sessionId);closed=true;try{await storage.close?.();}finally{release();await operation;}}};
 }catch(error){try{await storage.close?.();}finally{release();await operation;}throw error;}
}

export async function deleteDurableSlot({sessionId,locks=globalThis.navigator?.locks,storage=new IndexedDBStorage()}={}) {
 if(!locks?.request || sessionId!=='local-research')throw Error('exclusive lock required');
 return locks.request(`prometheus-session-${sessionId}`,{ifAvailable:true},async lock=>{if(!lock)throw Error('session is open elsewhere');try{await deleteSlot(storage,sessionId);}finally{await storage.close?.();}});
}
