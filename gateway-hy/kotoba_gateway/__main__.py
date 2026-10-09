import sys

import hy  # noqa: F401

from kotoba_gateway.server import main

sys.exit(main(sys.argv[1:]))
