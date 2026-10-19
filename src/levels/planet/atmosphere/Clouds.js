// Clouds — volumetric, ray-marched cloud layer on a spherical shell.
//
// Nubis / Horizon-Zero-Dawn style: Perlin-Worley shape noise eroded by Worley
// detail, a planet-wide weather map (coverage, type, wetness), height
// profiles per cloud type, Beer–Lambert + powder, dual-lobe HG phase with a
// silver lining, Wrenninge multiple-scattering octaves, ambient from the
// physically-derived sky/ground radiance, and the key light coloured by the
// atmosphere's transmittance LUT at every sample — so cumulus towers glow
// gold and crimson at sunset and stay lit after the ground has gone dark.
//
// Rendered at reduced resolution (quality-scaled), with aerial perspective
// applied to the clouds themselves, then upsampled with depth-aware weights
// and composited over the atmosphere-lit scene. From orbit the same shader
// runs a cheaper shape-only march (the "projected layer").
//
// The render pass is driven by Atmosphere.js (effects order: air → clouds →
// weather). Clouds also provide their GLSL to the atmosphere for cloud
// shadows on the ground and crepuscular shafts in the air.

import * as THREE from 'three';
import { AtmosphereModel, ATMO_PARS, ATMO_FUNCS } from './AtmosphereModel.js';
import { CloudResources, CLOUD_UNIFORMS_GLSL, CLOUD_FUNCS_GLSL } from './CloudShared.js';
import { DEPTH_GLSL, COLOR_GLSL, FULLSCREEN_VERT } from '../../../core/glsl/common.js';
import { Random, seedFrom } from '../../../core/Random.js';

