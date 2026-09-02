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
import './style.css';
import * as Wav from './core/wav.js';
import type { ParsedWav } from './core/wav.js';
import { BeatGrid, TapTempo, snapSample, alignSample, psxavencSafeQuantum } from './core/grid.js';
import type { SnapOptions } from './core/grid.js';
import { AudioEngine, LOOP_FORWARD } from './ui/audio.js';
import { WaveformView } from './ui/waveform.js';
import { buildPeaksAsync } from './core/peaks.js';
import { formatTime } from './core/time.js';
import * as Band from './core/band.js';
import * as Logic from './core/logicsong.js';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** One entry of `state.loops`; `end` is INCLUSIVE, as above. */
export interface Loop {
  id: number;
  start: number;
  end: number;
  type: number;
  playCount: number;
}

/** Modifier/hit-test flags the waveform view passes back with an interaction. */
interface DragMods {
  alt?: boolean;
  band?: string;
}

/** What onDragEnd receives. */
interface DragEndInfo {
  kind?: string;
  moved?: boolean;
}

/** The subset of a GarageBand MetaData.plist this file reads. */
interface BandMetadata {
  bpm?: number;
  beatsPerBar?: number;
  beatUnit?: number;
  key?: string;
  mode?: string;
  sampleRate?: number;
  tracks?: number;
}

export interface AppState {
  name: string | null;
  kind: 'wav' | 'decoded' | null;
  parsed: ParsedWav | null;
  channels: Float32Array[] | null;
  sampleRate: number;
  frames: number;
  loops: Loop[];
  selected: number;
  nextId: number;
  dirty: boolean;
}

