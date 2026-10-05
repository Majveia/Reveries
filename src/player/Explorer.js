// The Explorer — a procedural third-person hero, sculpted entirely from signed
// distance fields at load time:
//   · a smooth skinned under-suit (one SDF body, Surface-Nets meshed, skin
//     weights derived from per-bone primitive distances),
//   · bevelled hard-shell armour plates that conform to the body (offset shells
//     of the body field intersected with designed outlines), rigidly skinned,
//   · a helmet with a deep glass visor, side pods and an antenna,
//   · a jetpack with twin thruster pods and shoulder straps,
//   · a wrapped scarf collar (the flowing tails are simulated in Scarf.js).
// Every vertex carries material data (albedo, roughness/metal, accent-line and
// panel-seam signed distances, baked SDF ambient occlusion) consumed by the
// shaders in Materials.js.
//
// Character space: +Y up, +Z forward, +X = character's LEFT. Feet at y = 0.

import * as THREE from 'three';
import {
  sdSphere, sdEllipsoid, sdCapsule, sdRoundCone, sdRoundBox, sdBox, sdTorus, sdCylinder,
  smin, smax, meshSDF, sdfAO, clamp, smoothstep,
} from './SDF.js';

export const BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'clavL', 'upperArmL', 'foreArmL', 'handL',
  'clavR', 'upperArmR', 'foreArmR', 'handR',
  'thighL', 'shinL', 'footL', 'toeL',
  'thighR', 'shinR', 'footR', 'toeR',
];
export const B = Object.fromEntries(BONES.map((n, i) => [n, i]));
export const PARENT = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  clavL: 'chest', upperArmL: 'clavL', foreArmL: 'upperArmL', handL: 'foreArmL',
  clavR: 'chest', upperArmR: 'clavR', foreArmR: 'upperArmR', handR: 'foreArmR',
  thighL: 'hips', shinL: 'thighL', footL: 'shinL', toeL: 'footL',
  thighR: 'hips', shinR: 'thighR', footR: 'shinR', toeR: 'footR',
};

// ---- small vector helpers on plain arrays (fast, allocation-light) ----------------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---- palette (sRGB hex → linear) ---------------------------------------------------
const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
export const PALETTE = {
  ivory: lin('#e4ddcc'),
  ivoryWarm: lin('#d9d0bd'),
  graphite: lin('#2a2d33'),
  gunmetal: lin('#3b3f47'),
  suit: lin('#4a515d'),
  suitDark: lin('#2c3139'),
  glove: lin('#1b1d21'),
  sole: lin('#121316'),
  scarf: lin('#a3202a'),
  accent: new THREE.Color('#62f0ff'),
  glyph: new THREE.Color('#ffc865'),
};

// =====================================================================================
// Skeleton specification (bind pose = A-pose)
// =====================================================================================
export function skeletonSpec() {
  const J = {};
  J.hips = [0, 0.975, 0.0];
  J.spine = [0, 1.085, -0.008];
  J.chest = [0, 1.275, -0.014];
  J.neck = [0, 1.478, -0.024];
  J.head = [0, 1.588, -0.006];
  const beta = THREE.MathUtils.degToRad(40); // arm angle from vertical in the A-pose
  for (const [S, s] of [['L', 1], ['R', -1]]) {
    J['clav' + S] = [s * 0.028, 1.43, -0.016];
    const sh = [s * 0.182, 1.428, -0.03];
    J['upperArm' + S] = sh;
    const dA = norm([s * Math.sin(beta), -Math.cos(beta), 0.035]);
    J['dA' + S] = dA;
    J['foreArm' + S] = add(sh, mul(dA, 0.285));
    J['hand' + S] = add(J['foreArm' + S], mul(dA, 0.255));
    J['handEnd' + S] = add(J['hand' + S], mul(dA, 0.175));
    J['thigh' + S] = [s * 0.094, 0.928, 0.004];
    J['shin' + S] = [s * 0.1, 0.508, 0.018];
    J['foot' + S] = [s * 0.104, 0.088, -0.018];
    J['toe' + S] = [s * 0.106, 0.026, 0.118];
    J['toeEnd' + S] = [s * 0.106, 0.02, 0.192];
  }
  // Rest frames (columns X, Y, Z in character space). Limbs: Y runs along the
  // bone toward the child, X is the hinge axis (positive rotation = flexion).
  const F = {};
  const ident = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const frameFrom = (Y, hintX) => {
    const y = norm(Y);
    let x = sub(hintX, mul(y, dot(hintX, y)));
    x = norm(x);
    const z = cross(x, y);
    return [x, y, z];
  };
  for (const n of ['hips', 'spine', 'chest', 'neck', 'head', 'clavL', 'clavR', 'footL', 'footR', 'toeL', 'toeR']) F[n] = ident;
  for (const S of ['L', 'R']) {
    const dA = J['dA' + S];
    const hinge = norm(cross(dA, [0, 0, 1]));
    F['upperArm' + S] = frameFrom(dA, hinge);
    F['foreArm' + S] = F['upperArm' + S];
    F['hand' + S] = F['upperArm' + S];
    F['thigh' + S] = frameFrom(sub(J['shin' + S], J['thigh' + S]), [1, 0, 0]);
    F['shin' + S] = frameFrom(sub(J['foot' + S], J['shin' + S]), [1, 0, 0]);
  }
  const lengths = {
    thigh: len(sub(J.shinL, J.thighL)), shin: len(sub(J.footL, J.shinL)),
    upperArm: 0.285, foreArm: 0.255, hand: 0.175,
  };
  return { J, F, lengths, beta };
}

/** Build THREE.Bones in the bind pose. Returns { bones[], root }. */
export function buildBones(spec) {
  const { J, F } = spec;
  const bones = [];
  const worldQ = {};
  const m = new THREE.Matrix4();
  for (const name of BONES) {
    const b = new THREE.Bone();
    b.name = name;
    const f = F[name];
    m.makeBasis(new THREE.Vector3(...f[0]), new THREE.Vector3(...f[1]), new THREE.Vector3(...f[2]));
    worldQ[name] = new THREE.Quaternion().setFromRotationMatrix(m);
    bones.push(b);
  }
  for (const name of BONES) {
    const b = bones[B[name]];
    const p = PARENT[name];
    if (!p) { b.position.set(...J[name]); b.quaternion.copy(worldQ[name]); continue; }
    const pb = bones[B[p]];
    pb.add(b);
    const inv = worldQ[p].clone().invert();
    b.position.set(...sub(J[name], J[p])).applyQuaternion(inv);
    b.quaternion.copy(inv).multiply(worldQ[name]);
  }
  return { bones, root: bones[0], restWorldQ: worldQ };
}

