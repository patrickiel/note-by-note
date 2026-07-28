import type { EngineEvent } from './messaging/protocol';
import { chordsFeature } from '../features/chords/panel/panel';
import { eqFeature } from '../features/eq/panel/panel';
import { libraryFeature } from '../features/library/panel/panel';
import { settingsFeature } from '../features/settings/panel/panel';

/** The snapshot variant of EngineEvent (the engine's full "current state"). */
export type SnapshotEvent = Extract<EngineEvent, { type: 'snapshot' }>;

/** A side-panel feature's registration surface. The composition roots — App
 * (boot init) and the connection manager (port event routing) — iterate these
 * instead of hard-coding each feature. This is the "light registration" seam:
 * core imports the feature contributions; features never import the roots.
 * A feature only implements the hooks it needs. */
export interface PanelFeature {
  /** Async storage load at panel boot. Run concurrently across features. */
  init?(): Promise<void> | void;
  /** Route an engine→panel event into feature-owned state that lives outside
   * the session mirror (e.g. chords' PCM stream). */
  routeEvent?(event: EngineEvent): void;
  /** React to a fresh engine snapshot (the full current-state message). */
  onSnapshot?(snapshot: SnapshotEvent): void;
  /** The engine port disconnected (navigation/reload/teardown). */
  onDisconnect?(): void;
}

/** Every panel feature that contributes boot init or engine-event routing.
 * (Features whose only per-track state is swapped by track-sync — markers,
 * snippets — register there instead, via core/persist/track-data.ts.) */
export const features: PanelFeature[] = [
  settingsFeature,
  libraryFeature,
  eqFeature,
  chordsFeature,
];
