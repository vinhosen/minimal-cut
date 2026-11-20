import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { AspectRatio, ColorSettings, ExportSettings, MediaAsset, TimelineClip } from '../types/editor';
import { getCanvasDimensions } from './timecode';
import { renderCompositionFrame } from './renderer';
import { clipSourceTime, findActiveClip } from './clipTime';
import { audibleClips, ensureAssetAudio, scheduleClipAudio } from '../audio/scheduleClipAudio';

export interface ExportProgress {
  percent: number;
  message: string;
  currentFrame: number;
  totalFrames: number;
}

/**
 * Seeks an HTMLVideoElement to `targetTime` and waits until the frame is actually decoded
 * (`readyState >= 2 && !video.seeking`). Replaces the old 180ms timeout that caused black/stale
 * frames at cut points during export.
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
        // Wait a micro-poll if seeked fired before readyState reached HAVE_CURRENT_DATA
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

  // Ensure all referenced audio and video assets have their AudioBuffer decoded before mixing
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
}): Promise<{ blob: Blob; filename: string; engine: 'webcodecs' | 'mediarecorder' }> {
  const { clips, assets, colors, aspectRatio, settings, totalDuration, signal, onProgress } = params;
  const [W, H] = getCanvasDimensions(aspectRatio, settings.resolution, false);
  const fps = settings.fps;
  const bitrate = settings.bitrateMbps * 1_000_000;
  const totalFrames = Math.max(1, Math.ceil(totalDuration * fps));

  // Wait for custom web fonts (Inter, Noto Sans Thai) so text overlays on early frames don't use fallback font
  if (typeof document !== 'undefined' && 'fonts' in document) {
    try {
      await document.fonts.ready;
    } catch {
      // ignore font readiness error
    }
  }

  const codec = await pickSupportedVideoCodec(W, H, bitrate, fps);

  if (codec && 'VideoFrame' in window) {
    onProgress({
      percent: 1,
      message: `ใช้ WebCodecs Offline (${W}×${H} @ ${fps} FPS • ${codec})`,
      currentFrame: 0,
      totalFrames,
    });

    const mixedAudio = await renderMixedAudioBuffer(totalDuration, clips, assets);
    const hasAudioEncoder = Boolean(mixedAudio && 'AudioEncoder' in window && 'AudioData' in window);

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
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
      fastStart: 'in-memory',
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
      // Encode Audio if present
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
            audioEncoder.encode(audioData);
            audioData.close();
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

      // Pause any playing videos before offline seek
      assets.forEach((a) => {
        if (a.videoEl && !a.videoEl.paused) a.videoEl.pause();
      });

      for (let f = 0; f < totalFrames; f++) {
        if (signal.aborted) {
          throw new Error('ยกเลิกการบันทึกแล้ว');
        }
        if (encoderError) throw encoderError;

        const t = f / fps;

        // Sync active video clip accurately to frame timestamp using shared clipSourceTime
        const activeVideo = findActiveClip(clips, 'video', t);
        if (activeVideo && activeVideo.mediaId) {
          const asset = assets.get(activeVideo.mediaId);
          if (asset?.videoEl) {
            const srcT = clipSourceTime(activeVideo, t);
            await seekVideoTo(asset.videoEl, srcT);
          }
        }

        renderCompositionFrame(ctx, W, H, t, clips, assets, colors, false);

        // Backpressure control so GPU encoder queue stays healthy at 120 FPS
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
        message: 'กำลังรวมไฟล์ MP4...',
        currentFrame: totalFrames,
        totalFrames,
      });

      await videoEncoder.flush();
    } finally {
      if (videoEncoder.state !== 'closed') {
        videoEncoder.close();
      }
    }

    muxer.finalize();

    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    return {
      blob,
      filename: `MinimalCut_${W}x${H}_${fps}fps.mp4`,
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

      // Sync active video element during MediaRecorder realtime capture
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
