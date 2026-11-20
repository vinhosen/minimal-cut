import type { ColorSettings, MediaAsset, TimelineClip } from '../types/editor';
import { renderCompositionFrame, type RenderOptions } from '../utils/renderer';
import { getSharedGpuCompositor } from '../filmcraft/gpuCompositor';
import { WcSource } from '../filmcraft/webcodecs';
import { clipSourceTime, findActiveClip } from '../utils/clipTime';

/**
 * Unified FilmCraft Render & WebCodecs Decode Coordinator.
 *
 * - Manages per-asset `WcSource` (FilmCraft GOP-aware WebCodecs `VideoDecoder` + 40-frame LRU cache)
 *   for frame-accurate scrubbing and offline export without 180ms `<video>` seek timeouts.
 * - Uses `FilmCraftGpuCompositor` (WebGL2 linear-light shaders) when available, with automatic
 *   fallback to `renderCompositionFrame` (Canvas 2D) when `?cpu` is set or WebGL2 is unavailable.
 */
export class RenderClient {
  private wcSources = new Map<string, WcSource>();
  private openingIds = new Set<string>();
  private readonly onRepaint: () => void;

  constructor(onRepaint: () => void) {
    this.onRepaint = onRepaint;
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

  /** Decode a video asset's frame at `srcTimeSec` using WebCodecs `WcSource` (for frame-accurate export). */
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
   * Render a composition frame at `time`.
   * While scrubbing (`!isPlaying`), checks the FilmCraft `WcSource` decoded-frame cache first
   * for zero-flicker frame-accurate scrubbing, falling back to the double-buffered `<video>` element.
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

    let cachedBitmap: ImageBitmap | null = null;
    const activeVideo = findActiveClip(clips, 'video', time);
    if (!isPlaying && activeVideo?.mediaId) {
      const wc = this.wcSources.get(activeVideo.mediaId);
      if (wc && !wc.isFailed()) {
        const srcT = clipSourceTime(activeVideo, time);
        cachedBitmap = wc.getCachedOrRequestFrame(srcT);
      }
    }

    const opts: RenderOptions = {
      videoSource,
      holdIfNotReady: true,
      frameProvider: cachedBitmap
        ? (clip) => (clip.id === activeVideo?.id ? cachedBitmap ?? undefined : undefined)
        : undefined,
    };

    const gpu = getSharedGpuCompositor();
    if (gpu) {
      return gpu.renderFrame(ctx, width, height, time, clips, assets, colors, showCenterGuides, opts);
    }
    return renderCompositionFrame(ctx, width, height, time, clips, assets, colors, showCenterGuides, opts);
  }

  reset(): void {
    this.wcSources.forEach((s) => s.close());
    this.wcSources.clear();
    this.openingIds.clear();
  }
}
