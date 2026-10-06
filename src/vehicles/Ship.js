// Starship — arcade-sim flight from orbit to the ground.
//
// Body-rate control: mouse/right stick drive a spring-centred virtual stick
// (pitch / yaw), Q/E roll, W/S (or triggers) move a persistent throttle,
// Shift boosts, Space/C give vertical (VTOL) thrust.
// In the atmosphere (density ρ = exp(-alt / H)):
//   - velocity aligns with the nose (lift) proportionally to ρ,
//   - quadratic drag ∝ ρ|v|² — hitting the air at orbital speed decelerates
//     hard and lights the re-entry plasma sheath (emergent, not scripted),
//   - bank-to-turn: yaw input rolls the ship into a coordinated turn,
//   - antigrav lift trims out gravity so flying low feels effortless.
// Above the atmosphere: inertial space flight, throttle ceiling grows with
// altitude so orbit → ground takes ~a minute, not ten.
// Landing assist: near the ground and slow, the ship auto-levels and the gear
// drops; touching down slow & level lands it. Interact while airborne starts an
// automatic descent; interact when landed exits (handled by the player).

import * as THREE from 'three';
import { buildShip } from './Models.js';
import { Flame, Trail, Plasma, GlowSprite, BlobShadow } from './VFX.js';

const clamp = THREE.MathUtils.clamp, smooth = THREE.MathUtils.smoothstep, lerp = THREE.MathUtils.lerp;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _p = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _g = {};
const _n = new THREE.Vector3();
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

export class Ship {
  constructor(sys, { seed = 1, livery = 0 } = {}) {
    this.sys = sys;
    this.world = sys.world;
    this.type = 'ship';
    const model = buildShip(sys.mats, { seed, livery });
    this.model = model;
    this.object3d = new THREE.Group();
    this.object3d.name = 'starship';
    this.object3d.add(model.group);
    this.position = this.object3d.position;
    this.quaternion = this.object3d.quaternion;
    this.velocity = new THREE.Vector3();
    this.seat = new THREE.Vector3(0, 0.25, 1.2);
    this.cameraProfile = { distance: 19, height: 4.8, fov: 62, lag: 5 };
    this.angVel = new THREE.Vector3(); // body rates: x pitch, y yaw, z roll (rad/s)
    this.stick = new THREE.Vector2();
    this.thrSet = 0.35; this.throttle = 0; this.boost = 0; this.vtol = 0;
    this.landed = true; this.autoland = false; this.gearT = 1;
    this.rider = null;
    this.alt = 0; this.rho = 1; this.speed = 0; this.space = 0; this.reentry = 0; this.gload = 0;
    this.manualRollT = 0;
    // VFX
    this.flames = model.nozzles.map((n, i) => {
      const f = new Flame({ radius: n.r, length: n.len, core: i ? [0.8, 0.9, 1.0] : [1.0, 0.86, 0.7], edge: i ? [0.35, 0.5, 1.0] : [1.0, 0.38, 0.1] });
      f.mesh.position.copy(n.pos);
      model.group.add(f.mesh);
      return f;
    });
    // nozzle glow sprites: the bell reads white-hot from any angle, and seeds the bloom
    this.glows = model.nozzles.map((n, i) => {
      const g = new GlowSprite(i ? [0.45, 0.6, 1.0] : [1.0, 0.55, 0.25], n.r * 4.2);
      g.mesh.position.copy(n.pos);
      model.group.add(g.mesh);
      return g;
    });
    this._coreA = new THREE.Color(1.0, 0.86, 0.7); this._edgeA = new THREE.Color(1.0, 0.38, 0.1);
    this._coreS = new THREE.Color(0.75, 0.9, 1.0); this._edgeS = new THREE.Color(0.25, 0.45, 1.0);
    this.shadow = new BlobShadow();
    this._sprayAcc = 0;
    this.vortex = model.wingtips.map(() => new Trail(26, { width: 0.05, grow: 16, color: [0.9, 0.94, 1.0], minStep: 2, erode: 0.8 }));
    this.contrail = new Trail(96, { width: 1.4, color: [1, 1, 1], minStep: 6, additive: false });
    this.plasma = new Plasma(6.5);
    this.object3d.add(this.plasma.mesh);
    this._wing = [new THREE.Vector3(), new THREE.Vector3()];
  }

  addTo(scene) {
    scene.add(this.object3d);
    for (const t of this.vortex) scene.add(t.mesh);
    scene.add(this.contrail.mesh);
    scene.add(this.shadow.mesh);
  }

