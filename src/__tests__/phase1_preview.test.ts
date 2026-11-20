import { afterEach, describe, expect, it, vi } from 'vitest';
import { RenderClient } from '../engine/RenderClient';
import { VideoSyncController } from '../engine/VideoSyncController';
import type { ColorSettings, MediaAsset, TimelineClip } from '../types/editor';

const TEST_COLORS: ColorSettings = {
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

function makeClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: 'c1',
    track: 'video',
    name: 'Clip 1',
    mediaId: 'm1',
    timelineStart: 0,
    duration: 5,
    sourceStart: 0,
    sourceDuration: 10,
    x: 0,
    y: 0,
    scale: 100,
    opacity: 100,
    rotation: 0,
    crop: 0,
    flipH: false,
    flipV: false,
    blend: 'source-over',
    mask: 'none',
    transition: 'none',
    speed: 1,
    reverse: false,
    muted: false,
    volume: 100,
    fadeIn: 0,
    fadeOut: 0,
    ...overrides,
  };
}

describe('Phase 1 — Flicker-Free OffscreenCanvas Double-Buffering & rVFC Preview', () => {
  const origOffscreenCanvas = globalThis.OffscreenCanvas;
  const origDocument = globalThis.document;

  afterEach(() => {
    globalThis.OffscreenCanvas = origOffscreenCanvas;
    globalThis.document = origDocument;
  });

  it('never clears or touches visible canvas while video.readyState < 2 or seeking, and blits atomically from OffscreenCanvas when ready', () => {
    const backCtxCalls: string[] = [];

    class MockOffscreenCanvas {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return {
          canvas: this,
          fillStyle: '',
          filter: 'none',
          globalAlpha: 1,
          globalCompositeOperation: 'source-over',
          fillRect: vi.fn(() => backCtxCalls.push('fillRect')),
          save: vi.fn(),
          restore: vi.fn(),
          translate: vi.fn(),
          rotate: vi.fn(),
          scale: vi.fn(),
          beginPath: vi.fn(),
          arc: vi.fn(),
          roundRect: vi.fn(),
          clip: vi.fn(),
          drawImage: vi.fn(() => backCtxCalls.push('drawImage')),
        };
      }
    }

    globalThis.OffscreenCanvas = MockOffscreenCanvas as unknown as typeof OffscreenCanvas;

    const visibleCtx = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    const videoEl = {
      readyState: 1,
      seeking: false,
      videoWidth: 1280,
      videoHeight: 720,
    } as unknown as HTMLVideoElement;

    const assets = new Map<string, MediaAsset>([
      [
        'm1',
        {
          id: 'm1',
          name: 'clip.mp4',
          type: 'video',
          file: new File([], 'clip.mp4'),
          url: 'blob:v1',
          duration: 10,
          width: 1280,
          height: 720,
          videoEl,
        },
      ],
    ]);

    const clips = [makeClip()];
    const client = new RenderClient(vi.fn());

    // 1. readyState < 2 -> MUST NOT wipe or draw onto visible canvas (retain previous valid frame)
    const drewNotReady = client.render({
      ctx: visibleCtx,
      width: 1280,
      height: 720,
      time: 1.0,
      isPlaying: true,
      clips,
      assets,
      colors: TEST_COLORS,
      showCenterGuides: false,
      videoSource: () => videoEl,
    });
    expect(drewNotReady).toBe(false);
    expect(visibleCtx.clearRect).not.toHaveBeenCalled();
    expect(visibleCtx.fillRect).not.toHaveBeenCalled();
    expect(visibleCtx.drawImage).not.toHaveBeenCalled();

    // 2. readyState >= 2 but seeking === true -> MUST NOT wipe or draw onto visible canvas
    (videoEl as unknown as { readyState: number; seeking: boolean }).readyState = 4;
    (videoEl as unknown as { readyState: number; seeking: boolean }).seeking = true;
    const drewSeeking = client.render({
      ctx: visibleCtx,
      width: 1280,
      height: 720,
      time: 1.0,
      isPlaying: true,
      clips,
      assets,
      colors: TEST_COLORS,
      showCenterGuides: false,
      videoSource: () => videoEl,
    });
    expect(drewSeeking).toBe(false);
    expect(visibleCtx.clearRect).not.toHaveBeenCalled();
    expect(visibleCtx.drawImage).not.toHaveBeenCalled();

    // 3. readyState >= 2 && !seeking -> composes onto OffscreenCanvas backbuffer, then single atomic blit to visible canvas
    (videoEl as unknown as { readyState: number; seeking: boolean }).seeking = false;
    const drewReady = client.render({
      ctx: visibleCtx,
      width: 1280,
      height: 720,
      time: 1.0,
      isPlaying: true,
      clips,
      assets,
      colors: TEST_COLORS,
      showCenterGuides: false,
      videoSource: () => videoEl,
    });
    expect(drewReady).toBe(true);
    expect(backCtxCalls).toContain('fillRect');
    expect(backCtxCalls).toContain('drawImage');
    expect(visibleCtx.clearRect).not.toHaveBeenCalled();
    expect(visibleCtx.fillRect).not.toHaveBeenCalled();
    expect(visibleCtx.drawImage).toHaveBeenCalledTimes(1);
    expect(visibleCtx.drawImage).toHaveBeenCalledWith(expect.any(MockOffscreenCanvas), 0, 0, 1280, 720);
  });

  it('pairs requestVideoFrameCallback with native video.play() and cancels cleanly on pauseAll()', () => {
    const vfcCallbacks: Array<(now: number, meta: unknown) => void> = [];
    const cancelVfcSpy = vi.fn();
    const makeVideo = () => ({
      src: 'blob:test',
      preload: 'auto',
      playsInline: true,
      muted: true,
      volume: 1,
      playbackRate: 1,
      paused: true,
      seeking: false,
      readyState: 4,
      duration: 10,
      currentTime: 0,
      play: vi.fn(function (this: { paused: boolean }) {
        this.paused = false;
        return Promise.resolve();
      }),
      pause: vi.fn(function (this: { paused: boolean }) {
        this.paused = true;
      }),
      load: vi.fn(),
      removeAttribute: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      requestVideoFrameCallback: vi.fn((cb: (now: number, meta: unknown) => void) => {
        vfcCallbacks.push(cb);
        return 42;
      }),
      cancelVideoFrameCallback: cancelVfcSpy,
    });

    const standby = makeVideo();
    globalThis.document = {
      createElement: vi.fn(() => standby),
    } as unknown as Document;

    const mainVideo = makeVideo();
    const assets = new Map<string, MediaAsset>([
      [
        'm1',
        {
          id: 'm1',
          name: 'clip.mp4',
          type: 'video',
          file: new File([], 'clip.mp4'),
          url: 'blob:test',
          duration: 10,
          width: 1280,
          height: 720,
          videoEl: mainVideo as unknown as HTMLVideoElement,
        },
      ],
    ]);

    const onFrameReady = vi.fn();
    const ctrl = new VideoSyncController(() => assets, onFrameReady);
    const clips = [makeClip()];

    ctrl.seekDiscrete(0, clips, true);
    expect(mainVideo.play).toHaveBeenCalledTimes(1);
    expect(mainVideo.requestVideoFrameCallback).toHaveBeenCalledTimes(1);

    // Simulate decoded video frame callback firing
    expect(vfcCallbacks).toHaveLength(1);
    vfcCallbacks[0](16.6, {});
    expect(onFrameReady).toHaveBeenCalledTimes(1);
    expect(mainVideo.requestVideoFrameCallback).toHaveBeenCalledTimes(2);

    // Pause cancels active rVFC handle cleanly
    ctrl.pauseAll();
    expect(cancelVfcSpy).toHaveBeenCalledWith(42);
  });
});
