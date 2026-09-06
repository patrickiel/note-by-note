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
  clearSyncArea,
  isRateLimited,
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
 * needed. Local changes (storage events), remote ones (sync-area events),
 * retries and the push debounce all just ask for a reconcile later — one
 * timer, latest request wins — and the push spacing is enforced in `#push`.
 * Applying a merge that changes local data ends in a panel reload — stores
 * read storage once at start-up, same as the import flow — so that is
 * deferred while a track is loaded and picked up on the next quiet moment,
 * panel open, or "Sync now".
 *
 * Runs in every open panel document (there can be more than one: a Firefox
 * window each, the local-player tab). They share `syncConfig` through its
 * watch, so at worst two push the same content, which the spacing absorbs.
 * A change the panel didn't manage to push before closing is remembered via
 * `pendingPush`.
 */
class SyncStore {
  config = $state<SyncConfig>({ ...DEFAULT_SYNC_CONFIG });
  enabled = $derived(this.config.enabled);
  lastSyncedAt = $derived(this.config.lastSyncedAt);
  lastError = $derived(this.config.lastError);
  /** The last push left old songs or charts out to fit the quota. */
  trimmed = $derived(this.config.trimmed);
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

  /** Suppresses local change events while a merge is being written. */
  #applying = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #lastPushAt = 0;
  #tornSince = 0;
  /** Serializes reconciles so they can't interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  async init() {
    this.config = await loadSyncConfig();
    // Another panel document's bookkeeping, and the echo of our own writes
    // (which is the value already held — harmless).
    syncConfigItem.watch((value) => {
      this.config = value ?? { ...DEFAULT_SYNC_CONFIG };
    });
    browser.storage.local.onChanged.addListener((changes) => {
      if (this.#applying || !this.config.enabled) return;
      if (!Object.keys(changes).some((key) => SYNCED_KEY_RE.test(key))) return;
      // Persisted immediately (not on the debounce) so a panel closed
      // mid-burst still knows there is unpushed data next time it opens.
      void this.#saveConfig({ pendingPush: true, lastChangedAt: Date.now() });
      this.#reconcileIn(PUSH_DEBOUNCE_MS);
    });
    onSyncAreaChanged(() => {
      if (this.config.enabled) this.#reconcileIn(REMOTE_DEBOUNCE_MS);
    });
    if (this.config.enabled) await this.#enqueue(() => this.#reconcile(true));
    setInterval(() => {
      if (this.config.enabled) void this.#enqueue(() => this.#reconcile());
    }, SAFETY_INTERVAL_MS);
  }

  async enable(): Promise<void> {
    await this.#saveConfig({ enabled: true, lastError: null });
    await this.#enqueue(() => this.#reconcile(true));
  }

  async disable(): Promise<void> {
    clearTimeout(this.#timer);
    this.pendingApply = false;
    await this.#saveConfig({ enabled: false });
  }

  /** Back up now and pull in the other devices' changes, reload included. */
  async syncNow(): Promise<void> {
    await this.#enqueue(() => this.#reconcile(true));
  }

  /**
   * Empties the synced copy and turns sync off — left on, the next change
   * would quietly re-upload. Other devices with sync on will re-seed it from
   * their own data the next time they change something.
   */
  async deleteRemote(): Promise<void> {
    await this.disable();
    await this.#enqueue(async () => {
      this.#syncing = true;
      try {
        await clearSyncArea();
        this.usedBytes = 0;
        await this.#saveConfig({ ...DEFAULT_SYNC_CONFIG, enabled: false });
      } catch (err) {
        await this.#saveConfig({ lastError: syncErrorMessage(err) });
        throw err;
      } finally {
        this.#syncing = false;
      }
    });
  }

  async #saveConfig(patch: Partial<SyncConfig>) {
    this.config = { ...this.config, ...patch };
    await syncConfigItem.setValue($state.snapshot(this.config));
  }

  #enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(op, op);
    this.#queue = result.catch(() => {});
    return result;
  }

  /** Reconcile after `delayMs`; a later request replaces an earlier one. */
  #reconcileIn(delayMs: number) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#enqueue(() => this.#reconcile()), delayMs);
  }

  /**
   * The whole algorithm. Reads the area and this device's data, then:
   *  - nothing there → seed it (unless this device has nothing either);
   *  - torn → wait for the rest to land, retry;
   *  - unchanged since last look → push if this device changed something;
   *  - otherwise merge the two copies, write the result wherever it differs.
   *
   * Applying (writing a merge locally) reloads the panel, so it waits for a
   * moment without a track loaded unless `force` — "Sync now", enabling,
   * opening the panel.
   */
  async #reconcile(force = false) {
    if (!this.config.enabled) return;
    this.#syncing = true;
    let applied = false;
    try {
      const { result, bytes } = await readSyncArea();
      this.usedBytes = bytes;
      const local = await createBackup();
      const localHash = await contentHash(local);
      const localChanged = localHash !== this.config.lastLocalHash;

      if (result.kind === 'torn') {
        if (!this.#tornSince) this.#tornSince = Date.now();
        if (Date.now() - this.#tornSince < TORN_GIVE_UP_MS) {
          this.#reconcileIn(TORN_RETRY_MS);
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
        if (isEmpty(local) && !this.config.pendingPush) return;
        await this.#push(local, localHash);
        return;
      }

      const { meta, base64 } = result;
      if (meta.h === this.config.lastRemoteHash) {
        // Remote is what we last saw (our own echo included).
        if (localChanged || this.config.pendingPush) await this.#push(local, localHash);
        else if (this.config.lastError) await this.#saveConfig({ lastError: null });
        return;
      }

      // Another device wrote since we last looked.
      const remote = await unpackBackup(base64);
      const remoteWins = !localChanged || remote.exportedAt > this.config.lastChangedAt;
      const merged = mergeBackups(local, remote, remoteWins);
      const [mergedHash, remoteHash] = await Promise.all([
        contentHash(merged),
        contentHash(remote),
      ]);
      const needApply = mergedHash !== localHash;
      const needPush = mergedHash !== remoteHash;

      if (needApply && !force && session.media !== null) {
        // A track is loaded; applying would reload the panel mid-practice.
        // Nothing is pushed either: a push now would carry only our side.
        this.pendingApply = true;
        return;
      }
      this.pendingApply = false;
      if (needApply) {
        // #applying stays set until the reload: nothing in between may
        // schedule a push of what was just written. The reload is owed from
        // here on, even if the restore fails halfway.
        this.#applying = true;
        clearTimeout(this.#timer);
        applied = true;
        await restoreBackup(merged);
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
      if (isRateLimited(err)) this.#reconcileIn(RATE_LIMIT_RETRY_MS);
    } finally {
      this.#syncing = false;
      // Local data changed under the stores (same situation as an import).
      if (applied) location.reload();
    }
  }

  /** Writes `backup` to the area, cut to the quota if it must be — or, too
   * soon after the last write, comes back for it later (the next reconcile
   * reaches the same conclusion; `pendingPush` and the hashes are untouched
   * until the write lands). `hash` is the content hash of this device's full
   * data, so a trimmed push doesn't read as "local changed" next time. */
  async #push(backup: Backup, hash: string) {
    const wait = this.#lastPushAt + MIN_PUSH_SPACING_MS - Date.now();
    if (wait > 0) {
      this.#reconcileIn(wait);
      return;
    }
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
