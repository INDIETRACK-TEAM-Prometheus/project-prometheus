import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentSam } from '../server/sam-adapter.js';
import { sharedProviderPolicy } from '../server/provider-policy.js';
sharedProviderPolicy.minIntervalMs = 0;

const fixture = '<0f>0<|box;x1=10;y1=20;x2=14;y2=24;w=100;h=80;c=0.75|><|mask;x=0;y=0;c=0.75;data=5,5,!!!!!(QO(0lu8?|>';
const originalFetch = globalThis.fetch;
const originalKey = process.env.META_API_KEY;
function response(text, extra = {}) { return new Response(JSON.stringify({ status: 'completed', model: 'sam-3.1', id: 'resp_123', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], ...extra }), { status: 200 }); }
test.after(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.META_API_KEY; else process.env.META_API_KEY = originalKey; });
test('sends SAM request and decodes a real protocol mask with half-open bounds', async () => {
  process.env.META_API_KEY = 'test-secret';
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.meta.ai/v1/responses');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'sam-3.1');
    assert.equal(body.store, false);
    assert.deepEqual(body.metadata, { mask_encoding: 'one_bit', include_confidence: 'true' });
    assert.equal(body.input[0].content[1].image_url, 'data:image/png;base64,AA==');
    return response(fixture);
  };
  const result = await segmentSam({ imageDataUrl: 'data:image/png;base64,AA==', prompt: 'cup' });
  assert.deepEqual(result.masks[0].bounds, { left: 10, top: 20, right: 15, bottom: 25 });
  assert.equal(result.masks[0].sourceWidth, 100);
  assert.equal(result.masks[0].sourceHeight, 80);
  assert.equal(result.masks[0].raster.length, 25);
  assert.ok(result.masks[0].raster.every(x => x === 0 || x === 1));
  assert.equal(result.masks[0].confidence, 0.75);
  assert.equal(result.model, 'sam-3.1');
  assert.equal(result.requestId, 'resp_123');
});
test('accepts empty matches and rejects malformed or unexpected provider output', async () => {
  globalThis.fetch = async () => response('');
  assert.deepEqual((await segmentSam({ prompt: 'cup', imageDataUrl: 'data:' })).masks, []);
  for (const reply of [response('<0f>'), response(fixture, { model: 'other' }), response(fixture, { output: [null] }), response(fixture, { output: null }), response(fixture.replace('5,5,', '99999,5,'))]) {
    globalThis.fetch = async () => reply;
    await assert.rejects(segmentSam({ prompt: 'cup', imageDataUrl: 'data:' }), { code: 'SAM_INVALID_RESPONSE' });
  }
});
test('sanitizes upstream failures and supports cancellation', async () => {
  globalThis.fetch = async () => { throw new Error('test-secret'); };
  await assert.rejects(segmentSam({ prompt: 'cup', imageDataUrl: 'data:' }), { message: 'PROVIDER_NETWORK_ERROR' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(segmentSam({ prompt: 'cup', imageDataUrl: 'data:', signal: controller.signal }), { code: 'SAM_CANCELLED' });
});


