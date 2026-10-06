// Ornamental trees — the planted, tended trees of a settlement (avenues,
// square edges, gardens, orchards): plane trees and cypresses in Ghibli
// towns, red and orange maples and black pines around temples, golden trees
// in the gothic lands, palms along neon canals and desert oases. Wild
// vegetation belongs to the flora module; these are part of the architecture.
// One InstancedMesh per tree kind, sharing the civ building material.

import * as THREE from 'three';
import { MeshBuilder } from './builder.js';
import { M, F } from './ids.js';
import { Random, seedFrom } from '../../../core/Random.js';
import { rockLathe } from './landmarks.js';

const TAU = Math.PI * 2;
const col = (h) => new THREE.Color(h);

function lobe(B, x, y, z, r, sy, seed, segs, rings, amp) {
  const prof = [];
  for (let j = 0; j <= rings; j++) { const a = -Math.PI / 2 + (j / rings) * Math.PI; prof.push([Math.max(0.02, Math.cos(a) * r), y + Math.sin(a) * r * sy]); }
  rockLathe(B, x, z, prof, { segs, amp, fq: 1.8 / r, seed });
}
/** A canopy mass: a core lobe crowded by smaller leaf clumps so the silhouette breaks up and self-shades. */
function blob(B, x, y, z, r, color, seed, sy = 0.8) {
  B.mat(M.FOLIAGE, (seed * 0.137) % 1, 0, 3).color(color).ext(0.9, 0, F.NOWIN, 0);
  lobe(B, x, y, z, r * 0.82, sy, seed, 9, 6, 0.24);
  const n = 7;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const el = Math.asin(1 - 2 * t * 0.85) ; // biased to the upper hemisphere
    const az = i * 2.39996 + seed * 1.7;
    const rr = r * (0.36 + 0.14 * ((seed * 7 + i * 3) % 5) / 5);
    const px = x + Math.cos(az) * Math.cos(el) * r * 0.72, pz = z + Math.sin(az) * Math.cos(el) * r * 0.72, py = y + Math.sin(el) * r * sy * 0.72;
    const c = color.clone().multiplyScalar(0.85 + 0.3 * (((seed * 13 + i * 7) % 10) / 10));
    B.mat(M.FOLIAGE, ((seed + i) * 0.173) % 1, 0, 3).color(c).ext(0.95, 0, F.NOWIN, 0);
    lobe(B, px, py, pz, rr, Math.max(0.6, sy), seed * 10 + i, 6, 4, 0.3);
  }
}

function trunk(B, pts, r, color) {
  B.mat(M.WOOD, 0.3, 0, 3).color(color).ext(1, 0, F.NOWIN, 0);
  B.tube(pts.map((p) => new THREE.Vector3(...p)), r, 5);
}

