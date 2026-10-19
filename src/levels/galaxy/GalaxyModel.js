// Galaxy model: one description of a galaxy's structure shared by every renderer
// in the galaxy level (stars, diffuse volume, dust extinction, nebulae).
//
//  * params(g)          → numeric parameters derived from the universe catalog entry
//  * buildMaps()        → face-on structure maps rendered on the GPU once:
//                         R young (arm) starlight, G old disk light, B dust column, A HII emission
//                         They follow the exact log-spiral convention of Universe.galaxySample
//                         (θ_arm(r) = ln(r / 0.12R)·k + 2πi/arms), so the catalog stars and the
//                         volumetric light/dust always agree.
//  * GAL_GLSL           → shared GLSL: map lookup, vertical profiles integrated analytically
//                         over ray segments (a thin dust layer can never be stepped over),
//                         dust optical depth between two points.
//  * makeNoise3D()      → small periodic 3D fbm texture (cheap volumetric detail everywhere).

import * as THREE from 'three';
import { Random, seedFrom } from '../../core/Random.js';
import { NOISE_GLSL } from '../../core/glsl/noise.js';
import { FULLSCREEN_VERT } from '../../core/glsl/common.js';

export const TYPE_ID = { spiral: 0, barred: 1, elliptical: 2, irregular: 3, lenticular: 4, ring: 5 };

export function galaxyParams(g) {
  const R = g.radiusKpc;
  const t = TYPE_ID[g.type] ?? 0;
  const k = g.arms > 0 ? (1 / Math.tan((g.pitch * Math.PI) / 180)) * g.armWinding : 0;
  const thick = g.thicknessKpc;
  return {
    R, type: t, k, arms: g.arms, r0: R * 0.12, bar: g.bar, sf: g.starFormation, dust: g.dust,
    extent: R * 1.3,
    // vertical scale heights (kpc)
    // thin-disk scale heights capped relative to R (NGC 891: z0 ≈ 0.35 kpc at R ≈ 15 kpc), so seen
    // edge-on the disk is a tapered luminous needle and the dust a razor slit (~0.4 of the young layer)
    hOld: Math.min(Math.max(0.2, thick * 0.9), 0.026 * R), hYoung: Math.min(Math.max(0.09, thick * 0.38), 0.011 * R), hDust: Math.min(Math.max(0.08, thick * 0.3), 0.0062 * R),
    // bulge (flattened Gaussian mixture ≈ Sersic n~3 profile)
    bulgeQ: t === 2 ? 0.72 : t === 4 ? 0.6 : 0.62,
    bulgeScale: t === 2 ? R * 0.42 : R * (0.06 + g.bulge * 0.12) * (1 - 0.45 * Math.min(1, g.bar || 0)) * (t === 1 ? 0.62 : 1),
    bulgeAmp: t === 2 ? 2.2 : (0.55 + g.bulge * 1.4) * (1 - 0.3 * Math.min(1, g.bar || 0)) * (t === 1 ? 0.5 : 1),
    seed: (g.seed % 9973) * 0.137,
  };
}

