/*
 * End-to-end check in a real browser. Loads the Python-generated fixture
 * through the actual file input, drives the UI, exports, and hands the result
 * back to Python to verify - so no step of the chain is graded by the code
 * that produced it.
 *
 * Needs a running server (see test/run-e2e.sh) and a chromium binary; it takes
 * both as arguments rather than guessing:
 *
 *   node test/e2e.mjs <baseUrl> <playwrightDir> <chromiumPath> <fixture> <outDir>
 *
 * Any page error or console error fails the run. A blank page that throws in a
 * module script otherwise looks exactly like a page with nothing to draw yet.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const [baseUrl, pwDir, chromiumPath, fixture, outDir] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: e2e.mjs <baseUrl> <playwrightDir> <chromiumPath> <fixture> <outDir>');
  process.exit(2);
}

const require = createRequire(path.join(pwDir, 'noop.js'));
const { chromium } = require('playwright');

const failures = [];
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures.push(name); }
}

const browser = await chromium.launch({
  headless: true,
  executablePath: chromiumPath,
  args: [
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',  // no gesture in headless
    '--mute-audio'
  ]
});
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 800 } });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

await page.goto(baseUrl, { waitUntil: 'networkidle' });

console.log('\n[1] page loads and the module graph evaluates');
check('status line rendered', (await page.textContent('#status')).includes('Ready'));
check('no console errors on load', consoleErrors.length === 0, consoleErrors.join(' | '));

console.log('\n[2] load the fixture through the real file input');
await page.setInputFiles('#file', fixture);
await page.waitForFunction(
  () => document.getElementById('filename').textContent.endsWith('.wav'),
  null, { timeout: 10000 });

const info = await page.textContent('#fileinfo');
check('sample rate reported', info.includes('44100 Hz'), info);
check('channel count reported', info.includes('stereo'), info);
check('frame count reported', info.includes('132,300'), info);
check('unknown "note" chunk seen', info.includes('note'), info);
check('existing smpl loop detected', info.includes('1 loop in smpl'), info);

const loopRow = await page.textContent('#looplist li');
check('loop start read from smpl', loopRow.includes('8,400'), loopRow);
check('loop end read from smpl', loopRow.includes('25,199'), loopRow);
check('loop length shown', loopRow.includes('16,800'), loopRow);

console.log('\n[3] the waveform actually rendered pixels');
const painted = await page.evaluate(() => {
  const c = document.getElementById('wave');
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const seen = new Set();
  for (let i = 0; i < d.length; i += 4) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
  return { colours: seen.size, w: c.width, h: c.height };
});
// A blank canvas is one colour. The waveform, ruler, loop band and playhead
// are four different ones at minimum.
check('canvas is not a flat fill', painted.colours > 4, JSON.stringify(painted));
check('canvas has a backing size', painted.w > 100 && painted.h > 100, JSON.stringify(painted));

await page.screenshot({ path: path.join(outDir, 'shot-loaded.png') });

console.log('\n[4] alignment readouts');
const startInfo = await page.textContent('#startinfo');
const lengthInfo = await page.textContent('#lengthinfo');
check('block-aligned start reported as aligned', startInfo.includes('aligned'), startInfo);
check('length reported in whole blocks', lengthInfo.includes('600 × 28'), lengthInfo);

// Now break the alignment on purpose and confirm the readout notices. Without
// this the "aligned" check above could just be a label that is always there.
await page.fill('#loopstart', '8401');
await page.dispatchEvent('#loopstart', 'change');
const startInfo2 = await page.textContent('#startinfo');
check('misaligned start is flagged', /off 28/.test(startInfo2), startInfo2);
await page.fill('#loopstart', '8400');
await page.dispatchEvent('#loopstart', 'change');

console.log('\n[5] playback advances the playhead');
await page.check('#loopon');
await page.click('#play');
await page.waitForTimeout(700);
const moved = await page.evaluate(() => {
  const a = document.getElementById('cursorinfo').textContent;
  return new Promise(r => setTimeout(() => r([a, document.getElementById('cursorinfo').textContent]), 400));
});
check('playhead moves while playing', moved[0] !== moved[1], JSON.stringify(moved));
check('play button flipped to Stop', (await page.textContent('#play')) === 'Stop');
await page.click('#play');

console.log('\n[6] drag a loop edge on the canvas');
await page.click('#zoomloop');
await page.waitForTimeout(120);
const box = await page.locator('#wave').boundingBox();

/* Ask the app where the handle actually is instead of guessing a fraction of
 * the width. The first version of this test guessed 13%, landed inside the
 * loop body, dragged the WHOLE loop, and still passed - which is why the
 * end-did-not-move assertion below exists. */
