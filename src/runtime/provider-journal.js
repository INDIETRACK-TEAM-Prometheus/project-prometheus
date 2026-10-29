// A journal instance requires exclusive ownership of its storage key for its lifetime.
// Pending entries deliberately remain uncertain after a crash or failed call.
export class ProviderJournal {
  static async open({storage, sessionId, retentionConsent=false, expiresAt=null, now=Date.now, maxEntries=1024}={}) {
    if (!storage || typeof storage.load!=='function' || typeof storage.save!=='function' || typeof storage.delete!=='function' || !/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId) || typeof now!=='function' || !Number.isInteger(maxEntries) || maxEntries<1 || maxEntries>1024) throw new TypeError('invalid journal configuration');
    if (storage.durable && (retentionConsent!==true || !Number.isSafeInteger(expiresAt) || expiresAt<=now())) throw new Error('durable journal requires retention consent and expiry');
    const key=`provider-journal:${sessionId}`;
    const saved=await storage.load(key);
    if(saved && (saved.schemaVersion!==1 || saved.expiresAt!==expiresAt || !Array.isArray(saved.entries) || saved.entries.length>maxEntries || saved.entries.some(e=>!e || !/^[a-f0-9]{64}$/.test(e.id) || !['uncertain','completed'].includes(e.state)) || new Set(saved.entries.map(e=>e.id)).size!==saved.entries.length)) throw new Error('invalid provider journal');
    return new ProviderJournal({storage,key,expiresAt,now,maxEntries,entries:saved?.entries??[]});
  }
  constructor(options) { Object.assign(this,options); this.queue=Promise.resolve(); this.inflight=new Set(); this.closed=false; }
  async run(id, call) {
    if (this.closed) throw new Error('journal closed');
    if (!/^[a-f0-9]{64}$/.test(id) || typeof call!=='function') throw new TypeError('opaque operation digest and call required');
    const claim=this.queue.then(async()=>{
      if(this.expiresAt!==null && this.now()>=this.expiresAt) throw new Error('journal expired');
      const previous=this.entries.find(e=>e.id===id);
      if(previous) throw new Error(`provider call ${previous.state}`);
      if(this.entries.length>=this.maxEntries) throw new Error('provider journal full');
      const entries=[...this.entries,{id,state:'uncertain'}];
      await this.storage.save(this.key,{schemaVersion:1,expiresAt:this.expiresAt,entries});
      this.entries=entries;
    });
    this.queue=claim.catch(()=>{});
    const operation=(async()=>{
    await claim;
    if(this.expiresAt!==null && this.now()>=this.expiresAt) throw new Error('journal expired');
    const result=await call();
    const complete=this.queue.then(async()=>{
      if(this.expiresAt!==null && this.now()>=this.expiresAt) throw new Error('journal expired');
      const entries=this.entries.map(e=>e.id===id?{id,state:'completed'}:e);
      await this.storage.save(this.key,{schemaVersion:1,expiresAt:this.expiresAt,entries});
      this.entries=entries;
    });
    this.queue=complete.catch(()=>{});
    await complete;
    return result;
    })();
    this.inflight.add(operation);
    try { return await operation; } finally { this.inflight.delete(operation); }
  }
  async close({remove=false}={}) { this.closed=true; await Promise.allSettled([...this.inflight]); await this.queue; if(remove) { await this.storage.delete(this.key); this.entries=[]; } }
  async delete() { return this.close({remove:true}); }
}

// The digest is an operation identity, not a provider idempotency key.
export async function providerOperationId(sessionId, route, frameId) {
  if (![sessionId,route,frameId].every(x=>typeof x==='string' && x.length>0 && x.length<=256)) throw new TypeError('invalid operation identity');
  const bytes=new TextEncoder().encode(JSON.stringify([sessionId,route,frameId]));
  const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
