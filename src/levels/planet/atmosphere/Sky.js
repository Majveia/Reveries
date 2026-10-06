// Sky — everything beyond (and glowing within) the atmosphere.
//
// The dome renders *space radiance* (light arriving at the top of the
// atmosphere); the Atmosphere post effect then attenuates it by the true
// transmittance and adds in-scattering. So the sun disk reddens at sunset,
// stars fade near the horizon, a daytime moon turns pale — automatically.
//
//   • Galaxy band: baked once into an HDR cubemap by ray-marching a model of
//     the home barred spiral (exponential disk, log-spiral arms with the
//     catalog's pitch/arm count, bar, bulge, clumpy dust with reddening, HII
//     knots) from the star's real galactocentric position.
//   • Stars: per-pixel analytic star field (3 layers, power-law magnitudes,
//     blackbody colours, AA'd to the pixel footprint, density follows the band,
//     scintillation near the horizon).
//   • Sun: limb-darkened disk in the star's colour + faint inner corona.
//   • Moons (planet.moons): real 3D bodies with parallax, phase lighting,
//     procedural maria/craters/ice cracks/lava seams, planetshine.
//   • Other planets as bright wandering stars. Aurora curtains on aurora worlds.
//   • Rings (planet.rings): a lit, banded, planet-shadowed ring mesh.

import * as THREE from 'three';
import { AtmosphereModel, makeFullscreen } from './AtmosphereModel.js';
import { Celestial, MAX_MOONS, MAX_PLANETS } from './Celestial.js';
import { NOISE_GLSL } from '../../../core/glsl/noise.js';
import { FULLSCREEN_VERT } from '../../../core/glsl/common.js';

const CUBE_DIR_GLSL = /* glsl */ `
vec3 cubeFaceDir(int f, vec2 st){
  float sc = st.x * 2.0 - 1.0, tc = st.y * 2.0 - 1.0;
  if (f == 0) return normalize(vec3(1.0, -tc, -sc));
  if (f == 1) return normalize(vec3(-1.0, -tc, sc));
  if (f == 2) return normalize(vec3(sc, 1.0, tc));
  if (f == 3) return normalize(vec3(sc, -1.0, -tc));
  if (f == 4) return normalize(vec3(sc, -tc, 1.0));
  return normalize(vec3(-sc, -tc, -1.0));
}`;

