/** Speed feature — its slice of the engine⇄panel wire protocol (auto BPM
 * detection). Unioned into the core protocol by core/messaging/protocol.ts. */

export type SpeedEngineEvent =
  /** Auto BPM detection: `detecting` toggles the panel spinner; on completion
   * `bpm` is the detected base (1×) tempo, or null when nothing was found. */
  { type: 'bpm'; detecting: boolean; bpm: number | null };

export type SpeedCommand = { type: 'detectBpm' };
