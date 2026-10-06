// People — villagers walking the streets, idling on plazas, as one instanced
// mesh. The figure is generated in code (robe, torso, legs, arms, head, hat)
// and animated on the GPU: legs and arms swing about hip/shoulder pivots by a
// per-instance gait phase, the body bobs. CPU only advances each walker along
// its street polyline (precomputed ground samples), O(n) with tiny constants.

import * as THREE from 'three';
import { Random } from '../../../core/Random.js';

const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _up = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3();
const _m = new THREE.Matrix4();

// part ids: 0 torso/robe, 1 left leg, 2 right leg, 3 left arm, 4 right arm, 5 head (skin), 6 hat/hair
function figureGeometry(style) {
  const P = [], N = [], A = [];
  const box = (x0, y0, z0, x1, y1, z1, part, taper = 0) => {
    const v = [
      [x0 + taper, y1, z0 + taper * 0.5], [x1 - taper, y1, z0 + taper * 0.5], [x1 - taper, y1, z1 - taper * 0.5], [x0 + taper, y1, z1 - taper * 0.5],
      [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    ];
    const faces = [[3, 2, 1, 0, [0, 1, 0]], [4, 5, 6, 7, [0, -1, 0]], [7, 6, 2, 3, [0, 0, 1]], [5, 4, 0, 1, [0, 0, -1]], [6, 5, 1, 2, [1, 0, 0]], [4, 7, 3, 0, [-1, 0, 0]]];
    for (const [a, b, c, d, n] of faces) {
      for (const i of [a, b, c, a, c, d]) { P.push(...v[i]); N.push(...n); A.push(part); }
    }
  };
  const lathe = (prof, segs, part, cx = 0, cz = 0) => {
    for (let j = 0; j < prof.length - 1; j++) for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
      const [r0, y0] = prof[j], [r1, y1] = prof[j + 1];
      const p = (r, y, a) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
      const dr = r1 - r0, dy = y1 - y0, l = Math.hypot(dr, dy) || 1;
      const n = (a) => [Math.cos(a) * dy / l, -dr / l, Math.sin(a) * dy / l];
      const quad = [[r0, y0, a0], [r0, y0, a1], [r1, y1, a1], [r0, y0, a0], [r1, y1, a1], [r1, y1, a0]];
      for (const [r, y, a] of quad) { P.push(...p(r, y, a)); N.push(...n(a)); A.push(part); }
    }
  };
  const robe = style === 'temple' || style === 'monolithic' || style === 'organic';
  // legs
  box(-0.17, 0.0, -0.08, -0.03, 0.9, 0.08, 1);
  box(0.03, 0.0, -0.08, 0.17, 0.9, 0.08, 2);
  if (robe) lathe([[0.2, 0.2], [0.26, 0.5], [0.22, 1.0], [0.2, 1.38], [0.12, 1.46]], 8, 0);
  else {
    box(-0.2, 0.86, -0.12, 0.2, 1.42, 0.12, 0, 0.03);
    lathe([[0.22, 0.62], [0.21, 0.95]], 8, 0); // skirt/coat hem
  }
  // arms
  box(-0.29, 0.82, -0.06, -0.19, 1.4, 0.06, 3);
  box(0.19, 0.82, -0.06, 0.29, 1.4, 0.06, 4);
  // head
  lathe([[0.02, 1.46], [0.1, 1.5], [0.115, 1.6], [0.1, 1.7], [0.02, 1.75]], 7, 5);
  // hat / hood
  if (style === 'temple') lathe([[0.3, 1.66], [0.22, 1.7], [0.02, 1.84]], 9, 6); // conical straw hat
  else if (style === 'monolithic') lathe([[0.14, 1.5], [0.13, 1.7], [0.06, 1.8], [0.01, 1.82]], 7, 6); // hood
  else if (style === 'outpost') lathe([[0.15, 1.48], [0.16, 1.62], [0.13, 1.76], [0.02, 1.8]], 8, 6); // helmet
  else lathe([[0.12, 1.66], [0.12, 1.74], [0.02, 1.78]], 7, 6);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(A, 1));
  g.computeBoundingSphere();
  return g;
}

