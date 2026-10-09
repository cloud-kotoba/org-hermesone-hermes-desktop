# Profile distribution

Design for running Kotoba's ~1,000 Hermes profiles on the murakumo fleet instead of the workstation: leased placement, a lazy per-node scheduler, ledger-based state handoff, and a desktop that only observes.

Status: proposal (2026-10-09). It changes the fleet rule that only the workstation ticks profiles (`com-junkawasaki/fleet-manifest/devices.edn`), so it needs a superseding ADR before rollout past the canary.

## Problem

Launching Kotoba desktop makes the workstation unresponsive. Two independent costs scale with the number of profiles, and both run on this one machine.

Measured on 2026-10-09: 1,015 profiles, 1,774 enabled cron jobs across 949 of them, and 23 GB of profile data (`state.db` total 8.24 GB, median 0.29 MB, largest 669 MB). Load average was 15–16 on 10 cores.

- **The multiplexed gateway's idle cost.** One upstream `hermes gateway` with `gateway.multiplex_profiles: true` serves 1,012 profiles. With zero agents running it used ~205% CPU, 3.1 GB RSS, 722 threads and 2,786 file descriptors, because it keeps per-profile resources open (three `state.db` handles, WAL/SHM, logs) whether or not anything is due.
- **The desktop's full scans.** The always-mounted status bar calls `listProfiles()` every 4 s, and Office does the same while visible. Each call scans every profile, including synchronous main-process work: ~1,015 `cron/executions.db` open/close cycles and ~2,030 re-reads of the same `gateway_state.json`. The IPC payload carries every avatar.

Moving execution off the PC fixes the first. The second is the desktop's own cost and must be fixed regardless of where profiles run.

## Principles

The rules every component below follows. They are what make the system distributed rather than "the same multiplexer on a bigger machine".

