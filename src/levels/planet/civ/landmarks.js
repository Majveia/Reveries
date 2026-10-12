// Landmarks — the awe objects visible from far away, one or two per world:
// the floating island city (Laputa), the black monolith (Kubrick), the great
// pagoda, the hometree, the space elevator, colossal statues and arches.

import * as THREE from 'three';
import { M, W, F } from './ids.js';
import { col, glow, flag, figure, TAU } from './kit.js';
import { SimplexNoise } from '../../../core/Noise.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

/**
 * Noisy surface of revolution (rock masses, tree trunks, foliage blobs).
 * profile [[r, y], …] bottom→top; amp = radial noise amplitude (fraction);
 * fq = noise frequency (per meter); returns nothing, draws into B.
 */
export function rockLathe(B, cx, cz, profile, o = {}) {
  const segs = o.segs ?? 24, amp = o.amp ?? 0.15, fq = o.fq ?? 0.05, ampY = o.ampY ?? 0;
  const noise = new SimplexNoise(o.seed ?? 7);
  const rows = profile.length;
  const P = [];
  let rmean = 0; for (const p of profile) rmean += p[0]; rmean /= rows;
  for (let j = 0; j < rows; j++) {
    const [r, y] = profile[j];
    const row = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      const ii = i % segs;
      const aa = (ii / segs) * TAU;
      const ys = o.yStretch ?? 1;
      let n = noise.noise3(Math.cos(aa) * rmean * fq, y * fq * ys, Math.sin(aa) * rmean * fq) + 0.5 * noise.noise3(Math.cos(aa) * rmean * fq * 2.7, y * fq * 2.7 * ys + 9, Math.sin(aa) * rmean * fq * 2.7);
      if (o.detail) n += o.detail * noise.noise3(Math.cos(aa) * rmean * fq * 7.3, y * fq * 7.3 * ys + 3, Math.sin(aa) * rmean * fq * 7.3);
      const rr = Math.max(0.01, r * (1 + amp * n));
      const yy = y + ampY * n * (o.ampYScale ?? 1);
      row.push(new THREE.Vector3(cx + Math.cos(aa) * rr, yy, cz + Math.sin(aa) * rr));
      void ca; void sa;
    }
    P.push(row);
  }
  const se = B.e.slice();
  const C = rmean * TAU;
  B.e[1] = C; B.e[3] = o.wallH ?? 0; B.e[2] = o.flags ?? F.NOWIN;
  const start = B.n;
  const n = new THREE.Vector3();
  let vacc = 0;
  for (let j = 0; j < rows; j++) {
    if (j > 0) vacc += P[j][0].distanceTo(P[j - 1][0]);
    for (let i = 0; i <= segs; i++) {
      const im = (i - 1 + segs) % segs, ip = (i + 1) % segs;
      const jm = Math.max(0, j - 1), jp = Math.min(rows - 1, j + 1);
      _a.copy(P[j][ip]).sub(P[j][im]);
      _b.copy(P[jp][i]).sub(P[jm][i]);
      n.copy(_b).cross(_a).normalize();
      if (o.flip) n.negate();
      if (!Number.isFinite(n.x) || n.lengthSq() < 0.5) n.set(0, Math.sign(profile[rows - 1][1] - profile[0][1]) || 1, 0);
      const p = P[j][i];
      B.v(p.x, p.y, p.z, n.x, n.y, n.z, -C / 2 + C * (i / segs), vacc + (o.vOff ?? 0));
    }
  }
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < segs; i++) {
    const a = start + j * (segs + 1) + i, b = a + 1, c = a + segs + 2, d = a + segs + 1;
    if (o.flip) B.quad(a, b, c, d); else B.quad(a, d, c, b);
  }
  B.e = se;
}

/** Foliage cluster: a noisy sphere. */
export function foliageBlob(B, x, y, z, r, color, seed = 1, segs = 12) {
  B.mat(M.FOLIAGE, (seed * 0.137) % 1, 0, 3).color(color).ext(0.85, 0, F.NOWIN, 0);
  const prof = [];
  for (let j = 0; j <= 8; j++) { const a = -Math.PI / 2 + (j / 8) * Math.PI; prof.push([Math.max(0.02, Math.cos(a) * r), y + Math.sin(a) * r * 0.8]); }
  rockLathe(B, x, z, prof, { segs: Math.max(segs, 16), amp: 0.18, fq: 2.2 / r, seed });
}

