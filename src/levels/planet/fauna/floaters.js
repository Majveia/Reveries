// Floaters — sky jellies and sky whales.
//
// • Sky jellies: translucent bells with scalloped rims, oral arms and long
//   ribbon tentacles. GPU animation: the bell contracts in a sharp pulse and
//   relaxes, tentacles trail in travelling waves. Custom shader: wrapped sun
//   light + transmitted back light + Fresnel rim, bioluminescent veins and
//   tentacle beads that breathe light at night (HDR, they bloom).
// • Sky whales: 60–140 m leviathans drifting slowly among the clouds; vertical
//   body undulation, sweeping pectoral fins and fluke strokes in the vertex
//   shader; counter-shaded hide, ventral pleats, barnacle constellations and
//   (on luminous worlds) glowing flank lines.
import * as THREE from 'three';
import { Random, seedFrom } from '../../../core/Random.js';
import { TAU, clamp, smooth, lerp, rigMaterial, paint, mergeParts, blob, membrane, vnoise, tangentBasis, writeInstance, makeInstanced } from './common.js';

// ---------------------------------------------------------------------------------
// Jellies
// ---------------------------------------------------------------------------------
const JELLY_VERT = /* glsl */ `
attribute vec4 aRig;      // x: 0 bell, 1 tentacle, 2 oral arm; y: t along (0 top .. 1 tip); z: angle; w: inner(1)/outer(0)
attribute vec4 aAnim;     // x pulse phase, y glow, z drift speed, w seed
uniform float uFTime;
varying vec3 vN; varying vec3 vW; varying vec4 vRig; varying float vPulse; varying vec3 vCol; varying float vGlowI;
void main() {
  vec3 p = position; vec3 n = normal;
  float ph = aAnim.x;
  float c = fract(ph / 6.2831853);
  float pulse = smoothstep(0.0, 0.12, c) * (1.0 - smoothstep(0.12, 0.75, c)); // sharp contraction, slow relax
  vPulse = pulse;
  if (aRig.x < 0.5) {
    // bell: contract the rim inward, dome rises
    float rim = smoothstep(0.2, -0.45, p.y);
    p.xz *= 1.0 - 0.2 * pulse * rim;
    p.y += 0.08 * pulse * (1.0 - rim);
  } else {
    float t = aRig.y;
    float w = sin(t * 7.0 - uFTime * 1.7 - aRig.z * 3.0 + aAnim.w * 10.0);
    float w2 = cos(t * 4.0 - uFTime * 1.1 + aRig.z * 5.0);
    float amp = t * t * (aRig.x > 1.5 ? 0.25 : 0.55);
    p.x += (w * 0.6 + w2 * 0.4) * amp;
    p.z += (w2 * 0.6 - w * 0.4) * amp;
    // tentacles bunch with the pulse and trail upward drift
    p.xz *= 1.0 - 0.25 * pulse * (1.0 - t);
    p.y += pulse * 0.25 * t;
  }
  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * n);
  vRig = aRig;
  #ifdef USE_INSTANCING_COLOR
  vCol = instanceColor;
  #else
  vCol = vec3(1.0);
  #endif
  vGlowI = aAnim.y;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const JELLY_FRAG = /* glsl */ `
