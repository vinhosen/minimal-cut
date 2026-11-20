/**
 * Authoritative Master Playback Clock anchored strictly to `AudioContext.currentTime` (Phase 2).
 *
 * Strict Guardrails:
 * - Designates `AudioContext.currentTime` as the single authoritative Master Clock.
 * - NEVER uses `Date.now()`, `performance.now()`, `setInterval`, or HTML `<video>`/`<audio>`
 *   clocks to drive timeline timestamps.
 */

export interface AudioTimeSource {
  readonly currentTime: number;
  readonly state?: AudioContextState;
}

export class TimelineClock {
  private ctx: AudioTimeSource | null = null;
  private playing = false;
  private playbackStartContextTime = 0;
  private timelineOffset = 0;

  /** Bind the AudioContext whose `currentTime` drives this master clock. */
  attach(ctx: AudioTimeSource): void {
    if (this.ctx === ctx) return;
    const cur = this.getCurrentTime();
    this.ctx = ctx;
    this.timelineOffset = cur;
    if (this.playing) {
      this.playbackStartContextTime = ctx.currentTime;
    }
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /** Anchor playback at `timelineOffset` against the current `AudioContext.currentTime`. */
  start(timelineOffset: number): void {
    this.timelineOffset = Math.max(0, timelineOffset);
    this.playbackStartContextTime = this.ctx ? this.ctx.currentTime : 0;
    this.playing = true;
  }

  /** Freeze the clock at its current timeline timestamp and return it. */
  pause(): number {
    const current = this.getCurrentTime();
    this.timelineOffset = current;
    this.playing = false;
    return current;
  }

  /** Re-anchor the clock to a new discrete timeline timestamp. */
  seek(timelineOffset: number): void {
    this.timelineOffset = Math.max(0, timelineOffset);
    if (this.playing && this.ctx) {
      this.playbackStartContextTime = this.ctx.currentTime;
    }
  }

  /** Current authoritative timeline position in seconds derived exclusively from `AudioContext.currentTime`. */
  getCurrentTime(): number {
    if (!this.playing || !this.ctx) {
      return this.timelineOffset;
    }
    const elapsed = Math.max(0, this.ctx.currentTime - this.playbackStartContextTime);
    return this.timelineOffset + elapsed;
  }

  /** Convert a timeline timestamp (seconds) into the exact `AudioContext.currentTime` at which it occurs. */
  timelineToContextTime(timelineSec: number): number {
    return this.playbackStartContextTime + (timelineSec - this.timelineOffset);
  }
}
