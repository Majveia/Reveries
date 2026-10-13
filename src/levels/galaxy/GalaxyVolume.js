// Volumetric galaxy light: the unresolved starlight of the disk (young blue arms,
// old warm disk), HII glow, the Sersic bulge and — most importantly — absorbing
// dust, raymarched at reduced resolution and composited over the scene.
//
// Per ray segment the face-on structure map is sampled once at the segment midpoint
// while each component's sech² vertical profile is integrated EXACTLY over the
// segment, so a 100 pc dust layer seen face-on or edge-on is never stepped over.
// The bulge is integrated analytically (flattened Gaussian mixture, erf) and
// attenuated by the dust transmittance at the ray's closest approach to the core.
//
// Emission close to the camera fades out ("resolved" into the point star layers),
// dust does not — near dust silhouettes against the bright background like the
// Milky Way's Great Rift.

import * as THREE from 'three';
import { FULLSCREEN_VERT, COLOR_GLSL } from '../../core/glsl/common.js';
import { GAL_GLSL } from './GalaxyModel.js';

const MARCH_FRAG = /* glsl */ `
precision highp float;
${COLOR_GLSL}
${GAL_GLSL}
uniform sampler3D uNoise;
uniform mat4 uProjInv, uViewInv;
uniform vec3 uCam;
uniform float uCoreR, uStretch, uBulgeDim, uSteps, uR, uBulgeQ, uBulgeScale, uBulgeAmp, uEmit, uNearFade, uPixAngle, uFrame, uDetail, uYoungGain, uThick, uNucleus, uInside;
uniform vec3 uColYoung, uColOld, uColHII, uColBulge, uColDustGlow;
uniform vec2 uRes;
varying vec2 vUv;

float erfa(float x){ // Abramowitz-Stegun 7.1.26 (|err| < 1.5e-7)
  float s = sign(x); x = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * x);
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
  return s * y;
}
// ∫ exp(-|S(o + t d)|² / 2σ²) dt over [t0, t1], S = diag(1, 1/q, 1)
float gaussLine(vec3 o, vec3 d, float s, float t0, float t1){
  vec3 so = o * vec3(1.0, 1.0 / uBulgeQ, 1.0), sd = d * vec3(1.0, 1.0 / uBulgeQ, 1.0);
  float L2 = dot(sd, sd), L = sqrt(L2);
  float tc = -dot(so, sd) / L2;
  float b2 = max(dot(so, so) - dot(so, sd) * dot(so, sd) / L2, 0.0);
  float k = L / (s * 1.41421356);
  return exp(-b2 / (2.0 * s * s)) * s * 1.25331414 / L * (erfa((t1 - tc) * k) - erfa((t0 - tc) * k));
}
// bulge (flattened Gaussian mixture ~ Sersic n≈3) + compact nuclear star cluster, over [t0, t1]
float bulgeLine(vec3 o, vec3 d, float t0, float t1){
  float s = uBulgeScale;
  return gaussLine(o, d, s * 0.012, t0, t1) * uNucleus
       + gaussLine(o, d, s * 0.05, t0, t1) * 1.7
       + gaussLine(o, d, s * 0.16, t0, t1) * 0.85
       + gaussLine(o, d, s * 0.45, t0, t1) * 0.42
       + gaussLine(o, d, s * 1.1, t0, t1) * 0.1
       + gaussLine(o, d, s * 2.6, t0, t1) * 0.012;   // faint extended halo (Sersic wing)
}
vec2 slab(vec3 o, vec3 d, float h){
  if (abs(d.y) < 1e-6) return abs(o.y) < h ? vec2(0.0, 1e9) : vec2(1.0, 0.0);
  float a = (-h - o.y) / d.y, b = (h - o.y) / d.y;
  return vec2(min(a, b), max(a, b));
}
vec2 cyl(vec3 o, vec3 d, float R){
  float A = dot(d.xz, d.xz), B = dot(o.xz, d.xz), C = dot(o.xz, o.xz) - R * R;
  if (A < 1e-9) return C < 0.0 ? vec2(0.0, 1e9) : vec2(1.0, 0.0);
  float D = B * B - A * C; if (D < 0.0) return vec2(1.0, 0.0);
  D = sqrt(D); return vec2((-B - D) / A, (-B + D) / A);
}

void main(){
  vec4 cp = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize((uViewInv * vec4(normalize(cp.xyz / cp.w), 0.0)).xyz);
  vec3 ro = uCam;
  float H = max(uHOld * 6.0, uHDust * 10.0);
  vec2 ts = slab(ro, rd, H), tcyl = cyl(ro, rd, uExtent);
  float t0 = max(max(ts.x, tcyl.x), 0.0), t1 = min(ts.y, tcyl.y);
  vec3 col = vec3(0.0);
  vec3 T = vec3(1.0);
  vec3 KRGB = mix(vec3(0.62, 1.0, 1.48), vec3(0.85, 1.0, 1.18), uInside);   // milder inside: rifts read dark brown, not glowing orange   // wavelength-dependent extinction: lane edges redden
  vec3 cB = uColBulge * uBulgeAmp * uEmit * uBulgeDim;
  float grazeK = mix(smoothstep(0.03, 0.3, abs(rd.y)), 1.0, uInside);
  float camR = length(ro * vec3(1.0, 1.0 / uBulgeQ, 1.0));
  float inBulge = max((1.0 - smoothstep(uBulgeScale * 0.2, uBulgeScale * 1.5, camR)) * 0.7, uInside);
  if (t1 > t0) {
    // bulge light in front of the dusty slab
    col += bulgeLine(ro, rd, 0.0, t0) * cB;
    float N = uSteps;
    float jit = ign(gl_FragCoord.xy + uFrame * 5.588);
    // inside the slab: geometric steps (fine near the camera, long far away) so the near
    // dust resolves into rifts while the far disk still integrates into a band
    bool inside = t0 <= 0.0;
    float tmin = 0.012;
    float span = t1 - t0;
    float G = inside ? log(1.0 + span / tmin) : 0.0;
    // outside the slab: importance-sample the vertical structure (steps at equal increments of a
    // sech² cumulative centred on the midplane, blended with uniform steps) so the bulge/lane
    // crossing is resolved finely and no curtain striations appear
    float hS = uHOld * 0.9;
    float ca = galCum(ro.y + rd.y * t0, hS), cb = galCum(ro.y + rd.y * t1, hS);
    // (continuous switch: a hard on/off drew a horizon line across edge-on views)
    float wImp = (!inside && abs(rd.y) > 1e-4) ? 0.86 * smoothstep(0.04, 0.2, abs(cb - ca)) : 0.0;
    float ta = t0;
    for (int i = 0; i < 160; i++) {
      if (float(i) >= N) break;
      float u = min((float(i) + 1.0 + (jit - 0.5) * 0.9) / N, 1.0);
      if (i == int(N) - 1) u = 1.0;
      float tb = inside ? t0 + tmin * (exp(G * u) - 1.0) : t0 + span * u;
      if (wImp > 0.0) {
        float yc = hS * atanh(clamp(2.0 * mix(ca, cb, u), -0.99999, 0.99999));
        tb = mix(tb, clamp((yc - ro.y) / rd.y, t0, t1), wImp);
      }
      tb = min(tb, t1);
      vec3 pa = ro + rd * ta, pb = ro + rd * tb;
      vec3 pm = 0.5 * (pa + pb);
      float seg = tb - ta;
      float tm = 0.5 * (ta + tb);
      float lod = log2(max(tm * uPixAngle * 0.8, seg * 0.25) / uMapTexel);
      // Off-plane light must not be a vertical extrusion of the face-on map (that projects into
      // curtain streaks): the map is smoothed with height and sheared by 3D noise, the old disk
      // samples a smooth map, and the whole disk follows a gentle outer warp.
      float rr = length(pm.xz);
      float wy = 0.014 * uR * smoothstep(0.55 * uR, 1.15 * uR, rr) * sin(atan(pm.z, pm.x) - 0.7);
      vec4 nsh = texture(uNoise, pm * 0.31 + 0.11);
      float ay = abs(pm.y - wy);
      // bulge/bar: smooth unresolved light (M31, NGC 1300) - no shear, no cloud modulation
      float gC = smoothstep(uCoreR * 0.55, uCoreR * 1.25, rr);
      // (outside the disk a mild shear only: strong shear brushed the face-on arms into fur)
      vec3 pmS = pm + vec3(nsh.x - 0.5, 0.0, nsh.z - 0.5) * ay * mix(0.35, 1.6, uInside) * gC;
      // light far off the midplane samples a strongly smoothed map: seen obliquely, a sharp map
      // extruded through the layer's thickness projects into short parallel streaks ("fur")
      vec4 m = galMap(pmS, max(lod + mix(2.0, 1.7, uInside) * log2(1.0 + ay / (uHYoung * mix(0.5, 1.0, uInside))), 0.0));
      vec4 mS = galMap(pmS, max(lod + 3.0, 0.0));
      // dust is sampled sharper than the light (no height LOD bias, one level finer) and given a
      // contrast curve: hairline HST filaments go near-opaque, inter-lane disk stays clear
      float mD = galMap(pmS, max(lod - 1.0, 0.0)).b;
      mD = pow(mD, 1.55) * 1.3;
      float ya = pa.y - wy, yb = pb.y - wy;
      float rTap = 1.0 - smoothstep(0.78 * uExtent, 0.98 * uExtent, rr);   // the bounding cylinder is never visible
      // the lane swells and pinches; seen edge-on it stays one thin opaque slit (NGC 891)
      float hDv = uHDust * mix(0.6, mix(0.6 + 0.3 * nsh.y, 0.55 + 0.9 * nsh.y, grazeK), gC);
      float det = 1.0;
      if (uDetail > 0.0 && tm < 3.0) {
        vec4 n1 = texture(uNoise, pm * 1.7);
        vec4 n2 = texture(uNoise, pm * 9.0 + n1.xyz * 0.15);
        det = mix(1.0, (0.35 + 1.3 * n1.r) * (0.4 + 1.2 * n2.b), uDetail * (1.0 - smoothstep(0.8, 3.0, tm)) * gC);
      }
      float pY = galSeg(ya, yb, uHYoung * mix(0.55, 1.0, uInside)), pO = galSeg(ya, yb, uHOld), pD = galSeg(ya, yb, hDv);
      float pT = galSeg(ya, yb, uHOld * 2.6);
      // inside the disk the near dust condenses into discrete opaque clouds with clear gaps
      // between them: the band breaks into Great-Rift silhouettes instead of a smooth haze
      float dIn = det;
      float starCl = 1.0;
      if (uInside > 0.0 && tm < 3.0) {
        // three octaves (≈7, 2.5, 0.8 kpc periods): giant molecular cloud complexes with
        // filamentary edges and clear lanes between them → Great-Rift silhouettes on the band
        vec4 c0 = texture(uNoise, pm * vec3(0.14, 0.5, 0.14) + 0.71);
        vec4 c1 = texture(uNoise, pm * vec3(0.4, 1.2, 0.4) + 0.37 + c0.xyz * 0.2);
        vec4 c2 = texture(uNoise, pm * vec3(1.25, 2.6, 1.25) + c1.xyz * 0.3);
        float cv = c0.g * 0.45 + c1.r * 0.35 + c2.b * 0.2;
        float cl = smoothstep(0.42, 0.62, cv);
        dIn = mix(det * det * 1.3, (0.02 + cl * cl * 20.0) * (0.55 + c2.r), 1.0 - smoothstep(1.2, 3.0, tm));
        // bright star clouds (Sagittarius / Scutum) where the clouds open up
        starCl = mix(1.0, 0.55 + 1.6 * smoothstep(0.5, 0.3, cv), uInside);
      }
      // (inside the disk a molecular-cloud floor: the local map may be dust-poor, e.g. within the bar)
      float tau = rTap * (mix(m.b, mD, 1.0 - uInside) + 0.14 * uInside * (1.0 - smoothstep(1.2, 3.0, tm))) * pD * seg * uKappa * mix(det, dIn, uInside);
      // extraplanar dust: sparse filaments and plumes rising off the plane (NGC 891 / Sombrero)
      if (uInside < 0.5) {
        float xn = texture(uNoise, pm * vec3(0.22, 0.6, 0.22) + 0.31).b;
        float xn2 = texture(uNoise, pm * vec3(0.9, 1.8, 0.9) + 0.57).r;
        float exB = smoothstep(max(uBulgeScale * 0.8, 0.09 * uR), max(uBulgeScale * 2.2, 0.3 * uR), length(pm.xz));   // keep bulge + bar light smooth (no smoke)
        tau += mS.b * galSeg(ya, yb, uHDust * 4.0) * seg * uKappa * pow(xn, 3.4) * (0.4 + xn2) * 1.25 * exB;
      }
      vec3 cOld = mix(mix(uColOld, vec3(0.95, 0.9, 0.86), uInside), vec3(0.78, 0.82, 1.0), smoothstep(0.08 * uR, 0.55 * uR, length(pm.xz)) * 0.75);
      vec3 cY = mix(uColYoung, vec3(0.8, 0.88, 1.0), smoothstep(0.3, 1.6, m.r) * 0.6 * (1.0 - uInside));   // white-blue arm ridges
      // box/peanut bulge: the inner old light (bar) is vertically thickened (face-on brightness kept,
      // since both profiles integrate to 1), so edge-on a luminous bulge stands above and below the lane
      float pk = (1.0 - uInside) * 0.7 * exp(-pow(length(pm.xz) / (0.2 * uR), 2.0));
      float pOk = mix(pO, galSeg(ya, yb, uHOld * 1.7), pk);
      vec3 j = starCl * (m.r * cY * pY * uYoungGain + mix(m.g, mS.g, mix(0.85, 0.6, gC) * (1.0 - uInside)) * cOld * (pOk + pT * uThick * (1.0 - uInside)) * mix(1.0, smoothstep(0.0, uNearFade * 3.0, tm), uInside) + m.a * uColHII * pD * 2.1 * det * smoothstep(0.3, 2.0, tm) * (1.0 - 0.7 * uInside)) * uEmit;
      j += m.b * pD * uColDustGlow * uEmit * grazeK;
      j *= rTap;   // (no glow at grazing angles: the lane must absorb, not paint orange)
      float near = smoothstep(0.0, uNearFade, tm);
      vec3 tr = exp(-tau * KRGB);
      vec3 add = j * seg * near * (tau > 1e-4 ? (1.0 - tr) / (tau * KRGB) : vec3(1.0));
      // the bulge is integrated per segment so the midplane lane slices straight through it
      float bn = mix(1.0, smoothstep(0.0, uNearFade * 1.5, tm), inBulge);
      add += bulgeLine(ro, rd, ta, tb) * bn * cB * (tau > 1e-4 ? (1.0 - tr) / (tau * KRGB) : vec3(1.0));
      col += T * add;
      T *= tr;
      ta = tb;
      if (T.g < 0.002) break;
    }
    col += T * bulgeLine(ro, rd, t1, 1e5) * cB;
  } else {
    float bn = mix(1.0, smoothstep(0.0, uNearFade * 1.5, max(-dot(ro, rd), 0.0)), inBulge);
    col += bulgeLine(ro, rd, 0.0, 1e5) * cB * bn;
  }
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  // HST-style asinh stretch: the arms stay linear, the bar/bulge keep their internal
  // structure (boxy bar, lanes, nucleus) instead of clipping to a flat cream plateau
  float Lc = dot(col, vec3(0.2126, 0.7152, 0.0722)) * uStretch;
  if (Lc > 1e-4) col *= log(Lc + sqrt(Lc * Lc + 1.0)) / Lc;
  gl_FragColor = vec4(max(col, 0.0), clamp(dot(T, vec3(0.3, 0.45, 0.25)), 0.0, 1.0));
}`;

