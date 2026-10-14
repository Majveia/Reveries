// Organic — Moebius / Avatar: houses that are grown, not built. Bulbous
// shell pods on tapering stems, ribbed towers of stacked bulbs, arching
// tendrils over the paths, mushroom canopies over the plaza, lumen stalks
// that breathe light at night, and a hometree whose crown is a city.

import * as THREE from 'three';
import { M, W, F, G } from '../ids.js';
import { col, glow, pool, TAU } from '../kit.js';
import { rockLathe, foliageBlob } from '../landmarks.js';

export function palette(A, rng) {
  const P = A?.palette || {};
  const glowC = (P.glow || [P.accent || '#3ff0ff', '#c04bff', '#5aff9a']).map(col);
  const pastel = A?.name === 'Arzach' || (P.sky && col(P.sky).r > col(P.sky).b);
  void rng;
  return {
    shells: (pastel ? ['#f2d6c4', '#e8c4b8', '#f6e6d0', '#d8b8c8', '#cfe2d6', '#f0dcb4'] : ['#cfe0d4', '#9fc8c0', '#e2dcc8', '#8fb8b0', '#c8b8d8', '#a8c8a0', '#d8e4d0']).map(col),
    ribs: (pastel ? ['#b07c86', '#8a6a7a'] : ['#3e4a40', '#4a3e52', '#2e3a34']).map(col),
    glow: glowC,
    stone: col(P.rock || '#7a7468'), stoneDark: col('#5a5650'), wood: col('#5a4a3a'), trim: col('#e8e0d0'), iron: col('#2a2a2a'),
    lamp: glowC[0], accent: col(P.accent || '#3ff0ff'),
    cloth: glowC,
    foliage: (P.foliage || ['#2f8a4a', '#1f6a3a', '#5ab04a']).map(col),
    ground: { main: col('#9a947e'), street: col('#8e8a74'), lane: col('#7a7460'), plaza: col('#a8a28a'), dirt: col('#6a6450') },
    metal: col('#8a9098'),
  };
}

export function roadMat(road) { return road.kind === 'main' ? G.FLAG : G.DIRT; }
export const plazaMat = () => G.TERRACE;
export const shotSun = 0.11;
export const shot = { dist: 1.0, height: 38, sunAngle: 1.8, lmLift: 0.35 };

function pod(ctx, x, y, z, r, h, color, seed, kind = 0) {
  const B = ctx.B;
  let prof;
  if (kind === 1) prof = [[r * 0.3, y], [r * 0.9, y + h * 0.18], [r, y + h * 0.42], [r * 0.82, y + h * 0.62], [r * 0.42, y + h * 0.8], [r * 0.12, y + h * 0.93], [0.03, y + h * 1.12]]; // onion
  else if (kind === 2) prof = [[r * 0.25, y], [r * 0.95, y + h * 0.12], [r * 1.1, y + h * 0.3], [r * 1.0, y + h * 0.42], [r * 0.5, y + h * 0.5], [0.05, y + h * 0.54]]; // disc / saucer
  else prof = [[r * 0.35, y], [r * 0.85, y + h * 0.15], [r, y + h * 0.38], [r * 0.92, y + h * 0.6], [r * 0.6, y + h * 0.82], [r * 0.22, y + h * 0.97], [0.05, y + h]]; // gourd
  B.mat(M.SHELL, seed, W.PORTHOLE, Math.max(2.6, h / 2)).color(color).ext(1, 0, F.FRONT, 0);
  B.lathe(x, z, prof, { segs: 20, flags: F.FRONT });
  return y + h * (kind === 2 ? 0.54 : kind === 1 ? 1.12 : 1);
}

