"""One-frame CLI; saves only the predicted metric depth and validity mask."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
from PIL import Image

from model import (
    MAX_IMAGE_BYTES, DepthFailure, decode_image, infer_bgr, load_model,
    model_metadata, summarize,
)


def main():
    parser = argparse.ArgumentParser(description="Depth Anything V2 Metric Hypersim Small local inference")
    parser.add_argument("--image", required=True, type=Path, help="local PNG or JPEG; never uploaded")
    parser.add_argument("--frame-id", required=True)
    parser.add_argument("--observed-at", required=True, type=float)
    parser.add_argument("--runtime-home", type=Path, default=Path(".asset-tmp/depth-runtime"))
    parser.add_argument("--output", required=True, type=Path, help="destination .npz for depth_m and valid_mask")
    args = parser.parse_args()
    if not args.frame_id.strip() or len(args.frame_id) > 128 or args.observed_at < 0:
        parser.error("frame ID and observed time are invalid")
    try:
        if not args.image.is_file() or args.image.stat().st_size < 1 or args.image.stat().st_size > MAX_IMAGE_BYTES:
            raise DepthFailure("DEPTH_INVALID_IMAGE")
        image_bytes = args.image.read_bytes()
        with Image.open(args.image) as image:
            width, height = image.size
        total_started = time.perf_counter()
        model, checkpoint_hash, model_load_ms = load_model(args.runtime_home)
        decode_started = time.perf_counter()
        bgr = decode_image(image_bytes, width, height)
        decode_ms = round((time.perf_counter() - decode_started) * 1000, 3)
        depth, valid, inference_ms = infer_bgr(model, bgr)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(args.output, depth_m=depth, valid_mask=valid)
        print(json.dumps({
            "status": "ok",
            "frame": {"frameId": args.frame_id, "observedAt": args.observed_at},
            "width": width,
            "height": height,
            "output": str(args.output.resolve()),
            "units": "m",
            "convention": "axial_z",
            "depthSource": "monocular_estimated_depth",
            "model": model_metadata(checkpoint_hash),
            "timing": {
                "modelLoadMs": model_load_ms,
                "decodeMs": decode_ms,
                "inferenceMs": inference_ms,
                "totalMs": round((time.perf_counter() - total_started) * 1000, 3),
            },
            "summary": summarize(depth, valid),
        }, separators=(",", ":"), allow_nan=False))
        return 0
    except DepthFailure as exc:
        print(json.dumps({"status": "error", "error": exc.code}, separators=(",", ":")))
        return 2
    except Exception:
        print(json.dumps({"status": "error", "error": "DEPTH_RUNTIME_UNAVAILABLE"}, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

