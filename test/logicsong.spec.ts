/*
 * Unit tests for the Logic/GarageBand chunked `ProjectData` reader.
 *
 * Every fixture here is SYNTHESISED by the builder below - none of it is
 * derived from, or a copy of, any real project file. The builder is written
 * strictly from the format documented in the header comment of
 * `src/core/logicsong.ts`, which is the module under test and is NOT
 * modified by this file.
 */
import { describe, it, expect } from 'vitest';
import {
  PPQ,
  TICK_ORIGIN,
  readRecords,
  parseLogicSong,
  tempoMapToBars,
  describeNonSong,
  isProjectDataPath,
} from '../src/core/logicsong.js';

/* ---- synthetic chunked-song builder ------------------------------------- */

const ROOT_HEADER_SIZE = 24;
const RECORD_HEADER_SIZE = 0x24;
const ROOT_MAGIC = [0x23, 0x47, 0xc0, 0xab];

/*
 * The tick origin, written here as a LITERAL on purpose.
 *
 * MEASURED 2026-09-02: an earlier version of this file imported TICK_ORIGIN
 * and used it to build fixtures, and a mutation setting the constant to 0 was
 * caught by NOTHING - all twelve tests still passed, because the write side
 * and the read side moved together. A guarded quantity derived from the
 * constant you perturb is green by construction. The one assertion below is
 * what pins the value; everything else builds against this literal.
 */
const ORIGIN = 38400;

/** A row is exactly 4 little-endian u32 words (16 bytes). */
type Row = [number, number, number, number];

interface RawRecord {
  tag: string;
  payload: Uint8Array;
}

function packRows(rows: Row[]): Uint8Array {
  const out = new Uint8Array(rows.length * 16);
  const dv = new DataView(out.buffer);
  rows.forEach((row, ri) => {
    row.forEach((word, wi) => dv.setUint32(ri * 16 + wi * 4, word >>> 0, true));
  });
  return out;
}

/** Two rows encoding a tempo event: marker 0x60 + tick, then raw BPM*10000. */
function tempoRows(tickWithOrigin: number, bpm: number): Row[] {
  return [
    [0x60, tickWithOrigin, 0, 0],
    [Math.round(bpm * 10000), 0, 0, 0],
  ];
}

/** Same shape as tempoRows, but the second word is an already-raw BPM*10000
 * value rather than being derived from a real BPM - for building decoys that
 * report sub-1-BPM garbage the way note/automation data does. */
function rawTempoRows(tickWithOrigin: number, rawBpm: number): Row[] {
  return [
    [0x60, tickWithOrigin, 0, 0],
    [rawBpm, 0, 0, 0],
  ];
}

/** Two rows encoding a time signature event: marker 0x30, tick, denominator
 * shift in the top byte of word 3, numerator in word 4. Second row unused. */
function sigRows(tickWithOrigin: number, numerator: number, denominatorShift: number): Row[] {
  return [
    [0x30, tickWithOrigin, (denominatorShift << 24) >>> 0, numerator],
    [0, 0, 0, 0],
  ];
}

/** The 0xf1 terminator, plus one filler row so a scanner that requires room
 * for a trailing row (as this format's does) actually reaches the marker. */
function terminatorRows(): Row[] {
  return [
    [0xf1, 0, 0, 0],
    [0, 0, 0, 0],
  ];
}

function qSvE(...rowGroups: Row[][]): RawRecord {
  const rows: Row[] = ([] as Row[]).concat(...rowGroups);
  return { tag: 'qSvE', payload: packRows(rows) };
}

/** Bar N (1-based) start tick under a constant 4/4, relative to tick 0. */
function barTick4_4(bar: number): number {
  return (bar - 1) * 4 * PPQ;
}

function buildSong(records: RawRecord[]): ArrayBuffer {
  const recordBytes = records.map((r) => {
    if (r.tag.length !== 4) throw new Error('tag must be 4 characters');
    const buf = new Uint8Array(RECORD_HEADER_SIZE + r.payload.length);
    for (let i = 0; i < 4; i++) buf[i] = r.tag.charCodeAt(i);
    new DataView(buf.buffer).setUint32(0x1c, r.payload.length, true);
    buf.set(r.payload, RECORD_HEADER_SIZE);
    return buf;
  });
  const recordsTotal = recordBytes.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(ROOT_HEADER_SIZE + recordsTotal);
  out.set(ROOT_MAGIC, 0);
  new DataView(out.buffer).setUint32(0x10, recordsTotal, true);
  let off = ROOT_HEADER_SIZE;
  for (const rb of recordBytes) {
    out.set(rb, off);
    off += rb.length;
  }
  return out.buffer;
}

/* ---- 1. round trip ------------------------------------------------------- */

