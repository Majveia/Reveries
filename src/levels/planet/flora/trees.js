// Trees & large plants: species variants → instanced meshes near the camera,
// baked impostor billboards out to the horizon, trunk colliders around the
// player, and colossal landmark trees.
import * as THREE from 'three';
import { faceDir, cellRng, valueFbm3, valueNoise3 } from './scatter.js';
import { CellLayer } from './stream.js';
import { WIND_GLSL, patchMaterial } from './shaders.js';
import { buildPlant } from './species.js';
import { foliageAtlas } from './textures.js';
import { Random, seedFrom } from '../../../core/Random.js';

const CELL = 128;
const _dir = [0, 0, 0];
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4(), _s = new THREE.Vector3();
const _c = new THREE.Color();
const Y = new THREE.Vector3(0, 1, 0);

// wind applied in world space, converted back to the instance's local frame
const WIND_APPLY = /* glsl */ `
#ifdef USE_INSTANCING
  mat4 flIM = instanceMatrix;
#else
  mat4 flIM = mat4(1.0);
#endif
  vec3 flBase = (modelMatrix * flIM * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 flUp = normalize(flBase);
  vec3 flWd = uWind.xyz - flUp * dot(uWind.xyz, flUp); flWd = normalize(flWd + vec3(1e-5));
  float flPh = fl_hash2(flBase.xz * 0.013 + flBase.y * 0.007) * 6.2831;
  float flG = fl_gust(flBase, flWd, uTime);
  float flS = uWind.w * (0.3 + 0.95 * flG) + 0.18 * sin(uTime * 0.83 + flPh) * (0.35 + uWind.w);
  vec3 flOff = flWd * flS * aWind.x + cross(flUp, flWd) * sin(uTime * 1.31 + flPh * 1.7) * 0.25 * aWind.x * (0.3 + uWind.w);
  flOff += vec3(sin(uTime * 7.1 + position.x * 1.9 + flPh), sin(uTime * 5.7 + position.y * 1.3 + flPh * 1.3), sin(uTime * 8.3 + position.z * 2.1 + flPh)) * 0.055 * aWind.y * (0.25 + uWind.w);
  transformed += inverse(mat3(modelMatrix * flIM)) * flOff;
`;

const BARK_FRAG = /* glsl */ `
float fl_vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = fl_h(i), b = fl_h(i + vec2(1.0, 0.0)), c = fl_h(i + vec2(0.0, 1.0)), d = fl_h(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
`;

function barkMaterial(U, depth = false) {
  const mat = depth ? new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }) : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  return patchMaterial(mat, U, (sh) => {
    sh.vertexShader = 'attribute vec3 aWind;\nvarying vec2 vBUv;\nvarying float vBGlow;\n' + WIND_GLSL + sh.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_APPLY + '\nvBUv = uv; vBGlow = aWind.z;');
    if (depth) return;
    sh.fragmentShader = 'varying vec2 vBUv;\nvarying float vBGlow;\nuniform float uNight;\nuniform vec3 uGlowCol;\nfloat fl_h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\n' + BARK_FRAG + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
  float flF = fl_vn(vec2(vBUv.x * 3.0, vBUv.y * 0.9)) * 0.6 + fl_vn(vec2(vBUv.x * 9.0, vBUv.y * 2.7)) * 0.4;
  float flRidge = smoothstep(0.25, 0.65, flF);
  diffuseColor.rgb *= mix(0.55, 1.12, flRidge) * (0.9 + 0.2 * fl_vn(vBUv * vec2(1.0, 0.2)));`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += mix(diffuseColor.rgb, uGlowCol, 0.75) * vBGlow * (0.35 + 3.0 * uNight);');
  }, depth ? 'flora-bark-depth' : 'flora-bark');
}

function leafMaterial(U, map, depth = false) {
  const mat = depth
    ? new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.42 })
    : new THREE.MeshStandardMaterial({ vertexColors: true, map, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.62, metalness: 0 });
  return patchMaterial(mat, U, (sh) => {
    sh.vertexShader = 'attribute vec3 aWind;\nvarying float vLGlow;\nvarying float vLBack;\n' + WIND_GLSL + sh.vertexShader
      .replace('#include <begin_vertex>', `#include <begin_vertex>
${WIND_APPLY}
  vLGlow = aWind.z;
  vec3 flWP = (modelMatrix * flIM * vec4(transformed, 1.0)).xyz;
  vLBack = pow(max(dot(normalize(flWP - cameraPosition), uKeyDir), 0.0), 4.0);`);
    if (depth) return;
    sh.fragmentShader = 'varying float vLGlow;\nvarying float vLBack;\nuniform vec3 uKeyColor;\nuniform float uNight;\nuniform vec3 uGlowCol;\n' + sh.fragmentShader
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize( vNormal );')
      .replace('#include <opaque_fragment>', `outgoingLight += diffuseColor.rgb * uKeyColor * (0.05 + 0.5 * vLBack) * 0.35;
  outgoingLight += mix(diffuseColor.rgb, uGlowCol, 0.7) * vLGlow * (0.3 + 3.0 * uNight);
#include <opaque_fragment>`);
  }, depth ? 'flora-leaf-depth' : 'flora-leaf');
}

