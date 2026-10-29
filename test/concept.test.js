import test from 'node:test';
import assert from 'node:assert/strict';
import {validSamConcept} from '../src/app.js';
test('SAM concept must be nonblank and bounded',()=>{ assert.equal(validSamConcept('  '),false); assert.equal(validSamConcept('x'.repeat(257)),false); assert.equal(validSamConcept(' red cube '),true); });
