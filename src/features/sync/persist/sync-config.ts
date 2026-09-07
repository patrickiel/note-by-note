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
export async function loadSyncConfig(): Promise<SyncConfig> {
  const raw = await syncConfigItem.getValue();
  return Object.fromEntries(Object.entries(DEFAULT_SYNC_CONFIG).map(([key, fallback]) =>
    [key, raw[key as keyof SyncConfig] ?? fallback])) as unknown as SyncConfig;
}
