/**
 * FilmCraft WebCodecs GOP-Aware Hardware Video Decoder & Frame Cache
 * Ported from `storytold/filmcraft/apps/filmcraft-web/src/webcodecs.rs` (MIT OR Apache-2.0).
 *
 * - Opens H.264 (`avc`), HEVC (`hevc`), VP9 (`vp9`), and AV1 (`av1`) MP4/MOV files via `openMp4Blob`.
 * - Keeps a per-source decoded frame cache (`CACHE_FRAMES = 40`) evicting the frame furthest from `want`.
 * - Uses GOP-aware sync-sample seeking (`syncSampleBefore(i)`) with `LOOKAHEAD = 8` samples for B-frame reordering.
 * - Protects active decode sessions from thrash-restarts unless the target is reached or the session is idle > `STALE_MS`.
 */

import {
  type Mp4File,
  type Mp4Track,
  openMp4Blob,
  sampleAtPresentationTime,
  syncSampleBefore,
} from './isobmff';
import { secondsToTicks, ticksToRationalRound } from './time';

export const LOOKAHEAD = 8;
export const CACHE_FRAMES = 40;
export const MAX_QUEUE = 24;
export const STALE_MS = 2000.0;
export const MAX_SAMPLE_BYTES = 64 * 1024 * 1024;

let supportedFamilies: string[] = [];
let probed = false;
let nextSourceId = 1;
let totalSources = 0;
let totalFramesDecoded = 0;
let totalFallbacks = 0;
let closedFrames = 0;
let staleFrames = 0;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function validateSampleBounds(offset: number, size: number, fileLen: number): number {
  if (size <= 0 || size > MAX_SAMPLE_BYTES) {
    throw new Error('MP4 sample larger than any picture');
  }
  if (offset < 0 || offset + size > fileLen) {
    throw new Error('MP4 sample runs past the end of the file');
  }
  return size;
}

/** Probe which codec families (`avc`, `hevc`, `vp9`, `av1`) the browser decodes via WebCodecs. */
export async function probeWebCodecs(): Promise<string[]> {
  if (probed) return supportedFamilies;
  probed = true;
  if (typeof window === 'undefined' || !('VideoDecoder' in window)) {
    supportedFamilies = [];
    return supportedFamilies;
  }
  if (window.location?.search?.includes('nowebcodecs')) {
    supportedFamilies = [];
    return supportedFamilies;
  }
  const ok: string[] = [];
  const probes: Array<[string, string]> = [
    ['avc', 'avc1.640028'],
    ['hevc', 'hvc1.1.6.L120.90'],
    ['vp9', 'vp09.00.40.08'],
    ['av1', 'av01.0.08M.08'],
  ];
  for (const [family, codec] of probes) {
    try {
      const res = await VideoDecoder.isConfigSupported({
        codec,
        codedWidth: 1920,
        codedHeight: 1080,
      });
      if (res.supported) ok.push(family);
    } catch {
      // unsupported family
    }
  }
  supportedFamilies = ok;
  return supportedFamilies;
}

export function getSupportedFamilies(): string[] {
  return supportedFamilies;
}

interface DecoderSession {
  decoder: VideoDecoder;
  start: number;
  next: number;
  needsKey: boolean;
  flushing: boolean;
  errored: boolean;
  target: number;
  lastOutput: number;
  outMax: number;
  copying: number;
  generation: number;
  alive: boolean;
}

export class WcSource {
  readonly id: number;
  readonly blob: Blob;
  readonly file: Mp4File;
  readonly track: Mp4Track;
  readonly codecString: string;
  readonly description?: Uint8Array;
  private frames = new Map<number, ImageBitmap>();
  private failed = false;
  private session: DecoderSession | null = null;
  private feeding = false;
  private waiters = new Set<() => void>();
  private readonly onRepaint?: () => void;

  private constructor(
    id: number,
    blob: Blob,
    file: Mp4File,
    track: Mp4Track,
    codecString: string,
    description: Uint8Array | undefined,
    onRepaint?: () => void
  ) {
    this.id = id;
    this.blob = blob;
    this.file = file;
    this.track = track;
    this.codecString = codecString;
    this.description = description;
    this.onRepaint = onRepaint;
  }

