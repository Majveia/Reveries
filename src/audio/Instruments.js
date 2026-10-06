// Synthesized instruments. Each is play(ctx, A, out, t, midi, dur, vel, o):
// schedules one note at ctx time t on destination `out`, cleans up after
// itself. A = shared assets { waves, samples, noise }. o: { pan, bright, ... }.
// Levels: a single note at vel 1 peaks around 0.25 so chords and layers sum
// with headroom (mix gains are trimmed per layer in Music.js).
import { mtof } from './Theory.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function env(g, t, a, d, s, r, dur, peak) {
  a = Math.min(a, Math.max(0.004, dur * 0.9));
  const p = g.gain;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  if (d > 0 && s < 1) p.setTargetAtTime(peak * s, t + a, d / 3);
  p.setTargetAtTime(0, t + dur, Math.max(0.01, r / 4));
  return t + dur + r * 1.6 + 0.05; // stop time
}
// Control-rate params: filter sweeps and vibrato at 128-sample steps are inaudible
// but avoid per-sample coefficient / pow() work — the big CPU win for many voices.
function kr(...ps) { for (const p of ps) { try { p.automationRate = 'k-rate'; } catch { /* old browsers */ } } }
function ar(p) { try { p.automationRate = 'a-rate'; } catch { /* ignore */ } }
function bq(ctx) { const b = ctx.createBiquadFilter(); kr(b.frequency, b.Q, b.detune, b.gain); return b; }
function panNode(ctx, out, pan) {
  if (!pan || !ctx.createStereoPanner) return out;
  const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); p.connect(out); return p;
}
function osc(ctx, type, f, t, stop, detune = 0, wave) {
  const o = ctx.createOscillator();
  if (wave) o.setPeriodicWave(wave); else o.type = type;
  kr(o.frequency, o.detune);
  o.frequency.setValueAtTime(f, t); if (detune) o.detune.setValueAtTime(detune, t);
  o.start(t); o.stop(stop);
  return o;
}
function vibrato(ctx, targets, t, stop, rate = 5, cents = 8, delay = 0.6) {
  const l = ctx.createOscillator(); l.frequency.value = rate * (0.94 + Math.random() * 0.12);
  const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(cents, t + delay + 0.5);
  l.connect(g); for (const o of targets) g.connect(o.detune);
  l.start(t); l.stop(stop);
}

// Warm analog ensemble pad (Vangelis CS-80 / string machine): 3 detuned saws,
// low-passed with a slow filter swell, delayed vibrato.
export function pad(ctx, A, out, t, midi, dur, vel, o = {}) {
  const f = mtof(midi), bright = o.bright ?? 1;
  const atk = o.attack ?? 1.6, rel = o.release ?? 3;
  const g = ctx.createGain();
  const stop = env(g, t, atk, 2, 0.8, rel, dur, 0.07 * vel);
  const lp = bq(ctx); lp.type = 'lowpass'; lp.Q.value = 0.6;
  const fc = clamp(f * 3 + 900 * bright * vel, 200, 9000);
  // finite ramps only: an automation that never settles forces per-sample biquad coefficients
  lp.frequency.setValueAtTime(fc * 0.35, t); lp.frequency.linearRampToValueAtTime(fc, t + atk * 1.2);
  lp.frequency.linearRampToValueAtTime(fc * 0.7, t + atk * 1.2 + Math.max(0.5, dur * 0.6));
  const os = [osc(ctx, 'sawtooth', f, t, stop, -9), osc(ctx, 'sawtooth', f, t, stop, 8)];
  if (!o.lite) os.push(osc(ctx, o.sub ? 'triangle' : 'sawtooth', o.sub ? f / 2 : f, t, stop, 2));
  for (const x of os) x.connect(lp);
  if (!o.lite) vibrato(ctx, [os[0]], t, stop, 4.6, 7, atk);
  lp.connect(g); g.connect(panNode(ctx, out, o.pan));
}

// Bowed string section: like pad but brighter, slower attack, stronger vibrato, slight bow noise.
export function strings(ctx, A, out, t, midi, dur, vel, o = {}) {
  pad(ctx, A, out, t, midi, dur, vel * 0.95, { ...o, attack: o.attack ?? 1.1, bright: (o.bright ?? 1) * 1.3, release: o.release ?? 2.2 });
}

