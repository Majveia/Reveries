// Grass, reeds and wildflowers — GPU-instanced blades streamed in 8 m cells.
//
//  • Deterministic: every cell grows the same blades in the same order (rank).
//    Lower-detail tiers keep a prefix of that sequence, and the vertex shader
//    thins blades continuously with distance (density ∝ 1/d², width grows to
//    keep coverage) — no popping rings, ~200k blades at 'high'.
//  • Placement follows the planet: climate (moisture/temp/rock/snow/sand) at
//    cell corners, a bilinear height grid (1 m near, 2 m far) so blades sit on
//    the true surface, slope + water + settlement clearings, reeds along shores.
//  • Shading: MeshStandardMaterial (sun, sky IBL, shadows like everything else)
//    patched for bent curved blades, rolling gusts, flutter, player push,
//    root AO → sunlit tips, backlit translucency, optional bioluminescence.
import * as THREE from 'three';
import { faceDir } from './scatter.js';
import { cellRng } from './scatter.js';
import { valueNoise3, valueFbm3 } from './scatter.js';
import { CellLayer } from './stream.js';
import { WIND_GLSL, patchMaterial } from './shaders.js';

const CELL = 8;
const STRIDE = 8;
const _dir = [0, 0, 0];
const _c = new THREE.Color();

function packColor(c) {
  // sqrt-encoded 8-bit linear rgb packed into one exactly-representable float
  const r = Math.min(255, Math.round(Math.sqrt(Math.max(0, c.r)) * 255));
  const g = Math.min(255, Math.round(Math.sqrt(Math.max(0, c.g)) * 255));
  const b = Math.min(255, Math.round(Math.sqrt(Math.max(0, c.b)) * 255));
  return r * 65536 + g * 256 + b;
}

function bladeGeometry(segs) {
  const pos = [], idx = [];
  for (let s = 0; s < segs; s++) { const t = s / segs; pos.push(-0.5, t, 0, 0.5, t, 0); }
  pos.push(0, 1, 0);
  for (let s = 0; s < segs - 1; s++) { const a = s * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const a = (segs - 1) * 2; idx.push(a, a + 1, a + 2);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).fill(0.5), 3)); // smooth-shaded (normal computed in the shader)
  g.setIndex(idx);
  return g;
}

// flower: 2-segment stem + a 5-petal fan head (aPart: 0 stem, 1 petal tip, 2 heart)
function flowerGeometry() {
  const pos = [], part = [], idx = [];
  for (let s = 0; s <= 2; s++) { const t = s / 2; pos.push(-0.5, t, 0, 0.5, t, 0); part.push(0, 0); }
  idx.push(0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4);
  const c0 = pos.length / 3;
  pos.push(0, 0.15, 0); part.push(2);
  const P = 10;
  for (let k = 0; k < P; k++) {
    const a = (k / P) * Math.PI * 2, r = k % 2 === 0 ? 1 : 0.38;
    pos.push(Math.cos(a) * r, (k % 2 === 0 ? 0.32 : 0.05), Math.sin(a) * r); part.push(k % 2 === 0 ? 1 : 1.5);
  }
  for (let k = 0; k < P; k++) idx.push(c0, c0 + 1 + k, c0 + 1 + ((k + 1) % P));
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).fill(0.5), 3));
  g.setIndex(idx);
  return g;
}

// flower spike (lupine / goldenrod raceme): stem + crossed floret quads along
// the upper stem. aPart: 0 stem, 1 floret; aT: anchor height along the stem.
function spikeGeometry(K = 6) {
  const pos = [], part = [], tt = [], idx = [], q = [];
  for (let s = 0; s <= 2; s++) { const t = s / 2; pos.push(-0.5, t, 0, 0.5, t, 0); part.push(0, 0); tt.push(t, t); q.push(0, 0, 0, 0); }
  idx.push(0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4);
  for (let k = 0; k < K; k++) {
    const t = 0.5 + 0.5 * (k / (K - 1));
    const sz = 0.55 - 0.3 * (k / (K - 1));
    const a = k * 2.4, ox = Math.cos(a) * 0.22, oz = Math.sin(a) * 0.22;
    for (let c = 0; c < 2; c++) {
      const ca = Math.cos(a + c * 1.5708) * sz, sa = Math.sin(a + c * 1.5708) * sz;
      const b = pos.length / 3;
      pos.push(ox - ca, -sz, oz - sa, ox + ca, -sz, oz + sa, ox + ca, sz, oz + sa, ox - ca, sz, oz - sa);
      part.push(1, 1, 1.5, 1.5); tt.push(t, t, t, t); q.push(-1, -1, 1, -1, 1, 1, -1, 1);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(tt, 1));
  g.setAttribute('aQ', new THREE.Float32BufferAttribute(q, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).fill(0.5), 3));
  g.setIndex(idx);
  return g;
}