// ---------------------------------------------------------------------------------
// Shared GLSL. Expects uniforms: uMap (sampler2D), uExtent, uHOld, uHYoung, uHDust,
// uKappa (dust opacity per map unit), uMapTexel (kpc per texel at lod 0).
export const GAL_GLSL = /* glsl */ `
uniform sampler2D uMap;
uniform float uExtent, uHOld, uHYoung, uHDust, uKappa, uMapTexel;
vec2 galUV(vec3 p){ return p.xz / (2.0 * uExtent) + 0.5; }
vec4 galMap(vec3 p, float lod){
  vec2 uv = galUV(p);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return max(textureLod(uMap, uv, lod), 0.0);
}
float galCum(float y, float h){ return 0.5 * tanh(clamp(y / h, -12.0, 12.0)); }
// Mean of the normalized sech² vertical profile (1/2h · sech²(y/h)) over [ya, yb].
float galSeg(float ya, float yb, float h){
  float dy = yb - ya;
  if (abs(dy) < 1e-3 * h) { float c = cosh(clamp(0.5 * (ya + yb) / h, -12.0, 12.0)); return 0.5 / (h * c * c); }
  return (galCum(yb, h) - galCum(ya, h)) / dy;
}
// Dust optical depth along the straight segment a→b. The thin dust layer is
// importance-sampled: the N map taps sit at equal steps of the cumulative sech²
// profile, i.e. exactly where the segment crosses the dust (a lane can never be
// missed). Segments running inside the layer fall back to uniform taps.
float galTau(vec3 a, vec3 b, int N, float lod){
  float L = length(b - a);
  float dy = b.y - a.y;
  float ca = galCum(a.y, uHDust), cb = galCum(b.y, uHDust);
  float tau = 0.0;
  if (abs(cb - ca) > 0.03 && abs(dy) > 1e-5) {
    for (int i = 0; i < 8; i++) {
      if (i >= N) break;
      float c = mix(ca, cb, (float(i) + 0.5) / float(N));
      float y = uHDust * atanh(clamp(2.0 * c, -0.99999, 0.99999));
      tau += galMap(mix(a, b, clamp((y - a.y) / dy, 0.0, 1.0)), lod).b;
    }
    tau *= (cb - ca) / float(N) * L / dy;
  } else {
    vec3 d = (b - a) / float(N);
    for (int i = 0; i < 8; i++) {
      if (i >= N) break;
      vec3 pa = a + d * float(i), pb = pa + d;
      tau += galMap(0.5 * (pa + pb), lod).b * galSeg(pa.y, pb.y, uHDust) * (L / float(N));
    }
  }
  return tau * uKappa;
}
`;

