// Copies the GPL Rubber Band WASM binary shipped by @echogarden/rubberband-wasm
// into public/worklets/rb.wasm (a web_accessible_resource). The extension
// fetches these bytes on the main thread and hands them to the pitch worklet
// via processorOptions — CSP-safe, since nothing is fetched or compiled from a
// Blob/eval inside the worklet scope. Runs at postinstall; the copied binary is
// committed so builds don't depend on the package being reinstalled.
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export async function copyRubberbandWasm() {
  const src = require.resolve('@echogarden/rubberband-wasm/rubberband.wasm');
  const dest = resolve(root, 'public/worklets/rb.wasm');
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await copyRubberbandWasm();
  console.log('wrote public/worklets/rb.wasm');
}
