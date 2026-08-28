/*
 * UI glue. Owns the document state (source, loop list, grid, snap settings)
 * and wires it to the waveform view and the audio engine.
 *
 * Two conventions that everything else here depends on:
 *   - loop `end` is INCLUSIVE, exactly as stored in the `smpl` chunk.
 *   - snapping and alignment are applied to the loop BOUNDARY (end + 1), not
 *     to the inclusive end, so that an aligned start and an aligned boundary
 *     give a loop LENGTH that is a multiple of the quantum. That is the thing
 *     the SPU actually cares about; aligning the inclusive end instead would
 *     leave every loop one sample short of a whole ADPCM block.
 */
import * as Wav from './wav.js';
import { BeatGrid, TapTempo, snapSample, alignSample, psxavencSafeQuantum } from './grid.js';
import { AudioEngine, LOOP_FORWARD } from './audio.js';
import { WaveformView, buildPeaks, formatTime } from './waveform.js';

var $ = function (id) { return document.getElementById(id); };

var state = {
  name: null,
  kind: null,            // 'wav' | 'decoded'
  parsed: null,          // Wav.parseWav result, when kind === 'wav'
  channels: null,
  sampleRate: 44100,
  frames: 0,
  loops: [],
  selected: -1,
  nextId: 1,
  dirty: false
};

var grid = new BeatGrid(44100);
var tap = new TapTempo();
var engine = new AudioEngine();
var view = new WaveformView($('wave'), $('overview'));
view.grid = grid;

/* ---- helpers ----------------------------------------------------------- */

function status(msg, kind) {
  var el = $('status');
  el.textContent = msg;
  el.className = kind || '';
}

function snapOpts(mods) {
  var bypass = mods && mods.alt;
  return {
    grid: grid,
    snapToGrid: !bypass && $('snapgrid').checked,
    alignEnabled: !bypass && $('alignon').checked,
    alignQuantum: parseInt($('alignq').value, 10) || 1,
    maxSample: state.frames
  };
}

function quantum() {
  return $('alignon').checked ? (parseInt($('alignq').value, 10) || 1) : 1;
}

function selectedLoop() {
  return state.selected >= 0 ? state.loops[state.selected] : null;
}

function clampLoop(L) {
  if (L.start < 0) L.start = 0;
  if (L.end > state.frames - 1) L.end = Math.max(0, state.frames - 1);
  if (L.end < L.start + 1) L.end = Math.min(state.frames - 1, L.start + 1);
}

/* ---- source loading ---------------------------------------------------- */

function looksLikeRiff(buf) {
  if (buf.byteLength < 12) return false;
  var v = new DataView(buf);
  return v.getUint32(0, false) === 0x52494646;   // 'RIFF'
}

async function loadFile(file) {
  status('Reading ' + file.name + '...');
  var buf = await file.arrayBuffer();
  await engine.init();

  try {
    if (looksLikeRiff(buf)) {
      await loadWav(file.name, buf);
    } else {
      await loadDecoded(file.name, buf);
    }
  } catch (err) {
    console.error(err);
    status('Could not load ' + file.name + ': ' + err.message, 'err');
    return;
  }
  afterLoad();
}

async function loadWav(name, buf) {
  var parsed = Wav.parseWav(buf);
  state.name = name;
  state.kind = 'wav';
  state.parsed = parsed;
  state.channels = parsed.channels;
  state.sampleRate = parsed.sampleRate;
  state.frames = parsed.frames;

  state.loops = [];
  state.nextId = 1;
  if (parsed.smpl && parsed.smpl.loops.length) {
    for (var i = 0; i < parsed.smpl.loops.length; i++) {
      var L = parsed.smpl.loops[i];
      state.loops.push({
        id: state.nextId++,
        start: Math.min(L.start, parsed.frames - 1),
        end: Math.min(L.end, parsed.frames - 1),
        type: L.type,
        playCount: L.playCount
      });
    }
  }
}

