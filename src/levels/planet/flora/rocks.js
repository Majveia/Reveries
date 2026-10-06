// Rocks & boulders — procedural deformed meshes (layered/fractured noise on a
// subdivided icosphere, flattened base, sheared strata), instanced per
// variant and streamed in 48 m cells. Material: MeshStandardMaterial patched
// with world-space triplanar grain, strata, cavity darkening, lichen and moss
// that grows on upward-facing surfaces on wet worlds (glowing moss on Pandora).
// Large boulders near the player become sphere colliders.
import * as THREE from 'three';
import { faceDir, cellRng, valueNoise3 } from './scatter.js';
import { CellLayer } from './stream.js';
import { patchMaterial } from './shaders.js';
import { Random, seedFrom } from '../../../core/Random.js';
import { SimplexNoise } from '../../../core/Noise.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const CELL = 48;
const _dir = [0, 0, 0];
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4(), _s = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

function rockGeometry(rng, kind) {
  // indexed (welded) sphere so deformed rocks get smooth normals, not facets
  const ico = new THREE.IcosahedronGeometry(1, kind === 'pebble' ? 3 : 4);
  ico.deleteAttribute('normal'); ico.deleteAttribute('uv');
  const geo = mergeVertices(ico, 1e-5); ico.dispose();
  const nz = new SimplexNoise(Math.floor(rng.float() * 1e9));
  const pos = geo.getAttribute('position');
  const sx = 0.8 + rng.float() * 0.6, sy = kind === 'slab' ? 0.35 + rng.float() * 0.2 : 0.55 + rng.float() * 0.35, sz = 0.7 + rng.float() * 0.5;
  const strataDir = new THREE.Vector3(rng.float() - 0.5, 1.5, rng.float() - 0.5).normalize();
  const cut = [];
  const ncut = kind === 'pebble' ? 3 : 6 + Math.floor(rng.float() * 3);
  for (let k = 0; k < ncut; k++) cut.push({ n: new THREE.Vector3(rng.float() - 0.5, (rng.float() - 0.3) * 0.8, rng.float() - 0.5).normalize(), d: 0.58 + rng.float() * 0.25 });
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const n0 = p.clone();
    let r = 1 + 0.32 * nz.noise3(p.x * 1.1, p.y * 1.1, p.z * 1.1) + 0.12 * nz.noise3(p.x * 2.7, p.y * 2.7, p.z * 2.7) + 0.045 * nz.noise3(p.x * 7, p.y * 7, p.z * 7);
    // strata steps
    const s = n0.dot(strataDir) * 5.0;
    r *= 1 - 0.035 * Math.abs((s - Math.floor(s)) - 0.5);
    p.multiplyScalar(r);
    // fracture planes: flat faces like split stone
    for (const c of cut) { const d = p.dot(c.n); if (d > c.d) p.addScaledVector(c.n, -(d - c.d) * 0.93); }
    p.set(p.x * sx, p.y * sy, p.z * sz);
    if (p.y < -0.15) p.y = -0.15 + (p.y + 0.15) * 0.25; // flattened, buried base
    pos.setXYZ(i, p.x, p.y + 0.12, p.z);
  }
  geo.computeVertexNormals();
  // cavity AO in vertex colour: concave = darker (curvature via normal vs radial)
  const nrm = geo.getAttribute('normal');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).normalize();
    const nn = new THREE.Vector3().fromBufferAttribute(nrm, i);
    const conv = THREE.MathUtils.clamp(nn.dot(p), 0, 1);
    const yk = THREE.MathUtils.clamp((pos.getY(i) + 0.05) / 0.6, 0, 1);
    const a = (0.55 + 0.45 * conv) * (0.6 + 0.4 * yk);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = a;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

const ROCK_VERT = /* glsl */ `
varying vec3 vRW; varying vec3 vRN; varying vec3 vRUp; varying float vRY;
uniform vec3 uAnchor;
`;
const ROCK_FRAG = /* glsl */ `
varying vec3 vRW; varying vec3 vRN; varying vec3 vRUp; varying float vRY;
uniform vec3 uGround;
uniform vec3 uRockA; uniform vec3 uRockB; uniform vec3 uMossCol; uniform float uMoss; uniform float uGlowMoss; uniform float uNight;
float rk_h(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float rk_n(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rk_h(i), rk_h(i + vec3(1,0,0)), f.x), mix(rk_h(i + vec3(0,1,0)), rk_h(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(rk_h(i + vec3(0,0,1)), rk_h(i + vec3(1,0,1)), f.x), mix(rk_h(i + vec3(0,1,1)), rk_h(i + vec3(1,1,1)), f.x), f.y), f.z); }
float rk_f(vec3 p){ return rk_n(p) * 0.5 + rk_n(p * 2.1 + 3.1) * 0.27 + rk_n(p * 4.3 - 1.7) * 0.15 + rk_n(p * 9.1 + 5.3) * 0.08; }
`;

