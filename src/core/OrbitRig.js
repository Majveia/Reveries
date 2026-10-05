// Smooth, inertial orbit camera for the map levels (cosmos / galaxy / system).
// Feels like a heavy, well-damped cinema rig: drag to swing, wheel/pinch to
// dolly (logarithmic), right-drag / two-finger to pan, gentle idle drift.

import * as THREE from 'three';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class OrbitRig {
  constructor(camera, opts = {}) {
    this.camera = camera;
    this.target = (opts.target || new THREE.Vector3()).clone();
    this.distance = opts.distance ?? 10;
    this.minDistance = opts.minDistance ?? 0.1;
    this.maxDistance = opts.maxDistance ?? 1e6;
    this.yaw = opts.yaw ?? 0.6;
    this.pitch = opts.pitch ?? 0.35;
    this.minPitch = opts.minPitch ?? -1.45;
    this.maxPitch = opts.maxPitch ?? 1.45;
    this.autoRotate = opts.autoRotate ?? 0.015; // rad/s when idle
    this.damping = opts.damping ?? 6.0;
    this.zoomSpeed = opts.zoomSpeed ?? 0.18;
    this.panSpeed = opts.panSpeed ?? 1.0;
    this.up = (opts.up || new THREE.Vector3(0, 1, 0)).clone();
    this.enabled = true;

    this._yawV = 0; this._pitchV = 0; this._logDistTarget = Math.log(this.distance);
    this._targetGoal = this.target.clone();
    this._idle = 0;
    this._fly = null;
    this.roll = 0;
    this.apply();
  }

  /** Cinematic move of focus + distance. Returns a promise resolved on arrival. */
  flyTo(target, distance = this.distance, seconds = 2.2, opts = {}) {
    return new Promise((resolve) => {
      this._fly = {
        fromT: this.target.clone(), toT: target.clone(),
        fromD: Math.log(this.distance), toD: Math.log(THREE.MathUtils.clamp(distance, this.minDistance, this.maxDistance)),
        fromYaw: this.yaw, toYaw: opts.yaw ?? this.yaw, fromPitch: this.pitch, toPitch: opts.pitch ?? this.pitch,
        t: 0, dur: seconds, resolve,
      };
    });
  }
  get flying() { return !!this._fly; }

  setTarget(v, immediate = false) {
    this._targetGoal.copy(v);
    if (immediate) this.target.copy(v);
  }

  update(dt, input) {
    if (this._fly) {
      const f = this._fly;
      f.t = Math.min(1, f.t + dt / f.dur);
      const e = ease(f.t);
      this.target.lerpVectors(f.fromT, f.toT, e);
      this._targetGoal.copy(this.target);
      this.distance = Math.exp(f.fromD + (f.toD - f.fromD) * e);
      this._logDistTarget = Math.log(this.distance);
      this.yaw = f.fromYaw + (f.toYaw - f.fromYaw) * e;
      this.pitch = f.fromPitch + (f.toPitch - f.fromPitch) * e;
      if (f.t >= 1) { this._fly = null; f.resolve(); }
      this.apply();
      return;
    }
    if (this.enabled && input) {
      const lx = input.look.x, ly = input.look.y;
      if (lx || ly) { this._yawV = -lx / Math.max(dt, 1e-3) * 0.9; this._pitchV = -ly / Math.max(dt, 1e-3) * 0.9; this._idle = 0; }
      if (input.zoom) { this._logDistTarget += input.zoom * this.zoomSpeed; this._idle = 0; }
      if (input.pan.x || input.pan.y) {
        const k = this.distance * 0.0016 * this.panSpeed;
        _v.set(-input.pan.x * k, input.pan.y * k, 0).applyQuaternion(this.camera.quaternion);
        this._targetGoal.add(_v); this._idle = 0;
      }
      // keyboard nudges
      if (input.move.x || input.move.y) { this._yawV += -input.move.x * 1.2 * dt * 10; this._logDistTarget -= input.move.y * dt * 0.9; this._idle = 0; }
    }
    this._idle += dt;
    this._logDistTarget = THREE.MathUtils.clamp(this._logDistTarget, Math.log(this.minDistance), Math.log(this.maxDistance));
    const k = 1 - Math.exp(-this.damping * dt);
    this.yaw += this._yawV * dt;
    this.pitch = THREE.MathUtils.clamp(this.pitch + this._pitchV * dt, this.minPitch, this.maxPitch);
    const decay = Math.exp(-4.5 * dt);
    this._yawV *= decay; this._pitchV *= decay;
    if (this._idle > 2.5) this.yaw += this.autoRotate * dt * Math.min(1, (this._idle - 2.5) / 3);
    const ld = Math.log(this.distance);
    this.distance = Math.exp(ld + (this._logDistTarget - ld) * k);
    this.target.lerp(this._targetGoal, k);
    this.apply();
  }

  apply() {
    const cp = Math.cos(this.pitch);
    _v.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp).multiplyScalar(this.distance);
    // Support arbitrary up vectors (e.g. orbiting a tilted planet).
    _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.up);
    _v.applyQuaternion(_q);
    this.camera.position.copy(this.target).add(_v);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.target);
    if (this.roll) this.camera.rotateZ(this.roll);
  }
}
