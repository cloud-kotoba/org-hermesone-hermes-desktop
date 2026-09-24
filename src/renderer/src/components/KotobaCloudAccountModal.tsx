// @lat: [[kotoba-cloud-account#Kotoba Cloud account#Sign-in modal]]
import { useEffect, useRef, useState } from "react";
import { X, Check, Copy } from "../assets/icons";
import { useI18n } from "./useI18n";
import HermesLogo from "./common/HermesLogo";
import type {
  KotobaCloudAccount,
  KotobaDeviceSignIn,
} from "../../../shared/account";

const ACCOUNT_URL = "https://kotoba.cloud/account";

interface Props {
  profile?: string;
  onClose: () => void;
  onConnected: (account: KotobaCloudAccount) => void;
}

/**
 * "Sign in to Kotoba Cloud". The primary path is the device grant: the
 * approval page opens in the default browser, the person signs in there with
 * their Passkey and approves the code shown here, and the main process
 * receives this machine's own scoped token and saves it as the profile's
 * KOTOBA_API_KEY. A Passkey inside an app window never reached the person's
 * authenticator, which is why this no longer opens one. Pasting a token
 * issued on kotoba.cloud/account stays as the manual path. Nothing is stored
 * on a refusal, and the refusal is shown by name.
 */
function KotobaCloudAccountModal({
  profile,
  onClose,
  onConnected,
}: Props): React.JSX.Element {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<
    "idle" | "running" | "device" | "success" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<KotobaDeviceSignIn | null>(null);
  const [copied, setCopied] = useState(false);
  const waiting = useRef(false);

  // closing the dialog mid-sign-in stops the main process's polling
  useEffect(
    () => () => {
      if (waiting.current) void window.hermesAPI.cancelKotobaDeviceSignIn();
    },
    [],
  );

  async function signInWithBrowser(): Promise<void> {
    if (status === "running" || status === "device") return;
    setStatus("device");
    setError(null);
    setDevice(null);
    try {
      const d = await window.hermesAPI.startKotobaDeviceSignIn();
      setDevice(d);
      waiting.current = true;
      const r = await window.hermesAPI.waitKotobaDeviceSignIn(profile);
      waiting.current = false;
      if (r.status === "connected") {
        setStatus("success");
        onConnected(r.account);
      } else {
        setStatus("error");
        setError(r.error);
      }
    } catch (err) {
      waiting.current = false;
      setStatus("error");
      setError((err as Error)?.message || t("providers.kotobaAccount.failed"));
    }
  }

  function copyCode(): void {
    if (!device) return;
    navigator.clipboard
      .writeText(device.userCode)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard unavailable — don't claim "Copied".
      });
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
        : status === "device"
          ? t("providers.kotobaAccount.deviceHint")
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
          {(status === "running" || status === "device") && (
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

        {status === "device" && device && (
          <>
            <div className="hermes-signin-code">{device.userCode}</div>
            <button className="hermes-signin-copy" onClick={copyCode}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              <span>
                {copied
                  ? t("providers.kotobaAccount.copied")
                  : t("providers.kotobaAccount.copyCode")}
              </span>
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() =>
                void window.hermesAPI.openExternal(
                  device.verificationUriComplete,
                )
              }
            >
              {t("providers.kotobaAccount.reopenBrowser")}
            </button>
          </>
        )}

        {status !== "success" && status !== "device" && (
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
              onClick={() => void signInWithBrowser()}
              disabled={status === "running"}
            >
              {t("providers.kotobaAccount.passkey")}
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
              disabled={status === "running"}
            />
            <button
              type="submit"
              className="btn btn-secondary btn-sm"
              disabled={!token.trim() || status === "running"}
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
              : status === "device"
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
