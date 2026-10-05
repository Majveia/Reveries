// World: the physical truth of a planet that every subsystem agrees on.
// Planet is centred at the origin, units are meters, +Y is the rotation axis.
// The planet does not rotate; instead the sun direction orbits it (cheaper,
// and every world position stays fixed — great for physics and caching).
//
// Key API (stable):
//   world.radius, world.seaLevel (m above base radius, or -Infinity), world.gravity (m/s²)
//   world.heightAt(dir)                 terrain height (m) for a unit direction
//   world.sample(dir)                   { h, moisture, temp, rock, biome }
//   world.groundAt(pos, out?)           { height, radius, point, normal, water, waterDepth, colliderTop }
//   world.normalAt(dir)                 surface normal (finite differences)
//   world.up(pos, out?)                 local up
//   world.frame(pos, forwardHint)       { up, forward, right } tangent frame
//   world.altitude(pos)                 height above ground/water
//   world.raycast(origin, dir, max)     { point, distance, normal } | null  (terrain only)
//   world.addCollider(c) / removeCollider(c) / collide(pos, radius, height)
//   world.addPOI(poi) / nearestPOI(pos, maxDist)
//   world.sites                         settlement sites [{ dir, position, radius, kind, name, flat }]
//   world.sunDir (Vector3), world.timeOfDay (0..1 at the focus point), world.setTimeOfDay(t, atDir)
//   world.daylight (0..1 at focus), world.wind (Vector3), world.uniforms (shared shader uniforms)

import * as THREE from 'three';
import { createTerrain, terrainParams } from './terrain/TerrainHeight.js';
import { Random, seedFrom } from '../../core/Random.js';
import { makeName } from '../../universe/Names.js';
import { AESTHETICS } from '../../universe/Aesthetics.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4();

export class World {
  constructor(planet, level) {
    this.planet = planet;
    this.level = level;
    this.aesthetic = planet.aesthetic ? AESTHETICS[planet.aesthetic] : null;
    this.palette = this.aesthetic?.palette || null;
    this.radius = planet.world.radius;
    this.terrainParams = terrainParams({ ...planet, styleTerrain: this.aesthetic?.terrain?.style });
    this.terrain = createTerrain(this.terrainParams);
    this.gravity = 9.81 * THREE.MathUtils.clamp(planet.gravityG, 0.35, 1.8);
    this.atmosphereHeight = planet.world.atmosphereHeight || 0;
    this.atmosphereRadius = this.radius + this.atmosphereHeight;

    // Sea level: choose the height percentile matching the aesthetic's ocean fraction.
    const frac = planet.world.seaLevel ?? 0.2;
    if (frac <= 0.001) this.seaLevel = -Infinity;
    else if (Number.isFinite(this.terrain.seaLevel)) this.seaLevel = this.terrain.seaLevel; // the height field designs its coasts (beaches, sea cliffs, estuaries) at this height
    else {
      const rng = new Random(seedFrom(planet.seed, 'sea'));
      const hs = [];
      for (let i = 0; i < 1600; i++) { const [x, y, z] = rng.unitVector(); hs.push(this.terrain.height(x, y, z)); }
      hs.sort((a, b) => a - b);
      this.seaLevel = hs[Math.floor(frac * (hs.length - 1))];
    }
    this.hasOcean = Number.isFinite(this.seaLevel);

    // Time & sun
    this.axis = new THREE.Vector3(0, 1, 0);
    this.dayLength = 24 * 60; // seconds of real time per planetary day (relaxed pace)
    this.dayAngle = 0; // radians; sun longitude
    this.sunElevationTilt = THREE.MathUtils.degToRad(Math.min(planet.axialTiltDeg ?? 15, 28)) * 0.6;
    this.sunDir = new THREE.Vector3(1, 0, 0);
    this.timeOfDay = 0.5;
    this.daylight = 1;
    this.focus = new THREE.Vector3(0, this.radius, 0); // where "local time" is measured (player/camera)
    this.timeScale = 1;
    this.wind = new THREE.Vector3(1, 0, 0.3).normalize();
    this.windStrength = 0.5;

    this.colliders = new Set();
    this._grid = new Map();
    this.pois = [];
    this.sites = [];

    // Shared uniforms every shader can bind (same object instances).
    this.uniforms = {
      uTime: { value: 0 },
      uSunDir: { value: this.sunDir },
      uPlanetRadius: { value: this.radius },
      uSeaLevel: { value: this.hasOcean ? this.seaLevel : -1e9 },
      uAtmoRadius: { value: this.atmosphereRadius },
      uDaylight: { value: 1 },
      uWind: { value: new THREE.Vector4(this.wind.x, this.wind.y, this.wind.z, this.windStrength) },
      uCameraPos: { value: new THREE.Vector3() },
    };
    this._computeSites();
  }

