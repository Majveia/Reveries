// Cluster lights: every detected halo carries its brightest cluster galaxy (a
// sharp white-gold HDR core with faint 4-point diffraction spikes, JWST style)
// wrapped in a soft intracluster-light glow of radius ≈ R200. These give the
// nodes of the web a readable, luminous heart instead of a diffuse blur.

import * as THREE from 'three';

const VERT = /* glsl */ `
attribute float aMass;       // log10(M / 1e13 Msun/h)
attribute float aSeed;
uniform float uProj; uniform float uFog; uniform float uFogNear; uniform float uGain; uniform float uPxK; uniform float uTime; uniform float uNear;
varying vec3 vCol; varying float vCore; varying float vIcl; varying float vSpike; varying float vSB;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;
  float m = max(aMass, 0.0);
  // R200 (comoving Mpc/h) ∝ M^(1/3): 1.6 Mpc for 1e15
  float R = 1.63 * pow(10.0, (aMass - 2.0) / 3.0);
  float pxR = R * uProj / max(dist, 0.5);
  float pxCap = 96.0 * uPxK;
  float px = clamp(pxR * 2.0, 10.0 * uPxK, pxCap);
  float nearF = smoothstep(uNear * 0.3, uNear, dist);
  if (dist < 0.8 || nearF <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  gl_PointSize = px;
  float tr = exp(-max(dist - uFogNear, 0.0) / uFog);
  float tw = 0.92 + 0.08 * sin(uTime * (0.6 + aSeed) + aSeed * 40.0);   // slow scintillation
  float L = pow(10.0, 0.75 * m) * uGain * tr * tw * nearF;
  vCore = px / max(1.6 * uPxK, 1.0);                       // sprite radius in core units
  vIcl = clamp(pxR * 2.0 / px, 0.05, 1.0);                 // R200 relative to the sprite
  vSpike = smoothstep(1.4, 2.4, m);   // only the few richest clusters carry a (faint) PSF
  // point-like BCG nucleus (fixed ~2 px): flux falls with distance, capped in the near field so a
  // halo beside the camera never becomes a giant disc
  vCol = mix(vec3(1.0, 0.80, 0.55), vec3(1.0, 0.93, 0.82), fract(aSeed * 7.31)) * L * 75.0 / max(dist, 15.0);
  // intracluster light is an extended source: its SURFACE BRIGHTNESS does not depend on distance
  // (old: ∝ 1/d², which blew close halos into flat cream plateaus); it fades out once the sprite is
  // clamped (truncated R200)
  vSB = 0.22 * L * (1.0 - smoothstep(0.75, 1.0, pxR * 2.0 / pxCap));
}`;

const FRAG = /* glsl */ `
varying vec3 vCol; varying float vCore; varying float vIcl; varying float vSpike; varying float vSB;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  vec2 q = p * vCore;                                     // core units
  float rq = length(q);
  // brightest cluster galaxy: a cuspy, NFW/Sersic-like core (sharp peak, long shallow wing) —
  // the only part of the web allowed past display white
  float core = 1.6 * exp(-rq * rq * 3.0) + 0.10 * exp(-rq * 1.1);
  // intracluster light: de Vaucouleurs envelope truncated at R200, so voids stay true black
  float ri = sqrt(r2) / vIcl;
  float icl = 0.08 * exp(-pow(ri, 0.5) * 5.5) * exp(-ri * ri * 1.5) * (1.0 - smoothstep(0.35, 1.0, sqrt(r2)));
  float sp = 0.0;                                          // hexagonal (JWST) diffraction pattern
  for (int k = 0; k < 3; k++) {
    float an = 1.5707963 + float(k) * 1.0471976;
    vec2 e = vec2(cos(an), sin(an));
    sp += exp(-abs(dot(q, vec2(-e.y, e.x))) * 2.2) * exp(-abs(dot(q, e)) / vCore * 6.0);
  }
  float v = core + 0.16 * sp * vSpike * (1.0 - smoothstep(0.5, 1.0, sqrt(r2)));
  // ICL: warm gold envelope, redder in its outskirts
  vec3 iclCol = mix(vec3(1.0, 0.55, 0.22), vec3(1.0, 0.82, 0.55), exp(-ri * 3.0));
  gl_FragColor = vec4(vCol * v + iclCol * icl * 20.0 * vSB, 1.0);
}`;


