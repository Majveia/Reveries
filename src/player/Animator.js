// Procedural animation for the explorer: no clips, only physics-informed
// parametric motion solved every frame.
//
//   · gait engine: foot trajectories per phase (stance / swing, heel-strike and
//     toe-off rolls), walk→run→sprint blends with stride, cadence and duty factor
//     driven by real ground speed (zero foot sliding), pelvis bob/sway/rotation,
//     counter-rotating shoulders, arm swing with speed-dependent elbow bend
//   · analytic two-bone leg IK onto the actual terrain under each foot, foot
//     alignment to the ground normal, automatic pelvis drop so legs never over-reach
//   · lean into acceleration and bank into turns, head look toward the camera aim,
//     idle breathing / weight shift / look-around
//   · airborne poses (rise / fall / glide / jetpack), landing squash and roll,
//     swimming (stroke + treading water), sliding (surf stance)
//
// Pose math (character space, bind = A-pose): every bone has a rotation delta
// D_b expressed in bind coordinates; its accumulated rotation is R_b = R_p · D_b,
// world rotation W_b = R_b · Q_b (Q_b = bind rotation) and the bone's local
// quaternion is Q_p⁻¹ · D_b · Q_b. Joint positions follow P_b = P_p + R_p (J_b − J_p).

import * as THREE from 'three';
import { BONES, B, PARENT } from './Explorer.js';

const NB = BONES.length;
const TAU = Math.PI * 2;
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
/** gait cycles per second for a ground speed (m/s) — walk ~1.1 Hz … sprint ~2 Hz */
const cadence = (sp) => clamp(1.0 + 0.09 * sp, 0.95, 2.0);

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();

function qAxis(out, axis, angle) { return out.setFromAxisAngle(axis, angle); }
/** q = Ry(yaw) · Rx(pitch) · Rz(roll) */
function qYXZ(out, pitch, yaw, roll) {
  out.setFromAxisAngle(Y, yaw);
  if (pitch) out.multiply(_q3.setFromAxisAngle(X, pitch));
  if (roll) out.multiply(_q3.setFromAxisAngle(Z, roll));
  return out;
}
function nlerpInto(out, a, b, t) {
  // shortest-path normalized lerp (fast blend of many quaternions)
  const d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const s = d < 0 ? -t : t;
  out.set(a.x * (1 - t) + b.x * s, a.y * (1 - t) + b.y * s, a.z * (1 - t) + b.z * s, a.w * (1 - t) + b.w * s);
  return out.normalize();
}

class Pose {
  constructor() {
    this.D = Array.from({ length: NB }, () => new THREE.Quaternion());
    this.root = new THREE.Vector3(); // hips offset from bind (char space)
    this.ik = 0; // leg IK weight (0 = pure FK)
    this.feet = [0, 1].map(() => ({ pos: new THREE.Vector3(), pitch: 0, toe: 0, yaw: 0, plant: 0 }));
  }
  reset() { for (const q of this.D) q.identity(); this.root.set(0, 0, 0); this.ik = 0; return this; }
}

