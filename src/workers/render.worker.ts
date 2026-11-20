import type { ColorSettings, TimelineClip } from '../types/editor';
import { type AssetDimensions, renderCompositionFrame } from '../utils/renderer';
import { FilmCraftGpuCompositor } from '../filmcraft/gpuCompositor';

export type RenderWorkerIncoming =
  | {
      type: 'init';
      canvas: OffscreenCanvas;
      width: number;
      height: number;
      useWebGl: boolean;
    }
  | {
      type: 'resize';
      width: number;
      height: number;
    }
  | {
      type: 'state';
      clips: TimelineClip[];
      colors: ColorSettings;
      assetDims: Array<[string, AssetDimensions]>;
    }
  | {
      type: 'frame';
      time: number;
      showGuides: boolean;
      frames: Array<[string, ImageBitmap]>;
    };

let offscreen: OffscreenCanvas | null = null;
let ctx2d: OffscreenCanvasRenderingContext2D | null = null;
let gpu: FilmCraftGpuCompositor | null = null;
let clips: TimelineClip[] = [];
let colors: ColorSettings = {
  lut: 'normal',
  brightness: 100,
  contrast: 100,
  saturation: 100,
  blur: 0,
  vignette: 0,
  glitch: false,
  chromaKey: false,
  noiseReduce: false,
};
let assetDims = new Map<string, AssetDimensions>();

self.onmessage = (e: MessageEvent<RenderWorkerIncoming>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    offscreen = msg.canvas;
    offscreen.width = msg.width;
    offscreen.height = msg.height;
    ctx2d = offscreen.getContext('2d', { alpha: false });
    if (msg.useWebGl) {
      try {
        const g = new FilmCraftGpuCompositor(msg.width, msg.height);
        if (g.isAvailable()) gpu = g;
      } catch {
        gpu = null;
      }
    }
  } else if (msg.type === 'resize') {
    if (offscreen) {
      offscreen.width = msg.width;
      offscreen.height = msg.height;
    }
  } else if (msg.type === 'state') {
    clips = msg.clips;
    colors = msg.colors;
    assetDims = new Map(msg.assetDims);
  } else if (msg.type === 'frame') {
    if (!offscreen || !ctx2d) {
      msg.frames.forEach(([, bmp]) => bmp.close());
      return;
    }
    const frameMap = new Map<string, ImageBitmap>(msg.frames);
    const opts = {
      frameProvider: (clip: TimelineClip) => (clip.mediaId ? frameMap.get(clip.mediaId) : undefined),
    };
    const W = offscreen.width;
    const H = offscreen.height;
    if (gpu) {
      gpu.renderFrame(ctx2d, W, H, msg.time, clips, assetDims, colors, msg.showGuides, opts);
    } else {
      renderCompositionFrame(ctx2d, W, H, msg.time, clips, assetDims, colors, msg.showGuides, opts);
    }
    frameMap.forEach((bmp) => bmp.close());
  }
};
