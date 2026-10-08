# Hy gateway

Kotoba's local Hermes API server, written in Hy (`gateway-hy/`). It replaces upstream `hermes gateway` as the process the desktop spawns per profile, while staying wire-compatible with the Hermes Agent API.

The desktop's main process already speaks the Hermes API for remote and gateway-only setups (`sendMessageViaRuns` → `sendMessageViaApi`). The Hy gateway implements exactly that surface, so the desktop needs no new protocol: it spawns a different process on the same port and keeps talking HTTP.

## Hermes API surface

The routes mirror upstream `gateway/platforms/api_server.py`, with the same JSON and SSE shapes, and are also served under `/p/<profile>/`.

- `GET /health` (unauthenticated), `/health/detailed`, `/api/status`
- `GET /v1/capabilities`, `/v1/models`
- `POST /v1/chat/completions`: OpenAI chunks, `event: hermes.tool.progress` frames, `X-Hermes-Session-Id`
- `POST /v1/runs` → `202 {run_id}`; `GET /v1/runs/{id}`; `GET /v1/runs/{id}/events`; `POST /v1/runs/{id}/stop`

Run events keep upstream names and key order (`event`, `run_id`, `timestamp`, …): `message.delta`, `reasoning.available`, `tool.started`, `tool.completed`, `approval.request`, `run.completed|failed|cancelled`. Bearer auth uses `API_SERVER_KEY` from the environment or `HERMES_HOME/.env`; a non-loopback bind without a key is refused (exit 78), as upstream does.

## Hermes Agent backend

Each turn builds a Hermes Agent `AIAgent` in-process with upstream's own runtime helpers, so sessions persist to the profile's `state.db` exactly as upstream API turns do.

The helpers are `_resolve_runtime_agent_kwargs`, `_get_platform_tools(..., "api_server")`, and the fallback and reasoning config loaders.

The gateway runs under the Hermes venv's python (`HERMES_PYTHON`) with `cwd=HERMES_REPO`. Its only extra dependency is Hy, vendored into `gateway-hy/.deps` by `npm run gateway:deps`; nothing is installed into the Hermes venv. Tool approvals register a gateway notify that surfaces `approval.request`. A client disconnecting from the event stream interrupts the agent.

An `echo` backend (`--backend echo`) needs no Hermes install and backs the contract tests.

## Desktop integration

[[src/main/kotoba-gateway.ts#gatewayRuntime]] selects the runtime: `hy` by default, or `hermes` via `KOTOBA_GATEWAY_RUNTIME=hermes` for upstream messaging platforms.

In `hy` mode, `startGatewayDetailed` spawns [[src/main/kotoba-gateway.ts#kotobaGatewayArgs]] (launcher, `--port`, `--pid-file`) with `HERMES_HOME` set to the profile home. The pid file is `kotoba-gateway.pid`, never `gateway.pid`, so a user's running upstream gateway or multiplexer ([[gateway-multiplex]]) is not mistaken for it, and multiplexer checks are skipped. Restart is stop, then start, then poll `/health`.

The main window gets `--kotoba-gateway-runtime=<runtime>` as an extra argument, and preload exposes it as `window.electron.kotobaGatewayRuntime`. In local mode with the `auto` transport, [[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#localChatTransportPreference]] picks the `/v1` transport, so chat reaches the Hy gateway rather than the upstream dashboard WebSocket. Picking `dashboard` explicitly still works.

Packaged builds ship `gateway-hy/` (with `.deps`) as `extraResources`.

## Tests

Contract tests in `gateway-hy/tests/test_gateway.hy` run the echo backend over real HTTP (`npm run test:gateway`). The runtime switch is covered in `src/main/kotoba-gateway.test.ts`, the transport choice in `useDashboardChatTransport.test.tsx`.

### Health is unauthenticated

`GET /health` answers without a bearer token and reports `platform: hermes-agent`, matching upstream liveness probing.

### Bearer auth is enforced

A wrong bearer token on an authenticated route returns 401.

### Capabilities advertise runs

`/v1/capabilities` advertises `run_submission` and the run events path, and works under the `/p/<profile>/` prefix.

### Runs stream message deltas then completion

`POST /v1/runs` returns 202 with the requested session id, and the event stream carries tool events and `message.delta` frames, then ends with `run.completed` holding the final output.

### Chat completions stream OpenAI chunks

Streaming chat echoes `X-Hermes-Session-Id`, emits `chat.completion.chunk` content deltas, and ends with `[DONE]`.

### Chat completions without streaming

Non-streaming chat returns one `chat.completion` with the assistant message.

### Unknown runs are 404

Stopping a run id the gateway never issued returns 404.

### Message splitting

OpenAI messages split into system instructions, text-only history, and the final user turn. A conversation that does not end on a user message is rejected.

### Runtime defaults to hy

The desktop uses the Hy gateway unless `KOTOBA_GATEWAY_RUNTIME=hermes`, and treats unknown values as `hy`.

### Spawn uses its own pid file per profile

Spawn args carry the launcher, the profile's port and `kotoba-gateway.pid` in the profile home. The env points `HERMES_HOME` at that profile.

### Local auto chat uses the Hermes API

Local `auto` chat switches to the `/v1` transport only when the Hy gateway is active. Explicit preferences and remote connections are left unchanged.
