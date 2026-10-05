// Ocean / lava-sea GLSL.
//
// Geometry: a camera-centred spherical cap (rings × segments) whose ring
// spacing grows geometrically with distance from the camera's nadir, out to
// just past the sea horizon — dense under the camera, sparse at the horizon,
// the whole visible disc from orbit. Vertices lie exactly on the sea sphere
// and are displaced by a directional Gerstner spectrum evaluated in the
// "anchor plane" (a tangent frame re-anchored as the camera travels, with
// phase continuity). Waves shorter than ~2 vertex spacings are filtered out
// in the vertex shader and live on in the per-pixel normals; waves shorter
// than the pixel footprint fold into GGX roughness (Toksvig-style), so the
// sun glint widens into a glitter path with distance and a broad sheen from
// orbit.
//
// Optics: sky reflection from the atmosphere's sky-view LUT (same radiance as
// the sky), Fresnel, GGX sun + moon glints, wave-crest subsurface scattering,
// depth-based absorption / transparency in the shallows from baked terrain
// height maps, Jacobian crest foam, surf bands and swash on beaches, seabed
// caustics, glitter sparkles. LAVA: cooling crust plates over HDR melt.
import { ATMO_PARS, ATMO_FUNCS, SKYVIEW_FUNCS } from '../atmosphere/AtmosphereModel.js';
import { COLOR_GLSL } from '../../../core/glsl/common.js';

export const NW = 16;

const COMMON = /* glsl */ `
#define NW ${NW}
uniform vec4 uWave[NW];      // dir.x, dir.z (anchor plane), k, amplitude
uniform float uPhase[NW];    // phase offset incl. −ωt (wrapped on the CPU)
uniform float uChop;
uniform float uRs;           // sea radius
uniform vec3 uAnchor, uT1, uT2;
uniform sampler2D tGlobal, tLocal;
uniform vec4 uLocal;         // local map: centre x, z, 1/span, valid
uniform float uTime;
uniform float uSwash;
uniform float uWaveScale;

uniform sampler2D tDetail;
uniform vec4 uSurf;          // breaker height (m), wavelength (m), angular speed (rad/s), on

vec2 localUV(vec2 xz){ return (xz - uLocal.xy) * uLocal.z + 0.5; }
float localMask(vec2 luv){
  if (uLocal.w < 0.5) return 0.0;
  vec2 e = smoothstep(vec2(0.0), vec2(0.08), luv) * smoothstep(vec2(0.0), vec2(0.08), 1.0 - luv);
  return e.x * e.y;
}
float terrainRel(vec3 dir, vec2 xz){
  float g = textureLod(tGlobal, vec2(atan(dir.x, dir.z) * 0.15915494 + 0.5, asin(clamp(dir.y, -1.0, 1.0)) * 0.31830989 + 0.5), 0.0).r;
  vec2 luv = localUV(xz);
  float m = localMask(luv);
  if (m > 0.0) return mix(g, textureLod(tLocal, luv, 0.0).r, m);
  return g;
}
float shoalFactor(float depth){ return smoothstep(-0.4, 6.0, depth) * (0.55 + 0.45 * smoothstep(6.0, 40.0, depth)); }

// ---- surf: breakers rolling up the beach along the distance-to-shore field ----
// Returns the breaker height (m). o = (dh/ds, crest lip foam, whitewater, breaking 0..1);
// g = unit gradient of the shore distance in the anchor plane (seaward).
float surf(vec2 xz, float depth, out vec4 o, out vec2 g){
  o = vec4(0.0); g = vec2(0.0);
  if (uSurf.w < 0.5) return 0.0;
  vec2 luv = localUV(xz);
  float m = localMask(luv);
  if (m <= 0.0) return 0.0;
  float s = textureLod(tLocal, luv, 0.0).g;
  if (s > 380.0 || s < -6.0) return 0.0;
  float e = 1.0 / float(textureSize(tLocal, 0).x);
  vec2 gg = vec2(textureLod(tLocal, luv + vec2(e, 0.0), 0.0).g - textureLod(tLocal, luv - vec2(e, 0.0), 0.0).g,
                 textureLod(tLocal, luv + vec2(0.0, e), 0.0).g - textureLod(tLocal, luv - vec2(0.0, e), 0.0).g);
  g = gg / max(length(gg), 1e-4);
  float nA = textureLod(tDetail, xz / 520.0 + vec2(0.17, 0.61), 0.0).a;
  float nB = textureLod(tDetail, xz / 190.0 + vec2(0.53, 0.29), 0.0).a;
  // waves slow and bunch up in the shallows (c = √(g·h))
  float lam = uSurf.y * (0.62 + 0.38 * smoothstep(0.0, 9.0, depth));
  float ph = s / lam * 6.2831853 + uSurf.z * uTime + nA * 6.0 + nB * 1.5;
  float u = fract(ph * 0.15915494);
  // sets: every few waves a bigger one; crests broken into segments along the shore
  float grp = 0.5 + 0.5 * sin(ph * 0.23 + nA * 7.0);
  float seg = smoothstep(0.18, 0.62, nB + 0.25 * sin(ph * 0.5));
  float A = uSurf.x * (0.45 + 0.75 * grp) * (0.35 + 0.65 * seg);
  A *= 0.55 + 0.8 * (1.0 - smoothstep(1.5, 12.0, depth));        // shoaling
  float db = 1.25 * A + 0.25;                                        // breaks at h ≈ 0.8 · depth
  float br = smoothstep(db * 1.6, db * 0.75, depth);
  A *= mix(1.0, 0.4, smoothstep(db * 0.7, -0.2, depth));             // bore decays up the beach
  A *= (1.0 - smoothstep(210.0, 360.0, s)) * smoothstep(-5.0, 0.5, s) * m;
  float uc = mix(0.34, 0.06, br);
  float h, dh;
  if (u < uc) { float x = u / uc; h = x * x * (3.0 - 2.0 * x); dh = 6.0 * x * (1.0 - x) / uc; }
  else { float t = (u - uc) / (1.0 - uc); float a = 1.0 - t; h = a * a * a * (1.0 + 3.0 * t); dh = -12.0 * t * a * a / (1.0 - uc); }
  float dc = u - uc;
  o.x = A * dh / lam;
  float lip = exp(-dc * dc / 0.0012) * smoothstep(0.2, 0.75, br) * smoothstep(0.15, 0.6, A);
  float white = br * (dc > 0.0 ? exp(-dc / 0.2) : exp(dc / 0.025) * smoothstep(0.6, 1.0, br));
  o.y = lip; o.z = white * smoothstep(0.05, 0.4, A); o.w = br * step(0.05, A);
  return A * (h - 0.33);
}
`;

