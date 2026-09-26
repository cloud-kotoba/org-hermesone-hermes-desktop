// @vitest-environment node
// @lat: [[mithril-gateway#Mithril gateway#Tests]]

import { describe, expect, it, vi } from "vitest";

// electron is only needed for the window and the cookie partition; the lane
// itself is driven through the injected request function.
vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) },
  net: { request: () => ({}) },
}));

import {
  mithrilGatewayStatus,
  launchMithrilGateway,
  stopMithrilGateway,
} from "./mithril-gateway";

type Call = { url: string; method: string; origin?: string; body?: unknown };
function script(answers: Array<{ status: number; body: unknown }>): {
  request: (
    url: string,
    o?: Record<string, unknown>,
  ) => Promise<{ status: number; body: unknown }>;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queue = [...answers];
  return {
    calls,
    request: async (url, o = {}) => {
      calls.push({
        url,
        method: (o.method as string) ?? "GET",
        origin: o.origin as string | undefined,
        body: o.body,
      });
      const next = queue.shift();
      if (!next) throw new Error("no scripted answer left");
      return next;
    },
  };
}
const SESSION = "https://app.mithril.fund/v1/sandbox/session";
const READY = {
  url: "https://x--dash.modal.run/?hs=abc",
  sandboxId: "sb-1",
  status: "ready",
};

describe("mithrilGatewayStatus", () => {
  it("reads a stopped lane, a running one, and the two refusals by name", async () => {
    const s = script([
      { status: 200, body: { running: false } },
      { status: 200, body: READY },
      { status: 401, body: { error: "sign-in-required" } },
      { status: 404, body: {} },
    ]);
    expect(await mithrilGatewayStatus(s.request)).toEqual({
      running: false,
      status: "stopped",
      url: null,
      sandboxId: null,
    });
    expect(await mithrilGatewayStatus(s.request)).toEqual({
      running: true,
      status: "ready",
      url: READY.url,
      sandboxId: "sb-1",
    });
    expect(await mithrilGatewayStatus(s.request)).toMatchObject({
      running: false,
      status: "signed-out",
      error: "sign-in-required",
    });
    expect(await mithrilGatewayStatus(s.request)).toMatchObject({
      status: "unavailable",
      error: "sandbox-session-not-deployed",
    });
    expect(s.calls.every((c) => c.url === SESSION && c.method === "GET")).toBe(
      true,
    );
  });
});

describe("launchMithrilGateway", () => {
  it("POSTs with the app origin and a JSON body, and returns a ready sandbox", async () => {
    const s = script([{ status: 200, body: READY }]);
    const r = await launchMithrilGateway(s.request);
    expect(r).toEqual({
      running: true,
      status: "ready",
      url: READY.url,
      sandboxId: "sb-1",
    });
    expect(s.calls).toEqual([
      {
        url: SESSION,
        method: "POST",
        origin: "https://app.mithril.fund",
        body: {},
      },
    ]);
  });

  it("polls GET while the sandbox is starting, then hands back the url", async () => {
    const s = script([
      { status: 202, body: { status: "starting" } },
      { status: 200, body: { status: "starting" } },
      { status: 200, body: READY },
    ]);
    const slept: number[] = [];
    let t = 0;
    const r = await launchMithrilGateway(
      s.request,
      async (ms) => {
        slept.push(ms);
        t += ms;
      },
      () => t,
    );
    expect(r.status).toBe("ready");
    expect(r.url).toBe(READY.url);
    expect(slept).toEqual([5000, 5000]);
    expect(s.calls.map((c) => c.method)).toEqual(["POST", "GET", "GET"]);
  });

  it("gives up by name when starting outlasts the deadline", async () => {
    const answers = Array.from({ length: 40 }, () => ({
      status: 200,
      body: { status: "starting" },
    }));
    const s = script([
      { status: 202, body: { status: "starting" } },
      ...answers,
    ]);
    let t = 0;
    const r = await launchMithrilGateway(
      s.request,
      async (ms) => {
        t += ms;
      },
      () => t,
    );
    expect(r.status).toBe("starting");
    expect(s.calls.length).toBeLessThan(40);
  });

  it("returns a refusal by name and never polls into a second charge", async () => {
    const s = script([
      { status: 402, body: { error: "usage-limit-exceeded" } },
    ]);
    const r = await launchMithrilGateway(s.request);
    expect(r).toMatchObject({
      running: false,
      status: "refused",
      error: "usage-limit-exceeded",
    });
    expect(s.calls.length).toBe(1);
  });

  it("throws sign-in-required on a 401 so the card can offer the Passkey window", async () => {
    const s = script([{ status: 401, body: { error: "sign-in-required" } }]);
    await expect(launchMithrilGateway(s.request)).rejects.toMatchObject({
      code: "sign-in-required",
    });
  });
});

describe("stopMithrilGateway", () => {
  it("DELETEs with the app origin; a refusal comes back by name", async () => {
    const s = script([
      { status: 200, body: { running: false } },
      { status: 503, body: { error: "sandbox-gateway-unavailable" } },
    ]);
    expect(await stopMithrilGateway(s.request)).toEqual({ stopped: true });
    expect(await stopMithrilGateway(s.request)).toEqual({
      stopped: false,
      error: "sandbox-gateway-unavailable",
    });
    expect(s.calls[0]).toMatchObject({
      method: "DELETE",
      origin: "https://app.mithril.fund",
    });
  });
});
