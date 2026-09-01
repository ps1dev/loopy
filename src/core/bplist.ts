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

/** A dictionary object in a plist. Keys are stringified by the parser. */
export type PlistDict = { [k: string]: PlistValue };

/**
 * Everything `parseBinaryPlist` can hand back. Every member below is reachable
 * from the switch in `parseObject`: null (0x00), boolean (0x00), number (0x10
 * ints and 0x20 reals), Date (0x30), Uint8Array (0x40 data), string (0x50
 * ASCII and 0x60 UTF-16BE), array (0xa0/0xc0) and dict (0xd0, which is also
 * how a 0x80 UID arrives, as `{ CFUID: number }`).
 */
export type PlistValue =
  | null
  | boolean
  | number
  | string
  | Date
  | Uint8Array
  | PlistValue[]
  | PlistDict;

const MAGIC = 'bplist00';

function readUInt(view: DataView, off: number, size: number): number {
  // Big-endian, up to 8 bytes. Above 2^53 precision is gone, but these are
  // offsets and counts into a file - if one exceeds 2^53 something else has
  // already gone very wrong.
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + view.getUint8(off + i);
  return v;
}

export function parseBinaryPlist(buffer: ArrayBuffer): PlistValue {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 40) throw new Error('too short to be a binary plist');

  let magic = '';
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(bytes[i]);
  if (magic !== MAGIC) {
    throw new Error('not a binary plist (magic is "' + magic.replace(/[^\x20-\x7e]/g, '.') + '")');
  }

  const t = bytes.length - 32;
  const offsetIntSize = view.getUint8(t + 6);
  const objectRefSize = view.getUint8(t + 7);
  const numObjects = readUInt(view, t + 8, 8);
  const topObject = readUInt(view, t + 16, 8);
  const offsetTableOffset = readUInt(view, t + 24, 8);

  if (!offsetIntSize || !objectRefSize) throw new Error('binary plist trailer is malformed');

  const offsets: number[] = new Array(numObjects);
  for (let j = 0; j < numObjects; j++) {
    offsets[j] = readUInt(view, offsetTableOffset + j * offsetIntSize, offsetIntSize);
  }

  const cache: (PlistValue | undefined)[] = new Array(numObjects);

  function readRef(off: number): number { return readUInt(view, off, objectRefSize); }

  /* Marker byte is a type nibble plus a length nibble; 0xF in the length
   * nibble means the real length follows as its own integer object. */
  function readLength(off: number, lowNibble: number): { length: number; next: number } {
    if (lowNibble !== 0x0f) return { length: lowNibble, next: off + 1 };
    const sizeMarker = view.getUint8(off + 1);
    if ((sizeMarker & 0xf0) !== 0x10) throw new Error('bad length marker at ' + off);
    const intBytes = 1 << (sizeMarker & 0x0f);
    return { length: readUInt(view, off + 2, intBytes), next: off + 2 + intBytes };
  }

  function utf16be(off: number, chars: number): string {
    let s = '';
    for (let k = 0; k < chars; k++) s += String.fromCharCode(view.getUint16(off + k * 2, false));
    return s;
  }

  function ascii(off: number, len: number): string {
    let s = '';
    for (let k = 0; k < len; k++) s += String.fromCharCode(bytes[off + k]);
    return s;
  }

  function parseObject(index: number): PlistValue {
    if (index >= numObjects) throw new Error('object ref ' + index + ' out of range');
    if (cache[index] !== undefined) return cache[index];

    const off = offsets[index];
    const marker = view.getUint8(off);
    const type = marker & 0xf0;
    const low = marker & 0x0f;
    let out: PlistValue;

    switch (type) {
      case 0x00:
        if (low === 0) out = null;
        else if (low === 8) out = false;
        else if (low === 9) out = true;
        else if (low === 15) out = null;        // fill byte
        else throw new Error('unknown singleton marker 0x' + marker.toString(16));
        break;

      case 0x10: {                              // int, 2^low bytes, big-endian
        const n = 1 << low;
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
        const rn = 1 << low;
        if (rn === 4) out = view.getFloat32(off + 1, false);
        else if (rn === 8) out = view.getFloat64(off + 1, false);
        else throw new Error('unsupported real width ' + rn + ' bytes at offset ' + off);
        break;
      }

      case 0x30:                                // date: seconds since 2001-01-01
        out = new Date((view.getFloat64(off + 1, false) + 978307200) * 1000);
        break;

      case 0x40: {                              // data
        const d = readLength(off, low);
        out = bytes.slice(d.next, d.next + d.length);
        break;
      }

      case 0x50: {                              // ASCII string
        const a = readLength(off, low);
        out = ascii(a.next, a.length);
        break;
      }

      case 0x60: {                              // UTF-16BE string
        const u = readLength(off, low);
        out = utf16be(u.next, u.length);
        break;
      }

      case 0x80:                                // UID
        out = { CFUID: readUInt(view, off + 1, low + 1) };
        break;

      case 0xa0:                                // array
      case 0xc0: {                              // set, treated as an array
        const arr = readLength(off, low);
        out = [];
        cache[index] = out;                     // set first: arrays can self-reference
        for (let ai = 0; ai < arr.length; ai++) {
          out.push(parseObject(readRef(arr.next + ai * objectRefSize)));
        }
        return out;
      }

      case 0xd0: {                              // dict
        const dd = readLength(off, low);
        out = {};
        cache[index] = out;
        const keysAt = dd.next;
        const valsAt = dd.next + dd.length * objectRefSize;
        for (let di = 0; di < dd.length; di++) {
          const key = parseObject(readRef(keysAt + di * objectRefSize));
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
export function isBinaryPlist(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 8) return false;
  const b = new Uint8Array(buffer, 0, 8);
  for (let i = 0; i < 8; i++) if (b[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}
