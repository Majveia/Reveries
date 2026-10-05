// Deep-sky backdrop of the galaxy level: faint foreground halo stars and distant
// background galaxies (tiny tilted spirals and ellipticals) on a camera-centred
// sphere. Lives in the main scene so the galaxy volume attenuates it (dust lanes
// silhouette the background universe, the disk occludes it).

import * as THREE from 'three';
import { Random, seedFrom } from '../../core/Random.js';
import { bbColor } from './Stars.js';

const VERT = /* glsl */ `
attribute vec4 aCol;      // rgb, brightness
attribute vec4 aShape;    // size px, axis ratio, angle, kind (0 star, 1 spiral, 2 elliptical)
uniform float uDist, uPxScale;
varying vec3 vCol; varying vec4 vShape;
void main(){
  vec3 p = cameraPosition + normalize(position) * uDist;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  float px = aShape.x * uPxScale;
  gl_PointSize = px;
  vShape = aShape;
  vCol = aCol.rgb * aCol.a / max(1.0, 0.25 * px * px);
}`;
const FRAG = /* glsl */ `
varying vec3 vCol; varying vec4 vShape;
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float k = vShape.w;
  if (k < 0.5) { float r2 = dot(c, c); if (r2 > 1.0) discard; gl_FragColor = vec4(vCol * exp(-r2 * 6.0) * 2.0, 1.0); return; }
  float a = vShape.z, cs = cos(a), sn = sin(a);
  vec2 e = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y);
  e.y /= max(vShape.y, 0.15);
  float r = length(e);
  if (r > 1.0) discard;
  float f;
  if (k < 1.5) {
    float th = atan(e.y, e.x);
    float arm = 0.5 + 0.5 * cos(2.0 * th - log(max(r, 0.02)) * 5.0);
    f = exp(-r * 9.0) * 1.6 + exp(-r * 3.5) * arm * 0.6;
    vec3 col = mix(vec3(1.0, 0.8, 0.55), vec3(0.55, 0.7, 1.0), smoothstep(0.05, 0.5, r));
    gl_FragColor = vec4(vCol * col * f * (1.0 - r) * 4.0, 1.0);
  } else {
    f = exp(-r * 5.0);
    gl_FragColor = vec4(vCol * vec3(1.0, 0.82, 0.62) * f * (1.0 - r) * 4.0, 1.0);
  }
}`;

export class DeepSky {
  constructor(engine, g) {
    const q = engine.quality;
    const rng = new Random(seedFrom(g.seed, 'deepsky'));
    const nStars = q.pick(2500, 4000, 6000, 8000), nGal = q.pick(120, 200, 320, 400);
    const n = nStars + nGal;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), shp = new Float32Array(n * 4);
    const tmp = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const [x, y, z] = rng.unitVector();
      pos.set([x, y, z], i * 3);
      if (i < nStars) {
        bbColor(rng.range(3200, 11000), tmp);
        const b = 0.02 * Math.pow(rng.float(), 5) + 0.0025;
        col.set([tmp[0], tmp[1], tmp[2], b], i * 4);
        shp.set([2.2, 1, 0, 0], i * 4);
      } else {
        const ell = rng.chance(0.35);
        col.set([1, 1, 1, rng.range(0.004, 0.02)], i * 4);
        shp.set([rng.range(3, 9) * (rng.chance(0.06) ? 2.2 : 1), rng.range(0.2, 1), rng.range(0, Math.PI), ell ? 2 : 1], i * 4);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aCol', new THREE.BufferAttribute(col, 4));
    geo.setAttribute('aShape', new THREE.BufferAttribute(shp, 4));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: { uDist: { value: 1 }, uPxScale: { value: 1 } },
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = -10;
  }
  update(camera, height) {
    this.mat.uniforms.uDist.value = camera.far * 0.5;
    this.mat.uniforms.uPxScale.value = Math.max(1, height / 720);
  }
  dispose() { this.points.geometry.dispose(); this.mat.dispose(); }
}
