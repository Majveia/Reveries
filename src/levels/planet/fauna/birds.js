// Birds — boid flocks, soaring raptors / great cranes, seabirds along coasts.
//
// • Geometry per species: body, head, beak, fanned tail and two-jointed wings
//   with a fringed primary outline (cranes add a long neck and trailing legs).
// • GPU wing flap: the wing vertices rotate about the shoulder and fold about
//   the elbow with a phase lag (aAnim = phase, flap amount, glide dihedral).
// • CPU boids (per flock, O(n²) with n ≤ 48): separation / alignment / cohesion,
//   a wandering flock goal, terrain-following altitude band and banking turns.
//   Soarers circle thermals; cranes fly in a slow V formation.
import * as THREE from 'three';
import { Random, seedFrom, hash3i, u01 } from '../../../core/Random.js';
import { TAU, clamp, smooth, lerp, rigMaterial, paint, mergeParts, blob, limb, membrane, tangentBasis, writeInstance, makeInstanced } from './common.js';

const BIRDS = {
  swift: { span: 0.62, body: 0.2, color: '#2a2a30', belly: '#5a5650', tip: '#141418', flap: 1.0, rate: 11, speed: [11, 16], tail: 'fork', neck: 0 },
  gull: { span: 1.35, body: 0.32, color: '#e8e8e4', belly: '#ffffff', tip: '#1e1e22', flap: 0.75, rate: 4.2, speed: [8, 12], tail: 'fan', neck: 0, glide: 0.6 },
  raptor: { span: 2.1, body: 0.42, color: '#4a3424', belly: '#b89a74', tip: '#1a120c', flap: 0.6, rate: 2.8, speed: [9, 13], tail: 'fan', neck: 0, glide: 0.92 },
  crane: { span: 2.3, body: 0.5, color: '#efeeea', belly: '#ffffff', tip: '#121214', flap: 0.7, rate: 2.4, speed: [10, 12], tail: 'short', neck: 0.65, legs: 0.7, crown: '#c81e1e' },
  ikran: { span: 3.4, body: 0.75, color: '#1c3a6a', belly: '#5ac8d8', tip: '#ff7a2a', flap: 0.85, rate: 2.2, speed: [13, 18], tail: 'long', neck: 0.35, glow: '#40e8ff' },
  ray: { span: 2.4, body: 0.6, color: '#f2b8a0', belly: '#fff0e0', tip: '#3fb0a6', flap: 0.5, rate: 1.6, speed: [6, 9], tail: 'long', neck: 0, glide: 0.5 },
};

const FLOCKS_FOR = {
  dune: { flock: 'swift', soar: 'raptor' }, ghibli: { flock: 'swift', soar: 'raptor', coast: 'gull' }, moebius: { flock: 'ray', soar: 'ray' },
  tarkovsky: { flock: 'swift', soar: 'raptor' }, ueda: { flock: 'swift', soar: 'raptor' }, pandora: { flock: 'ikran', soar: 'ikran', coast: 'gull' },
  bebop: { flock: 'gull', soar: 'gull', coast: 'gull' }, erdtree: { flock: 'swift', soar: 'raptor' }, wukong: { flock: 'swift', soar: 'crane', cranes: true, coast: 'crane' },
  nausicaa: { flock: 'swift', soar: 'raptor' }, glacier: { flock: 'gull', soar: 'raptor', coast: 'gull' }, interstellar: { flock: 'gull', soar: 'gull' },
};

const RIG_GLSL = /* glsl */ `
uniform vec4 uWing;   // x shoulder |x|, y elbow |x|, z flap amplitude, w fold amplitude
uniform vec2 uLegs;   // trailing legs pivot (y, z)
void rig(inout vec3 p, inout vec3 n) {
  float ph = aAnim.x, flap = aAnim.y, dihedral = aAnim.z;
  if (aRig.x > 0.5) {
    float s = p.x < 0.0 ? -1.0 : 1.0;
    vec2 v = vec2(abs(p.x), p.y);
    vec2 m = vec2(abs(n.x) * 1.0, n.y); m.x = n.x * s;
    float a1 = flap * uWing.z * sin(ph) + dihedral;
    float a2 = flap * uWing.w * sin(ph - 0.9) + dihedral * 0.4;
    if (v.x > uWing.y) { vec2 e = vec2(uWing.y, 0.0); v = e + fa_rot(v - e, a2); m = fa_rot(m, a2); }
    if (v.x > uWing.x) { vec2 sh = vec2(uWing.x, 0.0); v = sh + fa_rot(v - sh, a1); m = fa_rot(m, a1); }
    // wing sweep back on the downstroke recovery
    p.z -= flap * 0.08 * (v.x - uWing.x) * max(0.0, -sin(ph));
    p.x = s * v.x; p.y = v.y; n.x = s * m.x; n.y = m.y;
  }
  // body heave opposite to the wings
  p.y -= flap * 0.04 * uWing.y * sin(ph);
}
`;

