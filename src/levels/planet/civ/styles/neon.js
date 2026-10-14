// Neon — Cowboy Bebop / Blade Runner: dense towers of rust and glass with
// lit office grids, vertical neon signs stacked up the facades, holographic
// billboards, street stalls under awnings, and an arcology pyramid glowing on
// the skyline.

import * as THREE from 'three';
import { M, W, F, G } from '../ids.js';
import { col, glow, plinth, lampPost, roadLamps, stall, TAU } from '../kit.js';

export function palette(A, rng) {
  const P = A?.palette || {};
  void rng;
  return {
    towers: ['#7a6a5e', '#5e5650', '#8a7666', '#6a625a', '#4e4a48'].map(col),
    neon: (P.neon || ['#ff2f8f', '#2fe0ff', '#ffd02f', '#9f5fff']).map(col),
    stone: col('#6a6058'), stoneDark: col('#4a4440'), wood: col('#4a3a2e'), trim: col('#a89888'), iron: col('#1c1c1e'),
    lamp: col(P.lights || '#ff9f4a'), accent: col(P.accent || '#ff3f7f'),
    cloth: (P.neon || ['#ff2f8f', '#2fe0ff', '#ffd02f']).map(col),
    ground: { main: col('#4a4644'), street: col('#565250'), lane: col('#5e5652'), plaza: col('#5a5654'), dirt: col('#5a4a3e') },
    metal: col('#7a7a74'),
  };
}

export function roadMat(road) { return road.kind === 'avenue' ? G.DECK : G.FLAG; }
export const plazaMat = () => G.FLAG;
export const shotSun = 0.03;
export const shot = { dist: 0.74, height: 48, sunAngle: 2.4, lmLift: 0.2 };

function sign(ctx, x, y, z, w, h, c) {
  const B = ctx.B;
  B.mat(M.NEON, ctx.rng.float(), 0, 3).color(c).ext(1, w, F.NOWIN, h);
  B.box(x - w / 2, y, z, x + w / 2, y + h, z + 0.25, { base: y });
  glow(ctx, x, y + h / 2, z + 0.6, c, Math.max(w, h) * 0.35, 0.1 + ctx.rng.float() * 0.9);
}

export function building(ctx, lot) {
  const { rng, pal } = ctx;
  ctx.place(lot.x, lot.z, lot.base, lot.yaw);
  const B = ctx.B;
  const w = lot.w * 0.92, d = lot.d * 0.92;
  const core = lot.zone < 0.45;
  const H = core ? rng.range(30, 110) : rng.range(10, 36);
  const c = rng.pick(pal.towers).clone().multiplyScalar(rng.range(0.85, 1.1));
  plinth(ctx, w, d, lot, 0.3, M.CONCRETE, pal.stoneDark, 0);
  // podium with shopfronts
  B.mat(M.CONCRETE, rng.float(), W.HOUSE, 4).color(c.clone().multiplyScalar(0.8)).ext(1, 0, 0, 0);
  B.box(-w / 2, 0.3, -d / 2, w / 2, 5, d / 2, { base: 0.3, top: true, front: F.FRONT | F.SHOP });
  // tower with setbacks
  let y = 5, sw = w * 0.92, sd = d * 0.92;
  const steps = H > 50 ? 3 : H > 25 ? 2 : 1;
  for (let i = 0; i < steps; i++) {
    const h = (H - 5) / steps;
    B.mat(rng.chance(0.3) ? M.RUST : M.METAL, rng.float(), W.GRID, 3.4).color(c).ext(1, 0, 0, 0);
    B.box(-sw / 2, y, -sd / 2, sw / 2, y + h, sd / 2, { base: y, top: true });
    y += h; sw *= 0.8; sd *= 0.8;
  }
  // neon signs stacked vertically on the front corner
  const ns = rng.int(1, 3);
  for (let k = 0; k < ns; k++) {
    const sx = rng.range(-w * 0.4, w * 0.4);
    sign(ctx, sx, rng.range(6, Math.min(H * 0.6, 26)), d / 2 + 0.3, rng.range(1.2, 2.2), rng.range(4, 9), rng.pick(pal.neon));
  }
  // horizontal shop sign
  sign(ctx, 0, 3.6, d / 2 + 0.1, w * 0.6, 0.9, rng.pick(pal.neon));
  // rooftop antenna + beacon
  if (H > 40) {
    B.mat(M.METAL, 0.3, 0, 3).color(pal.metal).ext(1, 0, F.NOWIN, 0);
    B.cylinder(0, 0, 0.2, 0.06, y, y + 12, { segs: 5 });
    ctx.beacons.push({ position: new THREE.Vector3(0, y + 12.4, 0).applyMatrix4(ctx.M), color: col('#ff3020'), scale: 0.6, phase: 2 + rng.float() });
  }
  // a hologram billboard on some towers
  if (core && rng.chance(0.25)) {
    B.mat(M.HOLO, rng.float(), 0, 3).color(rng.pick(pal.neon)).ext(1, sw, F.NOWIN, 8);
    B.box(-sw / 2, y - 14, sd / 2 + 1, sw / 2, y - 4, sd / 2 + 1.1, { base: y - 14 });
  }
  ctx.collider(0, H / 2, 0, w / 2, H / 2, d / 2, false);
  ctx.footprints.push({ lot, h: H });
}

