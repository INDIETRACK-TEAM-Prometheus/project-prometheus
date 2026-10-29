export function flipRgba(bytes,width,height) {
  if (!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||!(bytes instanceof Uint8Array)||bytes.length!==width*height*4) throw new Error('invalid framebuffer');
  const out=new Uint8ClampedArray(bytes.length), stride=width*4;
  for(let y=0;y<height;y++)out.set(bytes.subarray((height-1-y)*stride,(height-y)*stride),y*stride);
  return out;
}
export function maskOverlay(masks,width,height) {
  const out=new Uint8ClampedArray(width*height*4);
  for(const m of masks) {
    const b=m?.bounds,w=m?.width,h=m?.height;
    if(m?.sourceWidth!==width||m?.sourceHeight!==height||![w,h,b?.left,b?.top,b?.right,b?.bottom].every(Number.isInteger)||w<1||h<1||b.left<0||b.top<0||b.right>width||b.bottom>height||b.right<=b.left||b.bottom<=b.top||!Array.isArray(m.raster)||m.raster.length!==w*h||!m.raster.every(v=>v===0||v===1))throw new Error('invalid mask');
    const bw=b.right-b.left,bh=b.bottom-b.top;
    for(let y=b.top;y<b.bottom;y++)for(let x=b.left;x<b.right;x++)if(m.raster[Math.floor((y-b.top+.5)*h/bh)*w+Math.floor((x-b.left+.5)*w/bw)]){const i=(y*width+x)*4;out[i]=255;out[i+1]=210;out[i+2]=0;out[i+3]=120;}
  }
  return out;
}
export function createSceneDiagnostic({encode,request,display,pin=()=>true,release=()=>{},sampleDepth=()=>null}) {
  let generation=0, controller=null, releaseCurrent=null;
  return {
    async run(frame,rgba,prompt='red object') {
      if(typeof prompt!=='string'||!prompt.trim()||prompt.length>256)return {status:'failed'};
      if(controller)return {status:'busy'};
      const token=++generation, abort=new AbortController();controller=abort;
      try {if(!pin(frame)){controller=null;return {status:'failed'};}} catch {controller=null;return {status:'failed'};}
      let held=true;const releaseOnce=()=>{if(held){held=false;release(frame);}};releaseCurrent=releaseOnce;
      try {
        const pixels=flipRgba(rgba,frame.width,frame.height), imageDataUrl=await encode(pixels,frame.width,frame.height);
        if(token!==generation)return {status:'cancelled'};
        const result=await request({frame:{frameId:frame.frameId,observedAt:frame.observedAt},imageDataUrl,prompt},abort.signal);
        if(token!==generation)return {status:'cancelled'};
        if(result?.frame?.frameId!==frame.frameId||result.frame.observedAt!==frame.observedAt||!Array.isArray(result.masks))throw new Error('frame mismatch');
        const overlay=maskOverlay(result.masks,frame.width,frame.height);
        let depth=null;
        try {const sampled=sampleDepth(frame);if(sampled?.frameId===frame.frameId && sampled.observedAt===frame.observedAt)depth=sampled;} catch {}
        display({frame,pixels,overlay,depth,count:result.masks.length,provider:result.provider,model:result.model});
        return {status:'ok'};
      } catch {return {status:token===generation?'failed':'cancelled'};}
      finally {releaseOnce();if(token===generation){controller=null;releaseCurrent=null;}}
    },
    cancel(){generation++;controller?.abort();releaseCurrent?.();releaseCurrent=null;controller=null;}
  };
}
