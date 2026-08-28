/*
 * RIFF/WAVE reader and writer with `smpl` chunk support.
 *
 * Deliberately hand-rolled rather than leaning on decodeAudioData:
 *   - decodeAudioData resamples to the AudioContext rate, which would silently
 *     move every loop point. Sample indices have to survive a round trip
 *     untouched, so WAV files are parsed here and handed to the audio layer at
 *     their own rate.
 *   - decodeAudioData also throws away every chunk that is not `fmt ` or
 *     `data`, and the whole point of this tool is one of those chunks.
 *
 * On export the original file bytes are reused verbatim for every chunk except
 * `smpl`, so a WAV that goes in comes back out sample-identical.
 *
 * No dependencies. ES module: serve the directory over HTTP (see README) -
 * modules are blocked by CORS on file://.
 */
var FMT_PCM = 0x0001;
var FMT_FLOAT = 0x0003;
var FMT_EXTENSIBLE = 0xfffe;

function fourcc(view, off) {
  return String.fromCharCode(
    view.getUint8(off), view.getUint8(off + 1),
    view.getUint8(off + 2), view.getUint8(off + 3));
}

/*
 * Walk the top-level chunk list. Returns the raw chunk table so the writer
 * can copy anything it does not understand straight through.
 */
export function parseChunks(buffer) {
  var view = new DataView(buffer);
  if (buffer.byteLength < 12) throw new Error('file is too short to be a RIFF container');
  if (fourcc(view, 0) !== 'RIFF') throw new Error('not a RIFF file (missing "RIFF" magic)');
  if (fourcc(view, 8) !== 'WAVE') throw new Error('RIFF file is not a WAVE (form type is "' + fourcc(view, 8) + '")');

  var riffSize = view.getUint32(4, true);
  // Some encoders write a wrong or zero RIFF size; trust the file length.
  var end = Math.min(buffer.byteLength, riffSize + 8);
  if (riffSize === 0 || riffSize === 0xffffffff) end = buffer.byteLength;

  var chunks = [];
  var pos = 12;
  while (pos + 8 <= end) {
    var id = fourcc(view, pos);
    var size = view.getUint32(pos + 4, true);
    var dataOff = pos + 8;
    if (dataOff + size > buffer.byteLength) {
      // Truncated final chunk: keep what is actually there rather than
      // failing the whole load.
      size = buffer.byteLength - dataOff;
    }
    chunks.push({ id: id, offset: dataOff, size: size });
    pos = dataOff + size + (size & 1); // chunks are word-aligned
  }
  return chunks;
}

function parseFmt(buffer, chunk) {
  var v = new DataView(buffer, chunk.offset, chunk.size);
  var fmt = {
    formatTag: v.getUint16(0, true),
    channels: v.getUint16(2, true),
    sampleRate: v.getUint32(4, true),
    byteRate: v.getUint32(8, true),
    blockAlign: v.getUint16(12, true),
    bitsPerSample: v.getUint16(14, true)
  };
  if (fmt.formatTag === FMT_EXTENSIBLE && chunk.size >= 40) {
    // The real format lives in the first two bytes of the subformat GUID.
    fmt.formatTag = v.getUint16(24, true);
    var validBits = v.getUint16(18, true);
    if (validBits > 0) fmt.validBits = validBits;
  }
  if (!fmt.channels) throw new Error('fmt chunk declares zero channels');
  if (!fmt.sampleRate) throw new Error('fmt chunk declares a zero sample rate');
  return fmt;
}

/*
 * `smpl` layout (36-byte header, then 24 bytes per loop, then sampler data).
 * dwStart / dwEnd are in SAMPLE FRAMES, not bytes, and dwEnd is INCLUSIVE:
 * the spec says the end sample "will also be played". Everything downstream
 * of here keeps that convention; only the playback layer converts.
 */
export function parseSmpl(buffer, chunk) {
  if (chunk.size < 36) return null;
  var v = new DataView(buffer, chunk.offset, chunk.size);
  var smpl = {
    manufacturer: v.getUint32(0, true),
    product: v.getUint32(4, true),
    samplePeriod: v.getUint32(8, true),
    midiUnityNote: v.getUint32(12, true),
    midiPitchFraction: v.getUint32(16, true),
    smpteFormat: v.getUint32(20, true),
    smpteOffset: v.getUint32(24, true),
    loops: []
  };
  var count = v.getUint32(28, true);
  var samplerDataBytes = v.getUint32(32, true);
  smpl.samplerDataBytes = samplerDataBytes;

  var maxLoops = Math.floor((chunk.size - 36) / 24);
  if (count > maxLoops) count = maxLoops; // tolerate a lying count
  for (var i = 0; i < count; i++) {
    var o = 36 + i * 24;
    smpl.loops.push({
      id: v.getUint32(o, true),
      type: v.getUint32(o + 4, true),
      start: v.getUint32(o + 8, true),
      end: v.getUint32(o + 12, true),
      fraction: v.getUint32(o + 16, true),
      playCount: v.getUint32(o + 20, true)
    });
  }
  return smpl;
}

