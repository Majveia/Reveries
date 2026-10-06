// The cosmos level — the largest scale of Reveries and its title experience.
//
// A real-time cosmological N-body simulation (GPU particle-mesh, FastPM
// kick-drift-kick in an expanding flat ΛCDM universe, 2LPT initial conditions
// from the σ8-normalised power spectrum) grows the cosmic web from
// near-uniform noise: sheets, filaments, nodes and voids. The web is rendered
// as millions of tracer sprites of the dark-matter sheet, coloured by density
// and velocity dispersion.
//
// Title: the formed web drifts behind the title. Click → the Big Bang: the
// simulation restarts at z = 49 and the web forms over ~25 s while the camera
// pulls back. Hover a bright halo → its galaxy; Enter dives into it.

import * as THREE from 'three';
import { OrbitRig } from '../../core/OrbitRig.js';
import { seedFrom } from '../../core/Random.js';
import { PMSolver } from './PMSolver.js';
import { WebRenderer } from './WebRenderer.js';
import { DeepField } from './DeepField.js';
import { GasGlow } from './GasGlow.js';
import { findHalos, assignIds, sci } from './Halos.js';
import { A_START, ageGyr, BOX } from './Cosmology.js';

const RATES = [0, 0.25, 1, 4, 16];
const BANG_SECONDS = 25;
const HERO = { distance: 330, yaw: 0.72, pitch: 0.36 };
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _p = new THREE.Vector3();
const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };

export default class CosmosLevel {
  constructor(engine, addr = {}, opts = {}) {
    this.engine = engine;
    this.addr = addr;
    this.opts = opts;
    this.effects = [];
    this.grade = {
      exposure: 1.0, agxPunch: 0.55, contrast: 1.06, saturation: 1.12, temperature: -0.02, tint: 0.02,
      blackPoint: 0.006, vignette: 0.32, vignetteSoftness: 0.6, grain: 0.018, chroma: 0.0018,
      bloomStrength: 0.08, bloomRadius: 0.75, bloomThreshold: 0.0,
    };
    this.L = BOX;
    this.halos = [];
    this.ref = [];
    this.hovered = null;
    this.selected = null;
    this.rateIdx = 2;
    this.mode = 'live'; // 'live' | 'early'
    this.phase = 'idle'; // 'idle' | 'bang' | 'dive'
    this.aTarget = 1;
    this._teleT = 0;
    this._haloT = 0;
    this._flash = 0;
    this._shotTime = null;
    this.center = new THREE.Vector3();
    this.home = new THREE.Vector3(BOX / 2, BOX / 2, BOX / 2);
  }

  async load(progress) {
    const e = this.engine;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 4000);
    const tier = e.params.has('cq') ? Math.max(0, Math.min(3, parseInt(e.params.get('cq'), 10))) : e.quality.level;
    this.sim = new PMSolver(e.renderer, {
      tier, seed: seedFrom(e.universe.seed, 'cosmic-web'),
      steps: e.shotMode ? 24 : 40,
    });
    progress(0.04, 'seeding the primordial field');
    await this.sim.init((p) => progress(0.04 + p, 'seeding the primordial field'));
    progress(0.35, 'gravity at work');
    await this.sim.runTo(1, (p) => progress(0.35 + 0.6 * p, 'gravity at work'));
    this._detectHalos(true);
    if (this.ref[0]) this.home.set(this.ref[0].x, this.ref[0].y, this.ref[0].z);

    this.web = new WebRenderer(e, this.sim, { galaxies: e.quality.pick(16384, 32768, 65536, 131072) });
    this.scene.add(this.web.galaxies);
    this.glow = new GasGlow(this.sim, e.quality.pick(24, 32, 40, 56));
    this.effects = [this.web.effect, this.glow];
    // debug: ?cw=gain:0.2,gamma:1.6 overrides render params
    if (e.params.get('cw')) { this._dbg = {}; for (const kv of e.params.get('cw').split(',')) { const [k, v] = kv.split(':'); this._dbg[k] = parseFloat(v); } this._dbgUrl = this._dbg; }