export class Animator {
  constructor(rig) {
    this.rig = rig;
    this.bones = rig.bones;
    const spec = rig.spec;
    this.J = BONES.map((n) => new THREE.Vector3(...spec.J[n]));
    this.parent = BONES.map((n) => (PARENT[n] ? B[PARENT[n]] : -1));
    this.Qb = BONES.map((n) => rig.restWorldQ[n].clone());
    this.QpInv = BONES.map((n) => (PARENT[n] ? rig.restWorldQ[PARENT[n]].clone().invert() : new THREE.Quaternion()));
    this.R = BONES.map(() => new THREE.Quaternion());
    this.P = this.J.map((j) => j.clone());
    this.beta = spec.beta;
    // leg data
    this.legs = ['L', 'R'].map((S, i) => {
      const th = B['thigh' + S], sh = B['shin' + S], ft = B['foot' + S], toe = B['toe' + S];
      const l1 = this.J[sh].distanceTo(this.J[th]), l2 = this.J[ft].distanceTo(this.J[sh]);
      const d1 = this.J[sh].clone().sub(this.J[th]).normalize(), d2 = this.J[ft].clone().sub(this.J[sh]).normalize();
      const basis = (d) => { const x = new THREE.Vector3().crossVectors(d, Z).normalize(); const z = new THREE.Vector3().crossVectors(x, d); return new THREE.Matrix4().makeBasis(x, d, z); };
      return {
        S, side: i === 0 ? 1 : -1, th, sh, ft, toe, l1, l2,
        bind1: basis(d1).transpose(), bind2: basis(d2).transpose(), // inverse (orthonormal)
        ankle: this.J[ft].clone(), heelOff: new THREE.Vector3(0, -this.J[ft].y, -0.075), ballOff: new THREE.Vector3(0, -this.J[ft].y, 0.135),
        ground: 0, groundN: new THREE.Vector3(0, 1, 0), drop: 0,
      };
    });
    this.poses = { loco: new Pose(), air: new Pose(), glide: new Pose(), jet: new Pose(), swim: new Pose(), slide: new Pose(), roll: new Pose(), ride: new Pose() };
    this.out = new Pose();
    this.w = { loco: 1, air: 0, glide: 0, jet: 0, swim: 0, slide: 0, roll: 0, ride: 0 };
    // state
    this.phase = 0;
    this.speed = 0;
    this.gait = 0;
    this.sprint = 0;
    this.lean = 0; this.bank = 0;
    this.time = 0;
    this.idleTime = 0;
    this.swimPhase = 0;
    this.squash = 0; this.squashV = 0;
    this.rollT = -1;
    this.lookYaw = 0; this.lookPitch = 0;
    this.idleLook = 0;
    this.pelvisDrop = 0;
    this.stepEvents = [];
    this._prevPhi = [0, 0.5];
    this.freezePhase = false;
  }

  /** Trigger a landing reaction. impact = downward speed (m/s); moving = forward speed. */
  land(impact, moving) {
    if (impact > 11.5 && moving > 3.5) { this.rollT = 0; return 'roll'; }
    this.squashV -= clamp(impact * 0.055, 0, 0.7);
    return 'land';
  }

