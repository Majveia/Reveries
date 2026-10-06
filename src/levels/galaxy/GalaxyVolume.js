// Volumetric galaxy light: the unresolved starlight of the disk (young blue arms,
// old warm disk), HII glow, the Sersic bulge and — most importantly — absorbing
// dust, raymarched at reduced resolution and composited over the scene.
//
// Per ray segment the face-on structure map is sampled once at the segment midpoint
// while each component's sech² vertical profile is integrated EXACTLY over the
// segment, so a 100 pc dust layer seen face-on or edge-on is never stepped over.
// The bulge is integrated analytically (flattened Gaussian mixture, erf) and
// attenuated by the dust transmittance at the ray's closest approach to the core.
//
// Emission close to the camera fades out ("resolved" into the point star layers),
// dust does not — near dust silhouettes against the bright background like the
// Milky Way's Great Rift.

import * as THREE from 'three';
import { FULLSCREEN_VERT, COLOR_GLSL } from '../../core/glsl/common.js';
import { GAL_GLSL } from './GalaxyModel.js';

const MARCH_FRAG = /* glsl */ `
precision highp float;
${COLOR_GLSL}
${GAL_GLSL}
uniform sampler3D uNoise;
uniform mat4 uProjInv, uViewInv;
uniform vec3 uCam;
uniform float uBulgeDim, uSteps, uR, uBulgeQ, uBulgeScale, uBulgeAmp, uEmit, uNearFade, uPixAngle, uFrame, uDetail, uYoungGain, uThick, uNucleus, uInside;
uniform vec3 uColYoung, uColOld, uColHII, uColBulge, uColDustGlow;
uniform vec2 uRes;
varying vec2 vUv;

float erfa(float x){ // Abramowitz-Stegun 7.1.26 (|err| < 1.5e-7)
  float s = sign(x); x = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * x);
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
  return s * y;
}
// ∫ exp(-|S(o + t d)|² / 2σ²) dt over [t0, t1], S = diag(1, 1/q, 1)
float gaussLine(vec3 o, vec3 d, float s, float t0, float t1){
  vec3 so = o * vec3(1.0, 1.0 / uBulgeQ, 1.0), sd = d * vec3(1.0, 1.0 / uBulgeQ, 1.0);
  float L2 = dot(sd, sd), L = sqrt(L2);
  float tc = -dot(so, sd) / L2;
  float b2 = max(dot(so, so) - dot(so, sd) * dot(so, sd) / L2, 0.0);
  float k = L / (s * 1.41421356);
  return exp(-b2 / (2.0 * s * s)) * s * 1.25331414 / L * (erfa((t1 - tc) * k) - erfa((t0 - tc) * k));
}
// bulge (flattened Gaussian mixture ~ Sersic n≈3) + compact nuclear star cluster, over [t0, t1]
float bulgeLine(vec3 o, vec3 d, float t0, float t1){
  float s = uBulgeScale;
  return gaussLine(o, d, s * 0.012, t0, t1) * uNucleus
       + gaussLine(o, d, s * 0.05, t0, t1) * 6.0
       + gaussLine(o, d, s * 0.16, t0, t1) * 1.6
       + gaussLine(o, d, s * 0.45, t0, t1) * 0.42
       + gaussLine(o, d, s * 1.1, t0, t1) * 0.07;
}
vec2 slab(vec3 o, vec3 d, float h){
  if (abs(d.y) < 1e-6) return abs(o.y) < h ? vec2(0.0, 1e9) : vec2(1.0, 0.0);
  float a = (-h - o.y) / d.y, b = (h - o.y) / d.y;
  return vec2(min(a, b), max(a, b));
}
vec2 cyl(vec3 o, vec3 d, float R){
  float A = dot(d.xz, d.xz), B = dot(o.xz, d.xz), C = dot(o.xz, o.xz) - R * R;
  if (A < 1e-9) return C < 0.0 ? vec2(0.0, 1e9) : vec2(1.0, 0.0);
  float D = B * B - A * C; if (D < 0.0) return vec2(1.0, 0.0);
  D = sqrt(D); return vec2((-B - D) / A, (-B + D) / A);
}

void main(){
  vec4 cp = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize((uViewInv * vec4(normalize(cp.xyz / cp.w), 0.0)).xyz);
  vec3 ro = uCam;
  float H = max(uHOld * 6.0, uHDust * 10.0);
  vec2 ts = slab(ro, rd, H), tcyl = cyl(ro, rd, uExtent);
  float t0 = max(max(ts.x, tcyl.x), 0.0), t1 = min(ts.y, tcyl.y);
  vec3 col = vec3(0.0);
  vec3 T = vec3(1.0);
  const vec3 KRGB = vec3(0.8, 1.0, 1.22);   // wavelength-dependent extinction: lane edges redden
  vec3 cB = uColBulge * uBulgeAmp * uEmit * uBulgeDim;
  float camR = length(ro * vec3(1.0, 1.0 / uBulgeQ, 1.0));
  float inBulge = max((1.0 - smoothstep(uBulgeScale * 0.2, uBulgeScale * 1.5, camR)) * 0.7, uInside);
  if (t1 > t0) {
    // bulge light in front of the dusty slab
    col += bulgeLine(ro, rd, 0.0, t0) * cB;
    float N = uSteps;
    float jit = ign(gl_FragCoord.xy + uFrame * 5.588);
    // inside the slab: geometric steps (fine near the camera, long far away) so the near
    // dust resolves into rifts while the far disk still integrates into a band
    bool inside = t0 <= 0.0;
    float tmin = 0.012;
    float span = t1 - t0;
    float G = inside ? log(1.0 + span / tmin) : 0.0;
    float ta = t0;
    for (int i = 0; i < 160; i++) {
      if (float(i) >= N) break;
      float u = min((float(i) + 1.0 + (jit - 0.5) * 0.9) / N, 1.0);
      if (i == int(N) - 1) u = 1.0;
      float tb = inside ? t0 + tmin * (exp(G * u) - 1.0) : t0 + span * u;
      tb = min(tb, t1);
      vec3 pa = ro + rd * ta, pb = ro + rd * tb;
      vec3 pm = 0.5 * (pa + pb);
      float seg = tb - ta;
      float tm = 0.5 * (ta + tb);
      float lod = log2(max(tm * uPixAngle * 0.8, seg * 0.25) / uMapTexel);
      vec4 m = galMap(pm, max(lod, 0.0));
      float det = 1.0;
      if (uDetail > 0.0 && tm < 3.0) {
        vec4 n1 = texture(uNoise, pm * 1.7);
        vec4 n2 = texture(uNoise, pm * 9.0 + n1.xyz * 0.15);
        det = mix(1.0, (0.35 + 1.3 * n1.r) * (0.4 + 1.2 * n2.b), uDetail * (1.0 - smoothstep(0.8, 3.0, tm)));
      }
      float pY = galSeg(pa.y, pb.y, uHYoung), pO = galSeg(pa.y, pb.y, uHOld), pD = galSeg(pa.y, pb.y, uHDust);
      float pT = galSeg(pa.y, pb.y, uHOld * 2.6);
      // inside the disk the near dust condenses into discrete opaque clouds with clear gaps
      // between them: the band breaks into Great-Rift silhouettes instead of a smooth haze
      float dIn = det;
      if (uInside > 0.0 && tm < 3.0) {
        vec4 c1 = texture(uNoise, pm * vec3(1.6, 3.0, 1.6) + 0.37);
        vec4 c2 = texture(uNoise, pm * vec3(6.0, 9.0, 6.0) + c1.xyz * 0.3);
        float cl = smoothstep(0.57, 0.65, c1.g * 0.6 + c2.r * 0.4);
        dIn = mix(det * det * 1.3, (0.04 + cl * cl * 9.0) * (0.5 + c2.b), 1.0 - smoothstep(0.8, 2.0, tm));
      }
      float tau = m.b * pD * seg * uKappa * mix(det, dIn, uInside);
      vec3 cOld = mix(mix(uColOld, vec3(0.95, 0.9, 0.86), uInside), vec3(0.78, 0.82, 1.0), smoothstep(0.08 * uR, 0.55 * uR, length(pm.xz)) * 0.75);
      vec3 j = (m.r * uColYoung * pY * uYoungGain + m.g * cOld * (pO + pT * uThick * (1.0 - uInside)) * mix(1.0, smoothstep(0.0, uNearFade * 3.0, tm), uInside) + m.a * uColHII * pD * 1.6 * det * smoothstep(0.3, 2.0, tm) * (1.0 - 0.7 * uInside)) * uEmit;
      j += m.b * pD * uColDustGlow * uEmit;
      float near = smoothstep(0.0, uNearFade, tm);
      vec3 tr = exp(-tau * KRGB);
      vec3 add = j * seg * near * (tau > 1e-4 ? (1.0 - tr) / (tau * KRGB) : vec3(1.0));
      // the bulge is integrated per segment so the midplane lane slices straight through it
      float bn = mix(1.0, smoothstep(0.0, uNearFade * 1.5, tm), inBulge);
      add += bulgeLine(ro, rd, ta, tb) * bn * cB * (tau > 1e-4 ? (1.0 - tr) / (tau * KRGB) : vec3(1.0));
      col += T * add;
      T *= tr;
      ta = tb;
      if (T.g < 0.002) break;
    }
    col += T * bulgeLine(ro, rd, t1, 1e5) * cB;
  } else {
    float bn = mix(1.0, smoothstep(0.0, uNearFade * 1.5, max(-dot(ro, rd), 0.0)), inBulge);
    col += bulgeLine(ro, rd, 0.0, 1e5) * cB * bn;
  }
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  gl_FragColor = vec4(max(col, 0.0), clamp(dot(T, vec3(0.3, 0.45, 0.25)), 0.0, 1.0));
}`;

