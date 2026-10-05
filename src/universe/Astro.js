// Real astrophysics used across the universe: cosmology, stellar structure,
// orbital mechanics. SI units unless noted.

export const G = 6.674e-11;
export const C = 2.998e8;
export const AU = 1.496e11;
export const PC = 3.0857e16;
export const LY = 9.4607e15;
export const SOLAR_MASS = 1.989e30;
export const SOLAR_RADIUS = 6.957e8;
export const SOLAR_LUM = 3.828e26;
export const SOLAR_TEMP = 5772;
export const EARTH_MASS = 5.972e24;
export const EARTH_RADIUS = 6.371e6;
export const JUPITER_MASS = 1.898e27;
export const JUPITER_RADIUS = 6.9911e7;
export const YEAR = 3.15576e7;
export const DAY = 86400;
export const SIGMA_SB = 5.670374e-8;

// ---- Cosmology (flat ΛCDM, Planck 2018) ------------------------------------
export const COSMO = { H0: 67.7, Om: 0.31, OL: 0.69, sigma8: 0.81, ns: 0.965, h: 0.677 };

/** Hubble parameter E(a) = H(a)/H0 for flat ΛCDM (radiation neglected). */
export function E(a, cosmo = COSMO) { return Math.sqrt(cosmo.Om / (a * a * a) + cosmo.OL); }

/**
 * Linear growth factor D(a), normalised to D(1)=1, via the Carroll, Press &
 * Turner (1992) fitting formula — accurate to ~1% for ΛCDM.
 */
export function growthFactor(a, cosmo = COSMO) {
  const g = (aa) => {
    const e2 = cosmo.Om / (aa * aa * aa) + cosmo.OL;
    const Om = cosmo.Om / (aa * aa * aa) / e2, OL = cosmo.OL / e2;
    return 2.5 * Om / (Math.pow(Om, 4 / 7) - OL + (1 + Om / 2) * (1 + OL / 70));
  };
  return (a * g(a)) / g(1);
}

/** Growth rate f = dlnD/dlna ≈ Ωm(a)^0.55 (Linder). */
export function growthRate(a, cosmo = COSMO) {
  const e2 = cosmo.Om / (a * a * a) + cosmo.OL;
  return Math.pow(cosmo.Om / (a * a * a) / e2, 0.55);
}

/** Age of the universe at scale factor a, in Gyr (flat ΛCDM, analytic). */
export function ageAt(a, cosmo = COSMO) {
  const H0s = (cosmo.H0 * 1000) / (PC * 1e6); // 1/s
  const t = (2 / (3 * Math.sqrt(cosmo.OL))) * Math.asinh(Math.sqrt((cosmo.OL / cosmo.Om) * a * a * a)) / H0s;
  return t / (YEAR * 1e9);
}
export const redshiftOf = (a) => 1 / a - 1;
export const scaleOf = (z) => 1 / (1 + z);

/**
 * Approximate ΛCDM matter power spectrum P(k) shape (BBKS transfer function),
 * k in h/Mpc. Normalisation is arbitrary (callers normalise to σ8).
 */
export function powerSpectrum(k, cosmo = COSMO) {
  if (k <= 0) return 0;
  const gamma = cosmo.Om * cosmo.h;
  const q = k / gamma;
  const T = Math.log(1 + 2.34 * q) / (2.34 * q) * Math.pow(1 + 3.89 * q + Math.pow(16.1 * q, 2) + Math.pow(5.46 * q, 3) + Math.pow(6.71 * q, 4), -0.25);
  return Math.pow(k, cosmo.ns) * T * T;
}

// ---- Stars ---------------------------------------------------------------------
// Spectral classes with real-ish parameters (main sequence) and relative
// abundance in the Milky Way (M dwarfs dominate).
export const SPECTRAL = [
  { cls: 'O', temp: [30000, 50000], mass: [16, 60], abundance: 0.00003 },
  { cls: 'B', temp: [10000, 30000], mass: [2.1, 16], abundance: 0.0013 },
  { cls: 'A', temp: [7500, 10000], mass: [1.4, 2.1], abundance: 0.006 },
  { cls: 'F', temp: [6000, 7500], mass: [1.04, 1.4], abundance: 0.03 },
  { cls: 'G', temp: [5200, 6000], mass: [0.8, 1.04], abundance: 0.076 },
  { cls: 'K', temp: [3700, 5200], mass: [0.45, 0.8], abundance: 0.121 },
  { cls: 'M', temp: [2400, 3700], mass: [0.08, 0.45], abundance: 0.7645 },
];

