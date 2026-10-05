// Monolithic — Villeneuve's Arrakeen: colossal battered slabs of
// sand-scoured concrete, stepped ziggurats, fins casting comb shadows, slit
// windows glowing amber at dusk, low adobe quarters with domes and wind
// catchers, a citadel that dwarfs everything, walls that outlast the dunes,
// and — far out in the sand — a black monolith humming at 1:4:9.

import * as THREE from 'three';
import { M, W, F, G } from '../ids.js';
import { col, glow, plinth, lampPost, roadLamps, stair, flag, TAU } from '../kit.js';
import { monolith } from '../landmarks.js';

export function palette(A, rng) {
  const P = A?.palette || {};
  void rng;
  return {
    concrete: ['#b5a690', '#a89a84', '#bfae94', '#9d907c', '#c4b49a'].map(col),
    adobe: ['#c49a72', '#b88c66', '#cfa77e', '#a98060'].map(col),
    dark: col('#3a332c'), black: col('#0c0b0a'),
    stone: col('#a2927a'), stoneDark: col('#7d6e5a'), wood: col('#5a4430'), trim: col('#c8b89a'), iron: col('#1c1a18'),
    lamp: col(P.lights || '#ffb36b'), accent: col(P.accent || '#ff9a3c'),
    cloth: ['#7a2a1a', '#c8a060', '#2a2420', '#d8c8a8'].map(col),
    ground: { main: col('#b09a7a'), street: col('#a8926e'), lane: col('#b8a07a'), plaza: col('#bba482'), dirt: col(P.sand || '#d8ae76').multiplyScalar(0.85) },
    metal: col('#7a7068'),
  };
}

export function roadMat(road, zone) {
  if (road.kind === 'avenue') return G.SANDSTONE;
  if (road.kind === 'main') return G.SANDSTONE;
  return zone < 0.5 ? G.FLAG : G.DIRT;
}
export const plazaMat = () => G.SANDSTONE;
export const shotSun = 0.13;
export const shot = { dist: 1.0, height: 45, sunAngle: 1.75, lmLift: 0.25, fov: 52 };

function slab(ctx, lot, w, d, H) {
  const { rng, pal } = ctx, B = ctx.B;
  const c = rng.pick(pal.concrete).clone().multiplyScalar(rng.range(0.92, 1.04));
  plinth(ctx, w, d, lot, 0.4, M.CONCRETE, c.clone().multiplyScalar(0.9), 0.4);
  const fh = rng.range(3.6, 4.4);
  const battered = rng.chance(0.55);
  const inset = battered ? H * rng.range(0.05, 0.11) : 0;
  B.mat(M.CONCRETE, rng.float(), W.SLIT, fh).color(c).ext(1, 0, 0, 0);
  B.frustumBox(-w / 2, -d / 2, w / 2, d / 2, 0.4, H, inset, { base: 0.4, top: true, front: F.FRONT });
  if (!battered) {
    // vertical fins on the long faces
    B.mat(M.CONCRETE, rng.float(), 0, fh).color(c.clone().multiplyScalar(0.96)).ext(1, 0, F.NOWIN, 0);
    const n = Math.floor(w / rng.range(3.2, 4.8));
    for (let i = 0; i <= n; i++) {
      const x = -w / 2 + (i / n) * w;
      for (const s of [-1, 1]) B.boxC(x, 0.4, s * (d / 2 + 0.45), 0.5, H - 0.4 - rng.range(0, 1.5), 0.9, { top: true });
    }
    // recessed crown band
    B.mat(M.CONCRETE, 0.2, 0, 3).color(pal.dark);
    B.box(-w / 2 + 0.3, H - 2.2, -d / 2 + 0.3, w / 2 - 0.3, H - 0.6, d / 2 + 0.3, { top: false, base: H - 2.2 });
    B.mat(M.CONCRETE, rng.float(), 0, 3).color(c);
    B.box(-w / 2 - 0.2, H - 0.6, -d / 2 - 0.2, w / 2 + 0.2, H + 0.6, d / 2 + 0.2, { base: H - 0.6 });
  } else {
    // a deep portal on the front face
    const pw = Math.min(w * 0.3, 5), ph = Math.min(H * 0.4, 9);
    B.mat(M.CONCRETE, 0.2, 0, 3).color(pal.dark).ext(0.5, 0, F.NOWIN, 0);
    B.box(-pw / 2, 0.4, d / 2 - 0.3, pw / 2, ph, d / 2 + 0.02, { base: 0.4, top: false });
    B.mat(M.EMISSIVE, 0.2, 0, 3).color(pal.lamp.clone().multiplyScalar(0.5));
    B.box(-pw / 2 + 0.4, 0.4, d / 2 - 0.2, pw / 2 - 0.4, 0.4 + Math.min(ph - 1, 3.6), d / 2 + 0.05, { base: 0.4, top: false, sides: [true, false, false, false] });
    glow(ctx, 0, 2.4, d / 2 + 0.6, pal.lamp, 1.2, rng.float());
  }
  // roof furniture: vents, a mast with a blinking red light on the tallest
  if (H > 26) {
    B.mat(M.METAL, 0.3, 0, 3).color(pal.metal).ext(1, 0, F.NOWIN, 0);
    B.boxC(rng.range(-w / 4, w / 4), H, rng.range(-d / 4, d / 4), 3, 2.2, 3);
    B.cylinder(w * 0.3 - inset, -d * 0.2 + inset, 0.12, 0.08, H, H + 7, { segs: 5 });
    ctx.beacons.push({ position: new THREE.Vector3(w * 0.3 - inset, H + 7.2, -d * 0.2 + inset).applyMatrix4(ctx.M), color: col('#ff3020'), scale: 0.7, phase: 2 + rng.float() });
  }
  return H;
}

