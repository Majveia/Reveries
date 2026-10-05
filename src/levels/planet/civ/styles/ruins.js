// Ruins — Fumito Ueda: bleached, moss-veined stone of a vanished people.
// Colonnades with broken shafts, toppled drums, colossal arches standing
// alone in the grass, jagged wall fragments, megaliths, stepped platforms, a
// fallen giant's head — and a few cold spirit lights at dusk.

import * as THREE from 'three';
import { M, W, F, G } from '../ids.js';
import { col, glow, figure, TAU } from '../kit.js';
import { rockLathe } from '../landmarks.js';

export function palette(A, rng) {
  const P = A?.palette || {};
  void rng;
  const base = col(P.rock || '#9b968a');
  return {
    stones: [base.clone().lerp(col('#d8d2c2'), 0.5), base.clone().lerp(col('#c8c0ae'), 0.35), base.clone(), base.clone().lerp(col('#e2dccb'), 0.6)],
    stone: base.clone().lerp(col('#cfc8b6'), 0.4), stoneDark: base.clone().multiplyScalar(0.7), wood: col('#5a4a3a'), trim: col('#e0d8c8'), iron: col('#2a2a2a'),
    lamp: col('#9fd8ff'), accent: col(P.accent || '#e8e2c8'), cloth: [col('#8a7a5a')],
    ground: { main: col('#a8a294'), street: col('#9a9486'), lane: col('#8a8474'), plaza: col('#b2ac9c'), dirt: col('#7a7464') },
    metal: col('#7a7a74'),
  };
}

export function roadMat(road) { return road.kind === 'avenue' || road.kind === 'main' ? G.FLAG : G.GRAVEL; }
export const plazaMat = () => G.FLAG;
export const people = false;
export const shotSun = 0.08;
export const shot = { dist: 0.7, height: 18, sunAngle: 1.5, lmLift: 0.35 };

function column(B, x, z, y0, h, r, broken, rng) {
  B.cylinder(x, z, r * 1.25, r * 1.25, y0 - 0.5, y0 + 0.5, { segs: 10, top: true });
  B.cylinder(x, z, r, r * 0.9, y0 + 0.5, y0 + h, { segs: 12, top: true });
  if (!broken) { B.box(x - r * 1.4, y0 + h, z - r * 1.4, x + r * 1.4, y0 + h + r * 0.8, z + r * 1.4); }
  else {
    // jagged break: a tilted short drum on top
    const t = rng.range(0.2, 0.6);
    B.cylinder(x + rng.range(-0.1, 0.1), z, r * 0.88, r * 0.7, y0 + h, y0 + h + t, { segs: 7, top: true, smooth: false });
  }
}

