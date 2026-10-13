// Giants — the awe moments.
//
// • Sandworm (dune worlds): a 16 m-thick, 480 m-long segmented worm breaching
//   the dunes in a great arc. The geometry is a tube in parameter space; the
//   vertex shader slides it along a circular spine that dives through the
//   ground, so the worm surges out of the sand, arches and plunges back in.
//   Ring ridges, sand-dusted back, a three-lobed maw with a glowing throat.
//   Sand cascades: GPU billboards erupting where the body breaks the surface.
// • Colossus (Ueda worlds): a moss-and-stone giant ~110 m tall walking slowly
//   across the far plains; bipedal walk cycle on the GPU, fog makes it a
//   silhouette against the haze.
import * as THREE from 'three';
import { Random, seedFrom } from '../../../core/Random.js';
import { TAU, clamp, smooth, lerp, rigMaterial, paint, mergeParts, blob, limb, vnoise, tangentBasis } from './common.js';

// ---------------------------------------------------------------------------------
const WORM_RIG = /* glsl */ `
uniform float uHead;   // arc angle of the head
uniform float uArcR;   // spine circle radius
uniform float uDepth;  // spine circle centre depth below ground
uniform float uBodyLen;
uniform float uRad;
varying float vWormY;
float wormSeg(float s, out float f, out float hv) {
  // armour rings of varying pitch (6–14 m): integrate a hashed pitch along the body
  float x = s * uBodyLen / 10.0;
  float i = floor(x); hv = fract(sin(i * 12.9898) * 43758.5453);
  f = fract(x);
  f = clamp((f - 0.5) * (1.0 + (hv - 0.5) * 0.6) + 0.5, 0.0, 1.0);
  return i;
}
float wormR(float s, float a) {
  float f, hv; wormSeg(s, f, hv);
  // shingled plates: each ring swells toward its leading (head-ward) edge, then steps down into the seam
  // low-relief shingles: the mass reads first, the armour only up close
  float shingle = 0.965 + 0.035 * smoothstep(0.0, 0.85, f) - 0.03 * smoothstep(0.9, 1.0, f);
  float prof = mix(0.78, 1.0, smoothstep(0.0, 0.45, s)) * (1.0 + 0.12 * smoothstep(0.6, 0.93, s) * (1.0 - smoothstep(0.93, 0.975, s) * 0.3));
  float maw = smoothstep(0.965, 1.0, s);
  float lobes = pow(0.5 + 0.5 * cos(a * 3.0), 0.6);
  float back = 1.0 + 0.05 * max(0.0, sin(a)) * (hv - 0.3);
  // three thick petals flare wide open; deep notches between them
  return uRad * prof * shingle * back * (1.0 + maw * (0.22 + 0.95 * lobes));
}
void rig(inout vec3 p, inout vec3 n) {
  float s = aRig.x;         // 0 tail .. 1 head
  float a = aRig.y;         // angle around the body
  float phi = uHead - (1.0 - s) * uBodyLen / uArcR;
  vec3 C = vec3(0.0, -uDepth + uArcR * cos(phi), uArcR * sin(phi));
  vec3 T = vec3(0.0, -sin(phi), cos(phi));
  vec3 N = vec3(0.0, cos(phi), sin(phi));
  // the head section rears up along the outward normal, then the face turns down toward its prey
  float rear = smoothstep(0.8, 1.0, s);
  C += N * rear * rear * uRad * 2.6;
  T = normalize(T + N * rear * 0.8);
  vec3 B = vec3(1.0, 0.0, 0.0);
  float maw = smoothstep(0.962, 1.0, s);
  float lobes = pow(0.5 + 0.5 * cos(a * 3.0), 0.6);
  float r = wormR(s, a);
  float ds = 0.6 / uBodyLen;
  float dr = (wormR(s + ds, a) - wormR(s - ds, a)) / 1.2;
  vec3 off = cos(a) * B + sin(a) * N;
  // three petal lips peel open and curl back: forward along T at the lobe centres, retracted between them
  // petals peel open forward-and-out (curling back at the tips), notches retract: a real three-jawed maw
  float tip = smoothstep(0.985, 1.0, s);
  vec3 surf = C + off * r + T * maw * (lobes * 1.45 - 0.55) * uRad * 0.6 - T * tip * lobes * uRad * 0.35 - off * maw * maw * (1.0 - lobes) * uRad * 0.35;
  if (aGlow > 1.5) {
    // a real 3D tooth: a cone rooted on the inner wall, raked inward and back toward the gullet (lamprey rows)
    vec3 D = normalize(-off + T * aRig.w);
    vec3 L1 = normalize(cross(D, T)), L2 = normalize(cross(L1, D));
    float h = p.z;
    p = surf - off * uRad * 0.04 + D * h * aRig.z * uRad + (L1 * p.x + L2 * p.y) * uRad * aRig.z * 0.26 * (1.0 - h);
    n = normalize(L1 * position.x + L2 * position.y + D * 0.35);
  } else {
    p = surf;
    n = normalize(off - T * clamp(dr, -2.0, 2.0) - T * 0.5 * maw);
  }
  vWormY = p.y;
}
`;