async function loadDecoded(name, buf) {
  var audio = await engine.ctx.decodeAudioData(buf.slice(0));
  var chans = [];
  for (var c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
  state.name = name;
  state.kind = 'decoded';
  state.parsed = null;
  state.channels = chans;
  state.sampleRate = audio.sampleRate;
  state.frames = audio.length;
  state.loops = [];
  state.nextId = 1;
}

function afterLoad() {
  grid.setSampleRate(state.sampleRate);
  engine.setSource(state.channels, state.sampleRate);
  engine.setGrid(grid);

  var peaks = buildPeaks(state.channels);
  view.setSource(state.channels, peaks, state.sampleRate);
  view.loops = state.loops;
  view.selected = state.loops.length ? 0 : -1;
  state.selected = view.selected;

  // The psxavenc-safe quantum depends on the sample rate, so it can only be
  // filled in once a file is loaded.
  var safeQ = psxavencSafeQuantum(state.sampleRate, 28);
  var safeOpt = $('presetsafe');
  safeOpt.value = String(safeQ);
  safeOpt.textContent = safeQ + ' (block-aligned and whole-ms, survives psxavenc)';
  $('safenote').innerHTML = 'psxavenc rounds a loop start to whole milliseconds internally, so at '
    + state.sampleRate + ' Hz a start that is a multiple of <b>' + safeQ + '</b> samples ('
    + (safeQ * 1000 / state.sampleRate) + ' ms) is guaranteed to come back on the intended '
    + 'ADPCM block. Other values usually land one block early.';

  $('filename').textContent = state.name;
  $('export').disabled = false;
  $('export2').disabled = false;
  $('gridoffset').value = grid.offset;

  var bits = state.kind === 'wav'
    ? (state.parsed.fmt.bitsPerSample + '-bit ' +
       (state.parsed.fmt.formatTag === 3 ? 'float' : 'PCM'))
    : 'decoded by the browser';
  var chunkNames = state.kind === 'wav'
    ? state.parsed.chunks.map(function (c) { return c.id.trim(); }).join(' ')
    : '';

  $('fileinfo').innerHTML =
    span(state.sampleRate + ' Hz') +
    span(state.channels.length === 1 ? 'mono' : state.channels.length === 2 ? 'stereo' : state.channels.length + ' ch') +
    span(bits) +
    span(state.frames.toLocaleString() + ' frames') +
    span(formatTime(state.frames / state.sampleRate)) +
    (chunkNames ? span('chunks: ' + chunkNames) : '') +
    (state.kind === 'wav'
      ? span(state.parsed.smpl
          ? (state.parsed.smpl.loops.length + ' loop' + (state.parsed.smpl.loops.length === 1 ? '' : 's') + ' in smpl')
          : 'no smpl chunk', state.parsed.smpl ? 'ok' : '')
      : '');

  var msg = 'Loaded ' + state.name + '.';
  if (state.kind === 'wav' && state.parsed.smpl && state.parsed.smpl.loops.length) {
    msg += ' Found ' + state.parsed.smpl.loops.length + ' existing loop point'
      + (state.parsed.smpl.loops.length === 1 ? '' : 's') + '.';
  } else if (state.kind === 'decoded') {
    msg += ' Non-WAV source: export writes a fresh 16-bit WAV.';
  }
  if (engine.resampling) {
    msg += ' Note: output device runs at ' + engine.contextRate + ' Hz, so playback is resampled;'
      + ' the loop points themselves stay exact.';
  }
  status(msg, 'ok');

  state.dirty = false;
  syncEngineLoop();
  renderLoopList();
  view.requestDraw();
}

function span(text, cls) {
  return '<span class="' + (cls || '') + '">' + text + '</span>';
}

/* ---- loop list --------------------------------------------------------- */

function renderLoopList() {
  var ul = $('looplist');
  ul.innerHTML = '';
  var typeNames = ['fwd', 'ping-pong', 'bwd'];

  for (var i = 0; i < state.loops.length; i++) {
    var L = state.loops[i];
    var li = document.createElement('li');
    li.className = (i === state.selected ? 'sel' : '');
    li.dataset.index = String(i);
    var len = L.end - L.start + 1;
    li.innerHTML =
      '<span class="n">' + (i + 1) + '</span>' +
      '<span class="rng">' + L.start.toLocaleString() + ' &ndash; ' + L.end.toLocaleString() + '</span>' +
      '<span class="len">' + len.toLocaleString() + ' smp</span>' +
      '<span class="ty">' + (typeNames[L.type] || ('type ' + L.type)) + '</span>';
    li.addEventListener('click', function (ev) {
      selectLoop(parseInt(ev.currentTarget.dataset.index, 10));
    });
    ul.appendChild(li);
  }
  if (!state.loops.length) {
    var empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No loop points. Add one, or load a WAV that has a smpl chunk.';
    ul.appendChild(empty);
  }

  $('delloop').disabled = state.selected < 0;
  var ed = $('loopedit');
  var L2 = selectedLoop();
  if (!L2) { ed.classList.add('hidden'); return; }
  ed.classList.remove('hidden');
  $('looptype').value = String(L2.type);
  $('loopstart').value = L2.start;
  $('loopend').value = L2.end;
  updateLoopReadouts();
}

function updateLoopReadouts() {
  var L = selectedLoop();
  if (!L) return;
  var q = quantum();
  var len = L.end - L.start + 1;
  var boundary = L.end + 1;

  var startOff = q > 1 ? (L.start % q) : 0;
  var lenOff = q > 1 ? (len % q) : 0;

  $('startinfo').innerHTML =
    formatTime(L.start / state.sampleRate) +
    (grid.enabled ? '  &middot;  ' + grid.positionLabel(L.start) : '') +
    (q > 1 ? '  &middot;  ' + (startOff === 0
      ? '<span class="ok">aligned</span>'
      : '<span class="warn">+' + startOff + ' off ' + q + '</span>') : '');

  $('endinfo').innerHTML =
    formatTime((L.end + 1) / state.sampleRate) +
    (grid.enabled ? '  &middot;  ' + grid.positionLabel(boundary) : '') +
    '  &middot;  boundary ' + boundary.toLocaleString();

  var lenTxt = len.toLocaleString() + ' samples &middot; ' + formatTime(len / state.sampleRate);
  if (q > 1) {
    lenTxt += ' &middot; ' + (lenOff === 0
      ? '<span class="ok">' + (len / q) + ' &times; ' + q + '</span>'
      : '<span class="warn">' + lenOff + ' samples past a multiple of ' + q + '</span>');
  }
  if (grid.enabled) {
    var beats = len / grid.samplesPerBeat;
    lenTxt += ' &middot; ' + beats.toFixed(3) + ' beats';
  }
  $('lengthinfo').innerHTML = 'Length: ' + lenTxt;
}

function selectLoop(i) {
  state.selected = i;
  view.selected = i;
  syncEngineLoop();
  renderLoopList();
  view.requestDraw();
}

function syncEngineLoop() {
  var L = selectedLoop();
  if (L) engine.setLoop({ start: L.start, end: L.end, type: L.type }, $('loopon').checked);
  else engine.setLoop(null, false);
}

function addLoop(start, end, type) {
  var q = quantum();
  if (start === undefined) {
    start = engine.positionSamples();
    var span = Math.min(state.frames - start, Math.round(state.sampleRate));
    if (span < 2) { start = Math.max(0, state.frames - 2); span = 2; }
    end = start + span - 1;
  }
  start = alignSample(Math.max(0, start), q, 'nearest');
  var boundary = alignSample(end + 1, q, 'nearest');
  if (boundary <= start) boundary = start + q;
  var L = {
    id: state.nextId++,
    start: start,
    end: boundary - 1,
    type: type === undefined ? LOOP_FORWARD : type,
    playCount: 0
  };
  clampLoop(L);
  state.loops.push(L);
  state.dirty = true;
  selectLoop(state.loops.length - 1);
  status('Added loop ' + state.loops.length + '.');
}

function deleteLoop() {
  if (state.selected < 0) return;
  state.loops.splice(state.selected, 1);
  state.dirty = true;
  var next = Math.min(state.selected, state.loops.length - 1);
  selectLoop(next);
  status('Deleted loop.');
}

/* ---- dragging ---------------------------------------------------------- */

view.onSelect = function (i) { if (i !== state.selected) selectLoop(i); };

view.onSeek = function (sample) {
  engine.seekSamples(Math.max(0, Math.min(sample, state.frames)));
  view.playhead = engine.positionSamples();
  view.requestDraw();
  updateCursorInfo();
};

view.onDragPoint = function (index, edge, rawSample, mods) {
  var L = state.loops[index];
  if (!L) return;
  var o = snapOpts(mods);
  if (edge === 'start') {
    var r = snapSample(rawSample, o);
    L.start = Math.max(0, Math.min(r.sample, L.end - 1));
  } else {
    // Snap the exclusive boundary; the stored end is one below it.
    var rb = snapSample(rawSample, o);
    var b = Math.max(L.start + 1, Math.min(rb.sample, state.frames));
    L.end = b - 1;
  }
  clampLoop(L);
  state.dirty = true;
  if (index === state.selected) {
    syncEngineLoop();
    $('loopstart').value = L.start;
    $('loopend').value = L.end;
    updateLoopReadouts();
  }
  renderLoopListLight();
  view.requestDraw();
};

view.onDragLoop = function (index, delta, mods) {
  var L = state.loops[index];
  if (!L) return;
  var o = snapOpts(mods);
  var len = L.end - L.start + 1;
  var r = snapSample(L.start + delta, o);
  var ns = Math.max(0, Math.min(r.sample, state.frames - len));
  L.start = ns;
  L.end = ns + len - 1;
  clampLoop(L);
  state.dirty = true;
  if (index === state.selected) {
    syncEngineLoop();
    $('loopstart').value = L.start;
    $('loopend').value = L.end;
    updateLoopReadouts();
  }
  renderLoopListLight();
  view.requestDraw();
};

/* Update just the numbers in the list, without rebuilding it - rebuilding
 * mid-drag drops the mousedown target and the drag dies on the first move. */
function renderLoopListLight() {
  var items = $('looplist').querySelectorAll('li[data-index]');
  for (var i = 0; i < items.length; i++) {
    var L = state.loops[i];
    if (!L) continue;
    var rng = items[i].querySelector('.rng');
    var len = items[i].querySelector('.len');
    if (rng) rng.innerHTML = L.start.toLocaleString() + ' &ndash; ' + L.end.toLocaleString();
    if (len) len.textContent = (L.end - L.start + 1).toLocaleString() + ' smp';
  }
}

view.onDragEnd = function (d) {
  if (d && (d.kind === 'point' || d.kind === 'loop') && d.moved) renderLoopList();
};

/* ---- export ------------------------------------------------------------ */

function exportWav() {
  if (!state.channels) return;
  var loops = state.loops.map(function (L, i) {
    return { id: i, type: L.type, start: L.start, end: L.end, fraction: 0, playCount: L.playCount || 0 };
  });

  var out;
  try {
    if (state.kind === 'wav') {
      out = Wav.writeWavWithSmpl(state.parsed, loops);
    } else {
      out = Wav.encodeWav16(state.channels, state.sampleRate, loops);
    }
  } catch (err) {
    console.error(err);
    status('Export failed: ' + err.message, 'err');
    return;
  }

  var base = (state.name || 'audio').replace(/\.[^.]+$/, '');
  var blob = new Blob([out], { type: 'audio/wav' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = base + '-loop.wav';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 5000);

  state.dirty = false;
  status('Exported ' + a.download + ' with ' + loops.length + ' loop point'
    + (loops.length === 1 ? '' : 's') + '.', 'ok');
}

/* ---- readouts and the frame loop --------------------------------------- */

function updateCursorInfo() {
  if (!state.frames) { $('cursorinfo').textContent = ''; return; }
  var p = view.playhead;
  var txt = p.toLocaleString() + ' smp  ' + formatTime(p / state.sampleRate);
  if (grid.enabled) txt += '   bar ' + grid.positionLabel(p);
  var spp = view.viewLength / (view.cssWidth || 1);
  txt += '   ' + (spp < 1 ? (1 / spp).toFixed(1) + ' px/smp' : spp.toFixed(1) + ' smp/px');
  $('cursorinfo').textContent = txt;
}

function frame() {
  if (engine.ready) {
    var pos = engine.positionSamples();
    if (pos !== view.playhead) {
      view.playhead = pos;
      if ($('follow').checked && engine.playing) {
        var margin = view.viewLength * 0.1;
        if (pos < view.viewStart + margin || pos > view.viewEnd - margin) {
          var half = view.viewLength / 2;
          view.setView(pos - half, pos + half);
        }
      }
      view.requestDraw();
      updateCursorInfo();
    }
    var label = engine.playing ? 'Stop' : 'Play';
    if ($('play').textContent !== label) $('play').textContent = label;
  }
  requestAnimationFrame(frame);
}

/* ---- wiring ------------------------------------------------------------ */

$('file').addEventListener('change', function (ev) {
  if (ev.target.files && ev.target.files[0]) loadFile(ev.target.files[0]);
});

['dragenter', 'dragover'].forEach(function (t) {
  window.addEventListener(t, function (ev) { ev.preventDefault(); $('drop').classList.remove('hidden'); });
});
['dragleave', 'drop'].forEach(function (t) {
  window.addEventListener(t, function (ev) {
    ev.preventDefault();
    if (t === 'dragleave' && ev.relatedTarget) return;
    $('drop').classList.add('hidden');
  });
});
window.addEventListener('drop', function (ev) {
  if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]) loadFile(ev.dataTransfer.files[0]);
});

