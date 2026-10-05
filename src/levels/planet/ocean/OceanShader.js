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

float terrainRel(vec3 dir, vec2 xz){
  float g = textureLod(tGlobal, vec2(atan(dir.x, dir.z) * 0.15915494 + 0.5, asin(clamp(dir.y, -1.0, 1.0)) * 0.31830989 + 0.5), 0.0).r;
  if (uLocal.w > 0.5) {
    vec2 luv = (xz - uLocal.xy) * uLocal.z + 0.5;
    vec2 e = smoothstep(vec2(0.0), vec2(0.08), luv) * smoothstep(vec2(0.0), vec2(0.08), 1.0 - luv);
    float m = e.x * e.y;
    if (m > 0.0) return mix(g, textureLod(tLocal, luv, 0.0).r, m);
  }
  return g;
}
float shoalFactor(float depth){ return smoothstep(-0.4, 6.0, depth) * (0.55 + 0.45 * smoothstep(6.0, 40.0, depth)); }
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
uniform sampler2D tDetail;
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
  vec3 t1 = normalize(uT1 - n0 * dot(uT1, n0));
  vec3 t2 = cross(t1, n0);
  vec2 flow = vec2(uDetail.x, uDetail.y) * uTime * uLava.y;
  vec2 p = vXZ - flow;
  vec2 warp = vec2(texture2D(tDetail, p / 260.0 + 0.31).a, texture2D(tDetail, p / 240.0 + 0.77).a) - 0.5;
  vec2 q = p / uLava.x + warp * 0.18;
  vec4 plB = texture2D(tPlates, q * 0.33 + vec2(0.13, 0.71) + warp * 0.1);   // major fractures
  vec4 pl = texture2D(tPlates, q);                                         // plates
  vec4 pl2 = texture2D(tPlates, q * 3.3 + vec2(0.37, 0.61) + warp * 0.2);  // fine crazing
  float aa = clamp(foot / uLava.x * 5.0, 0.0, 1.0);
  float open = smoothstep(0.5, 14.0, depth);
  // meandering molten channels: ridges of a warped low-frequency field, sliding with the flow
  vec2 cp = (vXZ - flow * 1.6) / 900.0 + warp * 0.12;
  float cn = texture2D(tDetail, cp).a * 0.65 + texture2D(tDetail, cp * 2.7 + 0.5).a * 0.35;
  float chan = pow(1.0 - abs(cn * 2.0 - 1.0), 7.0);
  float field = texture2D(tDetail, p / 700.0 + vec2(uTime * 0.0006, 0.0)).a;
  float heat = clamp((0.3 + 0.7 * open) * (0.5 + 0.8 * field + 0.9 * chan) * uLava.z, 0.0, 1.6);
  float hc = clamp(heat, 0.0, 1.0);
  float wB = mix(0.03, 0.12, hc), w1 = mix(0.012, 0.06, hc) * (0.6 + 0.8 * pl.g), w2 = 0.05;
  float crB = 1.0 - smoothstep(wB * 0.4, wB + 0.03, plB.r);
  float cr1 = 1.0 - smoothstep(w1 * 0.3, w1 + 0.02, pl.r);
  float cr2 = (1.0 - smoothstep(0.0, w2, pl2.r)) * smoothstep(0.35, 1.0, hc) * 0.45;
  float crack = max(max(crB, cr1), cr2);
  // keep the mean coverage stable as the cracks shrink below a pixel
  float cover = clamp(wB * 1.6 + w1 * 1.1 + 0.03 * hc, 0.0, 1.0);
  crack = mix(crack, cover, smoothstep(0.15, 0.9, aa));
  float halo = (exp(-plB.r / max(wB * 1.4, 0.01)) * 0.6 + exp(-pl.r / max(w1 * 1.6, 0.01)) * 0.4) * hc * (1.0 - aa * 0.7);
  float pool = smoothstep(0.55, 0.85, chan * (0.6 + 0.6 * field) + plB.g * 0.25) * open;
  float molten = clamp(max(crack, pool), 0.0, 1.0);
  float seam = exp(-abs(depth - 0.35) * 2.0) * 0.6;
  float temp = mix(900.0, 1500.0, clamp(molten * 0.55 + heat * 0.35 + pool * 0.3, 0.0, 1.0));
  float pulse = 0.82 + 0.18 * sin(uTime * 0.6 + pl.g * 40.0 + plB.g * 13.0);
  vec3 emis = blackbody(temp) * (molten * uLava.w * (0.45 + 0.75 * heat) * pulse + seam * uLava.w * 0.35);
  vec3 haloE = blackbody(950.0) * halo * uLava.w * 0.05;
  // crust: domed plates, glassy obsidian sheen
  vec2 e = vec2(0.004, 0.0);
  float hb = pl.b;
  float gx = texture2D(tPlates, q + e.xy).b - hb, gz = texture2D(tPlates, q + e.yx).b - hb;
  vec3 Nl = normalize(vec3(gx * 2.5 + (pl2.a - 0.5) * 0.3 - sx * 0.6, 1.0 - sy * 0.3, gz * 2.5 - sz * 0.6));
  vec3 N = normalize(t1 * Nl.x + n0 * Nl.y + t2 * Nl.z);
  vec3 L = uSunDir;
  vec3 Es = lightE(L, uSunE, n0) * sunVis(vWorld);
  float NL = max(dot(N, L), 0.0), NV = max(dot(N, V), 0.02);
  vec3 H = normalize(L + V);
  float rough = 0.32 + 0.25 * pl2.a;
  vec3 albedo = vec3(0.02, 0.018, 0.017) * (0.7 + 0.6 * pl.g);
  vec3 col = albedo * (Es * NL + uSkyIrr) / 3.14159;
  col += Es * ggxD(max(dot(N, H), 0.0), rough) * visSmith(NL, NV, rough) * fresnel(dot(V, H), 0.05) * NL;
  vec3 R = reflect(-V, N); R -= n0 * 2.0 * min(dot(R, n0), 0.0);
  col += skyRadiance(R, n0) * fresnel(NV, 0.04) * 0.6;
  // under-glow lighting the crust edges from below
  col += haloE;
  col = col * (1.0 - molten) + emis;
  gl_FragColor = vec4(col, 1.0);
  return;
#else
  // ===================== water =====================
  vec3 t1 = normalize(uT1 - n0 * dot(uT1, n0));
  vec3 t2 = cross(t1, n0);
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
  float foam = clamp(crestFoam + shoreFoam + streak, 0.0, 1.0);
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
