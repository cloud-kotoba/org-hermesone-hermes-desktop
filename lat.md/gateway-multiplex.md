# Multiplexed gateway status

A profile with no `gateway.pid` of its own is not necessarily off. With `gateway.multiplex_profiles` on, one process — the default profile's gateway — serves every profile on the host, and no named profile gets a pid file.

Measured 2026-09-22 on this fork's workstation: 93 profiles, one live gateway (`~/.hermes/gateway.pid` → pid 37295), `served_profiles` in `~/.hermes/gateway_state.json` listing all 93, zero per-profile `gateway.pid` files, and `hermes profile list` reporting Gateway=running for every one of them. The desktop's Agents page showed 92 of the 93 as **Off**, and the row the operator started spun on **Starting…** until the poll gave up, because [[src/main/profiles.ts#isGatewayRunning]] read only the per-profile pid file. Starting one by hand reproduces what the app's spawn would have hit:

```
✗ The default gateway is running as a profile multiplexer and already serves profile 'akc-blog-i18n'.
                                                                                          (exit 78)
```

[[src/main/gateway-multiplex.ts]] is the one place that answers "which profiles does the live gateway serve", so the status read and the start guard cannot disagree.

## Where the answer comes from

The truth about a running process is the record that process writes. The gateway stamps `served_profiles` into the default home's `gateway_state.json` at startup; the CLI reads that same record, and this module mirrors it.

The writer is `gateway/run_adapters.py::_record_served_profiles`; the CLI's reader is `hermes_cli/gateway_multiplex_served.py`.

Reading the config instead would be a guess: `hermes -p coder …` loads coder's `.env`, so an env-only opt-in on the default profile is invisible to it, and an allowlist edited after start flips the guess before the restart that would make it true.

## Unknown is a third answer

[[src/main/gateway-multiplex.ts#liveMultiplexer]] returns `null` — not an empty list — when it cannot establish a live multiplexer.

That covers: no record; a `gateway_state` that is not `running`; a pid that is dead or contradicted by `gateway.pid`; unparseable JSON; and a build old enough not to record `served_profiles` at all.

That distinction is the whole safety of the change. An empty `served` array is an authoritative "serves nobody else"; `null` means "this evidence is unavailable", and callers fall back to the per-profile pid file they used before multiplexing existed. Collapsing the two would let a crashed gateway's leftover record answer questions about a live one, or a dead process claim a profile is being served.

## What the two callers do with it

[[src/main/profiles.ts#isGatewayRunning]] asks first, so a served profile reads **Running** instead of **Off**, and [[src/main/profiles.ts#listProfiles]] sets `gatewayShared` on the row so the pill's tooltip can say *Served by the shared gateway* rather than implying the profile owns a process.

[[src/main/hermes.ts#startGatewayDetailed]] refuses to spawn for a served profile and reports `alreadyRunning`. Spawning would only write the CLI's exit-78 refusal into `gateway-stderr.log` and leave the renderer's 10-second poll waiting for a pid file that is never going to appear.

## Tests

[[src/main/gateway-multiplex.test.ts]] writes real `gateway_state.json` and `gateway.pid` fixtures into a temp home and checks both directions: a served profile, an unserved one, and every way the evidence can be unavailable.

`deadPid()` proves its pid is not alive before using it, so the "dead recorder" cases cannot quietly degrade into "alive" on a platform with a larger pid space.

### Reads the live gateway's served list

A record written by a live process and listing the profile reports it served, and exposes the recorded list and its non-default members.

### A profile outside the list is not served

When a live gateway records a list that omits the profile, the answer is a confident false — the record is readable, and "serves nobody else" is an answer, not an absence of one.

### A dead recorder is unknown, not empty

A record whose `pid` names no live process yields `null`, so nothing downstream treats a crashed gateway's leftover list as the current one.

### A record without served_profiles is unknown

A gateway old enough not to record the key yields `null` rather than an empty list, so "we cannot tell" never reads as "nothing is served".

### A stopped gateway serves nothing

A record whose `gateway_state` is not `running` yields `null`, even when its `served_profiles` list is fully populated.

### A pid file that disagrees wins nothing

When `gateway.pid` names a different process than the record does, the record is not about the process that owns this home and is refused.

### A missing record is unknown

With no `gateway_state.json` at all the module reports `null` and serves nobody, which is what a machine that has never run a multiplexer should say.

### Unparseable JSON is unknown

A truncated or corrupt record yields `null` instead of throwing into a status read.

### The default profile is served by its own gateway

The default profile is what the multiplexer runs as, so a live multiplexer always serves it, asked by name, by `undefined`, or by home path.

### Profile paths resolve to profile names

`multiplexerServesHome` maps `<home>/profiles/<name>` to the name the record uses, which is what `listProfiles` has to work with.

### A malformed profile name is not served

A name that cannot be normalised answers false instead of throwing, so one bad directory name cannot break the whole profile listing.
