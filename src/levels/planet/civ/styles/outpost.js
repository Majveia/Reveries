// Outpost — Starfield / NASA-punk frontier: modular habs with strip windows,
// vertical tank habs, pressurised tubes, comms masts with blinking beacons,
// solar arrays, container stacks, landing pads with parked ships, floodlit
// work yards, and a skyhook tether rising into orbit.

import * as THREE from 'three';
import { M, W, F, G } from '../ids.js';
import { col, glow, plinth, lampPost, roadLamps, crates, TAU } from '../kit.js';
import { spaceElevator } from '../landmarks.js';

export function palette(A, rng) {
  const P = A?.palette || {};
  void rng;
  return {
    panels: ['#d6dade', '#c9cdd1', '#e2e4e4', '#b8bec4', '#d8d2c6'].map(col),
    dark: col('#2e3238'), mid: col('#6a7078'),
    accents: [P.accent || '#ff8a2a', '#e8c22a', '#2a6ab8', '#c83a2a', '#3a8a5a'].map(col),
    stone: col('#7a7a78'), stoneDark: col('#5a5a58'), wood: col('#5a4a3a'), trim: col('#e8e8e4'), iron: col('#2a2c30'),
    lamp: col(P.lights || '#cfe6ff'), warm: col('#ffcf87'), accent: col(P.accent || '#ff8a2a'),
    cloth: [P.accent || '#ff8a2a', '#2a6ab8', '#e8e8e4'].map(col),
    ground: { main: col('#5a5c5e'), street: col('#6a6a68'), lane: col('#7a746a'), plaza: col('#6e7072'), dirt: col('#7a7266') },
    metal: col('#8a9098'),
  };
}

export function roadMat(road) { return road.kind === 'avenue' ? G.DECK : road.kind === 'street' ? G.GRAVEL : G.GRAVEL; }
export const plazaMat = () => G.DECK;
export const shotSun = 0.07;
export const shot = { dist: 1.0, height: 35, sunAngle: 1.6, lmLift: 0.18, fov: 58 };

function legs(B, w, d, h, color) {
  B.mat(M.METAL, 0.3, 0, 3).color(color).ext(0.9, 0, F.NOWIN, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    B.boxC(sx * (w / 2 - 0.5), -1.2, sz * (d / 2 - 0.5), 0.35, h + 1.2, 0.35);
    B.boxC(sx * (w / 2 - 0.5), -1.2, sz * (d / 2 - 0.5), 1.1, 0.3, 1.1);
  }
}

function hab(ctx, w, d, h, y0, color) {
  const { rng, pal } = ctx, B = ctx.B;
  B.mat(M.METAL, rng.float(), W.STRIP, 3.2).color(color).ext(1, 0, 0, 0);
  B.box(-w / 2, y0, -d / 2, w / 2, y0 + h, d / 2, { base: y0, front: F.FRONT, topMat: [M.METAL, rng.float(), 0, 3] });
  // chamfer rails & roof edge
  B.mat(M.METAL, 0.3, 0, 3).color(pal.dark).ext(1, 0, F.NOWIN, 0);
  B.box(-w / 2 - 0.12, y0 + h - 0.25, -d / 2 - 0.12, w / 2 + 0.12, y0 + h + 0.1, d / 2 + 0.12, { base: y0 + h - 0.25 });
  B.box(-w / 2 - 0.12, y0 - 0.1, -d / 2 - 0.12, w / 2 + 0.12, y0 + 0.2, d / 2 + 0.12, { base: y0 - 0.1 });
}