function buildWormGeo(rings, around) {
  const pos = [], nor = [], col = [], rigA = [], glow = [], idx = [];
  const sand = new THREE.Color('#6e6052'), dark = new THREE.Color('#1e1814'), throat = new THREE.Color('#1a0806');
  for (let i = 0; i <= rings; i++) {
    const s = i / rings;
    for (let j = 0; j <= around; j++) {
      const a = (j / around) * TAU;
      pos.push(Math.cos(a), Math.sin(a), s); nor.push(Math.cos(a), Math.sin(a), 0);
      const top = Math.sin(a) * 0.5 + 0.5;
      const groove = smooth(0.0, 0.3, Math.abs(Math.sin(s * (620 / 7.5) * Math.PI)));
      const nz = vnoise(s * 400, Math.cos(a) * 3, Math.sin(a) * 3);
      let k = clamp(0.15 + 0.85 * groove * (0.35 + 0.65 * top * top), 0, 1) * (0.75 + 0.5 * nz);
      let c = [lerp(dark.r, sand.r, k), lerp(dark.g, sand.g, k), lerp(dark.b, sand.b, k)];
      const m = smooth(0.975, 0.995, s);
      c = [lerp(c[0], throat.r, m), lerp(c[1], throat.g, m), lerp(c[2], throat.b, m)];
      col.push(...c);
      rigA.push(s, a, 0, 0);
      glow.push(smooth(0.985, 1.0, s) * 0.6);
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < around; j++) {
    const a = i * (around + 1) + j, b = a + around + 1;
    idx.push(a, a + 1, b, b, a + 1, b + 1); // outward-facing (front = hide, back = inside the maw)
  }
  // teeth: concentric rings receding into the throat, big at the lips, smaller and denser deeper in
  const TS = 7;
  for (const [s0, nT, len, back] of [[0.991, 18, 0.5, -0.25], [0.983, 22, 0.42, -0.45], [0.975, 26, 0.34, -0.6], [0.967, 30, 0.26, -0.75], [0.959, 30, 0.2, -0.9]]) {
    for (let t = 0; t < nT; t++) {
      const a0 = ((t + (nT % 4) * 0.25 + s0 * 37) / nT) * TAU, l = len * (0.75 + 0.5 * vnoise(t * 3.1, s0 * 90, 1.7));
      const b0 = pos.length / 3;
      for (let k = 0; k < TS; k++) { const q = (k / TS) * TAU; pos.push(Math.cos(q), Math.sin(q), 0); nor.push(Math.cos(q), Math.sin(q), 0); col.push(0.5, 0.45, 0.36); rigA.push(s0, a0, l, back); glow.push(2); }
      pos.push(0, 0, 1); nor.push(0, 0, 1); col.push(0.62, 0.58, 0.5); rigA.push(s0, a0, l, back); glow.push(2);
      for (let k = 0; k < TS; k++) idx.push(b0 + k, b0 + (k + 1) % TS, b0 + TS);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aRig', new THREE.Float32BufferAttribute(rigA, 4));
  g.setAttribute('aGlow', new THREE.Float32BufferAttribute(glow, 1));
  g.setAttribute('aAnim', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3 * 4), 4));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 600);
  return g;
}