const COMP_FRAG = /* glsl */ `
uniform sampler2D tInput, tVol; uniform vec2 uTexel;
uniform mat4 uProjInv, uViewInv; uniform float uGrain, uGrainK;
varying vec2 vUv;
float h13(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
void main(){
  // 4-tap tent upsample of the half-res volume (smooth, no blockiness)
  vec4 v = texture2D(tVol, vUv + uTexel * vec2(-0.5, -0.5)) + texture2D(tVol, vUv + uTexel * vec2(0.5, -0.5))
         + texture2D(tVol, vUv + uTexel * vec2(-0.5, 0.5)) + texture2D(tVol, vUv + uTexel * vec2(0.5, 0.5));
  v *= 0.25;
  vec3 c = texture2D(tInput, vUv).rgb;
  if (uGrain > 0.0) {
    // inside the disk the unresolved band breaks into myriad faint stars: a full-resolution,
    // direction-locked (no swimming) sparkle field modulates the diffuse light (mean ≈ 1)
    vec4 cp = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 rd = normalize((uViewInv * vec4(normalize(cp.xyz / cp.w), 0.0)).xyz);
    // analytic point-spread stars (≥1.2 px Gaussian, lognormal-ish fluxes): no per-pixel hash
    float s = 0.0;
    for (int l = 0; l < 2; l++) {
      float K = uGrainK * (l == 0 ? 0.3 : 0.17);
      vec3 g = rd * K, cell = floor(g);
      vec3 j = vec3(h13(cell), h13(cell + 5.1), h13(cell + 9.7));
      vec3 sp = cell + 0.5 + (j - 0.5) * 0.6;
      vec3 dd = g - sp; dd -= rd * dot(dd, rd);
      float px = length(dd) / K * (uGrainK);                 // distance in pixels
      float f = step(0.72, h13(cell + 6.1)) * exp(-5.0 * h13(cell + 2.3)) * (l == 0 ? 6.0 : 20.0);
      s += f * exp(-px * px / (2.0 * 0.75 * 0.75));
    }
    // the band resolves into stars: diffuse light partly redistributed into point sources
    // (mean preserved), plus sparse bright foreground stars on top of the band
    float lv = dot(v.rgb, vec3(0.2126, 0.7152, 0.0722));
    // (star clouds read creamy white-gold, not saturated orange: partially desaturate the band)
    v.rgb = mix(v.rgb, lv * vec3(1.05, 0.97, 0.86), 0.45 * min(1.0, uGrain * 2.0));
    // sparkles carry the band's luminance but a stellar (near-white) colour: no orange glitter
    v.rgb *= mix(1.0, 0.72, uGrain * 1.4);
    v.rgb += uGrain * 1.4 * s * 0.1 * lv * vec3(1.0, 0.95, 0.88);
    v.rgb += uGrain * s * s * 0.0022 * vec3(0.95, 0.95, 1.0) * smoothstep(0.0, 0.04, lv);
  }
  gl_FragColor = vec4(c * v.a + v.rgb, 1.0);
}`;