export function building(ctx, lot) {
  const { rng, pal } = ctx;
  ctx.place(lot.x, lot.z, lot.base, lot.yaw);
  const B = ctx.B;
  const w = Math.max(6, lot.w * rng.range(0.75, 0.92)), d = Math.max(5, lot.d * rng.range(0.7, 0.9));
  const color = rng.pick(pal.panels).clone().multiplyScalar(rng.range(0.9, 1.03));
  const r = rng.float();
  let top;
  const y0 = 0.9;
  if (r < 0.5 || lot.plaza) {
    // stacked modular habs on legs
    legs(B, w, d, y0, pal.mid);
    const h1 = rng.range(3.2, 3.8);
    hab(ctx, w, d, h1, y0, color);
    top = y0 + h1;
    if (rng.chance(lot.zone < 0.4 ? 0.7 : 0.35)) {
      const w2 = w * rng.range(0.55, 0.8), d2 = d * rng.range(0.6, 0.9), ox = rng.range(-1, 1) * (w - w2) / 2;
      ctx.place(lot.x, lot.z, lot.base, lot.yaw);
      ctx.B.setMatrix(ctx.M.clone().multiply(new THREE.Matrix4().makeTranslation(ox, 0, 0)));
      hab(ctx, w2, d2, rng.range(3, 3.4), top + 0.1, rng.pick(pal.panels));
      top += 3.4;
      ctx.place(lot.x, lot.z, lot.base, lot.yaw);
    }
    // accent stripe band (painted)
    B.mat(M.METAL, 0.9, 0, 3).color(rng.pick(pal.accents)).ext(1, 0, F.NOWIN, 0);
    B.box(-w / 2 - 0.03, y0 + 0.5, d / 2, -w / 2 + 1.2, y0 + 2.8, d / 2 + 0.04, { base: y0, top: false });
    // airlock
    B.mat(M.METAL, 0.4, W.PORTHOLE, 2.6).color(pal.panels[3]).ext(1, 0, 0, 0);
    B.box(-1.1, y0, d / 2, 1.1, y0 + 2.8, d / 2 + 1.8, { base: y0, front: F.NOWIN });
    B.mat(M.EMISSIVE, 0.2, 0, 3).color(pal.lamp);
    B.box(-0.7, y0 + 2.9, d / 2 + 1.6, 0.7, y0 + 3.0, d / 2 + 1.85);
    glow(ctx, 0, y0 + 2.7, d / 2 + 2.0, pal.lamp, 0.5, rng.float());
    // ramp
    B.mat(M.METAL, 0.3, 0, 3).color(pal.mid).ext(1, 0, F.NOWIN, 0);
    B.quadP(new THREE.Vector3(-0.9, -0.1, d / 2 + 4.2), new THREE.Vector3(0.9, -0.1, d / 2 + 4.2), new THREE.Vector3(0.9, y0, d / 2 + 1.8), new THREE.Vector3(-0.9, y0, d / 2 + 1.8), [0, 0], [1.8, 0], [1.8, 2.5], [0, 2.5], new THREE.Vector3(0, 1, 0));
  } else if (r < 0.72) {
    // vertical tank hab: cylinder with domed roof and a ring of portholes
    const R = Math.min(w, d) * 0.45, H = rng.range(6, 11);
    plinth(ctx, R * 2.2, R * 2.2, lot, 0.4, M.CONCRETE, pal.stone, 0);
    B.mat(M.METAL, rng.float(), W.PORTHOLE, 3.4).color(color).ext(1, 0, 0, 0);
    B.cylinder(0, 0, R, R, 0.4, H, { segs: 20, base: 0.4, flags: F.FRONT });
    B.mat(M.METAL, 0.2, 0, 3).color(pal.dark).ext(1, 0, F.NOWIN, 0);
    for (const y of [0.4, H * 0.5, H]) B.cylinder(0, 0, R + 0.12, R + 0.12, y - 0.15, y + 0.15, { segs: 20 });
    B.mat(M.METAL, rng.float(), 0, 3).color(color);
    B.dome(0, H, 0, R, { rings: 5, segs: 20, sy: 0.55 });
    top = H + R * 0.55;
    // comms dish on top
    if (rng.chance(0.5)) dish(ctx, 0, top, 0, rng.range(1.5, 3), pal);
  } else if (r < 0.86) {
    // barrel-vault hangar
    const R = Math.min(w / 2, 8), L = d;
    plinth(ctx, w, d, lot, 0.3, M.CONCRETE, pal.stone, 0);
    const M0 = ctx.M.clone();
    B.setMatrix(M0.clone().multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
    B.mat(M.METAL, rng.float(), 0, 3).color(color).ext(1, 0, F.NOWIN, 0);
    B.cylinder(0, 0, R, R, -L / 2, L / 2, { segs: 16, a0: Math.PI, a1: TAU, smooth: false });
    B.setMatrix(M0);
    // end walls with big doors
    B.mat(M.METAL, 0.5, 0, 3).color(pal.dark).ext(1, 0, F.NOWIN, 0);
    B.cylinder(0, L / 2, R, R, 0.3, 0.31, { segs: 2 });
    const pts = [];
    for (let i = 0; i <= 16; i++) { const a = Math.PI * (i / 16); pts.push(new THREE.Vector3(Math.cos(a) * R, 0.3 + Math.sin(a) * R, L / 2)); }
    for (let i = 0; i < 16; i++) B.triP(new THREE.Vector3(0, 0.3, L / 2), pts[i], pts[i + 1], [0, 0], [1, 0], [1, 1]);
    for (let i = 0; i < 16; i++) B.triP(new THREE.Vector3(0, 0.3, -L / 2), pts[i + 1].clone().setZ(-L / 2), pts[i].clone().setZ(-L / 2), [0, 0], [1, 0], [1, 1]);
    B.mat(M.EMISSIVE, 0.2, 0, 3).color(pal.warm.clone().multiplyScalar(0.6));
    B.box(-R * 0.6, 0.3, L / 2 + 0.02, R * 0.6, R * 0.75, L / 2 + 0.05, { top: false, sides: [true, false, false, false] });
    glow(ctx, 0, R * 0.8, L / 2 + 0.6, pal.warm, 0.9, rng.float());
    top = R + 0.3;
  } else {
    // container yard
    plinth(ctx, w, d, lot, 0.15, M.CONCRETE, pal.stone, 0);
    const nx = Math.max(1, Math.floor(w / 6.4)), nz = Math.max(1, Math.floor(d / 2.6));
    top = 0;
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const stack = rng.int(1, 3);
      for (let k = 0; k < stack; k++) {
        if (rng.chance(0.15)) break;
        B.mat(M.METAL, rng.float(), 0, 3).color(rng.pick(pal.accents).clone().multiplyScalar(rng.range(0.6, 1))).ext(0.95, 0, F.NOWIN, 0);
        const x = -w / 2 + 3.2 + i * 6.4, z = -d / 2 + 1.3 + j * 2.6;
        B.boxC(x, 0.15 + k * 2.6, z, 6.0, 2.55, 2.4);
        top = Math.max(top, 0.15 + (k + 1) * 2.6);
      }
    }
    crates(ctx, w / 2 - 1, 0.15, d / 2 + 1, 3);
  }
  // roof gear: antenna / solar / vent
  if (r < 0.5 && rng.chance(0.6)) {
    const rg = rng.float();
    if (rg < 0.4) solar(ctx, rng.range(-w / 4, w / 4), top + 0.15, rng.range(-d / 4, d / 4), 4, 2.4, pal);
    else if (rg < 0.7) mast(ctx, w / 2 - 0.8, top, -d / 2 + 0.8, rng.range(5, 10), pal);
    else { B.mat(M.METAL, 0.3, 0, 3).color(pal.mid).ext(1, 0, F.NOWIN, 0); B.boxC(rng.range(-w / 4, w / 4), top, rng.range(-d / 4, d / 4), 1.6, 1.1, 1.6); }
  }
  ctx.collider(0, top / 2, 0, w / 2, top / 2 + 0.3, d / 2, true);
  ctx.footprints.push({ lot, h: top });
}