  static async open(blob: Blob, onRepaint?: () => void): Promise<WcSource | null> {
    if (typeof window === 'undefined' || !('VideoDecoder' in window)) return null;
    const families = await probeWebCodecs();
    if (families.length === 0) return null;

    const mp4 = await openMp4Blob(blob);
    if (!mp4) return null;
    const vTrack = mp4.tracks.find((t) => t.kind === 'video' && t.samples.length > 0);
    if (!vTrack || vTrack.entries.length === 0) return null;
    const entry = vTrack.entries[0];
    if (!families.includes(entry.codecFamily)) return null;

    // Verify exact codec configuration before creating source
    try {
      const cfg: VideoDecoderConfig = {
        codec: entry.codecString,
        codedWidth: vTrack.width,
        codedHeight: vTrack.height,
        optimizeForLatency: true,
        description: entry.description,
      };
      const sup = await VideoDecoder.isConfigSupported(cfg);
      if (!sup.supported) return null;
    } catch {
      return null;
    }

    totalSources++;
    return new WcSource(
      nextSourceId++,
      blob,
      mp4,
      vTrack,
      entry.codecString,
      entry.description,
      onRepaint
    );
  }

  isFailed(): boolean {
    return this.failed;
  }

  private notifyWaiters(): void {
    for (const w of this.waiters) {
      try {
        w();
      } catch {
        // ignore
      }
    }
    this.waiters.clear();
    this.onRepaint?.();
  }

