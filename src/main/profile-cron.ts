// @lat: [[office-cron-presence#Cron presence#Reading a profile's cron state]]
/**
 * What a profile's cron scheduler says about its work — read from the files
 * Hermes Agent keeps under `<profile>/cron/`:
 *
 *   jobs.json       every job: enabled, schedule, last_run_at, last_status,
 *                   last_error, next_run_at (the scheduler writes it)
 *   executions.db   one row per attempt; status 'claimed' / 'running' while
 *                   an attempt is in flight (sqlite, read-only here)
 *
 * This fork's fleet is cron-driven: 80+ profiles each run one daily job and
 * hold no resident gateway, so upstream's Office (gateway running or a
 * Kanban card → "working", otherwise "idle") drew every one of them idle
 * even on the day they had all run — and drew the 57 that had FAILED that
 * morning the same amber as the ones that had succeeded. Measured
 * 2026-09-22. The Office reads this instead: an attempt in flight is
 * working, a last run that failed is an error with its reason, and a job
 * that ran fine is idle-with-a-next-run.
 */
import Database from "better-sqlite3";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface ProfileCronState {
  /** Enabled jobs. */
  jobs: number;
  /** Attempts currently claimed or running (executions.db). */
  running: number;
  /** ISO time of the most recent last_run_at across enabled jobs, or null. */
  lastRunAt: string | null;
  /** The status of that most recent run: "ok", "error", or null (never ran). */
  lastStatus: "ok" | "error" | null;
  /** The scheduler's last_error for the failed job, when lastStatus is error. */
  lastError: string | null;
  /** ISO time of the soonest next_run_at across enabled jobs, or null. */
  nextRunAt: string | null;
  /** Job names whose last run failed. */
  failedJobs: string[];
}

interface CronJob {
  id?: string;
  name?: string;
  enabled?: boolean;
  last_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  next_run_at?: string | null;
}

function readJobs(cronDir: string): CronJob[] {
  const file = join(cronDir, "jobs.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? ((parsed as { jobs?: unknown }).jobs ?? [])
        : [];
    const jobs = Array.isArray(list)
      ? list
      : list && typeof list === "object"
        ? Object.values(list as Record<string, unknown>)
        : [];
    return jobs.filter((j): j is CronJob => !!j && typeof j === "object");
  } catch {
    return [];
  }
}

/** Attempts in flight, or 0 when the db is absent or will not open. */
export function countRunningExecutions(cronDir: string): number {
  const file = join(cronDir, "executions.db");
  if (!existsSync(file)) return 0;
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM executions WHERE status IN ('claimed','running')",
      )
      .get() as { n?: number } | undefined;
    return Number(row?.n ?? 0) || 0;
  } catch {
    return 0;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

/** Fold a profile's jobs (and in-flight attempts) into one state, or null
 *  when the profile has no cron directory at all. */
export function readProfileCronState(
  profilePath: string,
): ProfileCronState | null {
  const cronDir = join(profilePath, "cron");
  if (!existsSync(cronDir)) return null;
  const enabled = readJobs(cronDir).filter((j) => j.enabled);
  let last: CronJob | null = null;
  let next: string | null = null;
  const failedJobs: string[] = [];
  for (const job of enabled) {
    if (
      job.last_run_at &&
      (!last || job.last_run_at > (last.last_run_at ?? ""))
    ) {
      last = job;
    }
    if (job.next_run_at && (!next || job.next_run_at < next))
      next = job.next_run_at;
    if (job.last_status === "error") failedJobs.push(job.name || job.id || "?");
  }
  const lastStatus: ProfileCronState["lastStatus"] =
    last?.last_status === "ok"
      ? "ok"
      : last?.last_status === "error"
        ? "error"
        : null;
  return {
    jobs: enabled.length,
    running: countRunningExecutions(cronDir),
    lastRunAt: last?.last_run_at ?? null,
    lastStatus,
    lastError: lastStatus === "error" ? (last?.last_error ?? null) : null,
    nextRunAt: next,
    failedJobs,
  };
}
