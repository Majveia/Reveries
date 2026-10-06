// Sound effects: UI (tuned to the current key), warp whoosh, arrival swell,
// surface-dependent footsteps, jump/land, board/alight servos, boost, takeoff,
// discovery chime — plus continuous vehicle motor layers (hover-bike whine,
// ship roar + afterburner).
import { mtof, degSemi, scaleOf } from './Theory.js';
import { glass, pad, sub } from './Instruments.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export class Sfx {
  constructor(ctx, A, out, reverb) {
    this.ctx = ctx; this.A = A; this.out = out; this.reverb = reverb;
    this.key = 50; this.scale = scaleOf('lydian');
    this._last = {};
  }
  setKey(root, scaleName) { this.key = root; this.scale = scaleOf(scaleName === 'jazz' ? 'ionian' : scaleName); }
  note(deg, oct = 0) { return this.key + 12 * oct + degSemi(this.scale, deg); }

  _g(v, rev = 0.3, pan = 0) {
    const ctx = this.ctx, g = ctx.createGain(); g.gain.value = v;
    let node = g;
    if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); node = p; }
    node.connect(this.out);
    if (rev) { const s = ctx.createGain(); s.gain.value = rev; node.connect(s); s.connect(this.reverb); }
    return g;
  }
  _noise(t, dur, type = 'white', rate = 1) {
    const s = this.ctx.createBufferSource(); s.buffer = this.A.noise[type]; s.loop = true; s.playbackRate.value = rate;
    s.start(t, Math.random() * 4); s.stop(t + dur + 0.05); return s;
  }
  _filt(type, f, q = 0.7) { const b = this.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
  _env(t, a, d, peak = 1, curve = 'exp') {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a);
    if (curve === 'exp') g.gain.setTargetAtTime(0, t + a, d / 4); else g.gain.linearRampToValueAtTime(0, t + a + d);
    return g;
  }
  _thump(t, f0, f1, dec, v, dest) {
    const o = this.ctx.createOscillator(); o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dec);
    const e = this._env(t, 0.003, dec, v); o.connect(e); e.connect(dest); o.start(t); o.stop(t + dec * 2 + 0.05);
  }

  play(name, o = {}, t = this.ctx.currentTime + 0.01) {
    // rate-limit identical sounds (e.g. hover spam)
    const now = this.ctx.currentTime;
    const minGap = { hover: 0.06, step: 0.12, ui: 0.05, select: 0.05, land: 0.15 }[name] ?? 0.02;
    if (this._last[name] != null && now - this._last[name] < minGap) return;
    this._last[name] = now;
    const fn = this['_' + name];
    if (fn) fn.call(this, t, o);
  }

  // ---- UI ----------------------------------------------------------------------------------------
  _hover(t) {
    const g = this._g(0.8, 0.15);
    const o = this.ctx.createOscillator(); o.frequency.value = mtof(this.note(4, 2));
    const e = this._env(t, 0.004, 0.06, 0.08); o.connect(e); e.connect(g); o.start(t); o.stop(t + 0.15);
  }
  _ui(t) {
    const g = this._g(2, 0.35);
    glass(this.ctx, this.A, g, t, this.note(4, 1), 0.3, 0.35, { ratio: 2, decay: 1.2, pan: 0.1 });
  }
  _select(t) {
    const g = this._g(1.6, 0.45);
    glass(this.ctx, this.A, g, t, this.note(0, 1), 0.4, 0.4, { ratio: 2, decay: 1.6, pan: -0.15 });
    glass(this.ctx, this.A, g, t + 0.07, this.note(4, 1), 0.4, 0.35, { ratio: 2, decay: 1.8, pan: 0.15 });
  }
  _discover(t) {
    const g = this._g(1, 0.6);
    [0, 2, 4, 7, 9].forEach((d, i) => glass(this.ctx, this.A, g, t + i * 0.11, this.note(d, 1), 0.5, 0.42 - i * 0.03, { ratio: 3.5, decay: 3, pan: -0.4 + i * 0.2 }));
    [0, 4].forEach((d) => pad(this.ctx, this.A, g, t, this.note(d, 0), 1.2, 0.7, { attack: 0.6, release: 2.5, bright: 0.8 }));
  }

  // ---- travel ------------------------------------------------------------------------------------
  _warp(t) {
    const ctx = this.ctx, dur = 2.4, g = this._g(1, 0.6);
    const n = this._noise(t, dur, 'pink');
    const bp = this._filt('bandpass', 150, 1.2);
    bp.frequency.setValueAtTime(140, t); bp.frequency.exponentialRampToValueAtTime(5200, t + dur * 0.75); bp.frequency.exponentialRampToValueAtTime(900, t + dur);
    const e = ctx.createGain(); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.9, t + dur * 0.7); e.gain.linearRampToValueAtTime(0, t + dur);
    n.connect(bp); bp.connect(e); e.connect(g);
    // rising tonal glide (two detuned saws through a sweeping low-pass) + sub
    const lp = this._filt('lowpass', 300, 4); lp.frequency.setValueAtTime(300, t); lp.frequency.exponentialRampToValueAtTime(4000, t + dur * 0.8);
    const te = ctx.createGain(); te.gain.setValueAtTime(0, t); te.gain.linearRampToValueAtTime(0.05, t + dur * 0.6); te.gain.linearRampToValueAtTime(0, t + dur);
    for (const dt of [-12, 12]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.detune.value = dt;
      o.frequency.setValueAtTime(mtof(this.key - 12), t); o.frequency.exponentialRampToValueAtTime(mtof(this.key + 24), t + dur);
      o.connect(lp); o.start(t); o.stop(t + dur + 0.1);
    }
    lp.connect(te); te.connect(g);
    sub(ctx, this.A, g, t, this.key - 24, dur * 0.8, 0.8, { attack: dur * 0.6, release: 0.6 });
  }
  _arrive(t, o = {}) {
    const ctx = this.ctx, g = this._g(o.gain ?? 0.9, 0.7);
    const notes = [this.note(0, -1), this.note(2, 0), this.note(4, 0), this.note(6, 0)];
    notes.forEach((m, i) => pad(ctx, this.A, g, t + i * 0.04, m, 2.2, 0.85, { attack: 1.1, release: 3.5, bright: 0.9, pan: (i - 1.5) * 0.35 }));
    sub(ctx, this.A, g, t, this.key - 24, 1.8, 0.8, { attack: 0.8, release: 2.5 });
    [7, 9, 11, 14].forEach((d, i) => glass(ctx, this.A, g, t + 0.9 + i * 0.13, this.note(d, 1), 0.5, 0.25, { ratio: 3.5, decay: 3, pan: (i - 1.5) * 0.4 }));
  }
  _takeoff(t) {
    const ctx = this.ctx, g = this._g(0.9, 0.3);
    const n = this._noise(t, 3, 'brown');
    const lp = this._filt('lowpass', 120, 1); lp.frequency.setValueAtTime(120, t); lp.frequency.exponentialRampToValueAtTime(1600, t + 1.4); lp.frequency.exponentialRampToValueAtTime(500, t + 3);
    const e = ctx.createGain(); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.9, t + 0.8); e.gain.setTargetAtTime(0, t + 1.6, 0.5);
    n.connect(lp); lp.connect(e); e.connect(g);
  }
  _boost(t) {
    const ctx = this.ctx, g = this._g(0.8, 0.25);
    const n = this._noise(t, 1.4, 'white');
    const bp = this._filt('bandpass', 400, 1.5); bp.frequency.setValueAtTime(400, t); bp.frequency.exponentialRampToValueAtTime(6000, t + 0.5); bp.frequency.exponentialRampToValueAtTime(1500, t + 1.3);
    const e = this._env(t, 0.06, 1.2, 0.6); n.connect(bp); bp.connect(e); e.connect(g);
    this._thump(t, 90, 40, 0.4, 0.5, g);
  }

  // ---- body --------------------------------------------------------------------------------------
  _jump(t) {
    const g = this._g(0.6, 0.05);
    const n = this._noise(t, 0.3, 'pink'); const bp = this._filt('bandpass', 700, 1);
    bp.frequency.setValueAtTime(500, t); bp.frequency.exponentialRampToValueAtTime(1400, t + 0.2);
    const e = this._env(t, 0.03, 0.2, 0.5); n.connect(bp); bp.connect(e); e.connect(g);
    this._step(t, { intensity: 0.7 });
  }
  _land(t, o) {
    const k = clamp(o.intensity ?? 0.5, 0, 1);
    const g = this._g(0.5 + 0.6 * k, 0.08);
    this._thump(t, 110, 38, 0.18 + 0.2 * k, 0.9, g);
    const n = this._noise(t, 0.4, 'brown'); const lp = this._filt('lowpass', 500 + 1500 * k);
    const e = this._env(t, 0.004, 0.25 + 0.2 * k, 0.8); n.connect(lp); lp.connect(e); e.connect(g);
    this._step(t + 0.01, { intensity: 1, surface: o.surface });
  }
  _step(t, o) {
    const ctx = this.ctx, k = clamp(o.intensity ?? 0.5, 0.15, 1), s = o.surface || 'dirt';
    const g = this._g(0.8 * (0.5 + 0.5 * k), 0.04, (Math.random() - 0.5) * 0.25);
    const burst = (type, ftype, f, q, a, d, v, at = t, rate = 1) => {
      const n = this._noise(at, a + d + 0.1, type, rate); const fl = this._filt(ftype, f, q); const e = this._env(at, a, d, v);
      n.connect(fl); fl.connect(e); e.connect(g);
    };
    const r = 0.85 + Math.random() * 0.3;
    if (s === 'water') {
      burst('white', 'lowpass', 2600 * r, 0.8, 0.01, 0.28, 0.7);
      for (let i = 0; i < 3; i++) { const o2 = ctx.createOscillator(); const tt = t + 0.04 + i * 0.05 * r; o2.frequency.setValueAtTime(500 + Math.random() * 600, tt); o2.frequency.exponentialRampToValueAtTime(1400 + Math.random() * 800, tt + 0.05); const e = this._env(tt, 0.003, 0.05, 0.06); o2.connect(e); e.connect(g); o2.start(tt); o2.stop(tt + 0.12); }
      return;
    }
    this._thump(t, 85 * r, 45, 0.07, 0.35 * k, g);
    if (s === 'grass') { burst('white', 'bandpass', 2600 * r, 0.8, 0.02, 0.16, 0.35); burst('pink', 'lowpass', 900, 0.7, 0.004, 0.06, 0.3); }
    else if (s === 'sand') { burst('white', 'bandpass', 3500 * r, 0.6, 0.03, 0.2, 0.32); }
    else if (s === 'snow') { for (let i = 0; i < 6; i++) burst('white', 'bandpass', 2500 + Math.random() * 2500, 2, 0.002, 0.03, 0.5 * Math.random() + 0.2, t + i * 0.018 + Math.random() * 0.01); }
    else if (s === 'rock' || s === 'stone') { burst('white', 'bandpass', 1900 * r, 1.8, 0.001, 0.04, 0.8); burst('pink', 'highpass', 4000, 0.7, 0.001, 0.08, 0.15, t + 0.012); }
    else if (s === 'metal') {
      burst('white', 'bandpass', 2400, 3, 0.001, 0.03, 0.6);
      const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 1150 * r; const bp = this._filt('bandpass', 2300, 9);
      const e = this._env(t, 0.001, 0.18, 0.05); o2.connect(bp); bp.connect(e); e.connect(g); o2.start(t); o2.stop(t + 0.3);
    } else if (s === 'wet') {
      const n = this._noise(t, 0.25, 'pink'); const lp = this._filt('lowpass', 1500, 4); lp.frequency.setValueAtTime(1500, t); lp.frequency.exponentialRampToValueAtTime(300, t + 0.15);
      const e = this._env(t, 0.01, 0.15, 0.7); n.connect(lp); lp.connect(e); e.connect(g);
    } else { burst('pink', 'lowpass', 1300 * r, 0.8, 0.004, 0.08, 0.7); burst('white', 'bandpass', 3000, 1, 0.006, 0.05, 0.12); }
  }
  _board(t) {
    const ctx = this.ctx, g = this._g(0.7, 0.15);
    this._step(t, { intensity: 1, surface: 'metal' });
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(110, t + 0.1); o.frequency.exponentialRampToValueAtTime(440, t + 0.7);
    const lp = this._filt('lowpass', 1200, 3); const e = ctx.createGain(); e.gain.setValueAtTime(0, t + 0.1); e.gain.linearRampToValueAtTime(0.06, t + 0.25); e.gain.linearRampToValueAtTime(0, t + 0.75);
    o.connect(lp); lp.connect(e); e.connect(g); o.start(t + 0.1); o.stop(t + 0.8);
    glass(ctx, this.A, g, t + 0.65, this.note(4, 1), 0.3, 0.3, { ratio: 2, decay: 1 });
  }
  _alight(t) {
    const ctx = this.ctx, g = this._g(0.7, 0.15);
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(400, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.6);
    const lp = this._filt('lowpass', 1000, 3); const e = ctx.createGain(); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.06, t + 0.1); e.gain.linearRampToValueAtTime(0, t + 0.6);
    o.connect(lp); lp.connect(e); e.connect(g); o.start(t); o.stop(t + 0.7);
    this._step(t + 0.55, { intensity: 1, surface: 'metal' });
  }
}

