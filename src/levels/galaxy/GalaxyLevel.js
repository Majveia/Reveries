// Galaxy level: a Hubble/JWST-grade galaxy you can fly through, from the whole
// disk down to parsecs and into the event horizon of its central black hole.
//
//   effects: GalaxyVolume (diffuse starlight + dust, half-res raymarch)
//          → OverlayPass (catalog stars with per-star dust extinction, clusters,
//            HII knots, nested local star fields, system markers)
//          → Nebulae (raymarched emission nebulae, half-res)
//          → BlackHole (Schwarzschild geodesics, accretion disk, lensing)
//
// Units: kpc. Galaxy plane = xz, y up (Universe.galaxySample convention).

import * as THREE from 'three';
import { OrbitRig } from '../../core/OrbitRig.js';
import { galaxyParams, buildMaps, makeNoise3D, placeNebulae } from './GalaxyModel.js';
import { GalaxyVolume } from './GalaxyVolume.js';
import { Stars, OverlayPass } from './Stars.js';
import { Nebulae } from './Nebulae.js';
import { BlackHole } from './BlackHole.js';
import { DeepSky } from './Sky.js';

const TYPE_LABEL = { spiral: 'Spiral galaxy', barred: 'Barred spiral galaxy', elliptical: 'Elliptical galaxy', irregular: 'Irregular galaxy', lenticular: 'Lenticular galaxy', ring: 'Ring galaxy' };
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();

export default class GalaxyLevel {
  constructor(engine, addr, opts = {}) {
    this.engine = engine;
    this.addr = { g: addr.g ?? 0 };
    this.opts = opts;
    this.effects = [];
    this.hover = -1;
    this.selected = -1;
    this._pickTimer = 0;
  }

  async load(progress) {
    const E = this.engine, U = E.universe, q = E.quality;
    const g = (this.g = U.galaxy(this.addr.g));
    const P = (this.P = galaxyParams(g));
    progress?.(0.05, 'mapping the galaxy');
    this.scene = new THREE.Scene();
    this.overlay = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.001, 2000);

    // Nebulae first: their positions are carved into the HII map
    this.nebulaList = placeNebulae(U, g, g.type === 'elliptical' ? 0 : g.type === 'lenticular' ? 1 : 6);
    const mapSize = E.shotMode ? 2048 : q.pick(1024, 1536, 2048, 2048);
    this.mapRT = buildMaps(E.renderer, P, mapSize, this.nebulaList);
    progress?.(0.12, 'weaving dust');
    this.noise3D = makeNoise3D(q.level <= 0 ? 48 : 64, g.seed);
    const mapTexel = (2 * P.extent) / mapSize;
    // shared galaxy uniforms (same objects in every material)
    this.gu = {
      uMap: { value: this.mapRT.texture }, uExtent: { value: P.extent }, uHOld: { value: P.hOld }, uHYoung: { value: P.hYoung },
      uHDust: { value: P.hDust }, uKappa: { value: 5.0 }, uMapTexel: { value: mapTexel },
    };

    this.volume = new GalaxyVolume(E, P, this.mapRT, this.noise3D);
    this.volume.march.uniforms.uKappa = this.gu.uKappa;

    this.stars = new Stars(this, P, this.gu);
    this.stars.build(g, progress);
    progress?.(0.7, 'cataloguing star systems');
    this.stars.buildSystems(g, 2000);
    this.overlay.add(this.stars.group);
    this.overlayPass = new OverlayPass(this.overlay);

    progress?.(0.8, 'lighting nebulae');
    this.nebulae = new Nebulae(E, P, this.nebulaList, this.noise3D, this.gu);
    progress?.(0.9, 'bending light');
    this.blackHole = new BlackHole(E, g);
    this.blackHole.setNoise(this.noise3D);
    if (this.nebulaList.length) this.stars.addPoints(this.nebulae.clusterGeo, 0.02);

    this.deepSky = new DeepSky(E, g);
    this.scene.add(this.deepSky.points);

