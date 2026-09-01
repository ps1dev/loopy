/*
 * The actual sample-playback loop. No Web Audio types in here at all: it is
 * fed an output array and a frame count, so the same code runs inside an
 * AudioWorkletProcessor and inside a ScriptProcessorNode callback.
 *
 * Why not AudioBufferSourceNode:
 *   - loopStart/loopEnd are doubles in SECONDS, so a sample-exact loop point
 *     is only reachable by hoping the browser's seconds->frames rounding
 *     agrees with yours. It does not, consistently, across engines.
 *   - it can only loop forward. The `smpl` chunk has three loop types and two
 *     of them (alternating and backward) have no AudioBufferSourceNode
 *     equivalent at all.
 *
 * Position is a float sample index. When the file rate matches the context
 * rate `step` is exactly 1 and every position is an integer, so the loop
 * boundaries are bit-exact; otherwise positions land between samples and are
 * linearly interpolated. Linear is the honest choice here - this is a
 * monitoring tool, and pretending to sinc-quality resampling would hide the
 * fact that the browser is resampling at all. Load a file at the device rate
 * if you care.
 *
 * Loop-point convention throughout: `end` is INCLUSIVE, matching dwEnd in the
 * `smpl` chunk. The loop covers `end - start + 1` sample frames.
 */

export const LOOP_FORWARD = 0;
export const LOOP_ALTERNATING = 1;   // ping-pong
export const LOOP_BACKWARD = 2;

/**
 * The three `smpl` loop types this engine acts on. Documentation, NOT the type
 * of `loopType` - `dwType` comes off the wire as an arbitrary u32 and this
 * codebase deliberately carries whatever the file said (the loop list renders
 * an unknown value as "type 7" rather than rewriting it). Narrowing the field
 * to this union would force a lying cast at every call site that reads a loop
 * out of a file, so the field stays `number` and the engine treats anything
 * that is not ALTERNATING or BACKWARD as forward, exactly as the JS did.
 */
export type LoopType =
  | typeof LOOP_FORWARD
  | typeof LOOP_ALTERNATING
  | typeof LOOP_BACKWARD;

/** One entry of the tempo map: a constant-tempo run starting at `sample`. */
export interface TempoSegment {
  sample: number;
  beat: number;
  spb: number;
  beatsPerBar: number;
}

/** Called when a non-looping play runs off the end. */
export type EndedCallback = () => void;

export class PlayerCore {
  channels: Float32Array[] | null;
  frames: number;
  sourceRate: number;
  outputRate: number;

  playing: boolean;
  position: number;
  direction: 1 | -1;
  gain: number;

  loopEnabled: boolean;
  loopStart: number;
  loopEnd: number;
  loopType: number;

  metronome: boolean;
  metroGain: number;
  segments: TempoSegment[];
  _segIndex: number;
  _lastBeat: number | null;
  _clickPos: number;
  _clickLen: number;
  _clickFreq: number;
  _clickGain: number;

  onEnded: EndedCallback | null;

  constructor() {
    this.channels = null;       // array of Float32Array
    this.frames = 0;
    this.sourceRate = 44100;
    this.outputRate = 44100;

    this.playing = false;
    this.position = 0;          // float sample index into the source
    this.direction = 1;         // +1 / -1, only moves under alternating loops
    this.gain = 1;

    this.loopEnabled = false;
    this.loopStart = 0;
    this.loopEnd = 0;           // inclusive
    this.loopType = LOOP_FORWARD;

    // Metronome, run from the same position clock so a click cannot drift
    // away from the audio or be left behind by a loop jump.
    this.metronome = false;
    this.metroGain = 0.35;
    // Ticks follow BEATS, never grid divisions. The divisions control is a
    // visual density setting for the grid; wiring it to the click turned
    // "show me sixteenths" into a machine-gun metronome. Subdivision is not a
    // field here at all, so it structurally cannot reach the click.
    //
    // The tempo map arrives as a SEGMENT TABLE rather than one beat length,
    // so a song that changes tempo clicks at the right rate on both sides of
    // the change. Each entry: {sample, beat, spb, beatsPerBar}. Empty means
    // no grid, and the metronome stays silent rather than guessing 120.
    this.segments = [];
    this._segIndex = 0;
    this._lastBeat = null;
    this._clickPos = -1;        // frames into the current click, -1 = idle
    this._clickLen = 0;
    this._clickFreq = 1200;
    this._clickGain = 0;

    this.onEnded = null;        // called when a non-looping play runs off the end
  }

  setSource(channels: Float32Array[] | null, sourceRate: number): void {
    this.channels = channels;
    this.frames = channels && channels.length ? channels[0].length : 0;
    this.sourceRate = sourceRate || 44100;
    this.position = 0;
    this.direction = 1;
    this.playing = false;
    this._lastBeat = null;
  }

  get step(): number { return this.sourceRate / this.outputRate; }

  get loopLength(): number {
    const n = this.loopEnd - this.loopStart + 1;
    return n > 0 ? n : 0;
  }

  get loopActive(): boolean | null {
    return this.loopEnabled && this.channels && this.loopLength > 1;
  }

  seek(sample: number): void {
    this.position = Math.max(0, Math.min(sample, this.frames));
    this.direction = (this.loopType === LOOP_BACKWARD && this.loopActive) ? -1 : 1;
    this._lastBeat = null;
  }

  play(fromSample?: number): void {
    if (!this.channels || !this.frames) return;
    if (fromSample !== undefined) this.seek(fromSample);
    if (this.position >= this.frames) this.seek(0);
    if (this.loopActive && this.loopType === LOOP_BACKWARD) this.direction = -1;
    this.playing = true;
  }

