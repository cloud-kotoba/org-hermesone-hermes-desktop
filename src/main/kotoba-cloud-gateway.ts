// @lat: [[kotoba-cloud-gateway#Kotoba Cloud gateway]]
/**
 * The gateway kotoba.cloud provides: the person's own Hermes running in a
 * per-user Modal Sandbox behind app.kotoba.cloud (cloud-kotoba/app-hermes-
 * sandbox "dashboard sessions", 2026-09-22). The worker owns sign-in and
 * billing — POST /v1/sandbox/session launches or resumes (one flat charge),
 * GET reports (free), DELETE stops (free) — and hands back the sandbox's own
 * tunnel URL carrying a signed, expiring `?hs=` handoff that the in-sandbox
 * gate validates. Sessions live at most 3 h.
 *
 * This module drives that lane with the desktop's Kotoba Cloud session
 * (kotoba-cloud-session.ts) and opens the returned dashboard in a window on
 * its own partition: the stock Hermes web UI, same-origin against the
 * sandbox, so chat, PTY and WebSockets all just work. It does NOT retarget
 * the desktop's native chat transport at the sandbox — the sandbox's gate
 * authenticates by cookie and the dashboard inside runs in loopback mode
 * (SPA-injected session token), a pairing upstream's Remote transport has
 * no mode for; that is the follow-up named in lat.md, not something this
 * pretends to do.
 */
import { BrowserWindow, session } from "electron";
import {
  KOTOBA_APP_ORIGIN,
  KotobaCloudSessionError,
  requestKotobaCloudJson,
} from "./kotoba-cloud-session";

export const KOTOBA_GATEWAY_PARTITION = "persist:kotoba-cloud-gateway";

/**
 * What the frame says. The window hosts the in-sandbox Hermes dashboard, so
 * without pinning this the title bar would carry that page's own name.
 */
export const GATEWAY_WINDOW_TITLE = "Kotoba chat";
const SESSION_URL = `${KOTOBA_APP_ORIGIN}/v1/sandbox/session`;
const STARTING_POLL_MS = 5_000;
const STARTING_DEADLINE_MS = 150_000;

export interface KotobaGatewayStatus {
  /** A sandbox is running for this account. */
  running: boolean;
  /** "ready" | "starting" | "stopped" | a server word. */
  status: string;
  /** The gated tunnel URL (with its handoff token) while running. */
  url: string | null;
  sandboxId: string | null;
  /** The server's error by name when the lane could not answer. */
  error?: string;
}

type Fetcher = typeof requestKotobaCloudJson;

function fold(
  status: number,
  body: unknown,
  fallback: string,
): KotobaGatewayStatus {
  const b = (body ?? {}) as Record<string, unknown>;
  const url = typeof b.url === "string" ? b.url : null;
  const sandboxId = typeof b.sandboxId === "string" ? b.sandboxId : null;
  if (
    status === 200 &&
    (b.running === false || (!url && b.status !== "starting"))
  ) {
    return { running: false, status: "stopped", url: null, sandboxId: null };
  }
  if (status === 200 || status === 202) {
    const word =
      typeof b.status === "string" ? b.status : url ? "ready" : "starting";
    return { running: word !== "stopped", status: word, url, sandboxId };
  }
  const error = typeof b.error === "string" ? b.error : `HTTP ${status}`;
  return {
    running: false,
    status: fallback,
    url: null,
    sandboxId: null,
    error,
  };
}

/** GET — free; 401 reads as sign-in-required, 404 as the lane not deployed. */
export async function kotobaGatewayStatus(
  request: Fetcher = requestKotobaCloudJson,
): Promise<KotobaGatewayStatus> {
  const { status, body } = await request(SESSION_URL);
  if (status === 401)
    return {
      running: false,
      status: "signed-out",
      url: null,
      sandboxId: null,
      error: "sign-in-required",
    };
  if (status === 404)
    return {
      running: false,
      status: "unavailable",
      url: null,
      sandboxId: null,
      error: "sandbox-session-not-deployed",
    };
  return fold(status, body, "unavailable");
}

/**
 * POST — launch or resume (one flat charge), then poll GET while the server
 * says "starting" (cold image pull), up to STARTING_DEADLINE_MS. A refusal
 * (402 usage-limit-exceeded, 503 billing-not-configured / sandbox-gateway-
 * unavailable) is returned by name, never retried into a second charge.
 */
export async function launchKotobaGateway(
  request: Fetcher = requestKotobaCloudJson,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
  now: () => number = Date.now,
): Promise<KotobaGatewayStatus> {
  const { status, body } = await request(SESSION_URL, {
    method: "POST",
    origin: KOTOBA_APP_ORIGIN,
    body: {},
    timeoutMs: 120_000,
  });
  if (status === 401)
    throw new KotobaCloudSessionError(
      "Sign in to Kotoba Cloud first.",
      "sign-in-required",
      401,
    );
  let state = fold(status, body, "refused");
  if (state.error) return state;
  const deadline = now() + STARTING_DEADLINE_MS;
  while (state.status === "starting" && now() < deadline) {
    await sleep(STARTING_POLL_MS);
    state = await kotobaGatewayStatus(request);
    if (state.error) return state;
  }
  return state;
}

/** DELETE — stop now; free. */
export async function stopKotobaGateway(
  request: Fetcher = requestKotobaCloudJson,
): Promise<{ stopped: boolean; error?: string }> {
  const { status, body } = await request(SESSION_URL, {
    method: "DELETE",
    origin: KOTOBA_APP_ORIGIN,
  });
  if (status === 200 || status === 204) return { stopped: true };
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    stopped: false,
    error: typeof b.error === "string" ? b.error : `HTTP ${status}`,
  };
}

let gatewayWindow: BrowserWindow | null = null;

/**
 * Show the person's cloud Hermes: the sandbox's dashboard in a window on the
 * gateway partition (the handoff cookie the gate mints lives there; the
 * renderer never sees it). One window; a second call focuses it.
 */
export function openKotobaGatewayWindow(
  url: string,
  parent?: BrowserWindow | null,
): { opened: boolean } {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new KotobaCloudSessionError(
      `The gateway URL must be https, got ${parsed.protocol}`,
      "request-failed",
    );
  }
  if (gatewayWindow && !gatewayWindow.isDestroyed()) {
    void gatewayWindow.loadURL(url);
    gatewayWindow.focus();
    return { opened: true };
  }
  gatewayWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    title: GATEWAY_WINDOW_TITLE,
    autoHideMenuBar: true,
    ...(parent ? { parent } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: session.fromPartition(KOTOBA_GATEWAY_PARTITION),
      webSecurity: true,
    },
  });
  // The page loaded here is the in-sandbox Hermes dashboard, whose document
  // title is "Hermes Agent - Dashboard" — and Electron lets the document title
  // win over the `title` option above, so the window a Kotoba user opened from
  // Kotoba announced itself as something else in the title bar, the window
  // menu and the app switcher. Keep our own name on the frame; the page's
  // contents are its own.
  gatewayWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    if (gatewayWindow && !gatewayWindow.isDestroyed()) {
      gatewayWindow.setTitle(GATEWAY_WINDOW_TITLE);
    }
  });
  gatewayWindow.on("closed", () => {
    gatewayWindow = null;
  });
  void gatewayWindow.loadURL(url);
  return { opened: true };
}
