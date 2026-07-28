import { chords } from '../features/chords/panel/chords.svelte';
import { snippets } from '../features/snippets/panel/snippets.svelte';
import { markers } from '../features/markers/panel/markers.svelte';
import { session } from '../core/state/session.svelte';

/** Populates the stores with the mockup's demo data (dev preview only —
 * activated with ?mock in the side panel URL). */
export function installMockState() {
  session.connection = 'connected-direct';
  session.media = {
    title: 'Megadeth - Symphony of Destruction - Guitar Tab | Lesson',
    pageUrl: 'https://youtube.com/watch?v=741FSo7Xb40',
    duration: 230,
    hasVideo: true,
  };
  session.t = 141;
  session.playing = false;

  markers.load([
    { id: 'm1', t: 128.47, label: '' },
    { id: 'm2', t: 138.83, label: '' },
    { id: 'm3', t: 138.92, label: '' },
    { id: 'm4', t: 142.12, label: '' },
    { id: 'm5', t: 145.59, label: '' },
    { id: 'm6', t: 150.4, label: '' },
    { id: 'm7', t: 152.55, label: '' },
    { id: 'm8', t: 155.75, label: '' },
  ]);

  snippets.load(
    [
      {
        id: 'c1',
        name: 'Snippet',
        startT: 138.8,
        endT: 142.1,
        enabled: true,
        repeats: 1,
        overrides: { speed: 0.5 },
      },
    ],
    false,
  );

  chords.load({
    segments: [
      { startT: 120, endT: 128, label: 'Em', confidence: 0.9 },
      { startT: 128, endT: 136, label: 'C', confidence: 0.85 },
      { startT: 136, endT: 144, label: 'G', confidence: 0.88 },
      { startT: 144, endT: 152, label: 'D', confidence: 0.82 },
      { startT: 152, endT: 160, label: 'Em', confidence: 0.9 },
    ],
    key: { tonic: 'E', mode: 'minor', confidence: 0.71 },
    coverage: 40 / 230,
    analyzedFrom: 120,
    analyzedTo: 160,
    computedAt: Date.now(),
  });
}
