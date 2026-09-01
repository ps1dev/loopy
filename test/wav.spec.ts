/*
 * Unit tests for the parts that have a right answer: the RIFF reader/writer.
 */
import { describe, it, expect } from 'vitest';

import * as Wav from '../src/core/wav.js';

/* ---- fixtures ---------------------------------------------------------- */

function tag(u8: Uint8Array, off: number, s: string) { for (let i = 0; i < 4; i++) u8[off + i] = s.charCodeAt(i); }

/*
 * Build a 16-bit PCM WAV by hand. `opts.loops` adds a smpl chunk;
 * `opts.extraChunk` adds an unrecognised chunk so the writer's
 * copy-everything-through behaviour has something to fail on.
 */
function makeWav(opts: {
  rate?: number;
  channels?: number;
  frames?: number;
  loops?: { start: number; end: number; type?: number; id?: number; playCount?: number }[] | null;
  extraChunk?: { id: string; data: Uint8Array } | null;
} = {}) {
  const rate = opts.rate || 44100;
  const ch = opts.channels || 1;
  const frames = opts.frames || 100;
  const loops = opts.loops || null;
  const extra = opts.extraChunk || null;

  const dataBytes = frames * ch * 2;
  const extraBytes = extra ? 8 + extra.data.length + (extra.data.length & 1) : 0;
  const smplBytes = loops ? 8 + 36 + loops.length * 24 : 0;
  const total = 12 + 24 + extraBytes + smplBytes + 8 + dataBytes;

  const buf = new ArrayBuffer(total);
  const u = new Uint8Array(buf);
  const v = new DataView(buf);

  tag(u, 0, 'RIFF'); v.setUint32(4, total - 8, true); tag(u, 8, 'WAVE');
  tag(u, 12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 2, true);
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);

  let o = 36;
  if (extra) {
    tag(u, o, extra.id); v.setUint32(o + 4, extra.data.length, true);
    u.set(extra.data, o + 8);
    o += 8 + extra.data.length + (extra.data.length & 1);
  }
  if (loops) {
    tag(u, o, 'smpl'); v.setUint32(o + 4, 36 + loops.length * 24, true);
    const b = o + 8;
    v.setUint32(b + 0, 0x41414141, true);      // manufacturer, distinctive
    v.setUint32(b + 4, 0x42424242, true);      // product
    v.setUint32(b + 8, Math.round(1e9 / rate), true);
    v.setUint32(b + 12, 60, true);             // unity note
    v.setUint32(b + 16, 0, true);
    v.setUint32(b + 20, 0, true);
    v.setUint32(b + 24, 0, true);
    v.setUint32(b + 28, loops.length, true);
    v.setUint32(b + 32, 0, true);
    loops.forEach((L, i) => {
      const p = b + 36 + i * 24;
      v.setUint32(p + 0, L.id ?? i, true);
      v.setUint32(p + 4, L.type ?? 0, true);
      v.setUint32(p + 8, L.start, true);
      v.setUint32(p + 12, L.end, true);
      v.setUint32(p + 16, 0, true);
      v.setUint32(p + 20, L.playCount ?? 0, true);
    });
    o += 8 + 36 + loops.length * 24;
  }

  tag(u, o, 'data'); v.setUint32(o + 4, dataBytes, true);
  const dataOff = o + 8;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < ch; c++) {
      // A recognisable pattern so a byte-for-byte comparison means something.
      v.setInt16(dataOff + (f * ch + c) * 2, ((f * 37 + c * 11) % 32000) - 16000, true);
    }
  }
  return { buffer: buf, dataOff, dataBytes };
}

function chunkNames(parsed: ReturnType<typeof Wav.parseWav>) { return parsed.chunks.map(c => c.id); }

function dataBytesOf(buffer: ArrayBuffer) {
  const chunks = Wav.parseChunks(buffer);
  const d = chunks.find(c => c.id === 'data')!;
  return new Uint8Array(buffer, d.offset, d.size);
}

/* ---- WAV reading ------------------------------------------------------- */

