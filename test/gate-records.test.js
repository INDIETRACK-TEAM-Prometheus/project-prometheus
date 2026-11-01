import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {CONTRACT_FIELDS, EXPECTED_GATES, SYNTHETIC_TEST_KINDS, REAL_TEST_KINDS, validateRecord, validateDirectory} from '../scripts/validate-gate-records.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gatesDir = path.join(root, 'docs', 'evidence', 'gates');
const script = path.join(root, 'scripts', 'validate-gate-records.mjs');
let cached; const real = () => (cached ??= validateDirectory(gatesDir, {root}));
const clone = value => JSON.parse(JSON.stringify(value));
const evidenceFile = 'docs/evidence/unit-tests-20261101-doc-consistency.txt';

function baseRecord() {
  return clone(real().records['G0-A.json']);
}
function passedRecord() {
  return {
    gateId: 'G1-F', requirementIds: ['T01'], status: 'passed', implementationStatus: 'tested', evaluationStatus: 'passed',
    commit: 'abcdef1', testKind: 'real_user', environment: {os: 'test-fixture'}, modelVersions: {}, profileHash: 'sha256:fixture',
    startedAtUtc: '2026-11-03T01:00:00Z', finishedAtUtc: '2026-11-03T01:30:00Z',
    metrics: {p95ErrorFractionOfScreenDiagonal: 0.04}, thresholds: {p95ErrorFractionOfScreenDiagonalMax: 0.05}, thresholdVersion: 'fixture-v1',
    evidencePaths: [evidenceFile], failures: [], limitations: ['synthetic fixture for the validator test only'], reviewer: 'cto'
  };
}

test('real gate records satisfy the contract and cover every detailed gate', () => {
  const {records, errors} = real();
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(records).map(f => f.replace(/\.json$/, '')).sort(), [...EXPECTED_GATES].sort());
  assert.equal(EXPECTED_GATES.length, 26);
  for (const [file, record] of Object.entries(records)) {
    assert.deepEqual(Object.keys(record).sort(), [...CONTRACT_FIELDS].sort(), file);
    assert.equal(record.status, record.evaluationStatus, file);
    assert.equal(record.reviewer === 'pending_cto' || record.status === 'passed', true, file);
  }
});

test('no record is passed on synthetic, unit or unrun evidence and real-user conditions stay unevaluated or blocked', () => {
  for (const [file, record] of Object.entries(real().records)) {
    if (record.status === 'passed') assert.ok(REAL_TEST_KINDS.includes(record.testKind), `${file} passed on ${record.testKind}`);
    if (SYNTHETIC_TEST_KINDS.includes(record.testKind)) assert.notEqual(record.status, 'passed', file);
  }
});

test('gate records only reference requirement IDs listed in the trace table', () => {
  const trace = readFileSync(path.join(root, 'docs', 'REQUIREMENT_TRACE.md'), 'utf8');
  for (const [file, record] of Object.entries(real().records)) {
    for (const id of record.requirementIds) assert.ok(new RegExp(`\\| ${id} \\|`).test(trace), `${file}: ${id} is not a row of REQUIREMENT_TRACE.md`);
  }
});