const MARCH_FRAG = /* glsl */ `
${ATMO_PARS}
${ATMO_FUNCS}
${CLOUD_UNIFORMS_GLSL}
${CLOUD_FUNCS_GLSL}
${DEPTH_GLSL}
${COLOR_GLSL}
uniform sampler2D tDepth;
uniform vec2 uFullRes;
uniform float uNear, uFar, uRev;
uniform mat4 uProjInv, uViewInv;
uniform vec3 uCam;
uniform vec3 uKeyDir, uKeyE;   // key light direction and TOA illuminance
uniform vec3 uKey2Dir, uKey2E; // second key (moon at night; 0 by day), cheap light march
uniform vec3 uNightAmb;        // starlight + airglow floor (radiance): unlit clouds read blue-grey, never holes
uniform vec3 uFogGlowC;       // bioluminescent mist (the atmosphere's uFogGlow): it scatters in front of / under the clouds too
uniform vec3 uCityGlow;       // settlement / bioluminescent glow lighting cloud bases from below (radiance)
uniform vec3 uCloudAlbedo;
uniform float uSteps, uLightSteps, uMaxDist, uFrame, uOrbitLod;
uniform sampler2D tHistory;
uniform mat4 uPrevViewProj;
uniform float uHistoryBlend;
uniform float uCurveK;         // 0..1: compress the tiny planet's curvature for cloud lighting (night stays night)
varying vec2 vUv;

float hg(float c, float g){ float g2 = g * g; return 0.0795775 * (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5); }

// Physically-derived ambient at a point of the cloud layer: sky irradiance from
// the LUT for the sun and the moon at *this* position on the planet (so the
// night hemisphere goes black and dusk clouds turn rose and amber).
vec3 cloudSkyAmb(vec3 up, float r){
  return uSunE * atmoSkyIrr(r, dot(up, uSunDir)) + uMoonE * atmoSkyIrr(r, dot(up, uMoonDir));
}

// Orbit: a cheap "projected" layer instead of the full march, but integrated through
// three slices of the shell (base / middle / top) so the deck has thickness: margins
// fray and thin out, dense cores build up, and the slices parallax at grazing angles.
// Lit with a sunward self-shadow (anti-sun flanks darken, sun-facing edges glow),
// soft Beer-Lambert opacity (no binary decal edges) and the sky-dome ambient.
float cProf2D(float h, float c){
  // denser cores reach higher: the top slice only exists where the deck is thick
  return smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.25 + 0.7 * c, 0.3 + 0.75 * c, h));
}
vec4 projectedLayer(vec3 ro, vec3 rd, float sceneDist, out float dOut){
  dOut = -1.0;
  float shellH = uCloudTop - uCloudBase;
  float Rm = uCloudBase + shellH * 0.45;
  vec2 tm = raySphere(ro, rd, Rm);
  if (tm.y <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  float t = tm.x > 0.0 ? tm.x : tm.y;
  if (t > sceneDist + 1500.0) return vec4(0.0, 0.0, 0.0, 1.0);
  vec3 P = ro + rd * t;
  float r = length(P);
  vec3 n = P / r;
  vec3 wx = cloudWeather(P);
  if (wx.r < 0.015) { dOut = t; return vec4(0.0, 0.0, 0.0, 1.0); }
  float mu = max(abs(dot(rd, n)), 0.06);
  // three slices through the shell, each with its own height profile
  float tauSum = 0.0; float cMid = 0.0; float hW = 0.0;
  for (int k = 0; k < 5; k++) {
    float h = 0.1 + 0.2 * float(k);
    float Rk = uCloudBase + shellH * h;
    vec2 tk = raySphere(ro, rd, Rk);
    float ts = tk.x > 0.0 ? tk.x : tk.y;
    if (ts <= 0.0 || ts > sceneDist + 1500.0) continue;
    vec3 Pk = ro + rd * ts;
    float ck = cloudLayer2D(Pk, wx);
    if (k == 2) cMid = ck;
    float dk = ck * cProf2D(h, ck) * 0.6;
    tauSum += dk; hW += dk * h;
  }
  if (tauSum <= 0.002) { dOut = t; return vec4(0.0, 0.0, 0.0, 1.0); }
  float hMean = hW / tauSum;
  // optical depth: linear in density × slice thickness, path-lengthened toward the limb
  float tau = tauSum * (1.2 + 1.5 * wx.g) * (0.7 + 0.6 * wx.b) / mu;
  // soft Beer-Lambert opacity: margins fade over kilometres instead of a decal cut
  float alpha = (1.0 - exp(-tau * 0.42)) * smoothstep(0.0, 0.18, abs(dot(rd, n)));
  // sunward self-shadow: sample the deck a little toward the light along the surface
  vec3 kT = uKeyDir - n * dot(uKeyDir, n);
  float kl = length(kT);
  vec3 Ps = kl > 1e-3 ? normalize(P + kT / kl * 900.0) * Rm : P;
  float cs = cloudLayer2D(Ps, cloudWeather(Ps));
  float occl = max(cs - cMid, 0.0);             // anti-sun flank: the cloud body sits between it and the sun
  float muS = dot(n, uKeyDir);
  float selfSh = exp(-occl * 3.2 / max(muS * 2.0 + 0.25, 0.25) - cs * 0.35);
  // tops (high mean slice) catch more light than the thin low margins
  float topK = 0.75 + 0.5 * hMean;
  vec3 Tl = transmittanceToLight(r + shellH * 0.4, muS);
  float cosV = dot(rd, uKeyDir);
  float thick = 1.0 - exp(-tau * 0.5);
  float dayK = smoothstep(-0.12, 0.2, muS);
  // thick decks: bright multiple-scattering reflectance (sun-facing tops near-white);
  // thin veils: forward lobe (silver margins toward the sun)
  float refl = max(muS, 0.0) * 0.5 * thick * selfSh * topK + 0.04 * dayK * thick;
  float fwd = hg(cosV, 0.65) * 0.5 * (1.0 - thick) * dayK;
  vec3 Ld = uKeyE * Tl * (refl + fwd);
  // ambient: zenith sky + a cool skylight floor in the self-shadowed flanks
  vec3 Sa = (cloudSkyAmb(n, r) + uNightAmb) * PI * (0.32 + 0.22 * hMean) * (0.7 + 0.3 * selfSh);
  vec3 col = (Ld + Sa) * uCloudAlbedo * (1.0 - 0.3 * wx.b);
  vec2 ta = raySphere(ro, rd, uRt);
  float a0 = max(ta.x, 0.0);
  vec3 Lair, Tair;
  atmoIntegrate(ro, rd, a0, max(t, a0 + 1.0), 6, 0, Lair, Tair);
  dOut = t;
  return vec4((col * Tair + Lair) * alpha, 1.0 - alpha);
}

vec4 marchClouds(out float dOut, out vec3 rdOut){
  dOut = -1.0;
  float depth = texture2D(tDepth, vUv).r;
  bool far = isFarDepth(depth, uRev);
  vec3 vp = viewPosFromDepth(vUv, far ? 0.5 : depth, uProjInv, uRev);
  vec3 rd = normalize(mat3(uViewInv) * vp); // rotation only: world-space subtraction at planet scale quantizes rd into blocks
  rdOut = rd;
  float sceneDist = far ? 1e12 : length(viewPosFromDepth(vUv, depth, uProjInv, uRev));
  vec3 ro = uCam;
  float r0 = length(ro);
  // shell intersection
  vec2 tTop = raySphere(ro, rd, uCloudTop);
  vec2 tBot = raySphere(ro, rd, uCloudBase);
  vec2 tGnd = raySphere(ro, rd, uRb - 200.0);
  float t0, t1;
  if (tTop.y <= 0.0) { return vec4(0.0, 0.0, 0.0, 1.0); }
  if (r0 < uCloudBase) { t0 = tBot.y; t1 = tTop.y; if (tGnd.x > 0.0) { return vec4(0.0, 0.0, 0.0, 1.0); } }
  else if (r0 < uCloudTop) { t0 = 0.0; t1 = tBot.x > 0.0 ? tBot.x : tTop.y; }
  else { t0 = tTop.x; t1 = tBot.x > 0.0 ? tBot.x : tTop.y; }
  t0 = max(t0, 0.0);
  if (uOrbitLod > 0.5) return projectedLayer(ro, rd, sceneDist, dOut);
  t1 = min(t1, min(sceneDist, uMaxDist));
  if (t1 <= t0) { return vec4(0.0, 0.0, 0.0, 1.0); }

#ifdef CLOUD_DEBUG_WEATHER
  { vec3 wq = cloudWeather(ro + rd * max(t0, 1.0)); dOut = -1.0; return vec4(wq.r * 0.5, wq.g * 0.5, wq.b * 0.5, 0.0); }
#endif
  float seg = t1 - t0;
  float N = clamp(seg / 70.0, 16.0, uSteps);
  // from orbit, fade the layer toward the limb so grazing rays don't pile up into a grey rim
  float graze = 1.0;
  if (r0 > uCloudTop) { vec3 Pe = ro + rd * t0; graze = smoothstep(0.02, 0.25, -dot(rd, normalize(Pe))); }
  float dt = seg / N;
  // per-pixel white-noise start offset, re-seeded each frame (an interleaved-gradient
  // pattern left diagonal moire stripes whenever the accumulation was short)
  float jit = fract(sin(dot(gl_FragCoord.xy + uFrame * vec2(37.31, 17.77), vec2(12.9898, 78.233))) * 43758.5453);
  float cosK = dot(rd, uKeyDir);
  float phase = mix(hg(cosK, 0.8), hg(cosK, -0.3), 0.3);
  vec3 camUp = normalize(ro);
  float silverPh = hg(cosK, 0.93);
  float cosK2 = dot(rd, uKey2Dir);
  float phase2 = mix(hg(cosK2, 0.8), hg(cosK2, -0.3), 0.3);
  bool key2 = uKey2E.r + uKey2E.g + uKey2E.b > 0.0;
  float sigma = uCloudDensity;
  vec3 L = vec3(0.0);
  float T = 1.0;
  float wsum = 0.0, dsum = 0.0;
  float shellH = uCloudTop - uCloudBase;
  float lod0 = uOrbitLod;
  int iN = int(N);
  for (int i = 0; i < 160; i++) {
    if (i >= iN) break;
    float t = t0 + (float(i) + jit) * dt;
    vec3 P = ro + rd * t;
    vec3 wx = cloudWeather(P);
    if (wx.r < 0.02) continue;
    float lod = max(lod0, step(30000.0 + 6000.0 * jit, t)); // dithered LOD edge: no visible seam
    // near-field fade: flying through the deck shows soft wisps, not a smeared wall
    float d = cloudDensityW(P, wx, lod) * graze * smoothstep(40.0, 480.0, t);
    if (d <= 0.002) continue;
    float r = length(P);
    vec3 up = P / r;
    // lighting frame: on a 20–70 km world a cloud 40 km away sits a third of the way to the
    // terminator; pull its "up" toward the camera's so night clouds stay night
    vec3 upL = normalize(mix(up, camUp, uCurveK));
    float h01 = clamp((r - uCloudBase) / shellH, 0.0, 1.0);
    float hl = clamp(h01 / max(cloudTopH(wx), 0.05), 0.0, 1.0);
    // light march toward the key light
    float od = 0.0;
    float ls = shellH * 0.05;
    float lt = 0.0;
    for (int j = 0; j < 6; j++) {
      if (float(j) >= uLightSteps) break;
      float len = ls * pow(2.0, float(j));
      lt += len;
      vec3 Pl = P + uKeyDir * (lt - 0.5 * len);
      od += cloudDensity(Pl, j < 2 ? lod : 1.0) * len;
    }
    od *= sigma;
    // atmospheric transmittance of the key light at this sample (sunset colour, planet shadow)
    vec3 Tl = transmittanceToLight(r, dot(upL, uKeyDir));
    float ext = d * sigma;
    // multiple-scattering octaves (Wrenninge)
    // (4 octaves: deep interiors keep a soft multiply-scattered glow instead of going flat)
    float ms = 0.0, a = 1.0, b = 1.0, c = 1.0;
    for (int o = 0; o < 4; o++) {
      ms += a * exp(-od * b) * mix(phase, 0.0795775, 1.0 - c);
      a *= 0.55; b *= 0.32; c *= 0.5;
    }
    // diffusion floor: light that random-walks around a shadowing tower (sides of a cumulus in
    // the shadow of its neighbour read blue-grey, never as charcoal holes)
    // (small: it is coloured by the key's transmittance, so at golden hour a large floor
    // turned every shadowed flank brown/maroon; the cool sky ambient carries those instead)
    ms += 0.014 / (1.0 + 0.08 * od);
    // silver lining: the thin, least-shadowed margins light up when looking toward the sun
    ms += (0.14 + 0.3 * smoothstep(0.55, 0.92, cosK)) * silverPh * exp(-od * 0.7) * (1.0 - smoothstep(0.0, 0.3, d));
    float powder = 1.0 - exp(-ext * 380.0);
    powder = mix(1.0, powder, 0.3 + 0.45 * smoothstep(-0.2, 0.6, -cosK));
    // Schneider in-scatter probability: thin outer wisps and the flat bases scatter less light
    // toward the eye than the dense, high interior → dark crevices between bright billows
    float depthP = 0.06 + pow(clamp(d * 0.85, 0.0, 1.0), mix(0.5, 1.6, hl));
    float vertP = pow(clamp(cRemap(hl, 0.04, 0.22, 0.25, 1.0), 0.25, 1.0), 0.8);
    // (not when backlit: there the thin margins must glow — the silver lining)
    float inP = mix(1.0, clamp(depthP, 0.0, 1.0) * vertP, 0.55 * smoothstep(0.75, 0.1, cosK));
    vec3 Sk = uKeyE * Tl * ms * powder * inP * 3.14159;
    if (key2) {
      // moon: a geometric (×3) cone march like the sun's — first tap at full detail, the
      // rest shape-only — and the same Wrenninge octaves. The old 3-tap estimate summed
      // ~0.9 shell heights of optical depth, so every dense core went to exp(-200) = black
      // paper with holes; a cumulus under a full moon is a soft grey-blue body instead.
      float od2 = 0.0, lt2 = 0.0;
      for (int j = 0; j < 3; j++) {
        float len2 = shellH * 0.05 * pow(3.0, float(j));
        lt2 += len2;
        od2 += cloudDensity(P + uKey2Dir * (lt2 - 0.5 * len2), j == 0 ? lod : 1.0) * len2;
      }
      od2 *= sigma;
      float ms2 = 0.0, a2 = 1.0, b2 = 1.0, c2 = 1.0;
      for (int o = 0; o < 4; o++) {
        ms2 += a2 * exp(-od2 * b2) * mix(phase2, 0.0795775, 1.0 - c2);
        a2 *= 0.55; b2 *= 0.3; c2 *= 0.5;
      }
      // diffusion floor: moonlight random-walking through the body → cores stay grey-blue
      ms2 += 0.012 + 0.045 / (1.0 + 0.03 * od2);
      // gentle powder only (no charcoal interiors at night)
      ms2 *= mix(1.0, 1.0 - exp(-ext * 380.0), 0.15 * smoothstep(-0.2, 0.6, -cosK2));
      // moonlit silver rims on the thin margins (forward lobe around the moon)
      ms2 += (0.25 + 0.6 * smoothstep(0.6, 0.97, cosK2)) * hg(cosK2, 0.9) * exp(-od2 * 0.7) * (1.0 - smoothstep(0.0, 0.32, d));
      vec3 Tm2 = transmittanceToLight(r, dot(upL, uKey2Dir));
      Sk += uKey2E * Tm2 * ms2 * 3.14159;
      // moonlit sky dome (the sky-scattering moon is deliberately dim; the deck sees the real one)
      Sk += uKey2E * Tm2 * (0.018 + 0.02 * sqrt(hl)) * 3.14159;
    }
    // ambient: sky from above, bounce from below, self-occluded toward the bottom/inside
    // vertical gradient within each cloud (relative to its own top): luminous tops,
    // blue-grey (never charcoal) bases lit by the ground bounce
    float ambOcc = exp(-d * 1.4);
    vec3 skyA = cloudSkyAmb(upL, r);
    float muSun = dot(upL, uSunDir);
    vec3 gndA = uGroundAlbedo * (uSunE * transmittanceToLight(uRb + 2.0, muSun) * max(muSun, 0.0) / PI + skyA);
    // ground bounce reaches the bases desaturated (a green/ochre world must not tint the deck)
    gndA = mix(vec3(dot(gndA, vec3(0.3333))), gndA, 0.35) + uCityGlow + uFogGlowC * 1.6;
    // tops see the whole (blue) sky dome, bases a cool blue-grey mix of sky and a little bounce
    vec3 Sa = (skyA * (0.5 + 0.7 * sqrt(hl)) + gndA * 0.35 * (1.0 - hl)) * (0.7 + 0.3 * ambOcc) * PI * 0.36
      + skyA * PI * 0.05
      // starlight/airglow floor graded by height: dark bases (0.2x), faintly lit domes (1x)
      + uNightAmb * PI * 0.36 * mix(0.2, 1.0, sqrt(hl)) * (0.55 + 0.45 * ambOcc); // sky-coloured multiple-scattering floor: thick bases read blue-grey, never navy holes
    vec3 S = (Sk + Sa) * uCloudAlbedo * (1.0 - 0.45 * wx.b);
    float st = exp(-ext * dt);
    float Tprev = T;
    L += T * S * (1.0 - st);
    T *= st;
    dsum += t * (Tprev - T); wsum += Tprev - T;
    if (T < 0.008) break;
  }
  float alpha = 1.0 - T;
  float dW = dsum / max(wsum, 1e-5);
  if (alpha < 0.002) { dOut = dW > 0.0 ? dW : -1.0; return vec4(0.0, 0.0, 0.0, 1.0); }
  // aerial perspective between camera and the cloud
  vec2 ta = raySphere(ro, rd, uRt);
  float a0 = max(ta.x, 0.0);
  vec3 Lair, Tair;
  atmoIntegrate(ro, rd, a0, max(dW, a0 + 1.0), 8, 0, Lair, Tair);
  vec3 col = L * Tair + Lair * alpha;
  // glowing mist between the camera and a low deck (no black cut-outs in a bioluminescent night)
  // (same shallow-layer path as the atmosphere's glowing mist, so a deck matches the sky behind it)
  if (uFogGlowC.r + uFogGlowC.g + uFogGlowC.b > 0.0) {
    float tE = min(dW, 7000.0);
    float hRel = max(0.5 * (length(ro) + length(ro + rd * tE)) - uRb - uFog.z - 40.0, 0.0);
    col += uFogGlowC * (1.0 - exp(-tE / 1700.0 * exp(-hRel / 80.0))) * alpha;
  }
  dOut = dW;
  return vec4(col, T);
}
void main(){
  float dW; vec3 rd;
  vec4 cur = marchClouds(dW, rd);
  if (uHistoryBlend > 0.0) {
    vec3 P = uCam + rd * (dW > 0.0 ? dW : 15000.0);
    vec4 pc = uPrevViewProj * vec4(P, 1.0);
    vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
    if (pc.w > 0.0 && all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) {
      vec4 h = texture2D(tHistory, puv);
      float diff = abs(h.a - cur.a);
      float k = uHistoryBlend * (1.0 - smoothstep(0.15, 0.5, diff));
      cur = mix(cur, h, k);
    }
  }
  gl_FragColor = cur;
}`;

