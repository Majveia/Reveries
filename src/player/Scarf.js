// The scarf — the explorer's flowing signature. Two Verlet cloth ribbons pinned
// to the collar knot, simulated in double precision in world space:
//   · structural / shear / bend distance constraints (position based dynamics),
//   · gravity toward the planet centre, aerodynamic drag + lift from the
//     relative air velocity (planet wind + gusts − particle velocity) projected
//     on the local ribbon normal — that is what makes it ripple and stream,
//   · collisions against capsules that follow the animated skeleton (torso,
//     jetpack, head, arms, legs) and against the ground,
//   · rendered as a smooth Catmull-Rom up-sampled ribbon (cloth material with
//     woven bump, embroidered borders and glyphs that glow while gliding).

import * as THREE from 'three';

const UP_SAMPLE = 3;

class Ribbon {
  constructor(anchorCount, cols, rows, length, width) {
    this.cols = cols; this.rows = rows; this.length = length; this.width = width;
    this.n = cols * rows;
    this.p = new Float64Array(this.n * 3);
    this.o = new Float64Array(this.n * 3); // previous
    this.nrm = new Float64Array(this.n * 3);
    this.seg = length / (rows - 1);
    this.dx = width / (cols - 1);
    this.anchorCount = anchorCount;
    // tapered: full width at the knot, ~60% at the tip
    this.dxAt = (r) => this.dx * (1 - 0.4 * Math.pow(r / (rows - 1), 1.3));
    const c = [];
    const add = (a, b, k) => c.push(a, b, 0, k);
    for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
      const i = r * cols + q;
      if (q + 1 < cols) add(i, i + 1, 1);
      if (r + 1 < rows) add(i, i + cols, 1);
      if (r + 1 < rows && q + 1 < cols) { add(i, i + cols + 1, 0.6); add(i + 1, i + cols, 0.6); }
      // soft bending: the cloth folds into travelling S-waves and curls across its width
      if (r + 2 < rows) add(i, i + 2 * cols, 0.045);
      if (q + 2 < cols) add(i, i + 2, 0.12);
    }
    this.con = new Float64Array(c);
    // rest lengths
    for (let k = 0; k < this.con.length; k += 4) {
      const a = this.con[k], b = this.con[k + 1];
      const ra = Math.floor(a / cols), qa = a % cols, rb = Math.floor(b / cols), qb = b % cols;
      const xa = (qa - (cols - 1) / 2) * this.dxAt(ra), xb = (qb - (cols - 1) / 2) * this.dxAt(rb);
      this.con[k + 2] = Math.hypot((ra - rb) * this.seg, xa - xb);
    }
  }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3();

export class Scarf {
  /**
   * opts: { material, quality }
   */
  constructor(material, quality = 2) {
    const rows = [12, 16, 20, 22][quality] ?? 20;
    this.ribbons = [
      new Ribbon(3, 7, rows + 2, 1.9, 0.27),
      new Ribbon(3, 5, Math.round(rows * 0.65), 1.1, 0.2),
    ];
    this.object = new THREE.Group();
    this.object.name = 'explorer-scarf';
    this.meshes = this.ribbons.map((rb) => this._makeMesh(rb, material));
    for (const m of this.meshes) this.object.add(m);
    this.ready = false;
    this.capsules = []; // [{a: Vector3, b: Vector3, r}] world space (set each frame)
    this.groundR = 0;
    this.up = new THREE.Vector3(0, 1, 0);
    this.gravity = 9.81;
    this.wind = new THREE.Vector3();
    this.gust = 0;
    this.airOffset = new THREE.Vector3(); // extra relative wind (e.g. shot pose "running")
    this.time = 0;
    this.flutter = 26;
    this.ribbons.forEach((rb, i) => { rb.phase = i * 2.1; });
  }

  _makeMesh(rb, material) {
    const R = (rb.rows - 1) * UP_SAMPLE + 1, C = rb.cols;
    const n = R * C;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const cl = new Float32Array(n * 4);
    for (let r = 0; r < R; r++) for (let q = 0; q < C; q++) {
      const i = r * C + q;
      const along = (r / (R - 1)) * rb.length;
      cl[i * 4] = q / (C - 1);
      cl[i * 4 + 1] = along;
      cl[i * 4 + 2] = 0.55 + 0.45 * Math.min(1, along / 0.35);
      cl[i * 4 + 3] = r / (R - 1); // 0 at the knot, 1 at the frayed tip
    }
    g.setAttribute('aCloth', new THREE.BufferAttribute(cl, 4));
    const idx = [];
    for (let r = 0; r < R - 1; r++) for (let q = 0; q < C - 1; q++) {
      const a = r * C + q, b = a + 1, c = a + C, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);
    const m = new THREE.Mesh(g, material);
    m.castShadow = true; m.receiveShadow = true;
    m.frustumCulled = false;
    m.userData.R = R;
    return m;
  }

