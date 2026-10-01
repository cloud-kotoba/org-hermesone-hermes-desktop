// @vitest-environment node
// @lat: [[kotoba-cloud-account#Kotoba Cloud account#Tests]]
//
// The Kotoba Cloud token at rest, end to end on a real profile tree: the real
// config.ts (readEnv / setEnvValue / secureSpawnEnv), the real encrypted
// store, and the startup migration — with a reversible fake keychain.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keychain = vi.hoisted(() => ({
  available: true,
  // when set, decrypt returns this instead (a keychain that won't read back)
  decryptOverride: null as string | null,
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, "utf-8"),
    decryptString: (buf: Buffer) =>
      keychain.decryptOverride ?? buf.toString("utf-8").replace(/^enc:/, ""),
  },
}));

const TOKEN = "kc_pat_urn:kotoba:principal:0123.d5cc449fa4d5.abcdefMAC";
const OTHER = "kc_pat_urn:kotoba:principal:0123.aaaaaaaaaaaa.otherMAC";

let home: string;

async function load(): Promise<{
  config: typeof import("./config");
  account: typeof import("./kotoba-cloud-account");
  store: typeof import("./kotoba-cloud-token-store");
}> {
  vi.resetModules();
  vi.stubEnv("HERMES_HOME", home);
  return {
    config: await import("./config"),
    account: await import("./kotoba-cloud-account"),
    store: await import("./kotoba-cloud-token-store"),
  };
}

function envPath(profile?: string): string {
  return profile ? join(home, "profiles", profile, ".env") : join(home, ".env");
}
function writeEnv(content: string, profile?: string): void {
  const p = envPath(profile);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}
const envText = (profile?: string): string =>
  existsSync(envPath(profile)) ? readFileSync(envPath(profile), "utf-8") : "";
const storeFile = (profile?: string): string =>
  profile
    ? join(home, "profiles", profile, "kotoba-cloud-token.json")
    : join(home, "kotoba-cloud-token.json");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kotoba-token-"));
  keychain.available = true;
  keychain.decryptOverride = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("startup migration", () => {
  it("moves a plaintext token into the keychain and removes the .env line, for every profile", async () => {
    writeEnv(`OPENAI_API_KEY=sk-1\nKOTOBA_API_KEY=${TOKEN}\n`);
    writeEnv(`KOTOBA_API_KEY=${OTHER}\n`, "work");
    const { account, config } = await load();

    expect(account.migrateKotobaTokensToKeychain()).toEqual({
      default: "migrated",
      work: "migrated",
    });
    expect(envText()).not.toContain("KOTOBA_API_KEY");
    expect(envText()).toContain("OPENAI_API_KEY=sk-1");
    expect(envText("work")).not.toContain("KOTOBA_API_KEY");
    // ciphertext only on disk
    expect(readFileSync(storeFile(), "utf-8")).not.toContain(TOKEN);
    expect(config.readEnv().KOTOBA_API_KEY).toBe(TOKEN);
    expect(config.readEnv("work").KOTOBA_API_KEY).toBe(OTHER);
  });

  it("is idempotent: a second run finds nothing to move and changes nothing", async () => {
    writeEnv(`KOTOBA_API_KEY=${TOKEN}\n`);
    const { account, config } = await load();
    account.migrateKotobaTokensToKeychain();
    const after = readFileSync(storeFile(), "utf-8");

    expect(account.migrateKotobaTokensToKeychain()).toEqual({});
    expect(readFileSync(storeFile(), "utf-8")).toBe(after);
    expect(config.readEnv().KOTOBA_API_KEY).toBe(TOKEN);
  });

  it("a plaintext token that differs from the stored one replaces it", async () => {
    writeEnv(`KOTOBA_API_KEY=${TOKEN}\n`);
    const { account, store } = await load();
    store.writeStoredKotobaToken(undefined, OTHER);

    expect(account.migrateKotobaTokensToKeychain()).toEqual({
      default: "replaced-stored",
    });
    expect(store.readStoredKotobaToken(undefined)).toBe(TOKEN);
  });

  it("keeps the .env token and records a warning when the keychain is unavailable", async () => {
    keychain.available = false;
    writeEnv(`KOTOBA_API_KEY=${TOKEN}\n`);
    const { account, config } = await load();

    expect(account.migrateKotobaTokensToKeychain()).toEqual({
      default: "kept-plaintext",
    });
    expect(envText()).toContain(`KOTOBA_API_KEY=${TOKEN}`);
    expect(existsSync(storeFile())).toBe(false);
    expect(config.readEnv().KOTOBA_API_KEY).toBe(TOKEN);
    expect(config.secureEnvWarning()).toBe(config.KOTOBA_PLAINTEXT_WARNING);
    expect(account.kotobaTokenStorage()).toEqual({
      storage: "plaintext",
      storageWarning: config.KOTOBA_PLAINTEXT_WARNING,
    });
  });

  it("keeps the .env token when the keychain encrypts but does not read back", async () => {
    keychain.decryptOverride = "garbage";
    writeEnv(`KOTOBA_API_KEY=${TOKEN}\n`);
    const { account, config } = await load();

    expect(account.migrateKotobaTokensToKeychain()).toEqual({
      default: "failed-kept-plaintext",
    });
    expect(envText()).toContain(`KOTOBA_API_KEY=${TOKEN}`);
    expect(config.readEnv().KOTOBA_API_KEY).toBe(TOKEN);
  });
});

