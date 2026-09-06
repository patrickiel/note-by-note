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
  /** Hash of the local data at last sync; a matching hash means there is
   * nothing new to push (also swallows the echo of applying a remote copy). */
  lastSyncedHash: string | null;
  /** A change happened but the push hasn't landed yet — survives the panel
   * closing mid-debounce so the next open retries. */
  pendingPush: boolean;
  lastError: string | null;
  /** This device agreed to exchange data with whatever is in the browser's
   * sync area. Sync is on by default and the area is shared by every install
   * on the profile, so a device can meet a snapshot it never asked for — and
   * applying it overwrites what is here. Consent is implied when there is
   * nothing to lose (a fresh install, or this device seeded the area) and
   * given explicitly via the panel otherwise. Per-device like the rest of
   * this record — consent doesn't travel in a backup. */
  consented: boolean;
  /** The last push had to leave something out to fit the quota — drives the
   * hint in Settings. */
  trimmed: boolean;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  enabled: true,
  lastSyncedAt: 0,
  lastChangedAt: 0,
  lastSyncedHash: null,
  pendingPush: false,
  lastError: null,
  consented: false,
  trimmed: false,
};

export const syncConfigItem = storage.defineItem<SyncConfig>('local:syncConfig', {
  fallback: DEFAULT_SYNC_CONFIG,
});

/** Fields of the record as written by builds that synced to a server under a
 * secret ID. Their presence marks a record to migrate. */
interface LegacySyncConfig {
  enabled?: boolean;
  lastChangedAt?: number;
  consentedId?: string | null;
  syncId?: string | null;
}

/**
 * Reads the bookkeeping, migrating a record left by the server-backed sync
 * on the first run after the update: the switch is kept, the rest refers to
 * a snapshot that no longer exists and is reset so the first reconcile seeds
 * the browser's sync area (or, if another upgraded device already did, meets
 * it the same way a new install would). The old ID in the sync area is
 * removed — nothing reads it any more.
 */
export async function loadSyncState(): Promise<SyncConfig> {
  const raw = (await syncConfigItem.getValue()) as SyncConfig & LegacySyncConfig;
  if (!('consentedId' in raw) && !('syncId' in raw)) return raw;
  const config: SyncConfig = {
    ...DEFAULT_SYNC_CONFIG,
    enabled: raw.enabled ?? true,
    lastChangedAt: raw.lastChangedAt ?? 0,
    pendingPush: true,
  };
  await syncConfigItem.setValue(config);
  await browser.storage.sync.remove('syncId').catch(() => {});
  return config;
}