export function building(ctx, lot) {
  const { rng, pal } = ctx;
  ctx.place(lot.x, lot.z, lot.low ?? lot.base, lot.yaw);
  const B = ctx.B;
  const c = rng.pick(pal.stones).clone().multiplyScalar(rng.range(0.9, 1.05));
  B.mat(M.MOSSSTONE, rng.float(), 0, 3).color(c).ext(1, 0, F.NOWIN, 0);
  const w = lot.w, d = lot.d, lift = (lot.base - (lot.low ?? lot.base));
  const r = rng.float();
  let top = 4;
  if (r < 0.3) {
    // colonnade on a stylobate
    B.box(-w / 2, -1, -d / 2, w / 2, lift + 0.8, d / 2);
    const n = Math.max(2, Math.floor(w / 3.2));
    const h = rng.range(7, 13);
    for (let i = 0; i <= n; i++) for (const s of [-1, 1]) {
      if (rng.chance(0.25)) continue;
      const broken = rng.chance(0.55);
      column(B, -w / 2 + 1 + i * ((w - 2) / n), s * (d / 2 - 1.2), lift + 0.8, broken ? h * rng.range(0.2, 0.8) : h, 0.55, broken, rng);
    }
    // fallen drums lying in the grass
    const M0 = ctx.M.clone();
    for (let k = 0; k < rng.int(1, 3); k++) {
      const yaw = rng.float() * TAU;
      B.setMatrix(M0.clone().multiply(new THREE.Matrix4().makeTranslation(rng.range(-w, w) * 0.6, lift * 0.3 + 0.45, rng.range(-d, d) * 0.7)).multiply(new THREE.Matrix4().makeRotationY(yaw)).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)));
      B.cylinder(0, 0, 0.55, 0.5, -1.2, 1.2, { segs: 10, top: true, bottom: true });
    }
    B.setMatrix(M0);
    top = lift + h;
  } else if (r < 0.55) {
    // arch fragment(s)
    const span = Math.min(w, 9), H = rng.range(6, 12), t = rng.range(1.2, 2);
    B.box(-span / 2 - t, -1, -t, -span / 2, lift + H, t, { base: -1 });
    if (rng.chance(0.7)) B.box(span / 2, -1, -t, span / 2 + t, lift + H * rng.range(0.6, 1), t, { base: -1 });
    B.arch(0, lift + H, -t, t, span / 2, span / 2 + t, { segs: rng.chance(0.4) ? 5 : 10 });
    top = lift + H + span / 2 + t;
  } else if (r < 0.8) {
    // ruined wall with a jagged top and an empty window
    const n = Math.max(3, Math.floor(w / 1.5)), t = 1.2;
    for (let i = 0; i < n; i++) {
      const x0 = -w / 2 + i * (w / n), x1 = x0 + w / n;
      const h = lift + Math.max(1, rng.range(2, 9) * Math.sin(Math.PI * (i + 0.5) / n) + rng.range(-1, 1));
      if (i === Math.floor(n / 2) && h > lift + 5) { B.box(x0, -1, -t / 2, x1, lift + 1.5, t / 2); B.box(x0, lift + 4.2, -t / 2, x1, h, t / 2); }
      else B.box(x0, -1, -t / 2, x1, h, t / 2);
      top = Math.max(top, h);
    }
  } else {
    // megaliths
    const n = rng.int(1, 3);
    for (let k = 0; k < n; k++) {
      const h = rng.range(5, 11), ww = rng.range(1.4, 2.6);
      const M0 = ctx.M.clone();
      B.setMatrix(M0.clone().multiply(new THREE.Matrix4().makeTranslation(rng.range(-w / 3, w / 3), -1, rng.range(-d / 3, d / 3))).multiply(new THREE.Matrix4().makeRotationZ(rng.range(-0.12, 0.12))).multiply(new THREE.Matrix4().makeRotationY(rng.float() * TAU)));
      B.frustumBox(-ww / 2, -ww * 0.35, ww / 2, ww * 0.35, 0, h + lift, ww * 0.12, { base: 0 });
      B.setMatrix(M0);
      top = Math.max(top, h);
    }
  }
  if (rng.chance(0.12)) glow(ctx, rng.range(-w / 3, w / 3), lift + rng.range(1, 3), rng.range(-d / 3, d / 3), pal.lamp, 0.35, 0.3 + rng.float());
  ctx.collider(0, top / 2, 0, w / 2, top / 2, Math.min(d, 2.5) / 2, false);
  ctx.footprints.push({ lot, h: top });
}

export function plaza(ctx, pz) {
  const { rng, pal } = ctx;
  if (pz.kind !== 'main') return;
  // a stepped altar platform with a worn statue
  const fr = ctx.frame;
  ctx.place(pz.x, pz.z, fr.hAt(pz.x, pz.z), rng.float() * TAU);
  const B = ctx.B;
  B.mat(M.MOSSSTONE, 0.4, 0, 3).color(pal.stone).ext(1, 0, F.NOWIN, 0);
  for (let i = 0; i < 3; i++) B.box(-6 + i * 1.6, -1 + i * 0.7, -6 + i * 1.6, 6 - i * 1.6, -0.3 + (i + 1) * 0.7, 6 - i * 1.6);
  figure(B, 0, 1.8, 0, 2.8, M.MOSSSTONE, pal.stones[0], 1);
  ctx.collider(0, 0.8, 0, 6, 1.4, 6, true);
  ctx.occupy(pz.x, pz.z, 7);
  ctx.poiAt(pz.x, pz.z, fr.hAt(pz.x, pz.z) + 2, 20, 'shrine', 'The Worn Altar');
}

