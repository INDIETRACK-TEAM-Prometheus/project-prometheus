#!/usr/bin/env bash
# One-time setup of a Linux GPU host (tested target: Kali rolling, NVIDIA MX450, driver 550) for the Prometheus
# gaze and depth workers. Everything lives under ~/prometheus-gpu; the system Python and packages are not touched.
# Gaze (TensorFlow) and depth (PyTorch) get separate Python 3.12 environments because each bundles its own CUDA libraries.
set -euo pipefail

ROOT="${PROMETHEUS_GPU_ROOT:-$HOME/prometheus-gpu}"
mkdir -p "$ROOT"/{gaze/app,depth/app,logs,run}

if ! command -v nvidia-smi >/dev/null || ! nvidia-smi >/dev/null 2>&1; then
  echo "NVIDIA driver is not working (nvidia-smi failed); install the driver first" >&2
  exit 2
fi

# uv from PyPI in its own venv (Kali's system pip is externally managed); uv then provides a standalone Python 3.12.
if [ ! -x "$ROOT/tools/bin/uv" ]; then
  python3 -m venv "$ROOT/tools"
  "$ROOT/tools/bin/python" -m pip install --quiet --disable-pip-version-check "uv==0.9.5"
fi
UV="$ROOT/tools/bin/uv"

if [ ! -x "$ROOT/gaze/venv/bin/python" ]; then "$UV" venv --quiet --python 3.12 "$ROOT/gaze/venv"; fi
VIRTUAL_ENV="$ROOT/gaze/venv" "$UV" pip install --quiet --python "$ROOT/gaze/venv/bin/python" \
  "tensorflow[and-cuda]==2.19.0" "mediapipe==0.10.32" "opencv-python-headless==4.10.0.84"

if [ ! -x "$ROOT/depth/venv/bin/python" ]; then "$UV" venv --quiet --python 3.12 "$ROOT/depth/venv"; fi
# cu124 wheels match the 550 driver (CUDA 12.4) without relying on forward compatibility.
VIRTUAL_ENV="$ROOT/depth/venv" "$UV" pip install --quiet --python "$ROOT/depth/venv/bin/python" \
  --index-url https://download.pytorch.org/whl/cu124 --extra-index-url https://pypi.org/simple \
  "torch==2.6.0" "torchvision==0.21.0" "numpy==1.26.4" "opencv-python-headless==4.10.0.84" "pillow==11.1.0"

"$ROOT/gaze/venv/bin/python" - <<'PY'
import tensorflow as tf, mediapipe
gpus = tf.config.list_physical_devices("GPU")
print("gaze:", "tensorflow", tf.__version__, "mediapipe", mediapipe.__version__, "gpus", len(gpus))
raise SystemExit(0 if gpus else 3)
PY
"$ROOT/depth/venv/bin/python" - <<'PY'
import torch
print("depth:", "torch", torch.__version__, "cuda", torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else None)
raise SystemExit(0 if torch.cuda.is_available() else 3)
PY
echo "setup complete: $ROOT"
