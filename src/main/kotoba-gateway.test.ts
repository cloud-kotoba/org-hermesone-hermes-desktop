import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/repo" },
}));
vi.mock("./utils", () => ({
  profileHome: (profile?: string) =>
    profile ? `/home/.hermes/profiles/${profile}` : "/home/.hermes",
}));

import {
  gatewayRuntime,
  kotobaGatewayArgs,
  kotobaGatewayEnv,
  kotobaGatewayPidPath,
} from "./kotoba-gateway";

describe("kotoba Hy gateway", () => {
  // @lat: [[gateway-hy#Tests#Runtime defaults to hy]]
  it("defaults to the Hy runtime and honours KOTOBA_GATEWAY_RUNTIME=hermes", () => {
    expect(gatewayRuntime({})).toBe("hy");
    expect(gatewayRuntime({ KOTOBA_GATEWAY_RUNTIME: "HERMES" })).toBe("hermes");
    expect(gatewayRuntime({ KOTOBA_GATEWAY_RUNTIME: "bogus" })).toBe("hy");
  });

  // @lat: [[gateway-hy#Tests#Spawn uses its own pid file per profile]]
  it("spawns the launcher with port and a per-profile pid file", () => {
    expect(kotobaGatewayPidPath("work")).toBe(
      "/home/.hermes/profiles/work/kotoba-gateway.pid",
    );
    expect(kotobaGatewayArgs(undefined, 8642)).toEqual([
      "/repo/gateway-hy/kotoba_gateway_main.py",
      "--port",
      "8642",
      "--pid-file",
      "/home/.hermes/kotoba-gateway.pid",
    ]);
    expect(kotobaGatewayEnv("work", "/hermes-agent")).toMatchObject({
      HERMES_HOME: "/home/.hermes/profiles/work",
      HERMES_REPO: "/hermes-agent",
    });
  });
});
