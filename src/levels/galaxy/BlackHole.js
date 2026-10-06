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
uniform float uBg, uTime, uSteps, uIn, uOut, uDoppler, uGain, uTmax, uRint, uPix, uHoleAng, uStarGain, uSS;
uniform vec3 uHoleDir, uCoreCol;
uniform vec2 uRes;
varying vec2 vUv;
const float TAU = 6.2831853;
float gW = 1.0;   // source-plane star width factor: lens compression never makes a star sub-pixel

// analytic star layer evaluated in the BENT direction: lensed stars stay crisp points
// (arcs only where the true lens map stretches them), Einstein-ring images included.
vec3 starLayer(vec3 dir, float scale, float dens, float pix){
  vec3 g = dir * scale;
  vec3 cell = floor(g);
  vec3 hsh = hash33(cell);
  float pick = hash13(cell + 7.0);
  if (pick < 1.0 - dens) return vec3(0.0);
  vec3 sp = (cell + 0.5 + (hsh - 0.5) * 0.7) / scale;
  float ang = length(normalize(sp) - dir);
  float w = pix * 0.75 * gW;
  float mag = pow(hash13(cell + 3.1), 6.0) * 6.0 + 0.15;
  vec3 c = blackbody(mix(3200.0, 14000.0, hsh.y * hsh.y));
  return c * mag * exp(-ang * ang / (w * w));
}
vec3 background(vec3 dir){
  vec3 vd = mat3(uView) * dir;
  vec4 clip = uProj * vec4(vd, 0.0);
  vec3 sky = starLayer(dir, 140.0, 0.022, uPix) + starLayer(dir, 380.0, 0.012, uPix) * 0.45;
  // the frame behind the hole contains the (unlensed) nucleus itself: mask it out so it is not
  // self-lensed into a hard graphic Einstein ring; its light is the broad lensed glow instead
  float toHole = acos(clamp(dot(dir, uHoleDir), -1.0, 1.0));
  float mask = smoothstep(uHoleAng * 2.5, uHoleAng * 9.0, toHole);
  vec3 glow = uCoreCol * exp(-toHole / max(uHoleAng * 6.0, 1e-4)) * 0.6;
  if (clip.w > 1e-5) {
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    float inside = smoothstep(0.0, 0.04, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
    vec3 c = texture2D(tInput, clamp(uv, 0.001, 0.999)).rgb * mask + glow;
    return sky * uStarGain + c * uBg * mix(0.6, 1.0, inside);
  }
  return sky * uStarGain + glow * uBg;
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
  // hot turbulent filaments on the inner edge (24-40 angular cells), sheared by the flow
  float n4 = texture(uNoise, vec3(r * 3.7 + n2 * 0.3, a / TAU * 2.0 + r * 0.05, 0.53)).b;
  float inner = 1.0 - smoothstep(0.0, 0.45, x);
  float dens = (0.35 + 0.9 * n1) * (0.45 + 0.9 * n2) * (0.7 + 0.5 * n3) * mix(1.0, 0.35 + 1.4 * n4, inner);
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
  vec3 c = blackbody(T) * pow(g, 4.0) * tp * tp * uGain * (0.6 + 0.8 * n2) * (0.7 + 0.6 * n4 * inner);
  return vec4(c * alpha, alpha);
}

// rotate v toward the hole (perpendicular component direction n) by angle a
vec3 bend(vec3 v, vec3 n, float a){ return normalize(v * cos(a) + n * sin(a)); }

vec3 trace(vec2 uv){
  vec4 cp = uProjInv * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize((uViewInv * vec4(normalize(cp.xyz / cp.w), 0.0)).xyz);
  vec3 p = uCam;
  vec3 v = rd;
  float r0 = length(p);
  float tca = -dot(p, v);
  vec3 cpt = p + v * tca;                 // closest approach of the straight line
  float b = length(cpt);
  vec3 toBH = -cpt / max(b, 1e-5);
  float sObs = -tca;                      // observer's signed position along the line
  vec3 col = vec3(0.0);
  float T = 1.0;
  // weak field (exact first-order GR deflection, integrated along the straight line):
  // alpha(s1→s2) = (Rs/b)·(s2/√(s2²+b²) − s1/√(s1²+b²))
  if (r0 > uRint && (b > uRint || tca < 0.0)) {
    float a = (1.0 / b) * (1.0 - sObs / sqrt(sObs * sObs + b * b));
    float th = atan(b, max(tca, 1e-4)), k = min(a / max(th, 1e-4), 0.98);
    gW = min(max(1.0 + k, 1.0 / max(1.0 - k, 0.02)) * 0.8, 5.0);
    return background(bend(v, toBH, a));
  }
  if (r0 > uRint) {
    // bend by the deflection accumulated before entering the integration sphere
    float sIn = -sqrt(max(uRint * uRint - b * b, 0.0));
    float a = (1.0 / b) * (sIn / uRint - sObs / sqrt(sObs * sObs + b * b));
    p = cpt + v * sIn;
    v = bend(v, toBH, a);
  }
  float h2 = dot(cross(p, v), cross(p, v));
  bool captured = false;
  float minR = 1e9;
  for (int i = 0; i < 500; i++) {
    if (float(i) >= uSteps) break;
    float r = length(p);
    minR = min(minR, r);
    float dt = clamp((r - 0.95) * 0.08, 0.003, 1.6) * (abs(r - 1.5) < 0.25 ? 0.6 : 1.0);
    vec3 vh = v - 0.75 * h2 * p / pow(r, 5.0) * dt;
    vec3 pn = p + vh * dt;
    float rn = length(pn);
    vec3 vn = vh - 0.75 * h2 * pn / pow(rn, 5.0) * dt;
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
    if (length(p) > uRint * 1.02 && dot(p, v) > 0.0) break;
  }
  gW = 2.5;
  if (!captured && T > 0.01) {
    // remaining deflection on the way out to infinity
    v = normalize(v);
    float rr = length(p);
    vec3 pn = p / rr;
    float cosE = dot(pn, v);
    vec3 perp = v * cosE - pn;
    float bb = rr * sqrt(max(1.0 - cosE * cosE, 0.0));
    if (bb > 1e-3) v = bend(v, normalize(perp - v * dot(perp, v)), (1.0 / bb) * (1.0 - cosE));
    col += T * background(v);
  }
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  return max(col, 0.0);
}
void main(){
  if (uSS < 1.5) { gl_FragColor = vec4(trace(vUv), 1.0); return; }
  // 2x2 rotated-grid supersampling (shot mode): sharp photon ring, no speckle
  vec2 px = 1.0 / uRes;
  vec3 c = trace(vUv + px * vec2(0.125, 0.375)) + trace(vUv + px * vec2(-0.375, 0.125))
         + trace(vUv + px * vec2(-0.125, -0.375)) + trace(vUv + px * vec2(0.375, -0.125));
  gl_FragColor = vec4(c * 0.25, 1.0);
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
        uSteps: { value: engine.shotMode ? 300 : q.pick(160, 220, 300, 360) },
        uIn: { value: 3.0 }, uOut: { value: 14.0 }, uBg: { value: 1 }, uDoppler: { value: 1.0 }, uGain: { value: 0.5 }, uTmax: { value: 5200 }, uRint: { value: 60.0 },
        uPix: { value: 0.001 }, uHoleAng: { value: 0.01 }, uStarGain: { value: 1 }, uSS: { value: engine.shotMode ? 4 : 1 },
        uHoleDir: { value: new THREE.Vector3(0, 0, 1) }, uCoreCol: { value: new THREE.Color(1.0, 0.72, 0.45) }, uRes: { value: new THREE.Vector2(1, 1) },
      },
    });
  }

  setNoise(tex) { this.mat.uniforms.uNoise.value = tex; }

  update(camera, t) {
    const d = camera.position.distanceTo(this.position) / this.rs;
    this.enabled = d < 6000;
    // eye adaptation to the disk: the bright nuclear sky is exposed down near the hole
    this.mat.uniforms.uBg.value = 0.035 + 0.965 * THREE.MathUtils.smoothstep(d, 150, 4000);
    this.mat.uniforms.uTime.value = this.engine.shotMode ? 3.0 : t;
    // the analytic lensed star layer only near the hole (farther out the frame already holds the stars)
    this.mat.uniforms.uStarGain.value = 0.55 * (1 - THREE.MathUtils.smoothstep(d, 250, 2500));
  }

  render(renderer, input, output, ctx) {
    const u = this.mat.uniforms;
    u.tInput.value = input;
    u.uProjInv.value.copy(ctx.camera.projectionMatrixInverse);
    u.uViewInv.value.copy(ctx.camera.matrixWorld);
    u.uView.value.copy(ctx.camera.matrixWorldInverse);
    u.uProj.value.copy(ctx.camera.projectionMatrix);
    u.uCam.value.copy(ctx.cameraPosition).sub(this.position).divideScalar(this.rs);
    const dist = Math.max(u.uCam.value.length(), 1e-6);
    u.uHoleDir.value.copy(u.uCam.value).multiplyScalar(-1 / dist);
    u.uHoleAng.value = Math.asin(Math.min(1, 2.6 / dist));
    u.uPix.value = (ctx.camera.fov * Math.PI / 180) / ctx.height;
    u.uRes.value.set(ctx.width, ctx.height);
    ctx.fullscreen(this.mat, output);
  }

  dispose() { this.mat.dispose(); }
}
