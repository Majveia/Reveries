// GPU particle-mesh N-body solver for ΛCDM structure formation (WebGL2 GPGPU).
//
//   • Particles live in float textures: displacement ψ = x − q from their
//     Lagrangian lattice site q, and canonical momentum p = a² dx/dt.
//   • Initial conditions: Gaussian random field δ_k (Cosmology.linearModes,
//     σ8-normalised ΛCDM spectrum) → 2LPT displacements & growing-mode momenta
//     at a = 0.02, all derived with GPU FFTs.
//   • Gravity: CIC mass assignment (particles rendered as 2×2 splats into a
//     padded 2D-tiled 3D grid, additive float blending, 2 z-slices each) →
//     Stockham radix-2 FFT (fragment passes along x, y, z) → Green's function
//     with CIC compensation → spectral gradient (−∇Φ packed two-per-complex) →
//     inverse FFT → CIC force interpolation.
//   • Time integration: FastPM kick-drift-kick in the scale factor (exact
//     linear growth for any step size), comoving periodic box.
//   • Display: a finer lattice of "tracers" interpolates the Lagrangian
//     displacement field between particles (the dark-matter phase-space
//     sheet), carrying a heat value from local density and velocity
//     dispersion. Tracer states at consecutive steps are blended in the vertex
//     shader with the exact FastPM drift weight, so motion is continuous while
//     the expensive solve is amortised over many frames.
//
// Every GPU pass is a `yield` inside a generator, so callers can run a budget
// of passes per frame (real time) or drain the job synchronously (shot mode).

import * as THREE from 'three';
import { BOX, A_START, Growth, makeSchedule, linearModes, particleMass, COSMO } from './Cosmology.js';

// Quality tiers: n³ particles, M³ mesh, m³ tracers.
export const TIERS = [
  { n: 40, M: 64, m: 64, budget: 6 },     // low     64k particles · 262k tracers
  { n: 52, M: 64, m: 84, budget: 8 },     // medium 141k particles · 593k tracers
  { n: 64, M: 128, m: 128, budget: 12 },  // high   262k particles · 2.1M tracers
  { n: 100, M: 128, m: 160, budget: 16 }, // ultra  1.0M particles · 4.1M tracers
];

