import type { ColorSettings, MediaAsset, TimelineClip, VideoKeyframe } from '../types/editor';
import { clamp } from './timecode';

export type Canvas2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type FrameProvider = (clip: TimelineClip) => CanvasImageSource | undefined;

export interface AssetDimensions {
  width: number;
  height: number;
}

let offCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
function getOffscreen(W: number, H: number): [HTMLCanvasElement | OffscreenCanvas, Canvas2DContext] {
  if (!offCanvas) {
    if (typeof document !== 'undefined') {
      offCanvas = document.createElement('canvas');
    } else {
      offCanvas = new OffscreenCanvas(W, H);
    }
  }
  if (offCanvas.width !== W || offCanvas.height !== H) {
    offCanvas.width = W;
    offCanvas.height = H;
  }
  const ctx = offCanvas.getContext('2d', { willReadFrequently: true }) as Canvas2DContext;
  return [offCanvas, ctx];
}

export function evalKeyframes(clip: TimelineClip, tLocal: number): VideoKeyframe {
  const kfs = clip.keyframes;
  if (!kfs || kfs.length === 0) {
    return { t: tLocal, x: clip.x, y: clip.y, scale: clip.scale, opacity: clip.opacity };
  }
  if (tLocal <= kfs[0].t) return kfs[0];
  if (tLocal >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1];
  for (let i = 0; i < kfs.length - 1; i++) {
    if (tLocal >= kfs[i].t && tLocal <= kfs[i + 1].t) {
      const p = (tLocal - kfs[i].t) / Math.max(0.001, kfs[i + 1].t - kfs[i].t);
      return {
        t: tLocal,
        x: kfs[i].x + (kfs[i + 1].x - kfs[i].x) * p,
        y: kfs[i].y + (kfs[i + 1].y - kfs[i].y) * p,
        scale: kfs[i].scale + (kfs[i + 1].scale - kfs[i].scale) * p,
        opacity: kfs[i].opacity + (kfs[i + 1].opacity - kfs[i].opacity) * p,
      };
    }
  }
  return kfs[0];
}

export function buildFilterString(colors: ColorSettings): string {
  let base = `brightness(${colors.brightness}%) contrast(${colors.contrast}%) saturate(${colors.saturation}%)`;
  if (colors.blur > 0) base += ` blur(${colors.blur}px)`;
  if (colors.lut === 'vivid') {
    base = `brightness(${colors.brightness}%) contrast(${Math.round(colors.contrast * 1.15)}%) saturate(${Math.round(colors.saturation * 1.35)}%)`;
    if (colors.blur > 0) base += ` blur(${colors.blur}px)`;
  } else if (colors.lut === 'warm') {
    base += ' sepia(0.25) saturate(115%)';
  } else if (colors.lut === 'matrix') {
    base += ' sepia(1) hue-rotate(75deg)';
  } else if (colors.lut === 'noir') {
    base += ' grayscale(1) contrast(115%)';
  }
  return base;
}

export function drawVisualLayer(
  ctx: Canvas2DContext,
  W: number,
  H: number,
  clip: TimelineClip,
  el: CanvasImageSource,
  srcW: number,
  srcH: number,
  time: number,
  colors: ColorSettings
) {
  if (!srcW || !srcH) return;
  const tLocal = time - clip.timelineStart;
  const kf = evalKeyframes(clip, tLocal);
  let alpha = kf.opacity / 100;
  let slideX = 0;

  if (clip.transition === 'fade' || clip.transition === 'dissolve') {
    if (tLocal < 0.45) alpha *= tLocal / 0.45;
    if (clip.duration - tLocal < 0.45) alpha *= (clip.duration - tLocal) / 0.45;
  } else if (clip.transition === 'slide' && tLocal < 0.45) {
    const ease = 1 - Math.pow(1 - tLocal / 0.45, 3);
    slideX = (1 - ease) * -W * 0.35;
  }

  const baseScale = Math.min(W / srcW, H / srcH) * (kf.scale / 100);
  const dw = srcW * baseScale;
  const dh = srcH * baseScale;

  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.globalCompositeOperation = clip.blend || 'source-over';
  ctx.translate(W / 2 + kf.x * (W / 1280) + slideX, H / 2 + kf.y * (H / 720));
  ctx.rotate((clip.rotation * Math.PI) / 180);
  ctx.scale(clip.flipH ? -1 : 1, clip.flipV ? -1 : 1);

  if (clip.mask === 'circle') {
    ctx.beginPath();
    ctx.arc(0, 0, Math.min(dw, dh) / 2, 0, Math.PI * 2);
    ctx.clip();
  } else if (clip.mask === 'rounded') {
    ctx.beginPath();
    ctx.roundRect(-dw / 2, -dh / 2, dw, dh, 28 * (Math.min(W, H) / 720));
    ctx.clip();
  }

  ctx.filter = buildFilterString(colors);

  const cp = clamp(clip.crop, 0, 45) / 100;
  ctx.drawImage(
    el,
    srcW * cp,
    srcH * cp,
    srcW * (1 - cp * 2),
    srcH * (1 - cp * 2),
    -dw / 2,
    -dh / 2,
    dw,
    dh
  );
  ctx.restore();
}

