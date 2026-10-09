"""Launcher: `HERMES_PYTHON kotoba_gateway_main.py [--port N]`.

Puts this directory and its vendored `.deps` (Hy) on sys.path, so the gateway
runs inside Hermes Agent's own environment without installing anything into it.

With the Hermes backend, Hermes' bootstrap runs first: it may re-exec this
script under Hermes' managed dependency generation and only then puts those
dependencies (e.g. `cryptography`) on sys.path. Entering it before any gateway
module loads means every import below sees the same environment Hermes does.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _backend(argv):
    for i, arg in enumerate(argv):
        if arg == "--backend" and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith("--backend="):
            return arg.split("=", 1)[1]
    return os.environ.get("KOTOBA_GATEWAY_BACKEND", "hermes")


if _backend(sys.argv[1:]) == "hermes":
    repo = os.environ.get("HERMES_REPO") or os.getcwd()
    if os.path.isfile(os.path.join(repo, "hermes_bootstrap.py")):
        if repo not in sys.path:
            sys.path.insert(0, repo)
        import hermes_bootstrap  # noqa: E402,F401  (may re-exec this process)

for path in (os.path.join(HERE, ".deps"), HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

import hy  # noqa: E402,F401

from kotoba_gateway.server import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