$('play').addEventListener('click', async function () {
  await engine.init();
  engine.toggle();
});
$('rewind').addEventListener('click', function () {
  engine.seekSamples(0);
  view.playhead = 0;
  view.requestDraw();
});
$('loopon').addEventListener('change', function () { syncEngineLoop(); });
$('volume').addEventListener('input', function () { engine.setVolume(parseFloat(this.value)); });

$('addloop').addEventListener('click', function () { if (state.frames) addLoop(); });
$('delloop').addEventListener('click', deleteLoop);
$('loopfromview').addEventListener('click', function () {
  if (!state.frames) return;
  addLoop(Math.max(0, Math.round(view.viewStart)), Math.min(state.frames - 1, Math.round(view.viewEnd)));
});

$('looptype').addEventListener('change', function () {
  var L = selectedLoop();
  if (!L) return;
  L.type = parseInt(this.value, 10);
  state.dirty = true;
  syncEngineLoop();
  renderLoopList();
});

function commitField(which) {
  var L = selectedLoop();
  if (!L) return;
  var v = parseInt($(which === 'start' ? 'loopstart' : 'loopend').value, 10);
  if (isNaN(v)) return;
  // Typed values are taken literally - this is the escape hatch from
  // snapping - but the readout flags them if they break alignment.
  if (which === 'start') L.start = Math.max(0, Math.min(v, L.end - 1));
  else L.end = Math.max(L.start + 1, Math.min(v, state.frames - 1));
  clampLoop(L);
  state.dirty = true;
  syncEngineLoop();
  renderLoopList();
  view.requestDraw();
}
$('loopstart').addEventListener('change', function () { commitField('start'); });
$('loopend').addEventListener('change', function () { commitField('end'); });

