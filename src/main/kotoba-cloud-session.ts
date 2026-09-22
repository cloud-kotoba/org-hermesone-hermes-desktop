// @lat: [[kotoba-cloud-account#Kotoba Cloud account#Passkey session]]
/**
 * The desktop's own signed-in session with kotoba.cloud.
 *
 * kotoba.cloud authenticates a person with a Passkey (or wallet) in a
 * browser page — auth.kotoba.cloud/sign-in — and hands back the same-product
 * `gftd_session` cookie (Domain=kotoba.cloud, HttpOnly). This module hosts
 * that page in an Electron window whose cookies live in a partition the
 * renderer never sees (`persist:kotoba-cloud`, the same pattern as
 * remote-oauth.ts), then speaks to kotoba.cloud from the main process with
 * `useSessionCookies`. The desktop never handles the credential itself; it
 * holds the session the person created, like the browser tab would.
 *
 * With that session it can do what the account console does: read the
 * viewer (`GET /v1/session`), issue this machine's personal API token
 * (`POST /v1/account/api-token`, shown once, stored as KOTOBA_API_KEY by
 * kotoba-cloud-account.ts), and — kotoba-cloud-gateway.ts — launch the
 * person's hosted Hermes gateway.
 *
 * The POSTs carry `Origin: https://kotoba.cloud`: the worker's same-origin
 * gate exists to stop a foreign web page from spending a browser's ambient
 * cookies, and this partition is reachable by no web page at all — the
 * desktop is the person's own agent, the same standing as the console tab.
 */
import { BrowserWindow, net, session, type Session } from "electron";
import { hostname } from "os";

export const KOTOBA_CLOUD_PARTITION = "persist:kotoba-cloud";
export const KOTOBA_CLOUD_ORIGIN = "https://kotoba.cloud";
export const KOTOBA_APP_ORIGIN = "https://app.kotoba.cloud";
export const KOTOBA_SESSION_COOKIE = "gftd_session";
export const KOTOBA_SIGN_IN_URL =
  "https://auth.kotoba.cloud/sign-in?return_to=" +
  encodeURIComponent(`${KOTOBA_CLOUD_ORIGIN}/account`);

export interface KotobaCloudViewer {
  valid: boolean;
  username?: string | null;
  principalId?: string | null;
  accountDid?: string | null;
}

export class KotobaCloudSessionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "sign-in-cancelled"
      | "sign-in-timeout"
      | "sign-in-required"
      | "request-failed"
      | string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "KotobaCloudSessionError";
  }
}

export function getKotobaCloudSession(): Session {
  return session.fromPartition(KOTOBA_CLOUD_PARTITION);
}

/** One JSON request against kotoba.cloud with the partition's cookies. */
export function requestKotobaCloudJson(
  url: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    body?: unknown;
    origin?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: options.method ?? "GET",
      redirect: "follow",
      session: getKotobaCloudSession(),
      url,
      useSessionCookies: true,
    });
    request.setHeader("Accept", "application/json");
    if (options.origin) request.setHeader("Origin", options.origin);
    if (options.body !== undefined) {
      request.setHeader("Content-Type", "application/json");
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.abort();
      reject(
        new KotobaCloudSessionError(
          `kotoba.cloud did not answer within ${options.timeoutMs ?? 15_000} ms: ${url}`,
          "request-failed",
        ),
      );
    }, options.timeoutMs ?? 15_000);
    timer.unref?.();
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = { raw: text.slice(0, 200) };
        }
        resolve({ status: response.statusCode, body });
      });
      response.on("error", (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new KotobaCloudSessionError(error.message, "request-failed"));
      });
    });
    request.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new KotobaCloudSessionError(error.message, "request-failed"));
    });
    if (options.body !== undefined) request.write(JSON.stringify(options.body));
    request.end();
  });
}

