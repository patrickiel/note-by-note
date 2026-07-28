/** Shared UI signal: true while a fine-tunable timeline drag is in progress —
 * either a marker pin or the playhead scrub. Drives the "Hold Shift to
 * fine-tune" hint on the Looper title row. Kept out of the markers store
 * because the playhead scrub isn't a marker concern. */
class TimelineDragState {
  active = $state(false);
  /** Interaction hint for the pin the pointer is over (null when none), shown
   * on the Looper title row while not actively dragging. */
  hoverHint = $state<string | null>(null);
}

export const timelineDrag = new TimelineDragState();