  /**
   * s: { dt, speed, localVel{x,z}, accel{x,z} (local), turnRate, grounded, vy, state:'ground'|'air'|'glide'|'jet'|'swim'|'slide',
   *      lookYaw, lookPitch, groundFn(footCharPos, outNormal) → height offset }
   */
  update(s) {
    const dt = s.dt;
    this.time += dt;
    this.stepEvents.length = 0;
    // ---- state weights (cross-fades) --------------------------------------------------
    const target = { loco: 0, air: 0, glide: 0, jet: 0, swim: 0, slide: 0, roll: 0, ride: 0 };
    target[s.state === 'ground' ? 'loco' : s.state] = 1;
    if (this.rollT >= 0) { for (const k in target) target[k] = 0; target.roll = 1; }
    const rate = s.state === 'ground' ? 14 : 8;
    let sum = 0;
    for (const k in this.w) { this.w[k] = damp(this.w[k], target[k], this.rollT >= 0 ? 30 : rate, dt); sum += this.w[k]; }
    for (const k in this.w) this.w[k] /= sum;

    // ---- shared smoothed parameters ---------------------------------------------------
    this.speed = damp(this.speed, s.speed, 10, dt);
    const sp = this.speed;
    this.gait = damp(this.gait, sstep(2.6, 4.6, sp), 6, dt);
    this.sprint = damp(this.sprint, sstep(7.5, 10.5, sp), 4, dt);
    const accF = clamp(s.accel?.z || 0, -25, 25), accX = clamp(s.accel?.x || 0, -25, 25);
    this.lean = damp(this.lean, clamp(sp * 0.045 + this.sprint * 0.12 + accF * 0.012, -0.25, 0.48), 5, dt);
    this.bank = damp(this.bank, clamp(-(s.turnRate || 0) * sp * 0.035 - accX * 0.004, -0.35, 0.35), 5, dt);
    this.idleTime = sp < 0.15 && s.state === 'ground' ? this.idleTime + dt : 0;
    // squash spring (critically-damped-ish)
    this.squashV += (-this.squash * 220 - this.squashV * 22) * dt;
    this.squash += this.squashV * dt;
    // head look
    const idleLook = this.idleTime > 3 ? Math.sin(this.time * 0.37) * 0.55 + Math.sin(this.time * 0.13) * 0.3 : 0;
    this.idleLook = damp(this.idleLook, idleLook, 1.5, dt);
    this.lookYaw = damp(this.lookYaw, clamp((s.lookYaw ?? 0) + this.idleLook * (s.lookFree ? 1 : 0), -1.25, 1.25), 6, dt);
    this.lookPitch = damp(this.lookPitch, clamp(s.lookPitch ?? 0, -0.7, 0.6), 6, dt);

    if (!this.freezePhase) {
      const f = sp < 0.05 ? 0 : cadence(sp);
      this.phase = (this.phase + f * dt) % 1;
    }
    if (this.rollT >= 0) { this.rollT += dt / 0.62; if (this.rollT >= 1) this.rollT = -1; }

    // ---- evaluate active poses ----------------------------------------------------------
    const out = this.out.reset();
    let first = true;
    let ikW = 0;
    const rootAcc = _v4.set(0, 0, 0);
    const feetAcc = [new THREE.Vector3(), new THREE.Vector3()];
    const feetMeta = [{ pitch: 0, toe: 0, yaw: 0 }, { pitch: 0, toe: 0, yaw: 0 }];
    let accW = 0;
    for (const k of ['loco', 'air', 'glide', 'jet', 'swim', 'slide', 'roll', 'ride']) {
      const w = this.w[k];
      if (w < 0.002) continue;
      const p = this.poses[k].reset();
      this['_' + k](p, s);
      accW += w;
      const t = w / accW;
      for (let i = 0; i < NB; i++) {
        if (first) out.D[i].copy(p.D[i]); else nlerpInto(out.D[i], out.D[i], p.D[i], t);
      }
      rootAcc.addScaledVector(p.root, w);
      ikW += p.ik * w;
      for (let f = 0; f < 2; f++) {
        if (p.ik > 0) {
          feetAcc[f].addScaledVector(p.feet[f].pos, w * p.ik);
          feetMeta[f].pitch += p.feet[f].pitch * w * p.ik; feetMeta[f].toe += p.feet[f].toe * w * p.ik; feetMeta[f].yaw += p.feet[f].yaw * w * p.ik;
        }
      }
      first = false;
    }
    out.root.copy(rootAcc);
    out.ik = ikW;
    for (let f = 0; f < 2; f++) {
      if (ikW > 1e-4) { out.feet[f].pos.copy(feetAcc[f]).multiplyScalar(1 / ikW); out.feet[f].pitch = feetMeta[f].pitch / ikW; out.feet[f].toe = feetMeta[f].toe / ikW; out.feet[f].yaw = feetMeta[f].yaw / ikW; }
    }

    // ---- additive layers --------------------------------------------------------------
    // landing squash: pelvis drops, spine curls a touch
    out.root.y += Math.min(0, this.squash) * 0.55;
    out.D[B.spine].multiply(_q.setFromAxisAngle(X, -Math.min(0, this.squash) * 0.9));
    // head look (distributed chest/neck/head), stabilize gaze against the lean
    const ly = this.lookYaw, lp = this.lookPitch;
    out.D[B.chest].premultiply(qYXZ(_q, -lp * 0.15, ly * 0.22, 0));
    out.D[B.neck].premultiply(qYXZ(_q, -lp * 0.35, ly * 0.33, 0));
    out.D[B.head].premultiply(qYXZ(_q, -lp * 0.5 - this.lean * 0.6 * this.w.loco, ly * 0.45, 0));

    // ---- FK pass ----------------------------------------------------------------------
    this._fk(out);
    // ---- leg IK onto terrain ------------------------------------------------------------
    if (ikW > 0.01) this._legIK(out, s, ikW);
    // ---- write bones ------------------------------------------------------------------
    for (let i = 0; i < NB; i++) {
      const b = this.bones[i];
      b.quaternion.copy(this.QpInv[i]).multiply(out.D[i]).multiply(this.Qb[i]);
    }
    this.bones[B.hips].position.copy(this.J[B.hips]).add(out.root);
  }

  _fk(pose) {
    for (let i = 0; i < NB; i++) {
      const p = this.parent[i];
      if (p < 0) {
        this.R[i].copy(pose.D[i]);
        this.P[i].copy(this.J[i]).add(pose.root);
      } else {
        this.R[i].copy(this.R[p]).multiply(pose.D[i]);
        this.P[i].copy(this.J[i]).sub(this.J[p]).applyQuaternion(this.R[p]).add(this.P[p]);
      }
    }
  }

