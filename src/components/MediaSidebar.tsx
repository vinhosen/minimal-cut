import React, { useRef, useState } from 'react';
import {
  Film,
  Type,
  Sliders,
  Mic,
  Sparkles,
  Upload,
  Plus,
  Music,
  Image as ImageIcon,
  FileDown,
  FileUp,
  Square,
} from 'lucide-react';
import type { ColorSettings, LutPreset, MediaAsset, TextStyleType } from '../types/editor';

type SidebarTab = 'media' | 'text' | 'color' | 'audio' | 'ai';

interface MediaSidebarProps {
  assets: MediaAsset[];
  colors: ColorSettings;
  isRecordingMic: boolean;
  micStatus: string;
  audioDb: string;
  analyserRef: React.RefObject<AnalyserNode | null>;
  aiLogs: string[];
  isTranscribing: boolean;
  whisperProvider: 'gemini' | 'groq' | 'openai';
  whisperApiKey: string;
  onImportFiles: (files: FileList) => void;
  onAddAssetToTimeline: (asset: MediaAsset) => void;
  onAddTextClip: (text: string, style: TextStyleType, y?: number, dur?: number) => void;
  onUpdateColors: (patch: Partial<ColorSettings>) => void;
  onImportSrt: (file: File) => void;
  onExportSrt: () => void;
  onExportProject: () => void;
  onImportProject: (file: File) => void;
  onToggleMicRecord: () => void;
  onChangeWhisperProvider: (p: 'gemini' | 'groq' | 'openai') => void;
  onChangeWhisperKey: (k: string) => void;
  onAiAutoSub: () => void;
  onAiSilenceCut: () => void;
  onAiSplitHalf: () => void;
  onAiAutoShorts: () => void;
}

