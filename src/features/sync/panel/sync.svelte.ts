import { encodeBackup } from '../../../core/persist/backup-codec';
import { createBackup, restoreBackup, type Backup } from '../../../core/persist/backup';
import { session } from '../../../core/state/session.svelte';
import { fitBackup } from '../persist/fit';
import { contentHash } from '../persist/hash';
import { mergeBackups } from '../persist/merge';
import {
  BUDGET_CHARS,
  itemsBytes,
  packBackup,
  packedChars,
  SYNC_QUOTA_BYTES,
  unpackBackup,
} from '../persist/sync-blob';
import {
  classifySyncError,
  clearSyncArea,
  onSyncAreaChanged,
  readSyncArea,
  syncErrorMessage,
  writeSyncArea,
} from '../persist/sync-area';
import {
  DEFAULT_SYNC_CONFIG,
  loadSyncConfig,
  syncConfigItem,
  type SyncConfig,
} from '../persist/sync-config';

/** Trailing debounce after the last data change before pushing. */
const PUSH_DEBOUNCE_MS = 5000;
/** Writes are metered by the browser (120/min); keep ours far under that. */
const MIN_PUSH_SPACING_MS = 30_000;
/** Chunks arrive one by one; wait for the burst before reading. */
const REMOTE_DEBOUNCE_MS = 1500;
/** A torn read is usually a write still landing: look again shortly … */
const TORN_RETRY_MS = 5000;
/** … but not forever — past this, the writer died mid-write; our copy wins. */
const TORN_GIVE_UP_MS = 90_000;
const RATE_LIMIT_RETRY_MS = 65_000;
/** Belt and braces: the change event should carry everything, but a missed
 * one must not mean a device stays stale until the next panel open. */
const SAFETY_INTERVAL_MS = 5 * 60_000;

/** Raw storage keys (no `local:` prefix in change events) that belong to the
 * backup. `syncConfig` itself is deliberately absent. */
const SYNCED_KEY_RE = /^(settings|uiPrefs|history|favorites|eqPresets|deletions|track:)/;

const measure = (backup: Backup) => packedChars(encodeBackup(backup));

function isEmpty(backup: Backup): boolean {
  return (
    backup.history.length === 0 &&
    backup.favorites.length === 0 &&
    backup.tracks.length === 0 &&
    backup.eqPresets.length === 0 &&
    Object.keys(backup.deletions ?? {}).length === 0
  );
}

/**
 * Cross-device sync through the browser's own synced storage — no server,
 * no account, no ID: whoever signs into the same browser profile gets the
 * data, because the browser vendor's sync carries it (see `sync-blob.ts` for
 * the layout, `merge.ts` for how two copies become one).
 *
 * One routine, `#reconcile`, does everything: read the area, compare with
 * what this device last saw, merge, then write locally and/or remotely as
 * needed. Local changes (storage events) and remote ones (sync-area events)
 * both just ask for a reconcile. Applying a merge that changes local data
 * ends in a panel reload — stores read storage once at start-up, same as the
 * import flow — so that is deferred while a track is loaded and picked up on
 * the next quiet moment, panel open, or "Sync now".
 *
 * Runs only in the sidepanel: it is the sole writer of synced data, so there
 * is nothing to observe while it's closed. A change the panel didn't manage
 * to push before closing is remembered via `pendingPush`.
 */
class SyncStore {
  enabled = $state(false);
  lastSyncedAt = $state(0);
  lastError = $state<string | null>(null);
  /** The last push left old songs or charts out to fit the quota. */
  trimmed = $state(false);
  /** Bytes the area holds, by the browser's accounting. */
  usedBytes = $state(0);
  /** Another device's changes are in, waiting for a moment without a track
   * loaded (applying reloads the panel). "Sync now" applies them at once. */
  pendingApply = $state(false);
  #syncing = $state(false);

  status = $derived<'off' | 'syncing' | 'error' | 'idle'>(
    !this.enabled ? 'off' : this.#syncing ? 'syncing' : this.lastError ? 'error' : 'idle',
  );
  usedPercent = $derived(
    this.usedBytes ? Math.max(1, Math.round((this.usedBytes / SYNC_QUOTA_BYTES) * 100)) : 0,
  );