describe("read and write paths", () => {
  it("setEnvValue(KOTOBA_API_KEY) writes the keychain, never .env; readEnv and the spawn env carry it", async () => {
    writeEnv("OPENAI_API_KEY=sk-1\n");
    const { config, account } = await load();

    config.setEnvValue("KOTOBA_API_KEY", TOKEN);
    expect(envText()).not.toContain("KOTOBA_API_KEY");
    expect(config.readEnvFile().KOTOBA_API_KEY).toBeUndefined();
    expect(config.readEnv().KOTOBA_API_KEY).toBe(TOKEN);
    expect(config.secureSpawnEnv()).toEqual({ KOTOBA_API_KEY: TOKEN });
    expect(account.kotobaCloudToken()).toBe(TOKEN);
    expect(account.kotobaTokenStorage()).toEqual({ storage: "keychain" });
  });

  it("an empty write clears the keychain entry and any plaintext line", async () => {
    writeEnv(`KOTOBA_API_KEY=${OTHER}\n`);
    const { config, account } = await load();
    config.setEnvValue("KOTOBA_API_KEY", TOKEN);
    config.setEnvValue("KOTOBA_API_KEY", "");

    expect(existsSync(storeFile())).toBe(false);
    expect(envText()).not.toContain("KOTOBA_API_KEY");
    expect(account.kotobaCloudToken()).toBeNull();
    expect(config.secureSpawnEnv()).toEqual({});
  });

  it("falls back to plaintext .env with a warning when the keychain is unavailable", async () => {
    keychain.available = false;
    const { config } = await load();
    config.setEnvValue("KOTOBA_API_KEY", TOKEN);

    expect(envText()).toContain(`KOTOBA_API_KEY=${TOKEN}`);
    expect(config.readEnv().KOTOBA_API_KEY).toBe(TOKEN);
    expect(config.secureEnvWarning()).toBe(config.KOTOBA_PLAINTEXT_WARNING);
  });

  it("other keys still go to .env untouched", async () => {
    const { config } = await load();
    config.setEnvValue("OPENAI_API_KEY", "sk-2");
    expect(envText()).toContain("OPENAI_API_KEY=sk-2");
    expect(existsSync(storeFile())).toBe(false);
  });

  it("a corrupt store file reads as no token, not a crash", async () => {
    writeFileSync(storeFile(), "{not json");
    const { config, store } = await load();
    expect(store.readStoredKotobaToken(undefined)).toBeNull();
    expect(config.readEnv().KOTOBA_API_KEY).toBeUndefined();
  });
});
