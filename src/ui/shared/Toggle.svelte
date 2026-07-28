<script lang="ts">
  let {
    checked = $bindable(false),
    disabled = false,
    label,
    size = 'md',
    onchange,
  }: {
    checked?: boolean;
    disabled?: boolean;
    label: string;
    /** `sm` (30×18) for inline use in headers/cards; `md` (38×22) default. */
    size?: 'md' | 'sm';
    onchange?: (checked: boolean) => void;
  } = $props();

  function toggle() {
    checked = !checked;
    onchange?.(checked);
  }
</script>

<button
  type="button"
  class={['toggle', { sm: size === 'sm', on: checked }]}
  role="switch"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  onclick={toggle}
>
  <span class="knob"></span>
</button>

<style>
  .toggle {
    position: relative;
    width: 38px;
    height: 22px;
    flex: none;
    border-radius: var(--radius-pill);
    background: var(--toggle-off);
    border: 1px solid var(--border-strong);
    transition:
      background 0.18s,
      border-color 0.18s;
  }

  .toggle.on {
    background: var(--accent);
    border-color: transparent;
  }

  .toggle:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--toggle-knob);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
    transition:
      transform 0.2s cubic-bezier(0.34, 1.4, 0.44, 1),
      background 0.18s;
  }

  .toggle.on .knob {
    transform: translateX(16px);
    background: var(--toggle-knob-on);
  }

  /* Compact variant. */
  .toggle.sm {
    width: 30px;
    height: 18px;
  }

  .toggle.sm .knob {
    width: 12px;
    height: 12px;
  }

  .toggle.sm.on .knob {
    transform: translateX(12px);
  }
</style>
