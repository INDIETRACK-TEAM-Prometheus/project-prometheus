import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const width = 256, height = 256;
export const square = Object.freeze({x:32,y:48,width:80,height:80});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i=0;i<8;i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name=Buffer.from(type), out=Buffer.alloc(12+data.length);
  out.writeUInt32BE(data.length); name.copy(out,4); data.copy(out,8); out.writeUInt32BE(crc32(Buffer.concat([name,data])),8+data.length); return out;
}
export function makeScene() {
  const rows=Buffer.alloc((width*3+1)*height), truth=new Uint8Array(width*height);
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const red=x>=square.x && x<square.x+square.width && y>=square.y && y<square.y+square.height;
    const blue=(x-186)**2+(y-90)**2<36**2;
    const green=x>=120 && x<208 && y>=170 && y<220;
    const rgb=red?[230,35,35]:blue?[35,70,225]:green?[35,180,70]:[245,245,245];
    truth[y*width+x]=Number(red); const offset=y*(width*3+1)+1+x*3;
    rows[offset]=rgb[0]; rows[offset+1]=rgb[1]; rows[offset+2]=rgb[2];
  }
  const header=Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height,4); header[8]=8; header[9]=2;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
  return {png,truth,sha256:createHash('sha256').update(png).digest('hex')};
}
export function iou(mask, truth) {
  if (mask.length!==truth.length) throw new Error('mask size mismatch');
  let intersection=0,union=0; for(let i=0;i<truth.length;i++){ const a=!!mask[i],b=!!truth[i]; if(a&&b) intersection++; if(a||b) union++; }
  return union ? intersection/union : 0;
}

// The parser uses half-open source bounds; raster scaling here uses nearest pixel centers.
export function projectMask(mask, sourceWidth, sourceHeight) {
  const b=mask?.bounds, w=mask?.width, h=mask?.height;
  if (!b || ![sourceWidth,sourceHeight,w,h,b.left,b.top,b.right,b.bottom].every(Number.isInteger) || sourceWidth<1 || sourceHeight<1 || w<1 || h<1 || b.left<0 || b.top<0 || b.right>sourceWidth || b.bottom>sourceHeight || b.right<=b.left || b.bottom<=b.top || mask.sourceWidth!==sourceWidth || mask.sourceHeight!==sourceHeight || !Array.isArray(mask.raster) || mask.raster.length!==w*h || !mask.raster.every(v=>v===0||v===1)) throw new Error('invalid mask');
  const result=new Uint8Array(sourceWidth*sourceHeight), bw=b.right-b.left, bh=b.bottom-b.top;
  for(let y=b.top;y<b.bottom;y++) for(let x=b.left;x<b.right;x++) {
    const sx=Math.floor((x-b.left+0.5)*w/bw), sy=Math.floor((y-b.top+0.5)*h/bh);
    result[y*sourceWidth+x]=mask.raster[sy*w+sx];
  }
  return result;
}
