import { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } from 'mp4-muxer';
import type { AspectRatio, ColorSettings, ExportSettings, MediaAsset, TimelineClip } from '../types/editor';
import { getCanvasDimensions } from './timecode';
import { renderCompositionFrame, type FrameProvider } from './renderer';
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
  engine: 'webcodecs' | 'mediarecorder';
  /** True when the file was already written to a user-picked FileSystemFileHandle via showSaveFilePicker. */
  savedDirectly?: boolean;
  /** Optional cleanup callback (e.g. deletes temporary OPFS export file after download). */
  cleanup?: () => Promise<void>;
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

/**
 * Seeks an HTMLVideoElement to `targetTime` and waits until the frame is actually decoded
 * (`readyState >= 2 && !video.seeking`).
 */
function seekVideoTo(video: HTMLVideoElement, targetTime: number): Promise<void> {
  const clamped = Math.max(0, Math.min(targetTime, video.duration || targetTime));
  if (!video.seeking && Math.abs(video.currentTime - clamped) < 0.002 && video.readyState >= 2) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      if (video.seeking || video.readyState < 2) {
        setTimeout(() => {
          if (!done) {
            done = true;
            cleanup();
            resolve();
          }
        }, 16);
        return;
      }
      done = true;
      cleanup();
      resolve();
    };
    const forceFinish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      video.removeEventListener('seeked', finish);
      video.removeEventListener('loadeddata', finish);
      clearTimeout(timer);
    };
    const timer = setTimeout(forceFinish, 1500);
    video.addEventListener('seeked', finish);
    video.addEventListener('loadeddata', finish);
    video.currentTime = clamped;
  });
}

