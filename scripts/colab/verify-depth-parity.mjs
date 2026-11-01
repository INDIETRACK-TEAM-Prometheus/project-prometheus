// Compares local CPU output with paired legacy/optimized Colab transport runs on one synthetic image.
// It sends only the given scene image to Colab, never webcam data.
// Usage: node scripts/colab/verify-depth-parity.mjs --image scene.png --output report.json [--remote http://127.0.0.1:49190/] [--runs 12]
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createDepthProvider, createRemoteDepthProvider } from '../../server/depth-provider.js';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const imagePath = arg('image'), output = arg('output'), remoteUrl = arg('remote') ?? 'http://127.0.0.1:49190/', runs = Number(arg('runs') ?? 12);
if (!imagePath || !output || !Number.isInteger(runs) || runs < 11 || runs > 50) { console.error('usage: --image PNG --output JSON [--remote URL] [--runs N>=11]'); process.exit(2); }
const bytes = await readFile(imagePath);
if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { console.error('PNG required'); process.exit(2); }
const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
const imageDataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
const percentile = (values, p) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const summarize = (values, warmStart = 1) => {
  const warm = values.slice(warmStart);
  return {
    first: values[0] ?? null, sampleCount: values.length, samples: values, warmSampleCount: warm.length, warmSamples: warm,
    warmP50: warm.length ? percentile(warm, .5) : null,
    warmP95: warm.length ? percentile(warm, .95) : null,
    warmMax: warm.length ? Math.max(...warm) : null,
  };
};

async function measure(provider, count = runs) {
  const results = [];
  for (let i = 0; i < count; i++) results.push(await provider.infer({ frame: { frameId: `parity-${i}`, observedAt: i, width, height }, imageDataUrl }));
  const round = results.map(r => r.timing.requestRoundTripMs), inference = results.map(r => r.timing.inferenceMs);
  return {
    first: results[0], model: results[0].model,
    samples: results.map((r, i) => ({ run: i + 1, cold: i === 0, requestRoundTripMs: round[i], inferenceMs: inference[i], totalMs: r.timing.totalMs })),
    roundTripMs: summarize(round), inferenceMs: summarize(inference),
  };
}

const blockSamples = Math.ceil((runs - 1) / 2);
const pairedWarmSamples = blockSamples * 2;
async function measureTransportPair(legacy, optimized) {
  const providers = { legacy, optimized }, runsByMode = { legacy: [], optimized: [] }, warmups = { legacy: [], optimized: [] };
  const blockOrders = [['legacy', 'optimized'], ['optimized', 'legacy']];
  for (let block = 0; block < blockOrders.length; block++) {
    const pairIds = Array.from({ length: blockSamples }, (_, i) => ({ frameId: `transport-pair-${block + 1}-${i + 1}`, observedAt: block * blockSamples + i }));
    for (const mode of blockOrders[block]) {
      const warmupStarted = performance.now();
      const warmup = await providers[mode].infer({ frame: { frameId: `transport-warmup-${mode}-${block + 1}`, observedAt: 1000 + block, width, height }, imageDataUrl });
      warmups[mode].push({ block: block + 1, requestRoundTripMs: warmup.timing.requestRoundTripMs, inferenceMs: warmup.timing.inferenceMs, totalMs: warmup.timing.totalMs, elapsedMs: Math.round((performance.now() - warmupStarted) * 1000) / 1000 });
      for (let i = 0; i < pairIds.length; i++) {
        const pair = pairIds[i];
        const result = await providers[mode].infer({ frame: { ...pair, width, height }, imageDataUrl });
        runsByMode[mode].push({ pair: `${block + 1}.${i + 1}`, result, requestRoundTripMs: result.timing.requestRoundTripMs, inferenceMs: result.timing.inferenceMs, totalMs: result.timing.totalMs });
      }
    }
  }
  const summarizeMode = mode => {
    const values = runsByMode[mode];
    return {
      model: values[0].result.model,
      pairedWarmSampleCount: values.length,
      samples: values.map((r, i) => ({ run: i + 1, pair: r.pair, requestRoundTripMs: r.requestRoundTripMs, inferenceMs: r.inferenceMs, totalMs: r.totalMs })),
      roundTripMs: summarize(values.map(r => r.requestRoundTripMs), 0),
      inferenceMs: summarize(values.map(r => r.inferenceMs), 0),
      warmups: warmups[mode],
      first: values[0].result,
    };
  };
  return { legacy: summarizeMode('legacy'), optimized: summarizeMode('optimized'), blockOrders, pairedWarmSamples };
}

