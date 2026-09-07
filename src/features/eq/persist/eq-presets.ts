import type { EqPreset } from '../../../core/model/types';
import { tombstone } from '../../../core/persist/deletions';
import { eqPresetsItem } from '../../../core/persist/storage';

/** Save the current curve under `name`. An existing preset with that name is
 * replaced in place — that's the edit and rename path, so there's no separate
 * UI for either, and it is also what un-deletes a name this device or another
 * one had tombstoned. Stamped so a sync merge can tell this save from a
 * deletion of the same name on another device (see deletions.ts). */
export async function saveEqPreset(name: string, gains: number[]): Promise<void> {
  const list = await eqPresetsItem.getValue();
  const index = list.findIndex((p) => p.name === name);
  const preset = { name, gains, updatedAt: Date.now() };
  if (index === -1) {
    await eqPresetsItem.setValue([...list, preset]);
  } else {
    const next = [...list];
    next[index] = preset;
    await eqPresetsItem.setValue(next);
  }
}

/** The preset stays as a tombstone (`deletions.ts`), emptied of its gains, so
 * a sync merge with another device's copy doesn't bring it back. */
export async function deleteEqPreset(name: string): Promise<void> {
  const list = await eqPresetsItem.getValue();
  const now = Date.now();
  await eqPresetsItem.setValue(
    list.map((p) => (p.name === name ? tombstone<EqPreset>({ name, gains: [] }, now) : p)),
  );
}