// Pipe organ: flue ranks wavetable, 16' sub at low velocity, chiff transient, slow wind tremulant.
export function organ(ctx, A, out, t, midi, dur, vel, o = {}) {
  const f = mtof(midi);
  const g = ctx.createGain();
  const stop = env(g, t, o.attack ?? 0.12, 0.4, 0.9, o.release ?? 0.9, dur, 0.085 * vel);
  const lp = bq(ctx); lp.type = 'lowpass'; lp.frequency.value = clamp(f * 8 * (o.bright ?? 1), 400, 10000); lp.Q.value = 0.5;
  const a = osc(ctx, null, f, t, stop, -2, A.waves.organ), b = osc(ctx, null, f, t, stop, 3, A.waves.organ);
  a.connect(lp); b.connect(lp);
  if (o.sub !== false && midi > 40) { const s = osc(ctx, 'sine', f / 2, t, stop); const sg = ctx.createGain(); sg.gain.value = 0.45; s.connect(sg); sg.connect(lp); }
  // chiff: brief band-passed breath at the 2nd harmonic
  const n = ctx.createBufferSource(); n.buffer = A.noise.white;
  const nb = bq(ctx); nb.type = 'bandpass'; nb.frequency.value = Math.min(9000, f * 2); nb.Q.value = 6;
  const ng = ctx.createGain(); ng.gain.setValueAtTime(0, t); ng.gain.linearRampToValueAtTime(0.5 * vel, t + 0.02); ng.gain.setTargetAtTime(0, t + 0.03, 0.04);
  n.connect(nb); nb.connect(ng); ng.connect(g); n.start(t, Math.random() * 4); n.stop(t + 0.4);
  lp.connect(g); g.connect(panNode(ctx, out, o.pan));
}

// Choir "aah": detuned saws through three vowel formants, slow attack, chorus vibrato.
const VOWELS = { a: [[730, 1], [1090, 0.5], [2440, 0.25]], o: [[570, 1], [840, 0.45], [2410, 0.15]], u: [[300, 1], [870, 0.3], [2240, 0.1]], e: [[530, 1], [1840, 0.4], [2480, 0.25]] };
export function choir(ctx, A, out, t, midi, dur, vel, o = {}) {
  const f = mtof(midi);
  const g = ctx.createGain();
  const stop = env(g, t, o.attack ?? 2.0, 2, 0.85, o.release ?? 3.2, dur, 0.16 * vel);
  const src = ctx.createGain(); src.gain.value = 1;
  const os = [osc(ctx, 'sawtooth', f, t, stop, -11), osc(ctx, 'sawtooth', f, t, stop, 10), osc(ctx, 'sawtooth', f, t, stop, 0)];
  for (const x of os) x.connect(src);
  if (!o.lite) vibrato(ctx, [os[2]], t, stop, 5.2, 12, 1.0);
  for (const [ff, a] of VOWELS[o.vowel || 'a']) {
    const b = bq(ctx); b.type = 'bandpass'; b.frequency.value = ff * (midi < 52 ? 0.9 : 1); b.Q.value = ff / 90;
    const bg = ctx.createGain(); bg.gain.value = a; src.connect(b); b.connect(bg); bg.connect(g);
  }
  g.connect(panNode(ctx, out, o.pan));
}

// FM bell / celesta / glass harmonica.
export function glass(ctx, A, out, t, midi, dur, vel, o = {}) {
  const f = mtof(midi);
  const ratio = o.ratio ?? 3.5, decay = o.decay ?? clamp(5 - (midi - 60) * 0.06, 1.5, 6);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.13 * vel, t + 0.004);
  g.gain.setTargetAtTime(0, t + 0.004, decay / 4);
  const stop = t + decay * 1.4 + 0.1;
  const c = osc(ctx, 'sine', f, t, stop);
  const m = osc(ctx, 'sine', f * ratio, t, stop);
  const mg = ctx.createGain(); mg.gain.setValueAtTime(f * 2.2 * vel * (o.bright ?? 1), t); mg.gain.setTargetAtTime(f * 0.15, t, decay / 8);
  ar(c.frequency); m.connect(mg); mg.connect(c.frequency); // audio-rate FM
  const p2 = osc(ctx, 'sine', f * 2.756, t, stop); const p2g = ctx.createGain(); p2g.gain.setValueAtTime(0.25, t); p2g.gain.setTargetAtTime(0, t, decay / 10);
  p2.connect(p2g); p2g.connect(g);
  c.connect(g); g.connect(panNode(ctx, out, o.pan));
}