export function extras(ctx) {
  const { plan, rng, pal } = ctx;
  // the vanished city sprawls beyond its roads: scatter more ruins over dry, gentle ground
  const want = ctx.main ? 70 : 34;
  let placed = 0;
  for (let k = 0; k < want * 6 && placed < want; k++) {
    const a = rng.range(0, TAU), r = Math.sqrt(rng.float()) * plan.radius * 1.1;
    const x = plan.center[0] + Math.cos(a) * r, z = plan.center[1] + Math.sin(a) * r;
    const w = rng.range(6, 16), d = rng.range(5, 14), yaw = rng.float() * TAU;
    const fp = ctx.frame.footprint(x, z, w, d, yaw, 3);
    if (fp.wet > 0 || fp.max - fp.min > 5) continue;
    if (!ctx.free(x, z, Math.max(w, d) * 0.6)) continue;
    const lot = { x, z, w, d, yaw, base: fp.max, low: fp.min, zone: r / plan.radius };
    ctx.select(x, z);
    ctx.lot = lot;
    building(ctx, lot);
    ctx.lot = null;
    ctx.occupy(x, z, Math.max(w, d) * 0.6);
    placed++;
  }
  // avenue of broken columns along the main axis
  const av = plan.mains?.[0];
  if (av) {
    for (let i = 3; i < av.pts.length - 1; i += 3) {
      const [x, z] = av.pts[i], [x2, z2] = av.pts[i + 1];
      const L = Math.hypot(x2 - x, z2 - z) || 1;
      const nx = -(z2 - z) / L, nz = (x2 - x) / L;
      for (const s of [-1, 1]) {
        const px = x + nx * (av.w / 2 + 2) * s, pz = z + nz * (av.w / 2 + 2) * s;
        if (!ctx.free(px, pz, 1)) continue;
        ctx.place(px, pz, ctx.frame.hAt(px, pz), 0);
        ctx.B.mat(M.MOSSSTONE, rng.float(), 0, 3).color(rng.pick(pal.stones)).ext(1, 0, F.NOWIN, 0);
        const broken = rng.chance(0.6);
        column(ctx.B, 0, 0, 0, broken ? rng.range(2, 7) : rng.range(8, 10), 0.6, broken, rng);
      }
    }
  }
}

/** The fallen colossus: a giant stone head half-sunk in the ground + a lone great arch. */
export function landmark(ctx) {
  const { plan, rng, pal } = ctx;
  ctx.useTile('landmark');
  const spot = plan.spots.find((s) => s.r > plan.builtRadius * 0.5) || plan.spots[0];
  if (spot) {
    const fr = ctx.frame;
    ctx.place(spot.x, spot.z, fr.hAt(spot.x, spot.z) - 6, rng.float() * TAU);
    const B = ctx.B;
    B.mat(M.MOSSSTONE, 0.6, 0, 3).color(pal.stones[1]).ext(1, 0, F.NOWIN, 0);
    const M0 = ctx.M.clone();
    B.setMatrix(M0.clone().multiply(new THREE.Matrix4().makeRotationZ(1.25)));
    rockLathe(B, 0, 0, [[1, -16], [10, -14], [14, -6], [15, 4], [13, 12], [9, 17], [1, 19]], { segs: 20, amp: 0.08, fq: 0.08, seed: 5 });
    // crown band
    B.cylinder(0, 0, 13.6, 12.5, 10, 14, { segs: 20, top: true });
    B.setMatrix(M0);
    ctx.collider(0, 8, 0, 14, 10, 14, false);
    ctx.landmarkSpots.push({ x: spot.x, z: spot.z, h: fr.hAt(spot.x, spot.z) + 20, kind: 'colossus', title: 'The Fallen Colossus' });
    ctx.poiAt(spot.x, spot.z, fr.hAt(spot.x, spot.z) + 2, 50, 'landmark', 'The Fallen Colossus');
  }
  // great lone arch
  const s2 = plan.spots.find((s) => s !== spot && s.r > plan.builtRadius * 0.3);
  if (s2) {
    const fr = ctx.frame;
    const yaw = rng.float() * TAU;
    const fp = fr.footprint(s2.x, s2.z, 60, 12, yaw, 3);
    ctx.place(s2.x, s2.z, fp.min - 2, yaw);
    const B = ctx.B;
    B.mat(M.MOSSSTONE, 0.7, 0, 3).color(pal.stones[3]).ext(1, 0, F.NOWIN, 0);
    const span = 34, H = 38, t = 7;
    B.box(-span / 2 - t, 0, -t / 2, -span / 2, H, t / 2);
    B.box(span / 2, 0, -t / 2, span / 2 + t, H, t / 2);
    B.arch(0, H, -t / 2, t / 2, span / 2, span / 2 + t, { segs: 14 });
    ctx.collider(-span / 2 - t / 2, H / 2, 0, t / 2, H / 2, t / 2, false);
    ctx.collider(span / 2 + t / 2, H / 2, 0, t / 2, H / 2, t / 2, false);
    ctx.landmarkSpots.push({ x: s2.x, z: s2.z, h: fp.min + H + span / 2, kind: 'arch', title: 'The Great Arch' });
  }
  ctx.useTile(null);
}

export function reserve(ctx) { void ctx; return []; }
