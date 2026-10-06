// Planet bodies of the orrery: surface, atmosphere shell, rings, moons and the
// thin orbit line, all lit by the star at the origin.

import * as THREE from 'three';
import { Random, seedFrom } from '../../core/Random.js';
import { NOISE_GLSL } from '../../core/glsl/noise.js';
import { terrainParams } from '../planet/terrain/TerrainHeight.js';
import { RING_GLSL, COMMON_GLSL, PLANET_VERT, ROCKY_FRAG, GAS_FRAG, ATMO_FRAG, RING_VERT, RING_FRAG } from './PlanetShaders.js';

const srgb = (hex, fb = '#888888') => { const c = new THREE.Color(); c.set(hex || fb); return c; }; // → linear
const srgbArr = (hex, fb) => { const c = new THREE.Color(hex || fb); return [c.r, c.g, c.b].map((v) => v); };
const linFromArr = (a) => new THREE.Color().setRGB(a[0], a[1], a[2], THREE.SRGBColorSpace);

const CLOUDS = { terran: 0.55, ocean: 0.62, jungle: 0.68, desert: 0.06, ice: 0.32, lava: 0.18, toxic: 0.75, exotic: 0.4, barren: 0 };
const CLOUD_TINT = { lava: [0.22, 0.2, 0.2], toxic: [0.85, 0.9, 0.55], exotic: [0.95, 0.85, 1.0], desert: [0.95, 0.85, 0.7] };

/** Bake surfaces of all landable planets in parallel workers. Resolves to Map(index → {albedo, data}). */
export async function bakeSurfaces(planets, quality, onProgress) {
  const W = quality.pick(256, 384, 512, 768), H = W / 2;
  const jobs = planets.filter((p) => p.world);
  const out = new Map();
  if (!jobs.length) return out;
  const nW = Math.min(jobs.length, Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)));
  let next = 0, done = 0;
  await new Promise((resolve) => {
    const workers = [];
    const finish = () => { if (done >= jobs.length) { workers.forEach((w) => w.terminate()); resolve(); } };
    const feed = (w) => {
      if (next >= jobs.length) return;
      const p = jobs[next++];
      const P = p.palette || {};
      const pal = {
        g0: srgbArr(P.ground?.[0], '#7a7a6a'), g1: srgbArr(P.ground?.[1], '#6a6458'), g2: srgbArr(P.ground?.[2], '#5a564e'), g3: srgbArr(P.ground?.[3], '#8a8270'),
        f0: srgbArr(P.foliage?.[0], '#4a6a3a'), f1: srgbArr(P.foliage?.[1] || P.foliage?.[0], '#5a7a44'), f2: srgbArr(P.foliage?.[2] || P.foliage?.[0], '#3a5a30'),
        rock: srgbArr(P.rock, '#6e6a64'), sand: srgbArr(P.sand, '#cdbb92'), water: srgbArr(P.water, '#2a5a78'),
      };
      w._job = p.index;
      w.postMessage({ id: p.index, params: terrainParams(p), W, H, pal, kind: p.kind });
    };
    for (let i = 0; i < nW; i++) {
      let w;
      try { w = new Worker(new URL('./SurfaceBakeWorker.js', import.meta.url), { type: 'module' }); } catch (e) { console.warn('[system] bake worker unavailable', e); done = jobs.length; finish(); return; }
      w.onmessage = (e) => {
        const m = e.data;
        if (m.error) console.warn('[system] surface bake failed', m.error);
        else out.set(m.id, { albedo: m.albedo, data: m.data, W, H });
        done++; onProgress?.(done / jobs.length);
        feed(w); finish();
      };
      w.onerror = (e) => { console.warn('[system] bake worker error', e.message); done++; feed(w); finish(); };
      workers.push(w);
      feed(w);
    }
  });
  return out;
}

