/**
 * Auto Proxy Generator (Phase 2.2)
 * Generates a lightweight 540p H.264 proxy with frequent keyframes (every 10 frames)
 * in OPFS (`proxy/<assetId>.mp4`) for high-resolution (>1080p) video assets.
 */

import { ArrayBufferTarget, FileSystemWritableFileStreamTarget, Muxer } from 'mp4-muxer';
import type { MediaAsset } from '../types/editor';
import { getOpfsFileHandle, opfsAvailable, opfsLoadFile } from '../storage/opfs';

const PROXY_TARGET_HEIGHT = 540;
const PROXY_FPS = 30;
const PROXY_BITRATE = 1_800_000;

export function shouldBuildAutoProxy(asset: MediaAsset): boolean {
  if (asset.type !== 'video') return false;
  // Auto-generate proxy for >1080p videos (2K/4K) or files > 80 MB
  return Math.max(asset.width, asset.height) > 1920 || asset.file.size > 80 * 1024 * 1024;
}

export async function generateVideoProxy(
  asset: MediaAsset,
  onStatus: (patch: Partial<MediaAsset>) => void
): Promise<string | null> {
  if (typeof window === 'undefined' || !('VideoEncoder' in window) || !('VideoFrame' in window)) {
    return null;
  }

  const relPath = `proxy/${asset.id}.mp4`;
  // Check if proxy already exists in OPFS
  const existing = await opfsLoadFile(relPath, `proxy_${asset.name}`, 'video/mp4');
  if (existing && existing.size > 0) {
    const url = URL.createObjectURL(existing);
    onStatus({ proxyUrl: url, proxyStatus: 'ready', proxyProgress: 100 });
    return url;
  }

  const aspect = Math.max(0.2, asset.width / Math.max(1, asset.height));
  const H = PROXY_TARGET_HEIGHT;
  const W = Math.max(2, Math.round((H * aspect) / 2) * 2);

  let supported = false;
  try {
    const sup = await VideoEncoder.isConfigSupported({
      codec: 'avc1.42001f',
      width: W,
      height: H,
      bitrate: PROXY_BITRATE,
      framerate: PROXY_FPS,
    });
    supported = Boolean(sup.supported);
  } catch {
    supported = false;
  }
  if (!supported) return null;

  onStatus({ proxyStatus: 'building', proxyProgress: 0 });

  const vid = document.createElement('video');
  vid.src = asset.url;
  vid.muted = true;
  vid.playsInline = true;
  vid.preload = 'auto';

  let writable: FileSystemWritableFileStream | null = null;
  let encoder: VideoEncoder | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      vid.onloadeddata = () => resolve();
      vid.onerror = () => reject(new Error('proxy load error'));
    });

    const dur = Math.min(asset.duration || vid.duration || 5, 180);
    const totalFrames = Math.max(1, Math.ceil(dur * PROXY_FPS));

    let memTarget: ArrayBufferTarget | null = null;
    let muxerTarget: ArrayBufferTarget | FileSystemWritableFileStreamTarget;

    if (opfsAvailable()) {
      try {
        const fh = await getOpfsFileHandle(relPath, true);
        writable = await fh.createWritable();
        muxerTarget = new FileSystemWritableFileStreamTarget(writable);
      } catch {
        writable = null;
      }
    }
    if (!writable) {
      memTarget = new ArrayBufferTarget();
      muxerTarget = memTarget;
    }

    const muxer = new Muxer({
      target: muxerTarget!,
      video: { codec: 'avc', width: W, height: H },
      fastStart: writable ? { expectedVideoChunks: totalFrames + 16 } : 'in-memory',
    });

    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: () => {},
    });

    encoder.configure({
      codec: 'avc1.42001f',
      width: W,
      height: H,
      bitrate: PROXY_BITRATE,
      framerate: PROXY_FPS,
      hardwareAcceleration: 'prefer-hardware',
    });

    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(W, H)
        : Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctx = canvas.getContext('2d', { alpha: false }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D;
    const frameDurationUs = Math.round(1_000_000 / PROXY_FPS);

    for (let f = 0; f < totalFrames; f++) {
      const targetT = Math.min(dur, f / PROXY_FPS);
      if (vid.seeking || Math.abs(vid.currentTime - targetT) >= 0.002 || vid.readyState < 2) {
        await new Promise<void>((resolve) => {
          const done = () => {
            vid.removeEventListener('seeked', done);
            resolve();
          };
          const timer = setTimeout(done, 300);
          vid.addEventListener(
            'seeked',
            () => {
              clearTimeout(timer);
              done();
            },
            { once: true }
          );
          vid.currentTime = targetT;
        });
      }

      ctx.drawImage(vid, 0, 0, W, H);
      const vf = new VideoFrame(canvas, {
        timestamp: f * frameDurationUs,
        duration: frameDurationUs,
      });
      try {
        // Frequent keyframe every 10 frames so scrubbing in Proxy mode is instant
        encoder.encode(vf, { keyFrame: f % 10 === 0 });
      } finally {
        vf.close();
      }

      while (encoder.encodeQueueSize > 12) {
        await new Promise((r) => setTimeout(r, 4));
      }

      if (f % 15 === 0) {
        onStatus({ proxyProgress: Math.round(((f + 1) / totalFrames) * 100) });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    await encoder.flush();
    muxer.finalize();
    if (writable) {
      await writable.close();
      writable = null;
    }

    const proxyFile =
      (await opfsLoadFile(relPath, `proxy_${asset.name}`, 'video/mp4')) ??
      (memTarget ? new File([memTarget.buffer], `proxy_${asset.name}`, { type: 'video/mp4' }) : null);

    if (!proxyFile) {
      onStatus({ proxyStatus: 'failed' });
      return null;
    }

    const proxyUrl = URL.createObjectURL(proxyFile);
    onStatus({ proxyUrl, proxyStatus: 'ready', proxyProgress: 100 });
    return proxyUrl;
  } catch {
    if (writable) await writable.abort().catch(() => {});
    onStatus({ proxyStatus: 'failed' });
    return null;
  } finally {
    if (encoder && encoder.state !== 'closed') {
      try {
        encoder.close();
      } catch {
        // ignore
      }
    }
    vid.pause();
    vid.removeAttribute('src');
    vid.load();
  }
}