/** Geometry of one tree kind, base at origin, ~real size in meters. */
function treeGeometry(kind) {
  const B = new MeshBuilder(2048);
  const bark = col('#4a3a2c');
  switch (kind) {
    case 'round': {
      trunk(B, [[0, -0.5, 0], [0.1, 2.4, 0], [0, 3.6, 0.1]], 0.22, bark);
      const g = [col('#4f7a34'), col('#5a8a3c'), col('#466e30')];
      blob(B, 0, 4.6, 0, 2.5, g[0], 1); blob(B, 1.3, 4.1, 0.6, 1.8, g[1], 2); blob(B, -1.1, 4.3, -0.7, 1.9, g[2], 3); blob(B, 0.2, 5.8, -0.3, 1.6, g[1], 4);
      break;
    }
    case 'orchard': {
      trunk(B, [[0, -0.4, 0], [0.05, 1.3, 0], [0.2, 1.9, 0.1]], 0.14, bark);
      blob(B, 0.1, 2.6, 0, 1.6, col('#5f8a3a'), 5); blob(B, -0.6, 2.4, 0.4, 1.0, col('#6a9440'), 6);
      break;
    }
    case 'cypress': {
      trunk(B, [[0, -0.4, 0], [0, 1.0, 0]], 0.16, bark);
      B.mat(M.FOLIAGE, 0.6, 0, 3).color(col('#2f4a26')).ext(0.9, 0, F.NOWIN, 0);
      rockLathe(B, 0, 0, [[0.2, 0.6], [0.95, 1.6], [1.05, 3.6], [0.8, 6.2], [0.35, 8.4], [0.05, 9.2]], { segs: 9, amp: 0.16, fq: 0.9, seed: 7 });
      break;
    }
    case 'pine': {
      // Japanese black pine: leaning trunk, flat cloud-pruned pads
      trunk(B, [[0, -0.5, 0], [0.5, 2.0, 0.2], [1.4, 3.8, 0.4], [1.8, 5.4, 0.3]], 0.26, col('#3a2e26'));
      trunk(B, [[0.8, 2.8, 0.3], [-0.8, 3.8, -0.4]], 0.12, col('#3a2e26'));
      const g = col('#2c4a2a');
      blob(B, 1.9, 5.6, 0.3, 2.2, g, 8, 0.38); blob(B, -0.9, 4.0, -0.4, 1.6, g, 9, 0.4); blob(B, 1.2, 4.2, 1.2, 1.4, g, 10, 0.4);
      break;
    }
    case 'maple_red':
    case 'maple_orange': {
      const red = kind === 'maple_red';
      trunk(B, [[0, -0.5, 0], [0.2, 1.8, 0], [0.6, 3.2, 0.3]], 0.2, col('#3a2a20'));
      trunk(B, [[0.15, 1.6, 0], [-1.0, 3.0, -0.4]], 0.11, col('#3a2a20'));
      const a = red ? col('#a8281e') : col('#d8642a'), b = red ? col('#c8382a') : col('#e88a34'), c = red ? col('#8a1e18') : col('#c85424');
      blob(B, 0.4, 4.0, 0.2, 2.3, a, 11, 0.62); blob(B, -1.1, 3.6, -0.5, 1.7, b, 12, 0.6); blob(B, 1.4, 3.4, 0.9, 1.5, c, 13, 0.6); blob(B, 0, 4.9, -0.4, 1.5, b, 14, 0.6);
      break;
    }
    case 'golden': {
      trunk(B, [[0, -0.5, 0], [0.2, 2.6, 0], [0.1, 4.2, 0.2]], 0.25, col('#5a4632'));
      const g = [col('#d8a830'), col('#e8bc44'), col('#c08a24')];
      blob(B, 0, 5.0, 0, 2.6, g[0], 15); blob(B, 1.4, 4.5, 0.7, 1.9, g[1], 16); blob(B, -1.2, 4.6, -0.6, 1.9, g[2], 17); blob(B, 0.3, 6.3, -0.2, 1.6, g[1], 18);
      break;
    }
    case 'palm': {
      const pts = [];
      for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push([Math.sin(t * 1.4) * 1.2, -0.4 + t * 8.5, 0]); }
      trunk(B, pts, 0.2, col('#6a5a44'));
      const top = new THREE.Vector3(Math.sin(1.4) * 1.2, 8.1, 0);
      B.mat(M.FOLIAGE, 0.4, 0, 3).color(col('#4a6a2a')).ext(1, 0, F.NOWIN, 0);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU + 0.3;
        const ca = Math.cos(a), sa = Math.sin(a);
        const L = 3.6;
        const p0 = top.clone(), p1 = top.clone().add(new THREE.Vector3(ca * L * 0.5, 0.6, sa * L * 0.5)), p2 = top.clone().add(new THREE.Vector3(ca * L, -0.9, sa * L));
        const wv = new THREE.Vector3(-sa * 0.45, 0, ca * 0.45);
        for (const sd of [1, -1]) {
          const q0 = p0, q1 = p1.clone().addScaledVector(wv, sd), q2 = p2, q3 = p1.clone();
          B.quadP(q0, q1, q2, q3, [0, 0], [1, 0], [1, 1], [0, 1]);
          B.quadP(q3, q2, q1, q0, [0, 0], [1, 0], [1, 1], [0, 1]);
        }
      }
      break;
    }
    default:
      return treeGeometry('round');
  }
  return B.toGeometry();
}

const STYLE_TREES = {
  pastoral: { avenue: ['round', 'round', 'cypress'], garden: ['round', 'orchard', 'cypress'], plaza: ['round'], tint: 0.12 },
  temple: { avenue: ['maple_red', 'maple_orange', 'pine'], garden: ['maple_red', 'maple_orange', 'pine', 'pine'], plaza: ['pine', 'maple_red'], tint: 0.1 },
  gothic: { avenue: ['golden', 'cypress'], garden: ['golden', 'golden', 'cypress'], plaza: ['golden'], tint: 0.12 },
  neon: { avenue: ['palm'], garden: ['palm'], plaza: ['palm'], tint: 0.08 },
  monolithic: { avenue: ['palm'], garden: ['palm'], plaza: ['palm'], tint: 0.08, sparse: 0.2 },
  ruins: { avenue: ['cypress'], garden: ['cypress', 'round'], plaza: [], tint: 0.1, sparse: 0.4 },
};

