// Pastoral — Miyazaki towns: white & cream plaster, terracotta / teal roofs,
// shutters and flower boxes, round towers with conical caps, windmills on the
// hills, bunting across lanes, a bell tower over the market square, and
// Laputa itself drifting above.

import * as THREE from 'three';
import { M, W, F, G } from '../ids.js';
import { col, glow, plinth, lampPost, stall, fountain, statue, flag, bunting, crates, lowWall, roadLamps, paperLantern, plantTrees, lanternStrings, TAU } from '../kit.js';
import { floatingIsland, foliageBlob } from '../landmarks.js';

export function palette(A, rng) {
  const P = A?.palette || {};
  return {
    walls: ['#f3eee3', '#f1e8d6', '#efe2c8', '#f4efe6', '#e9dccb', '#f0dccb', '#e6e1d4', '#f2e6cf', '#dfe4e2', '#efd9b9'].map(col),
    roofs: ['#c8502e', '#d2603a', '#bc4a2c', '#d06a3c', '#c8502e', '#b4462c', '#4a9a92', '#3a8088', '#5a7a9c', '#d88a42'].map(col),
    stone: col('#9d9584'), stoneDark: col('#7d766a'), wood: col('#6a4428'), trim: col('#efe9dc'), iron: col('#1c1c1e'),
    lamp: col(P.lights || '#ffcf87'), accent: col(P.accent || '#d8432f'),
    cloth: ['#d8432f', '#f2c14e', '#3d8a84', '#f4efe6', '#5a7fbf', '#e07a5f'].map(col),
    fields: ['#c9a646', '#8bab4a', '#a4b852', '#b88a3e', '#7f9a46', '#d0b85a'].map(col),
    ground: { main: col('#958a78'), street: col('#9a8e7c'), lane: col('#8e7a5c'), plaza: col('#b0a590'), dirt: col('#8a7456') },
    metal: col('#8a9098'),
  };
}

export function roadMat(road, zone) {
  if (road.kind === 'main' || road.kind === 'avenue') return zone < 0.75 ? G.COBBLE : G.DIRT;
  if (road.kind === 'street') return zone < 0.5 ? G.COBBLE : G.DIRT;
  return G.DIRT;
}
export const plazaMat = (pz) => (pz.kind === 'main' ? G.FLAG : G.COBBLE);
export const lampKind = 'iron';
export const shotSun = 0.14;

