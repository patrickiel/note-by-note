import type { TrackDataDescriptor } from '../../core/persist/track-data';
import { snippets } from './panel/snippets.svelte';

/** Snippets' slice of the per-track record (the snippet list plus the two
 * sequence flags). */
export const snippetsTrackData: TrackDataDescriptor = {
  bind(persist) {
    snippets.onPersist = persist;
  },
  collect(data) {
    data.snippets = $state.snapshot(snippets.list);
    data.sequenceLoop = snippets.sequenceLoop;
    data.sequenceCountIn = snippets.sequenceCountIn;
  },
  load(data) {
    snippets.load(
      data?.snippets ?? [],
      data?.sequenceLoop ?? false,
      data?.sequenceCountIn ?? false,
    );
  },
};
