// Herds — procedural quadrupeds grazing, wandering and fleeing across the land.
//
// • Geometry: each species is generated from a small parameter set (body,
//   neck, head, horns/antlers/crest, four two-segment legs, tail) and painted
//   with vertex colours (counter-shading, stripes / spots / saddles, glowing
//   markings on bioluminescent worlds).
// • Animation: fully on the GPU. Vertices carry a rig (leg id, lower-segment
//   flag, neck weight, tail weight); instances carry (phase, gait, graze, stride).
//   The shader bends knees, swings hips with walk / gallop phase offsets, lowers
//   the neck to graze, nibbles, looks around and swishes the tail.
// • Simulation (CPU, cheap): herds live in a deterministic 3D lattice of cells
//   on the sphere; each animal is a little state machine (graze / walk / look /
//   flee) in the herd's tangent plane, with separation, water / city avoidance,
//   and terrain heights sampled round-robin and extrapolated with the local slope.
import * as THREE from 'three';
import { Random, seedFrom, hash3i, u01 } from '../../../core/Random.js';
import { TAU, clamp, smooth, lerp, rigMaterial, paint, mergeParts, blob, limb, mixColor, vnoise, tangentBasis, writeInstance, makeInstanced } from './common.js';

// ---------------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------------
const SPECIES = {
  // pastoral antelope-deer: russet back, cream belly, little lyre horns
  antelope: { bodyLen: 0.78, bodyR: 0.42, bodyW: 0.34, legLen: 0.92, legR: 0.075, neckLen: 0.62, neckUp: 0.95, headLen: 0.3, headR: 0.12,
    horns: 'lyre', tail: 0.22, ears: 0.13, back: '#8a4f2a', belly: '#efe0c4', pattern: 'flank', patternColor: '#3a2416', hoof: '#2a2420', size: [0.9, 1.2], count: [7, 14] },
  // shaggy woolly grazer (ghibli's second species: big, soft, round)
  yak: { bodyLen: 1.0, bodyR: 0.66, bodyW: 0.55, legLen: 0.72, legR: 0.13, neckLen: 0.34, neckUp: 0.25, headLen: 0.36, headR: 0.2,
    horns: 'curved', tail: 0.4, ears: 0.12, back: '#7a5e44', belly: '#b09878', pattern: 'shag', patternColor: '#d8c8a8', hoof: '#1c1814', size: [1.0, 1.25], count: [4, 8], hump: 0.25 },
  // northern elk / caribou with antlers
  elk: { bodyLen: 0.95, bodyR: 0.5, bodyW: 0.42, legLen: 1.08, legR: 0.085, neckLen: 0.6, neckUp: 0.75, headLen: 0.42, headR: 0.15,
    horns: 'antlers', tail: 0.12, ears: 0.15, back: '#5e4b3b', belly: '#c8b8a0', pattern: 'mane', patternColor: '#ddd2c0', hoof: '#201a16', size: [0.95, 1.2], count: [6, 12] },
  // Pandora six-limbed-looking grazer: dark indigo hide with glowing cyan stripes and a head fan
  hexa: { bodyLen: 0.85, bodyR: 0.42, bodyW: 0.33, legLen: 1.0, legR: 0.07, neckLen: 0.72, neckUp: 0.85, headLen: 0.42, headR: 0.12,
    horns: 'fan', tail: 0.5, ears: 0.0, back: '#1d2a52', belly: '#5f7fa0', pattern: 'stripes', patternColor: '#3fd8ff', glow: 1, hoof: '#101420', size: [1.0, 1.3], count: [6, 12] },
  // Moebius / Rick / frontier stilt walker: tiny round body on very long legs, long neck
  stilt: { bodyLen: 0.55, bodyR: 0.45, bodyW: 0.4, legLen: 2.4, legR: 0.06, neckLen: 1.1, neckUp: 1.2, headLen: 0.42, headR: 0.12,
    horns: 'crest', tail: 0.5, ears: 0.0, back: '#e6d2b8', belly: '#fbf1e0', pattern: 'spots', patternColor: '#c45a50', hoof: '#3a2a2a', size: [1.0, 1.35], count: [4, 9] },
};

