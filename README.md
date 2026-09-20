# Loop Point Editor

A web-based editor for audio loop points, aimed at getting a loop into a WAV
file's `smpl` chunk so that something downstream (psxavenc, a sampler, a game
engine) can use it.

Running at <https://tools.psx.dev/loopy/>.

Vanilla TypeScript, no framework, no runtime dependencies. Vite builds it to a
single self-contained `dist/index.html`: no external JS, no external CSS, no
fetches at runtime.

## Running it

**Double-click `dist/index.html`.** That is the whole procedure. No server, no
network, no install.

The single-file build is not packaging convenience. The earlier multi-file
version of this tool had to be served over HTTP, because a browser refuses to
load ES modules from a `file://` origin - and it failed in the worst possible
way, drawing the whole page correctly and then ignoring every click, since only
the module graph was blocked. Inlining the modules removes the fetch, so the
failure has nowhere left to live.

To build it, or to work on it:

    npm install
    npm run build      # -> dist/index.html
    npm run dev        # dev server with hot reload
    npm test           # tsc --noEmit, then the unit and browser suites

## What it does

**Import.** WAV files are parsed here rather than handed to the browser,
because `decodeAudioData` resamples to the output device's rate (which would
silently move every loop point) and discards every chunk that is not `fmt ` or
`data` (which is the one we care about). Any existing `smpl` loops are loaded
and shown. PCM 8/16/24/32-bit and 32/64-bit float are read, including
`WAVE_FORMAT_EXTENSIBLE`.

Anything that is not a RIFF file goes through `decodeAudioData`, so mp3, ogg,
flac and m4a work to whatever extent the browser supports them. That decode
runs on a throwaway `OfflineAudioContext`, never on the playback context: a
decode issued on a suspended context does not reliably call back (on macOS
Safari it never resolves), which showed up as the first non-WAV file hanging
until a second file was loaded and supplied the gesture that unblocked it.
Non-WAV imports are resampled to the decoding context's rate - there is no way
to learn a compressed file's native rate without decoding it first.

Loading shows an overlay with a spinner once it passes ~180 ms, so a small file
does not flash one. No progress bar: `decodeAudioData` reports no progress at
all, and a bar that is honest for one phase and invented for another is worse
than a spinner. The waveform build afterwards is chunked so the window stays
responsive and the spinner keeps turning.

**Display.** Waveform with a per-channel lane, a time ruler, an overview strip,
and an optional beat grid. With the grid on, a second ruler row below the time
row numbers the bars and shades the bar the playhead is in. **Click a bar
number to jump to the start of that bar** - that click always goes to the bar
start regardless of the snap setting, because the number under the cursor is
the request. Zoom runs from the whole file down to individual
samples with the sample dots drawn. Drawing uses a peak pyramid built once on
load, so scrubbing a long file stays responsive.

**Loops.** Add, delete, select, drag either edge, or <kbd>Shift</kbd>-drag the
whole region. A plain drag always moves the playhead, including inside a loop -
a loop body that swallowed clicks made the playhead unreachable exactly where
you most want to place it.
Edit start and end numerically. Each loop carries a `smpl` loop type: forward,
alternating (ping-pong) or backward. Playback honours all three.

**Variable tempo.** The grid carries a tempo *map*, not one BPM: a list of
changes each keyed to the bar it takes effect at. A song that runs 115 BPM for
five bars and 128 from bar 6 is two entries, added with "+ tempo change".
Grid lines, bar numbering, snapping and the metronome all follow it.

Bar/beat position is derived from the absolute sample position by a
piecewise-linear lookup against segment anchors - `anchor.beat + (pos -
anchor.sample) / samplesPerBeat` - never by integrating the current tempo
forward. Integrating drifts; a lookup cannot. The anchor table is rebuilt only
when the map is edited, over a handful of segments rather than per sample.

**Beat grid.** Adjustable BPM, subdivisions, beats per bar, and an offset in
samples with 1 ms and 10 ms nudge buttons plus "at playhead". Tap tempo. A
metronome that is generated inside the playback loop from the same sample
clock, so it cannot drift from the audio or be left behind by a loop jump. It
ticks on *beats*: the subdivisions setting is grid density only, and the player
has no subdivision input at all, so it cannot reach the click.

