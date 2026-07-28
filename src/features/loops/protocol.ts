/** Loops feature — its slice of the engine⇄panel wire protocol. Unioned into
 * the core protocol by core/messaging/protocol.ts. (The snapshot event carries
 * the current LoopState inline — see the note in core/messaging/protocol.ts.) */
import type { LoopState } from '../../core/model/types';

export type LoopEngineEvent = { type: 'loop'; loop: LoopState };

export type LoopCommand =
  | { type: 'loop.set'; startT: number; endT: number }
  | { type: 'loop.song'; on: boolean }
  | { type: 'loop.toggle'; on: boolean }
  | { type: 'loop.countIn'; on: boolean }
  | { type: 'loop.clear' };
