# Local Depth Anything V2 metric provider

This U07 provider runs the official **Depth Anything V2 Metric Hypersim Small** (`vits`) checkpoint locally. It accepts one PNG or JPEG frame, returns the full-size axial-Z map in metres, and carries the exact frame ID and observation timestamp. It does not call a renderer, cloud model, or external API.

The model was installed from the official [Depth Anything V2 metric-depth instructions](https://github.com/DepthAnything/Depth-Anything-V2/blob/a561b849ebae10a6f5ef49e26c83cbbcd36c71bf/metric_depth/README.md) and the [official Hypersim Small checkpoint](https://huggingface.co/depth-anything/Depth-Anything-V2-Metric-Hypersim-Small). The model card lists Apache-2.0. Its documented output is metric depth in metres, with a 20 m maximum for the indoor Hypersim model. The application records these values as `units: "m"`, `convention: "axial_z"`, and `depthSource: "monocular_estimated_depth"`; it remains a monocular estimate, not sensor ground truth.

## Install on Windows

From the project root, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/depth/setup.ps1
```

The script pins the upstream source commit and package versions, downloads the checkpoint into the ignored `.asset-tmp/depth-runtime/` directory, and verifies its SHA-256 before loading it. It will stop if the downloaded checkpoint differs from the verified hash. Nothing under the runtime directory is committed.

The tested environment used Python 3.12.10 and CPU-only PyTorch 2.6.0 / torchvision 0.21.0. Intel Iris Xe acceleration is not enabled in this environment; inference runs on CPU.

## One-frame CLI

```powershell
& .asset-tmp/depth-runtime/venv312/Scripts/python.exe scripts/depth/infer.py `
  --runtime-home .asset-tmp/depth-runtime `
  --image C:/data/frame.png `
  --frame-id camera-frame-42 `
  --observed-at 1000 `
  --output .asset-tmp/depth-runtime/frame-depth.npz
```

The CLI emits a JSON summary to stdout. The `.npz` contains `depth_m` (`float32`, zero for invalid values) and `valid_mask` (`uint8`, 1 means valid). Input frames and depth outputs are not copied into the repository outside the ignored runtime path.

## Node service

```js
import { createDepthProvider } from './server/depth-provider.js';

const depthProvider = createDepthProvider();
const result = await depthProvider.infer({ frame, imageDataUrl, signal });
// result.frame, result.depth, result.model, result.timing
await depthProvider.close();
```

The service starts one local Python worker and reuses its loaded model. It permits one in-flight frame, rejects another with `DEPTH_PROVIDER_BUSY`, and kills the worker on abort or timeout. Image inputs are restricted to canonical PNG/JPEG data URLs up to 5 MiB; each dimension is at most 4096 and area at most 1,048,576 pixels. The frame dimensions must match the decoded image. The worker emits a parallel 0/1 validity mask and zeroes invalid depth samples. The adapter rejects a response if frame ID/time, dimensions, model hash, unit, convention, mask, or output values fail validation.

The adapter returns the metric image map and model/timing metadata. The caller must attach its same-frame intrinsics, camera pose, causal processing timestamp, and other runtime-only fields before passing a depth object to the perception pipeline. A depth map without camera calibration cannot be unprojected into world coordinates.

## Local verification

```powershell
node --test test/depth-provider.test.js
& .asset-tmp/depth-runtime/venv312/Scripts/python.exe scripts/depth/test_model.py
```

The four Node tests cover the local worker protocol, request bounds, single in-flight behavior, frame mismatch rejection, and cancellation. Five Python unit tests cover image decoding/alignment, input bounds, request validation, validity masks, and empty-output rejection; the inference test uses a stub and is not model evidence.

The actual checkpoint smoke is in [`evidence/depth-u07-20261031.json`](evidence/depth-u07-20261031.json). It used a locally generated 640×360 synthetic indoor-style RGB scene. This verifies model loading and end-to-end value production only; it does not establish camera performance, absolute-depth accuracy, or the G2-B comparison against engine ground truth. The recorded result is explicitly synthetic.