const GALAXY_FRAG = /* glsl */ `
${NOISE_GLSL}
${CUBE_DIR_GLSL}
uniform int uFace; uniform float uSize;
uniform mat3 uCelToGal;
uniform vec3 uObs;
uniform float uRgal, uBar, uBarAngle, uPitch, uArms, uSF, uDustAmt, uBulge;
uniform vec3 uColCore, uColArms, uColHII;
uniform float uGain;
float armField(vec2 xz, float R){
  float th = atan(xz.y, xz.x);
  float k = 1.0 / tan(uPitch);
  float ph = uArms * (th - log(max(R, 0.3) / (uRgal * 0.12)) * k);
  float a = 0.5 + 0.5 * cos(ph);
  return a * a * a * smoothstep(uRgal * uBar * 0.6, uRgal * uBar * 1.1, R);
}
void main(){
  vec2 st = gl_FragCoord.xy / uSize;
  vec3 dc = cubeFaceDir(uFace, st);
  vec3 d = normalize(uCelToGal * dc);
  vec3 L = vec3(0.0), T = vec3(1.0);
  const int N = 48;
  float tMax = uRgal * 2.2;
  float prev = 0.0;
  float hR = uRgal * 0.28;
  float ca = cos(uBarAngle), sa = sin(uBarAngle);
  for (int i = 0; i < N; i++) {
    float a = (float(i) + 1.0) / float(N);
    float tn = tMax * a * a;
    float dt = tn - prev;
    float t = prev + 0.5 * dt;
    prev = tn;
    vec3 p = uObs + d * t;
    float R = length(p.xz);
    float z = abs(p.y);
    float disk = exp(-R / hR) * exp(-z / 0.28);
    float thin = exp(-R / hR) * exp(-z / 0.09);
    float arm = armField(p.xz, R);
    vec2 bp = vec2(ca * p.x + sa * p.z, -sa * p.x + ca * p.z);
    float bl = uBar * uRgal;
    float bar = uBar > 0.0 ? exp(-pow(bp.x / max(bl, 0.1), 2.0) - pow(bp.y / max(bl * 0.28, 0.1), 2.0) - pow(p.y / 0.35, 2.0)) : 0.0;
    float bulge = exp(-length(vec3(p.x, p.y * 1.7, p.z)) / (0.55 + uBulge));
    // clumpy structure: star clouds and dust filaments
    // clumps at a few hundred pc: star clouds and dust lanes read as fine structure, not giant blobs
    float n1 = snoise(p * 3.4), n2 = snoise(p * 9.5 + 3.1), n4 = snoise(p * 22.0 - 1.7);
    float n3 = n2 * 0.5 + 0.5 * sin(dot(p, vec3(19.1, 27.3, 23.7)) + n1 * 4.0);
    float clump = clamp(0.6 + 0.3 * n1 + 0.3 * n2 + 0.15 * n4, 0.0, 2.0);
    vec3 em = vec3(1.0, 0.86, 0.7) * disk * (0.35 + 1.4 * arm) * clump
            + uColArms * thin * arm * uSF * 1.6 * (0.6 + 0.6 * n2)
            + uColHII * thin * pow(arm, 2.0) * uSF * max(n3, 0.0) * 2.5
            + uColCore * (bar * 2.2 + bulge * 6.0);
    float dust = exp(-R / (hR * 1.25)) * exp(-z / 0.075) * (0.35 + 1.7 * arm) * clamp(0.55 + 0.45 * n1 + 0.6 * n2 + 0.45 * abs(n4) * 2.0 - 0.3, 0.0, 2.4);
    vec3 ext = uDustAmt * 9.0 * dust * vec3(0.66, 0.92, 1.3);
    vec3 st2 = exp(-ext * dt);
    vec3 ie = max(ext, vec3(1e-6));
    L += T * em * (1.0 - st2) / ie;
    T *= st2;
  }
  L *= uGain;
  // OLED: no veil away from the band
  float l = dot(L, vec3(0.2126, 0.7152, 0.0722));
  L *= smoothstep(0.0, 1.0, l / 0.0025);
  gl_FragColor = vec4(L, 1.0);
}`;

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const DOME_FRAG = /* glsl */ `
${NOISE_GLSL}
#define MAX_MOONS ${MAX_MOONS}
#define MAX_PLANETS ${MAX_PLANETS}
varying vec3 vDir;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunRadiance;
uniform vec3 uSunE;
uniform float uSunAngR;
uniform mat3 uWorldToCel;
uniform samplerCube tGalaxy;
uniform float uGalaxyGain;
uniform mat3 uCelToGal;
uniform float uSpace;
uniform float uStarVis;
uniform float uPixelAng;
uniform float uTime;
uniform float uPlanetR;
uniform float uAtmoTop;
uniform vec4 uMoonDir[MAX_MOONS];   // dir (world), angular radius
uniform vec4 uMoonCol[MAX_MOONS];   // colour, albedo
uniform vec4 uMoonInfo[MAX_MOONS];  // kind (0 barren,1 ice,2 lava), seed, planetshine, -
uniform int uMoonCount;
uniform vec4 uPlanetDir[MAX_PLANETS]; // dir (celestial), brightness
uniform vec3 uPlanetCol[MAX_PLANETS];
uniform int uPlanetCount;
uniform float uAurora;
uniform vec3 uAuroraA, uAuroraB;
uniform float uAuroraH0, uAuroraH1;

vec3 starColor(float h){
  // 3000K (orange) … 11000K (blue-white), weighted toward sun-like
  vec3 c1 = vec3(1.0, 0.62, 0.35), c2 = vec3(1.0, 0.88, 0.74), c3 = vec3(0.92, 0.95, 1.0), c4 = vec3(0.68, 0.78, 1.0);
  return h < 0.3 ? mix(c1, c2, h / 0.3) : h < 0.75 ? mix(c2, c3, (h - 0.3) / 0.45) : mix(c3, c4, (h - 0.75) / 0.25);
}

// One cell-hashed star layer. Fluxes follow a Euclidean power law
// N(>F) ∝ F^-1.5 (F = Fmin·u^-2/3): a handful of bright stars over a fine dust
// of faint ones. Energy is spread over the pixel footprint (resolution-stable).
vec3 starLayer(vec3 d, float scale, float seed, float density, float fmin, float fmax){
  vec3 p = d * scale;
  vec3 c = floor(p);
  vec3 h = hash33(c + seed);
  if (h.x > density) return vec3(0.0);
  vec3 j = hash33(c * 1.73 + seed + 11.3);
  vec3 sp = normalize(c + 0.2 + 0.6 * j) * scale;
  vec3 f = sp - c;
  if (any(lessThan(f, vec3(0.12))) || any(greaterThan(f, vec3(0.88)))) return vec3(0.0);
  vec3 sd = normalize(sp);
  float ang = length(d - sd);
  float sig = uPixelAng * 0.7;   // >= ~1.2 px footprint: survives upsampling and FXAA
  float u = max(h.y / max(density, 1e-3), 1e-4);
  float flux = min(fmin * pow(u, -0.6667), fmax);
  float g = exp(-ang * ang / (2.0 * sig * sig)) / (6.2831853 * sig * sig);
  // mostly white with a gentle B-V tint
  vec3 tint = mix(vec3(1.0), starColor(h.z), 0.45);
  return tint * flux * g * 1.25e-5;
}

vec3 moonSurface(vec3 n, int kind, float seed, vec3 tint, out vec3 emissive){
  emissive = vec3(0.0);
  vec3 q = n * 2.2 + seed;
  float maria = smoothstep(0.05, 0.45, fbm(q * 0.9, 4) * 0.6 + 0.2);
  // craters: worley pits with bright rims
  vec2 w1 = worley(n * 7.0 + seed), w2 = worley(n * 19.0 - seed);
  float crater = smoothstep(0.0, 0.35, w1.x) * 0.25 + 0.75;
  float rim = smoothstep(0.32, 0.4, w1.x) * (1.0 - smoothstep(0.4, 0.52, w1.x));
  float fine = 0.88 + 0.12 * smoothstep(0.0, 0.3, w2.x);
  float alb = mix(1.0, 0.55, maria) * crater * fine + rim * 0.18;
  // highlands keep the moon's tint, maria go cool grey-blue (basalt), not brown
  vec3 grey = vec3(dot(tint, vec3(0.3333)));
  vec3 col = mix(mix(tint, grey, 0.45) * 1.08, grey * vec3(0.8, 0.86, 0.98), maria) * alb;
  if (kind == 1) { // ice: bright with dark lineae
    float cracks = 1.0 - smoothstep(0.0, 0.06, abs(snoise(q * 2.5)) * (0.6 + 0.4 * snoise(q * 7.0)));
    col = mix(vec3(0.92, 0.95, 1.0), tint, 0.25) * (1.0 - cracks * 0.45) * (0.9 + 0.1 * crater);
  } else if (kind == 2) { // lava: dark crust, glowing seams
    float seam = 1.0 - smoothstep(0.0, 0.05, abs(snoise(q * 3.0)));
    col = vec3(0.16, 0.13, 0.12) * crater;
    emissive = vec3(1.0, 0.32, 0.06) * seam * 0.6;
  }
  return col;
}

void main(){
  vec3 rd = normalize(vDir);
  vec3 dc = uWorldToCel * rd;
  vec3 col = vec3(0.0);
  float occl = 1.0;

  // ---- moons (occlude what is behind them) ---------------------------------
  vec3 moonCol = vec3(0.0);
  for (int i = 0; i < MAX_MOONS; i++) {
    if (i >= uMoonCount) break;
    vec3 md = uMoonDir[i].xyz;
    float ar = uMoonDir[i].w;
    float cd = dot(rd, md);
    if (cd < cos(ar * 1.08)) continue;
    vec3 ax = normalize(cross(md, abs(md.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 ay = cross(ax, md);
    vec2 q = vec2(dot(rd, ax), dot(rd, ay)) / sin(ar);
    float rr = dot(q, q);
    float edge = 1.0 - smoothstep(1.0 - 2.5 * uPixelAng / ar, 1.0, sqrt(rr));
    if (edge <= 0.0) continue;
    vec3 n = q.x * ax + q.y * ay - sqrt(max(1.0 - rr, 0.0)) * md;
    vec3 nc = uWorldToCel * n;
    vec3 em;
    vec3 alb = moonSurface(nc, int(uMoonInfo[i].x), uMoonInfo[i].y, uMoonCol[i].rgb, em);
    float ndl = dot(n, uSunDir);
    // Lommel–Seeliger-ish (flat full moon) blended with Lambert
    float mu0 = max(ndl, 0.0), mu = max(dot(n, -md), 0.05);
    float ls = mu0 / (mu0 + mu) * 2.0;
    float lit = mix(mu0, ls, 0.55) * smoothstep(-0.02, 0.06, ndl);
    vec3 L = alb * uMoonCol[i].a * uSunE * (2.6 / 3.14159) * lit;
    // planetshine on the night side
    L += alb * uMoonInfo[i].z * (1.0 - smoothstep(-0.1, 0.2, ndl));
    L += em;
    moonCol = mix(moonCol, L, edge);
    occl *= 1.0 - edge;
  }

  // ---- moon aureole: forward-scattered moonlight in the air (the sky-view LUT
  // is too coarse for the tight Mie lobe); lunar halo ring on icy/hazy worlds
  for (int i = 0; i < MAX_MOONS; i++) {
    if (i >= uMoonCount || uSpace > 0.99) break;
    vec3 md = uMoonDir[i].xyz;
    float ar = uMoonDir[i].w;
    float th = acos(clamp(dot(rd, md), -1.0, 1.0));
    if (th > ar * 60.0) continue;
    float frac = 0.5 * (1.0 - dot(md, uSunDir));
    vec3 Lm = uMoonCol[i].rgb * uMoonCol[i].a * uSunE * 0.8 * frac * frac;
    float x = max(th - ar, 0.0);
    float glow = 0.14 * exp(-x / (ar * 1.4)) + 0.03 * exp(-x / (ar * 5.0)) + 0.006 * exp(-x / (ar * 20.0));
    col += Lm * glow * (1.0 - uSpace) * step(ar, th);
  }

  // ---- sun -----------------------------------------------------------------
  float cs = dot(rd, uSunDir);
  float th = acos(clamp(cs, -1.0, 1.0));
  if (th < uSunAngR * 1.6) {
    float x = clamp(th / uSunAngR, 0.0, 1.0);
    float mu = sqrt(max(1.0 - x * x, 0.0));
    float limb = 1.0 - 0.6 * (1.0 - mu) - 0.2 * (1.0 - mu) * (1.0 - mu);
    float disk = 1.0 - smoothstep(1.0 - 1.5 * uPixelAng / uSunAngR, 1.0, th / uSunAngR);
    col += uSunRadiance * limb * disk * occl;
  }
  // inner corona (visible from space and through thin air)
  // (from space only a tight 2-3 radius glow: the wide term would lift black space through bloom)
  col += uSunRadiance * (0.00035 * exp(-max(th - uSunAngR, 0.0) / (uSunAngR * mix(1.8, 0.9, uSpace))) + 0.000012 * (1.0 - uSpace) * exp(-max(th - uSunAngR, 0.0) / (uSunAngR * 9.0))) * occl;

  // ---- galaxy band + stars ------------------------------------------------
  if (uStarVis > 0.001) {
    vec3 gal = textureCube(tGalaxy, dc).rgb;
    float gl = dot(gal, vec3(0.333));
    // contrast curve: the diffuse disk glow we sit inside is cut to black (OLED),
    // the band, bulge and star clouds keep their structure; mostly neutral colour.
    // seen from inside the disk the band is mostly neutral starlight: warm only toward
    // the bulge, cool-white in the arms; contrast lives in the dust rifts, not the hue
    vec3 galD = mix(vec3(gl) * vec3(0.93, 0.96, 1.06), gal, 0.5) * uGalaxyGain * 0.7;
    float gd = gl * uGalaxyGain * 0.7;
    galD *= smoothstep(0.004, 0.04, gd) * clamp(gd / 0.04, 0.3, 1.5);
    // dust: coherent dark rifts hugging the mid-plane (Great-Rift-like) plus mottled
    // star clouds; smooth fBm lanes, anisotropic along the plane (no crackle veins)
    vec3 dg = uCelToGal * dc;
    float bandM = exp(-dg.y * dg.y / 0.02);
    if (bandM > 0.01) {
      vec3 fp = vec3(dg.x, dg.y * 3.0, dg.z);
      float lanes = snoise(fp * 4.0 + 1.7) * 0.55 + snoise(fp * 11.0 + vec3(5.1, 2.3, 8.7)) * 0.3 + snoise(fp * 27.0 - 3.3) * 0.15;
      float rift = smoothstep(-0.05, 0.55, lanes) * exp(-dg.y * dg.y / 0.004);
      float patchy = smoothstep(0.15, 0.7, snoise(fp * 18.0 + 9.1) * 0.6 + snoise(fp * 45.0) * 0.4) * 0.45;
      float mott = 0.75 + 0.5 * smoothstep(-0.5, 0.8, snoise(dc * 40.0) * 0.6 + snoise(dc * 110.0) * 0.4);
      float absorb = clamp(rift * 0.85 + patchy * (1.0 - rift), 0.0, 0.92);
      galD *= mix(1.0, (1.0 - absorb) * mott, bandM);
      // dust reddens what it does not block
      galD *= mix(vec3(1.0), vec3(1.08, 0.97, 0.86), absorb * bandM);
    }
    vec3 stars = vec3(0.0);
    // band density: faint stars crowd into the Milky Way, sparse elsewhere
    float dens = smoothstep(0.0, 1.0, gl * 90.0);
    stars += starLayer(dc, 70.0, 1.0, 0.42, 0.010, 6.0);               // naked-eye stars (~8k)
    stars += starLayer(dc, 190.0, 7.0, 0.10 + 0.55 * dens, 0.0035, 0.25); // faint field, clustered in the band
    stars += starLayer(dc, 420.0, 13.0, 0.03 + 0.5 * dens * dens, 0.0016, 0.05); // unresolved band grain
    // scintillation near the horizon
    vec3 up = normalize(uCamPos);
    float el = dot(rd, up);
    float tw = 1.0 + 0.45 * (1.0 - smoothstep(0.0, 0.5, el)) * sin(uTime * 23.0 + hash13(floor(dc * 420.0)) * 60.0);
    // planets
    vec3 pl = vec3(0.0);
    for (int i = 0; i < MAX_PLANETS; i++) {
      if (i >= uPlanetCount) break;
      float a = length(dc - uPlanetDir[i].xyz);
      float sig = uPixelAng * 0.8;
      pl += uPlanetCol[i] * uPlanetDir[i].w * exp(-a * a / (2.0 * sig * sig)) / (6.2831853 * sig * sig) * 2.5e-6;
    }
    col += (galD + stars * tw + pl) * uStarVis * occl;
  }

  // ---- aurora curtains --------------------------------------------------------
  if (uAurora > 0.001) {
    float r = length(uCamPos);
    vec3 up = uCamPos / r;
    vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), up));
    vec3 north = cross(up, east);
    // shells
    float R0 = uPlanetR + uAuroraH0, R1 = uPlanetR + uAuroraH1;
    float b = dot(uCamPos, rd);
    float c0 = r * r - R0 * R0, c1 = r * r - R1 * R1;
    float h0 = b * b - c0, h1 = b * b - c1;
    if (h1 > 0.0 && r < R1) {
      float tA = h0 > 0.0 && r > R0 ? -b - sqrt(h0) : (r < R0 ? -b + sqrt(max(h0, 0.0)) : 0.0);
      float tB = -b + sqrt(h1);
      tA = max(tA, 0.0);
      vec3 acc = vec3(0.0);
      const int AN = 28;
      float dt = (tB - tA) / float(AN);
      float j = hash12(gl_FragCoord.xy);
      for (int i = 0; i < AN; i++) {
        float t = tA + (float(i) + j) * dt;
        vec3 P = uCamPos + rd * t;
        float hgt = (length(P) - uPlanetR - uAuroraH0) / (uAuroraH1 - uAuroraH0);
        vec2 xz = vec2(dot(P - uCamPos, east), dot(P - uCamPos, north)) / 9000.0;
        // folded curtain lines
        float warp = snoise(vec2(xz.x * 0.35, uTime * 0.03)) * 1.6 + snoise(vec2(xz.x * 1.3 + 4.0, uTime * 0.07)) * 0.35;
        float line = abs(xz.y - 0.9 - warp);
        float curtain = exp(-line * line / 0.012) + 0.45 * exp(-pow(abs(xz.y + 0.6 - warp * 0.7), 2.0) / 0.02);
        float rays = 0.55 + 0.45 * snoise(vec2(xz.x * 22.0 + warp * 3.0, uTime * 0.25));
        float prof = smoothstep(0.0, 0.06, hgt) * exp(-hgt * 2.6);
        vec3 c = mix(uAuroraA, uAuroraB, smoothstep(0.15, 0.85, hgt));
        acc += c * curtain * rays * prof;
      }
      col += acc * dt / 9000.0 * uAurora * 0.012;
    }
  }

  col = col + moonCol;
  gl_FragColor = vec4(col, 1.0);
}`;

