// DSP building blocks: noise buffers, generated convolution IRs, pre-rendered
// percussion / texture loops, organ & e-piano wavetables, soft-clip curve.
// Everything is generated in JS at init on whatever BaseAudioContext is given
// (realtime or offline), so it is testable headless.
import { rng32 } from './Theory.js';

function buf(ctx, seconds, ch = 2) {
  return ctx.createBuffer(ch, Math.max(1, Math.floor(seconds * ctx.sampleRate)), ctx.sampleRate);
}

export function noiseBuffers(ctx, seconds = 6) {
  const r = rng32(1234567);
  const white = buf(ctx, seconds), pink = buf(ctx, seconds), brown = buf(ctx, seconds);
  for (let c = 0; c < 2; c++) {
    const w = white.getChannelData(c), p = pink.getChannelData(c), b = brown.getChannelData(c);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0;
    for (let i = 0; i < w.length; i++) {
      const x = r() * 2 - 1;
      w[i] = x * 0.5;
      // Paul Kellet's refined pink filter
      b0 = 0.99886 * b0 + x * 0.0555179; b1 = 0.99332 * b1 + x * 0.0750759; b2 = 0.969 * b2 + x * 0.153852;
      b3 = 0.8665 * b3 + x * 0.3104856; b4 = 0.55 * b4 + x * 0.5329522; b5 = -0.7616 * b5 - x * 0.016898;
      p[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.09;
      b6 = x * 0.115926;
      br = (br + 0.02 * x) / 1.02;
      b[i] = br * 3.2;
    }
    // crossfade the loop seam
    const n = Math.floor(ctx.sampleRate * 0.05);
    for (const d of [w, p, b]) for (let i = 0; i < n; i++) { const k = i / n; d[i] = d[i] * k + d[d.length - n + i] * (1 - k); }
  }
  return { white, pink, brown };
}

/**
 * Stereo reverb impulse response: early reflections + exponentially decaying,
 * progressively darker diffuse tail (frequency-dependent decay like a real hall).
 */
export function reverbIR(ctx, { seconds = 5, decay = 2.6, predelay = 0.025, dark = 0.6, seed = 7, early = 10 } = {}) {
  const r = rng32(seed);
  const b = buf(ctx, seconds + predelay);
  const sr = ctx.sampleRate;
  const pd = Math.floor(predelay * sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < d.length - pd; i++) {
      const t = i / sr;
      const x = r() * 2 - 1;
      // lowpass coefficient slides from bright to dark over the tail
      const a = 0.85 - dark * 0.75 * Math.min(1, t / seconds) ** 0.6;
      lp = lp + a * (x - lp);
      const env = Math.pow(1 - t / seconds, decay) * Math.exp(-t * 1.2);
      const fadeIn = Math.min(1, t / 0.012);
      d[i + pd] = lp * env * fadeIn;
    }
    for (let k = 0; k < early; k++) {
      const t = 0.004 + r() * 0.07;
      const idx = pd + Math.floor(t * sr);
      if (idx < d.length) d[idx] += (r() * 2 - 1) * 0.6 * (1 - t / 0.08);
    }
  }
  // normalize energy so different IRs sit at similar loudness
  let e = 0;
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) e += d[i] * d[i]; }
  const g = 1 / Math.sqrt(e / 2 + 1e-9) * 0.9;
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= g; }
  return b;
}

// one-pole helpers for offline synthesis of samples
function hp1(d, f, sr) { const a = 1 / (1 + 2 * Math.PI * f / sr); let y = 0, xp = 0; for (let i = 0; i < d.length; i++) { const x = d[i]; y = a * (y + x - xp); xp = x; d[i] = y; } }
function lp1(d, f, sr) { const a = 1 - Math.exp(-2 * Math.PI * f / sr); let y = 0; for (let i = 0; i < d.length; i++) { y += a * (d[i] - y); d[i] = y; } }
function bp(d, f, q, sr) { // RBJ biquad bandpass (constant 0 dB peak)
  const w = 2 * Math.PI * f / sr, al = Math.sin(w) / (2 * q), cw = Math.cos(w);
  const a0 = 1 + al, b0 = al / a0, b2 = -al / a0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < d.length; i++) { const x = d[i]; const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; d[i] = y; }
}
function peakNorm(d, p = 0.9) { let m = 0; for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i])); if (m > 0) for (let i = 0; i < d.length; i++) d[i] *= p / m; }