// --- impostors ----------------------------------------------------------------
const IMP_VERT = /* glsl */ `
attribute vec3 iPos;   // base, relative to anchor
attribute vec4 iDat;   // size, yOffset, tile, glow
attribute vec3 iCol;
uniform vec3 uCam;
uniform float uTiles;
varying vec3 vICol;
varying float vIGlow;
varying float vIBack;
${WIND_GLSL}
`;
const IMP_BODY = /* glsl */ `
  vec3 iUp = normalize(uAnchor + iPos);
  vec3 iTc = uCam - iPos; iTc -= iUp * dot(iTc, iUp); iTc = normalize(iTc + vec3(1e-4));
  vec3 iRight = normalize(cross(iUp, iTc));
  float iSw = sin(uTime * 0.8 + iPos.x * 0.05 + iPos.z * 0.04) * 0.012 * uWind.w * position.y * iDat.x;
  vec3 p = iPos + iRight * (position.x * iDat.x + iSw) + iUp * (position.y * iDat.x + iDat.y);
  vec3 objectNormal = normalize(iRight * position.x * 1.3 + iUp * (position.y - 0.45) * 0.9 + iTc * 0.8);
  vICol = iCol; vIGlow = iDat.w;
  vIBack = pow(max(dot(normalize(p - uCam), uKeyDir), 0.0), 4.0);
`;
function impostorMaterial(U, tex) {
  const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.38, side: THREE.DoubleSide, roughness: 0.7, metalness: 0 });
  return patchMaterial(mat, U, (sh) => {
    sh.vertexShader = IMP_VERT + sh.vertexShader
      .replace('#include <beginnormal_vertex>', IMP_BODY)
      .replace('#include <begin_vertex>', `vec3 transformed = p;
  float iT = iDat.z; float iC = mod(iT, uTiles); float iR = floor(iT / uTiles);
  vMapUv = (vec2(iC, iR) + vec2(position.x + 0.5, position.y) * 0.985 + 0.0075) / uTiles;`);
    sh.fragmentShader = 'varying vec3 vICol;\nvarying float vIGlow;\nvarying float vIBack;\nuniform vec3 uKeyColor;\nuniform float uNight;\nuniform vec3 uGlowCol;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= vICol;')
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize( vNormal );')
      .replace('#include <opaque_fragment>', `outgoingLight += diffuseColor.rgb * uKeyColor * (0.05 + 0.5 * vIBack) * 0.3;
  outgoingLight += mix(diffuseColor.rgb, uGlowCol, 0.7) * vIGlow * (0.25 + 2.2 * uNight);
#include <opaque_fragment>`);
  }, 'flora-impostor');
}

