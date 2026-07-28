import { Controller } from '@/core/engine/controller';

export default defineContentScript({
  registration: 'runtime',
  main(ctx) {
    // executeScript can race with registerContentScripts on reload.
    if (window.__noteByNote) return;
    window.__noteByNote = true;
    const controller = new Controller();
    controller.begin();
    // Extension reload/update: tear the orphaned engine down — otherwise it
    // keeps ticking, seeking, and re-writing playbackRate with no UI able to
    // reach it, fighting both the page player and the freshly injected copy.
    ctx.onInvalidated(() => {
      window.__noteByNote = false;
      controller.destroy();
    });
  },
});
