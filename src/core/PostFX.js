// HDR post-processing pipeline — the "camera" of Reveries.
//
//   scene ─► sceneRT  (HalfFloat color + Float32 reversed depth, MSAA, TAA sub-pixel jitter)
//         ─► GTAO      (half-res horizon-based AO from depth, bilateral denoise, applied before effects)
//         ─► level effects (atmosphere, lensing, volumetrics …) ping-pong HDR
//         ─► TAA       (camera reprojection, dual-hypothesis history, variance clipping, Catmull-Rom)
//         ─► motion blur (optional, camera)      ─► depth of field (optional, gather bokeh)
//         ─► auto-exposure (log-luminance pyramid, eye adaptation, black-excluding metering)
//         ─► bloom     (13-tap Karis mip chain, wide energy-conserving PSF)
//         ─► lens      (anamorphic streaks, analytic aperture ghosts + halo for the dominant light)
//         ─► composite (exposure → optical vignette → AgX/ACES/Neutral → 3D LUT grade+look → grain)
//         ─► CAS sharpen (TAA tiers) | FXAA (low tiers) ─► screen
//
// Effect interface (levels pass an array to render()):
//   { enabled?: boolean, render(renderer, inputTexture, outputTarget, ctx) }
//   ctx = { depthTexture, camera, near, far, reversed (0|1), time, width, height,
//           projInv (Matrix4), viewInv (Matrix4), cameraPosition (Vector3), fullscreen,
//           frame, jitter (Vector2, NDC offset applied to this frame's projection) }
//   Use ctx.fullscreen(material, outputTarget) to draw a fullscreen triangle.
//
// Grade keys (levels set a partial grade; see DEFAULT_GRADE): exposure/tonemap/color
// controls, `look` (named film look, e.g. an aesthetic id) + lookStrength, autoExposure,
// bloom*, flare/streak, ao (0 = off, planet surfaces opt in), dof, motionBlur, sharpen, grain.
//
// URL debug: ?pfx=ao|exposure|flare|nolut|noaa|fxaa  ·  ?aa=fxaa forces FXAA.

import * as THREE from 'three';
import { FULLSCREEN_VERT, DEPTH_GLSL } from './glsl/common.js';

const DEFAULT_GRADE = {
  exposure: 1.0,
  toneMap: 'agx', // 'agx' | 'aces' | 'neutral'
  agxPunch: 0.5, // 0 = neutral AgX, 1 = punchy look
  contrast: 1.05,
  saturation: 1.05,
  temperature: 0.0, // -1 cool … +1 warm
  tint: 0.0, // -1 green … +1 magenta
  lift: [0, 0, 0], // shaped: lifts shadows but never pure black (OLED)
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  shadowsTint: [0, 0, 0], // split toning (added in shadows, never in pure black)
  highlightsTint: [0, 0, 0],
  blackPoint: 0.004, // crushes near-black to true black (OLED)
  blackToe: 0.016, // display values below this roll smoothly into pure black (bloom veil, scatter)
  look: 'filmic', // named look (LOOKS below; aesthetic ids map to their film looks)
  lookStrength: 1.0,
  vignette: 0.28,
  vignetteSoftness: 0.55,
  grain: 0.035,
  grainSize: 1.35, // px at 1080p
  chroma: 0.0012, // lateral chromatic aberration at the frame edges
  // auto exposure (eye adaptation)
  autoExposure: 0.0, // 0 = manual only (space levels, tuned by hand), 1 = fully metered; planets opt in
  aeKey: 0.16, // target mid-grey of the metered (non-black) scene
  aeMin: -2.5, aeMax: 0.5, // EV clamp of the automatic correction (dark scenes may only open up a little)
  purkinje: 0.6, // night vision: dim light shifts blue and desaturates (only with autoExposure > 0)
  aeDarkComp: 0.3, // fraction of the under-exposure that is compensated (night stays night)
  aeSpeedUp: 2.5, aeSpeedDown: 1.2, // adaptation rates (1/s) toward brighter / darker
  // bloom
  bloomStrength: 0.06,
  bloomRadius: 0.85, // 0 tight … 1 very wide soft halo
  bloomThreshold: 0.0, // 0 = energy conserving full-scene bloom
  bloomKnee: 0.5,
  bloomHighlights: 2.5, // extra (non energy-conserving) glow for exposed highlights: lit windows, lanterns, lava
  bloomHighlightStart: 2.0, // exposed luminance where highlight glow starts
  halation: 0.0, // warm film halation around highlights
  // lens
  flare: 0.5, // aperture ghosts + halo strength for the dominant bright source
  flareThreshold: 5.0, // exposed luminance above which light flares
  streak: 0.08, // anamorphic streak strength
  streakTint: [0.5, 0.68, 1.0],
  // ambient occlusion (world units; levels with walkable surfaces opt in)
  ao: 0.0, aoRadius: 1.6, aoPower: 1.4, aoDistance: 350,
  // camera
  sharpen: 0.35,
  motionBlur: 0.0, // shutter fraction (0 off … 1 = 360° shutter)
  motionBlurNear: 0.0, // pixels nearer than this (world units) are not blurred (third-person subject)
  dof: 0.0, // 0 off … 1 on
  dofFocus: 0.0, // focus distance (world units), 0 = autofocus at screen center
  dofAperture: 1.0, // CoC scale (bigger = shallower)
  dofMaxBlur: 14, // max CoC radius in px at 1080p
  taa: 1, // 0 disables TAA for this level (falls back to FXAA)
};