/* Decode PCM/float sample data into per-channel Float32Arrays in [-1, 1]. */
function decodeSamples(buffer, fmt, dataChunk) {
  var bytesPerSample = fmt.bitsPerSample >> 3;
  if (bytesPerSample < 1) throw new Error('unsupported bit depth: ' + fmt.bitsPerSample);
  var frameBytes = fmt.blockAlign || bytesPerSample * fmt.channels;
  if (frameBytes < bytesPerSample * fmt.channels) frameBytes = bytesPerSample * fmt.channels;
  var frames = Math.floor(dataChunk.size / frameBytes);

  var channels = [];
  for (var c = 0; c < fmt.channels; c++) channels.push(new Float32Array(frames));

  var bytes = new Uint8Array(buffer, dataChunk.offset, frames * frameBytes);
  var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  var isFloat = fmt.formatTag === FMT_FLOAT;

  for (var f = 0; f < frames; f++) {
    var base = f * frameBytes;
    for (var ch = 0; ch < fmt.channels; ch++) {
      var o = base + ch * bytesPerSample;
      var s;
      if (isFloat) {
        s = bytesPerSample === 8 ? view.getFloat64(o, true) : view.getFloat32(o, true);
      } else if (bytesPerSample === 1) {
        s = (view.getUint8(o) - 128) / 128;          // 8-bit WAV is unsigned
      } else if (bytesPerSample === 2) {
        s = view.getInt16(o, true) / 32768;
      } else if (bytesPerSample === 3) {
        var lo = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16);
        if (lo & 0x800000) lo |= ~0xffffff;           // sign-extend 24 -> 32
        s = lo / 8388608;
      } else if (bytesPerSample === 4) {
        s = view.getInt32(o, true) / 2147483648;
      } else {
        throw new Error('unsupported sample width: ' + fmt.bitsPerSample + ' bits');
      }
      channels[ch][f] = s;
    }
  }
  return { channels: channels, frames: frames };
}

/*
 * Full parse. Returns everything the app needs plus the original buffer and
 * chunk table, which the writer uses to rebuild the file losslessly.
 */
export function parseWav(buffer) {
  var chunks = parseChunks(buffer);
  var fmtChunk = null, dataChunk = null, smplChunk = null;
  for (var i = 0; i < chunks.length; i++) {
    if (chunks[i].id === 'fmt ' && !fmtChunk) fmtChunk = chunks[i];
    else if (chunks[i].id === 'data' && !dataChunk) dataChunk = chunks[i];
    else if (chunks[i].id === 'smpl' && !smplChunk) smplChunk = chunks[i];
  }
  if (!fmtChunk) throw new Error('WAVE file has no "fmt " chunk');
  if (!dataChunk) throw new Error('WAVE file has no "data" chunk');

  var fmt = parseFmt(buffer, fmtChunk);
  if (fmt.formatTag !== FMT_PCM && fmt.formatTag !== FMT_FLOAT) {
    throw new Error('unsupported WAVE encoding (format tag 0x' +
      fmt.formatTag.toString(16) + '); this tool reads PCM and IEEE float only');
  }
  var decoded = decodeSamples(buffer, fmt, dataChunk);
  var smpl = smplChunk ? parseSmpl(buffer, smplChunk) : null;

  return {
    buffer: buffer,
    chunks: chunks,
    fmt: fmt,
    dataChunk: dataChunk,
    smpl: smpl,
    channels: decoded.channels,
    frames: decoded.frames,
    sampleRate: fmt.sampleRate
  };
}

/* ---- writing ---------------------------------------------------------- */

export function buildSmplChunk(opts) {
  var loops = opts.loops || [];
  var size = 36 + loops.length * 24;
  var buf = new ArrayBuffer(8 + size);
  var v = new DataView(buf);
  var b = new Uint8Array(buf);
  b[0] = 0x73; b[1] = 0x6d; b[2] = 0x70; b[3] = 0x6c; // "smpl"
  v.setUint32(4, size, true);

  var samplePeriod = opts.samplePeriod;
  if (!samplePeriod) samplePeriod = Math.round(1e9 / opts.sampleRate); // ns
  v.setUint32(8, opts.manufacturer || 0, true);
  v.setUint32(12, opts.product || 0, true);
  v.setUint32(16, samplePeriod, true);
  v.setUint32(20, opts.midiUnityNote === undefined ? 60 : opts.midiUnityNote, true);
  v.setUint32(24, opts.midiPitchFraction || 0, true);
  v.setUint32(28, opts.smpteFormat || 0, true);
  v.setUint32(32, opts.smpteOffset || 0, true);
  v.setUint32(36, loops.length, true);
  v.setUint32(40, 0, true); // no sampler-specific data

  for (var i = 0; i < loops.length; i++) {
    var o = 44 + i * 24;
    var L = loops[i];
    v.setUint32(o, L.id === undefined ? i : L.id, true);
    v.setUint32(o + 4, L.type || 0, true);   // 0 = forward
    v.setUint32(o + 8, L.start >>> 0, true);
    v.setUint32(o + 12, L.end >>> 0, true);  // inclusive
    v.setUint32(o + 16, L.fraction || 0, true);
    v.setUint32(o + 20, L.playCount || 0, true); // 0 = loop forever
  }
  return buf;
}

