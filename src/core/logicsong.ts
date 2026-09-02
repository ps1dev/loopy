/*
 * Logic / GarageBand `ProjectData` reader - tempo map and time signatures.
 *
 * WHY THIS EXISTS: `MetaData.plist` carries exactly ONE `BeatsPerMinute`
 * scalar and no nested structure at all, so it can never describe a project
 * whose tempo changes. The tempo MAP lives in the chunked binary at
 * `<project>.band/Alternatives/000/ProjectData`.
 *
 * Container, verified against a real GarageBand 10.4.14 project (a 4,009,795
 * byte file, 3,297 records, walk terminating exactly on the final byte):
 *
 *   ROOT      +0x00  4  magic 23 47 C0 AB
 *             +0x10  4  u32 length = filesize - 24
 *             +0x18     records to EOF
 *   RECORD    +0x00  4  tag, a BYTE-REVERSED FourCC ('qSvE' on disk = EvSq)
 *             +0x1c  4  u32 payload size; record total = 0x24 + size
 *
 * Everything is LITTLE-ENDIAN. Other reverse-engineering efforts are recorded
 * as having stalled by assuming big-endian.
 *
 * EVENTS: a `qSvE` payload is a sequence of 16-byte rows whose first u32 is a
 * marker. A tempo event is two rows - marker 0x60 with the tick position in
 * the second word, then a row whose first word is round(BPM * 10000). There
 * are no floats anywhere in it. 0xf1 terminates a record's event list.
 *
 * ⚠ A NAIVE MARKER SCAN FINDS DECOYS. In the verified project, three separate
 * `qSvE` records contain a row starting 0x60; two of them are note or
 * automation data where the byte coincides, reporting positions near 2^31 and
 * tempos under 1 BPM. `pickTempoRecord` is the part that matters, not the row
 * walk. The upstream format notes carry the same warning ("never blind-scan")
 * about a decoy at file offset 0xAE.
 */

/** Ticks per quarter note. */
export const PPQ = 960;

/**
 * Tick positions in this format are stored with an origin rather than from
 * zero, which is why scanning for absolute positions from 0 finds nothing.
 */
export const TICK_ORIGIN = 38400;

/** Musical bounds used to reject decoy rows, in raw BPM*10000 units. */
const MIN_RAW_BPM = 50000;      /* 5 BPM */
const MAX_RAW_BPM = 10000000;   /* 1000 BPM */

/** Highest tick we will believe, ~2000 bars of 4/4. */
const MAX_TICK = TICK_ORIGIN + 2000 * 4 * PPQ;

const MARKER_TEMPO = 0x60;
const MARKER_SIGNATURE = 0x30;
const MARKER_END = 0xf1;

const ROOT_MAGIC = [0x23, 0x47, 0xc0, 0xab];

export interface TempoEvent {
  /** Ticks from the start of the song, origin already removed. */
  tick: number;
  bpm: number;
}

export interface SignatureEvent {
  tick: number;
  numerator: number;
  denominator: number;
}

export interface LogicSong {
  tempos: TempoEvent[];
  signatures: SignatureEvent[];
}

/** A tempo change expressed the way `BeatGrid.setTempos` wants it. */
export interface BarTempo {
  bar: number;
  bpm: number;
  beatsPerBar: number;
}

/**
 * Is this the project binary? No extension, optionally under an
 * `Alternatives/<n>/` directory.
 *
 * ⚠ CASE-INSENSITIVE ON PURPOSE, changed 2026-09-02 after a user dropped the
 * bundle-root `projectData` (lowercase p). A capital-only match declined it
 * silently and it fell through to the audio decoder, which reports a decode
 * error - true, useless, and it hides the one thing worth saying. Routing on
 * the NAME and diagnosing on the CONTENT is the right split: this accepts
 * both, and `describeNonSong` then names the mistake exactly.
 */
export function isProjectDataPath(path: string): boolean {
  return /(^|\/)ProjectData$/i.test(path);
}

export function isChunkedSong(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 24) return false;
  const b = new Uint8Array(buffer, 0, 4);
  for (let i = 0; i < 4; i++) if (b[i] !== ROOT_MAGIC[i]) return false;
  return true;
}