const BLADE_VERT = /* glsl */ `
attribute vec4 aOff;   // xyz: base relative to anchor, w: rank
attribute vec4 aDat;   // yaw, height, width, packed colour
#ifdef FLOWER
attribute float aPart;
#ifdef SPIKE
attribute float aT;
attribute vec2 aQ;
varying vec2 vQ;
#endif
uniform vec3 uStemCol;
uniform float uHeadSize;
#endif
uniform vec3 uCam;
uniform vec3 uPlayer;
uniform float uR0;
uniform float uFar;
uniform float uWidthMax;
uniform float uStiff;
varying vec3 vGCol;
varying float vTrans;
varying float vGlow;
uniform float uGlow;
${WIND_GLSL}
vec3 fl_unpack(float v) {
  float r = floor(v / 65536.0); float g = floor((v - r * 65536.0) / 256.0); float b = v - r * 65536.0 - g * 256.0;
  vec3 c = vec3(r, g, b) / 255.0; return c * c;
}
`;

const BLADE_BODY = /* glsl */ `
  vec3 base = aOff.xyz;
  vec3 gUp = normalize(uAnchor + base);
  vec3 toC = base - uCam;
  float dC = length(toC);
  float fDen = clamp(uR0 * uR0 / max(dC * dC, 1e-3), 0.0, 1.0);
  float vis = (1.0 - smoothstep(fDen * 0.7, fDen, aOff.w)) * (1.0 - smoothstep(uFar * 0.72, uFar, dC));
  float wk = clamp(inversesqrt(max(fDen, 1e-4)), 1.0, uWidthMax);
  float rnd = fl_hash(aOff.w * 7919.0 + aDat.x * 13.7);
  vec3 ref = abs(gUp.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(ref, gUp)); vec3 t2 = cross(gUp, t1);
  vec3 side = t1 * cos(aDat.x) + t2 * sin(aDat.x);
  vec3 fwd = cross(side, gUp);
  float h = aDat.y * vis;
  vec3 wd = uWind.xyz - gUp * dot(uWind.xyz, gUp); wd = normalize(wd + vec3(1e-5));
  vec3 wp = uAnchor + base;
  float gst = fl_gust(wp, wd, uTime);
  float stiff = uStiff / (0.5 + aDat.y);
  float sway = uWind.w * (0.12 + 0.95 * gst) * stiff + 0.07 * sin(uTime * (2.1 + rnd * 1.9) + rnd * 40.0 + dot(wp, wd) * 0.4) * (0.4 + uWind.w) * stiff;
  vec3 lean = fwd * (rnd - 0.5) * 1.25 + side * (fl_hash(rnd * 91.3) - 0.5) * 0.45;
  lean += wd * sway;
  vec3 pp = base - uPlayer; float pv = dot(pp, gUp); pp -= gUp * pv; float pd = length(pp);
  lean += (pp / max(pd, 1e-3)) * smoothstep(1.25, 0.1, pd) * 1.5 * step(abs(pv), 2.5);
  float L2 = dot(lean, lean); if (L2 > 1.1) { lean *= inversesqrt(L2) * 1.05; L2 = 1.1; }
  float shrink = 1.0 - 0.38 * L2;
#ifdef FLOWER
  float part = aPart;
#ifdef SPIKE
  float t = aT;
  vQ = aQ;
#else
  float t = part > 0.5 ? 1.0 : position.y;
#endif
#else
  float t = position.y;
#endif
  vec3 p = base + gUp * (h * t * shrink) + lean * (h * t * t) - gUp * 0.04;
  vec3 tang = gUp * shrink + lean * 2.0 * t;
#ifdef FLOWER
  if (part > 0.5) {
    float hs = uHeadSize * (0.7 + 0.6 * rnd) * vis * min(wk, 2.2);
    vec3 hup = normalize(tang + gUp * 0.6);
    vec3 hs1 = normalize(cross(hup, side)); vec3 hs2 = cross(hs1, hup);
    p += (hs1 * position.x + hs2 * position.z + hup * position.y) * hs;
  } else {
    p += side * position.x * aDat.z * wk;
  }
#else
  p += side * position.x * aDat.z * wk * (1.0 - 0.75 * t * t);
#endif
  vec3 bn = normalize(cross(side, tang));
  if (dot(bn, toC) > 0.0) bn = -bn;
  bn = normalize(bn + side * position.x * 1.4);
  bn = normalize(mix(bn, gUp, 0.5));
  vec3 bc = fl_unpack(aDat.w);
#ifdef FLOWER
  if (part > 0.5) {
    vec3 heart = mix(vec3(0.85, 0.55, 0.06), bc * 0.5, 0.35);
#ifdef SPIKE
    vGCol = bc * (part > 1.25 ? 1.0 : 0.7) * (0.75 + 0.25 * t);
#else
    vGCol = part > 1.75 ? heart : bc * (part > 1.25 ? 0.82 : 1.0);
#endif
    bn = normalize(mix(gUp, -normalize(toC), 0.3));
    vGlow = uGlow;
  } else { vGCol = uStemCol * mix(0.45, 1.0, t); vGlow = 0.0; }
  vTrans = 0.6;
#else
  float ao = mix(0.42, 1.0, smoothstep(0.0, 0.85, t));
  vec3 tip = bc * vec3(1.18, 1.16, 0.86) + vec3(0.025, 0.022, 0.0);
  vGCol = mix(bc * ao, tip, smoothstep(0.55, 1.0, t)) * (0.86 + 0.28 * rnd);
  // glowing blades come in patches (a few metres across), not as uniform frost
  vec3 gpc = floor((uAnchor + base) * 0.3);
  float gpatch = smoothstep(0.55, 0.85, fract(sin(dot(gpc, vec3(12.9898, 78.233, 37.719))) * 43758.5453));
  vGlow = uGlow * smoothstep(0.55, 1.0, t) * step(0.6, rnd) * gpatch;
  vTrans = t * t;
#endif
  float back = pow(max(dot(normalize(toC), uKeyDir), 0.0), 5.0);
  vTrans *= 0.22 + 1.6 * back;
  vec3 objectNormal = bn;
`;