// =====================================================================================
// Body field (under-suit)
// =====================================================================================
function makeBody(spec) {
  const { J } = spec;
  const prims = []; // { bone, f, bone2?, w2? }
  const P = (bone, f, extra) => { prims.push({ bone: B[bone], f, ...(extra || {}) }); return f; };

  // torso
  const pelvis = P('hips', (x, y, z) => sdEllipsoid(x, y, z, 0, 0.958, -0.008, 0.156, 0.104, 0.113));
  const crotch = P('hips', (x, y, z) => sdEllipsoid(x, y, z, 0, 0.875, -0.004, 0.072, 0.06, 0.082));
  const gluteL = P('hips', (x, y, z) => sdEllipsoid(x, y, z, 0.07, 0.905, -0.052, 0.083, 0.086, 0.076));
  const gluteR = P('hips', (x, y, z) => sdEllipsoid(x, y, z, -0.07, 0.905, -0.052, 0.083, 0.086, 0.076));
  const abdomen = P('spine', (x, y, z) => sdRoundCone(x, y, (z + 0.004) / 0.84 - 0.004, 0, 1.0, 0.0, 0, 1.19, -0.004, 0.122, 0.13) * 0.84);
  const ribs = P('chest', (x, y, z) => sdEllipsoid(x, y, z, 0, 1.305, -0.012, 0.164, 0.152, 0.112));
  const pecL = P('chest', (x, y, z) => sdEllipsoid(x, y, z, 0.072, 1.346, 0.05, 0.08, 0.062, 0.05));
  const pecR = P('chest', (x, y, z) => sdEllipsoid(x, y, z, -0.072, 1.346, 0.05, 0.08, 0.062, 0.05));
  const latL = P('chest', (x, y, z) => sdEllipsoid(x, y, z, 0.112, 1.27, -0.04, 0.07, 0.12, 0.07));
  const latR = P('chest', (x, y, z) => sdEllipsoid(x, y, z, -0.112, 1.27, -0.04, 0.07, 0.12, 0.07));
  const traps = P('chest', (x, y, z) => sdCapsule(x, y, z, -0.125, 1.432, -0.036, 0.125, 1.432, -0.036, 0.056));
  const uback = P('chest', (x, y, z) => sdEllipsoid(x, y, z, 0, 1.385, -0.062, 0.12, 0.085, 0.068));
  const neck = P('neck', (x, y, z) => sdRoundCone(x, y, z, 0, 1.42, -0.022, 0, 1.6, -0.006, 0.058, 0.05));
  const torso = (x, y, z) => {
    let d = smin(pelvis(x, y, z), abdomen(x, y, z), 0.06);
    d = smin(d, crotch(x, y, z), 0.04);
    d = smin(d, smin(gluteL(x, y, z), gluteR(x, y, z), 0.03), 0.035);
    d = smin(d, ribs(x, y, z), 0.07);
    d = smin(d, smin(pecL(x, y, z), pecR(x, y, z), 0.03), 0.04);
    d = smin(d, smin(latL(x, y, z), latR(x, y, z), 0.03), 0.05);
    d = smin(d, traps(x, y, z), 0.05);
    d = smin(d, uback(x, y, z), 0.05);
    d = smin(d, neck(x, y, z), 0.035);
    return d;
  };

  const arms = [];
  const legs = [];
  for (const [S, s] of [['L', 1], ['R', -1]]) {
    const sh = J['upperArm' + S], el = J['foreArm' + S], wr = J['hand' + S], dA = J['dA' + S];
    const palmN = norm([-s * Math.cos(spec.beta), -Math.sin(spec.beta), 0]); // palm faces body/down
    const wAx = norm(sub([0, 0, 1], mul(dA, dot([0, 0, 1], dA))));
    const nAx = norm(cross(wAx, dA)); // completes frame; sign-corrected below
    const pn = dot(nAx, palmN) < 0 ? mul(nAx, -1) : nAx;
    const deltC = add(sh, [s * 0.012, 0.014, 0.0]);
    const delt = P('upperArm' + S, (x, y, z) => sdEllipsoid(x, y, z, deltC[0], deltC[1], deltC[2], 0.071, 0.068, 0.074));
    const uarm = P('upperArm' + S, (x, y, z) => sdRoundCone(x, y, z, sh[0], sh[1], sh[2], el[0], el[1], el[2], 0.061, 0.046));
    const farm = P('foreArm' + S, (x, y, z) => sdRoundCone(x, y, z, el[0], el[1], el[2], wr[0], wr[1], wr[2], 0.046, 0.033));
    const fbul = add(add(el, mul(dA, 0.075)), mul(wAx, -0.004));
    const fbulge = P('foreArm' + S, (x, y, z) => sdEllipsoid(x, y, z, fbul[0], fbul[1], fbul[2], 0.047, 0.047, 0.047));
    const palmC = add(add(wr, mul(dA, 0.052)), mul(pn, -0.002));
    const palm = P('hand' + S, (x, y, z) => sdRoundBox(x, y, z, palmC, wAx, dA, pn, 0.041, 0.05, 0.018, 0.014));
    // fingers curl slightly toward the palm
    const fDir = norm(add(mul(dA, Math.cos(0.38)), mul(pn, Math.sin(0.38))));
    const fN = norm(sub(pn, mul(fDir, dot(pn, fDir))));
    const fingC = add(add(wr, mul(dA, 0.118)), mul(pn, 0.016));
    const fing = P('hand' + S, (x, y, z) => sdRoundBox(x, y, z, fingC, wAx, fDir, fN, 0.039, 0.038, 0.014, 0.012));
    const thA = add(add(add(wr, mul(dA, 0.024)), mul(wAx, 0.03)), mul(pn, 0.008));
    const thB = add(add(add(wr, mul(dA, 0.082)), mul(wAx, 0.046)), mul(pn, 0.03));
    const thumb = P('hand' + S, (x, y, z) => sdCapsule(x, y, z, thA[0], thA[1], thA[2], thB[0], thB[1], thB[2], 0.0135));
    arms.push((x, y, z) => {
      let d = smin(delt(x, y, z), uarm(x, y, z), 0.03);
      d = smin(d, smin(farm(x, y, z), fbulge(x, y, z), 0.03), 0.022);
      const h = smin(smin(palm(x, y, z), fing(x, y, z), 0.012), thumb(x, y, z), 0.012);
      return smin(d, h, 0.016);
    });

    const hp = J['thigh' + S], kn = J['shin' + S], an = J['foot' + S];
    const thigh = P('thigh' + S, (x, y, z) => sdRoundCone(x, y, z, hp[0], hp[1], hp[2], kn[0], kn[1], kn[2], 0.09, 0.058));
    const qc = add(lerp3(hp, kn, 0.4), [s * 0.004, 0, 0.02]);
    const quad = P('thigh' + S, (x, y, z) => sdEllipsoid(x, y, z, qc[0], qc[1], qc[2], 0.07, 0.135, 0.068));
    const knee = P('shin' + S, (x, y, z) => sdSphere(x, y, z, kn[0], kn[1], kn[2] + 0.002, 0.046), { bone2: B['thigh' + S] });
    const shin = P('shin' + S, (x, y, z) => sdRoundCone(x, y, z, kn[0], kn[1], kn[2], an[0], an[1], an[2], 0.051, 0.038));
    const cc = add(kn, [0, -0.135, -0.03]);
    const calf = P('shin' + S, (x, y, z) => sdEllipsoid(x, y, z, cc[0], cc[1], cc[2], 0.05, 0.105, 0.054));
    const fx = s * 0.105;
    const heel = P('foot' + S, (x, y, z) => sdBox(x, y, z, fx, 0.052, -0.032, 0.047, 0.052, 0.056, 0.03));
    const mid = P('foot' + S, (x, y, z) => sdBox(x, y, z, fx, 0.04, 0.066, 0.05, 0.04, 0.074, 0.028));
    const ankleCuff = P('foot' + S, (x, y, z) => sdCapsule(x, y, z, an[0], an[1] - 0.01, an[2], an[0], an[1] + 0.05, an[2], 0.047));
    const toe = P('toe' + S, (x, y, z) => sdEllipsoid(x, y, z, fx, 0.034, 0.15, 0.05, 0.034, 0.056));
    legs.push((x, y, z) => {
      let d = smin(thigh(x, y, z), quad(x, y, z), 0.04);
      d = smin(d, knee(x, y, z), 0.03);
      d = smin(d, smin(shin(x, y, z), calf(x, y, z), 0.04), 0.03);
      let f = smin(smin(heel(x, y, z), mid(x, y, z), 0.03), toe(x, y, z), 0.03);
      f = smin(f, ankleCuff(x, y, z), 0.03);
      f = smax(f, -y, 0.006); // flat sole
      return smin(d, f, 0.025);
    });
  }

  const field = (x, y, z) => {
    let d = torso(x, y, z);
    d = smin(d, arms[0](x, y, z), 0.022);
    d = smin(d, arms[1](x, y, z), 0.022);
    d = smin(d, legs[0](x, y, z), 0.03);
    d = smin(d, legs[1](x, y, z), 0.03);
    return d;
  };
  return { field, prims };
}

