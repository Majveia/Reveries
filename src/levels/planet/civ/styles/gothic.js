// Gothic — Elden Ring / Lies of P: steep slate roofs over stone and
// half-timber, lancet windows with tracery, a cathedral with flying
// buttresses and twin spires over the square, curtain walls with round
// towers, and on the horizon a colossal golden tree.

import * as THREE from 'three';
import { M, W, F, G } from '../ids.js';
import { col, glow, plinth, lampPost, roadLamps, flag, statue, plantTrees, TAU } from '../kit.js';
import { rockLathe, foliageBlob } from '../landmarks.js';

export function palette(A, rng) {
  const P = A?.palette || {};
  void rng;
  return {
    stones: ['#a49c8c', '#968e7e', '#b0a898', '#8a8476', '#bab2a0'].map(col),
    plaster: ['#d8ccb4', '#cfc2a8', '#e0d6c0'].map(col),
    roofs: ['#3e4448', '#4a4e52', '#363a3e', '#52504a', '#5a4a3a'].map(col),
    stone: col('#9a9282'), stoneDark: col('#6e685c'), wood: col('#3a2a1e'), trim: col('#cfc6b4'), iron: col('#1a1a1c'),
    lamp: col(P.lights || '#ffc860'), accent: col(P.accent || '#ffd25a'), gold: col('#d8a84a'),
    cloth: ['#6a1a1a', '#1a2a4a', '#c8a040', '#2a2a2a'].map(col),
    foliage: (P.foliage || ['#c89a2a', '#e0b040', '#a07020']).map(col),
    fields: ['#a08a3a', '#8a8a42', '#b89a4a', '#7a7a3a'].map(col),
    ground: { main: col('#8a8476'), street: col('#827c6e'), lane: col('#76705e'), plaza: col('#9a9484'), dirt: col('#6e6450') },
    metal: col('#7a7a74'),
  };
}

export function roadMat(road, zone) { return road.kind === 'lane' || zone > 0.7 ? G.DIRT : G.COBBLE; }
export const plazaMat = () => G.FLAG;
export const shotSun = 0.12;
export const shot = { dist: 0.86, height: 27, sunAngle: 1.9, lmLift: 0.2 };