  /** Character-space position of a bind-space point attached to bone b. */
  pointOn(b, bindPoint, out) {
    return out.copy(bindPoint).sub(this.J[b]).applyQuaternion(this.R[b]).add(this.P[b]);
  }

  // ===================================================================================
  // Leg IK
  // ===================================================================================
  _legIK(pose, s, w) {
    const legs = this.legs;
    const dt = s.dt;
    // 1) ground offsets under each foot target (terrain-adaptive)
    let need = 0;
    for (let f = 0; f < 2; f++) {
      const L = legs[f], ft = pose.feet[f];
      const g = s.groundFn ? s.groundFn(ft.pos, L.groundN) : 0;
      L.ground = damp(L.ground, clamp(g, -0.5, 0.5), 18, dt);
      // ankle target from the sole pivot
      this._ankleTarget(L, ft, _v);
      _v.y += L.ground;
      L.target = (L.target || new THREE.Vector3()).copy(_v);
      // pelvis drop so that the leg can reach (soft IK)
      const H = this.P[L.th];
      const d = _v2.copy(_v).sub(H);
      const Lmax = (L.l1 + L.l2) * 0.985;
      const disc = d.y * d.y - (d.lengthSq() - Lmax * Lmax);
      const drop = d.lengthSq() <= Lmax * Lmax ? 0 : (-d.y - Math.sqrt(Math.max(0, disc)));
      need = Math.max(need, Math.max(0, drop));
    }
    // also sink when both feet are below the root (standing across a dip)
    const lowGround = Math.min(0, Math.min(legs[0].ground, legs[1].ground));
    this.pelvisDrop = damp(this.pelvisDrop, Math.min(need, 0.35) * w - lowGround * w * 0.0, 20, dt);
    if (this.pelvisDrop > 1e-4 || lowGround < 0) {
      const dy = -this.pelvisDrop + lowGround * w;
      pose.root.y += dy;
      this._fk(pose);
    }
    // 2) solve each leg
    for (let f = 0; f < 2; f++) {
      const L = legs[f], ft = pose.feet[f];
      const H = this.P[L.th];
      const T = L.target;
      const d = _v.copy(T).sub(H);
      let dist = d.length();
      const lmax = (L.l1 + L.l2) * 0.9995, lmin = Math.abs(L.l1 - L.l2) + 0.02;
      dist = clamp(dist, lmin, lmax);
      const dir = d.normalize();
      // knee pole: character forward rotated by the foot yaw, mixed with the hips
      const pole = _v2.set(Math.sin(ft.yaw) * 0.6, 0, Math.cos(ft.yaw)).applyQuaternion(this.R[B.hips]);
      pole.addScaledVector(dir, -pole.dot(dir));
      if (pole.lengthSq() < 1e-6) pole.set(0, 0, 1);
      pole.normalize();
      const a = (L.l1 * L.l1 + dist * dist - L.l2 * L.l2) / (2 * L.l1 * dist);
      const ang = Math.acos(clamp(a, -1, 1));
      // knee position: rotate dir toward pole by ang
      const knee = _v3.copy(dir).multiplyScalar(Math.cos(ang) * L.l1).addScaledVector(pole, Math.sin(ang) * L.l1).add(H);
      const hinge = _v4.crossVectors(dir, pole).normalize(); // same for both bones
      // thigh
      const y1 = _vA.copy(knee).sub(H).normalize();
      const z1 = _vB.crossVectors(hinge, y1);
      _m.makeBasis(hinge, y1, z1).multiply(L.bind1);
      const Rth = _qA.setFromRotationMatrix(_m);
      // shin
      const ankle = _vC.copy(dir).multiplyScalar(dist).add(H);
      const y2 = _vA.copy(ankle).sub(knee).normalize();
      const z2 = _vB.crossVectors(hinge, y2);
      _m.makeBasis(hinge, y2, z2).multiply(L.bind2);
      const Rsh = _qB.setFromRotationMatrix(_m);
      // foot: align to ground normal, facing yaw, pitch roll
      const n = _vD.copy(L.groundN).lerp(Y, 0.35).normalize();
      const fwd = _vE.set(Math.sin(ft.yaw), 0, Math.cos(ft.yaw)).applyQuaternion(_qC.setFromAxisAngle(Y, 0)).addScaledVector(n, 0);
      fwd.applyQuaternion(this._hipsYaw(_qC));
      fwd.addScaledVector(n, -fwd.dot(n)).normalize();
      const fx = _vF.crossVectors(n, fwd).normalize();
      _m.makeBasis(fx, n, fwd);
      const Rft = _qD.setFromRotationMatrix(_m).multiply(_q.setFromAxisAngle(X, -ft.pitch));
      // convert to deltas: D = R_parent⁻¹ · R
      const Dth = _q2.copy(this.R[B.hips]).invert().multiply(Rth);
      nlerpInto(pose.D[L.th], pose.D[L.th], Dth, w);
      const Dsh = _q2.copy(Rth).invert().multiply(Rsh);
      nlerpInto(pose.D[L.sh], pose.D[L.sh], Dsh, w);
      const Dft = _q2.copy(Rsh).invert().multiply(Rft);
      nlerpInto(pose.D[L.ft], pose.D[L.ft], Dft, w);
      pose.D[L.toe].copy(_q.setFromAxisAngle(X, -ft.toe));
    }
    this._fk(pose);
  }

