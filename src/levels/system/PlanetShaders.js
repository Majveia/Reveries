// GLSL for planets seen from space: rocky worlds (baked continents from the
// planet's own TerrainHeight + procedural detail, oceans with a broad sun
// glint, a weather layer with cyclones, climatological bands and cloud
// shadows, night-side city networks, lava, ice), gas giants (zonal jets,
// shear-zone turbulence, festoons, vortex storms), Chapman-style atmospheres,
// Saturn-like rings and moons.

export const RING_GLSL = /* glsl */`
float rHash(float x){ return fract(sin(x * 127.1) * 43758.5453); }
float rNoise(float x){ float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(rHash(i), rHash(i + 1.0), f); }
// Optical depth of a Saturn-like ring system at normalised radius x (0 inner … 1 outer).
float ringDensity(float x, float seed){
  if (x < 0.0 || x > 1.0) return 0.0;
  float d = 0.0;
  d += smoothstep(0.0, 0.05, x) * (0.10 + 0.16 * x / 0.25) * (1.0 - smoothstep(0.25, 0.27, x));  // C ring: faint, dusty
  d += smoothstep(0.255, 0.29, x) * (0.62 + 0.36 * smoothstep(0.32, 0.52, x)) * (1.0 - smoothstep(0.575, 0.592, x)); // B ring: dense
  d += smoothstep(0.64, 0.66, x) * (0.58 - 0.12 * smoothstep(0.8, 0.95, x)) * (1.0 - smoothstep(0.955, 0.965, x)); // A ring
  d += smoothstep(0.592, 0.6, x) * (1.0 - smoothstep(0.62, 0.64, x)) * 0.06;                       // dusty Cassini division
  d *= 1.0 - 0.92 * exp(-pow((x - 0.888) / 0.0035, 2.0));                                          // Encke gap
  d *= 1.0 - 0.7 * exp(-pow((x - 0.94) / 0.0012, 2.0));                                            // Keeler gap
  d += exp(-pow((x - 0.99) / 0.0028, 2.0)) * 0.5;                                                  // F ring
  // plateaus and ringlets at every scale
  float fine = 0.66 + 0.2 * rNoise(x * 70.0 + seed) + 0.16 * rNoise(x * 260.0 + seed * 3.0) + 0.1 * rNoise(x * 900.0 + seed) + 0.06 * rNoise(x * 2600.0);
  float plateau = 1.0 + 0.35 * smoothstep(0.55, 0.9, rNoise(x * 34.0 + seed * 7.0)) * step(x, 0.25);
  return clamp(d * fine * plateau, 0.0, 1.0);
}
`;

export const COMMON_GLSL = /* glsl */`
vec3 rotY(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z); }
vec3 rotAxis(vec3 v, vec3 k, float a){ float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }
// Bump mapping without tangents (Mikkelsen 2010)
vec3 bumpN(vec3 P, vec3 N, float h){
  vec3 dpdx = dFdx(P), dpdy = dFdy(P);
  float dhdx = dFdx(h), dhdy = dFdy(h);
  vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
  return normalize(abs(det) * N - grad);
}
float sat(float x){ return clamp(x, 0.0, 1.0); }
// shadow of a ring plane on a point P (light direction L)
float ringShadow(vec3 P, vec3 L, vec3 C, vec3 nR, float rIn, float rOut, float op, float seed){
  float dn = dot(L, nR);
  if (abs(dn) < 1e-4) return 1.0;
  float t = dot(C - P, nR) / dn;
  if (t <= 0.0) return 1.0;
  vec3 Q = P + L * t;
  float x = (length(Q - C) - rIn) / (rOut - rIn);
  float tau = ringDensity(x, seed) * op * 2.2;
  return exp(-tau / max(abs(dn), 0.08));
}
`;

