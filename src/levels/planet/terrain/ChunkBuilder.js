// Cube-sphere chunk geometry builder — PURE + WORKER-SAFE.
//
// A chunk is one quadtree node on one of the 6 cube faces: an (N+1)² vertex
// grid (tangent-warped cube → sphere mapping for near-uniform cells) plus a
// skirt ring. Produced per vertex:
//   position  float32×3  relative to the chunk origin (precision: no 50 km offsets on the GPU)
//   aMorph    float32×3  delta to the parent-grid position (CDLOD geomorph target)
//   aNrm      int8×4     surface normal (xyz) + level/127 (w)
//   aNrm2     int8×4     parent-grid normal (morph target)
//   aMatA     uint8×4    moisture, temperature, rock, snow
//   aMatB     uint8×4    sand, wet/river, cavity (concavity → AO), cliff/strata
//   aHgt      float32    height above base radius (m) — strata, shoreline, snow line
// Shared index buffer (same topology for every chunk): buildIndex(N).

export const FACES = [
  // normal       u axis        v axis      (u × v = normal)
  [1, 0, 0, 0, 0, -1, 0, 1, 0],
  [-1, 0, 0, 0, 0, 1, 0, 1, 0],
  [0, 1, 0, 1, 0, 0, 0, 0, -1],
  [0, -1, 0, 1, 0, 0, 0, 0, 1],
  [0, 0, 1, 1, 0, 0, 0, 1, 0],
  [0, 0, -1, -1, 0, 0, 0, 1, 0],
];
const QP = Math.PI / 4;

/** Face coordinates (a, b) ∈ [-1, 1] → unit direction (tangent warp ≈ equal-area cells). */
export function faceDir(face, a, b, out) {
  const F = FACES[face];
  const ta = a === 1 ? 1 : a === -1 ? -1 : Math.tan(a * QP);
  const tb = b === 1 ? 1 : b === -1 ? -1 : Math.tan(b * QP);
  const x = F[0] + ta * F[3] + tb * F[6], y = F[1] + ta * F[4] + tb * F[7], z = F[2] + ta * F[5] + tb * F[8];
  const l = Math.sqrt(x * x + y * y + z * z);
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

/** Unit direction → { face, a, b } (inverse of faceDir). */
export function dirToFace(x, y, z, out = {}) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let face;
  if (ax >= ay && ax >= az) face = x > 0 ? 0 : 1;
  else if (ay >= az) face = y > 0 ? 2 : 3;
  else face = z > 0 ? 4 : 5;
  const F = FACES[face];
  const dn = x * F[0] + y * F[1] + z * F[2];
  const u = (x * F[3] + y * F[4] + z * F[5]) / dn, v = (x * F[6] + y * F[7] + z * F[8]) / dn;
  out.face = face; out.a = Math.atan(u) / QP; out.b = Math.atan(v) / QP;
  return out;
}

export function vertexCount(N) { return (N + 1) * (N + 1) + 4 * (N + 1); }

/** Shared index buffer: grid (diagonal a→d, CCW from outside) + outward-facing skirts. */
export function buildIndex(N) {
  const V = N + 1;
  const idx = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
    idx.push(a, b, d, a, d, c);
  }
  const base = V * V;
  // skirt vertex for boundary vertex k on edge e: base + e*V + k
  // edge 0: j=0 (i=k)  edge 1: j=N (i=k)  edge 2: i=0 (j=k)  edge 3: i=N (j=k)
  for (let k = 0; k < N; k++) {
    // edge 0 (outward -v)
    { const B0 = k, B1 = k + 1, S0 = base + k, S1 = base + k + 1; idx.push(B0, S0, B1, B1, S0, S1); }
    // edge 1 (outward +v)
    { const B0 = N * V + k, B1 = B0 + 1, S0 = base + V + k, S1 = S0 + 1; idx.push(B0, B1, S0, B1, S1, S0); }
    // edge 2 (outward -u)
    { const B0 = k * V, B1 = (k + 1) * V, S0 = base + 2 * V + k, S1 = S0 + 1; idx.push(B0, B1, S0, B1, S1, S0); }
    // edge 3 (outward +u)
    { const B0 = k * V + N, B1 = (k + 1) * V + N, S0 = base + 3 * V + k, S1 = S0 + 1; idx.push(B0, S0, B1, B1, S0, S1); }
  }
  return new Uint16Array(idx);
}

