// SystemLevel — the orrery of one star system (engine.universe.system(g, s)).
//
// Star (Star.js), planets with atmospheres, rings and moons (Planets.js), belts
// (Belts.js), comets (Comets.js) and the galactic backdrop (Backdrop.js), laid
// out on real Kepler orbits with log-compressed radii (Layout.js).
// Interaction: OrbitRig; hover → name; click → info card with Land; Esc/map → up.
// Time warp: timeFaster / timeSlower.

import * as THREE from 'three';
import { OrbitRig } from '../../core/OrbitRig.js';
import { AESTHETICS } from '../../universe/Aesthetics.js';
import { makeLayout, DAYS_PER_SEC } from './Layout.js';
import { Backdrop } from './Backdrop.js';
import { Star } from './Star.js';
import { SystemPlanet, bakeSurfaces } from './Planets.js';
import { Belt } from './Belts.js';
import { Comet } from './Comets.js';

const WARPS = [0, 0.25, 1, 4, 16, 64, 256, 1024];
const KIND_LABEL = { terran: 'Terran world', ocean: 'Ocean world', desert: 'Desert world', ice: 'Ice world', lava: 'Lava world', jungle: 'Jungle world', toxic: 'Toxic world', barren: 'Barren world', exotic: 'Exotic world', gas: 'Gas giant' };
const CIV_LABEL = ['None', 'Ruins of the vanished', 'Settled', 'Spacefaring'];
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _p = new THREE.Vector3();
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export default class SystemLevel {
  constructor(engine, addr = {}, opts = {}) {
    this.engine = engine;
    this.addr = { g: addr.g ?? 0, s: addr.s ?? 0 };
    this.opts = opts;
    this.effects = [];
    this.days = 0;
    this.spinT = 0;
    this.warpIdx = 2;
    this.focus = null;
    this.hover = null;
  }

  async load(progress) {
    const E = this.engine, U = E.universe;
    const sys = U.system(this.addr.g, this.addr.s);
    this.sys = sys;
    this.galaxy = U.galaxy(this.addr.g);
    this.layout = makeLayout(sys);
    const L = this.layout;
    progress?.(0.05, `approaching ${sys.star.name}`);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0, 0, 0);
    this.camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.02, 8000);

    this.backdrop = new Backdrop(E, sys, this.galaxy);
    this.scene.add(this.backdrop.group);

    this.star = new Star(E, sys.star, L.starR);
    this.scene.add(this.star.group);
    const starColor = this.star.color;

    // Surfaces baked from each world's real terrain (workers) so orbit and ground agree.
    let bake = new Map();
    try { bake = await bakeSurfaces(sys.planets, E.quality, (p) => progress?.(0.1 + 0.6 * p, 'charting continents')); }
    catch (e) { console.warn('[system] surface bake skipped', e); }

    this.planets = sys.planets.map((p) => new SystemPlanet(E, p, L, starColor, bake));
    for (const sp of this.planets) { this.scene.add(sp.root); this.scene.add(sp.orbit); }
    progress?.(0.8, 'tracing orbits');

    // Belts: keep the real belt's position but nest it in the clearest gap between planet orbits.
    this.belts = [];
    const orbitsV = this.planets.map((sp) => L.rv(sp.planet.orbit.a)).sort((a, b) => a - b);
    for (const b of sys.belts) {
      let rIn = L.rv(b.inner), rOut = L.rv(b.outer);
      if (b.kind !== 'kuiper' && orbitsV.length > 1) {
        const mid = (rIn + rOut) / 2;
        let best = null;
        for (let i = 0; i < orbitsV.length - 1; i++) {
          const lo = orbitsV[i], hi = orbitsV[i + 1], gap = hi - lo;
          const score = Math.abs((lo + hi) / 2 - mid) - gap * 0.6;
          if (gap > 5 && (!best || score < best.score)) best = { lo, hi, gap, score };
        }
        if (best) { rIn = best.lo + best.gap * 0.22; rOut = best.hi - best.gap * 0.22; }
      } else if (b.kind === 'kuiper') {
        const last = orbitsV[orbitsV.length - 1] || 0;
        rIn = Math.max(rIn, last + 14); rOut = Math.max(rOut, rIn + 10);
      }
      const belt = new Belt(E, b, L, starColor, rIn, rOut, sys.star.seed);
      belt.kind = b.kind;
      this.belts.push(belt);
      this.scene.add(belt.group);
    }
    this.comets = sys.comets.map((c, i) => new Comet(E, c, L, starColor, i));
    for (const c of this.comets) this.scene.add(c.group);
    progress?.(0.95, 'igniting');

    const extent = Math.max(60, ...orbitsV) || 90;
    this.extent = extent;
    this.rig = new OrbitRig(this.camera, {
      distance: extent * 1.55, minDistance: 0.05, maxDistance: extent * 7, pitch: 0.42, yaw: 0.7,
      autoRotate: E.shotMode ? 0 : 0.01, damping: 5.5, zoomSpeed: 0.2,
    });
    this.raycaster = new THREE.Raycaster();

    this.grade = {
      exposure: 1.0, agxPunch: 0.55, contrast: 1.1, saturation: 1.12, blackPoint: 0.006, temperature: 0.0,
      vignette: 0.3, vignetteSoftness: 0.6, grain: 0.006, chroma: 0.0, sharpen: 0.12,
      bloomStrength: 0.07, bloomRadius: 0.7, bloomThreshold: 0.0,
      autoExposure: 0.0, flare: 0.16, flareThreshold: 10.0, streak: 0.03, halation: 0.04, look: 'cosmic', lookStrength: 0.5,
    };
    this.crumbs = U.crumbs(this.addr);
    this._update(0, 0);
    progress?.(1, 'ready');
  }

  enter(prev) {
    const E = this.engine;
    E.input.setMode('orbit');
    E.ui.setMode('map');
    E.audio?.setScene?.('system');
    if (!E.shotMode) E.ui.hint([['primary', 'Select world'], ['travel', 'Land'], ['timeFaster', 'Time'], ['escape', 'Up']], 6000);
    // Arriving from a planet: start beside it and pull back.
    const from = this.opts?.from, fa = this.opts?.fromAddr;
    if (from === 'planet' && fa?.p != null) {
      const sp = this.planets.find((x) => x.planet.index === fa.p);
      if (sp) {
        this._pose(sp.position, sp.R * 3, this._yawToward(sp, 1.4), 0.12);
        this.focus = sp;
        setTimeout(() => this._select(sp, false), 400);
      }
    } else if (from === 'galaxy' || prev === 'galaxy') {
      const r = this.rig; r.distance = this.extent * 5; r._logDistTarget = Math.log(r.distance); r.apply();
      r.flyTo(new THREE.Vector3(), this.extent * 1.55, 3.2, { pitch: 0.42, yaw: r.yaw + 0.6 });
    }
    if (!E.shotMode) setTimeout(() => E.ui.arrival?.({ kicker: `${this.sys.star.cls} · ${this.sys.planets.length} worlds`, title: this.sys.star.name, text: this.sys.star.designation, ms: 5200 }), 300);
  }

  // ---- per frame -------------------------------------------------------------------
  update(dt, t) {
    const E = this.engine, I = E.input;
    // time warp
    if (I.pressed('timeFaster')) this._setWarp(this.warpIdx + 1);
    if (I.pressed('timeSlower')) this._setWarp(this.warpIdx - 1);
    const warp = WARPS[this.warpIdx];
    this.days += dt * DAYS_PER_SEC * warp;
    this.spinT += dt * Math.min(warp, 16) * (warp > 0 ? 1 : 0);
    this._update(dt, t);

    // camera follows the focused planet
    if (this.focus) {
      if (this.rig.flying) this.rig._fly.toT.copy(this.focus.position);
      else this.rig.setTarget(this.focus.position, true);
    }
    if (!this._landing) this.rig.update(dt, I);
    else this.rig.update(dt, null);
    // never fly into the star
    const cp = this.camera.position, minR = this.layout.starR * 1.04;
    if (cp.lengthSq() < minR * minR) { cp.setLength(minR); this.camera.lookAt(this.rig.target); }

    this._interact();
    // Keep the projection in sync with the renderer's reversed-Z mode: PostFX restores a projection
    // matrix saved before three flipped camera.reversedDepth on the first frame, which would leave a
    // forward-Z matrix against a reversed depth test (far things drawn over near ones).
    this.camera.updateProjectionMatrix();
    const sel = this.focus;
    if (!E.shotMode) E.ui.telemetry({ Time: warp ? `×${warp}` : 'paused', Day: Math.floor(this.days).toLocaleString(), ...(sel ? { Orbit: `${sel.planet.orbit.a.toFixed(2)} AU` } : {}) });

    if (I.pressed('map')) { E.up(); return; }
    if (I.pressed('escape')) {
      if (this.focus) this._unfocus(); else E.up();
    }
    if (I.pressed('travel') && this.focus && this.focus.planet.landable) this._land(this.focus);
  }

  _update(dt, t) {
    const cam = this.camera;
    for (const sp of this.planets) sp.update(this.days, t, this.spinT);
    for (const b of this.belts) b.update(this.days, t, this.engine.renderer.getPixelRatio());
    for (const c of this.comets) c.update(this.days, t);
    cam.updateMatrixWorld();
    this.star.update(dt, t, cam, this._starVisibility());
    this.backdrop.update(dt, t, cam, this.engine.renderer.getPixelRatio());
    // orbit lines brighten for the hovered / selected world
    const close = this.rig.distance < this.extent * 0.2;
    const far = THREE.MathUtils.smoothstep(this.rig.distance, 3, 30);
    for (const sp of this.planets) {
      sp.orbitMat.uniforms.uHi.value = sp === this.hover || sp === this.focus ? 1 : 0;
      sp.orbitMat.uniforms.uDim.value = sp === this.focus ? 0.6 : close ? 0.1 + 0.4 * far : 1;
    }
  }

  /** Visible fraction of the stellar disk (planets crossing it dim the glare). */
  _starVisibility() {
    const cp = this.camera.position;
    const dS = cp.length();
    if (dS < 1e-6) return 1;
    const aS = Math.asin(Math.min(1, this.layout.starR / dS));
    let vis = 1;
    _w.copy(cp).multiplyScalar(-1 / dS);
    for (const sp of this.planets) {
      _v.copy(sp.position).sub(cp);
      const d = _v.length();
      if (d > dS) continue;
      const aP = Math.asin(Math.min(1, sp.R / d));
      const sep = Math.acos(THREE.MathUtils.clamp(_v.dot(_w) / d, -1, 1));
      const o = THREE.MathUtils.clamp((aP + aS - sep) / (2 * Math.min(aS, aP) + 1e-6), 0, 1);
      vis = Math.min(vis, 1 - o * Math.min(1, (aP / aS) ** 2));
    }
    return vis;
  }

  _setWarp(i) {
    this.warpIdx = THREE.MathUtils.clamp(i, 0, WARPS.length - 1);
    const w = WARPS[this.warpIdx];
    this.engine.ui.hint(w ? `Time ×${w} · ${(w * DAYS_PER_SEC).toLocaleString()} days per second` : 'Time paused', 1800);
  }

  // ---- picking & UI ---------------------------------------------------------------------
  _pick(px, py) {
    const cam = this.camera, W = window.innerWidth, H = window.innerHeight;
    let best = null, bestD = Infinity;
    const f = 1 / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    for (const sp of this.planets) {
      _v.copy(sp.position).project(cam);
      if (_v.z > 1 || _v.z < -1) continue;
      const sx = (_v.x * 0.5 + 0.5) * W, sy = (-_v.y * 0.5 + 0.5) * H;
      const dist = cam.position.distanceTo(sp.position);
      const rPx = (sp.R / dist) * f * H * 0.5;
      const d = Math.hypot(sx - px, sy - py);
      if (d < Math.max(16, rPx + 8) && d - rPx < bestD) { bestD = d - rPx; best = sp; }
    }
    return best;
  }

  _interact() {
    const E = this.engine, I = E.input, ui = E.ui;
    const ptr = I.pointer;
    this.hover = ptr && ptr.inside !== false && !I.isTouch ? this._pick(ptr.x, ptr.y) : null;
    const far = this.rig.distance > this.extent * 0.6;
    for (const sp of this.planets) {
      const p = sp.planet;
      const hov = sp === this.hover;
      if (hov || sp === this.focus || (far && !E.shotMode)) {
        _p.copy(sp.position); _p.y += sp.R * 1.15;
        ui.labelWorld?.(`sys-${p.index}`, _p, this.camera, p.name, { sub: hov ? `${KIND_LABEL[p.kind] || p.kind}${p.aesthetic ? ' · ' + (AESTHETICS[p.aesthetic]?.name || '') : ''}` : '', hover: hov, kind: 'planet' });
      }
    }
    if (this.hover) this.engine.canvas.style.cursor = 'pointer';
    else if (this.engine.canvas.style.cursor === 'pointer') this.engine.canvas.style.cursor = '';
    const c = I.click;
    if (c && !this._landing) {
      const sp = this._pick(c.x, c.y);
      if (sp) {
        if (sp === this.focus && I.doubleClick && sp.planet.landable) this._land(sp);
        else this._select(sp, true);
      }
    }
  }

  _yawToward(sp, offset) {
    // yaw so the camera sits `offset` radians around from the star direction (lit side in view)
    const sx = -sp.position.x, sz = -sp.position.z;
    return Math.atan2(sx, sz) + offset;
  }

  _select(sp, fly = true) {
    const E = this.engine, p = sp.planet;
    this.focus = sp;
    if (fly) {
      const yaw = this.rig.yaw + wrapPi(this._yawToward(sp, 0.95) - this.rig.yaw);
      this.rig.flyTo(sp.position, (sp.planet.rings ? sp.ringOut : sp.R) * 3.6, 2.4, { yaw, pitch: 0.2 });
    }
    const A = p.aesthetic ? AESTHETICS[p.aesthetic] : null;
    const civ = p.civ;
    const rows = [
      ['Kind', KIND_LABEL[p.kind] || p.kind],
      ['Gravity', `${p.gravityG.toFixed(2)} g`],
      ['Temperature', `${Math.round(p.tempK - 273.15)} °C`],
      ['Orbit', `${p.orbit.a.toFixed(2)} AU · ${Math.round(p.orbit.periodDays)} days`],
      ['Moons', String(p.moons.length)],
      ['Civilization', `${CIV_LABEL[civ.level] || '—'}${civ.culture && civ.level >= 2 ? ' · the ' + civ.culture : ''}${civ.population ? ' · ' + fmtPop(civ.population) : ''}`],
    ];
    if (A) rows.push(['Aesthetic', `${A.name} — ${A.inspiration}`]);
    E.ui.info({
      title: p.name,
      subtitle: `${p.designation} · ${p.lore?.epithet || ''}`,
      rows,
      text: p.lore?.myth ? `<i>${p.lore.myth}</i>` : '',
      actions: p.landable ? [{ label: 'Land', primary: true, onClick: () => this._land(sp) }] : [],
    });
    E.audio?.sfx?.('ui');
  }

  _unfocus() {
    this.focus = null;
    this.engine.ui.info(null);
    this.rig.flyTo(new THREE.Vector3(), this.extent * 1.55, 2.4, { pitch: 0.42 });
  }

  async _land(sp) {
    if (this._landing || !sp.planet.landable) return;
    this._landing = true;
    this.focus = sp;
    this.engine.ui.info(null);
    const yaw = this.rig.yaw + wrapPi(this._yawToward(sp, 0.6) - this.rig.yaw);
    await this.rig.flyTo(sp.position, sp.R * 1.5, 1.7, { yaw, pitch: 0.1 });
    const ok = await this.engine.go('planet', { g: this.addr.g, s: this.addr.s, p: sp.planet.index }, { from: 'system' });
    if (!ok) this._landing = false;
  }

  // ---- shots (harness) -------------------------------------------------------------------
  _pose(target, distance, yaw, pitch) {
    const r = this.rig;
    r._fly = null;
    r.target.copy(target); r._targetGoal.copy(target);
    r.distance = distance; r._logDistTarget = Math.log(distance);
    r.yaw = yaw; r.pitch = pitch; r._yawV = 0; r._pitchV = 0; r.autoRotate = 0; r._idle = 0;
    r.apply();
  }
  _poseDir(target, distance, dir) {
    dir.normalize();
    this._pose(target, distance, Math.atan2(dir.x, dir.z), Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)));
  }
  _poseCam(camPos, lookAt) {
    const d = camPos.clone().sub(lookAt);
    const dist = d.length();
    this._poseDir(lookAt, dist, d);
  }
  _planet(i) { return this.planets.find((x) => x.planet.index === i) || this.planets[0]; }

  get shots() {
    const L = this.layout;
    return {
      hero: async () => {
        // beside the ringed giant at a ~115° phase angle: a lit crescent with open rings in the
        // foreground, the star and the inner worlds strung along their orbits beyond it
        const sp = this.planets.find((x) => x.planet.rings) || this._planet(2);
        this.focus = null;
        const P = sp.position, R = sp.R;
        const s = P.clone().multiplyScalar(-1).normalize(), up = new THREE.Vector3(0, 1, 0);
        const t = new THREE.Vector3().crossVectors(up, s).normalize();
        const ph = THREE.MathUtils.degToRad(100);
        const dirC = s.clone().multiplyScalar(Math.cos(ph)).addScaledVector(t, Math.sin(ph)).addScaledVector(up, 0.4).normalize();
        const cam = P.clone().addScaledVector(dirC, R * 10.5);
        const look = P.clone().lerp(new THREE.Vector3(0, 0, 0), 0.3).addScaledVector(up, -R * 1.2);
        this._poseCam(cam, look);
      },
      overview: async () => { this.focus = null; this._pose(new THREE.Vector3(), this.extent * 1.55, 0.7, 0.55); },
      star: async () => {
        this.focus = null;
        const R = L.starR;
        const d0 = new THREE.Vector3(0.05, 0.22, -1).normalize();
        const side = new THREE.Vector3().crossVectors(d0, new THREE.Vector3(0, 1, 0)).normalize();
        const dir = side.clone().multiplyScalar(-1).addScaledVector(d0, 0.32);
        this._poseDir(d0.clone().multiplyScalar(R * 0.92), R * 0.95, dir);
      },
      gasgiant: async () => {
        const sp = this.planets.find((x) => x.planet.kind === 'gas' && x.planet.rings) || this.planets.find((x) => x.planet.kind === 'gas') || this._planet(5);
        this.focus = sp;
        const s = sp.position.clone().multiplyScalar(-1).normalize();
        const dir = s.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.9);
        dir.addScaledVector(sp.ringN, 0.42);
        this._poseDir(sp.position, (sp.ringOut || sp.R * 2) * 2.25, dir);
      },
      planet: async () => {
        const sp = this._planet(2);
        this.focus = sp;
        const s = sp.position.clone().multiplyScalar(-1).normalize();
        const dir = s.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 1.5);
        dir.y += 0.3;
        this._poseDir(sp.position, sp.R * 2.9, dir);
      },
      belt: async () => {
        this.focus = null;
        const b = this.belts.find((x) => x.kind !== 'kuiper') || this.belts[0];
        if (!b) { this._pose(new THREE.Vector3(), this.extent, 0.4, 0.1); return; }
        // a big boulder at ~75° phase (mostly lit, hard terminator), the star low in the frame corner,
        // the belt streaming away toward it
        let best = b.instances[0];
        for (const it of b.instances) if (it.s > best.s) best = it;
        const pos = b.instancePosition(best, this.days, new THREE.Vector3());
        const S = best.s;
        const s = pos.clone().multiplyScalar(-1).normalize(), up = new THREE.Vector3(0, 1, 0);
        const t = new THREE.Vector3().crossVectors(up, s).normalize();
        const ph = THREE.MathUtils.degToRad(138);
        const dirC = s.clone().multiplyScalar(Math.cos(ph)).addScaledVector(t, Math.sin(ph)).addScaledVector(up, 0.1).normalize();
        const cam = pos.clone().addScaledVector(dirC, S * 4.6);
        // aim between the rock (left) and the star (right) so the boulder is rim-lit against the glare
        const toRock = pos.clone().sub(cam).normalize(), toStar = cam.clone().multiplyScalar(-1).normalize();
        const look = cam.clone().addScaledVector(toRock.add(toStar).normalize(), S * 4.0);
        this._poseCam(cam, look);
      },
    };
  }

  onResize(w, h) { if (this.camera) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); } }

  exit() { this.engine.ui.clearLabels?.(); this.engine.ui.telemetry(null); if (this.engine.canvas.style.cursor === 'pointer') this.engine.canvas.style.cursor = ''; }

  dispose() {
    this.backdrop?.dispose(); this.star?.dispose();
    for (const p of this.planets || []) p.dispose();
    for (const b of this.belts || []) b.dispose();
    for (const c of this.comets || []) c.dispose();
  }
}

function fmtPop(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} billion`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} million`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} thousand`;
  return String(n);
}
