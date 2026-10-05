// Motes — airborne life around the camera, fully animated on the GPU:
//   'leaves'  tumbling maple / golden leaves drifting down through the light
//   'petals'  a few petals and seeds carried on the wind (lush meadows)
//   'flies'   fireflies / bioluminescent spores: HDR points that wake at night
//   'spores'  pale fungal spores raining slowly (Nausicaä)
// Instances live in a box wrapped around the camera in a tangent frame fixed
// per flora anchor, so they never pop as the camera moves and cost no CPU.
import * as THREE from 'three';
import { tileRect, TILE, foliageAtlas } from './textures.js';

const VERT = /* glsl */ `
attribute vec4 aSeed;          // xyz in [0,1), w random
uniform vec3 uCamL;            // camera in local frame coords (x, y=height, z)
uniform vec3 uT1; uniform vec3 uT2; uniform vec3 uUp;
uniform vec3 uCamW;            // camera relative to anchor (world axes)
uniform float uGroundY;        // ground height below the camera (local y)
uniform float uBox; uniform float uHeight;
uniform float uTime; uniform vec4 uWind;
uniform float uFall; uniform float uSize; uniform float uKind;
uniform vec4 uTile;
varying vec2 vUv; varying float vSeed; varying float vFade; varying vec3 vN; varying vec2 vQ;
void main() {
  float r = aSeed.w; vQ = position.xy * 2.0;
  float t = uTime * (0.6 + 0.8 * fract(r * 13.7));
  vec3 wl = vec3(dot(uWind.xyz, uT1), 0.0, dot(uWind.xyz, uT2)) * (0.6 + uWind.w * 2.2);
  // drift: wind + fall + swirl
  vec3 d = wl * t * 0.8;
  d.y = -uFall * t;
  d.x += sin(t * 0.9 + r * 40.0) * 1.2; d.z += cos(t * 0.7 + r * 23.0) * 1.2;
  d.y += sin(t * 1.3 + r * 17.0) * 0.4 * (1.0 + uKind);
  vec3 lp = aSeed.xyz * vec3(uBox, uHeight, uBox) + d;
  // wrap around the camera (x, z) and over the height band above the ground
  lp.x = mod(lp.x - uCamL.x + uBox * 0.5, uBox) - uBox * 0.5 + uCamL.x;
  lp.z = mod(lp.z - uCamL.z + uBox * 0.5, uBox) - uBox * 0.5 + uCamL.z;
  lp.y = mod(lp.y, uHeight) + uGroundY + 0.15;
  vec3 wp = uT1 * lp.x + uUp * lp.y + uT2 * lp.z;
  // fade at the box edge and very near the camera
  vec2 e = abs(lp.xz - uCamL.xz) / (uBox * 0.5);
  float dc = length(wp - uCamW);
  vFade = (1.0 - smoothstep(0.7, 1.0, max(e.x, e.y))) * smoothstep(0.4, 1.5, dc) * (1.0 - smoothstep(uHeight * 0.85, uHeight, lp.y - uGroundY));
  // tumbling quad
  float a1 = t * (1.5 + 2.0 * r) + r * 30.0, a2 = t * (1.1 + r) + r * 11.0;
  vec3 ax = normalize(uT1 * cos(a1) + uUp * sin(a1) * 0.7 + uT2 * sin(a2) * 0.6);
  vec3 ay = normalize(cross(ax, normalize(uT2 * cos(a2) + uUp * sin(a2) + uT1 * 0.3)));
  if (uKind > 0.5) { // camera-facing points
    vec3 f = normalize(uCamW - wp); ax = normalize(cross(uUp, f)); ay = cross(f, ax);
  }
  float s = uSize * (0.7 + 0.6 * fract(r * 7.3));
  if (uKind > 0.5) s *= 0.6 + 0.4 * sin(uTime * (2.0 + 3.0 * r) + r * 50.0);
  wp += (ax * position.x + ay * position.y) * s;
  vN = normalize(cross(ax, ay));
  vUv = mix(uTile.xy, uTile.zw, position.xy + 0.5);
  vSeed = r;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap; uniform float uKind; uniform vec4 uTile;
uniform vec3 uColA; uniform vec3 uColB; uniform vec3 uKeyColor; uniform vec3 uKeyDir; uniform vec3 uAmb; uniform float uNight; uniform float uGlow;
varying vec2 vUv; varying float vSeed; varying float vFade; varying vec3 vN; varying vec2 vQ;
void main() {
  vec3 col = mix(uColA, uColB, fract(vSeed * 5.31));
  if (uKind > 0.5) {
    vec2 q = vUv * 2.0 - 1.0; float d = dot(q, q);
    float a = (exp(-d * 16.0) + 0.22 * exp(-d * 3.5)) * vFade; // bright core + soft halo
    if (a < 0.01) discard;
    float on = uGlow * (0.08 + uNight) * (0.5 + 0.5 * sin(vSeed * 91.0));
    gl_FragColor = vec4(col * a * on * 6.0, a);
    return;
  }
  // single leaf / petal silhouette: lobed (maple) or oval (petal)
  float ang = atan(vQ.y, vQ.x), rad = length(vQ);
  float lobes = uTile.x < -0.5 ? 0.55 + 0.45 * pow(abs(cos(ang * 2.5 + 1.57)), 0.6) : 0.62 + 0.3 * abs(cos(ang));
  if (rad > lobes || vFade < 0.02) discard;
  vec4 tx = vec4(vec3(0.82 + 0.18 * (1.0 - rad / lobes) - 0.15 * smoothstep(0.03, 0.0, abs(vQ.x)) * step(vQ.y, 0.0)), 1.0);
  float ndl = abs(dot(normalize(vN), uKeyDir));
  vec3 L = uKeyColor * (0.35 + 0.65 * ndl) * 0.9 + uAmb * 0.9;
  gl_FragColor = vec4(col * tx.rgb * L * vFade, 1.0);
}`;

