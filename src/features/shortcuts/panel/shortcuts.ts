import {
  DEFAULT_KEYMAP,
  TRANSPOSE_RANGE_EXTENDED,
  TRANSPOSE_RANGE_STANDARD,
} from '../../../core/model/defaults';
import type { ActionId } from '../../../core/model/types';
import { snippets } from '../../snippets/panel/snippets.svelte';
import { markers } from '../../markers/panel/markers.svelte';
import { session } from '../../../core/state/session.svelte';
import { settings, uiPrefs } from '../../settings/panel/settings.svelte';
import { view } from '../../../core/state/view.svelte';
import { timelineView } from '../../../ui/timeline/timeline-view.svelte';

/** Builds the combo string a keydown event represents ("Shift+ArrowLeft"). */
export function comboFromEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  const key =
    event.key === ' '
      ? 'Space'
      : event.key.length === 1
        ? event.key.toLowerCase()
        : event.key;
  parts.push(key);
  return parts.join('+');
}

/** One-semitone keyboard nudge, clamped to the active transpose range so the
 * arrow keys stay in step with the slider's ±12 / ±36 bounds. */
function nudgeTranspose(direction: -1 | 1): number {
  const limit = settings.current.extendedTranspose
    ? TRANSPOSE_RANGE_EXTENDED
    : TRANSPOSE_RANGE_STANDARD;
  return Math.max(-limit, Math.min(limit, session.params.transpose + direction));
}

/** The span a range action works on: the panel's marker selection, else a range
 * loop restored from the engine. */
function activeRange(): { startT: number; endT: number } | null {
  return (
    markers.range ??
    (session.loop.mode?.kind === 'range'
      ? { startT: session.loop.mode.startT, endT: session.loop.mode.endT }
      : null)
  );
}

function runAction(action: ActionId) {
  const seek = settings.current.seekInterval;
  switch (action) {
    case 'playPause':
      session.togglePlay();
      break;
    case 'seekBack':
      session.skip(-seek);
      break;
    case 'seekFwd':
      session.skip(seek);
      break;
    case 'prevMarker': {
      const m = markers.prevMarker();
      if (m) session.seek(m.t);
      break;
    }
    case 'nextMarker': {
      const m = markers.nextMarker();
      if (m) session.seek(m.t);
      break;
    }
    case 'jumpStart':
      session.jumpStart();
      break;
    // The pitch nudges mirror controls that grey out when the DSP chain never
    // attached; firing them there would move a disabled slider for no audio.
    case 'transposeUp':
      if (session.dspAvailable) session.patchParams({ transpose: nudgeTranspose(1) });
      break;
    case 'transposeDown':
      if (session.dspAvailable) session.patchParams({ transpose: nudgeTranspose(-1) });
      break;
    case 'pitchUp':
      if (session.dspAvailable) {
        session.patchParams({ pitchCents: session.params.pitchCents + 1 });
      }
      break;
    case 'pitchDown':
      if (session.dspAvailable) {
        session.patchParams({ pitchCents: session.params.pitchCents - 1 });
      }
      break;
    case 'speedUp':
      session.patchParams({ speed: session.params.speed + 0.05 });
      break;
    case 'speedDown':
      session.patchParams({ speed: session.params.speed - 0.05 });
      break;
    case 'addMarker':
      markers.add();
      break;
    case 'toggleLoop':
      session.toggleLoop(!session.loop.active);
      break;
    case 'rangeSelect':
      markers.selectCurrentSection();
      break;
    case 'addSnippet': {
      const range = activeRange();
      if (range) snippets.addFromRange(range.startT, range.endT);
      break;
    }
    case 'zoomIn':
      timelineView.zoomStep(1);
      break;
    case 'zoomOut':
      timelineView.zoomStep(-1);
      break;
    case 'zoomFit': {
      // One key for "get me oriented": lost in a zoomed view → back to the whole
      // track; already looking at the whole track → frame what's being practised.
      if (!timelineView.atFit) {
        timelineView.zoomToFit();
        break;
      }
      const range = activeRange();
      if (range) timelineView.zoomToRange(range.startT, range.endT);
      break;
    }
    case 'toggleFollow':
      uiPrefs.setTimelineFollow(!uiPrefs.current.timelineFollow);
      break;
    case 'power':
      session.togglePower();
      break;
  }
}

/** Global keydown handler for the side panel. Returns an unsubscriber. */
export function installShortcuts(): () => void {
  const handler = (event: KeyboardEvent) => {
    if (!settings.current.shortcutsEnabled) return;
    if (view.current !== 'workspace') return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
    if (target?.isContentEditable) return;

    const keymap = settings.current.customShortcuts
      ? settings.current.keymap
      : DEFAULT_KEYMAP;
    const combo = comboFromEvent(event);
    const action = (Object.keys(keymap) as ActionId[]).find(
      (a) => keymap[a] === combo,
    );
    if (!action) return;
    event.preventDefault();
    runAction(action);
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
