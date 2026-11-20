/**
 * FilmCraft Exact Media Time (`filmcraft_time::Tick`, ported from storytold/filmcraft, MIT OR Apache-2.0).
 *
 * All time is an integer number of `Tick`s at `TICKS_PER_SECOND = 254_016_000_000n`.
 * That number divides evenly into the frame duration of every broadcast rate
 * (23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120…) and the sample duration
 * of every common audio rate (8 kHz to 192 kHz, including the 44.1 kHz family).
 * So frame and sample positions are exact integers, edits never drift, and audio
 * and video line up to the sample.
 */

export const TICKS_PER_SECOND = 254_016_000_000n;
export const TICKS_PER_SECOND_NUM = 254_016_000_000;

export type Tick = bigint;

export interface FrameRate {
  readonly num: number;
  readonly den: number;
}

export interface TimeRange {
  readonly start: Tick;
  readonly duration: Tick;
}

export function secondsToTicks(sec: number): Tick {
  if (!Number.isFinite(sec)) return 0n;
  return BigInt(Math.round(sec * TICKS_PER_SECOND_NUM));
}

export function ticksToSeconds(ticks: Tick): number {
  return Number(ticks) / TICKS_PER_SECOND_NUM;
}

/** Convert ticks to a rational unit `num / den` with nearest rounding (like `Tick::to_rational_round`). */
export function ticksToRationalRound(ticks: Tick, num: number, den: number): bigint {
  const n = BigInt(Math.max(1, Math.round(num)));
  const d = BigInt(Math.max(1, Math.round(den)));
  const numer = ticks * d;
  const denom = TICKS_PER_SECOND * n;
  const half = denom / 2n;
  return numer >= 0n ? (numer + half) / denom : (numer - half) / denom;
}

/** Exact tick duration of one frame at `rate` (`num / den` fps). */
export function frameDuration(rate: FrameRate | number): Tick {
  const r: FrameRate = typeof rate === 'number' ? { num: rate, den: 1 } : rate;
  return (TICKS_PER_SECOND * BigInt(r.den)) / BigInt(r.num);
}

/** Exact tick of frame index `frame` at `rate`. */
export function tickOfFrame(frame: number | bigint, rate: FrameRate | number): Tick {
  return BigInt(frame) * frameDuration(rate);
}

/** Frame index at `tick` (floor for non-negative ticks). */
export function frameAtTick(tick: Tick, rate: FrameRate | number): bigint {
  const dur = frameDuration(rate);
  if (dur <= 0n) return 0n;
  return tick / dur;
}

/** Snap `tick` to the nearest frame boundary at `rate`. */
export function snapTickToFrame(tick: Tick, rate: FrameRate | number): Tick {
  const dur = frameDuration(rate);
  if (dur <= 0n) return tick;
  const half = dur / 2n;
  const idx = tick >= 0n ? (tick + half) / dur : (tick - half) / dur;
  return idx * dur;
}

/** Snap a seconds value to the nearest frame boundary using exact FilmCraft integer ticks. */
export function snapSecondsToFrame(sec: number, rate: FrameRate | number): number {
  return ticksToSeconds(snapTickToFrame(secondsToTicks(sec), rate));
}

/** Exact tick duration of one audio sample at `sampleRate` Hz. */
export function sampleDuration(sampleRate: number): Tick {
  return TICKS_PER_SECOND / BigInt(Math.max(1, Math.round(sampleRate)));
}
