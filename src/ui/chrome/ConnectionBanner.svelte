<script lang="ts">
  import Icon from '@/ui/shared/Icon.svelte';
  import type { IconName } from '@/ui/icons';
  import { session } from '@/core/state/session.svelte';
  import { cubicOut } from 'svelte/easing';
  import { untrack } from 'svelte';

  /**
   * Reveals the banner as a single fade at (near) full size rather than growing
   * an empty box: the height/padding/margin reach full within the first third
   * of the reveal, while opacity fades across the whole duration. That avoids
   * the "empty accent sliver, then content" two-step, while still collapsing the
   * box (so content below eases into place instead of jumping). At t=0 the box
   * is fully collapsed and transparent, so during the `delay` window a transient
   * state (e.g. seeking) reserves no space and never flashes.
   */
  function slideFade(node: HTMLElement, { duration = 200, delay = 0 } = {}) {
    const style = getComputedStyle(node);
    const height = parseFloat(style.height);
    const padTop = parseFloat(style.paddingTop);
    const padBottom = parseFloat(style.paddingBottom);
    const marginTop = parseFloat(style.marginTop);
    const marginBottom = parseFloat(style.marginBottom);
    return {
      duration,
      delay,
      easing: cubicOut,
      css: (t: number) => {
        const grow = Math.min(1, t * 3);
        return `
        overflow: hidden;
        opacity: ${t};
        height: ${grow * height}px;
        padding-top: ${grow * padTop}px;
        padding-bottom: ${grow * padBottom}px;
        margin-top: ${grow * marginTop}px;
        margin-bottom: ${grow * marginBottom}px;
      `;
      },
    };
  }

  let {
    onconnect,
    oncapture,
  }: {
    /** Requests host permission / injects the content script. */
    onconnect?: () => void;
    /** Switches to tab audio mode. */
    oncapture?: () => void;
  } = $props();

  interface BannerContent {
    icon: IconName;
    title: string;
    lines: string[];
    /** Inline link on plain banners; on highlighted banners the label becomes a
     * static chip and its onclick drives the whole card. */
    action?: { label: string; onclick: () => void };
    /** Draws the banner as a prominent clickable accent card. */
    highlight?: boolean;
  }

  let content = $derived.by((): BannerContent | null => {
    switch (session.connection) {
      case 'connected-direct':
      case 'connected-hybrid':
      case 'connected-capture':
      case 'local-file':
        return null;
      case 'idle':
      case 'detecting':
        return {
          icon: 'playCircle',
          title: 'Connect to this page',
          lines: ['Works on any tab playing audio or video.'],
          action: onconnect ? { label: 'Connect', onclick: onconnect } : undefined,
          highlight: true,
        };
      case 'media-paused':
        // Count-in pauses the element on purpose (restart or manual play) —
        // that pause is not a "start playback" prompt.
        if (session.countIn != null) return null;
        return {
          icon: 'playCircle',
          title: 'Start playback',
          lines: ['Play audio or video on this page to get started.'],
          highlight: true,
        };
      case 'stale':
        return {
          icon: 'playCircle',
          title: 'Start playback',
          lines: [
            'Play audio or video on this page to get started.',
            "If Note by Note doesn't connect, reload the page and reopen the extension.",
          ],
          highlight: true,
        };
      case 'pitch-unavailable':
        return {
          icon: 'tabAudio',
          title: 'Pitch not available',
          lines: [
            'This page blocks the audio processor, so pitch, vocals and the EQ are off.',
            oncapture
              ? 'Tab capture routes the sound through the extension instead.'
              : 'Speed and looping still work. For the full set, play the file from your device (Settings → Play a local file).',
          ],
          action: oncapture
            ? { label: 'Use tab capture', onclick: oncapture }
            : undefined,
          // The dimmed effect panels below are only explained by this card, so
          // it gets the same weight as the Connect prompt rather than sitting
          // quietly above them.
          highlight: !!oncapture,
        };
      case 'no-player':
        return {
          icon: 'tabAudio',
          title: 'No compatible player detected',
          lines: [
            "Audio is playing, but Note by Note couldn't hook into this page's player. Other audio/video extensions can conflict — try disabling them.",
          ],
          action: oncapture
            ? { label: 'Use tab capture', onclick: oncapture }
            : undefined,
        };
      case 'restricted':
        return {
          icon: 'shield',
          title: 'Not available here',
          lines: ["Note by Note can't run on this page. Try a tab with audio or video."],
        };
    }
  });

  /**
   * Delays *showing* the banner so brief transient states (e.g. `media-paused`
   * flashing while seeking on the YouTube scrubber) don't pop it in for a few
   * hundred ms. A timer gate is required: Svelte's transition `delay` renders
   * the element fully during the delay, so it can't hide it. Hiding stays
   * immediate — the effect depends only on `content`, so a `null` clears the
   * banner (and cancels any pending show) at once.
   */
  const SHOW_DELAY = 800;
  let visibleContent = $state<BannerContent | null>(null);

  $effect(() => {
    if (!content) {
      untrack(() => (visibleContent = null));
      return;
    }
    const next = content;
    // Already showing: swap content live without re-arming the delay.
    if (untrack(() => visibleContent)) {
      untrack(() => (visibleContent = next));
      return;
    }
    const timer = setTimeout(() => (visibleContent = next), SHOW_DELAY);
    return () => clearTimeout(timer);
  });