describe('parseLogicSong / tempoMapToBars: round trip', () => {
  it('reads a two-tempo, explicit-4/4 project back out exactly', () => {
    const tempoRecord = qSvE(
      tempoRows(ORIGIN + barTick4_4(1), 115),
      tempoRows(ORIGIN + barTick4_4(6), 128.3402),
      terminatorRows(),
    );
    const sigRecord = qSvE(sigRows(ORIGIN + 0, 4, 2), terminatorRows());
    const buf = buildSong([tempoRecord, sigRecord]);

    const song = parseLogicSong(buf);
    expect(song.tempos).toEqual([
      { tick: 0, bpm: 115 },
      { tick: 19200, bpm: 128.3402 },
    ]);

    const bars = tempoMapToBars(song);
    expect(bars).toEqual([
      { bar: 1, bpm: 115, beatsPerBar: 4 },
      { bar: 6, bpm: 128.3402, beatsPerBar: 4 },
    ]);
  });
});

/* ---- 2. decoy rejection ---------------------------------------------------
 *
 * The header comment documents three qSvE records in a real project sharing
 * a row that starts with marker 0x60: one genuine tempo map and two decoys
 * (note/automation data) reporting ticks near 2^31 and sub-1-BPM values.
 * `pickTempoRecord` throws those out because their first event does not sit
 * at TICK_ORIGIN - this is the test that a naive "find any 0x60 row" scan
 * would fail.
 */

describe('parseLogicSong: decoy qSvE records', () => {
  const DECOY_TICK = 2298478594; // near 2^31, as documented
  const genuineTempoRecord = qSvE(
    tempoRows(ORIGIN + barTick4_4(1), 115),
    tempoRows(ORIGIN + barTick4_4(6), 128.3402),
    terminatorRows(),
  );
  const decoy1 = qSvE(rawTempoRows(DECOY_TICK, 280), terminatorRows()); // 0.028 BPM
  const decoy2 = qSvE(rawTempoRows(DECOY_TICK, 1536), terminatorRows()); // 0.1536 BPM

  it('finds the genuine tempo map alongside two decoy records', () => {
    const buf = buildSong([genuineTempoRecord, decoy1, decoy2]);
    const song = parseLogicSong(buf);
    expect(song.tempos).toEqual([
      { tick: 0, bpm: 115 },
      { tick: 19200, bpm: 128.3402 },
    ]);
  });

  it('finds the genuine tempo map when the decoys come first', () => {
    const buf = buildSong([decoy1, decoy2, genuineTempoRecord]);
    const song = parseLogicSong(buf);
    expect(song.tempos).toEqual([
      { tick: 0, bpm: 115 },
      { tick: 19200, bpm: 128.3402 },
    ]);
  });

  it('throws when only decoys are present', () => {
    const buf = buildSong([decoy1, decoy2]);
    expect(() => parseLogicSong(buf)).toThrow();
  });
});

/* ---- 3. bar-1 pinning ------------------------------------------------------ */

describe('parseLogicSong: bar-1 pinning', () => {
  it('rejects a tempo record whose first event is not at TICK_ORIGIN', () => {
    // First (and only) tempo event sits at bar 2, not bar 1 - not pinned.
    const unpinned = qSvE(tempoRows(ORIGIN + barTick4_4(2), 120), terminatorRows());
    const buf = buildSong([unpinned]);
    expect(() => parseLogicSong(buf)).toThrow();
  });
});

/* ---- 4. meter map ---------------------------------------------------------
 *
 * 4/4 from bar 1, 3/4 from bar 3. Bar-tick math (PPQ = 960):
 *   4/4 bar length  = 4 * (4/4) * 960 = 3840 ticks
 *   3/4 bar length  = 3 * (4/4) * 960 = 2880 ticks
 *   bar 3 starts at 2 * 3840             = 7680  (end of bars 1-2)
 *   bar 4 starts at 7680 + 2880          = 10560
 *   bar 5 starts at 10560 + 2880         = 13440
 *   bar 6 starts at 13440 + 2880         = 16320
 *   bar 7 starts at 16320 + 2880         = 19200 (end of bars 3-6)
 * So a tempo change at tick 19200 must land on bar 7 under the real meter
 * map. A naive division by a constant 3840-tick 4/4 bar would instead give
 * 19200 / 3840 = 5.0 -> bar 6 - the two disagree here, which is the point.
 */

