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
  return out;
}
