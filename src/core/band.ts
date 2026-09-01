/*
 * GarageBand `.band` project reader - the small, boring part of the bundle
 * that happens to hold everything this tool needs.
 *
 * Measured 2026-08-28 against GarageBand 10.4.14 projects, by changing one
 * value at a time in the app and diffing:
 *
 *   Chemical Plant.band/
 *     projectData                       NSKeyedArchiver XML wrapper, a stub
 *     Resources/ProjectInformation.plist  bundle identity, no musical data
 *     Alternatives/000/
 *       MetaData.plist                  <- everything below comes from here
 *       ProjectData                     1.2 MB, Logic's chunked song format
 *       DisplayState.plist              window layout
 *       DisplayStateArchive             window layout
 *       WindowImage.jpg                 the save-screen thumbnail
 *
 * MetaData.plist is a plain binary plist with flat scalar keys, so tempo,
 * time signature and key cost a plist read rather than any reverse
 * engineering of the chunk format. BeatsPerMinute is a real float, so
 * non-integer tempos survive.
 *
 * NOT AVAILABLE, and the reason is recorded so nobody re-runs the search:
 * the CYCLE / loop region is not in any of the plists. Searched ProjectData
 * for an adjacent (start,end) and (start,length) pair across beats, ppq
 * 240/480/768/960/1920/3840/15360, 0- and 1-based bars, seconds and samples,
 * as u16/u32/f32/f64, both endiannesses, within a 64-byte window, requiring
 * the candidate to be rare in two projects whose only difference was the
 * cycle position. Zero survivors. That rules out adjacent-pair storage in
 * those units; it does not rule out non-adjacent or encoded storage, so it
 * is a bounded negative, not a proof of absence.
 */
import { parseBinaryPlist, isBinaryPlist } from './bplist.js';
import type { PlistDict, PlistValue } from './bplist.js';

/*
 * ---- HAND-DECLARED, not from lib.dom ------------------------------------
 * The directory-drop API (`webkitGetAsEntry`, `createReader`, `readEntries`)
 * is non-standard and TypeScript's DOM lib types only part of it: its
 * `FileSystemEntry` carries neither `file` nor `createReader`, so the shapes
 * this file actually touches are declared here. They are deliberately
 * structural and minimal, so a real `DataTransferItemList` satisfies
 * `ArrayLike<DroppedItem>` without the caller casting anything.
 */

/** What both entry kinds have in common; `isFile`/`isDirectory` discriminate. */
interface FsEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

/** HAND-DECLARED: an `FsEntry` for which `isFile` is true. */
interface FsFileEntry extends FsEntry {
  file(success: (f: DroppedFile) => void, failure?: (e: unknown) => void): void;
}

/** HAND-DECLARED: an `FsEntry` for which `isDirectory` is true. */
interface FsDirectoryEntry extends FsEntry {
  createReader(): FsDirectoryReader;
}

/** HAND-DECLARED: batches out, empty batch means end. */
interface FsDirectoryReader {
  readEntries(success: (entries: FsEntry[]) => void, failure?: (e: unknown) => void): void;
}

/** HAND-DECLARED: the one member of `DataTransferItem` this file uses. */
export interface DroppedItem {
  webkitGetAsEntry?(): FsEntry | null;
}

/**
 * A dropped `File` carrying the bundle-relative `path` that `walkEntry`
 * attaches to it. `path` is not part of the standard `File`.
 */
export interface DroppedFile extends File {
  path?: string;
}

/**
 * The minimum `pickMetadataFile` reads: a bundle-relative path, a name, or
 * both. Both are optional because callers pass bare `{ path }` records as
 * well as real `File`s.
 */
export interface NamedFile {
  name?: string;
  path?: string;
}

/**
 * What `readBandMetadata` returns. Every musical field is optional because a
 * project missing one yields undefined for it rather than a default; `raw` is
 * always set, being the whole parsed plist.
 */
export interface BandMetadata {
  bpm?: number;
  beatsPerBar?: number;
  beatUnit?: number;
  sampleRate?: number;
  tracks?: number;
  key?: string;
  mode?: string;
  version?: number;
  raw: PlistValue;
}

const KEY_NAMES = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];

/*
 * Pull the useful fields out of a MetaData.plist buffer. Every field is
 * optional: a project missing one yields undefined for it rather than a
 * default, so the caller can tell "GarageBand said 4/4" from "we assumed
 * 4/4". That distinction is the whole reason not to fill in defaults here.
 */