export function building(ctx, lot) {
  const { rng, pal } = ctx;
  ctx.place(lot.x, lot.z, lot.low ?? lot.base, lot.yaw);
  const B = ctx.B;
  const r = Math.min(lot.w, lot.d) * rng.range(0.4, 0.5);
  const kind = rng.int(0, 2);
  const core = lot.zone < 0.35;
  const shell = rng.pick(pal.shells).clone().multiplyScalar(rng.range(0.92, 1.04));
  const rib = rng.pick(pal.ribs);
  const lift = (lot.base - (lot.low ?? lot.base)) + rng.range(1.2, 3.5);
  // stem / root flare
  B.mat(M.SHELL, rng.float(), 0, 3).color(rib).ext(0.9, 0, F.NOWIN, 0);
  B.lathe(0, 0, [[r * 0.75, -1], [r * 0.42, 0.4], [r * 0.24, lift * 0.6], [r * 0.4, lift + 0.4]], { segs: 12 });
  let top;
  if (core && rng.chance(0.35)) {
    // tower of stacked bulbs
    let y = lift;
    const n = rng.int(3, 5);
    let rr = r * 1.05;
    for (let i = 0; i < n; i++) {
      const h = rr * rng.range(1.5, 1.9);
      pod(ctx, 0, y, 0, rr, h, shell.clone().multiplyScalar(1 - i * 0.03), rng.float());
      // glowing waist ring
      B.mat(M.EMISSIVE, 0.2, 0, 3).color(rng.pick(pal.glow).clone().multiplyScalar(0.6)).ext(1, 0, F.NOWIN, 0);
      B.cylinder(0, 0, rr * 0.36, rr * 0.36, y + h * 0.97, y + h * 1.03, { segs: 14 });
      y += h * 0.92; rr *= 0.82;
    }
    top = y;
    B.mat(M.SHELL, rng.float(), 0, 3).color(rib);
    B.cylinder(0, 0, 0.18, 0.04, y, y + 6, { segs: 6 });
    ctx.beacons.push({ position: new THREE.Vector3(0, y + 6.2, 0).applyMatrix4(ctx.M), color: rng.pick(pal.glow), scale: 0.6, phase: 0.3 + rng.float() });
  } else {
    const h = r * rng.range(1.7, 2.4) * (kind === 2 ? 1.6 : 1);
    top = pod(ctx, 0, lift, 0, r, h, shell, rng.float(), kind);
    // smaller fused pod
    if (rng.chance(0.55)) {
      const a = rng.range(0, TAU), rr = r * rng.range(0.45, 0.65);
      pod(ctx, Math.cos(a) * r * 0.85, lift + h * 0.15, Math.sin(a) * r * 0.85, rr, rr * 1.8, rng.pick(pal.shells).clone().multiplyScalar(0.96), rng.float(), rng.int(0, 1));
    }
    // cap spike / sprout
    B.mat(M.SHELL, rng.float(), 0, 3).color(rib).ext(1, 0, F.NOWIN, 0);
    B.cylinder(0, 0, 0.3, 0.02, top - 0.3, top + rng.range(1.5, 4), { segs: 6 });
  }
  // external ribs sweeping up the body
  B.mat(M.SHELL, rng.float(), 0, 3).color(rib).ext(1, 0, F.NOWIN, 0);
  const nr = rng.int(3, 5);
  for (let k = 0; k < nr; k++) {
    const a = (k / nr) * TAU + rng.float();
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const rad = r * (0.5 + 0.62 * Math.sin(Math.PI * (0.1 + 0.8 * t)));
      pts.push(new THREE.Vector3(Math.cos(a + t * 0.6) * rad, lift - 0.5 + (top - lift) * t * 0.85, Math.sin(a + t * 0.6) * rad));
    }
    B.tube(pts, 0.16 + r * 0.02, 5);
  }
  // door membrane glow + bioluminescent freckle lights
  glow(ctx, 0, lift + 1.4, r * 0.95, rng.pick(pal.glow), 0.5, rng.float());
  ctx.collider(0, (top) / 2, 0, r * 0.8, top / 2, r * 0.8, false);
  ctx.footprints.push({ lot, h: top });
}

/** Lumen stalk: a curved stem ending in a glowing bulb. */
function lumen(ctx, x, z, h, c) {
  const fr = ctx.frame;
  ctx.place(x, z, fr.hAt(x, z), ctx.rng.float() * TAU);
  const B = ctx.B;
  B.mat(M.SHELL, 0.4, 0, 3).color(ctx.pal.ribs[0]).ext(1, 0, F.NOWIN, 0);
  const pts = [new THREE.Vector3(0, -0.2, 0), new THREE.Vector3(0.1, h * 0.5, 0), new THREE.Vector3(0.6, h * 0.92, 0), new THREE.Vector3(0.9, h * 0.85, 0)];
  B.tube(pts, 0.07, 4);
  B.mat(M.EMISSIVE, 0.3, 0, 3).color(c.clone().multiplyScalar(0.7));
  B.lathe(0.95, 0, [[0.02, h * 0.85 - 0.45], [0.22, h * 0.85 - 0.3], [0.18, h * 0.85 - 0.05], [0.02, h * 0.85]], { segs: 8 });
  glow(ctx, 0.95, h * 0.85 - 0.25, 0, c, 0.6, ctx.rng.float());
  pool(ctx, 0.9, 0, 0, 6, 0.8);
}

