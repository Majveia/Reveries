// The star: a living photosphere (granulation, supergranulation, sunspots with
// umbra/penumbra, faculae, limb darkening) coloured by its blackbody
// temperature and rendered in HDR so it blooms; a chromosphere rim and a
// streamer corona; prominences and coronal-loop arcades rising over the limb;
// a subtle lens glare that dims when a planet eclipses the disk. Giants churn
// with huge convection cells, white dwarfs burn smooth and blue, neutron stars
// sweep twin pulsar beams across the system.

import * as THREE from 'three';
import { Random, seedFrom } from '../../core/Random.js';
import { NOISE_GLSL } from '../../core/glsl/noise.js';

const BILLBOARD_VERT = /* glsl */`
  uniform float uSize;
  varying vec2 vUv;
  void main(){
    vUv = position.xy;
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * uSize;
    gl_Position = projectionMatrix * mv;
  }`;

export class Star {
  constructor(engine, star, radius) {
    this.engine = engine; this.star = star; this.radius = radius;
    this.group = new THREE.Group();
    const q = engine.quality;
    const rng = new Random(seedFrom(star.seed, 'starvis'));
    const kind = star.kind;
    const col = new THREE.Color().setRGB(star.color[0], star.color[1], star.color[2]); // already linear
    this.color = col;
    const hot = THREE.MathUtils.clamp((star.temp - 3000) / 9000, 0, 1);
    // Surface radiance (HDR): bright enough to bloom; scaled down for huge giants so they read as cooler.
    const intensity = kind === 'neutron' ? 60 : kind === 'whiteDwarf' ? 40 : kind === 'giant' ? 14 : 26;
    const cell = kind === 'giant' ? 9.0 : kind === 'whiteDwarf' ? 70.0 : 88.0;
    const spots = kind === 'main' ? THREE.MathUtils.clamp(1.2 - hot * 1.1, 0.15, 1.0) : kind === 'giant' ? 0.5 : 0.0;

    // ---- photosphere ---------------------------------------------------------------
    this.baseI = intensity;
    this.baseCorona = kind === 'neutron' ? 3.0 : 1.0;
    this.surfMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uColor: { value: col }, uI: { value: intensity }, uCell: { value: cell },
        uSpots: { value: spots }, uSeed: { value: rng.range(0, 50) }, uHot: { value: hot }, uFilter: { value: 0 },
        uOct: { value: q.pick(3, 4, 5, 5) },
      },
      vertexShader: /* glsl */`
        varying vec3 vObj; varying vec3 vN; varying vec3 vWP;
        void main(){
          vObj = position; vN = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0); vWP = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        ${NOISE_GLSL}
        uniform float uTime, uI, uCell, uSpots, uSeed, uHot, uFilter; uniform vec3 uColor; uniform int uOct;
        varying vec3 vObj; varying vec3 vN; varying vec3 vWP;
        vec3 rotY(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z); }
        void main(){
          vec3 p = normalize(vObj);
          float lat = p.y;
          // differential rotation: the equator laps the poles
          vec3 q = rotY(p, uTime * (0.006 + 0.004 * (1.0 - lat * lat)));
          vec3 qs = q + uSeed;
          // granulation: bright convective cells, dark intergranular lanes, slowly boiling
          vec3 wq = qs * uCell + 0.35 * vec3(snoise(qs * 9.0 + uTime * 0.03), snoise(qs * 9.0 + 17.0 - uTime * 0.03), 0.0);
          vec2 w1 = worley(wq + vec3(0.0, 0.0, uTime * 0.04));
          float gran = smoothstep(0.0, 0.22, w1.y - w1.x) * (0.55 + 0.45 * (1.0 - w1.x * w1.x));
          vec2 w2 = worley(wq * 2.6 + vec3(uTime * 0.05));
          gran = gran * 0.75 + 0.25 * smoothstep(0.0, 0.3, w2.y - w2.x);
          // supergranulation network
          vec2 sg = worley(qs * uCell * 0.17);
          float net = 1.0 - smoothstep(0.0, 0.12, sg.y - sg.x);
          float turb = fbm(qs * 5.0 + vec3(uTime * 0.01), uOct);
          // active regions: sunspots in the royal latitudes
          float belt = smoothstep(0.03, 0.12, abs(lat)) * (1.0 - smoothstep(0.42, 0.62, abs(lat)));
          float act = fbm(qs * 2.4 + 31.0, 4) * belt;
          float spotN = fbm(qs * 13.0 - 5.0, 3);
          float sp = smoothstep(0.36, 0.45, act + spotN * 0.12) * uSpots;
          float umbra = smoothstep(0.46, 0.52, act + spotN * 0.10) * uSpots;
          // penumbral filaments radiate from the umbra
          float fil = 0.75 + 0.25 * sin(dot(q, vec3(173.0, 211.0, 197.0)) + spotN * 18.0);
          float faculae = smoothstep(0.15, 0.33, act) * (1.0 - sp);
          float I = (0.78 + 0.3 * gran) * (1.0 + 0.12 * turb) * (1.0 + 0.08 * net);
          I *= mix(1.0, 0.42 * fil, sp);
          I *= mix(1.0, 0.09, umbra);
          // limb darkening (wavelength dependent: the limb is redder and dimmer)
          vec3 V = normalize(cameraPosition - vWP);
          float mu = clamp(dot(normalize(vN), V), 0.0, 1.0);
          vec3 limb = pow(vec3(max(mu, 0.02)), vec3(0.55, 0.8, 1.15) * mix(0.9, 0.5, uHot) * (1.0 + 0.4 * uFilter));
          limb *= 0.35 + 0.65 * smoothstep(0.0, 0.25, mu);
          I *= 1.0 + faculae * (1.0 - mu) * 1.4;
          vec3 c = uColor * mix(vec3(1.0, 0.82, 0.62), vec3(1.0), 0.4 + 0.6 * gran) * I * limb * uI;
          c *= mix(vec3(1.0), vec3(1.0, 0.55, 0.3), umbra * 0.6);
          // close-up "solar filter": warmer, more saturated photosphere
          c *= mix(vec3(1.0), vec3(1.0, 0.6, 0.26) * 1.25, uFilter);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const segs = q.pick(64, 96, 128, 160);
    this.surface = new THREE.Mesh(new THREE.SphereGeometry(radius, segs, segs >> 1), this.surfMat);
    this.group.add(this.surface);

    // ---- chromosphere + corona (camera-facing) -------------------------------------
    const coronaScale = kind === 'giant' ? 3.2 : kind === 'neutron' ? 40 : kind === 'whiteDwarf' ? 9 : 6.5;
    const FACING_VERT = /* glsl */`
      uniform float uSize;
      varying vec2 vUv;
      void main(){
        vUv = position.xy;
        vec3 c = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 f = normalize(cameraPosition - c);
        vec3 up = abs(f.y) > 0.98 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
        vec3 r = normalize(cross(up, f));
        vec3 u = cross(f, r);
        vec3 wp = c + (r * position.x + u * position.y) * uSize;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`;
    this.coronaMat = new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: radius * coronaScale }, uTime: { value: 0 }, uColor: { value: col },
        uDisk: { value: 1 / coronaScale }, uSeed: { value: rng.range(0, 50) },
        uHalpha: { value: new THREE.Color().setRGB(1.0, 0.18 + 0.4 * hot, 0.16 + 0.6 * hot) },
        uI: { value: kind === 'neutron' ? 3.0 : 1.0 },
      },
      vertexShader: FACING_VERT,
      fragmentShader: /* glsl */`
        ${NOISE_GLSL}
        uniform float uTime, uDisk, uSeed, uI; uniform vec3 uColor, uHalpha;
        varying vec2 vUv;
        void main(){
          float r = length(vUv) / uDisk; // in disk radii
          if (r < 0.985 || length(vUv) > 1.0) discard;
          float a = atan(vUv.y, vUv.x);
          float x = r - 1.0;
          // streamers: long radial rays, brighter near the equator
          float st = fbm(vec2(a * 2.6 + uSeed, log(r) * 0.6 - uTime * 0.006), 4);
          float rays = 0.45 + 0.9 * pow(max(0.0, 0.5 + 0.5 * snoise(vec2(a * 7.0 + uSeed, log(r) * 1.4 - uTime * 0.01))), 2.5);
          float eq = 0.6 + 0.4 * pow(abs(cos(a)), 2.0);
          float inner = exp(-x * 9.0) * 1.4;
          float outer = exp(-x * 1.25) * 0.22 * rays * eq * (0.7 + 0.6 * st);
          float halo = 0.05 / (1.0 + x * x * 6.0);
          float chromo = exp(-pow((r - 1.004) / 0.011, 2.0)) * (0.8 + 0.4 * st);
          float spicules = smoothstep(0.2, 0.9, snoise(vec2(a * 160.0, uTime * 0.05))) * exp(-x * 60.0) * 0.6;
          vec3 c = uColor * (inner + outer + halo) * uI + uHalpha * (chromo * 2.6 + spicules);
          c *= smoothstep(1.0, 0.55, length(vUv));
          gl_FragColor = vec4(c, 1.0);
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });
    this.corona = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.coronaMat);
    this.corona.frustumCulled = false; this.corona.renderOrder = 2;
    this.group.add(this.corona);

    // ---- prominences & coronal loops ---------------------------------------------------
    this.loops = new THREE.Group();
    if (kind === 'main' || kind === 'giant') this._buildLoops(rng, col, hot);
    this.group.add(this.loops);

    // ---- pulsar beams ------------------------------------------------------------------
    if (kind === 'neutron') {
      this.pulsar = new THREE.Group();
      this.pulsar.rotation.z = 0.35;
      const beamMat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(0.55, 0.7, 1.0) }, uTime: { value: 0 } },
        vertexShader: /* glsl */`
          varying float vS; varying vec3 vN; varying vec3 vWP;
          void main(){ vS = uv.y; vN = normalize(mat3(modelMatrix) * normal); vec4 wp = modelMatrix * vec4(position, 1.0); vWP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
        fragmentShader: /* glsl */`
          uniform vec3 uColor; uniform float uTime; varying float vS; varying vec3 vN; varying vec3 vWP;
          void main(){
            vec3 V = normalize(cameraPosition - vWP);
            float f = pow(abs(dot(normalize(vN), V)), 1.5);
            float along = pow(1.0 - vS, 0.0) * exp(-(1.0 - vS) * 2.2) * smoothstep(0.0, 0.08, 1.0 - vS);
            gl_FragColor = vec4(uColor * f * along * 2.2, 1.0);
          }`,
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide,
      });
      const L = 160, R = 9;
      for (const s of [1, -1]) {
        const g = new THREE.ConeGeometry(R, L, 48, 1, true);
        g.translate(0, -L / 2, 0); // apex at origin
        const m = new THREE.Mesh(g, beamMat);
        m.rotation.x = s > 0 ? Math.PI : 0;
        m.frustumCulled = false;
        this.pulsar.add(m);
      }
      this.pulsarSpin = new THREE.Group(); this.pulsarSpin.add(this.pulsar);
      this.group.add(this.pulsarSpin);
      this.beamMat = beamMat;
    }

    // ---- lens glare: fixed angular size, drawn over everything ------------------------
    this.glareMat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 1 }, uColor: { value: col }, uVis: { value: 1 }, uI: { value: kind === 'giant' ? 0.6 : 1.0 } },
      vertexShader: BILLBOARD_VERT,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uVis, uI; varying vec2 vUv;
        void main(){
          float r = length(vUv); if (r > 1.0) discard;
          float a = atan(vUv.y, vUv.x);
          float spikes = 0.0;
          for (int i = 0; i < 3; i++) {
            float ang = a + float(i) * 1.0471976 + 0.26;
            float s = abs(sin(ang));
            spikes += exp(-s * r * 900.0) * pow(1.0 - r, 6.0);
          }
          float fine = abs(sin(a * 37.0)) * abs(sin(a * 23.0 + 1.3));
          float core = 0.10 / (1.0 + pow(r * 26.0, 2.0)) + 0.012 / (1.0 + r * r * 220.0);
          float rays = fine * exp(-r * 9.0) * 0.06;
          float ring = exp(-pow((r - 0.55) / 0.018, 2.0)) * 0.006;
          vec3 c = uColor * (core + spikes * 0.12 + rays) + vec3(0.6, 0.8, 1.0) * ring;
          gl_FragColor = vec4(c * uVis * uI * smoothstep(1.0, 0.8, r), 1.0);
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
    });
    this.glare = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.glareMat);
    this.glare.frustumCulled = false; this.glare.renderOrder = 50;
    this.group.add(this.glare);
  }

  _buildLoops(rng, col, hot) {
    const R = this.radius;
    const hAlpha = new THREE.Color().setRGB(1.0, 0.22 + 0.45 * hot, 0.2 + 0.6 * hot);
    const mkMat = (color, I, flow) => new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color }, uI: { value: I }, uK: { value: 1 }, uTime: { value: 0 }, uFlow: { value: flow }, uSeed: { value: rng.range(0, 40) } },
      vertexShader: /* glsl */`
        varying vec2 vUv; varying vec3 vN; varying vec3 vWP;
        void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 wp = modelMatrix * vec4(position, 1.0); vWP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: /* glsl */`
        ${NOISE_GLSL}
        uniform vec3 uColor; uniform float uI, uK, uTime, uFlow, uSeed;
        varying vec2 vUv; varying vec3 vN; varying vec3 vWP;
        void main(){
          vec3 V = normalize(cameraPosition - vWP);
          float f = abs(dot(normalize(vN), V));
          float core = pow(f, 1.6);
          float n = fbm(vec2(vUv.x * 14.0 - uTime * uFlow + uSeed, vUv.y * 6.0 + uSeed), 4);
          float n2 = fbm(vec2(vUv.x * 60.0 - uTime * uFlow * 2.0, vUv.y * 2.0 + uSeed * 3.0), 3);
          float strand = smoothstep(-0.2, 0.6, n) * (0.5 + 0.9 * smoothstep(-0.1, 0.5, n2)) * 1.4;
          float ends = smoothstep(0.0, 0.07, vUv.x) * smoothstep(1.0, 0.93, vUv.x);
          gl_FragColor = vec4(uColor * uI * uK * core * strand * (0.35 + 0.65 * ends), 1.0);
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide,
    });
    const arch = (center, tangent, span, height, thick, mat, twist = 0) => {
      const up = center.clone().normalize();
      const pts = [];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24, ang = (t - 0.5) * Math.PI;
        const along = Math.sin(ang) * span * 0.5;
        const h = Math.cos(ang) * height;
        const side = up.clone().cross(tangent).normalize().multiplyScalar(Math.sin(t * Math.PI) * twist);
        pts.push(up.clone().multiplyScalar(R * 0.995 + h).addScaledVector(tangent, along).add(side));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const g = new THREE.TubeGeometry(curve, 48, thick, 8, false);
      const m = new THREE.Mesh(g, mat); m.frustumCulled = false;
      this.loops.add(m);
    };
    const randDir = (latMax) => {
      const lat = rng.range(-latMax, latMax), lon = rng.range(0, Math.PI * 2);
      return new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
    };
    const tangentOf = (dir) => new THREE.Vector3(rng.range(-1, 1), rng.range(-0.3, 0.3), rng.range(-1, 1)).cross(dir).normalize();
    // Quiescent prominences: tall, wispy, H-alpha red. One is placed on the shot limb (+x side).
    const nProm = 5;
    for (let k = 0; k < nProm; k++) {
      const dir = k === 0 ? new THREE.Vector3(0.05, 0.22, -1).normalize() : randDir(0.9);
      const tan = k === 0 ? new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y).normalize() : tangentOf(dir);
      const mat = mkMat(hAlpha, 1.6, 0.25);
      const span = R * rng.range(0.16, 0.3) * (k === 0 ? 1.2 : 1), height = R * rng.range(0.12, 0.26) * (k === 0 ? 1.25 : 1);
      const side = new THREE.Vector3().crossVectors(dir, tan).normalize();
      for (let s = 0; s < 9; s++) {
        const off = side.clone().multiplyScalar(R * rng.range(-0.025, 0.025));
        arch(dir.clone().multiplyScalar(R).add(off), tan, span * rng.range(0.75, 1.15), height * rng.range(0.6, 1.1), R * rng.range(0.006, 0.016), mat, R * rng.range(-0.03, 0.03));
      }
    }
    // Active-region arcades: nested hot loops.
    const hotCol = col.clone().multiply(new THREE.Color(1.0, 0.72, 0.42));
    for (let k = 0; k < 3; k++) {
      const dir = k === 0 ? new THREE.Vector3(-0.15, 0.3, -1).normalize() : randDir(0.5);
      const tan = tangentOf(dir);
      const mat = mkMat(hotCol, 1.1, 0.6);
      const base = R * rng.range(0.05, 0.1);
      for (let s = 0; s < 7; s++) {
        const off = new THREE.Vector3().crossVectors(dir, tan).normalize().multiplyScalar((s - 3) * R * 0.012);
        arch(dir.clone().multiplyScalar(R).add(off), tan, base * (1 + s * 0.05), base * 0.55 * (1 + s * 0.04), R * 0.0025, mat);
      }
    }
  }

  /** occlusion: 0..1 visible fraction of the disk (planets in front). */
  update(dt, t, camera, visible = 1) {
    this.surfMat.uniforms.uTime.value = t;
    this.coronaMat.uniforms.uTime.value = t;
    const d = camera.position.length();
    const R = this.radius;
    // the silhouette of a sphere seen from distance d is larger than its radius
    const sil = R * d / Math.sqrt(Math.max(d * d - R * R, 1e-6));
    this.coronaMat.uniforms.uDisk.value = Math.min(0.99, sil / this.coronaMat.uniforms.uSize.value);
    for (const m of this.loops.children) m.material.uniforms.uTime.value = t;
    // glare subtends a fixed angle on screen
    this.glareMat.uniforms.uSize.value = d * 0.55;
    this.glareMat.uniforms.uVis.value = visible * THREE.MathUtils.smoothstep(d / R, 2.5, 8.0);
    // photographic exposure: close to the star the photosphere is dimmed so its texture survives
    const k = THREE.MathUtils.clamp(Math.pow((d / R) / 10, 1.2), 0.2, 1);
    this.surfMat.uniforms.uI.value = this.baseI * k;
    this.surfMat.uniforms.uFilter.value = THREE.MathUtils.smoothstep(1 - k, 0.2, 0.75);
    this.coronaMat.uniforms.uI.value = this.baseCorona * (0.35 + 0.65 * k);
    for (const m of this.loops.children) m.material.uniforms.uK.value = 0.5 + 0.5 * k;
    if (this.pulsarSpin) { this.pulsarSpin.rotation.y = t * 2.6; }
  }

  dispose() { this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); }
}
