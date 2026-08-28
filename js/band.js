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

var KEY_NAMES = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];

/*
 * Pull the useful fields out of a MetaData.plist buffer. Every field is
 * optional: a project missing one yields undefined for it rather than a
 * default, so the caller can tell "GarageBand said 4/4" from "we assumed
 * 4/4". That distinction is the whole reason not to fill in defaults here.
 */
export function readBandMetadata(buffer) {
  if (!isBinaryPlist(buffer)) throw new Error('MetaData.plist is not a binary plist');
  var p = parseBinaryPlist(buffer);
  if (!p || typeof p !== 'object') throw new Error('MetaData.plist did not parse to a dictionary');

  var out = {};
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
export function describeBandMetadata(m) {
  var bits = [];
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
export function formatBpm(bpm) {
  var r = Math.round(bpm * 1000) / 1000;
  return (r === Math.round(r)) ? String(Math.round(r)) : String(r);
}

/*
 * Is this entry the metadata file we want? Accepts the file dropped on its
 * own as well as found inside a bundle.
 */
export function isMetadataPath(path) {
  return /(^|\/)MetaData\.plist$/i.test(path);
}

/*
 * Walk a dropped directory (a .band bundle is a directory) and return the
 * MetaData.plist File, preferring the lowest-numbered Alternatives entry -
 * that is the active alternative, and a project with several would otherwise
 * resolve by directory-iteration order, which is not defined.
 */
export function pickMetadataFile(files) {
  var cands = files.filter(function (f) { return isMetadataPath(f.path || f.name); });
  if (!cands.length) return null;
  cands.sort(function (a, b) {
    var pa = a.path || a.name, pb = b.path || b.name;
    var na = alternativeIndex(pa), nb = alternativeIndex(pb);
    if (na !== nb) return na - nb;
    return pa.length - pb.length;
  });
  return cands[0];
}

function alternativeIndex(path) {
  var m = /Alternatives\/(\d+)\//.exec(path);
  return m ? parseInt(m[1], 10) : 9999;
}

/*
 * Read every file out of a dropped DataTransferItem that is a directory.
 * Uses the webkitGetAsEntry API, which is what browsers expose for folder
 * drops - and a macOS bundle arrives as a folder.
 */
export function readDroppedEntries(items) {
  var entries = [];
  for (var i = 0; i < items.length; i++) {
    var e = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
    if (e) entries.push(e);
  }
  if (!entries.length) return Promise.resolve([]);
  return Promise.all(entries.map(function (e) { return walkEntry(e, ''); }))
    .then(function (lists) {
      return lists.reduce(function (a, b) { return a.concat(b); }, []);
    });
}

function walkEntry(entry, prefix) {
  var path = prefix + entry.name;
  if (entry.isFile) {
    return new Promise(function (resolve) {
      entry.file(function (f) { f.path = path; resolve([f]); },
                 function () { resolve([]); });
    });
  }
  if (!entry.isDirectory) return Promise.resolve([]);

  var reader = entry.createReader();
  var acc = [];
  return new Promise(function (resolve) {
    // readEntries returns a batch at a time and signals the end with an empty
    // batch. Reading once and stopping silently truncates a large bundle.
    var readBatch = function () {
      reader.readEntries(function (batch) {
        if (!batch.length) {
          Promise.all(acc.map(function (c) { return walkEntry(c, path + '/'); }))
            .then(function (lists) {
              resolve(lists.reduce(function (a, b) { return a.concat(b); }, []));
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
