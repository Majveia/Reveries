// Screen-space reflections on the sea (HDR, before the atmosphere pass).
//
// The water shader mirrors the sky (sky-view LUT); this pass puts the world in
// the water: headlands, cliffs, ships, trees and towns. Water pixels are
// recognised from the depth buffer (on the wave surface over a submerged
// seabed), their normal is re-evaluated from the same Gerstner spectrum, and
// the reflected ray is marched through the depth buffer (geometric steps,
// binary refinement). Where it hits, the sky term the water shader added is
// swapped for the hit radiance (same Fresnel), faded at screen edges and with
// distance; where it misses, the sky reflection stays.
import * as THREE from 'three';
import { DEPTH_GLSL, FULLSCREEN_VERT, COLOR_GLSL } from '../../../core/glsl/common.js';
import { ATMO_PARS, ATMO_FUNCS, SKYVIEW_FUNCS } from '../atmosphere/AtmosphereModel.js';
import { OCEAN_COMMON } from './OceanShader.js';

const FRAG = /* glsl */ `
${DEPTH_GLSL}
${ATMO_PARS}
${ATMO_FUNCS}
${SKYVIEW_FUNCS}
${COLOR_GLSL}
${OCEAN_COMMON}
uniform sampler2D tInput, tDepth;
uniform float uRev, uLutW, uMaxAmp, uPixelAngle, uSteps, uStrength;
uniform mat4 uProjInv, uViewInv, uProjM, uViewM;
uniform vec3 uCam, uSkyZenith, uSkyHorizon;
varying vec2 vUv;

vec3 skyRadiance(vec3 R, vec3 n0){
  float up = dot(R, n0);
  vec3 fb = mix(uSkyHorizon, uSkyZenith, pow(clamp(up, 0.0, 1.0), 0.45));
  if (uLutW <= 0.0) return fb;
  return mix(fb, skyViewLookup(R).rgb, uLutW);
}
float fresnel(float c, float f0){ return f0 + (1.0 - f0) * pow(1.0 - clamp(c, 0.0, 1.0), 5.0); }
vec2 toUV(vec3 q, out float ok){
  vec4 c = uProjM * vec4(q, 1.0);
  ok = c.w > 1e-4 ? 1.0 : 0.0;
  return c.xy / max(c.w, 1e-4) * 0.5 + 0.5;
}
float sceneZ(vec2 uv, out float far){
  float d = texture2D(tDepth, uv).r;
  far = isFarDepth(d, uRev) ? 1.0 : 0.0;
  return viewPosFromDepth(uv, d, uProjInv, uRev).z;
}

void main(){
  vec3 col = texture2D(tInput, vUv).rgb;
  gl_FragColor = vec4(col, 1.0);
  float d0 = texture2D(tDepth, vUv).r;
  if (isFarDepth(d0, uRev)) return;
  vec3 vp = viewPosFromDepth(vUv, d0, uProjInv, uRev);
  float dist = length(vp);
  if (dist > 4000.0) return;
  vec3 P = (uViewInv * vec4(vp, 1.0)).xyz;
  vec3 n0 = normalize(P);
  float r = length(P) - uRs;
  float band = uMaxAmp * 2.2 * uWaveScale + uSurf.x * 1.5 + 1.5;
  if (abs(r) > band) return;
  vec3 rel = n0 * uRs - uAnchor;
  vec2 xz = vec2(dot(rel, uT1), dot(rel, uT2));
  float depth = -terrainRel(n0, xz);
  if (depth < 0.1) return;                       // dry land / beach
  vec3 V = normalize(uCam - P);
  float cosV = abs(dot(V, n0));
  float foot = dist * uPixelAngle / pow(max(cosV, 0.03), 0.35);
  // wave height + slope at this point (same spectrum as the water mesh)
  float shoal = shoalFactor(depth) * uWaveScale;
  float hgt = 0.0, sx = 0.0, sz = 0.0, sy = 0.0;
  for (int i = 0; i < NW; i++) {
    vec4 w = uWave[i];
    float lam = 6.2831853 / w.z;
    float t = w.z * dot(w.xy, xz) + uPhase[i];
    hgt += w.w * shoal * sin(t);
    float f = 1.0 - smoothstep(0.07, 0.3, foot / lam);
    float ka = w.z * w.w * shoal * f;
    sx += w.x * ka * cos(t); sz += w.y * ka * cos(t); sy += uChop * ka * sin(t);
  }
  vec4 so; vec2 sg;
  float sh = surf(xz, depth, so, sg);
  // not the water surface (a hull, a pier, a rock just above the sea)?
  if (abs(r - hgt - sh) > 0.8 + uChop * uMaxAmp * 0.6 * uWaveScale + max(sh, 0.0)) return;
  sx += so.x * sg.x; sz += so.x * sg.y;
  vec2 dn = (texture2D(tDetail, xz / 9.0 + vec2(uTime * 0.02, 0.0)).rg - 0.5) * 0.06 * (1.0 - smoothstep(0.3, 2.0, foot));
  vec3 t1 = normalize(uT1 - n0 * dot(uT1, n0));
  vec3 t2 = cross(t1, n0);
  vec3 N = normalize(t1 * (-sx - dn.x) + n0 * (1.0 - sy) + t2 * (-sz - dn.y));
  vec3 Rw = reflect(-V, N);
  Rw -= n0 * 2.0 * min(dot(Rw, n0), 0.0);
  Rw = normalize(Rw + n0 * 0.02);
  float NV = max(dot(N, V), 0.001);
  float F = fresnel(NV, 0.02);
  // march the reflected ray in view space
  vec3 Rv = normalize((uViewM * vec4(Rw, 0.0)).xyz);
  float t0 = 0.25 + dist * 0.004;
  float tMax = 3500.0;
  float jit = ign(gl_FragCoord.xy);
  float prevT = 0.0, hitT = -1.0;
  float ok;
  for (int i = 0; i < 40; i++) {
    if (float(i) >= uSteps) break;
    float fi = (float(i) + jit) / uSteps;
    float t = t0 * pow(tMax / t0, fi);
    vec3 q = vp + Rv * t;
    vec2 uv = toUV(q, ok);
    if (ok < 0.5 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    float far;
    float sz0 = sceneZ(uv, far);
    float thick = max(0.6, (t - prevT) * 1.5 + t * 0.03);
    if (far < 0.5 && q.z < sz0 && q.z > sz0 - thick) { hitT = t; break; }
    prevT = t;
  }
  if (hitT < 0.0) return;
  // binary refinement
  float a = prevT, b = hitT;
  for (int k = 0; k < 5; k++) {
    float m = 0.5 * (a + b);
    vec3 q = vp + Rv * m;
    float far;
    vec2 uv = toUV(q, ok);
    float sz0 = sceneZ(uv, far);
    if (far < 0.5 && q.z < sz0) b = m; else a = m;
  }
  vec3 qh = vp + Rv * b;
  vec2 uvh = toUV(qh, ok);
  float farH;
  sceneZ(uvh, farH);
  if (farH > 0.5) return;
  vec3 hit = texture2D(tInput, uvh).rgb;
  // reject reflections of the sea itself (rays skimming over the next crest)
  vec3 Ph = (uViewInv * vec4(qh, 1.0)).xyz;
  float rh = length(Ph) - uRs;
  float self = 1.0 - smoothstep(band * 0.6, band * 1.2, abs(rh));
  vec2 e = min(uvh, 1.0 - uvh);
  float fade = smoothstep(0.0, 0.06, min(e.x, e.y)) * (1.0 - smoothstep(2000.0, 4000.0, dist)) * (1.0 - smoothstep(1800.0, 3500.0, b)) * (1.0 - self * 0.85);
  // the reflected scene sits a little dimmer and bluer than the dry view
  // (water is not a perfect mirror; the skylight in between)
  // swap the sky share of this pixel for the hit (hue-neutral: the remainder
  // of the pixel — body, glints, foam — keeps its colour)
  vec3 skyR = skyRadiance(compressR(Rw, n0, cosV, dist), n0);
  float share = clamp(luma(skyR) * F / max(luma(col), 1e-5), 0.0, 0.95);
  float w = fade * uStrength;
  vec3 outc = col * (1.0 - share * w) + hit * (0.9 * F * w);
  gl_FragColor = vec4(outc, 1.0);
}
`;