// ---------------------------------------------------------------------------------
const MAP_FRAG = /* glsl */ `
precision highp float;
${NOISE_GLSL}
uniform float uR, uE, uK, uR0, uArms, uBar, uSF, uDust, uType, uSeed;
uniform vec4 uNeb[8];
uniform float uNebCount;
varying vec2 vUv;
const float PI = 3.14159265, TAU = 6.2831853;

float fbm2(vec2 p, int o){ float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++){ if (i >= o) break; s += a * snoise(vec3(p, uSeed + float(i) * 7.1)); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return s; }
// Irregular emission knots: one candidate per cell with a power-law luminosity (dN/dL ~ L^-2)
// and a size that grows with it; random orientation/elongation so no two look alike.
float knots(vec2 x, float thr, float seed){
  vec2 id = floor(x), f = fract(x);
  float s = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = id + vec2(float(i), float(j));
    vec3 h = hash32(c + seed);
    if (h.z < thr) continue;
    float u = (h.z - thr) / (1.0 - thr);
    float L = 1.0 / (1.0 - 0.96 * u * u);
    float rad = 0.05 + 0.045 * pow(L, 0.55);
    vec2 d = vec2(float(i), float(j)) + 0.2 + 0.6 * h.xy - f;
    float a = hash12(c + seed + 7.3) * 6.2832;
    d = mat2(cos(a), -sin(a), sin(a), cos(a)) * d;
    d *= vec2(1.0, 1.0 + 1.4 * hash12(c + seed + 3.1));
    s += L * exp(-dot(d, d) / (rad * rad));
  }
  return s;
}
float ridge2(vec2 p, int o);
float clumpBar(vec2 p){ return smoothstep(0.5, 0.1, worley(p * 3.0 + uSeed).x); }
float ridge2(vec2 p, int o){ float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++){ if (i >= o) break; float n = 1.0 - abs(snoise(vec3(p, uSeed * 1.3 + float(i) * 3.3))); s += a * n * n; p = p * 2.1 + vec2(4.1, 2.7); a *= 0.5; } return s; }

void main(){
  vec2 p = (vUv * 2.0 - 1.0) * uE;           // galaxy plane (x, z) in kpc
  float r = length(p);
  // large-scale domain warp so arms are not geometric
  vec2 w = vec2(fbm2(p * 0.11, 3), fbm2(p * 0.11 + 31.7, 3));
  vec2 q = p + w * uR * 0.045;
  float rq = length(q), tq = atan(q.y, q.x);
  float disk = exp(-r / (0.2 * uR));
  // spiral-sheared frame: noise in this frame winds up along the arms (flocculent texture)
  float shA = -uK * log(max(rq, 0.3) / uR0) * 0.92;
  vec2 qs = mat2(cos(shA), -sin(shA), sin(shA), cos(shA)) * q;
  float flocY = max(0.0, 0.7 * fbm2(qs * vec2(0.34, 0.85) + 5.0, 5) + 0.3 * fbm2(q * 0.7 + 2.0, 4) + 0.05);
  float flocD = 0.7 * ridge2(qs * vec2(0.75, 1.9) + 9.0, 5) + 0.3 * ridge2(q * 1.3 + 4.0, 4);
  float edge = 1.0 - smoothstep(0.7 * uR, 1.2 * uR, r);
  vec4 o = vec4(0.0);

  // ---- spiral coordinates (matches Universe.galaxySample) -----------------------
  float young = 0.0, dust = 0.0, hii = 0.0, old = 0.0, sweptK = 0.0, barMask = 0.0;
  if (uArms > 0.5 && uType != 3.0 && uType != 4.0 && uType != 2.0) {
    float lr = log(max(rq, 0.3) / uR0);
    float armPh = (tq - uK * lr) * uArms / TAU;
    float armId = floor(armPh + 0.5);
    float phi = (armPh - armId) * TAU / uArms;     // angular offset from the arm ridge (rad)
    float across = phi * rq;                         // kpc across the arm
    vec2 ac = vec2(lr * 3.2, across * 0.9);          // arm-aligned coordinates
    float inner = smoothstep(0.05 * uR, 0.2 * uR, r);
    // young arm: narrow, fragmented, clumpy
    float sig = 0.25 + 0.1 * (1.0 - uSF);
    float arm = exp(-phi * phi / (2.0 * sig * sig));
    float frag = smoothstep(-0.35, 0.45, fbm2(vec2(lr * 5.0, armId * 13.0 + across * 0.3), 4));
    float clump = 0.45 + 1.1 * max(0.0, fbm2(q * 0.9, 5) + 0.25);
    // hierarchical star-forming clumps: ridged noise (power 2.5) breaks the arm into knots and spurs
    float clR = pow(ridge2(q * 1.7 + 13.0, 4), 4.0) * 4.0 + pow(ridge2(q * 5.5 + 3.0, 3), 3.0) * 1.4;
    // OB associations: light gathers into cells (Worley) strung along the arm, dark gaps between
    vec2 wy = worley(qs * vec2(1.9, 2.4) + uSeed + 0.4 * vec2(fbm2(q * 1.3, 2), fbm2(q * 1.3 + 5.0, 2)));
    vec2 wy2 = worley(q * 7.0 + uSeed * 1.7);
    float cmask = smoothstep(0.62, 0.08, wy.x) * 1.5 + smoothstep(0.42, 0.05, wy2.x) * 0.9;
    young = arm * (0.3 + 0.7 * frag) * clump * (0.12 + clR) * (0.22 + cmask) * exp(-r / (0.5 * uR)) * inner * edge * 2.6;
    young += 0.035 * disk * edge * (0.5 + 0.8 * fbm2(q * 0.6, 3));
    // secondary branches / spurs and flocculent arm fragments between the main arms
    float ph2 = (tq - uK * 1.18 * lr + 1.1) * (uArms * 2.0) / TAU;
    float phi2 = (ph2 - floor(ph2 + 0.5)) * TAU / (uArms * 2.0);
    float spur = exp(-phi2 * phi2 / (2.0 * 0.07 * 0.07)) * smoothstep(0.25 * uR, 0.5 * uR, r);
    young += (spur * 0.35 * frag + flocY * flocY * 0.45) * exp(-r / (0.38 * uR)) * inner * edge * uSF;
    // resolved OB associations: compact power-law knots strung along the arm ridges (NGC 1300 / M51)
    vec2 qo = q + 0.12 * vec2(fbm2(q * 3.0 + 1.0, 2), fbm2(q * 3.0 + 6.0, 2));
    float ob = knots(qo * 3.2, 0.55, uSeed + 23.0) * 0.6 + knots(qo * 7.5, 0.5, uSeed + 61.0) * 0.45;
    young += ob * pow(arm, 1.5) * (0.3 + 0.7 * frag) * exp(-r / (0.45 * uR)) * inner * edge * (0.5 + 0.5 * uSF);
    // inter-arm: velvet dark (arm/interarm contrast)
    young *= 0.32 + 0.68 * smoothstep(0.02, 0.5, arm + spur * 0.5);
    // dust: lane on the inner (concave) side of each arm, filamentary + feathered spurs
    float dOff = 0.17 + 0.05 * fbm2(vec2(lr * 3.0, armId * 5.0), 2);
    float dSig = 0.044 + 0.03 * max(0.0, fbm2(q * 0.5 + 3.0, 3));
    float wob = 0.035 * fbm2(vec2(lr * 7.0, armId * 9.0 + 1.0), 3);
    float lane = exp(-pow(phi - dOff - wob, 2.0) / (2.0 * dSig * dSig));
    // braided secondary strands either side of the main lane (M51 / NGC 1300 look)
    float s2 = exp(-pow(phi - dOff * 0.62 + wob * 1.7, 2.0) / (2.0 * pow(dSig * 0.45, 2.0)));
    float s3 = exp(-pow(phi - dOff * 1.45 - wob, 2.0) / (2.0 * pow(dSig * 0.6, 2.0)));
    float fil = ridge2(vec2(lr * 9.0, across * 3.5 + armId * 17.0), 5);
    float fil2 = ridge2(vec2(lr * 16.0 + 3.0, across * 6.0 + armId * 7.0), 4);
    float brk = smoothstep(-0.25, 0.35, fbm2(vec2(lr * 6.0, armId * 11.0 + 4.0), 3));   // gaps along the lane
    float fil3 = ridge2(vec2(lr * 40.0 + 7.0, across * 14.0 + armId * 5.0), 3);         // hairline filaments
    float laneD = lane * (0.06 + 3.0 * smoothstep(0.45, 0.8, fil) * (0.5 + fil)) * (0.1 + 0.9 * brk)
                + (s2 + s3 * 0.8) * smoothstep(0.35, 0.85, fil2) * 1.9 * (1.0 - 0.5 * brk)
                + exp(-pow(phi - dOff * 0.9 - wob * 2.0, 2.0) / (2.0 * pow(dSig * 2.2, 2.0))) * pow(fil3, 6.0) * 1.6;
    // feathers: thin dark streaks leaving the lane outward through the arm at a steep angle
    float sp = ridge2(vec2(lr * 22.0 + phi * 6.0, armId * 3.0 + across * 0.6), 3);
    float feather = pow(sp, 3.5) * exp(-pow(phi - dOff * 0.2, 2.0) / (2.0 * 0.4 * 0.4)) * 1.6;
    float floc = max(0.0, fbm2(q * 1.4 + 7.0, 5) + 0.15);
    dust = (laneD * 3.4 + feather * 2.2 + floc * 0.45 * arm) * exp(-r / (0.5 * uR)) * inner * edge;
    dust += 0.18 * floc * disk * edge * smoothstep(0.03 * uR, 0.12 * uR, r);   // the bulge stays smooth
    // a web of thin filaments over the whole inner disk (M101 / M51 look)
    dust += pow(flocD, 4.0) * 0.9 * exp(-r / (0.35 * uR)) * inner * edge;
    // HII knots strung along the arm, just outside the dust lane
    // multi-scale, power-law knots, clustered into star-forming complexes (no polka dots)
    vec2 qk = q + 0.25 * vec2(fbm2(q * 2.0 + 3.0, 2), fbm2(q * 2.0 + 8.0, 2));
    float knot = knots(qk * 2.4, 0.72, uSeed) * 0.5 + knots(qk * 6.5, 0.6, uSeed + 41.0) * 0.28 + knots(qk * 15.0, 0.55, uSeed + 77.0) * 0.12;
    float cplx = smoothstep(-0.15, 0.55, fbm2(q * 0.55 + 17.0, 3));
    float hiiBand = exp(-pow(phi + 0.02, 2.0) / (2.0 * 0.1 * 0.1));
    hii = knot * cplx * hiiBand * (0.4 + clump) * inner * edge * exp(-r / (0.42 * uR)) * 4.5 * uSF;
    // old disk is mildly enhanced in the arms (density wave)
    // barred galaxies: the bar sweeps the inner disk clean (NGC 1300) — off the bar and off the
    // arms the old-light floor and the diffuse dust drop away, so the inter-arm reads velvet dark
    float aB = uR * uBar * 0.56;
    float barEnv = uBar > 0.0 ? exp(-0.5 * (pow(p.x / (aB * 1.15), 4.0) + pow(p.y / (uR * 0.07), 2.0))) : 1.0;
    sweptK = uBar > 0.0 ? smoothstep(0.03 * uR, 0.09 * uR, r) * (1.0 - smoothstep(0.38 * uR, 0.6 * uR, r)) * (1.0 - barEnv) : 0.0;
    float armEnv = exp(-phi * phi / (2.0 * 0.4 * 0.4));
    old = disk * (mix(0.3, 0.07, sweptK) + 0.9 * armEnv * (1.0 - 0.45 * sweptK));
    young *= 1.0 - 0.55 * sweptK * (1.0 - arm);
    dust *= 1.0 - 0.6 * sweptK * (1.0 - armEnv);
  } else if (uType == 3.0) {
    // irregular: clumpy, offset star-forming complexes
    vec2 c = p + vec2(0.15, -0.1) * uR;
    float base = exp(-length(c * vec2(1.0, 1.4)) / (0.3 * uR));
    float cl = max(0.0, fbm2(q * 0.35, 5) + 0.15);
    young = base * cl * 2.5;
    old = base * 0.6;
    dust = base * max(0.0, fbm2(q * 0.8 + 11.0, 5)) * 1.2;
    vec2 wc = worley(q * 2.0 + vec2(uSeed));
    hii = smoothstep(0.4, 0.05, wc.x) * step(0.5, hash12(floor(q * 2.0 + vec2(uSeed)))) * cl * 4.0 * base;
  } else if (uType == 4.0) {
    // lenticular: smooth disk, a dusty inner ring, no star formation
    old = disk * 1.1;
    float ringR = 0.32 * uR;
    float rr = exp(-pow(r - ringR, 2.0) / (2.0 * pow(0.035 * uR, 2.0)));
    dust = rr * (0.4 + 1.2 * ridge2(q * 1.2, 4)) * 1.2 + 0.05 * disk;
  } else {
    old = uType == 2.0 ? 0.0 : disk;
  }
  // ring galaxies: a bright star-forming ring
  if (uType == 5.0) {
    float ringR = 0.55 * uR;
    float rr = exp(-pow(r - ringR, 2.0) / (2.0 * pow(0.05 * uR, 2.0)));
    float cl = 0.5 + max(0.0, fbm2(q * 0.8, 4) + 0.3);
    young = young * 0.35 + rr * cl * 2.0;
    dust = dust * 0.6 + exp(-pow(r - ringR * 0.92, 2.0) / (2.0 * pow(0.025 * uR, 2.0))) * ridge2(q * 1.5, 4) * 1.5;
    vec2 wc = worley(q * 3.0 + vec2(uSeed));
    hii = hii * 0.4 + rr * smoothstep(0.4, 0.05, wc.x) * 3.0;
  }
  // bar (along x, as in galaxySample) + straight dust lanes on its leading edges
  if (uBar > 0.0) {
    float a = uR * uBar * 0.56, b = uR * 0.04;
    // boxy, smooth bar with a luminance gradient toward the nucleus (NGC 1300): a flat-topped
    // super-Gaussian body plus an exponential ridge along its axis
    float bar = exp(-0.5 * (pow(p.x * p.x / (a * a), 2.4) + pow(p.y * p.y / (b * b * 0.55), 1.5)));
    float barRidge = exp(-abs(p.x) / (0.35 * a)) * exp(-0.5 * p.y * p.y / (b * b * 0.3));
    // the bar body is swept clean of mottled disk dust: only its straight leading-edge lanes remain
    barMask = exp(-0.5 * (pow(p.x / (a * 1.05), 4.0) + pow(p.y / (b * 1.8), 2.0)));
    dust *= 1.0 - 0.85 * barMask;
    // (moderate amplitude: the bar must keep its elongated shape through the tonemap, not clip to an oval)
    old += bar * 2.9 + barRidge * 2.2;
    // ansae: brightened bar ends where the bar meets the arms
    old += 1.4 * exp(-0.5 * (pow((abs(p.x) - a * 0.92) / (0.12 * a), 2.0) + p.y * p.y / (b * b * 0.8)));
    young += bar * smoothstep(0.7, 1.0, abs(p.x) / a) * 0.3 * (0.4 + clumpBar(p));   // star formation only at the bar ends
    // leading-edge bar lanes: offset, curved (S-shaped through the centre), wandering in width,
    // fragmented into filaments, swinging out into the inner arm lanes at the bar ends
    float sx = sign(p.x), ax = abs(p.x) / a;
    float lanePos = sx * (0.024 * uR + 0.03 * uR * ax * ax + 0.02 * uR * smoothstep(0.7, 1.6, ax) * ax)
                  + 0.009 * uR * fbm2(vec2(p.x * 0.9, sx * 3.0), 3);
    float lw = 0.0045 * uR * (0.6 + 1.1 * max(0.0, fbm2(vec2(p.x * 0.7, sx * 7.0 + 2.0), 3) + 0.4));
    float ln = exp(-pow(p.y + lanePos, 2.0) / (2.0 * lw * lw));
    ln += 0.5 * exp(-pow(p.y + lanePos * 1.35, 2.0) / (2.0 * pow(lw * 0.6, 2.0))) * smoothstep(0.3, 0.9, ax);  // secondary strand
    float along = smoothstep(0.035 * uR, 0.1 * uR, abs(p.x)) * smoothstep(0.045 * uR, 0.08 * uR, r) * (1.0 - smoothstep(1.3 * a, 2.3 * a, abs(p.x)));
    float bfil = ridge2(vec2(p.x * 2.5, p.y * 6.0) + 21.0, 4);
    dust += ln * along * (0.12 + 2.2 * smoothstep(0.45, 0.72, bfil)) * 6.5;
    // dust spurs feathering off the lanes across the bar
    dust += pow(ridge2(vec2(p.x * 9.0 + p.y * 3.0, p.y * 2.0), 3), 10.0) * bar * 0.7;   // hairline spurs only
    // nuclear star-forming ring / mini spiral
    float nr = exp(-pow(r - 0.035 * uR, 2.0) / (2.0 * pow(0.008 * uR, 2.0)));
    young += nr * 1.5; hii += nr * smoothstep(0.3, 0.0, worley(q * 14.0).x) * 3.0;
    dust += exp(-pow(r - 0.05 * uR, 2.0) / (2.0 * pow(0.008 * uR, 2.0))) * pow(ridge2(q * 5.0, 3), 3.0) * 0.6;   // (wispy nuclear spiral: no slash through the nucleus)
  }
  // named emission nebulae: big HII complexes carved into the map
  for (int i = 0; i < 8; i++) {
    if (float(i) >= uNebCount) break;
    vec2 d = p - uNeb[i].xy;
    float s = uNeb[i].z;
    // a giant HII complex: a cluster of irregular knots, not a smooth ball
    float gk = exp(-dot(d, d) / (2.0 * s * s));
    hii += gk * (0.25 + 1.4 * knots(p * 12.0 + float(i) * 13.7, 0.35, uSeed + 5.0) + 0.8 * knots(p * 30.0, 0.5, uSeed + 9.0)) * 1.3;
    young += exp(-dot(d, d) / (2.0 * 4.0 * s * s)) * 0.8;
  }
  // screen extinction inside the column: lanes silhouette the arm light face-on
  float dd = dust * uDust;
  young *= exp(-dd * 3.0);
  old *= exp(-dd * 0.9);
  hii *= exp(-dd * 0.8);
  // diffuse dust disk with a longer scale length than the starlight (edge-on lanes span the disk)
  if (uType != 2.0) dust += (0.45 + 0.6 * flocD * flocD * smoothstep(0.04 * uR, 0.14 * uR, r)) * exp(-r / (0.5 * uR)) * edge * (uType == 4.0 ? 0.3 : 1.0) * (1.0 - 0.7 * sweptK) * (1.0 - 0.8 * barMask);
  o = vec4(young, old, dust * uDust, hii);
  gl_FragColor = max(o, 0.0);
}`;

