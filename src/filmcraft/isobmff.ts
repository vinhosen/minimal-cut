/**
 * FilmCraft ISO-BMFF (MP4 / QuickTime MOV) Demuxer
 * Ported from `storytold/craft-libs/crates/media/src/isobmff` & `storytold/filmcraft/apps/filmcraft-web/src/webcodecs.rs`
 * (MIT OR Apache-2.0).
 *
 * Parses box headers and `moov` sample tables (`stsd`, `stts`, `ctts`, `stsc`, `stsz`, `stco`/`co64`, `stss`)
 * without loading `mdat` into memory; reads compressed samples on demand via `Blob.slice()`.
 */

export type TrackKind = 'video' | 'audio' | 'other';

export interface Sample {
  offset: number;
  size: number;
  dts: number;
  pts: number;
  duration: number;
  isSync: boolean;
}

export interface SampleEntry {
  format: string;
  width: number;
  height: number;
  codecFamily: 'avc' | 'hevc' | 'vp9' | 'av1' | 'aac' | 'unknown';
  codecString: string;
  /** Raw codec configuration box payload (`avcC`, `hvcC`, `av1C`, `vpcC`) for WebCodecs `description`. */
  description?: Uint8Array;
  channelCount?: number;
  sampleRate?: number;
}

export interface Mp4Track {
  id: number;
  kind: TrackKind;
  timescale: number;
  duration: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  entries: SampleEntry[];
  samples: Sample[];
}

export interface Mp4File {
  tracks: Mp4Track[];
  durationSec: number;
  byteLength: number;
}

/** Check if the first bytes of a file look like an ISO-BMFF (MP4/MOV) container. */
export function sniffMp4(head: Uint8Array): boolean {
  if (head.byteLength < 8) return false;
  const tag = ascii(head, 4, 4);
  return (
    tag === 'ftyp' ||
    tag === 'moov' ||
    tag === 'mdat' ||
    tag === 'free' ||
    tag === 'skip' ||
    tag === 'wide' ||
    tag === 'styp'
  );
}

/** Nearest sample at or before presentation time `targetPts` (in track timescale units). */
export function sampleAtPresentationTime(track: Mp4Track, targetPts: number): number {
  const samples = track.samples;
  if (samples.length === 0) return 0;
  let bestIdx = 0;
  let bestDiff = Infinity;
  // Samples are near-monotonic in PTS (only B-frame reordering permutes within small lookahead windows)
  // Binary search on DTS first to narrow window, then scan ±16 samples for exact closest PTS.
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].dts <= targetPts) lo = mid;
    else hi = mid - 1;
  }
  const winStart = Math.max(0, lo - 16);
  const winEnd = Math.min(samples.length - 1, lo + 16);
  for (let i = winStart; i <= winEnd; i++) {
    const diff = Math.abs(samples[i].pts - targetPts);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Index of the sync (key) sample at or before `sampleIndex`. */
export function syncSampleBefore(track: Mp4Track, sampleIndex: number): number {
  const samples = track.samples;
  for (let i = Math.min(sampleIndex, samples.length - 1); i >= 0; i--) {
    if (samples[i].isSync) return i;
  }
  return 0;
}

function ascii(buf: Uint8Array, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && offset + i < buf.byteLength; i++) {
    s += String.fromCharCode(buf[offset + i]);
  }
  return s;
}

function hex2(n: number): string {
  return (n & 0xff).toString(16).padStart(2, '0');
}

interface BoxRef {
  type: string;
  headerSize: number;
  start: number;
  end: number;
}

function iterBoxes(view: DataView, buf: Uint8Array, start: number, end: number): BoxRef[] {
  const out: BoxRef[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos, false);
    const type = ascii(buf, pos + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      const hi = view.getUint32(pos + 8, false);
      const lo = view.getUint32(pos + 12, false);
      size = hi * 4294967296 + lo;
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) break;
    out.push({ type, headerSize, start: pos, end: pos + size });
    pos += size;
  }
  return out;
}