export const MediaSidebar: React.FC<MediaSidebarProps> = ({
  assets,
  colors,
  isRecordingMic,
  micStatus,
  audioDb,
  aiLogs,
  isTranscribing,
  whisperProvider,
  whisperApiKey,
  onImportFiles,
  onAddAssetToTimeline,
  onAddTextClip,
  onUpdateColors,
  onImportSrt,
  onExportSrt,
  onExportProject,
  onImportProject,
  onToggleMicRecord,
  onChangeWhisperProvider,
  onChangeWhisperKey,
  onAiAutoSub,
  onAiSilenceCut,
  onAiSplitHalf,
  onAiAutoShorts,
}) => {
  const [tab, setTab] = useState<SidebarTab>('media');
  const [isDragOver, setIsDragOver] = useState(false);
  const [draftText, setDraftText] = useState('ข้อความของคุณ');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);
  const projInputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length) {
      onImportFiles(e.dataTransfer.files);
    }
  };

  return (
    <aside className="panel sidebar-left">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="video/*,image/*,audio/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length) onImportFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={srtInputRef}
        type="file"
        accept=".srt,text/plain"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.[0]) onImportSrt(e.target.files[0]);
          e.target.value = '';
        }}
      />
      <input
        ref={projInputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.[0]) onImportProject(e.target.files[0]);
          e.target.value = '';
        }}
      />

      {/* CapCut-style Vertical Rail */}
      <nav className="rail" aria-label="หมวดหมู่เครื่องมือ">
        <button className={`rail-item ${tab === 'media' ? 'active' : ''}`} onClick={() => setTab('media')}>
          <Film size={17} />
          <span>สื่อ</span>
        </button>
        <button className={`rail-item ${tab === 'text' ? 'active' : ''}`} onClick={() => setTab('text')}>
          <Type size={17} />
          <span>ข้อความ</span>
        </button>
        <button className={`rail-item ${tab === 'color' ? 'active' : ''}`} onClick={() => setTab('color')}>
          <Sliders size={17} />
          <span>สี/FX</span>
        </button>
        <button className={`rail-item ${tab === 'audio' ? 'active' : ''}`} onClick={() => setTab('audio')}>
          <Mic size={17} />
          <span>เสียง</span>
        </button>
        <button className={`rail-item ${tab === 'ai' ? 'active' : ''}`} onClick={() => setTab('ai')}>
          <Sparkles size={17} />
          <span>อัตโนมัติ</span>
        </button>
      </nav>

      {/* Drawer Content */}
      <div className="drawer">
        <div className="drawer-header">
          <span className="drawer-title">
            {tab === 'media' && 'คลังสื่อ & โปรเจกต์'}
            {tab === 'text' && 'ข้อความ & ซับไตเติล'}
            {tab === 'color' && 'โทนสี & เอฟเฟกต์'}
            {tab === 'audio' && 'อัดเสียง & ระบบเสียง'}
            {tab === 'ai' && 'ผู้ช่วยอัตโนมัติ'}
          </span>
          {tab === 'media' && (
            <button
              className="btn btn-primary"
              style={{ height: 26, padding: '0 10px', fontSize: 11 }}
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus size={13} /> นำเข้า
            </button>
          )}
        </div>

        <div className="drawer-body">
          {tab === 'media' && (
            <>
              <div
                className={`dropzone ${isDragOver ? 'dragover' : ''}`}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragOver(true);
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleDrop}
              >
                <Upload size={20} style={{ color: 'var(--text-muted)', marginBottom: 6 }} />
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                  ลากไฟล์มาวาง หรือคลิกเลือก
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  วิดีโอ, รูปภาพ, เสียง (โหลดทันที)
                </div>
              </div>

              <div className="asset-grid">
                {assets.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '16px 8px' }}>
                    ยังไม่มีไฟล์ในคลัง
                  </div>
                ) : (
                  assets.map((asset) => (
                    <div key={asset.id} className="asset-card">
                      <div className="asset-thumb">
                        {asset.type === 'video' && <Film size={16} />}
                        {asset.type === 'image' && <ImageIcon size={16} />}
                        {asset.type === 'audio' && <Music size={16} />}
                      </div>
                      <div className="asset-info">
                        <div className="asset-name" title={asset.name}>
                          {asset.name}
                        </div>
                        <div className="asset-meta">
                          {asset.type === 'image' ? `${asset.width}×${asset.height}` : `${asset.duration.toFixed(1)} วิ`}
                        </div>
                      </div>
                      <button
                        className="btn btn-secondary btn-icon"
                        title="เพิ่มลงไทม์ไลน์"
                        onClick={() => onAddAssetToTimeline(asset)}
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>

              <div className="insp-section" style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: 12, borderBottom: 'none' }}>
                <div className="insp-heading">ไฟล์โปรเจกต์ (.JSON)</div>
                <div className="grid-2">
                  <button className="btn btn-secondary" onClick={onExportProject}>
                    <FileDown size={13} /> ส่งออกงาน
                  </button>
                  <button className="btn btn-secondary" onClick={() => projInputRef.current?.click()}>
                    <FileUp size={13} /> เปิดโปรเจกต์
                  </button>
                </div>
              </div>
            </>
          )}

          {tab === 'text' && (
            <>
              <div className="control-row">
                <label className="control-label">ข้อความเริ่มต้น</label>
                <input
                  className="input"
                  value={draftText}
                  onChange={(e) => setDraftText(e.target.value)}
                  placeholder="พิมพ์ข้อความ..."
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(
                  [
                    { style: 'subtitle', label: 'ซับไตเติล (Subtitle)', desc: 'ตัวอักษรขอบชัด อ่านง่าย' },
                    { style: 'title', label: 'หัวข้อใหญ่ (Title)', desc: 'ตัวหนาพร้อมเงา' },
                    { style: 'lowerthird', label: 'แถบชื่อผู้พูด (Lower Third)', desc: 'ป้ายขาวแถบสีด้านซ้าย' },
                    { style: 'badge', label: 'ป้ายแคปซูล (Badge)', desc: 'พื้นหลังสีทึบขอบมน' },
                    { style: 'sticker', label: 'สติกเกอร์ ✨', desc: 'ข้อความตกแต่งประกาย' },
                    { style: 'shape', label: 'กรอบสี่เหลี่ยม', desc: 'กรอบเน้นจุดสำคัญ' },
                  ] as { style: TextStyleType; label: string; desc: string }[]
                ).map((preset) => (
                  <button
                    key={preset.style}
                    className="asset-card"
                    style={{ cursor: 'pointer', textAlign: 'left', width: '100%' }}
                    onClick={() => onAddTextClip(draftText.trim() || 'ข้อความ', preset.style)}
                  >
                    <div className="asset-info">
                      <div className="asset-name">{preset.label}</div>
                      <div className="asset-meta">{preset.desc}</div>
                    </div>
                    <Plus size={14} style={{ color: 'var(--text-secondary)' }} />
                  </button>
                ))}
              </div>

              <div className="insp-section" style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: 12 }}>
                <div className="insp-heading">เทมเพลตด่วน</div>
                <div className="grid-2">
                  <button
                    className="btn btn-secondary"
                    onClick={() => onAddTextClip('ยินดีต้อนรับ', 'badge', 50, 3)}
                  >
                    + ป้ายเปิดคลิป
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => onAddTextClip('ผู้บรรยาย: คุณวิน', 'lowerthird', 82, 4)}
                  >
                    + แถบชื่อผู้พูด
                  </button>
                </div>
              </div>

              <div className="insp-section" style={{ borderBottom: 'none' }}>
                <div className="insp-heading">จัดการซับไตเติล (.SRT)</div>
                <div className="grid-2">
                  <button className="btn btn-secondary" onClick={() => srtInputRef.current?.click()}>
                    <FileUp size={13} /> นำเข้า .SRT
                  </button>
                  <button className="btn btn-secondary" onClick={onExportSrt}>
                    <FileDown size={13} /> ส่งออก .SRT
                  </button>
                </div>
              </div>
            </>
          )}

          {tab === 'color' && (
            <>
              <div className="control-row">
                <span className="control-label">โทนสีสำเร็จรูป (LUT)</span>
                <div className="grid-2">
                  {(
                    [
                      { id: 'normal', label: 'ปกติ' },
                      { id: 'vivid', label: 'สดใส' },
                      { id: 'warm', label: 'โทนอุ่น' },
                      { id: 'matrix', label: 'โทนเขียว' },
                      { id: 'noir', label: 'ขาวดำ' },
                    ] as { id: LutPreset; label: string }[]
                  ).map((lut) => (
                    <button
                      key={lut.id}
                      className={`btn ${colors.lut === lut.id ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => onUpdateColors({ lut: lut.id })}
                    >
                      {lut.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="control-row">
                <div className="control-label">
                  <span>ความสว่าง</span>
                  <span className="control-value">{colors.brightness}%</span>
                </div>
                <input
                  type="range"
                  className="slider"
                  min={50}
                  max={175}
                  value={colors.brightness}
                  onChange={(e) => onUpdateColors({ brightness: +e.target.value })}
                />
              </div>

              <div className="control-row">
                <div className="control-label">
                  <span>ความคมชัด (Contrast)</span>
                  <span className="control-value">{colors.contrast}%</span>
                </div>
                <input
                  type="range"
                  className="slider"
                  min={50}
                  max={175}
                  value={colors.contrast}
                  onChange={(e) => onUpdateColors({ contrast: +e.target.value })}
                />
              </div>

              <div className="control-row">
                <div className="control-label">
                  <span>ความสดของสี</span>
                  <span className="control-value">{colors.saturation}%</span>
                </div>
                <input
                  type="range"
                  className="slider"
                  min={0}
                  max={200}
                  value={colors.saturation}
                  onChange={(e) => onUpdateColors({ saturation: +e.target.value })}
                />
              </div>

              <div className="grid-2">
                <div className="control-row">
                  <div className="control-label">
                    <span>เบลอภาพ</span>
                    <span className="control-value">{colors.blur}px</span>
                  </div>
                  <input
                    type="range"
                    className="slider"
                    min={0}
                    max={12}
                    value={colors.blur}
                    onChange={(e) => onUpdateColors({ blur: +e.target.value })}
                  />
                </div>
                <div className="control-row">
                  <div className="control-label">
                    <span>ขอบมืด</span>
                    <span className="control-value">{colors.vignette}%</span>
                  </div>
                  <input
                    type="range"
                    className="slider"
                    min={0}
                    max={100}
                    value={colors.vignette}
                    onChange={(e) => onUpdateColors({ vignette: +e.target.value })}
                  />
                </div>
              </div>

              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, cursor: 'pointer' }}>
                <span>เอฟเฟกต์ภาพสั่น (Glitch)</span>
                <input
                  type="checkbox"
                  checked={colors.glitch}
                  onChange={(e) => onUpdateColors({ glitch: e.target.checked })}
                />
              </label>

              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, cursor: 'pointer' }}>
                <span>ลบฉากหลังสีเขียว (Chroma Key)</span>
                <input
                  type="checkbox"
                  checked={colors.chromaKey}
                  onChange={(e) => onUpdateColors({ chromaKey: e.target.checked })}
                />
              </label>

              <button
                className="btn btn-secondary"
                onClick={() =>
                  onUpdateColors({
                    lut: 'normal',
                    brightness: 100,
                    contrast: 100,
                    saturation: 100,
                    blur: 0,
                    vignette: 0,
                    glitch: false,
                    chromaKey: false,
                  })
                }
              >
                รีเซ็ตสี & เอฟเฟกต์
              </button>
            </>
          )}

          {tab === 'audio' && (
            <>
              <div className="insp-section">
                <div className="insp-heading">อัดเสียงพากย์ผ่านไมโครโฟน</div>
                <button
                  className={`btn ${isRecordingMic ? 'btn-dark' : 'btn-primary'}`}
                  onClick={onToggleMicRecord}
                >
                  {isRecordingMic ? <Square size={13} /> : <Mic size={13} />}
                  <span>{isRecordingMic ? 'หยุดอัดเสียง' : 'เริ่มอัดเสียงพากย์'}</span>
                </button>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{micStatus}</div>
              </div>

              <div className="insp-section">
                <div className="insp-heading">ปรับแต่งเสียงอัตโนมัติ</div>
                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, cursor: 'pointer' }}>
                  <span>ลดเสียงรบกวน (HPF + Compressor)</span>
                  <input
                    type="checkbox"
                    checked={colors.noiseReduce}
                    onChange={(e) => onUpdateColors({ noiseReduce: e.target.checked })}
                  />
                </label>
              </div>

              <div className="insp-section" style={{ borderBottom: 'none' }}>
                <div className="control-label">
                  <span>ความดังเสียงเรียลไทม์</span>
                  <span className="control-value">{audioDb}</span>
                </div>
              </div>
            </>
          )}

          {tab === 'ai' && (
            <>
              <div className="insp-section">
                <div className="insp-heading">AI สร้างซับไตเติลอัตโนมัติ</div>
                <select
                  className="select"
                  value={whisperProvider}
                  onChange={(e) => onChangeWhisperProvider(e.target.value as 'gemini' | 'groq' | 'openai')}
                >
                  <option value="gemini">Google AI Studio (Gemini 2.5 Flash)</option>
                  <option value="groq">Groq Whisper (whisper-large-v3)</option>
                  <option value="openai">OpenAI Whisper (whisper-1)</option>
                </select>
                <input
                  type="password"
                  className="input"
                  value={whisperApiKey}
                  onChange={(e) => onChangeWhisperKey(e.target.value)}
                  placeholder="วาง API Key (เก็บในเครื่องเท่านั้น)"
                />
                <button className="btn btn-primary" onClick={onAiAutoSub} disabled={isTranscribing}>
                  <Sparkles size={13} />
                  <span>{isTranscribing ? 'กำลังถอดเสียง...' : 'สร้างซับไตเติลอัตโนมัติ'}</span>
                </button>
              </div>

              <div className="insp-section">
                <div className="insp-heading">เครื่องมือช่วยตัดต่อเร็ว</div>
                <button className="btn btn-secondary" onClick={onAiSilenceCut}>
                  ตัดช่วงเงียบในคลิปเสียง (Worker)
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => onUpdateColors({ chromaKey: !colors.chromaKey })}
                >
                  {colors.chromaKey ? 'ปิดลบฉากสีเขียว' : 'เปิดลบฉากสีเขียวอัตโนมัติ'}
                </button>
                <button className="btn btn-secondary" onClick={onAiSplitHalf}>
                  แบ่งครึ่งคลิปวิดีโออัตโนมัติ
                </button>
                <button className="btn btn-secondary" onClick={onAiAutoShorts}>
                  ปรับเป็นแนวตั้ง 9:16 (Shorts)
                </button>
              </div>

              <div
                style={{
                  background: 'var(--bg-app)',
                  border: '1px solid var(--border-hairline)',
                  borderRadius: 8,
                  padding: 8,
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  maxHeight: 110,
                  overflowY: 'auto',
                }}
              >
                {aiLogs.map((l, i) => (
                  <div key={i}>• {l}</div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  );
};
