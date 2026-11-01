# Comparison protocol v2 (generator, ledger, scorer)

Versioned sidecar contract for G5-D. It implements the audit items A02-A06, A10 and A11 ([audit](GATE_PROTOCOL_AUDIT_20261101.md)) without touching v1 (`src/evaluation/comparison.js`, `scripts/evaluate-comparison.mjs`, `COMPARISON_PROTOCOL.md`). Passing v1 validation says nothing about v2 and vice versa.

**Status: implemented and unit-tested on synthetic fixtures only.** No provider call, camera, Depth Anything run, SAM run, annotator, or study data exists for v2. Nothing here passes G5-D or any other Gate. Reports carry `dataProvenance` (`synthetic` or `provider`) copied from the ledger header, and `gateStatus.g5d: not_evaluated`.

## Pipeline

`study manifest (frozen, hashed)` -> `generator` -> `append-only JSONL ledger` -> *(separate, later)* `annotations bound to the closed ledger` -> `scorer` -> `report`.

| File | Role |
| --- | --- |
| `src/evaluation/manifest.js` | Manifest validator, canonical JSON, SHA-256, condition registry, factorial cells |
| `src/evaluation/generator.js` | Decision validation, artifact re-hash, deterministic prompt build, sequential provider calls, ledger |
| `src/evaluation/comparison-v2.js` | Scorer (`evaluateComparisonV2`, `baselinePrediction`) |
| `scripts/generate-comparison.mjs` | Generator CLI (dry run default) |
| `scripts/evaluate-comparison-v2.mjs` | Scorer CLI |

## Study manifest

Exactly these fields; unknown fields are rejected. The hash is SHA-256 of the canonical JSON (sorted keys) of the validated manifest. The generator writes it into the ledger header; the scorer refuses (`MANIFEST_HASH_MISMATCH`) when the supplied manifest hashes differently. This catches a threshold edited after results exist, provided the ledger header hash is anchored somewhere the analyst cannot rewrite (see Limits).

`schemaVersion:1, kind:'prometheus_study_manifest', studyId, thresholdVersion, conditions, horizons (subset of 1000/3000/5000), endpoints, primaryEndpoint {endpoint,horizonMs,metric:'anticipation_success'}, primaryContrast {candidate,reference}, practicalDelta, noninferiorityMargins (coverage|deadlineAccuracy|endToEndAccuracy), coverageFloor, deadlineMs, maxResultAgeMs, samplePlan {minSessions,minEligibleDecisions,maxSessions,bootstrapIterations,seed}, stoppingRule {kind:'fixed_sample'}, exclusionRules {sessionEndRule,trackingLostRule,gazeQualityMinValidFraction}, multiplicityPolicy {method:'holm'|'none',alpha,confirmatory[]}, annotationPolicy, calibration {bins,minSamples}, controls {gazeShuffleSeed,minGazeTimeShiftMs}`.

Endpoint definitions are fixed strings: `next_look_onset` = first fixation onset (min `minFixationMs`) in `(cutoff, cutoff+horizon]`; `next_interaction` = first user interaction in the same window. The primary contrast cannot use a diagnostic arm. `candidate` must be a manifest condition; `reference` may also be a baseline.

## Conditions

All 9 v1 conditions plus the four A02/A03 controls are mandatory; oracle and factorial arms are optional.

| Condition | Evidence kinds |
| --- | --- |
| v1 nine | as in `COMPARISON_PROTOCOL.md` |
| `spatial_memory_context` | scene, gaze_crop, sam_objects, history, spatial_memory (coordinates, object state version, relations, retrieval) |
| `history_only_matched` | same history items as above, no spatial fields (A02 control) |
| `sam_bbox_crop` / `sam_mask_foreground` | scene, gaze_crop, one image per candidate; object, width, height and area must match across the pair (`CROP_MISMATCH`) (A03) |
| `oracle_mask`, `oracle_gaze`, `oracle_depth` | `diagnostic:true`; evidence marked `oracle_diagnostic`; excluded from primary/confirmatory claims; contrasts flagged `excludedFromPrimaryClaims` |
| `depth_history`, `depth_proactive`, `history_proactive` | complete the 2^3 depth x history x proactive cells with the existing `sam_object_context`, `depth_context`, `history_context`, `proactive_context`, `depth_history_proactive` |

