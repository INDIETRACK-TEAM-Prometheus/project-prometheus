import contextlib
import io
import runpy
import unittest
from contextlib import nullcontext
from pathlib import Path

import numpy as np


with contextlib.redirect_stdout(io.StringIO()):
    service = runpy.run_path(
        str(Path(__file__).with_name("gaze_service.py")),
        init_globals={"_PROMETHEUS_GAZE_SERVER": True},
    )


class FakeTF:
    @staticmethod
    def device(_):
        return nullcontext()


class FakeLandmarker:
    def close(self):
        pass


class FakeGazeMLP:
    def __init__(self):
        self.weights = [np.zeros(shape, dtype=np.float32) for shape in service["ADAPTER_WEIGHT_SHAPES"]]

    def get_weights(self):
        return [value.copy() for value in self.weights]

    def set_weights(self, values):
        self.weights = [np.asarray(value, dtype=np.float32).copy() for value in values]

    def predict(self, features):
        total = sum(float(value.sum()) for value in self.weights) + float(np.asarray(features).sum())
        return np.asarray([[total, total / 2]], dtype=np.float32)


class FakeTracker:
    def __init__(self):
        self.face_landmarker = FakeLandmarker()
        self.calib_data = {"support_x": [], "support_y": [], "timestamps": [], "pt_type": []}
        self.adapt_calls = []
        self.blazegaze = type("BlazeGaze", (), {"gaze_mlp": FakeGazeMLP()})()

    def adapt(self, eye_patches, head_vectors, face_origins, targets, **kwargs):
        self.adapt_calls.append((eye_patches, head_vectors, face_origins, targets, kwargs))