const COMP_FRAG = /* glsl */ `
uniform sampler2D tInput, tVol; uniform vec2 uTexel;
uniform mat4 uProjInv, uViewInv; uniform float uGrain, uGrainK;
varying vec2 vUv;
float h13(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
void main(){
  // 4-tap tent upsample of the half-res volume (smooth, no blockiness)
  vec4 v = texture2D(tVol, vUv + uTexel * vec2(-0.5, -0.5)) + texture2D(tVol, vUv + uTexel * vec2(0.5, -0.5))
         + texture2D(tVol, vUv + uTexel * vec2(-0.5, 0.5)) + texture2D(tVol, vUv + uTexel * vec2(0.5, 0.5));
  v *= 0.25;
  vec3 c = texture2D(tInput, vUv).rgb;
  if (uGrain > 0.0) {
    // inside the disk the unresolved band breaks into myriad faint stars: a full-resolution,
    // direction-locked (no swimming) sparkle field modulates the diffuse light (mean ≈ 1)
    vec4 cp = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 rd = normalize((uViewInv * vec4(normalize(cp.xyz / cp.w), 0.0)).xyz);
    vec3 cell = floor(rd * uGrainK);
    float h = h13(cell), h2 = h13(cell + 17.3);
    float s = pow(h, 14.0) * 6.0 + pow(h2, 2.0) * 0.75;
    v.rgb *= mix(1.0, 0.35 + s, uGrain);
  }
  gl_FragColor = vec4(c * v.a + v.rgb, 1.0);
}`;

