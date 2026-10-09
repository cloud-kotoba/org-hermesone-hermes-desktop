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
- **Continuous replication.** After every turn the owner pushes the new blocks and head to a shared store (murakumo R2, which already holds actions receipts, or kotobase). Recovery after a crash therefore loses at most the in-flight turn.
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

- **No full scans on timers.** Replace the 4 s `listProfiles()` polls in StatusBar and Office with a single-profile status call for the active profile, plus the paginated `GET /api/profiles` read model for lists. Drop avatars from list payloads, cache `liveMultiplexer` once per call, and read cron state asynchronously with an mtime cache.
- **No local multiplexer.** The local gateway runs only profiles pinned to the workstation (development, `:attested`). Everything else is owned by fleet nodes.
- **Routing.** Chat for a profile goes to its owner, found through the read model, over the tailnet. It uses run delegation when the desktop is connected to a local gateway.
- **Fleet view.** The Agents screen shows owner node, lease state, queue latency and last run per profile, from the read model.

## Capacity

Spreading 949 cron-bearing profiles over the 9 schedulable Macs gives about 105 profiles per node. That is tractable once idle cost is a heap entry instead of open handles.

Sizing rule: a node's `max-turns` bounds concurrent work, and its sustainable load is `Σ(cost EMA × fire rate)` over its profiles, which must stay below `max-turns` with headroom. The reconciler enforces this via queue latency rather than up-front estimates, because per-profile cost is not measured yet. Phase 1 measures it.

Upstream per-profile overhead was about 3 threads and 3 file descriptors per served profile at zero activity, plus 205% CPU across 1,012 profiles. The heap design targets under 1% CPU at idle for 100 profiles; Phase 1 checks that number.

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

1. **Desktop relief (local, no fleet).** Remove the full-scan polls, the duplicate multiplexer reads, the synchronous sqlite calls and the avatar payload. This fixes the freezing on its own.
2. **Shard host mode, measured locally.** Implement `--shard` (heap scheduler, lazy agents) in the Hy gateway. Run it on the workstation with all profiles in place of the upstream multiplexer, and measure idle CPU, memory, and per-profile cost EMA.
3. **Leases and reconciler.** Add the profile registry, lease table and reconciler to cloud-murakumo. Canary: 20 `:anonymous` profiles on benjamin, everything else stays on the workstation.
4. **Replication and secrets.** Continuous ledger push, planned and unplanned handoff, and per-lease kagi reveal. Kill the canary node and confirm recovery within the TTL.
5. **Fleet rollout.** Supersede the devices.edn rule with an ADR, then move all `:anonymous` profiles. The workstation keeps `:attested` and pinned profiles only.

## Open questions

Decisions this design needs before Phase 3.

- **Residency classification.** Which of the 1,015 profiles are `:attested`? Needs a pass over their secrets references.
- **Shared store.** murakumo R2 vs kotobase for replicated ledger blocks.
- **Model access per node.** Profiles whose provider is a hosted API run anywhere. Local-model profiles need nodes with the model loaded, as a placement capability.
- **Upstream compatibility.** The shard host runs Hermes' `AIAgent` per turn. Whether all profile features (MCP servers, plugins, messaging platforms) work without a resident gateway per profile needs checking during Phase 2.
- **ADR.** Wording of the decision that supersedes "only the workstation ticks a profile".
