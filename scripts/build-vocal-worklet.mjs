// Bundles src/features/vocal-reducer/engine/vocal-reducer.worklet.ts (plus its DSP import) into
// the self-contained classic script public/worklets/vocal-reducer-worklet.js.
// Runs from the wxt `build:before` hook (dev/build/zip) and from postinstall.
// NOTE: editing the worklet source mid-`pnpm dev` needs a dev-server restart
// (or run `node scripts/build-vocal-worklet.mjs` by hand).
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildWorklet() {
  await build({
    entryPoints: [resolve(root, 'src/features/vocal-reducer/engine/vocal-reducer.worklet.ts')],
    outfile: resolve(root, 'public/worklets/vocal-reducer-worklet.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildWorklet();
  console.log('wrote public/worklets/vocal-reducer-worklet.js');
}
