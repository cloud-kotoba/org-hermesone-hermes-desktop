// @lat: [[service-supervisor]]
/**
 * Kotoba Desktop supervises the machine's long-running services (tunnels,
 * bridges, model servers, loop supervisors) that used to be launchd
 * `KeepAlive` agents. Schedules moved to Hermes cron; a daemon is not a
 * schedule — it needs a supervisor that restarts it when it dies — so that
 * role lives here (owner direction 2026-09-23).
 *
 * Services are spawned detached and recorded in a pid file, so they outlive a
 * Desktop restart or update; the next Desktop adopts them from the pid file
 * and keeps watching. Liveness is polled (the same check for an owned child
 * and an adopted pid), and a dead service is restarted per its policy with
 * launchd's throttle floor plus exponential backoff for crash loops.
 *
 * A label that launchd still has loaded is never started here: two
 * supervisors would run two copies.
 */
import { spawn as nodeSpawn } from "child_process";
import { execFileSync } from "child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

export type RestartPolicy = "always" | "on-failure";

export interface ServiceSpec {
  label: string;
  program: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stdout?: string;
  stderr?: string;
  restart?: RestartPolicy;
  /** Minimum seconds between starts (launchd ThrottleInterval; default 10). */
  throttleSec?: number;
  enabled?: boolean;
}

export type ServiceState =
  | "running"
  | "backoff"
  | "stopped"
  | "disabled"
  | "blocked-by-launchd";

export interface ServiceStatus {
  label: string;
  state: ServiceState;
  pid: number | null;
  restarts: number;
  lastExitCode: number | null;
  lastStartedAt: number | null;
  nextStartAt: number | null;
}

export interface SupervisorDeps {
  now: () => number;
  /** Start the process detached; returns its pid, or null on spawn failure. */
  spawn: (
    spec: ServiceSpec,
    onExit: (code: number | null) => void,
  ) => number | null;
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  readPid: (label: string) => number | null;
  writePid: (label: string, pid: number) => void;
  clearPid: (label: string) => void;
  launchdLoaded: (label: string) => boolean;
  log: (msg: string) => void;
}

/** A run shorter than this counts as a crash loop and doubles the backoff. */
export const QUICK_EXIT_MS = 60_000;
export const MAX_BACKOFF_MS = 300_000;
const DEFAULT_THROTTLE_SEC = 10;

interface Entry {
  spec: ServiceSpec;
  pid: number | null;
  restarts: number;
  quickExits: number;
  lastExitCode: number | null;
  lastStartedAt: number | null;
  nextStartAt: number | null;
  stopped: boolean;
  blocked: boolean;
}

export class ServiceSupervisor {
  private entries = new Map<string, Entry>();

  constructor(
    specs: ServiceSpec[],
    private readonly deps: SupervisorDeps,
  ) {
    for (const spec of specs) {
      this.entries.set(spec.label, {
        spec,
        pid: null,
        restarts: 0,
        quickExits: 0,
        lastExitCode: null,
        lastStartedAt: null,
        nextStartAt: null,
        stopped: false,
        blocked: false,
      });
    }
  }

  /** One supervision pass: adopt, detect deaths, start what is due. */
  tick(): void {
    const now = this.deps.now();
    for (const e of this.entries.values()) {
      if (e.spec.enabled === false || e.stopped) continue;
      if (e.pid === null) {
        const adopted = this.deps.readPid(e.spec.label);
        if (adopted !== null && this.deps.isAlive(adopted)) {
          e.pid = adopted;
          e.lastStartedAt ??= now;
          continue;
        }
      }
      if (e.pid !== null) {
        if (this.deps.isAlive(e.pid)) continue;
        this.onDeath(e, e.lastExitCode, now);
        if (e.stopped) continue; // on-failure after a clean exit: leave it down
      }
      if (e.nextStartAt !== null && now < e.nextStartAt) continue;
      this.start(e, now);
    }
  }

  private onDeath(e: Entry, code: number | null, now: number): void {
    const ran = e.lastStartedAt === null ? Infinity : now - e.lastStartedAt;
    e.pid = null;
    this.deps.clearPid(e.spec.label);
    if (e.spec.restart === "on-failure" && code === 0) {
      e.stopped = true;
      this.deps.log(
        `${e.spec.label}: exited 0, restart=on-failure — left stopped`,
      );
      return;
    }
    e.quickExits = ran < QUICK_EXIT_MS ? e.quickExits + 1 : 0;
    const throttle = (e.spec.throttleSec ?? DEFAULT_THROTTLE_SEC) * 1000;
    const backoff =
      e.quickExits === 0
        ? throttle
        : Math.min(MAX_BACKOFF_MS, throttle * 2 ** (e.quickExits - 1));
    const earliest = (e.lastStartedAt ?? now) + throttle;
    e.nextStartAt = Math.max(now + backoff, earliest);
    this.deps.log(
      `${e.spec.label}: died (code ${code ?? "unknown"}), restart in ${Math.round((e.nextStartAt - now) / 1000)}s`,
    );
  }

  private start(e: Entry, now: number): void {
    if (this.deps.launchdLoaded(e.spec.label)) {
      if (!e.blocked)
        this.deps.log(
          `${e.spec.label}: still loaded in launchd — not starting a second copy`,
        );
      e.blocked = true;
      return;
    }
    e.blocked = false;
    const pid = this.deps.spawn(e.spec, (code) => {
      e.lastExitCode = code;
    });
    e.lastStartedAt = now;
    if (pid === null) {
      this.onDeath(e, null, now);
      return;
    }
    if (e.nextStartAt !== null) e.restarts += 1;
    e.pid = pid;
    e.nextStartAt = null;
    e.lastExitCode = null;
    this.deps.writePid(e.spec.label, pid);
    this.deps.log(`${e.spec.label}: started pid ${pid}`);
  }

