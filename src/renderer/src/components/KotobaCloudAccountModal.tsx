// @lat: [[kotoba-cloud-account#Kotoba Cloud account#Sign-in modal]]
import { useState } from "react";
import { X, Check } from "../assets/icons";
import { useI18n } from "./useI18n";
import HermesLogo from "./common/HermesLogo";
import type { KotobaCloudAccount } from "../../../shared/account";

const ACCOUNT_URL = "https://kotoba.cloud/account";

interface Props {
  profile?: string;
  onClose: () => void;
  onConnected: (account: KotobaCloudAccount) => void;
}

/**
 * "Sign in to Kotoba Cloud": the Passkey sign-in happens in the browser on
 * kotoba.cloud/account, which issues a personal API token; this modal takes
 * that token and has the main process prove it against Kotoba Cloud before
 * it is saved as the profile's KOTOBA_API_KEY. Nothing is stored on a
 * refusal, and the refusal is shown by name.
 */
function KotobaCloudAccountModal({
  profile,
  onClose,
  onConnected,
}: Props): React.JSX.Element {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<
    "idle" | "running" | "passkey" | "success" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  // Passkey in a window on the app's own cookie partition; the token is
  // then issued from that session by the main process — nothing is typed
  // here, nothing is pasted.
  async function signInWithPasskey(): Promise<void> {
    if (status === "running" || status === "passkey") return;
    setStatus("passkey");
    setError(null);
    try {
      const r = await window.hermesAPI.signInKotobaCloud(profile);
      if (r.result.status === "connected") {
        setStatus("success");
        onConnected(r.result.account);
      } else {
        setStatus("error");
        setError(r.result.error);
      }
    } catch (err) {
      setStatus("error");
      setError((err as Error)?.message || t("providers.kotobaAccount.failed"));
    }
  }

  async function connect(): Promise<void> {
    if (!token.trim() || status === "running") return;
    setStatus("running");
    setError(null);
    try {
      const r = await window.hermesAPI.connectKotobaCloud(token, profile);
      if (r.status === "connected") {
        setStatus("success");
        onConnected(r.account);
      } else {
        setStatus("error");
        setError(r.error);
      }
    } catch (err) {
      setStatus("error");
      setError((err as Error)?.message || t("providers.kotobaAccount.failed"));
    }
  }

  const subtitle =
    status === "error"
      ? error || t("providers.kotobaAccount.failed")
      : status === "success"
        ? t("providers.kotobaAccount.successHint")
        : t("providers.kotobaAccount.modalHint");

  return (
    <div className="models-modal-overlay" onClick={onClose}>
      <div className="hermes-signin-modal" onClick={(e) => e.stopPropagation()}>
        <button
          className="hermes-signin-close"
          onClick={onClose}
          aria-label={t("common.close")}
        >
          <X size={18} />
        </button>

        <div className="hermes-signin-emblem">
          {status === "running" && (
            <span className="hermes-signin-ring" aria-hidden="true" />
          )}
          {status === "success" ? (
            <span className="hermes-signin-bolt">
              <Check size={26} />
            </span>
          ) : status === "error" ? (
            <span className="hermes-signin-bolt">
              <X size={26} />
            </span>
          ) : (
            <span className="hermes-signin-mark">
              <HermesLogo size={92} />
            </span>
          )}
        </div>

        <h2 className="hermes-signin-title">
          {t("providers.kotobaAccount.modalTitle")}
        </h2>
        <p className="hermes-signin-subtitle">{subtitle}</p>

        {status !== "success" && (
          <form
            className="kotoba-signin-form"
            onSubmit={(e) => {
              e.preventDefault();
              void connect();
            }}
          >
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void signInWithPasskey()}
              disabled={status === "passkey" || status === "running"}
            >
              {status === "passkey"
                ? t("providers.kotobaAccount.passkeyWorking")
                : t("providers.kotobaAccount.passkey")}
            </button>
            <p className="kotoba-signin-label">
              {t("providers.kotobaAccount.passkeyHint")}
            </p>
            <p className="kotoba-signin-label kotoba-signin-or">
              {t("providers.kotobaAccount.orPaste")}
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void window.hermesAPI.openExternal(ACCOUNT_URL)}
            >
              {t("providers.kotobaAccount.openAccount")}
            </button>
            <label className="kotoba-signin-label" htmlFor="kotoba-cloud-token">
              {t("providers.kotobaAccount.tokenLabel")}
            </label>
            <input
              id="kotoba-cloud-token"
              className="input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("providers.kotobaAccount.tokenPlaceholder")}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={status === "running" || status === "passkey"}
            />
            <button
              type="submit"
              className="btn btn-secondary btn-sm"
              disabled={
                !token.trim() || status === "running" || status === "passkey"
              }
            >
              {status === "running"
                ? t("providers.kotobaAccount.connecting")
                : t("providers.kotobaAccount.connect")}
            </button>
          </form>
        )}

        <div className="hermes-signin-footer">
          <span className="hermes-signin-footer-status">
            {status === "running"
              ? t("providers.kotobaAccount.connecting")
              : status === "passkey"
                ? t("providers.kotobaAccount.passkeyWorking")
                : status === "success"
                  ? t("providers.kotobaAccount.connected")
                  : ""}
          </span>
          <button className="hermes-signin-cancel" onClick={onClose}>
            {status === "success" ? t("common.close") : t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default KotobaCloudAccountModal;