const SPECIES_FOR = {
  ghibli: ['antelope', 'yak'], pandora: ['hexa'], tarkovsky: ['elk'], erdtree: ['elk'], glacier: ['elk'],
  moebius: ['stilt'], rick: ['stilt'], frontier: ['stilt'], nausicaa: ['yak'],
};
const RECOLOR = {
  erdtree: { back: '#6a5232', belly: '#d8c69a', patternColor: '#e8d8a8' },
  glacier: { back: '#8c8a86', belly: '#ecebe6', patternColor: '#ffffff' },
  rick: { back: '#9ad86a', belly: '#e8ffb0', patternColor: '#ff5ab0', glow: 0.6 },
  frontier: { back: '#b08a6a', belly: '#e0c8a8', patternColor: '#5a3a2a' },
};

const RIG_GLSL = /* glsl */ `
uniform vec3 uHip[4];
uniform vec3 uKnee[4];
uniform vec3 uNeck;
uniform vec3 uTail;
uniform vec4 uGait;   // x hip swing, y knee lift, z bob, w body pitch
void faSwing(inout vec3 p, inout vec3 n, vec3 piv, float a) {
  vec2 v = fa_rot(vec2(p.z - piv.z, p.y - piv.y), a);
  p.z = piv.z + v.x; p.y = piv.y + v.y;
  vec2 m = fa_rot(vec2(n.z, n.y), a); n.z = m.x; n.y = m.y;
}
void faYaw(inout vec3 p, inout vec3 n, vec3 piv, float a) {
  vec2 v = fa_rot(vec2(p.x - piv.x, p.z - piv.z), a);
  p.x = piv.x + v.x; p.z = piv.z + v.y;
  vec2 m = fa_rot(vec2(n.x, n.z), a); n.x = m.x; n.z = m.y;
}
void rig(inout vec3 p, inout vec3 n) {
  float id = float(gl_InstanceID);
  float ph = aAnim.x, gait = aAnim.y, graze = aAnim.z, amp = aAnim.w;
  int leg = int(aRig.x + 0.5) - 1;
  if (leg >= 0) {
    float wOff = leg == 0 ? 0.0 : leg == 1 ? 3.1416 : leg == 2 ? 4.712 : 1.571;
    float gOff = leg == 0 ? 0.0 : leg == 1 ? 0.55 : leg == 2 ? 3.5 : 4.0;
    float lp = ph + mix(wOff, gOff, gait);
    float a = amp * uGait.x * mix(1.0, 1.7, gait) * sin(lp);
    float lift = max(0.0, cos(lp)); lift *= lift;
    float k = amp * uGait.y * mix(1.0, 1.6, gait) * lift;
    if (aRig.y > 0.5) faSwing(p, n, uKnee[leg], leg < 2 ? -k * 1.2 : -k * 0.9);
    faSwing(p, n, uHip[leg], a);
  }
  if (aRig.z > 0.0) {
    float w = aRig.z;
    float look = sin(uFTime * 0.37 + id * 2.1) * 0.35 * (1.0 - graze) * (1.0 - gait);
    float down = graze * 1.15 + sin(uFTime * 5.0 + id) * 0.06 * graze - gait * 0.25 + amp * 0.06 * sin(ph * 2.0);
    faSwing(p, n, uNeck, -down * w);
    faYaw(p, n, uNeck, look * w);
  }
  if (aRig.w > 0.0) {
    faYaw(p, n, uTail, sin(uFTime * 2.6 + id * 1.7) * 0.5 * aRig.w);
    faSwing(p, n, uTail, -0.25 * aRig.w * gait);
  }
  // body motion: bob and gallop rocking (whole animal pivots about the body centre)
  float bob = (1.0 - cos(ph * 2.0)) * 0.5 * amp * uGait.z * mix(1.0, 2.2, gait);
  if (leg < 0) p.y += bob; else p.y += bob * smoothstep(0.0, uHip[0].y, p.y);
  if (leg < 0) faSwing(p, n, vec3(0.0, uHip[0].y, 0.0), sin(ph) * uGait.w * gait * amp);
}
`;

