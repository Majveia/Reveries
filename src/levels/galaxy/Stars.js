// Point-star layers of the galaxy, all rendered in an overlay pass AFTER the
// volumetric light so each star carries its own dust extinction (vertex shader
// integrates the dust column between the camera and the star):
//
//  * catalog field   300k–1M stars sampled with universe.galaxySample (exact catalog
//                    morphology) with stellar-population colors and a luminosity function
//  * young clusters  tight blue-white OB associations strung along the arms
//  * HII knots       world-sized soft pink emission blobs (Hα + Hβ) on the arms
//  * local fields    nested wrap-around procedural star boxes (1.2 kpc → 1.2 pc) whose
//                    density follows the galaxy model, so zooming to parsecs is never empty
//  * systems         the first catalog star systems (universe.star) with selection rings

import * as THREE from 'three';
import { Random, seedFrom } from '../../core/Random.js';
import { GAL_GLSL } from './GalaxyModel.js';

// Linear-sRGB blackbody (Tanner Helland fit), normalized to max channel 1.
export function bbColor(T, out = [0, 0, 0]) {
  const t = Math.min(40000, Math.max(1000, T)) / 100;
  let r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  let g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  let b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v) => Math.pow(Math.min(255, Math.max(0, v)) / 255, 2.2);
  out[0] = c(r); out[1] = c(g); out[2] = c(b);
  const m = Math.max(out[0], out[1], out[2], 1e-6);
  out[0] /= m; out[1] /= m; out[2] /= m;
  return out;
}

// Inside the disk: the same discrete near-dust clouds as the volume (GalaxyVolume) dim every
// point star within 3 kpc, so the resolved star haze breaks into rifts exactly like the band.
const CLOUD_GLSL = /* glsl */ `
uniform sampler3D uNoise; uniform float uInside;
float cloudTau(vec3 a, vec3 b){
  float L = length(b - a), t = 0.0;
  for (int k = 0; k < 4; k++) {
    vec3 pm = mix(a, b, (float(k) + 0.5) / 4.0);
    vec4 c1 = textureLod(uNoise, pm * 0.9 + 0.37, 0.0);
    vec4 c2 = textureLod(uNoise, pm * 4.0 + c1.xyz * 0.3, 0.0);
    float cl = smoothstep(0.57, 0.65, c1.g * 0.6 + c2.r * 0.4);
    float pD = 0.5 / (uHDust * pow(cosh(clamp(pm.y / uHDust, -12.0, 12.0)), 2.0));
    t += galMap(pm, 0.0).b * pD * (0.04 + cl * cl * 9.0) * (0.5 + c2.b);
  }
  return t * L * 0.25 * uKappa;
}
float starTau(vec3 a, vec3 b, int n, float lod){
  if (uInside <= 0.0) return galTau(a, b, n, lod);
  float L = length(b - a);
  vec3 m = a + (b - a) * (min(L, 2.0) / max(L, 1e-6));
  float far = L > 2.0 ? galTau(m, b, n, lod) : 0.0;
  return mix(galTau(a, b, n, lod), cloudTau(a, m) + far, uInside);
}
`;