  /** Stop supervising and terminate one service (it stays stopped until restart()). */
  stop(label: string): boolean {
    const e = this.entries.get(label);
    if (!e) return false;
    e.stopped = true;
    if (e.pid !== null && this.deps.isAlive(e.pid))
      this.deps.kill(e.pid, "SIGTERM");
    e.pid = null;
    this.deps.clearPid(label);
    return true;
  }

  /** Terminate (if running) and start again on the next tick, with the backoff reset. */
  restart(label: string): boolean {
    const e = this.entries.get(label);
    if (!e) return false;
    if (e.pid !== null && this.deps.isAlive(e.pid))
      this.deps.kill(e.pid, "SIGTERM");
    e.pid = null;
    this.deps.clearPid(label);
    e.stopped = false;
    e.quickExits = 0;
    e.nextStartAt = null;
    return true;
  }

  list(): ServiceStatus[] {
    const now = this.deps.now();
    return [...this.entries.values()].map((e) => ({
      label: e.spec.label,
      state:
        e.spec.enabled === false
          ? "disabled"
          : e.blocked
            ? "blocked-by-launchd"
            : e.stopped
              ? "stopped"
              : e.pid !== null
                ? "running"
                : e.nextStartAt !== null && now < e.nextStartAt
                  ? "backoff"
                  : "stopped",
      pid: e.pid,
      restarts: e.restarts,
      lastExitCode: e.lastExitCode,
      lastStartedAt: e.lastStartedAt,
      nextStartAt: e.nextStartAt,
    }));
  }
}

// ---- real-process wiring ---------------------------------------------------

const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export function servicesConfigPath(home = homedir()): string {
  return join(home, ".hermes", "desktop-services.json");
}

function pidDir(home = homedir()): string {
  return join(home, ".hermes", "desktop-services");
}

export function loadServiceSpecs(path = servicesConfigPath()): ServiceSpec[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    services?: ServiceSpec[];
  };
  return (raw.services ?? []).filter(
    (s) => s && typeof s.label === "string" && typeof s.program === "string",
  );
}

export function realSupervisorDeps(home = homedir()): SupervisorDeps {
  const dir = pidDir(home);
  const pidFile = (label: string): string => join(dir, `${label}.pid`);
  return {
    now: () => Date.now(),
    spawn: (spec, onExit) => {
      // launchd's environment, not Desktop's: a service must not inherit the app's secrets.
      const env: Record<string, string> = {
        HOME: home,
        USER: process.env.USER ?? "",
        LOGNAME: process.env.USER ?? "",
        SHELL: "/bin/zsh",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        PATH: LAUNCHD_PATH,
        ...(spec.env ?? {}),
      };
      const out = openSync(spec.stdout ?? "/dev/null", "a");
      const err =
        spec.stderr && spec.stderr !== spec.stdout
          ? openSync(spec.stderr, "a")
          : out;
      try {
        const child = nodeSpawn(spec.program, spec.args ?? [], {
          cwd: spec.cwd ?? home,
          env,
          detached: true,
          stdio: ["ignore", out, err],
        });
        child.on("exit", (code) => onExit(code));
        child.on("error", () => onExit(null));
        child.unref();
        return child.pid ?? null;
      } catch {
        return null;
      } finally {
        closeSync(out);
        if (err !== out) closeSync(err);
      }
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    },
    readPid: (label) => {
      try {
        const n = parseInt(readFileSync(pidFile(label), "utf8").trim(), 10);
        return Number.isFinite(n) && n > 1 ? n : null;
      } catch {
        return null;
      }
    },
    writePid: (label, pid) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(pidFile(label), `${pid}\n`);
    },
    clearPid: (label) => {
      try {
        unlinkSync(pidFile(label));
      } catch {
        /* none */
      }
    },
    launchdLoaded: (label) => {
      try {
        execFileSync("launchctl", ["list", label], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    log: (msg) => console.log(`[service-supervisor] ${msg}`),
  };
}

let running: { supervisor: ServiceSupervisor; timer: NodeJS.Timeout } | null =
  null;

/** Start supervising the services in ~/.hermes/desktop-services.json (no-op when absent or empty). */
export function startServiceSupervisor(
  intervalMs = 5_000,
): ServiceSupervisor | null {
  if (running) return running.supervisor;
  if (process.platform !== "darwin") return null;
  let specs: ServiceSpec[];
  try {
    specs = loadServiceSpecs();
  } catch (e) {
    console.error("[service-supervisor] cannot read desktop-services.json:", e);
    return null;
  }
  if (specs.length === 0) return null;
  const supervisor = new ServiceSupervisor(specs, realSupervisorDeps());
  supervisor.tick();
  const timer = setInterval(() => supervisor.tick(), intervalMs);
  timer.unref();
  running = { supervisor, timer };
  return supervisor;
}

/** Stop the watch loop only. Services keep running (they are detached) and the next Desktop adopts them. */
export function stopServiceSupervisorPolling(): void {
  if (!running) return;
  clearInterval(running.timer);
  running = null;
}

export function getServiceSupervisor(): ServiceSupervisor | null {
  return running?.supervisor ?? null;
}
