/*
 * Beat grid, snapping and sample alignment. Pure functions over sample
 * indices - no DOM, no audio. Everything here works in SAMPLE FRAMES at the
 * file's own rate; seconds only appear at the edges.
 */

export class BeatGrid {
  constructor(sampleRate) {
    this.sampleRate = sampleRate || 44100;
    this.bpm = 120;
    this.offset = 0;        // sample index of beat 0
    this.subdivision = 1;   // grid lines per beat (1 = beats, 4 = 16ths)
    this.beatsPerBar = 4;
    this.enabled = false;
  }

  setSampleRate(rate) {
    // Keep the grid where it is in TIME, not in sample index, when the rate
    // changes under us (a new file loaded at a different rate).
    if (rate && this.sampleRate && rate !== this.sampleRate) {
      this.offset = Math.round(this.offset * rate / this.sampleRate);
    }
    this.sampleRate = rate;
  }

  /* Samples per beat. Fractional on purpose: rounding here accumulates drift
   * across a long file, which is exactly the error a beat grid exists to
   * expose. Rounding happens once, at the point a line is drawn or snapped to. */
  get samplesPerBeat() {
    return this.sampleRate * 60 / this.bpm;
  }

  get samplesPerDivision() {
    return this.samplesPerBeat / Math.max(1, this.subdivision);
  }

  /* Fractional division index at a sample position. */
  divisionAt(sample) {
    return (sample - this.offset) / this.samplesPerDivision;
  }

  /* Sample position of a (possibly negative) division index. */
  sampleOfDivision(n) {
    return this.offset + n * this.samplesPerDivision;
  }

  /* Nearest grid line to `sample`, as an integer sample index. */
  nearestLine(sample) {
    return Math.round(this.sampleOfDivision(Math.round(this.divisionAt(sample))));
  }

  /*
   * Every grid line in [from, to], as {sample, division, isBeat, isBar}.
   * Bounded by `limit` so a zoomed-out view cannot ask for a million lines.
   */
  linesIn(from, to, limit) {
    var out = [];
    var spd = this.samplesPerDivision;
    if (!(spd > 0)) return out;
    var first = Math.ceil(this.divisionAt(from));
    var last = Math.floor(this.divisionAt(to));
    if (last < first) return out;
    if (limit && (last - first + 1) > limit) return out; // too dense to be useful
    var sub = Math.max(1, this.subdivision);
    var perBar = sub * Math.max(1, this.beatsPerBar);
    for (var n = first; n <= last; n++) {
      var isBeat = (((n % sub) + sub) % sub) === 0;
      out.push({
        sample: Math.round(this.sampleOfDivision(n)),
        division: n,
        isBeat: isBeat,
        isBar: isBeat && ((((n % perBar) + perBar) % perBar) === 0)
      });
    }
    return out;
  }

  get samplesPerBar() {
    return this.samplesPerBeat * Math.max(1, this.beatsPerBar);
  }

  /* Fractional bar index at a sample position. 0-based internally; the UI
   * adds one, because DAWs count bars from 1 and users say "bar 5". */
  barAt(sample) {
    return (sample - this.offset) / this.samplesPerBar;
  }

  sampleOfBar(n) {
    return this.offset + n * this.samplesPerBar;
  }

  /* Start of the bar containing `sample`, as an integer sample index. Used by
   * the bar ruler: clicking "bar 5" means the start of bar 5, not the nearest
   * grid line to where the pixel happened to fall. */
  barStartAt(sample) {
    return Math.round(this.sampleOfBar(Math.floor(this.barAt(sample) + 1e-9)));
  }

  /* Every bar line in [from, to] as {sample, bar} with bar 1-based.
   * `limit` guards a zoomed-out view from asking for thousands. */
  barsIn(from, to, limit) {
    var out = [];
    var spb = this.samplesPerBar;
    if (!(spb > 0)) return out;
    var first = Math.ceil(this.barAt(from));
    var last = Math.floor(this.barAt(to));
    if (last < first) return out;
    if (limit && (last - first + 1) > limit) return out;
    for (var n = first; n <= last; n++) {
      out.push({ sample: Math.round(this.sampleOfBar(n)), bar: n + 1 });
    }
    return out;
  }

  /* "bar.beat.tick" readout for a sample position, 1-based like a DAW. */
  positionLabel(sample) {
    var beat = (sample - this.offset) / this.samplesPerBeat;
    var bpb = Math.max(1, this.beatsPerBar);
    var bar = Math.floor(beat / bpb);
    var inBar = beat - bar * bpb;
    var b = Math.floor(inBar);
    var tick = Math.round((inBar - b) * 960);
    if (tick >= 960) { tick -= 960; b += 1; }
    return (bar + 1) + '.' + (b + 1) + '.' + String(tick).padStart(3, '0');
  }
}

/*
 * Tap tempo. Averages the intervals of a run of taps and drops the run when
 * the gap gets long enough that it is obviously a new attempt.
 *
 * Returns null until there are two taps, then a {bpm, taps} estimate.
 */
export class TapTempo {
  constructor(opts) {
    opts = opts || {};
    this.resetAfterMs = opts.resetAfterMs || 2500;
    this.maxTaps = opts.maxTaps || 16;
    this.times = [];
  }

  reset() { this.times = []; }

  /* `now` in milliseconds (performance.now()). */
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
    var bpm = 60000 * intervals / span;
    return { bpm: bpm, taps: this.times.length };
  }
}

/*
 * Round `sample` to a multiple of `quantum`, biased so the result stays a
 * legal loop point. mode:
 *   'nearest' (default), 'floor', 'ceil'
 *
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

function gcd(a, b) { while (b) { var t = a % b; a = b; b = t; } return a; }

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
 *
 * 44100 -> 1764 (40 ms), 22050 -> 1764 (80 ms), 48000 -> 336 (7 ms).
 */
export function psxavencSafeQuantum(rate, blockSize) {
  var block = blockSize || 28;
  if (!rate) return block;
  var msStride = rate / gcd(rate, 1000);   // samples per whole millisecond
  return block * msStride / gcd(block, msStride);
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
