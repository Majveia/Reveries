// Comets on long eccentric Kepler orbits. Near the star they wake up: a
// glowing coma, a straight blue ion tail pointing exactly anti-sunward, and a
// broader, curved, cream dust tail lagging along the orbit.

import * as THREE from 'three';
import { NOISE_GLSL } from '../../core/glsl/noise.js';

const TAIL_VERT = /* glsl */`
attribute vec2 aT;  // along (0 head … 1 tip), side (-1 … 1)
uniform vec3 uHead, uAxis, uCurve; uniform float uLen, uWidth, uBend;
varying vec2 vT;
void main(){
  float s = aT.x;
  vec3 dir = normalize(uAxis + uCurve * uBend * s * 2.0);
  vec3 p = uHead + uAxis * uLen * s + uCurve * uLen * uBend * s * s;
  vec3 V = normalize(cameraPosition - p);
  vec3 side = normalize(cross(dir, V));
  float w = uWidth * (0.12 + 0.88 * sqrt(s)) ;
  p += side * aT.y * w;
  vT = aT;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const TAIL_FRAG = /* glsl */`
${NOISE_GLSL}
uniform vec3 uCol; uniform float uI, uTime, uSeed, uStreak;
varying vec2 vT;
void main(){
  float s = vT.x, y = vT.y;
  float across = exp(-y * y * (uStreak > 0.5 ? 9.0 : 3.5));
  float along = pow(1.0 - s, 1.6) * smoothstep(0.0, 0.03, s);
  float st = uStreak > 0.5
    ? 0.55 + 0.9 * smoothstep(-0.2, 0.7, snoise(vec2(y * 7.0 + uSeed, s * 2.0 - uTime * 0.25)))
    : 0.75 + 0.35 * snoise(vec2(y * 2.5 + uSeed, s * 4.0 - uTime * 0.05));
  gl_FragColor = vec4(uCol * uI * across * along * st, 1.0);
}`;

export class Comet {
  constructor(engine, data, layout, starColor, idx) {
    this.data = data; this.layout = layout;
    this.group = new THREE.Group();
    const a = data.a, e = data.e;
    let M0 = data.M0;
    if (idx === 0) {
      // the first comet is caught inbound, a little before perihelion, tail ablaze
      const q = a * (1 - e), r = Math.min(a, q * 1.3);
      const cosE = (1 - r / a) / e, E = -Math.acos(THREE.MathUtils.clamp(cosE, -1, 1));
      M0 = E - e * Math.sin(E);
    }
    this.el = { a, e, i: data.i, node: data.node, peri: data.peri, M0, period: layout.periodDays(a) };
    this.position = new THREE.Vector3();
    this.prev = new THREE.Vector3();

    const mkTail = (color, I, width, bend, streak, nS) => {
      const g = new THREE.BufferGeometry();
      const n = 64, pos = new Float32Array((n + 1) * 2 * 3), t = new Float32Array((n + 1) * 2 * 2), idxs = [];
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j < 2; j++) { const k = i * 2 + j; t[k * 2] = i / n; t[k * 2 + 1] = j ? 1 : -1; }
        if (i < n) { const b = i * 2; idxs.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aT', new THREE.BufferAttribute(t, 2));
      g.setIndex(idxs);
      const m = new THREE.ShaderMaterial({
        uniforms: {
          uHead: { value: this.position }, uAxis: { value: new THREE.Vector3(1, 0, 0) }, uCurve: { value: new THREE.Vector3(0, 0, 1) },
          uLen: { value: 1 }, uWidth: { value: width }, uBend: { value: bend }, uCol: { value: color }, uI: { value: I }, uTime: { value: 0 }, uSeed: { value: nS }, uStreak: { value: streak },
        },
        vertexShader: TAIL_VERT, fragmentShader: TAIL_FRAG,
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 5;
      this.group.add(mesh);
      return m;
    };
    this.ion = mkTail(new THREE.Color(0.25, 0.55, 1.0), 1.2, 0.35, 0.0, 1, idx * 7.1);
    this.dust = mkTail(new THREE.Color(1.0, 0.86, 0.66).multiply(starColor), 0.9, 1.1, 0.55, 0, idx * 3.3);

    // nucleus + coma
    this.comaMat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 1 }, uI: { value: 1 }, uCol: { value: new THREE.Color(0.75, 0.88, 1.0) } },
      vertexShader: /* glsl */`uniform float uSize; varying vec2 vUv; void main(){ vUv = position.xy; vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0); mv.xy += position.xy * uSize; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */`uniform float uI; uniform vec3 uCol; varying vec2 vUv; void main(){ float r = length(vUv); float a = exp(-r * 7.0) * 0.8 + 0.06 / (1.0 + r * r * 300.0) * 6.0; gl_FragColor = vec4(uCol * a * uI * smoothstep(1.0, 0.6, r), 1.0); }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });
    this.coma = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.comaMat);
    this.coma.frustumCulled = false; this.coma.renderOrder = 6;
    this.group.add(this.coma);
    this.nucleus = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.19, 0.18) }));
    this.group.add(this.nucleus);
  }

  update(days, t) {
    const L = this.layout;
    L.position(this.el, days - 2, this.prev);
    L.position(this.el, days, this.position);
    this.coma.position.copy(this.position);
    this.nucleus.position.copy(this.position);
    // activity rises steeply toward the star (true distance in AU)
    const rv = this.position.length();
    const rAU = L.ra(rv) / L.sl;
    const act = THREE.MathUtils.clamp(6.0 / (rAU * rAU + 0.3), 0.04, 3.0);
    const anti = _a.copy(this.position).normalize();
    const vel = _b.copy(this.position).sub(this.prev);
    if (vel.lengthSq() < 1e-12) vel.set(0, 0, 1);
    vel.normalize();
    // dust lags behind along the orbit: bend opposite to the velocity, perpendicular to the anti-sun axis
    const curve = _c.copy(vel).multiplyScalar(-1).addScaledVector(anti, vel.dot(anti)).normalize();
    const len = THREE.MathUtils.clamp(4 + 7 * act, 3, 26);
    for (const [m, k] of [[this.ion, 1.0], [this.dust, 0.72]]) {
      const u = m.uniforms;
      u.uAxis.value.copy(anti); u.uCurve.value.copy(curve); u.uLen.value = len * k;
      u.uI.value = (m === this.ion ? 1.1 : 0.8) * Math.min(1.5, act);
      u.uTime.value = t;
    }
    this.comaMat.uniforms.uSize.value = 0.6 + 0.8 * Math.min(1.5, act);
    this.comaMat.uniforms.uI.value = 0.35 + 0.8 * Math.min(1.5, act);
  }

  dispose() { this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); }
}
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