  // ---- terrain queries ------------------------------------------------------------
  heightAt(dir) { return this.terrain.height(dir.x, dir.y, dir.z); }
  sample(dir) { return this.terrain.sample(dir.x, dir.y, dir.z); }
  /** Radius of walkable surface (terrain or sea surface, whichever is higher). */
  surfaceRadius(dir) { const h = this.heightAt(dir); return this.radius + (this.hasOcean ? Math.max(h, this.seaLevel) : h); }

  normalAt(dir, out = new THREE.Vector3(), eps = 0.6) {
    // Finite differences on the sphere (eps in meters).
    const up = _a.copy(dir).normalize();
    const t1 = _b.set(0, 1, 0);
    if (Math.abs(up.y) > 0.9) t1.set(1, 0, 0);
    t1.cross(up).normalize();
    const t2 = _c.copy(up).cross(t1).normalize();
    const R = this.radius, k = eps / R;
    const h0 = this.terrain.height(up.x, up.y, up.z);
    const p1 = _d.copy(up).addScaledVector(t1, k).normalize();
    const h1 = this.terrain.height(p1.x, p1.y, p1.z);
    const p2 = _d.copy(up).addScaledVector(t2, k).normalize();
    const h2 = this.terrain.height(p2.x, p2.y, p2.z);
    // gradient in tangent plane
    out.copy(up).multiplyScalar(eps).addScaledVector(t1, -(h1 - h0)).addScaledVector(t2, -(h2 - h0));
    return out.normalize();
  }

  /** Full ground query for a world position. */
  groundAt(pos, out = {}) {
    const dir = (out._dir ||= new THREE.Vector3()).copy(pos).normalize();
    const h = this.heightAt(dir);
    const waterTop = this.hasOcean ? this.seaLevel : -Infinity;
    const colliderTop = this.colliderTopAt(pos);
    const groundH = Math.max(h, colliderTop - this.radius);
    out.height = groundH;
    out.terrainHeight = h;
    out.radius = this.radius + groundH;
    out.point = (out.point ||= new THREE.Vector3()).copy(dir).multiplyScalar(out.radius);
    out.normal = colliderTop - this.radius > h + 0.05 ? (out.normal ||= new THREE.Vector3()).copy(dir) : this.normalAt(dir, out.normal ||= new THREE.Vector3());
    out.water = waterTop > groundH;
    out.waterDepth = out.water ? waterTop - groundH : 0;
    out.waterRadius = this.radius + waterTop;
    out.colliderTop = colliderTop;
    return out;
  }

  up(pos, out = new THREE.Vector3()) { return out.copy(pos).normalize(); }

  /** Tangent frame at pos; forward is the hint projected onto the tangent plane. */
  frame(pos, forwardHint, out = { up: new THREE.Vector3(), forward: new THREE.Vector3(), right: new THREE.Vector3() }) {
    out.up.copy(pos).normalize();
    out.forward.copy(forwardHint).addScaledVector(out.up, -forwardHint.dot(out.up));
    if (out.forward.lengthSq() < 1e-8) { out.forward.set(0, 0, 1).addScaledVector(out.up, -out.up.z); }
    out.forward.normalize();
    out.right.copy(out.forward).cross(out.up).normalize();
    return out;
  }

  altitude(pos) {
    const dir = _a.copy(pos).normalize();
    return pos.length() - this.surfaceRadius(dir);
  }

