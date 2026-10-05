// AtmosphereModel — the physical atmosphere of one planet, shared by the sky,
// clouds, weather, the aerial-perspective post effect and the scene lighting.
//
// Technique: Hillaire 2020 ("A Scalable and Production Ready Sky and
// Atmosphere Rendering Technique") on top of Bruneton's transmittance
// parameterization:
//   • transmittance LUT (256×64)       T(r, μ) to the top of the atmosphere
//   • multiple-scattering LUT (32×32)  Ψms(r, μs) — infinite-order isotropic approximation
//   • sky-view LUT (192×108, per frame) radiance around the camera (sun + moon light)
//   • aerial-perspective froxels (32³ in a 1024×32 atlas, per frame) — in Atmosphere.js
//
// The planets of Reveries are small (22–70 km) with thick atmospheres (12 % of
// the radius), so densities are expressed as *visual optical depths* and
// scaled to the world: the sky looks Earth-like from the ground, the limb glows
// from orbit, and kilometres of air read like tens of kilometres on Earth —
// distant hills turn blue the way Crimson Desert's mountains do.
//
// Everything is in planet-centred world space, meters.  Light intensities are
// in the same arbitrary-but-consistent HDR units the renderer uses (the
// directional sun light at noon ≈ 3.4, so a white Lambertian surface ≈ 1).

import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../../core/glsl/common.js';

export const TRANS_W = 256, TRANS_H = 64, MS_SIZE = 32, SKY_W = 192, SKY_H = 108;
export const AP_SLICES = 32, AP_RES = 32; // froxel volume: 32×32 screen tiles × 32 depth slices

// Tunables (visual optical depths, vertical, at density 1).
const TAU_R = 0.46; // Rayleigh, channel weight 1.0 (Earth's blue ≈ 0.27 — slightly hazier, richer sunsets)
const TAU_O = 0.11; // ozone (green), scaled by the planet's life
export const SUN_E0 = 4.6; // sun illuminance at the top of the atmosphere

// ---------------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------------

/** Uniform declarations shared by every atmosphere-aware shader. */
export const ATMO_PARS = /* glsl */ `
#ifndef PI
#define PI 3.141592653589793
#endif
uniform float uRb;          // bottom (sea level) radius
uniform float uRt;          // top of the atmosphere
uniform vec3 uBetaR;        // Rayleigh scattering at h = 0
uniform vec3 uBetaMs;       // Mie scattering at h = 0
uniform vec3 uBetaMe;       // Mie extinction at h = 0
uniform vec3 uBetaO;        // ozone absorption at the layer peak
uniform vec4 uProfile;      // 1/HR, 1/HM, exp(-T/HR), exp(-T/HM)
uniform vec4 uProfile2;     // normR, normM, ozone centre, 1/ozone half width
uniform float uMieG;
uniform vec3 uGroundAlbedo;
uniform float uPenumbra;    // soft planet shadow (sin of angular size)
uniform vec3 uSunDir;       // world, towards the sun
uniform vec3 uSunE;         // sun illuminance at the top of the atmosphere (rgb)
uniform vec3 uMoonDir;
uniform vec3 uMoonE;        // brightest moon (night key light), rgb
uniform vec4 uFog;          // x: fog density at ground (1/m), y: 1/fog scale height, z: fog base radius offset, w: fog albedo
uniform vec3 uFogColor;     // fog / dust scattering colour (albedo per channel)
uniform sampler2D tTransmittance;
uniform sampler2D tMultiScat;
`;

