"""Pinned local inference for Depth Anything V2 Metric Hypersim Small."""

from __future__ import annotations

import hashlib
import io
import os
import time
import warnings
import contextlib
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, UnidentifiedImageError

MODEL_ID = "depth-anything/Depth-Anything-V2-Metric-Hypersim-Small"
MODEL_FILE = "depth_anything_v2_metric_hypersim_vits.pth"
MODEL_SHA256 = "b782898d8a3e8be1f639de33837ed85e9b4b73e40f8f5e5cd99067588d722545"
MODEL_LICENSE = "Apache-2.0"
SOURCE_URL = "https://github.com/DepthAnything/Depth-Anything-V2"
SOURCE_COMMIT = "a561b849ebae10a6f5ef49e26c83cbbcd36c71bf"
MAX_DEPTH_M = 20.0
INPUT_SIZE = 518
MAX_PIXELS = 1024 * 1024
MAX_DIMENSION = 4096
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_REQUEST_BYTES = 8 * 1024 * 1024


class DepthFailure(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def checkpoint_path(home: Path) -> Path:
    return home / "checkpoints" / MODEL_FILE


def verify_checkpoint(home: Path) -> str:
    path = checkpoint_path(home)
    if not path.is_file():
        raise DepthFailure("DEPTH_MODEL_MISSING")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    actual = digest.hexdigest()
    if actual != MODEL_SHA256:
        raise DepthFailure("DEPTH_MODEL_HASH_MISMATCH")
    return actual


def load_model(home: Path, device: str = "cpu"):
    started = time.perf_counter()
    source = home / "source" / "metric_depth"
    if not (source / "depth_anything_v2" / "dpt.py").is_file():
        raise DepthFailure("DEPTH_SOURCE_MISSING")
    sys_path = str(source.resolve())
    import sys
    if sys_path not in sys.path:
        sys.path.insert(0, sys_path)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            from depth_anything_v2.dpt import DepthAnythingV2
    except Exception as exc:
        raise DepthFailure("DEPTH_RUNTIME_UNAVAILABLE") from exc

    checkpoint_hash = verify_checkpoint(home)
    if device not in ("cpu", "cuda") or (device == "cuda" and not torch.cuda.is_available()):
        raise DepthFailure("DEPTH_RUNTIME_UNAVAILABLE")
    torch.set_num_threads(max(1, min(8, os.cpu_count() or 1)))
    try:
        with contextlib.redirect_stdout(sys.stderr):
            model = DepthAnythingV2(encoder="vits", features=64, out_channels=[48, 96, 192, 384], max_depth=MAX_DEPTH_M)
            state = torch.load(checkpoint_path(home), map_location="cpu", weights_only=True)
            model.load_state_dict(state, strict=True)
    except Exception as exc:
        raise DepthFailure("DEPTH_MODEL_INVALID") from exc
    model.eval().to(device)
    return model, checkpoint_hash, round((time.perf_counter() - started) * 1000, 3)


def decode_image(image_bytes: bytes, width: int, height: int):
    if not isinstance(image_bytes, bytes) or not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
        raise DepthFailure("DEPTH_INVALID_IMAGE")
    if not (isinstance(width, int) and isinstance(height, int) and 1 <= width <= MAX_DIMENSION and 1 <= height <= MAX_DIMENSION and width * height <= MAX_PIXELS):
        raise DepthFailure("DEPTH_INVALID_FRAME")
    try:
        Image.MAX_IMAGE_PIXELS = MAX_PIXELS
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(image_bytes))
            if image.format not in ("PNG", "JPEG") or image.size != (width, height):
                raise DepthFailure("DEPTH_FRAME_MISMATCH")
            image.load()
            rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    except DepthFailure:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise DepthFailure("DEPTH_INVALID_IMAGE") from exc
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def infer_bgr(model, bgr: np.ndarray, input_size: int = INPUT_SIZE, device: str = "cpu"):
    """Run the upstream infer_image preprocessing/head on the given device and return metric axial Z."""
    started = time.perf_counter()
    try:
        image, (height, width) = model.image2tensor(bgr, input_size)
        # DepthAnythingV2.image2tensor selects CUDA/MPS when installed. Use the
        # explicitly requested device so provenance always names where it ran.
        image = image.to(device)
        with torch.inference_mode():
            depth = model.forward(image)
            depth = F.interpolate(depth[:, None], (height, width), mode="bilinear", align_corners=True)[0, 0]
        depth = depth.detach().to("cpu", dtype=torch.float32).numpy()
    except Exception as exc:
        raise DepthFailure("DEPTH_INFERENCE_FAILED") from exc
    if depth.shape != (height, width):
        raise DepthFailure("DEPTH_INVALID_OUTPUT")
    valid = np.isfinite(depth) & (depth > 0.0) & (depth <= MAX_DEPTH_M)
    if not valid.any():
        raise DepthFailure("DEPTH_INVALID_OUTPUT")
    depth = np.where(valid, depth, 0.0).astype("<f4", copy=False)
    return depth, valid.astype(np.uint8), round((time.perf_counter() - started) * 1000, 3)


def summarize(depth: np.ndarray, valid: np.ndarray):
    samples = depth[valid.astype(bool)]
    return {
        "validCount": int(samples.size),
        "invalidCount": int(valid.size - samples.size),
        "minM": round(float(samples.min()), 6),
        "medianM": round(float(np.median(samples)), 6),
        "maxM": round(float(samples.max()), 6),
    }


def model_metadata(checkpoint_hash: str, device: str = "cpu"):
    return {
        "id": MODEL_ID,
        "sha256": checkpoint_hash,
        "license": MODEL_LICENSE,
        "sourceUrl": SOURCE_URL,
        "sourceCommit": SOURCE_COMMIT,
        "encoder": "vits",
        "dataset": "hypersim",
        "maxDepthM": MAX_DEPTH_M,
        "units": "m",
        "convention": "axial_z",
        "device": device,
    }

