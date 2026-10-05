// Terrain material — a physically based, fully procedural landscape shader.
//
// MeshStandardMaterial (sun + hemisphere + shadow maps, three's PBR BRDF)
// extended with onBeforeCompile:
//   • CDLOD geomorphing in the vertex shader (per-vertex morph toward the
//     parent grid by camera distance — no popping, no cracks with skirts)
//   • layered geology from per-vertex worker attributes (moisture, temperature,
//     rock, snow, sand, wet/river, cavity, cliff) + slope + altitude
//   • 3D tileable noise volumes (gradient noise with analytic derivatives,
//     Worley cells) sampled in a floating "detail space" (camera-snapped origin,
//     exact float32 chunk origins) → stable centimetre detail anywhere on a
//     50 km planet, no triplanar needed, detail normals from analytic gradients
//   • rock strata / ledges, vertical karst runnels, fractured blocks, scree,
//     sand ripples along the wind, wind-packed snow, wet shorelines, moss on
//     ledges, macro albedo variation
//   • far-terrain sun visibility (terrain shadow map owned by the terrain
//     subsystem) folded into the directional light
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Noise volumes (generated once per session; pure code, no assets)
// ---------------------------------------------------------------------------
const S = 64; // texels per tile edge
let _cache = null;

function rngFactory(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Tileable Perlin gradient noise with analytic derivatives on an S³ grid, P lattice cells per tile. */
function gradNoise(P, seed) {
  const rnd = rngFactory(seed);
  const G = new Float32Array(P * P * P * 3);
  for (let i = 0; i < P * P * P; i++) {
    const z = rnd() * 2 - 1, t = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    G[i * 3] = r * Math.cos(t); G[i * 3 + 1] = r * Math.sin(t); G[i * 3 + 2] = z;
  }
  const out = new Float32Array(S * S * S * 4);
  const gi = (x, y, z) => (((z % P) * P + (y % P)) * P + (x % P)) * 3;
  let mx = 0;
  for (let k = 0; k < S; k++) for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const px = ((i + 0.5) / S) * P, py = ((j + 0.5) / S) * P, pz = ((k + 0.5) / S) * P;
    const X = Math.floor(px), Y = Math.floor(py), Z = Math.floor(pz);
    const fx = px - X, fy = py - Y, fz = pz - Z;
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10), uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    const dux = 30 * fx * fx * (fx - 1) * (fx - 1), duy = 30 * fy * fy * (fy - 1) * (fy - 1), duz = 30 * fz * fz * (fz - 1) * (fz - 1);
    const c = [];
    for (let n = 0; n < 8; n++) {
      const ox = n & 1, oy = (n >> 1) & 1, oz = (n >> 2) & 1;
      const g = gi(X + ox, Y + oy, Z + oz);
      const gx = G[g], gy = G[g + 1], gz = G[g + 2];
      c.push([gx, gy, gz, gx * (fx - ox) + gy * (fy - oy) + gz * (fz - oz)]);
    }
    const [a, b, cc, d, e, f, g, h] = c;
    const va = a[3], vb = b[3], vc = cc[3], vd = d[3], ve = e[3], vf = f[3], vg = g[3], vh = h[3];
    const k0 = vb - va, k1 = vc - va, k2 = ve - va, k3 = va - vb - vc + vd, k4 = va - vc - ve + vg, k5 = va - vb - ve + vf, k6 = -va + vb + vc - vd + ve - vf - vg + vh;
    const v = va + ux * k0 + uy * k1 + uz * k2 + ux * uy * k3 + uy * uz * k4 + uz * ux * k5 + ux * uy * uz * k6;
    const grad = [0, 1, 2].map((q) => a[q] + ux * (b[q] - a[q]) + uy * (cc[q] - a[q]) + uz * (e[q] - a[q]) + ux * uy * (a[q] - b[q] - cc[q] + d[q]) + uy * uz * (a[q] - cc[q] - e[q] + g[q]) + uz * ux * (a[q] - b[q] - e[q] + f[q]) + ux * uy * uz * (-a[q] + b[q] + cc[q] - d[q] + e[q] - f[q] - g[q] + h[q]));
    const dx = grad[0] + dux * (k0 + uy * k3 + uz * k5 + uy * uz * k6);
    const dy = grad[1] + duy * (k1 + ux * k3 + uz * k4 + ux * uz * k6);
    const dz = grad[2] + duz * (k2 + uy * k4 + ux * k5 + ux * uy * k6);
    const o = ((k * S + j) * S + i) * 4;
    out[o] = dx; out[o + 1] = dy; out[o + 2] = dz; out[o + 3] = v;
    if (Math.abs(v) > mx) mx = Math.abs(v);
  }
  // normalize value to ±1 (derivatives scaled alike)
  const s = 1 / (mx || 1);
  for (let i = 0; i < out.length; i++) out[i] *= s;
  return out;
}

