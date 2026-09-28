// Shared shapes for the Hermes account (device-login) surface, used across the
// main process, preload bridge, and renderer.

export interface HermesAccountUser {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface HermesAccount {
  apiUrl: string;
  user: HermesAccountUser;
}

/** Outcome of the auto-provisioned Hermes One Inference key check. */
export interface EnsureHermesOneKeyResult {
  status: "created" | "exists" | "signed-out" | "error";
  error?: string;
}

/** The signed-in account's AI-credit balance (USD-denominated; null when
 *  signed out or unavailable). */
export interface HermesOneCreditsResult {
  balance: number | null;
  error?: string;
}

/** This fork's Mithril account: the stored personal API token, proven
 *  against mithril.fund. `live` false = the stored token no longer verifies
 *  (revoked / unreachable — `error` says which). `balance` is ai credit in
 *  USD, null when the token lacks billing:read (`error` names the scope). */
export interface MithrilAccount {
  tokenId: string | null;
  accountUrl: string;
  live: boolean;
  balance: number | null;
  error?: string;
  /** Where the token is at rest: the OS keychain, or plaintext `.env` when
   *  the keychain is unavailable (then `storageWarning` says so). */
  storage?: "keychain" | "plaintext";
  storageWarning?: string;
  /** The billing context `balance` belongs to: null = personal, else the
   *  selected organization's handle. */
  org?: string | null;
  /** mithril.fund page to manage the selected context. */
  manageUrl?: string;
}

/** One organization the signed-in person belongs to (`GET /v1/org/memberships`). */
export interface MithrilOrgMembership {
  handle: string;
  did: string;
  role: string;
  plan: string | null;
  seatLimit: number | null;
  memberCount: number;
}

/**
 * The memberships read, with every non-list answer named so the UI never
 * shows an empty list for something that is not "no organizations":
 * `reconnect` — the token predates the `org:read` scope; `unavailable` — the
 * route is not deployed (404); `signed-out` — no token; `error` — anything
 * else (network, 5xx, revoked).
 */
export type MithrilOrgMemberships =
  | { status: "ok"; orgs: MithrilOrgMembership[] }
  | { status: "reconnect" | "unavailable" | "signed-out" }
  | { status: "error"; error: string };

export interface MithrilOrgState {
  memberships: MithrilOrgMemberships;
  /** The persisted selection: null = Personal. */
  selected: string | null;
}

/** The desktop's signed-in Mithril session (Passkey in a window). */
export interface MithrilViewerInfo {
  valid: boolean;
  username?: string | null;
  principalId?: string | null;
}

/**
 * A Mithril device sign-in in progress, as the renderer sees it: the
 * code to show and where the browser was sent. The device code itself stays
 * in the main process.
 */
export interface MithrilDeviceSignIn {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: number;
}

/** The hosted gateway (per-user Hermes in a Modal sandbox) as the lane reports it. */
export interface MithrilGatewayInfo {
  running: boolean;
  status: string;
  url: string | null;
  sandboxId: string | null;
  error?: string;
}

export type MithrilConnectResult =
  | { status: "connected"; account: MithrilAccount }
  | { status: "invalid" | "refused"; error: string };

/** Emitted once the backend issues a device code, so the modal can show it. */
export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}
