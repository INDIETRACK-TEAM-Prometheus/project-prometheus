import { readFile, open, stat } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/spatial/depth-artifact.js';
import { computeDepthMetrics } from '../src/evaluation/depth-metrics.js';
import { decodeDepthMap } from '../src/spatial/world-depth-export.js';

const usage = `Usage: node scripts/evaluate-depth.mjs --pred pred.(npz|json) --gt engine-gt.json --output report.json
  [--pred-frame-id ID (required for .npz)] [--masks masks.json] [--gaze X,Y --gaze-radius PX]
  [--boundary-band PX] [--max-depth M] [--scale-correction calibration-fit.json] [--sample-id ID]
Reads a model map (worker .npz with depth_m/valid_mask, or a depth-map JSON export) and an engine GT export.
Local only: no network, no Python required. The report file is created exclusively (never overwritten).`;

const MAX_INPUT = 64 * 1024 * 1024;
const fail = message => { throw new Error(message); };

// Minimal NumPy .npz reader (zip stored/deflate, zip64 sizes, .npy v1-v3, little-endian f4/f8/u1/b1).
export function readNpz(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) fail('npz: too short');
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fail('npz: no zip end record');
  let count = buffer.readUInt16LE(eocd + 10), cdOffset = buffer.readUInt32LE(eocd + 16);
  if ((count === 0xffff || cdOffset === 0xffffffff) && eocd >= 20 && buffer.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z = Number(buffer.readBigUInt64LE(eocd - 20 + 8));
    if (buffer.readUInt32LE(z) !== 0x06064b50) fail('npz: bad zip64 record');
    count = Number(buffer.readBigUInt64LE(z + 32)); cdOffset = Number(buffer.readBigUInt64LE(z + 48));
  }
  const arrays = {};
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) fail('npz: bad central directory');
    const method = buffer.readUInt16LE(p + 10), nameLen = buffer.readUInt16LE(p + 28), extraLen = buffer.readUInt16LE(p + 30), commentLen = buffer.readUInt16LE(p + 32);
    let comp = buffer.readUInt32LE(p + 20), uncomp = buffer.readUInt32LE(p + 24), local = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    for (let e = p + 46 + nameLen, end = e + extraLen; e + 4 <= end;) {
      const id = buffer.readUInt16LE(e), size = buffer.readUInt16LE(e + 2);
      if (id === 1) {
        let q = e + 4;
        if (uncomp === 0xffffffff) { uncomp = Number(buffer.readBigUInt64LE(q)); q += 8; }
        if (comp === 0xffffffff) { comp = Number(buffer.readBigUInt64LE(q)); q += 8; }
        if (local === 0xffffffff) { local = Number(buffer.readBigUInt64LE(q)); }
      }
      e += 4 + size;
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (uncomp > MAX_INPUT) fail('npz: entry too large');
    if (buffer.readUInt32LE(local) !== 0x04034b50) fail('npz: bad local header');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + comp);
    let data;
    if (method === 0) data = raw; else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: MAX_INPUT }); else fail('npz: unsupported compression');
    if (data.length !== uncomp) fail('npz: size mismatch');
    arrays[name.replace(/\.npy$/, '')] = parseNpy(data);
  }
  return arrays;
}

function parseNpy(data) {
  if (data.length < 12 || data[0] !== 0x93 || data.toString('latin1', 1, 6) !== 'NUMPY') fail('npy: bad magic');
  const major = data[6], headerLen = major === 1 ? data.readUInt16LE(8) : data.readUInt32LE(8), at = major === 1 ? 10 : 12;
  const header = data.toString('latin1', at, at + headerLen), body = data.subarray(at + headerLen);
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1], fortran = /'fortran_order':\s*(True|False)/.exec(header)?.[1];
  const shapeText = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1];
  if (!descr || fortran !== 'False' || shapeText === undefined) fail('npy: unsupported header');
  const shape = shapeText.split(',').map(s => s.trim()).filter(Boolean).map(Number);
  if (shape.length !== 2 || !shape.every(Number.isSafeInteger)) fail('npy: expected 2-D array');
  const n = shape[0] * shape[1], out = descr === '<f8' ? new Float64Array(n) : descr === '<f4' ? new Float32Array(n) : ['|u1', '|b1', '<u1'].includes(descr) ? new Uint8Array(n) : fail(`npy: unsupported dtype ${descr}`);
  const size = out.BYTES_PER_ELEMENT;
  if (body.length !== n * size) fail('npy: payload size mismatch');
  for (let i = 0; i < n; i++) out[i] = size === 8 ? body.readDoubleLE(i * 8) : size === 4 ? body.readFloatLE(i * 4) : body[i];
  return { shape, data: out };
}

async function readLimited(path) {
  if ((await stat(path)).size > MAX_INPUT) fail(`input exceeds 64 MiB: ${path}`);
  const raw = await readFile(path);
  if (raw.byteLength > MAX_INPUT) fail(`input exceeds 64 MiB: ${path}`);
  return raw;
}

function parseArgs(argv) {
  const allowed = ['--pred', '--gt', '--output', '--pred-frame-id', '--masks', '--gaze', '--gaze-radius', '--boundary-band', '--max-depth', '--scale-correction', '--sample-id'];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') return { help: true };
    if (!allowed.includes(argv[i]) || Object.hasOwn(options, argv[i]) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) fail(usage);
    options[argv[i]] = argv[++i];
  }
  if (!options['--pred'] || !options['--gt'] || !options['--output']) fail(usage);
  return { options };
}