/** Media, phase functions, LUT parameterisations, integration. Requires ATMO_PARS. */
export const ATMO_FUNCS = /* glsl */ `
float atmoSafeSqrt(float x){ return sqrt(max(x, 0.0)); }

// Distance from radius r along cos-zenith mu to the sphere of radius R (exit when outside->inside not handled).
float distToTopR(float r, float mu){
  float disc = (uRt - r) * (uRt + r) + r * r * mu * mu;
  return max(-r * mu + atmoSafeSqrt(disc), 0.0);
}
bool hitsGround(float r, float mu){
  return mu < 0.0 && r * r * mu * mu - (r - uRb) * (r + uRb) >= 0.0;
}
float distToGround(float r, float mu){
  float disc = r * r * mu * mu - (r - uRb) * (r + uRb);
  return max(-r * mu - atmoSafeSqrt(disc), 0.0);
}
// Generic ray / sphere: returns (tNear, tFar), tFar < 0 when missed.
vec2 raySphere(vec3 ro, vec3 rd, float R){
  float b = dot(ro, rd);
  float r = length(ro);
  float c = (r - R) * (r + R);
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

void atmoMedium(float r, out vec3 scatR, out vec3 scatM, out vec3 ext){
  float h = max(r - uRb, 0.0);
  float dR = max((exp(-h * uProfile.x) - uProfile.z) * uProfile2.x, 0.0);
  float dM = max((exp(-h * uProfile.y) - uProfile.w) * uProfile2.y, 0.0);
  float dO = max(1.0 - abs(h - uProfile2.z) * uProfile2.w, 0.0);
  scatR = uBetaR * dR;
  scatM = uBetaMs * dM;
  ext = scatR + uBetaMe * dM + uBetaO * dO;
  // Weather fog / dust: an extra low, dense layer (lit like Mie with its own albedo).
  if (uFog.x > 0.0) {
    float dF = uFog.x * exp(-max(h - uFog.z, 0.0) * uFog.y);
    scatM += uFogColor * dF * uFog.w;
    ext += vec3(dF);
  }
}

float phaseRayleigh(float c){ return 0.0596831 * (1.0 + c * c); }
float phaseMie(float c, float g){
  float g2 = g * g;
  float k = 0.1193662 * (1.0 - g2) / (2.0 + g2);
  return k * (1.0 + c * c) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}
float phaseHG(float c, float g){
  float g2 = g * g;
  return 0.0795775 * (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}

// Bruneton transmittance parameterisation.
vec2 transmittanceUV(float r, float mu){
  float H = atmoSafeSqrt((uRt - uRb) * (uRt + uRb));
  float rho = atmoSafeSqrt((r - uRb) * (r + uRb));
  float d = distToTopR(r, mu);
  float dmin = uRt - r, dmax = rho + H;
  float xmu = (d - dmin) / max(dmax - dmin, 1e-3);
  float xr = rho / H;
  return vec2(0.5 / ${TRANS_W}.0 + xmu * (1.0 - 1.0 / ${TRANS_W}.0), 0.5 / ${TRANS_H}.0 + xr * (1.0 - 1.0 / ${TRANS_H}.0));
}
vec3 atmoTransmittance(float r, float mu){
  r = clamp(r, uRb + 0.5, uRt);
  return texture2D(tTransmittance, transmittanceUV(r, mu)).rgb;
}
// Transmittance to a light (sun/moon) including the planet's soft shadow.
vec3 transmittanceToLight(float r, float mu){
  r = max(r, uRb + 0.5);
  float sinH = uRb / r;
  float cosH = -atmoSafeSqrt(1.0 - sinH * sinH);
  float vis = smoothstep(-sinH * uPenumbra, sinH * uPenumbra, mu - cosH);
  if (vis <= 0.0) return vec3(0.0);
  return atmoTransmittance(r, mu) * vis;
}
vec3 atmoMultiScat(float r, float mu){
  float x = clamp(mu * 0.5 + 0.5, 0.0, 1.0);
  float y = clamp((r - uRb) / (uRt - uRb), 0.0, 1.0);
  return texture2D(tMultiScat, vec2(0.5 / ${MS_SIZE}.0 + x * (1.0 - 1.0 / ${MS_SIZE}.0), 0.5 / ${MS_SIZE}.0 + y * (1.0 - 1.0 / ${MS_SIZE}.0))).rgb;
}

// Source term (in-scattered radiance per meter) at radius r / up vector, for both lights.
vec3 atmoSource(vec3 P, float r, vec3 sR, vec3 sM, float pRs, float pMs, float pRm, float pMm){
  vec3 up = P / r;
  vec3 S = vec3(0.0);
  vec3 sT = sR + sM;
  if (uSunE.r + uSunE.g + uSunE.b > 0.0) {
    float mu = dot(up, uSunDir);
    S += uSunE * (transmittanceToLight(r, mu) * (sR * pRs + sM * pMs) + atmoMultiScat(r, mu) * sT);
  }
  if (uMoonE.r + uMoonE.g + uMoonE.b > 0.0) {
    float mu = dot(up, uMoonDir);
    S += uMoonE * (transmittanceToLight(r, mu) * (sR * pRm + sM * pMm) + atmoMultiScat(r, mu) * sT);
  }
  return S;
}

// Integrate in-scattering along ro + rd*t, t in [t0, t1] with N steps.
// mode: 0 = quadratic (dense near t0), 1 = reversed quadratic (dense near t1), 2 = uniform.
void atmoIntegrate(vec3 ro, vec3 rd, float t0, float t1, int N, int mode, out vec3 L, out vec3 T){
  L = vec3(0.0); T = vec3(1.0);
  float seg = t1 - t0;
  if (seg <= 0.0) return;
  float cs = dot(rd, uSunDir), cm = dot(rd, uMoonDir);
  float pRs = phaseRayleigh(cs), pMs = phaseMie(cs, uMieG);
  float pRm = phaseRayleigh(cm), pMm = phaseMie(cm, uMieG);
  float fN = float(N);
  float prev = 0.0;
  for (int i = 0; i < 48; i++) {
    if (i >= N) break;
    float a = (float(i) + 1.0) / fN;
    float f = mode == 0 ? a * a : (mode == 1 ? 1.0 - (1.0 - a) * (1.0 - a) : a);
    float next = seg * f;
    float dt = next - prev;
    float t = t0 + prev + dt * (mode == 0 ? 0.3 : 0.5);
    prev = next;
    vec3 P = ro + rd * t;
    float r = length(P);
    vec3 sR, sM, ext;
    atmoMedium(r, sR, sM, ext);
    vec3 S = atmoSource(P, r, sR, sM, pRs, pMs, pRm, pMm);
    vec3 st = exp(-ext * dt);
    L += T * (S - S * st) / max(ext, vec3(1e-12));
    T *= st;
  }
}
`;

