# MinimalCut Stability Roadmap — Progress & Handoff

> ไฟล์นี้ใช้สำหรับส่งต่องาน ถ้าเซสชัน/โมเดลหยุดกลางทาง ให้อ่านไฟล์นี้ก่อนเริ่มทำต่อ
> แผนเต็ม: ดู implementation plan ในแชต (สรุปไว้ด้านล่าง)

## Rules
- Branch: `feat/stability-roadmap` → PR เข้า `main` (ห้าม push เข้า `main` ตรงๆ เพราะจะ auto-deploy ขึ้น GitHub Pages)
- 1 step = 1 commit ที่ผ่าน `npm run build && npm run lint && npm test` เสมอ
- Hosting: GitHub Pages (ต้องตั้ง `base: './'` และใช้ `coi-serviceworker` สำหรับ COOP/COEP)
- ทำต่อเนื่องครบ 3 Phase แล้วค่อยรีวิว (ใช้ subagent ช่วยรีวิว) แล้วเขียนผลลงส่วน "Review findings"
- ถ้า limit ใกล้หมด: ทำ step ที่ค้างให้จบ → อัปเดตไฟล์นี้ → commit + push → แจ้งผู้ใช้

## Resume prompt (คัดลอกให้โมเดลถัดไป)
```
Continue the MinimalCut stability roadmap in /home/antigravity/vinhosen/minimal-cut on branch
feat/stability-roadmap. Read docs/ROADMAP_PROGRESS.md, find the first unchecked step, implement it,
verify with `npm run build && npm run lint && npm test`, commit, update this file, push.
```

## Checklist

### Phase 0 — Bug fixes
- [x] 0.1 Test infra (vitest) + shared `clipSourceTime` (B2) + speed-aware audio (B3)
- [x] 0.2 StrictMode-safe undo/redo/update (B4) + eliminate all 6 `react(refs)`/hooks lint warnings
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
- [/] Subagent code review + fixes
- [ ] Push branch & open PR, walkthrough

## Commit log
| Step | Commit | Notes |
|---|---|---|
| Phase 0 | `2c5585c` | Cut-point flicker/stutter fix, export audio, reverse math, StrictMode undo/redo, 0 lint warnings |
| Phase 1 | `e1c7d3d` | Multi-asset build, COOP/COEP `coi-serviceworker`, FilmCraft `Tick` time base, OPFS recovery, streaming export |

## Open issues / notes
- Baseline: build OK, oxlint 0 errors / 6 warnings (react refs, exhaustive-deps)

## Review findings
(to be filled after review)
