import { storage } from '#imports';

/** Per-device sync bookkeeping. Deliberately not part of `Backup` (like
 * grantedOrigins): restoring a backup from another device must not clobber
 * this device's bookkeeping. */
export interface SyncConfig {
  enabled: boolean;
  /** `exportedAt` of the last blob pushed or merged in; 0 = never synced. */
  lastSyncedAt: number;
  /** Wall clock of the last local data change — this device's side of
   * "whose settings win" against a remote blob's clock. */
  lastChangedAt: number;
  /** `meta.h` of the blob this device last reconciled with. The same hash on
   * the next read means nothing new arrived (our own write echo included). */
  lastRemoteHash: string | null;
  /** Content hash of this device's data at the last reconcile; a different
   * one now means there is something to push. */
  lastLocalHash: string | null;
  /** A change happened but the push hasn't landed yet — survives the panel
   * closing mid-debounce so the next open retries. */
  pendingPush: boolean;
  lastError: string | null;
  /** The last push had to leave old songs or charts out to fit the quota. */
  trimmed: boolean;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  enabled: true,
  lastSyncedAt: 0,
  lastChangedAt: 0,
  lastRemoteHash: null,
  lastLocalHash: null,
  pendingPush: false,
  lastError: null,
  trimmed: false,
};

export const syncConfigItem = storage.defineItem<SyncConfig>('local:syncConfig', {
  fallback: DEFAULT_SYNC_CONFIG,
});

/** Reads the record, migrating one written by the server-era builds (which
 * carried `syncId`/`consentedId` and hashes over a different shape): the
 * on/off choice is kept, the bookkeeping starts over so the first reconcile
 * merges rather than trusting stale hashes. */
export async function loadSyncConfig(): Promise<SyncConfig> {
  const raw = (await syncConfigItem.getValue()) as Partial<SyncConfig> & {
    syncId?: unknown;
    consentedId?: unknown;
    lastSyncedHash?: unknown;
  };
  const legacy = 'syncId' in raw || 'consentedId' in raw || 'lastSyncedHash' in raw;
  if (!legacy) return { ...DEFAULT_SYNC_CONFIG, ...raw };
  const config: SyncConfig = {
    ...DEFAULT_SYNC_CONFIG,
    enabled: raw.enabled ?? true,
    lastChangedAt: raw.lastChangedAt ?? 0,
    pendingPush: true,
  };
  await syncConfigItem.setValue(config);
  return config;
}