  /** Lay the ribbons out from the anchors, trailing behind/below. */
  reset(anchors, back, up) {
    for (let k = 0; k < this.ribbons.length; k++) {
      const rb = this.ribbons[k], A = anchors[k];
      for (let r = 0; r < rb.rows; r++) for (let q = 0; q < rb.cols; q++) {
        const i = (r * rb.cols + q) * 3;
        const ap = this._anchorAt(A, q / (rb.cols - 1), _a);
        const d = r * rb.seg;
        _b.copy(ap).addScaledVector(back, d * 0.55).addScaledVector(up, -d * 0.83);
        rb.p[i] = rb.o[i] = _b.x; rb.p[i + 1] = rb.o[i + 1] = _b.y; rb.p[i + 2] = rb.o[i + 2] = _b.z;
      }
    }
    this.ready = true;
    this._prevA = anchors.map((A) => A.map((v) => v.clone()));
  }

  _anchorAt(A, t, out) {
    // A: array of 3 Vector3 across the ribbon root
    const s = t * (A.length - 1), i = Math.min(A.length - 2, Math.floor(s)), f = s - i;
    return out.copy(A[i]).lerp(A[i + 1], f);
  }

  /**
   * anchors: [[Vector3 x3], [Vector3 x3]] world positions of the ribbon roots.
   * dt: frame time. Steps internally at ≤ 1/150 s.
   */
  step(dt, anchors) {
    if (!this.ready) return;
    const steps = Math.min(6, Math.max(2, Math.ceil(dt * 150)));
    const h = Math.min(dt, 1 / 30) / steps;
    if (!this._prevA) this._prevA = anchors.map((A) => A.map((v) => v.clone()));
    for (let s = 0; s < steps; s++) {
      this.time += h;
      for (let k = 0; k < this.ribbons.length; k++) this._substep(this.ribbons[k], anchors[k], h, (s + 1) / steps, this._prevA[k]);
    }
    for (let k = 0; k < anchors.length; k++) for (let j = 0; j < anchors[k].length; j++) this._prevA[k][j].copy(anchors[k][j]);
  }

  _substep(rb, A, h, frac, PA) {
    const { p, o, cols, rows } = rb;
    const up = this.up, g = this.gravity;
    const t = this.time;
    // normals (for aerodynamics)
    this._normals(rb);
    const wx = this.wind.x + this.airOffset.x, wy = this.wind.y + this.airOffset.y, wz = this.wind.z + this.airOffset.z;
    const damping = 0.996;
    const kN = 11.0, kT = 0.9;
    for (let r = 1; r < rows; r++) for (let q = 0; q < cols; q++) {
      const i = (r * cols + q) * 3;
      const vx = (p[i] - o[i]) / h, vy = (p[i + 1] - o[i + 1]) / h, vz = (p[i + 2] - o[i + 2]) / h;
      // gusty turbulence travelling down the ribbon
      const tt = t * 7.0 - r * 0.55;
      const gust = 1 + this.gust * (0.45 * Math.sin(tt) + 0.25 * Math.sin(tt * 2.3 + q));
      let ax = wx * gust - vx, ay = wy * gust - vy, az = wz * gust - vz;
      const nx = rb.nrm[i], ny = rb.nrm[i + 1], nz = rb.nrm[i + 2];
      const vn = ax * nx + ay * ny + az * nz;
      const s01 = r / (rows - 1);
      const tipFree = 0.6 + 0.4 * s01;
      let fx = (kN * vn * nx + kT * (ax - vn * nx)) * tipFree;
      let fy = (kN * vn * ny + kT * (ay - vn * ny)) * tipFree;
      let fz = (kN * vn * nz + kT * (az - vn * nz)) * tipFree;
      // flag flutter: travelling waves normal to the ribbon, growing toward the free tip
      const rel = Math.sqrt(ax * ax + ay * ay + az * az);
      const amp = this.flutter * Math.min(1.6, rel / 5) * (0.25 + 0.75 * s01);
      const along = r * rb.seg;
      const wave = Math.sin(t * (7 + rel * 1.1) - along * 5.5 + rb.phase) + 0.45 * Math.sin(t * (12.3 + rel * 0.7) - along * 9.0 + q * 0.8 + rb.phase * 1.7);
      fx += nx * amp * wave; fy += ny * amp * wave; fz += nz * amp * wave;
      fx -= up.x * g; fy -= up.y * g; fz -= up.z * g;
      const px = p[i], py = p[i + 1], pz = p[i + 2];
      p[i] += (px - o[i]) * damping + fx * h * h;
      p[i + 1] += (py - o[i + 1]) * damping + fy * h * h;
      p[i + 2] += (pz - o[i + 2]) * damping + fz * h * h;
      o[i] = px; o[i + 1] = py; o[i + 2] = pz;
    }
    // pin the root row (interpolated over the substeps for smooth motion)
    for (let q = 0; q < cols; q++) {
      const i = q * 3;
      const ap = this._anchorAt(A, q / (cols - 1), _a);
      const pp = this._anchorAt(PA, q / (cols - 1), _b);
      ap.lerpVectors(pp, ap, frac);
      o[i] = p[i]; o[i + 1] = p[i + 1]; o[i + 2] = p[i + 2];
      p[i] = ap.x; p[i + 1] = ap.y; p[i + 2] = ap.z;
    }
    // constraints
    const con = rb.con;
    for (let it = 0; it < 4; it++) {
      for (let k = 0; k < con.length; k += 4) {
        const a = con[k] * 3, b = con[k + 1] * 3, rest = con[k + 2], stiff = con[k + 3];
        const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
        const diff = ((d - rest) / d) * stiff;
        const pinA = a < cols * 3, pinB = b < cols * 3;
        if (pinA && pinB) continue;
        const wa = pinA ? 0 : pinB ? 1 : 0.5, wb = pinB ? 0 : pinA ? 1 : 0.5;
        p[a] += dx * diff * wa; p[a + 1] += dy * diff * wa; p[a + 2] += dz * diff * wa;
        p[b] -= dx * diff * wb; p[b + 1] -= dy * diff * wb; p[b + 2] -= dz * diff * wb;
      }
      if (it % 2 === 1) this._collide(rb);
    }
  }

