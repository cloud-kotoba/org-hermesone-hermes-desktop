// @lat: [[kotoba-cloud-account#Kotoba Cloud account#Token at rest]]
/**
 * The Kotoba Cloud personal API token (`kc_pat_…`) at rest, encrypted with
 * the OS keychain through Electron `safeStorage` — the pattern of
 * account-store.ts and wallet-store.ts. One small file per profile home,
 * `kotoba-cloud-token.json`, holding only the ciphertext.
 *
 * This module is the storage primitive only. Everything that needs the token
 * reads it through `readEnv()` (config.ts overlays it as `KOTOBA_API_KEY`) or
 * `kotobaCloudToken()` (kotoba-cloud-account.ts); nothing else opens this
 * file. It deliberately depends on nothing but fs + utils + electron so
 * config.ts can import it without closing another cycle.
 *
 * Every `safeStorage` touch is guarded: a test that mocks `electron` without
 * `safeStorage` (vitest throws on a missing export) and a Linux session with
 * no keyring both read as "encryption unavailable", never as a crash.
 */
import { safeStorage } from "electron";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { profileHome, safeWriteFile } from "./utils";

export const KOTOBA_TOKEN_FILE = "kotoba-cloud-token.json";

interface StoredToken {
  version: 1;
  encryptedToken: string;
}

function tokenPath(profile?: string): string {
  return join(profileHome(profile), KOTOBA_TOKEN_FILE);
}

/** True when the OS keychain can encrypt here; false (never throws) otherwise. */
export function kotobaSecureStorageAvailable(): boolean {
  try {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  } catch {
    return false;
  }
}

/** Whether a stored (encrypted) token file exists for the profile. */
export function hasStoredKotobaToken(profile?: string): boolean {
  return existsSync(tokenPath(profile));
}

/**
 * Decrypt the profile's stored token, or null when there is none, the file is
 * corrupt, or the keychain refuses (e.g. the app was re-signed and lost
 * access). Never throws.
 */
export function readStoredKotobaToken(profile?: string): string | null {
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
export function writeStoredKotobaToken(
  profile: string | undefined,
  token: string,
): void {
  const value = token.trim();
  if (!value) throw new Error("Refusing to store an empty token.");
  if (!kotobaSecureStorageAvailable()) {
    throw new Error("Secure storage is not available on this device.");
  }
  const stored: StoredToken = {
    version: 1,
    encryptedToken: safeStorage.encryptString(value).toString("base64"),
  };
  safeWriteFile(tokenPath(profile), JSON.stringify(stored, null, 2));
  if (readStoredKotobaToken(profile) !== value) {
    throw new Error("The keychain did not return the token it stored.");
  }
}

/** Remove the stored token for a profile (best-effort). */
export function clearStoredKotobaToken(profile?: string): void {
  const file = tokenPath(profile);
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch {
    // best-effort — the file holds ciphertext only
  }
}
