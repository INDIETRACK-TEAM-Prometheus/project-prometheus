// Runs one synthetic scene image through the local CPU worker and the Colab GPU tunnel and records
// output agreement and latency. It sends only the given scene image to Colab, never webcam data.
// Usage: node scripts/colab/verify-depth-parity.mjs --image scene.png --output report.json [--remote http://127.0.0.1:49190/] [--runs 5]
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createDepthProvider, createRemoteDepthProvider } from '../../server/depth-provider.js';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const imagePath = arg('image'), output = arg('output'), remoteUrl = arg('remote') ?? 'http://127.0.0.1:49190/', runs = Number(arg('runs') ?? 5);
if (!imagePath || !output || !Number.isInteger(runs) || runs < 1 || runs > 50) { console.error('usage: --image PNG --output JSON [--remote URL] [--runs N]'); process.exit(2); }
const bytes = await readFile(imagePath);
if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { console.error('PNG required'); process.exit(2); }
const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
const imageDataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
const percentile = (values, p) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

async function measure(provider) {
  const results = [];
  for (let i = 0; i < runs; i++) results.push(await provider.infer({ frame: { frameId: `parity-${i}`, observedAt: i, width, height }, imageDataUrl }));
  const round = results.map(r => r.timing.requestRoundTripMs), inference = results.map(r => r.timing.inferenceMs);
  return { first: results[0], model: results[0].model, roundTripMs: { first: round[0], warmP50: percentile(round.slice(1).length ? round.slice(1) : round, .5), warmMax: Math.max(...(round.slice(1).length ? round.slice(1) : round)) }, inferenceMs: { first: inference[0], warmP50: percentile(inference.slice(1).length ? inference.slice(1) : inference, .5) } };
}

const local = createDepthProvider(), remote = createRemoteDepthProvider({ baseUrl: remoteUrl, startupTimeoutMs: 60_000, requestTimeoutMs: 120_000 });
try {
  const cpu = await measure(local), gpu = await measure(remote);
  const a = cpu.first.depth, b = gpu.first.depth;
  let both = 0, sumAbs = 0, maxAbs = 0, sumRel = 0, maskDisagree = 0;
  for (let i = 0; i < a.values.length; i++) {
    if (a.validMask[i] !== b.validMask[i]) maskDisagree++;
    if (!a.validMask[i] || !b.validMask[i]) continue;
    const d = Math.abs(a.values[i] - b.values[i]);
    both++; sumAbs += d; maxAbs = Math.max(maxAbs, d); sumRel += d / a.values[i];
  }
  const report = {
    kind: 'depth_backend_parity', synthetic: true, gateStatus: 'not_asserted', finishedAtUtc: new Date().toISOString(),
    input: { path: imagePath, sha256: createHash('sha256').update(bytes).digest('hex'), width, height, runsPerBackend: runs },
    local: { model: cpu.model, roundTripMs: cpu.roundTripMs, inferenceMs: cpu.inferenceMs },
    colab: { model: gpu.model, roundTripMs: gpu.roundTripMs, inferenceMs: gpu.inferenceMs },
    agreement: { comparedPixels: both, validMaskDisagreements: maskDisagree, meanAbsDiffM: both ? sumAbs / both : null, maxAbsDiffM: both ? maxAbs : null, meanRelDiff: both ? sumRel / both : null },
    limitations: ['One synthetic scene image; agreement shows backend parity, not depth accuracy.', 'Colab runs a different torch/CUDA build than the local CPU worker; small numeric differences are expected.', 'Round trip includes the SSH tunnel over the public internet and varies with network conditions.'],
  };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ agreement: report.agreement, local: report.local.roundTripMs, colab: report.colab.roundTripMs, colabInference: report.colab.inferenceMs }, null, 1));
} finally {
  await local.close(); await remote.close();
}