function dish(ctx, x, y, z, r, pal) {
  const B = ctx.B;
  B.mat(M.METAL, 0.3, 0, 3).color(pal.mid).ext(1, 0, F.NOWIN, 0);
  B.cylinder(x, z, 0.15, 0.12, y, y + r * 0.8, { segs: 6 });
  B.mat(M.METAL, 0.4, 0, 3).color(pal.panels[0]);
  B.lathe(x, z, [[0.05, y + r * 0.7], [r * 0.6, y + r * 0.8], [r, y + r * 1.15]], { segs: 16 });
  B.lathe(x, z, [[r, y + r * 1.15], [r * 0.6, y + r * 0.82], [0.05, y + r * 0.72]], { segs: 16 });
}

function solar(ctx, x, y, z, w, d, pal) {
  const B = ctx.B;
  B.mat(M.METAL, 0.3, 0, 3).color(pal.mid).ext(1, 0, F.NOWIN, 0);
  B.boxC(x, y, z, 0.2, 0.9, 0.2);
  B.mat(M.SOLAR, 0.4, 0, 3).color(col('#14203a'));
  const p0 = new THREE.Vector3(x - w / 2, y + 0.7, z - d / 2), p1 = new THREE.Vector3(x + w / 2, y + 0.7, z - d / 2), p2 = new THREE.Vector3(x + w / 2, y + 1.5, z + d / 2), p3 = new THREE.Vector3(x - w / 2, y + 1.5, z + d / 2);
  B.quadP(p0, p1, p2, p3, [0, 0], [w, 0], [w, d], [0, d], new THREE.Vector3(0, 1, -0.3));
}

