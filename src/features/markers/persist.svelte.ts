import type { TrackDataDescriptor } from '../../core/persist/track-data';
import { markers } from './panel/markers.svelte';

/** Markers' slice of the per-track record. */
export const markersTrackData: TrackDataDescriptor = {
  bind(persist) {
    markers.onPersist = persist;
  },
  collect(data) {
    data.markers = $state.snapshot(markers.list);
  },
  load(data) {
    markers.load(data?.markers ?? []);
  },
};
