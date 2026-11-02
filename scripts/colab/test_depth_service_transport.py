import contextlib
import gzip
import io
import json
import runpy
import unittest
from pathlib import Path


with contextlib.redirect_stdout(io.StringIO()):
    service = runpy.run_path(
        str(Path(__file__).with_name("depth_service.py")),
        init_globals={"_PROMETHEUS_DEPTH_SERVER": True},
    )
encode_reply = service["encode_reply"]


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


class FakeRun:
    """Scripted stand-in for subprocess.run: records commands and answers verify/install/uninstall."""

    def __init__(self, verify=(False,), install_code=0, raise_on=None):
        self.verify = list(verify)
        self.install_code = install_code
        self.raise_on = raise_on
        self.calls = []

    def __call__(self, command, **kwargs):
        self.calls.append(command)
        kind = "verify" if command[1] == "-c" else command[3]
        if self.raise_on == kind:
            raise RuntimeError("boom")
        result = type("Result", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        if kind == "verify":
            ok = self.verify.pop(0) if self.verify else False
            result.returncode, result.stdout = (0, service["XFORMERS_VERSION"] + "\n") if ok else (3, "")
        elif kind == "install":
            result.returncode = self.install_code
        return result

    def kinds(self):
        return ["verify" if c[1] == "-c" else c[3] for c in self.calls]


class XformersAcceleratorTests(unittest.TestCase):
    def ensure(self, run, environ=None):
        return service["ensure_xformers"](run=run, environ=environ or {}, python="python")

    def test_verify_code_compiles_and_names_the_checks(self):
        compile(service["XFORMERS_VERIFY_CODE"], "verify", "exec")
        for needle in ("memory_efficient_attention", "scaled_dot_product_attention", "cuda.is_available", "1e-3"):
            self.assertIn(needle, service["XFORMERS_VERIFY_CODE"])

    def test_can_be_switched_off(self):
        run = FakeRun()
        self.assertIsNone(self.ensure(run, {"PROMETHEUS_XFORMERS": "0"}))
        self.assertEqual(run.calls, [])

    def test_an_already_working_install_is_reused_without_pip(self):
        run = FakeRun(verify=(True,))
        self.assertEqual(self.ensure(run), service["XFORMERS_VERSION"])
        self.assertEqual(run.kinds(), ["verify"])

    def test_install_is_pinned_never_touches_torch_and_must_pass_the_gpu_check(self):
        run = FakeRun(verify=(False, True))
        self.assertEqual(self.ensure(run), service["XFORMERS_VERSION"])
        self.assertEqual(run.kinds(), ["verify", "install", "verify"])
        install = run.calls[1]
        self.assertIn("--no-deps", install)
        self.assertIn("xformers==" + service["XFORMERS_VERSION"], install)
        self.assertFalse([part for part in install if part.startswith("torch")])

    def test_failed_install_or_failed_check_removes_xformers_and_keeps_the_service_running(self):
        failed_install = FakeRun(verify=(False,), install_code=1)
        self.assertIsNone(self.ensure(failed_install))
        self.assertEqual(failed_install.kinds(), ["verify", "install", "uninstall"])
        failed_check = FakeRun(verify=(False, False))
        self.assertIsNone(self.ensure(failed_check))
        self.assertEqual(failed_check.kinds(), ["verify", "install", "verify", "uninstall"])

    def test_errors_in_any_step_never_escape(self):
        for step in ("verify", "install", "uninstall"):
            run = FakeRun(verify=(False, False), raise_on=step)
            self.assertIsNone(self.ensure(run), step)
        self.assertEqual(self.ensure(FakeRun(verify=(True,)), {}), service["XFORMERS_VERSION"])


if __name__ == "__main__":
    unittest.main()
