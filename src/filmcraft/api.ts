/**
 * FilmCraft Web Control Channel & Agent API (`window.filmcraft`) + FCPXML Interchange
 * Ported from `storytold/filmcraft/apps/filmcraft-web/src/api.rs`, `host.rs`, and `crates/interchange`
 * (MIT OR Apache-2.0).
 *
 * Exposes `window.filmcraft` (`execute`, `request`, `commands`, `inspect`, `uiInspect`,
 * `screenshot`, `importFiles`, `importUrl`, `openProject`, `files`, `readFile`, `info`)
 * and `window.filmcraftLoad` for automation, MCP agents, and headless browser smoke tests.
 */

import type { AspectRatio, ColorSettings, ExportSettings, MediaAsset, TextStyleType, TimelineClip } from '../types/editor';
import type { Capabilities } from '../utils/capabilities';
import { opfsRead } from '../storage/opfs';
import { webcodecsStats } from './webcodecs';

export interface FilmCraftControllerHooks {
  getState: () => {
    clips: TimelineClip[];
    assets: MediaAsset[];
    colors: ColorSettings;
    aspectRatio: AspectRatio;
    exportSettings: ExportSettings;
    playhead: number;
    totalDuration: number;
    isPlaying: boolean;
    capabilities: Capabilities;
    canvas: HTMLCanvasElement | null;
  };
  togglePlay: (force?: boolean) => void;
  seekTo: (time: number) => void;
  split: () => void;
  deleteSelected: () => void;
  rippleDeleteSelected: () => void;
  undo: () => void;
  redo: () => void;
  clearProject: () => void;
  addTextClip: (text: string, style: TextStyleType, y?: number, dur?: number) => void;
  updateColors: (patch: Partial<ColorSettings>) => void;
  importFiles: (files: FileList | File[]) => Promise<void>;
  importProject: (file: File) => Promise<void>;
  exportMp4: () => Promise<{ blob: Blob; filename: string }>;
}

const virtualFiles = new Map<string, { bytes: Uint8Array; kind: 'media' | 'export' | 'project' }>();
const bootTimeMs = typeof performance !== 'undefined' ? performance.now() : 0;

export function registerVirtualFile(
  path: string,
  bytes: Uint8Array,
  kind: 'media' | 'export' | 'project'
): void {
  virtualFiles.set(path, { bytes, kind });
}