**Snapping.** Snap to the beat grid, force loop points to a multiple of N
samples, or both. The playhead snaps to the grid too, on click and while
scrubbing - but only to the grid, never to the sample-alignment quantum:
alignment exists so a loop *length* is a whole number of ADPCM blocks, and a
listening position has no such constraint. The default is 28, the PS1 SPU's ADPCM block size. Hold
<kbd>Alt</kbd> while dragging to bypass.

**Export.** Writes the loops back as a `smpl` chunk. For a WAV source every
other chunk is copied through byte for byte, so `cue`, `LIST`, `fact` and
anything else the file carried survives, and the audio data is unchanged. For a
non-WAV source it writes a new 16-bit PCM WAV.

## GarageBand projects

Drop a `.band` bundle on the window and the beat grid configures itself from
the project. Tempo, time signature, key and sample rate come out of
`Alternatives/000/MetaData.plist`, a plain binary plist - no reverse
engineering of Logic's chunk format involved. You can also drop the
`MetaData.plist` on its own.

Measured against GarageBand 10.4.14 by changing one value in the app and
diffing saves. `BeatsPerMinute` is stored as a **float32** (bplist marker
`0x22`), so a fractional tempo survives but only to single precision - 121.3
reads back as 121.30000305, which the UI rounds.

What is *not* in the bundle: the cycle / loop region. `ProjectData` was
searched for an adjacent (start,end) and (start,length) pair across beats,
ppq 240/480/768/960/1920/3840/15360, 0- and 1-based bars, seconds and samples,
as u16/u32/f32/f64, both endiannesses, within a 64-byte window, requiring the
candidate to be rare in two projects differing only in cycle position. Zero
survivors. That rules out adjacent-pair storage in those units; it is a
bounded negative, not a proof of absence. Place loop points yourself.

## Two conventions worth knowing

**`dwEnd` is inclusive.** The RIFF spec says the end sample "will also be
played", so a loop from 0 to 27 is 28 samples long. Everything in the UI shows
the inclusive end, and the *boundary* (end + 1) beside it, because the boundary
is what the arithmetic actually uses.

**Snapping applies to the boundary, not the inclusive end.** If both the start
and the boundary are multiples of 28, the loop *length* is a multiple of 28,
which is the thing the SPU cares about. Aligning the inclusive end instead
would leave every loop one sample short of a whole ADPCM block. The length
readout shows the block count, and flags it when a hand-typed value breaks the
alignment - typed values are taken literally, as the escape hatch.

## Two things about psxavenc

Both measured 2026-08-28 against psxavenc built from Codeberg at `4658cb96`,
by encoding files this tool exported and reading back which ADPCM block came
out carrying the loop-start flag.

**1. It only uses `dwStart`.** `decoding.c` reads `dwEnd` off the stream and
discards it (`avio_rl32(pb); // End offset`), and the loop end is
unconditionally the end of the encoded data. Loop *type* is read but ping-pong
and backward are warned about and treated as forward. So for a psxavenc target,
only the loop start survives; the end and the type are documentation. They are
still written to the file for everything else that reads `smpl`.

**2. The loop start is rounded to whole milliseconds on the way through**, and
that can move it. `decoding.c` does `round(pts * 1000.0)` and `filefmt.c` then
does an integer divide back to a block index, so a sample-exact loop start can
come out one 28-sample block early. Measured at 44100 Hz: all six tested
multiples of 1764 landed on the intended block; four of five non-multiples came
back one block early (8400 -> 8372, 2800 -> 2772, 9800 -> 9772, 280 -> 252).
One non-multiple, 28, happened to land right, so being a multiple is
*sufficient* and not *necessary* - it is the safe choice, not the only working
one.

1764 is the smallest count that is both a whole number of ADPCM blocks and a
whole number of milliseconds at 44100 Hz (40 ms). The alignment preset list
computes the equivalent value for whatever rate the loaded file uses.

**And a bug worth knowing about.** psxavenc's chunk walk uses
`avio_skip(pb, chunk_size)` without the RIFF pad byte that follows an
odd-sized chunk, so any odd-sized chunk ahead of `smpl` desynchronises the
reader and the loop point is silently not found - no warning, no error, the
encode just comes out unlooped. Isolated with a one-variable control: a 19-byte
chunk before `smpl` hides it, the same chunk padded to 20 bytes does not, and
removing it entirely does not.

