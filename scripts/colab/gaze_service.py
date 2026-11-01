"""Ephemeral GPU WebEyeTrack service for a Colab runtime.

Run with `colab exec -f scripts/colab/gaze_service.py --timeout 900`. The service
binds to loopback only; the local application reaches it through the SSH tunnel.
Camera frames, eye patches, and calibration examples are kept in RAM only.
"""

import contextlib
import gc
import io
import re
import base64
import hashlib
import json
import math
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit


HOME = Path("/content/prometheus-gaze")
APP = HOME / "app"
SOURCE = HOME / "source"
ARCHIVE = HOME / "upstream.zip"
PORT = 8766
SOURCE_COMMIT = "75fbd2f5f784f2eb3a39675a8dcbf1b01c697f1c"
SOURCE_ZIP = f"https://github.com/RedForestAI/WebEyeTrack/archive/{SOURCE_COMMIT}.zip"
MEDIAPIPE_VERSION = "0.10.32"
MAX_SESSIONS = 2
SESSION_TTL_SECONDS = 600
FRAME_CACHE_SIZE = 32
CALIBRATION_POINTS = 27
MAX_FRAME_BYTES = 6 * 1024 * 1024
MAX_FRAME_PIXELS = 2_764_800  # 1920 x 1440
MAX_JSON_BYTES = 16 * 1024
MAX_TARGET_FRAMES = 8
MIN_USABLE_FRAMES = 3
MAX_TARGET_JSON_BYTES = 2 * 1024 * 1024
MAX_ADAPTER_JSON_BYTES = 64 * 1024
MODEL_ID = "webeyetrack-blazegaze-mpiifacegaze"
ADAPTER_ID = "webeyetrack-gaze-mlp-f32-v1"
ADAPTER_WEIGHT_SHAPES = ((518, 16), (16,), (16, 16), (16,), (16, 2), (2,))

TRACKER_FACTORY = None
TF = None
NP = None
CV2 = None
HEALTH = None
MODEL_SHA256 = None
SESSIONS = {}
SESSION_LOCK = threading.RLock()
COMPUTE_LOCK = threading.Lock()


def encode_json(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False).encode("utf-8")


def read_json_body(raw):
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ServiceError(400, "GAZE_INVALID_REQUEST")
    if not isinstance(value, dict):
        raise ServiceError(400, "GAZE_INVALID_REQUEST")
    return value


