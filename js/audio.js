/*
 * Audio host: an AudioContext, a ScriptProcessorNode, and PlayerCore doing
 * the actual work in its callback.
 *
 * ScriptProcessorNode is deprecated and an AudioWorklet would be the modern
 * answer, but the callback here is a per-sample copy with an interpolation
 * and a loop bounds check - nowhere near enough work to miss a deadline, and
 * the redraw path it shares the main thread with runs off a precomputed peak
 * pyramid rather than raw samples. What the deprecated node buys in exchange:
 * no secure-context requirement (so serving this off a bare IP works), no
 * duplicate copy of the sample data across a thread boundary, and a playhead
 * read straight out of the player rather than extrapolated between messages.
 *
 * All positions crossing this boundary are SAMPLE FRAMES at the source rate.
 */
import { PlayerCore, LOOP_FORWARD, LOOP_ALTERNATING, LOOP_BACKWARD } from './player-core.js';

export { PlayerCore, LOOP_FORWARD, LOOP_ALTERNATING, LOOP_BACKWARD };

/* 2048 frames is ~43 ms at 48 kHz: enough slack to survive a slow redraw,
 * short enough that toggling the loop feels immediate. */
var BUFFER_FRAMES = 2048;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.core = new PlayerCore();
    this.ready = false;

    this.loop = null;            // {start, end, type}, end inclusive
    this.loopEnabled = false;
    this.grid = null;

    this.onEnded = null;

    var self = this;
    this.core.onEnded = function () { if (self.onEnded) self.onEnded(); };
  }

  /*
   * NEVER await resume(). On a context the autoplay policy has blocked,
   * resume() returns a promise that stays PENDING - it does not reject - so
   * `await this.ctx.resume()` hangs the caller until some unrelated future
   * gesture starts the context. That was the cause of "the first non-WAV file
   * hangs until you load a second one": the second load supplied the gesture
   * that unblocked the first load's await.
   *
   * Setting up the graph does not need a running context; only hearing it
   * does. So resume is fired and forgotten here, and retried in play(), which
   * is where a gesture is actually present.
   */
  _kick() {
    if (this.ctx && this.ctx.state === 'suspended') {
      var p = this.ctx.resume();
      if (p && p.catch) p.catch(function () { /* still blocked; play() retries */ });
    }
  }

  async init() {
    if (this.ctx) { this._kick(); return; }
    var Ctor = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctor();
    this._kick();
    this.core.outputRate = this.ctx.sampleRate;

    try {
      this.node = this.ctx.createScriptProcessor(BUFFER_FRAMES, 0, 2);
    } catch (e) {
      // A few engines refuse zero input channels; one unused input is harmless.
      this.node = this.ctx.createScriptProcessor(BUFFER_FRAMES, 1, 2);
    }

    var self = this;
    var scratch = [];
    this.node.onaudioprocess = function (ev) {
      var ob = ev.outputBuffer;
      scratch.length = 0;
      for (var c = 0; c < ob.numberOfChannels; c++) scratch.push(ob.getChannelData(c));
      self.core.render(scratch, ob.length);
    };

    this.node.connect(this.ctx.destination);
    this.ready = true;
    this._pushParams();
  }

  get playing() { return this.core.playing; }
  get frames() { return this.core.frames; }
  get sourceRate() { return this.core.sourceRate; }
  get sampleRate() { return this.core.sourceRate; }
  get contextRate() { return this.ctx ? this.ctx.sampleRate : 0; }

  /* True when the browser is resampling us, which is worth saying out loud:
   * loop points stay exact in the file, but what you hear is interpolated. */
  get resampling() {
    return !!(this.ctx && this.core.sourceRate && this.ctx.sampleRate !== this.core.sourceRate);
  }

  setSource(channels, sourceRate) {
    this.core.setSource(channels, sourceRate);
  }

  _pushParams(reconcile) {
    var core = this.core;
    var L = this.loop;
    core.loopEnabled = this.loopEnabled;
    if (L) {
      core.loopStart = L.start;
      core.loopEnd = L.end;
      core.loopType = L.type || LOOP_FORWARD;
    }
    if (this.grid) {
      // The whole tempo map, not one beat length: a song with a tempo change
      // must click at the right rate on both sides of it.
      core.segments = this.grid.enabled ? this.grid.segments() : [];
      core._segIndex = 0;
    }
    if (reconcile) core.reconcile();
  }

  setLoop(loop, enabled) {
    this.loop = loop;
    if (enabled !== undefined) this.loopEnabled = enabled;
    this._pushParams(true);
  }

  setGrid(grid) { this.grid = grid; this._pushParams(); }
  gridChanged() { this._pushParams(); }

  setMetronome(on) { this.core.metronome = !!on; }
  setMetronomeVolume(v) { this.core.metroGain = v; }
  setVolume(v) { this.core.gain = v; }

  play(fromSample) {
    if (!this.core.frames) return;
    this._kick();          // a play click is a gesture; this is where it lands
    this._pushParams();
    this.core.play(fromSample);
  }

  stop() { this.core.stop(); }
  toggle() { if (this.core.playing) this.stop(); else this.play(); }
  seekSamples(sample) { this.core.seek(sample); }

  /* Exact: this is the player's own position, not an estimate. */
  positionSamples() { return Math.round(this.core.position); }
}
