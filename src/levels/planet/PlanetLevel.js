// PlanetLevel — one seamless world from orbit down to a blade of grass.
//
// The level is an orchestrator: it owns the World (physics truth), camera,
// sun/sky light, shared uniforms and the list of SUBSYSTEMS. Each subsystem
// lives in its own module (owned by a different sub-project) and plugs in via:
//
//   export default class X {
//     constructor(level)              // level.world, level.scene, level.camera, level.engine …
//     async init(progress)            // build resources
//     update(dt, t)                   // per frame (in `order`)
//     lateUpdate?(dt, t)              // after every update (camera rigs, LOD)
//     effects?                        // array of PostFX effects (HDR, before bloom)
//     shot?(name, spot)               // optional: pose for a screenshot preset
//     dispose()
//   }
//   X.order = 20                      // static number, lower updates first
//
// A subsystem that fails to load is skipped (logged) — the world still runs.

import * as THREE from 'three';
import { World } from './World.js';
import { OrbitRig } from '../../core/OrbitRig.js';
import { AESTHETICS } from '../../universe/Aesthetics.js';

export const SUBSYSTEMS = [
  ['terrain', () => import('./terrain/Terrain.js')],
  ['ocean', () => import('./ocean/Ocean.js')],
  ['sky', () => import('./atmosphere/Sky.js')],
  ['atmosphere', () => import('./atmosphere/Atmosphere.js')],
  ['clouds', () => import('./atmosphere/Clouds.js')],
  ['weather', () => import('./atmosphere/Weather.js')],
  ['flora', () => import('./flora/Flora.js')],
  ['fauna', () => import('./fauna/Fauna.js')],
  ['civ', () => import('./civ/Civilization.js')],
  ['vehicles', () => import('../../vehicles/Vehicles.js')],
  ['player', () => import('../../player/Player.js')],
];

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

