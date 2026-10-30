import test from 'node:test';
import assert from 'node:assert/strict';
import {startupFailureDiagnostic} from '../src/app.js';

test('startup diagnostics expose only an allowlisted code and its fixed step',()=>{
  const error=Object.assign(new Error('private browser detail'),{code:'camera_permission_denied',step:'private browser detail'});
  assert.deepEqual(startupFailureDiagnostic(error),{code:'camera_permission_denied',step:'camera'});
  assert.deepEqual(startupFailureDiagnostic(Object.assign(new Error('private detail'),{code:'camera_permission_denied_extra'})),{code:'startup_failed',step:'startup'});
  assert.deepEqual(startupFailureDiagnostic(new Error('private detail')),{code:'startup_failed',step:'startup'});
});
