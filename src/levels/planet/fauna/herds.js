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
import { TAU, clamp, smooth, lerp, rigMaterial, paint, mergeParts, blob, limb, loft, mixColor, vnoise, tangentBasis, writeInstance, makeInstanced } from './common.js';

// ---------------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------------
const SPECIES = {
  // pastoral antelope-deer: russet back, cream belly, little lyre horns
  antelope: { bodyLen: 0.78, bodyR: 0.42, bodyW: 0.34, legLen: 0.92, legR: 0.075, neckLen: 0.74, neckUp: 0.95, headLen: 0.36, headR: 0.12,
    horns: 'lyre', tail: 0.22, ears: 0.13, back: '#7e4a2a', belly: '#efe0c4', pattern: 'flank', patternColor: '#3a2416', hoof: '#2a2420', size: [0.9, 1.2], count: [7, 14], rump: 1 },
  // shaggy woolly grazer (ghibli's second species: big, soft, round)
  yak: { bodyLen: 1.0, bodyR: 0.66, bodyW: 0.55, legLen: 0.72, legR: 0.13, neckLen: 0.34, neckUp: 0.25, headLen: 0.36, headR: 0.2,
    horns: 'curved', tail: 0.4, ears: 0.12, back: '#7a5e44', belly: '#b09878', pattern: 'shag', patternColor: '#d8c8a8', hoof: '#1c1814', size: [1.0, 1.25], count: [4, 8], hump: 0.25 },
  // northern elk / caribou with antlers
  elk: { bodyLen: 0.95, bodyR: 0.5, bodyW: 0.42, legLen: 1.08, legR: 0.085, neckLen: 0.6, neckUp: 0.75, headLen: 0.42, headR: 0.15,
    horns: 'antlers', tail: 0.12, ears: 0.15, back: '#5e4b3b', belly: '#c8b8a0', pattern: 'mane', patternColor: '#ddd2c0', hoof: '#201a16', size: [0.95, 1.2], count: [6, 12] },
  // Pandora six-limbed-looking grazer: dark indigo hide with glowing cyan stripes and a head fan
  hexa: { bodyLen: 0.85, bodyR: 0.42, bodyW: 0.33, legLen: 1.0, legR: 0.07, neckLen: 0.72, neckUp: 0.85, headLen: 0.42, headR: 0.12,
    horns: 'fan', tail: 0.5, ears: 0.0, back: '#2e4278', belly: '#7a9cc0', pattern: 'stripes', patternColor: '#3fd8ff', glow: 1, hoof: '#101420', size: [1.0, 1.3], count: [6, 12] },
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
uniform vec3 uKnee[4];   // carpus (fore) / hock (hind)
uniform vec3 uFetlock[4];
uniform vec3 uNeckP[3];  // neck root, mid-neck, poll
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
    bool fore = leg < 2;
    // pastern: folds in the swing, counter-rotates in stance so the hoof stays flat on the ground
    if (aRig.y > 1.5) faSwing(p, n, uFetlock[leg], -k * (fore ? 1.1 : 0.9) - a * 0.8 * (1.0 - lift));
    // cannon below the carpus / hock (the hock also flexes a little while grazing-stepping)
    if (aRig.y > 0.5) faSwing(p, n, uKnee[leg], fore ? -k * 1.25 : -k * 0.85);
    // hind: the stifle flexes forward as the hock closes (reciprocal apparatus)
    if (!fore && aRig.y < 0.5 && p.y < uKnee[leg].y + (uHip[leg].y - uKnee[leg].y) * 0.75) faSwing(p, n, uHip[leg] - vec3(0.0, (uHip[leg].y - uKnee[leg].y) * 0.4, 0.0), k * 0.25);
    faSwing(p, n, uHip[leg], a);
  }
  if (aRig.z > 0.0) {
    // the neck curves as a chain: poll, mid-neck and root each take a share (distal first = correct FK)
    float t = aRig.z;
    float look = sin(uFTime * 0.37 + id * 2.1) * 0.35 * (1.0 - graze) * (1.0 - gait);
    float down = graze * 1.0 + sin(uFTime * 5.0 + id) * 0.05 * graze - gait * 0.25 + amp * 0.06 * sin(ph * 2.0);
    float w2 = smoothstep(0.88, 0.97, t), w1 = smoothstep(0.42, 0.62, t), w0 = smoothstep(0.02, 0.3, t);
    faSwing(p, n, uNeckP[2], -(down * 0.42 + 0.12 * graze) * w2);
    faSwing(p, n, uNeckP[1], -down * 0.4 * w1);
    faSwing(p, n, uNeckP[0], -down * 0.62 * w0);
    faYaw(p, n, uNeckP[0], look * w0);
    faYaw(p, n, uNeckP[2], look * 0.6 * w2);
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

function buildSpecies(spec, Q = 2) {
  const S = spec;
  const back = new THREE.Color(S.back), belly = new THREE.Color(S.belly), pat = new THREE.Color(S.patternColor), hoof = new THREE.Color(S.hoof);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const g = (u, c, w) => Math.exp(-(((u - c) / w) ** 2));
  const hipY = S.legLen, cy = S.legLen + S.bodyR * 0.55, L = S.legLen, r = S.legR;
  const AR = [12, 14, 18, 20][Q], LR = [8, 9, 10, 12][Q]; // ring resolution by quality
  const parts = [];
  const zF = S.bodyLen * 0.58, zB = -S.bodyLen * 0.56, xL = S.bodyW * 0.6;
  const hips = [V(xL, hipY + S.bodyR * 0.25, zF), V(-xL, hipY + S.bodyR * 0.25, zF), V(xL, hipY + S.bodyR * 0.3, zB), V(-xL, hipY + S.bodyR * 0.3, zB)];
  const knees = hips.map((h, i) => (i < 2 ? V(h.x * 0.92, L * 0.42, h.z + 0.01 * L) : V(h.x * 0.9, L * 0.47, h.z - 0.17 * L)));
  const fetlocks = hips.map((h, i) => (i < 2 ? V(h.x * 0.92, L * 0.12, h.z + 0.015 * L) : V(h.x * 0.9, L * 0.115, h.z - 0.085 * L)));
  const tailBase = V(0, cy + S.bodyR * 0.42, -S.bodyLen * 0.93);
  // colour: counter-shading + pattern + markings
  const coat = (p, n, extra = 0) => {
    const up = clamp(n.y * 0.5 + 0.5, 0, 1);
    let t = smooth(0.25, 0.75, up);
    const yy = (p.y - hipY) / (S.bodyR * 1.6);
    t = clamp(t * 0.65 + clamp(yy, 0, 1) * 0.5, 0, 1);
    let c = mixColor(belly, back, t);
    const nz = vnoise(p.x * 9, p.y * 9, p.z * 9);
    let pm = 0;
    if (S.pattern === 'flank') pm = smooth(0.05, 0.0, Math.abs(yy - 0.18 + Math.sin(p.z * 3) * 0.04)) * (1 - Math.abs(n.y)) * 0.9;
    else if (S.pattern === 'mane') pm = smooth(0.6, 0.9, extra);
    else if (S.pattern === 'shag') pm = smooth(0.45, 0.8, nz) * 0.45;
    c = [lerp(c[0], pat.r, pm), lerp(c[1], pat.g, pm), lerp(c[2], pat.b, pm)];
    // darker dorsal line, sooty lower legs
    const dors = smooth(0.06, 0.0, Math.abs(p.x)) * smooth(0.6, 0.95, n.y) * 0.3;
    const sock = p.y < L * 0.5 && p.y > 0.06 ? smooth(L * 0.5, L * 0.2, p.y) * 0.5 : 0;
    // pale rump patch (antelope): breaks the silhouette at distance like a real herd
    if (S.rump && p.y > L * 0.75) { const rp = smooth(-0.15, -0.6, n.z) * smooth(-S.bodyLen * 0.2, -S.bodyLen * 0.45, p.z); c = [lerp(c[0], belly.r, rp), lerp(c[1], belly.g, rp), lerp(c[2], belly.b, rp)]; }
    const k = 1 - dors - sock;
    const ao = 0.75 + 0.25 * up;
    const v = 0.85 + 0.3 * nz;
    return [c[0] * ao * v * k, c[1] * ao * v * k, c[2] * ao * v * k];
  };
  // --- torso: lofted sections — deep chest keel, withers, tucked flank, rounded rump and hip points
  const TR = [];
  const NT = [16, 20, 26, 30][Q];
  for (let i = 0; i <= NT; i++) {
    const u = -1 + (2 * i) / NT, e = Math.pow(Math.max(0, 1 - u * u), u < 0 ? 0.36 : 0.44);
    const rx = S.bodyW * e * (1 + 0.12 * g(u, -0.55, 0.22) + 0.07 * g(u, 0.5, 0.25) - 0.1 * g(u, 0.02, 0.3));
    let yt = S.bodyR * e * (1 + 0.1 * g(u, 0.6, 0.16) + 0.07 * g(u, -0.55, 0.2) - 0.05 * g(u, 0.08, 0.28));
    if (S.hump) yt *= 1 + S.hump * g(u, 0.5, 0.3);
    const yb = S.bodyR * e * (0.86 + 0.26 * g(u, 0.36, 0.3) - 0.17 * g(u, -0.38, 0.28));
    TR.push({ c: V(0, cy + S.bodyR * 0.07 * u - (yb - yt) * 0.15, u * S.bodyLen * 1.02), rx, yt, yb, sq: 0.25, keel: 0.55 * g(u, 0.3, 0.45) });
  }
  const body = loft(TR, AR + 4);
  parts.push(paint(body, (p, n) => coat(p, n, Math.exp(-((p.z / S.bodyLen - 0.6) ** 2) * 10) * (n.y < 0 ? 1 : 0)), () => [0, 0, 0, 0]));
  // --- neck: a curved loft rising out of the withers / brisket, thick and deep at the root
  const ang = Math.atan(S.neckUp);
  const nb0 = V(0, cy + S.bodyR * 0.05, S.bodyLen * 0.5);
  const neckTop = V(0, cy + S.bodyR * 0.35 + Math.sin(ang) * S.neckLen, S.bodyLen * 0.72 + Math.cos(ang) * S.neckLen);
  const nCtrl = V(0, cy + S.bodyR * 0.5 + Math.sin(ang) * S.neckLen * 0.35, S.bodyLen * 0.78 + Math.cos(ang) * S.neckLen * 0.25);
  const bez = (t) => V(0, (1 - t) ** 2 * nb0.y + 2 * (1 - t) * t * nCtrl.y + t * t * neckTop.y, (1 - t) ** 2 * nb0.z + 2 * (1 - t) * t * nCtrl.z + t * t * neckTop.z);
  const NR = [];
  for (let i = 0; i <= 9; i++) {
    const t = i / 9, k = Math.pow(1 - t, 1.3);
    const rx = lerp(S.headR * 0.6, S.bodyW * 0.46, k) * (i === 0 ? 0.6 : 1);
    const yy = lerp(S.headR * 0.85, S.bodyR * 0.62, k) * (i === 0 ? 0.6 : 1);
    NR.push({ c: bez(t), rx, yt: yy * (S.pattern === 'mane' ? 1.1 : 0.95), yb: yy * 1.08, sq: 0.1, rig: [0, 0, lerp(0.02, 0.95, t), 0] });
  }
  const neckP = [bez(0.22), bez(0.6), neckTop.clone()];
  const neck = loft(NR, AR);
  parts.push(paint(neck, (p, n) => coat(p, n, 1 - Math.abs(n.x))));
  // --- head: cranium → jaw → muzzle loft, ears as leaf cards, glossy eyes
  const HL = S.headLen * 1.3, HR = S.headR * 1.35;
  const hdir = V(0, -0.62, 1).normalize();
  const h0 = neckTop.clone().addScaledVector(hdir, -HL * 0.08);
  const HP = [[0, 0.25, 0.35, 0.3], [0.08, 0.85, 0.9, 0.75], [0.25, 0.95, 0.9, 0.95], [0.45, 0.78, 0.72, 0.9], [0.65, 0.6, 0.6, 0.7], [0.85, 0.52, 0.55, 0.6], [0.98, 0.45, 0.48, 0.5], [1.03, 0.18, 0.2, 0.2]];
  const head = loft(HP.map(([s, x, yt, yb]) => ({ c: h0.clone().addScaledVector(hdir, s * HL).add(V(0, -0.05 * HR * Math.sin(s * Math.PI), 0)), rx: x * HR * 0.82, yt: yt * HR, yb: yb * HR, sq: 0.2, rig: [0, 0, 1, 0] })), AR - 2);
  const muzzle = h0.clone().addScaledVector(hdir, HL);
  const headC = h0.clone().addScaledVector(hdir, HL * 0.28);
  parts.push(paint(head, (p, n) => {
    const c = coat(p, n, 0); const d = p.distanceTo(muzzle) / HL;
    const m = smooth(0.24, 0.06, d); // dark wet nose
    const w = S.pattern === 'flank' ? smooth(0.42, 0.3, d) * smooth(0.12, 0.2, d) * 0.6 : 0; // pale muzzle ring
    return [lerp(lerp(c[0], 0.9, w), 0.04, m), lerp(lerp(c[1], 0.86, w), 0.035, m), lerp(lerp(c[2], 0.8, w), 0.03, m)];
  }));
  for (const s of [-1, 1]) {
    const e = blob(0.034 * HR / 0.16, 0.03 * HR / 0.16, 0.036 * HR / 0.16, null, 8, 6);
    const ep = headC.clone().add(V(s * HR * 0.66, HR * 0.38, 0));
    e.translate(ep.x, ep.y, ep.z);
    parts.push(paint(e, () => [0.012, 0.009, 0.007], () => [0, 0, 1, 0], S.glow ? () => 0.6 : null));
  }
  if (S.ears > 0) for (const s of [-1, 1]) {
    const base = headC.clone().add(V(s * HR * 0.5, HR * 0.72, -HL * 0.12));
    const dirE = V(s * 0.85, 0.5, -0.2).normalize(), E = S.ears * 1.25;
    const ER = [];
    for (let i = 0; i <= 5; i++) { const t = i / 5, wdt = Math.sin(Math.PI * Math.pow(t, 0.75)) + (i === 0 ? 0.35 : 0); ER.push({ c: base.clone().addScaledVector(dirE, t * E).add(V(0, 0, E * 0.12 * Math.sin(t * Math.PI))), rx: E * 0.07 * (1 - t * 0.6), yt: E * 0.24 * wdt, yb: E * 0.24 * wdt, rig: [0, 0, 1, 0] }); }
    const ear = loft(ER, 8, V(0, 0, 1));
    parts.push(paint(ear, (p, n) => { const c = coat(p, n, 0); const inner = n.z > 0.3 ? 0.55 : 1; return [c[0] * inner, c[1] * inner, c[2] * inner]; }));
  }
  // --- horns
  const hornCol = (p, n, base) => { const k = 0.7 + 0.3 * Math.abs(Math.sin(p.distanceTo(base) * 90)); return [0.1 * k, 0.085 * k, 0.07 * k]; };
  const hornTop = headC.clone().add(V(0, HR * 0.8, -HL * 0.12));
  if (S.horns === 'lyre' || S.horns === 'curved') for (const s of [-1, 1]) {
    const base = hornTop.clone().add(V(s * HR * 0.32, 0, 0));
    const hl = S.horns === 'lyre' ? 0.58 : 0.5, r0 = HR * (S.horns === 'lyre' ? 0.26 : 0.3);
    const HRn = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const c = S.horns === 'lyre'
        ? base.clone().add(V(s * hl * (0.06 + 0.22 * Math.sin(Math.PI * t * 0.85) - 0.08 * t * t), hl * t, -hl * 0.38 * t + hl * 0.32 * t * t * t))
        : base.clone().add(V(s * hl * (0.5 * Math.sin(t * 1.6)), hl * (0.25 * Math.sin(t * 3.0)), hl * (-0.15 * t + 0.35 * t * t)));
      const ridge = 1 + 0.14 * Math.max(0, Math.sin(t * 46)) * (1 - t);
      const rr = r0 * (1 - 0.82 * t) * ridge;
      HRn.push({ c, rx: rr, yt: rr, yb: rr, rig: [0, 0, 1, 0] });
    }
    const horn = loft(HRn, 7);
    parts.push(paint(horn, (p, n) => hornCol(p, n, base)));
  } else if (S.horns === 'antlers') for (const s of [-1, 1]) {
    const a = hornTop.clone().add(V(s * HR * 0.3, 0, 0));
    const main = [a, a.clone().add(V(s * 0.18, 0.28, -0.12)), a.clone().add(V(s * 0.38, 0.5, -0.1)), a.clone().add(V(s * 0.5, 0.72, 0.05))];
    const ac = [0.32, 0.27, 0.2];
    for (let i = 0; i < 3; i++) {
      parts.push(paint(limb(main[i], main[i + 1], 0.03 - i * 0.006, 0.024 - i * 0.006, 6, 1), () => ac, () => [0, 0, 1, 0]));
      const tine = main[i + 1].clone().add(V(s * 0.02, 0.2 - i * 0.03, 0.12));
      parts.push(paint(limb(main[i + 1], tine, 0.016, 0.006, 5, 1), () => ac, () => [0, 0, 1, 0]));
    }
  } else if (S.horns === 'fan' || S.horns === 'crest') {
    const n = S.horns === 'fan' ? 7 : 4;
    for (let i = 0; i < n; i++) {
      const u = (i / (n - 1)) * 2 - 1;
      const a = hornTop.clone().add(V(0, 0, -HL * 0.08));
      const b = a.clone().add(V(u * 0.32, 0.28 + 0.06 * (1 - u * u), -0.2 - 0.05 * Math.abs(u)));
      parts.push(paint(limb(a, b, 0.02, 0.008, 5, 1), () => S.horns === 'fan' ? [0.05, 0.08, 0.2] : [0.6, 0.25, 0.2], () => [0, 0, 1, 0], S.glow ? (p) => 0.3 + 0.7 * clamp((p.y - a.y) / 0.3, 0, 1) : null));
    }
  }
  // --- legs: muscled upper (forearm / gaskin), knobbed carpus or backward hock, slim cannon,
  //     fetlock, sloped pastern and a hoof — rig 0 upper, 1 cannon, 2 pastern
  for (let i = 0; i < 4; i++) {
    const h = hips[i], K = knees[i], F = fetlocks[i], fore = i < 2, x = K.x;
    const LRg = fore ? [
      [V(h.x * 0.85, h.y + S.bodyR * 0.45, h.z + 0.02), 2.0, 2.2, 2.2, 0],
      [V(x, L * 0.86, h.z + 0.03 * L), 2.0, 2.3, 1.9, 0],          // elbow / upper forearm (muscle)
      [V(x, L * 0.66, h.z + 0.02 * L), 1.5, 1.6, 1.4, 0],
      [V(x, L * 0.5, K.z + 0.004 * L), 1.25, 1.25, 1.2, 0],
      [V(K.x, K.y, K.z), 1.3, 1.4, 1.35, 0],                         // carpus knob
      [V(x, L * 0.36, K.z + 0.002 * L), 0.95, 0.9, 1.1, 1],
      [V(x, L * 0.24, K.z + 0.006 * L), 0.82, 0.8, 1.05, 1],         // cannon (tendon behind)
      [V(F.x, F.y + 0.03 * L, F.z - 0.005 * L), 1.0, 1.0, 1.25, 1],
      [V(F.x, F.y, F.z), 1.02, 1.05, 1.2, 1],                        // fetlock
      [V(x, L * 0.06, F.z + 0.03 * L), 0.82, 0.85, 0.9, 2],          // pastern
      [V(x, 0.045, F.z + 0.055 * L), 1.0, 1.05, 1.0, 2],             // coronet
      [V(x, 0.008, F.z + 0.08 * L), 1.15, 1.3, 1.0, 2],              // hoof sole
      [V(x, 0.0, F.z + 0.07 * L), 0.3, 0.3, 0.3, 2],
    ] : [
      [V(h.x * 0.85, h.y + S.bodyR * 0.4, h.z + 0.06), 2.4, 2.5, 2.5, 0],
      [V(x, L * 0.84, h.z + 0.1 * L), 2.3, 2.6, 2.4, 0],            // stifle / thigh
      [V(x, L * 0.68, h.z - 0.02 * L), 1.55, 1.4, 1.9, 0],           // gaskin
      [V(x, L * 0.54, K.z + 0.02 * L), 1.25, 1.1, 1.4, 0],
      [V(K.x, K.y, K.z - 0.01 * L), 1.15, 1.0, 1.55, 0],             // hock point (backward)
      [V(x, L * 0.36, K.z + 0.025 * L), 0.9, 0.85, 1.15, 1],
      [V(x, L * 0.24, F.z - 0.02 * L), 0.8, 0.8, 1.05, 1],
      [V(F.x, F.y + 0.03 * L, F.z - 0.004 * L), 0.98, 1.0, 1.2, 1],
      [V(F.x, F.y, F.z), 1.0, 1.05, 1.15, 1],
      [V(x, L * 0.06, F.z + 0.03 * L), 0.8, 0.85, 0.9, 2],
      [V(x, 0.045, F.z + 0.05 * L), 0.98, 1.0, 1.0, 2],
      [V(x, 0.008, F.z + 0.075 * L), 1.12, 1.25, 1.0, 2],
      [V(x, 0.0, F.z + 0.065 * L), 0.3, 0.3, 0.3, 2],
    ];
    const leg = loft(LRg.map(([c, rx, yf, yb, seg]) => ({ c, rx: rx * r, yt: yf * r, yb: yb * r, sq: 0.1, rig: [i + 1, seg, 0, 0] })), LR);
    parts.push(paint(leg, (p, n) => {
      if (p.y < 0.05) return [hoof.r, hoof.g, hoof.b];
      return coat(p, n, 0);
    }));
  }
  // --- tail
  if (S.tail > 0) {
    const TRn = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const c = tailBase.clone().add(V(0, -S.tail * 0.85 * t + S.tail * 0.12 * Math.sin(t * 2.5), -S.tail * 0.35 * t - S.bodyR * 0.08));
      const rr = S.bodyR * (S.pattern === 'shag' ? lerp(0.13, 0.17, t) : lerp(0.11, 0.03, t) + (t > 0.6 ? 0.04 * smooth(0.6, 0.85, t) * (1 - smooth(0.9, 1, t)) : 0));
      TRn.push({ c, rx: rr, yt: rr, yb: rr, rig: [0, 0, 0, t] });
    }
    const tl = loft(TRn, 8);
    parts.push(paint(tl, (p, n) => { const c = coat(p, n, 0); return S.pattern === 'stripes' ? c : [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55]; }));
  }
  const geo = mergeParts(parts);
  geo.computeBoundingSphere();
  return { geo, hips, knees, fetlocks, neckP, tailBase };
}

