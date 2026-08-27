<script lang="ts">
  import { tooltip } from '@/ui/shared/tooltip.svelte';

  /** The "DETECT" button shared by auto-tempo and auto-tuning: a fixed-width
   * ghost button that swaps its label for a bobbing spectrum meter while the
   * engine measures, and flips its tooltip to a hint after a fruitless run. */
  let {
    detecting,
    disabled = false,
    /** What is being measured, for the accessible name ("Detect tempo"). */
    subject,
    hint,
    noResult = false,
    noResultHint,
    onclick,
  }: {
    detecting: boolean;
    disabled?: boolean;
    subject: string;
    hint: string;
    noResult?: boolean;
    noResultHint: string;
    onclick: () => void;
  } = $props();
</script>

<button
  type="button"
  class={[
    'relative flex-none rounded-[7px] border px-2.25 py-1 font-mono text-[10px] font-bold tracking-[0.08em]',
    detecting
      ? 'detecting text-accent-ink border-accent-line bg-accent-softer'
      : noResult
        ? 'text-danger border-danger ghost'
        : 'text-muted border-line-strong ghost active:not-disabled:bg-inset active:not-disabled:text-accent',
  ]}
  aria-label={detecting ? `Detecting ${subject}` : `Detect ${subject}`}
  aria-busy={detecting}
  {disabled}
  {onclick}
  {@attach tooltip(noResult ? noResultHint : hint)}
>
  <!-- The label stays in the DOM (hidden while detecting) so the button
       keeps a constant width; the meter overlays it in fixed columns. After a
       fruitless run it reads FAILED for a few seconds — same six monospace
       glyphs, so nothing shifts — with the hint in the tooltip. -->
  <span class="detect-label" role={noResult ? 'status' : undefined}>
    {noResult ? 'FAILED' : 'DETECT'}
  </span>
  {#if detecting}
    <span class="eq" aria-hidden="true">
      <i class="bar"></i>
      <i class="bar"></i>
      <i class="bar"></i>
      <i class="bar"></i>
    </span>
  {/if}
</button>

<style>
  /* Hidden but still laid out → the button width stays fixed at "DETECT". */
  .detecting .detect-label {
    visibility: hidden;
  }

  /* A small spectrum meter: fixed-width bars centered over the button, so only
     their HEIGHT animates. All bars share one keyframe; per-bar animation-delay
     scatters the phase so they bob out of sync. (The keyframe name must stay in
     the `animation` shorthand — a nameless one gets minified to `none`.) */
  .eq {
    position: absolute;
    inset: 0;
    margin: auto;
    width: 22px;
    display: flex;
    align-items: center;
  }

  .bar {
    flex: 1 1 0;
    min-width: 0;
    font-size: 9px;
    line-height: 1;
    font-style: normal;
    text-align: center;
  }

  .bar::before {
    content: '▃';
    animation: eq 1.1s steps(1, end) infinite;
  }
  .bar:nth-child(2)::before {
    animation-delay: -0.45s;
  }
  .bar:nth-child(3)::before {
    animation-delay: -0.2s;
  }
  .bar:nth-child(4)::before {
    animation-delay: -0.75s;
  }

  @keyframes eq {
    0% { content: '▁'; }
    12.5% { content: '▃'; }
    25% { content: '▅'; }
    37.5% { content: '▆'; }
    50% { content: '▇'; }
    62.5% { content: '▆'; }
    75% { content: '▅'; }
    87.5% { content: '▃'; }
  }

  @media (prefers-reduced-motion: reduce) {
    .bar::before {
      content: '▄';
      animation: none;
    }
  }
</style>
