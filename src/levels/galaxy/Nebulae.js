// Emission nebulae you can fly into: each is a raymarched volume bounded by a sphere
// (rendered back-faced so it also works from inside), drawn at reduced resolution
// and composited over the image with premultiplied alpha.
//
// Physics-inspired look (JWST Carina / Pillars / Orion):
//  * a young ionizing cluster carves a cavity; the cavity wall erodes into dust pillars
//    pointing at the cluster (noise evaluated in a radially stretched frame)
//  * ionization front: dust surfaces facing the cluster glow (Hα + SII, orange/red rims),
//    the hot inner cavity glows in OIII (teal), outer gas in Hα (red)
//  * dust absorbs and back-scatters brownish light; one shadow tap toward the
//    cluster gives each sample its illumination
// kinds: pillars (columns), cliffs (a cosmic-cliff wall), shell (bubble), veil (filaments)

import * as THREE from 'three';
import { COLOR_GLSL } from '../../core/glsl/common.js';
import { Random, seedFrom } from '../../core/Random.js';
import { bbColor } from './Stars.js';

const KIND_ID = { pillars: 0, cliffs: 1, shell: 2, veil: 3 };

const VERT = /* glsl */ `
varying vec3 vWorld;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

const FRAG = /* glsl */ `
precision highp float;
${COLOR_GLSL}
uniform sampler3D uNoise;
uniform vec3 uCenter; uniform float uRadius, uSeed, uKind, uRot, uSteps, uGain, uFade, uScale;
uniform vec2 uRes;
varying vec3 vWorld;

vec4 nz(vec3 p){ return texture(uNoise, p); }
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
const vec3 STAR = vec3(0.0, 0.42, 0.0);

// returns (gas, dust)
vec2 field(vec3 x){
  float r = length(x);
  vec3 sp = vec3(uSeed);
  float edge = 1.0 - smoothstep(0.6, 1.0, r);
  vec3 w = nz(x * 0.6 + sp).rgb - 0.5;
  vec3 xw = x + w * 0.28;
  float gasN = nz(xw * 1.1 + sp * 1.3).r;
  float gasF = nz(xw * 3.3 + sp).g;
  float gas = edge * (0.25 + gasN * 0.9) * (0.35 + gasF);
  float dust = 0.0;
  if (uKind < 1.5) {
    // cosmic cliffs / pillars: an eroded dust wall below a turbulent skyline,
    // the hot cluster above it carves the cavity (Carina, Eagle)
    float h1 = nz(vec3(xw.x * 0.7, 0.13, xw.z * 0.7) + sp).r - 0.5;
    float h2 = nz(vec3(xw.x * 2.1, 0.57, xw.z * 2.1) + sp).b - 0.5;
    float h3 = nz(vec3(xw.x * 5.5, 0.91, xw.z * 5.5) + sp).g - 0.5;
    float sky = -0.12 + h1 * 0.75 + h2 * 0.32 + h3 * 0.1;
    if (uKind < 0.5) {
      float cl = nz(vec3(xw.x * 1.5, 0.33, xw.z * 1.5) + sp * 1.7).b;
      sky += pow(cl, 9.0) * 1.4 - 0.18;          // a few tall columns rising toward the cluster
    }
    float hgt = sky - xw.y;
    float wall = smoothstep(-0.015, 0.09, hgt);
    float t1 = nz(xw * 3.6 + sp).g, t2 = nz(xw * 8.5 + sp * 0.5).r;
    dust = wall * (0.3 + 2.2 * t1 * t2) * edge;
    gas *= 0.45 + 1.2 * smoothstep(0.35, -0.05, -hgt) * smoothstep(-0.3, 0.0, -hgt);  // bright layer hugging the cliff top
  } else if (uKind < 2.5) {
    // shell / bubble with filaments
    vec3 sd = x - STAR; float rs = length(sd);
    float sh = exp(-pow((rs - 0.58 - (gasN - 0.5) * 0.25) / 0.09, 2.0));
    gas = edge * (0.15 + sh * 2.2) * (0.4 + gasF);
    dust = sh * smoothstep(0.55, 0.85, nz(xw * 3.0 + sp).b) * 1.5 + smoothstep(0.62, 0.9, nz(xw * 1.5 + sp).r) * edge;
  } else {
    // veil: thin ridged sheets
    float rid = nz(xw * 1.6 + sp).b;
    gas = edge * pow(rid, 6.0) * 4.0 + edge * 0.1;
    dust = edge * smoothstep(0.6, 0.85, nz(xw * 2.2 + sp * 0.7).r) * 0.8;
  }
  // ionized cavity: little gas right around the cluster
  gas *= smoothstep(0.05, 0.3, length(x - STAR));
  return vec2(gas, dust);
}

