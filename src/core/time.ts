/* Clock-style time formatting, shared by the ruler and the readouts. */

export function formatTime(sec: number, step?: number): string {
  const neg = sec < 0;
  if (neg) sec = -sec;
  const decimals = (step === undefined) ? 3 : (step < 0.01 ? 3 : step < 1 ? 2 : 0);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const str = m + ':' + (s < 10 ? '0' : '') + s.toFixed(decimals);
  return (neg ? '-' : '') + str;
}
