import type { TrackData } from './types.ts';

/** What makes a per-track record worth keeping. Pure, shared by the storage
 * layer, the track writer and the sync codec (which runs under `node --test`,
 * hence the relative `.ts` import). */

export function hasChart(track: TrackData): boolean {
  return !!track.chordChart && track.chordChart.segments.length > 0;
}

/** The flags alone (`sequenceLoop`, `sequenceCountIn`, `chordsEnabled`) are
 * not content — they mean nothing without snippets or a chart. */
export function hasContent(track: TrackData): boolean {
  return (
    (track.markers?.length ?? 0) > 0 || (track.snippets?.length ?? 0) > 0 || hasChart(track)
  );
}
