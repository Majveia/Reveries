// Renders the cosmic web: millions of tracer sprites of the dark-matter
// phase-space sheet, accumulated additively (HDR) as projected column density
// + density-weighted colour, then mapped through a luminous palette in a
// post effect (deep indigo sheets → electric cyan filaments → gold-white
// nodes) with depth cueing. True black stays true black.

import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/glsl/common.js';

const PALETTE_GLSL = /* glsl */ `
vec3 webPalette(float h){
  // linear-light HDR stops: near-black indigo veil → magenta-violet sheets → electric blue skirt →
  // saturated cyan filament spines → pale crossover → amber groups → white-gold cluster cores.
  // Stops sit low enough that the mass-weighted heat of an ordinary filament (≈0.45-0.6) lands in
  // CYAN, not in blue: three distinct hues, not a single powder-blue.
  // restrained like JWST / Millennium plates: mostly near-neutral emission with distinct accents
  vec3 c0 = vec3(0.003, 0.002, 0.008);   // void
  vec3 c1 = vec3(0.050, 0.016, 0.120);   // faint sheet: plum-indigo
  vec3 c2 = vec3(0.230, 0.110, 0.520);   // violet sheet / thin filament
  vec3 c3 = vec3(0.130, 0.220, 0.640);   // dim indigo-blue filament skirt (recedes; spines carry the light)
  vec3 c4 = vec3(0.300, 0.800, 0.980);   // electric cyan filament spine
  vec3 c45 = vec3(0.860, 0.930, 0.950);  // near-white crossover (where filaments feed a node)
  vec3 c5 = vec3(2.100, 1.250, 0.380);   // gold-amber group (green-rich so AgX keeps it GOLD, not salmon)
  vec3 c6 = vec3(3.200, 2.650, 1.800);   // white-gold cluster core (HDR: blooms)
  h = clamp(h, 0.0, 1.2);
  if (h < 0.18) return mix(c0, c1, h / 0.18);
  if (h < 0.42) return mix(c1, c2, (h - 0.18) / 0.24);   // a wide violet veil band
  if (h < 0.49) return mix(c2, c3, (h - 0.42) / 0.07);
  if (h < 0.55) return mix(c3, c4, (h - 0.49) / 0.06);
  // no constant cyan band: halo bodies keep a hue/luminance gradient toward their cores (no jelly fill)
  if (h < 0.66) { float k = clamp((h - 0.55) / 0.11, 0.0, 1.0); return mix(c4, c45, k * k * (0.35 + 0.65 * k)); }
  if (h < 0.72) return mix(c45, c5, smoothstep(0.66, 0.72, h));
  return mix(c5, c6, clamp((h - 0.72) / 0.32, 0.0, 1.0));
}
// the young universe (z ≳ 3): a delicate indigo-teal lattice whose first knots burn blue-white
vec3 earlyPalette(float h){
  vec3 e0 = vec3(0.002, 0.003, 0.010);
  vec3 e1 = vec3(0.080, 0.022, 0.170);   // plum-indigo sheet (hot, young)
  vec3 e2 = vec3(0.050, 0.360, 0.640);   // teal lattice
  vec3 e3 = vec3(0.300, 0.720, 0.950);   // pale cyan knot
  vec3 e4 = vec3(1.050, 1.020, 1.100);   // white-hot first collapse
  h = clamp(h, 0.0, 1.2);
  if (h < 0.28) return mix(e0, e1, h / 0.28);
  if (h < 0.46) return mix(e1, e2, (h - 0.28) / 0.18);
  if (h < 0.60) return mix(e2, e3, (h - 0.46) / 0.14);
  return mix(e3, e4, clamp((h - 0.60) / 0.18, 0.0, 1.0));
}`;