export class Motes {
  constructor(flora, kind) {
    this.flora = flora; this.kind = kind;
  }

  init() {
    const fl = this.flora, q = fl.engine.quality, k = this.kind;
    const cfg = {
      leaves: { n: 340, box: 40, height: 11, fall: 0.5, size: 0.17, tile: TILE.maple, kind: 0 },
      petals: { n: 90, box: 40, height: 8, fall: 0.25, size: 0.06, tile: TILE.small, kind: 0 },
      flies: { n: 420, box: 60, height: 5, fall: 0.0, size: 0.09, tile: TILE.solid, kind: 1 },
      spores: { n: 600, box: 70, height: 24, fall: 0.35, size: 0.06, tile: TILE.solid, kind: 1 },
    }[k.type];
    if (k.height) cfg.height = k.height;
    const n = Math.round(cfg.n * (k.n || 1) * q.pick(0.35, 0.6, 1, 1.4));
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(n * 4);
    let s = (fl.seed ^ 0x51ed) >>> 0;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < n * 4; i++) seeds[i] = rnd();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    g.instanceCount = n;
    const [u0, v0, u1, v1] = tileRect(cfg.tile);
    const w = fl.world;
    this.U = {
      uCamL: { value: new THREE.Vector3() }, uT1: { value: new THREE.Vector3() }, uT2: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3() },
      uCamW: { value: new THREE.Vector3() }, uGroundY: { value: 0 }, uBox: { value: cfg.box }, uHeight: { value: cfg.height },
      uTime: w.uniforms.uTime, uWind: w.uniforms.uWind, uFall: { value: cfg.fall }, uSize: { value: cfg.size * (k.size || 1) }, uKind: { value: cfg.kind },
      uTile: { value: k.type === 'leaves' ? new THREE.Vector4(-1, 0, 0, 0) : new THREE.Vector4(u0, v0, u1, v1) }, uMap: { value: foliageAtlas() },
      uColA: { value: new THREE.Color(k.colors[0]) }, uColB: { value: new THREE.Color(k.colors[1] || k.colors[0]) },
      uKeyColor: fl.uniforms.uKeyColor, uKeyDir: fl.uniforms.uKeyDir, uNight: fl.uniforms.uNight, uGlow: { value: k.glow ?? 1 },
      uAmb: { value: new THREE.Color(0.2, 0.25, 0.3) },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.U, side: THREE.DoubleSide,
      transparent: cfg.kind === 1, depthWrite: cfg.kind !== 1, blending: cfg.kind === 1 ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.geo = g; this.mat = mat;
    fl.group.add(this.mesh);
    this._frameAnchor = new THREE.Vector3(1e12, 0, 0);
  }

  update(cam) {
    const fl = this.flora, U = this.U, A = fl.anchor;
    if (!this._frameAnchor.equals(A)) {
      this._frameAnchor.copy(A);
      const up = U.uUp.value.copy(A).normalize();
      const ref = Math.abs(up.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      U.uT1.value.crossVectors(ref, up).normalize();
      U.uT2.value.crossVectors(up, U.uT1.value).normalize();
    }
    const rel = U.uCamW.value.copy(cam).sub(A);
    U.uCamL.value.set(rel.dot(U.uT1.value), rel.dot(U.uUp.value), rel.dot(U.uT2.value));
    // ground under the camera, in the same local frame
    const g = fl.world.groundAt(cam, this._g || (this._g = {}));
    U.uGroundY.value = this._gy = g.point.clone().sub(A).dot(U.uUp.value);
    if (fl.level.lighting?.skyColor) U.uAmb.value.copy(fl.level.lighting.skyColor);
    const alt = cam.distanceTo(g.point);
    this.mesh.visible = alt < 120 && (this.kind.type !== 'flies' || U.uNight.value > 0.05 || this.kind.always);
  }

  dispose() { this.geo?.dispose(); this.mat?.dispose(); }
}
