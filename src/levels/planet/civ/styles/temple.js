// Temple — Black Myth: Wukong / Sekiro: halls on stone terraces with red
// lacquer columns and sweeping curved roofs of dark barrel tiles, lattice
// screens glowing like paper lanterns at dusk, paifang gates over the
// processional way, stone toro lanterns, a great pagoda on the heights and a
// colossal guardian at the end of the avenue.

import * as THREE from 'three';
import { M, W, F, G } from '../ids.js';
import { col, glow, plinth, lampPost, flag, paperLantern, stall, roadLamps, lowWall, stair, plantTrees, lanternStrings, TAU } from '../kit.js';
import { colossus, foliageBlob } from '../landmarks.js';
import { boat } from './pastoral.js';

export function palette(A, rng) {
  const P = A?.palette || {};
  void rng;
  return {
    walls: ['#e8e2d4', '#ddd6c6', '#e4dccb', '#d6cfbf'].map(col),
    roofs: ['#4a4f4e', '#42484c', '#50524c', '#3c4446', '#5a5048'].map(col),
    lacquer: col('#8e1f18'), lacquer2: col('#6e1a14'), gold: col('#c8963a'),
    stone: col('#8f8b80'), stoneDark: col('#6a675e'), wood: col('#4a3324'), woodDark: col('#2c1f16'), trim: col('#d9d2c2'), iron: col('#1c1c1e'),
    lamp: col(P.lights || '#ffb85a'), lantern: col('#ff4a2a'), accent: col(P.accent || '#c8282a'),
    cloth: ['#b8282a', '#d8a83a', '#2a2a2a', '#e8e0d0'].map(col),
    fields: ['#7a8a4a', '#8a9a52', '#a09a5a', '#6a7a46', '#9aa860'].map(col),
    ground: { main: col('#8a867c'), street: col('#85817a'), lane: col('#7a6e5a'), plaza: col('#9a968a'), dirt: col('#7a6a52') },
    metal: col('#7a7a74'),
  };
}

export function roadMat(road, zone) {
  if (road.kind === 'avenue') return G.FLAG;
  if (road.kind === 'main') return zone < 0.7 ? G.FLAG : G.DIRT;
  if (road.kind === 'street') return zone < 0.45 ? G.COBBLE : G.DIRT;
  return G.DIRT;
}
export const plazaMat = () => G.FLAG;
export const shotSun = 0.4;
export const lightsEarly = 0.34; // lanterns lit in the mist of the late afternoon
export const shot = { dist: 0.56, height: 60, sunAngle: 1.7, lmLift: 0.3, sunPref: 1.8 };

