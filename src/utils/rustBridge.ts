import type { AspectRatio, ColorSettings, ExportSettings, TimelineClip } from '../types/editor';

export async function isRustBackendAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { method: 'GET' });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.status === 'ok';
  } catch {
    return false;
  }
}

export async function uploadMediaToRust(file: File): Promise<string | null> {
  try {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const res = await fetch('/api/media/upload', { method: 'POST', body: fd });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.id || null;
  } catch {
    return null;
  }
}

export async function exportViaRustEngine(params: {
  aspectRatio: AspectRatio;
  clips: TimelineClip[];
  colors: ColorSettings;
  settings: ExportSettings;
  serverIdMap: Map<string, string>;
  signal: AbortSignal;
  onProgress: (percent: number, message: string) => void;
}): Promise<{ url: string; filename: string; sizeMb: string }> {
  const mappedClips = params.clips.map((c) => ({
    ...c,
    mediaId: c.mediaId ? params.serverIdMap.get(c.mediaId) || c.mediaId : null,
  }));

  const startRes = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      aspectRatio: params.aspectRatio,
      clips: mappedClips,
      colors: params.colors,
      settings: params.settings,
    }),
    signal: params.signal,
  });

  if (!startRes.ok) {
    throw new Error('ไม่สามารถเริ่มเรนเดอร์ผ่าน Rust Engine ได้');
  }

  const job = await startRes.json();
  const jobId = job.id as string;

  while (true) {
    if (params.signal.aborted) {
      throw new Error('ยกเลิกการบันทึกแล้ว');
    }
    await new Promise((r) => setTimeout(r, 400));
    const stRes = await fetch(`/api/export/${jobId}`, { signal: params.signal });
    if (!stRes.ok) throw new Error('ไม่สามารถตรวจสอบสถานะการเรนเดอร์ได้');
    const st = await stRes.json();

    params.onProgress(st.percent || 0, st.message || 'กำลังเรนเดอร์...');

    if (st.status === 'done') {
      const sizeMb = ((st.size_bytes || 0) / (1024 * 1024)).toFixed(2);
      return {
        url: `/api/export/${jobId}/download`,
        filename: st.filename || 'export.mp4',
        sizeMb,
      };
    }
    if (st.status === 'error') {
      throw new Error(st.message || 'Rust FFmpeg render failed');
    }
  }
}