export const OCEAN_VERT = /* glsl */ `
${COMMON}
uniform vec3 uCapU, uCapE, uCapN;
uniform float uCapD0, uCapDmax, uRings, uSegs;
varying vec3 vWorld;
varying vec2 vXZ;
varying vec3 vUp;
varying float vDepth;
varying float vSpacing;

void main(){
  float s = position.x, phi = position.y;
  float ratio = 1.0 + uCapDmax / uCapD0;
  float d = uCapD0 * (pow(ratio, s) - 1.0);
  float th = d / uRs;
  vec3 dir = normalize(uCapU * cos(th) + (uCapE * cos(phi) + uCapN * sin(phi)) * sin(th));
  vec3 P = dir * uRs;
  float dRad = uCapD0 * log(ratio) * pow(ratio, s) / uRings;
  float dLat = 6.2831853 * uRs * sin(max(th, 1e-6)) / uSegs;
  float spacing = max(dRad, dLat);
  vec3 rel = P - uAnchor;
  vec2 xz = vec2(dot(rel, uT1), dot(rel, uT2));
  float depth = -terrainRel(dir, xz);
  float amp = shoalFactor(depth) * (1.0 - smoothstep(0.82 * uCapDmax, uCapDmax, d)) * uWaveScale;
  vec3 disp = vec3(0.0);
  for (int i = 0; i < NW; i++) {
    vec4 w = uWave[i];
    float lam = 6.2831853 / w.z;
    float a = w.w * (1.0 - smoothstep(0.3, 0.55, spacing / lam));
    float t = w.z * dot(w.xy, xz) + uPhase[i];
    float c = cos(t), sn = sin(t);
    disp.xz += w.xy * (uChop * a * c);
    disp.y += a * sn;
  }
  disp *= amp;
  // breakers: height + the crest pitching forward toward the beach
  vec4 so; vec2 sg;
  float sh = surf(xz, depth, so, sg);
  disp.y += sh;
  disp.xz -= sg * max(sh, 0.0) * 0.55 * so.w;
  // swash: the sea breathes up and down the beach, out of phase along the shore
  float nearShore = 1.0 - smoothstep(0.5, 7.0, depth);
  disp.y += nearShore * uSwash * (0.55 * sin(uTime * 0.42 + xz.x * 0.021 + xz.y * 0.013) + 0.45 * sin(uTime * 0.27 - xz.y * 0.017 + 1.7));
  vec3 t1 = normalize(uT1 - dir * dot(uT1, dir));
  vec3 t2 = cross(t1, dir);
  vec3 W = P + t1 * disp.x + t2 * disp.z + dir * disp.y;
  vWorld = W; vXZ = xz; vUp = dir; vDepth = depth; vSpacing = spacing;
  gl_Position = projectionMatrix * viewMatrix * vec4(W, 1.0);
}
`;

