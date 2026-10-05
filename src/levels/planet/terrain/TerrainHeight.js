// Planet height field — the single source of truth for terrain shape.
// PURE + WORKER-SAFE: imported by the main thread (physics, placement) AND by
// the terrain workers (mesh generation). Both produce bit-identical numbers.
//
//   const params = terrainParams(planet)          // plain JSON, postMessage-able
//   const T = createTerrain(params)
//   T.height(x, y, z)  → meters above base radius for unit direction (x,y,z)
//   T.sample(x, y, z)  → { h, moisture, temp, rock, biome, snow, sand, river, wet }
//   T.seaLevel         → 0 when the world has an ocean (coasts are designed at h = 0), else -Infinity
//
// Biome codes: 0 seabed · 1 grassland · 2 forest · 3 arid scrub · 4 snow/ice ·
//              5 sand (beach/dune) · 6 bare rock / alpine · 7 wetland · 8 volcanic ash
//
// Landforms are style-driven (aesthetic.terrain.style): rolling, dunes, mesas,
// craters, wetlands, plateaus, karst, canyons, highlands, archipelago, blobby,
// badlands, volcanic, glacial. Every style shares one continental frame
// (domain-warped continents, shelves, ocean basins calibrated to the
// aesthetic's ocean fraction), meandering river valleys, derivative-eroded
// ridged mountains (iq) and a band-limited meter-scale detail layer.

import { Random } from '../../../core/Random.js';

// ---------------------------------------------------------------------------
// Fast seeded 3D simplex noise with analytic derivatives (r² = 0.5 kernel,
// C1-continuous). Pure JS, no allocations in the hot path.
// ---------------------------------------------------------------------------
const F3 = 1 / 3, G3 = 1 / 6;
const NSCALE = 106.0;

/** Derivative output of the last `n3d` call: [dx, dy, dz]. */
export const DN = new Float64Array(3);

export function makeNoise(seed) {
  const rng = new Random((seed >>> 0) || 1);
  const p = new Uint16Array(1024);
  for (let i = 0; i < 1024; i++) p[i] = i;
  for (let i = 1023; i > 0; i--) { const j = Math.floor(rng.float() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  const perm = new Uint16Array(2048);
  for (let i = 0; i < 2048; i++) perm[i] = p[i & 1023];
  const GX = new Float64Array(1024), GY = new Float64Array(1024), GZ = new Float64Array(1024);
  for (let i = 0; i < 1024; i++) {
    // random unit gradients → isotropic noise
    const z = rng.range(-1, 1), t = rng.range(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
    GX[i] = r * Math.cos(t); GY[i] = r * Math.sin(t); GZ[i] = z;
  }

  function n3(x, y, z) {
    const s = (x + y + z) * F3;
    const fi = Math.floor(x + s), fj = Math.floor(y + s), fk = Math.floor(z + s);
    const t = (fi + fj + fk) * G3;
    const x0 = x - fi + t, y0 = y - fj + t, z0 = z - fk + t;
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = fi & 1023, jj = fj & 1023, kk = fk & 1023;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) { const g = perm[ii + perm[jj + perm[kk]]]; t0 *= t0; n += t0 * t0 * (GX[g] * x0 + GY[g] * y0 + GZ[g] * z0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) { const g = perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]]; t1 *= t1; n += t1 * t1 * (GX[g] * x1 + GY[g] * y1 + GZ[g] * z1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) { const g = perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]]; t2 *= t2; n += t2 * t2 * (GX[g] * x2 + GY[g] * y2 + GZ[g] * z2); }
    let t3 = 0.5 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) { const g = perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]]; t3 *= t3; n += t3 * t3 * (GX[g] * x3 + GY[g] * y3 + GZ[g] * z3); }
    return NSCALE * n;
  }

  /** Noise value; gradient written to DN. */
  function n3d(x, y, z) {
    const s = (x + y + z) * F3;
    const fi = Math.floor(x + s), fj = Math.floor(y + s), fk = Math.floor(z + s);
    const t = (fi + fj + fk) * G3;
    const x0 = x - fi + t, y0 = y - fj + t, z0 = z - fk + t;
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = fi & 1023, jj = fj & 1023, kk = fk & 1023;
    let n = 0, dx = 0, dy = 0, dz = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = perm[ii + perm[jj + perm[kk]]];
      const gd = GX[g] * x0 + GY[g] * y0 + GZ[g] * z0, t2 = t0 * t0, t4 = t2 * t2, k = -8 * t2 * t0 * gd;
      n += t4 * gd; dx += k * x0 + t4 * GX[g]; dy += k * y0 + t4 * GY[g]; dz += k * z0 + t4 * GZ[g];
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]];
      const gd = GX[g] * x1 + GY[g] * y1 + GZ[g] * z1, t2 = t1 * t1, t4 = t2 * t2, k = -8 * t2 * t1 * gd;
      n += t4 * gd; dx += k * x1 + t4 * GX[g]; dy += k * y1 + t4 * GY[g]; dz += k * z1 + t4 * GZ[g];
    }
    let t2_ = 0.5 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2_ > 0) {
      const g = perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]];
      const gd = GX[g] * x2 + GY[g] * y2 + GZ[g] * z2, t2 = t2_ * t2_, t4 = t2 * t2, k = -8 * t2 * t2_ * gd;
      n += t4 * gd; dx += k * x2 + t4 * GX[g]; dy += k * y2 + t4 * GY[g]; dz += k * z2 + t4 * GZ[g];
    }
    let t3 = 0.5 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]];
      const gd = GX[g] * x3 + GY[g] * y3 + GZ[g] * z3, t2 = t3 * t3, t4 = t2 * t2, k = -8 * t2 * t3 * gd;
      n += t4 * gd; dx += k * x3 + t4 * GX[g]; dy += k * y3 + t4 * GY[g]; dz += k * z3 + t4 * GZ[g];
    }
    DN[0] = NSCALE * dx; DN[1] = NSCALE * dy; DN[2] = NSCALE * dz;
    return NSCALE * n;
  }

  // Lattice hash for cellular features: (ix,iy,iz,k) → [0,1)
  function hashU(ix, iy, iz, k) {
    // 2 rounds for better decorrelation; returns [0,1)
    let h = perm[((ix & 1023) + perm[((iy & 1023) + perm[((iz & 1023) + k * 37) & 2047]) & 2047]) & 2047];
    h = perm[(h + k * 101 + 7) & 2047];
    return (h + rng01[(h + k) & 1023]) / 1024;
  }
  const rng01 = new Float64Array(1024);
  for (let i = 0; i < 1024; i++) rng01[i] = rng.float();

  return { n3, n3d, hashU };
}

