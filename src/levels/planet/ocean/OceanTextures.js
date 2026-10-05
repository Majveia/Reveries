// Procedural, perfectly tiling textures for the ocean (no external assets).
//
//   detailTexture()  RGBA8 256²: R,G = slopes (dh/dx, dh/dy) of a band-limited
//                    capillary/ripple height field (sum of integer-frequency
//                    sines → exact tiling), B = lacy foam pattern (cellular
//                    bubbles), A = low-frequency value noise (foam breakup,
//                    flow warp).
//   plateTexture()   RGBA8 512²: periodic Voronoi for lava crust plates —
//                    R = edge distance (F2−F1), G = cell id, B = F1 (plate dome),
//                    A = fine crack noise.
import * as THREE from 'three';
import { Random } from '../../../core/Random.js';

function finish(tex) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Periodic value noise on an n×n lattice, sampled at u,v ∈ [0,1). */
function makeValueNoise(rng, n) {
  const g = new Float32Array(n * n);
  for (let i = 0; i < g.length; i++) g[i] = rng.float();
  return (u, v) => {
    const x = u * n, y = v * n;
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % n) + n) % n, y0 = ((yi % n) + n) % n, x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
    const a = g[y0 * n + x0], b = g[y0 * n + x1], c = g[y1 * n + x0], d = g[y1 * n + x1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

/** Periodic Worley (F1, F2, id) with an m×m jittered grid of feature points. */
function makeWorley(rng, m, jitter = 0.9) {
  const px = new Float32Array(m * m), py = new Float32Array(m * m), id = new Float32Array(m * m);
  for (let i = 0; i < m * m; i++) { px[i] = 0.5 + (rng.float() - 0.5) * jitter; py[i] = 0.5 + (rng.float() - 0.5) * jitter; id[i] = rng.float(); }
  const out = { f1: 0, f2: 0, id: 0 };
  return (u, v) => {
    const x = u * m, y = v * m;
    const xi = Math.floor(x), yi = Math.floor(y);
    let f1 = 1e9, f2 = 1e9, cid = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const wx = ((cx % m) + m) % m, wy = ((cy % m) + m) % m;
      const k = wy * m + wx;
      const ddx = cx + px[k] - x, ddy = cy + py[k] - y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < f1) { f2 = f1; f1 = d; cid = id[k]; } else if (d < f2) f2 = d;
    }
    out.f1 = f1; out.f2 = f2; out.id = cid;
    return out;
  };
}

export function detailTexture(seed = 1) {
  const N = 256;
  const rng = new Random(seed >>> 0 || 7);
  // Ripple spectrum: integer wave vectors (exact tiling), mildly anisotropic
  // along +x (the shader rotates into the wind), amplitude ∝ |k|^-1.6.
  const waves = [];
  for (let i = 0; i < 48; i++) {
    const kmag = 3 + Math.pow(rng.float(), 1.6) * 34;
    const ang = (rng.float() - 0.5) * Math.PI * (rng.float() < 0.7 ? 0.9 : 2.0);
    const kx = Math.round(Math.cos(ang) * kmag), ky = Math.round(Math.sin(ang) * kmag);
    if (kx === 0 && ky === 0) continue;
    const km = Math.hypot(kx, ky);
    waves.push({ kx, ky, a: Math.pow(km, -1.6), ph: rng.float() * Math.PI * 2 });
  }
  const sx = new Float32Array(N * N), sy = new Float32Array(N * N);
  let smax = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let gx = 0, gy = 0;
    const u = (x / N) * Math.PI * 2, v = (y / N) * Math.PI * 2;
    for (const w of waves) {
      const c = Math.cos(w.kx * u + w.ky * v + w.ph) * w.a;
      gx += c * w.kx; gy += c * w.ky;
    }
    sx[y * N + x] = gx; sy[y * N + x] = gy;
    smax = Math.max(smax, Math.abs(gx), Math.abs(gy));
  }
  const vn = makeValueNoise(rng, 8), vn2 = makeValueNoise(rng, 32);
  const wo = makeWorley(rng, 24, 1.0), wo2 = makeWorley(rng, 64, 1.0);
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, u = x / N, v = y / N;
    const o = i * 4;
    data[o] = Math.round((0.5 + 0.5 * sx[i] / smax) * 255);
    data[o + 1] = Math.round((0.5 + 0.5 * sy[i] / smax) * 255);
    // Foam: bubbly cellular lace — bright on cell walls, holes in cell centres.
    const a = wo(u, v); const e1 = a.f2 - a.f1;
    const b = wo2(u, v); const e2 = b.f2 - b.f1;
    let foam = Math.exp(-e1 * 9.0) * 0.75 + Math.exp(-e2 * 7.0) * 0.55;
    foam *= 0.55 + 0.9 * vn2(u, v);
    data[o + 2] = Math.round(Math.min(1, foam) * 255);
    data[o + 3] = Math.round((vn(u, v) * 0.7 + vn2(u, v) * 0.3) * 255);
  }
  return finish(new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType));
}

export function plateTexture(seed = 3) {
  const N = 512;
  const rng = new Random(seed >>> 0 || 11);
  const wo = makeWorley(rng, 14, 0.85), wf = makeWorley(rng, 56, 1.0);
  const vn = makeValueNoise(rng, 16);
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N;
    // domain warp so plates are irregular polygons, not tidy cells
    const wu = u + (vn(u, v) - 0.5) * 0.035, wv = v + (vn(v + 0.37, u + 0.71) - 0.5) * 0.035;
    const a = wo(wu, wv);
    const edge = a.f2 - a.f1;
    const f = wf(u, v);
    const o = (y * N + x) * 4;
    data[o] = Math.round(Math.min(1, edge * 1.6) * 255);
    data[o + 1] = Math.round(a.id * 255);
    data[o + 2] = Math.round(Math.min(1, a.f1 * 1.25) * 255);
    data[o + 3] = Math.round(Math.min(1, (f.f2 - f.f1) * 2.2) * 255);
  }
  return finish(new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType));
}
