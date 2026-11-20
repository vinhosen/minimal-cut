/**
 * Origin Private File System (OPFS) with coalesced write queue — ported from
 * `storytold/filmcraft/apps/filmcraft-web/src/opfs.rs` (MIT OR Apache-2.0).
 *
 * Writes are queued and coalesced per path (the newest bytes win) and run one at a time.
 * Includes an automatic IndexedDB / memory fallback when OPFS is unavailable.
 */

export type WriteDone = (ok: boolean) => void;

/** Up to 4 GiB media files are kept in OPFS for crash recovery (matches FilmCraft KEEP_MAX). */
export const KEEP_MAX_BYTES = 4 * 1024 * 1024 * 1024;

interface PendingEntry {
  data: Uint8Array;
  callbacks: WriteDone[];
}

const pendingQueue = new Map<string, PendingEntry>();
let writerRunning = false;

/** Fallback in-memory store used in environments without OPFS (e.g. unit tests or restricted contextos). */
const fallbackStore = new Map<string, { bytes: Uint8Array; name: string; type: string }>();

/** Whether this browser has OPFS (`navigator.storage.getDirectory`). */
export function opfsAvailable(): boolean {
  return Boolean(
    typeof window !== 'undefined' &&
      window.navigator?.storage &&
      typeof window.navigator.storage.getDirectory === 'function'
  );
}

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  if (!opfsAvailable()) {
    throw new Error('OPFS not available');
  }
  return window.navigator.storage.getDirectory();
}

async function getParent(
  rel: string,
  create: boolean
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  let dir = await getRoot();
  const parts = rel.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error('empty path');
  const name = parts[parts.length - 1];
  const dirs = parts.slice(0, -1);
  for (const d of dirs) {
    dir = await dir.getDirectoryHandle(d, { create });
  }
  return { dir, name };
}

export async function getOpfsFileHandle(
  rel: string,
  create: boolean
): Promise<FileSystemFileHandle> {
  const { dir, name } = await getParent(rel, create);
  return dir.getFileHandle(name, { create });
}

async function writeNow(rel: string, data: Uint8Array): Promise<void> {
  if (!opfsAvailable()) {
    const parts = rel.split('/').filter(Boolean);
    fallbackStore.set(rel, {
      bytes: data.slice(),
      name: parts[parts.length - 1] || 'file',
      type: 'application/octet-stream',
    });
    return;
  }
  const fh = await getOpfsFileHandle(rel, true);
  const writable = await fh.createWritable();
  await writable.write(data as unknown as BufferSource);
  await writable.close();
}

async function drainWriteQueue(): Promise<void> {
  while (pendingQueue.size > 0) {
    const firstKey = pendingQueue.keys().next().value;
    if (firstKey === undefined) break;
    const entry = pendingQueue.get(firstKey)!;
    pendingQueue.delete(firstKey);
    let ok = true;
    try {
      await writeNow(firstKey, entry.data);
    } catch {
      ok = false;
    }
    for (const cb of entry.callbacks) {
      try {
        cb(ok);
      } catch {
        // ignore callback error
      }
    }
  }
  writerRunning = false;
}

/**
 * Queue a coalesced write of `data` to `rel` (relative to the OPFS root), then call `done`.
 * A write replaced by a newer one to the same path reports the newer one's result.
 */
export function opfsWriteThen(rel: string, data: Uint8Array | string, done?: WriteDone): void {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const existing = pendingQueue.get(rel);
  if (existing) {
    existing.data = bytes;
    if (done) existing.callbacks.push(done);
  } else {
    pendingQueue.set(rel, {
      data: bytes,
      callbacks: done ? [done] : [],
    });
  }
  if (!writerRunning) {
    writerRunning = true;
    void drainWriteQueue();
  }
}

export function opfsWrite(rel: string, data: Uint8Array | string): Promise<boolean> {
  return new Promise((resolve) => {
    opfsWriteThen(rel, data, resolve);
  });
}

export async function opfsRead(rel: string): Promise<Uint8Array | null> {
  const pending = pendingQueue.get(rel);
  if (pending) return pending.data.slice();

  if (!opfsAvailable()) {
    const hit = fallbackStore.get(rel);
    return hit ? hit.bytes.slice() : null;
  }
  try {
    const fh = await getOpfsFileHandle(rel, false);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

export async function opfsReadText(rel: string): Promise<string | null> {
  const bytes = await opfsRead(rel);
  if (!bytes) return null;
  return new TextDecoder().decode(bytes);
}

/** Stream or copy a Blob/File into OPFS at `rel` (e.g. `media/<assetId>`). */
export async function opfsStoreBlob(rel: string, blob: Blob, filename?: string): Promise<boolean> {
  if (blob.size > KEEP_MAX_BYTES) return false;
  if (!opfsAvailable()) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    fallbackStore.set(rel, {
      bytes,
      name: filename || (blob instanceof File ? blob.name : 'media'),
      type: blob.type || 'application/octet-stream',
    });
    return true;
  }
  try {
    const fh = await getOpfsFileHandle(rel, true);
    const writable = await fh.createWritable();
    if (typeof blob.stream === 'function') {
      await blob.stream().pipeTo(writable);
    } else {
      await writable.write(blob);
      await writable.close();
    }
    return true;
  } catch {
    return false;
  }
}

/** Read an OPFS file back as a `File` object with original `filename` and `mimeType`. */
export async function opfsLoadFile(
  rel: string,
  filename?: string,
  mimeType?: string
): Promise<File | null> {
  if (!opfsAvailable()) {
    const hit = fallbackStore.get(rel);
    if (!hit) return null;
    const copy = new Uint8Array(hit.bytes.byteLength);
    copy.set(hit.bytes);
    return new File([copy.buffer], filename || hit.name, {
      type: mimeType || hit.type,
    });
  }
  try {
    const fh = await getOpfsFileHandle(rel, false);
    const f = await fh.getFile();
    if ((filename && f.name !== filename) || (mimeType && f.type !== mimeType)) {
      return new File([f], filename || f.name, { type: mimeType || f.type });
    }
    return f;
  } catch {
    return null;
  }
}

export async function opfsRemove(rel: string): Promise<void> {
  pendingQueue.delete(rel);
  fallbackStore.delete(rel);
  if (!opfsAvailable()) return;
  try {
    const { dir, name } = await getParent(rel, false);
    await dir.removeEntry(name, { recursive: true });
  } catch {
    // ignore missing entry
  }
}

export async function opfsClearAll(): Promise<void> {
  pendingQueue.clear();
  fallbackStore.clear();
  if (!opfsAvailable()) return;
  for (const sub of ['recovery', 'media', 'proxy', 'exports']) {
    try {
      const root = await getRoot();
      await root.removeEntry(sub, { recursive: true });
    } catch {
      // ignore if directory does not exist
    }
  }
}

export async function getStorageEstimate(): Promise<{ usageBytes: number; quotaBytes: number }> {
  if (typeof window !== 'undefined' && window.navigator?.storage?.estimate) {
    try {
      const est = await window.navigator.storage.estimate();
      return {
        usageBytes: est.usage || 0,
        quotaBytes: est.quota || 0,
      };
    } catch {
      // ignore
    }
  }
  return { usageBytes: 0, quotaBytes: 0 };
}
