import { encodeBackup, isEmptyBackup } from '../../../core/persist/backup-codec';
import { createBackup, restoreBackup, type Backup } from '../../../core/persist/backup';
import { session } from '../../../core/state/session.svelte';
import type { MediaInfo } from '../../../core/model/types';
import { fitBackup, type FitResult } from '../persist/fit';
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
/** A reconcile that finds everything in order takes milliseconds; without a
 * floor "Syncing…" comes and goes inside a frame and the button reads dead. */
const MIN_VISIBLE_SYNC_MS = 600;
/** Belt and braces: the change event should carry everything, but a missed
 * one must not mean a device stays stale until the next panel open. */
const SAFETY_INTERVAL_MS = 5 * 60_000;

/** Raw storage keys (no `local:` prefix in change events) that belong to the
 * backup. `syncConfig` itself is deliberately absent. */
const SYNCED_KEY_RE = /^(settings|uiPrefs|history|favorites|eqPresets|deletions|track:)/;

const measure = (backup: Backup) => packedChars(encodeBackup(backup));
const fit = (backup: Backup) => fitBackup(backup, BUDGET_CHARS, measure);

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
  /** A depth, not a flag: "Sync now" holds it up for the minimum visible time
   * around a reconcile that drops it as soon as it is done. */
  #busy = $state(0);

  status = $derived<'off' | 'syncing' | 'error' | 'idle'>(
    !this.enabled ? 'off' : this.#busy > 0 ? 'syncing' : this.lastError ? 'error' : 'idle',
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

  /** Back up now and pull in the other devices' changes, reload included.
   * Usually there is nothing to carry — the panel reconciled when it opened
   * and after every change since — so what the click has to show for itself
   * is the status line: "Syncing…" for long enough to read, then a refreshed
   * "Last synced just now". */
  async syncNow(): Promise<void> {
    this.#busy++;
    try {
      await Promise.all([
        this.#enqueue(() => this.#reconcile(true)),
        new Promise((resolve) => setTimeout(resolve, MIN_VISIBLE_SYNC_MS)),
      ]);
    } finally {
      this.#busy--;
    }
  }

  /** The loaded track changed (wired to `session.onMediaChanged` by the panel
   * root). A merge held back because applying it would reload the panel
   * mid-practice has no other cue that its moment has come: without this it
   * waits for the safety interval, up to five minutes after the track went
   * away, while this device carries on pushing its own state. */
  onMedia(media: MediaInfo | null): void {
    if (media === null && this.pendingApply && this.config.enabled) {
      this.#reconcileIn(REMOTE_DEBOUNCE_MS);
    }
  }

  /**
   * Empties the synced copy and turns sync off — left on, the next change
   * would quietly re-upload. Other devices with sync on will re-seed it from
   * their own data the next time they change something.
   */
  async deleteRemote(): Promise<void> {
    await this.disable();
    await this.#enqueue(async () => {
      this.#busy++;
      try {
        await clearSyncArea();
        this.usedBytes = 0;
        await this.#saveConfig({ ...DEFAULT_SYNC_CONFIG, enabled: false });
      } catch (err) {
        await this.#saveConfig({ lastError: syncErrorMessage(err) });
        throw err;
      } finally {
        this.#busy--;
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

  /** Whether a write would come too soon after the last one, scheduling the
   * retry if so. Asked before the encoding work wherever a push is the only
   * thing left to do: the debounce is 5 s and the spacing 30 s, so most of a
   * burst's reconciles have nothing to do but come back later, and gzipping
   * the whole library to find that out is pure waste on the panel's thread. */
  #pushTooSoon(): boolean {
    const wait = this.#lastPushAt + MIN_PUSH_SPACING_MS - Date.now();
    if (wait <= 0) return false;
    this.#reconcileIn(wait);
    return true;
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
    this.#busy++;
    let applied = false;
    try {
      const { result, bytes } = await readSyncArea();
      this.usedBytes = bytes;

      if (result.kind === 'torn') {
        if (!this.#tornSince) this.#tornSince = Date.now();
        if (Date.now() - this.#tornSince < TORN_GIVE_UP_MS) {
          this.#reconcileIn(TORN_RETRY_MS);
          return;
        }
        // Nobody finished that write; ours replaces it. Whatever it carried
        // comes back merged when its writer reconciles against ours.
      }
      this.#tornSince = 0;

      // When there is nothing new from another device, a push is the only
      // thing this reconcile could do — and if the spacing says not yet, it
      // need not read and encode the whole library to find that out. The
      // debounce is 5 s against a 30 s spacing, so during a burst of edits
      // that is most reconciles.
      const pushIsAllThatIsLeft =
        result.kind === 'torn' ||
        (this.config.pendingPush &&
          (result.kind === 'none' || result.meta.h === this.config.lastRemoteHash));
      if (pushIsAllThatIsLeft && this.#pushTooSoon()) return;

      const local = await createBackup();
      const localHash = await contentHash(local);
      const localChanged = localHash !== this.config.lastLocalHash;

      if (result.kind === 'torn') {
        if (!this.#pushTooSoon()) await this.#push(await fit(local), localHash);
        return;
      }

      if (result.kind === 'none') {
        if (isEmptyBackup(local) && !this.config.pendingPush) return;
        if (!this.#pushTooSoon()) await this.#push(await fit(local), localHash);
        return;
      }

      const { meta, base64 } = result;
      if (meta.h === this.config.lastRemoteHash) {
        // Remote is what we last saw (our own echo included).
        if (localChanged || this.config.pendingPush) {
          if (!this.#pushTooSoon()) await this.#push(await fit(local), localHash);
        } else {
          // Nothing to send and nothing to fetch: this device is in agreement
          // with the synced copy as of now, which is what the status line
          // reports. Recording it is the only visible outcome a "Sync now"
          // that finds everything already in order can have.
          await this.#saveConfig({ lastSyncedAt: Date.now(), lastError: null });
        }
        return;
      }

      // Another device wrote since we last looked.
      const remote = await unpackBackup(base64);
      const remoteWins = !localChanged || remote.exportedAt > this.config.lastChangedAt;
      const merged = mergeBackups(local, remote, remoteWins);
      const mergedHash = await contentHash(merged);
      const needApply = mergedHash !== localHash;

      if (needApply && !force && session.media !== null) {
        // A track is loaded; applying would reload the panel mid-practice.
        // Nothing is pushed either: a push now would carry only our side.
        // Before the fit, so a track left loaded for an hour doesn't gzip the
        // library on every tick to throw the result away.
        this.pendingApply = true;
        return;
      }
      this.pendingApply = false;

      const fitted = await fit(merged);
      // Push our own edits, or a full copy the remote lacks. Once the merge
      // is over the quota only our edits count: two devices holding
      // different old songs would otherwise cut the copy differently and
      // re-upload each other's cut forever. The remote's own hash is the
      // last thing asked for — another full encode, and only the last term
      // needs it.
      const needPush =
        localChanged ||
        this.config.pendingPush ||
        (!fitted.trimmed && mergedHash !== (await contentHash(remote)));

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
        await this.#push(fitted, mergedHash);
      } else {
        await this.#saveConfig({
          lastSyncedAt: Date.now(),
          lastRemoteHash: meta.h,
          lastLocalHash: mergedHash,
          pendingPush: false,
          lastError: null,
          trimmed: fitted.trimmed,
        });
      }
    } catch (err) {
      await this.#saveConfig({ lastError: syncErrorMessage(err) });
      if (isRateLimited(err)) this.#reconcileIn(RATE_LIMIT_RETRY_MS);
    } finally {
      this.#busy--;
      // Local data changed under the stores (same situation as an import).
      if (applied) location.reload();
    }
  }

  /** Writes a fitted backup to the area — or, too soon after the last write,
   * comes back for it later (the next reconcile reaches the same conclusion;
   * `pendingPush` and the hashes are untouched until the write lands).
   * `hash` is the content hash of this device's full data, so a trimmed push
   * doesn't read as "local changed" next time. */
  async #push(fitted: FitResult, hash: string) {
    if (this.#pushTooSoon()) return;
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