/** Tileable Worley: F1, F2-F1, cell id; P cells per tile. */
function worley(P, seed) {
  const rnd = rngFactory(seed);
  const F = new Float32Array(P * P * P * 4);
  for (let i = 0; i < P * P * P; i++) { F[i * 4] = rnd(); F[i * 4 + 1] = rnd(); F[i * 4 + 2] = rnd(); F[i * 4 + 3] = rnd(); }
  const out = new Float32Array(S * S * S * 3);
  for (let k = 0; k < S; k++) for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const px = ((i + 0.5) / S) * P, py = ((j + 0.5) / S) * P, pz = ((k + 0.5) / S) * P;
    const X = Math.floor(px), Y = Math.floor(py), Z = Math.floor(pz);
    let f1 = 9, f2 = 9, id = 0;
    for (let c = -1; c <= 1; c++) for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const cx = X + a, cy = Y + b, cz = Z + c;
      const w = ((((cz + P) % P) * P + ((cy + P) % P)) * P + ((cx + P) % P)) * 4;
      const dx = cx + F[w] - px, dy = cy + F[w + 1] - py, dz = cz + F[w + 2] - pz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < f1) { f2 = f1; f1 = d; id = F[w + 3]; } else if (d < f2) f2 = d;
    }
    const o = ((k * S + j) * S + i) * 3;
    out[o] = f1; out[o + 1] = f2 - f1; out[o + 2] = id;
  }
  return out;
}

export function noiseTextures() {
  if (_cache) return _cache;
  const n8 = gradNoise(8, 1337), n16 = gradNoise(16, 7331), w = worley(8, 4242);
  const A = new Uint8Array(S * S * S * 4), B = new Uint8Array(S * S * S * 4);
  const q = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let i = 0; i < S * S * S; i++) {
    // A: gradient (lattice units, ±4 range) + value of an 8-cell gradient noise
    A[i * 4] = q(n8[i * 4] / 8 + 0.5); A[i * 4 + 1] = q(n8[i * 4 + 1] / 8 + 0.5); A[i * 4 + 2] = q(n8[i * 4 + 2] / 8 + 0.5); A[i * 4 + 3] = q(n8[i * 4 + 3] * 0.5 + 0.5);
    // B: Worley F1, F2-F1, cell id, 16-cell gradient noise value
    B[i * 4] = q(w[i * 3] / 1.1); B[i * 4 + 1] = q(w[i * 3 + 1] / 0.9); B[i * 4 + 2] = q(w[i * 3 + 2]); B[i * 4 + 3] = q(n16[i * 4 + 3] * 0.5 + 0.5);
  }
  const mk = (data) => {
    const t = new THREE.Data3DTexture(data, S, S, S);
    t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true; t.unpackAlignment = 1; t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  _cache = { A: mk(A), B: mk(B) };
  return _cache;
}

// ---------------------------------------------------------------------------
// Style table: how each landform style is dressed
// ---------------------------------------------------------------------------
// strata: band height (m), strata strength, runnels (vertical streaks), ripples,
// moss, crack/block strength, rock hue variation, volcanic glow
const STYLE = {
  rolling: { strataH: 7, strata: 0.35, runnel: 0.35, ripple: 0.4, moss: 0.6, blocks: 0.8, hue: 0.25, glow: 0, grassK: 1 },
  dunes: { strataH: 11, strata: 0.9, runnel: 0.2, ripple: 1.0, moss: 0, blocks: 0.6, hue: 0.5, glow: 0, grassK: 0.2 },
  karst: { strataH: 3.2, strata: 0.55, runnel: 1.0, ripple: 0.2, moss: 1.0, blocks: 1.0, hue: 0.15, glow: 0, grassK: 1 },
  glacial: { strataH: 5, strata: 0.3, runnel: 0.5, ripple: 0.3, moss: 0.15, blocks: 1.0, hue: 0.15, glow: 0, grassK: 0.6 },
  mesas: { strataH: 9, strata: 1.0, runnel: 0.45, ripple: 0.7, moss: 0.05, blocks: 0.7, hue: 0.9, glow: 0, grassK: 0.4 },
  canyons: { strataH: 8, strata: 1.0, runnel: 0.5, ripple: 0.6, moss: 0.1, blocks: 0.8, hue: 0.8, glow: 0, grassK: 0.5 },
  badlands: { strataH: 4.5, strata: 1.0, runnel: 0.7, ripple: 0.5, moss: 0.0, blocks: 0.5, hue: 1.0, glow: 0, grassK: 0.3 },
  highlands: { strataH: 6, strata: 0.5, runnel: 0.45, ripple: 0.3, moss: 0.5, blocks: 1.0, hue: 0.3, glow: 0, grassK: 1 },
  plateaus: { strataH: 8, strata: 0.75, runnel: 0.4, ripple: 0.3, moss: 0.4, blocks: 0.9, hue: 0.35, glow: 0, grassK: 1 },
  craters: { strataH: 6, strata: 0.15, runnel: 0.1, ripple: 0.0, moss: 0, blocks: 0.6, hue: 0.2, glow: 0, grassK: 0 },
  volcanic: { strataH: 2.5, strata: 0.3, runnel: 0.3, ripple: 0.2, moss: 0, blocks: 1.0, hue: 0.2, glow: 1, grassK: 0.2 },
  wetlands: { strataH: 5, strata: 0.3, runnel: 0.3, ripple: 0.2, moss: 1.0, blocks: 0.6, hue: 0.2, glow: 0, grassK: 1 },
  archipelago: { strataH: 4, strata: 0.4, runnel: 0.5, ripple: 0.5, moss: 0.6, blocks: 0.9, hue: 0.25, glow: 0, grassK: 1 },
  blobby: { strataH: 6, strata: 0.2, runnel: 0.1, ripple: 0.3, moss: 0.4, blocks: 0.2, hue: 0.6, glow: 0, grassK: 1 },
};

