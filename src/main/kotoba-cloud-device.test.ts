// @vitest-environment node
// @lat: [[kotoba-cloud-account#Kotoba Cloud account#Device sign-in]]

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  session: { fromPartition: () => ({}) },
  net: { request: () => ({}) },
}));

import {
  DEVICE_SCOPES,
  pollDeviceGrant,
  startDeviceGrant,
  type DeviceGrant,
} from "./kotoba-cloud-device";

type Answer = { status: number; body: unknown };
function script(answers: Answer[]): {
  request: (
    url: string,
    o?: Record<string, unknown>,
  ) => Promise<{ status: number; body: unknown }>;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  const queue = [...answers];
  return {
    calls,
    request: async (url, o = {}) => {
      calls.push({ url, body: o.body });
      const next = queue.shift();
      if (!next) throw new Error("no scripted answer left");
      return next;
    },
  };
}

const START = {
  device_code: "d".repeat(64),
  user_code: "ABCD-EFGH",
  verification_uri: "https://kotoba.cloud/account/device",
  verification_uri_complete:
    "https://kotoba.cloud/account/device?user_code=ABCD-EFGH",
  expires_in: 600,
  interval: 5,
};

describe("startDeviceGrant", () => {
  it("asks for exactly the desktop's scopes and names the machine", async () => {
    const s = script([{ status: 200, body: START }]);
    const g = await startDeviceGrant(s.request, () => 1_000);
    expect(s.calls[0].url).toBe("https://kotoba.cloud/v1/account/device/code");
    const body = s.calls[0].body as { scope: string; device_name: string };
    expect(body.scope.split(" ")).toEqual([...DEVICE_SCOPES]);
    expect(body.scope).toContain("sandbox");
    expect(body.scope).not.toContain("account");
    expect(body.device_name).toMatch(/^Kotoba desktop · /);
    expect(g).toEqual({
      deviceCode: START.device_code,
      userCode: "ABCD-EFGH",
      verificationUri: START.verification_uri,
      verificationUriComplete: START.verification_uri_complete,
      interval: 5,
      expiresAt: 601_000,
    });
  });

  it("throws the server's refusal by name, and refuses a non-https approval URL", async () => {
    await expect(
      startDeviceGrant(
        script([{ status: 400, body: { error: "invalid_scope" } }]).request,
      ),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(
      startDeviceGrant(
        script([
          {
            status: 200,
            body: {
              ...START,
              verification_uri_complete: "http://evil.example/?user_code=x",
            },
          },
        ]).request,
      ),
    ).rejects.toMatchObject({ code: "request-failed" });
  });
});

describe("pollDeviceGrant", () => {
  const grant: DeviceGrant = {
    deviceCode: "d".repeat(64),
    userCode: "ABCD-EFGH",
    verificationUri: START.verification_uri,
    verificationUriComplete: START.verification_uri_complete,
    interval: 5,
    expiresAt: 1_000_000,
  };

  it("waits through pending, backs off on slow_down, and returns the token", async () => {
    const s = script([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: { access_token: "kc_pat_x.aaaaaaaaaaaa.m" } },
    ]);
    const slept: number[] = [];
    const token = await pollDeviceGrant(grant, {
      request: s.request,
      sleep: async (ms) => {
        slept.push(ms);
      },
      now: () => 0,
    });
    expect(token).toBe("kc_pat_x.aaaaaaaaaaaa.m");
    expect(slept).toEqual([5_000, 5_000, 10_000, 10_000]);
    expect(
      s.calls.every((c) => c.url.endsWith("/v1/account/device/token")),
    ).toBe(true);
    expect(s.calls[0].body).toEqual({ device_code: grant.deviceCode });
  });

  it("names denial, expiry and cancellation", async () => {
    const opts = { sleep: async () => {}, now: () => 0 };
    await expect(
      pollDeviceGrant(grant, {
        ...opts,
        request: script([{ status: 400, body: { error: "access_denied" } }])
          .request,
      }),
    ).rejects.toMatchObject({ code: "access_denied" });
    await expect(
      pollDeviceGrant(grant, {
        ...opts,
        request: script([{ status: 400, body: { error: "expired_token" } }])
          .request,
      }),
    ).rejects.toMatchObject({ code: "expired_token" });
    // the local clock passing expiresAt stops polling without a request
    const none = script([]);
    await expect(
      pollDeviceGrant(grant, {
        ...opts,
        request: none.request,
        now: () => 2_000_000,
      }),
    ).rejects.toMatchObject({ code: "expired_token" });
    expect(none.calls).toHaveLength(0);
    await expect(
      pollDeviceGrant(grant, {
        ...opts,
        request: none.request,
        cancelled: () => true,
      }),
    ).rejects.toMatchObject({ code: "sign-in-cancelled" });
  });
});
