<script lang="ts">
  import IconButton from '@/ui/shared/IconButton.svelte';
  import { markers } from '@/features/markers/panel/markers.svelte';
  import { session } from '@/core/state/session.svelte';
  import { uiPrefs } from '@/features/settings/panel/settings.svelte';

  const mode = $derived(session.loop.mode);
  const loopActive = $derived(session.loop.active && mode?.kind !== 'song');
  const loopDisabled = $derived(markers.range === null && mode?.kind !== 'range');
  const markerView = $derived(uiPrefs.current.markerView);
</script>

<div class="flex items-center gap-0.5">
  <IconButton
    icon="plus"
    label="Add marker"
    action="addMarker"
    onclick={() => markers.add()}
  />
  <IconButton
    icon="loop"
    label="Loop selected range"
    action="toggleLoop"
    active={loopActive}
    disabled={loopDisabled}
    onclick={() => session.toggleLoop(!session.loop.active)}
  />
  <IconButton
    icon="clock"
    label="Count-in"
    active={session.loop.countIn}
    onclick={() => session.toggleCountIn(!session.loop.countIn)}
  />
  <span class="flex-1"></span>
  <IconButton
    icon="pencil"
    label="Edit markers"
    active={markers.editMode}
    onclick={() => (markers.editMode = !markers.editMode)}
  />
  <IconButton
    icon={markerView === 'blocks' ? 'viewList' : 'viewBlocks'}
    label={markerView === 'blocks' ? 'List view' : 'Blocks view'}
    onclick={() => uiPrefs.setMarkerView(markerView === 'blocks' ? 'list' : 'blocks')}
  />
</div>