def valid_frame_id(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value < 2**53


def valid_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def calibration_target(value):
    if not isinstance(value, list) or len(value) != 2 or not all(valid_number(item) for item in value):
        raise ServiceError(400, "GAZE_INVALID_TARGET")
    if any(item < -0.5 or item > 0.5 for item in value):
        raise ServiceError(400, "GAZE_INVALID_TARGET")
    return [float(value[0]), float(value[1])]


def screen_dimensions(body):
    px = body.get("screenPxDimensions", [1920, 1080])
    cm = body.get("screenCmDimensions", [53.1, 29.8])
    px = [1920, 1080] if px is None else px
    cm = [53.1, 29.8] if cm is None else cm
    if not isinstance(px, list) or len(px) != 2 or any(not isinstance(v, int) or isinstance(v, bool) or v < 1 or v > 20000 for v in px):
        raise ServiceError(400, "GAZE_INVALID_SCREEN")
    if not isinstance(cm, list) or len(cm) != 2 or any(not valid_number(v) or v <= 0 or v > 200 for v in cm):
        raise ServiceError(400, "GAZE_INVALID_SCREEN")
    return tuple(px), tuple(float(v) for v in cm)


def decode_adapter(adapter):
    if adapter is None:
        return None
    if not isinstance(adapter, dict) or set(adapter) != {"schemaVersion", "adapterId", "modelId", "sourceCommit", "modelSha256", "weights"}:
        raise ServiceError(400, "GAZE_INVALID_ADAPTER")
    if adapter.get("schemaVersion") != 1 or adapter.get("adapterId") != ADAPTER_ID:
        raise ServiceError(409, "GAZE_ADAPTER_VERSION_MISMATCH")
    if adapter.get("modelId") != MODEL_ID or adapter.get("sourceCommit") != SOURCE_COMMIT or adapter.get("modelSha256") != MODEL_SHA256:
        raise ServiceError(409, "GAZE_ADAPTER_MODEL_MISMATCH")
    entries = adapter.get("weights")
    if not isinstance(entries, list) or len(entries) != len(ADAPTER_WEIGHT_SHAPES):
        raise ServiceError(400, "GAZE_INVALID_ADAPTER")
    decoded = []
    for entry, expected_shape in zip(entries, ADAPTER_WEIGHT_SHAPES):
        if not isinstance(entry, dict) or set(entry) != {"shape", "dtype", "data"}:
            raise ServiceError(400, "GAZE_INVALID_ADAPTER")
        if entry["shape"] != list(expected_shape) or entry["dtype"] != "float32-le" or not isinstance(entry["data"], str):
            raise ServiceError(400, "GAZE_INVALID_ADAPTER")
        try:
            raw = base64.b64decode(entry["data"], validate=True)
        except (ValueError, base64.binascii.Error):
            raise ServiceError(400, "GAZE_INVALID_ADAPTER")
        if len(raw) != math.prod(expected_shape) * 4:
            raise ServiceError(400, "GAZE_INVALID_ADAPTER")
        values = NP.frombuffer(raw, dtype="<f4")
        if not NP.isfinite(values).all():
            raise ServiceError(400, "GAZE_INVALID_ADAPTER")
        decoded.append(values.reshape(expected_shape).copy())
    return decoded


def export_adapter(tracker):
    weights = tracker.blazegaze.gaze_mlp.get_weights()
    if len(weights) != len(ADAPTER_WEIGHT_SHAPES):
        raise ServiceError(503, "GAZE_ADAPTER_SHAPE_MISMATCH")
    entries = []
    for value, expected_shape in zip(weights, ADAPTER_WEIGHT_SHAPES):
        array = NP.asarray(value, dtype="<f4")
        if tuple(array.shape) != expected_shape or not NP.isfinite(array).all():
            raise ServiceError(503, "GAZE_ADAPTER_SHAPE_MISMATCH")
        entries.append({
            "shape": list(expected_shape),
            "dtype": "float32-le",
            "data": base64.b64encode(array.tobytes(order="C")).decode("ascii"),
        })
    return {
        "schemaVersion": 1,
        "adapterId": ADAPTER_ID,
        "modelId": MODEL_ID,
        "sourceCommit": SOURCE_COMMIT,
        "modelSha256": MODEL_SHA256,
        "weights": entries,
    }


def apply_adapter(tracker, adapter_weights):
    if adapter_weights is None:
        return False
    model = tracker.blazegaze.gaze_mlp
    expected = model.get_weights()
    if len(expected) != len(adapter_weights) or any(tuple(left.shape) != tuple(right.shape) for left, right in zip(expected, adapter_weights)):
        raise ServiceError(409, "GAZE_ADAPTER_SHAPE_MISMATCH")
    model.set_weights(adapter_weights)
    return True


class ServiceError(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status = status
        self.code = code


class TrackerState:
    def __init__(self, tracker):
        self.tracker = tracker
        self.frames = OrderedDict()
        self.calibration = []
        self.calibration_by_index = {}
        self.batch = {}
        self.batch_results = {}
        self.calibrated = False
        self.failed = False


class GazeSession:
    def __init__(self, session_id, screen_px, screen_cm, tracker):
        now = time.monotonic()
        self.session_id = session_id
        self.screen_px = screen_px
        self.screen_cm = screen_cm
        self.active = TrackerState(tracker)
        self.candidate = None
        self.last_frame_id = 0
        self.created_at = now
        self.last_activity = now


def _clear_tracker_state(state):
    if state is None:
        return
    state.frames.clear()
    state.calibration.clear()
    state.calibration_by_index.clear()
    state.batch.clear()
    state.batch_results.clear()
    tracker = state.tracker
    state.tracker = None
    if tracker is None:
        return
    try:
        tracker.face_landmarker.close()
    except Exception:
        pass
    try:
        for values in tracker.calib_data.values():
            values.clear()
    except Exception:
        pass


def _dispose_session(session):
    _clear_tracker_state(session.active)
    _clear_tracker_state(session.candidate)
    session.active = None
    session.candidate = None


def _expire_sessions(now=None):
    now = time.monotonic() if now is None else now
    expired = []
    with SESSION_LOCK:
        for session_id, session in tuple(SESSIONS.items()):
            if now - session.last_activity > SESSION_TTL_SECONDS:
                del SESSIONS[session_id]
                expired.append(session)
    for session in expired:
        _dispose_session(session)
    if expired and not SESSIONS and TF is not None:
        gc.collect()
        try:
            TF.keras.backend.clear_session()
        except Exception:
            pass
    return len(expired)


def _new_tracker(screen_px, screen_cm):
    if TRACKER_FACTORY is None:
        raise ServiceError(503, "GAZE_NOT_READY")
    try:
        return TRACKER_FACTORY(screen_px, screen_cm)
    except Exception:
        raise ServiceError(503, "GAZE_MODEL_UNAVAILABLE")


def create_session(body):
    if set(body) - {"screenPxDimensions", "screenCmDimensions", "adapter"}:
        raise ServiceError(400, "GAZE_INVALID_REQUEST")
    screen_px, screen_cm = screen_dimensions(body)
    adapter_weights = decode_adapter(body.get("adapter"))
    _expire_sessions()
    with SESSION_LOCK:
        if len(SESSIONS) >= MAX_SESSIONS:
            raise ServiceError(429, "GAZE_SESSION_LIMIT")
    tracker = _new_tracker(screen_px, screen_cm)
    try:
        calibrated = apply_adapter(tracker, adapter_weights)
    except Exception:
        _clear_tracker_state(TrackerState(tracker))
        raise
    session_id = secrets.token_urlsafe(24)
    session = GazeSession(session_id, screen_px, screen_cm, tracker)
    session.active.calibrated = calibrated
    with SESSION_LOCK:
        if len(SESSIONS) >= MAX_SESSIONS:
            _dispose_session(session)
            raise ServiceError(429, "GAZE_SESSION_LIMIT")
        SESSIONS[session_id] = session
    return {"status": "ready", "sessionId": session_id, "expiresInSeconds": SESSION_TTL_SECONDS, "calibrated": calibrated}


def get_session(session_id):
    _expire_sessions()
    with SESSION_LOCK:
        session = SESSIONS.get(session_id)
        if session is None:
            raise ServiceError(404, "GAZE_SESSION_NOT_FOUND")
        session.last_activity = time.monotonic()
        return session


def delete_session(session_id):
    with SESSION_LOCK:
        session = SESSIONS.pop(session_id, None)
    if session is None:
        raise ServiceError(404, "GAZE_SESSION_NOT_FOUND")
    _dispose_session(session)
    if not SESSIONS and TF is not None:
        gc.collect()
        try:
            TF.keras.backend.clear_session()
        except Exception:
            pass


EYE_PATCH_ERROR_MARKER = "Error in obtaining eye patch:"


def _safe_failure_text(text):
    """First line of an upstream error message reduced to a short, harmless token string."""
    line = (text or "").strip().splitlines()[0] if (text or "").strip() else ""
    cleaned = re.sub(r"[^A-Za-z0-9 _.,:()\[\]/=-]", "?", line)[:160].strip()
    return cleaned or None


def _tracking_failure(captured_output):
    """Why upstream reported no face: no landmarks at all, or landmarks found but the eye patch could not be built."""
    if EYE_PATCH_ERROR_MARKER in captured_output:
        return {"stage": "eye_patch", "message": _safe_failure_text(captured_output.split(EYE_PATCH_ERROR_MARKER, 1)[1])}
    return {"stage": "landmarks", "message": None}


def _eye_aspect_ratios(state, result, width, height):
    """EAR per eye exactly as upstream computes it for the open/closed decision, or None when unavailable."""
    try:
        from webeyetrack.model_based import compute_ear
        landmarks = NP.asarray(result.facial_landmarks, dtype=NP.float64)[:, :2] * NP.array([width, height], dtype=NP.float64)
        left = float(compute_ear(facial_landmarks=landmarks, side="left"))
        right = float(compute_ear(facial_landmarks=landmarks, side="right"))
        threshold = float(getattr(getattr(state.tracker, "config", None), "ear_threshold", 0.2))
        if all(math.isfinite(value) for value in (left, right, threshold)):
            return {"left": round(left, 4), "right": round(right, 4), "threshold": round(threshold, 4)}
    except Exception:
        pass
    return None


def _frame_result(state, session, frame_id, capture_timestamp_ms, jpeg):
    encoded = NP.frombuffer(jpeg, dtype=NP.uint8)
    frame = CV2.imdecode(encoded, CV2.IMREAD_COLOR)
    if frame is None or frame.ndim != 3 or frame.shape[2] != 3:
        raise ServiceError(400, "GAZE_INVALID_FRAME")
    height, width = frame.shape[:2]
    if width < 64 or height < 64 or width * height > MAX_FRAME_PIXELS:
        raise ServiceError(413, "GAZE_FRAME_DIMENSIONS")
    started = time.perf_counter()
    captured = io.StringIO()
    try:
        # Upstream reports an eye-patch failure only by printing it; capture that (inference holds COMPUTE_LOCK, so one thread).
        with TF.device("/GPU:0"), contextlib.redirect_stdout(captured):
            status, result, _ = state.tracker.process_frame(frame)
    except Exception:
        raise ServiceError(503, "GAZE_INFERENCE_FAILED")
    total_ms = (time.perf_counter() - started) * 1000
    face_detected = result is not None and getattr(status, "value", status) == 1
    gaze_state = getattr(result, "gaze_state", "unknown") if face_detected else "unknown"
    raw_norm = getattr(result, "norm_pog", None) if face_detected else None
    norm = None
    try:
        values = NP.asarray(raw_norm, dtype=NP.float64).reshape(-1)
        if values.size == 2 and NP.isfinite(values).all():
            norm = [float(values[0]), float(values[1])]
    except Exception:
        pass
    durations = {}
    for source, target in (
        ("landmark_detection", "faceLandmarker"),
        ("prepare_input", "prepareInput"),
        ("infer_pog", "blazeGaze"),
        ("affine_&_kalman", "filter"),
    ):
        try:
            value = float(result.durations[source]) * 1000 if face_detected else 0.0
            if math.isfinite(value) and value >= 0:
                durations[target] = value
        except Exception:
            pass
    durations["workerTotalMs"] = total_ms
    if face_detected and gaze_state == "open" and norm is not None and state is session.candidate:
        try:
            features = {
                "eyePatch": NP.array(result.eye_patch, copy=True),
                "headVector": NP.array(result.head_vector, dtype=NP.float32, copy=True),
                "faceOrigin3D": NP.array(result.face_origin_3d, dtype=NP.float32, copy=True),
            }
            state.frames[frame_id] = {"gazeState": gaze_state, **features}
            while len(state.frames) > FRAME_CACHE_SIZE:
                state.frames.popitem(last=False)
        except Exception:
            pass
    return {
        "status": "ok",
        "frameId": frame_id,
        "captureTimestampMs": capture_timestamp_ms,
        "width": width,
        "height": height,
        "faceDetected": bool(face_detected),
        "gazeState": gaze_state,
        "normPog": norm,
        "eyeAspectRatio": _eye_aspect_ratios(state, result, width, height) if face_detected else None,
        "trackingFailure": None if face_detected else _tracking_failure(captured.getvalue()),
        "durations": durations,
    }


def infer_frame(session, frame_id, capture_timestamp_ms, jpeg):
    if not valid_frame_id(frame_id) or not valid_number(capture_timestamp_ms) or capture_timestamp_ms < 0:
        raise ServiceError(400, "GAZE_INVALID_FRAME_METADATA")
    if frame_id <= session.last_frame_id:
        raise ServiceError(409, "GAZE_FRAME_OUT_OF_ORDER")
    state = session.candidate if session.candidate is not None else session.active
    if state is None or state.tracker is None or state.failed:
        raise ServiceError(409, "GAZE_TRACKER_UNAVAILABLE")
    response = _frame_result(state, session, frame_id, float(capture_timestamp_ms), jpeg)
    session.last_frame_id = frame_id
    return response


def start_candidate(session):
    if session.candidate is not None:
        raise ServiceError(409, "GAZE_CANDIDATE_EXISTS")
    session.candidate = TrackerState(_new_tracker(session.screen_px, session.screen_cm))
    return {"status": "started", "points": 0, "requiredPoints": CALIBRATION_POINTS}


def add_calibration_sample(session, body):
    candidate = session.candidate
    if candidate is None or candidate.failed:
        raise ServiceError(409, "GAZE_CANDIDATE_UNAVAILABLE")
    index = body.get("pointIndex")
    frame_id = body.get("frameId")
    target = calibration_target(body.get("target"))
    if not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= CALIBRATION_POINTS:
        raise ServiceError(400, "GAZE_INVALID_CALIBRATION_INDEX")
    prior = candidate.calibration_by_index.get(index)
    if prior is not None:
        if prior["frameId"] == frame_id and prior["target"] == target:
            return {"status": "adapted" if candidate.calibrated else "collecting", "points": len(candidate.calibration), "requiredPoints": CALIBRATION_POINTS}
        raise ServiceError(409, "GAZE_CALIBRATION_INDEX_REUSED")
    if index != len(candidate.calibration):
        raise ServiceError(409, "GAZE_CALIBRATION_ORDER")
    if not valid_frame_id(frame_id):
        raise ServiceError(400, "GAZE_INVALID_FRAME_METADATA")
    sample = candidate.frames.pop(frame_id, None)
    if sample is None or sample.get("gazeState") != "open":
        raise ServiceError(422, "GAZE_CALIBRATION_FRAME_UNAVAILABLE")
    sample.update({"frameId": frame_id, "target": target})
    candidate.calibration.append(sample)
    candidate.calibration_by_index[index] = {"frameId": frame_id, "target": target}
    if len(candidate.calibration) < CALIBRATION_POINTS:
        return {"status": "collecting", "points": len(candidate.calibration), "requiredPoints": CALIBRATION_POINTS}
    return _adapt_candidate(candidate)


def _adapt_candidate(candidate):
    try:
        with TF.device("/GPU:0"):
            candidate.tracker.adapt(
                [sample["eyePatch"] for sample in candidate.calibration],
                [sample["headVector"] for sample in candidate.calibration],
                [sample["faceOrigin3D"] for sample in candidate.calibration],
                [sample["target"] for sample in candidate.calibration],
                steps_inner=5,
                inner_lr=1e-5,
                affine_transform=False,
                pt_type="calib",
            )
    except Exception:
        candidate.failed = True
        candidate.frames.clear()
        candidate.calibration.clear()
        candidate.calibration_by_index.clear()
        raise ServiceError(503, "GAZE_ADAPTATION_FAILED")
    candidate.calibrated = True
    candidate.frames.clear()
    candidate.calibration.clear()
    try:
        for values in candidate.tracker.calib_data.values():
            values.clear()
    except Exception:
        pass
    return {"status": "adapted", "points": CALIBRATION_POINTS, "requiredPoints": CALIBRATION_POINTS}


def _decode_jpeg_base64(value):
    if not isinstance(value, str) or not value or len(value) > (MAX_FRAME_BYTES * 4) // 3 + 8:
        raise ServiceError(400, "GAZE_INVALID_FRAME")
    try:
        raw = base64.b64decode(value, validate=True)
    except Exception:
        raise ServiceError(400, "GAZE_INVALID_FRAME")
    if len(raw) < 4 or len(raw) > MAX_FRAME_BYTES or raw[:3] != b"\xff\xd8\xff":
        raise ServiceError(400, "GAZE_INVALID_FRAME")
    return raw


def _median(values):
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def process_calibration_target(session, body):
    """Analyse a short burst of frames for one calibration target (train or validate) while no live stream runs.

    Training stores the most representative open-eye frame's features for the final adaptation; validation only
    measures the adapted candidate. Re-sending the same frame IDs returns the stored answer, so retries are safe.
    """
    candidate = session.candidate
    if candidate is None or candidate.failed:
        raise ServiceError(409, "GAZE_CANDIDATE_UNAVAILABLE")
    if set(body) - {"phase", "pointIndex", "target", "frames"}:
        raise ServiceError(400, "GAZE_INVALID_REQUEST")
    phase = body.get("phase")
    if phase not in ("train", "validate"):
        raise ServiceError(400, "GAZE_INVALID_REQUEST")
    index = body.get("pointIndex")
    if not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= CALIBRATION_POINTS:
        raise ServiceError(400, "GAZE_INVALID_CALIBRATION_INDEX")
    target = calibration_target(body.get("target"))
    frames = body.get("frames")
    if not isinstance(frames, list) or not 1 <= len(frames) <= MAX_TARGET_FRAMES:
        raise ServiceError(400, "GAZE_INVALID_REQUEST")
    if phase == "train" and candidate.calibrated:
        raise ServiceError(409, "GAZE_CANDIDATE_ALREADY_ADAPTED")
    if phase == "validate" and not candidate.calibrated:
        raise ServiceError(409, "GAZE_CANDIDATE_NOT_ADAPTED")
    ids = []
    decoded = []
    for item in frames:
        if not isinstance(item, dict) or set(item) != {"frameId", "captureTimestampMs", "jpeg"} or not valid_frame_id(item["frameId"]):
            raise ServiceError(400, "GAZE_INVALID_FRAME_METADATA")
        ids.append(item["frameId"])
        decoded.append(_decode_jpeg_base64(item["jpeg"]))
    previous = candidate.batch_results.get((phase, index))
    if previous is not None and previous["ids"] == ids and previous["target"] == target:
        return previous["response"]

    results = []
    frame_errors = []
    for item, jpeg in zip(frames, decoded):
        try:
            results.append(infer_frame(session, item["frameId"], item["captureTimestampMs"], jpeg))
        except ServiceError as error:
            frame_errors.append(error.code)
    usable = [r for r in results if r["faceDetected"] and r["gazeState"] == "open" and r["normPog"] is not None]
    faces = [r for r in results if r["faceDetected"]]
    closed = [r for r in faces if r["gazeState"] == "closed"]
    ears = [r["eyeAspectRatio"] for r in results if r.get("eyeAspectRatio")]
    summary = {
        "pointIndex": index,
        "phase": phase,
        "totalFrames": len(frames),
        "faceFrames": len(faces),
        "closedFrames": len(closed),
        "usableFrames": len(usable),
        "frameErrors": len(frame_errors),
        "eyePatchFailures": len([r for r in results if (r.get("trackingFailure") or {}).get("stage") == "eye_patch"]),
        "failureMessage": next((r["trackingFailure"]["message"] for r in results if (r.get("trackingFailure") or {}).get("stage") == "eye_patch" and r["trackingFailure"]["message"]), None),
        "eyeAspectRatio": {"min": min(min(e["left"], e["right"]) for e in ears), "threshold": ears[0]["threshold"]} if ears else None,
    }
    needed = max(1, min(MIN_USABLE_FRAMES, len(frames)))
    if len(usable) < needed or len(usable) * 2 < len(frames):
        for frame_id in ids:
            candidate.frames.pop(frame_id, None)
        summary["status"] = "insufficient"
    else:
        center = [_median([r["normPog"][0] for r in usable]), _median([r["normPog"][1] for r in usable])]
        if phase == "train":
            best = min(usable, key=lambda r: (r["normPog"][0] - center[0]) ** 2 + (r["normPog"][1] - center[1]) ** 2)
            sample = candidate.frames.pop(best["frameId"], None)
            for frame_id in ids:
                candidate.frames.pop(frame_id, None)
            if sample is None or sample.get("gazeState") != "open":
                raise ServiceError(422, "GAZE_CALIBRATION_FRAME_UNAVAILABLE")
            sample.update({"frameId": best["frameId"], "target": target})
            candidate.batch[index] = sample
            summary["status"] = "accepted"
            summary["collected"] = len(candidate.batch)
            summary["requiredPoints"] = CALIBRATION_POINTS
        else:
            for frame_id in ids:
                candidate.frames.pop(frame_id, None)
            summary["status"] = "measured"
            summary["normPog"] = center
    candidate.batch_results[(phase, index)] = {"ids": ids, "target": target, "response": summary}
    return summary


def finalize_candidate(session):
    candidate = session.candidate
    if candidate is None or candidate.failed:
        raise ServiceError(409, "GAZE_CANDIDATE_UNAVAILABLE")
    if candidate.calibrated:
        return {"status": "adapted", "points": CALIBRATION_POINTS, "requiredPoints": CALIBRATION_POINTS}
    if len(candidate.batch) != CALIBRATION_POINTS:
        raise ServiceError(409, "GAZE_CALIBRATION_INCOMPLETE")
    candidate.calibration = [candidate.batch[i] for i in range(CALIBRATION_POINTS)]
    candidate.calibration_by_index = {i: {"frameId": candidate.batch[i]["frameId"], "target": candidate.batch[i]["target"]} for i in range(CALIBRATION_POINTS)}
    result = _adapt_candidate(candidate)
    candidate.batch.clear()
    for key in [key for key in candidate.batch_results if key[0] == "train"]:
        del candidate.batch_results[key]
    return result


def accept_candidate(session):
    candidate = session.candidate
    if candidate is None or candidate.failed or not candidate.calibrated:
        raise ServiceError(409, "GAZE_CANDIDATE_NOT_ADAPTED")
    adapter = export_adapter(candidate.tracker)
    previous = session.active
    session.active = candidate
    session.candidate = None
    _clear_tracker_state(previous)
    return {"status": "accepted", "calibrated": True, "adapter": adapter}


def discard_candidate(session):
    if session.candidate is None:
        raise ServiceError(409, "GAZE_CANDIDATE_UNAVAILABLE")
    candidate = session.candidate
    session.candidate = None
    _clear_tracker_state(candidate)
    return {"status": "discarded"}


def run_synthetic_self_test():
    """Exercise model adaptation and adapter restore with synthetic tensors only."""
    if not COMPUTE_LOCK.acquire(blocking=False):
        raise ServiceError(429, "GAZE_PROVIDER_BUSY")
    baseline = None
    restored = None
    try:
        if SESSIONS:
            raise ServiceError(409, "GAZE_SELF_TEST_REQUIRES_NO_SESSIONS")
        baseline = _new_tracker((1920, 1080), (53.1, 29.8))
        patch = NP.full((128, 512, 3), 112, dtype=NP.uint8)
        patch[48:80, 40:472] = (178, 142, 112)
        patch[56:72, 190:222] = (62, 94, 138)
        grid = [(-0.4, -0.4), (0.0, -0.4), (0.4, -0.4), (-0.4, 0.0), (0.0, 0.0), (0.4, 0.0), (-0.4, 0.4), (0.0, 0.4), (0.4, 0.4)]
        patches = []
        heads = []
        origins = []
        targets = []
        for index in range(CALIBRATION_POINTS):
            sample = patch.copy()
            sample[:, :, 0] = NP.clip(sample[:, :, 0].astype(NP.int16) + index % 5, 0, 255).astype(NP.uint8)
            patches.append(sample)
            gx, gy = grid[index % len(grid)]
            heads.append(NP.asarray([gx * 0.1, gy * 0.1, 1.0], dtype=NP.float32))
            origins.append(NP.asarray([gx * 0.5, gy * 0.5, 35.0], dtype=NP.float32))
            targets.append([gx, gy])
        with TF.device("/GPU:0"):
            baseline.adapt(patches, heads, origins, targets, steps_inner=5, inner_lr=1e-5, affine_transform=False, pt_type="calib")
            probe = baseline.infer_fn(
                image=TF.convert_to_tensor(NP.expand_dims(patches[0] / 255.0, axis=0), dtype=TF.float32),
                head_vector=TF.convert_to_tensor(NP.expand_dims(heads[0], axis=0), dtype=TF.float32),
                face_origin_3d=TF.convert_to_tensor(NP.expand_dims(origins[0], axis=0), dtype=TF.float32),
            )
        before = NP.asarray(probe.numpy(), dtype=NP.float32)
        if before.shape != (1, 2) or not NP.isfinite(before).all() or "GPU:0" not in probe.device.upper():
            raise ServiceError(503, "GAZE_SELF_TEST_GPU_INFERENCE_FAILED")
        adapter = export_adapter(baseline)
        restored = _new_tracker((1920, 1080), (53.1, 29.8))
        if not apply_adapter(restored, decode_adapter(adapter)):
            raise ServiceError(503, "GAZE_SELF_TEST_ADAPTER_RESTORE_FAILED")
        with TF.device("/GPU:0"):
            prediction = restored.infer_fn(
                image=TF.convert_to_tensor(NP.expand_dims(patches[0] / 255.0, axis=0), dtype=TF.float32),
                head_vector=TF.convert_to_tensor(NP.expand_dims(heads[0], axis=0), dtype=TF.float32),
                face_origin_3d=TF.convert_to_tensor(NP.expand_dims(origins[0], axis=0), dtype=TF.float32),
            )
        after = NP.asarray(prediction.numpy(), dtype=NP.float32)
        if prediction.device != probe.device or not NP.allclose(before, after, rtol=0, atol=1e-6):
            raise ServiceError(503, "GAZE_SELF_TEST_ROUND_TRIP_FAILED")
        _, face_result, _ = baseline.process_frame(NP.zeros((360, 640, 3), dtype=NP.uint8))
        if face_result is not None:
            raise ServiceError(503, "GAZE_SELF_TEST_NO_FACE_FAILED")
        return {"status": "passed", "device": "cuda", "syntheticCalibrationPoints": CALIBRATION_POINTS, "adapterRoundTripMaxDelta": float(NP.max(NP.abs(before - after))), "blankFrameFaceDetected": False}
    finally:
        _clear_tracker_state(TrackerState(baseline))
        _clear_tracker_state(TrackerState(restored))
        gc.collect()
        if not SESSIONS and TF is not None:
            try:
                TF.keras.backend.clear_session()
            except Exception:
                pass
        COMPUTE_LOCK.release()


def _content_length(handler, maximum, allow_empty=False):
    if handler.headers.get("Transfer-Encoding"):
        raise ServiceError(400, "GAZE_INVALID_REQUEST")
    headers = handler.headers.get_all("Content-Length", [])
    value = headers[0].strip() if len(headers) == 1 else ""
    if allow_empty and not headers:
        return 0
    if not value or not value.isascii() or not value.isdigit():
        raise ServiceError(400, "GAZE_INVALID_REQUEST")
    length = int(value)
    if length == 0 and not allow_empty:
        raise ServiceError(400, "GAZE_INVALID_REQUEST")
    if length > maximum:
        raise ServiceError(413, "GAZE_REQUEST_TOO_LARGE")
    return length


def serve(health):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "PrometheusGaze/1"
        sys_version = ""

        def reply(self, status, value):
            body = encode_json(value)
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if self.close_connection:
                self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def read_body(self, maximum, allow_empty=False):
            length = _content_length(self, maximum, allow_empty)
            raw = self.rfile.read(length) if length else b""
            if len(raw) != length:
                raise ServiceError(400, "GAZE_INVALID_REQUEST")
            return raw

        def service(self, action):
            try:
                action()
            except ServiceError as error:
                self.close_connection = True
                self.reply(error.status, {"status": "error", "error": error.code})
            except Exception:
                self.close_connection = True
                self.reply(500, {"status": "error", "error": "GAZE_INTERNAL_ERROR"})

        def do_GET(self):
            def action():
                if self.path == "/health":
                    self.read_body(MAX_JSON_BYTES, allow_empty=True)
                    self.reply(200, health)
                else:
                    self.close_connection = True
                    self.reply(404, {"status": "error", "error": "not_found"})
            self.service(action)

        def do_POST(self):
            def action():
                path = urlsplit(self.path).path
                if urlsplit(self.path).query or urlsplit(self.path).fragment:
                    raise ServiceError(400, "GAZE_INVALID_REQUEST")
                if path == "/sessions":
                    body = read_json_body(self.read_body(MAX_ADAPTER_JSON_BYTES))
                    if not COMPUTE_LOCK.acquire(blocking=False):
                        raise ServiceError(429, "GAZE_PROVIDER_BUSY")
                    try:
                        result = create_session(body)
                    finally:
                        COMPUTE_LOCK.release()
                    self.reply(201, result)
                    return

                parts = path.strip("/").split("/")
                if len(parts) < 2 or parts[0] != "sessions" or not parts[1] or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in parts[1]):
                    self.close_connection = True
                    self.reply(404, {"status": "error", "error": "not_found"})
                    return
                session_id = parts[1]
                operation = parts[2:] if len(parts) > 2 else []
                frame = None
                frame_id = None
                capture_timestamp = None
                body = None
                if operation == ["frame"]:
                    if self.headers.get_content_type() != "image/jpeg":
                        raise ServiceError(415, "GAZE_FRAME_CONTENT_TYPE")
                    frame = self.read_body(MAX_FRAME_BYTES)
                    try:
                        frame_id = int(self.headers.get("X-Frame-Id", ""), 10)
                        capture_timestamp = float(self.headers.get("X-Capture-Timestamp-Ms", ""))
                    except ValueError:
                        raise ServiceError(400, "GAZE_INVALID_FRAME_METADATA")
                elif operation in (["candidate", "start"], ["candidate", "accept"], ["candidate", "discard"]):
                    self.read_body(MAX_JSON_BYTES, allow_empty=True)
                elif operation == ["calibration", "sample"]:
                    body = read_json_body(self.read_body(MAX_JSON_BYTES))
                elif operation == ["calibration", "target"]:
                    body = read_json_body(self.read_body(MAX_TARGET_JSON_BYTES))
                elif operation == ["candidate", "adapt"]:
                    self.read_body(MAX_JSON_BYTES, allow_empty=True)
                else:
                    self.close_connection = True
                    self.reply(404, {"status": "error", "error": "not_found"})
                    return
                if not COMPUTE_LOCK.acquire(blocking=False):
                    raise ServiceError(429, "GAZE_PROVIDER_BUSY")
                try:
                    session = get_session(session_id)
                    if operation == ["frame"]:
                        result = infer_frame(session, frame_id, capture_timestamp, frame)
                    elif operation == ["candidate", "start"]:
                        result = start_candidate(session)
                    elif operation == ["candidate", "accept"]:
                        result = accept_candidate(session)
                    elif operation == ["candidate", "discard"]:
                        result = discard_candidate(session)
                    elif operation == ["calibration", "sample"]:
                        result = add_calibration_sample(session, body)
                    elif operation == ["calibration", "target"]:
                        result = process_calibration_target(session, body)
                    elif operation == ["candidate", "adapt"]:
                        result = finalize_candidate(session)
                finally:
                    COMPUTE_LOCK.release()
                self.reply(200, result)
            self.service(action)

        def do_DELETE(self):
            def action():
                parts = urlsplit(self.path).path.strip("/").split("/")
                self.read_body(MAX_JSON_BYTES, allow_empty=True)
                if len(parts) != 2 or parts[0] != "sessions":
                    self.close_connection = True
                    self.reply(404, {"status": "error", "error": "not_found"})
                    return
                session_id = parts[1]
                if not COMPUTE_LOCK.acquire(blocking=False):
                    raise ServiceError(429, "GAZE_PROVIDER_BUSY")
                try:
                    delete_session(session_id)
                finally:
                    COMPUTE_LOCK.release()
                self.reply(200, {"status": "disposed"})
            self.service(action)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, name="prometheus-gaze", daemon=True).start()
    return server


