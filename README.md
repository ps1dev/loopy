# Loop Point Editor

A web-based editor for audio loop points, aimed at getting a loop into a WAV
file's `smpl` chunk so that something downstream (psxavenc, a sampler, a game
engine) can use it.

Plain HTML/CSS/JS, ES modules, no frameworks, no build step, no dependencies.

## Running it

**It has to be served over HTTP. Opening `index.html` directly does not work** -
that gives it a `file://` address and browsers refuse to load ES modules from
there, so the page draws and then ignores every click.

Easiest, on macOS: double-click **`serve.command`** in this folder. It starts a
server on a free port and opens the browser at it.

Otherwise, from the folder holding `index.html`:

    python3 -m http.server 8080
    # then open http://localhost:8080/

If you do open it from `file://` anyway, the page says so and gives you the
command rather than failing silently.

## What it does

**Import.** WAV files are parsed here rather than handed to the browser,
because `decodeAudioData` resamples to the output device's rate (which would
silently move every loop point) and discards every chunk that is not `fmt ` or
`data` (which is the one we care about). Any existing `smpl` loops are loaded
and shown. PCM 8/16/24/32-bit and 32/64-bit float are read, including
`WAVE_FORMAT_EXTENSIBLE`.

Anything that is not a RIFF file goes through `decodeAudioData`, so mp3, ogg,
flac and m4a work to whatever extent the browser supports them.

**Display.** Waveform with a per-channel lane, a time ruler, an overview strip,
and an optional beat grid. Zoom runs from the whole file down to individual
samples with the sample dots drawn. Drawing uses a peak pyramid built once on
load, so scrubbing a long file stays responsive.

**Loops.** Add, delete, select, drag either edge, or <kbd>Shift</kbd>-drag the
whole region. A plain drag always moves the playhead, including inside a loop -
a loop body that swallowed clicks made the playhead unreachable exactly where
you most want to place it.
Edit start and end numerically. Each loop carries a `smpl` loop type: forward,
alternating (ping-pong) or backward. Playback honours all three.

**Beat grid.** Adjustable BPM, subdivisions, beats per bar, and an offset in
samples with 1 ms and 10 ms nudge buttons plus "at playhead". Tap tempo. A
metronome that is generated inside the playback loop from the same sample
clock, so it cannot drift from the audio or be left behind by a loop jump. It
ticks on *beats*: the subdivisions setting is grid density only, and the player
has no subdivision input at all, so it cannot reach the click.

**Snapping.** Snap to the beat grid, force loop points to a multiple of N
samples, or both. The default is 28, the PS1 SPU's ADPCM block size. Hold
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
(`js/player-core.js`) rather than an `AudioBufferSourceNode`. Two reasons:
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

    index.html          markup
    css/style.css
    js/wav.js           RIFF/WAVE reader and writer, smpl chunk
    js/player-core.js   the sample loop: looping, resampling, metronome
    js/audio.js         AudioContext and ScriptProcessorNode host
    js/waveform.js      peak pyramid, canvas drawing, mouse interaction
    js/grid.js          beat grid, tap tempo, snapping and alignment
    js/bplist.js        Apple binary plist reader
    js/band.js          GarageBand .band project metadata
    js/app.js           UI glue
    test/               see below

`package.json` exists only so `node --test` can import the same module files
the browser loads. There are no dependencies to install.

## Tests

    node --test test/test.mjs                    # logic only, no browser needed
    PLAYWRIGHT_DIR=/path/to/a/playwright/install bash test/run-e2e.sh

The unit tests cover the RIFF reader and writer and the playback loop. The
player tests use a *ramp* source where sample N holds the value N, so the
rendered output is a literal transcript of which sample indices were read - a
loop bug shows up as the wrong integers rather than as "sounds wrong".

`test/run-e2e.sh` additionally drives the real page in headless Chromium:
loads a fixture through the actual file input, checks the canvas painted more
than one colour, plays, drags a loop handle, exports, and then hands the
exported file to `test/fixture.py` - a deliberately independent Python
implementation of the same format - to confirm the bytes are right. A round
trip where my parser checks my writer proves only that the two agree with each
other.