export function drawTextLayer(
  ctx: Canvas2DContext,
  W: number,
  H: number,
  clip: TimelineClip,
  time: number
) {
  const fx = clip.fxData;
  if (!fx || !fx.text) return;

  const tLocal = time - clip.timelineStart;
  const dur = clip.duration;
  const cx = (fx.x / 100) * W;
  const cy = (fx.y / 100) * H;
  const refScale = Math.min(W, H) / 720;
  const fontSize = Math.max(12, Math.round(fx.fontSize * refScale));

  let txt = fx.text;
  let alpha = 1;

  if (fx.anim === 'typewriter') {
    const len = Math.max(1, Math.floor((tLocal / Math.min(1.5, dur)) * txt.length));
    txt = txt.slice(0, len);
  } else if (fx.anim === 'pulse') {
    alpha = 0.65 + 0.35 * Math.sin(tLocal * 6);
  } else if (fx.anim === 'fade') {
    if (tLocal < 0.35) alpha = tLocal / 0.35;
    else if (dur - tLocal < 0.35) alpha = (dur - tLocal) / 0.35;
  }

  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${fontSize}px "Inter", "Noto Sans Thai", sans-serif`;

  if (fx.style === 'lowerthird') {
    const padX = 24 * refScale;
    const h = fontSize * 1.7;
    const w = ctx.measureText(txt).width + padX * 2;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.beginPath();
    ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 8 * refScale);
    ctx.fill();
    ctx.fillStyle = fx.bgColor;
    ctx.fillRect(cx - w / 2, cy - h / 2, 5 * refScale, h);
    ctx.fillStyle = '#18181b';
    ctx.fillText(txt, cx + 3 * refScale, cy);
  } else if (fx.style === 'badge') {
    const padX = 20 * refScale;
    const h = fontSize * 1.65;
    const w = ctx.measureText(txt).width + padX * 2;
    ctx.fillStyle = fx.bgColor;
    ctx.beginPath();
    ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 999);
    ctx.fill();
    ctx.fillStyle = fx.color;
    ctx.fillText(txt, cx, cy);
  } else if (fx.style === 'shape') {
    ctx.strokeStyle = fx.color;
    ctx.lineWidth = Math.max(2, 4 * refScale);
    ctx.strokeRect(cx - 150 * refScale, cy - 60 * refScale, 300 * refScale, 120 * refScale);
  } else if (fx.style === 'sticker') {
    ctx.font = `700 ${Math.round(fontSize * 1.2)}px "Inter", "Noto Sans Thai", sans-serif`;
    ctx.fillStyle = fx.color;
    ctx.fillText(`✨ ${txt} ✨`, cx, cy);
  } else if (fx.style === 'title') {
    ctx.font = `700 ${Math.round(fontSize * 1.25)}px "Inter", "Noto Sans Thai", sans-serif`;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 12 * refScale;
    ctx.fillStyle = fx.color;
    ctx.fillText(txt, cx, cy);
  } else {
    ctx.lineWidth = Math.max(2, 4 * refScale);
    ctx.strokeStyle = fx.bgColor;
    ctx.lineJoin = 'round';
    ctx.strokeText(txt, cx, cy);
    ctx.fillStyle = fx.color;
    ctx.fillText(txt, cx, cy);
  }

  ctx.restore();
}

export interface RenderOptions {
  /** Element that currently holds the frame for a video clip (double-buffered preview). Defaults to asset.videoEl. */
  videoSource?: (clip: TimelineClip) => HTMLVideoElement | undefined;
  /** Generic frame source provider (VideoFrame / ImageBitmap / OffscreenCanvas) for worker or WebCodecs decode. */
  frameProvider?: FrameProvider;
  /**
   * When true and the active video element has no decoded frame yet (e.g. mid-seek),
   * nothing is drawn so the canvas keeps the previous good frame instead of flashing black.
   */
  holdIfNotReady?: boolean;
}

export function isVideoFrameReady(el: HTMLVideoElement | undefined): boolean {
  return Boolean(el && el.readyState >= 2 && !el.seeking);
}

/** Returns false when the frame was skipped because the video source was not ready. */
export function renderCompositionFrame(
  ctx: Canvas2DContext,
  W: number,
  H: number,
  time: number,
  clips: TimelineClip[],
  assets: Map<string, MediaAsset | AssetDimensions>,
  colors: ColorSettings,
  showCenterGuides = false,
  opts: RenderOptions = {}
): boolean {
  const activeVideo = clips.find(
    (c) => c.track === 'video' && time >= c.timelineStart && time < c.timelineStart + c.duration
  );
  const videoAsset = activeVideo?.mediaId ? assets.get(activeVideo.mediaId) : undefined;
  const providedVideoFrame = activeVideo ? opts.frameProvider?.(activeVideo) : undefined;
  const mediaVideoAsset = videoAsset && 'videoEl' in videoAsset ? (videoAsset as MediaAsset) : undefined;
  const videoEl =
    activeVideo && !providedVideoFrame && mediaVideoAsset
      ? (opts.videoSource?.(activeVideo) ?? mediaVideoAsset.videoEl)
      : undefined;
  const videoReady = Boolean(providedVideoFrame) || isVideoFrameReady(videoEl);

  if (opts.holdIfNotReady && videoAsset && !videoReady) {
    return false;
  }

  ctx.fillStyle = '#0f1115';
  ctx.fillRect(0, 0, W, H);

  if (activeVideo && videoAsset) {
    const srcEl = providedVideoFrame ?? (videoEl && videoEl.readyState >= 2 ? videoEl : undefined);
    if (srcEl) {
      drawVisualLayer(ctx, W, H, activeVideo, srcEl, videoAsset.width, videoAsset.height, time, colors);
    }
  }

  // 2. Chroma Key (Green Screen)
  if (colors.chromaKey && activeVideo) {
    const [off, offCtx] = getOffscreen(W, H);
    offCtx.drawImage(ctx.canvas, 0, 0);
    const imgData = offCtx.getImageData(0, 0, W, H);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 1] > 105 && d[i + 1] > d[i] * 1.35 && d[i + 1] > d[i + 2] * 1.35) {
        d[i + 3] = 0;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    void off;
  }

  // 3. Image / Overlay Track
  const activeImages = clips.filter(
    (c) => c.track === 'image' && time >= c.timelineStart && time < c.timelineStart + c.duration
  );
  for (const imgClip of activeImages) {
    if (!imgClip.mediaId) continue;
    const asset = assets.get(imgClip.mediaId);
    if (!asset) continue;
    const providedImg = opts.frameProvider?.(imgClip);
    const mediaImg = 'imgEl' in asset ? (asset as MediaAsset).imgEl : undefined;
    const srcEl = providedImg ?? (mediaImg && mediaImg.complete ? mediaImg : undefined);
    if (srcEl) {
      drawVisualLayer(ctx, W, H, imgClip, srcEl, asset.width, asset.height, time, colors);
    }
  }

  // 4. Glitch Effect
  if (colors.glitch) {
    const [off, offCtx] = getOffscreen(W, H);
    offCtx.drawImage(ctx.canvas, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.38;
    const shift = Math.round(6 * (W / 1280));
    ctx.drawImage(off, -shift, 0);
    ctx.drawImage(off, shift, 0);
    ctx.restore();
  }

  // 5. Vignette
  if (colors.vignette > 0) {
    const grad = ctx.createRadialGradient(W / 2, H / 2, W * 0.25, W / 2, H / 2, W * 0.72);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(1, `rgba(0, 0, 0, ${colors.vignette / 100})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  // 6. Text / Subtitle Track
  const activeTexts = clips.filter(
    (c) => c.track === 'fx' && time >= c.timelineStart && time < c.timelineStart + c.duration
  );
  for (const txtClip of activeTexts) {
    drawTextLayer(ctx, W, H, txtClip, time);
  }

  // 7. Alignment Guides
  if (showCenterGuides) {
    ctx.save();
    ctx.strokeStyle = 'rgba(14, 165, 233, 0.8)';
    ctx.lineWidth = Math.max(1, Math.min(W, H) / 480);
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();
    ctx.restore();
  }
  return true;
}