test('the CLI accepts the real records and exits 0', () => {
  const r = spawnSync(process.execPath, [script], {encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /26 gate records checked; 0 error/);
});

test('a well-formed record with real-evidence testKind passes, including passed with complete evidence', () => {
  assert.deepEqual(validateRecord(baseRecord(), {root, fileName: 'G0-A.json'}), []);
  assert.deepEqual(validateRecord(passedRecord(), {root, fileName: 'G1-F.json'}), []);
});

const mutations = [
  ['a missing contract field', r => { delete r.limitations; }, /missing field: limitations/],
  ['an extra field', r => { r.notes = 'x'; }, /unexpected field: notes/],
  ['an invalid status enum', r => { r.status = 'done'; r.evaluationStatus = 'done'; }, /status must be one of/],
  ['an invalid implementationStatus enum', r => { r.implementationStatus = 'passed'; }, /implementationStatus must be one of/],
  ['status not mirroring evaluationStatus', r => { r.status = 'blocked'; }, /status must mirror evaluationStatus/],
  ['an unknown testKind', r => { r.testKind = 'manual'; }, /testKind must be one of/],
  ['a malformed commit', r => { r.commit = 'HEAD'; }, /commit must be/],
  ['an unknown requirement id', r => { r.requirementIds.push('XYZ-99'); }, /invalid requirement id: XYZ-99/],
  ['empty requirementIds', r => { r.requirementIds = []; }, /requirementIds must be a non-empty array/],
  ['a non-UTC timestamp', r => { r.startedAtUtc = '2026-11-03 10:00'; r.finishedAtUtc = '2026-11-03 11:00'; }, /startedAtUtc must be null or an ISO-8601 UTC/],
  ['only one timestamp set', r => { r.startedAtUtc = '2026-11-03T01:00:00Z'; }, /both be set or both be null/],
  ['thresholds without a version', r => { r.thresholdVersion = null; }, /non-empty thresholds require a thresholdVersion/],
  ['a version without thresholds', r => { r.thresholds = {}; }, /empty thresholds require thresholdVersion null/],
  ['a nonexistent evidence path on an unevaluated gate', r => { r.evidencePaths.push('docs/evidence/does-not-exist.json'); }, /does not exist as a file/],
  ['an evidence path escaping the repository', r => { r.evidencePaths = ['../Prometheus_SRS_v1.1.md']; }, /escapes the repository root|does not exist/],
  ['an absolute evidence path', r => { r.evidencePaths = [path.join(root, evidenceFile)]; }, /must be relative/],
  ['a duplicated evidence path', r => { r.evidencePaths = [evidenceFile, evidenceFile]; }, /duplicated/],
  ['blocked without a reason', r => { r.status = 'blocked'; r.evaluationStatus = 'blocked'; r.failures = []; r.limitations = []; }, /blocked requires a stated reason/],
  ['failed without failures', r => { r.status = 'failed'; r.evaluationStatus = 'failed'; r.failures = []; }, /failed requires at least one entry in failures/],
  ['a non-array failures field', r => { r.failures = 'none'; }, /failures must be an array/]
];
for (const [name, mutate, expected] of mutations) {
  test(`validator rejects ${name}`, () => {
    const r = baseRecord();
    mutate(r);
    const errors = validateRecord(r, {root});
    assert.ok(errors.some(m => expected.test(m)), `expected ${expected}, got ${JSON.stringify(errors)}`);
  });
}

const passedMutations = [
  ['synthetic_live_provider', r => { r.testKind = 'synthetic_live_provider'; }, /passed is not allowed for testKind/],
  ['unit testKind', r => { r.testKind = 'unit'; }, /passed is not allowed for testKind/],
  ['synthetic testKind', r => { r.testKind = 'synthetic'; }, /passed is not allowed for testKind/],
  ['not_run testKind', r => { r.testKind = 'not_run'; }, /passed is not allowed for testKind/],
  ['empty metrics', r => { r.metrics = {}; }, /passed requires non-empty metrics/],
  ['empty thresholds', r => { r.thresholds = {}; r.thresholdVersion = null; }, /passed requires non-empty thresholds/],
  ['a null thresholdVersion', r => { r.thresholdVersion = null; }, /passed requires thresholdVersion/],
  ['empty evidencePaths', r => { r.evidencePaths = []; }, /passed requires non-empty evidencePaths/],
  ['a nonexistent evidence path', r => { r.evidencePaths = ['docs/evidence/never-produced.json']; }, /does not exist as a file/],
  ['implementationStatus below tested', r => { r.implementationStatus = 'implemented'; }, /passed requires implementationStatus tested/],
  ['missing timestamps', r => { r.startedAtUtc = null; r.finishedAtUtc = null; }, /passed requires startedAtUtc and finishedAtUtc/],
  ['an unassigned reviewer', r => { r.reviewer = 'pending_cto'; }, /named reviewer/]
];
for (const [name, mutate, expected] of passedMutations) {
  test(`validator rejects passed with ${name}`, () => {
    const r = passedRecord();
    mutate(r);
    const errors = validateRecord(r, {root});
    assert.ok(errors.some(m => expected.test(m)), `expected ${expected}, got ${JSON.stringify(errors)}`);
  });
}

test('validateDirectory reports missing gates, file name mismatches, unknown gates and invalid JSON', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-records-'));
  try {
    const good = real().records['G0-A.json'];
    writeFileSync(path.join(dir, 'G0-A.json'), JSON.stringify(good));
    writeFileSync(path.join(dir, 'G0-B.json'), JSON.stringify(good)); // gateId G0-A inside G0-B.json
    writeFileSync(path.join(dir, 'G9-Z.json'), JSON.stringify({...good, gateId: 'G9-Z'}));
    writeFileSync(path.join(dir, 'G0-C.json'), '{not json');
    const {errors} = validateDirectory(dir, {root});
    const text = errors.map(e => `${e.file}: ${e.message}`).join('\n');
    assert.match(text, /G0-B\.json: file name G0-B\.json must be G0-A\.json/);
    assert.match(text, /G9-Z\.json: unknown gate id/);
    assert.match(text, /G0-C\.json: invalid JSON/);
    assert.match(text, /G5-D\.json: missing gate record/);
    assert.ok(errors.length >= 4);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('the CLI exits 1 for a directory containing an invalid record and 0 only for valid ones', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-records-cli-'));
  try {
    const bad = passedRecord();
    bad.testKind = 'unit';
    writeFileSync(path.join(dir, 'G1-F.json'), JSON.stringify(bad));
    const failing = spawnSync(process.execPath, [script, dir, '--root', root], {encoding: 'utf8'});
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /passed is not allowed for testKind unit/);
    mkdirSync(path.join(dir, 'ok'));
    writeFileSync(path.join(dir, 'ok', 'G1-F.json'), JSON.stringify(passedRecord()));
    const partial = spawnSync(process.execPath, [script, path.join(dir, 'ok'), '--root', root], {encoding: 'utf8'});
    assert.equal(partial.status, 1, 'a directory missing the other 25 gates must still fail');
    assert.match(partial.stderr, /missing gate record/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