describe('WAV reading', () => {
  it('reads fmt and data from a minimal WAV', () => {
    const { buffer } = makeWav({ rate: 22050, channels: 2, frames: 64 });
    const p = Wav.parseWav(buffer);
    expect(p.sampleRate).toBe(22050);
    expect(p.channels.length).toBe(2);
    expect(p.frames).toBe(64);
    expect(p.fmt.bitsPerSample).toBe(16);
  });

  it('a WAV with no smpl chunk parses with smpl === null', () => {
    // Negative control for the test below: if this returned a smpl object,
    // the positive result would mean nothing.
    const { buffer } = makeWav({});
    const p = Wav.parseWav(buffer);
    expect(p.smpl).toBe(null);
  });

  it('reads loop points out of a smpl chunk, dwEnd inclusive', () => {
    const { buffer } = makeWav({ loops: [{ start: 28, end: 83, type: 0 }] });
    const p = Wav.parseWav(buffer);
    expect(p.smpl, 'expected a smpl chunk').toBeTruthy();
    expect(p.smpl!.loops.length).toBe(1);
    expect(p.smpl!.loops[0].start).toBe(28);
    expect(p.smpl!.loops[0].end).toBe(83);
    expect(p.smpl!.midiUnityNote).toBe(60);
    expect(p.smpl!.manufacturer).toBe(0x41414141);
  });

  it('reads several loops with distinct types', () => {
    const { buffer } = makeWav({
      loops: [
        { start: 0, end: 27, type: 0 },
        { start: 28, end: 55, type: 1 },
        { start: 56, end: 83, type: 2 }
      ]
    });
    const p = Wav.parseWav(buffer);
    expect(p.smpl!.loops.length).toBe(3);
    expect(p.smpl!.loops.map(l => l.type)).toEqual([0, 1, 2]);
    expect(p.smpl!.loops.map(l => l.start)).toEqual([0, 28, 56]);
  });

  it('a lying cSampleLoops count is clamped to the chunk size', () => {
    const { buffer } = makeWav({ loops: [{ start: 4, end: 8 }] });
    // Rewrite the count to 99 without growing the chunk.
    const chunks = Wav.parseChunks(buffer);
    const smpl = chunks.find(c => c.id === 'smpl')!;
    new DataView(buffer).setUint32(smpl.offset + 28, 99, true);
    const p = Wav.parseWav(buffer);
    expect(p.smpl!.loops.length).toBe(1);
  });

  it('rejects a non-RIFF file with a useful message', () => {
    const buf = new ArrayBuffer(64);
    new Uint8Array(buf).set([0x4f, 0x67, 0x67, 0x53]);  // 'OggS'
    expect(() => Wav.parseWav(buf)).toThrow(/not a RIFF file/);
  });
});

/* ---- WAV writing ------------------------------------------------------- */

