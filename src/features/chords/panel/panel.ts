import type { EngineEvent } from '../../../core/messaging/protocol';
import type { PanelFeature, SnapshotEvent } from '../../../core/features';
import { chords } from './chords.svelte';

/** Chord/key detection lives in its own track-scoped store (like markers), so
 * its engine traffic is routed here rather than through the session mirror. */
export const chordsFeature: PanelFeature = {
  routeEvent(event: EngineEvent) {
    if (event.type === 'pcm') chords.pushPcm(event.samples, event.sampleRate, event.t, event.speed);
  },
  onSnapshot(snapshot: SnapshotEvent) {
    chords.syncActive(snapshot.chordActive);
  },
  onDisconnect() {
    chords.onDisconnect();
  },
};