// =====================================================================================
// Hard-surface pieces
// =====================================================================================
// Each piece: { name, bone, f(x,y,z), bounds, h, color(p)→rgb, mat(p)→[rough, metal],
//               line(p)→signed distance to accent line, seam(p)→signed distance to seam }
const FAR = 1;

// Armour plate: a solid band from 12 mm *inside* the supporting body field out to
// offset+thick. The buried inner face is hidden by the suit (and culled at build
// time) so only the outer skin and a clean, chunky rim are visible.
function shell(d, offset, thick) { const o = offset * 0.6 + thick * 0.8; return Math.max(d - o, -(d + 0.012)); }

function makePieces(spec, body) {
  const { J } = spec;
  const pieces = [];
  const ivory = PALETTE.ivory, graphite = PALETTE.graphite, gun = PALETTE.gunmetal;

  // ---- chest plate ----------------------------------------------------------------
  {
    const base = (x, y, z) => {
      let d = sdEllipsoid(x, y, z, 0, 1.305, -0.012, 0.164, 0.152, 0.112);
      d = smin(d, smin(sdEllipsoid(x, y, z, 0.072, 1.346, 0.05, 0.08, 0.062, 0.05), sdEllipsoid(x, y, z, -0.072, 1.346, 0.05, 0.08, 0.062, 0.05), 0.03), 0.04);
      return d;
    };
    const f = (x, y, z) => {
      const ax = Math.abs(x);
      let d = shell(base(x, y, z), 0.016, 0.013);
      const topY = 1.452 - smoothstep(0.07, 0.165, ax) * 0.075;
      let region = Math.max(1.152 - y, y - topY);
      region = Math.max(region, -0.04 - z);
      // V-neck
      const v = ax - (0.05 + Math.max(0, y - 1.36) * 0.95);
      region = Math.max(region, -v);
      // side cut for the arms
      region = Math.max(region, ax - 0.172);
      return smax(d, region, 0.007);
    };
    pieces.push({
      name: 'chestPlate', bone: B.chest, f, bounds: [-0.2, 1.12, -0.08, 0.2, 1.48, 0.14], h: 0.0065,
      color: () => ivory, mat: () => [0.34, 0.0], split: (x, y) => y - 1.19,
      line: (x, y, z) => (y < 1.205 ? y - 1.171 : FAR),
      seam: (x, y, z) => (y > 1.2 ? (Math.abs(x) < 0.09 ? x : (Math.abs(x) - 0.135)) : FAR),
    });
  }
  // ---- back plate (under the pack) ------------------------------------------------------
  {
    const f = (x, y, z) => {
      const d = shell(sdEllipsoid(x, y, z, 0, 1.31, -0.015, 0.164, 0.152, 0.112), 0.012, 0.012);
      let region = Math.max(1.17 - y, y - 1.445);
      region = Math.max(region, z + 0.035);
      region = Math.max(region, Math.abs(x) - 0.15);
      return smax(d, region, 0.007);
    };
    pieces.push({
      name: 'backPlate', bone: B.chest, f, bounds: [-0.19, 1.14, -0.16, 0.19, 1.47, 0.0], h: 0.008,
      color: () => graphite, mat: () => [0.45, 0.3], line: () => FAR, seam: (x, y) => y - 1.3,
    });
  }
  // ---- belt + buckle ---------------------------------------------------------------------
  {
    const f = (x, y, z) => {
      const b = sdRoundCone(x, y, (z + 0.004) / 0.86 - 0.004, 0, 0.95, 0.0, 0, 1.06, -0.002, 0.135, 0.128) * 0.86;
      let d = shell(b, 0.004, 0.02);
      d = smax(d, Math.max(0.975 - y, y - 1.022), 0.006);
      const buckle = sdRoundBox(x, y, z, [0, 0.999, 0.118], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.036, 0.03, 0.012, 0.008);
      return smin(d, buckle, 0.004);
    };
    pieces.push({
      name: 'belt', bone: B.hips, f, bounds: [-0.18, 0.95, -0.15, 0.18, 1.05, 0.15], h: 0.007,
      color: () => ivory, mat: () => [0.32, 0], split: (x, y, z) => Math.min(z - 0.1, 0.04 - Math.abs(x)),
      line: (x, y, z) => (z > 0.1 ? Math.hypot(x, y - 0.999) - 0.008 : FAR),
      seam: () => FAR,
    });
  }
  // ---- hip guards ---------------------------------------------------------------------
  for (const s of [1, -1]) {
    const f = (x, y, z) => {
      const d = shell(sdEllipsoid(x, y, z, 0, 0.94, -0.008, 0.156, 0.11, 0.113), 0.012, 0.011);
      let region = Math.max(0.865 - y, y - 0.975);
      region = Math.max(region, 0.105 - s * x);
      region = Math.max(region, Math.abs(z + 0.005) - 0.075);
      return smax(d, region, 0.008);
    };
    pieces.push({
      name: 'hip' + s, bone: B.hips, f, bounds: [s > 0 ? 0.08 : -0.2, 0.84, -0.11, s > 0 ? 0.2 : -0.08, 1.0, 0.1], h: 0.0065,
      color: () => ivory, mat: () => [0.32, 0], line: () => FAR, seam: (x, y) => y - 0.92,
    });
  }

  for (const [S, s] of [['L', 1], ['R', -1]]) {
    const sh = J['upperArm' + S], el = J['foreArm' + S], wr = J['hand' + S], dA = J['dA' + S];
    // ---- pauldron ---------------------------------------------------------------------
    {
      const c = add(sh, [s * 0.016, 0.02, -0.004]);
      const out = norm([s * 1, 0.25, 0]);
      const f = (x, y, z) => {
        const p = [x, y, z];
        const d = shell(sdEllipsoid(x, y, z, c[0], c[1], c[2], 0.068, 0.062, 0.072), 0.012, 0.012);
        const rel = sub(p, sh);
        let region = dot(rel, dA) - 0.062; // only the cap near the joint
        region = Math.max(region, -dot(rel, out) - 0.012); // open toward the neck
        // second lame (layered): cut a step
        return smax(d, region, 0.008);
      };
      const lame = (x, y, z) => {
        const p = [x, y, z];
        const d = shell(sdRoundCone(x, y, z, sh[0], sh[1], sh[2], el[0], el[1], el[2], 0.057, 0.043), 0.013, 0.011);
        const t = dot(sub(p, sh), dA);
        let region = Math.max(0.055 - t, t - 0.105);
        region = Math.max(region, -dot(sub(p, sh), out) + 0.01);
        return smax(d, region, 0.006);
      };
      const g = (x, y, z) => Math.min(f(x, y, z), lame(x, y, z));
      const lo = [Math.min(sh[0], el[0]) - 0.12, sh[1] - 0.17, -0.13], hi = [Math.max(sh[0], el[0]) + 0.12, sh[1] + 0.12, 0.1];
      pieces.push({
        name: 'pauldron' + S, bone: B['upperArm' + S], f: g, bounds: [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]], h: 0.0062,
        color: () => ivory, mat: () => [0.32, 0], split: (x, y, z) => 0.05 - dot(sub([x, y, z], sh), dA),
        line: (x, y, z) => { const t = dot(sub([x, y, z], sh), dA); return t < 0.05 ? t - 0.03 : FAR; },
        seam: () => FAR,
      });
    }
    // ---- bracer + wrist cuff ---------------------------------------------------------------
    {
      const out = norm([s * Math.cos(spec.beta), Math.sin(spec.beta), 0]); // outer (back of forearm) side in A-pose
      const f = (x, y, z) => {
        const p = [x, y, z];
        const d = shell(sdRoundCone(x, y, z, el[0], el[1], el[2], wr[0], wr[1], wr[2], 0.044, 0.031), 0.009, 0.01);
        const t = dot(sub(p, el), dA);
        let region = Math.max(0.045 - t, t - 0.235);
        // open slit on the inner (palm) side
        const rel = sub(sub(p, el), mul(dA, t));
        const side = dot(norm(rel), out);
        region = Math.max(region, (-side - 0.55) * 0.05);
        let dd = smax(d, region, 0.006);
        if (s > 0) { // wrist computer on the left forearm
          const cc = add(add(el, mul(dA, 0.17)), mul(out, 0.043));
          const zA = norm(cross(dA, out));
          dd = Math.min(dd, sdRoundBox(x, y, z, cc, zA, dA, out, 0.022, 0.034, 0.01, 0.006));
        }
        // cuff ring
        const cuff = sdCylinder(x, y, z, ...add(el, mul(dA, 0.226)), ...add(el, mul(dA, 0.252)), 0.041, 0.006);
        return Math.min(dd, cuff);
      };
      const lo = [Math.min(el[0], wr[0]) - 0.07, Math.min(el[1], wr[1]) - 0.07, -0.08], hi = [Math.max(el[0], wr[0]) + 0.07, Math.max(el[1], wr[1]) + 0.07, 0.08];
      pieces.push({
        name: 'bracer' + S, bone: B['foreArm' + S], f, bounds: [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]], h: 0.0058,
        color: () => ivory, mat: () => [0.33, 0], split: (x, y, z) => 0.22 - dot(sub([x, y, z], el), dA),
        line: (x, y, z) => {
          const p = [x, y, z], t = dot(sub(p, el), dA);
          if (s > 0) { // wrist screen glows
            const cc = add(add(el, mul(dA, 0.17)), mul(out, 0.043));
            const q = sub(p, cc);
            if (dot(q, out) > 0.004 && Math.abs(dot(q, dA)) < 0.03) return Math.max(Math.abs(dot(q, dA)) - 0.022, Math.abs(dot(q, norm(cross(dA, out)))) - 0.014);
          }
          if (t < 0.06 || t > 0.215) return FAR;
          const rel = sub(sub(p, el), mul(dA, t));
          const zA = norm(cross(dA, out));
          return dot(rel, zA) * 1.0; // stripe along the outer ridge
        },
        seam: (x, y, z) => dot(sub([x, y, z], el), dA) - 0.13,
      });
    }
    // ---- thigh plate ------------------------------------------------------------------
    {
      const hp = J['thigh' + S], kn = J['shin' + S];
      const ax = norm(sub(kn, hp));
      const f = (x, y, z) => {
        const p = [x, y, z];
        const d = shell(sdRoundCone(x, y, z, hp[0], hp[1], hp[2], kn[0], kn[1], kn[2], 0.086, 0.056), 0.022, 0.011);
        const t = dot(sub(p, hp), ax);
        let region = Math.max(0.09 - t, t - 0.33);
        const rel = sub(sub(p, hp), mul(ax, t));
        const a = Math.atan2(rel[0] * s, rel[2]); // 0 = front, +π/2 = outer side
        region = Math.max(region, (Math.abs(a - 0.55) - 1.05) * 0.06);
        return smax(d, region, 0.007);
      };
      pieces.push({
        name: 'thigh' + S, bone: B['thigh' + S], f, bounds: [hp[0] - 0.13, kn[1] - 0.02, -0.12, hp[0] + 0.13, hp[1] - 0.05, 0.14], h: 0.0065,
        color: () => ivory, mat: () => [0.3, 0],
        line: (x, y, z) => {
          const p = [x, y, z], t = dot(sub(p, hp), ax);
          if (t < 0.12 || t > 0.3) return FAR;
          const rel = sub(sub(p, hp), mul(ax, t));
          const a = Math.atan2(rel[0] * s, rel[2]);
          return (a - 1.05) * 0.09; // vertical stripe on the outer side
        },
        seam: (x, y, z) => dot(sub([x, y, z], hp), ax) - 0.2,
      });
    }
    // ---- knee cap + greave --------------------------------------------------------------
    {
      const kn = J['shin' + S], an = J['foot' + S];
      const ax = norm(sub(an, kn));
      const f = (x, y, z) => {
        const p = [x, y, z];
        let cap = shell(sdEllipsoid(x, y, z, kn[0], kn[1] - 0.004, kn[2] + 0.014, 0.05, 0.058, 0.042), 0.006, 0.01);
        cap = smax(cap, Math.max(kn[2] - 0.008 - z, Math.abs(y - kn[1] + 0.004) - 0.064), 0.008);
        const sh = shell(sdRoundCone(x, y, z, kn[0], kn[1], kn[2], an[0], an[1], an[2], 0.051, 0.038), 0.012, 0.011);
        const t = dot(sub(p, kn), ax);
        let region = Math.max(0.075 - t, t - 0.345);
        const rel = sub(sub(p, kn), mul(ax, t));
        const a = Math.atan2(rel[0] * s, rel[2]);
        region = Math.max(region, (Math.abs(a - 0.25) - 1.35) * 0.05);
        const gr = smax(sh, region, 0.007);
        return Math.min(cap, gr);
      };
      pieces.push({
        name: 'shin' + S, bone: B['shin' + S], f, bounds: [kn[0] - 0.1, an[1], -0.1, kn[0] + 0.1, kn[1] + 0.08, 0.11], h: 0.0062,
        color: () => ivory, mat: () => [0.33, 0], split: (x, y) => (kn[1] - 0.075) - y,
        line: (x, y, z) => {
          const p = [x, y, z], t = dot(sub(p, kn), ax);
          if (t < 0.1 || t > 0.32) return FAR;
          const rel = sub(sub(p, kn), mul(ax, t));
          return Math.atan2(rel[0] * s, rel[2]) * 0.05 - 0.004; // front centre stripe
        },
        seam: (x, y, z) => dot(sub([x, y, z], kn), ax) - 0.21,
      });
    }
    // ---- boot shell + toe cap ---------------------------------------------------------------
    {
      const fx = s * 0.105, an = J['foot' + S];
      const footF = (x, y, z) => {
        let f = smin(sdBox(x, y, z, fx, 0.052, -0.032, 0.047, 0.052, 0.056, 0.03), sdBox(x, y, z, fx, 0.04, 0.066, 0.05, 0.04, 0.074, 0.028), 0.03);
        f = smin(f, sdCapsule(x, y, z, an[0], an[1] - 0.01, an[2], an[0], an[1] + 0.05, an[2], 0.047), 0.03);
        return f;
      };
      const f = (x, y, z) => {
        const d = shell(footF(x, y, z), 0.006, 0.01);
        let region = Math.max(0.03 - y, y - 0.145);
        region = Math.max(region, z - 0.11);
        return smax(d, region, 0.006);
      };
      pieces.push({
        name: 'boot' + S, bone: B['foot' + S], f, bounds: [fx - 0.08, 0.0, -0.11, fx + 0.08, 0.17, 0.13], h: 0.0062,
        color: () => ivory, mat: () => [0.36, 0], split: (x, y) => y - 0.05,
        line: (x, y, z) => (z < -0.06 ? y - 0.075 : FAR), seam: (x, y, z) => z - 0.02,
      });
      const toeF = (x, y, z) => {
        const d = shell(sdEllipsoid(x, y, z, fx, 0.034, 0.15, 0.05, 0.034, 0.056), 0.005, 0.009);
        return smax(d, Math.max(0.026 - y, 0.112 - z), 0.006);
      };
      pieces.push({
        name: 'toe' + S, bone: B['toe' + S], f: toeF, bounds: [fx - 0.07, 0.0, 0.08, fx + 0.07, 0.09, 0.23], h: 0.006,
        color: () => ivory, mat: () => [0.32, 0], line: () => FAR, seam: () => FAR,
      });
    }
  }

  // ---- helmet ---------------------------------------------------------------------------
  const HC = [0, 1.668, 0.014];
  const helmetOuter = (x, y, z) => {
    let d = sdEllipsoid(x, y, z, HC[0], HC[1] + 0.004, HC[2] - 0.006, 0.116, 0.134, 0.13);
    d = smin(d, sdEllipsoid(x, y, z, 0, 1.596, 0.052, 0.09, 0.07, 0.092), 0.04); // faceplate / jaw
    d = smin(d, sdEllipsoid(x, y, z, 0, 1.6, -0.058, 0.1, 0.066, 0.084), 0.04); // back of neck
    // cheek guards: subtle planes that break the egg silhouette
    for (const s of [1, -1]) d = smin(d, sdRoundBox(x, y, z, [s * 0.078, 1.6, 0.06], norm([s, 0, 0.45]), [0, 1, 0], norm([-s * 0.45, 0, 1]), 0.012, 0.05, 0.045, 0.01), 0.022);
    return d;
  };
  const visorShape = (x, y) => {
    // rounded, slightly wider at the top (2D outline on the front face)
    const yy = y - 1.666;
    const hw = 0.098 - Math.max(0, -yy) * 0.4;
    return Math.max(Math.abs(x) - hw, Math.abs(yy + (x * x) * 1.1) - 0.046);
  };
  {
    const f = (x, y, z) => {
      const o = helmetOuter(x, y, z);
      // solid shell; the visor glass and its gasket are clean parametric meshes on top
      let d = smax(o, 1.528 - y, 0.01); // neck opening
      // crest ridge
      const crest = smax(sdBox(x, y, z, 0, 1.775, -0.03, 0.008, 0.05, 0.11, 0.005), o - 0.003, 0.004);
      d = smin(d, crest, 0.006);
      // side pods
      for (const s of [1, -1]) {
        d = smin(d, sdCylinder(x, y, z, s * 0.1, 1.662, -0.004, s * 0.134, 1.662, -0.004, 0.034, 0.007), 0.008);
      }
      return d;
    };
    pieces.push({
      name: 'helmet', bone: B.head, f, bounds: [-0.17, 1.5, -0.17, 0.17, 1.84, 0.18], h: 0.006,
      color: () => ivory, mat: () => [0.28, 0.0],
      split: (x, y, z) => {
        const ax = Math.abs(x);
        const pod = Math.min(ax - 0.118, 0.022 - Math.hypot(y - 1.662, z + 0.004));
        const crest = Math.min(0.0105 - ax, y - 1.73);
        const chin = 1.57 - y;
        return -Math.max(pod, crest, chin);
      },
      line: (x, y, z) => {
        if (Math.abs(x) > 0.128) return Math.hypot(y - 1.662, z + 0.004) - 0.025; // pod rings
        if (y < 1.6 && z < -0.02) return y - 1.582; // rear glow line
        // visor wrap: a thin light band continuing the visor gasket around the helmet sides
        if (Math.abs(x) > 0.07 && z > -0.11 && z < 0.07 && y > 1.6 && y < 1.7) return y - (1.64 + z * 0.22);
        return FAR;
      },
      seam: (x, y, z) => {
        if (Math.abs(x) < 0.14 && z < 0.06 && y > 1.6) return Math.abs(x) - 0.03;
        return FAR;
      },
    });
    // neck seal ring (chest)
    const ringN = norm([0, 1, 0.16]);
    pieces.push({
      name: 'neckRing', bone: B.chest, f: (x, y, z) => sdTorus(x, y, z, [0, 1.478, -0.012], ringN, 0.083, 0.02),
      bounds: [-0.13, 1.42, -0.12, 0.13, 1.54, 0.1], h: 0.0055,
      color: () => graphite, mat: () => [0.38, 0.55], line: (x, y, z) => (z > 0.04 ? y - 1.49 : FAR), seam: () => FAR,
    });
    // antenna on the left pod
    pieces.push({
      name: 'antenna', bone: B.head,
      f: (x, y, z) => Math.min(sdCapsule(x, y, z, 0.134, 1.685, -0.02, 0.142, 1.8, -0.075, 0.0035), sdSphere(x, y, z, 0.142, 1.8, -0.075, 0.0065)),
      bounds: [0.12, 1.66, -0.1, 0.16, 1.82, 0.0], h: 0.0035,
      color: () => graphite, mat: () => [0.35, 0.6], line: (x, y, z) => Math.hypot(x - 0.142, y - 1.8, z + 0.075) - 0.0068, seam: () => FAR,
    });
  }

  // ---- jetpack ----------------------------------------------------------------------------
  const packMain = (x, y, z) => {
    const taper = 1 - (1.29 - y) * 0.32;
    let d = sdRoundBox(x / taper, y, z, [0, 1.29, -0.198], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.118, 0.165, 0.062, 0.05) * Math.min(1, taper);
    d = smax(d, -(z + 0.135) , 0.02); // flat-ish face against the back
    return d;
  };
  const pods = (x, y, z) => Math.min(
    sdCapsule(x, y, z, 0.128, 1.13, -0.212, 0.128, 1.39, -0.205, 0.043),
    sdCapsule(x, y, z, -0.128, 1.13, -0.212, -0.128, 1.39, -0.205, 0.043));
  const nozzles = (x, y, z) => {
    let d = FAR;
    for (const s of [1, -1]) {
      const outer = sdCylinder(x, y, z, s * 0.128, 1.115, -0.214, s * 0.128, 1.058, -0.222, 0.035, 0.006);
      const inner = sdCylinder(x, y, z, s * 0.128, 1.09, -0.216, s * 0.128, 1.04, -0.225, 0.025, 0.0);
      d = Math.min(d, Math.max(outer, -inner));
    }
    return d;
  };
  {
    const f = (x, y, z) => {
      let d = smin(packMain(x, y, z), pods(x, y, z), 0.025);
      // centre spine
      d = smin(d, sdRoundBox(x, y, z, [0, 1.3, -0.262], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.03, 0.15, 0.012, 0.008), 0.008);
      // top handle
      d = Math.min(d, sdTorus(x, y, z, [0, 1.462, -0.205], [0, 0, 1], 0.045, 0.009));
      d = Math.min(d, nozzles(x, y, z));
      // straps over the shoulders
      for (const s of [1, -1]) {
        const a = [s * 0.095, 1.405, -0.142], b = [s * 0.112, 1.478, -0.05], c = [s * 0.118, 1.445, 0.062], e = [s * 0.11, 1.36, 0.105];
        d = Math.min(d, sdCapsule(x, y, z, ...a, ...b, 0.012), sdCapsule(x, y, z, ...b, ...c, 0.012), sdCapsule(x, y, z, ...c, ...e, 0.011));
      }
      return d;
    };
    pieces.push({
      name: 'jetpack', bone: B.chest, f, bounds: [-0.2, 1.02, -0.3, 0.2, 1.5, 0.13], h: 0.0068,
      color: () => ivory, mat: () => [0.31, 0.0],
      split: (x, y, z) => -Math.max(z + 0.15, Math.min(0.032 - Math.abs(x), -0.25 - z), 1.12 - y, Math.abs(x) - 0.098),
      line: (x, y, z) => {
        if (Math.abs(x) < 0.032 && z < -0.26 && y > 1.18 && y < 1.42) return Math.abs(x) - 0.006; // spine light
        if (y < 1.095 && Math.abs(Math.abs(x) - 0.128) < 0.03) return Math.hypot(Math.abs(x) - 0.128, z + 0.218) - 0.022; // nozzle mouth
        if (Math.abs(x) > 0.1 && z < -0.24 && y < 1.19) return y - 1.17; // pod vent band
        if (Math.abs(x) > 0.1 && y > 1.2 && y < 1.355) { // outer-back light strip on each pod
          const dx = Math.abs(x) - 0.128, dz = z + 0.21;
          if (dx * dx + dz * dz > 0.03 * 0.03) return (Math.atan2(-dz, dx) - 0.75) * 0.043;
        }
        return FAR;
      },
      seam: (x, y, z) => {
        if (Math.abs(x) > 0.1) return Math.min(Math.abs(y - 1.36), Math.abs(y - 1.195));
        return z < -0.15 ? Math.min(Math.abs(y - 1.215), Math.abs(y - 1.39)) : FAR;
      },
    });
  }

  // ---- scarf collar (fabric, rendered with the scarf material) ------------------------------
  const collar = {
    name: 'collar', bone: B.chest, cloth: true,
    f: (x, y, z) => {
      const c = [0, 1.47, -0.014];
      const n = norm([0, 1, 0.22]);
      const px = x - c[0], py = y - c[1], pz = z - c[2];
      const ang = Math.atan2(px, pz);
      // wrapped folds
      const wob = 0.006 * Math.sin(ang * 5 + 0.7) + 0.004 * Math.sin(ang * 9 - 1.3);
      let d = sdTorus(x, y, z, c, n, 0.092 + wob, 0.031 + 0.004 * Math.sin(ang * 3));
      // second wrap, slightly lower and offset, gives a layered knot at the back-left
      d = smin(d, sdTorus(x, y, z, [0.0, 1.448, -0.02], norm([0.12, 1, 0.3]), 0.096, 0.026), 0.02);
      // knot at the back
      d = smin(d, sdEllipsoid(x, y, z, 0.035, 1.45, -0.112, 0.045, 0.04, 0.03), 0.02);
      return d;
    },
    bounds: [-0.16, 1.38, -0.17, 0.16, 1.56, 0.14], h: 0.0062,
  };

  return { pieces, collar, helmetOuter, visorShape, HC, packMain, pods };
}

