<script lang="ts">
  import IconButton from '@/ui/shared/IconButton.svelte';
  import { session } from '@/core/state/session.svelte';
  import { view } from '@/core/state/view.svelte';
</script>

<header
  class="topbar flex items-center gap-2 h-13 px-2.5 border-b border-line shrink-0"
>
  <div class="flex items-center gap-2 min-w-0">
    <span class="text-[13.5px] font-bold tracking-[0.01em] whitespace-nowrap">
      Note <em class="not-italic text-accent-ink">by</em> Note
    </span>
  </div>
  <span class="flex-1"></span>
  <div class="flex items-center gap-0.5">
    <!-- Share button hidden: its behavior is unspecified. -->
    <span class={['power-wrap inline-flex', { off: !session.params.power }]}>
      <IconButton
        icon="power"
        label={session.params.power ? 'Power (on)' : 'Power (off)'}
        action="power"
        active={session.params.power}
        onclick={() => session.togglePower()}
      />
    </span>
    <span class="w-px h-4 mx-1 bg-line-strong"></span>
    <IconButton icon="library" label="Songs" onclick={() => view.open('library')} />
    <IconButton icon="help" label="Help" onclick={() => view.open('help')} />
    <IconButton
      icon="settings"
      label="Settings"
      onclick={() => view.open('settings')}
    />
  </div>
</header>

<style>
  /* Base-colored bar with a whisper of top sheen. */
  .topbar {
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.025), transparent),
      var(--bg);
  }

  /* Power OFF = processing bypass: danger-tinted, dimmed icon. */
  .power-wrap.off :global(.icon-btn) {
    color: var(--danger);
    opacity: 0.7;
  }
</style>
