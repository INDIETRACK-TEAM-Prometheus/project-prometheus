"""Fast CPU-side checks; these use a stub only and do not claim model inference."""

from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path

import numpy as np
import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import DepthFailure, decode_image, infer_bgr
from worker import parse_request


class FakeModel:
    def __init__(self, values):
        self.values = values

    def image2tensor(self, image, _input_size):
        self.shape = image.shape[:2]
        return torch.zeros((1, 3, 14, 14)), self.shape

    def forward(self, _image):
        height, width = self.shape
        return torch.as_tensor(self.values, dtype=torch.float32).reshape(1, height, width)


def png_bytes(width=3, height=2):
    out = io.BytesIO()
    Image.new("RGB", (width, height), (90, 120, 160)).save(out, format="PNG")
    return out.getvalue()


class DepthInputTests(unittest.TestCase):
    def test_decodes_only_frame_aligned_bounded_png(self):
        image = decode_image(png_bytes(), 3, 2)
        self.assertEqual(image.shape, (2, 3, 3))
        with self.assertRaisesRegex(DepthFailure, "DEPTH_FRAME_MISMATCH"):
            decode_image(png_bytes(), 2, 3)

    def test_rejects_unbounded_frame_before_decoding(self):
        with self.assertRaisesRegex(DepthFailure, "DEPTH_INVALID_FRAME"):
            decode_image(png_bytes(), 4096, 4096)

    def test_worker_request_keeps_aligned_frame_and_strict_data_url(self):
        import base64
        encoded = base64.b64encode(png_bytes()).decode("ascii")
        request = {
            "id": "request-1",
            "frame": {"frameId": "f1", "observedAt": 25.5, "width": 3, "height": 2},
            "imageDataUrl": "data:image/png;base64," + encoded,
        }
        request_id, frame, pixels = parse_request(request)
        self.assertEqual((request_id, frame["frameId"], len(pixels)), ("request-1", "f1", len(png_bytes())))
        request["frame"]["width"] = 4
        _, mismatched_frame, mismatched_pixels = parse_request(request)
        with self.assertRaisesRegex(DepthFailure, "DEPTH_FRAME_MISMATCH"):
            decode_image(mismatched_pixels, mismatched_frame["width"], mismatched_frame["height"])

    def test_inference_returns_meters_with_explicit_invalid_mask(self):
        bgr = np.zeros((2, 3, 3), dtype=np.uint8)
        depth, valid, elapsed = infer_bgr(FakeModel([2.0, float("nan"), 0.0, 3.0, 21.0, 4.0]), bgr)
        self.assertEqual(depth.shape, (2, 3))
        np.testing.assert_array_equal(valid, np.array([[1, 0, 0], [1, 0, 1]], dtype=np.uint8))
        np.testing.assert_array_equal(depth, np.array([[2.0, 0.0, 0.0], [3.0, 0.0, 4.0]], dtype="<f4"))
        self.assertGreaterEqual(elapsed, 0)

    def test_all_invalid_predictions_are_not_published(self):
        with self.assertRaisesRegex(DepthFailure, "DEPTH_INVALID_OUTPUT"):
            infer_bgr(FakeModel([0, float("nan"), 30, 0, 0, 0]), np.zeros((2, 3, 3), dtype=np.uint8))


if __name__ == "__main__":
    unittest.main()

