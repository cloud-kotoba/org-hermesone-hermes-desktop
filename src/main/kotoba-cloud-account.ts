// @lat: [[kotoba-cloud-account#Kotoba Cloud account]]
/**
 * The Kotoba Cloud account surface of this fork — what "Sign in to Kotoba
 * Cloud" on the Providers page actually does.
 *
 * kotoba.cloud signs a person in with a Passkey in the browser and issues
 * personal API tokens (`kc_pat_<principal>.<tokenId>.<mac>`) on
 * https://kotoba.cloud/account. There is no device-code / OAuth flow to reuse
 * (the workspace's human-authentication policy makes those non-authorities),
 * so the desktop's account *is* the token: connecting stores it as the
 * profile's `KOTOBA_API_KEY` — the same variable the Kotoba Cloud provider
 * card and the agent's `providers: kotoba:` entry read — after proving it
 * against `GET /v1/billing/status`, the read-only route that accepts a token
 * bearer and answers the ai-credit balance (app-kotoba-cloud billing-gateway).
 *
 * Fail-closed on the things a person would otherwise discover after a charge:
 * a token that does not verify is not stored, a revoked token reads as
 * revoked (the server checks its registry, not only the MAC), and a token
 * without the `billing:read` scope is stored — it can still chat — but the
 * balance is shown as unknown rather than as zero.
 */
import { readEnv, setEnvValue } from "./config";
import { mirrorFirstPartyAgentProviders } from "./agent-config-providers";
import type {
  KotobaCloudAccount,
  KotobaCloudConnectResult,
} from "../shared/account";

export const KOTOBA_CLOUD_ORIGIN = "https://kotoba.cloud";
export const KOTOBA_CLOUD_ACCOUNT_URL = `${KOTOBA_CLOUD_ORIGIN}/account`;
export const KOTOBA_API_KEY_ENV = "KOTOBA_API_KEY";
const TOKEN_RE = /^kc_pat_[^.\s]+\.([0-9a-f]{12})\.[^\s]+$/;
const BILLING_STATUS_PATH = "/v1/billing/status";

/** The 12-hex token id inside a `kc_pat_` token, or null for any other shape. */
export function kotobaTokenId(token: string): string | null {
  const m = TOKEN_RE.exec(token.trim());
  return m ? m[1] : null;
}

type Verify =
  | { ok: true; balance: number | null; scopeMissing?: string }
  | { ok: false; error: string };

/**
 * Ask kotoba.cloud what this token is. One request, one route, the answer
 * read by name: 200 → the ai balance (`balances[scope=ai].availableMicroUSD`),
 * 401 `token-revoked` / `sign-in-required` → not a live token, 403 with a
 * scope refusal → live but cannot read billing.
 */
export async function verifyKotobaCloudToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Verify> {
  try {
    const res = await fetchImpl(
      `${KOTOBA_CLOUD_ORIGIN}${BILLING_STATUS_PATH}`,
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
      // live token, wrong scopes — the refusal names the scope it wanted
      const detail =
        typeof body.error === "string"
          ? body.error
          : JSON.stringify(body.error ?? "");
      return {
        ok: true,
        balance: null,
        scopeMissing: detail || "billing:read",
      };
    }
    const error =
      typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    return { ok: false, error };
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't reach ${KOTOBA_CLOUD_ORIGIN}: ${(err as Error).message}`,
    };
  }
}

/** The account state for a profile: null when no token is stored. */
export async function kotobaCloudAccount(
  profile?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KotobaCloudAccount | null> {
  const token = (readEnv(profile)[KOTOBA_API_KEY_ENV] || "").trim();
  if (!token) return null;
  const verified = await verifyKotobaCloudToken(token, fetchImpl);
  return {
    tokenId: kotobaTokenId(token),
    accountUrl: KOTOBA_CLOUD_ACCOUNT_URL,
    live: verified.ok,
    balance: verified.ok ? verified.balance : null,
    error: verified.ok ? verified.scopeMissing : verified.error,
  };
}

/** Store a token as the profile's KOTOBA_API_KEY — only once it verified. */
export async function connectKotobaCloud(
  rawToken: string,
  profile?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KotobaCloudConnectResult> {
  const token = String(rawToken || "").trim();
  if (!kotobaTokenId(token)) {
    return {
      status: "invalid",
      error:
        "That is not a kotoba.cloud personal API token (kc_pat_…). Issue one on kotoba.cloud/account.",
    };
  }
  const verified = await verifyKotobaCloudToken(token, fetchImpl);
  if (!verified.ok) return { status: "refused", error: verified.error };
  setEnvValue(KOTOBA_API_KEY_ENV, token, profile);
  // the agent routes `kotoba` by slug once the key exists (config.yaml providers:)
  mirrorFirstPartyAgentProviders(profile);
  return {
    status: "connected",
    account: {
      tokenId: kotobaTokenId(token),
      accountUrl: KOTOBA_CLOUD_ACCOUNT_URL,
      live: true,
      balance: verified.balance,
      error: verified.scopeMissing,
    },
  };
}

/** Forget the token. The card on kotoba.cloud/account is where it is revoked. */
export function disconnectKotobaCloud(profile?: string): { success: boolean } {
  setEnvValue(KOTOBA_API_KEY_ENV, "", profile);
  return { success: true };
}
