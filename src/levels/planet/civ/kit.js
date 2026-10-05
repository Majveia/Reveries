// Shared architectural kit: street lamps, lanterns, banners, market stalls,
// fountains, crates, stairs, plinths, statues, low walls, bunting … used by
// every style generator. All functions draw into ctx.B (architecture builder)
// in the current placement frame and register glows / colliders on ctx.

import * as THREE from 'three';
import { M, W, F } from './ids.js';

const _v = new THREE.Vector3(), _m = new THREE.Matrix4();
export const col = (hex) => new THREE.Color(hex);
export const TAU = Math.PI * 2;

/** Push a glow light at building-local point (x,y,z) under the current placement. */
export function glow(ctx, x, y, z, color, scale = 1, phase = 0) {
  _v.set(x, y, z).applyMatrix4(ctx.M);
  ctx.glows.push({ position: _v.clone(), color: color.isColor ? color : col(color), scale, phase });
}
/** Lamp pool on the ground (for the street material), building-local point. */
export function pool(ctx, x, y, z, r = 7, k = 1) {
  _v.set(x, y, z).applyMatrix4(ctx.M);
  ctx.lamps.push({ p: _v.clone(), r, k });
}

/** Plinth/foundation under a footprint: from below the lowest ground up to `top`. */
export function plinth(ctx, w, d, lot, top, mat = M.STONE, color = ctx.pal.stone, extra = 0.15) {
  const B = ctx.B;
  const y0 = (lot.low ?? lot.base) - (lot.base ?? 0) - 0.8;
  B.mat(mat, ctx.rng.float(), 0, 3).color(color).ext(0.9, 0, F.NOWIN, 0);
  B.box(-w / 2 - extra, y0, -d / 2 - extra, w / 2 + extra, top, d / 2 + extra, { base: y0, top: true, topMat: [mat, ctx.rng.float(), 0, 3] });
  B.ext(1, 0, 0, 0);
}

/** Street lamp post (iron + glass lantern) at plan point. kind: 'iron' | 'stone' | 'paper' | 'tech' */
export function lampPost(ctx, x, z, kind = 'iron', yaw = 0) {
  const fr = ctx.frame, h = fr.hAt(x, z);
  ctx.place(x, z, h, yaw);
  const B = ctx.B, lc = ctx.pal.lamp;
  if (kind === 'paper') {
    // stone toro lantern
    B.mat(M.STONE, 0.3, 0, 3).color(ctx.pal.stone).ext(0.9, 0, F.NOWIN, 0);
    B.boxC(0, -0.3, 0, 0.7, 0.45, 0.7);
    B.cylinder(0, 0, 0.16, 0.14, 0.15, 1.0, { segs: 6 });
    B.boxC(0, 1.0, 0, 0.62, 0.12, 0.62);
    B.mat(M.PAPER, 0.5, 0, 3).color(lc);
    B.boxC(0, 1.12, 0, 0.42, 0.42, 0.42, { top: false });
    B.mat(M.STONE, 0.3, 0, 3).color(ctx.pal.stone);
    B.pyramid(0, 0, 0.9, 0.9, 1.54, 0.38);
    B.boxC(0, 1.88, 0, 0.12, 0.14, 0.12);
    glow(ctx, 0, 1.33, 0, lc, 0.55, 0.3 + ctx.rng.float());
    pool(ctx, 0, 0, 0, 5, 0.7);
    return;
  }
  if (kind === 'tech') {
    B.mat(M.METAL, 0.2, 0, 3).color(ctx.pal.metal || col('#8a9098')).ext(1, 0, F.NOWIN, 0);
    B.boxC(0, -0.2, 0, 0.5, 0.35, 0.5);
    B.cylinder(0, 0, 0.08, 0.07, 0, 4.4, { segs: 6 });
    B.boxC(0.35, 4.3, 0, 0.9, 0.12, 0.26);
    B.mat(M.EMISSIVE, 0.1, 0, 3).color(lc);
    B.boxC(0.55, 4.24, 0, 0.5, 0.06, 0.18, { top: false });
    glow(ctx, 0.55, 4.18, 0, lc, 0.5);
    pool(ctx, 0.55, 0, 0, 8, 1.0);
    return;
  }
  // iron / stone lamp post with a glass lantern
  B.mat(kind === 'stone' ? M.STONE : M.IRON, 0.4, 0, 3).color(kind === 'stone' ? ctx.pal.stone : col('#1c1c1e')).ext(1, 0, F.NOWIN, 0);
  B.boxC(0, -0.25, 0, 0.42, 0.55, 0.42);
  B.cylinder(0, 0, 0.075, 0.055, 0.3, 3.2, { segs: 6 });
  B.mat(M.IRON, 0.4, 0, 3).color(col('#1c1c1e'));
  B.boxC(0, 3.15, 0, 0.36, 0.06, 0.36);
  B.mat(M.EMISSIVE, 0.2, 0, 3).color(lc);
  B.boxC(0, 3.21, 0, 0.26, 0.42, 0.26, { top: false });
  B.mat(M.IRON, 0.4, 0, 3).color(col('#1c1c1e'));
  B.pyramid(0, 0, 0.46, 0.46, 3.63, 0.3);
  glow(ctx, 0, 3.42, 0, lc, 0.6, 0.2 + ctx.rng.float() * 0.9);
  pool(ctx, 0, 0, 0, 7, 1.0);
}

