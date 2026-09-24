# Service supervisor

Kotoba Desktop keeps the machine's long-running services up — tunnels, bridges, model servers, loop supervisors that used to be launchd `KeepAlive` agents.

Owner direction 2026-09-23: schedules live in Hermes cron (visible and editable here), not launchd. A daemon is not a schedule: cron can start it, but nothing notices it died until the next fire, so the restart-on-death role moved into the app that is already always running. On the machine that prompted this, 27 of 101 LaunchAgents were `KeepAlive` services.

## Configuration

[[src/main/service-supervisor.ts#loadServiceSpecs]] reads `~/.hermes/desktop-services.json`; a missing or empty file is a no-op.

Each entry has label, program, args, env, cwd, stdout, stderr, restart (`always` | `on-failure`), throttleSec and enabled. `scripts/launchd-to-desktop-services.mjs` converts a `KeepAlive` plist into an entry (`KeepAlive: true` → `always`, `{SuccessfulExit: false}` / `{Crashed: true}` → `on-failure`, `ThrottleInterval` → `throttleSec`) and refuses schedule-only plists, which belong in Hermes cron.

## Supervision

[[src/main/service-supervisor.ts#ServiceSupervisor]] is driven by a 5 s tick started from [[src/main/app/start.ts#startMainProcess]] on app ready.

Each tick adopts a live pid from `~/.hermes/desktop-services/<label>.pid`, detects a dead one, and starts what is due. Services are spawned **detached** with launchd's minimal environment plus the entry's `env` (never the app's own environment, so a service does not inherit Desktop's secrets), appending to the entry's log paths. They outlive a Desktop quit, restart or update; `before-quit` stops only the watch loop, and the next Desktop adopts them from their pid files.

A dead service restarts after `throttleSec` (launchd's floor). A run shorter than 60 s counts as a crash loop and doubles the delay, capped at 5 minutes; a long run resets it. `on-failure` leaves a clean exit (code 0) stopped. An adopted pid's exit code is unknown and counts as a failure.

A label launchd still has loaded is never started (`blocked-by-launchd`), so cutting a service over is: write its entry, then `launchctl bootout` it — the next tick starts it. IPC `services-list`, `services-restart` and `services-stop` expose [[src/main/service-supervisor.ts#ServiceSupervisor#list]], `restart` and `stop`; there is no renderer surface yet.

## Tests

[[src/main/service-supervisor.test.ts]] drives the supervisor with a fake process table and clock, so restart timing is arithmetic rather than waiting.

Covered: start and pid file, adoption instead of a second copy, restart after the throttle, crash-loop doubling and the 5-minute cap, `on-failure` staying down after exit 0 and restarting after a non-zero exit, the launchd guard, disabled entries, and `stop` / `restart`.
