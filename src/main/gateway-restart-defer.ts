// @lat: [[office-cron-presence#Cron presence#Deferring a restart]]
/**
 * Don't restart a profile's gateway out from under its own cron job.
 *
 * Writing a credential — an API key in Settings, this fork's Kotoba Cloud
 * sign-in — restarts the local gateway so it picks the value up. That is a
 * convenience, not something the person asked for, and it kills whatever the
 * gateway is running: Hermes reports it as
 * `Gateway shutdown (<phase>) killed the job's tool subprocess before the
 * run finished.` (gateway/run_shutdown.py). Measured 2026-09-22 on this
 * machine's fleet: three profiles lost a daily run to exactly that message,
 * one of them twice, on a day when a key was written while ~10 cron jobs
 * were in flight across the fleet.
 *
 * So an INCIDENTAL restart waits for the profile's cron scheduler to be
 * idle (profile-cron's executions.db read), up to `maxWaitMs`; then it
 * restarts anyway, because a gateway holding a stale key is its own
 * failure and waiting forever would hide it. A restart the person asked
 * for (the Settings button, "restart-gateway") is NOT routed through here —
 * a deliberate restart happens when it is asked for.
 */
import { countRunningExecutions } from "./profile-cron";
import { profilePaths } from "./utils";
import { join } from "path";

/** How long an incidental restart waits for the profile to go idle. */
export const DEFAULT_MAX_WAIT_MS = 10 * 60_000;
/** How often it re-reads executions.db while waiting. */
export const DEFAULT_POLL_MS = 15_000;

export interface DeferResult {
  restarted: boolean;
  /** "idle" — nothing was running; "waited" — a job finished first;
   *  "timeout" — the cap expired and it restarted anyway. */
  reason: "idle" | "waited" | "timeout";
  waitedMs: number;
}

/** One pending deferral per profile: a burst of env writes must not queue
 *  a restart each. */
const pending = new Map<string, Promise<DeferResult>>();

export function cronBusy(
  profile: string | undefined,
  count: (dir: string) => number = countRunningExecutions,
): boolean {
  try {
    return count(join(profilePaths(profile).home, "cron")) > 0;
  } catch {
    // An unreadable executions.db must not block a credential from taking
    // effect: treat it as idle and restart. The opposite reading would let
    // one broken file freeze every future restart.
    return false;
  }
}

/**
 * Restart `profile`'s gateway once its cron scheduler is idle. Returns what
 * happened, so the caller can log it by name rather than guessing.
 */
export function restartGatewayWhenIdle(
  profile: string | undefined,
  restart: (profile?: string) => Promise<unknown>,
  opts: {
    maxWaitMs?: number;
    pollMs?: number;
    busy?: (profile: string | undefined) => boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<DeferResult> {
  const key = profile?.trim() || "default";
  const existing = pending.get(key);
  if (existing) return existing;

  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const busy = opts.busy ?? ((p: string | undefined) => cronBusy(p));
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  const run = (async (): Promise<DeferResult> => {
    const t0 = now();
    if (!busy(profile)) {
      await restart(profile);
      return { restarted: true, reason: "idle", waitedMs: 0 };
    }
    console.log(
      "gateway-restart-deferred",
      key,
      "a cron attempt is in flight; waiting up to",
      maxWaitMs,
      "ms",
    );
    while (now() - t0 < maxWaitMs) {
      await sleep(pollMs);
      if (!busy(profile)) {
        const waitedMs = now() - t0;
        console.log("gateway-restart-resumed", key, "after", waitedMs, "ms");
        await restart(profile);
        return { restarted: true, reason: "waited", waitedMs };
      }
    }
    const waitedMs = now() - t0;
    console.warn(
      "gateway-restart-forced",
      key,
      "still busy after",
      waitedMs,
      "ms — restarting anyway so the new value takes effect",
    );
    await restart(profile);
    return { restarted: true, reason: "timeout", waitedMs };
  })();

  const tracked = run.finally(() => {
    if (pending.get(key) === tracked) pending.delete(key);
  });
  pending.set(key, tracked);
  return tracked;
}

/** Test hook: forget any pending deferral. */
export function resetGatewayRestartDeferrals(): void {
  pending.clear();
}
