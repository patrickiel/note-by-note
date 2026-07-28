<script lang="ts">
  import { FILLED_ICONS, ICONS, type IconName } from '@/ui/icons';

  let {
    name,
    size = 18,
  }: {
    name: IconName;
    size?: number;
  } = $props();

  const Glyph = $derived(ICONS[name]);
</script>

<Glyph
  {size}
  fill={FILLED_ICONS.has(name) ? 'currentColor' : 'none'}
  aria-hidden="true"
/>
