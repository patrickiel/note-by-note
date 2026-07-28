/** Snippets feature — its slice of the engine⇄panel wire protocol (practice
 * sequence). Unioned into the core protocol by core/messaging/protocol.ts.
 * (The snapshot event carries the current SequenceState inline.) */
import type { SequenceState, SnippetRuntime } from '../../core/model/types';

export type SnippetEngineEvent = { type: 'seq'; seq: SequenceState };

export type SnippetCommand =
  | { type: 'seq.start'; snippets: SnippetRuntime[]; fromSnippetId?: string; loopAll: boolean }
  | { type: 'seq.update'; snippets: SnippetRuntime[]; loopAll: boolean }
  | { type: 'seq.stop' };
