import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('aria_verify_vrs', Path(__file__).resolve().parents[1] / 'scripts/aria_verify_vrs.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class VerifierTest(unittest.TestCase):
    def test_checksum_mismatch_blocks_before_sdk(self):
        with patch.object(module, 'sha256', return_value='wrong'):
            result = module.verify(Path('wrong.vrs'))
            self.assertEqual(result['status'], 'blocked')
            self.assertEqual(result['unavailableReasons']['vrs'], 'checksum_mismatch')
            self.assertIsNone(result['rgb'])
    def test_index_selection_is_bounded(self):
        self.assertEqual(module.indices(0), [])
        self.assertEqual(module.indices(1), [0])
        self.assertEqual(module.indices(100), [0, 50, 99])

if __name__ == '__main__': unittest.main()