/** Plant trees for a settlement. Returns { meshes, dispose() } or null. */
export function plantTrees(settlement, ctx) {
  const cfg = STYLE_TREES[settlement.styleKey];
  if (!cfg) return null;
  // trees need living soil: skip on barren/frozen worlds
  const A = settlement.level.aesthetic;
  if (A?.flora === 'none') return null;
  const plan = ctx.plan, frame = ctx.frame;
  const rng = new Random(seedFrom(settlement.seed, 'trees'));
  const q = settlement.level.engine.quality;
  const budget = Math.round(q.pick(80, 160, 320, 420) * (settlement.main ? 1 : 0.6) * (cfg.sparse ?? 1));
  const spots = { };
  const add = (kind, x, z, s) => { (spots[kind] ||= []).push([x, z, s, rng.float() * TAU]); };
  let n = 0;
  // avenues
  for (const road of plan.roads) {
    if (n >= budget * 0.45) break;
    if (road.kind !== 'main' && road.kind !== 'avenue') continue;
    let s = 0, next = rng.range(4, 10), side = 1;
    for (let i = 1; i < road.pts.length; i++) {
      const [ax, az] = road.pts[i - 1], [bx, bz] = road.pts[i];
      const L = Math.hypot(bx - ax, bz - az); if (L < 1e-3) continue;
      while (next < s + L) {
        const t = (next - s) / L, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const nx = -(bz - az) / L, nz = (bx - ax) / L;
        const off = road.w / 2 + 2.2;
        for (const sd of cfg.sparse ? [side] : [1, -1]) {
          const px = x + nx * off * sd, pz = z + nz * off * sd;
          if (ctx.free(px, pz, 1.4)) { add(rng.pick(cfg.avenue), px, pz, rng.range(0.85, 1.15)); ctx.occupy(px, pz, 1.6); n++; }
        }
        side = -side;
        next += rng.range(9, 14);
      }
      s += L;
    }
  }
  // edge of the main square
  const pz0 = plan.plazas[0];
  if (cfg.plaza.length && pz0) {
    const k = Math.floor(pz0.r / 3.2);
    for (let i = 0; i < k; i++) {
      const a = (i / k) * TAU + 0.15;
      const x = pz0.x + Math.cos(a) * (pz0.r - 2.6), z = pz0.z + Math.sin(a) * (pz0.r - 2.6);
      if (ctx.free(x, z, 1.2, true)) { add(rng.pick(cfg.plaza), x, z, rng.range(0.9, 1.1)); ctx.occupy(x, z, 1.5); n++; }
    }
  }
  // gardens: gaps near streets, inside the built area
  for (let k = 0; k < budget * 8 && n < budget; k++) {
    const a = rng.range(0, TAU), r = Math.sqrt(rng.float()) * plan.builtRadius * 1.08;
    const x = plan.center[0] + Math.cos(a) * r, z = plan.center[1] + Math.sin(a) * r;
    const qd = plan.roadGrid.query(x, z, 24);
    if (qd.d > 20 || qd.d < 2) continue;
    if (!ctx.free(x, z, 1.8)) continue;
    add(rng.pick(cfg.garden), x, z, rng.range(0.8, 1.25));
    ctx.occupy(x, z, 2.2);
    n++;
  }
  // a couple of orchards in the fields (pastoral)
  if (settlement.styleKey === 'pastoral') {
    for (const f of plan.fields.slice(0, 3)) {
      const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
      for (let u = -f.w / 2 + 3; u < f.w / 2 - 2; u += 5) for (let v = -f.d / 2 + 3; v < f.d / 2 - 2; v += 5) {
        const x = f.x + u * c + v * s, z = f.z - u * s + v * c;
        add('orchard', x, z, rng.range(0.85, 1.1));
      }
    }
  }
  const kinds = Object.keys(spots);
  if (!kinds.length) return null;
  const meshes = [];
  const M4 = new THREE.Matrix4(), S4 = new THREE.Matrix4(), cc = new THREE.Color();
  const tint = cfg.tint;
  for (const kind of kinds) {
    const list = spots[kind];
    const geo = treeGeometry(kind);
    const mesh = new THREE.InstancedMesh(geo, settlement.material, list.length);
    for (let i = 0; i < list.length; i++) {
      const [x, z, sc, yaw] = list[i];
      frame.placement(x, z, frame.hAt(x, z), yaw, M4);
      M4.multiply(S4.makeScale(sc, sc * rng.range(0.9, 1.15), sc));
      mesh.setMatrixAt(i, M4);
      mesh.setColorAt(i, cc.setRGB(1 + rng.range(-tint, tint), 1 + rng.range(-tint, tint), 1 + rng.range(-tint, tint) * 0.6).multiplyScalar(rng.range(0.85, 1.1)));
      // trunk collider
      const pos = frame.point(x, z, frame.hAt(x, z) - 0.3).applyMatrix4(frame.matrix);
      settlement.colliders.push({ type: 'cylinder', center: pos, up: pos.clone().normalize(), radius: 0.35 * sc, height: 3 * sc });
    }
    mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.computeBoundingSphere();
    mesh.name = `civ-trees:${kind}`;
    settlement.group.add(mesh);
    settlement.meshes.push(mesh);
    meshes.push(mesh);
  }
  return { meshes, dispose() { for (const m of meshes) { m.geometry.dispose(); m.parent?.remove(m); } } };
}