Interaction effects are computed only when all eight cells are in the manifest and ledger; otherwise `interaction.status:'refused'` with `missingCells`.

## Generator

Decision input (strict, see `validateDecision`): ids, `observedUntilMs`, `issuedAtMs` (>= cutoff), neutral `candidates`, `scene`, `gaze` (+ crop artifact), optional `gazeControls`, `samObjects`, `samInputs`, `depth`, `history`, `spatialMemory`, `proactive`, `oracle`. Artifacts are `{id,sha256,observedAtMs,processedAtMs,mediaType, path|base64|text}`; every artifact is re-hashed before use and again before each decision's calls (`ARTIFACT_HASH_MISMATCH`); paths cannot leave `--base-dir`.

Leakage guard: any key containing `label`, `target`, `future`, `groundTruth`/`truth`, `annotation`, `answer`, `outcome`, `nextLook|nextInteraction|nextGaze` anywhere in a decision is rejected (`LABEL_LEAK`). Prompt inputs are built from whitelisted fields only. Anything observed or processed after the cutoff is rejected (`FUTURE_INPUT`). Free-text values are not scanned.

Prompt input: `{task, observedUntil, issuedAt, evidence[], imageDataUrl, horizonMs, candidates[], images?}`. `promptSha256` is SHA-256 of its canonical JSON. `callProvider(promptInput,{signal,endpoint})` is injected and called sequentially, one call per decision x horizon x endpoint x condition, with a timeout. `maxCalls` and `budgetUsd` are checked before each call; remaining cells get a `budget_exhausted` row.

### Ledger (JSONL, exclusive create)

Each line: `{seq,type,prevHash,payload,hash}` with `hash = sha256(canonicalJson({seq,type,prevHash,payload}))` and `prevHash` of line 0 = 64 zeros. Order: one `header`, N `record`, one `footer`.

- `header`: `schemaVersion, kind:'prometheus_generation_ledger', studyId, manifestSha256, thresholdVersion, provenance:'synthetic'|'provider', createdAtMs, limits, plannedCells`.
- `record` (one per planned cell, failures included): `decisionId, participantId, sessionId, condition, diagnostic, endpoint, horizonMs, observedUntilMs, candidateIds, promptSha256, promptBytes, artifacts[{id,sha256}], gazeSourceSampleId, gazeTransform, newestInputObservedAtMs, issuedAtMs, availableAtMs, renderedAtMs, latencyMs, status (ok|timeout|parse_failed|provider_failed|budget_exhausted), errorCode, responseSha256, result {abstained,rankedTargetIds,probabilities}|null, provider, usage, costUsd, costSource`.
- `footer`: `recordCount, closedAtMs, callsMade, spentUsd`.

`issuedAtMs` is the decision's pre-registered issue time; `availableAtMs = issuedAtMs + measured latency` (session timeline, deliberately delayed offline replay); `renderedAtMs` is null unless the decision supplies `renderLatencyMs`. Non-ok rows have no result and no availability. `probabilities`, when present, is a full vector aligned with `candidateIds`. `responseSha256` hashes the canonical JSON of the value the injected provider returned (optionally saved under `--raw-dir`). Costs are estimates, not invoices.

`verifyLedgerText` detects edited, deleted, reordered, appended and truncated lines (`LEDGER_TAMPERED`, `LEDGER_UNCLOSED`).

## Annotations

Separate file, written after the ledger closes: `schemaVersion:1, kind:'prometheus_annotations_v2', studyId, ledgerTailSha256, boundAtMs, sessions[{participantId,sessionId,sessionEndMs,fixations[{objectId,onsetMs,endMs}],interactions[{objectId,atMs}],decisions[{decisionId,observedUntilMs,gazeValidFraction,outcomes[endpoint][horizon]}]}]`. Outcome per endpoint and horizon: `{outcome:'event',targetId,eventAtMs}`, `no_event`, `tracking_lost` or `session_end_censored`. The scorer checks that an `event` is the first fixation/interaction in the window and that `no_event` windows hold none (`ANNOTATION_INCONSISTENT`), that `ledgerTailSha256` equals the ledger tail (`ANNOTATION_LEDGER_MISMATCH`) and `boundAtMs >= footer.closedAtMs`.

## Scoring

Per endpoint x horizon (never mixed):