const RING_VERT = /* glsl */ `
varying vec3 vWorld;
varying float vR;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vR = length(position.xy);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const RING_FRAG = /* glsl */ `
${NOISE_GLSL}
varying vec3 vWorld;
varying float vR;
uniform float uInner, uOuter, uPlanetR, uOpacity;
uniform vec3 uColor, uSunDir, uSunE, uCamPos, uNormal;
void main(){
  float x = (vR - uInner) / (uOuter - uInner);
  float band = 0.55 + 0.25 * snoise(vec2(x * 38.0, 1.3)) + 0.15 * snoise(vec2(x * 160.0, 4.1)) + 0.08 * snoise(vec2(x * 600.0, 9.7));
  float gap = smoothstep(0.0, 0.02, abs(x - 0.62)) * smoothstep(0.0, 0.01, abs(x - 0.83));
  float edge = smoothstep(0.0, 0.03, x) * smoothstep(1.0, 0.94, x);
  float dens = clamp(band, 0.0, 1.0) * gap * edge;
  float alpha = clamp(dens * uOpacity, 0.0, 0.97);
  // planet shadow
  vec3 P = vWorld;
  float b = dot(P, uSunDir);
  float c = dot(P, P) - uPlanetR * uPlanetR;
  float shadow = (b < 0.0 && b * b - c > 0.0) ? 0.04 : 1.0;
  vec3 V = normalize(uCamPos - P);
  float cosA = dot(-V, uSunDir);
  float phase = 0.35 + 0.9 * pow(max(cosA, 0.0), 6.0) * (1.0 - alpha) + 0.25 * max(-cosA, 0.0);
  float lit = abs(dot(uNormal, uSunDir)) * 0.6 + 0.4;
  vec3 col = uColor * (0.75 + 0.5 * band) * uSunE * (1.0 / 3.14159) * phase * lit * shadow;
  gl_FragColor = vec4(col * alpha, alpha);
}`;

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

export default class Sky {
  static order = 80;
  constructor(level) {
    this.level = level;
    this.engine = level.engine;
    this.world = level.world;
    this.model = AtmosphereModel.get(level);
    this.celestial = level.celestial || (level.celestial = new Celestial(level));
    level.sky = this;
  }

  async init(progress) {
    let t0 = performance.now();
    await this.model.init();
    if (this.engine.debug) console.warn('[sky] luts ms', Math.round(performance.now() - t0));
    progress?.(0.3);
    t0 = performance.now();
    this._bakeGalaxy();
    if (this.engine.debug) { this.engine.renderer.getContext().finish(); console.warn('[sky] galaxy ms', Math.round(performance.now() - t0)); }
    progress?.(0.7);
    this._buildDome();
    if (this.level.planet.rings) this._buildRings();
    progress?.(1);
  }

  _bakeGalaxy() {
    const q = this.engine.quality;
    const size = this.engine.shotMode ? 1024 : q.pick(384, 512, 1024, 1536);
    const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    const cel = this.celestial, g = cel.galaxy;
    const obs = cel.starGal.clone();
    obs.y *= 0.06; // keep the band crisp (we sit near the mid-plane)
    const mat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: GALAXY_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        uFace: { value: 0 }, uSize: { value: size },
        uCelToGal: { value: cel.celToGal },
        uObs: { value: obs },
        uRgal: { value: g.radiusKpc }, uBar: { value: g.bar || 0 }, uBarAngle: { value: 0.45 },
        uPitch: { value: THREE.MathUtils.degToRad(g.pitch || 14) }, uArms: { value: g.arms || 2 },
        uSF: { value: g.starFormation ?? 0.7 }, uDustAmt: { value: g.dust ?? 0.7 }, uBulge: { value: g.bulge ?? 0.3 },
        uColCore: { value: new THREE.Vector3(...(g.colorCore || [1, 0.8, 0.6])) },
        uColArms: { value: new THREE.Vector3(...(g.colorArms || [0.7, 0.8, 1])) },
        uColHII: { value: new THREE.Vector3(...(g.colorHII || [1, 0.5, 0.6])) },
        uGain: { value: 0.075 },
      },
    });
    const fs = makeFullscreen();
    const r = this.engine.renderer;
    const prev = r.getRenderTarget();
    for (let f = 0; f < 6; f++) { mat.uniforms.uFace.value = f; fs.render(r, mat, rt, f); }
    r.setRenderTarget(prev);
    mat.dispose(); fs.dispose();
    this.galaxyRT = rt;
  }

  _buildDome() {
    const L = this.level, cel = this.celestial, m = this.model;
    const moonDir = [], moonCol = [], moonInfo = [], planetDir = [], planetCol = [];
    for (let i = 0; i < MAX_MOONS; i++) { moonDir.push(new THREE.Vector4()); moonCol.push(new THREE.Vector4()); moonInfo.push(new THREE.Vector4()); }
    for (let i = 0; i < MAX_PLANETS; i++) { planetDir.push(new THREE.Vector4()); planetCol.push(new THREE.Vector3()); }
    cel.planets.forEach((p, i) => { planetDir[i].set(p.cel.x, p.cel.y, p.cel.z, p.brightness); planetCol[i].set(p.color.r, p.color.g, p.color.b); });
    cel.moons.forEach((mo, i) => {
      moonCol[i].set(mo.color.r, mo.color.g, mo.color.b, mo.albedo);
      moonInfo[i].set(mo.kind === 'ice' ? 1 : mo.kind === 'lava' ? 2 : 0, (mo.seed % 997) * 0.37, 0, 0);
    });
    const A = L.aesthetic?.palette;
    const glow = A?.glow || ['#5affb0', '#8a7aff'];
    const thick = m.thickness;
    this.uniforms = {
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: this.world.sunDir },
      uSunRadiance: { value: new THREE.Vector3() },
      uSunE: { value: m.sunE },
      uSunAngR: { value: 0.0095 },
      uWorldToCel: { value: cel.worldToCel },
      tGalaxy: { value: this.galaxyRT.texture },
      uGalaxyGain: { value: 1 }, uCelToGal: { value: cel.celToGal }, uSpace: { value: 0 },
      uStarVis: { value: 0 },
      uPixelAng: { value: 0.001 },
      uTime: { value: 0 },
      uPlanetR: { value: m.Rb },
      uAtmoTop: { value: m.Rt },
      uMoonDir: { value: moonDir }, uMoonCol: { value: moonCol }, uMoonInfo: { value: moonInfo }, uMoonCount: { value: cel.moons.length },
      uPlanetDir: { value: planetDir }, uPlanetCol: { value: planetCol }, uPlanetCount: { value: cel.planets.length },
      uAurora: { value: 0 },
      uAuroraA: { value: new THREE.Color(glow[0]) }, uAuroraB: { value: new THREE.Color(glow[1] || '#8a7aff') },
      uAuroraH0: { value: thick * 0.55 }, uAuroraH1: { value: thick * 2.2 },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, uniforms: this.uniforms,
      side: THREE.BackSide, depthWrite: false, depthTest: false, toneMapped: false,
    });
    const geo = new THREE.SphereGeometry(1, 96, 48);
    this.dome = new THREE.Mesh(geo, mat);
    this.domeRadius = 5e5;
    this.dome.scale.setScalar(this.domeRadius);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.dome.onBeforeRender = (r, s, cam) => { this.dome.position.copy(cam.position); this.dome.updateMatrixWorld(); };
    if (!(this.engine.params.get('atmo') || '').includes('nodome')) L.scene.add(this.dome);
  }

  _buildRings() {
    const L = this.level, R = this.world.radius, rg = L.planet.rings;
    const inner = rg.inner * R, outer = rg.outer * R;
    const geo = new THREE.RingGeometry(inner, outer, 512, 8);
    const normal = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2 + (rg.tilt || 0) * 0.3).normalize();
    this.ringUniforms = {
      uInner: { value: inner }, uOuter: { value: outer }, uPlanetR: { value: R }, uOpacity: { value: rg.opacity ?? 0.7 },
      uColor: { value: new THREE.Vector3(...rg.color) }, uSunDir: { value: this.world.sunDir }, uSunE: { value: this.model.sunE },
      uCamPos: { value: new THREE.Vector3() }, uNormal: { value: normal },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: RING_VERT, fragmentShader: RING_FRAG, uniforms: this.ringUniforms,
      transparent: true, depthWrite: true, side: THREE.DoubleSide, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.rings = new THREE.Mesh(geo, mat);
    this.rings.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    this.rings.frustumCulled = false;
    L.scene.add(this.rings);
  }

  update(dt, t) {
    this.celestial.update(t);
  }

  lateUpdate(dt, t) {
    if (!this.uniforms) return;
    const L = this.level, cam = L.camera, cel = this.celestial, m = this.model, u = this.uniforms;
    cel.update(t);
    u.uCamPos.value.copy(cam.position);
    u.uTime.value = t;
    const H = this.engine.postfx?.height || innerHeight;
    u.uPixelAng.value = THREE.MathUtils.degToRad(cam.fov) / Math.max(1, H);
    // Sun disk radiance: illuminance spread over the (enlarged) disk, capped for
    // a hot core that blooms without blowing out the whole frame.
    const ar = u.uSunAngR.value;
    const rad = Math.min(m.sunE0 / (Math.PI * ar * ar), 4000);
    const sc = m.starColor;
    u.uSunRadiance.value.set(sc.r, sc.g, sc.b).multiplyScalar(rad);
    // moons
    cel.moons.forEach((mo, i) => {
      u.uMoonDir.value[i].set(mo.dir.x, mo.dir.y, mo.dir.z, mo.angRadius);
      // planetshine: the lit fraction of the planet seen from the moon
      const toPlanet = _v.copy(mo.pos).negate().normalize();
      const lit = 0.5 * (1 + toPlanet.dot(this.world.sunDir) * -1);
      u.uMoonInfo.value[i].z = 0.006 * lit;
    });
    // star visibility: night at the camera, or above the air
    const alt = cam.position.length() - m.Rb;
    const up = _v2.copy(cam.position).normalize();
    const sunEl = up.dot(this.world.sunDir);
    const night = 1 - THREE.MathUtils.smoothstep(sunEl, -0.16, 0.04);
    const space = m.present ? THREE.MathUtils.smoothstep(alt, m.thickness * 0.8, m.thickness * 2.0) : 1;
    u.uStarVis.value = Math.max(night, space);
    u.uGalaxyGain.value = this.galaxyGain ?? 0.6;
    u.uSpace.value = space;
    // aurora (weather decides)
    const ws = L.weatherState;
    u.uAurora.value = (ws?.aurora || 0) * night * (1 - space);
    if (this.ringUniforms) this.ringUniforms.uCamPos.value.copy(cam.position);
  }

  dispose() {
    this.galaxyRT?.dispose();
    this.dome?.geometry.dispose(); this.dome?.material.dispose();
    this.rings?.geometry.dispose(); this.rings?.material.dispose();
    this.model?.dispose?.();
  }
}
