import { app, ipcMain, shell, type BrowserWindow } from "electron";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type { AppUpdater } from "electron-updater";
import { dirname, join, resolve } from "path";
import { updaterLogger } from "../updater-log";

interface UpdaterDeps {
  getMainWindow: () => BrowserWindow | null;
}

let autoUpdaterInstance: AppUpdater | null = null;

// Where a person installs a new build by hand. The same origin as the
// electron-builder.yml `publish.url` feed; it redirects to the current brand's
// download page, which links the per-arch .dmg files.
const DOWNLOAD_PAGE_URL = "https://app.mithril.fund/";

/**
 * Why macOS auto-update cannot be used for this bundle, or null when it can.
 *
 * Squirrel.Mac only installs a successor that satisfies the RUNNING bundle's
 * designated requirement. An ad-hoc signature's requirement is a cdhash pin,
 * so no other build can ever satisfy it: every install ends in "Code signature
 * … did not pass validation" (updater.log, 0.7.10 → 0.7.12). Until the app
 * ships with a Developer ID identity, the upgrade path is the download page.
 *
 * A signature that cannot be read is treated as manual too: opening the
 * download page is always safe, a Squirrel install that cannot validate is not.
 */
export function macManualUpdateReason(
  platform: NodeJS.Platform,
  readSignature: () => string,
): string | null {
  if (platform !== "darwin") return null;
  let details: string;
  try {
    details = readSignature();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `code signature unreadable (${message})`;
  }
  if (/^Signature=adhoc$/m.test(details)) return "ad-hoc code signature";
  if (/^TeamIdentifier=not set$/m.test(details)) return "no TeamIdentifier";
  if (!/^TeamIdentifier=\S+$/m.test(details)) {
    return "code signature details not recognised";
  }
  return null;
}

/** `codesign -dv` output for the running .app bundle. codesign prints the
 *  details on stderr, so both streams are returned; a non-zero exit throws. */
function readBundleSignature(): string {
  const bundle = resolve(app.getPath("exe"), "..", "..", "..");
  const result = spawnSync("/usr/bin/codesign", ["-dv", bundle], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`codesign exited ${result.status}: ${output.trim()}`);
  }
  return output;
}

function updatePreferencesPath(): string {
  return join(app.getPath("userData"), "update-preferences.json");
}

function getAutoUpgradeEnabled(): boolean {
  const file = updatePreferencesPath();
  if (!existsSync(file)) {
    return true;
  }

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      autoUpgrade?: unknown;
    };
    return parsed.autoUpgrade !== false;
  } catch {
    return true;
  }
}

function setAutoUpgradeEnabled(enabled: boolean): void {
  const file = updatePreferencesPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ autoUpgrade: enabled }, null, 2)}\n`);
}

export function setupUpdater({ getMainWindow }: UpdaterDeps): void {
  ipcMain.handle("get-app-version", () => app.getVersion());
  ipcMain.handle("get-auto-upgrade-enabled", () => getAutoUpgradeEnabled());
  ipcMain.handle("set-auto-upgrade-enabled", (_event, enabled: boolean) => {
    setAutoUpgradeEnabled(enabled);
    if (autoUpdaterInstance) {
      autoUpdaterInstance.autoDownload = enabled;
    }
    return true;
  });

  const isPortableBuild = !!process.env.PORTABLE_EXECUTABLE_DIR;
  if (!app.isPackaged || isPortableBuild) {
    autoUpdaterInstance = null;
    ipcMain.handle("check-for-updates", async () => null);
    ipcMain.handle("download-update", () => true);
    ipcMain.handle("install-update", () => {});
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { autoUpdater } = require("electron-updater") as {
    autoUpdater: AppUpdater;
  };

  autoUpdaterInstance = autoUpdater;
  autoUpdater.logger = updaterLogger;

  const manualReason = macManualUpdateReason(
    process.platform,
    readBundleSignature,
  );
  if (manualReason) {
    setupManualUpdater(autoUpdater, manualReason, getMainWindow);
    return;
  }

  autoUpdater.autoDownload = getAutoUpgradeEnabled();
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    getMainWindow()?.webContents.send("update-available", {
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    getMainWindow()?.webContents.send("update-download-progress", {
      percent: Math.round(progress.percent),
    });
  });
  autoUpdater.on("update-downloaded", () => {
    getMainWindow()?.webContents.send("update-downloaded");
  });
  autoUpdater.on("error", (err) => {
    getMainWindow()?.webContents.send("update-error", err.message);
  });

  ipcMain.handle("check-for-updates", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.updateInfo?.version || null;
    } catch {
      return null;
    }
  });
  ipcMain.handle("download-update", async () => {
    try {
      await autoUpdater.downloadUpdate();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      getMainWindow()?.webContents.send("update-error", message);
      return false;
    }
  });
  ipcMain.handle("install-update", () => {
    updaterLogger.info(
      "Restart requested by user — calling quitAndInstall(isSilent=false, isForceRunAfter=true)",
    );
    autoUpdater.quitAndInstall(false, true);
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);
}

/**
 * The feed is still read — a newer version still surfaces the sidebar's
 * "Update available" button — but nothing is downloaded or handed to
 * Squirrel.Mac. Pressing the button opens the download page instead.
 */
function setupManualUpdater(
  autoUpdater: AppUpdater,
  reason: string,
  getMainWindow: () => BrowserWindow | null,
): void {
  updaterLogger.info(
    `macOS auto-install disabled: ${reason}; updates go through ${DOWNLOAD_PAGE_URL}`,
  );
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  let latest: { version: string; releaseNotes: unknown } | null = null;
  autoUpdater.on("update-available", (info) => {
    latest = { version: info.version, releaseNotes: info.releaseNotes };
    getMainWindow()?.webContents.send("update-available", latest);
  });
  autoUpdater.on("error", (err) => {
    getMainWindow()?.webContents.send("update-error", err.message);
  });

  const openDownloadPage = async (): Promise<void> => {
    updaterLogger.info(`Opening ${DOWNLOAD_PAGE_URL} for a manual update`);
    await shell.openExternal(DOWNLOAD_PAGE_URL);
    // The renderer moved to "downloading" before invoking and only leaves it on
    // an event; put it back on "available" so the button stays usable.
    if (latest) getMainWindow()?.webContents.send("update-available", latest);
  };

  ipcMain.handle("check-for-updates", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.updateInfo?.version || null;
    } catch {
      return null;
    }
  });
  ipcMain.handle("download-update", async () => {
    try {
      await openDownloadPage();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      getMainWindow()?.webContents.send("update-error", message);
      return false;
    }
  });
  ipcMain.handle("install-update", () => openDownloadPage());

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);
}
