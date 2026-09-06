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

/** The stored record over the defaults, known fields only. A record from the
 * server-era builds (`syncId`, hashes over another shape) needs no more than
 * that: its leftovers are dropped here and gone on the next write, and the
 * hashes it lacks read as null, which sends the first reconcile down the
 * merge path rather than trusting anything stale. */
export async function loadSyncConfig(): Promise<SyncConfig> {
  const raw = (await syncConfigItem.getValue()) as Partial<SyncConfig>;
  const config: Record<string, unknown> = { ...DEFAULT_SYNC_CONFIG };
  for (const key of Object.keys(DEFAULT_SYNC_CONFIG)) {
    const value = raw[key as keyof SyncConfig];
    if (value !== undefined) config[key] = value;
  }
  return config as unknown as SyncConfig;
}