uniform vec3 uKeyColor; uniform vec3 uKeyDir; uniform vec3 uSky; uniform vec3 uGround;
uniform float uNight; uniform vec3 uGlowA; uniform vec3 uGlowB;
varying vec3 vN; varying vec3 vW; varying vec4 vRig; varying float vPulse; varying vec3 vCol; varying float vGlowI;
void main() {
  vec3 V = normalize(cameraPosition - vW);
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  float ndv = abs(dot(N, V));
  float fres = pow(1.0 - ndv, 2.2);
  vec3 L = normalize(uKeyDir);
  vec3 up = normalize(vW);
  float wrap = max(0.0, (dot(N, L) + 0.6) / 1.6);
  float trans = pow(max(0.0, dot(-V, L)), 4.0); // looking toward the sun through the bell
  vec3 base = mix(vec3(1.0), vCol, 0.3);
  vec3 gcol = vCol * 1.6;
  vec3 amb = mix(uGround, uSky, dot(N, up) * 0.5 + 0.5);
  vec3 lit = base * (uKeyColor * (wrap * 0.22 + trans * 0.5) + amb * 0.9);
  float glowI = vGlowI * (0.04 + 1.0 * uNight);
  vec3 glow = vec3(0.0);
  float alpha;
  if (vRig.x < 0.5) {
    // bell: radial veins + rim band glow
    float ang = atan(vW.x, vW.z);
    float veins = smoothstep(0.82, 1.0, abs(sin(vRig.z * 8.0)));
    float rimBand = smoothstep(0.25, 0.0, abs(vRig.y - 0.92));
    glow = mix(gcol, mix(uGlowA, uGlowB, 0.5) * 0.5, vRig.y * 0.5) * (0.06 + veins * 0.5 + rimBand * 1.5 + vRig.w * 0.35) * (0.5 + 0.9 * vPulse);
    alpha = clamp(0.1 + fres * 0.6 + vRig.w * 0.12 + rimBand * 0.2, 0.0, 0.9);
    lit += base * uSky * fres * 0.8;
  } else {
    float bead = smoothstep(0.85, 1.0, sin(vRig.y * (vRig.x > 1.5 ? 14.0 : 40.0) - vPulse * 4.0) * 0.5 + 0.5);
    glow = gcol * (0.15 + bead * 1.2) * (1.0 - vRig.y * 0.7);
    alpha = (vRig.x > 1.5 ? 0.22 : 0.4) * (0.6 + bead * 0.4) * (1.0 - smoothstep(0.6, 1.0, vRig.y));
  }
  vec3 col = lit + glow * glowI;
  gl_FragColor = vec4(col, alpha);
}
`;

function buildJelly(rng) {
  const parts = [];
  // bell: lathe profile, scalloped rim
  const prof = [];
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const t = i / N, a = t * Math.PI * 0.62;
    prof.push(new THREE.Vector2(Math.sin(a) * (1 + 0.08 * t), Math.cos(a) * 0.85 - 0.25 - t * t * 0.2));
  }
  const bell = new THREE.LatheGeometry(prof, 28);
  bell.deleteAttribute('uv');
  const pa = bell.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
    const ang = Math.atan2(x, z), r = Math.hypot(x, z);
    const sc = 1 + 0.06 * Math.max(0, Math.cos(ang * 8)) * smooth(0.5, 0.95, r);
    pa.setXYZ(i, x * sc, y - 0.07 * smooth(0.8, 1.0, r) * (0.5 + 0.5 * Math.cos(ang * 16)), z * sc);
  }
  bell.computeVertexNormals();
  paint(bell, () => [1, 1, 1], (p) => {
    const r = Math.hypot(p.x, p.z);
    return [0, clamp(r, 0, 1), Math.atan2(p.x, p.z), 0];
  });
  parts.push(bell);
  // inner glowing core
  const core = blob(0.42, 0.3, 0.42, null, 12, 8); core.translate(0, 0.15, 0);
  parts.push(paint(core, () => [1, 1, 1], (p) => [0, 0.2, Math.atan2(p.x, p.z), 1]));
  // ribbon tentacles and frilly oral arms
  const ribbon = (x0, z0, len, width, kind, ang) => {
    const segs = 18, verts = [], rig = [];
    const nx = Math.cos(ang), nz = -Math.sin(ang);
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs, t1 = (s + 1) / segs;
      const w0 = width * (1 - t0 * 0.8), w1 = width * (1 - t1 * 0.8);
      const y0 = -0.3 - t0 * len, y1 = -0.3 - t1 * len;
      const quad = [[x0 - nx * w0, y0, z0 - nz * w0, t0], [x0 + nx * w0, y0, z0 + nz * w0, t0], [x0 + nx * w1, y1, z0 + nz * w1, t1],
        [x0 - nx * w0, y0, z0 - nz * w0, t0], [x0 + nx * w1, y1, z0 + nz * w1, t1], [x0 - nx * w1, y1, z0 - nz * w1, t1]];
      for (const q of quad) { verts.push(q[0], q[1], q[2]); rig.push(kind, q[3], ang, 0); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.computeVertexNormals();
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(verts.length).fill(1), 3));
    g.setAttribute('aRig', new THREE.Float32BufferAttribute(rig, 4));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(new Float32Array(verts.length / 3), 1));
    return g;
  };
  const nt = 12;
  for (let i = 0; i < nt; i++) {
    const a = (i / nt) * TAU + rng.range(-0.1, 0.1);
    parts.push(ribbon(Math.sin(a) * 0.85, Math.cos(a) * 0.85, rng.range(2.6, 4.2), 0.025, 1, a));
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4;
    parts.push(ribbon(Math.sin(a) * 0.18, Math.cos(a) * 0.18, rng.range(1.2, 1.8), 0.14, 2, a));
  }
  const g = mergeParts(parts);
  return g;
}

const JELLY_GLOW = {
  pandora: ['#38f6ff', '#c04bff', '#7fe8ff'], rick: ['#7aff5a', '#ff4ad8', '#ffe85a'], moebius: ['#ffb070', '#3fd0c0', '#ffe0f0'],
};

// ---------------------------------------------------------------------------------
// Whales
// ---------------------------------------------------------------------------------
const WHALE_RIG = /* glsl */ `
uniform float uLen;
void rig(inout vec3 p, inout vec3 n) {
  float ph = aAnim.x, amp = aAnim.y;
  float s = aRig.x; // 0 head .. 1 fluke tip
  // vertical travelling undulation, growing toward the tail
  float k = 6.2831853 * 0.85;
  float wv = sin(s * k - ph) * amp * uLen * 0.045 * smoothstep(0.25, 1.0, s);
  float slope = cos(s * k - ph) * amp * 0.045 * k * smoothstep(0.25, 1.0, s);
  p.y += wv;
  n.y -= slope * n.z;
  // pectoral fins sweep (aRig.y = ±1, aRig.z = distance from the body)
  if (abs(aRig.y) > 0.5) {
    float a = (sin(ph * 0.5 + 0.6) * 0.35 + 0.1) * aRig.z;
    vec2 v = fa_rot(vec2(abs(p.x), p.y - aRig.w), a);
    p.x = sign(p.x) * v.x; p.y = v.y + aRig.w;
  }
}
`;

function buildWhale(style) {
  const parts = [];
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const back = new THREE.Color(style.back), belly = new THREE.Color(style.belly), mark = new THREE.Color(style.mark);
  // body (unit length 1 along -z from head at z=+0.5)
  const body = blob(0.105, 0.1, 0.5, (z, x, y) => {
    const t = (0.5 - z * 0.5); // z in -1..1 → head 0..1 tail
    let r = Math.pow(Math.sin(Math.PI * Math.pow(clamp(t, 0, 1), 0.62)), 0.75);
    r *= 1 - 0.75 * smooth(0.55, 1.0, t);
    if (y < 0) r *= 1 + 0.12 * Math.exp(-((t - 0.25) ** 2) * 30); // throat
    return Math.max(r, 0.03);
  }, 40, 22);
  const col = (p, n) => {
    const t = smooth(-0.35, 0.35, n.y);
    let c = [lerp(belly.r, back.r, t), lerp(belly.g, back.g, t), lerp(belly.b, back.b, t)];
    // ventral pleats
    if (n.y < -0.2 && p.z > -0.05) { const pl = smooth(0.3, 0.9, Math.abs(Math.sin(p.x * 260))) * 0.35; c = c.map((v) => v * (1 - pl)); }
    // barnacle / lichen constellations
    const b = smooth(0.74, 0.8, vnoise(p.x * 90, p.y * 90, p.z * 40)) * (t > 0.3 ? 1 : 0.4);
    c = [lerp(c[0], mark.r, b), lerp(c[1], mark.g, b), lerp(c[2], mark.b, b)];
    const v = 0.85 + 0.3 * vnoise(p.x * 30, p.y * 30, p.z * 12);
    return c.map((x) => x * v);
  };
  const glowFn = style.glow ? (p, n) => smooth(0.008, 0.0, Math.abs(p.y - 0.01 - 0.02 * Math.sin(p.z * 18))) * smooth(0.3, 0.7, Math.abs(n.x)) * (0.5 + 0.5 * smooth(0.7, 0.9, vnoise(p.z * 60, 0, 0))) + smooth(0.8, 0.85, vnoise(p.x * 120, p.y * 120, p.z * 50)) * 0.8 : null;
  parts.push(paint(body, col, (p) => [clamp(0.5 - p.z, 0, 1), 0, 0, 0], glowFn));
  // eye
  for (const s of [-1, 1]) {
    const e = blob(0.006, 0.006, 0.006, null, 6, 4); e.translate(s * 0.084, -0.014, 0.36);
    parts.push(paint(e, () => [0.01, 0.01, 0.01], () => [0.14, 0, 0, 0], style.glow ? () => 1.5 : null));
  }
  // pectoral fins (long, humpback-like, knobbly leading edge)
  for (const s of [-1, 1]) {
    const out = [[0, 0.06], [0.08, 0.04], [0.2, -0.02], [0.32, -0.1], [0.34, -0.13], [0.3, -0.12], [0.18, -0.07], [0.06, -0.04], [0, -0.04]].map(([x, z]) => [s * (0.08 + x), 0.2 + z]);
    const g = membrane(out, 0.0);
    g.rotateZ(s * -0.25);
    g.translate(0, -0.035, 0);
    parts.push(paint(g, (p, n) => col(p, V(0, s * p.x > 0.15 ? -1 : 0.2, 0)), (p) => [clamp(0.5 - p.z, 0, 1), s, clamp((Math.abs(p.x) - 0.08) / 0.3, 0, 1) * 1.6, -0.035], glowFn));
  }
  // flukes
  const fl = [[0, -0.42], [0.06, -0.47], [0.14, -0.54], [0.12, -0.56], [0.05, -0.53], [0, -0.51], [-0.05, -0.53], [-0.12, -0.56], [-0.14, -0.54], [-0.06, -0.47]];
  const flg = membrane(fl, 0.004);
  parts.push(paint(flg, (p) => col(p, V(0, 1, 0)), (p) => [clamp(0.5 - p.z, 0, 1), 0, 0, 0], glowFn));
  // dorsal ridge bumps
  for (let i = 0; i < 5; i++) {
    const z = -0.1 - i * 0.06;
    const k = blob(0.006, 0.012, 0.02, null, 6, 4); k.translate(0, 0.075 * (1 - i * 0.12), z);
    parts.push(paint(k, () => [back.r * 0.7, back.g * 0.7, back.b * 0.7], () => [clamp(0.5 - z, 0, 1), 0, 0, 0]));
  }
  const g = mergeParts(parts);
  g.computeBoundingSphere();
  return g;
}

const WHALE_STYLE = {
  ghibli: { back: '#3e4f66', belly: '#e6e2d8', mark: '#f4efe4' },
  moebius: { back: '#d77a6a', belly: '#fde6d2', mark: '#3fb0a6' },
  pandora: { back: '#1a2648', belly: '#8ab0c8', mark: '#9ad8ff', glow: '#38f6ff' },
  wukong: { back: '#3a3c3e', belly: '#cfcbc2', mark: '#e8e2d4' },
  default: { back: '#4a5868', belly: '#d8d4cc', mark: '#ece6da' },
};

const _v = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();

export class Floaters {
  constructor(fauna, { jellies, whales }) {
    this.fauna = fauna; this.world = fauna.world;
    const A = fauna.level.planet.aesthetic;
    const q = fauna.q;
    this.jellies = [];
    this.whales = [];
    if (jellies) {
      const rng = new Random(seedFrom(fauna.seed, 'jellygeo'));
      const geo = buildJelly(rng);
      const L = fauna.level.lighting;
      const glow = JELLY_GLOW[A] || JELLY_GLOW.pandora;
      this.jU = {
        uFTime: fauna.uniforms.uFTime, uKeyColor: { value: L?.keyColor || new THREE.Color(1, 1, 1) }, uKeyDir: { value: L?.keyDir || new THREE.Vector3(0, 1, 0) },
        uSky: { value: L?.skyColor || new THREE.Color(0.3, 0.4, 0.6) }, uGround: { value: L?.groundColor || new THREE.Color(0.1, 0.1, 0.1) },
        uNight: { value: 0 }, uGlowA: { value: new THREE.Color(glow[0]).multiplyScalar(2.2) }, uGlowB: { value: new THREE.Color(glow[1]).multiplyScalar(2.2) },
      };
      const mat = new THREE.ShaderMaterial({ vertexShader: JELLY_VERT, fragmentShader: JELLY_FRAG, uniforms: this.jU, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      this.jMax = q.pick(24, 40, 64, 90);
      const anim = new THREE.InstancedBufferAttribute(new Float32Array(this.jMax * 4), 4); anim.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aAnim', anim);
      this.jMesh = new THREE.InstancedMesh(geo, mat, this.jMax);
      this.jMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.jMax * 3).fill(1), 3);
      this.jMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.jMesh.frustumCulled = false; this.jMesh.count = 0; this.jMesh.renderOrder = 2;
      this.jAnim = anim;
      this.jPalette = glow.map((h) => new THREE.Color(h));
      fauna.root.add(this.jMesh);
      this._jRng = rng;
    }
    if (whales) {
      const style = WHALE_STYLE[A] || WHALE_STYLE.default;
      const geo = buildWhale(style);
      const uni = { uFTime: fauna.uniforms.uFTime, uGlowColor: { value: new THREE.Color(style.glow || '#000000') }, uLen: { value: 1 } };
      const mats = rigMaterial({ roughness: 0.62 }, WHALE_RIG, uni, 'whale-' + A);
      mats.mat.side = THREE.DoubleSide;
      const { mesh, anim } = makeInstanced(geo, mats, 8, { shadow: true });
      mesh.receiveShadow = true;
      fauna.root.add(mesh);
      this.wMesh = mesh; this.wAnim = anim; this.wU = uni; this.wGlow = new THREE.Color(style.glow || '#000000');
      // a deterministic pod roaming the region of the first settlement + the opposite hemisphere
      const rng = new Random(seedFrom(fauna.seed, 'whales'));
      const n = q.pick(2, 3, 4, 5);
      const homes = (this.world.sites.length ? this.world.sites : [{ dir: new THREE.Vector3(0.3, 0.5, 0.8).normalize() }]).slice(0, 3);
      for (let i = 0; i < n; i++) {
        const h = homes[i % homes.length].dir;
        this.whales.push(this._makeWhale(h, rng, {}));
      }
    }
  }

  _makeWhale(dir, rng, o) {
    const w = this.world, R = w.radius;
    const [t1, t2] = tangentBasis(dir.clone().normalize(), new THREE.Vector3(), new THREE.Vector3());
    const a = o.ang ?? rng.range(0, TAU), rr = o.dist ?? rng.range(600, 2600);
    const d = dir.clone().multiplyScalar(R).addScaledVector(t1, Math.cos(a) * rr).addScaledVector(t2, Math.sin(a) * rr).normalize();
    const gh = Math.max(w.heightAt(d), w.hasOcean ? w.seaLevel : -1e9);
    const len = o.len ?? rng.range(70, 140);
    const alt = o.alt ?? rng.range(380, 900);
    const head = o.heading ?? rng.range(0, TAU);
    return { pos: d.clone().multiplyScalar(R + gh + alt), len, alt, head, speed: len * rng.range(0.05, 0.08), phase: rng.range(0, TAU), turn: rng.range(-0.012, 0.012), t1, t2, forced: !!o.forced };
  }

  spawnWhale(pos, heading, len) {
    const w = this.world;
    const d = pos.clone().normalize();
    const gh = Math.max(w.heightAt(d), w.hasOcean ? w.seaLevel : -1e9);
    const wh = this._makeWhale(d, this._jRng || new Random(7), { dist: 0, ang: 0, len, alt: pos.length() - w.radius - gh, heading, forced: true });
    wh.pos.copy(pos); wh.fwd = heading.clone ? heading.clone() : null;
    this.whales.push(wh);
    return wh;
  }

  spawnJellies(center, n, spread, rng = new Random(seedFrom(this.fauna.seed, 'jf')), minAlt = 0) {
    this.jellies.length = 0;
    const w = this.world;
    const up = center.clone().normalize();
    const [t1, t2] = tangentBasis(up, new THREE.Vector3(), new THREE.Vector3());
    for (let i = 0; i < n; i++) {
      const p = center.clone().addScaledVector(t1, rng.range(-1, 1) * spread).addScaledVector(t2, rng.range(-1, 1) * spread * 0.7);
      const d = p.clone().normalize();
      const gh = Math.max(w.heightAt(d), w.hasOcean ? w.seaLevel : -1e9);
      const altAbove = Math.max(p.length() - w.radius - gh, 0);
      const base = d.multiplyScalar(w.radius + gh + Math.max(altAbove + rng.range(-0.25, 0.6) * spread * 0.35, minAlt || 4));
      const big = rng.float() < 0.18;
      this.jellies.push({ base, p: base.clone(), size: big ? rng.range(5, 9) : rng.range(1.4, 3.6), phase: rng.range(0, TAU), rate: rng.range(0.5, 0.9), drift: rng.range(0, TAU), seed: rng.float(), col: rng.int(0, 2), glow: rng.range(0.6, 1.3) });
    }
  }

  _ambientJellies(cam) {
    // keep a deterministic swarm drifting around wherever the player is (re-seeded per 600 m cell)
    const R = this.world.radius;
    _v.copy(cam).normalize();
    const key = `${Math.round(_v.x * R / 600)},${Math.round(_v.y * R / 600)},${Math.round(_v.z * R / 600)}`;
    if (key === this._jKey) return;
    this._jKey = key;
    const rng = new Random(seedFrom(this.fauna.seed, 'jcell', key));
    const gh = this.world.heightAt(_v);
    const c = _v.clone().multiplyScalar(R + Math.max(gh, this.world.hasOcean ? this.world.seaLevel : -1e9) + 45);
    this.spawnJellies(c, Math.min(this.jMax, this.fauna.q.pick(10, 18, 28, 40)), 160, rng);
  }

  update(dt, cam) {
    const fa = this.fauna, anchor = fa.anchor, t = fa.time;
    if (this.jMesh) {
      if (!fa.showcase?.jellies) this._ambientJellies(cam);
      this.jU.uNight.value = fa.night;
      const arr = this.jMesh.instanceMatrix.array, an = this.jAnim.array, col = this.jMesh.instanceColor.array;
      let n = 0;
      for (const j of this.jellies) {
        if (n >= this.jMax) break;
        _u.copy(j.base).normalize();
        tangentBasis(_u, _t1, _t2);
        const c = (t * j.rate) / TAU;
        const bob = Math.sin(t * 0.4 + j.seed * 20) * 1.2 + (c % 1) * 0;
        j.p.copy(j.base).addScaledVector(_t1, Math.sin(t * 0.05 + j.drift) * 6).addScaledVector(_t2, Math.cos(t * 0.04 + j.drift) * 6).addScaledVector(_u, bob);
        _f.copy(_t1).multiplyScalar(Math.cos(j.drift)).addScaledVector(_t2, Math.sin(j.drift));
        // slight tilt with the drift
        _u.addScaledVector(_f, 0.12 * Math.sin(t * 0.3 + j.seed * 9)).normalize();
        writeInstance(arr, n, j.p, anchor, _f, _u, j.size);
        an[n * 4] = t * j.rate * TAU * 0.25 + j.phase; an[n * 4 + 1] = j.glow; an[n * 4 + 2] = 0; an[n * 4 + 3] = j.seed;
        const pc = this.jPalette[j.col];
        col[n * 3] = pc.r; col[n * 3 + 1] = pc.g; col[n * 3 + 2] = pc.b;
        n++;
      }
      this.jMesh.count = n;
      this.jMesh.instanceMatrix.needsUpdate = true; this.jAnim.needsUpdate = true; this.jMesh.instanceColor.needsUpdate = true;
    }
    if (this.wMesh) {
      const arr = this.wMesh.instanceMatrix.array, an = this.wAnim.array;
      let n = 0;
      for (const wh of this.whales) {
        _u.copy(wh.pos).normalize();
        tangentBasis(_u, _t1, _t2);
        if (!wh.fwd) wh.fwd = _t1.clone().multiplyScalar(Math.cos(wh.head)).addScaledVector(_t2, Math.sin(wh.head));
        wh.fwd.addScaledVector(_u, -wh.fwd.dot(_u)).normalize();
        wh.fwd.applyAxisAngle(_u, wh.turn * dt);
        wh.pos.addScaledVector(wh.fwd, wh.speed * dt);
        wh.phase += dt * (wh.speed / wh.len) * TAU * 0.9;
        if (n >= 8) continue;
        if (wh.pos.distanceToSquared(cam) > 12000 * 12000) continue;
        _f.copy(wh.fwd).addScaledVector(_u, Math.sin(wh.phase * 0.25) * 0.04);
        writeInstance(arr, n, wh.pos, anchor, _f, _u, wh.len);
        an[n * 4] = wh.phase; an[n * 4 + 1] = 1; an[n * 4 + 2] = 0; an[n * 4 + 3] = 0;
        n++;
      }
      this.wMesh.count = n;
      this.wMesh.instanceMatrix.needsUpdate = true; this.wAnim.needsUpdate = true;
      this.wU.uGlowColor.value.copy(this.wGlow).multiplyScalar(0.05 + 2.5 * fa.night);
    }
  }

  clearForced() { this.whales = this.whales.filter((w) => !w.forced); }

  dispose() {
    for (const m of [this.jMesh, this.wMesh]) if (m) { m.removeFromParent(); m.geometry.dispose(); m.material.dispose(); m.customDepthMaterial?.dispose(); }
  }
}
