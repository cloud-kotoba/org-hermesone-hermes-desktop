// @vitest-environment node
// @lat: [[mithril-account#Mithril account#Tests]]

import { beforeEach, describe, expect, it, vi } from "vitest";

// config.ts reaches for electron + the installer; the account module needs
// only its env accessors and the desktop settings, so those are in-memory
// here (`env` is the resolved view — keychain store or .env alike; the
// storage split itself is mithril-token-store.test.ts's job).
const env: Record<string, string> = {};
const desktop: Record<string, unknown> = {};
vi.mock("./config", () => ({
  MITHRIL_PLAINTEXT_WARNING: "plaintext",
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
vi.mock("./mithril-token-store", () => ({
  hasStoredMithrilToken: () => false,
  mithrilSecureStorageAvailable: () => true,
  readStoredMithrilToken: () => null,
  writeStoredMithrilToken: () => {},
}));
const mirrored: unknown[] = [];
vi.mock("./agent-config-providers", () => ({
  mirrorFirstPartyAgentProviders: (profile?: string) => {
    mirrored.push(profile);
  },
}));

import {
  connectMithril,
  disconnectMithril,
  mithrilAccount,
  mithrilTokenId,
  verifyMithrilToken,
} from "./mithril-account";
import {
  fetchMithrilOrgMemberships,
  getMithrilOrgSelection,
  mithrilManageUrl,
  setMithrilOrgSelection,
} from "./mithril-orgs";

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

describe("mithrilTokenId", () => {
  it("reads the 12-hex id out of a kc_pat_ token and nothing else", () => {
    expect(mithrilTokenId(TOKEN)).toBe("d5cc449fa4d5");
    expect(mithrilTokenId("hs-live-abc")).toBeNull();
    expect(mithrilTokenId("kc_pat_x.notahexid.mac")).toBeNull();
    expect(mithrilTokenId("")).toBeNull();
  });
});

describe("verifyMithrilToken", () => {
  it("asks /v1/billing/status with the bearer and reads the ai balance", async () => {
    const f = answer(200, {
      balances: [
        { scope: "storage", availableMicroUSD: 999 },
        { scope: "ai", availableMicroUSD: 12_340_000 },
      ],
    });
    const r = await verifyMithrilToken(TOKEN, f);
    expect(r).toEqual({ ok: true, balance: 12.34 });
    expect(callsOf(f)).toEqual([
      {
        url: "https://mithril.fund/v1/billing/status",
        auth: `Bearer ${TOKEN}`,
      },
    ]);
  });

  it("names a revoked token by the server's word, not as a generic failure", async () => {
    const r = await verifyMithrilToken(
      TOKEN,
      answer(401, { error: "token-revoked" }),
    );
    expect(r).toEqual({ ok: false, error: "token-revoked" });
  });

  it("keeps a live token that cannot read billing, with the balance unknown", async () => {
    const r = await verifyMithrilToken(
      TOKEN,
      answer(403, { error: "scope-refused:billing:read" }),
    );
    expect(r).toEqual({
      ok: true,
      balance: null,
      refusal: "scope-refused:billing:read",
    });
  });

  it("reports an unreachable mithril.fund as unreachable", async () => {
    const f = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const r = await verifyMithrilToken(TOKEN, f);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error).toMatch(
        /Couldn't reach https:\/\/mithril.fund: ENOTFOUND/,
      );
  });
});

describe("connectMithril", () => {
  it("stores a verified token as KOTOBA_API_KEY and mirrors the agent provider", async () => {
    const r = await connectMithril(
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
        accountUrl: "https://console.mithril.fund/account",
        live: true,
        balance: 5,
        error: undefined,
        org: null,
        manageUrl: "https://console.mithril.fund/account",
        storage: "keychain",
      },
    });
    expect(env.KOTOBA_API_KEY).toBe(TOKEN);
    expect(mirrored).toEqual(["work"]);
  });

  it("refuses a token the server refuses and stores nothing", async () => {
    const r = await connectMithril(
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
    const r = await connectMithril("hs-live-upstream", undefined, f);
    expect(r.status).toBe("invalid");
    expect(callsOf(f)).toEqual([]);
    expect(env.KOTOBA_API_KEY).toBeUndefined();
  });
});

describe("mithrilAccount", () => {
  it("is null with no token, and re-verifies a stored one on every read", async () => {
    expect(await mithrilAccount(undefined, answer(200, {}))).toBeNull();
    env.KOTOBA_API_KEY = TOKEN;
    const live = await mithrilAccount(
      undefined,
      answer(200, { balances: [{ scope: "ai", availableMicroUSD: 0 }] }),
    );
    expect(live).toEqual({
      tokenId: "d5cc449fa4d5",
      accountUrl: "https://console.mithril.fund/account",
      live: true,
      balance: 0,
      error: undefined,
      org: null,
      manageUrl: "https://console.mithril.fund/account",
      storage: "keychain",
    });
    const dead = await mithrilAccount(
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
    setMithrilOrgSelection("work", "acme");
    expect(disconnectMithril("work")).toEqual({ success: true });
    expect(env.KOTOBA_API_KEY).toBe("");
    // the next account may not be in the same organizations
    expect(getMithrilOrgSelection("work")).toBeNull();
  });

  it("reads the selected organization's ledger with ?org= and links its manage page", async () => {
    env.KOTOBA_API_KEY = TOKEN;
    setMithrilOrgSelection(undefined, "acme");
    const f = answer(200, {
      balances: [{ scope: "ai", availableMicroUSD: 7_500_000 }],
    });
    const a = await mithrilAccount(undefined, f);
    expect(callsOf(f)[0].url).toBe(
      "https://mithril.fund/v1/billing/status?org=acme",
    );
    expect(a).toMatchObject({
      live: true,
      balance: 7.5,
      org: "acme",
      manageUrl: "https://console.mithril.fund/account?org=acme",
    });
  });

  it("a role that cannot read the org ledger stays live with the balance unknown", async () => {
    env.KOTOBA_API_KEY = TOKEN;
    setMithrilOrgSelection(undefined, "acme");
    const a = await mithrilAccount(
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
    const r = await fetchMithrilOrgMemberships(TOKEN, f);
    expect(callsOf(f)).toEqual([
      {
        url: "https://mithril.fund/v1/org/memberships",
        auth: `Bearer ${TOKEN}`,
      },
    ]);
    expect(r).toEqual({ status: "ok", orgs: ORGS.orgs });
  });

  it("an empty list is 'no organizations', distinct from every refusal", async () => {
    expect(
      await fetchMithrilOrgMemberships(TOKEN, answer(200, { orgs: [] })),
    ).toEqual({ status: "ok", orgs: [] });
  });

  it("a token without org:read reads as reconnect, not as an empty list or an error", async () => {
    expect(
      await fetchMithrilOrgMemberships(
        TOKEN,
        answer(403, { error: { code: "token-scope-insufficient" } }),
      ),
    ).toEqual({ status: "reconnect" });
  });

  it("a server without the route (404) reads as unavailable", async () => {
    expect(
      await fetchMithrilOrgMemberships(
        TOKEN,
        answer(404, { error: "not-found" }),
      ),
    ).toEqual({ status: "unavailable" });
  });

  it("anything else is an error that names the server's code; no token is signed-out", async () => {
    expect(
      await fetchMithrilOrgMemberships(
        TOKEN,
        answer(401, { error: "token-revoked" }),
      ),
    ).toEqual({ status: "error", error: "token-revoked" });
    expect(
      await fetchMithrilOrgMemberships(TOKEN, answer(200, { nope: 1 })),
    ).toEqual({ status: "error", error: "malformed-response" });
    expect(await fetchMithrilOrgMemberships(null, answer(200, ORGS))).toEqual({
      status: "signed-out",
    });
  });

  it("drops rows whose handle could not be sent back safely", async () => {
    const r = await fetchMithrilOrgMemberships(
      TOKEN,
      answer(200, {
        orgs: [{ handle: "../x", role: "owner", memberCount: 1 }, ORGS.orgs[0]],
      }),
    );
    expect(r).toEqual({ status: "ok", orgs: [ORGS.orgs[0]] });
  });

  it("persists the selection per profile and refuses a malformed handle", () => {
    expect(getMithrilOrgSelection("work")).toBeNull();
    setMithrilOrgSelection("work", "acme");
    expect(getMithrilOrgSelection("work")).toBe("acme");
    expect(getMithrilOrgSelection(undefined)).toBeNull();
    setMithrilOrgSelection("work", null);
    expect(getMithrilOrgSelection("work")).toBeNull();
    expect(() => setMithrilOrgSelection("work", "a/b")).toThrow();
  });

  it("manage opens the account console, with ?org= for an organization", () => {
    expect(mithrilManageUrl(null)).toBe("https://console.mithril.fund/account");
    expect(mithrilManageUrl("acme")).toBe(
      "https://console.mithril.fund/account?org=acme",
    );
  });
});
