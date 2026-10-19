// Cosmology for the cosmic web.
//
//  • Linear (D1) and second-order (D2) growth functions integrated from the
//    exact flat-ΛCDM growth ODEs (radiation neglected, E(a) from Astro.js):
//        d/da [a³E dD1/da] = 3/2 Ωm D1 / (a²E)
//        d/da [a³E dD2/da] = 3/2 Ωm (D2 − D1²) / (a²E)
//  • FastPM kick/drift operators (Feng et al. 2016): exact Zel'dovich growth in
//    the linear regime for any step size, so ~40 PM steps reproduce ΛCDM.
//  • σ8 normalisation of the Astro.js BBKS power spectrum.
//  • Gaussian random field modes generated directly in Fourier space with a
//    per-k-vector seed: every quality tier (grid size) shares the same
//    large-scale modes, hence the same clusters, voids and halo catalogue.
//
// Units: lengths in Mpc/h (comoving), time in 1/H0, canonical momentum
// p = a² dx/dt  →  peculiar velocity v = p / a  in units of 100 km/s.

import { COSMO, E, ageAt, powerSpectrum, growthFactor, growthRate } from '../../universe/Astro.js';
import { hash3i } from '../../core/Random.js';

export const BOX = 200; // Mpc/h — comoving side of the periodic box
export const A_START = 0.02; // z = 49: N-body starts here (2LPT initial conditions)
export const A_CMB = 1 / 1090; // recombination, the CMB

export class Growth {
  constructor(cosmo = COSMO) {
    this.cosmo = cosmo;
    const n = 4096, a0 = 1e-4, a1 = 24;
    this.n = n; this.l0 = Math.log(a0); this.dl = (Math.log(a1) - this.l0) / (n - 1);
    const D1 = new Float64Array(n), P1 = new Float64Array(n), D2 = new Float64Array(n), P2 = new Float64Array(n);
    const Om = cosmo.Om;
    // y = [D1, P1 = a³E D1', D2, P2 = a³E D2'], integrated in ln a.
    const f = (a, y, o) => {
      const e = E(a, cosmo), a3e = a * a * a * e, s = 1.5 * Om / (a * a * e);
      o[0] = a * y[1] / a3e; o[1] = a * s * y[0];
      o[2] = a * y[3] / a3e; o[3] = a * s * (y[2] - y[0] * y[0]);
    };
    const ea0 = E(a0, cosmo);
    let y = [a0, a0 * a0 * a0 * ea0, -3 / 7 * a0 * a0, a0 * a0 * a0 * ea0 * (-6 / 7 * a0)];
    const k1 = [0, 0, 0, 0], k2 = [0, 0, 0, 0], k3 = [0, 0, 0, 0], k4 = [0, 0, 0, 0], t = [0, 0, 0, 0];
    const sub = 8, h = this.dl / sub;
    for (let i = 0; i < n; i++) {
      D1[i] = y[0]; P1[i] = y[1]; D2[i] = y[2]; P2[i] = y[3];
      if (i === n - 1) break;
      let l = this.l0 + i * this.dl;
      for (let s = 0; s < sub; s++) {
        const a = Math.exp(l);
        f(a, y, k1);
        for (let j = 0; j < 4; j++) t[j] = y[j] + 0.5 * h * k1[j];
        f(Math.exp(l + 0.5 * h), t, k2);
        for (let j = 0; j < 4; j++) t[j] = y[j] + 0.5 * h * k2[j];
        f(Math.exp(l + 0.5 * h), t, k3);
        for (let j = 0; j < 4; j++) t[j] = y[j] + h * k3[j];
        f(Math.exp(l + h), t, k4);
        for (let j = 0; j < 4; j++) y[j] += (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]);
        l += h;
      }
    }
    // Normalise D1(1) = 1 (D2 ∝ D1² scales with the square).
    this.D1t = D1; this.P1t = P1; this.D2t = D2; this.P2t = P2;
    const s = 1 / this._lerp(D1, 1);
    for (let i = 0; i < n; i++) { D1[i] *= s; P1[i] *= s; D2[i] *= s * s; P2[i] *= s * s; }
  }

  _lerp(tab, a) {
    const x = (Math.log(a) - this.l0) / this.dl;
    const i = Math.max(0, Math.min(this.n - 2, Math.floor(x)));
    const u = Math.max(0, Math.min(1, x - i));
    return tab[i] + (tab[i + 1] - tab[i]) * u;
  }
  D1(a) { return this._lerp(this.D1t, a); }
  D2(a) { return this._lerp(this.D2t, a); }
  /** Linear momentum growth G_p(a) = a³E dD1/da  (p_lin = G_p S1). */
  Gp(a) { return this._lerp(this.P1t, a); }
  Gp2(a) { return this._lerp(this.P2t, a); }
  /** f = dlnD1/dlna */
  f1(a) { return this.Gp(a) / (a * a * E(a, this.cosmo) * this.D1(a)); }

  /** FastPM kick factor: Δp = F(a_c)·K, F = −∇Φ with ∇²Φ = 3/2 Ωm δ / a_c. */
  kick(a0, a1, ac) { return (this.Gp(a1) - this.Gp(a0)) * ac / (1.5 * this.cosmo.Om * this.D1(ac)); }
  /** FastPM drift factor: Δx = p(a_c)·Dr. */
  drift(a0, a1, ac) { return (this.D1(a1) - this.D1(a0)) / this.Gp(ac); }
}

