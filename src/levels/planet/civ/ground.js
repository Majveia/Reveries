// Ground draping: streets, plazas, fields and pads are thin meshes laid over
// the true terrain height field (SiteFrame.hAt), plus the shadow catcher that
// lets the terrain receive the city's sun shadows and contact occlusion.
//
// Ground vertices: aFac = world-aligned plan coords (so overlapping ribbons
// share one pattern), aMat = (surface id, seed, edge 0..1 across, lamp pool),
// aExt = (ao, radius for pads, 0, 0).

import * as THREE from 'three';

const _n = new THREE.Vector3(), _u = new THREE.Vector3(), _p = new THREE.Vector3();

/** Spatial hash of lamps for light pools on the ground. */
export class LampField {
  constructor(lamps) {
    this.map = new Map();
    for (const l of lamps) {
      const i = Math.floor(l.p.x / 8), j = Math.floor(l.p.z / 8);
      const k = i * 92821 + j; let a = this.map.get(k); if (!a) this.map.set(k, a = []); a.push(l);
    }
  }
  at(x, z) {
    let s = 0;
    const i0 = Math.floor(x / 8), j0 = Math.floor(z / 8);
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) {
      const a = this.map.get(i * 92821 + j); if (!a) continue;
      for (const l of a) {
        const d = Math.hypot(l.p.x - x, l.p.z - z) / l.r;
        if (d < 1) { const f = 1 - d; s += f * f * l.k; }
      }
    }
    return Math.min(s, 1.5);
  }
}

function groundNormal(frame, x, z, out) {
  const e = 1.0;
  const dx = (frame.hAt(x + e, z) - frame.hAt(x - e, z)) / (2 * e);
  const dz = (frame.hAt(x, z + e) - frame.hAt(x, z - e)) / (2 * e);
  frame.upAt(x, z, out);
  out.x -= dx; out.z -= dz;
  return out.normalize();
}

function vtx(G, frame, x, z, lift, u, v, lamps) {
  const h = frame.hAt(x, z);
  frame.point(x, z, h + lift, _p);
  groundNormal(frame, x, z, _n);
  if (lamps) G.a[3] = lamps.at(_p.x, _p.z);
  return G.v(_p.x, _p.y, _p.z, _n.x, _n.y, _n.z, u, v);
}

/**
 * A graded causeway: the centreline height is low-passed along the road (no
 * draping over dune crests), the cross-section is level, and retaining-wall
 * skirts drop to the terrain wherever the road rides above it. Dune crests
 * simply bury the paving (sand drifting over the road). UVs are road-local
 * (along, across) so slab courses run with the road.
 */
