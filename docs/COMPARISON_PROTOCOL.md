# Paired ablation comparison protocol

This scorer evaluates precomputed, held-out predictions offline. It makes no provider requests, reads no API key, and does not turn the existing four-profile replay into a claim of predictive performance. The repository contains no study labels or benchmark report; the unit-test records are synthetic validation fixtures only.

## Conditions and controls

Every decision must contain all nine conditions. They share one scene frame, one `observedUntilMs` cutoff, one model configuration, and one per-request cost cap:

| Condition | Required model-input evidence |
| --- | --- |
| `scene_only` | Scene |
| `gaze_crop` | Scene and gaze crop |
| `sam_object_context` | Scene, gaze crop, SAM objects |
| `depth_context` | Scene, gaze crop, SAM objects, depth |
| `history_context` | Scene, gaze crop, SAM objects, history |
| `proactive_context` | Scene, gaze crop, SAM objects, proactive context |
| `depth_history_proactive` | Scene, gaze crop, SAM objects, depth, history, proactive context |
| `gaze_shuffled` | Scene and gaze crop made from a different gaze sample |
| `gaze_time_shifted` | Scene and gaze crop made from an earlier gaze sample |

The last two rows are controls for the gaze crop condition. The shuffled source sample must be present in that session and already processed by the decision cutoff. The time-shifted source must precede the original gaze sample by at least the configured `minGazeTimeShiftMs`. Both controls carry explicit transform metadata. They cannot use a gaze sample observed or processed after the decision cutoff.

## Input contract

`prometheus_ablation_comparison` schema version 1 has these top-level fields:

| Field | Purpose |
| --- | --- |
| `studyId` | Pseudonymous study identifier |
| `targetIds` | Ordered, shared categorical target space used by every condition and probability vector |
| `runConfig` | Shared model, prompt hash, output-token limit, cutoff field, per-request and total cost caps, gaze-control settings, and required split policy |
| `splitManifest` | Participant/session/scene assignments for train, validation, and test, plus scene-frame SHA-256 fingerprints |
| `heldoutManifest` | Predeclared test session IDs and exact decision IDs expected in the comparison |
| `sessions` | The held-out session data, labels, causal evidence metadata, and nine complete condition records for each decision |

IDs must be pseudonymous. `splitManifest` must list the train, validation, and test assignments used for model development, not just the rows selected for scoring. `runConfig.splitPolicy` is required. `subject_heldout` rejects participant, session, scene, or frame fingerprints reused across splits. `personalized_session` allows one participant to appear in multiple splits for calibration, but still rejects reused session IDs, scene IDs, and frame fingerprints; its report explicitly limits generalization to disjoint sessions from those participants and makes no cross-user claim. The held-out manifest and supplied session rows must match exactly, including every decision ID. This is a consistency check on caller-provided manifests; it cannot prove that the source dataset or annotations are truthful.

Each decision stores scene/frame IDs and hash, scene observation time, `observedUntilMs`, one gaze sample ID, optional current-object and future next-target labels, and all nine condition records. Current-object labels must be observed at or before the cutoff. A next-target label must be observed after it. Labels stay at decision level; the condition input contains no labels or free-form text.

Each condition repeats the complete model configuration and records an `input.cutoffMs` equal to the decision cutoff. Its evidence contains only IDs, kind, frame/sample references, observation and processing times, and SHA-256 digests. Evidence observation and processing times must both be at or before the cutoff. The evidence kinds and counts must match the condition table above. Scene evidence is identical across all conditions; the unmodified gaze crop is identical across `gaze_crop`, `sam_object_context`, and every depth/history/proactive arm; SAM object evidence is identical across those context arms. Unknown fields are rejected, so target labels cannot be added to model-input evidence unnoticed.

Exact record fields are:

- `runConfig`: `model`, `cutoffField`, `perDecisionCostCapUsd`, `totalCostCapUsd`, `gazeShuffleSeed`, `minGazeTimeShiftMs`, `splitPolicy`. The `model` object is `provider`, `modelId`, `revision`, `promptSha256`, `temperature`, `maxOutputTokens`.
- `splitManifest` row: `participantId`, `sessionId`, `sceneId`, `split`, `sceneSha256s`.
- `heldoutManifest` row: `participantId`, `sessionId`, `decisionIds`.
- `session`: `participantId`, `sessionId`, `gazeSamples`, `decisions`. A gaze sample is `sampleId`, `observedAtMs`, `processedAtMs`.
- `decision`: `decisionId`, `sceneId`, `frameId`, `sceneSha256`, `sceneObservedAtMs`, `observedUntilMs`, `gazeSampleId`, `currentObjectLabel`, `nextTargetLabel`, `conditions`.
- `condition`: `model`, `input`, `result`, `call`. `input` is `cutoffMs`, `evidence`, `gazeSourceSampleId`, `gazeTransform`. An evidence row is `id`, `kind`, `sourceFrameId`, `observedAtMs`, `processedAtMs`, `sha256`; `gaze_crop` rows also require `sourceSampleId`. `history` may contain multiple evidence rows.
- `result`: `currentObjectId`, `nextTarget`. `nextTarget` is `abstained`, `rankedTargetIds`, `probabilities`; probabilities are either `null` or a full vector in `targetIds` order.
- `call`: `status`, `errorCode`, `startedAtMs`, `completedAtMs`, `latencyMs`, `cacheState`, `cacheSourceDecisionId`, `costUsd`, `costCapUsd`.