function parseVideoSampleEntry(
  format: string,
  view: DataView,
  buf: Uint8Array,
  entryStart: number,
  entryEnd: number
): SampleEntry {
  // VisualSampleEntry has 78-byte header after the 8-byte box header (6 reserved + 2 data_ref_idx + 16 pre_defined + 2 width + 2 height + 50 ...)
  const payloadStart = entryStart + 8;
  const width = payloadStart + 26 <= entryEnd ? view.getUint16(payloadStart + 24, false) : 0;
  const height = payloadStart + 28 <= entryEnd ? view.getUint16(payloadStart + 26, false) : 0;

  let codecFamily: SampleEntry['codecFamily'] = 'unknown';
  let codecString = format;
  let description: Uint8Array | undefined;

  const childrenStart = payloadStart + 78;
  if (childrenStart < entryEnd) {
    const subBoxes = iterBoxes(view, buf, childrenStart, entryEnd);
    for (const b of subBoxes) {
      const pStart = b.start + b.headerSize;
      if (b.type === 'avcC' && pStart + 4 <= b.end) {
        codecFamily = 'avc';
        const profile = buf[pStart + 1];
        const compat = buf[pStart + 2];
        const level = buf[pStart + 3];
        codecString = `avc1.${hex2(profile)}${hex2(compat)}${hex2(level)}`;
        description = buf.slice(pStart, b.end);
      } else if (b.type === 'hvcC' && pStart + 13 <= b.end) {
        codecFamily = 'hevc';
        const byte1 = buf[pStart + 1];
        const profileSpace = ['', 'A', 'B', 'C'][(byte1 >> 6) & 3];
        const tierFlag = (byte1 >> 5) & 1 ? 'H' : 'L';
        const profileIdc = byte1 & 0x1f;
        const levelIdc = buf[pStart + 12];
        const prefix = format === 'hev1' ? 'hev1' : 'hvc1';
        codecString = `${prefix}.${profileSpace}${profileIdc}.60.${tierFlag}${levelIdc}.90`;
        description = buf.slice(pStart, b.end);
      } else if (b.type === 'vpcC' && pStart + 8 <= b.end) {
        codecFamily = 'vp9';
        // FullBox (4 bytes version/flags) then profile, level, bitDepth...
        const profile = buf[pStart + 4];
        const level = buf[pStart + 5];
        const bitDepth = Math.max(8, (buf[pStart + 6] >> 4) & 0x0f);
        codecString = `vp09.${String(profile).padStart(2, '0')}.${String(level).padStart(2, '0')}.${String(bitDepth).padStart(2, '0')}`;
      } else if (b.type === 'av1C' && pStart + 4 <= b.end) {
        codecFamily = 'av1';
        const byte1 = buf[pStart + 1];
        const seqProfile = (byte1 >> 5) & 0x07;
        const seqLevelIdx0 = byte1 & 0x1f;
        const byte2 = buf[pStart + 2];
        const tier = (byte2 >> 7) & 1 ? 'H' : 'M';
        const highBitdepth = (byte2 >> 6) & 1;
        const twelveBit = (byte2 >> 5) & 1;
        const depth = twelveBit ? 12 : highBitdepth ? 10 : 8;
        codecString = `av01.${seqProfile}.${String(seqLevelIdx0).padStart(2, '0')}${tier}.${String(depth).padStart(2, '0')}`;
        description = buf.slice(pStart, b.end);
      }
    }
  }

  return {
    format,
    width,
    height,
    codecFamily,
    codecString,
    description,
  };
}