class GazeServiceTests(unittest.TestCase):
    def setUp(self):
        namespace = service["add_calibration_sample"].__globals__
        namespace["TF"] = FakeTF
        namespace["NP"] = np
        namespace["MODEL_SHA256"] = "A" * 64
        self.session = service["GazeSession"]("test-session", (1920, 1080), (53.1, 29.8), FakeTracker())
        self.session.candidate = service["TrackerState"](FakeTracker())

    def _with_fake_upstream_ear(self, compute_ear):
        import sys
        import types
        package = types.ModuleType("webeyetrack")
        module = types.ModuleType("webeyetrack.model_based")
        module.compute_ear = compute_ear
        package.model_based = module
        previous = {name: sys.modules.get(name) for name in ("webeyetrack", "webeyetrack.model_based")}
        sys.modules["webeyetrack"], sys.modules["webeyetrack.model_based"] = package, module
        self.addCleanup(lambda: [sys.modules.__setitem__(n, m) if m is not None else sys.modules.pop(n, None) for n, m in previous.items()])
        namespace = service["_eye_aspect_ratios"].__globals__
        namespace["NP"] = np

    def test_eye_aspect_ratios_use_upstream_scaling_and_threshold(self):
        seen = []

        def compute_ear(facial_landmarks, side):
            seen.append((side, float(facial_landmarks[0][0]), float(facial_landmarks[0][1])))
            return 0.1823456 if side == "left" else 0.25

        self._with_fake_upstream_ear(compute_ear)
        tracker = FakeTracker()
        tracker.config = type("Config", (), {"ear_threshold": 0.2})()
        state = service["TrackerState"](tracker)
        result = type("Result", (), {"facial_landmarks": np.array([[0.5, 0.25, 0.0]])})()
        ear = service["_eye_aspect_ratios"](state, result, 640, 360)
        self.assertEqual(ear, {"left": 0.1823, "right": 0.25, "threshold": 0.2})
        self.assertEqual(seen, [("left", 320.0, 90.0), ("right", 320.0, 90.0)])

    def test_eye_aspect_ratios_are_null_when_upstream_helper_or_values_fail(self):
        self._with_fake_upstream_ear(lambda facial_landmarks, side: float("nan"))
        state = service["TrackerState"](FakeTracker())
        result = type("Result", (), {"facial_landmarks": np.array([[0.5, 0.25, 0.0]])})()
        self.assertIsNone(service["_eye_aspect_ratios"](state, result, 640, 360))
        self._with_fake_upstream_ear(lambda facial_landmarks, side: (_ for _ in ()).throw(RuntimeError("boom")))
        self.assertIsNone(service["_eye_aspect_ratios"](state, result, 640, 360))

    def test_defaults_and_null_screen_dimensions_match_upstream(self):
        self.assertEqual(service["screen_dimensions"]({}), ((1920, 1080), (53.1, 29.8)))
        self.assertEqual(service["screen_dimensions"]({"screenPxDimensions": None, "screenCmDimensions": None}), ((1920, 1080), (53.1, 29.8)))

    def test_invalid_target_is_rejected(self):
        with self.assertRaises(service["ServiceError"]) as error:
            service["calibration_target"]([0.51, 0])
        self.assertEqual(error.exception.code, "GAZE_INVALID_TARGET")

    def test_calibration_requires_exact_fresh_candidate_frames_and_adapts_on_27(self):
        with self.assertRaises(service["ServiceError"]) as error:
            service["add_calibration_sample"](self.session, {"pointIndex": 0, "frameId": 999, "target": [0, 0]})
        self.assertEqual(error.exception.code, "GAZE_CALIBRATION_FRAME_UNAVAILABLE")

        candidate = self.session.candidate
        for index in range(27):
            frame_id = index + 1
            candidate.frames[frame_id] = {
                "gazeState": "open",
                "eyePatch": f"eye-{index}",
                "headVector": f"head-{index}",
                "faceOrigin3D": f"face-{index}",
            }
            result = service["add_calibration_sample"](
                self.session,
                {"pointIndex": index, "frameId": frame_id, "target": [index / 100, -index / 100]},
            )
            self.assertEqual(result["points"], index + 1)

        self.assertEqual(result["status"], "adapted")
        self.assertEqual(result["requiredPoints"], 27)
        self.assertEqual(len(candidate.tracker.adapt_calls), 1)
        adapted = candidate.tracker.adapt_calls[0]
        self.assertEqual(len(adapted[0]), 27)
        self.assertEqual(adapted[3][26], [0.26, -0.26])
        self.assertEqual(adapted[4], {"steps_inner": 5, "inner_lr": 1e-5, "affine_transform": False, "pt_type": "calib"})
        self.assertEqual(candidate.frames, {})
        self.assertEqual(candidate.calibration, [])

    def test_completed_sample_retry_is_idempotent_and_changed_reuse_fails(self):
        candidate = self.session.candidate
        candidate.calibrated = True
        candidate.calibration_by_index[0] = {"frameId": 1, "target": [0.0, 0.0]}
        retried = service["add_calibration_sample"](self.session, {"pointIndex": 0, "frameId": 1, "target": [0.0, 0.0]})
        self.assertEqual(retried["status"], "adapted")
        with self.assertRaises(service["ServiceError"]) as error:
            service["add_calibration_sample"](self.session, {"pointIndex": 0, "frameId": 2, "target": [0.0, 0.0]})
        self.assertEqual(error.exception.code, "GAZE_CALIBRATION_INDEX_REUSED")

    def test_candidate_commit_preserves_adapted_tracker_and_discards_baseline(self):
        previous = self.session.active
        candidate = self.session.candidate
        candidate.calibrated = True
        result = service["accept_candidate"](self.session)
        self.assertEqual(result["status"], "accepted")
        self.assertTrue(result["calibrated"])
        self.assertEqual(result["adapter"]["adapterId"], "webeyetrack-gaze-mlp-f32-v1")
        self.assertIs(self.session.active, candidate)
        self.assertIsNone(self.session.candidate)
        self.assertIsNone(previous.tracker)

    def test_adapter_round_trip_preserves_synthetic_predictions(self):
        source = FakeTracker()
        arrays = source.blazegaze.gaze_mlp.get_weights()
        for index, value in enumerate(arrays):
            value[:] = (index + 1) / 1000
        source.blazegaze.gaze_mlp.set_weights(arrays)
        probe = np.asarray([[0.25, -0.125]], dtype=np.float32)
        before = source.blazegaze.gaze_mlp.predict(probe)

        adapter = service["export_adapter"](source)
        self.assertEqual(set(adapter), {"schemaVersion", "adapterId", "modelId", "sourceCommit", "modelSha256", "weights"})
        restored = FakeTracker()
        weights = service["decode_adapter"](adapter)
        self.assertTrue(service["apply_adapter"](restored, weights))
        after = restored.blazegaze.gaze_mlp.predict(probe)
        np.testing.assert_array_equal(before, after)

    def test_adapter_rejects_wrong_hash_and_invalid_weight_payload(self):
        source = FakeTracker()
        adapter = service["export_adapter"](source)
        adapter["modelSha256"] = "B" * 64
        with self.assertRaises(service["ServiceError"]) as error:
            service["decode_adapter"](adapter)
        self.assertEqual(error.exception.code, "GAZE_ADAPTER_MODEL_MISMATCH")

        adapter = service["export_adapter"](source)
        adapter["weights"][0]["data"] = "AAAAAAAAAIA="  # wrong byte count for [518,16]
        with self.assertRaises(service["ServiceError"]) as error:
            service["decode_adapter"](adapter)
        self.assertEqual(error.exception.code, "GAZE_INVALID_ADAPTER")