/** One house / tower / hall on a lot. */
export function building(ctx, lot) {
  const { rng, pal } = ctx;
  const B = ctx.B;
  const zone = lot.zone;
  const core = zone < 0.35;
  const tower = (core && rng.chance(0.06)) || (lot.plaza && rng.chance(0.12));
  ctx.place(lot.x, lot.z, lot.base, lot.yaw);
  if (tower) return roundTower(ctx, lot);

  const w = Math.max(5, lot.w * rng.range(0.86, 0.98)), d = Math.max(5, lot.d * rng.range(0.82, 0.98));
  let floors = core ? rng.int(2, 4) : zone < 0.65 ? rng.int(1, 3) : rng.int(1, 2);
  if (lot.plaza) floors = Math.max(floors, 3);
  const fh = rng.range(2.9, 3.2);
  const fl = 0.35;
  const H = floors * fh;
  const wall = rng.pick(pal.walls).clone().multiplyScalar(rng.range(0.93, 1.02));
  const seed = rng.float();
  plinth(ctx, w, d, lot, fl, M.STONE, pal.stone, 0.12);
  // walls with windows
  const shop = (lot.plaza || (core && lot.row === 0 && rng.chance(0.5))) ? F.SHOP : 0;
  B.mat(M.PLASTER, seed, W.HOUSE, fh).color(wall).ext(1, 0, 0, 0);
  B.box(-w / 2, fl, -d / 2, w / 2, fl + H, d / 2, { top: false, base: fl, front: F.FRONT | shop, right: 0, back: 0, left: 0 });
  // stone quoins / corner pilasters
  B.mat(M.STONE, seed, 0, 3).color(pal.stone.clone().multiplyScalar(1.15)).ext(1, 0, F.NOWIN, 0);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) B.boxC(sx * (w / 2 - 0.12), fl, sz * (d / 2 - 0.12), 0.34, H, 0.34, { top: false });
  // string courses between floors and a cornice at the eave
  B.mat(M.STONE, seed, 0, 3).color(pal.trim).ext(0.95, 0, F.NOWIN, 0);
  for (let f = 1; f < floors; f++) B.box(-w / 2 - 0.07, fl + f * fh - 0.1, -d / 2 - 0.07, w / 2 + 0.07, fl + f * fh + 0.06, d / 2 + 0.07, { base: fl });
  B.box(-w / 2 - 0.12, fl + H - 0.22, -d / 2 - 0.12, w / 2 + 0.12, fl + H, d / 2 + 0.12, { base: fl });

  // roof
  const roofC = rng.pick(pal.roofs).clone().multiplyScalar(rng.range(0.85, 1.05));
  const slate = roofC.b > roofC.r;
  const roofMat = [slate ? M.SLATE : M.TILE, rng.float(), 0, 3];
  const r = rng.float();
  B.mat(M.PLASTER, seed, W.HOUSE, fh).color(wall).ext(1, 0, 0, 0);
  const yE = fl + H;
  let ridgeY;
  if (r < 0.55) {
    const rise = (d / 2) * rng.range(0.65, 1.0);
    B.gableRoof(-w / 2, -d / 2, w / 2, d / 2, yE, rise, { over: 0.5, overG: 0.35, roofMat, roofColor: roofC, trimMat: [M.WOOD, seed, 0, 3], trimColor: pal.wood, base: fl, ridgeW: 0.26 });
    ridgeY = yE + rise;
  } else if (r < 0.82) {
    // gable facing the street (Kiki's Koriko)
    const rise = (w / 2) * rng.range(0.8, 1.15);
    const M0 = ctx.M.clone();
    const rot = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    B.setMatrix(M0.clone().multiply(rot));
    B.gableRoof(-d / 2, -w / 2, d / 2, w / 2, yE, rise, { over: 0.45, overG: 0.4, roofMat, roofColor: roofC, trimMat: [M.WOOD, seed, 0, 3], trimColor: pal.wood, base: fl, ridgeW: 0.24, gableFlags: 0 });
    B.setMatrix(M0);
    ridgeY = yE + rise;
  } else {
    const rise = Math.min(w, d) / 2 * rng.range(0.7, 0.95);
    ridgeY = B.hipRoof(-w / 2, -d / 2, w / 2, d / 2, yE, rise, { over: 0.5, roofMat, roofColor: roofC, trimMat: [M.WOOD, seed, 0, 3], trimColor: pal.wood });
  }
  // chimney
  if (rng.chance(0.75)) {
    const cx = rng.range(-w / 2 + 0.8, w / 2 - 0.8), cz = rng.range(-d * 0.2, d * 0.2);
    B.mat(rng.chance(0.5) ? M.BRICK : M.PLASTER, rng.float(), 0, 3).color(rng.chance(0.5) ? col('#a0583a') : wall).ext(1, 0, F.NOWIN, 0);
    B.boxC(cx, yE - 0.5, cz, 0.6, ridgeY - yE + 1.6, 0.6);
    B.mat(M.STONE, 0.4, 0, 3).color(pal.stoneDark);
    B.boxC(cx, ridgeY + 1.1, cz, 0.78, 0.12, 0.78);
    if (ctx.smokes && rng.chance(0.2)) ctx.smokes.push({ position: new THREE.Vector3(cx, ridgeY + 1.3, cz).applyMatrix4(ctx.M), seed: rng.float() });
  }
  // balcony on the first floor
  if (floors >= 2 && rng.chance(0.38)) {
    const bw = Math.min(w * 0.55, rng.range(2, 3.6)), y = fl + fh;
    B.mat(M.WOOD, rng.float(), 0, 3).color(pal.wood).ext(0.95, 0, F.NOWIN, 0);
    B.box(-bw / 2, y - 0.12, d / 2, bw / 2, y + 0.04, d / 2 + 0.9, { base: y });
    for (let i = 0; i <= Math.floor(bw / 0.3); i++) B.boxC(-bw / 2 + i * (bw / Math.floor(bw / 0.3)), y, d / 2 + 0.86, 0.05, 0.95, 0.05, { top: false });
    B.box(-bw / 2, y + 0.95, d / 2 + 0.82, bw / 2, y + 1.02, d / 2 + 0.92, { base: y });
    // flowers spilling over the rail
    B.mat(M.FOLIAGE, rng.float(), 0, 3).color(col('#3f6a2a'));
    B.box(-bw / 2 + 0.1, y + 0.04, d / 2 + 0.6, bw / 2 - 0.1, y + 0.3, d / 2 + 0.8, { base: y });
    B.mat(M.CLOTH, rng.float(), 0, 3).color(rng.pick([col('#d23a4a'), col('#f2d23c'), col('#e86aa0')]));
    for (let i = 0; i < 6; i++) B.boxC(rng.range(-bw / 2 + 0.2, bw / 2 - 0.2), y + 0.25, d / 2 + rng.range(0.6, 0.85), 0.16, 0.12, 0.16);
  }
  // shop awning on the plaza
  if (shop && rng.chance(0.75)) {
    const aw = w - 0.8, y = fl + Math.min(fh * 0.92, 2.7);
    const c1 = rng.pick(pal.cloth);
    B.mat(M.CLOTH, rng.float(), 0, 3).color(c1).ext(1, aw, 0, 1.2);
    const p0 = new THREE.Vector3(-aw / 2, y, d / 2 + 0.05), p1 = new THREE.Vector3(aw / 2, y, d / 2 + 0.05), p2 = new THREE.Vector3(aw / 2, y - 0.6, d / 2 + 1.3), p3 = new THREE.Vector3(-aw / 2, y - 0.6, d / 2 + 1.3);
    B.quadP(p3, p2, p1, p0, [0, 0], [aw, 0], [aw, 1.2], [0, 1.2]);
    B.quadP(p0, p1, p2, p3, [0, 0], [aw, 0], [aw, 1.2], [0, 1.2]);
    crates(ctx, rng.range(-w / 3, w / 3), 0, d / 2 + 1.0, 2);
  }
  // door lantern
  if (rng.chance(0.45)) {
    const lx = rng.chance(0.5) ? 0.9 : -0.9;
    B.mat(M.IRON, 0.3, 0, 3).color(pal.iron).ext(1, 0, F.NOWIN, 0);
    B.boxC(lx, fl + 2.35, d / 2 + 0.2, 0.06, 0.06, 0.4);
    B.mat(M.EMISSIVE, 0.2, 0, 3).color(pal.lamp);
    B.boxC(lx, fl + 2.05, d / 2 + 0.36, 0.18, 0.28, 0.18);
    glow(ctx, lx, fl + 2.2, d / 2 + 0.36, pal.lamp, 0.35, rng.float());
  }
  ctx.collider(0, (fl + H) / 2, 0, w / 2, (fl + H) / 2 + 0.6, d / 2, false);
  ctx.footprints.push({ lot, h: ridgeY });
}

