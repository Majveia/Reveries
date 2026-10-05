// GLSL for planets seen from space: rocky worlds (baked continents from the
// planet's own TerrainHeight + procedural detail, oceans with sun glint,
// animated weather, night-side city networks, lava, ice), gas giants (zonal
// jets, turbulent flow, vortex storms), atmospheres, rings and moons.

export const RING_GLSL = /* glsl */`
float rHash(float x){ return fract(sin(x * 127.1) * 43758.5453); }
float rNoise(float x){ float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(rHash(i), rHash(i + 1.0), f); }
// Optical density of a Saturn-like ring system at normalised radius x (0 inner … 1 outer).
float ringDensity(float x, float seed){
  if (x < 0.0 || x > 1.0) return 0.0;
  float d = 0.0;
  d += smoothstep(0.0, 0.04, x) * (0.16 + 0.12 * x / 0.25) * (1.0 - smoothstep(0.24, 0.27, x));    // C ring (faint)
  d += smoothstep(0.24, 0.28, x) * (0.72 + 0.25 * smoothstep(0.3, 0.55, x)) * (1.0 - smoothstep(0.585, 0.6, x)); // B ring (dense)
  d += smoothstep(0.645, 0.665, x) * 0.62 * (1.0 - smoothstep(0.955, 0.97, x));                   // A ring
  d *= 1.0 - 0.9 * exp(-pow((x - 0.885) / 0.0045, 2.0));                                          // Encke gap
  d *= 1.0 - 0.5 * exp(-pow((x - 0.62) / 0.012, 2.0));                                            // inside Cassini division
  d += exp(-pow((x - 0.993) / 0.0035, 2.0)) * 0.55;                                               // F ring
  float fine = 0.62 + 0.24 * rNoise(x * 90.0 + seed) + 0.18 * rNoise(x * 420.0 + seed * 3.0) + 0.12 * rNoise(x * 1500.0 + seed);
  return clamp(d * fine, 0.0, 1.0);
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
  return 1.0 - ringDensity(x, seed) * op * 0.92;
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
uniform mat3 uSpin;  // object → world rotation (for cloud drift independent of spin)
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

void main(){
  vec3 d = normalize(vObj);
  vec3 sd = d * 1.0 + uSeed;
  float h; vec3 alb; float snow = 0.0; float cityPot = 0.0; float rough = 0.6;
  float detail = fbm(sd * 22.0, uOct);
  float micro = fbm(sd * 90.0, 3);
#ifdef HAS_MAP
  // domain-warp the lookup so texel-scale biome boundaries become organic
  vec3 dw = normalize(d + vec3(detail, micro, fbm(sd * 31.0 + 5.0, 2)) * 0.007);
  vec4 A = texEq(uAlbedo, dw);
  vec4 D = texEq(uData, dw);
  h = (D.r - 0.5) * 2.8 + detail * 0.10 + micro * 0.03;
  snow = D.g; cityPot = D.b; rough = D.a;
  alb = A.rgb;
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
  float crater = smoothstep(0.05, 0.0, cr.x - 0.08) - smoothstep(0.16, 0.10, cr.x) * 0.0;
  h += (smoothstep(0.32, 0.12, cr.x) * -0.25 + smoothstep(0.34, 0.3, cr.x) * smoothstep(0.26, 0.31, cr.x) * 0.25) * 0.5;
  alb *= 1.0 - crater * 0.1;
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
  vec3 sunCol = uSun * mix(vec3(1.0, 0.5, 0.28), vec3(1.0), smoothstep(-0.06, 0.14, ndlG));

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
    vec3 w = mix(uShallow, uWater, sat(depth * 1.3 + 0.15));
    col = w * sunCol * ndl;
    vec3 H = normalize(L + V);
    float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
    float glint = pow(max(dot(Ng, H), 0.0), 220.0) * 18.0 + pow(max(dot(Ng, H), 0.0), 24.0) * 0.35;
    col += sunCol * glint * smoothstep(0.0, 0.15, ndlG) * (0.3 + fres);
    col += uAtmo * fres * 0.5 * tw * uAtmoDensity;
#endif
  } else {
    // snow on peaks & poles
    float sm = smoothstep(0.4, 0.62, snow + detail * 0.35 + micro * 0.15);
    alb = mix(alb, vec3(0.86, 0.9, 0.95), sm);
    alb *= 0.82 + 0.3 * (micro * 0.5 + 0.5) + 0.12 * detail;
    col = alb * sunCol * ndl;
  }

  // --- weather ------------------------------------------------------------------
  float cloud = 0.0;
#ifndef MOON
  if (uCloudCover > 0.001) {
    vec3 cw = d;                       // clouds co-rotate, plus their own slow drift
    cw = rotY(cw, uTime * 0.004);
    float lat = cw.y;
    vec3 cp = cw * 2.2 + uSeed * 0.37;
    vec3 warp = vec3(fbm(cp * 1.4, 3), fbm(cp * 1.4 + 5.2, 3), fbm(cp * 1.4 + 9.7, 3));
    float n = fbm(cp * 2.0 + warp * 1.1 + vec3(uTime * 0.003, 0.0, 0.0), uOct);
    float det = fbm(cp * 11.0 + warp * 2.5, 3);
    n += 0.3 * det;
    float bands = 0.12 * cos(lat * 9.0) + 0.1 * smoothstep(0.75, 0.95, abs(lat));
    float base = n + bands;
    cloud = smoothstep(0.42 - uCloudCover * 0.75, 0.6 - uCloudCover * 0.6, base);
    cloud *= 0.7 + 0.3 * smoothstep(-0.3, 0.4, det + (base - 0.2));
    float cl = cloud;
    vec3 cloudLit = uCloudCol * uSun * sat((ndlG + 0.1) / 1.1) * 1.1;
    cloudLit *= mix(vec3(1.0, 0.55, 0.35), vec3(1.0), smoothstep(-0.08, 0.12, ndlG));
    col *= 1.0 - cl * 0.55;
    col = mix(col, cloudLit, cl * 0.97);
  }
#endif

  // --- night side: civilisation ------------------------------------------------
  float night = smoothstep(0.05, -0.18, ndlG);
#ifdef HAS_MAP
  if (uCiv > 0.5 && !ocean) {
    float region = smoothstep(0.1, 0.45, fbm(sd * 2.6 + 20.0, 3) + cityPot * 0.35 - 0.25) * cityPot;
    vec2 wc = worley(sd * 34.0);
    float big = smoothstep(0.05, 0.45, snoise(sd * 11.0 + 3.0));
    float cores = smoothstep(0.32, 0.0, wc.x) * big;
    float suburbs = smoothstep(0.55, 0.1, wc.x) * big * smoothstep(0.2, 0.75, snoise(sd * 400.0) * 0.5 + 0.5);
    float arteries = smoothstep(0.022, 0.0, wc.y - wc.x) * smoothstep(0.6, 0.2, wc.x) * 0.35;
    float hamlets = smoothstep(0.86, 0.97, snoise(sd * 260.0)) * 0.5;
    float lights = region * (cores * cores * 2.2 + suburbs * 0.7 + arteries + hamlets) * (uCiv - 1.0) * 0.6;
    float flick = 0.9 + 0.1 * sin(uTime * 3.0 + wc.x * 60.0);
    emis += uLights * lights * flick * night * 3.4 * (1.0 - cloud * 0.75);
  }
#endif
  col += emis * (1.0 - cloud * 0.6);

  // --- ring shadow --------------------------------------------------------------
#ifdef HAS_RINGS
  col *= ringShadow(vWP, L, uCenter, uRingN, uRingIn, uRingOut, uRingOp, uRingSeed);
#endif

  // --- atmosphere seen from above: aerial haze + bright scattering limb ----------
#ifndef MOON
  float rim = pow(1.0 - ndv, 3.0);
  float lit = smoothstep(-0.3, 0.45, ndlG);
  vec3 atm = uAtmo * uSun * (0.05 + rim * 1.3) * lit * uAtmoDensity;
  col = col * (1.0 - 0.35 * rim * uAtmoDensity) + atm;
  // sunset ring at the terminator
  col += vec3(1.0, 0.38, 0.12) * uSun * rim * exp(-pow(ndlG / 0.14, 2.0)) * 0.6 * uAtmoDensity;
#endif
  gl_FragColor = vec4(col, 1.0);
}`;

