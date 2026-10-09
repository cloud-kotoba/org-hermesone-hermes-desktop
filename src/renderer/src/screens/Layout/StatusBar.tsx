import { useEffect, useState } from "react";

interface StatusInfo {
  mode: string;
  gatewayRunning: boolean;
  model: string;
  skillCount: number;
}

/**
 * Bottom system strip — a native desktop-app affordance that surfaces the
 * live connection/gateway state, active model, and skill count that were
 * previously buried. Every field is real (sourced from `getProfileSummary` +
 * `getConnectionConfig`); nothing is fabricated, so if a value is unknown the
 * chip is simply omitted rather than shown with a placeholder.
 *
 * It asks for the active profile only. It used to call `listProfiles()` every
 * 4 s, a full scan of every profile (~1,000 on a busy install) just to show
 * one row.
 */
export function StatusBar({
  activeProfile,
}: {
  activeProfile: string;
}): React.JSX.Element {
  const [info, setInfo] = useState<StatusInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      const [active, conn] = await Promise.all([
        window.hermesAPI.getProfileSummary(activeProfile).catch(() => null),
        window.hermesAPI.getConnectionConfig().catch(() => null),
      ]);
      if (cancelled) return;
      if (!active && !conn) return; // keep last-known on a transient failure
      setInfo({
        mode: conn?.mode ?? "local",
        gatewayRunning: active?.gatewayRunning ?? false,
        model: active?.model ?? "",
        skillCount: active?.skillCount ?? 0,
      });
    }
    void load();
    // Gateway state + skill count change while the app is open; poll gently.
    const id = window.setInterval(() => void load(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeProfile]);

  const isMac = window.electron?.process?.platform === "darwin";
  const mod = isMac ? "⌘" : "Ctrl";

  return (
    <footer className="status-bar" aria-label="Status">
      <div className="status-bar-group">
        <span
          className={`status-dot ${info?.gatewayRunning ? "online" : "offline"}`}
          aria-hidden="true"
        />
        <span className="status-item status-strong">
          {info?.gatewayRunning ? "gateway" : "offline"}
        </span>
        <span className="status-sep" aria-hidden="true">
          &middot;
        </span>
        <span className="status-item">{info?.mode ?? "local"}</span>
        {info?.model ? (
          <>
            <span className="status-sep" aria-hidden="true">
              &middot;
            </span>
            <span className="status-item">{info.model}</span>
          </>
        ) : null}
        {info ? (
          <>
            <span className="status-sep" aria-hidden="true">
              &middot;
            </span>
            <span className="status-item">{info.skillCount} skills</span>
          </>
        ) : null}
      </div>
      <div className="status-bar-group status-bar-hints">
        <span className="status-item">
          <kbd className="status-kbd">/</kbd> commands
        </span>
        <span className="status-sep" aria-hidden="true">
          &middot;
        </span>
        <span className="status-item">
          <kbd className="status-kbd">{mod},</kbd> settings
        </span>
      </div>
    </footer>
  );
}

export default StatusBar;
