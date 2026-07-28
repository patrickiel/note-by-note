<script lang="ts">
  import { session } from '@/core/state/session.svelte';
  import { view } from '@/core/state/view.svelte';

  // Only over the workspace — never on top of the Settings/Library/Help views.
  let progress = $derived(view.current === 'workspace' ? session.countIn : null);
  let pips = $derived([...Array(progress?.beats ?? 0).keys()]);
</script>

{#if progress}
  <div
    class="overlay"
    role="status"
    aria-label="Count-in, beat {progress.beat} of {progress.beats}"
  >
    {#key progress.beat}
      <div class="count">
        <span class="number">{progress.beat}</span>
      </div>
    {/key}
    <div class="pips" aria-hidden="true">
      {#each pips as i (i)}
        <span class={['pip', { done: i < progress.beat }]}></span>
      {/each}
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: absolute;
    inset: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 22px;
    background: color-mix(in oklab, var(--bg) 82%, transparent);
    backdrop-filter: blur(2px);
    /* Purely informational — let clicks (e.g. Play again to abort) pass through
       to the transport underneath. */
    pointer-events: none;
  }

  .count {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 140px;
    height: 140px;
    border-radius: 50%;
    background: var(--accent-soft);
    border: 2px solid var(--accent);
    animation: count-pop 0.4s ease-out;
  }

  .number {
    font-family: var(--font-mono);
    font-size: 72px;
    font-weight: 700;
    line-height: 1;
    color: var(--accent-ink);
    font-variant-numeric: tabular-nums;
  }

  .pips {
    display: flex;
    gap: 10px;
  }

  .pip {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--toggle-off);
    transition: background 0.12s;
  }

  .pip.done {
    background: var(--accent);
  }

  @keyframes count-pop {
    0% {
      transform: scale(0.72);
      opacity: 0.35;
    }
    45% {
      transform: scale(1.06);
      opacity: 1;
    }
    100% {
      transform: scale(1);
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .count {
      animation: none;
    }
  }
</style>
