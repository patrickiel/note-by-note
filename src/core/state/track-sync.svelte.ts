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
  /** Params staged by a History click, matched on the page rather than the
   * identity key: the duration is part of the key and is still settling while
   * the target loads (ads, late metadata), so the key can't match yet. */
  #pendingRestore: { normalizedUrl: string; params: EffectParams } | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** The params last set for #identity. `session.params` is overwritten by the
   * incoming engine's snapshot before that snapshot's media event reaches us,
   * so the outgoing track has to be saved from this, not from the mirror. */
  #params: EffectParams | null = null;
  /** True once the user touched a control on this track — gates the Recent save. */
  #userAdjusted = false;
  /** Key of an in-flight #apply. Every connect delivers more than one snapshot
   * and #identity is only assigned after an awaited save, so without this two
   * runs both take the track-switch branch and the loser applies auto-reset
   * over the params the winner just restored. */
  #applyingKey: string | null = null;
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

  /** Applies the params a History click staged, but only once the track keys
   * itself the way that click targeted — an intermediate identity (a pre-roll
   * ad's duration, metadata not loaded yet) must not burn the restore. */
  #takeRestore(normalizedUrl: string): boolean {
    const restore = this.#pendingRestore;
    if (!restore || restore.normalizedUrl !== normalizedUrl) return false;
    this.#pendingRestore = null;
    session.patchParams(restore.params);
    // patchParams fires onParamsChanged synchronously — a restore is not an
    // edit, so it must not re-save the entry it just came from.
    this.#userAdjusted = false;
    clearTimeout(this.#saveTimer);
    return true;
  }

  async #apply(media: MediaInfo) {
    const identity = makeTrackIdentity(media.pageUrl, media.title, media.duration);
    if (identity.key === this.#applyingKey) return;

    if (identity.key === this.#identity?.key) {
      // Clicking the entry for the track already open reloads the page, so the
      // engine comes back on defaults under an unchanged key — restore here too.
      this.#takeRestore(identity.normalizedUrl);
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
      const adjusted = this.#userAdjusted;
      this.#identity = identity;
      this.#pageUrl = media.pageUrl;
      this.#thumbnailUrl = media.thumbnailUrl ?? this.#thumbnailUrl;
      // The key was wrong until now, so the real key's slice was never loaded.
      const data = await loadTrackData(identity.key);
      if (data) for (const d of trackDataDescriptors) d.load(data);
      // The duration finally matches what a click staged — unless the user
      // started adjusting while it settled, in which case their edit wins.
      if (!adjusted && this.#takeRestore(identity.normalizedUrl)) return;
      if (adjusted) {
        await removeHistoryEntry(staleKey);
        await this.#saveCurrent();
        // Only carry the stale key's slice over when the real key has none, so
        // this can't overwrite a saved record with an emptied one.
        if (!data) this.#persistTrackData();
      }
      return;
    }

    this.#applyingKey = identity.key;
    try {
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
      if (!this.#takeRestore(identity.normalizedUrl)) {
        // A click that never landed here can't land later either — a differing
        // normalizedUrl means a genuinely different page.
        this.#pendingRestore = null;
        if (settings.current.autoReset) {
          session.patchParams(structuredClone(DEFAULT_PARAMS));
        } else if (settings.current.rememberSettings && settings.current.lastUsedParams) {
          // $state.snapshot, not structuredClone: settings.current is a rune, so
          // lastUsedParams is a proxy and structuredClone throws on it.
          session.patchParams($state.snapshot(settings.current.lastUsedParams) as EffectParams);
        }
        // The patches above fire onParamsChanged synchronously — reset after
        // them so only real user edits count toward the Recent save.
        this.#userAdjusted = false;
        clearTimeout(this.#saveTimer);
      }
      this.#params = $state.snapshot(session.params) as EffectParams;

      // If the track is favorited, bump its Last Accessed timestamp.
      await touchFavorite(identity.key, {
        pageUrl: media.pageUrl,
        thumbnailUrl: media.thumbnailUrl,
      });
    } finally {
      this.#applyingKey = null;
    }
  }

  /** Called on (debounced) param changes to keep history and
   * "Remember settings" fresh without waiting for a track switch. */
  onParamsChanged() {
    this.#userAdjusted = true;
    this.#params = $state.snapshot(session.params) as EffectParams;
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
    // Nothing was edited on this track — mirroring now would write auto-reset
    // or carried-over state over what the user actually saved.
    if (!this.#userAdjusted) return;
    const params = this.#params ?? ($state.snapshot(session.params) as EffectParams);
    // Favorites mirror the latest settings so they recall them on open.
    await touchFavorite(this.#identity.key, { params });
    if (!settings.current.autoSave) return;
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
    // Duration-independent, unlike identity.key: the target's duration goes on
    // settling long after this (ads, late metadata), so the key can't match yet.
    const normalizedUrl = makeTrackIdentity(entry.pageUrl, '', 0).normalizedUrl;
    // Snapshot now: `entry` belongs to a $state store, so its params are a proxy
    // (structuredClone throws DataCloneError on one) and patchParams would
    // otherwise assign nested values — the EQ bands — straight off the entry.
    const params = $state.snapshot(entry.params) as EffectParams;
    this.#pendingRestore = { normalizedUrl, params };

    // Already playing that page: apply in place. Re-navigating to the URL it is
    // already on would reload for nothing (losing the playhead), and may not
    // fire a media event at all — leaving the restore staged forever.
    const playing = session.media?.pageUrl;
    if (playing && makeTrackIdentity(playing, '', 0).normalizedUrl === normalizedUrl) {
      this.#takeRestore(normalizedUrl);
      return;
    }

    if (tabId != null) {
      await browser.tabs.update(tabId, { url: entry.pageUrl });
    } else {
      await browser.tabs.create({ url: entry.pageUrl });
    }
  }
}

export const trackSync = new TrackSync();