/** Per-pixel coat: fur breakup (two-scale mottling + strands combed along the body and down the legs) and the pattern. */
function surfaceGLSL(S) {
  const pc = new THREE.Color(S.patternColor);
  const v3 = `vec3(${pc.r.toFixed(3)}, ${pc.g.toFixed(3)}, ${pc.b.toFixed(3)})`;
  const y0 = (S.legLen * 0.3).toFixed(3), G = (S.glow || 0).toFixed(3), legTop = (S.legLen * 0.9).toFixed(3);
  const shag = S.pattern === 'shag' ? 1.6 : 1.0;
  const pattern = S.pattern === 'stripes' ? `
    float s = sin(p.z * 22.0 + sin(p.y * 8.0) * 1.5 + faNoise(p * 9.0) * 2.0);
    float sfw = max(fwidth(s), 1e-4);
    float ln = smoothstep(0.92 - sfw, 0.96 + sfw, s) * smoothstep(-0.2, 0.55, n.y) * step(0.3, faNoise(p * 3.0 + 1.7));
    // a slow pulse of light travels along the body
    ln *= 0.45 + 0.55 * smoothstep(0.2, 0.9, sin(p.z * 3.0 - uFTime * 1.4) * 0.5 + 0.5);
    ln = max(ln, faLine(p.x * 14.0, 0.12) * smoothstep(0.6, 0.9, n.y) * 0.8);
    float dots = smoothstep(0.8, 0.86, faNoise(p * 26.0)) * smoothstep(0.1, 0.8, n.y) * 0.8;
    float m = max(ln, dots) * step(${y0}, p.y);
    col = mix(col, ${v3} * 0.35, m * 0.6);
    glow = m * ${G};` : S.pattern === 'spots' ? `
    float sp = faNoise(p * 7.0 + 3.0); float fw = max(fwidth(sp), 1e-4);
    float m = smoothstep(0.64 - fw, 0.64 + fw, sp) * smoothstep(-0.2, 0.6, n.y) * step(${y0}, p.y);
    col = mix(col, ${v3}, m);
    glow = m * ${G};` : '';
  return `void faSurface(vec3 p, vec3 n, inout vec3 col, inout float glow) {
    if (glow > 0.01 || p.y < 0.05) return; // eyes, crest and hooves keep their own look
    // fur: strands combed along the body axis (and down the legs), filtered by the pixel footprint
    vec3 sp = p.y < ${legTop} && abs(n.y) < 0.8 ? vec3(p.x * 70.0, p.y * 7.0, p.z * 70.0) : vec3(p.x * 60.0, p.y * 60.0, p.z * 7.0);
    sp *= ${(1 / shag).toFixed(3)};
    float fwS = length(fwidth(sp));
    float strand = mix(0.5, faNoise(sp), 1.0 - smoothstep(0.35, 1.1, fwS));
    float b1 = faNoise(p * 9.0), b2 = faNoise(p * 37.0);
    col *= (0.86 + 0.28 * b1) * mix(1.0, 0.9 + 0.2 * b2, 1.0 - smoothstep(0.4, 1.4, fwS * 0.5)) * (0.8 + 0.4 * strand);
    ${pattern}
  }`;
}

