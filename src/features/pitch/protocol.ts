/** Pitch feature's wire-protocol fragment (reference-tuning detection).
 * Unioned into the core protocol by core/messaging/protocol.ts. */

export type PitchEngineEvent =
  /** Auto tuning detection: `detecting` toggles the panel spinner; on
   * completion `hz` is the recording's measured A4, or null when nothing
   * pitched was found. */
  { type: 'tuning'; detecting: boolean; hz: number | null };

export type PitchCommand = { type: 'detectTuning' };