function buildBird(B) {
  const parts = [];
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const c = new THREE.Color(B.color), be = new THREE.Color(B.belly), tip = new THREE.Color(B.tip);
  const S = B.span / 2; // half span
  const bl = B.body;
  const coat = (p, n) => { const t = smooth(-0.4, 0.4, n.y); return [lerp(be.r, c.r, t), lerp(be.g, c.g, t), lerp(be.b, c.b, t)]; };
  const glow = B.glow ? (p) => 0.6 * smooth(0.6, 1.0, Math.abs(p.x) / S) : null;
  // body
  const body = blob(bl * 0.23, bl * 0.22, bl * 0.55, (z) => 1 - 0.35 * smooth(0.1, 1, -z), 10, 8);
  parts.push(paint(body, coat, () => [0, 0, 0, 0]));
  // head + neck
  const neckL = B.neck * B.span * 0.5;
  const headP = V(0, bl * 0.06, bl * 0.5 + neckL + bl * 0.12);
  if (neckL > 0) parts.push(paint(limb(V(0, 0, bl * 0.4), headP, bl * 0.1, bl * 0.06, 6, 3), coat, () => [0, 0, 0, 0]));
  const head = blob(bl * 0.12, bl * 0.12, bl * 0.16, null, 8, 6); head.translate(headP.x, headP.y, headP.z);
  parts.push(paint(head, (p, n) => (B.crown && n.y > 0.5 ? [0.6, 0.02, 0.02] : coat(p, n)), () => [0, 0, 0, 0]));
  const beak = limb(headP, headP.clone().add(V(0, -bl * 0.03, bl * (B.neck > 0.5 ? 0.42 : 0.22))), bl * 0.04, bl * 0.006, 5, 1);
  parts.push(paint(beak, () => (B.neck > 0.5 ? [0.35, 0.3, 0.2] : [0.6, 0.45, 0.1]), () => [0, 0, 0, 0]));
  // tail
  const tl = B.tail === 'long' ? bl * 1.2 : B.tail === 'short' ? bl * 0.3 : bl * 0.55;
  const tw = B.tail === 'fork' ? bl * 0.35 : bl * 0.25;
  const tailOut = B.tail === 'fork'
    ? [[-bl * 0.06, -bl * 0.4], [bl * 0.06, -bl * 0.4], [tw, -bl * 0.4 - tl], [0, -bl * 0.4 - tl * 0.55], [-tw, -bl * 0.4 - tl]]
    : [[-bl * 0.08, -bl * 0.35], [bl * 0.08, -bl * 0.35], [tw, -bl * 0.35 - tl * 0.95], [0, -bl * 0.35 - tl], [-tw, -bl * 0.35 - tl * 0.95]];
  parts.push(paint(membrane(tailOut), (p) => { const t = smooth(0.3, 1, (-p.z - bl * 0.35) / tl); return [lerp(c.r, tip.r, t), lerp(c.g, tip.g, t), lerp(c.b, tip.b, t)]; }, () => [0, 0, 0, 0]));
  // wings: inner (shoulder→elbow) and outer hand with fringed primaries
  for (const s of [-1, 1]) {
    const sh = bl * 0.18, el = S * 0.45;
    const chord = B.span * (B.neck > 0.5 ? 0.24 : 0.2);
    const out = [];
    out.push([sh, bl * 0.18], [el, chord * 0.32], [S * 0.8, chord * 0.12], [S, -chord * 0.1]);
    // primaries fringe (trailing edge, outer → inner)
    const nf = 6;
    for (let k = 0; k < nf; k++) {
      const u = 1 - k / nf;
      const x = lerp(S * 0.55, S * 0.98, u), z = -chord * (0.35 + 0.25 * (1 - u));
      out.push([x, z], [x - S * 0.03, z + chord * 0.12]);
    }
    out.push([el * 0.9, -chord * 0.62], [sh, -chord * 0.45]);
    const g = membrane(out.map(([x, z]) => [x * s, z]), 0.0);
    // camber: lift the leading edge region slightly
    const pa = g.attributes.position;
    for (let i = 0; i < pa.count; i++) { const x = Math.abs(pa.getX(i)), z = pa.getZ(i); pa.setY(i, 0.04 * chord * Math.cos(clamp(z / chord, -1, 1) * 1.5) * (1 - x / S)); }
    parts.push(paint(g, (p) => {
      const ax = Math.abs(p.x) / S; const t = smooth(0.62, 0.9, ax) * (B.tip === B.color ? 0 : 1);
      const tb = smooth(-0.1, -0.5, p.z / chord) * smooth(0.3, 0.6, ax) * (B.neck > 0.5 ? 1 : 0.35); // dark trailing primaries
      const k = Math.max(t, tb);
      const base = [lerp(c.r, be.r, 0.15), lerp(c.g, be.g, 0.15), lerp(c.b, be.b, 0.15)];
      return [lerp(base[0], tip.r, k), lerp(base[1], tip.g, k), lerp(base[2], tip.b, k)];
    }, () => [1, 0, 0, 0], glow));
  }
  // legs trailing behind (cranes)
  if (B.legs) for (const s of [-1, 1]) {
    const a = V(s * bl * 0.06, -bl * 0.12, -bl * 0.3), b = a.clone().add(V(0, -bl * 0.05, -B.legs * B.span * 0.45));
    parts.push(paint(limb(a, b, bl * 0.025, bl * 0.018, 4, 1), () => [0.08, 0.07, 0.06], () => [0, 0, 0, 0]));
  }
  const geo = mergeParts(parts);
  geo.computeBoundingSphere();
  return geo;
}

