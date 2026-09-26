// @lat: [[office-interactions#Backend Wallet Actions]]
import { mapCloudWallet, resolveLinkedAgent } from "./wallet-sync";
import { listWallets } from "./wallet-store";
import type {
  CloudWalletRaw,
  PortfolioTokenView,
  ProvisionWalletResult,
  WalletPortfolioResult,
} from "../shared/wallets";

// Backend-driven wallet operations for the Office's space representatives
// (bank receptionist). Everything goes through the hermes-one backend — the
// desktop holds no keys and reads no chain state locally for these flows.

/** Raw token row from the backend portfolio (provider-normalised). */
interface PortfolioTokenRaw {
  symbol?: string;
  name?: string;
  balance?: number;
  balanceUsd?: number;
}

/**
 * Token balances for one of the profile's cloud wallets, via
 * `GET /api/wallets/:id/portfolio`. Requires a transactable wallet (the
 * backend authenticates reads with the wallet's stored key); receive-only
 * wallets surface the backend's error string.
 */
export async function getWalletPortfolio(
  profile: string | undefined,
  walletId: string,
): Promise<WalletPortfolioResult> {
  const resolved = await resolveLinkedAgent(profile);
  if (resolved.status !== "ok") return { status: resolved.status };
  const { apiUrl, token } = resolved;

  try {
    const res = await fetch(
      `${apiUrl}/v1/wallets/${encodeURIComponent(walletId)}/portfolio`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
      },
    );
    const data = (await res.json().catch(() => ({}))) as {
      // Mithril answers the rows flat, plus `unread`: the symbols whose
      // balance could not be read. A row that could not be read is NOT listed
      // as zero — see app-kotoba-cloud.wallets.
      tokens?: PortfolioTokenRaw[];
      unread?: string[];
      error?: { code?: string } | string;
    };
    if (!res.ok) {
      const code =
        typeof data.error === "string" ? data.error : data.error?.code;
      return {
        status: "error",
        error: code || `Portfolio unavailable (HTTP ${res.status}).`,
      };
    }
    const tokens: PortfolioTokenView[] = (data.tokens ?? []).map((t) => ({
      symbol: t.symbol || "?",
      name: t.name || t.symbol || "Token",
      balance: typeof t.balance === "number" ? t.balance : 0,
      // null, not 0: this plane has no price oracle, and a zero here would
      // render as "worth nothing" instead of "not priced".
      balanceUsd: typeof t.balanceUsd === "number" ? t.balanceUsd : null,
    }));
    return {
      status: "ok",
      // no oracle, so no total — the pane shows the balances, not a valuation
      totalUsd: null,
      tokens,
      unread: Array.isArray(data.unread) ? data.unread : [],
    };
  } catch (err) {
    return {
      status: "error",
      error: `Couldn't reach ${apiUrl}: ${(err as Error).message}`,
    };
  }
}

/**
 * REGISTER this profile's local wallet address with the account, via
 * `POST /v1/wallets`.
 *
 * This used to ask the backend to PROVISION a custodial (Bankr) wallet.
 * Mithril does not do that and will not: it holds no keys, so there is
 * nothing to provision. What it offers instead is the half that is safe —
 * the account remembers an address the person already controls, and reads
 * its balances from the chain. The registered row comes back
 * `canTransact: false`, which is the honest description rather than a
 * placeholder.
 *
 * The address is the profile's own local wallet (wallet-store), whose
 * encrypted recovery phrase never leaves this machine. With no local wallet
 * there is nothing to register, and that is `unlinked` — not an error.
 *
 * Idempotent: registering the same address twice answers 409, which surfaces
 * as `status: "exists"`.
 */
export async function provisionAgentWallet(
  profile?: string,
): Promise<ProvisionWalletResult> {
  const resolved = await resolveLinkedAgent(profile);
  if (resolved.status !== "ok") return { status: resolved.status };
  const { apiUrl, token } = resolved;

  const local = listWallets(profile)[0];
  if (!local?.address) return { status: "unlinked" };

  try {
    const res = await fetch(`${apiUrl}/v1/wallets`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        address: local.address,
        label: local.name || undefined,
      }),
    });
    if (res.status === 409) return { status: "exists" };
    const data = (await res.json().catch(() => ({}))) as {
      wallet?: CloudWalletRaw;
      error?: string;
    };
    if (!res.ok || !data.wallet) {
      return {
        status: "error",
        error: data.error || `Wallet creation failed (HTTP ${res.status}).`,
      };
    }
    return { status: "ok", wallet: mapCloudWallet(data.wallet) ?? undefined };
  } catch (err) {
    return {
      status: "error",
      error: `Couldn't reach ${apiUrl}: ${(err as Error).message}`,
    };
  }
}
