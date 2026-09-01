/*
 * Unit tests for the binary plist reader and the GarageBand .band metadata
 * built on top of it.
 */
import { describe, it, expect } from 'vitest';

/* ---- binary plist + .band metadata ------------------------------------- */

import { parseBinaryPlist, isBinaryPlist } from '../src/core/bplist.js';
import { readBandMetadata, formatBpm, pickMetadataFile } from '../src/core/band.js';
import fs from 'node:fs';

/* Real GarageBand 10.4.14 files. Expected values are what Python's plistlib
 * reported independently, and two of them are tempos Naoki set by hand in the
 * app and told me before I looked - so the oracle is external twice over. */
const BAND_FIXTURES: [string, number][] = [
  ['/tmp/band/Chemical Plant.band/Alternatives/000/MetaData.plist', 139.0],
  ['/tmp/band2/Chemical Plant.band/Alternatives/000/MetaData.plist', 121.0],
  ['/tmp/band3/Chemical Plant.band/Alternatives/000/MetaData.plist', 121.0]
];
const haveFixtures = BAND_FIXTURES.every(([p]) => fs.existsSync(p));

function buf(path: string): ArrayBuffer {
  const b = fs.readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe('binary plist + .band metadata', () => {
  it.skipIf(!haveFixtures)('isBinaryPlist rejects an XML plist and accepts a binary one', () => {
    expect(isBinaryPlist(buf(BAND_FIXTURES[0][0]))).toBe(true);
    const xml = new TextEncoder().encode('<?xml version="1.0"?><plist></plist>');
    expect(isBinaryPlist(xml.buffer)).toBe(false);
  });

  it.skipIf(!haveFixtures)('reads BeatsPerMinute out of real GarageBand projects', () => {
    for (const [path, expected] of BAND_FIXTURES) {
      const m = readBandMetadata(buf(path));
      expect(m.bpm, path).toBe(expected);
      expect(typeof m.bpm).toBe('number');
    }
  });

  it.skipIf(!haveFixtures)('reads time signature, key and rate', () => {
    const m = readBandMetadata(buf(BAND_FIXTURES[1][0]));
    expect(m.beatsPerBar).toBe(4);
    expect(m.beatUnit).toBe(4);
    expect(m.sampleRate).toBe(44100);
    expect(m.key).toBe('C');
    expect(m.mode).toBe('major');
    expect(m.tracks).toBe(12);
  });

  it.skipIf(!haveFixtures)('the tempo edit is visible, so the field is not a coincidence', () => {
    // Same project, one value changed in GarageBand between the two saves.
    const a = readBandMetadata(buf(BAND_FIXTURES[0][0]));
    const b = readBandMetadata(buf(BAND_FIXTURES[1][0]));
    expect(a.bpm).not.toBe(b.bpm);
    expect(a.beatsPerBar, 'only the tempo should have moved').toBe(b.beatsPerBar);
    expect(a.sampleRate).toBe(b.sampleRate);
  });

  it('a missing field yields undefined rather than a silent default', () => {
    // Hand-built minimal bplist: a dict with only BeatsPerMinute.
    const m = readBandMetadata(buildMiniPlist(98.6));
    expect(m.bpm).toBe(98.6);
    expect(m.beatsPerBar,
      'absent time signature must be undefined so callers can tell it was absent').toBe(undefined);
  });

  it('parseBinaryPlist throws on a non-plist instead of returning junk', () => {
    const junk = new Uint8Array(64);
    junk.set(new TextEncoder().encode('RIFF'));
    expect(() => parseBinaryPlist(junk.buffer)).toThrow(/not a binary plist/);
  });

  it('formatBpm keeps a fractional tempo and tidies an integer one', () => {
    expect(formatBpm(121.0)).toBe('121');
    expect(formatBpm(137.5)).toBe('137.5');
    expect(formatBpm(120.00000001)).toBe('120');
  });

  it('pickMetadataFile prefers the lowest Alternatives index', () => {
    const files = [
      { path: 'X.band/Alternatives/001/MetaData.plist' },
      { path: 'X.band/Alternatives/000/MetaData.plist' },
      { path: 'X.band/Resources/ProjectInformation.plist' }
    ];
    expect(pickMetadataFile(files)!.path).toBe('X.band/Alternatives/000/MetaData.plist');
    expect(pickMetadataFile([{ path: 'X.band/projectData' }])).toBe(null);
  });
});

/* Minimal bplist00 with one real-valued entry, so the "absent field" test
 * does not depend on a fixture being present. */
function buildMiniPlist(bpm: number): ArrayBuffer {
  const enc = new TextEncoder();
  const key = enc.encode('BeatsPerMinute');
  const parts: Uint8Array[] = [];
  parts.push(enc.encode('bplist00'));            // 0
  const offsets: number[] = [];
  let pos = 8;
  offsets.push(pos);                             // obj 0: dict, 1 entry
  parts.push(new Uint8Array([0xd1, 0x01, 0x02])); pos += 3;
  offsets.push(pos);                             // obj 1: ASCII key
  const k = new Uint8Array(1 + key.length);
  k[0] = 0x50 | key.length; k.set(key, 1);
  parts.push(k); pos += k.length;
  offsets.push(pos);                             // obj 2: double
  const dv = new Uint8Array(9); dv[0] = 0x23;
  new DataView(dv.buffer).setFloat64(1, bpm, false);
  parts.push(dv); pos += 9;

  const tableAt = pos;
  parts.push(new Uint8Array(offsets));           // 1-byte offsets
  pos += offsets.length;
  const tr = new Uint8Array(32);
  const tv = new DataView(tr.buffer);
  tr[6] = 1; tr[7] = 1;                          // offsetIntSize, objectRefSize
  tv.setUint32(12, offsets.length, false);       // numObjects (low half)
  tv.setUint32(20, 0, false);                    // topObject
  tv.setUint32(28, tableAt, false);              // offsetTableOffset
  parts.push(tr);

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}