/** A timber hall: terrace, columns, lattice screens, curved roof (1–2 eaves). */
function hall(ctx, w, d, lot, o = {}) {
  const { rng, pal } = ctx;
  const B = ctx.B;
  const terr = o.terrace ?? 0.7;
  plinth(ctx, w + 1.6, d + 1.6, lot, terr, M.STONE, pal.stone, 0);
  // front steps
  if (terr > 0.5) stair(ctx, -Math.min(2.4, w * 0.25), Math.min(2.4, w * 0.25), d / 2 + 0.8 + terr * 1.6, d / 2 + 0.8, 0, terr, M.STONE, pal.stone);
  const H = o.H ?? rng.range(3.4, 4.2);
  const y0 = terr;
  // walls: lattice front/back in dark wood, plaster sides
  const wood = o.lacquer ? pal.lacquer : pal.wood;
  B.mat(M.WOOD, rng.float(), W.LATTICE, H).color(wood).ext(1, 0, 0, 0);
  B.wall(-w / 2, d / 2, w / 2, d / 2, y0, y0 + H, y0, F.FRONT);
  B.mat(M.WOOD, rng.float(), o.big ? W.LATTICE : W.NONE, H).color(o.big ? wood : pal.woodDark);
  B.wall(w / 2, -d / 2, -w / 2, -d / 2, y0, y0 + H, y0, 0);
  B.mat(M.PLASTER, rng.float(), 0, H).color(rng.pick(pal.walls)).ext(1, 0, F.NOWIN, 0);
  B.wall(w / 2, d / 2, w / 2, -d / 2, y0, y0 + H, y0, F.NOWIN);
  B.wall(-w / 2, -d / 2, -w / 2, d / 2, y0, y0 + H, y0, F.NOWIN);
  // timber frame: posts & beam on the plaster sides
  B.mat(M.LACQUER, rng.float(), 0, 3).color(o.lacquer ? pal.lacquer : pal.woodDark).ext(1, 0, F.NOWIN, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.boxC(sx * (w / 2), y0, sz * (d / 2), 0.32, H, 0.32, { top: false });
  for (const sx of [-1, 1]) B.box(sx * w / 2 - 0.12, y0 + H - 0.4, -d / 2, sx * w / 2 + 0.12, y0 + H, d / 2, { base: y0 });
  // peristyle columns
  const colsR = o.peristyle ? 1.4 : 0;
  if (colsR) {
    B.mat(M.LACQUER, 0.4, 0, 3).color(pal.lacquer).ext(1, 0, F.NOWIN, 0);
    const nx = Math.max(2, Math.round((w + 2 * colsR) / 2.6)), nz = Math.max(2, Math.round((d + 2 * colsR) / 2.6));
    for (let i = 0; i <= nx; i++) for (const sz of [-1, 1]) {
      const x = -w / 2 - colsR + (i / nx) * (w + 2 * colsR);
      B.cylinder(x, sz * (d / 2 + colsR), 0.24, 0.22, y0, y0 + H + 0.3, { segs: 8 });
      B.mat(M.STONE, 0.4, 0, 3).color(pal.stone); B.cylinder(x, sz * (d / 2 + colsR), 0.36, 0.32, y0, y0 + 0.25, { segs: 8, top: true }); B.mat(M.LACQUER, 0.4, 0, 3).color(pal.lacquer);
    }
    for (let i = 1; i < nz; i++) for (const sx of [-1, 1]) {
      const z = -d / 2 - colsR + (i / nz) * (d + 2 * colsR);
      B.cylinder(sx * (w / 2 + colsR), z, 0.24, 0.22, y0, y0 + H + 0.3, { segs: 8 });
    }
    // architrave (green-blue painted beams with gold accents)
    B.mat(M.LACQUER, 0.6, 0, 3).color(col('#2c5a5a')).ext(1, 0, F.NOWIN, 0);
    B.box(-w / 2 - colsR - 0.2, y0 + H - 0.1, d / 2 + colsR - 0.2, w / 2 + colsR + 0.2, y0 + H + 0.5, d / 2 + colsR + 0.2, { base: y0 });
    B.box(-w / 2 - colsR - 0.2, y0 + H - 0.1, -d / 2 - colsR - 0.2, w / 2 + colsR + 0.2, y0 + H + 0.5, -d / 2 - colsR + 0.2, { base: y0 });
    B.box(-w / 2 - colsR - 0.2, y0 + H - 0.1, -d / 2 - colsR, -w / 2 - colsR + 0.2, y0 + H + 0.5, d / 2 + colsR, { base: y0 });
    B.box(w / 2 + colsR - 0.2, y0 + H - 0.1, -d / 2 - colsR, w / 2 + colsR + 0.2, y0 + H + 0.5, d / 2 + colsR, { base: y0 });
  }
  // bracket sets (dougong) as a dark band under the eaves
  const yE = y0 + H + (colsR ? 0.5 : 0);
  B.mat(M.WOOD, 0.2, 0, 3).color(pal.woodDark).ext(0.6, 0, F.NOWIN, 0);
  B.box(-w / 2 - colsR - 0.35, yE, -d / 2 - colsR - 0.35, w / 2 + colsR + 0.35, yE + 0.45, d / 2 + colsR + 0.35, { base: yE });
  const roofC = o.roofColor || rng.pick(pal.roofs);
  const rx = w / 2 + colsR + 0.2, rz = d / 2 + colsR + 0.2;
  let top;
  const roofOpt = { over: o.over ?? 1.5, curve: 1.8, flare: o.flare ?? 1.1, segS: 8, segR: 5, thick: 0.3, roofMat: [M.TEMPLE_TILE, rng.float(), 0, 3], roofColor: roofC, trimMat: [M.WOOD, 0.3, 0, 3], trimColor: o.lacquer ? pal.lacquer2 : pal.woodDark, ridgeColor: roofC.clone().multiplyScalar(0.8) };
  if (o.double) {
    // lower eave skirt, clerestory, upper roof
    B.curvedRoof(-rx, -rz, rx, rz, yE + 0.45, Math.min(rx, rz) * 0.35, { ...roofOpt, ridge: false, hipK: 0.55 });
    const ux = rx * 0.68, uz = rz * 0.68, uy = yE + 0.45 + Math.min(rx, rz) * 0.32;
    B.mat(M.WOOD, rng.float(), W.LATTICE, 2.2).color(wood).ext(1, 0, 0, 0);
    B.box(-ux + 0.6, uy - 0.6, -uz + 0.6, ux - 0.6, uy + 1.9, uz - 0.6, { top: false, base: uy - 0.6 });
    B.mat(M.WOOD, 0.2, 0, 3).color(pal.woodDark).ext(0.6, 0, F.NOWIN, 0);
    B.box(-ux + 0.3, uy + 1.9, -uz + 0.3, ux - 0.3, uy + 2.3, uz - 0.3);
    top = B.curvedRoof(-ux + 0.3, -uz + 0.3, ux - 0.3, uz - 0.3, uy + 2.3, Math.min(ux, uz) * (o.steep ?? 0.62), { ...roofOpt, over: (o.over ?? 1.5) * 0.85 });
  } else {
    top = B.curvedRoof(-rx, -rz, rx, rz, yE + 0.45, Math.min(rx, rz) * (o.steep ?? 0.58), roofOpt);
  }
  // red lanterns under the eave corners
  if (o.lanterns !== false) {
    for (const [sx, sz] of [[-1, 1], [1, 1]]) paperLantern(ctx, sx * (rx + 0.6), yE - 1.0, sz * (rz + 0.6), pal.lantern, 0.32);
  }
  return { top, H: yE };
}

export function building(ctx, lot) {
  const { rng, pal } = ctx;
  ctx.place(lot.x, lot.z, lot.base, lot.yaw);
  const core = lot.zone < 0.35;
  const w = Math.max(6, lot.w * rng.range(0.8, 0.92) - 1.6), d = Math.max(5, lot.d * rng.range(0.78, 0.9) - 1.6);
  let r;
  const big = lot.w * lot.d > 130;
  if (big && (core || lot.plaza) && rng.chance(0.7)) return compound(ctx, lot);
  if (lot.plaza) r = hall(ctx, w, d, lot, { big: true, peristyle: rng.chance(0.6), double: rng.chance(0.4), lacquer: true, terrace: 1.2 });
  else if (core && rng.chance(0.25)) r = hall(ctx, w, d, lot, { big: true, peristyle: rng.chance(0.5), double: rng.chance(0.3), lacquer: rng.chance(0.6), terrace: 0.9 });
  else r = huiHouse(ctx, w, d, lot, core);
  ctx.collider(0, r.H / 2, 0, w / 2 + 0.8, r.H / 2 + 0.5, d / 2 + 0.8, false);
  ctx.footprints.push({ lot, h: r.top });
}

/** Walled temple compound: white wall with tile coping, roofed gate, hall inside. */
function compound(ctx, lot) {
  const { rng, pal } = ctx, B = ctx.B;
  const W = lot.w * 0.97, D = lot.d * 0.97, H = 2.7, T = 0.5;
  plinth(ctx, W, D, lot, 0.35, M.STONE, pal.stone, 0.05);
  const wall = pal.walls[0];
  const roofC = pal.roofs[0];
  const gw = 3.2;
  const seg = (x0, z0, x1, z1) => {
    const L = Math.hypot(x1 - x0, z1 - z0); if (L < 0.3) return;
    B.mat(M.PLASTER, rng.float(), 0, 3).color(wall).ext(1, 0, F.NOWIN, 0);
    B.slab(x0, z0, x1, z1, T, 0.35, H, { base: 0.35 });
    // grey brick base course and dark tile coping with a little ridge
    B.mat(M.BRICK, rng.float(), 0, 3).color(col('#6e6a64'));
    B.slab(x0, z0, x1, z1, T + 0.06, 0.35, 0.9, { base: 0.35, top: false });
    B.mat(M.TEMPLE_TILE, rng.float(), 0, 3).color(roofC);
    B.slab(x0, z0, x1, z1, T + 0.5, H, H + 0.22, { base: H });
    B.slab(x0, z0, x1, z1, 0.22, H + 0.22, H + 0.48, { base: H });
  };
  const hw = W / 2, hd = D / 2;
  seg(-hw, -hd, hw, -hd); seg(hw, -hd, hw, hd); seg(-hw, -hd, -hw, hd);
  seg(-hw, hd, -gw / 2, hd); seg(gw / 2, hd, hw, hd);
  // gatehouse: two lacquer posts, a curved roof, lanterns
  B.mat(M.LACQUER, 0.4, 0, 3).color(pal.lacquer).ext(1, 0, F.NOWIN, 0);
  for (const sx of [-1, 1]) B.cylinder(sx * (gw / 2 + 0.1), hd, 0.2, 0.18, 0.35, 3.6, { segs: 8 });
  B.mat(M.LACQUER, 0.5, 0, 3).color(col('#2c5a5a'));
  B.box(-gw / 2 - 0.4, 3.3, hd - 0.25, gw / 2 + 0.4, 3.75, hd + 0.25);
  B.curvedRoof(-gw / 2 - 0.3, hd - 0.9, gw / 2 + 0.3, hd + 0.9, 3.75, 1.0, { over: 0.8, curve: 1.6, flare: 0.6, segS: 8, segR: 4, thick: 0.18, roofMat: [M.TEMPLE_TILE, 0.4, 0, 3], roofColor: roofC, trimMat: [M.LACQUER, 0.3, 0, 3], trimColor: pal.lacquer2, ridgeW: 0.3, ridgeH: 0.4 });
  for (const sx of [-1, 1]) paperLantern(ctx, sx * (gw / 2 + 0.2), 2.6, hd + 0.75, pal.lantern, 0.3);
  // the hall within, raised on its own terrace
  const w = Math.max(6, W - 5), d = Math.max(5, D - 6.5);
  const r = hall(ctx, w, d, lot, { big: true, peristyle: rng.chance(0.5), double: rng.chance(0.45), lacquer: true, terrace: 1.3, lanterns: true });
  // courtyard incense burner
  B.mat(M.BRONZE, 0.5, 0, 3).color(col('#4a3a24')).ext(1, 0, F.NOWIN, 0);
  B.lathe(0, hd - 2.2, [[0.3, 0.35], [0.6, 0.6], [0.7, 1.2], [0.5, 1.4], [0.6, 1.5], [0.1, 1.55]], { segs: 10 });
  glow(ctx, 0, 1.4, hd - 2.2, col('#ff8a3a'), 0.4, rng.float());
  for (const [x0, z0, x1, z1] of [[-hw, -hd, hw, -hd], [hw, -hd, hw, hd], [-hw, -hd, -hw, hd]]) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    ctx.collider(cx, H / 2, cz, Math.max(Math.abs(x1 - x0) / 2, T / 2), H / 2 + 0.3, Math.max(Math.abs(z1 - z0) / 2, T / 2), false);
  }
  ctx.collider(-(hw + gw / 2) / 2, H / 2, hd, (hw - gw / 2) / 2, H / 2 + 0.3, T / 2, false);
  ctx.collider((hw + gw / 2) / 2, H / 2, hd, (hw - gw / 2) / 2, H / 2 + 0.3, T / 2, false);
  ctx.collider(0, r.H / 2, 0, w / 2 + 0.8, r.H / 2 + 0.5, d / 2 + 0.8, false);
  ctx.footprints.push({ lot, h: r.top });
}

