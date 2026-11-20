import type { MediaAsset, TimelineClip } from '../types/editor';
import { clipEnd, hasSeamlessNeighbor } from '../utils/clipTime';

/** Length of the micro-fade applied at hard cut points to avoid audible clicks. */
export const DECLICK_SEC = 0.005;

export interface EnvelopeOptions {
  declickIn: boolean;
  declickOut: boolean;
}

/** Gain of a clip at clip-local time `lt` (0..duration), including fades, keyframes and declick. */
export function clipGainAt(clip: TimelineClip, lt: number, opts: EnvelopeOptions): number {
  if (clip.muted) return 0;
  const norm = clip.normalizeGain ?? 1;
  let base = (clip.volume ?? 100) / 100;

  const kfs = clip.audioKeyframes?.length ? [...clip.audioKeyframes].sort((a, b) => a.t - b.t) : null;
  if (kfs) {
    // Implicit starting point at t=0 = clip volume, then ramp through keyframes, hold after the last.
    const pts = kfs[0].t > 0 ? [{ t: 0, gain: base }, ...kfs] : kfs;
    if (lt >= pts[pts.length - 1].t) base = pts[pts.length - 1].gain;
    else {
      for (let i = 0; i < pts.length - 1; i++) {
        if (lt >= pts[i].t && lt <= pts[i + 1].t) {
          const p = (lt - pts[i].t) / Math.max(1e-6, pts[i + 1].t - pts[i].t);
          base = pts[i].gain + (pts[i + 1].gain - pts[i].gain) * p;
          break;
        }
      }
    }
  }

  let g = base * norm;
  const d = clip.duration;
  if (clip.fadeIn > 0) g *= Math.min(1, Math.max(0, lt / clip.fadeIn));
  if (clip.fadeOut > 0) g *= Math.min(1, Math.max(0, (d - lt) / clip.fadeOut));
  if (opts.declickIn) g *= Math.min(1, Math.max(0, lt / DECLICK_SEC));
  if (opts.declickOut) g *= Math.min(1, Math.max(0, (d - lt) / DECLICK_SEC));
  return Math.max(0, g);
}

/** Sorted, de-duplicated breakpoints in [from, to] where the envelope changes slope. */
export function envelopeBreakpoints(clip: TimelineClip, from: number, to: number, opts: EnvelopeOptions): number[] {
  const d = clip.duration;
  const raw = [from, to];
  if (opts.declickIn) raw.push(DECLICK_SEC);
  if (opts.declickOut) raw.push(d - DECLICK_SEC);
  if (clip.fadeIn > 0) raw.push(clip.fadeIn);
  if (clip.fadeOut > 0) raw.push(d - clip.fadeOut);
  for (const k of clip.audioKeyframes || []) raw.push(k.t);
  // Fades multiplied by keyframe ramps are not linear: add intermediate samples inside fades.
  if (clip.audioKeyframes?.length) {
    for (let t = 0; t < clip.fadeIn; t += 0.05) raw.push(t);
    for (let t = d - clip.fadeOut; t < d; t += 0.05) raw.push(t);
  }
  return [...new Set(raw.filter((t) => t >= from - 1e-9 && t <= to + 1e-9).map((t) => Math.round(t * 1e6) / 1e6))].sort(
    (a, b) => a - b
  );
}

const reversedCache = new WeakMap<AudioBuffer, AudioBuffer>();
function getReversedBuffer(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const cached = reversedCache.get(buf);
  if (cached) return cached;
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
  }
  reversedCache.set(buf, out);
  return out;
}

export interface ScheduleParams {
  ctx: BaseAudioContext;
  destination: AudioNode;
  clip: TimelineClip;
  buffer: AudioBuffer;
  /** Timeline position that corresponds to context time `when`. */
  playFrom: number;
  /** Context time at which timeline position `playFrom` is heard. */
  when: number;
  allClips: TimelineClip[];
}