function ziggurat(ctx, lot, w, d, steps, stepH) {
  const { rng, pal } = ctx, B = ctx.B;
  const c = rng.pick(pal.concrete);
  plinth(ctx, w, d, lot, 0.4, M.CONCRETE, c.clone().multiplyScalar(0.9), 0.4);
  let y = 0.4, sw = w, sd = d;
  for (let i = 0; i < steps; i++) {
    const h = stepH * (1 - i * 0.08);
    B.mat(M.CONCRETE, rng.float(), i % 2 ? W.SLIT : W.NONE, 4).color(c.clone().multiplyScalar(1 - i * 0.03)).ext(1, 0, i % 2 ? 0 : F.NOWIN, 0);
    B.frustumBox(-sw / 2, -sd / 2, sw / 2, sd / 2, y, y + h, h * 0.12, { base: y, front: F.FRONT });
    y += h; sw = sw * 0.72; sd = sd * 0.72;
  }
  // central stair up the front
  stair(ctx, -2, 2, d / 2 + 6, d / 2 - 2, 0, Math.min(y * 0.35, stepH), M.CONCRETE, c);
  return y;
}

function adobe(ctx, lot) {
  const { rng, pal } = ctx, B = ctx.B;
  const w = Math.max(5, lot.w * rng.range(0.7, 0.95)), d = Math.max(5, lot.d * rng.range(0.7, 0.95));
  const c = rng.pick(pal.adobe).clone().multiplyScalar(rng.range(0.92, 1.05));
  plinth(ctx, w, d, lot, 0.25, M.ADOBE, c.clone().multiplyScalar(0.85), 0.1);
  const H = rng.chance(0.4) ? 6.4 : 3.4;
  B.mat(M.ADOBE, rng.float(), W.SLIT, 3.2).color(c).ext(1, 0, 0, 0);
  B.frustumBox(-w / 2, -d / 2, w / 2, d / 2, 0.25, H, 0.25, { base: 0.25, top: true, front: F.FRONT });
  // parapet
  B.mat(M.ADOBE, rng.float(), 0, 3).color(c.clone().multiplyScalar(0.96)).ext(1, 0, F.NOWIN, 0);
  const iw = w / 2 - 0.25, id = d / 2 - 0.25;
  B.box(-iw, H, id - 0.3, iw, H + 0.7, id);
  B.box(-iw, H, -id, iw, H + 0.7, -id + 0.3);
  B.box(-iw, H, -id, -iw + 0.3, H + 0.7, id);
  B.box(iw - 0.3, H, -id, iw, H + 0.7, id);
  let top = H + 0.7;
  if (rng.chance(0.35)) {
    B.mat(M.ADOBE, rng.float(), 0, 3).color(c.clone().multiplyScalar(1.05));
    const r = Math.min(w, d) * 0.3;
    B.dome(rng.range(-w / 6, w / 6), H, rng.range(-d / 6, d / 6), r, { rings: 5, segs: 14, sy: 0.85 });
    top = H + r * 0.85;
  } else if (rng.chance(0.3)) {
    // wind catcher tower
    const tx = rng.range(-w / 4, w / 4), tz = rng.range(-d / 4, d / 4), th = H + rng.range(4, 7);
    B.mat(M.ADOBE, rng.float(), 0, 3).color(c);
    B.boxC(tx, H, tz, 1.6, th - H, 1.6);
    B.mat(M.CONCRETE, 0.2, 0, 3).color(pal.dark);
    for (const s of [-1, 1]) { B.boxC(tx, th - 2.2, tz + s * 0.81, 0.9, 1.6, 0.04, { top: false }); B.boxC(tx + s * 0.81, th - 2.2, tz, 0.04, 1.6, 0.9, { top: false }); }
    B.mat(M.ADOBE, rng.float(), 0, 3).color(c);
    B.boxC(tx, th, tz, 2.0, 0.3, 2.0);
    top = th;
  }
  // a cloth awning on some doors
  if (rng.chance(0.35)) {
    B.mat(M.CLOTH, rng.float(), 0, 3).color(rng.pick(pal.cloth)).ext(1, 2.4, 0, 1.2);
    const p0 = new THREE.Vector3(-1.2, 2.5, d / 2), p1 = new THREE.Vector3(1.2, 2.5, d / 2), p2 = new THREE.Vector3(1.2, 2.1, d / 2 + 1.4), p3 = new THREE.Vector3(-1.2, 2.1, d / 2 + 1.4);
    B.quadP(p3, p2, p1, p0, [0, 0], [2.4, 0], [2.4, 1.2], [0, 1.2]);
    B.quadP(p0, p1, p2, p3, [0, 0], [2.4, 0], [2.4, 1.2], [0, 1.2]);
  }
  if (rng.chance(0.4)) glow(ctx, 0.9, 2.2, d / 2 + 0.3, pal.lamp, 0.35, rng.float());
  ctx.collider(0, H / 2, 0, w / 2, H / 2 + 0.3, d / 2, true);
  ctx.footprints.push({ lot, h: top });
}

