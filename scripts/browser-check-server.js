import http from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files={'/':'scripts/browser-check.html','/check.js':'scripts/browser-check.js','/src/spatial/world.js':'src/spatial/world.js','/src/spatial/geometry.js':'src/spatial/geometry.js','/src/memory/index.js':'src/memory/index.js'};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
function valid(r){return exact(r,['schemaVersion','webgl','indexedDB'])&&r.schemaVersion===1&&exact(r.webgl,['pass','centerRGBA','hit','depth'])&&typeof r.webgl.pass==='boolean'&&(r.webgl.centerRGBA===null||Array.isArray(r.webgl.centerRGBA)&&r.webgl.centerRGBA.length===4&&r.webgl.centerRGBA.every(x=>Number.isInteger(x)&&x>=0&&x<=255))&&['hit','no_hit','unavailable'].includes(r.webgl.hit)&&(r.webgl.depth===null||Number.isFinite(r.webgl.depth)&&r.webgl.depth>=0&&r.webgl.depth<10000)&&exact(r.indexedDB,['closeReopen','previousPageLoad'])&&typeof r.indexedDB.closeReopen==='boolean'&&typeof r.indexedDB.previousPageLoad==='boolean';}
export function createBrowserCheckServer(){return http.createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(req.method==='POST'&&pathname==='/report'){
  const port=req.socket.localPort,host=req.headers.host;
  if(!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.localAddress)||host!==`127.0.0.1:${port}`||req.headers.origin!==`http://${host}`||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||'')){req.resume();res.writeHead(403).end();return;}
  let size=0,chunks=[],large=false;for await(const chunk of req){size+=chunk.length;if(size>65536){large=true;chunks=[];}else if(!large)chunks.push(chunk);}if(large){res.writeHead(413).end();return;}
  let report;try{report=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{res.writeHead(400).end();return;}
  if(!valid(report)){res.writeHead(400).end();return;}
  try{await mkdir(path.join(root,'docs/evidence'),{recursive:true});await writeFile(path.join(root,'docs/evidence/browser-live.json'),JSON.stringify({receivedAt:new Date().toISOString(),source:'browser_reported',...report},null,2)+'\n');res.writeHead(204,{'Cache-Control':'no-store'}).end();}catch{res.writeHead(500).end();}return;
 }
 if(req.method!=='GET'||!files[pathname]){res.writeHead(404).end();return;}
 try{const data=await readFile(path.join(root,files[pathname]));res.writeHead(200,{'Content-Type':pathname==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(data);}catch{res.writeHead(500).end();}
});}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))createBrowserCheckServer().listen(4183,'127.0.0.1',()=>console.log('Browser check: http://127.0.0.1:4183/'));
