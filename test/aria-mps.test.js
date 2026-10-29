import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const run = (...args) => spawnSync('python', ['src/aria/mps_csv.py', ...args], {encoding:'utf8'});
test('Gen2 MPS CSV uses device time, offline provenance, cutoff and nulls', () => {
  const dir = mkdtempSync(join(tmpdir(),'aria-test-'));
  try {
    const file = join(dir,'gaze.csv');
    writeFileSync(file, 'tracking_timestamp_us,yaw_rads_cpf,pitch_rads_cpf\n100,0.2,-0.3\n200,0.4,0.5\n');
    const output = run('gaze',file,'--cutoff-us','100'); assert.equal(output.status,0);
    const records = output.stdout.trim().split('\n').map(JSON.parse); assert.equal(records.length,1);
    assert.equal(records[0].captureTsNs,100000); assert.equal(records[0].causalStatus,'offline_assisted');
    assert.equal(records[0].depth,null); assert.equal(records[0].unavailableReasons.depth,'not_in_mps_csv');
    assert.match(records[0].provenance.fileSha256,/^[a-f0-9]{64}$/);
    writeFileSync(file,'tracking_timestamp_us,yaw_rads_cpf,pitch_rads_cpf\n100,NaN,0\n'); assert.notEqual(run('gaze',file).status,0);
    writeFileSync(file,'tracking_timestamp_us,yaw_rads_cpf,pitch_rads_cpf\n200,0,0\n100,0,0\n'); assert.notEqual(run('gaze',file).status,0);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('closed-loop pose preserves map identity and world transform', () => {
  const dir=mkdtempSync(join(tmpdir(),'aria-test-'));
  try { const file=join(dir,'pose.csv'); writeFileSync(file,'graph_uid,tracking_timestamp_us,tx_world_device,ty_world_device,tz_world_device,qx_world_device,qy_world_device,qz_world_device,qw_world_device\nmap,5,1,2,3,0,0,0,1\n'); const out=run('pose',file); assert.equal(out.status,0); const item=JSON.parse(out.stdout); assert.equal(item.mapId,'map'); assert.deepEqual(item.translationM,[1,2,3]); assert.deepEqual(item.quaternionXyzw,[0,0,0,1]); }
  finally { rmSync(dir,{recursive:true,force:true}); }
});
