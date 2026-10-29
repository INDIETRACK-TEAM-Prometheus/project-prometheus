import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLocalServer } from '../server.js';

const input = {frame:{frameId:'frame-1',observedAt:42}, imageDataUrl:'data:image/png;base64,iVBORw0KGgo=', prompt:'cup'};
async function withServer(sam, run, options = {}) {
  const server = createLocalServer({sam,...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`,server.address().port); }
  finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
}
const post = (base, body=input, headers={}) => fetch(`${base}/api/sam/segment`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});

test('SAM route forwards only validated image and prompt and returns frame provenance', async()=>{
  let sent;
  await withServer(async args => { sent=args; return {masks:[{objectId:'1'}]}; },async base=>{
    const response=await post(base); assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{frame:input.frame,masks:[{objectId:'1'}]});
    assert.equal(sent.imageDataUrl,input.imageDataUrl); assert.equal(sent.prompt,'cup'); assert.ok(sent.signal instanceof AbortSignal);
    assert.equal(response.headers.get('cache-control'),'no-store');
  });
});
test('SAM route rejects cross-origin, invalid media, malformed input, and oversize bodies before provider',async()=>{
  let calls=0;
  await withServer(async()=>{calls++;},async base=>{
    assert.equal((await post(base,input,{origin:'https://evil.example'})).status,403);
    assert.equal((await post(base,input,{'sec-fetch-site':'cross-site'})).status,403);
    assert.equal((await post(base,input,{'content-type':'text/plain'})).status,415);
    for (const body of [{...input,prompt:''},{...input,frame:{...input.frame,hidden:'secret'}},{...input,imageDataUrl:'data:image/png;base64,YWJj'},{...input,extra:true}]) assert.equal((await post(base,body)).status,400);
    assert.equal((await post(base,{...input,prompt:'x'.repeat(8*1024*1024)})).status,413);
    assert.equal(calls,0);
  });
});
test('SAM route rejects untrusted Host and sanitizes provider errors',async()=>{
  await withServer(async()=>{throw Object.assign(new Error('secret provider details'),{code:'SAM_UPSTREAM_ERROR'});},async(base,port)=>{
    const status=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:'/api/sam/segment',method:'POST',headers:{host:`evil.example:${port}`,'content-type':'application/json'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end(JSON.stringify(input));});
    assert.equal(status,403);
    const response=await post(base); assert.equal(response.status,502); assert.deepEqual(await response.json(),{error:'provider_failed'});
  });
});
test('SAM route bounds concurrent provider calls',async()=>{
  let releases=[];
  await withServer(()=>new Promise(resolve=>releases.push(()=>resolve({masks:[]}))),async base=>{
    const first=post(base), second=post(base);
    while(releases.length<2) await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal((await post(base)).status,429);
    releases.forEach(release=>release());
    assert.equal((await first).status,200); assert.equal((await second).status,200);
  });
});

test('timeout responds without freeing a slot while a provider ignores cancellation',async()=>{
  const releases=[];
  await withServer(()=>new Promise(resolve=>releases.push(()=>resolve({masks:[]}))),async base=>{
    const first=post(base), second=post(base);
    assert.equal((await first).status,504); assert.equal((await second).status,504);
    assert.equal((await post(base)).status,429);
    releases.forEach(release=>release());
  },{samTimeoutMs:20});
});

test('provider HTTP status is included only for recognized upstream errors',async()=>{
 await withServer(async()=>{throw Object.assign(new Error('secret'),{code:'PROVIDER_HTTP_ERROR',status:403});},async base=>{const response=await post(base);assert.equal(response.status,502);assert.deepEqual(await response.json(),{error:'provider_failed',upstreamStatus:403});});
 await withServer(async()=>{throw Object.assign(new Error('secret'),{code:'OTHER',status:403});},async base=>{const response=await post(base);assert.deepEqual(await response.json(),{error:'provider_failed'});});
});

test('diagnostic module is served while provider internals stay private',async()=>{
 await withServer(async()=>({masks:[]}),async base=>{
  assert.equal((await fetch(base+'/src/spatial/scene-diagnostic.js')).status,200);
  for(const path of ['/server/reasoner-adapter.js','/server/sam-adapter.js','/.env']) assert.equal((await fetch(base+path)).status,404);
 });
});

test('provider diagnostics expose fixed codes only',async()=>{
 await withServer(async()=>{throw Object.assign(new Error('secret'),{code:'SAM_INVALID_RESPONSE'});},async base=>{assert.deepEqual(await (await post(base)).json(),{error:'provider_failed',providerCode:'SAM_INVALID_RESPONSE'});});
 await withServer(async()=>{throw Object.assign(new Error('secret'),{code:'secret-provider-data'});},async base=>{assert.deepEqual(await (await post(base)).json(),{error:'provider_failed'});});
});

test('perception browser module and its spatial dependency are served, server code remains private',async()=>{
 await withServer(async()=>({masks:[]}),async base=>{
  for(const path of ['/src/runtime/perception.js','/src/spatial/tracker.js','/src/spatial/geometry.js']) assert.equal((await fetch(base+path)).status,200,path);
  assert.equal((await fetch(base+'/src/gaze/frozen-demo.js')).status,200);
  for(const path of ['/server/reasoner-adapter.js','/server/sam-adapter.js','/.env']) assert.equal((await fetch(base+path)).status,404,path);
 });
});
