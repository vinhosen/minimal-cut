/**
 * FilmCraft Project Persistence & Crash-Recovery Policy
 * Ported from `storytold/filmcraft/apps/filmcraft-web/src/recovery.rs` and `recovery_policy.rs`
 * (MIT OR Apache-2.0), with IndexedDB mirror so recovery works even if OPFS is unavailable.
 */

import type { AspectRatio, ColorSettings, ExportSettings, MediaAsset, TimelineClip } from '../types/editor';
import {
  opfsAvailable,
  opfsClearAll,
  opfsLoadFile,
  opfsReadText,
  opfsRemove,
  opfsStoreBlob,
  opfsWrite,
} from './opfs';

export const SNAPSHOT_PATH = 'recovery/snapshot.fcproj';
export const META_PATH = 'recovery/meta.json';
export const INTERVAL_S = 5.0;

export interface AssetManifestItem {
  id: string;
  name: string;
  type: 'video' | 'image' | 'audio';
  mimeType: string;
  size: number;
  duration: number;
  width: number;
  height: number;
}

export interface ProjectSnapshot {
  format: 'filmcraft-minimalcut';
  version: 3;
  name: string;
  revision: number;
  savedAt: number;
  aspectRatio: AspectRatio;
  colors: ColorSettings;
  exportSettings: ExportSettings;
  assetsManifest: AssetManifestItem[];
  clips: TimelineClip[];
}

export interface RecoveryMeta {
  dirty: boolean;
  name: string;
  revision: number;
  savedAt: number;
  clipCount: number;
  assetCount: number;
}

export type PolicyAction =
  | { type: 'Nothing' }
  | { type: 'WriteSnapshot'; revision: number }
  | { type: 'WriteClean' }
  | { type: 'WakeAfter'; seconds: number };

/**
 * FilmCraft RecoveryPolicy state machine (`recovery_policy.rs`):
 * Tracks dirty/saved revisions and decides when to write a snapshot or mark clean.
 */
export class RecoveryPolicy {
  private lastRevision: number | null = null;
  private lastTime: number | null = null;
  private ownsDirtyMeta = false;
  private cleaning = false;
  private snapshots = 0;
  private snapshotsAtClean = 0;
  private readonly intervalS: number;

  constructor(intervalS = INTERVAL_S) {
    this.intervalS = intervalS;
  }

  tick(nowSec: number, revision: number, savedRevision: number): PolicyAction {
    if (revision !== savedRevision) {
      if (this.lastRevision === revision) {
        return { type: 'Nothing' };
      }
      const since = this.lastTime === null ? Infinity : nowSec - this.lastTime;
      if (since >= this.intervalS) {
        this.lastRevision = revision;
        this.lastTime = nowSec;
        this.ownsDirtyMeta = true;
        this.snapshots += 1;
        return { type: 'WriteSnapshot', revision };
      }
      return { type: 'WakeAfter', seconds: Math.max(0.05, this.intervalS - since) };
    }
    if (this.ownsDirtyMeta && !this.cleaning) {
      const since = this.lastTime === null ? Infinity : nowSec - this.lastTime;
      if (this.lastRevision !== null || since >= this.intervalS) {
        this.cleaning = true;
        this.snapshotsAtClean = this.snapshots;
        return { type: 'WriteClean' };
      }
      return { type: 'WakeAfter', seconds: Math.max(0.05, this.intervalS - since) };
    }
    return { type: 'Nothing' };
  }

  written(revision: number, ok: boolean, nowSec: number): void {
    if (!ok && this.lastRevision === revision) {
      this.lastRevision = null;
      this.lastTime = nowSec;
    }
  }

  cleaned(ok: boolean, nowSec: number): void {
    this.cleaning = false;
    if (ok) {
      this.ownsDirtyMeta = this.snapshots !== this.snapshotsAtClean;
    } else {
      this.lastRevision = null;
      this.lastTime = nowSec;
    }
  }
}

// --- IndexedDB Mirror ---
const DB_NAME = 'minimalcut_filmcraft_db';
const DB_VERSION = 1;
const STORE_PROJECT = 'project';
const STORE_MEDIA = 'media';

function openIdb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_PROJECT)) {
          db.createObjectStore(STORE_PROJECT);
        }
        if (!db.objectStoreNames.contains(STORE_MEDIA)) {
          db.createObjectStore(STORE_MEDIA);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbPut(storeName: string, key: string, value: unknown): Promise<boolean> {
  const db = await openIdb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
    } catch {
      db.close();
      resolve(false);
    }
  });
}

async function idbGet<T>(storeName: string, key: string): Promise<T | null> {
  const db = await openIdb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as T) ?? null);
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function idbClearAll(): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction([STORE_PROJECT, STORE_MEDIA], 'readwrite');
      tx.objectStore(STORE_PROJECT).clear();
      tx.objectStore(STORE_MEDIA).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