function figureMaterial(timeU) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uPTime = timeU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aPart; attribute vec4 aWalk; uniform float uPTime; varying float vPart; varying vec3 vSkin;
mat3 rotX(float a){ float c = cos(a), s = sin(a); return mat3(1.0,0.0,0.0, 0.0,c,s, 0.0,-s,c); }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
float gait = aWalk.x + uPTime * aWalk.y * 5.2;
float amp = clamp(aWalk.y, 0.0, 1.0) * 0.55;
float idle = 1.0 - clamp(aWalk.y * 4.0, 0.0, 1.0);
float sw = sin(gait);
float ang = 0.0; vec3 piv = vec3(0.0);
if (aPart > 0.5 && aPart < 1.5) { ang = sw * amp; piv = vec3(0.0, 0.9, 0.0); }
else if (aPart > 1.5 && aPart < 2.5) { ang = -sw * amp; piv = vec3(0.0, 0.9, 0.0); }
else if (aPart > 2.5 && aPart < 3.5) { ang = -sw * amp * 0.8 + idle * 0.15 * sin(uPTime * 0.7 + aWalk.x); piv = vec3(0.0, 1.38, 0.0); }
else if (aPart > 3.5 && aPart < 4.5) { ang = sw * amp * 0.8 - idle * (0.2 + 0.6 * step(0.7, fract(aWalk.x * 3.1)) * (0.5 + 0.5 * sin(uPTime * 1.3 + aWalk.x * 7.0))); piv = vec3(0.0, 1.38, 0.0); }
mat3 R = rotX(ang);
objectNormal = R * objectNormal;
vPart = aPart; vSkin = vec3(aWalk.z);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
transformed = R * (transformed - piv) + piv;
transformed.y += abs(cos(gait)) * 0.04 * amp * 2.0 + idle * 0.01 * sin(uPTime * 1.1 + aWalk.x);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPart; varying vec3 vSkin;')
      .replace('#include <color_fragment>', `#include <color_fragment>
if (vPart > 4.5 && vPart < 5.5) diffuseColor.rgb = mix(vec3(0.62, 0.42, 0.3), vec3(0.28, 0.17, 0.11), vSkin.x);
else if (vPart > 0.5 && vPart < 2.5) diffuseColor.rgb *= 0.45;
else if (vPart > 5.5) diffuseColor.rgb = diffuseColor.rgb * 0.5 + vec3(0.12, 0.1, 0.08);`);
  };
  m.customProgramCacheKey = () => 'civ-people';
  return m;
}

const CLOTHES = {
  pastoral: ['#3d6a8a', '#a8432f', '#e8e0cc', '#4a6a3a', '#c8a050', '#6a4a7a', '#2a3a5a', '#b86a3a'],
  temple: ['#2a2a2a', '#8e1f18', '#d8d0c0', '#4a4a3a', '#6a5a3a', '#3a4a5a'],
  monolithic: ['#3a3028', '#6a5a48', '#2a2420', '#8a7a62', '#1e2a30', '#5a2a1a'],
  organic: ['#2f6a6a', '#6a3a7a', '#c8b88a', '#3a5a3a', '#8a5a4a'],
  outpost: ['#d8d8d4', '#e07a2a', '#3a4a5a', '#c8c040', '#5a5e64'],
  gothic: ['#2a2a30', '#5a1a1a', '#3a3a2a', '#6a6050', '#2a3040'],
  neon: ['#1a1a24', '#3a1a3a', '#c83a6a', '#2a4a6a', '#e8c040', '#6a6a70'],
  ruins: ['#5a5040'],
};