export const OCEAN_FRAG = /* glsl */ `
${ATMO_PARS}
${ATMO_FUNCS}
${SKYVIEW_FUNCS}
${COLOR_GLSL}
${COMMON}
uniform sampler2D tPlates;
uniform vec4 uDetail;        // wind cos, sin, strength, time scroll
uniform float uPixelAngle;
uniform float uLutW;
uniform vec3 uSkyZenith, uSkyHorizon, uSkyIrr;
uniform vec3 uDeep, uShallow, uSSS, uAbsorb, uBed;
uniform float uMaxAmp;
uniform float uFoam;
uniform float uSparkle;
uniform float uUnder;
uniform vec4 uLava;          // plate scale, flow speed, heat, glow intensity
uniform sampler2D tSunVis;   // terrain's far sun-shadow depth map (headlands shade the bay)
uniform mat4 uSunVisM;
uniform float uSunVisOn;
uniform vec4 uSunVisParams;  // reversed, depth bias, normal offset
varying vec3 vWorld;
varying vec2 vXZ;
varying vec3 vUp;
varying float vDepth;
varying float vSpacing;

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }

vec3 skyRadiance(vec3 R, vec3 n0){
  float up = dot(R, n0);
  vec3 fb = mix(uSkyHorizon, uSkyZenith, pow(clamp(up, 0.0, 1.0), 0.45));
  if (uLutW <= 0.0) return fb;
  return mix(fb, skyViewLookup(R).rgb, uLutW);
}

float ggxD(float NH, float a){ float a2 = a * a; float d = NH * NH * (a2 - 1.0) + 1.0; return a2 / (3.14159265 * d * d + 1e-7); }
float visSmith(float NL, float NV, float a){ float k = a * 0.5; return 0.25 / ((NL * (1.0 - k) + k) * (NV * (1.0 - k) + k)); }
// incandescent melt radiance (linear, relative to 1300 K): blackbody hue; the
// visible output climbs ~T^8 across 700–1500 K, so the rims of a rift are blood
// red and its core white-gold
vec3 lavaRad(float T){
  vec3 c = blackbody(max(T, 1000.0));
  if (T < 1000.0) c = mix(vec3(1.0, 0.012, 0.0), c, smoothstep(700.0, 1000.0, T));
  return c * pow(max(T, 0.0) / 1300.0, 8.0);
}
float fresnel(float c, float f0){ return f0 + (1.0 - f0) * pow(1.0 - clamp(c, 0.0, 1.0), 5.0); }

uniform float uUseTrans;
float sunVis(vec3 P){
  if (uSunVisOn < 0.5) return 1.0;
  vec3 c = (uSunVisM * vec4(P, 1.0)).xyz;
  vec2 e = min(c.xy, 1.0 - c.xy);
  if (min(e.x, e.y) < 0.0) return 1.0;
  float edgeFade = smoothstep(0.0, 0.06, min(e.x, e.y));
  vec2 ts = 1.0 / vec2(textureSize(tSunVis, 0));
  float s = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    float dz = texture2D(tSunVis, c.xy + vec2(x, y) * ts * 1.5).r;
    s += uSunVisParams.x > 0.5 ? step(dz - uSunVisParams.y, c.z) : step(c.z - uSunVisParams.y, dz);
  }
  return mix(1.0, s / 9.0, edgeFade);
}
vec3 lightE(vec3 dir, vec3 E0, vec3 n0){
  if (uUseTrans < 0.5) return E0 * smoothstep(-0.04, 0.06, dot(n0, dir));
  return E0 * transmittanceToLight(uRb + 2.0, dot(n0, dir));
}

void main(){
  vec3 n0 = normalize(vUp);
  vec3 Vv = cameraPosition - vWorld;
  float dist = length(Vv);
  vec3 V = Vv / dist;
  bool below = uUnder > 0.5;
  float cosV = abs(dot(V, n0));
  float foot = dist * uPixelAngle / pow(max(cosV, 0.03), 0.35);

  float depth = -terrainRel(n0, vXZ);
  float shoal = shoalFactor(depth) * uWaveScale;

  // ---- wave spectrum: analytic Gerstner normal, Jacobian, filtered variance ----
  float sx = 0.0, sz = 0.0, sy = 0.0, jxx = 0.0, jzz = 0.0, jxz = 0.0, var = 0.0, hgt = 0.0;
  for (int i = 0; i < NW; i++) {
    vec4 w = uWave[i];
    float lam = 6.2831853 / w.z;
    float f = 1.0 - smoothstep(0.5, 1.4, foot * 2.0 / lam);
    float ka = w.z * w.w * shoal;
    var += (1.0 - f * f) * 0.5 * ka * ka;
    if (f <= 0.0) continue;
    float t = w.z * dot(w.xy, vXZ) + uPhase[i];
    float c = cos(t) * f, sn = sin(t) * f;
    sx += w.x * ka * c; sz += w.y * ka * c;
    sy += uChop * ka * sn;
    jxx += uChop * ka * sn * w.x * w.x;
    jzz += uChop * ka * sn * w.y * w.y;
    jxz += uChop * ka * sn * w.x * w.y;
    hgt += w.w * shoal * sin(t) * f;
  }
  float J = (1.0 - jxx) * (1.0 - jzz) - jxz * jxz;

  // ---- capillary detail (two scrolling layers rotated into the wind) ----
  mat2 rw = mat2(uDetail.x, uDetail.y, -uDetail.y, uDetail.x);
  vec2 pw = rw * vXZ;
  vec2 uv1 = pw / 7.3 + vec2(uDetail.w * 0.11, 0.0);
  vec2 uv2 = (mat2(0.8, 0.6, -0.6, 0.8) * pw) / 2.9 + vec2(uDetail.w * 0.23, uDetail.w * 0.05);
  vec4 d1 = texture2D(tDetail, uv1);
  vec4 d2 = texture2D(tDetail, uv2);
  float dk = uDetail.z * (0.35 + 0.65 * shoal);
  vec2 ds = ((d1.rg * 2.0 - 1.0) * 0.55 + (d2.rg * 2.0 - 1.0) * 0.4) * dk;
  float dfade = smoothstep(0.6, 6.0, foot);
  var += dfade * 0.09 * dk * dk;
  ds *= 1.0 - dfade * 0.85;
  ds = ds * rw; // back to anchor-plane axes

#ifdef LAVA
  // ===================== molten sea =====================
  // Rigid crust rafts drift on the melt (a lava lake's crust moves as plates,
  // tearing open along glowing rifts); hot regions and meandering channels
  // open into churning pools; radiance follows the melt temperature (∝ T^8 in
  // the visible), so rifts glow white-gold at the core and cool to blood red
  // at their rims, and the crust keeps a faint ember glow near every crack.
  vec3 t1 = normalize(uT1 - n0 * dot(uT1, n0));
  vec3 t2 = cross(t1, n0);
  vec2 wdir = vec2(uDetail.x, uDetail.y);
  vec2 drift = wdir * uTime * uLava.y;
  vec2 p = vXZ - drift;
  vec2 warp = vec2(texture2D(tDetail, vXZ / 330.0 + 0.31).a, texture2D(tDetail, vXZ / 290.0 + 0.77).a) - 0.5;
  vec2 q = p / uLava.x + warp * 0.22;
  vec4 plB = texture2D(tPlates, q * 0.31 + vec2(0.13, 0.71) + warp * 0.12);  // major rifts
  vec4 pl = texture2D(tPlates, q);                                         // plates
  vec4 pl2 = texture2D(tPlates, q * 3.1 + vec2(0.37, 0.61) + warp * 0.25); // rafts / crazing
  float aa = clamp(foot / uLava.x * 4.0, 0.0, 1.0);
  float open = smoothstep(0.3, 10.0, depth);
  // heat: a slow regional field + meandering channels sliding with the flow
  vec2 cp = (vXZ - drift * 2.2) / 1100.0 + warp * 0.1;
  float cn = texture2D(tDetail, cp).a * 0.65 + texture2D(tDetail, cp * 2.7 + 0.5).a * 0.35;
  float chan = pow(1.0 - abs(cn * 2.0 - 1.0), 9.0);
  float field = texture2D(tDetail, vXZ / 1500.0 + vec2(0.41, uTime * 0.0004)).a;
  float H = clamp((smoothstep(0.25, 0.85, field) * 0.75 + chan * 0.85) * open * uLava.z, 0.0, 1.0);
  // crack widths (in plate edge-distance units) open with heat
  float wB = mix(0.012, 0.2, H * H);
  float w1 = mix(0.0, 0.1, smoothstep(0.25, 1.0, H)) * (0.4 + 1.2 * pl.g);
  float w2 = mix(0.0, 0.08, smoothstep(0.55, 1.0, H));
  float cB = 1.0 - plB.r / max(wB, 1e-4);   // 1 at the rift centre, 0 at its rim
  float c1 = 1.0 - pl.r / max(w1, 1e-4);
  float c2 = 1.0 - pl2.r / max(w2, 1e-4);
  float core = max(max(cB, c1), c2 * 0.8);
  float molten = smoothstep(0.0, 0.25, core);
  // open pools: the crust breaks into small drifting rafts
  float pool = smoothstep(0.78, 0.95, H + 0.12 * (plB.g - 0.5));
  float raft = smoothstep(0.06, 0.13, pl2.r) * step(0.42, pl2.g) * (1.0 - smoothstep(0.9, 1.0, H));
  molten = max(molten, pool * (1.0 - raft));
  // churning melt: flow-mapped turbulence with darker cooling skins
  vec2 fv = wdir * uLava.y * 2.0 + (vec2(texture2D(tDetail, vXZ / 600.0).a, texture2D(tDetail, vXZ / 600.0 + 0.5).a) - 0.5) * uLava.y * 4.0;
  float f0 = fract(uTime / 24.0), f1 = fract(uTime / 24.0 + 0.5);
  float tw = abs(f0 * 2.0 - 1.0);
  float m0 = texture2D(tDetail, (vXZ - fv * f0 * 24.0) / 37.0).a, m1 = texture2D(tDetail, (vXZ - fv * f1 * 24.0) / 37.0 + 0.5).a;
  float churn = mix(m0, m1, tw);
  float churn2 = texture2D(tDetail, (vXZ - fv * 10.0) / 11.0 + uTime * 0.004).a;
  float skin = smoothstep(0.45, 0.7, churn * 0.7 + churn2 * 0.45) * (0.5 + 0.5 * pool);
  float Tm = mix(1050.0, 1420.0, clamp(max(core, pool) * 0.8 + H * 0.35, 0.0, 1.0)) - skin * 330.0 + (churn - 0.5) * 120.0;
  // far away the cracks shrink below a pixel: keep the mean radiance, not aliasing
  float cover = clamp(wB * 0.9 + w1 * 0.7 + w2 * 0.3 + pool * 0.8, 0.0, 1.0);
  molten = mix(molten, cover, aa);
  Tm = mix(Tm, mix(1080.0, 1300.0, H), aa);
  float seam = exp(-abs(depth - 0.12) * 6.0) * (0.25 + 0.75 * smoothstep(0.3, 0.7, pl2.a)) * 0.7;
  float pulse = 0.88 + 0.12 * sin(uTime * 0.7 + pl.g * 40.0 + plB.g * 13.0);
  vec3 emis = lavaRad(Tm) * uLava.w * pulse * molten + lavaRad(1250.0) * uLava.w * seam * (1.0 - molten);
  // crust: residual heat glows near the cracks, stronger over hot regions
  float nearC = max(max(exp(-plB.r / max(wB * 2.2 + 0.015, 0.02)), exp(-pl.r / max(w1 * 2.5 + 0.01, 0.02)) * step(0.001, w1)), pool * 0.6);
  // fine crazing on the crust stays faintly incandescent (texture on the plates)
  float craze = (1.0 - smoothstep(0.0, 0.05, pl2.r)) * (1.0 - aa);
  float Tc = 560.0 + 380.0 * nearC * (0.3 + 0.7 * H) + 60.0 * H + craze * (150.0 + 200.0 * H);
  vec3 crustGlow = lavaRad(Tc) * uLava.w * (1.0 - aa * 0.5);
  // crust surface: domed basalt plates, glassy where freshly chilled, ashen where old
  vec2 e = vec2(0.004, 0.0);
  float hb = pl.b;
  float gx = texture2D(tPlates, q + e.xy).b - hb, gz = texture2D(tPlates, q + e.yx).b - hb;
  vec2 rr = texture2D(tDetail, vXZ / 3.7).rg * 2.0 - 1.0;
  vec3 Nl = normalize(vec3(gx * 3.0 + rr.x * 0.25 * (1.0 - aa) - sx * 0.5, 1.0 - sy * 0.3, gz * 3.0 + rr.y * 0.25 * (1.0 - aa) - sz * 0.5));
  vec3 N = normalize(t1 * Nl.x + n0 * Nl.y + t2 * Nl.z);
  vec3 L = uSunDir;
  vec3 Es = lightE(L, uSunE, n0) * sunVis(vWorld);
  float NL = max(dot(N, L), 0.0), NV = max(dot(N, V), 0.02);
  vec3 H2 = normalize(L + V);
  float glassy = smoothstep(0.3, 0.9, nearC);
  float rough = mix(0.55, 0.18, glassy) + 0.15 * pl2.a;
  float ash = smoothstep(0.4, 0.9, pl.g * (1.0 - H)) * 0.6;
  vec3 albedo = mix(vec3(0.022, 0.019, 0.018), vec3(0.07, 0.062, 0.058), ash) * (0.7 + 0.6 * pl2.a);
  vec3 col = albedo * (Es * NL + uSkyIrr) / 3.14159;
  col += Es * ggxD(max(dot(N, H2), 0.0), rough) * visSmith(NL, NV, rough) * fresnel(dot(V, H2), 0.05) * NL;
  vec3 R = reflect(-V, N); R -= n0 * 2.0 * min(dot(R, n0), 0.0);
  col += skyRadiance(R, n0) * fresnel(NV, 0.045) * mix(0.25, 0.8, glassy);
  // the glowing sea reflected in the glassy crust: at grazing angles the
  // obsidian mirrors the incandescent horizon
  float hor = exp(-max(dot(R, n0), 0.0) * 9.0);
  float Fr = fresnel(NV, 0.05);
  col += lavaRad(1180.0) * uLava.w * (0.012 + 0.06 * hor) * Fr * mix(0.5, 1.0, glassy) * (0.4 + 0.6 * H + 0.4 * nearC);
  col += crustGlow;
  col = col * (1.0 - molten) + emis;
  gl_FragColor = vec4(col, 1.0);
  return;
#else
  // ===================== water =====================
  vec3 t1 = normalize(uT1 - n0 * dot(uT1, n0));
  vec3 t2 = cross(t1, n0);
  vec4 so; vec2 sg;
  float sh = surf(vXZ, depth, so, sg);
  float surfF = 1.0 - smoothstep(1.0, 6.0, foot);   // breaker detail fades into roughness far away
  sx += so.x * sg.x * surfF; sz += so.x * sg.y * surfF;
  var += (1.0 - surfF) * so.x * so.x * 0.5;
  vec3 Nl = normalize(vec3(-sx - ds.x, 1.0 - sy, -sz - ds.y));
  vec3 N = normalize(t1 * Nl.x + n0 * Nl.y + t2 * Nl.z);
  if (below) N = -N;
  vec3 nUp = below ? -n0 : n0;
  float rough = clamp(sqrt(0.0014 + var * 1.6), 0.035, 0.55);

  vec3 L = uSunDir;
  vec3 Es = lightE(L, uSunE, n0) * sunVis(vWorld);
  vec3 Em = lightE(uMoonDir, uMoonE, n0);
  float NV = max(dot(N, V), 0.001);

  if (below) {
    // looking up from under water: Snell's window, total internal reflection outside it
    float c = dot(V, -n0);
    float win = smoothstep(0.62, 0.7, NV);
    vec3 Rt = refract(-V, N, 1.333);
    vec3 skyT = skyRadiance(normalize(-Rt + n0 * 0.001), n0);
    vec3 deepU = uDeep * (uSkyIrr + Es * max(dot(n0, L), 0.0)) * 0.35;
    vec3 colB = mix(deepU, skyT * 0.85 + Es * pow(max(dot(-Rt, L), 0.0), 600.0) * 30.0, win);
    gl_FragColor = vec4(colB, 1.0);
    return;
  }

  vec3 R = reflect(-V, N);
  R -= n0 * 2.0 * min(dot(R, n0), 0.0);
  R = normalize(R + n0 * 0.02);
  float F = fresnel(NV, 0.02) * mix(1.0, 0.9, smoothstep(0.05, 0.4, rough));
  vec3 sky = skyRadiance(R, n0);

  // sun + moon glints (GGX, rough with distance)
  float NL = max(dot(N, L), 0.0);
  vec3 H = normalize(L + V);
  float aS = max(rough, 0.012);
  vec3 spec = Es * ggxD(max(dot(N, H), 0.0), aS) * visSmith(NL, NV, aS) * fresnel(dot(V, H), 0.02) * NL;
  vec3 Hm = normalize(uMoonDir + V);
  float NLm = max(dot(N, uMoonDir), 0.0);
  spec += Em * ggxD(max(dot(N, Hm), 0.0), aS) * visSmith(NLm, NV, aS) * fresnel(dot(V, Hm), 0.02) * NLm;
  // glitter: sparse micro-facets catching the sun near the camera
  if (uSparkle > 0.0 && dist < 400.0) {
    vec2 cell = floor(vXZ * 5.0);
    vec2 hh = hash22(cell + floor(uTime * 6.0 + hash12(cell) * 7.0));
    vec3 Ng = normalize(N + (t1 * (hh.x - 0.5) + t2 * (hh.y - 0.5)) * 0.32);
    float g = pow(max(dot(Ng, H), 0.0), 1800.0) * step(0.55, hash12(cell + 3.1));
    spec += Es * g * 14.0 * uSparkle * (1.0 - smoothstep(60.0, 400.0, dist)) * smoothstep(0.0, 0.2, NL);
  }

  // water body: upwelling light, crest SSS, depth absorption
  float sunUp = max(dot(n0, L), 0.0);
  vec3 Ein = Es * (0.25 + 0.75 * sunUp) + uSkyIrr + Em * 0.5;
  float cosT = sqrt(max(1.0 - (1.0 - NV * NV) / 1.777, 0.05));
  float path = max(depth, 0.0) / cosT;
  vec3 Tr = exp(-uAbsorb * path);
  float Tl = dot(Tr, vec3(0.2126, 0.7152, 0.0722));
  float shallowMix = exp(-max(depth, 0.0) * 0.3);
  vec3 bodyAlb = mix(uDeep, uShallow, shallowMix);
  // surf zone: churned, sediment-milky turquoise
  float turb = clamp(so.w * 0.7 + (1.0 - smoothstep(0.0, 3.5, depth)) * 0.25, 0.0, 1.0) * step(0.0, depth);
  bodyAlb = mix(bodyAlb, mix(uShallow * 1.6, uBed * 0.35, 0.35), turb * 0.6);
  vec3 body = bodyAlb * Ein / 3.14159 * (1.0 - Tr * 0.85);
  // subsurface scattering through backlit wave crests
  vec3 Lh = L - n0 * dot(L, n0); vec3 Vh = -V + n0 * dot(V, n0);
  float back = pow(max(dot(normalize(Lh + 1e-5), normalize(Vh + 1e-5)), 0.0), 3.0);
  float crest = clamp(hgt / max(uMaxAmp, 1e-3) * 0.6 + 0.45, 0.0, 1.0);
  float face = pow(1.0 - NV, 2.0) * 0.6 + 0.4;
  vec3 sss = uSSS * (Es * back * (1.0 - sunUp * 0.6) * crest * crest * face * 0.22 + uSkyIrr * crest * 0.08) * (1.0 - smoothstep(0.0, 1.0, foot * 0.02));
  // seabed caustics (added; the bed itself shows through the blend)
  float caus = 0.0;
  if (depth > 0.0 && Tl > 0.02) {
    vec2 cb = vXZ * 0.55;
    float c1 = texture2D(tDetail, cb + vec2(uTime * 0.031, uTime * 0.017)).b;
    float c2 = texture2D(tDetail, cb * 1.31 + vec2(-uTime * 0.023, uTime * 0.029)).b;
    caus = pow(c1 * c2 * 1.7, 2.5) * smoothstep(0.0, 0.6, depth) * (1.0 - smoothstep(4.0, 30.0, foot));
  }
  vec3 bedLight = uBed * Es * sunUp * Tr * Tr * caus * 0.9;

  // foam: Jacobian crests, surf lines, swash edge
  float fJ = smoothstep(uFoam, uFoam - 0.45, J);
  vec2 fuv = vXZ / 4.3 + vec2(uTime * 0.02, 0.0);
  float ft = texture2D(tDetail, fuv).b;
  float ft2 = texture2D(tDetail, vXZ / 13.0 - vec2(0.0, uTime * 0.012)).a;
  float crestFoam = fJ * smoothstep(0.15, 0.55, ft * (0.6 + 0.8 * ft2));
  float surfZone = 1.0 - smoothstep(0.6, 9.0, depth);
  float ph = depth * 1.15 + uTime * 0.9 + ft2 * 3.0;
  float band = pow(0.5 + 0.5 * sin(ph), 5.0) * surfZone * smoothstep(-0.6, 0.6, depth);
  float wash = (1.0 - smoothstep(0.0, 0.9, abs(depth - 0.1))) * 0.9;
  float shoreFoam = clamp((band * 1.2 + wash) * smoothstep(0.2, 0.75, ft + 0.15 * ft2) + wash * 0.35, 0.0, 1.0);
  // wind-blown streaks: crest foam smeared downwind
  float st = texture2D(tDetail, vec2(pw.x / 60.0 - uDetail.w * 0.004, pw.y / 5.5)).a;
  float streak = smoothstep(0.68, 0.86, st) * smoothstep(0.3, 0.7, ft) * 0.35 * smoothstep(0.85, 1.3, uWaveScale) * smoothstep(3.0, 20.0, depth);
  // breakers: a bright lip on the pitching crest, whitewater rolling behind it, lacy residue
  float lace = smoothstep(0.25, 0.75, ft * (0.55 + 0.9 * ft2));
  float ft3 = texture2D(tDetail, vXZ / 2.1 + vec2(0.0, uTime * 0.05)).b;
  float surfFoam = so.y * (0.75 + 0.25 * ft3) + so.z * smoothstep(0.1, 0.6, ft3 * 0.6 + ft * 0.6) + so.w * lace * 0.35;
  shoreFoam *= 1.0 - so.w * 0.5;
  float foam = clamp(crestFoam + shoreFoam + streak + surfFoam, 0.0, 1.0);
  foam *= 1.0 - smoothstep(0.5, 3.0, foot) * 0.6;
  vec3 foamCol = vec3(0.86) * (Es * max(dot(n0, L), 0.0) * (0.6 + 0.4 * max(dot(N, L), 0.0)) + uSkyIrr * 1.1 + Em * 0.4) / 3.14159;

  vec3 col = (body + sss + bedLight) * (1.0 - F) + sky * F + spec;
  float alpha = 1.0 - (1.0 - F) * Tl;
  col = mix(col, foamCol, foam);
  alpha = max(alpha, foam);
  // shoreline fade (no hard edge where the mesh slides under the sand)
  float fadeIn = smoothstep(-0.25, 0.25, depth + 0.35);
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0)) * fadeIn;
#endif
}
`;
