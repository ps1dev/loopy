/*
 * Beat grid, snapping and sample alignment. Pure functions over sample
 * indices - no DOM, no audio. Everything here works in SAMPLE FRAMES at the
 * file's own rate; seconds only appear at the edges.
 *
 * The grid carries a TEMPO MAP rather than a single BPM: a list of changes,
 * each stating the bar it takes effect at, its tempo, and its meter. A song
 * that runs 115 BPM for five bars and 128 from bar 6 is two entries. A
 * constant-tempo song is one entry and behaves exactly as a fixed grid does.
 *
 * Changes are keyed to BARS, not beats or samples, because that is where a
 * tempo change is actually placed in a DAW and it is what a person says: "bar
 * 6 is 128". Keying them to samples would make every change move when an
 * earlier tempo is edited.
 *
 * Everything else is derived from a segment table rebuilt whenever the map
 * changes: each segment knows the bar, beat and SAMPLE it starts at, so
 * position lookups are a small search plus one multiply instead of a walk
 * from the beginning of the song.
 */

function gcd(a, b) { while (b) { var t = a % b; a = b; b = t; } return a; }

export class BeatGrid {
  constructor(sampleRate) {
    this.sampleRate = sampleRate || 44100;
    this._offset = 0;       // sample index of bar 1 beat 1
    this.subdivision = 1;   // grid lines per beat (1 = beats, 4 = 16ths)
    this.enabled = false;
    // Tempo map, always non-empty and always starting at bar 1.
    this._tempos = [{ bar: 1, bpm: 120, beatsPerBar: 4 }];
    this._rebuild();
  }

  /* A plain field here would leave the segment table stale, since every
   * segment's sample position is measured from the offset. Callers assign
   * grid.offset directly, so it has to rebuild itself. */
  get offset() { return this._offset; }
  set offset(v) { this._offset = v || 0; this._rebuild(); }

  /* ---- tempo map -------------------------------------------------------- */

  get tempos() { return this._tempos.slice(); }

  /* Convenience for the common single-tempo case: reading gives the first
   * segment's tempo, writing replaces it without disturbing later changes. */
  get bpm() { return this._tempos[0].bpm; }
  set bpm(v) { if (v > 0) { this._tempos[0].bpm = v; this._rebuild(); } }

  get beatsPerBar() { return this._tempos[0].beatsPerBar; }
  set beatsPerBar(v) {
    if (!(v > 0)) return;
    // Setting the meter with no explicit per-change meter set applies to all,
    // which is what a single "beats/bar" control should mean.
    for (var i = 0; i < this._tempos.length; i++) this._tempos[i].beatsPerBar = v;
    this._rebuild();
  }

  /* True when there is more than one tempo, i.e. the grid is non-uniform.
   * Callers that assume a constant beat length should check this. */
  get hasTempoChanges() { return this._tempos.length > 1; }

  setTempos(list) {
    var out = [];
    for (var i = 0; i < (list || []).length; i++) {
      var t = list[i];
      var bar = Math.max(1, Math.round(t.bar || 1));
      var bpm = Number(t.bpm);
      if (!(bpm > 0)) continue;
      out.push({ bar: bar, bpm: bpm, beatsPerBar: Math.max(1, Math.round(t.beatsPerBar || 4)) });
    }
    if (!out.length) out = [{ bar: 1, bpm: 120, beatsPerBar: 4 }];
    out.sort(function (a, b) { return a.bar - b.bar; });
    // Two changes at the same bar is not meaningful; the later one wins.
    var dedup = [];
    for (var j = 0; j < out.length; j++) {
      if (dedup.length && dedup[dedup.length - 1].bar === out[j].bar) dedup[dedup.length - 1] = out[j];
      else dedup.push(out[j]);
    }
    dedup[0].bar = 1;      // the map must cover from the start of the song
    this._tempos = dedup;
    this._rebuild();
    return this._tempos.slice();
  }

  addTempo(bar, bpm, beatsPerBar) {
    var list = this.tempos;
    list.push({ bar: bar, bpm: bpm, beatsPerBar: beatsPerBar || this._tempos[0].beatsPerBar });
    return this.setTempos(list);
  }

