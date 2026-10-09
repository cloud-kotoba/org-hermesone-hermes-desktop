// @vitest-environment node
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";

// A throwaway HERMES_HOME with a handful of profiles. The installer module
// resolves HERMES_HOME at import, so it is mocked to point here.
const { home, liveMultiplexer, readProfileCronState } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { mkdtempSync } = require("fs");
  const { tmpdir } = require("os");
  const path = require("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    home: mkdtempSync(path.join(tmpdir(), "kotoba-profiles-")) as string,
    // Counted: these are the per-scan costs the cache exists to bound.
    liveMultiplexer: vi.fn(() => ({ pid: 1, served: ["alpha", "beta"] })),
    readProfileCronState: vi.fn((_profilePath: string) => null),
  };
});

vi.mock("./installer", () => ({
  HERMES_HOME: home,
  HERMES_PYTHON: "/nonexistent/python",
  hermesCliArgs: (args: string[] = []) => args,
  getEnhancedPath: () => process.env.PATH ?? "",
}));

vi.mock("./gateway-multiplex", () => ({ liveMultiplexer }));
vi.mock("./profile-cron", () => ({ readProfileCronState }));

import {
  getProfileSummary,
  invalidateProfileCache,
  listProfiles,
} from "./profiles";

const NAMES = ["alpha", "beta", "gamma", "delta"];

function cronStateCallsFor(name: string): number {
  return readProfileCronState.mock.calls.filter(
    ([profilePath]) => profilePath === join(home, "profiles", name),
  ).length;
}

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, "profiles"), { recursive: true });
  writeFileSync(join(home, "config.yaml"), "model:\n  default: base\n");
  for (const name of NAMES) {
    const dir = join(home, "profiles", name);
    mkdirSync(join(dir, "cron"), { recursive: true });
    writeFileSync(join(dir, "config.yaml"), `model:\n  default: m-${name}\n`);
    writeFileSync(join(dir, "cron", "jobs.json"), '{"jobs": []}');
  }
  invalidateProfileCache();
  liveMultiplexer.mockClear();
  readProfileCronState.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("profile scan cost control", () => {
  // @lat: [[profile-distribution#Desktop relief#Tests#One multiplexer read per scan]]
  it("reads the multiplexer record once per scan, not per profile", async () => {
    const list = await listProfiles();
    expect(list.map((p) => p.id).sort()).toEqual(["default", ...NAMES].sort());
    expect(liveMultiplexer).toHaveBeenCalledTimes(1);
    const alpha = list.find((p) => p.id === "alpha")!;
    expect(alpha.gatewayRunning).toBe(true);
    expect(alpha.gatewayShared).toBe(true);
    expect(list.find((p) => p.id === "gamma")!.gatewayRunning).toBe(false);
    expect(list.find((p) => p.id === "default")!.gatewayShared).toBe(false);
  });

  // @lat: [[profile-distribution#Desktop relief#Tests#Concurrent callers share one scan]]
  it("lets concurrent callers share one scan and reuses it briefly", async () => {
    await Promise.all([listProfiles(), listProfiles(), listProfiles()]);
    expect(liveMultiplexer).toHaveBeenCalledTimes(1);
    await listProfiles(); // within the reuse window
    expect(liveMultiplexer).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 5_000);
    await listProfiles(); // window passed: a new scan
    expect(liveMultiplexer).toHaveBeenCalledTimes(2);
  });

  // @lat: [[profile-distribution#Desktop relief#Tests#Unchanged profiles are not re-read]]
  it("re-reads cron state only for profiles whose files changed", async () => {
    await listProfiles();
    expect(cronStateCallsFor("alpha")).toBe(1);
    expect(cronStateCallsFor("gamma")).toBe(1);

    // Touch gamma's jobs.json, then let the list reuse window pass.
    const future = new Date(Date.now() + 10_000);
    utimesSync(
      join(home, "profiles", "gamma", "cron", "jobs.json"),
      future,
      future,
    );
    vi.setSystemTime(Date.now() + 5_000);
    await listProfiles();

    expect(cronStateCallsFor("alpha")).toBe(1); // unchanged: memo hit
    expect(cronStateCallsFor("gamma")).toBe(2); // changed: re-read
  });

  // @lat: [[profile-distribution#Desktop relief#Tests#Mutations invalidate the cache]]
  it("serves a renamed profile right after the mutation invalidates", async () => {
    await listProfiles();
    writeFileSync(
      join(home, "profiles", "beta", "profile-meta.json"),
      JSON.stringify({ name: "Beta Renamed" }),
    );
    invalidateProfileCache("beta"); // what the rename IPC handler does
    const list = await listProfiles(); // no time passed
    expect(list.find((p) => p.id === "beta")!.name).toBe("Beta Renamed");
  });

  // @lat: [[profile-distribution#Desktop relief#Tests#Summary reads one profile]]
  it("answers a single-profile summary without scanning the others", async () => {
    const delta = await getProfileSummary("delta");
    expect(delta?.model).toBe("m-delta");
    expect(readProfileCronState).toHaveBeenCalledTimes(1);
    expect(cronStateCallsFor("delta")).toBe(1);
    expect(await getProfileSummary("missing")).toBeNull();
    expect(await getProfileSummary("../escape")).toBeNull();
    expect((await getProfileSummary("default"))?.model).toBe("base");
  });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
