// Civilization — the planet subsystem that turns world.sites into living
// settlements in the world's architectural style (Aesthetics.architecture):
// pastoral (Ghibli), monolithic (Villeneuve), temple (Wukong/Sekiro), organic
// (Moebius/Avatar), outpost (NASA-punk), gothic (FromSoftware), neon (Bebop),
// ruins (Ueda).
//
// The capital (site 0) is built at load; other sites stream in (time-sliced)
// when the camera comes within range, and every site shows its night lights
// from afar. See Settlement.js for the pipeline.

import * as THREE from 'three';
import { Settlement } from './Settlement.js';

const _v = new THREE.Vector3(), _c = new THREE.Color();

export default class Civilization {
  static order = 70;

  constructor(level) {
    this.level = level;
    this.settlements = [];
    this.queue = [];
    this.shared = {};
    level.civilization = this;
  }

  async init(progress) {
    const w = this.level.world;
    const sites = w.sites || [];
    for (const site of sites) {
      const s = new Settlement(this, site, { main: site.index === 0 });
      this.settlements.push(s);
    }
    const main = this.settlements[0];
    if (main) {
      try {
        main.buildNow();
        this.level.scene.add(main.group);
      } catch (e) {
        console.error('[civ] capital build failed', e);
      }
    }
    for (const s of this.settlements) {
      try { s.makeFarLOD(); if (!s.group.parent) this.level.scene.add(s.group); } catch (e) { console.warn('[civ] far LOD', s.site.name, e); }
    }
    progress?.(1);
  }

  update(dt, t) {
    const cam = this.level.camera.position;
    const engine = this.level.engine;
    // stream nearby settlements
    for (const s of this.settlements) {
      if (s.built || s._gen) continue;
      const d = cam.distanceTo(s.frame.origin);
      if (d < 5200 && !engine.shotMode) { s._gen = s.build(); this.queue.push(s); }
    }
    if (this.queue.length) {
      const t0 = performance.now();
      while (this.queue.length && performance.now() - t0 < 5) {
        const s = this.queue[0];
        let r;
        try { r = s._gen.next(); } catch (e) { console.error('[civ] build failed', s.site.name, e); r = { done: true }; s.failed = true; }
        if (r.done) { this.queue.shift(); s._gen = null; if (!s.failed && !s.group.parent) this.level.scene.add(s.group); }
      }
    }
    for (const s of this.settlements) {
      if (!s.group.parent) continue;
      const camLocal = s.frame.toLocal(cam, _v);
      const d = camLocal.length();
      this._lightUniforms(s);
      s.update(dt, t, camLocal, d);
    }
  }

  _lightUniforms(s) {
    const u = s.uniforms;
    const sunL = s.frame.sunLocal(this.level.world.sunDir, u.uCivSunL.value);
    const y = sunL.y;
    const ss = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
    u.uCivNight.value = 1 - ss(-0.1, 0.1, y);
    u.uCivDay.value = ss(-0.1, 0.25, y);
    u.uCivLitP.value = 0.06 + 0.66 * ss(0.12, -0.1, y);
    // sky colour for glass reflections follows the light
    const P = this.level.aesthetic?.palette || {};
    const day = u.uCivDay.value;
    u.uCivSkyZ.value.set(P.zenith || '#3b7dd8').multiplyScalar(0.03 + 0.9 * day);
    u.uCivSkyH.value.set(P.horizon || '#d6ecff').lerp(_c.set('#ff9a5a'), (1 - day) * 0.6 * (1 - u.uCivNight.value * 0.8)).multiplyScalar(0.05 + 0.9 * Math.max(day, 0.25 * (1 - u.uCivNight.value)));
    // world up at the site, in view space (for sky reflections)
    u.uCivUpV.value.copy(s.frame.up).transformDirection(this.level.camera.matrixWorldInverse);
  }

  /** Screenshot presets. */
  shot(name, spot) {
    const s = this.settlements[0];
    if (!s || !s.built) return false;
    if (name === 'city') { this._shotCity(s); return true; }
    if (name === 'citynight') { this._shotCity(s, { night: true }); return true; }
    if (name === 'street') { this._shotStreet(s); return true; }
    void spot;
    return false;
  }

  /** Pick a time at the site where the sun's local elevation (sin) ≈ target, in the evening. */
  _timeFor(s, target, from = 0.62, to = 0.92) {
    const w = this.level.world;
    let best = 0.75, bd = Infinity;
    for (let t = from; t <= to; t += 0.0025) {
      w.setTimeOfDay(t, s.site.dir);
      const y = s.frame.sunLocal(w.sunDir, _v).y;
      const d = Math.abs(y - target);
      if (d < bd) { bd = d; best = t; }
    }
    w.setTimeOfDay(best, s.site.dir);
    return best;
  }