const BAKE_VERT = /* glsl */ `
attribute vec3 color;
varying vec3 vC; varying vec2 vU;
void main() { vC = color; vU = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BAKE_FRAG = /* glsl */ `
uniform sampler2D map; uniform float uLeaf;
varying vec3 vC; varying vec2 vU;
void main() {
  vec4 t = uLeaf > 0.5 ? texture2D(map, vU) : vec4(1.0);
  if (t.a < 0.42) discard;
  gl_FragColor = vec4(t.rgb * vC, 1.0);
}`;

export class Trees {
  constructor(flora) {
    this.flora = flora;
    this.world = flora.world;
    this.T = flora.profile.trees;
  }

  init() {
    const fl = this.flora, w = this.world, q = fl.engine.quality, T = this.T;
    this.R = w.radius;
    this.sea = w.hasOcean ? w.seaLevel : -Infinity;
    this.meshRange = q.pick(70, 110, 150, 200);
    this.farRange = Math.min(w.radius * 0.12, q.pick(1100, 1700, 2400, 3200));
    this.colRange = 45;
    this.atlas = foliageAtlas();
    const U = {
      uAnchor: fl.uniforms.uAnchor, uKeyColor: fl.uniforms.uKeyColor, uKeyDir: fl.uniforms.uKeyDir, uNight: fl.uniforms.uNight,
      uTime: w.uniforms.uTime, uWind: w.uniforms.uWind, uGlowCol: { value: new THREE.Color(T.glowCol || '#7fe6ff') },
    };
    this.U = U;
    this.barkMat = barkMaterial(U); this.barkDepth = barkMaterial(U, true);
    this.leafMat = leafMaterial(U, this.atlas); this.leafDepth = leafMaterial(U, this.atlas, true);

    // ---- species variants -------------------------------------------------
    const rng = new Random(seedFrom(fl.seed, 'flora-trees'));
    const nv = q.pick(2, 3, 4, 5);
    this.species = [];
    this.variants = [];
    for (const sp of T.species) {
      const entry = { ...sp, variants: [] };
      const n = sp.variants || nv;
      for (let k = 0; k < n; k++) {
        const pal = typeof sp.pal === 'function' ? sp.pal(k, rng) : sp.pal || {};
        let g;
        try { g = buildPlant(sp.kind, rng, pal, { scale: sp.scale || 1 }); } catch (e) { console.warn('[flora] species', sp.kind, e); continue; }
        const v = { index: this.variants.length, kind: sp.kind, ...g, list: [], glow: pal.glowAmt || 0 };
        v.barkMesh = this._inst(g.bark, this.barkMat, this.barkDepth, 64);
        v.leafMesh = g.leaves ? this._inst(g.leaves, this.leafMat, this.leafDepth, 64) : null;
        entry.variants.push(v); this.variants.push(v);
      }
      if (entry.variants.length) this.species.push(entry);
    }
    this._bakeImpostors();
    // impostor instancing
    const ig = new THREE.InstancedBufferGeometry();
    ig.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    ig.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    ig.setIndex([0, 1, 2, 0, 2, 3]);
    this.impGeo = ig; this._impCap = 0; this._growImp(4096);
    this.IU = { ...U, uCam: fl.uniforms.uCam, uTiles: { value: this.tiles } };
    this.impMat = impostorMaterial(this.IU, this.impRT.texture);
    this.impMesh = new THREE.Mesh(ig, this.impMat);
    this.impMesh.frustumCulled = false; this.impMesh.receiveShadow = true; this.impMesh.castShadow = false;
    fl.group.add(this.impMesh);

    this.colliders = new Map();
    this.layer = new CellLayer({
      R: this.R, cellSize: CELL, radius: this.farRange, moveThresh: 12, cacheMax: 900,
      tierOf: (dmin) => (dmin > this.farRange ? -1 : dmin < this.meshRange + 260 ? 0 : dmin < 1100 ? 1 : 2),
      covers: (c, tier) => c.data && c.data.tier <= tier,
      build: (c, tier) => this._build(c, tier),
    });
    this._lastPack = new THREE.Vector3(1e12, 0, 0);
    this._landmarks();
  }

  _inst(geo, mat, depthMat, cap) {
    const m = new THREE.InstancedMesh(geo, mat, cap);
    m.count = 0; m.castShadow = true; m.receiveShadow = true;
    m.customDepthMaterial = depthMat;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = true;
    this.flora.group.add(m);
    return m;
  }

  _growInst(v, which, cap) {
    const old = v[which];
    const m = this._inst(old.geometry, old.material, old.customDepthMaterial, cap);
    this.flora.group.remove(old); old.dispose();
    v[which] = m;
    return m;
  }

  _growImp(cap) {
    const g = this.impGeo;
    const mk = (n, s) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(n * s), s); a.setUsage(THREE.DynamicDrawUsage); return a; };
    g.setAttribute('iPos', mk(cap, 3)); g.setAttribute('iDat', mk(cap, 4)); g.setAttribute('iCol', mk(cap, 3));
    this._impCap = cap;
  }

  // Render each variant from the side into an atlas tile (albedo + baked canopy AO).
  _bakeImpostors() {
    const n = Math.max(1, this.variants.length);
    const tiles = Math.ceil(Math.sqrt(n));
    this.tiles = tiles;
    const TS = this.flora.engine.quality.pick(128, 192, 256, 256);
    const size = tiles * TS;
    const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
    this.impRT = rt;
    const renderer = this.flora.engine.renderer;
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    const barkM = new THREE.ShaderMaterial({ vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG, uniforms: { map: { value: this.atlas }, uLeaf: { value: 0 } } });
    const leafM = new THREE.ShaderMaterial({ vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG, uniforms: { map: { value: this.atlas }, uLeaf: { value: 1 } }, side: THREE.DoubleSide });
    const prevRT = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0); renderer.clear(true, true, true);
    for (const v of this.variants) {
      const box = new THREE.Box3();
      if (v.bark) { v.bark.computeBoundingBox(); box.union(v.bark.boundingBox); }
      if (v.leaves) { v.leaves.computeBoundingBox(); box.union(v.leaves.boundingBox); }
      const h = box.max.y - Math.max(box.min.y, -0.5), wdt = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
      const s = Math.max(h, wdt) * 1.04;
      v.impSize = s; v.impY = Math.max(box.min.y, -0.5);
      const cx = (box.max.x + box.min.x) * 0.5, cz = (box.max.z + box.min.z) * 0.5;
      cam.left = -s / 2; cam.right = s / 2; cam.bottom = 0; cam.top = s;
      cam.position.set(cx, v.impY, cz + 500); cam.lookAt(cx, v.impY, cz); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
      const col = v.index % tiles, row = Math.floor(v.index / tiles);
      rt.viewport.set(col * TS, row * TS, TS, TS); rt.scissor.set(col * TS, row * TS, TS, TS); rt.scissorTest = true;
      // dilated clear colour: the plant's mean foliage tone at zero alpha
      const lc = v.leaves ? v.leaves.getAttribute('color') : v.bark.getAttribute('color');
      let r = 0, g = 0, b = 0; const cnt = lc.count; for (let k = 0; k < cnt; k += 7) { r += lc.getX(k); g += lc.getY(k); b += lc.getZ(k); } const nn = Math.ceil(cnt / 7);
      renderer.setRenderTarget(rt);
      renderer.setClearColor(new THREE.Color(r / nn * 0.8, g / nn * 0.8, b / nn * 0.8), 0); renderer.clear(true, true, true);
      scene.clear();
      if (v.bark) scene.add(new THREE.Mesh(v.bark, barkM));
      if (v.leaves) scene.add(new THREE.Mesh(v.leaves, leafM));
      renderer.render(scene, cam);
    }
    rt.scissorTest = false; rt.viewport.set(0, 0, size, size); rt.scissor.set(0, 0, size, size);
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    barkM.dispose(); leafM.dispose();
  }

  _clim(s) {
    const T = this.T;
    let p;
    switch (s.biome) {
      case 0: return 0;
      case 1: p = T.grassland ?? 0.3; break;
      case 2: p = 1; break;
      case 3: p = T.arid ?? 0.1; break;
      case 4: p = T.snowy ?? 0; break;
      case 5: p = T.sandy ?? 0.04; break;
      case 6: p = T.rocky ?? 0.05; break;
      case 7: p = T.wet ?? 0.45; break;
      default: p = 0;
    }
    p *= 1 - THREE.MathUtils.smoothstep(s.cliff || 0, 0.35, 0.6);
    p *= 1 - THREE.MathUtils.smoothstep(s.snow, T.snowLine ?? 0.45, (T.snowLine ?? 0.45) + 0.25);
    return p;
  }

  _pickSpecies(s, r) {
    let tot = 0;
    const ws = this._ws || (this._ws = new Float32Array(this.species.length));
    for (let k = 0; k < this.species.length; k++) {
      const sp = this.species[k];
      let wgt = sp.w;
      if (sp.cold) wgt *= 1 + sp.cold * THREE.MathUtils.clamp((0.5 - s.temp) * 3, -0.9, 2);
      if (sp.wet) wgt *= 1 + sp.wet * THREE.MathUtils.clamp((s.moisture - 0.5) * 3, -0.9, 2);
      if (sp.shore && this.sea > -1e8) wgt *= 1 + sp.shore * (1 - THREE.MathUtils.smoothstep(s.h - this.sea, 2, 30)) * 4;
      ws[k] = Math.max(0, wgt); tot += ws[k];
    }
    let x = r * tot;
    for (let k = 0; k < this.species.length; k++) { x -= ws[k]; if (x <= 0) return this.species[k]; }
    return this.species[this.species.length - 1];
  }

  _build(c, tier) {
    const { face, i, j, N } = c;
    const T = this.T, R = this.R, sea = this.sea;
    const cellM = (Math.PI * 0.5 * R) / N;
    const kmax = Math.round(cellM * cellM * T.density);
    const frac = tier === 0 ? 1 : tier === 1 ? 0.3 : 0.1;
    const gen = Math.ceil(kmax * frac);
    const rng = cellRng(this.flora.seed, 31, face, i, j);
    const trees = [];
    const fz = this.flora.noiseScale.forest;
    for (let k = 0; k < gen; k++) {
      const u = rng(), v = rng(), r1 = rng(), r2 = rng(), r3 = rng(), r4 = rng();
      faceDir(face, ((i + u) / N) * 2 - 1, ((j + v) / N) * 2 - 1, _dir);
      const s = this.world.terrain.sample(_dir[0], _dir[1], _dir[2]);
      if (sea > -1e8 && s.h < sea + 0.7) continue;
      let p = this._clim(s);
      if (p <= 0) continue;
      const rr = R + s.h;
      const x = _dir[0] * rr, y = _dir[1] * rr, z = _dir[2] * rr;
      const fm = valueFbm3(x * fz, y * fz, z * fz, 3);
      p *= THREE.MathUtils.smoothstep(fm + (s.biome === 2 ? 0.35 : 0.05) + (T.cover ?? 0) + (s.moisture - 0.5) * 0.4, 0.0, 0.32);
      p *= this.flora.siteClear(x, y, z, 1.0);
      if (r1 > p) continue;
      const sp = this._pickSpecies(s, r2);
      const vv = sp.variants[Math.floor(r3 * sp.variants.length) % sp.variants.length];
      const scale = (0.72 + 0.55 * r4) * (k < kmax * 0.06 ? 1.2 : 1) * (sp.sizeK || 1);
      trees.push({ x, y, z, nx: _dir[0], ny: _dir[1], nz: _dir[2], yaw: u * 97.0 + v * 53.0, scale, v: vv, rank: k / kmax, tint: r2 * 7.31 % 1, sp });
    }
    c.data = { tier, trees };
  }

  _pack(focus, cam, player) {
    const anchor = this.flora.anchor;
    for (const v of this.variants) v.list.length = 0;
    const imp = [];
    const mr2 = this.meshRange * this.meshRange;
    const wantCol = new Set();
    for (const c of this.layer.active.values()) {
      if (!c.data) continue;
      const frac = c.tier === 0 ? 1 : c.tier === 1 ? 0.3 : 0.1;
      for (const t of c.data.trees) {
        if (t.rank >= frac) continue;
        const dx = t.x - cam.x, dy = t.y - cam.y, dz = t.z - cam.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < mr2) t.v.list.push(t); else imp.push(t);
        if (player) {
          const px = t.x - player.x, py = t.y - player.y, pz = t.z - player.z;
          if (px * px + py * py + pz * pz < this.colRange * this.colRange && t.v.trunkR > 0.08) wantCol.add(t);
        }
      }
    }
    // mesh instances
    for (const v of this.variants) {
      const n = v.list.length;
      if (n > v.barkMesh.instanceMatrix.count) { this._growInst(v, 'barkMesh', Math.ceil(n * 1.5)); if (v.leafMesh) this._growInst(v, 'leafMesh', Math.ceil(n * 1.5)); }
      for (let k = 0; k < n; k++) {
        const t = v.list[k];
        _v.set(t.nx, t.ny, t.nz);
        _q.setFromUnitVectors(Y, _v);
        _q2.setFromAxisAngle(Y, t.yaw);
        _q.multiply(_q2);
        _s.setScalar(t.scale);
        _m.compose(_v2.set(t.x - anchor.x, t.y - anchor.y, t.z - anchor.z), _q, _s);
        v.barkMesh.setMatrixAt(k, _m);
        if (v.leafMesh) {
          v.leafMesh.setMatrixAt(k, _m);
          const tv = (t.tint - 0.5);
          _c.setRGB(1 + tv * 0.16, 1 + tv * 0.1, 1 - tv * 0.12);
          if (t.sp.tints) _c.multiply(t.sp.tints[Math.floor(t.tint * t.sp.tints.length) % t.sp.tints.length]);
          v.leafMesh.setColorAt(k, _c);
        }
      }
      for (const m of [v.barkMesh, v.leafMesh]) {
        if (!m) continue;
        m.count = n;
        m.instanceMatrix.clearUpdateRanges?.(); m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
        if (n) m.computeBoundingSphere(); else m.boundingSphere = null;
      }
    }
    // impostors
    if (imp.length > this._impCap) this._growImp(Math.ceil(imp.length * 1.4));
    const g = this.impGeo, P = g.getAttribute('iPos').array, D = g.getAttribute('iDat').array, C = g.getAttribute('iCol').array;
    for (let k = 0; k < imp.length; k++) {
      const t = imp[k], v = t.v;
      P[k * 3] = t.x - anchor.x; P[k * 3 + 1] = t.y - anchor.y; P[k * 3 + 2] = t.z - anchor.z;
      D[k * 4] = v.impSize * t.scale; D[k * 4 + 1] = v.impY * t.scale; D[k * 4 + 2] = v.index; D[k * 4 + 3] = v.glow;
      const tv = (t.tint - 0.5);
      _c.setRGB(1 + tv * 0.16, 1 + tv * 0.1, 1 - tv * 0.12);
      if (t.sp.tints) _c.multiply(t.sp.tints[Math.floor(t.tint * t.sp.tints.length) % t.sp.tints.length]);
      C[k * 3] = _c.r; C[k * 3 + 1] = _c.g; C[k * 3 + 2] = _c.b;
    }
    for (const nm of ['iPos', 'iDat', 'iCol']) g.getAttribute(nm).needsUpdate = true;
    g.instanceCount = imp.length;
    // trunk colliders around the player
    const w = this.world;
    for (const [t, col] of this.colliders) if (!wantCol.has(t)) { w.removeCollider(col); this.colliders.delete(t); }
    for (const t of wantCol) {
      if (this.colliders.has(t)) continue;
      const up = new THREE.Vector3(t.nx, t.ny, t.nz);
      const col = w.addCollider({ type: 'cylinder', center: new THREE.Vector3(t.x, t.y, t.z).addScaledVector(up, -0.5), up, radius: Math.max(0.15, t.v.trunkR * t.scale * 1.05), height: Math.min(8, t.v.height * t.scale * 0.6) + 0.5, walkable: false, flora: true });
      this.colliders.set(t, col);
    }
    this.meshCount = this.variants.reduce((a, v) => a + v.list.length, 0);
    this.impCount = imp.length;
  }

  update(focus, cam, player, budget, force) {
    if (!this.layer) return;
    this.layer.update(focus, budget, force);
    if (this.layer.dirty || this.flora.reanchored || cam.distanceToSquared(this._lastPack) > 64) {
      this.layer.dirty = false;
      this._lastPack.copy(cam);
      this._pack(focus, cam, player);
    }
    for (const L of this.landmarkMeshes || []) L.position.copy(L.userData.world).sub(this.flora.anchor);
  }

  // ---- colossal landmark trees ---------------------------------------------------
  _landmarks() {
    const T = this.T, fl = this.flora, w = this.world;
    this.landmarkMeshes = [];
    if (!T.landmark || !w.sites?.length) return;
    const L = T.landmark;
    const rng = new Random(seedFrom(fl.seed, 'landmark-tree'));
    let spot;
    try { spot = fl.level.scenicSpot(0, 520, 2); } catch { return; }
    const site = spot.site || w.sites[0];
    // behind the settlement as seen from the vista point, a little to the side
    const up = site.dir.clone();
    const away = site.position.clone().sub(spot.position); away.addScaledVector(up, -away.dot(up)).normalize();
    const side = away.clone().cross(up).normalize();
    let best = null;
    for (let k = 0; k < 14; k++) {
      const dist = site.radius + L.H * 0.6 + 80 + k * 40;
      const lat = (k % 2 ? 1 : -1) * (0.25 + 0.05 * k) * dist;
      const p = site.position.clone().addScaledVector(away, dist).addScaledVector(side, lat);
      const dir = p.normalize();
      const h = w.heightAt(dir);
      if (this.sea > -1e8 && h < this.sea + 3) continue;
      const n = w.normalAt(dir);
      if (n.dot(dir) < 0.9) continue;
      best = { dir: dir.clone(), h }; break;
    }
    if (!best) return;
    const g = buildPlant('giant', rng, L.pal || {}, { style: L.style, H: L.H });
    const pos = best.dir.clone().multiplyScalar(w.radius + best.h - L.H * 0.012);
    const q = new THREE.Quaternion().setFromUnitVectors(Y, best.dir);
    for (const [geo, mat, dm] of [[g.bark, this.barkMat, this.barkDepth], [g.leaves, this.leafMat, this.leafDepth]]) {
      if (!geo) continue;
      const m = new THREE.Mesh(geo, mat);
      m.customDepthMaterial = dm; m.castShadow = true; m.receiveShadow = true;
      m.quaternion.copy(q); m.userData.world = pos.clone();
      m.position.copy(pos).sub(fl.anchor);
      fl.group.add(m); this.landmarkMeshes.push(m);
    }
    this.landmark = { position: pos, height: g.height };
    w.addCollider({ type: 'cylinder', center: pos.clone(), up: best.dir.clone(), radius: g.trunkR * 1.2, height: g.height * 0.4, walkable: false });
    w.addPOI?.({ position: pos.clone().addScaledVector(best.dir, 4), radius: L.H * 0.6, title: L.name || 'The Elder Tree', text: L.text || 'Older than the oldest stones of the town.', kind: 'landmark' });
  }

  dispose() {
    for (const v of this.variants || []) { v.bark?.dispose(); v.leaves?.dispose(); v.barkMesh?.dispose(); v.leafMesh?.dispose(); }
    for (const c of this.colliders?.values() || []) this.world.removeCollider(c);
    this.impGeo?.dispose(); this.impMat?.dispose(); this.impRT?.dispose();
    this.barkMat?.dispose(); this.leafMat?.dispose(); this.barkDepth?.dispose(); this.leafDepth?.dispose();
  }
}