// =====================================================================================
// Geometry assembly
// =====================================================================================
let CACHE = null;

/**
 * Build (or fetch from cache) all raw geometry arrays. Pure CPU work.
 * quality: 0..3 (coarser grids on low tiers).
 */
export function buildExplorerData(quality = 2) {
  if (CACHE && CACHE.quality === quality) return CACHE;
  const t0 = performance.now();
  const spec = skeletonSpec();
  const body = makeBody(spec);
  const P = makePieces(spec, body);
  const hs = [1.6, 1.25, 1.0, 0.9][quality] ?? 1;

  // Union field for ambient occlusion (bounding-sphere accelerated).
  const aoParts = [];
  for (const pc of P.pieces) {
    const b = pc.bounds;
    const c = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
    aoParts.push({ f: pc.f, c, r: Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2 });
  }
  aoParts.push({ f: P.collar.f, c: [0, 1.47, -0.02], r: 0.17 });
  const unionAO = (x, y, z) => {
    let d = body.field(x, y, z);
    for (const p of aoParts) {
      const dc = Math.hypot(x - p.c[0], y - p.c[1], z - p.c[2]) - p.r;
      if (dc > 0.08) { d = Math.min(d, dc); continue; }
      d = Math.min(d, p.f(x, y, z));
    }
    return d;
  };

  // ---- body (skinned, smooth weights) ------------------------------------------------
  const bodyMesh = meshSDF(body.field, [-0.72, -0.004, -0.2, 0.72, 1.66, 0.26], 0.0115 * hs, { project: 2 });
  const nv = bodyMesh.positions.length / 3;
  const skinIndex = new Uint16Array(nv * 4), skinWeight = new Float32Array(nv * 4);
  const colors = new Float32Array(nv * 3), mat = new Float32Array(nv * 4);
  const nb = BONES.length;
  const bd = new Float32Array(nb);
  const tau = 0.016;
  for (let v = 0; v < nv; v++) {
    const x = bodyMesh.positions[v * 3], y = bodyMesh.positions[v * 3 + 1], z = bodyMesh.positions[v * 3 + 2];
    bd.fill(1e9);
    for (const pr of body.prims) {
      const d = pr.f(x, y, z);
      if (d < bd[pr.bone]) bd[pr.bone] = d;
      if (pr.bone2 != null && d + 0.004 < bd[pr.bone2]) bd[pr.bone2] = d + 0.004;
    }
    let dmin = 1e9;
    for (let b = 0; b < nb; b++) if (bd[b] < dmin) dmin = bd[b];
    // top-4 by weight
    const ws = [];
    for (let b = 0; b < nb; b++) {
      const t = (bd[b] - dmin) / tau;
      if (t < 5) ws.push([b, Math.exp(-t * t * 0.5 - t * 0.6)]);
    }
    ws.sort((a, b) => b[1] - a[1]);
    let sum = 0;
    for (let k = 0; k < 4 && k < ws.length; k++) sum += ws[k][1];
    for (let k = 0; k < 4; k++) {
      skinIndex[v * 4 + k] = k < ws.length ? ws[k][0] : 0;
      skinWeight[v * 4 + k] = k < ws.length ? ws[k][1] / sum : 0;
    }
    // ---- material regions --------------------------------------------------------------
    const ax = Math.abs(x);
    let col = PALETTE.suit, rough = 0.78, sheen = 1, pattern = 0;
    const dom = ws[0][0];
    if (dom === B.handL || dom === B.handR) { col = PALETTE.glove; rough = 0.62; pattern = 3; }
    else if (y < 0.026) { col = PALETTE.sole; rough = 0.9; pattern = 4; }
    else if (dom === B.footL || dom === B.footR || dom === B.toeL || dom === B.toeR) { col = PALETTE.suitDark; rough = 0.7; pattern = 4; }
    else if (y > 1.02 && y < 1.17) { pattern = 1; } // ribbed waist
    else if ((dom === B.upperArmL || dom === B.upperArmR) && y < 1.36) { pattern = 2; }
    else if (dom === B.neck) { col = PALETTE.suitDark; pattern = 1; }
    else if (y > 0.48 && y < 0.56 && z < 0.0) { pattern = 1; } // behind the knee
    if (ax < 0.012 && y > 0.87 && y < 1.15 && z > 0) col = PALETTE.suitDark; // front seam band
    colors[v * 3] = col[0]; colors[v * 3 + 1] = col[1]; colors[v * 3 + 2] = col[2];
    const nx = bodyMesh.normals[v * 3], ny = bodyMesh.normals[v * 3 + 1], nz = bodyMesh.normals[v * 3 + 2];
    const ao = sdfAO(unionAO, x, y, z, nx, ny, nz, 0.012, 5, 1.0);
    mat[v * 4] = rough; mat[v * 4 + 1] = sheen; mat[v * 4 + 2] = pattern; mat[v * 4 + 3] = ao;
  }
  smoothAttr(mat, 4, 3, bodyMesh.indices, 0, nv, 3);
  const bodyData = { ...bodyMesh, skinIndex, skinWeight, colors, mat };

  // ---- hard pieces (rigid) -------------------------------------------------------------
  const merged = { positions: [], normals: [], indices: [], skinIndex: [], colors: [], mat: [], ao: [] };
  const appendPiece = (pc, m) => {
    const base = merged.positions.length / 3;
    const n = m.positions.length / 3;
    for (let v = 0; v < n; v++) {
      const x = m.positions[v * 3], y = m.positions[v * 3 + 1], z = m.positions[v * 3 + 2];
      merged.positions.push(x, y, z);
      const nx = m.normals[v * 3], ny = m.normals[v * 3 + 1], nz = m.normals[v * 3 + 2];
      merged.normals.push(nx, ny, nz);
      merged.skinIndex.push(pc.bone);
      const c = pc.color(x, y, z);
      merged.colors.push(c[0], c[1], c[2]);
      const rm = pc.mat(x, y, z);
      merged.mat.push(rm[0], rm[1], clamp(pc.line(x, y, z), -1, 1), clamp(pc.seam(x, y, z), -1, 1));
      merged.ao.push(sdfAO(unionAO, x, y, z, nx, ny, nz, 0.01, 5, 0.9));
      // mean curvature (SDF laplacian): convex edges > 0, creases < 0 — drives edge wear / grime
      const ce = 0.0035, f0 = pc.f(x, y, z);
      const lap = (pc.f(x + ce, y, z) + pc.f(x - ce, y, z) + pc.f(x, y + ce, z) + pc.f(x, y - ce, z) + pc.f(x, y, z + ce) + pc.f(x, y, z - ce) - 6 * f0) / (ce * ce);
      merged.ao.push(clamp(lap * 0.0045, -1, 1));
      merged.ao.push(clamp(pc.split ? pc.split(x, y, z) : FAR, -1, 1));
    }
    for (let i = 0; i < m.indices.length; i++) merged.indices.push(m.indices[i] + base);
  };
  for (const pc of P.pieces) {
    const b = pc.bounds;
    const m = meshSDF(pc.f, b, pc.h * hs, { project: 3 });
    cullBuried(m, body.field, -0.0025);
    appendPiece(pc, m);
    smoothAttr(merged.ao, 3, 0, m.indices, merged.positions.length / 3 - m.positions.length / 3, m.positions.length / 3, 3);
  }
  {
    const g = buildGasket(P, quality);
    const base = merged.positions.length / 3;
    const n = g.positions.length / 3;
    const gc = PALETTE.graphite;
    for (let v = 0; v < n; v++) {
      merged.positions.push(g.positions[v * 3], g.positions[v * 3 + 1], g.positions[v * 3 + 2]);
      merged.normals.push(g.normals[v * 3], g.normals[v * 3 + 1], g.normals[v * 3 + 2]);
      merged.skinIndex.push(B.head);
      merged.colors.push(gc[0], gc[1], gc[2]);
      merged.mat.push(0.45, 0.2, FAR, FAR);
      merged.ao.push(0.9, 0.2, FAR);
    }
    for (const i of g.indices) merged.indices.push(i + base);
  }
  const hard = {
    positions: new Float32Array(merged.positions), normals: new Float32Array(merged.normals),
    indices: new Uint32Array(merged.indices), skinBone: new Uint16Array(merged.skinIndex),
    colors: new Float32Array(merged.colors), mat: new Float32Array(merged.mat), ao: new Float32Array(merged.ao),
  };

  // ---- visor glass (head): a clean parametric surface projected onto the helmet front ----
  const visor = buildVisor(P, quality);

  // ---- scarf collar (cloth material, rigid on chest) ---------------------------------------
  const cm = meshSDF(P.collar.f, P.collar.bounds, P.collar.h * hs, { project: 2 });
  const cn = cm.positions.length / 3;
  const cuv = new Float32Array(cn * 2), cao = new Float32Array(cn);
  for (let v = 0; v < cn; v++) {
    const x = cm.positions[v * 3], y = cm.positions[v * 3 + 1], z = cm.positions[v * 3 + 2];
    cuv[v * 2] = Math.atan2(x, z + 0.014) / Math.PI;
    cuv[v * 2 + 1] = (y - 1.38) * 4;
    cao[v] = sdfAO(unionAO, x, y, z, cm.normals[v * 3], cm.normals[v * 3 + 1], cm.normals[v * 3 + 2], 0.01, 4, 0.9);
  }
  const collar = { ...cm, uv: cuv, ao: cao, bone: B.chest };

  // Scarf anchor points (chest-space, character bind pose) for the two tails.
  const anchors = {
    long: [[0.065, 1.468, -0.11], [0.0, 1.476, -0.124], [-0.065, 1.468, -0.11]],
    short: [[0.085, 1.44, -0.095], [0.045, 1.428, -0.118], [0.005, 1.42, -0.122]],
  };

  // Simple collision proxies (bone-local in bind space → converted later).
  const proxies = [
    { bone: B.hips, a: [0, 0.94, -0.01], b: [0, 0.94, -0.01], r: 0.17 },
    { bone: B.spine, a: [0, 1.05, -0.0], b: [0, 1.2, -0.0], r: 0.15 },
    { bone: B.chest, a: [0, 1.25, -0.01], b: [0, 1.38, -0.01], r: 0.17 },
    { bone: B.chest, a: [-0.06, 1.29, -0.21], b: [0.06, 1.29, -0.21], r: 0.12 }, // pack upper/lower
    { bone: B.chest, a: [0, 1.38, -0.21], b: [0, 1.16, -0.21], r: 0.11 },
    { bone: B.chest, a: [0.128, 1.38, -0.21], b: [0.128, 1.1, -0.215], r: 0.055 },
    { bone: B.chest, a: [-0.128, 1.38, -0.21], b: [-0.128, 1.1, -0.215], r: 0.055 },
    { bone: B.head, a: [0, 1.67, 0.012], b: [0, 1.67, 0.012], r: 0.16 },
    { bone: B.upperArmL, a: J0(spec, 'upperArmL'), b: J0(spec, 'foreArmL'), r: 0.07 },
    { bone: B.upperArmR, a: J0(spec, 'upperArmR'), b: J0(spec, 'foreArmR'), r: 0.07 },
    { bone: B.foreArmL, a: J0(spec, 'foreArmL'), b: J0(spec, 'handL'), r: 0.055 },
    { bone: B.foreArmR, a: J0(spec, 'foreArmR'), b: J0(spec, 'handR'), r: 0.055 },
    { bone: B.thighL, a: J0(spec, 'thighL'), b: J0(spec, 'shinL'), r: 0.1 },
    { bone: B.thighR, a: J0(spec, 'thighR'), b: J0(spec, 'shinR'), r: 0.1 },
    { bone: B.shinL, a: J0(spec, 'shinL'), b: J0(spec, 'footL'), r: 0.07 },
    { bone: B.shinR, a: J0(spec, 'shinR'), b: J0(spec, 'footR'), r: 0.07 },
  ];

  CACHE = {
    quality, spec, body: bodyData, hard, visor, collar, anchors, proxies,
    // thruster nozzle mouths in chest space (bind)
    nozzles: [[0.128, 1.045, -0.226], [-0.128, 1.045, -0.226]],
    ms: performance.now() - t0,
  };
  return CACHE;
}
function J0(spec, n) { return spec.J[n].slice(); }

