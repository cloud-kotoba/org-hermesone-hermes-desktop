// @vitest-environment node
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const { home } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { mkdtempSync } = require("fs");
  const { tmpdir } = require("os");
  const path = require("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    home: mkdtempSync(path.join(tmpdir(), "kotoba-token-scan-")) as string,
  };
});

vi.mock("./installer", () => ({ HERMES_HOME: home }));
// The scan only reads files; the migration's side effects are not exercised.
vi.mock("./config", () => ({
  KOTOBA_PLAINTEXT_WARNING: "plaintext",
  readEnv: () => ({}),
  readEnvFile: () => ({}),
  removeEnvKey: () => {},
  secureEnvWarning: () => undefined,
  setSecureEnvWarning: () => {},
  setEnvValue: () => {},
  readDesktopConfig: () => ({}),
  writeDesktopConfig: () => {},
}));
vi.mock("./kotoba-cloud-token-store", () => ({
  hasStoredKotobaToken: () => false,
  kotobaSecureStorageAvailable: () => true,
  readStoredKotobaToken: () => null,
  writeStoredKotobaToken: () => {},
}));
vi.mock("./agent-config-providers", () => ({
  mirrorFirstPartyAgentProviders: () => {},
}));

import { profilesWithPlaintextKotobaToken } from "./kotoba-cloud-account";

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("startup token scan", () => {
  // @lat: [[profile-distribution#Desktop relief#Tests#Startup token scan is async and selective]]
  it("finds only the profiles whose .env holds a plaintext token", async () => {
    writeFileSync(join(home, ".env"), "OPENAI_API_KEY=x\n");
    for (const [name, env] of [
      ["clean", "FOO=bar\n"],
      ["leaky", "FOO=bar\nexport KOTOBA_API_KEY=kc_pat_example\n"],
      ["noenv", null],
    ] as const) {
      mkdirSync(join(home, "profiles", name), { recursive: true });
      if (env) writeFileSync(join(home, "profiles", name, ".env"), env);
    }
    expect(await profilesWithPlaintextKotobaToken()).toEqual(["leaky"]);
  });
});