    this.effects = [this.volume, this.overlayPass, this.nebulae, this.blackHole];
    // debug: ?gdbg=volume,overlay,nebulae,bh disables those effects
    const dbg = (E.params.get('gdbg') || '').split(',');
    if (dbg.includes('volume')) this.volume.enabled = false;
    if (dbg.includes('overlay')) this.overlayPass.enabled = false;
    if (dbg.includes('sky')) this.deepSky.points.visible = false;
    this._noBH = dbg.includes('bh'); this._noNeb = dbg.includes('nebulae');

    this.rig = new OrbitRig(this.camera, {
      distance: P.R * 2.5, minDistance: this.blackHole.rs * 3.2, maxDistance: P.R * 8, pitch: 0.75, yaw: 0.4,
      autoRotate: E.shotMode ? 0 : 0.012, damping: 5, zoomSpeed: 0.22,
    });

    this.grade = {
      exposure: 1.0, agxPunch: 0.55, contrast: 1.14, saturation: 1.2, blackPoint: 0.006,
      vignette: 0.32, grain: 0.012, bloomStrength: 0.085, bloomRadius: 0.8, chroma: 0.0015, temperature: 0.0,
    };
    this.crumbs = U.crumbs(this.addr);
    this._makeLabels();
    progress?.(1, 'ready');
  }

  // ---- UI -------------------------------------------------------------------------
  _makeLabels() {
    const mk = (cls) => {
      const el = document.createElement('div');
      el.className = cls;
      el.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:5;font:500 11px/1.2 var(--rv-font, system-ui);letter-spacing:.12em;text-transform:uppercase;color:rgba(235,240,255,.86);text-shadow:0 0 8px #000,0 0 2px #000;white-space:nowrap;opacity:0;transition:opacity .35s;will-change:transform';
      document.body.appendChild(el);
      return el;
    };
    this.hoverEl = mk('rv-gal-hover');
    this.homeEl = mk('rv-gal-home');
    if (this.g.id === 0) this.homeEl.innerHTML = '<span style="opacity:.55;font-weight:400">home ·</span> Aurelia';
    if (this.engine.params.get('ui') === '0' || this.engine.shotMode && this.engine.params.get('ui') !== '1') {
      this.hoverEl.style.display = 'none'; this.homeEl.style.display = 'none';
    }
  }

  _placeLabel(el, pos, dx = 14, dy = -6) {
    _p.copy(pos).project(this.camera);
    if (_p.z > 1 || _p.z < -1 || Math.abs(_p.x) > 1.1 || Math.abs(_p.y) > 1.1) { el.style.opacity = '0'; return false; }
    const x = (_p.x * 0.5 + 0.5) * innerWidth, y = (-_p.y * 0.5 + 0.5) * innerHeight;
    el.style.transform = `translate(${Math.round(x + dx)}px, ${Math.round(y + dy)}px)`;
    return true;
  }

  _starCard(i) {
    const sys = this.stars.systems[i];
    const s = sys.star;
    const E = this.engine;
    const hz = s.hz ? `${s.hz[0]?.toFixed?.(2) ?? s.hz.inner?.toFixed(2)}–${s.hz[1]?.toFixed?.(2) ?? s.hz.outer?.toFixed(2)} AU` : '—';
    E.ui.info({
      title: s.name,
      subtitle: `${s.designation || ''} · ${s.cls}`,
      rows: [
        ['Class', s.cls], ['Temperature', `${Math.round(s.temp).toLocaleString()} K`], ['Mass', `${s.massSun.toFixed(2)} M☉`],
        ['Luminosity', `${s.lumSun < 0.01 ? s.lumSun.toExponential(1) : s.lumSun.toFixed(2)} L☉`], ['Planets', String(s.planetCount)],
        ['Habitable zone', hz], ['Distance from core', `${sys.pos.length().toFixed(2)} kpc`],
      ],
      actions: [
        { label: 'Travel', primary: true, onClick: () => this.travel(i) },
        { label: 'Close', onClick: () => { this.selected = -1; E.ui.info(null); } },
      ],
    });
  }

  select(i) {
    this.selected = i;
    if (i < 0) { this.engine.ui.info(null); return; }
    this._starCard(i);
    this.engine.audio?.sfx?.('ui');
  }

  async travel(i) {
    const sys = this.stars.systems[i];
    if (!sys || this._travelling) return;
    this._travelling = true;
    this.engine.ui.info(null);
    await this.rig.flyTo(sys.pos, 0.004, 2.0);
    this._travelling = false;
    this.engine.go('system', { g: this.g.id, s: i });
  }

  _pick(ndcX, ndcY, maxPx = 14) {
    const sys = this.stars.systems;
    if (!sys) return -1;
    const cam = this.camera;
    const w = innerWidth, h = innerHeight;
    let best = -1, bestD = maxPx * maxPx;
    const near = this.stars.markMat.uniforms.uNear.value;
    for (let i = 0; i < sys.length; i++) {
      const p = sys[i].pos;
      const d = cam.position.distanceTo(p);
      if (d > near && i !== 0) continue;
      _v.copy(p).project(cam);
      if (_v.z > 1) continue;
      const dx = (_v.x - ndcX) * 0.5 * w, dy = (_v.y - ndcY) * 0.5 * h;
      const dd = dx * dx + dy * dy;
      if (dd < bestD) { bestD = dd; best = i; }
    }
    return best;
  }

  enter() {
    const E = this.engine;
    E.input.setMode('orbit');
    E.ui.setMode?.('map');
    if (!E.shotMode) E.ui.hint('Drag to orbit · scroll to dive · click a marked star', 5200);
    E.audio?.setScene?.('galaxy');
    if (this.opts.from === 'system' && this.opts.fromAddr?.s != null) {
      const sys = this.stars.systems[this.opts.fromAddr.s];
      if (sys) { this.rig.setTarget(sys.pos, true); this.rig.distance = 0.02; this.rig._logDistTarget = Math.log(0.02); this.rig.flyTo(sys.pos, 1.2, 2.5); }
    }
  }

  update(dt, t) {
    const E = this.engine, inp = E.input;
    this.rig.update(dt, this._travelling ? null : inp);
    // dynamic clip planes: from 20 Rs to the whole galaxy
    const camD = this.camera.position.length();
    const near = Math.max(this.blackHole.rs * 0.05, Math.min(this.rig.distance, camD) * 0.002);
    if (Math.abs(near - this.camera.near) / this.camera.near > 0.05) { this.camera.near = near; this.camera.far = Math.max(this.P.R * 20, near * 1e7); this.camera.updateProjectionMatrix(); }
    this.camera.updateMatrixWorld();
    this.stars.update(this.camera, E.height || innerHeight);
    this.deepSky.update(this.camera, E.height || innerHeight);
    this.nebulae.update(this.camera, t);
    this.blackHole.update(this.camera, t);
    if (this._noBH) this.blackHole.enabled = false;
    if (this._noNeb) this.nebulae.enabled = false;
    // inside the bulge the diffuse light resolves into the point-star layers
    const coreD = this.camera.position.length();
    this.volume.march.uniforms.uNearFade.value = THREE.MathUtils.clamp(this.rig.distance * 4, 0.12, 0.7);
    this.volume.march.uniforms.uBulgeDim.value = THREE.MathUtils.lerp(0.05, 1, THREE.MathUtils.smoothstep(coreD, 0.002, 0.3));

    // markers: visible within ~a kpc of the camera
    const mu = this.stars.markMat.uniforms;
    mu.uNear.value = THREE.MathUtils.clamp(this.rig.distance * 2.5, 0.08, 1.6);
    mu.uHover.value = this.hover; mu.uSel.value = this.selected;

    // hover / click picking (map levels: pointer is free)
    if (!this._travelling) {
      this._pickTimer -= dt;
      const pt = inp.pointer;
      if (pt && this._pickTimer <= 0 && !inp.isTouch) { this._pickTimer = 0.06; this.hover = this._pick(pt.ndcX, pt.ndcY); }
      if (inp.click) {
        const i = this._pick(inp.click.ndcX, inp.click.ndcY, inp.isTouch ? 26 : 16);
        if (i >= 0) {
          if (i === this.selected) this.travel(i);
          else { this.select(i); this.rig.flyTo(this.stars.systems[i].pos, Math.min(this.rig.distance, 0.35), 1.6); }
        }
      }
      if (inp.pressed('travel') && this.selected >= 0) this.travel(this.selected);
      if (inp.pressed('escape') || inp.pressed('map')) {
        if (this.selected >= 0) this.select(-1);
        else E.up();
      }
    }

    // labels (engine UI name tags when available, own DOM tags otherwise)
    const ui = E.ui;
    if (ui.labelWorld && this.hoverEl.style.display !== 'none') {
      this.hoverEl.style.opacity = '0'; this.homeEl.style.opacity = '0';
      const hi = this.hover >= 0 ? this.hover : this.selected;
      if (hi > 0) {
        const s = this.stars.systems[hi];
        ui.labelWorld('gal-hover', s.pos, this.camera, s.star.name, { sub: s.star.cls, hover: true, kind: 'star' });
      }
      if (this.g.id === 0) ui.labelWorld('gal-home', this.stars.systems[0].pos, this.camera, 'Aurelia', { sub: 'home', kind: 'home' });
    } else if (this.hoverEl.style.display !== 'none') {
      const hi = this.hover >= 0 ? this.hover : this.selected;
      if (hi >= 0 && hi !== 0) {
        const s = this.stars.systems[hi];
        this.hoverEl.textContent = s.star.name;
        this.hoverEl.style.opacity = this._placeLabel(this.hoverEl, s.pos) ? '1' : '0';
      } else this.hoverEl.style.opacity = '0';
      if (this.g.id === 0) {
        const vis = this._placeLabel(this.homeEl, this.stars.systems[0].pos);
        this.homeEl.style.opacity = vis ? (hi === 0 ? '1' : '0.7') : '0';
      }
    }

    // telemetry: scale readout
    if (!E.shotMode && ((this._tele = (this._tele || 0) + dt) > 0.25)) {
      this._tele = 0;
      const d = this.camera.position.length();
      const fmt = d > 1 ? `${d.toFixed(1)} kpc` : d > 0.001 ? `${(d * 1000).toFixed(d > 0.01 ? 0 : 2)} pc` : `${(d / this.blackHole.rs).toFixed(1)} Rs`;
      E.ui.telemetry?.({ CORE: fmt });
    }
  }

  onResize(w, h) { if (!this.camera) return; this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }

  exit() { this.hoverEl?.remove(); this.homeEl?.remove(); }

  dispose() {
    this.hoverEl?.remove(); this.homeEl?.remove();
    this.stars?.dispose(); this.deepSky?.dispose(); this.volume?.dispose(); this.overlayPass?.dispose(); this.nebulae?.dispose(); this.blackHole?.dispose();
    this.mapRT?.dispose(); this.noise3D?.dispose();
  }

  // ---- shots ----------------------------------------------------------------------
  _pose(target, distance, yaw, pitch) {
    const r = this.rig;
    r._fly = null;
    r.target.copy(target); r._targetGoal.copy(target);
    r.distance = distance; r._logDistTarget = Math.log(distance);
    r.yaw = yaw; r.pitch = pitch; r._yawV = 0; r._pitchV = 0; r.autoRotate = 0; r._idle = 0;
    r.apply();
  }

  get shots() {
    const P = this.P;
    return {
      hero: async () => { this._pose(new THREE.Vector3(0, 0, 0), P.R * 2.35, 0.55, 0.78); },
      edge: async () => { this._pose(new THREE.Vector3(0, 0, 0), P.R * 1.5, 1.1, 0.045); },
      core: async () => { this._pose(new THREE.Vector3(0, 0, 0), this.blackHole.rs * 24, 2.2, 0.085); },
      nebula: async () => {
        const n = this.nebulaList[0];
        if (!n) { this._pose(new THREE.Vector3(), P.R * 0.6, 0.3, 0.3); return; }
        // inside the nebula, at the foot of the dust cliffs, looking across the cavity
        this._pose(n.pos.clone().add(new THREE.Vector3(0, n.radius * 0.05, 0)), n.radius * 0.88, n.rot + 0.6, 0.2);
      },
      stars: async () => {
        const s = this.stars.systems[0];
        this._pose(s.pos, 0.3, 0.9, 0.55);
        this.select(0);
        this.hover = 0;
      },
    };
  }
}
