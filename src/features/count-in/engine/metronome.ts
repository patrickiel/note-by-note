/** Audible count-in clicks. Owns a small dedicated AudioContext (independent of
 * the DSP pipeline) so it works in the content script and the local player. The
 * caller gates beeps to direct/local mode — in tab-capture mode a page-side
 * click would be re-captured and returned pitch-shifted, so we never play there.
 *
 * Clicks are scheduled ahead on the audio clock, which stays sample-accurate
 * even when the page's rAF/timers are throttled — the visual count may drift a
 * few ms, but the beat you *hear* is exact. */
export class Metronome {
  #ctx: AudioContext | null = null;
  #removeResume: (() => void) | null = null;
  /** Clicks committed to the audio clock but not yet finished — kept so an
   * aborted count-in can silence the ones that haven't sounded. */
  #scheduled: OscillatorNode[] = [];

  /** Lazily create the context on first use and keep it warm across count-ins.
   * Autoplay policy starts it suspended, so resume on any page gesture too. */
  #ensureCtx(): AudioContext {
    if (this.#ctx) return this.#ctx;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.#ctx = ctx;
    const resume = () => void ctx.resume().catch(() => {});
    document.addEventListener('pointerdown', resume, { capture: true });
    document.addEventListener('keydown', resume, { capture: true });
    this.#removeResume = () => {
      document.removeEventListener('pointerdown', resume, { capture: true });
      document.removeEventListener('keydown', resume, { capture: true });
    };
    return ctx;
  }

  /** Schedule `beats` clicks one beat apart at `bpm`, accenting the downbeat. */
  scheduleClicks(beats: number, bpm: number) {
    this.stop(); // drop any clicks still pending from a previous count-in
    const ctx = this.#ensureCtx();
    void ctx.resume().catch(() => {});
    const interval = 60 / bpm; // seconds per beat
    const start = ctx.currentTime + 0.05; // tiny lead so the first click isn't clipped
    for (let i = 0; i < beats; i++) {
      this.#click(ctx, start + i * interval, i === 0);
    }
  }

  /** Silence every click that hasn't sounded yet (called when a count-in is
   * aborted). Clicks already playing get their tail cut — inaudible for a
   * ~50ms blip. */
  stop() {
    for (const osc of this.#scheduled) {
      try {
        osc.stop();
      } catch {
        // Already stopped/ended — nothing to cancel.
      }
    }
    this.#scheduled = [];
  }

  #click(ctx: AudioContext, at: number, accent: boolean) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = accent ? 1600 : 1000;
    const peak = accent ? 0.5 : 0.28;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.07);
    this.#scheduled.push(osc);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
      const i = this.#scheduled.indexOf(osc);
      if (i >= 0) this.#scheduled.splice(i, 1);
    };
  }

  dispose() {
    this.stop();
    this.#removeResume?.();
    this.#removeResume = null;
    void this.#ctx?.close().catch(() => {});
    this.#ctx = null;
  }
}
