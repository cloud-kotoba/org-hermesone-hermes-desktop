// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// wallet-actions' deps are faked the same way as wallet-sync.test.ts: the
// tests drive the backend-call logic without a real account, keychain, or
// network.

const mockState = vi.hoisted(() => ({
  account: null as { apiUrl: string; token: string } | null,
  linkedAgentId: null as string | null,
  linkedApiUrl: "http://localhost:3002",
  syncAgentsCalls: 0,
  linkAfterSync: null as string | null,
}));

vi.mock("./account-store", () => ({
  findAccountProfile: () => (mockState.account ? "default" : null),
  getAccount: () =>
    mockState.account
      ? {
          apiUrl: mockState.account.apiUrl,
          user: { id: "u1", email: null, name: null, avatarUrl: null },
        }
      : null,
  getAccessToken: () => mockState.account?.token ?? null,
}));

vi.mock("./hermes-account", () => ({
  apiHeaders: (json = true) =>
    json ? { "content-type": "application/json" } : {},
}));

vi.mock("./wallet-store", () => ({
  // the address this profile already controls; its key never leaves the machine
  listWallets: () => [{ id: "local-1", name: "main", address: "0xlocal" }],
}));

vi.mock("./agent-sync", () => ({
  // wallet-sync now reads the SAME account agent-sync stamps links with
  cloudAccount: () =>
    mockState.account
      ? {
          apiUrl: mockState.account.apiUrl,
          accountId: "u1",
          token: mockState.account.token,
        }
      : null,
  getLinkedAgentId: () => mockState.linkedAgentId,
  // Link owner recorded in sync state — matches the mock account ("u1") so
  // actions proceed; the legacy/foreign paths are covered in wallet-sync tests.
  getLinkedAgentAccountId: () => "u1",
  getLinkedAgentApiUrl: () => mockState.linkedApiUrl,
  syncAgents: vi.fn(async () => {
    mockState.syncAgentsCalls++;
    mockState.linkedAgentId = mockState.linkAfterSync;
    return { status: "ok", outcomes: [], finishedAt: Date.now() };
  }),
}));

interface StubCall {
  url: string;
  init?: RequestInit;
}

function stubFetch(body: unknown, ok = true, status = 200): StubCall[] {
  const calls: StubCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok, status, json: async () => body };
    }),
  );
  return calls;
}

async function engine(): Promise<typeof import("./wallet-actions")> {
  return import("./wallet-actions");
}

beforeEach(() => {
  mockState.account = { apiUrl: "http://localhost:3002", token: "tok" };
  mockState.linkedAgentId = "agent-1";
  mockState.linkedApiUrl = "http://localhost:3002";
  mockState.linkAfterSync = null;
  mockState.syncAgentsCalls = 0;
  vi.resetModules();
});

afterEach(() => vi.unstubAllGlobals());