describe('WAV writing', () => {
  it('injects a smpl chunk into a WAV that had none', () => {
    const { buffer } = makeWav({ frames: 200 });
    const p = Wav.parseWav(buffer);
    const out = Wav.writeWavWithSmpl(p, [{ start: 28, end: 139, type: 0 }]);
    const q = Wav.parseWav(out);
    expect(q.smpl).toBeTruthy();
    expect(q.smpl!.loops.length).toBe(1);
    expect(q.smpl!.loops[0].start).toBe(28);
    expect(q.smpl!.loops[0].end).toBe(139);
    expect(q.smpl!.loops[0].type).toBe(0);
  });

  it('sample data survives a round trip byte for byte', () => {
    const { buffer } = makeWav({ channels: 2, frames: 333 });
    const p = Wav.parseWav(buffer);
    const out = Wav.writeWavWithSmpl(p, [{ start: 0, end: 100 }]);
    expect(
      Array.from(dataBytesOf(out)),
      'data chunk bytes changed during export'
    ).toEqual(Array.from(dataBytesOf(buffer)));
  });

  it('an unrecognised chunk is copied through', () => {
    const extra = { id: 'cue ', data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) };
    const { buffer } = makeWav({ extraChunk: extra });
    const p = Wav.parseWav(buffer);
    expect(chunkNames(p).includes('cue ')).toBe(true);
    const out = Wav.writeWavWithSmpl(p, [{ start: 1, end: 9 }]);
    const q = Wav.parseWav(out);
    expect(chunkNames(q).includes('cue '), 'cue chunk was dropped on export').toBe(true);
    const c = q.chunks.find(x => x.id === 'cue ')!;
    expect(Array.from(new Uint8Array(out, c.offset, c.size))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('an odd-sized chunk keeps its pad byte and does not shift later chunks', () => {
    const extra = { id: 'LIST', data: new Uint8Array([9, 9, 9]) };   // 3 bytes, odd
    const { buffer } = makeWav({ extraChunk: extra, frames: 50 });
    const p = Wav.parseWav(buffer);
    const out = Wav.writeWavWithSmpl(p, [{ start: 2, end: 20 }]);
    const q = Wav.parseWav(out);
    expect(q.frames).toBe(50);
    expect(Array.from(dataBytesOf(out))).toEqual(Array.from(dataBytesOf(buffer)));
  });

  it('an existing smpl chunk is replaced, not duplicated', () => {
    const { buffer } = makeWav({ loops: [{ start: 1, end: 2 }] });
    const p = Wav.parseWav(buffer);
    const out = Wav.writeWavWithSmpl(p, [{ start: 28, end: 55 }, { start: 56, end: 83 }]);
    const q = Wav.parseWav(out);
    expect(chunkNames(q).filter(n => n === 'smpl').length).toBe(1);
    expect(q.smpl!.loops.length).toBe(2);
    expect(q.smpl!.loops[0].start).toBe(28);
  });

  it('exporting with no loops removes the smpl chunk entirely', () => {
    const { buffer } = makeWav({ loops: [{ start: 1, end: 2 }] });
    const p = Wav.parseWav(buffer);
    const out = Wav.writeWavWithSmpl(p, []);
    const q = Wav.parseWav(out);
    expect(q.smpl).toBe(null);
    expect(chunkNames(q).includes('smpl')).toBe(false);
  });

  it('the new smpl chunk is written immediately after fmt', () => {
    // Not cosmetic: psxavenc's chunk walk does not skip the RIFF pad byte after
    // an odd-sized chunk, so anything odd ahead of smpl hides the loop point
    // from it. fmt is a fixed even size, so sitting right after it is safe.
    const extra = { id: 'note', data: new Uint8Array(19) };   // odd on purpose
    const { buffer } = makeWav({ extraChunk: extra });
    const p = Wav.parseWav(buffer);
    expect(chunkNames(p), 'fixture layout changed').toEqual(['fmt ', 'note', 'data']);
    const out = Wav.writeWavWithSmpl(p, [{ start: 0, end: 27 }]);
    expect(chunkNames(Wav.parseWav(out))).toEqual(['fmt ', 'smpl', 'note', 'data']);
  });

  it('the RIFF size field matches the real file length after export', () => {
    const { buffer } = makeWav({ extraChunk: { id: 'fact', data: new Uint8Array([0, 0, 0, 7]) } });
    const p = Wav.parseWav(buffer);
    const out = Wav.writeWavWithSmpl(p, [{ start: 0, end: 27 }]);
    expect(new DataView(out).getUint32(4, true)).toBe(out.byteLength - 8);
  });

  it('encodeWav16 produces a readable WAV carrying its loops', () => {
    const ch = [new Float32Array(64), new Float32Array(64)];
    for (let i = 0; i < 64; i++) { ch[0][i] = Math.sin(i); ch[1][i] = -Math.sin(i); }
    const out = Wav.encodeWav16(ch, 32000, [{ start: 4, end: 59, type: 1 }]);
    const p = Wav.parseWav(out);
    expect(p.sampleRate).toBe(32000);
    expect(p.channels.length).toBe(2);
    expect(p.frames).toBe(64);
    expect(p.smpl!.loops[0].start).toBe(4);
    expect(p.smpl!.loops[0].end).toBe(59);
    expect(p.smpl!.loops[0].type).toBe(1);
  });

  it('smpl samplePeriod is derived from the sample rate in nanoseconds', () => {
    const out = Wav.encodeWav16([new Float32Array(8)], 44100, [{ start: 0, end: 7 }]);
    const p = Wav.parseWav(out);
    expect(p.smpl!.samplePeriod).toBe(Math.round(1e9 / 44100));   // 22676
  });
});