const col = (hex, fallback) => new THREE.Color(hex || fallback);

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------
const VERT_PARS = /* glsl */`
attribute vec3 aMorph;
attribute vec4 aNrm;
attribute vec4 aNrm2;
attribute vec4 aMatA;
attribute vec4 aMatB;
attribute float aHgt;
uniform vec3 uDetailOrigin;
uniform float uLodK;
uniform float uFaceSize;
varying vec3 vD;
varying vec3 vWN;
varying vec3 vUp;
varying vec4 vMatA;
varying vec4 vMatB;
varying float vH;
varying float vDist;
`;

const VERT_NORMAL = /* glsl */`
float tLevel = floor( aNrm.w * 127.0 + 0.5 );
vec3 tOrigin = modelMatrix[ 3 ].xyz;
vec3 tCamRel = ( tOrigin - cameraPosition ) + position;
float tDist = length( tCamRel );
float tParent = uLodK * uFaceSize * exp2( 1.0 - tLevel );
float tMorph = tLevel > 0.5 ? smoothstep( 0.6, 0.92, tDist / tParent ) : 0.0;
vec3 objectNormal = normalize( mix( aNrm.xyz, aNrm2.xyz, tMorph ) );
`;

const VERT_BEGIN = /* glsl */`
vec3 transformed = position + aMorph * tMorph;
vD = ( tOrigin - uDetailOrigin ) + transformed;
vWN = objectNormal;
vUp = normalize( tOrigin + transformed );
vMatA = aMatA;
vMatB = aMatB;
vH = aHgt + dot( aMorph * tMorph, vUp );
vDist = tDist;
`;

const FRAG_PARS = /* glsl */`
uniform highp sampler3D tNoiseA;
uniform highp sampler3D tNoiseB;
uniform float uPixelAngle;
uniform float uSeaLevel;
uniform float uRelief;
uniform float uTime;
uniform vec3 uWindDir;
uniform vec3 uGround0;
uniform vec3 uGround1;
uniform vec3 uGround2;
uniform vec3 uGround3;
uniform vec3 uRockA;
uniform vec3 uRockB;
uniform vec3 uRockC;
uniform vec3 uSand;
uniform vec3 uSnow;
uniform vec3 uSoil;
uniform vec3 uMoss;
uniform vec3 uGlow;
uniform vec4 uStyleA;   // strataH, strata, runnel, ripple
uniform vec4 uStyleB;   // moss, blocks, hue, glow
uniform float uGrassK;
uniform sampler2D tSunVis;     // far terrain shadow (depth, sun ortho)
uniform mat4 uSunVisMatrix;    // world (detail space) → sun shadow uv/depth
uniform float uSunVisOn;
uniform vec4 uSunVisParams;    // reversed, depth bias, normal offset (m)
varying vec3 vD;
varying vec3 vWN;
varying vec3 vUp;
varying vec4 vMatA;
varying vec4 vMatB;
varying float vH;
varying float vDist;

vec3 tN;      // final world-space shading normal
vec3 tGeoN;   // geometric world normal
float tAO;
float tSunVisF;
float tRough;
vec3 tEmit;

// gradient noise: xyz = d/dp (per meter), w = value in [-1, 1]
vec4 nA( vec3 p, float f ) {
  vec4 t = texture( tNoiseA, p * f );
  return vec4( ( t.xyz * 8.0 - 4.0 ) * ( 8.0 * f ), t.w * 2.0 - 1.0 );
}
vec4 nB( vec3 p, float f ) { return texture( tNoiseB, p * f ); }

// fade an octave whose features ( 1/(8f) m ) approach the pixel footprint
float octW( float f, float pix ) { return 1.0 - smoothstep( 0.35, 1.0, pix * f * 8.0 ); }

float hash11( float p ) { p = fract( p * 0.1031 ); p *= p + 33.33; p *= p + p; return fract( p ); }

// height-based blend: a over b by weight w, using layer heights for crisp natural edges
float hblend( float w, float ha, float hb, float k ) { return smoothstep( -k, k, ( w - 0.5 ) * 2.0 + ( ha - hb ) ); }

// ---- far terrain shadow ----
float sunVisibility( vec3 d, vec3 n ) {
  if ( uSunVisOn < 0.5 ) return 1.0;
  vec4 sc = uSunVisMatrix * vec4( d + n * uSunVisParams.z, 1.0 );
  vec3 c = sc.xyz;
  vec2 e = min( c.xy, 1.0 - c.xy );
  if ( min( e.x, e.y ) < 0.0 ) return 1.0;
  float edgeFade = smoothstep( 0.0, 0.08, min( e.x, e.y ) );
  vec2 ts = vec2( 1.0 ) / vec2( textureSize( tSunVis, 0 ) );
  float bias = uSunVisParams.y;
  float s = 0.0;
  for ( int y = -1; y <= 1; y ++ ) for ( int x = -1; x <= 1; x ++ ) {
    float dz = texture2D( tSunVis, c.xy + vec2( x, y ) * ts * 1.5 ).r;
    // reversed depth: larger = nearer the sun
    s += uSunVisParams.x > 0.5 ? step( dz - bias, c.z ) : step( c.z - bias, dz );
  }
  return mix( 1.0, s / 9.0, edgeFade );
}
`;

