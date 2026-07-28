import { EQ_BANDS, EQ_GAIN_LIMIT } from '../../../core/model/defaults';

/** 10-band graphic EQ: chained peaking biquads (shelves at the extremes). */
export interface Equalizer {
  input: AudioNode;
  output: AudioNode;
  setGains(gains: number[]): void;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

export function createEqualizer(ctx: BaseAudioContext): Equalizer {
  const filters = EQ_BANDS.map((frequency, i) => {
    const filter = ctx.createBiquadFilter();
    filter.type =
      i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
    filter.frequency.value = frequency;
    filter.Q.value = 1.1;
    filter.gain.value = 0;
    return filter;
  });
  for (let i = 1; i < filters.length; i++) filters[i - 1].connect(filters[i]);

  let currentGains = EQ_BANDS.map(() => 0);
  let enabled = false;

  const apply = () => {
    const t = ctx.currentTime;
    filters.forEach((filter, i) => {
      const target = enabled
        ? Math.max(-EQ_GAIN_LIMIT, Math.min(EQ_GAIN_LIMIT, currentGains[i] ?? 0))
        : 0;
      filter.gain.setTargetAtTime(target, t, 0.02);
    });
  };

  return {
    input: filters[0],
    output: filters[filters.length - 1],
    setGains(gains) {
      currentGains = gains;
      apply();
    },
    setEnabled(on) {
      enabled = on;
      apply();
    },
    dispose() {
      for (const filter of filters) filter.disconnect();
    },
  };
}
