// Flora scatter — deterministic, seamless cell grids on the sphere.
//
// Cells live on an equi-angular cube-sphere: direction → (face, a, b) with
// a, b ∈ [-1, 1] and near-uniform cell sizes (≤ ~1.3× distortion). A cell
// (face, i, j) at a grid resolution N is identified by an integer key and
// seeds its own RNG from (planet seed, layer, face, i, j) — the same cell
// always grows the same plants, wherever the player comes from.
//
//   cubeCoords(dir)            → { face, a, b }
//   faceDir(face, a, b, out)   → unit direction (equi-angular inverse)
//   cellsAround(focusDir, R, cellSize, radius, fn)  → fn(face, i, j, N, distMeters)
//   cellRng(seed, layer, face, i, j)  → fast mulberry32 generator
//   valueNoise2(x, y, seed)    → smooth value noise in [-1, 1] (cheap, CPU)

const QP = Math.PI / 4;
const FACES = [
  // [axis, sign] → face normal; (u, v) tangents chosen so each face is right-handed
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

/** Gnomonic projection of dir onto face f (may lie outside [-1,1]); returns null if behind. */
export function projectToFace(f, x, y, z, out) {
  const F = FACES[f];
  const dn = x * F.n[0] + y * F.n[1] + z * F.n[2];
  if (dn <= 1e-4) return null;
  const u = (x * F.u[0] + y * F.u[1] + z * F.u[2]) / dn;
  const v = (x * F.v[0] + y * F.v[1] + z * F.v[2]) / dn;
  out.a = Math.atan(u) / QP; out.b = Math.atan(v) / QP; out.face = f;
  return out;
}

export function cubeCoords(x, y, z, out = {}) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let f;
  if (ax >= ay && ax >= az) f = x > 0 ? 0 : 1;
  else if (ay >= az) f = y > 0 ? 2 : 3;
  else f = z > 0 ? 4 : 5;
  return projectToFace(f, x, y, z, out);
}

/** Equi-angular (a, b) on face → unit direction written into out (array or Vector3-like). */
export function faceDir(f, a, b, out) {
  const F = FACES[f];
  const u = Math.tan(a * QP), v = Math.tan(b * QP);
  let x = F.n[0] + F.u[0] * u + F.v[0] * v;
  let y = F.n[1] + F.u[1] * u + F.v[1] * v;
  let z = F.n[2] + F.u[2] * u + F.v[2] * v;
  const l = 1 / Math.sqrt(x * x + y * y + z * z);
  x *= l; y *= l; z *= l;
  if (out.isVector3) out.set(x, y, z); else { out[0] = x; out[1] = y; out[2] = z; }
  return out;
}

/** Grid resolution (cells per face edge) for a target cell size in meters. */
export function gridN(R, cellSize) { return Math.max(1, Math.round((Math.PI * 0.5 * R) / cellSize)); }

export function cellKey(face, i, j, N) { return (face * N + i) * N + j; }

const _p = { a: 0, b: 0, face: 0 };
const _d = [0, 0, 0];
/**
 * Visit every cell (face, i, j) of grid N whose center lies within `radius`
 * meters (+ half a cell diagonal) of the focus direction. fn(face, i, j, dist).
 */
export function cellsAround(fx, fy, fz, R, N, radius, fn) {
  const cellM = (Math.PI * 0.5 * R) / N;
  const reach = radius + cellM * 0.75;
  const ang = reach / R;
  const cosLim = Math.cos(Math.min(Math.PI, ang + QP * 1.42)); // faces we can possibly touch
  const da = (ang / QP) * 1.45 + 2 / N; // generous in face units (distortion)
  for (let f = 0; f < 6; f++) {
    const F = FACES[f];
    const dn = fx * F.n[0] + fy * F.n[1] + fz * F.n[2];
    if (dn < cosLim || dn <= 0.05) continue;
    if (!projectToFace(f, fx, fy, fz, _p)) continue;
    const i0 = Math.max(0, Math.floor(((_p.a - da) * 0.5 + 0.5) * N)), i1 = Math.min(N - 1, Math.floor(((_p.a + da) * 0.5 + 0.5) * N));
    const j0 = Math.max(0, Math.floor(((_p.b - da) * 0.5 + 0.5) * N)), j1 = Math.min(N - 1, Math.floor(((_p.b + da) * 0.5 + 0.5) * N));
    for (let i = i0; i <= i1; i++) {
      const a = ((i + 0.5) / N) * 2 - 1;
      for (let j = j0; j <= j1; j++) {
        const b = ((j + 0.5) / N) * 2 - 1;
        faceDir(f, a, b, _d);
        const c = _d[0] * fx + _d[1] * fy + _d[2] * fz;
        const dist = Math.acos(Math.min(1, c)) * R;
        if (dist <= reach) fn(f, i, j, dist);
      }
    }
  }
}

/** mulberry32 seeded from integer hashes — fast, good enough for scatter. */
export function cellRng(seed, layer, face, i, j) {
  let h = (seed ^ Math.imul(layer + 0x9e37, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (face * 0x27d4eb2d + i), 0xcc9e2d51); h ^= h >>> 15;
  h = Math.imul(h ^ (j * 0x165667b1 + 0x61c88647), 0x1b873593); h ^= h >>> 13;
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function h2(x, y, seed) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** Smooth 2D value noise in [-1, 1]. */
export function valueNoise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = h2(xi, yi, seed), b = h2(xi + 1, yi, seed), c = h2(xi, yi + 1, seed), d = h2(xi + 1, yi + 1, seed);
  return ((a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy) * 2 - 1;
}
/** 3-octave value fbm in [-1, 1]. */
export function valueFbm2(x, y, seed = 0) {
  return (valueNoise2(x, y, seed) * 0.57 + valueNoise2(x * 2.03 + 7.1, y * 2.03 - 3.3, seed + 17) * 0.29 + valueNoise2(x * 4.1 - 1.7, y * 4.1 + 9.2, seed + 31) * 0.14);
}

/** Smooth 3D value noise in [-1, 1] on world positions (for continent-scale masks). */
export function valueNoise3(x, y, z, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let fx = x - xi, fy = y - yi, fz = z - zi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const s0 = seed + Math.imul(zi, 0x3c6ef372), s1 = seed + Math.imul(zi + 1, 0x3c6ef372);
  const l0 = (h2(xi, yi, s0) * (1 - fx) + h2(xi + 1, yi, s0) * fx) * (1 - fy) + (h2(xi, yi + 1, s0) * (1 - fx) + h2(xi + 1, yi + 1, s0) * fx) * fy;
  const l1 = (h2(xi, yi, s1) * (1 - fx) + h2(xi + 1, yi, s1) * fx) * (1 - fy) + (h2(xi, yi + 1, s1) * (1 - fx) + h2(xi + 1, yi + 1, s1) * fx) * fy;
  return (l0 + (l1 - l0) * fz) * 2 - 1;
}
export function valueFbm3(x, y, z, seed = 0) {
  return valueNoise3(x, y, z, seed) * 0.55 + valueNoise3(x * 2.1 + 3.1, y * 2.1 - 1.3, z * 2.1 + 7.7, seed + 13) * 0.3 + valueNoise3(x * 4.3 - 5.1, y * 4.3 + 2.9, z * 4.3 - 0.7, seed + 29) * 0.15;
}