const state: AppState = {
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

const grid = new BeatGrid(44100);
const tap = new TapTempo();
const engine = new AudioEngine();
const view = new WaveformView($<HTMLCanvasElement>('wave'), $<HTMLCanvasElement>('overview'));
view.grid = grid;

/* ---- helpers ----------------------------------------------------------- */

function status(msg: string, kind?: string): void {
  const el = $('status');
  el.textContent = msg;
  el.className = kind || '';
}

function snapOpts(mods: DragMods | null | undefined): SnapOptions {
  const bypass = mods && mods.alt;
  return {
    grid: grid,
    snapToGrid: !bypass && $<HTMLInputElement>('snapgrid').checked,
    alignEnabled: !bypass && $<HTMLInputElement>('alignon').checked,
    alignQuantum: parseInt($<HTMLInputElement>('alignq').value, 10) || 1,
    maxSample: state.frames
  };
}

function quantum(): number {
  return $<HTMLInputElement>('alignon').checked ? (parseInt($<HTMLInputElement>('alignq').value, 10) || 1) : 1;
}

function selectedLoop(): Loop | null {
  return state.selected >= 0 ? state.loops[state.selected] : null;
}

function clampLoop(L: Loop): void {
  if (L.start < 0) L.start = 0;
  if (L.end > state.frames - 1) L.end = Math.max(0, state.frames - 1);
  if (L.end < L.start + 1) L.end = Math.min(state.frames - 1, L.start + 1);
}

/* ---- busy overlay ------------------------------------------------------ */

/*
 * Shown only after SHOW_AFTER_MS, so a short file that loads instantly does
 * not flash a spinner - a overlay that blinks on every small file trains you
 * to ignore it.
 *
 * `fraction` may be null, which renders as an indeterminate sweep rather than
 * a made-up percentage. decodeAudioData reports no progress at all (the API
 * has no callback and the work happens off-thread), so the decode phase is
 * honestly indeterminate; the waveform build afterwards is our own code and
 * is a real fraction.
 */
const SHOW_AFTER_MS = 180;
let busyTimer: ReturnType<typeof setTimeout> | null = null;

function busyShow(phase: string, note: string): void {
  busySet(phase, null, note);
  if (busyTimer || !$('busy').classList.contains('hidden')) return;
  busyTimer = setTimeout(function () {
    busyTimer = null;
    $('busy').classList.remove('hidden');
  }, SHOW_AFTER_MS);
}

function busySet(phase: string | null | undefined, fraction: number | null | undefined, note?: string): void {
  if (phase !== undefined && phase !== null) $('busyphase').textContent = phase;
  // `fraction` is accepted and deliberately not rendered as a bar. It still
  // drives the note, so the waveform build shows a percentage in text without
  // a second progress widget to maintain.
  if (note !== undefined) $('busynote').textContent = note || '';
}

function busyHide(): void {
  if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
  $('busy').classList.add('hidden');
}

/* Let the browser paint before starting a blocking stretch. Without this the
 * overlay is only made visible in the DOM and never actually drawn. */
function paint(): Promise<void> {
  return new Promise<void>(function (r) {
    requestAnimationFrame(function () { requestAnimationFrame(function () { r(); }); });
  });
}

function prettySize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

/* ---- source loading ---------------------------------------------------- */

function looksLikeRiff(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false;
  const v = new DataView(buf);
  return v.getUint32(0, false) === 0x52494646;   // 'RIFF'
}

async function loadFile(file: File): Promise<void> {
  status('Reading ' + file.name + '...');
  busyShow('Reading ' + file.name, prettySize(file.size));
  try {
    const buf = await file.arrayBuffer();
    await engine.init();

    if (looksLikeRiff(buf)) {
      // Our own parser, and fast - but a very large WAV still takes a moment,
      // so the overlay is not gated on the format. Naoki asked for it on
      // conversions; a 40-minute WAV deserves it just as much.
      busySet('Reading WAV', null, prettySize(file.size));
      await paint();
      await loadWav(file.name, buf);
    } else {
      const ext = (/\.([a-z0-9]+)$/i.exec(file.name) || [, 'audio'])[1].toLowerCase();
      busySet('Decoding ' + ext.toUpperCase(), null,
        'the browser reports no progress for this step');
      await paint();
      await loadDecoded(file.name, buf);
    }
    await afterLoad();
  } catch (err) {
    console.error(err);
    status('Could not load ' + file.name + ': ' + (err as Error).message, 'err');
    return;
  } finally {
    busyHide();
  }
}

async function loadWav(name: string, buf: ArrayBuffer): Promise<void> {
  const parsed = Wav.parseWav(buf);
  state.name = name;
  state.kind = 'wav';
  state.parsed = parsed;
  state.channels = parsed.channels;
  state.sampleRate = parsed.sampleRate;
  state.frames = parsed.frames;

  state.loops = [];
  state.nextId = 1;
  if (parsed.smpl && parsed.smpl.loops.length) {
    for (let i = 0; i < parsed.smpl.loops.length; i++) {
      const L = parsed.smpl.loops[i];
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

/*
 * Decode on a THROWAWAY OfflineAudioContext, never on the playback context.
 *
 * The playback AudioContext is suspended until a user gesture starts it, and
 * a decode issued on a suspended context does not reliably call back - on
 * macOS Safari it simply never resolves. The symptom is vicious: the first
 * non-WAV file appears to hang forever, and then loading a SECOND file
 * supplies a fresh gesture, the context starts, and the stalled first decode
 * completes. It looks like a race, it is actually a decode waiting on an
 * unrelated event. WAV never showed it because our own parser never touches
 * the context.
 *
 * An OfflineAudioContext is not subject to the autoplay policy and needs no
 * gesture, so the decode is independent of playback state entirely.
 *
 * The known cost, stated rather than hidden: decodeAudioData resamples to the
 * decoding context's rate, so a non-WAV file is resampled on import. There is
 * no way to learn a compressed file's native rate without decoding it first.
 */
function makeDecoder(): BaseAudioContext {
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (Off) {
    const rate = (engine.ctx && engine.ctx.sampleRate) || 44100;
    try { return new Off(1, 1, rate); } catch (e) { /* fall through */ }
  }
  return engine.ctx!;   // last resort; the original behaviour
}

function decodeWithTimeout(ctx: BaseAudioContext, buf: ArrayBuffer, ms: number): Promise<AudioBuffer> {
  // A decode that never settles must not present as an eternal spinner. If
  // this fires it is a bug worth reporting, so say so rather than failing
  // vaguely.
  return new Promise<AudioBuffer>(function (resolve, reject) {
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error('the decoder did not respond within ' + Math.round(ms / 1000) +
        's - this is a bug, please say which format and browser'));
    }, ms);
    const done = function (b: AudioBuffer) { if (settled) return; settled = true; clearTimeout(timer); resolve(b); };
    const fail = function (e: DOMException | null) {
      if (settled) return; settled = true; clearTimeout(timer);
      reject(e || new Error('the browser could not decode this file'));
    };
    // Both the promise and the callback forms - older Safari only has the latter.
    const r = ctx.decodeAudioData(buf, done, fail);
    if (r && typeof r.then === 'function') r.then(done, fail);
  });
}

async function loadDecoded(name: string, buf: ArrayBuffer): Promise<void> {
  const audio = await decodeWithTimeout(makeDecoder(), buf.slice(0), 120000);
  const chans: Float32Array[] = [];
  for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
  state.name = name;
  state.kind = 'decoded';
  state.parsed = null;
  state.channels = chans;
  state.sampleRate = audio.sampleRate;
  state.frames = audio.length;
  state.loops = [];
  state.nextId = 1;
}

async function afterLoad(): Promise<void> {
  grid.setSampleRate(state.sampleRate);
  engine.setSource(state.channels!, state.sampleRate);
  engine.setGrid(grid);

  busySet('Building waveform', 0,
    state.frames.toLocaleString() + ' frames x ' + state.channels!.length + ' ch');
  await paint();
  const peaks = await buildPeaksAsync(state.channels!, function (f: number) {
    busySet(null, f, Math.round(f * 100) + '%');
  });
  view.setSource(state.channels!, peaks, state.sampleRate);
  view.loops = state.loops;
  view.selected = state.loops.length ? 0 : -1;
  state.selected = view.selected;

  // The psxavenc-safe quantum depends on the sample rate, so it can only be
  // filled in once a file is loaded.
  const safeQ = psxavencSafeQuantum(state.sampleRate, 28);
  const safeOpt = $<HTMLOptionElement>('presetsafe');
  safeOpt.value = String(safeQ);
  safeOpt.textContent = safeQ + ' (block-aligned and whole-ms, survives psxavenc)';
  $('safenote').innerHTML = 'psxavenc rounds a loop start to whole milliseconds internally, so at '
    + state.sampleRate + ' Hz a start that is a multiple of <b>' + safeQ + '</b> samples ('
    + (safeQ * 1000 / state.sampleRate) + ' ms) is guaranteed to come back on the intended '
    + 'ADPCM block. Other values usually land one block early.';

  $('filename').textContent = state.name;
  $<HTMLButtonElement>('export').disabled = false;
  $<HTMLButtonElement>('export2').disabled = false;
  $<HTMLInputElement>('gridoffset').value = String(grid.offset);

  const bits = state.kind === 'wav'
    ? (state.parsed!.fmt.bitsPerSample + '-bit ' +
       (state.parsed!.fmt.formatTag === 3 ? 'float' : 'PCM'))
    : 'decoded by the browser';
  const chunkNames = state.kind === 'wav'
    ? state.parsed!.chunks.map(function (c) { return c.id.trim(); }).join(' ')
    : '';

  $('fileinfo').innerHTML =
    span(state.sampleRate + ' Hz') +
    span(state.channels!.length === 1 ? 'mono' : state.channels!.length === 2 ? 'stereo' : state.channels!.length + ' ch') +
    span(bits) +
    span(state.frames.toLocaleString() + ' frames') +
    span(formatTime(state.frames / state.sampleRate)) +
    (chunkNames ? span('chunks: ' + chunkNames) : '') +
    (state.kind === 'wav'
      ? span(state.parsed!.smpl
          ? (state.parsed!.smpl.loops.length + ' loop' + (state.parsed!.smpl.loops.length === 1 ? '' : 's') + ' in smpl')
          : 'no smpl chunk', state.parsed!.smpl ? 'ok' : '')
      : '');

  let msg = 'Loaded ' + state.name + '.';
  if (state.kind === 'wav' && state.parsed!.smpl && state.parsed!.smpl.loops.length) {
    msg += ' Found ' + state.parsed!.smpl.loops.length + ' existing loop point'
      + (state.parsed!.smpl.loops.length === 1 ? '' : 's') + '.';
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

function span(text: string, cls?: string): string {
  return '<span class="' + (cls || '') + '">' + text + '</span>';
}

/* ---- loop list --------------------------------------------------------- */

function renderLoopList(): void {
  const ul = $('looplist');
  ul.innerHTML = '';
  const typeNames = ['fwd', 'ping-pong', 'bwd'];

  for (let i = 0; i < state.loops.length; i++) {
    const L = state.loops[i];
    const li = document.createElement('li');
    li.className = (i === state.selected ? 'sel' : '');
    li.dataset.index = String(i);
    const len = L.end - L.start + 1;
    li.innerHTML =
      '<span class="n">' + (i + 1) + '</span>' +
      '<span class="rng">' + L.start.toLocaleString() + ' &ndash; ' + L.end.toLocaleString() + '</span>' +
      '<span class="len">' + len.toLocaleString() + ' smp</span>' +
      '<span class="ty">' + (typeNames[L.type] || ('type ' + L.type)) + '</span>';
    li.addEventListener('click', function (ev: MouseEvent) {
      selectLoop(parseInt((ev.currentTarget as HTMLElement).dataset.index!, 10));
    });
    ul.appendChild(li);
  }
  if (!state.loops.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No loop points. Add one, or load a WAV that has a smpl chunk.';
    ul.appendChild(empty);
  }

  $<HTMLButtonElement>('delloop').disabled = state.selected < 0;
  const ed = $('loopedit');
  const L2 = selectedLoop();
  if (!L2) { ed.classList.add('hidden'); return; }
  ed.classList.remove('hidden');
  $<HTMLSelectElement>('looptype').value = String(L2.type);
  $<HTMLInputElement>('loopstart').value = String(L2.start);
  $<HTMLInputElement>('loopend').value = String(L2.end);
  updateLoopReadouts();
}

function updateLoopReadouts(): void {
  const L = selectedLoop();
  if (!L) return;
  const q = quantum();
  const len = L.end - L.start + 1;
  const boundary = L.end + 1;

  const startOff = q > 1 ? (L.start % q) : 0;
  const lenOff = q > 1 ? (len % q) : 0;

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

  let lenTxt = len.toLocaleString() + ' samples &middot; ' + formatTime(len / state.sampleRate);
  if (q > 1) {
    lenTxt += ' &middot; ' + (lenOff === 0
      ? '<span class="ok">' + (len / q) + ' &times; ' + q + '</span>'
      : '<span class="warn">' + lenOff + ' samples past a multiple of ' + q + '</span>');
  }
  if (grid.enabled) {
    // Integrated across tempo changes; a plain divide is wrong once the
    // map has more than one entry, and wrong silently.
    const beats = grid.beatsBetween(L.start, L.end + 1);
    lenTxt += ' &middot; ' + beats.toFixed(3) + ' beats';
  }
  $('lengthinfo').innerHTML = 'Length: ' + lenTxt;
}

function selectLoop(i: number): void {
  state.selected = i;
  view.selected = i;
  syncEngineLoop();
  renderLoopList();
  view.requestDraw();
}

function syncEngineLoop(): void {
  const L = selectedLoop();
  // No cast on `type`: `dwType` is an arbitrary u32 in the file and this tool
  // carries whatever the file said, so asserting it is one of the three known
  // values would be asserting something the format does not guarantee.
  if (L) engine.setLoop({ start: L.start, end: L.end, type: L.type }, $<HTMLInputElement>('loopon').checked);
  else engine.setLoop(null, false);
}

function addLoop(start?: number, end?: number, type?: number): void {
  const q = quantum();
  if (start === undefined) {
    start = engine.positionSamples();
    let span = Math.min(state.frames - start, Math.round(state.sampleRate));
    if (span < 2) { start = Math.max(0, state.frames - 2); span = 2; }
    end = start + span - 1;
  }
  start = alignSample(Math.max(0, start), q, 'nearest');
  let boundary = alignSample(end! + 1, q, 'nearest');
  if (boundary <= start) boundary = start + q;
  const L: Loop = {
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

function deleteLoop(): void {
  if (state.selected < 0) return;
  state.loops.splice(state.selected, 1);
  state.dirty = true;
  const next = Math.min(state.selected, state.loops.length - 1);
  selectLoop(next);
  status('Deleted loop.');
}

/* ---- dragging ---------------------------------------------------------- */

view.onSelect = function (i: number) { if (i !== state.selected) selectLoop(i); };

/*
 * The playhead snaps to the BEAT GRID only - never to the sample-alignment
 * quantum. Alignment exists so a loop LENGTH is a whole number of ADPCM
 * blocks; the playhead is a listening position and has no such constraint,
 * and rounding it to 28-sample boundaries would fight the grid for no gain.
 */
view.onSeek = function (sample: number, mods: DragMods | null) {
  const bypass = mods && mods.alt;
  if (!bypass && mods && mods.band === 'bars' && grid.enabled) {
    // Clicked the bar strip: go to the START of that bar, whatever the snap
    // checkbox says. Clicking a labelled bar number and landing on a beat
    // inside the previous bar would make the label a lie.
    sample = grid.barStartAt(sample);
  } else if (!bypass && $<HTMLInputElement>('snapgrid').checked && grid.enabled) {
    sample = grid.nearestLine(sample);
  } else {
    sample = Math.round(sample);
  }
  engine.seekSamples(Math.max(0, Math.min(sample, state.frames)));
  view.playhead = engine.positionSamples();
  view.requestDraw();
  updateCursorInfo();
};

view.onDragPoint = function (index: number, edge: string, rawSample: number, mods: DragMods | null) {
  const L = state.loops[index];
  if (!L) return;
  const o = snapOpts(mods);
  if (edge === 'start') {
    const r = snapSample(rawSample, o);
    L.start = Math.max(0, Math.min(r.sample, L.end - 1));
  } else {
    // Snap the exclusive boundary; the stored end is one below it.
    const rb = snapSample(rawSample, o);
    const b = Math.max(L.start + 1, Math.min(rb.sample, state.frames));
    L.end = b - 1;
  }
  clampLoop(L);
  state.dirty = true;
  if (index === state.selected) {
    syncEngineLoop();
    $<HTMLInputElement>('loopstart').value = String(L.start);
    $<HTMLInputElement>('loopend').value = String(L.end);
    updateLoopReadouts();
  }
  renderLoopListLight();
  view.requestDraw();
};

view.onDragLoop = function (index: number, delta: number, mods: DragMods | null) {
  const L = state.loops[index];
  if (!L) return;
  const o = snapOpts(mods);
  const len = L.end - L.start + 1;
  const r = snapSample(L.start + delta, o);
  const ns = Math.max(0, Math.min(r.sample, state.frames - len));
  L.start = ns;
  L.end = ns + len - 1;
  clampLoop(L);
  state.dirty = true;
  if (index === state.selected) {
    syncEngineLoop();
    $<HTMLInputElement>('loopstart').value = String(L.start);
    $<HTMLInputElement>('loopend').value = String(L.end);
    updateLoopReadouts();
  }
  renderLoopListLight();
  view.requestDraw();
};

/* Update just the numbers in the list, without rebuilding it - rebuilding
 * mid-drag drops the mousedown target and the drag dies on the first move. */
function renderLoopListLight(): void {
  const items = $('looplist').querySelectorAll('li[data-index]');
  for (let i = 0; i < items.length; i++) {
    const L = state.loops[i];
    if (!L) continue;
    const rng = items[i].querySelector('.rng');
    const len = items[i].querySelector('.len');
    if (rng) rng.innerHTML = L.start.toLocaleString() + ' &ndash; ' + L.end.toLocaleString();
    if (len) len.textContent = (L.end - L.start + 1).toLocaleString() + ' smp';
  }
}

view.onDragEnd = function (d: DragEndInfo | null) {
  if (d && (d.kind === 'point' || d.kind === 'loop') && d.moved) renderLoopList();
};

/* ---- export ------------------------------------------------------------ */

function exportWav(): void {
  if (!state.channels) return;
  const loops = state.loops.map(function (L, i) {
    return { id: i, type: L.type, start: L.start, end: L.end, fraction: 0, playCount: L.playCount || 0 };
  });

  let out: ArrayBuffer;
  try {
    if (state.kind === 'wav') {
      out = Wav.writeWavWithSmpl(state.parsed!, loops);
    } else {
      out = Wav.encodeWav16(state.channels, state.sampleRate, loops);
    }
  } catch (err) {
    console.error(err);
    status('Export failed: ' + (err as Error).message, 'err');
    return;
  }

  const base = (state.name || 'audio').replace(/\.[^.]+$/, '');
  const blob = new Blob([out], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
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

function updateCursorInfo(): void {
  if (!state.frames) { $('cursorinfo').textContent = ''; return; }
  const p = view.playhead;
  let txt = p.toLocaleString() + ' smp  ' + formatTime(p / state.sampleRate);
  if (grid.enabled) {
    txt += '   bar ' + grid.positionLabel(p);
    if (grid.hasTempoChanges) txt += ' @ ' + grid.bpmAt(p) + ' BPM';
  }
  const spp = view.viewLength / (view.cssWidth || 1);
  txt += '   ' + (spp < 1 ? (1 / spp).toFixed(1) + ' px/smp' : spp.toFixed(1) + ' smp/px');
  $('cursorinfo').textContent = txt;
}

function frame(): void {
  if (engine.ready) {
    const pos = engine.positionSamples();
    if (pos !== view.playhead) {
      view.playhead = pos;
      if ($<HTMLInputElement>('follow').checked && engine.playing) {
        const margin = view.viewLength * 0.1;
        if (pos < view.viewStart + margin || pos > view.viewEnd - margin) {
          const half = view.viewLength / 2;
          view.setView(pos - half, pos + half);
        }
      }
      view.requestDraw();
      updateCursorInfo();
    }
    const label = engine.playing ? 'Stop' : 'Play';
    if ($('play').textContent !== label) $('play').textContent = label;
  }
  requestAnimationFrame(frame);
}

/* ---- wiring ------------------------------------------------------------ */

$('file').addEventListener('change', function (ev: Event) {
  // Kick the context here, synchronously inside the gesture. Awaiting a file
  // read first and only then calling init() spends the user activation, and
  // resume() on a blocked context stays pending indefinitely rather than
  // rejecting.
  engine.init();
  const target = ev.target as HTMLInputElement;
  if (target.files && target.files[0]) dispatchFile(target.files[0]);
});

/*
 * One routing decision for both entry points. The picker used to call
 * loadFile() directly, so choosing a MetaData.plist through the Open button
 * went to the audio decoder and reported a decode error, while dropping the
 * same file worked - a difference with no reason behind it that nobody would
 * think to report as a bug.
 */
function dispatchFile(f: File): void {
  if (Band.isMetadataPath(f.name)) { loadBandMetadataFile(f); return; }
  if (Logic.isProjectDataPath(f.name)) { loadProjectDataFile(f); return; }
  loadFile(f);
}

['dragenter', 'dragover'].forEach(function (t: string) {
  window.addEventListener(t, function (ev: Event) { ev.preventDefault(); $('drop').classList.remove('hidden'); });
});
['dragleave', 'drop'].forEach(function (t: string) {
  window.addEventListener(t, function (ev: Event) {
    ev.preventDefault();
    if (t === 'dragleave' && (ev as DragEvent).relatedTarget) return;
    $('drop').classList.add('hidden');
  });
});
window.addEventListener('drop', function (ev: DragEvent) {
  const dt = ev.dataTransfer;
  if (!dt) return;

  /*
   * ⚠ RESOLVE A FILE FIRST. `webkitGetAsEntry().isDirectory` cannot gate this.
   *
   * MEASURED on Safari 26.0.1 / macOS, 2026-09-02: a dropped `.zip` reported
   * `isFile=false isDirectory=true` while `getAsFile()` handed back a
   * perfectly readable 42 MB File, and `createReader().readEntries()` then
   * failed with NotFoundError. Gating on isDirectory sent an ordinary file
   * down the bundle walk, which came back empty and reported "no
   * MetaData.plist in that bundle" about a file that was never a bundle.
   *
   * A real folder drop yields no usable File (null, or a zero-length stub),
   * which is what the size check separates.
   */
  let f: File | null = null;
  if (dt.items) {
    for (let i = 0; i < dt.items.length && !f; i++) {
      const it = dt.items[i];
      if (it.kind === 'file' && it.getAsFile) f = it.getAsFile();
    }
  }
  if (!f) f = (dt.files && dt.files[0]) || null;
  if (f && f.size > 0) { dispatchFile(f); return; }

  let hasDir = false;
  if (dt.items) {
    for (let i = 0; i < dt.items.length; i++) {
      const e = dt.items[i].webkitGetAsEntry && dt.items[i].webkitGetAsEntry();
      if (e && e.isDirectory) { hasDir = true; break; }
    }
  }
  if (hasDir) { loadBandDrop(dt.items); return; }

  // Never a silent return: a drop that reached here carried no readable file
  // and no walkable directory, and what it DID carry is the only thing that
  // tells anyone whether this is a browser difference or an empty drag.
  status('Nothing usable in that drop. ' + describeDrop(dt), 'err');
});

/*
 * Describe a DataTransfer for a human reading a status line. Deliberately
 * concrete - counts and names, not "unsupported" - because the person seeing
 * this is on a browser the author could not test.
 */
function describeDrop(dt: DataTransfer): string {
  const bits: string[] = [];
  bits.push('files: ' + (dt.files ? dt.files.length : 'none'));
  if (dt.items) {
    const kinds: string[] = [];
    for (let i = 0; i < dt.items.length; i++) {
      kinds.push(dt.items[i].kind + (dt.items[i].type ? '/' + dt.items[i].type : ''));
    }
    bits.push('items: ' + (kinds.length ? kinds.join(', ') : 'none'));
  } else {
    bits.push('items: unavailable');
  }
  const types = dt.types ? Array.prototype.slice.call(dt.types).join(', ') : '';
  if (types) bits.push('types: ' + types);
  return bits.join(' | ');
}

/* ---- GarageBand project import ----------------------------------------- */

function loadBandDrop(items: DataTransferItemList): void {
  status('Reading project bundle...');
  Band.readDroppedEntries(items).then(function (files: File[]) {
    // ProjectData first: it carries the whole tempo MAP, while MetaData.plist
    // holds a single scalar and can never describe a project whose tempo
    // changes. Metadata is still read afterwards for key, meter and rate.
    const proj = Band.pickBundleFile(files, Logic.isProjectDataPath);
    const meta = Band.pickMetadataFile(files);
    if (proj) { loadProjectDataFile(proj, meta || undefined); return; }
    if (!meta) {
      // Say what was looked for and where, rather than "failed" - a bundle
      // with an unexpected layout is a fact worth reporting back.
      status('No MetaData.plist in that bundle (looked at ' + files.length +
        ' files). If it is a .band, the file lives in Alternatives/000/.', 'err');
      return;
    }
    loadBandMetadataFile(meta);
  }).catch(function (err: unknown) {
    console.error(err);
    status('Could not read the dropped folder: ' + (err as Error).message, 'err');
  });
}

function loadBandMetadataFile(file: File): void {
  file.arrayBuffer().then(function (buf) {
    let m: BandMetadata;
    try {
      m = Band.readBandMetadata(buf);
    } catch (err) {
      status('Not a readable MetaData.plist: ' + (err as Error).message, 'err');
      return;
    }
    applyBandMetadata(m, (file as File & { path?: string }).path || file.name);
  });
}

/*
 * Read Alternatives/<n>/ProjectData - the whole tempo map, not just a first
 * tempo. `meta` is optional and supplies only the fallback meter, used when
 * the project states no time signature of its own.
 */
function loadProjectDataFile(file: File, meta?: File): void {
  const label = (file as File & { path?: string }).path || file.name;
  const metaSig = meta
    ? meta.arrayBuffer().then(function (b) {
        try {
          const m = Band.readBandMetadata(b);
          if (m.beatsPerBar) return { numerator: m.beatsPerBar, denominator: m.beatUnit || 4 };
        } catch { /* a bad plist must not sink a good ProjectData */ }
        return undefined;
      })
    : Promise.resolve(undefined);

  Promise.all([file.arrayBuffer(), metaSig]).then(function (r) {
    const buf = r[0] as ArrayBuffer;
    const fallback = r[1] as { numerator: number; denominator: number } | undefined;
    let bars: Logic.BarTempo[];
    let meterFromProject: boolean;
    try {
      const song = Logic.parseLogicSong(buf);
      // Which source actually won is a fact about the parse, not about what
      // was offered - the fallback is only consulted when the project states
      // no signature of its own.
      meterFromProject = song.signatures.length > 0;
      bars = Logic.tempoMapToBars(song, fallback);
    } catch (err) {
      status('Could not read ' + label + ': ' + (err as Error).message, 'err');
      return;
    }
    applyTempoMap(bars, label, meterFromProject ? 'the project' : (fallback ? 'MetaData.plist' : 'the 4/4 default'));
  }).catch(function (err: unknown) {
    status('Could not read ' + label + ': ' + (err as Error).message, 'err');
  });
}

/*
 * Push a parsed tempo map into the grid. The inputs are set from the FIRST
 * entry before gridChanged() so the single-tempo controls agree with bar one,
 * then setTempos installs the rest - gridChanged reads the inputs, so doing
 * it the other way round would flatten the map back to one tempo.
 */
function applyTempoMap(bars: Logic.BarTempo[], label: string, meterSource: string): void {
  if (!bars.length) {
    status('Read ' + label + ' but it declared no tempo.', 'err');
    return;
  }
  $<HTMLInputElement>('bpm').value = String(bars[0].bpm);
  $<HTMLInputElement>('beatsbar').value = String(bars[0].beatsPerBar);
  $<HTMLInputElement>('gridon').checked = true;
  $<HTMLInputElement>('snapgrid').checked = true;
  gridChanged();
  grid.setTempos(bars);
  afterGridEdit();

  // Exact, not Band.formatBpm: that rounds for display because MetaData.plist
  // stores a float32 with junk digits, whereas a ProjectData tempo is an
  // integer over 10000 and is exact. Rounding 128.3402 to 128.34 here would
  // misreport what was actually imported.
  const changes = bars.slice(1).map(function (t) {
    return 'bar ' + t.bar + ' -> ' + String(t.bpm);
  });
  // Name where the meter came from. An assumed 4/4 and a read 4/4 look
  // identical in the box, and only one of them is evidence.
  const meter = bars[0].beatsPerBar + ' beats/bar (from ' + meterSource + ')';
  status('Tempo map from ' + label + ': ' + String(bars[0].bpm) + ' BPM at bar 1' +
    (changes.length ? ', then ' + changes.join(', ') : ' (no changes)') +
    '. ' + meter + '. Loop points are not read from the project yet - place those yourself.', 'ok');
}

/*
 * Apply only what the project actually stated. A field GarageBand did not
 * write is left alone rather than defaulted, and the status line says which
 * values came from the file - otherwise an assumed 4/4 is indistinguishable
 * from a read one.
 */
function applyBandMetadata(m: BandMetadata, label: string): void {
  const applied: string[] = [];
  if (m.bpm !== undefined && m.bpm > 0) {
    $<HTMLInputElement>('bpm').value = Band.formatBpm(m.bpm);
    applied.push(Band.formatBpm(m.bpm) + ' BPM');
  }
  if (m.beatsPerBar !== undefined && m.beatsPerBar > 0) {
    $<HTMLInputElement>('beatsbar').value = String(m.beatsPerBar);
    applied.push(m.beatsPerBar + '/' + (m.beatUnit || 4));
  }
  if (applied.length) {
    $<HTMLInputElement>('gridon').checked = true;
    $<HTMLInputElement>('snapgrid').checked = true;
    gridChanged();
  }

  const extra: string[] = [];
  if (m.key) extra.push('key ' + m.key + (m.mode ? ' ' + m.mode : ''));
  if (m.sampleRate) {
    extra.push(m.sampleRate + ' Hz');
    if (state.frames && m.sampleRate !== state.sampleRate) {
      extra.push('WARNING: the loaded audio is ' + state.sampleRate +
        ' Hz, so the grid will not line up');
    }
  }
  if (m.tracks !== undefined) extra.push(m.tracks + ' tracks');

  if (!applied.length) {
    status('Read ' + (label || 'the project') + ' but it declared no tempo.', 'err');
    return;
  }
  status('Grid set from ' + (label || 'project') + ': ' + applied.join(', ')
    + (extra.length ? '  (' + extra.join(', ') + ')' : '')
    + '. Loop points are not read from the bundle yet - place those yourself.', 'ok');
}

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
$<HTMLInputElement>('volume').addEventListener('input', function () { engine.setVolume(parseFloat(this.value)); });

$('addloop').addEventListener('click', function () { if (state.frames) addLoop(); });
$('delloop').addEventListener('click', deleteLoop);
$('loopfromview').addEventListener('click', function () {
  if (!state.frames) return;
  addLoop(Math.max(0, Math.round(view.viewStart)), Math.min(state.frames - 1, Math.round(view.viewEnd)));
});

$<HTMLSelectElement>('looptype').addEventListener('change', function () {
  const L = selectedLoop();
  if (!L) return;
  L.type = parseInt(this.value, 10);
  state.dirty = true;
  syncEngineLoop();
  renderLoopList();
});

function commitField(which: 'start' | 'end'): void {
  const L = selectedLoop();
  if (!L) return;
  const v = parseInt($<HTMLInputElement>(which === 'start' ? 'loopstart' : 'loopend').value, 10);
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

function setPointFromPlayhead(which: 'start' | 'end'): void {
  const L = selectedLoop();
  if (!L) return;
  const p = engine.positionSamples();
  const o = snapOpts(null);
  if (which === 'start') {
    L.start = Math.max(0, Math.min(snapSample(p, o).sample, L.end - 1));
  } else {
    const b = Math.max(L.start + 1, Math.min(snapSample(p, o).sample, state.frames));
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
$<HTMLSelectElement>('alignpreset').addEventListener('change', function () {
  if (!this.value) return;
  $<HTMLInputElement>('alignq').value = this.value;
  $<HTMLInputElement>('alignon').checked = this.value !== '1';
  this.value = '';
  updateLoopReadouts();
});

/* ---- tempo map editor -------------------------------------------------- */

/*
 * One row per tempo change. Row 0 is the song's starting tempo: it is pinned
 * to bar 1 and cannot be deleted, because the map has to cover the song from
 * the beginning - a map starting at bar 6 would leave bars 1-5 with no tempo
 * at all. Its BPM lives in the main field above rather than being duplicated
 * here, so there is one place to edit it.
 */
function renderTempoList(): void {
  const ul = $('tempolist');
  const list = grid.tempos;
  ul.innerHTML = '';

  for (let i = 1; i < list.length; i++) {
    (function (idx: number) {
      const t = list[idx];
      const li = document.createElement('li');

      const lbl = document.createElement('span');
      lbl.className = 'tl-lbl';
      lbl.textContent = 'bar';
      const bar = document.createElement('input');
      bar.type = 'number'; bar.min = '2'; bar.step = '1'; bar.value = String(t.bar);
      const at = document.createElement('span');
      at.className = 'tl-lbl';
      at.textContent = '\u2192';
      const bpm = document.createElement('input');
      bpm.type = 'number'; bpm.min = '10'; bpm.max = '400'; bpm.step = '0.001'; bpm.value = String(t.bpm);
      const unit = document.createElement('span');
      unit.className = 'tl-lbl';
      unit.textContent = 'BPM';
      const del = document.createElement('button');
      del.className = 'tl-del'; del.title = 'Remove this tempo change';
      del.innerHTML = '&times;';

      const commit = function () {
        const all = grid.tempos;
        const b = parseInt(bar.value, 10);
        const v = parseFloat(bpm.value);
        if (b > 1) all[idx].bar = b;
        if (v > 0) all[idx].bpm = v;
        grid.setTempos(all);
        afterGridEdit();
      };
      bar.addEventListener('change', commit);
      bpm.addEventListener('change', commit);
      del.addEventListener('click', function () {
        grid.removeTempoAt(idx);
        afterGridEdit();
      });

      li.appendChild(lbl); li.appendChild(bar); li.appendChild(at);
      li.appendChild(bpm); li.appendChild(unit); li.appendChild(del);
      ul.appendChild(li);
    })(i);
  }

  $('tempocount').textContent = list.length > 1
    ? (list.length - 1) + ' change' + (list.length === 2 ? '' : 's')
      + ', ' + list[0].bpm + ' from bar 1'
    : '';
}

/* Re-render and re-push after a change to the map itself, without going back
 * through gridChanged() - that reads the BPM field, which would overwrite the
 * first entry with a stale value while a row is being edited. */
function afterGridEdit(): void {
  $<HTMLInputElement>('bpm').value = String(grid.tempos[0].bpm);
  engine.gridChanged();
  renderTempoList();
  updateLoopReadouts();
  updateCursorInfo();
  view.requestDraw();
}

$('addtempo').addEventListener('click', function () {
  // Default the new change to the bar the playhead is in - that is almost
  // always where you want it, and it is one fewer number to type.
  let bar = grid.enabled
    ? Math.max(2, Math.floor(grid.barAt(engine.positionSamples()) + 1e-9))
    : 2;
  const existing = grid.tempos;
  for (let i = 0; i < existing.length; i++) if (existing[i].bar === bar) bar += 1;
  grid.addTempo(bar, grid.tempos[grid.tempos.length - 1].bpm);
  if (!$<HTMLInputElement>('gridon').checked) { $<HTMLInputElement>('gridon').checked = true; gridChanged(); }
  afterGridEdit();
  status('Tempo change added at bar ' + bar + '. Edit the bar or BPM in the list.');
});

function gridChanged(redrawList?: boolean): void {
  grid.bpm = parseFloat($<HTMLInputElement>('bpm').value) || 120;
  grid.offset = parseInt($<HTMLInputElement>('gridoffset').value, 10) || 0;
  grid.subdivision = parseInt($<HTMLSelectElement>('subdiv').value, 10) || 1;
  grid.beatsPerBar = parseInt($<HTMLInputElement>('beatsbar').value, 10) || 4;
  grid.enabled = $<HTMLInputElement>('gridon').checked;
  view.showGrid = grid.enabled;
  engine.gridChanged();
  renderTempoList();
  if (redrawList !== false) updateLoopReadouts();
  updateCursorInfo();
  view.requestDraw();
}

['bpm', 'gridoffset', 'subdiv', 'beatsbar'].forEach(function (id: string) {
  $(id).addEventListener('input', function () { gridChanged(); });
});
$('gridon').addEventListener('change', function () { gridChanged(); });
$<HTMLInputElement>('metro').addEventListener('change', function () { engine.setMetronome(this.checked); });
$<HTMLInputElement>('metrovol').addEventListener('input', function () { engine.setMetronomeVolume(parseFloat(this.value)); });

function nudge(n: number): void {
  $<HTMLInputElement>('gridoffset').value = String((parseInt($<HTMLInputElement>('gridoffset').value, 10) || 0) + n);
  gridChanged();
}
$('nudgeminus').addEventListener('click', function () { nudge(-nudgeStep()); });
$('nudgeplus').addEventListener('click', function () { nudge(nudgeStep()); });
$('nudgeminus10').addEventListener('click', function () { nudge(-nudgeStep() * 10); });
$('nudgeplus10').addEventListener('click', function () { nudge(nudgeStep() * 10); });
function nudgeStep(): number { return Math.max(1, Math.round(state.sampleRate / 1000)); }  // 1 ms

$('gridhere').addEventListener('click', function () {
  $<HTMLInputElement>('gridoffset').value = String(engine.positionSamples());
  gridChanged();
});

function doTap(): void {
  const r = tap.tap(performance.now());
  if (!r) { $('tapinfo').textContent = 'tap again...'; return; }
  $<HTMLInputElement>('bpm').value = r.bpm.toFixed(3);
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

window.addEventListener('keydown', function (ev: KeyboardEvent) {
  const t = ev.target as HTMLElement | null;
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
      $<HTMLInputElement>('loopon').checked = !$<HTMLInputElement>('loopon').checked;
      syncEngineLoop();
      break;
    case 's': case 'S': setPointFromPlayhead('start'); break;
    case 'e': case 'E': setPointFromPlayhead('end'); break;
    case 'a': case 'A': if (state.frames) addLoop(); break;
    case 't': case 'T': doTap(); break;
    case 'm': case 'M':
      $<HTMLInputElement>('metro').checked = !$<HTMLInputElement>('metro').checked;
      engine.setMetronome($<HTMLInputElement>('metro').checked);
      break;
    case 'Delete': case 'Backspace': deleteLoop(); break;
    case 'Home': engine.seekSamples(0); view.playhead = 0; view.requestDraw(); break;
    case '+': case '=': view.zoomAt(view.playhead, 0.5); break;
    case '-': case '_': view.zoomAt(view.playhead, 2); break;
    case '0': view.fit(); break;
    case 'ArrowLeft': case 'ArrowRight': {
      const dir = ev.key === 'ArrowLeft' ? -1 : 1;
      const amount = view.viewLength * (ev.shiftKey ? 0.9 : 0.1) * dir;
      view.setView(view.viewStart + amount, view.viewEnd + amount);
      break;
    }
    default: return;
  }
});

window.addEventListener('beforeunload', function (ev: BeforeUnloadEvent) {
  if (state.dirty) { ev.preventDefault(); ev.returnValue = ''; }
});

engine.setGrid(grid);
gridChanged();
renderLoopList();
requestAnimationFrame(frame);
$('buildstamp').textContent = 'build ' + __BUILD_STAMP__;
status('Ready. Open a .wav (or drop one anywhere) to start.');

declare global {
  interface Window {
    __loopeditor: {
      state: AppState;
      view: WaveformView;
      engine: AudioEngine;
      grid: BeatGrid;
      Wav: typeof Wav;
      makeDecoder: typeof makeDecoder;
      decodeWithTimeout: typeof decodeWithTimeout;
    };
    /* Legacy Safari alias; not in TypeScript's DOM lib. */
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  }
}

/*
 * Handle for the console and for the browser test. Exposed on purpose: the
 * e2e test needs the exact pixel position of a loop handle to drag it, and
 * guessing a position instead produced a test that grabbed the loop BODY and
 * still reported a passing "dragged the start handle" check.
 */
window.__loopeditor = {
  state: state, view: view, engine: engine, grid: grid, Wav: Wav,
  // Exposed so the decode test can exercise the actual mechanism: that
  // decoding uses a context independent of playback.
  makeDecoder: makeDecoder, decodeWithTimeout: decodeWithTimeout
};