- **The desktop observes, it never executes.** It shows and steers profiles, and talks to whichever node owns one. It ticks nothing, and it never scans all profiles on a timer.
- **One owner per profile, enforced by a fenced lease.** Exactly one node may tick a profile's cron at a time. Ownership is a lease with an epoch number, and every write carries the epoch so a stale owner's writes are rejected.
- **Idle profiles cost nothing.** A node holds one scheduling heap for all its profiles and builds an agent only when a job is due, then tears it down. Idle cost is a heap entry, not threads and file handles.
- **State is content, not a machine.** Session history is the signed, content-addressed ledger from [[gateway-hy#Decentralized mesh]]. Any node holding the chain can continue a profile, so moving one is a pull, not a migration.
- **Credentials stay where policy says.** Profiles that hold signing keys or wallets are `:attested` and stay on the operator side, per ADR-2608111721 decision 5. Only `:anonymous` profiles move to the fleet.
- **Reuse the fleet's own parts.** Placement extends `murakumo.task.plan` (the designated placement authority), liveness reuses the device heartbeat, and transport is the tailnet.

## Architecture

Three roles: the murakumo control plane decides placement, each fleet node runs a Kotoba shard host, and the desktop reads placement and routes to owners.

| Role | Runs where | Responsibility |
|---|---|---|
| Control plane | murakumo.cloud (existing Worker + D1) | Profile registry, leases, reconciler, placement |
| Shard host | Each fleet node, one per node | Holds leases, ticks owned profiles, serves the Hermes API for them |
| Desktop | Workstation | Shows placement and health, sends chat to the owning node |

Each shard host is the Hy gateway (`gateway-hy/`) in a new `--shard` mode. It is already a mesh node with a `did:key` identity, signed requests and run delegation, so the desktop and peers reach a profile's owner through the same Hermes API.

### Control plane

Owns the profile registry and the lease table, and runs the reconciler that keeps every eligible profile leased to exactly one live node.

Proposed endpoints, next to `/api/actions` in cloud-murakumo:

- `PUT /api/profiles/:id` registers a profile: residency class, cost estimate, pin, and repository source.
- `POST /api/nodes/:did/heartbeat` extends the existing signed device heartbeat with capacity (free RAM, cores, running turns, queue latency) and the epochs of the leases the node holds.
- `GET /api/nodes/:did/leases` returns the node's desired lease set with epochs.
- `POST /api/leases/:profile/renew` and `/release` are fenced by epoch. A renew carrying an old epoch fails with 409.
- `GET /api/profiles?owner=&state=` is the paginated read model the desktop uses instead of scanning disk.

Lease record: `{profile, node-did, epoch, granted-at, expires-at, state :active|:draining|:released}`. The TTL is 10 minutes, renewed every 2 minutes by the heartbeat.

### Placement

Weighted rendezvous hashing chooses an owner, and the existing planner's load signal decides when to override it. The goal is spreading load with minimal movement when nodes join or leave.

1. **Eligibility.** A node is eligible for a profile if it is live (heartbeat < 180 s, the threshold `devices.cljk` already uses), not draining, holds the capabilities the profile needs (e.g. `python3`, a local model), and matches the residency class (`:attested` profiles are eligible only on attested hosts).
2. **Default owner by weighted rendezvous (HRW) hashing.** `score = weight(node) / -ln(hash(profile, node))`, and the highest score wins. Adding or removing a node moves only about 1/N of profiles, and any party can recompute the expected owner.
3. **Load override.** A node's weight comes from measured capacity. Per-profile cost is an EMA of turn runtime and token use, the same EMA idea `root/scripts/fleet-ci/placement.cljk` feeds the planner. If a node's queue latency stays above its budget for 3 reconciler passes, the reconciler moves its costliest movable profiles to the next HRW candidate.
4. **Hysteresis.** A profile moves only if the gain exceeds a margin, at most once per 30 minutes, and never while it has a turn running. This prevents flapping.
5. **Pins.** A profile can be pinned to a node (e.g. one that needs a GPU, or the workstation for local development). Pins override hashing but still need a valid lease.

The reconciler runs every 60 s and emits lease grants, renews and drains. `murakumo.task.plan` stays the authority: the reconciler calls its `admit`/`eligible?` for node filtering, rather than introducing a second placement engine.

### Shard host

One Hy gateway per node with a single scheduling heap, so a node can hold hundreds of profiles at near-zero idle cost.

- **Lease loop.** Every 2 minutes: heartbeat, fetch the desired lease set, renew held leases, materialize newly granted profiles, and drop released ones. Without a successful renew it stops ticking a profile when the TTL expires (fail closed), since it cannot tell a network partition from a control-plane outage.
- **Materialize.** Profile definitions (config, SOUL, skills, cron jobs) come from the owning repository at a pinned commit, per ADR-2609241200. Run state comes from the ledger head (see State and handoff). Each profile gets a directory under `~/.kotoba/profiles/<id>`, with no long-lived handles.
- **One heap, lazy agents.** All owned cron jobs sit in one min-heap keyed by next fire time. When a job is due, the host checks the lease epoch, builds an `AIAgent` for that profile, runs the turn, appends to the ledger, and discards the agent. Idle cost is O(1) per profile.
- **Concurrency limit.** At most `max-turns` agent turns run at once (default `cores / 2`), and due jobs beyond that wait in a fair per-profile queue. Queue latency is reported in the heartbeat, which is what the reconciler balances on.
- **Missed fires.** After a handoff or downtime, jobs within a catch-up window (default: one interval, capped at 6 h) run once. Older ones are recorded as skipped, not replayed in a burst.
- **Chat.** Interactive chat for an owned profile goes through the host's existing Hermes API (`/v1/runs`). A desktop connected elsewhere reaches it by run delegation (`"peer": did`).

### State and handoff

Run state is the content-addressed ledger, replicated continuously, so a profile can move or survive a node loss with at most one turn of loss.

- **What moves.** The session ledger (signed head plus blocks), cron run state (`last-run`/`next-run` per job, stored as a ledger entry), and memories. Definitions are not copied; they come from git.
- **What does not move.** Large SQLite files such as `state.db`, the FTS index and caches. The new owner rebuilds them lazily from the ledger, which is why a 669 MB `state.db` does not block a handoff.
- **Continuous replication.** After every turn the owner pushes the new blocks and head to yataverse. Recovery after a crash therefore loses at most the in-flight turn.
- **Store: yataverse, not R2.** Decided 2026-10-09: replicated blocks live on yataverse, the content-addressed bytes plane that verifies every read and write against its CID. Neither murakumo R2 nor kotobase is used. Writes carry a tenant Biscuit, minted per node, like the kagi reveal.
- **CID codec.** yataverse names a block by the CID of its raw bytes (raw codec, `bafkrei…`), while the Hy ledger currently tags CIDs with the dag-json codec. The ledger switches to raw-codec CIDv1 before Phase 4, so a block's ledger CID and its yataverse CID are the same string.
- **Planned handoff.**
  1. The reconciler marks the lease `:draining`.
  2. The old owner finishes or stops its running turn, publishes its final head, and releases.
  3. The new owner acquires with `epoch + 1`, pulls and verifies the chain (`Ledger.adopt`), and starts ticking.
- **Unplanned loss.** The lease expires after its TTL. The new owner acquires with `epoch + 1` and continues from the last replicated head.
- **Fencing.** Each ledger append and cron-state write carries the epoch. The store and peers reject writes whose epoch is older than the current lease, so a slow or partitioned former owner cannot overwrite the new owner's history.

### Secrets

Each node holds only the credentials of the profiles it currently owns, revealed through kagi, and deletes them when the lease ends.

A granted lease triggers a governed kagi reveal of that profile's `.env` to the node, as the existing one-way flow already requires (ADR-2607198200, ADR-2608312200). Releasing or losing the lease deletes the materialized `.env`. Profiles that need signing keys or wallets are `:attested` and never move off the operator side.

### Desktop

The desktop stops scanning disk and stops ticking. It reads the control plane's read model and talks to profile owners.

- **No full scans on timers.** Phase 1 already replaced the status bar's poll with a single-profile call and bounded list scans ([[profile-distribution#Desktop relief]]). With fleet placement, lists come from the paginated `GET /api/profiles` read model instead of local disk.
- **No local multiplexer.** The local gateway runs only profiles pinned to the workstation (development, `:attested`). Everything else is owned by fleet nodes.
- **Routing.** Chat for a profile goes to its owner, found through the read model, over the tailnet. It uses run delegation when the desktop is connected to a local gateway.
- **Fleet view.** The Agents screen shows owner node, lease state, queue latency and last run per profile, from the read model.

## Desktop relief

Phase 1, implemented: the desktop's own per-profile cost is bounded, independent of where profiles run. It changes no fleet behavior.

- **Shared, briefly reused scans.** Concurrent `listProfiles()` callers share one in-flight scan, and a finished list is reused for 3 s ([[src/main/profiles.ts#listProfiles]]). Writes that change the list invalidate it: metadata writes in `profile-meta.ts`, plus create and delete, through [[src/main/profile-cache.ts#invalidateProfileCache]].
- **Per-profile memo.** Config, `.env`/SOUL presence, skill count, metadata and cron state are reused until one of five watched files changes (profile dir, `config.yaml`, `profile-meta.json`, `cron/jobs.json`, `cron/executions.db-wal`), or 60 s pass. The synchronous cron SQLite read happens only on change.
- **One multiplexer read per scan.** `gateway_state.json` is read once per scan, not twice per profile.
- **Single-profile status.** [[src/main/profiles.ts#getProfileSummary]] (`get-profile-summary` IPC) serves the status bar and the Agents post-switch poll, which used to run a full scan every 4 s and every 700 ms respectively.
- **Async startup token scan.** [[src/main/kotoba-cloud-account.ts#profilesWithPlaintextKotobaToken]] finds `.env` files with a plaintext token asynchronously, so the synchronous keychain migration touches only those, not all ~1,000 before the first window.

Measured on the workstation's 1,015 profiles, 2026-10-09:

| Call | Before | After |
|---|---|---|
| Status bar refresh (every 4 s) | 2.0–2.6 s, main thread blocked up to 646 ms | 13 ms, blocked 5 ms |
| List rescan (Office, every 4 s while visible) | 2.0–2.6 s, blocked up to 646 ms | 0.2–0.6 s, blocked ≤ 41 ms; 0 ms within the 3 s reuse |
| First scan after launch | 2.6 s | ~3 s, once (every profile is read) |

Avatars stay in the list payload: no profile on the workstation has one, so they cost nothing today.

### Tests

The cache's contract, checked against a temporary HERMES_HOME (`src/main/profiles.test.ts`, `src/main/kotoba-token-scan.test.ts`).

#### One multiplexer read per scan

A scan reads the multiplexer record once however many profiles there are, and still reports served profiles as running and shared.

#### Concurrent callers share one scan

Simultaneous `listProfiles()` calls share one scan, a call within the reuse window does not scan, and a call after it does.

#### Unchanged profiles are not re-read

After the reuse window, only a profile whose cron file changed has its cron state read again; the others are served from the memo.

#### Mutations invalidate the cache

A rename followed immediately by `listProfiles()` returns the new name, without waiting for the reuse window.

#### Summary reads one profile

`getProfileSummary` reads only the requested profile, returns null for unknown or invalid ids, and answers for `default`.

#### Startup token scan is async and selective

The startup scan returns only the profiles whose `.env` contains `KOTOBA_API_KEY`, ignoring profiles without one or without an `.env`.

## Shard host implementation

Phase 2, implemented in `gateway-hy/kotoba_gateway/shard.hy`: one heap for every profile's cron schedule, calling upstream's own tick only for profiles that are due.

Upstream's multiplexer visits every served profile every 60 s, whether or not anything is due: a liveness probe, the profile's cron lock, a `jobs.json` read, sweeps and a heartbeat write. The shard host replaces only that loop. Job execution, delivery, misfire grace and fire claims stay upstream's, because a due profile is handed to upstream `tick()` inside that profile's scope (`cron.scheduler_provider._profile_cron_scope`).

- **Index.** `ProfileIndex` stats every profile's `cron/jobs.json` once per rescan (60 s) and re-reads only changed files. A profile's due time is its earliest active job's `next_run_at`; an active job without one counts as due now.
- **Heap.** One min-heap of `(due, profile)` with lazy invalidation. Idle cost per profile is one heap entry and one `stat` per minute.
- **Bounded ticks.** At most `--max-turns` profiles tick at once (default half the cores). Upstream itself hands jobs to detached worker processes, so upstream's cron parallel limit still bounds the jobs themselves.
- **Housekeeping.** In run mode every profile is still ticked at least every 6 h, spread by name, so upstream's sweeps and heartbeats keep running for profiles with nothing due.
- **Modes.** `--shard observe` indexes, schedules and records what would fire without executing anything, so it is safe next to a live multiplexer. `--shard run` ticks, and exits with 78 while an upstream multiplexer is live (`--shard-force` overrides), so no job runs twice.
- **Status and cost.** `GET /v1/shard` reports profiles, jobs, heap size, fires, rescan time, CPU and memory. `--shard-report` prints per-profile cost (EMA of run duration) and fire rate from the last 7 days of `cron/executions.db`.

### Measurements

Measured on the workstation, 2026-10-09: the shard host in observe mode over all 1,015 profiles and 1,774 jobs, running next to the live upstream multiplexer for 3.5 minutes.

| | Shard host (observe) | Upstream multiplexer |
|---|---|---|
| Profiles / jobs | 1,015 / 1,774 (946 on the heap) | 1,012 served |
| CPU | 0.12% average, 0.0–0.2% sampled | 5–42% sampled (205% the same morning) |
| Memory | 32 MB (156 MB peak at startup) | 176–515 MB (3.1 GB the same morning) |
| Threads / open files | 4 / 18 | 744 / 2,786 |
| Full rescan | 180–500 ms once a minute | every profile, every 60 s |

Observe mode recorded 10 would-be fires in 222 s, consistent with the history below.

Execution history (`--shard-report`, last 7 days): 958 profiles have runs, 2,779 runs a day, 153,644 busy seconds a day. That is **1.78 turns running on average**. The costliest profile (`mithril`, 142 runs a day at 125 s each) averages 0.2 of a turn. The workstation's load comes from per-profile overhead, not from agent work.

### Switch-over

On 2026-10-09 at 11:56 the workstation's cron ticker and Hermes API server (port 8642) moved from upstream's `ai.hermes.gateway` to the shard host in run mode, as the launchd job `cloud.kotoba.shard-gateway`.

`ai.hermes.gateway` was booted out and disabled (`launchctl disable`), so it does not return at login. The service runs a deployment copy in `~/.kotoba/gateway-hy` (commit in its `SOURCE.edn`) with the upstream job's PATH and file limit. Rolling back takes three commands, listed in the plist header: boot out the shard gateway, enable `ai.hermes.gateway`, bootstrap it.

Checked after the switch:

- **Jobs run.** Execution rows are claimed by the shard gateway's pid and complete. Fires land on time ("late 0.1 s"). Failures in the first runs come from the model provider (murakumo unreachable, OpenRouter fallback HTTP 402), the same outage as before the switch.
- **Heartbeats.** Per-profile ticker markers are written after each tick. The default home's heartbeat stays under 60 s, and `hermes-cron-guard --fallback-tick` reports `FRESH ... nothing to do`, so it does not start its own ticks.
- **Live cost while running jobs.** 4–13% CPU (5.7% average), 268 MB, 56 threads, 82 open files. Upstream used 205% CPU, 3.1 GB, 744 threads and 2,786 files that morning.

### Findings

What the measurement and switch surfaced, and how each was resolved.

- **Node key not durable in HERMES_HOME.** `~/.hermes/kotoba-node.key` from 2026-10-08 was gone the next day, cause unknown. Resolved: node key, ledger and peer table now live in `~/.kotoba/homes/<id>/` (id from the home's real path), and files found in HERMES_HOME are moved there once.
- **`profiles/default` shadowed the root home.** The workstation has a `profiles/default` directory with no jobs. The index keyed it as `default`, so the host heartbeat went to `profiles/default/cron/` and the guard saw the root heartbeat age. Resolved: `default` always means HERMES_HOME, as upstream resolves it, and `profiles/default` is skipped.
- **Ticker heartbeats.** Resolved: run mode writes upstream's markers per profile after each tick and keeps the default home's heartbeat fresh. Profiles with nothing due still beat only at housekeeping (≤ 6 h); accepted.
- **Delivery without live adapters.** Accepted: no profile on the workstation has messaging-bot credentials, 1,749 of 1,774 enabled jobs deliver `local`, and the rest use the internal bot-chat mailbox that upstream's tick drains.

### Tests

The scheduler's contract, with a temporary HERMES_HOME, a fake clock and a recording tick (`gateway-hy/tests/test_shard.hy`).

#### Earliest active job sets a profile's due time

A profile is due at its earliest active job's `next_run_at`. Disabled and paused jobs are ignored, and an active job without `next_run_at` is due now.

#### Unchanged profiles cost one stat

After the first scan, a rescan re-reads nothing until a `jobs.json` changes, and then re-reads only that profile.

#### Only due profiles are ticked

Run mode ticks a profile only once its due time has passed, then re-reads its `jobs.json` and reschedules it at the advanced due time.

#### Observe mode never executes

Observe mode records due profiles as fires without ever calling the tick.

#### Concurrent ticks are bounded

With six due profiles and `max-turns` 2, no more than two ticks run at once, and all six complete.

#### Run mode refuses a live multiplexer

The guard reports a running multiplexer whose pid is alive, and ignores a missing record or a stopped gateway.

#### Cost report comes from execution history

The cost report derives a profile's cost EMA, fire rate and busy seconds from its `executions.db`.

## Lease client

Phase 3, shard-host side (`gateway-hy/kotoba_gateway/lease.hy`): a node ticks a profile only while it holds that profile's lease from the murakumo control plane.

The control plane is `cloud-murakumo` `profile-leases` (pure placement and leases) and `profiles-http` (D1 adapter), on branch `claude/profile-leases`. Its routes:

- `PUT /api/profiles/registry` and `PUT /api/profiles/nodes/:did` register profiles and nodes (admin bearer `MURAKUMO_PROFILES_ADMIN_TOKEN`).
- `GET /api/profiles` is the placement view.
- `POST /api/profiles/nodes/:did/heartbeat` is the node's signed heartbeat.

- **Heartbeat.** Every 120 s (`--lease-interval`) the node posts `observed_at_ms` (strictly growing), the leases it holds and its caps and capacity. The body is signed with the node's Ed25519 key over `murakumo-profile-lease-v1\n<did>\n<origin>\n<sha256(body)>\n`, base64url in `x-murakumo-signature`. The answer is the node's lease set, with `expires_at`.
- **Local expiry.** A lease's expiry is converted to the local clock from the server's own `now`, counted from when the request was sent. Clock skew cannot stretch a lease, and latency only shortens it.
- **Fail closed.** A failed heartbeat keeps current leases until they expire, then the profiles stop.
- **Two checks.** The shard host's `allow` predicate is applied when scheduling and again right before each tick, so a lease lost in between is never acted on. Lease changes re-schedule every indexed profile.
- **Flags.** `--lease-url https://murakumo.cloud` turns lease mode on, `--node-caps` sets advertised capabilities, and the first heartbeat completes before the first scan.
- **Registry.** `tools/lease_plan.py` pins every profile to the workstation and N canaries to a canary node. Canaries have no secrets in their `.env`, only `local` deliveries, and the lowest measured cost. Profiles whose `.env` holds keys or tokens are registered `attested`. Dry run on 2026-10-09: 1,015 profiles, 328 attested, 685 canary candidates.

Verified across languages: the Hy client against the real `profiles-http` handler served by `test/profiles_http_dev_server.cljk` (node:sqlite, real migrations). Both nodes got their pinned leases and renewed them, and a signature bound to another origin got `401 bad-signature`. That run caught one real mismatch (a kebab-case `expires-at` on the wire), fixed in the handler.

### Tests

The client's contract with a scripted control plane, and the shard host in lease mode (`gateway-hy/tests/test_lease.hy`).

#### Heartbeats are signed under the lease domain

The signed bytes match the control plane's framing literally, and the heartbeat's signature verifies against the node's did over the body's digest.

#### Expiry is counted on the local clock

With the server clock an hour ahead, a 600 s lease is held for exactly 600 s of local time.

#### Leases run out when the plane is unreachable

A failed heartbeat keeps a lease until its local expiry and then disallows the profile.

#### Observed time strictly grows

Two heartbeats at the same clock reading carry strictly increasing `observed_at_ms`.

#### Lease changes are announced

The change callback fires when the set of leased profiles changes, not on a plain renewal.

#### Only leased profiles are ticked

In run mode with an `allow` predicate, only the leased profile ticks. Gaining a lease and re-applying schedules the other one.

#### A lease lost before the tick is not acted on

A profile whose lease was lost after scheduling is not ticked when its turn comes.

## Capacity

Spreading 949 cron-bearing profiles over the 9 schedulable Macs gives about 105 profiles per node. Phase 2 showed that idle cost is negligible with the heap (0.12% CPU for all 1,015 profiles) and that actual work averages 1.78 concurrent turns ([[profile-distribution#Shard host implementation#Measurements]]).

So compute is not what forces distribution: one node at 50% of five turns could carry today's load. Distribution buys isolation (one bad profile or node doesn't stall the rest), availability when the workstation sleeps, and headroom for growth. Placement weights should still follow measured cost, because three profiles (`mithril`, `kotobase-ldbc`, `otent`) account for a fifth of all busy time.

Sizing rule: a node's `max-turns` bounds concurrent work, and its sustainable load is `Σ(cost EMA × fire rate)` over its profiles, which must stay below `max-turns` with headroom. The reconciler enforces this via queue latency, seeded with the measured cost EMAs from `--shard-report`.

Upstream's idle overhead is about 0.7 threads and 2.8 open files per served profile. The heap design held all 1,015 profiles at 0.12% CPU, 4 threads and 18 files.

## Failure modes

How the design behaves when parts fail, and what each costs.

| Failure | Behavior | Cost |
|---|---|---|
| Node dies | Lease expires (10 min), the reconciler reassigns, and the new owner continues from the last replicated head | ≤ 10 min of delayed fires, at most one in-flight turn lost |
| Node partitioned | The node can't renew, so it stops ticking at TTL (fail closed). The control plane reassigns after TTL | Same as node death, never two tickers |
| Control plane down | No renewals, so hosts stop ticking at TTL. Nobody can be granted a conflicting lease | Crons pause until it returns. Running chats continue |
| Slow former owner writes late | Epoch fencing rejects the write | None |
| Hot node | Queue latency exceeds budget for 3 passes, and the reconciler moves its costliest profiles | Brief handoff per moved profile |
| Workstation sleeps or reboots | Only its pinned profiles pause | Fleet profiles unaffected |

## Rollout

Ordered so the desktop gets relief immediately, and each later phase can be stopped without stranding profiles.

1. **Desktop relief (local, no fleet). Done**, see [[profile-distribution#Desktop relief]]. Status-bar refresh fell from ~2 s to 13 ms, and list rescans from ~2 s to 0.2–0.6 s with the main thread blocked at most 41 ms.
2. **Shard host mode, measured locally. Done**, see [[profile-distribution#Shard host implementation]]. Observe mode over all 1,015 profiles: 0.12% CPU, 32 MB, 4 threads. Since 2026-10-09 the workstation runs `--shard run` instead of the upstream multiplexer ([[profile-distribution#Shard host implementation#Switch-over]]).
3. **Leases and reconciler. Implemented**, not yet deployed: control plane in cloud-murakumo (`claude/profile-leases`), lease client in the shard host ([[profile-distribution#Lease client]]). Canary: 20 `:anonymous` profiles on benjamin, everything else pinned to the workstation. Going live needs the cloud-murakumo merge and deploy, the D1 migration, the admin secret, and a Hermes install on benjamin (it has none).
4. **Replication and secrets.** Continuous ledger push, planned and unplanned handoff, and per-lease kagi reveal. Kill the canary node and confirm recovery within the TTL.
5. **Fleet rollout.** Supersede the devices.edn rule with an ADR, then move all `:anonymous` profiles. The workstation keeps `:attested` and pinned profiles only.

## Open questions

Decisions this design needs before Phase 3.

- **Residency classification.** Which of the 1,015 profiles are `:attested`? Needs a pass over their secrets references.
- **Model access per node.** Profiles whose provider is a hosted API run anywhere. Local-model profiles need nodes with the model loaded, as a placement capability.
- **Upstream compatibility.** The shard host runs Hermes' `AIAgent` per turn. Whether all profile features (MCP servers, plugins, messaging platforms) work without a resident gateway per profile needs checking during Phase 2.
- **ADR.** Wording of the decision that supersedes "only the workstation ticks a profile".

#### Run mode keeps ticker heartbeats

After each tick the heartbeat hook receives the profile and its error (None on success). The default home's heartbeat is written at most once a minute.

#### Observe mode writes no heartbeats

Observe mode has no heartbeat hook, so it never touches upstream's markers while the multiplexer owns them.

#### Node state lives outside HERMES_HOME

The node key moves from HERMES_HOME to its `~/.kotoba/homes/<id>` directory once. The move is idempotent, and different homes get different directories.

#### A profiles/default directory never shadows the root home

With both a root `cron/jobs.json` and a `profiles/default` directory, the `default` entry is the root home, and the host heartbeat goes to the root home.
