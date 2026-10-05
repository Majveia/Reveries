// Procedural plant species: branch skeletons → tapered tubes (bark) and
// clustered foliage cards with volumetric (canopy-spherical) normals and
// baked canopy AO in vertex colours. Each call builds one variant:
//
//   buildPlant(kind, rng, opts) → { bark: BufferGeometry, leaves: BufferGeometry|null,
//                                   height, crown, trunkR }
//
// Attributes: position, normal, color, uv (bark: around × meters; leaves: atlas),
// aWind (x sway metres/strength, y leaf flutter, z glow).
// Kinds: broad, birch, conifer, maple, golden, biolum, palm, fungus, coral,
// cactus, scrub, giant (landmark; opts.style picks the look).
import * as THREE from 'three';
import { TILE, tileRect } from './textures.js';

const V = THREE.Vector3;
const UP = new V(0, 1, 0);

class Builder {
  constructor() { this.p = []; this.n = []; this.c = []; this.uv = []; this.w = []; this.i = []; }
  get vcount() { return this.p.length / 3; }
  vert(p, n, c, u, v, w0, w1, g) { this.p.push(p.x, p.y, p.z); this.n.push(n.x, n.y, n.z); this.c.push(c.r, c.g, c.b); this.uv.push(u, v); this.w.push(w0, w1, g); }
  geometry() {
    if (!this.i.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.w, 3));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

/** Sway weight: metres of displacement per unit wind strength at height y. */
const swayAt = (y, H, k = 1) => k * 0.022 * H * Math.pow(Math.max(0, y) / H, 1.8);

/** Tube along points with radii; parallel-transport frames. */
function tube(B, pts, radii, sides, col, H, opts = {}) {
  const n = pts.length;
  const base = B.vcount;
  let normal = new V(), binormal = new V();
  const tan = new V();
  let vAcc = 0;
  const _q = new THREE.Quaternion();
  let prevT = null;
  const c = new THREE.Color();
  for (let k = 0; k < n; k++) {
    if (k < n - 1) tan.copy(pts[k + 1]).sub(pts[k]).normalize(); else tan.copy(pts[k]).sub(pts[k - 1]).normalize();
    if (k === 0) {
      normal.copy(Math.abs(tan.y) < 0.9 ? UP : new V(1, 0, 0)).cross(tan).normalize();
    } else {
      _q.setFromUnitVectors(prevT, tan);
      normal.applyQuaternion(_q);
    }
    prevT = (prevT || new V()).copy(tan);
    binormal.copy(tan).cross(normal).normalize();
    if (k > 0) vAcc += pts[k].distanceTo(pts[k - 1]);
    const r = radii[k];
    const y = pts[k].y;
    // AO: dark at the root and at branch bases
    const ao = (opts.ao ?? 1) * (0.55 + 0.45 * Math.min(1, (y + 0.4) / (H * 0.25))) * (k === 0 && opts.child ? 0.7 : 1);
    const circ = Math.max(1, Math.round(2 * Math.PI * Math.max(r, 0.05) / 0.5));
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = normal.x * ca + binormal.x * sa, ny = normal.y * ca + binormal.y * sa, nz = normal.z * ca + binormal.z * sa;
      // root flare
      let rr = r;
      if (opts.flare && k === 0) rr *= 1.0 + opts.flare * (0.6 + 0.4 * Math.cos(a * 5));
      const p = new V(pts[k].x + nx * rr, pts[k].y + ny * rr, pts[k].z + nz * rr);
      c.copy(col).multiplyScalar(ao);
      B.vert(p, new V(nx, ny, nz), c, (s / sides) * circ, vAcc, swayAt(p.y, H, opts.swayK ?? 1), 0, opts.glow || 0);
    }
  }
  for (let k = 0; k < n - 1; k++) for (let s = 0; s < sides; s++) {
    const a = base + k * (sides + 1) + s, b = a + sides + 1;
    B.i.push(a, b, a + 1, a + 1, b, b + 1);
  }
}