function gradedRibbon(G, frame, rs, w, id, color, lift, lamps, seed, step, grade) {
  const n = rs.length;
  let hs = rs.map((p) => frame.hAt(p[0], p[1]));
  const win = Math.max(1, Math.round((grade.win ?? 50) / step));
  for (let pass = 0; pass < 3; pass++) {
    const src = hs, out = new Array(n);
    let acc = 0, cnt = 0, lo = 0, hi = -1;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - win), b = Math.min(n - 1, i + win);
      while (hi < b) { hi++; acc += src[hi]; cnt++; }
      while (lo < a) { acc -= src[lo]; lo++; cnt--; }
      out[i] = acc / cnt;
    }
    hs = out;
  }
  const sea = frame.sea + 0.6;
  for (let i = 0; i < n; i++) hs[i] = Math.max(hs[i], sea);
  G.color(color);
  const cols = 4;
  const start = G.n;
  let sAcc = 0;
  const ss = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (i > 0) sAcc += Math.hypot(rs[i][0] - rs[i - 1][0], rs[i][1] - rs[i - 1][1]);
    ss[i] = sAcc;
    const p = rs[i], a = rs[Math.max(0, i - 1)], b = rs[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
    const nx = -tz, nz = tx;
    for (let c = 0; c <= cols; c++) {
      const e = c / cols, off = (e - 0.5) * w;
      const x = p[0] + nx * off, z = p[1] + nz * off;
      G.mat(id, seed, e, 0);
      frame.point(x, z, hs[i] + lift + (1 - Math.abs(e - 0.5) * 2) * 0.03, _p);
      frame.upAt(x, z, _n);
      if (lamps) G.a[3] = lamps.at(_p.x, _p.z);
      G.v(_p.x, _p.y, _p.z, _n.x, _n.y, _n.z, sAcc, off);
    }
  }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < cols; c++) {
    const a = start + r * (cols + 1) + c, b = a + 1, d = a + cols + 1, e = d + 1;
    G.quad(a, b, e, d);
  }
  if (grade.skirt === false) return;
  // retaining walls / embankment faces on both edges
  G.color(grade.skirtColor || color);
  for (const sgn of [-1, 1]) {
    const s0 = G.n;
    for (let i = 0; i < n; i++) {
      const p = rs[i], a = rs[Math.max(0, i - 1)], b = rs[Math.min(n - 1, i + 1)];
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      const nx = -tz * sgn, nz = tx * sgn;
      const x = p[0] + nx * w * 0.5, z = p[1] + nz * w * 0.5;
      const top = hs[i] + lift, g = frame.hAt(x + nx * 0.6, z + nz * 0.6);
      const bot = Math.min(g - 1.2, top - 0.05);
      frame.upAt(x, z, _u);
      _n.set(nx, 0, nz).addScaledVector(_u, -(_u.x * nx + _u.z * nz) * 0).normalize();
      G.mat(id, seed, 0.5, 0);
      frame.point(x, z, top, _p); G.v(_p.x, _p.y, _p.z, _n.x, _n.y, _n.z, ss[i], 0);
      frame.point(x + nx * 0.25 * Math.max(0, top - bot) * 0.15, z + nz * 0.25 * Math.max(0, top - bot) * 0.15, bot, _p); G.v(_p.x, _p.y, _p.z, _n.x, _n.y, _n.z, ss[i], top - bot);
    }
    for (let r = 0; r < n - 1; r++) {
      const a = s0 + r * 2, b = a + 1, c = a + 2, d = a + 3;
      G.quad(a, b, d, c); G.quad(a, c, d, b);
    }
  }
}

/** Drape a ribbon along a plan polyline (or grade it into a causeway when `grade` is given). */
export function ribbon(G, frame, pts, w, id, color, lift, lamps, seed = 0, step = 2.5, grade = null) {
  if (pts.length < 2) return;
  // resample
  const rs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < n; k++) rs.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
  }
  rs.push(pts[pts.length - 1]);
  if (grade) return gradedRibbon(G, frame, rs, w, id, color, lift, lamps, seed, step, grade);
  G.color(color);
  const cols = 4;
  const start = G.n;
  let rowCount = 0;
  for (let i = 0; i < rs.length; i++) {
    const p = rs[i], a = rs[Math.max(0, i - 1)], b = rs[Math.min(rs.length - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
    const nx = -tz, nz = tx;
    for (let c = 0; c <= cols; c++) {
      const e = c / cols;
      const off = (e - 0.5) * w;
      const x = p[0] + nx * off, z = p[1] + nz * off;
      G.mat(id, seed, e, 0);
      vtx(G, frame, x, z, lift + (1 - Math.abs(e - 0.5) * 2) * 0.03, x, z, lamps);
    }
    rowCount++;
  }
  for (let r = 0; r < rowCount - 1; r++) for (let c = 0; c < cols; c++) {
    const a = start + r * (cols + 1) + c, b = a + 1, d = a + cols + 1, e = d + 1;
    G.quad(a, b, e, d);
  }
}

/** Drape a disc (plaza). padLocal: uv relative to center (for landing pads). */
export function disc(G, frame, cx, cz, r, id, color, lift, lamps, o = {}) {
  const segs = o.segs ?? Math.max(24, Math.floor(r * 2.2)), rings = o.rings ?? Math.max(3, Math.ceil(r / 3));
  G.color(color);
  const se = G.e[1]; G.e[1] = r;
  const start = G.n;
  for (let j = 0; j <= rings; j++) {
    const rr = (j / rings) * r;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
      G.mat(id, o.seed ?? 0, 0.5 + 0.5 * (j / rings) * 0.8, 0);
      vtx(G, frame, x, z, lift, o.padLocal ? x - cx : x, o.padLocal ? z - cz : z, lamps);
    }
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < segs; i++) {
    const a = start + j * segs + i, b = start + j * segs + (i + 1) % segs, c = a + segs, d = b + segs;
    G.quad(a, b, d, c);
  }
  G.e[1] = se;
}