/** Render the face-on structure maps (RGBA half float, mipmapped). */
export function buildMaps(renderer, P, size, nebulae) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  const neb = [];
  for (let i = 0; i < 8; i++) {
    const n = nebulae[i];
    neb.push(n ? new THREE.Vector4(n.pos.x, n.pos.z, n.radius * 1.4, 0) : new THREE.Vector4());
  }
  const mat = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT, fragmentShader: MAP_FRAG, depthTest: false, depthWrite: false,
    uniforms: {
      uR: { value: P.R }, uE: { value: P.extent }, uK: { value: P.k }, uR0: { value: P.r0 }, uArms: { value: P.arms },
      uBar: { value: P.bar }, uSF: { value: P.sf }, uDust: { value: P.dust }, uType: { value: P.type }, uSeed: { value: P.seed },
      uNeb: { value: neb }, uNebCount: { value: Math.min(8, nebulae.length) },
    },
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(mesh, cam);
  renderer.setRenderTarget(prev);
  geo.dispose(); mat.dispose();
  return rt;
}

// ---------------------------------------------------------------------------------
/** Periodic 3D noise texture (RGBA8), tiling gradient (Perlin) noise:
 *  R, G = independent fbm, B = ridged multifractal (crisp creases → filaments, eroded edges),
 *  A = cellular (inverted Worley F1, knobs/globules). Each channel is moment-matched to fixed
 *  statistics (mean/std) so every shader's thresholds stay calibrated regardless of size. */
