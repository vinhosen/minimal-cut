import { useEffect, useMemo, useRef, useState } from 'react';
import type { AspectRatio, ColorSettings, ExportSettings, MediaAsset, TimelineClip } from '../types/editor';
import {
  buildProjectSnapshot,
  markRecoveryClean,
  RecoveryPolicy,
  saveRecoverySnapshot,
} from '../storage/projectDb';

export interface AutosaveParams {
  clips: TimelineClip[];
  assets: MediaAsset[];
  colors: ColorSettings;
  aspectRatio: AspectRatio;
  exportSettings: ExportSettings;
  enabled?: boolean;
}

export function useAutosave(params: AutosaveParams): {
  autosaveLabel: string;
  dirty: boolean;
  flushAutosave: () => Promise<void>;
} {
  const { clips, assets, colors, aspectRatio, exportSettings, enabled = true } = params;
  const [savedKey, setSavedKey] = useState<string>('');

  const revisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const policyRef = useRef<RecoveryPolicy | null>(null);
  const latestRef = useRef(params);

  // Content signature representing current project state
  const currentKey = useMemo(() => {
    if (clips.length === 0) return '';
    return JSON.stringify({
      aspectRatio,
      colors,
      exportSettings,
      assetIds: assets.map((a) => a.id),
      clips,
    });
  }, [clips, assets, colors, aspectRatio, exportSettings]);

  useEffect(() => {
    latestRef.current = params;
  });

  useEffect(() => {
    if (!policyRef.current) {
      policyRef.current = new RecoveryPolicy(2.0);
    }
    if (!enabled) return;
    if (clips.length === 0) {
      savedRevisionRef.current = revisionRef.current;
      void markRecoveryClean().then(() => {
        setSavedKey('');
      });
      return;
    }

    revisionRef.current += 1;
    const rev = revisionRef.current;
    const keySnapshot = currentKey;
    const policy = policyRef.current;

    const timer = setTimeout(async () => {
      const nowSec = performance.now() / 1000;
      const act = policy.tick(nowSec, rev, 0);
      if (act.type === 'WriteSnapshot' || rev !== savedRevisionRef.current) {
        const cur = latestRef.current;
        const snap = buildProjectSnapshot({
          revision: rev,
          aspectRatio: cur.aspectRatio,
          colors: cur.colors,
          exportSettings: cur.exportSettings,
          assets: cur.assets,
          clips: cur.clips,
        });
        const ok = await saveRecoverySnapshot(snap, true);
        policy.written(rev, ok, performance.now() / 1000);
        if (ok) {
          savedRevisionRef.current = rev;
          setSavedKey(keySnapshot);
        }
      }
    }, 1500);

    return () => clearTimeout(timer);
  }, [currentKey, clips.length, enabled]);

  // Request persistent storage once and flush snapshot on pagehide / visibilitychange
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.navigator?.storage?.persist) {
      window.navigator.storage.persist().catch(() => {});
    }

    const flushOnHide = () => {
      const cur = latestRef.current;
      if (!cur.enabled || cur.clips.length === 0) return;
      const snap = buildProjectSnapshot({
        revision: revisionRef.current,
        aspectRatio: cur.aspectRatio,
        colors: cur.colors,
        exportSettings: cur.exportSettings,
        assets: cur.assets,
        clips: cur.clips,
      });
      void saveRecoverySnapshot(snap, true);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushOnHide();
    };
    window.addEventListener('pagehide', flushOnHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushOnHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const flushAutosave = async () => {
    const cur = latestRef.current;
    if (cur.clips.length === 0) {
      await markRecoveryClean();
      setSavedKey('');
      return;
    }
    const snap = buildProjectSnapshot({
      revision: revisionRef.current,
      aspectRatio: cur.aspectRatio,
      colors: cur.colors,
      exportSettings: cur.exportSettings,
      assets: cur.assets,
      clips: cur.clips,
    });
    await saveRecoverySnapshot(snap, true);
    savedRevisionRef.current = revisionRef.current;
    setSavedKey(currentKey);
  };

  const dirty = clips.length > 0 && savedKey !== currentKey;
  const autosaveLabel =
    clips.length === 0
      ? 'บันทึกอัตโนมัติพร้อมใช้'
      : !dirty
        ? 'บันทึกอัตโนมัติแล้ว (OPFS)'
        : 'กำลังบันทึกอัตโนมัติ...';

  return { autosaveLabel, dirty, flushAutosave };
}
