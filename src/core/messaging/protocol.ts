import type {
  ConnectionState,
  EffectParams,
  LoopState,
  MediaInfo,
  SequenceState,
} from '../model/types';
import type { ChordCommand, ChordEngineEvent } from '../../features/chords/protocol';
import type { CountInEngineEvent } from '../../features/count-in/protocol';
import type { LoopCommand, LoopEngineEvent } from '../../features/loops/protocol';
import type { SnippetCommand, SnippetEngineEvent } from '../../features/snippets/protocol';
import type { SpeedCommand, SpeedEngineEvent } from '../../features/speed/protocol';

// The wire protocol is composed from per-feature fragments (features/<f>/protocol.ts)
// unioned here — the one place both ends agree on. This is a deliberate
// composition-root inversion: core imports the feature fragments; features never
// import this shell.

/** Port name for sidepanel ⇄ engine connections (content script, local player). */
export const UI_PORT = 'note-by-note-ui';
/** Port name for sidepanel/background ⇄ offscreen document. */
export const OFFSCREEN_PORT = 'note-by-note-offscreen';

export type EngineErrorCode =
  | 'worklet-failed'
  | 'cors-silence'
  | 'autoplay-blocked'
  | 'capture-failed';

/** Core engine → side panel events: transport/session/error plus the snapshot.
 * The snapshot keeps its per-feature fields (loop, seq, chordActive) inline
 * rather than delegating to the feature fragments — a documented pragmatic
 * exception, since it is one atomic "current state" message. */
type CoreEngineEvent =
  | {
      type: 'snapshot';
      state: ConnectionState;
      media: MediaInfo | null;
      params: EffectParams;
      volume: number;
      loop: LoopState;
      seq: SequenceState;
      t: number;
      playing: boolean;
      /** Whether engine-side chord detection is currently enabled. */
      chordActive: boolean;
      /** See the 'dsp' event. */
      dspAvailable: boolean;
    }
  | { type: 'state'; state: ConnectionState }
  /** Whether the DSP chain reached the audio. False once the pipeline is
   * confirmed unable to attach (page CSP blocks the worklet, CORS/DRM taint):
   * pitch, the vocal reducer and the EQ are inert until the user switches to
   * tab capture. Separate from `state` because 'pitch-unavailable' only shows
   * while the media plays, while a dead chain outlives any pause. */
  | { type: 'dsp'; available: boolean }
  /** The element's source is being swapped (SPA navigation): the panel's
   * track-scoped state (markers, snippets, duration) is stale until the next
   * 'media' event — seeks must not be issued from it. */
  | { type: 'source-changing' }
  | { type: 'media'; media: MediaInfo | null }
  | { type: 'time'; t: number; playing: boolean }
  | { type: 'params'; params: EffectParams }
  | { type: 'volume'; volume: number }
  | { type: 'error'; code: EngineErrorCode; detail?: string };

/** Engine → side panel. */
export type EngineEvent =
  | CoreEngineEvent
  | LoopEngineEvent
  | CountInEngineEvent
  | SnippetEngineEvent
  | SpeedEngineEvent
  | ChordEngineEvent;

/** Core side panel → engine commands: transport/params/volume/settings. */
type CoreEngineCommand =
  | { type: 'hello' }
  | {
      type: 'transport';
      op: 'play' | 'pause' | 'toggle' | 'jumpStart' | 'skip';
      /** Seconds for `skip` (negative = rewind). */
      value?: number;
    }
  | { type: 'seek'; t: number }
  /** Seek to `t` and start playback with a count-in (the "play from marker"
   * gesture). Unlike seek+play it counts in even when playback is already
   * running, so it can't degrade to a bare seek. */
  | { type: 'playFrom'; t: number }
  | { type: 'scrub'; t: number; previewMs: number }
  | { type: 'params'; patch: Partial<EffectParams> }
  | { type: 'volume'; volume: number }
  | {
      type: 'settings';
      seekInterval: number;
      lowLatency: boolean;
      formantPreserved: boolean;
      countInBeats: number;
      countInBpm: number;
      countInBeep: boolean;
    };

/** Side panel → engine. */
export type EngineCommand =
  | CoreEngineCommand
  | LoopCommand
  | SnippetCommand
  | SpeedCommand
  | ChordCommand;

/** Background → offscreen document (runtime messages, offscreen filters by target). */
export type OffscreenCommand =
  | { target: 'offscreen'; type: 'capture.start'; tabId: number; streamId: string }
  | { target: 'offscreen'; type: 'capture.stop'; tabId: number }
  | { target: 'offscreen'; type: 'capture.query'; tabId: number }
  | { target: 'offscreen'; type: 'params'; tabId: number; patch: Partial<EffectParams> }
  | { target: 'offscreen'; type: 'volume'; tabId: number; volume: number };

/** RPC handled by the background service worker (via @webext-core/messaging). */
export interface ProtocolMap {
  /** Request per-origin host permission, inject + persist the content script.
   * Must run after the side panel already obtained the permission grant. */
  ensureInjected(data: { tabId: number }): Promise<{ ok: boolean; error?: string }>;
  /** Broker tab capture: get a stream id and start the offscreen pipeline. */
  startCapture(data: { tabId: number }): Promise<{ ok: boolean; error?: string }>;
  stopCapture(data: { tabId: number }): Promise<void>;
  /** True while the offscreen document has an active capture for the tab. */
  isCapturing(data: { tabId: number }): Promise<boolean>;
  /** Effect params / volume for a captured tab (routed to the offscreen doc). */
  captureParams(data: { tabId: number; patch: Partial<EffectParams> }): Promise<void>;
  captureVolume(data: { tabId: number; volume: number }): Promise<void>;
  /** Revoke Permissions. */
  revokeAllPermissions(): Promise<void>;
}
