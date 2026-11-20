import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AspectRatio,
  ColorSettings,
  ExportSettings,
  MediaAsset,
  TextStyleType,
  TimelineClip,
} from './types/editor';
import { computeAudioPeaks, getCanvasDimensions, nextId } from './utils/timecode';
import { splitClipAtOffset } from './utils/clipTime';
import { exportProjectToMp4, type ExportProgress } from './utils/exporter';
import { exportViaRustEngine, isRustBackendAvailable, uploadMediaToRust } from './utils/rustBridge';
import { ensureAssetAudio } from './audio/scheduleClipAudio';
import { TimelineClock } from './audio/TimelineClock';
import { AudioScheduler } from './audio/AudioScheduler';
import { VideoSyncController } from './engine/VideoSyncController';
import { detectCapabilities } from './utils/capabilities';
import {
  clearAllRecoveryData,
  loadRecoverySnapshot,
  persistMediaFile,
  restoreMediaFile,
  type ProjectSnapshot,
  type RecoveryMeta,
} from './storage/projectDb';
import { useAutosave } from './hooks/useAutosave';
import { createAssetFromFile } from './media/createAsset';
import { generateVideoProxy, shouldBuildAutoProxy } from './media/proxy';
import { RenderClient } from './engine/RenderClient';
import { exportToFcpxml, installFilmCraftWebApi } from './filmcraft/api';
import { RecoveryDialog } from './components/RecoveryDialog';
import { Film, FolderPlus, SlidersHorizontal } from 'lucide-react';
import { TopBar } from './components/TopBar';
import { MediaSidebar } from './components/MediaSidebar';
import { PreviewPlayer } from './components/PreviewPlayer';
import { InspectorPanel } from './components/InspectorPanel';
import { Timeline } from './components/Timeline';
import { ExportModal } from './components/ExportModal';

const DEFAULT_COLORS: ColorSettings = {
  lut: 'normal',
  brightness: 100,
  contrast: 100,
  saturation: 100,
  blur: 0,
  vignette: 0,
  glitch: false,
  chromaKey: false,
  noiseReduce: false,
};

const DEFAULT_EXPORT: ExportSettings = {
  resolution: 1080,
  fps: 60,
  bitrateMbps: 10,
};

