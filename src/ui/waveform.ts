/*
 * Waveform display and mouse interaction.
 *
 * The peak pyramid the renderer reads is built in ../core/peaks.ts.
 */

import { BASE_BUCKET } from '../core/peaks.js';
import type { PeakPyramid } from '../core/peaks.js';
import { formatTime } from '../core/time.js';

/** A loop as the view needs it; sample frames, `end` inclusive. */
export interface Loop {
  start: number;
  end: number;
}

/** Which horizontal band of the canvas a pointer event landed in. */
export type Band = 'time' | 'bars' | 'lanes';

/** Modifier keys as handed to the callbacks, plus the band on a seek. */
export interface Mods {
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  band?: Band;
}

/** What the pointer is over: a loop edge, or a loop body. */
export interface Hit {
  loop: number;
  edge: 'start' | 'end' | 'body';
}

/** The in-progress mouse gesture, exposed as `_drag` for the E2E. */
export type Drag =
  | { kind: 'pan'; x: number; start: number; end: number }
  | { kind: 'seek'; band?: Band }
  | { kind: 'loop'; loop: number; x: number; mods: Mods; moved: boolean }
  | { kind: 'point'; loop: number; edge: 'start' | 'end'; mods: Mods; moved: boolean };

/** The part of the beat grid this view reads; BeatGrid satisfies it. */
export interface WaveformGrid {
  linesIn(from: number, to: number, limit: number): Array<{ sample: number; isBeat: boolean; isBar: boolean }>;
  barsIn(from: number, to: number, limit: number): Array<{ sample: number; bar: number }>;
  samplesPerBarAt(sample: number): number;
  barStartAt(sample: number): number;
  sampleOfBar(bar: number): number;
  barAt(sample: number): number;
}

const RULER_H = 22;       // time ruler
const BAR_RULER_H = 17;   // bar ruler, only present when the grid is on
const HANDLE_PX = 6;      // grab radius for a loop edge

export class WaveformView {
  canvas: HTMLCanvasElement;
  overview: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D;
  octx: CanvasRenderingContext2D | null;

  channels: Float32Array[] | null;
  peaks: PeakPyramid | null;
  frames: number;
  sampleRate: number;

  viewStart: number;
  viewEnd: number;
  playhead: number;
  loops: Loop[];
  selected: number;
  grid: WaveformGrid | null;
  showGrid: boolean;
  hover: Hit | null;

  onSeek: ((sample: number, mods: Mods) => void) | null;
  onDragPoint: ((loopIndex: number, edge: 'start' | 'end', sample: number, mods: Mods) => void) | null;
  onDragLoop: ((loopIndex: number, deltaSamples: number, mods: Mods) => void) | null;
  onDragEnd: ((drag: Drag) => void) | null;
  onSelect: ((loopIndex: number) => void) | null;
  onView: (() => void) | null;

  _drag: Drag | null;
  _raf: number | null;

  constructor(canvas: HTMLCanvasElement, overviewCanvas: HTMLCanvasElement | null) {
    this.canvas = canvas;
    this.overview = overviewCanvas;
    // The JS assumed a 2d context exists; a null one here is a broken page,
    // not a state to draw around.
    this.ctx = canvas.getContext('2d')!;
    this.octx = overviewCanvas ? overviewCanvas.getContext('2d') : null;

    this.channels = null;
    this.peaks = null;
    this.frames = 0;
    this.sampleRate = 44100;

    this.viewStart = 0;
    this.viewEnd = 0;
    this.playhead = 0;
    this.loops = [];
    this.selected = -1;
    this.grid = null;
    this.showGrid = false;
    this.hover = null;        // {loop, edge} under the cursor

    // Callbacks, wired by the app.
    this.onSeek = null;             // (sample, modifiers)
    this.onDragPoint = null;        // (loopIndex, edge, sample, modifiers)
    this.onDragLoop = null;         // (loopIndex, deltaSamples, modifiers)
    this.onDragEnd = null;
    this.onSelect = null;           // (loopIndex)
    this.onView = null;             // () -> view changed

    this._drag = null;
    this._raf = null;
    this._bind();
  }

  setSource(channels: Float32Array[] | null, peaks: PeakPyramid | null, sampleRate: number): void {
    this.channels = channels;
    this.peaks = peaks;
    this.frames = channels && channels.length ? channels[0].length : 0;
    this.sampleRate = sampleRate;
    this.viewStart = 0;
    this.viewEnd = this.frames;
    this.playhead = 0;
    this.requestDraw();
  }