def _download(url, destination, timeout=300):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=timeout) as response, destination.open("wb") as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)


def _prepare_source():
    marker = SOURCE / ".prometheus-source-commit"
    package = SOURCE / "python" / "webeyetrack" / "webeyetrack.py"
    weights = SOURCE / "python" / "webeyetrack" / "model_weights" / "blazegaze_mpiifacegaze.keras"
    landmarker = SOURCE / "python" / "webeyetrack" / "model_weights" / "face_landmarker_v2_with_blendshapes.task"
    if marker.is_file() and marker.read_text("ascii").strip() == SOURCE_COMMIT and package.is_file() and weights.is_file() and landmarker.is_file():
        _patch_upstream_mediapipe_compatibility(SOURCE)
        return weights, landmarker
    if SOURCE.exists():
        shutil.rmtree(SOURCE)
    _download(SOURCE_ZIP, ARCHIVE)
    staging = HOME / "source-staging"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    prefix = f"WebEyeTrack-{SOURCE_COMMIT}/python/webeyetrack/"
    with zipfile.ZipFile(ARCHIVE) as archive:
        for item in archive.infolist():
            if not item.filename.startswith(prefix) or item.is_dir():
                continue
            relative = PurePosixPath(item.filename[len(f"WebEyeTrack-{SOURCE_COMMIT}/"):])
            if relative.is_absolute() or ".." in relative.parts:
                continue
            destination = staging.joinpath(*relative.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(item) as incoming, destination.open("wb") as outgoing:
                shutil.copyfileobj(incoming, outgoing)
        try:
            license_item = archive.getinfo(f"WebEyeTrack-{SOURCE_COMMIT}/LICENSE")
            with archive.open(license_item) as incoming, (staging / "LICENSE").open("wb") as outgoing:
                shutil.copyfileobj(incoming, outgoing)
        except KeyError:
            raise RuntimeError("pinned WebEyeTrack archive has no root MIT license")
    ARCHIVE.unlink(missing_ok=True)
    if not (staging / "python" / "webeyetrack" / "model_weights" / weights.name).is_file():
        raise RuntimeError("pinned WebEyeTrack archive is missing the official BlazeGaze checkpoint")
    _patch_upstream_mediapipe_compatibility(staging)
    (staging / ".prometheus-source-commit").write_text(SOURCE_COMMIT, encoding="ascii")
    staging.rename(SOURCE)
    return weights, landmarker


def _patch_upstream_mediapipe_compatibility(source_root):
    """Apply narrow compatibility edits for MediaPipe 0.10.32 / Python 3.13.

    The pinned WebEyeTrack dataclass module imports ``mediapipe.python as mp``
    but never references ``mp``. Its actual face-landmarker path uses the
    supported MediaPipe Tasks API. Python 3.13 also rejects its mutable NumPy
    dataclass default. Fail closed if either pinned-source assumption changes.
    """
    protocol = source_root / "python" / "webeyetrack" / "data_protocols.py"
    source = protocol.read_text("utf-8")
    legacy = "import mediapipe.python as mp"
    if legacy in source:
        if source.count(legacy) != 1 or "mp." in source.replace(legacy, ""):
            raise RuntimeError("pinned WebEyeTrack MediaPipe compatibility assumption changed")
        source = source.replace(legacy, "# Compatibility: unused legacy import removed in MediaPipe 0.10.30+")
    elif "Compatibility: unused legacy import removed in MediaPipe 0.10.30+" not in source:
        raise RuntimeError("pinned WebEyeTrack MediaPipe compatibility assumption changed")
    mutable_default = "norm_pog: np.ndarray = np.array([0.5, 0.5])"
    safe_default = "norm_pog: np.ndarray = field(default_factory=lambda: np.array([0.5, 0.5]))"
    if mutable_default in source:
        source = source.replace(mutable_default, safe_default)
    elif safe_default not in source:
        raise RuntimeError("pinned WebEyeTrack Python 3.13 dataclass assumption changed")
    protocol.write_text(source, encoding="utf-8")

    tracker = source_root / "python" / "webeyetrack" / "webeyetrack.py"
    tracker_source = tracker.read_text("utf-8")
    imports = "from dataclasses import dataclass"
    imports_with_field = "from dataclasses import dataclass, field"
    if imports in tracker_source:
        tracker_source = tracker_source.replace(imports, imports_with_field, 1)
    elif imports_with_field not in tracker_source:
        raise RuntimeError("pinned WebEyeTrack Python 3.13 dataclass import assumption changed")
    for field_name, class_name in (("kalman_config", "KalmanFilterConfig"), ("calib_config", "CalibConfig")):
        mutable = f"{field_name}: {class_name} = {class_name}()"
        safe = f"{field_name}: {class_name} = field(default_factory={class_name})"
        if mutable in tracker_source:
            tracker_source = tracker_source.replace(mutable, safe, 1)
        elif safe not in tracker_source:
            raise RuntimeError("pinned WebEyeTrack Python 3.13 dataclass defaults assumption changed")
    tracker.write_text(tracker_source, encoding="utf-8")


def _sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest().upper()


def bootstrap():
    global TRACKER_FACTORY, TF, NP, CV2, MODEL_SHA256
    if not (APP / "gaze_service.py").is_file():
        raise SystemExit("upload scripts/colab/gaze_service.py to /content/prometheus-gaze/app/gaze_service.py first")
    weights, landmarker = _prepare_source()
    sys.path.insert(0, str(SOURCE / "python"))
    import cv2
    try:
        from importlib.metadata import PackageNotFoundError, version
        try:
            mediapipe_version = version("mediapipe")
        except PackageNotFoundError:
            mediapipe_version = None
        if mediapipe_version != MEDIAPIPE_VERSION:
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", f"mediapipe=={MEDIAPIPE_VERSION}"],
                check=True,
                timeout=300,
            )
    except Exception as error:
        raise SystemExit(f"could not install pinned MediaPipe {MEDIAPIPE_VERSION} ({type(error).__name__})")
    import mediapipe
    import numpy as np
    import tensorflow as tf
    from webeyetrack import WebEyeTrack, WebEyeTrackConfig

    devices = tf.config.list_physical_devices("GPU")
    if not devices:
        raise SystemExit("no CUDA GPU is visible; cloud gaze service will not fall back to CPU")
    for device in devices:
        tf.config.experimental.set_memory_growth(device, True)
    tf.config.set_soft_device_placement(False)

    original_landmarker = WebEyeTrackConfig.__dataclass_fields__["mediapipe_flm_model_fp"].default
    if not Path(original_landmarker).is_file() or not weights.is_file() or not landmarker.is_file():
        raise SystemExit("pinned WebEyeTrack assets are incomplete")

    def tracker_factory(screen_px, screen_cm):
        config = WebEyeTrackConfig(
            blazegaze_mlp_fp=weights,
            mediapipe_flm_model_fp=str(landmarker),
            screen_px_dimensions=screen_px,
            screen_cm_dimensions=screen_cm,
            verbose=False,
        )
        with tf.device("/GPU:0"):
            return WebEyeTrack(config)

    TRACKER_FACTORY = tracker_factory
    TF, NP, CV2 = tf, np, cv2
    probe = None
    try:
        probe = _new_tracker((1920, 1080), (53.1, 29.8))
        with tf.device("/GPU:0"):
            output = probe.infer_fn(
                image=tf.zeros((1, 128, 512, 3), dtype=tf.float32),
                head_vector=tf.zeros((1, 3), dtype=tf.float32),
                face_origin_3d=tf.zeros((1, 3), dtype=tf.float32),
            )
        if tuple(output.shape) != (1, 2) or "GPU:0" not in output.device.upper():
            raise SystemExit("BlazeGaze GPU warm-up did not produce a (1,2) CUDA tensor")
    except SystemExit:
        raise
    except Exception as error:
        raise SystemExit(f"BlazeGaze CUDA warm-up failed ({type(error).__name__}); CPU fallback is disabled")
    finally:
        if probe is not None:
            try:
                probe.face_landmarker.close()
            except Exception:
                pass
            try:
                for values in probe.calib_data.values():
                    values.clear()
            except Exception:
                pass
        del probe
        gc.collect()
        try:
            tf.keras.backend.clear_session()
        except Exception:
            pass

    try:
        gpu_name = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip().splitlines()[0]
    except Exception:
        gpu_name = devices[0].name
    MODEL_SHA256 = _sha256(weights)
    return {
        "status": "ready",
        "backend": "colab_remote",
        "device": "cuda",
        "gpu": gpu_name,
        "model": {
            "id": MODEL_ID,
            "source": "https://github.com/RedForestAI/WebEyeTrack",
            "sourceCommit": SOURCE_COMMIT,
            "license": "MIT",
            "weights": weights.name,
            "sha256": MODEL_SHA256,
            "faceLandmarker": landmarker.name,
            "faceLandmarkerSha256": _sha256(landmarker),
        },
        "runtime": {
            "python": sys.version.split()[0],
            "tensorflow": tf.__version__,
            "mediapipe": mediapipe.__version__,
        },
    }


if "_PROMETHEUS_GAZE_SERVER" not in globals():
    HEALTH = bootstrap()
    _PROMETHEUS_GAZE_SERVER = serve(HEALTH)
print(json.dumps({"service": "prometheus-gaze", "listening": f"127.0.0.1:{PORT}", "model": (HEALTH or {}).get("model", {}).get("id")}, separators=(",", ":")))