const WORM_SURFACE = /* glsl */ `
uniform float uRad;
varying float vWormY;
void faSurface(vec3 p, vec3 n, inout vec3 col, inout float glow) {
  float s = p.z;
  float x = s * 620.0 / 10.0, ring = floor(x), f = fract(x);
  float hv = faHash(vec3(ring, 1.7, 3.1));
  f = clamp((f - 0.5) * (1.0 + (hv - 0.5) * 0.6) + 0.5, 0.0, 1.0);
  float ang = atan(p.y, p.x);
  float top = p.y * 0.5 + 0.5;
  if (glow > 1.5) {
    // ivory enamel, stained at the root, receding rows darken into the gullet
    float dRow = smoothstep(0.993, 0.958, s);
    col = mix(vec3(0.16, 0.11, 0.07), vec3(0.62, 0.57, 0.47), smoothstep(0.0, 0.7, p.z)) * mix(1.0, 0.22, dRow) * (0.85 + 0.3 * faNoise(vec3(p.xy * 3.0, s * 900.0)));
    glow = 0.0;
    return;
  }
  if (!gl_FrontFacing) {
    // inside the maw: wet dark flesh, concentric rows of pale crystalline teeth, a furnace glow deep in the throat
    float depth = smoothstep(1.0, 0.94, s);
    float rowF = fract(s * 620.0 / 4.0);
    float tooth = faLine(fract(ang * 15.0 / 6.2831853 + floor(s * 620.0 / 4.0) * 0.5) - 0.5, 0.2 * (1.0 - rowF)) * smoothstep(0.0, 0.2, rowF) * (1.0 - smoothstep(0.55, 0.85, rowF));
    float wet = faNoise(vec3(s * 300.0, p.x * 6.0, p.y * 6.0));
    // a dark wet cavern: ivory teeth crowd the lips, the throat falls away into near-black with a faint ember far down
    col = mix(vec3(0.045, 0.014, 0.011) * (0.7 + 0.6 * wet), vec3(0.14, 0.1, 0.08), tooth * 0.5 * (1.0 - depth * 0.8)) * mix(1.0, 0.18, depth);
    // wet ribbed gullet: concentric folds catching a sheen
    col *= 0.75 + 0.5 * smoothstep(0.3, 0.9, sin(s * 620.0 * 1.4 + wet * 2.0) * 0.5 + 0.5);
    glow = max(glow, pow(depth, 4.0) * 0.05 + 0.002);
    return;
  }
  float seam = 1.0 - smoothstep(0.0, 0.04 + 0.03 * hv, min(f, 1.0 - f));
  float nz = faNoise(vec3(s * 260.0, p.x * 5.0, p.y * 5.0)), nz2 = faNoise(vec3(s * 900.0, p.x * 14.0, p.y * 14.0));
  float nz3 = faNoise(vec3(s * 2400.0, p.x * 40.0, p.y * 40.0));
  // longitudinal plate cracks on the flanks
  float plate = faLine(sin(ang * 7.0 + hv * 6.0), 0.04) * smoothstep(0.85, 0.3, top);
  // hide value drifts slowly along the body (not per ring: no banded hose)
  float nzS = faNoise(vec3(s * 70.0, p.x * 1.5, p.y * 1.5));
  vec3 hide = mix(vec3(0.075, 0.056, 0.043), vec3(0.15, 0.112, 0.078), nzS) * (0.78 + 0.32 * nz2) * (0.88 + 0.24 * nz3) * (0.94 + 0.12 * hv);
  // dust settles on the upper armour (soft, uniform), sand packs into the seams (bright, granular)
  vec3 dust = vec3(0.36, 0.26, 0.16) * (0.85 + 0.3 * nz);
  vec3 sand = vec3(0.42, 0.3, 0.18) * (0.8 + 0.4 * nz3);
  float dusty = smoothstep(0.55, 1.0, top) * (0.15 + 0.35 * nz) * smoothstep(0.2, 0.9, f);
  vec3 c = mix(hide, dust, dusty);
  c = mix(c, sand, seam * (0.16 + 0.2 * top));
  c *= 1.0 - 0.3 * plate;
  // the body surges up caked in sand: a thick granular coat near the dune surface, streaming off higher up
  float streak = faNoise(vec3(s * 40.0, ang * 3.0, 0.0));
  float caked = 1.0 - smoothstep(0.0, uRad * (1.4 + 1.2 * streak), vWormY + (nz - 0.5) * uRad * 0.6);
  vec3 caked3 = vec3(0.5, 0.35, 0.21) * (0.8 + 0.35 * nz3) * (0.85 + 0.25 * nz2);
  c = mix(c, caked3, clamp(caked * 0.95, 0.0, 1.0));
  col = c; glow = 0.0;
}
`;