/**
 * Time-step boundaries (scale factors). Uniform in √a inside each segment —
 * large steps while the universe is linear, fine steps while halos collapse —
 * with exact boundaries at the snapshot epochs, then gentle steps into the
 * future (the web keeps evolving after today).
 */
export function makeSchedule(steps = 40, marks = [1 / 6, 1]) {
  const knots = [A_START, ...marks.filter((m) => m > A_START).sort((a, b) => a - b)];
  const span = Math.sqrt(knots[knots.length - 1]) - Math.sqrt(A_START);
  const out = [A_START];
  for (let k = 1; k < knots.length; k++) {
    const s0 = Math.sqrt(knots[k - 1]), s1 = Math.sqrt(knots[k]);
    const nSeg = Math.max(1, Math.round((steps * (s1 - s0)) / span));
    for (let i = 1; i <= nSeg; i++) { const s = s0 + ((s1 - s0) * i) / nSeg; out.push(i === nSeg ? knots[k] : s * s); }
  }
  // Future: Δa ≈ 0.045 → 0.09, up to a = 6 (≈ +30 Gyr).
  let a = out[out.length - 1];
  while (a < 6) { a += 0.045 * Math.sqrt(a); out.push(a); }
  return out;
}

/** σ8 normalisation constant for Astro.powerSpectrum (top-hat R = 8 Mpc/h). */
export function sigma8Norm(cosmo = COSMO) {
  const W = (x) => (x < 1e-3 ? 1 - x * x / 10 : (3 * (Math.sin(x) - x * Math.cos(x))) / (x * x * x));
  const lk0 = Math.log(1e-5), lk1 = Math.log(1e3), n = 6000, dl = (lk1 - lk0) / n;
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const k = Math.exp(lk0 + i * dl);
    const w = W(k * 8);
    const v = (k * k * k * powerSpectrum(k, cosmo) * w * w) / (2 * Math.PI * Math.PI);
    s += v * (i === 0 || i === n ? 0.5 : 1);
  }
  s *= dl;
  return (cosmo.sigma8 * cosmo.sigma8) / s;
}

/** Box–Muller from two uint32 hashes. */
function gauss2(h1, h2, out) {
  const u = Math.max(1e-12, (h1 >>> 0) / 4294967296), v = (h2 >>> 0) / 4294967296;
  const r = Math.sqrt(-2 * Math.log(u));
  out[0] = r * Math.cos(2 * Math.PI * v); out[1] = r * Math.sin(2 * Math.PI * v);
}

