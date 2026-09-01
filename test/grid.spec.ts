/*
 * Unit tests for the beat grid: alignment, snapping, tap tempo and the
 * variable-tempo map.
 */
import { describe, it, expect } from 'vitest';

import { BeatGrid, TapTempo, alignSample, snapSample } from '../src/core/grid.js';

/* ---- alignment and snapping -------------------------------------------- */

describe('alignment and snapping', () => {
  it('alignSample rounds to the requested multiple', () => {
    expect(alignSample(0, 28)).toBe(0);
    expect(alignSample(13, 28)).toBe(0);
    expect(alignSample(15, 28)).toBe(28);
    expect(alignSample(41, 28, 'floor')).toBe(28);
    expect(alignSample(29, 28, 'ceil')).toBe(56);
    expect(alignSample(1234, 1)).toBe(1234);   // quantum 1 is a no-op
  });

  it('snapSample applies the grid first and alignment last', () => {
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
    expect(r.sample).toBe(22064);
    expect(r.sample % 28).toBe(0);
    expect(r.offGrid).toBe(14);
  });

  it('snapSample with alignment off lands exactly on the beat', () => {
    const g = new BeatGrid(44100);
    g.bpm = 120; g.enabled = true;
    const r = snapSample(21000, { grid: g, snapToGrid: true, alignEnabled: false, maxSample: 1e9 });
    expect(r.sample).toBe(22050);
  });

  it('snapSample clamps to the file and keeps the clamp aligned', () => {
    const r = snapSample(999999, {
      grid: null, snapToGrid: false, alignEnabled: true, alignQuantum: 28, maxSample: 1000
    });
    expect(r.sample <= 1000).toBe(true);
    expect(r.sample % 28).toBe(0);
  });

  it('BeatGrid.linesIn marks bars and beats correctly', () => {
    const g = new BeatGrid(1000);
    g.bpm = 60;            // 1000 samples per beat
    g.subdivision = 2;     // a line every 500 samples
    g.beatsPerBar = 4;
    const lines = g.linesIn(0, 4000, 1000);
    expect(lines[0].sample).toBe(0);
    expect(lines[0].isBar).toBe(true);
    expect(lines[1].sample).toBe(500);
    expect(lines[1].isBeat).toBe(false);
    expect(lines[2].sample).toBe(1000);
    expect(lines[2].isBeat).toBe(true);
    expect(lines[2].isBar).toBe(false);
    expect(lines[8].sample).toBe(4000);
    expect(lines[8].isBar).toBe(true);
  });

  it('TapTempo needs two taps and then reports a tempo', () => {
    const t = new TapTempo();
    expect(t.tap(0)).toBe(null);
    const r = t.tap(500);
    expect(Math.abs(r!.bpm - 120) < 1e-6).toBe(true);
    const r2 = t.tap(1000);
    expect(Math.abs(r2!.bpm - 120) < 1e-6).toBe(true);
    expect(r2!.taps).toBe(3);
  });

  it('TapTempo starts a new run after a long gap', () => {
    const t = new TapTempo({ resetAfterMs: 1000 });
    t.tap(0); t.tap(500);
    expect(t.tap(9000), 'a gap longer than the reset should start over').toBe(null);
  });
});

/* ---- variable tempo ----------------------------------------------------- */

