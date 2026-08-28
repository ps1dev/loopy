/*
 * Apple binary property list (bplist00) reader.
 *
 * Written rather than pulled in because this project has no dependencies and
 * the format is small: a header, a trailer describing the offset table, and a
 * flat object table whose entries are tagged by a type nibble.
 *
 * Only the reading side, and only the types that turn up in the files this
 * tool cares about. Unsupported types throw with their marker byte rather
 * than returning undefined - a parser that silently yields undefined for a
 * type it does not know produces a plausible object with a hole in it, and
 * the hole is discovered much later by whoever consumed it.
 *
 * Layout:
 *   0..7    "bplist00"
 *   ...     object data
 *   last 32 trailer: 6 unused, offsetIntSize, objectRefSize,
 *                    numObjects(8), topObject(8), offsetTableOffset(8)
 */

var MAGIC = 'bplist00';

function readUInt(view, off, size) {
  // Big-endian, up to 8 bytes. Above 2^53 precision is gone, but these are
  // offsets and counts into a file - if one exceeds 2^53 something else has
  // already gone very wrong.
  var v = 0;
  for (var i = 0; i < size; i++) v = v * 256 + view.getUint8(off + i);
  return v;
}

export function parseBinaryPlist(buffer) {
  var bytes = new Uint8Array(buffer);
  var view = new DataView(buffer);
  if (bytes.length < 40) throw new Error('too short to be a binary plist');

  var magic = '';
  for (var i = 0; i < 8; i++) magic += String.fromCharCode(bytes[i]);
  if (magic !== MAGIC) {
    throw new Error('not a binary plist (magic is "' + magic.replace(/[^\x20-\x7e]/g, '.') + '")');
  }

  var t = bytes.length - 32;
  var offsetIntSize = view.getUint8(t + 6);
  var objectRefSize = view.getUint8(t + 7);
  var numObjects = readUInt(view, t + 8, 8);
  var topObject = readUInt(view, t + 16, 8);
  var offsetTableOffset = readUInt(view, t + 24, 8);

  if (!offsetIntSize || !objectRefSize) throw new Error('binary plist trailer is malformed');

  var offsets = new Array(numObjects);
  for (var j = 0; j < numObjects; j++) {
    offsets[j] = readUInt(view, offsetTableOffset + j * offsetIntSize, offsetIntSize);
  }

  var cache = new Array(numObjects);

  function readRef(off) { return readUInt(view, off, objectRefSize); }

  /* Marker byte is a type nibble plus a length nibble; 0xF in the length
   * nibble means the real length follows as its own integer object. */
  function readLength(off, lowNibble) {
    if (lowNibble !== 0x0f) return { length: lowNibble, next: off + 1 };
    var sizeMarker = view.getUint8(off + 1);
    if ((sizeMarker & 0xf0) !== 0x10) throw new Error('bad length marker at ' + off);
    var intBytes = 1 << (sizeMarker & 0x0f);
    return { length: readUInt(view, off + 2, intBytes), next: off + 2 + intBytes };
  }

  function utf16be(off, chars) {
    var s = '';
    for (var k = 0; k < chars; k++) s += String.fromCharCode(view.getUint16(off + k * 2, false));
    return s;
  }

  function ascii(off, len) {
    var s = '';
    for (var k = 0; k < len; k++) s += String.fromCharCode(bytes[off + k]);
    return s;
  }

  function parseObject(index) {
    if (index >= numObjects) throw new Error('object ref ' + index + ' out of range');
    if (cache[index] !== undefined) return cache[index];

    var off = offsets[index];
    var marker = view.getUint8(off);
    var type = marker & 0xf0;
    var low = marker & 0x0f;
    var out;

    switch (type) {
      case 0x00:
        if (low === 0) out = null;
        else if (low === 8) out = false;
        else if (low === 9) out = true;
        else if (low === 15) out = null;        // fill byte
        else throw new Error('unknown singleton marker 0x' + marker.toString(16));
        break;

      case 0x10: {                              // int, 2^low bytes, big-endian
        var n = 1 << low;
        if (n === 16) {                         // 128-bit; keep the low 64
          out = readUInt(view, off + 9, 8);
        } else if (n === 8) {
          // Signed 64-bit in the format; values here are small in practice.
          out = Number(view.getBigInt64(off + 1, false));
        } else {
          out = readUInt(view, off + 1, n);
        }
        break;
      }

      case 0x20: {                              // real, 2^low bytes
        // The length nibble is log2 of the byte count: 2 -> float32,
        // 3 -> float64. An earlier version read BOTH as float32 and passed
        // every test against real GarageBand files, because those happen to
        // store float32 - three fixtures of the same kind agreeing about a
        // parser that was wrong for the other half of the type.
        var rn = 1 << low;
        if (rn === 4) out = view.getFloat32(off + 1, false);
        else if (rn === 8) out = view.getFloat64(off + 1, false);
        else throw new Error('unsupported real width ' + rn + ' bytes at offset ' + off);
        break;
      }

      case 0x30:                                // date: seconds since 2001-01-01
        out = new Date((view.getFloat64(off + 1, false) + 978307200) * 1000);
        break;

      case 0x40: {                              // data
        var d = readLength(off, low);
        out = bytes.slice(d.next, d.next + d.length);
        break;
      }

      case 0x50: {                              // ASCII string
        var a = readLength(off, low);
        out = ascii(a.next, a.length);
        break;
      }

      case 0x60: {                              // UTF-16BE string
        var u = readLength(off, low);
        out = utf16be(u.next, u.length);
        break;
      }

      case 0x80:                                // UID
        out = { CFUID: readUInt(view, off + 1, low + 1) };
        break;

      case 0xa0:                                // array
      case 0xc0: {                              // set, treated as an array
        var arr = readLength(off, low);
        out = [];
        cache[index] = out;                     // set first: arrays can self-reference
        for (var ai = 0; ai < arr.length; ai++) {
          out.push(parseObject(readRef(arr.next + ai * objectRefSize)));
        }
        return out;
      }

      case 0xd0: {                              // dict
        var dd = readLength(off, low);
        out = {};
        cache[index] = out;
        var keysAt = dd.next;
        var valsAt = dd.next + dd.length * objectRefSize;
        for (var di = 0; di < dd.length; di++) {
          var key = parseObject(readRef(keysAt + di * objectRefSize));
          out[String(key)] = parseObject(readRef(valsAt + di * objectRefSize));
        }
        return out;
      }

      default:
        throw new Error('unsupported binary plist type 0x' + type.toString(16) +
                        ' at offset ' + off);
    }

    cache[index] = out;
    return out;
  }

  return parseObject(topObject);
}

/* Convenience: true if the buffer starts with the bplist magic. */
export function isBinaryPlist(buffer) {
  if (buffer.byteLength < 8) return false;
  var b = new Uint8Array(buffer, 0, 8);
  for (var i = 0; i < 8; i++) if (b[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}
