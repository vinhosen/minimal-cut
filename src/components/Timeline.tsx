import React, { useEffect, useRef } from 'react';
import { Scissors, Trash2, Magnet, Film, Image as ImageIcon, Type, Music } from 'lucide-react';
import type { MediaAsset, TimelineClip, TrackType } from '../types/editor';

interface TimelineProps {
  clips: TimelineClip[];
  assets: Map<string, MediaAsset>;
  selectedClipId: string | null;
  playhead: number;
  totalDuration: number;
  zoom: number;
  snap: boolean;
  onChangeZoom: (z: number) => void;
  onToggleSnap: () => void;
  onSelectClip: (id: string | null) => void;
  onSeek: (time: number) => void;
  onSplit: () => void;
  onDelete: () => void;
  onRippleDelete: () => void;
  onUpdateClip: (id: string, patch: Partial<TimelineClip>, commitHistory?: boolean) => void;
}

const TRACKS: { id: TrackType; label: string; icon: React.ReactNode }[] = [
  { id: 'video', label: 'วิดีโอ', icon: <Film size={13} /> },
  { id: 'image', label: 'รูปภาพ', icon: <ImageIcon size={13} /> },
  { id: 'fx', label: 'ข้อความ', icon: <Type size={13} /> },
  { id: 'audio', label: 'เสียง', icon: <Music size={13} /> },
];