  #config: SyncConfig = { ...DEFAULT_SYNC_CONFIG };
  /** Suppresses the echo of our own `syncConfigItem` write. */
  #writing = false;
  /** Suppresses local change events while a merge is being written. */
  #applying = false;
  #pushTimer: ReturnType<typeof setTimeout> | undefined;
  #remoteTimer: ReturnType<typeof setTimeout> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #lastPushAt = 0;
  #tornSince = 0;
  /** Serializes reconciles so they can't interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  async init() {
    this.#config = await loadSyncConfig();
    this.#reflect();
    syncConfigItem.watch((value) => {
      if (this.#writing) return;
      this.#config = value ?? { ...DEFAULT_SYNC_CONFIG };
      this.#reflect();
    });
    browser.storage.local.onChanged.addListener((changes) => {
      if (this.#applying || !this.#config.enabled) return;
      if (!Object.keys(changes).some((key) => SYNCED_KEY_RE.test(key))) return;
      this.#onDataChanged();
    });
    onSyncAreaChanged(() => {
      if (!this.#config.enabled) return;
      clearTimeout(this.#remoteTimer);
      this.#remoteTimer = setTimeout(() => {
        void this.#enqueue(() => this.#reconcile({ allowApply: session.media === null }));
      }, REMOTE_DEBOUNCE_MS);
    });
    if (this.#config.enabled) {
      await this.#enqueue(() => this.#reconcile({ allowApply: true }));
    }
    setInterval(() => {
      if (!this.#config.enabled) return;
      void this.#enqueue(() => this.#reconcile({ allowApply: session.media === null }));
    }, SAFETY_INTERVAL_MS);
  }

  async enable(): Promise<void> {
    await this.#saveConfig({ enabled: true, lastError: null });
    await this.#enqueue(() => this.#reconcile({ allowApply: true }));
  }

  async disable(): Promise<void> {
    clearTimeout(this.#pushTimer);
    clearTimeout(this.#retryTimer);
    this.pendingApply = false;
    await this.#saveConfig({ enabled: false });
  }

  /** Back up now and pull in the other devices' changes, reload included. */
  async syncNow(): Promise<void> {
    await this.#enqueue(() => this.#reconcile({ allowApply: true }));
  }

