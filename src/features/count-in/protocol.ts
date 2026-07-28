/** Count-in feature — its slice of the engine→panel wire protocol (the live
 * countdown overlay). Unioned into the core protocol by
 * core/messaging/protocol.ts. */
import type { CountInProgress } from '../../core/model/types';

export type CountInEngineEvent = { type: 'countdown'; countdown: CountInProgress | null };
