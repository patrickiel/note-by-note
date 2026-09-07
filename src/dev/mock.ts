import { chords } from '../features/chords/panel/chords.svelte';
import { snippets } from '../features/snippets/panel/snippets.svelte';
import { markers } from '../features/markers/panel/markers.svelte';
import { session } from '../core/state/session.svelte';
import { BUILTIN_EQ_PRESETS } from '../core/model/defaults';

const GUITAR_EQ = BUILTIN_EQ_PRESETS.find((p) => p.name === 'Guitar')!;

/** Populates the stores with the mockup's demo data (dev preview only —
 * activated with ?mock in the side panel URL). A mid-practice session rather
 * than a fresh one: labelled markers across the whole track, a loop on the
 * solo, a slow→fast snippet chain, and the effects actually doing something.
 * The store screenshots are taken from this state. */
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

  session.params = {
    ...session.params,
    transpose: 2,
    speed: 0.75,
    vocalReduce: 0.65,
    eq: { enabled: true, gains: [...GUITAR_EQ.gains] },
    baseBpm: 92,
  };

  markers.load([
    { id: 'm1', t: 8.2, label: 'Intro' },
    { id: 'm2', t: 27.4, label: 'Verse 1' },
    { id: 'm3', t: 52.8, label: 'Chorus' },
    { id: 'm4', t: 78.1, label: 'Verse 2' },
    { id: 'm5', t: 103.6, label: 'Chorus' },
    { id: 'm6', t: 128.47, label: 'Solo' },
    { id: 'm7', t: 142.12, label: 'Solo (fast)' },
    { id: 'm8', t: 178.3, label: 'Outro' },
  ]);

  // No engine is attached in preview, so this takes the optimistic path.
  session.setLoopRange(128.47, 178.3);

  snippets.load(
    [
      {
        id: 'c1',
        name: 'Solo — half speed',
        startT: 128.47,
        endT: 142.12,
        enabled: true,
        repeats: 4,
        overrides: { speed: 0.5 },
      },
      {
        id: 'c2',
        name: 'Solo — 75%',
        startT: 128.47,
        endT: 142.12,
        enabled: true,
        repeats: 3,
        overrides: { speed: 0.75 },
      },
      {
        id: 'c3',
        name: 'Solo — full speed',
        startT: 128.47,
        endT: 155.75,
        enabled: true,
        repeats: 2,
        overrides: {},
      },
    ],
    true,
  );

  // One chord per bar at 92 bpm (~2.6 s), so the strip's fixed 48 px/s scale
  // shows a handful of tiles rather than one giant block.
  const BAR = (4 * 60) / 92;
  const PROGRESSION = ['Em', 'C', 'G', 'D', 'Em', 'C', 'Bm', 'D'];
  const CHORDS_FROM = 96;
  const bars = Math.round((176 - CHORDS_FROM) / BAR);
  const segments = Array.from({ length: bars }, (_, i) => ({
    startT: CHORDS_FROM + i * BAR,
    endT: CHORDS_FROM + (i + 1) * BAR,
    label: PROGRESSION[i % PROGRESSION.length],
    confidence: 0.78 + ((i * 7) % 15) / 100,
  }));

  chords.load({
    segments,
    key: { tonic: 'E', mode: 'minor', confidence: 0.71 },
    coverage: (segments.length * BAR) / 230,
    analyzedFrom: CHORDS_FROM,
    analyzedTo: CHORDS_FROM + segments.length * BAR,
    computedAt: Date.now(),
  });
}

/** Opt-in playhead motion for previewing anything time-driven (timeline
 * auto-follow, the chord strip) without an engine. Kept out of
 * `installMockState` on purpose: the E2E export and the store screenshot tools
 * render that state and have to stay deterministic. */
export function installMockTicker() {
  const STEP_MS = 33;
  session.playing = true;
  setInterval(() => {
    const loop = session.loop.mode;
    const from = loop?.kind === 'range' ? loop.startT : 0;
    const to = loop?.kind === 'range' ? loop.endT : session.duration;
    const next = session.t + (STEP_MS / 1000) * session.params.speed;
    session.t = next >= to ? from : next;
  }, STEP_MS);
}