describe("getWalletPortfolio", () => {
  it("reports signed-out without hitting the network", async () => {
    mockState.account = null;
    const calls = stubFetch({});
    const { getWalletPortfolio } = await engine();
    const result = await getWalletPortfolio("default", "wal-1");
    expect(result.status).toBe("signed-out");
    expect(calls).toHaveLength(0);
  });

  it("maps Mithril's portfolio rows to token views", async () => {
    const calls = stubFetch({
      tokens: [
        { symbol: "USDC", name: "USD Coin", balance: 12.281, balanceUsd: null },
        { symbol: "ETH", name: "Ether", balance: 0.001, balanceUsd: null },
      ],
      unread: [],
    });
    const { getWalletPortfolio } = await engine();
    const result = await getWalletPortfolio("default", "wal-1");
    expect(result.status).toBe("ok");
    expect(result.tokens?.map((t) => t.symbol)).toEqual(["USDC", "ETH"]);
    // this plane has no price oracle: unpriced is null, and the total with it
    expect(result.tokens?.every((t) => t.balanceUsd === null)).toBe(true);
    expect(result.totalUsd).toBe(null);
    expect(calls[0].url).toBe(
      "http://localhost:3002/v1/wallets/wal-1/portfolio",
    );
  });

  it("carries `unread` through instead of showing an unread row as zero", async () => {
    stubFetch({
      tokens: [
        { symbol: "ETH", name: "Ether", balance: 0.001, balanceUsd: null },
      ],
      unread: ["USDC", "WETH"],
    });
    const { getWalletPortfolio } = await engine();
    const result = await getWalletPortfolio("default", "wal-1");
    expect(result.status).toBe("ok");
    // the two that could not be read are NAMED, not listed at zero: "0" and
    // "we could not ask" are different answers about somebody's money
    expect(result.unread).toEqual(["USDC", "WETH"]);
    expect(result.tokens?.map((t) => t.symbol)).toEqual(["ETH"]);
  });

  it("defaults malformed token rows instead of crashing", async () => {
    stubFetch({ tokens: [{}] });
    const { getWalletPortfolio } = await engine();
    const result = await getWalletPortfolio("default", "wal-1");
    expect(result.status).toBe("ok");
    expect(result.tokens).toEqual([
      { symbol: "?", name: "Token", balance: 0, balanceUsd: null },
    ]);
  });

  it("surfaces the backend error string on HTTP failure", async () => {
    stubFetch({ error: "encryption_unconfigured" }, false, 503);
    const { getWalletPortfolio } = await engine();
    const result = await getWalletPortfolio("default", "wal-1");
    expect(result.status).toBe("error");
    expect(result.error).toBe("encryption_unconfigured");
  });

  it("surfaces a network failure as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const { getWalletPortfolio } = await engine();
    const result = await getWalletPortfolio("default", "wal-1");
    expect(result.status).toBe("error");
    expect(result.error).toContain("boom");
  });
});

describe("provisionAgentWallet", () => {
  it("registers the profile's local address instead of provisioning custody", async () => {
    const calls = stubFetch({
      wallet: {
        id: "wal-1",
        kind: "watch-only",
        label: "main",
        evmAddress: "0xabc",
        receiveOnly: true,
        canTransact: false,
        createdAt: new Date().toISOString(),
      },
    });
    const { provisionAgentWallet } = await engine();
    const result = await provisionAgentWallet("default");
    expect(result.status).toBe("ok");
    expect(calls[0].url).toBe("http://localhost:3002/v1/wallets");
    // the address is the LOCAL wallet's; no key and no `kind: bankr` crosses,
    // because this plane cannot hold one
    const sent = JSON.parse(String(calls[0].init?.body ?? "{}"));
    expect(sent).toMatchObject({ address: "0xlocal" });
    expect(sent.kind).toBeUndefined();
    expect(result.wallet?.canTransact).toBe(false);
  });

  it("maps the backend's 409 to status exists", async () => {
    stubFetch({ error: "already_provisioned" }, false, 409);
    const { provisionAgentWallet } = await engine();
    const result = await provisionAgentWallet("default");
    expect(result.status).toBe("exists");
  });

  it("stays unlinked when even a sync can't link the profile", async () => {
    mockState.linkedAgentId = null;
    mockState.linkAfterSync = null;
    const calls = stubFetch({});
    const { provisionAgentWallet } = await engine();
    const result = await provisionAgentWallet("default");
    expect(mockState.syncAgentsCalls).toBe(1);
    expect(result.status).toBe("unlinked");
    expect(calls).toHaveLength(0);
  });

  it("surfaces an HTTP error", async () => {
    stubFetch({}, false, 500);
    const { provisionAgentWallet } = await engine();
    const result = await provisionAgentWallet("default");
    expect(result.status).toBe("error");
    expect(result.error).toContain("500");
  });
});

describe("wallet actions backend ownership", () => {
  it("blocks both wallet provisioning and portfolio reads for another backend", async () => {
    mockState.linkedApiUrl = "http://localhost:9999";
    const calls = stubFetch({});
    const e = await engine();
    expect(await e.provisionAgentWallet("alpha")).toEqual({
      status: "foreign",
    });
    expect(await e.getWalletPortfolio("alpha", "wallet-1")).toEqual({
      status: "foreign",
    });
    expect(calls).toEqual([]);
  });
});
