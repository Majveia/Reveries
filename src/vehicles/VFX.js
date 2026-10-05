// Vehicle VFX — all GPU-cheap, HDR, additive or soft alpha:
//   Flame      thruster plume: shock diamonds, hot core, fresnel edge (cone mesh)
//   Particles  world-space ring-buffer point sprites (dust, water spray, sparks);
//              motion is evaluated in the vertex shader from spawn state
//   Trail      camera-facing ribbon from a ring buffer of points (contrails,
//              wingtip vortices, bike light trails)
//   Plasma     re-entry shock sheath: stretched fresnel shell with flowing noise
//   Streaks    camera-space speed lines (boost)
//   GroundGlow repulsor light pool on the ground below the hover bike

import * as THREE from 'three';

const _tq = new THREE.Vector3();

const NOISE = /* glsl */`
float h31(vec3 p){ p = fract(p*0.3183099+.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vnoise(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(h31(i),h31(i+vec3(1,0,0)),f.x),mix(h31(i+vec3(0,1,0)),h31(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(h31(i+vec3(0,0,1)),h31(i+vec3(1,0,1)),f.x),mix(h31(i+vec3(0,1,1)),h31(i+vec3(1,1,1)),f.x),f.y),f.z); }
`;

// ------------------------------------------------------------------------------------------
export class Flame {
  constructor({ radius = 0.4, length = 3, core = [1.0, 0.85, 0.7], edge = [1.0, 0.35, 0.08], boost = [0.45, 0.6, 1.0], gain = 1 } = {}) {
    const g = new THREE.CylinderGeometry(radius * 0.08, radius, 1, 24, 12, true);
    g.translate(0, 0.5, 0);
    g.rotateX(-Math.PI / 2); // tip toward -Z
    this.uniforms = {
      uTime: { value: 0 }, uThrottle: { value: 0 }, uBoost: { value: 0 }, uSeed: { value: Math.random() * 10 }, uGain: { value: gain },
      uCore: { value: new THREE.Color(...core) }, uEdge: { value: new THREE.Color(...edge) }, uBoostCol: { value: new THREE.Color(...boost) },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        varying float vA; varying float vF; varying vec3 vL;
        uniform float uTime, uThrottle;
        void main(){
          vA = uv.y; vL = position;
          vec3 p = position;
          // flicker the plume width
          p.xy *= 1.0 + 0.08*sin(uTime*60.0 + uv.y*20.0)*uv.y;
          vec4 mv = modelViewMatrix*vec4(p,1.0);
          vec3 n = normalize(normalMatrix*normal);
          vF = abs(dot(n, normalize(-mv.xyz)));
          gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader: /* glsl */`
        ${NOISE}
        varying float vA; varying float vF; varying vec3 vL;
        uniform float uTime, uThrottle, uBoost, uSeed, uGain;
        uniform vec3 uCore, uEdge, uBoostCol;
        void main(){
          float a = vA;                              // 0 at the nozzle → 1 at the tip
          float facing = vF;                         // 1 = looking through the plume's core
          float core = pow(facing, 7.0);
          float sheath = pow(facing, 1.5);
          float body = pow(1.0 - a, 2.6);
          // Mach diamonds: bright knots along the hot core, fading downstream
          float dia = 0.55 + 0.45*pow(max(0.0, sin(a*30.0 - uTime*3.0)), 6.0) * (1.0 - a);
          float n = vnoise(vec3(vL.xy*7.0, vL.z*4.0 - uTime*36.0 + uSeed));
          float I = body * (sheath*0.35 + core*dia*1.6) * (0.6 + 0.6*n);
          vec3 c = mix(uEdge, uCore, clamp(core*(1.3 - a), 0.0, 1.0));
          c = mix(c, uBoostCol + vec3(0.12)*core, uBoost*0.7);
          float e = 0.3 + uThrottle*2.6 + uBoost*3.0;
          gl_FragColor = vec4(c * I * e * 2.2 * uGain * smoothstep(0.0, 0.06, a + 0.01), 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.length = length;
  }
  set(throttle, boost, t) {
    const u = this.uniforms;
    u.uThrottle.value = throttle; u.uBoost.value = boost; u.uTime.value = t;
    const L = this.length * (0.18 + throttle * 0.7 + boost * 0.9);
    this.mesh.scale.set(1 + boost * 0.15, 1 + boost * 0.15, Math.max(0.05, L));
    this.mesh.visible = throttle + boost > 0.01;
  }
  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

// ------------------------------------------------------------------------------------------
export class Particles {
  constructor(count = 1024, { additive = false } = {}) {
    this.count = count;
    this.head = 0;
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aMeta = new THREE.BufferAttribute(new Float32Array(count * 4), 4).setUsage(THREE.DynamicDrawUsage); // birth, life, size0, size1
    this.aCol = new THREE.BufferAttribute(new Float32Array(count * 4), 4).setUsage(THREE.DynamicDrawUsage); // rgb, alpha*gravityFlag
    for (let i = 0; i < count; i++) this.aMeta.array[i * 4] = -1e6;
    g.setAttribute('position', this.aPos);
    g.setAttribute('aVel', this.aVel);
    g.setAttribute('aMeta', this.aMeta);
    g.setAttribute('aCol', this.aCol);
    this.uniforms = {
      uTime: { value: 0 }, uScale: { value: 500 }, uUp: { value: new THREE.Vector3(0, 1, 0) },
      uLight: { value: new THREE.Color(1, 1, 1) }, uAmb: { value: new THREE.Color(0.3, 0.3, 0.35) },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */`
        attribute vec3 aVel; attribute vec4 aMeta; attribute vec4 aCol;
        uniform float uTime, uScale; uniform vec3 uUp;
        varying vec4 vC; varying float vT;
        void main(){
          float age = uTime - aMeta.x;
          float t = age / aMeta.y;
          if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
          float k = 2.2; // drag
          vec3 p = position + aVel * (1.0 - exp(-k*age)) / k;
          float grav = aCol.w < 0.0 ? 1.0 : 0.0;
          p -= uUp * grav * 4.9 * age * age * 0.9;
          p += uUp * (1.0 - grav) * age * 0.6; // warm dust rises a little
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float size = mix(aMeta.z, aMeta.w, sqrt(t));
          gl_PointSize = clamp(size * uScale / max(0.1, -mv.z), 0.0, 256.0);
          float fade = smoothstep(0.0, 0.08, t) * (1.0 - t) * (1.0 - t);
          vC = vec4(aCol.rgb, abs(aCol.w) * fade); vT = t;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uLight, uAmb;
        varying vec4 vC; varying float vT;
        void main(){
          vec2 q = gl_PointCoord*2.0 - 1.0;
          float r2 = dot(q,q);
          if (r2 > 1.0) discard;
          float a = (1.0 - r2); a *= a;
          // fake lit volume: brighter on the upper side
          float lit = 0.55 + 0.45*(-q.y);
          vec3 c = vC.rgb * (uLight*lit + uAmb);
          gl_FragColor = vec4(c, vC.a * a);
        }`,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this._dirty = false;
  }
  /** grav: true → falls (spray); false → floats (dust). */
  emit(p, v, life, s0, s1, r, g, b, a, t, grav = false) {
    const i = this.head; this.head = (this.head + 1) % this.count;
    this.aPos.array[i * 3] = p.x; this.aPos.array[i * 3 + 1] = p.y; this.aPos.array[i * 3 + 2] = p.z;
    this.aVel.array[i * 3] = v.x; this.aVel.array[i * 3 + 1] = v.y; this.aVel.array[i * 3 + 2] = v.z;
    this.aMeta.array[i * 4] = t; this.aMeta.array[i * 4 + 1] = life; this.aMeta.array[i * 4 + 2] = s0; this.aMeta.array[i * 4 + 3] = s1;
    this.aCol.array[i * 4] = r; this.aCol.array[i * 4 + 1] = g; this.aCol.array[i * 4 + 2] = b; this.aCol.array[i * 4 + 3] = grav ? -a : a;
    this._dirty = true;
  }
  update(t, camera, height) {
    this.uniforms.uTime.value = t;
    this.uniforms.uScale.value = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    if (this._dirty) { this.aPos.needsUpdate = this.aVel.needsUpdate = this.aMeta.needsUpdate = this.aCol.needsUpdate = true; this._dirty = false; }
  }
  dispose() { this.points.geometry.dispose(); this.material.dispose(); }
}

// ------------------------------------------------------------------------------------------
export class Trail {
  constructor(n = 64, { width = 0.4, color = [1, 1, 1], additive = true, minStep = 2, grow = 2.4, erode = 0.35 } = {}) {
    this.erode = erode;
    this.n = n; this.minStep = minStep;
    this.pts = Array.from({ length: n }, () => new THREE.Vector3());
    this.w = new Float32Array(n);
    this.count = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.nxt = new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.side = new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage); // side, u, width·alpha
    g.setAttribute('position', this.pos); g.setAttribute('aNext', this.nxt); g.setAttribute('aSide', this.side);
    const idx = [];
    for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    this.uniforms = { uColor: { value: new THREE.Color(...color) }, uWidth: { value: width }, uGrow: { value: grow }, uErode: { value: erode }, uTime: { value: 0 }, uLight: { value: new THREE.Color(1, 1, 1) } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */`
        attribute vec3 aNext; attribute vec3 aSide;
        uniform float uWidth, uGrow;
        varying float vU; varying float vS; varying float vA;
        void main(){
          vec4 a = modelViewMatrix*vec4(position,1.0);
          vec4 b = modelViewMatrix*vec4(aNext,1.0);
          vec3 d = b.xyz - a.xyz; if (dot(d,d) < 1e-8) d = vec3(0.0,0.0,1.0);
          vec3 side = normalize(cross(d, a.xyz));
          float w = uWidth * (0.6 + aSide.y*uGrow);
          a.xyz += side * aSide.x * w;
          gl_Position = projectionMatrix*a;
          vU = aSide.y; vS = aSide.x; vA = aSide.z;
        }`,
      fragmentShader: /* glsl */`
        ${NOISE}
        uniform vec3 uColor, uLight; uniform float uTime, uErode;
        varying float vU; varying float vS; varying float vA;
        void main(){
          float edge = exp(-vS*vS*3.2) - 0.04;
          float nn = vnoise(vec3(vU*26.0, vS*3.0, uTime*0.7)) * 0.6 + vnoise(vec3(vU*70.0, vS*7.0, uTime*1.3)) * 0.4;
          float n = mix(1.0, smoothstep(0.15 + vU*0.5, 0.9, nn + 0.35), uErode);
          float fade = smoothstep(0.0, 0.05, vU) * pow(1.0 - vU, 1.4);
          gl_FragColor = vec4(uColor*uLight, 1.0) * (max(edge, 0.0)*n*fade*vA);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }
  reset() { this.count = 0; }
  /** Push the emitter position (world) with an intensity 0..1. */
  push(p, intensity) {
    if (this.count > 0 && this.pts[0].distanceToSquared(p) < this.minStep * this.minStep) {
      this.pts[0].copy(p); this.w[0] = intensity; // slide the head
    } else {
      const last = this.pts[this.n - 1];
      for (let i = this.n - 1; i > 0; i--) { this.pts[i] = this.pts[i - 1]; this.w[i] = this.w[i - 1]; }
      this.pts[0] = last.copy(p); this.w[0] = intensity;
      this.count = Math.min(this.n, this.count + 1);
    }
    this._write();
  }
  _write() {
    const P = this.pos.array, N = this.nxt.array, S = this.side.array, n = this.n, c = this.count;
    if (!c) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    const q = _tq;
    for (let i = 0; i < n; i++) {
      const k = Math.min(i, c - 1);
      const p = this.pts[k];
      if (k + 1 < c) q.copy(this.pts[k + 1]);
      else if (k > 0) q.copy(p).multiplyScalar(2).sub(this.pts[k - 1]);
      else q.copy(p).addScalar(0.01);
      for (let s = 0; s < 2; s++) {
        const j = (i * 2 + s) * 3;
        P[j] = p.x; P[j + 1] = p.y; P[j + 2] = p.z;
        N[j] = q.x; N[j + 1] = q.y; N[j + 2] = q.z;
        S[j] = s ? 1 : -1; S[j + 1] = i / (n - 1); S[j + 2] = i < c ? this.w[k] : 0;
      }
    }
    this.pos.needsUpdate = this.nxt.needsUpdate = this.side.needsUpdate = true;
  }
  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

// ------------------------------------------------------------------------------------------
export class Plasma {
  constructor(radius = 5) {
    const g = new THREE.SphereGeometry(1, 48, 24);
    this.uniforms = { uTime: { value: 0 }, uI: { value: 0 }, uTail: { value: 3 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        uniform float uTail, uTime;
        varying vec3 vL; varying float vF; varying float vBack;
        void main(){
          vec3 p = position;
          // local +Z is the flight direction: blunt shock front, long wake behind
          float back = smoothstep(0.2, -1.0, p.z);
          p.z = p.z > 0.0 ? p.z*0.55 : p.z*(1.0 + uTail*back);
          p.xy *= 1.0 - back*0.55;
          vL = position; vBack = back;
          vec4 mv = modelViewMatrix*vec4(p,1.0);
          vec3 n = normalize(normalMatrix*normal);
          vF = 1.0 - abs(dot(n, normalize(-mv.xyz)));
          gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader: /* glsl */`
        ${NOISE}
        uniform float uTime, uI;
        varying vec3 vL; varying float vF; varying float vBack;
        void main(){
          float n = vnoise(vec3(vL.xy*5.0, vL.z*2.0 + uTime*14.0));
          float n2 = vnoise(vec3(vL.xy*13.0, vL.z*5.0 + uTime*31.0));
          float front = smoothstep(-0.2, 0.9, vL.z);
          float rim = pow(vF, 2.2);
          float I = (rim*(0.5 + front*1.6) + front*0.25) * (0.55 + 0.7*n*n2) * (1.0 - vBack*0.75);
          vec3 hot = vec3(1.0, 0.82, 0.62);
          vec3 orange = vec3(1.0, 0.36, 0.08);
          vec3 violet = vec3(0.75, 0.25, 1.0);
          vec3 c = mix(orange, hot, front*rim);
          c = mix(c, violet, vBack*0.6);
          gl_FragColor = vec4(c * I * uI * 6.0, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.scale.setScalar(radius);
    this.mesh.visible = false;
  }
  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

// ------------------------------------------------------------------------------------------
export class Streaks {
  constructor(n = 90) {
    const pos = [], aS = [];
    let seed = 12345;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, r = 2.2 + rnd() * 6, z0 = rnd(), len = 0.4 + rnd() * 1.2, sp = 0.6 + rnd() * 0.8;
      const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.7;
      for (const [s, e] of [[-1, 0], [1, 0], [-1, 1], [1, 0], [1, 1], [-1, 1]]) { pos.push(x, y, 0); aS.push(s, e, z0, len, sp, a); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    // pack 6 floats into two vec3 attributes
    const A = new Float32Array(n * 6 * 3), B = new Float32Array(n * 6 * 3);
    for (let i = 0; i < n * 6; i++) { A[i * 3] = aS[i * 6]; A[i * 3 + 1] = aS[i * 6 + 1]; A[i * 3 + 2] = aS[i * 6 + 2]; B[i * 3] = aS[i * 6 + 3]; B[i * 3 + 1] = aS[i * 6 + 4]; B[i * 3 + 2] = aS[i * 6 + 5]; }
    g.setAttribute('aS', new THREE.BufferAttribute(A, 3));
    g.setAttribute('aT', new THREE.BufferAttribute(B, 3));
    this.uniforms = { uTime: { value: 0 }, uI: { value: 0 }, uSpeed: { value: 1 }, uColor: { value: new THREE.Color(0.8, 0.9, 1.0) } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute vec3 aS; attribute vec3 aT;
        uniform float uTime, uSpeed;
        varying float vE; varying float vZ;
        void main(){
          float z = fract(aS.z - uTime*aT.y*uSpeed*0.6);
          float depth = mix(-60.0, -2.0, z);
          float len = aT.x * (4.0 + uSpeed*10.0);
          vec3 p = vec3(position.xy * (1.0 + (1.0-z)*0.6), depth - aS.y*len);
          vec2 tang = vec2(-sin(aT.z), cos(aT.z));
          p.xy += tang * aS.x * 0.012;
          gl_Position = projectionMatrix * vec4(p, 1.0);
          vE = aS.y; vZ = z;
        }`,
      fragmentShader: /* glsl */`
        uniform float uI; uniform vec3 uColor;
        varying float vE; varying float vZ;
        void main(){
          float a = (1.0 - vE) * vE * 4.0 * smoothstep(0.0, 0.3, vZ) * smoothstep(1.0, 0.7, vZ);
          gl_FragColor = vec4(uColor * a * uI * 0.9, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 50;
    this.mesh.visible = false;
  }
  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

// ------------------------------------------------------------------------------------------
export class GroundGlow {
  constructor(color = [0.35, 0.85, 1.0]) {
    const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2);
    this.uniforms = { uColor: { value: new THREE.Color(...color) }, uI: { value: 1 }, uTime: { value: 0 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uI, uTime; varying vec2 vUv;
        void main(){
          vec2 q = (vUv - 0.5) * vec2(2.0, 2.0);
          float d = length(q * vec2(1.6, 0.8));
          float a = exp(-d*d*4.0) * (0.9 + 0.1*sin(uTime*40.0));
          float ring = exp(-pow((d - 0.55)*9.0, 2.0)) * 0.25;
          gl_FragColor = vec4(uColor * (a + ring) * uI, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
  }
  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

// ------------------------------------------------------------------------------------------
/** Camera-facing additive glow sprite (nozzle bloom seed visible from any angle). */
export class GlowSprite {
  constructor(color = [1.0, 0.6, 0.3], size = 1) {
    const g = new THREE.PlaneGeometry(1, 1);
    this.uniforms = { uColor: { value: new THREE.Color(...color) }, uI: { value: 1 }, uSize: { value: size }, uAxis: { value: new THREE.Vector3(0, 0, -1) } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        uniform float uSize; uniform vec3 uAxis;
        varying vec2 vQ; varying float vView;
        void main(){
          vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec3 ax = normalize(normalMatrix * uAxis);
          vView = max(0.0, dot(ax, normalize(-c.xyz)));   // 1 = looking up the nozzle
          vQ = position.xy * 2.0;
          c.xy += position.xy * uSize * (0.55 + 0.45 * vView);
          c.z += uSize * 0.35;                              // pull toward the camera past the bell lip
          gl_Position = projectionMatrix * c;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uI;
        varying vec2 vQ; varying float vView;
        void main(){
          float r = length(vQ);
          float core = exp(-r*r*18.0);
          float halo = exp(-r*r*4.5) * 0.35;
          vec3 c = mix(uColor, vec3(1.0), core*0.8);
          gl_FragColor = vec4(c * (core*3.0 + halo) * uI * (0.35 + 0.65*vView), 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }
  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

/** Soft contact shadow / blob decal projected on the ground under a low vehicle. */
export class BlobShadow {
  constructor() {
    const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2);
    this.uniforms = { uI: { value: 0.5 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: /* glsl */`
        uniform float uI; varying vec2 vUv;
        void main(){
          vec2 q = (vUv - 0.5) * 2.0;
          float d = dot(q, q);
          gl_FragColor = vec4(0.0, 0.0, 0.0, exp(-d*3.5) * uI);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }
  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}