/** Laplacian-smooth one channel of an interleaved per-vertex array over mesh edges. */
function smoothAttr(arr, stride, ch, indices, base, count, iters) {
  const sum = new Float64Array(count), cnt = new Uint16Array(count);
  for (let it = 0; it < iters; it++) {
    sum.fill(0); cnt.fill(0);
    for (let t = 0; t < indices.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = indices[t + e], b = indices[t + (e + 1) % 3];
        sum[a] += arr[(base + b) * stride + ch]; cnt[a]++;
        sum[b] += arr[(base + a) * stride + ch]; cnt[b]++;
      }
    }
    for (let v = 0; v < count; v++) if (cnt[v]) { const k = (base + v) * stride + ch; arr[k] = arr[k] * 0.4 + (sum[v] / cnt[v]) * 0.6; }
  }
}

/** Drop triangles whose three vertices are all buried inside the suit (never visible). */
function cullBuried(m, field, thresh) {
  const P = m.positions, I = m.indices;
  const nv = P.length / 3;
  const inside = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) inside[v] = field(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]) < thresh ? 1 : 0;
  const out = [];
  for (let t = 0; t < I.length; t += 3) {
    if (inside[I[t]] && inside[I[t + 1]] && inside[I[t + 2]]) continue;
    out.push(I[t], I[t + 1], I[t + 2]);
  }
  m.indices = new Uint32Array(out);
}

