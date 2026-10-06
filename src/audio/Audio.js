// Audio engine API (procedural, WebAudio). The audio module is owned by the
// audio sub-project; this file defines the stable API everyone calls.
//
//   audio.unlock()                       call from a user gesture (title click)
//   audio.setScene(name, music)          name: 'cosmos'|'galaxy'|'system'|'planet'
//                                        music: aesthetic.music ({root, scale, tempo, timbre}) or null
//   audio.setTimeOfDay(t01)              planet: 0 = midnight, 0.5 = noon (also polled from the world)
//   audio.setFlight(speed01, altitude01) intensity for wind/engine layers
//   audio.setEngine(kind|null, throttle) 'bike'|'ship'|null
//   audio.sfx(name, opts)                'select','hover','ui','warp','arrive','jump','land','step',
//                                        'board','alight','boost','takeoff','discover'
//   audio.setVolume(v) / audio.toggleMute()
//   audio.update(dt)
//
// Signal flow:
//   music scenes ─┬─ dry ─► music glue compressor ─┐
//                 ├─ hall send ─► convolver (generated 6 s hall IR) ─┤
//                 ├─ room send ─► convolver (1.6 s room IR) ─────────┤
//                 └─ delay send ─► ping-pong delay ─► (+ hall) ──────┤
//   ambience ──────────────────────────────────────────────────────┤
//   sfx ───────────────────────────────────────────────────────────┴─► limiter ─► soft clip ─► volume ─► out
//
// The planet soundscape reads the live level each frame (camera altitude,
// player speed, nearby coast / settlements, daylight, weather) so other modules
// only need the calls above.
import { MusicScene, SCENE_MUSIC } from './Music.js';
import { Ambience } from './Ambience.js';
import { Sfx, Motors } from './Sfx.js';
import { noiseBuffers, reverbIR, samples, waves, softClipCurve } from './DSP.js';
import { hashStr } from './Theory.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (x, a, b) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const SITE_W = { megacity: 1, city: 0.9, spaceport: 0.8, town: 0.7, village: 0.5, outpost: 0.3, ruins: 0 };

export class AudioEngine {
  constructor(engine) {
    this.engine = engine;
    this.ctx = null;
    this.master = null;
    this.volume = 0.8;
    this.muted = false;
    this.scene = null;          // { name, music }
    this.music = null;          // active MusicScene
    this._old = [];             // fading scenes
    this._tod = 0.5; this._todSet = false;
    this._flight = { speed: 0, alt: 0, t: -1 };
    this._acc = 0; this._probeT = 0; this._visits = 0;
    this._probe = { surf: 0, veg: 0, biome: 1 };
    this.fadeIn = 6;            // seconds for the very first scene
    // ?audio=1: start without a gesture (headless harness / autoplay-allowed kiosks)
    try { if (engine?.params?.get?.('audio') === '1') setTimeout(() => this.unlock(), 0); } catch { /* no params */ }
  }