const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _c = new THREE.Vector3(), _al = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3();
const CELL = 1400;

export class Birds {
  constructor(fauna) {
    this.fauna = fauna;
    this.world = fauna.world;
    const A = fauna.level.planet.aesthetic;
    this.cfg = FLOCKS_FOR[A] || { flock: 'swift', soar: 'raptor', coast: 'gull' };
    this.kinds = {};
    const want = new Set([this.cfg.flock, this.cfg.soar, this.cfg.coast].filter(Boolean));
    for (const id of want) {
      const B = BIRDS[id];
      const geo = buildBird(B);
      const uni = {
        uFTime: fauna.uniforms.uFTime, uGlowColor: { value: new THREE.Color(B.glow || '#000000') },
        uWing: { value: new THREE.Vector4(B.body * 0.18, B.span * 0.5 * 0.45, B.flap, B.flap * 0.7) }, uLegs: { value: new THREE.Vector2() },
      };
      const mats = rigMaterial({ roughness: 0.7, side: THREE.DoubleSide }, RIG_GLSL, uni, 'bird-' + id);
      const max = fauna.q.pick(60, 110, 170, 240);
      const { mesh, anim } = makeInstanced(geo, mats, max, { shadow: true });
      mesh.receiveShadow = false;
      fauna.root.add(mesh);
      this.kinds[id] = { B, mesh, anim, uni, max, count: 0, glowBase: new THREE.Color(B.glow || '#000000') };
    }
    this.flocks = new Map();
    this.forced = [];
    this._scanTimer = 0;
  }

  _cellFlock(ix, iy, iz) {
    const w = this.world, R = w.radius;
    const h = hash3i(ix, iy, iz, this.fauna.seed ^ 0x3b1f);
    if (u01(h) > this.fauna.density.birds) return null;
    const rng = new Random(h);
    _v.set((ix + rng.float()) * CELL, (iy + rng.float()) * CELL, (iz + rng.float()) * CELL).normalize().multiplyScalar(R);
    if (Math.floor(_v.x / CELL) !== ix || Math.floor(_v.y / CELL) !== iy || Math.floor(_v.z / CELL) !== iz) return null;
    const dir = _v.clone().normalize();
    const gh = w.heightAt(dir);
    const coast = w.hasOcean && gh < w.seaLevel + 25;
    const kind = coast && this.cfg.coast ? this.cfg.coast : (rng.float() < 0.3 ? this.cfg.soar : this.cfg.flock);
    return this._makeFlock(`${ix},${iy},${iz}`, dir, kind, rng);
  }