// Visor outline in (u, v) ∈ [-1, 1]²: a superellipse ("squircle") mapped onto the
// helmet front. x = u·hw(v), y = 1.664 − 1.1·x² + v·0.046.
const VISOR_N = 7;
function visorUV(theta, rho) {
  const c = Math.cos(theta), s = Math.sin(theta);
  const u = Math.sign(c) * Math.pow(Math.abs(c), 2 / VISOR_N) * rho;
  const v = Math.sign(s) * Math.pow(Math.abs(s), 2 / VISOR_N) * rho;
  return [u, v];
}
function visorPoint(f, u, v, out) {
  const x = u * 0.104 * (1 - Math.max(0, -v) * 0.14);
  const y = 1.668 - 0.9 * x * x + v * 0.044;
  let z0 = 0.0, z1 = 0.26;
  for (let k = 0; k < 40; k++) { const zm = (z0 + z1) * 0.5; if (f(x, y, zm) < 0) z0 = zm; else z1 = zm; }
  const z = (z0 + z1) * 0.5, e = 0.0008;
  let nx = f(x + e, y, z) - f(x - e, y, z), ny = f(x, y + e, z) - f(x, y - e, z), nz = f(x, y, z + e) - f(x, y, z - e);
  const nl = Math.hypot(nx, ny, nz) || 1;
  out[0] = x; out[1] = y; out[2] = z; out[3] = nx / nl; out[4] = ny / nl; out[5] = nz / nl;
  return out;
}

