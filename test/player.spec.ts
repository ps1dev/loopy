/*
 * Unit tests for the playback loop.
 *
 * The player tests use a RAMP source (sample N holds the value N), so the
 * rendered output is a literal transcript of which sample indices were read.
 * That is the oracle - a loop bug shows up as the wrong integers, not as a
 * vague "sounds wrong".
 */
import { describe, it, expect } from 'vitest';

import { PlayerCore, LOOP_FORWARD, LOOP_ALTERNATING, LOOP_BACKWARD } from '../src/core/player-core.js';

/* ---- the playback loop ------------------------------------------------- */

/* Source where sample N holds value N, so output reads back as sample indices. */
function ramp(frames: number) {
  const a = new Float32Array(frames);
  for (let i = 0; i < frames; i++) a[i] = i;
  return [a];
}

function renderIndices(core: PlayerCore, n: number) {
  const out = [new Float32Array(n)];
  core.render(out, n);
  return Array.from(out[0]).map(v => Math.round(v));
}

describe('the playback loop', () => {
  it('with no loop, playback runs to the end and reports ending once', () => {
    const core = new PlayerCore();
    core.setSource(ramp(10), 44100);
    core.outputRate = 44100;
    let ended = 0;
    core.onEnded = () => { ended++; };
    core.play(0);
    const got = renderIndices(core, 16);
    expect(got.slice(0, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ended).toBe(1);
    expect(core.playing).toBe(false);
    expect(got.slice(10), 'tail after the end should be silent').toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('a forward loop replays start..end inclusive', () => {
    const core = new PlayerCore();
    core.setSource(ramp(20), 44100);
    core.outputRate = 44100;
    core.loopEnabled = true;
    core.loopStart = 4;
    core.loopEnd = 7;               // inclusive: four samples, 4 5 6 7
    core.loopType = LOOP_FORWARD;
    core.play(0);
    expect(renderIndices(core, 16)).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7, 4, 5, 6, 7, 4, 5, 6, 7]);
  });

  it('the forward loop end is inclusive, not exclusive', () => {
    // The whole point: an exclusive reading would give 4 5 6 4 5 6 and never
    // play sample 7. This test fails loudly if the convention slips.
    const core = new PlayerCore();
    core.setSource(ramp(20), 44100);
    core.outputRate = 44100;
    core.loopEnabled = true;
    core.loopStart = 4; core.loopEnd = 7;
    core.play(4);
    const got = renderIndices(core, 8);
    expect(got.includes(7), 'sample at dwEnd must be played').toBe(true);
    expect(got).toEqual([4, 5, 6, 7, 4, 5, 6, 7]);
  });

  it('an alternating loop ping-pongs without repeating either endpoint', () => {
    const core = new PlayerCore();
    core.setSource(ramp(20), 44100);
    core.outputRate = 44100;
    core.loopEnabled = true;
    core.loopStart = 4; core.loopEnd = 7;
    core.loopType = LOOP_ALTERNATING;
    core.play(4);
    expect(renderIndices(core, 12)).toEqual(
      [4, 5, 6, 7, 6, 5, 4, 5, 6, 7, 6, 5]);
  });

  it('an alternating loop never reads outside the loop region', () => {
    const core = new PlayerCore();
    core.setSource(ramp(20), 44100);
    core.outputRate = 44100;
    core.loopEnabled = true;
    core.loopStart = 4; core.loopEnd = 7;
    core.loopType = LOOP_ALTERNATING;
    core.play(4);
    const got = renderIndices(core, 200);
    const bad = got.filter(v => v < 4 || v > 7);
    expect(bad, 'ping-pong read outside start..end').toEqual([]);
  });

  it('a backward loop plays end..start and jumps back to the end', () => {
    const core = new PlayerCore();
    core.setSource(ramp(20), 44100);
    core.outputRate = 44100;
    core.loopEnabled = true;
    core.loopStart = 4; core.loopEnd = 7;
    core.loopType = LOOP_BACKWARD;
    core.play(7);
    expect(renderIndices(core, 12)).toEqual(
      [7, 6, 5, 4, 7, 6, 5, 4, 7, 6, 5, 4]);
  });

  it('reconcile pulls a playhead sitting outside the loop back into it', () => {
    const core = new PlayerCore();
    core.setSource(ramp(20), 44100);
    core.outputRate = 44100;
    core.play(15);
    core.loopEnabled = true;
    core.loopStart = 4; core.loopEnd = 7;
    core.reconcile();
    expect(core.position).toBe(4);
  });

  it('reconcile leaves a playhead already inside the loop alone', () => {
    const core = new PlayerCore();
    core.setSource(ramp(20), 44100);
    core.outputRate = 44100;
    core.play(6);
    core.loopEnabled = true;
    core.loopStart = 4; core.loopEnd = 7;
    core.reconcile();
    expect(core.position).toBe(6);
  });

  it('a one-sample-long loop region is refused rather than freezing playback', () => {
    const core = new PlayerCore();
    core.setSource(ramp(20), 44100);
    core.outputRate = 44100;
    core.loopEnabled = true;
    core.loopStart = 5; core.loopEnd = 5;   // length 1
    expect(core.loopActive).toBe(false);
    core.play(0);
    const got = renderIndices(core, 8);
    expect(got, 'should play straight through').toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('a rate mismatch resamples but keeps the loop inside its bounds', () => {
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
    expect(min >= 10 - 1e-3, 'read below the loop start: ' + min).toBe(true);
    expect(max <= 30 + 1e-3, 'read past the loop end: ' + max).toBe(true);
  });

  it('mono sources are copied to every output channel', () => {
    const core = new PlayerCore();
    core.setSource(ramp(16), 44100);
    core.outputRate = 44100;
    core.play(0);
    const out = [new Float32Array(8), new Float32Array(8)];
    core.render(out, 8);
    expect(Array.from(out[0])).toEqual(Array.from(out[1]));
  });

  it('the metronome fires once per grid division and accents the bar', () => {
    const core = new PlayerCore();
    core.setSource(ramp(4000), 44100);
    core.outputRate = 44100;
    core.metronome = true;
    core.segments = [{ sample: 0, beat: 0, spb: 500, beatsPerBar: 4 }];
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
    expect(onsets,
      'expected one click just after each of the beats at 500/1000/1500').toEqual([501, 1001, 1501]);
  });

  it('the metronome has no subdivision input to be affected by', () => {
    // The grid's divisions control must not reach the click. Rather than assert
    // that setting it changes nothing - which passes just as well if the wiring
    // is merely broken today - check the coupling cannot exist: the player has
    // no subdivision field, and ticks are driven only by samplesPerBeat.
    const core = new PlayerCore();
    expect('subdivision' in core, 'PlayerCore regained a subdivision field').toBe(false);
    core.setSource(ramp(4000), 44100);
    core.outputRate = 44100;
    core.metronome = true;
    core.segments = [{ sample: 0, beat: 0, spb: 1000, beatsPerBar: 4 }];
    core.gain = 0;
    core.play(0);
    const out = [new Float32Array(3500)];
    core.render(out, 3500);
    const onsets = [];
    for (let i = 1; i < 3500; i++) if (out[0][i] !== 0 && out[0][i - 1] === 0) onsets.push(i);
    expect(onsets, 'clicks should land on beats only').toEqual([1001, 2001, 3001]);
  });

  it('the metronome stays silent when it is switched off', () => {
    const core = new PlayerCore();
    core.setSource(ramp(4000), 44100);
    core.outputRate = 44100;
    core.metronome = false;
    core.segments = [{ sample: 0, beat: 0, spb: 500, beatsPerBar: 4 }];
    core.gain = 0;
    core.play(0);
    const out = [new Float32Array(2000)];
    core.render(out, 2000);
    expect(out[0].every(v => v === 0), 'metronome produced sound while disabled').toBe(true);
  });

  /* From the variable-tempo section: a metronome case, so it lives here. */
  it('the metronome clicks at the new rate after a tempo change', () => {
    const core = new PlayerCore();
    core.setSource(ramp(6000), 44100);
    core.outputRate = 44100;
    core.metronome = true;
    core.gain = 0;
    // 1000 samples/beat until sample 3000, then 500.
    core.segments = [
      { sample: 0, beat: 0, spb: 1000, beatsPerBar: 4 },
      { sample: 3000, beat: 3, spb: 500, beatsPerBar: 4 }
    ];
    core.play(0);
    const out = [new Float32Array(6000)];
    core.render(out, 6000);
    const onsets = [];
    for (let i = 1; i < 6000; i++) if (out[0][i] !== 0 && out[0][i - 1] === 0) onsets.push(i);
    expect(onsets,
      'clicks should be 1000 apart then 500 apart').toEqual([1001, 2001, 3001, 3501, 4001, 4501, 5001, 5501]);
  });
});
