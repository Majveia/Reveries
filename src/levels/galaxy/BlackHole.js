// The central supermassive black hole: a screen-space pass that integrates
// Schwarzschild null geodesics for every pixel near the hole.
//
// Units inside the shader: Schwarzschild radius Rs = 1 (M = 1/2). For a photon the
// orbit equation u'' + u = 3Mu² is equivalent to the Newtonian-looking ODE
//      x'' = -(3/2) h² x / |x|⁵,     h = |x × x'|   (conserved)
// which we integrate with an adaptive leapfrog. Along the way:
//  * crossing the thin accretion disk (ISCO 3 Rs → 14 Rs, galactic plane) adds
//    emission: Novikov–Thorne-like temperature profile, Keplerian shear animated
//    turbulence, relativistic Doppler beaming D = 1/(γ(1−β·n)) and gravitational
//    redshift √(1−Rs/r): one side brighter and bluer, the other dim and red;
//    multiple crossings produce the over/under images and the photon ring.
//  * rays with r < Rs are captured (the shadow, ≈2.6 Rs in radius).
//  * escaping rays sample the frame in their bent direction → Einstein ring of the
//    background stars; rays never coming close get the weak-field deflection
//    α = (Rs/b)(1 + cos ψ) so the lensing fades smoothly to nothing.
// The visual Rs is exaggerated (a few pc instead of AU) so the hole is reachable.

import * as THREE from 'three';
import { FULLSCREEN_VERT, COLOR_GLSL } from '../../core/glsl/common.js';
import { HASH_GLSL } from '../../core/glsl/noise.js';

const FRAG = /* glsl */ `
precision highp float;
${COLOR_GLSL}
${HASH_GLSL}
uniform sampler2D tInput;
uniform sampler3D uNoise;
uniform mat4 uProjInv, uViewInv, uView, uProj;
uniform vec3 uCam;            // camera position in Rs units (BH at origin)
uniform float uTime, uSteps, uIn, uOut, uDoppler, uGain, uTmax, uRint;
varying vec2 vUv;
const float TAU = 6.2831853;

vec3 background(vec3 dir){
  vec3 vd = mat3(uView) * dir;
  vec4 clip = uProj * vec4(vd, 0.0);
  vec3 sky = vec3(0.0);
  // sparse procedural field for directions outside the frame (keeps the ring alive)
  vec3 g = dir * 180.0;
  vec3 cell = floor(g);
  vec3 hsh = hash33(cell);
  float d = length(fract(g) - 0.5 - (hsh - 0.5) * 0.6);
  float st = step(0.985, hash13(cell + 7.0)) * exp(-d * d * 120.0);
  sky += st * mix(vec3(1.0, 0.75, 0.5), vec3(0.7, 0.8, 1.0), hsh.x) * 0.8;
  if (clip.w > 1e-5) {
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    float inside = smoothstep(0.0, 0.04, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
    vec3 c = texture2D(tInput, clamp(uv, 0.001, 0.999)).rgb;
    return mix(sky + c * 0.6, c, inside);
  }
  return sky;
}

vec4 diskSample(vec3 hit, vec3 v){
  float r = length(hit.xz);
  if (r < uIn || r > uOut) return vec4(0.0);
  float ang = atan(hit.z, hit.x);
  // Keplerian shear: inner gas laps the outer gas (Ω ∝ r^-3/2), rotating toward −θ
  float om = 0.7 * pow(r, -1.5);
  float a = ang + om * uTime * 6.0;
  float x = (r - uIn) / (uOut - uIn);
  vec3 q = vec3(r * 0.11, a / TAU * 3.0, 0.37);
  float n1 = texture(uNoise, q).r;
  float n2 = texture(uNoise, vec3(r * 0.42, a / TAU * 7.0, 0.71) + n1 * 0.08).b;
  float n3 = texture(uNoise, vec3(r * 1.3, a / TAU * 11.0, 0.13)).g;
  float dens = (0.35 + 0.9 * n1) * (0.45 + 0.9 * n2) * (0.7 + 0.5 * n3);
  float edge = smoothstep(0.0, 0.035, x) * (1.0 - smoothstep(0.55, 1.0, x));
  float alpha = clamp(dens * edge * 1.35, 0.0, 1.0);
  // temperature profile (Novikov–Thorne shape), peak normalized to 1
  float tp = pow(uIn / r, 0.75) * pow(max(1.0 - sqrt(uIn / r), 0.0), 0.25) / 0.488;
  // Doppler + gravitational shift
  vec3 vdir = normalize(vec3(hit.z, 0.0, -hit.x));
  float beta = min(sqrt(0.5 / max(r - 1.0, 0.05)), 0.92);
  float gam = inversesqrt(1.0 - beta * beta);
  float cosT = dot(vdir, -normalize(v));
  float D = 1.0 / (gam * (1.0 - beta * cosT));
  float g = D * sqrt(max(1.0 - 1.0 / r, 0.0));
  g = mix(1.0, g, uDoppler);
  float T = uTmax * tp * g;
  vec3 c = blackbody(T) * pow(g, 4.0) * tp * tp * uGain * (0.6 + 0.8 * n2);
  return vec4(c * alpha, alpha);
}

void main(){
  vec4 cp = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize((uViewInv * vec4(normalize(cp.xyz / cp.w), 0.0)).xyz);
  vec3 p = uCam;
  vec3 v = rd;
  float r0 = length(p);
  vec3 L = cross(p, v);
  float b = length(L);
  float tca = -dot(p, v);
  vec3 col = vec3(0.0);
  float T = 1.0;
  if (r0 > uRint && (b > uRint || tca < 0.0)) {
    // weak field: deflect toward the hole
    vec3 toBH = -(p + v * tca) / max(b, 1e-4);
    float cosPsi = tca / sqrt(tca * tca + b * b);
    float alpha = (1.0 / b) * (1.0 + cosPsi);
    gl_FragColor = vec4(background(normalize(v + toBH * alpha)), 1.0);
    return;
  }
  if (r0 > uRint) p += v * (tca - sqrt(max(uRint * uRint - b * b, 0.0)));
  float h2 = dot(cross(p, v), cross(p, v));
  bool captured = false;
  for (int i = 0; i < 400; i++) {
    if (float(i) >= uSteps) break;
    float r = length(p);
    float dt = clamp((r - 0.9) * 0.11, 0.008, 1.2);
    vec3 acc = -1.5 * h2 * p / pow(r, 5.0);
    vec3 vn = v + acc * dt;
    vec3 pn = p + vn * dt;
    if (pn.y * p.y < 0.0) {
      float f = p.y / (p.y - pn.y);
      vec3 hit = mix(p, pn, f);
      vec4 d = diskSample(hit, vn);
      col += T * d.rgb;
      T *= 1.0 - d.a;
    }
    p = pn; v = vn;
    if (dot(p, p) < 1.0) { captured = true; break; }
    if (T < 0.01) break;
    if (r > uRint * 1.02 && dot(p, v) > 0.0) break;
  }
  if (!captured && T > 0.01) col += T * background(normalize(v));
  gl_FragColor = vec4(col, 1.0);
}`;

