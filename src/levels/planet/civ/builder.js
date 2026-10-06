// MeshBuilder — accumulates architecture into growable typed arrays.
//
// Every vertex carries, besides position/normal:
//   color  (vec3)  base albedo, linear
//   aFac   (vec2)  "facade space" in meters: u along the surface, v up / along the slope
//   aMat   (vec4)  x material id (see ids.js), y seed 0..1, z window style, w floor height (m)
//   aExt   (vec4)  x baked occlusion (1 = open), y face width (m), z flags, w wall height (m)
// The building shader (materials.js) turns these into stone courses, plaster,
// roof tiles, windows that light up at dusk, … so geometry stays light while
// facades stay rich. Primitives are authored in a local frame (Y up, the
// building front facing +Z) and transformed by the current matrix.

import * as THREE from 'three';

const _v = new THREE.Vector3(), _n = new THREE.Vector3();

export class MeshBuilder {
  constructor(cap = 4096) {
    this.cap = 0; this.icap = 0;
    this.n = 0; this.ni = 0;
    this._grow(cap, cap * 2);
    this.m = new THREE.Matrix4();
    this.nm = new THREE.Matrix3();
    this.ident = true;
    this.c = [0.8, 0.8, 0.8];
    this.a = [0, 0, 0, 3];
    this.e = [1, 0, 0, 0];
  }

  _grow(nv, ni) {
    if (nv > this.cap) {
      const cap = Math.max(nv, Math.ceil(this.cap * 1.7) + 1024);
      const re = (old, k) => { const a = new Float32Array(cap * k); if (old) a.set(old.subarray(0, this.n * k)); return a; };
      this.P = re(this.P, 3); this.N = re(this.N, 3); this.C = re(this.C, 3);
      this.F = re(this.F, 2); this.A = re(this.A, 4); this.E = re(this.E, 4);
      this.cap = cap;
    }
    if (ni > this.icap) {
      const cap = Math.max(ni, Math.ceil(this.icap * 1.7) + 2048);
      const a = new Uint32Array(cap); if (this.I) a.set(this.I.subarray(0, this.ni)); this.I = a; this.icap = cap;
    }
  }

  setMatrix(m) { this.m.copy(m); this.nm.getNormalMatrix(m); this.ident = false; return this; }
  resetMatrix() { this.m.identity(); this.nm.identity(); this.ident = true; return this; }
  color(r, g, b) { if (r.isColor) { this.c[0] = r.r; this.c[1] = r.g; this.c[2] = r.b; } else { this.c[0] = r; this.c[1] = g; this.c[2] = b; } return this; }
  mat(id, seed = this.a[1], win = 0, floorH = this.a[3]) { this.a[0] = id; this.a[1] = seed; this.a[2] = win; this.a[3] = floorH; return this; }
  ext(ao = 1, faceW = 0, flags = 0, wallH = 0) { this.e[0] = ao; this.e[1] = faceW; this.e[2] = flags; this.e[3] = wallH; return this; }

