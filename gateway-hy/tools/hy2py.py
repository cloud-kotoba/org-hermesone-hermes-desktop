"""Render the Hy gateway as Python (the py side of the py <-> hy mapping).

    python tools/hy2py.py            # write py/kotoba_gateway/*.py
    python tools/hy2py.py --check    # compile every module, write nothing

The generated files are a read-only view for reviewers and for diffing against
upstream Hermes Python. The Hy sources stay authoritative, and py/ is
gitignored.
"""

import argparse
import ast
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path[:0] = [os.path.join(ROOT, ".deps"), ROOT]

import hy  # noqa: E402,F401
import hy.compiler  # noqa: E402

PACKAGE = "kotoba_gateway"
HEADER = "# Generated from {src} by tools/hy2py.py. Do not edit; edit the .hy source.\n"


def hy_modules():
    pkg = os.path.join(ROOT, PACKAGE)
    return sorted(
        os.path.join(pkg, name) for name in os.listdir(pkg) if name.endswith(".hy")
    )


def to_python(path):
    """Python source for one Hy module (compiled with Hy's own compiler)."""
    with open(path, encoding="utf-8") as f:
        source = f.read()
    module = f"{PACKAGE}.{os.path.splitext(os.path.basename(path))[0]}"
    tree = hy.compiler.hy_compile(
        hy.read_many(source, filename=path), module, filename=path, source=source
    )
    return ast.unparse(tree) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--out", default=os.path.join(ROOT, "py"))
    args = parser.parse_args(argv)
    out_pkg = os.path.join(args.out, PACKAGE)
    for path in hy_modules():
        rel = os.path.relpath(path, ROOT)
        code = to_python(path)
        compile(code, rel, "exec")  # the Python view must be valid Python
        if args.check:
            print(f"ok  {rel}")
            continue
        os.makedirs(out_pkg, exist_ok=True)
        target = os.path.join(out_pkg, os.path.basename(path)[:-3] + ".py")
        with open(target, "w", encoding="utf-8") as f:
            f.write(HEADER.format(src=rel) + code)
        print(f"{rel} -> {os.path.relpath(target, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
