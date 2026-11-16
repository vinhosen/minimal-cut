import React from 'react';
import { X, Download, CheckCircle2, Loader2 } from 'lucide-react';
import type { ExportFps, ExportResolution, ExportSettings } from '../types/editor';
import type { ExportProgress } from '../utils/exporter';

interface ExportModalProps {
  isOpen: boolean;
  isExporting: boolean;
  settings: ExportSettings;
  progress: ExportProgress | null;
  error: string | null;
  doneInfo: { filename: string; sizeMb: string; engine: string } | null;
  onUpdateSettings: (patch: Partial<ExportSettings>) => void;
  onStartExport: () => void;
  onCancelExport: () => void;
  onClose: () => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  isExporting,
  settings,
  progress,
  error,
  doneInfo,
  onUpdateSettings,
  onStartExport,
  onCancelExport,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
            Export วิดีโอ
          </h2>
          {!isExporting && (
            <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="ปิด">
              <X size={16} />
            </button>
          )}
        </div>

        {!isExporting && !doneInfo && (
          <>
            <div className="control-row">
              <label className="control-label">ความละเอียด</label>
              <select
                className="select"
                value={settings.resolution}
                onChange={(e) => onUpdateSettings({ resolution: +e.target.value as ExportResolution })}
              >
                <option value={2160}>4K UHD (2160p)</option>
                <option value={1440}>2K QHD (1440p)</option>
                <option value={1080}>Full HD (1080p)</option>
                <option value={720}>HD (720p)</option>
                <option value={480}>SD (480p)</option>
              </select>
            </div>

            <div className="grid-2">
              <div className="control-row">
                <label className="control-label">เฟรมเรต (FPS)</label>
                <select
                  className="select"
                  value={settings.fps}
                  onChange={(e) => onUpdateSettings({ fps: +e.target.value as ExportFps })}
                >
                  <option value={24}>24 FPS</option>
                  <option value={30}>30 FPS</option>
                  <option value={60}>60 FPS</option>
                  <option value={120}>120 FPS (ลื่นพิเศษ)</option>
                </select>
              </div>
              <div className="control-row">
                <label className="control-label">บิตเรต</label>
                <select
                  className="select"
                  value={settings.bitrateMbps}
                  onChange={(e) => onUpdateSettings({ bitrateMbps: +e.target.value })}
                >
                  <option value={5}>5 Mbps</option>
                  <option value={10}>10 Mbps</option>
                  <option value={20}>20 Mbps</option>
                  <option value={35}>35 Mbps</option>
                </select>
              </div>
            </div>

            {error && (
              <div
                style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: 'var(--danger-soft)',
                  color: 'var(--danger)',
                  fontSize: 12,
                }}
              >
                {error}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button className="btn btn-secondary" onClick={onClose}>
                ยกเลิก
              </button>
              <button className="btn btn-primary" onClick={onStartExport}>
                <Download size={14} /> เริ่มบันทึก MP4
              </button>
            </div>
          </>
        )}

        {isExporting && progress && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
                <Loader2 size={14} className="spin" />
                {progress.message}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{progress.percent}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={onCancelExport}>
                ยกเลิก
              </button>
            </div>
          </div>
        )}

        {doneInfo && !isExporting && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: 12,
                borderRadius: 10,
                background: 'var(--success-soft)',
                color: '#065f46',
              }}
            >
              <CheckCircle2 size={20} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>บันทึกไฟล์สำเร็จ!</div>
                <div style={{ fontSize: 11 }}>
                  {doneInfo.filename} ({doneInfo.sizeMb} MB • {doneInfo.engine === 'webcodecs' ? 'WebCodecs MP4' : 'MediaRecorder'})
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-dark" onClick={onClose}>
                เสร็จสิ้น
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