  /** March a ray against the height field. Returns hit or null. */
  raycast(origin, dir, maxDist = 5000) {
    let t = 0, prevT = 0, prevD = null;
    const p = new THREE.Vector3();
    for (let i = 0; i < 200 && t <= maxDist; i++) {
      p.copy(origin).addScaledVector(dir, t);
      const d = p.length() - this.surfaceRadius(_b.copy(p).normalize());
      if (d < 0) {
        // refine by bisection
        let a = prevT, b = t;
        for (let k = 0; k < 10; k++) {
          const m = (a + b) * 0.5; p.copy(origin).addScaledVector(dir, m);
          const dm = p.length() - this.surfaceRadius(_b.copy(p).normalize());
          if (dm < 0) b = m; else a = m;
        }
        p.copy(origin).addScaledVector(dir, b);
        return { point: p.clone(), distance: b, normal: this.normalAt(_b.copy(p).normalize(), new THREE.Vector3()) };
      }
      prevT = t; prevD = d;
      t += Math.max(0.25, d * 0.6);
    }
    return null;
  }

  // ---- colliders (buildings, rocks, trees, vehicles) --------------------------------
  // c = { type: 'box', center, quaternion, half: Vector3 }
  //   | { type: 'cylinder', center (base center), up (unit), radius, height }
  //   | { type: 'sphere', center, radius }
  // Optional: c.walkable (default true for box tops / cylinder tops).
  addCollider(c) {
    c._r = c.type === 'box' ? c.half.length() : c.type === 'cylinder' ? Math.hypot(c.radius, c.height) : c.radius;
    if (c.type === 'box') { c._inv = new THREE.Quaternion().copy(c.quaternion || _q.identity()).invert(); }
    this.colliders.add(c);
    this._gridInsert(c);
    return c;
  }
  removeCollider(c) {
    this.colliders.delete(c);
    for (const k of c._cells || []) this._grid.get(k)?.delete(c);
  }
  _cellKey(x, y, z) { return `${Math.floor(x / 64)},${Math.floor(y / 64)},${Math.floor(z / 64)}`; }
  _gridInsert(c) {
    c._cells = [];
    const r = c._r, p = c.center;
    for (let x = Math.floor((p.x - r) / 64); x <= Math.floor((p.x + r) / 64); x++)
      for (let y = Math.floor((p.y - r) / 64); y <= Math.floor((p.y + r) / 64); y++)
        for (let z = Math.floor((p.z - r) / 64); z <= Math.floor((p.z + r) / 64); z++) {
          const k = `${x},${y},${z}`;
          if (!this._grid.has(k)) this._grid.set(k, new Set());
          this._grid.get(k).add(c); c._cells.push(k);
        }
  }
  _near(pos) { return this._grid.get(this._cellKey(pos.x, pos.y, pos.z)) || EMPTY; }