/** The signed-in viewer, or {valid:false} — never throws on a 401. */
export async function kotobaCloudViewer(): Promise<KotobaCloudViewer> {
  try {
    const { status, body } = await requestKotobaCloudJson(
      `${KOTOBA_CLOUD_ORIGIN}/v1/session`,
    );
    const v = (body ?? {}) as Record<string, unknown>;
    if (status !== 200 || v.valid !== true) return { valid: false };
    return {
      valid: true,
      username: typeof v.username === "string" ? v.username : null,
      principalId: typeof v.principalId === "string" ? v.principalId : null,
      accountDid: typeof v.accountDid === "string" ? v.accountDid : null,
    };
  } catch {
    return { valid: false };
  }
}

/** Forget the session: the partition's cookies go, nothing else. */
export async function signOutKotobaCloud(): Promise<void> {
  await getKotobaCloudSession().clearStorageData({ storages: ["cookies"] });
}

/**
 * Host the Passkey sign-in page in a window on the partition; resolve once
 * `GET /v1/session` answers a valid viewer, reject when the person closes
 * the window or five minutes pass. Nothing is typed by this process.
 */
export function openKotobaCloudSignIn(
  parent?: BrowserWindow | null,
): Promise<KotobaCloudViewer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const win = new BrowserWindow({
      width: 520,
      height: 760,
      title: "Sign in to Kotoba Cloud",
      autoHideMenuBar: true,
      ...(parent ? { parent, modal: true } : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: getKotobaCloudSession(),
        webSecurity: true,
      },
    });
    const finish = (error?: Error, viewer?: KotobaCloudViewer): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);
      if (!win.isDestroyed()) win.destroy();
      if (error) reject(error);
      else resolve(viewer as KotobaCloudViewer);
    };
    const check = async (): Promise<void> => {
      if (settled) return;
      const viewer = await kotobaCloudViewer();
      if (viewer.valid) finish(undefined, viewer);
    };
    const poll = setInterval(() => void check(), 1_500);
    poll.unref?.();
    const deadline = setTimeout(
      () =>
        finish(
          new KotobaCloudSessionError(
            "Kotoba Cloud sign-in did not complete within five minutes.",
            "sign-in-timeout",
          ),
        ),
      5 * 60_000,
    );
    deadline.unref?.();
    win.webContents.on("did-navigate", () => void check());
    win.webContents.on("did-redirect-navigation", () => void check());
    win.on("closed", () => {
      if (!settled)
        finish(
          new KotobaCloudSessionError(
            "Kotoba Cloud sign-in was cancelled.",
            "sign-in-cancelled",
          ),
        );
    });
    void win
      .loadURL(KOTOBA_SIGN_IN_URL)
      .catch((error) =>
        finish(
          new KotobaCloudSessionError(
            `Could not open the Kotoba Cloud sign-in page: ${error instanceof Error ? error.message : String(error)}`,
            "request-failed",
          ),
        ),
      );
  });
}

/**
 * Issue this machine's personal API token from the signed-in session — the
 * console's own POST, shown once. `inference` + `billing:read` is what the
 * desktop uses (chat, and the balance on the account card); it never asks
 * for `account`.
 */
export async function issueDesktopToken(): Promise<{
  token: string;
  tokenId: string | null;
}> {
  const label = `Kotoba desktop · ${hostname()}`.slice(0, 64);
  const { status, body } = await requestKotobaCloudJson(
    `${KOTOBA_CLOUD_ORIGIN}/v1/account/api-token`,
    {
      method: "POST",
      origin: KOTOBA_CLOUD_ORIGIN,
      body: { label, scopes: ["inference", "billing:read"] },
    },
  );
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 401)
    throw new KotobaCloudSessionError(
      "Sign in to Kotoba Cloud first.",
      "sign-in-required",
      401,
    );
  if (status !== 200 || typeof b.token !== "string")
    throw new KotobaCloudSessionError(
      `kotoba.cloud refused to issue a token: ${typeof b.error === "string" ? b.error : `HTTP ${status}`}`,
      typeof b.error === "string" ? b.error : "request-failed",
      status,
    );
  return {
    token: b.token,
    tokenId: typeof b.tokenId === "string" ? b.tokenId : null,
  };
}
