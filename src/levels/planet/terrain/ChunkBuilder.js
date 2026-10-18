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
//   aHorA/B   uint8×4 ×2 horizon elevation (sin, (s+0.25)/1.25) toward 8 azimuths in the
//                        HOR_AXIS east/north frame → soft, LOD-consistent terrain sun
//                        shadows + sky occlusion (see horizonFrame / TerrainMaterial)
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

// Horizon frame: east = normalize(HOR_AXIS × up), north = up × east. A skewed fixed
// axis (no cube-face seams); the shader rebuilds exactly the same frame.
export const HOR_AXIS = [0.2873478855663454, 0.9578262852211514, 0.0];
export const HOR_K = 8;
function horizonFrame(px, py, pz, out) {
  const ax = HOR_AXIS[0], ay = HOR_AXIS[1], az = HOR_AXIS[2];
  let ex = ay * pz - az * py, ey = az * px - ax * pz, ez = ax * py - ay * px;
  let l = Math.sqrt(ex * ex + ey * ey + ez * ez);
  if (l < 1e-6) { ex = 1; ey = 0; ez = 0; l = 1; }
  ex /= l; ey /= l; ez /= l;
  out[0] = ex; out[1] = ey; out[2] = ez;
  out[3] = py * ez - pz * ey; out[4] = pz * ex - px * ez; out[5] = px * ey - py * ex;
  return out;
}
const HOR_COS = [], HOR_SIN = [];
for (let k = 0; k < 8; k++) { HOR_COS.push(Math.cos((k * Math.PI) / 4)); HOR_SIN.push(Math.sin((k * Math.PI) / 4)); }

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
  // LOD band limit: octaves finer than ~2–4 vertex spacings are faded so the
  // mesh never aliases the height field (exact at spacing ≤ 1 m → physics).
  const spacing = (Math.PI * 0.5 * R) / total;
  const hasLod = typeof T.setLod === 'function';
  if (hasLod) T.setLod(spacing);
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

  // ---- parent-band heights at the even (parent-grid) vertices ----
  // CDLOD morph target must equal what the parent chunk rendered there,
  // including the parent's coarser band limit → seamless, pop-free morphs.
  let PH = null;
  if (hasLod && level > 0) {
    T.setLod(spacing * 2);
    const parentLS = T.lod;
    T.setLod(spacing);
    if (parentLS !== T.lod) {
      T.setLod(spacing * 2);
      PH = new Float64Array(G * G);
      for (let j = 0; j <= N; j += 2) for (let i = 0; i <= N; i += 2) {
        const g = (j + 1) * G + (i + 1);
        PH[g] = T.evaluate(DX[g], DY[g], DZ[g], false).h;
      }
    }
  }
  // ---- horizon (8 azimuths) ----
  // far part: great-circle marches from a coarse grid of chunk points (true height
  // field, band-limited with distance), bilinearly spread over the vertices; near
  // part: per-vertex marches over this chunk's own bordered height grid.
  const HK = HOR_K;
  const horF = new Float32Array(V * V * HK).fill(-0.25);
  {
    const HG = spacing < 8 ? 5 : 9, gs = N / (HG - 1);
    const dmax = Math.min(20000, R * 0.6);
    const d0 = 2 * gs * spacing;
    const C = new Float32Array(HG * HG * HK).fill(-0.25);
    if (d0 < dmax * 0.7 && level >= 1) {
      const S = 9, ratio = Math.pow(dmax / d0, 1 / (S - 1));
      const fr = [0, 0, 0, 0, 0, 0];
      for (let cj = 0; cj < HG; cj++) for (let ci = 0; ci < HG; ci++) {
        const g = (Math.round(cj * gs) + 1) * G + (Math.round(ci * gs) + 1);
        const px = DX[g], py = DY[g], pz = DZ[g], r0 = R + H[g];
        horizonFrame(px, py, pz, fr);
        const cb = (cj * HG + ci) * HK;
        for (let k = 0; k < HK; k++) {
          const tx = HOR_COS[k] * fr[0] + HOR_SIN[k] * fr[3], ty = HOR_COS[k] * fr[1] + HOR_SIN[k] * fr[4], tz = HOR_COS[k] * fr[2] + HOR_SIN[k] * fr[5];
          let best = -0.25, d = d0;
          for (let st = 0; st < S; st++, d *= ratio) {
            const an = d / R, ca = Math.cos(an), sa = Math.sin(an);
            const qx = px * ca + tx * sa, qy = py * ca + ty * sa, qz = pz * ca + tz * sa;
            if (hasLod) T.setLod(Math.max(spacing, d * 0.06));
            const rq = R + T.evaluate(qx, qy, qz, false).h;
            const vx = qx * rq - px * r0, vy = qy * rq - py * r0, vz = qz * rq - pz * r0;
            const e = (vx * px + vy * py + vz * pz) / (Math.sqrt(vx * vx + vy * vy + vz * vz) || 1);
            if (e > best) best = e;
          }
          C[cb + k] = best;
        }
      }
    }
    // spread + near marches
    const NS = [1, 2, 3, 5, 8, 12, 18, 26, 36];
    const fr = [0, 0, 0, 0, 0, 0];
    const inv2R = 1 / (2 * R);
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const k0 = (j * V + i) * HK, g = (j + 1) * G + (i + 1);
      // coarse bilinear
      const fi = Math.min(HG - 1.0001, i / gs), fj = Math.min(HG - 1.0001, j / gs);
      const ci = Math.floor(fi), cj = Math.floor(fj), ti = fi - ci, tj = fj - cj;
      const c00 = (cj * HG + ci) * HK, c10 = c00 + HK, c01 = c00 + HG * HK, c11 = c01 + HK;
      for (let k = 0; k < HK; k++) horF[k0 + k] = (C[c00 + k] * (1 - ti) + C[c10 + k] * ti) * (1 - tj) + (C[c01 + k] * (1 - ti) + C[c11 + k] * ti) * tj;
      // local grid tangents (m per grid step) in the horizon frame
      const px = DX[g], py = DY[g], pz = DZ[g];
      horizonFrame(px, py, pz, fr);
      const tix = (PX[g + 1] - PX[g - 1]) * 0.5, tiy = (PY[g + 1] - PY[g - 1]) * 0.5, tiz = (PZ[g + 1] - PZ[g - 1]) * 0.5;
      const tjx = (PX[g + G] - PX[g - G]) * 0.5, tjy = (PY[g + G] - PY[g - G]) * 0.5, tjz = (PZ[g + G] - PZ[g - G]) * 0.5;
      const ie = tix * fr[0] + tiy * fr[1] + tiz * fr[2], inn = tix * fr[3] + tiy * fr[4] + tiz * fr[5];
      const je = tjx * fr[0] + tjy * fr[1] + tjz * fr[2], jn = tjx * fr[3] + tjy * fr[4] + tjz * fr[5];
      const det = ie * jn - je * inn;
      if (Math.abs(det) < 1e-9) continue;
      const h0 = H[g];
      for (let k = 0; k < HK; k++) {
        // grid steps per metre along azimuth k
        const a = (jn * HOR_COS[k] - je * HOR_SIN[k]) / det, b = (-inn * HOR_COS[k] + ie * HOR_SIN[k]) / det;
        let best = horF[k0 + k];
        for (let st = 0; st < NS.length; st++) {
          const d = NS[st] * spacing;
          const si = i + a * d, sj = j + b * d;
          if (si < -1 || sj < -1 || si > N + 1 || sj > N + 1) break;
          const ii = Math.min(N, Math.floor(si)), jj = Math.min(N, Math.floor(sj));
          const fx = si - ii, fy = sj - jj;
          const gg = (jj + 1) * G + (ii + 1);
          const hs = (H[gg] * (1 - fx) + H[gg + 1] * fx) * (1 - fy) + (H[gg + G] * (1 - fx) + H[gg + G + 1] * fx) * fy;
          const dh = hs - h0 - d * d * inv2R;
          const e = dh / Math.sqrt(d * d + dh * dh);
          if (e > best) best = e;
        }
        horF[k0 + k] = best;
      }
    }
  }
  if (hasLod) T.setLod(0);

  // ---- origin: chunk center on the base sphere ----
  faceDir(face, -1 + (2 * (ix * N + N / 2)) / total, -1 + (2 * (iy * N + N / 2)) / total, dir);
  // rounded to 1/16 m → exactly representable in float32 (mesh.position), so
  // world-space shader coordinates derived from it carry no per-chunk jitter.
  const ox = Math.round(dir[0] * R * 16) / 16, oy = Math.round(dir[1] * R * 16) / 16, oz = Math.round(dir[2] * R * 16) / 16;

  const VC = V * V + 4 * V;
  const position = new Float32Array(VC * 3);
  const morph = new Float32Array(VC * 3);
  const nrm = new Int8Array(VC * 4), nrm2 = new Int8Array(VC * 4);
  const hgt = new Float32Array(VC);
  const horA = new Uint8Array(VC * 4), horB = new Uint8Array(VC * 4);
  for (let k = 0; k < V * V; k++) for (let c = 0; c < 4; c++) {
    horA[k * 4 + c] = u8((horF[k * HK + c] + 0.25) / 1.25);
    horB[k * 4 + c] = u8((horF[k * HK + 4 + c] + 0.25) / 1.25);
  }
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
  let maxDelta = 0;
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const g = (j + 1) * G + (i + 1), k = j * V + i;
    const lap = (H[g - 1] + H[g + 1] + H[g - G] + H[g + G]) * 0.25 - H[g];
    matB[k * 4 + 2] = u8(0.5 + Math.max(-0.5, Math.min(0.5, (lap / spacing) * 2.5)));
    position[k * 3] = PX[g] - ox; position[k * 3 + 1] = PY[g] - oy; position[k * 3 + 2] = PZ[g] - oz;
    hgt[k] = H[g];
    // morph target (parent grid: even vertices; diagonal a→d split)
    const io = i & 1, jo = j & 1;
    // parent-grid position at grid index g (parent band limit when available)
    const ppx = (gg) => (PH ? DX[gg] * (R + PH[gg]) : PX[gg]);
    const ppy = (gg) => (PH ? DY[gg] * (R + PH[gg]) : PY[gg]);
    const ppz = (gg) => (PH ? DZ[gg] * (R + PH[gg]) : PZ[gg]);
    let tx = ppx(g), ty = ppy(g), tz = ppz(g);
    let mx = NX[k], my = NY[k], mz = NZ[k];
    if (io || jo) {
      let g0, g1, k0, k1;
      if (io && jo) { g0 = g - G - 1; g1 = g + G + 1; k0 = k - V - 1; k1 = k + V + 1; }
      else if (io) { g0 = g - 1; g1 = g + 1; k0 = k - 1; k1 = k + 1; }
      else { g0 = g - G; g1 = g + G; k0 = k - V; k1 = k + V; }
      tx = (ppx(g0) + ppx(g1)) * 0.5; ty = (ppy(g0) + ppy(g1)) * 0.5; tz = (ppz(g0) + ppz(g1)) * 0.5;
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
  // deep enough to hide T-junction gaps against a coarser neighbour even on sheer
  // walls (karst towers, mesa risers): the gap there can approach the local relief
  const skirt = Math.max(0.6, maxDelta * 2.2 + spacing * 0.8 + (maxH - minH) * 0.3);
  const base = V * V;
  for (let e = 0; e < 4; e++) for (let t = 0; t <= N; t++) {
    const i = e === 0 || e === 1 ? t : e === 2 ? 0 : N;
    const j = e === 0 ? 0 : e === 1 ? N : t;
    const k = j * V + i, s = base + e * V + t;
    const g = (j + 1) * G + (i + 1);
    position[s * 3] = PX[g] - DX[g] * skirt - ox; position[s * 3 + 1] = PY[g] - DY[g] * skirt - oy; position[s * 3 + 2] = PZ[g] - DZ[g] * skirt - oz;
    morph[s * 3] = morph[k * 3]; morph[s * 3 + 1] = morph[k * 3 + 1]; morph[s * 3 + 2] = morph[k * 3 + 2];
    for (let c = 0; c < 4; c++) { nrm[s * 4 + c] = nrm[k * 4 + c]; nrm2[s * 4 + c] = nrm2[k * 4 + c]; matA[s * 4 + c] = matA[k * 4 + c]; matB[s * 4 + c] = matB[k * 4 + c]; horA[s * 4 + c] = horA[k * 4 + c]; horB[s * 4 + c] = horB[k * 4 + c]; }
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
    position, morph, nrm, nrm2, matA, matB, hgt, horA, horB,
  };
}

/** Transferable list for postMessage. */
export function transferables(c) {
  return [c.position.buffer, c.morph.buffer, c.nrm.buffer, c.nrm2.buffer, c.matA.buffer, c.matB.buffer, c.hgt.buffer, c.horA.buffer, c.horB.buffer];
}
