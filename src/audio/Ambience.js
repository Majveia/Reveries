// Planet ambience: wind (altitude / speed / weather driven, gusting), ocean
// surf near coasts (wave sets with crash + foam fizz), birdsong by day (per-planet
// species), crickets at night, city murmur near settlements (crowd bed + distant
// bells and work clanks), rain (hiss + drops) and thunder in storms.
// Driven by params set each frame from AudioEngine.update().
import { rng32 } from './Theory.js';
import { glass } from './Instruments.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export class Ambience {
  constructor(ctx, A, out, reverb) {
    this.ctx = ctx; this.A = A; this.out = out; this.reverb = reverb;
    this.p = { wind: 0, gust: 0, surf: 0, birds: 0, insects: 0, city: 0, rain: 0, storm: 0, space: 0 };
    this.cur = { ...this.p };
    this.rng = rng32(77);
    this.species = [];
    this._srcs = [];
    const loop = (buffer, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = buffer; s.loop = true; s.playbackRate.value = rate; s.start(ctx.currentTime, Math.random() * buffer.duration * 0.9); this._srcs.push(s); return s; };
    const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const filt = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const N = A.noise;
    // wind: low body + whistling band
    this.windLow = filt('lowpass', 300, 0.5); this.windLowG = gain();
    loop(N.brown, 0.9).connect(this.windLow); this.windLow.connect(this.windLowG); this.windLowG.connect(out);
    this.windHi = filt('bandpass', 700, 3.5); this.windHiG = gain();
    loop(N.pink, 1.0).connect(this.windHi); this.windHi.connect(this.windHiG); this.windHiG.connect(out);
    // surf: brown body + pink foam
    this.surfLP = filt('lowpass', 500, 0.6); this.surfG = gain();
    loop(N.brown, 1.1).connect(this.surfLP); this.surfLP.connect(this.surfG); this.surfG.connect(out);
    this.foamHP = filt('highpass', 2500, 0.5); this.foamG = gain();
    loop(N.pink, 0.95).connect(this.foamHP); this.foamHP.connect(this.foamG); this.foamG.connect(out);
    this.surfMaster = gain(0); this.surfG.disconnect(); this.foamG.disconnect(); this.surfG.connect(this.surfMaster); this.foamG.connect(this.surfMaster); this.surfMaster.connect(out);
    // insects
    this.insectG = gain(); loop(A.samples.crickets).connect(this.insectG); this.insectG.connect(out);
    // city crowd bed
    this.cityBP = filt('bandpass', 480, 0.9); this.cityG = gain();
    loop(N.pink, 0.8).connect(this.cityBP); this.cityBP.connect(this.cityG); this.cityG.connect(out);
    // rain: hiss + drops
    this.rainHP = filt('highpass', 600, 0.5); this.rainLP = filt('lowpass', 7000, 0.5); this.rainG = gain();
    loop(N.pink, 1.0).connect(this.rainHP); this.rainHP.connect(this.rainLP); this.rainLP.connect(this.rainG); this.rainG.connect(out);
    this.dropG = gain(); loop(A.samples.drops).connect(this.dropG); this.dropG.connect(out);
    this._wave = 0; this._bird = 1; this._city = 2; this._thunder = 6; this._gustT = 0; this._gust = 0;
    this.setSpecies(1);
  }

  dispose() {
    for (const s of this._srcs) { try { s.stop(); s.disconnect(); } catch { /* ignore */ } }
    this._srcs.length = 0;
  }

  setSpecies(seed) {
    const r = rng32(seed);
    this.species = Array.from({ length: 3 }, () => ({
      kind: r.pick(['whistle', 'trill', 'warble', 'coo']), f: r.range(2200, 4800), span: r.range(0.15, 0.5), notes: r.int(2, 6), gap: r.range(0.08, 0.2), down: r.chance(0.5),
    }));
  }

  /** Smoothly steer the beds toward the target params (called ~20 Hz). */
  update(dt, now) {
    const P = this.p, C = this.cur, k = 1 - Math.exp(-dt * 1.5);
    for (const key in P) C[key] += (P[key] - C[key]) * k;
    const tc = 0.25;
    // gusts: random walk
    this._gustT -= dt;
    if (this._gustT <= 0) { this._gustT = this.rng.range(1.5, 5); this._gustTarget = this.rng.range(0, 1); }
    this._gust += ((this._gustTarget ?? 0) - this._gust) * (1 - Math.exp(-dt * 0.7));
    const w = clamp(C.wind, 0, 1.5), g = this._gust;
    this.windLowG.gain.setTargetAtTime(0.5 * w * (0.6 + 0.4 * g), now, tc);
    this.windLow.frequency.setTargetAtTime(180 + 500 * w * (0.5 + 0.5 * g), now, tc);
    this.windHiG.gain.setTargetAtTime(0.16 * w * w * (0.3 + 0.7 * g), now, tc);
    this.windHi.frequency.setTargetAtTime(450 + 1300 * w * g, now, 0.6);
    this.insectG.gain.setTargetAtTime(0.3 * C.insects, now, 0.5);
    this.cityG.gain.setTargetAtTime(0.55 * C.city * (0.8 + 0.2 * Math.sin(now * 0.37) * Math.sin(now * 0.11)), now, 0.4);
    this.rainG.gain.setTargetAtTime(0.4 * C.rain, now, 0.5);
    this.dropG.gain.setTargetAtTime(0.18 * C.rain, now, 0.5);
    this.surfMaster.gain.setTargetAtTime(clamp(C.surf, 0, 1), now, 0.5);

    // ---- events
    const ctx = this.ctx, r = this.rng;
    // waves: crash, then foam wash
    this._wave -= dt;
    if (this._wave <= 0 && C.surf > 0.02) {
      const per = r.range(6, 11), big = r.range(0.6, 1), t = now + 0.05;
      this._wave = per;
      const G = this.surfG.gain, F = this.surfLP.frequency, FG = this.foamG.gain;
      G.cancelScheduledValues(t); G.setValueAtTime(G.value, t); G.linearRampToValueAtTime(0.55 * big, t + 2.2); G.setTargetAtTime(0.1, t + 2.4, 1.6);
      F.cancelScheduledValues(t); F.setValueAtTime(F.value, t); F.linearRampToValueAtTime(1600 * big, t + 2.3); F.setTargetAtTime(380, t + 2.5, 1.2);
      FG.cancelScheduledValues(t); FG.setValueAtTime(FG.value, t); FG.linearRampToValueAtTime(0.12 * big, t + 2.6); FG.setTargetAtTime(0.0, t + 3.2, 1.5);
    }
    // birds
    this._bird -= dt;
    if (this._bird <= 0) {
      this._bird = r.range(0.6, 2.5) / Math.max(0.15, C.birds);
      if (C.birds > 0.05 && this.species.length) this._birdCall(now + 0.05, r.pick(this.species), C.birds);
    }
    // city events
    this._city -= dt;
    if (this._city <= 0) {
      this._city = r.range(1.5, 5);
      if (C.city > 0.08) this._cityEvent(now + 0.05, C.city);
    }
    // thunder
    this._thunder -= dt;
    if (this._thunder <= 0) {
      this._thunder = r.range(9, 25);
      if (C.storm > 0.3) this._thunderAt(now + 0.1, C.storm);
    }
    void ctx;
  }

  _birdCall(t, sp, level) {
    const ctx = this.ctx, r = this.rng;
    const pan = r.range(-0.9, 0.9), dist = r.range(0.3, 1);
    const out = ctx.createGain(); out.gain.value = 0.05 * level * dist;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000 + 6000 * dist;
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    out.connect(lp); if (p) { p.pan.value = pan; lp.connect(p); p.connect(this.out); p.connect(this.reverb); } else lp.connect(this.out);
    let tt = t;
    const f0 = sp.f * r.range(0.95, 1.05);
    for (let i = 0; i < sp.notes; i++) {
      const o = ctx.createOscillator(); o.type = 'sine';
      const g = ctx.createGain();
      const d = sp.kind === 'trill' ? 0.045 : sp.kind === 'coo' ? 0.35 : sp.span * r.range(0.4, 0.9);
      const f = sp.kind === 'coo' ? f0 * 0.28 : f0 * (1 + (sp.down ? -1 : 1) * i * 0.04);
      o.frequency.setValueAtTime(f, tt);
      if (sp.kind === 'whistle') o.frequency.exponentialRampToValueAtTime(f * (sp.down ? 0.7 : 1.4), tt + d);
      else if (sp.kind === 'warble') { o.frequency.linearRampToValueAtTime(f * 1.25, tt + d * 0.3); o.frequency.linearRampToValueAtTime(f * 0.9, tt + d); }
      else if (sp.kind === 'coo') o.frequency.linearRampToValueAtTime(f * 0.92, tt + d);
      else o.frequency.linearRampToValueAtTime(f * 1.08, tt + d);
      g.gain.setValueAtTime(0, tt); g.gain.linearRampToValueAtTime(1, tt + Math.min(0.02, d * 0.3)); g.gain.setTargetAtTime(0, tt + d * 0.6, d * 0.2);
      o.connect(g); g.connect(out); o.start(tt); o.stop(tt + d + 0.1);
      tt += d + (sp.kind === 'trill' ? 0.02 : sp.gap);
    }
  }

  _cityEvent(t, level) {
    const ctx = this.ctx, r = this.rng, A = this.A;
    const kind = r.weighted(['bell', 'clank', 'voices'], [1, 2, 3]);
    const g = ctx.createGain(); g.gain.value = level; g.connect(this.out); g.connect(this.reverb);
    if (kind === 'bell') glass(ctx, A, g, t, r.pick([55, 57, 60, 62]), 1, 0.25, { ratio: 2.4, decay: 4, pan: r.range(-0.7, 0.7) });
    else if (kind === 'clank') {
      for (let i = 0, n = r.int(1, 3); i < n; i++) {
        const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = r.range(700, 1500);
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = r.range(1500, 3500); bp.Q.value = 8;
        const e = ctx.createGain(); const tt = t + i * r.range(0.35, 0.6);
        e.gain.setValueAtTime(0, tt); e.gain.linearRampToValueAtTime(0.03, tt + 0.002); e.gain.setTargetAtTime(0, tt + 0.003, 0.05);
        o.connect(bp); bp.connect(e); e.connect(g); o.start(tt); o.stop(tt + 0.4);
      }
    } else {
      // distant voices: formant-filtered bursts with speech-like pitch contours
      for (let i = 0, n = r.int(3, 7); i < n; i++) {
        const tt = t + i * r.range(0.12, 0.3);
        const o = ctx.createOscillator(); o.type = 'sawtooth'; const f = r.range(110, 230);
        o.frequency.setValueAtTime(f, tt); o.frequency.linearRampToValueAtTime(f * r.range(0.8, 1.25), tt + 0.2);
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = r.pick([500, 700, 1100, 1700]); bp.Q.value = 4;
        const e = ctx.createGain(); e.gain.setValueAtTime(0, tt); e.gain.linearRampToValueAtTime(0.025, tt + 0.03); e.gain.setTargetAtTime(0, tt + 0.12, 0.04);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
        o.connect(bp); bp.connect(e); e.connect(lp); lp.connect(g); o.start(tt); o.stop(tt + 0.4);
      }
    }
  }

  _thunderAt(t, level) {
    const ctx = this.ctx, r = this.rng;
    const src = ctx.createBufferSource(); src.buffer = this.A.noise.brown; src.playbackRate.value = r.range(0.5, 0.8);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(120, t + 4);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t);
    let tt = t;
    for (let i = 0; i < r.int(2, 4); i++) { g.gain.linearRampToValueAtTime(0.7 * level * r.range(0.5, 1), tt + 0.08); g.gain.setTargetAtTime(0.25 * level, tt + 0.1, 0.3); tt += r.range(0.4, 1.1); }
    g.gain.setTargetAtTime(0, tt, 1.4);
    src.connect(lp); lp.connect(g); g.connect(this.out); g.connect(this.reverb);
    src.start(t, r.range(0, 2)); src.stop(tt + 6);
  }
}