/** Main-sequence luminosity (L☉) from mass (M☉), piecewise mass–luminosity relation. */
export function massLuminosity(m) {
  if (m < 0.43) return 0.23 * Math.pow(m, 2.3);
  if (m < 2) return Math.pow(m, 4);
  if (m < 55) return 1.4 * Math.pow(m, 3.5);
  return 32000 * m;
}
/** Main-sequence radius (R☉) from mass (M☉). */
export function massRadius(m) { return m < 1 ? Math.pow(m, 0.8) : Math.pow(m, 0.57); }
/** Effective temperature from L (L☉) and R (R☉) via Stefan–Boltzmann. */
export function effectiveTemp(L, R) { return SOLAR_TEMP * Math.pow(L / (R * R), 0.25); }
/** Main-sequence lifetime in Gyr. */
export function msLifetime(m) { return 10 * Math.pow(m, -2.5); }

/** Habitable zone inner/outer edges in AU (Kopparapu-like, simplified). */
export function habitableZone(L) { return [Math.sqrt(L / 1.1), Math.sqrt(L / 0.53)]; }

/** Planet equilibrium temperature (K). L in L☉, a in AU. */
export function equilibriumTemp(L, aAU, albedo = 0.3) {
  return 278.6 * Math.pow(L * (1 - albedo), 0.25) / Math.sqrt(aAU);
}

/**
 * Blackbody color (linear sRGB, max-normalised) for a temperature in K.
 * Integrates Planck's law against CIE 1931 2° colour matching functions
 * (analytic multi-lobe Gaussian fit, Wyman et al. 2013).
 */
export function blackbodyColor(T) {
  const g = (x, mu, s1, s2) => { const t = (x - mu) / (x < mu ? s1 : s2); return Math.exp(-0.5 * t * t); };
  let X = 0, Y = 0, Z = 0;
  for (let lam = 380; lam <= 780; lam += 5) {
    const l = lam * 1e-9;
    const B = 1 / (Math.pow(l, 5) * (Math.exp(1.4387769e-2 / (l * T)) - 1));
    const x = 1.056 * g(lam, 599.8, 37.9, 31.0) + 0.362 * g(lam, 442.0, 16.0, 26.7) - 0.065 * g(lam, 501.1, 20.4, 26.2);
    const y = 0.821 * g(lam, 568.8, 46.9, 40.5) + 0.286 * g(lam, 530.9, 16.3, 31.1);
    const z = 1.217 * g(lam, 437.0, 11.8, 36.0) + 0.681 * g(lam, 459.0, 26.0, 13.8);
    X += B * x; Y += B * y; Z += B * z;
  }
  let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  let gg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  let b = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  r = Math.max(r, 0); gg = Math.max(gg, 0); b = Math.max(b, 0);
  const m = Math.max(r, gg, b) || 1;
  return [r / m, gg / m, b / m];
}

// ---- Orbits --------------------------------------------------------------------
/** Solve Kepler's equation M = E - e sin E for eccentric anomaly E (Newton). */
export function solveKepler(M, e) {
  M = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let Ecc = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 12; i++) {
    const d = (Ecc - e * Math.sin(Ecc) - M) / (1 - e * Math.cos(Ecc));
    Ecc -= d;
    if (Math.abs(d) < 1e-10) break;
  }
  return Ecc;
}

/**
 * Position on a Keplerian orbit at time t.
 * el = { a, e, i, node (Ω), peri (ω), M0, period } (angles in radians, a in any unit)
 * Returns [x, y, z] in the reference plane (y up, ecliptic = xz plane).
 */
export function orbitPosition(el, t, out = [0, 0, 0]) {
  const n = (2 * Math.PI) / el.period;
  const M = el.M0 + n * t;
  const Ecc = solveKepler(M, el.e);
  const cosE = Math.cos(Ecc), sinE = Math.sin(Ecc);
  const xv = el.a * (cosE - el.e);
  const yv = el.a * Math.sqrt(1 - el.e * el.e) * sinE;
  const v = Math.atan2(yv, xv), r = Math.hypot(xv, yv);
  const cO = Math.cos(el.node), sO = Math.sin(el.node);
  const cw = Math.cos(el.peri + v), sw = Math.sin(el.peri + v);
  const ci = Math.cos(el.i), si = Math.sin(el.i);
  const x = r * (cO * cw - sO * sw * ci);
  const z = r * (sO * cw + cO * sw * ci);
  const y = r * (sw * si);
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

/** Orbital period (seconds) from semi-major axis (m) and central mass (kg). */
export function keplerPeriod(aMeters, M) { return 2 * Math.PI * Math.sqrt((aMeters * aMeters * aMeters) / (G * M)); }

/** Schwarzschild radius (m) of a mass (kg). */
export function schwarzschildRadius(M) { return (2 * G * M) / (C * C); }

/** Surface gravity (m/s²). */
export function surfaceGravity(M, R) { return (G * M) / (R * R); }

/** Hill sphere radius. */
export function hillRadius(a, m, M) { return a * Math.cbrt(m / (3 * M)); }

/** Rocky planet radius (Earth radii) from mass (Earth masses), Zeng et al. style. */
export function rockyRadius(mE) { return Math.pow(mE, 0.27); }