export function buildProjectSnapshot(params: {
  name?: string;
  revision: number;
  aspectRatio: AspectRatio;
  colors: ColorSettings;
  exportSettings: ExportSettings;
  assets: MediaAsset[];
  clips: TimelineClip[];
}): ProjectSnapshot {
  return {
    format: 'filmcraft-minimalcut',
    version: 3,
    name: params.name || 'MinimalCut Project',
    revision: params.revision,
    savedAt: Date.now(),
    aspectRatio: params.aspectRatio,
    colors: params.colors,
    exportSettings: params.exportSettings,
    assetsManifest: params.assets.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      mimeType: a.file?.type || (a.type === 'video' ? 'video/mp4' : a.type === 'image' ? 'image/png' : 'audio/mpeg'),
      size: a.file?.size || 0,
      duration: a.duration,
      width: a.width,
      height: a.height,
    })),
    clips: params.clips,
  };
}

/** Save project snapshot + dirty metadata to OPFS (`recovery/snapshot.fcproj`) and IndexedDB. */
export async function saveRecoverySnapshot(snapshot: ProjectSnapshot, dirty = true): Promise<boolean> {
  const jsonText = JSON.stringify(snapshot);
  const meta: RecoveryMeta = {
    dirty: dirty && snapshot.clips.length > 0,
    name: snapshot.name,
    revision: snapshot.revision,
    savedAt: snapshot.savedAt,
    clipCount: snapshot.clips.length,
    assetCount: snapshot.assetsManifest.length,
  };
  const [opfsSnapOk, opfsMetaOk, idbSnapOk, idbMetaOk] = await Promise.all([
    opfsWrite(SNAPSHOT_PATH, jsonText),
    opfsWrite(META_PATH, JSON.stringify(meta)),
    idbPut(STORE_PROJECT, 'snapshot', snapshot),
    idbPut(STORE_PROJECT, 'meta', meta),
  ]);
  return (opfsSnapOk && opfsMetaOk) || (idbSnapOk && idbMetaOk);
}

export async function markRecoveryClean(): Promise<boolean> {
  const meta: RecoveryMeta = {
    dirty: false,
    name: 'MinimalCut Project',
    revision: 0,
    savedAt: Date.now(),
    clipCount: 0,
    assetCount: 0,
  };
  const [o, i] = await Promise.all([
    opfsWrite(META_PATH, JSON.stringify(meta)),
    idbPut(STORE_PROJECT, 'meta', meta),
  ]);
  return o || i;
}

/** Check if an unsaved recovery snapshot exists from a previous session. */
export async function loadRecoverySnapshot(): Promise<{
  meta: RecoveryMeta;
  snapshot: ProjectSnapshot;
} | null> {
  try {
    const metaText = await opfsReadText(META_PATH);
    if (metaText) {
      const meta = JSON.parse(metaText) as RecoveryMeta;
      if (meta.dirty && meta.clipCount > 0) {
        const snapText = await opfsReadText(SNAPSHOT_PATH);
        if (snapText) {
          const snapshot = JSON.parse(snapText) as ProjectSnapshot;
          if (Array.isArray(snapshot.clips) && snapshot.clips.length > 0) {
            return { meta, snapshot };
          }
        }
      }
    }
  } catch {
    // fallback to IDB
  }

  const meta = await idbGet<RecoveryMeta>(STORE_PROJECT, 'meta');
  if (!meta?.dirty || meta.clipCount <= 0) return null;
  const snapshot = await idbGet<ProjectSnapshot>(STORE_PROJECT, 'snapshot');
  if (!snapshot || !Array.isArray(snapshot.clips) || snapshot.clips.length === 0) return null;
  return { meta, snapshot };
}

/** Keep a copy of an imported media file in OPFS (`media/<assetId>`) and IDB fallback. */
export async function persistMediaFile(assetId: string, file: File): Promise<boolean> {
  const rel = `media/${assetId}`;
  const okOpfs = await opfsStoreBlob(rel, file, file.name);
  if (okOpfs && opfsAvailable()) return true;
  return idbPut(STORE_MEDIA, assetId, file);
}

/** Restore a persisted media file by asset ID from OPFS (`media/<assetId>`) or IDB fallback. */
export async function restoreMediaFile(item: AssetManifestItem): Promise<File | null> {
  const fromOpfs = await opfsLoadFile(`media/${item.id}`, item.name, item.mimeType);
  if (fromOpfs) return fromOpfs;
  const fromIdb = await idbGet<Blob | File>(STORE_MEDIA, item.id);
  if (!fromIdb) return null;
  if (fromIdb instanceof File) return fromIdb;
  return new File([fromIdb], item.name, { type: item.mimeType || fromIdb.type });
}

async function idbDelete(storeName: string, key: string): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

export async function removePersistedMedia(assetId: string): Promise<void> {
  await Promise.all([
    opfsRemove(`media/${assetId}`),
    opfsRemove(`proxy/${assetId}.mp4`),
    idbDelete(STORE_MEDIA, assetId),
  ]);
}

export async function clearAllRecoveryData(): Promise<void> {
  await Promise.all([opfsClearAll(), idbClearAll()]);
}