function makeBladeMaterial(U, flower, spike = false) {
  const mat = new THREE.MeshStandardMaterial({ roughness: flower ? 0.6 : 0.52, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.85 });
  return patchMaterial(mat, U, (sh) => {
    if (flower) sh.defines = { ...(sh.defines || {}), FLOWER: '' };
    if (spike) sh.defines.SPIKE = '';
    sh.vertexShader = BLADE_VERT + sh.vertexShader
      .replace('#include <beginnormal_vertex>', BLADE_BODY)
      .replace('#include <begin_vertex>', 'vec3 transformed = p;');
    sh.fragmentShader = 'varying vec3 vGCol;\nvarying float vTrans;\nvarying float vGlow;\nuniform vec3 uKeyColor;\nuniform float uNight;\nuniform float uTransK;\nuniform vec3 uGlowCol;\n#ifdef SPIKE\nvarying vec2 vQ;\n#endif\n' + sh.fragmentShader
      .replace('#include <color_fragment>', `diffuseColor.rgb = vGCol;
#ifdef SPIKE
  // florets are five-lobed blossoms cut from their quads, brighter at the heart
  float fr = length(vQ);
  if (fr > 1e-3) {
    float fa = atan(vQ.y, vQ.x);
    if (fr > 0.5 + 0.5 * pow(abs(cos(fa * 2.5)), 0.7)) discard;
    diffuseColor.rgb *= 0.78 + 0.32 * smoothstep(0.9, 0.1, fr);
  }
#endif`)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n#ifndef FLAT_SHADED\nnormal = normalize( vNormal );\n#endif')
      .replace('#include <opaque_fragment>', 'outgoingLight += vGCol * uKeyColor * vTrans * uTransK + mix(vGCol, uGlowCol, 0.9) * vGlow * (0.12 + 2.0 * uNight);\n#include <opaque_fragment>');
  }, flower ? (spike ? 'flora-spike' : 'flora-flower') : 'flora-grass');
}

