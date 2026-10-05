// CloudShared — resources and GLSL shared by the volumetric clouds, their
// shadows (in the Atmosphere pass) and the weather.
//
//   • Shape volume (128³ RGBA8, tileable): R = Perlin-Worley, GBA = Worley fBm
//     at 3 frequencies (Schneider/Nubis "Horizon Zero Dawn" layout).
//   • Detail volume (32³ RGB8, tileable): Worley fBm at 3 frequencies, erodes
//     edges into wisps (bottom) and billows (top).
//   • Weather cubemap (planet-wide): R = coverage, G = cloud type
//     (0 stratus … 0.5 cumulus … 1 cumulonimbus), B = wetness/precipitation.
//     Domain-warped fBm on the sphere with latitude bands (ITCZ, subtropical
//     highs, storm tracks) shaped by the world's weather.
//
// All baked on the GPU at init; nothing is downloaded.

import * as THREE from 'three';
import { makeFullscreen } from './AtmosphereModel.js';
import { NOISE_GLSL, HASH_GLSL } from '../../../core/glsl/noise.js';
import { FULLSCREEN_VERT } from '../../../core/glsl/common.js';

const TILE_NOISE_GLSL = /* glsl */ `
${HASH_GLSL}
float remap(float v, float a, float b, float c, float d){ return c + (v - a) / (b - a) * (d - c); }
vec3 ghash(vec3 c, float freq){ return normalize(hash33(mod(c, freq) + 0.123) * 2.0 - 1.0); }
float perlinT(vec3 p, float freq){
  vec3 q = p * freq; vec3 i = floor(q); vec3 f = fract(q);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(ghash(i, freq), f);
  float n100 = dot(ghash(i + vec3(1,0,0), freq), f - vec3(1,0,0));
  float n010 = dot(ghash(i + vec3(0,1,0), freq), f - vec3(0,1,0));
  float n110 = dot(ghash(i + vec3(1,1,0), freq), f - vec3(1,1,0));
  float n001 = dot(ghash(i + vec3(0,0,1), freq), f - vec3(0,0,1));
  float n101 = dot(ghash(i + vec3(1,0,1), freq), f - vec3(1,0,1));
  float n011 = dot(ghash(i + vec3(0,1,1), freq), f - vec3(0,1,1));
  float n111 = dot(ghash(i + vec3(1,1,1), freq), f - vec3(1,1,1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float perlinFbmT(vec3 p, float freq, int oct){
  float a = 1.0, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++) { if (i >= oct) break; n += a * perlinT(p, freq); s += a; a *= 0.5; freq *= 2.0; }
  return n / s;
}
float worleyT(vec3 p, float freq){
  vec3 q = p * freq; vec3 id = floor(q); vec3 f = fract(q);
  float md = 1e4;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 h = hash33(mod(id + o, freq) + 7.31);
    vec3 d = o + h - f;
    md = min(md, dot(d, d));
  }
  return 1.0 - sqrt(md);
}
float worleyFbmT(vec3 p, float freq){
  return worleyT(p, freq) * 0.625 + worleyT(p, freq * 2.0) * 0.25 + worleyT(p, freq * 4.0) * 0.125;
}`;

const SHAPE_FRAG = /* glsl */ `
${TILE_NOISE_GLSL}
uniform float uLayer, uSize;
uniform int uOct;
void main(){
  vec3 p = vec3(gl_FragCoord.xy, uLayer + 0.5) / uSize;
  // single-octave Worley at 4/8/16 cells; their weighted sum is the Worley fBm
  float w1 = worleyT(p, 4.0), w2 = worleyT(p, 8.0), w3 = worleyT(p, 16.0);
  float wf = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
  float pf = mix(1.0, perlinFbmT(p, 4.0, uOct) * 1.4, 0.5);
  pf = abs(pf * 2.0 - 1.0);
  float pw = remap(pf, 0.0, 1.0, wf, 1.0);
  gl_FragColor = vec4(clamp(pw, 0.0, 1.0), w1, w2, w3);
}`;

const DETAIL_FRAG = /* glsl */ `
${TILE_NOISE_GLSL}
uniform float uLayer, uSize;
void main(){
  vec3 p = vec3(gl_FragCoord.xy, uLayer + 0.5) / uSize;
  float a = worleyT(p, 2.0), b = worleyT(p, 4.0), c = worleyT(p, 8.0), d = worleyT(p, 16.0), e = worleyT(p, 32.0);
  gl_FragColor = vec4(a * 0.625 + b * 0.25 + c * 0.125, b * 0.625 + c * 0.25 + d * 0.125, c * 0.625 + d * 0.25 + e * 0.125, 1.0);
}`;