function roundTower(ctx, lot) {
  const { rng, pal } = ctx, B = ctx.B;
  const r = Math.min(lot.w, lot.d) * 0.42;
  const floors = rng.int(4, 6), fh = 3.1, fl = 0.35, H = floors * fh;
  const wall = rng.pick(pal.walls);
  plinth(ctx, r * 2, r * 2, lot, fl, M.STONE, pal.stone, 0.2);
  B.mat(M.PLASTER, rng.float(), W.HOUSE, fh).color(wall).ext(1, 0, 0, 0);
  B.cylinder(0, 0, r, r * 0.94, fl, fl + H, { segs: 16, base: fl, flags: F.FRONT });
  B.mat(M.STONE, 0.3, 0, 3).color(pal.trim).ext(0.95, 0, F.NOWIN, 0);
  B.cylinder(0, 0, r * 0.94 + 0.18, r * 0.94 + 0.18, fl + H - 0.25, fl + H, { segs: 16, top: false });
  // belvedere ring of arches = dark gallery band + conical roof
  const roofC = rng.pick(pal.roofs);
  const yE = fl + H;
  B.mat(rng.chance(0.4) ? M.BRONZE : M.TILE, rng.float(), 0, 3).color(roofC).ext(1, 0, 0, 0);
  const rise = r * rng.range(1.6, 2.4);
  B.lathe(0, 0, [[r * 0.94 + 0.55, yE - 0.3], [r * 0.85, yE + rise * 0.25], [r * 0.45, yE + rise * 0.65], [0.05, yE + rise]], { segs: 16 });
  B.mat(M.GOLD, 0.3, 0, 3).color(col('#d8a84a'));
  B.cylinder(0, 0, 0.05, 0.03, yE + rise - 0.1, yE + rise + 1.6, { segs: 5 });
  B.lathe(0, 0, [[0.01, yE + rise + 0.9], [0.18, yE + rise + 1.0], [0.01, yE + rise + 1.12]], { segs: 6 });
  flag(ctx, 0.05, yE + rise + 1.55, 0, 1.4, 0.7, rng.pick(pal.cloth), rng.float() * TAU);
  ctx.collider(0, (fl + H) / 2, 0, r, (fl + H) / 2 + 0.6, r, false);
  ctx.footprints.push({ lot, h: yE + rise });
}