function mast(ctx, x, y, z, h, pal) {
  const B = ctx.B;
  B.mat(M.METAL, 0.3, 0, 3).color(pal.panels[0]).ext(1, 0, F.NOWIN, 0);
  B.cylinder(x, z, 0.1, 0.05, y, y + h, { segs: 5 });
  for (let i = 1; i < 4; i++) B.boxC(x, y + h * i / 4, z, 1.2 - i * 0.25, 0.05, 0.05);
  ctx.beacons.push({ position: new THREE.Vector3(x, y + h + 0.2, z).applyMatrix4(ctx.M), color: col('#ff3020'), scale: 0.45, phase: 2.0 + ctx.rng.float() });
}

/** Landing pad with markings + a parked ship (plan point). */
function pad(ctx, x, z, R, withShip) {
  const { rng, pal } = ctx;
  const fp = ctx.frame.footprint(x, z, R * 2, R * 2, 0, 4);
  const yaw = rng.float() * TAU;
  ctx.place(x, z, fp.max + 0.6, yaw);
  const B = ctx.B;
  B.mat(M.CONCRETE, 0.3, 0, 3).color(pal.stone).ext(0.9, 0, F.NOWIN, 0);
  B.cylinder(0, 0, R + 0.5, R + 0.2, fp.min - fp.max - 1.5, 0, { segs: 8, smooth: false });
  // pad surface drawn by the ground material (markings) — register for ground pass
  const cx = x, cz = z, h = fp.max + 0.6;
  (ctx.groundExtra ||= []).push((Gb) => {
    padDisc(Gb, ctx.frame, cx, cz, R, h, pal);
  });
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    glow(ctx, Math.cos(a) * (R + 0.2), 0.2, Math.sin(a) * (R + 0.2), k % 2 ? col('#ffb030') : pal.lamp, 0.35, 2.2 + k * 0.12);
  }
  // floodlight masts
  for (const s of [-1, 1]) {
    B.mat(M.METAL, 0.3, 0, 3).color(pal.mid).ext(1, 0, F.NOWIN, 0);
    B.cylinder(s * (R + 2.5), 0, 0.18, 0.12, 0, 12, { segs: 6 });
    B.boxC(s * (R + 2.5), 12, 0, 1.6, 0.5, 0.6);
    glow(ctx, s * (R + 2.2), 12, 0, pal.lamp, 1.1, 0);
    ctx.beacons.push({ position: new THREE.Vector3(s * (R + 2.5), 12.8, 0).applyMatrix4(ctx.M), color: col('#ff3020'), scale: 0.5, phase: 2.0 + rng.float() });
  }
  if (withShip) ship(B, 0, 0, 0, rng.range(14, 20), pal, rng);
  ctx.collider(0, -0.3, 0, R, 0.3, R, true);
}

