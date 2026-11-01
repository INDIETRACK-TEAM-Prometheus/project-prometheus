#!/usr/bin/env node
// Validates Gate judgement records in docs/evidence/gates/*.json against the contract in
// docs/GATE_PLAN_20261104.md. Read-only: no network, no writes. Usage:
//   node scripts/validate-gate-records.mjs [recordsDir] [--root repoRoot]
// Exit code 0 when every record is valid, 1 otherwise.
import {readFileSync, readdirSync, existsSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const CONTRACT_FIELDS = Object.freeze(['gateId', 'requirementIds', 'status', 'implementationStatus', 'evaluationStatus', 'commit', 'testKind', 'environment', 'modelVersions', 'profileHash', 'startedAtUtc', 'finishedAtUtc', 'metrics', 'thresholds', 'thresholdVersion', 'evidencePaths', 'failures', 'limitations', 'reviewer']);
export const EXPECTED_GATES = Object.freeze(['G0-A', 'G0-B', 'G0-C', 'G1-A', 'G1-B', 'G1-C', 'G1-D', 'G1-E', 'G1-F', 'G1-G', 'G2-A', 'G2-B', 'G2-C', 'G2-D', 'G3-A', 'G3-B', 'G3-C', 'G4-A', 'G4-B', 'G4-C', 'G4-D', 'G4-E', 'G5-A', 'G5-B', 'G5-C', 'G5-D']);
export const EVALUATION_STATUSES = Object.freeze(['not_evaluated', 'blocked', 'failed', 'passed']);
export const IMPLEMENTATION_STATUSES = Object.freeze(['planned', 'implemented', 'tested']);
// Evidence classes that can never support `passed`: mocks, unit/injected tests, synthetic inputs, nothing run.
export const SYNTHETIC_TEST_KINDS = Object.freeze(['not_run', 'unit', 'synthetic', 'synthetic_model_smoke', 'synthetic_live_provider']);
// Evidence classes that may support `passed` when the other conditions hold.
export const REAL_TEST_KINDS = Object.freeze(['real_provider', 'real_camera', 'real_user', 'real_hardware', 'public_dataset', 'mixed_real']);
export const TEST_KINDS = Object.freeze([...SYNTHETIC_TEST_KINDS, ...REAL_TEST_KINDS]);

const REQUIREMENT_ID = /^(?:(?:SCP|EYE|GEO|OBJ|PATH|EVT|MEM|INF|PRE|RT|UI|SEC|OPEN|SYNC|BUF|MAP|VALID|DEL|DATA|OPS|API)-\d{2}|T\d{2})$/;
const GATE_ID = /^G[0-5]-[A-G]$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = v => typeof v === 'string' && v.trim().length > 0;
const stringArray = v => Array.isArray(v) && v.every(nonEmptyString);
const isEmptyObject = v => isObject(v) && Object.keys(v).length === 0;
const isUtc = v => typeof v === 'string' && UTC.test(v) && !Number.isNaN(Date.parse(v));

function checkEvidencePath(p, root) {
  if (!nonEmptyString(p)) return 'is not a non-empty string';
  if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p) || p.startsWith('\\\\')) return 'must be relative to the repository root';
  const resolved = path.resolve(root, p);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 'escapes the repository root';
  if (!existsSync(resolved) || !statSync(resolved).isFile()) return 'does not exist as a file';
  return null;
}