  _shotCity(s, o = {}) {
    const w = this.level.world, f = s.frame, plan = s.plan;
    this._timeFor(s, o.night ? -0.2 : (s.style.shotSun ?? 0.045));
    const sunL = f.sunLocal(w.sunDir, new THREE.Vector3());
    const sunA = Math.atan2(sunL.z, sunL.x);
    const c = plan.center;
    const Rb = Math.max(120, plan.builtRadius);
    const lm = s.ctx.landmarkSpots.find((l) => ['island', 'elevator', 'pagoda', 'monolith', 'tree', 'citadel', 'colossus', 'arch'].includes(l.kind)) || s.ctx.landmarkSpots[0];
    const sh = s.style.shot || {};
    let best = null;
    // classic composition: camera on the far side of town from the landmark, landmark rising behind the roofs
    const a0 = lm ? Math.atan2(c[1] - lm.z, c[0] - lm.x) : 0;
    const cand = lm ? Array.from({ length: 15 }, (_, k) => a0 + (k - 7) * 0.12) : Array.from({ length: 48 }, (_, k) => (k / 48) * Math.PI * 2);
    for (const a of cand) {
      const D = Rb * (sh.dist ?? 0.85) + 30;
      const x = c[0] + Math.cos(a) * D, z = c[1] + Math.sin(a) * D;
      const gh = f.hAt(x, z);
      const ch = f.hAt(c[0], c[1]);
      const elev = Math.max(gh, f.sea + 1) + (sh.height ?? (22 + Rb * 0.05));
      const camY = Math.max(elev, ch + (sh.minAbove ?? 30));
      // view direction (horizontal) from camera to center
      const vx = c[0] - x, vz = c[1] - z;
      const va = Math.atan2(vz, vx);
      // sun azimuth relative to view: prefer the sun off to one side and a bit ahead (rim light) or behind
      let da = Math.abs(((sunA - va + Math.PI * 3) % (Math.PI * 2)) - Math.PI); // 0 = sun ahead, π = behind
      const sunScore = -Math.abs(da - (sh.sunAngle ?? 1.9));
      // terrain occlusion along the line of sight
      let occl = 0;
      for (let i = 1; i < 12; i++) {
        const t = i / 12;
        const px = x + vx * t, pz = z + vz * t;
        const ly = camY + (ch + 8 - camY) * t;
        const g = f.hAt(px, pz);
        if (g > ly) occl += (g - ly);
      }
      let lmScore = 0;
      if (lm) lmScore = -Math.abs(((a - a0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 1.2;
      const wetCam = f.wet(x, z) ? -0.3 : 0;
      const hill = Math.min(1.5, Math.max(0, (gh - ch) / 40));
      const sc = sunScore * 1.0 + lmScore - occl * 0.08 + wetCam + hill * 0.5;
      if (!best || sc > best.sc) best = { sc, x, z, camY, a };
    }
    const pos = f.point(best.x, best.z, best.camY);
    // fit the town and the whole landmark into the frame
    const ch = f.hAt(c[0], c[1]);
    const pts = [f.point(c[0], c[1], ch), f.point(c[0], c[1], ch + (sh.lookUp ?? 12))];
    if (lm && sh.frameLandmark !== false) {
      const top = lm.R ? lm.h + lm.R * 0.95 : lm.h;
      const bottom = lm.R ? lm.h - lm.R * 1.3 : f.hAt(lm.x, lm.z);
      pts.push(f.point(lm.x, lm.z, top), f.point(lm.x, lm.z, bottom));
    }
    const fwd = new THREE.Vector3();
    for (const p of pts) fwd.add(p.clone().sub(pos).normalize());
    fwd.normalize();
    const up = f.upAt(best.x, best.z, new THREE.Vector3());
    const right = fwd.clone().cross(up).normalize();
    const camUp = right.clone().cross(fwd).normalize();
    let lo = Infinity, hi = -Infinity, wmax = 0;
    for (const p of pts) {
      const d = p.clone().sub(pos);
      const z = d.dot(fwd), yv = Math.atan2(d.dot(camUp), z), xv = Math.atan2(d.dot(right), z);
      lo = Math.min(lo, yv); hi = Math.max(hi, yv); wmax = Math.max(wmax, Math.abs(xv));
    }
    const mid = (lo + hi) / 2;
    const aim = fwd.clone().applyAxisAngle(right, mid);
    const aspect = this.level.camera.aspect || 16 / 9;
    const needV = Math.max(hi - lo, (wmax * 2) / aspect);
    const fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(needV) * 1.22 + 3, sh.minFov ?? 32, 72);
    const tgt = pos.clone().addScaledVector(aim, 100);
    f.toWorld(pos, pos); f.toWorld(tgt, tgt);
    this.level.freeCam = { position: pos, target: tgt };
    this.level.camera.fov = fov;
    this.level.camera.updateProjectionMatrix();
    s.forceShadow();
  }

  _shotStreet(s) {
    const w = this.level.world, f = s.frame, plan = s.plan;
    this._timeFor(s, 0.06);
    const pz = plan.plazas[0];
    const a = 0.7;
    const x = pz.x + Math.cos(a) * pz.r * 0.8, z = pz.z + Math.sin(a) * pz.r * 0.8;
    const pos = f.toWorld(f.point(x, z, f.hAt(x, z) + 1.7));
    const tgt = f.toWorld(f.point(pz.x - Math.cos(a) * 30, pz.z - Math.sin(a) * 30, f.hAt(pz.x, pz.z) + 6));
    this.level.freeCam = { position: pos, target: tgt };
    void w;
    s.forceShadow();
  }

  dispose() {
    for (const s of this.settlements) s.dispose();
    this.settlements = [];
  }
}