/** Visor glass: a radial grid over the squircle outline, lifted 2.5 mm off the helmet. */
function buildVisor(P, quality) {
  const NT = [48, 64, 88, 104][quality] ?? 88, NR = [6, 8, 10, 12][quality] ?? 10;
  const positions = [], normals = [], uvs = [], indices = [];
  const f = P.helmetOuter, q = new Float64Array(6);
  // centre vertex + rings
  visorPoint(f, 0, 0, q);
  positions.push(q[0] + q[3] * 0.0025, q[1] + q[4] * 0.0025, q[2] + q[5] * 0.0025); normals.push(q[3], q[4], q[5]); uvs.push(0, 0);
  for (let r = 1; r <= NR; r++) {
    const rho = r / NR;
    for (let t = 0; t < NT; t++) {
      const [u, v] = visorUV((t / NT) * Math.PI * 2, rho);
      visorPoint(f, u, v, q);
      positions.push(q[0] + q[3] * 0.0025, q[1] + q[4] * 0.0025, q[2] + q[5] * 0.0025);
      normals.push(q[3], q[4], q[5]); uvs.push(u, v);
    }
  }
  const ring = (r, t) => 1 + (r - 1) * NT + (t % NT);
  for (let t = 0; t < NT; t++) indices.push(0, ring(1, t), ring(1, t + 1));
  for (let r = 1; r < NR; r++) for (let t = 0; t < NT; t++) {
    const a = ring(r, t), b = ring(r, t + 1), c = ring(r + 1, t), d = ring(r + 1, t + 1);
    indices.push(a, c, b, b, c, d);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uv: new Float32Array(uvs), indices: new Uint32Array(indices), bone: B.head };
}

