import { describe, expect, it } from 'vitest';
import {
  frameAtTick,
  frameDuration,
  sampleDuration,
  secondsToTicks,
  snapSecondsToFrame,
  tickOfFrame,
  TICKS_PER_SECOND,
  ticksToRationalRound,
  ticksToSeconds,
} from '../filmcraft/time';
import {
  buildProjectSnapshot,
  clearAllRecoveryData,
  loadRecoverySnapshot,
  markRecoveryClean,
  RecoveryPolicy,
  saveRecoverySnapshot,
} from '../storage/projectDb';
import { opfsReadText, opfsWrite } from '../storage/opfs';
import { parseUrlFlags } from '../utils/capabilities';
import type { TimelineClip } from '../types/editor';

describe('Phase 1 — FilmCraft exact Tick time, OPFS recovery, and capabilities', () => {
  it('divides evenly into all standard broadcast frame rates and audio sample rates', () => {
    const rates = [
      { num: 24000, den: 1001 }, // 23.976
      { num: 24, den: 1 },
      { num: 25, den: 1 },
      { num: 30000, den: 1001 }, // 29.97
      { num: 30, den: 1 },
      { num: 50, den: 1 },
      { num: 60000, den: 1001 }, // 59.94
      { num: 60, den: 1 },
      { num: 120, den: 1 },
    ];
    for (const r of rates) {
      const numer = TICKS_PER_SECOND * BigInt(r.den);
      expect(numer % BigInt(r.num)).toBe(0n);
      const dur = frameDuration(r);
      expect(frameAtTick(tickOfFrame(100, r), r)).toBe(100n);
      expect(dur > 0n).toBe(true);
    }

    for (const sr of [8000, 16000, 22050, 44100, 48000, 96000, 192000]) {
      expect(TICKS_PER_SECOND % BigInt(sr)).toBe(0n);
      expect(sampleDuration(sr) * BigInt(sr)).toBe(TICKS_PER_SECOND);
    }

    expect(ticksToSeconds(secondsToTicks(2.5))).toBeCloseTo(2.5, 9);
    expect(snapSecondsToFrame(1.008, 60)).toBeCloseTo(60 / 60, 4);
    expect(ticksToRationalRound(TICKS_PER_SECOND, 1, 90000)).toBe(90000n);
  });

  it('implements FilmCraft RecoveryPolicy state machine accurately', () => {
    const policy = new RecoveryPolicy(5.0);
    // Clean when revision === savedRevision
    expect(policy.tick(0, 1, 1)).toEqual({ type: 'Nothing' });

    // First dirty tick writes snapshot immediately
    expect(policy.tick(10, 2, 1)).toEqual({ type: 'WriteSnapshot', revision: 2 });
    policy.written(2, true, 10.1);

    // Same revision does nothing
    expect(policy.tick(11, 2, 1)).toEqual({ type: 'Nothing' });

    // Next revision before interval wakes after remaining time
    const wake = policy.tick(12, 3, 1);
    expect(wake.type).toBe('WakeAfter');
    if (wake.type === 'WakeAfter') {
      expect(wake.seconds).toBeCloseTo(3.0, 2);
    }

    // After interval elapses, writes new snapshot
    expect(policy.tick(15.5, 3, 1)).toEqual({ type: 'WriteSnapshot', revision: 3 });
    policy.written(3, true, 15.6);

    // When project becomes clean (revision === savedRevision), writes clean meta
    expect(policy.tick(16, 3, 3)).toEqual({ type: 'WriteClean' });
    policy.cleaned(true, 16.1);
    expect(policy.tick(17, 3, 3)).toEqual({ type: 'Nothing' });
  });

  it('coalesces OPFS writes and round-trips project recovery snapshots', async () => {
    await clearAllRecoveryData();
    await opfsWrite('test/hello.txt', 'first');
    await opfsWrite('test/hello.txt', 'second');
    expect(await opfsReadText('test/hello.txt')).toBe('second');

    const sampleClip: TimelineClip = {
      id: 'c1',
      track: 'video',
      name: 'Intro.mp4',
      mediaId: 'm1',
      timelineStart: 0,
      duration: 5,
      sourceStart: 0,
      sourceDuration: 5,
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
    };

    const snap = buildProjectSnapshot({
      name: 'Demo',
      revision: 4,
      aspectRatio: '16:9',
      colors: {
        lut: 'normal',
        brightness: 100,
        contrast: 100,
        saturation: 100,
        blur: 0,
        vignette: 0,
        glitch: false,
        chromaKey: false,
        noiseReduce: false,
      },
      exportSettings: { resolution: 1080, fps: 60, bitrateMbps: 10 },
      assets: [],
      clips: [sampleClip],
    });

    await saveRecoverySnapshot(snap, true);
    const loaded = await loadRecoverySnapshot();
    expect(loaded).not.toBeNull();
    expect(loaded?.meta.dirty).toBe(true);
    expect(loaded?.snapshot.clips).toHaveLength(1);
    expect(loaded?.snapshot.clips[0].name).toBe('Intro.mp4');

    await markRecoveryClean();
    expect(await loadRecoverySnapshot()).toBeNull();
  });

  it('parses FilmCraft URL flags (?norecover, ?fresh, ?cpu, ?webgl, ?nowebcodecs)', () => {
    const flags = parseUrlFlags('?norecover&cpu&nowebcodecs');
    expect(flags.noRecover).toBe(true);
    expect(flags.cpu).toBe(true);
    expect(flags.noWebCodecs).toBe(true);
    expect(flags.fresh).toBe(false);
  });
});
