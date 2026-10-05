// Renders the cosmic web: millions of tracer sprites of the dark-matter
// phase-space sheet, accumulated additively (HDR) as projected column density
// + density-weighted colour, then mapped through a luminous palette in a
// post effect (deep indigo sheets → electric cyan filaments → gold-white
// nodes) with depth cueing. True black stays true black.

import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/glsl/common.js';

const PALETTE_GLSL = /* glsl */ `
vec3 webPalette(float h){
  // linear-light HDR stops
  vec3 c0 = vec3(0.020, 0.008, 0.055);   // void
  vec3 c1 = vec3(0.100, 0.030, 0.360);   // sheet indigo-violet
  vec3 c2 = vec3(0.130, 0.170, 0.820);   // blue-violet
  vec3 c3 = vec3(0.050, 0.850, 1.100);   // electric cyan filament
  vec3 c4 = vec3(0.850, 0.900, 0.950);   // pale crossover
  vec3 c5 = vec3(1.550, 0.850, 0.300);   // warm gold group
  vec3 c6 = vec3(1.800, 1.500, 1.100);   // white-gold cluster core
  h = clamp(h, 0.0, 1.2);
  if (h < 0.18) return mix(c0, c1, h / 0.18);
  if (h < 0.37) return mix(c1, c2, (h - 0.18) / 0.19);
  if (h < 0.50) return mix(c2, c3, (h - 0.37) / 0.13);
  if (h < 0.60) return mix(c3, c4, (h - 0.50) / 0.10);
  if (h < 0.71) return mix(c4, c5, (h - 0.60) / 0.11);
  return mix(c5, c6, clamp((h - 0.71) / 0.3, 0.0, 1.0));
}`;

const TRACER_VERT = /* glsl */ `
uniform sampler2D tPrev; uniform sampler2D tNext; uniform float uW;
uniform float uL; uniform vec3 uCenter; uniform float uScale; uniform float uShape;
uniform float uProj; uniform float uTime; uniform float uShimmer; uniform float uVol; uniform float uGamma;
uniform float uWarm; uniform float uFog; uniform float uSizeK; uniform float uOverlap; uniform float uContrastK; uniform float uFogNear;
varying vec4 vC;
${PALETTE_GLSL}
float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
void main(){
  int t = gl_VertexID;
  ivec2 tc = ivec2(t % TW, t / TW);
  vec4 s = mix(texelFetch(tPrev, tc, 0), texelFetch(tNext, tc, 0), uW);
  ivec3 l = ivec3(t % MT, (t / MT) % MT, t / (MT * MT));
  vec3 x = (vec3(l) + 0.5) * (uL / float(MT)) + s.xyz;
  vec3 d = x - uCenter;
  d -= uL * floor(d / uL + 0.5);                     // periodic: nearest image around the centre
  vec3 ad = abs(d) / (0.5 * uL);
  float nrm = pow(pow(ad.x, uShape) + pow(ad.y, uShape) + pow(ad.z, uShape), 1.0 / uShape);
  float fade = 1.0 - smoothstep(0.78, 0.99, nrm);
  float heat = s.w;
  float hh = clamp((heat - 0.5) / 0.5, 0.0, 1.0);
  // virialised shimmer: members of collapsed halos swarm on their orbits
  float fid = float(t);
  vec3 ph = vec3(hash11(fid), hash11(fid + 17.3), hash11(fid + 41.9)) * 6.2831853;
  float om = 0.35 + hash11(fid + 7.1) * 0.9;
  d += uShimmer * hh * hh * 0.45 * sin(uTime * om + ph);
  vec3 wp = uCenter + d * uScale;
  vec4 mv = modelViewMatrix * vec4(wp, 1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;
  if (dist < 0.05 || fade <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vC = vec4(0.0); return; }
  // Gaussian-splat the sheet: sprites cover the local inter-tracer spacing, so stretched
  // regions (voids, sheets) render as a smooth continuum and collapsed ones stay sharp.
  float rhoEff = pow(10.0, (heat - 0.2) / (0.31 * uContrastK));
  float spacing = (uL / float(MT)) * clamp(pow(rhoEff, -0.333), 0.05, 1.8) * uScale;
  float sharp = (uL / float(MT)) * uSizeK * 0.09 * uScale;
  float px = max(sharp, spacing * uOverlap) * uProj / dist;
  float pxc = clamp(px, 1.0, 40.0);
  gl_PointSize = pxc;
  // emission ∝ mass · ρ^γ ; per-pixel value is column density (Mpc of mean matter)
  float emis = uVol * pow(10.0, uGamma * (heat - 0.2) / 0.31);
  float pxWorld = dist / uProj;
  float norm = max(1.0, 0.262 * pxc * pxc);
  float near = smoothstep(3.0, 14.0, dist);
  float val = fade * near * emis / (pxWorld * pxWorld * norm) / (uScale * uScale) * 1e-3; // ×1e-3 keeps half-float sums finite
  val = min(val, 30.0);
  // depth cue: distant structure cools and dims slightly (atmospheric perspective of the web)
  float fd = max(dist - uFogNear, 0.0);
  float fogk = 1.0 - exp(-fd / uFog);
  vec3 col = webPalette(heat);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(0.13, 0.09, 0.62) * (lum * 0.9 + 0.02), fogk * 0.5);
  val *= mix(1.0, exp(-fd / uFog), 0.7);
  // primordial glow (early universe): warm amber plasma
  col = mix(col, vec3(1.25, 0.62, 0.28), uWarm);
  val *= 1.0 + 5.0 * uWarm * uWarm;
  vC = vec4(col * val, val);
}`;

