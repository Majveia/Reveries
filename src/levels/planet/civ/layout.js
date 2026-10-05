// Town planner — grows a street network over the real terrain, then packs
// building lots along the streets. Everything is in plan coordinates (x, z)
// of the SiteFrame (meters). The plan is pure data; generators turn it into
// geometry.
//
// Plan = {
//   center: [x, z], radius,               built-up radius actually reached
//   roads:  [{ pts: [[x,z],…], w, kind }], kind: 'main' | 'street' | 'lane' | 'avenue' | 'stair'
//   plazas: [{ x, z, r, kind }],
//   lots:   [{ x, z, yaw, w, d, zone, road, kind, base, slope }],
//   fields: [{ pts: [[x,z]×4], kind }],
//   docks:  [{ x, z, yaw, len }],
//   wall:   [[x,z],…] | null, gates: [{x, z, yaw}],
//   spots:  [{ x, z, kind }]               (hilltops, vistas, landmark seats)
// }

import { Random } from '../../../core/Random.js';
import { SimplexNoise } from '../../../core/Noise.js';
import { planRot } from './frame.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- spatial hashes
class SegGrid {
  constructor(cell = 16) { this.cell = cell; this.map = new Map(); }
  _k(i, j) { return i * 92821 + j; }
  add(ax, az, bx, bz, w, id) {
    const c = this.cell, s = { ax, az, bx, bz, w, id };
    const i0 = Math.floor((Math.min(ax, bx) - w) / c), i1 = Math.floor((Math.max(ax, bx) + w) / c);
    const j0 = Math.floor((Math.min(az, bz) - w) / c), j1 = Math.floor((Math.max(az, bz) + w) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = this._k(i, j); let a = this.map.get(k); if (!a) this.map.set(k, a = []); a.push(s);
    }
  }
  /** min over segments of (distance - half width); also returns the segment */
  query(x, z, r = 0, skip = -1) {
    const c = this.cell;
    let best = Infinity, seg = null;
    const i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c), j0 = Math.floor((z - r) / c), j1 = Math.floor((z + r) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const a = this.map.get(this._k(i, j)); if (!a) continue;
      for (const s of a) {
        if (s.id === skip) continue;
        const d = segDist(x, z, s.ax, s.az, s.bx, s.bz) - s.w * 0.5;
        if (d < best) { best = d; seg = s; }
      }
    }
    return { d: best, seg };
  }
}

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px, ez = az + dz * t - pz;
  return Math.sqrt(ex * ex + ez * ez);
}

class BoxGrid {
  constructor(cell = 24) { this.cell = cell; this.map = new Map(); }
  _k(i, j) { return i * 92821 + j; }
  _corners(b) {
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw), hw = b.w / 2 + (b.pad || 0), hd = b.d / 2 + (b.pad || 0);
    return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => [b.x + u * c + v * s, b.z - u * s + v * c]);
  }
  add(b) {
    b._c = this._corners(b);
    const r = Math.hypot(b.w, b.d) / 2 + (b.pad || 0), c = this.cell;
    for (let i = Math.floor((b.x - r) / c); i <= Math.floor((b.x + r) / c); i++)
      for (let j = Math.floor((b.z - r) / c); j <= Math.floor((b.z + r) / c); j++) {
        const k = this._k(i, j); let a = this.map.get(k); if (!a) this.map.set(k, a = []); a.push(b);
      }
  }
  hits(b) {
    const cs = this._corners(b), r = Math.hypot(b.w, b.d) / 2 + (b.pad || 0), c = this.cell;
    const seen = new Set();
    for (let i = Math.floor((b.x - r) / c); i <= Math.floor((b.x + r) / c); i++)
      for (let j = Math.floor((b.z - r) / c); j <= Math.floor((b.z + r) / c); j++) {
        const a = this.map.get(this._k(i, j)); if (!a) continue;
        for (const o of a) {
          if (seen.has(o)) continue; seen.add(o);
          if (Math.hypot(o.x - b.x, o.z - b.z) > r + Math.hypot(o.w, o.d) / 2 + (o.pad || 0)) continue;
          if (obbOverlap(cs, o._c)) return true;
        }
      }
    return false;
  }
}

