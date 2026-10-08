"""Launcher: `HERMES_PYTHON kotoba_gateway_main.py [--port N]`.

Puts this directory and its vendored `.deps` (Hy) on sys.path, so the gateway
runs inside Hermes Agent's own venv without installing anything into it.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
for path in (os.path.join(HERE, ".deps"), HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

import hy  # noqa: E402,F401

from kotoba_gateway.server import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
