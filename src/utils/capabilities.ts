export interface Capabilities {
  webCodecsEncode: boolean;
  webCodecsDecode: boolean;
  offscreenCanvas: boolean;
  webgl2: boolean;
  opfs: boolean;
  fsAccess: boolean;
  crossOriginIsolated: boolean;
  audioWorklet: boolean;
  /** Active compositor mode ('webgl2' | 'canvas2d') */
  compositor: 'webgl2' | 'canvas2d';
  /** Active engine mode ('v2' | 'standard') */
  engine: 'v2' | 'standard';
  /** FilmCraft URL flags */
  flags: {
    empty: boolean;
    noRecover: boolean;
    fresh: boolean;
    cpu: boolean;
    webgl: boolean;
    noWebCodecs: boolean;
    engineV2: boolean;
  };
}

export function parseUrlFlags(search = typeof window !== 'undefined' ? window.location.search : '') {
  const params = new URLSearchParams(search);
  return {
    empty: params.has('empty'),
    noRecover: params.has('norecover'),
    fresh: params.has('fresh'),
    cpu: params.has('cpu'),
    webgl: params.has('webgl'),
    noWebCodecs: params.has('nowebcodecs'),
    engineV2: params.get('engine') === 'v2' || !params.has('legacy'),
  };
}

export function detectCapabilities(): Capabilities {
  const win = typeof window !== 'undefined' ? window : undefined;
  const flags = parseUrlFlags();

  const webCodecsEncode = Boolean(win && 'VideoEncoder' in win && 'VideoFrame' in win);
  const webCodecsDecode = Boolean(win && !flags.noWebCodecs && 'VideoDecoder' in win && 'EncodedVideoChunk' in win);
  const offscreenCanvas = Boolean(win && 'OffscreenCanvas' in win);

  let webgl2 = false;
  if (win && typeof document !== 'undefined' && !flags.cpu) {
    try {
      const c = document.createElement('canvas');
      webgl2 = Boolean(c.getContext('webgl2'));
    } catch {
      webgl2 = false;
    }
  }

  const opfs = Boolean(
    win &&
      'navigator' in win &&
      win.navigator?.storage &&
      typeof win.navigator.storage.getDirectory === 'function'
  );

  const fsAccess = Boolean(win && 'showSaveFilePicker' in win);
  const crossOriginIsolated = Boolean(win && win.crossOriginIsolated);
  const audioWorklet = Boolean(win && 'AudioWorkletNode' in win);

  const compositor: 'webgl2' | 'canvas2d' = !flags.cpu && webgl2 ? 'webgl2' : 'canvas2d';
  const engine: 'v2' | 'standard' = flags.engineV2 && (webCodecsDecode || webgl2) ? 'v2' : 'standard';

  return {
    webCodecsEncode,
    webCodecsDecode,
    offscreenCanvas,
    webgl2,
    opfs,
    fsAccess,
    crossOriginIsolated,
    audioWorklet,
    compositor,
    engine,
    flags,
  };
}
