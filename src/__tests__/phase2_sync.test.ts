import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_LOOKAHEAD_SEC, AudioScheduler } from '../audio/AudioScheduler';
import { TimelineClock } from '../audio/TimelineClock';
import { VideoSyncController } from '../engine/VideoSyncController';
import type { MediaAsset, TimelineClip } from '../types/editor';

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

interface MockSourceNode {
  buffer: AudioBuffer | null;
  playbackRate: { value: number };
  onended: (() => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface MockGainNode {
  gain: {
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeMockAudioCtx(initialTime = 10) {
  const sources: MockSourceNode[] = [];
  const gains: MockGainNode[] = [];

  const ctx = {
    currentTime: initialTime,
    state: 'running' as AudioContextState,
    destination: {} as AudioDestinationNode,
    createBufferSource: vi.fn(() => {
      const node: MockSourceNode = {
        buffer: null,
        playbackRate: { value: 1 },
        onended: null,
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      sources.push(node);
      return node as unknown as AudioBufferSourceNode;
    }),
    createGain: vi.fn(() => {
      const node: MockGainNode = {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(node);
      return node as unknown as GainNode;
    }),
  };

  return { ctx: ctx as unknown as AudioContext & { currentTime: number }, sources, gains };
}

function makeMockVideoEl(initialTime = 0) {
  let _currentTime = initialTime;
  const setCurrentTimeSpy = vi.fn((val: number) => {
    _currentTime = val;
  });

  const el = {
    src: 'blob:test',
    preload: 'auto',
    playsInline: true,
    muted: false,
    volume: 1,
    playbackRate: 1,
    paused: true,
    seeking: false,
    readyState: 4,
    duration: 20,
    get currentTime() {
      return _currentTime;
    },
    set currentTime(val: number) {
      setCurrentTimeSpy(val);
    },
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
  };

  return { el: el as unknown as HTMLVideoElement & { _rawSetTime: (v: number) => void }, setCurrentTimeSpy, advanceRaw: (t: number) => { _currentTime = t; } };
}

describe('Phase 2 — Authoritative AudioContext Master Clock, Lookahead Scheduler, and Drift Slaving', () => {
  const originalDocument = globalThis.document;

  afterEach(() => {
    globalThis.document = originalDocument;
  });

  it('drives TimelineClock exclusively from AudioContext.currentTime', () => {
    const fakeCtx = { currentTime: 12.5, state: 'running' as AudioContextState };
    const clock = new TimelineClock();
    clock.attach(fakeCtx);

    expect(clock.isPlaying()).toBe(false);
    expect(clock.getCurrentTime()).toBe(0);

    clock.start(3.0);
    expect(clock.isPlaying()).toBe(true);
    expect(clock.getCurrentTime()).toBeCloseTo(3.0);
    expect(clock.timelineToContextTime(3.0)).toBeCloseTo(12.5);
    expect(clock.timelineToContextTime(3.15)).toBeCloseTo(12.65);

    // Advance AudioContext clock by 1.25s
    fakeCtx.currentTime = 13.75;
    expect(clock.getCurrentTime()).toBeCloseTo(4.25);

    // Pause freezes timeline time; advancing AudioContext does not move timeline
    const frozen = clock.pause();
    expect(frozen).toBeCloseTo(4.25);
    fakeCtx.currentTime = 20.0;
    expect(clock.getCurrentTime()).toBeCloseTo(4.25);

    // Discrete seek while paused and while playing
    clock.seek(1.5);
    expect(clock.getCurrentTime()).toBeCloseTo(1.5);
    clock.start(1.5);
    fakeCtx.currentTime = 20.5;
    expect(clock.getCurrentTime()).toBeCloseTo(2.0);
    clock.seek(6.0);
    expect(clock.getCurrentTime()).toBeCloseTo(6.0);
    fakeCtx.currentTime = 20.75;
    expect(clock.getCurrentTime()).toBeCloseTo(6.25);
  });

  it('schedules audio strictly inside the 150ms lookahead window and cleans up all nodes on stopAll()', () => {
    expect(AUDIO_LOOKAHEAD_SEC).toBeGreaterThanOrEqual(0.1);
    expect(AUDIO_LOOKAHEAD_SEC).toBeLessThanOrEqual(0.2);

    const { ctx, sources, gains } = makeMockAudioCtx(10.0);
    const clock = new TimelineClock();
    clock.attach(ctx);
    const scheduler = new AudioScheduler(clock);

    const fakeBuffer = { duration: 10, numberOfChannels: 2, length: 480000, sampleRate: 48000 } as AudioBuffer;
    const assets = new Map<string, MediaAsset>([
      [
        'm1',
        {
          id: 'm1',
          name: 'track.mp4',
          type: 'audio',
          file: new File([], 'track.mp4'),
          url: 'blob:audio',
          duration: 10,
          width: 0,
          height: 0,
          audioBuffer: fakeBuffer,
          audioStatus: 'ready',
        },
      ],
    ]);

    const c1 = makeClip({ id: 'c1', track: 'audio', timelineStart: 0.0, duration: 2.0 });
    const c2 = makeClip({ id: 'c2', track: 'audio', timelineStart: 2.0, duration: 2.0 });
    const clips = [c1, c2];

    clock.start(0.0);
    // At t = 0.0, horizon = 0.15s -> only c1 should be scheduled, NOT c2 (at 2.0s)
    const firstCount = scheduler.pump(ctx, ctx.destination, clips, assets);
    expect(firstCount).toBe(1);
    expect(sources).toHaveLength(1);
    expect(sources[0].start).toHaveBeenCalledWith(10.0, 0, 2.0);
    expect(scheduler.getActiveNodeCount()).toBe(1);

    // Repeated pump at t = 1.80s (horizon = 1.95s < 2.0s) -> still 0 new nodes (no duplicate c1)
    ctx.currentTime = 11.8;
    expect(scheduler.pump(ctx, ctx.destination, clips, assets)).toBe(0);
    expect(sources).toHaveLength(1);

    // At t = 1.90s (horizon = 2.05s >= 2.0s) -> c2 enters lookahead window and schedules at exact AudioContext time 12.0s
    ctx.currentTime = 11.9;
    expect(scheduler.pump(ctx, ctx.destination, clips, assets)).toBe(1);
    expect(sources).toHaveLength(2);
    expect(sources[1].start).toHaveBeenCalledWith(12.0, 0, 2.0);
    expect(scheduler.getActiveNodeCount()).toBe(2);

    // Immediate stop & disconnect on pause/scrub/unmount
    scheduler.stopAll();
    expect(scheduler.getActiveNodeCount()).toBe(0);
    for (const s of sources) {
      expect(s.stop).toHaveBeenCalledTimes(1);
      expect(s.disconnect).toHaveBeenCalledTimes(1);
    }
    for (const g of gains) {
      expect(g.disconnect).toHaveBeenCalledTimes(1);
    }
  });

  it('slaves video drift to AudioContext master clock with 80ms threshold, mutes <video>, and avoids steady-state seeks', () => {
    const standbyVideo = makeMockVideoEl(0);
    globalThis.document = {
      createElement: vi.fn(() => standbyVideo.el),
    } as unknown as Document;

    const mainVideo = makeMockVideoEl(0);
    const assets = new Map<string, MediaAsset>([
      [
        'm1',
        {
          id: 'm1',
          name: 'clip.mp4',
          type: 'video',
          file: new File([], 'clip.mp4'),
          url: 'blob:test',
          duration: 20,
          width: 1920,
          height: 1080,
          videoEl: mainVideo.el,
        },
      ],
    ]);

    const c1 = makeClip({ id: 'c1', timelineStart: 0, duration: 5, sourceStart: 0 });
    const c2 = makeClip({ id: 'c2', timelineStart: 5, duration: 5, sourceStart: 10 });
    const clips = [c1, c2];

    const ctrl = new VideoSyncController(() => assets, vi.fn());
    const phase2Opts = { driftThresholdSec: 0.08, alwaysMuteVideo: true };

    // 1. Discrete play start at t = 0
    ctrl.seekDiscrete(0, clips, true, phase2Opts);
    expect(mainVideo.el.muted).toBe(true);
    expect(mainVideo.el.play).toHaveBeenCalledTimes(1);
    mainVideo.setCurrentTimeSpy.mockClear();

    // 2. Steady-state playback with 50ms drift (<= 80ms threshold) -> MUST NOT seek video.currentTime
    mainVideo.advanceRaw(1.05);
    ctrl.updatePlayback(1.0, clips, phase2Opts);
    expect(mainVideo.setCurrentTimeSpy).not.toHaveBeenCalled();

    // 3. Drift grows to 120ms (> 80ms threshold) -> MUST issue a single corrective seek
    mainVideo.advanceRaw(1.32);
    ctrl.updatePlayback(1.2, clips, phase2Opts);
    expect(mainVideo.setCurrentTimeSpy).toHaveBeenCalledTimes(1);
    expect(mainVideo.setCurrentTimeSpy).toHaveBeenLastCalledWith(1.2);

    // 4. Cooldown suppresses back-to-back corrective seeks within 250ms
    mainVideo.advanceRaw(1.45);
    ctrl.updatePlayback(1.3, clips, phase2Opts);
    expect(mainVideo.setCurrentTimeSpy).toHaveBeenCalledTimes(1);

    // 5. Clip-to-clip boundary transition at t = 5.0 (hard cut to sourceStart = 10)
    ctrl.updatePlayback(5.0, clips, phase2Opts);
    const activeElAtCut = ctrl.elementFor(c2);
    expect(activeElAtCut?.muted).toBe(true);
    expect(activeElAtCut?.currentTime).toBeCloseTo(10.0);
  });

  it('does not permanently latch preRolledClipId while standby is seeking, and retries once ready', () => {
    const standbyVideo = makeMockVideoEl(0);
    globalThis.document = {
      createElement: vi.fn(() => standbyVideo.el),
    } as unknown as Document;

    const mainVideo = makeMockVideoEl(0);
    const assets = new Map<string, MediaAsset>([
      [
        'm1',
        {
          id: 'm1',
          name: 'clip.mp4',
          type: 'video',
          file: new File([], 'clip.mp4'),
          url: 'blob:test',
          duration: 20,
          width: 1920,
          height: 1080,
          videoEl: mainVideo.el,
        },
      ],
    ]);

    const c1 = makeClip({ id: 'c1', timelineStart: 0, duration: 5, sourceStart: 0 });
    const c2 = makeClip({ id: 'c2', timelineStart: 5, duration: 5, sourceStart: 12 });
    const clips = [c1, c2];
    const ctrl = new VideoSyncController(() => assets, vi.fn());

    // Enter lookahead window (t = 4.0 -> 1.0s before c2) while standby is still seeking
    (standbyVideo.el as unknown as { seeking: boolean }).seeking = true;
    ctrl.seekDiscrete(4.0, clips, true, { driftThresholdSec: 0.08, alwaysMuteVideo: true });
    expect(standbyVideo.setCurrentTimeSpy).not.toHaveBeenCalled();

    // Standby finishes seeking -> next playback tick MUST retry and pre-roll c2 to sourceStart = 12
    (standbyVideo.el as unknown as { seeking: boolean }).seeking = false;
    mainVideo.advanceRaw(4.1);
    ctrl.updatePlayback(4.1, clips, { driftThresholdSec: 0.08, alwaysMuteVideo: true });
    expect(standbyVideo.setCurrentTimeSpy).toHaveBeenCalledTimes(1);
    expect(standbyVideo.setCurrentTimeSpy).toHaveBeenLastCalledWith(12);
  });
});
