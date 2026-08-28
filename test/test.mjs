/*
 * Unit tests for the parts that have a right answer: the RIFF reader/writer
 * and the playback loop. Run with `node --test test/` from the project root.
 *
 * The player tests use a RAMP source (sample N holds the value N), so the
 * rendered output is a literal transcript of which sample indices were read.
 * That is the oracle - a loop bug shows up as the wrong integers, not as a
 * vague "sounds wrong".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as Wav from '../js/wav.js';
import { BeatGrid, TapTempo, alignSample, snapSample } from '../js/grid.js';
import { PlayerCore, LOOP_FORWARD, LOOP_ALTERNATING, LOOP_BACKWARD } from '../js/player-core.js';

/* ---- fixtures ---------------------------------------------------------- */

function tag(u8, off, s) { for (let i = 0; i < 4; i++) u8[off + i] = s.charCodeAt(i); }

/*
 * Build a 16-bit PCM WAV by hand. `opts.loops` adds a smpl chunk;
 * `opts.extraChunk` adds an unrecognised chunk so the writer's
 * copy-everything-through behaviour has something to fail on.
 */
function makeWav(opts = {}) {
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

function chunkNames(parsed) { return parsed.chunks.map(c => c.id); }

function dataBytesOf(buffer) {
  const chunks = Wav.parseChunks(buffer);
  const d = chunks.find(c => c.id === 'data');
  return new Uint8Array(buffer, d.offset, d.size);
}

/* ---- WAV reading ------------------------------------------------------- */

test('reads fmt and data from a minimal WAV', () => {
  const { buffer } = makeWav({ rate: 22050, channels: 2, frames: 64 });
  const p = Wav.parseWav(buffer);
  assert.equal(p.sampleRate, 22050);
  assert.equal(p.channels.length, 2);
  assert.equal(p.frames, 64);
  assert.equal(p.fmt.bitsPerSample, 16);
});

test('a WAV with no smpl chunk parses with smpl === null', () => {
  // Negative control for the test below: if this returned a smpl object,
  // the positive result would mean nothing.
  const { buffer } = makeWav({});
  const p = Wav.parseWav(buffer);
  assert.equal(p.smpl, null);
});

test('reads loop points out of a smpl chunk, dwEnd inclusive', () => {
  const { buffer } = makeWav({ loops: [{ start: 28, end: 83, type: 0 }] });
  const p = Wav.parseWav(buffer);
  assert.ok(p.smpl, 'expected a smpl chunk');
  assert.equal(p.smpl.loops.length, 1);
  assert.equal(p.smpl.loops[0].start, 28);
  assert.equal(p.smpl.loops[0].end, 83);
  assert.equal(p.smpl.midiUnityNote, 60);
  assert.equal(p.smpl.manufacturer, 0x41414141);
});

test('reads several loops with distinct types', () => {
  const { buffer } = makeWav({
    loops: [
      { start: 0, end: 27, type: 0 },
      { start: 28, end: 55, type: 1 },
      { start: 56, end: 83, type: 2 }
    ]
  });
  const p = Wav.parseWav(buffer);
  assert.equal(p.smpl.loops.length, 3);
  assert.deepEqual(p.smpl.loops.map(l => l.type), [0, 1, 2]);
  assert.deepEqual(p.smpl.loops.map(l => l.start), [0, 28, 56]);
});

test('a lying cSampleLoops count is clamped to the chunk size', () => {
  const { buffer } = makeWav({ loops: [{ start: 4, end: 8 }] });
  // Rewrite the count to 99 without growing the chunk.
  const chunks = Wav.parseChunks(buffer);
  const smpl = chunks.find(c => c.id === 'smpl');
  new DataView(buffer).setUint32(smpl.offset + 28, 99, true);
  const p = Wav.parseWav(buffer);
  assert.equal(p.smpl.loops.length, 1);
});

test('rejects a non-RIFF file with a useful message', () => {
  const buf = new ArrayBuffer(64);
  new Uint8Array(buf).set([0x4f, 0x67, 0x67, 0x53]);  // 'OggS'
  assert.throws(() => Wav.parseWav(buf), /not a RIFF file/);
});

/* ---- WAV writing ------------------------------------------------------- */

test('injects a smpl chunk into a WAV that had none', () => {
  const { buffer } = makeWav({ frames: 200 });
  const p = Wav.parseWav(buffer);
  const out = Wav.writeWavWithSmpl(p, [{ start: 28, end: 139, type: 0 }]);
  const q = Wav.parseWav(out);
  assert.ok(q.smpl);
  assert.equal(q.smpl.loops.length, 1);
  assert.equal(q.smpl.loops[0].start, 28);
  assert.equal(q.smpl.loops[0].end, 139);
  assert.equal(q.smpl.loops[0].type, 0);
});

test('sample data survives a round trip byte for byte', () => {
  const { buffer } = makeWav({ channels: 2, frames: 333 });
  const p = Wav.parseWav(buffer);
  const out = Wav.writeWavWithSmpl(p, [{ start: 0, end: 100 }]);
  assert.deepEqual(
    Array.from(dataBytesOf(out)),
    Array.from(dataBytesOf(buffer)),
    'data chunk bytes changed during export'
  );
});

test('an unrecognised chunk is copied through', () => {
  const extra = { id: 'cue ', data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) };
  const { buffer } = makeWav({ extraChunk: extra });
  const p = Wav.parseWav(buffer);
  assert.ok(chunkNames(p).includes('cue '));
  const out = Wav.writeWavWithSmpl(p, [{ start: 1, end: 9 }]);
  const q = Wav.parseWav(out);
  assert.ok(chunkNames(q).includes('cue '), 'cue chunk was dropped on export');
  const c = q.chunks.find(x => x.id === 'cue ');
  assert.deepEqual(Array.from(new Uint8Array(out, c.offset, c.size)), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('an odd-sized chunk keeps its pad byte and does not shift later chunks', () => {
  const extra = { id: 'LIST', data: new Uint8Array([9, 9, 9]) };   // 3 bytes, odd
  const { buffer } = makeWav({ extraChunk: extra, frames: 50 });
  const p = Wav.parseWav(buffer);
  const out = Wav.writeWavWithSmpl(p, [{ start: 2, end: 20 }]);
  const q = Wav.parseWav(out);
  assert.equal(q.frames, 50);
  assert.deepEqual(Array.from(dataBytesOf(out)), Array.from(dataBytesOf(buffer)));
});

test('an existing smpl chunk is replaced, not duplicated', () => {
  const { buffer } = makeWav({ loops: [{ start: 1, end: 2 }] });
  const p = Wav.parseWav(buffer);
  const out = Wav.writeWavWithSmpl(p, [{ start: 28, end: 55 }, { start: 56, end: 83 }]);
  const q = Wav.parseWav(out);
  assert.equal(chunkNames(q).filter(n => n === 'smpl').length, 1);
  assert.equal(q.smpl.loops.length, 2);
  assert.equal(q.smpl.loops[0].start, 28);
});

test('exporting with no loops removes the smpl chunk entirely', () => {
  const { buffer } = makeWav({ loops: [{ start: 1, end: 2 }] });
  const p = Wav.parseWav(buffer);
  const out = Wav.writeWavWithSmpl(p, []);
  const q = Wav.parseWav(out);
  assert.equal(q.smpl, null);
  assert.ok(!chunkNames(q).includes('smpl'));
});

test('the new smpl chunk is written immediately after fmt', () => {
  // Not cosmetic: psxavenc's chunk walk does not skip the RIFF pad byte after
  // an odd-sized chunk, so anything odd ahead of smpl hides the loop point
  // from it. fmt is a fixed even size, so sitting right after it is safe.
  const extra = { id: 'note', data: new Uint8Array(19) };   // odd on purpose
  const { buffer } = makeWav({ extraChunk: extra });
  const p = Wav.parseWav(buffer);
  assert.deepEqual(chunkNames(p), ['fmt ', 'note', 'data'], 'fixture layout changed');
  const out = Wav.writeWavWithSmpl(p, [{ start: 0, end: 27 }]);
  assert.deepEqual(chunkNames(Wav.parseWav(out)), ['fmt ', 'smpl', 'note', 'data']);
});

test('the RIFF size field matches the real file length after export', () => {
  const { buffer } = makeWav({ extraChunk: { id: 'fact', data: new Uint8Array([0, 0, 0, 7]) } });
  const p = Wav.parseWav(buffer);
  const out = Wav.writeWavWithSmpl(p, [{ start: 0, end: 27 }]);
  assert.equal(new DataView(out).getUint32(4, true), out.byteLength - 8);
});

test('encodeWav16 produces a readable WAV carrying its loops', () => {
  const ch = [new Float32Array(64), new Float32Array(64)];
  for (let i = 0; i < 64; i++) { ch[0][i] = Math.sin(i); ch[1][i] = -Math.sin(i); }
  const out = Wav.encodeWav16(ch, 32000, [{ start: 4, end: 59, type: 1 }]);
  const p = Wav.parseWav(out);
  assert.equal(p.sampleRate, 32000);
  assert.equal(p.channels.length, 2);
  assert.equal(p.frames, 64);
  assert.equal(p.smpl.loops[0].start, 4);
  assert.equal(p.smpl.loops[0].end, 59);
  assert.equal(p.smpl.loops[0].type, 1);
});

test('smpl samplePeriod is derived from the sample rate in nanoseconds', () => {
  const out = Wav.encodeWav16([new Float32Array(8)], 44100, [{ start: 0, end: 7 }]);
  const p = Wav.parseWav(out);
  assert.equal(p.smpl.samplePeriod, Math.round(1e9 / 44100));   // 22676
});

/* ---- alignment and snapping -------------------------------------------- */

test('alignSample rounds to the requested multiple', () => {
  assert.equal(alignSample(0, 28), 0);
  assert.equal(alignSample(13, 28), 0);
  assert.equal(alignSample(15, 28), 28);
  assert.equal(alignSample(41, 28, 'floor'), 28);
  assert.equal(alignSample(29, 28, 'ceil'), 56);
  assert.equal(alignSample(1234, 1), 1234);   // quantum 1 is a no-op
});

test('snapSample applies the grid first and alignment last', () => {
  const g = new BeatGrid(44100);
  g.bpm = 120;             // 22050 samples per beat
  g.enabled = true;
  g.offset = 0;
  const r = snapSample(21000, {
    grid: g, snapToGrid: true, alignEnabled: true, alignQuantum: 28, maxSample: 1e9
  });
  // Nearest beat is 22050. 22050 / 28 is exactly 787.5, an exact tie, and
  // Math.round breaks ties upward: 788 * 28 = 22064. The 14-sample overshoot
  // is what `offGrid` exists to report, rather than the UI claiming the point
  // is on the beat when it is not.
  assert.equal(r.sample, 22064);
  assert.equal(r.sample % 28, 0);
  assert.equal(r.offGrid, 14);
});

test('snapSample with alignment off lands exactly on the beat', () => {
  const g = new BeatGrid(44100);
  g.bpm = 120; g.enabled = true;
  const r = snapSample(21000, { grid: g, snapToGrid: true, alignEnabled: false, maxSample: 1e9 });
  assert.equal(r.sample, 22050);
});

test('snapSample clamps to the file and keeps the clamp aligned', () => {
  const r = snapSample(999999, {
    grid: null, snapToGrid: false, alignEnabled: true, alignQuantum: 28, maxSample: 1000
  });
  assert.ok(r.sample <= 1000);
  assert.equal(r.sample % 28, 0);
});

test('BeatGrid.linesIn marks bars and beats correctly', () => {
  const g = new BeatGrid(1000);
  g.bpm = 60;            // 1000 samples per beat
  g.subdivision = 2;     // a line every 500 samples
  g.beatsPerBar = 4;
  const lines = g.linesIn(0, 4000, 1000);
  assert.equal(lines[0].sample, 0);
  assert.equal(lines[0].isBar, true);
  assert.equal(lines[1].sample, 500);
  assert.equal(lines[1].isBeat, false);
  assert.equal(lines[2].sample, 1000);
  assert.equal(lines[2].isBeat, true);
  assert.equal(lines[2].isBar, false);
  assert.equal(lines[8].sample, 4000);
  assert.equal(lines[8].isBar, true);
});

test('TapTempo needs two taps and then reports a tempo', () => {
  const t = new TapTempo();
  assert.equal(t.tap(0), null);
  const r = t.tap(500);
  assert.ok(Math.abs(r.bpm - 120) < 1e-6);
  const r2 = t.tap(1000);
  assert.ok(Math.abs(r2.bpm - 120) < 1e-6);
  assert.equal(r2.taps, 3);
});

test('TapTempo starts a new run after a long gap', () => {
  const t = new TapTempo({ resetAfterMs: 1000 });
  t.tap(0); t.tap(500);
  assert.equal(t.tap(9000), null, 'a gap longer than the reset should start over');
});

/* ---- the playback loop ------------------------------------------------- */

/* Source where sample N holds value N, so output reads back as sample indices. */
function ramp(frames) {
  const a = new Float32Array(frames);
  for (let i = 0; i < frames; i++) a[i] = i;
  return [a];
}

function renderIndices(core, n) {
  const out = [new Float32Array(n)];
  core.render(out, n);
  return Array.from(out[0]).map(v => Math.round(v));
}

test('with no loop, playback runs to the end and reports ending once', () => {
  const core = new PlayerCore();
  core.setSource(ramp(10), 44100);
  core.outputRate = 44100;
  let ended = 0;
  core.onEnded = () => { ended++; };
  core.play(0);
  const got = renderIndices(core, 16);
  assert.deepEqual(got.slice(0, 10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(ended, 1);
  assert.equal(core.playing, false);
  assert.deepEqual(got.slice(10), [0, 0, 0, 0, 0, 0], 'tail after the end should be silent');
});

test('a forward loop replays start..end inclusive', () => {
  const core = new PlayerCore();
  core.setSource(ramp(20), 44100);
  core.outputRate = 44100;
  core.loopEnabled = true;
  core.loopStart = 4;
  core.loopEnd = 7;               // inclusive: four samples, 4 5 6 7
  core.loopType = LOOP_FORWARD;
  core.play(0);
  assert.deepEqual(renderIndices(core, 16),
    [0, 1, 2, 3, 4, 5, 6, 7, 4, 5, 6, 7, 4, 5, 6, 7]);
});

test('the forward loop end is inclusive, not exclusive', () => {
  // The whole point: an exclusive reading would give 4 5 6 4 5 6 and never
  // play sample 7. This test fails loudly if the convention slips.
  const core = new PlayerCore();
  core.setSource(ramp(20), 44100);
  core.outputRate = 44100;
  core.loopEnabled = true;
  core.loopStart = 4; core.loopEnd = 7;
  core.play(4);
  const got = renderIndices(core, 8);
  assert.ok(got.includes(7), 'sample at dwEnd must be played');
  assert.deepEqual(got, [4, 5, 6, 7, 4, 5, 6, 7]);
});

test('an alternating loop ping-pongs without repeating either endpoint', () => {
  const core = new PlayerCore();
  core.setSource(ramp(20), 44100);
  core.outputRate = 44100;
  core.loopEnabled = true;
  core.loopStart = 4; core.loopEnd = 7;
  core.loopType = LOOP_ALTERNATING;
  core.play(4);
  assert.deepEqual(renderIndices(core, 12),
    [4, 5, 6, 7, 6, 5, 4, 5, 6, 7, 6, 5]);
});

test('an alternating loop never reads outside the loop region', () => {
  const core = new PlayerCore();
  core.setSource(ramp(20), 44100);
  core.outputRate = 44100;
  core.loopEnabled = true;
  core.loopStart = 4; core.loopEnd = 7;
  core.loopType = LOOP_ALTERNATING;
  core.play(4);
  const got = renderIndices(core, 200);
  const bad = got.filter(v => v < 4 || v > 7);
  assert.deepEqual(bad, [], 'ping-pong read outside start..end');
});

test('a backward loop plays end..start and jumps back to the end', () => {
  const core = new PlayerCore();
  core.setSource(ramp(20), 44100);
  core.outputRate = 44100;
  core.loopEnabled = true;
  core.loopStart = 4; core.loopEnd = 7;
  core.loopType = LOOP_BACKWARD;
  core.play(7);
  assert.deepEqual(renderIndices(core, 12),
    [7, 6, 5, 4, 7, 6, 5, 4, 7, 6, 5, 4]);
});

test('reconcile pulls a playhead sitting outside the loop back into it', () => {
  const core = new PlayerCore();
  core.setSource(ramp(20), 44100);
  core.outputRate = 44100;
  core.play(15);
  core.loopEnabled = true;
  core.loopStart = 4; core.loopEnd = 7;
  core.reconcile();
  assert.equal(core.position, 4);
});

test('reconcile leaves a playhead already inside the loop alone', () => {
  const core = new PlayerCore();
  core.setSource(ramp(20), 44100);
  core.outputRate = 44100;
  core.play(6);
  core.loopEnabled = true;
  core.loopStart = 4; core.loopEnd = 7;
  core.reconcile();
  assert.equal(core.position, 6);
});

test('a one-sample-long loop region is refused rather than freezing playback', () => {
  const core = new PlayerCore();
  core.setSource(ramp(20), 44100);
  core.outputRate = 44100;
  core.loopEnabled = true;
  core.loopStart = 5; core.loopEnd = 5;   // length 1
  assert.equal(core.loopActive, false);
  core.play(0);
  const got = renderIndices(core, 8);
  assert.deepEqual(got, [0, 1, 2, 3, 4, 5, 6, 7], 'should play straight through');
});

test('a rate mismatch resamples but keeps the loop inside its bounds', () => {
  const core = new PlayerCore();
  core.setSource(ramp(100), 44100);
  core.outputRate = 48000;                 // step ~0.919
  core.loopEnabled = true;
  core.loopStart = 10; core.loopEnd = 29;
  core.play(10);
  const out = [new Float32Array(500)];
  core.render(out, 500);
  let min = Infinity, max = -Infinity;
  for (const v of out[0]) { if (v < min) min = v; if (v > max) max = v; }
  assert.ok(min >= 10 - 1e-3, 'read below the loop start: ' + min);
  assert.ok(max <= 30 + 1e-3, 'read past the loop end: ' + max);
});

test('mono sources are copied to every output channel', () => {
  const core = new PlayerCore();
  core.setSource(ramp(16), 44100);
  core.outputRate = 44100;
  core.play(0);
  const out = [new Float32Array(8), new Float32Array(8)];
  core.render(out, 8);
  assert.deepEqual(Array.from(out[0]), Array.from(out[1]));
});

test('the metronome fires once per grid division and accents the bar', () => {
  const core = new PlayerCore();
  core.setSource(ramp(4000), 44100);
  core.outputRate = 44100;
  core.metronome = true;
  core.gridOffset = 0;
  core.samplesPerDivision = 500;
  core.subdivision = 1;
  core.beatsPerBar = 4;
  core.gain = 0;                   // isolate the click from the source
  core.play(0);
  const out = [new Float32Array(2000)];
  core.render(out, 2000);

  // Click onsets: the sample right after each division boundary is non-zero
  // while the sample just before it has decayed away.
  const onsets = [];
  for (let i = 1; i < 2000; i++) {
    if (out[0][i] !== 0 && out[0][i - 1] === 0) onsets.push(i);
  }
  assert.deepEqual(onsets, [501, 1001, 1501],
    'expected one click just after each of the divisions at 500/1000/1500');
});

test('the metronome stays silent when it is switched off', () => {
  const core = new PlayerCore();
  core.setSource(ramp(4000), 44100);
  core.outputRate = 44100;
  core.metronome = false;
  core.samplesPerDivision = 500;
  core.gain = 0;
  core.play(0);
  const out = [new Float32Array(2000)];
  core.render(out, 2000);
  assert.ok(out[0].every(v => v === 0), 'metronome produced sound while disabled');
});
