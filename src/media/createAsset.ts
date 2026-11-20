import type { MediaAsset } from '../types/editor';
import { computeAudioPeaks, nextId } from '../utils/timecode';
import { ensureAssetAudio } from '../audio/scheduleClipAudio';

export interface CreateAssetOptions {
  /** Explicit ID when restoring from a saved/recovered project snapshot. */
  id?: string;
  /** AudioContext provider for background audio/waveform decoding. */
  getAudioCtx?: () => BaseAudioContext;
  /** Callback invoked when background audio/peaks decoding finishes. */
  onAudioReady?: (asset: MediaAsset) => void;
}

export function createAssetFromFile(file: File, opts: CreateAssetOptions = {}): Promise<MediaAsset> {
  const url = URL.createObjectURL(file);
  const mime = file.type || '';

  if (mime.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name)) {
    return new Promise((resolve, reject) => {
      const vid = document.createElement('video');
      vid.src = url;
      vid.playsInline = true;
      vid.preload = 'auto';
      vid.onloadedmetadata = () => {
        const asset: MediaAsset = {
          id: opts.id || nextId('vid'),
          type: 'video',
          name: file.name,
          url,
          file,
          duration: vid.duration && Number.isFinite(vid.duration) ? vid.duration : 5,
          width: vid.videoWidth || 1280,
          height: vid.videoHeight || 720,
          videoEl: vid,
        };
        if (opts.getAudioCtx) {
          try {
            const ctx = opts.getAudioCtx();
            ensureAssetAudio(asset, ctx).then((buf) => {
              if (!buf) return;
              asset.peaks = computeAudioPeaks(buf);
              opts.onAudioReady?.(asset);
            });
          } catch {
            // ignore background audio decode error
          }
        }
        resolve(asset);
      };
      vid.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`ไม่สามารถเปิดไฟล์วิดีโอ "${file.name}" ได้`));
      };
    });
  }

  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|bmp)$/i.test(file.name)) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const asset: MediaAsset = {
          id: opts.id || nextId('img'),
          type: 'image',
          name: file.name,
          url,
          file,
          duration: 5,
          width: img.width || 1280,
          height: img.height || 720,
          imgEl: img,
        };
        resolve(asset);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`ไม่สามารถเปิดรูป "${file.name}" ได้`));
      };
      img.src = url;
    });
  }

  if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(file.name)) {
    return new Promise((resolve, reject) => {
      const aud = document.createElement('audio');
      aud.src = url;
      aud.preload = 'metadata';
      aud.onloadedmetadata = () => {
        const asset: MediaAsset = {
          id: opts.id || nextId('aud'),
          type: 'audio',
          name: file.name,
          url,
          file,
          duration: aud.duration && Number.isFinite(aud.duration) ? aud.duration : 5,
          width: 0,
          height: 0,
        };
        if (opts.getAudioCtx) {
          try {
            const ctx = opts.getAudioCtx();
            ensureAssetAudio(asset, ctx).then((buf) => {
              if (!buf) return;
              asset.peaks = computeAudioPeaks(buf);
              opts.onAudioReady?.(asset);
            });
          } catch {
            // ignore
          }
        }
        resolve(asset);
      };
      aud.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`ไม่สามารถเปิดไฟล์เสียง "${file.name}" ได้`));
      };
    });
  }

  URL.revokeObjectURL(url);
  return Promise.reject(new Error(`ไม่รองรับประเภทไฟล์ "${file.name}"`));
}