    this.rig = new OrbitRig(this.camera, {
      target: this.home, distance: HERO.distance, yaw: HERO.yaw, pitch: HERO.pitch,
      minDistance: 1.5, maxDistance: 900, autoRotate: e.shotMode ? 0 : 0.018, damping: 5,
    });
    this._buildMarkers();
    this.deep = new DeepField(seedFrom(e.universe.seed, 'deep-field'), e.quality.pick(2500, 4000, 6000, 8000));
    this.scene.add(this.deep.points);
    progress(1, 'the cosmic web');
  }

  // ---- halos -------------------------------------------------------------------
  _detectHalos(reference = false) {
    const s = this.sim;
    const grid = s.readHaloGrid();
    const unit = (s.particleMass * s.N) / (s.M ** 3);
    const list = findHalos(grid, s.H, s.L, unit, 160);
    if (reference || !this.ref.length) {
      list.forEach((h, i) => { h.id = i; });
      this.ref = list.map((h) => ({ ...h }));
    } else assignIds(list, this.ref, s.L, 7);
    this.halos = list;
    this._haloA = s.a;
    this._grid = grid;
  }

  _haloWorld(h, out) {
    // nearest periodic image around the current wrap centre
    const L = this.L;
    out.set(h.x, h.y, h.z).sub(this.center);
    out.x -= L * Math.floor(out.x / L + 0.5); out.y -= L * Math.floor(out.y / L + 0.5); out.z -= L * Math.floor(out.z / L + 0.5);
    return out.add(this.center);
  }

  _buildMarkers() {
    const mk = (strength) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uStrength: { value: strength }, uColor: { value: new THREE.Color(1.0, 0.86, 0.62) } },
        vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform float uTime; uniform float uStrength; uniform vec3 uColor; varying vec2 vUv;
          void main(){
            float r = length(vUv);
            float ring = smoothstep(0.035, 0.0, abs(r - 0.78));
            float a = atan(vUv.y, vUv.x);
            float ticks = smoothstep(0.06, 0.0, abs(r - 0.93)) * step(0.92, abs(cos(a * 2.0 + uTime * 0.4)));
            float v = (ring * (0.55 + 0.45 * abs(sin(a * 3.0 + uTime))) + ticks) * uStrength;
            gl_FragColor = vec4(uColor * v * 2.2, v);
          }`,
        transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      m.visible = false; m.renderOrder = 10; m.frustumCulled = false;
      this.scene.add(m);
      return m;
    };
    this.hoverRing = mk(0.7);
    this.selectRing = mk(1.0);
    const label = document.createElement('div');
    label.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:5;font:500 10px/1.5 var(--rv-mono, monospace);letter-spacing:.14em;text-transform:uppercase;color:rgba(236,240,255,.9);text-shadow:0 0 10px #000;opacity:0;transition:opacity .25s;white-space:nowrap';
    document.body.appendChild(label);
    this.label = label;
  }

  _placeRing(mesh, h, px) {
    if (!h) { mesh.visible = false; return; }
    this._haloWorld(h, mesh.position);
    const d = mesh.position.distanceTo(this.camera.position);
    const s = (px / (this.engine.height || 720)) * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * d;
    mesh.scale.setScalar(s);
    mesh.quaternion.copy(this.camera.quaternion);
    mesh.visible = true;
    mesh.material.uniforms.uTime.value = this.engine.time;
  }

  _pick(ptr) {
    if (!ptr || !this.halos.length) return null;
    const W = this.engine.width, H = this.engine.height;
    let best = null, bd = 26 * 26;
    const n = Math.min(this.halos.length, 96);
    for (let i = 0; i < n; i++) {
      const h = this.halos[i];
      this._haloWorld(h, _p);
      _v.copy(_p).project(this.camera);
      if (_v.z > 1 || _v.z < -1) continue;
      const dx = (_v.x - ptr.ndcX) * W * 0.5, dy = (_v.y - ptr.ndcY) * H * 0.5;
      const bonus = 1 + Math.min(1.5, Math.log10(h.mass / 1e13 + 1));
      const d2 = (dx * dx + dy * dy) / (bonus * bonus);
      if (d2 < bd) { bd = d2; best = h; }
    }
    return best;
  }

  _galaxyFor(h) { return this.engine.universe.galaxy(h.id); }

  _select(h) {
    this.selected = h;
    const ui = this.engine.ui;
    if (!h) { ui.info(null); return; }
    const g = this._galaxyFor(h);
    const z = 1 / this.sim.a - 1;
    const kind = h.mass > 1e15 ? 'Galaxy cluster' : h.mass > 1e14 ? 'Galaxy group' : 'Dark-matter halo';
    ui.info({
      subtitle: `${kind} · ${g.designation || 'Halo ' + h.id}`,
      title: g.name,
      rows: [
        ['Halo mass', `${sci(h.mass)} M☉/h`],
        ['Brightest galaxy', `${g.type}`],
        ['Overdensity', `${Math.round(h.peak)}×`],
        ['Redshift', z >= 0 ? z.toFixed(2) : `${z.toFixed(2)} (future)`],
      ],
      text: h.id === 0 ? 'The deepest well in this corner of the universe. Home.' : 'A knot where filaments meet and galaxies gather.',
      actions: [{ label: 'Enter', primary: true, onClick: () => this.dive(h) }],
    });
    this.engine.audio.sfx('select');
  }

  dive(h) {
    if (this.phase === 'dive' || !h) return;
    this.phase = 'dive';
    this.engine.ui.info(null);
    this.label.style.opacity = '0';
    const p = this._haloWorld(h, new THREE.Vector3());
    this.rig.flyTo(p, 1.6, 2.2, { yaw: this.rig.yaw + 0.5, pitch: this.rig.pitch * 0.6 }).then(() => {
      this.engine.go('galaxy', { g: h.id }, { from: 'cosmos' });
    });
  }

  // ---- lifecycle --------------------------------------------------------------------
  enter(prev) {
    const e = this.engine;
    e.input.setMode('orbit');
    e.ui.setMode('map');
    e.audio.setScene('cosmos');
    if (prev === 'galaxy' && this.addr.g != null) {
      const h = this.halos.find((x) => x.id === this.addr.g) || this.ref[0];
      if (h) {
        const p = this._haloWorld(h, new THREE.Vector3());
        this.rig.setTarget(p, true);
        this.rig.distance = 2; this.rig._logDistTarget = Math.log(2);
        this.rig.flyTo(this.home, HERO.distance * 0.75, 4.0, { yaw: this.rig.yaw + 0.6, pitch: HERO.pitch });
      }
    }
    if (!this.opts.intro && !e.shotMode) e.ui.hint('Drag to orbit · scroll to zoom · click a bright node', 5200);
    this.introPending = !!this.opts.intro;
  }

  onBegin() {
    // The Big Bang.
    const e = this.engine;
    this.introPending = false;
    this.phase = 'bang';
    this.bangT = 0;
    this._select(null);
    this.sim.restart();
    this._flash = 1;
    this.rig.setTarget(this.home, true);
    this.rig.distance = 26; this.rig._logDistTarget = Math.log(26);
    this.rig.flyTo(this.home, HERO.distance, BANG_SECONDS * 0.96, { yaw: this.rig.yaw + 1.15, pitch: HERO.pitch });
    e.audio.sfx('warp');
  }

  update(dt, t) {
    const e = this.engine, input = e.input, sim = this.sim;
    const ptr = input.pointer;

    // --- time -----------------------------------------------------------------
    if (input.pressed('timeFaster')) { this.rateIdx = Math.min(RATES.length - 1, this.rateIdx + 1); e.ui.hint(this._rateLabel(), 1800); }
    if (input.pressed('timeSlower')) { this.rateIdx = Math.max(0, this.rateIdx - 1); e.ui.hint(this._rateLabel(), 1800); }
    const rate = RATES[this.rateIdx];
    if (this.phase === 'bang') {
      this.bangT += dt * Math.max(rate, 0.25);
      const s = Math.min(1, this.bangT / BANG_SECONDS);
      const ease = 1 - Math.pow(1 - s, 1.6);
      const sa = Math.sqrt(A_START) + (1 - Math.sqrt(A_START)) * ease;
      this.aTarget = sa * sa;
      if (s >= 1) { this.phase = 'idle'; e.ui.hint('Drag to orbit · scroll to zoom · click a bright node', 5200); }
    } else if (!e.shotMode && this.phase !== 'dive') {
      this.aTarget = Math.min(sim.schedule[sim.schedule.length - 1], this.aTarget + dt * 0.0035 * rate);
    }

    // --- simulation -------------------------------------------------------------
    if (!e.shotMode) {
      const behind = this.aTarget - this.disp?.a > 0.02 ? 2 : 1;
      this.disp = sim.update(this.aTarget, behind);
      if (sim.a >= 0.3 && (this._haloA == null || Math.abs(sim.a - this._haloA) > 0.04) && !sim.busy) this._detectHalos(false);
    } else if (!this.disp || this.mode === 'live') {
      this.disp = sim.display(this.aTarget);
    }
    if (this.mode === 'early' && sim.early) this.disp = { prev: sim.early, next: sim.early, w: 0, a: 1 / 6 };
    const a = this.disp.a;

    // --- camera -----------------------------------------------------------------
    if (this.phase === 'dive' || this.introPending) this.rig.update(dt, null);
    else this.rig.update(dt, input);
    const camD = this.camera.position.distanceTo(this.rig.target);
    const inside = 1 - smooth((camD - 0.32 * this.L) / (0.42 * this.L));
    this.center.lerpVectors(this.rig.target, this.camera.position, inside);
    const p = this.web.params;
    p.shape = 2;
    p.fog = 260 - 150 * inside;
    p.fogNear = Math.max(0, camD - 0.45 * this.L);
    // early universe: a hot primordial glow that cools into the dark ages
    p.warm = 0.85 * (1 - smooth((a - 0.022) / 0.05));
    p.shimmer = 1;
    this.glow.center.copy(this.center);
    this.glow.enabled = this.mode !== 'early';
    this.glow.strength = 0.003 * (1 - p.warm);
    if (this._dbg) Object.assign(p, this._dbg);

    // flash of the Big Bang
    const tr = e.postfx.transition;
    if (this._flash > 0 && !e._busy) {
      this._flash = Math.max(0, this._flash - dt / 1.8);
      tr.color.setRGB(1.0, 0.93, 0.82);
      tr.fade = this._flash * this._flash;
      if (this._flash === 0) { tr.fade = 0; tr.color.setRGB(0, 0, 0); }
    }

    // --- interaction ------------------------------------------------------------
    if (this.phase !== 'dive' && !this.introPending && !e.shotMode) {
      const overUI = !ptr || ptr.buttons;
      this.hovered = input.isTouch ? null : (overUI ? this.hovered : this._pick(ptr));
      if (input.click) {
        const h = this._pick(input.click);
        if (h && h === this.selected) this.dive(h);
        else this._select(h);
      }
      if (input.doubleClick) { const h = this._pick(input.doubleClick); if (h) this.dive(h); }
      if (this.selected && (input.pressed('travel') || input.pressed('interact'))) this.dive(this.selected);
      if (input.pressed('escape') && this.selected) this._select(null);
      this.engine.canvas.style.cursor = this.hovered ? 'pointer' : '';
    }
    if (this.selected) {
      // keep the selection attached to its (moving) halo
      const cur = this.halos.find((h) => h.id === this.selected.id);
      if (cur) this.selected = cur;
    }
    this._placeRing(this.hoverRing, this.hovered && this.hovered !== this.selected ? this.hovered : null, 22);
    this._placeRing(this.selectRing, this.phase === 'dive' ? null : this.selected, 30);
    this._updateLabel();

    // --- telemetry ----------------------------------------------------------------
    this._teleT -= dt;
    if (this._teleT <= 0 && !this.introPending) {
      this._teleT = 0.12;
      const z = 1 / a - 1;
      e.ui.telemetry({ z: z >= 0 ? z.toFixed(z > 9.95 ? 1 : 2) : z.toFixed(2), AGE: `${ageGyr(a).toFixed(2)} Gyr`, a: a.toFixed(3), ...(rate !== 1 ? { T: rate === 0 ? 'paused' : `×${rate}` } : {}) });
    }
  }

  _rateLabel() { const r = RATES[this.rateIdx]; return r === 0 ? 'Time paused' : `Cosmic time ×${r}`; }

  _updateLabel() {
    const h = this.hovered && this.phase !== 'dive' ? this.hovered : null;
    if (!h) { this.label.style.opacity = '0'; return; }
    this._haloWorld(h, _p);
    _v.copy(_p).project(this.camera);
    const x = (_v.x * 0.5 + 0.5) * this.engine.width, y = (-_v.y * 0.5 + 0.5) * this.engine.height;
    const g = this._galaxyFor(h);
    this.label.innerHTML = `${g.name}<br><span style="color:rgba(220,228,255,.5)">${sci(h.mass)} M☉/h</span>`;
    this.label.style.transform = `translate(${Math.round(x + 18)}px, ${Math.round(y - 8)}px)`;
    this.label.style.opacity = '1';
  }

  render() {
    const e = this.engine;
    // the deep field fades while we are inside the web (it would be hidden by more web)
    const camD = this.camera.position.distanceTo(this.rig.target);
    this.deep.update(this.camera, e.postfx.height, smooth((camD - 0.35 * this.L) / (0.5 * this.L)) * (1 - this.web.params.warm));
    const time = e.shotMode ? 12.0 : e.time;
    this.web.accumulate(this.camera, this.disp, this.center, time, e.shotMode);
    e.postfx.render(this.scene, this.camera, this.effects, { time: e.time, dt: e.dt });
  }

  // ---- shots ----------------------------------------------------------------------
  _pose(target, offset, fov = 50) {
    const r = this.rig;
    r._fly = null;
    r.setTarget(target, true);
    r.distance = offset.length(); r._logDistTarget = Math.log(r.distance);
    r.pitch = Math.asin(offset.y / r.distance);
    r.yaw = Math.atan2(offset.x, offset.z);
    r._yawV = 0; r._pitchV = 0;
    this.camera.fov = fov; this.camera.updateProjectionMatrix();
    r.apply();
  }
  _heroOffset(d = HERO.distance, yaw = HERO.yaw, pitch = HERO.pitch) {
    return new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(d);
  }

  /** Direction (scaled to r) from home toward the emptiest region at distance r (coarse density). */
  _voidOffset(r) {
    const s = this.sim, H = s.H, g = this._grid, L = this.L;
    let best = null, bv = Infinity;
    const at = (x, y, z) => {
      const i = (v) => ((Math.floor(v / L * H) % H) + H) % H;
      let sum = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
        sum += g[((i(z) + dz + H) % H * H + (i(y) + dy + H) % H) * H + (i(x) + dx + H) % H];
      return sum;
    };
    for (let k = 0; k < 96; k++) {
      // Fibonacci sphere, biased to mid elevations for a cinematic horizon
      const y = 1 - (k + 0.5) / 96 * 2, rr = Math.sqrt(1 - y * y), ph = k * 2.399963;
      if (Math.abs(y) > 0.55) continue;
      const d = new THREE.Vector3(Math.cos(ph) * rr, y, Math.sin(ph) * rr);
      let v = 0;
      for (const f of [0.55, 0.8, 1.0]) v += at(this.home.x + d.x * r * f, this.home.y + d.y * r * f, this.home.z + d.z * r * f);
      if (v < bv) { bv = v; best = d; }
    }
    return (best || new THREE.Vector3(0.8, 0.2, 0.5).normalize()).multiplyScalar(r);
  }

  get shots() {
    // "name~k:v,k:v" renders preset `name` with render-parameter overrides (look-dev)
    const base = this._shots();
    return new Proxy(base, {
      get: (t, name) => {
        if (typeof name !== 'string' || !(name in t || name.includes('~'))) return t[name];
        if (!name.includes('~')) return async () => { this._dbg = this._dbgUrl; await t[name](); };
        const [b, kv] = name.split('~');
        return async () => {
          this._dbg = { ...(this._dbgUrl || {}) };
          for (const pair of kv.split(/[;+]/)) { const [k, v] = pair.split(':'); this._dbg[k] = parseFloat(v); }
          await t[b]?.();
        };
      },
    });
  }

  _shots() {
    return {
      hero: async () => { this.mode = 'live'; this._pose(this.home, this._heroOffset(), 50); },
      early: async () => { this.mode = 'early'; this._pose(this.home, this._heroOffset(250, HERO.yaw + 0.4, 0.3), 50); },
      // look-dev: the Big Bang at an intermediate epoch ("bang~a:0.05+d:40"); destroys the z=0 state, render last
      bang: async () => {
        const a = this._dbg?.a ?? 0.05, d = this._dbg?.d ?? 60;
        this.mode = 'live';
        this.sim.restartSync();
        if (a > A_START) await this.sim.runTo(a);
        this.aTarget = this.sim.a;
        this._pose(this.home, this._heroOffset(d, HERO.yaw + 0.5, 0.3), 50);
      },
      node: async () => { this.mode = 'live'; this._pose(this.home, this._heroOffset(24, HERO.yaw + 2.2, 0.22), 55); },
      web: async () => {
        this.mode = 'live';
        // inside the web: from the emptiest nearby void, looking across the filaments toward home
        const off = this._voidOffset(52);
        this._pose(this.home, off, 62);
      },
    };
  }

  onResize(w, h) { if (this.camera) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); } }

  exit() {
    this.engine.ui.telemetry(null);
    this.engine.ui.info(null);
    this.engine.canvas.style.cursor = '';
    const tr = this.engine.postfx.transition;
    if (this._flash > 0) { tr.color.setRGB(0, 0, 0); }
  }

  dispose() {
    this.label?.remove();
    this.web?.dispose();
    this.deep?.dispose();
    this.glow?.dispose();
    this.sim?.dispose();
    for (const m of [this.hoverRing, this.selectRing]) { if (m) { m.geometry.dispose(); m.material.dispose(); } }
  }
}
