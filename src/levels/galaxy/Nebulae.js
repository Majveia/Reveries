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
uniform vec3 uCenter; uniform float uRadius, uSeed, uKind, uRot, uSteps, uGain, uFade, uScale, uFrameJ;
uniform vec2 uRes;
varying vec3 vWorld;

vec4 nz(vec3 p){ return texture(uNoise, p); }
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
const vec3 STAR = vec3(0.0, 0.42, 0.0);
const mat3 RT = mat3(0.80, 0.36, -0.48, -0.60, 0.48, -0.64, 0.0, 0.80, 0.60);   // 2nd lattice: breaks tiling

vec3 SP;
float gHG = -1.0;   // signed height above the dust skyline at the last field() sample
// signed height above the dust skyline (>0 = inside the dust) for cliffs / pillars
float cliffH(vec3 xw){
  // secondary 3D domain warp (rotated lattice): overhangs and erosion instead of extruded
  // vertical curtains where the heightfield is steep
  xw += (nz(RT * xw * 0.75 + SP * 0.6).gbr - 0.5) * vec3(0.32, 0.12, 0.32);
  vec2 h = xw.xz;
  float s = -0.26;   // (ridged channel B has mean ≈0.71, fbm R/G ≈0.48)
  s += (nz(vec3(h * 0.13, 0.13) + SP).r - 0.5) * 2.6;                 // broad terrain
  s += (nz(vec3(h * 0.42, 0.57) + SP).b - 0.71) * 0.9;                // ridged peaks
  if (uKind < 0.5) {
    float cl = nz(vec3(h * 0.27, 0.33) + SP * 1.7).b;
    s += pow(smoothstep(0.8, 0.97, cl), 1.5) * 0.8;                  // columns rising toward the cluster
  }
  // 3D erosion: knobs, overhangs, eroded globules (two rotated lattices)
  s += (nz(xw * 0.9 + SP).b - 0.71) * 0.30;
  s += (nz(RT * xw * 2.3 + SP).g - 0.5) * 0.16;
  s += (nz(xw * 5.7 + SP * 0.3).b - 0.71) * 0.07;
  s += (nz(RT * xw * 13.0).r - 0.5) * 0.035;
  return s - xw.y;
}
vec3 warp(vec3 x){ return x + (nz(x * 0.17 + SP).rgb - 0.5) * 0.5; }
float edgeF(vec3 x){ return 1.0 - smoothstep(0.78, 1.0, length(x)); }

// dust density only (light march)
float dustF(vec3 x){
  vec3 xw = warp(x);
  float e = edgeF(x);
  if (uKind < 1.5) {
    float hg = cliffH(xw);
    return (smoothstep(0.0, 0.02, hg) * 1.2 + smoothstep(0.84, 0.96, nz(RT * xw * 0.8 + SP).b) * exp(-max(-hg, 0.0) * 6.0) * 0.25) * e;
  } else if (uKind < 2.5) {
    vec3 sd = x - STAR; float rs = length(sd);
    float shd = (rs - 0.55) / 0.08; float sh = exp(-shd * shd);
    return (sh * smoothstep(0.76, 0.92, nz(xw * 2.4 + SP).b) * 1.4 + smoothstep(0.66, 0.85, nz(RT * xw * 1.1 + SP).r) * 0.8) * e;
  }
  return smoothstep(0.62, 0.82, nz(xw * 1.4 + SP * 0.7).r) * 0.7 * e;
}

