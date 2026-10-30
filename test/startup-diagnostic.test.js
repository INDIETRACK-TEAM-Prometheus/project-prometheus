import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoordinator,startupFailureDiagnostic} from '../src/app.js';

test('startup diagnostics expose only an allowlisted code and its fixed step',()=>{
  const error=Object.assign(new Error('private browser detail'),{code:'camera_permission_denied',step:'private browser detail'});
  assert.deepEqual(startupFailureDiagnostic(error),{code:'camera_permission_denied',step:'camera'});
  assert.deepEqual(startupFailureDiagnostic(Object.assign(new Error('private detail'),{code:'camera_permission_denied_extra'})),{code:'startup_failed',step:'startup'});
  assert.deepEqual(startupFailureDiagnostic(new Error('private detail')),{code:'startup_failed',step:'startup'});
  assert.deepEqual(startupFailureDiagnostic({code:'worker_inference_failed'}),{code:'worker_inference_failed',step:'worker_inference'});
  assert.deepEqual(startupFailureDiagnostic({code:'runtime_start_failed'}),{code:'runtime_start_failed',step:'runtime_start'});
  assert.deepEqual(startupFailureDiagnostic({code:'capture_frame_failed'}),{code:'capture_frame_failed',step:'capture'});
});

test('runtime startup failure has a fixed stage and stops the acquired camera',async()=>{
  const diagnostics=[],calls=[];
  const app=createCoordinator({
    controller:{async start(){return {width:640};},stop(){calls.push('camera_stop');}},
    memory:{},
    runtime:{start(){throw new Error('private runtime detail');},stop(){calls.push('runtime_stop');}},
    onDiagnostic:code=>diagnostics.push(startupFailureDiagnostic({code}))
  });
  const result=await app.start();
  assert.equal(result.reason,'start_failed');
  assert.equal(result.error.code,'runtime_start_failed');
  assert.equal(result.error.message.includes('private runtime detail'),false);
  assert.deepEqual(calls,['runtime_stop','camera_stop']);
  assert.deepEqual(diagnostics.map(item=>item.code),['runtime_start_started','runtime_start_failed','runtime_stop_requested','runtime_stopped']);
  assert.ok(diagnostics.every(item=>Object.keys(item).join(',')==='code,step'));
});
