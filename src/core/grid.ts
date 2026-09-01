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

/** One tempo-map entry as the grid stores and hands it back. */
export interface TempoChange {
  bar: number;
  bpm: number;
  beatsPerBar: number;
}

/** A tempo-map entry on its way IN: every field is defaulted or dropped. */
export interface TempoChangeInput {
  bar?: number;
  bpm?: number;
  beatsPerBar?: number;
}

/** A row of the internal segment table: the start of a constant-tempo stretch. */
interface TempoSegment {
  bar: number;
  beat: number;
  sample: number;
  bpm: number;
  beatsPerBar: number;
  spb: number;
}

/** A constant-tempo stretch as plain data, for the audio engine's metronome. */
export interface MetronomeSegment {
  sample: number;
  beat: number;
  spb: number;
  beatsPerBar: number;
}

/** One grid line: its sample, its absolute division index, and what it lands on. */
export interface GridLine {
  sample: number;
  division: number;
  isBeat: boolean;
  isBar: boolean;
}

/** One bar line: its sample and its 1-based bar number. */
export interface BarLine {
  sample: number;
  bar: number;
}

/** How `alignSample` breaks a position that is not already on the quantum. */
export type AlignMode = 'nearest' | 'floor' | 'ceil';

/** Options bag for `TapTempo`. */
export interface TapTempoOptions {
  resetAfterMs?: number;
  maxTaps?: number;
}

/** What a tap reports once there are at least two of them. */
export interface TapResult {
  bpm: number;
  taps: number;
}

/** Options bag for `snapSample`: the grid, the two toggles and the bounds. */
export interface SnapOptions {
  grid?: BeatGrid | null;
  snapToGrid?: boolean;
  alignEnabled?: boolean;
  alignQuantum?: number;
  alignMode?: AlignMode;
  maxSample?: number;
}

/** A snapped point and how far the alignment pushed it off the grid line. */
export interface SnapResult {
  sample: number;
  offGrid: number;
}

function gcd(a: number, b: number): number { while (b) { const t = a % b; a = b; b = t; } return a; }

export class BeatGrid {
  public sampleRate: number;
  private _offset: number;
  public subdivision: number;
  public enabled: boolean;
  private _tempos: TempoChange[];
  private _segs!: TempoSegment[];

