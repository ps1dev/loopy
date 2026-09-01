/*
 * The peak pyramid is the only reason this stays responsive: a zoomed-out
 * five-minute stereo file is ~26M reads per redraw if you scan raw samples,
 * which is a visibly janky drag. Levels are built once on load (base bucket
 * 256, doubling) and the renderer picks the coarsest level that still has at
 * least one bucket per pixel column. Below 256 samples/pixel it reads raw.
 */

export const BASE_BUCKET = 256;

/** One pyramid level: per-bucket min/max, `bucket` samples to a bucket. */
export interface PeakLevel {
  bucket: number;
  min: Float32Array;
  max: Float32Array;
}

/** One entry per channel, coarsest-last: `pyramid[channel][level]`. */
export type PeakPyramid = PeakLevel[][];

export function buildPeaks(channels: Float32Array[]): PeakPyramid {
  const out: PeakPyramid = [];
  for (let c = 0; c < channels.length; c++) {
    const data = channels[c];
    const levels: PeakLevel[] = [];
    const n = Math.ceil(data.length / BASE_BUCKET);
    const mn = new Float32Array(n), mx = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = i * BASE_BUCKET, e = Math.min(s + BASE_BUCKET, data.length);
      let lo = Infinity, hi = -Infinity;
      for (let j = s; j < e; j++) { const v = data[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (lo === Infinity) { lo = 0; hi = 0; }
      mn[i] = lo; mx[i] = hi;
    }
    levels.push({ bucket: BASE_BUCKET, min: mn, max: mx });

    while (levels[levels.length - 1].min.length > 2) {
      const prev = levels[levels.length - 1];
      const m = Math.ceil(prev.min.length / 2);
      const pmn = new Float32Array(m), pmx = new Float32Array(m);
      for (let k = 0; k < m; k++) {
        const a = k * 2, b = Math.min(a + 1, prev.min.length - 1);
        pmn[k] = Math.min(prev.min[a], prev.min[b]);
        pmx[k] = Math.max(prev.max[a], prev.max[b]);
      }
      levels.push({ bucket: prev.bucket * 2, min: pmn, max: pmx });
    }
    out.push(levels);
  }
  return out;
}

/*
 * Same pyramid, built in slices so the page can paint between them.
 *
 * The synchronous version above blocks the main thread for the whole build,
 * which on a long file means the loading overlay cannot animate its progress
 * and the window is frozen - the exact thing an overlay exists to avoid. This
 * yields whenever it has held the thread for longer than a frame, and reports
 * a real 0..1 fraction rather than a fake one.
 *
 * Only the base level is chunked: the reductions above it are cheap (half the
 * work of the level below, geometrically), so they run in one go at the end.
 *
 * `yieldEveryMs` exists for the tests and nothing else. How many slices a build
 * splits into is a race against the wall clock: a build that finishes inside
 * one interval yields once, at the end, and that is CORRECT behaviour rather
 * than a bug. A test asserting "several progress reports" is therefore grading
 * machine speed, which is exactly how it failed 1 run in 4 once the suite began
 * running files in parallel workers next to a browser launch. Passing 0 makes
 * every check point yield, so the chunking can be asserted deterministically.
 */
export async function buildPeaksAsync(
  channels: Float32Array[],
  onProgress?: ((fraction: number) => void) | null,
  yieldEveryMs: number = 12
): Promise<PeakPyramid> {
  const out: PeakPyramid = [];
  let totalBuckets = 0;
  for (let c0 = 0; c0 < channels.length; c0++) {
    totalBuckets += Math.ceil(channels[c0].length / BASE_BUCKET);
  }
  if (!totalBuckets) return buildPeaks(channels);
  let done = 0;
  let lastYield = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  for (let c = 0; c < channels.length; c++) {
    const data = channels[c];
    const n = Math.ceil(data.length / BASE_BUCKET);
    const mn = new Float32Array(n), mx = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const s = i * BASE_BUCKET, e = Math.min(s + BASE_BUCKET, data.length);
      let lo = Infinity, hi = -Infinity;
      for (let j = s; j < e; j++) { const v = data[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (lo === Infinity) { lo = 0; hi = 0; }
      mn[i] = lo; mx[i] = hi;
      done++;

      // Check the clock every 256 buckets rather than every one: calling
      // performance.now() per bucket is itself a measurable cost here.
      if ((i & 255) === 0) {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (now - lastYield > yieldEveryMs) {
          if (onProgress) onProgress(done / totalBuckets);
          await new Promise(function (r) { setTimeout(r, 0); });
          lastYield = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        }
      }
    }

    const levels: PeakLevel[] = [{ bucket: BASE_BUCKET, min: mn, max: mx }];
    while (levels[levels.length - 1].min.length > 2) {
      const prev = levels[levels.length - 1];
      const m = Math.ceil(prev.min.length / 2);
      const pmn = new Float32Array(m), pmx = new Float32Array(m);
      for (let k = 0; k < m; k++) {
        const a = k * 2, b = Math.min(a + 1, prev.min.length - 1);
        pmn[k] = Math.min(prev.min[a], prev.min[b]);
        pmx[k] = Math.max(prev.max[a], prev.max[b]);
      }
      levels.push({ bucket: prev.bucket * 2, min: pmn, max: pmx });
    }
    out.push(levels);
  }
  if (onProgress) onProgress(1);
  return out;
}