// The material body: computes diffuseColor, tRough, tN, tAO, tSunVisF, tEmit.
// Layers are evaluated only where they have weight, octaves only where they
// are larger than a pixel (cheap at distance, rich up close).
const FRAG_SURFACE = /* glsl */`
{
  vec3 D = vD;
  vec3 up = normalize( vUp );
  vec3 Ng = normalize( vWN );
  tGeoN = Ng;
  float pix = max( vDist * uPixelAngle, 1e-4 );
  float moist = vMatA.x, temp = vMatA.y, rockA = vMatA.z, snowA = vMatA.w;
  float sandA = vMatB.x, wetA = vMatB.y, cav = vMatB.z, cliffA = vMatB.w;
  float h = vH;
  float slope = 1.0 - dot( Ng, up );
  float w;

  // ---- macro variation (kills tiling, gives regions their own character) ----
  vec4 m0 = nA( D, 1.0 / 4096.0 );
  vec4 m1 = nA( D.zxy, 1.0 / 1024.0 );
  vec4 m2 = nA( D.yzx + 3.7, 1.0 / 256.0 );
  vec4 m3 = octW( 1.0 / 64.0, pix ) > 0.0 ? nA( D + 1.3, 1.0 / 64.0 ) : vec4( 0.0 );
  float macro = m0.w * 0.45 + m1.w * 0.35 + m2.w * 0.2;
  float meso = m2.w * 0.6 + m3.w * 0.4;

  // ---- layer weights (before detail: lets us skip invisible layers) ----
  // sand never turns to rock just because it is steep (slip faces sit at 30–34°)
  float rockSlope = smoothstep( 0.2, 0.42, slope + meso * 0.08 ) * ( 1.0 - sandA );
  // convex shoulders & crests shed soil → bedrock shows; hollows stay soft
  float convex = smoothstep( 0.45, 0.32, cav ) * smoothstep( 0.12, 0.35, slope ) * ( 1.0 - sandA );
  float conc = smoothstep( 0.53, 0.66, cav );
  // alpine: high ground is bare rock (relief-relative), broken by meso noise
  float alpine = smoothstep( 0.42, 0.62, h / max( uRelief, 1.0 ) + meso * 0.06 ) * ( 1.0 - sandA );
  float rockW = clamp( max( max( max( rockA, cliffA ), rockSlope ), max( convex * 0.6, alpine * smoothstep( 0.04, 0.2, slope + meso * 0.1 ) ) ), 0.0, 1.0 );
  float shore = uSeaLevel > -1e8 ? 1.0 - smoothstep( 0.8 + meso * 1.2, 3.0 + meso * 4.5 + m1.w * 2.0, h - uSeaLevel ) : 0.0;
  float sandW = max( sandA, shore * ( 1.0 - rockSlope ) );
  float soilW = clamp( smoothstep( 0.1, 0.24, slope + meso * 0.06 ) + ( 1.0 - smoothstep( 0.12, 0.35, moist ) ) * 0.5, 0.0, 1.0 );
  float snowW = clamp( snowA * ( 1.0 - smoothstep( 0.32, 0.6, slope + meso * 0.1 ) ) * 1.25, 0.0, 1.0 );

  // ---- strata coordinate (radial height, gently warped) ----
  float strataH = uStyleA.x;
  float sCoord = ( h + m2.w * strataH * 1.6 + m3.w * strataH * 0.35 ) / strataH;
  float sBand = floor( sCoord );
  float sFrac = fract( sCoord );
  float bandRnd = hash11( sBand * 1.618 + 0.37 );
  float bandRnd2 = hash11( sBand * 3.17 + 9.1 );

  // ================= SOIL / GRASS =================
  vec3 gSoil = vec3( 0.0 );
  float hGrass = 0.0;
  float peb = 0.0;
  {
    vec4 g1 = nA( D.zxy + 4.4, 1.0 / 16.0 ); w = octW( 1.0 / 16.0, pix );
    gSoil += g1.xyz * 0.06 * w; hGrass += g1.w * 0.5;
    w = octW( 1.0, pix );
    if ( w > 0.0 ) { vec4 g2 = nA( D + 8.8, 1.0 ); gSoil += g2.xyz * 0.02 * w; hGrass += g2.w * 0.3 * w; }
    w = octW( 0.5, pix );
    if ( w > 0.0 ) { vec4 pb = nB( D.yzx + 2.0, 0.5 ); peb = ( 1.0 - smoothstep( 0.0, 0.45, pb.x ) ) * w; hGrass += peb * 0.2; }
  }

  // ================= ROCK =================
  vec3 gRock = vec3( 0.0 );
  float hRock = 0.0;
  float crack = 0.0;
  if ( rockW > 0.004 ) {
    w = octW( 1.0 / 32.0, pix );
    if ( w > 0.0 ) { vec4 o1 = nA( D + 7.1, 1.0 / 32.0 ); gRock += o1.xyz * 1.2 * w; hRock += o1.w * 0.5 * w; }
    w = octW( 1.0 / 8.0, pix );
    if ( w > 0.0 ) { vec4 o2 = nA( D.yzx + 2.3, 1.0 / 8.0 ); gRock += o2.xyz * 0.32 * w; hRock += o2.w * 0.25 * w; }
    w = octW( 0.5, pix );
    if ( w > 0.0 ) { vec4 o3 = nA( D.zxy + 5.9, 0.5 ); gRock += o3.xyz * 0.06 * w; hRock += o3.w * 0.12 * w; }
    w = octW( 2.0, pix );
    if ( w > 0.0 ) { vec4 o4 = nA( D + 1.7, 2.0 ); gRock += o4.xyz * 0.012 * w; hRock += o4.w * 0.06 * w; }
    // vertical runnels: noise in a space compressed along 'up'
    float rw = octW( 1.0 / 8.0, pix ) * uStyleA.z * smoothstep( 0.25, 0.6, slope );
    if ( rw > 0.0 ) {
      vec3 Dq = D - up * dot( D, up ) * 0.9;
      vec4 r1 = nA( Dq + 11.0, 1.0 / 8.0 );
      gRock += ( r1.xyz - up * dot( r1.xyz, up ) ) * 0.35 * rw;
      hRock += r1.w * 0.3 * rw;
    }
    // large runnels / gullies visible from afar
    float rw2 = octW( 1.0 / 64.0, pix ) * uStyleA.z * smoothstep( 0.3, 0.7, slope );
    if ( rw2 > 0.0 ) {
      vec3 Dq = D - up * dot( D, up ) * 0.85;
      vec4 r2 = nA( Dq.zxy + 3.0, 1.0 / 64.0 );
      gRock += ( r2.xyz - up * dot( r2.xyz, up ) ) * 2.5 * rw2;
      hRock += r2.w * 0.4 * rw2;
    }
    // blocks / joints (Worley cell borders → cracks)
    float bw = octW( 1.0 / 32.0, pix ) * uStyleB.y;
    if ( bw > 0.0 ) {
      vec4 c1 = nB( D + 0.5, 1.0 / 32.0 );
      crack = ( 1.0 - smoothstep( 0.0, 0.07, c1.y ) ) * bw;
      hRock -= crack * 0.5;
    }
    // strata ledges: sawtooth along 'up' (overhanging lips, recessed beds)
    float sw = uStyleA.y * octW( 0.5 / strataH, pix ) * smoothstep( 0.2, 0.55, slope );
    if ( sw > 0.0 ) {
      float led = smoothstep( 0.0, 0.12, sFrac ) * ( 1.0 - smoothstep( 0.55, 1.0, sFrac ) * 0.6 );
      float ledD = ( sFrac < 0.12 ? 1.0 / 0.12 : 0.0 ) - ( sFrac > 0.55 ? 0.6 / 0.45 : 0.0 );
      gRock += up * ledD * 0.045 * sw;
      hRock += led * 0.3 * sw;
    }
  }

  // ================= SAND =================
  vec3 gSand = vec3( 0.0 );
  float hSand = 0.0;
  float rippleShade = 0.0;
  float leeF = 0.0;
  if ( sandW > 0.004 ) {
    // zonal wind frame (west → east), matching the dune phase in TerrainHeight
    vec3 east = vec3( up.z, 0.0, -up.x );
    vec3 wt = dot( east, east ) > 1e-4 ? normalize( east ) : normalize( uWindDir - up * dot( uWindDir, up ) + vec3( 1e-4 ) );
    leeF = smoothstep( 0.04, 0.3, dot( Ng, wt ) ) * sandA;
    vec3 wb = cross( up, wt );
    vec4 wq = nA( D + 21.0, 1.0 / 16.0 );
    // primary ripples (~0.22 m) + megaripples (~1.6 m), curved by noise
    float ph1 = dot( D, wt ) / 0.22 + wq.w * 1.4 + dot( D, wb ) * 0.12;
    float ph2 = dot( D, wt ) / 1.6 + wq.w * 1.1 + dot( D, wb ) * 0.05;
    float f1 = fract( ph1 ), f2 = fract( ph2 );
    // asymmetric profile: long stoss slope, steep lee face
    float p1 = f1 < 0.75 ? f1 / 0.75 : ( 1.0 - f1 ) / 0.25;
    float d1 = f1 < 0.75 ? 1.0 / 0.75 : -1.0 / 0.25;
    float p2 = f2 < 0.7 ? f2 / 0.7 : ( 1.0 - f2 ) / 0.3;
    float d2 = f2 < 0.7 ? 1.0 / 0.7 : -1.0 / 0.3;
    float w1 = octW( 1.0 / 1.8, pix ) * uStyleA.w * ( 1.0 - 0.85 * leeF );
    float w2 = octW( 1.0 / 12.0, pix ) * uStyleA.w * ( 1.0 - 0.7 * leeF );
    gSand += wt * ( d1 / 0.22 ) * 0.016 * w1 + wt * ( d2 / 1.6 ) * 0.07 * w2;
    hSand = p1 * 0.2 * w1 + p2 * 0.4 * w2 + wq.w * 0.3;
    rippleShade = ( p1 - 0.5 ) * w1;
    w = octW( 0.25, pix );
    if ( w > 0.0 ) { vec4 s1 = nA( D.yzx, 0.25 ); gSand += s1.xyz * 0.015 * w; }
  }

  // ================= ALBEDO =================
  // rock: base + strata band colors + macro hue drift + weathering
  vec3 rockCol = uRockA;
  // strata bands read on walls only; on near-flat rock they would marble into contour blotches
  float wallK = smoothstep( 0.12, 0.4, slope );
  float bandMix = mix( 0.5, bandRnd, uStyleA.y * wallK );
  rockCol = mix( rockCol, uRockB, smoothstep( 0.3, 0.9, bandMix ) * uStyleB.z );
  rockCol = mix( rockCol, uRockC, smoothstep( 0.55, 1.0, bandRnd2 ) * uStyleB.z * 0.8 * wallK );
  rockCol *= 0.78 + 0.32 * ( macro * 0.5 + 0.5 ) + 0.18 * hRock;
  rockCol *= 1.0 - crack * 0.55;
  // wind-blown dust settles on flat rock in sandy worlds (desert pavement)
  rockCol = mix( rockCol, uSand * ( 0.82 + 0.1 * meso ), ( 1.0 - smoothstep( 0.06, 0.3, slope ) ) * 0.5 * uStyleA.w * ( 1.0 - crack ) );
  // dark streaks down the walls, pale dry crowns
  float streak = clamp( 0.5 - hRock * 0.9, 0.0, 1.0 ) * uStyleA.z * smoothstep( 0.3, 0.7, slope );
  rockCol *= 1.0 - streak * ( 0.25 + 0.3 * uStyleA.z );

  // vegetation colour from moisture, temperature and macro noise
  vec3 lush = mix( uGround1, uGround0, smoothstep( -0.4, 0.5, macro ) );
  vec3 meadow = mix( uGround2, uGround0, smoothstep( -0.2, 0.6, meso ) );
  vec3 dry = mix( uGround3, uSand, 0.35 );
  vec3 grassCol = mix( lush, meadow, smoothstep( 0.2, 0.7, meso * 0.5 + 0.5 ) * 0.6 );
  // ---- patchwork: 3–12 m Worley patches (dry / lush / bare), each its own tint ----
  float bare = 0.0;
  {
    float pw = octW( 1.0 / 96.0, pix );
    vec4 pc = nB( D.yzx + 13.0, 1.0 / 96.0 );   // ~12 m cells
    vec4 ps = nB( D.zxy + 5.0, 1.0 / 32.0 );    // ~4 m cells
    float pws = octW( 1.0 / 32.0, pix );
    float edge = smoothstep( 0.0, 0.25, pc.y );
    float dryP = smoothstep( 0.62, 0.8, pc.z ) * edge * pw;
    float lushP = smoothstep( 0.3, 0.12, pc.z ) * edge * pw;
    grassCol = mix( grassCol, mix( uGround3, uSand, 0.25 ) * 0.95, dryP * 0.55 );
    grassCol = mix( grassCol, uGround1 * 0.82, lushP * 0.5 );
    // per-cell hue / value jitter (±8%)
    float j1 = ( ps.z - 0.5 ) * pws, j2 = ( pc.w - 0.5 );
    grassCol *= 1.0 + j1 * 0.18 + j2 * 0.12;
    grassCol = mix( grassCol, grassCol * vec3( 1.1, 1.0, 0.75 ), clamp( j1 + 0.5, 0.0, 1.0 ) * 0.25 * pws );
    bare = smoothstep( 0.86, 0.95, pc.z ) * smoothstep( 0.42, 0.18, pc.x ) * pw;
  }
  // desaturate a touch: real meadows are greyer than paint
  grassCol = mix( vec3( dot( grassCol, vec3( 0.3, 0.55, 0.15 ) ) ), grassCol, 0.8 );
  // hollows: lusher, darker; forests (beyond flora's reach) read as darker canopy masses
  grassCol *= 1.0 - 0.15 * conc;
  float farK = smoothstep( 3.0, 50.0, pix );
  float forest = smoothstep( 0.52, 0.78, moist + macro * 0.18 ) * smoothstep( 0.22, 0.42, temp );
  grassCol = mix( grassCol, grassCol * vec3( 0.52, 0.64, 0.56 ), forest * ( 0.25 + 0.5 * farK ) );
  grassCol = mix( dry, grassCol, smoothstep( 0.18, 0.55, moist + macro * 0.12 ) );
  grassCol = mix( grassCol, grassCol * vec3( 1.08, 1.0, 0.72 ), smoothstep( 0.55, 0.85, temp ) * 0.5 );
  grassCol *= 0.82 + 0.3 * ( hGrass * 0.5 + 0.5 );
  // soil / scree
  vec3 soilCol = mix( uSoil, uSoil * 1.25, hGrass * 0.5 + 0.5 );
  soilCol = mix( soilCol, uRockA * 0.9, 0.25 + peb * 0.4 );
  vec3 sandCol = uSand * ( 0.9 + 0.12 * macro + 0.05 * rippleShade );
  // lee (slip) faces: finer, darker avalanche sand; crests catch light
  sandCol *= 1.0 - 0.09 * leeF;
  sandCol *= 1.0 + 0.08 * smoothstep( 0.46, 0.38, cav );
  vec3 snowCol = uSnow * ( 0.94 + 0.06 * meso );

  // ---- composite with height-based blending ----
  soilW = max( soilW, bare );
  float wSoil = hblend( soilW, hGrass * 0.3, 0.0, 0.35 );
  vec3 albedo = mix( grassCol, soilCol, wSoil );
  vec3 gN = gSoil * ( 1.0 + 0.6 * wSoil );
  float rough = mix( 0.92, 0.95, wSoil );
  float wSand = sandW > 0.004 ? hblend( sandW, hSand * 0.2, hGrass * 0.2, 0.35 ) : 0.0;
  albedo = mix( albedo, sandCol, wSand );
  gN = mix( gN, gSand, wSand );
  rough = mix( rough, 0.88, wSand );
  float wRock = rockW > 0.004 ? hblend( rockW, hRock * 0.6, 0.0, 0.3 ) : 0.0;
  albedo = mix( albedo, rockCol, wRock );
  gN = mix( gN, gRock, wRock );
  rough = mix( rough, 0.8 + 0.12 * crack, wRock );

  // moss / lichen on rock: up-facing ledges in moist climates
  float mossW = uStyleB.x * wRock * smoothstep( 0.35, 0.75, moist ) * smoothstep( 0.55, 0.9, dot( normalize( Ng - gN * 0.5 ), up ) + meso * 0.2 ) * ( 1.0 - snowW );
  albedo = mix( albedo, uMoss * ( 0.8 + 0.3 * hGrass ), mossW * 0.85 );

  // snow on top
  float wSnow = snowW > 0.004 ? hblend( snowW, 0.0, hRock * 0.4 * wRock, 0.25 ) : 0.0;
  albedo = mix( albedo, snowCol, wSnow );
  gN = mix( gN, gSoil * 0.4, wSnow );
  rough = mix( rough, 0.55, wSnow );

  // ---- wetness: rivers, shorelines, damp hollows ----
  float wet = clamp( wetA * 1.2, 0.0, 1.0 );
  if ( uSeaLevel > -1e8 ) wet = max( wet, 1.0 - smoothstep( 0.2, 1.6 + meso * 0.6, h - uSeaLevel ) );
  wet *= ( 1.0 - wSnow );
  albedo *= mix( 1.0, 0.52, wet );
  rough = mix( rough, 0.28, wet * 0.85 );
  // river channel core: standing water film → dark, mirror-like, flat
  float riverW = smoothstep( 0.74, 0.92, wetA ) * ( 1.0 - wSnow );
  albedo *= mix( 1.0, 0.45, riverW );
  rough = mix( rough, 0.07, riverW );
  gN *= 1.0 - riverW * 0.9;
  // damp hollows in wet climates: mud & rain puddles that mirror the sky
  float pw2 = octW( 1.0 / 24.0, pix );
  if ( pw2 > 0.0 ) {
    vec4 pd = nA( D.yzx + 31.0, 1.0 / 24.0 );
    float pud = smoothstep( 0.45, 0.62, moist ) * smoothstep( 0.35, 0.6, pd.w + conc * 0.6 + hGrass * -0.15 ) * ( 1.0 - wRock ) * ( 1.0 - wSnow ) * ( 1.0 - wSand ) * pw2;
    albedo *= mix( 1.0, 0.55, pud );
    rough = mix( rough, 0.12, smoothstep( 0.5, 0.9, pud ) );
    gN *= 1.0 - 0.8 * smoothstep( 0.5, 0.9, pud );
  }
  if ( uSeaLevel > -1e8 && h < uSeaLevel ) albedo *= vec3( 0.55, 0.7, 0.72 );

  // ---- ambient occlusion: chunk cavity + crack + micro hollows ----
  float ao = clamp( 1.0 - ( cav - 0.5 ) * 1.8, 0.35, 1.0 );
  ao *= 1.0 - crack * 0.6 * wRock;
  ao *= mix( 1.0, 0.75 + 0.25 * clamp( hRock + 0.5, 0.0, 1.0 ), wRock );
  ao *= mix( 0.8 + 0.2 * clamp( hGrass * 0.5 + 0.5, 0.0, 1.0 ), 1.0, max( wRock, wSand ) );
  tAO = ao;

  // ---- volcanic glow in deep cracks of hot basalt ----
  tEmit = vec3( 0.0 );
  if ( uStyleB.w > 0.0 ) {
    float hot = smoothstep( 0.75, 0.95, temp ) * crack * wRock;
    tEmit = uGlow * hot * 6.0 * uStyleB.w;
  }

  // ---- shading normal ----
  vec3 gT = gN - Ng * dot( gN, Ng );
  tN = normalize( Ng - gT );
  tRough = rough;
  diffuseColor.rgb = albedo;
  tSunVisF = sunVisibility( D, Ng );
}
`;