void main(){
  vec3 ro = cameraPosition, rd = normalize(vWorld - ro);
  vec3 oc = ro - uCenter;
  float b = dot(oc, rd), c = dot(oc, oc) - uRadius * uRadius, h = b * b - c;
  if (h <= 0.0) discard;
  h = sqrt(h);
  float t0 = max(-b - h, 0.0), t1 = -b + h;
  if (t1 <= t0) discard;
  float N = uSteps;
  float dt = (t1 - t0) / N;
  float jit = ign(gl_FragCoord.xy);
  vec3 col = vec3(0.0);
  float T = 1.0;
  vec3 cHa = vec3(1.0, 0.11, 0.08), cOIII = vec3(0.12, 0.55, 1.0), cSII = vec3(1.0, 0.38, 0.1), cDust = vec3(0.55, 0.32, 0.18);
  float stepU = dt / uRadius; // step in unit-sphere coordinates
  for (int i = 0; i < 96; i++) {
    if (float(i) >= N) break;
    float t = t0 + (float(i) + jit) * dt;
    vec3 x = (ro + rd * t - uCenter) / uRadius;
    x.xz = rot(uRot) * x.xz;
    vec2 f = field(x);
    float gas = f.x, dust = f.y;
    if (gas + dust < 0.004) continue;
    vec3 sd = STAR - x; float rs = length(sd);
    vec3 toS = sd / max(rs, 1e-4);
    // one shadow tap toward the cluster: is this sample on the lit face of the dust?
    float occ = field(x + toS * 0.07).y + 0.5 * field(x + toS * 0.18).y;
    float lit = exp(-occ * 3.2) / (1.0 + rs * rs * 3.0);
    float ion = smoothstep(0.7, 0.1, rs);
    // gas: OIII-teal hot cavity near the cluster → Hα/SII red-pink outer envelope
    vec3 gcol = mix(mix(cHa, vec3(1.0, 0.28, 0.42), 0.35), cOIII * 1.3, ion);
    vec3 e = gas * lit * gcol * 0.8;
    e += gas * cHa * 0.05 * (1.0 - ion);                     // diffuse recombination glow
    // dust (JWST look): surfaces facing the cluster glow warm (PAH + scattered light),
    // the ionization front itself is a thin bright yellow-white rim; shadowed dust stays dark
    float front = exp(-occ * 7.0);
    e += dust * lit * (cSII * 2.6 + vec3(1.0, 0.85, 0.6) * front * 4.5);
    e += dust * cDust * 0.06;
    float sigma = dust * 14.0 + gas * 0.25;
    float a = exp(-sigma * stepU * 2.0);
    col += T * e * (1.0 - a) / max(sigma, 1e-3);
    T *= a;
    if (T < 0.01) break;
  }
  // the ionizing cluster itself
  vec3 sw = STAR; sw.xz = rot(-uRot) * sw.xz;
  vec3 sc = uCenter + sw * uRadius;
  float bd = length(cross(sc - ro, rd));
  float core = exp(-bd * bd / (uRadius * uRadius * 0.0004));
  col += vec3(0.75, 0.85, 1.0) * core * 6.0 * T;
  col *= uGain * uFade;
  float alpha = (1.0 - T) * uFade;
  gl_FragColor = vec4(col, alpha);
}`;

const COMP = /* glsl */ `
uniform sampler2D tInput, tNeb; uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  vec4 n = texture2D(tNeb, vUv + uTexel * vec2(-0.5, -0.5)) + texture2D(tNeb, vUv + uTexel * vec2(0.5, -0.5))
         + texture2D(tNeb, vUv + uTexel * vec2(-0.5, 0.5)) + texture2D(tNeb, vUv + uTexel * vec2(0.5, 0.5));
  n *= 0.25;
  vec3 c = texture2D(tInput, vUv).rgb;
  gl_FragColor = vec4(c * (1.0 - n.a) + n.rgb, 1.0);
}`;

export class Nebulae {
  constructor(engine, P, list, noise3D) {
    this.engine = engine;
    this.list = list;
    this.enabled = false;
    const q = engine.quality;
    this.scale = engine.shotMode ? 0.5 : q.pick(0.35, 0.45, 0.5, 0.65);
    this.scene = new THREE.Scene();
    this.stars = new THREE.Group();
    const sphere = new THREE.IcosahedronGeometry(1, 3);
    this.items = list.map((n) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, transparent: true,
        depthTest: false, depthWrite: false,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
        uniforms: {
          uNoise: { value: noise3D }, uCenter: { value: n.pos.clone() }, uRadius: { value: n.radius }, uSeed: { value: (n.seed % 1) + n.index * 0.37 },
          uKind: { value: KIND_ID[n.kind] ?? 0 }, uRot: { value: n.rot }, uSteps: { value: engine.shotMode ? 64 : q.pick(28, 40, 56, 72) },
          uGain: { value: 1.5 }, uFade: { value: 1 }, uScale: { value: 1 }, uRes: { value: new THREE.Vector2() },
        },
      });
      const mesh = new THREE.Mesh(sphere, m);
      mesh.position.copy(n.pos);
      mesh.scale.setScalar(n.radius * 1.02);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      return { n, mesh, mat: m };
    });
    this.sphere = sphere;
    this._buildClusters();
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
    this.comp = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: COMP, depthTest: false, depthWrite: false,
      uniforms: { tInput: { value: null }, tNeb: { value: null }, uTexel: { value: new THREE.Vector2() } },
    });
  }

  // a few dozen hot young stars at each nebula's heart (drawn by the overlay pass)
  _buildClusters() {
    const pos = [], col = [];
    const tmp = [0, 0, 0];
    for (const it of this.items) {
      const n = it.n;
      const rng = new Random(seedFrom(Math.floor(n.seed * 1000), 'neb-cluster', n.index));
      const c = new THREE.Vector3(0, 0.42, 0);
      c.applyAxisAngle(new THREE.Vector3(0, 1, 0), n.rot).multiplyScalar(n.radius).add(n.pos);
      for (let k = 0; k < 70; k++) {
        const s = n.radius * (k < 30 ? 0.05 : 0.22);
        pos.push(c.x + rng.gaussian(0, s), c.y + rng.gaussian(0, s), c.z + rng.gaussian(0, s));
        bbColor(rng.range(12000, 35000), tmp);
        col.push(tmp[0] * 255, tmp[1] * 255, tmp[2] * 255, Math.round(Math.log2(rng.logRange(20, 600)) * 16 + 128));
      }
    }
    this.clusterGeo = new THREE.BufferGeometry();
    this.clusterGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.clusterGeo.setAttribute('aCol', new THREE.BufferAttribute(new Uint8Array(col), 4, true));
  }

  update(camera) {
    let any = false;
    for (const it of this.items) {
      const d = camera.position.distanceTo(it.n.pos);
      const R = it.n.radius;
      const fade = 1 - THREE.MathUtils.smoothstep(d, R * 14, R * 30);
      it.mat.uniforms.uFade.value = fade;
      it.mesh.visible = fade > 0.001;
      any = any || it.mesh.visible;
    }
    this.enabled = any;
  }

  render(renderer, input, output, ctx) {
    const w = Math.max(2, Math.round(ctx.width * this.scale)), h = Math.max(2, Math.round(ctx.height * this.scale));
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    const prevColor = renderer.getClearColor(new THREE.Color()), prevA = renderer.getClearAlpha();
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    const ac = renderer.autoClear; renderer.autoClear = false;
    renderer.render(this.scene, ctx.camera);
    renderer.autoClear = ac;
    renderer.setClearColor(prevColor, prevA);
    this.comp.uniforms.tInput.value = input;
    this.comp.uniforms.tNeb.value = this.rt.texture;
    this.comp.uniforms.uTexel.value.set(1 / w, 1 / h);
    ctx.fullscreen(this.comp, output);
  }

  dispose() {
    this.rt.dispose(); this.comp.dispose(); this.sphere.dispose(); this.clusterGeo.dispose();
    for (const it of this.items) it.mat.dispose();
  }
}
