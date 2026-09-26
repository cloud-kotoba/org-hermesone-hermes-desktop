// @lat: [[mithril-account#Mithril account#Organization switcher]]
/**
 * The organizations a Mithril account belongs to, and which billing
 * context (Personal, or one org) the desktop shows.
 *
 * The contract is mithril.fund's:
 *   GET /v1/org/memberships   bearer PAT with scope `org:read`
 *     → {"orgs":[{"handle","did","role","plan"|null,"seatLimit"|null,"memberCount"}]}
 *   GET /v1/billing/status?org=<handle>
 *     → the personal status shape, for the org ledger; 403
 *       `org-role-insufficient` for roles other than owner/admin/billing.
 *
 * Every non-list answer is named (`MithrilOrgMemberships`) so the switcher
 * never renders "no organizations" for a token that simply predates the
 * `org:read` scope (403 → `reconnect`) or a server that has not deployed the
 * route (404 → `unavailable`).
 *
 * Member management stays on the web (console.mithril.fund/account); the desktop
 * only reads memberships and chooses which ledger the balance chip shows.
 */
import { readDesktopConfig, writeDesktopConfig } from "./config";
import type {
  MithrilOrgMembership,
  MithrilOrgMemberships,
} from "../shared/account";

const MITHRIL_ORIGIN = "https://mithril.fund";
const MITHRIL_ACCOUNT_URL = "https://console.mithril.fund/account";
export const MITHRIL_ORG_MEMBERSHIPS_URL = `${MITHRIL_ORIGIN}/v1/org/memberships`;
const SELECTION_KEY = "mithrilOrgByProfile";

/** Org handles are the path/query segment we send back; accept only a plain slug. */
const HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The server's refusal code, whether it answered `{error:"x"}` or `{error:{code:"x"}}`. */
export function mithrilErrorCode(body: unknown): string | null {
  const e = (body as { error?: unknown } | null)?.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/** One membership row, or null when the row does not have the contract's shape. */
export function parseMembership(raw: unknown): MithrilOrgMembership | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.handle !== "string" || !HANDLE_RE.test(r.handle)) return null;
  if (typeof r.role !== "string" || !r.role) return null;
  const memberCount = Number(r.memberCount);
  const seatLimit =
    r.seatLimit === null || r.seatLimit === undefined
      ? null
      : Number(r.seatLimit);
  return {
    handle: r.handle,
    did: typeof r.did === "string" ? r.did : "",
    role: r.role,
    plan: typeof r.plan === "string" ? r.plan : null,
    seatLimit: Number.isFinite(seatLimit) ? (seatLimit as number) : null,
    memberCount: Number.isFinite(memberCount) ? memberCount : 0,
  };
}

/**
 * Read the account's organizations. 200 → the rows that have the contract's
 * shape; 403 (any refusal — on this route it is the missing `org:read`
 * scope) → `reconnect`; 404 → `unavailable`; anything else → `error` with
 * the server's code or the HTTP status.
 */
export async function fetchMithrilOrgMemberships(
  token: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<MithrilOrgMemberships> {
  if (!token) return { status: "signed-out" };
  try {
    const res = await fetchImpl(MITHRIL_ORG_MEMBERSHIPS_URL, {
      headers: {
        authorization: `Bearer ${token.trim()}`,
        accept: "application/json",
      },
    });
    const body = (await res.json().catch(() => ({}))) as {
      orgs?: unknown;
    };
    if (res.status === 200) {
      if (!Array.isArray(body.orgs))
        return { status: "error", error: "malformed-response" };
      const orgs = body.orgs
        .map(parseMembership)
        .filter((o): o is MithrilOrgMembership => o !== null);
      return { status: "ok", orgs };
    }
    if (res.status === 403) return { status: "reconnect" };
    if (res.status === 404) return { status: "unavailable" };
    const code = mithrilErrorCode(body);
    if (code && /scope/i.test(code)) return { status: "reconnect" };
    return { status: "error", error: code ?? `HTTP ${res.status}` };
  } catch (err) {
    return {
      status: "error",
      error: `Couldn't reach ${MITHRIL_ORIGIN}: ${(err as Error).message}`,
    };
  }
}

function selections(): Record<string, string> {
  const raw = readDesktopConfig()[SELECTION_KEY];
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && HANDLE_RE.test(v)) out[k] = v;
  }
  return out;
}

/** The persisted billing context for a profile: null = Personal. */
export function getMithrilOrgSelection(profile?: string): string | null {
  return selections()[profile || "default"] ?? null;
}

/** Persist the billing context (null = Personal). Rejects a malformed handle. */
export function setMithrilOrgSelection(
  profile: string | undefined,
  handle: string | null,
): string | null {
  if (handle !== null && !HANDLE_RE.test(handle)) {
    throw new Error("Not an organization handle.");
  }
  const key = profile || "default";
  const data = readDesktopConfig();
  const next = selections();
  if (handle) next[key] = handle;
  else delete next[key];
  writeDesktopConfig({ ...data, [SELECTION_KEY]: next });
  return handle;
}

/**
 * Where "Manage on mithril.fund" goes. mithril.fund has no confirmed
 * `/account/org/<handle>` page, so an org opens the account console with
 * `?org=<handle>`.
 */
export function mithrilManageUrl(org: string | null | undefined): string {
  const base = MITHRIL_ACCOUNT_URL;
  return org ? `${base}?org=${encodeURIComponent(org)}` : base;
}
