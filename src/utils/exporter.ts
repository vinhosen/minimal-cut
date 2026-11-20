/**
 * Deterministic Frame-Accurate Offline WebCodecs MP4 Export Pipeline (Phase 3).
 *
 * Strict Guardrails:
 * - NEVER uses `canvas.captureStream()` or `MediaRecorder` for video export.
 * - Steps offline frame-by-frame by exact non-drifting microsecond intervals:
 *   `dt = 1 / fps`, `timestampUs = Math.round(frameIndex * (1_000_000 / fps))`.
 * - Awaits explicit seek + decode completion (`seeked` + `readyState >= 2` + frame settle)
 *   on dedicated full-resolution export `<video>` elements (immune to Proxy Mode & preview side-effects)
 *   before compositing onto a dedicated `OffscreenCanvas`.
 * - Immediately calls `.close()` on every `VideoFrame`, `AudioData`, and decoded override frame.
 * - Renders timeline audio offline via `OfflineAudioContext`, encodes AAC `AudioData` aligned
 *   to the same microsecond epoch (safely handling platform AAC negative priming timestamps),
 *   flushes both encoders, and finalizes `mp4-muxer` inside a unified abort/cleanup lifecycle.
 */

import { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } from 'mp4-muxer';
import type { AspectRatio, ColorSettings, ExportSettings, MediaAsset, TimelineClip } from '../types/editor';
import { getCanvasDimensions } from './timecode';
import { renderCompositionFrame, type Canvas2DContext, type FrameProvider } from './renderer';
import { clipSourceTime, findActiveClip } from './clipTime';
import { audibleClips, ensureAssetAudio, scheduleClipAudio } from '../audio/scheduleClipAudio';
import { getOpfsFileHandle, getStorageEstimate, opfsAvailable, opfsRemove } from '../storage/opfs';

export interface ExportProgress {
  percent: number;
  message: string;
  currentFrame: number;
  totalFrames: number;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  engine: 'webcodecs';
  /** True when the file was already written to a user-picked FileSystemFileHandle via showSaveFilePicker. */
  savedDirectly?: boolean;
  /** Optional cleanup callback (e.g. deletes temporary OPFS export file after download). */
  cleanup?: () => Promise<void>;
}

export interface FrameTiming {
  /** Timeline position in seconds (`frameIndex * (1 / fps)`). */
  timeSec: number;
  /** Exact presentation timestamp in microseconds (`Math.round(frameIndex * (1_000_000 / fps))`). */
  timestampUs: number;
  /** Exact frame duration in microseconds (`nextTimestampUs - timestampUs`) with zero cumulative drift. */
  durationUs: number;
}

/** Computes exact, zero-drift microsecond timing for frame `frameIndex` at `fps`. */
export function computeFrameTiming(frameIndex: number, fps: number): FrameTiming {
  const dt = 1 / fps;
  const timestampUs = Math.round(frameIndex * (1_000_000 / fps));
  const nextTimestampUs = Math.round((frameIndex + 1) * (1_000_000 / fps));
  return {
    timeSec: frameIndex * dt,
    timestampUs,
    durationUs: Math.max(1, nextTimestampUs - timestampUs),
  };
}

/** Computes exact audio chunk microsecond timestamp aligned to the video timeline epoch. */
export function computeAudioTimestampUs(sampleOffset: number, sampleRate: number): number {
  return Math.round((sampleOffset / sampleRate) * 1_000_000);
}

/**
 * Prompt the user with File System Access API (`showSaveFilePicker`) if supported and requested.
 * Must be called synchronously inside the click gesture before awaiting other promises.
 */
