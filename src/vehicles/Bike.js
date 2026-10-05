// Hover bike — repulsor spring physics over terrain AND water.
//
// Four probes (front/rear × left/right) sample World.groundAt (terrain, roofs
// and the sea surface). Each acts as a damped spring toward the hover height;
// their average drives the vertical motion, their spread gives the surface
// normal the chassis aligns to. Steering yaws the heading; lateral grip bleeds
// sideways velocity (low grip while braking+steering = drift). Banking, pitch
// from acceleration, boost with FOV kick and speed streaks, dust/spray plumes.

import * as THREE from 'three';
import { buildBike } from './Models.js';
import { Flame, Trail, GroundGlow } from './VFX.js';

const clamp = THREE.MathUtils.clamp;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _p = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _g = {};
const _e = new THREE.Euler();

const HOVER = 0.62;       // m, chassis origin above the surface (belly ≈ 0.55 m clear)
const MAX_SPEED = 62;     // m/s cruise (~220 km/h)
const BOOST_SPEED = 105;  // m/s boost (~380 km/h)

export class Bike {
  constructor(sys, { seed = 1, livery = 0 } = {}) {
    this.sys = sys;
    this.world = sys.world;
    this.type = 'bike';
    const model = buildBike(sys.mats, { seed, livery });
    this.model = model;
    this.object3d = new THREE.Group();
    this.object3d.name = 'hover-bike';
    this.body = model.group; // visual child (bank/pitch/bob)
    this.object3d.add(this.body);
    this.position = this.object3d.position;
    this.quaternion = this.object3d.quaternion;
    this.velocity = new THREE.Vector3();
    this.seat = model.seat.clone();
    this.cameraProfile = { distance: 6.2, height: 2.3, fov: 64, lag: 8 };
    this.baseFov = 64;
    this.heading = new THREE.Vector3(0, 0, 1);
    this._baseQ = new THREE.Quaternion();
    this.up = new THREE.Vector3(0, 1, 0);
    this.normal = new THREE.Vector3(0, 1, 0);
    this.vUp = 0;
    this.yawRate = 0; this.bank = 0; this.pitch = 0; this.steer = 0;
    this.throttle = 0; this.boost = 0; this.drift = 0;
    this.rider = null;
    this.overWater = false; this.groundH = 0;
    this.sleeping = false;
    // VFX
    this.flame = new Flame({ radius: 0.15, length: 0.9, core: [1.0, 0.75, 0.8], edge: [1.0, 0.25, 0.15], boost: [0.5, 0.75, 1.0], gain: 0.28 });
    this.flame.mesh.position.copy(model.nozzles[0].pos);
    this.body.add(this.flame.mesh);
    this.glow = new GroundGlow([0.3, 0.8, 1.0]);
    this.glow.mesh.scale.set(3.4, 1, 5.6);
    this.lightTrail = new Trail(28, { width: 0.025, color: [1.0, 0.12, 0.06], minStep: 1.0, erode: 0 });
    this._emitAcc = 0;
  }

  addTo(scene) { scene.add(this.object3d); scene.add(this.glow.mesh); scene.add(this.lightTrail.mesh); }

  /** Place at a surface direction, facing `forward` (tangent hint). */
  place(dir, forward) {
    const w = this.world;
    _v.copy(dir).normalize();
    const g = w.groundAt(_p.copy(_v).multiplyScalar(w.radius + w.heightAt(_v) + 50), _g);
    const top = Math.max(g.radius, g.water ? g.waterRadius : -Infinity);
    this.position.copy(_v).multiplyScalar(top + HOVER);
    this.up.copy(_v);
    this.heading.copy(forward).addScaledVector(_v, -forward.dot(_v)).normalize();
    this.velocity.set(0, 0, 0); this.vUp = 0;
    this.normal.copy(_v);
    this._orient(1);
    this.lightTrail.reset();
    return this;
  }

  canBoard(pos) { return !this.rider && pos.distanceTo(this.position) < 4.5; }
  enter(player) { this.rider = player; this.sleeping = false; this.sys.onBoard(this); }
  exit() {
    this.rider = null;
    this.sys.onAlight(this);
    const left = _v.crossVectors(this.up, this.heading).normalize();
    const p = this.position.clone().addScaledVector(left, 1.6);
    const g = this.world.groundAt(p, _g);
    return p.copy(g.point).addScaledVector(this.up, Math.max(0, (g.water ? g.waterRadius : 0) - g.radius) + 0.05);
  }