const TRACER_FRAG = /* glsl */ `
varying vec4 vC;
void main(){
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(pc, pc);
  if (r2 > 1.0) discard;
  float k = (1.0 - r2) * (1.0 - r2);
  gl_FragColor = vC * k;
}`;


// Galaxies: a sparse, hash-selected subset of tracers lights up as sharp HDR
// points where matter has collapsed (groups, clusters, dense filaments). They
// render straight into the HDR scene (not log-mapped) so they sparkle and bloom.
const GALAXY_VERT = /* glsl */ `
uniform sampler2D tPrev; uniform sampler2D tNext; uniform float uW;
uniform float uL; uniform vec3 uCenter; uniform float uScale; uniform float uShape;
uniform float uTime; uniform float uShimmer; uniform float uWarm; uniform float uGal; uniform float uPxK;
varying vec3 vCol;
uint ihash(uint x){ x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
void main(){
  uint hi = ihash(uint(gl_VertexID) + 0x9e3779b9u);
  int t = gl_VertexID * STRIDE + int(hi % uint(STRIDE));
  ivec2 tc = ivec2(t % TW, t / TW);
  vec4 s = mix(texelFetch(tPrev, tc, 0), texelFetch(tNext, tc, 0), uW);
  ivec3 l = ivec3(t % MT, (t / MT) % MT, t / (MT * MT));
  vec3 x = (vec3(l) + 0.5) * (uL / float(MT)) + s.xyz;
  vec3 d = x - uCenter;
  d -= uL * floor(d / uL + 0.5);
  vec3 ad = abs(d) / (0.5 * uL);
  float nrm = pow(pow(ad.x, uShape) + pow(ad.y, uShape) + pow(ad.z, uShape), 1.0 / uShape);
  float fade = 1.0 - smoothstep(0.76, 0.97, nrm);
  float heat = s.w;
  float hh = clamp((heat - 0.5) / 0.5, 0.0, 1.0);
  float fid = float(t);
  vec3 ph = vec3(hash11(fid), hash11(fid + 17.3), hash11(fid + 41.9)) * 6.2831853;
  float om = 0.35 + hash11(fid + 7.1) * 0.9;
  d += uShimmer * hh * hh * 0.45 * sin(uTime * om + ph);
  vec4 mv = modelViewMatrix * vec4(uCenter + d * uScale, 1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;
  // luminosity function: galaxies live in collapsed structures; a few are giants
  float u = float((hi >> 8) & 1023u) / 1023.0;
  float lum = smoothstep(0.40, 0.95, heat) * (0.25 + 2.6 * u * u * u * u);
  if (dist < 0.3 || fade <= 0.0 || lum < 0.004) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); return; }
  float b = lum * fade * smoothstep(0.3, 2.5, dist) * uGal * 110.0 / max(dist, 6.0);
  float px = clamp(uPxK * (1.1 + 1.8 * u * u) * sqrt(30.0 / max(dist, 4.0)), 1.0, 7.0);
  gl_PointSize = px;
  // red-and-dead ellipticals in cluster cores, blue star-forming spirals in filaments
  float tint = float((hi >> 20) & 255u) / 255.0;
  vec3 cl = mix(vec3(1.0, 0.74, 0.46), vec3(1.0, 0.9, 0.78), tint);
  vec3 fl = mix(vec3(0.62, 0.78, 1.0), vec3(0.95, 0.92, 1.0), tint);
  vec3 col = mix(fl, cl, smoothstep(0.55, 0.85, heat));
  col = mix(col, vec3(1.25, 0.62, 0.28), uWarm);
  vCol = col * b / max(1.0, px * px * 0.3);
}`;
const GALAXY_FRAG = /* glsl */ `
varying vec3 vCol;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vCol * (exp(-r2 * 7.0) + 0.35 * exp(-r2 * 2.0)), 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tInput; uniform sampler2D tAccum; uniform float uGain; uniform float uA0; uniform float uHi; uniform float uExposure; uniform float uToe;
varying vec2 vUv;
void main(){
  vec3 base = texture2D(tInput, vUv).rgb;
  vec4 acc = texture2D(tAccum, vUv);
  float A = min(acc.a, 60000.0) * 1000.0;
  vec3 C = min(acc.rgb, vec3(60000.0)) * 1000.0 / max(A, 1e-6);
  // log column-density response (shows faint sheets and blazing nodes at once) + HDR highlights for bloom
  float I = uGain * log(1.0 + pow(A / uA0, uToe)) + uHi * pow(A / uA0 * 0.01, 1.2);
  gl_FragColor = vec4(base + C * I * uExposure, 1.0);
}`;

