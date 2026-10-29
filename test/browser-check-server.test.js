import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserCheckServer} from '../scripts/browser-check-server.js';
test('browser evidence endpoint rejects cross-origin, malformed and oversized reports',async()=>{
 const server=createBrowserCheckServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const base=`http://127.0.0.1:${server.address().port}`;const send=(body,origin=base)=>fetch(base+'/report',{method:'POST',headers:{'content-type':'application/json',origin},body});
 assert.equal((await send('{}','https://evil.example')).status,403);assert.equal((await send('{"path":"x"}')).status,400);assert.equal((await send('x'.repeat(65537))).status,413);assert.equal((await fetch(base+'/server.js')).status,404);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