function parseTrak(view: DataView, buf: Uint8Array, trakBox: BoxRef): Mp4Track | null {
  let trackId = 1;
  let tkhdW = 0;
  let tkhdH = 0;
  let rotation: 0 | 90 | 180 | 270 = 0;
  let timescale = 1000;
  let duration = 0;
  let kind: TrackKind = 'other';
  const entries: SampleEntry[] = [];
  const stts: Array<{ count: number; delta: number }> = [];
  const ctts: Array<{ count: number; offset: number }> = [];
  const stsc: Array<{ firstChunk: number; samplesPerChunk: number; descIdx: number }> = [];
  const stsz: number[] = [];
  let defaultSampleSize = 0;
  let sampleCountFromStsz = 0;
  const chunkOffsets: number[] = [];
  const stss = new Set<number>();
  let hasStss = false;

  for (const child of iterBoxes(view, buf, trakBox.start + trakBox.headerSize, trakBox.end)) {
    const p = child.start + child.headerSize;
    if (child.type === 'tkhd' && p + 84 <= child.end) {
      const ver = buf[p];
      trackId = ver === 1 ? view.getUint32(p + 20, false) : view.getUint32(p + 12, false);
      const matrixOff = ver === 1 ? p + 52 : p + 40;
      const dimOff = ver === 1 ? p + 88 : p + 76;
      if (dimOff + 8 <= child.end) {
        tkhdW = view.getUint32(dimOff, false) >>> 16;
        tkhdH = view.getUint32(dimOff + 4, false) >>> 16;
      }
      if (matrixOff + 16 <= child.end) {
        const a = view.getInt32(matrixOff, false) / 65536;
        const b = view.getInt32(matrixOff + 4, false) / 65536;
        const angle = ((Math.round((Math.atan2(b, a) * 180) / Math.PI) % 360) + 360) % 360;
        if (angle === 90 || angle === 180 || angle === 270) rotation = angle;
      }
    } else if (child.type === 'mdia') {
      for (const mChild of iterBoxes(view, buf, p, child.end)) {
        const mp = mChild.start + mChild.headerSize;
        if (mChild.type === 'mdhd' && mp + 24 <= mChild.end) {
          const ver = buf[mp];
          if (ver === 1 && mp + 32 <= mChild.end) {
            timescale = view.getUint32(mp + 20, false) || 1000;
            const hi = view.getUint32(mp + 24, false);
            const lo = view.getUint32(mp + 28, false);
            duration = hi * 4294967296 + lo;
          } else {
            timescale = view.getUint32(mp + 12, false) || 1000;
            duration = view.getUint32(mp + 16, false);
          }
        } else if (mChild.type === 'hdlr' && mp + 12 <= mChild.end) {
          const handler = ascii(buf, mp + 8, 4);
          if (handler === 'vide') kind = 'video';
          else if (handler === 'soun') kind = 'audio';
        } else if (mChild.type === 'minf') {
          for (const minfChild of iterBoxes(view, buf, mp, mChild.end)) {
            if (minfChild.type !== 'stbl') continue;
            const sp = minfChild.start + minfChild.headerSize;
            for (const stBox of iterBoxes(view, buf, sp, minfChild.end)) {
              const bp = stBox.start + stBox.headerSize;
              if (stBox.type === 'stsd' && bp + 8 <= stBox.end) {
                const entryBoxes = iterBoxes(view, buf, bp + 8, stBox.end);
                for (const eb of entryBoxes) {
                  entries.push(parseVideoSampleEntry(eb.type, view, buf, eb.start, eb.end));
                }
              } else if (stBox.type === 'stts' && bp + 8 <= stBox.end) {
                const count = view.getUint32(bp + 4, false);
                let cur = bp + 8;
                for (let i = 0; i < count && cur + 8 <= stBox.end; i++, cur += 8) {
                  stts.push({
                    count: view.getUint32(cur, false),
                    delta: view.getUint32(cur + 4, false),
                  });
                }
              } else if (stBox.type === 'ctts' && bp + 8 <= stBox.end) {
                const ver = buf[bp];
                const count = view.getUint32(bp + 4, false);
                let cur = bp + 8;
                for (let i = 0; i < count && cur + 8 <= stBox.end; i++, cur += 8) {
                  ctts.push({
                    count: view.getUint32(cur, false),
                    offset: ver === 1 ? view.getInt32(cur + 4, false) : view.getUint32(cur + 4, false),
                  });
                }
              } else if (stBox.type === 'stsc' && bp + 8 <= stBox.end) {
                const count = view.getUint32(bp + 4, false);
                let cur = bp + 8;
                for (let i = 0; i < count && cur + 12 <= stBox.end; i++, cur += 12) {
                  stsc.push({
                    firstChunk: view.getUint32(cur, false),
                    samplesPerChunk: view.getUint32(cur + 4, false),
                    descIdx: view.getUint32(cur + 8, false),
                  });
                }
              } else if (stBox.type === 'stsz' && bp + 12 <= stBox.end) {
                defaultSampleSize = view.getUint32(bp + 4, false);
                sampleCountFromStsz = view.getUint32(bp + 8, false);
                if (defaultSampleSize === 0) {
                  let cur = bp + 12;
                  for (let i = 0; i < sampleCountFromStsz && cur + 4 <= stBox.end; i++, cur += 4) {
                    stsz.push(view.getUint32(cur, false));
                  }
                }
              } else if (stBox.type === 'stco' && bp + 8 <= stBox.end) {
                const count = view.getUint32(bp + 4, false);
                let cur = bp + 8;
                for (let i = 0; i < count && cur + 4 <= stBox.end; i++, cur += 4) {
                  chunkOffsets.push(view.getUint32(cur, false));
                }
              } else if (stBox.type === 'co64' && bp + 8 <= stBox.end) {
                const count = view.getUint32(bp + 4, false);
                let cur = bp + 8;
                for (let i = 0; i < count && cur + 8 <= stBox.end; i++, cur += 8) {
                  const hi = view.getUint32(cur, false);
                  const lo = view.getUint32(cur + 4, false);
                  chunkOffsets.push(hi * 4294967296 + lo);
                }
              } else if (stBox.type === 'stss' && bp + 8 <= stBox.end) {
                hasStss = true;
                const count = view.getUint32(bp + 4, false);
                let cur = bp + 8;
                for (let i = 0; i < count && cur + 4 <= stBox.end; i++, cur += 4) {
                  stss.add(view.getUint32(cur, false)); // 1-based sample number
                }
              }
            }
          }
        }
      }
    }
  }

  const totalSamples = sampleCountFromStsz || stsz.length;
  if (totalSamples === 0 || chunkOffsets.length === 0 || stsc.length === 0) {
    return null;
  }

  // Expand sample offsets and sizes from stsc + chunkOffsets + stsz
  const sampleOffsets = new Array<number>(totalSamples);
  const sampleSizes = new Array<number>(totalSamples);
  let sampleIdx = 0;
  for (let chunkIdx = 0; chunkIdx < chunkOffsets.length && sampleIdx < totalSamples; chunkIdx++) {
    const chunkNum = chunkIdx + 1; // 1-based
    let spc = stsc[0].samplesPerChunk;
    for (let j = 0; j < stsc.length; j++) {
      if (stsc[j].firstChunk <= chunkNum) spc = stsc[j].samplesPerChunk;
      else break;
    }
    let offset = chunkOffsets[chunkIdx];
    for (let s = 0; s < spc && sampleIdx < totalSamples; s++) {
      const sz = defaultSampleSize || stsz[sampleIdx] || 0;
      sampleOffsets[sampleIdx] = offset;
      sampleSizes[sampleIdx] = sz;
      offset += sz;
      sampleIdx++;
    }
  }

  const samples: Sample[] = [];
  let sttsIdx = 0;
  let sttsRem = stts[0]?.count ?? 0;
  let cttsIdx = 0;
  let cttsRem = ctts[0]?.count ?? 0;
  let dts = 0;

  for (let i = 0; i < sampleIdx; i++) {
    while (sttsIdx < stts.length && sttsRem === 0) {
      sttsIdx++;
      sttsRem = stts[sttsIdx]?.count ?? 0;
    }
    const delta = stts[sttsIdx]?.delta ?? 1;
    if (sttsRem > 0) sttsRem--;

    while (cttsIdx < ctts.length && cttsRem === 0) {
      cttsIdx++;
      cttsRem = ctts[cttsIdx]?.count ?? 0;
    }
    const cttsOff = ctts[cttsIdx]?.offset ?? 0;
    if (cttsRem > 0) cttsRem--;

    const isSync = hasStss ? stss.has(i + 1) : true;
    samples.push({
      offset: sampleOffsets[i],
      size: sampleSizes[i],
      dts,
      pts: dts + cttsOff,
      duration: delta,
      isSync,
    });
    dts += delta;
  }

  const entryW = entries[0]?.width || tkhdW || 1280;
  const entryH = entries[0]?.height || tkhdH || 720;

  return {
    id: trackId,
    kind,
    timescale,
    duration,
    width: entryW,
    height: entryH,
    rotation,
    entries,
    samples,
  };
}

