// Fauna — life everywhere: the Planet Earth III layer of Reveries.
//
//   birds.js     boid flocks, soaring raptors, V-formations of great cranes, gulls at coasts
//   herds.js     procedural quadrupeds: grazing / walking / fleeing herds, GPU walk cycles
//   floaters.js  bioluminescent sky jellies and sky whales drifting among the clouds
//   giants.js    awe moments: the breaching sandworm, the walking colossus
//   smalllife.js butterflies over meadows, fish schools in the shallows
//   common.js    GPU rig materials, geometry primitives, instancing helpers
//
// Everything is instanced and animated on the GPU; the CPU only runs cheap
// steering. Creatures spawn deterministically from lattice cells around the
// camera (seeded from the planet), never in settlements (birds excepted), and
// live in a floating-origin group so they stay precise anywhere on the planet.
//
// Screenshots: shot('fauna') composes a wildlife frame per world (a herd in the
// meadow under a passing flock and a sky whale; jellies at dusk on Pandora; a
// sandworm breaching the dunes on Arrakeen). Every other preset gets a
// "showcase" pass after the camera is placed, so creatures appear in vistas.
import * as THREE from 'three';
import { seedFrom, Random } from '../../../core/Random.js';
import { Herds, herdSpeciesFor } from './herds.js';
import { Birds, birdsFor } from './birds.js';
import { Floaters } from './floaters.js';
import { Giants } from './giants.js';
import { SmallLife } from './smalllife.js';
import { tangentBasis, TAU, smooth } from './common.js';
import { valueFbm3 } from '../flora/scatter.js';

const BIRD_COUNT = (k, hero) => (k === 'ikran' || k === 'ray' ? (hero ? 7 : 5) : k === 'gull' ? (hero ? 16 : 12) : (hero ? 34 : 26));
const WHALE_WORLDS = ['ghibli', 'moebius', 'pandora'];
const SHOT_TIME = { dune: 0.7, pandora: 0.775, ghibli: 0.345, wukong: 0.3, moebius: 0.35, ueda: 0.3, rick: 0.33, tarkovsky: 0.36, glacier: 0.33, erdtree: 0.7 };
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _n = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _ndc = new THREE.Vector3();

export default class Fauna {
  static order = 60;

  constructor(level) {
    this.level = level;
    this.world = level.world;
    this.engine = level.engine;
    this.q = this.engine.quality;
    this.seed = seedFrom(level.planet.seed, 'fauna');
    this.aesthetic = level.planet.aesthetic || null;
    this.list = level.aesthetic?.fauna || [];
    this.uniforms = { uFTime: { value: 0 } };
    this.root = new THREE.Group();
    this.root.name = 'fauna';
    this.anchor = new THREE.Vector3();
    this.time = 0;
    this.night = 0;
    this.density = { herds: this.q.pick(0.22, 0.3, 0.38, 0.45), birds: this.q.pick(0.35, 0.5, 0.6, 0.7) };
    this.mods = [];
    this.showcase = null;
    this._pending = false;
  }

  async init(progress) {
    const A = this.aesthetic, L = this.list;
    if (!A || !this.level.planet.landable) return;
    const wrap = (name, fn) => { try { const m = fn(); if (m) { this[name] = m; this.mods.push(m); } } catch (e) { console.warn(`[fauna] ${name} failed:`, e); } };
    const herdSp = herdSpeciesFor(A, L);
    if (herdSp.length) wrap('herds', () => new Herds(this, herdSp));
    progress?.(0.3);
    if (birdsFor(A, L)) wrap('birds', () => new Birds(this));
    progress?.(0.55);
    const jellies = L.includes('jellies') || L.includes('blobs');
    const whales = WHALE_WORLDS.includes(A);
    if (jellies || whales) wrap('floaters', () => new Floaters(this, { jellies, whales }));
    progress?.(0.8);
    if (L.includes('worms') || L.includes('colossi')) wrap('giants', () => new Giants(this, { worm: L.includes('worms'), colossus: L.includes('colossi') }));
    wrap('small', () => new SmallLife(this));
    this.level.scene.add(this.root);
    progress?.(1);
  }

  /** Is this ground fit for grazing? (dry, gentle, away from settlements) */
  groundOK(dir, minUp = 0.9, clearance = 80) {
    const w = this.world;
    const h = w.heightAt(dir);
    if (w.hasOcean && h < w.seaLevel + 1.5) return false;
    w.normalAt(dir, _n, 2);
    if (_n.dot(dir) < minUp) return false;
    _v.copy(dir).multiplyScalar(w.radius + h);
    for (const s of w.sites) if (s.kind !== 'ruins' && _v.distanceTo(s.position) < s.radius + clearance) return false;
    return true;
  }

