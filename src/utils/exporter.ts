import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { AspectRatio, ColorSettings, ExportSettings, MediaAsset, TimelineClip } from '../types/editor';
import { getCanvasDimensions } from './timecode';
import { renderCompositionFrame } from './renderer';

export interface ExportProgress {
  percent: number;
  message: string;
  currentFrame: number;
  totalFrames: number;
}

function seekVideoTo(video: HTMLVideoElement, targetTime: number): Promise<void> {
  const clamped = Math.max(0, Math.min(targetTime, video.duration || targetTime));
  if (Math.abs(video.currentTime - clamped) < 0.002 && video.readyState >= 2) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 180);
    video.addEventListener('seeked', finish, { once: true });
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

async function renderMixedAudioBuffer(
  totalDuration: number,
  clips: TimelineClip[],
  assets: Map<string, MediaAsset>
): Promise<AudioBuffer | null> {
  const audioClips = clips.filter((c) => c.track === 'audio' && c.mediaId);
  if (!audioClips.length) return null;

  const sampleRate = 48000;
  const length = Math.ceil(totalDuration * sampleRate);
  const offline = new OfflineAudioContext(2, Math.max(1, length), sampleRate);

  let hasAnySource = false;
  for (const clip of audioClips) {
    const asset = clip.mediaId ? assets.get(clip.mediaId) : undefined;
    if (!asset?.audioBuffer) continue;

    hasAnySource = true;
    const src = offline.createBufferSource();
    src.buffer = asset.audioBuffer;
    const gain = offline.createGain();
    const norm = clip.normalizeGain ?? 1.0;
    const baseVol = (clip.muted ? 0 : (clip.volume ?? 100) / 100) * norm;

    gain.gain.setValueAtTime(baseVol, clip.timelineStart);
    if (clip.fadeIn > 0) {
      gain.gain.setValueAtTime(0.001, clip.timelineStart);
      gain.gain.linearRampToValueAtTime(baseVol, clip.timelineStart + clip.fadeIn);
    }
    if (clip.fadeOut > 0 && clip.duration > clip.fadeOut) {
      const outStart = clip.timelineStart + clip.duration - clip.fadeOut;
      gain.gain.setValueAtTime(baseVol, outStart);
      gain.gain.linearRampToValueAtTime(0.001, clip.timelineStart + clip.duration);
    }
    if (clip.audioKeyframes?.length) {
      for (const kf of clip.audioKeyframes) {
        if (kf.t >= 0 && kf.t <= clip.duration) {
          gain.gain.linearRampToValueAtTime(kf.gain * norm, clip.timelineStart + kf.t);
        }
      }
    }

    src.connect(gain);
    gain.connect(offline.destination);
    src.start(clip.timelineStart, clip.sourceStart, clip.duration);
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

    // Encode Audio if present
    if (hasAudioEncoder && mixedAudio) {
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (err) => {
          console.warn('AudioEncoder warning:', err);
        },
      });
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
      audioEncoder.close();
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
        videoEncoder.close();
        throw new Error('ยกเลิกการบันทึกแล้ว');
      }
      if (encoderError) throw encoderError;

      const t = f / fps;

      // Sync active video clip accurately to frame timestamp
      const activeVideo = clips.find(
        (c) => c.track === 'video' && t >= c.timelineStart && t < c.timelineStart + c.duration
      );
      if (activeVideo && activeVideo.mediaId) {
        const asset = assets.get(activeVideo.mediaId);
        if (asset?.videoEl) {
          const off = (t - activeVideo.timelineStart) * (activeVideo.speed || 1);
          const srcT = activeVideo.reverse
            ? Math.max(0, asset.duration - activeVideo.sourceStart - off)
            : activeVideo.sourceStart + off;
          await seekVideoTo(asset.videoEl, srcT);
        }
      }

      renderCompositionFrame(ctx, W, H, t, clips, assets, colors, false);

      // Backpressure control so GPU encoder queue stays healthy at 120 FPS
      while (videoEncoder.encodeQueueSize > 12) {
        await new Promise((r) => setTimeout(r, 4));
      }

      const frame = new VideoFrame(canvas, {
        timestamp: f * frameDurationUs,
        duration: frameDurationUs,
      });
      videoEncoder.encode(frame, { keyFrame: f % fps === 0 });
      frame.close();

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
    videoEncoder.close();
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
    const tick = setInterval(async () => {
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
      renderCompositionFrame(ctx, W, H, elapsed, clips, assets, colors, false);
      onProgress({
        percent: Math.min(99, Math.round((elapsed / totalDuration) * 100)),
        message: `กำลังบันทึก ${elapsed.toFixed(1)}s / ${totalDuration.toFixed(1)}s`,
        currentFrame: Math.floor(elapsed * fps),
        totalFrames,
      });
    }, Math.max(8, Math.floor(1000 / Math.min(fps, 60))));
  });
}