/** Hanging paper lantern (building-local), e.g. under eaves. */
export function paperLantern(ctx, x, y, z, color, size = 0.32) {
  const B = ctx.B;
  B.mat(M.PAPER, ctx.rng.float(), 0, 3).color(color).ext(1, 0, 0, 0);
  B.lathe(x, z, [[0.02, y + size * 1.25], [size * 0.7, y + size * 1.05], [size, y + size * 0.5], [size * 0.7, y], [0.02, y - size * 0.15]], { segs: 8 });
  B.mat(M.WOOD, 0.1, 0, 3).color(col('#1a1410'));
  B.boxC(x, y + size * 1.25, z, 0.04, 0.6, 0.04, { top: false });
  glow(ctx, x, y + size * 0.55, z, color, size * 1.6, 0.2 + ctx.rng.float() * 0.9);
}

/**
 * Cloth banner hanging from a pole (building-local). Waves in the wind via the
 * cloth flag; double-sided. Hoist at (x, y, z), flies along +X' of `dir`.
 */
export function flag(ctx, x, y, z, w, h, color, ang = 0, vertical = false) {
  const B = ctx.B;
  B.mat(M.CLOTH, ctx.rng.float(), 0, 3).color(color);
  const c = Math.cos(ang), s = Math.sin(ang);
  const n = Math.max(2, Math.ceil(w / 0.5));
  const se = B.e.slice();
  B.e[0] = 1; B.e[1] = w; B.e[2] = F.CLOTH; B.e[3] = h;
  for (const side of [1, -1]) {
    const start = B.n;
    for (let i = 0; i <= n; i++) {
      const u = (i / n) * w;
      for (const v of [0, h]) {
        const px = x + (vertical ? 0 : u * c), pz = z + (vertical ? 0 : -u * s);
        const py = vertical ? y - u : y - v;
        const qx = vertical ? x + v * c : px, qz = vertical ? z - v * s : pz;
        B.v(qx, py, qz, s * side, 0, c * side, u, h - v);
      }
    }
    for (let i = 0; i < n; i++) {
      const a = start + i * 2;
      if (side > 0) B.quad(a, a + 2, a + 3, a + 1); else B.quad(a, a + 1, a + 3, a + 2);
    }
  }
  B.e = se;
}

/** Bunting: a sagging string of small pennants between two building-local points. */
export function bunting(ctx, a, b, colors, sag = 0.8) {
  const B = ctx.B;
  const L = a.distanceTo(b);
  const n = Math.max(3, Math.floor(L / 0.7));
  const dir = _v.copy(b).sub(a).normalize();
  const nx = -dir.z, nz = dir.x;
  // the string
  const pts = [];
  for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push(new THREE.Vector3().lerpVectors(a, b, t).add(new THREE.Vector3(0, -sag * 4 * t * (1 - t), 0))); }
  B.mat(M.WOOD, 0.2, 0, 3).color(col('#2a2622')).ext(1, 0, 0, 0);
  B.tube(pts, 0.012, 3);
  const se = B.e.slice();
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const p = new THREE.Vector3().lerpVectors(a, b, t); p.y -= sag * 4 * t * (1 - t);
    const c = colors[i % colors.length];
    B.mat(M.CLOTH, 0.9, 0, 3).color(c);
    B.e[0] = 1; B.e[1] = 0.3; B.e[2] = F.CLOTH; B.e[3] = 0.35;
    const hw = 0.13;
    for (const sd of [1, -1]) {
      const i0 = B.v(p.x - dir.x * hw, p.y, p.z - dir.z * hw, nx * sd, 0, nz * sd, 0, 0.35);
      const i1 = B.v(p.x + dir.x * hw, p.y, p.z + dir.z * hw, nx * sd, 0, nz * sd, 0.3, 0.35);
      const i2 = B.v(p.x, p.y - 0.34, p.z, nx * sd, 0, nz * sd, 0.15, 0);
      if (sd > 0) B.tri(i0, i2, i1); else B.tri(i0, i1, i2);
    }
  }
  B.e = se;
}