$('starthere').addEventListener('click', function () { setPointFromPlayhead('start'); });
$('endhere').addEventListener('click', function () { setPointFromPlayhead('end'); });

function setPointFromPlayhead(which) {
  var L = selectedLoop();
  if (!L) return;
  var p = engine.positionSamples();
  var o = snapOpts(null);
  if (which === 'start') {
    L.start = Math.max(0, Math.min(snapSample(p, o).sample, L.end - 1));
  } else {
    var b = Math.max(L.start + 1, Math.min(snapSample(p, o).sample, state.frames));
    L.end = b - 1;
  }
  clampLoop(L);
  state.dirty = true;
  syncEngineLoop();
  renderLoopList();
  view.requestDraw();
}

$('alignon').addEventListener('change', updateLoopReadouts);
$('alignq').addEventListener('change', updateLoopReadouts);
$('alignpreset').addEventListener('change', function () {
  if (!this.value) return;
  $('alignq').value = this.value;
  $('alignon').checked = this.value !== '1';
  this.value = '';
  updateLoopReadouts();
});

function gridChanged(redrawList) {
  grid.bpm = parseFloat($('bpm').value) || 120;
  grid.offset = parseInt($('gridoffset').value, 10) || 0;
  grid.subdivision = parseInt($('subdiv').value, 10) || 1;
  grid.beatsPerBar = parseInt($('beatsbar').value, 10) || 4;
  grid.enabled = $('gridon').checked;
  view.showGrid = grid.enabled;
  engine.gridChanged();
  if (redrawList !== false) updateLoopReadouts();
  updateCursorInfo();
  view.requestDraw();
}