// ---------------------------------------------------------------- Laputa
export function floatingIsland(ctx, x, z, alt, R) {
  const { rng, pal } = ctx;
  ctx.useTile('landmark');
  const B = ctx.B;
  ctx.place(x, z, alt, rng.float() * TAU);
  const rock = col(ctx.A?.palette?.rock || '#8a8478').multiplyScalar(0.95);
  const moss = col('#5f7a3a');
  // underside: a gnarled bowl of stratified rock, lobed and dripping roots
  // (dense lathe: at hero scale the silhouette and the light must stay smooth, never faceted)
  B.mat(M.ROCK, 0.31, 0, 3).color(rock).ext(1, 0, F.NOWIN, 0);
  const prof = [];
  const depth = R * 1.25;
  const N = 72;
  for (let j = 0; j <= N; j++) {
    const t = j / N; // 0 bottom … 1 top
    const r = R * (t < 0.9 ? Math.pow(t / 0.9, 0.42) * 1.03 : 1.03 - (t - 0.9) * 0.3);
    prof.push([Math.max(0.5, r), -depth * Math.pow(1 - t, 1.15) - 3]);
  }
  rockLathe(B, 0, 0, prof, { segs: 220, amp: 0.2, fq: 0.032, ampY: 6, seed: 11, yStretch: 0.3, detail: 0.22 });
  // smooth a coarse profile into many rows (Catmull-Rom) so lobes read as rounded rock, not facets
  const smoothProf = (P, per = 4) => {
    const out = [];
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
      for (let k = 0; k < per; k++) {
        const t = k / per, t2 = t * t, t3 = t2 * t;
        const cr = (a0, a1, a2, a3) => 0.5 * (2 * a1 + (-a0 + a2) * t + (2 * a0 - 5 * a1 + 4 * a2 - a3) * t2 + (-a0 + 3 * a1 - 3 * a2 + a3) * t3);
        out.push([Math.max(0.2, cr(p0[0], p1[0], p2[0], p3[0])), cr(p0[1], p1[1], p2[1], p3[1])]);
      }
    }
    out.push(P[P.length - 1]);
    return out;
  };
  for (let k = 0; k < 16; k++) {
    const a = rng.range(0, TAU), rr = R * rng.range(0.3, 0.82);
    const lx = Math.cos(a) * rr, lz = Math.sin(a) * rr, lr = R * rng.range(0.16, 0.3);
    const ld = depth * rng.range(0.55, 0.98);
    rockLathe(B, lx, lz, smoothProf([[0.3, -ld], [lr * 0.3, -ld * 0.93], [lr * 0.55, -ld * 0.8], [lr * 0.8, -ld * 0.62], [lr, -ld * 0.45], [lr * 1.05, -ld * 0.25], [lr * 1.05, -10], [lr * 0.9, -2]]), { segs: 48, amp: 0.28, fq: 0.06, seed: 20 + k, yStretch: 0.35, detail: 0.2 });
  }
  // grass rim
  const moss2 = moss.clone().multiplyScalar(1.1);
  B.mat(M.GRASS, 0.2, 0, 3).color(moss2).ext(1, 0, F.NOWIN, 0);
  rockLathe(B, 0, 0, [[R * 1.0, -3.5], [R * 0.99, -0.8], [R * 0.9, 0.6], [R * 0.8, 1.2]], { segs: 96, amp: 0.05, fq: 0.05, seed: 11 });
  // the castle: three concentric arcaded terraces stepping up to the tree, each ring lived in
  const stone = col('#c4bcaa');
  const terraces = [[0.8, 9], [0.6, 20], [0.4, 32]];
  const walls = ctx.pal?.walls?.length ? ctx.pal.walls : [col('#ece4d2'), col('#f2ead8'), col('#e2d6be')];
  const roofs = ctx.pal?.roofs?.length ? ctx.pal.roofs : [col('#a8442e'), col('#3e6a6a'), col('#b8583a')];
  const M0 = ctx.M.clone(), MH = new THREE.Matrix4(), RY = new THREE.Matrix4();
  let prevTop = 1.2;
  for (let ti = 0; ti < terraces.length; ti++) {
    const [rk, top] = terraces[ti];
    const rr = R * rk;
    B.mat(M.MOSSSTONE, 0.4 + ti * 0.1, W.ARCADE, 4.2).color(stone.clone().multiplyScalar(1 - ti * 0.04)).ext(1, 0, 0, 0);
    B.cylinder(0, 0, rr, rr * 0.985, prevTop - 4, top, { segs: 72, base: prevTop - 4 });
    // cornice + grass terrace on top
    B.mat(M.MOSSSTONE, 0.5, 0, 3).color(stone.clone().multiplyScalar(0.92)).ext(1, 0, F.NOWIN, 0);
    B.cylinder(0, 0, rr + 0.6, rr + 0.6, top - 0.5, top + 0.4, { segs: 72, top: false });
    B.mat(M.GRASS, 0.3 + ti * 0.1, 0, 3).color(moss2).ext(1, 0, F.NOWIN, 0);
    B.disc(0, top + 0.4, 0, rr + 0.6, 72, 1);
    // towers on the terrace edge
    const nt = [10, 7, 5][ti];
    const towerA = [];
    for (let k = 0; k < nt; k++) {
      const a = (k / nt) * TAU + ti * 0.35;
      towerA.push(a);
      const tx = Math.cos(a) * rr, tz = Math.sin(a) * rr;
      const th = top + rng.range(8, 16) - ti * 2;
      B.mat(M.MOSSSTONE, rng.float(), W.LANCET, 4).color(stone).ext(1, 0, 0, 0);
      B.cylinder(tx, tz, 3.0, 2.7, prevTop - 4, th, { segs: 16, base: prevTop - 4 });
      B.mat(M.SLATE, rng.float(), 0, 3).color(col('#3e6a6a')).ext(1, 0, F.NOWIN, 0);
      B.lathe(tx, tz, [[3.5, th], [2.4, th + 2.6], [0.05, th + 7.5]], { segs: 16 });
      glow(ctx, tx * 1.04, th - 3, tz * 1.04, pal.lamp, 0.9, rng.float());
    }
    // houses ringing the terrace (between this wall and the next one up): a village in the sky
    const rIn = ti + 1 < terraces.length ? R * terraces[ti + 1][0] : R * 0.14;
    const rMid = (rr + rIn) / 2, ring = rr - rIn;
    const nh = Math.floor((TAU * rMid) / 11);
    for (let k = 0; k < nh; k++) {
      const a = (k / nh) * TAU + rng.range(-0.04, 0.04);
      if (towerA.some((ta) => Math.abs(((a - ta + Math.PI * 3) % TAU) - Math.PI) < 0.06)) continue;
      if (rng.chance(0.16)) continue;
      const w = rng.range(5.5, 8.5), d = Math.min(ring - 5, rng.range(5, 7.5));
      const floors = rng.chance(0.35) ? 2 : 1, fh = 3.0, H = floors * fh + 0.3;
      const hx = Math.cos(a) * (rMid + rng.range(-1, 1)), hz = Math.sin(a) * (rMid + rng.range(-1, 1));
      MH.copy(M0).multiply(RY.makeTranslation(hx, top + 0.4, hz)).multiply(RY.makeRotationY(Math.PI / 2 - a));
      B.setMatrix(MH);
      const seed = rng.float();
      B.mat(M.PLASTER, seed, W.HOUSE, fh).color(rng.pick(walls).clone().multiplyScalar(rng.range(0.92, 1.03))).ext(1, 0, 0, 0);
      B.box(-w / 2, 0, -d / 2, w / 2, H, d / 2, { top: false, base: 0, front: F.FRONT, right: 0, back: 0, left: 0 });
      const rc = rng.pick(roofs).clone().multiplyScalar(rng.range(0.85, 1.05));
      B.gableRoof(-w / 2, -d / 2, w / 2, d / 2, H, (d / 2) * rng.range(0.7, 0.95), { over: 0.5, overG: 0.35, roofMat: [rc.b > rc.r ? M.SLATE : M.TILE, rng.float(), 0, 3], roofColor: rc, trimMat: [M.WOOD, seed, 0, 3], trimColor: col('#5a4030'), base: 0, ridgeW: 0.24 });
      B.setMatrix(M0);
      if (rng.chance(0.45)) glow(ctx, Math.cos(a) * (rMid + d / 2 + 0.6), top + 2.6, Math.sin(a) * (rMid + d / 2 + 0.6), pal.lamp, 0.5, rng.float());
    }
    prevTop = top + 0.4;
  }
  // the great tree crowning the castle: a broad cauliflower canopy of many leaf masses
  const trunk = col('#5a4a3a');
  const ty = prevTop;
  B.mat(M.WOOD, 0.33, 0, 3).color(trunk).ext(1, 0, F.NOWIN, 0);
  const th = R * 0.5;
  rockLathe(B, 0, 0, smoothProf([[R * 0.13, ty - 2], [R * 0.075, ty + R * 0.05], [R * 0.058, ty + th * 0.45], [R * 0.045, ty + th * 0.8], [R * 0.03, ty + th]], 3), { segs: 24, amp: 0.25, fq: 0.12, seed: 31 });
  // roots pouring over the terraces
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * TAU + rng.range(-0.2, 0.2);
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10, r = R * (0.06 + t * 0.78);
      const yy = r < R * 0.4 ? ty : r < R * 0.6 ? 20.4 : r < R * 0.8 ? 9.4 : 1.2;
      pts.push(new THREE.Vector3(Math.cos(a + t * 0.25) * r, yy + 1.0 + Math.sin(t * 7 + k) * 0.5, Math.sin(a + t * 0.25) * r));
    }
    const r0 = R * rng.range(0.016, 0.024);
    B.tube(pts, (t) => r0 * (1.4 - t * 0.9), 6);
  }
  const fol = [col('#3f7a34'), col('#4f8a3c'), col('#36702f'), col('#5a9a44'), col('#6aa64c')];
  const cy = ty + th * 0.92, Rc = R * 0.52, Rv = R * 0.26;
  const limbs = [];
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * TAU + rng.range(-0.3, 0.3);
    const y0 = ty + th * rng.range(0.35, 0.75), L = Rc * rng.range(0.6, 0.85);
    const tip = new THREE.Vector3(Math.cos(a) * L, cy + Rv * rng.range(-0.2, 0.3), Math.sin(a) * L);
    B.mat(M.WOOD, 0.33, 0, 3).color(trunk);
    const mid = new THREE.Vector3(Math.cos(a) * L * 0.45, (y0 + tip.y) / 2 + L * 0.1, Math.sin(a) * L * 0.45);
    const r0 = R * 0.022;
    B.tube([new THREE.Vector3(0, y0, 0), mid, tip], (t) => r0 * (1 - t * 0.7), 7);
    limbs.push(tip);
  }
  // outer shell of leaf masses (dome), a few big inner fills, then small tufts on the sunlit top
  let fk = 0;
  for (let k = 0; k < 46; k++) {
    const u = rng.range(0, TAU), v = Math.acos(rng.range(-0.25, 1)); // upper-biased sphere
    const sr = rng.range(0.78, 1.0);
    const px = Math.cos(u) * Math.sin(v) * Rc * sr, pz = Math.sin(u) * Math.sin(v) * Rc * sr, py = cy + Math.cos(v) * Rv * sr;
    foliageBlob(B, px, py, pz, R * rng.range(0.085, 0.14), rng.pick(fol), 40 + fk++, 12);
  }
  for (const p of limbs) foliageBlob(B, p.x * 0.8, p.y, p.z * 0.8, R * rng.range(0.15, 0.2), rng.pick(fol), 40 + fk++, 14);
  foliageBlob(B, 0, cy + Rv * 0.4, 0, R * 0.3, fol[0], 40 + fk++, 16);
  for (let k = 0; k < 18; k++) {
    const u = rng.range(0, TAU), v = rng.range(0, 0.9);
    foliageBlob(B, Math.cos(u) * Math.sin(v) * Rc * 0.85, cy + Math.cos(v) * Rv * 1.05, Math.sin(u) * Math.sin(v) * Rc * 0.85, R * rng.range(0.05, 0.08), rng.pick(fol.slice(2)), 40 + fk++, 10);
  }
  // hanging roots below the island: tapered, branching, some very long
  B.mat(M.WOOD, 0.4, 0, 3).color(col('#4a3a2c'));
  for (let k = 0; k < 40; k++) {
    const a = rng.range(0, TAU), r0 = R * Math.sqrt(rng.range(0.01, 0.8));
    const tProf = Math.pow(Math.min(1, r0 / (R * 1.03)), 1 / 0.42) * 0.9;
    const ytop = -depth * Math.pow(1 - tProf, 1.15) - 3 + 4;
    const len = rng.range(20, 110) * (1.2 - r0 / R * 0.6);
    const pts = [];
    for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push(new THREE.Vector3(Math.cos(a) * r0 + Math.sin(t * 5 + k) * 3 * t, ytop - len * t, Math.sin(a) * r0 + Math.cos(t * 4 + k) * 3 * t)); }
    const rad = rng.range(0.8, 2.2);
    B.tube(pts, (t) => rad * Math.pow(1 - t, 0.7) + 0.06, 7);
    if (rng.chance(0.65)) {
      const s0 = rng.int(2, 5);
      const q = pts.slice(s0).map((p, i) => p.clone().add(new THREE.Vector3(Math.sin(i * 0.7 + k) * (1 + i * 0.6), -i * 1.4, Math.cos(i * 0.9 + k) * (1 + i * 0.6))));
      const rb = rad * 0.45;
      B.tube(q, (t) => rb * Math.pow(1 - t, 0.8) + 0.04, 5);
    }
  }
  // waterfalls: translucent animated ribbons that widen and dissolve into spray
  ctx.group.add(waterfallMesh(ctx, R, rng));
  ctx.useTile(null);
  ctx.poiAt(x, z, alt + 20, R * 1.4, 'landmark', 'The Floating City');
  ctx.landmarkSpots.push({ x, z, h: alt, kind: 'island', R, title: 'The Floating City' });
}