async function pickSupportedVideoCodec(width: number, height: number, bitrate: number, fps: number): Promise<string | null> {
  if (!('VideoEncoder' in window)) return null;
  const candidates = [
    'avc1.640028', // H.264 High L4.0
    'avc1.4d002a', // H.264 Main L4.2 (supports 1080p60/120)
    'avc1.42001f', // H.264 Baseline L3.1
    'avc1.42E01E',
  ];
  for (const codec of candidates) {
    try {
      const res = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate,
        framerate: fps,
      });
      if (res.supported) return codec;
    } catch {
      // try next
    }
  }
  return null;
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
  /** Optional Phase 3 frame-accurate decoder callback `(asset, srcTimeSec) => Promise<CanvasImageSource | null>` */
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

  const codec = await pickSupportedVideoCodec(W, H, bitrate, fps);

  if (codec && 'VideoFrame' in window) {
    onProgress({
      percent: 1,
      message: `ใช้ WebCodecs Streaming (${W}×${H} @ ${fps} FPS • ${codec})`,
      currentFrame: 0,
      totalFrames,
    });

    const mixedAudio = await renderMixedAudioBuffer(totalDuration, clips, assets);
    const hasAudioEncoder = Boolean(mixedAudio && 'AudioEncoder' in window && 'AudioData' in window);
    const expectedAudioChunks = hasAudioEncoder && mixedAudio ? Math.ceil(mixedAudio.length / 1024) + 32 : 0;

    // 3-tier Streaming Target: 1) User FileSystemFileHandle -> 2) OPFS disk stream -> 3) ArrayBuffer fallback
    let writableStream: FileSystemWritableFileStream | null = null;
    let opfsTempHandle: FileSystemFileHandle | null = null;
    let opfsTempPath: string | null = null;
    let memoryTarget: ArrayBufferTarget | null = null;
    let muxerTarget: ArrayBufferTarget | FileSystemWritableFileStreamTarget;
    let savedDirectly = false;

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
        opfsTempPath = null;
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
      audio: hasAudioEncoder
        ? {
            codec: 'aac',
            numberOfChannels: 2,
            sampleRate: 48000,
          }
        : undefined,
      fastStart: writableStream
        ? {
            expectedVideoChunks: totalFrames + 32,
            expectedAudioChunks: hasAudioEncoder ? expectedAudioChunks : undefined,
          }
        : 'in-memory',
    });

    let encoderError: Error | null = null;
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (err) => {
        encoderError = err;
      },
    });

    videoEncoder.configure({
      codec,
      width: W,
      height: H,
      bitrate,
      framerate: fps,
      hardwareAcceleration: 'prefer-hardware',
    });

    try {
      if (hasAudioEncoder && mixedAudio) {
        const audioEncoder = new AudioEncoder({
          output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
          error: (err) => {
            console.warn('AudioEncoder warning:', err);
          },
        });
        try {
          audioEncoder.configure({
            codec: 'mp4a.40.2',
            numberOfChannels: 2,
            sampleRate: 48000,
            bitrate: 192_000,
          });

          const ch0 = mixedAudio.getChannelData(0);
          const ch1 = mixedAudio.numberOfChannels > 1 ? mixedAudio.getChannelData(1) : ch0;
          const chunkFrames = 1024;
          for (let offset = 0; offset < mixedAudio.length; offset += chunkFrames) {
            if (signal.aborted) throw new Error('ยกเลิกการบันทึกแล้ว');
            const frames = Math.min(chunkFrames, mixedAudio.length - offset);
            const planar = new Float32Array(frames * 2);
            planar.set(ch0.subarray(offset, offset + frames), 0);
            planar.set(ch1.subarray(offset, offset + frames), frames);
            const audioData = new AudioData({
              format: 'f32-planar',
              sampleRate: 48000,
              numberOfFrames: frames,
              numberOfChannels: 2,
              timestamp: Math.round((offset / 48000) * 1_000_000),
              data: planar,
            });
            try {
              audioEncoder.encode(audioData);
            } finally {
              audioData.close();
            }
          }
          await audioEncoder.flush();
        } finally {
          if (audioEncoder.state !== 'closed') audioEncoder.close();
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d', { alpha: false })!;
      const frameDurationUs = Math.round(1_000_000 / fps);

      assets.forEach((a) => {
        if (a.videoEl && !a.videoEl.paused) a.videoEl.pause();
      });

      for (let f = 0; f < totalFrames; f++) {
        if (signal.aborted) {
          throw new Error('ยกเลิกการบันทึกแล้ว');
        }
        if (encoderError) throw encoderError;

        const t = f / fps;
        const activeVideo = findActiveClip(clips, 'video', t);
        let decodedOverride: CanvasImageSource | null = null;

        if (activeVideo && activeVideo.mediaId) {
          const asset = assets.get(activeVideo.mediaId);
          if (asset) {
            const srcT = clipSourceTime(activeVideo, t);
            if (decodeFrame) {
              decodedOverride = await decodeFrame(asset, srcT);
            }
            if (!decodedOverride && asset.videoEl) {
              await seekVideoTo(asset.videoEl, srcT);
            }
          }
        }

        const frameProvider: FrameProvider | undefined = decodedOverride
          ? (clip) => (clip.id === activeVideo?.id ? decodedOverride ?? undefined : undefined)
          : undefined;

        renderCompositionFrame(ctx, W, H, t, clips, assets, colors, false, {
          frameProvider,
        });

        if (decodedOverride && 'close' in decodedOverride && typeof decodedOverride.close === 'function') {
          decodedOverride.close();
        }

        while (videoEncoder.encodeQueueSize > 12) {
          if (signal.aborted) throw new Error('ยกเลิกการบันทึกแล้ว');
          if (encoderError) throw encoderError;
          await new Promise((r) => setTimeout(r, 4));
        }

        const frame = new VideoFrame(canvas, {
          timestamp: f * frameDurationUs,
          duration: frameDurationUs,
        });
        try {
          videoEncoder.encode(frame, { keyFrame: f % fps === 0 });
        } finally {
          frame.close();
        }

        if (f % Math.max(1, Math.floor(fps / 6)) === 0 || f === totalFrames - 1) {
          const pct = Math.min(99, Math.round(((f + 1) / totalFrames) * 100));
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
        message: 'กำลังปิดและบันทึกสตรีม MP4...',
        currentFrame: totalFrames,
        totalFrames,
      });

      await videoEncoder.flush();
    } catch (err) {
      if (writableStream) {
        await writableStream.abort().catch(() => {});
      }
      if (opfsTempPath) {
        await opfsRemove(opfsTempPath);
      }
      throw err;
    } finally {
      if (videoEncoder.state !== 'closed') {
        videoEncoder.close();
      }
    }

    muxer.finalize();

    if (writableStream) {
      await writableStream.close();
    }

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

  // Fallback to MediaRecorder (for browsers without WebCodecs VideoEncoder)
  onProgress({
    percent: 1,
    message: `เบราว์เซอร์ไม่รองรับ WebCodecs — ใช้ MediaRecorder (${W}×${H} @ ${fps} FPS)`,
    currentFrame: 0,
    totalFrames,
  });

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const stream = canvas.captureStream(fps);
  const mime =
    ['video/mp4', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const recorder = mime ? new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  return new Promise((resolve, reject) => {
    recorder.onstop = () => {
      assets.forEach((a) => {
        if (a.videoEl && !a.videoEl.paused) a.videoEl.pause();
      });
      if (signal.aborted) return reject(new Error('ยกเลิกการบันทึกแล้ว'));
      const isMp4 = (recorder.mimeType || '').includes('mp4');
      const blob = new Blob(chunks, { type: isMp4 ? 'video/mp4' : 'video/webm' });
      resolve({
        blob,
        filename: `MinimalCut_${W}x${H}_${fps}fps.${isMp4 ? 'mp4' : 'webm'}`,
        engine: 'mediarecorder',
      });
    };

    recorder.start(500);
    const start = performance.now();
    const tick = setInterval(() => {
      if (signal.aborted) {
        clearInterval(tick);
        recorder.stop();
        return;
      }
      const elapsed = (performance.now() - start) / 1000;
      if (elapsed >= totalDuration) {
        clearInterval(tick);
        recorder.stop();
        return;
      }

      const activeVideo = findActiveClip(clips, 'video', elapsed);
      assets.forEach((asset) => {
        if (asset.type !== 'video' || !asset.videoEl) return;
        const vid = asset.videoEl;
        if (!activeVideo || activeVideo.mediaId !== asset.id) {
          if (!vid.paused) vid.pause();
          return;
        }
        const tgt = clipSourceTime(activeVideo, elapsed);
        vid.muted = true;
        if (activeVideo.reverse) {
          if (!vid.paused) vid.pause();
          if (!vid.seeking && Math.abs(vid.currentTime - tgt) > 0.02) {
            vid.currentTime = Math.max(0, Math.min(tgt, asset.duration));
          }
        } else {
          vid.playbackRate = activeVideo.speed || 1;
          if (!vid.seeking && Math.abs(vid.currentTime - tgt) > 0.25) {
            vid.currentTime = Math.max(0, Math.min(tgt, asset.duration));
          }
          if (vid.paused) vid.play().catch(() => {});
        }
      });

      renderCompositionFrame(ctx, W, H, elapsed, clips, assets, colors, false, { holdIfNotReady: true });
      onProgress({
        percent: Math.min(99, Math.round((elapsed / totalDuration) * 100)),
        message: `กำลังบันทึก ${elapsed.toFixed(1)}s / ${totalDuration.toFixed(1)}s`,
        currentFrame: Math.floor(elapsed * fps),
        totalFrames,
      });
    }, Math.max(8, Math.floor(1000 / Math.min(fps, 60))));
  });
}