/** Create the terrain material for a world. Returns { material, uniforms }. */
export function createTerrainMaterial(world, style) {
  const P = world.palette || {};
  const st = STYLE[style] || STYLE.rolling;
  const tex = noiseTextures();
  const g = P.ground || ['#6a8a4a', '#4f7a3a', '#8bb85a', '#b9c97a'];
  const rock = col(P.rock, '#7a746a');
  const sand = col(P.sand, '#d8c8a0');
  // derived rock band colors: warm/cool shifts of the palette rock
  const rockB = rock.clone().multiply(new THREE.Color(1.18, 1.05, 0.9));
  const rockC = rock.clone().multiply(new THREE.Color(0.82, 0.8, 0.86));
  if (style === 'mesas' || style === 'canyons' || style === 'badlands' || style === 'dunes') {
    rockB.copy(rock).lerp(new THREE.Color('#b0603a'), 0.5);
    rockC.copy(rock).lerp(new THREE.Color('#e8d0a8'), 0.45);
  }
  // sand seas: bedrock is the sand's parent rock → close in tone (no clay marbling)
  if (style === 'dunes') { rock.lerp(sand, 0.4); rockB.lerp(sand, 0.3); rockC.lerp(sand, 0.3); }
  if (style === 'karst') { rock.lerp(new THREE.Color('#b8b4a8'), 0.5); rockB.copy(rock).lerp(new THREE.Color('#d8d4c8'), 0.7); rockC.copy(rock).lerp(new THREE.Color('#3e443a'), 0.55); }
  if (style === 'glacial') { rockB.copy(rock).lerp(new THREE.Color('#3a4450'), 0.4); rockC.copy(rock).lerp(new THREE.Color('#8a96a4'), 0.4); }
  const soil = col(g[3], '#8a7050').lerp(new THREE.Color('#5a4630'), 0.55);
  const moss = col(P.foliage?.[2] || P.foliage?.[0], '#4a6a34').lerp(col(g[1]), 0.4);
  const snow = new THREE.Color(style === 'glacial' ? '#e6eef8' : '#eef2f6');
  const glow = col(P.accent, '#ff6a20');

  const uniforms = {
    tNoiseA: { value: tex.A },
    tNoiseB: { value: tex.B },
    uDetailOrigin: { value: new THREE.Vector3() },
    uLodK: { value: 3 },
    uFaceSize: { value: world.radius * Math.PI * 0.5 },
    uPixelAngle: { value: 0.001 },
    uSeaLevel: world.uniforms.uSeaLevel,
    uRelief: { value: world.terrainParams.relief },
    uTime: world.uniforms.uTime,
    uWindDir: { value: new THREE.Vector3(1, 0, 0.3).normalize() },
    uGround0: { value: col(g[0]) }, uGround1: { value: col(g[1]) }, uGround2: { value: col(g[2] || g[0]) }, uGround3: { value: col(g[3] || g[1]) },
    uRockA: { value: rock }, uRockB: { value: rockB }, uRockC: { value: rockC },
    uSand: { value: sand }, uSnow: { value: snow }, uSoil: { value: soil }, uMoss: { value: moss }, uGlow: { value: glow },
    uStyleA: { value: new THREE.Vector4(st.strataH, st.strata, st.runnel, st.ripple) },
    uStyleB: { value: new THREE.Vector4(st.moss, st.blocks, st.hue, st.glow) },
    uGrassK: { value: st.grassK },
    tSunVis: { value: null },
    uSunVisMatrix: { value: new THREE.Matrix4() },
    uSunVisOn: { value: 0 },
    uSunVisParams: { value: new THREE.Vector4(1, 0.001, 20, 0) },
  };

  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  material.name = 'TerrainMaterial';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <beginnormal_vertex>', VERT_NORMAL)
      .replace('#include <begin_vertex>', VERT_BEGIN);
    const lights = THREE.ShaderChunk.lights_fragment_begin.replace(
      'getDirectionalLightInfo( directionalLight, directLight );',
      'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= tSunVisF;'
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_SURFACE)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n\tnormal = normalize( ( viewMatrix * vec4( tN, 0.0 ) ).xyz );\n\tnonPerturbedNormal = normalize( ( viewMatrix * vec4( tGeoN, 0.0 ) ).xyz );')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += tEmit;')
      .replace('#include <lights_fragment_begin>', lights)
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n\treflectedLight.indirectDiffuse *= tAO;\n\treflectedLight.indirectSpecular *= tAO * tAO;\n\treflectedLight.directDiffuse *= mix( 1.0, tAO, 0.35 );');
  };
  material.customProgramCacheKey = () => 'reveries-terrain-v2';
  return { material, uniforms };
}