  update(dt, input, t) {
    const w = this.world;
    const camD = this.sys.level.camera.position.distanceToSquared(this.position);
    if (!input && camD > 600 * 600 && this.velocity.lengthSq() < 0.01) { this.sleeping = true; this.object3d.visible = camD < 6000 * 6000; this.glow.mesh.visible = false; return; }
    this.sleeping = false;
    this.object3d.visible = true;
    const steps = Math.min(4, Math.max(1, Math.ceil(dt / (1 / 60))));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this._step(h, input);
    this._orient(dt);
    this._fx(dt, t, input);
    void w;
  }

  _step(dt, input) {
    const w = this.world;
    const up = this.up.copy(this.position).normalize();
    const fwd = this.heading.addScaledVector(up, -this.heading.dot(up)).normalize();
    const left = _v.crossVectors(up, fwd).normalize();

    // ---- input
    let thr = 0, steer = 0, boost = false, brake = false, hop = false;
    if (input) {
      thr = clamp(input.move.y + (input.throttle || 0), -1, 1);
      steer = clamp(input.move.x + (input.look?.x || 0) * 0, -1, 1);
      boost = input.down('sprint');
      brake = input.down('crouch') || input.down('brake');
      hop = input.pressed('jump');
    }
    this.throttle += ((boost ? 1 : Math.max(0, thr)) - this.throttle) * (1 - Math.exp(-6 * dt));
    this.boost += ((boost ? 1 : 0) - this.boost) * (1 - Math.exp(-(boost ? 4 : 2) * dt));
    this.steer += (steer - this.steer) * (1 - Math.exp(-8 * dt));

    // ---- probes: hover springs
    let hSum = 0, n = 0, water = 0;
    const probes = [[0.45, 1.15], [-0.45, 1.15], [0.45, -1.2], [-0.45, -1.2]];
    const hs = [];
    for (const [x, z] of probes) {
      _p.copy(this.position).addScaledVector(left, x).addScaledVector(fwd, z);
      const g = w.groundAt(_p, _g);
      const top = Math.max(g.radius, g.water ? g.waterRadius : -Infinity);
      if (g.water) water++;
      const hh = _p.length() - top;
      hs.push(hh); hSum += hh; n++;
    }
    const hAvg = hSum / n;
    this.groundH = hAvg;
    this.overWater = water >= 2;
    // surface normal from probe height differences (front-back, left-right)
    const dzSlope = ((hs[2] + hs[3]) - (hs[0] + hs[1])) * 0.5 / 2.35; // height rises toward the back → nose up
    const dxSlope = ((hs[1] + hs[3]) - (hs[0] + hs[2])) * 0.5 / 0.9;
    this.normal.copy(up).addScaledVector(fwd, -dzSlope).addScaledVector(left, -dxSlope).normalize();
    // keep slope response sane on cliffs
    if (this.normal.dot(up) < 0.55) this.normal.lerp(up, 0.5).normalize();

    const g0 = w.gravity;
    let aUp = -g0;
    if (hAvg < HOVER * 3) {
      const k = 70, c = 11;
      const sink = HOVER - hAvg;
      aUp += g0 * clamp(1 + sink * 1.2, 0, 3) + k * sink * 0.25 - c * this.vUp * (hAvg < HOVER * 1.8 ? 1 : 0.3);
    }
    // arcade downforce: at speed the repulsors pull the bike back onto the terrain over crests
    const spd = Math.hypot(this.velocity.x, this.velocity.y, this.velocity.z);
    if (hAvg > HOVER) aUp -= g0 * 1.6 * clamp(spd / 45, 0, 1) * clamp((hAvg - HOVER) / 1.5, 0, 1) * (this._hopT > 0 ? 0.2 : 1);
    this._hopT = Math.max(0, (this._hopT || 0) - dt);
    if (hop && hAvg < HOVER * 1.6) { this.vUp += 7.5; this._hopT = 0.8; }
    this.vUp += aUp * dt;
    this.vUp *= Math.exp(-0.4 * dt);

    // ---- planar dynamics
    const vt = _v2.copy(this.velocity).addScaledVector(up, -this.velocity.dot(up));
    let s = vt.dot(fwd), l = vt.dot(left);
    const vmax = MAX_SPEED + (BOOST_SPEED - MAX_SPEED) * this.boost;
    if (thr > 0 || boost) s += (boost ? 34 : 24) * Math.max(thr, boost ? 1 : 0) * clamp(1 - s / vmax, -1, 1) * dt;
    else if (thr < 0) s += (s > 1 ? -42 : -10 * clamp(1 + s / 14, 0, 1)) * -thr * dt;
    if (brake) s -= Math.sign(s) * Math.min(Math.abs(s), 18 * dt);
    // slope: gravity pulls along the surface
    s += -g0 * (this.normal.dot(fwd)) * dt * 0.6;
    s *= Math.exp(-(0.05 + (input ? 0 : 0.6)) * dt);
    if (Math.abs(s) > vmax * 1.15) s *= Math.exp(-1.5 * dt);
    const drifting = brake && Math.abs(this.steer) > 0.3 && Math.abs(s) > 18;
    this.drift += ((drifting ? 1 : 0) - this.drift) * (1 - Math.exp(-5 * dt));
    const grip = THREE.MathUtils.lerp(8, 1.1, this.drift);
    l *= Math.exp(-grip * dt);
    // steering: rate falls with speed; drift tightens it
    const sp = Math.abs(s);
    const turn = this.steer * THREE.MathUtils.lerp(2.1, 0.95, clamp(sp / BOOST_SPEED, 0, 1)) * clamp(sp / 4, 0.25, 1) * (1 + this.drift * 0.6) * (s < -0.5 ? -1 : 1);
    this.yawRate += (turn - this.yawRate) * (1 - Math.exp(-7 * dt));
    fwd.applyAxisAngle(up, -this.yawRate * dt).normalize();
    left.crossVectors(up, fwd).normalize();
    // velocity follows the new heading (grip), with sideways slip retained for drift
    this.velocity.copy(fwd).multiplyScalar(s).addScaledVector(left, l).addScaledVector(up, this.vUp);
    this.position.addScaledVector(this.velocity, dt);

    // hard floor
    const g = w.groundAt(this.position, _g);
    const top = Math.max(g.radius, g.water ? g.waterRadius : -Infinity) + 0.25;
    const r = this.position.length();
    if (r < top) { this.position.multiplyScalar(top / r); if (this.vUp < 0) this.vUp = -this.vUp * 0.15; }
    // buildings / rocks / trees
    _v3.copy(this.position);
    if (w.collide(this.position, 1.0, 1.4)) {
      const push = _v3.sub(this.position).negate();
      const pl = push.length();
      if (pl > 1e-4) {
        push.multiplyScalar(1 / pl);
        const into = this.velocity.dot(push);
        if (into < 0) this.velocity.addScaledVector(push, -into * 1.3);
        this.velocity.multiplyScalar(0.92);
        this.sys.shake(Math.min(1, -into / 30));
      }
    }
    this.heading.copy(fwd);
    this._s = s; this._l = l; this._accel = thr;
  }