export function building(ctx, lot) {
  const { rng, pal } = ctx;
  ctx.place(lot.x, lot.z, lot.base, lot.yaw);
  const B = ctx.B;
  const w = Math.max(5, lot.w * rng.range(0.88, 1)), d = Math.max(6, lot.d * rng.range(0.85, 0.98));
  const core = lot.zone < 0.4;
  const floors = core ? rng.int(3, 4) : rng.int(2, 3);
  const fh = 3.3, fl = 0.4, H = floors * fh;
  const stone = rng.pick(pal.stones);
  plinth(ctx, w, d, lot, fl, M.STONE, pal.stoneDark, 0.1);
  // ground floor in stone, upper floors stone or plaster half-timber
  B.mat(M.STONE, rng.float(), W.LANCET, fh).color(stone).ext(1, 0, 0, 0);
  B.box(-w / 2, fl, -d / 2, w / 2, fl + fh, d / 2, { top: false, base: fl, front: F.FRONT });
  const timber = rng.chance(0.5);
  B.mat(timber ? M.PLASTER : M.STONE, rng.float(), W.LANCET, fh).color(timber ? rng.pick(pal.plaster) : stone).ext(1, 0, 0, 0);
  // jetty: upper floors overhang the street
  const j = timber ? 0.35 : 0;
  B.box(-w / 2 - j, fl + fh, -d / 2 - j, w / 2 + j, fl + H, d / 2 + j, { top: false, base: fl + fh });
  if (timber) {
    B.mat(M.WOOD, 0.3, 0, 3).color(pal.wood).ext(1, 0, F.NOWIN, 0);
    const n = Math.max(2, Math.floor(w / 1.4));
    for (let i = 0; i <= n; i++) B.boxC(-w / 2 - j + i * ((w + 2 * j) / n), fl + fh, d / 2 + j + 0.04, 0.16, H - fh, 0.08, { top: false });
    for (let f = 1; f < floors; f++) B.box(-w / 2 - j - 0.05, fl + f * fh - 0.12, d / 2 + j, w / 2 + j + 0.05, fl + f * fh + 0.12, d / 2 + j + 0.1);
  }
  // steep slate gable facing the street
  const roofC = rng.pick(pal.roofs);
  const rise = (w / 2 + j) * rng.range(1.3, 1.8);
  const M0 = ctx.M.clone();
  B.setMatrix(M0.clone().multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)));
  B.mat(timber ? M.PLASTER : M.STONE, rng.float(), W.LANCET, fh).color(timber ? pal.plaster[0] : stone).ext(1, 0, 0, 0);
  B.gableRoof(-d / 2 - j, -w / 2 - j, d / 2 + j, w / 2 + j, fl + H, rise, { over: 0.35, overG: 0.3, roofMat: [M.SLATE, rng.float(), 0, 3], roofColor: roofC, trimMat: [M.WOOD, 0.3, 0, 3], trimColor: pal.wood, base: fl, ridgeW: 0.2 });
  B.setMatrix(M0);
  // dormer
  if (rng.chance(0.4)) {
    B.mat(M.SLATE, rng.float(), 0, 3).color(roofC).ext(1, 0, F.NOWIN, 0);
    B.pyramid(0, d * 0.15, 1.4, 1.4, fl + H + rise * 0.3, rise * 0.45);
  }
  // chimney
  B.mat(M.STONE, rng.float(), 0, 3).color(pal.stoneDark).ext(1, 0, F.NOWIN, 0);
  B.boxC(w / 2 - 0.6, fl + H, rng.range(-d / 3, d / 3), 0.7, rise * 0.9, 0.7);
  if (rng.chance(0.35)) glow(ctx, 0.8, fl + 2.3, d / 2 + 0.3, pal.lamp, 0.35, rng.float());
  ctx.collider(0, (fl + H) / 2, 0, w / 2, (fl + H) / 2 + 0.5, d / 2, false);
  ctx.footprints.push({ lot, h: fl + H + rise });
}