  removeTempoAt(index) {
    if (index <= 0 || index >= this._tempos.length) return this._tempos.slice();
    var list = this.tempos;
    list.splice(index, 1);
    return this.setTempos(list);
  }

  setSampleRate(rate) {
    // Keep the grid where it is in TIME, not in sample index, when the rate
    // changes under us (a new file loaded at a different rate).
    if (rate && this.sampleRate && rate !== this.sampleRate) {
      this._offset = Math.round(this._offset * rate / this.sampleRate);
    }
    this.sampleRate = rate;
    this._rebuild();
  }

  /*
   * Segment table. Each entry is the start of a constant-tempo stretch and
   * carries its absolute bar, beat and sample so lookups do not have to
   * accumulate from bar 1 every time.
   */
  _rebuild() {
    var segs = [];
    var beat = 0, sample = this._offset;
    for (var i = 0; i < this._tempos.length; i++) {
      var t = this._tempos[i];
      var spb = this.sampleRate * 60 / t.bpm;
      segs.push({
        bar: t.bar, beat: beat, sample: sample,
        bpm: t.bpm, beatsPerBar: t.beatsPerBar, spb: spb
      });
      var next = this._tempos[i + 1];
      if (next) {
        var bars = next.bar - t.bar;
        var beats = bars * t.beatsPerBar;
        beat += beats;
        sample += beats * spb;
      }
    }
    this._segs = segs;
  }

  /* The segment governing a given sample / beat / bar. Linear scan from the
   * end: tempo maps are short (a handful of entries), so a binary search
   * would cost more in code than it saves. */
  _segAtSample(s) {
    var g = this._segs;
    for (var i = g.length - 1; i > 0; i--) if (s >= g[i].sample) return g[i];
    return g[0];
  }
  _segAtBeat(b) {
    var g = this._segs;
    for (var i = g.length - 1; i > 0; i--) if (b >= g[i].beat) return g[i];
    return g[0];
  }
  _segAtBar(bar) {
    var g = this._segs;
    for (var i = g.length - 1; i > 0; i--) if (bar >= g[i].bar) return g[i];
    return g[0];
  }

  /* Samples per beat AT a position. There is no single answer for the whole
   * song once the map has more than one entry, which is why the old constant
   * property is gone rather than quietly returning the first tempo. */
  samplesPerBeatAt(sample) { return this._segAtSample(sample).spb; }
  samplesPerBarAt(sample) {
    var s = this._segAtSample(sample);
    return s.spb * s.beatsPerBar;
  }
  beatsPerBarAt(sample) { return this._segAtSample(sample).beatsPerBar; }
  bpmAt(sample) { return this._segAtSample(sample).bpm; }

  /* ---- position conversion ---------------------------------------------- */

  beatAtSample(sample) {
    var s = this._segAtSample(sample);
    return s.beat + (sample - s.sample) / s.spb;
  }

  sampleOfBeat(beat) {
    var s = this._segAtBeat(beat);
    return s.sample + (beat - s.beat) * s.spb;
  }

  barAt(sample) {
    var s = this._segAtSample(sample);
    var beatsIn = (sample - s.sample) / s.spb;
    return s.bar + beatsIn / s.beatsPerBar;
  }

  sampleOfBar(bar) {
    var s = this._segAtBar(bar);
    return s.sample + (bar - s.bar) * s.beatsPerBar * s.spb;
  }

  /* Start of the bar containing `sample`, as an integer sample index. */
  barStartAt(sample) {
    return Math.round(this.sampleOfBar(Math.floor(this.barAt(sample) + 1e-9)));
  }

  get samplesPerDivisionAt() { return null; }   // deliberately absent; see below

  divisionsPerBeat() { return Math.max(1, this.subdivision); }

