// Hearth smoke: thin, wind-sheared wisps rising from chimneys. One instanced
// billboard mesh per settlement; every puff is animated on the GPU (rise,
// grow, shear, fade) so the whole town breathes with zero CPU cost.

import * as THREE from 'three';

const VERT = /* glsl */`
attribute vec4 aBase;   // xyz chimney top (settlement-local), w seed
attribute float aPuff;  // 0..1 phase offset of this puff in its column
uniform float uCivTime; uniform vec4 uCivWind;
varying vec2 vUv; varying float vA; varying float vAge; varying float vSeed;
void main(){
  float seed = aBase.w;
  float age = fract(uCivTime * (0.045 + 0.02 * seed) + aPuff + seed * 7.0);
  vec2 dir = normalize(vec2(cos(seed * 40.0), sin(seed * 40.0)) * 0.35 + vec2(0.8, 0.45));
  float rise = age * (14.0 + 8.0 * seed);
  vec3 c = aBase.xyz + vec3(0.0, rise, 0.0);
  c.xz += dir * (age * age * (7.0 + 6.0 * uCivWind.w)) + vec2(sin(age * 6.0 + seed * 30.0), cos(age * 5.0 + seed * 20.0)) * age * 0.8;
  float size = 1.6 + age * (7.0 + 4.0 * seed);
  vec4 mv = modelViewMatrix * vec4(c, 1.0);
  float rot = seed * 6.28 + age * 1.5;
  vec2 p = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * position.xy;
  mv.xy += p * size;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy + 0.5;
  vA = smoothstep(0.0, 0.2, age) * (1.0 - smoothstep(0.35, 1.0, age));
  vAge = age; vSeed = seed;
}`;

const FRAG = /* glsl */`
uniform vec3 uCivSkyZ, uCivSkyH, uCivLamp, uCivSunL; uniform float uCivNight, uCivDay, uCivTime;
varying vec2 vUv; varying float vA; varying float vAge; varying float vSeed;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
void main(){
  vec2 q = vUv - 0.5;
  float r = length(q) * 2.0;
  float n = n2(vUv * 3.0 + vSeed * 17.0 + vAge * 1.5) * 0.6 + n2(vUv * 7.0 - vSeed * 9.0) * 0.4;
  float a = (1.0 - smoothstep(0.0, 1.0, r + (n - 0.5) * 0.5)) * vA * 0.11;
  if (a < 0.003) discard;
  // lit by the sky (cool) with a little sun on top and warm town glow from below at night
  vec3 sky = uCivSkyH * 0.22 + uCivSkyZ * 0.18;
  vec3 col = sky * (0.55 + 0.45 * n) + uCivLamp * 0.04 * uCivNight * (1.0 - vAge);
  col += vec3(1.0, 0.75, 0.5) * max(uCivSunL.y, 0.0) * uCivDay * 0.25 * n;
  gl_FragColor = vec4(col, a);
}`;

/** items: [{ position: Vector3 (settlement-local), seed }] */
export function makeSmokeMesh(uniforms, items, puffs = 6) {
  const base = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index; g.setAttribute('position', base.getAttribute('position'));
  const n = items.length * puffs;
  const aBase = new Float32Array(n * 4), aPuff = new Float32Array(n);
  let k = 0;
  for (const it of items) {
    for (let i = 0; i < puffs; i++, k++) {
      aBase.set([it.position.x, it.position.y, it.position.z, it.seed], k * 4);
      aPuff[k] = i / puffs;
    }
  }
  g.setAttribute('aBase', new THREE.InstancedBufferAttribute(aBase, 4));
  g.setAttribute('aPuff', new THREE.InstancedBufferAttribute(aPuff, 1));
  g.instanceCount = n;
  const box = new THREE.Box3();
  for (const it of items) box.expandByPoint(it.position);
  box.expandByScalar(30);
  g.boundingBox = box; g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: { uCivTime: uniforms.uCivTime, uCivWind: uniforms.uCivWind, uCivSkyZ: uniforms.uCivSkyZ, uCivSkyH: uniforms.uCivSkyH, uCivLamp: uniforms.uCivLamp, uCivSunL: uniforms.uCivSunL, uCivNight: uniforms.uCivNight, uCivDay: uniforms.uCivDay },
    transparent: true, depthWrite: false,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.renderOrder = 5;
  mesh.name = 'civ-smoke';
  return mesh;
}