export class GalaxyVolume {
  constructor(engine, P, mapRT, noise3D) {
    this.engine = engine;
    this.enabled = true;
    this.P = P;
    const q = engine.quality;
    this.scale = engine.shotMode ? 0.85 : q.pick(0.33, 0.4, 0.5, 0.6);
    this.baseScale = this.scale;
    this.steps = engine.shotMode ? 110 : q.pick(32, 44, 60, 80);
    const mapSize = mapRT.width;
    this.march = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: MARCH_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        uMap: { value: mapRT.texture }, uNoise: { value: noise3D },
        uExtent: { value: P.extent }, uHOld: { value: P.hOld }, uHYoung: { value: P.hYoung }, uHDust: { value: P.hDust },
        uKappa: { value: 2.4 }, uMapTexel: { value: (2 * P.extent) / mapSize },
        uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() },
        uSteps: { value: this.steps }, uR: { value: P.R }, uBulgeQ: { value: P.bulgeQ }, uBulgeScale: { value: P.bulgeScale },
        uBulgeDim: { value: 1 }, uBulgeAmp: { value: P.bulgeAmp }, uEmit: { value: 1.0 }, uNearFade: { value: 0.12 }, uPixAngle: { value: 0.001 },
        uFrame: { value: 0 }, uDetail: { value: 1.0 }, uRes: { value: new THREE.Vector2() }, uYoungGain: { value: 0.48 }, uInside: { value: 0 }, uThick: { value: 0.1 }, uNucleus: { value: 30.0 },
        uColYoung: { value: new THREE.Color(0.42, 0.6, 1.0) }, uColOld: { value: new THREE.Color(1.0, 0.8, 0.6) },
        uColHII: { value: new THREE.Color(1.0, 0.22, 0.38) }, uColBulge: { value: new THREE.Color(1.0, 0.78, 0.52) },
        uColDustGlow: { value: new THREE.Color(0.007, 0.0045, 0.0038) },
      },
    });
    this.comp = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: COMP_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tInput: { value: null }, tVol: { value: null }, uTexel: { value: new THREE.Vector2() }, uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() }, uGrain: { value: 0 }, uGrainK: { value: 500 } },
    });
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.frame = 0;
  }

  render(renderer, input, output, ctx) {
    const w = Math.max(2, Math.round(ctx.width * this.scale)), h = Math.max(2, Math.round(ctx.height * this.scale));
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    const u = this.march.uniforms;
    u.uProjInv.value.copy(ctx.camera.projectionMatrixInverse);
    u.uViewInv.value.copy(ctx.camera.matrixWorld);
    u.uCam.value.copy(ctx.cameraPosition);
    u.uPixAngle.value = (ctx.camera.fov * Math.PI / 180) / h;
    u.uFrame.value = this.engine.shotMode ? 0 : (this.frame++ % 64);
    u.uRes.value.set(w, h);
    ctx.fullscreen(this.march, this.rt);
    this.comp.uniforms.tInput.value = input;
    this.comp.uniforms.tVol.value = this.rt.texture;
    this.comp.uniforms.uTexel.value.set(1 / w, 1 / h);
    const cu = this.comp.uniforms;
    cu.uProjInv.value.copy(ctx.camera.projectionMatrixInverse); cu.uViewInv.value.copy(ctx.camera.matrixWorld);
    cu.uGrain.value = this.march.uniforms.uInside.value * 0.5;
    cu.uGrainK.value = ctx.height / (ctx.camera.fov * Math.PI / 180) * 1.0;
    ctx.fullscreen(this.comp, output);
  }

  dispose() { this.rt.dispose(); this.march.dispose(); this.comp.dispose(); }
}