function rockMaterial(U) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  return patchMaterial(mat, U, (sh) => {
    sh.vertexShader = ROCK_VERT + sh.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  vec4 rkW = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
  vRW = transformed * length(instanceMatrix[0].xyz) + fract((instanceMatrix[3].xyz + uAnchor) * 0.0137) * 97.0; vRN = normalize(mat3(modelMatrix * instanceMatrix) * objectNormal); vRUp = normalize(rkW.xyz + uAnchor); vRY = position.y;`);
    sh.fragmentShader = ROCK_FRAG + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
  vec3 rp = vRW;
  float g1 = rk_f(rp * 1.7), g2 = rk_f(rp * 7.0 + 11.0), g3 = rk_n(rp * 0.35);
  vec3 rc = mix(uRockA, uRockB, smoothstep(0.3, 0.75, g3 * 0.6 + g1 * 0.5));
  rc *= 0.72 + 0.42 * g2;
  // lichen speckles
  float lich = smoothstep(0.72, 0.8, rk_n(rp * 5.3 + 7.0)) * 0.6;
  rc = mix(rc, vec3(0.62, 0.6, 0.48) * (0.8 + 0.4 * g2), lich * 0.5);
  float upk = dot(normalize(vRN), vRUp);
  float moss = uMoss * smoothstep(0.15, 0.65, upk + (g1 - 0.5) * 0.7);
  rc = mix(rc, uMossCol * (0.7 + 0.5 * g2), moss);
  // soil creep: the buried base takes the colour of the ground around it
  float soil = smoothstep(0.32, 0.02, vRY + (g1 - 0.5) * 0.22) * (1.0 - moss * 0.5);
  rc = mix(rc, uGround * (0.75 + 0.4 * g2), soil * 0.85);
  diffuseColor.rgb *= rc;
  float rkMoss = moss;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  // procedural bump (screen-space derivatives): chisel marks, grain and pits
  {
    float bh = rk_f(rp * 2.3) * 0.55 + rk_n(rp * 9.0) * 0.3 + rk_n(rp * 23.0) * 0.15;
    bh -= 0.35 * smoothstep(0.75, 0.9, rk_n(rp * 4.1 + 2.0));
    vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
    float dhx = dFdx(bh), dhy = dFdy(bh);
    vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
    float det = dot(dpx, r1);
    vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
    normal = normalize(abs(det) * normal - grad * 0.09 * (1.0 - rkMoss * 0.6));
  }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(0.78 + 0.2 * g2, 0.95, rkMoss);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += uMossCol * vec3(0.4, 1.6, 2.2) * uGlowMoss * rkMoss * smoothstep(0.55, 0.9, g2) * (0.15 + 2.5 * uNight);');
  }, 'flora-rock');
}

export class Rocks {
  constructor(flora) {
    this.flora = flora;
    this.world = flora.world;
    this.P = flora.profile.rocks;
  }

  init() {
    const fl = this.flora, q = fl.engine.quality, P = this.P, w = this.world;
    this.R = w.radius;
    this.sea = w.hasOcean ? w.seaLevel : -Infinity;
    this.range = q.pick(160, 240, 340, 420);
    const rc = new THREE.Color(P.color || '#7a766e');
    this.U = {
      uAnchor: fl.uniforms.uAnchor, uNight: fl.uniforms.uNight,
      uRockA: { value: rc.clone().multiplyScalar(0.85) }, uRockB: { value: rc.clone().lerp(new THREE.Color('#a8a296'), 0.35) },
      uMossCol: { value: new THREE.Color(P.mossCol || '#4e6e2c') }, uGround: { value: new THREE.Color((fl.aesthetic?.palette?.ground || ['#6a5a44'])[0]).multiplyScalar(0.8) }, uMoss: { value: P.moss || 0 }, uGlowMoss: { value: P.glowMoss || 0 },
    };
    this.mat = rockMaterial(this.U);
    const rng = new Random(seedFrom(fl.seed, 'rocks'));
    this.variants = [];
    const kinds = ['boulder', 'boulder', 'slab', 'boulder', 'slab', 'pebble'];
    for (let k = 0; k < q.pick(3, 4, 5, 6); k++) {
      const geo = rockGeometry(rng, kinds[k]);
      const m = new THREE.InstancedMesh(geo, this.mat, 64);
      m.count = 0; m.castShadow = true; m.receiveShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      fl.group.add(m);
      this.variants.push({ geo, mesh: m, list: [], kind: kinds[k] });
    }
    this.colliders = new Map();
    this.layer = new CellLayer({
      R: this.R, cellSize: CELL, radius: this.range, moveThresh: 6, cacheMax: 600,
      tierOf: (dmin) => (dmin > this.range ? -1 : 0),
      covers: (c) => !!c.data,
      build: (c) => this._build(c),
    });
    this._lastPack = new THREE.Vector3(1e12, 0, 0);
  }

  _build(c) {
    const { face, i, j, N } = c;
    const R = this.R, sea = this.sea, P = this.P;
    const cellM = (Math.PI * 0.5 * R) / N;
    const kmax = Math.max(1, Math.round(cellM * cellM * P.density * 2.2));
    const rng = cellRng(this.flora.seed, 47, face, i, j);
    const out = [];
    for (let k = 0; k < kmax; k++) {
      const u = rng(), v = rng(), r1 = rng(), r2 = rng(), r3 = rng(), r4 = rng();
      faceDir(face, ((i + u) / N) * 2 - 1, ((j + v) / N) * 2 - 1, _dir);
      const s = this.world.terrain.sample(_dir[0], _dir[1], _dir[2]);
      if (sea > -1e8 && s.h < sea - 0.6) continue;
      const rr = R + s.h;
      const x = _dir[0] * rr, y = _dir[1] * rr, z = _dir[2] * rr;
      // more stone where the land is rocky / steep / near cliffs, clustered in fields
      const fld = valueNoise3(x * 0.018, y * 0.018, z * 0.018, 77) * 0.5 + 0.5;
      let p = 0.12 + 0.9 * Math.max(s.rock, s.cliff || 0) + 0.35 * (s.sand > 0.5 ? 0.3 : 0) + (s.biome === 4 ? 0.3 : 0);
      p *= 0.25 + 1.2 * fld * fld;
      p *= this.flora.siteClear(x, y, z, 0.8);
      if (r1 > p * 0.45) continue;
      // size distribution: many small, few huge
      let sc = (0.25 + 2.2 * Math.pow(r2, 3.2)) * (P.size || 1);
      if (r3 < 0.04 * (0.4 + fld)) sc *= 2.4;
      const vi = Math.floor(r4 * 0.999 * this.variants.length);
      out.push({ x, y, z, nx: _dir[0], ny: _dir[1], nz: _dir[2], yaw: u * 41.0 + v * 17.0, tilt: (r3 - 0.5) * 0.5, sc, sy: 0.8 + 0.4 * r1, v: vi, sink: sc * (0.12 + 0.18 * r2) });
    }
    c.data = out;
  }

  _pack(player) {
    const anchor = this.flora.anchor;
    for (const v of this.variants) v.list.length = 0;
    const want = new Set();
    for (const c of this.layer.active.values()) {
      if (!c.data) continue;
      for (const t of c.data) {
        this.variants[t.v].list.push(t);
        if (player && t.sc > 0.9) {
          const dx = t.x - player.x, dy = t.y - player.y, dz = t.z - player.z;
          if (dx * dx + dy * dy + dz * dz < 40 * 40) want.add(t);
        }
      }
    }
    for (const v of this.variants) {
      const n = v.list.length;
      if (n > v.mesh.instanceMatrix.count) {
        const m = new THREE.InstancedMesh(v.geo, this.mat, Math.ceil(n * 1.5));
        m.castShadow = true; m.receiveShadow = true; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.flora.group.remove(v.mesh); v.mesh.dispose(); this.flora.group.add(m); v.mesh = m;
      }
      for (let k = 0; k < n; k++) {
        const t = v.list[k];
        _v.set(t.nx, t.ny, t.nz);
        _q.setFromUnitVectors(Y, _v);
        _q2.setFromEuler(new THREE.Euler(t.tilt, t.yaw, t.tilt * 0.6));
        _q.multiply(_q2);
        _s.set(t.sc, t.sc * t.sy, t.sc * (0.9 + 0.2 * t.sy));
        _m.compose(_v2.set(t.x - anchor.x, t.y - anchor.y, t.z - anchor.z).addScaledVector(_v, -t.sink), _q, _s);
        v.mesh.setMatrixAt(k, _m);
      }
      v.mesh.count = n;
      v.mesh.instanceMatrix.needsUpdate = true;
      if (n) v.mesh.computeBoundingSphere();
    }
    const w = this.world;
    for (const [t, col] of this.colliders) if (!want.has(t)) { w.removeCollider(col); this.colliders.delete(t); }
    for (const t of want) {
      if (this.colliders.has(t)) continue;
      const up = new THREE.Vector3(t.nx, t.ny, t.nz);
      const col = w.addCollider({ type: 'sphere', center: new THREE.Vector3(t.x, t.y, t.z).addScaledVector(up, t.sc * 0.25 - t.sink), radius: t.sc * 0.62, flora: true });
      this.colliders.set(t, col);
    }
    this.count = this.variants.reduce((a, v) => a + v.list.length, 0);
  }

  update(focus, player, budget, force) {
    if (!this.layer) return;
    this.layer.update(focus, budget, force);
    if (this.layer.dirty || this.flora.reanchored || (player && player.distanceToSquared(this._lastPack) > 100)) {
      this.layer.dirty = false;
      if (player) this._lastPack.copy(player);
      this._pack(player);
    }
  }

  dispose() {
    for (const v of this.variants || []) { v.geo.dispose(); v.mesh.dispose(); }
    for (const c of this.colliders?.values() || []) this.world.removeCollider(c);
    this.mat?.dispose();
  }
}