class BatchCalibrationTests(unittest.TestCase):
    """Per-target frame bursts and the final adaptation, with inference replaced by a scripted fake."""

    def setUp(self):
        import base64
        self.jpeg = base64.b64encode(b"\xff\xd8\xff\xd9").decode("ascii")
        namespace = service["process_calibration_target"].__globals__
        namespace["NP"] = np
        namespace["TF"] = FakeTF
        self.namespace = namespace
        self.original_infer = namespace["infer_frame"]
        self.addCleanup(lambda: namespace.__setitem__("infer_frame", self.original_infer))
        self.session = service["GazeSession"]("batch-session", (1920, 1080), (53.1, 29.8), FakeTracker())
        self.session.candidate = service["TrackerState"](FakeTracker())
        self.script = {}

        def fake_infer(session, frame_id, timestamp, jpeg):
            outcome = self.script.get(frame_id, {"face": True, "state": "open", "pog": [0.1, 0.2]})
            if outcome.get("raise"):
                raise service["ServiceError"](503, outcome["raise"])
            result = {"frameId": frame_id, "faceDetected": outcome["face"], "gazeState": outcome["state"] if outcome["face"] else "unknown",
                      "normPog": outcome["pog"] if outcome["face"] else None, "eyeAspectRatio": outcome.get("ear")}
            if outcome["face"] and outcome["state"] == "open":
                session.candidate.frames[frame_id] = {"gazeState": "open", "eyePatch": frame_id, "headVector": frame_id, "faceOrigin3D": frame_id}
            return result

        namespace["infer_frame"] = fake_infer

    def body(self, ids, phase="train", index=0, target=(0.0, 0.0)):
        return {"phase": phase, "pointIndex": index, "target": list(target), "frames": [{"frameId": i, "captureTimestampMs": float(i), "jpeg": self.jpeg} for i in ids]}

    def test_train_target_keeps_the_most_representative_open_frame_and_clears_the_rest(self):
        self.script = {1: {"face": True, "state": "open", "pog": [0.10, 0.10]}, 2: {"face": True, "state": "open", "pog": [0.12, 0.10]},
                       3: {"face": True, "state": "open", "pog": [0.50, 0.50]}, 4: {"face": True, "state": "open", "pog": [0.11, 0.11]},
                       5: {"face": True, "state": "closed", "pog": [0.0, 0.0]}}
        response = service["process_calibration_target"](self.session, self.body([1, 2, 3, 4, 5]))
        candidate = self.session.candidate
        self.assertEqual(response["status"], "accepted")
        self.assertEqual((response["usableFrames"], response["closedFrames"], response["collected"]), (4, 1, 1))
        self.assertEqual(candidate.batch[0]["frameId"], 4)  # closest to the median, not the outlier
        self.assertEqual(len(candidate.frames), 0)
        self.assertEqual(candidate.batch[0]["target"], [0.0, 0.0])

    def test_closed_or_missing_faces_are_reported_with_eye_aspect_ratio_and_store_nothing(self):
        ear = {"left": 0.17, "right": 0.19, "threshold": 0.2}
        self.script = {i: {"face": True, "state": "closed", "pog": [0.0, 0.0], "ear": ear} for i in range(1, 6)}
        response = service["process_calibration_target"](self.session, self.body(range(1, 6)))
        self.assertEqual(response["status"], "insufficient")
        self.assertEqual((response["faceFrames"], response["closedFrames"], response["usableFrames"]), (5, 5, 0))
        self.assertEqual(response["eyeAspectRatio"], {"min": 0.17, "threshold": 0.2})
        self.assertEqual(len(self.session.candidate.batch), 0)
        self.script = {i: {"face": False, "state": "unknown", "pog": None} for i in range(6, 11)}
        none = service["process_calibration_target"](self.session, self.body(range(6, 11), index=1))
        self.assertEqual((none["status"], none["faceFrames"], none["eyeAspectRatio"]), ("insufficient", 0, None))

    def test_frame_errors_do_not_abort_the_burst_but_too_few_usable_frames_fail(self):
        self.script = {1: {"raise": "GAZE_INFERENCE_FAILED"}, 2: {"raise": "GAZE_INFERENCE_FAILED"}, 3: {"raise": "GAZE_INFERENCE_FAILED"}}
        response = service["process_calibration_target"](self.session, self.body([1, 2, 3, 4, 5]))
        self.assertEqual((response["status"], response["frameErrors"], response["usableFrames"]), ("insufficient", 3, 2))

    def test_resending_the_same_frames_is_idempotent_and_new_frames_replace_the_sample(self):
        first = service["process_calibration_target"](self.session, self.body([1, 2, 3, 4, 5]))
        again = service["process_calibration_target"](self.session, self.body([1, 2, 3, 4, 5]))
        self.assertIs(first, again)
        self.assertEqual(len(self.session.candidate.batch), 1)
        replaced = service["process_calibration_target"](self.session, self.body([6, 7, 8, 9, 10]))
        self.assertEqual(replaced["status"], "accepted")
        self.assertEqual(len(self.session.candidate.batch), 1)
        self.assertGreaterEqual(self.session.candidate.batch[0]["frameId"], 6)

    def test_requests_are_validated_before_any_inference(self):
        calls = []
        self.namespace["infer_frame"] = lambda *args: calls.append(args)
        bad_bodies = [
            {**self.body([1]), "phase": "other"}, {**self.body([1]), "pointIndex": 27}, {**self.body([1]), "target": [0.9, 0]},
            {**self.body([1]), "extra": 1}, {**self.body([]),}, self.body(range(1, 10)),
            {**self.body([1]), "frames": [{"frameId": 1, "captureTimestampMs": 1.0, "jpeg": "not base64!"}]},
            {**self.body([1]), "frames": [{"frameId": 1, "captureTimestampMs": 1.0, "jpeg": "AAAAAAA="}]},
            {**self.body([1]), "frames": [{"frameId": 0, "captureTimestampMs": 1.0, "jpeg": self.jpeg}]},
        ]
        for body in bad_bodies:
            with self.assertRaises(service["ServiceError"]) as error:
                service["process_calibration_target"](self.session, body)
            self.assertEqual(error.exception.status, 400, body.keys())
        self.assertEqual(calls, [])
        self.session.candidate = None
        with self.assertRaises(service["ServiceError"]) as error:
            service["process_calibration_target"](self.session, self.body([1]))
        self.assertEqual(error.exception.code, "GAZE_CANDIDATE_UNAVAILABLE")

    def test_phase_must_match_the_candidate_state(self):
        with self.assertRaises(service["ServiceError"]) as error:
            service["process_calibration_target"](self.session, self.body([1, 2, 3], phase="validate"))
        self.assertEqual(error.exception.code, "GAZE_CANDIDATE_NOT_ADAPTED")
        self.session.candidate.calibrated = True
        with self.assertRaises(service["ServiceError"]) as error:
            service["process_calibration_target"](self.session, self.body([1, 2, 3]))
        self.assertEqual(error.exception.code, "GAZE_CANDIDATE_ALREADY_ADAPTED")

    def test_validation_measures_the_median_without_storing_samples(self):
        self.session.candidate.calibrated = True
        self.script = {1: {"face": True, "state": "open", "pog": [0.0, 0.0]}, 2: {"face": True, "state": "open", "pog": [0.2, 0.4]},
                       3: {"face": True, "state": "open", "pog": [0.4, 0.2]}}
        response = service["process_calibration_target"](self.session, self.body([1, 2, 3], phase="validate"))
        self.assertEqual(response["status"], "measured")
        self.assertEqual(response["normPog"], [0.2, 0.2])
        self.assertEqual((len(self.session.candidate.batch), len(self.session.candidate.frames)), (0, 0))

    def test_finalize_requires_all_27_targets_then_adapts_once_in_target_order(self):
        for index in range(26):
            service["process_calibration_target"](self.session, self.body([index * 10 + i for i in range(1, 6)], index=index, target=(0.0, 0.0)))
        with self.assertRaises(service["ServiceError"]) as error:
            service["finalize_candidate"](self.session)
        self.assertEqual(error.exception.code, "GAZE_CALIBRATION_INCOMPLETE")
        service["process_calibration_target"](self.session, self.body([1001, 1002, 1003, 1004, 1005], index=26, target=(0.0, 0.0)))
        tracker = self.session.candidate.tracker
        result = service["finalize_candidate"](self.session)
        self.assertEqual(result, {"status": "adapted", "points": 27, "requiredPoints": 27})
        self.assertEqual(len(tracker.adapt_calls), 1)
        self.assertEqual(len(tracker.adapt_calls[0][0]), 27)
        self.assertTrue(self.session.candidate.calibrated)
        self.assertEqual(service["finalize_candidate"](self.session)["status"], "adapted")
        self.assertEqual(len(tracker.adapt_calls), 1)


