// Traffic — the sky and water above a settlement are never empty: Ghibli
// airships drifting on long loops, ornithopters beating their wings over the
// dunes, shuttles landing on and lifting off the outpost pads, jellyfish
// skyships, sky lanterns rising from temple towns at dusk, and boats working
// the harbour. Vehicles are code-built meshes moved along closed splines.

import * as THREE from 'three';
import { MeshBuilder } from './builder.js';
import { M, W, F } from './ids.js';
import { Random } from '../../../core/Random.js';
import { makeGlowMaterial, makeGlowMesh } from './materials.js';
import { ship } from './styles/outpost.js';
import { boat } from './styles/pastoral.js';

const TAU = Math.PI * 2;
const _w1 = new THREE.Matrix4(), _w2 = new THREE.Matrix4();
const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3(), _m = new THREE.Matrix4(), _s = new THREE.Matrix4();
const col = (h) => new THREE.Color(h);

function zLathe(B, prof, segs) {
  // lathe along local Z: build along Y then rotate
  const M0 = B.m.clone();
  B.setMatrix(M0.clone().multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
  B.lathe(0, 0, prof, { segs });
  B.setMatrix(M0);
}

function airship(rng, pal) {
  const B = new MeshBuilder(2048);
  const L = rng.range(34, 52), R = L * 0.16;
  const env = rng.pick([col('#efe6d2'), col('#d8c8a8'), col('#c8432f'), col('#e8e0cc')]);
  B.mat(M.CLOTH, rng.float(), 0, 3).color(env).ext(1, 0, F.NOWIN, 0);
  const prof = [];
  for (let i = 0; i <= 10; i++) { const t = i / 10; prof.push([Math.max(0.05, Math.sin(Math.PI * Math.pow(t, 0.9)) * R), (t - 0.5) * L]); }
  zLathe(B, prof, 16);
  // stripes
  B.mat(M.CLOTH, 0.3, 0, 3).color(pal.accent || col('#c8432f'));
  for (const z of [-0.18, 0.12]) zLathe(B, [[R * 1.01, z * L], [R * 1.01, (z + 0.05) * L]], 16);
  // fins
  B.mat(M.WOOD, 0.4, 0, 3).color(col('#6a4428'));
  for (let k = 0; k < 4; k++) {
    const a = k * TAU / 4;
    const c = Math.cos(a), s = Math.sin(a);
    const p0 = new THREE.Vector3(c * R * 0.3, s * R * 0.3, -L * 0.48), p1 = new THREE.Vector3(c * R * 1.2, s * R * 1.2, -L * 0.5), p2 = new THREE.Vector3(c * R * 0.9, s * R * 0.9, -L * 0.3), p3 = new THREE.Vector3(c * R * 0.6, s * R * 0.6, -L * 0.28);
    B.quadP(p0, p1, p2, p3, [0, 0], [1, 0], [1, 1], [0, 1]);
    B.quadP(p3, p2, p1, p0, [0, 0], [1, 0], [1, 1], [0, 1]);
  }
  // gondola with lit windows
  B.mat(M.WOOD, 0.4, W.HOUSE, 1.6).color(col('#5a3a24')).ext(1, 0, 0, 0);
  B.box(-R * 0.35, -R - 2.6, -L * 0.18, R * 0.35, -R - 0.4, L * 0.14, { base: -R - 2.6 });
  B.mat(M.IRON, 0.2, 0, 3).color(col('#2a2622')).ext(1, 0, F.NOWIN, 0);
  for (const z of [-L * 0.12, L * 0.08]) B.box(-0.05, -R - 0.4, z - 0.05, 0.05, -R * 0.6, z + 0.05);
  // propellers (static blurred discs)
  B.mat(M.WOOD, 0.4, 0, 3).color(col('#3a2a1a'));
  for (const s of [-1, 1]) {
    B.box(s * R * 0.35, -R - 1.4, -L * 0.17, s * (R * 0.35 + 2.2), -R - 1.2, -L * 0.15);
    B.cylinder(s * (R * 0.35 + 2.2), -L * 0.2, 0.25, 0.25, -R - 1.3 - 0.01, -R - 1.3 + 0.01, { segs: 6 });
  }
  B.mat(M.EMISSIVE, 0.2, 0, 3).color(col('#ffcf87'));
  B.boxC(0, -R - 2.0, L * 0.14 + 0.05, 0.6, 0.6, 0.1);
  return { geo: B.toGeometry(), len: L };
}

function ornithopter(rng, pal) {
  const B = new MeshBuilder(1024);
  const L = rng.range(9, 13);
  B.mat(M.METAL, rng.float(), 0, 3).color(col('#8a7a62')).ext(1, 0, F.NOWIN, 0);
  zLathe(B, [[0.05, -L * 0.5], [L * 0.06, -L * 0.3], [L * 0.1, 0], [L * 0.09, L * 0.25], [L * 0.05, L * 0.42], [0.05, L * 0.5]], 10);
  B.mat(M.GLASS, 0.3, 0, 3).color(col('#0a0c10'));
  B.box(-L * 0.06, L * 0.04, L * 0.12, L * 0.06, L * 0.1, L * 0.38);
  B.mat(M.METAL, 0.3, 0, 3).color(col('#3a3028'));
  B.box(-0.15, -L * 0.12, -L * 0.48, 0.15, L * 0.1, -L * 0.35);
  for (const s of [-1, 1]) B.box(s * L * 0.04, -L * 0.13, -L * 0.2, s * L * 0.06, -L * 0.1, L * 0.25);
  const body = B.toGeometry();
  const Wb = new MeshBuilder(256);
  Wb.mat(M.METAL, 0.5, 0, 3).color(col('#b8ac94')).ext(1, 0, F.NOWIN, 0);
  // one wing, hinged at x = 0, extends +x
  Wb.box(0, -0.04, -L * 0.07, L * 0.55, 0.04, L * 0.07);
  Wb.box(L * 0.1, -0.03, -L * 0.1, L * 0.5, 0.03, -L * 0.07);
  void pal;
  return { geo: body, wing: Wb.toGeometry(), len: L };
}

function jellyship(rng, pal) {
  const B = new MeshBuilder(2048);
  const R = rng.range(9, 15);
  B.mat(M.SHELL, rng.float(), W.PORTHOLE, 3).color(rng.pick(pal.shells || [col('#d6e2d0')])).ext(1, 0, F.FRONT, 0);
  B.lathe(0, 0, [[R * 0.4, -R * 0.2], [R, 0], [R * 0.9, R * 0.5], [R * 0.5, R * 0.85], [0.05, R]], { segs: 16 });
  B.mat(M.EMISSIVE, 0.3, 0, 3).color((pal.glow?.[0] || col('#3ff0ff')).clone().multiplyScalar(0.6));
  B.cylinder(0, 0, R * 0.98, R * 0.98, -0.1, 0.25, { segs: 16 });
  B.mat(M.SHELL, 0.4, 0, 3).color(pal.ribs?.[0] || col('#6a5a48'));
  for (let k = 0; k < 7; k++) {
    const a = k / 7 * TAU;
    const pts = [];
    for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push(new THREE.Vector3(Math.cos(a) * R * (0.6 - t * 0.3), -R * 0.2 - t * R * 1.4, Math.sin(a) * R * (0.6 - t * 0.3) + Math.sin(t * 5) * 0.8)); }
    B.tube(pts, 0.18, 4);
  }
  return { geo: B.toGeometry(), len: R * 2 };
}