function buildSpecies(spec) {
  const S = spec;
  const back = new THREE.Color(S.back), belly = new THREE.Color(S.belly), pat = new THREE.Color(S.patternColor), hoof = new THREE.Color(S.hoof);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const hipY = S.legLen, cy = S.legLen + S.bodyR * 0.55;
  const parts = [];
  const zF = S.bodyLen * 0.62, zB = -S.bodyLen * 0.6, xL = S.bodyW * 0.62;
  const hips = [V(xL, hipY + S.bodyR * 0.25, zF), V(-xL, hipY + S.bodyR * 0.25, zF), V(xL, hipY + S.bodyR * 0.3, zB), V(-xL, hipY + S.bodyR * 0.3, zB)];
  const knees = hips.map((h, i) => V(h.x * 0.9, S.legLen * (i < 2 ? 0.42 : 0.5), h.z + (i < 2 ? 0.03 : -0.12) * S.legLen));
  const neckBase = V(0, cy + S.bodyR * 0.35, S.bodyLen * 0.72);
  const tailBase = V(0, cy + S.bodyR * 0.35, -S.bodyLen * 0.95);
  // colour function: counter-shading + pattern
  const coat = (p, n, extra = 0) => {
    const up = clamp(n.y * 0.5 + 0.5, 0, 1);
    let t = smooth(0.25, 0.75, up) ; // 1 = back
    const yy = (p.y - hipY) / (S.bodyR * 1.6);
    t = clamp(t * 0.65 + clamp(yy, 0, 1) * 0.5, 0, 1);
    let c = mixColor(belly, back, t);
    const nz = vnoise(p.x * 9, p.y * 9, p.z * 9);
    let pm = 0;
    if (S.pattern === 'stripes') pm = smooth(0.55, 0.62, Math.sin(p.z * 22 + Math.sin(p.y * 8) * 1.5 + nz * 2) * 0.5 + 0.5) * smooth(0.3, 0.7, t);
    else if (S.pattern === 'spots') pm = smooth(0.66, 0.72, vnoise(p.x * 7 + 3, p.y * 7, p.z * 7)) * t;
    else if (S.pattern === 'flank') pm = smooth(0.05, 0.0, Math.abs(yy - 0.18 + Math.sin(p.z * 3) * 0.04)) * (1 - Math.abs(n.y)) * 0.9;
    else if (S.pattern === 'mane') pm = smooth(0.6, 0.9, extra);
    else if (S.pattern === 'shag') pm = smooth(0.45, 0.8, nz) * 0.45;
    c = [lerp(c[0], pat.r, pm), lerp(c[1], pat.g, pm), lerp(c[2], pat.b, pm)];
    const ao = 0.75 + 0.25 * up; // baked cavity darkening under the belly
    const v = 0.85 + 0.3 * nz;
    return [c[0] * ao * v, c[1] * ao * v, c[2] * ao * v];
  };
  const glowFn = S.glow ? (p, n) => {
    if (S.pattern === 'stripes') return smooth(0.6, 0.66, Math.sin(p.z * 22 + Math.sin(p.y * 8) * 1.5 + vnoise(p.x * 9, p.y * 9, p.z * 9) * 2) * 0.5 + 0.5) * smooth(0.0, 0.6, n.y * 0.5 + 0.5) * S.glow;
    return smooth(0.68, 0.72, vnoise(p.x * 7 + 3, p.y * 7, p.z * 7)) * S.glow;
  } : null;
  // body: deep chest, tucked waist, rounded rump (+hump)
  const body = blob(S.bodyW, S.bodyR, S.bodyLen, (z, x, y) => {
    let k = 1 + 0.12 * Math.exp(-((z - 0.45) ** 2) * 8) - 0.1 * Math.exp(-((z + 0.05) ** 2) * 10);
    if (y > 0 && S.hump) k *= 1 + S.hump * Math.exp(-((z - 0.5) ** 2) * 12) * y;
    if (y < 0) k *= 1 - 0.06 * Math.exp(-((z) ** 2) * 6);
    return k;
  }, 20, 14);
  body.translate(0, cy, 0);
  parts.push(paint(body, (p, n) => coat(p, n, Math.exp(-((p.z / S.bodyLen - 0.6) ** 2) * 10) * (n.y < 0 ? 1 : 0)), () => [0, 0, 0, 0], glowFn));
  // neck
  const neckTop = neckBase.clone().add(V(0, Math.sin(Math.atan(S.neckUp)) * S.neckLen, Math.cos(Math.atan(S.neckUp)) * S.neckLen));
  const neck = limb(neckBase.clone().add(V(0, -S.bodyR * 0.25, -S.bodyLen * 0.12)), neckTop, S.bodyR * 0.5, S.headR * 0.85, 12, 6);
  const nLen = neckTop.distanceTo(neckBase) + S.bodyLen * 0.12;
  const nDir = neckTop.clone().sub(neckBase).normalize();
  const neckW = (p) => clamp(p.clone().sub(neckBase).dot(nDir) / nLen + 0.15, 0, 1);
  parts.push(paint(neck, (p, n) => coat(p, n, 1 - Math.abs(n.x)), (p) => [0, 0, smooth(0, 1, neckW(p)), 0], glowFn));
  // head: tilted muzzle
  const hdir = V(0, -0.55, 1).normalize();
  const headC = neckTop.clone().addScaledVector(hdir, S.headLen * 0.55);
  const head = blob(S.headR * 0.85, S.headR, S.headLen * 0.6, (z) => 1 - 0.32 * smooth(-0.2, 1, z), 12, 10);
  head.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), hdir));
  head.translate(headC.x, headC.y, headC.z);
  const muzzle = headC.clone().addScaledVector(hdir, S.headLen * 0.55);
  parts.push(paint(head, (p, n) => {
    const c = coat(p, n, 0); const d = p.distanceTo(muzzle) / S.headLen;
    const m = smooth(0.35, 0.1, d); return [lerp(c[0], 0.05, m), lerp(c[1], 0.045, m), lerp(c[2], 0.04, m)];
  }, () => [0, 0, 1, 0], glowFn));
  // eyes (dark glossy beads)
  for (const s of [-1, 1]) {
    const e = blob(0.028, 0.028, 0.028, null, 6, 4);
    const ep = headC.clone().add(V(s * S.headR * 0.78, S.headR * 0.35, -S.headLen * 0.05));
    e.translate(ep.x, ep.y, ep.z);
    parts.push(paint(e, () => [0.01, 0.008, 0.006], () => [0, 0, 1, 0], S.glow ? () => 0.6 : null));
  }
  // ears
  if (S.ears > 0) for (const s of [-1, 1]) {
    const base = headC.clone().add(V(s * S.headR * 0.6, S.headR * 0.75, -S.headLen * 0.25));
    const ear = limb(base, base.clone().add(V(s * S.ears * 0.9, S.ears * 0.45, -S.ears * 0.25)), 0.035, 0.012, 6, 1);
    parts.push(paint(ear, (p, n) => coat(p, n, 0), () => [0, 0, 1, 0]));
  }
  // horns
  const hornCol = [0.12, 0.1, 0.08];
  const hornTop = headC.clone().add(V(0, S.headR * 0.8, -S.headLen * 0.25));
  if (S.horns === 'lyre' || S.horns === 'curved') for (const s of [-1, 1]) {
    let a = hornTop.clone().add(V(s * S.headR * 0.4, 0, 0));
    const steps = S.horns === 'lyre' ? [[0.05, 0.14, -0.06], [0.03, 0.12, -0.08], [-0.02, 0.1, -0.02]] : [[0.16, 0.04, -0.04], [0.08, 0.08, 0.02], [-0.02, 0.06, 0.08]];
    let r = S.headR * 0.28;
    for (const st of steps) {
      const b = a.clone().add(V(s * st[0], st[1], st[2]).multiplyScalar(S.horns === 'curved' ? 1.6 : 1));
      parts.push(paint(limb(a, b, r, r * 0.7, 6, 1), () => hornCol, () => [0, 0, 1, 0]));
      a = b; r *= 0.7;
    }
  } else if (S.horns === 'antlers') for (const s of [-1, 1]) {
    const a = hornTop.clone().add(V(s * S.headR * 0.35, 0, 0));
    const main = [a, a.clone().add(V(s * 0.18, 0.28, -0.12)), a.clone().add(V(s * 0.38, 0.5, -0.1)), a.clone().add(V(s * 0.5, 0.72, 0.05))];
    const ac = [0.32, 0.27, 0.2];
    for (let i = 0; i < 3; i++) {
      parts.push(paint(limb(main[i], main[i + 1], 0.03 - i * 0.006, 0.024 - i * 0.006, 5, 1), () => ac, () => [0, 0, 1, 0]));
      const tine = main[i + 1].clone().add(V(s * 0.02, 0.2 - i * 0.03, 0.12));
      parts.push(paint(limb(main[i + 1], tine, 0.016, 0.006, 5, 1), () => ac, () => [0, 0, 1, 0]));
    }
  } else if (S.horns === 'fan' || S.horns === 'crest') {
    // a flat fan crest: a row of thin spines with a membrane glow
    const n = S.horns === 'fan' ? 7 : 4;
    for (let i = 0; i < n; i++) {
      const u = (i / (n - 1)) * 2 - 1;
      const a = hornTop.clone().add(V(0, 0, -S.headLen * 0.1));
      const b = a.clone().add(V(u * 0.32, 0.28 + 0.06 * (1 - u * u), -0.2 - 0.05 * Math.abs(u)));
      parts.push(paint(limb(a, b, 0.02, 0.008, 5, 1), () => S.horns === 'fan' ? [0.05, 0.08, 0.2] : [0.6, 0.25, 0.2], () => [0, 0, 1, 0], S.glow ? (p) => 0.3 + 0.7 * clamp((p.y - a.y) / 0.3, 0, 1) : null));
    }
  }
  // legs (two segments + hooves)
  for (let i = 0; i < 4; i++) {
    const h = hips[i], k = knees[i];
    const foot = V(k.x, 0.05, k.z + (i < 2 ? -0.02 : 0.05) * S.legLen);
    const up = limb(h.clone().add(V(0, S.bodyR * 0.2, 0)), k, S.legR * (i < 2 ? 1.9 : 2.4), S.legR * 1.05, 8, 3);
    parts.push(paint(up, (p, n) => coat(p, n, 0), () => [i + 1, 0, 0, 0], glowFn));
    const lo = limb(k, foot, S.legR, S.legR * 0.7, 7, 2);
    parts.push(paint(lo, (p, n) => { const c = coat(p, n, 0); const d = smooth(0.35 * S.legLen, 0.1, p.y); return [lerp(c[0], c[0] * 0.5, d), lerp(c[1], c[1] * 0.5, d), lerp(c[2], c[2] * 0.5, d)]; }, () => [i + 1, 1, 0, 0]));
    const hf = blob(S.legR * 1.05, 0.05, S.legR * 1.3, null, 7, 4); hf.translate(foot.x, 0.04, foot.z + 0.01);
    parts.push(paint(hf, () => [hoof.r, hoof.g, hoof.b], () => [i + 1, 1, 0, 0]));
  }
  // tail
  if (S.tail > 0) {
    const tEnd = tailBase.clone().add(V(0, -S.tail * 0.8, -S.tail * 0.45));
    const tl = limb(tailBase, tEnd, S.bodyR * 0.12, S.bodyR * (S.pattern === 'shag' ? 0.16 : 0.05), 6, 3);
    parts.push(paint(tl, (p, n) => { const c = coat(p, n, 0); return S.pattern === 'stripes' ? c : [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6]; }, (p) => [0, 0, 0, clamp(p.distanceTo(tailBase) / S.tail, 0, 1)], glowFn));
  }
  const geo = mergeParts(parts);
  geo.computeBoundingSphere();
  return { geo, hips, knees, neckBase, tailBase };
}

