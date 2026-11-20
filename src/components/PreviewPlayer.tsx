import React, { useRef, useState } from 'react';
import { Play, Pause, SkipBack, ChevronLeft, ChevronRight, Repeat, Film } from 'lucide-react';
import type { AspectRatio, ExportFps, TimelineClip } from '../types/editor';
import { clamp, formatTimecode } from '../utils/timecode';

interface PreviewPlayerProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  canvasDims: [number, number];
  aspectRatio: AspectRatio;
  proxyMode: boolean;
  isPlaying: boolean;
  loop: boolean;
  playhead: number;
  totalDuration: number;
  fps: ExportFps;
  liveFps: number;
  clips: TimelineClip[];
  selectedClipId: string | null;
  onChangeAspectRatio: (ratio: AspectRatio) => void;
  onToggleProxy: () => void;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onToggleLoop: () => void;
  onSelectClip: (id: string) => void;
  onUpdateClipLive: (id: string, patch: Partial<TimelineClip>, commitHistory?: boolean) => void;
  onSetDraggingPreview: (dragging: boolean) => void;
}

export const PreviewPlayer: React.FC<PreviewPlayerProps> = ({
  canvasRef,
  canvasDims,
  aspectRatio,
  proxyMode,
  isPlaying,
  loop,
  playhead,
  totalDuration,
  fps,
  liveFps,
  clips,
  selectedClipId,
  onChangeAspectRatio,
  onToggleProxy,
  onTogglePlay,
  onSeek,
  onToggleLoop,
  onSelectClip,
  onUpdateClipLive,
  onSetDraggingPreview,
}) => {
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{
    clipId: string;
    track: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const getCanvasCoords = (ev: React.PointerEvent | PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
      y: ((ev.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
    };
  };

  const handlePointerDown = (ev: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.width;
    const H = canvas.height;
    const pt = getCanvasCoords(ev);
    const refScale = Math.min(W, H) / 720;

    // Pick topmost clip at playhead: fx -> image -> video
    const activeFx = clips.filter(
      (c) => c.track === 'fx' && playhead >= c.timelineStart && playhead < c.timelineStart + c.duration
    );
    let target = activeFx
      .slice()
      .reverse()
      .find((fc) => {
        if (!fc.fxData) return false;
        const fxX = (fc.fxData.x / 100) * W;
        const fxY = (fc.fxData.y / 100) * H;
        return Math.abs(pt.x - fxX) < 160 * refScale && Math.abs(pt.y - fxY) < 55 * refScale;
      });

    if (!target) {
      const activeImgs = clips.filter(
        (c) => c.track === 'image' && playhead >= c.timelineStart && playhead < c.timelineStart + c.duration
      );
      target = activeImgs.find((c) => c.id === selectedClipId) || activeImgs[activeImgs.length - 1];
    }

    if (!target) {
      target = clips.find(
        (c) => c.track === 'video' && playhead >= c.timelineStart && playhead < c.timelineStart + c.duration
      );
    }

    if (!target) return;
    onSelectClip(target.id);
    setDragging(true);
    onSetDraggingPreview(true);

    const origX = target.track === 'fx' && target.fxData ? target.fxData.x : target.x;
    const origY = target.track === 'fx' && target.fxData ? target.fxData.y : target.y;

    dragStartRef.current = {
      clipId: target.id,
      track: target.track,
      startX: pt.x,
      startY: pt.y,
      origX,
      origY,
    };

    const onMove = (m: PointerEvent) => {
      const ds = dragStartRef.current;
      if (!ds) return;
      const cur = getCanvasCoords(m);
      const dx = cur.x - ds.startX;
      const dy = cur.y - ds.startY;

      if (ds.track === 'fx' && target?.fxData) {
        let nx = clamp(Math.round(ds.origX + (dx / W) * 100), 5, 95);
        let ny = clamp(Math.round(ds.origY + (dy / H) * 100), 5, 95);
        if (Math.abs(nx - 50) <= 1) nx = 50;
        if (Math.abs(ny - 50) <= 1) ny = 50;
        onUpdateClipLive(ds.clipId, { fxData: { ...target.fxData, x: nx, y: ny } }, false);
      } else {
        let nx = clamp(Math.round(ds.origX + dx * (1280 / W)), -600, 600);
        let ny = clamp(Math.round(ds.origY + dy * (720 / H)), -600, 600);
        if (Math.abs(nx) <= 10) nx = 0;
        if (Math.abs(ny) <= 10) ny = 0;
        onUpdateClipLive(ds.clipId, { x: nx, y: ny }, false);
      }
    };

    const onUp = () => {
      setDragging(false);
      onSetDraggingPreview(false);
      dragStartRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const handleWheel = (ev: React.WheelEvent) => {
    const target =
      clips.find(
        (c) =>
          c.id === selectedClipId &&
          c.track !== 'audio' &&
          playhead >= c.timelineStart &&
          playhead < c.timelineStart + c.duration
      ) ||
      clips.find(
        (c) =>
          (c.track === 'image' || c.track === 'video') &&
          playhead >= c.timelineStart &&
          playhead < c.timelineStart + c.duration
      );

    if (!target) return;
    if (target.track === 'fx' && target.fxData) {
      const nextSize = clamp(target.fxData.fontSize + (ev.deltaY < 0 ? 2 : -2), 16, 96);
      onUpdateClipLive(target.id, { fxData: { ...target.fxData, fontSize: nextSize } }, false);
    } else {
      const nextScale = clamp(target.scale + (ev.deltaY < 0 ? 5 : -5), 20, 250);
      onUpdateClipLive(target.id, { scale: nextScale }, false);
    }
  };

  return (
    <section className="panel player-panel">
      <div className="player-header">
        <div className="segmented" role="group" aria-label="สัดส่วนหน้าจอ">
          {(['16:9', '9:16', '1:1'] as AspectRatio[]).map((ratio) => (
            <button
              key={ratio}
              className={`segmented-btn ${aspectRatio === ratio ? 'active' : ''}`}
              onClick={() => onChangeAspectRatio(ratio)}
            >
              {ratio}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {isPlaying ? `${liveFps} FPS` : `${canvasDims[0]}×${canvasDims[1]}`}
          </span>
          <button
            className={`btn ${proxyMode ? 'btn-primary' : 'btn-secondary'}`}
            style={{ height: 26, padding: '0 10px', fontSize: 11 }}
            onClick={onToggleProxy}
            title="ลดความละเอียดพรีวิวลง 50% เพื่อให้ตัดต่อลื่นขึ้น"
          >
            Proxy {proxyMode ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      <div className="player-stage">
        <canvas
          ref={canvasRef}
          width={canvasDims[0]}
          height={canvasDims[1]}
          className="preview-canvas"
          style={{ cursor: dragging ? 'grabbing' : 'grab' }}
          onPointerDown={handlePointerDown}
          onWheel={handleWheel}
        />
        {clips.length === 0 && (
          <div className="stage-empty">
            <Film size={32} strokeWidth={1.5} />
            <div style={{ fontSize: 13, fontWeight: 600, color: '#e4e4e7' }}>ยังไม่มีสื่อในไทม์ไลน์</div>
            <div style={{ fontSize: 12, color: '#a1a1aa' }}>
              นำเข้าวิดีโอหรือรูปภาพจากแถบด้านซ้าย แล้วกด + เพื่อเริ่มตัดต่อ
            </div>
          </div>
        )}
      </div>

      <div className="player-transport">
        <div className="timecode">
          <span>{formatTimecode(playhead, fps)}</span>
          <span className="timecode-muted"> / {formatTimecode(totalDuration, fps)}</span>
        </div>

        <div className="player-transport-controls">
          <button className="btn btn-ghost btn-icon" onClick={() => onSeek(0)} title="กลับไปจุดเริ่มต้น">
            <SkipBack size={15} />
          </button>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => onSeek(playhead - 1 / fps)}
            title="ถอยหลัง 1 เฟรม"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            className={`btn play-toggle-btn ${isPlaying ? 'btn-dark' : 'btn-primary'}`}
            onClick={onTogglePlay}
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            <span>{isPlaying ? 'หยุด' : 'เล่น'}</span>
          </button>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => onSeek(playhead + 1 / fps)}
            title="เดินหน้า 1 เฟรม"
          >
            <ChevronRight size={16} />
          </button>
          <button
            className={`btn btn-icon ${loop ? 'btn-primary' : 'btn-ghost'}`}
            onClick={onToggleLoop}
            title="เล่นวนซ้ำ"
          >
            <Repeat size={14} />
          </button>
        </div>

        <div className="hide-mobile" style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          ลากบนจอ: ย้าย • ลูกกลิ้ง: ซูม
        </div>
      </div>
    </section>
  );
};