export function plaza(ctx, pz) {
  const { rng, pal } = ctx;
  const fr = ctx.frame;
  if (pz.kind === 'main') {
    // mushroom canopies
    const n = Math.max(3, Math.floor(pz.r / 7));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rng.range(-0.2, 0.2), r = pz.r * rng.range(0.35, 0.6);
      const x = pz.x + Math.cos(a) * r, z = pz.z + Math.sin(a) * r;
      ctx.place(x, z, fr.hAt(x, z), rng.float() * TAU);
      const B = ctx.B;
      const H = rng.range(6, 11), R = rng.range(4, 7);
      B.mat(M.SHELL, rng.float(), 0, 3).color(pal.ribs[1]).ext(1, 0, F.NOWIN, 0);
      B.lathe(0, 0, [[0.9, -0.3], [0.45, 1.0], [0.38, H * 0.8], [0.6, H]], { segs: 10 });
      B.mat(M.SHELL, rng.float(), 0, 3).color(rng.pick(pal.shells));
      B.lathe(0, 0, [[R, H - 0.6], [R * 0.85, H + 0.4], [R * 0.45, H + 1.4], [0.05, H + 1.7]], { segs: 20 });
      B.lathe(0, 0, [[0.4, H], [R * 0.95, H - 0.65]], { segs: 20 });
      B.mat(M.EMISSIVE, 0.3, 0, 3).color(rng.pick(pal.glow).clone().multiplyScalar(0.5));
      B.cylinder(0, 0, R * 0.97, R * 0.97, H - 0.75, H - 0.6, { segs: 20 });
      for (let k = 0; k < 5; k++) { const b = k / 5 * TAU; glow(ctx, Math.cos(b) * R * 0.95, H - 0.9, Math.sin(b) * R * 0.95, rng.pick(pal.glow), 0.4, rng.float()); }
      ctx.collider(0, H / 2, 0, 0.6, H / 2, 0.6, false);
      ctx.occupy(x, z, 2);
    }
    // central spiral fountain sculpture
    ctx.place(pz.x, pz.z, fr.hAt(pz.x, pz.z), 0);
    const B = ctx.B;
    B.mat(M.SHELL, 0.3, 0, 3).color(pal.shells[0]).ext(1, 0, F.NOWIN, 0);
    const pts = [];
    for (let i = 0; i <= 24; i++) { const t = i / 24; pts.push(new THREE.Vector3(Math.cos(t * TAU * 1.5) * (2.4 - t * 2), t * 9, Math.sin(t * TAU * 1.5) * (2.4 - t * 2))); }
    B.tube(pts, 0.35, 6);
    B.mat(M.EMISSIVE, 0.3, 0, 3).color(pal.glow[0].clone().multiplyScalar(0.8));
    B.lathe(0, 0, [[0.02, 8.6], [0.7, 9.1], [0.02, 9.8]], { segs: 10 });
    glow(ctx, 0, 9.2, 0, pal.glow[0], 1.4, 0.2);
    ctx.occupy(pz.x, pz.z, 3);
    for (let i = 0; i < 10; i++) { const a = i / 10 * TAU; lumen(ctx, pz.x + Math.cos(a) * (pz.r - 1), pz.z + Math.sin(a) * (pz.r - 1), rng.range(3.5, 5), pal.glow[i % pal.glow.length]); }
  } else {
    lumen(ctx, pz.x, pz.z, 5, pal.glow[0]);
  }
}