const WEATHER_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform int uFace; uniform float uSize;
uniform float uSeed, uCoverage, uType, uWet, uBands, uScale;
vec3 cubeFaceDir(int f, vec2 st){
  float sc = st.x * 2.0 - 1.0, tc = st.y * 2.0 - 1.0;
  if (f == 0) return normalize(vec3(1.0, -tc, -sc));
  if (f == 1) return normalize(vec3(-1.0, -tc, sc));
  if (f == 2) return normalize(vec3(sc, 1.0, tc));
  if (f == 3) return normalize(vec3(sc, -1.0, -tc));
  if (f == 4) return normalize(vec3(sc, -tc, 1.0));
  return normalize(vec3(-sc, -tc, -1.0));
}
void main(){
  vec3 d = cubeFaceDir(uFace, gl_FragCoord.xy / uSize);
  vec3 p = d * uScale + uSeed;
  // domain warp → swirls, fronts and cyclones
  vec3 w = vec3(fbm(p * 0.8 + 1.7, 3), fbm(p * 0.8 + 9.2, 3), fbm(p * 0.8 - 4.4, 3));
  vec3 q = p + w * 1.25;
  float big = fbm(q * 0.9, 4);
  float mid = fbm(q * 2.6 + 3.0, 4);
  float fine = fbm(q * 7.0 - 2.0, 3);
  float lat = d.y;
  // latitude climate: wet equator, dry subtropics, stormy mid-latitudes
  float climate = 0.55 * exp(-lat * lat / 0.012) - 0.45 * exp(-pow(abs(lat) - 0.45, 2.0) / 0.015) + 0.35 * exp(-pow(abs(lat) - 0.75, 2.0) / 0.02);
  float c = big * 0.85 + mid * 0.45 + fine * 0.18 + climate * uBands + (uCoverage - 0.5) * 1.6;
  float cov = smoothstep(-0.08, 0.55, c);
  // cell clusters: break the field into separate cumulus families
  float cells = smoothstep(-0.25, 0.45, mid * 0.8 + fine * 0.6 + 0.1);
  cov *= mix(1.0, cells, 0.55 * (1.0 - uWet));
  float type = clamp(uType + 0.35 * mid + 0.4 * max(c - 0.4, 0.0) + 0.2 * climate, 0.0, 1.0);
  float wet = clamp(uWet * smoothstep(0.35, 0.9, c) + 0.6 * max(c - 0.7, 0.0), 0.0, 1.0);
  gl_FragColor = vec4(cov, type, wet, 1.0);
}`;

/** GLSL for sampling clouds. Requires uniforms listed in CLOUD_UNIFORMS_GLSL. */
export const CLOUD_UNIFORMS_GLSL = /* glsl */ `
uniform highp sampler3D tCloudShape;
uniform highp sampler3D tCloudDetail;
uniform samplerCube tCloudWeather;
uniform mat3 uCloudRot;      // world → weather-map frame (slow drift)
uniform float uCloudBase, uCloudTop; // radii
uniform float uCloudCov;     // global coverage multiplier
uniform float uCloudDensity; // extinction per metre at density 1
uniform vec3 uCloudWind;     // noise-space offset (animated)
uniform float uCloudShapeScale, uCloudDetailScale;
`;

export const CLOUD_FUNCS_GLSL = /* glsl */ `
float cRemap(float v, float a, float b, float c, float d){ return c + (v - a) / max(b - a, 1e-4) * (d - c); }
vec3 cloudWeather(vec3 P){
  vec3 dir = normalize(P);
  vec3 w = textureCube(tCloudWeather, uCloudRot * dir).rgb;
  w.r = clamp(w.r * uCloudCov, 0.0, 1.0);
  return w;
}
float cloudHeightProfile(float h, float type){
  float bottom = smoothstep(0.0, mix(0.06, 0.12, type), h);
  float topH = mix(0.32, 1.0, type);
  float top = 1.0 - smoothstep(topH * 0.55, topH, h);
  return bottom * top;
}
// lod: 0 = full detail, 1 = shape only
float cloudDensityW(vec3 P, vec3 wx, float lod){
  float r = length(P);
  float h = (r - uCloudBase) / (uCloudTop - uCloudBase);
  if (h <= 0.0 || h >= 1.0 || wx.r < 0.02) return 0.0;
  float prof = cloudHeightProfile(h, wx.g);
  if (prof <= 0.0) return 0.0;
  vec3 q = P * uCloudShapeScale + uCloudWind;
  vec4 n = texture(tCloudShape, q);
  float wfbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float base = cRemap(n.r, wfbm - 1.0, 1.0, 0.0, 1.0);
  base *= prof;
  // anvil-ish spread at the top of tall clouds, rounded cumulus tops
  float cov = wx.r * mix(1.0, 1.0 + 0.6 * smoothstep(0.6, 1.0, h), wx.g);
  float c = cRemap(base, 1.0 - cov, 1.0, 0.0, 1.0) * cov;
  if (c <= 0.0) return 0.0;
  if (lod < 0.5) {
    vec3 dn = texture(tCloudDetail, P * uCloudDetailScale + uCloudWind * 3.1).rgb;
    float df = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    float dm = mix(df, 1.0 - df, clamp(h * 4.0, 0.0, 1.0));
    c = cRemap(c, dm * 0.38, 1.0, 0.0, 1.0);
  }
  // denser, darker bases where it rains
  return max(c, 0.0) * (1.0 + wx.b * 0.8) * smoothstep(0.0, 0.15, h + 0.05);
}
float cloudDensity(vec3 P, float lod){ return cloudDensityW(P, cloudWeather(P), lod); }
// Approximate shadow of the cloud layer on a point (sun at L).
float cloudShadow(vec3 P, vec3 L){
  float Rm = mix(uCloudBase, uCloudTop, 0.35);
  float b = dot(P, L);
  float c = dot(P, P) - Rm * Rm;
  float h = b * b - c;
  if (h < 0.0) return 1.0;
  float t = -b + sqrt(h);
  if (t <= 0.0) return 1.0;
  vec3 Q = P + L * t;
  vec3 wx = cloudWeather(Q);
  if (wx.r < 0.02) return 1.0;
  float d0 = cloudDensityW(Q, wx, 1.0);
  vec3 Q2 = P + L * (t + (uCloudTop - uCloudBase) * 0.35);
  float d1 = cloudDensityW(Q2, wx, 1.0);
  float od = (d0 + d1) * uCloudDensity * (uCloudTop - uCloudBase) * 0.45;
  return mix(1.0, exp(-od), 0.92);
}
`;

export class CloudResources {
  constructor(level) {
    this.level = level;
    this.engine = level.engine;
    const q = this.engine.quality;
    this.shapeSize = this.engine.shotMode ? 64 : q.pick(64, 96, 128, 128);
    this.perlinOct = this.engine.shotMode ? 4 : q.pick(4, 5, 6, 6);
    this.detailSize = 32;
    this.weatherSize = q.pick(128, 192, 256, 256);
    this.ready = false;
  }

  _bake3D(size, frag, format) {
    const rt = new THREE.WebGL3DRenderTarget(size, size, size, {
      format, type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, generateMipmaps: false,
    });
    const tex = rt.texture;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
    const mat = new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader: frag, depthTest: false, depthWrite: false, uniforms: { uLayer: { value: 0 }, uSize: { value: size }, uOct: { value: this.perlinOct } } });
    const fs = this._fs || (this._fs = makeFullscreen());
    const r = this.engine.renderer;
    const prev = r.getRenderTarget();
    for (let z = 0; z < size; z++) { mat.uniforms.uLayer.value = z; fs.render(r, mat, rt, z); }
    r.setRenderTarget(prev);
    mat.dispose();
    return rt;
  }

  init() {
    if (this.ready) return;
    this.shapeRT = this._bake3D(this.shapeSize, SHAPE_FRAG, THREE.RGBAFormat);
    this.detailRT = this._bake3D(this.detailSize, DETAIL_FRAG, THREE.RGBAFormat);
    this.weatherRT = new THREE.WebGLCubeRenderTarget(this.weatherSize, { type: THREE.UnsignedByteType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.weatherMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: WEATHER_FRAG, depthTest: false, depthWrite: false,
      uniforms: { uFace: { value: 0 }, uSize: { value: this.weatherSize }, uSeed: { value: 0 }, uCoverage: { value: 0.5 }, uType: { value: 0.4 }, uWet: { value: 0 }, uBands: { value: 0.6 }, uScale: { value: 2.2 } },
    });
    this.ready = true;
  }

  /** (Re)generate the planet-wide weather map. */
  bakeWeather({ seed = 0, coverage = 0.5, type = 0.4, wet = 0, bands = 0.6, scale = 2.2 }) {
    if (!this.ready) this.init();
    const u = this.weatherMat.uniforms;
    u.uSeed.value = seed; u.uCoverage.value = coverage; u.uType.value = type; u.uWet.value = wet; u.uBands.value = bands; u.uScale.value = scale;
    const r = this.engine.renderer;
    const prev = r.getRenderTarget();
    const fs = this._fs || (this._fs = makeFullscreen());
    for (let f = 0; f < 6; f++) { u.uFace.value = f; fs.render(r, this.weatherMat, this.weatherRT, f); }
    r.setRenderTarget(prev);
  }

  dispose() {
    this.shapeRT?.dispose(); this.detailRT?.dispose(); this.weatherRT?.dispose(); this.weatherMat?.dispose(); this._fs?.dispose();
  }
}