/** Market stall with a striped cloth canopy, at plan point. */
export function stall(ctx, x, z, yaw, color) {
  const fr = ctx.frame, h = fr.hAt(x, z);
  ctx.place(x, z, h, yaw);
  const B = ctx.B, rng = ctx.rng;
  const w = rng.range(2.2, 3.2), d = rng.range(1.6, 2.2);
  B.mat(M.WOOD, rng.float(), 0, 3).color(ctx.pal.wood).ext(1, 0, F.NOWIN, 0);
  for (const [px, pz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) B.boxC(px, -0.2, pz, 0.1, (pz > 0 ? 2.3 : 2.6) + 0.2, 0.1);
  B.boxC(0, 0, d * 0.25, w, 0.9, d * 0.45);
  // goods: little colored boxes
  for (let i = 0; i < 5; i++) {
    B.mat(M.CLOTH, rng.float(), 0, 3).color(new THREE.Color().setHSL(rng.float(), rng.range(0.4, 0.8), rng.range(0.3, 0.55)));
    B.boxC(-w / 2 + 0.3 + (i / 5) * (w - 0.4), 0.9, d * 0.25 + rng.range(-0.2, 0.2), 0.32, rng.range(0.1, 0.3), 0.3);
  }
  // canopy (slanted, double sided cloth)
  B.mat(M.CLOTH, rng.float(), 0, 3).color(color);
  const se = B.e.slice(); B.e[1] = w + 0.4; B.e[3] = d + 0.4; B.e[2] = 0;
  const y1 = 2.75, y0 = 2.35;
  const pA = new THREE.Vector3(-w / 2 - 0.2, y1, -d / 2 - 0.2), pB = new THREE.Vector3(w / 2 + 0.2, y1, -d / 2 - 0.2), pC = new THREE.Vector3(w / 2 + 0.2, y0, d / 2 + 0.3), pD = new THREE.Vector3(-w / 2 - 0.2, y0, d / 2 + 0.3);
  B.quadP(pD, pC, pB, pA, [0, 0], [w, 0], [w, d], [0, d]);
  B.quadP(pA, pB, pC, pD, [0, 0], [w, 0], [w, d], [0, d]);
  // valance
  B.wall(-w / 2 - 0.2, d / 2 + 0.3, w / 2 + 0.2, d / 2 + 0.3, y0 - 0.3, y0, y0 - 0.3, 0, 0.3);
  B.e = se;
  ctx.collider(0, 0.6, 0, w / 2 + 0.2, 0.6, d / 2 + 0.2, false);
}

/** Stone fountain with basin and spout, at plan point. */
export function fountain(ctx, x, z, r = 3) {
  const fr = ctx.frame, h = fr.hAt(x, z);
  ctx.place(x, z, h, 0);
  const B = ctx.B;
  B.mat(M.STONE, 0.5, 0, 3).color(ctx.pal.stone).ext(0.95, 0, F.NOWIN, 0);
  B.cylinder(0, 0, r, r, -0.4, 0.55, { segs: 24, top: false });
  B.cylinder(0, 0, r - 0.3, r - 0.3, 0.55, -0.2, { segs: 24 });
  B.disc(0, 0.55, 0, r, 24, 1, [M.STONE, 0.5, 0, 3]);
  B.mat(M.GLASS, 0.5, 0, 3).color(col('#203a40'));
  B.disc(0, 0.35, 0, r - 0.3, 24, 1);
  B.mat(M.STONE, 0.5, 0, 3).color(ctx.pal.stone);
  B.lathe(0, 0, [[0.5, 0.3], [0.35, 1.2], [0.9, 1.5], [1.0, 1.65], [0.2, 1.75], [0.18, 2.4], [0.45, 2.6], [0.05, 2.85]], { segs: 14 });
  ctx.collider(0, 0.3, 0, r, 0.6, r, true);
}

/** Small statue on a pedestal (robed figure with raised arm), plan point. */
export function statue(ctx, x, z, yaw, s = 1, mat = M.BRONZE, colr = null) {
  const fr = ctx.frame, h = fr.hAt(x, z);
  ctx.place(x, z, h, yaw);
  const B = ctx.B;
  B.mat(M.STONE, 0.6, 0, 3).color(ctx.pal.stone).ext(0.95, 0, F.NOWIN, 0);
  B.boxC(0, -0.4, 0, 1.6 * s, 0.7 + 0.4, 1.6 * s);
  B.boxC(0, 0.7, 0, 1.2 * s, 1.4 * s, 1.2 * s);
  B.boxC(0, 0.7 + 1.4 * s, 0, 1.45 * s, 0.18 * s, 1.45 * s);
  figure(B, 0, 0.88 + 1.4 * s, 0, 1.0 * s * 1.25, mat, colr || col('#6a4a2a'));
  ctx.collider(0, 1.2 * s, 0, 0.8 * s, 1.2 * s + 0.4, 0.8 * s, false);
}

/** A robed figure built from lathes and tubes (statues, colossi). y0 = feet; s = height/2.4. */
export function figure(B, x, y0, z, s, mat, color, pose = 0) {
  B.mat(mat, 0.37, 0, 3).color(color).ext(1, 0, F.NOWIN, 0);
  // robe
  B.lathe(x, z, [[0.42 * s, y0], [0.38 * s, y0 + 0.5 * s], [0.3 * s, y0 + 1.1 * s], [0.25 * s, y0 + 1.5 * s], [0.3 * s, y0 + 1.65 * s], [0.22 * s, y0 + 1.82 * s], [0.06 * s, y0 + 1.86 * s]], { segs: 12 });
  // head
  B.lathe(x, z, [[0.03 * s, y0 + 1.84 * s], [0.13 * s, y0 + 1.9 * s], [0.15 * s, y0 + 2.02 * s], [0.12 * s, y0 + 2.14 * s], [0.02 * s, y0 + 2.2 * s]], { segs: 10 });
  // arms
  const sh = [x + 0.28 * s, y0 + 1.62 * s, z], sh2 = [x - 0.28 * s, y0 + 1.62 * s, z];
  const raise = pose === 0;
  B.tube([new THREE.Vector3(...sh), new THREE.Vector3(x + 0.38 * s, y0 + (raise ? 2.0 : 1.2) * s, z + 0.1 * s), new THREE.Vector3(x + 0.42 * s, y0 + (raise ? 2.45 : 0.95) * s, z + 0.15 * s)], 0.07 * s, 5);
  B.tube([new THREE.Vector3(...sh2), new THREE.Vector3(x - 0.36 * s, y0 + 1.25 * s, z + 0.12 * s), new THREE.Vector3(x - 0.2 * s, y0 + 1.1 * s, z + 0.3 * s)], 0.07 * s, 5);
}

/** Stack of crates / barrels near a point (building-local). */
export function crates(ctx, x, y, z, n = 3) {
  const B = ctx.B, rng = ctx.rng;
  for (let i = 0; i < n; i++) {
    const s = rng.range(0.5, 0.9);
    if (rng.chance(0.5)) {
      B.mat(M.WOOD, rng.float(), 0, 3).color(ctx.pal.wood).ext(0.95, 0, F.NOWIN, 0);
      B.boxC(x + rng.range(-1, 1), y, z + rng.range(-0.8, 0.8), s, s, s);
    } else {
      B.mat(M.WOOD, rng.float(), 0, 3).color(ctx.pal.wood.clone().multiplyScalar(0.8)).ext(0.95, 0, F.NOWIN, 0);
      B.lathe(x + rng.range(-1, 1), z + rng.range(-0.8, 0.8), [[0.28, y], [0.34, y + 0.4], [0.28, y + 0.8], [0.01, y + 0.8]], { segs: 8 });
    }
  }
}

/** Dry-stone wall along a plan polyline (draped over the terrain). */
export function lowWall(ctx, pts, h = 0.9, t = 0.6, mat = M.STONE, color = null) {
  const fr = ctx.frame, B = ctx.B;
  B.resetMatrix(); ctx.M.identity();
  B.mat(mat, ctx.rng.float(), 0, 3).color(color || ctx.pal.stone).ext(0.9, 0, F.NOWIN, 0);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3();
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
    const L = Math.hypot(x1 - x0, z1 - z0); if (L < 0.3) continue;
    const nx = -(z1 - z0) / L * t / 2, nz = (x1 - x0) / L * t / 2;
    const h0 = fr.hAt(x0, z0), h1 = fr.hAt(x1, z1);
    // two sides + top, each a quad from ground-0.3 to ground+h
    for (const s of [1, -1]) {
      fr.point(x0 + nx * s, z0 + nz * s, h0 - 0.3, a); fr.point(x1 + nx * s, z1 + nz * s, h1 - 0.3, b);
      fr.point(x1 + nx * s, z1 + nz * s, h1 + h, c); fr.point(x0 + nx * s, z0 + nz * s, h0 + h, d);
      const want = _v.set(nx * s, 0, nz * s);
      B.e[1] = L; B.e[3] = h;
      B.quadP(a, b, c, d, [0, 0], [L, 0], [L, h + 0.3], [0, h + 0.3], want);
    }
    fr.point(x0 + nx, z0 + nz, h0 + h, a); fr.point(x1 + nx, z1 + nz, h1 + h, b);
    fr.point(x1 - nx, z1 - nz, h1 + h, c); fr.point(x0 - nx, z0 - nz, h0 + h, d);
    B.quadP(a, b, c, d, [0, 0], [L, 0], [L, t], [0, t], _v.set(0, 1, 0));
  }
}