  _orient(dt) {
    const up = this.up.copy(this.position).normalize();
    const fwd = _v.copy(this.heading).addScaledVector(up, -this.heading.dot(up)).normalize();
    // chassis up: blend toward the surface normal near the ground
    const near = clamp(1 - (this.groundH - HOVER) / 4, 0, 1);
    const cu = _v2.copy(up).lerp(this.normal, 0.85 * near).normalize();
    const f2 = _v3.copy(fwd).addScaledVector(cu, -fwd.dot(cu)).normalize();
    const l2 = _p.crossVectors(cu, f2).normalize();
    _m.makeBasis(l2, cu, f2);
    _q.setFromRotationMatrix(_m);
    const k = dt >= 1 ? 1 : 1 - Math.exp(-12 * dt);
    this._baseQ.slerp(_q, k);
    // visual bank / pitch on the body child
    const sp = Math.abs(this._s || 0);
    const bankT = clamp(this.yawRate * sp * 0.022, -0.75, 0.75) + clamp((this._l || 0) * 0.02, -0.3, 0.3);
    this.bank += (bankT - this.bank) * (dt >= 1 ? 1 : 1 - Math.exp(-6 * dt));
    const pitchT = -this.throttle * 0.05 + this.boost * -0.04 + clamp(-this.vUp * 0.02, -0.15, 0.15);
    this.pitch += (pitchT - this.pitch) * (dt >= 1 ? 1 : 1 - Math.exp(-4 * dt));
    const bob = Math.sin((this.sys.time || 0) * 2.3) * 0.04 * (1 - clamp(sp / 20, 0, 1));
    this.body.position.set(0, bob, 0);
    // bank & pitch live on the root so the rider leans with the machine
    this.quaternion.copy(this._baseQ).multiply(_q2.setFromEuler(_e.set(this.pitch, 0, this.bank, 'YXZ')));
  }

