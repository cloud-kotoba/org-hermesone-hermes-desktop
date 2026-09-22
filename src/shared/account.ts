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

/** This fork's Kotoba Cloud account: the stored personal API token, proven
 *  against kotoba.cloud. `live` false = the stored token no longer verifies
 *  (revoked / unreachable — `error` says which). `balance` is ai credit in
 *  USD, null when the token lacks billing:read (`error` names the scope). */
export interface KotobaCloudAccount {
  tokenId: string | null;
  accountUrl: string;
  live: boolean;
  balance: number | null;
  error?: string;
}

/** The desktop's signed-in Kotoba Cloud session (Passkey in a window). */
export interface KotobaCloudViewerInfo {
  valid: boolean;
  username?: string | null;
  principalId?: string | null;
}

/** The hosted gateway (per-user Hermes in a Modal sandbox) as the lane reports it. */
export interface KotobaGatewayInfo {
  running: boolean;
  status: string;
  url: string | null;
  sandboxId: string | null;
  error?: string;
}

export type KotobaCloudConnectResult =
  | { status: "connected"; account: KotobaCloudAccount }
  | { status: "invalid" | "refused"; error: string };

/** Emitted once the backend issues a device code, so the modal can show it. */
export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}
