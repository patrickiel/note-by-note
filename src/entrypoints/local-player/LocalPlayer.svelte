<script lang="ts">
  import Icon from '@/ui/shared/Icon.svelte';
  import { Controller } from '@/core/engine/controller';

  let fileName = $state<string | null>(null);
  let objectUrl = $state<string | null>(null);
  let isVideo = $state(false);
  let dragOver = $state(false);

  // The same engine as the content script, reporting as a local file.
  const controller = new Controller({ connectedState: 'local-file' });
  controller.begin();

  function openFile(file: File) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    isVideo = file.type.startsWith('video/');
    fileName = file.name;
    document.title = `${file.name} — Note by Note`;
    // The controller's media watcher picks the element up automatically.
  }

  function onpick(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (file) openFile(file);
  }

  function ondrop(event: DragEvent) {
    event.preventDefault();
    dragOver = false;
    const file = event.dataTransfer?.files?.[0];
    if (file && /^(audio|video)\//.test(file.type)) openFile(file);
  }
</script>

<svelte:document
  ondragover={(e) => {
    e.preventDefault();
    dragOver = true;
  }}
  ondragleave={() => (dragOver = false)}
  {ondrop}
/>

<main
  class={[
    'max-w-[860px] mx-auto px-5 py-8 flex flex-col gap-5 min-h-screen',
    { 'outline-2 outline-dashed outline-accent-ink -outline-offset-8': dragOver },
  ]}
>
  <header class="flex items-baseline gap-2 text-accent-ink">
    <h1 class="m-0 text-[17px] text-fg">Note by Note</h1>
    <span class="text-[13px] text-muted">Local file</span>
  </header>

  {#if objectUrl}
    <p class="m-0 font-semibold">{fileName}</p>
    {#if isVideo}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video src={objectUrl} class="w-full rounded-md bg-black" controls autoplay></video>
    {:else}
      <audio src={objectUrl} class="w-full rounded-md bg-black" controls autoplay></audio>
    {/if}
    <p class="text-muted text-[12.5px]">Control pitch, speed, loops, and snippets from the Note by Note side panel.</p>
  {:else}
    <label
      class="flex flex-col items-center gap-2.5 py-18 px-6 border-2 border-dashed border-line-strong rounded-md text-muted cursor-pointer text-center hover:border-accent-ink hover:text-fg"
    >
      <Icon name="folderOpen" size={40} />
      <span class="text-[15px] font-bold text-fg">Open an audio or video file</span>
      <span class="text-[12.5px]">Click to browse, or drop a file anywhere (mp3, wav, mp4, mov …)</span>
      <input type="file" accept="audio/*,video/*" class="hidden" onchange={onpick} />
    </label>
  {/if}
</main>
