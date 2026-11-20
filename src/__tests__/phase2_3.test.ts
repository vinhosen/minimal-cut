import { describe, expect, it } from 'vitest';
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import {
  openMp4Blob,
  sampleAtPresentationTime,
  sniffMp4,
  syncSampleBefore,
} from '../filmcraft/isobmff';
import { validateSampleBounds } from '../filmcraft/webcodecs';
import { exportToFcpxml } from '../filmcraft/api';
import { shouldBuildAutoProxy } from '../media/proxy';
import { buildFilterString, evalKeyframes } from '../utils/renderer';
import type { MediaAsset, TimelineClip } from '../types/editor';

function makeClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: 'c1',
    track: 'video',
    name: 'Clip 1',
    mediaId: 'm1',
    timelineStart: 0,
    duration: 4,
    sourceStart: 0,
    sourceDuration: 4,
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

describe('Phase 2 & 3 — FilmCraft ISO-BMFF demuxer, WebCodecs GOP math, Auto Proxy, and FCPXML', () => {
  it('sniffs and parses a muxed ISO-BMFF MP4 container and locates sync samples', async () => {
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width: 640, height: 360 },
      fastStart: 'in-memory',
    });

    // Minimal valid avcC decoderConfig record for H.264 Baseline L3.0
    const avcc = new Uint8Array([
      0x01, 0x42, 0x00, 0x1e, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0x00, 0x1e, 0x01, 0x00, 0x02, 0x68, 0xce,
    ]);
    const meta = {
      decoderConfig: {
        codec: 'avc1.42001e',
        codedWidth: 640,
        codedHeight: 360,
        description: avcc,
      },
    };

    // Add 6 synthetic video chunks (keyframe at 0 and 3)
    for (let i = 0; i < 6; i++) {
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x65, i]);
      muxer.addVideoChunkRaw(
        payload,
        i % 3 === 0 ? 'key' : 'delta',
        i * 33_333,
        33_333,
        i === 0 ? meta : undefined
      );
    }
    muxer.finalize();

    const mp4Bytes = new Uint8Array(target.buffer);
    expect(sniffMp4(mp4Bytes.subarray(0, 16))).toBe(true);

    const blob = new Blob([mp4Bytes], { type: 'video/mp4' });
    const parsed = await openMp4Blob(blob);
    expect(parsed).not.toBeNull();
    expect(parsed!.tracks.length).toBe(1);

    const vTrack = parsed!.tracks[0];
    expect(vTrack.kind).toBe('video');
    expect(vTrack.width).toBe(640);
    expect(vTrack.height).toBe(360);
    expect(vTrack.samples.length).toBe(6);
    expect(vTrack.entries[0].codecFamily).toBe('avc');
    expect(vTrack.entries[0].codecString).toBe('avc1.42001e');

    // Sync samples at index 0 and 3
    expect(vTrack.samples[0].isSync).toBe(true);
    expect(vTrack.samples[1].isSync).toBe(false);
    expect(vTrack.samples[3].isSync).toBe(true);
    expect(syncSampleBefore(vTrack, 2)).toBe(0);
    expect(syncSampleBefore(vTrack, 4)).toBe(3);

    // Sample lookup by presentation timestamp
    const s4Pts = vTrack.samples[4].pts;
    expect(sampleAtPresentationTime(vTrack, s4Pts)).toBe(4);
  });

  it('validates MP4 sample bounds against file length and max sample size', () => {
    expect(validateSampleBounds(100, 4096, 10000)).toBe(4096);
    expect(() => validateSampleBounds(9000, 2000, 10000)).toThrow(/past the end/);
    expect(() => validateSampleBounds(0, 128 * 1024 * 1024, 200 * 1024 * 1024)).toThrow(/larger than any picture/);
  });

  it('triggers Auto Proxy for >1080p (2K/4K) videos and skips small 720p/1080p clips', () => {
    const smallFile = new File([new Uint8Array(1024)], 'small.mp4', { type: 'video/mp4' });
    const hdAsset: MediaAsset = {
      id: 'v1',
      type: 'video',
      name: '1080p.mp4',
      url: 'blob:1',
      file: smallFile,
      duration: 5,
      width: 1920,
      height: 1080,
    };
    const uhdAsset: MediaAsset = {
      ...hdAsset,
      id: 'v2',
      name: '4k.mp4',
      width: 3840,
      height: 2160,
    };
    expect(shouldBuildAutoProxy(hdAsset)).toBe(false);
    expect(shouldBuildAutoProxy(uhdAsset)).toBe(true);
  });

  it('evaluates video keyframes and generates valid Final Cut Pro XML (.fcpxml)', () => {
    const clip = makeClip({
      keyframes: [
        { t: 0, x: 0, y: 0, scale: 100, opacity: 100 },
        { t: 2, x: 100, y: -50, scale: 150, opacity: 50 },
      ],
    });
    const mid = evalKeyframes(clip, 1);
    expect(mid.x).toBeCloseTo(50);
    expect(mid.y).toBeCloseTo(-25);
    expect(mid.scale).toBeCloseTo(125);
    expect(mid.opacity).toBeCloseTo(75);

    const filter = buildFilterString({
      lut: 'vivid',
      brightness: 100,
      contrast: 100,
      saturation: 100,
      blur: 4,
      vignette: 0,
      glitch: false,
      chromaKey: false,
      noiseReduce: false,
    });
    expect(filter).toContain('contrast(115%)');
    expect(filter).toContain('saturate(135%)');
    expect(filter).toContain('blur(4px)');

    const xml = exportToFcpxml({
      name: 'FilmCraft Test',
      fps: 60,
      width: 1920,
      height: 1080,
      totalDuration: 4,
      clips: [clip],
      assets: [
        {
          id: 'm1',
          type: 'video',
          name: 'Sample & Clip.mp4',
          url: 'blob:1',
          file: new File([], 'sample.mp4'),
          duration: 4,
          width: 1920,
          height: 1080,
        },
      ],
    });
    expect(xml).toContain('<fcpxml version="1.10">');
    expect(xml).toContain('FFVideoFormat1080p60');
    expect(xml).toContain('Sample &amp; Clip.mp4');
    expect(xml).toContain('<asset-clip name="Clip 1"');
  });
});