export function makeNoise3D(size = 64, seed = 1) {
  const N = size, data = new Uint8Array(N * N * N * 4);
  const rng = new Random(seedFrom(seed, 'noise3d'));
  const G = [[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],[1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],[0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]];
  const octs = N >= 96 ? [4, 8, 16, 32, 48] : [4, 8, 16, 32];
  const grads = (p) => { const a = new Uint8Array(p * p * p); for (let i = 0; i < a.length; i++) a[i] = Math.floor(rng.float() * 12) % 12; return a; };
  const layers = [0, 1, 2].map(() => octs.map((p) => ({ p, g: grads(p) })));
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const perlin = (L, x, y, z) => {
    const p = L.p, fx = x * p, fy = y * p, fz = z * p;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const dx = fx - ix, dy = fy - iy, dz = fz - iz;
    const u = fade(dx), v = fade(dy), w = fade(dz);
    let r = 0;
    for (let k = 0; k < 8; k++) {
      const ox = k & 1, oy = (k >> 1) & 1, oz = (k >> 2) & 1;
      const gi = L.g[(((ix + ox) % p) * p + ((iy + oy) % p)) * p + ((iz + oz) % p)];
      const gv = G[gi];
      const d = gv[0] * (dx - ox) + gv[1] * (dy - oy) + gv[2] * (dz - oz);
      r += d * (ox ? u : 1 - u) * (oy ? v : 1 - v) * (oz ? w : 1 - w);
    }
    return r;   // ≈ [-1, 1]
  };
  // tiled Worley feature points
  const wp = [6, 13].map((p) => { const a = new Float32Array(p * p * p * 3); for (let i = 0; i < a.length; i++) a[i] = rng.float(); return { p, a }; });
  const worley = (W, x, y, z) => {
    const p = W.p, fx = x * p, fy = y * p, fz = z * p;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    let best = 9;
    for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cy = iy + j, cz = iz + k;
      const o = ((((cx % p) + p) % p * p + (((cy % p) + p) % p)) * p + (((cz % p) + p) % p)) * 3;
      const ddx = cx + W.a[o] - fx, ddy = cy + W.a[o + 1] - fy, ddz = cz + W.a[o + 2] - fz;
      const d = ddx * ddx + ddy * ddy + ddz * ddz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };
  const raw = [new Float32Array(N * N * N), new Float32Array(N * N * N), new Float32Array(N * N * N), new Float32Array(N * N * N)];
  let o = 0;
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++, o++) {
    const u = x / N, v = y / N, w = z / N;
    for (let c = 0; c < 2; c++) {
      let s = 0, amp = 1;
      for (const L of layers[c]) { s += perlin(L, u, v, w) * amp; amp *= 0.5; }
      raw[c][o] = s;
    }
    // ridged multifractal: each octave's crease weighted by the previous one (sharp filaments)
    let s = 0, amp = 1, wt = 1;
    for (const L of layers[2]) { let n = 1 - Math.abs(perlin(L, u, v, w) * 1.6); n = Math.max(0, n); n *= n; s += n * amp * wt; wt = Math.min(1, n * 1.6); amp *= 0.5; }
    raw[2][o] = s;
    raw[3][o] = (1 - worley(wp[0], u, v, w)) * 0.65 + (1 - worley(wp[1], u, v, w)) * 0.35;
  }
  const target = [[0.511, 0.11], [0.488, 0.13], [0.694, 0.14], [0.278, 0.121]];
  const M = N * N * N;
  for (let c = 0; c < 4; c++) {
    const a = raw[c];
    let m = 0, m2 = 0;
    for (let i = 0; i < M; i++) { m += a[i]; m2 += a[i] * a[i]; }
    m /= M; const sd = Math.sqrt(Math.max(1e-9, m2 / M - m * m));
    const k = target[c][1] / sd, b0 = target[c][0];
    for (let i = 0; i < M; i++) data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(((a[i] - m) * k + b0) * 255)));
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat; tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1; tex.needsUpdate = true;
  return tex;
}

