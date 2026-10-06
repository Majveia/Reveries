// Third/first-person camera on a spherical world.
//
// Third person: a spring arm over the right shoulder. The pivot follows the
// character through a critically damped spring (softer vertically so steps and
// landings don't jolt the frame), the heading gently recentres behind the
// direction of travel when the player isn't steering the camera, the arm
// shortens against terrain (world.raycast) and colliders and eases back out,
// FOV kicks on sprint / glide, a short damped shake on hard landings, zoom with
// wheel / pinch. First person: the eye rides the animated head (bob attenuated).
// Vehicles: chase camera from the vehicle's cameraProfile.
// level.freeCam always wins (screenshot / debug): the rig then never moves the camera.

import * as THREE from 'three';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _probe = new THREE.Vector3();

export class CameraRig {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.heading = new THREE.Vector3(0, 0, 1); // tangent unit vector (camera yaw)
    this.pitch = -0.12; // radians, + looks up
    this.distance = 3.6; // user zoom target
    this.minDist = 1.4; this.maxDist = 10;
    this.curDist = 3.6;
    this.shoulder = 0.38;
    this.pivotHeight = 1.52;
    this.view = 'third'; // 'third' | 'first'
    this.pivot = new THREE.Vector3();
    this.pivotVel = new THREE.Vector3();
    this.smoothPivot = new THREE.Vector3();
    this.fov = 58;
    this.baseFov = 58;
    this.idleLook = 0; // seconds since last manual look
    this.shake = 0;
    this.shakeT = 0;
    this.initialized = false;
    this.eye = new THREE.Vector3();
    this.eyeSmooth = new THREE.Vector3();
    this.position = new THREE.Vector3();
    this.lookDir = new THREE.Vector3(0, 0, 1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);
    this.recenterRate = 0.7;
  }

  /** Snap behind a facing direction (spawn, shots). */
  snap(pivotPos, up, facing, pitch = -0.12) {
    this.up.copy(up);
    this.heading.copy(facing).addScaledVector(up, -facing.dot(up)).normalize();
    this.pitch = pitch;
    this.smoothPivot.copy(pivotPos);
    this.pivotVel.set(0, 0, 0);
    this.curDist = this.distance;
    this.initialized = true;
  }

  addShake(a) { this.shake = Math.min(1.2, this.shake + a); this.shakeT = 0; }

  /** Rotate heading/pitch from input (look.x right, look.y up). */
  look(lx, ly, dt) {
    if (lx || ly) this.idleLook = 0; else this.idleLook += dt;
    if (lx) this.heading.applyAxisAngle(this.up, -lx);
    if (ly) this.pitch = clamp(this.pitch + ly, this.view === 'first' ? -1.35 : -1.2, this.view === 'first' ? 1.35 : 0.95);
  }

  /** Transport the heading into the tangent plane of a new up. */
  _transport(up) {
    this.up.copy(up);
    this.heading.addScaledVector(up, -this.heading.dot(up));
    if (this.heading.lengthSq() < 1e-8) this.heading.set(1, 0, 0).addScaledVector(up, -up.x);
    this.heading.normalize();
    this.right.crossVectors(this.heading, up).normalize();
  }

  /** Camera-relative movement basis (tangent plane). */
  basis(outFwd, outRight) { outFwd.copy(this.heading); outRight.copy(this.right); }

  /**
   * p: { pos (feet), up, vel, speed, sprint (0..1), glide (0..1), facing, grounded, eye (Vector3 world, head),
   *      zoom, dt, freeze (bool) }
   */
  update(p) {
    const dt = p.dt;
    this._transport(p.up);
    const up = this.up;
    // zoom
    if (p.zoom) this.distance = clamp(this.distance * Math.exp(p.zoom * 0.14), this.minDist, this.maxDist);

    // gentle auto-recenter behind the direction of travel
    if (this.view === 'third' && !p.freeze && p.speed > 1.2 && this.idleLook > 1.1 && p.recenter !== false) {
      const mv = _v.copy(p.vel).addScaledVector(up, -p.vel.dot(up));
      if (mv.lengthSq() > 0.5) {
        mv.normalize();
        const ang = Math.atan2(_v2.crossVectors(this.heading, mv).dot(up), this.heading.dot(mv));
        if (Math.abs(ang) < 2.2) {
          const rate = this.recenterRate * clamp(p.speed / 6, 0.2, 1.6) * Math.min(1, (this.idleLook - 1.1) * 0.8);
          this.heading.applyAxisAngle(up, ang * (1 - Math.exp(-rate * dt)));
          this.right.crossVectors(this.heading, up).normalize();
        }
        this.pitch += (-0.1 - this.pitch) * (1 - Math.exp(-0.5 * dt * Math.min(1, this.idleLook - 1.1)));
      }
    }

    const cam = this.camera;
    // look direction
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const dir = this.lookDir.copy(this.heading).multiplyScalar(cp).addScaledVector(up, sp).normalize();

    // FOV
    // portrait screens (phones): widen the vertical FOV so the horizontal view stays usable
    const portrait = clamp((1.25 - cam.aspect) / 0.8, 0, 1);
    const fovT = (this.view === 'first' ? 72 : this.baseFov + 9 * (p.sprint || 0) + 13 * (p.glide || 0) + (p.fovAdd || 0)) + portrait * 16;
    this.fov += (fovT - this.fov) * (p.freeze ? 1 : 1 - Math.exp(-3.5 * dt));

    // shake
    this.shakeT += dt;
    this.shake *= Math.exp(-5.5 * dt);
    const sh = this.shake;
    const shakeY = sh * 0.06 * Math.sin(this.shakeT * 38) ;
    const shakeX = sh * 0.025 * Math.sin(this.shakeT * 27 + 1.3);

    if (this.view === 'first') {
      // eye on the animated head; attenuate the bob (subtle, never nauseating)
      // (re)seed on first use, after a teleport / snap, and whenever posed for a shot
      if (!this.initialized || p.freeze || this.eyeSmooth.distanceToSquared(p.eye) > 4) { this.eyeSmooth.copy(p.eye); this.initialized = true; }
      const rel = _v.copy(p.eye).sub(this.eyeSmooth);
      // follow the horizontal motion tightly, the vertical bob softly
      const vert = rel.dot(up);
      rel.addScaledVector(up, -vert);
      this.eyeSmooth.add(rel).addScaledVector(up, vert * (1 - Math.exp(-14 * dt)));
      this.position.copy(this.eyeSmooth).addScaledVector(dir, 0.12).addScaledVector(up, shakeY);
      cam.near = 0.05;
    } else {
      // pivot: shoulder point with spring lag
      const pivot = this.pivot.copy(p.pos).addScaledVector(up, this.pivotHeight + portrait * 0.15).addScaledVector(this.right, this.shoulder * (1 - portrait * 0.8) * (this.curDist / 3.6) ** 0.5);
      if (!this.initialized || this.smoothPivot.distanceToSquared(pivot) > 400) { this.smoothPivot.copy(pivot); this.pivotVel.set(0, 0, 0); this.initialized = true; }
      if (p.freeze) { this.smoothPivot.copy(pivot); this.pivotVel.set(0, 0, 0); }
      else {
        // critically damped spring, stiffer horizontally than vertically
        const err = _v.copy(pivot).sub(this.smoothPivot);
        const ev = err.dot(up);
        const eh = _v2.copy(err).addScaledVector(up, -ev);
        const wH = 13, wV = 7.5;
        const vv = this.pivotVel.dot(up);
        const vh = _v3.copy(this.pivotVel).addScaledVector(up, -vv);
        vh.addScaledVector(eh, wH * wH * dt).addScaledVector(vh, -2 * wH * dt);
        const nvv = vv + (ev * wV * wV - 2 * wV * vv) * dt;
        this.pivotVel.copy(vh).addScaledVector(up, nvv);
        this.smoothPivot.addScaledVector(this.pivotVel, dt);
        // never lag too far (fast vehicles / falls)
        const lag = _v.copy(this.smoothPivot).sub(pivot);
        const maxLag = 0.9;
        if (lag.lengthSq() > maxLag * maxLag) this.smoothPivot.copy(pivot).addScaledVector(lag.normalize(), maxLag);
      }
      const S = this.smoothPivot;
      // collision: terrain ray + collider probes
      let want = this.distance * (1 + portrait * 0.25);
      const back = _v4.copy(dir).negate();
      const hit = this.world.raycast(S, back, want + 0.35);
      if (hit) want = Math.min(want, Math.max(0.6, hit.distance - 0.35));
      for (let k = 1; k <= 5; k++) {
        const t = (k / 5) * want;
        _probe.copy(S).addScaledVector(back, t).addScaledVector(up, -0.15);
        const before = _v3.copy(_probe);
        if (this.world.collide(_probe, 0.22, 0.3) && before.distanceToSquared(_probe) > 1e-6) { want = Math.max(0.6, ((k - 1) / 5) * want); break; }
      }
      // in quickly, out slowly
      const rate = want < this.curDist ? 18 : 2.2;
      this.curDist += (want - this.curDist) * (1 - Math.exp(-rate * (p.freeze ? 100 : dt)));
      this.position.copy(S).addScaledVector(back, this.curDist);
      // keep above the ground / water
      const g = this.world.groundAt(this.position, this._g || (this._g = {}));
      const minR = Math.max(g.radius, g.water ? g.waterRadius : -Infinity) + 0.3;
      const r = this.position.length();
      if (r < minR) this.position.setLength(minR);
      this.position.addScaledVector(up, shakeY).addScaledVector(this.right, shakeX);
      cam.near = 0.05;
    }
    cam.position.copy(this.position);
    cam.up.copy(up);
    _v.copy(this.position).add(dir);
    if (this.view === 'third') _v.addScaledVector(up, shakeY * 0.5);
    cam.lookAt(_v);
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }

  /** Chase camera for vehicles. v: vehicle, prof: cameraProfile. */
  updateVehicle(v, prof, dt, up, zoom) {
    this._transport(up);
    const cam = this.camera;
    const dist = (prof?.distance ?? 8) * (this.vehZoom ?? 1);
    if (zoom) this.vehZoom = clamp((this.vehZoom ?? 1) * Math.exp(zoom * 0.14), 0.5, 3);
    const height = prof?.height ?? 2.5;
    const lag = prof?.lag ?? 6;
    // forward from the vehicle's orientation (+Z local), fall back to velocity
    const fwd = _v.set(0, 0, 1).applyQuaternion(v.quaternion || v.object3d.quaternion);
    if (v.velocity && v.velocity.lengthSq() > 4) fwd.lerp(_v2.copy(v.velocity).normalize(), 0.3);
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() > 1e-6) {
      fwd.normalize();
      if (this.idleLook > 1.2) {
        const ang = Math.atan2(_v2.crossVectors(this.heading, fwd).dot(up), this.heading.dot(fwd));
        this.heading.applyAxisAngle(up, ang * (1 - Math.exp(-lag * 0.5 * dt)));
      }
    }
    this.right.crossVectors(this.heading, up).normalize();
    const pitch = this.pitch;
    const dir = this.lookDir.copy(this.heading).multiplyScalar(Math.cos(pitch)).addScaledVector(up, Math.sin(pitch)).normalize();
    const target = _v3.copy(v.position || v.object3d.position).addScaledVector(up, height * 0.5);
    if (!this.initialized || this.smoothPivot.distanceToSquared(target) > 2500) { this.smoothPivot.copy(target); this.initialized = true; }
    this.smoothPivot.lerp(target, 1 - Math.exp(-lag * dt));
    this.position.copy(this.smoothPivot).addScaledVector(dir, -dist).addScaledVector(up, height * 0.5);
    const g = this.world.groundAt(this.position, this._g || (this._g = {}));
    const minR = Math.max(g.radius, g.water ? g.waterRadius : -Infinity) + 0.5;
    if (this.position.length() < minR) this.position.setLength(minR);
    const fovT = prof?.fov ?? 62;
    this.fov += (fovT + (v.velocity ? Math.min(14, v.velocity.length() * 0.05) : 0) - this.fov) * (1 - Math.exp(-3 * dt));
    cam.position.copy(this.position);
    cam.up.copy(up);
    cam.lookAt(_v.copy(this.smoothPivot).addScaledVector(dir, 4));
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }
}