const STAR_VERT = /* glsl */ `
${GAL_GLSL}
${CLOUD_GLSL}
attribute vec4 aCol;          // linear color (rgb) + log2 luminosity code (a)
uniform float uBright, uMinPx, uMaxPx, uPxScale, uSat, uTauSteps, uFade;
varying vec3 vColor; varying float vSharp, vRc;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float d2 = dot(mv.xyz, mv.xyz);
  float L = exp2((aCol.a * 255.0 - 128.0) / 16.0);
  float flux = L * uBright / (d2 + 1e-6);
  flux = uSat * (1.0 - exp(-flux / uSat));
  float lod = log2(max(sqrt(d2) * 0.002, uMapTexel) / uMapTexel);
  flux *= exp(-starTau(cameraPosition, position, int(uTauSteps), lod));
  // stars embedded in a lane are dimmed by the column around them (screen term, matches the volume)
  flux *= exp(-galMap(position, 1.0).b * 1.1);
  float px = clamp(1.0 + sqrt(flux) * uPxScale, uMinPx, uMaxPx);
  gl_PointSize = px;
  vSharp = px;
  vRc = 0.45 + 0.07 * px;
  // energy: flux concentrated in a compact PSF core (~π·rc² pixels); the footprint holds spikes/halo
  vColor = aCol.rgb * flux / max(1.0, 3.1416 * vRc * vRc) * uFade;
  if (flux < 1e-4) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

// Telescope PSF: compact gaussian core, faint halo and — on bright stars — the
// six-pointed JWST diffraction pattern (three spike axes at 60° + a faint horizontal strut).
const STAR_FRAG = /* glsl */ `
varying vec3 vColor; varying float vSharp, vRc;
void main(){
  vec2 pc = (gl_PointCoord * 2.0 - 1.0) * vSharp * 0.5;   // pixels from the centre
  float d2 = dot(pc, pc), R = vSharp * 0.5;
  if (d2 > R * R) discard;
  float f = exp(-d2 / (vRc * vRc));
  if (vSharp > 5.0) {
    float d = sqrt(d2), edge = 1.0 - d / R;
    float sp = 0.0;
    for (int k = 0; k < 3; k++) {
      float a = 1.5708 + float(k) * 1.0472;
      vec2 ax = vec2(cos(a), sin(a));
      float across = abs(dot(pc, vec2(-ax.y, ax.x)));
      sp += exp(-across * across * 1.6) * exp(-d / (R * 0.32));
    }
    sp += 0.35 * exp(-pc.y * pc.y * 1.6) * exp(-d / (R * 0.2));
    float k = smoothstep(5.0, 12.0, vSharp);
    f += (sp * 0.16 + exp(-d / (vRc * 2.5)) * 0.05) * edge * edge * k;
  }
  gl_FragColor = vec4(vColor * f, 1.0);
}`;

// World-sized soft sprites (HII regions, cluster haze)
const BLOB_VERT = /* glsl */ `
${GAL_GLSL}
attribute vec4 aCol; attribute float aSize;
uniform float uProj, uGain, uMaxPx;
varying vec3 vColor; varying float vSeed;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = length(mv.xyz);
  float px = aSize * uProj / max(d, 1e-5);
  float pxc = clamp(px, 1.5, uMaxPx);
  float lod = log2(max(d * 0.004, uMapTexel) / uMapTexel);
  float ext = exp(-galTau(cameraPosition, position, 4, lod) * 0.8 - galMap(position, 1.0).b * 0.6);
  // surface brightness is distance-independent; unresolved blobs keep their total flux
  float sb = aCol.a * uGain * ext * min(1.0, px * px / (pxc * pxc));
  // fade out when the camera is inside / very close (the nebula renderer takes over)
  sb *= smoothstep(aSize * 1.5, aSize * 6.0, d);
  gl_PointSize = pxc;
  vColor = aCol.rgb * sb;
  vSeed = fract(position.x * 37.1 + position.z * 11.3);
  if (sb < 1e-5 || mv.z > -1e-4) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;
const BLOB_FRAG = /* glsl */ `
varying vec3 vColor; varying float vSeed;
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float a = atan(c.y, c.x);
  float s1 = vSeed * 40.0, s2 = fract(vSeed * 7.31) * 30.0;
  float n = floor(3.0 + fract(vSeed * 3.7) * 5.0);
  float lobes = 1.0 + (0.3 * sin(a * n + s1) + 0.18 * sin(a * (n + 2.0) - s2) + 0.12 * sin(a * 2.0 + s2)) * sqrt(r2) * 1.6;
  float f = exp(-r2 * 4.5 * max(lobes, 0.3)) - 0.011;
  float lum = dot(vColor, vec3(0.3, 0.5, 0.2));
  vec3 c0 = mix(vColor, vec3(lum) * vec3(0.9, 0.95, 1.1), exp(-r2 * 30.0) * 0.55);
  gl_FragColor = vec4(c0 * max(f, 0.0), 1.0);
}`;

