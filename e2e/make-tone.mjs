// Generates a 30s 440 Hz sine WAV used by the E2E test page.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const out = resolve(dir, 'fixtures', 'tone-440.wav');

const sampleRate = 44100;
const seconds = 30;
const freq = 440;
const samples = sampleRate * seconds;
const dataSize = samples * 2;
const buf = Buffer.alloc(44 + dataSize);

buf.write('RIFF', 0);
buf.writeUInt32LE(36 + dataSize, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(1, 22); // mono
buf.writeUInt32LE(sampleRate, 24);
buf.writeUInt32LE(sampleRate * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(dataSize, 40);

for (let i = 0; i < samples; i++) {
  const v = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.6;
  buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
console.log(`wrote ${out}`);
