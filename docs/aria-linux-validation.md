# Linux Aria VRS verification (prepared, not yet run)

2026-10-28: The user cannot use SSH. A manual USB/shared-folder package is available at `artifacts/aria-kali-validation-20261028.zip` (280,232,520 bytes). Its four source/data entries were verified against the bundled SHA-256 manifest; archive SHA-256 is `8b06909fc3979b66d5d34749a8ffca1acd60ad12062952f91629240134d1e672`. Unzip on Kali, follow README.md, and return only `aria-vrs-summary.json`. No API credential is needed. This preparation is not an SDK execution or Gate pass.

The script verifies the already-downloaded official public Gen 2 sample, not the licensed Pilot Dataset. This work has not been run with the SDK and does not establish a Gate pass. Use a user-approved Linux host and a dedicated working directory. It needs Python 3.10–3.14 and the [official Gen 2 supported platform](https://facebookresearch.github.io/projectaria_tools/gen2/research-tools/projectariatools/installation). No Meta API key is used or transferred.

Transfer only `scripts/aria_verify_vrs.py`, `src/aria/mps_csv.py`, `data/aria/aria_gen2_sample_data_1.vrs` and optionally `data/aria/closed_loop_trajectory.csv`, preserving relative directories. Confirm host identity and authorized access separately. Then in that directory:

```sh
python3 -m venv .venv-aria
.venv-aria/bin/python -m pip install 'projectaria-tools==2.3.0'
.venv-aria/bin/python scripts/aria_verify_vrs.py data/aria/aria_gen2_sample_data_1.vrs --mps-csv data/aria/closed_loop_trajectory.csv --output aria-vrs-summary.json
```

The script verifies SHA-256 `52e78d73dfc12b1d551292e0598b2babc7851c83297ebaab318686fb372f5c7f` before opening the file. It enumerates stream labels and time domains; resolves RGB and eye-gaze streams by label; decodes up to three RGB images into memory without writing pixels; samples on-device gaze validity and timestamps; and reports whether RGB calibration and device-to-CPF transform exist. It counts offline MPS poses at or before the last sampled RGB timestamp and labels them `offline_assisted`. This cutoff does not make MPS causal or establish synchronization accuracy. On-device gaze is `unknown` causality until timing and processing are validated. Missing streams, failed reads, and checksum mismatches produce explicit nulls/reasons and partial or blocked status. `inspected` means the three sampled inputs and calibration were present; it is not accuracy, alignment or device quality validation.

The JSON summary contains metadata, timestamps, dimensions, hashes and counts, with no pixel, audio, gaze vector, or credential data. Provider SDK logging may still emit diagnostics to the terminal; review output before sharing. The verification follows the official [VRS data provider API](https://github.com/facebookresearch/projectaria_tools/blob/main/core/data_provider/VrsDataProvider.h), [Gen 2 eye tracking tutorial](https://facebookresearch.github.io/projectaria_tools/gen2/research-tools/dataset/pilot/tutorials/vrs_loading), and [device calibration](https://facebookresearch.github.io/projectaria_tools/gen2/technical-specs/device/calibration). The script is a prepared verifier; actual SDK behavior and this recording's gaze availability remain unverified until run.