  private ensureSession(): DecoderSession | null {
    if (this.session && !this.session.errored && this.session.decoder.state !== 'closed') {
      return this.session;
    }
    try {
      const sess: DecoderSession = {
        decoder: null as unknown as VideoDecoder,
        start: 0,
        next: 0,
        needsKey: true,
        flushing: false,
        errored: false,
        target: Number.MIN_SAFE_INTEGER,
        lastOutput: nowMs(),
        outMax: Number.MIN_SAFE_INTEGER,
        copying: 0,
        generation: 1,
        alive: true,
      };

      const decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          const pts = frame.timestamp;
          const expectedGen = sess.generation;
          sess.copying++;
          createImageBitmap(frame)
            .then((bmp) => {
              frame.close();
              closedFrames++;
              sess.copying = Math.max(0, sess.copying - 1);
              if (!sess.alive || sess.generation !== expectedGen) {
                bmp.close();
                staleFrames++;
                return;
              }
              const old = this.frames.get(pts);
              if (old) old.close();
              this.frames.set(pts, bmp);
              sess.outMax = Math.max(sess.outMax, pts);
              sess.lastOutput = nowMs();
              totalFramesDecoded++;
              if (sess.outMax >= sess.target) {
                sess.target = Number.MIN_SAFE_INTEGER;
              }
              this.evictFarFrames(pts);
              this.notifyWaiters();
            })
            .catch(() => {
              frame.close();
              closedFrames++;
              sess.copying = Math.max(0, sess.copying - 1);
            });
        },
        error: () => {
          sess.errored = true;
          this.failed = true;
          totalFallbacks++;
          this.notifyWaiters();
        },
      });

      decoder.configure({
        codec: this.codecString,
        codedWidth: this.track.width,
        codedHeight: this.track.height,
        optimizeForLatency: true,
        description: this.description,
      });

      sess.decoder = decoder;
      this.session = sess;
      return sess;
    } catch {
      this.failed = true;
      totalFallbacks++;
      return null;
    }
  }

  private evictFarFrames(wantPts: number): void {
    while (this.frames.size > CACHE_FRAMES) {
      let farKey: number | null = null;
      let farDist = -1;
      for (const k of this.frames.keys()) {
        const dist = Math.abs(k - wantPts);
        if (dist > farDist) {
          farDist = dist;
          farKey = k;
        }
      }
      if (farKey === null) break;
      const bmp = this.frames.get(farKey);
      bmp?.close();
      this.frames.delete(farKey);
    }
  }

  private sampleIndexForTime(timeSec: number): { index: number; wantPts: number } {
    const t = this.track;
    const n = t.samples.length;
    const targetTicks = secondsToTicks(Math.max(0, timeSec));
    const targetPts = Number(ticksToRationalRound(targetTicks, 1, Math.max(1, t.timescale)));
    const index = Math.min(n - 1, Math.max(0, sampleAtPresentationTime(t, targetPts)));
    return { index, wantPts: t.samples[index].pts };
  }

  /**
   * Non-blocking frame lookup for interactive preview / scrubbing.
   * Returns the decoded `ImageBitmap` if cached, or starts decoding and returns `null`.
   */
  getCachedOrRequestFrame(timeSec: number): ImageBitmap | null {
    if (this.failed) return null;
    const { index, wantPts } = this.sampleIndexForTime(timeSec);
    const hit = this.frames.get(wantPts);
    if (hit) return hit;
    void this.drive(index, wantPts);
    return this.frames.get(wantPts) ?? null;
  }

  /**
   * Async frame-accurate lookup for offline export or pause-scrubbing.
   */
  async decodeFrameAt(timeSec: number, timeoutMs = 1800): Promise<ImageBitmap | null> {
    if (this.failed) return null;
    const { index, wantPts } = this.sampleIndexForTime(timeSec);
    const existing = this.frames.get(wantPts);
    if (existing) return existing;

    const deadline = nowMs() + timeoutMs;
    while (!this.failed && nowMs() < deadline) {
      await this.drive(index, wantPts);
      const hit = this.frames.get(wantPts);
      if (hit) return hit;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(onWake);
          resolve();
        }, 40);
        const onWake = () => {
          clearTimeout(timer);
          this.waiters.delete(onWake);
          resolve();
        };
        this.waiters.add(onWake);
      });

      const afterWait = this.frames.get(wantPts);
      if (afterWait) return afterWait;
    }
    return this.frames.get(wantPts) ?? null;
  }

  private async drive(sampleIdx: number, wantPts: number): Promise<void> {
    if (this.feeding || this.failed) return;
    const s = this.ensureSession();
    if (!s || s.errored || s.flushing) return;

    this.feeding = true;
    try {
      const t = this.track;
      const n = t.samples.length;
      const key = syncSampleBefore(t, sampleIdx);

      const covers =
        !s.needsKey &&
        s.start <= sampleIdx &&
        key <= s.next &&
        (sampleIdx >= s.next || wantPts > s.outMax);

      if (!covers) {
        const fresh = nowMs() - s.lastOutput < STALE_MS;
        const busy =
          fresh &&
          (s.copying > 0 || (!s.needsKey && s.target !== Number.MIN_SAFE_INTEGER && s.outMax < s.target));
        if (busy) return;

        if (!s.needsKey || s.next > 0) {
          s.generation++;
          s.decoder.reset();
          s.decoder.configure({
            codec: this.codecString,
            codedWidth: t.width,
            codedHeight: t.height,
            optimizeForLatency: true,
            description: this.description,
          });
        }
        s.start = key;
        s.next = key;
        s.needsKey = false;
        s.target = wantPts;
        s.outMax = Number.MIN_SAFE_INTEGER;
        s.lastOutput = nowMs();
      } else if (s.target === Number.MIN_SAFE_INTEGER) {
        s.target = wantPts;
      }

      const upto = Math.min(n - 1, sampleIdx + LOOKAHEAD);
      while (s.next <= upto && s.decoder.decodeQueueSize + s.copying < MAX_QUEUE) {
        const smp = t.samples[s.next];
        const sz = validateSampleBounds(smp.offset, smp.size, this.file.byteLength);
        const data = new Uint8Array(await this.blob.slice(smp.offset, smp.offset + sz).arrayBuffer());
        const chunk = new EncodedVideoChunk({
          type: smp.isSync || s.next === s.start ? 'key' : 'delta',
          timestamp: smp.pts,
          duration: smp.duration,
          data,
        });
        s.decoder.decode(chunk);
        s.next++;
      }

      if (s.next >= n && s.decoder.decodeQueueSize === 0 && !s.flushing) {
        s.flushing = true;
        s.needsKey = true;
        s.decoder
          .flush()
          .catch(() => {})
          .finally(() => {
            s.flushing = false;
            this.notifyWaiters();
          });
      }
    } catch {
      this.failed = true;
      totalFallbacks++;
    } finally {
      this.feeding = false;
    }
  }

  close(): void {
    if (this.session) {
      this.session.alive = false;
      this.session.generation++;
      if (this.session.decoder.state !== 'closed') {
        try {
          this.session.decoder.close();
        } catch {
          // ignore
        }
      }
      this.session = null;
    }
    this.frames.forEach((bmp) => bmp.close());
    this.frames.clear();
  }
}

export function webcodecsStats() {
  return {
    supportedFamilies,
    sources: totalSources,
    framesDecoded: totalFramesDecoded,
    fallbacks: totalFallbacks,
    closedFrames,
    staleFrames,
  };
}