  /* ---- coordinate helpers ---------------------------------------------- */

  get cssWidth(): number { return this.canvas.clientWidth || 1; }
  get cssHeight(): number { return this.canvas.clientHeight || 1; }
  get viewLength(): number { return Math.max(1, this.viewEnd - this.viewStart); }

  /* The bar ruler only exists when there is a grid to number, so the lane
   * area has to be measured rather than assumed. Hard-coding RULER_H here was
   * what drew the waveform under the bar strip on the first attempt. */
  get barRulerHeight(): number { return (this.showGrid && this.grid) ? BAR_RULER_H : 0; }
  get rulerHeight(): number { return RULER_H + this.barRulerHeight; }

  sampleToX(s: number): number { return (s - this.viewStart) * this.cssWidth / this.viewLength; }
  xToSample(x: number): number { return this.viewStart + x * this.viewLength / this.cssWidth; }

  setView(start: number, end: number): void {
    const minLen = 16;
    if (end - start < minLen) end = start + minLen;
    if (start < 0) { end -= start; start = 0; }
    if (this.frames && end > this.frames) {
      const over = end - this.frames;
      end = this.frames;
      start = Math.max(0, start - over);
    }
    this.viewStart = start;
    this.viewEnd = end;
    if (this.onView) this.onView();
    this.requestDraw();
  }

  zoomAt(sample: number, factor: number): void {
    const left = sample - this.viewStart;
    const right = this.viewEnd - sample;
    this.setView(sample - left * factor, sample + right * factor);
  }

  fit(): void { this.setView(0, this.frames || 1); }

  zoomToLoop(loop: Loop | null | undefined, pad?: number): void {
    if (!loop) return;
    const len = Math.max(16, loop.end - loop.start);
    const p = (pad === undefined ? 0.15 : pad) * len;
    this.setView(loop.start - p, loop.end + p);
  }

  /* ---- drawing ---------------------------------------------------------- */

  requestDraw(): void {
    if (this._raf) return;
    const self = this;
    this._raf = requestAnimationFrame(function () { self._raf = null; self.draw(); });
  }