/*
 * Rebuild a WAVE around the original chunk bytes, replacing (or inserting)
 * `smpl`. Every other chunk is copied byte-for-byte in its original order,
 * so cue/LIST/INFO/fact and anything else the source carried survives.
 *
 * The new `smpl` is written IMMEDIATELY AFTER `fmt `, not left wherever it
 * was. `fmt ` is a fixed even size, so a reader that walks the chunk list
 * reaches `smpl` before it can meet anything odd-sized. That matters because
 * psxavenc's chunk walk (decoding.c, `avio_skip(pb, chunk_size)`) does not
 * skip the RIFF pad byte after an odd-sized chunk, so any odd chunk ahead of
 * `smpl` desynchronises it and the loop point is silently not found.
 * Measured 2026-08-28 against psxavenc 4658cb96 with a 19-byte chunk: not
 * found; with the same chunk padded to 20 bytes, found. Ordering `smpl`
 * early sidesteps it without writing anything non-conforming.
 */
export function writeWavWithSmpl(parsed, loops, smplOpts) {
  var opts = {};
  var src = parsed.smpl || {};
  for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) opts[k] = src[k];
  if (smplOpts) for (var k2 in smplOpts) opts[k2] = smplOpts[k2];
  opts.loops = loops;
  opts.sampleRate = parsed.sampleRate;

  var smplBytes = loops.length ? new Uint8Array(buildSmplChunk(opts)) : null;

  var pieces = [];
  var total = 12; // RIFF header
  var wroteSmpl = false;
  var srcBytes = new Uint8Array(parsed.buffer);

  for (var i = 0; i < parsed.chunks.length; i++) {
    var c = parsed.chunks[i];
    if (c.id === 'smpl') {
      continue; // drop the original; a loop-less export drops it entirely
    }
    var padded = c.size + (c.size & 1);
    var raw = new Uint8Array(8 + padded);
    raw.set(srcBytes.subarray(c.offset - 8, c.offset - 8 + Math.min(8 + padded, srcBytes.length - (c.offset - 8))));
    pieces.push(raw);
    total += raw.length;
    if (c.id === 'fmt ' && smplBytes && !wroteSmpl) {
      pieces.push(smplBytes);
      total += smplBytes.length;
      wroteSmpl = true;
    }
  }
  // No fmt chunk to follow (parseWav would have rejected that, but the writer
  // should not depend on its caller): fall back to appending.
  if (smplBytes && !wroteSmpl) { pieces.push(smplBytes); total += smplBytes.length; }

  var out = new Uint8Array(total);
  var hv = new DataView(out.buffer);
  out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46; // "RIFF"
  hv.setUint32(4, total - 8, true);
  out[8] = 0x57; out[9] = 0x41; out[10] = 0x56; out[11] = 0x45; // "WAVE"
  var p = 12;
  for (var j = 0; j < pieces.length; j++) { out.set(pieces[j], p); p += pieces[j].length; }
  return out.buffer;
}

/*
 * Encode decoded float channels as a fresh 16-bit PCM WAVE. Used for sources
 * that did not come in as WAV (mp3/ogg/flac decoded by the browser), where
 * there are no original bytes to preserve.
 */
export function encodeWav16(channels, sampleRate, loops, smplOpts) {
  var ch = channels.length;
  var frames = ch ? channels[0].length : 0;
  var dataBytes = frames * ch * 2;
  var smplBytes = (loops && loops.length)
    ? new Uint8Array(buildSmplChunk(
        Object.assign({ sampleRate: sampleRate }, smplOpts || {}, { loops: loops })))
    : null;

  var total = 12 + 24 + 8 + dataBytes + (dataBytes & 1) + (smplBytes ? smplBytes.length : 0);
  var buf = new ArrayBuffer(total);
  var v = new DataView(buf);
  var u = new Uint8Array(buf);

  function tag(off, s) { for (var i = 0; i < 4; i++) u[off + i] = s.charCodeAt(i); }

  tag(0, 'RIFF'); v.setUint32(4, total - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);                    // PCM
  v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, dataBytes, true);

  var o = 44;
  for (var f = 0; f < frames; f++) {
    for (var c = 0; c < ch; c++) {
      var s = channels[c][f];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      v.setInt16(o, s < 0 ? s * 32768 : s * 32767, true);
      o += 2;
    }
  }
  if (dataBytes & 1) o++;
  if (smplBytes) u.set(smplBytes, o);
  return buf;
}