/**
 * Locate and parse the `moov` box of an MP4/MOV file without loading `mdat` into memory.
 */
export async function openMp4Blob(blob: Blob): Promise<Mp4File | null> {
  const totalLen = blob.size;
  if (totalLen < 16) return null;

  // Scan top-level box headers (only 16 bytes read per top-level box!) to locate `moov`
  let pos = 0;
  let moovStart = -1;
  let moovEnd = -1;

  while (pos + 8 <= totalLen) {
    const hdrBuf = new Uint8Array(await blob.slice(pos, Math.min(totalLen, pos + 16)).arrayBuffer());
    if (hdrBuf.byteLength < 8) break;
    if (pos === 0 && !sniffMp4(hdrBuf)) return null;
    const view = new DataView(hdrBuf.buffer, hdrBuf.byteOffset, hdrBuf.byteLength);
    let size = view.getUint32(0, false);
    const type = ascii(hdrBuf, 4, 4);
    let hdrSize = 8;
    if (size === 1) {
      if (hdrBuf.byteLength < 16) break;
      size = view.getUint32(8, false) * 4294967296 + view.getUint32(12, false);
      hdrSize = 16;
    } else if (size === 0) {
      size = totalLen - pos;
    }
    if (size < hdrSize || pos + size > totalLen) break;
    if (type === 'moov') {
      moovStart = pos + hdrSize;
      moovEnd = pos + size;
      break;
    }
    pos += size;
  }

  if (moovStart < 0 || moovEnd <= moovStart) return null;
  // Reject corrupt/gigantic moov (> 128 MiB)
  if (moovEnd - moovStart > 128 * 1024 * 1024) return null;

  const moovBytes = new Uint8Array(await blob.slice(moovStart, moovEnd).arrayBuffer());
  const moovView = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  const tracks: Mp4Track[] = [];
  let maxDurSec = 0;

  for (const box of iterBoxes(moovView, moovBytes, 0, moovBytes.byteLength)) {
    if (box.type === 'trak') {
      const t = parseTrak(moovView, moovBytes, box);
      if (t) {
        tracks.push(t);
        const durSec = t.timescale > 0 ? t.duration / t.timescale : 0;
        if (durSec > maxDurSec) maxDurSec = durSec;
      }
    }
  }

  if (tracks.length === 0) return null;
  return {
    tracks,
    durationSec: maxDurSec,
    byteLength: totalLen,
  };
}