- **Outcome categories** per decision; `no_event` whose window passes `sessionEndMs` becomes `session_end_censored` (counted in `excluded.reclassifiedNoEventToCensored`). Tracking-lost and censored decisions leave the success denominator and are reported.
- **Anticipation success** = correct top-1, status ok, `availableAtMs < eventAtMs`, `availableAtMs <= observedUntilMs + deadlineMs`, and result age (`availableAtMs - newestInputObservedAtMs`) <= `maxResultAgeMs`. Denominator = all eligible (`event`) decisions; failures, timeouts and abstentions count as misses. Lead time is reported only for successes. Also: end-to-end top-1/top-3, deadline accuracy, late-correct count, coverage (usable answers over event+no_event decisions), false-alarm rate.
- **Error decomposition** (A06): all / gaze-quality-gated (`gazeValidFraction >= gazeQualityMinValidFraction`) / below gate / unknown: candidate recall, reasoning accuracy given candidate present, end-to-end accuracy.
- **Baselines** (computed by the scorer from pre-cutoff fixations/interactions only): `baseline_current_hold`, `baseline_markov` (first-order transitions from the current state; abstains on unseen states). `newObjectTransition` reports the subset where target differs from the current object.
- **Calibration**: Brier and ECE (manifest bins, `minSamples`) only from complete probability vectors; coverage-risk curve over confidence-ordered answers (denominator = eligible decisions).
- **Preparation**: prepare hit, useful hit (success and not a duplicate), wrong preparations and duplicate updates per session-minute.
- **Statistics**: paired session-level percentile bootstrap (sessions are the unit, decisions stay clustered), seed and iterations from the manifest.
- **Verdict** on the primary contrast: `underpowered` if sessions with eligible decisions < `minSessions` or eligible decisions < `minEligibleDecisions`; else `improvement_supported` only if CI lower bound > `practicalDelta`, every noninferiority CI lower bound > -margin, and the arm's coverage >= `coverageFloor`; else `improvement_not_established`. More sessions than `maxSessions` is refused (`STOPPING_RULE_VIOLATION`).
- **Multiplicity**: `confirmatory` contrasts (primary endpoint and horizon only) get Holm-adjusted p-values and intervals at level `1 - alpha/k`; every other contrast, horizon or endpoint is `exploratory` with an unadjusted 95% interval. The scorer refuses a missing ledger cell (`LEDGER_INCOMPLETE`) or decision-set mismatch.

## CLI

```sh
# default dry run: builds and hashes every prompt, never calls a provider
node scripts/generate-comparison.mjs --manifest manifest.json --decisions decisions.json [--output plan.json]

# execution (not run in this repository): all consent and limit flags are mandatory
node scripts/generate-comparison.mjs --manifest manifest.json --decisions decisions.json \
  --execute --external-transfer --max-calls 200 --budget-usd 10 --ledger ledger.jsonl

node scripts/evaluate-comparison-v2.mjs --manifest manifest.json --ledger ledger.jsonl \
  --annotations annotations.json --output report.json [--expect-manifest-sha256 <hex>]
```

`--execute` uses `server/reasoner-adapter.js` through a dynamic import. That adapter takes one image, `scene|gaze|memory|mask` evidence and returns `nextGaze` only, so the CLI refuses (`ADAPTER_UNSUPPORTED`) any manifest with `next_interaction`, bbox/mask crop arms or oracle arms. Supply `--provider-module file.mjs --provenance synthetic|provider` exporting `callProvider(promptInput,{signal,endpoint})` for those. Outputs are written with exclusive create.

## Limits

- No real study has been run. All tests use synthetic fixtures and fake providers; no network, no API key.
- A ledger stored next to its analyst proves internal consistency and tamper evidence, not that the manifest was frozen in advance. Anchor the manifest hash and ledger tail hash externally (commit, timestamp, second party).
- Label isolation and independence of annotators, ground-truth truthfulness, provider billing and that artifact bytes show what they claim are not verifiable here.
- Gaze crops are sent as a point and rectangle plus a re-hashed crop digest; the existing adapter cannot carry crop images. Oracle arms show the upper bound of perfect inputs, not a product capability.
- The look endpoint on free observation has no independent gaze ground truth; use known-target tasks (`annotationPolicy.lookSource`).
- Bootstrap p-values are floor-limited at about 2/(iterations+1); Holm on bootstrap p-values is conservative guidance, not an exact test.
- Open-hypothesis quality (two blind reviewers) is outside this scorer and remains `not_assessed`.
