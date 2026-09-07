import type { TrackIdentity } from '../../../core/model/types';
import { songEntry } from '../../../core/persist/library';
import { library } from './library.svelte';

/** Saved settings belong to the song even when it is absent from Recent/Favorites. */
export function findSavedEntry(identity: TrackIdentity) {
  const song = library.current.shared.songs[identity.key];
  return song?.practice.value?.params ? songEntry(identity.key, library.current) : null;
}
