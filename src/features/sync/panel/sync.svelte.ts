import { sendMessage } from '../../../core/messaging/rpc';
import { DEFAULT_SYNC_CONFIG, loadSyncConfig, syncConfigItem } from '../persist/sync-config';

/** Status projection only. Sync runs in the background, independently of panel lifetime. */
class SyncStore {
  config = $state({ ...DEFAULT_SYNC_CONFIG });
  enabled = $derived(this.config.enabled);
  lastSyncedAt = $derived(this.config.lastSyncedAt);
  lastError = $derived(this.config.lastError);
  status = $derived(!this.enabled ? 'off' : this.config.syncing ? 'syncing' : this.lastError ? 'error' : 'idle');
  usedPercent = $derived(Math.round(this.config.usedBytes / 102400 * 100));
  async init() {
    this.config = await loadSyncConfig();
    syncConfigItem.watch((value) => { this.config = { ...DEFAULT_SYNC_CONFIG, ...value }; });
  }
  enable = () => sendMessage('librarySync', 'enable');
  disable = () => sendMessage('librarySync', 'disable');
  syncNow = () => sendMessage('librarySync', 'now');
  deleteRemote = () => sendMessage('librarySync', 'delete');
}
export const sync = new SyncStore();