export default class PlanetLevel {
  constructor(engine, addr, opts = {}) {
    this.engine = engine;
    this.addr = addr;
    this.opts = opts;
    this.planet = engine.universe.planet(addr.g ?? 0, addr.s ?? 0, addr.p ?? 2);
    this.star = engine.universe.star(addr.g ?? 0, addr.s ?? 0);
    if (!this.planet.landable) {
      // Gas giants are viewed from orbit only; pick the first landable sibling.
      const sys = engine.universe.system(addr.g ?? 0, addr.s ?? 0);
      const alt = sys.planets.find((p) => p.landable);
      if (alt) { this.planet = alt; this.addr = { ...addr, p: alt.index }; }
    }
    this.aesthetic = this.planet.aesthetic ? AESTHETICS[this.planet.aesthetic] : null;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.05, 2e7);
    this.scene.add(this.camera);
    this.effects = [];
    this.subsystems = [];
    this.sys = {}; // by name
    this.mode = 'orbit'; // 'orbit' | 'onfoot' | 'bike' | 'ship'
    this.player = null; // set by the player subsystem
    this.vehicles = null; // set by the vehicles subsystem
    this.freeCam = null; // { position, target } — overrides camera (shots/debug)
    this.ready = false;
    this.crumbs = engine.universe.crumbs(this.addr);
    const A = this.aesthetic;
    this.grade = {
      exposure: 1.0, contrast: 1.04, saturation: 1.04, bloomStrength: 0.05, vignette: 0.26, grain: 0.03, chroma: 0.0018, temperature: 0, tint: 0,
      ...(A?.grade || {}),
    };
  }

  async load(progress) {
    progress(0.05, `approaching ${this.planet.name}`);
    this.world = new World(this.planet, this);
    this.world.dayLength = this.engine.shotMode ? 1e9 : 26 * 60;
    this._setupLights();
    // Subsystems load in parallel; each failure is isolated.
    const total = SUBSYSTEMS.length;
    let done = 0;
    const mods = await Promise.all(SUBSYSTEMS.map(async ([name, loader]) => {
      try { const m = await loader(); return [name, m.default || m[Object.keys(m)[0]]]; }
      catch (e) { console.warn(`[planet] subsystem "${name}" unavailable:`, e); return null; }
    }));
    const entries = mods.filter(Boolean).map(([name, Cls]) => ({ name, Cls, order: Cls.order ?? 50 }));
    entries.sort((a, b) => a.order - b.order);
    for (const { name, Cls } of entries) {
      try {
        const inst = new Cls(this);
        inst.__name = name;
        this.subsystems.push(inst); this.sys[name] = inst;
      } catch (e) { console.warn(`[planet] subsystem "${name}" failed to construct:`, e); }
    }
    await Promise.all(this.subsystems.map(async (s) => {
      try { await s.init?.((p) => progress(0.1 + 0.85 * ((done + (p || 0)) / total))); }
      catch (e) { console.warn(`[planet] subsystem "${s.__name}" init failed:`, e); this.subsystems = this.subsystems.filter((x) => x !== s); delete this.sys[s.__name]; }
      done++; progress(0.1 + 0.85 * (done / total));
    }));
    this._collectEffects();
    // Fallback camera rig (used when no player subsystem drives the camera).
    this.rig = new OrbitRig(this.camera, { distance: this.world.radius * 3.2, minDistance: this.world.radius * 1.05, maxDistance: this.world.radius * 12, yaw: 0.4, pitch: 0.25, autoRotate: 0.02 });
    // Initial time: pleasant morning light at the first settlement (or spawn site).
    const spawnDir = this.world.sites[0]?.dir || new THREE.Vector3(0.3, 0.5, 0.8).normalize();
    this.world.focus.copy(spawnDir).multiplyScalar(this.world.radius);
    const tod = this.engine.params.get('time');
    this.world.setTimeOfDay(tod != null ? parseFloat(tod) : 0.32, spawnDir);
    const spawn = this.opts.spawn || this.engine.params.get('spawn') || 'orbit';
    this.player?.spawn?.(spawn);
    this.ready = true;
    progress(1);
  }

  _collectEffects() {
    this.effects = [];
    for (const s of this.subsystems) if (Array.isArray(s.effects)) this.effects.push(...s.effects);
  }

  _setupLights() {
    const sunColor = new THREE.Color().setRGB(...this.star.color);
    this.sunColor = sunColor;
    const sun = new THREE.DirectionalLight(sunColor, 3.2);
    sun.castShadow = true;
    const sm = this.engine.quality.shadowMapSize;
    sun.shadow.mapSize.set(sm, sm);
    const s = 70;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 1200 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    const P = this.aesthetic?.palette;
    this.hemi = new THREE.HemisphereLight(new THREE.Color(P?.sky || '#9fc4ff'), new THREE.Color(P?.ground?.[0] || '#55503a'), 0.55);
    this.scene.add(this.hemi);
  }

  _updateLights() {
    const w = this.world;
    const focus = this.player?.position || this.camera.position;
    const up = _v.copy(focus).normalize();
    // Shadow frustum follows the focus point.
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(w.sunDir, 600);
    this.sun.target.updateMatrixWorld();
    const elev = up.dot(w.sunDir);
    const d = w.daylight;
    // Warm low sun, white high sun.
    const warm = THREE.MathUtils.smoothstep(elev, -0.05, 0.35);
    this.sun.color.copy(this.sunColor).lerp(_tmpC.setRGB(1.0, 0.55, 0.32), 1 - warm);
    this.sun.intensity = 3.4 * d;
    this.sun.castShadow = d > 0.02 && w.altitude(focus) < 3000;
    this.hemi.intensity = 0.06 + 0.5 * d;
    this.hemi.position.copy(up);
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.engine.ui.setMode(mode === 'orbit' ? 'map' : mode);
    for (const s of this.subsystems) s.onModeChange?.(mode);
    this.engine.emit('planet-mode', { mode });
  }

  enter() {
    this.engine.audio.setScene('planet', this.aesthetic?.music || null);
    this.engine.input.setMode(this.player ? 'game' : 'orbit');
    this.engine.ui.setMode(this.mode === 'orbit' ? 'map' : this.mode);
    const P = this.planet;
    const A = this.aesthetic;
    this.engine.ui.toast(P.name, P.lore?.myth || '', 9000);
    if (!this.player) this.engine.ui.hint('Drag to orbit · scroll to zoom · Esc to leave', 5000);
    this._infoCard();
  }

  _infoCard() {
    const P = this.planet, A = this.aesthetic;
    this.engine.ui.info({
      subtitle: `${P.designation} · ${P.kind}`,
      title: P.name,
      rows: [
        ['gravity', `${P.gravityG.toFixed(2)} g`],
        ['mean temp', `${Math.round(P.tempK - 273)} °C`],
        ['day', `${P.dayLengthHours.toFixed(1)} h`],
        ['civilization', ['none', 'ruins', 'villages', 'towns', 'cities', 'megacities'][P.civ.level] || '—'],
        A ? ['aesthetic', A.name] : null,
      ].filter(Boolean),
      text: A ? `${A.mood}. <br><span style="opacity:.6">after ${A.inspiration}</span>` : '',
    });
    setTimeout(() => { if (this.engine.level === this) this.engine.ui.info(null); }, 9000);
  }

  update(dt, t) {
    const input = this.engine.input;
    if (input.pressed('escape') || input.pressed('map')) {
      if (!(this.player?.handlesEscape?.())) { this.engine.up(); return; }
    }
    const focus = this.player?.position || this.camera.position;
    this.world.update(dt, t, focus);
    for (const s of this.subsystems) { try { s.update?.(dt, t); } catch (e) { this._err(s, e); } }
    if (!this.player || this.freeCam) this._fallbackCamera(dt);
    for (const s of this.subsystems) { try { s.lateUpdate?.(dt, t); } catch (e) { this._err(s, e); } }
    this._updateCameraPlanes();
    this._updateLights();
    this.world.uniforms.uCameraPos.value.copy(this.camera.position);
  }

  _err(s, e) {
    s.__errs = (s.__errs || 0) + 1;
    if (s.__errs < 3) console.error(`[planet] ${s.__name}:`, e);
  }

  _fallbackCamera(dt) {
    if (this.freeCam) {
      this.camera.position.copy(this.freeCam.position);
      this.camera.up.copy(this.freeCam.up || _v2.copy(this.freeCam.position).normalize());
      this.camera.lookAt(this.freeCam.target);
      return;
    }
    this.rig.update(dt, this.engine.input);
  }

  _updateCameraPlanes() {
    const cam = this.camera;
    const alt = Math.max(0.5, this.world.altitude(cam.position));
    if (this.engine.reversedDepth) {
      cam.near = THREE.MathUtils.clamp(alt * 0.01, 0.05, 200);
      cam.far = 2e7;
    } else {
      cam.near = THREE.MathUtils.clamp(alt * 0.02, 0.1, 2000);
      cam.far = Math.max(cam.near * 2e5, 5000);
    }
    cam.updateProjectionMatrix();
  }

  onResize(w, h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }

  exit() {}
  dispose() {
    for (const s of this.subsystems) { try { s.dispose?.(); } catch (e) { console.warn(e); } }
    this.scene.traverse((o) => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.()); });
  }

  // ---- screenshot presets ---------------------------------------------------------
  /** A scenic spot near a settlement: returns { dir, position, lookAt }. */
  scenicSpot(siteIndex = 0, distance = 420, heightAbove = 2) {
    const w = this.world;
    const site = w.sites[siteIndex] || w.sites[0];
    const base = site ? site.dir.clone() : new THREE.Vector3(0.3, 0.5, 0.8).normalize();
    // Walk outward from the site toward the highest nearby ground for a view.
    let best = null;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const t1 = new THREE.Vector3(0, 1, 0).cross(base).normalize(), t2 = base.clone().cross(t1).normalize();
      const dir = base.clone().addScaledVector(t1, Math.cos(a) * distance / w.radius).addScaledVector(t2, Math.sin(a) * distance / w.radius).normalize();
      const h = w.heightAt(dir);
      if (w.hasOcean && h < w.seaLevel + 1) continue;
      if (!best || h > best.h) best = { dir, h };
    }
    if (!best) best = { dir: base, h: w.heightAt(base) };
    const position = best.dir.clone().multiplyScalar(w.radius + Math.max(best.h, w.hasOcean ? w.seaLevel : -1e9) + heightAbove);
    const lookAt = site ? site.position.clone() : base.clone().multiplyScalar(w.radius);
    return { dir: best.dir, position, lookAt, site };
  }

  get shots() {
    const w = this.world;
    const delegate = async (name, spot) => {
      for (const s of this.subsystems) if (s.shot) { try { if (await s.shot(name, spot)) return true; } catch (e) { console.warn(e); } }
      return false;
    };
    const free = (pos, target) => { this.freeCam = { position: pos.clone(), target: target.clone() }; };
    return {
      orbit: async () => {
        const dir = (w.sites[0]?.dir || new THREE.Vector3(0.3, 0.5, 0.8)).clone();
        w.setTimeOfDay(0.62, dir);
        const side = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
        free(dir.clone().multiplyScalar(w.radius * 2.6).addScaledVector(side, w.radius * 0.9), new THREE.Vector3());
        await delegate('orbit', null);
      },
      approach: async () => {
        const spot = this.scenicSpot(0, 2000, 0);
        w.setTimeOfDay(0.3, spot.dir);
        const up = spot.dir.clone();
        const pos = spot.position.clone().addScaledVector(up, 4500);
        const tgt = spot.lookAt.clone().addScaledVector(up, 300);
        if (!(await delegate('approach', { ...spot, position: pos, lookAt: tgt }))) free(pos, tgt);
      },
      vista: async () => {
        const spot = this.scenicSpot(0, 520, 2);
        w.setTimeOfDay(0.29, spot.dir);
        if (!(await delegate('vista', spot))) free(spot.position.clone().addScaledVector(spot.dir, 1.6), spot.lookAt);
      },
      character: async () => {
        const spot = this.scenicSpot(0, 300, 0);
        w.setTimeOfDay(0.36, spot.dir);
        if (!(await delegate('character', spot))) free(spot.position.clone().addScaledVector(spot.dir, 3), spot.lookAt);
      },
      fp: async () => {
        const spot = this.scenicSpot(0, 240, 0);
        w.setTimeOfDay(0.42, spot.dir);
        if (!(await delegate('fp', spot))) free(spot.position.clone().addScaledVector(spot.dir, 1.7), spot.lookAt);
      },
      city: async () => {
        const spot = this.scenicSpot(0, 700, 60);
        w.setTimeOfDay(0.78, spot.dir);
        if (!(await delegate('city', spot))) free(spot.position, spot.lookAt);
      },
      night: async () => {
        const spot = this.scenicSpot(0, 400, 2);
        w.setTimeOfDay(0.02, spot.dir);
        const up = spot.dir.clone();
        const tgt = spot.position.clone().addScaledVector(up, 900).add(spot.lookAt.clone().sub(spot.position).setLength(600));
        if (!(await delegate('night', { ...spot, lookAt: tgt }))) free(spot.position.clone().addScaledVector(up, 1.7), tgt);
      },
      ocean: async () => {
        // find a coastline
        let spot = null;
        for (let i = 0; i < w.sites.length && !spot; i++) { const s = this.scenicSpot(i, 260, 1.5); if (w.hasOcean) spot = s; }
        spot = spot || this.scenicSpot(0, 260, 1.5);
        w.setTimeOfDay(0.72, spot.dir);
        if (!(await delegate('ocean', spot))) free(spot.position.clone().addScaledVector(spot.dir, 2), spot.lookAt);
      },
      bike: async () => {
        const spot = this.scenicSpot(0, 600, 0);
        w.setTimeOfDay(0.33, spot.dir);
        if (!(await delegate('bike', spot))) free(spot.position.clone().addScaledVector(spot.dir, 4), spot.lookAt);
      },
      ship: async () => {
        const spot = this.scenicSpot(0, 900, 120);
        w.setTimeOfDay(0.7, spot.dir);
        if (!(await delegate('ship', spot))) free(spot.position, spot.lookAt);
      },
    };
  }
}

const _tmpC = new THREE.Color();
