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
uniform float uSteps, uR, uBulgeQ, uBulgeScale, uBulgeAmp, uEmit, uNearFade, uPixAngle, uFrame, uDetail;
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
  float T = 1.0;
  float Tclose = 1.0;
  float tClose = max(-dot(ro, rd), 0.0);
  if (t1 > t0) {
    float N = uSteps;
    float dt = (t1 - t0) / N;
    float jit = ign(gl_FragCoord.xy + uFrame * 5.588);
    float ta = t0;
    bool gotClose = false;
    for (int i = 0; i < 160; i++) {
      if (float(i) >= N) break;
      float tb = (i == int(N) - 1) ? t1 : min(t0 + (float(i) + 1.0 + (jit - 0.5) * 0.9) * dt, t1);
      vec3 pa = ro + rd * ta, pb = ro + rd * tb;
      vec3 pm = 0.5 * (pa + pb);
      float seg = tb - ta;
      float tm = 0.5 * (ta + tb);
      float lod = log2(max(tm * uPixAngle * 2.0, seg * 0.35) / uMapTexel);
      vec4 m = galMap(pm, max(lod, 0.0));
      // close-range volumetric detail (3D noise) so the structure never looks like a decal
      float det = 1.0;
      if (uDetail > 0.0 && tm < 3.0) {
        vec4 n1 = texture(uNoise, pm * 1.7);
        vec4 n2 = texture(uNoise, pm * 9.0 + n1.xyz * 0.15);
        det = mix(1.0, (0.35 + 1.3 * n1.r) * (0.4 + 1.2 * n2.b), uDetail * (1.0 - smoothstep(0.8, 3.0, tm)));
      }
      float pY = galSeg(pa.y, pb.y, uHYoung), pO = galSeg(pa.y, pb.y, uHOld), pD = galSeg(pa.y, pb.y, uHDust);
      float tau = m.b * pD * seg * uKappa * det;
      vec3 j = (m.r * uColYoung * pY + m.g * uColOld * pO + m.a * uColHII * pD * 1.6 * det) * uEmit;
      // faint reddish scattered light from the dust itself
      j += m.b * pD * uColDustGlow * uEmit;
      float near = smoothstep(0.0, uNearFade, tm);
      float tr = exp(-tau);
      // emission and absorption co-located within the segment
      vec3 add = j * seg * near * (tau > 1e-4 ? (1.0 - tr) / tau : 1.0);
      col += T * add;
      if (!gotClose && tb >= tClose) { float f = clamp((tClose - ta) / max(seg, 1e-6), 0.0, 1.0); Tclose = T * mix(1.0, tr, f); gotClose = true; }
      T *= tr;
      ta = tb;
      if (T < 0.003) break;
    }
    if (!gotClose) Tclose = T;
  }
  // bulge: flattened Gaussian mixture ~ Sersic(n≈3) — analytic line integral
  float s = uBulgeScale;
  float bt0 = 0.0, bt1 = 1e5;
  float b = gaussLine(ro, rd, s * 0.05, bt0, bt1) * 6.0
          + gaussLine(ro, rd, s * 0.16, bt0, bt1) * 1.6
          + gaussLine(ro, rd, s * 0.45, bt0, bt1) * 0.42
          + gaussLine(ro, rd, s * 1.1, bt0, bt1) * 0.07;
  // resolved-star fade near the camera (inside the bulge the light breaks into stars)
  float camR = length(ro * vec3(1.0, 1.0 / uBulgeQ, 1.0));
  b *= mix(1.0, smoothstep(0.0, uNearFade * 1.5, tClose), smoothstep(s * 1.5, s * 0.2, camR) * 0.7);
  col += b * uBulgeAmp * uColBulge * uEmit * Tclose;
  gl_FragColor = vec4(col, T);
}`;

const COMP_FRAG = /* glsl */ `
uniform sampler2D tInput, tVol; uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  // 4-tap tent upsample of the half-res volume (smooth, no blockiness)
  vec4 v = texture2D(tVol, vUv + uTexel * vec2(-0.5, -0.5)) + texture2D(tVol, vUv + uTexel * vec2(0.5, -0.5))
         + texture2D(tVol, vUv + uTexel * vec2(-0.5, 0.5)) + texture2D(tVol, vUv + uTexel * vec2(0.5, 0.5));
  v *= 0.25;
  vec3 c = texture2D(tInput, vUv).rgb;
  gl_FragColor = vec4(c * v.a + v.rgb, 1.0);
}`;

export class GalaxyVolume {
  constructor(engine, P, mapRT, noise3D) {
    this.engine = engine;
    this.enabled = true;
    this.P = P;
    const q = engine.quality;
    this.scale = engine.shotMode ? 0.5 : q.pick(0.33, 0.4, 0.5, 0.6);
    this.steps = q.pick(32, 44, 60, 80);
    const mapSize = mapRT.width;
    this.march = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: MARCH_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        uMap: { value: mapRT.texture }, uNoise: { value: noise3D },
        uExtent: { value: P.extent }, uHOld: { value: P.hOld }, uHYoung: { value: P.hYoung }, uHDust: { value: P.hDust },
        uKappa: { value: 2.4 }, uMapTexel: { value: (2 * P.extent) / mapSize },
        uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() },
        uSteps: { value: this.steps }, uR: { value: P.R }, uBulgeQ: { value: P.bulgeQ }, uBulgeScale: { value: P.bulgeScale },
        uBulgeAmp: { value: P.bulgeAmp }, uEmit: { value: 1.0 }, uNearFade: { value: 0.12 }, uPixAngle: { value: 0.001 },
        uFrame: { value: 0 }, uDetail: { value: 1.0 }, uRes: { value: new THREE.Vector2() },
        uColYoung: { value: new THREE.Color(0.55, 0.72, 1.0) }, uColOld: { value: new THREE.Color(1.0, 0.8, 0.6) },
        uColHII: { value: new THREE.Color(1.0, 0.22, 0.38) }, uColBulge: { value: new THREE.Color(1.0, 0.78, 0.52) },
        uColDustGlow: { value: new THREE.Color(0.06, 0.025, 0.012) },
      },
    });
    this.comp = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: COMP_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tInput: { value: null }, tVol: { value: null }, uTexel: { value: new THREE.Vector2() } },
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
    ctx.fullscreen(this.comp, output);
  }

  dispose() { this.rt.dispose(); this.march.dispose(); this.comp.dispose(); }
}