const COMPOSITE_FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform sampler2D tInput, tCloud, tDepth;
uniform vec2 uLowRes;
uniform float uNear, uFar, uRev;
varying vec2 vUv;
float linDepth(vec2 uv){
  float d = texture2D(tDepth, uv).r;
  if (isFarDepth(d, uRev)) return 1e9;
  return -depthToViewZ(d, uNear, uFar, uRev);
}
void main(){
  vec3 col = texture2D(tInput, vUv).rgb;
  float dc = linDepth(vUv);
  vec2 p = vUv * uLowRes - 0.5;
  vec2 i0 = floor(p);
  vec2 f = p - i0;
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int y = -1; y <= 2; y++) for (int x = -1; x <= 2; x++) {
    vec2 tc = (i0 + vec2(float(x), float(y)) + 0.5) / uLowRes;
    vec2 dd = vec2(float(x), float(y)) - f;
    float wb = exp(-dot(dd, dd) * 1.7);
    float dl = linDepth(tc);
    float rel = abs(dl - dc) / max(min(dl, dc), 1.0);
    float wd = 1.0 / (1e-3 + rel * 40.0);
    wd = min(wd, 1000.0);
    float w = wb * wd;
    acc += texture2D(tCloud, tc) * w;
    wsum += w;
  }
  vec4 c = acc / max(wsum, 1e-6);
  // depth edges: nearest-depth upsample (pick the low-res texel whose depth matches best)
  float best = 1e9; vec4 cb = c; float spread = 0.0;
  for (int y = 0; y <= 1; y++) for (int x = 0; x <= 1; x++) {
    vec2 tc = (i0 + vec2(float(x), float(y)) + 0.5) / uLowRes;
    float dl = linDepth(tc);
    float rel = abs(dl - dc) / max(min(dl, dc), 1.0);
    spread = max(spread, rel);
    if (rel < best) { best = rel; cb = texture2D(tCloud, tc); }
  }
  c = mix(c, cb, smoothstep(0.05, 0.25, spread));
  gl_FragColor = vec4(col * c.a + c.rgb, 1.0);
}`;

// Weather presets → cloud field.
export const CLOUD_PRESETS = {
  clear: { coverage: 0.34, type: 0.35, wet: 0.0, bands: 0.5, density: 0.06 },
  cumulus: { coverage: 0.5, type: 0.8, wet: 0.05, bands: 0.6, density: 0.085 },
  rain: { coverage: 0.72, type: 0.75, wet: 0.7, bands: 0.5, density: 0.08 },
  storm: { coverage: 0.8, type: 0.95, wet: 0.9, bands: 0.4, density: 0.07 },
  fog: { coverage: 0.38, type: 0.3, wet: 0.15, bands: 0.4, density: 0.04 },
  snow: { coverage: 0.66, type: 0.3, wet: 0.5, bands: 0.5, density: 0.05 },
  dust: { coverage: 0.18, type: 0.2, wet: 0.0, bands: 0.3, density: 0.03 },
  ash: { coverage: 0.7, type: 0.55, wet: 0.3, bands: 0.2, density: 0.06 },
  spores: { coverage: 0.4, type: 0.4, wet: 0.1, bands: 0.5, density: 0.04 },
  aurora: { coverage: 0.25, type: 0.3, wet: 0.0, bands: 0.5, density: 0.04 },
};

export default class Clouds {
  static order = 85;
  constructor(level) {
    this.level = level;
    this.engine = level.engine;
    this.world = level.world;
    this.model = AtmosphereModel.get(level);
    this.res = new CloudResources(level);
    this.ready = false;
    this.enabled = !!this.model.present;
    level.clouds = this;
    const T = this.model.thickness;
    // Shell ≈ 1.5–4 km on Earth-like worlds, scaled into thin atmospheres.
    this.baseH = Math.min(1500, T * 0.3);
    this.topH = Math.min(4200, T * 0.82);
    const relief = this.world.terrainParams?.relief || 1500;
    if (this.baseH < relief * 0.55) { this.baseH = Math.min(relief * 0.6, T * 0.42); this.topH = Math.max(this.topH, this.baseH + 1800); }
    this.topH = Math.min(this.topH, T * 0.95);
    this.preset = { ...CLOUD_PRESETS.cumulus };
    this.covTarget = 1;
    this._frame = 0;
    this.seed = new Random(seedFrom(level.planet.seed, 'clouds')).range(0, 100);
  }

  async init() {
    if (!this.enabled) return;
    await this.model.init();
    const t0 = performance.now();
    this.res.init();
    this.res.bakeWeather({ seed: this.seed, ...this.preset });
    if (this.engine.debug) { this.engine.renderer.getContext().finish(); console.warn('[clouds] bake ms', Math.round(performance.now() - t0)); }
    const m = this.model, r = this.res;
    this.uniforms = {
      ...m.uniforms,
      tCloudShape: { value: r.shapeRT.texture }, tCloudDetail: { value: r.detailRT.texture }, tCloudWeather: { value: r.weatherRT.texture },
      uCloudRot: { value: new THREE.Matrix3() },
      uCloudBase: { value: m.Rb + this.baseH }, uCloudTop: { value: m.Rb + this.topH },
      uCloudCov: { value: 1 }, uCloudDensity: { value: this.preset.density },
      uCloudWind: { value: new THREE.Vector3() },
      uCloudShapeScale: { value: 1 / 5600 }, uCloudDetailScale: { value: 1 / 1150 },
      uCloudWeatherSize: { value: r.weatherSize }, uCloudFlat: { value: 0 },
      uCloud3DInfo: { value: new THREE.Vector3(r.shapeSize, r.detailSize, r.manual3D ? 1 : 0) },
    };
    // A separate uniform object for the march (shares the cloud + atmosphere values by reference).
    this.marchMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: MARCH_FRAG, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: {
        ...this.uniforms,
        tDepth: { value: null }, uFullRes: { value: new THREE.Vector2() }, uNear: { value: 0.1 }, uFar: { value: 1e7 }, uRev: { value: 1 },
        uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() },
        uKeyDir: { value: new THREE.Vector3(0, 1, 0) }, uKeyE: { value: new THREE.Vector3() },
        uKey2Dir: { value: new THREE.Vector3(0, 1, 0) }, uKey2E: { value: new THREE.Vector3() }, uNightAmb: { value: new THREE.Vector3() },
        uCityGlow: { value: new THREE.Vector3() }, uFogGlowC: { value: new THREE.Vector3() },
        uCloudAlbedo: { value: new THREE.Vector3(1, 1, 1) },
        uSteps: { value: 64 }, uLightSteps: { value: 6 }, uMaxDist: { value: 90000 }, uFrame: { value: 0 }, uOrbitLod: { value: 0 },
        tHistory: { value: null }, uPrevViewProj: { value: new THREE.Matrix4() }, uHistoryBlend: { value: 0 },
        uCurveK: { value: 0.6 },
      },
    });
    if ((this.engine.params.get('atmo') || '').includes('dbgw')) this.marchMat.defines = { CLOUD_DEBUG_WEATHER: 1 };
    this.compMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: { tInput: { value: null }, tCloud: { value: null }, tDepth: { value: null }, uLowRes: { value: new THREE.Vector2() }, uNear: { value: 0.1 }, uFar: { value: 1e7 }, uRev: { value: 1 } },
    });
    this.ready = true;
  }

  /** Weather → cloud field. */
  setPreset(name, { rebake = true } = {}) {
    const p = CLOUD_PRESETS[name] || CLOUD_PRESETS.cumulus;
    this.preset = { ...p };
    this.presetName = name;
    if (this.ready) {
      this.uniforms.uCloudDensity.value = p.density;
      if (rebake) this.res.bakeWeather({ seed: this.seed, ...p });
    }
  }

  update(dt, t) {
    if (!this.ready) return;
    const u = this.uniforms;
    // Wind: the noise field drifts with the world wind; the weather map rotates slowly around the axis.
    const w = this.world.wind, ws = this.world.windStrength;
    const speed = (4 + 10 * ws) * dt;
    u.uCloudWind.value.addScaledVector(w, speed * u.uCloudShapeScale.value);
    this._rot = (this._rot || 0) + dt * 0.0012;
    u.uCloudRot.value.setFromMatrix4(_m4.makeRotationY(this._rot));
  }

  _ensureTargets(W, H, orbit = false) {
    // from orbit the layer is a single projected sample per pixel: render it at full
    // resolution (no stair-stepped coastlines of cloud over the sharp planet)
    const div = orbit ? 1 : this.engine.quality.pick(4, 3, 2, 2);
    const w = Math.max(1, Math.ceil(W / div)), h = Math.max(1, Math.ceil(H / div));
    if (this.rt && this.rt.width === w && this.rt.height === h) return;
    this.rt?.dispose(); this.rtPrev?.dispose();
    const mk = () => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false });
    this.rt = mk(); this.rtPrev = mk();
    this._historyValid = false;
  }

  /** Called by the atmosphere's pass chain. */
  render(renderer, input, output, ctx) {
    const L = this.level, m = this.model, light = L.lighting;
    const altC = ctx.cameraPosition.length() - m.Rb;
    this._ensureTargets(ctx.width, ctx.height, altC > this.topH * 2.4);
    const mu = this.marchMat.uniforms;
    mu.tDepth.value = ctx.depthTexture;
    mu.uFullRes.value.set(ctx.width, ctx.height);
    mu.uNear.value = ctx.near; mu.uFar.value = ctx.far; mu.uRev.value = ctx.reversed;
    mu.uProjInv.value.copy(ctx.projInv); mu.uViewInv.value.copy(ctx.viewInv); mu.uCam.value.copy(ctx.cameraPosition);
    // key light: sun by day, brightest moon by night (TOA illuminance; the shader applies transmittance)
    const sunUp = m.sunE.x + m.sunE.y + m.sunE.z;
    const camUp = _v.copy(ctx.cameraPosition).normalize();
    const sunEl = camUp.dot(this.world.sunDir);
    // Sun is always key 1 (the transmittance LUT handles the planet's shadow per sample, so
    // high clouds stay sunlit after the ground goes dark). The moon is key 2 once the sun is
    // low — both are lit consistently, no hard switch between a sunlit and a moonlit deck.
    const moonUp = m.moonE.x + m.moonE.y + m.moonE.z;
    if (sunUp > 0) { mu.uKeyDir.value.copy(this.world.sunDir); mu.uKeyE.value.copy(m.sunE); }
    // (moonE is the deliberately dim sky-scattering moon; the deck itself is lit a bit brighter)
    else { mu.uKeyDir.value.copy(m.moonDir); mu.uKeyE.value.set(m.moonE.x * 0.75, m.moonE.y * 0.85, m.moonE.z).multiplyScalar(1.8); }
    const k2 = sunUp > 0 && moonUp > 1e-6 ? 1 - THREE.MathUtils.smoothstep(sunEl, -0.25, 0.05) : 0;
    mu.uKey2Dir.value.copy(m.moonDir);
    // scotopic tint: moonlit cloud tops read cool silver, never cream
    mu.uKey2E.value.set(m.moonE.x * 0.62, m.moonE.y * 0.74, m.moonE.z * 0.92).multiplyScalar(k2 * 10.0);
    const nightK = light ? light.night : 0;
    // moonlit decks read cool silver-blue (scotopic), never cream under the warm grade
    mu.uCloudAlbedo.value.set(1 - 0.16 * nightK, 1 - 0.07 * nightK, 1 + 0.06 * nightK);
    // starlight + airglow + scattered moonlight: unlit clouds read as dark blue-grey shapes over the stars
    mu.uNightAmb.value.set(0.75e-3, 1.05e-3, 1.7e-3).multiplyScalar(nightK); // starlit/airglow decks read slate-blue against the band, not black paper
    // curvature compression fades out with altitude (from high up the true terminator shows)
    const altK = ctx.cameraPosition.length() - m.Rb;
    mu.uCurveK.value = 0.65 * (1 - THREE.MathUtils.smoothstep(altK, this.topH, this.topH * 2.4));
    mu.uCityGlow.value.set(0, 0, 0);
    if (light && light._bio) mu.uFogGlowC.value.set(light._bio.r, light._bio.g, light._bio.b).multiplyScalar(0.06 * (light.night || 0));
    else mu.uFogGlowC.value.set(0, 0, 0);
    if (light && light.night > 0.05) {
      // night: settlements within a few km light the cloud bases from below
      if (this._cityGlow === undefined || (this._cgFrame = (this._cgFrame || 0) + 1) % 30 === 0) {
        let g = 0;
        const sz = { megacity: 3, city: 2, spaceport: 1.6, town: 1, village: 0.5, outpost: 0.25, ruins: 0 };
        for (const site of this.world.sites || []) {
          const d = site.position ? site.position.distanceTo(ctx.cameraPosition) : 1e9;
          if (d < 4500) g += (sz[site.kind] ?? 0.5) * Math.exp(-d / 1500);
        }
        this._cityGlow = Math.min(g, 2);
      }
      if (!this._glowTint) {
        const glow = this.level.aesthetic?.palette?.glow?.[0];
        const bio = /pandora|eywa|nausicaa/i.test(this.level.planet.aesthetic || '');
        this._glowTint = bio && glow ? new THREE.Color(glow) : new THREE.Color(1, 0.62, 0.3);
      }
      const k = 0.0005 * this._cityGlow * light.night;
      mu.uCityGlow.value.set(this._glowTint.r, this._glowTint.g, this._glowTint.b).multiplyScalar(k);
    }
    const q = this.engine.quality;
    const alt = ctx.cameraPosition.length() - m.Rb;
    const orbit = alt > this.topH * 2.4;
    mu.uSteps.value = orbit ? q.pick(16, 24, 32, 40) : q.pick(32, 56, 84, 112);
    this.uniforms.uCloudFlat.value = orbit ? 1 : 0;
    // from high up the whole weather system reads (fronts, cyclone arms): widen the coverage
    // smoothly with altitude; near the deck the towers stay separated by blue gaps
    this.uniforms.uCloudCov.value = 1 + 0.35 * THREE.MathUtils.smoothstep(alt, this.topH * 1.4, this.topH * 3.2);
    mu.uLightSteps.value = orbit ? 3 : q.pick(3, 4, 6, 6);
    mu.uOrbitLod.value = orbit ? 1 : 0;
    mu.uMaxDist.value = orbit ? 4e5 : 7e4;
    mu.uFrame.value = this._frame++ % 64;
    // temporal accumulation (shots too: the jitter integrates over the rendered frames instead of dithering)
    const tmp = this.rtPrev; this.rtPrev = this.rt; this.rt = tmp;
    mu.tHistory.value = this.rtPrev.texture;
    if (this._wasOrbit !== orbit) this._historyValid = false;
    this._wasOrbit = orbit;
    // camera cuts (shot presets, respawns, a rig snapping into place): drop the history,
    // otherwise the previous view's cloud edges linger as bright ghost outlines
    const cam = ctx.camera;
    if (!this._lastCamPos) { this._lastCamPos = new THREE.Vector3(); this._lastCamQ = new THREE.Quaternion(); }
    const jump = this._lastCamPos.distanceTo(cam.position) > 25 || 2 * Math.acos(Math.min(1, Math.abs(this._lastCamQ.dot(cam.quaternion)))) > 0.035;
    this._lastCamPos.copy(cam.position); this._lastCamQ.copy(cam.quaternion);
    if (jump) this._historyValid = false;
    // shots: a running mean over the converging frames (each frame weighs the same → the
    // march noise integrates away instead of decaying into stripes); live play: EMA
    if (!this._historyValid || orbit) this._accN = 0;
    this._accN = (this._accN || 0) + 1;
    mu.uHistoryBlend.value = !this._historyValid || orbit ? 0 : (this.engine.shotMode ? Math.min(0.92, 1 - 1 / this._accN) : 0.86);
    ctx.fullscreen(this.marchMat, this.rt);
    this._historyValid = true;
    mu.uPrevViewProj.value.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
    const cu = this.compMat.uniforms;
    cu.tInput.value = input; cu.tCloud.value = this.rt.texture; cu.tDepth.value = ctx.depthTexture;
    cu.uLowRes.value.set(this.rt.width, this.rt.height);
    cu.uNear.value = ctx.near; cu.uFar.value = ctx.far; cu.uRev.value = ctx.reversed;
    ctx.fullscreen(this.compMat, output);
  }

  dispose() {
    this.res.dispose(); this.rt?.dispose(); this.marchMat?.dispose(); this.compMat?.dispose();
  }
}

const _v = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