export function plaza(ctx, pz) {
  const { rng, pal } = ctx;
  for (let i = 0; i < Math.floor(pz.r / 2.5); i++) {
    const a = rng.range(0, TAU), r = rng.range(pz.r * 0.3, pz.r * 0.8);
    const x = pz.x + Math.cos(a) * r, z = pz.z + Math.sin(a) * r;
    if (!ctx.free(x, z, 1.6, true)) continue;
    stall(ctx, x, z, a + Math.PI / 2, rng.pick(pal.cloth));
    ctx.B.mat(M.NEON, rng.float(), 0, 3).color(rng.pick(pal.neon)).ext(1, 1.6, F.NOWIN, 0.4);
    ctx.B.box(-0.8, 2.85, 1.2, 0.8, 3.25, 1.3);
    glow(ctx, 0, 3.0, 1.5, rng.pick(pal.neon), 0.8, rng.float());
    ctx.occupy(x, z, 3);
  }
  lampPost(ctx, pz.x, pz.z, 'tech');
}

export function extras(ctx) {
  for (const r of ctx.plan.roads) if (r.kind === 'avenue') roadLamps(ctx, r, 16, 'tech');
}

export function landmark(ctx) {
  const { plan, rng, pal } = ctx;
  const a = rng.range(0, TAU), r = plan.builtRadius * 1.25;
  const x = plan.center[0] + Math.cos(a) * r, z = plan.center[1] + Math.sin(a) * r;
  ctx.useTile('landmark');
  const fp = ctx.frame.footprint(x, z, 200, 200, 0, 4);
  ctx.place(x, z, fp.min - 2, Math.atan2(plan.center[0] - x, plan.center[1] - z));
  const B = ctx.B;
  // arcology: a stepped pyramid of lit glass
  let y = 0, s = 200;
  for (let i = 0; i < 9; i++) {
    const h = 32;
    B.mat(M.METAL, rng.float(), W.GRID, 3.6).color(col('#3a3632')).ext(1, 0, 0, 0);
    B.frustumBox(-s / 2, -s / 2, s / 2, s / 2, y, y + h, 9, { base: y });
    for (let k = 0; k < 4; k++) { const b = k / 4 * TAU + Math.PI / 4; glow(ctx, Math.cos(b) * s * 0.7, y + h, Math.sin(b) * s * 0.7, pal.lamp, 3, rng.float()); }
    y += h; s -= 21;
  }
  B.mat(M.EMISSIVE, 0.4, 0, 3).color(col('#ffd8a0'));
  B.frustumBox(-s / 2, -s / 2, s / 2, s / 2, y, y + 18, s / 2 - 1, { base: y });
  ctx.beacons.push({ position: new THREE.Vector3(0, y + 20, 0).applyMatrix4(ctx.M), color: col('#ff3020'), scale: 2, phase: 2.2 });
  ctx.collider(0, y / 2, 0, 100, y / 2, 100, false);
  ctx.useTile(null);
  ctx.landmarkSpots.push({ x, z, h: fp.min + y, kind: 'citadel', title: 'The Arcology' });
  ctx.poiAt(x, z, fp.min + 2, 140, 'landmark', 'The Arcology');
}

export function reserve(ctx) { void ctx; return []; }
