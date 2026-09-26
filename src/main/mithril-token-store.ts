// @lat: [[mithril-account#Mithril account#Token at rest]]
/**
 * The Mithril personal API token (`kc_pat_…`) at rest, encrypted with
 * the OS keychain through Electron `safeStorage` — the pattern of
 * account-store.ts and wallet-store.ts. One small file per profile home,
 * `mithril-token.json`, holding only the ciphertext.
 *
 * This module is the storage primitive only. Everything that needs the token
 * reads it through `readEnv()` (config.ts overlays it as `KOTOBA_API_KEY`) or
 * `mithrilToken()` (mithril-account.ts); nothing else opens this
 * file. It deliberately depends on nothing but fs + utils + electron so
 * config.ts can import it without closing another cycle.
 *
 * Every `safeStorage` touch is guarded: a test that mocks `electron` without
 * `safeStorage` (vitest throws on a missing export) and a Linux session with
 * no keyring both read as "encryption unavailable", never as a crash.
 */
import { safeStorage } from "electron";
import { existsSync, readFileSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { profileHome, safeWriteFile } from "./utils";

export const MITHRIL_TOKEN_FILE = "mithril-token.json";
/** The file's name before the app was renamed from Kotoba (0.7.12 and earlier). */
export const LEGACY_TOKEN_FILE = "kotoba-cloud-token.json";

interface StoredToken {
  version: 1;
  encryptedToken: string;
}

/**
 * The profile's token file. A file still under the Kotoba-era name is moved
 * to the current one the first time it is looked up. Whether it decrypts
 * depends on the platform: the keychain entry safeStorage keys it with is
 * named after the app on macOS, so there it reads as no token (sign in
 * again); Windows keeps the key in the migrated userData directory.
 */
function tokenPath(profile?: string): string {
  const home = profileHome(profile);
  const file = join(home, MITHRIL_TOKEN_FILE);
  const legacy = join(home, LEGACY_TOKEN_FILE);
  if (!existsSync(file) && existsSync(legacy)) {
    try {
      renameSync(legacy, file);
    } catch {
      // best-effort — a later lookup retries
    }
  }
  return file;
}

/** True when the OS keychain can encrypt here; false (never throws) otherwise. */
export function mithrilSecureStorageAvailable(): boolean {
  try {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  } catch {
    return false;
  }
}

/** Whether a stored (encrypted) token file exists for the profile. */
export function hasStoredMithrilToken(profile?: string): boolean {
  return existsSync(tokenPath(profile));
}

/**
 * Decrypt the profile's stored token, or null when there is none, the file is
 * corrupt, or the keychain refuses (e.g. the app was re-signed and lost
 * access). Never throws.
 */
export function readStoredMithrilToken(profile?: string): string | null {
  const file = tokenPath(profile);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(
      readFileSync(file, "utf-8"),
    ) as Partial<StoredToken>;
    if (parsed?.version !== 1 || typeof parsed.encryptedToken !== "string")
      return null;
    const token = safeStorage
      .decryptString(Buffer.from(parsed.encryptedToken, "base64"))
      .trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Encrypt and store a token. Throws when the keychain is unavailable — the
 * caller decides the fallback; this module never writes plaintext. The write
 * is proven by decrypting it back, so a caller that removes the plaintext copy
 * afterwards cannot lose the token to a keychain that encrypts but won't
 * decrypt.
 */
export function writeStoredMithrilToken(
  profile: string | undefined,
  token: string,
): void {
  const value = token.trim();
  if (!value) throw new Error("Refusing to store an empty token.");
  if (!mithrilSecureStorageAvailable()) {
    throw new Error("Secure storage is not available on this device.");
  }
  const stored: StoredToken = {
    version: 1,
    encryptedToken: safeStorage.encryptString(value).toString("base64"),
  };
  safeWriteFile(tokenPath(profile), JSON.stringify(stored, null, 2));
  if (readStoredMithrilToken(profile) !== value) {
    throw new Error("The keychain did not return the token it stored.");
  }
}

/** Remove the stored token for a profile (best-effort). */
export function clearStoredMithrilToken(profile?: string): void {
  const file = tokenPath(profile);
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch {
    // best-effort — the file holds ciphertext only
  }
}