class TrackingFailureTests(unittest.TestCase):
    """Upstream reports a failed eye patch only by printing it; the service must turn that into a reason."""

    def setUp(self):
        namespace = service["_frame_result"].__globals__
        self.namespace = namespace
        previous = {name: namespace.get(name) for name in ("NP", "TF", "CV2")}
        self.addCleanup(lambda: [namespace.__setitem__(name, value) for name, value in previous.items()])
        namespace["NP"] = np
        namespace["TF"] = FakeTF
        namespace["CV2"] = type("FakeCV2", (), {"IMREAD_COLOR": 1, "imdecode": staticmethod(lambda data, flag: np.zeros((120, 160, 3), dtype=np.uint8))})
        self.session = service["GazeSession"]("failure-session", (1920, 1080), (53.1, 29.8), FakeTracker())

    def run_frame(self, process_frame):
        tracker = FakeTracker()
        tracker.process_frame = process_frame
        state = service["TrackerState"](tracker)
        return service["_frame_result"](state, self.session, 1, 5.0, b"\xff\xd8\xff\xd9")

    def test_eye_patch_failure_is_named_with_a_sanitised_message(self):
        def process(frame):
            print("Error in obtaining eye patch: could not broadcast input array from shape (3,) into shape (2,)\nsecond line <script>")
            return type("Status", (), {"value": 0})(), None, None
        result = self.run_frame(process)
        self.assertFalse(result["faceDetected"])
        self.assertEqual(result["trackingFailure"], {"stage": "eye_patch", "message": "could not broadcast input array from shape (3,) into shape (2,)"})

    def test_message_is_reduced_to_harmless_characters_and_length(self):
        def process(frame):
            print("Error in obtaining eye patch: <b>bad</b> \\ \"quote\" " + "x" * 400)
            return type("Status", (), {"value": 0})(), None, None
        message = self.run_frame(process)["trackingFailure"]["message"]
        self.assertLessEqual(len(message), 160)
        self.assertNotIn("<", message)
        self.assertNotIn('"', message)

    def test_no_landmarks_is_reported_as_landmarks_stage(self):
        result = self.run_frame(lambda frame: (type("Status", (), {"value": 0})(), None, None))
        self.assertEqual(result["trackingFailure"], {"stage": "landmarks", "message": None})

    def test_detected_faces_carry_no_failure_and_stdout_is_restored(self):
        import sys
        before = sys.stdout

        def process(frame):
            print("noise that must not leak")
            result = type("Result", (), {"gaze_state": "open", "norm_pog": np.array([0.1, 0.2]), "durations": {}, "eye_patch": np.zeros((2, 2)),
                                         "head_vector": np.zeros(3), "face_origin_3d": np.zeros(3), "facial_landmarks": np.zeros((478, 3))})()
            return type("Status", (), {"value": 1})(), result, None

        result = self.run_frame(process)
        self.assertTrue(result["faceDetected"])
        self.assertIsNone(result["trackingFailure"])
        self.assertIs(sys.stdout, before)

    def test_inference_exceptions_still_surface_as_service_errors_with_stdout_restored(self):
        import sys
        before = sys.stdout

        def process(frame):
            raise RuntimeError("boom")

        with self.assertRaises(service["ServiceError"]) as error:
            self.run_frame(process)
        self.assertEqual(error.exception.code, "GAZE_INFERENCE_FAILED")
        self.assertIs(sys.stdout, before)

    def test_burst_summary_counts_eye_patch_failures_and_keeps_the_first_message(self):
        import base64
        jpeg = base64.b64encode(b"\xff\xd8\xff\xd9").decode("ascii")
        batch = BatchCalibrationTests("test_requests_are_validated_before_any_inference")
        batch.setUp()
        self.addCleanup(batch.doCleanups)
        failure = {"stage": "eye_patch", "message": "shape mismatch"}

        def fake_infer(session, frame_id, timestamp, data):
            return {"frameId": frame_id, "faceDetected": False, "gazeState": "unknown", "normPog": None, "eyeAspectRatio": None, "trackingFailure": failure}

        batch.namespace["infer_frame"] = fake_infer
        body = {"phase": "train", "pointIndex": 0, "target": [0.0, 0.0], "frames": [{"frameId": i, "captureTimestampMs": float(i), "jpeg": jpeg} for i in range(1, 6)]}
        response = service["process_calibration_target"](batch.session, body)
        self.assertEqual((response["status"], response["faceFrames"], response["eyePatchFailures"], response["failureMessage"]), ("insufficient", 0, 5, "shape mismatch"))


if __name__ == "__main__":
    unittest.main()
