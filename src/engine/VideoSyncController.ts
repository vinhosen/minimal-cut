import type { MediaAsset, TimelineClip } from '../types/editor';
import { clipEnd, clipSourceTime, findActiveClip, findNextClip, isSeamlessContinuation } from '../utils/clipTime';

/** How far ahead (seconds) we pre-roll the next clip on a standby element (once per clip). */
const LOOKAHEAD_SEC = 1.5;
/** Minimum cooldown (timeline seconds) between corrective drift seeks so the decoder can settle without stuttering. */
const DRIFT_SEEK_COOLDOWN_SEC = 0.25;

type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, metadata: unknown) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export interface PlaybackSyncOptions {
  /**
   * Phase 2 AudioContext Master Clock drift threshold (seconds).
   * When undefined (Phase 1 standalone), NO corrective seeks happen during continuous playback.
   * When set (e.g. 0.08 = 80ms), a corrective seek is issued ONLY if `|videoTimelineTime - time| > threshold`.
   */
  driftThresholdSec?: number;
  /**
   * When true (Phase 2), always mute underlying `<video>` elements so all audio passes
   * exclusively through the Web Audio graph.
   */
  alwaysMuteVideo?: boolean;
}

/**
 * Flicker-Free Double-Buffered Video Playback Controller (Phase 1 + Phase 2 drift slaving).
 *
 * Strict Guardrails:
 * - NEVER assigns `video.currentTime` continuously inside `requestAnimationFrame`.
 * - Restricts programmatic seeks strictly to discrete events:
 *   1. User scrubbing / manual pause / step (`seekDiscrete`)
 *   2. Playback start / loop wrap (`seekDiscrete`)
 *   3. Clip-to-clip boundary transitions (`active.id !== lastActiveClipId`)
 *   4. Phase 2 Master Clock drift recovery ONLY when `|videoTimelineTime - audioMasterTime| > 0.08` (80ms)
 * - Pairs native `video.play()` with `video.requestVideoFrameCallback()` (falling back to rAF).
 * - Maintains a standby `<video>` element per asset and pre-rolls upcoming clips ONCE per boundary.
 */
export class VideoSyncController {
  private assignment = new Map<string, HTMLVideoElement>();
  private standby = new Map<string, HTMLVideoElement>();
  private attached = new WeakSet<HTMLVideoElement>();
  private lastActiveClipId: string | null = null;
  private preRolledClipId: string | null = null;
  private lastCorrectiveSeekTimeline = -Infinity;
  private proxyMode = false;

  private vfcVideo: VideoWithRVFC | null = null;
  private vfcHandle: number | null = null;

  private readonly getAssets: () => Map<string, MediaAsset>;
  private readonly onFrameReady: () => void;

  constructor(getAssets: () => Map<string, MediaAsset>, onFrameReady: () => void) {
    this.getAssets = getAssets;
    this.onFrameReady = onFrameReady;
  }

  /** Element currently responsible for drawing `clip`. */
  elementFor(clip: TimelineClip): HTMLVideoElement | undefined {
    const assigned = this.assignment.get(clip.id);
    if (assigned) return assigned;
    return clip.mediaId ? this.getAssets().get(clip.mediaId)?.videoEl : undefined;
  }

  /**
   * Reads native `video.currentTime` from the currently playing forward clip and maps it back
   * to timeline seconds (Phase 1 native playback clock readback).
   */
  getActiveVideoTimelineTime(clips: TimelineClip[]): number | null {
    if (!this.lastActiveClipId) return null;
    const clip = clips.find((c) => c.id === this.lastActiveClipId);
    if (!clip || clip.reverse) return null;
    const el = this.assignment.get(clip.id);
    if (!el || el.paused || el.seeking || el.readyState < 2) return null;
    const spd = clip.speed || 1;
    const timelineTime = clip.timelineStart + (el.currentTime - clip.sourceStart) / spd;
    return Number.isFinite(timelineTime) ? timelineTime : null;
  }

  private cancelVfc(): void {
    if (this.vfcVideo && this.vfcHandle !== null) {
      try {
        this.vfcVideo.cancelVideoFrameCallback?.(this.vfcHandle);
      } catch {
        // ignore
      }
    }
    this.vfcVideo = null;
    this.vfcHandle = null;
  }

  private attachVfc(el: HTMLVideoElement | undefined, playing: boolean): void {
    const v = el as VideoWithRVFC | undefined;
    if (!playing || !v || typeof v.requestVideoFrameCallback !== 'function') {
      this.cancelVfc();
      return;
    }
    if (this.vfcVideo === v && this.vfcHandle !== null) return;
    this.cancelVfc();
    this.vfcVideo = v;
    const onVideoFrame = () => {
      this.vfcHandle = null;
      this.onFrameReady();
      if (this.vfcVideo === v && !v.paused) {
        this.vfcHandle = v.requestVideoFrameCallback!(onVideoFrame);
      }
    };
    this.vfcHandle = v.requestVideoFrameCallback(onVideoFrame);
  }