export function building(ctx, lot) {
  const { rng } = ctx;
  ctx.place(lot.x, lot.z, lot.base, lot.yaw);
  const area = lot.w * lot.d;
  const core = lot.zone < 0.45;
  if ((area > 260 && lot.zone < 0.7) || lot.plaza) {
    const w = lot.w * 0.92, d = lot.d * 0.92;
    let H;
    if (rng.chance(0.25) && Math.min(w, d) > 16) H = ziggurat(ctx, lot, w, d, rng.int(3, 4), rng.range(6, 9));
    else H = slab(ctx, lot, w, d, (core ? rng.range(18, 52) : rng.range(12, 26)) * (lot.plaza ? 1.2 : 1));
    ctx.collider(0, H / 2, 0, w / 2, H / 2, d / 2, false);
    ctx.footprints.push({ lot, h: H });
  } else adobe(ctx, lot);
}

export function plaza(ctx, pz) {
  const { pal, rng } = ctx;
  if (pz.kind === 'main') {
    // a sunken reflecting pool + obelisks
    const fr = ctx.frame;
    ctx.place(pz.x, pz.z, fr.hAt(pz.x, pz.z), 0);
    const B = ctx.B;
    const r = pz.r * 0.32;
    B.mat(M.CONCRETE, 0.3, 0, 3).color(pal.concrete[0]).ext(0.95, 0, F.NOWIN, 0);
    B.box(-r, -0.4, -r * 0.5, r, 0.5, r * 0.5, { top: false });
    B.mat(M.GLASS, 0.3, 0, 3).color(col('#14221f'));
    B.box(-r + 0.5, -0.4, -r * 0.5 + 0.5, r - 0.5, 0.3, r * 0.5 - 0.5, { sides: [false, false, false, false] });
    for (const s of [-1, 1]) {
      B.mat(M.CONCRETE, 0.5, 0, 3).color(pal.dark);
      B.frustumBox(s * (r + 3) - 1.2, -1.2, s * (r + 3) + 1.2, 1.2, -0.5, 22, 0.8, { base: -0.5 });
      glow(ctx, s * (r + 3), 0.8, 1.6, pal.lamp, 0.8, rng.float());
    }
    ctx.occupy(pz.x, pz.z, r + 4);
    const n = Math.max(6, Math.floor(pz.r / 4));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      lampPost(ctx, pz.x + Math.cos(a) * (pz.r - 1.5), pz.z + Math.sin(a) * (pz.r - 1.5), 'stone');
    }
  } else {
    lampPost(ctx, pz.x, pz.z, 'stone');
  }
}