/** Hui-style house: white plaster, dark tiles, stepped horse-head firewalls, lattice windows. */
function huiHouse(ctx, w, d, lot, core) {
  const { rng, pal } = ctx, B = ctx.B;
  const floors = core ? rng.int(2, 3) : rng.int(1, 2);
  const fh = 3.2, y0 = 0.5, H = floors * fh;
  plinth(ctx, w, d, lot, y0, M.STONE, pal.stone, 0.05);
  const wall = rng.pick(pal.walls).clone().multiplyScalar(rng.range(0.96, 1.04));
  B.mat(M.PLASTER, rng.float(), W.SCREEN, fh).color(wall).ext(1, 0, 0, 0);
  B.box(-w / 2, y0, -d / 2, w / 2, y0 + H, d / 2, { top: false, base: y0, front: F.FRONT });
  // grey brick skirting + dark eave band
  B.mat(M.BRICK, rng.float(), 0, 3).color(col('#6e6a64')).ext(1, 0, F.NOWIN, 0);
  B.box(-w / 2 - 0.04, y0, -d / 2 - 0.04, w / 2 + 0.04, y0 + 0.7, d / 2 + 0.04, { top: false });
  B.mat(M.WOOD, 0.2, 0, 3).color(pal.woodDark).ext(0.7, 0, F.NOWIN, 0);
  B.box(-w / 2 - 0.1, y0 + H - 0.3, -d / 2 - 0.1, w / 2 + 0.1, y0 + H, d / 2 + 0.1);
  // exposed timber frame: corner posts and floor beams (red lacquer in the old core)
  {
    const fc = core && rng.chance(0.45) ? pal.lacquer : pal.woodDark;
    B.mat(M.LACQUER, rng.float(), 0, 3).color(fc).ext(1, 0, F.NOWIN, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.boxC(sx * (w / 2), y0 + 0.7, sz * (d / 2), 0.36, H - 0.7, 0.36, { top: false });
    for (let k = 1; k < floors; k++) B.box(-w / 2 - 0.08, y0 + k * fh - 0.14, -d / 2 - 0.08, w / 2 + 0.08, y0 + k * fh + 0.14, d / 2 + 0.08, { top: false });
    if (w > 7) for (const sx of [-1, 1]) B.boxC(sx * w / 6, y0 + 0.7, d / 2 + 0.05, 0.26, H - 0.7, 0.14, { top: false });
  }
  const roofC = rng.pick(pal.roofs);
  const yE = y0 + H;
  const rise = d * 0.34;
  // dual-pitch curved roof (hip with long ridge), modest flare
  const top = B.curvedRoof(-w / 2, -d / 2, w / 2, d / 2, yE, rise, { over: 1.15, curve: 1.8, flare: 0.95, sweep: 0.5, segS: 7, segR: 4, thick: 0.22, roofMat: [M.TEMPLE_TILE, rng.float(), 0, 3], roofColor: roofC, trimMat: [M.WOOD, 0.3, 0, 3], trimColor: pal.woodDark, ridgeColor: roofC.clone().lerp(col('#b4b0a4'), 0.45), ridgeW: 0.36, ridgeH: 0.4, hipK: 0.25, ornaments: false });
  // stepped horse-head firewalls on both gable ends
  if (rng.chance(core ? 0.75 : 0.45)) {
    for (const sx of [-1, 1]) {
      const steps = rng.int(2, 3);
      for (let k = 0; k < steps; k++) {
        const zr = (d / 2 + 0.4) * (1 - k / steps), y1 = yE + 0.6 + (rise + 1.2) * ((k + 1) / steps);
        B.mat(M.PLASTER, rng.float(), 0, 3).color(wall).ext(1, 0, F.NOWIN, 0);
        B.box(sx * w / 2 - 0.25, yE - 0.3, -zr, sx * w / 2 + 0.25, y1, zr, { top: false });
        B.mat(M.TEMPLE_TILE, rng.float(), 0, 3).color(roofC);
        B.box(sx * w / 2 - 0.42, y1, -zr - 0.25, sx * w / 2 + 0.42, y1 + 0.28, zr + 0.25);
        B.mat(M.TEMPLE_TILE, 0.4, 0, 3).color(roofC.clone().multiplyScalar(0.7));
        for (const sz of [-1, 1]) B.box(sx * w / 2 - 0.2, y1 + 0.28, sz * (zr + 0.25) - 0.18, sx * w / 2 + 0.2, y1 + 0.62, sz * (zr + 0.25) + 0.18);
      }
    }
  }
  if (rng.chance(0.3)) paperLantern(ctx, rng.chance(0.5) ? -1.1 : 1.1, y0 + 2.7, d / 2 + 0.45, pal.lantern, 0.26);
  return { top, H: yE };
}

/** Paifang gate across a road (plan point, yaw = road direction). */
function paifang(ctx, x, z, yaw, span) {
  const { pal, rng } = ctx;
  const fp = ctx.frame.footprint(x, z, span, 3, yaw, 3);
  ctx.place(x, z, fp.min, yaw + Math.PI / 2);
  const B = ctx.B;
  const H = 6.5 + span * 0.15;
  B.mat(M.LACQUER, rng.float(), 0, 3).color(pal.lacquer).ext(1, 0, F.NOWIN, 0);
  const xs = [-span / 2, -span / 6, span / 6, span / 2];
  for (const px of xs) {
    B.mat(M.STONE, 0.5, 0, 3).color(pal.stone); B.boxC(px, -0.5, 0, 1.0, 1.3, 1.0);
    B.mat(M.LACQUER, 0.5, 0, 3).color(pal.lacquer);
    B.cylinder(px, 0, 0.32, 0.3, 0.8, Math.abs(px) < span / 3 ? H : H * 0.8, { segs: 10 });
  }
  B.mat(M.LACQUER, 0.6, 0, 3).color(col('#2c5a5a'));
  B.box(-span / 2 - 0.6, H - 1.2, -0.35, span / 2 + 0.6, H - 0.6, 0.35);
  B.mat(M.GOLD, 0.3, 0, 3).color(pal.gold);
  B.box(-span / 6 + 0.3, H - 2.5, -0.2, span / 6 - 0.3, H - 1.3, 0.2);
  B.mat(M.LACQUER, 0.6, 0, 3).color(pal.lacquer);
  B.box(-span / 2 - 0.4, H * 0.8 - 1.1, -0.3, span / 2 + 0.4, H * 0.8 - 0.6, 0.3);
  const roofC = pal.roofs[0];
  const ro = { over: 0.9, curve: 1.6, flare: 0.7, segS: 8, segR: 4, thick: 0.2, roofMat: [M.TEMPLE_TILE, 0.3, 0, 3], roofColor: roofC, trimMat: [M.LACQUER, 0.3, 0, 3], trimColor: pal.lacquer2, ridgeW: 0.3, ridgeH: 0.4 };
  B.curvedRoof(-span / 6 - 0.4, -0.5, span / 6 + 0.4, 0.5, H - 0.6, 1.0, ro);
  for (const s of [-1, 1]) B.curvedRoof(s * span / 3 - span / 6 - 0.2, -0.45, s * span / 3 + span / 6 + 0.2, 0.45, H * 0.8 - 0.6, 0.8, { ...ro, ornaments: false });
  paperLantern(ctx, -span / 6 + 0.6, H - 2.9, 0.6, pal.lantern, 0.36);
  paperLantern(ctx, span / 6 - 0.6, H - 2.9, 0.6, pal.lantern, 0.36);
  ctx.collider(-span / 2, H / 2, 0, 0.5, H / 2, 0.5, false);
  ctx.collider(span / 2, H / 2, 0, 0.5, H / 2, 0.5, false);
}

/** Great pagoda (landmark). */
export function pagoda(ctx, x, z, tiers = 9) {
  const { pal, rng } = ctx;
  ctx.useTile('landmark');
  const fp = ctx.frame.footprint(x, z, 30, 30, 0, 4);
  const yaw = Math.atan2(ctx.plan.center[0] - x, ctx.plan.center[1] - z);
  ctx.place(x, z, fp.max, yaw);
  const B = ctx.B;
  // stepped stone base
  plinth(ctx, 26, 26, { low: fp.min, base: fp.max }, 1.0, M.STONE, pal.stone, 0);
  B.mat(M.STONE, 0.4, 0, 3).color(pal.stone.clone().multiplyScalar(1.1)).ext(0.95, 0, F.NOWIN, 0);
  B.box(-10, 1.0, -10, 10, 2.6, 10);
  stair(ctx, -3, 3, 17, 13, 0, 1.0, M.STONE, pal.stone);
  stair(ctx, -2.5, 2.5, 13, 10, 1.0, 2.6, M.STONE, pal.stone);
  let y = 2.6, s = 15;
  for (let t = 0; t < tiers; t++) {
    const h = t === 0 ? 8 : 5.4 - t * 0.14;
    const hw = s / 2;
    B.mat(M.WOOD, rng.float(), W.LATTICE, h).color(t === 0 ? pal.lacquer : pal.wood).ext(1, 0, 0, 0);
    B.box(-hw, y, -hw, hw, y + h, hw, { top: false, base: y, front: F.FRONT });
    if (t > 0) {
      // walk-around balcony with a red railing (reads as a bright line between the dark roofs)
      const bw = hw + 1.3;
      B.mat(M.WOOD, 0.3, 0, 3).color(pal.woodDark).ext(0.8, 0, F.NOWIN, 0);
      B.box(-bw, y - 0.3, -bw, bw, y + 0.05, bw);
      B.mat(M.LACQUER, 0.4, 0, 3).color(pal.lacquer).ext(1, 0, F.NOWIN, 0);
      B.box(-bw, y + 0.95, bw - 0.12, bw, y + 1.1, bw + 0.02); B.box(-bw, y + 0.95, -bw - 0.02, bw, y + 1.1, -bw + 0.12);
      B.box(bw - 0.12, y + 0.95, -bw, bw + 0.02, y + 1.1, bw); B.box(-bw - 0.02, y + 0.95, -bw, -bw + 0.12, y + 1.1, bw);
      const np = Math.max(3, Math.round(bw * 2 / 1.6));
      for (let k = 0; k <= np; k++) {
        const u = -bw + (k / np) * bw * 2;
        B.boxC(u, y + 0.05, bw - 0.05, 0.1, 0.95, 0.1, { top: false }); B.boxC(u, y + 0.05, -bw + 0.05, 0.1, 0.95, 0.1, { top: false });
        B.boxC(bw - 0.05, y + 0.05, u, 0.1, 0.95, 0.1, { top: false }); B.boxC(-bw + 0.05, y + 0.05, u, 0.1, 0.95, 0.1, { top: false });
      }
    }
    // bracket (dougong) band under the eaves: gold-lit blocks on a dark beam
    B.mat(M.LACQUER, 0.5, 0, 3).color(col('#2c5a5a')).ext(0.8, 0, F.NOWIN, 0);
    B.box(-hw - 0.3, y + h - 0.7, -hw - 0.3, hw + 0.3, y + h, hw + 0.3, { top: false });
    B.mat(M.LACQUER, 0.3, 0, 3).color(pal.lacquer).ext(1, 0, F.NOWIN, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.boxC(sx * hw, y, sz * hw, 0.5, h, 0.5, { top: false });
    B.mat(M.WOOD, 0.2, 0, 3).color(pal.woodDark).ext(0.6, 0, F.NOWIN, 0);
    B.box(-hw - 0.5, y + h, -hw - 0.5, hw + 0.5, y + h + 0.6, hw + 0.5);
    const over = 3.0 - t * 0.14;
    B.curvedRoof(-hw - 0.4, -hw - 0.4, hw + 0.4, hw + 0.4, y + h + 0.6, 1.6, { over, curve: 1.9, flare: 1.5, sweep: 1.0, segS: 10, segR: 5, thick: 0.35, roofMat: [M.TEMPLE_TILE, rng.float(), 0, 3], roofColor: pal.roofs[0], trimMat: [M.LACQUER, 0.3, 0, 3], trimColor: pal.lacquer2, ridge: false, hipK: 0.3 });
    // corner bells / lanterns
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) glow(ctx, sx * (hw + over + 0.7), y + h + 0.9, sz * (hw + over + 0.7), pal.lamp, 0.6, rng.float());
    // balcony rail on the tier above
    y += h + 0.6 + 1.2;
    s *= 0.89;
  }
  // spire
  B.mat(M.BRONZE, 0.4, 0, 3).color(col('#6a5030')).ext(1, 0, F.NOWIN, 0);
  B.cylinder(0, 0, 0.5, 0.3, y - 1.2, y + 9, { segs: 8 });
  for (let i = 0; i < 7; i++) B.lathe(0, 0, [[0.05, y + 1 + i * 1.05], [0.9 - i * 0.07, y + 1.25 + i * 1.05], [0.05, y + 1.5 + i * 1.05]], { segs: 10 });
  B.mat(M.GOLD, 0.3, 0, 3).color(pal.gold);
  B.lathe(0, 0, [[0.02, y + 9], [0.7, y + 9.6], [0.5, y + 10.4], [0.02, y + 11.6]], { segs: 10 });
  glow(ctx, 0, y + 10.4, 0, pal.lamp, 1.6, 0.0);
  ctx.collider(0, y / 2, 0, 7, y / 2, 7, false);
  ctx.useTile(null);
  ctx.landmarkSpots.push({ x, z, h: fp.max + y + 11, kind: 'pagoda', title: 'The Nine-Storey Pagoda' });
  ctx.poiAt(x, z, fp.max + 3, 40, 'landmark', 'The Nine-Storey Pagoda');
  return fp.max;
}

/** A pilgrims' stair of lanterns and stone landings zig-zagging down the cliff from a high shrine to the town. */
function cliffStair(ctx, x, z, top) {
  const f = ctx.frame, c = ctx.plan.center, pal = ctx.pal;
  const bottom = Math.max(f.hAt(c[0], c[1]), f.sea + 1);
  if (top - bottom < 24) return;
  const a0 = Math.atan2(c[1] - z, c[0] - x);
  const n = Math.min(70, Math.floor((top - bottom) / 3.2));
  for (let i = 1; i < n; i++) {
    const t = i / n, y = top - t * (top - bottom) - 1.5;
    const a = a0 + Math.sin(t * Math.PI * 4.0) * 0.55;
    let r = 10, found = false;
    for (; r < 320; r += 1.5) if (f.hAt(x + Math.cos(a) * r, z + Math.sin(a) * r) < y) { found = true; break; }
    if (!found) continue;
    const px = x + Math.cos(a) * (r + 0.8), pz = z + Math.sin(a) * (r + 0.8);
    ctx.place(px, pz, y, -a + Math.PI / 2);
    const B = ctx.B;
    B.mat(M.STONE, (i * 0.137) % 1, 0, 3).color(pal.stone).ext(0.9, 0, F.NOWIN, 0);
    B.boxC(0, -0.45, 0, 2.6, 0.45, 2.0);
    B.boxC(0, -3.2, 0, 1.4, 2.75, 1.0, { top: false });
    if (i % 2 === 0) {
      B.mat(M.LACQUER, 0.4, 0, 3).color(pal.woodDark).ext(1, 0, F.NOWIN, 0);
      B.boxC(1.1, 0, 0.8, 0.12, 2.2, 0.12, { top: false });
      paperLantern(ctx, 1.1, 1.75, 1.05, i % 6 === 0 ? pal.lamp : pal.lantern, 0.34);
      glow(ctx, 1.1, 1.95, 1.05, i % 6 === 0 ? pal.lamp : pal.lantern, 1.5, (i * 0.618) % 1);
    }
  }
}

export function plaza(ctx, pz) {
  const { rng, pal } = ctx;
  if (pz.kind === 'main') {
    // bronze incense burner (ding) + stone lanterns + banners
    const fr = ctx.frame;
    ctx.place(pz.x, pz.z, fr.hAt(pz.x, pz.z), 0);
    const B = ctx.B;
    B.mat(M.STONE, 0.5, 0, 3).color(pal.stone).ext(0.95, 0, F.NOWIN, 0);
    B.boxC(0, -0.3, 0, 4.2, 0.8, 4.2);
    B.mat(M.BRONZE, 0.5, 0, 3).color(col('#4a3a24'));
    B.lathe(0, 0, [[0.6, 0.5], [1.4, 0.8], [1.6, 1.8], [1.3, 2.3], [1.45, 2.45], [0.3, 2.5]], { segs: 16 });
    for (let k = 0; k < 3; k++) { const a = k / 3 * TAU; B.cylinder(Math.cos(a) * 1.1, Math.sin(a) * 1.1, 0.18, 0.14, 0.5, 1.0, { segs: 6 }); }
    B.mat(M.BRONZE, 0.5, 0, 3).color(col('#4a3a24'));
    B.lathe(0, 0, [[1.2, 2.5], [0.9, 3.3], [0.3, 3.9], [0.05, 4.6]], { segs: 12 });
    glow(ctx, 0, 2.6, 0, col('#ff8a3a'), 1.3, 0.5);
    ctx.occupy(pz.x, pz.z, 3.5);
    const n = Math.max(6, Math.floor(pz.r / 3));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + 0.2;
      lampPost(ctx, pz.x + Math.cos(a) * (pz.r - 1.5), pz.z + Math.sin(a) * (pz.r - 1.5), 'paper');
    }
    // tall vertical banners
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.6;
      const x = pz.x + Math.cos(a) * pz.r * 0.62, z = pz.z + Math.sin(a) * pz.r * 0.62;
      ctx.place(x, z, fr.hAt(x, z), 0);
      ctx.B.mat(M.WOOD, 0.4, 0, 3).color(pal.woodDark).ext(1, 0, F.NOWIN, 0);
      ctx.B.cylinder(0, 0, 0.09, 0.07, -0.3, 9, { segs: 6 });
      ctx.B.box(-0.05, 8.7, -0.05, 1.2, 8.8, 0.05);
      flag(ctx, 0.08, 8.6, 0, 1.0, 5.5, pal.cloth[i % 2], rng.float() * TAU, false);
    }
    // a few market stalls at the edge
    for (let i = 0; i < 5; i++) {
      const a = rng.range(0, TAU), r = pz.r * rng.range(0.55, 0.8);
      const x = pz.x + Math.cos(a) * r, z = pz.z + Math.sin(a) * r;
      if (!ctx.free(x, z, 1.8, true)) continue;
      stall(ctx, x, z, a + Math.PI / 2, rng.pick([pal.cloth[0], pal.cloth[3], col('#d8b06a')]));
      ctx.occupy(x, z, 3.2);
    }
  } else {
    lampPost(ctx, pz.x, pz.z, 'paper');
  }
}