  /** Push a vertical capsule (feet at pos, given radius/height) out of colliders. Mutates pos. */
  collide(pos, radius = 0.4, height = 1.8) {
    let hit = false;
    const up = _c.copy(pos).normalize();
    for (const c of this._near(pos)) {
      if (c.type === 'box') {
        // local space of box
        const lp = _a.copy(pos).sub(c.center).applyQuaternion(c._inv);
        const lup = _d.copy(up).applyQuaternion(c._inv);
        const h = c.half;
        // treat capsule as a vertical segment sampled at feet / waist / head
        for (const s of [0.25, 0.9, height - 0.25]) {
          const sp = _b.copy(lp).addScaledVector(lup, s);
          const cx = THREE.MathUtils.clamp(sp.x, -h.x, h.x), cy = THREE.MathUtils.clamp(sp.y, -h.y, h.y), cz = THREE.MathUtils.clamp(sp.z, -h.z, h.z);
          const dx = sp.x - cx, dy = sp.y - cy, dz = sp.z - cz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < radius * radius) {
            let nx, ny, nz, pen;
            if (d2 > 1e-8) { const d = Math.sqrt(d2); nx = dx / d; ny = dy / d; nz = dz / d; pen = radius - d; }
            else { // inside: push along the smallest axis
              const ox = h.x - Math.abs(sp.x), oy = h.y - Math.abs(sp.y), oz = h.z - Math.abs(sp.z);
              if (ox < oy && ox < oz) { nx = Math.sign(sp.x) || 1; ny = 0; nz = 0; pen = ox + radius; }
              else if (oy < oz) { nx = 0; ny = Math.sign(sp.y) || 1; nz = 0; pen = oy + radius; }
              else { nx = 0; ny = 0; nz = Math.sign(sp.z) || 1; pen = oz + radius; }
            }
            const push = _b.set(nx, ny, nz).applyQuaternion(c.quaternion).multiplyScalar(pen);
            // remove vertical component (ground handling is done via colliderTopAt)
            push.addScaledVector(up, -push.dot(up));
            pos.add(push); lp.copy(pos).sub(c.center).applyQuaternion(c._inv); hit = true;
          }
        }
      } else if (c.type === 'cylinder') {
        const rel = _a.copy(pos).sub(c.center);
        const along = rel.dot(c.up);
        if (along > c.height || along + height < 0) continue;
        rel.addScaledVector(c.up, -along);
        const d = rel.length(), minD = c.radius + radius;
        if (d < minD && d > 1e-6) { pos.addScaledVector(rel.multiplyScalar(1 / d), minD - d); hit = true; }
      } else if (c.type === 'sphere') {
        const rel = _a.copy(pos).addScaledVector(up, height * 0.5).sub(c.center);
        const d = rel.length(), minD = c.radius + radius;
        if (d < minD && d > 1e-6) { rel.multiplyScalar(1 / d); rel.addScaledVector(up, -rel.dot(up)); pos.addScaledVector(rel, minD - d); hit = true; }
      }
    }
    return hit;
  }

  /** Highest walkable collider top (as radius from planet center) under pos, or -Infinity. */
  colliderTopAt(pos) {
    let best = -Infinity;
    const r = pos.length();
    for (const c of this._near(pos)) {
      if (c.walkable === false) continue;
      if (c.type === 'box') {
        const lp = _a.copy(pos).sub(c.center).applyQuaternion(c._inv);
        const h = c.half;
        if (Math.abs(lp.x) <= h.x && Math.abs(lp.z) <= h.z) {
          // top face along local +Y (boxes are placed with local Y = planet up)
          const topR = r + (h.y - lp.y);
          if (topR <= r + 0.6) best = Math.max(best, topR); // only if we're near/above the top (step height)
        }
      } else if (c.type === 'cylinder') {
        const rel = _a.copy(pos).sub(c.center);
        const along = rel.dot(c.up);
        rel.addScaledVector(c.up, -along);
        if (rel.length() <= c.radius && along >= c.height - 0.6) best = Math.max(best, r + (c.height - along));
      }
    }
    return best;
  }

  // ---- points of interest --------------------------------------------------------
  /** poi = { position: Vector3, radius, title, text, kind, discovered } */
  addPOI(poi) { poi.radius ??= 30; this.pois.push(poi); return poi; }
  nearestPOI(pos, maxDist = 60) {
    let best = null, bd = maxDist;
    for (const p of this.pois) { const d = p.position.distanceTo(pos); if (d < bd) { bd = d; best = p; } }
    return best;
  }

  // ---- settlements ------------------------------------------------------------------
  _computeSites() {
    const civ = this.planet.civ;
    const n = (civ?.settlements || 0);
    if (!n) return;
    const rng = new Random(seedFrom(this.planet.seed, 'sites'));
    const cands = [];
    const dir = new THREE.Vector3();
    for (let i = 0; i < 900; i++) {
      const [x, y, z] = rng.unitVector(); dir.set(x, y, z);
      if (Math.abs(y) > 0.82) continue; // avoid poles
      const h = this.heightAt(dir);
      if (this.hasOcean && h < this.seaLevel + 8) continue;
      // flatness: compare heights around
      let var2 = 0;
      const t1 = _b.set(0, 1, 0).cross(dir).normalize(), t2 = _c.copy(dir).cross(t1).normalize();
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const p = _d.copy(dir).addScaledVector(t1, Math.cos(a) * 260 / this.radius).addScaledVector(t2, Math.sin(a) * 260 / this.radius).normalize();
        const dh = this.heightAt(p) - h; var2 += dh * dh;
      }
      const flat = Math.sqrt(var2 / 8);
      const coast = this.hasOcean ? Math.max(0, 1 - (h - this.seaLevel) / 300) : 0;
      const score = -flat * 1.0 + coast * 40 - Math.max(0, h - (this.hasOcean ? this.seaLevel : 0) - this.terrainParams.relief * 0.5) * 0.05 + rng.float() * 8;
      cands.push({ dir: dir.clone(), h, flat, score });
    }
    cands.sort((a, b) => b.score - a.score);
    const lang = civ.lang || 'aether';
    const kinds = civ.level >= 5 ? ['megacity', 'city', 'city', 'town', 'spaceport'] : civ.level === 4 ? ['city', 'town', 'town', 'spaceport', 'village'] : civ.level === 3 ? ['town', 'town', 'village', 'village', 'outpost'] : civ.level === 2 ? ['village', 'village', 'outpost'] : ['ruins'];
    const minSep = 0.12; // radians
    for (const c of cands) {
      if (this.sites.length >= n) break;
      if (this.sites.some((s) => s.dir.angleTo(c.dir) < minSep)) continue;
      const kind = this.sites.length === 0 ? kinds[0] : rng.pick(kinds);
      const radius = { megacity: 1600, city: 1100, town: 600, village: 320, outpost: 220, spaceport: 700, ruins: 400 }[kind] || 400;
      this.sites.push({
        dir: c.dir, position: c.dir.clone().multiplyScalar(this.radius + c.h), height: c.h, radius, kind,
        name: makeName(rng, lang), flat: c.flat, style: this.aesthetic?.architecture || 'pastoral', index: this.sites.length,
      });
    }
    // Ancient ruins appear on most worlds with any history.
    if (civ.level >= 1 && civ.level < 5) {
      for (const c of cands.slice(Math.floor(cands.length * 0.3))) {
        if (this.sites.filter((s) => s.kind === 'ruins').length >= 2) break;
        if (this.sites.some((s) => s.dir.angleTo(c.dir) < minSep)) continue;
        if (rng.chance(0.5)) this.sites.push({ dir: c.dir, position: c.dir.clone().multiplyScalar(this.radius + c.h), height: c.h, radius: 380, kind: 'ruins', name: makeName(rng, 'void'), flat: c.flat, style: 'ruins', index: this.sites.length });
      }
    }
  }

  // ---- time of day ------------------------------------------------------------------
  /**
   * Set local time (0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset) at
   * direction atDir (defaults to the current focus point).
   */
  setTimeOfDay(t, atDir = this.focus) {
    const d = _a.copy(atDir).normalize();
    const lon = Math.atan2(d.x, d.z);
    // sun longitude so that local hour angle matches t
    this.dayAngle = lon + (t - 0.5) * Math.PI * 2;
    this._updateSun();
  }

  _updateSun() {
    const a = this.dayAngle;
    const tilt = this.sunElevationTilt;
    this.sunDir.set(Math.sin(a) * Math.cos(tilt), Math.sin(tilt), Math.cos(a) * Math.cos(tilt)).normalize();
    const up = _a.copy(this.focus).normalize();
    const elev = up.dot(this.sunDir); // sin of sun elevation
    this.daylight = THREE.MathUtils.smoothstep(elev, -0.12, 0.25);
    // local time at focus for UI/audio
    const lon = Math.atan2(up.x, up.z);
    let t = ((this.dayAngle - lon) / (Math.PI * 2) + 0.5) % 1;
    if (t < 0) t += 1;
    this.timeOfDay = t;
    this.uniforms.uDaylight.value = this.daylight;
  }

  update(dt, t, focusPos) {
    if (focusPos) this.focus.copy(focusPos);
    // Planet day: dayAngle advances; reverse sign = sun moves east→west.
    this.dayAngle -= (dt * this.timeScale * Math.PI * 2) / this.dayLength;
    this._updateSun();
    this.uniforms.uTime.value = t;
    const ws = 0.45 + 0.35 * Math.sin(t * 0.05) + 0.2 * Math.sin(t * 0.17);
    this.windStrength = ws;
    this.uniforms.uWind.value.set(this.wind.x, this.wind.y, this.wind.z, ws);
  }
}

const EMPTY = new Set();