/** Plazas: fountain / statue, market stalls, lamps, bunting. */
export function plaza(ctx, pz) {
  const { rng, pal } = ctx;
  if (pz.kind === 'main') {
    fountain(ctx, pz.x, pz.z, Math.min(3.6, pz.r * 0.18));
    const n = Math.floor(pz.r * 0.6);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, TAU), r = rng.range(pz.r * 0.38, pz.r * 0.78);
      const x = pz.x + Math.cos(a) * r, z = pz.z + Math.sin(a) * r;
      if (!ctx.free(x, z, 1.8, true)) continue;
      stall(ctx, x, z, a + Math.PI / 2 + rng.range(-0.3, 0.3), rng.pick(pal.cloth));
      ctx.occupy(x, z, 3.4);
    }
    const nl = Math.max(4, Math.floor(pz.r / 4));
    for (let i = 0; i < nl; i++) {
      const a = (i / nl) * TAU;
      lampPost(ctx, pz.x + Math.cos(a) * (pz.r - 1.2), pz.z + Math.sin(a) * (pz.r - 1.2), 'iron');
    }
  } else {
    if (rng.chance(0.6)) statue(ctx, pz.x, pz.z, rng.float() * TAU, 0.8);
    else fountain(ctx, pz.x, pz.z, 1.8);
    lampPost(ctx, pz.x + pz.r * 0.7, pz.z, 'iron');
  }
}