// Sky-view LUT mapping (shared by generation and lookup).
export const SKYVIEW_FUNCS = /* glsl */ `
uniform sampler2D tSkyView;
uniform mat3 uSkyFrame;   // columns: east, up, north at the camera
uniform float uSkyR;      // camera radius used for the LUT (clamped inside the atmosphere)
float skyHorizonZenith(float r){
  float cosB = atmoSafeSqrt((r - uRb) * (r + uRb)) / r;
  return PI - acos(clamp(cosB, -1.0, 1.0));
}
vec4 skyViewLookup(vec3 rd){
  vec3 l = transpose(uSkyFrame) * rd;
  float theta = acos(clamp(l.y, -1.0, 1.0));
  float phi = atan(l.z, l.x);
  float zh = skyHorizonZenith(uSkyR);
  float v = theta < zh ? 0.5 * (1.0 - atmoSafeSqrt(1.0 - theta / zh)) : 0.5 + 0.5 * atmoSafeSqrt((theta - zh) / (PI - zh));
  vec2 uv = vec2(phi / (2.0 * PI) + 0.5, 0.5 / ${SKY_H}.0 + v * (1.0 - 1.0 / ${SKY_H}.0));
  return texture2D(tSkyView, uv);
}
`;

const TRANS_FRAG = /* glsl */ `
${ATMO_PARS}
${ATMO_FUNCS}
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5) / vec2(${TRANS_W - 1}.0, ${TRANS_H - 1}.0);
  float H = atmoSafeSqrt((uRt - uRb) * (uRt + uRb));
  float rho = H * uv.y;
  float r = sqrt(rho * rho + uRb * uRb);
  float dmin = uRt - r, dmax = rho + H;
  float d = dmin + uv.x * (dmax - dmin);
  float mu = d <= 0.0 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
  float dist = distToTopR(r, mu);
  const int N = 48;
  vec3 od = vec3(0.0);
  float dt = dist / float(N);
  for (int i = 0; i < N; i++) {
    float t = (float(i) + 0.5) * dt;
    float rr = sqrt(r * r + t * t + 2.0 * r * mu * t);
    vec3 sR, sM, ext;
    atmoMedium(rr, sR, sM, ext);
    od += ext * dt;
  }
  gl_FragColor = vec4(exp(-od), 1.0);
}`;

