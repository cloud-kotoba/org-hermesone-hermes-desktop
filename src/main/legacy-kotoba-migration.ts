/**
 * One-shot carry-over from the app's Kotoba name (0.7.12 and earlier) to
 * Mithril. Imported FIRST by index.ts: the move has to happen before any
 * module resolves `app.getPath("userData")` (gpu-fallback caches it at load).
 *
 * The Electron data directory is named after the product, so the rename
 * would otherwise start every existing install from a blank window state,
 * renderer settings and session partitions. When `<appData>/Mithril` does
 * not exist yet and `<appData>/Kotoba` does, the old directory is moved into
 * place, and the two session partitions follow their new names
 * (`kotoba-cloud` → `mithril`, `kotoba-cloud-gateway` → `mithril-gateway`).
 *
 * The keychain-encrypted token (mithril-token-store.ts) cannot come along
 * this way: Electron's safeStorage key is held under the app's name in the
 * OS keychain, so a token written by Kotoba does not decrypt under Mithril
 * and the account reads as signed out once — sign in again.
 */
import { app } from "electron";
import { existsSync, renameSync } from "fs";
import { join } from "path";

export const LEGACY_APP_DIR = "Kotoba";

const LEGACY_PARTITIONS: ReadonlyArray<[string, string]> = [
  ["kotoba-cloud", "mithril"],
  ["kotoba-cloud-gateway", "mithril-gateway"],
];

/**
 * Move `<appData>/Kotoba` to `userDataDir` when the latter does not exist yet.
 * Returns true when it moved. Never throws — a failure leaves the app on a
 * fresh directory, which is where it would be without this step.
 */
export function migrateLegacyUserData(
  appDataDir: string,
  userDataDir: string,
): boolean {
  try {
    const legacy = join(appDataDir, LEGACY_APP_DIR);
    if (legacy === userDataDir) return false;
    if (existsSync(userDataDir) || !existsSync(legacy)) return false;
    renameSync(legacy, userDataDir);
    const partitions = join(userDataDir, "Partitions");
    for (const [from, to] of LEGACY_PARTITIONS) {
      const src = join(partitions, from);
      const dst = join(partitions, to);
      if (existsSync(src) && !existsSync(dst)) renameSync(src, dst);
    }
    return true;
  } catch (err) {
    console.warn(
      "[mithril] could not carry over the Kotoba data directory:",
      err,
    );
    return false;
  }
}

// Packaged builds only: a dev run's userData is named after package.json
// (`mithril-desktop`), never the old product directory.
if (app.isPackaged && !process.env.HERMES_DESKTOP_USER_DATA_DIR?.trim()) {
  if (migrateLegacyUserData(app.getPath("appData"), app.getPath("userData"))) {
    console.log("[mithril] carried over the Kotoba data directory");
  }
}
