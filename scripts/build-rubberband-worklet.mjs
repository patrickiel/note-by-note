// Bundles src/features/pitch/engine/rubberband.worklet.ts (plus the @echogarden/rubberband-wasm
// Emscripten glue) into the self-contained classic script
// public/worklets/rubberband-worklet.js. Runs from the wxt `build:before` hook
// (dev/build/zip) and from postinstall.
//
// The glue is an ES module targeting web/node/worker; two tweaks make it run in
// an AudioWorkletGlobalScope (which is none of those — Emscripten's "shell"
// env):
//   - `define process: undefined`  → forces ENVIRONMENT_IS_NODE false, so the
//     Node-only branch (its `await import("module")`, fs/path/url requires) is
//     never taken. The dead `import()` remains in the bundle but never runs.
//   - `define import.meta.url: ""`  → the glue only reads it to locate the wasm,
//     which we bypass by passing the bytes in via `wasmBinary`/`instantiateWasm`.
// NOTE: editing the worklet source mid-`pnpm dev` needs a dev-server restart
// (or run `node scripts/build-rubberband-worklet.mjs` by hand).
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildWorklet() {
  await build({
    entryPoints: [resolve(root, 'src/features/pitch/engine/rubberband.worklet.ts')],
    outfile: resolve(root, 'public/worklets/rubberband-worklet.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    define: {
      'import.meta.url': '""',
      process: 'undefined',
    },
    // Node built-ins referenced only inside dead ENVIRONMENT_IS_NODE branches.
    external: ['module', 'fs', 'path', 'url', 'worker_threads', 'crypto'],
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await buildWorklet();
  console.log('wrote public/worklets/rubberband-worklet.js');
}
