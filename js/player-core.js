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

export var LOOP_FORWARD = 0;
export var LOOP_ALTERNATING = 1;   // ping-pong
export var LOOP_BACKWARD = 2;

export class PlayerCore {
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
    this.gridOffset = 0;
    // Ticks follow BEATS, never grid divisions. The divisions control is a
    // visual density setting for the grid; wiring it to the click turned
    // "show me sixteenths" into a machine-gun metronome. Subdivision is not a
    // field here at all, so it structurally cannot reach the click.
    this.samplesPerBeat = 0;
    this.beatsPerBar = 4;
    this._lastBeat = null;
    this._clickPos = -1;        // frames into the current click, -1 = idle
    this._clickLen = 0;
    this._clickFreq = 1200;
    this._clickGain = 0;

    this.onEnded = null;        // called when a non-looping play runs off the end
  }

  setSource(channels, sourceRate) {
    this.channels = channels;
    this.frames = channels && channels.length ? channels[0].length : 0;
    this.sourceRate = sourceRate || 44100;
    this.position = 0;
    this.direction = 1;
    this.playing = false;
    this._lastBeat = null;
  }

  get step() { return this.sourceRate / this.outputRate; }

  get loopLength() {
    var n = this.loopEnd - this.loopStart + 1;
    return n > 0 ? n : 0;
  }

  get loopActive() {
    return this.loopEnabled && this.channels && this.loopLength > 1;
  }

  seek(sample) {
    this.position = Math.max(0, Math.min(sample, this.frames));
    this.direction = (this.loopType === LOOP_BACKWARD && this.loopActive) ? -1 : 1;
    this._lastBeat = null;
  }

  play(fromSample) {
    if (!this.channels || !this.frames) return;
    if (fromSample !== undefined) this.seek(fromSample);
    if (this.position >= this.frames) this.seek(0);
    if (this.loopActive && this.loopType === LOOP_BACKWARD) this.direction = -1;
    this.playing = true;
  }

  stop() { this.playing = false; }

  /*
   * If the loop moves while the playhead is outside it, pull the playhead to
   * the near edge rather than letting it run past the region for one pass.
   * Called by the host on every loop change.
   */
  reconcile() {
    if (!this.loopActive || !this.playing) return;
    var lo = this.loopStart, hi = this.loopEnd + 1;
    if (this.position < lo || this.position >= hi) {
      this.position = (this.loopType === LOOP_BACKWARD) ? hi - 1 : lo;
      this.direction = (this.loopType === LOOP_BACKWARD) ? -1 : 1;
      this._lastBeat = null;
    }
  }

  _sampleAt(ch, pos) {
    var data = this.channels[ch];
    var i = pos | 0;
    if (i < 0) return 0;
    if (i >= this.frames - 1) return data[this.frames - 1] || 0;
    var f = pos - i;
    if (f === 0) return data[i];
    return data[i] + (data[i + 1] - data[i]) * f;
  }

  _advance() {
    var step = this.step;
    if (!this.loopActive) {
      this.position += step;
      if (this.position >= this.frames) {
        this.position = this.frames;
        this.playing = false;
        if (this.onEnded) this.onEnded();
      }
      return;
    }

    var lo = this.loopStart;
    var hi = this.loopEnd + 1;      // exclusive upper bound
    var len = hi - lo;

    if (this.loopType === LOOP_BACKWARD) {
      this.position -= step;
      if (this.position < lo) {
        var under = lo - this.position;
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
      var last = hi - 1;
      var guard = 0;
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
      var over = this.position - hi;
      this.position = lo + (over % len);
    }
  }

  _metroTick() {
    if (!this.metronome || !(this.samplesPerBeat > 1)) return;
    var d = Math.floor((this.position - this.gridOffset) / this.samplesPerBeat);
    if (this._lastBeat === null) { this._lastBeat = d; return; }
    if (d === this._lastBeat) return;
    this._lastBeat = d;

    var perBar = Math.max(1, this.beatsPerBar);
    var accent = (((d % perBar) + perBar) % perBar) === 0;
    this._clickPos = 0;
    this._clickLen = Math.round(this.outputRate * 0.035);
    this._clickFreq = accent ? 1800 : 1200;
    this._clickGain = accent ? 0.9 : 0.5;
  }

  _clickSample() {
    if (this._clickPos < 0) return 0;
    if (this._clickPos >= this._clickLen) { this._clickPos = -1; return 0; }
    var t = this._clickPos / this._clickLen;
    var env = Math.exp(-9 * t);
    var v = Math.sin(2 * Math.PI * this._clickFreq * this._clickPos / this.outputRate);
    this._clickPos++;
    return v * env * this._clickGain * this.metroGain;
  }

  /*
   * Render `frames` frames into `out` (array of Float32Array, one per output
   * channel). Source channels are mapped up or down as needed: mono to
   * everything, extra source channels folded into the last output channel.
   */
  render(out, frames) {
    var outCh = out.length;
    if (!outCh) return;
    if (!this.channels || !this.frames) {
      for (var c0 = 0; c0 < outCh; c0++) out[c0].fill(0);
      return;
    }
    var srcCh = this.channels.length;
    var g = this.gain;

    for (var i = 0; i < frames; i++) {
      var click = this._clickSample();
      if (!this.playing) {
        for (var c1 = 0; c1 < outCh; c1++) out[c1][i] = click;
        continue;
      }
      for (var c = 0; c < outCh; c++) {
        var v;
        if (srcCh === 1) v = this._sampleAt(0, this.position);
        else if (c < srcCh) v = this._sampleAt(c, this.position);
        else v = this._sampleAt(srcCh - 1, this.position);
        out[c][i] = v * g + click;
      }
      this._advance();
      this._metroTick();
      if (!this.playing) {
        // Ran off the end mid-block: silence the remainder.
        for (var j = i + 1; j < frames; j++) {
          for (var c2 = 0; c2 < outCh; c2++) out[c2][j] = 0;
        }
        break;
      }
    }
  }
}