/** Pre-rendered one-shots & loops (mono unless noted). */
export function samples(ctx) {
  const sr = ctx.sampleRate;
  const r = rng32(424242);
  const mono = (sec, fn, post) => { const b = buf(ctx, sec, 1); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = fn(i / sr, i); post?.(d); peakNorm(d); return b; };
  const S = {};
  // jazz ride: inharmonic square partials (808-style metal) + noise, highpassed
  const rideF = [263, 400, 421, 474, 587, 845].map((f) => f * 1.9);
  S.ride = mono(1.6, (t) => {
    let s = 0; for (const f of rideF) s += Math.sign(Math.sin(2 * Math.PI * f * t + f));
    return (s * 0.12 + (r() * 2 - 1) * 0.5) * (Math.exp(-t * 3.2) * 0.8 + Math.exp(-t * 28) * 0.6);
  }, (d) => { hp1(d, 3200, sr); hp1(d, 3200, sr); lp1(d, 11000, sr); });
  S.rideBell = mono(1.2, (t) => {
    let s = 0; for (const f of rideF) s += Math.sin(2 * Math.PI * f * 1.4 * t);
    return s * Math.exp(-t * 4);
  }, (d) => hp1(d, 1200, sr));
  // brush tap & sweep
  S.brushTap = mono(0.25, (t) => (r() * 2 - 1) * (Math.exp(-t * 30) + 0.25 * Math.exp(-t * 9)), (d) => { bp(d, 4200, 0.7, sr); });
  S.brushSweep = mono(0.6, (t) => (r() * 2 - 1) * Math.sin(Math.PI * Math.min(1, t / 0.55)) ** 1.5, (d) => { bp(d, 3000, 0.5, sr); lp1(d, 7000, sr); });
  // feathered jazz kick / frame drum / taiko
  const drum = (sec, f0, f1, dec, click, noiseF) => mono(sec, (t) => {
    const f = f1 + (f0 - f1) * Math.exp(-t * 18);
    const ph = 2 * Math.PI * (f1 * t + (f0 - f1) * (1 - Math.exp(-t * 18)) / 18);
    return Math.sin(ph) * Math.exp(-t * dec) + (r() * 2 - 1) * click * Math.exp(-t * 60) + 0 * f;
  }, (d) => { if (noiseF) lp1(d, noiseF, sr); });
  S.kick = drum(0.6, 110, 52, 9, 0.15, 2500);
  S.frame = drum(1.2, 140, 72, 4.5, 0.35, 1800);
  S.taiko = drum(2.0, 95, 44, 2.6, 0.5, 900);
  // Interstellar clock tick
  S.tick = mono(0.12, (t) => (r() * 2 - 1) * Math.exp(-t * 140) + Math.sin(2 * Math.PI * 2400 * t) * Math.exp(-t * 90) * 0.5, (d) => bp(d, 2600, 2.5, sr));
  // shaker
  S.shaker = mono(0.15, (t) => (r() * 2 - 1) * Math.exp(-((t - 0.025) ** 2) / 0.0004), (d) => { hp1(d, 5000, sr); });
  // rim click
  S.rim = mono(0.1, (t) => Math.sin(2 * Math.PI * 1700 * t) * Math.exp(-t * 80) + (r() * 2 - 1) * Math.exp(-t * 200) * 0.6, (d) => hp1(d, 400, sr));

  // ---- ambience loops (stereo) ----
  // cricket chorus: several insects with distinct carrier / pulse rates / phrase rhythms
  {
    const sec = 8, b = buf(ctx, sec), N = b.length;
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      const R = rng32(99 + c * 17);
      const bugs = Array.from({ length: 5 }, () => ({ f: R.range(3600, 5200), pr: R.range(28, 46), ph: R.range(0.55, 1.4), on: R.range(0.25, 0.5), amp: R.range(0.3, 1), off: R.range(0, 2) }));
      for (let i = 0; i < N; i++) {
        const t = i / sr;
        let s = 0;
        for (const k of bugs) {
          const phrase = ((t + k.off) % k.ph) / k.ph;
          if (phrase > k.on) continue;
          const pulse = Math.max(0, Math.sin(2 * Math.PI * k.pr * t)) ** 2;
          const shape = Math.sin(Math.PI * phrase / k.on);
          s += Math.sin(2 * Math.PI * k.f * t) * pulse * shape * k.amp;
        }
        d[i] = s * 0.25;
      }
      for (let i = 0; i < 2000; i++) { const k = i / 2000; d[i] = d[i] * k + d[N - 2000 + i] * (1 - k); }
    }
    S.crickets = b;
  }
  // rain drops: thousands of tiny filtered impulses
  {
    const sec = 6, b = buf(ctx, sec), N = b.length;
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      const R = rng32(555 + c);
      for (let k = 0; k < sec * 380; k++) {
        const i0 = Math.floor(R() * (N - 2000));
        const f = R.range(1800, 7000), a = R.range(0.05, 0.6) ** 2, dec = R.range(120, 400);
        for (let j = 0; j < 1600; j++) { const t = j / sr; d[i0 + j] += Math.sin(2 * Math.PI * f * t * (1 - t * 2)) * a * Math.exp(-t * dec); }
      }
      hp1(d, 900, sr);
      for (let i = 0; i < 2000; i++) { const k = i / 2000; d[i] = d[i] * k + d[N - 2000 + i] * (1 - k); }
    }
    let m = 0; for (let c = 0; c < 2; c++) for (const v of b.getChannelData(c)) m = Math.max(m, Math.abs(v));
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < N; i++) d[i] *= 0.8 / (m || 1); }
    S.drops = b;
  }
  return S;
}

/** Wavetables: pipe organ (8' + 4' + 2 2/3' + 2' flue ranks), soft piano, e-piano tine. */
export function waves(ctx) {
  const mk = (amps) => {
    const re = new Float32Array(amps.length + 1), im = new Float32Array(amps.length + 1);
    amps.forEach((a, i) => { im[i + 1] = a; });
    return ctx.createPeriodicWave(re, im, { disableNormalization: false });
  };
  return {
    organ: mk([1, 0.55, 0.42, 0.34, 0.08, 0.2, 0.03, 0.18, 0.02, 0.05, 0, 0.06]),
    flute: mk([1, 0.18, 0.06, 0.02]),
    piano: mk([1, 0.45, 0.22, 0.14, 0.08, 0.05, 0.03, 0.02, 0.012]),
    reed: mk([1, 0.7, 0.55, 0.42, 0.3, 0.22, 0.15, 0.1, 0.06, 0.04]),
    hollow: mk([1, 0, 0.33, 0, 0.2, 0, 0.14, 0, 0.11]),
  };
}

/** tanh soft-clip curve: transparent below ~-6 dBFS, rounds peaks above. */
export function softClipCurve(n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const ax = Math.abs(x);
    c[i] = ax < 0.5 ? x : Math.sign(x) * (0.5 + 0.48 * Math.tanh((ax - 0.5) / 0.48));
  }
  return c;
}