// returns (gas, dust, skin)
vec3 field(vec3 x){
  vec3 xw = warp(x);
  float e = edgeF(x);
  float gasN = nz(RT * xw * 0.22 + SP * 1.3).r;
  float gasF = nz(xw * 1.3 + SP).g;
  float gasW = nz(RT * xw * 3.1 + SP).b;
  float gas = e * smoothstep(0.4, 0.62, gasN) * (0.15 + 1.6 * gasF * gasF) * (0.3 + 0.9 * gasW);
  float dust = 0.0, skin = 0.0;
  if (uKind < 1.5) {
    float hg = cliffH(xw);
    gHG = hg;
    float wall = smoothstep(0.0, 0.02, hg);
    dust = wall * (0.7 + 0.9 * nz(xw * 2.0 + SP).g) * (0.55 + 0.9 * nz(RT * xw * 7.0 + SP).b * nz(xw * 17.0).g) * e;
    dust += smoothstep(0.84, 0.96, nz(RT * xw * 0.8 + SP).b) * exp(-max(-hg, 0.0) * 6.0) * 0.25 * e;
    float above = -hg;
    gas *= smoothstep(0.0, 0.12, above);
    // photo-evaporating skin of ionized gas hugging the cliff surface
    // crisp ionization-front skin, broken into bright knots by the ridged detail
    float kn = nz(RT * xw * 9.0 + SP * 0.7).b;
    // JWST 'combed' texture: fine streamers stretched toward the cluster (photo-evaporation flow)
    // stretched along the direction to the cluster (anisotropy 4:1) in the rotated lattice,
    // so streamers point at the ionizing stars and never align with the texture axes
    vec3 dS = normalize(STAR - x);
    float al = dot(xw, dS);
    float comb = nz(RT * ((xw - dS * al) * 22.0 + dS * al * 5.5) + SP).g;
    skin = e * smoothstep(-0.004, 0.004, above) * (exp(-max(above, 0.0) / 0.006) * 2.2 + exp(-max(above, 0.0) / 0.035) * 0.22) * (0.2 + 1.5 * kn * kn) * (0.45 + 1.1 * comb);
    dust *= 0.75 + 0.5 * comb;
  } else if (uKind < 2.5) {
    vec3 sd = x - STAR; float rs = length(sd);
    float shd = (rs - 0.58 - (gasN - 0.5) * 0.4) / 0.07; float sh = exp(-shd * shd);
    gas = e * sh * (0.4 + 1.6 * gasF) * 1.6 + gas * 0.3;
    dust = dustF(x);
  } else {
    float rid = nz(xw * 1.6 + SP).b;
    gas = e * pow(smoothstep(0.66, 1.0, rid), 3.0) * 4.0 + gas * 0.25;
    dust = dustF(x);
  }
  // hot, diffuse OIII-bright cavity carved by the cluster's winds and UV
  if (uKind < 1.5) gas += e * e * smoothstep(0.95, 0.1, length(x - STAR)) * (0.15 + 1.3 * gasF * gasF) * smoothstep(0.0, 0.15, -cliffH(xw)) * 0.75;
  gas *= smoothstep(0.06, 0.3, length(x - STAR));   // ionized, cleared cavity right at the cluster
  return vec3(gas, dust, skin);
}