// ---------------------------------------------------------------------------
// Film looks: numeric parameter sets so looks interpolate smoothly between levels.
const LOOK_KEYS = ['tealOrange', 'bleach', 'mono', 'fadeToe', 'hlDesat', 'greenShift', 'redBoost', 'split', 'warmHi', 'coolLo', 'curve', 'skyDeep'];
const NEUTRAL_LOOK = { tealOrange: 0, bleach: 0, mono: 0, monoTint: [1, 1, 1], fadeToe: 0, hlDesat: 0.1, greenShift: 0, redBoost: 0, split: 0, splitLo: [0.0, 0.02, 0.05], splitHi: [0.05, 0.025, -0.02], warmHi: 0, coolLo: 0, curve: 0, skyDeep: 0 };
const L = (o) => ({ ...NEUTRAL_LOOK, ...o });
export const LOOKS = {
  neutral: L({}),
  filmic: L({ split: 0.5, curve: 0.25, hlDesat: 0.25 }),
  cosmic: L({ split: 0.5, splitLo: [0.0, 0.01, 0.04], splitHi: [0.04, 0.02, -0.01], curve: 0.2, hlDesat: 0.15, skyDeep: 0.3 }),
  blockbuster: L({ tealOrange: 0.5, split: 0.6, curve: 0.3 }),
  bleach: L({ bleach: 0.55, curve: 0.3, hlDesat: 0.3 }),
  noir: L({ mono: 0.85, monoTint: [0.95, 1.0, 1.06], bleach: 0.3, curve: 0.4 }),
  // per-aesthetic looks (ids from src/universe/Aesthetics.js)
  dune: L({ tealOrange: 0.3, mono: 0.3, monoTint: [1.12, 0.98, 0.82], hlDesat: 0.35, bleach: 0.12, warmHi: 0.4, curve: 0.25 }),
  ghibli: L({ fadeToe: 0.3, greenShift: -0.12, redBoost: 0.15, split: 0.35, splitLo: [-0.01, 0.01, 0.04], splitHi: [0.04, 0.03, 0.0], skyDeep: 0.35 }),
  moebius: L({ fadeToe: 0.45, hlDesat: 0.3, split: 0.5, splitLo: [0.02, 0.0, 0.04], splitHi: [0.04, 0.02, 0.0] }),
  kubrick: L({ bleach: 0.35, mono: 0.45, monoTint: [0.97, 1.0, 1.05], curve: 0.45 }),
  tarkovsky: L({ mono: 0.4, monoTint: [1.02, 1.04, 0.9], bleach: 0.25, greenShift: 0.18, fadeToe: 0.15, curve: 0.15 }),
  ueda: L({ bleach: 0.3, fadeToe: 0.3, hlDesat: 0.55, mono: 0.15, monoTint: [1.04, 1.02, 0.96] }),
  pandora: L({ greenShift: 0.12, redBoost: 0.1, split: 0.6, splitLo: [0.02, 0.0, 0.06], splitHi: [0.0, 0.04, 0.03], skyDeep: 0.3, curve: 0.2 }),
  bebop: L({ tealOrange: 0.5, redBoost: 0.2, split: 0.7, splitLo: [-0.02, 0.03, 0.05], splitHi: [0.06, 0.02, -0.03], curve: 0.35 }),
  erdtree: L({ tealOrange: 0.3, warmHi: 0.5, coolLo: 0.4, split: 0.5, splitLo: [-0.01, 0.025, 0.03], splitHi: [0.06, 0.04, -0.02], hlDesat: 0.2, curve: 0.3 }),
  wukong: L({ bleach: 0.15, greenShift: 0.15, warmHi: 0.3, coolLo: 0.3, split: 0.4, splitLo: [-0.01, 0.02, 0.03], splitHi: [0.05, 0.03, 0.0], curve: 0.3 }),
  interstellar: L({ bleach: 0.25, mono: 0.25, monoTint: [0.98, 1.0, 1.03], curve: 0.25, hlDesat: 0.3 }),
  rick: L({ redBoost: 0.2, greenShift: -0.2, split: 0.3, curve: 0.15 }),
  nausicaa: L({ greenShift: 0.25, fadeToe: 0.2, split: 0.4, splitLo: [0.0, 0.03, 0.03], splitHi: [0.05, 0.04, 0.0] }),
  frontier: L({ tealOrange: 0.2, hlDesat: 0.2, split: 0.3, curve: 0.15, skyDeep: 0.2 }),
  inferno: L({ tealOrange: 0.35, redBoost: 0.35, coolLo: 0.2, split: 0.6, splitLo: [0.04, 0.0, 0.01], splitHi: [0.06, 0.03, -0.03], curve: 0.4 }),
  glacier: L({ mono: 0.25, monoTint: [0.92, 1.0, 1.1], hlDesat: 0.35, split: 0.5, splitLo: [-0.01, 0.01, 0.05], splitHi: [0.02, 0.02, 0.02], skyDeep: 0.25 }),
};
function resolveLook(look) {
  if (look && typeof look === 'object') return { ...NEUTRAL_LOOK, ...look };
  return { ...(LOOKS[look] || LOOKS.neutral) };
}
function lerpLook(a, b, t, out) {
  for (const k of LOOK_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  for (const k of ['monoTint', 'splitLo', 'splitHi']) { out[k] = out[k] || [0, 0, 0]; for (let i = 0; i < 3; i++) out[k][i] = a[k][i] + (b[k][i] - a[k][i]) * t; }
  return out;
}

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
const U = (v) => ({ value: v });

const COMMON = /* glsl */ `
#define PI 3.14159265
#define HALF_PI 1.57079633
float lumOf(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float ignoise(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

// ---------------------------------------------------------------------------
// Bloom
const DOWN_FRAG = /* glsl */ `
uniform sampler2D tInput, tAE; uniform vec2 uTexel; uniform float uFirst; uniform float uThreshold; uniform float uKnee;
uniform float uHiBoost, uHiStart, uExposure;
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
    // Highlight glow: exposed highlights (windows, lanterns, lava, specular sun glints)
    // get an extra soft halo on top of the energy-conserving veil.
    if (uHiBoost > 0.0) {
      float le = dot(col, vec3(0.2126, 0.7152, 0.0722)) * uExposure * exp2(texture2D(tAE, vec2(0.5)).r);
      col *= 1.0 + uHiBoost * smoothstep(uHiStart, uHiStart * 5.0, le);
    }
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(min(max(col, 0.0), vec3(60000.0)), 1.0);
}`;

// Upsample-accumulate: up[i] = down[i] * w_i + tent(up[i+1]). Normalized in the composite,
// giving a long-tailed (~1/r^2) lens/eye PSF whose total energy equals bloomStrength.
const UP_FRAG = /* glsl */ `
uniform sampler2D tLow; uniform sampler2D tHigh; uniform vec2 uTexel; uniform float uWeight;
varying vec2 vUv;
void main(){
  vec2 t = uTexel;
  vec3 c = texture2D(tLow, vUv + vec2(-t.x, t.y)).rgb + texture2D(tLow, vUv + vec2(0.0, t.y)).rgb * 2.0 + texture2D(tLow, vUv + vec2(t.x, t.y)).rgb
         + texture2D(tLow, vUv + vec2(-t.x, 0.0)).rgb * 2.0 + texture2D(tLow, vUv).rgb * 4.0 + texture2D(tLow, vUv + vec2(t.x, 0.0)).rgb * 2.0
         + texture2D(tLow, vUv + vec2(-t.x, -t.y)).rgb + texture2D(tLow, vUv + vec2(0.0, -t.y)).rgb * 2.0 + texture2D(tLow, vUv + vec2(t.x, -t.y)).rgb;
  c /= 16.0;
  gl_FragColor = vec4(texture2D(tHigh, vUv).rgb * uWeight + c, 1.0);
}`;

// ---------------------------------------------------------------------------
// GTAO (Jimenez et al. 2016, structure after XeGTAO) — half resolution.
const AO_FRAG = /* glsl */ `
${COMMON}
${DEPTH_GLSL}
uniform sampler2D tDepth; uniform mat4 uProjInv; uniform vec2 uFullTexel; uniform float uReversed;
uniform float uRadius, uProjScale, uMaxPx, uFrame, uFadeEnd;
varying vec2 vUv;
vec3 vpos(vec2 uv){ return viewPosFromDepth(uv, texture2D(tDepth, uv).r, uProjInv, uReversed); }
float fastAcos(float x){ float ax = abs(x); float r = (-0.156583 * ax + HALF_PI) * sqrt(max(1.0 - ax, 0.0)); return x >= 0.0 ? r : PI - r; }
void main(){
  float d = texture2D(tDepth, vUv).r;
  if (isFarDepth(d, uReversed)) { gl_FragColor = vec4(1.0, 60000.0, 0.0, 1.0); return; }
  vec3 P = viewPosFromDepth(vUv, d, uProjInv, uReversed);
  float vz = -P.z;
  float radiusPx = uRadius * uProjScale / vz;
  if (vz > uFadeEnd || radiusPx < 1.5) { gl_FragColor = vec4(1.0, min(vz, 60000.0), 0.0, 1.0); return; }
  radiusPx = min(radiusPx, uMaxPx);
  // Edge-aware normal from depth: pick the smaller-difference neighbour per axis.
  vec2 tx = uFullTexel;
  vec3 Pr = vpos(vUv + vec2(tx.x, 0.0)), Pl = vpos(vUv - vec2(tx.x, 0.0));
  vec3 Pt = vpos(vUv + vec2(0.0, tx.y)), Pb = vpos(vUv - vec2(0.0, tx.y));
  vec3 dx = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? Pr - P : P - Pl;
  vec3 dy = abs(Pt.z - P.z) < abs(P.z - Pb.z) ? Pt - P : P - Pb;
  vec3 N = normalize(cross(dx, dy));
  vec3 V = normalize(-P);
  // Thickness-aware falloff (XeGTAO).
  float fRange = 0.615 * uRadius, fFrom = uRadius * (1.0 - 0.615);
  float fMul = -1.0 / fRange, fAdd = fFrom / fRange + 1.0;
  vec2 fc = gl_FragCoord.xy + vec2(uFrame * 5.588238, uFrame * 3.71);
  float n1 = ignoise(fc), n2 = fract(n1 * 1.61803 + hash12(fc * 0.37));
  float vis = 0.0;
  for (int s = 0; s < SLICES; s++) {
    float phi = (float(s) + n1) * PI / float(SLICES);
    vec2 omega = vec2(cos(phi), sin(phi));
    vec3 dirV = vec3(omega, 0.0);
    vec3 ortho = dirV - dot(dirV, V) * V;
    vec3 axis = normalize(cross(ortho, V));
    vec3 projN = N - axis * dot(N, axis);
    float projNLen = max(length(projN), 1e-4);
    float sgnN = sign(dot(ortho, projN));
    float cosN = clamp(dot(projN, V) / projNLen, 0.0, 1.0);
    float n = sgnN * fastAcos(cosN);
    float low0 = cos(n + HALF_PI), low1 = cos(n - HALF_PI);
    float hc0 = low0, hc1 = low1;
    for (int j = 0; j < STEPS; j++) {
      float t = (float(j) + n2) / float(STEPS);
      t = t * t;
      float sPx = max(t * radiusPx, float(j) + 1.0);
      vec2 off = omega * sPx * uFullTexel;
      vec3 d0 = vpos(vUv + off) - P, d1 = vpos(vUv - off) - P;
      float l0 = length(d0), l1 = length(d1);
      float sh0 = dot(d0, V) / max(l0, 1e-5), sh1 = dot(d1, V) / max(l1, 1e-5);
      float w0 = clamp(l0 * fMul + fAdd, 0.0, 1.0), w1 = clamp(l1 * fMul + fAdd, 0.0, 1.0);
      hc0 = max(hc0, mix(low0, sh0, w0));
      hc1 = max(hc1, mix(low1, sh1, w1));
    }
    float h0 = -fastAcos(clamp(hc1, -1.0, 1.0));
    float h1 = fastAcos(clamp(hc0, -1.0, 1.0));
    h0 = n + clamp(h0 - n, -HALF_PI, HALF_PI);
    h1 = n + clamp(h1 - n, -HALF_PI, HALF_PI);
    float sinN = sin(n);
    float ia0 = (cosN + 2.0 * h0 * sinN - cos(2.0 * h0 - n)) * 0.25;
    float ia1 = (cosN + 2.0 * h1 * sinN - cos(2.0 * h1 - n)) * 0.25;
    vis += projNLen * (ia0 + ia1);
  }
  vis = clamp(vis / float(SLICES), 0.0, 1.0);
  gl_FragColor = vec4(vis, vz, 0.0, 1.0);
}`;

const AO_BLUR_FRAG = /* glsl */ `
uniform sampler2D tAO; uniform vec2 uDir;
varying vec2 vUv;
void main(){
  vec2 c = texture2D(tAO, vUv).rg;
  float z = c.y, sum = c.x, ws = 1.0;
  float k = 1.0 / (z * 0.04 + 1e-3);
  for (int i = -3; i <= 3; i++) {
    if (i == 0) continue;
    vec2 s = texture2D(tAO, vUv + uDir * float(i)).rg;
    float w = exp(-0.18 * float(i * i)) * max(0.0, 1.0 - abs(s.y - z) * k);
    sum += s.x * w; ws += w;
  }
  gl_FragColor = vec4(sum / ws, z, 0.0, 1.0);
}`;

const AO_APPLY_FRAG = /* glsl */ `
${COMMON}
${DEPTH_GLSL}
uniform sampler2D tScene, tAO, tDepth; uniform vec2 uAORes; uniform float uReversed, uNear, uFar;
uniform float uIntensity, uPower, uFadeEnd, uDebug;
varying vec2 vUv;
void main(){
  vec4 col = texture2D(tScene, vUv);
  float d = texture2D(tDepth, vUv).r;
  if (isFarDepth(d, uReversed)) { gl_FragColor = uDebug > 0.5 ? vec4(1.0) : col; return; }
  float z = -depthToViewZ(d, uNear, uFar, uReversed);
  if (z > uFadeEnd) { gl_FragColor = uDebug > 0.5 ? vec4(1.0) : col; return; }
  // Joint-bilateral upsample of the half-res AO.
  vec2 hp = vUv * uAORes - 0.5; vec2 b = floor(hp); vec2 f = hp - b;
  float sum = 0.0, ws = 0.0;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec2 o = vec2(float(i), float(j));
    vec2 s = texture2D(tAO, (b + o + 0.5) / uAORes).rg;
    float bw = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
    float w = (bw + 1e-3) / (1e-3 + abs(s.y - z) / max(z, 1e-3) * 40.0);
    sum += s.x * w; ws += w;
  }
  float vis = ws > 0.0 ? sum / ws : 1.0;
  vis = pow(clamp(vis, 0.0, 1.0), uPower);
  // Multi-bounce (Jimenez 2016) with a mid albedo keeps lit surfaces from going grey.
  float a = 0.45; float A = 2.0404 * a - 0.3324, B = -4.7951 * a + 0.6417, C = 2.7552 * a + 0.6903;
  vis = max(vis, ((vis * A + B) * vis + C) * vis);
  float fade = 1.0 - smoothstep(uFadeEnd * 0.6, uFadeEnd, z);
  vis = mix(1.0, vis, uIntensity * fade);
  // Emissive surfaces (lit windows, lava) are not occluded.
  float emis = smoothstep(4.0, 24.0, lumOf(col.rgb));
  vis = mix(vis, 1.0, emis);
  gl_FragColor = uDebug > 0.5 ? vec4(vec3(vis), 1.0) : vec4(col.rgb * vis, col.a);
}`;

// ---------------------------------------------------------------------------
// Camera reprojection shared by TAA and motion blur. View-space (camera-relative)
// math only: planet coordinates are ~1e7 m, far beyond float32 world precision.
const REPROJECT_GLSL = /* glsl */ `
uniform mat4 uProjInvU; uniform mat4 uPrevProj; uniform mat4 uRel; uniform float uReversed;
vec2 reproject(vec2 uv, float d){
  vec3 vp = viewPosFromDepth(uv, d, uProjInvU, uReversed);
  vec4 pc = uPrevProj * (uRel * vec4(vp, 1.0));
  return pc.xy / max(pc.w, 1e-7) * 0.5 + 0.5;
}`;

const TAA_FRAG = /* glsl */ `
${COMMON}
${DEPTH_GLSL}
${REPROJECT_GLSL}
uniform sampler2D tCurrent, tHistory, tDepth; uniform vec2 uRes, uTexel; uniform float uReset, uMaxFrames;
varying vec2 vUv;
vec3 tm(vec3 c){ return c / (1.0 + lumOf(c)); }
vec3 itm(vec3 c){ return c / max(1.0 - lumOf(c), 1e-4); }
vec3 histCR(vec2 uv){
  vec2 sp = uv * uRes; vec2 t1 = floor(sp - 0.5) + 0.5; vec2 f = sp - t1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (t1 - 1.0) * uTexel, t3 = (t1 + 2.0) * uTexel, t12 = (t1 + w2 / w12) * uTexel;
  vec3 r = texture2D(tHistory, vec2(t12.x, t0.y)).rgb * (w12.x * w0.y)
         + texture2D(tHistory, vec2(t0.x, t12.y)).rgb * (w0.x * w12.y)
         + texture2D(tHistory, t12).rgb * (w12.x * w12.y)
         + texture2D(tHistory, vec2(t3.x, t12.y)).rgb * (w3.x * w12.y)
         + texture2D(tHistory, vec2(t12.x, t3.y)).rgb * (w12.x * w3.y);
  float wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / wsum, 0.0);
}
vec3 clipAABB(vec3 mn, vec3 mx, vec3 h, vec3 avg){
  vec3 c = 0.5 * (mx + mn), e = 0.5 * (mx - mn) + 1e-5;
  vec3 v = h - c; vec3 a = abs(v / e);
  float m = max(a.x, max(a.y, a.z));
  return m > 1.0 ? c + v / m : h;
}
void main(){
  vec3 cur = max(texture2D(tCurrent, vUv).rgb, 0.0);
  if (uReset > 0.5) { gl_FragColor = vec4(cur, 1.0); return; }
  // Neighbourhood statistics in a luminance-compressed space (stable on HDR fireflies).
  vec3 m1 = vec3(0.0), m2 = vec3(0.0), mn = vec3(1e9), mx = vec3(-1e9);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 s = tm(max(texture2D(tCurrent, vUv + vec2(float(i), float(j)) * uTexel).rgb, 0.0));
    m1 += s; m2 += s * s; mn = min(mn, s); mx = max(mx, s);
  }
  vec3 mu = m1 / 9.0; vec3 sig = sqrt(max(m2 / 9.0 - mu * mu, 0.0));
  float d = texture2D(tDepth, vUv).r;
  vec2 puv = reproject(vUv, d);
  vec2 velPx = (vUv - puv) * uRes;
  float speed = length(velPx);
  // Hypothesis A: camera-reprojected world history. B: screen-locked (third-person
  // subject, cockpit, things moving with the camera). Keep the one that fits better.
  vec4 hA = vec4(histCR(puv), texture2D(tHistory, puv).a);
  vec4 hB = texture2D(tHistory, vUv);
  vec3 tA = tm(hA.rgb), tB = tm(hB.rgb);
  vec3 sg = sig + 1e-3;
  float eA = length((tA - mu) / sg), eB = length((tB - mu) / sg);
  bool useB = speed > 0.75 && eB < eA * 0.7;
  vec4 h = useB ? hB : hA; vec3 th = useB ? tB : tA;
  bool off = !useB && (puv.x < 0.0 || puv.y < 0.0 || puv.x > 1.0 || puv.y > 1.0);
  float gam = mix(1.25, 0.9, clamp(speed / 12.0, 0.0, 1.0));
  vec3 bmn = max(mn, mu - gam * sig), bmx = min(mx, mu + gam * sig);
  th = clipAABB(bmn, bmx, th, mu);
  float n = off ? 0.0 : h.a;
  float blend = max(1.0 / (n + 1.0), 1.0 / uMaxFrames);
  blend = max(blend, mix(0.0, 0.25, clamp(speed / 24.0, 0.0, 1.0)));
  vec3 res = mix(th, tm(cur), blend);
  gl_FragColor = vec4(itm(res), min(n + 1.0, uMaxFrames));
}`;

const MBLUR_FRAG = /* glsl */ `
${COMMON}
${DEPTH_GLSL}
${REPROJECT_GLSL}
uniform sampler2D tInput, tDepth; uniform vec2 uRes, uTexel; uniform float uShutter, uMaxPx, uNearCut, uNear, uFar, uFrame;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tInput, vUv).rgb;
  float d = texture2D(tDepth, vUv).r;
  float z = -depthToViewZ(d, uNear, uFar, uReversed);
  if (!isFarDepth(d, uReversed) && z < uNearCut) { gl_FragColor = vec4(c, 1.0); return; }
  vec2 v = (vUv - reproject(vUv, d)) * uShutter;
  float lp = length(v * uRes);
  if (lp < 0.75) { gl_FragColor = vec4(c, 1.0); return; }
  v *= min(1.0, uMaxPx / lp);
  float jit = ignoise(gl_FragCoord.xy + uFrame * 7.0) - 0.5;
  vec3 acc = c; float ws = 1.0;
  for (int i = 0; i < 10; i++) {
    float t = (float(i) + 0.5 + jit) / 10.0 - 0.5;
    vec2 uv = vUv + v * t;
    float sd = texture2D(tDepth, uv).r;
    float sz = -depthToViewZ(sd, uNear, uFar, uReversed);
    // never smear the near subject over the background
    float w = (!isFarDepth(sd, uReversed) && sz < uNearCut) ? 0.0 : 1.0;
    acc += texture2D(tInput, uv).rgb * w; ws += w;
  }
  gl_FragColor = vec4(acc / ws, 1.0);
}`;

// ---------------------------------------------------------------------------
// Depth of field: half-res CoC, single-pass gather bokeh (Gustafsson), full-res merge.
const FOCUS_FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform sampler2D tDepth, tPrev; uniform float uReversed, uNear, uFar, uK, uManual;
varying vec2 vUv;
void main(){
  float z = 1e9;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    float d = texture2D(tDepth, vec2(0.5) + vec2(float(i), float(j)) * 0.02).r;
    if (!isFarDepth(d, uReversed)) z = min(z, -depthToViewZ(d, uNear, uFar, uReversed));
  }
  if (z > 1e8) z = uFar * 0.5;
  if (uManual > 0.0) z = uManual;
  float prev = texture2D(tPrev, vec2(0.5)).r;
  float lz = log(max(z, 1e-4));
  gl_FragColor = vec4(prev == 0.0 ? lz : mix(prev, lz, uK), 0.0, 0.0, 1.0);
}`;
const COC_GLSL = /* glsl */ `
float cocOf(float d){
  if (isFarDepth(d, uReversed)) return uMaxCoc;
  float z = -depthToViewZ(d, uNear, uFar, uReversed);
  float F = exp(texture2D(tFocus, vec2(0.5)).r);
  return clamp((z - F) / max(z, 1e-4) * uAperture, -1.0, 1.0) * uMaxCoc;
}`;
const DOF_COC_FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform sampler2D tInput, tDepth, tFocus; uniform float uReversed, uNear, uFar, uAperture, uMaxCoc;
varying vec2 vUv;
${COC_GLSL}
void main(){ gl_FragColor = vec4(texture2D(tInput, vUv).rgb, cocOf(texture2D(tDepth, vUv).r)); }`;
const DOF_GATHER_FRAG = /* glsl */ `
uniform sampler2D tCoc; uniform vec2 uTexel; uniform float uMaxCoc;
varying vec2 vUv;
const float GOLDEN = 2.39996323;
const float RAD = 1.1;
void main(){
  vec4 c0 = texture2D(tCoc, vUv);
  float cs = abs(c0.a);
  vec3 col = c0.rgb; float tot = 1.0; float r = RAD; float ang = 0.0;
  for (int i = 0; i < 96; i++) {
    if (r >= uMaxCoc) break;
    vec4 s = texture2D(tCoc, vUv + vec2(cos(ang), sin(ang)) * uTexel * r);
    float ss = abs(s.a);
    if (s.a > c0.a) ss = clamp(ss, 0.0, cs * 2.0);
    float m = smoothstep(r - 0.5, r + 0.5, ss);
    col += mix(col / tot, s.rgb, m); tot += 1.0;
    r += RAD / r; ang += GOLDEN;
  }
  gl_FragColor = vec4(col / tot, c0.a);
}`;
const DOF_MERGE_FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform sampler2D tInput, tBlur, tDepth, tFocus; uniform float uReversed, uNear, uFar, uAperture, uMaxCoc;
varying vec2 vUv;
${COC_GLSL}
void main(){
  vec3 sharp = texture2D(tInput, vUv).rgb;
  vec4 b = texture2D(tBlur, vUv);
  float coc = abs(cocOf(texture2D(tDepth, vUv).r));
  float t = smoothstep(0.35, 1.25, max(coc, abs(b.a) * step(b.a, 0.0)));
  gl_FragColor = vec4(mix(sharp, b.rgb, t), 1.0);
}`;

