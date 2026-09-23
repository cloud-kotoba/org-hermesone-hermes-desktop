// @vitest-environment node
// @lat: [[kotoba-cloud-account#Kotoba Cloud account#Tests]]

import { beforeEach, describe, expect, it, vi } from "vitest";

// config.ts reaches for electron + the installer; the account module needs
// only its env accessors and the desktop settings, so those are in-memory
// here (`env` is the resolved view — keychain store or .env alike; the
// storage split itself is kotoba-cloud-token-store.test.ts's job).
const env: Record<string, string> = {};
const desktop: Record<string, unknown> = {};
vi.mock("./config", () => ({
  KOTOBA_PLAINTEXT_WARNING: "plaintext",
  readEnv: () => ({ ...env }),
  readEnvFile: () => ({}),
  removeEnvKey: () => {},
  secureEnvWarning: () => undefined,
  setSecureEnvWarning: () => {},
  setEnvValue: (key: string, value: string) => {
    env[key] = value;
  },
  readDesktopConfig: () => ({ ...desktop }),
  writeDesktopConfig: (data: Record<string, unknown>) => {
    for (const k of Object.keys(desktop)) delete desktop[k];
    Object.assign(desktop, data);
  },
}));
vi.mock("./installer", () => ({ HERMES_HOME: "/nonexistent-hermes-home" }));
vi.mock("./kotoba-cloud-token-store", () => ({
  hasStoredKotobaToken: () => false,
  kotobaSecureStorageAvailable: () => true,
  readStoredKotobaToken: () => null,
  writeStoredKotobaToken: () => {},
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
import {
  fetchKotobaOrgMemberships,
  getKotobaOrgSelection,
  kotobaCloudManageUrl,
  setKotobaOrgSelection,
} from "./kotoba-cloud-orgs";

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
  for (const k of Object.keys(desktop)) delete desktop[k];
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
      refusal: "scope-refused:billing:read",
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
        org: null,
        manageUrl: "https://kotoba.cloud/account",
        storage: "keychain",
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
      org: null,
      manageUrl: "https://kotoba.cloud/account",
      storage: "keychain",
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
    setKotobaOrgSelection("work", "acme");
    expect(disconnectKotobaCloud("work")).toEqual({ success: true });
    expect(env.KOTOBA_API_KEY).toBe("");
    // the next account may not be in the same organizations
    expect(getKotobaOrgSelection("work")).toBeNull();
  });

  it("reads the selected organization's ledger with ?org= and links its manage page", async () => {
    env.KOTOBA_API_KEY = TOKEN;
    setKotobaOrgSelection(undefined, "acme");
    const f = answer(200, {
      balances: [{ scope: "ai", availableMicroUSD: 7_500_000 }],
    });
    const a = await kotobaCloudAccount(undefined, f);
    expect(callsOf(f)[0].url).toBe(
      "https://kotoba.cloud/v1/billing/status?org=acme",
    );
    expect(a).toMatchObject({
      live: true,
      balance: 7.5,
      org: "acme",
      manageUrl: "https://kotoba.cloud/account?org=acme",
    });
  });

  it("a role that cannot read the org ledger stays live with the balance unknown", async () => {
    env.KOTOBA_API_KEY = TOKEN;
    setKotobaOrgSelection(undefined, "acme");
    const a = await kotobaCloudAccount(
      undefined,
      answer(403, { error: "org-role-insufficient" }),
    );
    expect(a).toMatchObject({
      live: true,
      balance: null,
      error: "org-role-insufficient",
      org: "acme",
    });
  });
});

describe("organization switcher", () => {
  const ORGS = {
    orgs: [
      {
        handle: "acme",
        did: "did:web:acme",
        role: "owner",
        plan: "team",
        seatLimit: 10,
        memberCount: 3,
      },
      {
        handle: "lab",
        did: "did:web:lab",
        role: "member",
        plan: null,
        seatLimit: null,
        memberCount: 12,
      },
    ],
  };

  it("reads memberships with the bearer and keeps the contract's fields", async () => {
    const f = answer(200, ORGS);
    const r = await fetchKotobaOrgMemberships(TOKEN, f);
    expect(callsOf(f)).toEqual([
      {
        url: "https://kotoba.cloud/v1/org/memberships",
        auth: `Bearer ${TOKEN}`,
      },
    ]);
    expect(r).toEqual({ status: "ok", orgs: ORGS.orgs });
  });

  it("an empty list is 'no organizations', distinct from every refusal", async () => {
    expect(
      await fetchKotobaOrgMemberships(TOKEN, answer(200, { orgs: [] })),
    ).toEqual({ status: "ok", orgs: [] });
  });

  it("a token without org:read reads as reconnect, not as an empty list or an error", async () => {
    expect(
      await fetchKotobaOrgMemberships(
        TOKEN,
        answer(403, { error: { code: "token-scope-insufficient" } }),
      ),
    ).toEqual({ status: "reconnect" });
  });

  it("a server without the route (404) reads as unavailable", async () => {
    expect(
      await fetchKotobaOrgMemberships(
        TOKEN,
        answer(404, { error: "not-found" }),
      ),
    ).toEqual({ status: "unavailable" });
  });

  it("anything else is an error that names the server's code; no token is signed-out", async () => {
    expect(
      await fetchKotobaOrgMemberships(
        TOKEN,
        answer(401, { error: "token-revoked" }),
      ),
    ).toEqual({ status: "error", error: "token-revoked" });
    expect(
      await fetchKotobaOrgMemberships(TOKEN, answer(200, { nope: 1 })),
    ).toEqual({ status: "error", error: "malformed-response" });
    expect(await fetchKotobaOrgMemberships(null, answer(200, ORGS))).toEqual({
      status: "signed-out",
    });
  });

  it("drops rows whose handle could not be sent back safely", async () => {
    const r = await fetchKotobaOrgMemberships(
      TOKEN,
      answer(200, {
        orgs: [{ handle: "../x", role: "owner", memberCount: 1 }, ORGS.orgs[0]],
      }),
    );
    expect(r).toEqual({ status: "ok", orgs: [ORGS.orgs[0]] });
  });

  it("persists the selection per profile and refuses a malformed handle", () => {
    expect(getKotobaOrgSelection("work")).toBeNull();
    setKotobaOrgSelection("work", "acme");
    expect(getKotobaOrgSelection("work")).toBe("acme");
    expect(getKotobaOrgSelection(undefined)).toBeNull();
    setKotobaOrgSelection("work", null);
    expect(getKotobaOrgSelection("work")).toBeNull();
    expect(() => setKotobaOrgSelection("work", "a/b")).toThrow();
  });

  it("manage opens the account console, with ?org= for an organization", () => {
    expect(kotobaCloudManageUrl(null)).toBe("https://kotoba.cloud/account");
    expect(kotobaCloudManageUrl("acme")).toBe(
      "https://kotoba.cloud/account?org=acme",
    );
  });
});
