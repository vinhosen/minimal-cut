/**
 * FilmCraft Linear-Light WebGL2 GPU Compositor
 * Ported from `storytold/filmcraft/crates/gpu/src/composite.wgsl`, `mask.wgsl`, and `transition.wgsl`
 * (MIT OR Apache-2.0).
 *
 * Performs color grading, LUTs, chroma key, glitch, vignette, circle/rounded masks, and
 * layer transforms in WebGL2 shaders, then composites 2D text/subtitle layers.
 */

import type { ColorSettings, MediaAsset, TimelineClip } from '../types/editor';
import { clamp } from '../utils/timecode';
import {
  type AssetDimensions,
  type Canvas2DContext,
  drawTextLayer,
  evalKeyframes,
  isVideoFrameReady,
  type RenderOptions,
} from '../utils/renderer';

const VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_tex;
uniform vec2 u_canvasSize;
uniform vec2 u_layerSize;
uniform vec2 u_translate;
uniform float u_rotation;
uniform vec2 u_flip;
uniform float u_crop;
uniform float u_opacity;
uniform int u_mask; // 0 none, 1 circle, 2 rounded
uniform vec3 u_bcs; // brightness, contrast, saturation (1.0 = 100%)
uniform int u_lut;  // 0 normal, 1 vivid, 2 warm, 3 matrix, 4 noir
uniform int u_chromaKey;
uniform int u_glitch;
uniform float u_vignette;

