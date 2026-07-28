/** Attachment factory for popovers: calls `onDismiss` on pointerdown outside
 * the attached node or on Escape. Usage:
 *   <div {@attach dismissable(() => (open = false))}> */
export function dismissable(onDismiss: () => void) {
  return (node: Element) => {
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && node.contains(event.target)) return;
      onDismiss();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onDismiss();
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  };
}
