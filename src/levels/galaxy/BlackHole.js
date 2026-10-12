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
float gW = 1.0;   // source-plane star width factor
float gSinTh = 0.5;   // sin of the IMAGE angle from the hole (set per ray)

// analytic star layer evaluated in the BENT direction: lensed stars stay crisp points
// (arcs only where the true lens map stretches them), Einstein-ring images included.
vec3 gTdir = vec3(0.0); float gMuT = 1.0;
vec3 starLayer(vec3 dir, float scale, float dens, float pix){
  vec3 g = dir * scale;
  vec3 cell = floor(g);
  vec3 hsh = hash33(cell);
  float pick = hash13(cell + 7.0);
  if (pick < 1.0 - dens) return vec3(0.0);
  vec3 sp = (cell + 0.5 + (hsh - 0.5) * 0.7) / scale;
  // point-lens tangential magnification: a source offset o along the tangential direction
  // appears μt times larger in the image, so measure the star's distance in IMAGE space —
  // lensed stars stay crisp points instead of smeared arcs (only true multiple images remain)
  vec3 o = normalize(sp) - dir;
  float ot = dot(o, gTdir);
  vec3 orr = o - ot * gTdir;
  float ang = sqrt(ot * ot * gMuT * gMuT + dot(orr, orr));
  float w = pix * 0.75 * gW;
  float mag = pow(hash13(cell + 3.1), 6.0) * 6.0 + 0.15;
  vec3 c = blackbody(mix(3200.0, 14000.0, hsh.y * hsh.y));
  return c * mag * exp(-ang * ang / (w * w));
}
vec3 background(vec3 dir){
  vec3 cx = cross(uHoleDir, dir);
  float sinB = length(cx);
  gTdir = sinB > 1e-5 ? cx / sinB : vec3(0.0);
  gMuT = clamp(gSinTh / max(sinB, 1e-4), 0.05, 60.0);
  vec3 vd = mat3(uView) * dir;
  vec4 clip = uProj * vec4(vd, 0.0);
  vec3 sky = starLayer(dir, 140.0, 0.022, uPix) + starLayer(dir, 380.0, 0.012, uPix) * 0.45;
  // the nuclear environment: a warm bulge glow concentrated toward the galactic plane, a dense
  // nuclear star cluster and a dusty circumnuclear lane — structure for the Einstein ring to warp
  float sb = dir.y;
  float band = exp(-sb * sb / (2.0 * 0.2 * 0.2));
  vec4 en = texture(uNoise, dir * 1.4 + 0.23);
  vec4 en2 = texture(uNoise, dir * 4.5 + en.xyz * 0.3);
  float lane = 1.0 - 0.9 * exp(-pow((sb - 0.012 + (en.r - 0.5) * 0.05) / (0.03 + 0.03 * en2.g), 2.0)) * smoothstep(0.25, 0.6, en2.b + 0.2);
  lane *= 1.0 - 0.55 * smoothstep(0.55, 0.8, en2.r) * band;                                  // dark globules
  vec3 env = vec3(1.0, 0.58, 0.3) * (0.0006 + 0.012 * band * band * band + 0.003 * band) * (0.4 + 1.0 * en.g * en.g) * lane;
  env += vec3(1.0, 0.82, 0.62) * starLayer(dir, 520.0, 0.004 + 0.022 * band * band, uPix) * 0.5 * lane;
  sky += env;
  // the frame behind the hole contains the (unlensed) nucleus itself: mask it out so it is not
  // self-lensed into a hard graphic Einstein ring; its light is the broad lensed glow instead
  float toHole = acos(clamp(dot(dir, uHoleDir), -1.0, 1.0));
  // (wide, soft mask: a hard edge would itself be lensed into a ghost Einstein ring)
  float mask = smoothstep(uHoleAng * 2.0, uHoleAng * 18.0, toHole);
  mask *= mask;
  vec3 glow = uCoreCol * exp(-toHole / max(uHoleAng * 5.0, 1e-4)) * 0.04;
  if (clip.w > 1e-5) {
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    float inside = smoothstep(0.0, 0.04, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
    vec3 c = texture2D(tInput, clamp(uv, 0.001, 0.999)).rgb * mask + glow;
    return sky * uStarGain + c * uBg * mix(0.6, 1.0, inside);
  }
  return sky * uStarGain + glow * uBg;
}

// plasma texture in log-polar coordinates (u = ln r, a): anisotropy capped at ~3:1 so the
// disk reads as turbulent MRI plasma (trailing-spiral clumps, dark lanes), not combed hair
vec4 plasma(float r, float a, float z){
  float u = log(r);
  vec2 s = vec2(cos(a), sin(a));
  // large trailing-spiral clumps (angular frequency 3-8, pitch via u - a·0.25)
  float sp = a * 5.0 / TAU + u * 2.2;
  float n1 = texture(uNoise, vec3(u * 0.9 + 0.2 * s.x, sp * 0.33, 0.37 + z)).r;
  float n2 = texture(uNoise, vec3(u * 2.1 + n1 * 0.25, a / TAU * 9.0 + u * 1.2 + n1 * 0.2, 0.71 + z)).b;
  float n3 = texture(uNoise, vec3(u * 5.0 + n2 * 0.3, a / TAU * 16.0 + u * 2.0 + n2 * 0.25, 0.13 + z)).g;
  float n4 = texture(uNoise, vec3(u * 3.2 + n2 * 0.3, a / TAU * 11.0 + u * 1.6, 0.53 + z)).a;
  return vec4(n1, n2, n3, n4);
}
vec4 diskSample(vec3 hit, vec3 v){
  float r = length(hit.xz);
  // inside the ISCO the gas does not vanish: it plunges toward the horizon on near-geodesic
  // spirals, still hot but heavily redshifted, so the disk image closes onto the shadow
  if (r < 1.55 || r > uOut) return vec4(0.0);
  float plunge = r < uIn ? smoothstep(1.55, uIn, r) : 1.0;
  float ang = atan(hit.z, hit.x);
  // Keplerian flow (Ω ∝ r^-3/2, toward −θ) advected with two crossfaded phases (flow-map style):
  // the texture rotates differentially forever without the shear winding it into combed hair
  float om = 0.7 * pow(r, -1.5);
  // three crossfaded flow-map phases with mild shear (never winds into hairlines)
  float ph0 = fract(uTime * 0.3), ph1 = fract(ph0 + 1.0 / 3.0), ph2 = fract(ph0 + 2.0 / 3.0);
  vec3 wv = vec3(1.0 - abs(2.0 * ph0 - 1.0), 1.0 - abs(2.0 * ph1 - 1.0), 1.0 - abs(2.0 * ph2 - 1.0));
  wv /= wv.x + wv.y + wv.z;
  vec4 pn = plasma(r, ang + om * ph0 * 2.0, 0.0) * wv.x + plasma(r, ang + om * ph1 * 2.0, 0.33) * wv.y
          + plasma(r, ang + om * ph2 * 2.0, 0.66) * wv.z;
  // re-expand the contrast lost by averaging
  pn = clamp((pn - 0.5) * 1.35 + 0.5, 0.0, 1.0);
  float n1 = pn.x, n2 = pn.y, n3 = pn.z, n4 = pn.w;
  float x = max(r - uIn, 0.0) / (uOut - uIn);
  float bands = 0.75 + 0.25 * sin(log(r) * 11.0 + n1 * 5.0) * sin(log(r) * 4.0 + 1.3 + n2 * 2.0);
  float inner = 1.0 - smoothstep(0.0, 0.45, x);
  float dens = (0.3 + 1.1 * n1) * (0.35 + 1.2 * n2 * n2) * (0.85 + 0.3 * n3) * bands * mix(1.0, 0.35 + 1.4 * n4, inner);
  dens *= 0.4 + 1.1 * smoothstep(0.3, 0.72, n4);                  // clumps and dark gaps
  dens *= 0.35 + 0.65 * smoothstep(0.28, 0.55, n1);               // a few dark spiral lanes
  float edge = (r < uIn ? 0.55 * plunge * plunge : max(smoothstep(0.0, 0.035, x), 0.55)) * (1.0 - smoothstep(0.5, 1.0, x));
  float alpha = clamp(pow(dens, 1.6) * edge * 2.0, 0.0, 1.0);
  // temperature profile (Novikov–Thorne shape), peak normalized to 1
  float tp = pow(uIn / max(r, uIn), 0.75) * pow(max(1.0 - sqrt(uIn / max(r, uIn)), 0.0), 0.25) / 0.488;
  tp = max(tp, 0.62 * plunge * (1.0 - smoothstep(uIn, uIn * 1.35, r)));   // bridge the zero-torque edge
  // Doppler + gravitational shift: g = D·√(1−Rs/r); observed T ∝ g, observed intensity ∝ g⁴
  vec3 vdir = normalize(vec3(hit.z, 0.0, -hit.x));
  float beta = min(sqrt(0.5 / max(r - 1.0, 0.05)), 0.6);
  float gam = inversesqrt(1.0 - beta * beta);
  float cosT = dot(vdir, -normalize(v));
  float D = 1.0 / (gam * (1.0 - beta * cosT));
  float g = D * sqrt(max(1.0 - 1.0 / r, 0.0));
  g = mix(1.0, g, uDoppler);
  float T = uTmax * tp * g;
  // emissivity: Novikov–Thorne flux shape with a sharp ISCO peak; HDR so the inner edge blooms
  float em = tp * tp * (0.35 + 0.65 * tp * tp) * (1.0 + 2.2 * exp(-x * 9.0));
  vec3 bb = blackbody(T);
  bb = max(mix(vec3(dot(bb, vec3(0.2126, 0.7152, 0.0722))), bb, 1.45), 0.0);   // photographic saturation
  vec3 c = bb * pow(g, 4.0) * em * uGain * (0.5 + 0.9 * n2) * (0.88 + 0.24 * n3);
  return vec4(c * alpha, alpha);
}

// rotate v toward the hole (perpendicular component direction n) by angle a
vec3 bend(vec3 v, vec3 n, float a){ return normalize(v * cos(a) + n * sin(a)); }

vec3 trace(vec2 uv){
  vec4 cp = uProjInv * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize((uViewInv * vec4(normalize(cp.xyz / cp.w), 0.0)).xyz);
  vec3 p = uCam;
  vec3 v = rd;
  gSinTh = length(cross(rd, uHoleDir));
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
    gW = 1.0;
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
  bool captured = false, escaped = false;
  float minR = 1e9;
  bool crit = abs(sqrt(h2) - 2.598) < 0.06;   // near-critical rays: wind around the photon sphere
  for (int i = 0; i < 500; i++) {
    if (float(i) >= uSteps) break;
    float r = length(p);
    minR = min(minR, r);
    float dt = clamp((r - 0.95) * 0.08, 0.003, 1.6) * (abs(r - 1.5) < 0.3 ? (crit ? 0.12 : 0.3) : 1.0);
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
    if (length(p) > uRint * 1.02 && dot(p, v) > 0.0) { escaped = true; break; }
  }
  // a ray that neither escaped nor fell in within the step budget is winding down onto the
  // horizon from inside the photon sphere: it belongs to the shadow (pure black), never the sky
  if (!escaped && minR < 1.7) captured = true;
  gW = 1.0;
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
  // (the photon ring is not drawn analytically: it emerges from the n=1,2 disk images of rays
  //  skimming the photon sphere, resolved by the fine steps near r = 1.5 Rs / b ≈ 2.6 Rs)
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  return max(col, 0.0);
}
void main(){
  if (uSS < 1.5) { gl_FragColor = vec4(trace(vUv), 1.0); return; }
  // supersample only where the image is sharp-featured (disk, shadow edge, photon ring):
  // the weakly lensed sky beyond ~16 Rs impact parameter takes a single ray
  {
    vec4 cp = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 rd = normalize((uViewInv * vec4(normalize(cp.xyz / cp.w), 0.0)).xyz);
    float tca = -dot(uCam, rd);
    float b = length(uCam + rd * tca);
    if (b > 16.0 || tca < 0.0) { gl_FragColor = vec4(trace(vUv), 1.0); return; }
  }
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
        uSteps: { value: engine.shotMode ? 380 : q.pick(170, 240, 320, 380) },
        uIn: { value: 3.0 }, uOut: { value: 14.0 }, uBg: { value: 1 }, uDoppler: { value: 1.0 }, uGain: { value: 1.5 }, uTmax: { value: 7600 }, uRint: { value: 60.0 },
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
    this.mat.uniforms.uBg.value = 0.15 + 0.85 * THREE.MathUtils.smoothstep(d, 150, 4000);
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
