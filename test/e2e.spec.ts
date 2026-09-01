/**
 * End-to-end test against the BUILT single-file artifact.
 *
 * Port of test/e2e.mjs + test/e2e-decode.mjs + test/run-e2e.sh. Every check
 * name in those files survives verbatim as an `it(...)` title.
 *
 * What changed, and it is the point of the exercise: the old harness started
 * `python3 -m http.server` and pointed the browser at http://127.0.0.1:PORT/,
 * because the multi-file app was CORS-blocked on file://. The built artifact
 * inlines the module graph, so there is nothing left to block. This suite
 * loads dist/index.html straight off the filesystem. Running from file:// with
 * no server IS the property under test - do not reintroduce the server.
 *
 * TWO BROWSER ARMS, deliberately:
 *   - the playback arm launches with --autoplay-policy=no-user-gesture-required,
 *     because otherwise the AudioContext stays suspended and nothing plays;
 *   - the decode arm launches WITHOUT it, because the bug it exists to catch
 *     only exists while the context is blocked. That flag is a blindfold: with
 *     it on, the decode test is structurally incapable of failing.
 *
 * fixture.py is still called, twice, and is still an independent Python
 * implementation of the format: it writes the input and it grades the export.
 * A round trip where my parser checks my writer proves nothing.
 *
 * NOT carried over from run-e2e.sh: the `node --test test/test.mjs` stage. That
 * is the unit suite, which vitest picks up on its own.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist/index.html');
const FIXTURE_PY = resolve(__dirname, 'fixture.py');
const CHROME = '/usr/bin/chromium';

/** The app's own test handle. Unchanged names in the TS port. */
interface LoopRec {
  start: number;
  end: number;
  type: number;
}
interface LoopEditor {
  state: { loops: LoopRec[]; selected: number; frames: number; sampleRate: number };
  view: {
    playhead: number;
    _drag: { kind: string } | null | undefined;
    rulerHeight: number;
    barRulerHeight: number;
    sampleToX(sample: number): number;
  };
  engine: {
    ctx: AudioContext | null;
    init(): Promise<unknown>;
    positionSamples(): number;
  };
  grid: {
    nearestLine(pos: number): number;
    samplesPerBeatAt(pos: number): number;
    samplesPerBarAt(pos: number): number;
  };
  makeDecoder(): BaseAudioContext;
  decodeWithTimeout(dec: BaseAudioContext, bytes: ArrayBuffer, ms: number): Promise<AudioBuffer>;
}
/** Declared once; every evaluate site reaches the app through this. */
type WinApp = Window & typeof globalThis & { __loopeditor: LoopEditor };

const WORK = mkdtempSync(join(tmpdir(), 'loopedit-e2e-'));
const FIXTURE_WAV = join(WORK, 'fixture.wav');
const FIXTURE_MP3 = join(WORK, 'fixture.mp3');
const OUT_WAV = join(WORK, 'exported.wav');
const EXPECTED_JSON = join(WORK, 'expected.json');

/** run-e2e.sh skipped the decode stage outright when ffmpeg was missing. */
const HAS_FFMPEG = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function walkMtimes(dir: string): number[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = resolve(dir, e.name);
      return e.isDirectory() ? walkMtimes(full) : [statSync(full).mtimeMs];
    });
  } catch {
    return [];
  }
}

let browser: Browser;
let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];
const pageErrors: string[] = [];

beforeAll(async () => {
  // Build if dist is missing or older than any input. A test that silently
  // grades a previous build is measuring the wrong binary.
  const newest = Math.max(
    ...['src', 'index.html', 'vite.config.ts'].flatMap((p) => {
      const full = resolve(ROOT, p);
      return existsSync(full) ? [statSync(full).mtimeMs, ...walkMtimes(full)] : [0];
    }),
  );
  if (!existsSync(DIST) || statSync(DIST).mtimeMs < newest) {
    try {
      execSync('npm run build', { cwd: ROOT, stdio: 'pipe' });
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(
        'npm run build failed, so there is no artifact to grade:\n' +
          String(err.stdout ?? '') +
          String(err.stderr ?? ''),
      );
    }
  }

  // The fixture the whole chain runs on, written by the independent Python
  // implementation rather than by the code under test.
  execFileSync('python3', [FIXTURE_PY, 'make', FIXTURE_WAV], { stdio: 'pipe' });

  browser = await chromium.launch({
    headless: true,
    executablePath: CHROME,
    args: [
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required', // no user gesture in headless
      '--mute-audio',
    ],
  });
  context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 800 } });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`file://${DIST}`);
  await page.waitForSelector('#wave');
});

