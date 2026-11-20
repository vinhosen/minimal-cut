import React from 'react';
import { Scissors, Undo2, Redo2, Download, Trash2, HardDrive } from 'lucide-react';
import type { ExportFps, ExportResolution } from '../types/editor';
import type { Capabilities } from '../utils/capabilities';

interface TopBarProps {
  fps: ExportFps;
  resolution: ExportResolution;
  canUndo: boolean;
  canRedo: boolean;
  hasClips: boolean;
  webCodecsSupported: boolean;
  capabilities?: Capabilities;
  autosaveLabel?: string;
  onUndo: () => void;
  onRedo: () => void;
  onClearProject: () => void;
  onOpenExport: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  fps,
  resolution,
  canUndo,
  canRedo,
  hasClips,
  webCodecsSupported,
  capabilities,
  autosaveLabel,
  onUndo,
  onRedo,
  onClearProject,
  onOpenExport,
}) => {
  const resLabel = resolution === 2160 ? '4K' : resolution === 1440 ? '2K' : `${resolution}p`;

  const capSummary = capabilities
    ? [
        `Engine: FilmCraft ${capabilities.engine.toUpperCase()} (${capabilities.compositor.toUpperCase()})`,
        `WebCodecs Encode: ${capabilities.webCodecsEncode ? 'พร้อม' : 'ไม่รองรับ'}`,
        `WebCodecs Decode: ${capabilities.webCodecsDecode ? 'พร้อม' : 'Fallback'}`,
        `OPFS Storage: ${capabilities.opfs ? 'พร้อม' : 'IndexedDB Fallback'}`,
        `COOP/COEP Isolated: ${capabilities.crossOriginIsolated ? 'ใช่' : 'ไม่ใช่'}`,
      ].join(' • ')
    : webCodecsSupported
      ? 'พร้อม Export 120 FPS แบบ Offline'
      : 'ใช้ MediaRecorder';

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand-mark">
          <div className="brand-badge">
            <Scissors size={15} />
          </div>
          <span>MinimalCut</span>
        </div>
        <div className="topbar-divider hide-mobile" />
        <div className="status-pill hide-mobile" title={capSummary}>
          <span className="status-dot" />
          <span>
            {webCodecsSupported
              ? capabilities?.webgl2
                ? 'FilmCraft GPU + WebCodecs'
                : 'WebCodecs พร้อมใช้'
              : 'โหมดมาตรฐาน'}
          </span>
        </div>
        {autosaveLabel && (
          <div className="status-pill hide-mobile" title="ระบบบันทึกอัตโนมัติ (FilmCraft OPFS / IndexedDB)">
            <HardDrive size={12} />
            <span>{autosaveLabel}</span>
          </div>
        )}
      </div>

      <div className="topbar-center">
        <button className="btn btn-ghost btn-icon" onClick={onUndo} disabled={!canUndo} title="ย้อนกลับ (Ctrl+Z)">
          <Undo2 size={15} />
        </button>
        <button className="btn btn-ghost btn-icon" onClick={onRedo} disabled={!canRedo} title="ทำซ้ำ (Ctrl+Y)">
          <Redo2 size={15} />
        </button>
        <div className="topbar-divider hide-xs" />
        <span className="status-pill hide-xs">
          {resLabel} • {fps} FPS
        </span>
      </div>

      <div className="topbar-right">
        <button
          className="btn btn-ghost"
          onClick={onClearProject}
          disabled={!hasClips}
          title="ล้างโปรเจกต์เพื่อเริ่มใหม่"
        >
          <Trash2 size={14} />
          <span className="hide-xs">เริ่มใหม่</span>
        </button>
        <button className="btn btn-dark" onClick={onOpenExport} disabled={!hasClips}>
          <Download size={14} />
          <span>
            Export<span className="hide-xs"> วิดีโอ</span>
          </span>
        </button>
      </div>
    </header>
  );
};