/** Countryside & civic extras: bell tower, windmills, bunting, field walls, docks, lamps. */
export function extras(ctx) {
  const { rng, pal, plan } = ctx;
  // street lamps along main roads in town
  for (const r of plan.roads) if (r.kind === 'main' || r.kind === 'avenue') roadLamps(ctx, r, 22, 'iron');
  // festival lights strung between the houses of the old town
  for (const r of plan.roads) if (r.kind === 'street' || r.kind === 'main') lanternStrings(ctx, r, 26, [col('#ffc878'), col('#ffb060'), col('#ffd9a0')], { n: 9, h: 5.0, sag: 0.8, scale: 0.32, core: 0.5 });
  // bell tower over the main square
  const pz = plan.plazas[0];
  {
    const a = rng.range(0, TAU);
    const x = pz.x + Math.cos(a) * (pz.r + 7), z = pz.z + Math.sin(a) * (pz.r + 7);
    bellTower(ctx, x, z, Math.atan2(-Math.cos(a), -Math.sin(a)));
  }
  // windmills on the high spots
  let nw = 0;
  for (const s of plan.spots) {
    if (nw >= (ctx.main ? 4 : 2)) break;
    if (s.r < plan.builtRadius * 0.8) continue;
    if (!ctx.free(s.x, s.z, 6)) continue;
    windmill(ctx, s.x, s.z); ctx.occupy(s.x, s.z, 8); nw++;
  }
  // bunting across lanes in the core
  for (const road of plan.roads) {
    if (road.kind === 'lane' || road.pts.length < 6) continue;
    for (let i = 3; i < road.pts.length - 2; i += 7) {
      const [x, z] = road.pts[i];
      if (Math.hypot(x - plan.center[0], z - plan.center[1]) > plan.builtRadius * 0.6 || !rng.chance(0.4)) continue;
      const [x2, z2] = road.pts[i + 1];
      const L = Math.hypot(x2 - x, z2 - z) || 1;
      const nx = -(z2 - z) / L, nz = (x2 - x) / L;
      const off = road.w / 2 + 1.0;
      const h = ctx.frame.hAt(x, z) + rng.range(5.5, 7);
      ctx.place(x, z, ctx.frame.hAt(x, z), 0);
      const a = ctx.frame.point(x + nx * off, z + nz * off, h).applyMatrix4(ctx.inv());
      const b = ctx.frame.point(x - nx * off, z - nz * off, h).applyMatrix4(ctx.inv());
      bunting(ctx, a, b, pal.cloth, 0.9);
    }
  }
  // dry-stone walls around fields
  for (const f of plan.fields) {
    if (!rng.chance(0.45)) continue;
    const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
    const corner = (u, v) => [f.x + u * c + v * s, f.z - u * s + v * c];
    const pts = [];
    const hw = f.w / 2 + 1, hd = f.d / 2 + 1;
    const seq = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [-hw, -hd]];
    for (let k = 0; k < 4; k++) {
      if (rng.chance(0.3)) continue;
      const [u0, v0] = seq[k], [u1, v1] = seq[k + 1];
      const seg = [];
      for (let t = 0; t <= 1.001; t += 0.125) seg.push(corner(u0 + (u1 - u0) * t, v0 + (v1 - v0) * t));
      lowWall(ctx, seg, 0.8, 0.55);
    }
  }
  // haystacks and hay bales on fields
  for (const f of plan.fields) {
    if (f.kind !== 0 && f.kind !== 3) continue;
    for (let i = 0; i < rng.int(0, 4); i++) {
      const u = rng.range(-f.w / 2 + 2, f.w / 2 - 2), v = rng.range(-f.d / 2 + 2, f.d / 2 - 2);
      const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
      const x = f.x + u * c + v * s, z = f.z - u * s + v * c;
      ctx.place(x, z, ctx.frame.hAt(x, z) - 0.1, rng.float() * TAU);
      ctx.B.mat(M.GRASS, rng.float(), 0, 3).color(col('#c9a24e')).ext(0.9, 0, F.NOWIN, 0);
      ctx.B.lathe(0, 0, [[1.3, 0], [1.4, 0.9], [1.0, 1.9], [0.2, 2.5], [0.01, 2.55]], { segs: 10 });
    }
  }
  // docks
  for (const dk of plan.docks) dock(ctx, dk);
  // gardens: round orchard trees and dark cypresses between the houses
  const q = ctx.settlement.level.engine.quality;
  plantTrees(ctx, q.pick(40, 80, 140, 180) * (ctx.main ? 1 : 0.5), ['round', 'round', 'round', 'cypress'], [col('#4e8a3a'), col('#5f9a44'), col('#3f7a34'), col('#7aa84a')], foliageBlob);
}

