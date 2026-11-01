// G1-F independent accuracy-test plan and G1-E calibration schedule. Pure and browser-safe: no clock, no DOM, no node: imports.
// A plan is frozen by its hash before the run; nothing here measures gaze or proves a Gate.
const finite = Number.isFinite;

export const ACCURACY_PROTOCOL_VERSION = 1;
export const EDGE_BANDS = Object.freeze({low:Object.freeze([0.05, 0.10]), high:Object.freeze([0.90, 0.95])});
export const CENTER_BAND = Object.freeze([0.44, 0.56]);
// Normalised positions already used by app.js 27-point adaptation (0.12/0.50/0.88) and validation (0.20/0.48/0.76) grids.
export const APP_CALIBRATION_GRIDS_NORM = Object.freeze([0.12, 0.50, 0.88].flatMap(y => [0.12, 0.50, 0.88].map(x => Object.freeze({x, y})))
  .concat([0.20, 0.48, 0.76].flatMap(y => [0.20, 0.48, 0.76].map(x => Object.freeze({x, y})))));
export const DEFAULT_FIXATION_RULES = Object.freeze({settleMs:700, dwellMs:1200, minValidSamples:10, minValidFraction:0.5, hitRadiusFraction:0.05, interTrialMs:300});
export const GATE_CALIBRATION_WINDOW_MS = Object.freeze({min:30000, max:60000});

const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

// ---- hashing -------------------------------------------------------------------------------------------------
const primes = [];
for (let n = 2; primes.length < 64; n++) if (primes.every(p => n % p)) primes.push(n);
const frac32 = v => Math.floor((v - Math.floor(v)) * 2 ** 32) >>> 0;
const SHA_K = primes.map(p => frac32(Math.cbrt(p)));
const SHA_H0 = primes.slice(0, 8).map(p => frac32(Math.sqrt(p)));
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

export function sha256Hex(text) {
  if (typeof text !== 'string') throw new TypeError('string required');
  const bytes = new TextEncoder().encode(text), length = bytes.length, total = ((length + 9 + 63) >> 6) << 6;
  const buffer = new Uint8Array(total); buffer.set(bytes); buffer[length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(total - 8, Math.floor(length * 8 / 2 ** 32)); view.setUint32(total - 4, (length * 8) >>> 0);
  const h = [...SHA_H0], w = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => { h[i] = (h[i] + v) >>> 0; });
  }
  return h.map(v => v.toString(16).padStart(8, '0')).join('');
}

// Key-sorted JSON; non-finite numbers are refused so a hash can never cover NaN/Infinity silently.
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!finite(value)) throw new TypeError('non-finite number cannot be hashed'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  throw new TypeError('unsupported value in canonical JSON');
}
export const hashWithout = (object, key = 'hash') => { const {[key]: _omitted, ...rest} = object; return sha256Hex(canonicalJson(rest)); };

