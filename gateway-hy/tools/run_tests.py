"""Run the gateway test suite: `python tools/run_tests.py` (from anywhere).

One entry point for `npm run test:gateway` and the murakumo actions
`kotoba-desktop/gateway` job, which runs argv without a shell.
"""

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
sys.path[:0] = [os.path.join(ROOT, ".deps"), ROOT]

import hy  # noqa: E402,F401  (registers the .hy importer)

MODULES = [
    "tests.test_gateway",
    "tests.test_mesh",
    "tests.test_shard",
    "tests.test_placement",
    "tests.test_python_interop",
]

if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromNames(MODULES)
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
