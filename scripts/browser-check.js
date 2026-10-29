import {createWorld} from '/src/spatial/world.js';
import {IndexedDBStorage} from '/src/memory/index.js';
const out=document.querySelector('#results');let report=null;
async function run(){
 report={schemaVersion:1,webgl:{pass:false,centerRGBA:null,hit:'unavailable',depth:null},indexedDB:{previousPageLoad:false,closeReopen:false}};
 try{const canvas=document.querySelector('#canvas'),world=createWorld(canvas);world.render(0);const gl=canvas.getContext('webgl'),px=new Uint8Array(4);gl.readPixels(320,239,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px);const hit=world.raycast(320.5,240.5),depth=world.getDepthAt(320.5,240.5);report.webgl={centerRGBA:[...px],hit:hit.status,depth:depth.value??null,pass:px[0]>px[1]*2&&px[0]>px[2]*2&&hit.status==='hit'&&depth.status==='ok'&&Math.abs(depth.value-4.1)<.01};world.dispose();}catch{}
 try{const storage=new IndexedDBStorage({databaseName:'prometheus-browser-check'}),previous=await storage.load('probe');await storage.save('probe',{value:'persisted synthetic test'});await storage.close();const next=new IndexedDBStorage({databaseName:'prometheus-browser-check'}),read=await next.load('probe');await next.close();report.indexedDB={previousPageLoad:previous?.value==='persisted synthetic test',closeReopen:read?.value==='persisted synthetic test'};}catch{}
 out.textContent=JSON.stringify(report,null,2);
 try{const r=await fetch('/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)});document.querySelector('#status').textContent=r.ok?'Result saved. Reload this page, then run again to check persistence.':'Result could not be saved.';}catch{document.querySelector('#status').textContent='Result could not be saved.';}
}
document.querySelector('#run').addEventListener('click',run);
document.querySelector('#reload').addEventListener('click',()=>location.reload());
document.querySelector('#download').addEventListener('click',()=>{if(!report)return;const a=document.createElement('a');const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));a.href=url;a.download='browser-check.json';a.click();URL.revokeObjectURL(url);});