describe('variable tempo', () => {
  it('a single-entry tempo map behaves exactly like a fixed grid', () => {
    const g = new BeatGrid(44100);
    g.bpm = 120; g.beatsPerBar = 4;
    expect(g.hasTempoChanges).toBe(false);
    expect(g.samplesPerBeatAt(0)).toBe(22050);
    expect(g.sampleOfBar(1)).toBe(0);
    expect(g.sampleOfBar(2)).toBe(88200);
    expect(g.beatAtSample(22050)).toBe(1);
  });

  it('tempo changes are keyed to bars and take effect there', () => {
    // Naoki's case: 115 BPM for bars 1-5, 128 from bar 6.
    const g = new BeatGrid(44100);
    g.setTempos([{ bar: 1, bpm: 115, beatsPerBar: 4 }, { bar: 6, bpm: 128, beatsPerBar: 4 }]);
    expect(g.hasTempoChanges).toBe(true);

    const spb115 = 44100 * 60 / 115;
    const spb128 = 44100 * 60 / 128;
    const bar6 = 5 * 4 * spb115;              // five bars of four beats at 115

    expect(Math.abs(g.sampleOfBar(6) - bar6) < 1e-6, 'bar 6 position').toBe(true);
    expect(Math.abs(g.samplesPerBeatAt(bar6 - 1) - spb115) < 1e-9, 'just before the change').toBe(true);
    expect(Math.abs(g.samplesPerBeatAt(bar6 + 1) - spb128) < 1e-9, 'just after the change').toBe(true);
    expect(g.bpmAt(0)).toBe(115);
    expect(g.bpmAt(bar6 + 1)).toBe(128);
    // Bar 7 is one 128-bar past bar 6, not one 115-bar.
    expect(Math.abs(g.sampleOfBar(7) - (bar6 + 4 * spb128)) < 1e-6, 'bar 7 uses the new tempo').toBe(true);
  });

  it('bar/beat is derived from the absolute position, not integrated', () => {
    // The trap spicyjpeg named: accumulating the current BPM per step drifts.
    // A piecewise-linear lookup from a segment anchor cannot, so asking for a
    // position far into the song must be exact, not approximately right.
    const g = new BeatGrid(48000);
    g.setTempos([
      { bar: 1, bpm: 115, beatsPerBar: 4 },
      { bar: 6, bpm: 128, beatsPerBar: 4 },
      { bar: 200, bpm: 90, beatsPerBar: 4 }
    ]);
    for (const bar of [1, 2, 6, 7, 50, 199, 200, 201, 4000]) {
      const s = g.sampleOfBar(bar);
      expect(Math.abs(g.barAt(s) - bar) < 1e-9,
        'round trip failed at bar ' + bar + ': got ' + g.barAt(s)).toBe(true);
    }
  });

  it('the grid line spacing changes at the tempo change', () => {
    const g = new BeatGrid(44100);
    g.enabled = true;
    g.setTempos([{ bar: 1, bpm: 60, beatsPerBar: 4 }, { bar: 3, bpm: 120, beatsPerBar: 4 }]);
    // 60 BPM = 44100 samples/beat; 120 BPM = 22050. Bar 3 starts at beat 8.
    const change = 8 * 44100;
    const lines = g.linesIn(0, change + 44100 * 2, 10000).map(l => l.sample);
    expect(lines.includes(0) && lines.includes(44100), 'beats before the change').toBe(true);
    expect(lines.includes(change), 'a line exactly at the change').toBe(true);
    expect(lines.includes(change + 22050), 'the beat after the change is half as far').toBe(true);
    expect(!lines.includes(change + 44100 * 0.5 + 1), 'no stray lines').toBe(true);
    // No duplicates at the seam - the segment either side must not both emit it.
    expect(new Set(lines).size, 'duplicate line at a segment boundary').toBe(lines.length);
  });

  it('bars after a tempo change are numbered continuously', () => {
    const g = new BeatGrid(44100);
    g.setTempos([{ bar: 1, bpm: 60, beatsPerBar: 4 }, { bar: 3, bpm: 120, beatsPerBar: 4 }]);
    const bars = g.barsIn(0, g.sampleOfBar(6), 100);
    // Bar 1 sits at sample 0, which is inside the requested range, so it is
    // included - the first version of this expectation left it out and the code
    // was right. What matters is that numbering runs 1..6 continuously rather
    // than restarting at the tempo change in bar 3.
    expect(bars.map(b => b.bar), 'bar numbers must not restart').toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('positionLabel reports the right bar across a change', () => {
    const g = new BeatGrid(44100);
    g.setTempos([{ bar: 1, bpm: 115, beatsPerBar: 4 }, { bar: 6, bpm: 128, beatsPerBar: 4 }]);
    expect(g.positionLabel(g.sampleOfBar(1))).toMatch(/^1\.1\./);
    expect(g.positionLabel(g.sampleOfBar(6))).toMatch(/^6\.1\./);
    expect(g.positionLabel(g.sampleOfBar(9))).toMatch(/^9\.1\./);
  });

  it('the map is kept sorted and always starts at bar 1', () => {
    const g = new BeatGrid(44100);
    g.setTempos([{ bar: 12, bpm: 90 }, { bar: 4, bpm: 150 }, { bar: 7, bpm: 100 }]);
    const t = g.tempos;
    expect(t[0].bar, 'the earliest entry must cover from bar 1').toBe(1);
    expect(t.map(x => x.bar)).toEqual([1, 7, 12]);
    expect(t[0].bpm, 'the earliest entry keeps its tempo').toBe(150);
  });

  it('removing a change cannot remove the starting tempo', () => {
    const g = new BeatGrid(44100);
    g.setTempos([{ bar: 1, bpm: 115 }, { bar: 6, bpm: 128 }]);
    g.removeTempoAt(0);
    expect(g.tempos.length, 'entry 0 must survive').toBe(2);
    g.removeTempoAt(1);
    expect(g.tempos.length).toBe(1);
    expect(g.tempos[0].bpm).toBe(115);
  });

  it('beatsBetween integrates across a tempo change', () => {
    const g = new BeatGrid(44100);
    g.setTempos([{ bar: 1, bpm: 60, beatsPerBar: 4 }, { bar: 3, bpm: 120, beatsPerBar: 4 }]);
    // Bar 1 to bar 5 is 16 beats regardless of tempo; a naive
    // (samples / samplesPerBeat) would give a different, wrong number.
    const beats = g.beatsBetween(g.sampleOfBar(1), g.sampleOfBar(5));
    expect(Math.abs(beats - 16) < 1e-9, 'got ' + beats).toBe(true);
  });

  it('nearestLine picks the closer side of a tempo change', () => {
    const g = new BeatGrid(44100);
    g.enabled = true;
    g.setTempos([{ bar: 1, bpm: 60, beatsPerBar: 4 }, { bar: 3, bpm: 120, beatsPerBar: 4 }]);
    const change = 8 * 44100;
    // Lines are 44100 apart before and 22050 after, so a point just past the
    // change is nearer the following line than the preceding one.
    expect(g.nearestLine(change + 12000)).toBe(change + 22050);
    expect(g.nearestLine(change + 3000)).toBe(change);
    expect(g.nearestLine(change - 3000)).toBe(change);
  });
});