  /** Forest cover 0..1 at a direction (mirrors flora's tree placement), so wildlife frames find open meadows. */
  forestAt(dir) {
    const F = this.level.sys?.flora, T = F?.profile?.trees;
    if (!T) return 0;
    const w = this.world, s = w.sample(dir), rr = w.radius + s.h, fz = F.noiseScale?.forest ?? 1 / 240;
    const fm = valueFbm3(dir.x * rr * fz, dir.y * rr * fz, dir.z * rr * fz, 3);
    const fk = smooth(-0.02, 0.14, fm + (s.biome === 2 ? 0.25 : 0) + (T.cover ?? 0) + (s.moisture - 0.5) * 0.45);
    const clim = [0, T.grassland ?? 0.3, 1, T.arid ?? 0.1, T.snowy ?? 0, T.sandy ?? 0.04, T.rocky ?? 0.05, T.wet ?? 0.45][s.biome] ?? 0;
    return Math.min(1, clim * 1.4) * fk;
  }

  update(dt, t) {
    if (!this.mods.length) return;
    const cam = this.level.camera.position;
    const alt = this.world.altitude(cam);
    this.root.visible = alt < 9000;
    this.time += dt;
    this.uniforms.uFTime.value = this.time;
    this.night = this.level.lighting?.night ?? (1 - this.world.daylight);
    if (!this.root.visible) return;
    this._reanchor(cam);
  }

  _reanchor(cam) {
    if (this._anchored && this.anchor.distanceToSquared(cam) < 1500 * 1500) return;
    this._anchored = true;
    this.anchor.set(Math.round(cam.x / 64) * 64, Math.round(cam.y / 64) * 64, Math.round(cam.z / 64) * 64);
    this.root.position.copy(this.anchor);
    this.root.updateMatrixWorld(true);
  }

  // Simulation + instance writes run after the camera rigs placed the camera.
  lateUpdate(dt) {
    if (!this.mods.length) return;
    const cam = this.level.camera.position;
    this.root.visible = this.world.altitude(cam) < 9000;
    if (!this.root.visible) return;
    this._reanchor(cam);
    if (this._pending) { this._pending = false; try { this._showcase(); } catch (e) { console.warn('[fauna] showcase', e); } }
    const player = this.level.player && this.level.mode === 'onfoot' && !this.level.freeCam ? this.level.player.position : null;
    const step = (fn) => { try { fn(); } catch (e) { if (!this._errs) { this._errs = 1; console.error('[fauna]', e); } } };
    if (this.herds) step(() => this.herds.update(dt, cam, player));
    if (this.birds) step(() => this.birds.update(dt, cam));
    if (this.floaters) step(() => this.floaters.update(dt, cam));
    if (this.giants) step(() => this.giants.update(dt, cam));
    if (this.small) step(() => this.small.update(dt, cam));
  }

  // ---------------------------------------------------------------------------------
  // Screenshots
  // ---------------------------------------------------------------------------------
  shotReset() {
    this.herds?.clearForced(); this.birds?.clearForced(); this.floaters?.clearForced();
    this.showcase = null;
    if (this._fov0) { this.level.camera.fov = this._fov0; this.level.camera.updateProjectionMatrix(); this._fov0 = 0; }
    if (this.giants?.worm) this.giants.worm.dir = null;
    if (this.giants?.colossus) this.giants.colossus.pos = null;
    this._pending = this.engine.shotMode;
  }

  /** Advance the simulation so poses look natural (boids spread, legs mid-stride). */
  _settle(seconds) {
    const n = Math.round(seconds * 30);
    for (let i = 0; i < n; i++) { this.time += 1 / 30; this.uniforms.uFTime.value = this.time; this.lateUpdate(1 / 30); }
  }

  /** Find a meadow viewpoint near a settlement with an open view (relaxing the criteria on rugged / forested worlds). */
  _findSpot() {
    const w = this.world;
    w.setTimeOfDay(SHOT_TIME[this.aesthetic] ?? 0.32, (w.sites[0]?.dir || new THREE.Vector3(0.3, 0.5, 0.8).normalize()));
    this._sun = w.sunDir.clone();
    for (const [maxForest, minUp, corridor] of [[0.12, 0.94, 0.08], [0.3, 0.9, 0.06], [0.6, 0.86, 0.04], [1.01, 0.8, 0.02]]) {
      const b = this._searchSpot(maxForest, minUp, corridor);
      if (b) return b;
    }
    return null;
  }