export async function tryPickExportSaveHandle(suggestedName: string): Promise<FileSystemFileHandle | null> {
  if (typeof window === 'undefined' || !('showSaveFilePicker' in window)) return null;
  try {
    const picker = (
      window as unknown as {
        showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle>;
      }
    ).showSaveFilePicker;
    return await picker({
      suggestedName,
      types: [
        {
          description: 'MP4 Video',
          accept: { 'video/mp4': ['.mp4'] },
        },
      ],
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('ยกเลิกการเลือกไฟล์สำหรับบันทึก');
    }
    return null;
  }
}

type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, metadata: unknown) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/** Wait until a newly created export `<video>` element has loaded metadata (`readyState >= 1`). */
function waitForVideoMetadata(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error('ยกเลิกการบันทึกแล้ว'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
    };
    const onReady = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('ไม่สามารถโหลดไฟล์วิดีโอต้นฉบับสำหรับการ Export ได้'));
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('ยกเลิกการบันทึกแล้ว'));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      if (video.readyState >= 1) resolve();
      else reject(new Error('หมดเวลารอโหลดข้อมูลเมตาดาตาของวิดีโอสำหรับการ Export'));
    }, 5000);

    signal?.addEventListener('abort', onAbort, { once: true });
    video.addEventListener('loadedmetadata', onReady);
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('error', onError);
  });
}

/**
 * Explicitly seeks a paused `HTMLVideoElement` to `targetTime` and waits for:
 * 1. Metadata readiness (`readyState >= 1`)
 * 2. `seeked` event completion
 * 3. `video.readyState >= 2 && !video.seeking` (`loadeddata`/`canplay` if needed)
 * 4. Frame decode/compositor settle (`requestVideoFrameCallback` if fired during paused seek,
 *    or `requestAnimationFrame` raced with a short background-tab-safe timer so hidden tabs never stall).
 * Rejects instead of silently baking a black frame if `readyState < 2` at timeout.
 */
export async function seekAndSettleVideo(
  video: HTMLVideoElement,
  targetTime: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    throw new Error('ยกเลิกการบันทึกแล้ว');
  }

  video.muted = true;
  if (!video.paused) video.pause();

  if (video.readyState < 1) {
    await waitForVideoMetadata(video, signal);
  }

  const maxSeekable =
    Number.isFinite(video.duration) && video.duration > 0 ? Math.max(0, video.duration - 1e-4) : targetTime;
  const clamped = Math.max(0, Math.min(targetTime, maxSeekable));

  const alreadyAtTarget = !video.seeking && Math.abs(video.currentTime - clamped) < 0.001;
  if (alreadyAtTarget && video.readyState >= 2) {
    return;
  }

  return new Promise((resolve, reject) => {
    const v = video as VideoWithRVFC;
    let settled = false;
    let seekedDone = alreadyAtTarget;
    let vfcFired = false;
    let vfcHandle: number | null = null;
    let rafHandle: number | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadeddata', onDataReady);
      video.removeEventListener('canplay', onDataReady);
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(safetyTimer);
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      if (vfcHandle !== null && typeof v.cancelVideoFrameCallback === 'function') {
        try {
          v.cancelVideoFrameCallback(vfcHandle);
        } catch {
          // ignore
        }
        vfcHandle = null;
      }
      if (rafHandle !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
    };

    const finishOk = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => {
      fail(new Error('ยกเลิกการบันทึกแล้ว'));
    };

    const waitForFrameSettle = () => {
      if (settled || !seekedDone || video.seeking || video.readyState < 2) return;
      if (vfcFired) {
        finishOk();
        return;
      }
      // Prevent duplicate rAF / settle timer handles if both seeked and loadeddata fire
      if (rafHandle !== null || settleTimer !== null) return;

      const isHiddenTab = typeof document !== 'undefined' && document.hidden;
      if (!isHiddenTab && typeof requestAnimationFrame === 'function') {
        rafHandle = requestAnimationFrame(() => {
          rafHandle = null;
          finishOk();
        });
        // Short fallback timer prevents 2.5s stall if user switches to another tab mid-frame
        settleTimer = setTimeout(() => {
          settleTimer = null;
          finishOk();
        }, 50);
      } else {
        settleTimer = setTimeout(() => {
          settleTimer = null;
          finishOk();
        }, 16);
      }
    };

    const onSeeked = () => {
      seekedDone = true;
      if (!video.seeking && video.readyState >= 2) {
        waitForFrameSettle();
      }
    };

    const onDataReady = () => {
      if (seekedDone && !video.seeking && video.readyState >= 2) {
        waitForFrameSettle();
      }
    };

    // Register rVFC BEFORE mutating currentTime so browsers that fire rVFC on paused seek latch immediately.
    if (typeof v.requestVideoFrameCallback === 'function') {
      try {
        vfcHandle = v.requestVideoFrameCallback(() => {
          vfcHandle = null;
          vfcFired = true;
          if (seekedDone && !video.seeking && video.readyState >= 2) {
            finishOk();
          }
        });
      } catch {
        vfcHandle = null;
      }
    }

    const safetyTimer = setTimeout(() => {
      if (video.readyState >= 2) {
        finishOk();
      } else {
        fail(new Error(`หมดเวลารอถอดรหัสเฟรมวิดีโอที่เวลา ${clamped.toFixed(2)}s (readyState=${video.readyState})`));
      }
    }, 2500);

    signal?.addEventListener('abort', onAbort, { once: true });
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('loadeddata', onDataReady);
    video.addEventListener('canplay', onDataReady);

    if (!alreadyAtTarget) {
      video.currentTime = clamped;
    } else if (!video.seeking && video.readyState >= 2) {
      waitForFrameSettle();
    }
  });
}

