# Paired ablation comparison protocol

This scorer evaluates precomputed, held-out predictions offline. It makes no provider requests, reads no API key, and does not turn the existing four-profile replay into a claim of predictive performance. The repository contains no study labels or benchmark report; the unit-test records are synthetic validation fixtures only.

## Conditions and controls

Every decision must contain all nine conditions. They share one scene frame, one `observedUntilMs` cutoff, one model configuration, and one per-request cost cap:

| Condition | Required model-input evidence |
| --- | --- |
| `scene_only` | Scene |
| `gaze_crop` | Scene and gaze crop |
| `sam_object_context` | Scene, gaze crop, SAM objects |
| `depth_context` | Scene, gaze crop, SAM objects, actual Depth Anything V2 metric output |
| `history_context` | Scene, gaze crop, SAM objects, history |
| `proactive_context` | Scene, gaze crop, SAM objects, proactive context |
| `depth_history_proactive` | Scene, gaze crop, SAM objects, the same Depth Anything output, history, proactive context |
| `gaze_shuffled` | Scene and gaze crop made from a different gaze sample |
| `gaze_time_shifted` | Scene and gaze crop made from an earlier gaze sample |

The last two rows are controls for the gaze crop condition. The shuffled source sample must be present in that session and already processed by the decision cutoff. The time-shifted source must precede the original gaze sample by at least the configured `minGazeTimeShiftMs`. Both controls carry explicit transform metadata. They cannot use a gaze sample observed or processed after the decision cutoff.

## Depth Anything: model, generation, and evaluation

