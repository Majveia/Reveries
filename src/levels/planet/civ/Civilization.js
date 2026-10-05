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

const _v = new THREE.Vector3(), _c = new THREE.Color(), _b = new THREE.Vector3();

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
    // lanterns start glowing in the golden hour, windows light up progressively toward night
    u.uCivNight.value = 1 - ss(-0.08, 0.3, y);
    u.uCivDay.value = ss(-0.1, 0.25, y);
    u.uCivLitP.value = 0.05 + 0.7 * ss(0.32, -0.06, y);
    // sky colour for glass reflections follows the light
    const P = this.level.aesthetic?.palette || {};
    const day = u.uCivDay.value;
    u.uCivSkyZ.value.set(P.zenith || '#3b7dd8').multiplyScalar(0.03 + 0.9 * day);
    u.uCivSkyH.value.set(P.horizon || '#d6ecff').lerp(_c.set('#ff9a5a'), (1 - day) * 0.6 * (1 - u.uCivNight.value * 0.8)).multiplyScalar(0.05 + 0.9 * Math.max(day, 0.25 * (1 - u.uCivNight.value)));
    // warm light bounced off the sunlit ground (fills alleys and eave undersides)
    const sun = this.level.sun;
    if (u.uCivBounce && sun) {
      const e = (sun.intensity ?? 1) * Math.max(0, y) * 0.32 * (1 - u.uCivNight.value * 0.9);
      u.uCivBounce.value.set(sun.color.r, sun.color.g, sun.color.b).multiply(_b.set(0.3, 0.24, 0.17)).multiplyScalar(e);
    }
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
    this._timeFor(s, o.night ? -0.2 : (s.style.shotSun ?? 0.14));
    const sunL = f.sunLocal(w.sunDir, new THREE.Vector3());
    const sunA = Math.atan2(sunL.z, sunL.x);
    const c = plan.center;
    const Rb = Math.max(120, plan.builtRadius);
    const lm = s.ctx.landmarkSpots.find((l) => ['island', 'elevator', 'pagoda', 'monolith', 'tree', 'citadel', 'colossus', 'arch'].includes(l.kind)) || s.ctx.landmarkSpots[0];
    const sh = s.style.shot || {};
    const ch = f.hAt(c[0], c[1]);
    const R = f.R || 40000;
    const aspect = this.level.camera.aspect || 16 / 9;
    const TAU = Math.PI * 2;
    const wrap = (a) => ((a % TAU) + TAU * 1.5) % TAU - Math.PI;
    const lmTop = lm ? (lm.R ? lm.h + lm.R * 0.95 : lm.h) : 0;
    const lmBot = lm ? (lm.R ? lm.h - lm.R * 1.3 : f.hAt(lm.x, lm.z)) : 0;
    const fps = s.ctx.footprints || [];
    const sunPref = sh.sunPref ?? 1.45; // sun ahead and to the side: rim light, long shadows toward the camera
    // first terrain hit along a ray (plan space, curvature-corrected); returns [dist, groundH] or null
    const march = (x0, z0, y0, yaw, pitch, maxS, steps) => {
      const cx = Math.cos(yaw), cz = Math.sin(yaw), tp = Math.tan(pitch);
      for (let i = 1; i <= steps; i++) {
        const sd = (i / steps) ** 1.4 * maxS;
        const g = f.hAt(x0 + cx * sd, z0 + cz * sd);
        if (g > y0 + tp * sd + (sd * sd) / (2 * R)) return [sd, g];
      }
      return null;
    };
    const elevOf = (x0, z0, y0, x, z, y) => { const d = Math.hypot(x - x0, z - z0); return Math.atan2(y - y0 - (d * d) / (2 * R), d); };
    let best = null;
    const az = 36, dists = [0.55, 0.8, 1.05], heights = [0.45, 0.75, 1.15];
    for (let k = 0; k < az; k++) {
      const a = (k / az) * TAU;
      for (const fd of dists) {
        const D = Rb * (sh.dist ?? 0.85) * fd + 30;
        const x = c[0] + Math.cos(a) * D, z = c[1] + Math.sin(a) * D;
        const gh = f.hAt(x, z);
        for (const fh of heights) {
          const camY = Math.max(Math.max(gh, f.sea + 1) + (sh.height ?? 36) * fh, ch + 14);
          // never inside or right against a building
          let inside = false;
          for (const fp of fps) {
            const L = fp.lot; if (!L) continue;
            const r = Math.max(L.w, L.d) * 0.6 + 6;
            if (Math.abs(L.x - x) < r && Math.abs(L.z - z) < r && camY < (L.base ?? gh) + fp.h + 6) { inside = true; break; }
          }
          if (inside) continue;
          const aC = Math.atan2(c[1] - z, c[0] - x);
          const dC = Math.hypot(c[0] - x, c[1] - z);
          let vfov, yaw, pitch, dA = 0, dL = dC;
          const eTown = elevOf(x, z, camY, c[0], c[1], ch);
          let sc = 0;
          if (lm) {
            const aL = Math.atan2(lm.z - z, lm.x - x);
            dL = Math.hypot(lm.x - x, lm.z - z);
            dA = wrap(aL - aC);
            const eTop = elevOf(x, z, camY, lm.x, lm.z, lmTop);
            const eBot = elevOf(x, z, camY, lm.x, lm.z, lmBot);
            // landmark top near the upper frame line, town centre in the lower third
            vfov = THREE.MathUtils.clamp((eTop - Math.min(eTown, eBot)) / 0.66, THREE.MathUtils.degToRad(sh.minFov ?? 38), THREE.MathUtils.degToRad(62));
            pitch = eTop - 0.4 * vfov;
            const over = (eTop - Math.min(eTown, eBot)) / 0.66 - vfov;
            if (over > 0) sc -= over * 8;
            const hf = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
            // landmark on a third line, the town spreading toward the other side
            yaw = aL - Math.sign(dA || 1) * hf / 6;
            if (Math.abs(wrap(aC - yaw)) > hf * 0.42) sc -= 3;
            sc -= Math.abs(Math.abs(dA) - hf * 0.18) * 2.0;
            if (dL < dC * 0.85) sc -= 1.2; // the landmark should rise behind the roofs, not in front of them
            // landmark base must be visible over the terrain
            const toL = march(x, z, camY, aL, eBot + 0.004, dL * 0.97, 18);
            if (toL) sc -= 1.5;
          } else {
            vfov = THREE.MathUtils.degToRad(42);
            yaw = aC;
            pitch = eTown + 0.2 * vfov;
          }
          // terrain occlusion over a 5x4 grid of screen rays: penalise hills/fins rising between camera and town
          const hf = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
          let block = 0;
          for (const u of [-0.85, -0.42, 0, 0.42, 0.85]) {
            for (const v of [-0.6, -0.15, 0.3, 0.75]) {
              const hit = march(x, z, camY, yaw + u * hf * 0.5, pitch + v * vfov * 0.5, dC * 1.2, 16);
              if (hit && hit[0] < dC * 0.75 && hit[1] > Math.max(ch, gh) + 10) block++;
            }
          }
          const frac = block / 20;
          if (frac > 0.25) sc -= 6;
          sc -= frac * 6;
          const toC = march(x, z, camY, aC, eTown + 0.01, dC * 0.95, 16);
          if (toC) sc -= 2;
          // light: sun to the side and a little ahead
          const da = Math.abs(wrap(sunA - yaw));
          sc -= Math.abs(da - sunPref) * 1.3;
          if (f.wet(x, z)) sc -= 0.4;
          sc += Math.min(1, Math.max(0, (gh - ch) / 60)) * 0.4; // a natural vantage on a rise
          sc -= Math.abs(fh - 0.75) * 0.6;
          // the town should fill the frame: apparent size of the built area vs the field of view
          const townAng = 2 * Math.atan(Rb * 0.8 / Math.max(dC, 1));
          sc += Math.min(1, townAng / (vfov * aspect * 0.9)) * 3.0;
          // a lower, grazing view overlaps roofs in depth; a bird's-eye view flattens the town
          sc -= Math.max(0, -eTown - 0.2) * 4;
          if (!best || sc > best.sc) best = { sc, x, z, camY, yaw, pitch, vfov };
        }
      }
    }
    if (!best) { // fallback: high above the centre
      best = { x: c[0] + Rb, z: c[1], camY: ch + 120, yaw: Math.PI, pitch: -0.25, vfov: 0.8 };
    }
    const pos = f.point(best.x, best.z, best.camY);
    const up = f.upAt(best.x, best.z, new THREE.Vector3());
    const east = new THREE.Vector3(1, 0, 0).addScaledVector(up, -up.x).normalize();
    const south = up.clone().cross(east).multiplyScalar(-1).normalize();
    if (south.z < 0) south.negate();
    const fwd = east.multiplyScalar(Math.cos(best.yaw) * Math.cos(best.pitch))
      .addScaledVector(south, Math.sin(best.yaw) * Math.cos(best.pitch))
      .addScaledVector(up, Math.sin(best.pitch)).normalize();
    const tgt = pos.clone().addScaledVector(fwd, 100);
    f.toWorld(pos, pos); f.toWorld(tgt, tgt);
    this.level.freeCam = { position: pos, target: tgt };
    this.level.camera.fov = THREE.MathUtils.radToDeg(best.vfov);
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