// Nested wrap-around local star boxes
const LOCAL_VERT = /* glsl */ `
${GAL_GLSL}
${CLOUD_GLSL}
attribute vec4 aRnd;     // xyz position in unit box, w = luminosity/keep random
uniform float uS, uBright, uPxScale, uSat, uDensRef, uBulgeScale, uBulgeQ, uBulgeAmp, uHOldU, uHYoungU;
uniform vec3 uCamPos;
vec3 bb(float t){ // compact blackbody approx (linear)
  t = clamp(t, 1500.0, 30000.0) / 100.0;
  float r = t <= 66.0 ? 1.0 : clamp(1.2929 * pow(t - 60.0, -0.1332), 0.0, 1.0);
  float g = t <= 66.0 ? clamp(0.3901 * log(t) - 0.6318, 0.0, 1.0) : clamp(1.1299 * pow(t - 60.0, -0.0755), 0.0, 1.0);
  float b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : clamp(0.5432 * log(t - 10.0) - 1.1963, 0.0, 1.0));
  vec3 c = pow(vec3(r, g, b), vec3(2.2)); return c / max(c.r, max(c.g, c.b));
}
void main(){
  vec3 h = aRnd.xyz * uS;
  vec3 p = h + uS * floor((uCamPos - h) / uS + 0.5);   // nearest periodic image
  vec3 rel = p - uCamPos;
  float dist = length(rel);
  float boxFade = 1.0 - smoothstep(0.28 * uS, 0.48 * uS, dist);
  vec4 m = galMap(p, 0.0);
  float yO = 0.5 / (uHOldU * pow(cosh(clamp(p.y / uHOldU, -12.0, 12.0)), 2.0));
  float yY = 0.5 / (uHYoungU * pow(cosh(clamp(p.y / uHYoungU, -12.0, 12.0)), 2.0));
  vec3 bq = p * vec3(1.0, 1.0 / uBulgeQ, 1.0);
  float bul = uBulgeAmp * (exp(-dot(bq, bq) / (2.0 * pow(uBulgeScale * 0.16, 2.0))) * 3.0 + exp(-dot(bq, bq) / (2.0 * pow(uBulgeScale * 0.45, 2.0))) * 0.5);
  float young = m.r * yY, old = m.g * yO;
  float dens = young * 0.5 + old + bul;
  float keep = clamp(dens / uDensRef, 0.0, 1.0);
  float rnd = fract(aRnd.w * 13.37);
  if (rnd > keep || boxFade <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vSharp = 0.0; vRc = 1.0; return; }
  // population: young (blue) fraction follows the arm light; bulge is old and warm
  float fy = young * 0.5 / max(dens, 1e-6);
  float l = aRnd.w;
  float T, L;
  float pick = fract(aRnd.w * 71.3);
  float lf = fract(aRnd.w * 517.3);
  if (pick < fy * 0.35) { T = mix(9000.0, 28000.0, l * l); L = min(3000.0, 4.0 * pow(1.0 - lf * 0.999, -1.25)); }
  else if (pick < 0.07) { T = mix(3300.0, 4500.0, l); L = min(1500.0, 6.0 * pow(1.0 - lf * 0.999, -0.9)); }    // red giants
  else { T = mix(3300.0, 7600.0, pow(l, 1.6)); L = min(60.0, 0.12 * pow(1.0 - lf * 0.9995, -1.0)); }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float flux = L * uBright * uS * uS / (dist * dist + 1e-12);
  flux = uSat * (1.0 - exp(-flux / uSat));
  flux *= exp(-starTau(uCamPos, p, 2, 0.0));
  float px = clamp(1.0 + sqrt(flux) * uPxScale, 1.0, 26.0);
  gl_PointSize = px;
  vSharp = px;
  vRc = 0.45 + 0.07 * px;
  vColor = bb(T) * flux / max(1.0, 3.1416 * vRc * vRc) * boxFade;
}`;