const MS_FRAG = /* glsl */ `
${ATMO_PARS}
${ATMO_FUNCS}
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5) / vec2(${MS_SIZE - 1}.0);
  float muS = clamp(uv.x * 2.0 - 1.0, -1.0, 1.0);
  float r = clamp(uRb + uv.y * (uRt - uRb), uRb + 1.0, uRt - 1.0);
  vec3 sunDir = vec3(0.0, muS, atmoSafeSqrt(1.0 - muS * muS));
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 L2 = vec3(0.0), fms = vec3(0.0);
  const int SQ = 8;
  const int STEPS = 20;
  const float isoPhase = 0.0795775;
  for (int i = 0; i < SQ; i++) {
    for (int j = 0; j < SQ; j++) {
      float ra = (float(i) + 0.5) / float(SQ), rb = (float(j) + 0.5) / float(SQ);
      float th = 2.0 * PI * ra, ph = acos(1.0 - 2.0 * rb);
      vec3 rd = vec3(cos(th) * sin(ph), cos(ph), sin(th) * sin(ph));
      float mu = rd.y;
      bool g = hitsGround(r, mu);
      float tMax = g ? distToGround(r, mu) : distToTopR(r, mu);
      float dt = tMax / float(STEPS);
      vec3 T = vec3(1.0), L = vec3(0.0), F = vec3(0.0);
      for (int s = 0; s < STEPS; s++) {
        float t = (float(s) + 0.5) * dt;
        vec3 P = ro + rd * t;
        float rr = length(P);
        vec3 sR, sM, ext;
        atmoMedium(rr, sR, sM, ext);
        vec3 sc = sR + sM;
        vec3 st = exp(-ext * dt);
        vec3 Tl = transmittanceToLight(rr, dot(P / rr, sunDir));
        vec3 S = sc * Tl * isoPhase;
        vec3 ie = max(ext, vec3(1e-12));
        L += T * (S - S * st) / ie;
        F += T * (sc - sc * st) / ie;
        T *= st;
      }
      if (g) {
        vec3 P = ro + rd * tMax;
        vec3 n = normalize(P);
        float nl = max(dot(n, sunDir), 0.0);
        L += T * atmoTransmittance(uRb + 0.5, dot(n, sunDir)) * nl * uGroundAlbedo / PI;
      }
      L2 += L; fms += F;
    }
  }
  L2 /= float(SQ * SQ); fms /= float(SQ * SQ);
  gl_FragColor = vec4(L2 / max(vec3(1.0) - fms, vec3(1e-3)), 1.0);
}`;

const SKYVIEW_FRAG = /* glsl */ `
${ATMO_PARS}
${ATMO_FUNCS}
uniform mat3 uSkyFrame;
uniform float uSkyR;
uniform vec3 uNightGlow;   // airglow radiance near the horizon (night)
void main(){
  vec2 uv = (gl_FragCoord.xy - vec2(0.0, 0.5)) / vec2(${SKY_W}.0, ${SKY_H - 1}.0);
  float phi = (uv.x - 0.5) * 2.0 * PI + PI / ${SKY_W}.0;
  float r = uSkyR;
  float cosB = atmoSafeSqrt((r - uRb) * (r + uRb)) / r;
  float zh = PI - acos(clamp(cosB, -1.0, 1.0));
  float v = clamp(uv.y, 0.0, 1.0);
  float theta = v < 0.5 ? zh * (1.0 - (1.0 - 2.0 * v) * (1.0 - 2.0 * v)) : zh + (PI - zh) * (2.0 * v - 1.0) * (2.0 * v - 1.0);
  vec3 dl = vec3(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));
  vec3 rd = uSkyFrame * dl;
  vec3 ro = uSkyFrame[1] * r;
  float mu = cos(theta);
  bool g = hitsGround(r, mu);
  float tMax = g ? distToGround(r, mu) : distToTopR(r, mu);
  vec3 L, T;
  int N = int(clamp(18.0 + tMax / (uRt - uRb) * 4.0, 18.0, 32.0));
  atmoIntegrate(ro, rd, 0.0, tMax, N, g ? 2 : 0, L, T);
  // Night airglow: a faint emissive layer seen edge-on near the horizon.
  float el = max(0.0, 1.0 - abs(theta - zh + 0.04) * 2.2);
  L += uNightGlow * (0.25 + el * el * 1.5) * (g ? 0.4 : 1.0);
  gl_FragColor = vec4(L, dot(T, vec3(0.3333)));
}`;

// ---------------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------------

const mat = (frag, uniforms, extra = {}) => new THREE.ShaderMaterial({
  vertexShader: FULLSCREEN_VERT, fragmentShader: frag, uniforms,
  depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false, ...extra,
});

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

export class AtmosphereModel {
  /** One model per level, created by whichever atmosphere subsystem constructs first. */
  static get(level) {
    if (!level.atmoModel) level.atmoModel = new AtmosphereModel(level);
    return level.atmoModel;
  }

