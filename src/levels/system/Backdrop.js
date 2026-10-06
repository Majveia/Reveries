// OLED-black sky of a star system: a physically coloured starfield concentrated
// toward the galactic plane, plus the luminous band of the host galaxy — its
// bulge glowing in the true direction of the galactic centre, threaded by dark
// dust lanes. Everything stays exactly black away from the band.

import * as THREE from 'three';
import { Random, seedFrom } from '../../core/Random.js';
import { NOISE_GLSL } from '../../core/glsl/noise.js';
import { blackbodyColor } from '../../universe/Astro.js';

const SKY_R = 2600;

export class Backdrop {
  constructor(engine, sys, galaxy) {
    this.group = new THREE.Group();
    const rng = new Random(seedFrom(sys.star.seed, 'sky'));
    // Galactic frame: plane normal tilted ~60° from the ecliptic (like the Sun's).
    const tilt = rng.range(0.85, 1.25), spin = rng.range(0, Math.PI * 2);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, spin, 0, 'YXZ'));
    this.normal = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    // Direction to the galactic centre: the star's position in the galaxy plane (xz).
    const [px, , pz] = sys.star.position;
    const gc = new THREE.Vector3(-px, 0, -pz);
    if (gc.lengthSq() < 1e-6) gc.set(1, 0, 0);
    gc.normalize().applyQuaternion(q);
    this.center = gc;
    const rKpc = Math.hypot(px, pz);
    const bulge = THREE.MathUtils.clamp(1.6 - rKpc / (galaxy?.radiusKpc || 16) * 1.4, 0.35, 1.6);
    const right = new THREE.Vector3().crossVectors(this.normal, gc).normalize();

    // ---- stars ---------------------------------------------------------------
    const n = engine.quality.pick(2600, 4200, 6000, 8000);
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    const lut = []; for (let i = 0; i < 48; i++) lut.push(blackbodyColor(2600 * Math.pow(12, i / 47)));
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const inBand = rng.chance(0.55);
      if (inBand) {
        const l = rng.range(-Math.PI, Math.PI);
        const near = Math.exp(-l * l * 1.2);
        const b = rng.gaussian(0, 0.07 + 0.12 * near * bulge);
        v.copy(gc).multiplyScalar(Math.cos(l) * Math.cos(b)).addScaledVector(right, Math.sin(l) * Math.cos(b)).addScaledVector(this.normal, Math.sin(b));
      } else {
        const [x, y, z] = rng.unitVector(); v.set(x, y, z);
      }
      v.normalize().multiplyScalar(SKY_R);
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
      const t = Math.pow(rng.float(), 1.6); // cooler stars dominate
      const c = lut[Math.min(47, Math.floor((inBand ? t : t * 0.9) * 47))];
      // magnitudes: a handful of bright stars, a sea of faint ones (dN/dm ∝ 10^0.6m-ish)
      const m = Math.pow(rng.float(), 14);
      const lum = 0.018 + 0.05 * rng.float() + 3.2 * m;
      const w = 0.45; // stellar colours are pale, not neon
      col[i * 3] = (c[0] * (1 - w) + w) * lum; col[i * 3 + 1] = (c[1] * (1 - w) + w) * lum; col[i * 3 + 2] = (c[2] * (1 - w) + w) * lum;
      size[i] = 1.0 + 1.8 * Math.sqrt(m);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: { uDpr: { value: 1 }, uTime: { value: 0 } },
      vertexShader: /* glsl */`
        attribute float aSize; uniform float uDpr; uniform float uTime;
        varying vec3 vCol;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float tw = 0.96 + 0.04 * sin(uTime * (1.3 + fract(position.x * 0.013) * 3.0) + position.y);
          vCol = color * tw;
          gl_PointSize = max(1.0, aSize * 0.85) * uDpr;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vCol;
        void main(){
          vec2 c = gl_PointCoord * 2.0 - 1.0; float r2 = dot(c, c);
          float a = exp(-r2 * 2.2);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vCol * a, 1.0);
        }`,
      vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });
    const pts = new THREE.Points(g, this.starMat);
    pts.frustumCulled = false; pts.renderOrder = -10;
    this.group.add(pts);

    // ---- galactic band -------------------------------------------------------------
    const ca = galaxy?.colorArms || [0.7, 0.78, 1.0], cc = galaxy?.colorCore || [1.0, 0.85, 0.6];
    this.bandMat = new THREE.ShaderMaterial({
      uniforms: {
        uN: { value: this.normal }, uC: { value: gc }, uR: { value: right },
        uArm: { value: new THREE.Color().setRGB(ca[0], ca[1], ca[2], THREE.SRGBColorSpace) },
        uCore: { value: new THREE.Color().setRGB(cc[0], cc[1], cc[2], THREE.SRGBColorSpace) },
        uBulge: { value: bulge }, uDust: { value: galaxy?.dust ?? 0.8 }, uSeed: { value: rng.range(0, 100) },
        uOct: { value: engine.quality.pick(4, 5, 6, 6) },
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        ${NOISE_GLSL}
        uniform vec3 uN, uC, uR, uArm, uCore; uniform float uBulge, uDust, uSeed; uniform int uOct;
        varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          float sb = dot(d, uN); float b = asin(clamp(sb, -1.0, 1.0));
          float l = atan(dot(d, uR), dot(d, uC));
          float near = exp(-l * l * 1.1);
          vec3 p = d * 3.0 + uSeed;
          float wob = fbm(vec3(l * 1.3, 0.0, uSeed), 3) * 0.05;
          float bb = b - wob;
          float width = 0.075 + 0.11 * near * uBulge;
          float band = exp(-bb * bb / (2.0 * width * width));
          float clouds = 0.55 + 0.9 * max(fbm(p * 2.2, uOct), -0.4);
          float fine = 0.7 + 0.6 * fbm(p * 9.0, 3);
          float bulge = exp(-(l * l) / 0.22 - (bb * bb) / (0.02 + 0.03 * uBulge)) * uBulge;
          float I = band * clouds * fine * (0.35 + 0.65 * near) + bulge * 0.9;
          // dust lanes: a dark rift along the mid-plane, broken into filaments
          float lane = exp(-pow((bb + 0.012 * fbm(p * 4.0, 3)) / (0.022 + 0.02 * near), 2.0));
          float fil = smoothstep(-0.15, 0.45, fbm(p * 5.5 + 7.0, uOct));
          I *= 1.0 - uDust * 0.88 * lane * fil;
          I *= 1.0 - uDust * 0.45 * smoothstep(0.1, 0.6, fbm(p * 3.1 - 3.0, 4)) * band;
          vec3 col = mix(uArm, uCore, clamp(near * 0.8 + bulge * 0.6, 0.0, 1.0));
          col += vec3(0.5, 0.08, 0.15) * smoothstep(0.62, 0.8, fbm(p * 7.0 + 2.0, 3)) * band * (1.0 - lane);
          vec3 c = col * I * 0.16;
          c = max(c - 0.0012, 0.0); // keep the sky floor pure black (OLED)
          gl_FragColor = vec4(c, 1.0);
        }`,
      side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending, transparent: true,
    });
    const band = new THREE.Mesh(new THREE.SphereGeometry(SKY_R * 1.02, 64, 32), this.bandMat);
    band.frustumCulled = false; band.renderOrder = -11;
    this.group.add(band);
  }

  update(dt, t, camera, dpr) {
    this.group.position.copy(camera.position); // sky at infinity
    this.starMat.uniforms.uTime.value = t;
    this.starMat.uniforms.uDpr.value = dpr;
  }

  dispose() {
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
  }
}
