"""Private JSON-lines worker used by server/detect-provider.js: object boxes for one scene frame with RT-DETRv2
(PekingU/rtdetr_v2_r18vd, Apache-2.0, through Hugging Face transformers).

The detector is an auxiliary to SAM 3.1: it finds the boxes of everything in the frame in about half a second on CPU,
and Muse Spark names what is inside them. Requests: {"id", "frame": {frameId, observedAt, width, height}, "imageDataUrl"}.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import sys
import time

import cv2
import numpy as np

DATA_URL = re.compile(r"data:image/(png|jpeg);base64,([A-Za-z0-9+/]*={0,2})\Z")
MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 1024 * 1024
MAX_DETECTIONS = 30
# the checkpoint keeps PASCAL VOC spellings for a few COCO classes
READABLE = {"diningtable": "dining table", "pottedplant": "potted plant", "tvmonitor": "tv", "sofa": "couch", "motorbike": "motorcycle", "aeroplane": "airplane"}


class DetectFailure(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def send(value):
    sys.stdout.buffer.write((json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n").encode("ascii"))
    sys.stdout.buffer.flush()


def parse_request(value):
    if not isinstance(value, dict) or set(value) != {"id", "frame", "imageDataUrl"}:
        raise DetectFailure("DETECT_INVALID_REQUEST")
    request_id, frame = value["id"], value["frame"]
    if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
        raise DetectFailure("DETECT_INVALID_REQUEST")
    if not isinstance(frame, dict) or set(frame) != {"frameId", "observedAt", "width", "height"}:
        raise DetectFailure("DETECT_INVALID_FRAME")
    width, height = frame["width"], frame["height"]
    if not isinstance(frame["frameId"], str) or not frame["frameId"].strip() or len(frame["frameId"]) > 128:
        raise DetectFailure("DETECT_INVALID_FRAME")
    if isinstance(width, bool) or isinstance(height, bool) or not isinstance(width, int) or not isinstance(height, int) or width < 1 or height < 1 or width * height > MAX_PIXELS:
        raise DetectFailure("DETECT_INVALID_FRAME")
    match = DATA_URL.fullmatch(value["imageDataUrl"]) if isinstance(value["imageDataUrl"], str) else None
    if match is None:
        raise DetectFailure("DETECT_INVALID_IMAGE")
    try:
        image_bytes = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise DetectFailure("DETECT_INVALID_IMAGE") from exc
    image = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    if image is None or image.shape[1] != width or image.shape[0] != height:
        raise DetectFailure("DETECT_INVALID_IMAGE")
    return request_id, frame, cv2.cvtColor(image, cv2.COLOR_BGR2RGB)


def detect(model, processor, request, threshold):
    import torch
    request_id, frame, image = parse_request(request)
    started = time.perf_counter()
    with torch.no_grad():
        outputs = model(**processor(images=image, return_tensors="pt"))
    result = processor.post_process_object_detection(outputs, target_sizes=[image.shape[:2]], threshold=threshold)[0]
    inference_ms = round((time.perf_counter() - started) * 1000, 3)
    width, height = frame["width"], frame["height"]
    detections = []
    for box, label, score in zip(result["boxes"].tolist(), result["labels"].tolist(), result["scores"].tolist()):
        left, top = max(0, int(round(box[0]))), max(0, int(round(box[1])))
        right, bottom = min(width, int(round(box[2]))), min(height, int(round(box[3])))
        if right > left and bottom > top:
            name = model.config.id2label[int(label)]
            detections.append({"label": READABLE.get(name, name), "score": round(float(score), 4), "bounds": {"left": left, "top": top, "right": right, "bottom": bottom}})
    detections.sort(key=lambda item: -item["score"])
    return {"id": request_id, "status": "ok", "frame": frame, "detections": detections[:MAX_DETECTIONS], "timing": {"inferenceMs": inference_ms}}


def run_worker(model_id: str, threshold: float):
    try:
        import torch
        from transformers import RTDetrImageProcessor, RTDetrV2ForObjectDetection
        torch.set_num_threads(4)
        model = RTDetrV2ForObjectDetection.from_pretrained(model_id).eval()
        processor = RTDetrImageProcessor.from_pretrained(model_id)
        with torch.no_grad():  # warm-up: the first call is several times slower
            model(**processor(images=np.zeros((64, 64, 3), np.uint8), return_tensors="pt"))
    except Exception:
        send({"type": "ready", "status": "error", "error": "DETECT_RUNTIME_UNAVAILABLE"})
        return 2
    send({"type": "ready", "status": "ready", "model": {"id": model_id, "device": "cpu"}})
    while True:
        raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
        if not raw:
            return 0
        request_id = None
        try:
            request = json.loads(raw)
            if isinstance(request, dict) and isinstance(request.get("id"), str):
                request_id = request["id"][:128]
            send(detect(model, processor, request, threshold))
        except DetectFailure as exc:
            send({"id": request_id, "status": "error", "error": exc.code})
        except (UnicodeDecodeError, json.JSONDecodeError):
            send({"id": request_id, "status": "error", "error": "DETECT_INVALID_REQUEST"})
        except Exception:
            send({"id": request_id, "status": "error", "error": "DETECT_INFERENCE_FAILED"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="PekingU/rtdetr_v2_r18vd")
    parser.add_argument("--threshold", type=float, default=0.3)
    args = parser.parse_args()
    return run_worker(args.model, args.threshold)


if __name__ == "__main__":
    raise SystemExit(main())