/** Straight stair flight (building-local) climbing +Z from (z0,y0) to (z1,y1). */
export function stair(ctx, x0, x1, z0, z1, y0, y1, mat = M.STONE, color = null) {
  const B = ctx.B;
  B.mat(mat, ctx.rng.float(), 0, 3).color(color || ctx.pal.stone).ext(0.92, 0, F.NOWIN, 0);
  B.stairs(x0, x1, z0, z1, y0, y1, { step: 0.18, solid: true, floor: Math.min(y0, y1) - 1.0, sideFaces: true });
}

/** Ground-level lamp glows and simple stone bollards along a road, every `every` m. */
export function roadLamps(ctx, road, every, kind, offset = 0.8) {
  const pts = road.pts;
  let s = 0, next = every * 0.5;
  let side = 1;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const L = Math.hypot(bx - ax, bz - az); if (L < 1e-3) continue;
    while (next < s + L) {
      const t = (next - s) / L;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const nx = -(bz - az) / L, nz = (bx - ax) / L;
      const px = x + nx * (road.w / 2 + offset) * side, pz = z + nz * (road.w / 2 + offset) * side;
      if (!ctx.frame.wet(px, pz) && ctx.free(px, pz, 0.6)) lampPost(ctx, px, pz, kind, Math.atan2(-nx * side, -nz * side));
      side = -side;
      next += every;
    }
    s += L;
  }
}