  /** Park on the ground at dir, nose along `forward`. */
  park(dir, forward) {
    const w = this.world;
    _v.copy(dir).normalize();
    const g = w.groundAt(_p.copy(_v).multiplyScalar(w.radius + w.heightAt(_v) + 80), _g);
    const top = Math.max(g.radius, g.water ? g.waterRadius : -Infinity);
    this.position.copy(_v).multiplyScalar(top + this.model.gearHeight);
    this._levelTo(_v, forward, 1);
    this.velocity.set(0, 0, 0); this.angVel.set(0, 0, 0);
    this.landed = true; this.autoland = false; this.gearT = 1; this.thrSet = 0;
    this._resetTrails();
    return this;
  }

  /** Free flight at position, nose toward target. */
  fly(position, target, speed = 0, upHint = null) {
    this.position.copy(position);
    const f = _v.copy(target).sub(position).normalize();
    const up = _v2.copy(upHint || position).normalize();
    const l = _v3.crossVectors(up, f).normalize();
    up.crossVectors(f, l).normalize();
    _m.makeBasis(l, up, f);
    this.quaternion.setFromRotationMatrix(_m);
    this.velocity.copy(f).multiplyScalar(speed);
    this.angVel.set(0, 0, 0);
    this.landed = false; this.autoland = false; this.gearT = 0;
    this._resetTrails();
    return this;
  }

  _resetTrails() { for (const t of this.vortex) t.reset(); this.contrail.reset(); }

  _levelTo(up, forward, k) {
    const f = _v2.copy(forward).addScaledVector(up, -forward.dot(up));
    if (f.lengthSq() < 1e-8) f.set(1, 0, 0).addScaledVector(up, -up.x);
    f.normalize();
    const l = _v3.crossVectors(up, f).normalize();
    _m.makeBasis(l, up, f);
    _q.setFromRotationMatrix(_m);
    this.quaternion.slerp(_q, k);
  }

  canBoard(pos) {
    if (this.rider || !this.landed) return false;
    // board from beside the cockpit or under the nose
    return pos.distanceTo(this.position) < 9;
  }
  enter(player) { this.rider = player; this.sys.onBoard(this); }
  exit() {
    this.rider = null;
    this.sys.onAlight(this);
    const up = _v.copy(this.position).normalize();
    const left = _v2.set(1, 0, 0).applyQuaternion(this.quaternion);
    const p = this.position.clone().addScaledVector(left, 3.2).addScaledVector(up, 2);
    if (!this.landed) this.autoland = true; // unmanned: it settles down by itself
    const g = this.world.groundAt(p, _g);
    p.copy(g.point);
    if (g.water) p.copy(up).multiplyScalar(g.waterRadius + 0.05);
    return p;
  }

  get atmosphereHeight() { return Math.max(this.world.atmosphereHeight || 0, this.world.radius * 0.04); }

  update(dt, input, t) {
    if (this._holdForShot) { this._fx(dt, t, true); return; }
    const camD = this.sys.level.camera.position.distanceToSquared(this.position);
    if (!input && this.landed && camD > 3000 * 3000) { this.object3d.visible = camD < 20000 * 20000; return; }
    this.object3d.visible = true;
    const steps = Math.min(4, Math.max(1, Math.ceil(dt / (1 / 60))));
    for (let i = 0; i < steps; i++) this._step(dt / steps, input);
    this._fx(dt, t, !!input);
  }