/** Nebula placements: big HII complexes on the arms (deterministic). */
export function placeNebulae(U, g, count) {
  const rng = new Random(seedFrom(g.seed, 'nebulae'));
  const P = galaxyParams(g);
  const out = [];
  const kinds = ['pillars', 'cliffs', 'shell', 'pillars', 'veil', 'cliffs', 'shell', 'veil'];
  for (let i = 0; i < count; i++) {
    let x, z;
    if (g.arms > 0) {
      const r = P.R * rng.range(0.22, 0.62);
      const armIdx = rng.int(0, g.arms - 1);
      const th = Math.log(Math.max(r, 0.3) / P.r0) * P.k + (armIdx * 2 * Math.PI) / g.arms - 0.02;
      x = Math.cos(th) * r; z = Math.sin(th) * r;
    } else {
      const r = P.R * rng.range(0.1, 0.5), th = rng.range(0, Math.PI * 2);
      x = Math.cos(th) * r; z = Math.sin(th) * r;
    }
    out.push({
      index: i, kind: kinds[i % kinds.length],
      pos: new THREE.Vector3(x, rng.gaussian(0, 0.02), z),
      radius: rng.range(0.07, 0.13) * (i === 0 ? 1.25 : 1),
      seed: rng.range(0, 100),
      rot: rng.range(0, Math.PI * 2),
      name: `${['NGC', 'IC', 'Sh2', 'RCW'][i % 4]} ${rng.int(100, 7999)}`,
    });
  }
  return out;
}