/** Lathe (around +Y) from a profile [[r, y], ...] at origin o. */
function lathe(B, o, prof, sides, col, H, opts = {}) {
  const base = B.vcount;
  const c = new THREE.Color();
  for (let k = 0; k < prof.length; k++) {
    const [r, y] = prof[k];
    const [r0, y0] = prof[Math.max(0, k - 1)], [r1, y1] = prof[Math.min(prof.length - 1, k + 1)];
    const dy = y1 - y0, dr = r1 - r0;
    const nl = Math.hypot(dy, dr) || 1;
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      let rr = r * (1 + (opts.ribs ? opts.ribs * Math.pow(Math.abs(Math.cos(a * opts.ribN * 0.5)), 3) : 0) + (opts.wob ? opts.wob * Math.sin(a * 3 + k) : 0));
      const ca = Math.cos(a), sa = Math.sin(a);
      const p = new V(o.x + ca * rr, o.y + y, o.z + sa * rr);
      const n = new V(ca * dy / nl, -dr / nl, sa * dy / nl);
      if (opts.flipN) n.negate();
      const t = k / (prof.length - 1);
      c.copy(col).multiplyScalar(opts.shade ? opts.shade(t, a) : 1);
      B.vert(p, n, c, (s / sides) * 6, y, swayAt(p.y, H, opts.swayK ?? 0.4), 0, opts.glow ? opts.glow(t) : 0);
    }
  }
  for (let k = 0; k < prof.length - 1; k++) for (let s = 0; s < sides; s++) {
    const a = base + k * (sides + 1) + s, b = a + sides + 1;
    if (opts.flipN) B.i.push(a, a + 1, b, a + 1, b + 1, b); else B.i.push(a, b, a + 1, a + 1, b, b + 1);
  }
}