  constructor(level) {
    this.level = level;
    this.engine = level.engine;
    this.world = level.world;
    this.planet = level.planet;
    const w = this.world, P = this.planet, A = P.atmosphere || {};
    this.present = !!A.present && (A.density ?? 1) > 0.05;
    this.Rb = w.radius + (w.hasOcean ? w.seaLevel : 0);
    this.Rt = Math.max(w.atmosphereRadius, this.Rb + 1500);
    this.thickness = this.Rt - this.Rb;
    this.params = A;
    this.ready = false;
    this.lutDirty = true;
    this.weather = { fog: 0, fogHeight: 120, fogColor: new THREE.Color(1, 1, 1), dust: 0, overcast: 0 };

    // Light state (updated by Sky / Lighting each frame).
    this.sunDir = w.sunDir;
    this.moonDir = new THREE.Vector3(0, 1, 0);
    const sc = level.star?.color || [1, 1, 1];
    this.starColor = new THREE.Color(sc[0], sc[1], sc[2]);
    const flux = THREE.MathUtils.clamp(Math.pow((level.star?.lumSun ?? 1) / Math.max(0.05, (P.orbit?.a ?? 1) ** 2), 0.12), 0.7, 1.35);
    this.sunE0 = SUN_E0 * flux;
    this.sunE = new THREE.Vector3();
    this.moonE = new THREE.Vector3();
    this.nightFactor = 0; // 0 day … 1 deep night at the camera
    this.daySky = 1;

    const u = this.uniforms = {
      uRb: { value: this.Rb }, uRt: { value: this.Rt },
      uBetaR: { value: new THREE.Vector3() }, uBetaMs: { value: new THREE.Vector3() }, uBetaMe: { value: new THREE.Vector3() }, uBetaO: { value: new THREE.Vector3() },
      uProfile: { value: new THREE.Vector4() }, uProfile2: { value: new THREE.Vector4() },
      uMieG: { value: 0.8 }, uGroundAlbedo: { value: new THREE.Vector3(0.2, 0.2, 0.2) }, uPenumbra: { value: 0.035 },
      uSunDir: { value: this.sunDir }, uSunE: { value: this.sunE },
      uMoonDir: { value: this.moonDir }, uMoonE: { value: this.moonE },
      uFog: { value: new THREE.Vector4(0, 1 / 120, 0, 0.9) }, uFogColor: { value: new THREE.Vector3(1, 1, 1) },
      tTransmittance: { value: null }, tMultiScat: { value: null },
      tSkyView: { value: null }, uSkyFrame: { value: new THREE.Matrix3() }, uSkyR: { value: this.Rb + 2 },
      uNightGlow: { value: new THREE.Vector3() },
    };
    this._computeCoefficients();

    // Ground albedo (for multiple scattering and the bounce light).
    const pal = P.palette || w.palette;
    const g0 = new THREE.Color(pal?.ground?.[0] || '#6a6a5a');
    const water = new THREE.Color(pal?.water || '#20405a');
    const of = w.hasOcean ? THREE.MathUtils.clamp(P.world?.seaLevel ?? 0.3, 0, 0.9) : 0;
    this.groundAlbedo = new THREE.Color(g0.r, g0.g, g0.b).lerp(water.multiplyScalar(0.35), of);
    u.uGroundAlbedo.value.set(this.groundAlbedo.r, this.groundAlbedo.g, this.groundAlbedo.b);
  }

