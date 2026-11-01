"""Private JSON-lines worker used by server/depth-provider.js."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import torch

from model import (
    MAX_IMAGE_BYTES, MAX_PIXELS, MAX_REQUEST_BYTES,
    DepthFailure, decode_image, infer_bgr, load_model,
    model_metadata, summarize,
)


DATA_URL = re.compile(r"data:image/(png|jpeg);base64,([A-Za-z0-9+/]*={0,2})\Z")


def send(value):
    sys.stdout.buffer.write((json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n").encode("ascii"))
    sys.stdout.buffer.flush()


def parse_request(value):
    if not isinstance(value, dict) or set(value) != {"id", "frame", "imageDataUrl"}:
        raise DepthFailure("DEPTH_INVALID_REQUEST")
    request_id = value["id"]
    frame = value["frame"]
    if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
        raise DepthFailure("DEPTH_INVALID_REQUEST")
    if not isinstance(frame, dict) or set(frame) != {"frameId", "observedAt", "width", "height"}:
        raise DepthFailure("DEPTH_INVALID_FRAME")
    frame_id = frame["frameId"]
    observed_at = frame["observedAt"]
    width, height = frame["width"], frame["height"]
    if not isinstance(frame_id, str) or not frame_id.strip() or len(frame_id) > 128 or isinstance(observed_at, bool) or not isinstance(observed_at, (int, float)) or observed_at < 0:
        raise DepthFailure("DEPTH_INVALID_FRAME")
    if isinstance(width, bool) or isinstance(height, bool) or not isinstance(width, int) or not isinstance(height, int) or width < 1 or height < 1 or width > 4096 or height > 4096 or width * height > MAX_PIXELS:
        raise DepthFailure("DEPTH_INVALID_FRAME")
    match = DATA_URL.fullmatch(value["imageDataUrl"]) if isinstance(value["imageDataUrl"], str) else None
    if match is None or len(match.group(2)) % 4:
        raise DepthFailure("DEPTH_INVALID_IMAGE")
    try:
        image_bytes = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise DepthFailure("DEPTH_INVALID_IMAGE") from exc
    if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES or base64.b64encode(image_bytes).decode("ascii") != match.group(2):
        raise DepthFailure("DEPTH_INVALID_IMAGE")
    if match.group(1) == "png" and not image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        raise DepthFailure("DEPTH_INVALID_IMAGE")
    if match.group(1) == "jpeg" and not image_bytes.startswith(b"\xff\xd8\xff"):
        raise DepthFailure("DEPTH_INVALID_IMAGE")
    return request_id, {"frameId": frame_id, "observedAt": float(observed_at), "width": width, "height": height}, image_bytes


def infer_request(model, checkpoint_hash, request, device="cpu"):
    request_id, frame, image_bytes = parse_request(request)
    total_started = time.perf_counter()
    decode_started = time.perf_counter()
    bgr = decode_image(image_bytes, frame["width"], frame["height"])
    decode_ms = round((time.perf_counter() - decode_started) * 1000, 3)
    depth, valid, inference_ms = infer_bgr(model, bgr, device=device)
    return {
        "id": request_id,
        "status": "ok",
        "frame": frame,
        "width": frame["width"],
        "height": frame["height"],
        "valuesF32LE": base64.b64encode(depth.tobytes(order="C")).decode("ascii"),
        "validMaskU8": base64.b64encode(valid.tobytes(order="C")).decode("ascii"),
        "units": "m",
        "convention": "axial_z",
        "depthSource": "monocular_estimated_depth",
        "model": model_metadata(checkpoint_hash, device),
        "timing": {
            "decodeMs": decode_ms,
            "inferenceMs": inference_ms,
            "totalMs": round((time.perf_counter() - total_started) * 1000, 3),
        },
        "summary": summarize(depth, valid),
    }


def run_worker(home: Path):
    try:
        model, checkpoint_hash, model_load_ms = load_model(home)
    except DepthFailure as exc:
        send({"type": "ready", "status": "error", "error": exc.code})
        return 2
    except Exception:
        send({"type": "ready", "status": "error", "error": "DEPTH_RUNTIME_UNAVAILABLE"})
        return 2
    send({
        "type": "ready",
        "status": "ready",
        "model": model_metadata(checkpoint_hash),
        "modelLoadMs": model_load_ms,
        "pythonVersion": sys.version.split()[0],
        "torchVersion": torch.__version__,
        "device": "cpu",
    })
    while True:
        raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
        if not raw:
            return 0
        if len(raw) > MAX_REQUEST_BYTES and not raw.endswith(b"\n"):
            while raw and not raw.endswith(b"\n"):
                raw = sys.stdin.buffer.readline(65536)
            send({"id": None, "status": "error", "error": "DEPTH_REQUEST_TOO_LARGE"})
            continue
        if len(raw) > MAX_REQUEST_BYTES:
            send({"id": None, "status": "error", "error": "DEPTH_REQUEST_TOO_LARGE"})
            continue
        request_id = None
        try:
            request = json.loads(raw)
            if isinstance(request, dict) and isinstance(request.get("id"), str):
                request_id = request["id"][:128]
            send(infer_request(model, checkpoint_hash, request))
        except DepthFailure as exc:
            send({"id": request_id, "status": "error", "error": exc.code})
        except (UnicodeDecodeError, json.JSONDecodeError):
            send({"id": request_id, "status": "error", "error": "DEPTH_INVALID_REQUEST"})
        except Exception:
            send({"id": request_id, "status": "error", "error": "DEPTH_INFERENCE_FAILED"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True, type=Path)
    args = parser.parse_args()
    return run_worker(args.home)


if __name__ == "__main__":
    raise SystemExit(main())