/** Gasket: a smooth tube framing the visor (hard-surface material data included). */
function buildGasket(P, quality) {
  const NT = [64, 96, 128, 160][quality] ?? 128, NS = 10, R = 0.0062;
  const f = P.helmetOuter, q = new Float64Array(6), q2 = new Float64Array(6);
  const pos = [], nrm = [], idx = [];
  const pts = [];
  for (let t = 0; t < NT; t++) {
    const [u, v] = visorUV((t / NT) * Math.PI * 2, 1.0);
    visorPoint(f, u, v, q);
    pts.push(Array.from(q));
  }
  for (let t = 0; t < NT; t++) {
    const p = pts[t], pn = pts[(t + 1) % NT], pp = pts[(t + NT - 1) % NT];
    let tx = pn[0] - pp[0], ty = pn[1] - pp[1], tz = pn[2] - pp[2];
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    const nx = p[3], ny = p[4], nz = p[5];
    // binormal = T × N
    let bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
    const bl = Math.hypot(bx, by, bz) || 1; bx /= bl; by /= bl; bz /= bl;
    const cx = p[0] + nx * 0.0015, cy = p[1] + ny * 0.0015, cz = p[2] + nz * 0.0015;
    for (let k = 0; k < NS; k++) {
      const a = (k / NS) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const ox = nx * ca + bx * sa, oy = ny * ca + by * sa, oz = nz * ca + bz * sa;
      pos.push(cx + ox * R, cy + oy * R * 1.0, cz + oz * R);
      nrm.push(ox, oy, oz);
    }
  }
  for (let t = 0; t < NT; t++) for (let k = 0; k < NS; k++) {
    const a = t * NS + k, b = t * NS + (k + 1) % NS, c = ((t + 1) % NT) * NS + k, d = ((t + 1) % NT) * NS + (k + 1) % NS;
    idx.push(a, b, c, b, d, c);
  }
  return { positions: pos, normals: nrm, indices: idx };
}

/**
 * Create the explorer rig: { group, bones, skeleton, meshes{body,hard,visor,collar}, data }.
 * materials: { body, hard, visor, cloth } (from Materials.js)
 */
export function createExplorer(data, materials) {
  const group = new THREE.Group();
  group.name = 'Explorer';
  const { bones, root, restWorldQ } = buildBones(data.spec);
  group.add(root);
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  const mk = (geo, material, name) => {
    const m = new THREE.SkinnedMesh(geo, material);
    m.name = name;
    m.frustumCulled = false;
    group.add(m);
    return m;
  };

  // body
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.BufferAttribute(data.body.positions, 3));
  bg.setAttribute('normal', new THREE.BufferAttribute(data.body.normals, 3));
  bg.setAttribute('color', new THREE.BufferAttribute(data.body.colors, 3));
  bg.setAttribute('aMat', new THREE.BufferAttribute(data.body.mat, 4));
  bg.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(data.body.skinIndex, 4));
  bg.setAttribute('skinWeight', new THREE.Float32BufferAttribute(data.body.skinWeight, 4));
  bg.setIndex(new THREE.BufferAttribute(data.body.indices, 1));
  const body = mk(bg, materials.body, 'explorer-body');

  // hard surface
  const hg = new THREE.BufferGeometry();
  const n = data.hard.positions.length / 3;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) { si[v * 4] = data.hard.skinBone[v]; sw[v * 4] = 1; }
  hg.setAttribute('position', new THREE.BufferAttribute(data.hard.positions, 3));
  hg.setAttribute('normal', new THREE.BufferAttribute(data.hard.normals, 3));
  hg.setAttribute('color', new THREE.BufferAttribute(data.hard.colors, 3));
  hg.setAttribute('aMat', new THREE.BufferAttribute(data.hard.mat, 4));
  hg.setAttribute('aAO', new THREE.BufferAttribute(data.hard.ao, 3));
  hg.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  hg.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  hg.setIndex(new THREE.BufferAttribute(data.hard.indices, 1));
  const hard = mk(hg, materials.hard, 'explorer-armor');

  const rigid = (d, material, name, extra) => {
    const g = new THREE.BufferGeometry();
    const k = d.positions.length / 3;
    const s1 = new Uint16Array(k * 4), w1 = new Float32Array(k * 4);
    for (let v = 0; v < k; v++) { s1[v * 4] = d.bone; w1[v * 4] = 1; }
    g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(d.normals, 3));
    if (d.uv) g.setAttribute('uv', new THREE.BufferAttribute(d.uv, 2));
    if (extra) extra(g);
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(s1, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w1, 4));
    g.setIndex(new THREE.BufferAttribute(d.indices, 1));
    return mk(g, material, name);
  };
  const visor = rigid(data.visor, materials.visor, 'explorer-visor');
  const collar = rigid(data.collar, materials.collar, 'explorer-collar', (g) => g.setAttribute('aAO', new THREE.BufferAttribute(data.collar.ao, 1)));

  for (const m of [body, hard, visor, collar]) m.bind(skeleton);

  return {
    group, bones, skeleton, restWorldQ, spec: data.spec,
    meshes: { body, hard, visor, collar },
    data,
  };
}