// sand/dust plume billboards (GPU looping particles around two emitters)
const DUST_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uE0; uniform vec3 uE1; uniform vec3 uDir0; uniform vec3 uDir1;
uniform float uFTime; uniform float uScale; uniform float uOn0; uniform float uOn1;
uniform float uHead; uniform float uArcR; uniform float uDepth; uniform float uBodyLen; uniform float uRad;
varying vec2 vUv; varying float vA; varying float vH;
void main() {
  vec3 c; float size; float vStretch = 1.0;
  if (aSeed.w < 0.55) {
    // eruption clouds where the body breaks the surface
    float which = step(0.275, aSeed.w);
    vec3 E = mix(uE0, uE1, which);
    vec3 D = mix(uDir0, uDir1, which);
    float on = mix(uOn0, uOn1, which);
    float life = 6.0 + aSeed.z * 6.0;
    float age = fract(uFTime / life + aSeed.x);
    vec3 side = vec3(1.0, 0.0, 0.0);
    float spread = (aSeed.y - 0.5) * 2.0;
    c = E + side * spread * uScale * 1.6 + D * (aSeed.z - 0.4) * uScale * 1.2;
    float up = uScale * (4.6 * age - 3.2 * age * age) * (0.5 + aSeed.z);
    c.y += max(up, 0.0) + age * uScale * 0.6 + uScale * 0.7;
    c += side * spread * age * uScale * 1.5 + D * age * uScale;
    size = uScale * (0.35 + age * 1.2) * (0.6 + aSeed.y * 0.6);
    vA = smoothstep(0.0, 0.06, age) * (1.0 - smoothstep(0.4, 1.0, age)) * on;
  } else if (aSeed.w < 0.72) {
    // rolling dust skirt hugging the ground around the breach
    float which = step(0.635, aSeed.w);
    vec3 E = mix(uE0, uE1, which);
    float on = mix(uOn0, uOn1, which);
    float life = 10.0 + aSeed.z * 8.0;
    float age = fract(uFTime / life + aSeed.x);
    float ang = aSeed.y * 6.2831853;
    float rad = uScale * (0.6 + 2.6 * sqrt(age) * (0.5 + aSeed.z));
    c = E + vec3(cos(ang) * rad, uScale * (0.15 + 0.5 * age), sin(ang) * rad * 0.8);
    size = uScale * (1.0 + 1.6 * age);
    vA = smoothstep(0.0, 0.15, age) * (1.0 - smoothstep(0.5, 1.0, age)) * on * 0.8;
  } else {
    // sand cascading off the arching back
    float phi0 = acos(clamp(uDepth / uArcR, -1.0, 1.0));
    float tail = uHead - uBodyLen / uArcR;
    float lo = max(-phi0, tail), hi = min(phi0, uHead - 0.05);
    float phi = mix(lo, hi, fract(aSeed.x * 7.13));
    float life = 3.0 + aSeed.z * 2.0;
    float age = fract(uFTime / life + aSeed.y);
    vec3 C = vec3(0.0, -uDepth + uArcR * cos(phi), uArcR * sin(phi));
    float side = (aSeed.z - 0.5) * 2.0;
    c = C + vec3(side * uRad * 0.9, uRad * 0.8, 0.0);
    c.x += side * age * uRad * 0.6;
    c.y -= 4.9 * age * age * life * life * 0.35;
    float above = c.y;
    // tumbling clumps that shed into soft veils as they fall (no stretched streak curtain)
    size = uScale * (0.12 + age * 0.55) * (0.6 + aSeed.y * 0.8);
    vStretch = 1.0 + age * 0.35;
    vA = smoothstep(0.0, 0.3, age) * (1.0 - smoothstep(0.45, 1.0, age)) * step(lo, hi) * smoothstep(-5.0, 15.0, above) * 0.3;
  }
  vH = clamp(c.y / (uScale * 3.0), 0.0, 1.0);
  vUv = position.xy;
  vec4 mv = modelViewMatrix * vec4(c, 1.0);
  mv.xy += position.xy * size * vec2(1.0 / sqrt(vStretch), vStretch);
  gl_Position = projectionMatrix * mv;
}
`;
const DUST_FRAG = /* glsl */ `
uniform vec3 uKeyColor; uniform vec3 uSky; uniform vec3 uSand;
varying vec2 vUv; varying float vA; varying float vH;
float dh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float dn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(dh(i), dh(i + vec2(1, 0)), f.x), mix(dh(i + vec2(0, 1)), dh(i + vec2(1, 1)), f.x), f.y); }
void main() {
  float r = length(vUv);
  // billowing edge: a little noise eats the disc so puffs overlap into a curtain, not circles
  float e = dn(vUv * 2.5 + vA * 7.0) * 0.45 + dn(vUv * 6.0 - vA * 3.0) * 0.2;
  float d = smoothstep(1.0, 0.0, r + e * 0.7 - 0.1);
  d *= d;
  float lit = 0.5 + 0.5 * (vUv.y * 0.5 + 0.5);
  vec3 col = uSand * (uKeyColor * 0.7 * lit + uSky * 0.45) * mix(0.7, 1.0, vH);
  gl_FragColor = vec4(col, d * vA * 0.8);
}
`;

/** Sand berm ring (local xz plane, elongated along z where the body crosses the dune obliquely). */
function buildBerm(rIn, rng) {
  const A = 56, Rn = 14, pos = [], col = [], idx = [];
  const lip = new THREE.Color('#c99466'), churn = new THREE.Color('#6a472d'), dune = new THREE.Color('#c08a5c');
  const ph = [rng.range(0, 9), rng.range(0, 9), rng.range(0, 9)];
  for (let i = 0; i <= Rn; i++) {
    const t = i / Rn; // 0 inner edge .. 1 outer feather
    for (let j = 0; j <= A; j++) {
      const a = (j / A) * TAU, ca = Math.cos(a), sa = Math.sin(a);
      const wob = 1 + 0.12 * Math.sin(a * 3 + ph[0]) + 0.07 * Math.sin(a * 7 + ph[1]);
      const r = rIn * (0.92 + t * 2.6 * wob);
      // profile: drops into the hole, a heaved lip ~0.35 r high, then a long slump into the dune
      const lipH = rIn * 0.38 * (0.75 + 0.5 * vnoise(ca * 2 + ph[2], sa * 2, 0.5));
      const h = t < 0.18 ? lerp(-rIn * 0.12, lipH, smooth(0, 0.18, t)) : lipH * (1 - smooth(0.18, 1, t)) ** 1.6;
      const lump = (vnoise(ca * r * 0.12, sa * r * 0.12, 3.3) - 0.5) * rIn * 0.12 * (1 - t);
      pos.push(ca * r, h + lump, sa * r * 1.22);
      const k = smooth(0.0, 0.35, t), v = 0.88 + 0.2 * vnoise(ca * r * 0.3, sa * r * 0.3, 7.1);
      const c0 = [lerp(churn.r, lip.r, k), lerp(churn.g, lip.g, k), lerp(churn.b, lip.b, k)];
      const m = smooth(0.5, 1, t);
      col.push(lerp(c0[0], dune.r, m) * v, lerp(c0[1], dune.g, m) * v, lerp(c0[2], dune.b, m) * v, 1 - smooth(0.62, 1, t));
    }
  }
  for (let i = 0; i < Rn; i++) for (let j = 0; j < A; j++) {
    const a = i * (A + 1) + j, b = a + A + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------------
const COLOSSUS_RIG = /* glsl */ `
uniform vec3 uPiv[4];   // hips (L,R), shoulders (L,R)
uniform vec3 uKnee[2];
void cSwing(inout vec3 p, inout vec3 n, vec3 piv, float a) {
  vec2 v = fa_rot(vec2(p.z - piv.z, p.y - piv.y), a);
  p.z = piv.z + v.x; p.y = piv.y + v.y;
  vec2 m = fa_rot(vec2(n.z, n.y), a); n.z = m.x; n.y = m.y;
}
void rig(inout vec3 p, inout vec3 n) {
  float ph = aAnim.x;
  int part = int(aRig.x + 0.5) - 1;
  float sway = sin(ph) * 0.05;
  if (part == 0 || part == 1) {
    float lp = ph + (part == 0 ? 0.0 : 3.14159);
    float a = 0.32 * sin(lp);
    float lift = max(0.0, cos(lp));
    if (aRig.y > 0.5) cSwing(p, n, uKnee[part], -0.6 * lift * lift);
    cSwing(p, n, uPiv[part], a);
  } else if (part >= 2) {
    float lp = ph + (part == 2 ? 3.14159 : 0.0);
    cSwing(p, n, uPiv[part], 0.22 * sin(lp));
  }
  // body bob + roll
  p.y += (1.0 - cos(ph * 2.0)) * 0.6;
  p.x += sway * p.y * 0.02;
}
`;

function buildColossus() {
  const parts = [];
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const stone = new THREE.Color('#6c665c'), moss = new THREE.Color('#4a5a32'), fur = new THREE.Color('#3a352c');
  const coat = (p, n) => {
    const m = smooth(0.2, 0.8, n.y) * smooth(0.4, 0.6, vnoise(p.x * 0.15, p.y * 0.15, p.z * 0.15));
    const f = smooth(0.55, 0.7, vnoise(p.x * 0.08 + 5, p.y * 0.08, p.z * 0.08));
    let c = [lerp(stone.r, fur.r, f), lerp(stone.g, fur.g, f), lerp(stone.b, fur.b, f)];
    c = [lerp(c[0], moss.r, m), lerp(c[1], moss.g, m), lerp(c[2], moss.b, m)];
    const v = 0.75 + 0.5 * vnoise(p.x * 0.6, p.y * 0.6, p.z * 0.6);
    return c.map((x) => x * v);
  };
  const H = 110;
  const hipY = H * 0.42, shY = H * 0.78;
  const torso = blob(H * 0.17, H * 0.22, H * 0.12, (z, x, y) => 1 + 0.15 * Math.max(0, y), 18, 14); torso.translate(0, H * 0.6, 0);
  parts.push(paint(torso, coat, () => [0, 0, 0, 0]));
  const pelvis = blob(H * 0.14, H * 0.08, H * 0.1, null, 12, 8); pelvis.translate(0, hipY + H * 0.03, 0);
  parts.push(paint(pelvis, coat, () => [0, 0, 0, 0]));
  const head = blob(H * 0.06, H * 0.07, H * 0.065, null, 12, 10); head.translate(0, H * 0.9, H * 0.04);
  parts.push(paint(head, coat, () => [0, 0, 0, 0], (p) => (p.z > H * 0.09 && Math.abs(p.y - H * 0.91) < H * 0.012 ? 1 : 0)));
  // horns / ruin crown
  for (const s of [-1, 1]) parts.push(paint(limb(V(s * H * 0.04, H * 0.94, H * 0.03), V(s * H * 0.1, H * 1.0, -H * 0.02), H * 0.015, H * 0.004, 6, 2), () => [0.2, 0.19, 0.17], () => [0, 0, 0, 0]));
  // stone plates on the back
  for (let i = 0; i < 6; i++) {
    const b = blob(H * 0.08, H * 0.03, H * 0.06, null, 8, 6);
    b.rotateX(-0.4); b.translate((i % 2 ? 1 : -1) * H * 0.06, H * (0.55 + i * 0.05), -H * 0.11);
    parts.push(paint(b, (p, n) => coat(p, n).map((x) => x * 1.2), () => [0, 0, 0, 0]));
  }
  const piv = [V(H * 0.09, hipY, 0), V(-H * 0.09, hipY, 0), V(H * 0.2, shY, 0), V(-H * 0.2, shY, 0)];
  const knees = [V(H * 0.1, H * 0.2, H * 0.02), V(-H * 0.1, H * 0.2, H * 0.02)];
  for (let i = 0; i < 2; i++) {
    parts.push(paint(limb(piv[i], knees[i], H * 0.065, H * 0.05, 10, 3), coat, () => [i + 1, 0, 0, 0]));
    parts.push(paint(limb(knees[i], V(knees[i].x, H * 0.02, 0), H * 0.05, H * 0.045, 10, 3), coat, () => [i + 1, 1, 0, 0]));
    const foot = blob(H * 0.05, H * 0.025, H * 0.075, null, 10, 6); foot.translate(knees[i].x, H * 0.02, H * 0.02);
    parts.push(paint(foot, coat, () => [i + 1, 1, 0, 0]));
  }
  for (let i = 2; i < 4; i++) {
    const s = i === 2 ? 1 : -1;
    const el = V(s * H * 0.25, H * 0.5, H * 0.02);
    parts.push(paint(limb(piv[i], el, H * 0.05, H * 0.04, 10, 3), coat, () => [i + 1, 0, 0, 0]));
    parts.push(paint(limb(el, V(s * H * 0.26, H * 0.26, H * 0.06), H * 0.04, H * 0.045, 10, 3), coat, () => [i + 1, 0, 0, 0]));
  }
  const g = mergeParts(parts);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, H * 0.5, 0), H);
  return { geo: g, piv, knees };
}

const _u = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _m = new THREE.Matrix4(), _f = new THREE.Vector3(), _r = new THREE.Vector3();

export class Giants {
  constructor(fauna, { worm, colossus }) {
    this.fauna = fauna; this.world = fauna.world;
    const L = fauna.level.lighting;
    this.items = [];
    if (worm) {
      const geo = buildWormGeo(fauna.q.pick(160, 240, 320, 400), fauna.q.pick(18, 24, 32, 36));
      const uni = {
        uFTime: fauna.uniforms.uFTime, uGlowColor: { value: new THREE.Color('#ff6a2a').multiplyScalar(1.2) },
        uHead: { value: 0 }, uArcR: { value: 210 }, uDepth: { value: 118 }, uBodyLen: { value: 620 }, uRad: { value: 40 },
      };
      const mats = rigMaterial({ roughness: 0.9, side: THREE.DoubleSide }, WORM_RIG, uni, 'worm', { surface: WORM_SURFACE, bounce: 0.5, aoMin: 0.55 });
      const mesh = new THREE.Mesh(geo, mats.mat);
      mesh.customDepthMaterial = mats.depth; mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
      const group = new THREE.Group(); group.add(mesh);
      // dust
      const n = fauna.q.pick(260, 480, 760, 1000);
      const dg = new THREE.InstancedBufferGeometry();
      dg.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
      dg.setIndex([0, 1, 2, 0, 2, 3]);
      const rng = new Random(seedFrom(fauna.seed, 'dust'));
      const seeds = new Float32Array(n * 4); for (let i = 0; i < n * 4; i++) seeds[i] = rng.float();
      dg.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
      dg.instanceCount = n;
      const du = {
        uE0: { value: new THREE.Vector3() }, uE1: { value: new THREE.Vector3() }, uDir0: { value: new THREE.Vector3(0, 0, 1) }, uDir1: { value: new THREE.Vector3(0, 0, -1) },
        uFTime: fauna.uniforms.uFTime, uScale: { value: 70 }, uOn0: { value: 1 }, uOn1: { value: 1 },
        uKeyColor: { value: L?.keyColor || new THREE.Color(1, 1, 1) }, uSky: { value: L?.skyColor || new THREE.Color(0.4, 0.35, 0.3) }, uSand: { value: new THREE.Color('#b08a62') },
      };
      Object.assign(du, { uHead: uni.uHead, uArcR: uni.uArcR, uDepth: uni.uDepth, uBodyLen: uni.uBodyLen, uRad: uni.uRad });
      const dust = new THREE.Mesh(dg, new THREE.ShaderMaterial({ vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, uniforms: du, transparent: true, depthWrite: false }));
      dust.frustumCulled = false; dust.renderOrder = 3;
      group.add(dust);
      // sand berms heaved up where the body breaks the dune (a raised lip, a dark churned crater, feathered into the dune)
      const berms = [];
      for (let k = 0; k < 2; k++) {
        const bm = new THREE.Mesh(buildBerm(k ? 46 : 34, new Random(seedFrom(fauna.seed, 'berm', k))), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, transparent: true, depthWrite: true }));
        bm.receiveShadow = true; bm.frustumCulled = false; bm.renderOrder = 1; bm.visible = false;
        group.add(bm); berms.push(bm);
      }
      fauna.root.add(group);
      this.worm = { group, mesh, uni, du, berms, cycle: 0, dir: null, fwd: null, speed: 28, pause: 18 };
      this.items.push(this.worm);
    }
    if (colossus) {
      const { geo, piv, knees } = buildColossus();
      geo.setAttribute('aAnim', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 4), 4));
      const uni = { uFTime: fauna.uniforms.uFTime, uGlowColor: { value: new THREE.Color('#9fe8ff').multiplyScalar(4) }, uPiv: { value: piv }, uKnee: { value: knees } };
      const mats = rigMaterial({ roughness: 0.95 }, COLOSSUS_RIG, uni, 'colossus');
      const mesh = new THREE.Mesh(geo, mats.mat);
      mesh.customDepthMaterial = mats.depth; mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
      fauna.root.add(mesh);
      this.colossus = { mesh, uni, phase: 0, pos: null, fwd: null, speed: 2.2 };
      this.items.push(this.colossus);
    }
  }

  /** Place the worm with its local frame at ground dir, travelling along fwd; t0 = head arc angle. */
  placeWorm(dir, fwd, headPhi = null) {
    const W = this.worm; if (!W) return;
    W.dir = dir.clone().normalize();
    W.fwd = fwd.clone().addScaledVector(W.dir, -fwd.dot(W.dir)).normalize();
    W.headPhi = headPhi;
    const { uArcR, uDepth, uBodyLen } = W.uni;
    const phi0 = Math.acos(clamp(uDepth.value / uArcR.value, -1, 1));
    W.phiStart = -phi0 - 0.05; W.phiEnd = phi0 + uBodyLen.value / uArcR.value + 0.05;
    W.cycle = headPhi != null ? (headPhi - W.phiStart) * uArcR.value / W.speed : 0;
  }

  /** Place the colossus at a ground dir walking along fwd. */
  placeColossus(dir, fwd) {
    const C = this.colossus; if (!C) return;
    C.pos = dir.clone().normalize();
    C.fwd = fwd.clone();
  }

  update(dt, cam) {
    const fa = this.fauna, w = this.world, R = w.radius;
    const W = this.worm;
    if (W) {
      if (!W.dir) {
        // ambient: a worm hunting ~1.5 km from the camera, re-placed each cycle
        _u.copy(cam).normalize(); tangentBasis(_u, _t1, _t2);
        const a = (fa.seed % 1000) * 0.01;
        const d = _u.clone().multiplyScalar(R).addScaledVector(_t1, Math.cos(a) * 1500).addScaledVector(_t2, Math.sin(a) * 1500).normalize();
        this.placeWorm(d, _t1.clone().multiplyScalar(-Math.sin(a)).addScaledVector(_t2, Math.cos(a)));
        W.ambient = true;
      }
      const span = (W.phiEnd - W.phiStart) * W.uni.uArcR.value / W.speed;
      W.cycle += dt;
      if (W.cycle > span + W.pause) { W.cycle = 0; if (W.ambient) W.dir = null; }
      const phi = W.phiStart + Math.min(W.cycle, span) * W.speed / W.uni.uArcR.value;
      W.uni.uHead.value = W.cycle > span ? -10 : phi;
      W.mesh.visible = W.cycle <= span && !!W.dir;
      if (W.dir) {
        const gh = w.heightAt(W.dir);
        const pos = _u.copy(W.dir).multiplyScalar(R + gh);
        const up = W.dir;
        _r.copy(up).cross(W.fwd).normalize(); // local +x = up × fwd... keep right-handed: x = y × z
        _m.makeBasis(_r, up, W.fwd);
        W.group.quaternion.setFromRotationMatrix(_m);
        W.group.position.copy(pos).sub(fa.anchor);
        // dust emitters where the body crosses the surface
        const Ar = W.uni.uArcR.value, D = W.uni.uDepth.value, L = W.uni.uBodyLen.value;
        const phi0 = Math.acos(clamp(D / Ar, -1, 1));
        const tail = phi - L / Ar;
        // front (head) crossing: the body occupies [tail, phi]; crossings at ±phi0
        W.du.uE0.value.set(0, 0, -Ar * Math.sin(phi0)); W.du.uDir0.value.set(0, 0, -1);
        W.du.uE1.value.set(0, 0, Ar * Math.sin(phi0)); W.du.uDir1.value.set(0, 0, 1);
        W.du.uOn0.value = W.mesh.visible && tail < -phi0 && phi > -phi0 ? 1 : smooth(0.4, 0, Math.abs(tail + phi0));
        W.du.uOn1.value = W.mesh.visible && phi > phi0 - 0.1 && tail < phi0 ? 1 : 0;
        // berms sit on the real dune height at each crossing
        for (let k = 0; k < 2; k++) {
          const bm = W.berms[k], ez = (k ? 1 : -1) * Ar * Math.sin(phi0);
          const on = k ? W.du.uOn1.value : W.du.uOn0.value;
          bm.visible = on > 0.2;
          if (!bm.visible) continue;
          _f.copy(W.dir).multiplyScalar(R).addScaledVector(W.fwd, ez).normalize();
          bm.position.set(0, w.heightAt(_f) - gh - ez * ez / (2 * R) - 1.5, ez);
        }
        W.group.visible = true;
      } else W.group.visible = false;
    }
    const C = this.colossus;
    if (C) {
      if (!C.pos) {
        _u.copy(cam).normalize(); tangentBasis(_u, _t1, _t2);
        const d = _u.clone().multiplyScalar(R).addScaledVector(_t1, 2600).addScaledVector(_t2, 900).normalize();
        this.placeColossus(d, _t2.clone());
      }
      _u.copy(C.pos);
      C.fwd.addScaledVector(_u, -C.fwd.dot(_u)).normalize();
      C.pos.multiplyScalar(R).addScaledVector(C.fwd, C.speed * dt).normalize();
      C.phase += dt * C.speed / 30 * TAU;
      const gh = Math.max(w.heightAt(C.pos), w.hasOcean ? w.seaLevel : -1e9);
      _r.copy(C.pos).cross(C.fwd).normalize();
      _m.makeBasis(_r, C.pos, C.fwd);
      C.mesh.quaternion.setFromRotationMatrix(_m);
      C.mesh.position.copy(C.pos).multiplyScalar(R + gh - 2).sub(fa.anchor);
      const an = C.mesh.geometry.attributes.aAnim;
      // single-instance: drive phase through the uniform-free attribute path (constant per mesh)
      if (C._lastPh == null || Math.abs(C._lastPh - C.phase) > 1e-3) {
        an.array.fill(0); for (let i = 0; i < an.count; i++) an.array[i * 4] = C.phase;
        an.needsUpdate = true; C._lastPh = C.phase;
      }
      // eyes glow faintly
      C.uni.uGlowColor.value.set('#9fe8ff').multiplyScalar(0.5 + 3 * fa.night);
      // far from the camera: re-place in front of the explorer
      if (C.mesh.position.length() > 9000) C.pos = null;
    }
  }

  dispose() {
    for (const it of this.items) {
      const objs = it.group ? it.group.children : [it.mesh];
      for (const o of objs) { o.geometry.dispose(); o.material.dispose(); o.customDepthMaterial?.dispose(); }
      (it.group || it.mesh).removeFromParent();
    }
  }
}