// ---------------------------------------------------------------- Kubrick monolith
export function monolith(ctx, x, z, scale = 1) {
  ctx.useTile('landmark');
  const fr = ctx.frame;
  const yaw = ctx.rng.float() * TAU;
  const w = 8 * scale, d = 2 * scale, h = 36 * scale; // 1 : 4 : 9 (×2)… height 4.5 × width
  const fp = fr.footprint(x, z, w, d, yaw, 3);
  ctx.place(x, z, fp.min - 2, yaw);
  const B = ctx.B;
  B.mat(M.BLACK, 0.5, 0, 3).color(col('#020203')).ext(1, 0, F.NOWIN, 0);
  B.box(-w / 2, 0, -d / 2, w / 2, h * 2.25, d / 2, { base: 0 });
  ctx.collider(0, h * 1.125, 0, w / 2, h * 1.125, d / 2, false);
  ctx.useTile(null);
  ctx.landmarkSpots.push({ x, z, h: fp.min + h * 2.25, kind: 'monolith', title: 'The Monolith' });
  ctx.poiAt(x, z, fp.min + 2, 60, 'landmark', 'The Monolith');
}

// ---------------------------------------------------------------- Space elevator
export function spaceElevator(ctx, x, z) {
  const { rng, pal } = ctx;
  ctx.useTile('landmark');
  const fr = ctx.frame;
  const fp = fr.footprint(x, z, 60, 60, 0, 4);
  ctx.place(x, z, fp.max, 0);
  const B = ctx.B;
  const metal = col('#c8ccd2'), dark = col('#3a3e44');
  // anchor station: stepped octagonal base, ring buttresses, cable spindle
  B.mat(M.CONCRETE, 0.4, W.STRIP, 4).color(col('#a8a8a4')).ext(1, 0, 0, 0);
  B.cylinder(0, 0, 30, 26, fp.min - fp.max - 2, 10, { segs: 8, top: true, smooth: false });
  B.mat(M.METAL, 0.3, W.STRIP, 4.5).color(metal);
  B.cylinder(0, 0, 20, 17, 10, 26, { segs: 8, top: true, smooth: false });
  B.mat(M.METAL, 0.6, 0, 3).color(dark);
  B.cylinder(0, 0, 9, 6, 26, 60, { segs: 12, top: true });
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU + TAU / 16;
    const pts = [new THREE.Vector3(Math.cos(a) * 28, 9, Math.sin(a) * 28), new THREE.Vector3(Math.cos(a) * 16, 34, Math.sin(a) * 16), new THREE.Vector3(Math.cos(a) * 6.5, 58, Math.sin(a) * 6.5)];
    B.mat(M.METAL, 0.2, 0, 3).color(metal);
    B.tube(pts, 0.9, 6);
    glow(ctx, Math.cos(a) * 29, 10.5, Math.sin(a) * 29, col('#ff5030'), 1.2, 2.0 + k * 0.13);
  }
  // the tether: a slim tapering ribbon of cables going to orbit (local up)
  const top = Math.min(ctx.world.radius * 0.9, 36000);
  B.mat(M.METAL, 0.8, 0, 3).color(col('#9aa0a8'));
  const tPts = [];
  for (let i = 0; i <= 24; i++) tPts.push(new THREE.Vector3(0, 60 + Math.pow(i / 24, 2) * top, 0));
  for (const [ox, oz] of [[1.4, 0], [-1.4, 0], [0, 1.4], [0, -1.4]]) B.tube(tPts.map((p) => p.clone().add(new THREE.Vector3(ox, 0, oz))), 0.55, 4);
  // beacon lights climbing the tether
  for (let i = 0; i < 40; i++) {
    const y = 80 + Math.pow(i / 40, 2.2) * top * 0.6;
    glow(ctx, 0, y, 0, i % 2 ? col('#ff4030') : col('#ffffff'), 1.4 + y * 0.0012, 2.0 + i * 0.07);
  }
  // climbers moving up and down (animated)
  const dyn = ctx.dynamicBuilder();
  const S = dyn.B;
  S.mat(M.METAL, 0.3, W.STRIP, 2.2).color(metal).ext(1, 0, 0, 0);
  S.cylinder(0, 0, 5.5, 5.5, -3, 3, { segs: 8, top: true, bottom: true, smooth: false });
  S.mat(M.EMISSIVE, 0.2, 0, 3).color(col('#bfe0ff'));
  S.cylinder(0, 0, 5.6, 5.6, -0.4, 0.4, { segs: 8, smooth: false });
  const climber = dyn.finish();
  const climbers = [climber];
  const c2 = climber.clone(); ctx.group.add(c2); climbers.push(c2);
  const baseM = ctx.M.clone();
  const T = new THREE.Matrix4();
  ctx.anim.push((t) => {
    for (let k = 0; k < climbers.length; k++) {
      const ph = ((t * 0.004 + k * 0.5) % 1);
      const y = 70 + Math.pow(ph, 2) * top * 0.3;
      climbers[k].matrix.copy(baseM).multiply(T.makeTranslation(0, k ? 70 + Math.pow(1 - ph, 2) * top * 0.3 : y, 0));
      climbers[k].matrixWorldNeedsUpdate = true;
    }
  });
  for (const c of climbers) c.matrixAutoUpdate = false;
  // orbital station far above (seen as a ring of lights)
  B.mat(M.METAL, 0.3, W.STRIP, 3).color(metal).ext(1, 0, 0, 0);
  B.cylinder(0, 0, 220, 220, top - 20, top + 20, { segs: 24, top: true, bottom: true, smooth: false });
  for (let k = 0; k < 24; k++) glow(ctx, Math.cos(k / 24 * TAU) * 225, top, Math.sin(k / 24 * TAU) * 225, col('#cfe6ff'), 40, 0);
  ctx.collider(0, 5, 0, 26, 9, 26, true);
  ctx.useTile(null);
  ctx.landmarkSpots.push({ x, z, h: fp.max + 60, kind: 'elevator', title: 'The Skyhook' });
  ctx.poiAt(x, z, fp.max + 12, 90, 'landmark', 'The Skyhook');
  void pal; void rng;
}