export function readBandMetadata(buffer: ArrayBuffer): BandMetadata {
  if (!isBinaryPlist(buffer)) throw new Error('MetaData.plist is not a binary plist');
  // Named cast #1: the parser's union includes Date/Uint8Array/array, which
  // carry no string keys. The `typeof` guard on the next line is what makes
  // this true at runtime; it does not narrow the union in the type system.
  const p = parseBinaryPlist(buffer) as PlistDict;
  if (!p || typeof p !== 'object') throw new Error('MetaData.plist did not parse to a dictionary');

  // Named cast #2: `raw` is required on BandMetadata and is assigned at the
  // end of this function, so the empty literal is incomplete until then.
  const out = {} as BandMetadata;
  if (typeof p.BeatsPerMinute === 'number') out.bpm = p.BeatsPerMinute;
  if (typeof p.SongSignatureNumerator === 'number') out.beatsPerBar = p.SongSignatureNumerator;
  if (typeof p.SongSignatureDenominator === 'number') out.beatUnit = p.SongSignatureDenominator;
  if (typeof p.SampleRate === 'number') out.sampleRate = p.SampleRate;
  if (typeof p.NumberOfTracks === 'number') out.tracks = p.NumberOfTracks;
  if (typeof p.SongKey === 'string') out.key = p.SongKey;
  if (typeof p.SongGenderKey === 'string') out.mode = p.SongGenderKey;
  if (typeof p.Version === 'number') out.version = p.Version;
  out.raw = p;
  return out;
}

/* A one-line description for the status bar, listing only what was found. */
export function describeBandMetadata(m: BandMetadata): string {
  const bits: string[] = [];
  if (m.bpm !== undefined) bits.push(formatBpm(m.bpm) + ' BPM');
  if (m.beatsPerBar !== undefined && m.beatUnit !== undefined) {
    bits.push(m.beatsPerBar + '/' + m.beatUnit);
  }
  if (m.key) bits.push(m.key + (m.mode ? ' ' + m.mode : ''));
  if (m.sampleRate) bits.push(m.sampleRate + ' Hz');
  if (m.tracks !== undefined) bits.push(m.tracks + ' tracks');
  return bits.join(', ');
}

/* Trim float noise without lying about a genuinely fractional tempo. */
export function formatBpm(bpm: number): string {
  const r = Math.round(bpm * 1000) / 1000;
  return (r === Math.round(r)) ? String(Math.round(r)) : String(r);
}

/*
 * Is this entry the metadata file we want? Accepts the file dropped on its
 * own as well as found inside a bundle.
 */
export function isMetadataPath(path: string): boolean {
  return /(^|\/)MetaData\.plist$/i.test(path);
}

/*
 * Walk a dropped directory (a .band bundle is a directory) and return the
 * MetaData.plist File, preferring the lowest-numbered Alternatives entry -
 * that is the active alternative, and a project with several would otherwise
 * resolve by directory-iteration order, which is not defined.
 */
export function pickMetadataFile<T extends NamedFile>(files: T[]): T | null {
  // The `|| ''` are the only additions: with neither field set the original
  // handed `undefined` to a regex test, which coerces to the string
  // "undefined" and fails to match exactly as '' does - so the filter drops
  // that record either way and the sort below never sees one.
  const cands = files.filter(function (f) { return isMetadataPath(f.path || f.name || ''); });
  if (!cands.length) return null;
  cands.sort(function (a, b) {
    const pa = a.path || a.name || '', pb = b.path || b.name || '';
    const na = alternativeIndex(pa), nb = alternativeIndex(pb);
    if (na !== nb) return na - nb;
    return pa.length - pb.length;
  });
  return cands[0];
}

function alternativeIndex(path: string): number {
  const m = /Alternatives\/(\d+)\//.exec(path);
  return m ? parseInt(m[1], 10) : 9999;
}

/*
 * Read every file out of a dropped DataTransferItem that is a directory.
 * Uses the webkitGetAsEntry API, which is what browsers expose for folder
 * drops - and a macOS bundle arrives as a folder.
 */
export function readDroppedEntries(items: ArrayLike<DroppedItem>): Promise<DroppedFile[]> {
  const entries: FsEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    // `a && a()` in the original; the optional call is the same guard, and TS
    // cannot narrow the first read through a non-const index (TS2722).
    const e = items[i].webkitGetAsEntry?.();
    if (e) entries.push(e);
  }
  if (!entries.length) return Promise.resolve([]);
  return Promise.all(entries.map(function (e) { return walkEntry(e, ''); }))
    .then(function (lists) {
      return lists.reduce<DroppedFile[]>(function (a, b) { return a.concat(b); }, []);
    });
}

function walkEntry(entry: FsEntry, prefix: string): Promise<DroppedFile[]> {
  const path = prefix + entry.name;
  if (entry.isFile) {
    return new Promise<DroppedFile[]>(function (resolve) {
      (entry as FsFileEntry).file(function (f) { f.path = path; resolve([f]); },
                 function () { resolve([]); });
    });
  }
  if (!entry.isDirectory) return Promise.resolve([]);

  const reader = (entry as FsDirectoryEntry).createReader();
  let acc: FsEntry[] = [];
  return new Promise<DroppedFile[]>(function (resolve) {
    // readEntries returns a batch at a time and signals the end with an empty
    // batch. Reading once and stopping silently truncates a large bundle.
    const readBatch = function (): void {
      reader.readEntries(function (batch) {
        if (!batch.length) {
          Promise.all(acc.map(function (c) { return walkEntry(c, path + '/'); }))
            .then(function (lists) {
              resolve(lists.reduce<DroppedFile[]>(function (a, b) { return a.concat(b); }, []));
            });
          return;
        }
        acc = acc.concat(Array.prototype.slice.call(batch));
        readBatch();
      }, function () { resolve([]); });
    };
    readBatch();
  });
}