/**
 * Linear density modes δ_k at z = 0 on an M³ grid (unnormalised DFT
 * convention: δ(x) = M⁻³ Σ δ_k e^{ik·x}, ⟨|δ_k|²⟩ = M⁶ P(k) / V).
 * Hermitian symmetric by construction. Modes above kCut (the particle-lattice
 * Nyquist) and the grid Nyquist planes are zeroed.
 * Returns RGBA float data laid out in the 2D-tiled 3D layout (R,G = Re, Im).
 */
export function linearModes(M, TX, L, seed, kCutIdx, cosmo = COSMO) {
  const norm = sigma8Norm(cosmo);
  const V = L * L * L, kf = (2 * Math.PI) / L;
  const half = M >> 1, maxK2 = 3 * half * half;
  // Amplitude per integer |k|²: sqrt(M⁶ P(k) / V), with a soft spherical cut.
  const amp = new Float64Array(maxK2 + 1);
  for (let kk = 1; kk <= maxK2; kk++) {
    const kmag = Math.sqrt(kk);
    if (kmag > kCutIdx) continue;
    const k = kf * kmag;
    const taper = kmag > kCutIdx * 0.85 ? 0.5 + 0.5 * Math.cos(Math.PI * (kmag - kCutIdx * 0.85) / (kCutIdx * 0.15)) : 1;
    amp[kk] = Math.sqrt((M * M * M * M * M * M * norm * powerSpectrum(k, cosmo)) / V) * taper;
  }
  const TY = M / TX, W = TX * M, H = TY * M;
  const data = new Float32Array(W * H * 4);
  const g = [0, 0];
  const s1 = seed >>> 0, s2 = (seed ^ 0x5bd1e995) >>> 0;
  for (let z = 0; z < M; z++) {
    const kz = z < half ? z : z - M;
    const ox = (z % TX) * M, oy = Math.floor(z / TX) * M;
    for (let y = 0; y < M; y++) {
      const ky = y < half ? y : y - M;
      for (let x = 0; x < M; x++) {
        const kx = x < half ? x : x - M;
        if (kx === -half || ky === -half || kz === -half) continue;
        const kk = kx * kx + ky * ky + kz * kz;
        if (kk === 0 || amp[kk] === 0) continue;
        // Canonical half of k-space carries the random numbers; the other half is the conjugate.
        const canon = kx > 0 || (kx === 0 && (ky > 0 || (ky === 0 && kz > 0)));
        const cx = canon ? kx : -kx, cy = canon ? ky : -ky, cz = canon ? kz : -kz;
        gauss2(hash3i(cx, cy, cz, s1), hash3i(cx, cy, cz, s2), g);
        const a = amp[kk] * Math.SQRT1_2;
        const i = ((oy + y) * W + ox + x) * 4;
        data[i] = g[0] * a;
        data[i + 1] = (canon ? g[1] : -g[1]) * a;
      }
    }
  }
  return data;
}

/** Physical helpers for telemetry and the UI. */
export const redshift = (a) => 1 / a - 1;
export function ageGyr(a, cosmo = COSMO) { return ageAt(a, cosmo); }
/** CMB temperature (K). */
export const cmbTemperature = (a) => 2.7255 / a;

/** Particle mass in M☉/h for N particles in a box of side L (Mpc/h). */
export function particleMass(N, L = BOX, cosmo = COSMO) { return cosmo.Om * 2.775e11 * (L * L * L) / N; }

/** Cross-check against Astro.js fitting formulae (dev aid). */
export function checkGrowth(growth) {
  const out = [];
  for (const a of [0.02, 0.1, 0.5, 1]) out.push({ a, D1: growth.D1(a), cpt: growthFactor(a), f: growth.f1(a), linder: growthRate(a) });
  return out;
}

export { COSMO, E };