/** Drape an oriented rectangle (fields, courtyards); uv in rect-local meters. */
export function rect(G, frame, x, z, w, d, yaw, id, color, lift, lamps, o = {}) {
  const nu = Math.max(2, Math.ceil(w / (o.step ?? 4))), nv = Math.max(2, Math.ceil(d / (o.step ?? 4)));
  const c = Math.cos(yaw), s = Math.sin(yaw);
  G.color(color);
  const start = G.n;
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const u = (i / nu - 0.5) * w, v = (j / nv - 0.5) * d;
    const px = x + u * c + v * s, pz = z - u * s + v * c;
    const edge = Math.min(1, Math.min(i / nu, 1 - i / nu, j / nv, 1 - j / nv) * 2);
    G.mat(id, o.seed ?? 0, o.edge ?? edge, 0);
    vtx(G, frame, px, pz, lift, o.world ? px : u, o.world ? pz : v, lamps);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = start + j * (nu + 1) + i, b = a + 1, cc = a + nu + 1, d2 = cc + 1;
    G.quad(a, cc, d2, b);
  }
}

/**
 * Shadow catcher draped over the settlement area: position (local), normal,
 * aAO (1 = open, lower near walls — contact occlusion).
 */
export function catcherGeometry(frame, cx, cz, R, lots, step = 3) {
  const n = Math.ceil((R * 2) / step);
  const N = n + 1;
  const pos = new Float32Array(N * N * 3), nor = new Float32Array(N * N * 3), ao = new Float32Array(N * N).fill(1);
  const xs = new Float32Array(N * N), zs = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const x = cx - R + i * step, z = cz - R + j * step;
    xs[k] = x; zs[k] = z;
    frame.point(x, z, frame.hAt(x, z) + 0.25, _p);
    pos[k * 3] = _p.x; pos[k * 3 + 1] = _p.y; pos[k * 3 + 2] = _p.z;
    groundNormal(frame, x, z, _u);
    nor[k * 3] = _u.x; nor[k * 3 + 1] = _u.y; nor[k * 3 + 2] = _u.z;
  }
  // contact occlusion around footprints
  for (const l of lots) {
    const reach = 3.2 + Math.min(4, (l.h ?? 6) * 0.12);
    const rr = Math.hypot(l.w, l.d) / 2 + reach;
    const i0 = Math.max(0, Math.floor((l.x - rr - (cx - R)) / step)), i1 = Math.min(n, Math.ceil((l.x + rr - (cx - R)) / step));
    const j0 = Math.max(0, Math.floor((l.z - rr - (cz - R)) / step)), j1 = Math.min(n, Math.ceil((l.z + rr - (cz - R)) / step));
    const c = Math.cos(l.yaw), s = Math.sin(l.yaw);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * N + i;
      const dx = xs[k] - l.x, dz = zs[k] - l.z;
      const u = dx * c - dz * s, v = dx * s + dz * c;
      const ox = Math.max(Math.abs(u) - l.w / 2, 0), oz = Math.max(Math.abs(v) - l.d / 2, 0);
      const d = Math.hypot(ox, oz);
      const a = Math.min(1, d / reach);
      ao[k] = Math.min(ao[k], 0.25 + 0.75 * a * a * (3 - 2 * a));
    }
  }
  const idx = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * N + i;
    const x = xs[k] + step / 2 - cx, z = zs[k] + step / 2 - cz;
    if (x * x + z * z > R * R) continue;
    if (frame.wet(xs[k], zs[k], -0.5) && frame.wet(xs[k + N + 1], zs[k + N + 1], -0.5)) continue;
    idx.push(k, k + N, k + N + 1, k, k + N + 1, k + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
  g.setIndex(N * N > 65535 ? idx : idx);
  g.computeBoundingSphere();
  return g;
}