  private attach(el: HTMLVideoElement): void {
    if (this.attached.has(el)) return;
    this.attached.add(el);
    el.preload = 'auto';
    el.addEventListener('seeked', this.onFrameReady);
    el.addEventListener('loadeddata', this.onFrameReady);
  }

  setProxyMode(enabled: boolean): void {
    if (this.proxyMode === enabled) return;
    this.proxyMode = enabled;
    this.preRolledClipId = null;
    this.getAssets().forEach((asset) => {
      if (asset.type !== 'video' || !asset.videoEl) return;
      const targetSrc = enabled && asset.proxyUrl ? asset.proxyUrl : asset.url;
      for (const el of [asset.videoEl, this.standby.get(asset.id)]) {
        if (el && el.src !== targetSrc) {
          const curTime = el.currentTime;
          const wasPlaying = !el.paused;
          el.src = targetSrc;
          el.currentTime = curTime;
          if (wasPlaying) el.play().catch(() => {});
        }
      }
    });
  }

  private elementsOf(asset: MediaAsset): HTMLVideoElement[] {
    if (!asset.videoEl) return [];
    const targetSrc = this.proxyMode && asset.proxyUrl ? asset.proxyUrl : asset.url;
    if (asset.videoEl.src !== targetSrc) {
      asset.videoEl.src = targetSrc;
    }
    this.attach(asset.videoEl);
    let sb = this.standby.get(asset.id);
    if (!sb) {
      sb = document.createElement('video');
      sb.src = targetSrc;
      sb.playsInline = true;
      sb.muted = true;
      this.attach(sb);
      this.standby.set(asset.id, sb);
    } else if (sb.src !== targetSrc) {
      sb.src = targetSrc;
    }
    return [asset.videoEl, sb];
  }

  private pick(clip: TimelineClip, taken: Map<string, HTMLVideoElement>): HTMLVideoElement | undefined {
    const asset = clip.mediaId ? this.getAssets().get(clip.mediaId) : undefined;
    if (!asset) return undefined;
    const els = this.elementsOf(asset);
    const used = new Set(taken.values());
    const prev = this.assignment.get(clip.id);
    if (prev && !used.has(prev) && els.includes(prev)) return prev;
    return els.find((e) => !used.has(e)) ?? els[0];
  }

  private assignClips(time: number, clips: TimelineClip[]) {
    const active = findActiveClip(clips, 'video', time);
    const next = findNextClip(clips, 'video', active ? clipEnd(active) : time, active?.id);
    const upcoming = next && next.timelineStart - time <= LOOKAHEAD_SEC ? next : undefined;

    const keep = new Map<string, HTMLVideoElement>();
    const activeEl = active ? this.pick(active, keep) : undefined;
    if (active && activeEl) keep.set(active.id, activeEl);

    let upcomingEl: HTMLVideoElement | undefined;
    if (upcoming) {
      upcomingEl =
        active && activeEl && isSeamlessContinuation(active, upcoming)
          ? activeEl
          : this.pick(upcoming, keep);
      if (upcomingEl) keep.set(upcoming.id, upcomingEl);
    }
    this.assignment = keep;

    // Pause all idle elements outside active clip bounds
    this.getAssets().forEach((asset) => {
      if (asset.type !== 'video' || !asset.videoEl) return;
      for (const el of [asset.videoEl, this.standby.get(asset.id)]) {
        if (el && el !== activeEl && !el.paused) {
          el.pause();
        }
      }
    });

    return { active, activeEl, upcoming, upcomingEl };
  }

  private preRollUpcoming(
    upcoming: TimelineClip | undefined,
    upcomingEl: HTMLVideoElement | undefined,
    activeEl: HTMLVideoElement | undefined
  ): void {
    if (!upcoming || !upcomingEl || upcomingEl === activeEl) {
      if (!upcoming) this.preRolledClipId = null;
      return;
    }
    if (this.preRolledClipId === upcoming.id) return;
    upcomingEl.muted = true;
    if (!upcomingEl.paused) upcomingEl.pause();
    // Do not permanently latch preRolledClipId while standby is still mid-seek; retry next tick.
    if (upcomingEl.seeking) return;
    this.preRolledClipId = upcoming.id;
    const tgt = clipSourceTime(upcoming, upcoming.timelineStart);
    if (Math.abs(upcomingEl.currentTime - tgt) > 0.02) {
      upcomingEl.currentTime = tgt;
    }
  }