  _collide(rb) {
    const { p, cols, rows } = rb;
    const caps = this.capsules;
    const up = this.up, gR = this.groundR;
    const thick = 0.022;
    for (let r = 1; r < rows; r++) for (let q = 0; q < cols; q++) {
      const i = (r * cols + q) * 3;
      let x = p[i], y = p[i + 1], z = p[i + 2];
      for (let c = 0; c < caps.length; c++) {
        const C = caps[c];
        const ax = C.a.x, ay = C.a.y, az = C.a.z;
        const bx = C.b.x - ax, by = C.b.y - ay, bz = C.b.z - az;
        const px = x - ax, py = y - ay, pz = z - az;
        const bb = bx * bx + by * by + bz * bz;
        const tt = bb > 1e-9 ? Math.max(0, Math.min(1, (px * bx + py * by + pz * bz) / bb)) : 0;
        const dx = px - bx * tt, dy = py - by * tt, dz = pz - bz * tt;
        const d2 = dx * dx + dy * dy + dz * dz, rr = C.r + thick;
        if (d2 < rr * rr) {
          const d = Math.sqrt(d2) || 1e-6, push = (rr - d) / d;
          x += dx * push; y += dy * push; z += dz * push;
        }
      }
      // ground (sphere of radius gR around the planet centre)
      if (gR > 0) {
        const rl = Math.sqrt(x * x + y * y + z * z);
        if (rl < gR + thick) { const s = (gR + thick) / rl; x *= s; y *= s; z *= s; }
      }
      p[i] = x; p[i + 1] = y; p[i + 2] = z;
    }
  }

  _normals(rb) {
    const { p, nrm, cols, rows } = rb;
    for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
      const i = (r * cols + q) * 3;
      const r0 = Math.max(0, r - 1), r1 = Math.min(rows - 1, r + 1), q0 = Math.max(0, q - 1), q1 = Math.min(cols - 1, q + 1);
      const ia = (r0 * cols + q) * 3, ib = (r1 * cols + q) * 3, ic = (r * cols + q0) * 3, id = (r * cols + q1) * 3;
      const ux = p[ib] - p[ia], uy = p[ib + 1] - p[ia + 1], uz = p[ib + 2] - p[ia + 2];
      const vx = p[id] - p[ic], vy = p[id + 1] - p[ic + 1], vz = p[id + 2] - p[ic + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nrm[i] = nx / l; nrm[i + 1] = ny / l; nrm[i + 2] = nz / l;
    }
  }

  /** Write render geometry relative to origin (the mesh group sits at origin). */
  updateGeometry(origin) {
    for (let k = 0; k < this.ribbons.length; k++) {
      const rb = this.ribbons[k], mesh = this.meshes[k];
      const R = mesh.userData.R, C = rb.cols;
      const pos = mesh.geometry.attributes.position.array;
      const p = rb.p;
      for (let q = 0; q < C; q++) {
        for (let r = 0; r < R; r++) {
          const s = r / UP_SAMPLE, i1 = Math.min(rb.rows - 1, Math.floor(s)), f = s - i1;
          const i0 = Math.max(0, i1 - 1), i2 = Math.min(rb.rows - 1, i1 + 1), i3 = Math.min(rb.rows - 1, i1 + 2);
          const o = (r * C + q) * 3;
          for (let c = 0; c < 3; c++) {
            const P0 = p[(i0 * C + q) * 3 + c], P1 = p[(i1 * C + q) * 3 + c], P2 = p[(i2 * C + q) * 3 + c], P3 = p[(i3 * C + q) * 3 + c];
            // Catmull-Rom
            const f2 = f * f, f3 = f2 * f;
            const v = 0.5 * (2 * P1 + (-P0 + P2) * f + (2 * P0 - 5 * P1 + 4 * P2 - P3) * f2 + (-P0 + 3 * P1 - 3 * P2 + P3) * f3);
            pos[o + c] = v - (c === 0 ? origin.x : c === 1 ? origin.y : origin.z);
          }
        }
      }
      mesh.geometry.attributes.position.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    }
    this.object.position.copy(origin);
  }

  dispose() { for (const m of this.meshes) m.geometry.dispose(); }
}
