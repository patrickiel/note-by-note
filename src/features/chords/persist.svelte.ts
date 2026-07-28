import type { TrackDataDescriptor } from '../../core/persist/track-data';
import { chords } from './panel/chords.svelte';

/** Chords' slice of the per-track record: the analyzed chart and the panel
 * switch (separate, so switching off keeps the analysis). */
export const chordsTrackData: TrackDataDescriptor = {
  bind(persist) {
    chords.onPersist = persist;
  },
  collect(data) {
    data.chordChart = $state.snapshot(chords.chart);
    data.chordsEnabled = chords.enabled;
  },
  load(data) {
    chords.load(data?.chordChart ?? null, data?.chordsEnabled);
  },
};
