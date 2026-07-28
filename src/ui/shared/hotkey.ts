/** Turning a stored combo ("Shift+ArrowLeft") into display chips (⇧ ←).
 *
 * Shared by everything that shows a binding — tooltips, the Help sheet, the
 * keymap editor — so one shortcut never reads two different ways.
 *
 * Modifier names are spelled out on Windows/Linux and drawn as the standard
 * glyphs on macOS, which is what Mac users read on every other menu. Note that
 * `Ctrl` stays ⌃ (Control) rather than ⌘: `comboFromEvent` binds `event.ctrlKey`,
 * so Control really is the key that fires it. */

import { DEFAULT_KEYMAP } from '@/core/model/defaults';
import type { ActionId } from '@/core/model/types';
import { settings } from '@/features/settings/panel/settings.svelte';

/** Chrome exposes the real platform on `userAgentData`; the rest is fallback
 * for Firefox, where `navigator.platform` is still the reliable signal. */
export const IS_MAC = (() => {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
})();

/** Modifiers a combo can be prefixed with. Command/Win is absent on purpose:
 * neither `comboFromEvent` nor the keymap editor reads `event.metaKey`, so no
 * stored combo can contain it. */
const MODIFIERS = new Set(['Ctrl', 'Alt', 'Shift']);

/** Splits "Shift+ArrowLeft" into its parts. Whatever follows the modifiers is
 * the key, so a literal "+" binding survives the split. */
function splitCombo(combo: string): string[] {
  const parts = combo.split('+');
  const out: string[] = [];
  while (parts.length > 1 && MODIFIERS.has(parts[0]!)) out.push(parts.shift()!);
  out.push(parts.join('+'));
  return out;
}

/** Keys whose `event.key` name is too long or too technical for a small chip. */
const COMMON_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
};

const WIN_LABELS: Record<string, string> = {
  Escape: 'Esc',
  Delete: 'Del',
  Backspace: '⌫',
};

const MAC_LABELS: Record<string, string> = {
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Escape: '⎋',
  Enter: '↩',
  Tab: '⇥',
  Backspace: '⌫',
  Delete: '⌦',
  Home: '↖',
  End: '↘',
  PageUp: '⇞',
  PageDown: '⇟',
};

function keyLabel(part: string): string {
  const platform = IS_MAC ? MAC_LABELS : WIN_LABELS;
  return (
    platform[part] ?? COMMON_LABELS[part] ?? (part.length === 1 ? part.toUpperCase() : part)
  );
}

/** Display chips for a combo, one per key. Empty for an empty combo. */
export function comboChips(combo: string | undefined): string[] {
  if (!combo) return [];
  return splitCombo(combo).filter(Boolean).map(keyLabel);
}

/** The combo to advertise for `action`, resolved exactly the way the global
 * key handler resolves it — nothing is shown while shortcuts are off. */
export function activeCombo(
  action: ActionId | undefined,
  keys?: string,
): string | undefined {
  if (keys) return keys;
  if (!action) return undefined;
  const current = settings.current;
  if (!current.shortcutsEnabled) return undefined;
  return (current.customShortcuts ? current.keymap : DEFAULT_KEYMAP)[action];
}
