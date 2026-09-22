// @vitest-environment node
// @lat: [[office-cron-presence#Cron presence#Tests]]

import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

import { countRunningExecutions, readProfileCronState } from "./profile-cron";

const dirs: string[] = [];
function profileDir(): string {
  const d = mkdtempSync(join(tmpdir(), "kotoba-cron-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeJobs(profile: string, jobs: unknown): void {
  mkdirSync(join(profile, "cron"), { recursive: true });
  writeFileSync(join(profile, "cron", "jobs.json"), JSON.stringify(jobs));
}

function writeExecutions(profile: string, statuses: string[]): void {
  mkdirSync(join(profile, "cron"), { recursive: true });
  const db = new Database(join(profile, "cron", "executions.db"));
  db.exec(
    `CREATE TABLE executions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
       source TEXT NOT NULL, process_id TEXT NOT NULL, pid INTEGER NOT NULL,
       status TEXT NOT NULL, claimed_at TEXT NOT NULL)`,
  );
  const ins = db.prepare(
    "INSERT INTO executions VALUES (?, 'j1', 'ticker', 'p', 1, ?, '2026-09-22T00:00:00')",
  );
  statuses.forEach((s, i) => ins.run(`e${i}`, s));
  db.close();
}

describe("readProfileCronState", () => {
  it("is null for a profile with no cron directory", () => {
    expect(readProfileCronState(profileDir())).toBeNull();
  });

  it("folds the enabled jobs: latest last run, its status and error, soonest next run", () => {
    const p = profileDir();
    writeJobs(p, [
      {
        id: "a",
        name: "daily sync",
        enabled: true,
        last_run_at: "2026-09-22T04:35:29+09:00",
        last_status: "error",
        last_error:
          "RuntimeError: content screening could not run (screen-route-refused)",
        next_run_at: "2026-09-23T04:34:00+09:00",
      },
      {
        id: "b",
        name: "weekly report",
        enabled: true,
        last_run_at: "2026-09-21T10:00:00+09:00",
        last_status: "ok",
        last_error: null,
        next_run_at: "2026-09-22T20:00:00+09:00",
      },
      {
        id: "c",
        name: "paused",
        enabled: false,
        last_run_at: "2026-09-22T23:00:00+09:00",
        last_status: "error",
        last_error: "ignored — disabled",
        next_run_at: null,
      },
    ]);
    expect(readProfileCronState(p)).toEqual({
      jobs: 2,
      running: 0,
      lastRunAt: "2026-09-22T04:35:29+09:00",
      lastStatus: "error",
      lastError:
        "RuntimeError: content screening could not run (screen-route-refused)",
      nextRunAt: "2026-09-22T20:00:00+09:00",
      failedJobs: ["daily sync"],
    });
  });

  it("reads jobs.json in its {jobs: [...]} shape and a job that never ran", () => {
    const p = profileDir();
    writeJobs(p, {
      jobs: [
        {
          id: "x",
          name: "first",
          enabled: true,
          next_run_at: "2026-10-05T04:05:00+09:00",
        },
      ],
    });
    expect(readProfileCronState(p)).toMatchObject({
      jobs: 1,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      nextRunAt: "2026-10-05T04:05:00+09:00",
      failedJobs: [],
    });
  });

  it("counts claimed and running attempts from executions.db, and 0 without it", () => {
    const p = profileDir();
    writeJobs(p, [{ id: "a", name: "n", enabled: true, last_status: "ok" }]);
    expect(countRunningExecutions(join(p, "cron"))).toBe(0);
    writeExecutions(p, ["completed", "running", "claimed", "failed"]);
    expect(countRunningExecutions(join(p, "cron"))).toBe(2);
    expect(readProfileCronState(p)).toMatchObject({ running: 2 });
  });

  it("treats an unreadable jobs.json as no jobs rather than throwing", () => {
    const p = profileDir();
    mkdirSync(join(p, "cron"), { recursive: true });
    writeFileSync(join(p, "cron", "jobs.json"), "{not json");
    expect(readProfileCronState(p)).toMatchObject({ jobs: 0, running: 0 });
  });
});