export class GalaxyVolume {
  constructor(engine, P, mapRT, noise3D) {
    this.engine = engine;
    this.enabled = true;
    this.P = P;
    const q = engine.quality;
    this.scale = engine.shotMode ? 1.0 : q.pick(0.33, 0.4, 0.5, 0.6);
    this.baseScale = this.scale;
    this.steps = engine.shotMode ? 88 : q.pick(32, 44, 60, 80);
    const mapSize = mapRT.width;
    this.march = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: MARCH_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        uMap: { value: mapRT.texture }, uNoise: { value: noise3D },
        uExtent: { value: P.extent }, uHOld: { value: P.hOld }, uHYoung: { value: P.hYoung }, uHDust: { value: P.hDust },
        uKappa: { value: 2.4 }, uMapTexel: { value: (2 * P.extent) / mapSize },
        uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() },
        uSteps: { value: this.steps }, uR: { value: P.R }, uBulgeQ: { value: P.bulgeQ }, uBulgeScale: { value: P.bulgeScale },
        uCoreR: { value: Math.max(P.bulgeScale * 2.2, P.R * (P.bar || 0) * 0.56 * 1.15) }, uBulgeDim: { value: 1 }, uStretch: { value: 1.6 }, uBulgeAmp: { value: P.bulgeAmp }, uEmit: { value: 1.0 }, uNearFade: { value: 0.12 }, uPixAngle: { value: 0.001 },
        uFrame: { value: 0 }, uDetail: { value: 1.0 }, uRes: { value: new THREE.Vector2() }, uYoungGain: { value: 1.3 }, uInside: { value: 0 }, uThick: { value: 0.1 }, uNucleus: { value: 16.0 },
        uColYoung: { value: new THREE.Color(0.33, 0.53, 1.0) }, uColOld: { value: new THREE.Color(1.0, 0.8, 0.6) },
        uColHII: { value: new THREE.Color(1.0, 0.2, 0.24) }, uColBulge: { value: new THREE.Color(1.0, 0.78, 0.52) },
        uColDustGlow: { value: new THREE.Color(0.0013, 0.00095, 0.0009) },
      },
    });
    this.comp = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: COMP_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tInput: { value: null }, tVol: { value: null }, uTexel: { value: new THREE.Vector2() }, uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() }, uGrain: { value: 0 }, uGrainK: { value: 500 } },
    });
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.frame = 0;
  }

  render(renderer, input, output, ctx) {
    const w = Math.max(2, Math.round(ctx.width * this.scale)), h = Math.max(2, Math.round(ctx.height * this.scale));
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    const u = this.march.uniforms;
    u.uProjInv.value.copy(ctx.camera.projectionMatrixInverse);
    u.uViewInv.value.copy(ctx.camera.matrixWorld);
    u.uCam.value.copy(ctx.cameraPosition);
    u.uPixAngle.value = (ctx.camera.fov * Math.PI / 180) / h;
    u.uFrame.value = this.engine.shotMode ? 0 : (this.frame++ % 64);
    u.uRes.value.set(w, h);
    ctx.fullscreen(this.march, this.rt);
    this.comp.uniforms.tInput.value = input;
    this.comp.uniforms.tVol.value = this.rt.texture;
    this.comp.uniforms.uTexel.value.set(1 / w, 1 / h);
    const cu = this.comp.uniforms;
    cu.uProjInv.value.copy(ctx.camera.projectionMatrixInverse); cu.uViewInv.value.copy(ctx.camera.matrixWorld);
    cu.uGrain.value = this.march.uniforms.uInside.value * 0.5;
    cu.uGrainK.value = ctx.height / (ctx.camera.fov * Math.PI / 180) * 1.0;
    ctx.fullscreen(this.comp, output);
  }

  dispose() { this.rt.dispose(); this.march.dispose(); this.comp.dispose(); }
}
