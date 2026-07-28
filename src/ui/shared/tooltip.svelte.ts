/** Themed tooltips, replacing the browser's native `title` bubble.
 *
 * One controller + one floating layer ([TooltipLayer.svelte]) for the whole
 * panel: elements only register *what* to say, never render the bubble
 * themselves, so a tooltip can escape the `overflow: hidden` panel body and a
 * second one can never be on screen at once. Usage:
 *
 *   <button {@attach tooltip('Jump to start', { action: 'jumpStart' })}>
 *
 * `title` is deliberately not set alongside — the native bubble would shadow
 * this one. Anything that used `title` as its accessible name needs an explicit
 * `aria-label`, because the tooltip itself is `aria-hidden`. */

import type { ActionId } from '@/core/model/types';

/** Side of the anchor the bubble is tried on first. */
export type TooltipPlacement = 'bottom' | 'top';

export interface TooltipOptions {
  /** Shortcut action whose *current* binding is shown as key chips. */
  action?: ActionId;
  /** Literal combo ("Shift+ArrowLeft") for hints that aren't bound actions. */
  keys?: string;
  /** Defaults to 'bottom'; the layer flips it when the bubble won't fit. */
  placement?: TooltipPlacement;
}

/** Hover dwell before the first bubble opens. */
const OPEN_DELAY = 380;
/** Grace period on leave, so a pointer crossing a 1px gap doesn't flicker. */
const CLOSE_DELAY = 60;
/** After one closes, the next opens instantly for this long — scanning a row
 * of icon buttons shouldn't re-pay the dwell at every stop. */
const WARM_WINDOW = 400;

class TooltipController {
  /** Element the visible bubble points at; null when nothing is shown. */
  anchor = $state<HTMLElement | null>(null);
  text = $state('');
  action = $state<ActionId | undefined>(undefined);
  keys = $state<string | undefined>(undefined);
  placement = $state<TooltipPlacement>('bottom');

  #openTimer: ReturnType<typeof setTimeout> | undefined;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;
  #warmUntil = 0;

  /** Ask for `node`'s tooltip. Opens after the dwell, or at once while another
   * bubble is up / one just closed. */
  request(node: HTMLElement, text: string, opts: TooltipOptions) {
    clearTimeout(this.#openTimer);
    clearTimeout(this.#closeTimer);
    const open = () => {
      this.anchor = node;
      this.text = text;
      this.action = opts.action;
      this.keys = opts.keys;
      this.placement = opts.placement ?? 'bottom';
    };
    if (this.anchor || Date.now() < this.#warmUntil) open();
    else this.#openTimer = setTimeout(open, OPEN_DELAY);
  }

  /** Pointer/focus left `node`. Closes after the grace period and opens the
   * warm window so the neighbouring control responds instantly. */
  release(node: HTMLElement) {
    clearTimeout(this.#openTimer);
    if (this.anchor !== node) return;
    clearTimeout(this.#closeTimer);
    this.#closeTimer = setTimeout(() => {
      this.anchor = null;
      this.#warmUntil = Date.now() + WARM_WINDOW;
    }, CLOSE_DELAY);
  }

  /** Close now and go cold — for clicks, Escape, and teardown. The pointer is
   * usually still over the anchor, so staying cold is what keeps the bubble
   * down until the user deliberately hovers again. */
  dismiss() {
    clearTimeout(this.#openTimer);
    clearTimeout(this.#closeTimer);
    this.anchor = null;
    this.#warmUntil = 0;
  }

  /** Drop `node` if it is the current anchor (its component is unmounting). */
  forget(node: HTMLElement) {
    if (this.anchor === node) this.dismiss();
  }
}

export const tooltips = new TooltipController();

function isDisabled(node: HTMLElement): boolean {
  return 'disabled' in node && node.disabled === true;
}

function hits(node: HTMLElement, x: number, y: number): boolean {
  const r = node.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** Attachment factory. Falsy `text` attaches nothing, so callers can write
 * `tooltip(broken ? 'Why this is off' : '')` without a wrapping `{#if}`. */
export function tooltip(
  text: string | null | undefined,
  opts: TooltipOptions = {},
) {
  return (node: HTMLElement) => {
    if (!text) return;

    const show = () => tooltips.request(node, text, opts);
    const hide = () => tooltips.release(node);
    const dismiss = () => tooltips.dismiss();

    const onpointerenter = (event: PointerEvent) => {
      // Touch has no hover state; a bubble there would just cover the target.
      if (event.pointerType === 'touch') return;
      if (!isDisabled(node)) show();
    };
    const onfocusin = () => {
      // Only keyboard focus — a click already dismissed on pointerdown.
      if (node.matches(':focus-visible')) show();
    };

    node.addEventListener('pointerenter', onpointerenter);
    node.addEventListener('pointerleave', hide);
    node.addEventListener('pointerdown', dismiss, true);
    node.addEventListener('focusin', onfocusin);
    node.addEventListener('focusout', hide);

    // Disabled form controls swallow their own pointer events, and a disabled
    // control is exactly when its tooltip explains the most ("Connect a track
    // first"). Track the pointer on the parent and hit-test the node instead.
    const host = 'disabled' in node ? node.parentElement : null;
    let inside = false;
    const onhostmove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const over = isDisabled(node) && hits(node, event.clientX, event.clientY);
      if (over === inside) return;
      inside = over;
      if (over) show();
      else hide();
    };
    const onhostleave = () => {
      if (!inside) return;
      inside = false;
      hide();
    };
    host?.addEventListener('pointermove', onhostmove);
    host?.addEventListener('pointerleave', onhostleave);

    return () => {
      node.removeEventListener('pointerenter', onpointerenter);
      node.removeEventListener('pointerleave', hide);
      node.removeEventListener('pointerdown', dismiss, true);
      node.removeEventListener('focusin', onfocusin);
      node.removeEventListener('focusout', hide);
      host?.removeEventListener('pointermove', onhostmove);
      host?.removeEventListener('pointerleave', onhostleave);
      tooltips.forget(node);
    };
  };
}