export const Timeline: React.FC<TimelineProps> = ({
  clips,
  assets,
  selectedClipId,
  playhead,
  totalDuration,
  zoom,
  snap,
  onChangeZoom,
  onToggleSnap,
  onSelectClip,
  onSeek,
  onSplit,
  onDelete,
  onRippleDelete,
  onUpdateClip,
}) => {
  const rulerCanvasRef = useRef<HTMLCanvasElement>(null);
  const timelineInnerRef = useRef<HTMLDivElement>(null);

  const displaySeconds = Math.max(totalDuration + 8, 25);
  const timelineWidth = Math.ceil(displaySeconds * zoom);

  // Draw crisp ruler ticks
  useEffect(() => {
    const canvas = rulerCanvasRef.current;
    if (!canvas) return;
    canvas.width = timelineWidth;
    canvas.height = 24;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, timelineWidth, 24);
    ctx.fillStyle = '#71717a';
    ctx.font = '10px "JetBrains Mono", monospace';

    const stepSec = zoom < 40 ? 5 : zoom < 80 ? 2 : 1;
    for (let s = 0; s <= Math.ceil(displaySeconds); s++) {
      const x = s * zoom;
      const major = s % stepSec === 0;
      ctx.strokeStyle = major ? '#a1a1aa' : '#e4e7ec';
      ctx.beginPath();
      ctx.moveTo(x, major ? 8 : 16);
      ctx.lineTo(x, 24);
      ctx.stroke();
      if (major) {
        ctx.fillText(`${s}s`, x + 4, 13);
      }
    }
  }, [timelineWidth, displaySeconds, zoom]);

  const startScrub = (ev: React.PointerEvent) => {
    ev.stopPropagation();
    const updateScrub = (clientX: number) => {
      const el = timelineInnerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const t = Math.max(0, (clientX - rect.left) / zoom);
      onSeek(t);
    };
    updateScrub(ev.clientX);

    const onMove = (m: PointerEvent) => updateScrub(m.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const handleClipPointerDown = (ev: React.PointerEvent, clip: TimelineClip) => {
    ev.stopPropagation();
    onSelectClip(clip.id);

    const target = ev.target as HTMLElement;
    const mode = target.classList.contains('trim-handle-left')
      ? 'tl'
      : target.classList.contains('trim-handle-right')
        ? 'tr'
        : 'mv';

    const startX = ev.clientX;
    const origStart = clip.timelineStart;
    const origDur = clip.duration;
    const origSrcStart = clip.sourceStart;
    const spd = clip.speed || 1;
    let moved = false;

    const onMove = (m: PointerEvent) => {
      moved = true;
      const ds = (m.clientX - startX) / zoom;

      if (mode === 'mv') {
        let nextStart = Math.max(0, origStart + ds);
        if (snap) {
          if (Math.abs(nextStart - playhead) < 0.2) nextStart = playhead;
          // Snap to other clips' edges on same track
          for (const other of clips) {
            if (other.id === clip.id || other.track !== clip.track) continue;
            const otherEnd = other.timelineStart + other.duration;
            if (Math.abs(nextStart - otherEnd) < 0.2) {
              nextStart = otherEnd;
              break;
            }
          }
        }
        onUpdateClip(clip.id, { timelineStart: nextStart }, false);
      } else if (mode === 'tl') {
        const delta = Math.min(origDur - 0.2, Math.max(-origStart, -origSrcStart / spd, ds));
        onUpdateClip(
          clip.id,
          {
            timelineStart: origStart + delta,
            sourceStart: origSrcStart + delta * spd,
            duration: origDur - delta,
          },
          false
        );
      } else {
        const maxDur = (clip.sourceDuration - clip.sourceStart) / spd;
        const nextDur = Math.min(maxDur, Math.max(0.2, origDur + ds));
        onUpdateClip(clip.id, { duration: nextDur }, false);
      }
    };

    const onUp = () => {
      if (moved) {
        onUpdateClip(clip.id, {}, true);
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  return (
    <section className="panel timeline-panel">
      <div className="timeline-toolbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button className="btn btn-secondary" onClick={onSplit} title="ตัดแบ่งคลิปตรงเส้นสีแดง (S)">
            <Scissors size={13} />
            <span>ตัดแบ่ง (S)</span>
          </button>
          <button
            className="btn btn-secondary"
            onClick={onRippleDelete}
            disabled={!selectedClipId}
            title="ลบคลิปที่เลือกแล้วเลื่อนคลิปถัดไปมาชิด"
          >
            <Trash2 size={13} />
            <span>ลบแล้วเลื่อนชิด</span>
          </button>
          <button
            className="btn btn-ghost"
            onClick={onDelete}
            disabled={!selectedClipId}
            title="ลบคลิปที่เลือก (Delete)"
          >
            <span>ลบ</span>
          </button>
          <div className="topbar-divider" />
          <button
            className={`btn ${snap ? 'btn-primary' : 'btn-ghost'}`}
            onClick={onToggleSnap}
            title="ดูดติดขอบคลิปอัตโนมัติ"
          >
            <Magnet size={13} />
            <span>Snap</span>
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>ซูมไทม์ไลน์</span>
          <input
            type="range"
            className="slider"
            style={{ width: 110 }}
            min={20}
            max={200}
            value={zoom}
            onChange={(e) => onChangeZoom(+e.target.value)}
          />
          <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', width: 48 }}>
            {zoom}px/s
          </span>
        </div>
      </div>

      <div className="timeline-body">
        <div className="track-headers">
          <div className="track-header-ruler">TIME</div>
          {TRACKS.map((t) => (
            <div key={t.id} className="track-header-item">
              {t.icon}
              <span>{t.label}</span>
            </div>
          ))}
        </div>

        <div className="timeline-scroll" onClick={() => onSelectClip(null)}>
          <div ref={timelineInnerRef} className="timeline-inner" style={{ width: timelineWidth }}>
            <div className="ruler-bar" onPointerDown={startScrub}>
              <canvas ref={rulerCanvasRef} style={{ display: 'block', height: '100%' }} />
            </div>

            {TRACKS.map((track) => {
              const laneClips = clips.filter((c) => c.track === track.id);
              return (
                <div key={track.id} className="track-lane">
                  {laneClips.map((clip) => {
                    const asset = clip.mediaId ? assets.get(clip.mediaId) : undefined;
                    return (
                      <div
                        key={clip.id}
                        className={`clip-block track-${clip.track} ${clip.id === selectedClipId ? 'selected' : ''}`}
                        style={{
                          left: clip.timelineStart * zoom,
                          width: Math.max(22, clip.duration * zoom),
                        }}
                        onPointerDown={(e) => handleClipPointerDown(e, clip)}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {clip.track === 'audio' && asset?.peaks && (
                          <AudioWaveform peaks={asset.peaks} width={Math.max(22, Math.floor(clip.duration * zoom))} />
                        )}
                        <span
                          style={{
                            position: 'relative',
                            zIndex: 2,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            pointerEvents: 'none',
                          }}
                        >
                          {clip.name}
                        </span>
                        <div className="trim-handle trim-handle-left" />
                        <div className="trim-handle trim-handle-right" />
                      </div>
                    );
                  })}
                </div>
              );
            })}

            <div className="playhead" style={{ left: playhead * zoom }}>
              <div className="playhead-cap" onPointerDown={startScrub} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

const AudioWaveform: React.FC<{ peaks: Float32Array; width: number }> = ({ peaks, width }) => {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = 30;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, 30);
    ctx.fillStyle = 'rgba(5, 150, 105, 0.38)';
    for (let x = 0; x < width; x += 2) {
      const idx = Math.floor((x / width) * peaks.length);
      const amp = peaks[idx] || 0;
      const h = Math.max(2, amp * 24);
      ctx.fillRect(x, (30 - h) / 2, 1.5, h);
    }
  }, [peaks, width]);

  return (
    <canvas
      ref={ref}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    />
  );
};