/**
 * Schedules one clip's audio on a (realtime or offline) AudioContext.
 * Shared by preview playback and export so both sound identical.
 */
export function scheduleClipAudio(p: ScheduleParams): AudioBufferSourceNode | null {
  const { ctx, destination, clip, buffer, playFrom, when, allClips } = p;
  if (playFrom >= clipEnd(clip) - 1e-4) return null;

  const spd = clip.speed || 1;
  const delay = Math.max(0, clip.timelineStart - playFrom);
  const offsetLt = Math.max(0, playFrom - clip.timelineStart);
  const remLt = clip.duration - offsetLt;
  if (remLt <= 0.002) return null;

  const srcBuf = clip.reverse ? getReversedBuffer(ctx, buffer) : buffer;
  const srcOffset = clip.reverse
    ? buffer.duration - (clip.sourceStart + clip.duration * spd) + offsetLt * spd
    : clip.sourceStart + offsetLt * spd;
  if (srcOffset >= srcBuf.duration) return null;

  const opts: EnvelopeOptions = {
    declickIn: !hasSeamlessNeighbor(clip, allClips, 'prev'),
    declickOut: !hasSeamlessNeighbor(clip, allClips, 'next'),
  };

  const src = ctx.createBufferSource();
  src.buffer = srcBuf;
  src.playbackRate.value = spd;
  const gain = ctx.createGain();
  const start = when + delay;
  const pts = envelopeBreakpoints(clip, offsetLt, clip.duration, opts);
  pts.forEach((lt, i) => {
    const v = clipGainAt(clip, lt, opts);
    const at = start + (lt - offsetLt);
    if (i === 0) gain.gain.setValueAtTime(v, at);
    else gain.gain.linearRampToValueAtTime(v, at);
  });

  src.connect(gain);
  gain.connect(destination);
  src.start(start, Math.max(0, srcOffset), remLt * spd);
  return src;
}

/** Clips whose audio should be heard: audio-track clips and un-muted video clips with decoded audio. */
export function audibleClips(clips: TimelineClip[], assets: Map<string, MediaAsset>): Array<[TimelineClip, AudioBuffer]> {
  const out: Array<[TimelineClip, AudioBuffer]> = [];
  for (const c of clips) {
    if ((c.track !== 'audio' && c.track !== 'video') || !c.mediaId) continue;
    const buf = assets.get(c.mediaId)?.audioBuffer;
    if (buf) out.push([c, buf]);
  }
  return out;
}

/** Above this size we skip whole-file audio decoding (memory); the <video> element plays audio instead. */
export const MAX_VIDEO_AUDIO_DECODE_BYTES = 1024 * 1024 * 1024;

const pendingDecodes = new WeakMap<MediaAsset, Promise<AudioBuffer | null>>();

/**
 * Decodes the audio track of a media asset into `asset.audioBuffer` (once).
 * Resolves null if the file has no audio / cannot be decoded / is too large.
 */
export function ensureAssetAudio(asset: MediaAsset, ctx: BaseAudioContext): Promise<AudioBuffer | null> {
  if (asset.audioBuffer) return Promise.resolve(asset.audioBuffer);
  if (asset.audioStatus === 'none') return Promise.resolve(null);
  const pending = pendingDecodes.get(asset);
  if (pending) return pending;
  if (asset.type === 'video' && asset.file.size > MAX_VIDEO_AUDIO_DECODE_BYTES) {
    asset.audioStatus = 'none';
    return Promise.resolve(null);
  }
  asset.audioStatus = 'pending';
  const job = asset.file
    .arrayBuffer()
    .then((ab) => ctx.decodeAudioData(ab))
    .then((buf) => {
      asset.audioBuffer = buf;
      asset.audioStatus = 'ready';
      return buf;
    })
    .catch(() => {
      asset.audioStatus = 'none';
      return null;
    })
    .finally(() => pendingDecodes.delete(asset));
  pendingDecodes.set(asset, job);
  return job;
}