export function extras(ctx) {
  const { plan, rng, pal } = ctx;
  // lumen stalks along the paths
  for (const road of plan.roads) {
    let side = 1;
    for (let i = 2; i < road.pts.length - 1; i += road.kind === 'main' ? 3 : 5) {
      const [x, z] = road.pts[i], [x2, z2] = road.pts[i + 1];
      const L = Math.hypot(x2 - x, z2 - z) || 1;
      const nx = -(z2 - z) / L, nz = (x2 - x) / L;
      const px = x + nx * (road.w / 2 + 0.8) * side, pz = z + nz * (road.w / 2 + 0.8) * side;
      side = -side;
      if (!ctx.free(px, pz, 0.5)) continue;
      lumen(ctx, px, pz, rng.range(2.6, 4.2), rng.pick(pal.glow));
    }
  }
  // living bridges between neighbouring pods
  const fps = ctx.footprints.filter((f) => f.h > 8);
  let nb = 0;
  for (let i = 0; i < fps.length && nb < 40; i++) {
    const a = fps[i];
    for (let j = i + 1; j < fps.length; j++) {
      const b = fps[j];
      const dd = Math.hypot(a.lot.x - b.lot.x, a.lot.z - b.lot.z);
      if (dd < 12 || dd > 24 || !rng.chance(0.25)) continue;
      const fr = ctx.frame;
      ctx.place(a.lot.x, a.lot.z, 0, 0);
      const inv = ctx.inv();
      const ya = (a.lot.low ?? a.lot.base) + Math.min(a.h, b.h) * 0.55, yb = (b.lot.low ?? b.lot.base) + Math.min(a.h, b.h) * 0.55;
      const pa = fr.point(a.lot.x, a.lot.z, ya).applyMatrix4(inv), pb = fr.point(b.lot.x, b.lot.z, yb).applyMatrix4(inv);
      const pts = [];
      for (let k = 0; k <= 8; k++) { const t = k / 8; pts.push(new THREE.Vector3().lerpVectors(pa, pb, t).add(new THREE.Vector3(0, -Math.sin(Math.PI * t) * dd * 0.12, 0))); }
      ctx.B.mat(M.SHELL, rng.float(), 0, 3).color(pal.ribs[0]).ext(1, 0, F.NOWIN, 0);
      ctx.B.tube(pts, 0.5, 6);
      for (let k = 2; k < 8; k += 3) glow(ctx, pts[k].x, pts[k].y - 0.6, pts[k].z, rng.pick(pal.glow), 0.3, rng.float());
      nb++;
      break;
    }
  }
  // tendril arches over main paths
  for (const road of plan.mains || []) {
    for (let i = 6; i < road.pts.length - 2; i += 9) {
      if (!rng.chance(0.6)) continue;
      const [x, z] = road.pts[i], [x2, z2] = road.pts[i + 1];
      const yaw = Math.atan2(x2 - x, z2 - z);
      ctx.place(x, z, ctx.frame.hAt(x, z), yaw + Math.PI / 2);
      const B = ctx.B;
      const span = road.w + 3, H = rng.range(6, 9);
      const pts = [];
      for (let k = 0; k <= 12; k++) { const t = k / 12; pts.push(new THREE.Vector3(-span / 2 + span * t, -0.5 + Math.sin(Math.PI * t) * H + Math.sin(t * 9) * 0.2, Math.sin(t * TAU) * 0.6)); }
      B.mat(M.SHELL, rng.float(), 0, 3).color(pal.ribs[0]).ext(1, 0, F.NOWIN, 0);
      B.tube(pts, 0.35, 6);
      for (let k = 2; k < 11; k += 2) glow(ctx, pts[k].x, pts[k].y - 0.4, pts[k].z, rng.pick(pal.glow), 0.3, rng.float());
    }
  }
}