export const PLANET_VERT = /* glsl */`
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;
void main(){
  vObj = position;
  vWN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0); vWP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// Rocky worlds. Defines: HAS_MAP, KIND_{TERRAN,DESERT,ICE,LAVA,JUNGLE,TOXIC,BARREN,EXOTIC,OCEAN}, HAS_OCEAN, HAS_RINGS, MOON
export const ROCKY_FRAG = /* glsl */`
uniform sampler2D uAlbedo; uniform sampler2D uData;
uniform vec3 uSun; uniform vec3 uCenter; uniform float uRadius; uniform float uTime; uniform float uSeed;
uniform vec3 uWater; uniform vec3 uShallow; uniform vec3 uAtmo; uniform vec3 uLights; uniform vec3 uCloudCol; uniform vec3 uLava;
uniform vec3 uG0; uniform vec3 uG1; uniform vec3 uG2; uniform vec3 uRock;
uniform float uCloudCover; uniform float uCiv; uniform float uAtmoDensity; uniform float uRelief; uniform int uOct;
uniform mat3 uSpin;  // object → world rotation
uniform vec3 uRingN; uniform float uRingIn, uRingOut, uRingOp, uRingSeed;
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;

vec2 eqUV(vec3 d){
  return vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
}
vec4 texEq(sampler2D t, vec3 d){
  vec2 uv = eqUV(d);
  // Tarini seam fix: pick the u parameterisation with the smaller derivative
  vec2 uv2 = vec2(fract(uv.x + 0.5) - 0.5, uv.y);
  vec2 dx = dFdx(uv), dy = dFdy(uv), dx2 = dFdx(uv2), dy2 = dFdy(uv2);
  if (abs(dx2.x) + abs(dy2.x) < abs(dx.x) + abs(dy.x)) { dx = dx2; dy = dy2; }
  return textureGrad(t, uv, dx, dy);
}

// Weather: domain-warped fbm, wound into cyclones, shaped by a climatology
// (wet ITCZ, dry subtropical highs, stormy mid-latitudes), eroded into cumulus.
float cloudField(vec3 d, int oct, bool detail){
  vec3 c = rotY(d, uTime * 0.0035);
  // cyclones: spiral the sampling space around a few lows (opposite spin per hemisphere)
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float la = (fi < 2.0 ? 1.0 : -1.0) * (0.55 + 0.35 * fract(uSeed * (0.37 + fi * 0.13)));
    float lo = fract(uSeed * 0.171 + fi * 0.29) * 6.2832 + uTime * 0.002;
    vec3 cc = vec3(cos(la) * cos(lo), sin(la), cos(la) * sin(lo));
    float r = length(c - cc) / 0.32;
    c = rotAxis(c, cc, sign(la) * 3.2 * exp(-r * r * 1.4) * (0.6 + 0.4 * r));
  }
  float lat = c.y, al = abs(lat);
  vec3 p = c * 2.6 + uSeed * 0.37;
  vec3 w = vec3(fbm(p * 1.1, 3), fbm(p * 1.1 + 5.2, 3), fbm(p * 1.1 + 9.7, 3));
  vec3 q = p + w * 0.75;
  q.y *= 1.6;                                   // zonal stretching: fronts lie along latitude circles
  float n1 = fbm(q * 1.2, oct);
  float clim = 0.14 * exp(-al * al / 0.006) - 0.2 * exp(-pow((al - 0.42) / 0.13, 2.0)) + 0.12 * exp(-pow((al - 0.8) / 0.14, 2.0));
  float base = n1 + clim + (uCloudCover - 0.55) * 0.6;
  float cov = sat((base + 0.02) * 2.6);
  if (detail) {
    float n2 = fbm(q * 4.2 + w * 1.4, 4);
    float n3 = fbm(q * 13.0 + w * 2.0, 3);
    // soft, graded density with texture inside the decks; billowy eroded margins
    cov = sat((base + 0.12 * n2 + 0.02) * 2.6);
    cov *= sat(0.62 + 0.55 * n2 + 0.3 * n3);
    vec2 cu = worley(q * 18.0);
    float cum = smoothstep(0.62, 0.1, cu.x);                // cumulus cells in the broken margins
    float margin = smoothstep(-0.2, 0.0, base) * (1.0 - smoothstep(0.0, 0.25, base));
    cov = max(cov, margin * cum * 0.55 * sat(0.6 + n3));
    // fibrous cirrus streaks drawn out by the jets
    float fib = fbm(vec3(q.x * 6.0, q.y * 20.0, q.z * 6.0) + w, 3);
    cov = max(cov, smoothstep(0.15, 0.5, fib) * smoothstep(-0.12, 0.15, base) * 0.3);
  }
  return cov;
}