  /**
   * DISCRETE seek handler: called ONLY on discrete user/transport events
   * (user timeline scrub, manual step, play start, loop wrap).
   */
  seekDiscrete(
    time: number,
    clips: TimelineClip[],
    playing: boolean,
    opts: PlaybackSyncOptions = {}
  ): void {
    const assets = this.getAssets();
    const { active, activeEl, upcoming, upcomingEl } = this.assignClips(time, clips);
    this.lastActiveClipId = active?.id ?? null;
    this.preRolledClipId = null;
    this.lastCorrectiveSeekTimeline = time;

    if (active && activeEl) {
      const asset = assets.get(active.mediaId!);
      const spd = active.speed || 1;
      const duration = asset?.duration ?? activeEl.duration;
      const tgt = Math.max(0, Math.min(clipSourceTime(active, time), duration || Infinity));

      activeEl.muted = Boolean(opts.alwaysMuteVideo || asset?.audioBuffer || active.muted || active.reverse);
      activeEl.volume = Math.min(1, Math.max(0, (active.volume ?? 100) / 100));
      activeEl.playbackRate = spd;

      if (Math.abs(activeEl.currentTime - tgt) > 0.004) {
        activeEl.currentTime = tgt;
      }

      if (playing && !active.reverse) {
        if (activeEl.paused) activeEl.play().catch(() => {});
      } else if (!activeEl.paused) {
        activeEl.pause();
      }
    }

    this.attachVfc(active && !active.reverse ? activeEl : undefined, playing);
    this.preRollUpcoming(upcoming, upcomingEl, activeEl);
  }

  /**
   * Continuous playback update called during active playback.
   *
   * - NEVER assigns `video.currentTime` on steady-state frames.
   * - Detects discrete clip-to-clip boundary transitions (`active.id !== lastActiveClipId`)
   *   and switches smoothly to the pre-rolled standby element (or seeks once at the boundary).
   * - Optionally checks AudioContext master clock drift when `opts.driftThresholdSec` is set
   *   (80ms threshold in Phase 2) with cooldown protection against micro-stuttering.
   */
  updatePlayback(
    time: number,
    clips: TimelineClip[],
    opts: PlaybackSyncOptions = {}
  ): void {
    const assets = this.getAssets();
    const prevClipId = this.lastActiveClipId;
    const prevClip = prevClipId ? clips.find((c) => c.id === prevClipId) : undefined;
    const { active, activeEl, upcoming, upcomingEl } = this.assignClips(time, clips);

    const isBoundaryTransition = (active?.id ?? null) !== prevClipId;
    this.lastActiveClipId = active?.id ?? null;

    if (active && activeEl) {
      const asset = assets.get(active.mediaId!);
      const spd = active.speed || 1;
      const duration = asset?.duration ?? activeEl.duration;
      const tgt = Math.max(0, Math.min(clipSourceTime(active, time), duration || Infinity));

      activeEl.muted = Boolean(opts.alwaysMuteVideo || asset?.audioBuffer || active.muted || active.reverse);
      activeEl.volume = Math.min(1, Math.max(0, (active.volume ?? 100) / 100));
      if (activeEl.playbackRate !== spd) {
        activeEl.playbackRate = spd;
      }

      if (active.reverse) {
        // Reversed video is decoded by FilmCraft WebCodecs WcSource when available; keep <video> paused.
        if (!activeEl.paused) activeEl.pause();
        if (isBoundaryTransition && Math.abs(activeEl.currentTime - tgt) > 0.02) {
          activeEl.currentTime = tgt;
        }
      } else {
        // 1. Discrete clip-to-clip boundary transition
        if (isBoundaryTransition) {
          const seamless = Boolean(prevClip && isSeamlessContinuation(prevClip, active));
          if (!seamless && Math.abs(activeEl.currentTime - tgt) > 0.04) {
            activeEl.currentTime = tgt;
            this.lastCorrectiveSeekTimeline = time;
          }
        } else if (opts.driftThresholdSec !== undefined && !activeEl.seeking && activeEl.readyState >= 2) {
          // 2. Phase 2 Master Clock drift check (strict 80ms threshold + cooldown to prevent micro-stutter)
          const videoTimelineTime = active.timelineStart + (activeEl.currentTime - active.sourceStart) / spd;
          const drift = Math.abs(videoTimelineTime - time);
          if (drift > opts.driftThresholdSec && Math.abs(time - this.lastCorrectiveSeekTimeline) >= DRIFT_SEEK_COOLDOWN_SEC) {
            activeEl.currentTime = tgt;
            this.lastCorrectiveSeekTimeline = time;
          }
        }

        if (activeEl.paused) {
          activeEl.play().catch(() => {});
        }
      }
    }

    this.attachVfc(active && !active.reverse ? activeEl : undefined, true);
    this.preRollUpcoming(upcoming, upcomingEl, activeEl);
  }

  pauseAll(): void {
    this.cancelVfc();
    this.getAssets().forEach((asset) => {
      if (asset.type !== 'video') return;
      if (asset.videoEl && !asset.videoEl.paused) asset.videoEl.pause();
      const sb = this.standby.get(asset.id);
      if (sb && !sb.paused) sb.pause();
    });
  }

  /** Releases standby elements and cancels callbacks (e.g. on "new project" or unmount). */
  reset(): void {
    this.cancelVfc();
    this.standby.forEach((el) => {
      el.pause();
      el.removeAttribute('src');
      el.load();
    });
    this.standby.clear();
    this.assignment.clear();
    this.lastActiveClipId = null;
    this.preRolledClipId = null;
    this.lastCorrectiveSeekTimeline = -Infinity;
  }
}
