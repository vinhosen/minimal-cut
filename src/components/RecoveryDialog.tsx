import React from 'react';
import { RotateCcw, Trash2, Film } from 'lucide-react';
import type { RecoveryMeta } from '../storage/projectDb';

interface RecoveryDialogProps {
  meta: RecoveryMeta;
  isRestoring: boolean;
  onRestore: () => void;
  onDiscard: () => void;
}

export const RecoveryDialog: React.FC<RecoveryDialogProps> = ({
  meta,
  isRestoring,
  onRestore,
  onDiscard,
}) => {
  const savedDate = new Date(meta.savedAt).toLocaleString('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
      <div className="modal-card" style={{ maxWidth: 440 }}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="brand-badge">
              <Film size={16} />
            </div>
            <div>
              <h3 id="recovery-title" style={{ margin: 0, fontSize: 16 }}>
                พบโปรเจกต์ที่บันทึกอัตโนมัติ (Crash Recovery)
              </h3>
              <p style={{ margin: 0, fontSize: 12, opacity: 0.7 }}>
                FilmCraft OPFS Recovery • {savedDate}
              </p>
            </div>
          </div>
        </div>

        <div className="modal-body" style={{ padding: '14px 0', fontSize: 13.5, lineHeight: 1.55 }}>
          <p style={{ margin: '0 0 10px' }}>
            ระบบพบโปรเจกต์ล่าสุดที่ยังตัดต่อค้างไว้ ({meta.clipCount} คลิปบนไทม์ไลน์ • ไฟล์มีเดีย{' '}
            {meta.assetCount} ไฟล์) คุณต้องการกู้คืนโปรเจกต์เดิมกลับมาหรือไม่?
          </p>
        </div>

        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onDiscard}
            disabled={isRestoring}
          >
            <Trash2 size={14} />
            <span>เริ่มโปรเจกต์ใหม่</span>
          </button>
          <button
            type="button"
            className="btn btn-dark"
            onClick={onRestore}
            disabled={isRestoring}
          >
            <RotateCcw size={14} />
            <span>{isRestoring ? 'กำลังกู้คืนไฟล์สื่อ...' : 'กู้คืนโปรเจกต์ล่าสุด'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