// ---------------------------------------------------------------- Colossus (statue)
export function colossus(ctx, x, z, height, mat = M.MOSSSTONE, color = null, pose = 0) {
  ctx.useTile('landmark');
  const fr = ctx.frame;
  const fp = fr.footprint(x, z, height * 0.4, height * 0.4, 0, 3);
  const yaw = Math.atan2(ctx.plan.center[0] - x, ctx.plan.center[1] - z);
  ctx.place(x, z, fp.min - 1, yaw);
  const B = ctx.B;
  const s = height / 2.4;
  B.mat(M.STONE, 0.6, 0, 3).color(ctx.pal.stone).ext(0.95, 0, F.NOWIN, 0);
  B.boxC(0, -2, 0, s * 1.3, s * 0.35 + 2, s * 1.3);
  figure(B, 0, s * 0.35, 0, s, mat, color || col('#a49c88'), pose);
  ctx.collider(0, height / 2, 0, s * 0.45, height / 2, s * 0.45, false);
  ctx.useTile(null);
  ctx.landmarkSpots.push({ x, z, h: fp.min + height, kind: 'colossus', title: 'The Colossus' });
  ctx.poiAt(x, z, fp.min + 3, height, 'landmark', 'The Colossus');
}

// ---------------------------------------------------------------- Lighthouse
export function lighthouse(ctx, x, z) {
  ctx.useTile('landmark');
  const fr = ctx.frame;
  const fp = fr.footprint(x, z, 10, 10, 0, 3);
  ctx.place(x, z, fp.min, 0);
  const B = ctx.B, pal = ctx.pal;
  const H = 34;
  B.mat(M.PLASTER, 0.3, W.PORTHOLE, 6).color(col('#f2eee6')).ext(1, 0, 0, 0);
  B.cylinder(0, 0, 4.2, 2.8, -1, H, { segs: 16, base: -1 });
  B.mat(M.PLASTER, 0.3, 0, 3).color(col('#b8432f')).ext(1, 0, F.NOWIN, 0);
  for (const y of [8, 18]) B.cylinder(0, 0, 4.2 - (y / H) * 1.4 + 0.02, 4.2 - ((y + 3) / H) * 1.4 + 0.02, y, y + 3, { segs: 16 });
  B.mat(M.IRON, 0.3, 0, 3).color(pal.iron);
  B.cylinder(0, 0, 3.8, 3.8, H, H + 0.4, { segs: 16, top: true });
  B.mat(M.EMISSIVE, 0.3, 0, 3).color(col('#fff2c8'));
  B.cylinder(0, 0, 2.0, 2.0, H + 0.4, H + 3.2, { segs: 12 });
  B.mat(M.BRONZE, 0.3, 0, 3).color(col('#6a4a2a'));
  B.lathe(0, 0, [[2.6, H + 3.2], [1.6, H + 4.6], [0.05, H + 5.6]], { segs: 12 });
  glow(ctx, 0, H + 1.8, 0, col('#fff2c8'), 4, 0);
  ctx.collider(0, H / 2, 0, 3.6, H / 2, 3.6, false);
  ctx.useTile(null);
  ctx.landmarkSpots.push({ x, z, h: fp.min + H, kind: 'lighthouse', title: 'The Lighthouse' });
}

