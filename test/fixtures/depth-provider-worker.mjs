const model = {
  id: 'depth-anything/Depth-Anything-V2-Metric-Hypersim-Small',
  sha256: 'b782898d8a3e8be1f639de33837ed85e9b4b73e40f8f5e5cd99067588d722545',
  license: 'Apache-2.0',
  sourceUrl: 'https://github.com/DepthAnything/Depth-Anything-V2',
  sourceCommit: 'a561b849ebae10a6f5ef49e26c83cbbcd36c71bf',
  encoder: 'vits', dataset: 'hypersim', maxDepthM: 20, units: 'm', convention: 'axial_z', device: 'cpu',
};
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
write({type:'ready',status:'ready',model,modelLoadMs:17,pythonVersion:'3.12.10',torchVersion:'2.6.0+cpu',device:'cpu'});
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const newline = buffer.indexOf('\n');
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    const frame = process.env.DEPTH_TEST_MODE === 'mismatch' ? {...request.frame,frameId:'wrong-frame'} : request.frame;
    const count = request.frame.width * request.frame.height;
    const values = Buffer.alloc(count * 4);
    for (let i=0;i<count;i++) values.writeFloatLE(2.5,i*4);
    const mask = Buffer.alloc(count, 1);
    const response = {
      id:request.id,status:'ok',frame,width:request.frame.width,height:request.frame.height,
      valuesF32LE:values.toString('base64'),validMaskU8:mask.toString('base64'),units:'m',convention:'axial_z',depthSource:'monocular_estimated_depth',model,
      timing:{decodeMs:2,inferenceMs:11,totalMs:13},summary:{validCount:count,invalidCount:0,minM:2.5,medianM:2.5,maxM:2.5},
    };
    const delay = Number(process.env.DEPTH_TEST_DELAY_MS) || 0;
    setTimeout(() => write(response), delay);
  }
});
