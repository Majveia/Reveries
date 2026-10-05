// HDR post-processing pipeline.
//
//   scene ─► sceneRT (HalfFloat color + Float32 depth texture, MSAA on desktop)
//         ─► level effects (atmosphere, lensing, volumetrics …) ping-pong HDR
//         ─► physically-based bloom (mip chain, Karis-averaged)
//         ─► composite: exposure → AgX/ACES → grade → vignette/CA/grain → LDR
//         ─► FXAA ─► screen
//
// Effect interface (levels pass an array to render()):
//   { enabled?: boolean, render(renderer, inputTexture, outputTarget, ctx) }
//   ctx = { depthTexture, camera, near, far, reversed (0|1), time, width, height,
//           projInv (Matrix4), viewInv (Matrix4), cameraPosition (Vector3), fullscreen }
//   Use ctx.fullscreen(material, outputTarget) to draw a fullscreen triangle.

import * as THREE from 'three';
import { FULLSCREEN_VERT } from './glsl/common.js';

const DEFAULT_GRADE = {
  exposure: 1.0,
  toneMap: 'agx', // 'agx' | 'aces'
  agxPunch: 0.5, // 0 = neutral AgX, 1 = punchy look
  contrast: 1.05,
  saturation: 1.05,
  temperature: 0.0, // -1 cool … +1 warm
  tint: 0.0, // -1 green … +1 magenta
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  shadowsTint: [0, 0, 0], // split toning (added in shadows)
  highlightsTint: [0, 0, 0],
  blackPoint: 0.004, // crushes near-black to true black (OLED)
  vignette: 0.28,
  vignetteSoftness: 0.55,
  grain: 0.035,
  chroma: 0.0025, // chromatic aberration strength at edges
  bloomStrength: 0.06,
  bloomRadius: 0.85,
  bloomThreshold: 0.0, // 0 = energy conserving full-scene bloom
  bloomKnee: 0.5,
};

class Fullscreen {
  constructor() {
    const g = new THREE.BufferGeometry();
    // One big triangle covering the screen (no seam, cheaper than a quad).
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.mesh = new THREE.Mesh(g, null);
    this.mesh.frustumCulled = false;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  render(renderer, material, target) {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, this.camera);
  }
}