/**
 * Explain a buffer that is not a chunked song, in the terms of the mistake
 * someone is most likely to have made. The bundle root holds a `projectData`
 * (lowercase p) which is an NSKeyedArchiver plist wrapping an OLD song blob -
 * in the verified bundle it was a save from two years before the real one and
 * reported a tempo the project had not used since. It parses perfectly, which
 * is exactly why it needs naming rather than a generic failure.
 */
export function describeNonSong(buffer: ArrayBuffer): string {
  const head = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  const ascii = String.fromCharCode.apply(null, Array.from(head));
  if (ascii.indexOf('<?xml') === 0 || ascii.indexOf('bplist00') === 0) {
    return 'That is a property list, not the project binary. The bundle root holds a ' +
      'stale `projectData` (lowercase p); the tempo map is in ' +
      'Alternatives/000/ProjectData (capital P).';
  }
  return 'Not a Logic/GarageBand project binary (expected magic 23 47 C0 AB).';
}

interface Record_ {
  tag: string;
  offset: number;
  size: number;
}

/**
 * Walk the record table. Throws on desynchronisation rather than returning a
 * partial list: a wrong size field walks off into the middle of a payload and
 * every record after it is fiction, so a short-but-clean-looking list is the
 * dangerous outcome. A correct walk lands exactly on the final byte.
 */
export function readRecords(buffer: ArrayBuffer): Record_[] {
  if (!isChunkedSong(buffer)) throw new Error(describeNonSong(buffer));
  const dv = new DataView(buffer);
  /*
   * The length field is checked but NOT fatal.
   *
   * It matched exactly on the one project I had when this was written, and a
   * hard failure on a sample of size one would reject a legitimate file for a
   * header convention I have not actually surveyed. The real integrity check
   * is below: a walk that lands exactly on the final byte cannot be a
   * coincidence, and a wrong one desynchronises within a few records.
   */
  const declared = dv.getUint32(0x10, true);
  const lengthFieldOk = declared === buffer.byteLength - 24;
  const out: Record_[] = [];
  let off = 0x18;
  while (off + 0x24 <= buffer.byteLength) {
    const size = dv.getUint32(off + 0x1c, true);
    const bytes = new Uint8Array(buffer, off, 4);
    /* Tags are stored byte-reversed; present them the way the format
     * documentation names them, so 'qSvE' on disk reads as 'qSvE'. */
    const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const next = off + 0x24 + size;
    if (next <= off || next > buffer.byteLength) {
      throw new Error('record table desynchronised at offset 0x' + off.toString(16));
    }
    out.push({ tag: tag, offset: off + 0x24, size: size });
    off = next;
  }
  if (off !== buffer.byteLength) {
    throw new Error('record walk ended at 0x' + off.toString(16) + ', expected 0x' +
      buffer.byteLength.toString(16) +
      (lengthFieldOk ? '' : ' (the header length field disagrees with the file size too)'));
  }
  return out;
}

/** Every tempo event in one record's payload, unvalidated. */
function rawTempoEvents(dv: DataView, start: number, size: number): TempoEvent[] {
  const out: TempoEvent[] = [];
  for (let i = 0; i + 32 <= size; i += 16) {
    const marker = dv.getUint32(start + i, true);
    if (marker === MARKER_END) break;
    if (marker !== MARKER_TEMPO) continue;
    out.push({
      tick: dv.getUint32(start + i + 4, true),
      bpm: dv.getUint32(start + i + 16, true),
    });
  }
  return out;
}

/**
 * Choose the real tempo record among the candidates.
 *
 * The discriminator is that a genuine tempo map PINS BAR ONE: its first event
 * sits exactly at TICK_ORIGIN. Decoy rows carry whatever the surrounding note
 * or automation data happened to contain, which is never that value. The
 * range checks are a second net, not the primary one.
 */
function pickTempoRecord(cands: TempoEvent[][]): TempoEvent[] | null {
  const valid = cands.filter(function (evs) {
    if (!evs.length) return false;
    if (evs[0].tick !== TICK_ORIGIN) return false;
    return evs.every(function (e) {
      return e.tick >= TICK_ORIGIN && e.tick <= MAX_TICK &&
        e.bpm >= MIN_RAW_BPM && e.bpm <= MAX_RAW_BPM;
    });
  });
  if (!valid.length) return null;
  /* A project can carry more than one copy of the same map. Prefer the
   * richest, which is the one that has actually been edited. */
  valid.sort(function (a, b) { return b.length - a.length; });
  return valid[0];
}

