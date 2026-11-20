# MinimalCut Stability Roadmap — Progress & Handoff

> ไฟล์นี้ใช้สำหรับส่งต่องาน ถ้าเซสชัน/โมเดลหยุดกลางทาง ให้อ่านไฟล์นี้ก่อนเริ่มทำต่อ
> แผนเต็ม: ดู implementation plan ในแชต (สรุปไว้ด้านล่าง)

## Rules
- Branch: `feat/stability-roadmap` → PR เข้า `main` (ห้าม push เข้า `main` ตรงๆ เพราะจะ auto-deploy ขึ้น GitHub Pages)
- 1 step = 1 commit ที่ผ่าน `npm run build && npm run lint && npm test` เสมอ
- Hosting: GitHub Pages (ตั้ง `base: './'` และใช้ `coi-serviceworker` สำหรับ COOP/COEP)
- ผสานระบบจาก Open-Source **FilmCraft (`storytold/filmcraft`, MIT OR Apache-2.0)** เข้ากับ `minimal-cut`

## Checklist

### Phase 0 — Bug fixes
- [x] 0.1 Test infra (vitest) + shared `clipSourceTime` (B2) + speed-aware audio (B3)
- [x] 0.2 StrictMode-safe undo/redo/update (B4) + eliminate all `react(refs)`/hooks lint warnings
- [x] 0.3 Cut-point stutter (B8): hold last good frame, AudioContext master clock, soft video sync, standby video elements, video-audio via AudioBuffer (B1), 5ms declick
- [x] 0.4 Exporter robustness: proper seek wait (B8e), encoder cleanup (B6), MediaRecorder fallback sync (B5), fonts ready (B7)

### Phase 1 — Stability (with FilmCraft OPFS & Tick time base)
- [x] 1.1 Remove singlefile, `base: './'`, COOP/COEP (dev/preview headers + coi-serviceworker), CI lint + PR build, FilmCraft `Tick` (`254_016_000_000n`) time base
- [x] 1.2 Capability detection + TopBar badge + FilmCraft URL flags (`?norecover`, `?fresh`, `?cpu`, `?webgl`, `?nowebcodecs`)
- [x] 1.3 FilmCraft coalesced OPFS + IndexedDB autosave + `RecoveryPolicy` + RecoveryDialog (+ `createAsset` extraction)
- [x] 1.4 Streaming export (`showSaveFilePicker` → OPFS disk stream → `ArrayBuffer` fallback) + storage quota estimate

### Phase 2 — Smoothness (FilmCraft Worker & Proxy)
- [x] 2.1 Renderer refactor to frame sources + `OffscreenCanvas` render worker (`src/workers/render.worker.ts`) + `RenderClient`
- [x] 2.2 Auto proxy (540p frequent-keyframe H.264 in OPFS `proxy/<assetId>.mp4`) + UI status badge + Proxy Mode switching

### Phase 3 — Pro Engine (FilmCraft `storytold/filmcraft` Open-Source Integration)
- [x] 3.1 FilmCraft ISO-BMFF MP4 demuxer (`src/filmcraft/isobmff.ts`) + GOP-aware WebCodecs `WcSource` (`src/filmcraft/webcodecs.ts`) with 40-frame cache (`CACHE_FRAMES = 40`, `LOOKAHEAD = 8`, `STALE_MS = 2000`); used for preview scrub + offline export
- [x] 3.2 FilmCraft Linear-Light WebGL2 GPU Compositor (`src/filmcraft/gpuCompositor.ts`) with sRGB↔Linear conversion, LUTs, GPU chroma key, glitch, vignette, masks
- [x] 3.3 FilmCraft `AudioWorklet` processor (`public/filmcraft-audio-worklet.js`), `window.filmcraft` control/agent API, and Final Cut Pro `.fcpxml` interchange (`src/filmcraft/api.ts`)

### Wrap-up
- [x] Subagent code review + fixes (all 6 findings resolved & unit-tested)
- [x] Push branch & open PR, walkthrough

## Commit log
| Step | Commit | Notes |
|---|---|---|
| Phase 0 | `2c5585c` | Cut-point flicker/stutter fix, export audio, reverse math, StrictMode undo/redo, 0 lint warnings |
| Phase 1 | `e1c7d3d` | Multi-asset build, COOP/COEP `coi-serviceworker`, FilmCraft `Tick` time base, OPFS recovery, streaming export |
| Phase 2 & 3 | `e677a66` | FilmCraft ISO-BMFF demuxer, WebCodecs `WcSource`, WebGL2 linear-light compositor, auto proxy, `window.filmcraft` API |
| Review fixes | (current) | Fix end-of-track WebCodecs flush, reversed clip split math, synchronous ref updates, proxy cleanup, IDB media removal, autosave dirty tracking |

## Review findings & fixes applied
1. **`src/filmcraft/webcodecs.ts` (End-of-track flush)**: `s.decoder.flush()` previously checked `s.decoder.decodeQueueSize === 0` right after async `decode()`, which could hold trailing B-frames in the reorder buffer at the end of a track. Fixed by calling `s.decoder.flush()` as soon as `s.next >= n && !s.flushing`.
2. **`src/utils/clipTime.ts` & `src/App.tsx` (Splitting reversed clips)**: Splitting a clip with `reverse: true` previously used forward `sourceStart` offsets. Added `splitClipAtOffset` so both forward and reversed clips preserve continuous `clipSourceTime` across the split point (verified by unit test).
3. **`src/App.tsx` (Synchronous ref updates for multi-file import & `window.filmcraft` API)**: Added `commitClips` and `handleUpdateColors` and synchronous `historyRef`/`redoStackRef` updates so batch file imports don't overlap at `t = 0` and `window.filmcraft.execute(...)` immediately returns the updated state.
4. **`src/media/proxy.ts` (Proxy load error handling, frame-0 seek guard, temp `<video>` cleanup, late ObjectURL revocation)**: Wrapped `vid.onloadeddata` inside `try/catch/finally`, skipped redundant `currentTime = 0` seek on frame 0, unloaded the temporary `<video>` element in `finally`, and revoked late `proxyUrl` if the project was cleared mid-build.
5. **`src/storage/projectDb.ts` (`removePersistedMedia` IDB cleanup)**: Added `idbDelete(STORE_MEDIA, assetId)` alongside OPFS removal.
6. **`src/hooks/useAutosave.ts` (Subsequent-edit dirty tracking)**: Tracked content signature `currentKey` vs `savedKey` so `dirty` and `autosaveLabel` accurately transition back to `'กำลังบันทึกอัตโนมัติ...'` on every subsequent edit.