  /** Push one vertex (local coords), returns its index. */
  v(x, y, z, nx, ny, nz, u, w) {
    if (this.n >= this.cap) this._grow(this.n + 1, 0);
    const i = this.n++;
    if (this.ident) { _v.set(x, y, z); _n.set(nx, ny, nz); }
    else { _v.set(x, y, z).applyMatrix4(this.m); _n.set(nx, ny, nz).applyMatrix3(this.nm).normalize(); }
    const P = this.P, N = this.N, i3 = i * 3;
    P[i3] = _v.x; P[i3 + 1] = _v.y; P[i3 + 2] = _v.z;
    N[i3] = _n.x; N[i3 + 1] = _n.y; N[i3 + 2] = _n.z;
    this.C[i3] = this.c[0]; this.C[i3 + 1] = this.c[1]; this.C[i3 + 2] = this.c[2];
    this.F[i * 2] = u; this.F[i * 2 + 1] = w;
    const i4 = i * 4, A = this.A, E = this.E;
    A[i4] = this.a[0]; A[i4 + 1] = this.a[1]; A[i4 + 2] = this.a[2]; A[i4 + 3] = this.a[3];
    E[i4] = this.e[0]; E[i4 + 1] = this.e[1]; E[i4 + 2] = this.e[2]; E[i4 + 3] = this.e[3];
    return i;
  }
  tri(a, b, c) { if (this.ni + 3 > this.icap) this._grow(0, this.ni + 3); const I = this.I; I[this.ni++] = a; I[this.ni++] = b; I[this.ni++] = c; }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }

  /** Generic flat quad p0..p3 (CCW seen from the front) with explicit facade coords. */
  quadP(p0, p1, p2, p3, uv0, uv1, uv2, uv3, want = null) {
    _n.copy(p1).sub(p0).cross(_v.copy(p2).sub(p0));
    if (_n.lengthSq() < 1e-12) _n.copy(p2).sub(p0).cross(_v.copy(p3).sub(p0));
    _n.normalize();
    if (want && _n.dot(want) < 0) {
      // reverse winding to face `want`
      const t0 = [p0.x, p0.y, p0.z], t1 = [p1.x, p1.y, p1.z], t2 = [p2.x, p2.y, p2.z], t3 = [p3.x, p3.y, p3.z];
      const q0 = new THREE.Vector3(...t0), q1 = new THREE.Vector3(...t3), q2 = new THREE.Vector3(...t2), q3 = new THREE.Vector3(...t1);
      return this.quadP(q0, q1, q2, q3, uv0, uv3, uv2, uv1, null);
    }
    const nx = _n.x, ny = _n.y, nz = _n.z;
    const a = this.v(p0.x, p0.y, p0.z, nx, ny, nz, uv0[0], uv0[1]);
    const b = this.v(p1.x, p1.y, p1.z, nx, ny, nz, uv1[0], uv1[1]);
    const c = this.v(p2.x, p2.y, p2.z, nx, ny, nz, uv2[0], uv2[1]);
    const d = this.v(p3.x, p3.y, p3.z, nx, ny, nz, uv3[0], uv3[1]);
    this.quad(a, b, c, d);
  }
  triP(p0, p1, p2, uv0, uv1, uv2) {
    _n.copy(p1).sub(p0).cross(_v.copy(p2).sub(p0)).normalize();
    const a = this.v(p0.x, p0.y, p0.z, _n.x, _n.y, _n.z, uv0[0], uv0[1]);
    const b = this.v(p1.x, p1.y, p1.z, _n.x, _n.y, _n.z, uv1[0], uv1[1]);
    const c = this.v(p2.x, p2.y, p2.z, _n.x, _n.y, _n.z, uv2[0], uv2[1]);
    this.tri(a, b, c);
  }

  /**
   * Vertical wall from L=(x0,z0) to R=(x1,z1) as seen from outside, y0..y1.
   * Facade u runs -W/2..W/2 left→right, v = y - base.
   */
  wall(x0, z0, x1, z1, y0, y1, base = 0, flags = 0, wallH = null) {
    const dx = x1 - x0, dz = z1 - z0, W = Math.hypot(dx, dz);
    if (W < 1e-4) return;
    const nx = -dz / W, nz = dx / W;
    const e = this.e, sw = e[1], sf = e[2], sh = e[3];
    e[1] = W; e[2] = flags; e[3] = wallH ?? (y1 - base);
    const a = this.v(x0, y0, z0, nx, 0, nz, -W / 2, y0 - base);
    const b = this.v(x1, y0, z1, nx, 0, nz, W / 2, y0 - base);
    const c = this.v(x1, y1, z1, nx, 0, nz, W / 2, y1 - base);
    const d = this.v(x0, y1, z0, nx, 0, nz, -W / 2, y1 - base);
    this.quad(a, b, c, d);
    e[1] = sw; e[2] = sf; e[3] = sh;
  }

  /** Axis-aligned box in local space. opts: { top, bottom, base, front (flags for +Z face), wallH, topMat:[id,…], sides:[+z,+x,-z,-x] } */
  box(x0, y0, z0, x1, y1, z1, o = {}) {
    const base = o.base ?? y0, wh = o.wallH ?? null;
    const sides = o.sides || [true, true, true, true];
    if (sides[0]) this.wall(x0, z1, x1, z1, y0, y1, base, o.front ?? 0, wh); // +Z
    if (sides[1]) this.wall(x1, z1, x1, z0, y0, y1, base, o.right ?? 0, wh); // +X
    if (sides[2]) this.wall(x1, z0, x0, z0, y0, y1, base, o.back ?? 0, wh); // -Z
    if (sides[3]) this.wall(x0, z0, x0, z1, y0, y1, base, o.left ?? 0, wh); // -X
    if (o.top !== false) {
      const sa = this.a.slice();
      if (o.topMat) this.mat(...o.topMat);
      const a = this.v(x0, y1, z1, 0, 1, 0, x0, z1), b = this.v(x1, y1, z1, 0, 1, 0, x1, z1);
      const c = this.v(x1, y1, z0, 0, 1, 0, x1, z0), d = this.v(x0, y1, z0, 0, 1, 0, x0, z0);
      this.quad(a, b, c, d);
      this.a = sa;
    }
    if (o.bottom) {
      const a = this.v(x0, y0, z0, 0, -1, 0, x0, z0), b = this.v(x1, y0, z0, 0, -1, 0, x1, z0);
      const c = this.v(x1, y0, z1, 0, -1, 0, x1, z1), d = this.v(x0, y0, z1, 0, -1, 0, x0, z1);
      this.quad(a, b, c, d);
    }
  }

  /** Centered box helper: center x,z, base y, size w (x) × h × d (z). */
  boxC(cx, y0, cz, w, h, d, o = {}) { this.box(cx - w / 2, y0, cz - d / 2, cx + w / 2, y0 + h, cz + d / 2, o); }

  /** Oriented slab between two points on the ground plane (for walls, beams): from (ax,az) to (bx,bz), thickness t, y0..y1. */
  slab(ax, az, bx, bz, t, y0, y1, o = {}) {
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    if (L < 1e-3) return;
    const px = (-dz / L) * t * 0.5, pz = (dx / L) * t * 0.5;
    const base = o.base ?? y0;
    // outward faces: left side (+perp) and right side
    this.wall(bx + px, bz + pz, ax + px, az + pz, y0, y1, base, o.flags ?? 0, o.wallH);
    this.wall(ax - px, az - pz, bx - px, bz - pz, y0, y1, base, o.flags ?? 0, o.wallH);
    if (o.ends !== false) {
      this.wall(ax + px, az + pz, ax - px, az - pz, y0, y1, base, 0, o.wallH);
      this.wall(bx - px, bz - pz, bx + px, bz + pz, y0, y1, base, 0, o.wallH);
    }
    if (o.top !== false) {
      const sa = this.a.slice();
      if (o.topMat) this.mat(...o.topMat);
      const a = this.v(ax - px, y1, az - pz, 0, 1, 0, 0, -t / 2), b = this.v(bx - px, y1, bz - pz, 0, 1, 0, L, -t / 2);
      const c = this.v(bx + px, y1, bz + pz, 0, 1, 0, L, t / 2), d = this.v(ax + px, y1, az + pz, 0, 1, 0, 0, t / 2);
      this.quad(a, b, c, d);
      this.a = sa;
    }
  }

  /**
   * Gable roof over [x0,x1]×[z0,z1], ridge along X. Eave height yE, ridge height yE+rise.
   * over = eave overhang, overG = gable overhang. roofMat = [id, seed, win, fh] for the slopes;
   * the gable triangles use the current material (walls). thick = roof slab thickness.
   */
  gableRoof(x0, z0, x1, z1, yE, rise, o = {}) {
    const over = o.over ?? 0.5, overG = o.overG ?? 0.35, thick = o.thick ?? 0.18, base = o.base ?? 0;
    const zc = (z0 + z1) / 2, hd = (z1 - z0) / 2;
    const slope = rise / hd;
    const yR = yE + rise;
    const yEo = yE - over * slope; // eave edge lowered by overhang
    const wallMat = this.a.slice(), wallCol = this.c.slice();
    // gable triangles (walls) — u centered, v continues above the eave
    const W = z1 - z0;
    const e = this.e, sw = e[1], sh = e[3], sf = e[2];
    e[1] = W; e[3] = yE - base; e[2] = (o.gableFlags ?? 0) | 2; // flag 2 = gable region
    _n.set(1, 0, 0);
    {
      const a = this.v(x1, yE, z1, 1, 0, 0, -W / 2, yE - base), b = this.v(x1, yE, z0, 1, 0, 0, W / 2, yE - base), c = this.v(x1, yR, zc, 1, 0, 0, 0, yR - base);
      this.tri(a, b, c);
      const a2 = this.v(x0, yE, z0, -1, 0, 0, -W / 2, yE - base), b2 = this.v(x0, yE, z1, -1, 0, 0, W / 2, yE - base), c2 = this.v(x0, yR, zc, -1, 0, 0, 0, yR - base);
      this.tri(a2, b2, c2);
    }
    e[1] = sw; e[3] = sh; e[2] = sf;
    // slopes
    if (o.roofMat) this.mat(...o.roofMat);
    if (o.roofColor) this.color(o.roofColor);
    const L = Math.hypot(hd + over, rise + over * slope);
    const RX0 = x0 - overG, RX1 = x1 + overG, RW = RX1 - RX0;
    e[1] = RW; e[3] = L;
    const fy = hd / Math.hypot(hd, rise), fz = rise / Math.hypot(hd, rise);
    // front slope (+Z), CCW from outside: eave-left, eave-right, ridge-right, ridge-left
    {
      const a = this.v(RX0, yEo, z1 + over, 0, fy, fz, -RW / 2, 0), b = this.v(RX1, yEo, z1 + over, 0, fy, fz, RW / 2, 0);
      const c = this.v(RX1, yR, zc, 0, fy, fz, RW / 2, L), d = this.v(RX0, yR, zc, 0, fy, fz, -RW / 2, L);
      this.quad(a, b, c, d);
    }
    // back slope (-Z)
    {
      const a = this.v(RX1, yEo, z0 - over, 0, fy, -fz, -RW / 2, 0), b = this.v(RX0, yEo, z0 - over, 0, fy, -fz, RW / 2, 0);
      const c = this.v(RX0, yR, zc, 0, fy, -fz, RW / 2, L), d = this.v(RX1, yR, zc, 0, fy, -fz, -RW / 2, L);
      this.quad(a, b, c, d);
    }
    // thickness: fascia along eaves and verge (barge) boards, soffits
    if (thick > 0) {
      const sa = this.a.slice(), sc = this.c.slice();
      if (o.trimMat) this.mat(...o.trimMat); if (o.trimColor) this.color(o.trimColor);
      e[3] = 0; e[1] = RW;
      // eave fascias
      this.quadP(_p(RX0, yEo - thick, z1 + over), _p(RX1, yEo - thick, z1 + over), _p(RX1, yEo, z1 + over), _p(RX0, yEo, z1 + over), [-RW / 2, 0], [RW / 2, 0], [RW / 2, thick], [-RW / 2, thick]);
      this.quadP(_p(RX1, yEo - thick, z0 - over), _p(RX0, yEo - thick, z0 - over), _p(RX0, yEo, z0 - over), _p(RX1, yEo, z0 - over), [-RW / 2, 0], [RW / 2, 0], [RW / 2, thick], [-RW / 2, thick]);
      // verge boards (gable edges): thin strips following the slope
      for (const [x, s] of [[RX1, 1], [RX0, -1]]) {
        const zA = z1 + over, zB = z0 - over;
        const want = new THREE.Vector3(s, 0, 0);
        this.quadP(_p(x, yEo - thick, zA), _p(x, yEo, zA), _p(x, yR, zc), _p(x, yR - thick, zc), [0, 0], [0, thick], [L, thick], [L, 0], want);
        this.quadP(_p(x, yR - thick, zc), _p(x, yR, zc), _p(x, yEo, zB), _p(x, yEo - thick, zB), [0, 0], [0, thick], [L, thick], [L, 0], want);
      }
      // soffits (underside), slightly darker via occlusion
      const so = e[0]; e[0] = 0.45;
      this.quadP(_p(RX1, yEo - thick, z1 + over), _p(RX0, yEo - thick, z1 + over), _p(RX0, yE - thick, z1), _p(RX1, yE - thick, z1), [0, 0], [RW, 0], [RW, over], [0, over]);
      this.quadP(_p(RX0, yEo - thick, z0 - over), _p(RX1, yEo - thick, z0 - over), _p(RX1, yE - thick, z0), _p(RX0, yE - thick, z0), [0, 0], [RW, 0], [RW, over], [0, over]);
      e[0] = so;
      this.a = sa; this.c = sc;
    }
    // ridge cap
    if (o.ridge !== false) {
      const sa = this.a.slice();
      const rw = o.ridgeW ?? 0.22;
      this.e[3] = 0;
      this.box(RX0, yR - 0.05, zc - rw / 2, RX1, yR + rw * 0.6, zc + rw / 2, { base: yR });
      this.a = sa;
    }
    e[1] = sw; e[3] = sh; e[2] = sf;
    this.a = wallMat; this.c = wallCol;
  }

  /** Hip roof (4 slopes) over a rectangle; ridge along the longer side. */
  hipRoof(x0, z0, x1, z1, yE, rise, o = {}) {
    const over = o.over ?? 0.5, thick = o.thick ?? 0.16;
    const X0 = x0 - over, X1 = x1 + over, Z0 = z0 - over, Z1 = z1 + over;
    const w = X1 - X0, d = Z1 - Z0;
    const slope = rise / (Math.min(x1 - x0, z1 - z0) / 2);
    const yEo = yE - over * slope;
    const R = rise + over * slope;
    const yR = yEo + R;
    const alongX = w >= d;
    const h = (alongX ? d : w) / 2;
    const cx = (X0 + X1) / 2, cz = (Z0 + Z1) / 2;
    const r0 = alongX ? [X0 + h, cz] : [cx, Z0 + h];
    const r1 = alongX ? [X1 - h, cz] : [cx, Z1 - h];
    const sa = this.a.slice();
    if (o.roofMat) this.mat(...o.roofMat);
    if (o.roofColor) this.color(o.roofColor);
    const L = Math.hypot(h, R);
    const e = this.e, sw = e[1], sh = e[3];
    const corners = [[X0, Z1], [X1, Z1], [X1, Z0], [X0, Z0]]; // CCW from above starting front-left
    // faces: front (+Z), right (+X), back (-Z), left (-X)
    const ridgeFor = (i) => {
      // returns [left ridge point, right ridge point] for face i
      if (alongX) {
        if (i === 0) return [r0, r1]; if (i === 1) return [r1, r1]; if (i === 2) return [r1, r0]; return [r0, r0];
      }
      if (i === 0) return [r1, r1]; if (i === 1) return [r1, r0]; if (i === 2) return [r0, r0]; return [r0, r1];
    };
    for (let i = 0; i < 4; i++) {
      const A = corners[i], B = corners[(i + 1) % 4];
      const [RL, RR] = ridgeFor(i);
      const W = Math.hypot(B[0] - A[0], B[1] - A[1]);
      e[1] = W; e[3] = L;
      const p0 = _p(A[0], yEo, A[1]), p1 = _p(B[0], yEo, B[1]), p2 = _p(RR[0], yR, RR[1]), p3 = _p(RL[0], yR, RL[1]);
      // project ridge points onto u axis for facade coords
      const ux = (B[0] - A[0]) / W, uz = (B[1] - A[1]) / W;
      const uR = (RR[0] - A[0]) * ux + (RR[1] - A[1]) * uz - W / 2, uL = (RL[0] - A[0]) * ux + (RL[1] - A[1]) * uz - W / 2;
      if (Math.abs(RL[0] - RR[0]) + Math.abs(RL[1] - RR[1]) < 1e-4) this.triP(p0, p1, p2, [-W / 2, 0], [W / 2, 0], [uR, L]);
      else this.quadP(p0, p1, p2, p3, [-W / 2, 0], [W / 2, 0], [uR, L], [uL, L]);
    }
    if (thick > 0) {
      if (o.trimMat) this.mat(...o.trimMat); if (o.trimColor) this.color(o.trimColor);
      e[3] = 0;
      for (let i = 0; i < 4; i++) {
        const A = corners[i], B = corners[(i + 1) % 4];
        const W = Math.hypot(B[0] - A[0], B[1] - A[1]); e[1] = W;
        this.quadP(_p(A[0], yEo - thick, A[1]), _p(B[0], yEo - thick, B[1]), _p(B[0], yEo, B[1]), _p(A[0], yEo, A[1]), [-W / 2, 0], [W / 2, 0], [W / 2, thick], [-W / 2, thick]);
      }
      const so = e[0]; e[0] = 0.45;
      // soffit as one quad ring approximated by a flat underside
      this.quadP(_p(X0, yEo - thick, Z0), _p(X1, yEo - thick, Z0), _p(X1, yEo - thick, Z1), _p(X0, yEo - thick, Z1), [0, 0], [w, 0], [w, d], [0, d]);
      e[0] = so;
    }
    if (o.ridge !== false && (Math.abs(r0[0] - r1[0]) + Math.abs(r0[1] - r1[1]) > 0.1)) {
      const rw = o.ridgeW ?? 0.22;
      e[3] = 0;
      if (alongX) this.box(r0[0], yR - 0.05, cz - rw / 2, r1[0], yR + rw * 0.6, cz + rw / 2, { base: yR });
      else this.box(cx - rw / 2, yR - 0.05, r0[1], cx + rw / 2, yR + rw * 0.6, r1[1], { base: yR });
    }
    e[1] = sw; e[3] = sh;
    this.a = sa;
    return yR;
  }

  /** Square/rect pyramid (spire or tent roof), apex at y0+h. */
  pyramid(cx, cz, w, d, y0, h, o = {}) {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    const ap = _p(cx, y0 + h, cz);
    const c = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]];
    const e = this.e, sw = e[1], sh = e[3];
    for (let i = 0; i < 4; i++) {
      const A = c[i], B = c[(i + 1) % 4];
      const W = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const L = Math.hypot(h, (i % 2 ? w : d) / 2);
      e[1] = W; e[3] = L;
      this.triP(_p(A[0], y0, A[1]), _p(B[0], y0, B[1]), ap, [-W / 2, 0], [W / 2, 0], [0, L]);
    }
    e[1] = sw; e[3] = sh;
    if (o.bottom) this.quadP(_p(x0, y0, z0), _p(x1, y0, z0), _p(x1, y0, z1), _p(x0, y0, z1), [0, 0], [w, 0], [w, d], [0, d]);
  }

  /**
   * Cylinder / frustum / cone around (cx,cz) from y0 (radius r0) to y1 (radius r1).
   * u = arc length (centered), v = y - base. opts: { segs, top, bottom, base, a0, a1 (partial), flags, smooth }
   */
  cylinder(cx, cz, r0, r1, y0, y1, o = {}) {
    const segs = o.segs ?? 12, base = o.base ?? y0;
    const a0 = o.a0 ?? 0, a1 = o.a1 ?? Math.PI * 2;
    const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
    const rm = (r0 + r1) / 2, C = rm * (a1 - a0);
    const e = this.e, sw = e[1], sh = e[3], sf = e[2];
    e[1] = C; e[3] = o.wallH ?? (y1 - base); e[2] = o.flags ?? 0;
    const h = y1 - y0, dr = r0 - r1;
    const sl = Math.hypot(h, dr) || 1;
    const ny = dr / sl, nr = h / sl;
    const start = this.n;
    const smooth = o.smooth !== false;
    if (smooth) {
      for (let i = 0; i <= segs; i++) {
        const t = i / segs, a = a0 + (a1 - a0) * t;
        const ca = Math.cos(a), sa = Math.sin(a);
        const u = -C / 2 + C * t;
        this.v(cx + ca * r0, y0, cz + sa * r0, ca * nr, ny, sa * nr, u, y0 - base);
        this.v(cx + ca * r1, y1, cz + sa * r1, ca * nr, ny, sa * nr, u, y1 - base);
      }
      for (let i = 0; i < segs; i++) {
        const a = start + i * 2;
        // CCW from outside: bottom i, top i, top i+1 ... with angle increasing toward -? compute orientation
        this.quad(a, a + 1, a + 3, a + 2);
      }
    } else {
      for (let i = 0; i < segs; i++) {
        const t0 = i / segs, t1 = (i + 1) / segs;
        const aA = a0 + (a1 - a0) * t0, aB = a0 + (a1 - a0) * t1, am = (aA + aB) / 2;
        const nx = Math.cos(am) * nr, nz = Math.sin(am) * nr;
        const uA = -C / 2 + C * t0, uB = -C / 2 + C * t1;
        const p = this.v(cx + Math.cos(aA) * r0, y0, cz + Math.sin(aA) * r0, nx, ny, nz, uA, y0 - base);
        const q = this.v(cx + Math.cos(aA) * r1, y1, cz + Math.sin(aA) * r1, nx, ny, nz, uA, y1 - base);
        const r = this.v(cx + Math.cos(aB) * r1, y1, cz + Math.sin(aB) * r1, nx, ny, nz, uB, y1 - base);
        const s = this.v(cx + Math.cos(aB) * r0, y0, cz + Math.sin(aB) * r0, nx, ny, nz, uB, y0 - base);
        this.quad(p, q, r, s);
      }
    }
    e[1] = sw; e[3] = sh; e[2] = sf;
    if (o.top && r1 > 1e-4) this.disc(cx, y1, cz, r1, segs, 1, o.topMat, a0, a1, full);
    if (o.bottom && r0 > 1e-4) this.disc(cx, y0, cz, r0, segs, -1, null, a0, a1, full);
  }

  /** Horizontal disc (fan) facing up (dir=1) or down (-1). */
  disc(cx, y, cz, r, segs = 12, dir = 1, mat = null, a0 = 0, a1 = Math.PI * 2) {
    const sa = this.a.slice();
    if (mat) this.mat(...mat);
    const c = this.v(cx, y, cz, 0, dir, 0, cx, cz);
    const first = this.n;
    for (let i = 0; i <= segs; i++) {
      const a = a0 + (a1 - a0) * (i / segs);
      this.v(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r, 0, dir, 0, cx + Math.cos(a) * r, cz + Math.sin(a) * r);
    }
    for (let i = 0; i < segs; i++) {
      if (dir > 0) this.tri(c, first + i + 1, first + i); else this.tri(c, first + i, first + i + 1);
    }
    this.a = sa;
  }

  /**
   * Surface of revolution. profile = [[r, y], …] bottom→top. u = angle·uScale (centered), v = arc length.
   * opts: { segs, uScale (m per radian; default mean radius), base, flags }
   */
  lathe(cx, cz, profile, o = {}) {
    const segs = o.segs ?? 16;
    let rmean = 0; for (const p of profile) rmean += p[0]; rmean /= profile.length;
    const us = o.uScale ?? Math.max(rmean, 0.3);
    const C = us * Math.PI * 2;
    const e = this.e, sw = e[1], sh = e[3], sf = e[2];
    // arc lengths
    const s = [0];
    for (let j = 1; j < profile.length; j++) s.push(s[j - 1] + Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]));
    e[1] = C; e[3] = o.wallH ?? s[s.length - 1]; e[2] = o.flags ?? 0;
    const rows = profile.length;
    const start = this.n;
    for (let j = 0; j < rows; j++) {
      const jp = Math.max(0, j - 1), jn = Math.min(rows - 1, j + 1);
      const dr = profile[jn][0] - profile[jp][0], dy = profile[jn][1] - profile[jp][1];
      const l = Math.hypot(dr, dy) || 1;
      const nr = dy / l, ny = -dr / l;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const r = profile[j][0];
        this.v(cx + ca * r, profile[j][1], cz + sa * r, ca * nr, ny, sa * nr, -C / 2 + C * (i / segs), s[j] + (o.vOffset ?? 0));
      }
    }
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < segs; i++) {
        const a = start + j * (segs + 1) + i, b = a + 1, c = a + segs + 2, d = a + segs + 1;
        this.quad(a, d, c, b);
      }
    }
    e[1] = sw; e[3] = sh; e[2] = sf;
  }

  /** Hemisphere / spherical cap dome. */
  dome(cx, y0, cz, r, o = {}) {
    const rings = o.rings ?? 6, segs = o.segs ?? 16, sy = o.sy ?? 1;
    const prof = [];
    const a1 = o.cap ?? Math.PI / 2;
    for (let j = 0; j <= rings; j++) {
      const a = (j / rings) * a1;
      prof.push([Math.max(1e-3, Math.cos(a) * r), y0 + Math.sin(a) * r * sy]);
    }
    this.lathe(cx, cz, prof, { segs, ...o });
  }

  /** Semicircular arch ring in the local XY plane (opening along Z), centered at (cx, cy) spanning z0..z1. */
  arch(cx, cy, z0, z1, ri, ro, o = {}) {
    const segs = o.segs ?? 10;
    const e = this.e, sw = e[1], sh = e[3];
    e[1] = (z1 - z0); e[3] = 0;
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    for (let i = 0; i < segs; i++) {
      const a0 = Math.PI * (i / segs), a1 = Math.PI * ((i + 1) / segs);
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const i0 = [cx + c0 * ri, cy + s0 * ri], o0 = [cx + c0 * ro, cy + s0 * ro];
      const i1 = [cx + c1 * ri, cy + s1 * ri], o1 = [cx + c1 * ro, cy + s1 * ro];
      const D = z1 - z0;
      this.quadP(V(i0[0], i0[1], z1), V(o0[0], o0[1], z1), V(o1[0], o1[1], z1), V(i1[0], i1[1], z1), i0, o0, o1, i1, V(0, 0, 1));
      this.quadP(V(i1[0], i1[1], z0), V(o1[0], o1[1], z0), V(o0[0], o0[1], z0), V(i0[0], i0[1], z0), i1, o1, o0, i0, V(0, 0, -1));
      const mi = V(-(c0 + c1), -(s0 + s1), 0), mo = V(c0 + c1, s0 + s1, 0);
      this.quadP(V(i0[0], i0[1], z0), V(i0[0], i0[1], z1), V(i1[0], i1[1], z1), V(i1[0], i1[1], z0), [0, 0], [D, 0], [D, 1], [0, 1], mi);
      this.quadP(V(o1[0], o1[1], z0), V(o1[0], o1[1], z1), V(o0[0], o0[1], z1), V(o0[0], o0[1], z0), [0, 0], [D, 0], [D, 1], [0, 1], mo);
    }
    e[1] = sw; e[3] = sh;
  }

  /** Tube along a polyline of Vector3 (local), radius r. */
  tube(pts, r, segs = 5, cap = false) {
    if (pts.length < 2) return;
    const start = this.n;
    const t = new THREE.Vector3(), n1 = new THREE.Vector3(), n2 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    let len = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      t.copy(b).sub(a).normalize();
      n1.copy(Math.abs(t.y) > 0.9 ? _v.set(1, 0, 0) : up).cross(t).normalize();
      n2.copy(t).cross(n1).normalize();
      if (i > 0) len += pts[i].distanceTo(pts[i - 1]);
      for (let k = 0; k <= segs; k++) {
        const a2 = (k / segs) * Math.PI * 2, c = Math.cos(a2), s = Math.sin(a2);
        const nx = n1.x * c + n2.x * s, ny = n1.y * c + n2.y * s, nz = n1.z * c + n2.z * s;
        this.v(pts[i].x + nx * r, pts[i].y + ny * r, pts[i].z + nz * r, nx, ny, nz, (k / segs) * 6.283 * r, len);
      }
    }
    for (let i = 0; i < pts.length - 1; i++) for (let k = 0; k < segs; k++) {
      const a = start + i * (segs + 1) + k, b = a + 1, c = a + segs + 2, d = a + segs + 1;
      this.quad(a, b, c, d);
    }
  }

  /** Stairs climbing along +Z from (z0,y0) to (z1,y1), x0..x1 wide. */
  stairs(x0, x1, z0, z1, y0, y1, o = {}) {
    const rise = y1 - y0, run = z1 - z0;
    const n = Math.max(1, Math.round(Math.abs(rise) / (o.step ?? 0.2)));
    const dy = rise / n, dz = run / n;
    for (let i = 0; i < n; i++) {
      const za = z0 + dz * i, zb = z0 + dz * (i + 1);
      const yt = y0 + dy * (i + 1);
      this.box(x0, (o.solid ? (o.floor ?? y0 - 1) : yt - Math.abs(dy) - 0.05), Math.min(za, zb), x1, yt, Math.max(za, zb), { base: o.base ?? y0, sides: [true, !!o.sideFaces, i === 0, !!o.sideFaces] });
    }
  }

  /**
   * Curved East-Asian hip roof over [x0,x1]×[z0,z1]: concave slopes (shallow at
   * the eave, steep at the ridge) and upturned, outswept corners.
   * o: { over, curve (exponent), flare (corner lift m), sweep (corner out m),
   *      segS, segR, thick, roofMat, roofColor, trimMat, trimColor, ridge, ridgeMat, ridgeColor, ornaments }
   * Returns the ridge height.
   */
  curvedRoof(x0, z0, x1, z1, yE, rise, o = {}) {
    const over = o.over ?? 1.2, k = o.curve ?? 1.7, flare = o.flare ?? 0.9, sweep = o.sweep ?? flare * 0.6;
    const segS = o.segS ?? 8, segR = o.segR ?? 6, thick = o.thick ?? 0.25;
    const X0 = x0 - over, X1 = x1 + over, Z0 = z0 - over, Z1 = z1 + over;
    const w = X1 - X0, d = Z1 - Z0;
    const alongX = w >= d;
    const h = (alongX ? d : w) / 2 * (o.hipK ?? 0.92);
    const cx = (X0 + X1) / 2, cz = (Z0 + Z1) / 2;
    const r0 = alongX ? [X0 + h, cz] : [cx, Z0 + h];
    const r1 = alongX ? [X1 - h, cz] : [cx, Z1 - h];
    const yEo = yE - over * 0.35;
    const R = rise + over * 0.35;
    const yR = yEo + R;
    const corners = [[X0, Z1], [X1, Z1], [X1, Z0], [X0, Z0]];
    const cdir = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([a, b]) => [a * 0.7071, b * 0.7071]);
    const ridgeFor = (i) => {
      if (alongX) { if (i === 0) return [r0, r1]; if (i === 1) return [r1, r1]; if (i === 2) return [r1, r0]; return [r0, r0]; }
      if (i === 0) return [r1, r1]; if (i === 1) return [r1, r0]; if (i === 2) return [r0, r0]; return [r0, r1];
    };
    const sa = this.a.slice(), sc = this.c.slice(), se = this.e.slice();
    const fS = (s) => { const q = Math.max(0, Math.abs(2 * s - 1) - 0.35) / 0.65; return q * q; };
    const evalP = (i, s, r, out) => {
      const A = corners[i], B = corners[(i + 1) % 4];
      const [RL, RR] = ridgeFor(i);
      const ex = A[0] + (B[0] - A[0]) * s, ez = A[1] + (B[1] - A[1]) * s;
      const rx = RL[0] + (RR[0] - RL[0]) * s, rz = RL[1] + (RR[1] - RL[1]) * s;
      let x = ex + (rx - ex) * r, z = ez + (rz - ez) * r;
      const f = fS(s), fall = Math.pow(1 - r, 2.2);
      const cd = s < 0.5 ? cdir[i] : cdir[(i + 1) % 4];
      x += cd[0] * sweep * f * fall; z += cd[1] * sweep * f * fall;
      const y = yEo + R * Math.pow(r, k) + flare * f * fall;
      return out.set(x, y, z);
    };
    const P = new THREE.Vector3(), Pa = new THREE.Vector3(), Pb = new THREE.Vector3(), Pc = new THREE.Vector3(), Pd = new THREE.Vector3(), N = new THREE.Vector3();
    const slopeL = Math.hypot(h, R);
    for (const layer of thick > 0 ? [0, 1] : [0]) {
      // layer 0: tiled top; layer 1: soffit (underside, rafters)
      if (layer === 0) { if (o.roofMat) this.mat(...o.roofMat); if (o.roofColor) this.color(o.roofColor); this.e[0] = 1; }
      else { this.mat(...(o.trimMat || [3, 0.3, 0, 3])); if (o.trimColor) this.color(o.trimColor); this.e[0] = 0.4; }
      for (let i = 0; i < 4; i++) {
        const A = corners[i], B = corners[(i + 1) % 4];
        const W = Math.hypot(B[0] - A[0], B[1] - A[1]);
        this.e[1] = W; this.e[3] = slopeL; this.e[2] = 0;
        const start = this.n;
        for (let j = 0; j <= segR; j++) for (let q = 0; q <= segS; q++) {
          const s = q / segS, r = j / segR;
          evalP(i, s, r, P);
          const es = 1e-3;
          evalP(i, Math.min(1, s + es), r, Pa); evalP(i, Math.max(0, s - es), r, Pb);
          evalP(i, s, Math.min(1, r + es), Pc); evalP(i, s, Math.max(0, r - es), Pd);
          Pa.sub(Pb); Pc.sub(Pd);
          N.copy(Pa).cross(Pc).normalize();
          if (N.y < 0) N.negate();
          if (!Number.isFinite(N.x) || N.lengthSq() < 0.5) N.set(0, 1, 0);
          if (layer === 1) { P.y -= thick; N.negate(); }
          this.v(P.x, P.y, P.z, N.x, N.y, N.z, (s - 0.5) * W, r * slopeL);
        }
        for (let j = 0; j < segR; j++) for (let q = 0; q < segS; q++) {
          const a = start + j * (segS + 1) + q, b = a + 1, c = a + segS + 2, dd = a + segS + 1;
          // degenerate ridge-end triangles collapse harmlessly
          if (layer === 0) this.quad(a, b, c, dd); else this.quad(a, dd, c, b);
        }
      }
    }
    // eave fascia
    if (thick > 0) {
      this.mat(...(o.trimMat || [3, 0.3, 0, 3])); if (o.trimColor) this.color(o.trimColor); this.e[0] = 0.8; this.e[3] = 0;
      for (let i = 0; i < 4; i++) {
        for (let q = 0; q < segS; q++) {
          evalP(i, q / segS, 0, Pa); evalP(i, (q + 1) / segS, 0, Pb);
          const out = new THREE.Vector3((Pa.x + Pb.x) / 2 - cx, 0, (Pa.z + Pb.z) / 2 - cz);
          this.quadP(Pa.clone().setY(Pa.y - thick), Pb.clone().setY(Pb.y - thick), Pb.clone(), Pa.clone(), [0, 0], [1, 0], [1, thick], [0, thick], out);
        }
      }
    }
    // ridge with end ornaments
    if (o.ridge !== false) {
      if (o.ridgeMat) this.mat(...o.ridgeMat); else if (o.roofMat) this.mat(...o.roofMat);
      this.color(o.ridgeColor || o.roofColor || this.c);
      this.e[0] = 1; this.e[3] = 0;
      const rw = o.ridgeW ?? 0.45, rh = o.ridgeH ?? 0.7;
      const a0 = alongX ? r0[0] : r0[1], a1 = alongX ? r1[0] : r1[1];
      if (Math.abs(a1 - a0) > 0.2) {
        if (alongX) this.box(a0 - rw, yR - 0.1, cz - rw / 2, a1 + rw, yR + rh, cz + rw / 2, { base: yR });
        else this.box(cx - rw / 2, yR - 0.1, a0 - rw, cx + rw / 2, yR + rh, a1 + rw, { base: yR });
      } else {
        this.boxC(cx, yR - 0.1, cz, rw * 1.5, rh * 1.2, rw * 1.5);
      }
      if (o.ornaments !== false) {
        for (const [px, pz, sgn] of [[r0[0], r0[1], -1], [r1[0], r1[1], 1]]) {
          const dx = alongX ? sgn : 0, dz = alongX ? 0 : sgn;
          const pts = [new THREE.Vector3(px, yR + rh * 0.5, pz), new THREE.Vector3(px + dx * 0.4, yR + rh * 1.6, pz + dz * 0.4), new THREE.Vector3(px - dx * 0.15, yR + rh * 2.4, pz - dz * 0.15)];
          this.tube(pts, rw * 0.32, 5);
        }
      }
    }
    this.a = sa; this.c = sc; this.e = se;
    return yR + (o.ridgeH ?? 0.7);
  }

  /** Box with battered (inward-leaning) walls: top inset by `inset` on every side. */
  frustumBox(x0, z0, x1, z1, y0, y1, inset, o = {}) {
    const base = o.base ?? y0;
    const t = [[x0 + inset, z1 - inset], [x1 - inset, z1 - inset], [x1 - inset, z0 + inset], [x0 + inset, z0 + inset]];
    const b = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]];
    const flags = [o.front ?? 0, o.right ?? 0, o.back ?? 0, o.left ?? 0];
    const se = this.e.slice();
    for (let i = 0; i < 4; i++) {
      const A = b[i], B = b[(i + 1) % 4], C = t[(i + 1) % 4], D = t[i];
      const W = Math.hypot(B[0] - A[0], B[1] - A[1]), Wt = Math.hypot(C[0] - D[0], C[1] - D[1]);
      const H = Math.hypot(y1 - y0, inset);
      this.e[1] = W; this.e[2] = flags[i]; this.e[3] = o.wallH ?? (y1 - base);
      const out = new THREE.Vector3((A[0] + B[0]) / 2 - (x0 + x1) / 2, 0, (A[1] + B[1]) / 2 - (z0 + z1) / 2);
      this.quadP(_p(A[0], y0, A[1]), _p(B[0], y0, B[1]), _p(C[0], y1, C[1]), _p(D[0], y1, D[1]), [-W / 2, y0 - base], [W / 2, y0 - base], [Wt / 2, y0 - base + H], [-Wt / 2, y0 - base + H], out);
    }
    this.e = se;
    if (o.top !== false) {
      const sa = this.a.slice();
      if (o.topMat) this.mat(...o.topMat);
      this.quadP(_p(t[0][0], y1, t[0][1]), _p(t[1][0], y1, t[1][1]), _p(t[2][0], y1, t[2][1]), _p(t[3][0], y1, t[3][1]), [t[0][0], t[0][1]], [t[1][0], t[1][1]], [t[2][0], t[2][1]], [t[3][0], t[3][1]], new THREE.Vector3(0, 1, 0));
      this.a = sa;
    }
  }

  get vertexCount() { return this.n; }
  get triangleCount() { return this.ni / 3; }

  /** Build a BufferGeometry (copies the used part of the arrays). */
  toGeometry() {
    const g = new THREE.BufferGeometry();
    const n = this.n;
    g.setAttribute('position', new THREE.BufferAttribute(this.P.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.N.slice(0, n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.C.slice(0, n * 3), 3));
    g.setAttribute('aFac', new THREE.BufferAttribute(this.F.slice(0, n * 2), 2));
    g.setAttribute('aMat', new THREE.BufferAttribute(this.A.slice(0, n * 4), 4));
    g.setAttribute('aExt', new THREE.BufferAttribute(this.E.slice(0, n * 4), 4));
    const idx = n > 65535 ? this.I.slice(0, this.ni) : Uint16Array.from(this.I.subarray(0, this.ni));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  /** Append another builder's content (already in the same space). */
  append(b) {
    this._grow(this.n + b.n, this.ni + b.ni);
    const off = this.n;
    this.P.set(b.P.subarray(0, b.n * 3), off * 3); this.N.set(b.N.subarray(0, b.n * 3), off * 3);
    this.C.set(b.C.subarray(0, b.n * 3), off * 3); this.F.set(b.F.subarray(0, b.n * 2), off * 2);
    this.A.set(b.A.subarray(0, b.n * 4), off * 4); this.E.set(b.E.subarray(0, b.n * 4), off * 4);
    for (let i = 0; i < b.ni; i++) this.I[this.ni + i] = b.I[i] + off;
    this.n += b.n; this.ni += b.ni;
  }

  clear() { this.n = 0; this.ni = 0; }
}

// small allocation-light helpers (positions are copied by the builder)
const _pp = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
let _pi = 0;
function _p(x, y, z) { const v = _pp[_pi]; _pi = (_pi + 1) & 7; return v.set(x, y, z); }
export { _p as vec3tmp };
