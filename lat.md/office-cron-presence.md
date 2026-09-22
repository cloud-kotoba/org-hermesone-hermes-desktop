# Cron presence

The Office reads each profile's cron scheduler so a cron-driven bot's day of work — an attempt in flight, a run that failed, the next run — shows on its nameplate and in its details, instead of every bot standing idle.

This fork's fleet is ~90 profiles that each run one daily Hermes cron job and hold no resident gateway. Upstream's rule ([[src/renderer/src/screens/Office/office3d/agents.ts#profileToOfficeAgent]]: a running Kanban card, else gateway liveness, else idle) drew all of them amber all day, and on 2026-09-22 drew the 57 whose morning run had failed (`screen-route-refused`, an api.kotoba.cloud outage) the same amber as the 25 that had succeeded. Measured that day.

## Reading a profile's cron state

[[src/main/profile-cron.ts#readProfileCronState]] folds `<profile>/cron/jobs.json` (enabled jobs: `last_run_at`, `last_status`, `last_error`, `next_run_at`) into one state — the latest run and its status, the soonest next run, the failed job names — and [[src/main/profile-cron.ts#countRunningExecutions]] counts `claimed` / `running` rows in `cron/executions.db` (opened read-only with better-sqlite3). A profile without a cron directory is `null`; an unreadable `jobs.json` is zero jobs, never a throw. `listProfiles` carries it as `cron` on every local profile.

## Status rule

[[src/renderer/src/screens/Office/office3d/agents.ts#cronStatus]] says "working" for an attempt in flight, "error" for a failed last run, "idle" for a job that ran fine, and nothing for a profile without enabled jobs. A running Kanban card — or, when Kanban is unavailable, a live gateway — still wins; cron speaks only when upstream's rule would say idle. The details sidebar in [[src/renderer/src/screens/Office/Office.tsx#Office]] shows the job count, in-flight count, last run (with ✓ or the failure and its reason) and next run.

## Tests

[[src/main/profile-cron.test.ts]] writes real `jobs.json` files (both shapes) and a real sqlite `executions.db` into temp profiles and checks the fold, the in-flight count, and the no-throw on bad JSON. [[src/renderer/src/screens/Office/office3d/agents.test.ts]] covers the status rule: between runs idle, in flight working, failed run error, Kanban card wins, gateway wins only without Kanban, no cron keeps upstream's rule, and a cron change is a re-render.
