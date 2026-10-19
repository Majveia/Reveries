// Generative score. A MusicScene composes bar by bar just ahead of the audio
// clock: functional progressions per mode, voice-led pads, arpeggio patterns,
// motif-developed melodies (A A' B A'' periods with call-and-response rests),
// percussion per style, an intensity arc across sections, and day/night
// variation. 'jazz' runs a dedicated lounge combo: AABA ii–V–I form, walking
// bass with chromatic approaches, brushed drums + swung ride, rootless rhodes
// comping and vibraphone lines.
import * as T from './Theory.js';
import { INSTRUMENTS as I, hit } from './Instruments.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export const SCENE_MUSIC = {
  cosmos: { root: 50, scale: 'lydian', tempo: 52, timbre: 'cosmos' },
  galaxy: { root: 45, scale: 'dorian', tempo: 58, timbre: 'galaxy' },
  system: { root: 45, scale: 'aeolian', tempo: 66, timbre: 'system' },
  planet: { root: 52, scale: 'dorian', tempo: 62, timbre: 'strings' },
};

// Layer = [instrument, mix gain, options]. chordBars = harmonic rhythm.
// reverb: send amounts {hall, room, delay}.
const STYLES = {
  cosmos: { // Vangelis / Interstellar: CS-80 pad + organ bed, deep drone, glass sparkle, brass lead swells
    chordBars: 2, pad: ['pad', 1.0, { attack: 3.5, release: 6, bright: 0.55, n: 4, lo: 50, hi: 76 }], pad2: ['organ', 0.32, { attack: 2.5, release: 3, bright: 0.5, n: 3, lo: 38, hi: 62 }],
    drone: ['drone', 0.55, { oct: -2 }], arp: ['glass', 0.45, { pattern: 'sparkle', sub: 2, lo: 72, hi: 96, ratio: 3.5 }],
    melody: ['lead', 0.75, { lo: 62, hi: 81, density: 0.45, attack: 0.5, release: 2.5 }], perc: null, send: { hall: 0.75, room: 0, delay: 0.32 }, bright: 0.8,
  },
  galaxy: { // Blade Runner shimmer: string pad, soft synth arpeggio through delay, bells
    chordBars: 2, pad: ['strings', 0.9, { attack: 2.5, release: 4, bright: 0.6, n: 4, lo: 48, hi: 74 }], drone: ['sub', 0.6, { oct: -1, attack: 2, release: 3 }],
    arp: ['synth', 0.5, { pattern: 'updown', sub: 2, lo: 57, hi: 81, bright: 0.6 }], melody: ['glass', 0.7, { lo: 67, hi: 88, density: 0.5, ratio: 2 }],
    perc: null, send: { hall: 0.7, room: 0, delay: 0.4 }, bright: 0.8,
  },
  system: { // Interstellar: pipe organ chords, 8th-note organ ostinato, clock ticks
    chordBars: 2, pad: ['organ', 0.85, { attack: 1.2, release: 2.5, bright: 0.65, n: 4, lo: 48, hi: 72 }], drone: ['organ', 0.5, { oct: -2, attack: 3, release: 4, sub: false }],
    arp: ['organ', 0.42, { pattern: 'ostinato', sub: 2, lo: 64, hi: 84, attack: 0.03, release: 0.25, bright: 0.8, sub_: false }], melody: ['strings', 0.6, { lo: 60, hi: 79, density: 0.4, attack: 0.8 }],
    perc: 'tick', send: { hall: 0.7, room: 0, delay: 0.12 }, bright: 0.85,
  },
  drone: { // Dune / Mustafar / Zone: throat-low drone, dark pad, ney flute, frame drum
    chordBars: 4, pad: ['pad', 0.8, { attack: 4, release: 5, bright: 0.45, n: 3, lo: 45, hi: 67, sub: true }], drone: ['drone', 0.8, { oct: -1 }],
    arp: null, melody: ['flute', 0.6, { lo: 62, hi: 82, density: 0.4, ornament: true }], perc: 'frame', send: { hall: 0.6, room: 0.1, delay: 0.22 }, bright: 0.6,
  },
  strings: { // Hisaishi: string orchestra, broken-chord piano, piano melody
    chordBars: 2, pad: ['strings', 0.85, { attack: 1.6, release: 2.8, bright: 0.75, n: 4, lo: 50, hi: 74 }], drone: ['sub', 0.45, { oct: -1, attack: 1.2 }],
    arp: ['piano', 0.55, { pattern: 'broken', sub: 2, lo: 43, hi: 72 }], melody: ['piano', 0.8, { lo: 67, hi: 88, density: 0.6 }], nightMelody: ['glass', 0.75, { lo: 67, hi: 88, density: 0.45, ratio: 2, decay: 2.5 }],
    perc: null, send: { hall: 0.5, room: 0.15, delay: 0.1 }, bright: 0.9,
  },
  glass: { // Moebius / Pandora: glass bells, airy pad, celesta melody
    chordBars: 2, pad: ['pad', 0.85, { attack: 2.5, release: 4, bright: 0.7, n: 4, lo: 52, hi: 76 }], drone: ['sub', 0.45, { oct: -1, attack: 2 }],
    arp: ['glass', 0.5, { pattern: 'up', sub: 2, lo: 64, hi: 91, ratio: 3.5 }], melody: ['glass', 0.7, { lo: 72, hi: 93, density: 0.5, ratio: 2 }], nightMelody: ['flute', 0.5, { lo: 64, hi: 84, density: 0.35, breath: 1.4 }],
    perc: null, send: { hall: 0.65, room: 0, delay: 0.35 }, bright: 0.9,
  },
  choir: { // Kubrick / Tarkovsky / Elden Ring: choir, organ pedal, sparse flute
    chordBars: 4, pad: ['choir', 0.85, { attack: 3, release: 4, n: 4, lo: 48, hi: 72, vowel: 'a' }], pad2: ['organ', 0.25, { attack: 2, release: 3, bright: 0.4, n: 3, lo: 36, hi: 55 }],
    drone: ['drone', 0.55, { oct: -2 }], arp: null, melody: ['choir', 0.6, { lo: 64, hi: 79, density: 0.3, attack: 0.8, vowel: 'o' }], perc: null,
    send: { hall: 0.85, room: 0, delay: 0.1 }, bright: 0.7,
  },
  pluck: { // Wukong / Sekiro: guzheng runs, dizi flute, soft strings, frame drum
    chordBars: 2, pad: ['strings', 0.6, { attack: 2.5, release: 3, bright: 0.5, n: 3, lo: 50, hi: 70 }], drone: ['drone', 0.45, { oct: -1, bright: 0.6 }],
    arp: ['pluck', 0.55, { pattern: 'guzheng', sub: 4, lo: 55, hi: 86 }], melody: ['flute', 0.65, { lo: 67, hi: 88, density: 0.55, ornament: true }], nightMelody: ['pluck', 0.6, { lo: 60, hi: 84, density: 0.4, decay: 3 }],
    perc: 'frame', send: { hall: 0.55, room: 0.1, delay: 0.18 }, bright: 0.85,
  },
  organ: { // Interstellar (Miller): organ + ticking + strings
    chordBars: 2, pad: ['organ', 0.85, { attack: 1.5, release: 2.5, bright: 0.6, n: 4, lo: 48, hi: 72 }], drone: ['organ', 0.45, { oct: -2, attack: 3, sub: false }],
    arp: ['organ', 0.38, { pattern: 'ostinato', sub: 2, lo: 64, hi: 84, attack: 0.03, release: 0.25, bright: 0.8 }], melody: ['strings', 0.55, { lo: 60, hi: 79, density: 0.35 }],
    perc: 'tick', send: { hall: 0.75, room: 0, delay: 0.12 }, bright: 0.8,
  },
  synth: { // Rick & Morty / NASA-punk: analog arps, CS-80 pad, brass lead, light pulse
    chordBars: 2, pad: ['pad', 0.8, { attack: 1.5, release: 3, bright: 0.8, n: 4, lo: 50, hi: 74 }], drone: ['sub', 0.6, { oct: -1, attack: 0.5 }],
    arp: ['synth', 0.6, { pattern: 'up', sub: 4, lo: 55, hi: 84, bright: 0.8 }], melody: ['lead', 0.65, { lo: 62, hi: 84, density: 0.5 }], nightMelody: ['glass', 0.6, { lo: 67, hi: 88, density: 0.4, ratio: 3.5 }],
    perc: 'pulse', send: { hall: 0.45, room: 0.1, delay: 0.38 }, bright: 1,
  },
  jazz: { chordBars: 1, send: { hall: 0.2, room: 0.45, delay: 0.08 }, bright: 1 },
};