// Plucked zither / harp / guzheng: filtered saw with fast filter decay and optional bend-in.
export function pluck(ctx, A, out, t, midi, dur, vel, o = {}) {
  const f = mtof(midi), decay = o.decay ?? clamp(2.6 - (midi - 55) * 0.03, 0.8, 3);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16 * vel, t + 0.003); g.gain.setTargetAtTime(0, t + 0.003, decay / 3.5);
  const stop = t + decay * 1.5;
  const lp = bq(ctx); lp.type = 'lowpass'; lp.Q.value = 1.2;
  lp.frequency.setValueAtTime(clamp(f * 9 * (o.bright ?? 1), 300, 12000), t); lp.frequency.exponentialRampToValueAtTime(Math.max(60, f * 1.6), t + 0.45);
  const a = osc(ctx, 'sawtooth', f, t, stop), b = osc(ctx, 'triangle', f * 2, t, stop, 4);
  if (o.bend) { for (const x of [a, b]) { x.detune.setValueAtTime(-o.bend * 100, t); x.detune.setTargetAtTime(0, t + 0.04, 0.06); } }
  const bg = ctx.createGain(); bg.gain.value = 0.3; b.connect(bg); bg.connect(lp);
  a.connect(lp); lp.connect(g); g.connect(panNode(ctx, out, o.pan));
}

// Soft felt piano (Hisaishi): harmonic wavetable, two-stage decay, darkening filter.
export function piano(ctx, A, out, t, midi, dur, vel, o = {}) {
  const f = mtof(midi);
  const long = clamp(6 - (midi - 48) * 0.08, 1.5, 7);
  const g = ctx.createGain();
  const p = g.gain, pk = 0.15 * vel;
  p.setValueAtTime(0, t); p.linearRampToValueAtTime(pk, t + 0.006);
  p.setTargetAtTime(pk * 0.45, t + 0.006, 0.12);
  p.setTargetAtTime(0, t + 0.3, long / 3.5);
  p.setTargetAtTime(0, t + Math.max(dur, 0.3) + 0.1, 0.25); // damper
  const stop = t + Math.min(long * 1.3, Math.max(dur, 0.3) + 1.6);
  const lp = bq(ctx); lp.type = 'lowpass'; lp.Q.value = 0.4;
  lp.frequency.setValueAtTime(clamp(f * (3 + 5 * vel), 400, 9000), t); lp.frequency.exponentialRampToValueAtTime(clamp(f * 2, 300, 4000), t + 2.5);
  const a = osc(ctx, null, f, t, stop, -1.5, A.waves.piano), b = osc(ctx, null, f, t, stop, 1.5, A.waves.piano);
  a.connect(lp); b.connect(lp); lp.connect(g); g.connect(panNode(ctx, out, o.pan));
}

// Fender Rhodes: FM tine (ratio 1 body + ratio 14 bark), velocity-dependent bark.
export function rhodes(ctx, A, out, t, midi, dur, vel, o = {}) {
  const f = mtof(midi);
  const g = ctx.createGain();
  const p = g.gain, pk = 0.11 * vel;
  p.setValueAtTime(0, t); p.linearRampToValueAtTime(pk, t + 0.003);
  p.setTargetAtTime(pk * 0.5, t + 0.003, 0.4);
  p.setTargetAtTime(0, t + 0.5, clamp(3.5 - (midi - 60) * 0.05, 1, 4) / 3);
  p.setTargetAtTime(0, t + dur, 0.09);
  const stop = t + dur + 0.6;
  const c = osc(ctx, 'sine', f, t, stop);
  const m = osc(ctx, 'sine', f, t, stop); const mg = ctx.createGain();
  mg.gain.setValueAtTime(f * (0.6 + 1.4 * vel), t); mg.gain.setTargetAtTime(f * 0.12, t, 0.35);
  ar(c.frequency); m.connect(mg); mg.connect(c.frequency); // audio-rate FM
  const tn = osc(ctx, 'sine', f * 14, t, t + 0.3); const tg = ctx.createGain();
  tg.gain.setValueAtTime(f * 1.2 * vel * vel, t); tg.gain.setTargetAtTime(0, t, 0.03);
  tn.connect(tg); tg.connect(c.frequency);
  c.connect(g); g.connect(panNode(ctx, out, o.pan));
}