const q8 = (v) => { const x = Math.round(v * 127); return x < -127 ? -127 : x > 127 ? 127 : x; };
const u8 = (v) => { const x = Math.round(v * 255); return x < 0 ? 0 : x > 255 ? 255 : x; };

/**
 * Build one chunk.
 * job = { face, level, ix, iy, N, radius }
 * T   = createTerrain(...) instance (uses T.evaluate for attributes)
 */
export function buildChunk(T, job) {
  const { face, level, ix, iy, N } = job;
  const R = job.radius;
  const V = N + 1, G = N + 3; // grid with 1-vertex border
  const total = N << level;
  const dir = [0, 0, 0];

  // ---- sample the bordered grid (float64) ----
  const PX = new Float64Array(G * G), PY = new Float64Array(G * G), PZ = new Float64Array(G * G);
  const H = new Float64Array(G * G);
  const DX = new Float64Array(G * G), DY = new Float64Array(G * G), DZ = new Float64Array(G * G);
  const matA = new Uint8Array(V * V * 4 + 4 * V * 4), matB = new Uint8Array(V * V * 4 + 4 * V * 4);
  let minH = Infinity, maxH = -Infinity;
  for (let j = -1; j <= N + 1; j++) {
    const b = -1 + (2 * (iy * N + j)) / total;
    for (let i = -1; i <= N + 1; i++) {
      const a = -1 + (2 * (ix * N + i)) / total;
      faceDir(face, a, b, dir);
      const g = (j + 1) * G + (i + 1);
      const inner = i >= 0 && i <= N && j >= 0 && j <= N;
      const S = T.evaluate(dir[0], dir[1], dir[2], inner);
      const h = S.h;
      H[g] = h;
      DX[g] = dir[0]; DY[g] = dir[1]; DZ[g] = dir[2];
      const r = R + h;
      PX[g] = dir[0] * r; PY[g] = dir[1] * r; PZ[g] = dir[2] * r;
      if (inner) {
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
        const v = (j * V + i) * 4;
        matA[v] = u8(S.moisture); matA[v + 1] = u8(S.temp); matA[v + 2] = u8(S.rock); matA[v + 3] = u8(S.snow);
        matB[v] = u8(S.sand); matB[v + 1] = u8(Math.max(S.river, S.wet * 0.7)); matB[v + 3] = u8(S.cliff);
      }
    }
  }

  // ---- origin: chunk center on the base sphere ----
  faceDir(face, -1 + (2 * (ix * N + N / 2)) / total, -1 + (2 * (iy * N + N / 2)) / total, dir);
  const ox = dir[0] * R, oy = dir[1] * R, oz = dir[2] * R;

  const VC = V * V + 4 * V;
  const position = new Float32Array(VC * 3);
  const morph = new Float32Array(VC * 3);
  const nrm = new Int8Array(VC * 4), nrm2 = new Int8Array(VC * 4);
  const hgt = new Float32Array(VC);
  const lvl = q8(level / 127);

  // normals (central differences on the bordered grid)
  const NX = new Float64Array(V * V), NY = new Float64Array(V * V), NZ = new Float64Array(V * V);
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const g = (j + 1) * G + (i + 1);
    const ux = PX[g + 1] - PX[g - 1], uy = PY[g + 1] - PY[g - 1], uz = PZ[g + 1] - PZ[g - 1];
    const vx = PX[g + G] - PX[g - G], vy = PY[g + G] - PY[g - G], vz = PZ[g + G] - PZ[g - G];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    // make sure it points outward
    if (nx * DX[g] + ny * DY[g] + nz * DZ[g] < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const k = j * V + i;
    NX[k] = nx; NY[k] = ny; NZ[k] = nz;
  }

  // cavity: height relative to the 4-neighbour mean, scaled by spacing (concave → >0.5)
  const spacing = (Math.PI * 0.5 * R) / total;
  let maxDelta = 0;
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const g = (j + 1) * G + (i + 1), k = j * V + i;
    const lap = (H[g - 1] + H[g + 1] + H[g - G] + H[g + G]) * 0.25 - H[g];
    matB[k * 4 + 2] = u8(0.5 + Math.max(-0.5, Math.min(0.5, (lap / spacing) * 2.5)));
    position[k * 3] = PX[g] - ox; position[k * 3 + 1] = PY[g] - oy; position[k * 3 + 2] = PZ[g] - oz;
    hgt[k] = H[g];
    // morph target (parent grid: even vertices; diagonal a→d split)
    const io = i & 1, jo = j & 1;
    let tx = PX[g], ty = PY[g], tz = PZ[g];
    let mx = NX[k], my = NY[k], mz = NZ[k];
    if (io || jo) {
      let g0, g1, k0, k1;
      if (io && jo) { g0 = g - G - 1; g1 = g + G + 1; k0 = k - V - 1; k1 = k + V + 1; }
      else if (io) { g0 = g - 1; g1 = g + 1; k0 = k - 1; k1 = k + 1; }
      else { g0 = g - G; g1 = g + G; k0 = k - V; k1 = k + V; }
      tx = (PX[g0] + PX[g1]) * 0.5; ty = (PY[g0] + PY[g1]) * 0.5; tz = (PZ[g0] + PZ[g1]) * 0.5;
      mx = NX[k0] + NX[k1]; my = NY[k0] + NY[k1]; mz = NZ[k0] + NZ[k1];
      const ml = Math.sqrt(mx * mx + my * my + mz * mz) || 1; mx /= ml; my /= ml; mz /= ml;
    }
    const ddx = tx - PX[g], ddy = ty - PY[g], ddz = tz - PZ[g];
    morph[k * 3] = ddx; morph[k * 3 + 1] = ddy; morph[k * 3 + 2] = ddz;
    const dl = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    if (dl > maxDelta) maxDelta = dl;
    nrm[k * 4] = q8(NX[k]); nrm[k * 4 + 1] = q8(NY[k]); nrm[k * 4 + 2] = q8(NZ[k]); nrm[k * 4 + 3] = lvl;
    nrm2[k * 4] = q8(mx); nrm2[k * 4 + 1] = q8(my); nrm2[k * 4 + 2] = q8(mz); nrm2[k * 4 + 3] = lvl;
  }

  // ---- skirts ----
  const skirt = Math.max(0.6, maxDelta * 1.6 + spacing * 0.6 + (maxH - minH) * 0.02);
  const base = V * V;
  for (let e = 0; e < 4; e++) for (let t = 0; t <= N; t++) {
    const i = e === 0 || e === 1 ? t : e === 2 ? 0 : N;
    const j = e === 0 ? 0 : e === 1 ? N : t;
    const k = j * V + i, s = base + e * V + t;
    const g = (j + 1) * G + (i + 1);
    position[s * 3] = PX[g] - DX[g] * skirt - ox; position[s * 3 + 1] = PY[g] - DY[g] * skirt - oy; position[s * 3 + 2] = PZ[g] - DZ[g] * skirt - oz;
    morph[s * 3] = morph[k * 3]; morph[s * 3 + 1] = morph[k * 3 + 1]; morph[s * 3 + 2] = morph[k * 3 + 2];
    for (let c = 0; c < 4; c++) { nrm[s * 4 + c] = nrm[k * 4 + c]; nrm2[s * 4 + c] = nrm2[k * 4 + c]; matA[s * 4 + c] = matA[k * 4 + c]; matB[s * 4 + c] = matB[k * 4 + c]; }
    hgt[s] = hgt[k] - skirt;
  }

  // ---- bounds (relative to origin) ----
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < V * V; k++) { cx += position[k * 3]; cy += position[k * 3 + 1]; cz += position[k * 3 + 2]; }
  cx /= V * V; cy /= V * V; cz /= V * V;
  let rad = 0;
  for (let k = 0; k < VC; k++) {
    const dx = position[k * 3] - cx, dy = position[k * 3 + 1] - cy, dz = position[k * 3 + 2] - cz;
    const d = dx * dx + dy * dy + dz * dz; if (d > rad) rad = d;
  }
  rad = Math.sqrt(rad) + maxDelta;

  return {
    origin: [ox, oy, oz], center: [cx, cy, cz], radius: rad, minH, maxH, maxDelta, skirt,
    position, morph, nrm, nrm2, matA, matB, hgt,
  };
}

/** Transferable list for postMessage. */
export function transferables(c) {
  return [c.position.buffer, c.morph.buffer, c.nrm.buffer, c.nrm2.buffer, c.matA.buffer, c.matB.buffer, c.hgt.buffer];
}
