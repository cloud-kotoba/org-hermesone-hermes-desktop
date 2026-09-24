// @vitest-environment node
// @lat: [[service-supervisor#Tests]]

import { describe, expect, it } from "vitest";

import {
  MAX_BACKOFF_MS,
  QUICK_EXIT_MS,
  ServiceSupervisor,
  type ServiceSpec,
  type SupervisorDeps,
} from "./service-supervisor";

interface Harness {
  deps: SupervisorDeps;
  spawned: string[];
  killed: number[];
  pidFiles: Record<string, number>;
  advance: (ms: number) => void;
  die: (pid: number, code: number | null) => void;
}

/** A fake process table and clock: the supervisor is driven by tick(), so time is arithmetic. */
function harness(
  opts: { launchd?: Set<string>; pidFiles?: Record<string, number> } = {},
): Harness {
  let t = 0;
  let nextPid = 1000;
  const alive = new Set<number>();
  const pidFiles: Record<string, number> = { ...(opts.pidFiles ?? {}) };
  const spawned: string[] = [];
  const killed: number[] = [];
  const exits = new Map<number, (code: number | null) => void>();
  for (const pid of Object.values(pidFiles)) alive.add(pid);
  const deps: SupervisorDeps = {
    now: () => t,
    spawn: (spec, onExit) => {
      const pid = nextPid++;
      alive.add(pid);
      exits.set(pid, onExit);
      spawned.push(spec.label);
      return pid;
    },
    isAlive: (pid) => alive.has(pid),
    kill: (pid) => {
      killed.push(pid);
      alive.delete(pid);
    },
    readPid: (label) => pidFiles[label] ?? null,
    writePid: (label, pid) => {
      pidFiles[label] = pid;
    },
    clearPid: (label) => {
      delete pidFiles[label];
    },
    launchdLoaded: (label) => opts.launchd?.has(label) ?? false,
    log: () => {},
  };
  return {
    deps,
    spawned,
    killed,
    pidFiles,
    advance: (ms: number) => {
      t += ms;
    },
    die: (pid: number, code: number | null) => {
      alive.delete(pid);
      exits.get(pid)?.(code);
    },
  };
}

const svc = (over: Partial<ServiceSpec> = {}): ServiceSpec => ({
  label: "cloud.itonami.agent-tunnel",
  program: "/usr/bin/true",
  restart: "always",
  throttleSec: 10,
  ...over,
});

describe("ServiceSupervisor", () => {
  it("starts an enabled service and records its pid", () => {
    const h = harness();
    const s = new ServiceSupervisor([svc()], h.deps);
    s.tick();
    expect(h.spawned).toEqual(["cloud.itonami.agent-tunnel"]);
    expect(s.list()[0]).toMatchObject({
      state: "running",
      pid: 1000,
      restarts: 0,
    });
    expect(h.pidFiles["cloud.itonami.agent-tunnel"]).toBe(1000);
  });

  it("adopts a live pid from the pid file instead of starting a second copy", () => {
    const h = harness({ pidFiles: { "cloud.itonami.agent-tunnel": 4242 } });
    const s = new ServiceSupervisor([svc()], h.deps);
    s.tick();
    expect(h.spawned).toEqual([]);
    expect(s.list()[0]).toMatchObject({ state: "running", pid: 4242 });
  });

  it("restarts a service that died after a long run once the throttle has passed", () => {
    const h = harness();
    const s = new ServiceSupervisor([svc()], h.deps);
    s.tick();
    h.advance(QUICK_EXIT_MS * 2);
    h.die(1000, 1);
    s.tick();
    expect(s.list()[0]).toMatchObject({ state: "backoff", lastExitCode: 1 });
    h.advance(9_999);
    s.tick();
    expect(h.spawned).toHaveLength(1);
    h.advance(1);
    s.tick();
    expect(h.spawned).toHaveLength(2);
    expect(s.list()[0]).toMatchObject({ state: "running", restarts: 1 });
  });

  it("doubles the delay for a crash loop and caps it", () => {
    const h = harness();
    const s = new ServiceSupervisor([svc()], h.deps);
    s.tick();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      h.advance(1_000); // dies after 1 s: a quick exit
      h.die(s.list()[0].pid!, 1);
      s.tick();
      const st = s.list()[0];
      delays.push(st.nextStartAt! - (st.lastStartedAt! + 1_000));
      h.advance(st.nextStartAt! - (st.lastStartedAt! + 1_000));
      s.tick();
    }
    expect(delays.slice(0, 4)).toEqual([10_000, 20_000, 40_000, 80_000]);
    expect(Math.max(...delays)).toBe(MAX_BACKOFF_MS);
  });

  it("leaves an on-failure service stopped after a clean exit", () => {
    const h = harness();
    const s = new ServiceSupervisor([svc({ restart: "on-failure" })], h.deps);
    s.tick();
    h.advance(QUICK_EXIT_MS * 2);
    h.die(1000, 0);
    s.tick();
    h.advance(MAX_BACKOFF_MS);
    s.tick();
    expect(h.spawned).toHaveLength(1);
    expect(s.list()[0].state).toBe("stopped");
  });

  it("restarts an on-failure service after a non-zero exit", () => {
    const h = harness();
    const s = new ServiceSupervisor([svc({ restart: "on-failure" })], h.deps);
    s.tick();
    h.advance(QUICK_EXIT_MS * 2);
    h.die(1000, 75);
    s.tick();
    h.advance(10_000);
    s.tick();
    expect(h.spawned).toHaveLength(2);
  });

  it("never starts a label launchd still has loaded", () => {
    const h = harness({ launchd: new Set(["cloud.itonami.agent-tunnel"]) });
    const s = new ServiceSupervisor([svc()], h.deps);
    s.tick();
    expect(h.spawned).toEqual([]);
    expect(s.list()[0].state).toBe("blocked-by-launchd");
  });

  it("skips disabled services", () => {
    const h = harness();
    const s = new ServiceSupervisor([svc({ enabled: false })], h.deps);
    s.tick();
    expect(h.spawned).toEqual([]);
    expect(s.list()[0].state).toBe("disabled");
  });

  it("stop() terminates and keeps it down; restart() brings it back with the backoff reset", () => {
    const h = harness();
    const s = new ServiceSupervisor([svc()], h.deps);
    s.tick();
    expect(s.stop("cloud.itonami.agent-tunnel")).toBe(true);
    expect(h.killed).toEqual([1000]);
    s.tick();
    expect(h.spawned).toHaveLength(1);
    expect(s.list()[0].state).toBe("stopped");
    expect(s.restart("cloud.itonami.agent-tunnel")).toBe(true);
    s.tick();
    expect(h.spawned).toHaveLength(2);
    expect(s.list()[0].state).toBe("running");
    expect(s.stop("nope")).toBe(false);
  });
});
