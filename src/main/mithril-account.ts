// @lat: [[mithril-account#Mithril account]]
/**
 * The Mithril account surface of this fork — what "Sign in to Mithril
 * Cloud" on the Providers page actually does.
 *
 * mithril.fund signs a person in with a Passkey in the browser and issues
 * personal API tokens (`kc_pat_<principal>.<tokenId>.<mac>`) — on
 * https://console.mithril.fund/account, or to this machine through the device grant
 * the person approves with that Passkey (mithril-device.ts). The
 * desktop's account *is* the token: connecting stores it as the
 * profile's `KOTOBA_API_KEY` — the same variable the Mithril provider
 * card and the agent's `providers: mithril:` entry read — after proving it
 * against `GET /v1/billing/status`, the read-only route that accepts a token
 * bearer and answers the ai-credit balance (app-kotoba-cloud billing-gateway).
 *
 * Fail-closed on the things a person would otherwise discover after a charge:
 * a token that does not verify is not stored, a revoked token reads as
 * revoked (the server checks its registry, not only the MAC), and a token
 * without the `billing:read` scope is stored — it can still chat — but the
 * balance is shown as unknown rather than as zero.
 *
 * At rest the token is in the OS keychain (mithril-token-store.ts), not
 * in `.env`: `setEnvValue` / `readEnv` route `KOTOBA_API_KEY` there, and
 * `migrateMithrilTokensToKeychain` moves any plaintext copy at startup.
 */
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  MITHRIL_PLAINTEXT_WARNING,
  readEnv,
  readEnvFile,
  removeEnvKey,
  secureEnvWarning,
  setEnvValue,
  setSecureEnvWarning,
} from "./config";
import { mirrorFirstPartyAgentProviders } from "./agent-config-providers";
import { HERMES_HOME } from "./installer";
import {
  hasStoredMithrilToken,
  mithrilSecureStorageAvailable,
  readStoredMithrilToken,
  writeStoredMithrilToken,
} from "./mithril-token-store";
import { isValidProfileName } from "./utils";
import {
  getMithrilOrgSelection,
  mithrilManageUrl,
  mithrilErrorCode,
  setMithrilOrgSelection,
} from "./mithril-orgs";
import type { MithrilAccount, MithrilConnectResult } from "../shared/account";

export const MITHRIL_ORIGIN = "https://mithril.fund";
// The account console lives on its own host (mithril.fund/account redirects there).
export const MITHRIL_ACCOUNT_URL = "https://console.mithril.fund/account";
export const MITHRIL_API_KEY_ENV = "KOTOBA_API_KEY";
const TOKEN_RE = /^kc_pat_[^.\s]+\.([0-9a-f]{12})\.[^\s]+$/;
const BILLING_STATUS_PATH = "/v1/billing/status";

/**
 * The principal a `kc_pat_` token belongs to — the segment between the prefix
 * and the token id. It is the account identity the desktop has: there is no
 * separate user record to read, because the token IS the account here.
 * Returns null for anything that is not a token of this shape.
 */
export function mithrilPrincipalId(token: string): string | null {
  const t = token.trim();
  if (!TOKEN_RE.test(t)) return null;
  const principal = t.slice("kc_pat_".length).split(".")[0];
  return principal.length > 0 ? principal : null;
}

/** The 12-hex token id inside a `kc_pat_` token, or null for any other shape. */
export function mithrilTokenId(token: string): string | null {
  const m = TOKEN_RE.exec(token.trim());
  return m ? m[1] : null;
}

/**
 * The one accessor for the profile's Mithril token, wherever it is at
 * rest (keychain store, or plaintext `.env` when the keychain is
 * unavailable). Null when none is stored.
 */
export function mithrilToken(profile?: string): string | null {
  const token = (readEnv(profile)[MITHRIL_API_KEY_ENV] || "").trim();
  return token || null;
}

type Verify =
  | { ok: true; balance: number | null; refusal?: string }
  | { ok: false; error: string };