  _hipsYaw(out) {
    // yaw part of the hips rotation (feet follow the body heading, not its lean)
    const f = _vG.set(0, 0, 1).applyQuaternion(this.R[B.hips]);
    return out.setFromAxisAngle(Y, Math.atan2(f.x, f.z));
  }

  _ankleTarget(L, ft, out) {
    // ft.pos = ground point under the ankle at zero pitch. Pivot on heel (pitch>0, toes up) or ball (pitch<0).
    const pitch = ft.pitch;
    const piv = pitch < 0 ? L.ballOff : L.heelOff;
    // ground pivot point
    const g = _vH.copy(piv).setY(0).add(ft.pos);
    // ankle = pivot − R(pitch) · pivotOffset
    const off = _vI.copy(piv).applyAxisAngle(X, -pitch);
    out.copy(g).sub(off);
    out.y = Math.max(out.y, ft.pos.y + 0.04);
    return out;
  }

  // ===================================================================================
  // Poses
  // ===================================================================================
  _arms(p, swingL, swingR, elbowL, elbowR, out = 0.12, twist = 0) {
    for (const [S, s, sw, el] of [['L', 1, swingL, elbowL], ['R', -1, swingR, elbowR]]) {
      const ad = -(this.beta - out) * s; // bring the A-pose arm down to the side
      // D = Rx(-swing) · Rz(adduct) — swing forward = −X rotation
      qAxis(p.D[B['upperArm' + S]], X, -sw).multiply(_q.setFromAxisAngle(Z, ad)).multiply(_q.setFromAxisAngle(_vJ.copy(this.J[B['foreArm' + S]]).sub(this.J[B['upperArm' + S]]).normalize(), twist * s));
      const hinge = _vJ.copy(this.J[B['foreArm' + S]]).sub(this.J[B['upperArm' + S]]).normalize().cross(Z).normalize();
      qAxis(p.D[B['foreArm' + S]], hinge, el);
      // relaxed hand: slight flexion
      qAxis(p.D[B['hand' + S]], hinge, 0.18);
    }
  }