This tool writes the `smpl` chunk immediately after `fmt `, which is a fixed
even size, so the reader reaches `smpl` before it can meet anything odd. That
is spec-conforming output, not a hack - RIFF does not fix chunk order beyond
`fmt ` preceding `data`. It sidesteps the bug rather than fixing it; the fix
belongs upstream.

## Keys

| | |
|---|---|
| <kbd>Space</kbd> | play / stop |
| <kbd>L</kbd> | toggle loop playback |
| <kbd>S</kbd> / <kbd>E</kbd> | set the selected loop's start / end to the playhead |
| <kbd>A</kbd> | add a loop |
| <kbd>Del</kbd> | delete the selected loop |
| <kbd>T</kbd> | tap tempo |
| <kbd>M</kbd> | metronome |
| <kbd>+</kbd> <kbd>-</kbd> <kbd>0</kbd> | zoom in / out / fit |
| <kbd>&larr;</kbd> <kbd>&rarr;</kbd> | scroll, <kbd>Shift</kbd> for a page |
| wheel | zoom at the cursor; <kbd>Shift</kbd>+wheel scrolls |
| drag | move the playhead, anywhere |
| drag edge | move a loop point |
| <kbd>Shift</kbd>+drag inside | move the whole loop |
| middle drag | pan |

## Playback

Playback is a `ScriptProcessorNode` running a hand-written mixing loop
(`src/core/player-core.ts`) rather than an `AudioBufferSourceNode`. Two reasons:
`loopStart`/`loopEnd` on a buffer source are doubles in *seconds*, so a
sample-exact loop point depends on the browser's seconds-to-frames rounding
agreeing with yours; and a buffer source can only loop forward, while two of
the three `smpl` loop types are not forward.

`ScriptProcessorNode` is deprecated, but the callback is a per-sample copy with
one interpolation and a bounds check, which is nowhere near enough work to miss
a deadline. The redraw path it shares the main thread with reads the peak
pyramid rather than raw samples.

If the output device runs at a different rate from the file, playback is
linearly interpolated and the status line says so. The loop points themselves
are always exact - the resampling is in what you hear, not in what gets written.

## Layout

`src/core` is everything that runs without a DOM, which is also everything the
unit tests can reach directly. `src/ui` is the parts that own pixels.

    index.html               markup
    src/style.css
    src/main.ts              UI glue
    src/core/wav.ts          RIFF/WAVE reader and writer, smpl chunk
    src/core/player-core.ts  the sample loop: looping, resampling, metronome
    src/core/grid.ts         beat grid, tap tempo, snapping and alignment
    src/core/peaks.ts        the peak pyramid
    src/core/time.ts         timecode formatting
    src/core/bplist.ts       Apple binary plist reader
    src/core/band.ts         GarageBand .band project metadata
    src/ui/audio.ts          AudioContext and ScriptProcessorNode host
    src/ui/waveform.ts       canvas drawing and mouse interaction
    test/                    see below

## Tests

    npm test

That is `tsc --noEmit`, then vitest over both suites. Typechecking runs first
on purpose: vitest transpiles without typechecking, so a type error alone will
not fail a test run.

The unit tests cover the RIFF reader and writer, the beat grid, the peak
pyramid, the plist reader and the playback loop. The player tests use a *ramp*
source where sample N holds the value N, so the rendered output is a literal
transcript of which sample indices were read - a loop bug shows up as the wrong
integers rather than as "sounds wrong".

Four of the GarageBand tests need real `.band` fixtures and skip without them.
They skip loudly; they do not quietly pass.

`test/e2e.spec.ts` drives the real page in headless Chromium, loaded from
`file://dist/index.html` - the same way a user opens it, which is the thing
worth testing. It rebuilds first if `dist` is older than `src`, because a test
that silently grades a previous build is measuring the wrong binary. It loads a
fixture through the actual file input, checks the canvas painted more than one
colour, plays, drags a loop handle, exports, and hands the exported file to
`test/fixture.py` - a deliberately independent Python implementation of the same
format - to confirm the bytes are right. A round trip where my parser checks my
writer proves only that the two agree with each other.

It launches **two** browsers. Playback needs
`--autoplay-policy=no-user-gesture-required` or nothing ever sounds; but that
flag is a blindfold, because the decode test exists for a bug whose entire
precondition is a *suspended* AudioContext. So the decode case gets its own
browser without the flag, and forces the suspended state rather than hoping for
it - headless Chromium was observed starting the context anyway.