</script>

{#if visibleContent}
  <svelte:element
    this={visibleContent.highlight ? 'button' : 'div'}
    type={visibleContent.highlight ? 'button' : undefined}
    class="banner surface"
    class:highlight={visibleContent.highlight}
    role={visibleContent.highlight ? 'button' : 'status'}
    onclick={visibleContent.highlight
      ? (visibleContent.action?.onclick ?? (() => session.togglePlay()))
      : undefined}
    in:slideFade={{ duration: 220 }}
    out:slideFade={{ duration: 220 }}
  >
    <span class="icon">
      <Icon name={visibleContent.icon} size={18} />
    </span>
    <div class="text">
      <p class="title">{visibleContent.title}</p>
      {#each visibleContent.lines as line (line)}
        <p class="body">{line}</p>
      {/each}
      {#if visibleContent.action}
        {#if visibleContent.highlight}
          <!-- A label, not a control: the card itself already carries the same
               click, and a nested <button> inside it would be invalid. -->
          <span class="cta">{visibleContent.action.label}</span>
        {:else}
          <button type="button" class="action" onclick={visibleContent.action.onclick}>
            {visibleContent.action.label}
          </button>
        {/if}
      {/if}
      {#if session.lastError?.code === 'capture-failed'}
        <p class="error">
          Tab capture failed. Open Note by Note from its toolbar icon on this tab, then try
          again.
        </p>
      {/if}
    </div>
  </svelte:element>
{/if}

<style>
  .banner {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
  }

  .icon {
    display: inline-flex;
    color: var(--text-muted);
    margin-top: 1px;
    flex-shrink: 0;
  }

  /* Highlighted prompt ("Connect to this page", "Start playback", "Pitch not
     available") — the primary call to action. */
  .banner.highlight {
    width: 100%;
    text-align: left;
    cursor: pointer;
    background: var(--accent);
    border: none;
    box-shadow: 0 4px 16px var(--accent-soft);
    animation: attention 2s ease-in-out infinite;
    transition: background 0.12s;
  }

  .banner.highlight:hover {
    background: var(--accent-hover);
  }

  .banner.highlight .icon {
    color: var(--accent-contrast);
    animation: pulse 1.4s ease-in-out infinite;
  }

  .banner.highlight .title {
    color: var(--accent-contrast);
    font-size: 15px;
  }

  .banner.highlight .body {
    color: var(--accent-contrast);
    opacity: 0.85;
  }

  /* On the amber highlight fill, the default --danger red has poor contrast.
     A dark brick red stays legible on amber (~5:1) while still reading as an error. */
  .banner.highlight .error {
    color: #7a1b12;
    font-weight: 600;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.65;
      transform: scale(1.18);
    }
  }

  @keyframes attention {
    0%,
    100% {
      box-shadow: 0 4px 16px var(--accent-soft);
    }
    50% {
      box-shadow: 0 4px 22px var(--accent);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .banner.highlight,
    .banner.highlight .icon {
      animation: none;
    }
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  .body {
    margin: 0;
    font-size: 12px;
    color: var(--text-muted);
  }

  .error {
    margin: 6px 0 0;
    font-size: 11.5px;
    color: var(--danger);
  }

  .action {
    align-self: flex-start;
    margin-top: 3px;
    padding: 3px 6px;
    border-radius: var(--radius-sm);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--accent-ink);
  }

  .action:hover {
    color: var(--accent-ink-hover);
    background: var(--accent-soft);
  }

  /* The highlighted card's call to action. Tinted with the same dark ink the
     text uses, so it reads as a button on the amber fill in either theme. */
  .cta {
    align-self: flex-start;
    margin-top: 5px;
    padding: 3px 9px;
    border-radius: var(--radius-pill);
    background: rgba(32, 22, 10, 0.13);
    border: 1px solid rgba(32, 22, 10, 0.2);
    color: var(--accent-contrast);
    font-size: 12px;
    font-weight: 700;
    transition: background 0.12s;
  }

  .banner.highlight:hover .cta {
    background: rgba(32, 22, 10, 0.22);
  }
</style>