Each result includes a nullable current-object ID and a next-target ranking. A next-target abstention must have an empty ranking and no probabilities. Optional probabilities must cover every ID in `targetIds`, sum to one, and assign maximal probability to the top-ranked ID. Brier score is reported only for those complete distributions. It is the unnormalized multiclass sum of squared errors over the full target space.

Each call includes status, start/completion times, latency, cache state, source decision for a cache hit, cost in USD, and the cost cap. Calls start at or after the decision cutoff, and elapsed time must match the recorded latency. Cache hits must point to a completed result from the same condition in the same session, available before the cache lookup; the cached prediction must match exactly and incremental provider cost must be zero. Costs are caller-reported estimates, not invoices. Total reported cost must fit under the fixed experiment cap.

## Scoring and uncertainty

The report includes current-object accuracy and coverage; next-target Top-1 and Top-3 accuracy among answered decisions and over all labeled decisions (abstentions count as incorrect in the latter); next-target coverage; Brier score when available; signed lead time from response completion to the labeled next-target event for correct Top-1 predictions; and latency p50/p95 split by fresh call and cache hit. Cost totals and fresh/cache counts are reported per condition.

Paired ablation contrasts are fixed in the code: gaze crop vs scene-only; SAM context vs gaze crop; each single-factor depth, history, and proactive addition vs SAM context; the combined depth/history/proactive addition vs SAM context; and each gaze control vs gaze crop. The single-factor conditions isolate each addition; the combined condition measures their combined effect. The paired error table counts both-correct, candidate-only-correct, reference-only-correct, and both-wrong decisions. Metric deltas and 95% percentile confidence intervals resample session means, keeping decisions from one session clustered together. The bootstrap seed and iteration count are recorded. With fewer than two usable sessions, the interval is null. Intervals are descriptive and there is no multiple-comparison correction.

## Blinded open-hypothesis quality review

Categorical target scores do not establish that SAM or the reasoner resolved useful scene information. Reviewers should first record an open-ended assessment of what each output claims, what evidence supports it, what appears false, and whether it helps with a possible next action. Only then should they apply the rubric below. Keep conditions and model identity masked with randomized output labels; show the same pre-cutoff scene and permitted evidence context to both reviewers. Reveal the annotated next event only after each reviewer records an initial assessment.

| Criterion | Rating |
| --- | --- |
| Grounding | 0: material claims are unsupported or contradicted; 1: some claims are traceable but at least one material claim is unsupported; 2: every material claim is traceable to permitted pre-cutoff evidence. Record evidence references. |
| False assertions | Count each distinct material claim contradicted by the scene or reviewed labels; record the claim and the contradicting reference. Do not infer an error from a missing claim. |
| Possible-action relevance | 0: irrelevant or unusable; 1: broadly relevant but generic or incomplete; 2: specific and consistent with the independently annotated next action. |
| Uncertainty and abstention | 0: overstates certainty or gives a concrete target where evidence is insufficient; 1: expresses uncertainty or abstains when needed, and is direct when the evidence is sufficient. Record why an abstention was or was not appropriate. |

Use two independent human reviewers. Preserve each rating before discussion, report raw agreement and every disagreement, and document any adjudication separately. Do not replace human labels with an LLM judge. If only one reviewer is available, report that limitation and do not present the result as an independently reviewed quality comparison.

Store the review sidecar outside the source repository at `data/evaluations/<study-id>/human-review.json` (or another access-controlled external location). Include the blinded item IDs, rubric version, reviewer IDs as pseudonyms, per-reviewer notes and ratings, disagreement/adjudication records, and the final external file path in the study report. No sidecar or review ratings are included in this repository; until reviewers complete it, open-hypothesis quality is `not_assessed`.

## Run

Prepare the schema above from verified held-out predictions and labels, then run:

```sh
node scripts/evaluate-comparison.mjs --input heldout.json --output report.json
```

The script hashes the exact input bytes and writes the report exclusively; it will not replace an existing file. Optional `--seed` and `--bootstrap-iterations` set deterministic session bootstrap parameters. Input is capped at 64 MiB. No network, model runtime, browser, or API key is used.

An optional same-model GPU runtime comparison can use the same held-out manifest, scene/gaze evidence digests, model and prompt configuration, cutoff, and cost caps with predictions captured from the GPU run. Score that artifact with the same command and compare its condition metrics with the corresponding primary run. This scorer does not execute GPU jobs or produce a cross-device paired delta report. The installed Colab CLI 0.7.5 version/help check is not evidence of supported Windows execution, GPU access, or authentication; those remain unverified and are not prerequisites for this scorer. Record runtime, hardware, and authentication evidence separately; a model name or CLI version alone does not establish GPU execution. A different model (for example, a separate GazeQwen baseline) is not an ablation under this protocol and must not be presented as a same-model comparison.

## Limits

The validator can check recorded timestamps, split IDs, fingerprints, condition completeness, shared configuration, and the shape of outputs. It cannot inspect model prompts from their hash, verify that evidence digests correspond to actual pixels or sensor records, prove annotation independence, prove the external prediction generator did not read labels, authenticate a GPU, or verify provider billing. A report describes only the supplied data; it does not establish product quality or T08 passage. Do not publish a score until the manifest, annotation provenance, consent, and held-out split have been independently reviewed.