const TRACER_VERT = /* glsl */ `
uniform sampler2D tPrev; uniform sampler2D tNext; uniform float uW;
uniform float uL; uniform vec3 uCenter; uniform float uScale; uniform float uShape;
uniform float uProj; uniform float uTime; uniform float uShimmer; uniform float uVol; uniform float uGamma;
uniform float uWarm; uniform float uFog; uniform float uSizeK; uniform float uOverlap; uniform float uContrastK; uniform float uFogNear;
uniform float uPxMax; uniform float uNear; uniform float uEarly; uniform float uDim; uniform float uClampK;
varying vec4 vC;
${PALETTE_GLSL}
float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
uint ihashT(uint x){ x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
vec4 fetchT(ivec3 l){
  l = (l + MT) % MT;
  int i = l.x + l.y * MT + l.z * MT * MT;
  ivec2 tc = ivec2(i % TW, i / TW);
  return mix(texelFetch(tPrev, tc, 0), texelFetch(tNext, tc, 0), uW);
}
void main(){
  int vid = gl_VertexID;
  int t = vid / SUBS; int sub = vid - t * SUBS;
  ivec3 l = ivec3(t % MT, (t / MT) % MT, t / (MT * MT));
  vec4 s = fetchT(l);
  float sp0 = uL / float(MT);
  vec3 x = (vec3(l) + 0.5) * sp0 + s.xyz;
  vec3 d = x - uCenter;
  d -= uL * floor(d / uL + 0.5);                     // periodic: nearest image around the centre
  float heat = s.w;
  // Is the phase-space sheet under-sampled on screen here? Then refine it: extra sub-tracers are
  // spawned inside the Lagrangian tetrahedra spanned with the neighbouring tracers (barycentric
  // interpolation of their displacements, after Abel, Hahn & Kaehler 2012), each carrying 1/SUBS
  // of the mass. Well-sampled (distant or collapsed) regions keep a single tracer.
  float distP = -(modelViewMatrix * vec4(uCenter + d * uScale, 1.0)).z;
  float spP = sp0 * clamp(pow(pow(10.0, (heat - 0.2) / (0.31 * uContrastK)), -0.333), 0.05, 1.8) * uScale;
  float under = spP * uOverlap * uProj / max(distP, 0.05) / uPxMax;
  float nS = 1.0;
  if (SUBS > 1 && under > 1.0 && distP > 0.0) {
    nS = float(SUBS);
    if (sub > 0) {
      uint h = ihashT(uint(vid) * 747796405u + 2891336453u);
      uint h2 = ihashT(h ^ 0x68bc21ebu);
      vec4 r = vec4(float(h & 255u), float((h >> 8) & 255u), float((h >> 16) & 255u), float(h >> 24)) / 255.0 * 0.992 + 0.004;
      vec4 w = -log(r); w /= dot(w, vec4(1.0));           // uniform in the tetrahedron
      ivec3 sg = ivec3(int(h2 & 1u) * 2 - 1, int((h2 >> 1) & 1u) * 2 - 1, int((h2 >> 2) & 1u) * 2 - 1);
      vec4 sx = fetchT(l + ivec3(sg.x, 0, 0)), sy = fetchT(l + ivec3(0, sg.y, 0)), sz = fetchT(l + ivec3(0, 0, sg.z));
      d += w.y * (vec3(float(sg.x) * sp0, 0.0, 0.0) + sx.xyz - s.xyz)
         + w.z * (vec3(0.0, float(sg.y) * sp0, 0.0) + sy.xyz - s.xyz)
         + w.w * (vec3(0.0, 0.0, float(sg.z) * sp0) + sz.xyz - s.xyz);
      heat += w.y * (sx.w - s.w) + w.z * (sy.w - s.w) + w.w * (sz.w - s.w);
      // the tetrahedron's own (stream) density: stretched cells spread their mass thin, and cells
      // torn across a void after shell crossing are not interpolated at all
      vec3 e1 = vec3(float(sg.x) * sp0, 0.0, 0.0) + sx.xyz - s.xyz;
      vec3 e2 = vec3(0.0, float(sg.y) * sp0, 0.0) + sy.xyz - s.xyz;
      vec3 e3 = vec3(0.0, 0.0, float(sg.z) * sp0) + sz.xyz - s.xyz;
      float stretch = max(max(length(e1), length(e2)), length(e3)) / sp0;
      float rhoTet = sp0 * sp0 * sp0 / max(abs(dot(e1, cross(e2, e3))), 1e-4 * sp0 * sp0 * sp0);
      heat = min(heat, 0.2 + 0.31 * uContrastK * log(max(rhoTet, 0.05)) / log(10.0) + 0.12);
      // After shell crossing (collapsed halos, torn or inverted cells) the Lagrangian tetrahedron no
      // longer maps the sheet: interpolating it paints the cell's convex hull as a flat, faceted
      // polygon. There the sub-tracer instead joins its parent's virialised swarm — an isotropic,
      // centrally concentrated cloud (mass is conserved, the halo stays round and cuspy).
      float tetVol = dot(e1, cross(e2, e3));
      // (the young universe has barely shell-crossed: keep the sheet interpolation there, no swarm stipple)
      if (stretch > 2.2 || tetVol <= 0.0 || (s.w > 0.62 && uEarly < 0.5)) {
        d = x - uCenter; d -= uL * floor(d / uL + 0.5);
        vec3 gj = vec3(r.x - 0.5, r.y - 0.5, r.z - 0.5);
        d += normalize(gj + 1e-4) * (0.15 + 0.85 * r.w * r.w) * sp0 * 0.45;
        heat = s.w;
      }
    }
  } else if (sub > 0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vC = vec4(0.0); return; }
  vec3 ad = abs(d) / (0.5 * uL);
  float nrm = pow(pow(ad.x, uShape) + pow(ad.y, uShape) + pow(ad.z, uShape), 1.0 / uShape);
  // seen from outside, the volume ends in a soft, irregular (low-order noise) edge — never a sphere
  vec3 dn = d / max(length(d), 1e-3);
  nrm *= 1.0 + 0.11 * (sin(dot(dn, vec3(3.1, 1.7, -2.3)) * 2.1 + 1.3) + 0.6 * sin(dot(dn, vec3(-1.9, 4.3, 2.7)) * 1.7 + 4.1));
  float fade = 1.0 - smoothstep(0.58, 1.02, nrm);
  float hh = clamp((heat - 0.55) / 0.45, 0.0, 1.0);
  // virialised swarm: members of collapsed halos circulate on slow, coherent orbits
  float fid = float(vid);
  vec3 ph = vec3(hash11(fid), hash11(fid + 17.3), hash11(fid + 41.9)) * 6.2831853;
  float om = 0.25 + hash11(fid + 7.1) * 0.5;
  d += uShimmer * hh * hh * 0.28 * vec3(sin(uTime * om + ph.x), sin(uTime * om + ph.y), cos(uTime * om + ph.x));
  vec3 wp = uCenter + d * uScale;
  vec4 mv = modelViewMatrix * vec4(wp, 1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;
  if (dist < 0.05 || fade <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vC = vec4(0.0); return; }
  // Splat the sheet: the TRUE footprint covers the local inter-sample spacing (smooth continuum),
  // but sprites never grow past uPxMax pixels — near-field matter keeps its surface brightness
  // and thins into a dim, fine-grained haze instead of giant discs.
  float rhoEff = pow(10.0, (heat - 0.2) / (0.31 * uContrastK));
  float spacing = sp0 * clamp(pow(rhoEff, -0.333), 0.05, 1.8) * uScale * pow(nS, -0.3333);
  // collapsed halos keep sharp sprites: the cluster interior is drawn analytically (ClusterLights)
  float sharp = sp0 * uSizeK * 0.09 * uScale * (1.0 + 0.3 * hh);
  float px = max(sharp, spacing * uOverlap) * uProj / dist;
  float pxc = clamp(px, 1.0, uPxMax);
  gl_PointSize = pxc;
  // emission ∝ mass · ρ^γ ; per-pixel value is column density (Mpc of mean matter)
  float emis = uVol * pow(10.0, uGamma * (heat - 0.2) / 0.31) / nS;
  float pxWorld = dist / uProj;
  float norm = 0.19 * max(px, 1.0) * max(px, 1.0);        // Gaussian kernel integral of the true footprint
  float near = smoothstep(uNear * 0.25, uNear, dist);
  float val = fade * near * emis / (pxWorld * pxWorld * norm) / (uScale * uScale) * 1e-4; // ×1e-4 keeps half-float sums finite (cluster cores must not saturate at 65504)
  val *= pow(min(1.0, uPxMax / px), uClampK);             // under-sampled near field thins to a dim haze
  val = min(val, 3.0);
  // aerial perspective of the web: distant structure fades exponentially (and cools to violet in
  // the composite). Scalar channels only — colour is palette-mapped per PIXEL from the
  // accumulated mass-weighted heat, so neighbouring sprites never produce colour confetti.
  float fd = max(dist - uFogNear, 0.0);
  float tr = exp(-fd / uFog);
  val *= tr * uDim;
  // phase-space shimmer: virialised members flicker on their own orbital phase, so collapsed cores
  // sparkle (caustic glints) instead of glowing flat; cold filament streams stay steady
  val *= 1.0 + uShimmer * hh * (0.45 * sin(uTime * om * 2.7 + ph.y) + 0.25 * sin(uTime * om * 6.1 + ph.z));
  // primordial glow (the first instants after the Bang): warm amber plasma
  val *= 1.0 + 5.0 * uWarm * uWarm;
  // r: Σ mass·heat · g: Σ mass·haze · b: sample count (×1e-3) · a: Σ mass
  // the sample count only counts EFFECTIVE samples: near-field sprites dimmed by the px clamp or the
  // near fade must not push the composite onto the sparse sharp level (that punched dark holes)
  float cw = near * pow(min(1.0, uPxMax / px), uClampK) * step(0.02, tr);
  vC = vec4(val * heat, val * (1.0 - tr), 1e-3 * cw, val);
}`;

