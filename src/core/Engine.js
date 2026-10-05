// Engine: renderer, frame loop, adaptive resolution, level lifecycle and the
// cinematic transitions between scales of the universe.
//
// Level contract (see docs/ARCHITECTURE.md):
//   export default class XLevel {
//     constructor(engine, addr, opts)
//     async load(progress)            progress(p01, label)
//     enter(prevLevelName)            first frame is next
//     update(dt, t)                   per frame
//     render?()                       default: postfx.render(scene, camera, effects)
//     exit(); dispose()
//     scene, camera, effects[], grade{}, shots{ name: () => void }, onResize(w, h)
//   }

import * as THREE from 'three';
import { PostFX } from './PostFX.js';
import { Input } from './Input.js';
import { Quality } from './Quality.js';
import { UI } from '../ui/UI.js';
import { AudioEngine } from '../audio/Audio.js';
import { Universe } from '../universe/Universe.js';

export const LEVELS = {
  cosmos: () => import('../levels/cosmos/CosmosLevel.js'),
  galaxy: () => import('../levels/galaxy/GalaxyLevel.js'),
  system: () => import('../levels/system/SystemLevel.js'),
  planet: () => import('../levels/planet/PlanetLevel.js'),
};
const ORDER = ['cosmos', 'galaxy', 'system', 'planet'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Engine {
  constructor(params = new URLSearchParams(location.search), overrides = {}) {
    this.params = params;
    this.shotMode = params.has('shot');
    this.debug = params.has('debug');
    this.quality = new Quality(params);
    if (this.shotMode && !params.get('q')) { this.quality.maxDpr = 1; this.quality.minDpr = 1; }

    const canvas = document.createElement('canvas');
    canvas.className = 'rv-canvas';
    canvas.tabIndex = 0;
    document.body.appendChild(canvas);
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, depth: true, stencil: false,
      powerPreference: 'high-performance', reversedDepthBuffer: true,
      preserveDrawingBuffer: this.shotMode,
    });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.info.autoReset = false; // reset per frame in _loop (harness reports full-frame stats)
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.reversedDepth = !!this.renderer.state.buffers.depth.getReversed?.();

    this.events = new EventTarget();
    this.universe = new Universe(params.get('seed') || 'reveries');
    this.input = new (overrides.Input || Input)(canvas);
    this.postfx = new (overrides.PostFX || PostFX)(this.renderer, this.quality);
    this.ui = new (overrides.UI || UI)(this);
    if (params.get('ui') === '0') this.ui.setVisible(false);
    this.audio = new (overrides.AudioEngine || AudioEngine)(this);

    this.level = null;
    this.levelName = null;
    this.addr = {};
    this.time = 0;
    this.dt = 1 / 60;
    this.timeScale = 1;
    this.frame = 0;
    this._busy = false;
    this._dpr = this.quality.maxDpr;
    this._ft = 16;
    this._dprCooldown = 0;
    this._last = performance.now();
    this.photoMode = false;

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();

    if (this.debug) {
      this.fpsEl = document.createElement('div');
      this.fpsEl.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;font:10px monospace;color:#7f7;pointer-events:none';
      document.body.appendChild(this.fpsEl);
    }

    // Harness / debug API
    window.__REVERIES__ = {
      engine: this, ready: false, error: null,
      shot: async (name) => { const fn = this.level?.shots?.[name]; if (fn) await fn(); return !!fn; },
      shots: () => Object.keys(this.level?.shots || {}),
      frames: (n = 1) => new Promise((res) => { this._frameWaiters.push({ n: this.frame + n, res }); }),
    };
    this._frameWaiters = [];
    window.addEventListener('error', (e) => { window.__REVERIES__.error = String(e.message || e); });
    window.addEventListener('unhandledrejection', (e) => { window.__REVERIES__.error = String(e.reason?.stack || e.reason); });
  }

  emit(name, detail) { this.events.dispatchEvent(new CustomEvent(name, { detail })); }
  on(name, fn) { const h = (e) => fn(e.detail); this.events.addEventListener(name, h); return () => this.events.removeEventListener(name, h); }

  /** Boot: read the URL and enter the first level. */
  async start() {
    const p = this.params;
    const scene = p.get('scene') || 'cosmos';
    const addr = {};
    for (const k of ['g', 's', 'p']) if (p.has(k)) addr[k] = parseInt(p.get(k), 10);
    if (scene !== 'cosmos' && addr.g == null) addr.g = 0;
    if ((scene === 'system' || scene === 'planet') && addr.s == null) addr.s = 0;
    if (scene === 'planet' && addr.p == null) addr.p = 2;
    this.renderer.setAnimationLoop((now) => this._loop(now));
    const showTitle = !this.shotMode && !p.has('scene') && !p.has('notitle');
    await this.go(scene, addr, { transition: 'none', intro: showTitle, spawn: p.get('spawn') });
    if (showTitle) {
      this.ui.showTitle(() => {
        this.audio.unlock();
        this.emit('begin');
        this.level?.onBegin?.();
      });
    } else {
      const unlock = () => { this.audio.unlock(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
      window.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock);
    }
  }

  /**
   * Travel to a level. transition: 'warp-in' (deeper), 'warp-out' (up), 'fade', 'none'.
   * opts are passed to the level constructor (e.g. { spawn: 'surface', from: 'system' }).
   */
  async go(name, addr = {}, opts = {}) {
    if (this._busy) return false;
    if (!LEVELS[name]) { console.warn('Unknown level', name); return false; }
    this._busy = true;
    const prevName = this.levelName;
    const transition = opts.transition ?? (prevName ? (ORDER.indexOf(name) > ORDER.indexOf(prevName) ? 'warp-in' : 'warp-out') : 'none');
    const tr = this.postfx.transition;
    const anim = (from, to, seconds, key) => new Promise((res) => { this._anims.push({ key, from, to, t: 0, seconds, res }); });
    this._anims = this._anims || [];
    try {
      this.emit('leaving', { from: prevName, to: name, addr });
      if (prevName && transition !== 'none') {
        this.audio.sfx(transition === 'fade' ? 'ui' : 'warp');
        if (transition === 'warp-in') { tr.color.setRGB(0.85, 0.92, 1.0); await Promise.all([anim(0, 1, 1.1, 'warp'), anim(0, 1, 1.1, 'fade')]); }
        else { tr.color.setRGB(0, 0, 0); await Promise.all([anim(0, 0.6, 0.8, 'warp'), anim(0, 1, 0.8, 'fade')]); }
      }
      let showVeil = true;
      const veilTimer = setTimeout(() => { if (showVeil) this.ui.setProgress(0.02, `entering ${name}`); }, prevName ? 0 : 400);
      const mod = await LEVELS[name]();
      const Cls = mod.default || Object.values(mod).find((v) => typeof v === 'function');
      const lvl = new Cls(this, addr, opts);
      await lvl.load((p, label) => this.ui.setProgress(p, label || `entering ${name}`));
      showVeil = false; clearTimeout(veilTimer);
      this.ui.setProgress(null);
      if (this.level) { try { this.level.exit?.(); this.level.dispose?.(); } catch (e) { console.error(e); } }
      this.level = lvl; this.levelName = name; this.addr = { ...addr };
      this.ui.info(null); this.ui.prompt(null); this.ui.telemetry(null);
      this.ui.setLocation(lvl.crumbs || this.universe.crumbs(addr));
      if (lvl.grade) this.postfx.setGrade(lvl.grade, 0); else this.postfx.resetGrade(0);
      lvl.onResize?.(window.innerWidth, window.innerHeight);
      lvl.enter?.(prevName);
      this._updateURL(name, addr);
      this.emit('entered', { name, addr });
      if (transition !== 'none' && prevName) {
        await Promise.all([anim(tr.warp, 0, 1.3, 'warp'), anim(tr.fade, 0, 1.0, 'fade')]);
      } else { tr.warp = 0; tr.fade = 0; }
      return true;
    } catch (e) {
      console.error('Level load failed', e);
      window.__REVERIES__.error = String(e?.stack || e);
      this.ui.setProgress(null);
      tr.warp = 0; tr.fade = 0;
      this.ui.hint('That place could not be reached.', 3000);
      return false;
    } finally {
      this._busy = false;
    }
  }

  /** Go one level up the hierarchy (planet → system → galaxy → cosmos). */
  up() {
    const i = ORDER.indexOf(this.levelName);
    if (i <= 0) return;
    const name = ORDER[i - 1];
    const addr = { ...this.addr };
    if (name === 'system') delete addr.p;
    if (name === 'galaxy') { delete addr.p; delete addr.s; }
    if (name === 'cosmos') { delete addr.p; delete addr.s; }
    this.go(name, addr, { transition: 'warp-out', from: this.levelName, fromAddr: this.addr });
  }

  _updateURL(name, addr) {
    if (this.shotMode) return;
    const p = new URLSearchParams();
    p.set('scene', name);
    for (const k of ['g', 's', 'p']) if (addr[k] != null) p.set(k, addr[k]);
    for (const k of ['q', 'seed', 'debug']) if (this.params.has(k)) p.set(k, this.params.get(k));
    history.replaceState(null, '', `${location.pathname}?${p.toString()}`);
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.width = w; this.height = h;
    this.renderer.setPixelRatio(this._dpr);
    this.renderer.setSize(w, h, true);
    this.postfx.setSize(w, h, this._dpr);
    this.level?.onResize?.(w, h);
  }

  _adaptResolution(rawDt) {
    if (this.shotMode) return;
    this._ft += (rawDt * 1000 - this._ft) * 0.05;
    this._dprCooldown -= rawDt;
    if (this._dprCooldown > 0) return;
    const q = this.quality;
    let next = this._dpr;
    if (this._ft > 21 && this._dpr > q.minDpr) next = Math.max(q.minDpr, this._dpr - 0.1);
    else if (this._ft < 15.5 && this._dpr < q.maxDpr) next = Math.min(q.maxDpr, this._dpr + 0.05);
    if (next !== this._dpr) { this._dpr = next; this._resize(); this._dprCooldown = 1.5; }
  }

  _loop(now) {
    const rawDt = Math.min(0.1, Math.max(0.0005, (now - this._last) / 1000));
    this._last = now;
    const dt = this.shotMode ? 1 / 60 : rawDt;
    this.dt = dt * this.timeScale;
    this.time += this.dt;
    this.frame++;
    this._adaptResolution(rawDt);

    // transition tweens
    if (this._anims?.length) {
      for (const a of this._anims) {
        a.t = Math.min(1, a.t + dt / a.seconds);
        const e = a.t * a.t * (3 - 2 * a.t);
        this.postfx.transition[a.key] = a.from + (a.to - a.from) * e;
      }
      this._anims = this._anims.filter((a) => { if (a.t >= 1) { a.res(); return false; } return true; });
    }

    this.input.update(dt);
    if (this.input.pressed('photo')) { this.photoMode = !this.photoMode; this.ui.setVisible(!this.photoMode); }
    const lvl = this.level;
    this.renderer.info.reset();
    if (lvl) {
      try {
        lvl.update(this.dt, this.time);
        if (lvl.render) lvl.render();
        else this.postfx.render(lvl.scene, lvl.camera, lvl.effects || [], { time: this.time, dt: this.dt });
      } catch (e) {
        if (!this._loggedErr) { console.error(e); this._loggedErr = true; window.__REVERIES__.error = String(e?.stack || e); }
      }
    }
    this.ui.update(this.dt);
    this.audio.update(this.dt);
    this.input.endFrame();

    if (this.fpsEl && this.frame % 20 === 0) this.fpsEl.textContent = `${(1000 / this._ft).toFixed(0)} fps · dpr ${this._dpr.toFixed(2)} · ${this.renderer.info.render.calls} calls · ${(this.renderer.info.render.triangles / 1000).toFixed(0)}k tris`;
    if (this._frameWaiters.length) {
      this._frameWaiters = this._frameWaiters.filter((w) => { if (this.frame >= w.n) { w.res(); return false; } return true; });
    }
    if (lvl && !this._busy && !window.__REVERIES__.ready && lvl.ready !== false) {
      this._readyFrames = (this._readyFrames || 0) + 1;
      if (this._readyFrames > (this.shotMode ? 3 : 1)) window.__REVERIES__.ready = true;
    }
  }
}