async function measureHealthBaseline() {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const response = await fetch(new URL('health', remoteUrl));
    const body = await response.json();
    if (!response.ok || body.status !== 'ready') throw new Error('remote health baseline failed');
    samples.push(Math.round((performance.now() - started) * 1000) / 1000);
  }
  return summarize(samples, 0);
}

function compareDepth(a, b) {
  let both = 0, sumAbs = 0, maxAbs = 0, sumRel = 0, maskDisagree = 0;
  for (let i = 0; i < a.values.length; i++) {
    if (a.validMask[i] !== b.validMask[i]) maskDisagree++;
    if (!a.validMask[i] || !b.validMask[i]) continue;
    const d = Math.abs(a.values[i] - b.values[i]);
    both++; sumAbs += d; maxAbs = Math.max(maxAbs, d); sumRel += d / a.values[i];
  }
  return { comparedPixels: both, validMaskDisagreements: maskDisagree, meanAbsDiffM: both ? sumAbs / both : null, maxAbsDiffM: both ? maxAbs : null, meanRelDiff: both ? sumRel / both : null };
}

const local = createDepthProvider();
const legacy = createRemoteDepthProvider({ baseUrl: remoteUrl, transport: 'legacy', startupTimeoutMs: 60_000, requestTimeoutMs: 120_000 });
const optimized = createRemoteDepthProvider({ baseUrl: remoteUrl, transport: 'optimized', startupTimeoutMs: 60_000, requestTimeoutMs: 120_000 });
try {
  const cpu = await measure(local), pair = await measureTransportPair(legacy, optimized), gpu = pair.optimized;
  const healthBaselineMs = await measureHealthBaseline();
  const agreement = compareDepth(cpu.first.depth, gpu.first.depth);
  const transportAgreement = compareDepth(pair.legacy.first.depth, pair.optimized.first.depth);
  const report = {
    kind: 'depth_backend_parity', synthetic: true, gateStatus: 'not_asserted', finishedAtUtc: new Date().toISOString(),
    input: { path: imagePath, sha256: createHash('sha256').update(bytes).digest('hex'), width, height, runsPerBackend: runs, pairedWarmSamplesPerTransport: pair.pairedWarmSamples },
    local: { model: cpu.model, samples: cpu.samples, roundTripMs: cpu.roundTripMs, inferenceMs: cpu.inferenceMs },
    colab: { model: gpu.model, samples: gpu.samples, roundTripMs: gpu.roundTripMs, inferenceMs: gpu.inferenceMs, healthBaselineMs },
    transportComparison: {
      fixturePaired: true, measuredWarmSamplesPerTransport: pair.pairedWarmSamples, blockOrders: pair.blockOrders,
      legacy: { model: pair.legacy.model, pairedWarmSampleCount: pair.legacy.pairedWarmSampleCount, samples: pair.legacy.samples, roundTripMs: pair.legacy.roundTripMs, inferenceMs: pair.legacy.inferenceMs, warmups: pair.legacy.warmups },
      optimized: { model: gpu.model, pairedWarmSampleCount: gpu.pairedWarmSampleCount, samples: gpu.samples, roundTripMs: gpu.roundTripMs, inferenceMs: gpu.inferenceMs, warmups: gpu.warmups },
      agreement: transportAgreement,
    },
    agreement,
    limitations: ['One synthetic scene image; agreement shows backend parity, not depth accuracy.', 'Colab runs a different torch/CUDA build than the local CPU worker; small numeric differences are expected.', 'Round trip includes the SSH tunnel over the public internet and varies with network conditions.', 'The /health RTT is a small-response network baseline only; it is reported separately and is not subtracted from inference latency.', 'Transport measurements share one Colab session and fixture but still reflect public-internet variation; the observed difference is not a general latency guarantee.'],
  };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ agreement: report.agreement, transportAgreement, legacy: report.transportComparison.legacy.roundTripMs, optimized: report.transportComparison.optimized.roundTripMs, healthBaseline: report.colab.healthBaselineMs }, null, 1));
} finally {
  await local.close(); await legacy.close(); await optimized.close();
}
