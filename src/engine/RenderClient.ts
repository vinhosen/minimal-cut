import type { ColorSettings, MediaAsset, TimelineClip } from '../types/editor';
import {
  type Canvas2DContext,
  isVideoFrameReady,
  renderCompositionFrame,
  type RenderOptions,
} from '../utils/renderer';
import { getSharedGpuCompositor } from '../filmcraft/gpuCompositor';
import { WcSource } from '../filmcraft/webcodecs';
import { clipSourceTime, findActiveClip } from '../utils/clipTime';

/**
 * Unified Flicker-Free Double-Buffered Render & WebCodecs Decode Coordinator.
 *
 * Phase 1 Guardrails:
 * - Double-buffers every frame onto an OffscreenCanvas (with HTMLCanvasElement fallback)
 *   before performing a single atomic blit onto the visible preview <canvas>.
 * - NEVER clears or wipes the visible <canvas> before verifying that the active video frame
 *   is ready (`video.readyState >= 2 && !video.seeking`) or a decoded WebCodecs frame exists.
 * - Retains the previous valid frame on the visible <canvas> during clip transitions/seeks.
 */
export class RenderClient {
  private wcSources = new Map<string, WcSource>();
  private openingIds = new Set<string>();
  private backbuffer: OffscreenCanvas | HTMLCanvasElement | null = null;
  private backbufferCtx: Canvas2DContext | null = null;
  private readonly onRepaint: () => void;

  constructor(onRepaint: () => void) {
    this.onRepaint = onRepaint;
  }

  private ensureBackbuffer(width: number, height: number): [OffscreenCanvas | HTMLCanvasElement, Canvas2DContext] | null {
    const w = Math.max(2, width);
    const h = Math.max(2, height);
    if (!this.backbuffer) {
      if (typeof OffscreenCanvas !== 'undefined') {
        this.backbuffer = new OffscreenCanvas(w, h);
      } else if (typeof document !== 'undefined') {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        this.backbuffer = c;
      } else {
        return null;
      }
      this.backbufferCtx = this.backbuffer.getContext('2d', { alpha: false }) as Canvas2DContext | null;
    } else if (this.backbuffer.width !== w || this.backbuffer.height !== h) {
      this.backbuffer.width = w;
      this.backbuffer.height = h;
    }
    if (!this.backbufferCtx) return null;
    return [this.backbuffer, this.backbufferCtx];
  }

  /** Register a video asset with the FilmCraft WebCodecs GOP decoder in the background. */
  registerAsset(asset: MediaAsset): void {
    if (asset.type !== 'video' || this.wcSources.has(asset.id) || this.openingIds.has(asset.id)) {
      return;
    }
    this.openingIds.add(asset.id);
    WcSource.open(asset.file, this.onRepaint)
      .then((src) => {
        if (src) {
          this.wcSources.set(asset.id, src);
        }
      })
      .catch(() => {})
      .finally(() => {
        this.openingIds.delete(asset.id);
      });
  }

  /** Decode a video asset's frame at `srcTimeSec` using WebCodecs `WcSource` (for frame-accurate export or reverse playback). */
  async decodeFrameForExport(asset: MediaAsset, srcTimeSec: number): Promise<CanvasImageSource | null> {
    let src = this.wcSources.get(asset.id);
    if (!src && !this.openingIds.has(asset.id)) {
      const opened = await WcSource.open(asset.file);
      if (opened) {
        this.wcSources.set(asset.id, opened);
        src = opened;
      }
    }
    if (!src || src.isFailed()) return null;
    // Clone bitmap so caller can close it without evicting our cache entry
    const cached = await src.decodeFrameAt(srcTimeSec);
    if (!cached) return null;
    try {
      return await createImageBitmap(cached);
    } catch {
      return null;
    }
  }

  /**
   * Double-buffered flicker-free render at timeline timestamp `time`.
   * Composes onto an OffscreenCanvas backbuffer first and blits atomically to the visible
   * canvas ONLY when the active video frame is verified ready (`readyState >= 2 && !seeking`).
   */
  render(params: {
    ctx: CanvasRenderingContext2D;
    width: number;
    height: number;
    time: number;
    isPlaying: boolean;
    clips: TimelineClip[];
    assets: Map<string, MediaAsset>;
    colors: ColorSettings;
    showCenterGuides: boolean;
    videoSource: (clip: TimelineClip) => HTMLVideoElement | undefined;
  }): boolean {
    const {
      ctx,
      width,
      height,
      time,
      isPlaying,
      clips,
      assets,
      colors,
      showCenterGuides,
      videoSource,
    } = params;

    const activeVideo = findActiveClip(clips, 'video', time);
    const videoAsset = activeVideo?.mediaId ? assets.get(activeVideo.mediaId) : undefined;

    // Use WebCodecs cached frame when scrubbing OR playing a reversed clip (no video.currentTime spam!)
    let cachedBitmap: ImageBitmap | null = null;
    if (activeVideo?.mediaId && (!isPlaying || activeVideo.reverse)) {
      const wc = this.wcSources.get(activeVideo.mediaId);
      if (wc && !wc.isFailed()) {
        const srcT = clipSourceTime(activeVideo, time);
        cachedBitmap = wc.getCachedOrRequestFrame(srcT);
      }
    }

    // Phase 1 Strict Guardrail: NEVER clear or touch the visible canvas unless the active video
    // frame is ready (`readyState >= 2 && !seeking`) or we have a decoded WebCodecs frame.
    const videoEl = activeVideo && !cachedBitmap ? videoSource(activeVideo) ?? videoAsset?.videoEl : undefined;
    if (activeVideo && videoAsset && !cachedBitmap && !isVideoFrameReady(videoEl)) {
      return false;
    }

    const bb = this.ensureBackbuffer(width, height);
    if (!bb) return false;
    const [backbuffer, backCtx] = bb;

    const opts: RenderOptions = {
      videoSource,
      holdIfNotReady: true,
      frameProvider: cachedBitmap
        ? (clip) => (clip.id === activeVideo?.id ? cachedBitmap ?? undefined : undefined)
        : undefined,
    };

    const gpu = getSharedGpuCompositor();
    const drawn = gpu
      ? gpu.renderFrame(backCtx, width, height, time, clips, assets, colors, showCenterGuides, opts)
      : renderCompositionFrame(backCtx, width, height, time, clips, assets, colors, showCenterGuides, opts);

    if (!drawn) {
      return false;
    }

    // Single atomic blit from OffscreenCanvas backbuffer to the visible preview <canvas>
    ctx.drawImage(backbuffer, 0, 0, width, height);
    return true;
  }

  reset(): void {
    this.wcSources.forEach((s) => s.close());
    this.wcSources.clear();
    this.openingIds.clear();
  }
}
