// Pure height-map baking shared by the worker and the main thread (shot mode /
// worker fallback). T = createTerrain(...) height field on unit directions.

/** Equirect map: u = lon (atan2(x, z)) , v = lat (asin y). Values: h − sea (m). */
export function bakeGlobal(T, sea, w, h) {
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const lat = ((j + 0.5) / h - 0.5) * Math.PI;
    const cl = Math.cos(lat), y = Math.sin(lat);
    for (let i = 0; i < w; i++) {
      const lon = ((i + 0.5) / w) * Math.PI * 2 - Math.PI;
      out[j * w + i] = T.height(Math.sin(lon) * cl, y, Math.cos(lon) * cl) - sea;
    }
  }
  return out;
}

/**
 * Local map on the anchor tangent plane: texel (i, j) ↔ plane coords
 * x = cx + ((i + .5)/n − .5)·2·extent, z likewise; the point on the sea sphere
 * is P = A + T1·x + T2·z + U·y with |P| = Rs.
 */
export function bakeLocal(T, sea, m) {
  const { n, A, T1, T2, U, Rs, cx, cz, extent } = m;
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = cz + ((j + 0.5) / n - 0.5) * 2 * extent;
    for (let i = 0; i < n; i++) {
      const x = cx + ((i + 0.5) / n - 0.5) * 2 * extent;
      const yy = Math.sqrt(Math.max(0, Rs * Rs - x * x - z * z)) - Rs;
      const px = A[0] + T1[0] * x + T2[0] * z + U[0] * yy;
      const py = A[1] + T1[1] * x + T2[1] * z + U[1] * yy;
      const pz = A[2] + T1[2] * x + T2[2] * z + U[2] * yy;
      const l = Math.hypot(px, py, pz);
      out[j * n + i] = T.height(px / l, py / l, pz / l) - sea;
    }
  }
  return withShoreDistance(out, n, (2 * extent) / n);
}

/**
 * Interleave [height, signed distance to the shoreline (m, + over water)] —
 * the coordinate the surf rolls along. Two-pass chamfer (3-4) distance
 * transform with a sub-texel seed at the shoreline, then a light blur so the
 * breaker crests follow smoothed (refracted) contours instead of octagons.
 */
export function withShoreDistance(h, n, cell) {
  const N = n * n, INF = 1e9;
  const d = new Float32Array(N);
  // seed: texels touching the opposite side get the interpolated zero crossing
  const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, a = h[k], wet = a < 0;
    let best = INF;
    for (const [di, dj] of nb) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const b = h[jj * n + ii];
      if ((b < 0) !== wet) best = Math.min(best, Math.abs(a) / Math.max(Math.abs(a - b), 1e-4));
    }
    d[k] = best < INF ? best : INF;
  }
  const W1 = 1, W2 = Math.SQRT2;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i; let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + W1);
    if (j > 0) { v = Math.min(v, d[k - n] + W1); if (i > 0) v = Math.min(v, d[k - n - 1] + W2); if (i < n - 1) v = Math.min(v, d[k - n + 1] + W2); }
    d[k] = v;
  }
  for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) {
    const k = j * n + i; let v = d[k];
    if (i < n - 1) v = Math.min(v, d[k + 1] + W1);
    if (j < n - 1) { v = Math.min(v, d[k + n] + W1); if (i < n - 1) v = Math.min(v, d[k + n + 1] + W2); if (i > 0) v = Math.min(v, d[k + n - 1] + W2); }
    d[k] = v;
  }
  // no shoreline in the window: far from any coast
  for (let k = 0; k < N; k++) { if (d[k] > 1e8) d[k] = 4 * n; if (h[k] >= 0) d[k] = -d[k]; }
  // separable 5-tap blur (twice)
  const tmp = new Float32Array(N);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      let s = 0, w = 0;
      for (let o = -2; o <= 2; o++) { const ii = Math.min(n - 1, Math.max(0, i + o)); const ww = 3 - Math.abs(o); s += d[j * n + ii] * ww; w += ww; }
      tmp[j * n + i] = s / w;
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      let s = 0, w = 0;
      for (let o = -2; o <= 2; o++) { const jj = Math.min(n - 1, Math.max(0, j + o)); const ww = 3 - Math.abs(o); s += tmp[jj * n + i] * ww; w += ww; }
      d[j * n + i] = s / w;
    }
  }
  const out = new Float32Array(N * 2);
  for (let k = 0; k < N; k++) { out[k * 2] = h[k]; out[k * 2 + 1] = d[k] * cell; }
  return out;
}