  /* Nearest grid line to `sample`, as an integer sample index. Works across a
   * tempo change: the two candidate lines can be different distances apart on
   * either side, so both are computed and compared rather than rounding a
   * division index. */
  nearestLine(sample) {
    var sub = this.divisionsPerBeat();
    var b = this.beatAtSample(sample) * sub;
    var lo = this.sampleOfBeat(Math.floor(b) / sub);
    var hi = this.sampleOfBeat(Math.ceil(b) / sub);
    return Math.round((sample - lo) <= (hi - sample) ? lo : hi);
  }

  /*
   * Every grid line in [from, to]. Walks the segment table, so line spacing
   * changes at each tempo change exactly where it should.
   */
  linesIn(from, to, limit) {
    var out = [];
    var sub = this.divisionsPerBeat();
    var g = this._segs;
    if (!g.length) return out;

    // Rough count first, so a zoomed-out view bails before generating.
    var approx = 0;
    for (var q = 0; q < g.length; q++) {
      var segStart = g[q].sample;
      var segEnd = (q + 1 < g.length) ? g[q + 1].sample : Infinity;
      var a = Math.max(from, segStart), b = Math.min(to, segEnd);
      if (b > a) approx += (b - a) / (g[q].spb / sub);
    }
    if (limit && approx > limit) return out;

    for (var i = 0; i < g.length; i++) {
      var seg = g[i];
      var start = seg.sample;
      var end = (i + 1 < g.length) ? g[i + 1].sample : Infinity;
      var lo = Math.max(from, start);
      var hi = Math.min(to, end);
      if (hi < lo) continue;

      var step = seg.spb / sub;
      var firstDiv = Math.ceil((lo - start) / step - 1e-9);
      var perBar = sub * seg.beatsPerBar;
      for (var n = firstDiv; ; n++) {
        var pos = start + n * step;
        if (pos > hi + 1e-6) break;
        if (pos >= end - 1e-6 && i + 1 < g.length) break;  // next segment owns it
        var absDiv = Math.round((seg.beat * sub) + n);
        var isBeat = (((n % sub) + sub) % sub) === 0;
        out.push({
          sample: Math.round(pos),
          division: absDiv,
          isBeat: isBeat,
          isBar: isBeat && ((((n % perBar) + perBar) % perBar) === 0)
        });
      }
    }
    return out;
  }

  /* Every bar line in [from, to] as {sample, bar}, bar 1-based. */
  barsIn(from, to, limit) {
    var out = [];
    var g = this._segs;
    for (var i = 0; i < g.length; i++) {
      var seg = g[i];
      var start = seg.sample;
      var end = (i + 1 < g.length) ? g[i + 1].sample : Infinity;
      var lo = Math.max(from, start), hi = Math.min(to, end);
      if (hi < lo) continue;
      var step = seg.spb * seg.beatsPerBar;
      var first = Math.ceil((lo - start) / step - 1e-9);
      for (var n = first; ; n++) {
        var pos = start + n * step;
        if (pos > hi + 1e-6) break;
        if (pos >= end - 1e-6 && i + 1 < g.length) break;
        out.push({ sample: Math.round(pos), bar: seg.bar + n });
        if (limit && out.length > limit) return [];
      }
    }
    return out;
  }

  /* "bar.beat.tick" readout, 1-based like a DAW. */
  positionLabel(sample) {
    var seg = this._segAtSample(sample);
    var beatsIn = (sample - seg.sample) / seg.spb;
    var bpb = Math.max(1, seg.beatsPerBar);
    var barsIn = Math.floor(beatsIn / bpb);
    var bar = seg.bar + barsIn;
    var inBar = beatsIn - barsIn * bpb;
    var b = Math.floor(inBar);
    var tick = Math.round((inBar - b) * 960);
    if (tick >= 960) { tick -= 960; b += 1; }
    if (b >= bpb) { b -= bpb; bar += 1; }
    return bar + '.' + (b + 1) + '.' + String(tick).padStart(3, '0');
  }

  /* Beats between two sample positions, integrating across tempo changes.
   * A plain (b - a) / samplesPerBeat is wrong the moment the map has two
   * entries, and wrong quietly - it just reports the wrong number. */
  beatsBetween(a, b) {
    return this.beatAtSample(b) - this.beatAtSample(a);
  }