export function extras(ctx) {
  const { plan, rng, pal } = ctx;
  const q = ctx.settlement.level.engine.quality;
  plantTrees(ctx, q.pick(40, 80, 150, 200) * (ctx.main ? 1 : 0.5), ['maple', 'maple', 'maple', 'round'], [col('#b8322a'), col('#c8442a'), col('#d8642a'), col('#a82a22'), col('#e8a83a'), col('#3f5a34')], foliageBlob);
  for (const r of plan.roads) if (r.kind === 'avenue' || r.kind === 'main') roadLamps(ctx, r, 16, 'paper', 1.0);
  // red paper lantern strings strung across the lanes of the old town
  for (const r of plan.roads) if (r.kind === 'main' || r.kind === 'street') lanternStrings(ctx, r, r.kind === 'main' ? 14 : 22, [pal.lantern, pal.lantern, col('#ff8a3a')], { n: 6, h: 5.2, sag: 0.9, scale: 0.55, core: 0.55 });
  // gates where main roads leave the plaza and at the edge of town
  for (const r of plan.mains || []) {
    const pts = r.pts;
    for (const idx of [Math.min(4, pts.length - 2), Math.floor(pts.length * 0.75)]) {
      if (idx < 1 || idx >= pts.length) continue;
      const [x, z] = pts[idx], [x0, z0] = pts[idx - 1];
      const yaw = Math.atan2(x - x0, z - z0);
      if (!rng.chance(idx < 6 ? 0.9 : 0.5)) continue;
      paifang(ctx, x, z, yaw, r.w + 3);
    }
  }
  // garden walls around field plots (white walls with tile caps)
  for (const f of plan.fields) {
    if (!rng.chance(0.3)) continue;
    const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
    const corner = (u, v) => [f.x + u * c + v * s, f.z - u * s + v * c];
    const hw = f.w / 2 + 1, hd = f.d / 2 + 1;
    const pts = [];
    for (let t = 0; t <= 1.001; t += 0.1) pts.push(corner(-hw + 2 * hw * t, hd));
    lowWall(ctx, pts, 1.6, 0.5, M.PLASTER, pal.walls[0]);
  }
  for (const dk of plan.docks) {
    ctx.place(dk.x, dk.z, ctx.frame.sea, dk.yaw);
    const B = ctx.B;
    B.mat(M.WOOD, 0.4, 0, 3).color(pal.wood).ext(0.95, 0, F.NOWIN, 0);
    B.box(-1.5, 0.9, 0, 1.5, 1.15, dk.len);
    for (let zz = 1; zz < dk.len; zz += 3) for (const sx of [-1, 1]) B.cylinder(sx * 1.4, zz, 0.15, 0.15, -3, 1.2, { segs: 6 });
    boat(B, 3, 0.15, dk.len * 0.6, rng, pal);
  }
}

export function landmark(ctx) {
  const { plan, rng } = ctx;
  // the pagoda on the highest nearby spot that is not too far
  const spot = plan.spots.find((s) => s.r > plan.builtRadius * 0.3 && s.r < plan.builtRadius * 0.95) || plan.spots.find((s) => s.r < plan.builtRadius * 1.4) || plan.spots[0];
  if (spot) { const top = pagoda(ctx, spot.x, spot.z, 11); ctx.occupy(spot.x, spot.z, 24); try { cliffStair(ctx, spot.x, spot.z, top); } catch (e) { console.warn('[civ] cliff stair', e); } }
  // the guardian at the end of the processional avenue
  const av = plan.mains?.[0];
  if (av && av.pts.length > 6) {
    const [x, z] = av.pts[av.pts.length - 1];
    const [x0, z0] = av.pts[av.pts.length - 4];
    const L = Math.hypot(x - x0, z - z0) || 1;
    const gx = x + (x - x0) / L * 24, gz = z + (z - z0) / L * 24;
    if (!ctx.frame.wet(gx, gz)) colossus(ctx, gx, gz, rng.range(38, 50), M.STONE, col('#8a8678'), 0);
  }
}

export function reserve(ctx, radius) { void ctx; void radius; return []; }