/**
 * Garden tree at plan point: 'round' (deciduous), 'cypress', 'maple' (layered,
 * spreading), 'pine'. Trunk + noisy foliage lobes; cheap enough for hundreds.
 */
export function tree(ctx, x, z, kind, colors, scale = 1, foliageBlob) {
  const fr = ctx.frame, rng = ctx.rng;
  ctx.place(x, z, fr.hAt(x, z) - 0.2, rng.float() * TAU);
  const B = ctx.B;
  const s = scale * rng.range(0.8, 1.2);
  const bark = col('#4a3a2c');
  B.mat(M.WOOD, rng.float(), 0, 3).color(bark).ext(0.9, 0, F.NOWIN, 0);
  if (kind === 'cypress') {
    B.cylinder(0, 0, 0.18 * s, 0.12 * s, 0, 1.5 * s, { segs: 5 });
    const h = rng.range(7, 11) * s;
    B.mat(M.FOLIAGE, rng.float(), 0, 3).color(rng.pick(colors).clone().multiplyScalar(0.7)).ext(0.85, 0, F.NOWIN, 0);
    B.lathe(0, 0, [[0.6 * s, 1.0 * s], [1.1 * s, h * 0.3], [0.9 * s, h * 0.65], [0.3 * s, h * 0.92], [0.02, h]], { segs: 8 });
    ctx.collider(0, h / 2, 0, 0.6 * s, h / 2, 0.6 * s, false);
    return;
  }
  const h = (kind === 'maple' ? rng.range(5, 8) : rng.range(5, 9)) * s;
  const lean = rng.range(-0.6, 0.6) * s;
  B.tube([new THREE.Vector3(0, 0, 0), new THREE.Vector3(lean * 0.4, h * 0.45, 0), new THREE.Vector3(lean, h * 0.75, lean * 0.3)], 0.22 * s, 5);
  const n = kind === 'maple' ? rng.int(3, 5) : rng.int(2, 4);
  for (let i = 0; i < n; i++) {
    const a = rng.float() * TAU, rr = (kind === 'maple' ? rng.range(1.2, 2.6) : rng.range(0.6, 1.8)) * s;
    const r = (kind === 'maple' ? rng.range(1.8, 2.8) : rng.range(1.8, 3.0)) * s;
    const cy = h * (kind === 'maple' ? rng.range(0.72, 1.0) : rng.range(0.78, 1.05));
    foliageBlob(B, lean + Math.cos(a) * rr, cy, lean * 0.3 + Math.sin(a) * rr, r, rng.pick(colors).clone().multiplyScalar(rng.range(0.85, 1.1)), Math.floor(rng.float() * 1000), 10);
  }
  ctx.collider(0, h * 0.4, 0, 0.35 * s, h * 0.4, 0.35 * s, false);
}