  _searchSpot(maxForest, minUp, corridor) {
    const w = this.world, R = w.radius;
    const sites = w.sites.length ? w.sites : [{ dir: new THREE.Vector3(0.3, 0.5, 0.8).normalize(), radius: 0 }];
    const rng = new Random(seedFrom(this.seed, 'spot'));
    let best = null;
    const t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), d = new THREE.Vector3(), g = new THREE.Vector3();
    for (const s of sites.slice(0, 3)) {
      tangentBasis(s.dir, t1, t2);
      for (let k = 0; k < 28; k++) {
        const a = rng.range(0, TAU), r = (s.radius || 0) + rng.range(350, 1300);
        d.copy(s.dir).multiplyScalar(R).addScaledVector(t1, Math.cos(a) * r).addScaledVector(t2, Math.sin(a) * r).normalize();
        if (!this.groundOK(d, minUp, 140)) continue;
        const fk = this.forestAt(d);
        if (fk > maxForest) continue;
        const h0 = w.heightAt(d);
        const [u1, u2] = tangentBasis(d, new THREE.Vector3(), new THREE.Vector3());
        // the most open heading (terrain ahead stays below the eye) with a herd-friendly patch 20–70 m out
        for (let j = 0; j < 8; j++) {
          const hd = (j / 8) * TAU;
          const fw = u1.clone().multiplyScalar(Math.cos(hd)).addScaledVector(u2, Math.sin(hd));
          let block = 0, okPatch = 0;
          for (const dist of [20, 40, 70, 120, 200, 320]) {
            g.copy(d).multiplyScalar(R).addScaledVector(fw, dist).normalize();
            const h = w.heightAt(g);
            block = Math.max(block, (h - h0 - 2.0) / dist);
            if (dist >= 20 && dist <= 70 && this.groundOK(g, Math.min(minUp, 0.9), 60)) okPatch++;
            if (dist <= 120) block = Math.max(block, this.forestAt(g) * corridor);
          }
          if (!okPatch) continue;
          // the far land must stay low so the sky (flocks, whales, clouds) fills the upper frame
          let sky = 0;
          for (const dist of [450, 900, 1600]) {
            g.copy(d).multiplyScalar(R).addScaledVector(fw, dist).normalize();
            sky = Math.max(sky, (w.heightAt(g) - h0 - 3 - dist * dist / (2 * R)) / dist);
          }
          block += Math.max(0, sky - 0.04) * 1.5;
          // light: the sun behind-and-beside the lens lights the herd and models it
          const sunH = this._sun.clone().addScaledVector(d, -this._sun.dot(d));
          const sl = sunH.lengthSq() > 1e-6 ? fw.dot(sunH.normalize()) : 0;
          let score = -block * 40 + okPatch - fk * 2 + rng.float() * 0.4 - (w.hasOcean && h0 < w.seaLevel + 4 ? 2 : 0) - Math.abs(sl + 0.35) * 1.5;
          if (best && score <= best.score) continue;
          // the meadow ahead must not lie in a mountain's shadow
          g.copy(d).multiplyScalar(R).addScaledVector(fw, 35).normalize();
          const gp = g.clone().multiplyScalar(R + w.heightAt(g) + 2);
          if (this._sun.dot(g) < 0.05 || w.raycast(gp, this._sun, 2500)) score -= 4;
          if (!best || score > best.score) best = { score, dir: d.clone(), fwd: fw, h0 };
        }
      }
    }
    return best;
  }

  async shot(name) {
    if (name !== 'fauna' || !this.mods.length) return false;
    const w = this.world, R = w.radius, A = this.aesthetic;
    const spot = this._findSpot();
    if (!spot) return false;
    w.setTimeOfDay(SHOT_TIME[A] ?? 0.32, spot.dir);
    // turn the view so the sun is to the side (form-revealing light), keeping the open heading roughly
    const up = spot.dir;
    // jungle worlds with no open ground: rise above the canopy and watch the sky-life drift over it
    const canopy = this.forestAt(spot.dir) > 0.45;
    const eye = up.clone().multiplyScalar(R + spot.h0 + (canopy ? 46 : A === 'dune' ? 6 : 3.0));
    const fwd = spot.fwd.clone();
    const hp = eye.clone().addScaledVector(fwd, 26).normalize();
    const hpos = hp.clone().multiplyScalar(R + w.heightAt(hp));
    const target = canopy ? eye.clone().addScaledVector(fwd, 100).addScaledVector(up, -2) : A === 'dune' ? eye.clone().addScaledVector(fwd, 100).addScaledVector(up, 7) : hpos.addScaledVector(up, 1 + 26 * 0.1);
    this.level.freeCam = { position: eye, target, up: up.clone() };
    if (this.level.player) this.level.player.shotPose = null;
    const cam = this.level.camera;
    // wildlife-photography framing: a long lens compresses the herd, the flock and the giants
    if (!this._fov0) this._fov0 = cam.fov;
    cam.fov = A === 'dune' ? 42 : 36; cam.updateProjectionMatrix();
    cam.position.copy(eye); cam.up.copy(up); cam.lookAt(target); cam.updateMatrixWorld();
    this._pending = false;
    // the explorer stands just behind the lens: the sky, sun and ambient light are evaluated around them
    const P = this.level.player;
    if (P?.ctl?.place) {
      try {
        const bd = eye.clone().addScaledVector(fwd, -5).normalize();
        P.ctl.place(bd.multiplyScalar(R + w.heightAt(bd) + 0.1), fwd); P._afterTeleport?.(); P.ctl.frozen = true;
      } catch (e) { console.warn('[fauna] player place', e); }
    }
    w.focus.copy(eye);
    this._compose(eye, fwd, up, { hero: true, canopy });
    this._settle(this.engine.shotMode ? 2.5 : 0.5);
    this._debug();
    return true;
  }

  /** Generic pass for other presets: put life in front of whatever camera was chosen. */
  _showcase() {
    const cam = this.level.camera;
    cam.updateMatrixWorld();
    const up = cam.position.clone().normalize();
    const alt = this.world.altitude(cam.position);
    if (alt > 1500) return;
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-6) return;
    fwd.normalize();
    this._compose(cam.position.clone(), fwd, up, { hero: false });
    this._settle(1.5);
    this._debug();
  }

  _debug() {
    if (!this.engine.params?.get?.('fdebug')) return;
    const cam = this.level.camera; cam.updateMatrixWorld();
    const out = [];
    this.root.traverse((o) => {
      if (!o.isInstancedMesh || !o.count) return;
      let mnx = 9, mxx = -9, mny = 9, mxy = -9, vis = 0;
      const m = new THREE.Matrix4(), p = new THREE.Vector3();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m); p.setFromMatrixPosition(m).add(this.anchor).project(cam);
        if (p.z > 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) continue;
        vis++; mnx = Math.min(mnx, p.x); mxx = Math.max(mxx, p.x); mny = Math.min(mny, p.y); mxy = Math.max(mxy, p.y);
      }
      out.push(`${o.material.customProgramCacheKey?.().slice(6) || 'jelly'}:${vis}/${o.count}` + (vis ? `[${mnx.toFixed(2)}..${mxx.toFixed(2)},${mny.toFixed(2)}..${mxy.toFixed(2)}]` : ''));
    });
    console.warn('[fauna] in view', out.join(' '));
  }

  /** Nudge a world point so it lands at NDC (x, y) of the current camera. */
  _frameAt(p, eye, up, right, x, y) {
    const cam = this.level.camera, th = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    for (let k = 0; k < 5; k++) {
      _ndc.copy(p).project(cam);
      const dist = p.distanceTo(eye);
      p.addScaledVector(up, (y - _ndc.y) * th * dist * 0.9).addScaledVector(right, (x - _ndc.x) * th * cam.aspect * dist * 0.9);
    }
    return p;
  }

  _visible(p, cam, xr = 0.85, ymin = -0.9, ymax = 0.9) {
    _ndc.copy(p).project(cam);
    return _ndc.z < 1 && _ndc.z > -1 && Math.abs(_ndc.x) < xr && _ndc.y > ymin && _ndc.y < ymax;
  }

  _compose(eye, fwd, up, { hero, canopy = false }) {
    const w = this.world, R = w.radius, A = this.aesthetic, cam = this.level.camera;
    cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    this.showcase = {};
    const right = _r.copy(fwd).cross(up).normalize().clone();
    const at = (dist, side, lift = 0) => eye.clone().addScaledVector(fwd, dist).addScaledVector(right, side).normalize().multiplyScalar(R);
    // --- herd on visible open ground
    if (this.herds && !canopy) {
      const tries = hero ? [[26, -3], [30, 4], [22, 0], [36, -6], [48, 8]] : [[110, -30], [160, 30], [80, -20], [220, 0], [60, 15], [300, -60]];
      for (const [dist, side] of tries) {
        const d = at(dist, side).normalize();
        if (!this.groundOK(d, 0.88, 50)) continue;
        const gp = d.clone().multiplyScalar(R + w.heightAt(d) + 1);
        if (!this._visible(gp, cam, 0.8, -0.95, 0.4)) continue;
        // line of sight from the eye
        const dir = gp.clone().sub(eye); const len = dir.length(); dir.divideScalar(len);
        const hit = w.raycast?.(eye, dir, len);
        if (hit && (hit.distance ?? len) < len - 6) continue;
        this.herds.spawnAt(d, hero ? 9 : 9, right.clone().multiplyScalar((this.seed & 1) ? 1 : -1));
        this.showcase.herd = d;
        break;
      }
    }
    // --- birds crossing the sky
    if (this.birds) {
      const cfg = this.birds.cfg;
      const fp = this._frameAt(eye.clone().addScaledVector(fwd, hero ? 70 : 55), eye, up, right, hero ? 0.3 : -0.15, hero ? 0.48 : 0.5);
      const fd = fp.clone().normalize();
      const gh = Math.max(w.heightAt(fd), w.hasOcean ? w.seaLevel : -1e9);
      const eyeAlt = eye.length() - R;
      const alt = Math.max(fp.length() - R - gh, 8);
      const hdir = right.clone().multiplyScalar(-1).addScaledVector(fwd, -0.25);
      const heading = Math.atan2(hdir.dot(tangentBasis(fd)[1]), hdir.dot(tangentBasis(fd)[0]));
      if (A === 'wukong') this.birds.spawnAt(at(260, -40).normalize(), { kind: 'crane', count: 9, alt: alt + 25, heading });
      else { const kind = hero || !cfg.coast ? cfg.flock : cfg.coast; this.birds.spawnAt(fd, { kind, count: BIRD_COUNT(kind, hero), alt, heading, spread: hero ? 16 : 22, flock: true }); }
      if (cfg.soar && cfg.soar !== 'crane') this.birds.spawnAt(at(hero ? 160 : 260, hero ? -60 : 80).normalize(), { kind: cfg.soar, count: 2, alt: alt + 40, radius: 50 });
    }
    // --- whales among the clouds
    if (this.floaters?.wMesh) {
      const p = eye.clone().addScaledVector(fwd, hero ? 900 : 650).addScaledVector(right, hero ? 200 : -180).addScaledVector(up, hero ? 260 : 170);
      this._frameAt(p, eye, up, right, hero ? 0.38 : -0.3, hero ? 0.52 : 0.45);
      this.floaters.spawnWhale(p, right.clone().multiplyScalar(-1).addScaledVector(fwd, 0.3).normalize(), hero ? 130 : 120);
      const p2 = p.clone().addScaledVector(fwd, 500).addScaledVector(right, 380).addScaledVector(up, 90);
      this.floaters.spawnWhale(p2, right.clone().multiplyScalar(-1).addScaledVector(fwd, 0.2).normalize(), 70);
    }
    // --- sky jellies drifting over the meadow
    if (this.floaters?.jMesh) {
      const c = eye.clone().addScaledVector(fwd, canopy ? 100 : hero ? 48 : 110).addScaledVector(up, canopy ? -4 : hero ? 10 : 24);
      this.floaters.spawnJellies(c, Math.min(this.floaters.jMax, canopy ? 24 : hero ? 18 : 20), canopy ? 85 : hero ? 34 : 80, undefined, canopy ? 30 : 0);
      this.showcase.jellies = true;
    }
    // --- giants
    if (this.giants?.worm) {
      const d = at(hero ? 780 : 1300, hero ? 160 : -200).normalize();
      this.giants.placeWorm(d, right.clone().multiplyScalar(-1).addScaledVector(fwd, -0.25).normalize(), hero ? 0.25 : 0.1);
    }
    if (this.engine.shotMode && this.engine.params?.get?.('fdebug')) {
      const rep = (n, p) => { if (!p) return n + ':-'; _ndc.copy(p).project(cam); return `${n}:${_ndc.x.toFixed(2)},${_ndc.y.toFixed(2)}`; };
      const f0 = this.birds?.forced[0]?.home, wh = this.floaters?.whales.find((x) => x.forced)?.pos;
      console.warn('[fauna] compose', hero ? 'hero' : 'showcase', rep('herd', this.showcase.herd?.clone().multiplyScalar(R + w.heightAt(this.showcase.herd))), rep('flock', f0), rep('whale', wh), 'fov', cam.fov.toFixed(0));
    }
    if (this.giants?.colossus) {
      const d = at(hero ? 1600 : 2200, hero ? -300 : 400).normalize();
      this.giants.placeColossus(d, right.clone());
    }
  }

  dispose() {
    for (const m of this.mods) { try { m.dispose(); } catch { /* ignore */ } }
    this.root.removeFromParent();
  }
}