// Upright bass: sine + filtered triangle, pluck thump, slight pitch settle.
export function upright(ctx, A, out, t, midi, dur, vel, o = {}) {
  const f = mtof(midi);
  const g = ctx.createGain(); const p = g.gain, pk = 0.32 * vel;
  p.setValueAtTime(0, t); p.linearRampToValueAtTime(pk, t + 0.008);
  p.setTargetAtTime(pk * 0.55, t + 0.008, 0.08);
  p.setTargetAtTime(pk * 0.2, t + 0.12, 0.6);
  p.setTargetAtTime(0, t + dur * 0.95, 0.05);
  const stop = t + dur + 0.3;
  const lp = bq(ctx); lp.type = 'lowpass'; lp.Q.value = 1.4;
  lp.frequency.setValueAtTime(900 * (0.6 + vel * 0.6), t); lp.frequency.exponentialRampToValueAtTime(380, t + 0.35);
  const a = osc(ctx, 'sine', f, t, stop), b = osc(ctx, 'triangle', f, t, stop, 3);
  for (const x of [a, b]) { x.detune.setValueAtTime(25, t); x.detune.setTargetAtTime(0, t, 0.03); }
  const bg = ctx.createGain(); bg.gain.value = 0.7;
  a.connect(g); b.connect(bg); bg.connect(lp); lp.connect(g);
  g.connect(panNode(ctx, out, o.pan ?? -0.05));
}

// Sub / synth bass: sine with soft saw edge.
export function sub(ctx, A, out, t, midi, dur, vel, o = {}) {
  const f = mtof(midi);
  const g = ctx.createGain();
  const stop = env(g, t, o.attack ?? 0.4, 1, 0.85, o.release ?? 1.5, dur, 0.22 * vel);
  const a = osc(ctx, 'sine', f, t, stop);
  const lp = bq(ctx); lp.type = 'lowpass'; lp.frequency.value = clamp(f * 4 * (o.bright ?? 1), 80, 1200);
  const b = osc(ctx, 'sawtooth', f, t, stop, 5); const bg = ctx.createGain(); bg.gain.value = 0.25;
  b.connect(bg); bg.connect(lp); lp.connect(g); a.connect(g);
  g.connect(panNode(ctx, out, o.pan));
}

// Analog arpeggio synth: saw+square through resonant low-pass with snappy envelope.
export function synth(ctx, A, out, t, midi, dur, vel, o = {}) {
  const f = mtof(midi);
  const g = ctx.createGain(); const p = g.gain, pk = 0.09 * vel;
  p.setValueAtTime(0, t); p.linearRampToValueAtTime(pk, t + 0.004); p.setTargetAtTime(pk * 0.35, t + 0.004, 0.12); p.setTargetAtTime(0, t + dur, 0.07);
  const stop = t + dur + 0.35;
  const lp = bq(ctx); lp.type = 'lowpass'; lp.Q.value = 7;
  const top = clamp(f * 6 * (o.bright ?? 1), 500, 9000);
  lp.frequency.setValueAtTime(top, t); lp.frequency.exponentialRampToValueAtTime(clamp(f * 1.3, 150, 3000), t + 0.3);
  const a = osc(ctx, 'sawtooth', f, t, stop, -5), b = osc(ctx, 'square', f, t, stop, 6);
  const bg = ctx.createGain(); bg.gain.value = 0.5; b.connect(bg); bg.connect(lp); a.connect(lp);
  lp.connect(g); g.connect(panNode(ctx, out, o.pan));
}

// Vangelis brass lead: detuned saws with filter swell, portamento-free, delayed vibrato.
export function lead(ctx, A, out, t, midi, dur, vel, o = {}) {
  const f = mtof(midi);
  const g = ctx.createGain();
  const stop = env(g, t, o.attack ?? 0.25, 0.8, 0.8, o.release ?? 1.4, dur, 0.075 * vel);
  const lp = bq(ctx); lp.type = 'lowpass'; lp.Q.value = 2.5;
  const fc = clamp(f * 5 * (o.bright ?? 1), 400, 7000);
  lp.frequency.setValueAtTime(f * 1.2, t); lp.frequency.linearRampToValueAtTime(fc, t + 0.35); lp.frequency.linearRampToValueAtTime(fc * 0.55, t + 0.35 + Math.max(0.3, dur));
  const os = [osc(ctx, 'sawtooth', f, t, stop, -7), osc(ctx, 'sawtooth', f, t, stop, 7)];
  for (const x of os) x.connect(lp);
  vibrato(ctx, [os[0], os[1]], t, stop, 5.4, 14, 0.5);
  lp.connect(g); g.connect(panNode(ctx, out, o.pan));
}