// FilmCraft composite.wgsl srgb_to_linear & linear_to_srgb
vec3 srgbToLinear(vec3 v) {
  vec3 lo = v / 12.92;
  vec3 hi = pow((max(v, vec3(0.0)) + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, lessThanEqual(v, vec3(0.04045)));
}

vec3 linearToSrgb(vec3 v) {
  vec3 lo = v * 12.92;
  vec3 hi = 1.055 * pow(max(v, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, lessThanEqual(v, vec3(0.0031308)));
}

float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

vec4 sampleLayer(vec2 pixelPos) {
  vec2 d = pixelPos - u_translate;
  float c = cos(-u_rotation);
  float s = sin(-u_rotation);
  vec2 local = vec2(d.x * c - d.y * s, d.x * s + d.y * c);
  local *= u_flip;

  vec2 halfSize = u_layerSize * 0.5;
  if (abs(local.x) > halfSize.x || abs(local.y) > halfSize.y) {
    return vec4(0.0);
  }

  float maskCov = 1.0;
  if (u_mask == 1) {
    float rad = min(halfSize.x, halfSize.y);
    float dist = length(local) - rad;
    maskCov = clamp(0.5 - dist, 0.0, 1.0);
  } else if (u_mask == 2) {
    float r = 28.0 * (min(u_canvasSize.x, u_canvasSize.y) / 720.0);
    float dist = sdRoundedBox(local, halfSize, r);
    maskCov = clamp(0.5 - dist, 0.0, 1.0);
  }
  if (maskCov <= 0.0) return vec4(0.0);

  vec2 normUv = (local + halfSize) / max(u_layerSize, vec2(1.0));
  vec2 croppedUv = vec2(u_crop) + normUv * (1.0 - u_crop * 2.0);
  vec4 texel = texture(u_tex, clamp(croppedUv, 0.0, 1.0));

  // Chroma key in GPU shader (matches renderer.ts threshold)
  if (u_chromaKey == 1) {
    if (texel.g > (105.0 / 255.0) && texel.g > texel.r * 1.35 && texel.g > texel.b * 1.35) {
      return vec4(0.0);
    }
  }

  // Linear-light grading pipeline
  vec3 lin = srgbToLinear(texel.rgb);
  float br = u_bcs.x;
  float ct = u_bcs.y;
  float sat = u_bcs.z;

  if (u_lut == 1) { // vivid
    ct *= 1.15;
    sat *= 1.35;
  }

  vec3 srgb = linearToSrgb(lin) * br;
  srgb = (srgb - 0.5) * ct + 0.5;
  float luma = dot(srgb, vec3(0.2126, 0.7152, 0.0722));
  srgb = mix(vec3(luma), srgb, sat);

  if (u_lut == 2) { // warm
    vec3 sepia = vec3(
      dot(srgb, vec3(0.393, 0.769, 0.189)),
      dot(srgb, vec3(0.349, 0.686, 0.168)),
      dot(srgb, vec3(0.272, 0.534, 0.131))
    );
    srgb = mix(srgb, sepia, 0.25) * 1.05;
  } else if (u_lut == 3) { // matrix
    float g = dot(srgb, vec3(0.299, 0.587, 0.114));
    srgb = vec3(g * 0.25, min(1.0, g * 1.25), g * 0.35);
  } else if (u_lut == 4) { // noir
    float g = dot(srgb, vec3(0.299, 0.587, 0.114));
    srgb = vec3((g - 0.5) * 1.15 + 0.5);
  }

  return vec4(clamp(srgb, 0.0, 1.0), texel.a * u_opacity * maskCov);
}

void main() {
  vec2 px = v_uv * u_canvasSize;
  vec4 c = sampleLayer(px);
  if (u_glitch == 1) {
    float shift = 6.0 * (u_canvasSize.x / 1280.0);
    vec4 left = sampleLayer(px - vec2(shift, 0.0));
    vec4 right = sampleLayer(px + vec2(shift, 0.0));
    c.r = max(c.r, left.r * 0.65);
    c.b = max(c.b, right.b * 0.65);
  }
  if (u_vignette > 0.0) {
    float dist = length(px - u_canvasSize * 0.5) / max(u_canvasSize.x, 1.0);
    float vig = smoothstep(0.25, 0.72, dist) * u_vignette;
    c.rgb *= (1.0 - vig);
  }
  outColor = c;
}
`;

export class FilmCraftGpuCompositor {
  private glCanvas: HTMLCanvasElement | OffscreenCanvas;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private tex: WebGLTexture | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};

  constructor(width = 1280, height = 720) {
    if (typeof OffscreenCanvas !== 'undefined') {
      this.glCanvas = new OffscreenCanvas(width, height);
    } else if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      this.glCanvas = c;
    } else {
      throw new Error('No canvas support');
    }
    this.initGl();
  }

  isAvailable(): boolean {
    return Boolean(this.gl && this.program);
  }

  private initGl(): void {
    try {
      const gl = this.glCanvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      }) as WebGL2RenderingContext | null;
      if (!gl) return;

      const vs = this.compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      const fs = this.compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      if (!vs || !fs) return;

      const prog = gl.createProgram();
      if (!prog) return;
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        gl.deleteProgram(prog);
        return;
      }

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW
      );
      const loc = gl.getAttribLocation(prog, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      const names = [
        'u_tex',
        'u_canvasSize',
        'u_layerSize',
        'u_translate',
        'u_rotation',
        'u_flip',
        'u_crop',
        'u_opacity',
        'u_mask',
        'u_bcs',
        'u_lut',
        'u_chromaKey',
        'u_glitch',
        'u_vignette',
      ];
      for (const n of names) {
        this.uniforms[n] = gl.getUniformLocation(prog, n);
      }

      this.gl = gl;
      this.program = prog;
      this.vao = vao;
      this.tex = tex;
    } catch {
      this.gl = null;
      this.program = null;
    }
  }

  private compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  private drawLayerGl(
    W: number,
    H: number,
    clip: TimelineClip,
    source: TexImageSource,
    srcW: number,
    srcH: number,
    time: number,
    colors: ColorSettings,
    applyChroma: boolean
  ): void {
    const gl = this.gl;
    if (!gl || !this.program || !this.tex || !srcW || !srcH) return;

    const tLocal = time - clip.timelineStart;
    const kf = evalKeyframes(clip, tLocal);
    let alpha = kf.opacity / 100;
    let slideX = 0;

    if (clip.transition === 'fade' || clip.transition === 'dissolve') {
      if (tLocal < 0.45) alpha *= tLocal / 0.45;
      if (clip.duration - tLocal < 0.45) alpha *= (clip.duration - tLocal) / 0.45;
    } else if (clip.transition === 'slide' && tLocal < 0.45) {
      const ease = 1 - Math.pow(1 - tLocal / 0.45, 3);
      slideX = (1 - ease) * -W * 0.35;
    }

    const baseScale = Math.min(W / srcW, H / srcH) * (kf.scale / 100);
    const dw = srcW * baseScale;
    const dh = srcH * baseScale;
    const tx = W / 2 + kf.x * (W / 1280) + slideX;
    const ty = H / 2 + kf.y * (H / 720);
    const rot = (clip.rotation * Math.PI) / 180;
    const maskCode = clip.mask === 'circle' ? 1 : clip.mask === 'rounded' ? 2 : 0;
    const lutCode =
      colors.lut === 'vivid'
        ? 1
        : colors.lut === 'warm'
          ? 2
          : colors.lut === 'matrix'
            ? 3
            : colors.lut === 'noir'
              ? 4
              : 0;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    gl.uniform1i(this.uniforms.u_tex, 0);
    gl.uniform2f(this.uniforms.u_canvasSize, W, H);
    gl.uniform2f(this.uniforms.u_layerSize, dw, dh);
    gl.uniform2f(this.uniforms.u_translate, tx, ty);
    gl.uniform1f(this.uniforms.u_rotation, rot);
    gl.uniform2f(this.uniforms.u_flip, clip.flipH ? -1 : 1, clip.flipV ? -1 : 1);
    gl.uniform1f(this.uniforms.u_crop, clamp(clip.crop, 0, 45) / 100);
    gl.uniform1f(this.uniforms.u_opacity, clamp(alpha, 0, 1));
    gl.uniform1i(this.uniforms.u_mask, maskCode);
    gl.uniform3f(
      this.uniforms.u_bcs,
      colors.brightness / 100,
      colors.contrast / 100,
      colors.saturation / 100
    );
    gl.uniform1i(this.uniforms.u_lut, lutCode);
    gl.uniform1i(this.uniforms.u_chromaKey, applyChroma && colors.chromaKey ? 1 : 0);
    gl.uniform1i(this.uniforms.u_glitch, colors.glitch ? 1 : 0);
    gl.uniform1f(this.uniforms.u_vignette, colors.vignette / 100);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * Renders the composition via WebGL2 shaders and blits the result + 2D text overlays to `targetCtx`.
   */
  renderFrame(
    targetCtx: Canvas2DContext,
    W: number,
    H: number,
    time: number,
    clips: TimelineClip[],
    assets: Map<string, MediaAsset | AssetDimensions>,
    colors: ColorSettings,
    showCenterGuides = false,
    opts: RenderOptions = {}
  ): boolean {
    const gl = this.gl;
    if (!gl || !this.program) return false;

    const activeVideo = clips.find(
      (c) => c.track === 'video' && time >= c.timelineStart && time < c.timelineStart + c.duration
    );
    const videoAsset = activeVideo?.mediaId ? assets.get(activeVideo.mediaId) : undefined;
    const providedVideoFrame = activeVideo ? opts.frameProvider?.(activeVideo) : undefined;
    const mediaVideoAsset = videoAsset && 'videoEl' in videoAsset ? (videoAsset as MediaAsset) : undefined;
    const videoEl =
      activeVideo && !providedVideoFrame && mediaVideoAsset
        ? (opts.videoSource?.(activeVideo) ?? mediaVideoAsset.videoEl)
        : undefined;
    const videoReady = Boolean(providedVideoFrame) || isVideoFrameReady(videoEl);

    if (opts.holdIfNotReady && videoAsset && !videoReady) {
      return false;
    }

    if (this.glCanvas.width !== W || this.glCanvas.height !== H) {
      this.glCanvas.width = W;
      this.glCanvas.height = H;
    }

    gl.viewport(0, 0, W, H);
    gl.clearColor(15 / 255, 17 / 255, 21 / 255, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    if (activeVideo && videoAsset) {
      const srcEl = (providedVideoFrame ?? (videoEl && videoEl.readyState >= 2 ? videoEl : undefined)) as
        | TexImageSource
        | undefined;
      if (srcEl) {
        this.drawLayerGl(W, H, activeVideo, srcEl, videoAsset.width, videoAsset.height, time, colors, true);
      }
    }

    const activeImages = clips.filter(
      (c) => c.track === 'image' && time >= c.timelineStart && time < c.timelineStart + c.duration
    );
    for (const imgClip of activeImages) {
      if (!imgClip.mediaId) continue;
      const asset = assets.get(imgClip.mediaId);
      if (!asset) continue;
      const providedImg = opts.frameProvider?.(imgClip);
      const mediaImg = 'imgEl' in asset ? (asset as MediaAsset).imgEl : undefined;
      const srcEl = (providedImg ?? (mediaImg && mediaImg.complete ? mediaImg : undefined)) as
        | TexImageSource
        | undefined;
      if (srcEl) {
        this.drawLayerGl(W, H, imgClip, srcEl, asset.width, asset.height, time, colors, false);
      }
    }

    // Blit GPU-composited frame to target 2D canvas (with optional blur filter if blur > 0)
    targetCtx.save();
    if (colors.blur > 0) {
      targetCtx.filter = `blur(${colors.blur}px)`;
    }
    targetCtx.drawImage(this.glCanvas, 0, 0, W, H);
    targetCtx.restore();

    // Draw 2D Text / Subtitle Track & Alignment Guides on top
    const activeTexts = clips.filter(
      (c) => c.track === 'fx' && time >= c.timelineStart && time < c.timelineStart + c.duration
    );
    for (const txtClip of activeTexts) {
      drawTextLayer(targetCtx, W, H, txtClip, time);
    }

    if (showCenterGuides) {
      targetCtx.save();
      targetCtx.strokeStyle = 'rgba(14, 165, 233, 0.8)';
      targetCtx.lineWidth = Math.max(1, Math.min(W, H) / 480);
      targetCtx.setLineDash([6, 6]);
      targetCtx.beginPath();
      targetCtx.moveTo(W / 2, 0);
      targetCtx.lineTo(W / 2, H);
      targetCtx.moveTo(0, H / 2);
      targetCtx.lineTo(W, H / 2);
      targetCtx.stroke();
      targetCtx.restore();
    }

    return true;
  }
}

let sharedGpuCompositor: FilmCraftGpuCompositor | null = null;
export function getSharedGpuCompositor(): FilmCraftGpuCompositor | null {
  if (typeof window !== 'undefined' && window.location?.search?.includes('cpu')) {
    return null;
  }
  if (!sharedGpuCompositor) {
    try {
      sharedGpuCompositor = new FilmCraftGpuCompositor();
    } catch {
      return null;
    }
  }
  return sharedGpuCompositor.isAvailable() ? sharedGpuCompositor : null;
}
