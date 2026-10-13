// Small life — butterflies dancing over the meadows by day (glowing moths on
// luminous worlds at night), fish schools gliding through sunlit shallows.
// Both live in a small ring around the camera, re-homed as it moves; wings and
// tails animate on the GPU, paths are cheap analytic curves on the CPU.
import * as THREE from 'three';
import { Random, seedFrom } from '../../../core/Random.js';
import { TAU, clamp, smooth, lerp, rigMaterial, paint, mergeParts, blob, membrane, tangentBasis, writeInstance, makeInstanced } from './common.js';

const FLY_RIG = /* glsl */ `
void rig(inout vec3 p, inout vec3 n) {
  if (aRig.x > 0.5) {
    float s = p.x < 0.0 ? -1.0 : 1.0;
    float a = (sin(aAnim.x) * 0.95 + 0.35) * aAnim.y;
    vec2 v = fa_rot(vec2(abs(p.x), p.y), a);
    p.x = s * v.x; p.y = v.y;
  }
}
`;
const FISH_RIG = /* glsl */ `
void rig(inout vec3 p, inout vec3 n) {
  float t = clamp(-p.z / 0.5 + 0.5, 0.0, 1.0); // 0 head .. 1 tail
  p.x += sin(aAnim.x - t * 4.0) * 0.12 * t * t * aAnim.y;
}
`;

const PALETTES = {
  ghibli: ['#ffffff', '#ffd23a', '#7ab8ff', '#ff8a3a'], wukong: ['#ff5a2a', '#f8e8c8', '#2a2a2a'], pandora: ['#3fe8ff', '#c04bff', '#5aff9a'],
  erdtree: ['#ffd27a', '#fff2c8'], moebius: ['#3fb0a6', '#ff9a7a'], tarkovsky: ['#e8e4d8', '#c8a050'], ueda: ['#f8f4e8', '#e8c860'],
};
const MEADOWS = ['ghibli', 'wukong', 'pandora', 'erdtree', 'moebius', 'tarkovsky', 'ueda', 'nausicaa', 'rick'];

function buildButterfly() {
  const parts = [];
  for (const s of [-1, 1]) {
    const fore = [[0.005, 0.01], [0.05, 0.05], [0.075, 0.03], [0.07, -0.005], [0.02, -0.01]].map(([x, z]) => [x * s, z]);
    const hind = [[0.005, -0.005], [0.05, -0.02], [0.055, -0.045], [0.03, -0.05], [0.01, -0.03]].map(([x, z]) => [x * s, z]);
    for (const o of [fore, hind]) parts.push(paint(membrane(o), (p) => { const e = smooth(0.04, 0.07, Math.hypot(p.x, p.z)); return [1 - e * 0.85, 1 - e * 0.85, 1 - e * 0.85]; }, () => [1, 0, 0, 0], (p) => smooth(0.05, 0.075, Math.hypot(p.x, p.z)) * 0.8));
  }
  const b = blob(0.006, 0.006, 0.03, null, 5, 4);
  parts.push(paint(b, () => [0.05, 0.04, 0.03], () => [0, 0, 0, 0]));
  return mergeParts(parts);
}

function buildFish() {
  const parts = [];
  const body = blob(0.05, 0.08, 0.25, (z) => 1 - 0.6 * smooth(0, -1, z) , 10, 8);
  parts.push(paint(body, (p, n) => { const t = smooth(-0.5, 0.5, n.y); return [lerp(0.85, 0.2, t), lerp(0.85, 0.3, t), lerp(0.8, 0.32, t)]; }, () => [0, 0, 0, 0]));
  const tail = membrane([[0, -0.22], [0.0, -0.22], [0.0, -0.34], [0, -0.3]], 0);
  tail.rotateZ(Math.PI / 2);
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.22, 0, 0.07, -0.33, 0, -0.07, -0.33], 3));
  tg.setAttribute('normal', new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0], 3));
  tail.dispose();
  parts.push(paint(tg, () => [0.3, 0.35, 0.36], () => [0, 0, 0, 0]));
  return mergeParts(parts);
}