const SHADOW_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`;
const SHADOW_FRAG = /* glsl */ `uniform float uDark; varying vec2 vUv; void main() { float r = dot(vUv, vUv); float a = clamp(exp(-r * 3.0) - 0.05, 0.0, 1.0); gl_FragColor = vec4(0.0, 0.0, 0.0, a * uDark); }`;

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
      const built = buildSpecies(spec, fauna.q.level ?? 2);
      const U = fauna.uniforms;
      const uni = {
        uFTime: U.uFTime, uGlowColor: { value: new THREE.Color(spec.glow ? spec.patternColor : '#000000') },
        uHip: { value: built.hips }, uKnee: { value: built.knees }, uFetlock: { value: built.fetlocks }, uNeckP: { value: built.neckP }, uTail: { value: built.tailBase },
        uGait: { value: new THREE.Vector4(0.42, 0.9, 0.035 * spec.legLen, 0.07) },
      };
      const sheen = new THREE.Color(spec.back).lerp(new THREE.Color(spec.belly), 0.5).multiplyScalar(0.9);
      // soft fur silhouette (fuzz brightens grazing angles); luminous species get a bioluminescent rim so the body reads at night
      const fuzz = `{ vec3 faVd = normalize(vViewPosition); float faR = pow(1.0 - abs(dot(normalize(vNormal), faVd)), 3.0);
        diffuseColor.rgb *= 1.0 + 0.45 * faR;${spec.glow ? ' faGlow = max(faGlow, 0.16 * faR + 0.015);' : ''} }`;
      const mats = rigMaterial({ roughness: 0.86 }, RIG_GLSL, uni, 'herd-' + id, { surface: surfaceGLSL(spec), bounce: 0.35, sheen, surfaceMain: fuzz });
      const max = fauna.q.pick(24, 48, 80, 120);
      // no shadow-map casting (thin legs alias into dithered streaks at cascade
      // resolution): each animal gets an analytic soft contact shadow instead
      const { mesh, anim } = makeInstanced(built.geo, mats, max, { shadow: false });
      mesh.receiveShadow = true;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
      fauna.root.add(mesh);
      const sg = new THREE.PlaneGeometry(1, 1); sg.rotateX(-Math.PI / 2);
      const shadow = new THREE.InstancedMesh(sg, new THREE.ShaderMaterial({ vertexShader: SHADOW_VERT, fragmentShader: SHADOW_FRAG, uniforms: { uDark: { value: 0.55 } }, transparent: true, depthWrite: false }), max);
      shadow.instanceMatrix.setUsage(THREE.DynamicDrawUsage); shadow.frustumCulled = false; shadow.count = 0; shadow.renderOrder = 1;
      fauna.root.add(shadow);
      return { id, spec, mesh, anim, uni, max, shadow, glowBase: new THREE.Color(spec.glow ? spec.patternColor : '#000000').multiplyScalar(spec.glow ? 3 : 0), weight: k === 0 ? 1 : 0.45 };
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
  spawnAt(dir, count, faceDir = null, eye = null) {
    const rng = new Random(seedFrom(this.fauna.seed, 'forced', this.forced.length));
    this._spread = 3 + count * 0.8 * this.species[0].spec.bodyLen; this._forceFirst = true;
    const herd = this._makeHerd('forced' + this.forced.length, dir.clone().normalize(), rng, count);
    this._spread = null; this._forceFirst = false;
    if (faceDir) {
      const a = Math.atan2(faceDir.dot(herd.t2), faceDir.dot(herd.t1));
      for (const m of herd.members) m.head = a + rng.range(-1.2, 1.2);
    }
    if (eye) this._heroPose(herd, eye, rng);
    this.forced.push(herd);
    this.herds.set(herd.key, herd);
    return herd;
  }

  /** Wildlife-photography staging: a diagonal line of action with depth, a sentinel looking at the lens, one walking in, a juvenile. */
  _heroPose(herd, eye, rng) {
    const R = this.world.radius, ms = herd.members, n = ms.length, S = herd.sp.spec;
    _v.copy(eye).sub(_u.copy(herd.dir).multiplyScalar(R));
    let ex = _v.dot(herd.t1), ez = _v.dot(herd.t2); const el = Math.hypot(ex, ez) || 1;
    const tx = ex / el, tz = ez / el, lx = -tz, lz = tx; // toward the eye / lateral
    const span = 3.2 + n * 1.1 * S.bodyLen;
    for (let i = 0; i < n; i++) {
      const m = ms[i], u = n > 1 ? i / (n - 1) - 0.5 : 0;
      // diagonal: the near end sits left-and-close, the far end right-and-deep
      const along = u * span * 1.5 + rng.range(-0.6, 0.6), depth = -u * span * 1.1 + rng.range(-1.2, 1.2) + (i % 3 === 1 ? -span * 0.25 : 0);
      m.x = lx * along + tx * depth; m.z = lz * along + tz * depth; m.tx = m.x; m.tz = m.z;
      this._sample(herd, m);
      const toEye = Math.atan2(ez - m.z, ex - m.x);
      if (i === 1 || i === Math.floor(n * 0.6)) { m.state = 'look'; m.graze = 0; m.timer = 60; m.head = toEye + rng.range(-0.5, 0.5); }
      else if (i === 2) { m.state = 'walk'; m.timer = 60; m.head = toEye + 0.7; m.tx = m.x + Math.cos(m.head) * 30; m.tz = m.z + Math.sin(m.head) * 30; m.speed = 1.1; }
      else { m.state = 'graze'; m.graze = 1; m.timer = 60; }
      if (i === n - 1 && n > 4) m.scale = S.size[0] * 0.6;
    }
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
        // contact shadow: ground-hugging soft ellipse, pushed away from the sun
        const S = sp.spec, sc = m.scale;
        _v.addScaledVector(_d, 0.1 + 0.04 + 0.25 * Math.hypot(m.gx, m.gz) * S.bodyLen * sc);
        const sd = this.world.sunDir; const sk = clamp(1 - sd.dot(_d), 0, 0.9);
        _n.copy(sd).addScaledVector(_d, -sd.dot(_d));
        if (_n.lengthSq() > 1e-6) _v.addScaledVector(_n.normalize(), -S.legLen * sc * sk * 0.6);
        writeDecal(sp.shadow.instanceMatrix.array, i, _v, anchor, _f, _u, S.bodyW * 3.4 * sc, (S.bodyLen * 2.6 + S.legLen * sk * 0.8) * sc);
        an[i * 4] = m.phase; an[i * 4 + 1] = m.gait; an[i * 4 + 2] = m.graze; an[i * 4 + 3] = clamp(m.speed / 1.1, 0, 1.15);
        col[i * 3] = m.tint * (1 + m.hue); col[i * 3 + 1] = m.tint; col[i * 3 + 2] = m.tint * (1 - m.hue);
      }
    }
    for (const sp of this.species) {
      sp.mesh.count = sp.count; sp.shadow.count = sp.count; sp.shadow.instanceMatrix.needsUpdate = true;
      sp.shadow.material.uniforms.uDark.value = 0.55 * (1 - 0.6 * night);
      sp.mesh.instanceMatrix.needsUpdate = true; sp.anim.needsUpdate = true; sp.mesh.instanceColor.needsUpdate = true;
      sp.uni.uGlowColor.value.copy(sp.glowBase).multiplyScalar(0.03 + night * 0.5);
    }
  }

  dispose() { for (const sp of this.species) { sp.shadow.removeFromParent(); sp.shadow.geometry.dispose(); sp.shadow.material.dispose(); sp.mesh.removeFromParent(); sp.mesh.geometry.dispose(); sp.mesh.material.dispose(); sp.mesh.customDepthMaterial.dispose(); } }
}

const _dx = new THREE.Vector3(), _dz = new THREE.Vector3();
function writeDecal(arr, i, pos, anchor, fwd, up, sx, sz) {
  _dz.copy(fwd).addScaledVector(up, -fwd.dot(up)).normalize();
  _dx.copy(up).cross(_dz);
  const o = i * 16;
  arr[o] = _dx.x * sx; arr[o + 1] = _dx.y * sx; arr[o + 2] = _dx.z * sx; arr[o + 3] = 0;
  arr[o + 4] = up.x; arr[o + 5] = up.y; arr[o + 6] = up.z; arr[o + 7] = 0;
  arr[o + 8] = _dz.x * sz; arr[o + 9] = _dz.y * sz; arr[o + 10] = _dz.z * sz; arr[o + 11] = 0;
  arr[o + 12] = pos.x - anchor.x; arr[o + 13] = pos.y - anchor.y; arr[o + 14] = pos.z - anchor.z; arr[o + 15] = 1;
}

function lerpAngle(a, b, t) { const d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI; return a + d * t; }

export function herdSpeciesFor(aesthetic, fauna) {
  if (!fauna.includes('grazers') && !fauna.includes('walkers')) return [];
  return SPECIES_FOR[aesthetic] || ['antelope'];
}