function bellTower(ctx, x, z, yaw) {
  const { rng, pal } = ctx;
  const fp = ctx.frame.footprint(x, z, 7, 7, yaw, 3);
  ctx.place(x, z, fp.max, yaw);
  const B = ctx.B;
  const s = 6.2, H = 26;
  plinth(ctx, s, s, { low: fp.min, base: fp.max }, 0.5, M.STONE, pal.stone, 0.3);
  B.mat(M.PLASTER, 0.77, W.HOUSE, 4.2).color(pal.walls[0]).ext(1, 0, 0, 0);
  B.box(-s / 2, 0.5, -s / 2, s / 2, H, s / 2, { top: false, base: 0.5, front: F.FRONT });
  B.mat(M.STONE, 0.4, 0, 3).color(pal.stone.clone().multiplyScalar(1.1)).ext(1, 0, F.NOWIN, 0);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) B.boxC(sx * (s / 2 - 0.2), 0.5, sz * (s / 2 - 0.2), 0.55, H - 0.5, 0.55, { top: false });
  for (const y of [9, 17.5]) B.box(-s / 2 - 0.12, y - 0.15, -s / 2 - 0.12, s / 2 + 0.12, y + 0.12, s / 2 + 0.12);
  // clock faces
  for (let k = 0; k < 4; k++) {
    const M0 = ctx.M.clone();
    B.setMatrix(M0.clone().multiply(new THREE.Matrix4().makeRotationY(k * Math.PI / 2)));
    B.ext(1, 0, F.NOWIN, 0);
    B.setMatrix(M0.clone().multiply(new THREE.Matrix4().makeRotationY(k * Math.PI / 2)).multiply(new THREE.Matrix4().makeTranslation(0, 20.5, s / 2 + 0.05)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
    B.mat(M.GOLD, 0.2, 0, 3).color(col('#d8a84a'));
    B.cylinder(0, 0, 1.38, 1.38, -0.02, 0.06, { segs: 20 });
    B.mat(M.MARBLE, 0.2, 0, 3).color(col('#f2ead8'));
    B.cylinder(0, 0, 1.2, 1.2, 0.06, 0.1, { segs: 20, top: true });
    B.mat(M.IRON, 0.2, 0, 3).color(pal.iron);
    B.boxC(0, 0.1, -0.45, 0.08, 0.04, 0.9);
    B.boxC(0.3, 0.1, 0.1, 0.6, 0.04, 0.07);
    B.setMatrix(M0);
  }
  // belfry: open arches (4 piers), bell, then a pyramidal roof
  const yb = H;
  B.mat(M.STONE, 0.4, 0, 3).color(pal.stone.clone().multiplyScalar(1.12));
  B.box(-s / 2 - 0.3, yb, -s / 2 - 0.3, s / 2 + 0.3, yb + 0.4, s / 2 + 0.3);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) B.boxC(sx * (s / 2 - 0.5), yb + 0.4, sz * (s / 2 - 0.5), 1.0, 4.2, 1.0);
  B.box(-s / 2 - 0.3, yb + 4.6, -s / 2 - 0.3, s / 2 + 0.3, yb + 5.2, s / 2 + 0.3);
  B.mat(M.BRONZE, 0.5, 0, 3).color(col('#8a6a3a'));
  B.lathe(0, 0, [[0.02, yb + 3.9], [0.4, yb + 3.8], [0.6, yb + 3.2], [0.95, yb + 2.2], [0.02, yb + 2.2]], { segs: 12 });
  B.mat(M.EMISSIVE, 0.1, 0, 3).color(pal.lamp);
  B.boxC(0, yb + 0.4, 0, 1.2, 0.3, 1.2);
  glow(ctx, 0, yb + 1.2, 0, pal.lamp, 1.8, 0.5);
  const roofC = pal.roofs[6];
  B.mat(M.SLATE, 0.6, 0, 3).color(roofC);
  B.pyramid(0, 0, s + 1.2, s + 1.2, yb + 5.2, 8.5);
  B.mat(M.GOLD, 0.3, 0, 3).color(col('#d8a84a'));
  B.cylinder(0, 0, 0.06, 0.03, yb + 13.4, yb + 16.2, { segs: 5 });
  B.lathe(0, 0, [[0.01, yb + 14], [0.3, yb + 14.3], [0.01, yb + 14.6]], { segs: 8 });
  ctx.collider(0, H / 2, 0, s / 2, H / 2 + 0.5, s / 2, false);
  ctx.occupy(x, z, 6);
  ctx.landmarkSpots.push({ x, z, h: fp.max + yb + 16, kind: 'belltower', title: 'The Bell Tower' });
}