function padDisc(Gb, frame, cx, cz, R, h, pal) {
  // flat (not draped) pad top at height h, uv local for markings
  const segs = 32, rings = 4;
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  Gb.color(pal.ground.plaza);
  const se = Gb.e[1]; Gb.e[1] = R;
  const start = Gb.n;
  for (let j = 0; j <= rings; j++) for (let i = 0; i < segs; i++) {
    const a = (i / segs) * TAU, rr = (j / rings) * R;
    const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
    frame.point(x, z, h, p); frame.upAt(x, z, n);
    Gb.mat(G.PAD, 0.5, 0.5, 0);
    Gb.v(p.x, p.y, p.z, n.x, n.y, n.z, x - cx, z - cz);
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < segs; i++) {
    const a = start + j * segs + i, b = start + j * segs + (i + 1) % segs;
    Gb.quad(a, b, b + segs, a + segs);
  }
  Gb.e[1] = se;
}

/** A parked/landing ship (local), nose +Z. Also used by traffic. */
export function ship(B, x, y, z, L, pal, rng) {
  const hull = pal.panels[0], dark = pal.dark;
  B.mat(M.METAL, rng.float(), W.STRIP, 2.4).color(hull).ext(1, 0, 0, 0);
  // fuselage (lathe along local Z via rotation trick: build along Y then rotate)
  const M0 = B.m.clone();
  const R = new THREE.Matrix4().makeTranslation(x, y + L * 0.16, z).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  B.setMatrix(M0.clone().multiply(R));
  B.lathe(0, 0, [[L * 0.05, -L * 0.5], [L * 0.11, -L * 0.42], [L * 0.12, -L * 0.1], [L * 0.1, L * 0.2], [L * 0.06, L * 0.38], [0.05, L * 0.5]], { segs: 12 });
  B.setMatrix(M0);
  // wings / nacelles
  B.mat(M.METAL, rng.float(), 0, 3).color(pal.panels[3]).ext(1, 0, F.NOWIN, 0);
  B.box(x - L * 0.36, y + L * 0.12, z - L * 0.28, x + L * 0.36, y + L * 0.16, z + L * 0.02);
  for (const s of [-1, 1]) {
    B.mat(M.METAL, 0.3, 0, 3).color(dark);
    B.cylinder(x + s * L * 0.36, z - L * 0.15, L * 0.05, L * 0.05, y + L * 0.06, y + L * 0.22, { segs: 8, top: true });
    B.mat(M.METAL, 0.9, 0, 3).color(pal.accent);
    B.box(x + s * L * 0.2 - 0.3, y + L * 0.16, z - L * 0.25, x + s * L * 0.2 + 0.3, y + L * 0.17, z - L * 0.02);
    // landing struts
    B.mat(M.METAL, 0.3, 0, 3).color(dark);
    B.boxC(x + s * L * 0.18, y, z - L * 0.15, 0.25, L * 0.12, 0.25);
  }
  B.boxC(x, y, z + L * 0.3, 0.25, L * 0.1, 0.25);
  // cockpit glass
  B.mat(M.GLASS, 0.3, 0, 3).color(col('#0a1018'));
  B.box(x - L * 0.05, y + L * 0.22, z + L * 0.22, x + L * 0.05, y + L * 0.26, z + L * 0.34);
  // tail fin
  B.mat(M.METAL, 0.4, 0, 3).color(hull);
  B.box(x - 0.15, y + L * 0.22, z - L * 0.48, x + 0.15, y + L * 0.38, z - L * 0.3);
}

