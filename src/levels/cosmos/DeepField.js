// The deep field behind the simulated volume: thousands of faint, distant
// galaxies at cosmological distances (a JWST-like backdrop). Each is a tiny
// procedural ellipse (bulge + disk) with a redshift-dependent colour — most are
// small and reddened, a few nearby ones are larger and bluer. Rendered at
// infinity (follows the camera) and kept faint so OLED black stays black.

import * as THREE from 'three';
import { Random } from '../../core/Random.js';

const _red = new THREE.Color(1.0, 0.42, 0.26);

const VERT = /* glsl */ `
attribute vec4 aShape;   // size(px), axis ratio, angle, bulge fraction
attribute vec3 aColor;
uniform float uPx; uniform float uFade;
varying vec3 vColor; varying vec3 vShape;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(1.0, aShape.x * uPx);
  vColor = aColor * uFade * min(1.0, aShape.x * uPx / 1.5);
  vShape = aShape.yzw;
}`;
const FRAG = /* glsl */ `
varying vec3 vColor; varying vec3 vShape;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float c = cos(vShape.y), s = sin(vShape.y);
  vec2 q = vec2(c * p.x + s * p.y, (-s * p.x + c * p.y) / max(vShape.x, 0.15));
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float disk = exp(-r2 * 4.0);
  float bulge = exp(-dot(p, p) * 22.0);
  gl_FragColor = vec4(vColor * (disk * (1.0 - vShape.z) + bulge * vShape.z * 2.5), 1.0);
}`;

export class DeepField {
  constructor(seed, count = 6000, radius = 1500) {
    const rng = new Random(seed);
    const pos = new Float32Array(count * 3), shape = new Float32Array(count * 4), col = new Float32Array(count * 3);
    const tmp = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const [x, y, z] = rng.unitVector();
      pos.set([x * radius, y * radius, z * radius], i * 3);
      // apparent size & brightness from a steep luminosity function
      const u = rng.float();
      const near = Math.pow(u, 7);               // a few nearby, big, bright ones
      const size = 1.0 + near * 7.0 + rng.float() * 0.8;
      const ratio = rng.range(0.25, 1.0);
      const bulge = rng.range(0.15, 0.7);
      shape.set([size, ratio, rng.range(0, Math.PI), bulge], i * 4);
      // colour: observed galaxy mix — pale yellow-white ellipticals, warm orange, a few blue
      // spirals; the faintest (most distant) are redshift-reddened
      const kind = rng.float();
      if (kind < 0.5) tmp.setRGB(1.0, 0.86, 0.66); else if (kind < 0.84) tmp.setRGB(1.0, 0.6, 0.34); else tmp.setRGB(0.62, 0.74, 1.0);
      const zr = 1 - near;
      tmp.lerp(_red, 0.55 * zr * rng.float());
      // steep luminosity function: nearly all sub-threshold on OLED, a rare few resolved
      const b = 0.004 + Math.pow(rng.float(), 9) * 0.35 + near * 1.4;
      col.set([tmp.r * b, tmp.g * b, tmp.b * b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aShape', new THREE.BufferAttribute(shape, 4));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uPx: { value: 1 }, uFade: { value: 1 } },
      depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = -10;
  }
  /** Keep at infinity; scale sprite sizes with the viewport height. */
  update(camera, heightPx, fade = 1) {
    this.points.position.copy(camera.position);
    this.material.uniforms.uPx.value = heightPx / 720;
    this.material.uniforms.uFade.value = fade;
  }
  dispose() { this.points.geometry.dispose(); this.material.dispose(); }
}
