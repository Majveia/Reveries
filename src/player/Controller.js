// Character controller on a spherical planet.
//
// Gravity points to the planet centre (world.gravity). The controller keeps a
// tangent-plane velocity + a vertical speed, snaps to the ground through
// world.groundAt (terrain, water and walkable collider tops — step-up comes for
// free), slides on slopes steeper than the limit (or on sand), pushes out of
// world colliders, swims in deep water, and offers coyote time, jump buffering,
// air control, a jetpack hover (hold jump while airborne) that hands over to a
// glide when the fuel runs out.
//
// Speeds: walk 3 · run 6 · sprint 11 m/s; analog sticks are proportional, a
// touch stick held at full deflection auto-sprints.

import * as THREE from 'three';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

export const SPEED = { walk: 3, run: 6, sprint: 11, swim: 2.6, swimFast: 4.2, glide: 9.5 };

export class Controller {
  constructor(world) {
    this.world = world;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3(); // tangent velocity (world)
    this.vUp = 0; // vertical speed along local up
    this.up = new THREE.Vector3(0, 1, 0);
    this.facing = new THREE.Vector3(0, 0, 1);
    this.left = new THREE.Vector3(1, 0, 0);
    this.grounded = false;
    this.state = 'air'; // 'ground' | 'air' | 'jet' | 'glide' | 'swim' | 'slide'
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.fuel = 1;
    this.airTime = 0;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundRadius = 0;
    this.waterRadius = -Infinity;
    this.turnRate = 0;
    this.accelLocal = { x: 0, z: 0 };
    this.speed = 0;
    this.sprintHold = 0;
    this.slopeLimit = THREE.MathUtils.degToRad(46);
    this.sand = false;
    this.events = [];
    this._prevVel = new THREE.Vector3();
    this._g = {};
    this.jumpHeight = 1.3;
    this.radius = 0.32;
    this.height = 1.8;
    this.frozen = false;
  }

  /** Place the character on the ground at a world direction (or position). */
  place(pos, facingHint) {
    const dir = _v.copy(pos).normalize();
    const g = this.world.groundAt(_v2.copy(dir).multiplyScalar(this.world.surfaceRadius(dir) + 0.5), this._g);
    const r = Math.max(g.radius, g.water ? g.waterRadius - 1.35 : -Infinity);
    this.pos.copy(dir).multiplyScalar(r);
    this.world.collide(this.pos, this.radius, this.height);
    this.up.copy(this.pos).normalize();
    this.vel.set(0, 0, 0); this.vUp = 0;
    if (facingHint) this.setFacing(facingHint);
    this.grounded = !g.water || g.waterDepth < 1.2;
    this.state = this.grounded ? 'ground' : 'swim';
    this.groundRadius = g.radius;
  }

  setFacing(dirHint) {
    this.up.copy(this.pos).normalize();
    this.facing.copy(dirHint).addScaledVector(this.up, -dirHint.dot(this.up));
    if (this.facing.lengthSq() < 1e-8) this.facing.set(1, 0, 0).addScaledVector(this.up, -this.up.x);
    this.facing.normalize();
    this.left.crossVectors(this.up, this.facing).normalize();
  }

