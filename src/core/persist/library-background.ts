import { onMessage } from '../messaging/rpc';
import { applyCommand, canonical, emptyLibrary, mergeShared, type Library } from './library';
import { libraryItem } from './library-client';
import { parseBackupJson as parseLegacy } from './legacy-backup';
import { parseLibrary } from './backup-codec';
import { migrateBackup } from './library-migration';
import { bytesUsed, changedRecords, legacyKeys, PREFIX, readRecords, skippedMessage } from '../../features/sync/persist/records';
import { loadSyncConfig, syncConfigItem, type SyncConfig } from '../../features/sync/persist/sync-config';

const WAKE = 'library-sync';
const SAFETY = 'library-sync-safety';

/** One writer for edits, imports and merges. Persisted records survive worker restarts. */
export function startLibraryBackground() {
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work);
    queue = result.catch(() => {});
    return result;
  };
  /** `parseLegacy` rejects a damaged file, which is right for a backup the user
   * picked but fatal here: a single bad row would leave the panel with no
   * library at all, on every start, forever. Unusable rows are dropped instead,
   * and a parse that still fails yields an empty library. Either way the old
   * records are left in place, so nothing is beyond recovery. */
  const migrate = (raw: Record<string, unknown>): Library => {
    const defaults = emptyLibrary();
    const identified = (value: unknown) => (Array.isArray(value) ? value : []).filter((row) =>
      typeof (row as { identity?: { normalizedUrl?: unknown } })?.identity?.normalizedUrl === 'string');
    try {
      return migrateBackup(parseLegacy({ format: 'note-by-note-backup', version: 1,
        settings: raw.settings ?? defaults.shared.settings.value, uiPrefs: raw.uiPrefs ?? defaults.local.uiPrefs,
        history: identified(raw.history), favorites: identified(raw.favorites),
        eqPresets: Array.isArray(raw.eqPresets) ? raw.eqPresets : [],
        tracks: identified(Object.entries(raw).filter(([key]) => key.startsWith('track:')).map(([, value]) => value)),
      }));
    } catch (error) {
      console.error('[note-by-note] the previous library could not be migrated; its records are kept', error);
      return defaults;
    }
  };
  let ready: Promise<void> | undefined;
  const init = () => ready ??= (async () => {
    // Only the migration needs every old key. Ordinary wakes read one item.
    if ((await browser.storage.local.get('library')).library) return;
    await libraryItem.setValue(migrate(await browser.storage.local.get(null)));
  })().catch((error) => { ready = undefined; throw error; });
  const saveConfig = (config: SyncConfig) => syncConfigItem.setValue(config);
  const schedule = async () => {
    const config = await loadSyncConfig();
    if (config.enabled) await browser.alarms.create(WAKE, { when: Math.max(Date.now() + 5000, config.lastPushAt + 30000) });
  };
  const reconcile = async () => {
    await init();
    const config = await loadSyncConfig();
    if (!config.enabled) return;
    await saveConfig({ ...config, syncing: true });
    try {
      const existing = await browser.storage.sync.get(null);
      config.usedBytes = bytesUsed(existing);
      const remote = await readRecords(existing);
      const local = await libraryItem.getValue();
      const shared = mergeShared(local.shared, remote);
      if (canonical(shared) !== canonical(local.shared)) await libraryItem.setValue({ ...local, shared });
      const { changes, skipped } = await changedRecords(shared, remote, existing);
      if (Object.keys(changes).length) {
        if (Date.now() < config.lastPushAt + 30000) { await schedule(); return; }
        // Legacy bytes may occupy the quota. Their contents are durable locally before removal.
        const oldKeys = legacyKeys(existing);
        if (oldKeys.length) await browser.storage.sync.remove(oldKeys);
        await browser.storage.sync.set(changes);
        config.lastPushAt = Date.now();
        const final = { ...existing, ...changes };
        for (const key of oldKeys) delete final[key];
        config.usedBytes = bytesUsed(final);
      }
      config.lastSyncedAt = Date.now();
      config.lastError = skipped.length ? skippedMessage(skipped) : null;
    } catch (error) {
      config.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      await saveConfig({ ...config, syncing: false });
    }
  };
  onMessage('libraryRead', () => enqueue(async () => { await init(); return libraryItem.getValue(); }));
  onMessage('libraryEdit', ({ data }) => enqueue(async () => {
    await init();
    if (data.type === 'import') data.library = parseLibrary(data.library);
    const current = await libraryItem.getValue();
    const next = applyCommand(current, data);
    await libraryItem.setValue(next);
    if (canonical(current.shared) !== canonical(next.shared)) await schedule();
  }));
  onMessage('librarySync', ({ data }) => enqueue(async () => {
    const config = await loadSyncConfig();
    if (data === 'disable' || data === 'delete') {
      // Disabled before anything is removed, so a worker restart part-way
      // through the delete cannot wake up and upload the library again.
      await saveConfig(data === 'delete'
        ? { ...config, enabled: false, syncing: false, lastSyncedAt: 0, usedBytes: 0, lastError: null }
        : { ...config, enabled: false, syncing: false });
      await browser.alarms.clear(WAKE);
      if (data === 'delete') {
        const items = await browser.storage.sync.get(null);
        const old = new Set(legacyKeys(items));
        const keys = Object.keys(items).filter((key) => key.startsWith(PREFIX) || old.has(key));
        if (keys.length) await browser.storage.sync.remove(keys);
      }
      return;
    }
    if (data === 'enable') await saveConfig({ ...config, enabled: true });
    await reconcile();
  }));
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WAKE || alarm.name === SAFETY) void enqueue(reconcile);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && Object.keys(changes).some((key) => key.startsWith(PREFIX) || key.startsWith('nbn.'))) {
      void enqueue(reconcile);
    }
  });
  // Recreate the safety alarm on each worker start. No panel has to stay open.
  void browser.alarms.create(SAFETY, { periodInMinutes: 1 });
  void enqueue(reconcile);
}
