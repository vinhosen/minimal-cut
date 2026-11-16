import React from 'react';
import { FlipHorizontal, FlipVertical, KeyRound, Camera, Volume2, RotateCcw } from 'lucide-react';
import type {
  ExportFps,
  ExportResolution,
  ExportSettings,
  MaskType,
  TextAnimType,
  TextStyleType,
  TimelineClip,
  TransitionType,
} from '../types/editor';

interface InspectorPanelProps {
  selectedClip: TimelineClip | null;
  exportSettings: ExportSettings;
  onUpdateExportSettings: (patch: Partial<ExportSettings>) => void;
  onUpdateClip: (id: string, patch: Partial<TimelineClip>, commitHistory?: boolean) => void;
  onAddVideoKeyframe: (clipId: string) => void;
  onClearVideoKeyframes: (clipId: string) => void;
  onFreezeFrame: (clipId: string) => void;
  onDetachAudio: (clipId: string) => void;
  onAddAudioKeyframe: (clipId: string) => void;
  onNormalizeAudio: (clipId: string) => void;
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  selectedClip,
  exportSettings,
  onUpdateExportSettings,
  onUpdateClip,
  onAddVideoKeyframe,
  onClearVideoKeyframes,
  onFreezeFrame,
  onDetachAudio,
  onAddAudioKeyframe,
  onNormalizeAudio,
}) => {
  return (
    <aside className="panel inspector-panel">
      <div className="drawer-header">
        <span className="drawer-title">
          {!selectedClip && 'ตั้งค่าโปรเจกต์'}
          {selectedClip?.track === 'video' && 'ปรับแต่งวิดีโอ'}
          {selectedClip?.track === 'image' && 'ปรับแต่งรูปภาพ'}
          {selectedClip?.track === 'fx' && 'ปรับแต่งข้อความ'}
          {selectedClip?.track === 'audio' && 'ปรับแต่งเสียง'}
        </span>
      </div>

      <div className="inspector-body">
        {!selectedClip && (
          <div className="insp-section">
            <div className="insp-heading">คุณภาพและเฟรมเรต</div>
            <div className="control-row">
              <label className="control-label">ความละเอียด (Resolution)</label>
              <select
                className="select"
                value={exportSettings.resolution}
                onChange={(e) => onUpdateExportSettings({ resolution: +e.target.value as ExportResolution })}
              >
                <option value={2160}>4K UHD (2160p)</option>
                <option value={1440}>2K QHD (1440p)</option>
                <option value={1080}>Full HD (1080p)</option>
                <option value={720}>HD (720p)</option>
                <option value={480}>SD (480p)</option>
              </select>
            </div>

            <div className="control-row">
              <label className="control-label">ความลื่นไหล (FPS)</label>
              <select
                className="select"
                value={exportSettings.fps}
                onChange={(e) => onUpdateExportSettings({ fps: +e.target.value as ExportFps })}
              >
                <option value={24}>24 FPS (ภาพยนตร์)</option>
                <option value={30}>30 FPS (มาตรฐาน)</option>
                <option value={60}>60 FPS (ลื่นไหล)</option>
                <option value={120}>120 FPS (ลื่นพิเศษ • WebCodecs)</option>
              </select>
            </div>

            <div className="control-row">
              <label className="control-label">บิตเรต (Bitrate)</label>
              <select
                className="select"
                value={exportSettings.bitrateMbps}
                onChange={(e) => onUpdateExportSettings({ bitrateMbps: +e.target.value })}
              >
                <option value={5}>5 Mbps (ไฟล์เล็ก)</option>
                <option value={10}>10 Mbps (คมชัดปกติ)</option>
                <option value={20}>20 Mbps (สำหรับ 2K / 60FPS)</option>
                <option value={35}>35 Mbps (สำหรับ 4K / 120FPS)</option>
              </select>
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, marginTop: 4 }}>
              คลิกที่คลิปบนแถบเวลา (Timeline) ด้านล่างเพื่อปรับแต่งตำแหน่ง ขนาด ความเร็ว หรือข้อความ
            </div>
          </div>
        )}

        {(selectedClip?.track === 'video' || selectedClip?.track === 'image') && (
          <>
            <div className="insp-section">
              <div className="insp-heading">ตำแหน่งและขนาด</div>
              <div className="control-row">
                <div className="control-label">
                  <span>ย่อ-ขยาย (Scale)</span>
                  <span className="control-value">{selectedClip.scale}%</span>
                </div>
                <input
                  type="range"
                  className="slider"
                  min={20}
                  max={250}
                  value={selectedClip.scale}
                  onChange={(e) => onUpdateClip(selectedClip.id, { scale: +e.target.value }, false)}
                />
              </div>

              <div className="grid-2">
                <div className="control-row">
                  <div className="control-label">
                    <span>แกน X</span>
                    <span className="control-value">{selectedClip.x}</span>
                  </div>
                  <input
                    type="range"
                    className="slider"
                    min={-500}
                    max={500}
                    value={selectedClip.x}
                    onChange={(e) => onUpdateClip(selectedClip.id, { x: +e.target.value }, false)}
                  />
                </div>
                <div className="control-row">
                  <div className="control-label">
                    <span>แกน Y</span>
                    <span className="control-value">{selectedClip.y}</span>
                  </div>
                  <input
                    type="range"
                    className="slider"
                    min={-500}
                    max={500}
                    value={selectedClip.y}
                    onChange={(e) => onUpdateClip(selectedClip.id, { y: +e.target.value }, false)}
                  />
                </div>
              </div>

              <div className="grid-2">
                <div className="control-row">
                  <div className="control-label">
                    <span>หมุน</span>
                    <span className="control-value">{selectedClip.rotation}°</span>
                  </div>
                  <input
                    type="range"
                    className="slider"
                    min={-180}
                    max={180}
                    value={selectedClip.rotation}
                    onChange={(e) => onUpdateClip(selectedClip.id, { rotation: +e.target.value }, false)}
                  />
                </div>
                <div className="control-row">
                  <div className="control-label">
                    <span>ความชัด (Opacity)</span>
                    <span className="control-value">{selectedClip.opacity}%</span>
                  </div>
                  <input
                    type="range"
                    className="slider"
                    min={0}
                    max={100}
                    value={selectedClip.opacity}
                    onChange={(e) => onUpdateClip(selectedClip.id, { opacity: +e.target.value }, false)}
                  />
                </div>
              </div>

              <div className="control-row">
                <div className="control-label">
                  <span>ตัดขอบ (Crop)</span>
                  <span className="control-value">{selectedClip.crop}%</span>
                </div>
                <input
                  type="range"
                  className="slider"
                  min={0}
                  max={40}
                  value={selectedClip.crop}
                  onChange={(e) => onUpdateClip(selectedClip.id, { crop: +e.target.value }, false)}
                />
              </div>

              <div className="grid-2">
                <button
                  className={`btn ${selectedClip.flipH ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => onUpdateClip(selectedClip.id, { flipH: !selectedClip.flipH }, true)}
                >
                  <FlipHorizontal size={13} /> พลิกซ้าย-ขวา
                </button>
                <button
                  className={`btn ${selectedClip.flipV ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => onUpdateClip(selectedClip.id, { flipV: !selectedClip.flipV }, true)}
                >
                  <FlipVertical size={13} /> พลิกบน-ล่าง
                </button>
              </div>

              <div className="grid-2" style={{ marginTop: 6 }}>
                <button
                  className="btn btn-secondary"
                  onClick={() => onAddVideoKeyframe(selectedClip.id)}
                  title="บันทึกตำแหน่ง/ขนาด ณ เวลาปัจจุบัน (Keyframe)"
                >
                  <KeyRound size={13} /> + จำตำแหน่งเคลื่อนไหว
                  {selectedClip.keyframes?.length ? ` (${selectedClip.keyframes.length})` : ''}
                </button>
                {selectedClip.keyframes?.length ? (
                  <button
                    className="btn btn-secondary"
                    onClick={() => onClearVideoKeyframes(selectedClip.id)}
                  >
                    ล้าง Keyframe
                  </button>
                ) : (
                  <div />
                )}
              </div>
            </div>

            <div className="insp-section">
              <div className="insp-heading">ความเร็วและเอฟเฟกต์</div>
              {selectedClip.track === 'video' && (
                <div className="control-row">
                  <label className="control-label">ความเร็วคลิป (Speed)</label>
                  <select
                    className="select"
                    value={selectedClip.speed}
                    onChange={(e) => {
                      const nextSpeed = +e.target.value;
                      const usedSrcDur = selectedClip.duration * selectedClip.speed;
                      onUpdateClip(
                        selectedClip.id,
                        { speed: nextSpeed, duration: Math.max(0.2, usedSrcDur / nextSpeed) },
                        true
                      );
                    }}
                  >
                    <option value={0.5}>0.5x (สโลว์)</option>
                    <option value={1}>1.0x (ปกติ)</option>
                    <option value={1.5}>1.5x (เร็ว)</option>
                    <option value={2}>2.0x (เร็วมาก)</option>
                    <option value={4}>4.0x (ไทม์แลปส์)</option>
                  </select>
                </div>
              )}

              <div className="grid-2">
                <div className="control-row">
                  <label className="control-label">เปลี่ยนฉาก</label>
                  <select
                    className="select"
                    value={selectedClip.transition}
                    onChange={(e) =>
                      onUpdateClip(selectedClip.id, { transition: e.target.value as TransitionType }, true)
                    }
                  >
                    <option value="none">ไม่มี</option>
                    <option value="fade">Fade</option>
                    <option value="dissolve">Dissolve (ซ้อนจาง)</option>
                    <option value="slide">Slide</option>
                  </select>
                </div>
                <div className="control-row">
                  <label className="control-label">กรอบภาพ (Mask)</label>
                  <select
                    className="select"
                    value={selectedClip.mask || 'none'}
                    onChange={(e) =>
                      onUpdateClip(selectedClip.id, { mask: e.target.value as MaskType }, true)
                    }
                  >
                    <option value="none">สี่เหลี่ยมปกติ</option>
                    <option value="circle">วงกลม (Circle)</option>
                    <option value="rounded">ขอบมน (Rounded)</option>
                  </select>
                </div>
              </div>

              <div className="control-row">
                <label className="control-label">โหมดซ้อนภาพ (Blend)</label>
                <select
                  className="select"
                  value={selectedClip.blend}
                  onChange={(e) =>
                    onUpdateClip(selectedClip.id, { blend: e.target.value as GlobalCompositeOperation }, true)
                  }
                >
                  <option value="source-over">ปกติ</option>
                  <option value="screen">Screen</option>
                  <option value="multiply">Multiply</option>
                  <option value="overlay">Overlay</option>
                </select>
              </div>

              {selectedClip.track === 'video' && (
                <div className="grid-2" style={{ marginTop: 6 }}>
                  <button
                    className="btn btn-secondary"
                    onClick={() => onFreezeFrame(selectedClip.id)}
                  >
                    <Camera size={13} /> หยุดภาพนิ่ง 2 วิ
                  </button>
                  <button
                    className={`btn ${selectedClip.reverse ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => onUpdateClip(selectedClip.id, { reverse: !selectedClip.reverse }, true)}
                  >
                    <RotateCcw size={13} /> เล่นย้อนกลับ
                  </button>
                </div>
              )}
            </div>

            {selectedClip.track === 'video' && (
              <div className="insp-section">
                <div className="insp-heading">เสียงของวิดีโอ</div>
                <div className="control-row">
                  <div className="control-label">
                    <span>ความดังเสียง</span>
                    <span className="control-value">{selectedClip.muted ? 'ปิดเสียง' : `${selectedClip.volume}%`}</span>
                  </div>
                  <input
                    type="range"
                    className="slider"
                    min={0}
                    max={150}
                    value={selectedClip.muted ? 0 : selectedClip.volume}
                    onChange={(e) =>
                      onUpdateClip(selectedClip.id, { volume: +e.target.value, muted: +e.target.value === 0 }, false)
                    }
                  />
                </div>
                <button
                  className="btn btn-secondary"
                  style={{ width: '100%', marginTop: 4 }}
                  onClick={() => onDetachAudio(selectedClip.id)}
                >
                  <Volume2 size={13} /> แยกเสียงออกจากวิดีโอ
                </button>
              </div>
            )}
          </>
        )}

        {selectedClip?.track === 'fx' && selectedClip.fxData && (
          <div className="insp-section">
            <div className="insp-heading">ข้อความและรูปแบบ</div>
            <div className="control-row">
              <label className="control-label">เนื้อหาข้อความ</label>
              <input
                className="input"
                value={selectedClip.fxData.text}
                onChange={(e) =>
                  onUpdateClip(
                    selectedClip.id,
                    {
                      name: e.target.value.slice(0, 18) || 'ข้อความ',
                      fxData: { ...selectedClip.fxData!, text: e.target.value },
                    },
                    false
                  )
                }
              />
            </div>

            <div className="grid-2">
              <div className="control-row">
                <label className="control-label">รูปแบบ</label>
                <select
                  className="select"
                  value={selectedClip.fxData.style}
                  onChange={(e) =>
                    onUpdateClip(
                      selectedClip.id,
                      { fxData: { ...selectedClip.fxData!, style: e.target.value as TextStyleType } },
                      true
                    )
                  }
                >
                  <option value="subtitle">ซับไตเติล</option>
                  <option value="title">หัวข้อใหญ่</option>
                  <option value="lowerthird">แถบชื่อ</option>
                  <option value="badge">ป้ายแคปซูล</option>
                </select>
              </div>
              <div className="control-row">
                <label className="control-label">แอนิเมชัน</label>
                <select
                  className="select"
                  value={selectedClip.fxData.anim}
                  onChange={(e) =>
                    onUpdateClip(
                      selectedClip.id,
                      { fxData: { ...selectedClip.fxData!, anim: e.target.value as TextAnimType } },
                      true
                    )
                  }
                >
                  <option value="none">อยู่นิ่ง</option>
                  <option value="fade">Fade</option>
                  <option value="typewriter">พิมพ์ดีด</option>
                  <option value="pulse">กระพริบ</option>
                </select>
              </div>
            </div>

            <div className="control-row">
              <div className="control-label">
                <span>ขนาดตัวอักษร</span>
                <span className="control-value">{selectedClip.fxData.fontSize}px</span>
              </div>
              <input
                type="range"
                className="slider"
                min={16}
                max={96}
                value={selectedClip.fxData.fontSize}
                onChange={(e) =>
                  onUpdateClip(
                    selectedClip.id,
                    { fxData: { ...selectedClip.fxData!, fontSize: +e.target.value } },
                    false
                  )
                }
              />
            </div>

            <div className="grid-2">
              <div className="control-row">
                <label className="control-label">สีตัวอักษร</label>
                <input
                  type="color"
                  className="input"
                  style={{ padding: 2, height: 32 }}
                  value={selectedClip.fxData.color}
                  onChange={(e) =>
                    onUpdateClip(
                      selectedClip.id,
                      { fxData: { ...selectedClip.fxData!, color: e.target.value } },
                      false
                    )
                  }
                />
              </div>
              <div className="control-row">
                <label className="control-label">สีขอบ/พื้น</label>
                <input
                  type="color"
                  className="input"
                  style={{ padding: 2, height: 32 }}
                  value={selectedClip.fxData.bgColor}
                  onChange={(e) =>
                    onUpdateClip(
                      selectedClip.id,
                      { fxData: { ...selectedClip.fxData!, bgColor: e.target.value } },
                      false
                    )
                  }
                />
              </div>
            </div>
          </div>
        )}

        {selectedClip?.track === 'audio' && (
          <div className="insp-section">
            <div className="insp-heading">ระดับเสียงและเฟด</div>
            <div className="control-row">
              <div className="control-label">
                <span>ความดังเสียง</span>
                <span className="control-value">{selectedClip.volume}%</span>
              </div>
              <input
                type="range"
                className="slider"
                min={0}
                max={150}
                value={selectedClip.volume}
                onChange={(e) => onUpdateClip(selectedClip.id, { volume: +e.target.value }, false)}
              />
            </div>

            <div className="grid-2">
              <div className="control-row">
                <div className="control-label">
                  <span>Fade In</span>
                  <span className="control-value">{selectedClip.fadeIn}s</span>
                </div>
                <input
                  type="range"
                  className="slider"
                  min={0}
                  max={5}
                  step={0.5}
                  value={selectedClip.fadeIn}
                  onChange={(e) => onUpdateClip(selectedClip.id, { fadeIn: +e.target.value }, false)}
                />
              </div>
              <div className="control-row">
                <div className="control-label">
                  <span>Fade Out</span>
                  <span className="control-value">{selectedClip.fadeOut}s</span>
                </div>
                <input
                  type="range"
                  className="slider"
                  min={0}
                  max={5}
                  step={0.5}
                  value={selectedClip.fadeOut}
                  onChange={(e) => onUpdateClip(selectedClip.id, { fadeOut: +e.target.value }, false)}
                />
              </div>
            </div>

            <div className="grid-2" style={{ marginTop: 6 }}>
              <button
                className="btn btn-secondary"
                onClick={() => onAddAudioKeyframe(selectedClip.id)}
              >
                <KeyRound size={13} /> + ปักหมุดระดับเสียง
                {selectedClip.audioKeyframes?.length ? ` (${selectedClip.audioKeyframes.length})` : ''}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => onNormalizeAudio(selectedClip.id)}
              >
                <Volume2 size={13} /> ปรับเสียงให้ดังสม่ำเสมอ
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
