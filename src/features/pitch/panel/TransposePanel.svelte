<script lang="ts">
  import Panel from '@/ui/Panel.svelte';
  import SliderRow from '@/ui/SliderRow.svelte';
  import {
    DEFAULT_PARAMS,
    TRANSPOSE_RANGE_EXTENDED,
    TRANSPOSE_RANGE_STANDARD,
  } from '@/core/model/defaults';
  import { formatTranspose } from '@/core/model/format';
  import { settings } from '@/features/settings/panel/settings.svelte';
  import { session } from '@/core/state/session.svelte';

  let { grouped = false }: { grouped?: boolean } = $props();

  const RESET_KEYS = ['transpose'] as const;

  let limit = $derived(
    settings.current.extendedTranspose ? TRANSPOSE_RANGE_EXTENDED : TRANSPOSE_RANGE_STANDARD,
  );
  let enabled = $derived(session.params.transposeEnabled);
  let dirty = $derived(!session.isDefault([...RESET_KEYS]));
  // Pitch shifting lives in the DSP chain, so it's inert when that never attached.
  let blocked = $derived(!session.dspAvailable);
</script>

<Panel
  id="transpose"
  value={formatTranspose(session.params.transpose)}
  {enabled}
  {grouped}
  unavailable={blocked}
  onenabledchange={(on) => session.patchParams({ transposeEnabled: on })}
  onreset={() => session.resetParam([...RESET_KEYS])}
  resettable={dirty}
>
  <SliderRow
    value={session.params.transpose}
    min={-limit}
    max={limit}
    step={1}
    defaultValue={DEFAULT_PARAMS.transpose}
    disabled={!enabled || blocked}
    label="Transpose"
    downAction="transposeDown"
    upAction="transposeUp"
    onchange={(v) => session.patchParams({ transpose: v })}
  />
</Panel>
