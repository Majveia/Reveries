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
    // (artistic licence: a shallower ~25° tilt than the Sun's 60° so the band arcs diagonally through most
    // views along the ecliptic instead of hiding above / below them)
    const tilt = rng.range(0.36, 0.55), spin = rng.range(0, Math.PI * 2);
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
    const n = engine.quality.pick(6000, 11000, 18000, 24000);
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    const lut = []; for (let i = 0; i < 48; i++) lut.push(blackbodyColor(2600 * Math.pow(12, i / 47)));
    const v = new THREE.Vector3();
    // star counts grow ~10^(0.35 m) per magnitude: a few dozen beacons, a sea of faint dust
    const MMAX = 8.5, cdf = Math.pow(10, 0.35 * MMAX) - 1;
    for (let i = 0; i < n; i++) {
      const m = Math.log10(1 + rng.float() * cdf) / 0.35;
      // faint stars crowd the galactic plane far more than bright (nearby) ones
      const inBand = rng.chance(0.35 + 0.4 * Math.min(1, m / MMAX));
      if (inBand) {
        const l = rng.range(-Math.PI, Math.PI);
        const near = Math.exp(-l * l * 1.2);
        const b = rng.gaussian(0, 0.06 + 0.12 * near * bulge);
        v.copy(gc).multiplyScalar(Math.cos(l) * Math.cos(b)).addScaledVector(right, Math.sin(l) * Math.cos(b)).addScaledVector(this.normal, Math.sin(b));
      } else {
        const [x, y, z] = rng.unitVector(); v.set(x, y, z);
      }
      v.normalize().multiplyScalar(SKY_R);
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
      const t = Math.pow(rng.float(), 1.6); // cooler stars dominate
      const c = lut[Math.min(47, Math.floor((inBand ? t : t * 0.9) * 47))];
      // luminance over ~3.4 decades (10^-0.4m, gently compressed so the faint end stays visible on OLED)
      const lum = 3.0 * Math.pow(10, -0.4 * m * 0.82);
      const w = m < 2.5 ? 0.25 : 0.45; // bright stars keep a clear spectral tint
      col[i * 3] = (c[0] * (1 - w) + w) * lum; col[i * 3 + 1] = (c[1] * (1 - w) + w) * lum; col[i * 3 + 2] = (c[2] * (1 - w) + w) * lum;
      // the brightest few get a real core + soft halo sprite (size encodes the halo, energy stays in the core)
      size[i] = m < 1.6 ? 9.0 + (1.6 - m) * 4.0 : m < 3.2 ? 3.2 : 1.0 + 0.6 * Math.max(0, 4.5 - m) / 4.5;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: { uDpr: { value: 1 }, uTime: { value: 0 } },
      vertexShader: /* glsl */`
        attribute float aSize; uniform float uDpr; uniform float uTime;
        varying vec3 vCol; varying float vHalo;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float tw = 0.96 + 0.04 * sin(uTime * (1.3 + fract(position.x * 0.013) * 3.0) + position.y);
          vCol = color * tw;
          vHalo = aSize > 6.0 ? 1.0 : 0.0;
          gl_PointSize = max(1.0, aSize * 0.85) * uDpr;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vCol; varying float vHalo;
        void main(){
          vec2 c = gl_PointCoord * 2.0 - 1.0; float r2 = dot(c, c);
          // tight core; beacons add a faint airy halo + tiny cross so they read as stars, not discs
          float a = vHalo > 0.5 ? exp(-r2 * 70.0) * 1.6 + exp(-r2 * 9.0) * 0.07 + (exp(-abs(c.x) * 60.0) + exp(-abs(c.y) * 60.0)) * (1.0 - sqrt(r2)) * 0.05
                                : exp(-r2 * 2.2);
          if (a < 0.004 || r2 > 1.0) discard;
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
        uOct: { value: engine.quality.pick(4, 5, 6, 6) }, uK: { value: 1 },
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        ${NOISE_GLSL}
        uniform vec3 uN, uC, uR, uArm, uCore; uniform float uBulge, uDust, uSeed, uK; uniform int uOct;
        varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          float sb = dot(d, uN); float b = asin(clamp(sb, -1.0, 1.0));
          float l = atan(dot(d, uR), dot(d, uC));
          float near = exp(-l * l * 1.1);
          vec3 p = d * 3.0 + uSeed;
          float wob = fbm(vec3(l * 1.3, 0.0, uSeed), 3) * 0.05;
          float bb = b - wob;
          float width = 0.04 + 0.055 * near * uBulge;
          float band = exp(-bb * bb / (2.0 * width * width));
          float clouds = 0.75 + 0.45 * max(fbm(p * 2.2, uOct), -0.4);
          float fine = 0.82 + 0.36 * fbm(p * 9.0, 3);
          float bulge = exp(-(l * l) / 0.22 - (bb * bb) / (0.02 + 0.03 * uBulge)) * uBulge;
          // unresolved star clouds: grainy, clumpy starlight rather than a smooth gradient
          float grainS = 0.75 + 0.5 * smoothstep(-0.2, 0.7, fbm(p * 14.0 + 5.0, 3));
          // brightness carried by star density: sub-pixel speckle of unresolved stars, clumped into star clouds
          // (no per-pixel speckle: it read as TV static) — bright star clouds vs. thin voids at low frequency
          float sc = smoothstep(-0.25, 0.55, fbm(p * 4.2 + 9.0, 4));
          grainS *= 0.25 + 0.95 * sc * sc;
          float I = band * clouds * fine * grainS * (0.35 + 0.65 * near) + bulge * 0.9;
          // diffuse galactic light: a much wider, faint skirt around the band
          float skirt = exp(-bb * bb / (2.0 * 9.0 * width * width)) * (0.25 + 0.75 * near);
          // dust lanes: a dark rift along the mid-plane, broken into filaments
          float lane = exp(-pow((bb + 0.012 * fbm(p * 4.0, 3)) / (0.022 + 0.02 * near), 2.0));
          float fil = smoothstep(0.05, 0.25, fbm(p * 5.5 + 7.0, uOct));
          I *= 1.0 - uDust * 0.95 * lane * fil;
          I *= 1.0 - uDust * 0.45 * smoothstep(0.1, 0.6, fbm(p * 3.1 - 3.0, 4)) * band;
          vec3 core = mix(vec3(dot(uCore, vec3(0.3, 0.5, 0.2))), uCore, 0.35) * vec3(1.0, 0.95, 0.9);
          // unresolved old disc stars read cream/neutral, not saturated blue
          vec3 arm = mix(vec3(dot(uArm, vec3(0.3, 0.5, 0.2))), uArm, 0.3) * vec3(1.0, 0.97, 0.92);
          vec3 col = mix(arm, core, clamp(near * 0.7 + bulge * 0.5 + 0.15, 0.0, 1.0));
          // absorbing dust: lanes redden their edges (warm brown) rather than just dimming
          col *= mix(vec3(1.0), vec3(1.0, 0.72, 0.5), clamp(lane * fil * uDust * 0.7 + 0.15 * band * uDust * smoothstep(0.1, 0.6, fbm(p * 3.1 - 3.0, 4)), 0.0, 0.85));
          col += vec3(0.5, 0.08, 0.15) * 0.5 * smoothstep(0.62, 0.8, fbm(p * 7.0 + 2.0, 3)) * band * (1.0 - lane);
          vec3 c = (col * I * 0.22 + mix(arm, col, 0.5) * skirt * 0.008) * uK;
          c = max(c - 0.0022, 0.0); // keep the sky floor pure black (OLED)
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
