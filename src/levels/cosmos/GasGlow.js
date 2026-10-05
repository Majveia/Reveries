// Volumetric glow of the intergalactic medium: a low-resolution raymarch
// through the PM solver's Gaussian-smoothed density field (periodic, 2D-tiled
// 3D texture), emitting where gas has fallen into filaments and nodes —
// violet warm-hot medium in filaments, golden intracluster plasma in nodes.
// Optically thin emission ∝ (ρ − ρ₀)^1.15; rendered at ¼ resolution and added
// to the HDR frame. Empty space stays exactly black.

import * as THREE from 'three';
import { FULLSCREEN_VERT, COLOR_GLSL } from '../../core/glsl/common.js';

const MARCH_FRAG = /* glsl */ `
uniform sampler2D tForce; uniform float uL; uniform vec3 uCenter; uniform float uRadius;
uniform mat4 uProjInv; uniform mat4 uViewInv; uniform vec3 uCam; uniform float uStrength; uniform float uThresh;
uniform vec2 uRes; uniform float uFrame;
varying vec2 vUv;
${COLOR_GLSL}
ivec2 c2t(ivec3 c){ return ivec2((c.z % TX) * M + c.x, (c.z / TX) * M + c.y); }
float rhoAt(vec3 p){
  vec3 g = p * (float(M) / uL);
  vec3 i0 = floor(g); vec3 f = g - i0; ivec3 c0 = ivec3(i0);
  float r = 0.0;
  for (int dz = 0; dz < 2; dz++) for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++) {
    vec3 w = mix(1.0 - f, f, vec3(dx, dy, dz));
    r += w.x * w.y * w.z * texelFetch(tForce, c2t((c0 + ivec3(dx, dy, dz)) & (M - 1)), 0).w;
  }
  return 1.0 + r;
}
void main(){
  vec4 v = uProjInv * vec4(vUv * 2.0 - 1.0, 0.5, 1.0);
  vec3 dir = normalize(mat3(uViewInv) * (v.xyz / v.w));
  vec3 oc = uCam - uCenter;
  float b = dot(oc, dir), c = dot(oc, oc) - uRadius * uRadius;
  float h = b * b - c;
  if (h <= 0.0) { gl_FragColor = vec4(0.0); return; }
  h = sqrt(h);
  float t0 = max(-b - h, 0.3), t1 = -b + h;
  if (t1 <= t0) { gl_FragColor = vec4(0.0); return; }
  const int N = STEPS;
  float dt = (t1 - t0) / float(N);
  float t = t0 + dt * ign(gl_FragCoord.xy + uFrame * 7.13);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec3 p = uCam + dir * t;
    float rho = rhoAt(p);
    float e = pow(max(rho - uThresh, 0.0), 1.15);
    if (e > 0.0) {
      float r = length(p - uCenter) / uRadius;
      float edge = 1.0 - smoothstep(0.75, 1.0, r);
      vec3 col = mix(vec3(0.34, 0.10, 0.95), vec3(0.10, 0.55, 1.0), smoothstep(3.0, 10.0, rho));
      col = mix(col, vec3(1.45, 0.78, 0.36), smoothstep(14.0, 70.0, rho));
      acc += col * e * edge;
    }
    t += dt;
  }
  gl_FragColor = vec4(acc * dt * uStrength, 1.0);
}`;

const ADD_FRAG = /* glsl */ `
uniform sampler2D tInput; uniform sampler2D tGlow; uniform vec2 uTexel; varying vec2 vUv;
void main(){
  // 5-tap tent to hide the low-resolution raymarch
  vec3 g = texture2D(tGlow, vUv).rgb * 0.4
    + (texture2D(tGlow, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(tGlow, vUv - vec2(uTexel.x, 0.0)).rgb
     + texture2D(tGlow, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(tGlow, vUv - vec2(0.0, uTexel.y)).rgb) * 0.15;
  gl_FragColor = vec4(texture2D(tInput, vUv).rgb + g, 1.0);
}`;

export class GasGlow {
  constructor(sim, steps = 40) {
    this.sim = sim;
    this.enabled = true;
    this.strength = 0.003;
    this.thresh = 1.6;
    this.center = new THREE.Vector3();
    this.radius = sim.L * 0.49;
    this.rt = null;
    this.frame = 0;
    this.marchMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: MARCH_FRAG,
      defines: { M: sim.M, TX: sim.TX, STEPS: steps },
      uniforms: {
        tForce: { value: sim.force.texture }, uL: { value: sim.L }, uCenter: { value: this.center }, uRadius: { value: this.radius },
        uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() },
        uStrength: { value: 1 }, uThresh: { value: 1.6 }, uRes: { value: new THREE.Vector2() }, uFrame: { value: 0 },
      },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.addMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: ADD_FRAG,
      uniforms: { tInput: { value: null }, tGlow: { value: null }, uTexel: { value: new THREE.Vector2() } },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
  }

  render(renderer, input, output, ctx) {
    const w = Math.max(1, ctx.width >> 2), h = Math.max(1, ctx.height >> 2);
    if (!this.rt || this.rt.width !== w || this.rt.height !== h) {
      this.rt?.dispose();
      this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    }
    const u = this.marchMat.uniforms;
    u.tForce.value = this.sim.force.texture;
    u.uProjInv.value.copy(ctx.projInv); u.uViewInv.value.copy(ctx.viewInv); u.uCam.value.copy(ctx.cameraPosition);
    u.uStrength.value = this.strength; u.uThresh.value = this.thresh; u.uRadius.value = this.radius;
    u.uRes.value.set(w, h); u.uFrame.value = (this.frame++) % 64;
    ctx.fullscreen(this.marchMat, this.rt);
    this.addMat.uniforms.tInput.value = input; this.addMat.uniforms.tGlow.value = this.rt.texture;
    this.addMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    ctx.fullscreen(this.addMat, output);
  }

  dispose() { this.rt?.dispose(); this.marchMat.dispose(); this.addMat.dispose(); }
}
