#!/usr/bin/env node
// Helper for the Hy gateway in gateway-hy/.
//   deps   vendor Hy into gateway-hy/.deps for Hermes Agent's python
//   test   run the gateway contract tests (echo backend)
//   start  run the gateway against the local Hermes Agent install
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const gw = join(root, "gateway-hy");
const hermesHome = process.env.HERMES_HOME || join(homedir(), ".hermes");
const hermesRepo = process.env.HERMES_REPO || join(hermesHome, "hermes-agent");
// Same interpreter the desktop spawns (src/main/installer.ts HERMES_PYTHON).
const python =
  process.env.HERMES_PYTHON ||
  (process.platform === "win32"
    ? join(hermesRepo, "venv", "Scripts", "python.exe")
    : join(hermesRepo, "venv", "bin", "python"));

// Plain Node script linted with the TypeScript preset (see audit-production-dependencies.mjs).
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

const cmd = process.argv[2];
let code = 0;
if (cmd === "deps") {
  code = run("uv", [
    "pip",
    "install",
    "--python",
    python,
    "--target",
    join(gw, ".deps"),
    "-r",
    join(gw, "requirements.txt"),
  ]);
} else if (cmd === "test") {
  code = run(
    python,
    [
      "-c",
      "import sys; sys.path[:0]=['.deps','.']; import hy, unittest; " +
        "sys.exit(not unittest.main(module='tests.test_gateway', exit=False, argv=['t']).result.wasSuccessful())",
    ],
    { cwd: gw },
  );
} else if (cmd === "start") {
  code = run(
    python,
    [join(gw, "kotoba_gateway_main.py"), ...process.argv.slice(3)],
    {
      cwd: hermesRepo,
      env: { ...process.env, HERMES_HOME: hermesHome, HERMES_REPO: hermesRepo },
    },
  );
} else {
  console.error("usage: gateway-hy.mjs deps|test|start [--port N]");
  code = 2;
}
process.exit(code);