// ---------------------------------------------------------------------------
// Small math
// ---------------------------------------------------------------------------
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
function smoothstep(e0, e1, x) { let t = (x - e0) / (e1 - e0); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
function smootherstep(e0, e1, x) { let t = (x - e0) / (e1 - e0); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * t * (t * (t * 6 - 15) + 10); }
/** polynomial smooth max / min (k in output units) */
function smax(a, b, k) { const h = clamp01(0.5 + 0.5 * (a - b) / k); return lerp(b, a, h) + k * h * (1 - h); }
function smin(a, b, k) { const h = clamp01(0.5 + 0.5 * (b - a) / k); return lerp(b, a, h) - k * h * (1 - h); }
/** smooth |x| (rounded crease of width k) */
const sabs = (x, k) => Math.sqrt(x * x + k * k) - k;

/** Smooth terraces: step height `s`, riser steepness `k` (0 = linear, 1 = hard). */
function terrace(h, s, k) {
  const q = h / s, f = Math.floor(q), t = q - f;
  // ease the step: flat treads, steep risers
  const e = k <= 0 ? t : smoothstep(0.5 - 0.5 * (1 - k), 0.5 + 0.5 * (1 - k), t);
  return (f + e) * s;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------
const CLIMATE = {
  // temp0: equatorial sea-level temperature (0 frozen … 1 scorching); moist0: base humidity
  rolling: { temp0: 0.64, moist0: 0.62 },
  dunes: { temp0: 0.86, moist0: 0.06 },
  karst: { temp0: 0.72, moist0: 0.74 },
  glacial: { temp0: 0.16, moist0: 0.5 },
  mesas: { temp0: 0.78, moist0: 0.2 },
  canyons: { temp0: 0.74, moist0: 0.26 },
  highlands: { temp0: 0.58, moist0: 0.52 },
  plateaus: { temp0: 0.6, moist0: 0.42 },
  badlands: { temp0: 0.72, moist0: 0.16 },
  craters: { temp0: 0.45, moist0: 0.0 },
  volcanic: { temp0: 0.92, moist0: 0.08 },
  wetlands: { temp0: 0.56, moist0: 0.86 },
  archipelago: { temp0: 0.6, moist0: 0.62 },
  blobby: { temp0: 0.66, moist0: 0.6 },
};

/** Pure-JSON parameters for createTerrain (postMessage-able). */
export function terrainParams(planet) {
  const A = planet.terrainStyle || null;
  const style = planet.styleTerrain || (planet.kind === 'desert' ? 'dunes' : planet.kind === 'ice' ? 'glacial' : planet.kind === 'lava' ? 'volcanic' : planet.kind === 'barren' ? 'craters' : 'rolling');
  const ocean = planet.world.seaLevel ?? 0.2;
  return {
    seed: planet.seed >>> 0,
    radius: planet.world.radius,
    relief: planet.world.relief,
    oceanFraction: ocean,
    style: CLIMATE[style] ? style : 'rolling',
    kind: planet.kind,
    aesthetic: planet.aesthetic,
    tempK: planet.tempK,
    ...(A || {}),
  };
}

// Fibonacci sphere sample (deterministic, uniform)
function fib(i, n, out) {
  const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), phi = i * 2.399963229728653;
  out[0] = Math.cos(phi) * r; out[1] = y; out[2] = Math.sin(phi) * r;
  return out;
}

// ---------------------------------------------------------------------------
// createTerrain
// ---------------------------------------------------------------------------
export function createTerrain(p) {
  const R = p.radius, rel = p.relief;
  const style = p.style || 'rolling';
  const oceanFrac = p.oceanFraction ?? 0.2;
  const hasOcean = oceanFrac > 0.001;
  const clim = CLIMATE[style] || CLIMATE.rolling;
  const seed = p.seed >>> 0;
  const rng = new Random(seed ^ 0x2c1b3c6d);

  const nC = makeNoise(seed ^ 0x9e3779b9); // continents
  const nW = makeNoise(seed ^ 0x85ebca6b); // warps
  const nM = makeNoise(seed ^ 0xc2b2ae35); // mountains / masks
  const nH = makeNoise(seed ^ 0x27d4eb2f); // hills
  const nD = makeNoise(seed ^ 0x165667b1); // detail
  const nR = makeNoise(seed ^ 0xd3a2646c); // rivers
  const nS = makeNoise(seed ^ 0xfd7046c5); // style-specific
  const nK = makeNoise(seed ^ 0xb55a4f09); // cells / climate

  // Random per-planet offsets so planets sharing a style differ.
  const o = []; for (let i = 0; i < 24; i++) o.push(rng.range(-100, 100));
  const style01 = rng.float();

  // ---- fractal helpers ----------------------------------------------------
  function fbm(n, x, y, z, oct, lac = 2.0, gain = 0.5) {
    let s = 0, a = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      s += a * n.n3(x, y, z); norm += a; a *= gain;
      x = x * lac + 17.13; y = y * lac - 9.71; z = z * lac + 5.29;
    }
    return s / norm;
  }
  /** fbm with per-octave fractional amplitude cut (for band limiting). */
  function fbmAmp(n, x, y, z, oct, lac, gain) {
    let s = 0, a = 1;
    for (let i = 0; i < oct; i++) {
      s += a * n.n3(x, y, z); a *= gain;
      x = x * lac + 17.13; y = y * lac - 9.71; z = z * lac + 5.29;
    }
    return s;
  }
  /**
   * Ridged multifractal with iq-style derivative erosion: octaves are damped
   * where the accumulated slope is already steep → smooth flanks, crisp crests,
   * detail collecting in valleys/flats. (ux,uy,uz) = unit surface normal for
   * tangent-plane projection of the gradient. Returns ~[0, 1].
   */
  function ridgedEroded(n, x, y, z, ux, uy, uz, oct, lac, gain, erosion, sharp) {
    let s = 0, a = 0.5, w = 1, f = 1, gx = 0, gy = 0, gz = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      const v = n.n3d(x, y, z);
      const av = Math.sqrt(v * v + 0.0009); // rounded crease
      let r = 1 - av; if (r < 0) r = 0;
      const r2 = sharp > 1 ? Math.pow(r, sharp) : r * r;
      // derivative of r wrt v ≈ -sign(v); slope accumulates in tangent plane
      const sg = -(v / av) * a * f;
      let dx = DN[0] * sg, dy = DN[1] * sg, dz = DN[2] * sg;
      const dn = dx * ux + dy * uy + dz * uz; dx -= dn * ux; dy -= dn * uy; dz -= dn * uz;
      gx += dx; gy += dy; gz += dz;
      const rr = r2 * w;
      s += a * rr / (1 + erosion * (gx * gx + gy * gy + gz * gz));
      norm += a;
      w = clamp01(rr * 2.2);
      a *= gain; f *= lac;
      x = x * lac + 11.7; y = y * lac + 3.3; z = z * lac - 7.9;
    }
    return s / norm;
  }
  /** iq eroded fbm (value noise style) on the sphere. Returns ~[-1,1]. */
  function erodedFbm(n, x, y, z, ux, uy, uz, oct, lac, gain, erosion) {
    let s = 0, a = 1, f = 1, gx = 0, gy = 0, gz = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      const v = n.n3d(x, y, z);
      let dx = DN[0] * a * f, dy = DN[1] * a * f, dz = DN[2] * a * f;
      const dn = dx * ux + dy * uy + dz * uz; dx -= dn * ux; dy -= dn * uy; dz -= dn * uz;
      gx += dx; gy += dy; gz += dz;
      s += a * v / (1 + erosion * (gx * gx + gy * gy + gz * gz));
      norm += a; a *= gain; f *= lac;
      x = x * lac + 5.3; y = y * lac - 13.1; z = z * lac + 2.7;
    }
    return s / norm;
  }

  // ---- cellular features (towers, craters, cones, bulbs) --------------------
  // 3D jittered lattice restricted to [0.25,0.75] per axis; with feature radius
  // < 0.5 cell only the 2×2×2 nearest cells can touch a point → exact & cheap.
  // cb(dist, cellRandA, cellRandB, cellRandC) is folded with smooth max.
  const CELL = { best: 0, id: 0, d: 0, ra: 0, rb: 0, rc: 0 };
  function cells(n, X, Y, Z, size, salt, fn, acc) {
    const x = X / size, y = Y / size, z = Z / size;
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const ox = x - ix < 0.5 ? -1 : 0, oy = y - iy < 0.5 ? -1 : 0, oz = z - iz < 0.5 ? -1 : 0;
    let v = acc;
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
      const cx = ix + ox + a, cy = iy + oy + b, cz = iz + oz + c;
      const h1 = n.hashU(cx, cy, cz, salt), h2 = n.hashU(cx, cy, cz, salt + 1), h3 = n.hashU(cx, cy, cz, salt + 2);
      const fx = cx + 0.25 + 0.5 * h1, fy = cy + 0.25 + 0.5 * h2, fz = cz + 0.25 + 0.5 * h3;
      const dx = x - fx, dy = y - fy, dz = z - fz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 0.25) continue; // beyond 0.5 cells: no influence
      v = fn(Math.sqrt(d2), n.hashU(cx, cy, cz, salt + 3), n.hashU(cx, cy, cz, salt + 4), n.hashU(cx, cy, cz, salt + 5), v);
    }
    return v;
  }

  // ---- shared continental frame -------------------------------------------
  const contFreq = style === 'archipelago' ? 1.7 : style === 'dunes' ? 1.0 : 1.2;
  function continentRaw(x, y, z) {
    const wx = fbm(nW, x * 1.6 + o[0], y * 1.6 + o[1], z * 1.6 + o[2], 3);
    const wy = fbm(nW, x * 1.6 + o[3], y * 1.6 + o[4], z * 1.6 + o[5], 3);
    const wz = fbm(nW, x * 1.6 + o[6], y * 1.6 + o[7], z * 1.6 + o[8], 3);
    const k = 0.34;
    return fbm(nC, (x + k * wx) * contFreq + o[9], (y + k * wy) * contFreq + o[10], (z + k * wz) * contFreq + o[11], 7, 2.0, 0.53);
  }
  // Calibrate the coastline so the requested fraction of the planet is ocean.
  let contSea = 0, contLo = -0.5, contHi = 0.5;
  {
    const n = 2400, vals = new Float64Array(n), v = [0, 0, 0];
    for (let i = 0; i < n; i++) { fib(i, n, v); vals[i] = continentRaw(v[0], v[1], v[2]); }
    vals.sort();
    contSea = hasOcean ? vals[Math.floor(clamp(oceanFrac, 0, 0.98) * (n - 1))] : vals[Math.floor(0.45 * (n - 1))];
    contLo = vals[Math.floor(0.02 * (n - 1))]; contHi = vals[Math.floor(0.98 * (n - 1))];
  }
  const landSpan = Math.max(0.05, contHi - contSea), seaSpan = Math.max(0.05, contSea - contLo);

  // ---- dune wind phase (zonal winds, west → east) ---------------------------
  const duneLambda = 760; // m, primary crest spacing at the equator
  const duneN = Math.max(8, Math.round((2 * Math.PI * R) / duneLambda));
  const dune2Lambda = 270, dune2N = Math.max(8, Math.round((2 * Math.PI * R) / dune2Lambda));

  // ---- state written by evaluate() ------------------------------------------
  const S = { h: 0, moisture: 0, temp: 0, rock: 0, snow: 0, sand: 0, river: 0, wet: 0, cliff: 0, biome: 1, e: 0, ice: 0 };

  /**
   * Evaluate the terrain at unit direction (x,y,z).
   * full=false → height only (cheaper: skips climate fields).
   */
  function evaluate(x, y, z, full) {
    const X = x * R, Y = y * R, Z = z * R; // meters
    // continental signal, normalized: 0 = coastline, 1 ≈ deep interior, -1 ≈ abyss
    const cr = continentRaw(x, y, z);
    const e = cr >= contSea ? (cr - contSea) / landSpan : (cr - contSea) / seaSpan;
    S.e = e;
    let rock = 0, sand = 0, river = 0, wet = 0, cliff = 0, ice = 0;

    // Base profile: abyssal plains → slope → shelf → coast → interior.
    let h;
    if (e < 0) {
      const d = -e;
      h = -rel * (0.035 * smoothstep(0.0, 0.06, d) + 0.5 * smoothstep(0.06, 0.45, d) + 0.12 * d);
    } else {
      h = rel * (0.018 * smoothstep(0.0, 0.05, e) + 0.16 * smoothstep(0.03, 0.9, e));
    }
    const land = smoothstep(-0.02, 0.07, e);

    // regional masks (low frequency)
    const mReg = fbm(nM, x * 2.1 + o[12], y * 2.1 + o[13], z * 2.1 + o[14], 3) * 0.5 + 0.5; // 0..1
    const rough = clamp01(fbm(nM, x * 7 + o[15], y * 7 + o[16], z * 7 + o[17], 2) * 0.9 + 0.5);

    switch (style) {
      case 'dunes': h = styleDunes(x, y, z, X, Y, Z, e, h, mReg); break;
      case 'karst': h = styleKarst(x, y, z, X, Y, Z, e, h, land, mReg); break;
      case 'glacial': h = styleGlacial(x, y, z, X, Y, Z, e, h, land, mReg); break;
      case 'mesas': h = styleMesas(x, y, z, X, Y, Z, e, h, land, mReg); break;
      case 'canyons': h = styleCanyons(x, y, z, X, Y, Z, e, h, land, mReg); break;
      case 'badlands': h = styleBadlands(x, y, z, X, Y, Z, e, h, land, mReg); break;
      case 'craters': h = styleCraters(x, y, z, X, Y, Z, e, h, land, mReg); break;
      case 'volcanic': h = styleVolcanic(x, y, z, X, Y, Z, e, h, land, mReg); break;
      case 'wetlands': h = styleWetlands(x, y, z, X, Y, Z, e, h, land, mReg); break;
      case 'archipelago': h = styleArchipelago(x, y, z, X, Y, Z, e, h, land, mReg); break;
      case 'blobby': h = styleBlobby(x, y, z, X, Y, Z, e, h, land, mReg); break;
      case 'highlands': h = styleHighlands(x, y, z, X, Y, Z, e, h, land, mReg, false); break;
      case 'plateaus': h = styleHighlands(x, y, z, X, Y, Z, e, h, land, mReg, true); break;
      default: h = styleRolling(x, y, z, X, Y, Z, e, h, land, mReg); break;
    }
    rock = S.rock; sand = S.sand; cliff = S.cliff; ice = S.ice;

    // ---- river valleys (meandering, carved toward sea level in lowlands) ----
    if (style !== 'dunes' && style !== 'craters' && hasOcean && land > 0.01 && h > -2) {
      const wq = fbm(nR, x * 9 + o[18], y * 9 + o[19], z * 9 + o[20], 2) * 0.6;
      const rv = fbm(nR, x * 4.6 + wq, y * 4.6 - wq, z * 4.6 + wq * 0.5, 4, 2.1, 0.45);
      const ar = Math.abs(rv);
      const valleyW = style === 'canyons' ? 0.05 : 0.07, chanW = 0.0045;
      if (ar < valleyW) {
        const floor = Math.min(h, -2.5 + Math.max(0, h) * (style === 'karst' || style === 'wetlands' ? 0.02 : 0.12));
        const v = smootherstep(0, valleyW, ar);
        const vShape = Math.pow(v, 0.75);
        const carved = lerp(floor, h, vShape);
        const t = land * (1 - smoothstep(0.75, 1.0, ar / valleyW));
        h = lerp(h, carved, t);
        const ch = 1 - smoothstep(chanW * 0.4, chanW, ar);
        if (ch > 0) h -= ch * 2.2 * t;
        river = Math.max(river, (1 - smoothstep(0, chanW * 2.5, ar)) * t);
        wet = Math.max(wet, (1 - smoothstep(0, valleyW * 0.35, ar)) * t);
      }
    }

    // ---- band-limited detail (64 m → 1.5 m) --------------------------------
    {
      const r2 = clamp01(rough * 0.6 + rock * 0.8 + cliff * 0.6);
      const amp = (style === 'dunes' ? 0.25 : 0.55) + 2.6 * r2;
      const d = fbmAmp(nD, X / 48 + o[21], Y / 48 + o[22], Z / 48 + o[23], 6, 2.0, 0.44);
      h += d * amp;
    }

    S.h = h; S.rock = rock; S.sand = sand; S.river = river; S.wet = wet; S.cliff = cliff;
    if (!full) return h;

    // ---- climate ---------------------------------------------------------
    const lat = Math.abs(y);
    const tn = fbm(nK, x * 3.3 + 1.7, y * 3.3 - 4.1, z * 3.3 + 2.9, 2);
    const alt = Math.max(0, h);
    let temp = clim.temp0 - 0.62 * Math.pow(lat, 1.7) - (alt / rel) * 0.5 + tn * 0.07;
    temp = clamp01(temp);
    const mn = fbm(nK, x * 2.4 - 6.1, y * 2.4 + 3.3, z * 2.4 - 1.4, 3);
    let moisture = clim.moist0 + mn * 0.32 + wet * 0.35 + (hasOcean ? 0.12 * (1 - smoothstep(0.0, 0.25, e)) : 0) - (alt / rel) * 0.15;
    if (style === 'dunes') moisture = clim.moist0 + mn * 0.05 + wet * 0.2;
    moisture = clamp01(moisture);
    let snow = smoothstep(0.24, 0.07, temp);
    if (style === 'glacial') snow = Math.max(snow, ice);
    snow = clamp01(snow);
    if (style === 'craters' || style === 'volcanic') snow *= 0.2;

    let biome;
    const under = hasOcean && h < -0.3;
    if (under) biome = 0;
    else if (snow > 0.55) biome = 4;
    else if (style === 'volcanic' && rock > 0.3) biome = 8;
    else if (rock > 0.6 || cliff > 0.55) biome = 6;
    else if (sand > 0.5) biome = 5;
    else if (wet > 0.6 || (style === 'wetlands' && h < 6)) biome = 7;
    else if (moisture < 0.3) biome = 3;
    else if (moisture > 0.64) biome = 2;
    else biome = 1;

    S.temp = temp; S.moisture = moisture; S.snow = snow; S.biome = biome;
    return h;
  }

  // =======================================================================
  // STYLES — each returns the land height and fills S.rock/S.sand/S.cliff/S.ice
  // =======================================================================

  function mountains(x, y, z, X, Y, Z, lambda, oct, erosion, sharp) {
    // eroded ridged ranges; ~[0, 1]
    const fx = X / lambda + 31.7, fy = Y / lambda - 12.4, fz = Z / lambda + 7.1;
    return ridgedEroded(nM, fx, fy, fz, x, y, z, oct, 2.03, 0.5, erosion, sharp);
  }

  function coastShape(e, h, cliffMask, cliffH) {
    // sea cliffs: the land jumps up near the shoreline where cliffMask is high
    if (cliffMask <= 0 || e < -0.03) return h;
    const c = cliffH * smoothstep(0.0, 0.004, e) * cliffMask;
    S.cliff = Math.max(S.cliff, cliffMask * (1 - smoothstep(0.004, 0.02, Math.abs(e - 0.002))));
    return h + c;
  }

  function styleRolling(x, y, z, X, Y, Z, e, h, land, mReg) {
    S.rock = 0; S.sand = 0; S.cliff = 0; S.ice = 0;
    if (land <= 0) {
      S.sand = 0;
      return h + fbm(nH, X / 900, Y / 900, Z / 900, 3) * 18 * (1 - smoothstep(0.0, 0.2, -e));
    }
    // rolling hills: soft, rounded, multi-scale
    const wq = fbm(nW, X / 5200 + 3.1, Y / 5200, Z / 5200 - 2.2, 2) * 0.8;
    const hl = fbm(nH, X / 2300 + wq, Y / 2300 - wq, Z / 2300 + wq, 4, 2.0, 0.48);
    const hills = rel * 0.085 * (0.55 + 0.45 * hl) * (0.65 + 0.7 * mReg) * smoothstep(0.0, 0.12, e);
    // highlands & distant blue mountains
    const mm = smoothstep(0.42, 0.78, mReg + e * 0.35);
    let mnt = 0;
    if (mm > 0) {
      const r = mountains(x, y, z, X, Y, Z, 7800, 7, 1.6, 2.0);
      mnt = rel * 0.95 * mm * Math.pow(r, 1.35);
    }
    // tors / crags on hilltops (exposed rock)
    const tn = fbm(nS, X / 380 + 2.2, Y / 380, Z / 380 - 1.3, 3);
    const tor = smoothstep(0.42, 0.56, tn + hl * 0.25) * rel * 0.016 * smoothstep(0.03, 0.15, e);
    // sea cliffs in some regions
    const cm = smoothstep(0.52, 0.72, fbm(nS, x * 5 + 8.1, y * 5 - 2.4, z * 5 + 6.6, 2) * 0.5 + 0.5);
    let out = h + hills + mnt + tor;
    out = coastShape(e, out, cm, rel * 0.05);
    S.rock = clamp01(smoothstep(0.35, 0.8, mnt / (rel * 0.6)) + (tor > 0 ? smoothstep(0.42, 0.56, tn + hl * 0.25) * 0.85 : 0));
    // beaches
    if (out < 3.5 && out > -2) S.sand = Math.max(S.sand, (1 - smoothstep(1.2, 3.5, out)) * (1 - cm));
    return lerp(h, out, land);
  }

  function styleHighlands(x, y, z, X, Y, Z, e, h, land, mReg, plateau) {
    S.rock = 0; S.sand = 0; S.cliff = 0; S.ice = 0;
    if (land <= 0) return h;
    const k = smoothstep(0.0, 0.12, e);
    // macro-terraced plateaus separated by escarpments (Elden Ring / Ueda)
    const base = fbm(nH, X / 6500 + 4.4, Y / 6500 - 1.2, Z / 6500 + 0.3, 4, 2.0, 0.5) * 0.5 + 0.5;
    const step = plateau ? rel * 0.22 : rel * 0.14;
    const raw = rel * (plateau ? 0.85 : 0.6) * base * k;
    const tr = terrace(raw, step, plateau ? 0.82 : 0.7);
    const terr = lerp(raw, tr, smoothstep(0.25, 0.6, mReg + 0.2));
    const riser = Math.abs(tr - raw) / step; // close to step edges → cliffs
    // rolling texture on the treads
    const hl = fbm(nH, X / 1500, Y / 1500, Z / 1500, 4, 2.0, 0.47) * rel * 0.045 * k;
    // mountain spine
    const mm = smoothstep(0.55, 0.85, mReg + e * 0.2);
    let mnt = 0;
    if (mm > 0) mnt = rel * (plateau ? 0.7 : 1.05) * mm * Math.pow(mountains(x, y, z, X, Y, Z, 8600, 7, 1.4, 2.1), 1.4);
    // gorges
    const g = Math.abs(fbm(nS, X / 5200 + 9.1, Y / 5200, Z / 5200 - 3.3, 3));
    const gorge = (1 - smoothstep(0.0, 0.035, g)) * rel * 0.18 * k;
    let out = h + terr + hl + mnt - gorge;
    const cm = smoothstep(0.5, 0.7, fbm(nS, x * 4 + 1.1, y * 4 - 7.4, z * 4 + 3.6, 2) * 0.5 + 0.5);
    out = coastShape(e, out, cm, rel * 0.06);
    S.cliff = Math.max(S.cliff, smoothstep(0.25, 0.08, riser) * 0 + (1 - smoothstep(0.0, 0.025, g)) * 0.8 * k);
    S.rock = clamp01(smoothstep(0.4, 0.85, mnt / (rel * 0.6)));
    if (out < 3 && out > -2) S.sand = (1 - smoothstep(1, 3, out)) * (1 - cm);
    return lerp(h, out, land);
  }

  function styleDunes(x, y, z, X, Y, Z, e, h, mReg) {
    S.rock = 0; S.sand = 1; S.cliff = 0; S.ice = 0;
    // large-scale relief: basins (ergs) vs rocky uplands
    const up = smoothstep(0.08, 0.5, e * 0.8 + (mReg - 0.5) * 0.8);
    let base = rel * (0.06 + 0.2 * smoothstep(-0.4, 0.8, e));
    // rocky escarpments & wind-carved ridges (yardangs, elongated E-W)
    let rockH = -1e9;
    if (up > 0.001) {
      const r = mountains(x, y, z, X, Y * 3.0, Z, 9000, 6, 1.2, 1.6);
      const plateau = terrace(rel * 0.55 * (0.35 + 0.65 * r) * up, rel * 0.09, 0.75);
      rockH = base * 0.6 + plateau;
    }
    // ---- dunes ----
    const lat = Math.asin(clamp(y, -1, 1));
    const lon = Math.atan2(x, z);
    const latFade = 1 - smoothstep(0.65, 0.95, Math.abs(lat));
    const wA = fbm(nS, X / 4200 + 1.3, Y / 4200 - 2.1, Z / 4200 + 0.7, 3);
    const wB = fbm(nS, X / 1300 - 3.3, Y / 1300 + 4.4, Z / 1300 - 1.1, 2);
    const ph1 = lon * duneN / (2 * Math.PI) + wA * 2.2 + wB * 0.35;
    const f1 = ph1 - Math.floor(ph1);
    // asymmetric profile: long windward ramp, steep slip face, flat interdune corridor
    const fc = 0.8;
    let p1 = f1 < fc ? smoothstep(0.12, fc, f1) : 1 - smoothstep(fc, 1.0, f1) * 1.0;
    p1 = f1 < fc ? Math.pow(p1, 1.25) : Math.pow(Math.max(0, p1), 0.75);
    const latM = lat * R;
    const ph2 = lon * dune2N / (2 * Math.PI) + latM / dune2Lambda * 0.9 + wA * 1.1 + wB * 0.9;
    const f2 = ph2 - Math.floor(ph2);
    let p2 = f2 < 0.72 ? smoothstep(0.05, 0.72, f2) : 1 - smoothstep(0.72, 1.0, f2);
    p2 = p2 * p2;
    const ampN = fbm(nH, X / 6000 + 2.2, Y / 6000, Z / 6000 - 0.4, 3) * 0.5 + 0.5;
    const A1 = rel * 0.085 * (0.25 + 0.95 * ampN) * latFade;
    const A2 = rel * 0.026 * (0.4 + 0.8 * (1 - ampN)) * latFade;
    // small transverse dunelets
    const sm = fbm(nD, X / 95, Y / 340, Z / 95, 2);
    const dunes = A1 * p1 + A2 * p2 * (0.45 + 0.55 * p1) + (sm * 0.5 + 0.5) * 3.2 * latFade;
    const sandH = base + dunes + (1 - latFade) * fbm(nH, X / 900, Y / 900, Z / 900, 3) * 12;
    let out = sandH;
    if (rockH > -1e8) {
      out = smax(sandH, rockH, rel * 0.03);
      const exposed = smoothstep(-6, 10, rockH - sandH);
      S.rock = exposed; S.sand = 1 - exposed;
    }
    // salt pans / playas in deep basins
    return out;
  }

  function styleKarst(x, y, z, X, Y, Z, e, h, land, mReg) {
    S.rock = 0; S.sand = 0; S.cliff = 0; S.ice = 0;
    if (land <= 0 && e < -0.12) return h;
    const k = smoothstep(-0.05, 0.08, e);
    // alluvial plains (low, gently undulating, wet)
    const plain = fbm(nH, X / 1800, Y / 1800, Z / 1800, 3) * 9 + 6;
    let base = h * 0.35 + plain * k;
    // distant ink-wash mountain ranges
    const mm = smoothstep(0.5, 0.85, mReg + e * 0.3);
    let mnt = 0;
    if (mm > 0) mnt = rel * 0.9 * mm * Math.pow(mountains(x, y, z, X, Y, Z, 6800, 7, 1.3, 2.0), 1.25);
    // tower density field: clustered forests of pillars + open plains
    const dens = smoothstep(0.32, 0.62, fbm(nS, X / 7000 + 5.5, Y / 7000 - 2.2, Z / 7000 + 1.1, 3) * 0.5 + 0.5 + (mReg - 0.5) * 0.3);
    let towers = 0, towerRock = 0;
    if (dens > 0.001 && e > -0.1) {
      // irregular outlines
      const wob = fbm(nD, X / 70, Y / 70, Z / 70, 2) * 0.09;
      // big towers (fenglin)
      const big = cells(nK, X, Y, Z, 430, 11, (d, ra, rb, rc, acc) => {
        if (ra > 0.25 + 0.7 * dens) return acc; // empty cell
        const rad = 0.2 + 0.24 * rb; // in cells (< 0.5)
        const t = (d + wob * 0.6) / rad;
        if (t >= 1.0) return acc;
        const Ht = (150 + 330 * rc * rc) * (0.5 + 0.5 * dens);
        // dome top, near-vertical bulging walls, small talus apron
        const top = 1 - 0.32 * t * t;
        const wall = 1 - smoothstep(0.74, 0.97, t);
        const v = Ht * top * wall + Ht * 0.06 * (1 - smoothstep(0.85, 1.0, t));
        return smax(acc, v, 18);
      }, 0);
      // small towers / needles
      const small = cells(nK, X, Y, Z, 150, 23, (d, ra, rb, rc, acc) => {
        if (ra > 0.15 + 0.75 * dens) return acc;
        const rad = 0.16 + 0.26 * rb;
        const t = (d + wob) / rad;
        if (t >= 1.0) return acc;
        const Ht = (35 + 120 * rc) * (0.4 + 0.6 * dens);
        const v = Ht * (1 - 0.35 * t * t) * (1 - smoothstep(0.7, 0.96, t));
        return smax(acc, v, 8);
      }, 0);
      towers = smax(big, small, 10) * dens;
      towerRock = smoothstep(4, 30, towers);
    }
    let out = base + mnt + towers;
    S.rock = clamp01(towerRock * 0.9 + smoothstep(0.4, 0.85, mnt / (rel * 0.6)));
    S.cliff = towerRock;
    if (out < 2.5 && out > -2) S.sand = (1 - smoothstep(0.8, 2.5, out)) * 0.6;
    return lerp(h, out, smoothstep(-0.12, 0.0, e));
  }

  function styleGlacial(x, y, z, X, Y, Z, e, h, land, mReg) {
    S.rock = 0; S.sand = 0; S.cliff = 0; S.ice = 0;
    if (land <= 0 && e < -0.15) return h;
    const k = smoothstep(-0.02, 0.1, e);
    // sharp alpine relief: horns, arêtes
    const mm = smoothstep(0.2, 0.6, mReg + e * 0.5);
    const r = mountains(x, y, z, X, Y, Z, 6200, 8, 0.9, 2.6);
    let mnt = rel * 1.05 * mm * Math.pow(r, 1.15) * k;
    const hills = fbm(nH, X / 2000, Y / 2000, Z / 2000, 4) * rel * 0.05 * k;
    // U-shaped glacial valleys (fjords where they reach the sea)
    const wq = fbm(nW, X / 9000, Y / 9000, Z / 9000, 2) * 0.7;
    const vn = Math.abs(fbm(nR, X / 7600 + wq, Y / 7600 - wq, Z / 7600 + wq, 3, 2.0, 0.45));
    const U = smootherstep(0.02, 0.09, vn);
    let out = h + hills + mnt;
    const floorH = Math.min(out, h * 0.3 - 40 * (1 - k) - 12);
    out = lerp(floorH, out, Math.pow(U, 0.9));
    // ice sheets / plateau ice caps bury lower relief, nunataks poke through
    const lat = Math.abs(y);
    const iceLevel = rel * (0.18 + 0.22 * (fbm(nS, x * 3 + 2, y * 3, z * 3 - 1, 3) * 0.5 + 0.5)) * smoothstep(0.35, 0.8, lat + mReg * 0.25);
    if (iceLevel > 1) {
      const capped = smax(out, iceLevel + fbm(nD, X / 800, Y / 800, Z / 800, 2) * 6, rel * 0.03);
      S.ice = smoothstep(-4, 10, iceLevel - out + 6);
      out = capped;
    }
    // glacier tongues in valley floors
    S.ice = Math.max(S.ice, (1 - U) * smoothstep(-20, 60, out) * 0.9);
    S.rock = clamp01(smoothstep(0.2, 0.6, mnt / (rel * 0.6)) * (1 - S.ice * 0.7));
    S.cliff = clamp01((U - Math.pow(U, 3)) * 1.6 * (1 - S.ice));
    return lerp(h, out, smoothstep(-0.15, 0.0, e));
  }

  function styleMesas(x, y, z, X, Y, Z, e, h, land, mReg) {
    S.rock = 0; S.sand = 0; S.cliff = 0; S.ice = 0;
    if (land <= 0) return h;
    const k = smoothstep(0.0, 0.08, e);
    const wq = fbm(nW, X / 3000, Y / 3000, Z / 3000, 3) * 0.55;
    const m = fbm(nS, X / 4200 + wq, Y / 4200 - wq, Z / 4200 + wq, 5, 2.0, 0.55) * 0.5 + 0.5 + (mReg - 0.5) * 0.35;
    const tiers = [0.5, 0.62, 0.74];
    let mesa = 0, edge = 0;
    for (let i = 0; i < 3; i++) {
      const s = smoothstep(tiers[i], tiers[i] + 0.012, m);
      mesa += s * rel * (i === 0 ? 0.22 : 0.14);
      edge = Math.max(edge, 1 - Math.abs(s - 0.5) * 2);
    }
    // talus slopes at the base
    const talus = smoothstep(0.38, 0.5, m) * rel * 0.05;
    const floor = fbm(nH, X / 1800, Y / 1800, Z / 1800, 3) * rel * 0.02;
    const strata = terrace(mesa, rel * 0.02, 0.6) - mesa;
    let out = h + floor + talus + (mesa + strata * 0.6) * k;
    S.cliff = edge * k; S.rock = clamp01(edge * 1.2 + smoothstep(0.45, 0.55, m) * 0.4);
    S.sand = clamp01((1 - smoothstep(0.35, 0.48, m)) * 0.7);
    return lerp(h, out, land);
  }

  function styleCanyons(x, y, z, X, Y, Z, e, h, land, mReg) {
    S.rock = 0; S.sand = 0; S.cliff = 0; S.ice = 0;
    if (land <= 0) return h;
    const k = smoothstep(0.0, 0.1, e);
    const plateau = rel * 0.45 * k * (0.7 + 0.3 * mReg) + fbm(nH, X / 2500, Y / 2500, Z / 2500, 3) * rel * 0.03;
    const wq = fbm(nW, X / 6000, Y / 6000, Z / 6000, 2) * 0.9;
    const c1 = Math.abs(fbm(nS, X / 9000 + wq, Y / 9000 - wq, Z / 9000 + wq, 4, 2.0, 0.5));
    const c2 = Math.abs(fbm(nS, X / 2600 - wq, Y / 2600 + wq, Z / 2600, 3, 2.0, 0.5));
    const deep = 1 - smoothstep(0.0, 0.07, c1);
    const side = (1 - smoothstep(0.0, 0.05, c2)) * smoothstep(0.02, 0.2, c1) * 0.55;
    const cut = Math.max(deep, side);
    const depth = terrace(plateau * cut * 0.92, rel * 0.045, 0.78);
    const out = h + plateau - depth;
    S.cliff = clamp01((deep - deep * deep) * 4 + (side - side * side) * 3);
    S.rock = clamp01(S.cliff + cut * 0.4);
    S.sand = clamp01(deep * 0.6);
    return lerp(h, out, land);
  }

  function styleBadlands(x, y, z, X, Y, Z, e, h, land, mReg) {
    S.rock = 0; S.sand = 0; S.cliff = 0; S.ice = 0;
    if (land <= 0) return h;
    const k = smoothstep(0.0, 0.1, e);
    const b = mountains(x, y, z, X, Y, Z, 2600, 6, 2.2, 2.0);
    const g = mountains(x, y, z, X * 1.0, Y, Z, 700, 5, 1.0, 1.4);
    let out = rel * 0.25 * k * (0.4 + 0.6 * mReg) + rel * 0.35 * b * k + rel * 0.05 * g * k;
    out = lerp(out, terrace(out, rel * 0.03, 0.55), 0.65);
    // hoodoos
    const hood = cells(nK, X, Y, Z, 60, 41, (d, ra, rb, rc, acc) => {
      if (ra > 0.35) return acc;
      const t = d / (0.12 + 0.12 * rb);
      if (t >= 1) return acc;
      return Math.max(acc, (8 + 16 * rc) * (1 - smoothstep(0.6, 1.0, t)));
    }, 0) * smoothstep(0.55, 0.75, mReg);
    S.rock = clamp01(b * 1.2 + smoothstep(2, 8, hood));
    S.cliff = clamp01(smoothstep(2, 8, hood));
    return lerp(h, h + out + hood * k, land);
  }

  function styleCraters(x, y, z, X, Y, Z, e, h, land, mReg) {
    S.rock = 0; S.sand = 0; S.cliff = 0; S.ice = 0;
    // highlands vs maria
    const hl = fbm(nH, X / 5000, Y / 5000, Z / 5000, 5) * rel * 0.12;
    let out = h * 0.4 + hl;
    const crater = (size, salt, depthK, density) => cells(nK, X, Y, Z, size, salt, (d, ra, rb, rc, acc) => {
      if (ra > density) return acc;
      const r = 0.12 + 0.3 * rb; // radius in cells
      const t = d / r;
      if (t > 1.6) return acc;
      const D = size * r * depthK; // depth ∝ diameter
      // bowl + raised rim + ejecta blanket
      const bowl = t < 1 ? (t * t - 1) * D : 0;
      const rim = D * 0.35 * Math.exp(-((t - 1) * (t - 1)) / 0.02);
      const ejecta = t > 1 ? D * 0.12 * Math.max(0, 1.6 - t) / 0.6 : 0;
      const peak = size > 1000 && t < 0.25 ? D * 0.5 * (1 - t / 0.25) : 0;
      return acc + bowl + rim + ejecta + peak;
    }, 0);
    out += crater(9000, 51, 0.16, 0.5) + crater(2600, 57, 0.18, 0.6) + crater(700, 63, 0.2, 0.7) + crater(160, 69, 0.2, 0.75);
    S.rock = clamp01(smoothstep(0.1, 0.5, Math.abs(out - h * 0.4 - hl) / 120));
    return out;
  }

  function styleVolcanic(x, y, z, X, Y, Z, e, h, land, mReg) {
    S.rock = 1; S.sand = 0; S.cliff = 0; S.ice = 0;
    const k = smoothstep(-0.02, 0.08, e);
    const cones = cells(nK, X, Y, Z, 9000, 81, (d, ra, rb, rc, acc) => {
      if (ra > 0.55) return acc;
      const r = 0.28 + 0.2 * rb;
      const t = d / r;
      if (t >= 1) return acc;
      const H = rel * (0.5 + 0.9 * rc);
      let v = H * Math.pow(1 - t, 1.6);
      const cal = 0.1 + 0.05 * ra;
      if (t < cal) v = lerp(H * Math.pow(1 - cal, 1.6) - H * 0.12, v, t / cal * 0.0); // caldera floor
      return smax(acc, v, 60);
    }, 0);
    const flows = mountains(x, y, z, X, Y, Z, 1800, 6, 0.6, 1.2);
    const aa = fbm(nD, X / 40, Y / 40, Z / 40, 3) * 2.5;
    const out = h * 0.6 + (cones + rel * 0.12 * flows + aa) * k;
    S.rock = 1;
    S.cliff = clamp01(smoothstep(0.3, 0.6, flows));
    return lerp(h, out, smoothstep(-0.1, 0.02, e));
  }

  function styleWetlands(x, y, z, X, Y, Z, e, h, land, mReg) {
    S.rock = 0; S.sand = 0; S.cliff = 0; S.ice = 0;
    const k = smoothstep(-0.03, 0.08, e);
    const hum = fbm(nH, X / 600, Y / 600, Z / 600, 4, 2.0, 0.5);
    const low = fbm(nS, X / 2400, Y / 2400, Z / 2400, 3);
    let out = h * 0.35 + (hum * 7 + low * 16 + 6) * k;
    const mm = smoothstep(0.6, 0.9, mReg + e * 0.2);
    if (mm > 0) out += rel * 0.6 * mm * Math.pow(mountains(x, y, z, X, Y, Z, 7000, 6, 1.5, 1.6), 1.6);
    S.rock = clamp01(mm * 0.6);
    return lerp(h, out, smoothstep(-0.1, 0.02, e));
  }

  function styleArchipelago(x, y, z, X, Y, Z, e, h, land, mReg) {
    S.rock = 0; S.sand = 0; S.cliff = 0; S.ice = 0;
    // vast shallow seas with volcanic islands and reefs
    const shallow = -6 - 30 * smoothstep(0.0, 0.5, -e);
    let out = e < 0 ? lerp(h, shallow, 1 - smoothstep(0.25, 0.6, -e)) : h;
    const isl = cells(nK, X, Y, Z, 5200, 91, (d, ra, rb, rc, acc) => {
      if (ra > 0.45) return acc;
      const t = d / (0.15 + 0.3 * rb);
      if (t >= 1) return acc;
      return smax(acc, rel * (0.08 + 0.4 * rc * rc) * Math.pow(1 - t, 1.8), 30);
    }, -1e9);
    if (isl > -1e8) out = smax(out, isl + shallow * 0.5, 25);
    if (e > 0) out += rel * 0.15 * Math.pow(mountains(x, y, z, X, Y, Z, 5000, 6, 1.5, 1.8), 1.3) * smoothstep(0.0, 0.2, e);
    S.rock = clamp01(smoothstep(rel * 0.08, rel * 0.25, out));
    if (out < 3 && out > -2) S.sand = 1 - smoothstep(1, 3, out);
    return out;
  }

  function styleBlobby(x, y, z, X, Y, Z, e, h, land, mReg) {
    S.rock = 0; S.sand = 0; S.cliff = 0; S.ice = 0;
    const k = smoothstep(-0.02, 0.1, e);
    const bulb = (size, salt, hk) => cells(nK, X, Y, Z, size, salt, (d, ra, rb, rc, acc) => {
      if (ra > 0.7) return acc;
      const r = 0.2 + 0.25 * rb, t = d / r;
      if (t >= 1) return acc;
      return smax(acc, size * hk * (0.4 + 0.8 * rc) * Math.sqrt(1 - t * t), size * 0.06);
    }, 0);
    const out = h + (bulb(1800, 101, 0.22) + bulb(520, 107, 0.3) + bulb(140, 113, 0.25)) * k + fbm(nH, X / 3000, Y / 3000, Z / 3000, 3) * rel * 0.06 * k;
    S.rock = 0.2;
    return lerp(h, out, smoothstep(-0.1, 0.02, e));
  }

  // ---- public API -----------------------------------------------------------
  function height(x, y, z) { return evaluate(x, y, z, false); }
  function sample(x, y, z) {
    evaluate(x, y, z, true);
    return { h: S.h, moisture: S.moisture, temp: S.temp, rock: S.rock, biome: S.biome, snow: S.snow, sand: S.sand, river: S.river, wet: S.wet, cliff: S.cliff };
  }

  return {
    params: p, radius: R, relief: rel, style,
    seaLevel: hasOcean ? 0 : -Infinity,
    height, sample,
    /** Fast path for workers: fills and returns the shared state object (do not keep). */
    evaluate(x, y, z, full = true) { evaluate(x, y, z, full); return S; },
    state: S,
  };
}
