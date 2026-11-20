import type { TimelineClip } from '../types/editor';

/** Tolerance (seconds) used when comparing clip edges. */
export const EDGE_EPS = 1e-3;

export function clipEnd(clip: TimelineClip): number {
  return clip.timelineStart + clip.duration;
}

export function isClipActiveAt(clip: TimelineClip, t: number): boolean {
  return t >= clip.timelineStart && t < clipEnd(clip);
}

/**
 * Maps a timeline time to the time inside the source media for a clip.
 * Single source of truth for preview, export and audio scheduling
 * (previously preview and export used different reverse formulas).
 */
export function clipSourceTime(clip: TimelineClip, t: number): number {
  const spd = clip.speed || 1;
  const local = Math.max(0, Math.min(clip.duration, t - clip.timelineStart));
  return clip.reverse
    ? clip.sourceStart + Math.max(0, clip.duration - local) * spd
    : clip.sourceStart + local * spd;
}

export function findActiveClip(
  clips: TimelineClip[],
  track: TimelineClip['track'],
  t: number
): TimelineClip | undefined {
  return clips.find((c) => c.track === track && isClipActiveAt(c, t));
}

/** First clip on `track` that starts at or after `t` (excluding `exclude`). */
export function findNextClip(
  clips: TimelineClip[],
  track: TimelineClip['track'],
  t: number,
  excludeId?: string
): TimelineClip | undefined {
  let best: TimelineClip | undefined;
  for (const c of clips) {
    if (c.track !== track || c.id === excludeId) continue;
    if (c.timelineStart < t - EDGE_EPS) continue;
    if (!best || c.timelineStart < best.timelineStart) best = c;
  }
  return best;
}

/**
 * True when `b` directly continues `a` in both timeline and source time
 * (e.g. the two halves of a split). Such boundaries need no seek and no declick.
 */
export function isSeamlessContinuation(a: TimelineClip, b: TimelineClip): boolean {
  if (!a.mediaId || a.mediaId !== b.mediaId || a.track !== b.track) return false;
  if (a.reverse || b.reverse) return false;
  if ((a.speed || 1) !== (b.speed || 1)) return false;
  if (Math.abs(clipEnd(a) - b.timelineStart) > EDGE_EPS) return false;
  const aSrcEnd = a.sourceStart + a.duration * (a.speed || 1);
  return Math.abs(aSrcEnd - b.sourceStart) < EDGE_EPS * 5;
}

export function hasSeamlessNeighbor(
  clip: TimelineClip,
  clips: TimelineClip[],
  side: 'prev' | 'next'
): boolean {
  return clips.some((o) =>
    o.id !== clip.id && (side === 'prev' ? isSeamlessContinuation(o, clip) : isSeamlessContinuation(clip, o))
  );
}

/**
 * Splits a clip at clip-local timeline offset `offset` (`0 < offset < target.duration`).
 * Handles both forward and reversed clips so `clipSourceTime` is continuous across the split.
 */
export function splitClipAtOffset(
  target: TimelineClip,
  offset: number,
  rightId: string
): [TimelineClip, TimelineClip] {
  const spd = target.speed || 1;
  const rightDur = target.duration - offset;
  const leftSourceStart = target.reverse
    ? target.sourceStart + rightDur * spd
    : target.sourceStart;
  const rightSourceStart = target.reverse
    ? target.sourceStart
    : target.sourceStart + offset * spd;

  const leftClip: TimelineClip = {
    ...target,
    duration: offset,
    sourceStart: leftSourceStart,
    fxData: target.fxData ? { ...target.fxData } : undefined,
  };
  const rightClip: TimelineClip = {
    ...target,
    id: rightId,
    timelineStart: target.timelineStart + offset,
    duration: rightDur,
    sourceStart: rightSourceStart,
    fxData: target.fxData ? { ...target.fxData } : undefined,
  };
  return [leftClip, rightClip];
}