// ---------------------------------------------------------------------------------
const CELL = 900;
const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3(), _n = new THREE.Vector3();

export class Herds {
  constructor(fauna, speciesIds) {
    this.fauna = fauna;
    this.world = fauna.world;
    const A = fauna.level.planet.aesthetic;
    this.species = speciesIds.map((id, k) => {
      const spec = { ...SPECIES[id], ...(RECOLOR[A] || {}) };
      if (spec.glow == null) spec.glow = 0;
      const built = buildSpecies(spec);
      const U = fauna.uniforms;
      const uni = {
        uFTime: U.uFTime, uGlowColor: { value: new THREE.Color(spec.glow ? spec.patternColor : '#000000') },
        uHip: { value: built.hips }, uKnee: { value: built.knees }, uNeck: { value: built.neckBase }, uTail: { value: built.tailBase },
        uGait: { value: new THREE.Vector4(0.42, 0.9, 0.035 * spec.legLen, 0.07) },
      };
      const mats = rigMaterial({ roughness: 0.82 }, RIG_GLSL, uni, 'herd-' + id);
      const max = fauna.q.pick(24, 48, 80, 120);
      const { mesh, anim } = makeInstanced(built.geo, mats, max);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
      fauna.root.add(mesh);
      return { id, spec, mesh, anim, uni, max, glowBase: new THREE.Color(spec.glow ? spec.patternColor : '#000000').multiplyScalar(spec.glow ? 3 : 0), weight: k === 0 ? 1 : 0.45 };
    });
    this.herds = new Map(); // key → herd
    this.forced = [];
    this.rr = 0;
    this._scanTimer = 0;
  }

