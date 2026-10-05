// Procedural vehicle models.
//
//  buildShip()  — "Swordfish" racer: homage to Cowboy Bebop's Swordfish II —
//                 slim red monocoque, long lance nose, bubble canopy, swept
//                 anhedral wings with tip engine pods, canted twin tails, one big
//                 rear engine. Retractable tricycle gear.
//  buildBike()  — "Kaneda" hover bike: Akira-style low red fairing body with the
//                 wheels replaced by glowing repulsor discs, Star Wars speeder
//                 steering vanes, Bebop-grade wear.
//
// Hull parts are merged per material (paint / metal / glass / emissive), so a
// vehicle is ~5 draw calls. Convention: +Z forward, +Y up, +X left.

import * as THREE from 'three';
import { loft, lathe, plate, box, cyl, finish, merge, mirrorX, col } from './Geo.js';
import { Random } from '../core/Random.js';

const mesh = (geo, mat, shadow = true) => {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = shadow; m.receiveShadow = shadow;
  return m;
};

// ------------------------------------------------------------------------------------------
// Starship
// ------------------------------------------------------------------------------------------
export function buildShip(M, { seed = 1, livery = 0 } = {}) {
  const rng = new Random(seed);
  const L = [
    { red: '#a3121a', dark: '#24262b', light: '#d8d2c4', trim: '#c9a35a' },
    { red: '#1d5d8f', dark: '#22252a', light: '#e2ddd0', trim: '#d08a3a' },
    { red: '#d9d4c8', dark: '#2b2d31', light: '#a3121a', trim: '#5b6066' },
  ][livery % 3];
  const RED = col(L.red), DARK = col(L.dark), LIGHT = col(L.light), TRIM = col(L.trim);
  const GUN = col('#3a3d42'), STEEL = col('#8d9096');
  const paint = [], metal = [], glass = [], hot = [], cool = [];

  // ---- fuselage: red top, charcoal belly, a cream cheat-line along the flank
  const hull = (x, y, z, nx, ny, nz, out) => {
    if (y < -0.28 + z * 0.02) return out.copy(DARK);
    if (y < -0.12 + z * 0.02 && z > -3.6) return out.copy(LIGHT);
    return out.copy(RED);
  };
  paint.push(finish(loft([
    { z: -4.95, w: 0.56, h: 0.58, y: 0.06, n: 2.2 },
    { z: -4.5, w: 0.74, h: 0.74, y: 0.08, n: 2.6 },
    { z: -3.4, w: 0.88, h: 0.84, y: 0.1, n: 3.0 },
    { z: -2.0, w: 0.9, h: 0.84, y: 0.08, n: 3.0, top: 1.04 },
    { z: -0.6, w: 0.82, h: 0.78, y: 0.04, n: 2.9 },
    { z: 0.8, w: 0.68, h: 0.66, y: 0.0, n: 2.7 },
    { z: 2.1, w: 0.53, h: 0.5, y: -0.04, n: 2.5 },
    { z: 3.2, w: 0.38, h: 0.35, y: -0.08, n: 2.3 },
    { z: 4.05, w: 0.22, h: 0.21, y: -0.1, n: 2.1 },
    { z: 4.45, w: 0.1, h: 0.1, y: -0.1, n: 2 },
  ], { seg: 40 }), hull, 0.42));

  // dorsal spine from canopy to the engine
  paint.push(finish(loft([
    { z: -4.3, w: 0.16, h: 0.12, y: 0.8, n: 2.2 },
    { z: -3.0, w: 0.3, h: 0.22, y: 0.86, n: 2.6 },
    { z: -1.2, w: 0.36, h: 0.24, y: 0.82, n: 2.6 },
    { z: 0.0, w: 0.3, h: 0.18, y: 0.72, n: 2.4 },
    { z: 0.4, w: 0.12, h: 0.08, y: 0.66, n: 2 },
  ], { seg: 20 }), RED, 0.42));

  // canopy: tinted bubble with a metal frame ring and a center bow
  const can = new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, 0, Math.PI * 0.56);
  can.scale(0.44, 0.44, 1.2); can.translate(0, 0.5, 1.25);
  glass.push(finish(can, 0xffffff, 1));
  const frame = new THREE.TorusGeometry(1, 0.035, 6, 48); frame.rotateX(Math.PI / 2); frame.scale(0.45, 1, 1.21); frame.translate(0, 0.53, 1.25);
  metal.push(finish(frame, GUN, 1));
  const bow = new THREE.TorusGeometry(1, 0.03, 6, 40, Math.PI); bow.rotateY(Math.PI / 2); bow.scale(1, 0.46, 1.2); bow.translate(0, 0.5, 1.25);
  metal.push(finish(bow, GUN, 1));

  // nose lance (the swordfish bill) with collars
  metal.push(finish(cyl([0, -0.1, 4.3], [0, -0.1, 7.3], 0.075, 0.03, 12), STEEL, 2));
  metal.push(finish(cyl([0, -0.1, 4.35], [0, -0.1, 4.7], 0.13, 0.11, 14), GUN, 2));
  metal.push(finish(cyl([0, -0.1, 5.4], [0, -0.1, 5.52], 0.085, 0.085, 12), TRIM, 2));
  // chin sensor + twin under-nose guns
  for (const s of [1, -1]) metal.push(finish(cyl([0.32 * s, -0.42, 1.6], [0.32 * s, -0.42, 3.4], 0.045, 0.035, 8), GUN, 2));

  // rear engine: big nacelle, nozzle with petals, intake lips
  metal.push(finish(lathe([[0.001, -5.95], [0.42, -5.95], [0.5, -5.75], [0.6, -5.35], [0.66, -4.9], [0.6, -4.5], [0.001, -4.5]], 36), GUN, 1));
  metal.push(finish(lathe([[0.36, -5.96], [0.4, -5.96], [0.4, -5.6], [0.36, -5.6]], 36), DARK, 1));
  const hotDisk = new THREE.CircleGeometry(0.36, 32); hotDisk.rotateY(Math.PI); hotDisk.translate(0, 0.06, -5.9);
  // side intakes
  for (const s of [1, -1]) {
    const intake = loft([
      { z: -3.6, w: 0.18, h: 0.3, x: 0.86 * s, y: 0.12, n: 3 },
      { z: -2.0, w: 0.22, h: 0.34, x: 0.95 * s, y: 0.1, n: 3.2 },
      { z: -1.2, w: 0.2, h: 0.3, x: 0.93 * s, y: 0.06, n: 3.2 },
    ], { seg: 20 });
    paint.push(finish(intake, (x, y, z, nx, ny, nz, o) => o.copy(z > -1.25 && nz > 0.6 ? DARK : RED), 0.5));
    metal.push(finish(box(0.08, 0.5, 0.04, 1.02 * s, 0.07, -1.16), col('#0b0c0e'), 1));
  }

  // ---- wings: swept, slight anhedral, two-tone with a cream band
  const wingPlan = [[0.7, -0.4], [4.25, -3.15], [4.42, -3.3], [4.45, -4.5], [4.1, -4.55], [0.7, -3.6]];
  const wingPaint = (x, y, z, nx, ny, nz, o) => {
    const ax = Math.abs(x);
    if (ny < -0.5) return o.copy(ax > 3.35 && ax < 3.75 ? LIGHT : DARK);
    if (ax > 3.35 && ax < 3.75) return o.copy(LIGHT);
    return o.copy(RED);
  };
  const wingR = plate(wingPlan, 0.16, 0.05);
  wingR.rotateZ(-0.12); wingR.translate(0, -0.08, 0);
  paint.push(finish(wingR.clone(), wingPaint, 0.42), finish(mirrorX(wingR), wingPaint, 0.42));
  // wing leading-edge root fairings (blend wing into the body)
  for (const s of [1, -1]) {
    paint.push(finish(loft([
      { z: -3.6, w: 0.1, h: 0.08, x: 0.85 * s, y: -0.12, n: 2 },
      { z: -2.2, w: 0.3, h: 0.14, x: 0.95 * s, y: -0.12, n: 2.4 },
      { z: -0.6, w: 0.12, h: 0.06, x: 0.85 * s, y: -0.1, n: 2 },
    ], { seg: 16 }), RED, 0.42));
  }
  // wingtip engine pods
  const tipX = 4.42, tipY = -0.62;
  for (const s of [1, -1]) {
    const pod = lathe([[0.001, -5.25], [0.13, -5.25], [0.17, -5.05], [0.2, -4.4], [0.19, -3.4], [0.12, -2.75], [0.001, -2.6]], 20);
    pod.translate(tipX * s, tipY, 0);
    paint.push(finish(pod, (x, y, z, nx, ny, nz, o) => o.copy(z < -4.9 ? GUN : z > -3.1 ? LIGHT : RED), 1));
    const ring = new THREE.CircleGeometry(0.11, 16); ring.rotateY(Math.PI); ring.translate(tipX * s, tipY, -5.27);
    hot.push(ring);
    // tip fin
    const fin = plate([[0, -3.9], [0.0, -5.0], [0.55, -5.2], [0.62, -4.8]], 0.05, 0.02);
    fin.rotateZ(-Math.PI / 2); fin.translate(tipX * s, tipY + 0.05, 0);
    paint.push(finish(fin, DARK, 1));
  }
  // canards
  const canard = plate([[0.42, 2.7], [1.35, 1.85], [1.4, 1.6], [0.42, 1.75]], 0.07, 0.025);
  canard.rotateZ(-0.05); canard.translate(0, -0.12, 0);
  paint.push(finish(canard.clone(), RED, 0.5), finish(mirrorX(canard), RED, 0.5));

  // twin canted tails + ventral fin
  for (const s of [1, -1]) {
    const tail = plate([[0, -2.5], [0, -4.85], [1.35, -5.35], [1.5, -4.85]], 0.08, 0.03);
    tail.rotateZ(Math.PI / 2 - 0.32); // stand it up, cant outward
    if (s < 0) tail.scale(-1, 1, 1);
    tail.translate(0.42 * s, 0.68, 0);
    const t2 = s < 0 ? flipWinding(tail) : tail;
    paint.push(finish(t2, (x, y, z, nx, ny, nz, o) => o.copy(y > 1.75 ? LIGHT : RED), 0.5));
  }
  const vent = plate([[0, -3.0], [0, -4.7], [0.75, -4.95], [0.7, -4.4]], 0.07, 0.025);
  vent.rotateZ(-Math.PI / 2); vent.translate(0, -0.6, 0);
  paint.push(finish(vent, DARK, 0.5));

  // ---- greebles: spine hatches, antenna, vents, sensor blisters
  for (let k = 0; k < 9; k++) {
    const z = rng.range(-3.9, -0.6), w = rng.range(0.08, 0.2), d = rng.range(0.15, 0.5);
    metal.push(finish(box(w, 0.05, d, rng.range(-0.12, 0.12), 0.98 + Math.sin(z) * 0.02, z), rng.chance(0.5) ? GUN : DARK, 2));
  }
  metal.push(finish(cyl([0.18, 0.95, -3.6], [0.24, 1.5, -4.0], 0.012, 0.006, 5), STEEL, 2));
  for (const s of [1, -1]) {
    metal.push(finish(new THREE.SphereGeometry(0.11, 12, 8).scale(1, 0.6, 1.6).translate(0.62 * s, -0.42, 0.6), GUN, 2));
    for (let k = 0; k < 4; k++) metal.push(finish(box(0.02, 0.1, 0.22, 0.9 * s, 0.3, -3.0 - k * 0.3), col('#0d0e10'), 2));
  }

  // ---- landing gear (own group: animated)
  const gear = new THREE.Group();
  const gearParts = [];
  const leg = (x, z, len) => {
    gearParts.push(finish(cyl([x, -0.5, z], [x, -0.5 - len, z], 0.07, 0.06, 10), STEEL, 2));
    gearParts.push(finish(cyl([x, -0.65, z + 0.04], [x, -0.5 - len * 0.6, z + 0.2], 0.03, 0.03, 6), GUN, 2));
    gearParts.push(finish(cyl([x, -0.5 - len, z], [x, -0.5 - len - 0.08, z], 0.24, 0.26, 16), GUN, 2));
  };
  leg(0, 2.6, 1.1); leg(1.0, -2.4, 1.12); leg(-1.0, -2.4, 1.12);
  gear.add(mesh(merge(gearParts), M.metal));

  // ---- assemble
  const group = new THREE.Group();
  group.add(mesh(merge(paint), M.paint));
  group.add(mesh(merge(metal), M.metal));
  const gl = mesh(merge(glass), M.glass); gl.castShadow = true; group.add(gl);
  group.add(gear);
  const hotM = M.glow('#ffb36b', 14);
  const hotMesh = new THREE.Mesh(merge([finish(hotDisk), ...hot.map((h) => finish(h))]), hotM);
  group.add(hotMesh);

  // nav lights: port red (+X = left), starboard green, white tail strobes, warm landing lights
  const lights = new THREE.Group();
  const bulb = (hex, k, x, y, z, r = 0.06) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), M.glow(hex, k)); m.position.set(x, y, z); lights.add(m); return m; };
  const navL = bulb('#ff2a1a', 30, tipX, tipY + 0.2, -3.0), navR = bulb('#1aff6a', 30, -tipX, tipY + 0.2, -3.0);
  const strobes = [bulb('#ffffff', 60, 0.95, 2.1, -5.3, 0.05), bulb('#ffffff', 60, -0.95, 2.1, -5.3, 0.05)];
  const landing = [bulb('#ffe2b0', 25, 0, -0.62, 2.0, 0.08)];
  bulb('#7fd6ff', 6, 0, 0.36, 1.1, 0.12); // cockpit instrument glow (under the glass)
  group.add(lights);

  return {
    group, gear, hotMat: hotM, lights: { navL, navR, strobes, landing },
    nozzles: [
      { pos: new THREE.Vector3(0, 0.06, -5.92), r: 0.4, len: 4.2 },
      { pos: new THREE.Vector3(tipX, tipY, -5.28), r: 0.12, len: 1.8 },
      { pos: new THREE.Vector3(-tipX, tipY, -5.28), r: 0.12, len: 1.8 },
    ],
    wingtips: [new THREE.Vector3(tipX + 0.15, tipY, -4.6), new THREE.Vector3(-tipX - 0.15, tipY, -4.6)],
    gearHeight: 1.72, length: 13, radius: 6.5,
  };
}