['bpm', 'gridoffset', 'subdiv', 'beatsbar'].forEach(function (id) {
  $(id).addEventListener('input', function () { gridChanged(); });
});
$('gridon').addEventListener('change', function () { gridChanged(); });
$('metro').addEventListener('change', function () { engine.setMetronome(this.checked); });
$('metrovol').addEventListener('input', function () { engine.setMetronomeVolume(parseFloat(this.value)); });

function nudge(n) {
  $('gridoffset').value = (parseInt($('gridoffset').value, 10) || 0) + n;
  gridChanged();
}
$('nudgeminus').addEventListener('click', function () { nudge(-nudgeStep()); });
$('nudgeplus').addEventListener('click', function () { nudge(nudgeStep()); });
$('nudgeminus10').addEventListener('click', function () { nudge(-nudgeStep() * 10); });
$('nudgeplus10').addEventListener('click', function () { nudge(nudgeStep() * 10); });
function nudgeStep() { return Math.max(1, Math.round(state.sampleRate / 1000)); }  // 1 ms

$('gridhere').addEventListener('click', function () {
  $('gridoffset').value = engine.positionSamples();
  gridChanged();
});

function doTap() {
  var r = tap.tap(performance.now());
  if (!r) { $('tapinfo').textContent = 'tap again...'; return; }
  $('bpm').value = r.bpm.toFixed(3);
  $('tapinfo').textContent = r.taps + ' taps  ->  ' + r.bpm.toFixed(2) + ' BPM';
  gridChanged();
}
$('tap').addEventListener('click', doTap);