const TRACER_FRAG = /* glsl */ `
varying vec4 vC;
void main(){
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(pc, pc);
  if (r2 > 1.0) discard;
  float k = max(exp(-r2 * 4.0) - 0.0183, 0.0) * 1.0187;   // Gaussian, zero at the rim: never reads as a disc
  gl_FragColor = vC * k;
}`;


// Galaxies: a sparse, hash-selected subset of tracers lights up as sharp HDR
// points where matter has collapsed (groups, clusters, dense filaments). They
// render straight into the HDR scene (not log-mapped) so they sparkle and bloom;
// the brightest carry faint 4-point diffraction spikes (a JWST-like signature).
const GALAXY_VERT = /* glsl */ `
uniform sampler2D tPrev; uniform sampler2D tNext; uniform float uW;
uniform float uL; uniform vec3 uCenter; uniform float uScale; uniform float uShape;
uniform float uTime; uniform float uShimmer; uniform float uWarm; uniform float uGal; uniform float uPxK;
uniform float uFog; uniform float uFogNear; uniform float uEarly;
varying vec3 vCol; varying float vSpike; varying float vPx;
uint ihash(uint x){ x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
void main(){
  uint hi = ihash(uint(gl_VertexID) + 0x9e3779b9u);
  int t = gl_VertexID * STRIDE + int(hi % uint(STRIDE));
  ivec2 tc = ivec2(t % TW, t / TW);
  vec4 s = mix(texelFetch(tPrev, tc, 0), texelFetch(tNext, tc, 0), uW);
  ivec3 l = ivec3(t % MT, (t / MT) % MT, t / (MT * MT));
  vec3 x = (vec3(l) + 0.5) * (uL / float(MT)) + s.xyz;
  vec3 d = x - uCenter;
  d -= uL * floor(d / uL + 0.5);
  vec3 ad = abs(d) / (0.5 * uL);
  float nrm = pow(pow(ad.x, uShape) + pow(ad.y, uShape) + pow(ad.z, uShape), 1.0 / uShape);
  vec3 dn = d / max(length(d), 1e-3);
  nrm *= 1.0 + 0.11 * (sin(dot(dn, vec3(3.1, 1.7, -2.3)) * 2.1 + 1.3) + 0.6 * sin(dot(dn, vec3(-1.9, 4.3, 2.7)) * 1.7 + 4.1));
  float fade = 1.0 - smoothstep(0.58, 1.0, nrm);
  float heat = s.w;
  float hh = clamp((heat - 0.55) / 0.45, 0.0, 1.0);
  float fid = float(t);
  vec3 ph = vec3(hash11(fid), hash11(fid + 17.3), hash11(fid + 41.9)) * 6.2831853;
  float om = 0.25 + hash11(fid + 7.1) * 0.5;
  d += uShimmer * hh * hh * 0.28 * vec3(sin(uTime * om + ph.x), sin(uTime * om + ph.y), cos(uTime * om + ph.x));
  vec4 mv = modelViewMatrix * vec4(uCenter + d * uScale, 1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;
  // luminosity function: galaxies live in collapsed structures; a few are giants
  float u = float((hi >> 8) & 1023u) / 1023.0;
  float thr = mix(0.14, 0.56, uEarly);   // field galaxies light sheets and thin filaments too (faintly)                       // early on, only the rarest peaks have lit up
  // filament galaxies light up too (sharp HDR sparkle over the smooth web); a few are giants
  // log-normal-ish luminosity function over ~2 decades, weighted to dense matter (rho^1.3 importance)
  float u3 = u * u * u; float lum = smoothstep(thr, thr + 0.4, heat) * pow(10.0, 1.9 * u3 - 0.85) * (0.6 + 0.8 * smoothstep(0.5, 0.8, heat));
  if (dist < 0.3 || fade <= 0.0 || lum < 0.004) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vSpike = 0.0; vPx = 1.0; return; }
  float tr = exp(-max(dist - uFogNear, 0.0) / uFog);
  float b = lum * fade * tr * smoothstep(0.3, 2.5, dist) * uGal * 150.0 / sqrt(max(dist, 5.0));   // pin-sharp at every distance
  float core = clamp(uPxK * (0.7 + 1.0 * u * u) * sqrt(30.0 / max(dist, 4.0)), 1.0, 2.6);   // sharp, sub-3px HDR points
  // the brightest ~0.3% get diffraction spikes (a much larger, mostly empty sprite)
  float spike = 0.0;   // spikes only on luminance-ranked BCGs (ClusterLights)
  float px = spike > 0.0 ? clamp(uPxK * 26.0 * sqrt(30.0 / max(dist, 8.0)), 8.0, 40.0) : core;
  gl_PointSize = px;
  vPx = px / core;
  vSpike = spike;
  // red-and-dead ellipticals in cluster cores, blue star-forming spirals in filaments
  float tint = float((hi >> 20) & 255u) / 255.0;
  vec3 cl = mix(vec3(1.0, 0.70, 0.40), vec3(1.0, 0.88, 0.74), tint);
  vec3 fl = mix(vec3(0.58, 0.74, 1.0), vec3(0.92, 0.92, 1.0), tint);
  vec3 col = mix(fl, cl, smoothstep(0.55, 0.85, heat));
  col = mix(col, tint > 0.72 ? vec3(1.5, 0.62, 0.30) : vec3(0.75, 0.90, 1.45), uEarly);   // first protogalaxies: blue-white starbursts, ember sparks
  col = mix(col, vec3(1.25, 0.62, 0.28), uWarm);
  // HDR-capped: a point brighter than this only prints the bloom kernel (square tiles), not a star
  vCol = col * min(b, 5.0) / max(1.0, core * core * 0.35);
}`;
const GALAXY_FRAG = /* glsl */ `
varying vec3 vCol; varying float vSpike; varying float vPx;
void main(){
  vec2 p = (gl_PointCoord * 2.0 - 1.0) * vPx;                // in units of the core radius
  float r2 = dot(p, p);
  float v = exp(-r2 * 6.0) + 0.3 * exp(-r2 * 1.6);
  if (vSpike > 0.0) {
    // JWST-style hexagonal PSF: six primary arms (three struts through the core) + two faint
    // horizontal secondaries
    float sp = 0.0;
    for (int k = 0; k < 3; k++) {
      float an = 1.5707963 + float(k) * 1.0471976;
      vec2 e = vec2(cos(an), sin(an));
      float al = abs(dot(p, e)), pe = abs(dot(p, vec2(-e.y, e.x)));
      sp += exp(-pe * 3.2) * exp(-al / vPx * 4.5);
    }
    sp += 0.35 * exp(-abs(p.y) * 4.0) * exp(-abs(p.x) / vPx * 7.0);
    float edge = 1.0 - smoothstep(0.6, 1.0, length(p) / vPx);
    v += 0.22 * sp * edge + 0.04 * exp(-r2 * 0.12);
  } else if (r2 > 1.0) discard;
  gl_FragColor = vec4(vCol * v, 1.0);
}`;

