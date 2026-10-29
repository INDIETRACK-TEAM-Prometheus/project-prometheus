# Paired research replay

The local trace export contains consented scene and gaze evidence. Treat both the export and the report as sensitive local files. Supply pseudonymous participant and scene IDs and a train, validation, or test split; do not put real identifiers in these fields. Within one run, the runner rejects participant IDs, scene IDs, or identical scene-image fingerprints that occur across splits when multiple groups are supplied programmatically. The CLI accepts one group per run and cannot certify separation across an entire dataset or across separate runs.

Dry run (no provider requests):

```sh
node scripts/evaluate-trace.js --input trace.json --output report.json --participant p1 --scene s1 --split test
```

Execution sends the scene and applicable gaze, history, and memory to the configured Meta reasoner. It requires explicit transfer permission and limits, for example:

```sh
node scripts/evaluate-trace.js --input trace.json --output report.json --participant p1 --scene s1 --split test --execute --external-transfer --max-calls 12 --estimated-budget-usd 0.60
```

The default is at most one decision and a $0.05 reservation per call; `--max-decisions` and `--estimated-call-usd` may be set explicitly. Reservations and request counts are checked before every call. These are estimates, not a guarantee of the provider's billed cost; reported cost is included when available. There are no automatic retries. Failed and limited cells remain in the report. Output is created exclusively, so the command will not overwrite or resume an existing report. An interrupted run may leave an incomplete file; inspect it and choose a new output path deliberately before any new execution.

Each selected decision yields four independent profiles at each of 1, 3, and 5 seconds, using one frame and cutoff. Scene-only does not contain gaze. Held-out labels and group IDs are not model inputs. Dry runs and fixture results do not constitute T08 passage; this report makes no accuracy or improvement claim. Actual replay requires an eligible trace, verified timing, appropriate consent, and a configured provider. No labels are invented.
