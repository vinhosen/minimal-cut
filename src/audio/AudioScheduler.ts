/**
 * Deterministic Lookahead Web Audio Scheduler (Phase 2).
 *
 * Strict Guardrails:
 * - Uses `TimelineClock` (anchored strictly to `AudioContext.currentTime`) as the sole clock.
 * - Schedules gapless `AudioBufferSourceNode` playback inside a deterministic 150ms lookahead
 *   window (`LOOKAHEAD_SEC = 0.15`, within 100ms–200ms).
 * - Immediately stops and disconnects EVERY active `AudioBufferSourceNode` and `GainNode`
 *   on pause, scrub, timeline edit, loop wrap, or component unmount.
 */

import type { MediaAsset, TimelineClip } from '../types/editor';
import { clipEnd } from '../utils/clipTime';
import { audibleClips, scheduleClipAudioNodes, type ScheduledAudioNodes } from './scheduleClipAudio';
import type { TimelineClock } from './TimelineClock';

/** Deterministic lookahead window in seconds (150ms — strictly within 100ms–200ms guardrail). */
export const AUDIO_LOOKAHEAD_SEC = 0.15;

export class AudioScheduler {
  private readonly clock: TimelineClock;
  private readonly lookaheadSec: number;
  private activeNodes = new Set<ScheduledAudioNodes>();
  private scheduledClipIds = new Set<string>();

  constructor(clock: TimelineClock, lookaheadSec = AUDIO_LOOKAHEAD_SEC) {
    this.clock = clock;
    this.lookaheadSec = lookaheadSec;
  }

  getActiveNodeCount(): number {
    return this.activeNodes.size;
  }

  /**
   * Immediately stop and disconnect all active `AudioBufferSourceNode` and `GainNode` instances
   * and clear the lookahead schedule state (called on pause, scrub, edit, or unmount).
   */
  stopAll(): void {
    for (const branch of this.activeNodes) {
      branch.source.onended = null;
      try {
        branch.source.stop();
      } catch {
        // node may already have ended
      }
      try {
        branch.source.disconnect();
      } catch {
        // ignore
      }
      try {
        branch.gain.disconnect();
      } catch {
        // ignore
      }
    }
    this.activeNodes.clear();
    this.scheduledClipIds.clear();
  }

  /**
   * Reset active audio branches and immediately prime the lookahead window from the clock's
   * current timeline position.
   */
  restart(
    ctx: AudioContext,
    destination: AudioNode,
    clips: TimelineClip[],
    assets: Map<string, MediaAsset>
  ): void {
    this.stopAll();
    this.pump(ctx, destination, clips, assets);
  }

  /**
   * Deterministic lookahead pump: schedules every audible clip whose timeline start falls
   * within `[currentTime, currentTime + lookaheadSec]` at its exact `AudioContext.currentTime`.
   */
  pump(
    ctx: AudioContext,
    destination: AudioNode,
    clips: TimelineClip[],
    assets: Map<string, MediaAsset>
  ): number {
    if (!this.clock.isPlaying()) return 0;

    const nowTimeline = this.clock.getCurrentTime();
    const horizon = nowTimeline + this.lookaheadSec;
    let scheduledCount = 0;

    for (const [clip, buffer] of audibleClips(clips, assets)) {
      if (clip.muted) continue;
      if (this.scheduledClipIds.has(clip.id)) continue;
      if (clipEnd(clip) <= nowTimeline + 1e-4) continue;
      if (clip.timelineStart > horizon) continue;

      const playFrom = Math.max(nowTimeline, clip.timelineStart);
      const exactContextWhen = Math.max(ctx.currentTime, this.clock.timelineToContextTime(playFrom));

      const branch = scheduleClipAudioNodes({
        ctx,
        destination,
        clip,
        buffer,
        playFrom,
        when: exactContextWhen,
        allClips: clips,
      });

      if (branch) {
        this.scheduledClipIds.add(clip.id);
        this.activeNodes.add(branch);
        scheduledCount++;
        branch.source.onended = () => {
          this.activeNodes.delete(branch);
          try {
            branch.source.disconnect();
            branch.gain.disconnect();
          } catch {
            // ignore
          }
        };
      }
    }

    return scheduledCount;
  }
}
