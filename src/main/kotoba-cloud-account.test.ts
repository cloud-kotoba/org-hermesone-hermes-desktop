// @vitest-environment node
// @lat: [[kotoba-cloud-account#Kotoba Cloud account#Tests]]

import { beforeEach, describe, expect, it, vi } from "vitest";

// config.ts reaches for electron + the installer; the account module needs
// only readEnv / setEnvValue, so those two are an in-memory .env here.
const env: Record<string, string> = {};
vi.mock("./config", () => ({
  readEnv: () => ({ ...env }),
  setEnvValue: (key: string, value: string) => {
    env[key] = value;
  },
}));
const mirrored: unknown[] = [];
vi.mock("./agent-config-providers", () => ({
  mirrorFirstPartyAgentProviders: (profile?: string) => {
    mirrored.push(profile);
  },
}));

import {
  connectKotobaCloud,
  disconnectKotobaCloud,
  kotobaCloudAccount,
  kotobaTokenId,
  verifyKotobaCloudToken,
} from "./kotoba-cloud-account";

const TOKEN = "kc_pat_urn:kotoba:principal:0123.d5cc449fa4d5.abcdefMAC";

function answer(status: number, body: unknown): typeof fetch {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ url: String(url), auth: headers?.authorization });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  (f as unknown as { calls: typeof calls }).calls = calls;
  return f;
}
const callsOf = (f: typeof fetch): Array<{ url: string; auth?: string }> =>
  (f as unknown as { calls: Array<{ url: string; auth?: string }> }).calls;

beforeEach(() => {
  for (const k of Object.keys(env)) delete env[k];
  mirrored.length = 0;
});

describe("kotobaTokenId", () => {
  it("reads the 12-hex id out of a kc_pat_ token and nothing else", () => {
    expect(kotobaTokenId(TOKEN)).toBe("d5cc449fa4d5");
    expect(kotobaTokenId("hs-live-abc")).toBeNull();
    expect(kotobaTokenId("kc_pat_x.notahexid.mac")).toBeNull();
    expect(kotobaTokenId("")).toBeNull();
  });
});

describe("verifyKotobaCloudToken", () => {
  it("asks /v1/billing/status with the bearer and reads the ai balance", async () => {
    const f = answer(200, {
      balances: [
        { scope: "storage", availableMicroUSD: 999 },
        { scope: "ai", availableMicroUSD: 12_340_000 },
      ],
    });
    const r = await verifyKotobaCloudToken(TOKEN, f);
    expect(r).toEqual({ ok: true, balance: 12.34 });
    expect(callsOf(f)).toEqual([
      {
        url: "https://kotoba.cloud/v1/billing/status",
        auth: `Bearer ${TOKEN}`,
      },
    ]);
  });

  it("names a revoked token by the server's word, not as a generic failure", async () => {
    const r = await verifyKotobaCloudToken(
      TOKEN,
      answer(401, { error: "token-revoked" }),
    );
    expect(r).toEqual({ ok: false, error: "token-revoked" });
  });

  it("keeps a live token that cannot read billing, with the balance unknown", async () => {
    const r = await verifyKotobaCloudToken(
      TOKEN,
      answer(403, { error: "scope-refused:billing:read" }),
    );
    expect(r).toEqual({
      ok: true,
      balance: null,
      scopeMissing: "scope-refused:billing:read",
    });
  });

  it("reports an unreachable kotoba.cloud as unreachable", async () => {
    const f = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const r = await verifyKotobaCloudToken(TOKEN, f);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error).toMatch(
        /Couldn't reach https:\/\/kotoba.cloud: ENOTFOUND/,
      );
  });
});

describe("connectKotobaCloud", () => {
  it("stores a verified token as KOTOBA_API_KEY and mirrors the agent provider", async () => {
    const r = await connectKotobaCloud(
      `  ${TOKEN}\n`,
      "work",
      answer(200, {
        balances: [{ scope: "ai", availableMicroUSD: 5_000_000 }],
      }),
    );
    expect(r).toEqual({
      status: "connected",
      account: {
        tokenId: "d5cc449fa4d5",
        accountUrl: "https://kotoba.cloud/account",
        live: true,
        balance: 5,
        error: undefined,
      },
    });
    expect(env.KOTOBA_API_KEY).toBe(TOKEN);
    expect(mirrored).toEqual(["work"]);
  });

  it("refuses a token the server refuses and stores nothing", async () => {
    const r = await connectKotobaCloud(
      TOKEN,
      undefined,
      answer(401, { error: "sign-in-required" }),
    );
    expect(r).toEqual({ status: "refused", error: "sign-in-required" });
    expect(env.KOTOBA_API_KEY).toBeUndefined();
    expect(mirrored).toEqual([]);
  });

  it("rejects a non-kc_pat_ string before any network call", async () => {
    const f = answer(200, {});
    const r = await connectKotobaCloud("hs-live-upstream", undefined, f);
    expect(r.status).toBe("invalid");
    expect(callsOf(f)).toEqual([]);
    expect(env.KOTOBA_API_KEY).toBeUndefined();
  });
});

describe("kotobaCloudAccount", () => {
  it("is null with no token, and re-verifies a stored one on every read", async () => {
    expect(await kotobaCloudAccount(undefined, answer(200, {}))).toBeNull();
    env.KOTOBA_API_KEY = TOKEN;
    const live = await kotobaCloudAccount(
      undefined,
      answer(200, { balances: [{ scope: "ai", availableMicroUSD: 0 }] }),
    );
    expect(live).toEqual({
      tokenId: "d5cc449fa4d5",
      accountUrl: "https://kotoba.cloud/account",
      live: true,
      balance: 0,
      error: undefined,
    });
    const dead = await kotobaCloudAccount(
      undefined,
      answer(401, { error: "token-revoked" }),
    );
    expect(dead).toMatchObject({
      live: false,
      balance: null,
      error: "token-revoked",
    });
  });

  it("disconnect empties the key so the provider card reads it as unset", () => {
    env.KOTOBA_API_KEY = TOKEN;
    expect(disconnectKotobaCloud("work")).toEqual({ success: true });
    expect(env.KOTOBA_API_KEY).toBe("");
  });
});
