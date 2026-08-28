/*
 * Waveform display and mouse interaction.
 *
 * The peak pyramid is the only reason this stays responsive: a zoomed-out
 * five-minute stereo file is ~26M reads per redraw if you scan raw samples,
 * which is a visibly janky drag. Levels are built once on load (base bucket
 * 256, doubling) and the renderer picks the coarsest level that still has at
 * least one bucket per pixel column. Below 256 samples/pixel it reads raw.
 */

var BASE_BUCKET = 256;

export function buildPeaks(channels) {
  var out = [];
  for (var c = 0; c < channels.length; c++) {
    var data = channels[c];
    var levels = [];
    var n = Math.ceil(data.length / BASE_BUCKET);
    var mn = new Float32Array(n), mx = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var s = i * BASE_BUCKET, e = Math.min(s + BASE_BUCKET, data.length);
      var lo = Infinity, hi = -Infinity;
      for (var j = s; j < e; j++) { var v = data[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (lo === Infinity) { lo = 0; hi = 0; }
      mn[i] = lo; mx[i] = hi;
    }
    levels.push({ bucket: BASE_BUCKET, min: mn, max: mx });

    while (levels[levels.length - 1].min.length > 2) {
      var prev = levels[levels.length - 1];
      var m = Math.ceil(prev.min.length / 2);
      var pmn = new Float32Array(m), pmx = new Float32Array(m);
      for (var k = 0; k < m; k++) {
        var a = k * 2, b = Math.min(a + 1, prev.min.length - 1);
        pmn[k] = Math.min(prev.min[a], prev.min[b]);
        pmx[k] = Math.max(prev.max[a], prev.max[b]);
      }
      levels.push({ bucket: prev.bucket * 2, min: pmn, max: pmx });
    }
    out.push(levels);
  }
  return out;
}

var RULER_H = 22;
var HANDLE_PX = 6;      // grab radius for a loop edge

export class WaveformView {
  constructor(canvas, overviewCanvas) {
    this.canvas = canvas;
    this.overview = overviewCanvas;
    this.ctx = canvas.getContext('2d');
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
    this.onSeek = null;             // (sample)
    this.onDragPoint = null;        // (loopIndex, edge, sample, modifiers)
    this.onDragLoop = null;         // (loopIndex, deltaSamples, modifiers)
    this.onDragEnd = null;
    this.onSelect = null;           // (loopIndex)
    this.onView = null;             // () -> view changed

    this._drag = null;
    this._raf = null;
    this._bind();
  }

  setSource(channels, peaks, sampleRate) {
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

  get cssWidth() { return this.canvas.clientWidth || 1; }
  get cssHeight() { return this.canvas.clientHeight || 1; }
  get viewLength() { return Math.max(1, this.viewEnd - this.viewStart); }

  sampleToX(s) { return (s - this.viewStart) * this.cssWidth / this.viewLength; }
  xToSample(x) { return this.viewStart + x * this.viewLength / this.cssWidth; }

  setView(start, end) {
    var minLen = 16;
    if (end - start < minLen) end = start + minLen;
    if (start < 0) { end -= start; start = 0; }
    if (this.frames && end > this.frames) {
      var over = end - this.frames;
      end = this.frames;
      start = Math.max(0, start - over);
    }
    this.viewStart = start;
    this.viewEnd = end;
    if (this.onView) this.onView();
    this.requestDraw();
  }

  zoomAt(sample, factor) {
    var left = sample - this.viewStart;
    var right = this.viewEnd - sample;
    this.setView(sample - left * factor, sample + right * factor);
  }

  fit() { this.setView(0, this.frames || 1); }

  zoomToLoop(loop, pad) {
    if (!loop) return;
    var len = Math.max(16, loop.end - loop.start);
    var p = (pad === undefined ? 0.15 : pad) * len;
    this.setView(loop.start - p, loop.end + p);
  }

  /* ---- drawing ---------------------------------------------------------- */

  requestDraw() {
    if (this._raf) return;
    var self = this;
    this._raf = requestAnimationFrame(function () { self._raf = null; self.draw(); });
  }

  _prepare(canvas, ctx) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h };
  }

  draw() {
    var ctx = this.ctx;
    var dim = this._prepare(this.canvas, ctx);
    var w = dim.w, h = dim.h;

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

    var lanesTop = RULER_H;
    var lanesH = h - RULER_H;
    var nch = this.channels.length;
    var laneH = lanesH / nch;

    this._drawLoopBands(ctx, w, lanesTop, lanesH, true);
    if (this.showGrid && this.grid) this._drawGrid(ctx, w, lanesTop, lanesH);

    for (var c = 0; c < nch; c++) {
      this._drawChannel(ctx, c, 0, lanesTop + c * laneH, w, laneH);
    }

    this._drawLoopBands(ctx, w, lanesTop, lanesH, false);
    this._drawRuler(ctx, w);
    this._drawPlayhead(ctx, w, h);
    this._drawOverview();
  }

  _drawChannel(ctx, ch, x0, y0, w, h) {
    var mid = y0 + h / 2;
    var amp = (h / 2) * 0.92;

    ctx.strokeStyle = '#232a33';
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(mid) + 0.5);
    ctx.lineTo(x0 + w, Math.round(mid) + 0.5);
    ctx.stroke();

    var spp = this.viewLength / w;
    var data = this.channels[ch];
    var levels = this.peaks[ch];

    ctx.fillStyle = '#4fd08a';
    if (spp < BASE_BUCKET) {
      // Fine zoom: read raw samples.
      if (spp < 0.25) {
        // Very fine: draw the actual sample line, with dots per sample.
        ctx.strokeStyle = '#4fd08a';
        ctx.beginPath();
        var first = Math.max(0, Math.floor(this.viewStart) - 1);
        var last = Math.min(data.length - 1, Math.ceil(this.viewEnd) + 1);
        for (var s = first; s <= last; s++) {
          var px = this.sampleToX(s);
          var py = mid - data[s] * amp;
          if (s === first) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        if (spp < 0.08) {
          for (var s2 = first; s2 <= last; s2++) {
            ctx.fillRect(this.sampleToX(s2) - 1.5, mid - data[s2] * amp - 1.5, 3, 3);
          }
        }
        return;
      }
      for (var px2 = 0; px2 < w; px2++) {
        var a = Math.max(0, Math.floor(this.xToSample(px2)));
        var b = Math.min(data.length, Math.ceil(this.xToSample(px2 + 1)));
        if (b <= a) b = a + 1;
        var lo = Infinity, hi = -Infinity;
        for (var i = a; i < b && i < data.length; i++) { var v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (lo === Infinity) continue;
        var yTop = mid - hi * amp, yBot = mid - lo * amp;
        ctx.fillRect(x0 + px2, yTop, 1, Math.max(1, yBot - yTop));
      }
      return;
    }

    // Coarse zoom: coarsest pyramid level with >= 1 bucket per pixel.
    var lvl = levels[0];
    for (var l = 0; l < levels.length; l++) {
      if (levels[l].bucket <= spp) lvl = levels[l]; else break;
    }
    var bucket = lvl.bucket;
    for (var px3 = 0; px3 < w; px3++) {
      var sa = this.xToSample(px3) / bucket;
      var sb = this.xToSample(px3 + 1) / bucket;
      var ia = Math.max(0, Math.floor(sa));
      var ib = Math.min(lvl.min.length, Math.ceil(sb));
      if (ib <= ia) ib = ia + 1;
      var lo2 = Infinity, hi2 = -Infinity;
      for (var k = ia; k < ib && k < lvl.min.length; k++) {
        if (lvl.min[k] < lo2) lo2 = lvl.min[k];
        if (lvl.max[k] > hi2) hi2 = lvl.max[k];
      }
      if (lo2 === Infinity) continue;
      var t = mid - hi2 * amp, bt = mid - lo2 * amp;
      ctx.fillRect(x0 + px3, t, 1, Math.max(1, bt - t));
    }
  }

  _drawGrid(ctx, w, y0, h) {
    var lines = this.grid.linesIn(this.viewStart, this.viewEnd, 4000);
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      var x = Math.round(this.sampleToX(L.sample)) + 0.5;
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

  _drawLoopBands(ctx, w, y0, h,背景) {
    var background = 背景;
    for (var i = 0; i < this.loops.length; i++) {
      var L = this.loops[i];
      var sel = (i === this.selected);
      var xa = this.sampleToX(L.start);
      var xb = this.sampleToX(L.end + 1);
      if (xb < -20 || xa > w + 20) continue;

      if (background) {
        ctx.fillStyle = sel ? 'rgba(255,176,64,0.13)' : 'rgba(120,150,255,0.07)';
        ctx.fillRect(xa, y0, Math.max(1, xb - xa), h);
        continue;
      }

      var col = sel ? '#ffb040' : '#7d95ff';
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

  _drawRuler(ctx, w) {
    ctx.fillStyle = '#171c23';
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = '#2a323d';
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + 0.5); ctx.lineTo(w, RULER_H + 0.5);
    ctx.stroke();

    var spanSec = this.viewLength / this.sampleRate;
    var target = spanSec / (w / 90);            // ~90px between labels
    var steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    var step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) if (steps[i] >= target) { step = steps[i]; break; }

    var t0 = Math.floor((this.viewStart / this.sampleRate) / step) * step;
    ctx.fillStyle = '#8b98a6';
    ctx.font = '10px ui-monospace, monospace';
    for (var t = t0; t * this.sampleRate <= this.viewEnd; t += step) {
      var x = Math.round(this.sampleToX(t * this.sampleRate)) + 0.5;
      if (x < 0 || x > w) continue;
      ctx.strokeStyle = '#39444f';
      ctx.beginPath(); ctx.moveTo(x, RULER_H - 6); ctx.lineTo(x, RULER_H); ctx.stroke();
      ctx.fillText(formatTime(t, step), x + 3, 11);
    }
  }

  _drawPlayhead(ctx, w, h) {
    var x = Math.round(this.sampleToX(this.playhead)) + 0.5;
    if (x < -1 || x > w + 1) return;
    ctx.strokeStyle = '#ff5c72';
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.fillStyle = '#ff5c72';
    ctx.beginPath();
    ctx.moveTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.lineTo(x, 6);
    ctx.closePath(); ctx.fill();
  }

  _drawOverview() {
    if (!this.octx) return;
    var ctx = this.octx;
    var dim = this._prepare(this.overview, ctx);
    var w = dim.w, h = dim.h;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0e1217';
    ctx.fillRect(0, 0, w, h);
    if (!this.channels || !this.frames) return;

    var levels = this.peaks[0];
    var lvl = levels[levels.length - 1];
    var spp = this.frames / w;
    for (var l = 0; l < levels.length; l++) { if (levels[l].bucket <= spp) lvl = levels[l]; else break; }

    var mid = h / 2, amp = h / 2 * 0.9;
    ctx.fillStyle = '#2f6b4d';
    for (var px = 0; px < w; px++) {
      var ia = Math.floor(px * this.frames / w / lvl.bucket);
      var ib = Math.ceil((px + 1) * this.frames / w / lvl.bucket);
      if (ib <= ia) ib = ia + 1;
      var lo = Infinity, hi = -Infinity;
      for (var k = ia; k < ib && k < lvl.min.length; k++) {
        if (lvl.min[k] < lo) lo = lvl.min[k];
        if (lvl.max[k] > hi) hi = lvl.max[k];
      }
      if (lo === Infinity) continue;
      var t = mid - hi * amp, b = mid - lo * amp;
      ctx.fillRect(px, t, 1, Math.max(1, b - t));
    }

    for (var i = 0; i < this.loops.length; i++) {
      var L = this.loops[i];
      var xa = L.start / this.frames * w, xb = (L.end + 1) / this.frames * w;
      ctx.fillStyle = (i === this.selected) ? 'rgba(255,176,64,0.35)' : 'rgba(125,149,255,0.25)';
      ctx.fillRect(xa, 0, Math.max(1, xb - xa), h);
    }

    var vx = this.viewStart / this.frames * w;
    var vw = this.viewLength / this.frames * w;
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(vx, 0, Math.max(2, vw), h);
    ctx.strokeStyle = '#7f8c9a';
    ctx.strokeRect(Math.round(vx) + 0.5, 0.5, Math.max(2, vw), h - 1);

    var px2 = this.playhead / this.frames * w;
    ctx.strokeStyle = '#ff5c72';
    ctx.beginPath(); ctx.moveTo(px2, 0); ctx.lineTo(px2, h); ctx.stroke();
  }

  /* ---- hit testing and mouse -------------------------------------------- */

  hitTest(x) {
    var best = null, bestDist = HANDLE_PX + 1;
    for (var i = 0; i < this.loops.length; i++) {
      var L = this.loops[i];
      var ds = Math.abs(x - this.sampleToX(L.start));
      var de = Math.abs(x - this.sampleToX(L.end + 1));
      if (ds < bestDist) { bestDist = ds; best = { loop: i, edge: 'start' }; }
      if (de < bestDist) { bestDist = de; best = { loop: i, edge: 'end' }; }
    }
    if (best) return best;
    for (var j = this.loops.length - 1; j >= 0; j--) {
      var M = this.loops[j];
      if (x >= this.sampleToX(M.start) && x <= this.sampleToX(M.end + 1)) return { loop: j, edge: 'body' };
    }
    return null;
  }

  _localX(ev, el) {
    var r = (el || this.canvas).getBoundingClientRect();
    return ev.clientX - r.left;
  }

  _bind() {
    var self = this;

    this.canvas.addEventListener('mousedown', function (ev) {
      if (!self.frames) return;
      var x = self._localX(ev);
      var mods = { alt: ev.altKey, shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey };

      if (ev.button === 1 || (ev.button === 0 && ev.shiftKey && ev.altKey)) {
        self._drag = { kind: 'pan', x: x, start: self.viewStart, end: self.viewEnd };
        ev.preventDefault();
        return;
      }
      var hit = self.hitTest(x);
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
        if (self.onSeek) self.onSeek(Math.round(self.xToSample(x)));
      }
    });

    window.addEventListener('mousemove', function (ev) {
      if (!self.frames) return;
      var x = self._localX(ev);
      var d = self._drag;
      if (!d) {
        var hit = self.hitTest(x);
        var cur = 'default';
        if (hit && hit.edge !== 'body') cur = 'ew-resize';
        else if (hit && ev.shiftKey) cur = 'grab';   // body only grabs with shift
        if (self.canvas.style.cursor !== cur) self.canvas.style.cursor = cur;
        return;
      }
      var mods = { alt: ev.altKey, shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey };
      if (d.kind === 'pan') {
        var delta = (d.x - x) * self.viewLength / self.cssWidth;
        self.setView(d.start + delta, d.end + delta);
      } else if (d.kind === 'point') {
        d.moved = true;
        if (self.onDragPoint) self.onDragPoint(d.loop, d.edge, self.xToSample(x), mods);
      } else if (d.kind === 'loop') {
        d.moved = true;
        var dx = (x - d.x) * self.viewLength / self.cssWidth;
        d.x = x;
        if (self.onDragLoop) self.onDragLoop(d.loop, dx, mods);
      } else if (d.kind === 'seek') {
        if (self.onSeek) self.onSeek(Math.round(self.xToSample(x)));
      }
    });

    window.addEventListener('mouseup', function () {
      if (self._drag && self.onDragEnd) self.onDragEnd(self._drag);
      self._drag = null;
    });

    this.canvas.addEventListener('wheel', function (ev) {
      if (!self.frames) return;
      ev.preventDefault();
      var x = self._localX(ev);
      if (ev.shiftKey) {
        var delta = ev.deltaY * self.viewLength / self.cssWidth;
        self.setView(self.viewStart + delta, self.viewEnd + delta);
      } else {
        var f = Math.pow(1.0015, ev.deltaY);
        self.zoomAt(self.xToSample(x), f);
      }
    }, { passive: false });

    this.canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

    if (this.overview) {
      var jump = function (ev) {
        if (!self.frames) return;
        var r = self.overview.getBoundingClientRect();
        var frac = (ev.clientX - r.left) / (r.width || 1);
        var centre = frac * self.frames;
        var half = self.viewLength / 2;
        self.setView(centre - half, centre + half);
      };
      this.overview.addEventListener('mousedown', function (ev) {
        jump(ev);
        var move = function (e) { jump(e); };
        var up = function () {
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

export function formatTime(sec, step) {
  var neg = sec < 0;
  if (neg) sec = -sec;
  var decimals = (step === undefined) ? 3 : (step < 0.01 ? 3 : step < 1 ? 2 : 0);
  var m = Math.floor(sec / 60);
  var s = sec - m * 60;
  var str = m + ':' + (s < 10 ? '0' : '') + s.toFixed(decimals);
  return (neg ? '-' : '') + str;
}