// Member galaxies: each massive halo is resolved into a swarm of 40 cluster members (projected
// NFW-like radial distribution inside R200, Schechter-like luminosities, red-sequence ellipticals
// with random ellipticity and orientation) — substructure, not a smeared blob.
const MVERT = /* glsl */ `
attribute float aLum; attribute vec3 aShape;   // ellipticity, angle, colour seed
uniform float uProj; uniform float uFog; uniform float uFogNear; uniform float uGain; uniform float uPxK;
varying vec3 vCol; varying vec3 vShape; varying float vPx;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;
  if (dist < 0.4 || aLum <= 0.0 || uGain <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); return; }
  // physical size ~ 30-80 kpc → a few px when close, sub-pixel (energy-conserving) when far
  float sz = (0.035 + 0.05 * aLum) * uProj / dist;
  float px = clamp(sz * 2.0, 1.0, 9.0 * uPxK);
  gl_PointSize = px;
  vPx = px;
  float tr = exp(-max(dist - uFogNear, 0.0) / uFog);
  float area = max(1.0, sz * sz * 2.0);
  float b = uGain * tr * aLum * 3000.0 / max(dist * dist, 25.0) * min(4.0, area) / area * (px * px / max(px * px, 1.0));
  vCol = mix(vec3(1.0, 0.72, 0.46), vec3(1.0, 0.9, 0.78), aShape.z) * b;
  vShape = aShape;
}`;
const MFRAG = /* glsl */ `
varying vec3 vCol; varying vec3 vShape; varying float vPx;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float c = cos(vShape.y), s = sin(vShape.y);
  vec2 q = vec2(c * p.x + s * p.y, (-s * p.x + c * p.y) / mix(1.0, 0.45, vShape.x * step(2.5, vPx)));
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  // de Vaucouleurs-ish: bright nucleus, extended envelope
  float v = exp(-sqrt(r2) * 5.0) * 1.6 + 0.25 * exp(-r2 * 3.0);
  gl_FragColor = vec4(vCol * v, 1.0);
}`;
const NMEM = 96;

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
      uniforms: { uProj: { value: 600 }, uFog: { value: 60 }, uFogNear: { value: 0 }, uGain: { value: 1 }, uPxK: { value: 1 }, uTime: { value: 0 }, uNear: { value: 0 } },
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;

    // resolved cluster members of the top halos
    this.nTop = Math.min(max, 32);
    const nm = this.nTop * NMEM;
    this.mOff = new Float32Array(nm * 3);
    const mg = new THREE.BufferGeometry();
    this.mPos = new Float32Array(nm * 3);
    this.mLum = new Float32Array(nm);
    const mShape = new Float32Array(nm * 3);
    let hs = 0x9e3779b9;
    const rnd = () => { hs ^= hs << 13; hs >>>= 0; hs ^= hs >>> 17; hs ^= hs << 5; hs >>>= 0; return hs / 4294967296; };
    for (let i = 0; i < nm; i++) {
      // projected-NFW-like radius (concentrated, long tail) inside R200, isotropic direction
      const u = rnd(), r = Math.min(1, 0.08 + 0.92 * Math.pow(u, 1.6));
      const z = rnd() * 2 - 1, ph = rnd() * Math.PI * 2, rr = Math.sqrt(1 - z * z);
      this.mOff[i * 3] = Math.cos(ph) * rr * r; this.mOff[i * 3 + 1] = z * r; this.mOff[i * 3 + 2] = Math.sin(ph) * rr * r;
      // Schechter-like: many faint, a few bright members
      const l = rnd();
      this.mLum[i] = 0.15 + 1.6 * l * l * l * l;
      mShape[i * 3] = rnd(); mShape[i * 3 + 1] = rnd() * Math.PI; mShape[i * 3 + 2] = rnd();
    }
    this.mLumBase = this.mLum.slice();
    mg.setAttribute('position', new THREE.BufferAttribute(this.mPos, 3));
    mg.setAttribute('aLum', new THREE.BufferAttribute(this.mLum, 1));
    mg.setAttribute('aShape', new THREE.BufferAttribute(mShape, 3));
    mg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    mg.setDrawRange(0, 0);
    const U = this.material.uniforms;
    this.memMaterial = new THREE.ShaderMaterial({
      vertexShader: MVERT, fragmentShader: MFRAG,
      uniforms: { uProj: U.uProj, uFog: U.uFog, uFogNear: U.uFogNear, uGain: U.uGain, uPxK: U.uPxK },
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    this.members = new THREE.Points(mg, this.memMaterial);
    this.members.frustumCulled = false;
    this.members.renderOrder = 6;
    this.points.add(this.members);
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
    // members follow their halo (R200 ∝ M^1/3; 1.6 Mpc/h at 1e15), richness ∝ mass
    const nt = Math.min(this.nTop, n);
    for (let i = 0; i < nt; i++) {
      const lm = this.mass[i];
      const R = 1.63 * Math.pow(10, (lm - 2) / 3);
      const rich = Math.max(0, Math.min(1, (lm + 0.6) / 2.4));
      const cx = this.pos[i * 3], cy = this.pos[i * 3 + 1], cz = this.pos[i * 3 + 2];
      for (let j = 0; j < NMEM; j++) {
        const k = i * NMEM + j;
        // members orbit inside the potential well (σ_v shimmer): faster near the core
        const ox = this.mOff[k * 3], oy = this.mOff[k * 3 + 1], oz = this.mOff[k * 3 + 2];
        const rr = Math.max(0.08, Math.hypot(ox, oy, oz));
        const th = time * (0.035 / Math.sqrt(rr)) * (j & 1 ? 1 : -1) + j * 0.37;
        const c = Math.cos(th), sn = Math.sin(th);
        this.mPos[k * 3] = cx + (c * ox + sn * oz) * R; this.mPos[k * 3 + 1] = cy + oy * R; this.mPos[k * 3 + 2] = cz + (-sn * ox + c * oz) * R;
        this.mLum[k] = j < NMEM * rich ? this.mLumBase[k] : 0;
      }
    }
    const mg = this.members.geometry;
    mg.attributes.position.needsUpdate = true; mg.attributes.aLum.needsUpdate = true;
    mg.setDrawRange(0, nt * NMEM);
    const u = this.material.uniforms;
    u.uProj.value = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    u.uPxK.value = height / 720;
    u.uFog.value = params.fog; u.uFogNear.value = params.fogNear; u.uNear.value = params.near ?? 0;
    // galaxies only light up once halos have collapsed (and not in the primordial glow)
    u.uGain.value = (params.lights ?? 1) * (1 - params.warm) * Math.min(1, Math.max(0, (a - 0.25) / 0.35));
    u.uTime.value = time;
  }

  dispose() { this.points.geometry.dispose(); this.material.dispose(); this.members.geometry.dispose(); this.memMaterial.dispose(); }
}