export function extras(ctx) {
  const { plan } = ctx;
  for (const r of plan.roads) if (r.kind === 'avenue') roadLamps(ctx, r, 26, 'stone', 1.2);
}

/** Colossal battered city wall with towers and gate pylons. */
export function wall(ctx, wl, gates) {
  const { rng, pal } = ctx;
  const pts = wl.pts;
  const H = 14, T = 7;
  const c = pal.concrete[1];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (!a || !b) continue;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    if (gates.some((g) => Math.hypot(g.x - mx, g.z - mz) < g.w + 8)) continue;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const yaw = Math.atan2(b[0] - a[0], b[1] - a[1]) + Math.PI / 2;
    const fp = ctx.frame.footprint(mx, mz, L, T, yaw, 3);
    ctx.place(mx, mz, fp.min - 1, yaw);
    const B = ctx.B;
    B.mat(M.CONCRETE, rng.float(), 0, 4).color(c).ext(1, 0, F.NOWIN, 0);
    B.frustumBox(-L / 2 - 0.6, -T / 2, L / 2 + 0.6, T / 2, 0, H + (fp.max - fp.min), 1.8, { base: 0 });
    ctx.collider(0, H / 2, 0, L / 2, H / 2 + 1, T / 2, true);
    if (i % 3 === 0) {
      B.mat(M.CONCRETE, rng.float(), W.SLIT, 4).color(c.clone().multiplyScalar(0.95)).ext(1, 0, 0, 0);
      B.frustumBox(-L / 2 - 4.5, -T / 2 - 3, -L / 2 + 4.5, T / 2 + 3, 0, H + 9 + (fp.max - fp.min), 2.2, { base: 0 });
      glow(ctx, -L / 2, H + 9.5 + (fp.max - fp.min), 0, pal.lamp, 0.8, rng.float());
    }
  }
  for (const g of gates) {
    for (const s of [-1, 1]) {
      const yaw = g.yaw;
      const px = g.x + Math.cos(yaw) * s * (g.w / 2 + 6), pz = g.z - Math.sin(yaw) * s * (g.w / 2 + 6);
      const fp = ctx.frame.footprint(px, pz, 10, 12, yaw, 3);
      ctx.place(px, pz, fp.min - 1, yaw);
      const B = ctx.B;
      B.mat(M.CONCRETE, rng.float(), W.SLIT, 5).color(pal.concrete[2]).ext(1, 0, 0, 0);
      B.frustumBox(-5, -6, 5, 6, 0, 30 + (fp.max - fp.min), 2.6, { base: 0 });
      flag(ctx, 0, 27, 6.2, 2.4, 16, pal.cloth[0], Math.PI / 2, true);
      glow(ctx, 0, 4, 6.5, pal.lamp, 1.2, rng.float());
      ctx.collider(0, 15, 0, 5, 15, 6, false);
    }
  }
}

