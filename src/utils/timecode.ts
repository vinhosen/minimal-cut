import type { AspectRatio, ExportResolution } from '../types/editor';

let idCounter = 1;
export function nextId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${idCounter++}`;
}

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function formatTimecode(sec: number, fps: number): string {
  const s = Math.max(0, sec);
  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const frames = Math.floor((s % 1) * fps);
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}:${pad(frames)}`;
}

export function getCanvasDimensions(
  ratio: AspectRatio,
  resolution: ExportResolution,
  proxyMode = false
): [number, number] {
  const scale = proxyMode ? 0.5 : 1;
  const table: Record<AspectRatio, Record<ExportResolution, [number, number]>> = {
    '16:9': {
      2160: [3840, 2160],
      1440: [2560, 1440],
      1080: [1920, 1080],
      720: [1280, 720],
      480: [854, 480],
    },
    '9:16': {
      2160: [2160, 3840],
      1440: [1440, 2560],
      1080: [1080, 1920],
      720: [720, 1280],
      480: [480, 854],
    },
    '1:1': {
      2160: [2160, 2160],
      1440: [1440, 1440],
      1080: [1080, 1080],
      720: [720, 720],
      480: [480, 480],
    },
  };
  const [w, h] = table[ratio][resolution] || [1280, 720];
  // H.264 / WebCodecs requires even width and height
  const ew = Math.round((w * scale) / 2) * 2;
  const eh = Math.round((h * scale) / 2) * 2;
  return [ew, eh];
}

export function computeAudioPeaks(buffer: AudioBuffer, buckets = 240): Float32Array {
  const ch = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / buckets));
  const peaks = new Float32Array(buckets);
  for (let i = 0; i < buckets; i++) {
    let max = 0;
    const end = Math.min((i + 1) * step, ch.length);
    for (let j = i * step; j < end; j += 8) {
      const v = Math.abs(ch[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}
