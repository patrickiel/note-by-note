import { storage } from '#imports';

/** Per-device sync bookkeeping. Deliberately not part of `Backup` (like
 * grantedOrigins): restoring a backup from another device must not clobber
 * this device's bookkeeping. */
export interface SyncConfig {
  enabled: boolean;
  /** `exportedAt` of the last snapshot pushed or applied; 0 = never synced. */
  lastSyncedAt: number;
  /** Wall clock of the last local data change — the local side of
   * last-write-wins against a remote snapshot's `exportedAt`. */
  lastChangedAt: number;
  /** Hash of the data fields at last sync; a matching hash means there is
   * nothing new to push (also swallows the echo of applying a remote copy). */
  lastSyncedHash: string | null;
  /** A change happened but the push hasn't landed yet — survives the panel
   * closing mid-debounce so the next open retries. */
  pendingPush: boolean;
  lastError: string | null;
  /** The sync ID this device agreed to join, if any. Sync is on by default and
   * the ID arrives over browser-profile sync, so a device can be handed an
   * identity it never asked for — and adopting one means a remote snapshot can
   * overwrite everything here. Consent is granted implicitly when there is
   * nothing to lose (a fresh install, or this device minted the ID itself) and
   * explicitly via the panel otherwise. Stored per *identity*, not as a flag:
   * a second ID arriving later is a second decision. Per-device like the rest
   * of this record — consent doesn't travel in a backup. */
  consentedId: string | null;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  enabled: true,
  lastSyncedAt: 0,
  lastChangedAt: 0,
  lastSyncedHash: null,
  pendingPush: false,
  lastError: null,
  consentedId: null,
};

export const syncConfigItem = storage.defineItem<SyncConfig>('local:syncConfig', {
  fallback: DEFAULT_SYNC_CONFIG,
});

/** Secret capability token, 43-char base64url (32 random bytes). Lives in the
 * browser-synced `sync` area so Chrome/Firefox carry it to the user's other
 * devices on the same browser profile — a second install only needs the
 * toggle, not a pasted ID. Kept after disable so re-enabling reuses the same
 * remote blob. */
export const syncIdItem = storage.defineItem<string | null>('sync:syncId', {
  fallback: null,
});

/** `consentedId` postdates the first release. A device that had already synced
 * with its ID consented back when the user switched sync on, so re-asking on
 * upgrade would be noise. Returns whether it wrote anything. */
function backfillConsent(config: SyncConfig, syncId: string | null): boolean {
  if (config.consentedId !== undefined) return false;
  config.consentedId = config.lastSyncedAt > 0 ? syncId : null;
  return true;
}

/** Reads both items, moving a pre-split `syncId` out of `local:syncConfig`
 * into the sync area on the first run after the update. */
export async function loadSyncState(): Promise<{ config: SyncConfig; syncId: string | null }> {
  const [raw, storedId] = await Promise.all([syncConfigItem.getValue(), syncIdItem.getValue()]);
  const { syncId: legacyId, ...config } = raw as SyncConfig & { syncId?: string | null };
  if (legacyId === undefined) {
    if (backfillConsent(config, storedId)) await syncConfigItem.setValue(config);
    return { config, syncId: storedId };
  }
  let syncId = storedId;
  if (legacyId !== null && storedId === null) {
    syncId = legacyId;
    await syncIdItem.setValue(legacyId);
  } else if (legacyId !== null && storedId !== legacyId) {
    // Another device in the profile already established a different identity;
    // adopt it and drop bookkeeping that referred to the old blob.
    config.lastSyncedAt = 0;
    config.lastSyncedHash = null;
    config.pendingPush = false;
  }
  backfillConsent(config, syncId);
  await syncConfigItem.setValue(config);
  return { config, syncId };
}

/** The server accepts `[A-Za-z0-9_-]{43,64}` — same check client-side so a
 * mistyped ID fails before a network round-trip. The lower bound matches what
 * `generateSyncId` produces: anything shorter is guessable, and since the ID is
 * the only credential, a hand-picked short one would be squattable. */
export const SYNC_ID_RE = /^[A-Za-z0-9_-]{43,64}$/;

/** 32 random bytes as base64url (43 chars). The ID is the whole secret. */
export function generateSyncId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