$('export').addEventListener('click', exportWav);
$('export2').addEventListener('click', exportWav);

$('zoomin').addEventListener('click', function () { view.zoomAt(view.playhead, 0.5); });
$('zoomout').addEventListener('click', function () { view.zoomAt(view.playhead, 2); });
$('fit').addEventListener('click', function () { view.fit(); });
$('zoomloop').addEventListener('click', function () { view.zoomToLoop(selectedLoop()); });
view.onView = function () { updateCursorInfo(); };

$('help').addEventListener('click', function () { $('helpbox').classList.toggle('hidden'); });
$('helpclose').addEventListener('click', function () { $('helpbox').classList.add('hidden'); });

window.addEventListener('keydown', function (ev) {
  var t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
    if (ev.key === 'Escape') t.blur();
    return;
  }
  switch (ev.key) {
    case ' ':
      ev.preventDefault();
      engine.init().then(function () { engine.toggle(); });
      break;
    case 'l': case 'L':
      $('loopon').checked = !$('loopon').checked;
      syncEngineLoop();
      break;
    case 's': case 'S': setPointFromPlayhead('start'); break;
    case 'e': case 'E': setPointFromPlayhead('end'); break;
    case 'a': case 'A': if (state.frames) addLoop(); break;
    case 't': case 'T': doTap(); break;
    case 'm': case 'M':
      $('metro').checked = !$('metro').checked;
      engine.setMetronome($('metro').checked);
      break;
    case 'Delete': case 'Backspace': deleteLoop(); break;
    case 'Home': engine.seekSamples(0); view.playhead = 0; view.requestDraw(); break;
    case '+': case '=': view.zoomAt(view.playhead, 0.5); break;
    case '-': case '_': view.zoomAt(view.playhead, 2); break;
    case '0': view.fit(); break;
    case 'ArrowLeft': case 'ArrowRight': {
      var dir = ev.key === 'ArrowLeft' ? -1 : 1;
      var amount = view.viewLength * (ev.shiftKey ? 0.9 : 0.1) * dir;
      view.setView(view.viewStart + amount, view.viewEnd + amount);
      break;
    }
    default: return;
  }
});

window.addEventListener('beforeunload', function (ev) {
  if (state.dirty) { ev.preventDefault(); ev.returnValue = ''; }
});

engine.setGrid(grid);
gridChanged();
renderLoopList();
requestAnimationFrame(frame);
status('Ready. Open a .wav (or drop one anywhere) to start.');

/*
 * Handle for the console and for the browser test. Exposed on purpose: the
 * e2e test needs the exact pixel position of a loop handle to drag it, and
 * guessing a position instead produced a test that grabbed the loop BODY and
 * still reported a passing "dragged the start handle" check.
 */
window.__loopeditor = { state: state, view: view, engine: engine, grid: grid, Wav: Wav };