  /**
   * Empties the synced copy and turns sync off — left on, the next change
   * would quietly re-upload. Other devices with sync on will re-seed it from
   * their own data the next time they change something.
   */
  async deleteRemote(): Promise<void> {
    clearTimeout(this.#pushTimer);
    clearTimeout(this.#retryTimer);
    this.pendingApply = false;
    await this.#enqueue(async () => {
      this.#syncing = true;
      try {
        await clearSyncArea();
        this.usedBytes = 0;
        await this.#saveConfig({
          enabled: false,
          lastSyncedAt: 0,
          lastRemoteHash: null,
          lastLocalHash: null,
          pendingPush: false,
          lastError: null,
          trimmed: false,
        });
      } catch (err) {
        await this.#saveConfig({ lastError: syncErrorMessage(err) });
        throw err;
      } finally {
        this.#syncing = false;
      }
    });
  }

  #reflect() {
    this.enabled = this.#config.enabled;
    this.lastSyncedAt = this.#config.lastSyncedAt;
    this.lastError = this.#config.lastError;
    this.trimmed = this.#config.trimmed;
  }

  async #saveConfig(patch: Partial<SyncConfig>) {
    this.#config = { ...this.#config, ...patch };
    this.#reflect();
    this.#writing = true;
    try {
      await syncConfigItem.setValue(this.#config);
    } finally {
      this.#writing = false;
    }
  }

  #enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(op, op);
    this.#queue = result.catch(() => {});
    return result;
  }

  #onDataChanged() {
    // Persisted immediately (not on the debounce) so a panel closed mid-burst
    // still knows there is unpushed data next time it opens.
    void this.#saveConfig({ pendingPush: true, lastChangedAt: Date.now() });
    this.#schedulePush(PUSH_DEBOUNCE_MS);
  }

  #schedulePush(delayMs: number) {
    clearTimeout(this.#pushTimer);
    const spacing = this.#lastPushAt + MIN_PUSH_SPACING_MS - Date.now();
    this.#pushTimer = setTimeout(
      () => void this.#enqueue(() => this.#reconcile({ allowApply: session.media === null })),
      Math.max(delayMs, spacing),
    );
  }

  #retryIn(delayMs: number) {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(
      () => void this.#enqueue(() => this.#reconcile({ allowApply: session.media === null })),
      delayMs,
    );
  }

  /**
   * The whole algorithm. Reads the area and this device's data, then:
   *  - nothing there → seed it (unless this device has nothing either);
   *  - torn → wait for the rest to land, retry;
   *  - unchanged since last look → push if this device changed something;
   *  - otherwise merge the two copies, write the result wherever it differs.
   */
  async #reconcile(opts: { allowApply: boolean }) {
    if (!this.#config.enabled) return;
    this.#syncing = true;
    let applied = false;
    try {
      const { result, bytes } = await readSyncArea();
      this.usedBytes = bytes;
      const local = await createBackup();
      const localHash = await contentHash(local);
      const localChanged = localHash !== this.#config.lastLocalHash;

      if (result.kind === 'torn') {
        if (!this.#tornSince) this.#tornSince = Date.now();
        if (Date.now() - this.#tornSince < TORN_GIVE_UP_MS) {
          this.#retryIn(TORN_RETRY_MS);
          return;
        }
        // Nobody finished that write; ours replaces it. Whatever it carried
        // comes back merged when its writer reconciles against ours.
        this.#tornSince = 0;
        await this.#push(local, localHash);
        return;
      }
      this.#tornSince = 0;

      if (result.kind === 'none') {
        if (isEmpty(local) && !this.#config.pendingPush) return;
        await this.#push(local, localHash);
        return;
      }

      const { meta, base64 } = result;
      if (meta.h === this.#config.lastRemoteHash) {
        // Remote is what we last saw (our own echo included).
        if (localChanged || this.#config.pendingPush) await this.#push(local, localHash);
        else if (this.#config.lastError) await this.#saveConfig({ lastError: null });
        return;
      }

      // Another device wrote since we last looked.
      const remote = await unpackBackup(base64);
      const remoteWins = !localChanged || remote.exportedAt > this.#config.lastChangedAt;
      const merged = mergeBackups(local, remote, remoteWins);
      const [mergedHash, remoteHash] = await Promise.all([
        contentHash(merged),
        contentHash(remote),
      ]);
      const needApply = mergedHash !== localHash;
      const needPush = mergedHash !== remoteHash;

      if (needApply && !opts.allowApply) {
        // A track is loaded; applying would reload the panel mid-practice.
        // Nothing is pushed either: a push now would carry only our side.
        this.pendingApply = true;
        return;
      }
      this.pendingApply = false;
      if (needApply) {
        // #applying stays set until the reload: nothing in between may
        // schedule a push of what was just written.
        this.#applying = true;
        clearTimeout(this.#pushTimer);
        await restoreBackup(merged);
        applied = true;
      }
      if (needPush) {
        await this.#push(merged, mergedHash);
      } else {
        await this.#saveConfig({
          lastSyncedAt: meta.at,
          lastRemoteHash: meta.h,
          lastLocalHash: mergedHash,
          pendingPush: false,
          lastError: null,
        });
      }
    } catch (err) {
      await this.#saveConfig({ lastError: syncErrorMessage(err) });
      if (classifySyncError(err) === 'rate') this.#retryIn(RATE_LIMIT_RETRY_MS);
    } finally {
      this.#syncing = false;
      // Local data changed under the stores (same situation as an import):
      // the reload is owed whether or not the push after it went through.
      if (applied) location.reload();
    }
  }

  /** Writes `backup` to the area, cut to the quota if it must be. `hash` is
   * the content hash of this device's full data, so a trimmed push doesn't
   * read as "local changed" on the next pass. */
  async #push(backup: Backup, hash: string) {
    const fitted = await fitBackup(backup, BUDGET_CHARS, measure);
    const exportedAt = Date.now();
    const packed = await packBackup(
      encodeBackup({ ...fitted.backup, exportedAt }),
      browser.runtime.getManifest().version,
    );
    await writeSyncArea(packed.items);
    this.#lastPushAt = Date.now();
    this.usedBytes = itemsBytes(packed.items);
    await this.#saveConfig({
      lastSyncedAt: exportedAt,
      lastRemoteHash: packed.meta.h,
      lastLocalHash: hash,
      pendingPush: false,
      lastError: null,
      trimmed: fitted.trimmed,
    });
  }
}

export const sync = new SyncStore();