// Leaf litter: flat fallen leaves on the forest floor (maple / golden worlds).
const LITTER_BODY = /* glsl */ `
  vec3 base = aOff.xyz;
  vec3 gUp = normalize(uAnchor + base);
  vec3 toC = base - uCam;
  float dC = length(toC);
  float fDen = clamp(uR0 * uR0 / max(dC * dC, 1e-3), 0.0, 1.0);
  float vis = (1.0 - smoothstep(fDen * 0.7, fDen, aOff.w)) * (1.0 - smoothstep(uFar * 0.6, uFar, dC));
  vec3 ref = abs(gUp.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(ref, gUp)); vec3 t2 = cross(gUp, t1);
  vec3 side = t1 * cos(aDat.x) + t2 * sin(aDat.x);
  vec3 fwd = cross(gUp, side);
  float sz = aDat.y * vis * clamp(dC / uR0, 1.0, 2.0);
  float curl = aDat.z * dot(position.xz, position.xz);
  vec3 p = base + (side * position.x + fwd * position.z) * sz + gUp * (0.015 + curl * sz);
  vLUv = position.xz * 2.0;
  vGCol = fl_unpack(aDat.w);
  vec3 objectNormal = normalize(gUp + (side * position.x + fwd * position.z) * aDat.z * 0.8);
  vTrans = 0.0; vGlow = 0.0;
`;
function makeLitterMaterial(U) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
  return patchMaterial(mat, U, (sh) => {
    sh.vertexShader = BLADE_VERT + 'varying vec2 vLUv;\n' + sh.vertexShader
      .replace('#include <beginnormal_vertex>', LITTER_BODY)
      .replace('#include <begin_vertex>', 'vec3 transformed = p;');
    sh.fragmentShader = 'varying vec3 vGCol;\nvarying float vTrans;\nvarying float vGlow;\nvarying vec2 vLUv;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', `float la = atan(vLUv.y, vLUv.x), lr = length(vLUv);
  float lobes = 0.55 + 0.45 * pow(abs(cos(la * 2.5 + 1.57)), 0.6);
  if (lr > lobes) discard;
  diffuseColor.rgb = vGCol * (0.8 + 0.25 * (1.0 - lr / lobes)) * (1.0 - 0.3 * smoothstep(0.04, 0.0, abs(vLUv.x)));`);
  }, 'flora-litter');
}

export class Grass {
  constructor(flora) {
    this.flora = flora;
    this.world = flora.world;
    this.P = flora.profile.grass;
    this.F = flora.profile.flowers;
  }