function rawSignatureEvents(dv: DataView, start: number, size: number): SignatureEvent[] {
  const out: SignatureEvent[] = [];
  for (let i = 0; i + 32 <= size; i += 16) {
    const marker = dv.getUint32(start + i, true);
    if (marker === MARKER_END) break;
    if (marker !== MARKER_SIGNATURE) continue;
    /* Numerator in the 4th word; the 3rd word holds the denominator as a
     * left-shifted power of two (0x02000000 -> 2 -> 1<<2 = 4). */
    const numerator = dv.getUint32(start + i + 12, true);
    const denomShift = dv.getUint32(start + i + 8, true) >>> 24;
    const denominator = 1 << denomShift;
    if (numerator < 1 || numerator > 64) continue;
    if (denomShift < 1 || denomShift > 6) continue;
    out.push({ tick: dv.getUint32(start + i + 4, true), numerator: numerator, denominator: denominator });
  }
  return out;
}

/**
 * Parse a `ProjectData` buffer. Ticks in the result have the origin removed,
 * so the first tempo is at tick 0.
 */
export function parseLogicSong(buffer: ArrayBuffer): LogicSong {
  const recs = readRecords(buffer);
  const dv = new DataView(buffer);
  const tempoCands: TempoEvent[][] = [];
  let signatures: SignatureEvent[] = [];
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].tag !== 'qSvE') continue;
    const t = rawTempoEvents(dv, recs[i].offset, recs[i].size);
    if (t.length) tempoCands.push(t);
    if (!signatures.length) {
      const s = rawSignatureEvents(dv, recs[i].offset, recs[i].size);
      if (s.length) signatures = s;
    }
  }
  const chosen = pickTempoRecord(tempoCands);
  if (!chosen) {
    throw new Error('no tempo map found (' + tempoCands.length +
      ' candidate record(s), none pinned to bar 1)');
  }
  return {
    tempos: chosen.map(function (e) {
      return { tick: e.tick - TICK_ORIGIN, bpm: e.bpm / 10000 };
    }),
    signatures: signatures.map(function (s) {
      return { tick: Math.max(0, s.tick - TICK_ORIGIN), numerator: s.numerator, denominator: s.denominator };
    }),
  };
}

/**
 * Convert tick positions to bar numbers, walking the meter map alongside -
 * a tempo change at tick T is at a bar that depends on every preceding time
 * signature, so this cannot be a division.
 *
 * `fallback` is used when the project states no signature, and the caller
 * should pass what MetaData.plist said rather than guessing, so an assumed
 * 4/4 stays distinguishable from a read one.
 */
export function tempoMapToBars(song: LogicSong, fallback?: { numerator: number; denominator: number }): BarTempo[] {
  const sigs = song.signatures.length ? song.signatures.slice()
    : [{ tick: 0, numerator: (fallback && fallback.numerator) || 4, denominator: (fallback && fallback.denominator) || 4 }];
  sigs.sort(function (a, b) { return a.tick - b.tick; });
  if (sigs[0].tick > 0) sigs.unshift({ tick: 0, numerator: sigs[0].numerator, denominator: sigs[0].denominator });

  function barAt(tick: number): number {
    let bars = 0;
    let cursor = 0;
    for (let i = 0; i < sigs.length; i++) {
      const barTicks = sigs[i].numerator * (4 / sigs[i].denominator) * PPQ;
      const until = (i + 1 < sigs.length) ? Math.min(sigs[i + 1].tick, tick) : tick;
      if (until > cursor) {
        bars += (until - cursor) / barTicks;
        cursor = until;
      }
      if (cursor >= tick) break;
    }
    return Math.round(bars) + 1;
  }

  return song.tempos.map(function (t) {
    let sig = sigs[0];
    for (let i = 0; i < sigs.length; i++) if (sigs[i].tick <= t.tick) sig = sigs[i];
    return { bar: barAt(t.tick), bpm: t.bpm, beatsPerBar: sig.numerator };
  });
}