function windmill(ctx, x, z) {
  const { rng, pal } = ctx;
  const fp = ctx.frame.footprint(x, z, 7, 7, 0, 3);
  const yaw = rng.float() * TAU;
  ctx.place(x, z, fp.min, yaw);
  const B = ctx.B;
  const H = rng.range(11, 14);
  B.mat(M.PLASTER, rng.float(), W.HOUSE, 3.4).color(pal.walls[0]).ext(1, 0, 0, 0);
  B.lathe(0, 0, [[3.2, -1], [3.0, 0.5], [2.4, H * 0.6], [2.1, H]], { segs: 14, flags: F.FRONT });
  B.mat(M.WOOD, 0.4, 0, 3).color(pal.wood);
  B.cylinder(0, 0, 2.5, 2.5, H - 0.1, H + 0.3, { segs: 14 });
  B.mat(M.TILE, rng.float(), 0, 3).color(rng.pick(pal.roofs));
  B.lathe(0, 0, [[2.6, H + 0.3], [2.2, H + 1.6], [1.1, H + 2.8], [0.05, H + 3.3]], { segs: 14 });
  // sails (animated)
  const hub = new THREE.Vector3(0, H + 0.6, 2.6);
  const sails = ctx.dynamicBuilder();
  const S = sails.B;
  S.mat(M.WOOD, 0.3, 0, 3).color(pal.wood).ext(1, 0, F.NOWIN, 0);
  S.cylinder(0, 0, 0.35, 0.3, -0.5, 0.6, { segs: 8 });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU;
    const R = new THREE.Matrix4().makeRotationZ(a);
    S.setMatrix(R);
    S.mat(M.WOOD, 0.3, 0, 3).color(pal.wood);
    S.box(-0.12, 0.3, -0.06 + 0.4, 0.12, 9.5, 0.06 + 0.4);
    S.mat(M.CLOTH, 0.1, 0, 3).color(col('#efe6d2'));
    S.e[1] = 1.6; S.e[3] = 7.5; S.e[2] = 0;
    for (const sd of [1, -1]) {
      const p0 = new THREE.Vector3(0.12, 1.8, 0.42), p1 = new THREE.Vector3(1.7, 1.8, 0.42 + 0.15), p2 = new THREE.Vector3(1.7, 9.3, 0.42 + 0.15), p3 = new THREE.Vector3(0.12, 9.3, 0.42);
      if (sd > 0) S.quadP(p0, p1, p2, p3, [0, 0], [1.6, 0], [1.6, 7.5], [0, 7.5]); else S.quadP(p3, p2, p1, p0, [0, 7.5], [1.6, 7.5], [1.6, 0], [0, 0]);
    }
    // lattice bars
    S.mat(M.WOOD, 0.3, 0, 3).color(pal.wood);
    for (let j = 0; j < 6; j++) S.box(0.1, 1.8 + j * 1.5, 0.45, 1.75, 1.88 + j * 1.5, 0.6);
    S.resetMatrix();
  }
  const obj = sails.finish();
  const M0 = ctx.M.clone().multiply(new THREE.Matrix4().makeTranslation(hub.x, hub.y, hub.z));
  M0.multiply(new THREE.Matrix4().makeRotationX(-0.12));
  obj.matrixAutoUpdate = false;
  const base = M0.clone();
  const speed = rng.range(0.25, 0.45), ph = rng.float() * TAU;
  const R = new THREE.Matrix4();
  ctx.anim.push((t) => { obj.matrix.copy(base).multiply(R.makeRotationZ(-t * speed + ph)); obj.matrixWorldNeedsUpdate = true; });
  obj.matrix.copy(base);
  ctx.collider(0, H / 2, 0, 2.6, H / 2 + 1, 2.6, false);
  glow(ctx, 0, 2.2, 3.15, pal.lamp, 0.4, rng.float());
}

