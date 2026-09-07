import { storage } from '#imports';
export interface SyncConfig {
  enabled: boolean;
  lastSyncedAt: number;
  lastPushAt: number;
  lastError: string | null;
  usedBytes: number;
  syncing: boolean;
}
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  enabled: true, lastSyncedAt: 0, lastPushAt: 0, lastError: null, usedBytes: 0, syncing: false,
};
export const syncConfigItem = storage.defineItem<SyncConfig>('local:syncConfig', { fallback: DEFAULT_SYNC_CONFIG });
/** A stored config written before a field existed still lacks it. */
export const withSyncDefaults = (value: Partial<SyncConfig> | null): SyncConfig => ({ ...DEFAULT_SYNC_CONFIG, ...value });
export const loadSyncConfig = async (): Promise<SyncConfig> => withSyncDefaults(await syncConfigItem.getValue());