const MARK_VERT = /* glsl */ `
attribute vec3 aColor; attribute float aIdx;
uniform float uHover, uSel, uHome, uNear, uPx;
varying vec3 vColor; varying float vRing; varying float vAlpha; varying float vSel;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = length(mv.xyz);
  float isH = step(abs(aIdx - uHover), 0.5), isS = step(abs(aIdx - uSel), 0.5), isHome = step(abs(aIdx - uHome), 0.5);
  float vis = 1.0 - smoothstep(uNear * 0.5, uNear, d);
  vAlpha = max(vis * 0.45, max(isH, isS));
  vAlpha = max(vAlpha, isHome * 0.85 * (1.0 - smoothstep(uNear * 2.5, uNear * 5.0, d)));
  vSel = max(isH, isS);
  vRing = 1.0;
  gl_PointSize = uPx * (1.0 + 0.6 * vSel);
  vColor = aColor;
  if (vAlpha < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;
const MARK_FRAG = /* glsl */ `
varying vec3 vColor; varying float vRing; varying float vAlpha; varying float vSel;
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  float ring = smoothstep(0.1, 0.0, abs(r - 0.78)) * (vSel > 0.5 ? 1.0 : 0.6);
  // four tick gaps → reads as a reticle, not a bubble
  float gap = smoothstep(0.12, 0.2, min(abs(c.x), abs(c.y)) / max(r, 1e-3));
  float a = ring * mix(1.0, gap, 0.8) * vAlpha;
  gl_FragColor = vec4(mix(vec3(0.75, 0.85, 1.0), vColor, 0.35) * a * 0.9, 1.0);
}`;

export class Stars {
  constructor(level, P, uniformsShared) {
    this.level = level;
    this.engine = level.engine;
    this.P = P;
    this.U = uniformsShared; // { uMap, uExtent, uHOld, uHYoung, uHDust, uKappa, uMapTexel }
    this.group = new THREE.Group();
    this.objects = [];
  }

  _mat(vert, frag, extra) {
    const m = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag,
      uniforms: { ...this.U, ...extra },
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    });
    return m;
  }

  build(g, progress) {
    const E = this.engine, U = E.universe, q = E.quality;
    const P = this.P;
    const n = E.shotMode ? 600000 : q.pick(150000, 320000, 600000, 950000);
    const rng = new Random(seedFrom(g.seed, 'stars'));
    const nClusters = q.pick(250, 500, 900, 1200);
    const perCluster = 28;
    const total = n + nClusters * perCluster;
    const pos = new Float32Array(total * 3);
    const col = new Uint8Array(total * 4);
    const tmp = [0, 0, 0];
    const lumCode = (L) => Math.max(0, Math.min(255, Math.round(Math.log2(L) * 16 + 128)));
    let o = 0;
    const R = P.R;
    for (let i = 0; i < n; i++) {
      let s = U.galaxySample(g, rng);
      // galaxySample clamps r at 1.15 R: resample instead of piling stars onto a hard rim
      for (let k = 0; k < 8 && s.r >= R * 1.149; k++) s = U.galaxySample(g, rng);
      pos[o * 3] = s.x; pos[o * 3 + 1] = s.y; pos[o * 3 + 2] = s.z;
      const bulge = s.arm === 0 && s.r < R * 0.22 && Math.abs(s.y) > -1;
      const u = rng.float();
      let T, L;
      const youngP = s.arm * g.starFormation * 0.32;
      if (g.type === 'elliptical' || g.type === 'lenticular' || (bulge && s.r < R * 0.12)) {
        if (u < 0.07) { T = rng.range(3300, 4300); L = rng.range(8, 60); } else { T = rng.range(3600, 5600); L = rng.logRange(0.15, 3); }
      } else if (u < youngP) { T = rng.range(9000, 30000); L = rng.logRange(4, 120); pos[o * 3 + 1] *= 0.3; }
      else if (u < youngP + 0.04) { T = rng.range(3300, 4400); L = rng.logRange(5, 60); }
      else { T = rng.range(3800, 8000); L = rng.logRange(0.1, 4); }
      bbColor(T, tmp);
      col[o * 4] = tmp[0] * 255; col[o * 4 + 1] = tmp[1] * 255; col[o * 4 + 2] = tmp[2] * 255; col[o * 4 + 3] = lumCode(L);
      o++;
      if ((i & 65535) === 0) progress?.(0.2 + 0.4 * (i / n), 'resolving stars');
    }
    // young OB associations along the arms
    const crng = new Random(seedFrom(g.seed, 'clusters'));
    const hiiPos = [], hiiCol = [], hiiSize = [];
    let made = 0, guard = 0;
    const budget = nClusters * perCluster;
    let used = 0;
    const sub = [];
    while (made < nClusters && used < budget && guard++ < nClusters * 40) {
      const s = U.galaxySample(g, crng);
      if (g.type !== 'irregular' && g.arms > 0 && s.arm < 0.8) continue;
      if (s.r < R * 0.08 || s.r >= R * 1.149) continue;
      // fractal (Larson-like) clump hierarchy: complex -> sub-clumps -> star knots;
      // sizes follow a power-law mass function (a few giant complexes, many small ones)
      const cnt = Math.min(budget - used, Math.max(6, Math.round(10 * Math.pow(1 - crng.float() * 0.995, -0.75))));
      const spread = 0.012 * Math.pow(cnt / 10, 0.5) * crng.range(0.7, 1.4);
      sub.length = 0;
      const nSub = 2 + crng.int(0, 4);
      for (let k = 0; k < nSub; k++) sub.push([crng.gaussian(0, spread), crng.gaussian(0, spread * 0.3), crng.gaussian(0, spread)]);
      for (let k = 0; k < cnt; k++) {
        const sc = sub[crng.int(0, nSub - 1)];
        const kn = spread * (crng.chance(0.7) ? 0.12 : 0.4);
        pos[o * 3] = s.x + sc[0] + crng.gaussian(0, kn); pos[o * 3 + 1] = s.y * 0.3 + sc[1] + crng.gaussian(0, kn * 0.5); pos[o * 3 + 2] = s.z + sc[2] + crng.gaussian(0, kn);
        const T = crng.range(10000, 32000), L = Math.min(2000, 4 * Math.pow(1 - crng.float() * 0.999, -1.2));
        bbColor(T, tmp);
        col[o * 4] = tmp[0] * 255; col[o * 4 + 1] = tmp[1] * 255; col[o * 4 + 2] = tmp[2] * 255; col[o * 4 + 3] = lumCode(L);
        o++; used++;
      }
      // a blue haze around the association
      hiiPos.push(s.x, s.y * 0.3, s.z); hiiCol.push(0.42, 0.6, 1.0, 0.22 * Math.sqrt(cnt / 10)); hiiSize.push(spread * 3.5);
      made++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, o * 3), 3));
    geo.setAttribute('aCol', new THREE.BufferAttribute(col.subarray(0, o * 4), 4, true));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 2);
    this.starMat = this._mat(STAR_VERT, STAR_FRAG, {
      uBright: { value: 2.4 }, uMinPx: { value: 1.0 }, uMaxPx: { value: 7.0 }, uPxScale: { value: 1.6 }, uSat: { value: 60 },
      uTauSteps: { value: q.pick(2, 3, 4, 6) }, uFade: { value: 1 },
    });
    this.field = new THREE.Points(geo, this.starMat);
    this.field.frustumCulled = false;
    this.group.add(this.field);

    // HII knots: complexes of pink blobs on the arm ridges
    const hrng = new Random(seedFrom(g.seed, 'hii'));
    const nHII = g.type === 'elliptical' || g.type === 'lenticular' ? 0 : q.pick(90, 140, 200, 240);
    let hm = 0; guard = 0;
    while (hm < nHII && guard++ < nHII * 80) {
      const s = U.galaxySample(g, hrng);
      if (g.arms > 0 && s.arm < 0.9) continue;
      if (s.r < R * 0.1 || s.r >= R * 1.149) continue;
      // taper toward the arm tips: sparse XUV knots instead of a dotted rim
      if (hrng.float() < THREE.MathUtils.smoothstep(s.r, R * 0.55, R * 1.0) * 0.85) continue;
      if (hrng.chance(0.4)) continue;
      // dN/dL ∝ L^-2: a few giant complexes (30 Dor / NGC 604 class), many faint knots
      const big = Math.pow(1 - hrng.float() * 0.98, -1.0);
      const size = Math.min(0.11, 0.008 * Math.pow(big, 0.7));
      const bright = Math.min(6, 0.35 * Math.pow(big, 0.55)) * g.starFormation;
      // beads on a string: 1-4 knots chained along the arm direction
      const th = Math.atan2(s.z, s.x) + Math.PI / 2 + hrng.gaussian(0, 0.35);
      const chain = 1 + hrng.int(0, 3);
      const y0 = s.y * 0.25;
      for (let c = 0; c < chain; c++) {
        const off = (c - (chain - 1) / 2) * size * hrng.range(1.4, 2.6);
        const cx = s.x + Math.cos(th) * off, cz = s.z + Math.sin(th) * off;
        const subN = 1 + hrng.int(0, 3);
        for (let k = 0; k < subN; k++) {
          hiiPos.push(cx + hrng.gaussian(0, size * 0.6), y0 + hrng.gaussian(0, size * 0.15), cz + hrng.gaussian(0, size * 0.6));
          const pinkish = hrng.float();
          hiiCol.push(1.0, 0.3 + pinkish * 0.12, 0.36 + pinkish * 0.16, bright * hrng.range(0.3, 1.1) / subN * 1.2);
          hiiSize.push(size * hrng.range(0.5, 1.15));
        }
        // hot white-blue core (the ionizing cluster)
        hiiPos.push(cx, y0, cz); hiiCol.push(0.8, 0.86, 1.0, bright * 0.9); hiiSize.push(size * 0.3);
      }
      hm++;
    }
    if (hiiPos.length) {
      const hg = new THREE.BufferGeometry();
      hg.setAttribute('position', new THREE.Float32BufferAttribute(hiiPos, 3));
      hg.setAttribute('aCol', new THREE.Float32BufferAttribute(hiiCol, 4));
      hg.setAttribute('aSize', new THREE.Float32BufferAttribute(hiiSize, 1));
      this.blobMat = this._mat(BLOB_VERT, BLOB_FRAG, { uProj: { value: 500 }, uGain: { value: 0.5 }, uMaxPx: { value: 160 } });
      this.blobs = new THREE.Points(hg, this.blobMat);
      this.blobs.frustumCulled = false;
      this.group.add(this.blobs);
    }

    // nested local star fields
    const nLocal = E.shotMode ? 150000 : q.pick(25000, 50000, 90000, 140000);
    const lrng = new Random(seedFrom(g.seed, 'local'));
    const rnd = new Float32Array(nLocal * 4);
    for (let i = 0; i < rnd.length; i++) rnd[i] = lrng.float();
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nLocal * 3), 3));
    lg.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 4));
    this.locals = [];
    for (const S of [1.6, 0.16, 0.016, 0.0016]) {
      const m = this._mat(LOCAL_VERT, STAR_FRAG, {
        uS: { value: S }, uBright: { value: 0.0016 / (S * S) * S * S * 2.0 }, uPxScale: { value: 1.6 }, uSat: { value: 40 },
        uDensRef: { value: 0.0 }, uBulgeScale: { value: P.bulgeScale }, uBulgeQ: { value: P.bulgeQ }, uBulgeAmp: { value: P.bulgeAmp },
        uHOldU: { value: P.hOld }, uHYoungU: { value: P.hYoung }, uCamPos: { value: new THREE.Vector3() },
      });
      // density reference: keep ~all points in a dense arm, fewer in sparse regions
      m.uniforms.uDensRef.value = 1.2;
      // brightness tuned so a typical star at the box's typical distance is ~equally visible on every layer
      m.uniforms.uBright.value = 0.06;
      const pts = new THREE.Points(lg, m);
      pts.frustumCulled = false;
      this.locals.push(pts);
      this.group.add(pts);
    }
  }

  buildSystems(g, count) {
    const U = this.engine.universe;
    const n = Math.min(count, g.starCatalogSize || count);
    const pos = new Float32Array(n * 3), colr = new Float32Array(n * 3), idx = new Float32Array(n);
    this.systems = [];
    for (let i = 0; i < n; i++) {
      const s = U.star(g.id, i);
      pos.set(s.position, i * 3);
      const c = s.color || [1, 1, 1];
      colr.set([c[0], c[1], c[2]], i * 3);
      idx[i] = i;
      this.systems.push({ index: i, pos: new THREE.Vector3(...s.position), star: s });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colr, 3));
    geo.setAttribute('aIdx', new THREE.BufferAttribute(idx, 1));
    this.markMat = new THREE.ShaderMaterial({
      vertexShader: MARK_VERT, fragmentShader: MARK_FRAG,
      uniforms: { uHover: { value: -1 }, uSel: { value: -1 }, uHome: { value: g.id === 0 ? 0 : -1 }, uNear: { value: 0.6 }, uPx: { value: 18 } },
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    });
    this.markers = new THREE.Points(geo, this.markMat);
    this.markers.frustumCulled = false;
    this.group.add(this.markers);
    // the system stars themselves (bright points so selected systems read as real stars)
    const sc = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const s = this.systems[i].star;
      sc[i * 4] = colr[i * 3] * 255; sc[i * 4 + 1] = colr[i * 3 + 1] * 255; sc[i * 4 + 2] = colr[i * 3 + 2] * 255;
      sc[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(Math.log2(Math.max(0.3, Math.min(400, s.lumSun))) * 16 + 128)));
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('aCol', new THREE.BufferAttribute(sc, 4, true));
    this.sysMat = this._mat(STAR_VERT, STAR_FRAG, {
      uBright: { value: 0.004 }, uMinPx: { value: 1.0 }, uMaxPx: { value: 9.0 }, uPxScale: { value: 1.6 }, uSat: { value: 80 },
      uTauSteps: { value: 2 }, uFade: { value: 1 },
    });
    this.sysPoints = new THREE.Points(sg, this.sysMat);
    this.sysPoints.frustumCulled = false;
    this.group.add(this.sysPoints);
  }

  /** Extra star points (e.g. nebula clusters) drawn with the catalog star shader. */
  addPoints(geo, bright = 0.35) {
    const m = this._mat(STAR_VERT, STAR_FRAG, {
      uBright: { value: bright }, uMinPx: { value: 1.0 }, uMaxPx: { value: 9.0 }, uPxScale: { value: 1.6 }, uSat: { value: 80 },
      uTauSteps: { value: 2 }, uFade: { value: 1 },
    });
    const pts = new THREE.Points(geo, m);
    pts.frustumCulled = false;
    this.group.add(pts);
    return pts;
  }

  update(camera, height) {
    const proj = height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    if (this.blobMat) this.blobMat.uniforms.uProj.value = proj;
    const zoom = this.level.rig ? this.level.rig.distance : 1;
    for (const l of this.locals) {
      l.material.uniforms.uCamPos.value.copy(camera.position);
      l.visible = zoom < 4.0 && Math.abs(camera.position.y) < 3.0 && camera.position.length() > 0.004; // near the hole the lensed analytic sky takes over
    }
    const s = Math.max(1, height / 720);
    this.starMat.uniforms.uMaxPx.value = 18 * s;
    if (this.markMat) this.markMat.uniforms.uPx.value = 18 * s;
  }

  dispose() {
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }
}

/** Effect: renders an overlay scene on top of the HDR image (no depth, additive/premultiplied). */
export class OverlayPass {
  constructor(scene) {
    this.scene = scene;
    this.enabled = true;
    this.copy = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D t; varying vec2 vUv; void main(){ gl_FragColor = texture2D(t, vUv); }',
      uniforms: { t: { value: null } }, depthTest: false, depthWrite: false,
    });
  }
  render(renderer, input, output, ctx) {
    this.copy.uniforms.t.value = input;
    ctx.fullscreen(this.copy, output);
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(output);
    renderer.render(this.scene, ctx.camera);
    renderer.autoClear = ac;
  }
  dispose() { this.copy.dispose(); }
}