export function App() {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const assetsMapRef = useRef<Map<string, MediaAsset>>(new Map());
  const assetsMap = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  const [clips, setClips] = useState<TimelineClip[]>([]);
  const clipsRef = useRef<TimelineClip[]>([]);

  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('16:9');
  const [proxyMode, setProxyMode] = useState(false);
  const [colors, setColors] = useState<ColorSettings>(DEFAULT_COLORS);
  const colorsRef = useRef<ColorSettings>(colors);

  const [exportSettings, setExportSettings] = useState<ExportSettings>(DEFAULT_EXPORT);
  const [zoom, setZoom] = useState(70);
  const [snap, setSnap] = useState(true);
  const [loop, setLoop] = useState(false);
  const loopRef = useRef(loop);

  const [playhead, setPlayhead] = useState(0);
  const playheadRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);
  const [liveFps, setLiveFps] = useState(0);

  const [history, setHistory] = useState<TimelineClip[][]>([]);
  const [redoStack, setRedoStack] = useState<TimelineClip[][]>([]);
  const [toast, setToast] = useState<string | null>(null);

  // Mic, Audio Meter & AI states
  const [isRecordingMic, setIsRecordingMic] = useState(false);
  const [micStatus, setMicStatus] = useState('พร้อมอัดเสียงพากย์ผ่านไมโครโฟน');
  const [audioDb, setAudioDb] = useState('-∞ dB');
  const [aiLogs, setAiLogs] = useState<string[]>(['พร้อมใช้งานเครื่องมืออัตโนมัติ']);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [whisperProvider, setWhisperProvider] = useState<'gemini' | 'groq' | 'openai'>(
    () => (localStorage.getItem('minimalcut_whisper_provider') as 'gemini' | 'groq' | 'openai') || 'gemini'
  );
  const [whisperApiKey, setWhisperApiKey] = useState(
    () => localStorage.getItem('minimalcut_whisper_key') || ''
  );

  // Export modal state
  const [exportOpen, setExportOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<'timeline' | 'media' | 'inspector'>('timeline');
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportDone, setExportDone] = useState<{ filename: string; sizeMb: string; engine: string } | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDraggingPreviewRef = useRef(false);

  // Web Audio context & FX nodes
  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const noiseFilterRef = useRef<BiquadFilterNode | null>(null);
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const playRequestIdRef = useRef(0);
  const pendingPlayRef = useRef(false);
  const vfcPaintedThisFrameRef = useRef(false);
  const elementAudioBridgeRef = useRef(
    new WeakMap<HTMLVideoElement, { ctx: AudioContext; gain: GainNode }>()
  );

  const micRecorderRef = useRef<MediaRecorder | null>(null);
  const micChunksRef = useRef<Blob[]>([]);
  const micStreamRef = useRef<MediaStream | null>(null);

  const capabilities = useMemo(() => detectCapabilities(), []);
  const webCodecsSupported = capabilities.webCodecsEncode;
  const serverIdMapRef = useRef<Map<string, string>>(new Map());
  const rustAvailableRef = useRef(false);

  const [recoveryCandidate, setRecoveryCandidate] = useState<{
    meta: RecoveryMeta;
    snapshot: ProjectSnapshot;
  } | null>(null);
  const [isRestoringRecovery, setIsRestoringRecovery] = useState(false);

  useEffect(() => {
    isRustBackendAvailable().then((ok) => {
      rustAvailableRef.current = ok;
    });
  }, []);

  // FilmCraft OPFS / IndexedDB Crash-Recovery check on startup
  useEffect(() => {
    if (capabilities.flags.fresh) {
      void clearAllRecoveryData();
      return;
    }
    if (capabilities.flags.noRecover) {
      return;
    }
    loadRecoverySnapshot()
      .then((found) => {
        if (found && clipsRef.current.length === 0) {
          setRecoveryCandidate(found);
        }
      })
      .catch(() => {});
  }, [capabilities.flags.fresh, capabilities.flags.noRecover]);

  const { autosaveLabel } = useAutosave({
    clips,
    assets,
    colors,
    aspectRatio,
    exportSettings,
    enabled: !recoveryCandidate,
  });

  const canvasDims = useMemo(
    () => getCanvasDimensions(aspectRatio, exportSettings.resolution, proxyMode),
    [aspectRatio, exportSettings.resolution, proxyMode]
  );

  const totalDuration = useMemo(
    () => (clips.length ? Math.max(...clips.map((c) => c.timelineStart + c.duration)) : 0),
    [clips]
  );
  const totalDurationRef = useRef(0);

  const selectedClip = useMemo(
    () => clips.find((c) => c.id === selectedClipId) || null,
    [clips, selectedClipId]
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((prev) => (prev === msg ? null : prev)), 2800);
  }, []);

  const historyRef = useRef<TimelineClip[][]>([]);
  const redoStackRef = useRef<TimelineClip[][]>([]);

  const pushHistory = useCallback((snapshot: TimelineClip[]) => {
    const next = [...historyRef.current.slice(-29), snapshot.map((c) => ({ ...c }))];
    historyRef.current = next;
    redoStackRef.current = [];
    setHistory(next);
    setRedoStack([]);
  }, []);

  const commitClips = useCallback((next: TimelineClip[]) => {
    clipsRef.current = next;
    totalDurationRef.current = next.length ? Math.max(...next.map((c) => c.timelineStart + c.duration)) : 0;
    setClips(next);
  }, []);

  const handleUpdateColors = useCallback((patch: Partial<ColorSettings>) => {
    const next = { ...colorsRef.current, ...patch };
    colorsRef.current = next;
    setColors(next);
  }, []);

  // Phase 2: Authoritative Master Clock anchored strictly to AudioContext.currentTime
  const timelineClockRef = useRef<TimelineClock | null>(null);
  const getTimelineClock = useCallback(() => {
    if (!timelineClockRef.current) {
      timelineClockRef.current = new TimelineClock();
    }
    return timelineClockRef.current;
  }, []);

  // Phase 2: Deterministic 150ms lookahead Web Audio scheduler
  const audioSchedulerRef = useRef<AudioScheduler | null>(null);
  const getAudioScheduler = useCallback(() => {
    if (!audioSchedulerRef.current) {
      audioSchedulerRef.current = new AudioScheduler(getTimelineClock());
    }
    return audioSchedulerRef.current;
  }, [getTimelineClock]);

  // Forward-declared so the video controller (rVFC / seeked) and WebCodecs decoder can trigger redraws.
  const drawNowRef = useRef<(time: number) => void>(() => {});
  const videoSyncRef = useRef<VideoSyncController | null>(null);
  const getVideoSync = useCallback(() => {
    if (!videoSyncRef.current) {
      videoSyncRef.current = new VideoSyncController(
        () => assetsMapRef.current,
        () => {
          if (isPlayingRef.current) {
            const liveT = Math.min(getTimelineClock().getCurrentTime(), totalDurationRef.current);
            playheadRef.current = liveT;
            drawNowRef.current(liveT);
            vfcPaintedThisFrameRef.current = true;
          } else {
            drawNowRef.current(playheadRef.current);
          }
        }
      );
    }
    return videoSyncRef.current;
  }, [getTimelineClock]);

  const renderClientRef = useRef<RenderClient | null>(null);
  const getRenderClient = useCallback(() => {
    if (!renderClientRef.current) {
      renderClientRef.current = new RenderClient(() => {
        if (!isPlayingRef.current) drawNowRef.current(playheadRef.current);
      });
    }
    return renderClientRef.current;
  }, []);

  useEffect(() => {
    getVideoSync().setProxyMode(proxyMode);
  }, [getVideoSync, proxyMode]);

  // Immediate audio, video, clock, and export cleanup on component unmount
  useEffect(() => {
    return () => {
      playRequestIdRef.current += 1;
      pendingPlayRef.current = false;
      isPlayingRef.current = false;
      timelineClockRef.current?.pause();
      exportAbortRef.current?.abort();
      audioSchedulerRef.current?.stopAll();
      videoSyncRef.current?.reset();
      renderClientRef.current?.reset();
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  const drawNow = useCallback(
    (time: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;
      const sync = getVideoSync();
      getRenderClient().render({
        ctx,
        width: canvas.width,
        height: canvas.height,
        time,
        isPlaying: isPlayingRef.current,
        clips: clipsRef.current,
        assets: assetsMapRef.current,
        colors: colorsRef.current,
        showCenterGuides: isDraggingPreviewRef.current,
        videoSource: (clip) => sync.elementFor(clip),
      });
    },
    [getRenderClient, getVideoSync]
  );

  useEffect(() => {
    clipsRef.current = clips;
    colorsRef.current = colors;
    loopRef.current = loop;
    totalDurationRef.current = totalDuration;
    historyRef.current = history;
    redoStackRef.current = redoStack;
    drawNowRef.current = drawNow;
  }, [clips, colors, loop, totalDuration, history, redoStack, drawNow]);

  useEffect(() => {
    clipsRef.current = clips;
    colorsRef.current = colors;
    drawNow(playheadRef.current);
  }, [clips, colors, canvasDims, drawNow]);

  const stopAllAudio = useCallback(() => {
    getAudioScheduler().stopAll();
  }, [getAudioScheduler]);

  const ensureAudioCtx = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      audioCtxRef.current = ctx;

      const master = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = colorsRef.current.noiseReduce ? 'highpass' : 'allpass';
      filter.frequency.value = 160;

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -24;
      comp.ratio.value = 4;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;

      master.connect(filter);
      filter.connect(comp);
      comp.connect(analyser);
      analyser.connect(ctx.destination);

      masterGainRef.current = master;
      noiseFilterRef.current = filter;
      compressorRef.current = comp;
      analyserRef.current = analyser;
    }
    getTimelineClock().attach(audioCtxRef.current);
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
    return audioCtxRef.current;
  }, [getTimelineClock]);

  useEffect(() => {
    if (noiseFilterRef.current) {
      noiseFilterRef.current.type = colors.noiseReduce ? 'highpass' : 'allpass';
    }
  }, [colors.noiseReduce]);

  const startAudioAt = useCallback(
    (reanchorSec?: number) => {
      const ctx = audioCtxRef.current;
      if (!ctx || ctx.state !== 'running') return;
      getTimelineClock().attach(ctx);
      if (reanchorSec !== undefined) {
        getTimelineClock().seek(reanchorSec);
      }
      getAudioScheduler().restart(
        ctx,
        masterGainRef.current || ctx.destination,
        clipsRef.current,
        assetsMapRef.current
      );
    },
    [getAudioScheduler, getTimelineClock]
  );

  /** Seamlessly schedule newly decoded audio assets without cutting already-playing tracks. */
  const pumpAudio = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx || ctx.state !== 'running' || !isPlayingRef.current) return;
    getAudioScheduler().pump(
      ctx,
      masterGainRef.current || ctx.destination,
      clipsRef.current,
      assetsMapRef.current
    );
  }, [getAudioScheduler]);

  /**
   * Routes a `<video>` element's audio through Web Audio (`MediaElementAudioSourceNode`) when its
   * `AudioBuffer` has not decoded yet or failed `decodeAudioData`, keeping all audio inside the graph.
   */
  const connectElementAudio = useCallback((el: HTMLVideoElement, active: boolean, volume: number): boolean => {
    const ctx = audioCtxRef.current;
    if (!ctx || ctx.state === 'closed') return false;
    const existing = elementAudioBridgeRef.current.get(el);
    if (existing) {
      if (existing.ctx !== ctx) return false;
      existing.gain.gain.value = active ? Math.max(0, volume) : 0;
      return true;
    }
    if (!active) return true;
    try {
      const src = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      gain.gain.value = Math.max(0, volume);
      src.connect(gain);
      gain.connect(masterGainRef.current || ctx.destination);
      elementAudioBridgeRef.current.set(el, { ctx, gain });
      return true;
    } catch {
      return false;
    }
  }, []);

  const syncVideoElements = useCallback(
    (time: number, forceSeek: boolean) => {
      const sync = getVideoSync();
      // Phase 2 Guardrails: Mute <video> when AudioBuffer plays via AudioScheduler,
      // route fallback unbuffered audio through Web Audio bridge, and slave drift > 80ms.
      const syncOpts = {
        driftThresholdSec: 0.08,
        alwaysMuteVideo: true,
        connectElementAudio,
      };
      if (forceSeek) {
        sync.seekDiscrete(time, clipsRef.current, isPlayingRef.current, syncOpts);
      } else {
        sync.updatePlayback(time, clipsRef.current, syncOpts);
      }
    },
    [connectElementAudio, getVideoSync]
  );

  const seekTo = useCallback(
    (time: number) => {
      const clamped = Math.max(0, Math.min(time, totalDurationRef.current));
      playheadRef.current = clamped;
      setPlayhead(clamped);
      getTimelineClock().seek(clamped);
      stopAllAudio();
      syncVideoElements(clamped, true);
      if (isPlayingRef.current) startAudioAt();
      drawNow(clamped);
    },
    [drawNow, getTimelineClock, startAudioAt, stopAllAudio, syncVideoElements]
  );

  const togglePlay = useCallback(
    (force?: boolean) => {
      const total = totalDurationRef.current;
      const next = force !== undefined ? force : !(isPlayingRef.current || pendingPlayRef.current);
      const reqId = ++playRequestIdRef.current;

      // Always execute pause/stop BEFORE checking totalDuration so deleting/undoing the last clip
      // during active playback cleanly halts playback instead of looping forever.
      if (!next) {
        pendingPlayRef.current = false;
        const frozen = getTimelineClock().pause();
        isPlayingRef.current = false;
        setIsPlaying(false);
        const clampedFrozen = Math.max(0, Math.min(frozen, total));
        playheadRef.current = clampedFrozen;
        setPlayhead(clampedFrozen);
        getVideoSync().pauseAll();
        stopAllAudio();
        setAudioDb('-∞ dB');
        return;
      }

      if (total <= 0) {
        pendingPlayRef.current = false;
        showToast('กรุณาเพิ่มคลิปลงไทม์ไลน์ก่อนเล่นครับ');
        return;
      }

      const ctx = ensureAudioCtx();
      if (playheadRef.current >= total) {
        playheadRef.current = 0;
        setPlayhead(0);
      }
      pendingPlayRef.current = true;

      const startPlayback = () => {
        if (playRequestIdRef.current !== reqId || ctx.state === 'closed') {
          if (playRequestIdRef.current === reqId) pendingPlayRef.current = false;
          return;
        }
        pendingPlayRef.current = false;
        if (totalDurationRef.current <= 0) return;
        if (ctx.state !== 'running') {
          showToast('ไม่สามารถเปิดระบบเสียง (AudioContext) ได้ กรุณากดเล่นอีกครั้ง');
          return;
        }

        const startPos = Math.min(playheadRef.current, totalDurationRef.current);
        playheadRef.current = startPos;
        isPlayingRef.current = true;
        setIsPlaying(true);
        vfcPaintedThisFrameRef.current = false;
        getTimelineClock().attach(ctx);
        getTimelineClock().start(startPos);
        syncVideoElements(startPos, true);
        getAudioScheduler().restart(
          ctx,
          masterGainRef.current || ctx.destination,
          clipsRef.current,
          assetsMapRef.current
        );
        // Ensure any un-decoded audio/video asset decodes into AudioBuffer and joins lookahead pump
        assetsMapRef.current.forEach((asset) => {
          if ((asset.type === 'video' || asset.type === 'audio') && !asset.audioBuffer && asset.audioStatus !== 'none') {
            ensureAssetAudio(asset, ctx).then((buf) => {
              if (!buf || !isPlayingRef.current || ctx.state !== 'running') return;
              getAudioScheduler().pump(
                ctx,
                masterGainRef.current || ctx.destination,
                clipsRef.current,
                assetsMapRef.current
              );
            });
          }
        });
      };

      if (ctx.state === 'suspended') {
        ctx
          .resume()
          .then(startPlayback)
          .catch(() => {
            if (playRequestIdRef.current === reqId) {
              pendingPlayRef.current = false;
              showToast('ไม่สามารถเปิดระบบเสียง (AudioContext) ได้ กรุณากดเล่นอีกครั้ง');
            }
          });
      } else {
        startPlayback();
      }
    },
    [ensureAudioCtx, getAudioScheduler, getTimelineClock, getVideoSync, showToast, stopAllAudio, syncVideoElements]
  );

  // Playback rAF Loop driven exclusively by the AudioContext Master Clock (TimelineClock)
  useEffect(() => {
    let rafId = 0;
    let fpsCounter = 0;
    let fpsTimer = 0;
    let dbTimer = 0;
    let uiPlayheadTimer = 0;
    const dbData = new Uint8Array(128);

    const tick = (now: number) => {
      if (fpsTimer === 0) {
        fpsTimer = now;
        dbTimer = now;
        uiPlayheadTimer = now;
      }

      if (isPlayingRef.current) {
        const clock = getTimelineClock();
        let nextTime = clock.getCurrentTime();
        const total = totalDurationRef.current;

        if (nextTime >= total) {
          vfcPaintedThisFrameRef.current = false;
          if (loopRef.current && total > 0) {
            nextTime = 0;
            playheadRef.current = 0;
            setPlayhead(0);
            clock.start(0);
            syncVideoElements(0, true);
            startAudioAt(0);
          } else {
            nextTime = total;
            playheadRef.current = total;
            setPlayhead(total);
            togglePlay(false);
          }
        } else {
          playheadRef.current = nextTime;
          // Pump the deterministic 150ms Web Audio lookahead scheduler
          if (audioCtxRef.current && audioCtxRef.current.state === 'running') {
            getAudioScheduler().pump(
              audioCtxRef.current,
              masterGainRef.current || audioCtxRef.current.destination,
              clipsRef.current,
              assetsMapRef.current
            );
          }
          // Throttle React state updates to ~30Hz while canvas updates via rVFC/rAF at full refresh rate
          if (now - uiPlayheadTimer >= 32) {
            setPlayhead(nextTime);
            uiPlayheadTimer = now;
          }
          syncVideoElements(nextTime, false);
        }

        // Coalesce with rVFC: skip duplicate composite if rVFC already drew this paint frame
        if (vfcPaintedThisFrameRef.current) {
          vfcPaintedThisFrameRef.current = false;
        } else {
          drawNow(playheadRef.current);
        }

        fpsCounter++;
        if (now - fpsTimer >= 500) {
          setLiveFps(Math.round((fpsCounter * 1000) / (now - fpsTimer)));
          fpsCounter = 0;
          fpsTimer = now;
        }
        if (now - dbTimer >= 120 && analyserRef.current) {
          analyserRef.current.getByteTimeDomainData(dbData);
          let sum = 0;
          for (let i = 0; i < dbData.length; i++) {
            const v = (dbData[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / dbData.length);
          const db = rms > 0.0001 ? 20 * Math.log10(rms) : -100;
          setAudioDb(db <= -60 ? '-∞ dB' : `${db.toFixed(1)} dB`);
          dbTimer = now;
        }
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [drawNow, getAudioScheduler, getTimelineClock, startAudioAt, syncVideoElements, togglePlay]);

  // Fast Zero-Copy File Import (no IndexedDB blob blocking!)
  const addAssetToTimeline = useCallback(
    (asset: MediaAsset, currentClips?: TimelineClip[]) => {
      const list = currentClips || clipsRef.current;
      pushHistory(list);

      let newClip: TimelineClip;
      if (asset.type === 'video') {
        const startAt = list
          .filter((c) => c.track === 'video')
          .reduce((m, c) => Math.max(m, c.timelineStart + c.duration), 0);
        newClip = {
          id: nextId('clip'),
          track: 'video',
          name: asset.name,
          mediaId: asset.id,
          timelineStart: startAt,
          duration: asset.duration,
          sourceStart: 0,
          sourceDuration: asset.duration,
          x: 0,
          y: 0,
          scale: 100,
          opacity: 100,
          rotation: 0,
          crop: 0,
          flipH: false,
          flipV: false,
          blend: 'source-over',
          mask: 'none',
          transition: 'none',
          speed: 1,
          reverse: false,
          muted: false,
          volume: 100,
          fadeIn: 0,
          fadeOut: 0,
        };
      } else if (asset.type === 'image') {
        newClip = {
          id: nextId('clip'),
          track: 'image',
          name: asset.name,
          mediaId: asset.id,
          timelineStart: playheadRef.current,
          duration: 5,
          sourceStart: 0,
          sourceDuration: 600,
          x: 0,
          y: 0,
          scale: 60,
          opacity: 100,
          rotation: 0,
          crop: 0,
          flipH: false,
          flipV: false,
          blend: 'source-over',
          mask: 'none',
          transition: 'fade',
          speed: 1,
          reverse: false,
          muted: false,
          volume: 100,
          fadeIn: 0,
          fadeOut: 0,
        };
      } else {
        const startAt = list
          .filter((c) => c.track === 'audio')
          .reduce((m, c) => Math.max(m, c.timelineStart + c.duration), 0);
        newClip = {
          id: nextId('clip'),
          track: 'audio',
          name: asset.name,
          mediaId: asset.id,
          timelineStart: startAt,
          duration: asset.duration,
          sourceStart: 0,
          sourceDuration: asset.duration,
          x: 0,
          y: 0,
          scale: 100,
          opacity: 100,
          rotation: 0,
          crop: 0,
          flipH: false,
          flipV: false,
          blend: 'source-over',
          mask: 'none',
          transition: 'none',
          speed: 1,
          reverse: false,
          muted: false,
          volume: 100,
          fadeIn: 0,
          fadeOut: 0,
        };
      }

      const next = [...list, newClip];
      commitClips(next);
      setSelectedClipId(newClip.id);
    },
    [commitClips, pushHistory]
  );

  const attachVideoEnhancements = useCallback(
    (asset: MediaAsset) => {
      if (asset.type !== 'video') return;
      getRenderClient().registerAsset(asset);
      if (shouldBuildAutoProxy(asset)) {
        void generateVideoProxy(asset, (patch) => {
          if (!assetsMapRef.current.has(asset.id)) {
            if (patch.proxyUrl) URL.revokeObjectURL(patch.proxyUrl);
            return;
          }
          Object.assign(asset, patch);
          setAssets((prev) => prev.map((a) => (a.id === asset.id ? { ...asset } : a)));
        });
      }
    },
    [getRenderClient]
  );

  const handleImportFiles = useCallback(
    async (fileList: FileList | File[]) => {
      for (const file of Array.from(fileList)) {
        try {
          const asset = await createAssetFromFile(file, {
            getAudioCtx: ensureAudioCtx,
            onAudioReady: (readyAsset) => {
              if (!assetsMapRef.current.has(readyAsset.id)) return;
              setAssets((prev) => prev.map((a) => (a.id === readyAsset.id ? { ...readyAsset } : a)));
              if (isPlayingRef.current) {
                if (readyAsset.type === 'video') syncVideoElements(playheadRef.current, false);
                pumpAudio();
              }
            },
          });
          assetsMapRef.current.set(asset.id, asset);
          setAssets((prev) => [...prev, asset]);
          addAssetToTimeline(asset);
          attachVideoEnhancements(asset);
          showToast(`นำเข้า "${file.name}" แล้ว`);

          // Persist media file in background to FilmCraft OPFS / IndexedDB for crash recovery
          void persistMediaFile(asset.id, file);

          if (rustAvailableRef.current) {
            uploadMediaToRust(file).then((sid) => {
              if (sid) serverIdMapRef.current.set(asset.id, sid);
            });
          }
        } catch (err) {
          showToast(err instanceof Error ? err.message : `ไม่สามารถเปิดไฟล์ "${file.name}" ได้`);
        }
      }
    },
    [addAssetToTimeline, attachVideoEnhancements, ensureAudioCtx, pumpAudio, showToast, syncVideoElements]
  );

  const handleRestoreRecovery = useCallback(async () => {
    if (!recoveryCandidate) return;
    setIsRestoringRecovery(true);
    try {
      const { snapshot } = recoveryCandidate;
      const restoredAssets: MediaAsset[] = [];

      for (const item of snapshot.assetsManifest) {
        const file = await restoreMediaFile(item);
        if (!file) continue;
        try {
          const asset = await createAssetFromFile(file, {
            id: item.id,
            getAudioCtx: ensureAudioCtx,
            onAudioReady: (readyAsset) => {
              if (!assetsMapRef.current.has(readyAsset.id)) return;
              setAssets((prev) => prev.map((a) => (a.id === readyAsset.id ? { ...readyAsset } : a)));
              pumpAudio();
            },
          });
          assetsMapRef.current.set(asset.id, asset);
          attachVideoEnhancements(asset);
          restoredAssets.push(asset);
        } catch {
          // skip unreadable media
        }
      }

      if (snapshot.aspectRatio) setAspectRatio(snapshot.aspectRatio);
      if (snapshot.colors) handleUpdateColors({ ...DEFAULT_COLORS, ...snapshot.colors });
      if (snapshot.exportSettings) setExportSettings(snapshot.exportSettings);
      setAssets(restoredAssets);
      commitClips(snapshot.clips);
      setRecoveryCandidate(null);
      showToast(`กู้คืนโปรเจกต์สำเร็จ (${snapshot.clips.length} คลิป)`);
    } catch {
      showToast('ไม่สามารถกู้คืนโปรเจกต์ได้');
      setRecoveryCandidate(null);
    } finally {
      setIsRestoringRecovery(false);
    }
  }, [attachVideoEnhancements, commitClips, ensureAudioCtx, handleUpdateColors, pumpAudio, recoveryCandidate, showToast]);

  const handleDiscardRecovery = useCallback(async () => {
    setRecoveryCandidate(null);
    await clearAllRecoveryData();
    showToast('เริ่มโปรเจกต์ใหม่แล้ว');
  }, [showToast]);

  const handleAddTextClip = useCallback(
    (text: string, style: TextStyleType, y?: number, dur = 4) => {
      pushHistory(clipsRef.current);
      const newClip: TimelineClip = {
        id: nextId('fx'),
        track: 'fx',
        name: text.slice(0, 18),
        mediaId: null,
        timelineStart: playheadRef.current,
        duration: dur,
        sourceStart: 0,
        sourceDuration: 600,
        x: 0,
        y: 0,
        scale: 100,
        opacity: 100,
        rotation: 0,
        crop: 0,
        flipH: false,
        flipV: false,
        blend: 'source-over',
        mask: 'none',
        transition: 'none',
        speed: 1,
        reverse: false,
        muted: false,
        volume: 100,
        fadeIn: 0,
        fadeOut: 0,
        fxData: {
          text,
          style,
          anim: 'fade',
          color: '#FFFFFF',
          bgColor: '#0EA5E9',
          fontSize: style === 'title' ? 42 : 30,
          x: 50,
          y: y ?? (style === 'title' ? 50 : 82),
        },
      };
      commitClips([...clipsRef.current, newClip]);
      setSelectedClipId(newClip.id);
    },
    [commitClips, pushHistory]
  );

  const handleUpdateClip = useCallback(
    (id: string, patch: Partial<TimelineClip>, commitHistory = false) => {
      if (commitHistory) {
        pushHistory(clipsRef.current);
      }
      const next = clipsRef.current.map((c) => (c.id === id ? { ...c, ...patch } : c));
      commitClips(next);

      if (
        isPlayingRef.current &&
        ('muted' in patch ||
          'volume' in patch ||
          'speed' in patch ||
          'reverse' in patch ||
          'fadeIn' in patch ||
          'fadeOut' in patch ||
          'timelineStart' in patch ||
          'duration' in patch ||
          'sourceStart' in patch ||
          'normalizeGain' in patch ||
          'audioKeyframes' in patch)
      ) {
        startAudioAt();
      }
    },
    [commitClips, pushHistory, startAudioAt]
  );

  const handleSplit = useCallback(() => {
    const t = playheadRef.current;
    const target =
      clipsRef.current.find(
        (c) => c.id === selectedClipId && t > c.timelineStart + 0.05 && t < c.timelineStart + c.duration - 0.05
      ) ||
      clipsRef.current.find((c) => t > c.timelineStart + 0.05 && t < c.timelineStart + c.duration - 0.05);

    if (!target) {
      showToast('เลื่อนเส้นสีแดงไปตรงกลางคลิปที่ต้องการตัดแบ่งก่อนครับ');
      return;
    }

    pushHistory(clipsRef.current);
    const offset = t - target.timelineStart;
    const [leftClip, rightClip] = splitClipAtOffset(target, offset, nextId('clip'));

    const next = [...clipsRef.current.filter((c) => c.id !== target.id), leftClip, rightClip];
    commitClips(next);
    setSelectedClipId(rightClip.id);
    if (isPlayingRef.current) startAudioAt();
    showToast('ตัดแบ่งคลิปแล้ว');
  }, [commitClips, pushHistory, selectedClipId, showToast, startAudioAt]);

  const handleDelete = useCallback(() => {
    if (!selectedClipId) return;
    pushHistory(clipsRef.current);
    const next = clipsRef.current.filter((c) => c.id !== selectedClipId);
    commitClips(next);
    setSelectedClipId(null);
    if (isPlayingRef.current) startAudioAt();
  }, [commitClips, pushHistory, selectedClipId, startAudioAt]);

  const handleRippleDelete = useCallback(() => {
    const sel = clipsRef.current.find((c) => c.id === selectedClipId);
    if (!sel) return;
    pushHistory(clipsRef.current);
    const gap = sel.duration;
    const end = sel.timelineStart + sel.duration;
    const next = clipsRef.current
      .filter((c) => c.id !== sel.id)
      .map((c) =>
        c.track === sel.track && c.timelineStart >= end - 0.01
          ? { ...c, timelineStart: Math.max(0, c.timelineStart - gap) }
          : c
      );
    commitClips(next);
    setSelectedClipId(null);
    if (isPlayingRef.current) startAudioAt();
    showToast('ลบและเลื่อนคลิปมาชิดกันแล้ว');
  }, [commitClips, pushHistory, selectedClipId, showToast, startAudioAt]);

  const handleUndo = useCallback(() => {
    const prevHist = historyRef.current;
    if (!prevHist.length) return;
    const last = prevHist[prevHist.length - 1];
    const currentSnapshot = clipsRef.current.map((c) => ({ ...c }));
    const nextHist = prevHist.slice(0, -1);
    const nextRedo = [...redoStackRef.current, currentSnapshot];
    historyRef.current = nextHist;
    redoStackRef.current = nextRedo;
    setHistory(nextHist);
    setRedoStack(nextRedo);
    commitClips(last);
    if (isPlayingRef.current) startAudioAt();
  }, [commitClips, startAudioAt]);

  const handleRedo = useCallback(() => {
    const prevRedo = redoStackRef.current;
    if (!prevRedo.length) return;
    const next = prevRedo[prevRedo.length - 1];
    const currentSnapshot = clipsRef.current.map((c) => ({ ...c }));
    const nextRedo = prevRedo.slice(0, -1);
    const nextHist = [...historyRef.current, currentSnapshot];
    redoStackRef.current = nextRedo;
    historyRef.current = nextHist;
    setRedoStack(nextRedo);
    setHistory(nextHist);
    commitClips(next);
    if (isPlayingRef.current) startAudioAt();
  }, [commitClips, startAudioAt]);

  const handleClearProject = useCallback(() => {
    togglePlay(false);
    stopAllAudio();
    videoSyncRef.current?.reset();
    renderClientRef.current?.reset();
    assetsMapRef.current.forEach((a) => {
      URL.revokeObjectURL(a.url);
      if (a.proxyUrl) URL.revokeObjectURL(a.proxyUrl);
    });
    assetsMapRef.current.clear();
    setAssets([]);
    commitClips([]);
    setSelectedClipId(null);
    historyRef.current = [];
    redoStackRef.current = [];
    setHistory([]);
    setRedoStack([]);
    void clearAllRecoveryData();
    seekTo(0);
    showToast('เริ่มโปรเจกต์ใหม่แล้ว');
  }, [commitClips, seekTo, showToast, stopAllAudio, togglePlay]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 's' || e.key === 'S') {
        handleSplit();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        handleDelete();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleDelete, handleRedo, handleSplit, handleUndo, togglePlay]);

  // Export Handler (120 FPS WebCodecs Streaming Engine)
  const handleStartExport = async () => {
    if (totalDuration <= 0) return;
    togglePlay(false);

    setIsExporting(true);
    setExportError(null);
    setExportDone(null);
    setExportProgress({ percent: 0, message: 'กำลังเตรียมตัวเข้ารหัส...', currentFrame: 0, totalFrames: 1 });

    const abort = new AbortController();
    exportAbortRef.current = abort;

    try {
      const canUseRust =
        rustAvailableRef.current &&
        clipsRef.current.every((c) => !c.mediaId || serverIdMapRef.current.has(c.mediaId));

      if (canUseRust) {
        const res = await exportViaRustEngine({
          aspectRatio,
          clips: clipsRef.current,
          colors: colorsRef.current,
          settings: exportSettings,
          serverIdMap: serverIdMapRef.current,
          signal: abort.signal,
          onProgress: (percent, message) =>
            setExportProgress({ percent, message, currentFrame: 0, totalFrames: 1 }),
        });

        const a = document.createElement('a');
        a.href = res.url;
        a.download = res.filename;
        a.click();

        setExportDone({
          filename: res.filename,
          sizeMb: res.sizeMb,
          engine: 'rust-ffmpeg',
        });
      } else {
        const res = await exportProjectToMp4({
          clips: clipsRef.current,
          assets: assetsMapRef.current,
          colors: colorsRef.current,
          aspectRatio,
          settings: exportSettings,
          totalDuration,
          signal: abort.signal,
          onProgress: setExportProgress,
          decodeFrame: (asset, srcT) => getRenderClient().decodeFrameForExport(asset, srcT),
        });

        if (!res.savedDirectly) {
          const url = URL.createObjectURL(res.blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = res.filename;
          a.click();
          setTimeout(() => {
            URL.revokeObjectURL(url);
            void res.cleanup?.();
          }, 5000);
        }

        setExportDone({
          filename: res.filename,
          sizeMb: (res.blob.size / (1024 * 1024)).toFixed(2),
          engine: res.engine,
        });
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการบันทึกวิดีโอ');
    } finally {
      setIsExporting(false);
      exportAbortRef.current = null;
      syncVideoElements(playheadRef.current, true);
      drawNow(playheadRef.current);
    }
  };

  const appendAiLog = useCallback((msg: string) => {
    setAiLogs((prev) => [...prev.slice(-19), msg]);
  }, []);

  // --- Video & Audio Keyframes ---
  const handleAddVideoKeyframe = useCallback(
    (clipId: string) => {
      const clip = clipsRef.current.find((c) => c.id === clipId);
      if (!clip) return;
      const t = Math.max(0, Math.min(clip.duration, playheadRef.current - clip.timelineStart));
      const existing = (clip.keyframes || []).filter((k) => Math.abs(k.t - t) > 0.05);
      const next = [...existing, { t, x: clip.x, y: clip.y, scale: clip.scale, opacity: clip.opacity }].sort(
        (a, b) => a.t - b.t
      );
      handleUpdateClip(clipId, { keyframes: next }, true);
      showToast(`บันทึก Keyframe ที่ ${t.toFixed(2)} วิ (รวม ${next.length} จุด)`);
    },
    [handleUpdateClip, showToast]
  );

  const handleClearVideoKeyframes = useCallback(
    (clipId: string) => {
      handleUpdateClip(clipId, { keyframes: [] }, true);
      showToast('ล้าง Keyframe แล้ว');
    },
    [handleUpdateClip, showToast]
  );

  const handleAddAudioKeyframe = useCallback(
    (clipId: string) => {
      const clip = clipsRef.current.find((c) => c.id === clipId);
      if (!clip) return;
      const t = Math.max(0, Math.min(clip.duration, playheadRef.current - clip.timelineStart));
      const gain = clip.muted ? 0 : (clip.volume ?? 100) / 100;
      const existing = (clip.audioKeyframes || []).filter((k) => Math.abs(k.t - t) > 0.05);
      const next = [...existing, { t, gain }].sort((a, b) => a.t - b.t);
      handleUpdateClip(clipId, { audioKeyframes: next }, true);
      showToast(`ปักหมุดระดับเสียงที่ ${t.toFixed(2)} วิ`);
    },
    [handleUpdateClip, showToast]
  );

  const handleNormalizeAudio = useCallback(
    (clipId: string) => {
      const clip = clipsRef.current.find((c) => c.id === clipId);
      if (!clip || !clip.mediaId) return;
      const asset = assetsMapRef.current.get(clip.mediaId);
      if (!asset?.audioBuffer) {
        showToast('กำลังถอดรหัสไฟล์เสียง กรุณารอสักครู่แล้วลองใหม่');
        return;
      }
      let peak = 0;
      for (let ch = 0; ch < asset.audioBuffer.numberOfChannels; ch++) {
        const data = asset.audioBuffer.getChannelData(ch);
        for (let i = 0; i < data.length; i += 4) {
          const abs = Math.abs(data[i]);
          if (abs > peak) peak = abs;
        }
      }
      const gain = peak > 0.01 ? Math.min(3, 0.92 / peak) : 1;
      handleUpdateClip(clipId, { normalizeGain: gain }, true);
      showToast(`ปรับระดับเสียงให้สม่ำเสมอแล้ว (×${gain.toFixed(2)})`);
    },
    [handleUpdateClip, showToast]
  );

  // --- Freeze Frame (2s PNG capture) ---
  const handleFreezeFrame = useCallback(
    (clipId: string) => {
      const clip = clipsRef.current.find((c) => c.id === clipId);
      if (!clip || !clip.mediaId) return;
      const asset = assetsMapRef.current.get(clip.mediaId);
      if (!asset?.videoEl) return;

      const vid = asset.videoEl;
      const off = document.createElement('canvas');
      off.width = vid.videoWidth || 1280;
      off.height = vid.videoHeight || 720;
      const ctx = off.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(vid, 0, 0, off.width, off.height);

      off.toBlob((blob) => {
        if (!blob) return;
        const file = new File([blob], `freeze_${Date.now()}.png`, { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          const newAsset: MediaAsset = {
            id: nextId('img'),
            type: 'image',
            name: `ภาพนิ่ง (${clip.name.slice(0, 12)})`,
            url,
            file,
            duration: 2,
            width: img.width,
            height: img.height,
            imgEl: img,
          };
          assetsMapRef.current.set(newAsset.id, newAsset);
          setAssets((prev) => [...prev, newAsset]);
          pushHistory(clipsRef.current);
          const imgClip: TimelineClip = {
            id: nextId('clip'),
            track: 'image',
            name: newAsset.name,
            mediaId: newAsset.id,
            timelineStart: playheadRef.current,
            duration: 2,
            sourceStart: 0,
            sourceDuration: 600,
            x: 0,
            y: 0,
            scale: 100,
            opacity: 100,
            rotation: 0,
            crop: 0,
            flipH: false,
            flipV: false,
            blend: 'source-over',
            mask: 'none',
            transition: 'none',
            speed: 1,
            reverse: false,
            muted: false,
            volume: 100,
            fadeIn: 0,
            fadeOut: 0,
          };
          commitClips([...clipsRef.current, imgClip]);
          setSelectedClipId(imgClip.id);
          showToast('สร้างภาพนิ่ง 2 วินาทีแล้ว');
        };
        img.src = url;
      }, 'image/png');
    },
    [commitClips, pushHistory, showToast]
  );

  // --- Detach Audio from Video ---
  const handleDetachAudio = useCallback(
    async (clipId: string) => {
      const clip = clipsRef.current.find((c) => c.id === clipId);
      if (!clip || !clip.mediaId) return;
      const asset = assetsMapRef.current.get(clip.mediaId);
      if (!asset) return;
      try {
        showToast('กำลังแยกเสียงออกจากวิดีโอ...');
        const ctx = ensureAudioCtx();
        const ab = await asset.file.arrayBuffer();
        const buf = await ctx.decodeAudioData(ab);
        const newAsset: MediaAsset = {
          id: nextId('aud'),
          type: 'audio',
          name: `เสียง: ${asset.name}`,
          url: asset.url,
          file: asset.file,
          duration: buf.duration,
          width: 0,
          height: 0,
          audioBuffer: buf,
          peaks: computeAudioPeaks(buf),
        };
        assetsMapRef.current.set(newAsset.id, newAsset);
        setAssets((prev) => [...prev, newAsset]);
        pushHistory(clipsRef.current);

        const audioClip: TimelineClip = {
          id: nextId('clip'),
          track: 'audio',
          name: newAsset.name,
          mediaId: newAsset.id,
          timelineStart: clip.timelineStart,
          duration: clip.duration,
          sourceStart: clip.sourceStart,
          sourceDuration: buf.duration,
          x: 0,
          y: 0,
          scale: 100,
          opacity: 100,
          rotation: 0,
          crop: 0,
          flipH: false,
          flipV: false,
          blend: 'source-over',
          mask: 'none',
          transition: 'none',
          speed: 1,
          reverse: false,
          muted: false,
          volume: clip.volume ?? 100,
          fadeIn: 0,
          fadeOut: 0,
        };
        commitClips([
          ...clipsRef.current.map((c) => (c.id === clipId ? { ...c, muted: true } : c)),
          audioClip,
        ]);
        if (isPlayingRef.current) startAudioAt();
        setSelectedClipId(audioClip.id);
        showToast('แยกเสียงลงแทร็กเสียงแล้ว');
      } catch {
        showToast('วิดีโอนี้ไม่มีแทร็กเสียง หรือเบราว์เซอร์ไม่รองรับการถอดรหัส');
      }
    },
    [commitClips, ensureAudioCtx, pushHistory, showToast, startAudioAt]
  );

  // --- Mic Voiceover Recording ---
  const handleToggleMicRecord = useCallback(async () => {
    if (isRecordingMic && micRecorderRef.current) {
      micRecorderRef.current.stop();
      setIsRecordingMic(false);
      setMicStatus('กำลังประมวลผลเสียงพากย์...');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      micChunksRef.current = [];
      const rec = new MediaRecorder(stream);
      micRecorderRef.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) micChunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        micStreamRef.current?.getTracks().forEach((t) => t.stop());
        const blob = new Blob(micChunksRef.current, { type: 'audio/webm' });
        const file = new File([blob], `voiceover_${Date.now()}.webm`, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        const ctx = ensureAudioCtx();
        try {
          const ab = await blob.arrayBuffer();
          const buf = await ctx.decodeAudioData(ab);
          const asset: MediaAsset = {
            id: nextId('aud'),
            type: 'audio',
            name: `เสียงพากย์ ${new Date().toLocaleTimeString('th-TH')}`,
            url,
            file,
            duration: buf.duration,
            width: 0,
            height: 0,
            audioBuffer: buf,
            peaks: computeAudioPeaks(buf),
          };
          assetsMapRef.current.set(asset.id, asset);
          setAssets((prev) => [...prev, asset]);
          addAssetToTimeline(asset);
          setMicStatus('อัดเสียงพากย์และเพิ่มลงไทม์ไลน์แล้ว');
          showToast('เพิ่มเสียงพากย์ลงไทม์ไลน์แล้ว');
        } catch {
          setMicStatus('ไม่สามารถถอดรหัสเสียงที่อัดได้');
        }
      };
      rec.start();
      setIsRecordingMic(true);
      setMicStatus('กำลังอัดเสียง... กดปุ่มอีกครั้งเพื่อหยุด');
    } catch {
      setMicStatus('ไม่สามารถเข้าถึงไมโครโฟนได้ (กรุณาอนุญาตสิทธิ์ Mic)');
      showToast('ไม่สามารถเปิดไมโครโฟนได้');
    }
  }, [addAssetToTimeline, ensureAudioCtx, isRecordingMic, showToast]);

  // --- SRT Import / Export ---
  const handleImportSrt = useCallback(
    async (file: File) => {
      const text = await file.text();
      const blocks = text.replace(/\r/g, '').trim().split(/\n\n+/);
      const parseTs = (ts: string) => {
        const m = ts.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
        if (!m) return 0;
        return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
      };
      const newSubs: TimelineClip[] = [];
      for (const b of blocks) {
        const lines = b.split('\n');
        const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
        if (timeLineIdx < 0) continue;
        const [sStr, eStr] = lines[timeLineIdx].split('-->').map((s) => s.trim());
        const start = parseTs(sStr);
        const end = parseTs(eStr);
        const subText = lines.slice(timeLineIdx + 1).join(' ').trim();
        if (!subText || end <= start) continue;
        newSubs.push({
          id: nextId('fx'),
          track: 'fx',
          name: subText.slice(0, 18),
          mediaId: null,
          timelineStart: start,
          duration: Math.max(0.4, end - start),
          sourceStart: 0,
          sourceDuration: 600,
          x: 0,
          y: 0,
          scale: 100,
          opacity: 100,
          rotation: 0,
          crop: 0,
          flipH: false,
          flipV: false,
          blend: 'source-over',
          mask: 'none',
          transition: 'none',
          speed: 1,
          reverse: false,
          muted: false,
          volume: 100,
          fadeIn: 0,
          fadeOut: 0,
          fxData: {
            text: subText,
            style: 'subtitle',
            anim: 'none',
            color: '#FFFFFF',
            bgColor: '#0EA5E9',
            fontSize: 30,
            x: 50,
            y: 84,
          },
        });
      }
      if (!newSubs.length) {
        showToast('ไม่พบข้อมูลซับไตเติลในไฟล์ .SRT');
        return;
      }
      pushHistory(clipsRef.current);
      commitClips([...clipsRef.current, ...newSubs]);
      showToast(`นำเข้าซับไตเติล ${newSubs.length} บรรทัดแล้ว`);
    },
    [commitClips, pushHistory, showToast]
  );

  const handleExportSrt = useCallback(() => {
    const subs = clipsRef.current
      .filter((c) => c.track === 'fx' && c.fxData?.text)
      .sort((a, b) => a.timelineStart - b.timelineStart);
    if (!subs.length) {
      showToast('ยังไม่มีข้อความหรือซับไตเติลบนไทม์ไลน์');
      return;
    }
    const fmt = (sec: number) => {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      const ms = Math.round((sec % 1) * 1000);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };
    const srt = subs
      .map((c, idx) => `${idx + 1}\n${fmt(c.timelineStart)} --> ${fmt(c.timelineStart + c.duration)}\n${c.fxData!.text}`)
      .join('\n\n');
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `subtitles_${Date.now()}.srt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('ส่งออกไฟล์ .SRT แล้ว');
  }, [showToast]);

  // --- JSON Project Save / Load ---
  const handleExportProject = useCallback(() => {
    const payload = {
      version: 2,
      aspectRatio,
      colors: colorsRef.current,
      exportSettings,
      assetsManifest: assets.map((a) => ({ id: a.id, name: a.name, type: a.type })),
      clips: clipsRef.current,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `MinimalCut_Project_${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('บันทึกโปรเจกต์ .JSON แล้ว');
  }, [aspectRatio, assets, exportSettings, showToast]);

  const handleImportProject = useCallback(
    async (file: File) => {
      try {
        const data = JSON.parse(await file.text());
        togglePlay(false);
        if (data.aspectRatio) setAspectRatio(data.aspectRatio);
        if (data.colors) handleUpdateColors({ ...DEFAULT_COLORS, ...data.colors });
        if (data.exportSettings) setExportSettings(data.exportSettings);
        if (Array.isArray(data.clips)) {
          const manifest: Array<{ id: string; name: string }> = data.assetsManifest || [];
          const idMap = new Map<string, string>();
          for (const m of manifest) {
            const match = assets.find((a) => a.name === m.name);
            if (match) idMap.set(m.id, match.id);
          }
          pushHistory(clipsRef.current);
          const restored = (data.clips as TimelineClip[]).map((c) => ({
            ...c,
            mediaId: c.mediaId ? idMap.get(c.mediaId) ?? c.mediaId : null,
          }));
          commitClips(restored);
          seekTo(0);
          showToast('โหลดโปรเจกต์ .JSON แล้ว (นำเข้าไฟล์สื่อชื่อเดิมหากคลิปยังไม่ขึ้น)');
        }
      } catch {
        showToast('ไฟล์โปรเจกต์ .JSON ไม่ถูกต้อง');
      }
    },
    [assets, commitClips, handleUpdateColors, pushHistory, seekTo, showToast, togglePlay]
  );

  const handleExportFcpxml = useCallback(() => {
    const [w, h] = canvasDims;
    const xml = exportToFcpxml({
      fps: exportSettings.fps,
      width: w,
      height: h,
      totalDuration: totalDurationRef.current,
      clips: clipsRef.current,
      assets,
    });
    const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `MinimalCut_FilmCraft_${Date.now()}.fcpxml`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('ส่งออกไฟล์ .FCPXML (FilmCraft / Final Cut Pro) แล้ว');
  }, [assets, canvasDims, exportSettings.fps, showToast]);

  // Install FilmCraft Web Control & Agent API (`window.filmcraft`)
  useEffect(() => {
    installFilmCraftWebApi({
      getState: () => ({
        clips: clipsRef.current,
        assets: Array.from(assetsMapRef.current.values()),
        colors: colorsRef.current,
        aspectRatio,
        exportSettings,
        playhead: playheadRef.current,
        totalDuration: totalDurationRef.current,
        isPlaying: isPlayingRef.current,
        capabilities,
        canvas: canvasRef.current,
      }),
      togglePlay,
      seekTo,
      split: handleSplit,
      deleteSelected: handleDelete,
      rippleDeleteSelected: handleRippleDelete,
      undo: handleUndo,
      redo: handleRedo,
      clearProject: handleClearProject,
      addTextClip: handleAddTextClip,
      updateColors: handleUpdateColors,
      importFiles: handleImportFiles,
      importProject: handleImportProject,
      exportMp4: async () => {
        togglePlay(false);
        try {
          const res = await exportProjectToMp4({
            clips: clipsRef.current,
            assets: assetsMapRef.current,
            colors: colorsRef.current,
            aspectRatio,
            settings: exportSettings,
            totalDuration: Math.max(0.5, totalDurationRef.current),
            signal: new AbortController().signal,
            onProgress: () => {},
            decodeFrame: (asset, srcT) => getRenderClient().decodeFrameForExport(asset, srcT),
          });
          if (res.cleanup) {
            const bytes = await res.blob.arrayBuffer();
            await res.cleanup().catch(() => {});
            return { blob: new Blob([bytes], { type: 'video/mp4' }), filename: res.filename };
          }
          return { blob: res.blob, filename: res.filename };
        } finally {
          syncVideoElements(playheadRef.current, true);
          drawNow(playheadRef.current);
        }
      },
    });
  }, [
    aspectRatio,
    capabilities,
    drawNow,
    exportSettings,
    getRenderClient,
    handleAddTextClip,
    handleClearProject,
    handleDelete,
    handleImportFiles,
    handleImportProject,
    handleRedo,
    handleRippleDelete,
    handleSplit,
    handleUndo,
    handleUpdateColors,
    seekTo,
    syncVideoElements,
    togglePlay,
  ]);

  // --- AI & Auto Tools ---
  const handleAiAutoSub = useCallback(async () => {
    if (!whisperApiKey.trim()) {
      showToast('กรุณากรอก API Key ก่อนครับ');
      return;
    }
    const targetClip =
      clipsRef.current.find((c) => c.id === selectedClipId && (c.track === 'audio' || c.track === 'video')) ||
      clipsRef.current.find((c) => c.track === 'audio' || c.track === 'video');
    if (!targetClip?.mediaId) {
      showToast('กรุณาเพิ่มคลิปวิดีโอหรือเสียงลงไทม์ไลน์ก่อน');
      return;
    }
    const asset = assetsMapRef.current.get(targetClip.mediaId);
    if (!asset) return;

    setIsTranscribing(true);
    appendAiLog(`กำลังส่งเสียง "${asset.name}" ไปยัง ${whisperProvider.toUpperCase()}...`);
    try {
      let segs: Array<{ start: number; end: number; text: string }> = [];

      if (whisperProvider === 'gemini') {
        // Extract compact 16kHz mono WAV so even large video files fit cleanly in Gemini inline_data
        let payloadBytes: Uint8Array;
        let mimeType = 'audio/wav';
        try {
          const ctx = ensureAudioCtx();
          const buf = asset.audioBuffer || (await ctx.decodeAudioData(await asset.file.arrayBuffer()));
          const targetRate = 16000;
          const totalSamples = Math.floor(buf.duration * targetRate);
          const off = new OfflineAudioContext(1, totalSamples, targetRate);
          const src = off.createBufferSource();
          src.buffer = buf;
          src.connect(off.destination);
          src.start(0);
          const rendered = await off.startRendering();
          const ch = rendered.getChannelData(0);
          const wav = new ArrayBuffer(44 + ch.length * 2);
          const view = new DataView(wav);
          const writeStr = (o: number, s: string) => {
            for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
          };
          writeStr(0, 'RIFF');
          view.setUint32(4, 36 + ch.length * 2, true);
          writeStr(8, 'WAVE');
          writeStr(12, 'fmt ');
          view.setUint32(16, 16, true);
          view.setUint16(20, 1, true);
          view.setUint16(22, 1, true);
          view.setUint32(24, targetRate, true);
          view.setUint32(28, targetRate * 2, true);
          view.setUint16(32, 2, true);
          view.setUint16(34, 16, true);
          writeStr(36, 'data');
          view.setUint32(40, ch.length * 2, true);
          for (let i = 0; i < ch.length; i++) {
            const s = Math.max(-1, Math.min(1, ch[i]));
            view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
          }
          payloadBytes = new Uint8Array(wav);
        } catch {
          payloadBytes = new Uint8Array(await asset.file.arrayBuffer());
          mimeType = asset.file.type || 'audio/mp3';
        }

        // Chunked base64 encoding to avoid call stack overflow
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < payloadBytes.length; i += chunkSize) {
          binary += String.fromCharCode(...payloadBytes.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binary);

        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(whisperApiKey.trim())}`;
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: 'Transcribe the spoken audio accurately in Thai (or the spoken language). Return ONLY a JSON array of objects, each with "start" (number in seconds), "end" (number in seconds), and "text" (string).',
                  },
                  { inline_data: { mime_type: mimeType, data: base64 } },
                ],
              },
            ],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${errText.slice(0, 120)}`);
        }
        const json = await res.json();
        const rawText: string = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
        const parsed = JSON.parse(rawText);
        if (Array.isArray(parsed)) {
          segs = parsed
            .filter((x) => x && typeof x.text === 'string')
            .map((x) => ({
              start: Number(x.start) || 0,
              end: Math.max((Number(x.start) || 0) + 0.5, Number(x.end) || (Number(x.start) || 0) + 2),
              text: x.text,
            }));
        }
      } else {
        const form = new FormData();
        form.append('file', asset.file);
        form.append('model', whisperProvider === 'groq' ? 'whisper-large-v3' : 'whisper-1');
        form.append('response_format', 'verbose_json');
        form.append('language', 'th');

        const endpoint =
          whisperProvider === 'groq'
            ? 'https://api.groq.com/openai/v1/audio/transcriptions'
            : 'https://api.openai.com/v1/audio/transcriptions';

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${whisperApiKey.trim()}` },
          body: form,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        segs = json.segments || [];
        if (!segs.length && json.text) {
          segs.push({ start: 0, end: targetClip.duration, text: json.text });
        }
      }
      pushHistory(clipsRef.current);
      const subClips: TimelineClip[] = segs
        .filter((s) => s.text.trim())
        .map((s) => ({
          id: nextId('fx'),
          track: 'fx',
          name: s.text.trim().slice(0, 18),
          mediaId: null,
          timelineStart: targetClip.timelineStart + s.start,
          duration: Math.max(0.4, s.end - s.start),
          sourceStart: 0,
          sourceDuration: 600,
          x: 0,
          y: 0,
          scale: 100,
          opacity: 100,
          rotation: 0,
          crop: 0,
          flipH: false,
          flipV: false,
          blend: 'source-over',
          mask: 'none',
          transition: 'none',
          speed: 1,
          reverse: false,
          muted: false,
          volume: 100,
          fadeIn: 0,
          fadeOut: 0,
          fxData: {
            text: s.text.trim(),
            style: 'subtitle',
            anim: 'none',
            color: '#FFFFFF',
            bgColor: '#0EA5E9',
            fontSize: 30,
            x: 50,
            y: 84,
          },
        }));
      commitClips([...clipsRef.current, ...subClips]);
      appendAiLog(`สร้างซับไตเติลสำเร็จ ${subClips.length} ช่วง!`);
      showToast(`สร้างซับไตเติล AI ${subClips.length} ช่วงแล้ว`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'เชื่อมต่อ API ไม่สำเร็จ';
      appendAiLog(`ผิดพลาด: ${msg}`);
      showToast(`ถอดเสียงไม่สำเร็จ: ${msg}`);
    } finally {
      setIsTranscribing(false);
    }
  }, [appendAiLog, commitClips, ensureAudioCtx, pushHistory, selectedClipId, showToast, whisperApiKey, whisperProvider]);

  const handleAiSilenceCut = useCallback(() => {
    const audioClip =
      clipsRef.current.find((c) => c.id === selectedClipId && c.track === 'audio') ||
      clipsRef.current.find((c) => c.track === 'audio');
    if (!audioClip?.mediaId) {
      showToast('กรุณาเพิ่มคลิปเสียงลงแทร็กเสียงก่อน');
      return;
    }
    const asset = assetsMapRef.current.get(audioClip.mediaId);
    if (!asset?.audioBuffer) {
      showToast('กำลังถอดรหัสเสียง กรุณารอสักครู่');
      return;
    }

    appendAiLog('กำลังวิเคราะห์ช่วงเงียบด้วย Web Worker...');
    const chData = asset.audioBuffer.getChannelData(0).slice();
    const sr = asset.audioBuffer.sampleRate;

    const workerCode = `
      self.onmessage = function(e) {
        const { samples, sampleRate } = e.data;
        const win = Math.floor(sampleRate * 0.1);
        const thresh = 0.015;
        const keep = [];
        let activeStart = null;
        for (let i = 0; i < samples.length; i += win) {
          let sum = 0;
          const end = Math.min(samples.length, i + win);
          for (let j = i; j < end; j++) sum += samples[j] * samples[j];
          const rms = Math.sqrt(sum / (end - i));
          const t = i / sampleRate;
          if (rms >= thresh) {
            if (activeStart === null) activeStart = t;
          } else if (activeStart !== null && t - activeStart >= 0.25) {
            keep.push({ start: activeStart, end: t });
            activeStart = null;
          }
        }
        if (activeStart !== null) keep.push({ start: activeStart, end: samples.length / sampleRate });
        self.postMessage(keep);
      };
    `;
    const workerUrl = URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' }));
    const worker = new Worker(workerUrl);
    worker.onmessage = (e) => {
      URL.revokeObjectURL(workerUrl);
      worker.terminate();
      const segs: Array<{ start: number; end: number }> = e.data;
      if (!segs.length) {
        appendAiLog('ไม่พบช่วงเสียงพูดที่ชัดเจน');
        showToast('ไม่พบช่วงเสียงพูด');
        return;
      }
      pushHistory(clipsRef.current);
      let cursor = audioClip.timelineStart;
      const newClips: TimelineClip[] = segs.map((s) => {
        const dur = Math.max(0.2, s.end - s.start);
        const c: TimelineClip = {
          ...audioClip,
          id: nextId('clip'),
          timelineStart: cursor,
          sourceStart: s.start,
          duration: dur,
        };
        cursor += dur;
        return c;
      });
      commitClips([...clipsRef.current.filter((c) => c.id !== audioClip.id), ...newClips]);
      if (isPlayingRef.current) startAudioAt();
      appendAiLog(`ตัดช่วงเงียบออกแล้ว เหลือ ${newClips.length} ท่อน`);
      showToast(`ตัดช่วงเงียบสำเร็จ (${newClips.length} ท่อน)`);
    };
    worker.postMessage({ samples: chData, sampleRate: sr }, [chData.buffer]);
  }, [appendAiLog, commitClips, pushHistory, selectedClipId, showToast, startAudioAt]);

  const handleAiSplitHalf = useCallback(() => {
    const target =
      clipsRef.current.find((c) => c.id === selectedClipId && c.track === 'video') ||
      clipsRef.current.find((c) => c.track === 'video');
    if (!target || target.duration < 0.4) {
      showToast('ไม่พบคลิปวิดีโอสำหรับแบ่งครึ่ง');
      return;
    }
    pushHistory(clipsRef.current);
    const half = target.duration / 2;
    const [left, right] = splitClipAtOffset(target, half, nextId('clip'));
    commitClips([...clipsRef.current.filter((c) => c.id !== target.id), left, right]);
    if (isPlayingRef.current) startAudioAt();
    appendAiLog(`แบ่งครึ่งคลิป "${target.name}" แล้ว`);
    showToast('แบ่งครึ่งคลิปวิดีโอแล้ว');
  }, [appendAiLog, commitClips, pushHistory, selectedClipId, showToast, startAudioAt]);

  const handleAiAutoShorts = useCallback(() => {
    setAspectRatio('9:16');
    pushHistory(clipsRef.current);
    commitClips(
      clipsRef.current.map((c) => (c.track === 'video' ? { ...c, scale: Math.max(c.scale, 178) } : c))
    );
    appendAiLog('ปรับสัดส่วนเป็นแนวตั้ง 9:16 (Shorts / TikTok) แล้ว');
    showToast('ปรับเป็นแนวตั้ง 9:16 (Shorts) แล้ว');
  }, [appendAiLog, commitClips, pushHistory, showToast]);

  return (
    <div className="studio-shell" data-mobile-tab={mobileTab}>
      <TopBar
        fps={exportSettings.fps}
        resolution={exportSettings.resolution}
        canUndo={history.length > 0}
        canRedo={redoStack.length > 0}
        hasClips={clips.length > 0}
        webCodecsSupported={webCodecsSupported}
        capabilities={capabilities}
        autosaveLabel={clips.length > 0 ? autosaveLabel : undefined}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onClearProject={handleClearProject}
        onOpenExport={() => {
          setExportDone(null);
          setExportError(null);
          setExportOpen(true);
        }}
      />

      {recoveryCandidate && (
        <RecoveryDialog
          meta={recoveryCandidate.meta}
          isRestoring={isRestoringRecovery}
          onRestore={handleRestoreRecovery}
          onDiscard={handleDiscardRecovery}
        />
      )}

      <main className="workspace-upper">
        <MediaSidebar
          assets={assets}
          colors={colors}
          isRecordingMic={isRecordingMic}
          micStatus={micStatus}
          audioDb={audioDb}
          analyserRef={analyserRef}
          aiLogs={aiLogs}
          isTranscribing={isTranscribing}
          whisperProvider={whisperProvider}
          whisperApiKey={whisperApiKey}
          onImportFiles={handleImportFiles}
          onAddAssetToTimeline={(a) => addAssetToTimeline(a)}
          onAddTextClip={handleAddTextClip}
          onUpdateColors={handleUpdateColors}
          onImportSrt={handleImportSrt}
          onExportSrt={handleExportSrt}
          onExportProject={handleExportProject}
          onImportProject={handleImportProject}
          onExportFcpxml={handleExportFcpxml}
          onToggleMicRecord={handleToggleMicRecord}
          onChangeWhisperProvider={(p) => {
            setWhisperProvider(p);
            localStorage.setItem('minimalcut_whisper_provider', p);
          }}
          onChangeWhisperKey={(k) => {
            setWhisperApiKey(k);
            localStorage.setItem('minimalcut_whisper_key', k);
          }}
          onAiAutoSub={handleAiAutoSub}
          onAiSilenceCut={handleAiSilenceCut}
          onAiSplitHalf={handleAiSplitHalf}
          onAiAutoShorts={handleAiAutoShorts}
        />

        <PreviewPlayer
          canvasRef={canvasRef}
          canvasDims={canvasDims}
          aspectRatio={aspectRatio}
          proxyMode={proxyMode}
          isPlaying={isPlaying}
          loop={loop}
          playhead={playhead}
          totalDuration={totalDuration}
          fps={exportSettings.fps}
          liveFps={liveFps}
          clips={clips}
          selectedClipId={selectedClipId}
          onChangeAspectRatio={setAspectRatio}
          onToggleProxy={() => setProxyMode((p) => !p)}
          onTogglePlay={() => togglePlay()}
          onSeek={seekTo}
          onToggleLoop={() => setLoop((l) => !l)}
          onSelectClip={setSelectedClipId}
          onUpdateClipLive={handleUpdateClip}
          onSetDraggingPreview={(dragging) => {
            isDraggingPreviewRef.current = dragging;
            drawNow(playheadRef.current);
          }}
        />

        <InspectorPanel
          selectedClip={selectedClip}
          exportSettings={exportSettings}
          onUpdateExportSettings={(patch) => setExportSettings((prev) => ({ ...prev, ...patch }))}
          onUpdateClip={handleUpdateClip}
          onAddVideoKeyframe={handleAddVideoKeyframe}
          onClearVideoKeyframes={handleClearVideoKeyframes}
          onFreezeFrame={handleFreezeFrame}
          onDetachAudio={handleDetachAudio}
          onAddAudioKeyframe={handleAddAudioKeyframe}
          onNormalizeAudio={handleNormalizeAudio}
        />
      </main>

      <Timeline
        clips={clips}
        assets={assetsMap}
        selectedClipId={selectedClipId}
        playhead={playhead}
        totalDuration={totalDuration}
        zoom={zoom}
        snap={snap}
        onChangeZoom={setZoom}
        onToggleSnap={() => setSnap((s) => !s)}
        onSelectClip={setSelectedClipId}
        onSeek={seekTo}
        onSplit={handleSplit}
        onDelete={handleDelete}
        onRippleDelete={handleRippleDelete}
        onUpdateClip={handleUpdateClip}
      />

      <ExportModal
        isOpen={exportOpen}
        isExporting={isExporting}
        settings={exportSettings}
        progress={exportProgress}
        error={exportError}
        doneInfo={exportDone}
        onUpdateSettings={(patch) => setExportSettings((prev) => ({ ...prev, ...patch }))}
        onStartExport={handleStartExport}
        onCancelExport={() => exportAbortRef.current?.abort()}
        onClose={() => setExportOpen(false)}
      />

      <nav className="mobile-tabbar" aria-label="สลับมุมมองมือถือ">
        <button
          type="button"
          className={`mobile-tab-btn ${mobileTab === 'timeline' ? 'active' : ''}`}
          onClick={() => setMobileTab('timeline')}
        >
          <Film size={16} />
          <span>ไทม์ไลน์</span>
        </button>
        <button
          type="button"
          className={`mobile-tab-btn ${mobileTab === 'media' ? 'active' : ''}`}
          onClick={() => setMobileTab('media')}
        >
          <FolderPlus size={16} />
          <span>สื่อ &amp; เครื่องมือ</span>
        </button>
        <button
          type="button"
          className={`mobile-tab-btn ${mobileTab === 'inspector' ? 'active' : ''}`}
          onClick={() => setMobileTab('inspector')}
        >
          <SlidersHorizontal size={16} />
          <span>
            ปรับแต่ง
            {selectedClip && <span className="mobile-tab-dot" />}
          </span>
        </button>
      </nav>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

export default App;