export class OceanSSR {
  constructor(ocean) {
    this.ocean = ocean;
    const q = ocean.engine.quality;
    const own = {
      tInput: { value: null }, tDepth: { value: null },
      uRev: { value: 1 }, uSteps: { value: ocean.engine.shotMode ? 40 : q.pick(16, 20, 28, 36) }, uStrength: { value: 1 },
      uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() },
      uProjM: { value: new THREE.Matrix4() }, uViewM: { value: new THREE.Matrix4() },
      uCam: { value: new THREE.Vector3() },
    };
    this.mat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
      uniforms: Object.assign({}, ocean.uniforms, own),
    });
    this.minQuality = 1;
  }

  get enabled() {
    const o = this.ocean;
    if (!o.enabled || o.isLava || o.under) return false;
    if (!o.engine.shotMode && o.engine.quality.level < this.minQuality) return false;
    const alt = o.level.camera.position.length() - o.seaRadius;
    return alt < 2500;
  }

  render(renderer, input, output, ctx) {
    const u = this.mat.uniforms;
    u.tInput.value = input; u.tDepth.value = ctx.depthTexture;
    u.uRev.value = ctx.reversed ? 1 : 0;
    u.uProjInv.value.copy(ctx.projInv); u.uViewInv.value.copy(ctx.viewInv);
    u.uProjM.value.copy(ctx.projInv).invert();
    u.uViewM.value.copy(ctx.viewInv).invert();
    u.uCam.value.copy(ctx.cameraPosition);
    ctx.fullscreen(this.mat, output);
  }

  dispose() { this.mat.dispose(); }
}