/**
 * Ask mithril.fund what this token is. One request, one route, the answer
 * read by name: 200 → the ai balance (`balances[scope=ai].availableMicroUSD`),
 * 401 `token-revoked` / `sign-in-required` → not a live token, 403 with a
 * scope refusal → live but cannot read billing. With `org`, the same route
 * answers that organization's ledger (`?org=<handle>`); a 403
 * `org-role-insufficient` there means the person's role cannot read it —
 * still a live token, balance unknown.
 */
export async function verifyMithrilToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
  org?: string | null,
): Promise<Verify> {
  try {
    const query = org ? `?org=${encodeURIComponent(org)}` : "";
    const res = await fetchImpl(
      `${MITHRIL_ORIGIN}${BILLING_STATUS_PATH}${query}`,
      {
        headers: {
          authorization: `Bearer ${token.trim()}`,
          accept: "application/json",
        },
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      error?: unknown;
      balances?: Array<{ scope?: unknown; availableMicroUSD?: unknown }>;
    };
    if (res.status === 200) {
      const ai = Array.isArray(body.balances)
        ? body.balances.find((b) => b && b.scope === "ai")
        : undefined;
      const micro = Number(ai?.availableMicroUSD);
      return {
        ok: true,
        balance: Number.isFinite(micro) ? micro / 1_000_000 : null,
      };
    }
    if (res.status === 403) {
      // live token, but this read is refused — a missing scope, or (with
      // `org`) a role that cannot see the org ledger; the code names which
      const detail =
        mithrilErrorCode(body) ??
        (body.error === undefined ? "" : JSON.stringify(body.error));
      return {
        ok: true,
        balance: null,
        refusal: detail || "billing:read",
      };
    }
    const error = mithrilErrorCode(body) ?? `HTTP ${res.status}`;
    return { ok: false, error };
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't reach ${MITHRIL_ORIGIN}: ${(err as Error).message}`,
    };
  }
}

/** Where the profile's token is at rest, and the warning to show if plaintext. */
export function mithrilTokenStorage(profile?: string): {
  storage: "keychain" | "plaintext";
  storageWarning?: string;
} {
  const plaintext = (readEnvFile(profile)[MITHRIL_API_KEY_ENV] || "").trim();
  if (plaintext) {
    return {
      storage: "plaintext",
      storageWarning: secureEnvWarning(profile) ?? MITHRIL_PLAINTEXT_WARNING,
    };
  }
  return { storage: "keychain" };
}

/**
 * The account state for a profile: null when no token is stored. The
 * balance is the selected billing context's — personal, or the org chosen in
 * the switcher (`?org=`).
 */
