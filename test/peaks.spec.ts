/*
 * Unit tests for the waveform peak pyramid, sync and chunked.
 */
import { describe, it, expect } from 'vitest';

/* ---- chunked peak building --------------------------------------------- */

import { buildPeaks, buildPeaksAsync } from '../src/core/peaks.js';

function noisy(n: number) {
  const a = new Float32Array(n);
  // Deterministic, and varied enough that min/max per bucket differ.
  let x = 12345;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; a[i] = (x / 0x3fffffff) - 1; }
  return a;
}

describe('chunked peak building', () => {
  it('the async peak builder produces exactly the same pyramid as the sync one', async () => {
    // The whole point of the chunked version is that it is only a scheduling
    // change. If the numbers differ at all, the waveform you see while loading
    // is not the waveform you get.
    const ch = [noisy(200000), noisy(200000)];
    const sync = buildPeaks(ch);
    const async_ = await buildPeaksAsync(ch);
    expect(async_.length).toBe(sync.length);
    for (let c = 0; c < sync.length; c++) {
      expect(async_[c].length, 'level count differs on channel ' + c).toBe(sync[c].length);
      for (let l = 0; l < sync[c].length; l++) {
        expect(async_[c][l].bucket).toBe(sync[c][l].bucket);
        expect(Array.from(async_[c][l].min), 'min level ' + l).toEqual(Array.from(sync[c][l].min));
        expect(Array.from(async_[c][l].max), 'max level ' + l).toEqual(Array.from(sync[c][l].max));
      }
    }
  });

  it('the async builder actually yields, and reports monotonic progress', async () => {
    // A "chunked" builder that never yields is the failure this guards: it
    // would pass the equality test above and still freeze the page.
    let ticks = 0;
    const seen: number[] = [];
    const timer = setInterval(() => { ticks++; }, 1);
    const t0 = Date.now();
    await buildPeaksAsync([noisy(3000000)], f => seen.push(f));
    clearInterval(timer);

    expect(seen.length > 1, 'progress reported ' + seen.length + ' time(s); expected several').toBe(true);
    expect(seen[seen.length - 1], 'must finish at exactly 1').toBe(1);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i] >= seen[i - 1], 'progress went backwards: ' + seen[i - 1] + ' -> ' + seen[i]).toBe(true);
    }
    expect(seen.every(f => f >= 0 && f <= 1), 'progress out of range').toBe(true);
    expect(ticks > 0,
      'the event loop never ran during the build (took ' + (Date.now() - t0) + 'ms) - it did not yield').toBe(true);
  });

  it('the async builder handles an empty source without dividing by zero', async () => {
    const out = await buildPeaksAsync([new Float32Array(0)]);
    expect(Array.isArray(out)).toBe(true);
  });
});