  _computeCoefficients() {
    const A = this.params;
    const T = this.thickness;
    const HR = 0.25 * T, HM = 0.085 * T;
    const topR = Math.exp(-T / HR), topM = Math.exp(-T / HM);
    const normR = 1 / (1 - topR), normM = 1 / (1 - topM);
    // Column integrals of the normalised density profiles.
    const col = (H, top, norm) => (H * (1 - top) - T * top) * norm;
    const colR = col(HR, topR, normR), colM = col(HM, topM, normM);
    this.HR = HR; this.HM = HM;
    this._prof = { HR, HM, topR, topM, normR, normM };
    const density = this.present ? (A.density ?? 1) : 0;
    const ray = A.rayleigh || [0.18, 0.42, 1.0];
    const u = this.uniforms;
    u.uBetaR.value.set(ray[0], ray[1], ray[2]).multiplyScalar(TAU_R * density / colR);
    // Mie: aerosols, haze. mieColor is the single-scattering albedo tint.
    const haze = A.haze ?? 0.3, mie = A.mie ?? 0.4;
    const w = this.weather;
    const tauM = (mie * (0.045 + 0.3 * haze) + w.dust * 0.35 + w.overcast * 0.08) * density;
    const mc = new THREE.Color(A.mieColor || '#ffffff');
    const mx = Math.max(mc.r, mc.g, mc.b, 1e-3);
    const ms = tauM / colM;
    u.uBetaMs.value.set(mc.r / mx, mc.g / mx, mc.b / mx).multiplyScalar(ms * 0.92);
    u.uBetaMe.value.set(ms, ms, ms);
    u.uMieG.value = THREE.MathUtils.clamp(0.82 - 0.1 * haze - 0.1 * w.dust, 0.55, 0.85);
    // Ozone (only where there is life to make it).
    const life = THREE.MathUtils.clamp(this.planet.life ?? 0.4, 0, 1);
    const oc = 0.45 * T, ow = 0.25 * T;
    u.uBetaO.value.set(0.65 / 1.881, 1.0, 0.085 / 1.881).multiplyScalar(TAU_O * density * (0.25 + 0.75 * life) / ow);
    u.uProfile.value.set(1 / HR, 1 / HM, topR, topM);
    u.uProfile2.value.set(normR, normM, oc, 1 / ow);
    // Weather fog layer.
    u.uFog.value.set(w.fog, 1 / Math.max(10, w.fogHeight), 0, 0.92);
    u.uFogColor.value.set(w.fogColor.r, w.fogColor.g, w.fogColor.b);
    // CPU copies for the light colour.
    this._cpu = {
      betaR: u.uBetaR.value.clone(), betaMe: ms, betaO: u.uBetaO.value.clone(), oc, ow,
      fog: w.fog, fogH: Math.max(10, w.fogHeight),
    };
  }

  /** Weather pushes fog/dust here; LUTs are rebuilt when it changes noticeably. */
  setWeather(state) {
    const w = this.weather;
    const changed = Math.abs((state.fog ?? 0) - w.fog) > w.fog * 0.04 + 1e-6 || Math.abs((state.dust ?? 0) - w.dust) > 0.01 || Math.abs((state.overcast ?? 0) - w.overcast) > 0.02
      || Math.abs((state.fogHeight ?? w.fogHeight) - w.fogHeight) > 2;
    w.fog = state.fog ?? 0; w.dust = state.dust ?? 0; w.overcast = state.overcast ?? 0; w.fogHeight = state.fogHeight ?? w.fogHeight;
    if (state.fogColor) w.fogColor.copy(state.fogColor);
    if (changed) { this._computeCoefficients(); this.lutDirty = true; }
  }