  constructor(sampleRate?: number) {
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
  get offset(): number { return this._offset; }
  set offset(v: number) { this._offset = v || 0; this._rebuild(); }

  /* ---- tempo map -------------------------------------------------------- */

  get tempos(): TempoChange[] { return this._tempos.slice(); }

  /* Convenience for the common single-tempo case: reading gives the first
   * segment's tempo, writing replaces it without disturbing later changes. */
  get bpm(): number { return this._tempos[0].bpm; }
  set bpm(v: number) { if (v > 0) { this._tempos[0].bpm = v; this._rebuild(); } }

  get beatsPerBar(): number { return this._tempos[0].beatsPerBar; }
  set beatsPerBar(v: number) {
    if (!(v > 0)) return;
    // Setting the meter with no explicit per-change meter set applies to all,
    // which is what a single "beats/bar" control should mean.
    for (let i = 0; i < this._tempos.length; i++) this._tempos[i].beatsPerBar = v;
    this._rebuild();
  }

  /* True when there is more than one tempo, i.e. the grid is non-uniform.
   * Callers that assume a constant beat length should check this. */
  get hasTempoChanges(): boolean { return this._tempos.length > 1; }

  setTempos(list: TempoChangeInput[] | null | undefined): TempoChange[] {
    let out: TempoChange[] = [];
    for (let i = 0; i < (list || []).length; i++) {
      const t = list![i];
      const bar = Math.max(1, Math.round(t.bar || 1));
      const bpm = Number(t.bpm);
      if (!(bpm > 0)) continue;
      out.push({ bar: bar, bpm: bpm, beatsPerBar: Math.max(1, Math.round(t.beatsPerBar || 4)) });
    }
    if (!out.length) out = [{ bar: 1, bpm: 120, beatsPerBar: 4 }];
    out.sort(function (a, b) { return a.bar - b.bar; });
    // Two changes at the same bar is not meaningful; the later one wins.
    const dedup: TempoChange[] = [];
    for (let j = 0; j < out.length; j++) {
      if (dedup.length && dedup[dedup.length - 1].bar === out[j].bar) dedup[dedup.length - 1] = out[j];
      else dedup.push(out[j]);
    }
    dedup[0].bar = 1;      // the map must cover from the start of the song
    this._tempos = dedup;
    this._rebuild();
    return this._tempos.slice();
  }

  addTempo(bar: number, bpm: number, beatsPerBar?: number): TempoChange[] {
    const list = this.tempos;
    list.push({ bar: bar, bpm: bpm, beatsPerBar: beatsPerBar || this._tempos[0].beatsPerBar });
    return this.setTempos(list);
  }

  removeTempoAt(index: number): TempoChange[] {
    if (index <= 0 || index >= this._tempos.length) return this._tempos.slice();
    const list = this.tempos;
    list.splice(index, 1);
    return this.setTempos(list);
  }

  setSampleRate(rate: number): void {
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
  private _rebuild(): void {
    const segs: TempoSegment[] = [];
    let beat = 0, sample = this._offset;
    for (let i = 0; i < this._tempos.length; i++) {
      const t = this._tempos[i];
      const spb = this.sampleRate * 60 / t.bpm;
      segs.push({
        bar: t.bar, beat: beat, sample: sample,
        bpm: t.bpm, beatsPerBar: t.beatsPerBar, spb: spb
      });
      const next = this._tempos[i + 1];
      if (next) {
        const bars = next.bar - t.bar;
        const beats = bars * t.beatsPerBar;
        beat += beats;
        sample += beats * spb;
      }
    }
    this._segs = segs;
  }

  /* The segment governing a given sample / beat / bar. Linear scan from the
   * end: tempo maps are short (a handful of entries), so a binary search
   * would cost more in code than it saves. */
  private _segAtSample(s: number): TempoSegment {
    const g = this._segs;
    for (let i = g.length - 1; i > 0; i--) if (s >= g[i].sample) return g[i];
    return g[0];
  }
  private _segAtBeat(b: number): TempoSegment {
    const g = this._segs;
    for (let i = g.length - 1; i > 0; i--) if (b >= g[i].beat) return g[i];
    return g[0];
  }
  private _segAtBar(bar: number): TempoSegment {
    const g = this._segs;
    for (let i = g.length - 1; i > 0; i--) if (bar >= g[i].bar) return g[i];
    return g[0];
  }

  /* Samples per beat AT a position. There is no single answer for the whole
   * song once the map has more than one entry, which is why the old constant
   * property is gone rather than quietly returning the first tempo. */
  samplesPerBeatAt(sample: number): number { return this._segAtSample(sample).spb; }
  samplesPerBarAt(sample: number): number {
    const s = this._segAtSample(sample);
    return s.spb * s.beatsPerBar;
  }
  beatsPerBarAt(sample: number): number { return this._segAtSample(sample).beatsPerBar; }
  bpmAt(sample: number): number { return this._segAtSample(sample).bpm; }

  /* ---- position conversion ---------------------------------------------- */

  beatAtSample(sample: number): number {
    const s = this._segAtSample(sample);
    return s.beat + (sample - s.sample) / s.spb;
  }

  sampleOfBeat(beat: number): number {
    const s = this._segAtBeat(beat);
    return s.sample + (beat - s.beat) * s.spb;
  }

  barAt(sample: number): number {
    const s = this._segAtSample(sample);
    const beatsIn = (sample - s.sample) / s.spb;
    return s.bar + beatsIn / s.beatsPerBar;
  }

  sampleOfBar(bar: number): number {
    const s = this._segAtBar(bar);
    return s.sample + (bar - s.bar) * s.beatsPerBar * s.spb;
  }

  /* Start of the bar containing `sample`, as an integer sample index. */
  barStartAt(sample: number): number {
    return Math.round(this.sampleOfBar(Math.floor(this.barAt(sample) + 1e-9)));
  }

  get samplesPerDivisionAt(): null { return null; }   // deliberately absent; see below

  divisionsPerBeat(): number { return Math.max(1, this.subdivision); }

  /* Nearest grid line to `sample`, as an integer sample index. Works across a
   * tempo change: the two candidate lines can be different distances apart on
   * either side, so both are computed and compared rather than rounding a
   * division index. */
  nearestLine(sample: number): number {
    const sub = this.divisionsPerBeat();
    const b = this.beatAtSample(sample) * sub;
    const lo = this.sampleOfBeat(Math.floor(b) / sub);
    const hi = this.sampleOfBeat(Math.ceil(b) / sub);
    return Math.round((sample - lo) <= (hi - sample) ? lo : hi);
  }

  /*
   * Every grid line in [from, to]. Walks the segment table, so line spacing
   * changes at each tempo change exactly where it should.
   */
  linesIn(from: number, to: number, limit?: number): GridLine[] {
    const out: GridLine[] = [];
    const sub = this.divisionsPerBeat();
    const g = this._segs;
    if (!g.length) return out;

    // Rough count first, so a zoomed-out view bails before generating.
    let approx = 0;
    for (let q = 0; q < g.length; q++) {
      const segStart = g[q].sample;
      const segEnd = (q + 1 < g.length) ? g[q + 1].sample : Infinity;
      const a = Math.max(from, segStart), b = Math.min(to, segEnd);
      if (b > a) approx += (b - a) / (g[q].spb / sub);
    }
    if (limit && approx > limit) return out;

    for (let i = 0; i < g.length; i++) {
      const seg = g[i];
      const start = seg.sample;
      const end = (i + 1 < g.length) ? g[i + 1].sample : Infinity;
      const lo = Math.max(from, start);
      const hi = Math.min(to, end);
      if (hi < lo) continue;

      const step = seg.spb / sub;
      const firstDiv = Math.ceil((lo - start) / step - 1e-9);
      const perBar = sub * seg.beatsPerBar;
      for (let n = firstDiv; ; n++) {
        const pos = start + n * step;
        if (pos > hi + 1e-6) break;
        if (pos >= end - 1e-6 && i + 1 < g.length) break;  // next segment owns it
        const absDiv = Math.round((seg.beat * sub) + n);
        const isBeat = (((n % sub) + sub) % sub) === 0;
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
  barsIn(from: number, to: number, limit?: number): BarLine[] {
    const out: BarLine[] = [];
    const g = this._segs;
    for (let i = 0; i < g.length; i++) {
      const seg = g[i];
      const start = seg.sample;
      const end = (i + 1 < g.length) ? g[i + 1].sample : Infinity;
      const lo = Math.max(from, start), hi = Math.min(to, end);
      if (hi < lo) continue;
      const step = seg.spb * seg.beatsPerBar;
      const first = Math.ceil((lo - start) / step - 1e-9);
      for (let n = first; ; n++) {
        const pos = start + n * step;
        if (pos > hi + 1e-6) break;
        if (pos >= end - 1e-6 && i + 1 < g.length) break;
        out.push({ sample: Math.round(pos), bar: seg.bar + n });
        if (limit && out.length > limit) return [];
      }
    }
    return out;
  }

  /* "bar.beat.tick" readout, 1-based like a DAW. */
  positionLabel(sample: number): string {
    const seg = this._segAtSample(sample);
    const beatsIn = (sample - seg.sample) / seg.spb;
    const bpb = Math.max(1, seg.beatsPerBar);
    const barsIn = Math.floor(beatsIn / bpb);
    let bar = seg.bar + barsIn;
    const inBar = beatsIn - barsIn * bpb;
    let b = Math.floor(inBar);
    let tick = Math.round((inBar - b) * 960);
    if (tick >= 960) { tick -= 960; b += 1; }
    if (b >= bpb) { b -= bpb; bar += 1; }
    return bar + '.' + (b + 1) + '.' + String(tick).padStart(3, '0');
  }

  /* Beats between two sample positions, integrating across tempo changes.
   * A plain (b - a) / samplesPerBeat is wrong the moment the map has two
   * entries, and wrong quietly - it just reports the wrong number. */
  beatsBetween(a: number, b: number): number {
    return this.beatAtSample(b) - this.beatAtSample(a);
  }

  /* The segment table, for the audio engine's metronome. Plain data. */
  segments(): MetronomeSegment[] {
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
  public resetAfterMs: number;
  public maxTaps: number;
  public times: number[];

  constructor(opts?: TapTempoOptions | null) {
    opts = opts || {};
    this.resetAfterMs = opts.resetAfterMs || 2500;
    this.maxTaps = opts.maxTaps || 16;
    this.times = [];
  }

  reset(): void { this.times = []; }

  tap(now: number): TapResult | null {
    const n = this.times.length;
    if (n && (now - this.times[n - 1]) > this.resetAfterMs) this.times = [];
    this.times.push(now);
    if (this.times.length > this.maxTaps) this.times.shift();
    if (this.times.length < 2) return null;

    // Mean interval over the retained run. Simple and stable; a median would
    // reject a single fumbled tap better but reacts badly to a deliberate
    // tempo change mid-run, which is the commoner case here.
    const span = this.times[this.times.length - 1] - this.times[0];
    const intervals = this.times.length - 1;
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
export function psxavencSafeQuantum(rate: number, blockSize?: number): number {
  const block = blockSize || 28;
  if (!rate) return block;
  const msStride = rate / gcd(rate, 1000);   // samples per whole millisecond
  return block * msStride / gcd(block, msStride);
}

/*
 * Round `sample` to a multiple of `quantum`. mode: 'nearest', 'floor', 'ceil'.
 * This is what enforces the PS1 SPU's 28-sample ADPCM block granularity.
 */
export function alignSample(sample: number, quantum?: number, mode?: AlignMode): number {
  if (!quantum || quantum < 2) return Math.round(sample);
  const q = Math.round(quantum);
  let n = sample / q;
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
export function snapSample(sample: number, opts: SnapOptions): SnapResult {
  const grid = opts.grid;
  let out = Math.round(sample);
  let snappedToGrid = false;

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

  let offGrid = 0;
  if (snappedToGrid) offGrid = out - grid!.nearestLine(out);
  return { sample: out, offGrid: offGrid };
}