  /** Deterministic herd candidate for a lattice cell (or null). */
  _cellHerd(ix, iy, iz) {
    const w = this.world, R = w.radius;
    const h = hash3i(ix, iy, iz, this.fauna.seed ^ 0x4e7d);
    if (u01(h) > this.fauna.density.herds) return null;
    const rng = new Random(h);
    for (let tries = 0; tries < 3; tries++) {
      _v.set((ix + rng.float()) * CELL, (iy + rng.float()) * CELL, (iz + rng.float()) * CELL);
      _d.copy(_v).normalize();
      _v.copy(_d).multiplyScalar(R);
      if (Math.floor(_v.x / CELL) !== ix || Math.floor(_v.y / CELL) !== iy || Math.floor(_v.z / CELL) !== iz) return null;
      const dir = _d.clone();
      if (!this.fauna.groundOK(dir, 0.9)) continue;
      return this._makeHerd(`${ix},${iy},${iz}`, dir, rng);
    }
    return null;
  }

  _makeHerd(key, dir, rng, count = 0) {
    const sp = this.species.length > 1 && !this._forceFirst && rng.float() > 0.62 ? this.species[1] : this.species[0];
    const [t1, t2] = tangentBasis(dir, new THREE.Vector3(), new THREE.Vector3());
    const S = sp.spec;
    const n = count || rng.int(S.count[0], S.count[1]);
    const herd = { key, dir, t1, t2, sp, members: [], cx: 0, cz: 0, tx: 0, tz: 0, retarget: rng.range(10, 30), rng };
    const spread = this._spread ?? (4 + n * 1.3 * S.bodyLen);
    const baseHead = rng.range(0, TAU);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, TAU), r = Math.sqrt(rng.float()) * spread;
      const m = {
        x: Math.cos(a) * r, z: Math.sin(a) * r, head: baseHead + rng.range(-0.8, 0.8), speed: 0, want: 0,
        state: 'graze', timer: rng.range(0, 8), phase: rng.range(0, TAU), gait: 0, graze: rng.float() < 0.7 ? 1 : 0,
        scale: rng.range(S.size[0], S.size[1]) * (rng.float() < 0.15 ? 0.6 : 1), // a few young ones
        tint: 0.85 + rng.float() * 0.3, hue: rng.range(-0.04, 0.04),
        gh: 0, gx: 0, gz: 0, sx: 1e9, sz: 1e9, nx: 0, nz: 0, tx: 0, tz: 0, flee: 0,
      };
      m.tx = m.x; m.tz = m.z;
      herd.members.push(m);
      this._sample(herd, m);
    }
    return herd;
  }

  /** Force a herd at a direction (screenshots). */
  spawnAt(dir, count, faceDir = null) {
    const rng = new Random(seedFrom(this.fauna.seed, 'forced', this.forced.length));
    this._spread = 3 + count * 0.8 * this.species[0].spec.bodyLen; this._forceFirst = true;
    const herd = this._makeHerd('forced' + this.forced.length, dir.clone().normalize(), rng, count);
    this._spread = null; this._forceFirst = false;
    if (faceDir) {
      const a = Math.atan2(faceDir.dot(herd.t2), faceDir.dot(herd.t1));
      for (const m of herd.members) m.head = a + rng.range(-1.2, 1.2);
    }
    this.forced.push(herd);
    this.herds.set(herd.key, herd);
    return herd;
  }

  clearForced() { for (const h of this.forced) this.herds.delete(h.key); this.forced.length = 0; }

  _sample(herd, m) {
    const w = this.world, R = w.radius;
    const dir = _d.copy(herd.dir).multiplyScalar(R).addScaledVector(herd.t1, m.x).addScaledVector(herd.t2, m.z).normalize();
    m.gh = w.heightAt(dir);
    w.normalAt(dir, _n, 0.8);
    const ny = Math.max(0.3, _n.dot(dir));
    m.gx = -_n.dot(herd.t1) / ny; m.gz = -_n.dot(herd.t2) / ny;
    m.nx = _n.dot(herd.t1); m.nz = _n.dot(herd.t2);
    m.sx = m.x; m.sz = m.z;
  }

  _scan(cam) {
    const R = this.world.radius;
    _v.copy(cam).normalize().multiplyScalar(R);
    const cx = Math.floor(_v.x / CELL), cy = Math.floor(_v.y / CELL), cz = Math.floor(_v.z / CELL);
    const keep = new Set();
    for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) {
      const key = `${cx + x},${cy + y},${cz + z}`;
      let herd = this.herds.get(key);
      if (herd === undefined) {
        // cache null results too
        herd = this._cellHerd(cx + x, cy + y, cz + z);
        this.herds.set(key, herd);
      }
      keep.add(key);
    }
    for (const k of this.herds.keys()) if (!keep.has(k) && !k.startsWith('forced')) this.herds.delete(k);
  }

  update(dt, cam, player) {
    const w = this.world, R = w.radius;
    this._scanTimer -= dt;
    if (this._scanTimer <= 0) { this._scan(cam); this._scanTimer = 1.0; }
    const active = [];
    const maxD = this.fauna.q.pick(900, 1200, 1500, 1800);
    for (const h of this.herds.values()) {
      if (!h) continue;
      _v.copy(h.dir).multiplyScalar(R);
      if (_v.distanceTo(cam) - Math.abs(cam.length() - R) > maxD && !h.key.startsWith('forced')) continue;
      active.push(h);
    }
    // sim + ground sampling budget
    let budget = this.fauna.engine.shotMode ? 1e9 : 28;
    const total = active.reduce((s, h) => s + h.members.length, 0);
    let idx = 0;
    const pl = player;
    for (const h of active) {
      // herd centroid wander
      h.retarget -= dt;
      if (h.retarget <= 0) { h.retarget = h.rng.range(15, 40); const a = h.rng.range(0, TAU); h.tx = h.cx + Math.cos(a) * 20; h.tz = h.cz + Math.sin(a) * 20; const r = Math.hypot(h.tx, h.tz); if (r > 120) { h.tx *= 120 / r; h.tz *= 120 / r; } }
      h.cx += clamp(h.tx - h.cx, -1, 1) * dt * 0.25; h.cz += clamp(h.tz - h.cz, -1, 1) * dt * 0.25;
      // player in herd plane
      let px = 1e9, pz = 1e9;
      if (pl) { _v.copy(pl).sub(_u.copy(h.dir).multiplyScalar(R)); px = _v.dot(h.t1); pz = _v.dot(h.t2); }
      const S = h.sp.spec;
      const ms = h.members;
      for (let i = 0; i < ms.length; i++) {
        const m = ms[i];
        idx++;
        // --- perception
        const dpx = m.x - px, dpz = m.z - pz, dp = Math.hypot(dpx, dpz);
        if (dp < 28 && m.state !== 'flee') { m.state = 'flee'; m.timer = 5 + (i % 4); }
        m.timer -= dt;
        let want = 0, wantHead = m.head, wantGraze = 0, wantGait = 0;
        if (m.state === 'flee') {
          want = 7 + (i % 3) * 0.8; wantGait = 1; wantHead = Math.atan2(dpz, dpx) + Math.sin(i * 1.7) * 0.25;
          if (m.timer <= 0 && dp > 40) { m.state = 'look'; m.timer = 3; h.cx = m.x; h.cz = m.z; h.tx = h.cx; h.tz = h.cz; }
        } else if (m.state === 'walk') {
          want = 1.15 + (i % 3) * 0.15; wantHead = Math.atan2(m.tz - m.z, m.tx - m.x);
          if (Math.hypot(m.tx - m.x, m.tz - m.z) < 1.2 || m.timer <= 0) { m.state = h.rng.float() < 0.75 ? 'graze' : 'look'; m.timer = h.rng.range(4, 12); }
        } else {
          wantGraze = m.state === 'graze' ? 1 : 0;
          if (m.timer <= 0) {
            m.state = 'walk'; m.timer = 12;
            const a = h.rng.range(0, TAU), r = Math.sqrt(h.rng.float()) * (4 + ms.length * 1.2 * S.bodyLen);
            m.tx = h.cx + Math.cos(a) * r; m.tz = h.cz + Math.sin(a) * r;
          }
        }
        // separation
        let sx = 0, sz = 0;
        const minD = S.bodyLen * 2.6 * m.scale;
        for (let j = 0; j < ms.length; j++) {
          if (j === i) continue;
          const o = ms[j], dx = m.x - o.x, dz = m.z - o.z, d2 = dx * dx + dz * dz;
          if (d2 < minD * minD && d2 > 1e-6) { const d = Math.sqrt(d2), k = (minD - d) / minD; sx += dx / d * k; sz += dz / d * k; }
        }
        // terrain avoidance: water and steep slopes push back toward the centroid
        const steep = Math.hypot(m.gx, m.gz);
        if ((w.hasOcean && m.gh < w.seaLevel + 0.6) || steep > 0.7) { sx += (h.cx - m.x) * 0.2; sz += (h.cz - m.z) * 0.2; if (m.state === 'graze') { m.state = 'walk'; m.tx = h.cx; m.tz = h.cz; m.timer = 8; } }
        if (sx || sz) { const ang = Math.atan2(sz, sx); if (want < 0.4) { want = 0.9; wantHead = ang; } else wantHead = lerpAngle(wantHead, ang, clamp(Math.hypot(sx, sz), 0, 0.8)); }
        // integrate
        const turn = (m.state === 'flee' ? 3.2 : 1.4) * dt;
        let da = ((wantHead - m.head + Math.PI) % TAU + TAU) % TAU - Math.PI;
        m.head += clamp(da, -turn, turn);
        const slow = want > 0 ? clamp(1 - Math.abs(da) * 0.5, 0.25, 1) : 1;
        m.speed = lerp(m.speed, want * slow, 1 - Math.exp(-dt * (want > m.speed ? 2.2 : 3.5)));
        m.gait = lerp(m.gait, wantGait, 1 - Math.exp(-dt * 2.5));
        m.graze = lerp(m.graze, wantGraze, 1 - Math.exp(-dt * 1.6));
        m.x += Math.cos(m.head) * m.speed * dt; m.z += Math.sin(m.head) * m.speed * dt;
        const stride = S.legLen * m.scale * lerp(1.5, 2.6, m.gait);
        m.phase = (m.phase + dt * m.speed / stride * TAU) % (TAU * 64);
        // ground (round-robin exact sample + slope extrapolation in between)
        if (budget > 0 && (Math.hypot(m.x - m.sx, m.z - m.sz) > 1.5 || ((this.rr + idx) % Math.max(1, Math.ceil(total / 28)) === 0))) { this._sample(h, m); budget--; }
      }
    }
    this.rr++;
    this._write(active, cam);
  }

  _write(active, cam) {
    const w = this.world, R = w.radius, anchor = this.fauna.anchor;
    for (const sp of this.species) sp.count = 0;
    const night = this.fauna.night;
    for (const h of active) {
      const sp = h.sp;
      const arr = sp.mesh.instanceMatrix.array, an = sp.anim.array, col = sp.mesh.instanceColor.array;
      for (const m of h.members) {
        if (sp.count >= sp.max) break;
        const gh = m.gh + m.gx * (m.x - m.sx) + m.gz * (m.z - m.sz);
        _d.copy(h.dir).multiplyScalar(R).addScaledVector(h.t1, m.x).addScaledVector(h.t2, m.z).normalize();
        _v.copy(_d).multiplyScalar(R + gh);
        // cull far / behind-camera members cheaply by distance only
        if (_v.distanceToSquared(cam) > 2500 * 2500) continue;
        // body up: halfway between the radial up and the ground normal
        const t1 = h.t1, t2 = h.t2;
        _u.copy(_d).addScaledVector(t1, m.nx * 0.5).addScaledVector(t2, m.nz * 0.5).normalize();
        _f.copy(t1).multiplyScalar(Math.cos(m.head)).addScaledVector(t2, Math.sin(m.head));
        // sink slightly so hooves bite into the ground on slopes
        _v.addScaledVector(_d, -0.04 - 0.25 * Math.hypot(m.gx, m.gz) * sp.spec.bodyLen * m.scale);
        const i = sp.count++;
        writeInstance(arr, i, _v, anchor, _f, _u, m.scale);
        an[i * 4] = m.phase; an[i * 4 + 1] = m.gait; an[i * 4 + 2] = m.graze; an[i * 4 + 3] = clamp(m.speed / 1.1, 0, 1.15);
        col[i * 3] = m.tint * (1 + m.hue); col[i * 3 + 1] = m.tint; col[i * 3 + 2] = m.tint * (1 - m.hue);
      }
    }
    for (const sp of this.species) {
      sp.mesh.count = sp.count;
      sp.mesh.instanceMatrix.needsUpdate = true; sp.anim.needsUpdate = true; sp.mesh.instanceColor.needsUpdate = true;
      sp.uni.uGlowColor.value.copy(sp.glowBase).multiplyScalar(0.06 + night * 1.2);
    }
  }

  dispose() { for (const sp of this.species) { sp.mesh.removeFromParent(); sp.mesh.geometry.dispose(); sp.mesh.material.dispose(); sp.mesh.customDepthMaterial.dispose(); } }
}

function lerpAngle(a, b, t) { const d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI; return a + d * t; }

export function herdSpeciesFor(aesthetic, fauna) {
  if (!fauna.includes('grazers') && !fauna.includes('walkers')) return [];
  return SPECIES_FOR[aesthetic] || ['antelope'];
}