afterAll(async () => {
  await browser?.close();
});

/** Ask the app where a loop handle actually is instead of guessing a fraction
 * of the width. The first version of this test guessed 13%, landed inside the
 * loop body, dragged the WHOLE loop, and still passed. */
function handleX(edge: 'start' | 'end'): Promise<number> {
  return page.evaluate((which: 'start' | 'end') => {
    const app = (window as unknown as WinApp).__loopeditor;
    const L = app.state.loops[app.state.selected];
    return app.view.sampleToX(which === 'start' ? L.start : L.end + 1);
  }, edge);
}

const numValue = async (sel: string): Promise<number> => parseInt(await page.inputValue(sel), 10);
const text = async (sel: string): Promise<string> => (await page.textContent(sel)) ?? '';

describe('[1] page loads and the module graph evaluates', () => {
  it('status line rendered', async () => {
    expect(await text('#status')).toContain('Ready');
  });

  it('no console errors on load', () => {
    // A page that throws in a module script otherwise looks exactly like a
    // page with nothing to draw yet.
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

describe('[2] load the fixture through the real file input', () => {
  let info = '';
  let loopRow = '';

  beforeAll(async () => {
    await page.setInputFiles('#file', FIXTURE_WAV);
    await page.waitForFunction(
      () => document.getElementById('filename')?.textContent?.endsWith('.wav') ?? false,
      undefined,
      { timeout: 10_000 },
    );
    info = await text('#fileinfo');
    loopRow = await text('#looplist li');
  });

  it('sample rate reported', () => expect(info).toContain('44100 Hz'));
  it('channel count reported', () => expect(info).toContain('stereo'));
  it('frame count reported', () => expect(info).toContain('132,300'));
  it('unknown "note" chunk seen', () => expect(info).toContain('note'));
  it('existing smpl loop detected', () => expect(info).toContain('1 loop in smpl'));
  it('loop start read from smpl', () => expect(loopRow).toContain('8,400'));
  it('loop end read from smpl', () => expect(loopRow).toContain('25,199'));
  it('loop length shown', () => expect(loopRow).toContain('16,800'));
});

describe('[3] the waveform actually rendered pixels', () => {
  let painted: { colours: number; w: number; h: number };

  beforeAll(async () => {
    painted = await page.evaluate(() => {
      const c = document.getElementById('wave') as HTMLCanvasElement;
      const g = c.getContext('2d')!;
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set<string>();
      for (let i = 0; i < d.length; i += 4) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
      return { colours: seen.size, w: c.width, h: c.height };
    });
    await page.screenshot({ path: join(WORK, 'shot-loaded.png') });
  });

  // A blank canvas is one colour. The waveform, ruler, loop band and playhead
  // are four different ones at minimum.
  it('canvas is not a flat fill', () => expect(painted.colours).toBeGreaterThan(4));
  it('canvas has a backing size', () => {
    expect(painted.w).toBeGreaterThan(100);
    expect(painted.h).toBeGreaterThan(100);
  });
});

describe('[4] alignment readouts', () => {
  let startInfo = '';
  let lengthInfo = '';
  let startInfo2 = '';

  beforeAll(async () => {
    startInfo = await text('#startinfo');
    lengthInfo = await text('#lengthinfo');
    // Break the alignment on purpose and confirm the readout notices. Without
    // this the "aligned" check could just be a label that is always there.
    await page.fill('#loopstart', '8401');
    await page.dispatchEvent('#loopstart', 'change');
    startInfo2 = await text('#startinfo');
    await page.fill('#loopstart', '8400');
    await page.dispatchEvent('#loopstart', 'change');
  });

  it('block-aligned start reported as aligned', () => expect(startInfo).toContain('aligned'));
  it('length reported in whole blocks', () => expect(lengthInfo).toContain('600 × 28'));
  it('misaligned start is flagged', () => expect(startInfo2).toMatch(/off 28/));
});

describe('[5] playback advances the playhead', () => {
  let moved: [string, string];
  let playLabel = '';

  beforeAll(async () => {
    await page.check('#loopon');
    await page.click('#play');
    await page.waitForTimeout(700);
    moved = await page.evaluate(() => {
      const a = document.getElementById('cursorinfo')!.textContent ?? '';
      return new Promise<[string, string]>((r) =>
        setTimeout(() => r([a, document.getElementById('cursorinfo')!.textContent ?? '']), 400),
      );
    });
    playLabel = await text('#play');
    await page.click('#play');
  });

  it('playhead moves while playing', () => expect(moved[0]).not.toBe(moved[1]));
  it('play button flipped to Stop', () => expect(playLabel).toBe('Stop'));
});

describe('[6] drag a loop edge on the canvas', () => {
  let startBefore = 0;
  let endBefore = 0;
  let startAfter = 0;
  let endAfter = 0;
  let s0 = 0;
  let e0 = 0;
  let s1 = 0;
  let e1 = 0;
  let s2 = 0;
  let sPlain = 0;
  let headBefore = 0;
  let headAfter = 0;
  let restoredStart = '';
  let restoredEnd = '';

  beforeAll(async () => {
    await page.click('#zoomloop');
    await page.waitForTimeout(120);
    const box = (await page.locator('#wave').boundingBox())!;
    const midY = box.y + box.height / 2;

    startBefore = await numValue('#loopstart');
    endBefore = await numValue('#loopend');
    const hx = await handleX('start');
    await page.mouse.move(box.x + hx, midY);
    await page.mouse.down();
    await page.mouse.move(box.x + hx + 60, midY, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(80);
    startAfter = await numValue('#loopstart');
    endAfter = await numValue('#loopend');

    // The body drag requires shift: a plain drag inside a loop moves the
    // playhead instead, which is checked separately below.
    const bodyX = ((await handleX('start')) + (await handleX('end'))) / 2;
    s0 = await numValue('#loopstart');
    e0 = await numValue('#loopend');
    await page.keyboard.down('Shift');
    await page.mouse.move(box.x + bodyX, midY);
    await page.mouse.down();
    await page.mouse.move(box.x + bodyX + 40, midY, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForTimeout(80);
    s1 = await numValue('#loopstart');
    e1 = await numValue('#loopend');

    // And the bug spicyjpeg reported: a plain drag inside a loop body must
    // move the playhead, not the loop. Without this the fix has no oracle.
    s2 = await numValue('#loopstart');
    headBefore = await page.evaluate(() => (window as unknown as WinApp).__loopeditor.view.playhead);
    const insideX = ((await handleX('start')) + (await handleX('end'))) / 2;
    await page.mouse.move(box.x + insideX, midY);
    await page.mouse.down();
    await page.mouse.move(box.x + insideX + 30, midY, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(80);
    headAfter = await page.evaluate(() => (window as unknown as WinApp).__loopeditor.view.playhead);
    sPlain = await numValue('#loopstart');

    // Restore the fixture's own loop exactly, so the export check compares
    // against known numbers rather than whatever the drags left behind.
    await page.fill('#loopstart', '8400');
    await page.dispatchEvent('#loopstart', 'change');
    await page.fill('#loopend', '25199');
    await page.dispatchEvent('#loopend', 'change');
    restoredStart = await page.inputValue('#loopstart');
    restoredEnd = await page.inputValue('#loopend');
  });

  it('dragging the start handle moved the start', () => expect(startAfter).not.toBe(startBefore));
  it('dragging the start handle left the end alone', () => expect(endAfter).toBe(endBefore));
  it('dragged start landed on a 28-sample boundary', () => expect(startAfter % 28).toBe(0));
  it('body drag moved the loop', () => expect(s1).not.toBe(s0));
  it('body drag preserved the loop length', () => expect(e1 - s1).toBe(e0 - s0));
  it('plain drag inside a loop moves the playhead', () => expect(headAfter).not.toBe(headBefore));
  it('plain drag inside a loop leaves the loop alone', () => expect(sPlain).toBe(s2));
  it('loop restored for export', () => {
    expect(restoredStart).toBe('8400');
    expect(restoredEnd).toBe('25199');
  });
});

describe('[6b] the playhead snaps to the beat grid', () => {
  let on: { pos: number; nearest: number; spb: number };
  let off: { pos: number; nearest: number; spb: number };

  beforeAll(async () => {
    await page.click('#fit');
    await page.fill('#bpm', '120');
    await page.dispatchEvent('#bpm', 'input');
    await page.check('#gridon');
    await page.check('#snapgrid');
    await page.waitForTimeout(120);
    const wbox = (await page.locator('#wave').boundingBox())!;

    const clickAndRead = async (x: number) => {
      await page.mouse.click(wbox.x + x, wbox.y + wbox.height * 0.6);
      await page.waitForTimeout(80);
      return page.evaluate(() => {
        const a = (window as unknown as WinApp).__loopeditor;
        const p = a.engine.positionSamples();
        return { pos: p, nearest: a.grid.nearestLine(p), spb: a.grid.samplesPerBeatAt(p) };
      });
    };

    // Deliberately click BETWEEN grid lines. 120 BPM at 44100 is 22050 samples
    // per beat, and the fixture is 132300 frames = exactly 6 beats, so a click
    // near the middle of a beat cannot land on a line by luck.
    const midBeat = wbox.width * (1.5 / 6);
    on = await clickAndRead(midBeat);
    // Negative arm: with snapping off the same click must NOT be forced onto a
    // line, or the check above is satisfied by a playhead that always snaps.
    await page.uncheck('#snapgrid');
    off = await clickAndRead(midBeat);
    await page.check('#snapgrid');
    await page.uncheck('#gridon');
    await page.waitForTimeout(80);
  });

  it('snap on: playhead lands exactly on a grid line', () => expect(on.pos).toBe(on.nearest));
  it('snap on: landed on a beat multiple', () => expect(on.pos % on.spb).toBe(0));
  it('snap off: playhead is free of the grid', () => expect(off.pos).not.toBe(off.nearest));
});

describe('[6c] the bar ruler', () => {
  let geom: { spBar: number; rulerH: number; barH: number };
  let bar2 = -1;
  let bar1 = -1;
  let grabbed: { kind: string } | null | undefined;
  let offHeight = -1;

  beforeAll(async () => {
    await page.click('#fit');
    await page.check('#gridon');
    await page.waitForTimeout(120);
    const rb = (await page.locator('#wave').boundingBox())!;
    geom = await page.evaluate(() => {
      const a = (window as unknown as WinApp).__loopeditor;
      return { spBar: a.grid.samplesPerBarAt(0), rulerH: a.view.rulerHeight, barH: a.view.barRulerHeight };
    });

    const clickBarStrip = async (fracX: number) => {
      await page.mouse.click(rb.x + rb.width * fracX, rb.y + 30); // inside the bar strip
      await page.waitForTimeout(80);
      return page.evaluate(() => (window as unknown as WinApp).__loopeditor.engine.positionSamples());
    };
    // 120 BPM / 4/4 at 44100 = 88200 samples per bar; the fixture is 132300
    // frames, so bar 2 starts 2/3 of the way across a fitted view.
    bar2 = await clickBarStrip(0.72);
    bar1 = await clickBarStrip(0.4);
    grabbed = await page.evaluate(() => (window as unknown as WinApp).__loopeditor.view._drag);

    await page.screenshot({ path: join(WORK, 'shot-barruler.png') });
    await page.uncheck('#gridon');
    await page.waitForTimeout(80);
    offHeight = await page.evaluate(() => (window as unknown as WinApp).__loopeditor.view.barRulerHeight);
  });

  it('bar ruler appears when the grid is on', () => expect(geom.barH).toBeGreaterThan(0));
  it('samples per bar as expected', () => expect(geom.spBar).toBe(88200));
  it('clicking bar 2 lands exactly on the bar start', () => expect(bar2).toBe(88200));
  it('clicking inside bar 1 lands on bar 1 start', () => expect(bar1).toBe(0));
  // The strip must not be a dead zone that grabs loop handles instead.
  it('bar-strip click did not start a handle drag', () =>
    expect(!grabbed || grabbed.kind === 'seek').toBe(true));
  it('bar ruler disappears with the grid off', () => expect(offHeight).toBe(0));
});

describe('[7] add a second loop and export', () => {
  let rows = -1;
  let suggested = '';
  let claimed: LoopRec[] = [];

  beforeAll(async () => {
    await page.click('#addloop');
    await page.waitForTimeout(60);
    rows = await page.locator('#looplist li').count();
    await page.selectOption('#looptype', '1'); // ping-pong on the new one

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#export'),
    ]);
    await download.saveAs(OUT_WAV);
    suggested = download.suggestedFilename();

    /* Write down what the UI says it exported, so the Python verifier can
     * check the file against the app's own claim rather than against a
     * hardcoded guess that would drift the moment this test changes. */
    claimed = await page.evaluate(() =>
      (window as unknown as WinApp).__loopeditor.state.loops.map((L) => ({
        start: L.start,
        end: L.end,
        type: L.type,
      })),
    );
    writeFileSync(
      EXPECTED_JSON,
      JSON.stringify(
        { loops: claimed, sampleRate: 44100, frames: 132300, chunks: ['fmt ', 'smpl', 'note', 'data'] },
        null,
        2,
      ),
    );
    await page.screenshot({ path: join(WORK, 'shot-final.png') });
  });

  it('second loop added', () => expect(rows).toBe(2));
  it('export produced a file', () => {
    expect(existsSync(OUT_WAV)).toBe(true);
    expect(statSync(OUT_WAV).size).toBeGreaterThan(1000);
  });
  it('export is named after the source', () => expect(suggested).toBe('fixture-loop.wav'));

  // run-e2e.sh stage: "independent verification of the exported file". The
  // exported bytes are graded by fixture.py, which shares no lines with the
  // code that wrote them.
  it('independent verification of the exported file', () => {
    expect(existsSync(OUT_WAV), 'no exported.wav to verify').toBe(true);
    const r = spawnSync('python3', [FIXTURE_PY, 'verify', OUT_WAV, EXPECTED_JSON, FIXTURE_WAV], {
      encoding: 'utf8',
    });
    expect(r.status, `${r.stdout ?? ''}${r.stderr ?? ''}`).toBe(0);
    expect(r.stdout).toContain('VERIFY OK');
  });
});

describe('[8] console stayed clean throughout', () => {
  it('no console or page errors', () => {
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

/*
 * The first-non-WAV-hangs bug, in isolation, in its own browser.
 *
 * Launched WITHOUT --autoplay-policy=no-user-gesture-required on purpose: the
 * playback arm above passes that flag, which starts the AudioContext
 * immediately and hides this entirely. The bug only exists while the context
 * is blocked, so a test that unblocks it can never fail.
 */
describe.skipIf(!HAS_FFMPEG)('[decode] first non-WAV load with the audio context blocked', () => {
  let dBrowser: Browser;
  let dPage: Page;
  const errs: string[] = [];

  let blocked = '';
  let loaded = false;
  let notLoadedStatus = '';
  let st: { ctx: string; frames: number; rate: number } | null = null;
  let busyHidden = false;
  let mech: {
    separate: boolean;
    kind: string;
    ctxDuring: string;
    ok: boolean;
    err: string | null;
    ms: number;
  };

  beforeAll(async () => {
    execFileSync(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', FIXTURE_WAV, '-c:a', 'libmp3lame', '-b:a', '128k', FIXTURE_MP3],
      { stdio: 'pipe' },
    );

    dBrowser = await chromium.launch({
      headless: true,
      executablePath: CHROME,
      args: ['--no-sandbox', '--mute-audio'], // autoplay policy left at default
    });
    dPage = await (await dBrowser.newContext()).newPage();
    dPage.on('pageerror', (e) => errs.push(e.message));
    await dPage.goto(`file://${DIST}`);
    await dPage.waitForSelector('#wave');

    /* Force the failure condition rather than hoping the browser supplies it.
     * The first version of this test relied on the autoplay policy to leave
     * the context suspended; headless Chromium started it anyway, so the mp3
     * loaded, the test passed, and it had tested nothing. Suspending
     * explicitly makes the precondition a fact instead of an assumption. */
    blocked = await dPage.evaluate(async () => {
      const a = (window as unknown as WinApp).__loopeditor;
      await a.engine.init();
      await a.engine.ctx!.suspend();
      return a.engine.ctx!.state as string;
    });
    if (blocked !== 'suspended') {
      // Same bail-out as the old harness: nothing below this point means
      // anything if the context is running.
      throw new Error(
        `state was ${blocked}; the precondition does not hold so nothing below means anything`,
      );
    }

    await dPage.setInputFiles('#file', FIXTURE_MP3);
    // The bug's signature is a load that never finishes. Ten seconds is far
    // more than a 3-second mp3 needs and far less than the old failure, which
    // waited indefinitely for an unrelated gesture.
    try {
      await dPage.waitForFunction(
        () => document.getElementById('filename')?.textContent?.endsWith('.mp3') ?? false,
        undefined,
        { timeout: 10_000 },
      );
      loaded = true;
    } catch {
      loaded = false;
      notLoadedStatus = (await dPage.textContent('#status')) ?? '';
    }

    if (loaded) {
      st = await dPage.evaluate(() => {
        const a = (window as unknown as WinApp).__loopeditor;
        return {
          ctx: a.engine.ctx ? a.engine.ctx.state : 'none',
          frames: a.state.frames,
          rate: a.state.sampleRate,
        };
      });
      busyHidden = await dPage.isHidden('#busy');
    }

    /* The mechanism check. The old harness fetched a served copy of the mp3;
     * on file:// a page-side fetch of a file:// URL is blocked by Chromium, so
     * the same bytes are handed in as base64 instead. Same bytes, same decode,
     * no server. */
    const b64 = readFileSync(FIXTURE_MP3).toString('base64');
    mech = await dPage.evaluate(async (data: string) => {
      const a = (window as unknown as WinApp).__loopeditor;
      await a.engine.ctx!.suspend();
      const dec = a.makeDecoder();
      const bin = atob(data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const t0 = performance.now();
      let ok = false;
      let err: string | null = null;
      try {
        const b = await a.decodeWithTimeout(dec, bytes.buffer as ArrayBuffer, 8000);
        ok = b.length > 1000;
      } catch (e) {
        err = String(e && (e as Error).message);
      }
      return {
        separate: (dec as unknown) !== (a.engine.ctx as unknown),
        kind: dec.constructor.name,
        ctxDuring: a.engine.ctx!.state as string,
        ok,
        err,
        ms: Math.round(performance.now() - t0),
      };
    }, b64);
  });

  afterAll(async () => {
    await dBrowser?.close();
  });

  it('the audio context is suspended BEFORE the load', () => {
    expect(blocked).toBe('suspended');
  });

  it('the FIRST non-WAV file loads on its own', () => {
    expect(loaded, `still not loaded after 10s - status: ${notLoadedStatus}`).toBe(true);
  });

  // The input handler deliberately resumes the context (a file pick IS a
  // gesture), so the context state after a load says nothing. The property
  // that matters is tested directly by the mechanism checks below.
  it('decoded to real samples', () => {
    expect(st, 'the mp3 never loaded').not.toBeNull();
    expect(st!.frames).toBeGreaterThan(100000);
  });

  it('overlay was dismissed afterwards', () => expect(busyHidden).toBe(true));

  it('the decoder is NOT the playback context', () => expect(mech.separate).toBe(true));
  it('it is an OfflineAudioContext', () => expect(mech.kind).toMatch(/Offline/));
  it('decode completed with playback suspended', () =>
    expect(mech.ok, mech.err ?? JSON.stringify(mech)).toBe(true));
  it('...and the playback context stayed suspended throughout', () =>
    expect(mech.ctxDuring).toBe('suspended'));

  it('no page errors', () => expect(errs).toEqual([]));
});