/** Closed loop around the settlement at an altitude above the local ground. */
function loopCurve(frame, plan, rng, rMin, rMax, alt, wob = 0.25, n = 10) {
  const pts = [];
  const a0 = rng.range(0, TAU);
  const c = plan.center;
  let hMax = -Infinity;
  for (let k = 0; k < n; k++) {
    const a = a0 + (k / n) * TAU;
    const r = rng.range(rMin, rMax);
    const x = c[0] + Math.cos(a) * r, z = c[1] + Math.sin(a) * r;
    hMax = Math.max(hMax, frame.hAt(x, z), frame.sea);
    pts.push([x, z, (rng.float() - 0.5) * 2 * wob * alt]);
  }
  const P = pts.map(([x, z, dy]) => frame.point(x, z, Math.max(frame.hAt(x, z), frame.sea) * 0.3 + hMax * 0.7 + alt + dy));
  return new THREE.CatmullRomCurve3(P, true, 'centripetal');
}

export class Traffic {
  constructor(settlement, ctx) {
    this.s = settlement;
    this.items = [];
    this.meshes = [];
    const frame = settlement.frame, plan = settlement.plan, pal = ctx.pal;
    const rng = new Random(settlement.seed ^ 0x7aff);
    const style = settlement.styleKey;
    const q = settlement.level.engine.quality;
    const mat = settlement.dynMaterial;
    const Rb = Math.max(150, plan.builtRadius);
    this.group = settlement.group;
    const add = (geo, curve, speed, o = {}) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false; mesh.castShadow = true; mesh.frustumCulled = false;
      this.group.add(mesh); this.meshes.push(mesh);
      const it = { mesh, curve, len: curve.getLength(), u: rng.float(), speed, bank: o.bank ?? 0.3, wings: null, flap: o.flap ?? 0 };
      this.items.push(it);
      return it;
    };
    const n = settlement.main ? q.pick(2, 3, 5, 6) : q.pick(1, 1, 2, 3);
    if (style === 'pastoral' || style === 'gothic' || style === 'neon') {
      for (let i = 0; i < n; i++) {
        const a = airship(rng, pal);
        add(a.geo, loopCurve(frame, plan, rng, Rb * 0.6, Rb * 1.8, rng.range(110, 230), 0.15), rng.range(6, 10), { bank: 0.12 });
      }
    } else if (style === 'monolithic') {
      for (let i = 0; i < n + 1; i++) {
        const o = ornithopter(rng, pal);
        const it = add(o.geo, loopCurve(frame, plan, rng, Rb * 0.4, Rb * 1.5, rng.range(45, 110), 0.4, 8), rng.range(28, 42), { bank: 0.6, flap: 1 });
        it.wings = [];
        for (const [sx, z] of [[1, 0.12], [-1, 0.12], [1, -0.12], [-1, -0.12]]) {
          const wm = new THREE.Mesh(o.wing, mat);
          wm.matrixAutoUpdate = false; wm.frustumCulled = false;
          this.group.add(wm); this.meshes.push(wm);
          it.wings.push({ mesh: wm, sx, z: z * o.len, ph: z > 0 ? 0 : 1.3 });
        }
      }
    } else if (style === 'organic') {
      for (let i = 0; i < n; i++) {
        const j = jellyship(rng, pal);
        add(j.geo, loopCurve(frame, plan, rng, Rb * 0.5, Rb * 1.6, rng.range(70, 160), 0.3, 8), rng.range(3, 6), { bank: 0.05 });
      }
    }
    if (style === 'outpost' || ctx.pads?.length) {
      // shuttles cycling between orbit and the pads
      const pads = ctx.pads || [];
      pal.panels ||= [col('#d6dade'), col('#c9cdd1'), col('#e2e4e4'), col('#b8bec4')];
      pal.dark ||= col('#2e3238');
      for (let i = 0; i < Math.min(pads.length, n); i++) {
        const B = new MeshBuilder(2048);
        ship(B, 0, 0, 0, rng.range(14, 22), pal, rng);
        B.mat(M.EMISSIVE, 0.2, 0, 3).color(col('#9fd8ff')).ext(1, 0, F.NOWIN, 0);
        for (const s of [-1, 1]) B.cylinder(s * 6, -2.5, 0.8, 0.5, 0.6, 0.9, { segs: 8, top: true });
        const geo = B.toGeometry();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; mesh.castShadow = true;
        this.group.add(mesh); this.meshes.push(mesh);
        const pd = pads[i];
        this.items.push({ mesh, shuttle: true, pad: pd, ph: rng.float(), period: rng.range(70, 110), yaw: rng.float() * TAU });
      }
      // a heavy freighter crossing high above
      if (style === 'outpost' || settlement.kind === 'spaceport') {
        const B = new MeshBuilder(2048);
        ship(B, 0, 0, 0, 70, pal, rng);
        add(B.toGeometry(), loopCurve(frame, plan, rng, Rb * 1.5, Rb * 3, 420, 0.1, 6), 22, { bank: 0.05 });
      }
    }
    // sky lanterns rising at dusk (temple worlds)
    if (style === 'temple') {
      const cnt = q.pick(30, 60, 120, 160);
      this.lanternMat = makeGlowMaterial(settlement.uniforms, { size: 0.9, minPx: 1.4, gain: 6 });
      const items = [];
      this.lanterns = [];
      for (let i = 0; i < cnt; i++) {
        const a = rng.range(0, TAU), r = Math.sqrt(rng.float()) * Rb * 0.9;
        const x = plan.center[0] + Math.cos(a) * r, z = plan.center[1] + Math.sin(a) * r;
        const h0 = frame.hAt(x, z);
        const L = { x, z, h0, y: rng.range(0, 260), v: rng.range(0.8, 1.6), dx: rng.range(-0.6, 0.6), dz: rng.range(-0.6, 0.6) };
        this.lanterns.push(L);
        items.push({ position: frame.point(x, z, h0 + L.y), color: col(rng.chance(0.8) ? '#ff9a3a' : '#ffc870'), phase: 0.5 + rng.float() * 0.9, scale: 0.8 });
      }
      this.lanternMesh = makeGlowMesh(this.lanternMat, items);
      this.lanternMesh.matrixAutoUpdate = false; this.lanternMesh.frustumCulled = false;
      this.group.add(this.lanternMesh); this.meshes.push(this.lanternMesh);
    }
    // boats on the water near the harbour
    if (plan.shore || plan.docks.length) {
      const sh = plan.shore || [plan.docks[0].x, plan.docks[0].z];
      const P = [];
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * TAU;
        for (const rr of [90, 70, 55, 40]) {
          const x = sh[0] + Math.cos(a) * rr, z = sh[1] + Math.sin(a) * rr;
          if (frame.hAt(x, z) < frame.sea - 1.5) { P.push(frame.point(x, z, frame.sea + 0.05)); break; }
        }
      }
      if (P.length >= 6) {
        const curve = new THREE.CatmullRomCurve3(P, true, 'centripetal');
        for (let i = 0; i < Math.min(3, n); i++) {
          const B = new MeshBuilder(1024);
          boat(B, 0, 0, 0, rng, pal, rng.range(6, 9));
          B.mat(M.CLOTH, 0.4, 0, 3).color(col('#efe6d2')).ext(1, 0, F.NOWIN, 0);
          const p0 = new THREE.Vector3(0, 0.3, -1.2), p1 = new THREE.Vector3(0, 7, -0.6), p2 = new THREE.Vector3(0, 0.8, 2.6);
          B.triP(p0, p2, p1, [0, 0], [1, 0], [0, 1]); B.triP(p0, p1, p2, [0, 0], [0, 1], [1, 0]);
          const it = add(B.toGeometry(), curve, rng.range(2, 3.5), { bank: 0 });
          it.boat = true;
        }
      }
    }
  }

  update(dt, t, camLocal, camDist) {
    const vis = camDist < 12000;
    for (const m of this.meshes) m.visible = vis;
    if (!vis) return;
    const frame = this.s.frame;
    for (const it of this.items) {
      if (it.shuttle) { this._shuttle(it, t); continue; }
      it.u = (it.u + (it.speed * dt) / it.len) % 1;
      it.curve.getPointAt(it.u, _p);
      it.curve.getTangentAt(it.u, _t);
      // local up ≈ radial up at the point
      _u.set(_p.x / (frame.R + frame.h0), 1 + _p.y / (frame.R + frame.h0), _p.z / (frame.R + frame.h0)).normalize();
      // bank into the turn
      const u2 = (it.u + 0.01) % 1;
      const t2 = it.curve.getTangentAt(u2, _r);
      const turn = _t.x * t2.z - _t.z * t2.x;
      _r.copy(_u).cross(_t).normalize();
      _u.applyAxisAngle(_t, -turn * it.bank * 40);
      _r.copy(_u).cross(_t).normalize();
      _u.copy(_t).cross(_r).normalize();
      if (it.boat) { _p.y += Math.sin(t * 1.3 + it.u * 40) * 0.12; }
      _m.makeBasis(_r, _u, _t).setPosition(_p);
      it.mesh.matrix.copy(_m); it.mesh.matrixWorldNeedsUpdate = true;
      if (it.wings) {
        for (const w of it.wings) {
          const a = Math.sin(t * 22 + w.ph) * 0.45 * w.sx;
          _s.makeTranslation(0, 0.6, w.z).multiply(_w1.makeRotationZ(a)).multiply(_w2.makeScale(w.sx, 1, 1));
          w.mesh.matrix.multiplyMatrices(_m, _s); w.mesh.matrixWorldNeedsUpdate = true;
        }
      }
    }
    if (this.lanterns) {
      const night = this.s.uniforms.uCivNight.value;
      const mesh = this.lanternMesh;
      for (let i = 0; i < this.lanterns.length; i++) {
        const L = this.lanterns[i];
        L.y += L.v * dt * (0.4 + night);
        if (L.y > 320) L.y = 0;
        const x = L.x + L.dx * L.y * 0.4, z = L.z + L.dz * L.y * 0.4;
        frame.point(x, z, L.h0 + 2 + L.y, _p);
        const s = 1 - Math.max(0, (L.y - 240) / 80);
        _m.makeScale(s, s, s).setPosition(_p);
        mesh.setMatrixAt(i, _m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  _shuttle(it, t) {
    const frame = this.s.frame;
    const ph = ((t / it.period) + it.ph) % 1;
    // 0–0.35 parked, 0.35–0.55 lift off, 0.55–0.8 away (hidden), 0.8–1 descend
    let alt = 0, vis = true;
    if (ph < 0.35) alt = 0;
    else if (ph < 0.55) { const k = (ph - 0.35) / 0.2; alt = k * k * 900; }
    else if (ph < 0.8) vis = false;
    else { const k = 1 - (ph - 0.8) / 0.2; alt = k * k * 900; }
    it.mesh.visible = vis;
    if (!vis) return;
    frame.placement(it.pad.x, it.pad.z, it.pad.h + alt, it.yaw + alt * 0.002, _m);
    it.mesh.matrix.copy(_m); it.mesh.matrixWorldNeedsUpdate = true;
  }

  dispose() {
    for (const m of this.meshes) { m.parent?.remove(m); m.geometry?.dispose(); }
    this.lanternMat?.dispose();
  }
}
