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


if __name__ == "__main__":
    unittest.main()
