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
  karst: { strataH: 7, strata: 0.8, runnel: 0.4, ripple: 0.2, moss: 0.8, blocks: 1.0, hue: 0.35, glow: 0, grassK: 1 },
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
  // pixel footprint on the surface: grows at grazing incidence → octaves fade
  // before they alias into streaks/smears
  float nv = abs( dot( normalize( ( viewMatrix * vec4( Ng, 0.0 ) ).xyz ), normalize( -vViewPosition ) ) );
  float pix = max( vDist * uPixelAngle / max( nv, 0.22 ), 1e-4 );
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
  shore *= 1.0 - 0.75 * smoothstep( 6.0, 40.0, pix );
  float sandW = max( sandA, shore * ( 1.0 - rockSlope ) );
  float soilW = clamp( smoothstep( 0.1, 0.24, slope + meso * 0.06 ) + ( 1.0 - smoothstep( 0.12, 0.35, moist ) ) * 0.5, 0.0, 1.0 );
  // snow: wind-scoured off convex crests and steep faces (bare rock ribs), packed into
  // gullies, couloirs and lee hollows; ragged multi-scale edge → rock shows through
  float snowW;
  {
    float gully = smoothstep( 0.5, 0.62, cav ), ridge = smoothstep( 0.48, 0.36, cav );
    float hold = 1.0 - smoothstep( 0.1 + 0.12 * gully, 0.3 + 0.16 * gully, slope + meso * 0.05 + m1.w * 0.03 );
    float cover = snowA * 1.35 - 0.12 + gully * 0.25 - ridge * 0.3 * smoothstep( 0.04, 0.16, slope );
    cover += ( m2.w * 0.22 + m1.w * 0.16 + m3.w * 0.12 ) * ( 1.0 - 0.5 * smoothstep( 0.9, 1.3, snowA * 1.35 ) );
    snowW = smoothstep( 0.38, 0.62, cover ) * hold * step( 0.02, snowA );
  }

  // ---- strata coordinate (radial height, gently warped) ----
  float strataH = uStyleA.x;
  float sCoord = ( h + m2.w * strataH * 0.45 + m3.w * strataH * 0.12 ) / strataH;
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
    gSoil += g1.xyz * 0.018 * w; hGrass += g1.w * 0.5; // soft ground: detail via albedo/AO, not normal waves (no 'crumpled plastic')
    w = octW( 1.0, pix );
    if ( w > 0.0 ) { vec4 g2 = nA( D + 8.8, 1.0 ); gSoil += g2.xyz * 0.012 * w; hGrass += g2.w * 0.3 * w; }
    w = octW( 0.5, pix );
    if ( w > 0.0 ) { vec4 pb = nB( D.yzx + 2.0, 0.5 ); peb = ( 1.0 - smoothstep( 0.0, 0.45, pb.x ) ) * w; hGrass += peb * 0.2; }
  }

  // ================= ROCK =================
  vec3 gRock = vec3( 0.0 );
  float hRock = 0.0;
  float crack = 0.0;
  if ( rockW > 0.004 ) {
    // large-scale structure (32 m / 8 m lattices + 16 m fractured slabs): keeps
    // mid-distance cliffs and shoulders reading as broken rock, not clay
    gRock += m2.xyz * 5.0 * octW( 1.0 / 256.0, pix ) + m3.xyz * 2.2 * octW( 1.0 / 64.0, pix );
    hRock += m3.w * 0.35;
    // 20–40 m slabs: piecewise-planar facets readable from hundreds of metres
    {
      vec4 cX = nB( D.zxy + 41.0, 1.0 / 320.0 );
      vec3 tiltX = vec3( hash11( cX.z * 13.7 ), hash11( cX.z * 51.1 + 1.9 ), hash11( cX.z * 29.3 + 6.2 ) ) - 0.5;
      float fX = smoothstep( 0.0, 0.1, cX.y ) * uStyleB.y * octW( 1.0 / 320.0, pix );
      gRock += tiltX * 1.1 * fX;
      hRock += ( hash11( cX.z * 77.7 ) - 0.5 ) * 0.5 * fX;
      crack = max( crack, ( 1.0 - smoothstep( 0.0, 0.035, cX.y ) ) * fX * 0.9 );
    }
    float bwL = octW( 1.0 / 128.0, pix ) * uStyleB.y;
    {
      vec4 cL = nB( D.yzx + 17.0, 1.0 / 128.0 );
      vec3 tiltL = vec3( hash11( cL.z * 19.1 ), hash11( cL.z * 67.3 + 2.1 ), hash11( cL.z * 7.9 + 4.4 ) ) - 0.5;
      gRock += tiltL * 0.75 * smoothstep( 0.0, 0.08, cL.y ) * bwL;
      crack = ( 1.0 - smoothstep( 0.0, 0.05, cL.y ) ) * bwL * 0.8;
      hRock += ( hash11( cL.z * 33.3 ) - 0.5 ) * 0.4;
    }
    w = octW( 1.0 / 32.0, pix );
    if ( w > 0.0 ) { vec4 o1 = nA( D + 7.1, 1.0 / 32.0 ); gRock += o1.xyz * 1.2 * w; hRock += o1.w * 0.5 * w; }
    w = octW( 1.0 / 8.0, pix );
    if ( w > 0.0 ) { vec4 o2 = nA( D.yzx + 2.3, 1.0 / 8.0 ); gRock += o2.xyz * 0.32 * w; hRock += o2.w * 0.25 * w; }
    w = octW( 0.5, pix );
    if ( w > 0.0 ) { vec4 o3 = nA( D.zxy + 5.9, 0.5 ); gRock += o3.xyz * 0.06 * w; hRock += o3.w * 0.12 * w; }
    w = octW( 2.0, pix );
    if ( w > 0.0 ) { vec4 o4 = nA( D + 1.7, 2.0 ); gRock += o4.xyz * 0.012 * w; hRock += o4.w * 0.06 * w; }
    // vertical runnels: noise in a space compressed along 'up'
    float runMask = smoothstep( -0.25, 0.45, m3.w + m2.w * 0.5 );
    float rw = octW( 1.0 / 8.0, pix ) * uStyleA.z * smoothstep( 0.25, 0.6, slope ) * runMask;
    if ( rw > 0.0 ) {
      vec3 Dq = D - up * dot( D, up ) * 0.6;
      vec4 r1 = nA( Dq + 11.0, 1.0 / 8.0 );
      gRock += ( r1.xyz - up * dot( r1.xyz, up ) ) * 0.35 * rw;
      hRock += r1.w * 0.3 * rw;
    }
    // large runnels / gullies visible from afar
    float rw2 = octW( 1.0 / 64.0, pix ) * uStyleA.z * smoothstep( 0.3, 0.7, slope ) * ( 0.4 + 0.6 * runMask );
    if ( rw2 > 0.0 ) {
      vec3 Dq = D - up * dot( D, up ) * 0.75;
      vec4 r2 = nA( Dq.zxy + 3.0, 1.0 / 64.0 );
      gRock += ( r2.xyz - up * dot( r2.xyz, up ) ) * 2.5 * rw2;
      hRock += r2.w * 0.4 * rw2;
    }
    // blocks / joints (Worley cell borders → cracks) + fractured facets:
    // every cell is a planar block face with its own tilt (piecewise-constant
    // normal) → reads as broken stone, not noise. Two scales: 4 m slabs, 1 m chips.
    float bw = octW( 1.0 / 32.0, pix ) * uStyleB.y;
    if ( bw > 0.0 ) {
      vec4 c1 = nB( D + 0.5, 1.0 / 32.0 );
      crack = max( crack, ( 1.0 - smoothstep( 0.0, 0.07, c1.y ) ) * bw );
      hRock -= crack * 0.5;
      vec3 tilt = vec3( hash11( c1.z * 97.1 ), hash11( c1.z * 31.7 + 3.1 ), hash11( c1.z * 13.3 + 7.7 ) ) - 0.5;
      float fw = bw * smoothstep( 0.0, 0.12, c1.y );
      gRock += tilt * 0.9 * fw;
      hRock += ( hash11( c1.z * 57.3 ) - 0.5 ) * 0.35 * fw;
      float bw2 = octW( 1.0 / 8.0, pix ) * uStyleB.y;
      if ( bw2 > 0.0 ) {
        vec4 c2 = nB( D.zxy + 9.5, 1.0 / 8.0 );
        float crack2 = ( 1.0 - smoothstep( 0.0, 0.06, c2.y ) ) * bw2;
        vec3 tilt2 = vec3( hash11( c2.z * 71.3 ), hash11( c2.z * 23.9 + 1.3 ), hash11( c2.z * 41.1 + 5.5 ) ) - 0.5;
        gRock += tilt2 * 0.55 * bw2 * smoothstep( 0.0, 0.1, c2.y );
        crack = max( crack, crack2 * 0.7 );
        hRock -= crack2 * 0.25;
      }
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
    // slip faces only where the surface really is steep: low-amplitude crests must not print lines
    leeF = smoothstep( 0.04, 0.3, dot( Ng, wt ) ) * sandA * smoothstep( 0.03, 0.12, slope ); // slope = 1-cos: 14°..28°
    vec3 wb = cross( up, wt );
    vec4 wq = nA( D + 21.0, 1.0 / 16.0 );
    // primary ripples (~0.22 m) + megaripples (~1.6 m), curved by noise
    // ~12 cm wind ripples; a 1 m phase warp makes them bifurcate (Y-junctions)
    vec4 wf = octW( 1.0 / 8.0, pix ) > 0.0 ? nA( D.yzx + 7.0, 1.0 / 8.0 ) : vec4( 0.0 );
    vec4 wl4 = nA( D.zxy + 13.0, 1.0 / 32.0 );
    float lam = 0.16 * ( 1.0 + 0.5 * wl4.w );   // 8–24 cm ripples, coarser in patches
    float ph1 = dot( D, wt ) / lam + wq.w * 2.5 + wf.w * 1.6 + dot( D, wb ) * 0.2;
    vec4 wq2 = nA( D.zxy + 5.0, 1.0 / 64.0 );
    float lam2 = 1.6 * ( 1.0 + 0.35 * wl4.w );
    float ph2 = dot( D, wt ) / lam2 + wq.w * 2.6 + wq2.w * 4.5 + dot( D, wb ) * ( 0.05 + 0.12 * wq2.w );
    float f1 = fract( ph1 ), f2 = fract( ph2 );
    float bl1 = 1.0 - smoothstep( 0.12, 0.4, fwidth( ph1 ) ), bl2 = 1.0 - smoothstep( 0.12, 0.4, fwidth( ph2 ) );
    // asymmetric profile: long stoss slope, steep lee face
    float p1 = f1 < 0.75 ? f1 / 0.75 : ( 1.0 - f1 ) / 0.25;
    float d1 = f1 < 0.75 ? 1.0 / 0.75 : -1.0 / 0.25;
    float p2 = f2 < 0.7 ? f2 / 0.7 : ( 1.0 - f2 ) / 0.3;
    float d2 = f2 < 0.7 ? 1.0 / 0.7 : -1.0 / 0.3; d2 /= lam2 / 1.6;
    // ripples die on slip faces and on the knife-edge brink (cav < 0.5 → convex)
    float crestF = smoothstep( 0.47, 0.4, cav ) * smoothstep( 0.01, 0.05, slope );
    float w1 = octW( 3.0, pix ) * uStyleA.w * ( 1.0 - 0.95 * leeF ) * ( 1.0 - 0.7 * crestF ) * ( 0.25 + 0.75 * smoothstep( -0.5, 0.4, wq.w + wf.w * 0.4 ) ) * bl1;
    // megaripples come in patches (coarse lag sand), never as wall-to-wall stripes
    float w2 = octW( 0.5, pix ) * uStyleA.w * ( 1.0 - 0.8 * leeF ) * smoothstep( 0.5, 0.95, wq2.w + wq.w * 0.35 ) * 0.7 * bl2;
    // crisp wind ripples catching the light; megaripples are rare, gentle patches
    gSand += wt * ( d1 / lam ) * 0.005 * w1 + wt * ( d2 / 1.6 ) * 0.006 * w2;
    hSand = p1 * 0.2 * w1 + p2 * 0.4 * w2 + wq.w * 0.3;
    rippleShade = ( p1 - 0.5 ) * w1;
    w = octW( 0.25, pix );
    if ( w > 0.0 ) { vec4 s1 = nA( D.yzx, 0.25 ); gSand += s1.xyz * 0.015 * w; }
    // grain sparkle (1 cm-ish facets), very subtle
    w = octW( 4.0, pix );
    if ( w > 0.0 ) { vec4 s2 = nA( D.zxy + 3.3, 4.0 ); gSand += s2.xyz * 0.004 * w; }
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
  rockCol = mix( rockCol, uSand * ( 0.86 + 0.1 * meso ), ( 1.0 - smoothstep( 0.08, 0.34, slope ) ) * ( 0.7 + 0.2 * step( 0.99, uStyleA.w ) ) * uStyleA.w * uStyleA.w * ( 1.0 - crack * 0.6 ) );
  // dark streaks down the walls, pale dry crowns
  float streak = clamp( 0.5 - hRock * 0.9, 0.0, 1.0 ) * uStyleA.z * smoothstep( 0.3, 0.7, slope );
  rockCol *= 1.0 - streak * ( 0.12 + 0.18 * uStyleA.z );
  // bedding planes: thin dark recessed joints between beds + pale weathered lips on walls,
  // broken by vertical joints (Worley) so they read as stacked limestone blocks, not paint
  {
    float bedW = uStyleA.y * wallK * octW( 0.25 / strataH, pix );
    if ( bedW > 0.0 ) {
      float seam = 1.0 - smoothstep( 0.0, 0.07, sFrac ) * smoothstep( 1.0, 0.93, sFrac );
      float lip = smoothstep( 0.07, 0.16, sFrac ) * ( 1.0 - smoothstep( 0.16, 0.34, sFrac ) );
      vec4 jc = nB( D - up * dot( D, up ) * 0.65 + 23.0, 1.0 / 24.0 ); // columns: elongated along up
      float joint = ( 1.0 - smoothstep( 0.0, 0.05, jc.y ) ) * smoothstep( 0.4, 0.75, slope );
      rockCol *= 1.0 - bedW * ( seam * 0.45 + joint * 0.35 );
      rockCol *= 1.0 + bedW * lip * 0.12;
      crack = max( crack, bedW * ( seam * 0.6 + joint * 0.5 ) );
      rockCol *= 0.9 + 0.2 * hash11( sBand * 7.31 + floor( jc.z * 9.0 ) ) * bedW + 0.1 * ( 1.0 - bedW );
    }
  }
  // rain/biofilm streaks: long, dark-grey vertical stains hanging from ledges
  {
    vec3 Dv = D - up * dot( D, up ) * 0.8;
    float st2 = nA( Dv.yzx + 61.0, 1.0 / 24.0 ).w * 0.6 + nA( Dv + 5.0, 1.0 / 6.0 ).w * 0.4 * octW( 1.0 / 6.0, pix );
    // stains hang from each bedding lip and fade down the bed (not wall-high smears)
    float hang = mix( 1.0, 1.0 - smoothstep( 0.15, 0.95, 1.0 - sFrac ), uStyleA.y * 0.6 );
    float stain = smoothstep( 0.1, 0.5, st2 ) * smoothstep( 0.35, 0.8, slope ) * ( 0.4 + 0.6 * moist ) * uStyleB.x * hang;
    rockCol = mix( rockCol, rockCol * vec3( 0.52, 0.5, 0.49 ), stain * 0.32 );
  }
  // vista band (albedo only, 3–60 m): drainage gullies and pale ribs down the walls and
  // warm/cool weathering patches. Albedo cannot alias like normals, so it carries rock
  // character at 300 m – 3 km where the normal octaves have faded out.
  {
    vec3 Dv = D - up * dot( D, up ) * 0.85;
    float gul = nA( Dv.zxy + 7.0, 1.0 / 48.0 ).w * 0.7 + nA( Dv.yzx + 2.0, 1.0 / 16.0 ).w * 0.3 * octW( 1.0 / 16.0, pix * 0.5 );
    float gw = smoothstep( 0.22, 0.55, slope ) * octW( 1.0 / 48.0, pix * 0.35 );
    rockCol *= 1.0 - gw * smoothstep( 0.05, 0.6, gul ) * 0.38;
    rockCol *= 1.0 + gw * smoothstep( -0.15, -0.6, gul ) * 0.16;
    rockCol *= mix( vec3( 1.0 ), vec3( 1.07, 1.0, 0.9 ), smoothstep( -0.3, 0.5, m1.w ) * 0.5 );
    rockCol *= mix( vec3( 1.0 ), vec3( 0.9, 0.95, 1.04 ), smoothstep( 0.0, -0.6, m0.w ) * 0.4 );
  }
  // value structure: sunlit convex faces bright, recesses & cracks dark
  float convexity = clamp( ( 0.5 - cav ) * 3.0 + 0.5 + hRock * 0.35, 0.0, 1.0 );
  rockCol *= clamp( 1.0 + ( convexity - 0.5 ) * 0.7, 0.7, 1.16 );

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
    grassCol *= 1.0 + j1 * 0.14 + j2 * 0.07 * pw;
    grassCol = mix( grassCol, grassCol * vec3( 1.1, 1.0, 0.75 ), clamp( j1 + 0.5, 0.0, 1.0 ) * 0.25 * pws );
    bare = smoothstep( 0.86, 0.95, pc.z ) * smoothstep( 0.42, 0.18, pc.x ) * pw;
  }
  // desaturate a touch: real meadows are greyer than paint
  grassCol = mix( vec3( dot( grassCol, vec3( 0.3, 0.55, 0.15 ) ) ), grassCol, 0.8 );
  // hollows: lusher, darker; forests (beyond flora's reach) read as darker canopy masses
  grassCol *= 1.0 - 0.15 * conc;
  float farK = smoothstep( 3.0, 50.0, pix );
  float forest = smoothstep( 0.52, 0.78, moist + macro * 0.18 ) * smoothstep( 0.22, 0.42, temp );
  grassCol = mix( grassCol, grassCol * vec3( 0.6, 0.7, 0.62 ), forest * ( 0.2 + 0.25 * farK ) );
  grassCol = mix( dry, grassCol, smoothstep( 0.18, 0.55, moist + macro * 0.12 ) );
  grassCol = mix( grassCol, grassCol * vec3( 1.08, 1.0, 0.72 ), smoothstep( 0.55, 0.85, temp ) * 0.5 );
  // cold steppe / tundra: olive-brown bands toward the poles and the heights
  grassCol = mix( grassCol, mix( uSoil, uGround3, 0.45 ) * ( 0.9 + 0.15 * macro ), smoothstep( 0.4, 0.22, temp + meso * 0.04 ) * 0.65 );
  grassCol *= 0.82 + 0.3 * ( hGrass * 0.5 + 0.5 );
  // ---- landscape mosaic (100 m – 5 km): woodland / meadow / scrub, smooth & drainage-led ----
  // continuous fields only (no Worley cell IDs → no hard-edged camo parcels from the air):
  // valleys & hollows (worker cavity) and moist ground run greener and darker (riparian
  // woodland follows the drainage), convex crests and sun-baked slopes go dry and golden
  {
    float vg = m1.w * 0.55 + m2.w * 0.3 + m0.w * 0.3;               // 0.25–4 km smooth variation
    float drain = smoothstep( 0.47, 0.62, cav ) - smoothstep( 0.46, 0.34, cav ) * 0.8;
    float woodF = smoothstep( 0.05, 0.45, vg + ( moist - 0.5 ) * 0.9 + drain * 0.35 );
    float scrubF = smoothstep( 0.1, 0.5, -vg - ( moist - 0.5 ) * 0.7 - drain * 0.3 );
    float farM = 0.4 + 0.6 * smoothstep( 1.0, 12.0, pix );
    grassCol = mix( grassCol, grassCol * vec3( 0.7, 0.8, 0.72 ), woodF * farM * smoothstep( 0.25, 0.45, moist ) * 0.8 );
    grassCol = mix( grassCol, mix( grassCol, uGround3, 0.45 ) * vec3( 1.06, 1.0, 0.84 ), scrubF * farM * 0.55 );
  }
  // physically plausible floor: meadows are never darker than ~0.07 linear
  {
    float gl = dot( grassCol, vec3( 0.2126, 0.7152, 0.0722 ) );
    grassCol *= clamp( 0.075 / max( gl, 1e-3 ), 1.0, 1.7 );
  }
  // ---- near-field ground cover (0.1–1 m): the earth between the grass blades ----
  // clumps of turf with dark soil gaps, leaf litter / dry thatch specks and
  // small embedded stones, so sparse grass reads as ground, not paint.
  float stoneN = 0.0, groundAO = 1.0;
  {
    float wc = octW( 1.0 / 4.0, pix );
    if ( wc > 0.0 ) {
      vec4 cl = nB( D.zxy + 31.0, 1.0 / 4.0 );           // ~0.5 m turf clumps
      float gap = smoothstep( 0.1, 0.0, cl.y ) * ( 0.55 + 0.45 * smoothstep( 0.3, 0.7, cl.z ) );
      vec3 dirt = mix( uSoil * 0.85, uSoil * vec3( 1.1, 0.98, 0.86 ), cl.w );
      dirt *= clamp( 0.11 / max( dot( dirt, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-3 ), 1.0, 2.2 );
      grassCol *= 1.0 + ( cl.z - 0.5 ) * 0.22 * wc;           // clump-to-clump value jitter
      grassCol = mix( grassCol, grassCol * vec3( 1.12, 1.06, 0.8 ), smoothstep( 0.7, 0.95, cl.z ) * 0.5 * wc );
      grassCol = mix( grassCol, dirt, gap * 0.75 * wc );
      groundAO -= gap * 0.25 * wc; // turf gaps sit in the shade of the blades
      float wl = octW( 1.0 / 1.5, pix );
      if ( wl > 0.0 ) {
        vec4 lt = nB( D.yzx + 3.0, 1.0 / 1.5 );          // ~19 cm litter flakes
        float leaf = smoothstep( 0.22, 0.1, lt.x ) * step( 0.72, lt.z ) * wl;
        vec3 leafC = mix( uGround3 * vec3( 1.2, 0.95, 0.6 ), uSoil * vec3( 1.5, 1.1, 0.75 ), fract( lt.z * 7.3 ) );
        grassCol = mix( grassCol, leafC, leaf * 0.7 );
      }
      float ws = octW( 1.0 / 2.0, pix );
      if ( ws > 0.0 ) {
        vec4 sn = nB( D + 17.0, 1.0 / 2.0 );             // ~25 cm cells, sparse pebbles
        float st = smoothstep( 0.3, 0.18, sn.x ) * step( 0.86, sn.z ) * ws;
        stoneN = st;
        groundAO *= 1.0 - 0.55 * ( smoothstep( 0.4, 0.3, sn.x ) * step( 0.86, sn.z ) * ws - st ); // contact ring
        vec3 pebC = mix( uRockA, uRockB, fract( sn.z * 13.1 ) ) * ( 0.75 + 0.5 * smoothstep( 0.3, 0.0, sn.x ) );
        grassCol = mix( grassCol, pebC, st );
      }
    }
  }
  // aspect: equator-facing slopes sun-baked (warmer, drier), pole-facing lush & cool
  {
    vec3 tg = Ng - up * dot( Ng, up );
    vec3 eq = vec3( 0.0, 1.0, 0.0 ) - up * up.y;
    float asp = dot( tg, normalize( eq + vec3( 1e-5 ) ) ) * ( up.y > 0.0 ? -1.0 : 1.0 );
    float a01 = clamp( asp * 3.0, -1.0, 1.0 );
    grassCol *= mix( vec3( 1.0 ), a01 > 0.0 ? vec3( 1.1, 1.04, 0.84 ) : vec3( 0.86, 0.95, 0.96 ), abs( a01 ) * 0.6 );
  }
  {
    float gl2 = dot( grassCol, vec3( 0.2126, 0.7152, 0.0722 ) );
    grassCol *= clamp( 0.07 / max( gl2, 1e-3 ), 1.0, 1.5 );
  }
  // soil / scree
  vec3 soilCol = mix( uSoil, uSoil * 1.25, hGrass * 0.5 + 0.5 );
  soilCol = mix( soilCol, uRockA * 0.9, 0.25 + peb * 0.4 );
  vec3 sandCol = uSand * ( 0.9 + 0.12 * macro + 0.07 * rippleShade );
  // troughs: darker, redder (iron-stained, coarse lag); crests paler & finer
  float trough = smoothstep( 0.52, 0.62, cav );
  sandCol = mix( sandCol, sandCol * vec3( 0.92, 0.84, 0.77 ), trough * 0.45 );
  sandCol *= 1.0 + 0.06 * meso;
  // lee (slip) faces: finer, darker avalanche sand; crests catch light
  sandCol *= 1.0 - 0.17 * leeF;
  // knife-edge brink: a soft bright line where the stoss slope turns over into the slip face
  sandCol *= 1.0 + 0.12 * smoothstep( 0.46, 0.36, cav ) * smoothstep( 0.02, 0.08, slope ) * ( 1.0 - leeF );
  vec3 snowCol = uSnow * ( 0.94 + 0.06 * meso );

  // ---- composite with height-based blending ----
  soilW = max( soilW, bare );
  float wSoil = hblend( soilW, hGrass * 0.3, 0.0, 0.35 );
  vec3 albedo = mix( grassCol, soilCol, wSoil );
  vec3 gN = gSoil * ( 1.0 + 0.6 * wSoil );
  float rough = mix( 0.92, 0.95, wSoil );
  rough = mix( rough, 0.72, stoneN * ( 1.0 - wSoil ) );
  float wSand = sandW > 0.004 ? hblend( sandW, hSand * 0.2, hGrass * 0.2, 0.35 ) : 0.0;
  albedo = mix( albedo, sandCol, wSand );
  gN = mix( gN, gSand, wSand );
  rough = mix( rough, 0.88, wSand );
  float wRock = rockW > 0.004 ? hblend( rockW, hRock * 0.6, 0.0, 0.3 ) : 0.0;
  albedo = mix( albedo, rockCol, wRock );
  gN = mix( gN, gRock, wRock );
  rough = mix( rough, min( 0.97, 0.8 + 0.12 * crack + 0.1 * smoothstep( 0.5, 12.0, pix ) ), wRock );

  // vegetation clinging to ledges, bedding tops and the gentler rock in moist climates
  // (shrub tufts → far: a broken green veil that gives cliffs scale, Guilin / Ghibli)
  {
    float ledgeV = 1.0 - smoothstep( 0.28, 0.6, slope + meso * 0.08 );
    float bedTop = smoothstep( 0.72, 0.96, sFrac ) * smoothstep( 0.3, 0.7, slope ) * uStyleA.y;
    float clingK = clamp( ledgeV * 0.85 + bedTop * 0.8, 0.0, 1.0 ) * smoothstep( 0.32, 0.62, moist ) * uGrassK * ( 1.0 - snowW ) * ( 1.0 - sandA );
    if ( clingK * wRock > 0.01 ) {
      vec4 vt = nB( D.zxy + 3.0, 1.0 / 16.0 );       // ~2 m shrub tufts
      float tuft = mix( smoothstep( 0.55, 0.2, vt.x ), 0.45 + 0.25 * meso, smoothstep( 0.4, 3.0, pix ) );
      float cw = smoothstep( 0.32, 0.62, clingK * ( 0.55 + 0.7 * tuft ) + meso * 0.12 + m3.w * 0.06 );
      vec3 shrub = grassCol * vec3( 0.62, 0.7, 0.6 ) * ( 0.8 + 0.4 * vt.z );
      albedo = mix( albedo, shrub, cw * wRock * 0.85 );
      gN = mix( gN, gSoil, cw * wRock * 0.6 );
      rough = mix( rough, 0.95, cw * wRock );
    }
  }
  // moss / lichen on rock: up-facing ledges in moist climates
  vec3 gT0 = gN - Ng * dot( gN, Ng );
  float mossW = uStyleB.x * wRock * smoothstep( 0.35, 0.75, moist ) * smoothstep( 0.78, 0.86, dot( normalize( Ng - gT0 * 0.12 ), up ) + meso * 0.05 ) * ( 1.0 - snowW );
  albedo = mix( albedo, uMoss * ( 0.8 + 0.3 * hGrass ), mossW * 0.85 );

  // snow on top
  float wSnow = snowW > 0.004 ? hblend( snowW, 0.0, hRock * 0.7 * wRock, 0.22 ) : 0.0;
  albedo = mix( albedo, snowCol, wSnow );
  gN = mix( gN, gSoil * 0.4, wSnow );
  rough = mix( rough, 0.55, wSnow );

  // ---- far field: ridges catch light, valleys pool shade (legible relief at 1–20 km) ----
  {
    float farR = smoothstep( 2.0, 25.0, pix );
    float rv = smoothstep( 0.4, 0.62, cav );
    albedo *= mix( 1.0, mix( 1.0 + 0.1 * ( 1.0 - wRock ) * ( 1.0 - wSnow ), 0.72, rv ), farR * ( 1.0 - 0.75 * wSand ) ); // dune troughs: no dark crease lines
    // exposed rock streaks on steep far slopes
    albedo = mix( albedo, rockCol * 0.9, farR * smoothstep( 0.22, 0.45, slope ) * smoothstep( -0.2, 0.3, meso ) * ( 1.0 - wSnow ) * ( 1.0 - wRock ) * 0.6 );
  }
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
  float ao = clamp( 1.0 - ( cav - 0.53 ) * 1.5, 0.5, 1.0 );
  ao *= 1.0 - crack * 0.6 * wRock;
  ao *= mix( 1.0, 0.75 + 0.25 * clamp( hRock + 0.5, 0.0, 1.0 ), wRock );
  ao *= mix( 0.9 + 0.1 * clamp( hGrass * 0.5 + 0.5, 0.0, 1.0 ), 1.0, max( wRock, wSand ) );
  ao *= mix( clamp( groundAO, 0.62, 1.0 ), 1.0, max( max( wRock, wSand ), wSnow ) );
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
  if (style === 'dunes') { rock.lerp(sand, 0.5); rockB.lerp(sand, 0.45); rockC.lerp(sand, 0.35); }
  // karst: pale grey-beige limestone, chalky beds and dark stained beds
  if (style === 'karst') { rock.lerp(new THREE.Color('#b9b2a2'), 0.85); rockB.copy(rock).lerp(new THREE.Color('#ddd6c6'), 0.6); rockC.copy(rock).lerp(new THREE.Color('#55584f'), 0.5); }
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
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n\treflectedLight.indirectDiffuse *= tAO;\n\treflectedLight.indirectSpecular *= tAO * tAO;\n\treflectedLight.directDiffuse *= mix( 1.0, tAO, 0.15 );');
  };
  material.customProgramCacheKey = () => 'reveries-terrain-v4';

  // Shadow-map caster. Shadows render back faces (three's default for FrontSide), which
  // on a heightfield are exactly the slopes facing away from the light — plus the chunk
  // SKIRTS, whose outward walls hang below every chunk edge. Drawn into the shadow map,
  // the skirts cast thin, perfectly straight dark lines along chunk seams onto downhill
  // ground. Skirt vertices (index >= SKIRT0, set by Terrain) are discarded here. The
  // caster also gets the same CDLOD geomorph as the visible surface, measured from the
  // VIEW camera (uMorphCam, set by Terrain each frame): cameraPosition is the light here.
  const depthUniforms = { uLodK: uniforms.uLodK, uFaceSize: uniforms.uFaceSize, uMorphCam: { value: new THREE.Vector3() } };
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMaterial.defines = { SKIRT0: 4225 };
  depthMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, depthUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aMorph;\nattribute vec4 aNrm;\nuniform float uLodK;\nuniform float uFaceSize;\nuniform vec3 uMorphCam;\nvarying float vSkirt;')
      .replace('#include <begin_vertex>', `float tLevel = floor( aNrm.w * 127.0 + 0.5 );
float tDist = length( ( modelMatrix[ 3 ].xyz - uMorphCam ) + position );
float tParent = uLodK * uFaceSize * exp2( 1.0 - tLevel );
float tMorph = tLevel > 0.5 ? smoothstep( 0.6, 0.92, tDist / tParent ) : 0.0;
vec3 transformed = position + aMorph * tMorph;
vSkirt = gl_VertexID >= SKIRT0 ? 1.0 : 0.0;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vSkirt;')
      .replace('void main() {', 'void main() {\n\tif ( vSkirt > 0.001 ) discard;');
  };
  depthMaterial.customProgramCacheKey = () => 'reveries-terrain-depth-v2';
  return { material, uniforms, depthMaterial, depthUniforms };
}