  _step(dt, input) {
    const w = this.world, R = w.radius;
    const r = this.position.length();
    const up = _v.copy(this.position).multiplyScalar(1 / r);
    const sr = w.surfaceRadius(up);
    this.alt = r - sr;
    const H = this.atmosphereHeight;
    this.rho = Math.exp(-Math.max(0, this.alt) / (H * 0.22)) * (this.alt < H ? 1 : Math.exp(-(this.alt - H) / (H * 0.05)));
    const air = smooth(this.rho, 0.002, 0.08); // 0 in space, 1 in the lower atmosphere
    this.space = 1 - air;
    const q = this.quaternion;
    const fwd = _v2.copy(Z).applyQuaternion(q);
    const sUp = _v3.copy(Y).applyQuaternion(q);
    const left = _p.copy(X).applyQuaternion(q);

    // ---------------------------------------------------------------- input
    let pitchIn = 0, yawIn = 0, rollIn = 0, vert = 0, boost = false;
    if (input) {
      const lk = input.look || { x: 0, y: 0 };
      this.stick.x = clamp(this.stick.x * Math.exp(-2.6 * dt) + lk.x * 2.4, -1, 1);
      this.stick.y = clamp(this.stick.y * Math.exp(-2.6 * dt) + lk.y * 2.4, -1, 1);
      pitchIn = this.stick.y;
      yawIn = clamp(this.stick.x + input.move.x * 0.75, -1, 1);
      rollIn = (input.down('rollRight') ? 1 : 0) - (input.down('rollLeft') ? 1 : 0);
      vert = (input.down('jump') ? 1 : 0) - (input.down('crouch') ? 1 : 0);
      boost = input.down('sprint');
      const thrIn = clamp(input.move.y + (input.throttle || 0), -1, 1);
      this.thrSet = clamp(this.thrSet + thrIn * dt * 0.55, 0, 1);
      if (thrIn || vert || boost || Math.abs(pitchIn) > 0.2) this.autoland = false;
    } else if (!this.autoland && !this.landed && this.rider == null && !this.sys.autopilot) {
      this.autoland = true;
    }
    if (this.sys.autopilot === this) ({ pitchIn, yawIn, rollIn, vert, boost } = this._autopilot(dt, up));
    if (this.autoland) { this.thrSet = 0; vert = 0; }
    this.boost += ((boost ? 1 : 0) - this.boost) * (1 - Math.exp(-3 * dt));
    this.vtol = vert;

    // ---------------------------------------------------------------- landed
    if (this.landed) {
      this.velocity.set(0, 0, 0); this.angVel.multiplyScalar(0);
      this.gearT = Math.min(1, this.gearT + dt * 0.8);
      const g = w.groundAt(this.position, _g);
      const top = Math.max(g.radius, g.water ? g.waterRadius : -Infinity);
      this.position.copy(up).multiplyScalar(top + this.model.gearHeight);
      this._levelTo(g.water ? up : _n.copy(g.normal).lerp(up, 0.5).normalize(), fwd, 1 - Math.exp(-4 * dt));
      this.throttle += (0 - this.throttle) * (1 - Math.exp(-3 * dt));
      // yaw on the pad
      if (Math.abs(yawIn) > 0.05) { _q.setFromAxisAngle(Y, -yawIn * 0.9 * dt); q.multiply(_q); }
      if (vert > 0 || this.thrSet > 0.08 || boost) {
        this.landed = false;
        this.velocity.copy(up).multiplyScalar(6);
        if (this.thrSet < 0.08) this.thrSet = 0.08;
        this.sys.engine.audio.sfx?.('takeoff');
      }
      this.speed = 0;
      return;
    }

    // ---------------------------------------------------------------- rotation
    const speed = this.velocity.length();
    this.speed = speed;
    // current bank relative to the local horizon (+ = right wing down)
    const bank = Math.atan2(left.dot(up), sUp.dot(up));
    const pitchAng = Math.asin(clamp(fwd.dot(up), -1, 1));
    const low = smooth(this.alt, 220, 40) * smooth(speed, 90, 20) * air; // landing-assist zone
    let tPitch = -pitchIn * lerp(1.5, 1.1, air);
    let tYaw = -yawIn * lerp(0.9, 0.55, air);
    let tRoll = rollIn * 2.6;
    if (rollIn) this.manualRollT = 1.2; else this.manualRollT = Math.max(0, this.manualRollT - dt);
    if (air > 0.01 && !this.manualRollT) {
      // bank-to-turn: roll toward the commanded bank, then the bank turns us
      const want = clamp(yawIn * 1.15, -1.2, 1.2) * (1 - low);
      tRoll = lerp(tRoll, clamp((want - bank) * 2.8, -2.4, 2.4), air);
      tYaw += -Math.sin(bank) * 0.55 * air * smooth(speed, 20, 90);
      // gentle pitch-to-horizon hold for hands-off stability
      if (Math.abs(pitchIn) < 0.05) tPitch += pitchAng * 0.15 * air;
    }
    if (low > 0 || this.autoland) {
      const k = Math.max(low, this.autoland ? 1 : 0);
      tRoll = lerp(tRoll, clamp(-bank * 2.5, -2, 2), k);
      if (Math.abs(pitchIn) < 0.05 || this.autoland) tPitch = lerp(tPitch, clamp(pitchAng * 2.0, -1.2, 1.2), k);
    }
    const resp = lerp(2.2, 4.5, air);
    this.angVel.x += (tPitch - this.angVel.x) * (1 - Math.exp(-resp * dt));
    this.angVel.y += (tYaw - this.angVel.y) * (1 - Math.exp(-resp * dt));
    this.angVel.z += (tRoll - this.angVel.z) * (1 - Math.exp(-resp * 1.3 * dt));
    _e.set(this.angVel.x * dt, this.angVel.y * dt, this.angVel.z * dt, 'YXZ');
    _q.setFromEuler(_e);
    q.multiply(_q).normalize();
    fwd.copy(Z).applyQuaternion(q); sUp.copy(Y).applyQuaternion(q);

    // ---------------------------------------------------------------- linear
    const gR = w.gravity * (R / r) * (R / r);
    const v = this.velocity;
    // throttle ceiling: cruise in air, rising with altitude in space
    const vAtmo = 240, vSpace = clamp(Math.max(0, this.alt) * 0.06, 400, 9000);
    const vmax = lerp(vSpace, vAtmo, air) * (1 + this.boost * lerp(2.0, 1.6, air));
    const vf = v.dot(fwd);
    const amax = lerp(260, 42, air) * (1 + this.boost * 1.2);
    const want = this.thrSet * vmax;
    const aT = clamp((want - vf) * 1.4, -amax * 0.6, amax);
    this.throttle += (clamp(aT / amax, 0, 1) * 0.8 + this.thrSet * 0.2 + this.boost * 0.4 - this.throttle) * (1 - Math.exp(-5 * dt));
    v.addScaledVector(fwd, aT * dt);
    // gravity, with antigrav lift trimming it out in the air (arcade comfort)
    v.addScaledVector(up, -gR * dt * (1 - air * 0.985));
    // VTOL / autoland descent
    if (this.autoland) {
      const h = Math.max(0, this.alt - this.model.gearHeight);
      const vDown = clamp(h * 0.35, 2.5, 120);
      const vr = v.dot(up);
      v.addScaledVector(up, (-vDown - vr) * (1 - Math.exp(-2 * dt)));
      const vt = _v3.copy(v).addScaledVector(up, -v.dot(up));
      v.addScaledVector(vt, -(1 - Math.exp(-1.2 * dt)));
    } else if (vert) {
      v.addScaledVector(sUp, vert * 26 * dt);
    }
    // aero: lift aligns velocity with the nose; quadratic drag
    if (air > 0) {
      const along = v.dot(fwd);
      const lat = _v3.copy(v).addScaledVector(fwd, -along);
      if (!this.autoland && along > 0) {
        const k = 1 - Math.exp(-this.rho * 2.6 * smooth(along, 5, 60) * dt);
        v.addScaledVector(lat, -k);
        v.addScaledVector(fwd, lat.length() * k * 0.92);
      }
      // g-load (for vortex visibility): lateral acceleration from turning
      this.gload += ((lat.length() * 0.2 + Math.abs(this.angVel.x) * speed * 0.03 + Math.abs(this.angVel.y) * speed * 0.03) - this.gload) * (1 - Math.exp(-4 * dt));
    }
    const drag = this.rho * 1.6e-4 * speed;
    v.multiplyScalar(Math.exp(-drag * dt * (this.autoland ? 3 : 1)));
    // re-entry heating ~ ρ v³ (normalized)
    const heat = this.rho * Math.pow(Math.max(0, speed - 320) / 900, 2.0) * 9;
    this.reentry += (clamp(heat, 0, 1.4) - this.reentry) * (1 - Math.exp(-3 * dt));

    this.position.addScaledVector(v, dt);

    // ---------------------------------------------------------------- ground
    const r2 = this.position.length();
    const up2 = _v.copy(this.position).multiplyScalar(1 / r2);
    const g = w.groundAt(this.position, _g);
    const top = Math.max(g.radius, g.water ? g.waterRadius : -Infinity);
    const clearance = r2 - top;
    this.gearT += ((this.alt < 70 && speed < 70) || this.autoland ? dt * 0.9 : -dt * 0.9);
    this.gearT = clamp(this.gearT, 0, 1);
    if (clearance < this.model.gearHeight) {
      const vr = v.dot(up2);
      const level = sUp.dot(up2);
      if (speed < 28 && level > 0.82 && this.gearT > 0.6) {
        this.landed = true; this.autoland = false; v.set(0, 0, 0); this.thrSet = 0;
        this.sys.engine.audio.sfx?.('land', { intensity: clamp(-vr / 10, 0, 1) });
        this.sys.shake(clamp(-vr / 12, 0.05, 0.5));
      } else {
        // scrape / bounce
        if (vr < 0) v.addScaledVector(up2, -vr * 1.4);
        v.multiplyScalar(Math.exp(-2.5 * dt));
        this.sys.shake(clamp(-vr / 20, 0.1, 1));
      }
      this.position.copy(up2).multiplyScalar(top + this.model.gearHeight);
    }
    if (clearance < 30) {
      _v3.copy(this.position);
      if (w.collide(this.position, 5.5, 3)) {
        const push = _v3.sub(this.position).negate().normalize();
        const into = v.dot(push);
        if (into < 0) v.addScaledVector(push, -into * 1.2);
        this.sys.shake(0.5);
      }
    }
  }