  _loco(p, s) {
    const sp = this.speed, g = this.gait, spr = this.sprint;
    const move = sstep(0.05, 0.9, sp);
    const ph = this.phase;
    const duty = lerp(lerp(0.6, 0.29, g), 0.21, spr);
    const f = sp < 0.05 ? 1 : cadence(sp);
    const fore = lerp(0.5, 0.4, g); // running feet land under the body, push off far behind
    const cyc = sp / f;
    const stride = cyc * duty; // distance the foot travels in stance
    const lift = lerp(lerp(0.1, 0.22, g), 0.2, spr);
    const t = this.time;
    // breathing / idle sway
    const br = Math.sin(t * 1.65);
    const swayX = Math.sin(t * 0.42) * 0.018 * (1 - move);
    p.ik = 1;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const ft = p.feet[i];
      const phi = (ph + i * 0.5) % 1;
      if (this._prevPhi[i] > phi && move > 0.5 && !this.freezePhase) this.stepEvents.push({ foot: i, speed: sp });
      this._prevPhi[i] = phi;
      let z, y, pitch, toe = 0;
      if (phi < duty) {
        const u = phi / duty;
        z = stride * (fore - u);
        y = 0;
        pitch = lerp(0.28 * (1 - g * 0.6), 0, sstep(0, 0.18, u)) - lerp(0, 0.62 + 0.25 * g, sstep(0.62, 1, u));
        toe = sstep(0.7, 1, u) * 0.55;
      } else {
        const u = (phi - duty) / (1 - duty);
        const e = u * u * (3 - 2 * u);
        z = stride * (fore - 1) + stride * e;
        // heel kick (running: foot tucks up behind the body early in swing)
        const kick = g * Math.sin(Math.PI * Math.min(1, u * 1.6)) * lerp(0.13, 0.24, spr);
        y = lift * Math.sin(Math.PI * u) * (1 - 0.35 * g) + kick;
        z -= g * Math.sin(Math.PI * Math.min(1, u * 1.4)) * 0.12 * (1 - u);
        pitch = lerp(-0.7 - 0.4 * g, 0.22 * (1 - g * 0.5), sstep(0.15, 0.95, u));
        toe = (1 - u) * 0.3;
      }
      // idle stance blend
      const ix = side * 0.112, iz = i === 0 ? 0.035 : -0.045;
      const wx = side * lerp(0.098, 0.07, g);
      ft.pos.set(lerp(ix + swayX * 0.0, wx, move), y * move, lerp(iz, z, move));
      ft.pitch = pitch * move;
      ft.toe = toe * move;
      ft.yaw = side * lerp(0.12, 0.04, move);
    }
    // pelvis
    const walkBob = -0.022 * Math.cos(4 * Math.PI * ph);
    const runBob = -0.045 * Math.cos(4 * Math.PI * (ph - duty * 0.5));
    const bob = lerp(walkBob * Math.min(1, sp / 1.6), runBob, g) * move;
    const base = lerp(lerp(-0.012, -0.028, g), -0.035, spr) * move - 0.014 * (1 - move);
    p.root.set(swayX + 0.008 * Math.sin(TAU * ph) * move * (1 - g), base + bob + br * 0.002 * (1 - move), 0);
    const pYaw = -Math.cos(TAU * ph) * lerp(0.13, 0.17, g) * move;
    const pRoll = Math.sin(TAU * ph) * 0.06 * move * (1 - g * 0.3) + swayX * 1.5;
    // whole-body lean & bank applied at the hips
    qYXZ(p.D[B.hips], this.lean * 0.55, pYaw, this.bank + pRoll);
    qYXZ(p.D[B.spine], this.lean * 0.35 + 0.02 * br * (1 - move), -pYaw * 0.6, -pRoll * 0.7);
    qYXZ(p.D[B.chest], this.lean * 0.15 - 0.025 * br * (1 - move) + g * 0.04 * Math.abs(Math.sin(TAU * ph)), -pYaw * 1.6, -pRoll * 0.4 - this.bank * 0.25);
    qYXZ(p.D[B.neck], -this.lean * 0.4, pYaw * 1.0, pRoll * 0.5);
    // arms counter-swing
    const A = lerp(lerp(0.32, 0.82, g), 0.95, spr) * move;
    const swingL = -Math.cos(TAU * ph) * A + 0.05 - 0.12 * spr;
    const swingR = Math.cos(TAU * ph) * A + 0.05 - 0.12 * spr;
    const elBase = lerp(lerp(0.28, 1.3, g), 1.42, spr) * move + 0.22 * (1 - move);
    this._arms(p, swingL + 0.05 * br * (1 - move), swingR + 0.05 * br * (1 - move), elBase + Math.max(0, swingL) * 0.5, elBase + Math.max(0, swingR) * 0.5, lerp(0.1, 0.22, g * move), 0.3 * g * move);
    // shoulders lift with breathing / run
    for (const [S, s] of [['L', 1], ['R', -1]]) qYXZ(p.D[B['clav' + S]], 0, 0, s * (0.03 * br * (1 - move) + 0.04 * g * move));
  }

  _air(p, s) {
    const vy = s.vy ?? 0;
    const rise = sstep(-3, 3, vy);
    const t = this.time;
    // rising: leading knee up, trailing leg back; falling: reaching down, arms out
    const lead = Math.cos(TAU * this.phase) > 0 ? 1 : -1;
    const thL = lerp(0.35, lead > 0 ? 1.05 : -0.15, rise), thR = lerp(0.18, lead > 0 ? -0.15 : 1.05, rise);
    const knL = lerp(0.45, lead > 0 ? 1.5 : 0.7, rise), knR = lerp(0.3, lead > 0 ? 0.7 : 1.5, rise);
    this._legsFK(p, thL, thR, knL, knR, 0.06, -0.25 + 0.15 * Math.sin(t * 3));
    qYXZ(p.D[B.hips], 0.1 + this.lean * 0.4, 0, this.bank * 0.6);
    qYXZ(p.D[B.spine], lerp(0.05, 0.18, rise), 0, 0);
    qYXZ(p.D[B.chest], lerp(-0.08, 0.05, rise), 0, 0);
    const armOut = lerp(0.85, 0.25, rise);
    this._arms(p, lerp(0.15, lead > 0 ? -0.5 : 0.95, rise), lerp(0.15, lead > 0 ? 0.95 : -0.5, rise), lerp(0.45, 1.1, rise), lerp(0.45, 1.1, rise), armOut);
    p.root.set(0, lerp(0.02, 0.06, rise), 0);
  }

  _glide(p, s) {
    const t = this.time;
    const flutter = Math.sin(t * 7.3) * 0.03 + Math.sin(t * 2.1) * 0.05;
    qYXZ(p.D[B.hips], 0.95 + this.lean * 0.3, 0, this.bank * 1.4);
    qYXZ(p.D[B.spine], 0.08, 0, 0);
    qYXZ(p.D[B.chest], -0.12, 0, 0);
    // arms spread like wings, swept back
    this._arms(p, -0.35 + flutter, -0.35 - flutter, 0.18, 0.18, 1.32 + flutter, -0.4);
    this._legsFK(p, -0.12, -0.02, 0.28, 0.42, -0.03, -0.55);
    p.root.set(0, 0.0, 0);
  }

  _jet(p, s) {
    const t = this.time;
    const sway = Math.sin(t * 1.7) * 0.08;
    qYXZ(p.D[B.hips], 0.22 + this.lean * 0.5, 0, this.bank * 0.8 + sway * 0.3);
    qYXZ(p.D[B.spine], 0.06, 0, 0);
    qYXZ(p.D[B.chest], -0.05, 0, 0);
    this._arms(p, 0.35 + sway * 0.4, 0.3 - sway * 0.4, 0.75, 0.8, 0.42, 0.2);
    this._legsFK(p, 0.25 + sway, 0.05 - sway * 0.5, 0.65 + sway, 0.35, 0.05, -0.5);
    p.root.set(0, 0.04, 0);
  }

  _swim(p, s) {
    const sp = Math.min(this.speed, 4);
    const move = sstep(0.3, 1.6, sp);
    this.swimPhase = (this.swimPhase + s.dt * lerp(0.35, 0.75, move)) % 1;
    const ph = this.swimPhase, t = this.time;
    // body: upright treading ↔ horizontal crawl
    qYXZ(p.D[B.hips], lerp(0.25, 1.3, move), 0, Math.sin(TAU * ph) * 0.18 * move + this.bank * 0.5);
    qYXZ(p.D[B.spine], 0.05, 0, 0);
    qYXZ(p.D[B.chest], 0, Math.sin(TAU * ph) * 0.2 * move, 0);
    qYXZ(p.D[B.neck], -lerp(0.1, 0.7, move), 0, 0);
    // crawl stroke (arms rotate) vs sculling
    const aL = TAU * ph, aR = aL + Math.PI;
    const crawlL = 1.4 - Math.cos(aL) * 1.75, crawlR = 1.4 - Math.cos(aR) * 1.75;
    const scull = Math.sin(t * 2.6) * 0.35;
    this._arms(p, lerp(0.3, crawlL, move), lerp(0.3, crawlR, move), lerp(0.7, 0.35 + 0.4 * Math.max(0, Math.sin(aL)), move), lerp(0.7, 0.35 + 0.4 * Math.max(0, Math.sin(aR)), move), lerp(0.9 + scull, 0.25, move), 0);
    const kick = Math.sin(t * lerp(3, 9, move)) * lerp(0.35, 0.22, move);
    this._legsFK(p, lerp(0.45, 0.0, move) + kick, lerp(0.15, 0.0, move) - kick, lerp(0.9, 0.25, move) + kick * 0.6, lerp(0.5, 0.25, move) - kick * 0.6, 0.05, lerp(-0.2, -0.75, move));
    p.root.set(0, 0, 0);
  }

  _slide(p, s) {
    const t = this.time;
    const yaw = 0.95;
    const wob = Math.sin(t * 5.1) * 0.03;
    p.ik = 1;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    for (let i = 0; i < 2; i++) {
      const ft = p.feet[i];
      const along = i === 0 ? 0.24 : -0.24; // front foot is the left one
      const lat = i === 0 ? 0.04 : -0.04;
      ft.pos.set(along * sn + lat * c, 0, along * c - lat * sn);
      ft.pitch = 0; ft.toe = 0; ft.yaw = yaw;
    }
    p.root.set(0, -0.2 + wob, 0);
    qYXZ(p.D[B.hips], 0.28, yaw, this.bank * 0.5);
    qYXZ(p.D[B.spine], 0.1, -0.3, 0);
    qYXZ(p.D[B.chest], -0.05, -0.35, wob);
    qYXZ(p.D[B.neck], -0.2, -0.3, 0);
    this._arms(p, 0.25, -0.2, 0.35, 0.5, 1.05 + wob * 3, 0);
  }

  _roll(p, s) {
    const u = clamp(this.rollT, 0, 1);
    const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    const ang = e * TAU;
    const tuck = Math.sin(Math.PI * u);
    // rotate the whole body about a pivot at the centre of the tucked ball
    const C = _vJ.set(0, 0.42, 0);
    qYXZ(p.D[B.hips], ang + 0.4 * tuck, 0, 0);
    const hip = _v.copy(this.J[B.hips]).sub(C).applyQuaternion(p.D[B.hips]).add(C);
    p.root.copy(hip).sub(this.J[B.hips]);
    p.root.y -= 0.35 * tuck;
    p.root.z += 0.15 * tuck;
    qYXZ(p.D[B.spine], 0.6 * tuck, 0, 0);
    qYXZ(p.D[B.chest], 0.4 * tuck, 0, 0);
    qYXZ(p.D[B.neck], 0.5 * tuck, 0, 0);
    this._arms(p, 0.7 * tuck, 0.7 * tuck, 0.3 + 1.4 * tuck, 0.3 + 1.4 * tuck, 0.3, 0);
    this._legsFK(p, 1.5 * tuck, 1.3 * tuck, 0.3 + 2.0 * tuck, 0.3 + 1.9 * tuck, 0.05, 0.2 * tuck);
  }

  _ride(p, s) {
    const t = this.time;
    qYXZ(p.D[B.hips], 0.38, 0, this.bank * 0.5);
    qYXZ(p.D[B.spine], 0.12, 0, 0);
    qYXZ(p.D[B.chest], 0.05 + Math.sin(t * 1.6) * 0.01, 0, 0);
    qYXZ(p.D[B.neck], -0.35, 0, 0);
    this._arms(p, 0.95, 0.95, 0.55, 0.55, 0.3, 0.1);
    this._legsFK(p, 1.35, 1.35, 1.55, 1.55, 0.18, 0.15);
    p.root.set(0, -0.42, -0.05);
  }

  _legsFK(p, thighL, thighR, kneeL, kneeR, abd = 0.05, ankle = 0) {
    for (const [S, s, th, kn] of [['L', 1, thighL, kneeL], ['R', -1, thighR, kneeR]]) {
      qAxis(p.D[B['thigh' + S]], X, -th).multiply(_q.setFromAxisAngle(Z, s * abd));
      qAxis(p.D[B['shin' + S]], X, kn);
      qAxis(p.D[B['foot' + S]], X, -ankle);
      p.D[B['toe' + S]].identity();
    }
  }
}

// scratch
const _vA = new THREE.Vector3(), _vB = new THREE.Vector3(), _vC = new THREE.Vector3(), _vD = new THREE.Vector3();
const _vE = new THREE.Vector3(), _vF = new THREE.Vector3(), _vG = new THREE.Vector3(), _vH = new THREE.Vector3();
const _vI = new THREE.Vector3(), _vJ = new THREE.Vector3();
const _qA = new THREE.Quaternion(), _qB = new THREE.Quaternion(), _qC = new THREE.Quaternion(), _qD = new THREE.Quaternion();
