import { eqPresetsItem } from '../../../core/persist/storage';

/** Save the current curve under `name`. An existing preset with that name is
 * replaced in place — that's the edit and rename path, so there's no separate
 * UI for either. */
export async function saveEqPreset(name: string, gains: number[]): Promise<void> {
  const list = await eqPresetsItem.getValue();
  const index = list.findIndex((p) => p.name === name);
  if (index === -1) {
    await eqPresetsItem.setValue([...list, { name, gains }]);
    return;
  }
  const next = [...list];
  next[index] = { name, gains };
  await eqPresetsItem.setValue(next);
}

export async function deleteEqPreset(name: string): Promise<void> {
  const list = await eqPresetsItem.getValue();
  await eqPresetsItem.setValue(list.filter((p) => p.name !== name));
}