export class BlackHole {
  constructor(engine, g) {
    this.engine = engine;
    this.g = g;
    // visual Schwarzschild radius (kpc): scaled with the real mass so heavier holes are bigger
    this.rs = 1.2e-5 * Math.pow((g.blackHoleMassSun || 4e6) / 4e6, 0.25);
    this.enabled = false;
    this.position = new THREE.Vector3();
    const q = engine.quality;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tInput: { value: null }, uNoise: { value: null },
        uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() },
        uView: { value: new THREE.Matrix4() }, uProj: { value: new THREE.Matrix4() },
        uCam: { value: new THREE.Vector3() }, uTime: { value: 0 },
        uSteps: { value: engine.shotMode ? 320 : q.pick(140, 200, 280, 360) },
        uIn: { value: 3.0 }, uOut: { value: 14.0 }, uDoppler: { value: 0.8 }, uGain: { value: 9.0 }, uTmax: { value: 9500 }, uRint: { value: 40.0 },
      },
    });
  }

  setNoise(tex) { this.mat.uniforms.uNoise.value = tex; }

  update(camera, t) {
    const d = camera.position.distanceTo(this.position) / this.rs;
    this.enabled = d < 6000;
    this.mat.uniforms.uTime.value = this.engine.shotMode ? 3.0 : t;
  }

  render(renderer, input, output, ctx) {
    const u = this.mat.uniforms;
    u.tInput.value = input;
    u.uProjInv.value.copy(ctx.camera.projectionMatrixInverse);
    u.uViewInv.value.copy(ctx.camera.matrixWorld);
    u.uView.value.copy(ctx.camera.matrixWorldInverse);
    u.uProj.value.copy(ctx.camera.projectionMatrix);
    u.uCam.value.copy(ctx.cameraPosition).sub(this.position).divideScalar(this.rs);
    ctx.fullscreen(this.mat, output);
  }

  dispose() { this.mat.dispose(); }
}
