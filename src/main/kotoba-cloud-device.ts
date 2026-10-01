// @lat: [[kotoba-cloud-account#Kotoba Cloud account#Device sign-in]]
/**
 * Kotoba Cloud sign-in by the device grant (RFC 8628) — the Passkey happens in
 * the person's own browser, not in an Electron window.
 *
 * Why not a window: a Passkey inside an Electron BrowserWindow does not reach
 * the platform authenticator the person actually has (on macOS the iCloud
 * Keychain passkey is offered only to apps holding the browser entitlement;
 * the cross-device QR sheet is Chrome's own UI), so the old window opened and
 * then never progressed. The device grant moves the whole ceremony to the
 * default browser:
 *
 *   1. POST kotoba.cloud/v1/account/device/code {device_name, scope}
 *      → device_code (this process only), user_code, verification_uri_complete
 *   2. the browser opens verification_uri_complete; the person signs in with
 *      their Passkey there and approves THIS code (the screen shows the
 *      device name and the scopes it will get)
 *   3. POST /v1/account/device/token {device_code} until it answers
 *      {access_token} — a `kc_pat_` minted with exactly `DEVICE_SCOPES`
 *
 * The grant carries no authority of its own: a code only becomes a token
 * after a signed-in Passkey session approves it (app-kotoba-cloud
 * device_grant.cljk). The device code never leaves the main process.
 */
import { hostname } from "os";
import {
  KOTOBA_CLOUD_ORIGIN,
  KotobaCloudSessionError,
  requestKotobaCloudJson,
} from "./kotoba-cloud-session";

/**
 * What the desktop's token may do: chat, the balance on the account card,
 * profile backup (/v1/agents), the org billing switcher, and launching the
 * person's hosted Hermes. Never `account` or `wallets`.
 */
export const DEVICE_SCOPES = [
  "inference",
  "billing:read",
  "agents",
  "org:read",
  "sandbox",
] as const;

const CODE_URL = `${KOTOBA_CLOUD_ORIGIN}/v1/account/device/code`;
const TOKEN_URL = `${KOTOBA_CLOUD_ORIGIN}/v1/account/device/token`;

export interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  /** Seconds between polls the server asked for. */
  interval: number;
  /** Epoch ms after which the code is dead. */
  expiresAt: number;
}

type Fetcher = typeof requestKotobaCloudJson;

function str(x: unknown): string | null {
  return typeof x === "string" && x.length > 0 ? x : null;
}

/** Step 1: ask for a code pair. Refusals are thrown by name. */
export async function startDeviceGrant(
  request: Fetcher = requestKotobaCloudJson,
  now: () => number = Date.now,
): Promise<DeviceGrant> {
  const { status, body } = await request(CODE_URL, {
    method: "POST",
    body: {
      device_name: `Kotoba desktop · ${hostname()}`.slice(0, 64),
      scope: DEVICE_SCOPES.join(" "),
    },
  });
  const b = (body ?? {}) as Record<string, unknown>;
  const deviceCode = str(b.device_code);
  const userCode = str(b.user_code);
  const uri = str(b.verification_uri);
  const complete = str(b.verification_uri_complete);
  if (status !== 200 || !deviceCode || !userCode || !uri || !complete) {
    const error = str(b.error) ?? `HTTP ${status}`;
    throw new KotobaCloudSessionError(
      `kotoba.cloud did not start a device sign-in: ${error}`,
      error,
      status,
    );
  }
  // only ever send the person to kotoba.cloud's own approval screen
  if (new URL(complete).protocol !== "https:") {
    throw new KotobaCloudSessionError(
      `The approval URL must be https: ${complete}`,
      "request-failed",
    );
  }
  const interval =
    typeof b.interval === "number" && b.interval > 0 ? b.interval : 5;
  const expiresIn =
    typeof b.expires_in === "number" && b.expires_in > 0 ? b.expires_in : 600;
  return {
    deviceCode,
    userCode,
    verificationUri: uri,
    verificationUriComplete: complete,
    interval,
    expiresAt: now() + expiresIn * 1000,
  };
}

/**
 * Step 3: poll until the person approves (→ the token), denies, or the code
 * expires. `slow_down` widens the interval by 5 s as RFC 8628 §3.5 says.
 * `cancelled()` is checked before every poll so closing the dialog stops it.
 */
export async function pollDeviceGrant(
  grant: DeviceGrant,
  opts: {
    request?: Fetcher;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    cancelled?: () => boolean;
  } = {},
): Promise<string> {
  const request = opts.request ?? requestKotobaCloudJson;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const cancelled = opts.cancelled ?? (() => false);
  let interval = grant.interval;
  while (true) {
    await sleep(interval * 1000);
    if (cancelled())
      throw new KotobaCloudSessionError(
        "Kotoba Cloud sign-in was cancelled.",
        "sign-in-cancelled",
      );
    if (now() >= grant.expiresAt)
      throw new KotobaCloudSessionError(
        "The sign-in code expired before it was approved. Start again.",
        "expired_token",
      );
    const { status, body } = await request(TOKEN_URL, {
      method: "POST",
      body: { device_code: grant.deviceCode },
    });
    const b = (body ?? {}) as Record<string, unknown>;
    const token = str(b.access_token);
    if (status === 200 && token) return token;
    const error = str(b.error) ?? `HTTP ${status}`;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5;
      continue;
    }
    if (error === "access_denied")
      throw new KotobaCloudSessionError(
        "The sign-in was denied in the browser.",
        "access_denied",
        status,
      );
    if (error === "expired_token")
      throw new KotobaCloudSessionError(
        "The sign-in code expired before it was approved. Start again.",
        "expired_token",
        status,
      );
    throw new KotobaCloudSessionError(
      `kotoba.cloud could not finish the sign-in: ${error}`,
      error,
      status,
    );
  }
}