const mat = (frag, uniforms, defines = {}) => new THREE.ShaderMaterial({
  vertexShader: FULLSCREEN_VERT, fragmentShader: frag, uniforms, defines,
  depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
});

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tInput; uniform vec2 uTexel; uniform float uFirst; uniform float uThreshold; uniform float uKnee;
varying vec2 vUv;
vec3 s(vec2 o){ return texture2D(tInput, vUv + o * uTexel).rgb; }
float karis(vec3 c){ return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))); }
vec3 prefilter(vec3 c){
  if (uThreshold <= 0.0) return c;
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  rq = (rq * rq) / (4.0 * uKnee + 1e-5);
  return c * max(rq, br - uThreshold) / max(br, 1e-5);
}
void main(){
  // 13-tap downsample (Jimenez, CoD:AW 2014)
  vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
  vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
  vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
  vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
  vec3 col;
  if (uFirst > 0.5) {
    // Karis average on the first mip kills fireflies (stars/specular).
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    float w0 = karis(g0), w1 = karis(g1), w2 = karis(g2), w3 = karis(g3), w4 = karis(g4);
    col = (g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125 + g3 * w3 * 0.125 + g4 * w4 * 0.5) / (w0 * 0.125 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.5);
    col = prefilter(col);
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

const UP_FRAG = /* glsl */ `
uniform sampler2D tLow; uniform sampler2D tHigh; uniform vec2 uTexel; uniform float uRadius;
varying vec2 vUv;
void main(){
  // 3x3 tent upsample of the lower mip, blended with this level's downsample.
  vec2 t = uTexel;
  vec3 c = texture2D(tLow, vUv + vec2(-t.x, t.y)).rgb + texture2D(tLow, vUv + vec2(0.0, t.y)).rgb * 2.0 + texture2D(tLow, vUv + vec2(t.x, t.y)).rgb
         + texture2D(tLow, vUv + vec2(-t.x, 0.0)).rgb * 2.0 + texture2D(tLow, vUv).rgb * 4.0 + texture2D(tLow, vUv + vec2(t.x, 0.0)).rgb * 2.0
         + texture2D(tLow, vUv + vec2(-t.x, -t.y)).rgb + texture2D(tLow, vUv + vec2(0.0, -t.y)).rgb * 2.0 + texture2D(tLow, vUv + vec2(t.x, -t.y)).rgb;
  c /= 16.0;
  gl_FragColor = vec4(mix(texture2D(tHigh, vUv).rgb, c, uRadius), 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene; uniform sampler2D tBloom;
uniform vec2 uResolution; uniform float uTime;
uniform float uExposure, uToneMap, uAgxPunch, uContrast, uSaturation, uTemperature, uTint, uBlackPoint;
uniform vec3 uLift, uGamma, uGain, uShadowsTint, uHighlightsTint;
uniform float uVignette, uVignetteSoft, uGrain, uChroma, uBloomStrength;
uniform float uWarp, uFade; uniform vec3 uFadeColor;
varying vec2 vUv;

vec3 agxContrast(vec3 x){ vec3 x2 = x*x; vec3 x4 = x2*x2;
  return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232; }
vec3 agx(vec3 v){
  const mat3 m = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                      0.0784335999999992, 0.878468636469772, 0.0784336,
                      0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const mat3 mi = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                       -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                       -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  const float minEv = -12.47393, maxEv = 4.026069;
  v = m * max(v, vec3(1e-10));
  v = clamp(log2(v), minEv, maxEv);
  v = (v - minEv) / (maxEv - minEv);
  v = agxContrast(v);
  // punchy look
  float l = dot(v, vec3(0.2126, 0.7152, 0.0722));
  vec3 pv = pow(max(v, 0.0), vec3(mix(1.0, 1.35, uAgxPunch)));
  v = mix(v, l + mix(1.0, 1.4, uAgxPunch) * (pv - l), step(0.001, uAgxPunch));
  return clamp(mi * v, 0.0, 1.0); // display-encoded (≈ gamma 2.2)
}
vec3 acesFitted(vec3 c){
  const mat3 i = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 o = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  c = i * c; vec3 a = c * (c + 0.0245786) - 0.000090537; vec3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
  c = o * (a / b);
  return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
}
vec3 whiteBalance(vec3 c, float temp, float tint){
  // Simple, perceptually reasonable WB in display space.
  vec3 w = vec3(1.0 + temp * 0.10 + tint * 0.05, 1.0 - tint * 0.08, 1.0 - temp * 0.12 + tint * 0.05);
  return c * w;
}
float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

vec3 sampleScene(vec2 uv){
  vec2 d = uv - 0.5;
  float r2 = dot(d, d);
  vec2 off = d * r2 * uChroma * 4.0;
  vec3 c;
  c.r = texture2D(tScene, uv - off).r;
  c.g = texture2D(tScene, uv).g;
  c.b = texture2D(tScene, uv + off).b;
  return c;
}

void main(){
  vec2 uv = vUv;
  vec3 col;
  if (uWarp > 0.001) {
    // Hyperspace: radial zoom streaks toward the center.
    vec2 d = uv - 0.5;
    col = vec3(0.0);
    float total = 0.0;
    for (int i = 0; i < 16; i++) {
      float f = float(i) / 15.0;
      float sc = 1.0 - uWarp * 0.45 * f;
      float w = 1.0 - f * 0.6;
      col += sampleScene(0.5 + d * sc) * w; total += w;
    }
    col /= total;
    col *= 1.0 + uWarp * 2.5 * smoothstep(0.0, 0.7, length(d));
  } else {
    col = sampleScene(uv);
  }
  vec3 bloom = texture2D(tBloom, uv).rgb;
  col = mix(col, bloom, uBloomStrength) + bloom * uBloomStrength * 0.35;
  col *= uExposure;

  col = uToneMap < 0.5 ? agx(col) : acesFitted(col);

  // ---- grade (display space) ----
  col = whiteBalance(col, uTemperature, uTint);
  col = pow(max(col * uGain + uLift * (1.0 - col), 0.0), 1.0 / max(uGamma, vec3(0.01)));
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col += uShadowsTint * (1.0 - smoothstep(0.0, 0.45, l)) + uHighlightsTint * smoothstep(0.55, 1.0, l);
  col = (col - 0.5) * uContrast + 0.5;
  l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSaturation);
  col = max(col - uBlackPoint, 0.0) / (1.0 - uBlackPoint);

  // ---- lens ----
  vec2 vd = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
  float vig = smoothstep(0.85, 0.85 - uVignetteSoft, length(vd) * (1.0 + uVignette * 0.6));
  col *= mix(1.0 - uVignette, 1.0, vig);
  // Grain: luminance-weighted so true blacks stay black on OLED.
  float n = hash(uv * uResolution + fract(uTime * 13.17) * 917.0) - 0.5;
  float lg = dot(col, vec3(0.333));
  col += n * uGrain * smoothstep(0.0, 0.18, lg) * (1.0 - lg * 0.5);
  // Fade (level transitions)
  col = mix(col, uFadeColor, uFade);
  // Dither to kill banding in gradients.
  col += (hash(uv * uResolution * 1.37 + 3.1) - 0.5) / 255.0;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// FXAA 3.11 (simplified, quality preset ~12) — LDR input.
const FXAA_FRAG = /* glsl */ `
uniform sampler2D tInput; uniform vec2 uTexel; varying vec2 vUv;
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec3 rgbM = texture2D(tInput, vUv).rgb;
  float lM = lum(rgbM);
  float lN = lum(texture2D(tInput, vUv + vec2(0.0, uTexel.y)).rgb);
  float lS = lum(texture2D(tInput, vUv - vec2(0.0, uTexel.y)).rgb);
  float lE = lum(texture2D(tInput, vUv + vec2(uTexel.x, 0.0)).rgb);
  float lW = lum(texture2D(tInput, vUv - vec2(uTexel.x, 0.0)).rgb);
  float lMin = min(lM, min(min(lN, lS), min(lE, lW)));
  float lMax = max(lM, max(max(lN, lS), max(lE, lW)));
  float range = lMax - lMin;
  if (range < max(0.0312, lMax * 0.125)) { gl_FragColor = vec4(rgbM, 1.0); return; }
  float lNW = lum(texture2D(tInput, vUv + vec2(-uTexel.x, uTexel.y)).rgb);
  float lNE = lum(texture2D(tInput, vUv + vec2(uTexel.x, uTexel.y)).rgb);
  float lSW = lum(texture2D(tInput, vUv + vec2(-uTexel.x, -uTexel.y)).rgb);
  float lSE = lum(texture2D(tInput, vUv + vec2(uTexel.x, -uTexel.y)).rgb);
  vec2 dir;
  dir.x = -((lNW + lNE) - (lSW + lSE));
  dir.y = ((lNW + lSW) - (lNE + lSE));
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * uTexel;
  vec3 rgbA = 0.5 * (texture2D(tInput, vUv + dir * (1.0/3.0 - 0.5)).rgb + texture2D(tInput, vUv + dir * (2.0/3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tInput, vUv + dir * -0.5).rgb + texture2D(tInput, vUv + dir * 0.5).rgb);
  float lB = lum(rgbB);
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}`;

export class PostFX {
  constructor(renderer, quality) {
    this.renderer = renderer;
    this.quality = quality;
    this.fs = new Fullscreen();
    this.grade = { ...DEFAULT_GRADE };
    this._gradeFrom = null; this._gradeTo = null; this._gradeT = 1; this._gradeDur = 1;
    this.transition = { warp: 0, fade: 0, color: new THREE.Color(0, 0, 0) };
    this.bloomLevels = quality.pick(5, 6, 7, 7);
    this.enabled = true;
    this.reversed = renderer.state.buffers.depth.getReversed ? (renderer.state.buffers.depth.getReversed() ? 1 : 0) : 0;
    this.width = 1; this.height = 1;

    this._projInv = new THREE.Matrix4();
    this._ctx = {
      depthTexture: null, camera: null, near: 0.1, far: 1000, reversed: this.reversed, time: 0,
      width: 1, height: 1, projInv: this._projInv, viewInv: new THREE.Matrix4(), cameraPosition: new THREE.Vector3(),
      fullscreen: (material, target) => this.fs.render(this.renderer, material, target),
    };

    this.downMat = mat(DOWN_FRAG, { tInput: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 }, uThreshold: { value: 0 }, uKnee: { value: 0.5 } });
    this.upMat = mat(UP_FRAG, { tLow: { value: null }, tHigh: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 0.85 } });
    this.compMat = mat(COMPOSITE_FRAG, {
      tScene: { value: null }, tBloom: { value: null }, uResolution: { value: new THREE.Vector2() }, uTime: { value: 0 },
      uExposure: { value: 1 }, uToneMap: { value: 0 }, uAgxPunch: { value: 0.5 }, uContrast: { value: 1 }, uSaturation: { value: 1 },
      uTemperature: { value: 0 }, uTint: { value: 0 }, uBlackPoint: { value: 0.004 },
      uLift: { value: new THREE.Vector3() }, uGamma: { value: new THREE.Vector3(1, 1, 1) }, uGain: { value: new THREE.Vector3(1, 1, 1) },
      uShadowsTint: { value: new THREE.Vector3() }, uHighlightsTint: { value: new THREE.Vector3() },
      uVignette: { value: 0.3 }, uVignetteSoft: { value: 0.5 }, uGrain: { value: 0.03 }, uChroma: { value: 0.002 }, uBloomStrength: { value: 0.06 },
      uWarp: { value: 0 }, uFade: { value: 0 }, uFadeColor: { value: new THREE.Color() },
    });
    this.fxaaMat = mat(FXAA_FRAG, { tInput: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.copyMat = mat(`uniform sampler2D tInput; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tInput, vUv); }`, { tInput: { value: null } });
  }

  /** Smoothly blend toward a partial grade over `seconds`. */
  setGrade(partial, seconds = 0) {
    const target = { ...this.grade, ...partial };
    if (seconds <= 0) { this.grade = target; this._gradeT = 1; this._gradeTo = null; return; }
    this._gradeFrom = { ...this.grade }; this._gradeTo = target; this._gradeT = 0; this._gradeDur = seconds;
  }
  resetGrade(seconds = 0) { this.setGrade({ ...DEFAULT_GRADE }, seconds); }

  setSize(w, h, dpr) {
    const W = Math.max(1, Math.floor(w * dpr)), H = Math.max(1, Math.floor(h * dpr));
    if (W === this.width && H === this.height && this.sceneRT) return;
    this.width = W; this.height = H;
    this.dispose();
    const hdr = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false };
    const depthTexture = new THREE.DepthTexture(W, H, THREE.FloatType);
    depthTexture.minFilter = THREE.NearestFilter; depthTexture.magFilter = THREE.NearestFilter;
    this.sceneRT = new THREE.WebGLRenderTarget(W, H, { ...hdr, depthBuffer: true, depthTexture, samples: this.quality.msaa });
    this.pingRT = new THREE.WebGLRenderTarget(W, H, hdr);
    this.pongRT = new THREE.WebGLRenderTarget(W, H, hdr);
    this.ldrRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.down = []; this.up = [];
    let bw = W, bh = H;
    for (let i = 0; i < this.bloomLevels; i++) {
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
      this.down.push(new THREE.WebGLRenderTarget(bw, bh, hdr));
      this.up.push(new THREE.WebGLRenderTarget(bw, bh, hdr));
    }
  }

  get depthTexture() { return this.sceneRT?.depthTexture; }

  _tickGrade(dt) {
    if (!this._gradeTo) return;
    this._gradeT = Math.min(1, this._gradeT + dt / this._gradeDur);
    const t = this._gradeT * this._gradeT * (3 - 2 * this._gradeT);
    const a = this._gradeFrom, b = this._gradeTo, g = this.grade;
    for (const k of Object.keys(b)) {
      if (typeof b[k] === 'number') g[k] = a[k] + (b[k] - a[k]) * t;
      else if (Array.isArray(b[k])) g[k] = b[k].map((v, i) => a[k][i] + (v - a[k][i]) * t);
      else g[k] = t < 0.5 ? a[k] : b[k];
    }
    if (this._gradeT >= 1) this._gradeTo = null;
  }

  /**
   * Render a scene through the full pipeline to the screen.
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {Array} effects level-specific HDR effects (see header)
   * @param {object} opts { time, dt, before(renderer, sceneRT) }
   */
  render(scene, camera, effects = [], opts = {}) {
    const r = this.renderer;
    const dt = opts.dt ?? 1 / 60;
    this._tickGrade(dt);

    // 1) scene → HDR
    r.setRenderTarget(this.sceneRT);
    r.clear(true, true, false);
    r.render(scene, camera);
    let src = this.sceneRT.texture;

    // 2) level effects
    const ctx = this._ctx;
    ctx.depthTexture = this.sceneRT.depthTexture; ctx.camera = camera; ctx.near = camera.near; ctx.far = camera.far;
    ctx.time = opts.time ?? 0; ctx.width = this.width; ctx.height = this.height;
    this._projInv.copy(camera.projectionMatrixInverse); ctx.viewInv.copy(camera.matrixWorld);
    camera.getWorldPosition(ctx.cameraPosition);
    let flip = false;
    for (const fx of effects) {
      if (!fx || fx.enabled === false) continue;
      const out = flip ? this.pongRT : this.pingRT;
      fx.render(r, src, out, ctx);
      src = out.texture; flip = !flip;
    }

    // 3) bloom
    const g = this.grade;
    let prev = src;
    for (let i = 0; i < this.down.length; i++) {
      const t = this.down[i];
      this.downMat.uniforms.tInput.value = prev;
      const pw = i === 0 ? this.width : this.down[i - 1].width, ph = i === 0 ? this.height : this.down[i - 1].height;
      this.downMat.uniforms.uTexel.value.set(1 / pw, 1 / ph);
      this.downMat.uniforms.uFirst.value = i === 0 ? 1 : 0;
      this.downMat.uniforms.uThreshold.value = g.bloomThreshold;
      this.downMat.uniforms.uKnee.value = g.bloomKnee;
      this.fs.render(r, this.downMat, t);
      prev = t.texture;
    }
    let low = this.down[this.down.length - 1].texture;
    for (let i = this.down.length - 2; i >= 0; i--) {
      this.upMat.uniforms.tLow.value = low;
      this.upMat.uniforms.tHigh.value = this.down[i].texture;
      this.upMat.uniforms.uTexel.value.set(1 / this.down[i + 1].width, 1 / this.down[i + 1].height);
      this.upMat.uniforms.uRadius.value = g.bloomRadius;
      this.fs.render(r, this.upMat, this.up[i]);
      low = this.up[i].texture;
    }

    // 4) composite
    const u = this.compMat.uniforms;
    u.tScene.value = src; u.tBloom.value = low;
    u.uResolution.value.set(this.width, this.height); u.uTime.value = ctx.time;
    u.uExposure.value = g.exposure; u.uToneMap.value = g.toneMap === 'aces' ? 1 : 0; u.uAgxPunch.value = g.agxPunch;
    u.uContrast.value = g.contrast; u.uSaturation.value = g.saturation; u.uTemperature.value = g.temperature; u.uTint.value = g.tint;
    u.uBlackPoint.value = g.blackPoint;
    u.uLift.value.fromArray(g.lift); u.uGamma.value.fromArray(g.gamma); u.uGain.value.fromArray(g.gain);
    u.uShadowsTint.value.fromArray(g.shadowsTint); u.uHighlightsTint.value.fromArray(g.highlightsTint);
    u.uVignette.value = g.vignette; u.uVignetteSoft.value = g.vignetteSoftness; u.uGrain.value = g.grain; u.uChroma.value = g.chroma;
    u.uBloomStrength.value = g.bloomStrength;
    u.uWarp.value = this.transition.warp; u.uFade.value = this.transition.fade; u.uFadeColor.value.copy(this.transition.color);
    this.fs.render(r, this.compMat, this.ldrRT);

    // 5) FXAA → screen
    this.fxaaMat.uniforms.tInput.value = this.ldrRT.texture;
    this.fxaaMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.fs.render(r, this.fxaaMat, null);
  }

  dispose() {
    for (const t of [this.sceneRT, this.pingRT, this.pongRT, this.ldrRT, ...(this.down || []), ...(this.up || [])]) {
      if (!t) continue;
      t.depthTexture?.dispose?.();
      t.dispose();
    }
  }
}

export { DEFAULT_GRADE };