function cathedral(ctx, x, z, yaw) {
  const { pal, rng } = ctx;
  ctx.useTile('landmark');
  const L = 64, Wn = 18, Hn = 30;
  const fp = ctx.frame.footprint(x, z, Wn + 12, L, yaw, 4);
  ctx.place(x, z, fp.max, yaw);
  const B = ctx.B;
  const stone = pal.stones[2];
  plinth(ctx, Wn + 14, L + 6, { low: fp.min, base: fp.max }, 1.0, M.STONE, pal.stoneDark, 0);
  // nave with tall lancets
  B.mat(M.STONE, 0.4, W.LANCET, Hn).color(stone).ext(1, 0, 0, 0);
  B.box(-Wn / 2, 1, -L / 2, Wn / 2, 1 + Hn, L / 2, { top: false, base: 1, front: F.FRONT | F.NOWIN });
  // aisles
  B.mat(M.STONE, 0.5, W.LANCET, 12).color(stone.clone().multiplyScalar(0.95));
  for (const s of [-1, 1]) B.box(s > 0 ? Wn / 2 : -Wn / 2 - 7, 1, -L / 2 + 4, s > 0 ? Wn / 2 + 7 : -Wn / 2, 14, L / 2 - 6, { base: 1, top: true, topMat: [M.SLATE, 0.3, 0, 3] });
  // buttresses + flying buttresses
  B.mat(M.STONE, 0.6, 0, 3).color(stone.clone().multiplyScalar(0.92)).ext(1, 0, F.NOWIN, 0);
  for (let i = 0; i < 7; i++) {
    const zz = -L / 2 + 6 + i * ((L - 14) / 6);
    for (const s of [-1, 1]) {
      B.box(s * (Wn / 2 + 7) - 1, 1, zz - 0.9, s * (Wn / 2 + 7) + 1, 22, zz + 0.9);
      B.pyramid(s * (Wn / 2 + 7), zz, 2, 1.8, 22, 6);
      const pts = [];
      for (let k = 0; k <= 8; k++) { const t = k / 8; pts.push(new THREE.Vector3(s * (Wn / 2 + 7 - t * 7), 20 + Math.sin(t * Math.PI * 0.5) * 7 + t * 1.5, zz)); }
      B.tube(pts, 0.55, 5);
    }
  }
  // steep nave roof
  B.mat(M.STONE, 0.4, 0, Hn).color(stone);
  B.gableRoof(-Wn / 2, -L / 2, Wn / 2, L / 2, 1 + Hn, 12, { over: 0.4, overG: 0.2, roofMat: [M.SLATE, 0.5, 0, 3], roofColor: pal.roofs[0], trimMat: [M.STONE, 0.3, 0, 3], trimColor: stone, base: 1 });
  // apse
  B.mat(M.STONE, 0.4, W.LANCET, 20).color(stone).ext(1, 0, 0, 0);
  B.cylinder(0, -L / 2, Wn / 2, Wn / 2, 1, 24, { segs: 12, a0: Math.PI, a1: TAU, base: 1 });
  B.mat(M.SLATE, 0.4, 0, 3).color(pal.roofs[0]);
  B.lathe(0, -L / 2, [[Wn / 2 + 0.4, 24], [0.1, 32]], { segs: 12 });
  // twin west towers with spires
  for (const s of [-1, 1]) {
    const tx = s * (Wn / 2 + 2), tz = L / 2 - 3;
    B.mat(M.STONE, 0.6, W.LANCET, 9).color(stone).ext(1, 0, 0, 0);
    B.box(tx - 5, 1, tz - 5, tx + 5, 52, tz + 5, { base: 1, top: false });
    B.mat(M.STONE, 0.6, 0, 3).color(stone.clone().multiplyScalar(0.9)).ext(1, 0, F.NOWIN, 0);
    for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { B.boxC(tx + cx * 5, 1, tz + cz * 5, 1.4, 54, 1.4); B.pyramid(tx + cx * 5, tz + cz * 5, 1.6, 1.6, 55, 7); }
    B.mat(M.SLATE, 0.6, 0, 3).color(pal.roofs[1]);
    B.pyramid(tx, tz, 9, 9, 52, 34);
    B.mat(M.GOLD, 0.3, 0, 3).color(pal.gold);
    B.cylinder(tx, tz, 0.15, 0.08, 85, 90, { segs: 5 });
    ctx.beacons.push({ position: new THREE.Vector3(tx, 90.4, tz).applyMatrix4(ctx.M), color: pal.lamp, scale: 0.5, phase: 0.5 });
  }
  // rose window (glows at night)
  B.mat(M.STONE, 0.4, 0, 3).color(stone.clone().multiplyScalar(0.85)).ext(1, 0, F.NOWIN, 0);
  const M0 = ctx.M.clone();
  B.setMatrix(M0.clone().multiply(new THREE.Matrix4().makeTranslation(0, 22, L / 2 + 0.1)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
  B.cylinder(0, 0, 5.2, 5.2, 0, 0.5, { segs: 24, top: true });
  B.mat(M.EMISSIVE, 0.4, 0, 3).color(col('#c86a3a').multiplyScalar(0.35));
  B.cylinder(0, 0, 4.4, 4.4, 0.5, 0.55, { segs: 24, top: true });
  B.setMatrix(M0);
  glow(ctx, 0, 22, L / 2 + 1, col('#ff9a5a'), 3.2, 0.5);
  // portal
  B.mat(M.WOOD, 0.4, 0, 3).color(pal.wood);
  B.box(-2.4, 1, L / 2 - 0.2, 2.4, 9, L / 2 + 0.05, { base: 1, top: false });
  B.mat(M.STONE, 0.4, 0, 3).color(stone.clone().multiplyScalar(1.05));
  B.arch(0, 9, L / 2 - 0.2, L / 2 + 1.2, 2.4, 3.4, { segs: 8 });
  ctx.collider(0, 16, 0, Wn / 2 + 7, 16, L / 2, false);
  ctx.useTile(null);
  ctx.landmarkSpots.push({ x, z, h: fp.max + 90, kind: 'citadel', title: 'The Cathedral' });
  ctx.poiAt(x, z, fp.max + 2, 60, 'landmark', 'The Cathedral of the Golden Order');
  void rng;
}

export function plaza(ctx, pz) {
  const { pal, rng } = ctx;
  if (pz.kind === 'main') {
    statue(ctx, pz.x, pz.z, rng.float() * TAU, 1.2, M.BRONZE);
    ctx.occupy(pz.x, pz.z, 3);
    const n = Math.max(4, Math.floor(pz.r / 4));
    for (let i = 0; i < n; i++) { const a = (i / n) * TAU; lampPost(ctx, pz.x + Math.cos(a) * (pz.r - 1.2), pz.z + Math.sin(a) * (pz.r - 1.2), 'iron'); }
  } else lampPost(ctx, pz.x, pz.z, 'iron');
  void pal;
}

export function extras(ctx) {
  const { plan, pal } = ctx;
  plantTrees(ctx, ctx.settlement.level.engine.quality.pick(30, 60, 110, 150) * (ctx.main ? 1 : 0.5), ['round', 'round', 'cypress'], pal.foliage, foliageBlob);
  for (const r of plan.roads) if (r.kind === 'main') roadLamps(ctx, r, 20, 'iron');
}

export function wall(ctx, wl, gates) {
  const { rng, pal } = ctx;
  const pts = wl.pts, H = 11, T = 3.2;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (!a || !b) continue;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    if (gates.some((g) => Math.hypot(g.x - mx, g.z - mz) < g.w + 6)) continue;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const yaw = Math.atan2(b[0] - a[0], b[1] - a[1]) + Math.PI / 2;
    const fp = ctx.frame.footprint(mx, mz, L, T, yaw, 3);
    ctx.place(mx, mz, fp.min - 1, yaw);
    const B = ctx.B, dh = fp.max - fp.min;
    B.mat(M.STONE, rng.float(), 0, 3).color(pal.stones[1]).ext(1, 0, F.NOWIN, 0);
    B.box(-L / 2 - 0.3, 0, -T / 2, L / 2 + 0.3, H + dh, T / 2, { base: 0 });
    // crenellations
    const n = Math.floor(L / 1.6);
    for (let k = 0; k < n; k += 2) B.box(-L / 2 + k * 1.6, H + dh, T / 2 - 0.6, -L / 2 + k * 1.6 + 1.0, H + dh + 1.1, T / 2);
    ctx.collider(0, (H + dh) / 2, 0, L / 2, (H + dh) / 2, T / 2, true);
    if (i % 3 === 0) {
      B.mat(M.STONE, rng.float(), W.LANCET, 5).color(pal.stones[0]).ext(1, 0, 0, 0);
      B.cylinder(-L / 2, 0, 4.2, 3.8, 0, H + dh + 5, { segs: 14, top: true });
      B.mat(M.SLATE, rng.float(), 0, 3).color(pal.roofs[0]).ext(1, 0, F.NOWIN, 0);
      B.lathe(-L / 2, 0, [[4.6, H + dh + 5], [0.1, H + dh + 15]], { segs: 14 });
      glow(ctx, -L / 2, H + dh + 3, 4.0, pal.lamp, 0.6, rng.float());
    }
  }
  for (const g of gates) {
    const fp = ctx.frame.footprint(g.x, g.z, g.w + 14, 10, g.yaw, 3);
    ctx.place(g.x, g.z, fp.min - 1, g.yaw + Math.PI / 2);
    const B = ctx.B;
    B.mat(M.STONE, rng.float(), W.LANCET, 5).color(pal.stones[2]).ext(1, 0, 0, 0);
    for (const s of [-1, 1]) {
      B.box(s * (g.w / 2 + 0.5), 0, -5, s * (g.w / 2 + 7.5), 20, 5, { base: 0 });
      B.mat(M.SLATE, 0.3, 0, 3).color(pal.roofs[0]); B.pyramid(s * (g.w / 2 + 4), 0, 8, 11, 20, 9); B.mat(M.STONE, 0.3, W.LANCET, 5).color(pal.stones[2]);
      flag(ctx, s * (g.w / 2 + 4), 18, 5.1, 2, 7, pal.cloth[0], 0, true);
    }
    B.box(-g.w / 2 - 0.5, 12, -5, g.w / 2 + 0.5, 20, 5);
    B.arch(0, 12, -5, 5, g.w / 2 - 0.5, g.w / 2 + 0.5, { segs: 8 });
    ctx.collider(-g.w / 2 - 4, 10, 0, 3.5, 10, 5, false);
    ctx.collider(g.w / 2 + 4, 10, 0, 3.5, 10, 5, false);
  }
}

export function landmark(ctx) {
  const { plan, rng, pal } = ctx;
  const cd = ctx._cathedral;
  if (cd) cathedral(ctx, cd.x, cd.z, Math.atan2(plan.center[0] - cd.x, plan.center[1] - cd.z) + Math.PI);
  // the golden tree on the horizon
  const a = rng.range(0, TAU), r = plan.builtRadius * rng.range(2.2, 3);
  const x = plan.center[0] + Math.cos(a) * r, z = plan.center[1] + Math.sin(a) * r;
  ctx.useTile('landmark');
  const h0 = ctx.frame.hAt(x, z);
  ctx.place(x, z, h0 - 4, 0);
  const B = ctx.B;
  const H = 420;
  B.mat(M.WOOD, 0.5, 0, 3).color(col('#8a6a3a')).ext(1, 0, F.NOWIN, 0);
  rockLathe(B, 0, 0, [[60, 0], [34, 30], [22, 120], [16, 260], [9, H]], { segs: 24, amp: 0.35, fq: 0.02, seed: 13 });
  const gold = [col('#e8b840'), col('#f2c850'), col('#d8a030')];
  for (let k = 0; k < 14; k++) {
    const b = k / 14 * TAU + rng.range(-0.2, 0.2), y = H * rng.range(0.55, 1.0), L = rng.range(70, 150);
    const tip = new THREE.Vector3(Math.cos(b) * L, y + L * 0.3, Math.sin(b) * L);
    B.mat(M.WOOD, 0.5, 0, 3).color(col('#8a6a3a'));
    B.tube([new THREE.Vector3(0, y * 0.8, 0), new THREE.Vector3(Math.cos(b) * L * 0.5, y, Math.sin(b) * L * 0.5), tip], 5, 6);
    foliageBlob(B, tip.x, tip.y, tip.z, rng.range(50, 80), rng.pick(gold), 200 + k, 14);
    for (let g = 0; g < 6; g++) glow(ctx, tip.x + rng.range(-40, 40), tip.y + rng.range(-30, 30), tip.z + rng.range(-40, 40), col('#ffd76a'), 6, 0.5 + rng.float());
  }
  foliageBlob(B, 0, H, 0, 110, gold[1], 300, 18);
  ctx.useTile(null);
  ctx.landmarkSpots.push({ x, z, h: h0 + H, kind: 'tree', title: 'The Golden Tree' });
  ctx.poiAt(x, z, h0 + 2, 200, 'landmark', 'The Golden Tree');
  void pal;
}

export function reserve(ctx) {
  if (!ctx.main) return [];
  const a = ctx.rng.range(0, TAU);
  return (center, plazaR) => {
    const r = plazaR + 40;
    ctx._cathedral = { x: center[0] + Math.cos(a) * r, z: center[1] + Math.sin(a) * r };
    return [{ x: ctx._cathedral.x, z: ctx._cathedral.z, w: 50, d: 80, yaw: Math.atan2(-Math.cos(a), -Math.sin(a)) }];
  };
}
