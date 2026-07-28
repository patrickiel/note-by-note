import type { TrackData } from '../model/types';
import { chordsTrackData } from '../../features/chords/persist.svelte';
import { markersTrackData } from '../../features/markers/persist.svelte';
import { snippetsTrackData } from '../../features/snippets/persist.svelte';

/** A feature's slice of the single per-track record (TrackData). track-sync
 * binds, loads, and collects each descriptor without knowing the feature's
 * internals — the persistence half of the "light registration" seam. TrackData
 * stays typed in core (the descriptor keys are its fields). */
export interface TrackDataDescriptor {
  /** Wire the feature store's change hook to re-persist the whole record. */
  bind(persist: () => void): void;
  /** Populate this feature's fields on a fresh record being saved. */
  collect(data: TrackData): void;
  /** Restore this feature's state from a loaded record (null = never saved). */
  load(data: TrackData | null): void;
}

export const trackDataDescriptors: TrackDataDescriptor[] = [
  markersTrackData,
  snippetsTrackData,
  chordsTrackData,
];
