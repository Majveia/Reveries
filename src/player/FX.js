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

/**
 * Character shadow catcher: a small terrain-conforming grid around the feet that
 * receives the explorer's own high-resolution shadow (CharShadow's depth map), so
 * the hero always casts a crisp, grounded shadow even where the planet-scale sun
 * shadow map is far too coarse. The penumbra widens with distance from the
 * occluder (contact-hardening), and the whole thing fades at the grid edge.
 */
export class ShadowCatcher {
  constructor(shadowUniforms, n = 9, half = 2.6) {
    this.n = n; this.half = half;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * n * 3), gv = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i;
      gv[k * 2] = (i / (n - 1)) * 2 - 1; gv[k * 2 + 1] = (j / (n - 1)) * 2 - 1;
    }
    const idx = [];
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aGrid', new THREE.BufferAttribute(gv, 2));
    g.setIndex(idx);
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...shadowUniforms, uStrength: { value: 0.5 } },
      vertexShader: /* glsl */`
        attribute vec2 aGrid; varying vec2 vG; varying vec3 vView;
        void main() { vG = aGrid; vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uCSMap; uniform mat4 uCSMat; uniform float uCSHalf; uniform float uCSOn; uniform float uCSTexel; uniform float uStrength;
        varying vec2 vG; varying vec3 vView;
        void main() {
          if (uCSOn < 0.5) discard;
          vec4 sp = uCSMat * vec4(vView, 1.0);
          vec2 uv = sp.xy / uCSHalf * 0.5 + 0.5;
          float edge = smoothstep(0.0, 0.06, uv.x) * smoothstep(1.0, 0.94, uv.x) * smoothstep(0.0, 0.06, uv.y) * smoothstep(1.0, 0.94, uv.y);
          if (edge <= 0.0) discard;
          float d = -sp.z;
          // blocker distance → penumbra width (contact hardening)
          float blk = texture2D(uCSMap, uv).r;
          float pen = clamp((d - blk) * 0.02, 0.0035, 0.03) / (2.0 * uCSHalf);
          float s = 0.0;
          for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) {
            vec2 o = vec2(float(i), float(j)) * pen * 0.5;
            float st = texture2D(uCSMap, uv + o).r;
            s += smoothstep(st + 0.02, st + 0.06, d);
          }
          s /= 25.0;
          float fade = 1.0 - smoothstep(0.65, 1.0, max(abs(vG.x), abs(vG.y)));
          float a = s * edge * fade * uStrength;
          if (a < 0.003) discard;
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }`,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    this.object = new THREE.Mesh(g, this.material);
    this.object.renderOrder = 2;
    this.object.frustumCulled = false;
    this.object.visible = false;
    this._g = {};
    this._c = new THREE.Vector3(9e9, 0, 0);
  }

  /** center: world point on the ground (shadow centre); up/right/fwd: tangent basis. */
  update(world, center, up, right, fwd) {
    const o = this.object;
    o.position.copy(center);
    if (this._c.distanceToSquared(center) < 0.0004) return;
    this._c.copy(center);
    const n = this.n, h = this.half, pos = o.geometry.attributes.position.array;
    const p = this._p || (this._p = new THREE.Vector3());
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = ((i / (n - 1)) * 2 - 1) * h, z = ((j / (n - 1)) * 2 - 1) * h;
      p.copy(center).addScaledVector(right, x).addScaledVector(fwd, z).addScaledVector(up, 0.6);
      const gq = world.groundAt(p, this._g);
      let r = gq.radius;
      if (gq.water && gq.waterRadius > r) r = gq.waterRadius;
      p.setLength(r + 0.012).sub(center);
      pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
    }
    o.geometry.attributes.position.needsUpdate = true;
  }

  dispose() { this.object.geometry.dispose(); this.material.dispose(); }
}