The depth treatment in this experiment is **Depth Anything V2 Metric Hypersim Small**, model ID `depth-anything/Depth-Anything-V2-Metric-Hypersim-Small`, encoder `vits`, indoor maximum depth 20 m. Use the pinned checkpoint, source revision, runtime versions, and SHA-256 recorded by the existing [local provider](depth-anything-v2-local.md) and its [synthetic smoke evidence](evidence/depth-u07-20261031.json). The smoke verifies execution, not accuracy. The [official metric instructions](https://github.com/DepthAnything/Depth-Anything-V2/blob/a561b849ebae10a6f5ef49e26c83cbbcd36c71bf/metric_depth/README.md) and [checkpoint card](https://huggingface.co/depth-anything/Depth-Anything-V2-Metric-Hypersim-Small) are the source contracts.

### Generation and causal availability

1. Use the exact scene RGB frame shared by all nine conditions, not the webcam image of the participant's face. Invoke `createDepthProvider().infer({frame,imageDataUrl,signal})` or the local `/api/depth/estimate` route. Preserve frame ID, observation timestamp, dimensions, and RGB digest.
2. Save the actual full-resolution predicted `depth_m` map and its validity mask. The provider reports metres, axial camera Z, and `depthSource: monocular_estimated_depth`. A zero with invalid mask is missing data, not a zero-distance surface. Do not substitute standard relative-depth checkpoints or renderer output.
3. Record when the result actually became available. The experiment cutoff must be no earlier than completion of every included input, including Depth Anything. Use that same cutoff for every paired condition. If depth is late, move the common decision cutoff forward or record a missed/withheld depth decision; never backdate processing time to the RGB capture time.
4. Reuse the same saved prediction in `depth_context` and `depth_history_proactive`. Do not rerun the depth model selectively until a better map appears. Keep the common LLM model/prompt configuration and the predeclared output limits/cost caps unchanged.
5. Include depth preprocessing/inference/serialization time in pipeline preparation latency and account for local compute separately from LLM provider cost. Report cold model startup and warmed frame inference separately; cached depth must retain original frame and availability time. A fast cache lookup is not fresh depth inference.

This is a deliberately delayed paired offline decision when required inputs need time to become available. For live prediction, score the actual available inputs and whether the predicted next event has already occurred; do not use later-generated depth to claim an earlier prediction. A separate matched-delay control can delay the no-depth arm by the same preparation time to isolate added information from added observation time.

### What the LLM receives

Generate one deterministic, versioned structured depth artifact from the map and same-frame SAM masks. For each candidate, include its frame-scoped object ID, valid pixel fraction, median axial depth and interquartile range in metres, and the current gaze pixel's depth when valid. Compute object statistics from foreground mask pixels, not all pixels in its bounding box. Freeze the minimum valid-pixel fraction and sampling policy in the study manifest before scoring. If too few valid pixels remain, use an explicit missing reason and abstain from numerical depth for that object.

Optionally include near/far relations only when the declared uncertainty intervals do not overlap. These intervals describe map spread, not calibrated model confidence. Do not invent confidence values or object-centre depth from an empty region. The no-depth arms receive the same RGB, SAM masks, and candidate IDs but no depth values, near/far labels, or depth-derived XYZ. Hash the canonical serialized artifact; use that digest in the schema's existing `kind: depth` evidence row. The payload format and transformation revision belong to the study sidecar, not new unknown fields in the strict scorer schema.

Metric XYZ additionally needs the same-frame camera intrinsics and camera-to-world transform. Record resize/crop transformations and use `X_camera = z * inverse(K) * [u,v,1]`; distinguish axial Z from ray range. Without those calibrated inputs, retain image depth and withhold world XYZ. A scene-surface depth is not measured binocular fixation depth.

### Two different quality questions

| Question | Paired comparison and metrics |
| --- | --- |
| Is Depth Anything geometrically accurate? | Compare model depth against separately saved renderer ground truth for the exact synthetic RGB/camera frame. Report valid coverage, MAE (m), RMSE (m), AbsRel, and threshold accuracy `max(pred/gt,gt/pred) < 1.25` on a predeclared valid, positive, in-range GT mask. Report foreground objects, boundaries, and gaze pixels separately. Report model-missing pixels in coverage rather than silently excluding them. |
| Does estimated depth improve LLM attention/action inference? | Compare `depth_context` vs `sam_object_context` on identical held-out decisions. Report the existing current-object, next-target, coverage, lead-time, latency, and blinded open-hypothesis quality metrics, with paired session-level intervals. A better depth MAE alone does not establish better reasoning. |

Use the raw metric output for the primary depth accuracy result. Do not fit scale/shift to test GT or normalize each frame to match the renderer. If a scale correction is investigated, fit it only on the training/calibration split, freeze it, and report it as a separate experiment. Synthetic accuracy does not establish accuracy on real scenes without independent sensor/range ground truth.

An additional **engine-depth oracle arm** may estimate the benefit of perfect geometry; it must be reported outside this nine-condition scorer as a separately named experiment. Engine GT must never enter the model-depth artifact or be labelled Depth Anything. A predeclared shuffled-depth or object-depth-permutation control may test whether gains come from useful geometry, but similarly requires a separate documented experiment/schema extension; these arms are not currently supported by this scorer.

### Required depth sidecar and current implementation limits

Store a depth sidecar under the ignored study-data directory with: model ID/checkpoint hash/source revision/license; runtime/device/input resolution; RGB/map/mask/artifact digests and local paths; frame ID and observation/availability times; units/convention/invalid policy; cold/warm timings; SAM revision/mask IDs; structured-artifact policy; optional intrinsics/pose; GT provenance and evaluation ROI; metric report. Link its depth artifact digest to every corresponding evidence row. Keep GT and future labels outside model input.

The existing comparison CLI validates evidence hashes, timestamps, and paired-condition consistency. **It does not run Depth Anything, build mask-depth summaries, inspect map files, compute depth accuracy, or independently verify the sidecar.** Those steps require generation and verification before categorical scoring. The existing provider and smoke are implemented; this section specifies the still-required accuracy and reasoning experiments. Depth quality and improvement Gates remain unpassed until actual held-out results exist.

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
