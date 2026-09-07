import { BUILTIN_EQ_PRESETS, EQ_BANDS } from '../../../core/model/defaults';
import type { EqPreset } from '../../../core/model/types';
import { editLibrary, readLibrary, watchLibrary } from '../../../core/persist/library-client';
import type { Library } from '../../../core/persist/library';

/** Slider gains are multiples of 0.5 dB, so anything closer than this is the
 * same curve; the tolerance only guards against float drift. */
const GAIN_EPSILON = 0.01;

class EqPresetsStore {
  /** Projection of non-deleted presets. */
  saved = $state<EqPreset[]>([]);

  async init() {
    const select = (library: Library): EqPreset[] => Object.entries(library.shared.presets)
      .filter(([, preset]) => preset.value !== null)
      .map(([name, preset]) => ({ name, gains: preset.value! }));
    this.saved = select(await readLibrary());
    watchLibrary(select, (value) => { this.saved = value; });
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
    await editLibrary({ type: 'preset', name, gains });
  }

  async remove(name: string) {
    await editLibrary({ type: 'preset', name, gains: null });
  }
}

export const eqPresets = new EqPresetsStore();