function dock(ctx, dk) {
  const { rng, pal, frame } = ctx;
  const B = ctx.B;
  const sea = frame.sea;
  ctx.place(dk.x, dk.z, sea, dk.yaw);
  const L = dk.len, w = 3.2, y = 1.3;
  B.mat(M.WOOD, rng.float(), 0, 3).color(pal.wood.clone().multiplyScalar(0.9)).ext(0.95, 0, F.NOWIN, 0);
  B.box(-w / 2, y - 0.25, 0, w / 2, y, L, { base: y - 0.25 });
  for (let z = 1; z < L; z += 3) for (const sx of [-1, 1]) B.cylinder(sx * (w / 2 - 0.1), z, 0.16, 0.16, -3, y + (z % 6 < 3 ? 0.9 : 0.05), { segs: 6, top: true });
  lampPostLocal(ctx, w / 2 - 0.1, y, L - 0.5);
  // boats tied up
  for (let i = 0; i < rng.int(1, 3); i++) {
    const side = rng.chance(0.5) ? 1 : -1;
    boat(ctx.B, side * (w / 2 + 1.6), 0.15, rng.range(4, L - 3), rng, pal);
  }
  ctx.collider(0, y - 0.6, L / 2, w / 2, 0.6, L / 2, true);
}

function lampPostLocal(ctx, x, y, z) {
  const B = ctx.B;
  B.mat(M.IRON, 0.4, 0, 3).color(ctx.pal.iron).ext(1, 0, F.NOWIN, 0);
  B.cylinder(x, z, 0.07, 0.06, y, y + 3, { segs: 6 });
  B.mat(M.EMISSIVE, 0.2, 0, 3).color(ctx.pal.lamp);
  B.boxC(x, y + 3, z, 0.26, 0.4, 0.26);
  glow(ctx, x, y + 3.2, z, ctx.pal.lamp, 0.6, 0.4);
}

export function boat(B, x, y, z, rng, pal, len = null) {
  const L = len ?? rng.range(4, 6.5), bw = L * 0.32;
  B.mat(M.WOOD, rng.float(), 0, 3).color(rng.pick([col('#6a4428'), col('#3d6a8a'), col('#a8432f'), col('#e8e0cc')])).ext(1, 0, F.NOWIN, 0);
  const prof = [];
  for (let i = 0; i <= 6; i++) { const t = i / 6; prof.push([bw / 2 * Math.sin(Math.PI * (0.08 + 0.84 * t)), z - L / 2 + L * t]); }
  // hull: two sides + transom
  const hh = 0.8;
  for (const s of [1, -1]) {
    for (let i = 0; i < prof.length - 1; i++) {
      const [r0, z0] = prof[i], [r1, z1] = prof[i + 1];
      const a = new THREE.Vector3(x + s * r0 * 0.4, y - hh * 0.6, z0), b = new THREE.Vector3(x + s * r1 * 0.4, y - hh * 0.6, z1);
      const c = new THREE.Vector3(x + s * r1, y + hh * (0.4 + 0.25 * Math.abs(2 * (i + 1) / 6 - 1)), z1), d = new THREE.Vector3(x + s * r0, y + hh * (0.4 + 0.25 * Math.abs(2 * i / 6 - 1)), z0);
      B.quadP(a, b, c, d, [0, 0], [1, 0], [1, 1], [0, 1], new THREE.Vector3(s, 0, 0));
    }
  }
  B.mat(M.WOOD, rng.float(), 0, 3).color(pal.wood);
  B.box(x - bw * 0.4, y - 0.05, z - L * 0.35, x + bw * 0.4, y + 0.05, z + L * 0.35);
  if (rng.chance(0.5)) {
    B.cylinder(x, z - L * 0.1, 0.06, 0.05, y, y + L * 0.9, { segs: 5 });
  }
}

/** Main landmark: Laputa — the floating island city. */
export function landmark(ctx) {
  const { plan, rng } = ctx;
  // drift over the far side of town, toward the sea if there is one
  let a = rng.range(0, TAU);
  if (plan.shore) a = Math.atan2(plan.shore[1] - plan.center[1], plan.shore[0] - plan.center[0]) + rng.range(-0.5, 0.5);
  const off = plan.builtRadius * rng.range(0.75, 1.05);
  const x = plan.center[0] + Math.cos(a) * off, z = plan.center[1] + Math.sin(a) * off;
  const alt = Math.max(ctx.frame.hAt(plan.center[0], plan.center[1]), ctx.frame.hAt(x, z)) + rng.range(175, 215);
  floatingIsland(ctx, x, z, alt, rng.range(80, 100));
}

export const shot = { dist: 0.95, height: 40, sunAngle: 1.8 };