void main(){
  vec3 d = normalize(vObj);
  vec3 sd = d * 1.0 + uSeed;
  float h; vec3 alb; float snow = 0.0; float cityPot = 0.0; float rough = 0.6;
  float detail = fbm(sd * 22.0, uOct);
  float micro = fbm(sd * 90.0, 3);
#ifdef HAS_MAP
  // domain-warp the lookup so texel-scale biome boundaries become organic
  vec3 dw = normalize(d + vec3(fbm(sd * 9.0, 3), fbm(sd * 9.0 + 4.0, 3), fbm(sd * 9.0 + 8.0, 3)) * 0.012 + vec3(detail, micro, -detail) * 0.004);
  vec4 A = texEq(uAlbedo, dw);
  vec4 D = texEq(uData, dw);
  h = (D.r - 0.5) * 2.8 + detail * 0.10 + micro * 0.03;
  snow = D.g; cityPot = D.b; rough = D.a;
  alb = A.rgb;
  // satellite-photo albedo: darker, richer land with macro variation
  alb *= 0.72 + 0.2 * smoothstep(-0.5, 0.5, fbm(sd * 5.0 + 11.0, 3)) + 0.1 * detail;
#else
  float cont = fbm(sd * 1.6, uOct) + 0.5 * fbm(sd * 4.0 + 3.0, 3) * 0.5;
  h = cont * 1.4 + detail * 0.25 + micro * 0.05;
  alb = mix(uG0, uG1, sat(0.5 + detail * 1.5));
  alb = mix(alb, uG2, sat(fbm(sd * 6.0 + 9.0, 3) * 2.0));
  alb = mix(alb, uRock, sat(h * 0.8));
#endif

  // --- kind-specific surface character ---------------------------------
  vec3 emis = vec3(0.0);
#if defined(KIND_DESERT) || defined(KIND_BARREN) || defined(MOON)
  // wind-carved dune seas / crater fields
  float dunes = sin(dot(d, vec3(140.0, 31.0, 90.0)) + detail * 22.0) * 0.5 + 0.5;
  alb *= 0.9 + 0.16 * dunes * smoothstep(-0.2, 0.3, -h + 0.3);
  vec2 cr = worley(sd * 9.0);
  vec2 cr2 = worley(sd * 23.0 + 3.0);
  h += (smoothstep(0.32, 0.12, cr.x) * -0.25 + smoothstep(0.34, 0.3, cr.x) * smoothstep(0.26, 0.31, cr.x) * 0.3) * 0.5;
  h += (smoothstep(0.3, 0.1, cr2.x) * -0.12 + smoothstep(0.33, 0.29, cr2.x) * smoothstep(0.25, 0.3, cr2.x) * 0.14) * 0.5;
  alb *= 1.0 + 0.12 * smoothstep(0.12, 0.0, cr.x);   // bright young ejecta
#endif
#ifdef KIND_LAVA
  float cracks = 1.0 - abs(snoise(sd * 14.0 + detail * 1.5));
  cracks = pow(sat(cracks), 30.0) + pow(sat(1.0 - abs(snoise(sd * 38.0))), 40.0) * 0.5;
  float low = smoothstep(0.35, -0.05, h);
  float pulse = 0.8 + 0.2 * sin(uTime * 0.6 + detail * 12.0);
  alb = mix(alb * 0.35, vec3(0.03, 0.025, 0.022), 0.6);
#ifdef MOON
  alb = mix(vec3(0.75, 0.62, 0.28), vec3(0.35, 0.2, 0.1), sat(0.5 + detail * 2.0));  // sulphur plains, Io-like
  emis += uLava * pow(sat(cracks), 3.0) * low * 0.25;
#else
  emis += uLava * (cracks * (0.3 + 1.6 * low) + low * smoothstep(-0.02, -0.3, h) * (0.3 + 0.7 * smoothstep(0.0, 0.6, micro))) * 1.6 * pulse;
#endif
#endif

  bool ocean = false;
#ifdef HAS_OCEAN
  ocean = h < 0.0;
#endif

  // --- lighting frame -----------------------------------------------------------
  vec3 Ng = normalize(vWN);
  vec3 L = normalize(-vWP);               // the star sits at the origin
  vec3 V = normalize(cameraPosition - vWP);
  float ndlG = dot(Ng, L);
#ifdef HAS_MAP
  float hb = ocean ? 0.0 : (detail * 0.6 + micro * 0.25) * (0.35 + rough) * (0.4 + sat(h * 2.0));
#else
  float hb = ocean ? 0.0 : h;
#endif
  vec3 N = bumpN(vWP, Ng, hb * uRelief);
  float ndl = max(dot(N, L), 0.0) * smoothstep(-0.12, 0.08, ndlG);
  float ndv = max(dot(Ng, V), 0.0);
  float tw = smoothstep(-0.25, 0.35, ndlG);   // twilight band
  // sunlight reddens as it grazes through the air at the terminator
  vec3 sunCol = uSun * mix(vec3(1.0, 0.45, 0.22), vec3(1.0), mix(1.0, smoothstep(-0.03, 0.14, ndlG), sat(uAtmoDensity * 1.5)));

  // --- weather (computed first: it shades the ground) ---------------------------
  float cloud = 0.0, cshadow = 1.0;
#ifndef MOON
  if (uCloudCover > 0.001) {
    cloud = cloudField(d, uOct, true);
    // cloud shadows: march toward the sun in object space
    vec3 Lo = transpose(uSpin) * L;
    float cs = cloudField(normalize(d + Lo * 0.012 / max(ndlG, 0.25)), 3, false);
    cshadow = 1.0 - cs * 0.6;
  }
#endif

  vec3 col;
  if (ocean) {
#if defined(KIND_ICE)
    // frozen sea: pack ice with pressure ridges and dark leads
    float leads = smoothstep(0.93, 0.99, 1.0 - abs(snoise(sd * 30.0 + detail)));
    vec3 ice = mix(vec3(0.62, 0.72, 0.8), vec3(0.85, 0.9, 0.95), sat(0.5 + detail));
    col = mix(ice, uWater * 0.4, leads * 0.8) * (sunCol * ndl);
#elif defined(KIND_LAVA)
    col = alb * sunCol * ndl;
#else
    float depth = sat(-h * 2.4);
    vec3 w = mix(uShallow, uWater * 0.55, sat(depth * 1.3 + 0.15));
    col = w * sunCol * max(ndlG, 0.0) * cshadow;
    // broad sunglint (wind-roughened sea, Cox-Munk-ish) + a hot core
    vec3 H = normalize(L + V);
    float nh = max(dot(Ng, H), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
    float glint = pow(nh, 90.0) * 6.0 + pow(nh, 900.0) * 30.0;
    glint *= 0.6 + 0.4 * smoothstep(-0.3, 0.4, micro);
    col += sunCol * glint * fres * 4.0 * smoothstep(0.0, 0.1, ndlG) * cshadow * (1.0 - cloud);
#endif
  } else {
    // snow on peaks & poles
    float sm = smoothstep(0.35, 0.75, snow + detail * 0.3 + micro * 0.12);
    alb = mix(alb, vec3(0.82, 0.86, 0.92), sm);
    alb *= 0.86 + 0.24 * (micro * 0.5 + 0.5) + 0.1 * detail;
    col = alb * sunCol * ndl * cshadow;
  }

  // --- clouds -------------------------------------------------------------------
#ifndef MOON
  if (cloud > 0.0) {
    float wrap = sat((ndlG + 0.04) / 1.04);
    vec3 cloudLit = uCloudCol * sunCol * (wrap * 0.75 + 0.25 * sqrt(wrap)) * (0.7 + 0.45 * sqrt(cloud)) * 1.1;
    col = mix(col, cloudLit, cloud * 0.95);
  }
#endif

  // --- night side: civilisation ------------------------------------------------
  float night = smoothstep(0.04, -0.16, ndlG);
#ifdef HAS_MAP
  if (uCiv > 0.5 && !ocean) {
    // metropolitan regions follow the habitable lowlands and coasts
    float region = smoothstep(0.3, 0.65, fbm(sd * 2.6 + 20.0, 3) + cityPot * 0.5 - 0.15) * smoothstep(0.05, 0.35, cityPot);
    float coast = smoothstep(0.25, 0.0, h);
    vec2 wc = worley(sd * 46.0);
    float cores = smoothstep(0.16, 0.0, wc.x);                                    // city cores
    float sprawl = smoothstep(0.42, 0.04, wc.x) * smoothstep(0.45, 0.85, snoise(sd * 320.0) * 0.5 + 0.5);
    float roads = smoothstep(0.025, 0.0, wc.y - wc.x) * smoothstep(0.7, 0.3, wc.x); // highways between cities
    vec2 wt = worley(sd * 170.0 + 7.0);
    float town = smoothstep(0.14, 0.0, wt.x) * smoothstep(0.2, 0.6, snoise(sd * 40.0) * 0.5 + 0.5); // scattered towns
    float lights = region * (cores * 2.2 + sprawl * 0.6 + roads * 0.45 + town * 0.7) * (0.45 + 0.55 * coast);
    lights *= (uCiv - 1.0) * 0.6;
    emis += uLights * lights * night * 2.2 * (1.0 - cloud * 0.85);
  }
#endif
  col += emis * (1.0 - cloud * 0.6);

  // --- ring shadow --------------------------------------------------------------
#ifdef HAS_RINGS
  col *= ringShadow(vWP, L, uCenter, uRingN, uRingIn, uRingOut, uRingOp, uRingSeed);
#endif

  // --- aerial perspective seen from orbit (Chapman-like path through the air) ----
#ifndef MOON
  float path = uAtmoDensity * 0.09 / max(ndv, 0.06);
  float haze = 1.0 - exp(-path);
  float lit = smoothstep(-0.22, 0.4, ndlG);
  vec3 air = uAtmo * uSun * lit * 1.1 + vec3(1.0, 0.4, 0.15) * uSun * exp(-pow((ndlG - 0.0) / 0.07, 2.0)) * 0.18 * uAtmoDensity;
  col = col * (1.0 - haze * 0.75) + air * haze;
#endif
  gl_FragColor = vec4(col, 1.0);
}`;

export const GAS_FRAG = /* glsl */`
uniform vec3 uSun; uniform vec3 uCenter; uniform float uTime; uniform float uSeed; uniform float uTurb;
uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uAtmo; uniform int uOct;
uniform vec4 uStorm[3]; uniform int uStorms;
uniform vec3 uRingN; uniform float uRingIn, uRingOut, uRingOp, uRingSeed;
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;

// zonal flow field: anisotropic turbulence, strongest in the shear zones between jets
float flow(vec3 s, float shear){
  vec3 a = vec3(s.x * 2.6, s.y * 13.0, s.z * 2.6) + uSeed;
  vec3 w = vec3(fbm(a * 0.8, 3), fbm(a * 0.8 + 4.1, 3), fbm(a * 0.8 + 7.7, 3));
  return fbm(a * 1.3 + w * (0.9 + 1.6 * shear) * uTurb * 2.0, uOct);
}
// band profile: one value per latitude (random-looking but smooth)
float prof(float y, float k, float s){ return snoise(vec2(y * k, s)); }

void main(){
  vec3 d = normalize(vObj);
  // vortex storms swirl the sampling space
  vec3 sd = d;
  for (int i = 0; i < 3; i++) {
    if (i >= uStorms) break;
    vec4 st = uStorm[i];
    vec3 c = vec3(cos(st.x) * cos(st.y), sin(st.x), cos(st.x) * sin(st.y));
    float r = length(d - c) / st.z;
    sd = rotAxis(sd, c, exp(-r * r * 1.6) * 5.0 * st.w);
  }
  float lat0 = sd.y;
  float jetv = sin(lat0 * 15.0 + uSeed) * 0.6 + sin(lat0 * 6.0 + 1.0) * 0.4;   // jet speed profile
  float shear = abs(cos(lat0 * 15.0 + uSeed));                                // shear between jets
  // differential rotation with a two-phase flow so shear never runs away
  float T = 120.0;
  float p1 = fract(uTime / T), p2 = fract(uTime / T + 0.5);
  float wgt = abs(p1 * 2.0 - 1.0);
  float j = jetv * 0.015;
  float n = mix(flow(rotY(sd, j * p1 * T), shear), flow(rotY(sd, j * p2 * T), shear), wgt);
  // latitude perturbed by the flow: band edges curl into festoons and eddies
  float y = lat0 + n * (0.008 + 0.02 * shear) * (0.5 + uTurb);
  float b1 = prof(y, 5.5, uSeed);
  float b2 = prof(y, 17.0, uSeed + 3.0);
  float b3 = prof(y, 48.0, uSeed + 7.0);
  float b4 = prof(y, 140.0, uSeed + 11.0);
  vec3 c0 = mix(vec3(dot(uC0, vec3(0.3, 0.5, 0.2))), uC0, 0.55);
  vec3 c1 = mix(vec3(dot(uC1, vec3(0.3, 0.5, 0.2))), uC1, 0.55);
  vec3 c2 = mix(vec3(dot(uC2, vec3(0.3, 0.5, 0.2))), uC2, 0.35);
  vec3 col = mix(c1 * 0.88, c0, smoothstep(-0.6, 0.6, b1 + 0.35 * b2));
  col = mix(col, c2, smoothstep(0.4, 0.95, b2 * 0.7 + b3 * 0.4) * 0.22);
  col *= 0.93 + 0.05 * b3 + 0.025 * b4;
  col *= 0.95 + 0.07 * n;
  // small bright convective spots and dark barges in the shear zones
  vec2 wv = worley(vec3(sd.x * 14.0, sd.y * 40.0, sd.z * 14.0) + uSeed + n * 0.6);
  col *= 1.0 + 0.12 * smoothstep(0.25, 0.0, wv.x) * shear * uTurb * 2.0;
  // storms: tinted ovals with bright collars
  for (int i = 0; i < 3; i++) {
    if (i >= uStorms) break;
    vec4 st = uStorm[i];
    vec3 c = vec3(cos(st.x) * cos(st.y), sin(st.x), cos(st.x) * sin(st.y));
    float r = length(d - c) / st.z;
    float core = smoothstep(1.0, 0.45, r + n * 0.15);
    vec3 sc = i == 0 ? vec3(0.75, 0.36, 0.2) : vec3(0.95, 0.92, 0.88);
    col = mix(col, sc * (0.8 + 0.3 * n), core * 0.7);
    col += vec3(0.2, 0.18, 0.16) * exp(-pow((r - 1.0) / 0.15, 2.0)) * 0.5;
  }
  // polar hoods: cooler, hazier, with a hint of a hexagonal jet
  float pole = smoothstep(0.7, 0.95, abs(d.y));
  col = mix(col, mix(col, uAtmo * 0.5 + col * 0.4, 0.5), pole);

  vec3 Ng = normalize(vWN);
  vec3 L = normalize(-vWP);
  vec3 V = normalize(cameraPosition - vWP);
  float ndlG = dot(Ng, L);
  float ndv = max(dot(Ng, V), 0.0);
  // deep atmosphere: soft terminator (light diffuses below the cloud deck)
  float diff = sat((ndlG + 0.08) / 1.08);
  diff = mix(diff * diff * (3.0 - 2.0 * diff), max(ndlG, 0.0), 0.6);
  vec3 sunC = uSun * mix(vec3(1.0, 0.62, 0.4), vec3(1.0), smoothstep(-0.02, 0.2, ndlG));
  vec3 c = col * sunC * diff;
  // limb darkening and a thin high haze on the lit limb
  c *= 0.5 + 0.5 * pow(ndv, 0.4);
  float rim = pow(1.0 - ndv, 5.0);
  c += uAtmo * uSun * rim * smoothstep(-0.1, 0.5, ndlG) * 0.22;
#ifdef HAS_RINGS
  c *= ringShadow(vWP, L, uCenter, uRingN, uRingIn, uRingOut, uRingOp, uRingSeed);
  // ringshine: sunlight scattered off the rings faintly lights the night side
  float rs = sat(abs(dot(Ng, uRingN))) * smoothstep(0.1, -0.3, ndlG);
  c += col * uSun * 0.012 * rs;
#endif
  gl_FragColor = vec4(c, 1.0);
}`;

// Thin atmosphere shell outside the planet: the limb glow. Column density along
// the camera ray from the Chapman approximation of an exponential atmosphere.
export const ATMO_FRAG = /* glsl */`
uniform vec3 uSun; uniform vec3 uCenter; uniform float uR; uniform float uRa; uniform vec3 uAtmo; uniform float uDensity;
varying vec3 vWP;
void main(){
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWP - ro);
  vec3 oc = uCenter - ro;
  float tc = dot(oc, rd);
  vec3 P = ro + rd * max(tc, 0.0);
  float hgt = length(P - uCenter);
  float Hs = (uRa - uR) * 0.22;
  float x = max(hgt - uR, 0.0);
  // optical depth ∝ exp(-x/H) · sqrt(2πRH)  (grazing column)
  float tau = exp(-x / Hs) * sqrt(6.2832 * uR * Hs) / Hs * 0.05 * uDensity;
  float hit = smoothstep(uR * 0.992, uR * 1.004, hgt);
  vec3 n = normalize(P - uCenter);
  vec3 L = normalize(-uCenter);
  float mu = dot(n, L);
  float lit = smoothstep(-0.3, 0.3, mu);
  float cosT = dot(rd, L);
  float phaseR = 0.75 * (1.0 + cosT * cosT);
  float g = 0.7;
  float phaseM = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5) * 0.08;
  vec3 ray = mix(vec3(1.0, 0.4, 0.15), uAtmo, smoothstep(-0.12, 0.3, mu));
  vec3 c = uSun * (ray * phaseR + vec3(1.0, 0.85, 0.7) * phaseM) * (1.0 - exp(-tau)) * lit * hit;
  // backlit ring of light at the terminator (sunlight through the limb)
  c += vec3(1.0, 0.45, 0.2) * uSun * phaseM * 2.0 * (1.0 - exp(-tau)) * smoothstep(0.25, -0.05, mu) * smoothstep(-0.35, -0.05, mu) * hit;
  gl_FragColor = vec4(c, 1.0);
}`;

export const RING_VERT = /* glsl */`
varying vec3 vWP; varying vec3 vLP;
void main(){ vLP = position; vec4 wp = modelMatrix * vec4(position, 1.0); vWP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;

export const RING_FRAG = /* glsl */`
uniform vec3 uSun; uniform vec3 uCenter; uniform float uPR; uniform float uIn, uOut, uOp, uSeed; uniform vec3 uCol; uniform vec3 uN;
varying vec3 vWP; varying vec3 vLP;
void main(){
  float r = length(vLP.xy);
  float x = (r - uIn) / (uOut - uIn);
  // filter ringlets finer than a pixel (avoid moiré)
  float fw = fwidth(x);
  float dens = ringDensity(x, uSeed);
  if (fw > 0.002) dens = mix(dens, (ringDensity(x - fw * 0.5, uSeed) + ringDensity(x + fw * 0.5, uSeed) + dens) / 3.0, 0.8);
  if (dens < 0.003) discard;
  vec3 L = normalize(-vWP);
  vec3 V = normalize(cameraPosition - vWP);
  float sl = dot(uN, L), sv = dot(uN, V);
  bool litSide = sl * sv > 0.0;
  float muL = max(abs(sl), 0.05), muV = max(abs(sv), 0.05);
  float tau = dens * uOp * 2.2;
  // albedo varies ring to ring: dusty brown C ring and Cassini division, bright icy B and A rings
  float tone = 0.8 + 0.3 * rNoise(x * 55.0 + uSeed) - 0.3 * (1.0 - smoothstep(0.22, 0.3, x));
  vec3 alb = uCol * tone * mix(vec3(0.78, 0.66, 0.54), vec3(1.0), smoothstep(0.2, 0.45, x));
  // slant opacity: rings look denser when seen edge-on
  float opV = 1.0 - exp(-tau / muV);
  // single scattering of a particulate layer (lit face) / diffuse transmission (unlit face)
  float I;
  if (litSide) I = 0.9 * muL / (muL + muV) * (1.0 - exp(-tau * (1.0 / muL + 1.0 / muV))) / max(opV, 1e-3);
  else {
    float dm = muL - muV;
    float tr = abs(dm) < 0.01 ? tau / muL * exp(-tau / muL) : muL / dm * (exp(-tau / muL) - exp(-tau / muV));
    I = 0.9 * tr / max(opV, 1e-3) * 0.7;
  }
  I = max(I, 0.0);
  // forward scattering by fine dust when looking toward the star (unlit side glows in thin rings)
  float cosT = dot(-V, L);
  float fwd = pow(max(cosT, 0.0), 12.0) * 3.0 * (1.0 - smoothstep(0.3, 0.8, dens));
  // planet shadow (soft penumbra)
  vec3 oc = uCenter - vWP;
  float tp = dot(oc, L);
  float dc = length(oc - L * tp);
  float sh = tp > 0.0 ? smoothstep(uPR * 0.985, uPR * 1.02, dc) : 1.0;
  vec3 c = alb * uSun * (I + fwd) * sh * 1.1;
  // planetshine on the rings from the day side of the giant (faint, warm)
  c += alb * uSun * 0.01 * (1.0 - sh);
  gl_FragColor = vec4(c * opV, opV);
}`;