// ---------------------------------------------------------------- island waterfalls
const FALL_VERT = /* glsl */`
attribute float aSeed; attribute float aVeil;
varying vec2 vUv; varying float vSeed; varying float vVeil; varying float vDist;
void main(){
  vUv = uv; vSeed = aSeed; vVeil = aVeil;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const FALL_FRAG = /* glsl */`
uniform float uCivTime, uCivDay, uCivNight; uniform vec3 uCivSkyZ, uCivSkyH, uCivSunL;
varying vec2 vUv; varying float vSeed; varying float vVeil; varying float vDist;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
void main(){
  float v = vUv.y, u = vUv.x;
  // falling streaks: stretched noise scrolling down, accelerating with the fall
  float sp = uCivTime * (0.18 + 0.05 * vSeed);
  float s1 = n2(vec2(u * 14.0 + vSeed * 31.0, v * 3.0 - sp * 6.0));
  float s2 = n2(vec2(u * 33.0 - vSeed * 17.0, v * 7.0 - sp * 11.0));
  float streak = smoothstep(0.25, 0.85, s1 * 0.6 + s2 * 0.4);
  float edge = pow(max(0.0, sin(3.14159 * u)), mix(0.6, 1.6, v));
  float a;
  if (vVeil < 0.5) {
    // the sheet: dense at the lip, breaking into strands, gone by ~70% of the drop
    a = mix(0.85, 0.35, smoothstep(0.0, 0.5, v)) * mix(0.55, 1.0, streak) * edge;
    a *= 1.0 - smoothstep(0.35, 0.72, v + (s1 - 0.5) * 0.25);
  } else {
    // the spray veil: wide soft mist growing below the sheet, dissolving into air
    float m = n2(vec2(u * 5.0 + vSeed * 9.0, v * 2.5 - sp * 2.0)) * 0.6 + n2(vec2(u * 11.0, v * 5.0 - sp * 3.5)) * 0.4;
    a = 0.32 * smoothstep(0.1, 0.45, v) * (1.0 - smoothstep(0.55, 1.0, v)) * edge * (0.5 + 0.7 * m);
  }
  a *= smoothstep(0.0, 0.02, v);
  float sun = max(0.0, uCivSunL.y);
  vec3 lit = uCivSkyZ * 0.55 + uCivSkyH * 0.9 + vec3(1.0, 0.86, 0.68) * sun * 1.6 * uCivDay;
  vec3 col = lit * mix(0.95, 1.15, streak) + vec3(0.02, 0.025, 0.03);
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}`;

function waterfallMesh(ctx, R, rng) {
  const P = [], UV = [], S = [], V = [], I = [];
  const rows = 28, cols = 6;
  const nf = 3;
  for (let f = 0; f < nf; f++) {
    const a = rng.range(0, TAU), w0 = rng.range(3.5, 6.5), len = rng.range(140, 220), seed = rng.float();
    const ox = Math.cos(a), oz = Math.sin(a), tx = -oz, tz = ox;
    for (let veil = 0; veil < 2; veil++) {
      const base = P.length / 3;
      for (let j = 0; j <= rows; j++) {
        const t = j / rows;
        // the sheet arcs off the lip and drops, drifting a little outward
        const out = R * 1.0 + 1.2 + 9 * Math.sqrt(t) + (veil ? 4 : 0);
        const y = -1 - len * t * (veil ? 1.05 : 1.0) + (veil ? -len * 0.08 : 0);
        const w = (veil ? w0 * 2.4 + 34 * t : w0) * (1 + t * 2.2);
        for (let i = 0; i <= cols; i++) {
          const u = i / cols, k = (u - 0.5) * w;
          P.push(ox * out + tx * k, y, oz * out + tz * k);
          UV.push(u, t); S.push(seed); V.push(veil);
        }
      }
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const q = base + j * (cols + 1) + i;
        I.push(q, q + 1, q + cols + 2, q, q + cols + 2, q + cols + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(S, 1));
  g.setAttribute('aVeil', new THREE.Float32BufferAttribute(V, 1));
  g.setIndex(I);
  g.computeBoundingSphere();
  const U = ctx.settlement.uniforms;
  const mat = new THREE.ShaderMaterial({
    vertexShader: FALL_VERT, fragmentShader: FALL_FRAG,
    uniforms: { uCivTime: U.uCivTime, uCivDay: U.uCivDay, uCivNight: U.uCivNight, uCivSkyZ: U.uCivSkyZ, uCivSkyH: U.uCivSkyH, uCivSunL: U.uCivSunL },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(ctx.M);
  mesh.renderOrder = 2;
  ctx.settlement.meshes.push(mesh);
  return mesh;
}
