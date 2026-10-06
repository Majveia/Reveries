// Ocean post effects (HDR, before the atmosphere pass):
//   • underwater: wavelength-dependent absorption + in-scattering fog, seabed
//     caustics on every surface below the waterline, surface light falloff
//   • lava worlds: heat haze — refraction shimmer in the air layer over the melt
import * as THREE from 'three';
import { DEPTH_GLSL, FULLSCREEN_VERT } from '../../../core/glsl/common.js';

const FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform sampler2D tInput, tDepth, tDetail;
uniform float uNear, uFar, uRev, uTime, uRs;
uniform mat4 uProjInv, uViewInv;
uniform vec3 uCam, uSunDir;
uniform float uUnder, uHaze;
uniform vec2 uFume;          // density at the surface (1/m), scale height (m)
uniform vec3 uGlow;          // radiance of the lit fumes
uniform vec3 uAbsorb, uScatter, uLight;
varying vec2 vUv;

void main(){
  vec2 uv = vUv;
  float depth = texture2D(tDepth, uv).r;
  bool far = isFarDepth(depth, uRev);
  vec3 vp = viewPosFromDepth(uv, far ? 0.5 : depth, uProjInv, uRev);
  vec3 rd = normalize((uViewInv * vec4(vp, 1.0)).xyz - uCam);
  float dist = far ? 1e6 : length(viewPosFromDepth(uv, depth, uProjInv, uRev));
  vec3 P = uCam + rd * dist;

  if (uHaze > 0.0) {
    float hAbove = length(P) - uRs;
    float camAbove = length(uCam) - uRs;
    // shimmer strongest just above the melt and for rays skimming over it
    float layer = exp(-max(hAbove, 0.0) / 30.0) + exp(-max(camAbove, 0.0) / 40.0) * 0.5;
    float s = uHaze * layer * smoothstep(4.0, 40.0, dist) * (1.0 - smoothstep(1500.0, 6000.0, dist));
    vec2 n = texture2D(tDetail, uv * vec2(3.0, 1.6) + vec2(0.0, -uTime * 0.09)).rg + texture2D(tDetail, uv * vec2(5.3, 2.7) + vec2(uTime * 0.013, -uTime * 0.15)).rg - 1.0;
    uv += n * s * 0.006;
  }
  vec3 col = texture2D(tInput, uv).rgb;

  if (uHaze > 0.0) {
    // incandescent fumes: a low exponential layer over the melt, lit from below.
    // Rays that climb leave it at once (black sky stays black); rays skimming the
    // sea gather a molten horizon glow.
    float tEnd = far ? 30000.0 : dist;
    float od = 0.0, prev = 0.0;
    for (int i = 1; i <= 12; i++) {
      float f = float(i) / 12.0;
      float t = tEnd * f * f;
      float hh = length(uCam + rd * (0.5 * (t + prev))) - uRs;
      od += exp(-max(hh, 0.0) / uFume.y) * (t - prev);
      prev = t;
    }
    od *= uFume.x;
    col = col * exp(-od * 0.35) + uGlow * (1.0 - exp(-od));
  }

  if (uUnder > 0.5) {
    float d = min(dist, 4000.0);
    vec3 T = exp(-uAbsorb * d);
    // light reaching the camera depth, falling off with depth below the surface
    float camDepth = max(uRs - length(uCam), 0.0);
    vec3 Lz = uLight * exp(-uAbsorb * camDepth * 1.2);
    float up = dot(rd, normalize(uCam));
    vec3 fogc = uScatter * Lz * (0.55 + 0.45 * smoothstep(-0.5, 1.0, up));
    if (!far) {
      float pd = uRs - length(P);
      if (pd > 0.0) {
        vec2 cxz = vec2(dot(P, vec3(1.0, 0.0, 0.0)), dot(P, vec3(0.0, 0.0, 1.0))) * 0.45;
        float c1 = texture2D(tDetail, cxz + vec2(uTime * 0.031, uTime * 0.017)).b;
        float c2 = texture2D(tDetail, cxz * 1.31 + vec2(-uTime * 0.023, uTime * 0.029)).b;
        float caus = pow(c1 * c2 * 1.7, 2.5) * exp(-pd * 0.12);
        col += col * caus * 2.5 * max(dot(normalize(P), uSunDir), 0.0);
      }
    }
    col = col * T + fogc * (1.0 - T);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export class OceanFX {
  constructor(ocean) {
    this.ocean = ocean;
    const w = ocean.world;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tInput: { value: null }, tDepth: { value: null }, tDetail: { value: ocean.tDetail },
        uNear: { value: 0.1 }, uFar: { value: 1e7 }, uRev: { value: 1 }, uTime: w.uniforms.uTime, uRs: { value: ocean.seaRadius },
        uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() }, uSunDir: w.uniforms.uSunDir,
        uUnder: { value: 0 }, uHaze: { value: 0 }, uFume: { value: new THREE.Vector2(1 / 6500, 50) }, uGlow: { value: new THREE.Vector3(0.75, 0.085, 0.008) },
        uAbsorb: { value: new THREE.Vector3(0.32, 0.075, 0.06) }, uScatter: { value: new THREE.Vector3(0.02, 0.16, 0.2) }, uLight: { value: new THREE.Vector3(1, 1, 1) },
      },
    });
  }

  get enabled() { const o = this.ocean; return !!o.enabled && (o.under || o.isLava); }

  render(renderer, input, output, ctx) {
    const o = this.ocean, u = this.mat.uniforms;
    u.tInput.value = input; u.tDepth.value = ctx.depthTexture;
    u.uNear.value = ctx.near; u.uFar.value = ctx.far; u.uRev.value = ctx.reversed ? 1 : 0;
    u.uProjInv.value.copy(ctx.projInv); u.uViewInv.value.copy(ctx.viewInv); u.uCam.value.copy(ctx.cameraPosition);
    u.uUnder.value = o.under ? 1 : 0;
    u.uHaze.value = o.isLava ? 1 : 0;
    const L = o.level.lighting;
    if (L) {
      const k = L.keyColor, s = L.skyColor, c = Math.max(0, o.world.sunDir.dot(_n.copy(ctx.cameraPosition).normalize()));
      u.uLight.value.set(k.r * c + s.r * Math.PI, k.g * c + s.g * Math.PI, k.b * c + s.b * Math.PI);
    }
    ctx.fullscreen(this.mat, output);
  }

  dispose() { this.mat.dispose(); }
}

const _n = new THREE.Vector3();