// Multi-scale density estimate: the accumulation buffer is pyramided into a half- and a quarter-
// resolution copy with a separable Gaussian (no golden-angle spiral, no per-pixel switching).
const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
void main(){
  // 13-tap (Jimenez/CoD) downsample: overlapping 4×4 boxes weighted into a radial kernel, so a
  // single bright texel never prints a square footprint into the pyramid
  vec2 t = uTexel;
  vec4 a = texture2D(tSrc, vUv + t * vec2(-2.0, -2.0)), b = texture2D(tSrc, vUv + t * vec2(0.0, -2.0)), c = texture2D(tSrc, vUv + t * vec2(2.0, -2.0));
  vec4 d = texture2D(tSrc, vUv + t * vec2(-2.0, 0.0)), e = texture2D(tSrc, vUv), f = texture2D(tSrc, vUv + t * vec2(2.0, 0.0));
  vec4 g = texture2D(tSrc, vUv + t * vec2(-2.0, 2.0)), h = texture2D(tSrc, vUv + t * vec2(0.0, 2.0)), i = texture2D(tSrc, vUv + t * vec2(2.0, 2.0));
  vec4 j = texture2D(tSrc, vUv + t * vec2(-1.0, -1.0)), k = texture2D(tSrc, vUv + t * vec2(1.0, -1.0));
  vec4 l = texture2D(tSrc, vUv + t * vec2(-1.0, 1.0)), m = texture2D(tSrc, vUv + t * vec2(1.0, 1.0));
  gl_FragColor = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
}`;
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uDir; varying vec2 vUv;
void main(){
  // 9-tap Gaussian (σ≈2 texels) in 5 linear fetches
  vec4 c = texture2D(tSrc, vUv) * 0.2270270;
  c += (texture2D(tSrc, vUv + uDir * 1.3846154) + texture2D(tSrc, vUv - uDir * 1.3846154)) * 0.3162162;
  c += (texture2D(tSrc, vUv + uDir * 3.2307692) + texture2D(tSrc, vUv - uDir * 3.2307692)) * 0.0702703;
  gl_FragColor = c;
}`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tInput; uniform sampler2D tAccum; uniform sampler2D tHalf; uniform sampler2D tQuarter;
uniform float uGain; uniform float uA0; uniform float uHi; uniform float uExposure; uniform float uToe; uniform float uFloor;
uniform float uSmooth; uniform float uSharpA; uniform float uEarly; uniform float uWarm; uniform float uCap; uniform float uVeil;
uniform vec2 uHalfSize; uniform vec2 uQuarterSize; uniform float uEarlyLattice; uniform float uHiPow;
uniform float uOpt; uniform float uEnvK; uniform float uHeatK; uniform float uDetail; uniform float uLatticeK; uniform float uVeilFloor; uniform vec3 uVeilCol;
varying vec2 vUv;
${PALETTE_GLSL}
// cubic B-spline reconstruction in 4 bilinear taps: thresholding a bilinearly magnified low-res
// level draws diamond/polygon iso-contours (faceted blobs); the B-spline keeps them round and soft
vec4 texBicubic(sampler2D t, vec2 uv, vec2 size){
  vec2 st = uv * size - 0.5; vec2 i = floor(st); vec2 f = st - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0, w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (w1 / g0 - 1.0 + i + 0.5) / size, h1 = (w3 / g1 + 1.0 + i + 0.5) / size;
  return g0.y * (g0.x * texture2D(t, vec2(h0.x, h0.y)) + g1.x * texture2D(t, vec2(h1.x, h0.y)))
       + g1.y * (g0.x * texture2D(t, vec2(h0.x, h1.y)) + g1.x * texture2D(t, vec2(h1.x, h1.y)));
}
// select (not arithmetic mix: NaN·0 is still NaN) — overflowed / NaN texels sit in saturated cores
vec4 sane(vec4 v){ return clamp(mix(v, vec4(65000.0), bvec4(vec4(isnan(v)) + vec4(isinf(v)))), 0.0, 65000.0); }
float ignC(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
// soft black floor: C1 toe instead of a hard max(x - floor, 0) (no hard iso-contour edges)
float softFloor(float x, float fl){ float d = x - fl; const float w = 0.32; return d > w ? d : (d < -w ? 0.0 : (d + w) * (d + w) / (4.0 * w)); }
// log column-density response with a black floor (faint sheets fall to true black, OLED)
// + an unbounded power-law term for collapsed cores: a cusp that keeps rising toward the centre
float respI(float A){
  float x = log(1.0 + pow(A / uA0, uToe));
  float xf = softFloor(x, uFloor);
  return uGain * xf * xf / (xf + 0.6) + uHi * (1.0 - exp(-A / (uA0 * 60.0))) + uHi * 3.0 * pow(max(A / (uA0 * 60.0) - 0.15, 0.0), uHiPow);
}
void main(){
  vec3 base = texture2D(tInput, vUv).rgb;
  // half-float sums of collapsed knots can overflow to +inf; mix(x, inf, 0) would be NaN (black holes)
  // (and a bilinear tap between an inf texel and a zero weight is NaN: guard it explicitly, else the
  // densest cluster rims get dark 'bite' specks)
  vec4 f = texture2D(tAccum, vUv), h = texBicubic(tHalf, vUv, uHalfSize), q = texBicubic(tQuarter, vUv, uQuarterSize);
  f = sane(f); h = sane(h); q = sane(q);
  // Adaptive (SPH-like) smoothing driven by the SMOOTHED local sample count: where only a few sprites
  // overlap — sheets, filament skirts, the sparse swarms of collapsed halos — the tracers are
  // integrated over the wide Gaussian; well-sampled pixels keep the sharp kernel. The weights come
  // from blurred fields, so the transition is a gradient, never a dissolve/dither pattern.
  float cq = q.b * 1000.0, ch = h.b * 1000.0;
  float sA = uSharpA * uSmooth;
  // TWO LAYERS instead of one level replacing another:
  //  · the ENVELOPE — the adaptively smoothed (quarter → half) column, a soft luminous body;
  //  · the SHARP layer — the full-resolution accumulation, crisp filament spines, halo cusps and
  //    individual tracers, which may only ADD light above the envelope (never punch holes in it).
  // Crossovers are driven by the smoothed (effective) sample counts only.
  // The SHARP column is the visible body. Only genuinely under-sampled pixels (sparse sheets) fall
  // back to the half level (σ≈4 px), and only near-empty ones to the quarter level; the envelope
  // adds a faint additive halo (a PSF wing), never the body, so spines stay pin-sharp.
  float kH = smoothstep(0.02 * sA, 0.22 * sA, cq);
  float kF = smoothstep(0.06 * sA, 0.55 * sA, ch);
  vec4 env = mix(q, h, kH);
  vec4 acc = mix(h, f, kF);
  acc = mix(env, acc, kH);
  float Ae = min(env.a, 65000.0) * 10000.0;
  float A = min(acc.a, 65000.0) * 10000.0;
  float Ie = respI(Ae), Ia = respI(A);
  float I = Ia + uEnvK * Ie * (1.0 - 0.5 * smoothstep(0.0, 1.0, Ia / max(Ie, 1e-6)));
  // the sharp spine detail (high-pass of the full-res column over the half level), weighted toward
  // dense structure so sparse sheets do not speckle: thread-thin filaments and pin-point halos
  float hmA = acc.r / max(acc.a, 1e-12), hmE = env.r / max(env.a, 1e-12);
  float detail = max(respI(min(f.a, 65000.0) * 10000.0) - respI(min(h.a, 65000.0) * 10000.0), 0.0);
  float hf = f.r / max(f.a, 1e-12);
  I += uDetail * detail * kH * smoothstep(0.42, 0.75, hf) * (0.4 + 0.6 * hf * hf);
  float sAcc = clamp(Ia / max(uEnvK * Ie, 1e-6) - 0.5, 0.0, 1.0);
  float hm = mix(hmE, hmA, sAcc) * uHeatK;
  float haze = clamp(mix(env.g / max(env.a, 1e-12), acc.g / max(acc.a, 1e-12), sAcc), 0.0, 1.0);
  haze *= 1.0 - smoothstep(mix(0.6, 0.48, uEarly), mix(0.76, 0.66, uEarly), hm);
  float knC = smoothstep(0.5, 0.85, hmE * uHeatK);
  vec3 C = mix(webPalette(hm), earlyPalette(mix(min(hm, 0.62), hm, knC * knC)), uEarly);
  float lum = dot(C, vec3(0.2126, 0.7152, 0.0722));
  // aerial perspective: distant structure cools toward a dim violet veil (not toward black)
  C = mix(C, mix(vec3(0.24, 0.10, 0.66), vec3(0.08, 0.10, 0.50), uEarly) * (lum * 0.85 + 0.03), haze * 0.75);
  C = mix(C, vec3(1.25, 0.62, 0.28), uWarm);
  // The young universe: its projected COLUMN contrast is tiny (the whole box averages out into
  // blobs), but each pixel's mass-weighted heat still measures the 3-D overdensity of the matter it
  // integrates. Driving brightness by that heat (gated by coverage, so voids stay black) draws the
  // proto-web's connected lattice — the same skeleton the z=0 web will grow from.
  float cov = A / (A + uA0 * 0.6);
  // the first knots: no flat plateau — a log-column cusp that keeps rising toward their centres,
  // while the lattice term itself backs off inside them (they are rare, small and pin-bright)
  // knot-ness from the SMOOTHED heat: centre-peaked with a soft rim (the raw heat steps at the
  // knot's edge and printed flat stickers)
  float kn = smoothstep(0.5, 0.85, hmE * uHeatK);
  float Il = uGain * 2.2 * cov * pow(smoothstep(0.15, 0.42, hm), uLatticeK) * (1.0 - 0.7 * kn)
            + uGain * 1.5 * cov * kn * kn * kn * (0.6 + 0.4 * log(1.0 + A / (uA0 * 8.0)))
            + uDetail * detail * 0.6 * (1.0 - 0.75 * kn);
  I = mix(I, Il, uEarly * uEarlyLattice);
  // optical-depth soft cap: a filament seen end-on integrates its whole length — it stays a bright
  // line with a gradient instead of clipping into a flat plateau
  if (uOpt > 0.0) I = uOpt * (1.0 - exp(-I / uOpt));
  vec3 w = C * I * uExposure;
  // WHIM veil: a faint indigo-violet sheath from the wide (quarter-res) column around the web,
  // with its own floor so voids stay exactly black
  float xq = log(1.0 + pow(min(q.a, 65000.0) * 10000.0 / uA0, uToe));
  float veil = smoothstep(uVeilFloor * 0.3, uVeilFloor * 2.0, xq); veil *= veil;
  w += mix(uVeilCol, vec3(0.010, 0.050, 0.140), uEarly) * veil * uVeil * uExposure;
  // HDR shoulder: below the knee the web is linear; above it luminance keeps growing logarithmically
  // (no plateau) so cluster cores carry a cusp all the way up, cross display white and bloom —
  // the global AgX tonemap does the final roll-off and turns them white-gold.
  float wl = dot(w, vec3(0.2126, 0.7152, 0.0722));
  float knee = 0.45 * uCap;
  if (wl > knee) { float e = wl - knee; w *= (knee + e / (1.0 + e / (4.0 * uCap))) / wl; }
  // sub-LSB blue-noise dither kills banding in the long faint gradients
  w += (ignC(gl_FragCoord.xy) - 0.5) * 0.0015 * min(1.0, wl * 40.0);
  gl_FragColor = vec4(base + max(w, 0.0), 1.0);
}`;

export class WebRenderer {
  constructor(engine, sim, opts = {}) {
    this.engine = engine;
    this.sim = sim;
    const { TW, m, L, T } = sim;
    this.params = {
      gain: 0.30, a0: 60, hi: 0.12, cap: 0.95, toe: 1.4, floor: 0.6, exposure: 1, gamma: 2.2, shimmer: 1, warm: 0, fog: 60, sizeK: 1.0, shape: 2, scale: 1, overlap: 1.4, contrastK: 1, galaxies: 1, fogNear: 0, pxMax: 5, near: 10, early: 0, dim: 1, clampK: 1.0, smooth: 3.2, sharpA: 4.0, veil: 0.5,
    };
    const geo = new THREE.BufferGeometry();
    const SUBS = Math.max(1, opts.subs ?? 1);
    geo.setAttribute('position', new THREE.BufferAttribute(new Uint8Array(T * SUBS), 1));
    this.material = new THREE.ShaderMaterial({
      vertexShader: TRACER_VERT, fragmentShader: TRACER_FRAG,
      defines: { TW, MT: m, SUBS },
      uniforms: {
        tPrev: { value: null }, tNext: { value: null }, uW: { value: 0 },
        uL: { value: L }, uCenter: { value: new THREE.Vector3() }, uScale: { value: 1 }, uShape: { value: 6 },
        uProj: { value: 600 }, uTime: { value: 0 }, uShimmer: { value: 1 }, uVol: { value: (L / m) ** 3 }, uGamma: { value: 0.6 },
        uWarm: { value: 0 }, uFog: { value: 260 }, uSizeK: { value: 1 }, uOverlap: { value: 1.6 }, uContrastK: { value: 1 }, uFogNear: { value: 0 },
        uPxMax: { value: 5 }, uNear: { value: 10 }, uEarly: { value: 0 }, uDim: { value: 1 }, uClampK: { value: 0 },
      },
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    });
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.accScene = new THREE.Scene();
    this.accScene.add(this.points);
    this.accRT = null;

    // galaxies (scene object, HDR)
    const nGal = Math.min(T, opts.galaxies ?? 65536);
    const stride = Math.max(1, Math.floor(T / nGal));
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(new Uint8Array(Math.floor(T / stride)), 1));
    gg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const U = this.material.uniforms;
    this.galMaterial = new THREE.ShaderMaterial({
      vertexShader: GALAXY_VERT, fragmentShader: GALAXY_FRAG, defines: { TW, MT: m, STRIDE: stride },
      uniforms: { tPrev: U.tPrev, tNext: U.tNext, uW: U.uW, uL: U.uL, uCenter: U.uCenter, uScale: U.uScale, uShape: U.uShape, uTime: U.uTime, uShimmer: U.uShimmer, uWarm: U.uWarm, uGal: { value: 1 }, uPxK: { value: 1 }, uFog: U.uFog, uFogNear: U.uFogNear, uEarly: U.uEarly },
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    this.galaxies = new THREE.Points(gg, this.galMaterial);
    this.galaxies.frustumCulled = false;
    this.galaxies.renderOrder = 5;
    this._key = '';

    const self = this;
    this.compMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: COMPOSITE_FRAG,
      uniforms: { tInput: { value: null }, tAccum: { value: null }, tHalf: { value: null }, tQuarter: { value: null }, uGain: { value: 0.16 }, uA0: { value: 2 }, uHi: { value: 0.6 }, uExposure: { value: 1 }, uToe: { value: 1.4 }, uFloor: { value: 0 }, uSmooth: { value: 1 }, uSharpA: { value: 4 }, uEarly: { value: 0 }, uWarm: { value: 0 }, uCap: { value: 0.9 }, uVeil: { value: 0.5 }, uHalfSize: { value: new THREE.Vector2(1, 1) }, uEarlyLattice: { value: 0 }, uOpt: { value: 0 }, uEnvK: { value: 0.6 }, uHeatK: { value: 1 }, uDetail: { value: 0.8 }, uLatticeK: { value: 1.6 }, uHiPow: { value: 1.05 }, uVeilFloor: { value: 0.6 }, uVeilCol: { value: new THREE.Vector3(0.060, 0.016, 0.200) }, uQuarterSize: { value: new THREE.Vector2(1, 1) } },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.downMat = new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader: DOWN_FRAG, uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
    this.blurMat = new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader: BLUR_FRAG, uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } }, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
    this.effect = {
      enabled: true,
      render(renderer, input, output, ctx) {
        const u = self.compMat.uniforms;
        u.tInput.value = input; u.tAccum.value = self.accRT?.texture || null;
        u.uGain.value = self.params.gain; u.uA0.value = self.params.a0; u.uHi.value = self.params.hi; u.uExposure.value = self.params.exposure; u.uToe.value = self.params.toe; u.uFloor.value = self.params.floor;
        if (self.accRT) self._pyramid(ctx);
        u.tHalf.value = self.halfRT?.texture || null; u.tQuarter.value = self.quarterRT?.texture || null;
        if (self.halfRT) { u.uHalfSize.value.set(self.halfRT.width, self.halfRT.height); u.uQuarterSize.value.set(self.quarterRT.width, self.quarterRT.height); }
        u.uSmooth.value = self.params.smooth / 3.2; u.uSharpA.value = self.params.sharpA;
        u.uEarly.value = self.params.early; u.uWarm.value = self.params.warm; u.uCap.value = self.params.cap ?? 0.9; u.uVeil.value = self.params.veil ?? 0.5; u.uEarlyLattice.value = self.params.lattice ?? 0; u.uEnvK.value = self.params.envK ?? 0.6; u.uOpt.value = self.params.opt ?? 0; u.uHeatK.value = self.params.heatK ?? 1; u.uDetail.value = self.params.detail ?? 0.8; u.uLatticeK.value = self.params.latticeK ?? 1.6; u.uHiPow.value = self.params.hiPow ?? 1.05; u.uVeilFloor.value = self.params.veilFloor ?? self.params.floor;
        ctx.fullscreen(self.compMat, output);
      },
    };
  }

  _ensureRT() {
    const pf = this.engine.postfx;
    const w = pf.width, h = pf.height;
    if (this.accRT && this.accRT.width === w && this.accRT.height === h) return;
    this.accRT?.dispose();
    const ex = this.engine.renderer.extensions;
    const fType = (ex.has('EXT_float_blend') && ex.has('OES_texture_float_linear') && ex.has('EXT_color_buffer_float')) ? THREE.FloatType : THREE.HalfFloatType;
    this.accRT = new THREE.WebGLRenderTarget(w, h, {
      type: fType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    const opt = { type: fType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false };
    for (const k of ['halfRT', 'halfTmp', 'quarterRT', 'quarterTmp']) this[k]?.dispose();
    const hw = Math.max(1, Math.ceil(w / 2)), hh = Math.max(1, Math.ceil(h / 2));
    const qw = Math.max(1, Math.ceil(w / 4)), qh = Math.max(1, Math.ceil(h / 4));
    this.halfRT = new THREE.WebGLRenderTarget(hw, hh, opt); this.halfTmp = new THREE.WebGLRenderTarget(hw, hh, opt);
    this.quarterRT = new THREE.WebGLRenderTarget(qw, qh, opt); this.quarterTmp = new THREE.WebGLRenderTarget(qw, qh, opt);
    this._key = '';
    this._pyrKey = null;
  }

  /** Half/quarter-resolution Gaussian pyramid of the accumulation buffer (6 small passes). */
  _pyramid(ctx) {
    if (this._pyrKey === this._key && this._key) return;     // cached accumulation: pyramid is valid
    this._pyrKey = this._key;
    const d = this.downMat.uniforms, b = this.blurMat.uniforms;
    const level = (src, dst, tmp) => {
      d.tSrc.value = src.texture; d.uTexel.value.set(1 / src.width, 1 / src.height);
      ctx.fullscreen(this.downMat, dst);
      b.tSrc.value = dst.texture; b.uDir.value.set(1 / dst.width, 0); ctx.fullscreen(this.blurMat, tmp);
      b.tSrc.value = tmp.texture; b.uDir.value.set(0, 1 / dst.height); ctx.fullscreen(this.blurMat, dst);
    };
    level(this.accRT, this.halfRT, this.halfTmp);
    level(this.halfRT, this.quarterRT, this.quarterTmp);
  }

  /**
   * Accumulate tracer sprites for this camera. disp = { prev, next, w } from the solver.
   * `center` is the periodic wrap centre (Vector3), `time` drives the shimmer.
   */
  accumulate(camera, disp, center, time, cacheable = false) {
    this._ensureRT();
    const r = this.engine.renderer;
    const u = this.material.uniforms, p = this.params;
    u.tPrev.value = disp.prev.texture; u.tNext.value = disp.next.texture; u.uW.value = disp.w;
    u.uCenter.value.copy(center); u.uScale.value = p.scale; u.uShape.value = p.shape;
    u.uProj.value = this.accRT.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    u.uTime.value = time; u.uShimmer.value = p.shimmer; u.uGamma.value = p.gamma; u.uWarm.value = p.warm; u.uFog.value = p.fog; u.uSizeK.value = p.sizeK; u.uOverlap.value = p.overlap; u.uContrastK.value = p.contrastK; u.uFogNear.value = p.fogNear;
    const pxK = this.accRT.height / 720;
    u.uPxMax.value = Math.max(1.5, p.pxMax * pxK); u.uNear.value = p.near; u.uEarly.value = p.early; u.uDim.value = p.dim; u.uClampK.value = p.clampK;
    this.galMaterial.uniforms.uGal.value = p.galaxies ?? 1; this.galMaterial.uniforms.uPxK.value = this.accRT.height / 720;
    if (cacheable) {
      camera.updateMatrixWorld();
      const e = camera.matrixWorld.elements, f = camera.projectionMatrix.elements;
      const key = `${disp.prev.texture.id}|${disp.next.texture.id}|${disp.w.toFixed(5)}|${e.map((v) => v.toFixed(4)).join(',')}|${f[0].toFixed(4)},${f[5].toFixed(4)}|${center.x.toFixed(3)},${center.y.toFixed(3)},${center.z.toFixed(3)}|${JSON.stringify(p)}|${time.toFixed(2)}|${this.sim.version}`;
      if (key === this._key) return;
      this._key = key;
    } else this._key = '';
    const prevRT = r.getRenderTarget();
    const ac = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(this.accRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this.accScene, camera);
    r.autoClear = ac;
    r.setClearColor(0x000000, 1);
    r.setRenderTarget(prevRT);
  }

  dispose() {
    this.points.geometry.dispose(); this.material.dispose(); this.galaxies.geometry.dispose(); this.galMaterial.dispose(); this.compMat.dispose(); this.downMat.dispose(); this.blurMat.dispose(); this.accRT?.dispose(); for (const k of ['halfRT', 'halfTmp', 'quarterRT', 'quarterTmp']) this[k]?.dispose();
  }
}
