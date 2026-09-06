import { presetDeletion } from '../../../core/persist/deletions';
import { eqPresetsItem, recordDeletion } from '../../../core/persist/storage';

/** Save the current curve under `name`. An existing preset with that name is
 * replaced in place — that's the edit and rename path, so there's no separate
 * UI for either. Stamped so a sync merge can tell this save from a deletion
 * of the same name on another device (see deletions.ts). */
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

/** Dated (`deletions.ts`) so a sync merge with another device's copy doesn't
 * bring the preset back. */
export async function deleteEqPreset(name: string): Promise<void> {
  const list = await eqPresetsItem.getValue();
  await eqPresetsItem.setValue(list.filter((p) => p.name !== name));
  await recordDeletion(presetDeletion(name));
}
