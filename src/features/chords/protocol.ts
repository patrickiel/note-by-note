/** Chords feature — its slice of the engine⇄panel wire protocol. Unioned into
 * the core EngineEvent/EngineCommand by core/messaging/protocol.ts. */

export type ChordEngineEvent =
  /** Raw mono PCM batch (at `sampleRate`) for panel-side chord detection, while
   * a chord recording session is active. `t` is the media time of the batch's
   * end; `speed` is the `el.playbackRate` it was captured at (the tap sits
   * downstream of it), so the panel can map samples back to media time.
   * `samples` stays `number[]`: chrome.runtime ports JSON-serialize, so a typed
   * array would arrive mangled. */
  { type: 'pcm'; samples: number[]; sampleRate: number; t: number; speed: number };

export type ChordCommand =
  /** Start/stop streaming `pcm` events for a chord recording session. The
   * panel sends `on: false` on reconnect when it isn't recording, since a
   * session can't survive a panel reload. */
  { type: 'chordDetect'; on: boolean };