describe('tempoMapToBars: walks the meter map instead of dividing', () => {
  it('places a tempo change correctly across a signature change', () => {
    const tempoRecord = qSvE(
      tempoRows(ORIGIN + 0, 100),
      tempoRows(ORIGIN + 19200, 140),
      terminatorRows(),
    );
    const sigRecord = qSvE(
      sigRows(ORIGIN + 0, 4, 2), // 4/4 from bar 1
      sigRows(ORIGIN + 7680, 3, 2), // 3/4 from bar 3
      terminatorRows(),
    );
    const buf = buildSong([tempoRecord, sigRecord]);

    const song = parseLogicSong(buf);
    const bars = tempoMapToBars(song);
    expect(bars).toEqual([
      { bar: 1, bpm: 100, beatsPerBar: 4 },
      { bar: 7, bpm: 140, beatsPerBar: 3 },
    ]);
  });
});

/* ---- 5. container validation ----------------------------------------------- */

describe('readRecords / describeNonSong: container validation', () => {
  /*
   * CHANGED 2026-09-02: a bad length field is no longer fatal.
   *
   * The old assertion was `toThrow(/length field/)`. That check had been
   * verified against exactly ONE real project, and making it fatal on a
   * sample of that size risks rejecting a legitimate file over a header
   * convention nobody has surveyed. The walk landing exactly on the final
   * byte is the integrity check that cannot pass by accident, so the records
   * are what decide - the length field only decorates the error when the walk
   * ALSO fails.
   */
  it('tolerates a wrong length field when the records still walk cleanly', () => {
    const buf = buildSong([qSvE(tempoRows(ORIGIN, 120), terminatorRows())]);
    const bytes = new Uint8Array(buf.slice(0));
    new DataView(bytes.buffer).setUint32(0x10, 0xdeadbeef, true);
    expect(() => readRecords(bytes.buffer)).not.toThrow();
    expect(readRecords(bytes.buffer)).toHaveLength(1);
  });

  it('throws when a record size field would walk past EOF', () => {
    // Hand-built, not through buildSong: root header says the file is
    // exactly ROOT_HEADER_SIZE + RECORD_HEADER_SIZE + 8 bytes long (which is
    // true), but the record's own size field lies and claims a payload far
    // larger than actually fits.
    const payloadLen = 8;
    const total = ROOT_HEADER_SIZE + RECORD_HEADER_SIZE + payloadLen;
    const out = new Uint8Array(total);
    out.set(ROOT_MAGIC, 0);
    const dv = new DataView(out.buffer);
    dv.setUint32(0x10, total - ROOT_HEADER_SIZE, true);
    for (let i = 0; i < 4; i++) out[ROOT_HEADER_SIZE + i] = 'qSvE'.charCodeAt(i);
    dv.setUint32(ROOT_HEADER_SIZE + 0x1c, 1000, true); // lies: way past EOF
    expect(() => readRecords(out.buffer)).toThrow(/desynchronised/);
  });

  it('throws on a buffer with the wrong magic', () => {
    const bytes = new Uint8Array(32); // all zero - fails the magic check
    expect(() => readRecords(bytes.buffer)).toThrow();
  });

  it('describeNonSong on an XML-prefixed buffer mentions the real path', () => {
    const xml = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><plist></plist>');
    const msg = describeNonSong(xml.buffer);
    expect(msg).toContain('Alternatives/000/ProjectData');
  });
});

/* ---- 6. isProjectDataPath -------------------------------------------------- */

describe('isProjectDataPath', () => {
  it('matches the bare filename and the Alternatives path', () => {
    expect(isProjectDataPath('ProjectData')).toBe(true);
    expect(isProjectDataPath('Sortie.band/Alternatives/000/ProjectData')).toBe(true);
  });

  /*
   * CHANGED 2026-09-02, driven by a real drop: a user dropped the bundle-root
   * `projectData` (lowercase p) and the capital-only match declined it, so it
   * fell through to the audio decoder and reported a decode error - true and
   * useless. Routing is now by NAME, case-insensitively, and the diagnosis is
   * by CONTENT: describeNonSong names the mistake and points at
   * Alternatives/000/ProjectData. Extensions are still rejected.
   */
  it('matches the lowercase bundle-root projectData, so it can be diagnosed by content', () => {
    expect(isProjectDataPath('Sortie.band/projectData')).toBe(true);
  });

  it('does not match a file with an extension', () => {
    expect(isProjectDataPath('Sortie.band/Alternatives/000/ProjectData.bak')).toBe(false);
    expect(isProjectDataPath('ProjectData.zip')).toBe(false);
  });
});

describe('format constants', () => {
  /*
   * The only place TICK_ORIGIN is read. Every fixture above builds against the
   * ORIGIN literal instead, so this assertion is what actually holds the
   * constant in place - see the comment on ORIGIN for the mutation that
   * proved a symmetric fixture cannot.
   */
  it('pins the tick origin and ppq to the measured values', () => {
    expect(TICK_ORIGIN).toBe(38400);
    expect(PPQ).toBe(960);
  });
});