export function plaza(ctx, pz) {
  const { pal } = ctx;
  if (pz.kind === 'main') {
    // central comms tower
    const fr = ctx.frame;
    ctx.place(pz.x, pz.z, fr.hAt(pz.x, pz.z), 0);
    const B = ctx.B;
    B.mat(M.CONCRETE, 0.3, 0, 3).color(pal.stone).ext(0.95, 0, F.NOWIN, 0);
    B.boxC(0, -0.5, 0, 5, 1.2, 5);
    B.mat(M.METAL, 0.3, 0, 3).color(pal.panels[0]);
    const H = 32;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) B.tube([new THREE.Vector3(sx * 2, 0.6, sz * 2), new THREE.Vector3(sx * 0.4, H, sz * 0.4)], 0.14, 4);
    for (let i = 1; i < 10; i++) { const y = i * H / 10, s = 2 - 1.6 * (y / H); B.box(-s, y - 0.05, -s, s, y + 0.05, s); }
    dish(ctx, 0, H * 0.55, 1.6, 2.4, pal);
    dish(ctx, 0, H * 0.75, -1.2, 1.6, pal);
    ctx.beacons.push({ position: new THREE.Vector3(0, H + 0.5, 0).applyMatrix4(ctx.M), color: col('#ff3020'), scale: 0.9, phase: 2.0 });
    ctx.occupy(pz.x, pz.z, 4);
    const n = Math.max(4, Math.floor(pz.r / 5));
    for (let i = 0; i < n; i++) { const a = (i / n) * TAU; lampPost(ctx, pz.x + Math.cos(a) * (pz.r - 1.2), pz.z + Math.sin(a) * (pz.r - 1.2), 'tech'); }
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * TAU + 0.4;
      const x = pz.x + Math.cos(a) * pz.r * 0.6, z = pz.z + Math.sin(a) * pz.r * 0.6;
      ctx.place(x, z, fr.hAt(x, z), a);
      crates(ctx, 0, 0, 0, 4);
    }
  } else lampPost(ctx, pz.x, pz.z, 'tech');
}

/** Landing pads on flat ground around a settlement (also used by spaceports of any style). */
export function pads(ctx, want) {
  const { plan, rng } = ctx;
  const pal0 = ctx.pal;
  if (!pal0.panels) ctx.pal = { ...palette(ctx.A, rng), ...pal0, panels: palette(ctx.A, rng).panels, dark: col('#2e3238'), mid: col('#6a7078'), accents: palette(ctx.A, rng).accents, warm: col('#ffcf87') };
  let n = 0;
  for (let k = 0; k < 60 && n < want; k++) {
    const a = rng.range(0, TAU), r = plan.builtRadius * rng.range(0.85, 1.25);
    const x = plan.center[0] + Math.cos(a) * r, z = plan.center[1] + Math.sin(a) * r;
    const R = rng.range(13, 17);
    const fp = ctx.frame.footprint(x, z, R * 2, R * 2, 0, 3);
    if (fp.wet > 0 || fp.max - fp.min > 6) continue;
    if (!ctx.free(x, z, R + 3)) continue;
    pad(ctx, x, z, R, rng.chance(0.6));
    ctx.occupy(x, z, R + 4);
    (ctx.pads ||= []).push({ x, z, R, h: fp.max + 0.6 });
    n++;
  }
  ctx.pal = pal0;
}

export function extras(ctx) {
  const { plan, rng } = ctx;
  for (const r of plan.roads) if (r.kind === 'avenue') roadLamps(ctx, r, 20, 'tech', 1.0);
  pads(ctx, ctx.main ? 4 : 2);
  // solar farm
  for (let k = 0; k < 30; k++) {
    const a = rng.range(0, TAU), r = plan.builtRadius * rng.range(1.0, 1.3);
    const x = plan.center[0] + Math.cos(a) * r, z = plan.center[1] + Math.sin(a) * r;
    if (!ctx.free(x, z, 4)) continue;
    ctx.place(x, z, ctx.frame.hAt(x, z), a);
    solar(ctx, 0, 0, 0, 6, 3, ctx.pal);
    ctx.occupy(x, z, 4);
  }
}

export function landmark(ctx) {
  const { plan, rng } = ctx;
  let best = null;
  for (let k = 0; k < 40; k++) {
    const a = rng.range(0, TAU), r = plan.builtRadius * rng.range(0.5, 1.0);
    const x = plan.center[0] + Math.cos(a) * r, z = plan.center[1] + Math.sin(a) * r;
    const fp = ctx.frame.footprint(x, z, 60, 60, 0, 3);
    if (fp.wet > 0) continue;
    const sc = -(fp.max - fp.min) - (ctx.free(x, z, 30) ? 0 : 20);
    if (!best || sc > best.sc) best = { x, z, sc };
  }
  if (best) { spaceElevator(ctx, best.x, best.z); ctx.occupy(best.x, best.z, 34); }
}

export function reserve(ctx) { void ctx; return []; }