void main(){
  SP = vec3(uSeed);
  vec3 ro = cameraPosition, rd = normalize(vWorld - ro);
  vec3 oc = ro - uCenter;
  float b = dot(oc, rd), c = dot(oc, oc) - uRadius * uRadius, h = b * b - c;
  if (h <= 0.0) discard;
  h = sqrt(h);
  float t0 = max(-b - h, 0.0), t1 = -b + h;
  if (t1 <= t0) discard;
  float N = uSteps;
  float dt = (t1 - t0) / N;
  float jit = fract(ign(gl_FragCoord.xy) + uFrameJ);
  vec3 col = vec3(0.0);
  float T = 1.0;
  vec3 cHa = vec3(1.0, 0.09, 0.07), cOIII = vec3(0.05, 0.62, 1.0), cSII = vec3(1.0, 0.36, 0.08);
  vec3 cStar = vec3(0.75, 0.85, 1.0);
  float stepU = dt / uRadius;
  vec3 rdl = rd; rdl.xz = rot(uRot) * rdl.xz;
  float prevHG = -1.0;
  bool walled = false;
  for (int i = 0; i < 160; i++) {
    if (float(i) >= N) break;
    float t = t0 + (float(i) + jit) * dt;
    vec3 x = (ro + rd * t - uCenter) / uRadius;
    x.xz = rot(uRot) * x.xz;
    gHG = -1.0;
    vec3 f = field(x);
    float gas = f.x, dust = f.y, skin = f.z;
    // ray pierces the dust surface between two samples: a sub-step event, so the ionization front
    // stays razor sharp regardless of step size; limb-brightened where the ray grazes the skyline
    float dHG = gHG - prevHG;
    bool hitWall = !walled && uKind < 1.5 && prevHG < 0.0 && gHG >= 0.0 && i > 0;   // first (visible) surface only
    walled = walled || hitWall;
    prevHG = gHG;
    if (gas + dust + skin < 0.003) continue;
    vec3 sd = STAR - x; float rs = length(sd);
    vec3 toS = sd / max(rs, 1e-4);
    // short light march toward the cluster (dust only): shadows, rays, lit faces
    float occ = dustF(x + toS * 0.025) * 0.025 + dustF(x + toS * 0.07) * 0.045 + dustF(x + toS * 0.16) * 0.09 + dustF(x + toS * 0.32) * 0.16;
    float tr = exp(-occ * 105.0);
    float I = tr / (0.25 + rs * rs * 2.5);
    float ion = smoothstep(0.9, 0.15, rs);
    // Henyey-Greenstein forward scattering (g = 0.6)
    float cth = dot(rdl, -toS) * -1.0;
    float hg = 0.0509 * (1.0 - 0.36) / pow(1.0 + 0.36 - 1.2 * cth, 1.5) * 12.566;
    // gas: hot OIII cavity around the cluster, Hα/SII envelope further out
    // colours stay separated (not averaged into lavender): OIII only deep in the hot cavity
    float ionC = smoothstep(0.5, 0.85, ion);
    vec3 gcol = mix(mix(cHa, cSII, 0.3), cOIII, ionC) * mix(1.0, 0.55, ionC * (1.0 - ionC) * 4.0);
    vec3 e = gas * I * gcol * 0.55;
    if (hitWall) {
      float limb = clamp(stepU * 1.2 / max(dHG, 1e-4), 1.0, 7.0);
      float wL = pow((limb - 1.0) / 6.0, 0.8);                    // silhouettes / skyline glow, faces stay modest
      float knR = nz(RT * x * 3.7 + SP * 0.7).b;
      col += T * I * (0.012 + 0.16 * wL) * (0.5 + 1.0 * knR) * mix(vec3(1.0, 0.6, 0.38), vec3(1.0, 0.88, 0.7), wL);
    }
    e += skin * I * mix(cSII, vec3(1.0, 0.82, 0.55), 0.45) * 7.0;               // ionization front
    float sigD = dust * 88.0;
    // dust scatters starlight (albedo ~0.5, forward peaked): a lit cliff face reads as a surface
    e += sigD * I * vec3(1.0, 0.55, 0.26) * 0.12 * (0.25 + hg);
    e += sigD * vec3(0.9, 0.3, 0.16) * 0.0035 * (0.3 + ion);                      // Hα-reddened light on shadowed dust
    float sigma = sigD + gas * 0.35 + skin * 0.2;
    float a = exp(-sigma * stepU);
    col += T * e * (sigma > 1e-3 ? (1.0 - a) / sigma : stepU);
    T *= a;
    if (T < 0.008) break;
  }
  // the ionizing cluster's own glow
  vec3 sw = STAR; sw.xz = rot(-uRot) * sw.xz;
  vec3 sc = uCenter + sw * uRadius;
  float bd = length(cross(sc - ro, rd)) / uRadius;
  col += cStar * (exp(-bd * bd / 0.000004) * 0.8 + exp(-bd / 0.05) * 0.07)   // (the cluster's stars carry the cores + spikes)
          * T * step(0.0, dot(sc - ro, rd));
  col *= uGain * uFade;
  float alpha = (1.0 - T) * uFade;
  gl_FragColor = vec4(col, alpha);
}`;

const ACC = /* glsl */ `
uniform sampler2D tNew, tOld; uniform float uW;
varying vec2 vUv;
void main(){ gl_FragColor = mix(texture2D(tOld, vUv), texture2D(tNew, vUv), uW); }`;

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
    this.scale = engine.shotMode ? 0.85 : q.pick(0.35, 0.45, 0.5, 0.6);
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
          uKind: { value: KIND_ID[n.kind] ?? 0 }, uRot: { value: n.rot }, uSteps: { value: engine.shotMode ? 112 : q.pick(36, 52, 72, 96) },
          uGain: { value: 1.6 }, uFade: { value: 1 }, uScale: { value: 1 }, uFrameJ: { value: 0 }, uRes: { value: new THREE.Vector2() },
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
    this.acc = [0, 1].map(() => new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false }));
    this.accMat = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: ACC, depthTest: false, depthWrite: false,
      uniforms: { tNew: { value: null }, tOld: { value: null }, uW: { value: 1 } },
    });
    this._accN = 0; this._accI = 0; this._camKey = new THREE.Matrix4();
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
    const per = this.engine.quality.pick(500, 900, 1300, 1600);
    const ax = new THREE.Vector3(0, 1, 0);
    const v = new THREE.Vector3();
    for (const it of this.items) {
      const n = it.n;
      const rng = new Random(seedFrom(Math.floor(n.seed * 1000), 'neb-cluster', n.index));
      for (let k = 0; k < per; k++) {
        const core = k < per * 0.18;
        if (core) v.set(rng.gaussian(0, 0.05), 0.42 + rng.gaussian(0, 0.04), rng.gaussian(0, 0.05));
        else {
          // embedded stars fill the cleared cavity above the dust skyline
          do { v.set(rng.range(-0.9, 0.9), rng.range(0.0, 0.9), rng.range(-0.9, 0.9)); } while (v.lengthSq() > 0.8);
        }
        v.applyAxisAngle(ax, -n.rot).multiplyScalar(n.radius).add(n.pos);
        pos.push(v.x, v.y, v.z);
        const hot = core || rng.chance(0.35);
        bbColor(hot ? rng.range(11000, 35000) : rng.range(3200, 7500), tmp);
        // Salpeter-like: dN/dL ∝ L^-2 → a handful of very bright stars get the diffraction spikes
        const L = Math.min(4000, (core ? 6 : 0.6) * Math.pow(1 - rng.float() * 0.999, -1.15));
        col.push(tmp[0] * 255, tmp[1] * 255, tmp[2] * 255, Math.max(0, Math.min(255, Math.round(Math.log2(L) * 16 + 128))));
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
    if (this.rt.width !== w || this.rt.height !== h) { this.rt.setSize(w, h); for (const a of this.acc) a.setSize(w, h); this._accN = 0; }
    const prevColor = renderer.getClearColor(new THREE.Color()), prevA = renderer.getClearAlpha();
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    const ac = renderer.autoClear; renderer.autoClear = false;
    renderer.render(this.scene, ctx.camera);
    renderer.autoClear = ac;
    renderer.setClearColor(prevColor, prevA);
    // progressive refinement: while the camera holds still, jittered frames accumulate
    // (golden-ratio jitter sequence) so the half-step dither converges to a clean volume
    const cm = ctx.camera.matrixWorld;
    let still = true;
    for (let k = 0; k < 16; k++) if (Math.abs(cm.elements[k] - this._camKey.elements[k]) > 1e-7 * (1 + Math.abs(cm.elements[k]))) { still = false; break; }
    this._camKey.copy(cm);
    this._accN = still ? Math.min(this._accN + 1, this.engine.shotMode ? 64 : 16) : 1;
    const f = (this._f = ((this._f || 0) + 1) % 64);
    for (const it of this.items) it.mat.uniforms.uFrameJ.value = (f * 0.6180339) % 1;
    const src = this.acc[this._accI], dst = this.acc[1 - this._accI];
    this.accMat.uniforms.tNew.value = this.rt.texture; this.accMat.uniforms.tOld.value = src.texture;
    this.accMat.uniforms.uW.value = 1 / this._accN;
    ctx.fullscreen(this.accMat, dst);
    this._accI = 1 - this._accI;
    this.comp.uniforms.tInput.value = input;
    this.comp.uniforms.tNeb.value = dst.texture;
    this.comp.uniforms.uTexel.value.set(1 / w, 1 / h);
    ctx.fullscreen(this.comp, output);
  }

  dispose() {
    this.rt.dispose(); for (const a of this.acc) a.dispose(); this.accMat.dispose(); this.comp.dispose(); this.sphere.dispose(); this.clusterGeo.dispose();
    for (const it of this.items) it.mat.dispose();
  }
}
