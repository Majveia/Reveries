// Signed distance toolkit used to sculpt the explorer procedurally:
// exact/approximate primitives, smooth booleans, and a Surface Nets mesher
// (sparse evaluation via a coarse pre-pass, vertices projected back onto the
// iso-surface along the gradient, smooth analytic normals).
//
// Everything here is pure JS (no three.js) so it can run in a worker or at init.

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const mix = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Polynomial smooth minimum (iq). k = blend radius (m). */
export function smin(a, b, k) {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
export function smax(a, b, k) { return -smin(-a, -b, k); }

export function sdSphere(x, y, z, cx, cy, cz, r) {
  const dx = x - cx, dy = y - cy, dz = z - cz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

/** Approximate ellipsoid distance (iq), good near the surface. */
export function sdEllipsoid(x, y, z, cx, cy, cz, rx, ry, rz) {
  const px = x - cx, py = y - cy, pz = z - cz;
  const ax = px / rx, ay = py / ry, az = pz / rz;
  const bx = px / (rx * rx), by = py / (ry * ry), bz = pz / (rz * rz);
  const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
  const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
  if (k1 < 1e-9) return -Math.min(rx, ry, rz);
  return (k0 * (k0 - 1)) / k1;
}

export function sdCapsule(x, y, z, ax, ay, az, bx, by, bz, r) {
  const pax = x - ax, pay = y - ay, paz = z - az, bax = bx - ax, bay = by - ay, baz = bz - az;
  const h = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0, 1);
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

/** Exact round cone between sphere (a, r1) and sphere (b, r2) — iq. */
export function sdRoundCone(x, y, z, ax, ay, az, bx, by, bz, r1, r2) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = x - ax, pay = y - ay, paz = z - az;
  const yy = pax * bax + pay * bay + paz * baz;
  const zz = yy - l2;
  const qx = pax * l2 - bax * yy, qy = pay * l2 - bay * yy, qz = paz * l2 - baz * yy;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = yy * yy * l2;
  const z2 = zz * zz * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
}

/** Rounded box with an orthonormal frame (ax, ay, az are unit vectors [x,y,z]). */
export function sdRoundBox(x, y, z, c, ax, ay, az, hx, hy, hz, r) {
  const px = x - c[0], py = y - c[1], pz = z - c[2];
  const lx = px * ax[0] + py * ax[1] + pz * ax[2];
  const ly = px * ay[0] + py * ay[1] + pz * ay[2];
  const lz = px * az[0] + py * az[1] + pz * az[2];
  const qx = Math.abs(lx) - hx + r, qy = Math.abs(ly) - hy + r, qz = Math.abs(lz) - hz + r;
  const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
  return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - r;
}

/** Axis-aligned rounded box. */
export function sdBox(x, y, z, cx, cy, cz, hx, hy, hz, r = 0) {
  const qx = Math.abs(x - cx) - hx + r, qy = Math.abs(y - cy) - hy + r, qz = Math.abs(z - cz) - hz + r;
  const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
  return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - r;
}

/** Torus in the plane perpendicular to unit axis n, centered c. */
export function sdTorus(x, y, z, c, n, R, r) {
  const px = x - c[0], py = y - c[1], pz = z - c[2];
  const along = px * n[0] + py * n[1] + pz * n[2];
  const qx = px - n[0] * along, qy = py - n[1] * along, qz = pz - n[2] * along;
  const radial = Math.sqrt(qx * qx + qy * qy + qz * qz) - R;
  return Math.sqrt(radial * radial + along * along) - r;
}

/** Capped cylinder between a and b (radius r, edge rounding re) — iq. */
export function sdCylinder(x, y, z, ax, ay, az, bx, by, bz, r, re = 0) {
  if (re > 0) {
    // shrink the core by the rounding radius, then inflate
    const dx = bx - ax, dy = by - ay, dz = bz - az, l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const s = Math.min(re, l * 0.49) / l;
    ax += dx * s; ay += dy * s; az += dz * s; bx -= dx * s; by -= dy * s; bz -= dz * s;
    r -= re;
  }
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const pax = x - ax, pay = y - ay, paz = z - az;
  const baba = bax * bax + bay * bay + baz * baz;
  const paba = pax * bax + pay * bay + paz * baz;
  const lx = pax * baba - bax * paba, ly = pay * baba - bay * paba, lz = paz * baba - baz * paba;
  const xx = Math.sqrt(lx * lx + ly * ly + lz * lz) - r * baba;
  const yy = Math.abs(paba - baba * 0.5) - baba * 0.5;
  const x2 = xx * xx, y2 = yy * yy * baba;
  let d;
  if (Math.max(xx, yy) < 0) d = -Math.min(x2, y2);
  else d = (xx > 0 ? x2 : 0) + (yy > 0 ? y2 : 0);
  return (Math.sign(d) * Math.sqrt(Math.abs(d))) / baba - re;
}

// ---------------------------------------------------------------------------------
// Surface Nets mesher
// ---------------------------------------------------------------------------------

const CORNERS = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7], // x
  [0, 2], [1, 3], [4, 6], [5, 7], // y
  [0, 4], [1, 5], [2, 6], [3, 7], // z
];

