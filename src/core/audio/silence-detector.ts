/** Watches an AnalyserNode for sustained silence while the element claims to
 * be playing audibly — the signature of a CORS-tainted MediaElementSource. */
export function watchSilence(
  analyser: AnalyserNode,
  el: HTMLMediaElement,
  onSilent: () => void,
  thresholdMs = 1000,
): () => void {
  const buffer = new Float32Array(analyser.fftSize);
  let silentSince: number | null = null;
  let stopped = false;

  const interval = setInterval(() => {
    if (stopped) return;
    // Buffering and seek stalls are legitimately silent — only playback that
    // is actually advancing with data available can prove a CORS taint.
    if (
      el.paused ||
      el.muted ||
      el.volume === 0 ||
      el.seeking ||
      el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
    ) {
      silentSince = null;
      return;
    }
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    const rms = Math.sqrt(sum / buffer.length);
    if (rms > 1e-6) {
      silentSince = null;
      return;
    }
    silentSince ??= performance.now();
    if (performance.now() - silentSince >= thresholdMs) {
      stopped = true;
      clearInterval(interval);
      onSilent();
    }
  }, 250);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
