import os
import tempfile
import unittest
from pathlib import Path


class ColabServiceRunnerTests(unittest.TestCase):
    def test_depth_and_gaze_globals_stay_isolated_in_one_kernel(self):
        runner = Path(__file__).with_name("run-colab-service.py")
        runner_code = runner.read_text(encoding="utf-8")
        env_keys = ("PROMETHEUS_COLAB_SERVICE_PATH", "PROMETHEUS_COLAB_SERVICE_NAME")
        previous = {key: os.environ.get(key) for key in env_keys}

        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            depth = Path(directory) / "depth.py"
            gaze = Path(directory) / "gaze.py"
            depth.write_text('PORT = 8765\nSOURCE_COMMIT = "depth"\ndef read_commit(): return SOURCE_COMMIT\n', encoding="utf-8")
            gaze.write_text('PORT = 8766\nSOURCE_COMMIT = "gaze"\ndef read_commit(): return SOURCE_COMMIT\n', encoding="utf-8")
            kernel_globals = {"__name__": "__main__"}

            try:
                for name, path in (("depth", depth), ("gaze", gaze)):
                    os.environ[env_keys[0]] = str(path)
                    os.environ[env_keys[1]] = name
                    exec(compile(runner_code, str(runner), "exec"), kernel_globals)

                depth_namespace = kernel_globals["_PROMETHEUS_DEPTH_NAMESPACE"]
                gaze_namespace = kernel_globals["_PROMETHEUS_GAZE_NAMESPACE"]
                self.assertEqual(depth_namespace["read_commit"](), "depth")
                self.assertEqual(gaze_namespace["read_commit"](), "gaze")
                self.assertNotIn("SOURCE_COMMIT", kernel_globals)

                depth.write_text('SOURCE_COMMIT = "changed"\ndef read_commit(): return SOURCE_COMMIT\n', encoding="utf-8")
                os.environ[env_keys[0]] = str(depth)
                os.environ[env_keys[1]] = "depth"
                exec(compile(runner_code, str(runner), "exec"), kernel_globals)
                self.assertIs(kernel_globals["_PROMETHEUS_DEPTH_NAMESPACE"], depth_namespace)
                self.assertEqual(depth_namespace["read_commit"](), "depth")
            finally:
                for key, value in previous.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value


if __name__ == "__main__":
    unittest.main()