// ---- seeded randomness ---------------------------------------------------------------------------------------
function seedToUint32(seed) {
  if (Number.isSafeInteger(seed) && seed >= 0) return seed >>> 0 ^ Math.floor(seed / 2 ** 32);
  if (typeof seed === 'string' && seed) { let h = 2166136261; for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  throw new TypeError('seed must be a non-negative safe integer or a non-empty string');
}
export function createSeededRandom(seed) { // mulberry32
  let a = seedToUint32(seed);
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffled(items, random) { const a = [...items]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
// Randomised order per repeat; the first item of a repeat never equals the last of the previous one.
function repeatedOrder(items, repeats, random, same) {
  const order = [];
  for (let r = 0; r < repeats; r++) {
    const block = shuffled(items, random);
    if (order.length && block.length > 1 && same(order[order.length - 1].item, block[0])) { const j = 1 + Math.floor(random() * (block.length - 1)); [block[0], block[j]] = [block[j], block[0]]; }
    order.push(...block.map(item => ({item, repeat:r})));
  }
  return order;
}

// ---- geometry helpers ----------------------------------------------------------------------------------------
function validScreen(screen) { return finite(screen?.width) && finite(screen?.height) && screen.width >= 100 && screen.height >= 100; }
const diagonal = screen => Math.hypot(screen.width, screen.height);
const separationFraction = (a, b, screen) => Math.hypot((a.x - b.x) * screen.width, (a.y - b.y) * screen.height) / diagonal(screen);
const inBand = (v, [lo, hi]) => v >= lo && v <= hi;
const inEdgeBand = v => inBand(v, EDGE_BANDS.low) || inBand(v, EDGE_BANDS.high);
export function classifyTargetBand({x, y}) {
  if (inEdgeBand(x) || inEdgeBand(y)) return 'edge';
  return inBand(x, CENTER_BAND) && inBand(y, CENTER_BAND) ? 'center' : 'interior';
}
const AXIS_RANGES = {edgeLow:EDGE_BANDS.low, edgeHigh:EDGE_BANDS.high, center:CENTER_BAND, interior:[0.20, 0.80]};
const DEFAULT_SLOTS = [['edgeLow','edgeLow'], ['edgeHigh','edgeLow'], ['edgeLow','edgeHigh'], ['edgeHigh','edgeHigh'], ['center','edgeLow'], ['center','edgeHigh'], ['edgeLow','center'], ['edgeHigh','center'], ['center','center']];

function normalizeCalibrationTargets(targets) {
  if (!Array.isArray(targets)) throw new TypeError('calibrationTargets must be an array of normalised {x,y}');
  return targets.map(t => {
    if (!finite(t?.x) || !finite(t?.y) || t.x < 0 || t.x > 1 || t.y < 0 || t.y > 1) throw new TypeError('calibration target must be normalised {x,y} in [0,1]');
    return {x:round(t.x, 4), y:round(t.y, 4)};
  });
}
function normalizeRules(rules = {}) {
  const r = {...DEFAULT_FIXATION_RULES, ...rules};
  if (Object.keys(r).some(k => !(k in DEFAULT_FIXATION_RULES))) throw new TypeError('unknown fixation rule');
  if (![r.settleMs, r.dwellMs, r.interTrialMs].every(v => finite(v) && v >= 0) || r.settleMs < 300 || r.dwellMs < 500) throw new TypeError('settleMs >= 300 and dwellMs >= 500 required');
  if (!Number.isInteger(r.minValidSamples) || r.minValidSamples < 3) throw new TypeError('minValidSamples must be an integer >= 3');
  if (!finite(r.minValidFraction) || r.minValidFraction <= 0 || r.minValidFraction > 1) throw new TypeError('minValidFraction in (0,1] required');
  if (!finite(r.hitRadiusFraction) || r.hitRadiusFraction <= 0 || r.hitRadiusFraction > 0.2) throw new TypeError('hitRadiusFraction in (0,0.2] required');
  return r;
}

// Seeded, randomised-order accuracy plan: >=9 targets x >=3 repeats, disjoint from calibration targets, with centre and
// edge bands. Freeze `plan.hash` before running; any change to the plan changes the hash.
export function createAccuracyPlan({seed, screen, calibrationTargets = APP_CALIBRATION_GRIDS_NORM, targetCount = 9, repeats = 3, minSeparationFraction = 0.02, fixation = {}} = {}) {
  if (!validScreen(screen)) throw new TypeError('screen {width,height} >= 100 CSS px required');
  if (!Number.isInteger(targetCount) || targetCount < 9 || targetCount > 24) throw new TypeError('targetCount must be an integer in [9,24]');
  if (!Number.isInteger(repeats) || repeats < 3 || repeats > 10) throw new TypeError('repeats must be an integer in [3,10]');
  if (!finite(minSeparationFraction) || minSeparationFraction < 0.005 || minSeparationFraction > 0.1) throw new TypeError('minSeparationFraction in [0.005,0.1] required');
  const rules = normalizeRules(fixation), excluded = normalizeCalibrationTargets(calibrationTargets);
  const random = createSeededRandom(seed), picked = [];
  const slots = [...DEFAULT_SLOTS, ...Array.from({length:targetCount - 9}, () => ['interior', 'interior'])];
  for (const [kx, ky] of slots) {
    let found = null;
    for (let attempt = 0; attempt < 500 && !found; attempt++) {
      const candidate = {x:round(AXIS_RANGES[kx][0] + random() * (AXIS_RANGES[kx][1] - AXIS_RANGES[kx][0]), 4), y:round(AXIS_RANGES[ky][0] + random() * (AXIS_RANGES[ky][1] - AXIS_RANGES[ky][0]), 4)};
      if ([...excluded, ...picked].every(p => separationFraction(candidate, p, screen) >= minSeparationFraction)) found = candidate;
    }
    if (!found) throw new Error('could not place a target disjoint from calibration targets; relax minSeparationFraction or screen size');
    picked.push(found);
  }
  const targets = shuffled(picked.map((p, i) => ({id:`g${String(i).padStart(2, '0')}`, xNorm:p.x, yNorm:p.y, x:round(p.x * screen.width, 3), y:round(p.y * screen.height, 3), band:classifyTargetBand(p)})), random);
  const byId = new Map(targets.map(t => [t.id, t]));
  const stride = rules.settleMs + rules.dwellMs + rules.interTrialMs;
  const trials = repeatedOrder(targets, repeats, random, (a, b) => a.id === b.id).map(({item, repeat}, order) => ({
    trialId:`t${String(order).padStart(3, '0')}`, order, repeat, targetId:item.id, xNorm:item.xNorm, yNorm:item.yNorm, x:item.x, y:item.y, band:item.band, plannedOnsetMs:order * stride
  }));
  const plan = {
    kind:'accuracy_plan', version:ACCURACY_PROTOCOL_VERSION, seed, screen:{width:screen.width, height:screen.height}, repeats, minSeparationFraction, rules,
    excludedCalibrationTargets:excluded, targets:[...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), trials,
    plannedDurationMs:trials.length * stride, coverage:{center:targets.filter(t => t.band === 'center').length, edge:targets.filter(t => t.band === 'edge').length, interior:targets.filter(t => t.band === 'interior').length}
  };
  return {...plan, hash:hashWithout(plan)};
}

// Structural + hash verification. Returns {ok, errors}; it never repairs a plan.
export function verifyAccuracyPlan(plan, {expectedHash = null, minTargets = 9, minRepeats = 3} = {}) {
  const errors = [], fail = message => errors.push(message);
  try {
    if (plan?.kind !== 'accuracy_plan' || plan.version !== ACCURACY_PROTOCOL_VERSION) fail('wrong_kind_or_version');
    if (!validScreen(plan?.screen)) fail('invalid_screen');
    if (!Array.isArray(plan?.targets) || !Array.isArray(plan?.trials) || !Array.isArray(plan?.excludedCalibrationTargets)) { fail('missing_arrays'); return {ok:false, errors}; }
    if (typeof plan.hash !== 'string' || plan.hash !== hashWithout(plan)) fail('hash_mismatch');
    if (expectedHash !== null && plan.hash !== expectedHash) fail('frozen_hash_mismatch');
    if (plan.targets.length < minTargets) fail('too_few_targets');
    if (!Number.isInteger(plan.repeats) || plan.repeats < minRepeats) fail('too_few_repeats');
    const ids = new Set(plan.targets.map(t => t.id));
    if (ids.size !== plan.targets.length) fail('duplicate_target_id');
    const counts = new Map();
    for (const [i, t] of plan.trials.entries()) {
      if (t.order !== i || !ids.has(t.targetId)) fail('trial_order_or_target');
      counts.set(t.targetId, (counts.get(t.targetId) ?? 0) + 1);
      if (i && plan.trials[i - 1].targetId === t.targetId) fail('consecutive_same_target');
    }
    if (new Set(plan.trials.map(t => t.trialId)).size !== plan.trials.length) fail('duplicate_trial_id');
    if (plan.targets.some(t => counts.get(t.id) !== plan.repeats)) fail('repeat_count_mismatch');
    for (const t of plan.targets) {
      if (![t.xNorm, t.yNorm, t.x, t.y].every(finite) || t.xNorm < 0 || t.xNorm > 1 || t.yNorm < 0 || t.yNorm > 1 || Math.abs(t.x - t.xNorm * plan.screen.width) > 0.01 || Math.abs(t.y - t.yNorm * plan.screen.height) > 0.01) fail('target_geometry');
      if (t.band !== classifyTargetBand({x:t.xNorm, y:t.yNorm})) fail('target_band');
      if (plan.excludedCalibrationTargets.some(c => separationFraction({x:t.xNorm, y:t.yNorm}, c, plan.screen) < plan.minSeparationFraction - 1e-9)) fail('overlaps_calibration_target');
    }
    const has = f => plan.targets.some(f);
    if (!has(t => t.band === 'center')) fail('no_center_target');
    if (!has(t => inBand(t.xNorm, EDGE_BANDS.low)) || !has(t => inBand(t.xNorm, EDGE_BANDS.high)) || !has(t => inBand(t.yNorm, EDGE_BANDS.low)) || !has(t => inBand(t.yNorm, EDGE_BANDS.high))) fail('edge_bands_not_covered');
    normalizeRules(plan.rules);
  } catch (error) { fail(`exception:${error.message}`); }
  return {ok:errors.length === 0, errors};
}

// A trial's scored window (for the app): target shown at t0; samples count in [t0+settleMs, t0+settleMs+dwellMs].
export const trialWindow = (rules, shownAtMs) => ({settleEndMs:shownAtMs + rules.settleMs, endMs:shownAtMs + rules.settleMs + rules.dwellMs});

// G1-E: target sequence/timing for a 30-60 s first-time calibration. Planned timing only; the real duration must be measured.
export function createCalibrationSchedule({seed, screen, positionsNorm, repeats = 3, settleMs = 500, dwellMs = 700, transitionMs = 300, minTotalMs = GATE_CALIBRATION_WINDOW_MS.min, maxTotalMs = GATE_CALIBRATION_WINDOW_MS.max} = {}) {
  if (!validScreen(screen)) throw new TypeError('screen {width,height} >= 100 CSS px required');
  const positions = positionsNorm ?? [0.12, 0.5, 0.88].flatMap(y => [0.12, 0.5, 0.88].map(x => ({x, y})));
  if (!Array.isArray(positions) || positions.length < 6) throw new TypeError('at least 6 calibration positions required');
  const norm = normalizeCalibrationTargets(positions);
  if (new Set(norm.map(p => `${p.x},${p.y}`)).size !== norm.length) throw new TypeError('calibration positions must be unique');
  if (!Number.isInteger(repeats) || repeats < 1 || ![settleMs, dwellMs, transitionMs, minTotalMs, maxTotalMs].every(v => finite(v) && v >= 0) || settleMs < 300 || dwellMs < 300 || minTotalMs < 1 || maxTotalMs < minTotalMs) throw new TypeError('invalid calibration timing');
  const random = createSeededRandom(seed), slotMs = settleMs + dwellMs + transitionMs;
  const items = norm.map((p, i) => ({...p, positionIndex:i}));
  const targets = repeatedOrder(items, repeats, random, (a, b) => a.positionIndex === b.positionIndex).map(({item, repeat}, index) => {
    const shownAtMs = index * slotMs;
    return {id:`c${String(index).padStart(3, '0')}`, index, repeat, positionIndex:item.positionIndex, xNorm:item.x, yNorm:item.y, x:round(item.x * screen.width, 3), y:round(item.y * screen.height, 3), shownAtMs, windowStartMs:shownAtMs + settleMs, windowEndMs:shownAtMs + settleMs + dwellMs, endMs:shownAtMs + slotMs};
  });
  const totalMs = targets.length * slotMs - transitionMs;
  if (totalMs < minTotalMs || totalMs > maxTotalMs) throw new RangeError(`planned calibration ${totalMs} ms is outside ${minTotalMs}-${maxTotalMs} ms`);
  const schedule = {kind:'calibration_schedule', version:ACCURACY_PROTOCOL_VERSION, seed, screen:{width:screen.width, height:screen.height}, rules:{settleMs, dwellMs, transitionMs}, targets, uniquePositionsNorm:norm, totalMs, totalSeconds:totalMs / 1000, plannedOnly:true};
  return {...schedule, hash:hashWithout(schedule)};
}