// Bamboo flute (dizi / ney / shakuhachi): near-sine with breath noise, expressive vibrato and scoop.
export function flute(ctx, A, out, t, midi, dur, vel, o = {}) {
  const f = mtof(midi);
  const g = ctx.createGain();
  const stop = env(g, t, o.attack ?? 0.09, 0.4, 0.8, o.release ?? 0.35, dur, 0.13 * vel);
  const a = osc(ctx, null, f, t, stop, 0, A.waves.flute);
  a.detune.setValueAtTime(-35, t); a.detune.linearRampToValueAtTime(0, t + 0.09); // scoop
  vibrato(ctx, [a], t, stop, 5.3, 16, Math.min(0.5, dur * 0.4));
  a.connect(g);
  const n = ctx.createBufferSource(); n.buffer = A.noise.white; n.loop = true;
  const nb = bq(ctx); nb.type = 'bandpass'; nb.frequency.value = Math.min(10000, f * 2); nb.Q.value = 3;
  const ng = ctx.createGain(); ng.gain.setValueAtTime(0.0, t); ng.gain.linearRampToValueAtTime(0.5 * (o.breath ?? 1), t + 0.05); ng.gain.setTargetAtTime(0.18 * (o.breath ?? 1), t + 0.06, 0.1);
  n.connect(nb); nb.connect(ng); ng.connect(g); n.start(t, Math.random() * 4); n.stop(stop);
  g.connect(panNode(ctx, out, o.pan));
}

// Deep drone: three octave-spread sines/triangles with slow beating and filter breathing.
export function drone(ctx, A, out, t, midi, dur, vel, o = {}) {
  const f = mtof(midi);
  const g = ctx.createGain();
  const stop = env(g, t, o.attack ?? 4, 3, 0.9, o.release ?? 5, dur, 0.2 * vel);
  const lp = bq(ctx); lp.type = 'lowpass'; lp.frequency.value = clamp(f * 5 * (o.bright ?? 1), 120, 2000); lp.Q.value = 1.5;
  const l = ctx.createOscillator(); l.frequency.value = 0.05 + Math.random() * 0.05; const lg = ctx.createGain(); lg.gain.value = f * 2;
  l.connect(lg); lg.connect(lp.frequency); l.start(t); l.stop(stop);
  const a = osc(ctx, 'sine', f, t, stop), b = osc(ctx, 'triangle', f * 2, t, stop, 3), c = osc(ctx, 'sawtooth', f, t, stop, -4), d = osc(ctx, 'sine', f * 1.5, t, stop, 1);
  const cg = ctx.createGain(); cg.gain.value = 0.35; c.connect(cg); cg.connect(lp);
  const dg = ctx.createGain(); dg.gain.value = 0.18; d.connect(dg); dg.connect(lp);
  a.connect(g); b.connect(lp); lp.connect(g);
  g.connect(panNode(ctx, out, o.pan));
}

/** Play a pre-rendered sample with gain, rate, pan. */
export function hit(ctx, A, out, t, name, vel = 1, o = {}) {
  const s = A.samples[name]; if (!s) return;
  const src = ctx.createBufferSource(); src.buffer = s; src.playbackRate.value = o.rate ?? 1;
  const g = ctx.createGain(); g.gain.value = vel * (o.gain ?? 0.3);
  let node = g;
  if (o.lp) { const f = bq(ctx); f.type = 'lowpass'; f.frequency.value = o.lp; g.connect(f); node = f; }
  src.connect(g); node.connect(panNode(ctx, out, o.pan));
  src.start(t); src.stop(t + s.duration / (o.rate ?? 1) + 0.05);
}

export const INSTRUMENTS = { pad, strings, organ, choir, glass, pluck, piano, rhodes, upright, sub, synth, lead, flute, drone };
