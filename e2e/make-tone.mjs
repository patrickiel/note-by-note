// Generates the 30s sine WAVs used by the E2E test page: tone-440.wav (the
// main track) and tone-432.wav (a detuned copy for reference-tuning detection).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));

for (const freq of [440, 432]) writeTone(freq, resolve(dir, 'fixtures', `tone-${freq}.wav`));

function writeTone(freq, out) {
const sampleRate = 44100;
const seconds = 30;
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
}