/**
 * Mesh the zero iso-surface of f inside bounds [x0,y0,z0,x1,y1,z1] at grid step h.
 * Returns { positions, normals, indices } (Float32Array / Uint32Array).
 * opts.project: Newton projection iterations (default 2).
 * opts.safety: skip-threshold multiplier for sparse evaluation (default 10).
 */
export function meshSDF(f, bounds, h, opts = {}) {
  const [x0, y0, z0, x1, y1, z1] = bounds;
  const nx = Math.max(2, Math.ceil((x1 - x0) / h) + 1);
  const ny = Math.max(2, Math.ceil((y1 - y0) / h) + 1);
  const nz = Math.max(2, Math.ceil((z1 - z0) / h) + 1);
  const sxy = nx * ny;
  const vals = new Float32Array(nx * ny * nz);

  // Coarse pre-pass (step C): points far from the surface inherit the coarse
  // value — only the sign matters there, so the fine grid is evaluated sparsely.
  const C = 4;
  const cx = Math.ceil((nx - 1) / C) + 1, cy = Math.ceil((ny - 1) / C) + 1, cz = Math.ceil((nz - 1) / C) + 1;
  const coarse = new Float32Array(cx * cy * cz);
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    const fi = Math.min(i * C, nx - 1), fj = Math.min(j * C, ny - 1), fk = Math.min(k * C, nz - 1);
    coarse[i + j * cx + k * cx * cy] = f(x0 + fi * h, y0 + fj * h, z0 + fk * h);
  }
  const thresh = h * (opts.safety ?? 10);
  for (let k = 0; k < nz; k++) {
    const ck = Math.min(cz - 1, Math.round(k / C));
    const z = z0 + k * h;
    for (let j = 0; j < ny; j++) {
      const cj = Math.min(cy - 1, Math.round(j / C));
      const y = y0 + j * h;
      const base = j * nx + k * sxy;
      for (let i = 0; i < nx; i++) {
        const cv = coarse[Math.min(cx - 1, Math.round(i / C)) + cj * cx + ck * cx * cy];
        vals[base + i] = Math.abs(cv) > thresh ? cv : f(x0 + i * h, y, z);
      }
    }
  }

  // One vertex per sign-changing cell.
  const mx = nx - 1, my = ny - 1, mz = nz - 1;
  const cellIndex = new Int32Array(mx * my * mz).fill(-1);
  const pos = [];
  const cv = new Float32Array(8);
  for (let k = 0; k < mz; k++) for (let j = 0; j < my; j++) for (let i = 0; i < mx; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      const o = CORNERS[c];
      const v = vals[(i + o[0]) + (j + o[1]) * nx + (k + o[2]) * sxy];
      cv[c] = v;
      if (v < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let e = 0; e < 12; e++) {
      const a = EDGES[e][0], b = EDGES[e][1];
      const va = cv[a], vb = cv[b];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      const oa = CORNERS[a], ob = CORNERS[b];
      sx += oa[0] + (ob[0] - oa[0]) * t;
      sy += oa[1] + (ob[1] - oa[1]) * t;
      sz += oa[2] + (ob[2] - oa[2]) * t;
      n++;
    }
    cellIndex[i + j * mx + k * mx * my] = pos.length / 3;
    pos.push(x0 + (i + sx / n) * h, y0 + (j + sy / n) * h, z0 + (k + sz / n) * h);
  }

  // Quads across sign-changing grid edges.
  const idx = [];
  const cell = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= mx || j >= my || k >= mz ? -1 : cellIndex[i + j * mx + k * mx * my]);
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, c, b, a, d, c);
    else idx.push(a, b, c, a, c, d);
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v0 = vals[i + j * nx + k * sxy];
    const in0 = v0 < 0;
    if (i < mx) { // x edge
      const in1 = vals[i + 1 + j * nx + k * sxy] < 0;
      if (in0 !== in1 && j > 0 && k > 0) quad(cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k), !in0);
    }
    if (j < my) { // y edge
      const in1 = vals[i + (j + 1) * nx + k * sxy] < 0;
      if (in0 !== in1 && i > 0 && k > 0) quad(cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1), !in0);
    }
    if (k < mz) { // z edge
      const in1 = vals[i + j * nx + (k + 1) * sxy] < 0;
      if (in0 !== in1 && i > 0 && j > 0) quad(cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k), !in0);
    }
  }

  // Project onto the iso-surface + analytic normals.
  const nv = pos.length / 3;
  const positions = new Float32Array(pos);
  const normals = new Float32Array(nv * 3);
  const e = h * 0.2;
  const iters = opts.project ?? 2;
  const maxMove = h * 0.9;
  for (let v = 0; v < nv; v++) {
    let px = positions[v * 3], py = positions[v * 3 + 1], pz = positions[v * 3 + 2];
    const ox = px, oy = py, oz = pz;
    let gx = 0, gy = 0, gz = 0;
    for (let it = 0; it <= iters; it++) {
      const d = f(px, py, pz);
      gx = f(px + e, py, pz) - f(px - e, py, pz);
      gy = f(px, py + e, pz) - f(px, py - e, pz);
      gz = f(px, py, pz + e) - f(px, py, pz - e);
      const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
      gx /= gl; gy /= gl; gz /= gl;
      if (it === iters) break;
      px -= d * gx; py -= d * gy; pz -= d * gz;
      // never wander out of the neighbourhood (sharp features)
      const dx = px - ox, dy = py - oy, dz = pz - oz, dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dl > maxMove) { const s = maxMove / dl; px = ox + dx * s; py = oy + dy * s; pz = oz + dz * s; }
    }
    positions[v * 3] = px; positions[v * 3 + 1] = py; positions[v * 3 + 2] = pz;
    normals[v * 3] = gx; normals[v * 3 + 1] = gy; normals[v * 3 + 2] = gz;
  }
  const indices = new Uint32Array(idx);
  // Sharp features are under-resolved by the grid: vertices projected onto
  // alternating faces get alternating gradient normals (speckled rims). Where the
  // gradient disagrees with the local surface (area-weighted face normals), trust
  // the mesh.
  if (opts.fixNormals !== false && nv) {
    const fn = new Float32Array(nv * 3);
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
      const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
      const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const k of [a, b, c]) { fn[k] += nx; fn[k + 1] += ny; fn[k + 2] += nz; }
    }
    const cosT = Math.cos((opts.sharpAngle ?? 32) * Math.PI / 180);
    for (let v = 0; v < nv; v++) {
      const k = v * 3;
      const l = Math.hypot(fn[k], fn[k + 1], fn[k + 2]);
      if (l < 1e-12) continue;
      const fx = fn[k] / l, fy = fn[k + 1] / l, fz = fn[k + 2] / l;
      const d = fx * normals[k] + fy * normals[k + 1] + fz * normals[k + 2];
      if (d < cosT) {
        // blend toward the mesh normal (fully when they strongly disagree)
        const w = d < 0 ? 1 : Math.min(1, (cosT - d) / (cosT * 0.5));
        let nx = normals[k] * (1 - w) + fx * w, ny = normals[k + 1] * (1 - w) + fy * w, nz = normals[k + 2] * (1 - w) + fz * w;
        const nl = Math.hypot(nx, ny, nz) || 1;
        normals[k] = nx / nl; normals[k + 1] = ny / nl; normals[k + 2] = nz / nl;
      }
    }
  }
  return { positions, normals, indices };
}

/** Cheap SDF ambient occlusion along the normal (iq). Returns 0..1 (1 = open). */
export function sdfAO(f, px, py, pz, nx, ny, nz, step = 0.012, taps = 5, k = 1.0) {
  let occ = 0, w = 1;
  for (let i = 1; i <= taps; i++) {
    const t = step * i;
    const d = f(px + nx * t, py + ny * t, pz + nz * t);
    occ += (t - Math.max(d, 0)) * w;
    w *= 0.6;
  }
  return clamp(1 - (k * occ) / (step * 2.2), 0, 1);
}
