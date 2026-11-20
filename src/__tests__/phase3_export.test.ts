import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColorSettings } from '../types/editor';
import {
  computeAudioTimestampUs,
  computeFrameTiming,
  exportProjectToMp4,
  seekAndSettleVideo,
} from '../utils/exporter';
import exporterSource from '../utils/exporter?raw';

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

describe('Phase 3 — Deterministic Frame-Accurate Offline WebCodecs Export', () => {
  const origWindow = globalThis.window;
  const origVideoEncoder = globalThis.VideoEncoder;
  const origVideoFrame = globalThis.VideoFrame;
  const origEncodedVideoChunk = globalThis.EncodedVideoChunk;
  const origOffscreenCanvas = globalThis.OffscreenCanvas;

  afterEach(() => {
    globalThis.window = origWindow;
    globalThis.VideoEncoder = origVideoEncoder;
    globalThis.VideoFrame = origVideoFrame;
    globalThis.EncodedVideoChunk = origEncodedVideoChunk;
    globalThis.OffscreenCanvas = origOffscreenCanvas;
  });

  it('produces exact zero-drift microsecond frame timings across 24, 30, 60, and 120 FPS', () => {
    for (const fps of [24, 30, 60, 120] as const) {
      const totalSeconds = 120;
      const totalFrames = fps * totalSeconds;
      let expectedNextTs = 0;

      for (let f = 0; f < Math.min(totalFrames, 500); f++) {
        const timing = computeFrameTiming(f, fps);
        expect(timing.timestampUs).toBe(expectedNextTs);
        expect(timing.durationUs).toBeGreaterThan(0);
        expectedNextTs = timing.timestampUs + timing.durationUs;
      }

      // Verify zero cumulative rounding drift at the 2-minute mark
      const endTiming = computeFrameTiming(totalFrames, fps);
      expect(endTiming.timestampUs).toBe(totalSeconds * 1_000_000);
      expect(endTiming.timeSec).toBeCloseTo(totalSeconds, 9);
    }

    // Audio chunk timestamp alignment at 48 kHz
    expect(computeAudioTimestampUs(0, 48000)).toBe(0);
    expect(computeAudioTimestampUs(48000, 48000)).toBe(1_000_000);
    expect(computeAudioTimestampUs(24000, 48000)).toBe(500_000);
  });

  it('waits for seeked + readyState >= 2 before resolving seekAndSettleVideo and aborts cleanly', async () => {
    const listeners = new Map<string, Set<() => void>>();
    let _currentTime = 0;
    const video = {
      muted: false,
      paused: false,
      seeking: false,
      readyState: 1,
      duration: 10,
      pause: vi.fn(function (this: { paused: boolean }) {
        this.paused = true;
      }),
      get currentTime() {
        return _currentTime;
      },
      set currentTime(val: number) {
        _currentTime = val;
        this.seeking = true;
      },
      addEventListener: vi.fn((type: string, cb: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(cb);
      }),
      removeEventListener: vi.fn((type: string, cb: () => void) => {
        listeners.get(type)?.delete(cb);
      }),
    };
    const emit = (type: string) => {
      listeners.get(type)?.forEach((cb) => cb());
    };

    // 1. Seek to 2.5s while readyState is still 1 (HAVE_METADATA)
    let resolved = false;
    const p1 = seekAndSettleVideo(video as unknown as HTMLVideoElement, 2.5).then(() => {
      resolved = true;
    });

    expect(video.muted).toBe(true);
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(_currentTime).toBe(2.5);

    // Fire seeked while readyState is still < 2 -> must NOT resolve yet!
    video.seeking = false;
    emit('seeked');
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Now frame data arrives -> readyState >= 2 -> must resolve!
    video.readyState = 2;
    emit('loadeddata');
    await p1;
    expect(resolved).toBe(true);

    // 2. AbortController cancels a pending seek immediately
    const ac = new AbortController();
    video.readyState = 1;
    const p2 = seekAndSettleVideo(video as unknown as HTMLVideoElement, 5.0, ac.signal);
    ac.abort();
    await expect(p2).rejects.toThrow('ยกเลิกการบันทึกแล้ว');
  });

  it('strictly forbids MediaRecorder and captureStream in exporter.ts', () => {
    // Strip comment lines before checking runtime code
    const codeOnly = exporterSource
      .split('\n')
      .filter((line: string) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n');

    expect(codeOnly).not.toContain('captureStream');
    expect(codeOnly).not.toContain('MediaRecorder');
    expect(codeOnly).toContain('OffscreenCanvas');
    expect(codeOnly).toContain('VideoEncoder');
    expect(codeOnly).toContain('VideoFrame');
    expect(codeOnly).toContain('OfflineAudioContext');
    expect(codeOnly).toContain('.close()');
    expect(codeOnly).toContain('.flush()');
  });

  it('fails explicitly instead of falling back to MediaRecorder when WebCodecs is unavailable', async () => {
    globalThis.window = {} as unknown as Window & typeof globalThis;
    const ac = new AbortController();

    await expect(
      exportProjectToMp4({
        clips: [],
        assets: new Map(),
        colors: TEST_COLORS,
        aspectRatio: '16:9',
        settings: { resolution: 720, fps: 30, bitrateMbps: 10 },
        totalDuration: 0.2,
        signal: ac.signal,
        onProgress: vi.fn(),
      })
    ).rejects.toThrow(/WebCodecs VideoEncoder/);
  });

  it('closes every VideoFrame immediately after encode, flushes encoder, and reports 0-100% progress', async () => {
    const encodedTimestamps: number[] = [];
    const encodedDurations: number[] = [];
    let closedFrameCount = 0;
    let flushed = false;
    let encoderClosed = false;

    class MockVideoFrame {
      timestamp: number;
      duration: number;
      closed = false;
      constructor(_src: unknown, init: { timestamp: number; duration?: number }) {
        this.timestamp = init.timestamp;
        this.duration = init.duration ?? 0;
      }
      close() {
        if (!this.closed) {
          this.closed = true;
          closedFrameCount++;
        }
      }
    }

    class MockEncodedVideoChunk {
      type: EncodedVideoChunkType;
      timestamp: number;
      duration: number;
      byteLength: number;
      private bytes: Uint8Array;
      constructor(init: { type: EncodedVideoChunkType; timestamp: number; duration: number; data: Uint8Array }) {
        this.type = init.type;
        this.timestamp = init.timestamp;
        this.duration = init.duration;
        this.bytes = init.data;
        this.byteLength = init.data.byteLength;
      }
      copyTo(dest: Uint8Array | ArrayBuffer) {
        const view = dest instanceof ArrayBuffer ? new Uint8Array(dest) : dest;
        view.set(this.bytes);
      }
    }

    class MockVideoEncoder {
      state: CodecState = 'unconfigured';
      encodeQueueSize = 0;
      private onOutput: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void;
      static async isConfigSupported() {
        return { supported: true };
      }
      constructor(init: { output: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void }) {
        this.onOutput = init.output;
      }
      configure() {
        this.state = 'configured';
      }
      encode(frame: MockVideoFrame, opts?: { keyFrame?: boolean }) {
        encodedTimestamps.push(frame.timestamp);
        encodedDurations.push(frame.duration);
        const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0x88]);
        const chunk = new MockEncodedVideoChunk({
          type: opts?.keyFrame ? 'key' : 'delta',
          timestamp: frame.timestamp,
          duration: frame.duration,
          data: bytes,
        }) as unknown as EncodedVideoChunk;
        const meta: EncodedVideoChunkMetadata | undefined = opts?.keyFrame
          ? {
              decoderConfig: {
                codec: 'avc1.640028',
                codedWidth: 640,
                codedHeight: 360,
                description: new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80]),
              },
            }
          : undefined;
        this.onOutput(chunk, meta);
      }
      async flush() {
        flushed = true;
      }
      close() {
        this.state = 'closed';
        encoderClosed = true;
      }
    }

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
          fillRect: vi.fn(),
          save: vi.fn(),
          restore: vi.fn(),
          drawImage: vi.fn(),
        };
      }
    }

    globalThis.EncodedVideoChunk = MockEncodedVideoChunk as unknown as typeof EncodedVideoChunk;
    globalThis.VideoEncoder = MockVideoEncoder as unknown as typeof VideoEncoder;
    globalThis.VideoFrame = MockVideoFrame as unknown as typeof VideoFrame;
    globalThis.OffscreenCanvas = MockOffscreenCanvas as unknown as typeof OffscreenCanvas;
    globalThis.window = {
      VideoEncoder: MockVideoEncoder,
      VideoFrame: MockVideoFrame,
    } as unknown as Window & typeof globalThis;

    const progressValues: number[] = [];
    const ac = new AbortController();

    const result = await exportProjectToMp4({
      clips: [],
      assets: new Map(),
      colors: TEST_COLORS,
      aspectRatio: '16:9',
      settings: { resolution: 480, fps: 30, bitrateMbps: 5 },
      totalDuration: 0.2, // 6 frames at 30fps
      signal: ac.signal,
      onProgress: (p) => progressValues.push(p.percent),
    });

    expect(result.engine).toBe('webcodecs');
    expect(result.blob.size).toBeGreaterThan(0);
    expect(encodedTimestamps).toHaveLength(6);
    expect(encodedTimestamps).toEqual([0, 33333, 66667, 100000, 133333, 166667]);
    expect(encodedDurations).toEqual([33333, 33334, 33333, 33333, 33334, 33333]);
    expect(closedFrameCount).toBe(6);
    expect(flushed).toBe(true);
    expect(encoderClosed).toBe(true);
    expect(progressValues[progressValues.length - 1]).toBe(100);
  });
});
