import { describe, expect, it } from 'vitest';
import type { TimelineClip } from '../types/editor';
import {
  clipSourceTime,
  findNextClip,
  hasSeamlessNeighbor,
  isSeamlessContinuation,
  splitClipAtOffset,
} from '../utils/clipTime';
import { clipGainAt, DECLICK_SEC, envelopeBreakpoints } from '../audio/scheduleClipAudio';

function makeClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: 'c1',
    track: 'video',
    name: 'Clip 1',
    mediaId: 'm1',
    timelineStart: 0,
    duration: 4,
    sourceStart: 2,
    sourceDuration: 10,
    x: 0,
    y: 0,
    scale: 100,
    opacity: 100,
    rotation: 0,
    crop: 0,
    flipH: false,
    flipV: false,
    blend: 'source-over',
    mask: 'none',
    transition: 'none',
    speed: 1,
    reverse: false,
    muted: false,
    volume: 100,
    fadeIn: 0,
    fadeOut: 0,
    ...overrides,
  };
}

describe('Phase 0 — clipTime & audio envelope', () => {
  it('computes forward and reverse source time consistently (B2/B3)', () => {
    const fwd = makeClip({ timelineStart: 1, duration: 4, sourceStart: 2, speed: 1.5, reverse: false });
    expect(clipSourceTime(fwd, 1)).toBeCloseTo(2);
    expect(clipSourceTime(fwd, 3)).toBeCloseTo(2 + 2 * 1.5);
    expect(clipSourceTime(fwd, 5)).toBeCloseTo(2 + 4 * 1.5);

    const rev = makeClip({ timelineStart: 1, duration: 4, sourceStart: 2, speed: 1.5, reverse: true });
    // At start of reversed clip on timeline (t=1), source time is at the end of the trimmed region
    expect(clipSourceTime(rev, 1)).toBeCloseTo(2 + 4 * 1.5);
    expect(clipSourceTime(rev, 3)).toBeCloseTo(2 + 2 * 1.5);
    expect(clipSourceTime(rev, 5)).toBeCloseTo(2);
  });

  it('detects seamless split neighbors vs hard cuts (B8)', () => {
    const left = makeClip({ id: 'left', timelineStart: 0, duration: 2, sourceStart: 1, speed: 2 });
    const rightSeamless = makeClip({ id: 'right', timelineStart: 2, duration: 3, sourceStart: 5, speed: 2 });
    const rightJump = makeClip({ id: 'jump', timelineStart: 2, duration: 3, sourceStart: 8, speed: 2 });

    expect(isSeamlessContinuation(left, rightSeamless)).toBe(true);
    expect(isSeamlessContinuation(left, rightJump)).toBe(false);
    expect(hasSeamlessNeighbor(left, [left, rightSeamless], 'next')).toBe(true);
    expect(hasSeamlessNeighbor(rightSeamless, [left, rightSeamless], 'prev')).toBe(true);
    expect(hasSeamlessNeighbor(left, [left, rightJump], 'next')).toBe(false);
  });

  it('finds the next upcoming clip on a track', () => {
    const c1 = makeClip({ id: 'c1', timelineStart: 0, duration: 2 });
    const c2 = makeClip({ id: 'c2', timelineStart: 4, duration: 2 });
    const c3 = makeClip({ id: 'c3', timelineStart: 2, duration: 2 });
    const next = findNextClip([c1, c2, c3], 'video', 2, 'c1');
    expect(next?.id).toBe('c3');
  });

  it('applies 5ms declick micro-fade at hard cuts and respects fadeIn/fadeOut/keyframes', () => {
    const clip = makeClip({
      duration: 2,
      volume: 80,
      fadeIn: 0.5,
      fadeOut: 0.5,
      normalizeGain: 1.25,
    });
    const opts = { declickIn: true, declickOut: true };
    // At t=0 and t=duration, declick forces gain to 0
    expect(clipGainAt(clip, 0, opts)).toBe(0);
    expect(clipGainAt(clip, 2, opts)).toBe(0);
    // At midpoint (t=1.0), 80% * 1.25 = 1.0
    expect(clipGainAt(clip, 1.0, opts)).toBeCloseTo(1.0);
    // Halfway through 5ms declick
    expect(clipGainAt(clip, DECLICK_SEC / 2, { declickIn: true, declickOut: false })).toBeLessThan(0.02);

    const bps = envelopeBreakpoints(clip, 0, 2, opts);
    expect(bps).toContain(0);
    expect(bps).toContain(DECLICK_SEC);
    expect(bps).toContain(0.5);
    expect(bps).toContain(1.5);
    expect(bps).toContain(2 - DECLICK_SEC);
    expect(bps).toContain(2);
  });

  it('preserves continuous source timestamps when splitting forward and reversed clips', () => {
    const rev = makeClip({
      timelineStart: 2,
      duration: 6,
      sourceStart: 3,
      speed: 1.5,
      reverse: true,
    });
    const [left, right] = splitClipAtOffset(rev, 2.5, 'right_id');
    // At t=3.0 (inside left half)
    expect(clipSourceTime(left, 3.0)).toBeCloseTo(clipSourceTime(rev, 3.0));
    // At split boundary t=4.5
    expect(clipSourceTime(left, 4.5)).toBeCloseTo(clipSourceTime(rev, 4.5));
    expect(clipSourceTime(right, 4.5)).toBeCloseTo(clipSourceTime(rev, 4.5));
    // At t=6.5 (inside right half)
    expect(clipSourceTime(right, 6.5)).toBeCloseTo(clipSourceTime(rev, 6.5));
  });
});