const num = (v, name) => { const x = Number(v); if (!Number.isFinite(x)) fail(`invalid ${name}`); return x; };

export async function runEvaluation(argv, { now = () => new Date() } = {}) {
  const { options, help } = parseArgs(argv);
  if (help) return { help: usage };
  const predRaw = await readLimited(options['--pred']), gtRaw = await readLimited(options['--gt']);
  const gtJson = JSON.parse(gtRaw.toString('utf8'));
  if (gtJson.label !== 'engine_oracle' || gtJson.modelOutput !== false) fail('GT file must be an engine_oracle export (never model output)');
  const gt = decodeDepthMap(gtJson);

  let pred, predFormat, predFrameId, model = null;
  if (options['--pred'].toLowerCase().endsWith('.npz')) {
    predFormat = 'worker_npz';
    const arrays = readNpz(predRaw), d = arrays.depth_m, m = arrays.valid_mask;
    if (!d || !m || d.shape[0] !== m.shape[0] || d.shape[1] !== m.shape[1]) fail('npz needs same-shape depth_m and valid_mask');
    if (!options['--pred-frame-id']) fail('--pred-frame-id is required for .npz (the file carries no frame identity)');
    predFrameId = options['--pred-frame-id'];
    pred = { width: d.shape[1], height: d.shape[0], values: d.data, validMask: m.data };
  } else {
    predFormat = 'depth_map_json';
    const json = JSON.parse(predRaw.toString('utf8'));
    if (json.label === 'engine_oracle' || json.depthSource === 'engine_geometry') fail('prediction must not be engine geometry');
    if (json.depthSource !== 'monocular_estimated_depth' || json.units !== 'm' || json.convention !== 'axial_z') fail('prediction must be monocular metric axial_z depth in metres');
    pred = decodeDepthMap(json); predFrameId = json.frame?.frameId ?? json.frameId ?? options['--pred-frame-id']; model = json.model ?? null;
    if (!predFrameId) fail('prediction frame identity missing');
    if (options['--pred-frame-id'] && options['--pred-frame-id'] !== predFrameId) fail('--pred-frame-id disagrees with prediction file');
  }
  if (predFrameId !== gt.frame.frameId) fail(`frame mismatch: prediction ${predFrameId} vs GT ${gt.frame.frameId}`);
  if (pred.width !== gt.width || pred.height !== gt.height) fail(`dimension mismatch: prediction ${pred.width}x${pred.height} vs GT ${gt.width}x${gt.height} (a downsampled GT needs a matching prediction)`);

  const inputs = {
    pred: { path: options['--pred'], format: predFormat, sha256: sha256Hex(predRaw), frameId: predFrameId },
    gt: { path: options['--gt'], format: 'engine_depth_gt_json', sha256: sha256Hex(gtRaw), frameId: gt.frame.frameId },
  };
  let foregroundMasks = [];
  if (options['--masks']) {
    const raw = await readLimited(options['--masks']);
    foregroundMasks = JSON.parse(raw.toString('utf8'));
    inputs.masks = { path: options['--masks'], sha256: sha256Hex(raw) };
  }
  let scaleCorrection = null;
  if (options['--scale-correction']) {
    const raw = await readLimited(options['--scale-correction']);
    scaleCorrection = JSON.parse(raw.toString('utf8'));
    inputs.scaleCorrection = { path: options['--scale-correction'], sha256: sha256Hex(raw) };
  }
  let gaze = null;
  if (options['--gaze']) {
    const xy = options['--gaze'].split(',');
    if (xy.length !== 2 || !options['--gaze-radius']) fail('--gaze needs X,Y and --gaze-radius');
    gaze = { pixel: xy.map(v => num(v, 'gaze')), radiusPx: num(options['--gaze-radius'], 'gaze radius') };
  }
  const metrics = computeDepthMetrics({
    width: gt.width, height: gt.height, pred, gt, foregroundMasks, gaze,
    boundaryBandPx: options['--boundary-band'] === undefined ? 2 : num(options['--boundary-band'], 'boundary band'),
    maxDepthM: options['--max-depth'] === undefined ? 20 : num(options['--max-depth'], 'max depth'),
    scaleCorrection, evaluationSampleId: options['--sample-id'] ?? null,
  });
  const report = {
    schema: 'prometheus_depth_evaluation_report', version: 1, generatedAtUtc: now().toISOString(),
    synthetic: true, gateStatus: 'not_asserted',
    notes: ['Ground truth is an engine oracle for a synthetic frame; this is not real-scene accuracy.', 'No Gate pass is claimed by this report.'],
    groundTruth: { label: gtJson.label, depthSource: gtJson.depthSource, frame: gtJson.frame, downsample: gtJson.downsample, counts: gtJson.counts },
    prediction: { depthSource: 'monocular_estimated_depth', model },
    inputs, metrics,
  };
  const out = await open(options['--output'], 'wx');
  try { await out.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8'); } finally { await out.close(); }
  return { report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runEvaluation(process.argv.slice(2));
    if (result.help) console.log(result.help);
    else {
      const a = result.report.metrics.regions.all_valid;
      console.log(`Wrote synthetic depth report: all_valid coverage ${a.coverage} MAE ${a.mae} m AbsRel ${a.absRel}; pred ${result.report.inputs.pred.sha256}; gt ${result.report.inputs.gt.sha256}`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
