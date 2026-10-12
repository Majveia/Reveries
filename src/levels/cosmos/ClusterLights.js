// Cluster lights: every detected halo carries its brightest cluster galaxy (a
// sharp white-gold HDR core with faint 4-point diffraction spikes, JWST style)
// wrapped in a soft intracluster-light glow of radius ≈ R200. These give the
// nodes of the web a readable, luminous heart instead of a diffuse blur.

import * as THREE from 'three';

const VERT = /* glsl */ `
attribute float aMass;       // log10(M / 1e13 Msun/h)
attribute float aSeed;
uniform float uProj; uniform float uFog; uniform float uFogNear; uniform float uGain; uniform float uPxK; uniform float uTime;
varying vec3 vCol; varying float vCore; varying float vIcl; varying float vSpike;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;
  float m = max(aMass, 0.0);
  // R200 (comoving Mpc/h) ∝ M^(1/3): 1.6 Mpc for 1e15
  float R = 1.63 * pow(10.0, (aMass - 2.0) / 3.0);
  float pxR = R * uProj / max(dist, 0.5);
  float px = clamp(pxR * 2.0, 10.0 * uPxK, 80.0 * uPxK);
  if (dist < 0.8) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  gl_PointSize = px;
  float tr = exp(-max(dist - uFogNear, 0.0) / uFog);
  float tw = 0.92 + 0.08 * sin(uTime * (0.6 + aSeed) + aSeed * 40.0);   // slow scintillation
  float L = pow(10.0, 0.55 * m) * uGain * tr * tw;
  vCore = px / max(1.6 * uPxK, 1.0);                       // sprite radius in core units
  vIcl = clamp(pxR * 2.0 / px, 0.05, 1.0);                 // R200 relative to the sprite
  vSpike = smoothstep(0.6, 2.0, m);
  vCol = mix(vec3(1.0, 0.80, 0.55), vec3(1.0, 0.93, 0.82), fract(aSeed * 7.31)) * L * 40.0 / max(dist, 6.0);
}`;

const FRAG = /* glsl */ `
varying vec3 vCol; varying float vCore; varying float vIcl; varying float vSpike;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  vec2 q = p * vCore;                                     // core units
  float rq = length(q);
  // brightest cluster galaxy: a cuspy, NFW/Sersic-like core (sharp peak, long shallow wing) —
  // the only part of the web allowed past display white
  float core = exp(-rq * rq * 2.2) + 0.10 * exp(-rq * 1.1);
  // intracluster light: de Vaucouleurs envelope truncated at R200, so voids stay true black
  float ri = sqrt(r2) / vIcl;
  float icl = 0.03 * exp(-pow(ri, 0.5) * 5.0) * exp(-ri * ri) * (1.0 - smoothstep(0.6, 1.0, sqrt(r2)));
  vec2 a = abs(q);
  float sp = exp(-a.y * 2.2) * exp(-a.x / vCore * 6.0) + exp(-a.x * 2.2) * exp(-a.y / vCore * 6.0);
  float v = core + icl * vCore * 0.25 + 0.16 * sp * vSpike * (1.0 - smoothstep(0.5, 1.0, sqrt(r2)));
  gl_FragColor = vec4(vCol * v, 1.0);
}`;

export class ClusterLights {
  constructor(max = 96) {
    this.max = max;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.mass = new Float32Array(max);
    const seed = new Float32Array(max);
    for (let i = 0; i < max; i++) seed[i] = ((i * 0.6180339887) % 1);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aMass', new THREE.BufferAttribute(this.mass, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    g.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uProj: { value: 600 }, uFog: { value: 60 }, uFogNear: { value: 0 }, uGain: { value: 1 }, uPxK: { value: 1 }, uTime: { value: 0 } },
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }

  /** halos: list; place(h, out) → world position (nearest periodic image). */
  update(halos, place, camera, height, params, time, a) {
    const n = Math.min(this.max, halos.length);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      place(halos[i], v);
      this.pos[i * 3] = v.x; this.pos[i * 3 + 1] = v.y; this.pos[i * 3 + 2] = v.z;
      this.mass[i] = Math.log10(Math.max(halos[i].mass, 1) / 1e13);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true; g.attributes.aMass.needsUpdate = true;
    g.setDrawRange(0, n);
    const u = this.material.uniforms;
    u.uProj.value = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    u.uPxK.value = height / 720;
    u.uFog.value = params.fog; u.uFogNear.value = params.fogNear;
    // galaxies only light up once halos have collapsed (and not in the primordial glow)
    u.uGain.value = (params.lights ?? 1) * (1 - params.warm) * Math.min(1, Math.max(0, (a - 0.25) / 0.35));
    u.uTime.value = time;
  }

  dispose() { this.points.geometry.dispose(); this.material.dispose(); }
}