  // ---- GPU resources ------------------------------------------------------------
  init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      const hdr = (w, h, extra = {}) => new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        depthBuffer: false, generateMipmaps: false, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, ...extra,
      });
      this.transRT = hdr(TRANS_W, TRANS_H, { type: THREE.FloatType });
      this.msRT = hdr(MS_SIZE, MS_SIZE);
      this.skyRT = hdr(SKY_W, SKY_H, { wrapS: THREE.RepeatWrapping });
      this.uniforms.tTransmittance.value = this.transRT.texture;
      this.uniforms.tMultiScat.value = this.msRT.texture;
      this.uniforms.tSkyView.value = this.skyRT.texture;
      this.transMat = mat(TRANS_FRAG, this.uniforms);
      this.msMat = mat(MS_FRAG, this.uniforms);
      this.skyMat = mat(SKYVIEW_FRAG, this.uniforms);
      this._fs = makeFullscreen();
      this.buildLUTs();
      this.ready = true;
    })();
    return this._initPromise;
  }

  buildLUTs() {
    const r = this.engine.renderer;
    const prev = r.getRenderTarget();
    this._fs.render(r, this.transMat, this.transRT);
    this._fs.render(r, this.msMat, this.msRT);
    r.setRenderTarget(prev);
    this.lutDirty = false;
  }

  /** Per-frame: sky frame + sky-view LUT for the given camera position. */
  renderSkyView(camPos) {
    if (!this.ready) return;
    const r = this.engine.renderer;
    if (this.lutDirty) this.buildLUTs();
    const u = this.uniforms;
    const rr = THREE.MathUtils.clamp(camPos.length(), this.Rb + 2, this.Rt - 2);
    u.uSkyR.value = rr;
    const up = _v.copy(camPos).normalize();
    const ref = Math.abs(up.y) < 0.98 ? _v2.set(0, 1, 0) : _v2.set(1, 0, 0);
    const east = ref.clone().cross(up).normalize();
    const north = up.clone().cross(east).normalize();
    u.uSkyFrame.value.set(east.x, up.x, north.x, east.y, up.y, north.y, east.z, up.z, north.z);
    const prev = r.getRenderTarget();
    this._fs.render(r, this.skyMat, this.skyRT);
    r.setRenderTarget(prev);
  }

  /** Update light intensities (called by Sky/Lighting before rendering). */
  setLights({ sunVisible = 1, moonDir = null, moonE = 0, nightGlow = 0 }) {
    const c = this.starColor;
    this.sunE.set(c.r, c.g, c.b).multiplyScalar(this.sunE0 * sunVisible);
    if (moonDir) this.moonDir.copy(moonDir);
    const mc = this.moonColor || { r: 0.85, g: 0.9, b: 1.0 };
    this.moonE.set(mc.r, mc.g, mc.b).multiplyScalar(moonE);
    this.uniforms.uNightGlow.value.set(0.35, 0.55, 1.0).multiplyScalar(nightGlow);
  }

  // ---- CPU evaluation (light colours) --------------------------------------------
  /** Optical depth from pos along dir to the top of the atmosphere; returns rgb transmittance into out. */
  transmittance(pos, dir, out = new THREE.Vector3(), steps = 40) {
    if (!this.present) return out.set(1, 1, 1);
    const Rb = this.Rb, Rt = this.Rt;
    let r = pos.length();
    const p = _v.copy(pos);
    if (r < Rb + 0.5) { p.setLength(Rb + 0.5); r = Rb + 0.5; }
    const mu = p.dot(dir) / r;
    // planet shadow (soft)
    const sinH = Rb / r, cosH = -Math.sqrt(Math.max(0, 1 - sinH * sinH));
    const pen = this.uniforms.uPenumbra.value * sinH;
    const vis = smooth(-pen, pen, mu - cosH);
    if (vis <= 0) return out.set(0, 0, 0);
    if (r >= Rt && mu >= 0) return out.set(vis, vis, vis);
    const disc = (Rt - r) * (Rt + r) + r * r * mu * mu;
    const dist = Math.max(0, -r * mu + Math.sqrt(Math.max(0, disc)));
    const dt = dist / steps;
    const pr = this._prof, cp = this._cpu;
    let odR = 0, odM = 0, odO = 0, odF = 0;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) * dt;
      const rr = Math.sqrt(r * r + t * t + 2 * r * mu * t);
      const h = Math.max(0, rr - Rb);
      odR += Math.max(0, (Math.exp(-h / pr.HR) - pr.topR) * pr.normR) * dt;
      odM += Math.max(0, (Math.exp(-h / pr.HM) - pr.topM) * pr.normM) * dt;
      odO += Math.max(0, 1 - Math.abs(h - cp.oc) / cp.ow) * dt;
      if (cp.fog > 0) odF += cp.fog * Math.exp(-h / cp.fogH) * dt;
    }
    const bR = cp.betaR, bO = cp.betaO;
    out.set(
      Math.exp(-(bR.x * odR + cp.betaMe * odM + bO.x * odO + odF)),
      Math.exp(-(bR.y * odR + cp.betaMe * odM + bO.y * odO + odF)),
      Math.exp(-(bR.z * odR + cp.betaMe * odM + bO.z * odO + odF)),
    ).multiplyScalar(vis);
    return out;
  }

  dispose() {
    for (const t of [this.transRT, this.msRT, this.skyRT]) t?.dispose();
    for (const m of [this.transMat, this.msMat, this.skyMat]) m?.dispose();
    this._fs?.dispose();
  }
}

function smooth(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

/** Minimal fullscreen-triangle renderer (independent of PostFX). */
export function makeFullscreen() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const mesh = new THREE.Mesh(g, null);
  mesh.frustumCulled = false;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return {
    mesh, camera,
    render(renderer, material, target, layer = 0) {
      mesh.material = material;
      renderer.setRenderTarget(target, layer);
      renderer.render(mesh, camera);
    },
    dispose() { g.dispose(); },
  };
}

export { mat as fullscreenMaterial };