interface SupportedVideoEncoderConfig {
  codec: string;
  hardwareAcceleration: HardwareAcceleration;
  latencyMode: LatencyMode;
}

async function pickSupportedVideoConfig(
  width: number,
  height: number,
  bitrate: number,
  fps: number
): Promise<SupportedVideoEncoderConfig | null> {
  if (typeof window === 'undefined' || !('VideoEncoder' in window) || !('VideoFrame' in window)) {
    return null;
  }

  const codecs = [
    'avc1.640034', // H.264 High L5.2 (4K60 / 1080p120)
    'avc1.640032', // H.264 High L5.0 (4K30)
    'avc1.64002a', // H.264 High L4.2 (1080p60)
    'avc1.640028', // H.264 High L4.0 (1080p30)
    'avc1.4d002a', // H.264 Main L4.2
    'avc1.42001f', // H.264 Baseline L3.1
    'avc1.42E01E',
  ];
  // Prefer `latencyMode: 'realtime'` so H.264 encoders disable B-frame reordering and emit
  // strictly monotonic DTS===PTS timestamps compatible with mp4-muxer.
  const latencyModes: LatencyMode[] = ['realtime', 'quality'];
  const accelModes: HardwareAcceleration[] = ['prefer-hardware', 'no-preference', 'prefer-software'];

  for (const latencyMode of latencyModes) {
    for (const hardwareAcceleration of accelModes) {
      for (const codec of codecs) {
        try {
          const res = await VideoEncoder.isConfigSupported({
            codec,
            width,
            height,
            bitrate,
            framerate: fps,
            hardwareAcceleration,
            latencyMode,
          });
          if (res.supported) {
            return { codec, hardwareAcceleration, latencyMode };
          }
        } catch {
          // try next candidate
        }
      }
    }
  }
  return null;
}

interface SupportedAudioEncoderConfig {
  encoderCodec: string;
  muxerCodec: 'aac' | 'opus';
  bitrate?: number;
  label: string;
}