/** One foliage card (quad) with canopy normals. */
function card(B, center, ax, ay, w, h, tile, col, canopy, H, flutter = 1, glow = 0, anchorBottom = false) {
  const [u0, v0, u1, v1] = tileRect(tile);
  const base = B.vcount;
  const c = new THREE.Color();
  const corners = anchorBottom ? [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]] : [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  const cn = new V().crossVectors(ax, ay).normalize();
  for (let k = 0; k < 4; k++) {
    const [sx, sy] = corners[k];
    const p = center.clone().addScaledVector(ax, sx * w).addScaledVector(ay, sy * h);
    const d = p.clone().sub(canopy.c);
    d.x /= canopy.rx; d.y /= canopy.ry; d.z /= canopy.rx;
    const rl = d.length();
    const sn = d.clone().normalize();
    const n = sn.multiplyScalar(0.8).addScaledVector(cn, cn.dot(sn) >= 0 ? 0.2 : -0.2).normalize();
    // canopy AO: inner and lower leaves darker
    const ao = (0.22 + 0.78 * THREE.MathUtils.smoothstep(rl, 0.25, 1.05)) * (0.7 + 0.3 * THREE.MathUtils.clamp((p.y - canopy.c.y) / canopy.ry + 0.5, 0, 1));
    c.copy(col).multiplyScalar(ao);
    B.vert(p, n, c, sx + 0.5 > 0.5 ? u1 : u0, (anchorBottom ? sy : sy + 0.5) > 0.5 ? v1 : v0, swayAt(p.y, H), flutter, glow);
  }
  B.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** A leaf cluster: 2–3 crossed cards around a point. */
function cluster(B, p, size, tile, col, canopy, H, rng, flutter = 1, glow = 0) {
  const n = 2 + (rng.float() < 0.5 ? 1 : 0);
  const a0 = rng.float() * Math.PI;
  for (let k = 0; k < n; k++) {
    const a = a0 + (k / n) * Math.PI;
    const tilt = (rng.float() - 0.5) * 0.9;
    const ax = new V(Math.cos(a), 0, Math.sin(a));
    const ay = new V(-Math.sin(a) * Math.sin(tilt), Math.cos(tilt), Math.cos(a) * Math.sin(tilt));
    if (k === n - 1 && n === 3) ay.set(0, 0.25, 1).applyAxisAngle(UP, a).normalize(); // one flatter card
    const s = size * (0.85 + rng.float() * 0.3);
    card(B, p, ax, ay, s, s, tile, col, canopy, H, flutter, glow);
  }
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function path(start, dir, len, segs, rng, wiggle, trop) {
  const pts = [start.clone()];
  const d = dir.clone();
  for (let s = 1; s <= segs; s++) {
    d.x += (rng.float() - 0.5) * wiggle; d.y += (rng.float() - 0.5) * wiggle * 0.6 + trop; d.z += (rng.float() - 0.5) * wiggle;
    d.normalize();
    pts.push(pts[s - 1].clone().addScaledVector(d, len / segs));
  }
  return pts;
}

/**
 * Recursive deciduous tree.
 * P: { H, trunkR, depth, kids:[n0,n1,..], angle, lenK, wiggle, trop, leafTile, leafSize, leafCol, barkCol, leafDensity, crownStart, droop, glow }
 */
function deciduous(P, rng) {
  const B = new Builder(), L = new Builder();
  const H = P.H;
  const leafPts = [];
  const trunkLen = H * (P.trunkK ?? 0.55);
  const grow = (start, dir, len, r, depth) => {
    const segs = depth === 0 ? 7 : depth === 1 ? 5 : 3;
    const pts = path(start, dir, len, segs, rng, P.wiggle * (depth === 0 ? 0.5 : 1), depth === 0 ? 0.04 : P.trop - (P.droop || 0) * depth * 0.3);
    const radii = pts.map((_, k) => r * (1 - (k / segs) * (depth === 0 ? 0.55 : 0.75)));
    tube(B, pts, radii, depth === 0 ? 9 : depth === 1 ? 6 : 4, P.barkCol, H, { flare: depth === 0 ? (P.flare ?? 0.35) : 0, child: depth > 0 });
    if (depth >= P.depth) {
      for (let k = 1; k < pts.length; k++) if (rng.float() < P.leafDensity) leafPts.push(pts[k]);
      leafPts.push(pts[pts.length - 1]);
      return;
    }
    const nk = P.kids[depth];
    for (let c = 0; c < nk; c++) {
      const t = depth === 0 ? (P.crownStart ?? 0.45) + (1 - (P.crownStart ?? 0.45)) * ((c + rng.float() * 0.8) / nk) : 0.3 + 0.7 * ((c + rng.float()) / nk);
      const idx = Math.min(pts.length - 2, Math.floor(t * (pts.length - 1)));
      const sp = pts[idx].clone().lerp(pts[idx + 1], t * (pts.length - 1) - idx);
      const pd = pts[idx + 1].clone().sub(pts[idx]).normalize();
      const az = c * 2.39996 + rng.float() * 0.6;
      const perp = new V(Math.cos(az), 0, Math.sin(az));
      perp.addScaledVector(pd, -perp.dot(pd)).normalize();
      const ang = P.angle * (0.75 + rng.float() * 0.5) * (depth === 0 ? 1 : 0.85);
      const nd = pd.clone().multiplyScalar(Math.cos(ang)).addScaledVector(perp, Math.sin(ang)).normalize();
      const childLen = len * P.lenK * (depth === 0 ? (1.15 - t * 0.55) : (1.05 - t * 0.4)) * (0.8 + rng.float() * 0.4);
      const childR = radii[idx] * (0.42 + rng.float() * 0.18);
      grow(sp, nd, childLen, Math.max(0.025, childR), depth + 1);
    }
    // trunk/leader continues into the crown
    if (depth === 0 && P.leaderLeaves) for (let k = Math.floor(pts.length * 0.6); k < pts.length; k++) leafPts.push(pts[k]);
  };
  grow(new V(0, -0.3, 0), new V((rng.float() - 0.5) * 0.12, 1, (rng.float() - 0.5) * 0.12).normalize(), trunkLen + 0.3, P.trunkR, 0);
  // canopy ellipsoid from leaf points
  const box = new THREE.Box3().setFromPoints(leafPts);
  const canopy = { c: box.getCenter(new V()), rx: Math.max(1, (box.max.x - box.min.x + box.max.z - box.min.z) * 0.25 + P.leafSize * 0.4), ry: Math.max(1, (box.max.y - box.min.y) * 0.5 + P.leafSize * 0.4) };
  const lc = new THREE.Color();
  for (const p of leafPts) {
    lc.copy(P.leafCol).offsetHSL((rng.float() - 0.5) * 0.03, 0, (rng.float() - 0.5) * 0.05);
    if (P.leafCol2 && rng.float() < 0.35) lc.lerp(P.leafCol2, 0.6 + rng.float() * 0.4);
    const glow = P.glow ? (rng.float() < 0.5 ? P.glow : P.glow * 0.25) : 0;
    cluster(L, p.clone().add(new V((rng.float() - 0.5) * 0.5, (rng.float() - 0.3) * 0.4, (rng.float() - 0.5) * 0.5)), P.leafSize, P.leafTile, lc, canopy, H, rng, 1, glow);
  }
  // crown fill: extra sprays on the outer shell of the canopy (only where a
  // twig is close enough to carry them) so crowns read as full, soft volumes
  const nFill = Math.round(leafPts.length * (P.fill ?? 0.4));
  const reach2 = (P.leafSize * 1.6) ** 2;
  for (let k = 0; k < nFill; k++) {
    const th = rng.float() * Math.PI * 2, cy = rng.float() * 1.5 - 0.5, sr = Math.sqrt(Math.max(0, 1 - cy * cy)), rr = (0.68 + 0.3 * rng.float()) * 0.88;
    const p = new V(canopy.c.x + Math.cos(th) * sr * canopy.rx * rr, canopy.c.y + cy * canopy.ry * rr, canopy.c.z + Math.sin(th) * sr * canopy.rx * rr);
    let best = 1e9;
    for (const q of leafPts) { const d = q.distanceToSquared(p); if (d < best) best = d; }
    if (best > reach2) continue;
    lc.copy(P.leafCol).offsetHSL((rng.float() - 0.5) * 0.03, 0, (rng.float() - 0.5) * 0.05);
    if (P.leafCol2 && rng.float() < 0.45) lc.lerp(P.leafCol2, 0.6 + rng.float() * 0.4);
    cluster(L, p, P.leafSize * 0.9, P.leafTile, lc, canopy, H, rng, 1, P.glow ? P.glow * 0.25 : 0);
  }
  // hanging strands (willow / biolum)
  if (P.strands) {
    for (let k = 0; k < P.strands; k++) {
      const p = leafPts[Math.floor(rng.float() * leafPts.length)];
      if (!p) break;
      const a = rng.float() * Math.PI;
      const len = P.strandLen * (0.6 + rng.float() * 0.6);
      lc.copy(P.strandCol || P.leafCol);
      card(L, p.clone().add(new V(0, -len, 0)), new V(Math.cos(a), 0, Math.sin(a)), new V(0, 1, 0), len * 0.2, len, TILE.strand, lc, canopy, H, 0.6, P.strandGlow || 0, true);
    }
  }
  return { bark: B.geometry(), leaves: L.geometry(), height: box.max.y, crown: canopy.rx, trunkR: P.trunkR };
}

function conifer(P, rng) {
  const B = new Builder(), L = new Builder();
  const H = P.H;
  const trunk = path(new V(0, -0.3, 0), new V((rng.float() - 0.5) * 0.04, 1, (rng.float() - 0.5) * 0.04).normalize(), H + 0.3, 10, rng, 0.03, 0.02);
  tube(B, trunk, trunk.map((_, k) => P.trunkR * (1 - k / 10 * 0.92)), 8, P.barkCol, H, { flare: 0.3 });
  const canopy = { c: new V(0, H * 0.55, 0), rx: H * P.width * 0.6, ry: H * 0.5 };
  const whorls = P.whorls;
  const lc = new THREE.Color();
  const tierStart = P.clearTrunk ?? 0.22;
  for (let w = 0; w < whorls; w++) {
    const t = tierStart + (1 - tierStart) * (w / whorls);
    const y = t * H;
    const reach = H * P.width * Math.pow(1 - t, P.shape ?? 0.95) * (0.85 + rng.float() * 0.3) + 0.4;
    const nb = Math.max(3, Math.round(P.perWhorl * (1 - t * 0.4)));
    const az0 = rng.float() * Math.PI * 2;
    for (let b = 0; b < nb; b++) {
      const az = az0 + (b / nb) * Math.PI * 2 + (rng.float() - 0.5) * 0.4;
      const dir = new V(Math.cos(az), -P.droop * (0.6 + rng.float() * 0.8) + 0.15, Math.sin(az)).normalize();
      const pts = path(new V(trunk[0].x, y, trunk[0].z), dir, reach, 3, rng, 0.15, -P.droop * 0.05);
      tube(B, pts, [P.trunkR * 0.18 * (1 - t * 0.5), P.trunkR * 0.1, P.trunkR * 0.06, 0.02], 4, P.barkCol, H, { child: true });
      // needle sprays along the branch: a flat spray plus two sprays rolled
      // ±50° around the branch (bottle-brush volume); pines gather their
      // needles into dense cloud-like pads toward the branch tips
      const pad = P.pads ? 1 : 0;
      const nCards = Math.max(2, Math.round(reach / (P.leafSize * 0.42))) + pad * 2;
      for (let k = 0; k < nCards; k++) {
        let f = (k + 0.6) / nCards;
        if (pad) f = 0.45 + 0.55 * Math.sqrt(f);
        const pIdx = Math.min(2, Math.floor(f * 3));
        const p = pts[pIdx].clone().lerp(pts[pIdx + 1], Math.min(1, f * 3 - pIdx));
        const bd = pts[pIdx + 1].clone().sub(pts[pIdx]).normalize();
        const side = new V().crossVectors(bd, UP).normalize();
        const ay = bd.clone();
        const ax = side.clone().applyAxisAngle(bd, (rng.float() - 0.5) * 0.5);
        lc.copy(P.leafCol).offsetHSL((rng.float() - 0.5) * 0.02, 0, (rng.float() - 0.5) * 0.07);
        if (P.snow && rng.float() < P.snow) lc.lerp(new THREE.Color(0.85, 0.88, 0.92), 0.65);
        const s = P.leafSize * (1.05 - f * 0.35) * (pad ? 1.15 : 0.85);
        const o = p.clone().addScaledVector(UP, -0.05 + (rng.float() - 0.5) * 0.15 * s);
        if (pad) {
          // Huangshan-pine pad: a bushy cloud of crossed needle sprays readable from any side
          cluster(L, o.clone().addScaledVector(side, (rng.float() - 0.5) * s * 0.6), s * 0.95, TILE.needle, lc, canopy, H, rng, 0.5);
          card(L, o.clone().addScaledVector(UP, 0.12 * s), ax, ay, s * 1.3, s * 1.3, TILE.needle, lc, canopy, H, 0.5);
          continue;
        }
        card(L, o, ax, ay, s * 1.0, s * 1.1, TILE.needle, lc, canopy, H, 0.5);
        const roll = 1.0 + rng.float() * 0.3;
        card(L, o.clone().addScaledVector(UP, 0.06 * s), ax.clone().applyAxisAngle(bd, roll), ay, s * 0.8, s * 0.95, TILE.needle, lc, canopy, H, 0.5);
        if (pad || rng.float() < 0.6) card(L, o.clone().addScaledVector(UP, 0.03 * s), ax.clone().applyAxisAngle(bd, -roll), ay, s * 0.8, s * 0.95, TILE.needle, lc, canopy, H, 0.5);
      }
    }
  }
  // crown tip
  lc.copy(P.leafCol);
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI; card(L, new V(trunk[10].x, H - 0.9, trunk[10].z), new V(Math.cos(a), 0, Math.sin(a)), UP, P.leafSize * 0.7, P.leafSize * 1.6, TILE.needle, lc, canopy, H, 0.4); }
  return { bark: B.geometry(), leaves: L.geometry(), height: H, crown: canopy.rx, trunkR: P.trunkR };
}

function palm(P, rng) {
  const B = new Builder(), L = new Builder();
  const H = P.H;
  const lean = new V(rng.float() - 0.5, 0, rng.float() - 0.5).normalize().multiplyScalar(0.35 + rng.float() * 0.4);
  const pts = [];
  for (let k = 0; k <= 12; k++) { const t = k / 12; pts.push(new V(lean.x * H * t * t, t * H - 0.3, lean.z * H * t * t)); }
  const radii = pts.map((_, k) => P.trunkR * (1.25 - (k / 12) * 0.45) * (k % 2 ? 0.94 : 1.0));
  tube(B, pts, radii, 8, P.barkCol, H, { flare: 0.25, swayK: 1.4 });
  const top = pts[12];
  const canopy = { c: top.clone(), rx: P.frond * 0.8, ry: P.frond * 0.5 };
  const nf = 10 + Math.floor(rng.float() * 5);
  const lc = new THREE.Color();
  const [u0, v0, u1, v1] = tileRect(TILE.frond);
  for (let f = 0; f < nf; f++) {
    const az = (f / nf) * Math.PI * 2 + rng.float() * 0.3;
    const out = new V(Math.cos(az), 0, Math.sin(az));
    const side = new V(-Math.sin(az), 0, Math.cos(az));
    const lift = 0.5 + rng.float() * 0.6 - (f % 3 === 0 ? 0.6 : 0);
    const len = P.frond * (0.8 + rng.float() * 0.35);
    const segs = 5, base = L.vcount;
    lc.copy(P.leafCol).offsetHSL(0, 0, (rng.float() - 0.5) * 0.08);
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const p = top.clone().addScaledVector(out, len * t).addScaledVector(UP, len * (lift * t - 0.75 * t * t));
      const tw = 0.28 * len * Math.sin(Math.PI * (0.1 + 0.9 * t)) + 0.05;
      for (const sd of [-1, 1]) {
        const q = p.clone().addScaledVector(side, sd * tw).addScaledVector(UP, -Math.abs(sd) * tw * 0.35);
        const n = new V().copy(UP).multiplyScalar(0.8).addScaledVector(out, 0.3).normalize();
        L.vert(q, n, lc.clone().multiplyScalar(0.65 + 0.35 * t), u0 + (u1 - u0) * t, sd < 0 ? v0 : v1, swayAt(H, H, 1.4) + 0.12 * len * t * t, 1.2 * t, 0);
      }
    }
    for (let s = 0; s < segs; s++) { const a = base + s * 2; L.i.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  return { bark: B.geometry(), leaves: L.geometry(), height: H, crown: P.frond, trunkR: P.trunkR };
}

function fungus(P, rng) {
  const B = new Builder();
  const H = P.H;
  // stem: slightly curved, thick lathe-ish tube
  const bend = new V(rng.float() - 0.5, 0, rng.float() - 0.5).multiplyScalar(0.25);
  const stem = [];
  for (let k = 0; k <= 8; k++) { const t = k / 8; stem.push(new V(bend.x * H * t * t, t * H * 0.92 - 0.3, bend.z * H * t * t)); }
  const sr = P.trunkR;
  tube(B, stem, stem.map((_, k) => sr * (1.35 - 0.5 * Math.sin((k / 8) * Math.PI * 0.5)) * (k === 0 ? 1.3 : 1)), 12, P.barkCol, H, { swayK: 0.3, glow: P.stemGlow || 0 });
  const top = stem[8];
  const capR = P.cap * (0.85 + rng.float() * 0.3), capH = capR * (P.capH ?? 0.45);
  const prof = [];
  for (let k = 0; k <= 10; k++) { const t = k / 10, a = t * Math.PI * 0.5; prof.push([Math.max(0.01, Math.sin(Math.PI * 0.5 - a) * capR * (1 + 0.08 * Math.sin(t * 9))), Math.sin(a) * capH - capH * 0.15]); }
  prof.reverse(); // top → rim
  const capProf = prof.slice().reverse();
  lathe(B, top, capProf, 24, P.capCol, H, { swayK: 0.3, wob: 0.04, shade: (t) => 0.75 + 0.25 * (1 - t), glow: (t) => (P.spotGlow || 0) * (t > 0.4 && t < 0.9 ? 0.6 : 0.1) });
  // gills (underside): flat-ish disc facing down, glowing on bioluminescent worlds
  const under = [[capR * 0.98, -capH * 0.15], [capR * 0.6, -capH * 0.32], [sr * 1.2, -capH * 0.4]];
  lathe(B, top, under, 24, P.gillCol || P.capCol.clone().multiplyScalar(0.55), H, { swayK: 0.3, flipN: true, glow: () => P.gillGlow || 0 });
  return { bark: B.geometry(), leaves: null, height: H + capH, crown: capR, trunkR: sr };
}

function coral(P, rng) {
  const B = new Builder();
  const H = P.H;
  const grow = (start, dir, len, r, depth) => {
    const pts = path(start, dir, len, 4, rng, 0.5, 0.08);
    tube(B, pts, pts.map((_, k) => r * (1 - k / 4 * 0.45)), 7, P.barkCol, H, { glow: depth >= 2 ? (P.tipGlow || 0) * 0.3 : 0 });
    const end = pts[4];
    if (depth >= 2 || r < 0.08) {
      const prof = []; const br = r * 2.4;
      for (let k = 0; k <= 6; k++) { const a = -Math.PI / 2 + (k / 6) * Math.PI; prof.push([Math.max(0.01, Math.cos(a) * br), Math.sin(a) * br + br * 0.6]); }
      lathe(B, end, prof, 10, P.tipCol, H, { glow: () => P.tipGlow || 0 });
      return;
    }
    const nk = 2 + Math.floor(rng.float() * 2);
    for (let c = 0; c < nk; c++) {
      const az = rng.float() * Math.PI * 2;
      const nd = dir.clone().add(new V(Math.cos(az) * 0.9, 0.25, Math.sin(az) * 0.9)).normalize();
      grow(end, nd, len * 0.72, r * 0.62, depth + 1);
    }
  };
  grow(new V(0, -0.3, 0), UP.clone(), H * 0.45, P.trunkR, 0);
  return { bark: B.geometry(), leaves: null, height: H, crown: H * 0.5, trunkR: P.trunkR };
}

function cactus(P, rng) {
  const B = new Builder();
  const H = P.H;
  const col = P.barkCol;
  const prof = (h, r) => { const a = []; for (let k = 0; k <= 8; k++) { const t = k / 8; a.push([r * (t < 0.88 ? 1 : Math.sqrt(Math.max(0.01, 1 - ((t - 0.88) / 0.12) ** 2))), t * h]); } return a; };
  lathe(B, new V(0, -0.2, 0), prof(H, P.trunkR), 16, col, H, { ribs: 0.12, ribN: 12, swayK: 0.05, shade: (t) => 0.75 + 0.25 * t });
  const arms = Math.floor(rng.float() * 3);
  for (let a = 0; a < arms; a++) {
    const az = rng.float() * Math.PI * 2, y = H * (0.35 + rng.float() * 0.25), out = P.trunkR * 2.6;
    const pts = [new V(0, y, 0), new V(Math.cos(az) * out * 0.7, y + 0.1, Math.sin(az) * out * 0.7), new V(Math.cos(az) * out, y + out * 0.6, Math.sin(az) * out)];
    tube(B, pts, [P.trunkR * 0.6, P.trunkR * 0.62, P.trunkR * 0.62], 10, col, H, { swayK: 0.05 });
    lathe(B, pts[2], prof(H * 0.35, P.trunkR * 0.62), 12, col, H, { ribs: 0.1, ribN: 10, swayK: 0.05 });
  }
  return { bark: B.geometry(), leaves: null, height: H, crown: P.trunkR * 3, trunkR: P.trunkR };
}

function scrub(P, rng) {
  // a dense, low, rounded bush: short woody stems from the root, leaf clusters
  // packed into a squashed dome (outer shell bright, inner dark)
  const B = new Builder(), L = new Builder();
  const H = P.H;
  const R = H * (0.75 + rng.float() * 0.35);
  const canopy = { c: new V(0, H * 0.5, 0), rx: R, ry: H * 0.55 };
  const stems = 5 + Math.floor(rng.float() * 4);
  for (let s = 0; s < stems; s++) {
    const az = rng.float() * Math.PI * 2;
    const pts = path(new V(0, -0.15, 0), new V(Math.cos(az) * 0.8, 1, Math.sin(az) * 0.8).normalize(), H * (0.55 + rng.float() * 0.3), 3, rng, 0.5, 0.0);
    tube(B, pts, [P.trunkR, P.trunkR * 0.7, P.trunkR * 0.4, 0.01], 4, P.barkCol, H);
  }
  const lc = new THREE.Color();
  const n = Math.round(16 + 10 * (R / 1.5));
  for (let k = 0; k < n; k++) {
    // points on/inside a squashed dome, biased to the shell
    const az = rng.float() * Math.PI * 2, el = Math.acos(1 - rng.float() * 1.3), rr = 0.55 + 0.45 * Math.sqrt(rng.float());
    const p = new V(Math.sin(el) * Math.cos(az) * R * rr, H * 0.34 + Math.cos(el) * H * 0.55 * rr, Math.sin(el) * Math.sin(az) * R * rr);
    lc.copy(P.leafCol).offsetHSL((rng.float() - 0.5) * 0.02, 0, (rng.float() - 0.5) * 0.08);
    if (P.leafCol2 && rng.float() < 0.25) lc.lerp(P.leafCol2, 0.5);
    cluster(L, p, P.leafSize * (0.8 + rng.float() * 0.4), P.leafTile ?? TILE.small, lc, canopy, H, rng, 0.8);
  }
  return { bark: B.geometry(), leaves: L.geometry(), height: H * 1.05, crown: R, trunkR: 0 };
}

// ---------------------------------------------------------------------------
const C = (h) => new THREE.Color(h);

/**
 * Build one plant variant. pal: { leaf: Color, leaf2?: Color, bark: Color, glow?: Color, accent? }
 */
export function buildPlant(kind, rng, pal = {}, opts = {}) {
  const r = () => rng.float();
  const s = opts.scale || 1;
  switch (kind) {
    case 'broad': return deciduous({ H: (12 + r() * 8) * s, trunkR: (0.36 + r() * 0.22) * s, depth: 3, kids: [7 + Math.floor(r() * 3), 3, 4], angle: 0.8, lenK: 0.62, wiggle: 0.5, trop: 0.07, leafTile: TILE.broad, leafSize: 2.4 * s, leafCol: pal.leaf || C('#4e8a3c'), leafCol2: pal.leaf2, barkCol: pal.bark || C('#5a4a3c'), leafDensity: 0.8, crownStart: 0.35, trunkK: 0.5 }, rng);
    case 'maple': return deciduous({ H: (10.5 + r() * 6) * s, trunkR: (0.3 + r() * 0.16) * s, depth: 3, kids: [6 + Math.floor(r() * 3), 3, 4], angle: 0.85, lenK: 0.66, wiggle: 0.65, trop: 0.05, leafTile: TILE.maple, leafSize: 2.1 * s, leafCol: pal.leaf || C('#b8322a'), leafCol2: pal.leaf2, barkCol: pal.bark || C('#3e3430'), leafDensity: 0.75, crownStart: 0.32, trunkK: 0.45 }, rng);
    case 'golden': return deciduous({ H: (12 + r() * 7) * s, trunkR: (0.34 + r() * 0.16) * s, depth: 3, kids: [7, 3, 3], angle: 0.75, lenK: 0.64, wiggle: 0.55, trop: 0.09, leafTile: TILE.broad, leafSize: 2.2 * s, leafCol: pal.leaf || C('#d8a83a'), leafCol2: pal.leaf2, barkCol: pal.bark || C('#6a6258'), leafDensity: 0.6, crownStart: 0.4, glow: pal.glowAmt || 0.0, trunkK: 0.55 }, rng);
    case 'birch': return deciduous({ H: (11 + r() * 6) * s, trunkR: (0.16 + r() * 0.07) * s, depth: 2, kids: [12 + Math.floor(r() * 4), 5], angle: 0.65, lenK: 0.4, wiggle: 0.5, trop: -0.02, droop: 0.4, leafTile: TILE.small, leafSize: 2.0 * s, leafCol: pal.leaf || C('#8aa83a'), leafCol2: pal.leaf2, barkCol: pal.bark || C('#d8d4c8'), leafDensity: 1.0, crownStart: 0.3, flare: 0.1, leaderLeaves: true, trunkK: 0.95 }, rng);
    case 'biolum': return deciduous({ H: (11 + r() * 9) * s, trunkR: (0.4 + r() * 0.22) * s, depth: 3, kids: [6, 3, 3], angle: 1.0, lenK: 0.7, wiggle: 0.8, trop: 0.02, droop: 0.3, leafTile: TILE.broad, leafSize: 2.3 * s, leafCol: pal.leaf || C('#2f8a5a'), leafCol2: pal.leaf2, barkCol: pal.bark || C('#3a3440'), leafDensity: 0.8, fill: 0.6, crownStart: 0.4, glow: pal.glowAmt ?? 0.6, strands: 22, strandLen: 4.5 * s, strandCol: pal.glow || C('#5ae0ff'), strandGlow: 1.6, flare: 0.6, trunkK: 0.5 }, rng);
    case 'willow': return deciduous({ H: (8 + r() * 4) * s, trunkR: (0.4 + r() * 0.15) * s, depth: 2, kids: [7, 4], angle: 1.0, lenK: 0.7, wiggle: 0.6, trop: 0.05, leafTile: TILE.small, leafSize: 1.6 * s, leafCol: pal.leaf || C('#7a9a4a'), barkCol: pal.bark || C('#4a4238'), leafDensity: 0.7, crownStart: 0.4, strands: 26, strandLen: 4.2 * s, strandCol: (pal.leaf || C('#7a9a4a')).clone().multiplyScalar(0.8), trunkK: 0.45 }, rng);
    case 'conifer': return conifer({ H: (13 + r() * 10) * s, trunkR: (0.3 + r() * 0.12) * s, width: 0.2 + r() * 0.06, whorls: 13 + Math.floor(r() * 5), perWhorl: 6, droop: 0.35, leafSize: 1.9 * s, leafCol: pal.leaf || C('#2f4a2c'), barkCol: pal.bark || C('#4a3a30'), snow: pal.snow || 0 }, rng);
    case 'pine': return conifer({ H: (10 + r() * 6) * s, trunkR: (0.3 + r() * 0.1) * s, width: 0.34 + r() * 0.1, whorls: 7 + Math.floor(r() * 3), perWhorl: 5, droop: -0.05, shape: 0.35, clearTrunk: 0.5, pads: true, leafSize: 2.0 * s, leafCol: pal.leaf || C('#2a3a28'), barkCol: pal.bark || C('#5a4034') }, rng);
    case 'palm': return palm({ H: (8 + r() * 7) * s, trunkR: 0.22 * s, frond: 4.2 * s, leafCol: pal.leaf || C('#4a8a3a'), barkCol: pal.bark || C('#7a6a52') }, rng);
    case 'fungus': return fungus({ H: (5 + r() * 9) * s, trunkR: (0.35 + r() * 0.35) * s, cap: (3 + r() * 4) * s, capH: 0.3 + r() * 0.3, capCol: pal.leaf || C('#c8b48a'), barkCol: pal.bark || C('#e0d8c4'), gillCol: pal.leaf2, gillGlow: pal.glowAmt ?? 0, spotGlow: (pal.glowAmt ?? 0) * 0.5, stemGlow: (pal.glowAmt ?? 0) * 0.08 }, rng);
    case 'coral': return coral({ H: (5 + r() * 5) * s, trunkR: (0.3 + r() * 0.15) * s, barkCol: pal.bark || C('#d88a9a'), tipCol: pal.leaf || C('#f0c8a0'), tipGlow: pal.glowAmt ?? 0.3 }, rng);
    case 'cactus': return cactus({ H: (2.5 + r() * 4) * s, trunkR: (0.22 + r() * 0.12) * s, barkCol: pal.bark || C('#5a7a4a') }, rng);
    case 'scrub': return scrub({ H: (0.8 + r() * 1.2) * s, trunkR: 0.05 * s, leafSize: 0.95 * s, leafCol2: pal.leaf2, leafCol: pal.leaf || C('#6a7a4a'), barkCol: pal.bark || C('#5a4a3a'), leafTile: pal.tile }, rng);
    case 'giant': {
      const st = opts.style || 'broad';
      const base = { broad: 'broad', golden: 'golden', biolum: 'biolum', maple: 'maple' }[st] || 'broad';
      const P = {
        H: opts.H || 60, trunkR: (opts.H || 60) * 0.06, depth: 3, kids: [9, 4, 3], angle: 0.85, lenK: 0.62, wiggle: 0.45, trop: base === 'golden' ? 0.14 : 0.05,
        leafTile: base === 'maple' ? TILE.maple : TILE.broad, leafSize: (opts.H || 60) * 0.12, leafCol: pal.leaf || C('#4e8a3c'), leafCol2: pal.leaf2,
        barkCol: pal.bark || C('#5a4a3c'), leafDensity: 0.9, crownStart: 0.3, flare: 0.9, glow: pal.glowAmt || 0, trunkK: 0.5,
        strands: base === 'biolum' ? 90 : 0, strandLen: (opts.H || 60) * 0.3, strandCol: pal.glow, strandGlow: 2.2,
      };
      return deciduous(P, rng);
    }
    default: return deciduous({ H: 10 * s, trunkR: 0.35 * s, depth: 2, kids: [6, 3], angle: 0.8, lenK: 0.6, wiggle: 0.5, trop: 0.06, leafTile: TILE.broad, leafSize: 2 * s, leafCol: C('#4e8a3c'), barkCol: C('#5a4a3c'), leafDensity: 0.6 }, rng);
  }
}