export class People {
  constructor(settlement, ctx) {
    this.s = settlement;
    const frame = settlement.frame, plan = settlement.plan;
    const q = settlement.level.engine.quality;
    const rng = new Random(settlement.seed ^ 0x51ed);
    const style = settlement.styleKey;
    const base = settlement.main ? q.pick(70, 150, 280, 420) : q.pick(30, 60, 110, 160);
    const count = Math.round(base * Math.min(1.4, plan.lots.length / 200 + 0.3));
    this.paths = [];
    // precompute ground samples along each road (local positions & up)
    for (const road of plan.roads) {
      const pts = road.pts;
      const samples = [];
      let acc = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        const L = Math.hypot(bx - ax, bz - az); if (L < 1e-3) continue;
        const n = Math.max(1, Math.ceil(L / 3));
        for (let k = 0; k < n; k++) {
          const t = k / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          samples.push({ x, z, s: acc + L * t });
        }
        acc += L;
      }
      if (acc < 12) continue;
      const last = pts[pts.length - 1];
      samples.push({ x: last[0], z: last[1], s: acc });
      const P = new Float32Array(samples.length * 3), U = new Float32Array(samples.length * 3), S = new Float32Array(samples.length), NX = new Float32Array(samples.length), NZ = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const sm = samples[i];
        frame.ground(sm.x, sm.z, _p, 0.22);
        frame.upAt(sm.x, sm.z, _up);
        P.set([_p.x, _p.y, _p.z], i * 3); U.set([_up.x, _up.y, _up.z], i * 3); S[i] = sm.s;
        const a = samples[Math.max(0, i - 1)], b = samples[Math.min(samples.length - 1, i + 1)];
        const tx = b.x - a.x, tz = b.z - a.z, l = Math.hypot(tx, tz) || 1;
        NX[i] = -tz / l; NZ[i] = tx / l;
      }
      const zone = Math.hypot(pts[0][0] - plan.center[0], pts[0][1] - plan.center[1]) / plan.radius;
      this.paths.push({ P, U, S, NX, NZ, len: acc, w: road.w, weight: (road.kind === 'main' || road.kind === 'avenue' ? 3 : road.kind === 'street' ? 2 : 1) * (1.4 - Math.min(1, zone)) });
    }
    this.n = 0;
    if (!this.paths.length || count <= 0) return;
    this.geo = figureGeometry(style);
    this.mat = figureMaterial(settlement.world.uniforms.uTime);
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const walk = new Float32Array(count * 4);
    const palette = (CLOTHES[style] || CLOTHES.pastoral).map((h) => new THREE.Color(h));
    const totalW = this.paths.reduce((a, p) => a + p.weight * p.len, 0);
    this.agents = [];
    for (let i = 0; i < count; i++) {
      // pick a path weighted by importance × length
      let r = rng.float() * totalW, path = this.paths[0];
      for (const p of this.paths) { r -= p.weight * p.len; if (r <= 0) { path = p; break; } }
      const plazaIdle = rng.chance(0.18);
      const speed = plazaIdle ? 0 : rng.range(0.9, 1.5);
      const a = { path, s: rng.float() * path.len, dir: rng.chance(0.5) ? 1 : -1, speed, off: (rng.range(0.15, 0.48) * (rng.chance(0.5) ? 1 : -1)) * path.w, idx: 0, scale: rng.range(0.9, 1.08) };
      this.agents.push(a);
      walk[i * 4] = rng.float() * 6.28; walk[i * 4 + 1] = speed * 0.82; walk[i * 4 + 2] = rng.float(); walk[i * 4 + 3] = 0;
      mesh.setColorAt(i, palette[rng.int(0, palette.length - 1)].clone().multiplyScalar(rng.range(0.7, 1.1)));
    }
    // idle groups gather at plazas
    let gi = 0;
    for (const a of this.agents) {
      if (a.speed > 0) continue;
      const pz = plan.plazas[gi++ % plan.plazas.length];
      const ang = rng.range(0, Math.PI * 2), rr = rng.range(2, pz.r * 0.8);
      const x = pz.x + Math.cos(ang) * rr, z = pz.z + Math.sin(ang) * rr;
      a.fixed = frame.ground(x, z, new THREE.Vector3(), 0.26);
      a.fixedUp = frame.upAt(x, z, new THREE.Vector3());
      a.yaw = rng.range(0, Math.PI * 2);
    }
    this.geo.setAttribute('aWalk', new THREE.InstancedBufferAttribute(walk, 4));
    mesh.frustumCulled = false;
    mesh.castShadow = false; mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.name = 'civ-people';
    this.mesh = mesh;
    this.n = count;
    settlement.group.add(mesh);
    this._place(0);
    void ctx;
  }

  _place(dt) {
    const mesh = this.mesh;
    for (let i = 0; i < this.n; i++) {
      const a = this.agents[i];
      if (a.fixed) {
        _up.copy(a.fixedUp);
        _f.set(Math.sin(a.yaw), 0, Math.cos(a.yaw)).addScaledVector(_up, -Math.sin(a.yaw) * _up.x - Math.cos(a.yaw) * _up.z).normalize();
        _r.copy(_up).cross(_f).normalize();
        _q.copy(_up).multiplyScalar(a.scale);
        _m.makeBasis(_r.multiplyScalar(a.scale), _q, _f.multiplyScalar(a.scale)).setPosition(a.fixed);
        mesh.setMatrixAt(i, _m);
        continue;
      }
      const p = a.path;
      a.s += a.dir * a.speed * dt;
      if (a.s > p.len - 1) { a.s = p.len - 1; a.dir = -1; a.off = -a.off; }
      if (a.s < 1) { a.s = 1; a.dir = 1; a.off = -a.off; }
      // advance sample index
      let k = a.idx;
      while (k < p.S.length - 2 && p.S[k + 1] < a.s) k++;
      while (k > 0 && p.S[k] > a.s) k--;
      a.idx = k;
      const t = Math.min(1, Math.max(0, (a.s - p.S[k]) / Math.max(1e-3, p.S[k + 1] - p.S[k])));
      const k3 = k * 3, k4 = (k + 1) * 3;
      _p.set(p.P[k3] + (p.P[k4] - p.P[k3]) * t, p.P[k3 + 1] + (p.P[k4 + 1] - p.P[k3 + 1]) * t, p.P[k3 + 2] + (p.P[k4 + 2] - p.P[k3 + 2]) * t);
      _up.set(p.U[k3], p.U[k3 + 1], p.U[k3 + 2]);
      const nx = p.NX[k], nz = p.NZ[k];
      _p.x += nx * a.off; _p.z += nz * a.off;
      // forward = path tangent × dir (tangent = (nz, -nx) since n = (-tz, tx))
      _f.set(nz * a.dir, 0, -nx * a.dir);
      _f.addScaledVector(_up, -_f.dot(_up)).normalize();
      _r.copy(_up).cross(_f).normalize();
      _q.copy(_up).multiplyScalar(a.scale);
      _m.makeBasis(_r.multiplyScalar(a.scale), _q, _f.multiplyScalar(a.scale)).setPosition(_p);
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt, t, camLocal, camDist) {
    if (!this.mesh) return;
    const near = camDist < 2500;
    this.mesh.visible = near;
    if (!near) return;
    this._place(Math.min(dt, 0.1));
    void t; void camLocal;
  }

  dispose() { this.geo?.dispose(); this.mat?.dispose(); this.mesh?.parent?.remove(this.mesh); }
}
