import { BUILTIN_EQ_PRESETS, EQ_BANDS } from '../../../core/model/defaults';
import type { EqPreset } from '../../../core/model/types';
import { deleteEqPreset, saveEqPreset } from '../persist/eq-presets';
import { eqPresetsItem } from '../../../core/persist/storage';

/** Slider gains are multiples of 0.5 dB, so anything closer than this is the
 * same curve; the tolerance only guards against float drift. */
const GAIN_EPSILON = 0.01;

class EqPresetsStore {
  saved = $state<EqPreset[]>([]);

  async init() {
    this.saved = await eqPresetsItem.getValue();
    eqPresetsItem.watch((value) => {
      this.saved = value ?? [];
    });
  }

  /** Built-ins first, then the user's, as listed in the dropdown. */
  get all(): EqPreset[] {
    return [...BUILTIN_EQ_PRESETS, ...this.saved];
  }

  /** True for user presets only — built-ins can't be deleted. */
  isSaved(name: string): boolean {
    return this.saved.some((p) => p.name === name);
  }

  /** Name of the preset `gains` currently matches, or null when the curve is
   * custom. Built-ins win ties, being first in `all`. */
  match(gains: number[]): string | null {
    const preset = this.all.find((p) =>
      EQ_BANDS.every(
        (_, i) => Math.abs((p.gains[i] ?? 0) - (gains[i] ?? 0)) < GAIN_EPSILON,
      ),
    );
    return preset?.name ?? null;
  }

  async save(name: string, gains: number[]) {
    await saveEqPreset(name, gains);
  }

  async remove(name: string) {
    await deleteEqPreset(name);
  }
}

export const eqPresets = new EqPresetsStore();