// Returns an array of error strings (empty when valid). `root` is the repository root used to resolve evidencePaths.
export function validateRecord(record, {root = process.cwd(), fileName = null} = {}) {
  const errors = [];
  const err = m => errors.push(m);
  if (!isObject(record)) return ['record must be a JSON object'];

  const keys = Object.keys(record);
  for (const f of CONTRACT_FIELDS) if (!(f in record)) err(`missing field: ${f}`);
  for (const k of keys) if (!CONTRACT_FIELDS.includes(k)) err(`unexpected field: ${k}`);

  if (!(typeof record.gateId === 'string' && GATE_ID.test(record.gateId))) err('gateId must look like G0-A…G5-G');
  else if (fileName !== null && fileName !== `${record.gateId}.json`) err(`file name ${fileName} must be ${record.gateId}.json`);

  if (!Array.isArray(record.requirementIds) || record.requirementIds.length === 0) err('requirementIds must be a non-empty array');
  else {
    for (const id of record.requirementIds) if (typeof id !== 'string' || !REQUIREMENT_ID.test(id)) err(`invalid requirement id: ${String(id)}`);
    if (new Set(record.requirementIds).size !== record.requirementIds.length) err('requirementIds contains duplicates');
  }

  if (!EVALUATION_STATUSES.includes(record.status)) err(`status must be one of ${EVALUATION_STATUSES.join('|')}`);
  if (!IMPLEMENTATION_STATUSES.includes(record.implementationStatus)) err(`implementationStatus must be one of ${IMPLEMENTATION_STATUSES.join('|')}`);
  if (!EVALUATION_STATUSES.includes(record.evaluationStatus)) err(`evaluationStatus must be one of ${EVALUATION_STATUSES.join('|')}`);
  if (record.status !== record.evaluationStatus) err('status must mirror evaluationStatus');

  if (!(typeof record.commit === 'string' && COMMIT.test(record.commit))) err('commit must be a 7-40 character lowercase hex git hash');
  if (!TEST_KINDS.includes(record.testKind)) err(`testKind must be one of ${TEST_KINDS.join('|')}`);
  if (!isObject(record.environment)) err('environment must be an object');
  if (!isObject(record.modelVersions)) err('modelVersions must be an object');
  if (!(record.profileHash === null || nonEmptyString(record.profileHash))) err('profileHash must be null or a non-empty string');
  for (const f of ['startedAtUtc', 'finishedAtUtc']) if (!(record[f] === null || isUtc(record[f]))) err(`${f} must be null or an ISO-8601 UTC timestamp ending in Z`);
  if (isUtc(record.startedAtUtc) && isUtc(record.finishedAtUtc) && Date.parse(record.finishedAtUtc) < Date.parse(record.startedAtUtc)) err('finishedAtUtc is before startedAtUtc');
  if ((record.startedAtUtc === null) !== (record.finishedAtUtc === null)) err('startedAtUtc and finishedAtUtc must both be set or both be null');
  if (!isObject(record.metrics)) err('metrics must be an object');
  if (!isObject(record.thresholds)) err('thresholds must be an object');
  if (!(record.thresholdVersion === null || nonEmptyString(record.thresholdVersion))) err('thresholdVersion must be null or a non-empty string');
  if (isObject(record.thresholds)) {
    if (isEmptyObject(record.thresholds) && record.thresholdVersion !== null) err('empty thresholds require thresholdVersion null');
    if (!isEmptyObject(record.thresholds) && record.thresholdVersion === null) err('non-empty thresholds require a thresholdVersion');
  }
  if (!stringArray(record.failures)) err('failures must be an array of non-empty strings');
  if (!stringArray(record.limitations)) err('limitations must be an array of non-empty strings');
  if (!nonEmptyString(record.reviewer)) err('reviewer must be a non-empty string');

  // Every registered evidence path must be an existing repository file, whatever the status.
  if (!Array.isArray(record.evidencePaths)) err('evidencePaths must be an array');
  else {
    const seen = new Set();
    for (const p of record.evidencePaths) {
      const problem = checkEvidencePath(p, root);
      if (problem) err(`evidencePaths entry ${JSON.stringify(p)} ${problem}`);
      if (seen.has(p)) err(`evidencePaths entry ${JSON.stringify(p)} is duplicated`);
      seen.add(p);
    }
  }

  if (record.status === 'blocked' && !(Array.isArray(record.limitations) && record.limitations.length) && !(Array.isArray(record.failures) && record.failures.length)) err('blocked requires a stated reason in limitations or failures');
  if (record.status === 'failed' && !(Array.isArray(record.failures) && record.failures.length)) err('failed requires at least one entry in failures');

  if (record.status === 'passed' || record.evaluationStatus === 'passed') {
    if (SYNTHETIC_TEST_KINDS.includes(record.testKind)) err(`passed is not allowed for testKind ${record.testKind} (mock/unit/synthetic evidence cannot pass a gate)`);
    if (record.implementationStatus !== 'tested') err('passed requires implementationStatus tested');
    if (isObject(record.metrics) && isEmptyObject(record.metrics)) err('passed requires non-empty metrics');
    if (isObject(record.thresholds) && isEmptyObject(record.thresholds)) err('passed requires non-empty thresholds');
    if (record.thresholdVersion === null || !nonEmptyString(record.thresholdVersion)) err('passed requires thresholdVersion');
    if (!Array.isArray(record.evidencePaths) || record.evidencePaths.length === 0) err('passed requires non-empty evidencePaths');
    if (record.startedAtUtc === null || record.finishedAtUtc === null) err('passed requires startedAtUtc and finishedAtUtc');
    if (record.reviewer === 'pending_cto') err('passed requires a named reviewer, not pending_cto');
  }
  return errors;
}

// Validates every <gateId>.json in `dir` and checks that all expected gates are present exactly once.
// Returns {records: {file: record}, errors: [{file, message}]}.
export function validateDirectory(dir, {root = process.cwd(), expectedGates = EXPECTED_GATES} = {}) {
  const errors = [];
  const records = {};
  const add = (file, message) => errors.push({file, message});
  if (!existsSync(dir) || !statSync(dir).isDirectory()) { add(dir, 'records directory does not exist'); return {records, errors}; }
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  for (const file of files) {
    let record;
    try { record = JSON.parse(readFileSync(path.join(dir, file), 'utf8')); } catch (e) { add(file, `invalid JSON: ${e.message}`); continue; }
    records[file] = record;
    for (const m of validateRecord(record, {root, fileName: file})) add(file, m);
  }
  if (expectedGates) {
    const present = new Set(files.map(f => f.replace(/\.json$/, '')));
    for (const g of expectedGates) if (!present.has(g)) add(`${g}.json`, 'missing gate record');
    for (const p of present) if (!expectedGates.includes(p)) add(`${p}.json`, 'unknown gate id');
  }
  return {records, errors};
}

function main(argv) {
  const args = argv.slice(2);
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let dir = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') root = path.resolve(args[++i] ?? '');
    else if (!args[i].startsWith('--') && dir === null) dir = path.resolve(args[i]);
    else { console.error(`unknown argument: ${args[i]}`); return 2; }
  }
  dir ??= path.join(root, 'docs', 'evidence', 'gates');
  const {records, errors} = validateDirectory(dir, {root});
  const counts = {};
  for (const r of Object.values(records)) counts[r.status] = (counts[r.status] ?? 0) + 1;
  for (const {file, message} of errors) console.error(`${file}: ${message}`);
  console.log(`${Object.keys(records).length} gate records checked; ${errors.length} error(s); status counts ${JSON.stringify(counts)}`);
  return errors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv);
