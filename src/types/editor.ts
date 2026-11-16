export type TrackType = 'video' | 'image' | 'fx' | 'audio';
export type AspectRatio = '16:9' | '9:16' | '1:1';
export type ExportFps = 24 | 30 | 60 | 120;
export type ExportResolution = 480 | 720 | 1080 | 1440 | 2160;
export type LutPreset = 'normal' | 'vivid' | 'warm' | 'matrix' | 'noir';
export type TransitionType = 'none' | 'fade' | 'slide' | 'dissolve';
export type MaskType = 'none' | 'circle' | 'rounded';
export type TextStyleType = 'subtitle' | 'title' | 'lowerthird' | 'badge' | 'sticker' | 'shape';
export type TextAnimType = 'none' | 'fade' | 'typewriter' | 'pulse';

export interface VideoKeyframe {
  t: number;
  x: number;
  y: number;
  scale: number;
  opacity: number;
}

export interface AudioKeyframe {
  t: number;
  gain: number;
}

export interface MediaAsset {
  id: string;
  type: 'video' | 'image' | 'audio';
  name: string;
  url: string;
  file: File;
  duration: number;
  width: number;
  height: number;
  videoEl?: HTMLVideoElement;
  imgEl?: HTMLImageElement;
  audioBuffer?: AudioBuffer;
  peaks?: Float32Array;
}

export interface TextData {
  text: string;
  style: TextStyleType;
  anim: TextAnimType;
  color: string;
  bgColor: string;
  fontSize: number;
  x: number; // percentage 5-95
  y: number; // percentage 8-92
}

export interface TimelineClip {
  id: string;
  track: TrackType;
  name: string;
  mediaId: string | null;
  timelineStart: number;
  duration: number;
  sourceStart: number;
  sourceDuration: number;
  // Visual properties
  x: number;
  y: number;
  scale: number;
  opacity: number;
  rotation: number;
  crop: number;
  flipH: boolean;
  flipV: boolean;
  blend: GlobalCompositeOperation;
  mask: MaskType;
  transition: TransitionType;
  speed: number;
  reverse: boolean;
  muted: boolean;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  normalizeGain?: number;
  keyframes?: VideoKeyframe[];
  audioKeyframes?: AudioKeyframe[];
  // Text overlay data
  fxData?: TextData;
}

export interface ColorSettings {
  lut: LutPreset;
  brightness: number;
  contrast: number;
  saturation: number;
  blur: number;
  vignette: number;
  glitch: boolean;
  chromaKey: boolean;
  noiseReduce: boolean;
}

export interface ExportSettings {
  resolution: ExportResolution;
  fps: ExportFps;
  bitrateMbps: number;
}
