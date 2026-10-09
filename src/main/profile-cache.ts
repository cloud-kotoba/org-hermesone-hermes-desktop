/**
 * Invalidation hook for the profile list cache in profiles.ts.
 *
 * Kept in its own module so writers that profiles.ts itself imports (such as
 * profile-meta.ts) can invalidate without an import cycle. profiles.ts
 * registers the listener; anything that changes what `listProfiles()` would
 * return calls `invalidateProfileCache`.
 */

type Listener = (id?: string) => void;
const listeners = new Set<Listener>();

/** Drop cached profile data. Without an id every profile is dropped. */
export function invalidateProfileCache(id?: string): void {
  for (const listener of listeners) listener(id);
}

export function onProfileCacheInvalidated(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