export class MusicScene {
  /**
   * @param ctx BaseAudioContext
   * @param A shared assets
   * @param dest { dry, hall, room, delay } AudioNodes
   * @param spec { root, scale, tempo, timbre }
   */
  constructor(ctx, A, dest, spec, seed = 1) {
    this.ctx = ctx; this.A = A; this.spec = { ...spec };
    this.style = STYLES[spec.timbre] || STYLES.strings;
    this.isJazz = spec.timbre === 'jazz';
    this.rng = T.rng32(seed);
    this.scale = T.scaleOf(spec.scale === 'jazz' ? 'ionian' : spec.scale);
    this.scaleName = spec.scale === 'jazz' ? 'ionian' : spec.scale;
    this.key = spec.root;
    this.tempo = clamp(spec.tempo || 60, 36, 140);
    this.meter = 4;
    this.barDur = (this.meter * 60) / this.tempo;
    this.night = 0;
    this.out = ctx.createGain(); this.out.gain.value = 0;
    // layer buses
    this.bus = {};
    for (const k of ['pad', 'drone', 'arp', 'melody', 'perc', 'bass']) { const g = ctx.createGain(); g.connect(this.out); this.bus[k] = g; }
    // arpeggios alternate between two persistent panned buses (no per-note panner)
    this.arpLR = [-0.32, 0.32].map((pv) => {
      const g = ctx.createGain();
      if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pv; g.connect(p); p.connect(this.bus.arp); } else g.connect(this.bus.arp);
      return g;
    });
    // sends (per scene, so crossfades carry their own space)
    const S = this.style.send;
    this.out.connect(dest.dry);
    this.sends = [];
    for (const k of ['hall', 'room']) if (S[k] > 0) { const g = ctx.createGain(); g.gain.value = S[k]; this.out.connect(g); g.connect(dest[k]); this.sends.push(g); }
    // arp + melody feed the delay
    const dg = ctx.createGain(); dg.gain.value = S.delay; this.bus.arp.connect(dg); this.bus.melody.connect(dg); dg.connect(dest.delay); this.sends.push(dg);
    if (this.isJazz) {
      // rhodes suitcase autopan
      this.bus.comp = ctx.createGain();
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner(); const l = ctx.createOscillator(); l.frequency.value = 3.2; const lg = ctx.createGain(); lg.gain.value = 0.35;
        l.connect(lg); lg.connect(p.pan); l.start(); this._lfo = l;
        this.bus.comp.connect(p); p.connect(this.out);
      } else this.bus.comp.connect(this.out);
    }
    this.bar = 0; this.nextBar = null; this.stopped = false;
    this.prevPad = null; this.prevPad2 = null; this.prevComp = null; this.prevArpIdx = 0; this.bassPrev = null;
    this.motif = T.makeMotif(this.rng, 8, 0.2);
    this.lastProg = -1;
  }

  start(t, fade = 4) {
    this.nextBar = t + 0.05;
    const g = this.out.gain; g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(1, t + fade);
  }
  stop(t, fade = 3) {
    this.stopped = true;
    const g = this.out.gain; g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + fade);
    this.deadAt = t + fade + 8;
  }
  dispose() {
    try { this._lfo?.stop(); } catch { /* already stopped */ }
    try { this.out.disconnect(); for (const s of this.sends) s.disconnect(); } catch { /* ignore */ }
  }
  setNight(n) { this.night = clamp(n, 0, 1); }

  /** Compose & schedule every bar that starts before `until`. */
  pump(now, until) {
    if (this.stopped || this.nextBar == null) return;
    if (this.nextBar < now - 0.05) this.nextBar = now + 0.05; // timers stalled (hidden tab)
    let guard = 0;
    while (this.nextBar < until && guard++ < 64) {
      if (this.isJazz) this._jazzBar(this.bar, this.nextBar); else this._bar(this.bar, this.nextBar);
      this.bar++; this.nextBar += this.barDur;
    }
  }

  // ---------------------------------------------------------------------------------------------
  _play(layer, t, midi, dur, vel, extra) {
    let L = this.style[layer]; if (!L) return;
    if (layer === 'melody' && this.night > 0.6 && this.style.nightMelody) L = this.style.nightMelody;
    const [inst, g, o] = L;
    const opts = { ...o, ...extra };
    opts.bright = (opts.bright ?? 1) * this.style.bright * (1 - 0.35 * this.night);
    if (this.lite) opts.lite = true;
    let out = this.bus[layer === 'pad2' ? 'pad' : layer];
    if (layer === 'arp' && opts.pan) { out = this.arpLR[opts.pan < 0 ? 0 : 1]; opts.pan = 0; }
    this._n(inst, out, t, midi, dur, vel * g, opts);
  }
  /** Every note goes through here (onNote = optional debug/analysis hook). */
  _n(inst, out, t, midi, dur, vel, opts) {
    this.onNote?.(t, inst, midi, dur, vel);
    I[inst](this.ctx, this.A, out, t, midi, dur, vel, opts);
  }

  _section(barIdx) {
    const r = this.rng, st = this.style;
    const progs = T.progressionsOf(this.scaleName);
    let pi = this.lastProg;
    if (pi < 0) pi = 0; // open on the most characteristic progression
    else if (!r.chance(0.35)) { pi = r.int(0, progs.length - 1); if (pi === this.lastProg) pi = (pi + 1) % progs.length; }
    this.lastProg = pi;
    this.prog = progs[pi].map((d) => T.chordOn(this.scaleName, d, 4));
    const sec = Math.floor(barIdx / (4 * st.chordBars));
    this.sectionIdx = sec;
    // intensity arc: slow wave + jitter; night calmer; the opening section is gentle
    const arc = 0.55 + 0.3 * Math.sin(sec * 1.1 + 0.4) + r.range(-0.12, 0.12);
    this.intensity = sec === 0 ? 0.42 : clamp(arc * (1 - 0.3 * this.night), 0.15, 1);
    // motif development: keep, vary, or renew
    if (sec > 0) {
      const m = r.weighted(['keep', 'invert', 'retro', 'orn', 'new'], [3, 1.2, 1, 1.2, 1.5]);
      if (m === 'new') this.motif = T.makeMotif(r, 8, 0.25);
      else if (m === 'invert') this.motif = T.transform.invert(this.motif);
      else if (m === 'retro') this.motif = T.transform.retrograde(this.motif);
      else if (m === 'orn') this.motif = T.transform.ornament(this.motif, r);
    }
    const units = 2 * st.chordBars; // 2-bar melodic units per section
    const dens = (st.melody?.[2].density ?? 0.5) * (0.6 + 0.8 * this.intensity) * (1 - 0.4 * this.night);
    const A = 'A', A1 = 'A1', B = 'B', A2 = 'A2', _ = null;
    let plan;
    if (units <= 2) plan = [A, A2];
    else if (units === 4) plan = dens > 0.55 ? [A, A1, B, A2] : dens > 0.3 ? [A, _, A1, _] : [_, A, _, _];
    else plan = dens > 0.55 ? [A, _, A1, _, B, _, A2, _] : dens > 0.3 ? [_, A, _, _, _, A1, _, _] : [_, _, A, _, _, _, _, _];
    if (sec === 0) plan = plan.map((x, i) => (i < plan.length / 2 ? null : x)); // let the bed breathe first
    this.plan = plan;
    // macro-dynamics: the harmony bed swells with the section's intensity (Zimmer / Vangelis
    // crescendos), arriving over two bars and easing back before the next section
    const t0 = this.nextBar, secDur = 4 * st.chordBars * this.barDur;
    if (t0 != null) {
      const g = this.bus.pad.gain, peak = 0.7 + 0.55 * this.intensity;
      g.cancelScheduledValues(t0); g.setValueAtTime(this._padEnd ?? 0.85, t0);
      g.linearRampToValueAtTime(peak, t0 + Math.min(secDur * 0.55, 2 * this.barDur + secDur * 0.3));
      this._padEnd = 0.8 + 0.2 * this.intensity;
      g.linearRampToValueAtTime(this._padEnd, t0 + secDur * 0.95);
    }
    this.layers = {
      bass: this.intensity > 0.25,
      arp: !!st.arp && this.intensity > (sec === 0 ? 0.3 : 0.38),
      perc: !!st.perc && this.intensity > 0.5 && this.night < 0.7,
      pad2: !!st.pad2,
    };
  }

  _chordAt(barInSec) { return this.prog[Math.min(3, Math.floor(barInSec / this.style.chordBars))]; }

  _bar(bar, t) {
    const st = this.style, r = this.rng, bd = this.barDur, beat = bd / this.meter;
    const secBars = 4 * st.chordBars, bis = bar % secBars;
    if (bis === 0) this._section(bar);
    const ch = this._chordAt(bis);
    const absPcs = ch.pcs.map((p) => (p + this.key) % 12);
    const ess = ch.essential.map((p) => (p + this.key) % 12);
    const nightShift = this.night > 0.6 ? -12 : 0;
    // ---- harmony bed on chord changes
    if (bis % st.chordBars === 0) {
      const dur = st.chordBars * bd + 0.25;
      const [, , po] = st.pad;
      const v = T.voiceLead(this.prevPad, absPcs, Math.min(po.n || 4, this.lite ? 3 : 5), po.lo, po.hi, ess);
      this.prevPad = v;
      v.forEach((m, i) => this._play('pad', t + i * 0.02, m, dur, 0.75 + 0.25 * this.intensity, { pan: (i / Math.max(1, v.length - 1) - 0.5) * 0.9 }));
      if (this.layers.pad2) {
        const [, , o2] = st.pad2;
        const v2 = T.voiceLead(this.prevPad2, absPcs, o2.n || 3, o2.lo, o2.hi, ess);
        this.prevPad2 = v2;
        v2.forEach((m, i) => this._play('pad2', t + 0.05, m, dur, 0.6, { pan: (i - 1) * 0.3 }));
      }
      // bass / drone: chord root, low
      if (st.drone && (this.layers.bass || bis === 0)) {
        const oct = st.drone[2].oct ?? -1;
        if (st.drone[0] === 'drone' || st.drone[0] === 'organ') {
          // tonic pedal (the lydian #11 / phrygian b2 colours ring against it); re-struck each section
          if (bis === 0) { let p = this.key + 12 * oct; while (p < 33) p += 12; while (p > 45) p -= 12; this._play('drone', t, p, secBars * bd + 0.5, 0.8); }
        } else {
          // bass: chord root, voice-led to the nearest octave within E1..E3
          let root = this.key + ch.root + 12 * oct;
          const ref = this.bassPrev ?? (this.key - 12);
          while (root - ref > 6) root -= 12; while (ref - root > 6) root += 12;
          while (root < 33) root += 12; while (root > 52) root -= 12;
          this.bassPrev = root;
          this._play('drone', t, root, dur, 0.8);
        }
      }
    }
    // ---- arpeggio
    if (this.layers.arp) this._arp(bar, bis, t, ch, beat);
    // ---- melody (2-bar units)
    if (st.melody && bis % 2 === 0) {
      const u = this.plan[Math.floor(bis / 2)];
      if (u) this._melodyUnit(u, bis, t, beat, nightShift);
    }
    // ---- percussion
    if (this.layers.perc) this._perc(bar, bis, t, beat);
    // section downbeat accent (cosmic swell / frame drum boom)
    if (bis === 0 && this.sectionIdx > 0 && (st.perc === 'frame' || st.perc === 'tick') && r.chance(0.5)) hit(this.ctx, this.A, this.bus.perc, t, 'taiko', 0.6, { gain: 0.5, lp: 600 });
  }

  _arp(bar, bis, t, ch, beat) {
    const [, , o] = this.style.arp, r = this.rng;
    const sub = o.sub || 2, steps = this.meter * sub, dt = beat / sub;
    // chord tones over the arp range, ascending
    const pool = [];
    for (let m = o.lo; m <= o.hi; m++) if (ch.pcs.includes(((m - this.key) % 12 + 12) % 12)) pool.push(m);
    if (!pool.length) return;
    const pat = o.pattern;
    for (let s = 0; s < steps; s++) {
      let idx, vel = s % sub === 0 ? 0.8 : 0.55, play = true, extra = { pan: (s % 2 ? 0.3 : -0.3) };
      if (pat === 'up') idx = (s + bar) % Math.min(pool.length, 8);
      else if (pat === 'updown') { const n = Math.min(pool.length, 6), p = (s + bar * 2) % (2 * n - 2); idx = p < n ? p : 2 * n - 2 - p; }
      else if (pat === 'broken') {
        // Hisaishi left hand: root – 5th – octave – 10th … from the chord root in the low register
        const base = pool.findIndex((m) => ((m - this.key) % 12 + 12) % 12 === ch.root);
        idx = Math.max(0, base) + [0, 2, 3, 4, 5, 4, 3, 2][s % 8];
        vel = s === 0 ? 0.9 : 0.5 + 0.1 * Math.sin(s);
      } else if (pat === 'ostinato') {
        // Interstellar: alternate a held high pedal with a slowly moving inner voice
        const top = pool[pool.length - 1 - ((bar >> 1) % 2)];
        if (s % 2) { extra.midi = top; vel = 0.5; }
        else idx = Math.floor(pool.length * 0.35) + ((s >> 1) % 3);
      } else if (pat === 'sparkle') {
        play = r.chance(0.18 + 0.2 * this.intensity); idx = r.int(0, pool.length - 1); vel = r.range(0.35, 0.8);
      } else if (pat === 'guzheng') {
        // glissando run up the scale on beat 3 of every other bar, otherwise sparse plucks with bend-in
        if (bar % 2 === 1 && s >= 8 && s < 15) {
          const deg = T.nearestDeg(this.scale, o.lo + 7 - this.key) + (s - 8);
          extra.midi = this.key + T.degSemi(this.scale, deg); vel = 0.35 + (s - 8) * 0.07;
        } else { play = s % 4 === 0 ? r.chance(0.7) : r.chance(0.12); idx = r.int(0, pool.length - 1); if (r.chance(0.3)) extra.bend = 1; }
      } else idx = s % pool.length;
      if (!play || (this.lite && sub > 2 && s % 2)) continue;
      const midi = extra.midi ?? pool[clamp(idx, 0, pool.length - 1)];
      delete extra.midi;
      const swingLate = 0; // straight
      const tt = t + s * dt + swingLate + r.range(0, 0.008);
      this._play('arp', tt, midi, dt * (pat === 'broken' ? 3 : 0.9), vel * (0.7 + 0.3 * this.intensity), extra);
    }
  }

  _melodyUnit(u, bis, t, beat, shift) {
    const [, , o] = this.style.melody, r = this.rng;
    let m = this.motif;
    if (u === 'A1') m = T.transform.sequence(m, r.pick([1, 2, -1, 3]));
    else if (u === 'B') m = r.chance(0.5) ? T.transform.fragment(m) : T.transform.invert(m);
    if (o.ornament && r.chance(0.5)) m = T.transform.ornament(m, r);
    const ch0 = this._chordAt(bis);
    // anchor on a chord tone of the current chord near the middle of the range
    const mid = (o.lo + o.hi) / 2 + shift;
    let anchor = T.nearestDeg(this.scale, mid - this.key - 2);
    for (let k = 0; k < 4; k++) { const s = ((T.degSemi(this.scale, anchor) % 12) + 12) % 12; if (ch0.pcs.includes(s)) break; anchor++; }
    const beatsPerBar = this.meter;
    let prevMidi = null, prevS = null;
    for (const n of m) {
      if (n.t >= 8) continue;
      const ch = this._chordAt(bis + Math.floor(n.t / beatsPerBar));
      const real = T.realize([n], { scale: this.scale, keyRoot: this.key, anchorDeg: anchor, chordPcs: ch.pcs, lo: o.lo + shift, hi: o.hi + shift, beatsPerBar })[0];
      let midi = real.midi;
      // cadence of A2 resolves to the tonic chord tone
      if (u === 'A2' && n === m[m.length - 1]) { midi = this.key + ch.root; while (midi < o.lo + shift) midi += 12; while (midi > o.hi + shift) midi -= 12; }
      else if (prevMidi != null && midi === prevMidi && n.s !== prevS) {
        // snapping cancelled the motif's step: move diatonically in the motif's direction
        const dir = Math.sign(n.s - prevS), d = T.nearestDeg(this.scale, midi - this.key) + dir;
        const alt = this.key + T.degSemi(this.scale, d);
        if (alt >= o.lo + shift - 2 && alt <= o.hi + shift + 2) midi = alt;
      }
      // phrase dynamics: rising lines swell, the cadence relaxes, downbeats lean
      const rise = prevMidi != null ? clamp((midi - prevMidi) / 7, -1, 1) : 0;
      const arch = Math.sin(Math.PI * clamp(n.t / 8, 0, 1)) * 0.15;
      const vel = clamp((n.t % 4 === 0 ? 0.8 : 0.68) + 0.08 * rise + arch, 0.4, 1) * (0.85 + 0.15 * this.intensity) * (1 - 0.2 * this.night);
      const tt = t + n.t * beat + r.range(0, 0.015);
      this._play('melody', tt, midi, Math.max(0.12, n.d * beat * 0.95), vel, { pan: r.range(-0.15, 0.15) });
      prevMidi = midi; prevS = n.s;
    }
  }

  _perc(bar, bis, t, beat) {
    const p = this.style.perc, r = this.rng, A = this.A, ctx = this.ctx, out = this.bus.perc;
    if (p === 'tick') {
      for (let b = 0; b < this.meter; b++) hit(ctx, A, out, t + b * beat, 'tick', b === 0 ? 0.55 : 0.35, { gain: 0.25, pan: 0.1 });
    } else if (p === 'frame') {
      hit(ctx, A, out, t, 'frame', 0.8, { gain: 0.45, lp: 1500 });
      if (r.chance(0.6)) hit(ctx, A, out, t + 2.5 * beat, 'frame', 0.45, { gain: 0.45, lp: 1200, rate: 1.06 });
      if (r.chance(0.5)) hit(ctx, A, out, t + 3 * beat, 'frame', 0.3, { gain: 0.45, lp: 1600, rate: 1.12, pan: 0.2 });
    } else if (p === 'pulse') {
      hit(ctx, A, out, t, 'kick', 0.7, { gain: 0.5 });
      hit(ctx, A, out, t + 2 * beat, 'kick', 0.55, { gain: 0.5 });
      for (let s = 0; s < 8; s++) hit(ctx, A, out, t + s * beat / 2, 'shaker', s % 2 ? 0.35 : 0.2, { gain: 0.18, pan: 0.35 });
      if (r.chance(0.5)) hit(ctx, A, out, t + 3.5 * beat, 'rim', 0.4, { gain: 0.2, pan: -0.25 });
    }
  }

  // ---- jazz combo ------------------------------------------------------------------------------
  _jazzBar(bar, t) {
    const r = this.rng, ctx = this.ctx, A = this.A, beat = this.barDur / 4;
    const form = T.JAZZ_FORM, sec = Math.floor(bar / 8) % form.length, bis = bar % 8;
    const row = form[sec][bis], nextRow = bis < 7 ? form[sec][bis + 1] : form[(sec + 1) % form.length][0];
    const ch = T.jazzChord(row[0], row[1]), nx = T.jazzChord(nextRow[0], nextRow[1]);
    const key = this.key, sw = (k) => k * beat + (k % 1 ? beat * 0.17 : 0); // swung 8ths (≈ 2:1)
    if (bis === 0) {
      const chorus = Math.floor(bar / 32);
      this.intensity = chorus === 0 && sec === 0 ? 0.45 : clamp(0.6 + 0.25 * Math.sin(bar * 0.13) - 0.25 * this.night, 0.3, 1);
      if (sec === 0 || sec === 2 || r.chance(0.3)) this.motif = r.chance(0.6) ? T.makeMotif(r, 8, 0.35) : T.transform.ornament(this.motif, r);
    }
    // walking bass (or two-feel on the first A)
    const two = bar < 8;
    let root = this.bassTarget;
    if (root == null || (((root - key - row[0]) % 12) + 12) % 12 !== 0) { root = key - 24 + row[0]; while (root < 33) root += 12; while (root > 45) root -= 12; }
    // next root: nearest octave, steered back toward the middle of the bass range (A1..D3)
    const target = (() => { let n = key - 24 + nextRow[0]; while (n - root > 6) n -= 12; while (root - n > 6) n += 12; if (n < 33) n += 12; if (n > 50) n -= 12; return n; })();
    this.bassTarget = target;
    const tones = ch.tones.map((x) => ((x % 12) + 12) % 12);
    const walk = [root];
    if (two) walk.push(null, root + (tones.includes((row[0] + 7) % 12) ? 7 : 6), null);
    else {
      const dir = Math.sign(target - root) || 1;
      const third = root + (tones.includes((row[0] + 3) % 12) ? 3 : 4);
      const fifth = root + (tones.includes((row[0] + 6) % 12) && !tones.includes((row[0] + 7) % 12) ? 6 : 7);
      walk.push(dir > 0 ? third : root - (r.chance(0.5) ? 2 : 5));
      walk.push(dir > 0 ? fifth : walk[1] - 2);
      // beat 4: chromatic approach from the side we travel from, else the target's fifth
      const tdir = Math.sign(target - walk[2]) || dir;
      walk.push(r.chance(0.7) ? target - tdir : (Math.abs(target + 7 - walk[2]) < Math.abs(target - 5 - walk[2]) ? target + 7 : target - 5));
    }
    walk.forEach((m, i) => { if (m != null) this._n('upright', this.bus.bass, t + i * beat + r.range(-0.004, 0.006), clamp(m, 28, 52), (two && i % 2 === 0 ? 2 : 1) * beat * 0.92, i === 0 ? 0.95 : 0.8); });
    this.bassPrev = root;
    // drums: ride "ding, ding-da ding, ding-da", brushes on 2 & 4, feathered kick
    const dr = this.bus.perc;
    const ridePat = [0, 1, 1.5, 2, 3, 3.5];
    for (const k of ridePat) hit(ctx, A, dr, t + sw(k) + r.range(-0.005, 0.005), 'ride', (k % 1 ? 0.45 : k % 2 ? 0.75 : 0.6) * (0.7 + 0.3 * this.intensity), { gain: 0.16, pan: 0.35 });
    for (let b = 0; b < 4; b++) {
      hit(ctx, A, dr, t + b * beat, 'brushSweep', 0.35, { gain: 0.22, pan: -0.2, rate: 0.9 + r.range(0, 0.1) });
      if (b % 2 === 1) hit(ctx, A, dr, t + b * beat, 'brushTap', 0.7, { gain: 0.24, pan: -0.15 });
      hit(ctx, A, dr, t + b * beat, 'kick', 0.18, { gain: 0.3, lp: 400 });
    }
    if (r.chance(0.18)) hit(ctx, A, dr, t + sw(r.pick([1.5, 2.5, 3.5])), 'brushTap', 0.4, { gain: 0.24, pan: -0.3 }); // comping snare ghost
    // rhodes comping: rootless voicings, voice-led, Charleston / anticipation rhythms
    const absR = ch.rootless.map((p) => (p + key) % 12);
    const v = T.voiceLead(this.prevComp, absR, 4, 52, 72, absR);
    this.prevComp = v;
    const rhythm = r.weighted([[[0, 1.4], [1.5, 0.5]], [[0, 2.5]], [[0.5, 1], [2.5, 1.2]], [[1.5, 2]], [[0, 0.8], [2, 0.5], [3.5, 0.8]]], [3, 2, 2, 1.5, 1.2]);
    for (const [k, d] of rhythm) v.forEach((m, i) => this._n('rhodes', this.bus.comp, t + sw(k) + i * 0.006, m, d * beat, (k === 0 ? 0.55 : 0.48) * (0.85 + 0.25 * this.intensity)));
    // vibraphone line in the A sections (call), rests in B (response from rhodes fills)
    const phraseBar = bis % 4;
    if ((sec !== 2 || r.chance(0.35)) && this.intensity > 0.4 && phraseBar < 2 && bis % 4 === 0) {
      const m = sec === 1 ? T.transform.sequence(this.motif, 2) : sec === 3 ? T.transform.invert(this.motif) : this.motif;
      for (const n of m) {
        if (n.t >= 7) continue;
        const cb = Math.floor(n.t / 4), cr = cb === 0 ? row : nextRow;
        const cc = cb === 0 ? ch : nx;
        const pcs = cc.pcs.map((p) => (p - 0 + 12) % 12);
        const sc = [...new Set([...this.scale, ...pcs])].sort((a, b) => a - b);
        const real = T.realize([n], { scale: sc, keyRoot: key, anchorDeg: 9, chordPcs: pcs, lo: 67, hi: 86, beatsPerBar: 4 })[0];
        const tt = t + sw(Math.round(n.t * 2) / 2) + r.range(0, 0.01);
        this._n('glass', this.bus.melody, tt, real.midi, n.d * beat, 0.55 * (n.t % 2 === 0 ? 1 : 0.85), { ratio: 4, decay: 2.2, bright: 0.45, pan: 0.15 });
        void cr;
      }
    }
  }
}
