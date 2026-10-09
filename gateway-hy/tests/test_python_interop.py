"""py <-> hy: the Hy gateway used from plain Python, and its Python view.

Python callers import the Hy modules directly (once `hy` is imported) and see
ordinary snake_case names, which is the contract the mapping in
lat.md/gateway-hy.md documents.
"""

import os
import sys
import tempfile
import unittest

import hy  # noqa: F401  (registers the .hy importer)

from kotoba_gateway.backend import EchoBackend
from kotoba_gateway.identity import NodeIdentity, is_signed, verify_request
from kotoba_gateway.ledger import BlockStore, Ledger, cid_of, is_valid_cid
from kotoba_gateway.server import make_server, split_chat_messages

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import hy2py  # noqa: E402


class PythonInterop(unittest.TestCase):
    # @lat: [[gateway-hy#Tests#Hy modules are plain Python modules]]
    def test_hy_modules_are_plain_python_modules(self):
        node = NodeIdentity.generate()
        doc = node.sign_document({"hello": "py"})
        self.assertTrue(is_signed(doc))
        headers = node.request_headers("GET", "/v1/peers", b"")
        self.assertEqual(verify_request(headers, "GET", "/v1/peers", b""), node.did)
        with tempfile.TemporaryDirectory() as d:
            ledger = Ledger(BlockStore(d), os.path.join(d, "heads.json"), node)
            head = ledger.append("s", {"input": "a", "output": "b"})
            self.assertTrue(is_valid_cid(head["cid"]))
            self.assertEqual(cid_of(ledger.blocks.get_bytes(head["cid"])), head["cid"])
            server, gateway = make_server("127.0.0.1", 0, EchoBackend(), None, state_dir=d)
            server.server_close()
            self.assertEqual(gateway.node.did, gateway.manifest()["did"])
        self.assertEqual(split_chat_messages([{"role": "user", "content": "x"}])[2], "x")

    # @lat: [[gateway-hy#Tests#Python view compiles without mangled names]]
    def test_python_view_compiles_without_mangled_names(self):
        for path in hy2py.hy_modules():
            code = hy2py.to_python(path)
            compile(code, path, "exec")
            # `hyx_` means a Hy name Python cannot spell (e.g. `foo?`, or `{e!r}`
            # read as a symbol in an f-string): a broken mapping, or a bug.
            self.assertNotIn("hyx_", code, os.path.basename(path))


if __name__ == "__main__":
    unittest.main()