  _prepare(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): { w: number; h: number } {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h };
  }

  draw(): void {
    const ctx = this.ctx;
    const dim = this._prepare(this.canvas, ctx);
    const w = dim.w, h = dim.h;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#12161c';
    ctx.fillRect(0, 0, w, h);

    if (!this.channels || !this.frames) {
      ctx.fillStyle = '#59636f';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('drop an audio file here, or use Open', w / 2, h / 2);
      ctx.textAlign = 'left';
      this._drawOverview();
      return;
    }

    const lanesTop = this.rulerHeight;
    const lanesH = h - lanesTop;
    const nch = this.channels.length;
    const laneH = lanesH / nch;

    this._drawLoopBands(ctx, w, lanesTop, lanesH, true);
    if (this.showGrid && this.grid) this._drawGrid(ctx, w, lanesTop, lanesH);

    for (let c = 0; c < nch; c++) {
      this._drawChannel(ctx, c, 0, lanesTop + c * laneH, w, laneH);
    }

    this._drawLoopBands(ctx, w, lanesTop, lanesH, false);
    this._drawRuler(ctx, w);
    this._drawPlayhead(ctx, w, h);
    this._drawOverview();
  }

  _drawChannel(ctx: CanvasRenderingContext2D, ch: number, x0: number, y0: number, w: number, h: number): void {
    const mid = y0 + h / 2;
    const amp = (h / 2) * 0.92;

    ctx.strokeStyle = '#232a33';
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(mid) + 0.5);
    ctx.lineTo(x0 + w, Math.round(mid) + 0.5);
    ctx.stroke();

    const spp = this.viewLength / w;
    // Only ever called from draw(), past its channels/frames guard, and peaks
    // are set alongside channels.
    const data = this.channels![ch];
    const levels = this.peaks![ch];

    ctx.fillStyle = '#4fd08a';
    if (spp < BASE_BUCKET) {
      // Fine zoom: read raw samples.
      if (spp < 0.25) {
        // Very fine: draw the actual sample line, with dots per sample.
        ctx.strokeStyle = '#4fd08a';
        ctx.beginPath();
        const first = Math.max(0, Math.floor(this.viewStart) - 1);
        const last = Math.min(data.length - 1, Math.ceil(this.viewEnd) + 1);
        for (let s = first; s <= last; s++) {
          const px = this.sampleToX(s);
          const py = mid - data[s] * amp;
          if (s === first) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        if (spp < 0.08) {
          for (let s2 = first; s2 <= last; s2++) {
            ctx.fillRect(this.sampleToX(s2) - 1.5, mid - data[s2] * amp - 1.5, 3, 3);
          }
        }
        return;
      }
      for (let px2 = 0; px2 < w; px2++) {
        const a = Math.max(0, Math.floor(this.xToSample(px2)));
        let b = Math.min(data.length, Math.ceil(this.xToSample(px2 + 1)));
        if (b <= a) b = a + 1;
        let lo = Infinity, hi = -Infinity;
        for (let i = a; i < b && i < data.length; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (lo === Infinity) continue;
        const yTop = mid - hi * amp, yBot = mid - lo * amp;
        ctx.fillRect(x0 + px2, yTop, 1, Math.max(1, yBot - yTop));
      }
      return;
    }

    // Coarse zoom: coarsest pyramid level with >= 1 bucket per pixel.
    let lvl = levels[0];
    for (let l = 0; l < levels.length; l++) {
      if (levels[l].bucket <= spp) lvl = levels[l]; else break;
    }
    const bucket = lvl.bucket;
    for (let px3 = 0; px3 < w; px3++) {
      const sa = this.xToSample(px3) / bucket;
      const sb = this.xToSample(px3 + 1) / bucket;
      const ia = Math.max(0, Math.floor(sa));
      let ib = Math.min(lvl.min.length, Math.ceil(sb));
      if (ib <= ia) ib = ia + 1;
      let lo2 = Infinity, hi2 = -Infinity;
      for (let k = ia; k < ib && k < lvl.min.length; k++) {
        if (lvl.min[k] < lo2) lo2 = lvl.min[k];
        if (lvl.max[k] > hi2) hi2 = lvl.max[k];
      }
      if (lo2 === Infinity) continue;
      const t = mid - hi2 * amp, bt = mid - lo2 * amp;
      ctx.fillRect(x0 + px3, t, 1, Math.max(1, bt - t));
    }
  }

  _drawGrid(ctx: CanvasRenderingContext2D, w: number, y0: number, h: number): void {
    // Called only under `this.showGrid && this.grid`.
    const lines = this.grid!.linesIn(this.viewStart, this.viewEnd, 4000);
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const x = Math.round(this.sampleToX(L.sample)) + 0.5;
      if (x < 0 || x > w) continue;
      ctx.strokeStyle = L.isBar ? 'rgba(255,255,255,0.26)'
        : L.isBeat ? 'rgba(255,255,255,0.13)'
        : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + h);
      ctx.stroke();
    }
  }

  _drawLoopBands(ctx: CanvasRenderingContext2D, w: number, y0: number, h: number, 背景: boolean): void {
    const background = 背景;
    for (let i = 0; i < this.loops.length; i++) {
      const L = this.loops[i];
      const sel = (i === this.selected);
      const xa = this.sampleToX(L.start);
      const xb = this.sampleToX(L.end + 1);
      if (xb < -20 || xa > w + 20) continue;

      if (background) {
        ctx.fillStyle = sel ? 'rgba(255,176,64,0.13)' : 'rgba(120,150,255,0.07)';
        ctx.fillRect(xa, y0, Math.max(1, xb - xa), h);
        continue;
      }

      const col = sel ? '#ffb040' : '#7d95ff';
      ctx.lineWidth = sel ? 2 : 1;
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(Math.round(xa) + 0.5, y0); ctx.lineTo(Math.round(xa) + 0.5, y0 + h);
      ctx.moveTo(Math.round(xb) + 0.5, y0); ctx.lineTo(Math.round(xb) + 0.5, y0 + h);
      ctx.stroke();
      ctx.lineWidth = 1;

      // Flags: start points right, end points left, so they never overlap.
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(xa, y0); ctx.lineTo(xa + 9, y0 + 5); ctx.lineTo(xa, y0 + 10);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(xb, y0); ctx.lineTo(xb - 9, y0 + 5); ctx.lineTo(xb, y0 + 10);
      ctx.closePath(); ctx.fill();

      if (sel && xb - xa > 40) {
        ctx.fillStyle = 'rgba(255,176,64,0.85)';
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText('loop ' + (i + 1), xa + 12, y0 + 11);
      }
    }
  }

  _drawRuler(ctx: CanvasRenderingContext2D, w: number): void {
    const total = this.rulerHeight;
    ctx.fillStyle = '#171c23';
    ctx.fillRect(0, 0, w, total);
    ctx.strokeStyle = '#2a323d';
    ctx.beginPath();
    ctx.moveTo(0, total + 0.5); ctx.lineTo(w, total + 0.5);
    ctx.stroke();
    if (this.barRulerHeight) this._drawBarRuler(ctx, w);

    const spanSec = this.viewLength / this.sampleRate;
    const target = spanSec / (w / 90);            // ~90px between labels
    const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    let step = steps[steps.length - 1];
    for (let i = 0; i < steps.length; i++) if (steps[i] >= target) { step = steps[i]; break; }

    const t0 = Math.floor((this.viewStart / this.sampleRate) / step) * step;
    ctx.fillStyle = '#8b98a6';
    ctx.font = '10px ui-monospace, monospace';
    for (let t = t0; t * this.sampleRate <= this.viewEnd; t += step) {
      const x = Math.round(this.sampleToX(t * this.sampleRate)) + 0.5;
      if (x < 0 || x > w) continue;
      ctx.strokeStyle = '#39444f';
      ctx.beginPath(); ctx.moveTo(x, RULER_H - 6); ctx.lineTo(x, RULER_H); ctx.stroke();
      ctx.fillText(formatTime(t, step), x + 3, 11);
    }
  }

  /*
   * Bar numbers under the time ruler. Labels thin out as you zoom out - a
   * ruler that draws "17" on top of "18" is less useful than one that shows
   * every fourth bar, so the step is chosen from the pixel spacing rather
   * than fixed.
   */
  _drawBarRuler(ctx: CanvasRenderingContext2D, w: number): void {
    const y0 = RULER_H;
    const h = BAR_RULER_H;
    ctx.fillStyle = '#1c232c';
    ctx.fillRect(0, y0, w, h);
    ctx.strokeStyle = '#2a323d';
    ctx.beginPath();
    ctx.moveTo(0, y0 + 0.5); ctx.lineTo(w, y0 + 0.5);
    ctx.stroke();

    // Reached only when barRulerHeight is non-zero, which requires the grid.
    const pxPerBar = this.grid!.samplesPerBarAt(this.viewStart) * this.cssWidth / this.viewLength;
    if (!(pxPerBar > 0.5)) return;                 // too dense to mean anything
    let step = 1;
    while (pxPerBar * step < 44) step *= (step === 1 ? 2 : 2);

    const bars = this.grid!.barsIn(this.viewStart, this.viewEnd, 6000);
    ctx.font = '10px ui-monospace, monospace';
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const x = Math.round(this.sampleToX(b.sample)) + 0.5;
      if (x < -20 || x > w + 20) continue;
      const labelled = ((b.bar - 1) % step) === 0;
      ctx.strokeStyle = labelled ? '#4a5867' : '#333e4a';
      ctx.beginPath();
      ctx.moveTo(x, y0 + (labelled ? 2 : h - 5));
      ctx.lineTo(x, y0 + h);
      ctx.stroke();
      if (labelled) {
        ctx.fillStyle = '#9fb0c0';
        ctx.fillText(String(b.bar), x + 3, y0 + 11);
      }
    }

    // Mark where the playhead sits in bar terms, so the strip answers "which
    // bar am I in" without cross-referencing the readout below.
    const px = this.sampleToX(this.playhead);
    if (px >= -2 && px <= w + 2) {
      ctx.fillStyle = 'rgba(255,92,114,0.22)';
      const bs = this.sampleToX(this.grid!.barStartAt(this.playhead));
      const be = this.sampleToX(this.grid!.sampleOfBar(Math.floor(this.grid!.barAt(this.playhead) + 1e-9) + 1));
      ctx.fillRect(bs, y0 + 1, Math.max(1, be - bs), h - 1);
    }
  }

  _drawPlayhead(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const x = Math.round(this.sampleToX(this.playhead)) + 0.5;
    if (x < -1 || x > w + 1) return;
    ctx.strokeStyle = '#ff5c72';
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.fillStyle = '#ff5c72';
    ctx.beginPath();
    ctx.moveTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.lineTo(x, 6);
    ctx.closePath(); ctx.fill();
  }

  _drawOverview(): void {
    if (!this.octx) return;
    const ctx = this.octx;
    // octx only exists when the overview canvas does.
    const dim = this._prepare(this.overview!, ctx);
    const w = dim.w, h = dim.h;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0e1217';
    ctx.fillRect(0, 0, w, h);
    if (!this.channels || !this.frames) return;

    // Peaks are set alongside channels, which the guard above has checked.
    const levels = this.peaks![0];
    let lvl = levels[levels.length - 1];
    const spp = this.frames / w;
    for (let l = 0; l < levels.length; l++) { if (levels[l].bucket <= spp) lvl = levels[l]; else break; }

    const mid = h / 2, amp = h / 2 * 0.9;
    ctx.fillStyle = '#2f6b4d';
    for (let px = 0; px < w; px++) {
      const ia = Math.floor(px * this.frames / w / lvl.bucket);
      let ib = Math.ceil((px + 1) * this.frames / w / lvl.bucket);
      if (ib <= ia) ib = ia + 1;
      let lo = Infinity, hi = -Infinity;
      for (let k = ia; k < ib && k < lvl.min.length; k++) {
        if (lvl.min[k] < lo) lo = lvl.min[k];
        if (lvl.max[k] > hi) hi = lvl.max[k];
      }
      if (lo === Infinity) continue;
      const t = mid - hi * amp, b = mid - lo * amp;
      ctx.fillRect(px, t, 1, Math.max(1, b - t));
    }

    for (let i = 0; i < this.loops.length; i++) {
      const L = this.loops[i];
      const xa = L.start / this.frames * w, xb = (L.end + 1) / this.frames * w;
      ctx.fillStyle = (i === this.selected) ? 'rgba(255,176,64,0.35)' : 'rgba(125,149,255,0.25)';
      ctx.fillRect(xa, 0, Math.max(1, xb - xa), h);
    }

    const vx = this.viewStart / this.frames * w;
    const vw = this.viewLength / this.frames * w;
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(vx, 0, Math.max(2, vw), h);
    ctx.strokeStyle = '#7f8c9a';
    ctx.strokeRect(Math.round(vx) + 0.5, 0.5, Math.max(2, vw), h - 1);

    const px2 = this.playhead / this.frames * w;
    ctx.strokeStyle = '#ff5c72';
    ctx.beginPath(); ctx.moveTo(px2, 0); ctx.lineTo(px2, h); ctx.stroke();
  }

  /* ---- hit testing and mouse -------------------------------------------- */

  hitTest(x: number): Hit | null {
    let best: Hit | null = null, bestDist = HANDLE_PX + 1;
    for (let i = 0; i < this.loops.length; i++) {
      const L = this.loops[i];
      const ds = Math.abs(x - this.sampleToX(L.start));
      const de = Math.abs(x - this.sampleToX(L.end + 1));
      if (ds < bestDist) { bestDist = ds; best = { loop: i, edge: 'start' }; }
      if (de < bestDist) { bestDist = de; best = { loop: i, edge: 'end' }; }
    }
    if (best) return best;
    for (let j = this.loops.length - 1; j >= 0; j--) {
      const M = this.loops[j];
      if (x >= this.sampleToX(M.start) && x <= this.sampleToX(M.end + 1)) return { loop: j, edge: 'body' };
    }
    return null;
  }

  _localX(ev: MouseEvent, el?: Element | null): number {
    const r = (el || this.canvas).getBoundingClientRect();
    return ev.clientX - r.left;
  }

  _localY(ev: MouseEvent, el?: Element | null): number {
    const r = (el || this.canvas).getBoundingClientRect();
    return ev.clientY - r.top;
  }

  /* Which horizontal band the pointer is in. The bar strip is a click target
   * with its own meaning, so it has to be distinguished from the lanes -
   * and loop handles must not be grabbable through the ruler, or the strip
   * becomes unclickable wherever a loop edge happens to line up. */
  _band(y: number): Band {
    if (y < RULER_H) return 'time';
    if (y < this.rulerHeight) return 'bars';
    return 'lanes';
  }

  _bind(): void {
    const self = this;

    this.canvas.addEventListener('mousedown', function (ev) {
      if (!self.frames) return;
      const x = self._localX(ev);
      const mods: Mods = { alt: ev.altKey, shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey };

      if (ev.button === 1 || (ev.button === 0 && ev.shiftKey && ev.altKey)) {
        self._drag = { kind: 'pan', x: x, start: self.viewStart, end: self.viewEnd };
        ev.preventDefault();
        return;
      }
      const band = self._band(self._localY(ev));
      if (band !== 'lanes' && ev.button === 0) {
        // Clicking the bar strip means "go to that bar", not "go to the
        // nearest grid line" - the number under the cursor is the request.
        self._drag = { kind: 'seek', band: band };
        if (self.onSeek) self.onSeek(self.xToSample(x), withBand(mods, band));
        ev.preventDefault();
        return;
      }
      let hit = self.hitTest(x);
      // A loop body must NOT swallow the click: inside a long loop that would
      // make the playhead unreachable exactly where you most want to place it.
      // Edges still grab on a plain drag - they are a 6px target, not a
      // region - and moving the whole loop is shift+drag.
      if (hit && hit.edge === 'body' && !ev.shiftKey) hit = null;
      if (hit && ev.button === 0) {
        if (self.onSelect) self.onSelect(hit.loop);
        if (hit.edge === 'body') {
          self._drag = { kind: 'loop', loop: hit.loop, x: x, mods: mods, moved: false };
        } else {
          self._drag = { kind: 'point', loop: hit.loop, edge: hit.edge, mods: mods, moved: false };
          if (self.onDragPoint) self.onDragPoint(hit.loop, hit.edge, self.xToSample(x), mods);
        }
        ev.preventDefault();
        return;
      }
      if (ev.button === 0) {
        self._drag = { kind: 'seek' };
        if (self.onSeek) self.onSeek(self.xToSample(x), mods);
      }
    });

    window.addEventListener('mousemove', function (ev) {
      if (!self.frames) return;
      const x = self._localX(ev);
      const d = self._drag;
      if (!d) {
        const hit = self.hitTest(x);
        let cur = 'default';
        if (hit && hit.edge !== 'body') cur = 'ew-resize';
        else if (hit && ev.shiftKey) cur = 'grab';   // body only grabs with shift
        if (self.canvas.style.cursor !== cur) self.canvas.style.cursor = cur;
        return;
      }
      let mods: Mods = { alt: ev.altKey, shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey };
      if (d.kind === 'pan') {
        const delta = (d.x - x) * self.viewLength / self.cssWidth;
        self.setView(d.start + delta, d.end + delta);
      } else if (d.kind === 'point') {
        d.moved = true;
        if (self.onDragPoint) self.onDragPoint(d.loop, d.edge, self.xToSample(x), mods);
      } else if (d.kind === 'loop') {
        d.moved = true;
        const dx = (x - d.x) * self.viewLength / self.cssWidth;
        d.x = x;
        if (self.onDragLoop) self.onDragLoop(d.loop, dx, mods);
      } else if (d.kind === 'seek') {
        mods = withBand(mods, d.band);
        // Scrubbing snaps too - a playhead that snaps on click but slides
        // freely on drag is worse than one that never snaps, because the
        // reported position then depends on how you happened to click.
        if (self.onSeek) self.onSeek(self.xToSample(x), mods);
      }
    });

    window.addEventListener('mouseup', function () {
      if (self._drag && self.onDragEnd) self.onDragEnd(self._drag);
      self._drag = null;
    });

    this.canvas.addEventListener('wheel', function (ev) {
      if (!self.frames) return;
      ev.preventDefault();
      const x = self._localX(ev);
      if (ev.shiftKey) {
        const delta = ev.deltaY * self.viewLength / self.cssWidth;
        self.setView(self.viewStart + delta, self.viewEnd + delta);
      } else {
        const f = Math.pow(1.0015, ev.deltaY);
        self.zoomAt(self.xToSample(x), f);
      }
    }, { passive: false });

    this.canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

    if (this.overview) {
      const jump = function (ev: MouseEvent): void {
        if (!self.frames) return;
        // Only wired when the overview canvas exists.
        const r = self.overview!.getBoundingClientRect();
        const frac = (ev.clientX - r.left) / (r.width || 1);
        const centre = frac * self.frames;
        const half = self.viewLength / 2;
        self.setView(centre - half, centre + half);
      };
      this.overview.addEventListener('mousedown', function (ev) {
        jump(ev);
        const move = function (e: MouseEvent): void { jump(e); };
        const up = function (): void {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    }

    window.addEventListener('resize', function () { self.requestDraw(); });
  }
}

function withBand(mods: Mods | null | undefined, band?: Band): Mods {
  const m: Mods = { alt: false, shift: false, ctrl: false };
  if (mods) { m.alt = mods.alt; m.shift = mods.shift; m.ctrl = mods.ctrl; }
  m.band = band || 'lanes';
  return m;
}
