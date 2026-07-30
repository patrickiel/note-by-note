import { DEFAULT_PARAMS } from '../model/defaults';
import { makeTrackIdentity } from '../model/track-identity';
import type { EffectParams, HistoryEntry, MediaInfo, TrackData, TrackIdentity } from '../model/types';
import { touchFavorite } from '../../features/library/persist/favorites';
import { removeHistoryEntry, upsertHistory } from '../../features/library/persist/history';
import { loadTrackData, saveTrackData } from '../persist/storage';
import { trackDataDescriptors } from '../persist/track-data';
import { session } from './session.svelte';
import { settings } from '../../features/settings/panel/settings.svelte';

/** Reacts to track changes — auto-saves the previous track to
 * Recent, then resets / remembers / carries over params, and swaps the
 * per-track markers & snippets in and out of storage. */
class TrackSync {
  #identity: TrackIdentity | null = null;
  #pageUrl = '';
  #thumbnailUrl: string | undefined;
  /** Params staged by a History click, applied when that track loads. */
  #pendingRestore: { key: string; params: EffectParams } | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** True once the user touched a control on this track — gates the Recent save. */
  #userAdjusted = false;
  #zeroDurationTimer: ReturnType<typeof setTimeout> | undefined;

  init() {
    for (const d of trackDataDescriptors) {
      d.bind(() => {
        // Marker/snippet/chord edits count as adjusting a control.
        this.#userAdjusted = true;
        this.#persistTrackData();
        void this.#saveCurrent();
      });
    }
  }

  /** Called for every media info event from the engine. */
  async onMedia(media: MediaInfo | null) {
    clearTimeout(this.#zeroDurationTimer);
    if (!media) return;
    if (!media.duration) {
      // Duration 0 usually means metadata is still loading — but streams and
      // unseekable sources never report one. Give durationchange a moment to
      // supersede before keying the track without a duration.
      this.#zeroDurationTimer = setTimeout(() => {
        void this.#apply(media);
      }, 3000);
      return;
    }
    await this.#apply(media);
  }

  async #apply(media: MediaInfo) {
    const identity = makeTrackIdentity(media.pageUrl, media.title, media.duration);
    if (identity.key === this.#identity?.key) {
      // Same track — but the title may have settled late (SPA navigation).
      if (identity.title !== this.#identity.title) {
        this.#identity = identity;
        if (this.#userAdjusted) await this.#saveCurrent();
      }
      return;
    }

    // Same page, new duration — the metadata settled late (ad, slow load) and
    // the track got keyed with a stale duration. Re-key in place instead of
    // treating it as a track switch, so Recents doesn't get a duplicate row.
    if (this.#identity && identity.normalizedUrl === this.#identity.normalizedUrl) {
      const staleKey = this.#identity.key;
      this.#identity = identity;
      this.#pageUrl = media.pageUrl;
      this.#thumbnailUrl = media.thumbnailUrl ?? this.#thumbnailUrl;
      if (this.#userAdjusted) {
        await removeHistoryEntry(staleKey);
        await this.#saveCurrent();
        this.#persistTrackData();
      }
      return;
    }

    // Leaving the previous track: auto-save it with its final settings.
    await this.#saveCurrent();

    this.#identity = identity;
    this.#pageUrl = media.pageUrl;
    this.#thumbnailUrl = media.thumbnailUrl;

    // Restore this track's per-feature data (markers, snippets, chords) if
    // we've seen it before — each feature scatters its own slice.
    const data = await loadTrackData(identity.key);
    for (const d of trackDataDescriptors) d.load(data);

    // Starting params: history restore > auto reset > remember > carry over.
    const restore = this.#pendingRestore;
    this.#pendingRestore = null;
    if (restore?.key === identity.key) {
      session.patchParams(restore.params);
    } else if (settings.current.autoReset) {
      session.patchParams(structuredClone(DEFAULT_PARAMS));
    } else if (settings.current.rememberSettings && settings.current.lastUsedParams) {
      session.patchParams(structuredClone(settings.current.lastUsedParams));
    }
    // The patches above fire onParamsChanged synchronously — reset after them
    // so only real user edits count toward the Recent save.
    this.#userAdjusted = false;

    // If the track is favorited, bump its Last Accessed timestamp.
    await touchFavorite(identity.key, {
      pageUrl: media.pageUrl,
      thumbnailUrl: media.thumbnailUrl,
    });
  }

  /** Called on (debounced) param changes to keep history and
   * "Remember settings" fresh without waiting for a track switch. */
  onParamsChanged() {
    this.#userAdjusted = true;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      void this.#saveCurrent();
      if (settings.current.rememberSettings) {
        void settings.update({
          lastUsedParams: $state.snapshot(session.params) as EffectParams,
        });
      }
    }, 1500);
  }

  async #saveCurrent() {
    if (!this.#identity) return;
    const params = $state.snapshot(session.params) as EffectParams;
    // Favorites mirror the latest settings so they recall them on open.
    await touchFavorite(this.#identity.key, { params });
    if (!settings.current.autoSave || !this.#userAdjusted) return;
    await upsertHistory(this.#identity, params, this.#pageUrl, this.#thumbnailUrl);
  }

  #persistTrackData() {
    if (!this.#identity) return;
    // Build the single record; each feature descriptor fills in its own fields.
    const data: TrackData = {
      identity: this.#identity,
      markers: [],
      snippets: [],
      sequenceLoop: false,
      sequenceCountIn: false,
      chordChart: null,
      chordsEnabled: false,
      updatedAt: Date.now(),
    };
    for (const d of trackDataDescriptors) d.collect(data);
    void saveTrackData(data);
  }

  /** History → Recent entry clicked: navigate there and stage its settings. */
  async openHistoryEntry(tabId: number | null, entry: HistoryEntry) {
    this.#pendingRestore = { key: entry.identity.key, params: entry.params };
    if (tabId != null) {
      await browser.tabs.update(tabId, { url: entry.pageUrl });
    } else {
      await browser.tabs.create({ url: entry.pageUrl });
    }
  }
}

export const trackSync = new TrackSync();