// ---------------------------------------------------------------------------
// Auto exposure: black-excluding, centre-weighted log-luminance pyramid.
const LUM_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tInput; uniform vec2 uCell;
varying vec2 vUv;
void main(){
  float sl = 0.0, sw = 0.0;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec2 uv = vUv + (vec2(float(i), float(j)) - 0.5) * uCell * 0.5;
    float l = lumOf(texture2D(tInput, uv).rgb);
    if (l > 2e-4) {
      l = min(max(l, 2e-3), 40.0);
      vec2 dc = (uv - 0.5) * vec2(1.6, 1.0);
      float w = 1.0 - 0.6 * smoothstep(0.1, 0.7, length(dc));
      sl += log2(min(l, 6e4)) * w; sw += w;
    }
  }
  gl_FragColor = vec4(sl * 0.25, sw * 0.25, 0.0, 1.0);
}`;
const REDUCE_FRAG = /* glsl */ `
uniform sampler2D tInput; uniform vec2 uSrcTexel;
varying vec2 vUv;
void main(){
  vec4 a = vec4(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++)
    a += texture2D(tInput, vUv + (vec2(float(i), float(j)) - 1.5) * uSrcTexel);
  gl_FragColor = a / 16.0;
}`;
const ADAPT_FRAG = /* glsl */ `
uniform sampler2D tLum, tPrev; uniform float uKey, uAmount, uMin, uMax, uUp, uDown, uDt, uInstant, uDarkComp;
varying vec2 vUv;
void main(){
  vec2 s = texture2D(tLum, vec2(0.5)).rg;
  float prev = texture2D(tPrev, vec2(0.5)).r;
  float target = prev;
  if (s.y > 1e-5) {
    float avgLog = s.x / s.y;
    float delta = log2(uKey) - avgLog;
    if (delta > 0.0) delta *= uDarkComp; // eyes adapt to the dark only partially
    target = clamp(uAmount * delta, uMin, uMax);
  } else if (uInstant > 0.5) target = 0.0;
  float rate = target > prev ? uUp : uDown;
  float ev = uInstant > 0.5 ? target : prev + (target - prev) * (1.0 - exp(-uDt * rate));
  gl_FragColor = vec4(ev, s.x / max(s.y, 1e-6), s.y, 1.0);
}`;

// ---------------------------------------------------------------------------
// Lens: bright pass (exposed), anamorphic streak, dominant-source centroid.
const BRIGHT_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tInput, tAE; uniform vec2 uSrcTexel; uniform float uExposure, uThreshold;
varying vec2 vUv;
void main(){
  // 4x2 box (two bilinear taps) — energy preserving, small suns survive.
  vec3 c = 0.5 * (texture2D(tInput, vUv + vec2(-uSrcTexel.x, 0.0)).rgb + texture2D(tInput, vUv + vec2(uSrcTexel.x, 0.0)).rgb);
  c *= uExposure * exp2(texture2D(tAE, vec2(0.5)).r);
  float l = lumOf(c);
  float knee = uThreshold * 0.5;
  float x = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  float e = max(x * x / (4.0 * knee + 1e-4), l - uThreshold);
  vec3 b = c * (max(e, 0.0) / max(l, 1e-4));
  // Soft-limit: a sun 1000x over threshold must not streak 1000x longer (restraint).
  b *= 16.0 / (16.0 + lumOf(b));
  gl_FragColor = vec4(b, 1.0);
}`;
const STREAK_FRAG = /* glsl */ `
uniform sampler2D tInput; uniform sampler2D tA; uniform sampler2D tB; uniform vec2 uStep; uniform float uFinal;
varying vec2 vUv;
void main(){
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (int i = -4; i <= 4; i++) {
    float w = exp(-abs(float(i)) * 0.8);
    acc += texture2D(tInput, vUv + uStep * float(i)).rgb * w; ws += w;
  }
  acc /= ws;
  if (uFinal > 0.5) acc = acc * 0.07 + texture2D(tB, vUv).rgb * 0.28 + texture2D(tA, vUv).rgb * 0.65;
  gl_FragColor = vec4(acc, 1.0);
}`;
const CENTROID_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tInput; uniform vec2 uSrcTexel; uniform vec2 uTiles;
varying vec2 vUv;
void main(){
  // Each tile integrates a 16x32 block of the bright buffer with 8x16 bilinear taps.
  vec2 base = (floor(vUv * uTiles) / uTiles);
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 16; j++) for (int i = 0; i < 8; i++) {
    vec2 uv = base + (vec2(float(i), float(j)) * 2.0 + 1.0) * uSrcTexel;
    if (uv.x > 1.0 || uv.y > 1.0) continue;
    float w = lumOf(texture2D(tInput, uv).rgb);
    acc += vec4(uv * w, w, dot(uv - 0.5, uv - 0.5) * w);
  }
  gl_FragColor = acc / 128.0;
}`;
const CENTROID2_FRAG = /* glsl */ `
uniform sampler2D tInput; uniform vec2 uTiles;
varying vec2 vUv;
void main(){
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 128; j++) { if (float(j) >= uTiles.y) break;
    for (int i = 0; i < 128; i++) { if (float(i) >= uTiles.x) break;
      acc += texture2D(tInput, (vec2(float(i), float(j)) + 0.5) / uTiles); } }
  acc /= uTiles.x * uTiles.y;
  vec2 c = acc.w > 0.0 ? acc.xy / max(acc.z, 1e-12) : vec2(0.5);
  float spread = acc.z > 0.0 ? sqrt(max(acc.w / acc.z - dot(c - 0.5, c - 0.5), 0.0)) : 1.0;
  gl_FragColor = vec4(c, acc.z, spread);
}`;

// ---------------------------------------------------------------------------
// Grade baked into a 32^3 LUT (unwrapped 1024x32), sampled in display space.
const LUT_FRAG = /* glsl */ `
${COMMON}
uniform float uContrast, uSaturation, uTemperature, uTint, uBlackPoint;
uniform vec3 uLift, uGamma, uGain, uShadowsTint, uHighlightsTint;
uniform float uLookAmt, uTealOrange, uBleach, uMono, uFadeToe, uHlDesat, uGreenShift, uRedBoost, uSplit, uWarmHi, uCoolLo, uCurve, uSkyDeep;
uniform vec3 uMonoTint, uSplitLo, uSplitHi;
varying vec2 vUv;
vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y); float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c){ vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0); return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y); }
float hueBell(float h, float center, float width){ float d = abs(fract(h - center + 0.5) - 0.5); return 1.0 - smoothstep(0.0, width, d); }
float hueToward(float h, float target, float amt){ float d = fract(target - h + 0.5) - 0.5; return fract(h + d * amt); }
// S-curve with fixed endpoints (0 stays 0: OLED black is sacred).
float sCurve(float x, float c, float p){ return x < p ? p * pow(x / p, c) : 1.0 - (1.0 - p) * pow((1.0 - x) / (1.0 - p), c); }
vec3 sCurve3(vec3 x, float c, float p){ return vec3(sCurve(x.r, c, p), sCurve(x.g, c, p), sCurve(x.b, c, p)); }
vec3 look(vec3 c){
  float l = lumOf(c);
  vec3 hsv = rgb2hsv(c);
  // teal & orange: warm hues gather toward amber, cool hues toward teal
  float to = uTealOrange;
  float warm = hueBell(hsv.x, 0.07, 0.12), cool = hueBell(hsv.x, 0.52, 0.16);
  hsv.x = hueToward(hsv.x, 0.075, to * 0.5 * warm);
  hsv.x = hueToward(hsv.x, 0.5, to * 0.45 * cool);
  hsv.y *= 1.0 + to * 0.25 * (warm + cool);
  // green shift (- toward yellow-lime, + toward jade/teal)
  float green = hueBell(hsv.x, 0.30, 0.13);
  hsv.x = fract(hsv.x + uGreenShift * 0.07 * green);
  // red/orange richness (print film)
  hsv.y *= 1.0 + uRedBoost * hueBell(hsv.x, 0.02, 0.09);
  // deepen sky blues (polariser look)
  float blue = hueBell(hsv.x, 0.6, 0.1);
  hsv.y *= 1.0 + uSkyDeep * 0.3 * blue;
  hsv.z *= 1.0 - uSkyDeep * 0.12 * blue * hsv.y;
  c = hsv2rgb(hsv);
  // split toning (shaped so pure black and pure white stay neutral)
  float sh = smoothstep(0.0, 0.08, l) * (1.0 - smoothstep(0.05, 0.5, l));
  float hi = smoothstep(0.45, 0.95, l) * (1.0 - smoothstep(0.97, 1.0, l));
  c += uSplit * (uSplitLo * sh + uSplitHi * hi);
  c = mix(c, c * vec3(1.06, 1.0, 0.9), uWarmHi * smoothstep(0.4, 0.9, l));
  c = mix(c, c * vec3(0.92, 1.0, 1.08), uCoolLo * (1.0 - smoothstep(0.05, 0.4, l)));
  // bleach bypass: silver retention overlay
  float lb = lumOf(c);
  vec3 ov = mix(2.0 * c * lb, 1.0 - 2.0 * (1.0 - c) * (1.0 - lb), step(0.5, lb));
  c = mix(c, mix(vec3(lb), ov, 0.55), uBleach);
  // tinted monochrome
  c = mix(c, vec3(lumOf(c)) * uMonoTint, uMono);
  // highlight desaturation (film shoulder)
  float lh = lumOf(c);
  c = mix(c, vec3(lh), uHlDesat * smoothstep(0.55, 1.0, lh));
  // fade toe: lifts deep shadows softly, pure black stays black
  c = mix(c, pow(max(c, 0.0), vec3(0.82)), uFadeToe * (1.0 - smoothstep(0.0, 0.6, lumOf(c))));
  // print contrast
  c = sCurve3(clamp(c, 0.0, 1.0), 1.0 + uCurve * 0.35, 0.42);
  return c;
}
void main(){
  vec2 fc = floor(gl_FragCoord.xy);
  vec3 c = vec3(mod(fc.x, 32.0), fc.y, floor(fc.x / 32.0)) / 31.0;
  vec3 x0 = c;
  // white balance in linear light (luminance-preserving)
  vec3 lin = pow(c, vec3(2.2));
  vec3 wb = vec3(1.0 + uTemperature * 0.22 + uTint * 0.08, 1.0 - uTint * 0.16, 1.0 - uTemperature * 0.26 + uTint * 0.08);
  wb /= lumOf(wb);
  lin *= wb;
  c = pow(max(lin, 0.0), vec3(1.0 / 2.2));
  // look
  c = mix(c, look(clamp(c, 0.0, 1.0)), uLookAmt);
  // lift / gamma / gain (lift shaped: shadows open up, black stays black)
  float shape = smoothstep(0.0, 0.1, max(c.r, max(c.g, c.b)));
  c = c * uGain + uLift * (1.0 - c) * shape;
  c = pow(max(c, 0.0), 1.0 / max(uGamma, vec3(0.01)));
  float l = lumOf(c);
  c += uShadowsTint * smoothstep(0.0, 0.06, l) * (1.0 - smoothstep(0.0, 0.45, l)) + uHighlightsTint * smoothstep(0.55, 1.0, l);
  c = sCurve3(clamp(c, 0.0, 1.0), uContrast, 0.45);
  l = lumOf(c);
  c = mix(vec3(l), c, uSaturation);
  if (max(x0.r, max(x0.g, x0.b)) <= 0.0) c = vec3(0.0);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// ---------------------------------------------------------------------------
const COMPOSITE_FRAG = /* glsl */ `
${COMMON}
${DEPTH_GLSL}
uniform sampler2D tScene, tBloom, tAE, tStreak, tFlare, tLUT, tDepth; uniform float uReversed;
uniform vec2 uResolution; uniform float uTime, uFrameSeed;
uniform float uExposure, uToneMap, uAgxPunch;
uniform float uVignette, uVignetteSoft, uGrain, uGrainSize, uChroma, uBloomStrength, uBloomNorm, uHalation;
uniform float uStreak, uFlare; uniform vec3 uStreakTint; uniform float uUseLUT, uUseStreak, uUseFlare;
uniform float uWarp, uFade; uniform vec3 uFadeColor;
uniform float uDebug, uPurkinje, uBlackPoint, uBlackToe;
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
vec3 pbrNeutral(vec3 c){
  const float startC = 0.8 - 0.04, desat = 0.15;
  float x = min(c.r, min(c.g, c.b)); float off = x < 0.08 ? x - 6.25 * x * x : 0.04; c -= off;
  float peak = max(c.r, max(c.g, c.b));
  if (peak >= startC) { float d = 1.0 - startC; float np = 1.0 - d * d / (peak + d - startC); c *= np / peak;
    float g = 1.0 - 1.0 / (desat * (peak - np) + 1.0); c = mix(c, vec3(np), g); }
  return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
}
vec3 applyLUT(vec3 c){
  c = clamp(c, 0.0, 1.0) * 31.0;
  float bz = floor(c.b); float f = c.b - bz;
  vec2 uv = vec2((c.r + 0.5 + bz * 32.0) / 1024.0, (c.g + 0.5) / 32.0);
  vec3 a = texture2D(tLUT, uv).rgb;
  vec3 b = texture2D(tLUT, uv + vec2(32.0 / 1024.0, 0.0)).rgb;
  return mix(a, b, f);
}
float gFar = 0.0; // 1 where nothing was rendered (sky / space): no CA on point stars
vec3 sampleScene(vec2 uv){
  vec2 d = uv - 0.5;
  float r2 = dot(d, d);
  vec2 off = d * max(r2 - 0.03, 0.0) * uChroma * 3.0 * (1.0 - gFar);
  vec3 c;
  c.r = texture2D(tScene, uv - off).r;
  c.g = texture2D(tScene, uv).g;
  c.b = texture2D(tScene, uv + off).b;
  return c;
}
float gnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1, 0)), c = hash12(i + vec2(0, 1)), d = hash12(i + vec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// Aperture-shaped ghost: rounded hexagon with a brighter rim, slight dispersion.
float ghostShape(vec2 p, float r){
  vec2 q = abs(p) / r;
  float hex = max(q.x * 0.866025 + q.y * 0.5, q.y);
  float dd = mix(length(p) / r, hex, 0.55);
  return smoothstep(1.0, 0.9, dd) * (0.55 + 0.45 * smoothstep(0.55, 0.98, dd));
}
vec3 lensGhosts(vec2 uv, vec4 F, float aspect){
  vec2 src = F.xy;
  float I = F.z;
  if (I <= 1e-7) return vec3(0.0);
  float concentrated = 1.0 - smoothstep(0.04, 0.16, F.w);
  float energy = min(sqrt(I) * 0.8, 0.3) * concentrated; // I comes from the soft-limited bright pass; capped (restraint)
  if (energy < 1e-4) return vec3(0.0);
  vec2 axis = src - 0.5;
  // fade as the source leaves the frame
  float inFrame = smoothstep(0.75, 0.45, max(abs(axis.x), abs(axis.y)));
  vec3 acc = vec3(0.0);
  vec2 a2 = vec2(aspect, 1.0);
  const int NG = 7;
  float sc[7]; float rr[7]; vec3 tn[7]; float it[7];
  sc[0] = -0.42; rr[0] = 0.040; tn[0] = vec3(1.0, 0.62, 0.30); it[0] = 0.60;
  sc[1] = -0.16; rr[1] = 0.018; tn[1] = vec3(0.45, 0.95, 0.75); it[1] = 0.80;
  sc[2] =  0.24; rr[2] = 0.030; tn[2] = vec3(0.55, 0.65, 1.00); it[2] = 0.50;
  sc[3] =  0.55; rr[3] = 0.085; tn[3] = vec3(0.60, 1.00, 0.70); it[3] = 0.22;
  sc[4] = -0.85; rr[4] = 0.120; tn[4] = vec3(0.85, 0.55, 1.00); it[4] = 0.14;
  sc[5] =  1.35; rr[5] = 0.060; tn[5] = vec3(1.00, 0.75, 0.40); it[5] = 0.30;
  sc[6] = -1.60; rr[6] = 0.200; tn[6] = vec3(0.40, 0.70, 1.00); it[6] = 0.07;
  for (int i = 0; i < NG; i++) {
    vec2 gc = 0.5 + axis * sc[i];
    vec2 p = (uv - gc) * a2;
    float r = rr[i] * (1.0 + 0.6 * length(axis));
    vec3 g;
    g.r = ghostShape(p, r * 1.025);
    g.g = ghostShape(p, r);
    g.b = ghostShape(p, r * 0.975);
    acc += g * tn[i] * it[i];
  }
  // halo ring around the frame centre, lit on the source side
  vec2 pc = (uv - 0.5) * a2;
  float rl = length(pc);
  vec2 sd = normalize(axis * a2 + 1e-5);
  float side = pow(max(dot(pc / max(rl, 1e-4), sd), 0.0), 6.0);
  vec3 halo;
  halo.r = exp(-pow((rl - 0.47) / 0.022, 2.0));
  halo.g = exp(-pow((rl - 0.455) / 0.022, 2.0));
  halo.b = exp(-pow((rl - 0.44) / 0.022, 2.0));
  acc += halo * side * 0.10 * smoothstep(0.05, 0.35, length(axis * a2));
  // soft veiling glare around the source (lens-internal scatter)
  float ds = length((uv - src) * a2);
  acc += vec3(1.0, 0.92, 0.82) * 0.08 * exp(-ds * 9.0);
  return acc * energy * inFrame;
}

void main(){
  vec2 uv = vUv;
  gFar = isFarDepth(texture2D(tDepth, uv).r, uReversed) ? 1.0 : 0.0;
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
  vec3 bloom = texture2D(tBloom, uv).rgb * uBloomNorm;
  col = mix(col, bloom, uBloomStrength);
  col += bloom * uHalation * vec3(1.0, 0.35, 0.12) * 0.25;
  float ae = exp2(texture2D(tAE, vec2(0.5)).r);
  col *= uExposure * ae;
  if (uPurkinje > 0.0) {
    // Purkinje shift: as exposed light falls toward scotopic levels, rods take over —
    // colour drains and what remains leans moonlit blue. Multiplicative: black stays black.
    float lp = lumOf(col);
    float rod = uPurkinje * (1.0 - smoothstep(0.004, 0.09, lp));
    col = mix(col, vec3(lp) * vec3(0.72, 0.92, 1.38), rod * 0.8);
  }
  float aspect = uResolution.x / uResolution.y;
  if (uUseStreak > 0.5) {
    // Anamorphic streaks belong to point-like sources (sun disc, lamps), not to broad glare.
    float conc = uUseFlare > 0.5 ? 0.3 + 0.7 * (1.0 - smoothstep(0.05, 0.2, texture2D(tFlare, vec2(0.5)).w)) : 1.0;
    col += texture2D(tStreak, uv).rgb * uStreak * uStreakTint * conc;
  }
  if (uUseFlare > 0.5) col += lensGhosts(uv, texture2D(tFlare, vec2(0.5)), aspect) * uFlare;
  // optical vignette (in light, before the tone curve)
  vec2 vd = (uv - 0.5) * vec2(aspect, 1.0);
  float vig = smoothstep(0.85, 0.85 - uVignetteSoft, length(vd) * (1.0 + uVignette * 0.6));
  col *= mix(1.0 - uVignette, 1.0, vig);

  col = uToneMap < 0.5 ? agx(col) : (uToneMap < 1.5 ? acesFitted(col) : pbrNeutral(col));
  if (uUseLUT > 0.5) col = applyLUT(col);
  // Black point after the LUT (a 32^3 LUT cannot resolve the first few code values):
  // the faint veil of bloom/scatter over space collapses to true OLED black.
  col = max(col - uBlackPoint, 0.0) / (1.0 - uBlackPoint);
  // OLED toe: the last few code values (bloom veil tails, scatter) roll smoothly into
  // true black instead of a dim grey haze; hue is preserved.
  if (uBlackToe > 0.0) col *= smoothstep(0.0, uBlackToe, max(col.r, max(col.g, col.b)));

  // Film grain: two-octave, resolution independent, strongest in the midtones,
  // multiplicative so OLED black stays exactly black.
  vec2 gp = gl_FragCoord.xy / (uGrainSize * max(uResolution.y / 1080.0, 0.5));
  vec2 go = vec2(fract(uFrameSeed * 0.6180339) * 431.0, fract(uFrameSeed * 0.7548776) * 377.0);
  float gn = gnoise(gp + go) * 0.65 + gnoise(gp * 2.17 + go.yx) * 0.35 - 0.5;
  float lg = lumOf(col);
  col *= 1.0 + gn * uGrain * 2.6 * (1.0 - lg) * smoothstep(0.02, 0.25, lg) * (1.0 - 0.75 * gFar);
  // Fade (level transitions)
  col = mix(col, uFadeColor, uFade);
  // Dither to kill banding in gradients (never lifts black).
  col += (hash12(gl_FragCoord.xy + fract(uFrameSeed * 0.31) * 97.0) - 0.5) / 255.0 * smoothstep(0.0, 3.0 / 255.0, lg);
  if (uDebug > 0.5) {
    if (uDebug < 1.5) col = vec3(ae / 8.0, texture2D(tAE, vec2(0.5)).g * 0.05 + 0.5, 0.0); // exposure
    else col = texture2D(tStreak, uv).rgb + lensGhosts(uv, texture2D(tFlare, vec2(0.5)), aspect); // flare
  }
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

// AMD FidelityFX Contrast Adaptive Sharpening (LDR).
const CAS_FRAG = /* glsl */ `
uniform sampler2D tInput; uniform vec2 uTexel; uniform float uSharp; varying vec2 vUv;
void main(){
  vec3 b = texture2D(tInput, vUv + vec2(0.0, uTexel.y)).rgb;
  vec3 d = texture2D(tInput, vUv - vec2(uTexel.x, 0.0)).rgb;
  vec3 e = texture2D(tInput, vUv).rgb;
  vec3 f = texture2D(tInput, vUv + vec2(uTexel.x, 0.0)).rgb;
  vec3 h = texture2D(tInput, vUv - vec2(0.0, uTexel.y)).rgb;
  vec3 mn = min(e, min(min(b, d), min(f, h)));
  vec3 mx = max(e, max(max(b, d), max(f, h)));
  vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0));
  vec3 w = -amp / mix(8.0, 5.0, uSharp);
  vec3 o = (e + (b + d + f + h) * w) / (1.0 + 4.0 * w);
  gl_FragColor = vec4(clamp(o, 0.0, 1.0), 1.0);
}`;

const HALTON = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
const JITTER = Array.from({ length: 16 }, (_, i) => [HALTON(i + 1, 2) - 0.5, HALTON(i + 1, 3) - 0.5]);

export class PostFX {
  constructor(renderer, quality) {
    this.renderer = renderer;
    this.quality = quality;
    this.fs = new Fullscreen();
    this.grade = { ...DEFAULT_GRADE };
    this._gradeFrom = null; this._gradeTo = null; this._gradeT = 1; this._gradeDur = 1;
    this._look = resolveLook(this.grade.look); this._lookFrom = null; this._lookTo = null;
    this.transition = { warp: 0, fade: 0, color: new THREE.Color(0, 0, 0) };
    const q = quality.level;
    this.bloomLevels = quality.pick(6, 7, 8, 8);
    this.enabled = true;
    this.reversed = renderer.state.buffers.depth.getReversed ? (renderer.state.buffers.depth.getReversed() ? 1 : 0) : 0;
    this.width = 1; this.height = 1;
    this.frame = 0;

    const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    this.shotMode = params.has('shot');
    const dbg = params.get('pfx') || '';
    this.debug = dbg;
    // Feature tiers (low/medium keep the cheap passes only).
    this.settings = {
      taa: q >= 2 && params.get('aa') !== 'fxaa' && dbg !== 'noaa' && dbg !== 'fxaa',
      ao: q >= 2 && dbg !== 'noao', // GTAO: high/ultra only (phones run low/medium)
      aoSlices: quality.pick(1, 1, 2, 3), aoSteps: quality.pick(4, 4, 6, 8),
      flare: q >= 1, streak: q >= 1,
      motionBlur: q >= 2, dof: q >= 1, dofHalf: true,
      sharpen: q >= 2,
      lut: dbg !== 'nolut',
    };

    this._projInv = new THREE.Matrix4();
    this._jitter = new THREE.Vector2();
    this._ctx = {
      depthTexture: null, camera: null, near: 0.1, far: 1000, reversed: this.reversed, time: 0,
      width: 1, height: 1, projInv: this._projInv, viewInv: new THREE.Matrix4(), cameraPosition: new THREE.Vector3(),
      fullscreen: (material, target) => this.fs.render(this.renderer, material, target),
      frame: 0, jitter: this._jitter,
    };
    // camera history
    this._prevCam = null;
    this._prevView = new THREE.Matrix4();
    this._prevProj = new THREE.Matrix4();
    this._projU = new THREE.Matrix4();
    this._projInvU = new THREE.Matrix4();
    this._rel = new THREE.Matrix4();
    this._tmpM = new THREE.Matrix4();
    this._savedProj = new THREE.Matrix4();
    this._savedProjInv = new THREE.Matrix4();
    this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._historyValid = false;
    this._aeValid = false;
    this._focusValid = false;

    const R = this.reversed;
    this.downMat = mat(DOWN_FRAG, { tInput: U(null), tAE: U(null), uTexel: U(new THREE.Vector2()), uFirst: U(0), uThreshold: U(0), uKnee: U(0.5), uHiBoost: U(0), uHiStart: U(2), uExposure: U(1) });
    this.upMat = mat(UP_FRAG, { tLow: U(null), tHigh: U(null), uTexel: U(new THREE.Vector2()), uWeight: U(1) });
    const aoDefs = { SLICES: this.settings.aoSlices, STEPS: this.settings.aoSteps };
    this.aoMat = mat(AO_FRAG, { tDepth: U(null), uProjInv: U(new THREE.Matrix4()), uFullTexel: U(new THREE.Vector2()), uReversed: U(R), uRadius: U(1), uProjScale: U(1), uMaxPx: U(64), uFrame: U(0), uFadeEnd: U(300) }, aoDefs);
    this.aoBlurMat = mat(AO_BLUR_FRAG, { tAO: U(null), uDir: U(new THREE.Vector2()) });
    this.aoApplyMat = mat(AO_APPLY_FRAG, { tScene: U(null), tAO: U(null), tDepth: U(null), uAORes: U(new THREE.Vector2()), uReversed: U(R), uNear: U(0.1), uFar: U(1000), uIntensity: U(1), uPower: U(1.4), uFadeEnd: U(300), uDebug: U(0) });
    const reproU = () => ({ uProjInvU: U(new THREE.Matrix4()), uPrevProj: U(new THREE.Matrix4()), uRel: U(new THREE.Matrix4()), uReversed: U(R) });
    this.taaMat = mat(TAA_FRAG, { tCurrent: U(null), tHistory: U(null), tDepth: U(null), uRes: U(new THREE.Vector2()), uTexel: U(new THREE.Vector2()), uReset: U(1), uMaxFrames: U(12), ...reproU() });
    this.mbMat = mat(MBLUR_FRAG, { tInput: U(null), tDepth: U(null), uRes: U(new THREE.Vector2()), uTexel: U(new THREE.Vector2()), uShutter: U(0.5), uMaxPx: U(40), uNearCut: U(0), uNear: U(0.1), uFar: U(1000), uFrame: U(0), ...reproU() });
    const dofU = () => ({ tDepth: U(null), tFocus: U(null), uReversed: U(R), uNear: U(0.1), uFar: U(1000), uAperture: U(1), uMaxCoc: U(8) });
    this.focusMat = mat(FOCUS_FRAG, { tDepth: U(null), tPrev: U(null), uReversed: U(R), uNear: U(0.1), uFar: U(1000), uK: U(1), uManual: U(0) });
    this.cocMat = mat(DOF_COC_FRAG, { tInput: U(null), ...dofU() });
    this.gatherMat = mat(DOF_GATHER_FRAG, { tCoc: U(null), uTexel: U(new THREE.Vector2()), uMaxCoc: U(8) });
    this.mergeMat = mat(DOF_MERGE_FRAG, { tInput: U(null), tBlur: U(null), ...dofU() });
    this.lumMat = mat(LUM_FRAG, { tInput: U(null), uCell: U(new THREE.Vector2()) });
    this.reduceMat = mat(REDUCE_FRAG, { tInput: U(null), uSrcTexel: U(new THREE.Vector2()) });
    this.adaptMat = mat(ADAPT_FRAG, { tLum: U(null), tPrev: U(null), uKey: U(0.18), uAmount: U(1), uMin: U(-2), uMax: U(2), uUp: U(2), uDown: U(1), uDt: U(0.016), uInstant: U(1), uDarkComp: U(0.4) });
    this.brightMat = mat(BRIGHT_FRAG, { tInput: U(null), tAE: U(null), uSrcTexel: U(new THREE.Vector2()), uExposure: U(1), uThreshold: U(5) });
    this.streakMat = mat(STREAK_FRAG, { tInput: U(null), tA: U(null), tB: U(null), uStep: U(new THREE.Vector2()), uFinal: U(0) });
    this.centroidMat = mat(CENTROID_FRAG, { tInput: U(null), uSrcTexel: U(new THREE.Vector2()), uTiles: U(new THREE.Vector2()) });
    this.centroid2Mat = mat(CENTROID2_FRAG, { tInput: U(null), uTiles: U(new THREE.Vector2()) });
    this.lutMat = mat(LUT_FRAG, {
      uContrast: U(1), uSaturation: U(1), uTemperature: U(0), uTint: U(0), uBlackPoint: U(0.004),
      uLift: U(new THREE.Vector3()), uGamma: U(new THREE.Vector3(1, 1, 1)), uGain: U(new THREE.Vector3(1, 1, 1)),
      uShadowsTint: U(new THREE.Vector3()), uHighlightsTint: U(new THREE.Vector3()),
      uLookAmt: U(1), uTealOrange: U(0), uBleach: U(0), uMono: U(0), uFadeToe: U(0), uHlDesat: U(0), uGreenShift: U(0), uRedBoost: U(0),
      uSplit: U(0), uWarmHi: U(0), uCoolLo: U(0), uCurve: U(0), uSkyDeep: U(0),
      uMonoTint: U(new THREE.Vector3(1, 1, 1)), uSplitLo: U(new THREE.Vector3()), uSplitHi: U(new THREE.Vector3()),
    });
    this.compMat = mat(COMPOSITE_FRAG, {
      tScene: U(null), tBloom: U(null), tAE: U(null), tStreak: U(null), tFlare: U(null), tLUT: U(null), tDepth: U(null), uReversed: U(R),
      uResolution: U(new THREE.Vector2()), uTime: U(0), uFrameSeed: U(0),
      uExposure: U(1), uToneMap: U(0), uAgxPunch: U(0.5),
      uVignette: U(0.3), uVignetteSoft: U(0.5), uGrain: U(0.03), uGrainSize: U(1.35), uChroma: U(0.002), uBloomStrength: U(0.06), uBloomNorm: U(1), uHalation: U(0),
      uStreak: U(0), uFlare: U(0), uStreakTint: U(new THREE.Vector3(0.5, 0.7, 1)), uUseLUT: U(1), uUseStreak: U(0), uUseFlare: U(0),
      uWarp: U(0), uFade: U(0), uFadeColor: U(new THREE.Color()), uDebug: U(0), uPurkinje: U(0), uBlackPoint: U(0.004), uBlackToe: U(0.02),
    });
    this.fxaaMat = mat(FXAA_FRAG, { tInput: U(null), uTexel: U(new THREE.Vector2()) });
    this.casMat = mat(CAS_FRAG, { tInput: U(null), uTexel: U(new THREE.Vector2()), uSharp: U(0.35) });
    this.copyMat = mat(`uniform sampler2D tInput; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tInput, vUv); }`, { tInput: U(null) });

    // Size-independent tiny targets.
    const fl = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false };
    this.lumRTs = [64, 16, 4, 1].map((n) => new THREE.WebGLRenderTarget(n, n, fl));
    this.aeRT = [new THREE.WebGLRenderTarget(1, 1, fl), new THREE.WebGLRenderTarget(1, 1, fl)];
    this.focusRT = [new THREE.WebGLRenderTarget(1, 1, fl), new THREE.WebGLRenderTarget(1, 1, fl)];
    this.flareRT = new THREE.WebGLRenderTarget(1, 1, fl);
    this.lutRT = new THREE.WebGLRenderTarget(1024, 32, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false });
    this._aeIdx = 0; this._focusIdx = 0;
  }

  /** Smoothly blend toward a partial grade over `seconds`. */
  setGrade(partial, seconds = 0) {
    const target = { ...this.grade, ...partial };
    const lookTarget = resolveLook(target.look);
    if (seconds <= 0) { this.grade = target; this._gradeT = 1; this._gradeTo = null; this._look = lookTarget; this._lookTo = null; return; }
    this._gradeFrom = { ...this.grade }; this._gradeTo = target; this._gradeT = 0; this._gradeDur = seconds;
    this._lookFrom = { ...this._look, monoTint: [...this._look.monoTint], splitLo: [...this._look.splitLo], splitHi: [...this._look.splitHi] };
    this._lookTo = lookTarget;
  }
  resetGrade(seconds = 0) { this.setGrade({ ...DEFAULT_GRADE }, seconds); }
  /** Forget temporal history (call on hard camera cuts). */
  resetHistory() { this._historyValid = false; this._aeValid = false; this._focusValid = false; }

  setSize(w, h, dpr) {
    const W = Math.max(1, Math.floor(w * dpr)), H = Math.max(1, Math.floor(h * dpr));
    if (W === this.width && H === this.height && this.sceneRT) return;
    this.width = W; this.height = H;
    this._disposeSized();
    const hdr = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false };
    const depthTexture = new THREE.DepthTexture(W, H, THREE.FloatType);
    depthTexture.minFilter = THREE.NearestFilter; depthTexture.magFilter = THREE.NearestFilter;
    this.sceneRT = new THREE.WebGLRenderTarget(W, H, { ...hdr, depthBuffer: true, depthTexture, samples: this.quality.msaa });
    this.pingRT = new THREE.WebGLRenderTarget(W, H, hdr);
    this.pongRT = new THREE.WebGLRenderTarget(W, H, hdr);
    this.ldrRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    if (this.settings.taa) this.historyRT = [new THREE.WebGLRenderTarget(W, H, hdr), new THREE.WebGLRenderTarget(W, H, hdr)];
    this._histIdx = 0; this._historyValid = false;
    const hw = Math.max(1, W >> 1), hh = Math.max(1, H >> 1);
    if (this.settings.ao) this.aoRT = [new THREE.WebGLRenderTarget(hw, hh, hdr), new THREE.WebGLRenderTarget(hw, hh, hdr)];
    if (this.settings.dof) this.dofRT = [new THREE.WebGLRenderTarget(hw, hh, hdr), new THREE.WebGLRenderTarget(hw, hh, hdr)];
    // lens buffers: quarter width, half height (thin anamorphic streaks)
    const lw = Math.max(16, W >> 2), lh = Math.max(16, H);
    if (this.settings.flare || this.settings.streak) {
      this.brightRT = new THREE.WebGLRenderTarget(lw, lh, hdr);
      this.streakRT = [0, 1, 2].map(() => new THREE.WebGLRenderTarget(lw, lh, hdr));
      this._tiles = new THREE.Vector2(Math.ceil(lw / 16), Math.ceil(lh / 32));
      this.tileRT = new THREE.WebGLRenderTarget(this._tiles.x, this._tiles.y, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    }
    this.down = []; this.up = [];
    let bw = W, bh = H;
    for (let i = 0; i < this.bloomLevels; i++) {
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
      this.down.push(new THREE.WebGLRenderTarget(bw, bh, hdr));
      this.up.push(new THREE.WebGLRenderTarget(bw, bh, hdr));
      if (Math.min(bw, bh) <= 3) break;
    }
  }

  get depthTexture() { return this.sceneRT?.depthTexture; }

  _tickGrade(dt) {
    if (!this._gradeTo) return;
    this._gradeT = Math.min(1, this._gradeT + dt / this._gradeDur);
    const t = this._gradeT * this._gradeT * (3 - 2 * this._gradeT);
    const a = this._gradeFrom, b = this._gradeTo, g = this.grade;
    for (const k of Object.keys(b)) {
      if (typeof b[k] === 'number' && typeof a[k] === 'number') g[k] = a[k] + (b[k] - a[k]) * t;
      else if (Array.isArray(b[k]) && Array.isArray(a[k])) g[k] = b[k].map((v, i) => (a[k][i] ?? v) + (v - (a[k][i] ?? v)) * t);
      else g[k] = t < 0.5 ? a[k] : b[k];
    }
    if (this._lookTo) lerpLook(this._lookFrom, this._lookTo, t, this._look);
    if (this._gradeT >= 1) { this._gradeTo = null; this._lookTo = null; }
  }

  _other(tex) { return this.pingRT.texture === tex ? this.pongRT : this.pingRT; }

  /** Camera history: relative transform prev←cur in view space; detects cuts. */
  _cameraHistory(camera) {
    const cut = this._prevCam !== camera || !this._historyValid;
    // rel = prevView * curWorld  (camera-relative; float64 on the CPU)
    this._rel.multiplyMatrices(this._prevView, camera.matrixWorld);
    let teleport = false;
    if (!cut) {
      this._rel.decompose(this._p, this._q, this._s);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(this._q.w)));
      const near = camera.near || 0.1;
      if (ang > 0.5 || this._p.length() > near * 600) teleport = true;
    }
    this._projU.copy(camera.projectionMatrix);
    this._projInvU.copy(camera.projectionMatrixInverse);
    return cut || teleport;
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
    this.frame++;
    const g = this.grade, S = this.settings;
    const W = this.width, H = this.height;
    const useTAA = S.taa && g.taa !== 0 && !!camera.isPerspectiveCamera && !!this.historyRT;

    // 1) scene → HDR (sub-pixel jittered for TAA)
    if (useTAA) {
      const j = JITTER[this.frame % JITTER.length];
      this._jitter.set((j[0] * 2) / W, (j[1] * 2) / H);
      this._savedProj.copy(camera.projectionMatrix); this._savedProjInv.copy(camera.projectionMatrixInverse);
      const e = camera.projectionMatrix.elements;
      e[8] += this._jitter.x; e[9] += this._jitter.y;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    } else this._jitter.set(0, 0);
    r.setRenderTarget(this.sceneRT);
    r.clear(true, true, false);
    opts.before?.(r, this.sceneRT);
    try { r.render(scene, camera); } finally {
      if (useTAA) {
        this._projInv.copy(camera.projectionMatrixInverse); // jittered: matches the depth buffer
        camera.projectionMatrix.copy(this._savedProj); camera.projectionMatrixInverse.copy(this._savedProjInv);
      } else this._projInv.copy(camera.projectionMatrixInverse);
    }
    let src = this.sceneRT.texture;
    const depth = this.sceneRT.depthTexture;
    const cut = this._cameraHistory(camera);
    const instant = this.shotMode ? true : !this._aeValid;

    const ctx = this._ctx;
    ctx.depthTexture = depth; ctx.camera = camera; ctx.near = camera.near; ctx.far = camera.far;
    ctx.time = opts.time ?? 0; ctx.width = W; ctx.height = H; ctx.frame = this.frame;
    ctx.viewInv.copy(camera.matrixWorld);
    camera.getWorldPosition(ctx.cameraPosition);

    // 2) ambient occlusion (before atmosphere so fog is never occluded)
    if (S.ao && this.aoRT && g.ao > 0.001 && camera.isPerspectiveCamera) {
      const a = this.aoMat.uniforms;
      a.tDepth.value = depth; a.uProjInv.value.copy(this._projInv); a.uFullTexel.value.set(1 / W, 1 / H);
      a.uRadius.value = g.aoRadius; a.uProjScale.value = 0.5 * H * this._projU.elements[5];
      a.uMaxPx.value = Math.min(H * 0.12, 96); a.uFrame.value = useTAA ? this.frame % 64 : 0; a.uFadeEnd.value = g.aoDistance;
      this.fs.render(r, this.aoMat, this.aoRT[0]);
      const b = this.aoBlurMat.uniforms; const aw = this.aoRT[0].width, ah = this.aoRT[0].height;
      b.tAO.value = this.aoRT[0].texture; b.uDir.value.set(1 / aw, 0); this.fs.render(r, this.aoBlurMat, this.aoRT[1]);
      b.tAO.value = this.aoRT[1].texture; b.uDir.value.set(0, 1 / ah); this.fs.render(r, this.aoBlurMat, this.aoRT[0]);
      const p = this.aoApplyMat.uniforms;
      p.tScene.value = src; p.tAO.value = this.aoRT[0].texture; p.tDepth.value = depth; p.uAORes.value.set(aw, ah);
      p.uNear.value = camera.near; p.uFar.value = camera.far; p.uIntensity.value = Math.min(1.5, g.ao); p.uPower.value = g.aoPower;
      p.uFadeEnd.value = g.aoDistance; p.uDebug.value = this.debug === 'ao' ? 1 : 0;
      const out = this._other(src); this.fs.render(r, this.aoApplyMat, out); src = out.texture;
    }

    // 3) level effects
    for (const fx of effects) {
      if (!fx || fx.enabled === false) continue;
      const out = this._other(src);
      fx.render(r, src, out, ctx);
      src = out.texture;
    }

    // 4) temporal anti-aliasing
    const reproj = (u) => { u.uProjInvU.value.copy(this._projInvU); u.uPrevProj.value.copy(this._prevProj); u.uRel.value.copy(this._rel); };
    if (useTAA && this.debug !== 'ao') {
      const t = this.taaMat.uniforms;
      const prev = this.historyRT[this._histIdx], next = this.historyRT[1 - this._histIdx];
      t.tCurrent.value = src; t.tHistory.value = prev.texture; t.tDepth.value = depth;
      t.uRes.value.set(W, H); t.uTexel.value.set(1 / W, 1 / H); t.uReset.value = cut ? 1 : 0;
      t.uMaxFrames.value = this.shotMode ? 16 : 10;
      reproj(t);
      this.fs.render(r, this.taaMat, next);
      this._histIdx = 1 - this._histIdx; this._historyValid = true;
      src = next.texture;
    } else this._historyValid = false;

    // 5) camera motion blur
    if (S.motionBlur && g.motionBlur > 0.001 && !cut && camera.isPerspectiveCamera) {
      const m = this.mbMat.uniforms;
      m.tInput.value = src; m.tDepth.value = depth; m.uRes.value.set(W, H); m.uTexel.value.set(1 / W, 1 / H);
      m.uShutter.value = g.motionBlur; m.uMaxPx.value = H * 0.04; m.uNearCut.value = g.motionBlurNear; m.uNear.value = camera.near; m.uFar.value = camera.far;
      m.uFrame.value = this.frame % 32; reproj(m);
      const out = this._other(src); this.fs.render(r, this.mbMat, out); src = out.texture;
    }

    // 6) depth of field
    if (S.dof && this.dofRT && g.dof > 0.001 && camera.isPerspectiveCamera) {
      const f = this.focusMat.uniforms;
      const fPrev = this.focusRT[this._focusIdx], fNext = this.focusRT[1 - this._focusIdx];
      f.tDepth.value = depth; f.tPrev.value = fPrev.texture; f.uNear.value = camera.near; f.uFar.value = camera.far;
      f.uK.value = (this.shotMode || !this._focusValid) ? 1 : 1 - Math.exp(-dt * 4); f.uManual.value = g.dofFocus;
      this.fs.render(r, this.focusMat, fNext); this._focusIdx = 1 - this._focusIdx; this._focusValid = true;
      const maxCoc = Math.max(1, g.dofMaxBlur * (H / 1080) * 0.5);
      for (const mm of [this.cocMat, this.mergeMat]) {
        const u = mm.uniforms; u.tDepth.value = depth; u.tFocus.value = fNext.texture; u.uNear.value = camera.near; u.uFar.value = camera.far;
        u.uAperture.value = g.dofAperture * g.dof; u.uMaxCoc.value = maxCoc;
      }
      this.cocMat.uniforms.tInput.value = src; this.fs.render(r, this.cocMat, this.dofRT[0]);
      const ga = this.gatherMat.uniforms; ga.tCoc.value = this.dofRT[0].texture; ga.uTexel.value.set(1 / this.dofRT[0].width, 1 / this.dofRT[0].height); ga.uMaxCoc.value = maxCoc;
      this.fs.render(r, this.gatherMat, this.dofRT[1]);
      const mg = this.mergeMat.uniforms; mg.tInput.value = src; mg.tBlur.value = this.dofRT[1].texture;
      const out = this._other(src); this.fs.render(r, this.mergeMat, out); src = out.texture;
    } else this._focusValid = false;

    // 7) auto exposure
    {
      const l = this.lumMat.uniforms; l.tInput.value = src; l.uCell.value.set(1 / 64, 1 / 64);
      this.fs.render(r, this.lumMat, this.lumRTs[0]);
      for (let i = 1; i < this.lumRTs.length; i++) {
        const u = this.reduceMat.uniforms; u.tInput.value = this.lumRTs[i - 1].texture;
        u.uSrcTexel.value.set(1 / this.lumRTs[i - 1].width, 1 / this.lumRTs[i - 1].height);
        this.fs.render(r, this.reduceMat, this.lumRTs[i]);
      }
      const a = this.adaptMat.uniforms;
      const prev = this.aeRT[this._aeIdx], next = this.aeRT[1 - this._aeIdx];
      a.tLum.value = this.lumRTs[3].texture; a.tPrev.value = prev.texture;
      a.uKey.value = g.aeKey; a.uAmount.value = g.autoExposure; a.uMin.value = g.aeMin; a.uMax.value = g.aeMax;
      a.uDarkComp.value = g.aeDarkComp; a.uUp.value = g.aeSpeedUp; a.uDown.value = g.aeSpeedDown; a.uDt.value = dt; a.uInstant.value = instant ? 1 : 0;
      this.fs.render(r, this.adaptMat, next); this._aeIdx = 1 - this._aeIdx; this._aeValid = true;
    }
    const aeTex = this.aeRT[this._aeIdx].texture;

    // 8) bloom
    let prevTex = src;
    for (let i = 0; i < this.down.length; i++) {
      const t = this.down[i];
      this.downMat.uniforms.tInput.value = prevTex;
      const pw = i === 0 ? W : this.down[i - 1].width, ph = i === 0 ? H : this.down[i - 1].height;
      this.downMat.uniforms.uTexel.value.set(1 / pw, 1 / ph);
      this.downMat.uniforms.uFirst.value = i === 0 ? 1 : 0;
      this.downMat.uniforms.uThreshold.value = g.bloomThreshold;
      this.downMat.uniforms.uKnee.value = g.bloomKnee;
      this.downMat.uniforms.tAE.value = aeTex; this.downMat.uniforms.uExposure.value = g.exposure;
      this.downMat.uniforms.uHiBoost.value = i === 0 ? g.bloomHighlights : 0; this.downMat.uniforms.uHiStart.value = g.bloomHighlightStart;
      this.fs.render(r, this.downMat, t);
      prevTex = t.texture;
    }
    // PSF weights: mip i carries falloff^i of the energy (wide, soft tail).
    const n = this.down.length;
    const falloff = 0.42 + 0.62 * Math.min(1, Math.max(0, g.bloomRadius));
    let wsum = Math.pow(falloff, n - 1);
    let low = this.down[n - 1].texture;
    for (let i = n - 2; i >= 0; i--) {
      const wi = Math.pow(falloff, i);
      wsum += wi;
      this.upMat.uniforms.tLow.value = low;
      this.upMat.uniforms.tHigh.value = this.down[i].texture;
      this.upMat.uniforms.uTexel.value.set(1 / this.down[i + 1].width, 1 / this.down[i + 1].height);
      this.upMat.uniforms.uWeight.value = wi;
      this.fs.render(r, this.upMat, this.up[i]);
      low = this.up[i].texture;
    }
    const bloomNorm = 1 / wsum;

    // 9) lens: bright pass → anamorphic streak + dominant-source centroid
    const useStreak = S.streak && g.streak > 0.001 && this.brightRT;
    const useFlare = S.flare && g.flare > 0.001 && this.brightRT;
    if (useStreak || useFlare) {
      const b = this.brightMat.uniforms;
      b.tInput.value = src; b.tAE.value = aeTex; b.uSrcTexel.value.set(1 / W, 1 / H);
      b.uExposure.value = g.exposure; b.uThreshold.value = g.flareThreshold;
      this.fs.render(r, this.brightMat, this.brightRT);
      if (useStreak) {
        const s = this.streakMat.uniforms, lw = this.brightRT.width;
        const [A, B, C] = this.streakRT;
        s.uFinal.value = 0; s.tA.value = s.tB.value = this.brightRT.texture; s.tInput.value = this.brightRT.texture; s.uStep.value.set(1.5 / lw, 0); this.fs.render(r, this.streakMat, A);
        s.tInput.value = A.texture; s.uStep.value.set(7 / lw, 0); this.fs.render(r, this.streakMat, B);
        s.uFinal.value = 1; s.tInput.value = B.texture; s.tA.value = A.texture; s.tB.value = B.texture; s.uStep.value.set(30 / lw, 0); this.fs.render(r, this.streakMat, C);
      }
      if (useFlare) {
        const c = this.centroidMat.uniforms;
        c.tInput.value = this.brightRT.texture; c.uSrcTexel.value.set(1 / this.brightRT.width, 1 / this.brightRT.height); c.uTiles.value.copy(this._tiles);
        this.fs.render(r, this.centroidMat, this.tileRT);
        const c2 = this.centroid2Mat.uniforms; c2.tInput.value = this.tileRT.texture; c2.uTiles.value.copy(this._tiles);
        this.fs.render(r, this.centroid2Mat, this.flareRT);
      }
    }

    // 10) grade LUT
    if (S.lut) this._bakeLUT();

    // 11) composite
    const u = this.compMat.uniforms;
    u.tScene.value = src; u.tDepth.value = depth; u.tBloom.value = low; u.uBloomNorm.value = bloomNorm; u.tAE.value = aeTex;
    u.tStreak.value = useStreak ? this.streakRT[2].texture : null; u.tFlare.value = this.flareRT.texture; u.tLUT.value = this.lutRT.texture;
    u.uUseStreak.value = useStreak ? 1 : 0; u.uUseFlare.value = useFlare ? 1 : 0; u.uUseLUT.value = S.lut ? 1 : 0;
    u.uStreak.value = g.streak; u.uFlare.value = g.flare; u.uStreakTint.value.fromArray(g.streakTint);
    u.uResolution.value.set(W, H); u.uTime.value = ctx.time; u.uFrameSeed.value = this.shotMode ? 1 : this.frame % 997;
    u.uExposure.value = g.exposure; u.uToneMap.value = g.toneMap === 'aces' ? 1 : g.toneMap === 'neutral' ? 2 : 0; u.uAgxPunch.value = g.agxPunch;
    u.uVignette.value = g.vignette; u.uVignetteSoft.value = g.vignetteSoftness; u.uGrain.value = g.grain; u.uGrainSize.value = g.grainSize; u.uChroma.value = g.chroma;
    u.uBloomStrength.value = g.bloomStrength; u.uHalation.value = g.halation; u.uBlackPoint.value = g.blackPoint; u.uBlackToe.value = g.blackToe; u.uPurkinje.value = g.autoExposure > 0.001 ? g.purkinje : 0;
    u.uWarp.value = this.transition.warp; u.uFade.value = this.transition.fade; u.uFadeColor.value.copy(this.transition.color);
    u.uDebug.value = this.debug === 'exposure' ? 1 : this.debug === 'flare' ? 2 : 0;
    const finalPass = useTAA ? (S.sharpen && g.sharpen > 0.001 ? this.casMat : null) : this.fxaaMat;
    this.fs.render(r, this.compMat, finalPass ? this.ldrRT : null);

    // 12) sharpen (TAA tiers) or FXAA → screen
    if (finalPass) {
      finalPass.uniforms.tInput.value = this.ldrRT.texture;
      finalPass.uniforms.uTexel.value.set(1 / W, 1 / H);
      if (finalPass === this.casMat) finalPass.uniforms.uSharp.value = g.sharpen;
      this.fs.render(r, finalPass, null);
    }

    // history for next frame
    this._prevCam = camera;
    this._prevView.copy(camera.matrixWorldInverse);
    this._prevProj.copy(this._projU);
  }

  _lutSignature() {
    // Cheap change detector (no allocation): the LUT is only re-baked when the grade moves.
    const g = this.grade, k = this._look;
    let h = 0, i = 1;
    const add = (v) => { h += (+v || 0) * (i * 0.6180339 + 1.37); i++; };
    add(g.contrast); add(g.saturation); add(g.temperature); add(g.tint); add(g.lookStrength);
    for (const a of [g.lift, g.gamma, g.gain, g.shadowsTint, g.highlightsTint, k.monoTint, k.splitLo, k.splitHi]) { add(a?.[0]); add(a?.[1]); add(a?.[2]); }
    for (const key of LOOK_KEYS) add(k[key]);
    return h;
  }

  _bakeLUT() {
    const sig = this._lutSignature();
    if (sig === this._lutSig) return;
    this._lutSig = sig;
    const g = this.grade, k = this._look, u = this.lutMat.uniforms;
    u.uContrast.value = g.contrast; u.uSaturation.value = g.saturation; u.uTemperature.value = g.temperature; u.uTint.value = g.tint;
    u.uBlackPoint.value = g.blackPoint;
    u.uLift.value.fromArray(g.lift); u.uGamma.value.fromArray(g.gamma); u.uGain.value.fromArray(g.gain);
    u.uShadowsTint.value.fromArray(g.shadowsTint); u.uHighlightsTint.value.fromArray(g.highlightsTint);
    u.uLookAmt.value = g.lookStrength;
    u.uTealOrange.value = k.tealOrange; u.uBleach.value = k.bleach; u.uMono.value = k.mono; u.uFadeToe.value = k.fadeToe;
    u.uHlDesat.value = k.hlDesat; u.uGreenShift.value = k.greenShift; u.uRedBoost.value = k.redBoost; u.uSplit.value = k.split;
    u.uWarmHi.value = k.warmHi; u.uCoolLo.value = k.coolLo; u.uCurve.value = k.curve; u.uSkyDeep.value = k.skyDeep;
    u.uMonoTint.value.fromArray(k.monoTint); u.uSplitLo.value.fromArray(k.splitLo); u.uSplitHi.value.fromArray(k.splitHi);
    this.fs.render(this.renderer, this.lutMat, this.lutRT);
  }

  _disposeSized() {
    const list = [this.sceneRT, this.pingRT, this.pongRT, this.ldrRT, this.brightRT, this.tileRT,
      ...(this.historyRT || []), ...(this.aoRT || []), ...(this.dofRT || []), ...(this.streakRT || []), ...(this.down || []), ...(this.up || [])];
    for (const t of list) {
      if (!t) continue;
      t.depthTexture?.dispose?.();
      t.dispose();
    }
    this.historyRT = null; this.aoRT = null; this.dofRT = null; this.streakRT = null; this.brightRT = null; this.tileRT = null;
  }

  dispose() {
    this._disposeSized();
    for (const t of [...this.lumRTs, ...this.aeRT, ...this.focusRT, this.flareRT, this.lutRT]) t?.dispose();
  }
}

export { DEFAULT_GRADE };