  init() {
    const fl = this.flora, q = fl.engine.quality, w = this.world, P = this.P;
    const qd = q.pick(0.28, 0.55, 1, 1.35);
    this.dens0 = P.density * 62 * qd;              // blades per m² inside r0
    this.fdens0 = (this.F?.density || 0) * 9 * qd;  // flowers per m² inside r0 (in patches)
    this.r0 = q.pick(9, 11, 13, 15);
    this.far = q.pick(42, 62, 88, 115) * (P.far || 1);
    this.R = w.radius;
    this.sea = w.hasOcean ? w.seaLevel : -Infinity;
    this.seed = fl.seed;
    this.sites = w.sites || [];
    this.vtx = new Map(); // corner climate cache

    this.U = {
      uAnchor: fl.uniforms.uAnchor, uKeyColor: fl.uniforms.uKeyColor, uKeyDir: fl.uniforms.uKeyDir, uNight: fl.uniforms.uNight,
      uTime: w.uniforms.uTime, uWind: w.uniforms.uWind,
      uCam: fl.uniforms.uCam, uPlayer: fl.uniforms.uPlayer,
      uR0: { value: this.r0 }, uFar: { value: this.far }, uWidthMax: { value: 3.2 }, uStiff: { value: P.stiff ?? 1 },
      uGlow: { value: P.glow || 0 }, uTransK: { value: 0.16 }, uGlowCol: { value: new THREE.Color(P.glowCol || '#6fe8ff') },
    };
    this.mat = makeBladeMaterial(this.U, false);
    this.geo = bladeGeometry(q.level >= 2 ? 4 : 3);
    this.mesh = this._mesh(this.geo, this.mat);
    if (this.fdens0 > 0) {
      this.FU = { ...this.U, uStemCol: { value: new THREE.Color(P.colors[1]).multiplyScalar(0.85) }, uHeadSize: { value: this.F.size || 0.05 }, uGlow: { value: this.F.glow || 0 }, uGlowCol: { value: new THREE.Color(this.F.glowCol || P.glowCol || '#6fe8ff') }, uWidthMax: { value: 2.0 }, uTransK: { value: 0.25 } };
      const spike = this.F.style === 'spike';
      this.fmat = makeBladeMaterial(this.FU, true, spike);
      this.fgeo = spike ? spikeGeometry(q.level >= 2 ? 7 : 5) : flowerGeometry();
      this.fmesh = this._mesh(this.fgeo, this.fmat);
    }
    this.Lt = fl.profile.litter;
    if (this.Lt) {
      this.LU = { ...this.U, uFar: { value: Math.min(this.far, 45) } };
      this.lmat = makeLitterMaterial(this.LU);
      const lg = new THREE.InstancedBufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5], 3));
      lg.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
      lg.setIndex([0, 2, 1, 0, 3, 2]);
      this.lgeo = lg;
      this.lmesh = this._mesh(lg, this.lmat);
      this.lmesh.receiveShadow = true;
    }
    this.layer = new CellLayer({
      R: this.R, cellSize: CELL, radius: this.far, moveThresh: 2, cacheMax: 600,
      tierOf: (dm) => { const dmin = Math.max(0, dm - 5); return dmin > this.far ? -1 : dmin <= this.r0 ? 0 : Math.min(14, Math.ceil(Math.log2((dmin * dmin) / (this.r0 * this.r0)) * 2)); },
      covers: (c, tier) => c.data && c.data.gen >= this._need(tier) && (tier > 2 || c.data.fine),
      build: (c, tier) => this._build(c, tier),
    });
  }

  _mesh(geo, mat) {
    const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(STRIDE * 1024), STRIDE, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aOff', new THREE.InterleavedBufferAttribute(buf, 4, 0));
    geo.setAttribute('aDat', new THREE.InterleavedBufferAttribute(buf, 4, 4));
    geo.instanceCount = 0;
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false; m.castShadow = false; m.receiveShadow = true;
    m.renderOrder = 1;
    this.flora.group.add(m);
    return m;
  }

  _need(tier) { return Math.ceil(CELL * CELL * 1.25 * this.dens0 * Math.pow(2, -tier / 2)); }

  _corner(face, gi, gj, N) {
    const k = (face * (N + 1) + gi) * (N + 1) + gj;
    let v = this.vtx.get(k);
    if (v) return v;
    faceDir(face, (gi / N) * 2 - 1, (gj / N) * 2 - 1, _dir);
    const s = this.world.terrain.sample(_dir[0], _dir[1], _dir[2]);
    let g = 1;
    if (this.sea > -1e8 && s.h < this.sea + 0.2) g = 0.0;
    // bare rock, except on wet worlds where moss, ferns and grass tufts cling to it
    const rockK = THREE.MathUtils.smoothstep(s.rock + s.cliff * 0.7, 0.32, 0.62);
    g *= 1 - rockK * (1 - (this.P.rockVeg ?? 0.1) * THREE.MathUtils.smoothstep(s.moisture, 0.35, 0.7));
    g *= 1 - THREE.MathUtils.smoothstep(s.snow, 0.25, 0.55);
    g *= 1 - THREE.MathUtils.smoothstep(s.sand, 0.3, 0.6);
    if (s.biome === 8) g = 0;
    g *= THREE.MathUtils.lerp(1, THREE.MathUtils.smoothstep(s.moisture, 0.04, 0.32), this.P.needsWater ?? 1);
    v = { g, m: s.moisture, t: s.temp, wet: Math.max(s.wet || 0, s.river || 0), h: s.h };
    if (this.vtx.size > 60000) this.vtx.clear();
    this.vtx.set(k, v);
    return v;
  }

  _siteClear(x, y, z) { return this.flora.siteClear(x, y, z, 0.78); }

  _build(c, tier) {
    const { face, i, j, N } = c;
    const fine = tier <= 2;
    const G = fine ? 9 : 5;
    const gen = this._need(tier), full = this._need(0);
    const R = this.R, sea = this.sea, P = this.P;
    // cell center (absolute) — blade offsets are stored relative to it
    faceDir(face, ((i + 0.5) / N) * 2 - 1, ((j + 0.5) / N) * 2 - 1, _dir);
    const hc = this.world.terrain.height(_dir[0], _dir[1], _dir[2]);
    const cx = _dir[0] * (R + hc), cy = _dir[1] * (R + hc), cz = _dir[2] * (R + hc);
    // height grid
    const H = new Float32Array(G * G);
    for (let gi = 0; gi < G; gi++) for (let gj = 0; gj < G; gj++) {
      faceDir(face, ((i + gi / (G - 1)) / N) * 2 - 1, ((j + gj / (G - 1)) / N) * 2 - 1, _dir);
      H[gi * G + gj] = this.world.terrain.height(_dir[0], _dir[1], _dir[2]);
    }
    const c00 = this._corner(face, i, j, N), c10 = this._corner(face, i + 1, j, N), c01 = this._corner(face, i, j + 1, N), c11 = this._corner(face, i + 1, j + 1, N);
    const cellG = Math.max(c00.g, c10.g, c01.g, c11.g);
    const shoreCell = sea > -1e8 && Math.min(c00.h, c10.h, c01.h, c11.h) < sea + 1.6 && Math.max(c00.h, c10.h, c01.h, c11.h) > sea - 0.8;
    const siteK0 = this._siteClear(cx, cy, cz);
    const out = [], fout = [], out2 = [];
    if ((cellG > 0.01 || shoreCell) && siteK0 > 0) {
      const rng = cellRng(this.seed, 11, face, i, j);
      const cols = P.colors.map((h) => new THREE.Color(h));
      const dry = new THREE.Color(P.dry || '#b8a868'), reed = new THREE.Color(P.reed || '#5f7a3a');
      const nz = this.flora.noiseScale;
      const cellM = (Math.PI * 0.5 * R) / N;
      const slopeK = (G - 1) / cellM;
      for (let k = 0; k < gen; k++) {
        const u = rng(), v = rng(), r1 = rng(), r2 = rng(), r3 = rng();
        const fu = u * (G - 1), fv = v * (G - 1);
        const iu = Math.min(G - 2, fu | 0), iv = Math.min(G - 2, fv | 0), du = fu - iu, dv = fv - iv;
        const h00 = H[iu * G + iv], h10 = H[(iu + 1) * G + iv], h01 = H[iu * G + iv + 1], h11 = H[(iu + 1) * G + iv + 1];
        const h = (h00 * (1 - du) + h10 * du) * (1 - dv) + (h01 * (1 - du) + h11 * du) * dv;
        const gx = ((h10 - h00) * (1 - dv) + (h11 - h01) * dv) * slopeK, gy = ((h01 - h00) * (1 - du) + (h11 - h10) * du) * slopeK;
        const slope = gx * gx + gy * gy; // tan²
        const wu = (1 - u) * (1 - v), wv = u * (1 - v), wx = (1 - u) * v, wy = u * v;
        let g = c00.g * wu + c10.g * wv + c01.g * wx + c11.g * wy;
        const moist = c00.m * wu + c10.m * wv + c01.m * wx + c11.m * wy;
        const wet = c00.wet * wu + c10.wet * wv + c01.wet * wx + c11.wet * wy;
        faceDir(face, ((i + u) / N) * 2 - 1, ((j + v) / N) * 2 - 1, _dir);
        const rr = R + h;
        const x = _dir[0] * rr, y = _dir[1] * rr, z = _dir[2] * rr;
        let isReed = false;
        if (sea > -1e8 && h < sea + 1.1) {
          if (h > sea - 0.45 && moist > 0.3 && P.reeds !== false) { isReed = true; g = Math.max(g, 0.85); }
          else if (h < sea + 0.12) continue;
        }
        if (wet > 0.5 && P.reeds !== false && r3 < wet * 0.5) isReed = true;
        if (slope > 0.9) continue;
        g *= 1 - THREE.MathUtils.smoothstep(slope, 0.35, 0.9);
        // patches: clumps and bare spots, plus taller meadows
        const n1 = valueNoise3(x * nz.patch, y * nz.patch, z * nz.patch, 7);
        const n2 = valueNoise3(x * nz.color, y * nz.color, z * nz.color, 19);
        g *= THREE.MathUtils.smoothstep(n1 + (P.cover ?? 0.35), -0.15, 0.35);
        // settlement edges: thinner and shorter (grazed / mown) rather than bare
        const clr = siteK0 < 1 ? this._siteClear(x, y, z) : 1;
        g *= Math.sqrt(clr);
        if (r1 > g) continue;
        // colour: palette blend by macro noise + moisture, dry patches, per-blade jitter
        const ci = THREE.MathUtils.clamp((n2 * 0.5 + 0.5) * (cols.length - 1) + (r2 - 0.5) * 0.9, 0, cols.length - 1);
        const i0 = Math.floor(ci), i1 = Math.min(cols.length - 1, i0 + 1);
        _c.copy(cols[i0]).lerp(cols[i1], ci - i0);
        const dryK = THREE.MathUtils.clamp((0.42 - moist) * 2.2 + (P.dryBias || 0) + n1 * 0.25, 0, 1);
        _c.lerp(dry, dryK * 0.85);
        // clump-scale hue/value drift (warm sunlit tufts vs cool deep clumps)
        const n3 = valueNoise3(x * 0.45, y * 0.45, z * 0.45, 61);
        _c.multiplyScalar(0.84 + 0.3 * (n3 * 0.5 + 0.5));
        _c.r *= 1 + 0.16 * n3; _c.b *= 1 - 0.12 * n3;
        let hh = THREE.MathUtils.lerp(P.h[0], P.h[1], r3 * r3) * (0.75 + 0.5 * (n1 * 0.5 + 0.5)) * (0.55 + 0.45 * g) * (0.4 + 0.6 * clr);
        let ww = THREE.MathUtils.lerp(P.w[0], P.w[1], r2);
        if (isReed) { _c.copy(reed).multiplyScalar(0.8 + r2 * 0.4); hh = 0.9 + r3 * 1.1; ww *= 1.5; }
        out.push(x - cx, y - cy, z - cz, k / full, r2 * 6.2832 + u * 31.4, hh, ww, packColor(_c));
      }
      // fallen leaves under the forest canopy
      if (this.Lt) {
        const Lt = this.Lt, lfz = this.flora.noiseScale.forest;
        const lfull = Math.ceil(CELL * CELL * Lt.density), lgen = Math.ceil(lfull * gen / full);
        const lrng = cellRng(this.seed, 29, face, i, j);
        const lcols = Lt.colors.map((h) => new THREE.Color(h));
        for (let k = 0; k < lgen; k++) {
          const u = lrng(), v = lrng(), r1 = lrng(), r2 = lrng(), r3 = lrng();
          const fu = u * (G - 1), fv = v * (G - 1);
          const iu = Math.min(G - 2, fu | 0), iv = Math.min(G - 2, fv | 0), du = fu - iu, dv = fv - iv;
          const h = (H[iu * G + iv] * (1 - du) + H[(iu + 1) * G + iv] * du) * (1 - dv) + (H[iu * G + iv + 1] * (1 - du) + H[(iu + 1) * G + iv + 1] * du) * dv;
          if (sea > -1e8 && h < sea + 0.3) continue;
          faceDir(face, ((i + u) / N) * 2 - 1, ((j + v) / N) * 2 - 1, _dir);
          const rr = R + h;
          const x = _dir[0] * rr, y = _dir[1] * rr, z = _dir[2] * rr;
          const fm = valueFbm3(x * lfz, y * lfz, z * lfz, 3);
          const pr = THREE.MathUtils.smoothstep(fm + 0.3 + (Lt.cover ?? 0), 0.0, 0.4) * 0.85 + 0.15 * (valueNoise3(x * 0.2, y * 0.2, z * 0.2, 83) * 0.5 + 0.5);
          if (r1 > pr) continue;
          _c.copy(lcols[Math.floor(r2 * lcols.length * 0.999)]).multiplyScalar(0.55 + 0.5 * r3);
          if (r3 < 0.25) _c.lerp(new THREE.Color(Lt.dead || '#5a3a24'), 0.6);
          out2.push(x - cx, y - cy, z - cz, k / lfull, r3 * 6.2832 + u * 17.0, (Lt.size || 0.12) * (0.7 + 0.6 * r2), 0.35 + r1 * 0.5, packColor(_c));
        }
      }
      // wildflowers: own stream, patchy
      if (this.fdens0 > 0) {
        const F = this.F;
        const ratio = this.fdens0 / this.dens0, fgen = Math.ceil(gen * ratio), ffull = Math.ceil(full * ratio);
        const frng = cellRng(this.seed, 23, face, i, j);
        const fcols = F.colors.map((h) => new THREE.Color(h));
        for (let k = 0; k < fgen; k++) {
          const u = frng(), v = frng(), r1 = frng(), r2 = frng(), r3 = frng();
          const fu = u * (G - 1), fv = v * (G - 1);
          const iu = Math.min(G - 2, fu | 0), iv = Math.min(G - 2, fv | 0), du = fu - iu, dv = fv - iv;
          const h = (H[iu * G + iv] * (1 - du) + H[(iu + 1) * G + iv] * du) * (1 - dv) + (H[iu * G + iv + 1] * (1 - du) + H[(iu + 1) * G + iv + 1] * du) * dv;
          if (sea > -1e8 && h < sea + 0.6) continue;
          const wu = (1 - u) * (1 - v), wv = u * (1 - v), wx = (1 - u) * v, wy = u * v;
          let g = c00.g * wu + c10.g * wv + c01.g * wx + c11.g * wy;
          faceDir(face, ((i + u) / N) * 2 - 1, ((j + v) / N) * 2 - 1, _dir);
          const rr = R + h;
          const x = _dir[0] * rr, y = _dir[1] * rr, z = _dir[2] * rr;
          const fp = valueNoise3(x * nz.flower, y * nz.flower, z * nz.flower, 41);
          g *= THREE.MathUtils.smoothstep(fp, F.patch ?? 0.15, (F.patch ?? 0.15) + 0.35) * (0.15 + 0.85 * THREE.MathUtils.smoothstep(fp, 0.2, 0.55)) + (F.scatter ?? 0.03);
          if (siteK0 < 1) g *= this._siteClear(x, y, z);
          if (r1 > g) continue;
          // one colour dominates a patch, a few others sprinkle through it
          const pc = Math.floor((valueNoise3(x * nz.flower * 0.5, y * nz.flower * 0.5, z * nz.flower * 0.5, 53) * 0.5 + 0.5) * fcols.length * 0.999);
          const col = r3 < 0.78 ? fcols[pc] : fcols[Math.floor(r3 * 4.5 * fcols.length) % fcols.length];
          _c.copy(col).multiplyScalar(0.8 + 0.35 * r2);
          const hh = THREE.MathUtils.lerp(F.h[0], F.h[1], r2);
          fout.push(x - cx, y - cy, z - cz, k / ffull, r3 * 6.2832, hh, 0.012, packColor(_c));
        }
      }
    }
    c.data = { gen, fine, cx, cy, cz, blades: new Float32Array(out), flowers: new Float32Array(fout), litter: new Float32Array(out2), fgen: gen };
  }

  _count(c, arr) {
    // the cell's prefix for its tier (data is in rank order; ranks are k/gen)
    const need = this._need(c.tier) / this._need(0);
    if (need >= 1 || c.data.gen <= this._need(c.tier)) return arr.length / STRIDE;
    let lo = 0, hi = arr.length / STRIDE;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m * STRIDE + 3] < need) lo = m + 1; else hi = m; }
    return lo;
  }

  _pack(mesh, which) {
    const anchor = this.flora.anchor;
    let total = 0;
    for (const c of this.layer.active.values()) if (c.data) total += this._count(c, c.data[which]);
    const attr = mesh.geometry.getAttribute('aOff');
    let buf = attr.data;
    if (buf.array.length < total * STRIDE) {
      const nb = new THREE.InstancedInterleavedBuffer(new Float32Array(Math.ceil(total * 1.3 + 1024) * STRIDE), STRIDE, 1);
      nb.setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.setAttribute('aOff', new THREE.InterleavedBufferAttribute(nb, 4, 0));
      mesh.geometry.setAttribute('aDat', new THREE.InterleavedBufferAttribute(nb, 4, 4));
      mesh.geometry._maxInstanceCount = undefined; // three caches the instance cap from the first buffer it bound
      buf = nb;
    }
    const A = buf.array;
    let o = 0;
    for (const c of this.layer.active.values()) {
      if (!c.data) continue;
      const src = c.data[which], n = this._count(c, src);
      const ox = c.data.cx - anchor.x, oy = c.data.cy - anchor.y, oz = c.data.cz - anchor.z;
      for (let k = 0; k < n; k++) {
        const s = k * STRIDE;
        A[o] = src[s] + ox; A[o + 1] = src[s + 1] + oy; A[o + 2] = src[s + 2] + oz;
        A[o + 3] = src[s + 3]; A[o + 4] = src[s + 4]; A[o + 5] = src[s + 5]; A[o + 6] = src[s + 6]; A[o + 7] = src[s + 7];
        o += STRIDE;
      }
    }
    buf.clearUpdateRanges?.();
    buf.addUpdateRange?.(0, o);
    buf.needsUpdate = true;
    mesh.geometry.instanceCount = o / STRIDE;
  }

  update(focus, budget, force) {
    if (!this.layer) return;
    this.layer.update(focus, budget, force);
    if (this.layer.dirty || this.flora.reanchored) {
      this.layer.dirty = false;
      this._pack(this.mesh, 'blades');
      if (this.fmesh) this._pack(this.fmesh, 'flowers');
      if (this.lmesh) this._pack(this.lmesh, 'litter');
    }
  }

  get count() { return (this.mesh?.geometry.instanceCount || 0) + (this.fmesh?.geometry.instanceCount || 0); }

  dispose() {
    this.geo?.dispose(); this.mat?.dispose(); this.fgeo?.dispose(); this.fmat?.dispose(); this.lgeo?.dispose(); this.lmat?.dispose();
  }
}