  _fx(dt, t, input) {
    const sys = this.sys, w = this.world;
    const sp = Math.abs(this._s || 0);
    const driven = !!input;
    this.flame.set(driven ? 0.25 + this.throttle * 0.75 : 0.06, this.boost, t);
    this.model.hoverMat.color.setRGB(0.42, 1.0, 1.25).multiplyScalar(5 + this.throttle * 4 + this.boost * 6);
    // ground light pool
    const up = this.up;
    const g = w.groundAt(this.position, _g);
    const top = Math.max(g.radius, g.water ? g.waterRadius : -Infinity);
    const hgt = this.position.length() - top;
    this.glow.mesh.visible = hgt < 6;
    if (this.glow.mesh.visible) {
      this.glow.mesh.position.copy(up).multiplyScalar(top + 0.06);
      this.glow.mesh.quaternion.copy(this.quaternion);
      this.glow.uniforms.uI.value = (1.1 + this.throttle * 0.8 + this.boost * 0.8) * clamp(1.4 - hgt / 4, 0, 1) * (this.overWater ? 0.7 : 1) * (0.45 + 1.5 * (1 - w.daylight));
      this.glow.uniforms.uTime.value = t;
    }
    // tail-light ribbon at speed (Akira light trails)
    _p.copy(this.model.nozzles[0].pos).add(_v.set(0, 0.1, 0.25));
    this.body.updateMatrixWorld();
    _p.applyMatrix4(this.body.matrixWorld);
    this.lightTrail.push(_p, clamp((sp - 12) / 40, 0, 1) * (0.6 + this.boost));
    this.lightTrail.uniforms.uLight.value.setScalar(1.6 + this.boost * 1.6);
    // dust / spray
    if (sp > 6 && hgt < 4) {
      const P = this.overWater ? sys.spray : sys.dust;
      const rate = clamp(sp / 40, 0, 1.6) * (this.overWater ? 80 : 70) * (1 + this.boost * 2.2) * sys.fxScale;
      this._emitAcc += rate * dt;
      const fwd = this.heading, left = _v2.crossVectors(up, fwd).normalize();
      const dc = sys.dustColor;
      while (this._emitAcc >= 1) {
        this._emitAcc -= 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        _p.copy(up).multiplyScalar(top + 0.2).addScaledVector(fwd, (this.position.dot(fwd) - up.dot(fwd) * 0) * 0);
        _p.copy(this.position).addScaledVector(up, -hgt + 0.15).addScaledVector(fwd, -1.2 - Math.random() * 1.0).addScaledVector(left, side * (0.3 + Math.random() * 0.4));
        const vel = _v3.copy(fwd).multiplyScalar(-sp * 0.12 - Math.random() * 3).addScaledVector(left, side * (2 + Math.random() * 4)).addScaledVector(up, this.overWater ? 4 + Math.random() * 5 : 0.6 + Math.random() * 1.6);
        vel.addScaledVector(this.velocity, 0.35);
        if (this.overWater) P.emit(_p, vel, 0.8 + Math.random() * 0.7, 0.25, 1.4 + Math.random(), 0.85, 0.9, 0.95, 0.55, t, true);
        else if (Math.random() < 0.3) P.emit(_p, vel.addScaledVector(up, 1.5 + Math.random() * 2), 0.5 + Math.random() * 0.5, 0.06, 0.12, dc.r * 0.55, dc.g * 0.7, dc.b * 0.45, 0.9, t, true); // grass / grit kicked up
        else P.emit(_p, vel, 1.6 + Math.random() * 1.8, 0.6, 3.5 + Math.random() * 3.0, dc.r, dc.g, dc.b, 0.36, t, false);
      }
    }
  }

  dispose() {
    this.flame.dispose(); this.glow.dispose(); this.lightTrail.dispose();
    this.object3d.removeFromParent(); this.glow.mesh.removeFromParent(); this.lightTrail.mesh.removeFromParent();
  }
}