  _makeFlock(key, dir, kind, rng, opts = {}) {
    const w = this.world, R = w.radius;
    const B = BIRDS[kind];
    const soar = kind === this.cfg.soar && kind !== this.cfg.flock && !opts.flock;
    const cranes = kind === 'crane';
    const n = opts.count || (soar ? (cranes ? rng.int(5, 11) : rng.int(1, 3)) : (B.span > 3 ? rng.int(4, 9) : rng.int(14, B.span > 1.2 ? 22 : 44)));
    const gh = Math.max(w.heightAt(dir), w.hasOcean ? w.seaLevel : -1e9);
    const alt = opts.alt ?? (soar ? rng.range(50, 140) : rng.range(18, 70));
    const home = dir.clone().multiplyScalar(R + gh + alt);
    const [t1, t2] = tangentBasis(dir, new THREE.Vector3(), new THREE.Vector3());
    const f = { key, kind, B, soar, cranes, home, dir: dir.clone(), t1, t2, gh, alt, birds: [], goal: home.clone(), goalT: 0, rng, ground: gh, gT: 0, radius: opts.radius ?? rng.range(60, 160), ang: rng.range(0, TAU) };
    const sp = lerp(B.speed[0], B.speed[1], 0.5);
    const heading = opts.heading ?? rng.range(0, TAU);
    const hv = t1.clone().multiplyScalar(Math.cos(heading)).addScaledVector(t2, Math.sin(heading));
    const side = dir.clone().cross(hv).normalize();
    for (let i = 0; i < n; i++) {
      const b = { p: new THREE.Vector3(), v: new THREE.Vector3(), phase: rng.range(0, TAU), rate: B.rate * rng.range(0.85, 1.15), flap: 1, glideT: rng.range(0, 4), bank: 0, scale: rng.range(0.85, 1.15), ang: rng.range(0, TAU), r: f.radius * rng.range(0.6, 1.3), h: rng.range(-12, 12) };
      if (cranes) {
        const row = Math.ceil(i / 2), sgn = i % 2 ? 1 : -1;
        b.p.copy(home).addScaledVector(hv, -row * B.span * 1.1).addScaledVector(side, sgn * row * B.span * 1.25).addScaledVector(dir, row * 0.3);
        b.slot = { row, sgn };
      } else if (soar) {
        b.p.copy(home).addScaledVector(t1, Math.cos(b.ang) * b.r).addScaledVector(t2, Math.sin(b.ang) * b.r).addScaledVector(dir, b.h);
      } else {
        const sprd = opts.spread ?? 3.5 * Math.sqrt(n) * B.span;
        b.p.copy(home).addScaledVector(t1, rng.range(-1, 1) * sprd).addScaledVector(t2, rng.range(-1, 1) * sprd).addScaledVector(dir, rng.range(-0.3, 0.3) * sprd);
      }
      b.v.copy(hv).multiplyScalar(sp).addScaledVector(t1, rng.range(-1, 1)).addScaledVector(t2, rng.range(-1, 1));
      f.birds.push(b);
    }
    f.hv = hv; f.side = side;
    f.goal.copy(home).addScaledVector(hv, 200);
    return f;
  }

  spawnAt(dir, opts = {}) {
    const rng = new Random(seedFrom(this.fauna.seed, 'birds', this.forced.length));
    const kind = opts.kind || this.cfg.flock;
    const f = this._makeFlock('forced' + this.forced.length, dir.clone().normalize(), kind, rng, opts);
    this.forced.push(f); this.flocks.set(f.key, f);
    return f;
  }

  clearForced() { for (const f of this.forced) this.flocks.delete(f.key); this.forced.length = 0; }