async function handleX(edge) {
  return await page.evaluate((e) => {
    const app = window.__loopeditor;
    const L = app.state.loops[app.state.selected];
    return app.view.sampleToX(e === 'start' ? L.start : L.end + 1);
  }, edge);
}

const startBefore = parseInt(await page.inputValue('#loopstart'), 10);
const endBefore = parseInt(await page.inputValue('#loopend'), 10);
const hx = await handleX('start');
const midY = box.y + box.height / 2;
await page.mouse.move(box.x + hx, midY);
await page.mouse.down();
await page.mouse.move(box.x + hx + 60, midY, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(80);
let startAfter = parseInt(await page.inputValue('#loopstart'), 10);
let endAfter = parseInt(await page.inputValue('#loopend'), 10);
check('dragging the start handle moved the start', startAfter !== startBefore,
  startBefore + ' -> ' + startAfter);
check('dragging the start handle left the end alone', endAfter === endBefore,
  'end ' + endBefore + ' -> ' + endAfter);
check('dragged start landed on a 28-sample boundary', startAfter % 28 === 0, String(startAfter));

// Now the body drag. It requires shift: a plain drag inside a loop moves the
// playhead instead, which is checked separately below.
const bodyX = (await handleX('start') + await handleX('end')) / 2;
const s0 = parseInt(await page.inputValue('#loopstart'), 10);
const e0 = parseInt(await page.inputValue('#loopend'), 10);
await page.keyboard.down('Shift');
await page.mouse.move(box.x + bodyX, midY);
await page.mouse.down();
await page.mouse.move(box.x + bodyX + 40, midY, { steps: 6 });
await page.mouse.up();
await page.keyboard.up('Shift');
await page.waitForTimeout(80);
const s1 = parseInt(await page.inputValue('#loopstart'), 10);
const e1 = parseInt(await page.inputValue('#loopend'), 10);
check('body drag moved the loop', s1 !== s0, s0 + ' -> ' + s1);
check('body drag preserved the loop length', (e1 - s1) === (e0 - s0),
  'len ' + (e0 - s0 + 1) + ' -> ' + (e1 - s1 + 1));

// And the bug spicyjpeg reported: a plain drag inside a loop body must move
// the playhead, not the loop. Without this the fix has no oracle at all.
const s2 = parseInt(await page.inputValue('#loopstart'), 10);
const headBefore = await page.evaluate(() => window.__loopeditor.view.playhead);
const insideX = (await handleX('start') + await handleX('end')) / 2;
await page.mouse.move(box.x + insideX, midY);
await page.mouse.down();
await page.mouse.move(box.x + insideX + 30, midY, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(80);
const headAfter = await page.evaluate(() => window.__loopeditor.view.playhead);
check('plain drag inside a loop moves the playhead', headAfter !== headBefore,
  headBefore + ' -> ' + headAfter);
check('plain drag inside a loop leaves the loop alone',
  parseInt(await page.inputValue('#loopstart'), 10) === s2,
  s2 + ' -> ' + (await page.inputValue('#loopstart')));

// Restore the fixture's own loop exactly, so the export check below compares
// against known numbers rather than whatever the drags happened to leave.
await page.fill('#loopstart', '8400');
await page.dispatchEvent('#loopstart', 'change');
await page.fill('#loopend', '25199');
await page.dispatchEvent('#loopend', 'change');
check('loop restored for export',
  (await page.inputValue('#loopstart')) === '8400' && (await page.inputValue('#loopend')) === '25199');

console.log('\n[6b] the playhead snaps to the beat grid');
await page.click('#fit');
await page.fill('#bpm', '120');
await page.dispatchEvent('#bpm', 'input');
await page.check('#gridon');
await page.check('#snapgrid');
await page.waitForTimeout(120);
const wbox = await page.locator('#wave').boundingBox();

// Deliberately click BETWEEN grid lines. 120 BPM at 44100 is 22050 samples
// per beat, and the fixture is 132300 frames = exactly 6 beats, so a click
// near the middle of a beat cannot land on a line by luck.
async function clickAndRead(x) {
  await page.mouse.click(wbox.x + x, wbox.y + wbox.height * 0.6);
  await page.waitForTimeout(80);
  return await page.evaluate(() => {
    const a = window.__loopeditor;
    const p = a.engine.positionSamples();
    return { pos: p, nearest: a.grid.nearestLine(p), spb: a.grid.samplesPerBeat };
  });
}
const midBeat = wbox.width * (1.5 / 6);      // a beat and a half in
let r = await clickAndRead(midBeat);
check('snap on: playhead lands exactly on a grid line', r.pos === r.nearest,
  'pos=' + r.pos + ' nearest=' + r.nearest);
check('snap on: landed on a beat multiple', r.pos % r.spb === 0,
  'pos=' + r.pos + ' spb=' + r.spb);

// Negative arm: with snapping off the same click must NOT be forced onto a
// line, or the check above is satisfied by a playhead that always snaps.
await page.uncheck('#snapgrid');
r = await clickAndRead(midBeat);
check('snap off: playhead is free of the grid', r.pos !== r.nearest,
  'pos=' + r.pos + ' nearest=' + r.nearest);
await page.check('#snapgrid');
await page.uncheck('#gridon');
await page.waitForTimeout(80);

console.log('\n[6c] the bar ruler');
await page.click('#fit');
await page.check('#gridon');
await page.waitForTimeout(120);
const rb = await page.locator('#wave').boundingBox();
const geom = await page.evaluate(() => {
  const a = window.__loopeditor;
  return { spBar: a.grid.samplesPerBar, rulerH: a.view.rulerHeight, barH: a.view.barRulerHeight };
});
check('bar ruler appears when the grid is on', geom.barH > 0, JSON.stringify(geom));
// 120 BPM / 4/4 at 44100 = 88200 samples per bar; the fixture is 132300
// frames, so bar 2 starts 2/3 of the way across a fitted view.
check('samples per bar as expected', geom.spBar === 88200, String(geom.spBar));

async function clickBarStrip(fracX) {
  await page.mouse.click(rb.x + rb.width * fracX, rb.y + 30);   // inside the bar strip
  await page.waitForTimeout(80);
  return await page.evaluate(() => window.__loopeditor.engine.positionSamples());
}
let pos = await clickBarStrip(0.72);
check('clicking bar 2 lands exactly on the bar start', pos === 88200, String(pos));
pos = await clickBarStrip(0.40);
check('clicking inside bar 1 lands on bar 1 start', pos === 0, String(pos));

// The strip must not be a dead zone that grabs loop handles instead.
const grabbed = await page.evaluate(() => window.__loopeditor.view._drag);
check('bar-strip click did not start a handle drag', !grabbed || grabbed.kind === 'seek',
  JSON.stringify(grabbed));

await page.screenshot({ path: path.join(outDir, 'shot-barruler.png') });
await page.uncheck('#gridon');
await page.waitForTimeout(80);
const off = await page.evaluate(() => window.__loopeditor.view.barRulerHeight);
check('bar ruler disappears with the grid off', off === 0, String(off));

console.log('\n[7] add a second loop and export');
await page.click('#addloop');
await page.waitForTimeout(60);
const rows = await page.locator('#looplist li').count();
check('second loop added', rows === 2, 'rows=' + rows);
await page.selectOption('#looptype', '1');       // ping-pong on the new one

const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#export')
]);
const outFile = path.join(outDir, 'exported.wav');
await download.saveAs(outFile);
check('export produced a file', fs.existsSync(outFile) && fs.statSync(outFile).size > 1000,
  fs.existsSync(outFile) ? String(fs.statSync(outFile).size) : 'missing');
check('export is named after the source', download.suggestedFilename() === 'fixture-loop.wav',
  download.suggestedFilename());

/* Write down what the UI says it exported, so the Python verifier can check
 * the file against the app's own claim rather than against a hardcoded guess
 * that would drift the moment the test above changes. */
const claimed = await page.evaluate(() => window.__loopeditor.state.loops.map(
  L => ({ start: L.start, end: L.end, type: L.type })));
fs.writeFileSync(path.join(outDir, 'expected.json'), JSON.stringify({
  loops: claimed,
  sampleRate: 44100,
  frames: 132300,
  chunks: ['fmt ', 'smpl', 'note', 'data']
}, null, 2));
console.log('  ..   UI claims: ' + JSON.stringify(claimed));

await page.screenshot({ path: path.join(outDir, 'shot-final.png') });

console.log('\n[8] console stayed clean throughout');
check('no console or page errors', consoleErrors.length === 0, consoleErrors.join(' | '));

await browser.close();

console.log('\n' + (failures.length ? 'FAILED: ' + failures.join(', ') : 'ALL BROWSER CHECKS PASSED'));
process.exit(failures.length ? 1 : 0);