function obbOverlap(A, B) {
  for (const P of [A, B]) for (let i = 0; i < 4; i++) {
    const p = P[i], q = P[(i + 1) % 4];
    const nx = -(q[1] - p[1]), nz = q[0] - p[0];
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const v of A) { const d = v[0] * nx + v[1] * nz; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
    for (const v of B) { const d = v[0] * nx + v[1] * nz; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}

// ---------------------------------------------------------------- style planning parameters
export const PLAN_STYLE = {
  pastoral:   { net: 'organic', mains: [4, 6], meander: 0.35, slope: 0.24, lotW: [5.5, 9], lotD: [7, 10], gap: 0.15, setback: [0.2, 0.9], fill: 0.97, rows: 3, plazaR: [15, 22], wall: 0.25, fields: true, branchEvery: [20, 34], branchLen: [40, 130], roadW: { main: 5.5, street: 4, lane: 3 } },
  temple:     { net: 'axial', mains: [3, 4], meander: 0.25, slope: 0.3, lotW: [7, 11], lotD: [7, 10], coreScale: 1.55, gap: 0.7, setback: [0.3, 1.4], fill: 0.92, rows: 3, plazaR: [20, 28], wall: 0.6, fields: true, branchEvery: [30, 50], branchLen: [30, 110], roadW: { main: 7, street: 4, lane: 3 } },
  monolithic: { net: 'grid', mains: [4, 4], meander: 0.05, slope: 0.12, lotW: [9, 26], lotD: [9, 24], gap: 2.0, setback: [0.5, 3], fill: 0.85, rows: 2, plazaR: [30, 40], wall: 1, fields: false, gridStep: [44, 64], roadW: { main: 14, street: 7, lane: 4 } },
  organic:    { net: 'radial', mains: [5, 7], meander: 0.5, slope: 0.3, lotW: [8, 14], lotD: [8, 14], gap: 2.2, setback: [1, 3], fill: 0.75, rows: 2, plazaR: [22, 30], wall: 0, fields: false, branchEvery: [30, 46], branchLen: [30, 90], roadW: { main: 5, street: 3.5, lane: 2.5 } },
  outpost:    { net: 'grid', mains: [2, 2], meander: 0.02, slope: 0.12, lotW: [8, 16], lotD: [8, 14], gap: 3, setback: [1.5, 4], fill: 0.7, rows: 1, plazaR: [18, 24], wall: 0, fields: false, gridStep: [40, 56], roadW: { main: 10, street: 6, lane: 4 } },
  gothic:     { net: 'organic', mains: [4, 5], meander: 0.3, slope: 0.22, lotW: [6, 9], lotD: [8, 12], gap: 0.1, setback: [0.1, 0.8], fill: 0.95, rows: 2, plazaR: [18, 26], wall: 1, fields: true, branchEvery: [24, 40], branchLen: [40, 130], roadW: { main: 6, street: 4, lane: 3 } },
  neon:       { net: 'grid', mains: [4, 4], meander: 0.03, slope: 0.15, lotW: [12, 24], lotD: [12, 22], gap: 1.0, setback: [0.5, 1.5], fill: 0.95, rows: 2, plazaR: [18, 24], wall: 0, fields: false, gridStep: [38, 52], roadW: { main: 12, street: 7, lane: 4 } },
  ruins:      { net: 'axial', mains: [2, 3], meander: 0.15, slope: 0.3, lotW: [8, 18], lotD: [8, 18], gap: 6, setback: [2, 8], fill: 0.45, rows: 1, plazaR: [24, 34], wall: 0.4, fields: false, branchEvery: [40, 70], branchLen: [30, 80], roadW: { main: 9, street: 5, lane: 3 } },
};

export const KIND_RADIUS = { megacity: 520, city: 360, town: 280, village: 190, outpost: 150, spaceport: 260, ruins: 230 };

/**
 * Plan a settlement.
 * frame: SiteFrame; style: architecture key; kind: site kind; seed: number; main: bool (capital)
 */
export function planSettlement(frame, style, kind, seed, opts = {}) {
  const P = PLAN_STYLE[style] || PLAN_STYLE.pastoral;
  const rng = new Random(seed);
  const noise = new SimplexNoise(seed);
  const radius = (opts.radius ?? KIND_RADIUS[kind] ?? 220);
  const plan = { style, kind, radius, center: [0, 0], roads: [], plazas: [], lots: [], fields: [], docks: [], wall: null, gates: [], spots: [], props: [], seed };
  const roadGrid = new SegGrid(16);
  const lotGrid = new BoxGrid(24);
  const H = (x, z) => frame.hAt(x, z);
  const wet = (x, z) => frame.wet(x, z, 0.8);

  // ---- center: flattest dry point near the origin
  let best = null;
  for (let k = 0; k < 40; k++) {
    const a = rng.range(0, TAU), r = k === 0 ? 0 : rng.range(0, radius * 0.22);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (wet(x, z)) continue;
    const fp = frame.footprint(x, z, 40, 40, 0, 4);
    if (fp.wet > 0) continue;
    const sc = (fp.max - fp.min) + r * 0.02;
    if (!best || sc < best.sc) best = { x, z, sc };
  }
  if (best) plan.center = [best.x, best.z];
  const [cx, cz] = plan.center;
  const plazaR = rng.range(...P.plazaR) * (opts.main ? 1.15 : 1) * (kind === 'village' || kind === 'outpost' ? 0.8 : 1);
  plan.plazas.push({ x: cx, z: cz, r: plazaR, kind: 'main' });
  const addRoad = (pts, w, kind2) => {
    if (pts.length < 2) return null;
    const id = plan.roads.length;
    const road = { pts, w, kind: kind2, id };
    plan.roads.push(road);
    for (let i = 0; i < pts.length - 1; i++) roadGrid.add(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w, id);
    return road;
  };

  // ---- grow a road over the terrain from (x, z) heading a
  const grow = (x, z, a, len, step, opt = {}) => {
    const pts = [[x, z]];
    let h = H(x, z), heading = a;
    const maxSlope = opt.slope ?? P.slope;
    const meander = opt.meander ?? P.meander;
    const wob = rng.range(0, 100);
    for (let s = 0; s < len; s += step) {
      let bestA = null, bestSc = Infinity, bx = 0, bz = 0, bh = 0;
      for (let k = -3; k <= 3; k++) {
        const ca = heading + k * 0.16 + noise.noise2(wob + s * 0.012, 3.7) * meander * 0.5;
        const nx = x + Math.cos(ca) * step, nz = z + Math.sin(ca) * step;
        const nh = H(nx, nz);
        const sl = Math.abs(nh - h) / step;
        let sc = sl * 6 + Math.abs(k) * 0.12 * (1 - meander) + (sl > maxSlope ? 10 : 0);
        if (wet(nx, nz)) sc += 100;
        if (opt.toward) { const dd = Math.hypot(opt.toward[0] - nx, opt.toward[1] - nz); sc += dd * 0.02; }
        if (sc < bestSc) { bestSc = sc; bestA = ca; bx = nx; bz = nz; bh = nh; }
      }
      if (bestSc >= 10) { if (opt.coast && bestSc >= 100) plan._coastHits.push([x, z, heading]); break; }
      if (Math.hypot(bx - cx, bz - cz) > (opt.maxR ?? radius)) break;
      // junction: stop when meeting another road
      if (opt.stopAtRoads && s >= step) {
        const q = roadGrid.query(bx, bz, 10, opt.parent ?? -1);
        if (q.d < 4.5) { pts.push([bx, bz]); break; }
        // also avoid running parallel along the parent
        const qp = roadGrid.query(bx, bz, 10);
        if (s > step * 2 && qp.d < 3) break;
      }
      heading = bestA * 0.6 + heading * 0.4 + (bestA - heading) * 0.0;
      heading = bestA;
      x = bx; z = bz; h = bh;
      pts.push([x, z]);
    }
    return pts;
  };
  plan._coastHits = [];

  const mains = [];
  if (P.net === 'grid') {
    // Orthogonal grid aligned to a random axis, clipped to dry, gentle ground.
    const step = rng.range(...P.gridStep) * (kind === 'outpost' || kind === 'village' ? 0.85 : 1);
    const ax = rng.range(0, Math.PI / 2);
    const n = Math.ceil(radius / step);
    const lines = [];
    for (let i = -n; i <= n; i++) {
      for (const dir of [0, 1]) {
        const off = i * step;
        const pts = [];
        const L = Math.sqrt(Math.max(0, radius * radius - off * off));
        if (L < step * 0.7) continue;
        for (let t = -L; t <= L + 0.01; t += 6) {
          const [u, v] = dir ? [off, t] : [t, off];
          const [x, z] = planRot(u, v, ax);
          const X = cx + x, Z = cz + z;
          const ok = !wet(X, Z) && Math.abs(H(X, Z) - H(cx, cz)) < radius * 0.25;
          if (ok) pts.push([X, Z]);
          else if (pts.length) { lines.push({ pts: pts.slice(), main: i === 0 || Math.abs(i) === Math.round(n / 2) }); pts.length = 0; }
        }
        if (pts.length) lines.push({ pts: pts.slice(), main: i === 0 || Math.abs(i) === Math.round(n / 2) });
      }
    }
    for (const l of lines) {
      if (l.pts.length < 3) continue;
      const r = addRoad(l.pts, l.main ? P.roadW.main : P.roadW.street, l.main ? 'avenue' : 'street');
      if (l.main && r) mains.push(r);
    }
    plan.gridAxis = ax; plan.gridStep = step;
  } else {
    const nm = rng.int(...P.mains);
    const a0 = rng.range(0, TAU);
    const axial = P.net === 'axial';
    for (let i = 0; i < nm; i++) {
      let a = a0 + (i / nm) * TAU + rng.range(-0.3, 0.3) * (axial ? 0.2 : 1);
      if (axial && i === 0) a = a0;
      const sx = cx + Math.cos(a) * plazaR * 0.9, sz = cz + Math.sin(a) * plazaR * 0.9;
      const len = radius * (axial && i === 0 ? 1.05 : rng.range(0.8, 1.05));
      const pts = grow(sx, sz, a, len, 6, { coast: true, meander: axial && i === 0 ? 0.08 : P.meander, slope: P.slope * (axial && i === 0 ? 1.6 : 1) });
      const r = addRoad(pts, axial && i === 0 ? P.roadW.main * 1.3 : P.roadW.main, axial && i === 0 ? 'avenue' : 'main');
      if (r) mains.push(r);
    }
    // a road down to the nearest shore (harbour)
    const shore = findShore(frame, cx, cz, radius * 1.7);
    if (shore) {
      const a = Math.atan2(shore[1] - cz, shore[0] - cx);
      const sx = cx + Math.cos(a) * plazaR * 0.9, sz = cz + Math.sin(a) * plazaR * 0.9;
      const pts = grow(sx, sz, a, radius * 1.8, 6, { coast: true, toward: shore, maxR: radius * 1.8, slope: P.slope * 1.5, meander: 0.15 });
      const r = addRoad(pts, P.roadW.main, 'main');
      if (r) { mains.push(r); plan.harbourRoad = r; }
      plan.shore = shore;
    }
    // ring roads between neighbouring mains
    if (P.net !== 'axial' || rng.chance(0.5)) {
      const rr = radius * rng.range(0.38, 0.5);
      const pts = [];
      for (let k = 0; k <= 72; k++) {
        const a = (k / 72) * TAU + a0;
        const r = rr * (1 + 0.12 * noise.noise2(Math.cos(a) * 1.3, Math.sin(a) * 1.3));
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        const ok = !wet(x, z) && Math.abs(H(x, z) - H(cx, cz)) < 40;
        if (ok) pts.push([x, z]);
        else if (pts.length) { if (pts.length > 4) addRoad(pts.slice(), P.roadW.street, 'street'); pts.length = 0; }
      }
      if (pts.length > 4) addRoad(pts, P.roadW.street, 'street');
    }
    // branches off mains and off branches (two generations)
    const gen = (parents, depth) => {
      const out = [];
      for (const road of parents) {
        let acc = rng.range(...P.branchEvery) * 0.6;
        let s = 0;
        for (let i = 1; i < road.pts.length; i++) {
          const [ax, az] = road.pts[i - 1], [bx, bz] = road.pts[i];
          const sl = Math.hypot(bx - ax, bz - az);
          s += sl;
          if (s < acc) continue;
          acc = s + rng.range(...P.branchEvery) * (1 + depth * 0.4);
          const dist = Math.hypot(bx - cx, bz - cz) / radius;
          if (dist > 0.92) continue;
          const head = Math.atan2(bz - az, bx - ax);
          for (const side of [-1, 1]) {
            if (!rng.chance(0.62 - depth * 0.22)) continue;
            const a = head + side * (Math.PI / 2 + rng.range(-0.35, 0.35));
            const len = rng.range(...P.branchLen) * (1 - dist * 0.5) / (1 + depth * 0.6);
            const st = [bx + Math.cos(a) * road.w * 0.5, bz + Math.sin(a) * road.w * 0.5];
            const pts = grow(st[0], st[1], a, len, 5, { stopAtRoads: true, parent: road.id, slope: P.slope * 1.2 });
            pts.unshift([bx, bz]);
            if (pts.length >= 4) {
              const r = addRoad(pts, depth === 0 ? P.roadW.street : P.roadW.lane, depth === 0 ? 'street' : 'lane');
              if (r) out.push(r);
            }
          }
        }
      }
      return out;
    };
    const g1 = gen(mains, 0);
    gen(g1, 1);
  }
  plan.mains = mains;

  // ---- secondary plazas at a few points on main roads
  for (const m of mains) {
    if (m.pts.length < 20 || !rng.chance(0.55)) continue;
    const p = m.pts[Math.floor(m.pts.length * rng.range(0.35, 0.6))];
    if (wet(p[0], p[1])) continue;
    plan.plazas.push({ x: p[0], z: p[1], r: rng.range(8, 13), kind: 'square' });
  }

  // ---- reserve plazas against lots
  for (const pz of plan.plazas) lotGrid.add({ x: pz.x, z: pz.z, w: pz.r * 1.9, d: pz.r * 1.9, yaw: 0, pad: 0, reserved: true });
  // landmark / reserved zones requested by the caller
  const reserved = typeof opts.reserve === 'function' ? opts.reserve(plan.center, plazaR) : (opts.reserve || []);
  for (const r of reserved) lotGrid.add({ x: r.x, z: r.z, w: r.w, d: r.d, yaw: r.yaw || 0, pad: 0, reserved: true });

  // ---- lots along roads
  const tryLot = (x, z, yaw, w, d, zone, road, extra = {}) => {
    const lot = { x, z, yaw, w, d, pad: P.gap * 0.5, zone, road };
    if (Math.hypot(x - cx, z - cz) > radius * 1.02) return null;
    if (lotGrid.hits(lot)) return null;
    // keep clear of roads
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const probe = [[0, 0], [-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2], [0, d / 2], [0, -d / 2], [w / 2, 0], [-w / 2, 0]];
    for (const [u, v] of probe) {
      const px = x + u * c + v * s, pz = z - u * s + v * c;
      if (roadGrid.query(px, pz, 6).d < 0.3) return null;
      if (wet(px, pz)) return null;
    }
    const fp = frame.footprint(x, z, w, d, yaw, 3);
    const rel = fp.max - fp.min;
    if (rel > Math.max(w, d) * (P.slope * 1.6) + 1.2 && !extra.allowSteep) return null;
    Object.assign(lot, { base: fp.max, low: fp.min, mean: fp.mean, slope: rel }, extra);
    lotGrid.add(lot);
    plan.lots.push(lot);
    return lot;
  };

  for (const road of plan.roads) {
    const pts = road.pts;
    let s = 0, next = rng.range(0, 3);
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      const L = Math.hypot(bx - ax, bz - az); if (L < 1e-3) continue;
      const tx = (bx - ax) / L, tz = (bz - az) / L;
      while (next < s + L) {
        const t = (next - s) / L;
        const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
        const dist = Math.hypot(px - cx, pz - cz) / radius;
        const dens = 1 - dist * dist * 0.85;
        let w = rng.range(...P.lotW), d = rng.range(...P.lotD);
        if (dist < 0.3) { const k = P.coreScale ?? 1.1; w *= k; d *= k; }
        for (const side of [-1, 1]) {
          if (P.net === 'grid' && road.kind !== 'avenue') continue;
          if (!rng.chance(P.fill * dens)) continue;
          const nx = -tz * side, nz = tx * side; // outward normal
          for (let row = 0; row < P.rows; row++) {
            const sb = rng.range(...P.setback) + row * (d + P.gap + rng.range(0.5, 3));
            if (row > 0 && (dist > 0.75 || !rng.chance(dist < 0.4 ? 0.85 : 0.55))) break;
            const off = road.w * 0.5 + sb + d * 0.5;
            const lx = px + nx * off + tx * rng.range(-1, 1) * row, lz = pz + nz * off + tz * rng.range(-1, 1) * row;
            // front (+Z') faces the road: direction (-nx, -nz)
            const yaw = Math.atan2(-nx, -nz) + (P.net === 'grid' ? 0 : rng.range(-0.06, 0.06));
            tryLot(lx, lz, yaw, w, d, dist, road.id, { row });
          }
        }
        next += w + P.gap + rng.range(0, 1.5);
      }
      s += L;
    }
  }
  // grid nets: subdivide blocks into parcels
  if (P.net === 'grid') {
    const step = plan.gridStep, ax = plan.gridAxis;
    const n = Math.ceil(radius / step);
    for (let i = -n; i < n; i++) for (let j = -n; j < n; j++) {
      const [ox, oz] = planRot((i + 0.5) * step, (j + 0.5) * step, ax);
      const bx = cx + ox, bz = cz + oz;
      const dist = Math.hypot(ox, oz) / radius;
      if (dist > 0.98) continue;
      const inner = step - P.roadW.street - 2;
      const sx = rng.chance(0.5) ? 1 : rng.int(1, 2), sz = rng.int(1, 3);
      for (let a = 0; a < sx; a++) for (let b = 0; b < sz; b++) {
        if (!rng.chance(P.fill * (1 - dist * 0.4))) continue;
        const pw = inner / sx, pd = inner / sz;
        const u = -inner / 2 + pw * (a + 0.5), v = -inner / 2 + pd * (b + 0.5);
        const [px, pz] = planRot(u, v, ax);
        // face the nearest block edge
        const fu = Math.abs(u) / inner, fv = Math.abs(v) / inner;
        const yaw = ax + (fv >= fu ? (v > 0 ? 0 : Math.PI) : (u > 0 ? Math.PI / 2 : -Math.PI / 2));
        const across = fv >= fu;
        const w = (across ? pw : pd) - P.gap - rng.range(0, 2), d = (across ? pd : pw) - P.gap - rng.range(0, 2);
        tryLot(bx + px, bz + pz, yaw, Math.max(6, w), Math.max(6, d), dist, -1, { block: true });
      }
    }
  }
  // plaza frontage: buildings facing the main plaza
  for (const pz of plan.plazas) {
    const n = Math.floor((TAU * (pz.r + 6)) / 9);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU + rng.range(-0.05, 0.05);
      const w = rng.range(...P.lotW) * 1.05, d = rng.range(...P.lotD);
      const r = pz.r + 1.2 + d / 2;
      const x = pz.x + Math.cos(a) * r, z = pz.z + Math.sin(a) * r;
      tryLot(x, z, Math.atan2(-Math.cos(a), -Math.sin(a)), w, d, Math.hypot(x - cx, z - cz) / radius, -1, { plaza: true });
    }
  }
  // fill: scattered infill lots between roads in the inner zone (dense towns)
  const infill = Math.floor(plan.lots.length * (P.fill > 0.9 ? 0.35 : 0.15));
  for (let k = 0; k < infill * 4 && k < 4000; k++) {
    if (plan.lots.length > 900) break;
    const a = rng.range(0, TAU), r = Math.sqrt(rng.float()) * radius * 0.8;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    const q = roadGrid.query(x, z, 30);
    if (q.d > 26 || !q.seg) continue;
    const s = q.seg, ang = Math.atan2(s.bz - s.az, s.bx - s.ax);
    // face the nearest road
    const tx = Math.cos(ang), tz = Math.sin(ang);
    const vx = x - s.ax, vz = z - s.az;
    const side = Math.sign(vx * -tz + vz * tx) || 1;
    tryLot(x, z, Math.atan2(tz * side, -tx * side), rng.range(...P.lotW), rng.range(...P.lotD), r / radius, s.id, { infill: true });
  }

  // ---- walls (towns/cities only)
  if (rng.chance(P.wall) && kind !== 'village' && kind !== 'outpost') {
    let maxR = 0;
    for (const l of plan.lots) maxR = Math.max(maxR, Math.hypot(l.x - cx, l.z - cz));
    const wr = Math.min(radius, maxR * 0.8 + 12);
    const pts = [];
    const n = Math.max(12, Math.floor(wr / 9));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      let r = wr * (1 + 0.08 * noise.noise2(Math.cos(a) * 1.7 + 9, Math.sin(a) * 1.7));
      let x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (wet(x, z)) { pts.push(null); continue; }
      pts.push([x, z]);
    }
    plan.wall = { pts, r: wr };
    // gates where mains cross the wall
    for (const m of mains) {
      for (let i = 1; i < m.pts.length; i++) {
        const r0 = Math.hypot(m.pts[i - 1][0] - cx, m.pts[i - 1][1] - cz), r1 = Math.hypot(m.pts[i][0] - cx, m.pts[i][1] - cz);
        if (r0 < wr * 0.97 && r1 >= wr * 0.97) {
          const [x, z] = m.pts[i];
          plan.gates.push({ x, z, yaw: Math.atan2(m.pts[i][0] - m.pts[i - 1][0], m.pts[i][1] - m.pts[i - 1][1]), w: m.w });
          break;
        }
      }
    }
  }

  // ---- fields & countryside
  if (P.fields) {
    const nf = kind === 'village' ? 50 : 90;
    for (let k = 0; k < nf; k++) {
      const a = rng.range(0, TAU), r = radius * rng.range(0.55, 1.45);
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const w = rng.range(26, 60), d = rng.range(18, 40), yaw = a + rng.range(-0.3, 0.3);
      const fp = frame.footprint(x, z, w, d, yaw, 3);
      if (fp.wet > 0 || fp.max - fp.min > Math.max(w, d) * 0.22) continue;
      const lot = { x, z, w, d, yaw, pad: 2 };
      if (lotGrid.hits(lot)) continue;
      if (roadGrid.query(x, z, 40).d < Math.max(w, d) * 0.55) continue;
      lotGrid.add(lot);
      plan.fields.push({ x, z, w, d, yaw, kind: rng.int(0, 5) });
    }
  }

  // ---- docks where roads met the water
  for (const [x, z, a] of plan._coastHits) {
    if (plan.docks.length >= 4) break;
    if (plan.docks.some((d) => Math.hypot(d.x - x, d.z - z) < 40)) continue;
    // measure how far the water extends
    let len = 0;
    for (let t = 2; t < 60; t += 2) { if (!wet(x + Math.cos(a) * t, z + Math.sin(a) * t)) { if (t > 8) break; } else len = t; }
    if (len < 8) continue;
    plan.docks.push({ x, z, yaw: Math.atan2(Math.cos(a), Math.sin(a)), len: Math.min(len + 6, 46) });
  }

  // ---- high spots (for landmarks, windmills, shrines)
  const cand = [];
  for (let k = 0; k < 160; k++) {
    const a = rng.range(0, TAU), r = radius * rng.range(0.3, 1.5);
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    if (wet(x, z)) continue;
    const h = H(x, z);
    const fp = frame.footprint(x, z, 16, 16, 0, 3);
    if (fp.max - fp.min > 6) continue;
    if (lotGrid.hits({ x, z, w: 10, d: 10, yaw: 0, pad: 1 })) continue;
    if (roadGrid.query(x, z, 10).d < 3) continue;
    cand.push({ x, z, h, r });
  }
  cand.sort((a, b) => b.h - a.h);
  plan.spots = cand.slice(0, 24);

  // built-up radius
  let br = plazaR;
  for (const l of plan.lots) br = Math.max(br, Math.hypot(l.x - cx, l.z - cz));
  plan.builtRadius = br;
  plan.roadGrid = roadGrid;
  plan.lotGrid = lotGrid;
  delete plan._coastHits;
  return plan;
}

/** Nearest shoreline point (plan coords) within maxR, or null. */
function findShore(frame, cx, cz, maxR) {
  if (!Number.isFinite(frame.sea)) return null;
  for (let r = 30; r <= maxR; r += 15) {
    let best = null;
    const n = Math.max(12, Math.floor(r / 6));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (frame.wet(x, z, 0.5)) { best = [x, z]; break; }
    }
    if (best) return best;
  }
  return null;
}