  _scan(cam) {
    const R = this.world.radius;
    _v.copy(cam).normalize().multiplyScalar(R);
    const cx = Math.floor(_v.x / CELL), cy = Math.floor(_v.y / CELL), cz = Math.floor(_v.z / CELL);
    const keep = new Set();
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      const key = `${cx + x},${cy + y},${cz + z}`;
      if (!this.flocks.has(key)) this.flocks.set(key, this._cellFlock(cx + x, cy + y, cz + z));
      keep.add(key);
    }
    for (const k of this.flocks.keys()) if (!keep.has(k) && !k.startsWith('forced')) this.flocks.delete(k);
  }

  update(dt, cam) {
    this._scanTimer -= dt;
    if (this._scanTimer <= 0) { this._scan(cam); this._scanTimer = 1.5; }
    for (const k of Object.values(this.kinds)) k.count = 0;
    const w = this.world, R = w.radius;
    for (const f of this.flocks.values()) {
      if (!f) continue;
      if (f.home.distanceTo(cam) > 3500 && !f.key.startsWith('forced')) continue;
      this._sim(f, dt, w, R);
      this._write(f, cam);
    }
    const night = this.fauna.night;
    for (const k of Object.values(this.kinds)) {
      k.mesh.count = k.count; k.mesh.instanceMatrix.needsUpdate = true; k.anim.needsUpdate = true;
      k.uni.uGlowColor.value.copy(k.glowBase).multiplyScalar(0.05 + 1.5 * night);
    }
  }

  _sim(f, dt, w, R) {
    const B = f.B, bs = f.birds, n = bs.length;
    // ground under the flock (refreshed slowly)
    f.gT -= dt;
    if (f.gT <= 0) {
      f.gT = 0.7;
      _c.set(0, 0, 0); for (const b of bs) _c.add(b.p); _c.divideScalar(n).normalize();
      f.ground = Math.max(w.heightAt(_c), w.hasOcean ? w.seaLevel : -1e9);
    }
    // wandering goal around home
    f.goalT -= dt;
    if (f.goalT <= 0) {
      f.goalT = f.rng.range(5, 12);
      const a = f.rng.range(0, TAU), r = f.rng.range(40, 260);
      f.goal.copy(f.home).addScaledVector(f.t1, Math.cos(a) * r).addScaledVector(f.t2, Math.sin(a) * r);
    }
    const minV = B.speed[0], maxV = B.speed[1];
    if (f.cranes) {
      // V formation following a slowly curving leader
      const L = bs[0];
      L.p.addScaledVector(L.v, dt);
      _up.copy(L.p).normalize();
      const turn = Math.sin(this.fauna.time * 0.05 + f.ang) * 0.06;
      L.v.applyAxisAngle(_up, turn * dt);
      L.v.addScaledVector(_up, -L.v.dot(_up)).setLength(lerp(minV, maxV, 0.4));
      // keep altitude
      const alt = L.p.length() - (R + f.ground);
      L.p.addScaledVector(_up, clamp(f.alt - alt, -4, 4) * dt * 0.3);
      // wrap: if it strays far from home, turn back toward it
      if (L.p.distanceTo(f.home) > 1800) { _a.copy(f.home).sub(L.p); _a.addScaledVector(_up, -_a.dot(_up)).normalize(); L.v.lerp(_a.multiplyScalar(L.v.length()), dt * 0.3); }
      _f.copy(L.v).normalize(); _r.copy(_f).cross(_up).normalize();
      for (let i = 1; i < n; i++) {
        const b = bs[i], { row, sgn } = b.slot;
        _a.copy(L.p).addScaledVector(_f, -row * B.span * 1.1).addScaledVector(_r, -sgn * row * B.span * 1.3).addScaledVector(_up, Math.sin(this.fauna.time * 0.6 + i) * 0.4);
        b.v.copy(_a).sub(b.p).multiplyScalar(1.5).add(L.v);
        b.p.addScaledVector(b.v, dt);
      }
      for (const b of bs) { b.flap = 0.55 + 0.45 * Math.max(0, Math.sin(this.fauna.time * 0.25 + b.ang)); b.phase += dt * b.rate * TAU * 0.5; }
      return;
    }
    if (f.soar) {
      for (const b of bs) {
        const om = lerp(minV, maxV, 0.3) / b.r;
        b.ang += om * dt;
        _a.copy(f.home).addScaledVector(f.t1, Math.cos(b.ang) * b.r).addScaledVector(f.t2, Math.sin(b.ang) * b.r).addScaledVector(f.dir, b.h + Math.sin(b.ang * 0.5) * 8);
        _v.copy(_a).sub(b.p);
        b.v.lerp(_v.multiplyScalar(1 / Math.max(dt, 1e-3)), 0.08);
        b.v.clampLength(0, maxV);
        b.p.addScaledVector(b.v, dt);
        b.glideT -= dt;
        if (b.glideT <= 0) b.glideT = f.rng.range(3, 9);
        b.flap = b.glideT < 1.2 ? 1 : 0;
        b.phase += dt * b.rate * TAU * (b.flap > 0 ? 1 : 0.2);
        b.bank = lerp(b.bank, 0.45, dt);
      }
      return;
    }
    // boids
    for (let i = 0; i < n; i++) {
      const b = bs[i];
      _s.set(0, 0, 0); _al.set(0, 0, 0); _c.set(0, 0, 0);
      let cnt = 0;
      const sepR = B.span * 2.2, nR = B.span * 14;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const o = bs[j];
        _v.copy(b.p).sub(o.p);
        const d2 = _v.lengthSq();
        if (d2 < nR * nR) {
          cnt++; _al.add(o.v); _c.add(o.p);
          if (d2 < sepR * sepR) _s.addScaledVector(_v, (sepR * sepR - d2) / (d2 + 0.1));
        }
      }
      _a.set(0, 0, 0);
      if (cnt) {
        _al.divideScalar(cnt).sub(b.v).multiplyScalar(0.9);
        _c.divideScalar(cnt).sub(b.p).multiplyScalar(0.35);
        _a.add(_al).add(_c);
      }
      _a.addScaledVector(_s, 1.6);
      // goal
      _v.copy(f.goal).sub(b.p); const gd = _v.length();
      _a.addScaledVector(_v, Math.min(0.9, gd * 0.01) / Math.max(gd, 1) * 6);
      // altitude band above terrain (flock-level ground estimate)
      _up.copy(b.p).normalize();
      const alt = b.p.length() - (R + f.ground);
      const want = f.alt + Math.sin(this.fauna.time * 0.21 + i) * 6;
      _a.addScaledVector(_up, clamp(want - alt, -10, 10) * 0.6 - b.v.dot(_up) * 0.6);
      // wander
      _a.x += Math.sin(this.fauna.time * 1.3 + i * 7.1) * 1.5; _a.z += Math.cos(this.fauna.time * 1.1 + i * 3.3) * 1.5;
      _a.clampLength(0, 18);
      b.v.addScaledVector(_a, dt);
      const sp = b.v.length();
      if (sp > maxV) b.v.multiplyScalar(maxV / sp); else if (sp < minV) b.v.multiplyScalar(minV / Math.max(sp, 1e-3));
      b.p.addScaledVector(b.v, dt);
      // bank into the turn
      _f.copy(b.v).normalize(); _r.copy(_f).cross(_up);
      b.bank = lerp(b.bank, clamp(-_a.dot(_r) * 0.07, -0.9, 0.9), 1 - Math.exp(-dt * 4));
      // flap vs glide bursts
      b.glideT -= dt;
      if (b.glideT <= 0) b.glideT = f.rng.range(1.5, 5);
      const glideFrac = B.glide ?? 0.25;
      const wantFlap = (b.glideT % 3) / 3 > glideFrac || _a.dot(_up) > 3 ? 1 : 0;
      b.flap = lerp(b.flap, wantFlap, 1 - Math.exp(-dt * 5));
      b.phase += dt * b.rate * TAU * (0.25 + 0.75 * b.flap);
    }
  }

  _write(f, cam) {
    const k = this.kinds[f.kind]; if (!k) return;
    const arr = k.mesh.instanceMatrix.array, an = k.anim.array, anchor = this.fauna.anchor;
    for (const b of f.birds) {
      if (k.count >= k.max) return;
      if (b.p.distanceToSquared(cam) > 3000 * 3000) continue;
      _up.copy(b.p).normalize();
      _f.copy(b.v).normalize();
      _r.copy(_f).cross(_up).normalize();
      _up.addScaledVector(_r, Math.tan(b.bank * (f.soar ? -1 : 1)) * 0.9).normalize();
      // pitch the body with the climb rate
      const i = k.count++;
      writeInstance(arr, i, b.p, anchor, _f, _up, b.scale);
      an[i * 4] = b.phase; an[i * 4 + 1] = b.flap; an[i * 4 + 2] = (1 - b.flap) * 0.12; an[i * 4 + 3] = 0;
    }
  }

  dispose() { for (const k of Object.values(this.kinds)) { k.mesh.removeFromParent(); k.mesh.geometry.dispose(); k.mesh.material.dispose(); k.mesh.customDepthMaterial.dispose(); } }
}

export function birdsFor(aesthetic, fauna) { return fauna.includes('birds') || fauna.includes('cranes') || fauna.includes('insects'); }