  /* The segment table, for the audio engine's metronome. Plain data. */
  segments() {
    return this._segs.map(function (s) {
      return { sample: s.sample, beat: s.beat, spb: s.spb, beatsPerBar: s.beatsPerBar };
    });
  }
}

/*
 * Tap tempo. Averages the intervals of a run of taps and drops the run when
 * the gap gets long enough that it is obviously a new attempt.
 */
export class TapTempo {
  constructor(opts) {
    opts = opts || {};
    this.resetAfterMs = opts.resetAfterMs || 2500;
    this.maxTaps = opts.maxTaps || 16;
    this.times = [];
  }

  reset() { this.times = []; }

  tap(now) {
    var n = this.times.length;
    if (n && (now - this.times[n - 1]) > this.resetAfterMs) this.times = [];
    this.times.push(now);
    if (this.times.length > this.maxTaps) this.times.shift();
    if (this.times.length < 2) return null;

    // Mean interval over the retained run. Simple and stable; a median would
    // reject a single fumbled tap better but reacts badly to a deliberate
    // tempo change mid-run, which is the commoner case here.
    var span = this.times[this.times.length - 1] - this.times[0];
    var intervals = this.times.length - 1;
    return { bpm: 60000 * intervals / span, taps: this.times.length };
  }
}

/*
 * The smallest sample count that is BOTH a whole number of ADPCM blocks and a
 * whole number of milliseconds at `rate`.
 *
 * Why anyone would want that: psxavenc converts a `smpl` loop start to
 * milliseconds internally (decoding.c, `round(pts * 1000.0)`) and back to a
 * block index with an integer divide, so a loop point that is not a whole
 * number of milliseconds can come out one 28-sample block early. Measured
 * 2026-08-28 against psxavenc 4658cb96: all six tested multiples of 1764 at
 * 44100 Hz survived exactly, four of five non-multiples came back one block
 * early. Being a multiple is sufficient, not necessary - a non-multiple can
 * still land right by luck (28 did) - so this is the safe choice, not the
 * only working one.
 */
export function psxavencSafeQuantum(rate, blockSize) {
  var block = blockSize || 28;
  if (!rate) return block;
  var msStride = rate / gcd(rate, 1000);   // samples per whole millisecond
  return block * msStride / gcd(block, msStride);
}

/*
 * Round `sample` to a multiple of `quantum`. mode: 'nearest', 'floor', 'ceil'.
 * This is what enforces the PS1 SPU's 28-sample ADPCM block granularity.
 */
export function alignSample(sample, quantum, mode) {
  if (!quantum || quantum < 2) return Math.round(sample);
  var q = Math.round(quantum);
  var n = sample / q;
  if (mode === 'floor') n = Math.floor(n);
  else if (mode === 'ceil') n = Math.ceil(n);
  else n = Math.round(n);
  return n * q;
}

/*
 * The full snap pipeline for a dragged loop point.
 *
 * Order matters and is deliberate: grid snap first, sample alignment second.
 * Alignment is a hard constraint of the target hardware and grid snap is a
 * convenience, so alignment gets the last word - which means a snapped point
 * can sit up to quantum/2 samples off the beat. `offGrid` reports that
 * distance so the UI can say so rather than quietly lying about it.
 */
export function snapSample(sample, opts) {
  var grid = opts.grid;
  var out = Math.round(sample);
  var snappedToGrid = false;

  if (opts.snapToGrid && grid && grid.enabled) {
    out = grid.nearestLine(out);
    snappedToGrid = true;
  }
  if (opts.alignQuantum && opts.alignEnabled) {
    out = alignSample(out, opts.alignQuantum, opts.alignMode);
  }
  if (out < 0) out = opts.alignEnabled ? alignSample(0, opts.alignQuantum, 'ceil') : 0;
  if (opts.maxSample !== undefined && out > opts.maxSample) {
    out = opts.alignEnabled
      ? alignSample(opts.maxSample, opts.alignQuantum, 'floor')
      : opts.maxSample;
  }

  var offGrid = 0;
  if (snappedToGrid) offGrid = out - grid.nearestLine(out);
  return { sample: out, offGrid: offGrid };
}
