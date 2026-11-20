import type { MediaAsset, TimelineClip } from '../types/editor';
import { clipEnd, clipSourceTime, findActiveClip, findNextClip, isSeamlessContinuation } from '../utils/clipTime';

/** How far ahead (seconds) we start preparing the next clip on a standby element. */
const LOOKAHEAD_SEC = 1.5;
/** While playing, only hard-seek when drift exceeds this; smaller drift is corrected via playbackRate. */
const HARD_SEEK_DRIFT_PLAYING = 0.35;
const SOFT_SYNC_DRIFT = 0.03;
const SCRUB_SEEK_DRIFT = 0.01;

/**
 * Drives <video> elements for preview playback.
 *
 * - Double buffering: every video asset gets a hidden standby element. The next clip after a hard
 *   cut is pre-seeked on a free element so the switch at the cut point needs no seek (no flicker).
 * - Soft sync: small drift between the master clock and the video is corrected by nudging
 *   playbackRate instead of seeking (seeking caused periodic stutter).
 * - When an asset's audio is decoded into an AudioBuffer, its elements are muted and audio is
 *   scheduled sample-accurately by the Web Audio engine instead.
 */
export class VideoSyncController {
  private assignment = new Map<string, HTMLVideoElement>();
  private standby = new Map<string, HTMLVideoElement>();
  private attached = new WeakSet<HTMLVideoElement>();
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

  private attach(el: HTMLVideoElement) {
    if (this.attached.has(el)) return;
    this.attached.add(el);
    el.preload = 'auto';
    el.addEventListener('seeked', this.onFrameReady);
    el.addEventListener('loadeddata', this.onFrameReady);
  }

  private elementsOf(asset: MediaAsset): HTMLVideoElement[] {
    if (!asset.videoEl) return [];
    this.attach(asset.videoEl);
    let sb = this.standby.get(asset.id);
    if (!sb) {
      sb = document.createElement('video');
      sb.src = asset.url;
      sb.playsInline = true;
      sb.muted = true;
      this.attach(sb);
      this.standby.set(asset.id, sb);
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

  sync(time: number, clips: TimelineClip[], playing: boolean, forceSeek: boolean) {
    const assets = this.getAssets();
    const active = findActiveClip(clips, 'video', time);
    const next = findNextClip(clips, 'video', active ? clipEnd(active) : time, active?.id);
    const upcoming = next && next.timelineStart - time <= LOOKAHEAD_SEC ? next : undefined;

    const keep = new Map<string, HTMLVideoElement>();
    const activeEl = active ? this.pick(active, keep) : undefined;
    if (active && activeEl) keep.set(active.id, activeEl);
    let upcomingEl: HTMLVideoElement | undefined;
    if (upcoming) {
      upcomingEl =
        active && activeEl && isSeamlessContinuation(active, upcoming) ? activeEl : this.pick(upcoming, keep);
      if (upcomingEl) keep.set(upcoming.id, upcomingEl);
    }
    this.assignment = keep;

    if (active && activeEl) {
      const asset = assets.get(active.mediaId!);
      this.driveActive(activeEl, active, asset, time, playing, forceSeek);
    }

    // Pre-roll the next clip after a hard cut: park it paused on its first frame.
    if (upcoming && upcomingEl && upcomingEl !== activeEl) {
      upcomingEl.muted = true;
      if (!upcomingEl.paused) upcomingEl.pause();
      const tgt = clipSourceTime(upcoming, upcoming.timelineStart);
      if (!upcomingEl.seeking && Math.abs(upcomingEl.currentTime - tgt) > 0.02) {
        upcomingEl.currentTime = tgt;
      }
    }

    const used = new Set(keep.values());
    assets.forEach((asset) => {
      if (asset.type !== 'video' || !asset.videoEl) return;
      for (const el of [asset.videoEl, this.standby.get(asset.id)]) {
        if (el && !used.has(el) && !el.paused) el.pause();
      }
    });
  }

  private driveActive(
    el: HTMLVideoElement,
    clip: TimelineClip,
    asset: MediaAsset | undefined,
    time: number,
    playing: boolean,
    forceSeek: boolean
  ) {
    const spd = clip.speed || 1;
    const duration = asset?.duration ?? el.duration;
    const tgt = Math.max(0, Math.min(clipSourceTime(clip, time), duration || Infinity));
    const audioFromBuffer = Boolean(asset?.audioBuffer);
    el.muted = audioFromBuffer || clip.muted || clip.reverse;
    el.volume = Math.min(1, Math.max(0, (clip.volume ?? 100) / 100));

    if (clip.reverse) {
      // Browsers cannot play backwards: step by seeking (Phase 3 decoder replaces this).
      if (!el.paused) el.pause();
      if (forceSeek || (!el.seeking && Math.abs(el.currentTime - tgt) > 0.015)) el.currentTime = tgt;
      return;
    }

    const drift = el.currentTime - tgt;
    const seekThreshold = playing ? HARD_SEEK_DRIFT_PLAYING : SCRUB_SEEK_DRIFT;
    if (forceSeek || Math.abs(drift) > seekThreshold) {
      if (forceSeek || !el.seeking) el.currentTime = tgt;
      el.playbackRate = spd;
    } else if (playing && Math.abs(drift) > SOFT_SYNC_DRIFT) {
      // Video ahead (drift > 0) → slow down slightly, behind → speed up slightly.
      el.playbackRate = spd * Math.min(1.1, Math.max(0.9, 1 - drift * 0.8));
    } else if (el.playbackRate !== spd) {
      el.playbackRate = spd;
    }

    if (playing && el.paused) el.play().catch(() => {});
    else if (!playing && !el.paused) el.pause();
  }

  pauseAll() {
    this.getAssets().forEach((asset) => {
      if (asset.videoEl && !asset.videoEl.paused) asset.videoEl.pause();
      const sb = this.standby.get(asset.id);
      if (sb && !sb.paused) sb.pause();
    });
  }

  /** Releases standby elements (e.g. on "new project"). */
  reset() {
    this.standby.forEach((el) => {
      el.pause();
      el.removeAttribute('src');
      el.load();
    });
    this.standby.clear();
    this.assignment.clear();
  }
}
