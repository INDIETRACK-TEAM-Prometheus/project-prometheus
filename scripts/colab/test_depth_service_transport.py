import contextlib
import gzip
import io
import json
import runpy
import unittest
from pathlib import Path


with contextlib.redirect_stdout(io.StringIO()):
    encode_reply = runpy.run_path(
        str(Path(__file__).with_name("depth_service.py")),
        init_globals={"_PROMETHEUS_DEPTH_SERVER": True},
    )["encode_reply"]


class ReplyTransportTests(unittest.TestCase):
    def test_gzip_round_trip_preserves_full_json_values(self):
        value = {"values": [1.0, 1.0001, 2.5], "validMask": [1, 1, 0]}
        body, compressed = encode_reply(value, "gzip, deflate")
        self.assertTrue(compressed)
        self.assertEqual(json.loads(gzip.decompress(body)), value)

    def test_identity_and_zero_quality_leave_body_uncompressed(self):
        value = {"values": [1.0], "validMask": [1]}
        expected = json.dumps(value, separators=(",", ":"), allow_nan=False).encode("ascii")
        for accept_encoding in ("identity", "gzip;q=0"):
            body, compressed = encode_reply(value, accept_encoding)
            self.assertFalse(compressed)
            self.assertEqual(body, expected)


if __name__ == "__main__":
    unittest.main()