  /**
   * input: { mx, my (camera relative stick), sprint, walk, jumpPressed, jumpHeld, analog, touchFull }
   * camFwd / camRight: tangent unit vectors of the camera heading.
   */
  update(dt, inp, camFwd, camRight) {
    this.events.length = 0;
    if (this.frozen) { this.speed = this.vel.length(); return; }
    const w = this.world;
    const up = this.up.copy(this.pos).normalize();
    // keep vectors in the current tangent plane (we move on a sphere)
    this.vel.addScaledVector(up, -this.vel.dot(up));
    this.setFacing(this.facing);
    this._prevVel.copy(this.vel);

    // ---- intent ------------------------------------------------------------------
    const mag = Math.min(1, Math.hypot(inp.mx, inp.my));
    const want = _v.set(0, 0, 0);
    if (mag > 0.02) want.copy(camFwd).multiplyScalar(inp.my).addScaledVector(camRight, inp.mx).normalize();
    let target;
    if (inp.analog) {
      target = mag < 0.6 ? (mag / 0.6) * SPEED.walk : SPEED.walk + ((mag - 0.6) / 0.36) * (SPEED.run - SPEED.walk);
      target = Math.min(target, SPEED.run);
      this.sprintHold = inp.touchFull && mag > 0.96 ? this.sprintHold + dt : 0;
    } else {
      target = mag > 0.02 ? (inp.walk ? SPEED.walk : SPEED.run) : 0;
      this.sprintHold = 0;
    }
    const sprinting = mag > 0.3 && (inp.sprint || this.sprintHold > 0.45);
    if (sprinting) target = SPEED.sprint;
    this.sprinting = sprinting;

    // ---- jump buffer / coyote ------------------------------------------------------
    if (inp.jumpPressed) this.jumpBuffer = 0.15;
    else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.coyote = this.grounded ? 0.14 : Math.max(0, this.coyote - dt);

    const g = w.gravity;
    const st = this.state;
    const swimming = st === 'swim';
    if (swimming) target = mag > 0.02 ? (sprinting ? SPEED.swimFast : SPEED.swim * Math.max(0.4, mag)) : 0;

    // ---- horizontal dynamics ---------------------------------------------------------
    const desired = _v2.copy(want).multiplyScalar(target);
    if (this.grounded && st !== 'slide') {
      const cur = this.vel.length();
      const reversing = cur > 4 && desired.lengthSq() > 0 && desired.dot(this.vel) < -0.2 * cur * target;
      const k = reversing ? 5 : target > cur ? (sprinting ? 5.5 : 9) : 11;
      this.vel.lerp(desired, 1 - Math.exp(-k * dt));
    } else if (swimming) {
      this.vel.lerp(desired, 1 - Math.exp(-2.2 * dt));
    } else if (st === 'glide') {
      // glide: steer the heading, keep forward speed, gentle descent
      const sp = Math.max(this.vel.length(), SPEED.glide);
      const head = _v3.copy(this.vel.lengthSq() > 0.01 ? this.vel : this.facing).normalize();
      if (mag > 0.02) head.lerp(want, 1 - Math.exp(-1.8 * dt)).normalize();
      this.vel.copy(head).multiplyScalar(THREE.MathUtils.lerp(sp, SPEED.glide + (sprinting ? 3 : 0), 1 - Math.exp(-0.6 * dt)));
    } else if (st === 'slide') {
      // limited steering while sliding
      this.vel.addScaledVector(want, target * 0.9 * dt);
    } else {
      // air control: steer toward the stick without bleeding momentum
      if (mag > 0.02) {
        const keep = Math.max(this.vel.length(), target * 0.85);
        desired.setLength(keep);
        this.vel.lerp(desired, 1 - Math.exp(-(st === 'jet' ? 2.6 : 1.7) * dt));
      }
    }

    // ---- vertical dynamics -----------------------------------------------------------
    let jumped = false;
    if (this.jumpBuffer > 0 && (this.grounded || this.coyote > 0 || (swimming && this._atSurface))) {
      // apex height stays game-friendly across worlds (a little lower on heavy planets, floatier on light ones)
      const h = (swimming ? 0.7 : this.jumpHeight * (sprinting ? 1.1 : 1)) * clamp(Math.pow(9.81 / g, 0.35), 0.75, 1.6);
      this.vUp = Math.sqrt(2 * g * h);
      this.grounded = false; this.coyote = 0; this.jumpBuffer = 0;
      this.state = 'air'; this.airTime = 0;
      jumped = true;
      this.events.push({ type: 'jump' });
    }
    if (!this.grounded && !swimming) {
      this.airTime += dt;
      const canHover = inp.jumpHeld && !jumped && this.airTime > 0.22 && this.vUp < 2.5;
      if (canHover && this.fuel > 0.01) {
        this.state = 'jet';
        this.fuel = Math.max(0, this.fuel - dt / 1.9);
        this.vUp += (2.2 - this.vUp) * (1 - Math.exp(-4 * dt)) + 0 * dt;
      } else if (canHover || (inp.jumpHeld && this.state === 'glide')) {
        this.state = 'glide';
        this.vUp -= g * dt * 0.35;
        this.vUp = Math.max(this.vUp, -2.4);
        this.vUp += (-2.0 - this.vUp) * (1 - Math.exp(-3 * dt));
      } else {
        this.state = 'air';
        this.vUp -= g * dt;
        this.vUp = Math.max(this.vUp, -55);
      }
    }

    // ---- integrate ------------------------------------------------------------------
    const prevUp = this.vUp;
    this.pos.addScaledVector(this.vel, dt).addScaledVector(up, this.vUp * dt);

    // colliders (buildings, trees, rocks…)
    _v3.copy(this.pos);
    if (w.collide(this.pos, this.radius, this.height)) {
      const push = _v3.subVectors(this.pos, _v3);
      push.addScaledVector(up, -push.dot(up));
      if (push.lengthSq() > 1e-10) {
        push.normalize();
        const into = this.vel.dot(push);
        if (into < 0) this.vel.addScaledVector(push, -into);
      }
    }

    // ---- ground / water -------------------------------------------------------------
    const gq = w.groundAt(this.pos, this._g);
    const r = this.pos.length();
    this.groundRadius = gq.radius;
    this.groundNormal.copy(gq.normal);
    this.waterRadius = gq.water ? gq.waterRadius : -Infinity;
    const nUp = this.groundNormal.dot(_v.copy(this.pos).normalize());
    const slope = Math.acos(clamp(nUp, -1, 1));
    const biome = this._biome(gq);
    this.sand = biome;
    const limit = this.sand ? THREE.MathUtils.degToRad(31) : this.slopeLimit;
    const swimLine = gq.water ? gq.waterRadius - 1.32 : -Infinity;

    if (gq.water && gq.waterDepth > 1.32 && r < swimLine + 0.25) {
      // ---- swimming: buoyancy holds the chest at the surface
      if (this.state !== 'swim') this.events.push({ type: 'splash', impact: -prevUp });
      this.state = 'swim';
      this.grounded = false;
      this.fuel = Math.min(1, this.fuel + dt * 0.5);
      const err = swimLine - r;
      this.vUp += (err * 14 - this.vUp * 4.5) * dt;
      if (r < gq.radius + 0.05) { this.pos.setLength(gq.radius + 0.05); }
      this._atSurface = Math.abs(err) < 0.35;
    } else {
      this._atSurface = false;
      if (this.state === 'swim') this.state = 'air';
      const snap = this.grounded && this.vUp <= 0.5 ? 0.35 : 0.0;
      if (r <= gq.radius + snap && this.vUp <= 0.5) {
        if (!this.grounded) {
          this.events.push({ type: 'land', impact: -prevUp, speed: this.vel.length() });
        }
        this.pos.setLength(gq.radius);
        this.vUp = 0;
        this.grounded = true;
        this.airTime = 0;
        this.fuel = Math.min(1, this.fuel + dt * 0.7);
        // slopes
        if (slope > limit) {
          this.state = 'slide';
          const down = _v.copy(this.groundNormal).addScaledVector(up, -nUp);
          if (down.lengthSq() > 1e-8) {
            down.normalize();
            this.vel.addScaledVector(down, g * Math.sin(slope) * dt * (this.sand ? 0.9 : 1.1));
            const sp = this.vel.length(), maxS = this.sand ? 9 : 14;
            if (sp > maxS) this.vel.multiplyScalar(maxS / sp);
          }
        } else {
          if (this.state === 'slide' && this.vel.length() > 2.5 && slope > limit * 0.75) {
            // keep surfing a little while the slope eases
            this.vel.multiplyScalar(Math.exp(-1.5 * dt));
          } else this.state = 'ground';
          // walking uphill into a too-steep face: cancel the uphill component
          const ahead = _v.copy(this.pos).addScaledVector(this.vel, 0.25);
          const ga = w.groundAt(ahead, this._g2 || (this._g2 = {}));
          const rise = ga.radius - gq.radius;
          if (rise > 0.45 && rise / Math.max(0.05, this.vel.length() * 0.25) > Math.tan(limit)) {
            const hdir = _v2.copy(this.vel).normalize();
            const into = this.vel.dot(hdir);
            if (into > 0) this.vel.addScaledVector(hdir, -into * 0.85);
          }
        }
      } else if (this.grounded) {
        this.grounded = false;
        this.state = 'air';
        this.airTime = 0;
      }
    }

    // ---- facing -----------------------------------------------------------------------
    this.up.copy(this.pos).normalize();
    const sp = this.vel.length();
    this.speed = sp;
    let turn = 0;
    const steerDir = this.state === 'slide' ? null : (sp > 0.35 ? this.vel : (mag > 0.02 && this.grounded ? want : null));
    if (steerDir) {
      const tgt = _v.copy(steerDir).addScaledVector(this.up, -steerDir.dot(this.up)).normalize();
      const ang = Math.atan2(_v2.crossVectors(this.facing, tgt).dot(this.up), this.facing.dot(tgt));
      const maxRate = (this.state === 'glide' ? 3.2 : this.grounded ? THREE.MathUtils.lerp(13, 5.5, clamp((sp - 3) / 8, 0, 1)) : 5) * dt;
      turn = clamp(ang, -maxRate, maxRate);
      this.facing.applyAxisAngle(this.up, turn);
    }
    this.turnRate = THREE.MathUtils.lerp(this.turnRate, turn / Math.max(dt, 1e-4), 1 - Math.exp(-10 * dt));
    this.setFacing(this.facing);
    // local acceleration for the animation layer
    const ax = (this.vel.x - this._prevVel.x) / Math.max(dt, 1e-4), ay = (this.vel.y - this._prevVel.y) / Math.max(dt, 1e-4), az = (this.vel.z - this._prevVel.z) / Math.max(dt, 1e-4);
    const a = _v.set(ax, ay, az);
    this.accelLocal.z = THREE.MathUtils.lerp(this.accelLocal.z, a.dot(this.facing), 1 - Math.exp(-12 * dt));
    this.accelLocal.x = THREE.MathUtils.lerp(this.accelLocal.x, a.dot(this.left), 1 - Math.exp(-12 * dt));
  }

  _biome(gq) {
    // Sand detection: desert-styled worlds / dry sandy biomes slide earlier.
    const s = this.world.terrainParams?.style || this.world.aesthetic?.terrain?.style || '';
    return /dune|desert|sand/i.test(String(s));
  }
}