/** Plant garden trees on free ground near the roads of the inner town. */
export function plantTrees(ctx, n, kinds, colors, foliageBlob, maxZone = 0.95) {
  const { plan, rng } = ctx;
  let planted = 0;
  for (let k = 0; k < n * 8 && planted < n; k++) {
    const road = rng.pick(plan.roads);
    if (!road || road.pts.length < 2) continue;
    const i = rng.int(0, road.pts.length - 2);
    const [ax, az] = road.pts[i], [bx, bz] = road.pts[i + 1];
    const L = Math.hypot(bx - ax, bz - az) || 1;
    const side = rng.chance(0.5) ? 1 : -1;
    const off = road.w / 2 + rng.range(1.5, 7);
    const x = ax - (bz - az) / L * off * side, z = az + (bx - ax) / L * off * side;
    if (Math.hypot(x - plan.center[0], z - plan.center[1]) > plan.builtRadius * maxZone + 40) continue;
    if (!ctx.free(x, z, 1.4)) continue;
    tree(ctx, x, z, rng.pick(kinds), colors, 1, foliageBlob);
    ctx.occupy(x, z, 2.2);
    planted++;
  }
}

/**
 * Catenary strings of lanterns / festival lights across a road (glow sprites
 * on a sagging curve between the facades). colors: array of THREE.Color.
 */
export function lanternStrings(ctx, road, every, colors, o = {}) {
  const pts = road.pts, f = ctx.frame, plan = ctx.plan;
  const maxR = (plan.builtRadius || 300) * (o.core ?? 0.6);
  const n = o.n ?? 7, sag = o.sag ?? 1.1, h = o.h ?? 5.6, scale = o.scale ?? 0.5;
  let s = 0, next = every * 0.5, k = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const L = Math.hypot(bx - ax, bz - az); if (L < 1e-3) continue;
    while (next < s + L) {
      const t = (next - s) / L;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      next += every;
      if (Math.hypot(x - plan.center[0], z - plan.center[1]) > maxR) continue;
      const nx = -(bz - az) / L, nz = (bx - ax) / L;
      const half = road.w / 2 + (o.overhang ?? 1.2);
      const y0 = Math.max(f.hAt(x + nx * half, z + nz * half), f.hAt(x - nx * half, z - nz * half)) + h;
      if (f.wet(x, z)) continue;
      for (let j = 0; j < n; j++) {
        const u = (j + 0.5) / n * 2 - 1;
        const px = x + nx * half * u, pz = z + nz * half * u;
        const py = y0 - sag * (1 - u * u);
        const c = colors[(j + k) % colors.length];
        ctx.glows.push({ position: f.point(px, pz, py), color: c, scale: scale * (0.85 + 0.3 * ctx.rng.float()), phase: ctx.rng.float() });
      }
      k++;
    }
    s += L;
  }
}