  // ---- lifecycle ---------------------------------------------------------------------------------
  async unlock() {
    if (this.ctx) { if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { /* gesture needed */ } } return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    let ctx;
    try { ctx = new AC({ latencyHint: 'playback' }); } catch { try { ctx = new AC(); } catch { return; } }
    // iOS: a silent buffer started inside the gesture unlocks output
    try { const b = ctx.createBuffer(1, 1, ctx.sampleRate); const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); } catch { /* ignore */ }
    try { if (ctx.state !== 'running') ctx.resume(); } catch { /* ignore */ }
    try { this.attach(ctx); } catch (e) { console.warn('[audio] init failed', e); this.ctx = null; try { ctx.close(); } catch { /* ignore */ } return; }
    // keep resuming after interruptions (iOS calls, Safari tab switches)
    const kick = () => { if (this.ctx && this.ctx.state !== 'running' && !document.hidden) this.ctx.resume().catch(() => {}); };
    for (const ev of ['pointerdown', 'touchend', 'keydown']) window.addEventListener(ev, kick, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend().catch(() => {}); else this.ctx.resume().catch(() => {});
    });
  }

  /** Build the graph on any BaseAudioContext (realtime or offline — used by the level check). */
  attach(ctx) {
    this.ctx = ctx;
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.A = { noise: noiseBuffers(ctx), samples: samples(ctx), waves: waves(ctx) };
    // master chain
    this.master = g(this._vol());
    this.master.connect(ctx.destination);
    this.clip = ctx.createWaveShaper(); this.clip.curve = softClipCurve(); this.clip.oversample = '2x';
    this.clip.connect(this.master);
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -4; this.limiter.knee.value = 2; this.limiter.ratio.value = 20; this.limiter.attack.value = 0.002; this.limiter.release.value = 0.15;
    this.limiter.connect(this.clip);
    this.pre = g(1); this.pre.connect(this.limiter);
    // music glue
    this.glue = ctx.createDynamicsCompressor();
    this.glue.threshold.value = -22; this.glue.knee.value = 12; this.glue.ratio.value = 2.2; this.glue.attack.value = 0.06; this.glue.release.value = 0.6;
    this.musicBus = g(0.9); this.musicBus.connect(this.glue); this.glue.connect(this.pre);
    this.musicDry = g(1); this.musicDry.connect(this.musicBus);
    // reverbs
    this.hallIn = g(1); this.hall = ctx.createConvolver(); this.hall.normalize = false;
    this.hall.buffer = reverbIR(ctx, { seconds: 6, decay: 2.2, predelay: 0.04, dark: 0.7, seed: 11 });
    this.hallOut = g(0.42); this.hallIn.connect(this.hall); this.hall.connect(this.hallOut); this.hallOut.connect(this.musicBus);
    this.roomIn = g(1); this.room = ctx.createConvolver(); this.room.normalize = false;
    this.room.buffer = reverbIR(ctx, { seconds: 1.6, decay: 3, predelay: 0.012, dark: 0.45, seed: 23, early: 16 });
    this.roomOut = g(0.38); this.roomIn.connect(this.room); this.room.connect(this.roomOut); this.roomOut.connect(this.musicBus);
    // ping-pong delay (feeds the hall too)
    this.delayIn = g(1);
    const dl = ctx.createDelay(3), dr = ctx.createDelay(3), fbl = g(0.36), fbr = g(0.36);
    const lpl = ctx.createBiquadFilter(), lpr = ctx.createBiquadFilter();
    for (const f of [lpl, lpr]) { f.type = 'lowpass'; f.frequency.value = 3200; }
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 250;
    const merge = ctx.createChannelMerger(2);
    this.delayIn.connect(hp); hp.connect(dl);
    dl.connect(lpl); lpl.connect(fbl); fbl.connect(dr);
    dr.connect(lpr); lpr.connect(fbr); fbr.connect(dl);
    dl.connect(merge, 0, 0); dr.connect(merge, 0, 1);
    this.delayOut = g(0.5); merge.connect(this.delayOut); this.delayOut.connect(this.musicBus);
    const dh = g(0.35); this.delayOut.connect(dh); dh.connect(this.hallIn);
    this.dl = dl; this.dr = dr;
    this.dest = { dry: this.musicDry, hall: this.hallIn, room: this.roomIn, delay: this.delayIn };
    // ambience + sfx
    this.ambBus = g(0); this.ambBus.connect(this.pre);
    this.ambVerb = g(0.25); this.ambVerb.connect(this.roomIn);
    this.amb = null; // built lazily on planets (its noise loops cost CPU even when silent)
    this.sfxBus = g(0.85); this.sfxBus.connect(this.pre);
    this.sfxVerb = g(0.6); this.sfxVerb.connect(this.hallIn);
    this.fx = new Sfx(ctx, this.A, this.sfxBus, this.sfxVerb);
    this.motors = new Motors(ctx, this.A, this.sfxBus);
    if (this.scene) this._startScene(true);
    return this;
  }

  // ---- API ---------------------------------------------------------------------------------------
  setScene(name, music = null) {
    try { this._setScene(name, music); } catch (e) { console.warn('[audio] setScene', e); }
  }
  _setScene(name, music) {
    const spec = { ...(music || SCENE_MUSIC[name] || SCENE_MUSIC.planet) };
    const key = name + JSON.stringify(spec);
    if (this.scene && this.scene.key === key) return;
    const changed = !!this.scene;
    this.scene = { name, music: spec, key };
    this._todSet = false;
    if (this.ctx) this._startScene(false, changed);
  }

  _startScene(first, arrived = false) {
    const ctx = this.ctx, now = ctx.currentTime, spec = this.scene.music;
    if (this.music) { this.music.stop(now, 3.5); this._old.push(this.music); }
    const seed = (hashStr(this.scene.key) ^ Math.imul(++this._visits, 0x9e3779b1)) >>> 0;
    this.music = new MusicScene(ctx, this.A, this.dest, spec, seed);
    const q = this.engine?.quality;
    this.music.lite = this.lite ?? ((q && q.level <= 0) || !!this.engine?.input?.isTouch);
    this.music.setNight(this._night());
    this.music.start(now + (first ? 0.1 : 1.2), first ? this.fadeIn : 4);
    // delay time = dotted eighth of the new tempo
    const dt = clamp(0.75 * 60 / this.music.tempo, 0.18, 1.2);
    this.dl.delayTime.setTargetAtTime(dt, now, 0.8); this.dr.delayTime.setTargetAtTime(dt, now, 0.8);
    this.fx.setKey(spec.root, spec.scale);
    if (this.scene.name === 'planet') {
      const L = this.engine?.level;
      this._ensureAmb().setSpecies(hashStr(String(L?.planet?.name || spec.root)));
      this._ambKill = null;
    } else if (this.amb) this._ambKill = now + 4;
    this.ambBus.gain.setTargetAtTime(this.scene.name === 'planet' ? 1 : 0, now, 1.5);
    if (arrived) this.fx.play('arrive', { gain: 0.7 }, now + 0.6);
  }

  _ensureAmb() { return (this.amb ||= new Ambience(this.ctx, this.A, this.ambBus, this.ambVerb)); }

  setTimeOfDay(t01) { this._tod = t01; this._todSet = true; }
  setFlight(speed01, altitude01) { this._flight.speed = speed01 || 0; this._flight.alt = altitude01 || 0; this._flight.t = 0.5; }
  setEngine(kind, throttle = 0) { this._engKind = kind; this._engTh = throttle; this.motors?.set(kind, throttle); }

  sfx(name, opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    if ((name === 'step' || name === 'land') && !opts.surface) opts = { ...opts, surface: this._surface() };
    try { this.fx.play(name, opts); } catch (e) { if (!this._sfxErr) { this._sfxErr = true; console.warn('[audio] sfx', name, e); } }
  }

  setVolume(v) {
    this.volume = clamp(v ?? this.volume, 0, 1);
    if (this.master) this.master.gain.setTargetAtTime(this._vol(), this.ctx.currentTime, 0.05);
  }
  // perceptual taper; never above unity (the soft clipper bounds the signal to < 1)
  _vol() { return this.muted ? 0 : Math.min(1, Math.pow(this.volume, 1.5) * 1.15); }
  toggleMute() { this.muted = !this.muted; this.setVolume(this.volume); return this.muted; }

  // ---- per frame ---------------------------------------------------------------------------------
  update(dt) {
    // Engine calls this outside its own try/catch: audio must never take the frame loop down
    try { this._update(dt); } catch (e) { if (!this._updErr) { this._updErr = true; console.warn('[audio] update', e); } }
  }
  _update(dt) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.music) return;
    const now = ctx.currentTime;
    this.music.pump(now, now + 0.6);
    if (this._ambKill && now > this._ambKill) { this.amb?.dispose(); this.amb = null; this._ambKill = null; }
    if (this._old.length) this._old = this._old.filter((m) => { if (now > m.deadAt) { m.dispose(); return false; } return true; });
    this._acc += dt;
    if (this._acc < 0.05) return;
    const step = this._acc; this._acc = 0;
    this._flight.t -= step;
    this.music.setNight(this._night());
    this._planet(step, now);
    if (window.__REVERIES__) window.__REVERIES__.audio = { state: ctx.state, scene: this.scene?.name, bar: this.music.bar, amb: this.amb && Object.fromEntries(Object.entries(this.amb.cur).map(([k, v]) => [k, +v.toFixed(2)])) };
    this.motors.update(now, this._flight.t > 0 ? this._flight.speed : 0);
  }

  // ---- planet soundscape ---------------------------------------------------------------------------
  _night() {
    const w = this.engine?.level?.world;
    if (this.scene?.name !== 'planet') return 0;
    if (w && Number.isFinite(w.daylight)) return clamp(1 - w.daylight, 0, 1);
    if (this._todSet) return clamp(1 - Math.sin(Math.PI * this._tod) * 1.5, 0, 1);
    return 0;
  }

  _planet(dt, now) {
    const amb = this.amb;
    if (!amb) return;
    const P = amb.p;
    const L = this.engine?.level, w = L?.world;
    if (this.scene?.name !== 'planet' || !w || !L.camera) {
      for (const k in P) P[k] = 0;
      amb.update(dt, now);
      return;
    }
    const cam = L.camera.position;
    const alt = w.altitude(cam);
    const atmoTop = (w.atmosphereRadius || w.radius * 1.05) - w.radius;
    const inAir = 1 - smooth(alt, atmoTop * 0.35, atmoTop);
    const near = 1 - smooth(alt, 60, 700);
    const day = clamp(w.daylight ?? 1, 0, 1);
    const life = clamp(L.planet?.life ?? 0.5, 0, 1);
    const ws = L.weatherState || {};
    // probes (2 Hz): biome under the camera, coastline around it
    this._probeT -= dt;
    if (this._probeT <= 0) { this._probeT = 0.5; this._probeAround(w, cam, alt); }
    const pr = this._probe;
    // speed: on-foot / bike from the player, ship via setFlight
    const pl = L.player;
    const v = pl?.velocity ? pl.velocity.length() : 0;
    const flight = this._flight.t > 0 ? this._flight.speed : 0;
    const storm = ws.kind === 'storm' ? 1 : 0;
    const dust = ws.kind === 'dust' ? 0.6 : 0;
    P.wind = inAir * (clamp(w.windStrength ?? 0.5, 0, 1.5) * (0.3 + 0.5 * smooth(alt, 0, 3000)) + clamp(v / 70, 0, 0.6) + flight * 0.9 + storm * 0.5 + dust);
    P.surf = pr.surf * (1 - smooth(alt, 40, 450));
    const veg = pr.veg * life;
    P.birds = veg * Math.pow(day, 0.7) * near * (1 - storm) * (ws.precipitation ? 0.3 : 1);
    const warm = L.planet?.kind === 'ice' ? 0 : 1;
    P.insects = veg * warm * smooth(1 - day, 0.4, 0.9) * near * (ws.precipitation ? 0.2 : 1);
    let city = 0;
    for (const s of w.sites || []) {
      if (!s.position) continue;
      const d = cam.distanceTo(s.position), R = s.radius || 300;
      city = Math.max(city, (SITE_W[s.kind] ?? 0.5) * (1 - smooth(d, R * 0.6, R * 3 + 400)));
    }
    P.city = city * (1 - smooth(alt, 150, 1200)) * (0.55 + 0.45 * day);
    P.rain = (ws.kind === 'rain' || ws.kind === 'storm') ? clamp(ws.precipitation ?? 1, 0, 1) * inAir : 0;
    P.storm = storm * inAir;
    amb.update(dt, now);
  }

  _probeAround(w, cam, alt) {
    const pr = this._probe;
    const dir = cam.clone().normalize();
    let s;
    try { s = w.sample(dir); } catch { s = null; }
    if (s) {
      pr.biome = s.biome;
      pr.veg = [0, 1, 0.9, 0.35, 0.05, 0.1, 0.15, 0.8, 0][s.biome] ?? 0.3;
      pr.veg *= clamp(0.4 + (s.moisture ?? 0.5), 0, 1.2);
    }
    if (!w.hasOcean) { pr.surf = 0; return; }
    // coast detector: fraction of water in a ring around the camera
    const R = w.radius, ring = clamp(alt * 0.6 + 120, 120, 600) / R;
    const t1 = Math.abs(dir.y) < 0.9 ? new dir.constructor(0, 1, 0) : new dir.constructor(1, 0, 0);
    const u = t1.clone().cross(dir).normalize(), vv = dir.clone().cross(u);
    let water = 0, n = 0;
    const p = dir.clone();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      p.copy(dir).addScaledVector(u, Math.cos(a) * ring).addScaledVector(vv, Math.sin(a) * ring).normalize();
      try { if (w.heightAt(p) < w.seaLevel) water++; } catch { /* ignore */ }
      n++;
    }
    let under = false;
    try { under = w.heightAt(dir) < w.seaLevel; } catch { /* ignore */ }
    const f = water / Math.max(1, n);
    pr.surf = clamp(4 * f * (1 - f) + (under ? 0.35 : 0) + (f > 0.95 ? 0.25 : 0), 0, 1);
  }

  _surface() {
    const L = this.engine?.level, w = L?.world, pl = L?.player;
    if (!w || !pl?.position) return 'dirt';
    try {
      const g = w.groundAt(pl.position, this._gq ||= {});
      if (g.water && g.waterDepth > 0.05) return 'water';
      if (g.colliderTop - w.radius > g.terrainHeight + 0.05) return L.aesthetic?.architecture?.material === 'metal' ? 'metal' : 'stone';
      const s = w.sample(pl.position.clone().normalize());
      if ((s.snow ?? 0) > 0.5 || s.biome === 4) return 'snow';
      if ((s.sand ?? 0) > 0.5 || s.biome === 5) return 'sand';
      if (s.biome === 6 || s.biome === 8 || (s.rock ?? 0) > 0.6) return 'rock';
      if (s.biome === 7 || (s.wet ?? 0) > 0.6) return 'wet';
      if (s.biome === 1 || s.biome === 2) return 'grass';
      return 'dirt';
    } catch { return 'dirt'; }
  }
}