/** Hometree: the great tree whose crown is a city. */
export function landmark(ctx) {
  const { plan, rng, pal } = ctx;
  const spot = plan.spots.find((s) => s.r > plan.builtRadius * 0.6 && s.r < plan.builtRadius * 1.3) || plan.spots[0];
  if (!spot) return;
  ctx.useTile('landmark');
  const fr = ctx.frame;
  const fp = fr.footprint(spot.x, spot.z, 50, 50, 0, 4);
  ctx.place(spot.x, spot.z, fp.min - 2, rng.float() * TAU);
  const B = ctx.B;
  const H = rng.range(170, 210), R0 = 26;
  const bark = col('#4a4038');
  B.mat(M.WOOD, 0.4, 0, 3).color(bark).ext(1, 0, F.NOWIN, 0);
  rockLathe(B, 0, 0, [[R0 * 1.6, 0], [R0, 10], [R0 * 0.62, 40], [R0 * 0.5, 90], [R0 * 0.42, 130], [R0 * 0.3, H * 0.85], [R0 * 0.18, H]], { segs: 28, amp: 0.3, fq: 0.06, seed: 77 });
  // buttress roots
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * TAU + rng.range(-0.2, 0.2);
    const L = rng.range(45, 80);
    const pts = [];
    for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push(new THREE.Vector3(Math.cos(a) * (R0 * 0.6 + L * t), 30 * Math.pow(1 - t, 1.6) - 1, Math.sin(a) * (R0 * 0.6 + L * t))); }
    B.tube(pts, 4.5 - 1.5, 7);
  }
  // spiral of dwelling pods and platforms around the trunk
  const shell = pal.shells[0];
  for (let i = 0; i < 26; i++) {
    const t = i / 26;
    const y = 18 + t * H * 0.7, a = t * TAU * 3.2;
    const rT = R0 * (0.62 - t * 0.3) + 3;
    const px = Math.cos(a) * rT, pz = Math.sin(a) * rT;
    B.mat(M.SHELL, rng.float(), 0, 3).color(pal.ribs[0]).ext(1, 0, F.NOWIN, 0);
    B.cylinder(px, pz, 4.2, 4.2, y - 0.4, y, { segs: 12, top: true, bottom: true });
    if (i % 2 === 0) {
      const rr = rng.range(2.4, 3.4);
      pod(ctx, px * 1.12, y, pz * 1.12, rr, rr * 1.8, shell.clone().multiplyScalar(rng.range(0.9, 1.05)), rng.float());
    }
    glow(ctx, px * 1.25, y + 1.2, pz * 1.25, rng.pick(pal.glow), 0.9, rng.float());
  }
  // branches and the crown
  const crowns = [];
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * TAU + rng.range(-0.3, 0.3);
    const y0 = H * rng.range(0.55, 0.85), L = rng.range(40, 70);
    const tip = new THREE.Vector3(Math.cos(a) * L, y0 + L * 0.35, Math.sin(a) * L);
    B.mat(M.WOOD, 0.4, 0, 3).color(bark);
    B.tube([new THREE.Vector3(0, y0, 0), new THREE.Vector3(Math.cos(a) * L * 0.5, y0 + L * 0.3, Math.sin(a) * L * 0.5), tip], 2.4, 6);
    crowns.push(tip);
    // hanging glowing vines
    for (let v = 0; v < 4; v++) {
      const s = rng.range(0.4, 1);
      const p = new THREE.Vector3(Math.cos(a) * L * s, y0 + L * 0.3 * s, Math.sin(a) * L * s);
      for (let j = 1; j < 6; j++) glow(ctx, p.x, p.y - j * 3.2, p.z, rng.pick(pal.glow), 0.45, rng.float());
    }
  }
  crowns.push(new THREE.Vector3(0, H, 0));
  for (let k = 0; k < crowns.length; k++) {
    const p = crowns[k];
    // cauliflower canopy: a cluster of lobes per crown, darker beneath
    for (let j = 0; j < 4; j++) {
      const rr = rng.range(14, 24);
      const ox = rng.range(-1, 1) * 16, oy = rng.range(-4, 10), oz = rng.range(-1, 1) * 16;
      const c = rng.pick(pal.foliage).clone().multiplyScalar(oy < 0 ? 0.7 : 1.0);
      foliageBlob(B, p.x + ox, p.y + oy, p.z + oz, rr, c, 90 + k * 7 + j, 16);
    }
  }
  ctx.collider(0, H / 2, 0, R0 * 0.6, H / 2, R0 * 0.6, false);
  ctx.useTile(null);
  ctx.landmarkSpots.push({ x: spot.x, z: spot.z, h: fp.min + H, kind: 'tree', title: 'The Hometree' });
  ctx.poiAt(spot.x, spot.z, fp.min + 3, 80, 'landmark', 'The Hometree');
  ctx.occupy(spot.x, spot.z, 60);
}

export function reserve(ctx) { void ctx; return []; }