export async function mithrilAccount(
  profile?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MithrilAccount | null> {
  const token = mithrilToken(profile);
  if (!token) {
    // An encrypted token the keychain will not open (keyring locked, app
    // re-signed) must not read as "never connected" without a word.
    if (hasStoredMithrilToken(profile) && !mithrilSecureStorageAvailable()) {
      console.warn(
        "[mithril] a stored token exists but the OS keychain is unavailable",
      );
    }
    return null;
  }
  const org = getMithrilOrgSelection(profile);
  const verified = await verifyMithrilToken(token, fetchImpl, org);
  return {
    tokenId: mithrilTokenId(token),
    accountUrl: MITHRIL_ACCOUNT_URL,
    live: verified.ok,
    balance: verified.ok ? verified.balance : null,
    error: verified.ok ? verified.refusal : verified.error,
    org,
    manageUrl: mithrilManageUrl(org),
    ...mithrilTokenStorage(profile),
  };
}

/** Store a token as the profile's KOTOBA_API_KEY — only once it verified. */
export async function connectMithril(
  rawToken: string,
  profile?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MithrilConnectResult> {
  const token = String(rawToken || "").trim();
  if (!mithrilTokenId(token)) {
    return {
      status: "invalid",
      error:
        "That is not a mithril.fund personal API token (kc_pat_…). Issue one on console.mithril.fund/account.",
    };
  }
  const verified = await verifyMithrilToken(token, fetchImpl);
  if (!verified.ok) return { status: "refused", error: verified.error };
  // keychain when available, plaintext .env with a warning otherwise (config.ts)
  setEnvValue(MITHRIL_API_KEY_ENV, token, profile);
  // the agent routes `mithril` by slug once the key exists (config.yaml providers:)
  mirrorFirstPartyAgentProviders(profile);
  return {
    status: "connected",
    account: {
      tokenId: mithrilTokenId(token),
      accountUrl: MITHRIL_ACCOUNT_URL,
      live: true,
      balance: verified.balance,
      error: verified.refusal,
      org: null,
      manageUrl: mithrilManageUrl(null),
      ...mithrilTokenStorage(profile),
    },
  };
}

/** Forget the token. The card on console.mithril.fund/account is where it is revoked. */
export function disconnectMithril(profile?: string): { success: boolean } {
  // clears the keychain entry and any plaintext line (config.ts)
  setEnvValue(MITHRIL_API_KEY_ENV, "", profile);
  // the next account may not belong to the same organizations
  try {
    setMithrilOrgSelection(profile, null);
  } catch {
    /* best-effort */
  }
  return { success: true };
}

/** Profile names with a home on disk: `default` plus each valid named profile. */
function profilesOnDisk(): string[] {
  const names = ["default"];
  const dir = join(HERMES_HOME, "profiles");
  if (!existsSync(dir)) return names;
  try {
    for (const name of readdirSync(dir).sort()) {
      if (isValidProfileName(name) && name !== "default") names.push(name);
    }
  } catch {
    // unreadable profiles dir — the default profile is still migrated
  }
  return names;
}

export type MithrilTokenMigration =
  | "migrated"
  | "replaced-stored"
  | "kept-plaintext"
  | "failed-kept-plaintext";

/**
 * Startup migration: move a plaintext `KOTOBA_API_KEY` out of each profile's
 * `.env` into the keychain store, then remove the line. Idempotent — a
 * profile with no plaintext token is left alone. When the keychain is
 * unavailable (or the write does not read back) the `.env` copy stays, a
 * warning is recorded for the account card, and nothing is dropped. A
 * plaintext value that differs from an already-stored one wins: the desktop
 * never writes `.env` while the keychain works, so it is the newer write
 * (an older app version, the CLI, a hand edit).
 */
export function migrateMithrilTokensToKeychain(
  profiles: string[] = profilesOnDisk(),
): Record<string, MithrilTokenMigration> {
  const out: Record<string, MithrilTokenMigration> = {};
  for (const name of profiles) {
    const profile = name === "default" ? undefined : name;
    const plaintext = (readEnvFile(profile)[MITHRIL_API_KEY_ENV] || "").trim();
    if (!plaintext) continue;
    if (!mithrilSecureStorageAvailable()) {
      setSecureEnvWarning(profile, MITHRIL_PLAINTEXT_WARNING);
      console.warn(`[mithril] ${name}: ${MITHRIL_PLAINTEXT_WARNING}`);
      out[name] = "kept-plaintext";
      continue;
    }
    const previous = readStoredMithrilToken(profile);
    try {
      writeStoredMithrilToken(profile, plaintext);
    } catch (err) {
      setSecureEnvWarning(profile, MITHRIL_PLAINTEXT_WARNING);
      console.warn(
        `[mithril] ${name}: keychain write failed, token kept in .env: ${(err as Error).message}`,
      );
      out[name] = "failed-kept-plaintext";
      continue;
    }
    removeEnvKey(MITHRIL_API_KEY_ENV, profile);
    setSecureEnvWarning(profile, undefined);
    out[name] =
      previous && previous !== plaintext ? "replaced-stored" : "migrated";
  }
  return out;
}