// Fireflies: additive HDR motes hovering over the grass from dusk on, each with its own slow blink.
const FIREFLY_VERT = /* glsl */ `
attribute vec4 aHome; // xyz relative to the fauna anchor, w seed
uniform float uFTime; uniform float uOn;
varying vec2 vUv; varying float vB;
void main() {
  float sd = aHome.w * 97.0, t = uFTime;
  vec3 up = normalize(aHome.xyz + modelMatrix[3].xyz);
  vec3 c = aHome.xyz + vec3(sin(t * 0.31 + sd) * 1.6 + sin(t * 0.9 + sd * 2.0) * 0.4, 0.0, cos(t * 0.27 + sd * 3.0) * 1.6 + cos(t * 1.1 + sd) * 0.4);
  c += up * (0.5 + 0.9 * (0.5 + 0.5 * sin(t * 0.43 + sd * 5.0)));
  // asymmetric duty cycle: a ~0.4 s flash, then 1.5–5 s dark (real Photinus rhythm)
  float period = 1.9 + 3.6 * fract(sd * 0.37);
  float ph = fract(t / period + aHome.w * 13.0);
  float on = 0.4 / period;
  vB = smoothstep(0.0, on * 0.25, ph) * (1.0 - smoothstep(on * 0.35, on, ph)) * uOn;
  vUv = position.xy;
  vec4 mv = modelViewMatrix * vec4(c, 1.0);
  // a tiny HDR point core (~2 px) whatever the distance: bloom draws the halo, not a big sprite
  float sz = min(0.22, 12.0 * max(-mv.z, 0.1) / (projectionMatrix[1][1] * 450.0));
  vB *= 0.22 / max(sz, 1e-3) > 1.0 ? mix(1.0, 2.2, smoothstep(1.0, 4.0, 0.22 / max(sz, 1e-3))) : 1.0;
  mv.xy += position.xy * sz * step(0.002, vB);
  gl_Position = projectionMatrix * mv;
}
`;
const FIREFLY_FRAG = /* glsl */ `
uniform vec3 uColor; varying vec2 vUv; varying float vB;
void main() {
  float r = length(vUv);
  float core = exp(-r * r * 40.0), halo = exp(-r * r * 6.0) * 0.12;
  float a = (core + halo) * vB;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * a, 1.0);
}
`;
const FIREFLY_COL = { pandora: '#5affd8', rick: '#b8ff5a', moebius: '#ffe28a', default: '#d8ff6a' };

const _u = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _p = new THREE.Vector3(), _f = new THREE.Vector3();

