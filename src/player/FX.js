// Small character VFX: footstep / landing / slide dust and a soft contact
// shadow that grounds the explorer on any terrain. Everything is positioned
// relative to a floating origin (the player) so float precision holds at
// planet scale.

import * as THREE from 'three';

const MAX = 160;

export class Dust {
  constructor(color = new THREE.Color('#9a8a70')) {
    this.n = MAX;
    this.p = new Float64Array(MAX * 3); // world positions (double)
    this.v = new Float32Array(MAX * 3);
    this.life = new Float32Array(MAX);
    this.max = new Float32Array(MAX);
    this.size = new Float32Array(MAX);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX * 3);
    this.attr = new Float32Array(MAX * 2); // life01, size
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aLife', new THREE.BufferAttribute(this.attr, 2).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 50);
    this.uniforms = { uColor: { value: color.clone() }, uLight: { value: new THREE.Color(1, 1, 1) }, uScale: { value: 600 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute vec2 aLife; uniform float uScale; varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float t = aLife.x;
          vA = t <= 0.0 ? 0.0 : smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.35, 1.0, t));
          gl_PointSize = aLife.y * (0.6 + 1.6 * t) * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor, uLight; varying float vA;
        void main() {
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float d = dot(c, c);
          if (d > 1.0 || vA <= 0.0) discard;
          float a = (1.0 - d) * (1.0 - d) * vA * 0.32;
          gl_FragColor = vec4(uColor * uLight * a, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.object = new THREE.Points(g, mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 4;
    this.origin = new THREE.Vector3();
  }

  /** Emit n puffs at a world position, spreading in the tangent plane. */
  emit(pos, up, n, speed = 0.8, size = 0.25, life = 1.2, drift = null) {
    for (let k = 0; k < n; k++) {
      const i = this.next; this.next = (this.next + 1) % MAX;
      const a = Math.random() * Math.PI * 2, s = speed * (0.4 + Math.random() * 0.8);
      // tangent basis
      const tx = Math.abs(up.y) < 0.9 ? 1 : 0, ty = tx ? 0 : 1;
      let ux = ty * up.z - 0 * up.y, uy = 0 * up.x - tx * up.z, uz = tx * up.y - ty * up.x;
      const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
      const vx = up.y * uz - up.z * uy, vy = up.z * ux - up.x * uz, vz = up.x * uy - up.y * ux;
      const c = Math.cos(a) * s, d = Math.sin(a) * s;
      this.p[i * 3] = pos.x; this.p[i * 3 + 1] = pos.y; this.p[i * 3 + 2] = pos.z;
      const lift = 0.25 + Math.random() * 0.35;
      this.v[i * 3] = ux * c + vx * d + up.x * lift + (drift ? drift.x : 0);
      this.v[i * 3 + 1] = uy * c + vy * d + up.y * lift + (drift ? drift.y : 0);
      this.v[i * 3 + 2] = uz * c + vz * d + up.z * lift + (drift ? drift.z : 0);
      this.life[i] = 0; this.max[i] = life * (0.7 + Math.random() * 0.6); this.size[i] = size * (0.7 + Math.random() * 0.6);
    }
  }

  update(dt, origin, wind) {
    this.origin.copy(origin);
    for (let i = 0; i < MAX; i++) {
      const m = this.max[i];
      if (m <= 0) { this.attr[i * 2] = 0; continue; }
      this.life[i] += dt;
      const t = this.life[i] / m;
      if (t >= 1) { this.max[i] = 0; this.attr[i * 2] = 0; continue; }
      const drag = Math.exp(-2.2 * dt);
      for (let c = 0; c < 3; c++) {
        this.v[i * 3 + c] = this.v[i * 3 + c] * drag + (wind ? wind.getComponent(c) * 0.35 * dt : 0);
        this.p[i * 3 + c] += this.v[i * 3 + c] * dt;
      }
      this.pos[i * 3] = this.p[i * 3] - origin.x; this.pos[i * 3 + 1] = this.p[i * 3 + 1] - origin.y; this.pos[i * 3 + 2] = this.p[i * 3 + 2] - origin.z;
      this.attr[i * 2] = t; this.attr[i * 2 + 1] = this.size[i];
    }
    this.object.position.copy(origin);
    this.object.geometry.attributes.position.needsUpdate = true;
    this.object.geometry.attributes.aLife.needsUpdate = true;
  }

  dispose() { this.object.geometry.dispose(); this.object.material.dispose(); }
}

/** Soft elliptical contact shadow (ambient occlusion blob) under the feet. */
export class ContactShadow {
  constructor() {
    const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uStrength: { value: 0.55 }, uFeet: { value: new THREE.Vector4(0.1, 0, -0.1, 0) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */`
        uniform float uStrength; uniform vec4 uFeet; varying vec2 vUv;
        float blob(vec2 p, vec2 c, vec2 r) { vec2 q = (p - c) / r; return exp(-dot(q, q) * 2.2); }
        void main() {
          // body blob + a tighter darker blob under each foot (uFeet = x,z per foot in uv space)
          float a = blob(vUv, vec2(0.0), vec2(0.62, 0.5)) * 0.55;
          a += blob(vUv, uFeet.xy, vec2(0.16, 0.26)) * 0.6 + blob(vUv, uFeet.zw, vec2(0.16, 0.26)) * 0.6;
          a = clamp(a, 0.0, 1.0) * uStrength;
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }`,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    this.object = new THREE.Mesh(g, this.material);
    this.object.renderOrder = 2;
    this.object.frustumCulled = false;
    this.object.scale.set(1.2, 1, 1.2);
  }
  dispose() { this.object.geometry.dispose(); this.material.dispose(); }
}