async function pickSupportedAudioConfig(
  sampleRate = 48000,
  numberOfChannels = 2
): Promise<SupportedAudioEncoderConfig | null> {
  if (typeof window === 'undefined' || !('AudioEncoder' in window) || !('AudioData' in window)) {
    return null;
  }

  const candidates: SupportedAudioEncoderConfig[] = [
    { encoderCodec: 'mp4a.40.2', muxerCodec: 'aac', bitrate: 192_000, label: 'AAC' },
    { encoderCodec: 'mp4a.40.2', muxerCodec: 'aac', bitrate: 128_000, label: 'AAC' },
    { encoderCodec: 'mp4a.40.2', muxerCodec: 'aac', label: 'AAC' },
    { encoderCodec: 'opus', muxerCodec: 'opus', bitrate: 192_000, label: 'Opus' },
    { encoderCodec: 'opus', muxerCodec: 'opus', bitrate: 128_000, label: 'Opus' },
    { encoderCodec: 'opus', muxerCodec: 'opus', label: 'Opus' },
  ];

  for (const cand of candidates) {
    try {
      const res = await AudioEncoder.isConfigSupported({
        codec: cand.encoderCodec,
        numberOfChannels,
        sampleRate,
        ...(cand.bitrate ? { bitrate: cand.bitrate } : {}),
      });
      if (res.supported) return cand;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function createExportCanvas(width: number, height: number): {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: Canvas2DContext;
} {
  if (typeof OffscreenCanvas !== 'undefined') {
    const off = new OffscreenCanvas(width, height);
    const ctx = off.getContext('2d', { alpha: false });
    if (ctx) {
      return { canvas: off, ctx };
    }
  }
  const el = document.createElement('canvas');
  el.width = width;
  el.height = height;
  const ctx = el.getContext('2d', { alpha: false });
  if (!ctx) {
    throw new Error('ไม่สามารถสร้าง 2D Canvas Context สำหรับการ Export ได้');
  }
  return { canvas: el, ctx };
}

export async function renderMixedAudioBuffer(
  totalDuration: number,
  clips: TimelineClip[],
  assets: Map<string, MediaAsset>
): Promise<AudioBuffer | null> {
  const candidateClips = clips.filter(
    (c) => (c.track === 'audio' || (c.track === 'video' && !c.muted)) && c.mediaId
  );
  if (!candidateClips.length) return null;

  const sampleRate = 48000;
  const length = Math.ceil(totalDuration * sampleRate);
  const offline = new OfflineAudioContext(2, Math.max(1, length), sampleRate);

  for (const clip of candidateClips) {
    const asset = clip.mediaId ? assets.get(clip.mediaId) : undefined;
    if (asset && !asset.audioBuffer && asset.audioStatus !== 'none') {
      await ensureAssetAudio(asset, offline);
    }
  }

  const pairs = audibleClips(clips, assets);
  if (!pairs.length) return null;

  let hasAnySource = false;
  for (const [clip, buffer] of pairs) {
    if (clip.muted) continue;
    const node = scheduleClipAudio({
      ctx: offline,
      destination: offline.destination,
      clip,
      buffer,
      playFrom: 0,
      when: 0,
      allClips: clips,
    });
    if (node) hasAnySource = true;
  }

  if (!hasAnySource) return null;
  return offline.startRendering();
}

export async function exportProjectToMp4(params: {
  clips: TimelineClip[];
  assets: Map<string, MediaAsset>;
  colors: ColorSettings;
  aspectRatio: AspectRatio;
  settings: ExportSettings;
  totalDuration: number;
  signal: AbortSignal;
  onProgress: (p: ExportProgress) => void;
  saveHandle?: FileSystemFileHandle | null;
  /** Optional frame-accurate WebCodecs decoder callback `(asset, srcTimeSec) => Promise<CanvasImageSource | null>` */
  decodeFrame?: (asset: MediaAsset, srcTimeSec: number) => Promise<CanvasImageSource | null>;
}): Promise<ExportResult> {
  const {
    clips,
    assets,
    colors,
    aspectRatio,
    settings,
    totalDuration,
    signal,
    onProgress,
    saveHandle,
    decodeFrame,
  } = params;

  const checkAborted = () => {
    if (signal.aborted) {
      throw new Error('ยกเลิกการบันทึกแล้ว');
    }
  };

  checkAborted();

  const [W, H] = getCanvasDimensions(aspectRatio, settings.resolution, false);
  const fps = settings.fps;
  const bitrate = settings.bitrateMbps * 1_000_000;
  const totalFrames = Math.max(1, Math.ceil(totalDuration * fps));
  const filename = `MinimalCut_${W}x${H}_${fps}fps.mp4`;

  // Estimate required storage quota before starting
  const estimatedBytes = Math.ceil(((bitrate + 192_000) / 8) * totalDuration * 1.15);
  const { usageBytes, quotaBytes } = await getStorageEstimate();
  if (quotaBytes > 0 && quotaBytes - usageBytes < estimatedBytes && !saveHandle) {
    throw new Error('พื้นที่จัดเก็บของเบราว์เซอร์ไม่เพียงพอสำหรับการเรนเดอร์ไฟล์ขนาดนี้');
  }

  if (typeof document !== 'undefined' && 'fonts' in document) {
    try {
      await document.fonts.ready;
    } catch {
      // ignore
    }
  }

  checkAborted();

  const videoConfig = await pickSupportedVideoConfig(W, H, bitrate, fps);
  if (!videoConfig) {
    throw new Error(
      `เบราว์เซอร์ไม่รองรับ WebCodecs VideoEncoder (H.264 ${W}×${H} @ ${fps} FPS) — กรุณาใช้ Chrome / Edge / Safari รุ่นล่าสุด หรือปรับความละเอียดลง`
    );
  }

  onProgress({
    percent: 2,
    message: `เตรียม WebCodecs Offline (${W}×${H} @ ${fps} FPS • ${videoConfig.codec})`,
    currentFrame: 0,
    totalFrames,
  });

  checkAborted();

  const mixedAudio = await renderMixedAudioBuffer(totalDuration, clips, assets);
  checkAborted();

  const audioConfig = mixedAudio ? await pickSupportedAudioConfig(48000, 2) : null;
  const hasAudioEncoder = Boolean(mixedAudio && audioConfig);
  checkAborted();

  const audioChunkFrames = audioConfig?.muxerCodec === 'opus' ? 960 : 1024;
  const expectedAudioChunks = hasAudioEncoder && mixedAudio ? Math.ceil(mixedAudio.length / audioChunkFrames) + 32 : 0;

  // Unified lifecycle variables guarded by try/catch/finally so zero streams, OPFS files,
  // encoders, or dedicated export <video> elements can ever leak on error or abort.
  let writableStream: FileSystemWritableFileStream | null = null;
  let streamClosed = false;
  let opfsTempHandle: FileSystemFileHandle | null = null;
  let opfsTempPath: string | null = null;
  let memoryTarget: ArrayBufferTarget | null = null;
  let savedDirectly = false;
  let videoEncoder: VideoEncoder | null = null;
  const exportVideoEls = new Map<string, HTMLVideoElement>();

  const getExportVideoEl = (asset: MediaAsset): HTMLVideoElement | undefined => {
    const existing = exportVideoEls.get(asset.id);
    if (existing) return existing;
    if (typeof document !== 'undefined' && asset.url) {
      // Dedicated paused full-resolution element bound to original `asset.url` (immune to Proxy Mode & preview listeners)
      const el = document.createElement('video');
      el.src = asset.url;
      el.muted = true;
      el.playsInline = true;
      el.preload = 'auto';
      exportVideoEls.set(asset.id, el);
      return el;
    }
    return asset.videoEl;
  };

  try {
    let muxerTarget: ArrayBufferTarget | FileSystemWritableFileStreamTarget;

    // 3-tier Streaming Target: 1) User FileSystemFileHandle -> 2) OPFS disk stream -> 3) ArrayBuffer fallback
    if (saveHandle) {
      try {
        writableStream = await saveHandle.createWritable();
        muxerTarget = new FileSystemWritableFileStreamTarget(writableStream);
        savedDirectly = true;
      } catch {
        writableStream = null;
      }
    }

    if (!writableStream && opfsAvailable()) {
      try {
        opfsTempPath = `exports/export_${Date.now()}.mp4`;
        opfsTempHandle = await getOpfsFileHandle(opfsTempPath, true);
        writableStream = await opfsTempHandle.createWritable();
        muxerTarget = new FileSystemWritableFileStreamTarget(writableStream);
      } catch {
        writableStream = null;
        opfsTempHandle = null;
        if (opfsTempPath) {
          await opfsRemove(opfsTempPath).catch(() => {});
          opfsTempPath = null;
        }
      }
    }

    if (!writableStream) {
      memoryTarget = new ArrayBufferTarget();
      muxerTarget = memoryTarget;
    }

    const muxer = new Muxer({
      target: muxerTarget!,
      video: {
        codec: 'avc',
        width: W,
        height: H,
      },
      audio: audioConfig
        ? {
            codec: audioConfig.muxerCodec,
            numberOfChannels: 2,
            sampleRate: 48000,
          }
        : undefined,
      firstTimestampBehavior: 'offset',
      fastStart: writableStream
        ? {
            expectedVideoChunks: totalFrames + 32,
            expectedAudioChunks: hasAudioEncoder ? expectedAudioChunks : undefined,
          }
        : 'in-memory',
    });

    let videoEncoderError: Error | null = null;
    videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addVideoChunk(chunk, meta);
        } catch (err) {
          videoEncoderError = err instanceof Error ? err : new Error(String(err));
        }
      },
      error: (err) => {
        videoEncoderError = err instanceof Error ? err : new Error(String(err));
      },
    });

    videoEncoder.configure({
      codec: videoConfig.codec,
      width: W,
      height: H,
      bitrate,
      framerate: fps,
      hardwareAcceleration: videoConfig.hardwareAcceleration,
      latencyMode: videoConfig.latencyMode,
    });

    // 1. Offline Audio Encoding (aligned to microsecond epoch 0 µs; safely normalizes negative priming timestamps)
    if (audioConfig && mixedAudio) {
      onProgress({
        percent: 5,
        message: `กำลังเข้ารหัสเสียง ${audioConfig.label} (OfflineAudioContext)...`,
        currentFrame: 0,
        totalFrames,
      });

      let audioEncoderError: Error | null = null;
      let firstAudioTs: number | null = null;
      let lastAudioTs = -1;

      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          try {
            if (firstAudioTs === null) {
              firstAudioTs = chunk.timestamp < 0 ? chunk.timestamp : 0;
            }
            const shifted = Math.max(0, chunk.timestamp - firstAudioTs);
            const ts = shifted <= lastAudioTs ? lastAudioTs + 1 : shifted;
            lastAudioTs = ts;
            muxer.addAudioChunk(chunk, meta, ts);
          } catch (err) {
            audioEncoderError = err instanceof Error ? err : new Error(String(err));
          }
        },
        error: (err) => {
          audioEncoderError = err instanceof Error ? err : new Error(String(err));
        },
      });

      try {
        audioEncoder.configure({
          codec: audioConfig.encoderCodec,
          numberOfChannels: 2,
          sampleRate: 48000,
          ...(audioConfig.bitrate ? { bitrate: audioConfig.bitrate } : {}),
        });

        const ch0 = mixedAudio.getChannelData(0);
        const ch1 = mixedAudio.numberOfChannels > 1 ? mixedAudio.getChannelData(1) : ch0;
        const chunkFrames = audioChunkFrames;
        for (let offset = 0; offset < mixedAudio.length; offset += chunkFrames) {
          checkAborted();
          if (audioEncoderError) throw audioEncoderError;

          while (audioEncoder.encodeQueueSize > 32) {
            checkAborted();
            if (audioEncoderError) throw audioEncoderError;
            await new Promise((r) => setTimeout(r, 4));
          }

          const frames = Math.min(chunkFrames, mixedAudio.length - offset);
          const planar = new Float32Array(frames * 2);
          planar.set(ch0.subarray(offset, offset + frames), 0);
          planar.set(ch1.subarray(offset, offset + frames), frames);

          const audioData = new AudioData({
            format: 'f32-planar',
            sampleRate: 48000,
            numberOfFrames: frames,
            numberOfChannels: 2,
            timestamp: computeAudioTimestampUs(offset, 48000),
            data: planar,
          });
          try {
            audioEncoder.encode(audioData);
          } finally {
            audioData.close();
          }
        }
        await audioEncoder.flush();
        if (audioEncoderError) throw audioEncoderError;
      } finally {
        if (audioEncoder.state !== 'closed') audioEncoder.close();
      }
    }

    // 2. Dedicated OffscreenCanvas + Deterministic Offline Frame-by-Frame Video Compositing
    const { canvas: exportCanvas, ctx } = createExportCanvas(W, H);

    for (let f = 0; f < totalFrames; f++) {
      checkAborted();
      if (videoEncoderError) throw videoEncoderError;

      const timing = computeFrameTiming(f, fps);
      const t = timing.timeSec;
      const activeVideo = findActiveClip(clips, 'video', t);
      let decodedOverride: CanvasImageSource | null = null;

      if (activeVideo && activeVideo.mediaId) {
        const asset = assets.get(activeVideo.mediaId);
        if (asset) {
          const srcT = clipSourceTime(activeVideo, t);
          if (decodeFrame) {
            decodedOverride = await decodeFrame(asset, srcT);
          }
          if (!decodedOverride) {
            const exportVid = getExportVideoEl(asset);
            if (exportVid) {
              await seekAndSettleVideo(exportVid, srcT, signal);
            }
          }
        }
      }

      try {
        const frameProvider: FrameProvider | undefined = decodedOverride
          ? (clip) => (clip.id === activeVideo?.id ? decodedOverride ?? undefined : undefined)
          : undefined;

        renderCompositionFrame(ctx, W, H, t, clips, assets, colors, false, {
          frameProvider,
          videoSource: (clip) => (clip.mediaId ? exportVideoEls.get(clip.mediaId) : undefined),
        });
      } finally {
        if (decodedOverride && 'close' in decodedOverride && typeof decodedOverride.close === 'function') {
          decodedOverride.close();
        }
      }

      while (videoEncoder.encodeQueueSize > 12) {
        checkAborted();
        if (videoEncoderError) throw videoEncoderError;
        await new Promise((r) => setTimeout(r, 4));
      }

      const frame = new VideoFrame(exportCanvas, {
        timestamp: timing.timestampUs,
        duration: timing.durationUs,
      });
      try {
        videoEncoder.encode(frame, { keyFrame: f % fps === 0 });
      } finally {
        frame.close();
      }

      if (f % Math.max(1, Math.floor(fps / 6)) === 0 || f === totalFrames - 1) {
        const pct = Math.min(98, 10 + Math.round(((f + 1) / totalFrames) * 88));
        onProgress({
          percent: pct,
          message: `กำลังเรนเดอร์เฟรม ${f + 1} / ${totalFrames} (${fps} FPS)`,
          currentFrame: f + 1,
          totalFrames,
        });
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    onProgress({
      percent: 99,
      message: 'กำลัง Flush ตัวเข้ารหัสและปิดสตรีม MP4...',
      currentFrame: totalFrames,
      totalFrames,
    });

    await videoEncoder.flush();
    if (videoEncoderError) throw videoEncoderError;
    checkAborted();

    muxer.finalize();

    if (writableStream) {
      await writableStream.close();
      streamClosed = true;
    }
  } catch (err) {
    if (writableStream && !streamClosed) {
      await writableStream.abort().catch(() => {});
    }
    if (opfsTempPath) {
      await opfsRemove(opfsTempPath).catch(() => {});
    }
    throw err;
  } finally {
    if (videoEncoder && videoEncoder.state !== 'closed') {
      videoEncoder.close();
    }
    exportVideoEls.forEach((el) => {
      el.pause();
      el.removeAttribute('src');
      el.load();
    });
    exportVideoEls.clear();
  }

  onProgress({
    percent: 100,
    message: 'บันทึกไฟล์ MP4 เสร็จสมบูรณ์',
    currentFrame: totalFrames,
    totalFrames,
  });

  if (savedDirectly && saveHandle) {
    const file = await saveHandle.getFile();
    return {
      blob: file,
      filename: saveHandle.name || filename,
      engine: 'webcodecs',
      savedDirectly: true,
    };
  }

  if (opfsTempHandle && opfsTempPath) {
    const file = await opfsTempHandle.getFile();
    const tempRel = opfsTempPath;
    return {
      blob: file,
      filename,
      engine: 'webcodecs',
      cleanup: () => opfsRemove(tempRel),
    };
  }

  const blob = new Blob([memoryTarget!.buffer], { type: 'video/mp4' });
  return {
    blob,
    filename,
    engine: 'webcodecs',
  };
}