function dataTex(arr, W, H, colorSpace) {
  const t = new THREE.DataTexture(arr, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.anisotropy = 4;
  if (colorSpace) t.colorSpace = colorSpace;
  t.needsUpdate = true;
  return t;
}

export class SystemPlanet {
  constructor(engine, planet, layout, starColor, bake) {
    this.engine = engine; this.planet = planet; this.layout = layout;
    const q = engine.quality;
    const rng = new Random(seedFrom(planet.seed, 'orrery'));
    this.R = layout.planetR(planet);
    this.el = layout.planetEl(planet);
    this.position = new THREE.Vector3();
    this.root = new THREE.Group();
    this.tilt = new THREE.Group();
    this.tilt.rotation.set(THREE.MathUtils.degToRad(planet.axialTiltDeg) * (planet.kind === 'gas' ? 1 : 1), 0, 0, 'YXZ');
    this.tilt.rotation.y = rng.range(0, Math.PI * 2);
    this.root.add(this.tilt);
    const sun = starColor.clone().multiplyScalar(1.55 * Math.pow(THREE.MathUtils.clamp(planet.orbit.a / layout.sl, 0.3, 30), -0.18));
    this.sun = sun;
    const seed = rng.range(0, 100);
    const segs = q.pick(64, 96, 128, 160);
    const geo = new THREE.SphereGeometry(this.R, segs, segs >> 1);
    const ringed = !!planet.rings;
    this.ringIn = ringed ? planet.rings.inner * this.R : 0;
    this.ringOut = ringed ? planet.rings.outer * this.R : 0;
    const ringN = new THREE.Vector3(0, 1, 0);
    const ringUniforms = {
      uRingN: { value: ringN }, uRingIn: { value: this.ringIn }, uRingOut: { value: this.ringOut },
      uRingOp: { value: ringed ? planet.rings.opacity : 0 }, uRingSeed: { value: seed },
    };
    this.ringN = ringN;
    const atmoCol = (() => {
      const r = planet.atmosphere?.rayleigh || [0.3, 0.35, 0.5];
      const m = Math.max(...r);
      return new THREE.Color(r[0] / m, r[1] / m, r[2] / m);
    })();
    const atmoDensity = planet.atmosphere?.present ? THREE.MathUtils.clamp(planet.atmosphere.density ?? 1, 0.15, 1.4) : 0;
    this.atmoCol = atmoCol;

    let mat;
    if (planet.kind === 'gas') {
      const gb = planet.gasBands;
      const storms = [];
      const srng = rng.fork('storms');
      for (let i = 0; i < 3; i++) storms.push(new THREE.Vector4(srng.range(-0.55, 0.55), srng.range(0, 6.28), i === 0 ? srng.range(0.1, 0.16) : srng.range(0.03, 0.06), srng.sign() * srng.range(0.6, 1)));
      mat = new THREE.ShaderMaterial({
        uniforms: {
          uSun: { value: sun }, uCenter: { value: this.position }, uTime: { value: 0 }, uSeed: { value: seed }, uTurb: { value: gb.turbulence },
          uC0: { value: linFromArr(gb.colors[0]) }, uC1: { value: linFromArr(gb.colors[1]) }, uC2: { value: linFromArr(gb.colors[2]) },
          uAtmo: { value: atmoCol }, uOct: { value: q.pick(3, 4, 5, 5) },
          uStorm: { value: storms }, uStorms: { value: Math.max(1, gb.storms) },
          ...ringUniforms,
        },
        defines: ringed ? { HAS_RINGS: '' } : {},
        vertexShader: PLANET_VERT,
        fragmentShader: NOISE_GLSL + RING_GLSL + COMMON_GLSL + GAS_FRAG,
      });
    } else {
      const P = planet.palette || {};
      const defines = { [`KIND_${planet.kind.toUpperCase()}`]: '' };
      const b = bake?.get(planet.index);
      if (b) defines.HAS_MAP = '';
      const hasOcean = (planet.world?.seaLevel ?? 0) > 0.02 && planet.kind !== 'desert';
      if (hasOcean) defines.HAS_OCEAN = '';
      if (ringed) defines.HAS_RINGS = '';
      this.albedoTex = b ? dataTex(b.albedo, b.W, b.H, THREE.SRGBColorSpace) : null;
      this.dataTex = b ? dataTex(b.data, b.W, b.H) : null;
      const water = srgb(P.water, '#24506e');
      const ct = CLOUD_TINT[planet.kind] || [1, 1, 1];
      mat = new THREE.ShaderMaterial({
        uniforms: {
          uAlbedo: { value: this.albedoTex }, uData: { value: this.dataTex },
          uSun: { value: sun }, uCenter: { value: this.position }, uRadius: { value: this.R }, uTime: { value: 0 }, uSeed: { value: seed },
          uWater: { value: water.clone().multiplyScalar(0.55) }, uShallow: { value: water.clone().lerp(new THREE.Color(0.1, 0.35, 0.4), 0.4).multiplyScalar(0.9) },
          uAtmo: { value: atmoCol }, uLights: { value: srgb(P.lights, '#ffc27a') }, uCloudCol: { value: new THREE.Color(ct[0], ct[1], ct[2]) },
          uLava: { value: srgb(P.accent && planet.kind === 'lava' ? P.accent : '#ff5a1a') },
          uG0: { value: srgb(P.ground?.[0], '#8a8070') }, uG1: { value: srgb(P.ground?.[1], '#706a60') }, uG2: { value: srgb(P.ground?.[2], '#5a554e') }, uRock: { value: srgb(P.rock, '#6a6660') },
          uCloudCover: { value: CLOUDS[planet.kind] ?? 0.3 }, uCiv: { value: planet.civ.level }, uAtmoDensity: { value: atmoDensity },
          uRelief: { value: this.R * 0.012 }, uOct: { value: q.pick(3, 4, 5, 6) },
          uSpin: { value: new THREE.Matrix3() },
          ...ringUniforms,
        },
        defines,
        vertexShader: PLANET_VERT,
        fragmentShader: NOISE_GLSL + RING_GLSL + COMMON_GLSL + ROCKY_FRAG,
      });
    }
    this.mat = mat;
    this.body = new THREE.Mesh(geo, mat);
    this.body.userData.sysPlanet = this;
    this.tilt.add(this.body);
    this.spinRate = (Math.PI * 2) / Math.max(20, planet.dayLengthHours * 3.5) * (rng.chance(0.15) ? -1 : 1);
    this.spin0 = rng.range(0, Math.PI * 2);

    // ---- atmosphere shell -----------------------------------------------------------
    if (atmoDensity > 0.05) {
      const Ra = this.R * (planet.kind === 'gas' ? 1.035 : 1.055);
      this.atmoMat = new THREE.ShaderMaterial({
        uniforms: { uSun: { value: sun }, uCenter: { value: this.position }, uR: { value: this.R }, uRa: { value: Ra }, uAtmo: { value: atmoCol }, uDensity: { value: atmoDensity * (planet.kind === 'gas' ? 0.6 : 1) } },
        vertexShader: /* glsl */`varying vec3 vWP; void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vWP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
        fragmentShader: ATMO_FRAG,
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.FrontSide,
      });
      this.atmo = new THREE.Mesh(new THREE.SphereGeometry(Ra, q.pick(48, 64, 96, 96), q.pick(24, 32, 48, 48)), this.atmoMat);
      this.atmo.renderOrder = 3;
      this.root.add(this.atmo);
    }

    // ---- rings ----------------------------------------------------------------------
    if (ringed) {
      const rc = planet.rings.color;
      this.ringMat = new THREE.ShaderMaterial({
        uniforms: {
          uSun: { value: sun }, uCenter: { value: this.position }, uPR: { value: this.R },
          uIn: { value: this.ringIn }, uOut: { value: this.ringOut }, uOp: { value: Math.min(1, planet.rings.opacity * 1.25) }, uSeed: { value: seed },
          uCol: { value: linFromArr(rc) }, uN: { value: ringN },
        },
        vertexShader: RING_VERT,
        fragmentShader: RING_GLSL + RING_FRAG,
        transparent: true, depthWrite: false, side: THREE.DoubleSide, premultipliedAlpha: true,
      });
      const rg = new THREE.RingGeometry(this.ringIn, this.ringOut, q.pick(128, 192, 256, 256), 3);
      this.rings = new THREE.Mesh(rg, this.ringMat);
      this.rings.rotation.x = -Math.PI / 2; // into the equatorial (xz) plane of the tilt frame
      this.rings.renderOrder = 4;
      this.tilt.add(this.rings);
    }

    // ---- moons ----------------------------------------------------------------------
    this.moons = [];
    for (const m of planet.moons) {
      const mr = Math.max(0.03, m.radiusRel * this.R * (planet.kind === 'gas' ? 1.6 : 1.0));
      const dist = (ringed ? this.ringOut * 1.18 : this.R * 1.7) + this.R * 0.55 * Math.max(0, Math.sqrt(m.distance) - 1.45) * (planet.kind === 'gas' ? 1.2 : 2.2);
      const mc = linFromArr(m.color);
      const mm = new THREE.ShaderMaterial({
        uniforms: {
          uAlbedo: { value: null }, uData: { value: null },
          uSun: { value: sun }, uCenter: { value: this.position }, uRadius: { value: mr }, uTime: { value: 0 }, uSeed: { value: rng.range(0, 100) },
          uWater: { value: mc }, uShallow: { value: mc }, uAtmo: { value: mc }, uLights: { value: mc }, uCloudCol: { value: mc }, uLava: { value: new THREE.Color(1, 0.3, 0.05) },
          uG0: { value: mc.clone() }, uG1: { value: mc.clone().multiplyScalar(0.7) }, uG2: { value: mc.clone().multiplyScalar(0.85) },
          uRock: { value: mc.clone().multiplyScalar(m.kind === 'ice' ? 1.1 : 0.55) },
          uCloudCover: { value: 0 }, uCiv: { value: 0 }, uAtmoDensity: { value: 0 }, uRelief: { value: mr * 0.05 }, uOct: { value: 3 },
          uSpin: { value: new THREE.Matrix3() }, ...ringUniforms,
        },
        defines: { MOON: '', ...(m.kind === 'lava' ? { KIND_LAVA: '' } : {}) },
        vertexShader: PLANET_VERT,
        fragmentShader: NOISE_GLSL + RING_GLSL + COMMON_GLSL + ROCKY_FRAG,
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(mr, 32, 16), mm);
      this.root.add(mesh);
      this.moons.push({ data: m, mesh, mat: mm, dist, r: mr, speed: (Math.PI * 2) / (18 * Math.pow(dist / this.R, 1.5)), incl: m.incl });
    }

    // ---- orbit line -----------------------------------------------------------------
    const N = 384;
    const pts = new Float32Array(N * 3), ph = new Float32Array(N);
    const v = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      const days = (i / N) * this.el.period;
      layout.position(this.el, days, v);
      pts[i * 3] = v.x; pts[i * 3 + 1] = v.y; pts[i * 3 + 2] = v.z;
      ph[i] = i / N;
    }
    const og = new THREE.BufferGeometry();
    og.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    og.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    this.orbitMat = new THREE.ShaderMaterial({
      uniforms: { uPhase: { value: 0 }, uCol: { value: atmoDensity > 0.05 ? atmoCol.clone().lerp(new THREE.Color(1, 1, 1), 0.55) : new THREE.Color(0.8, 0.82, 0.9) }, uA: { value: 0.035 }, uHi: { value: 0 }, uDim: { value: 1 } },
      vertexShader: /* glsl */`attribute float aPhase; varying float vP; varying float vD; varying float vE;
        void main(){ vP = aPhase; vec4 mv = modelViewMatrix * vec4(position, 1.0); vD = -mv.z;
          vE = abs(normalize(cameraPosition - (modelMatrix * vec4(position, 1.0)).xyz).y);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */`
        uniform float uPhase, uA, uHi, uDim; uniform vec3 uCol; varying float vP; varying float vD; varying float vE;
        void main(){
          float behind = fract(uPhase - vP);           // 0 at the planet, growing behind it
          float trail = exp(-behind * 5.0) * smoothstep(0.0, 0.004, behind);
          float a = (uA * (1.0 + uHi * 1.5) + trail * 0.22) * uDim * smoothstep(0.3, 6.0, vD) * (0.25 + 0.75 * smoothstep(0.03, 0.3, vE));
          gl_FragColor = vec4(uCol * a, 1.0);
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });
    this.orbit = new THREE.LineLoop(og, this.orbitMat);
    this.orbit.frustumCulled = false;
    this.orbit.renderOrder = 1;
  }

  update(days, t, spinT) {
    this.engine && this.layout.position(this.el, days, this.position);
    this.root.position.copy(this.position);
    this.root.updateMatrixWorld(true);
    // ring plane normal in world space
    this.ringN.set(0, 1, 0).applyQuaternion(this.tilt.getWorldQuaternion(_q));
    const spin = this.spin0 + spinT * this.spinRate;
    this.body.rotation.y = spin;
    this.mat.uniforms.uTime.value = t;
    if (this.mat.uniforms.uSpin) {
      this.body.updateMatrixWorld(true);
      this.mat.uniforms.uSpin.value.setFromMatrix4(this.body.matrixWorld);
      // remove scale: matrixWorld has unit scale here
    }
    this.orbitMat.uniforms.uPhase.value = ((days / this.el.period) % 1 + 1) % 1;
    for (const m of this.moons) {
      const a = m.data.phase + spinT * m.speed;
      _v.set(Math.cos(a) * m.dist, Math.sin(a) * m.dist * Math.sin(m.incl), Math.sin(a) * m.dist * Math.cos(m.incl));
      _v.applyQuaternion(this.tilt.quaternion);
      m.mesh.position.copy(_v);
      m.mesh.rotation.y = a * 0.97;
      m.mat.uniforms.uTime.value = t;
    }
  }

  dispose() {
    this.root.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    this.orbit.geometry.dispose(); this.orbitMat.dispose();
    this.albedoTex?.dispose(); this.dataTex?.dispose();
  }
}
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
