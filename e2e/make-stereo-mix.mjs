// Generates a 30s stereo WAV for the vocal-reducer E2E test:
//   80 Hz equal in L/R   — "bass", center but below the reducer's low cut
//   440 Hz equal in L/R  — "vocal", center and in-band → should be cut
//   2000 Hz left only    — "side", in-band but panned → should survive
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const out = resolve(dir, 'fixtures', 'stereo-mix.wav');

const sampleRate = 44100;
const seconds = 30;
const samples = sampleRate * seconds;
const dataSize = samples * 4; // stereo, 16-bit
const buf = Buffer.alloc(44 + dataSize);

buf.write('RIFF', 0);
buf.writeUInt32LE(36 + dataSize, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(2, 22); // stereo
buf.writeUInt32LE(sampleRate, 24);
buf.writeUInt32LE(sampleRate * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(dataSize, 40);

for (let i = 0; i < samples; i++) {
  const t = i / sampleRate;
  const bass = 0.3 * Math.sin(2 * Math.PI * 80 * t);
  const vocal = 0.3 * Math.sin(2 * Math.PI * 440 * t);
  const side = 0.3 * Math.sin(2 * Math.PI * 2000 * t);
  buf.writeInt16LE(Math.round((bass + vocal + side) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round((bass + vocal) * 32767), 46 + i * 4);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
console.log(`wrote ${out}`);