/** The citadel: a colossal stepped pyramid on the main plaza's edge. */
function citadel(ctx, x, z, yaw) {
  const { pal, rng } = ctx;
  ctx.useTile('landmark');
  const S = 110;
  const fp = ctx.frame.footprint(x, z, S, S, yaw, 5);
  ctx.place(x, z, fp.min, yaw);
  const B = ctx.B;
  const c = pal.concrete[0];
  // lower mass: a vast battered platform
  const h1 = 56, in1 = 20;
  B.mat(M.CONCRETE, rng.float(), W.NONE, 5).color(c).ext(1, 0, F.NOWIN, 0);
  B.frustumBox(-S / 2, -S / 2, S / 2, S / 2, -2, h1, in1, { base: -2 });
  // the great door: a tall dark recess at the foot of the front face, lit from within
  B.mat(M.CONCRETE, 0.1, 0, 3).color(pal.dark).ext(0.35, 0, F.NOWIN, 0);
  B.box(-6, -2, S / 2 - 3, 6, 26, S / 2 + 0.3, { top: false, base: -2, sides: [true, false, false, false] });
  B.mat(M.EMISSIVE, 0.2, 0, 3).color(pal.lamp.clone().multiplyScalar(0.3));
  B.box(-4.5, -2, S / 2 - 2.6, 4.5, 12, S / 2 + 0.35, { top: false, base: -2, sides: [true, false, false, false] });
  // shadow recess
  const S2 = S - in1 * 2 - 6;
  B.mat(M.CONCRETE, 0.1, 0, 3).color(pal.dark).ext(0.4, 0, F.NOWIN, 0);
  B.box(-S2 / 2, h1, -S2 / 2, S2 / 2, h1 + 3, S2 / 2, { top: false });
  // upper mass with slit galleries
  const h2 = 38;
  B.mat(M.CONCRETE, rng.float(), W.SLIT, 5).color(c.clone().multiplyScalar(0.96)).ext(1, 0, 0, 0);
  B.frustumBox(-S2 / 2 - 2, -S2 / 2 - 2, S2 / 2 + 2, S2 / 2 + 2, h1 + 3, h1 + 3 + h2, 5, { base: h1 + 3, front: F.FRONT });
  // fins along the upper mass sides
  B.mat(M.CONCRETE, rng.float(), 0, 3).color(c.clone().multiplyScalar(0.92)).ext(1, 0, F.NOWIN, 0);
  for (let i = 0; i < 9; i++) {
    const x = -S2 / 2 + 4 + i * ((S2 - 8) / 8);
    for (const sz of [-1, 1]) B.boxC(x, h1 + 3, sz * (S2 / 2 + 1.5), 1.2, h2 - 6, 3.0);
  }
  const y = h1 + 3 + h2;
  // ramp/stair up the front face
  stair(ctx, -6, 6, S / 2 + 30, S / 2 - 4, -1, 22, M.CONCRETE, c.clone().multiplyScalar(0.92));
  // monumental portico: colossal square pillars along the front
  B.mat(M.CONCRETE, 0.3, 0, 3).color(c).ext(1, 0, F.NOWIN, 0);
  for (let i = 0; i < 8; i++) {
    const px = -S / 2 + 8 + i * ((S - 16) / 7);
    if (Math.abs(px) < 9) continue;
    B.boxC(px, -2, S / 2 + 8, 3.2, 34, 3.2);
  }
  B.box(-S / 2 + 4, 32, S / 2 + 5, S / 2 - 4, 36, S / 2 + 11);
  glow(ctx, 0, 3, S / 2 + 2, pal.lamp, 2.2, 0.4);
  ctx.collider(0, y / 2, 0, S / 2, y / 2, S / 2, false);
  ctx.useTile(null);
  ctx.landmarkSpots.push({ x, z, h: fp.min + y + 14, kind: 'citadel', title: 'The Citadel' });
  ctx.poiAt(x, z, fp.min + 2, 90, 'landmark', 'The Citadel');
}

export function reserve(ctx, radius) {
  // keep a 130 m square for the citadel next to the main plaza
  if (!ctx.main) return [];
  const a = ctx.rng.range(0, TAU);
  void radius;
  return (center, plazaR) => {
    const r = plazaR + 78;
    ctx._citadel = { x: center[0] + Math.cos(a) * r, z: center[1] + Math.sin(a) * r, a };
    return [{ x: ctx._citadel.x, z: ctx._citadel.z, w: 136, d: 136, yaw: 0 }];
  };
}

export function landmark(ctx) {
  const { plan, rng } = ctx;
  const cdl = ctx._citadel;
  if (cdl) citadel(ctx, cdl.x, cdl.z, Math.atan2(plan.center[0] - cdl.x, plan.center[1] - cdl.z));
  // the monolith out in the sand
  let best = null;
  for (let k = 0; k < 24; k++) {
    const a = rng.range(0, TAU), r = plan.builtRadius * rng.range(1.3, 1.9);
    const x = plan.center[0] + Math.cos(a) * r, z = plan.center[1] + Math.sin(a) * r;
    const fp = ctx.frame.footprint(x, z, 20, 6, 0, 3);
    const sc = -(fp.max - fp.min) + ctx.frame.hAt(x, z) * 0.05;
    if (!best || sc > best.sc) best = { x, z, sc };
  }
  if (best) monolith(ctx, best.x, best.z, 2.2);
}
