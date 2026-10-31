import test from 'node:test';
import assert from 'node:assert/strict';
import {associateMasks} from '../src/spatial/mask-association.js';

function fromRows(rows, objectId) {
  const height = rows.length, width = rows[0].length;
  return {objectId, sourceWidth:width, sourceHeight:height, width, height,
    bounds:{left:0,top:0,right:width,bottom:height}, raster:rows.join('').split('').map(Number)};
}

function iou(a, b) {
  let intersection=0,union=0;
  for(let i=0;i<a.raster.length;i++) { intersection += a.raster[i] && b.raster[i] ? 1 : 0; union += a.raster[i] || b.raster[i] ? 1 : 0; }
  return union ? intersection/union : 0;
}

test('uses source-pixel mask IoU and ignores SAM per-image ids',()=>{
  const previous={objectId:'local-object-7',mask:{sourceWidth:4,sourceHeight:4,width:2,height:2,bounds:{left:0,top:0,right:4,bottom:4},raster:[1,0,0,1]}};
  const detection={...fromRows(['1100','1100','0011','0011'],'sam-image-object-1')};
  const result=associateMasks([previous],[detection]);
  assert.deepEqual(result.matches,[{objectId:'local-object-7',detectionIndex:0,iou:1}]);
  assert.equal(result.proposedMatches[0].objectId,'local-object-7');
  assert.deepEqual(result.unmatchedObjectIds,[]);
});

test('appearance disagreement vetoes a spatial mask match',()=>{
  const mask=fromRows(['1100','1100','0011','0011']);
  const result=associateMasks([{objectId:'red-object',mask,appearance:[255,0,0]}],[{mask,appearance:[0,0,255]}]);
  assert.deepEqual(result.matches,[]);
  assert.deepEqual(result.newDetectionIndices,[0]);
});

test('global assignment beats greedy pair selection, then abstains when the IDs remain ambiguous',()=>{
  const tracks=[
    {objectId:'a',mask:fromRows(['0011','1001','1110','0010'])},
    {objectId:'b',mask:fromRows(['0000','0100','1001','0001'])}
  ];
  const detections=[
    fromRows(['0000','0001','0010','1100']),
    fromRows(['1010','0101','0100','0001'])
  ];
  const pairScores=tracks.map(track=>detections.map(detection=>iou(track.mask,detection)));
  const pairs=pairScores.flatMap((row,trackIndex)=>row.map((score,detectionIndex)=>({trackIndex,detectionIndex,score})))
    .filter(pair=>pair.score>=0.1).sort((a,b)=>b.score-a.score);
  const usedTracks=new Set(),usedDetections=new Set();let greedyScore=0;
  for(const pair of pairs) if(!usedTracks.has(pair.trackIndex)&&!usedDetections.has(pair.detectionIndex)) {
    usedTracks.add(pair.trackIndex);usedDetections.add(pair.detectionIndex);greedyScore+=pair.score;
  }

  const result=associateMasks(tracks,detections);
  assert.ok(result.proposedMatches.reduce((sum,match)=>sum+match.iou,0)>greedyScore);
  assert.deepEqual(result.proposedMatches.map(({objectId,detectionIndex})=>[objectId,detectionIndex]),[['a',0],['b',1]]);
  assert.deepEqual(result.matches,[]);
  assert.deepEqual(result.ambiguous.map(item=>item.detectionIndex),[0,1]);
  assert.deepEqual(result.unmatchedObjectIds,['a','b']);
});

test('withholds identity on tied masks, dimension changes, and exceeded work budget',()=>{
  const mask=fromRows(['1100','1100','0011','0011']);
  const tied=associateMasks([{objectId:'a',mask},{objectId:'b',mask}],[mask]);
  assert.deepEqual(tied.matches,[]);
  assert.deepEqual(tied.ambiguous,[{detectionIndex:0,candidateObjectIds:['a','b']}]);

  const changed=associateMasks([{objectId:'a',mask}],[fromRows(['11','11'])]);
  assert.equal(changed.status,'reset');
  assert.equal(changed.reason,'source_dimensions_changed');
  assert.deepEqual(changed.matches,[]);

  const budget=associateMasks([{objectId:'a',mask}],[mask],{maxComparisons:1});
  assert.equal(budget.status,'withheld');
  assert.equal(budget.reason,'comparison_budget_exceeded');
  assert.deepEqual(budget.matches,[]);
});

test('rejects malformed rasters and duplicate local track ids',()=>{
  const mask=fromRows(['10','01']);
  assert.throws(()=>associateMasks([{objectId:'same',mask},{objectId:'same',mask}],[mask]),/invalid mask association input/);
  assert.throws(()=>associateMasks([{objectId:'a',mask:{...mask,raster:[0,2,0,1]}}],[mask]),/invalid mask association input/);
});
