import { samProviderPolicy, providerHttpError, providerNetworkError } from './provider-policy.js';
import { formats, recordsOfKind, decodeMaskToRaster } from '@meta-sam/parser';

const MAX_RESPONSE = 16 * 1024 * 1024;
const MAX_AREA = 4096 * 4096;
const MAX_MASKS = 100;
const fail = code => Object.assign(new Error(code), { code });

async function readResponse(response) {
  if (!response.body) throw fail('SAM_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE) throw fail('SAM_INVALID_RESPONSE');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseOutput(data) {
  if (data.status !== 'completed' || data.model !== 'sam-3.1' || !Array.isArray(data.output)) throw fail('SAM_INVALID_RESPONSE');
  const parts = data.output.flatMap(item => item.type === 'message' && Array.isArray(item.content) ? item.content : []);
  if (parts.length !== 1 || parts[0].type !== 'output_text' || typeof parts[0].text !== 'string') throw fail('SAM_INVALID_RESPONSE');
  const text = parts[0].text;
  const dimensions = [...text.matchAll(/(?:^|;)data\s*=\s*(\d+)\s*,\s*(\d+)\s*,/g)];
  if (dimensions.reduce((sum, [, h, w]) => sum + +h * +w, 0) > MAX_AREA || dimensions.length > MAX_MASKS || dimensions.some(([, h, w]) => !Number.isSafeInteger(+h * +w) || +h < 1 || +w < 1 || +h > 4096 || +w > 4096 || +h * +w > MAX_AREA)) throw fail('SAM_INVALID_RESPONSE');
  const parser = formats.segmentation.image().createParser();
  parser.push(text);
  const result = parser.finish({ status: 'completed' }).result;
  if (result.diagnostics.some(d => d.severity === 'error') || result.records.some(r => r.kind === 'text')) throw fail('SAM_INVALID_RESPONSE');
  const masks = recordsOfKind(result.records, 'mask');
  const boxes = [...text.matchAll(/<\|box;([^|]*)\|>/g)].map(([, fields]) => {
    const values = Object.fromEntries(fields.split(';').map(field => field.split('=').map(value => value.trim())));
    return { sourceWidth: Number(values.w), sourceHeight: Number(values.h) };
  });
  if (masks.length !== dimensions.length || masks.length !== boxes.length || boxes.some(({ sourceWidth, sourceHeight }) => !Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1 || sourceWidth > 4096 || sourceHeight > 4096)) throw fail('SAM_INVALID_RESPONSE');
  return masks.map((record, i) => ({ objectId: record.objectId, bounds: record.bounds, ...boxes[i], width: record.mask.width, height: record.mask.height, raster: Array.from(decodeMaskToRaster(record.mask)), confidence: record.confidence ?? null }));
}

export async function segmentSam({ imageDataUrl, prompt, signal }) {
  if (!process.env.META_API_KEY) throw fail('SAM_NOT_CONFIGURED');
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (signal?.aborted) throw fail('SAM_CANCELLED');
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
  const started = performance.now();
  try {
    return await samProviderPolicy.run({cost:0.0025, signal}, async () => {
    let response;
    try { response = await fetch('https://api.meta.ai/v1/responses', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${process.env.META_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sam-3.1', stream: false, store: false, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageDataUrl }] }], metadata: { mask_encoding: 'one_bit', include_confidence: 'true' } })
    }); } catch { throw providerNetworkError(); }
    if (response.status === 429) throw providerHttpError(429);
    if (!response.ok) throw fail('SAM_UPSTREAM_ERROR');
    const data = await readResponse(response);
    let masks;
    try { masks = parseOutput(data); } catch { throw fail('SAM_INVALID_RESPONSE'); }
    const requestId = typeof data.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(data.id) ? data.id : null;
    return { masks, provider: 'Meta', model: data.model, requestId, latencyMs: Math.round(performance.now() - started), parserVersion: '0.1.0' };
    });
  } catch (error) {
    if (timedOut) throw fail('SAM_TIMEOUT');
    if (signal?.aborted) throw fail('SAM_CANCELLED');
    if (typeof error.code === 'string' && error.code.startsWith('PROVIDER_')) throw error;
    if (error.code === 'SAM_UPSTREAM_ERROR' || error.code === 'SAM_INVALID_RESPONSE') throw error;
    throw fail(error instanceof SyntaxError ? 'SAM_INVALID_RESPONSE' : 'SAM_UPSTREAM_ERROR');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}



