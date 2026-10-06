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
    { red: '#b0141c', dark: '#1d1f24', light: '#e2d9c6', trim: '#c9a35a' },
    { red: '#1d5d8f', dark: '#22252a', light: '#e2ddd0', trim: '#d08a3a' },
    { red: '#d9d4c8', dark: '#2b2d31', light: '#a3121a', trim: '#5b6066' },
  ][livery % 3];
  const RED = col(L.red), DARK = col(L.dark), LIGHT = col(L.light), TRIM = col(L.trim);
  const GUN = col('#3a3d42'), STEEL = col('#a4a8ae'), BLACK0 = col('#0b0c0e');
  const paint = [], metal = [], glass = [], hot = [];
  const UVS = 0.42; // ≈2.4 m of hull per atlas tile

  // ---- fuselage: slim lance-nosed monocoque; red top, charcoal belly, cream cheat line + nose band
  const hull = (x, y, z, nx, ny, nz, out) => {
    const keel = -0.1 + z * 0.012;
    if (y < keel) return out.copy(DARK);
    if (Math.abs(y - keel - 0.07) < 0.035 && z > -4.0 && z < 4.0) return out.copy(LIGHT);
    if (z > 2.55 && z < 3.0) return out.copy(LIGHT);
    if (z > 3.0 && z < 3.08) return out.copy(DARK);
    return out.copy(RED);
  };
  paint.push(finish(loft([
    { z: -4.95, w: 0.5, h: 0.52, y: 0.06, n: 2.2 },
    { z: -4.5, w: 0.7, h: 0.7, y: 0.08, n: 2.6 },
    { z: -3.4, w: 0.84, h: 0.8, y: 0.1, n: 3.0 },
    { z: -2.0, w: 0.82, h: 0.78, y: 0.08, n: 3.0, top: 1.04 },
    { z: -0.6, w: 0.68, h: 0.66, y: 0.04, n: 2.8 },
    { z: 0.6, w: 0.54, h: 0.54, y: 0.0, n: 2.6 },
    { z: 1.8, w: 0.44, h: 0.44, y: -0.04, n: 2.4 },
    { z: 3.0, w: 0.33, h: 0.32, y: -0.07, n: 2.2 },
    { z: 4.0, w: 0.2, h: 0.2, y: -0.1, n: 2.1 },
    { z: 4.45, w: 0.11, h: 0.11, y: -0.1, n: 2 },
  ], { seg: 44 }), hull, UVS));

  // dorsal spine from the canopy to the engine
  paint.push(finish(loft([
    { z: -4.3, w: 0.16, h: 0.12, y: 0.8, n: 2.2 },
    { z: -3.0, w: 0.3, h: 0.22, y: 0.86, n: 2.6 },
    { z: -1.4, w: 0.34, h: 0.22, y: 0.8, n: 2.6 },
    { z: -0.3, w: 0.3, h: 0.2, y: 0.6, n: 2.4 },
    { z: 0.0, w: 0.12, h: 0.08, y: 0.5, n: 2 },
  ], { seg: 24 }), RED, UVS));

  // canopy: big clear bubble well forward, framed, with a sill
  const CZ = 1.25, CY = 0.3;
  const can = new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.56);
  can.scale(0.5, 0.52, 1.55); can.translate(0, CY, CZ);
  glass.push(finish(can, 0xffffff, 1));
  const frame = new THREE.TorusGeometry(1, 0.04, 8, 64); frame.rotateX(Math.PI / 2); frame.scale(0.5, 1, 1.56); frame.translate(0, CY + 0.02, CZ);
  metal.push(finish(frame, GUN, 1));
  const bow = new THREE.TorusGeometry(1, 0.032, 6, 48, Math.PI); bow.rotateY(Math.PI / 2); bow.scale(1, 0.53, 0.62); bow.translate(0, CY, CZ - 0.25);
  metal.push(finish(bow, GUN, 1));
  // pilot: seat back, torso, helmet with a lit visor; instrument coaming glows under the glass
  metal.push(finish(box(0.36, 0.5, 0.1, 0, 0.52, 0.42), DARK, 2));
  paint.push(finish(new THREE.SphereGeometry(0.2, 12, 10).scale(1.1, 1.0, 0.8).translate(0, 0.46, 0.66), col('#3b4048'), 2));
  paint.push(finish(new THREE.SphereGeometry(0.15, 16, 12).scale(1, 1.08, 1.1).translate(0, 0.76, 0.72), LIGHT, 2));
  glass.push(finish(new THREE.SphereGeometry(0.1, 12, 8).scale(1.15, 0.6, 0.7).translate(0, 0.77, 0.81), 0xffffff, 2));
  metal.push(finish(box(0.62, 0.12, 0.3, 0, 0.4, 1.75), DARK, 2));

  // nose lance (the swordfish bill): thick root, collars, muzzle
  metal.push(finish(cyl([0, -0.1, 4.3], [0, -0.1, 7.0], 0.115, 0.05, 16), STEEL, 2));
  metal.push(finish(cyl([0, -0.1, 4.3], [0, -0.1, 4.8], 0.19, 0.16, 18), GUN, 2));
  metal.push(finish(cyl([0, -0.1, 5.5], [0, -0.1, 5.66], 0.12, 0.115, 14), TRIM, 2));
  metal.push(finish(cyl([0, -0.1, 6.95], [0, -0.1, 7.4], 0.08, 0.065, 12), GUN, 2));
  hot.push(finish(cyl([0, -0.1, 7.4], [0, -0.1, 7.42], 0.045, 0.045, 10), col('#6fdcff', 0.12), 1, 0, 0));
  for (const s of [1, -1]) metal.push(finish(cyl([0.3 * s, -0.36, 1.4], [0.3 * s, -0.36, 3.4], 0.05, 0.04, 8), GUN, 2));

  // rear engine: nacelle with a deep open bell; the cavity glows (hot material)
  metal.push(finish(lathe([[0.001, -5.5], [0.34, -5.5], [0.44, -5.93], [0.5, -5.97], [0.56, -5.8], [0.62, -5.35], [0.66, -4.9], [0.6, -4.5], [0.001, -4.5]], 40), GUN, 1));
  metal.push(finish(lathe([[0.61, -5.42], [0.645, -5.42], [0.645, -5.3], [0.61, -5.3]], 40), TRIM, 1));
  const cavity = (r0, r1, z0, z1, segs = 36) => {
    const d = new THREE.CircleGeometry(r0, segs); d.rotateY(Math.PI); d.translate(0, 0, z0 - 0.005);
    hot.push(finish(d, col('#ffffff', 1.6), 1, 0, 0));
    const wall = lathe([[r1 - 0.006, z1 + 0.01], [r0 - 0.004, z0 - 0.004]], segs);
    // inner wall: white-hot at the floor fading to orange at the lip
    hot.push(finish(wall, (x, y, z, nx, ny, nz, o) => o.setRGB(1.0, 0.55, 0.28).lerp(_white, THREE.MathUtils.clamp((z - z1) / (z0 - z1), 0, 1) ** 2), 1, 0, 0));
  };
  { const g0 = hot.length; cavity(0.34, 0.44, -5.5, -5.93); for (let i = g0; i < hot.length; i++) hot[i].translate(0, 0.06, 0); }
  // shift nacelle parts onto the engine axis (y = 0.06)
  for (const g of metal.slice(-2)) g.translate(0, 0.06, 0);

  // side intakes
  for (const s of [1, -1]) {
    const intake = loft([
      { z: -3.6, w: 0.18, h: 0.3, x: 0.84 * s, y: 0.12, n: 3 },
      { z: -2.0, w: 0.22, h: 0.34, x: 0.92 * s, y: 0.1, n: 3.2 },
      { z: -1.0, w: 0.2, h: 0.3, x: 0.86 * s, y: 0.06, n: 3.2 },
    ], { seg: 20 });
    paint.push(finish(intake, (x, y, z, nx, ny, nz, o) => o.copy(z > -1.05 && nz > 0.6 ? BLACK0 : y < 0.0 ? DARK : RED), UVS));
  }

  // ---- wings: big swept planform, anhedral, cream band near the tip
  const tipX = 5.1, tipA = 0.12, tipY = -0.08 - tipX * Math.sin(tipA);
  const wingPlan = [[0.65, -0.3], [4.95, -3.35], [5.12, -3.5], [5.15, -4.9], [4.75, -4.95], [0.65, -3.95]];
  const wingPaint = (x, y, z, nx, ny, nz, o) => {
    const ax = Math.abs(x);
    const band = ax > 3.75 && ax < 4.2;
    if (ny < -0.5) return o.copy(band ? LIGHT : DARK);
    if (band) return o.copy(LIGHT);
    return o.copy(RED);
  };
  const wingR = plate(wingPlan, 0.18, 0.06);
  wingR.rotateZ(-tipA); wingR.translate(0, -0.08, 0);
  paint.push(finish(wingR.clone(), wingPaint, UVS), finish(mirrorX(wingR), wingPaint, UVS));
  // wing-root fairings
  for (const s of [1, -1]) {
    paint.push(finish(loft([
      { z: -3.9, w: 0.1, h: 0.08, x: 0.8 * s, y: -0.12, n: 2 },
      { z: -2.2, w: 0.32, h: 0.16, x: 0.9 * s, y: -0.12, n: 2.4 },
      { z: -0.4, w: 0.12, h: 0.06, x: 0.75 * s, y: -0.1, n: 2 },
    ], { seg: 16 }), RED, UVS));
  }
  // wingtip engine pods: bold two-tone (cream intake cowl, red body, gunmetal tail) with glowing bells
  for (const s of [1, -1]) {
    const pod = lathe([[0.001, -5.2], [0.16, -5.2], [0.21, -5.5], [0.25, -5.53], [0.29, -5.2], [0.3, -4.4], [0.29, -3.2], [0.22, -2.3], [0.1, -1.95], [0.001, -1.88]], 28);
    pod.translate(tipX * s, tipY, 0);
    paint.push(finish(pod, (x, y, z, nx, ny, nz, o) => o.copy(z < -4.75 ? GUN : z > -2.85 ? LIGHT : z > -3.05 ? DARK : RED), 0.8));
    const g0 = hot.length; cavity(0.16, 0.21, -5.2, -5.5, 20);
    for (let i = g0; i < hot.length; i++) hot[i].translate(tipX * s, tipY, 0);
    // tip fin
    const fin = plate([[0, -3.9], [0.0, -5.1], [0.62, -5.35], [0.7, -4.9]], 0.06, 0.02);
    fin.rotateZ(-Math.PI / 2); fin.translate(tipX * s, tipY + 0.05, 0);
    paint.push(finish(fin, DARK, 1));
  }
  // canards
  const canard = plate([[0.38, 2.7], [1.35, 1.85], [1.4, 1.6], [0.38, 1.75]], 0.07, 0.025);
  canard.rotateZ(-0.05); canard.translate(0, -0.12, 0);
  paint.push(finish(canard.clone(), RED, 0.5), finish(mirrorX(canard), RED, 0.5));

  // twin canted tails + ventral fin
  for (const s of [1, -1]) {
    const tail = plate([[0, -2.4], [0, -4.85], [1.5, -5.45], [1.65, -4.9]], 0.09, 0.03);
    tail.rotateZ(Math.PI / 2 - 0.32);
    if (s < 0) tail.scale(-1, 1, 1);
    tail.translate(0.42 * s, 0.68, 0);
    const t2 = s < 0 ? flipWinding(tail) : tail;
    paint.push(finish(t2, (x, y, z, nx, ny, nz, o) => o.copy(y > 1.85 ? LIGHT : y > 1.75 ? DARK : RED), 0.5));
  }
  const vent = plate([[0, -3.0], [0, -4.7], [0.75, -4.95], [0.7, -4.4]], 0.07, 0.025);
  vent.rotateZ(-Math.PI / 2); vent.translate(0, -0.6, 0);
  paint.push(finish(vent, DARK, 0.5));

  // wing detail: gunmetal leading edge, flap lines, hardpoint rails + missiles
  for (const s of [1, -1]) {
    const wy = (x) => -0.08 - x * Math.sin(tipA);
    metal.push(finish(cyl([0.95 * s, wy(0.95) + 0.02, -0.5], [4.85 * s, wy(4.85) + 0.02, -3.3], 0.06, 0.04, 8), GUN, 2));
    const te = (x) => -3.95 - (x - 0.65) * 0.233 + 0.36;
    for (const [x0, x1] of [[1.1, 2.6], [2.8, 3.6]]) metal.push(finish(cyl([x0 * s, wy(x0) + 0.09, te(x0)], [x1 * s, wy(x1) + 0.09, te(x1)], 0.016, 0.016, 4), BLACK0, 2));
    metal.push(finish(box(0.07, 0.09, 1.4, 2.4 * s, wy(2.4) - 0.14, -2.6), GUN, 2));
    metal.push(finish(cyl([2.4 * s, wy(2.4) - 0.26, -1.8], [2.4 * s, wy(2.4) - 0.26, -3.3], 0.07, 0.07, 10), LIGHT, 2));
    metal.push(finish(cyl([2.4 * s, wy(2.4) - 0.26, -1.8], [2.4 * s, wy(2.4) - 0.26, -1.6], 0.07, 0.01, 10), DARK, 2));
  }

  // ---- greebles: spine hatches, antenna, vents, sensor blisters
  for (let k = 0; k < 10; k++) {
    const z = rng.range(-3.9, -0.8), w = rng.range(0.08, 0.2), d = rng.range(0.15, 0.5);
    metal.push(finish(box(w, 0.05, d, rng.range(-0.12, 0.12), 0.98 + Math.sin(z) * 0.02, z), rng.chance(0.5) ? GUN : DARK, 2));
  }
  metal.push(finish(cyl([0.18, 0.95, -3.6], [0.24, 1.5, -4.0], 0.012, 0.006, 5), STEEL, 2));
  for (const s of [1, -1]) {
    metal.push(finish(new THREE.SphereGeometry(0.11, 12, 8).scale(1, 0.6, 1.6).translate(0.5 * s, -0.4, 0.6), GUN, 2));
    for (let k = 0; k < 5; k++) metal.push(finish(box(0.02, 0.1, 0.2, 0.88 * s, 0.32, -2.9 - k * 0.28), col('#0d0e10'), 2));
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
  const gl = mesh(merge(glass.slice(1)), M.glass); group.add(gl);
  const canopy = mesh(merge(glass.slice(0, 1)), M.canopy); canopy.castShadow = false; canopy.renderOrder = 2; group.add(canopy);
  group.add(gear);
  const hotM = M.hot.clone(); // per-ship intensity, animated with throttle
  const hotMesh = new THREE.Mesh(merge(hot), hotM); hotMesh.renderOrder = 1;
  group.add(hotMesh);

  // nav lights: port red (+X = left), starboard green, white tail strobes, warm landing light, cockpit glow
  const lights = new THREE.Group();
  const bulb = (hex, k, x, y, z, r = 0.06) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), M.glow(hex, k)); m.position.set(x, y, z); lights.add(m); return m; };
  const navL = bulb('#ff2a1a', 30, tipX, tipY + 0.3, -3.2), navR = bulb('#1aff6a', 30, -tipX, tipY + 0.3, -3.2);
  const strobes = [bulb('#ffffff', 60, 1.0, 2.2, -5.4, 0.05), bulb('#ffffff', 60, -1.0, 2.2, -5.4, 0.05)];
  const landing = [bulb('#ffe2b0', 25, 0, -0.62, 2.0, 0.08)];
  const inst = new THREE.Mesh(finish(box(0.5, 0.02, 0.14, 0, 0.47, 1.66)), M.glow('#7fd6ff', 3.5)); lights.add(inst);
  group.add(lights);

  return {
    group, gear, hotMat: hotM, lights: { navL, navR, strobes, landing },
    nozzles: [
      { pos: new THREE.Vector3(0, 0.06, -5.96), r: 0.44, len: 5.0 },
      { pos: new THREE.Vector3(tipX, tipY, -5.52), r: 0.21, len: 2.4 },
      { pos: new THREE.Vector3(-tipX, tipY, -5.52), r: 0.21, len: 2.4 },
    ],
    wingtips: [new THREE.Vector3(tipX + 0.3, tipY, -5.0), new THREE.Vector3(-tipX - 0.3, tipY, -5.0)],
    gearHeight: 1.72, length: 14, radius: 7,
  };
}
const _white = new THREE.Color(1, 1, 1);

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
    { body: '#b8111b', dark: '#18191d', light: '#e9e4da', accent: '#ff5a2a' },
    { body: '#e6e0d3', dark: '#202227', light: '#b3121c', accent: '#2fa3c8' },
    { body: '#1f6a73', dark: '#1b1d21', light: '#e6dfd0', accent: '#ff8a3c' },
    { body: '#2a2d33', dark: '#141518', light: '#c9a35a', accent: '#ff3b6b' },
  ][livery % 4];
  const BODY = col(L.body), DARK = col(L.dark), LIGHT = col(L.light), ACC = col(L.accent), GUN = col('#34373c'), STEEL = col('#9a9da3'), BLACK = col('#0c0d0f');
  const paint = [], metal = [], glass = [];

  // ---- main hull: long, low, crisp superellipse sections (Akira fairing on a speeder spine)
  const bodyPaint = (x, y, z, nx, ny, nz, o) => {
    if (ny < -0.35 || y < 0.24) return o.copy(DARK);
    if (Math.abs(x) < 0.055 && ny > 0.6 && z > -1.7) return o.copy(LIGHT); // centre racing stripe
    if (Math.abs(y - 0.36) < 0.014 && z > -1.6 && z < 1.75) return o.copy(LIGHT); // flank pin-stripe
    return o.copy(BODY);
  };
  paint.push(finish(loft([
    { z: -2.0, w: 0.1, h: 0.12, y: 0.47, n: 2.4 },
    { z: -1.82, w: 0.25, h: 0.22, y: 0.46, n: 3.2 },
    { z: -1.35, w: 0.31, h: 0.25, y: 0.43, n: 3.4, top: 1.15 },
    { z: -0.8, w: 0.24, h: 0.19, y: 0.34, n: 3.2 },
    { z: -0.15, w: 0.22, h: 0.19, y: 0.33, n: 3.0 },
    { z: 0.5, w: 0.3, h: 0.26, y: 0.42, n: 3.4, top: 1.25 },
    { z: 1.15, w: 0.29, h: 0.25, y: 0.44, n: 3.4, top: 1.1 },
    { z: 1.65, w: 0.2, h: 0.18, y: 0.4, n: 2.8 },
    { z: 2.0, w: 0.08, h: 0.08, y: 0.34, n: 2.2 },
  ], { seg: 40 }), bodyPaint, 0.9));
  // keel / chassis spine underneath (dark metal)
  metal.push(finish(loft([
    { z: -1.6, w: 0.08, h: 0.06, y: 0.2, n: 4 },
    { z: -0.6, w: 0.16, h: 0.08, y: 0.13, n: 4 },
    { z: 0.6, w: 0.16, h: 0.08, y: 0.15, n: 4 },
    { z: 1.5, w: 0.08, h: 0.06, y: 0.22, n: 4 },
  ], { seg: 20 }), GUN, 1.5));
  // seat with a raised rear bolster
  paint.push(finish(loft([
    { z: -1.18, w: 0.17, h: 0.1, y: 0.62, n: 3.5 },
    { z: -0.95, w: 0.2, h: 0.07, y: 0.55, n: 3.5 },
    { z: -0.4, w: 0.19, h: 0.05, y: 0.5, n: 3.5 },
    { z: 0.0, w: 0.14, h: 0.05, y: 0.52, n: 3 },
  ], { seg: 20 }), col('#141518'), 2));
  // windscreen over the front cowl
  const ws = new THREE.SphereGeometry(1, 28, 12, 0, Math.PI * 2, 0, Math.PI * 0.5);
  ws.scale(0.24, 0.2, 0.42); ws.rotateX(-0.5); ws.translate(0, 0.7, 0.98);
  glass.push(finish(ws, 0xffffff, 1));
  // instrument binnacle + twin headlamp housing
  metal.push(finish(box(0.2, 0.07, 0.16, 0, 0.74, 0.55), DARK, 3));
  metal.push(finish(loft([
    { z: 1.55, w: 0.16, h: 0.07, y: 0.5, n: 3 },
    { z: 1.95, w: 0.12, h: 0.05, y: 0.44, n: 3 },
  ], { seg: 16 }), BLACK, 2));

  // ---- repulsor housings: flat discs where Akira's wheels were, on forked arms
  const pods = [[1.2, 0.42], [-1.25, 0.46]];
  for (const [z, r] of pods) {
    const h = lathe([[0.001, -0.1], [r * 0.85, -0.1], [r, -0.04], [r * 1.02, 0.05], [r * 0.92, 0.11], [0.001, 0.11]], 36);
    h.rotateX(Math.PI / 2); h.scale(0.6, 1, 1); h.translate(0, 0.06, z);
    metal.push(finish(h, GUN, 1.5));
    // cooling fins on the housing rim
    for (let k = 0; k < 7; k++) {
      const a = (k / 6 - 0.5) * 2.2;
      for (const s of [1, -1]) metal.push(finish(box(0.012, 0.09, 0.12, s * Math.sin(1.57 + a * 0.3) * r * 0.62, 0.07, z + Math.cos(1.57 + a) * r * 0.75), BLACK, 3));
    }
  }
  // ---- outrigger steering vanes (speeder DNA): long blades sweeping forward past the nose
  for (const s of [1, -1]) {
    const arm = loft([
      { z: 0.85, w: 0.035, h: 0.05, x: 0.27 * s, y: 0.32, n: 3 },
      { z: 1.7, w: 0.04, h: 0.06, x: 0.4 * s, y: 0.26, n: 3 },
      { z: 2.35, w: 0.03, h: 0.04, x: 0.42 * s, y: 0.24, n: 3 },
    ], { seg: 12 });
    metal.push(finish(arm, GUN, 2));
    const vane = plate([[0, 1.75], [0, 2.55], [0.03, 2.62], [0.2, 1.85]], 0.025, 0.008);
    vane.rotateZ(-Math.PI / 2); vane.translate(0.42 * s, 0.24, 0);
    paint.push(finish(vane, (x, y, z, nx, ny, nz, o) => o.copy(z > 2.38 ? ACC : DARK), 2));
    // footpegs, handlebars, grips, mirrors
    metal.push(finish(cyl([0.2 * s, 0.24, -0.35], [0.36 * s, 0.24, -0.38], 0.022, 0.022, 6), STEEL, 3));
    metal.push(finish(cyl([0.06 * s, 0.76, 0.48], [0.4 * s, 0.8, 0.36], 0.022, 0.02, 8), STEEL, 3));
    metal.push(finish(cyl([0.36 * s, 0.8, 0.37], [0.5 * s, 0.8, 0.33], 0.032, 0.032, 8), BLACK, 3));
    metal.push(finish(cyl([0.3 * s, 0.81, 0.4], [0.36 * s, 0.98, 0.42], 0.008, 0.008, 4), STEEL, 3));
    metal.push(finish(box(0.1, 0.05, 0.015, 0.37 * s, 0.99, 0.42), BLACK, 3));
    // side intakes and panel greebles on the rear cowl
    metal.push(finish(box(0.03, 0.12, 0.34, 0.3 * s, 0.42, -1.3), BLACK, 3));
    for (let k = 0; k < 4; k++) metal.push(finish(box(0.012, 0.012, 0.3, 0.315 * s, 0.37 + k * 0.03, -1.3), STEEL, 3));
    for (let k = 0; k < 3; k++) metal.push(finish(box(0.02, 0.05, rng.range(0.1, 0.22), 0.27 * s, 0.3 + k * 0.05, 0.6 + rng.range(-0.15, 0.15)), DARK, 3));
    // exhaust pipes along the lower flanks
    metal.push(finish(cyl([0.2 * s, 0.2, 0.4], [0.24 * s, 0.26, -1.75], 0.035, 0.045, 10), STEEL, 3));
    // canted tail fins
    const fin = plate([[0, -1.25], [0, -1.95], [0.32, -2.1], [0.3, -1.7]], 0.025, 0.008);
    fin.rotateZ(Math.PI / 2 - 0.5);
    if (s < 0) fin.scale(-1, 1, 1);
    fin.translate(0.16 * s, 0.62, 0);
    paint.push(finish(s < 0 ? flipWinding(fin) : fin, BODY, 2));
  }
  // rear turbine nacelle with intake ring and nozzle petals
  metal.push(finish(lathe([[0.001, -2.3], [0.16, -2.3], [0.2, -2.22], [0.23, -2.0], [0.22, -1.75], [0.16, -1.55], [0.001, -1.55]], 28).translate(0, 0.5, 0), GUN, 1.5));
  metal.push(finish(lathe([[0.15, -2.33], [0.185, -2.33], [0.185, -2.18], [0.15, -2.18]], 28).translate(0, 0.5, 0), BLACK, 1.5));
  // exposed turbine: hub cone + fan blades behind the nacelle lip (seen from the chase cam)
  metal.push(finish(lathe([[0.001, -2.36], [0.05, -2.3], [0.06, -2.26]], 16).translate(0, 0.5, 0), STEEL, 3));
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2;
    const bl = box(0.012, 0.1, 0.035, 0, 0.1, 0); bl.rotateZ(a); bl.rotateY(0); bl.translate(0, 0.5, -2.315);
    metal.push(finish(bl, GUN, 3));
  }
  // ribbed coolant hoses: engine → repulsor pods, and chrome exhaust tips
  for (const s of [1, -1]) {
    for (let k = 0; k < 6; k++) {
      const t0 = k / 6, t1 = (k + 0.85) / 6;
      const P = (t) => [0.17 * s + Math.sin(t * 3.14) * 0.05 * s, 0.3 - t * 0.12, -1.05 + t * 0.95];
      metal.push(finish(cyl(P(t0), P(t1), 0.026, 0.026, 8), k % 2 ? BLACK : GUN, 3));
    }
    metal.push(finish(cyl([0.245 * s, 0.265, -1.68], [0.25 * s, 0.27, -1.92], 0.05, 0.052, 12), STEEL, 3));
  }
  // racing number roundel on the flank
  for (const s of [1, -1]) paint.push(finish(new THREE.CircleGeometry(0.11, 20).rotateY(s * Math.PI / 2).translate(0.318 * s, 0.47, -1.15), LIGHT, 3));
  // badge, antenna
  paint.push(finish(new THREE.SphereGeometry(0.05, 12, 8).scale(1, 1, 0.4).translate(0, 0.6, 1.78), ACC, 3));
  metal.push(finish(cyl([-0.12, 0.62, -1.6], [-0.16, 1.15, -1.75], 0.006, 0.003, 4), STEEL, 3));

  const group = new THREE.Group();
  group.add(mesh(merge(paint), M.paint));
  group.add(mesh(merge(metal), M.metal));
  group.add(mesh(merge(glass), M.glass));

  // repulsor glow: rings + discs underneath (per-bike material, animated with throttle)
  const hoverM = M.glow('#6fe4ff', 8).clone();
  const discs = [];
  for (const [z, r] of pods) {
    const ring = new THREE.TorusGeometry(r * 0.74, 0.022, 6, 48); ring.rotateX(Math.PI / 2); ring.scale(0.6, 1, 1); ring.translate(0, -0.045, z);
    const d = new THREE.CircleGeometry(r * 0.45, 24); d.rotateX(Math.PI / 2); d.scale(0.6, 1, 1); d.translate(0, -0.042, z);
    discs.push(ring, d);
  }
  const nozzleRing = new THREE.TorusGeometry(0.165, 0.012, 6, 32); nozzleRing.translate(0, 0.5, -2.31);
  discs.push(nozzleRing);
  group.add(new THREE.Mesh(merge(discs.map((g) => finish(g))), hoverM));
  const tailM = M.glow('#ff2a1a', 18);
  group.add(new THREE.Mesh(merge([finish(box(0.36, 0.025, 0.02, 0, 0.6, -1.87)), finish(box(0.02, 0.025, 0.2, 0.25, 0.47, -1.78)), finish(box(0.02, 0.025, 0.2, -0.25, 0.47, -1.78))]), tailM));
  const head = new THREE.Mesh(merge([
    finish(new THREE.SphereGeometry(0.045, 10, 6).scale(1.4, 0.7, 0.5).translate(0.06, 0.47, 1.95)),
    finish(new THREE.SphereGeometry(0.045, 10, 6).scale(1.4, 0.7, 0.5).translate(-0.06, 0.47, 1.95)),
  ]), M.glow('#fff1d6', 30));
  group.add(head);
  return {
    group, hoverMat: hoverM,
    nozzles: [{ pos: new THREE.Vector3(0, 0.5, -2.3), r: 0.15, len: 1.4 }],
    pods: pods.map(([z]) => new THREE.Vector3(0, -0.05, z)),
    seat: new THREE.Vector3(0, 0.02, -0.55), length: 4.6, radius: 2.4,
  };
}