function flipWinding(g) {
  g = g.index ? g.toNonIndexed() : g;
  for (const attr of Object.values(g.attributes)) {
    const s = attr.itemSize, a = attr.array;
    for (let i = 0; i < attr.count; i += 3) for (let k = 0; k < s; k++) { const t = a[(i + 1) * s + k]; a[(i + 1) * s + k] = a[(i + 2) * s + k]; a[(i + 2) * s + k] = t; }
  }
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------------------------------
// Hover bike
// ------------------------------------------------------------------------------------------
export function buildBike(M, { seed = 1, livery = 0 } = {}) {
  const rng = new Random(seed);
  const L = [
    { body: '#b0131b', dark: '#1d1f23', light: '#e4ddcf', accent: '#f2c14a' },
    { body: '#e6e0d3', dark: '#202227', light: '#c0392b', accent: '#2fa3c8' },
    { body: '#1f6a73', dark: '#1b1d21', light: '#e4ddcf', accent: '#ff8a3c' },
    { body: '#2a2d33', dark: '#141518', light: '#c9a35a', accent: '#ff3b6b' },
  ][livery % 4];
  const BODY = col(L.body), DARK = col(L.dark), LIGHT = col(L.light), ACC = col(L.accent), GUN = col('#3a3d42'), STEEL = col('#9a9da3');
  const paint = [], metal = [], glass = [];

  // main body: high front fairing, waisted seat, tall tail cowl
  const bodyPaint = (x, y, z, nx, ny, nz, o) => {
    if (y < 0.42) return o.copy(DARK);
    if (Math.abs(y - 0.55) < 0.035 && z > -1.5) return o.copy(LIGHT); // pin stripe
    return o.copy(BODY);
  };
  paint.push(finish(loft([
    { z: -1.78, w: 0.16, h: 0.2, y: 0.68, n: 2.2 },
    { z: -1.55, w: 0.33, h: 0.36, y: 0.66, n: 2.8 },
    { z: -1.05, w: 0.39, h: 0.4, y: 0.62, n: 3.0, top: 1.05 },
    { z: -0.5, w: 0.3, h: 0.27, y: 0.6, n: 2.8 },
    { z: 0.05, w: 0.27, h: 0.26, y: 0.62, n: 2.6 },
    { z: 0.6, w: 0.37, h: 0.4, y: 0.66, n: 3.0, top: 1.12 },
    { z: 1.2, w: 0.4, h: 0.44, y: 0.62, n: 3.0 },
    { z: 1.65, w: 0.3, h: 0.32, y: 0.56, n: 2.6 },
    { z: 1.95, w: 0.12, h: 0.14, y: 0.5, n: 2.2 },
  ], { seg: 36 }), bodyPaint, 0.9));
  // seat
  paint.push(finish(loft([
    { z: -1.15, w: 0.2, h: 0.08, y: 1.0, n: 3 },
    { z: -0.75, w: 0.21, h: 0.08, y: 0.9, n: 3 },
    { z: -0.15, w: 0.19, h: 0.06, y: 0.86, n: 3 },
    { z: 0.15, w: 0.12, h: 0.05, y: 0.9, n: 3 },
  ], { seg: 20 }), col('#16171a'), 2));
  // windscreen
  const ws = new THREE.SphereGeometry(1, 28, 12, 0, Math.PI * 2, 0, Math.PI * 0.5);
  ws.scale(0.3, 0.22, 0.48); ws.rotateX(-0.45); ws.translate(0, 1.04, 0.9);
  glass.push(finish(ws, 0xffffff, 1));
  // front & rear repulsor housings (where Akira's wheels were)
  const pods = [[1.05, 0.44], [-1.15, 0.47]];
  for (const [z, r] of pods) {
    const h = lathe([[0.001, -0.14], [r * 0.82, -0.14], [r, -0.06], [r * 1.02, 0.05], [r * 0.9, 0.14], [0.001, 0.14]], 32);
    h.rotateX(Math.PI / 2); h.scale(0.62, 1, 1); h.translate(0, 0.3, z);
    metal.push(finish(h, GUN, 1.5));
  }
  // rear thruster
  metal.push(finish(lathe([[0.001, -2.05], [0.17, -2.05], [0.22, -1.95], [0.25, -1.7], [0.2, -1.45], [0.001, -1.45]], 24).translate(0, 0.72, 0), GUN, 1.5));
  // handlebars & controls
  for (const s of [1, -1]) {
    metal.push(finish(cyl([0.08 * s, 1.0, 0.45], [0.46 * s, 1.03, 0.3], 0.025, 0.022, 8), STEEL, 3));
    metal.push(finish(cyl([0.4 * s, 1.03, 0.32], [0.55 * s, 1.03, 0.27], 0.035, 0.035, 8), col('#111214'), 3));
    // footpegs
    metal.push(finish(cyl([0.25 * s, 0.42, -0.4], [0.42 * s, 0.42, -0.42], 0.025, 0.025, 6), STEEL, 3));
    // speeder vanes
    const vane = plate([[0, 0.55], [0, 1.6], [0.04, 1.75], [0.16, 0.6]], 0.03, 0.01);
    vane.rotateZ(-Math.PI / 2); vane.translate(0.42 * s, 0.68, 0);
    paint.push(finish(vane, LIGHT, 2));
    // side panel greebles
    for (let k = 0; k < 3; k++) metal.push(finish(box(0.02, 0.06, 0.18, 0.37 * s, 0.6 + k * 0.08, -1.05 + rng.range(-0.05, 0.05)), DARK, 3));
  }
  metal.push(finish(box(0.16, 0.08, 0.14, 0, 1.06, 0.48), DARK, 3)); // dash
  // accent badge on the nose
  paint.push(finish(new THREE.SphereGeometry(0.07, 12, 8).scale(1, 1, 0.4).translate(0, 0.9, 1.7), ACC, 3));

  const group = new THREE.Group();
  group.add(mesh(merge(paint), M.paint));
  group.add(mesh(merge(metal), M.metal));
  group.add(mesh(merge(glass), M.glass));

  // repulsor glow discs underneath + rings
  const hoverM = M.glow('#6fe4ff', 8);
  const discs = [];
  for (const [z, r] of pods) {
    const ring = new THREE.TorusGeometry(r * 0.72, 0.03, 6, 40); ring.rotateX(Math.PI / 2); ring.scale(0.62, 1, 1); ring.translate(0, 0.15, z);
    const d = new THREE.CircleGeometry(r * 0.5, 24); d.rotateX(Math.PI / 2); d.scale(0.62, 1, 1); d.translate(0, 0.155, z);
    discs.push(ring, d);
  }
  const hoverMesh = new THREE.Mesh(merge(discs.map((g) => finish(g))), hoverM);
  group.add(hoverMesh);
  const tailM = M.glow('#ff3a2a', 30);
  const tail = new THREE.Mesh(merge([finish(box(0.34, 0.04, 0.02, 0, 0.82, -1.79)), finish(new THREE.CircleGeometry(0.14, 20).rotateY(Math.PI).translate(0, 0.72, -2.06))]), tailM);
  group.add(tail);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 6).scale(1.6, 0.6, 0.5).translate(0, 0.82, 1.92), M.glow('#fff1d6', 40));
  group.add(head);
  return {
    group, hoverMat: hoverM,
    nozzles: [{ pos: new THREE.Vector3(0, 0.72, -2.06), r: 0.15, len: 1.6 }],
    pods: pods.map(([z]) => new THREE.Vector3(0, 0.15, z)),
    seat: new THREE.Vector3(0, 0.84, -0.45), length: 4, radius: 2.2,
  };
}
