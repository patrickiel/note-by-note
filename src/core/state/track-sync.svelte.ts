import { DEFAULT_PARAMS } from '../model/defaults';
import { makeTrackIdentity } from '../model/track-identity';
import type { EffectParams, HistoryEntry, MediaInfo, TrackData, TrackIdentity } from '../model/types';
import { touchFavorite } from '../../features/library/persist/favorites';
import { removeHistoryEntry, upsertHistory } from '../../features/library/persist/history';
import { findSavedEntry } from '../../features/library/panel/saved-settings';
import { loadTrackData, saveTrackData } from '../persist/storage';
import { openTabWithPanel } from '../side-panel';
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
  /** The song whose saved settings are currently applied, as `url\ntitle`. Set
   * only on a successful restore, so a lookup that missed — the title had not
   * settled yet — is retried on the next media event. Deliberately excludes the
   * duration: drifting duration is what it has to survive. */
  #restoredFor: string | null = null;
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

  /** The engine link dropped — reload, reopened tab, tab switch. Whatever
   * reconnects starts on the default preset, so this song has to be restored
   * again; flush any live edits first so the restore reads them back. */
  onEngineLost() {
    // #saveCurrent reads #userAdjusted and #params before its first await, so
    // clearing the flag on the next line can't race it.
    void this.#saveCurrent();
    this.#userAdjusted = false;
    this.#restoredFor = null;
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

  /** Puts a song's saved settings back on, however it was opened — a clicked
   * row, a typed URL, a link, an SPA navigation, a reload. Recent and Favorites
   * hand a song back the way it was left; the "new song" preference governs only
   * songs with nothing saved. */
  #restoreSaved(identity: TrackIdentity): boolean {
    const token = `${identity.normalizedUrl}\n${identity.title}`;
    if (this.#restoredFor === token) return false;
    const entry = findSavedEntry(identity);
    if (!entry) return false;
    this.#restoredFor = token;
    // $state.snapshot, not structuredClone: the entry belongs to a $state store,
    // so its params are a proxy (structuredClone throws DataCloneError on one)
    // and patchParams would otherwise assign its EQ band array by reference.
    this.#applyParams($state.snapshot(entry.params) as EffectParams);
    return true;
  }

  /** Sets params on the track's behalf rather than the user's. patchParams fires
   * onParamsChanged synchronously, so without this every restore and every auto
   * reset would count as an edit and re-save the entry it just read. */
  #applyParams(params: EffectParams) {
    session.patchParams(params);
    this.#userAdjusted = false;
    clearTimeout(this.#saveTimer);
  }

  async #apply(media: MediaInfo) {
    const identity = makeTrackIdentity(media.pageUrl, media.title, media.duration);
    if (identity.key === this.#applyingKey) return;

    if (identity.key === this.#identity?.key) {
      // Same track — but the title may have settled late (SPA navigation).
      if (identity.title !== this.#identity.title) {
        this.#identity = identity;
        if (this.#userAdjusted) await this.#saveCurrent();
      }
      // A no-op unless something changed what this song is or what is applied to
      // it: the title just settled, or the engine restarted on the defaults.
      if (!this.#userAdjusted) this.#restoreSaved(identity);
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
      // Their edits outrank anything stored; otherwise a lookup that missed on
      // the stale identity gets another go now the duration has settled.
      if (!adjusted) this.#restoreSaved(identity);
      if (adjusted) {
        // Housekeeping, not a user deletion: the song stays, only its
        // stale-keyed twin goes — so no deletion record (which is per song
        // and would kill the fresh row on the other devices).
        await removeHistoryEntry(staleKey, { record: false });
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

      // A different song, so nothing is applied for it yet — even if we happen
      // to be coming back to one restored earlier. Reset after both awaits, so
      // this branch is the last writer and an event that slipped through during
      // them can't restore only to be auto-reset over.
      this.#restoredFor = null;
      this.#userAdjusted = false;
      // Starting params: the song's own saved settings > auto reset > remember
      // > carry over. The last three are for songs with nothing saved.
      if (!this.#restoreSaved(identity)) {
        if (settings.current.autoReset) {
          this.#applyParams(structuredClone(DEFAULT_PARAMS));
        } else if (settings.current.rememberSettings && settings.current.lastUsedParams) {
          // $state.snapshot, not structuredClone: settings.current is a rune, so
          // lastUsedParams is a proxy and structuredClone throws on it.
          this.#applyParams($state.snapshot(settings.current.lastUsedParams) as EffectParams);
        }
      }
      this.#params = $state.snapshot(session.params) as EffectParams;

      // If the track is favorited, bump its Last Accessed timestamp.
      await touchFavorite(identity, {
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
    // Both copies, from one value, in one call: a song that is favorited *and*
    // in Recent must never end up with the two disagreeing. Auto Save off stops
    // new rows being added, not an existing one being kept current.
    await touchFavorite(this.#identity, { params });
    await upsertHistory(
      this.#identity,
      params,
      this.#pageUrl,
      this.#thumbnailUrl,
      !settings.current.autoSave,
    );
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

  /** A row in the Songs list was clicked: go there. Its settings need no staging
   * — arriving at a song is what puts them back on, whoever asked for it. */
  async openHistoryEntry(tabId: number | null, entry: HistoryEntry) {
    const target = makeTrackIdentity(entry.pageUrl, '', 0).normalizedUrl;
    const playing = session.media?.pageUrl;
    // Already on that page: apply in place. Re-navigating to the URL it is
    // already on would reload for nothing (losing the playhead), and may not
    // fire a media event at all.
    if (playing && makeTrackIdentity(playing, '', 0).normalizedUrl === target) {
      // Snapshot: `entry` belongs to a $state store, so patchParams would
      // otherwise assign its EQ band array straight off the entry.
      this.#applyParams($state.snapshot(entry.params) as EffectParams);
      return;
    }

    if (tabId != null) {
      await browser.tabs.update(tabId, { url: entry.pageUrl });
    } else {
      // No engine tab to reuse — a fresh one the panel follows (a plain create
      // would activate a tab the panel isn't enabled on and hide it).
      await openTabWithPanel(entry.pageUrl);
    }
  }
}

export const trackSync = new TrackSync();
