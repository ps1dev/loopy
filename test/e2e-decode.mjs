/*
 * The first-non-WAV-hangs bug, in isolation.
 *
 * Launched WITHOUT --autoplay-policy=no-user-gesture-required on purpose: the
 * main e2e run passes that flag, which starts the AudioContext immediately and
 * hides this entirely. The bug only exists while the context is blocked, so a
 * test that unblocks it can never fail.
 *
 *   node test/e2e-decode.mjs <baseUrl> <playwrightDir> <chromiumPath> <mp3>
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const [baseUrl, pwDir, chromiumPath, mp3] = process.argv.slice(2);
const require = createRequire(path.join(pwDir, 'noop.js'));
const { chromium } = require('playwright');

let fail = 0;
const check = (n, c, d) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  (' + d + ')')); if (!c) fail++; };

const browser = await chromium.launch({
  headless: true, executablePath: chromiumPath,
  args: ['--no-sandbox', '--mute-audio']       // autoplay policy left at default
});
const page = await (await browser.newContext()).newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(baseUrl, { waitUntil: 'networkidle' });

console.log('\n[decode] first non-WAV load with the audio context blocked');

/* Force the failure condition rather than hoping the browser supplies it.
 * The first version of this test relied on the autoplay policy to leave the
 * context suspended; headless Chromium started it anyway, so the mp3 loaded,
 * the test passed, and it had tested nothing. Suspending explicitly makes the
 * precondition a fact instead of an assumption. */
const blocked = await page.evaluate(async () => {
  const a = window.__loopeditor;
  await a.engine.init();
  await a.engine.ctx.suspend();
  return a.engine.ctx.state;
});
check('the audio context is suspended BEFORE the load', blocked === 'suspended',
  'state was ' + blocked + '; the precondition does not hold so nothing below means anything');
if (blocked !== 'suspended') { await browser.close(); process.exit(1); }

await page.setInputFiles('#file', mp3);

// The bug's signature is a load that never finishes. Ten seconds is far more
// than a 3-second mp3 needs and far less than the old failure, which waited
// indefinitely for an unrelated gesture.
let loaded = true;
try {
  await page.waitForFunction(
    () => document.getElementById('filename').textContent.endsWith('.mp3'),
    null, { timeout: 10000 });
} catch { loaded = false; }
check('the FIRST non-WAV file loads on its own', loaded,
  'still not loaded after 10s - status: ' + (await page.textContent('#status')));

if (loaded) {
  const st = await page.evaluate(() => {
    const a = window.__loopeditor;
    return { ctx: a.engine.ctx ? a.engine.ctx.state : 'none', frames: a.state.frames, rate: a.state.sampleRate };
  });
  // This is the discriminating assertion. If decoding still depended on a
  // running context, "loaded" and "suspended" could not both be true.
  // The input handler deliberately resumes the context (a file pick IS a
  // gesture), so the state after a load says nothing. The property that
  // matters is tested directly below instead.
  check('decoded to real samples', st.frames > 100000, JSON.stringify(st));
  check('overlay was dismissed afterwards', await page.isHidden('#busy'));
}
console.log('\n[decode] the mechanism: decoding does not use the playback context');
const mech = await page.evaluate(async (url) => {
  const a = window.__loopeditor;
  await a.engine.ctx.suspend();
  const dec = a.makeDecoder();
  const bytes = await (await fetch(url)).arrayBuffer();
  const t0 = performance.now();
  let ok = false, err = null;
  try { const b = await a.decodeWithTimeout(dec, bytes, 8000); ok = b.length > 1000; }
  catch (e) { err = String(e && e.message); }
  return {
    separate: dec !== a.engine.ctx,
    kind: dec.constructor.name,
    ctxDuring: a.engine.ctx.state,
    ok, err, ms: Math.round(performance.now() - t0)
  };
}, baseUrl.replace(/\/$/, '') + '/fixture-probe.mp3');

check('the decoder is NOT the playback context', mech.separate, 'kind=' + mech.kind);
check('it is an OfflineAudioContext', /Offline/.test(mech.kind), mech.kind);
check('decode completed with playback suspended', mech.ok, mech.err || JSON.stringify(mech));
check('...and the playback context stayed suspended throughout',
  mech.ctxDuring === 'suspended', mech.ctxDuring);

check('no page errors', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(fail ? '\nDECODE TEST FAILED' : '\nDECODE TEST PASSED');
process.exit(fail ? 1 : 0);