  /** Scripted pilot for screenshots: terrain-following cruise with a lazy bank. */
  _autopilot(dt, up) {
    const ap = this.sys.apParams || {};
    const fwd = _v3.copy(Z).applyQuaternion(this.quaternion);
    const pitchAng = Math.asin(clamp(fwd.dot(up), -1, 1));
    // clearance over whatever is below (terrain, roofs or the sea surface)
    const g = this.world.groundAt(this.position, _g);
    const clear = this.position.length() - Math.max(g.radius, g.water ? g.waterRadius : -Infinity);
    const wantClimb = clamp(((ap.alt ?? 90) - clear) / 250, -0.25, 0.25);
    this.thrSet = ap.throttle ?? 0.85;
    return { pitchIn: clamp((wantClimb - pitchAng) * 3, -0.6, 0.6), yawIn: ap.yaw ?? 0.18, rollIn: 0, vert: 0, boost: !!ap.boost };
  }

  _fx(dt, t, driven) {
    const sys = this.sys, M = this.model;
    const thr = this.landed ? (driven ? 0.06 : 0) : clamp(this.throttle, 0.25, 1);
    const sp = this.space;
    this.flames.forEach((f, i) => {
      f.set(i ? thr * 0.85 : thr, this.boost, t + i * 3.1);
      // dense air: hot orange afterburner; vacuum: blue ion plume
      if (i === 0) { f.uniforms.uCore.value.copy(this._coreA).lerp(this._coreS, sp); f.uniforms.uEdge.value.copy(this._edgeA).lerp(this._edgeS, sp); }
    });
    const cold = this.landed && !driven;
    const hotI = cold ? 0.18 : 2.5 + thr * 9 + this.boost * 12;
    M.hotMat.color.setRGB(lerp(1, 0.7, sp), lerp(1, 0.85, sp), 1).multiplyScalar(hotI);
    this.glows.forEach((g, i) => {
      g.mesh.visible = !cold;
      g.uniforms.uI.value = (0.6 + thr * 1.6 + this.boost * 2.0) * (i ? 0.8 : 1);
      if (i === 0) g.uniforms.uColor.value.setRGB(lerp(1.0, 0.45, sp), lerp(0.55, 0.65, sp), lerp(0.25, 1.0, sp));
    });
    // gear animation (rotate up into the belly)
    const gt = this.gearT;
    M.gear.visible = gt > 0.02;
    M.gear.scale.set(1, Math.max(0.05, gt), 1);
    M.gear.position.y = (1 - gt) * -0.4;
    // nav lights blink
    const blink = (Math.sin(t * 6.0) > 0.92) ? 1 : 0;
    for (const s of M.lights.strobes) s.visible = blink > 0;
    M.lights.landing[0].visible = gt > 0.5;
    // wingtip vortices: visible in dense air under g-load or at speed
    const obj = this.object3d;
    obj.updateMatrixWorld();
    const air = 1 - this.space;
    const vortexI = air * clamp((this.gload - 2) / 10, 0, 1) * smooth(this.speed, 40, 140) * (0.5 + 0.5 * this.rho);
    for (let i = 0; i < 2; i++) {
      _p.copy(M.wingtips[i]).applyMatrix4(obj.matrixWorld);
      if (this.landed) this.vortex[i].reset(); else this.vortex[i].push(_p, Math.max(vortexI, sys.forceVortex || 0));
      this.vortex[i].uniforms.uLight.value.copy(sys.ambientLight).multiplyScalar(1.6);
    }
    // engine contrail: cold, thin upper air (or always at boost in air)
    const contrailI = air * (smooth(this.alt, 1500, 5000) * smooth(this.alt, this.atmosphereHeight * 0.8, this.atmosphereHeight * 0.4) + this.boost * 0.3) * smooth(this.speed, 60, 200);
    _p.set(0, 0.06, -7).applyMatrix4(obj.matrixWorld);
    if (this.landed) this.contrail.reset(); else this.contrail.push(_p, Math.max(contrailI, sys.forceContrail || 0));
    this.contrail.uniforms.uLight.value.copy(sys.ambientLight).multiplyScalar(1.3);
    // ground effect: rooster-tail spray over water / dust over land, and a soft contact shadow
    const w = this.world;
    const g = w.groundAt(this.position, _g);
    const top = Math.max(g.radius, g.water ? g.waterRadius : -Infinity);
    const upN = _n.copy(this.position).normalize();
    const clear = this.position.length() - top;
    const sh = this.shadow;
    sh.mesh.visible = clear < 45 && !this.landed;
    if (sh.mesh.visible) {
      sh.mesh.position.copy(upN).multiplyScalar(top + 0.15);
      const fw = _v2.copy(Z).applyQuaternion(this.quaternion);
      _m.lookAt(_v3.set(0, 0, 0), _v.copy(fw).addScaledVector(upN, -fw.dot(upN)).normalize().negate(), upN);
      sh.mesh.quaternion.setFromRotationMatrix(_m);
      const k = 1 + clear * 0.08;
      sh.mesh.scale.set(9 * k, 1, 12 * k);
      sh.uniforms.uI.value = 0.55 * clamp(1 - clear / 45, 0, 1) * (g.water ? 0.6 : 1) * (0.3 + 0.7 * w.daylight);
    }
    if (!this.landed && clear < 28 && this.speed > 25) {
      const P = g.water ? sys.spray : sys.dust;
      const rate = clamp(this.speed / 120, 0, 1.6) * (1 - clear / 28) * (g.water ? 160 : 70) * sys.fxScale * (1 + this.boost);
      this._sprayAcc += rate * dt;
      const fw = _v2.copy(this.velocity).addScaledVector(upN, -this.velocity.dot(upN)).normalize();
      const lf = _v3.crossVectors(upN, fw).normalize();
      const dc = sys.dustColor;
      while (this._sprayAcc >= 1) {
        this._sprayAcc -= 1;
        const side = Math.random() < 0.5 ? -1 : 1, back = 4 + Math.random() * 8;
        _p.copy(this.position).addScaledVector(upN, -clear + 0.2).addScaledVector(fw, -back).addScaledVector(lf, side * (0.3 + Math.random() * 1.2));
        const vel = _v.copy(fw).multiplyScalar(this.speed * (0.1 + Math.random() * 0.12)).addScaledVector(lf, side * (2 + Math.random() * 5)).addScaledVector(upN, g.water ? 6 + Math.random() * 9 : 1 + Math.random() * 3);
        if (g.water) P.emit(_p, vel, 0.9 + Math.random() * 0.9, 0.5, 2.6 + Math.random() * 2, 0.9, 0.94, 0.98, 0.5, t, true);
        else P.emit(_p, vel, 1.8 + Math.random() * 1.5, 1.0, 5 + Math.random() * 4, dc.r, dc.g, dc.b, 0.3, t, false);
      }
    }
    // re-entry plasma sheath, oriented along the velocity
    const pl = this.plasma;
    pl.mesh.visible = this.reentry > 0.02;
    if (pl.mesh.visible) {
      _v.copy(this.velocity).normalize().applyQuaternion(_q2.copy(this.quaternion).invert());
      pl.mesh.quaternion.setFromUnitVectors(Z, _v);
      pl.mesh.position.copy(_v).multiplyScalar(1.5);
      pl.uniforms.uI.value = clamp(this.reentry, 0, 1.4);
      pl.uniforms.uTime.value = t;
      pl.uniforms.uTail.value = 2 + this.reentry * 3;
    }
  }

  dispose() {
    for (const f of this.flames) f.dispose();
    for (const g of this.glows) g.dispose();
    this.shadow.dispose(); this.shadow.mesh.removeFromParent();
    for (const tr of this.vortex) { tr.dispose(); tr.mesh.removeFromParent(); }
    this.contrail.dispose(); this.contrail.mesh.removeFromParent();
    this.plasma.dispose();
    this.object3d.removeFromParent();
  }
}