const VERT_FS = /* glsl */ `void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Tiled 3D layout helpers. Requires defines M (mesh size, power of two) and TX.
const GRID_GLSL = /* glsl */ `
ivec2 c2t(ivec3 c){ return ivec2((c.z % TX) * M + c.x, (c.z / TX) * M + c.y); }
ivec3 t2c(ivec2 p){ int tx = p.x / M; int ty = p.y / M; return ivec3(p.x - tx * M, p.y - ty * M, ty * TX + tx); }
ivec3 wrapc(ivec3 c){ return c & (M - 1); }
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
`;

// Particle lattice helpers. Requires defines NP (particles per side), PW (texture width), NTOT.
const LATTICE_GLSL = /* glsl */ `
ivec2 pidx2tex(int i){ return ivec2(i % PW, i / PW); }
int lat2idx(ivec3 l){ return (l.z * NP + l.y) * NP + l.x; }
ivec3 idx2lat(int i){ return ivec3(i % NP, (i / NP) % NP, i / (NP * NP)); }
int wrapn(int i){ return i < 0 ? i + NP : (i >= NP ? i - NP : i); }
`;

const FFT_FRAG = /* glsl */ `
uniform sampler2D tIn; uniform float uSub; uniform float uSign;
${GRID_GLSL}
void main(){
  ivec3 c = t2c(ivec2(gl_FragCoord.xy));
  int i = c[AXIS];
  int L = int(uSub + 0.5); int Ls = L / 2;
  ivec3 ce = c; ce[AXIS] = (i / L) * Ls + (i % Ls);
  ivec3 co = ce; co[AXIS] += M / 2;
  vec4 e = texelFetch(tIn, c2t(ce), 0);
  vec4 o = texelFetch(tIn, c2t(co), 0);
  float ang = uSign * 6.283185307179586 * float(i % L) / float(L);
  vec2 tw = vec2(cos(ang), sin(ang));
  gl_FragColor = vec4(e.xy + cmul(tw, o.xy), e.zw + cmul(tw, o.zw));
}`;

// k-space packing. MODE 0: gradient (−∇ of potential) packed as (Fx+iFy, Fz+iS).
// MODE 1: Hessian part A (dxx+idyy, dzz+idxy). MODE 2: Hessian part B (dxz+idyz, 0).
const KPACK_FRAG = /* glsl */ `
uniform sampler2D tIn; uniform float uScale; uniform float uKf; uniform float uSmooth2; uniform float uSmoothAmp; uniform float uDecon;
${GRID_GLSL}
void main(){
  ivec3 c = t2c(ivec2(gl_FragCoord.xy));
  ivec3 nn = c - M * (c / (M / 2));            // signed wavenumber index
  if (nn == ivec3(0)) { gl_FragColor = vec4(0.0); return; }
  vec3 k = vec3(nn) * uKf;
  float k2 = dot(k, k);
  vec3 kg = vec3(nn.x == -M / 2 ? 0.0 : k.x, nn.y == -M / 2 ? 0.0 : k.y, nn.z == -M / 2 ? 0.0 : k.z);
  vec2 d = texelFetch(tIn, ivec2(gl_FragCoord.xy), 0).xy;
  float f = uScale / k2;
  if (uDecon > 0.5) {
    // Compensate one power of the CIC window (assignment), sinc² per axis.
    vec3 h = 3.141592653589793 * vec3(nn) / float(M);
    vec3 s = vec3(nn.x == 0 ? 1.0 : sin(h.x) / h.x, nn.y == 0 ? 1.0 : sin(h.y) / h.y, nn.z == 0 ? 1.0 : sin(h.z) / h.z);
    float w = s.x * s.x * s.y * s.y * s.z * s.z;
    f /= max(w, 0.25);
    // mild anti-aliasing of the shortest modes
    f *= exp(-k2 * uSmooth2 * 0.18);
  }
#if MODE == 0
  float sm = uSmoothAmp * exp(-0.5 * k2 * uSmooth2);
  gl_FragColor = vec4(f * cmul(d, vec2(-kg.y, kg.x)), cmul(d, vec2(0.0, f * kg.z + sm)));
#elif MODE == 1
  gl_FragColor = vec4(f * cmul(d, vec2(kg.x * kg.x, kg.y * kg.y)), f * cmul(d, vec2(kg.z * kg.z, kg.x * kg.y)));
#else
  gl_FragColor = vec4(f * cmul(d, vec2(kg.x * kg.z, kg.y * kg.z)), 0.0, 0.0);
#endif
}`;

// 2LPT source term from the six second derivatives of φ1.
const SRC2_FRAG = /* glsl */ `
uniform sampler2D tA; uniform sampler2D tB;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 A = texelFetch(tA, p, 0), B = texelFetch(tB, p, 0);
  float s = A.x * A.y + A.x * A.z + A.y * A.z - A.w * A.w - B.x * B.x - B.y * B.y;
  gl_FragColor = vec4(s, 0.0, 0.0, 0.0);
}`;

// Particle initial conditions: sample ψ1, ψ2 at the lattice site (trilinear on the mesh).
const IC_FRAG = /* glsl */ `
uniform sampler2D tPsi1; uniform sampler2D tPsi2; uniform float uCoef1; uniform float uCoef2;
${GRID_GLSL}
${LATTICE_GLSL}
vec3 trilin(sampler2D t, vec3 g){
  vec3 i0 = floor(g); vec3 f = g - i0; ivec3 c0 = ivec3(i0);
  vec3 r = vec3(0.0);
  for (int dz = 0; dz < 2; dz++) for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++) {
    vec3 w3 = mix(1.0 - f, f, vec3(dx, dy, dz));
    r += w3.x * w3.y * w3.z * texelFetch(t, c2t(wrapc(c0 + ivec3(dx, dy, dz))), 0).xyz;
  }
  return r;
}
void main(){
  ivec2 tp = ivec2(gl_FragCoord.xy);
  int idx = tp.y * PW + tp.x;
  if (idx >= NTOT) { gl_FragColor = vec4(0.0); return; }
  vec3 g = (vec3(idx2lat(idx)) + 0.5) * (float(M) / float(NP));
  vec3 s1 = trilin(tPsi1, g), s2 = trilin(tPsi2, g);
  gl_FragColor = vec4(uCoef1 * s1 + uCoef2 * s2, 0.0);
}`;

// CIC deposit: each particle → 2 points (z-slices), each a 2×2 px splat into the padded tiled grid.
const DEPOSIT_VERT = /* glsl */ `
uniform sampler2D tPsi; uniform float uL; uniform vec2 uSize; uniform float uMass;
varying vec2 vCenter; varying float vW;
${LATTICE_GLSL}
void main(){
  int id = gl_VertexID; int idx = id >> 1; int zc = id & 1;
  vec3 q = (vec3(idx2lat(idx)) + 0.5) * (uL / float(NP));
  vec3 x = q + texelFetch(tPsi, pidx2tex(idx), 0).xyz;
  vec3 g = x * (float(M) / uL);
  g = g - float(M) * floor(g / float(M));
  g = min(g, vec3(float(M) - 1e-3));
  vec3 i0 = floor(g); vec3 f = g - i0;
  int iz = (int(i0.z) + zc) % M;
  vW = uMass * (zc == 0 ? 1.0 - f.z : f.z);
  vec2 origin = vec2(float(iz % TX), float(iz / TX)) * float(M + 1);
  vCenter = origin + g.xy + 0.5;
  gl_Position = vec4(vCenter / uSize * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 2.0;
}`;
const DEPOSIT_FRAG = /* glsl */ `
varying vec2 vCenter; varying float vW;
void main(){
  vec2 d = abs(gl_FragCoord.xy - vCenter);
  vec2 w = max(1.0 - d, 0.0);
  gl_FragColor = vec4(vW * w.x * w.y, 0.0, 0.0, 0.0);
}`;

// Fold the padded deposit (periodic wrap of the +1 column/row) into the mesh layout.
const FOLD_FRAG = /* glsl */ `
uniform sampler2D tPad;
${GRID_GLSL}
void main(){
  ivec3 c = t2c(ivec2(gl_FragCoord.xy));
  ivec2 o = ivec2(c.z % TX, c.z / TX) * (M + 1);
  float r = texelFetch(tPad, o + c.xy, 0).r;
  if (c.x == 0) r += texelFetch(tPad, o + ivec2(M, c.y), 0).r;
  if (c.y == 0) r += texelFetch(tPad, o + ivec2(c.x, M), 0).r;
  if (c.x == 0 && c.y == 0) r += texelFetch(tPad, o + ivec2(M, M), 0).r;
  gl_FragColor = vec4(r, 0.0, 0.0, 1.0);
}`;

// CIC force interpolation + kick, and drift.
const KICK_FRAG = /* glsl */ `
uniform sampler2D tPsi; uniform sampler2D tMom; uniform sampler2D tForce; uniform float uL; uniform float uK;
${GRID_GLSL}
${LATTICE_GLSL}
void main(){
  ivec2 tp = ivec2(gl_FragCoord.xy);
  int idx = tp.y * PW + tp.x;
  vec4 mom = texelFetch(tMom, tp, 0);
  if (idx >= NTOT) { gl_FragColor = vec4(0.0); return; }
  vec3 q = (vec3(idx2lat(idx)) + 0.5) * (uL / float(NP));
  vec3 g = (q + texelFetch(tPsi, tp, 0).xyz) * (float(M) / uL);
  vec3 i0 = floor(g); vec3 f = g - i0; ivec3 c0 = ivec3(i0);
  vec3 F = vec3(0.0);
  for (int dz = 0; dz < 2; dz++) for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++) {
    vec3 w3 = mix(1.0 - f, f, vec3(dx, dy, dz));
    F += w3.x * w3.y * w3.z * texelFetch(tForce, c2t(wrapc(c0 + ivec3(dx, dy, dz))), 0).xyz; // (Fx, Fy, Fz, S)
  }
  gl_FragColor = vec4(mom.xyz + F * uK, 0.0);
}`;
const DRIFT_FRAG = /* glsl */ `
uniform sampler2D tPsi; uniform sampler2D tMom; uniform float uD;
void main(){
  ivec2 tp = ivec2(gl_FragCoord.xy);
  gl_FragColor = vec4(texelFetch(tPsi, tp, 0).xyz + texelFetch(tMom, tp, 0).xyz * uD, 0.0);
}`;
const COPY_FRAG = /* glsl */ `uniform sampler2D tIn; void main(){ gl_FragColor = texelFetch(tIn, ivec2(gl_FragCoord.xy), 0); }`;

// Tracers: interpolate the Lagrangian displacement field between particles
// (phase-space sheet) and compute a heat value from density + velocity dispersion.
const TRACER_FRAG = /* glsl */ `
uniform sampler2D tPsi; uniform sampler2D tMom; uniform sampler2D tForce; uniform float uL; uniform float uA; uniform float uContrast;
${GRID_GLSL}
${LATTICE_GLSL}
void main(){
  ivec2 tp = ivec2(gl_FragCoord.xy);
  int t = tp.y * TW + tp.x;
  if (t >= MT * MT * MT) { gl_FragColor = vec4(0.0); return; }
  ivec3 lt = ivec3(t % MT, (t / MT) % MT, t / (MT * MT));
  vec3 u = (vec3(lt) + 0.5) * (float(NP) / float(MT)) - 0.5;
  vec3 i0 = floor(u); vec3 f = u - i0; ivec3 c0 = ivec3(i0);
  vec3 psi = vec3(0.0); vec3 vm = vec3(0.0); float v2 = 0.0;
  vec3 gx = vec3(0.0), gy = vec3(0.0), gz = vec3(0.0);
  for (int dz = 0; dz < 2; dz++) for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++) {
    ivec3 l = c0 + ivec3(dx, dy, dz);
    l = ivec3(wrapn(l.x), wrapn(l.y), wrapn(l.z));
    ivec2 pt = pidx2tex(lat2idx(l));
    vec3 w3 = mix(1.0 - f, f, vec3(dx, dy, dz));
    vec3 pc = texelFetch(tPsi, pt, 0).xyz;
    psi += w3.x * w3.y * w3.z * pc;
    // trilinear gradient of ψ in Lagrangian space (deformation tensor)
    vec3 sg = vec3(dx, dy, dz) * 2.0 - 1.0;
    gx += sg.x * w3.y * w3.z * pc; gy += sg.y * w3.x * w3.z * pc; gz += sg.z * w3.x * w3.y * pc;
    vec3 v = texelFetch(tMom, pt, 0).xyz / uA;
    vm += v; v2 += dot(v, v);
  }
  vm *= 0.125;
  // density of this phase-space stream: ρ = 1 / |det(I + ∇ψ)| (sharp, noise-free; caustics at shell crossing)
  float dq = uL / float(NP);
  mat3 J = mat3(1.0) + mat3(gx, gy, gz) / dq;
  float rhoSheet = 1.0 / max(abs(determinant(J)), 0.04);
  float sigma = sqrt(max(v2 * 0.125 - dot(vm, vm), 0.0)); // 100 km/s units
  vec3 x = (vec3(lt) + 0.5) * (uL / float(MT)) + psi;
  vec3 g = x * (float(M) / uL);
  vec3 j0 = floor(g); vec3 h = g - j0; ivec3 d0 = ivec3(j0);
  float rho = 0.0;
  for (int dz = 0; dz < 2; dz++) for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++) {
    vec3 w3 = mix(1.0 - h, h, vec3(dx, dy, dz));
    rho += w3.x * w3.y * w3.z * texelFetch(tForce, c2t(wrapc(d0 + ivec3(dx, dy, dz))), 0).w;
  }
  rho = max(1.0 + rho, 0.02);
  float rhoH = max(rho, min(rhoSheet, 8.0) * min(1.0, rho * 1.5));
  // heat: 0 voids … 0.2 sheets … 0.45 filaments … 0.7 groups … 1 cluster cores.
  // uContrast = D(a)^-0.6 keeps the young, low-contrast web legible.
  float heat = 0.2 + 0.31 * uContrast * log(rhoH) / log(10.0) + 0.022 * sigma;
  // per-tracer Lagrangian jitter inside its cell breaks the lattice pattern in voids
  uvec3 hq = uvec3(lt) * uvec3(1597334677u, 3812015801u, 2798796415u);
  uint hh = (hq.x ^ hq.y ^ hq.z) * 1597334677u;
  vec3 jit = vec3(float(hh & 1023u), float((hh >> 10) & 1023u), float((hh >> 20) & 1023u)) / 1023.0 - 0.5;
  // jitter scales with local expansion of the sheet (none in collapsed halos)
  float jitAmp = clamp(1.6 / rho, 0.0, 1.0) * 0.9;
  gl_FragColor = vec4(psi + jit * jitAmp * (uL / float(MT)), clamp(heat, 0.0, 1.2));
}`;

// Coarse density grid for the halo finder: (M/2)³ cells, 4 x-cells packed per texel.
const HALO_FRAG = /* glsl */ `
uniform sampler2D tRho;
${GRID_GLSL}
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  int tx = p.x / (H / 4); int ty = p.y / H;
  int hx0 = (p.x - tx * (H / 4)) * 4; int hy = p.y - ty * H; int hz = ty * HTX + tx;
  vec4 o = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    float s = 0.0;
    for (int dz = 0; dz < 2; dz++) for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++)
      s += texelFetch(tRho, c2t(ivec3((hx0 + k) * 2 + dx, hy * 2 + dy, hz * 2 + dz)), 0).r;
    o[k] = s;
  }
  gl_FragColor = o;
}`;

function makeRT(w, h, type = THREE.FloatType, format = THREE.RGBAFormat) {
  return new THREE.WebGLRenderTarget(w, h, {
    type, format, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
}

export class PMSolver {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    const tier = TIERS[Math.max(0, Math.min(3, opts.tier ?? 2))];
    this.tier = tier;
    this.L = opts.box ?? BOX;
    this.seed = opts.seed ?? 1;
    this.n = tier.n; this.M = tier.M; this.m = tier.m;
    this.N = this.n ** 3; this.T = this.m ** 3;
    this.budget = tier.budget;
    this.growth = new Growth(COSMO);
    this.schedule = makeSchedule(opts.steps ?? 40, opts.marks ?? [1 / 6, 1]);
    this.particleMass = particleMass(this.N, this.L); // M☉/h
    this.tracerMass = particleMass(this.T, this.L);

    const M = this.M;
    this.TX = M === 64 ? 8 : 16; this.TY = M / this.TX;
    this.GW = this.TX * M; this.GH = this.TY * M;
    this.PW = this.N > 600000 ? 1024 : this.N > 70000 ? 512 : 256;
    this.PH = Math.ceil(this.N / this.PW);
    this.TW = this.T > 1100000 ? 2048 : this.T > 300000 ? 1024 : 512;
    this.TH = Math.ceil(this.T / this.TW);
    this.H = M / 2; this.HTX = 8; this.HTY = this.H / this.HTX;

    const gl = renderer.getContext();
    this.floatBlend = renderer.extensions.has('EXT_float_blend');

    this._buildPipeline();
    this.k = 0; this.j = 0; this.job = null; this.version = 0;
    this.a = A_START;
    this.slotA = [A_START, A_START, A_START];
    this.early = null; // tracer snapshot at z ≈ 5
    this.onStep = null;
  }

  _buildPipeline() {
    const { M, TX, GW, GH, n, PW, PH, N, TW, TH, m } = this;
    const defs = { M, TX, NP: n, PW, NTOT: N, TW, MT: m, H: this.H, HTX: this.HTX };
    const mat = (frag, uniforms, extra = {}) => new THREE.ShaderMaterial({
      vertexShader: VERT_FS, fragmentShader: frag, uniforms, defines: { ...defs, ...extra },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.fsMesh = new THREE.Mesh(new THREE.BufferGeometry(), null);
    this.fsMesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.fsMesh.frustumCulled = false;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // mesh textures
    this.meshA = makeRT(GW, GH); this.meshB = makeRT(GW, GH); this.force = makeRT(GW, GH);
    const padType = this.floatBlend ? THREE.FloatType : THREE.HalfFloatType;
    this.pad = makeRT(TX * (M + 1), this.TY * (M + 1), padType, THREE.RedFormat);
    this.rho = makeRT(GW, GH, THREE.FloatType, THREE.RedFormat);
    // particles
    this.psi = [makeRT(PW, PH), makeRT(PW, PH)];
    this.mom = [makeRT(PW, PH), makeRT(PW, PH)];
    this.psi0 = makeRT(PW, PH); this.mom0 = makeRT(PW, PH);
    this.cur = 0; // index of current psi/mom
    // tracers (half float: displacement + heat)
    this.slots = [0, 1, 2].map(() => makeRT(TW, TH, THREE.HalfFloatType));
    this.haloRT = makeRT((this.H / 4) * this.HTX, this.H * this.HTY);

    this.fftMat = [0, 1, 2].map((ax) => mat(FFT_FRAG, { tIn: { value: null }, uSub: { value: 2 }, uSign: { value: -1 } }, { AXIS: ax }));
    const kpU = () => ({ tIn: { value: null }, uScale: { value: 1 }, uKf: { value: 2 * Math.PI / this.L }, uSmooth2: { value: 0 }, uSmoothAmp: { value: 0 }, uDecon: { value: 0 } });
    this.kpackMat = [0, 1, 2].map((mode) => mat(KPACK_FRAG, kpU(), { MODE: mode }));
    this.src2Mat = mat(SRC2_FRAG, { tA: { value: null }, tB: { value: null } });
    this.icMat = mat(IC_FRAG, { tPsi1: { value: null }, tPsi2: { value: null }, uCoef1: { value: 0 }, uCoef2: { value: 0 } });
    this.foldMat = mat(FOLD_FRAG, { tPad: { value: this.pad.texture } });
    this.kickMat = mat(KICK_FRAG, { tPsi: { value: null }, tMom: { value: null }, tForce: { value: this.force.texture }, uL: { value: this.L }, uK: { value: 0 } });
    this.driftMat = mat(DRIFT_FRAG, { tPsi: { value: null }, tMom: { value: null }, uD: { value: 0 } });
    this.copyMat = mat(COPY_FRAG, { tIn: { value: null } });
    this.tracerMat = mat(TRACER_FRAG, { tPsi: { value: null }, tMom: { value: null }, tForce: { value: this.force.texture }, uL: { value: this.L }, uA: { value: 1 }, uContrast: { value: 1 } });
    this.haloMat = mat(HALO_FRAG, { tRho: { value: this.rho.texture } });

    // deposit points: 2 vertices per particle
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(new Uint8Array(N * 2), 1));
    this.depositMat = new THREE.ShaderMaterial({
      vertexShader: DEPOSIT_VERT, fragmentShader: DEPOSIT_FRAG, defines: defs,
      uniforms: { tPsi: { value: null }, uL: { value: this.L }, uSize: { value: new THREE.Vector2(this.pad.width, this.pad.height) }, uMass: { value: (M * M * M) / N } },
      depthTest: false, depthWrite: false, blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    });
    dg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.depositPts = new THREE.Points(dg, this.depositMat);
    this.depositPts.frustumCulled = false;
  }

  // ---- low-level passes ------------------------------------------------------
  _pass(material, target) {
    const r = this.renderer;
    this.fsMesh.material = material;
    r.setRenderTarget(target);
    r.render(this.fsMesh, this.cam);
  }

  /** Full 3D FFT (sign −1 forward, +1 inverse, unnormalised). Yields per pass. Returns the output RT. */
  *_fft(inputTex, sign, finalTarget = null) {
    const stages = Math.log2(this.M);
    let src = inputTex, flip = false, out = null;
    for (let ax = 0; ax < 3; ax++) {
      const m = this.fftMat[ax];
      for (let s = 0; s < stages; s++) {
        const last = ax === 2 && s === stages - 1;
        out = last && finalTarget ? finalTarget : (flip ? this.meshB : this.meshA);
        if (out.texture === src) out = out === this.meshA ? this.meshB : this.meshA;
        m.uniforms.tIn.value = src; m.uniforms.uSub.value = 2 << s; m.uniforms.uSign.value = sign;
        this._pass(m, out);
        src = out.texture; flip = !flip;
        yield;
      }
    }
    return out;
  }

  *_kpack(mode, inputTex, target, scale, opts = {}) {
    const m = this.kpackMat[mode];
    m.uniforms.tIn.value = inputTex; m.uniforms.uScale.value = scale;
    m.uniforms.uDecon.value = opts.decon ? 1 : 0;
    const cell = this.L / this.M;
    m.uniforms.uSmooth2.value = opts.smooth != null ? (opts.smooth * cell) ** 2 : cell * cell;
    m.uniforms.uSmoothAmp.value = opts.smoothAmp ?? 0;
    this._pass(m, target);
    yield;
  }

  // ---- initial conditions ------------------------------------------------------
  /** Build 2LPT ICs. Synchronous generator (yields per pass). */
  *_icGen() {
    const { M, L } = this;
    const M3 = M * M * M;
    const data = linearModes(M, this.TX, L, this.seed, this.n / 2);
    const dk = new THREE.DataTexture(data, this.GW, this.GH, THREE.RGBAFormat, THREE.FloatType);
    dk.minFilter = dk.magFilter = THREE.NearestFilter; dk.needsUpdate = true;
    const tmp1 = makeRT(this.GW, this.GH), tmp2 = makeRT(this.GW, this.GH);
    // ψ1 = i k δ / k²
    yield* this._kpack(0, dk, this.meshB, 1 / M3);
    yield* this._fft(this.meshB.texture, 1, this.force); // force ← ψ1 (ψx, ψy, ψz in r, g, b)
    // φ1,ij
    yield* this._kpack(1, dk, this.meshB, 1 / M3);
    yield* this._fft(this.meshB.texture, 1, tmp1);
    yield* this._kpack(2, dk, this.meshB, 1 / M3);
    yield* this._fft(this.meshB.texture, 1, tmp2);
    this.src2Mat.uniforms.tA.value = tmp1.texture; this.src2Mat.uniforms.tB.value = tmp2.texture;
    this._pass(this.src2Mat, this.rho); yield;
    const sk = yield* this._fft(this.rho.texture, -1);
    // ψ2 = −i k s / k²
    const tgt = sk === this.meshA ? this.meshB : this.meshA;
    yield* this._kpack(0, sk.texture, tgt, -1 / M3);
    yield* this._fft(tgt.texture, 1, tmp1);
    // Particles. Packing put (ψx, ψy) in (r, g) and ψz in b.
    const g = this.growth, a0 = A_START;
    const u = this.icMat.uniforms;
    u.tPsi1.value = this.force.texture; u.tPsi2.value = tmp1.texture;
    u.uCoef1.value = g.D1(a0); u.uCoef2.value = g.D2(a0);
    this._pass(this.icMat, this.psi0); yield;
    u.uCoef1.value = g.Gp(a0); u.uCoef2.value = g.Gp2(a0);
    this._pass(this.icMat, this.mom0); yield;
    tmp1.dispose(); tmp2.dispose(); dk.dispose();
  }

  // ---- PM force ------------------------------------------------------------------
  *_forceGen(psiTex, a) {
    const r = this.renderer;
    const M3 = this.M ** 3;
    // deposit
    this.depositMat.uniforms.tPsi.value = psiTex;
    r.setRenderTarget(this.pad);
    r.setClearColor(0x000000, 0); r.clear(true, false, false);
    r.render(this.depositPts, this.cam);
    yield;
    this._pass(this.foldMat, this.rho); yield;
    const dk = yield* this._fft(this.rho.texture, -1);
    const tgt = dk === this.meshA ? this.meshB : this.meshA;
    // −∇Φ with ∇²Φ = 3/2 Ωm δ / a ; plus Gaussian-smoothed density in .w
    yield* this._kpack(0, dk.texture, tgt, (1.5 * COSMO.Om) / a / M3, { decon: true, smooth: 1.25, smoothAmp: 1 / M3 });
    yield* this._fft(tgt.texture, 1, this.force);
  }

  *_kick(K) {
    const u = this.kickMat.uniforms, c = this.cur, o = 1 - c;
    u.tPsi.value = this.psi[c].texture; u.tMom.value = this.mom[c].texture; u.uK.value = K;
    this._pass(this.kickMat, this.mom[o]);
    // mom ping-pong: swap only momentum
    const t = this.mom[c]; this.mom[c] = this.mom[o]; this.mom[o] = t;
    yield;
  }
  *_drift(D) {
    const u = this.driftMat.uniforms, c = this.cur, o = 1 - c;
    u.tPsi.value = this.psi[c].texture; u.tMom.value = this.mom[c].texture; u.uD.value = D;
    this._pass(this.driftMat, this.psi[o]);
    const t = this.psi[c]; this.psi[c] = this.psi[o]; this.psi[o] = t;
    yield;
  }
  *_tracers(target, a) {
    const u = this.tracerMat.uniforms;
    u.tPsi.value = this.psi[this.cur].texture; u.tMom.value = this.mom[this.cur].texture; u.uA.value = a;
    u.uContrast.value = Math.pow(Math.max(0.02, this.growth.D1(a)), -0.6);
    this._pass(this.tracerMat, target);
    yield;
  }
  _copy(src, dst) { this.copyMat.uniforms.tIn.value = src.texture; this._pass(this.copyMat, dst); }

  /** One FastPM KDK step k → k+1. */
  *_stepGen(tracers = true) {
    const g = this.growth, s = this.schedule;
    const a0 = s[this.k], a1 = s[this.k + 1], ah = Math.sqrt(a0 * a1);
    yield* this._kick(g.kick(a0, ah, a0));
    yield* this._drift(g.drift(a0, a1, ah));
    yield* this._forceGen(this.psi[this.cur].texture, a1);
    yield* this._kick(g.kick(ah, a1, a1));
    this.k++;
    this.a = a1;
    if (tracers) { yield* this._tracers(this.slots[this.k % 3], a1); this.slotA[this.k % 3] = a1; }
    if (this.early === null && Math.abs(a1 - 1 / 6) < 1e-6) {
      this.early = makeRT(this.TW, this.TH, THREE.HalfFloatType);
      yield* this._tracers(this.early, a1);
    }
    this.version++;
    this.onStep?.(this.k, a1);
  }

  /** (Re)start from the initial conditions: needs F(a_start) and the first tracer state. */
  *_startGen() {
    this._copy(this.psi0, this.psi[this.cur]); yield;
    this._copy(this.mom0, this.mom[this.cur]); yield;
    this.k = 0; this.j = 0; this.a = A_START;
    yield* this._forceGen(this.psi[this.cur].texture, A_START);
    yield* this._tracers(this.slots[0], A_START);
    this.slotA = [A_START, A_START, A_START];
    this.version++;
  }

  _drain(gen) { const r = this.renderer, prev = r.getRenderTarget(); for (const _ of gen); r.setRenderTarget(prev); }

  /** Build ICs and the initial state (synchronous; call during load). */
  async init(progress) {
    const r = this.renderer;
    const ac = r.autoClear; r.autoClear = false;
    try {
      const gen = this._icGen();
      let i = 0;
      for (const _ of gen) { if (++i % 24 === 0) { progress?.(Math.min(0.3, i / 400)); await new Promise((res) => setTimeout(res, 0)); } }
      this._drain(this._startGen());
    } finally { r.autoClear = ac; r.setRenderTarget(null); }
  }

  /** Synchronously evolve to scale factor aTarget (shot mode / title precompute). */
  async runTo(aTarget, progress) {
    const r = this.renderer;
    const ac = r.autoClear; r.autoClear = false;
    try {
      this.job = null;
      const start = this.k;
      while (this.k < this.schedule.length - 1 && this.schedule[this.k] < aTarget - 1e-9) {
        const last = this.schedule[this.k + 1] >= aTarget - 1e-9;
        this._drain(this._stepGen(last));
        progress?.((this.k - start) / Math.max(1, this._indexOf(aTarget) - start));
        await new Promise((res) => setTimeout(res, 0));
      }
      this.j = this.k; // display the latest state statically
      this.slotA[this.k % 3] = this.a;
    } finally { r.autoClear = ac; r.setRenderTarget(null); }
  }
  _indexOf(a) { const i = this.schedule.findIndex((x) => x >= a - 1e-9); return i < 0 ? this.schedule.length - 1 : i; }

  /** Synchronous restart (look-dev / shots). */
  restartSync() {
    const r = this.renderer, ac = r.autoClear; r.autoClear = false;
    try { this.job = null; this._restarting = false; this._drain(this._startGen()); } finally { r.autoClear = ac; r.setRenderTarget(null); }
  }

  /** Restart from a = 0.02 (asynchronously pumped). */
  restart() { this.job = this._startGen(); this._restarting = true; }

  /**
   * Advance the display toward aTarget; pump the background solve.
   * Returns the display state { prev, next, w, a }.
   */
  update(aTarget, budgetScale = 1) {
    const r = this.renderer;
    const ac = r.autoClear; r.autoClear = false;
    const prevRT = r.getRenderTarget();
    try {
      let budget = Math.max(1, Math.round(this.budget * budgetScale));
      while (budget > 0) {
        if (!this.job) {
          if (this._restarting) this._restarting = false;
          // compute ahead while the ring has room (k ≤ j + 1)
          if (this.k < this.schedule.length - 1 && this.k <= this.j + 1 && (this.schedule[this.k] < aTarget + 0.25 || this.k <= this.j)) this.job = this._stepGen(true);
          else break;
        }
        const res = this.job.next();
        budget--;
        if (res.done) this.job = null;
      }
    } finally { r.autoClear = ac; r.setRenderTarget(prevRT); }
    if (this._restarting) return this.display(A_START, true);
    return this.display(aTarget);
  }

  display(aTarget, frozen = false) {
    const s = this.schedule;
    if (frozen) { const sl = this.slots[0]; return { prev: sl, next: sl, w: 0, a: A_START }; }
    while (this.j + 1 <= this.k && aTarget >= s[this.j + 1] && this.j + 1 < this.k) this.j++;
    if (this.j >= this.k) { const sl = this.slots[this.k % 3]; return { prev: sl, next: sl, w: 0, a: s[this.k] }; }
    const a0 = s[this.j], a1 = s[this.j + 1];
    const a = Math.max(a0, Math.min(a1, aTarget));
    const g = this.growth;
    const w = (g.D1(a) - g.D1(a0)) / Math.max(1e-9, g.D1(a1) - g.D1(a0));
    return { prev: this.slots[this.j % 3], next: this.slots[(this.j + 1) % 3], w, a };
  }

  get busy() { return !!this.job; }

  /** Coarse density grid read back for the halo finder: Float32Array (M/2)³, units of mean density × 8. */
  readHaloGrid() {
    const r = this.renderer, prev = r.getRenderTarget();
    const ac = r.autoClear; r.autoClear = false;
    this._pass(this.haloMat, this.haloRT);
    r.autoClear = ac;
    const W = this.haloRT.width, Hh = this.haloRT.height;
    const buf = new Float32Array(W * Hh * 4);
    r.readRenderTargetPixels(this.haloRT, 0, 0, W, Hh, buf);
    r.setRenderTarget(prev);
    const H = this.H, out = new Float32Array(H * H * H);
    const q = H / 4;
    for (let py = 0; py < Hh; py++) {
      const ty = Math.floor(py / H), hy = py - ty * H;
      for (let px = 0; px < W; px++) {
        const tx = Math.floor(px / q), hx0 = (px - tx * q) * 4, hz = ty * this.HTX + tx;
        const i = (py * W + px) * 4, o = (hz * H + hy) * H + hx0;
        out[o] = buf[i]; out[o + 1] = buf[i + 1]; out[o + 2] = buf[i + 2]; out[o + 3] = buf[i + 3];
      }
    }
    return out;
  }

  dispose() {
    for (const t of [this.meshA, this.meshB, this.force, this.pad, this.rho, ...this.psi, ...this.mom, this.psi0, this.mom0, ...this.slots, this.haloRT, this.early]) t?.dispose();
    for (const m of [...this.fftMat, ...this.kpackMat, this.src2Mat, this.icMat, this.foldMat, this.kickMat, this.driftMat, this.copyMat, this.tracerMat, this.haloMat, this.depositMat]) m.dispose();
    this.fsMesh.geometry.dispose(); this.depositPts.geometry.dispose();
  }
}