export const GAS_FRAG = /* glsl */`
uniform vec3 uSun; uniform vec3 uCenter; uniform float uTime; uniform float uSeed; uniform float uTurb;
uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uAtmo; uniform int uOct;
uniform vec4 uStorm[3]; uniform int uStorms;
uniform vec3 uRingN; uniform float uRingIn, uRingOut, uRingOp, uRingSeed;
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;

float turb(vec3 s){
  // anisotropic: stretched along latitude circles like zonal flow
  vec3 a = vec3(s.x * 3.0, s.y * 18.0, s.z * 3.0) + uSeed;
  vec3 w = vec3(fbm(a * 0.7, 3), fbm(a * 0.7 + 4.1, 3), 0.0);
  return fbm(a + w * 1.4 * uTurb, uOct);
}
float jet(float lat){ return sin(lat * 13.0) * 0.6 + sin(lat * 5.0 + 1.0) * 0.4; }

void main(){
  vec3 d = normalize(vObj);
  // vortex storms swirl the sampling space
  vec3 sd = d;
  for (int i = 0; i < 3; i++) {
    if (i >= uStorms) break;
    vec4 st = uStorm[i];
    vec3 c = vec3(cos(st.x) * cos(st.y), sin(st.x), cos(st.x) * sin(st.y));
    float r = acos(clamp(dot(d, c), -1.0, 1.0)) / st.z;
    float sw = exp(-r * r * 1.6) * 5.0 * st.w;
    sd = rotAxis(sd, c, sw);
  }
  float lat = sd.y;
  // differential rotation with a two-phase flow so shear never runs away
  float T = 90.0;
  float p1 = fract(uTime / T), p2 = fract(uTime / T + 0.5);
  float wgt = abs(p1 * 2.0 - 1.0);
  float j = jet(lat) * 0.02;
  float n = mix(turb(rotY(sd, j * p1 * T)), turb(rotY(sd, j * p2 * T)), wgt);
  float yb = lat + n * 0.014 * uTurb;
  float b1 = 0.5 + 0.5 * sin(yb * 17.0 + 0.6 + 0.6 * sin(yb * 5.0));
  float b2 = 0.5 + 0.5 * sin(yb * 41.0 + 2.0 + n * 0.6);
  float b3 = 0.5 + 0.5 * sin(yb * 97.0 + n * 1.2);
  vec3 c0 = mix(vec3(dot(uC0, vec3(0.3, 0.5, 0.2))), uC0, 0.65);
  vec3 c1 = mix(vec3(dot(uC1, vec3(0.3, 0.5, 0.2))), uC1, 0.65);
  vec3 c2 = mix(vec3(dot(uC2, vec3(0.3, 0.5, 0.2))), uC2, 0.55);
  vec3 col = mix(c1, c0, smoothstep(0.2, 0.8, b1));
  col = mix(col, c2, smoothstep(0.6, 0.95, b2) * 0.3);
  col *= 0.93 + 0.1 * b3;
  col *= 0.96 + 0.08 * (n * 0.5 + 0.5);
  float fine = fbm(vec3(sd.x * 8.0, sd.y * 90.0, sd.z * 8.0) + uSeed + n * 1.5, 3);
  col *= 0.96 + 0.07 * fine;
  // storms: tinted ovals with bright collars
  for (int i = 0; i < 3; i++) {
    if (i >= uStorms) break;
    vec4 st = uStorm[i];
    vec3 c = vec3(cos(st.x) * cos(st.y), sin(st.x), cos(st.x) * sin(st.y));
    float r = acos(clamp(dot(d, c), -1.0, 1.0)) / st.z;
    float core = smoothstep(1.0, 0.45, r + n * 0.15);
    vec3 sc = i == 0 ? vec3(0.75, 0.32, 0.18) : vec3(0.95, 0.92, 0.88);
    col = mix(col, sc * (0.8 + 0.3 * n), core * 0.75);
    col += vec3(0.25, 0.22, 0.2) * exp(-pow((r - 1.0) / 0.15, 2.0)) * 0.6;
  }
  // polar hoods
  float pole = smoothstep(0.72, 0.95, abs(d.y));
  col = mix(col, col * vec3(0.75, 0.82, 0.95) * 0.85, pole);

  vec3 Ng = normalize(vWN);
  vec3 L = normalize(-vWP);
  vec3 V = normalize(cameraPosition - vWP);
  float ndlG = dot(Ng, L);
  float ndv = max(dot(Ng, V), 0.0);
  float diff = sat((ndlG + 0.06) / 1.06);
  diff = diff * diff * (3.0 - 2.0 * diff) * 0.35 + max(ndlG, 0.0) * 0.65;
  vec3 c = col * uSun * diff;
  // limb darkening and hazy rim
  c *= 0.55 + 0.45 * pow(ndv, 0.35);
  float rim = pow(1.0 - ndv, 4.0);
  c += uAtmo * uSun * rim * smoothstep(-0.2, 0.5, ndlG) * 0.5;
#ifdef HAS_RINGS
  c *= ringShadow(vWP, L, uCenter, uRingN, uRingIn, uRingOut, uRingOp, uRingSeed);
  // faint ringshine on the night side
  c += col * uSun * 0.006 * smoothstep(0.1, -0.2, ndlG);
#endif
  gl_FragColor = vec4(c, 1.0);
}`;

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
  float H = (uRa - uR) * 0.28;
  float x = max(hgt - uR, 0.0);
  float dens = exp(-x / H);
  // path length through the shell grows toward the limb
  float path = sqrt(max(uRa * uRa - hgt * hgt, 0.0)) / (uRa - uR) * 0.25;
  float hit = smoothstep(uR * 0.985, uR * 1.001, hgt);
  vec3 n = normalize(P - uCenter);
  vec3 L = normalize(-uCenter);
  float mu = dot(n, L);
  float lit = smoothstep(-0.35, 0.25, mu);
  float fwd = pow(max(dot(rd, L), 0.0), 10.0);
  vec3 col = mix(vec3(1.0, 0.42, 0.16), uAtmo, smoothstep(-0.15, 0.35, mu));
  vec3 c = col * uSun * dens * path * lit * (0.75 + 5.0 * fwd) * hit * uDensity;
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
  float dens = ringDensity(x, uSeed);
  if (dens < 0.003) discard;
  vec3 L = normalize(-vWP);
  vec3 V = normalize(cameraPosition - vWP);
  float sl = dot(uN, L), sv = dot(uN, V);
  bool litSide = sl * sv > 0.0;
  // albedo varies ring to ring: dusty brown C ring, bright icy B ring
  float tone = 0.75 + 0.35 * rNoise(x * 60.0 + uSeed) - 0.25 * (1.0 - smoothstep(0.2, 0.3, x));
  vec3 alb = uCol * tone * mix(vec3(0.85, 0.75, 0.65), vec3(1.0), smoothstep(0.2, 0.5, x));
  float opt = dens * uOp;
  float I = litSide ? (0.35 + 0.95 * dens) * (0.5 + 0.6 * abs(sl)) : opt * (1.0 - opt) * 1.2 + 0.03;
  // forward scattering by fine dust when looking toward the star
  float fwd = pow(max(dot(-V, L), 0.0), 8.0);
  I += fwd * (1.0 - dens) * 2.2 * dens;
  // planet shadow (soft penumbra)
  vec3 oc = uCenter - vWP;
  float tp = dot(oc, L);
  float dc = length(oc - L * tp);
  float sh = tp > 0.0 ? smoothstep(uPR * 0.97, uPR * 1.03, dc) : 1.0;
  vec3 c = alb * uSun * I * sh;
  gl_FragColor = vec4(c * opt, opt);
}`;