/** Generate a Final Cut Pro X `.fcpxml` (v1.10) interchange document from the current timeline. */
export function exportToFcpxml(params: {
  name?: string;
  fps: number;
  width: number;
  height: number;
  totalDuration: number;
  clips: TimelineClip[];
  assets: MediaAsset[];
}): string {
  const { name = 'MinimalCut Sequence', fps, width, height, totalDuration, clips, assets } = params;
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const secToRational = (sec: number) => `${Math.max(0, Math.round(sec * fps * 100))}/${fps * 100}s`;

  const resourcesXml = assets
    .map(
      (a, idx) =>
        `    <asset id="r${idx + 2}" name="${esc(a.name)}" uid="${esc(a.id)}" start="0s" duration="${secToRational(a.duration)}" hasVideo="${a.type !== 'audio' ? 1 : 0}" hasAudio="${a.type !== 'image' ? 1 : 0}" format="r1" />`
    )
    .join('\n');

  const assetIndexMap = new Map(assets.map((a, idx) => [a.id, `r${idx + 2}`]));
  const spineClips = clips
    .filter((c) => c.track === 'video' || c.track === 'image')
    .sort((a, b) => a.timelineStart - b.timelineStart)
    .map((c) => {
      const ref = (c.mediaId && assetIndexMap.get(c.mediaId)) || 'r1';
      return `            <asset-clip name="${esc(c.name)}" ref="${ref}" offset="${secToRational(c.timelineStart)}" start="${secToRational(c.sourceStart)}" duration="${secToRational(c.duration)}" />`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormat${height}p${fps}" frameDuration="100/${fps * 100}s" width="${width}" height="${height}" />
${resourcesXml}
  </resources>
  <library>
    <event name="MinimalCut Event">
      <project name="${esc(name)}">
        <sequence format="r1" duration="${secToRational(totalDuration)}" tcStart="0s" tcFormat="NDF">
          <spine>
${spineClips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;
}

const ENGINE_COMMANDS = [
  { id: 'sequence.razor', description: 'Split clip at playhead (or params.seconds)' },
  { id: 'sequence.delete', description: 'Delete selected clip' },
  { id: 'sequence.rippleDelete', description: 'Ripple delete selected clip' },
  { id: 'edit.undo', description: 'Undo last timeline edit' },
  { id: 'edit.redo', description: 'Redo timeline edit' },
  { id: 'project.clear', description: 'Clear project and recovery store' },
  { id: 'file.newSequence', description: 'Ensure sequence is ready' },
  { id: 'file.exportMedia', description: 'Render MP4 and store in virtual file table' },
  { id: 'file.exportFcpxml', description: 'Export timeline as Final Cut Pro XML (.fcpxml)' },
  { id: 'clip.addText', description: 'Add text or subtitle overlay clip' },
  { id: 'color.setGrade', description: 'Update Lumetri/LUT color settings' },
];

export function installFilmCraftWebApi(hooks: FilmCraftControllerHooks): void {
  if (typeof window === 'undefined') return;
  const win = window as unknown as Record<string, unknown>;

  const readyMs = Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - bootTimeMs);
  win.filmcraftLoad = { wasmMs: 0, readyMs };

  const inspect = () => {
    const st = hooks.getState();
    return {
      playhead: st.playhead,
      totalDuration: st.totalDuration,
      isPlaying: st.isPlaying,
      aspectRatio: st.aspectRatio,
      exportSettings: st.exportSettings,
      colors: st.colors,
      clipCount: st.clips.length,
      assetCount: st.assets.length,
      clips: st.clips.map((c) => ({
        id: c.id,
        track: c.track,
        name: c.name,
        timelineStart: c.timelineStart,
        duration: c.duration,
      })),
    };
  };

  const api = {
    commands: async () => ENGINE_COMMANDS,
    inspect: async () => inspect(),
    uiInspect: async () => inspect(),
    info: () => {
      const st = hooks.getState();
      return {
        engine: 'filmcraft-minimalcut',
        version: '0.20.1-compat',
        backend: st.capabilities.webgl2 ? 'webgl2' : 'canvas2d',
        compositor: st.capabilities.compositor,
        crossOriginIsolated: st.capabilities.crossOriginIsolated,
        opfs: st.capabilities.opfs,
        audioWorklet: st.capabilities.audioWorklet,
        webcodecs: webcodecsStats(),
        startupMs: readyMs,
      };
    },
    screenshot: async () => {
      const st = hooks.getState();
      const canvas = st.canvas;
      if (!canvas) throw new Error('Canvas not mounted');
      const dataUrl = canvas.toDataURL('image/png');
      const pngBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      return {
        pngBase64,
        data: pngBase64,
        width: canvas.width,
        height: canvas.height,
      };
    },
    importFiles: async (input: File | FileList | File[]) => {
      const list: File[] =
        input instanceof File
          ? [input]
          : Array.isArray(input)
            ? input
            : Array.from(input);
      await hooks.importFiles(list);
      for (const f of list) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        registerVirtualFile(`/files/${f.name}`, bytes, 'media');
      }
      const st = hooks.getState();
      return {
        items: st.assets.map((a) => ({ id: a.id, name: a.name, type: a.type, duration: a.duration })),
        errors: [],
        paths: list.map((f) => `/files/${f.name}`),
      };
    },
    importUrl: async (url: string, name?: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const blob = await res.blob();
      const filename =
        name || url.split(/[?#]/)[0].split('/').pop() || 'media.mp4';
      const file = new File([blob], filename, { type: blob.type || 'video/mp4' });
      return api.importFiles([file]);
    },
    openProject: async (fileOrUrl: File | string) => {
      let file: File;
      if (typeof fileOrUrl === 'string') {
        const res = await fetch(fileOrUrl);
        if (!res.ok) throw new Error(`${fileOrUrl}: HTTP ${res.status}`);
        const blob = await res.blob();
        file = new File([blob], 'project.fcproj', { type: 'application/json' });
      } else {
        file = fileOrUrl;
      }
      await hooks.importProject(file);
      return { ok: true };
    },
    files: () => {
      const out: Array<{ path: string; size: number; kind: string }> = [];
      virtualFiles.forEach((v, path) => {
        out.push({ path, size: v.bytes.byteLength, kind: v.kind });
      });
      return out;
    },
    readFile: async (path: string): Promise<Uint8Array> => {
      const hit = virtualFiles.get(path);
      if (hit) return hit.bytes;
      const fromOpfs = await opfsRead(path.replace(/^\//, ''));
      if (fromOpfs) return fromOpfs;
      throw new Error(`File not found: ${path}`);
    },
    request: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'ui.inspect') return inspect();
      if (method === 'ui.playback') {
        const action = params.action as string | undefined;
        if (typeof params.time === 'number') hooks.seekTo(params.time);
        if (action === 'play') hooks.togglePlay(true);
        else if (action === 'pause') hooks.togglePlay(false);
        else if (action === 'toggle') hooks.togglePlay();
        return inspect();
      }
      throw new Error(`Unknown control method: ${method}`);
    },
    execute: async (command: string, params: Record<string, unknown> = {}) => {
      switch (command) {
        case 'sequence.razor': {
          if (typeof params.seconds === 'number') hooks.seekTo(params.seconds);
          hooks.split();
          return inspect();
        }
        case 'sequence.delete':
          hooks.deleteSelected();
          return inspect();
        case 'sequence.rippleDelete':
          hooks.rippleDeleteSelected();
          return inspect();
        case 'edit.undo':
          hooks.undo();
          return inspect();
        case 'edit.redo':
          hooks.redo();
          return inspect();
        case 'project.clear':
          hooks.clearProject();
          return inspect();
        case 'file.newSequence':
          return inspect();
        case 'clip.addText': {
          const text = typeof params.text === 'string' ? params.text : 'Title';
          const style = (params.style as TextStyleType) || 'subtitle';
          const y = typeof params.y === 'number' ? params.y : undefined;
          const dur = typeof params.duration === 'number' ? params.duration : 4;
          hooks.addTextClip(text, style, y, dur);
          return inspect();
        }
        case 'color.setGrade':
          hooks.updateColors(params as Partial<ColorSettings>);
          return inspect();
        case 'file.exportFcpxml': {
          const st = hooks.getState();
          const xml = exportToFcpxml({
            fps: st.exportSettings.fps,
            width: st.canvas?.width || 1920,
            height: st.canvas?.height || 1080,
            totalDuration: st.totalDuration,
            clips: st.clips,
            assets: st.assets,
          });
          const path = (params.path as string) || '/exports/project.fcpxml';
          registerVirtualFile(path, new TextEncoder().encode(xml), 'project');
          return { path, xml };
        }
        case 'file.exportMedia': {
          const res = await hooks.exportMp4();
          const path = (params.path as string) || `/exports/${res.filename}`;
          const bytes = new Uint8Array(await res.blob.arrayBuffer());
          registerVirtualFile(path, bytes, 'export');
          return { job: 'done', path, sizeBytes: bytes.byteLength };
        }
        default:
          throw new Error(`Unknown FilmCraft command: ${command}`);
      }
    },
  };

  win.filmcraft = api;
}