export class SmallLife {
  constructor(fauna) {
    this.fauna = fauna; this.world = fauna.world;
    const A = fauna.aesthetic;
    this.rng = new Random(seedFrom(fauna.seed, 'small'));
    if (MEADOWS.includes(A)) {
      const geo = buildButterfly();
      const uni = { uFTime: fauna.uniforms.uFTime, uGlowColor: { value: new THREE.Color(0, 0, 0) } };
      const mats = rigMaterial({ roughness: 0.6, side: THREE.DoubleSide }, FLY_RIG, uni, 'butterfly');
      this.bMax = fauna.q.pick(12, 24, 36, 48);
      const { mesh, anim } = makeInstanced(geo, mats, this.bMax, { shadow: false });
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.bMax * 3).fill(1), 3);
      fauna.root.add(mesh);
      this.b = { mesh, anim, uni, list: [], pal: (PALETTES[A] || PALETTES.ghibli).map((h) => new THREE.Color(h)), glow: A === 'pandora' || A === 'rick' };
    }
    if (MEADOWS.includes(A)) {
      const n = fauna.q.pick(90, 180, 300, 420);
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const home = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4); home.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aHome', home); g.instanceCount = 0;
      const uni = { uFTime: fauna.uniforms.uFTime, uOn: { value: 0 }, uColor: { value: new THREE.Color(FIREFLY_COL[A] || FIREFLY_COL.default).multiplyScalar(14) } };
      const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: FIREFLY_VERT, fragmentShader: FIREFLY_FRAG, uniforms: uni, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      mesh.frustumCulled = false; mesh.renderOrder = 4;
      fauna.root.add(mesh);
      this.ff = { mesh, geo: g, home, uni, n, abs: [], center: null, anchor: new THREE.Vector3(1e9, 0, 0) };
    }
    if (this.world.hasOcean) {
      const geo = buildFish();
      const uni = { uFTime: fauna.uniforms.uFTime, uGlowColor: { value: new THREE.Color(0, 0, 0) } };
      const mats = rigMaterial({ roughness: 0.35, metalness: 0.2 }, FISH_RIG, uni, 'fish');
      this.fMax = fauna.q.pick(30, 60, 90, 120);
      const { mesh, anim } = makeInstanced(geo, mats, this.fMax, { shadow: false });
      fauna.root.add(mesh);
      this.fish = { mesh, anim, schools: [], key: null };
    }
  }

  _homeButterflies(cam) {
    const w = this.world, R = w.radius, rng = this.rng;
    const B = this.b;
    _u.copy(cam).normalize(); tangentBasis(_u, _t1, _t2);
    while (B.list.length < this.bMax) B.list.push({});
    for (const bf of B.list) {
      if (bf.home && bf.home.distanceTo(cam) < 45) continue;
      // place within 8–40 m on dry ground
      for (let k = 0; k < 4; k++) {
        const a = rng.range(0, TAU), r = rng.range(6, 38);
        const d = _p.copy(_u).multiplyScalar(R).addScaledVector(_t1, Math.cos(a) * r).addScaledVector(_t2, Math.sin(a) * r).normalize();
        const h = w.heightAt(d);
        if (w.hasOcean && h < w.seaLevel + 0.5) continue;
        bf.home = d.clone().multiplyScalar(R + h + 0.6);
        bf.up = d.clone();
        bf.seed = rng.float(); bf.col = rng.int(0, B.pal.length - 1); bf.size = rng.range(0.8, 1.5);
        break;
      }
    }
  }

  update(dt, cam) {
    const fa = this.fauna, t = fa.time, anchor = fa.anchor, w = this.world;
    const alt = w.altitude(cam);
    if (this.b) {
      const B = this.b;
      const on = alt < 120 && (fa.night < 0.6 || B.glow);
      let n = 0;
      if (on) {
        this._homeButterflies(cam);
        const arr = B.mesh.instanceMatrix.array, an = B.anim.array, col = B.mesh.instanceColor.array;
        for (const bf of B.list) {
          if (!bf.home) continue;
          const s = bf.seed * 100, tt = t * (0.6 + bf.seed * 0.5);
          tangentBasis(bf.up, _t1, _t2);
          // erratic fluttering loops
          const x = Math.sin(tt * 0.7 + s) * 2.5 + Math.sin(tt * 2.3 + s * 2) * 0.5;
          const z = Math.cos(tt * 0.5 + s * 3) * 2.5 + Math.cos(tt * 1.9 + s) * 0.5;
          const y = 0.4 + Math.abs(Math.sin(tt * 1.4 + s)) * 0.9;
          _p.copy(bf.home).addScaledVector(_t1, x).addScaledVector(_t2, z).addScaledVector(bf.up, y);
          const dx = Math.cos(tt * 0.7 + s) * 0.7 * 2.5, dz = -Math.sin(tt * 0.5 + s * 3) * 0.5 * 2.5;
          _f.copy(_t1).multiplyScalar(dx).addScaledVector(_t2, dz);
          writeInstance(arr, n, _p, anchor, _f, bf.up, bf.size);
          an[n * 4] = t * 22 + s; an[n * 4 + 1] = 1; an[n * 4 + 2] = 0; an[n * 4 + 3] = 0;
          const c = B.pal[bf.col]; col[n * 3] = c.r; col[n * 3 + 1] = c.g; col[n * 3 + 2] = c.b;
          n++;
        }
        B.mesh.instanceMatrix.needsUpdate = true; B.anim.needsUpdate = true; B.mesh.instanceColor.needsUpdate = true;
        if (B.glow) B.uni.uGlowColor.value.copy(B.pal[0]).multiplyScalar(0.1 + 4 * fa.night);
      }
      B.mesh.count = n;
    }
    if (this.fish) this._updateFish(dt, cam, alt);
    if (this.ff) this._updateFireflies(cam, alt);
  }

  _updateFireflies(cam, alt) {
    const F = this.ff, fa = this.fauna, w = this.world, R = w.radius;
    const on = smooth(0.18, 0.45, fa.night) * (alt < 150 ? 1 : 0);
    F.uni.uOn.value = on;
    F.mesh.visible = on > 0.01;
    if (!F.mesh.visible) return;
    if (!F.center || F.center.distanceTo(cam) > 30) {
      // deterministic swarm over dry, open ground within ~50 m (re-seeded per 40 m cell)
      _u.copy(cam).normalize(); tangentBasis(_u, _t1, _t2);
      const key = `${Math.round(_u.x * R / 40)},${Math.round(_u.y * R / 40)},${Math.round(_u.z * R / 40)}`;
      const rng = new Random(seedFrom(fa.seed, 'ff', key));
      F.center = cam.clone(); F.abs.length = 0;
      for (let i = 0; i < F.n * 2 && F.abs.length < F.n * 2; i++) {
        const a = rng.range(0, TAU), r = 3 + Math.pow(rng.float(), 0.7) * 50;
        const d = _p.copy(_u).multiplyScalar(R).addScaledVector(_t1, Math.cos(a) * r).addScaledVector(_t2, Math.sin(a) * r).normalize();
        const h = w.heightAt(d);
        if (w.hasOcean && h < w.seaLevel + 0.3) continue;
        F.abs.push(d.clone().multiplyScalar(R + h), rng.float());
      }
      F.anchor.set(1e9, 0, 0);
    }
    if (!F.anchor.equals(fa.anchor)) {
      F.anchor.copy(fa.anchor);
      const a = F.home.array; let k = 0;
      for (let i = 0; i + 1 < F.abs.length; i += 2) { const p = F.abs[i]; a[k++] = p.x - fa.anchor.x; a[k++] = p.y - fa.anchor.y; a[k++] = p.z - fa.anchor.z; a[k++] = F.abs[i + 1]; }
      F.geo.instanceCount = k / 4; F.home.needsUpdate = true;
    }
  }

  _updateFish(dt, cam, alt) {
    const F = this.fish, w = this.world, R = w.radius, fa = this.fauna, t = fa.time;
    if (alt > 80) { F.mesh.count = 0; return; }
    _u.copy(cam).normalize();
    const key = `${Math.round(_u.x * R / 80)},${Math.round(_u.y * R / 80)},${Math.round(_u.z * R / 80)}`;
    if (key !== F.key) {
      F.key = key; F.schools.length = 0;
      const rng = new Random(seedFrom(fa.seed, 'fish', key));
      tangentBasis(_u, _t1, _t2);
      for (let k = 0; k < 14 && F.schools.length < 3; k++) {
        const a = rng.range(0, TAU), r = rng.range(8, 70);
        const d = _p.copy(_u).multiplyScalar(R).addScaledVector(_t1, Math.cos(a) * r).addScaledVector(_t2, Math.sin(a) * r).normalize();
        const depth = w.seaLevel - w.heightAt(d);
        if (depth < 0.8 || depth > 6) continue;
        F.schools.push({ c: d.clone().multiplyScalar(R + w.seaLevel - Math.min(depth * 0.5, 1.2)), up: d.clone(), n: rng.int(10, 26), seed: rng.float(), r: rng.range(2, 5) });
      }
    }
    const arr = F.mesh.instanceMatrix.array, an = F.anim.array, anchor = fa.anchor;
    let n = 0;
    for (const s of F.schools) {
      tangentBasis(s.up, _t1, _t2);
      for (let i = 0; i < s.n && n < this.fMax; i++) {
        const ph = t * 0.35 + s.seed * 10 + i * 0.05;
        const rr = s.r * (0.6 + 0.4 * Math.sin(i * 1.7));
        const lag = i * 0.09;
        const x = Math.cos(ph - lag) * rr + Math.sin(i * 3.1) * 0.6, z = Math.sin(ph - lag) * rr + Math.cos(i * 2.3) * 0.6;
        _p.copy(s.c).addScaledVector(_t1, x).addScaledVector(_t2, z).addScaledVector(s.up, Math.sin(i * 5.7) * 0.25);
        _f.copy(_t1).multiplyScalar(-Math.sin(ph - lag)).addScaledVector(_t2, Math.cos(ph - lag));
        writeInstance(arr, n, _p, anchor, _f, s.up, 0.6 + 0.4 * Math.abs(Math.sin(i * 7.7)));
        an[n * 4] = t * 9 + i; an[n * 4 + 1] = 1;
        n++;
      }
    }
    F.mesh.count = n; F.mesh.instanceMatrix.needsUpdate = true; F.anim.needsUpdate = true;
  }

  dispose() { for (const m of [this.b?.mesh, this.fish?.mesh, this.ff?.mesh]) if (m) { m.removeFromParent(); m.geometry.dispose(); m.material.dispose(); m.customDepthMaterial?.dispose(); } }
}
