// Internal contracts only; these are not provider API schemas.
export const SCHEMA_VERSION = '1.1';
const id = x => typeof x === 'string' && x.trim().length > 0;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const nonnegative = x => finite(x) && x >= 0;
const strings = x => Array.isArray(x) && x.every(id);
const fail = message => { throw new TypeError(message); };

export function validateCommon(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) fail('record required');
  if (r.schema_version !== SCHEMA_VERSION) fail('unsupported schema_version');
  for (const k of ['session_id', 'id', 'source', 'source_clock_id']) if (!id(r[k])) fail(`invalid ${k}`);
  for (const k of ['capture_ts_ns', 'ingest_ts_ns', 'observed_at', 'processed_at', 'sync_uncertainty_ms']) if (!nonnegative(r[k])) fail(`invalid ${k}`);
  if (!['sensor', 'derived', 'external', 'synthetic'].includes(r.provenance_kind)) fail('invalid provenance_kind');
  if (!r.quality || typeof r.quality !== 'object' || Array.isArray(r.quality)) fail('quality required');
  if (!r.provenance || typeof r.provenance !== 'object' || Array.isArray(r.provenance)) fail('provenance required');
  return r;
}

// Missing numeric data must be represented by a reason, never a zero sentinel.
export function validateMeasurement(value, unit, allowedUnits) {
  if (!value || typeof value !== 'object' || !allowedUnits.includes(unit)) fail('invalid measurement unit');
  if (value.value === null) { if (!id(value.reason)) fail('null measurement requires reason'); }
  else if (!finite(value.value) || value.reason != null) fail('invalid measurement');
  return value;
}

export function validateScenarios(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length > 5) fail('scenarios must contain at most five items');
  const seen = new Set();
  for (const s of scenarios) {
    if (!s || !id(s.scenario_id) || seen.has(s.scenario_id) || !id(s.possible_next_action)) fail('invalid scenario');
    seen.add(s.scenario_id);
    if (!nonnegative(s.horizon_ms) || !strings(s.grounding_refs) || !Array.isArray(s.assumptions) || !s.assumptions.every(x => typeof x === 'string')) fail('invalid scenario evidence');
    if (!['active', 'withdrawn', 'abstained'].includes(s.status)) fail('invalid scenario status');
    if (s.optional_rank != null && (!Number.isInteger(s.optional_rank) || s.optional_rank < 1)) fail('invalid rank');
  }
  return scenarios;
}

export const providerCapabilities = Object.freeze({
  sam31: Object.freeze({status: 'blocked', reason: 'Provider contract and access unverified'}),
  museWonder: Object.freeze({status: 'blocked', reason: 'Provider contract and access unverified'})
});
export function requireProvider(name) {
  if (!Object.hasOwn(providerCapabilities, name)) throw new Error('Unknown provider');
  throw new Error(`${name}: blocked; provider contract and access unverified`);
}