  stop(): void { this.playing = false; }

  /*
   * If the loop moves while the playhead is outside it, pull the playhead to
   * the near edge rather than letting it run past the region for one pass.
   * Called by the host on every loop change.
   */
  reconcile(): void {
    if (!this.loopActive || !this.playing) return;
    const lo = this.loopStart, hi = this.loopEnd + 1;
    if (this.position < lo || this.position >= hi) {
      this.position = (this.loopType === LOOP_BACKWARD) ? hi - 1 : lo;
      this.direction = (this.loopType === LOOP_BACKWARD) ? -1 : 1;
      this._lastBeat = null;
    }
  }

  _sampleAt(ch: number, pos: number): number {
    const data = this.channels![ch];
    const i = pos | 0;
    if (i < 0) return 0;
    if (i >= this.frames - 1) return data[this.frames - 1] || 0;
    const f = pos - i;
    if (f === 0) return data[i];
    return data[i] + (data[i + 1] - data[i]) * f;
  }

  _advance(): void {
    const step = this.step;
    if (!this.loopActive) {
      this.position += step;
      if (this.position >= this.frames) {
        this.position = this.frames;
        this.playing = false;
        if (this.onEnded) this.onEnded();
      }
      return;
    }

    const lo = this.loopStart;
    const hi = this.loopEnd + 1;      // exclusive upper bound
    const len = hi - lo;

    if (this.loopType === LOOP_BACKWARD) {
      this.position -= step;
      if (this.position < lo) {
        const under = lo - this.position;
        this.position = hi - (under % len);
      }
      return;
    }

    if (this.loopType === LOOP_ALTERNATING) {
      this.position += step * this.direction;
      // Reflect about the two endpoint SAMPLES (lo and hi-1), not about the
      // exclusive boundary. Reflecting about `hi` would put the playhead one
      // sample past the loop end, i.e. outside the loop entirely - which is
      // both wrong and, on a one-shot sample, reading whatever follows it.
      // With this form each endpoint is played exactly once per traversal:
      // 4 5 6 7 6 5 4 5 6 7 ...
      const last = hi - 1;
      let guard = 0;
      while (guard++ < 4) {
        if (this.position > last) {
          this.position = 2 * last - this.position;
          this.direction = -1;
        } else if (this.position < lo) {
          this.position = 2 * lo - this.position;
          this.direction = 1;
        } else break;
      }
      return;
    }

    this.position += step;
    if (this.position >= hi) {
      const over = this.position - hi;
      this.position = lo + (over % len);
    }
  }

  /* Segment covering the current position. Cached and nudged rather than
   * searched: playback moves monotonically (or reverses, in a ping-pong
   * loop), so this is O(1) per sample in the common case. A binary search per
   * output sample would be pointless work in the audio callback. */
  _segAt(pos: number): TempoSegment {
    const g = this.segments;
    let i = this._segIndex;
    if (i >= g.length) i = g.length - 1;
    while (i + 1 < g.length && pos >= g[i + 1].sample) i++;
    while (i > 0 && pos < g[i].sample) i--;
    this._segIndex = i;
    return g[i];
  }

  _metroTick(): void {
    if (!this.metronome || !this.segments.length) return;
    const seg = this._segAt(this.position);
    if (!(seg.spb > 1)) return;
    const d = seg.beat + Math.floor((this.position - seg.sample) / seg.spb);
    if (this._lastBeat === null) { this._lastBeat = d; return; }
    if (d === this._lastBeat) return;
    this._lastBeat = d;

    const perBar = Math.max(1, seg.beatsPerBar);
    const accent = (((d % perBar) + perBar) % perBar) === 0;
    this._clickPos = 0;
    this._clickLen = Math.round(this.outputRate * 0.035);
    this._clickFreq = accent ? 1800 : 1200;
    this._clickGain = accent ? 0.9 : 0.5;
  }

  _clickSample(): number {
    if (this._clickPos < 0) return 0;
    if (this._clickPos >= this._clickLen) { this._clickPos = -1; return 0; }
    const t = this._clickPos / this._clickLen;
    const env = Math.exp(-9 * t);
    const v = Math.sin(2 * Math.PI * this._clickFreq * this._clickPos / this.outputRate);
    this._clickPos++;
    return v * env * this._clickGain * this.metroGain;
  }

  /*
   * Render `frames` frames into `out` (array of Float32Array, one per output
   * channel). Source channels are mapped up or down as needed: mono to
   * everything, extra source channels folded into the last output channel.
   */
  render(out: Float32Array[], frames: number): void {
    const outCh = out.length;
    if (!outCh) return;
    if (!this.channels || !this.frames) {
      for (let c0 = 0; c0 < outCh; c0++) out[c0].fill(0);
      return;
    }
    const srcCh = this.channels.length;
    const g = this.gain;

    for (let i = 0; i < frames; i++) {
      const click = this._clickSample();
      if (!this.playing) {
        for (let c1 = 0; c1 < outCh; c1++) out[c1][i] = click;
        continue;
      }
      for (let c = 0; c < outCh; c++) {
        let v: number;
        if (srcCh === 1) v = this._sampleAt(0, this.position);
        else if (c < srcCh) v = this._sampleAt(c, this.position);
        else v = this._sampleAt(srcCh - 1, this.position);
        out[c][i] = v * g + click;
      }
      this._advance();
      this._metroTick();
      if (!this.playing) {
        // Ran off the end mid-block: silence the remainder.
        for (let j = i + 1; j < frames; j++) {
          for (let c2 = 0; c2 < outCh; c2++) out[c2][j] = 0;
        }
        break;
      }
    }
  }
}