/** Continuous vehicle motor layers. */
export class Motors {
  constructor(ctx, A, out) {
    this.ctx = ctx;
    const g = (v = 0) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const loop = (b, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = b; s.loop = true; s.playbackRate.value = rate; s.start(); return s; };
    this.out = g(1); this.out.connect(out);
    // bike: electric whine (two detuned tones) + low hum + air turbulence
    this.bikeG = g(); this.bikeG.connect(this.out);
    this.whine = [ctx.createOscillator(), ctx.createOscillator()];
    this.whine[0].type = 'triangle'; this.whine[1].type = 'sine'; this.whine[1].detune.value = 9;
    const wf = ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.Q.value = 2; this.whineF = wf;
    this.whineG = g(0.06);
    for (const o of this.whine) { o.frequency.value = 300; o.connect(wf); o.start(); }
    wf.connect(this.whineG); this.whineG.connect(this.bikeG);
    this.hum = ctx.createOscillator(); this.hum.type = 'sawtooth'; this.hum.frequency.value = 55;
    const hl = ctx.createBiquadFilter(); hl.type = 'lowpass'; hl.frequency.value = 260; this.humF = hl;
    const hg = g(0.1); this.hum.connect(hl); hl.connect(hg); hg.connect(this.bikeG); this.hum.start();
    const tb = ctx.createBiquadFilter(); tb.type = 'bandpass'; tb.frequency.value = 900; tb.Q.value = 0.6; this.turbF = tb;
    this.turbG = g(0); loop(A.noise.pink).connect(tb); tb.connect(this.turbG); this.turbG.connect(this.bikeG);
    // ship: roar (brown LP) + jet hiss (afterburner) + sub rumble
    this.shipG = g(); this.shipG.connect(this.out);
    const rl = ctx.createBiquadFilter(); rl.type = 'lowpass'; rl.frequency.value = 200; rl.Q.value = 0.8; this.roarF = rl;
    this.roarG = g(0.6); loop(A.noise.brown, 0.8).connect(rl); rl.connect(this.roarG); this.roarG.connect(this.shipG);
    const jh = ctx.createBiquadFilter(); jh.type = 'bandpass'; jh.frequency.value = 1800; jh.Q.value = 0.7; this.jetF = jh;
    this.jetG = g(0); loop(A.noise.white).connect(jh); jh.connect(this.jetG); this.jetG.connect(this.shipG);
    this.rumble = ctx.createOscillator(); this.rumble.frequency.value = 40; const rg = g(0.25); this.rumble.connect(rg); rg.connect(this.shipG); this.rumble.start();
    this.kind = null; this.throttle = 0;
  }
  set(kind, throttle) { this.kind = kind; this.throttle = clamp(throttle || 0, 0, 1.5); }
  update(now, speed01 = 0) {
    const k = this.kind, th = this.throttle, tc = 0.12;
    this.bikeG.gain.setTargetAtTime(k === 'bike' ? 1.2 : 0, now, k === 'bike' ? 0.25 : 0.5);
    this.shipG.gain.setTargetAtTime(k === 'ship' ? 0.6 : 0, now, k === 'ship' ? 0.4 : 0.8);
    if (k === 'bike') {
      const f = 240 + 520 * th + 300 * speed01;
      for (const o of this.whine) o.frequency.setTargetAtTime(f, now, tc);
      this.whineF.frequency.setTargetAtTime(f * 1.5, now, tc);
      this.whineG.gain.setTargetAtTime(0.04 + 0.05 * th, now, tc);
      this.hum.frequency.setTargetAtTime(48 + 40 * th, now, tc);
      this.humF.frequency.setTargetAtTime(200 + 500 * th, now, tc);
      this.turbG.gain.setTargetAtTime(0.05 + 0.25 * speed01, now, tc);
      this.turbF.frequency.setTargetAtTime(600 + 1800 * speed01, now, tc);
    } else if (k === 'ship') {
      this.roarF.frequency.setTargetAtTime(150 + 900 * th, now, tc);
      this.roarG.gain.setTargetAtTime(0.35 + 0.5 * th, now, tc);
      const ab = clamp((th - 0.75) / 0.5, 0, 1);
      this.jetG.gain.setTargetAtTime(0.02 + 0.08 * th + 0.2 * ab, now, tc);
      this.jetF.frequency.setTargetAtTime(1200 + 2500 * ab, now, tc);
      this.rumble.frequency.setTargetAtTime(34 + 18 * th, now, tc);
    }
  }
}