export class WebRenderer {
  constructor(engine, sim, opts = {}) {
    this.engine = engine;
    this.sim = sim;
    const { TW, m, L, T } = sim;
    this.params = {
      gain: 0.16, a0: 60, hi: 0.02, toe: 1.4, exposure: 1, gamma: 2.2, shimmer: 1, warm: 0, fog: 260, sizeK: 1.0, shape: 2, scale: 1, overlap: 1.4, contrastK: 1, galaxies: 1, fogNear: 0,
    };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Uint8Array(T), 1));
    this.material = new THREE.ShaderMaterial({
      vertexShader: TRACER_VERT, fragmentShader: TRACER_FRAG,
      defines: { TW, MT: m },
      uniforms: {
        tPrev: { value: null }, tNext: { value: null }, uW: { value: 0 },
        uL: { value: L }, uCenter: { value: new THREE.Vector3() }, uScale: { value: 1 }, uShape: { value: 6 },
        uProj: { value: 600 }, uTime: { value: 0 }, uShimmer: { value: 1 }, uVol: { value: (L / m) ** 3 }, uGamma: { value: 0.6 },
        uWarm: { value: 0 }, uFog: { value: 260 }, uSizeK: { value: 1 }, uOverlap: { value: 1.6 }, uContrastK: { value: 1 }, uFogNear: { value: 0 },
      },
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    });
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.accScene = new THREE.Scene();
    this.accScene.add(this.points);
    this.accRT = null;

    // galaxies (scene object, HDR)
    const nGal = Math.min(T, opts.galaxies ?? 65536);
    const stride = Math.max(1, Math.floor(T / nGal));
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(new Uint8Array(Math.floor(T / stride)), 1));
    gg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const U = this.material.uniforms;
    this.galMaterial = new THREE.ShaderMaterial({
      vertexShader: GALAXY_VERT, fragmentShader: GALAXY_FRAG, defines: { TW, MT: m, STRIDE: stride },
      uniforms: { tPrev: U.tPrev, tNext: U.tNext, uW: U.uW, uL: U.uL, uCenter: U.uCenter, uScale: U.uScale, uShape: U.uShape, uTime: U.uTime, uShimmer: U.uShimmer, uWarm: U.uWarm, uGal: { value: 1 }, uPxK: { value: 1 } },
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    this.galaxies = new THREE.Points(gg, this.galMaterial);
    this.galaxies.frustumCulled = false;
    this.galaxies.renderOrder = 5;
    this._key = '';

    const self = this;
    this.compMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: COMPOSITE_FRAG,
      uniforms: { tInput: { value: null }, tAccum: { value: null }, uGain: { value: 0.16 }, uA0: { value: 2 }, uHi: { value: 0.6 }, uExposure: { value: 1 }, uToe: { value: 1.4 } },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.effect = {
      enabled: true,
      render(renderer, input, output, ctx) {
        const u = self.compMat.uniforms;
        u.tInput.value = input; u.tAccum.value = self.accRT?.texture || null;
        u.uGain.value = self.params.gain; u.uA0.value = self.params.a0; u.uHi.value = self.params.hi; u.uExposure.value = self.params.exposure; u.uToe.value = self.params.toe;
        ctx.fullscreen(self.compMat, output);
      },
    };
  }

  _ensureRT() {
    const pf = this.engine.postfx;
    const w = pf.width, h = pf.height;
    if (this.accRT && this.accRT.width === w && this.accRT.height === h) return;
    this.accRT?.dispose();
    this.accRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this._key = '';
  }

  /**
   * Accumulate tracer sprites for this camera. disp = { prev, next, w } from the solver.
   * `center` is the periodic wrap centre (Vector3), `time` drives the shimmer.
   */
  accumulate(camera, disp, center, time, cacheable = false) {
    this._ensureRT();
    const r = this.engine.renderer;
    const u = this.material.uniforms, p = this.params;
    u.tPrev.value = disp.prev.texture; u.tNext.value = disp.next.texture; u.uW.value = disp.w;
    u.uCenter.value.copy(center); u.uScale.value = p.scale; u.uShape.value = p.shape;
    u.uProj.value = this.accRT.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    u.uTime.value = time; u.uShimmer.value = p.shimmer; u.uGamma.value = p.gamma; u.uWarm.value = p.warm; u.uFog.value = p.fog; u.uSizeK.value = p.sizeK; u.uOverlap.value = p.overlap; u.uContrastK.value = p.contrastK; u.uFogNear.value = p.fogNear;
    this.galMaterial.uniforms.uGal.value = p.galaxies ?? 1; this.galMaterial.uniforms.uPxK.value = this.accRT.height / 720;
    if (cacheable) {
      camera.updateMatrixWorld();
      const e = camera.matrixWorld.elements, f = camera.projectionMatrix.elements;
      const key = `${disp.prev.texture.id}|${disp.next.texture.id}|${disp.w.toFixed(5)}|${e.map((v) => v.toFixed(4)).join(',')}|${f[0].toFixed(4)},${f[5].toFixed(4)}|${center.x.toFixed(3)},${center.y.toFixed(3)},${center.z.toFixed(3)}|${JSON.stringify(p)}|${time.toFixed(2)}|${this.sim.version}`;
      if (key === this._key) return;
      this._key = key;
    } else this._key = '';
    const prevRT = r.getRenderTarget();
    const ac = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(this.accRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this.accScene, camera);
    r.autoClear = ac;
    r.setClearColor(0x000000, 1);
    r.setRenderTarget(prevRT);
  }

  dispose() {
    this.points.geometry.dispose(); this.material.dispose(); this.galaxies.geometry.dispose(); this.galMaterial.dispose(); this.compMat.dispose(); this.accRT?.dispose();
  }
}
