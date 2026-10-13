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
import { COLOR_GLSL } from '../../core/glsl/common.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
    const intensity = kind === 'neutron' ? 60 : kind === 'whiteDwarf' ? 40 : kind === 'giant' ? 6 : 7;
    const cell = kind === 'giant' ? 22.0 : kind === 'whiteDwarf' ? 150.0 : 120.0;
    const spots = kind === 'main' ? THREE.MathUtils.clamp(1.2 - hot * 1.1, 0.15, 1.0) : kind === 'giant' ? 0.5 : 0.0;

    // ---- photosphere ---------------------------------------------------------------
    this.baseI = intensity;
    this.baseCorona = kind === 'neutron' ? 3.0 : 1.0;
    this.surfMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uColor: { value: col }, uI: { value: intensity }, uCell: { value: cell },
        uSpots: { value: spots }, uSeed: { value: rng.range(0, 50) }, uHot: { value: hot }, uFilter: { value: 0 },
        uOct: { value: q.pick(3, 4, 5, 5) }, uSpot: { value: this._spots(rng, kind) }, uTeff: { value: THREE.MathUtils.clamp(star.temp || 5800, 2500, 30000) },
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
        ${COLOR_GLSL}
        uniform float uTime, uI, uCell, uSpots, uSeed, uHot, uFilter, uTeff; uniform vec3 uColor; uniform int uOct; uniform vec4 uSpot[10];
        varying vec3 vObj; varying vec3 vN; varying vec3 vWP;
        vec3 rotY(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z); }
        // granulation cells: F1, F2 and a per-cell random (each granule has its own temperature)
        vec3 gcell(vec3 p){
          vec3 id = floor(p), f = fract(p);
          float f1 = 8.0, f2 = 8.0, hc = 0.0;
          for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            vec3 b = vec3(float(i), float(j), float(k));
            vec3 h = hash33(id + b);
            vec3 r = b + 0.15 + 0.7 * h - f;
            float d = dot(r, r);
            if (d < f1) { f2 = f1; f1 = d; hc = h.z; } else if (d < f2) { f2 = d; }
          }
          return vec3(sqrt(f1), sqrt(f2), hc);
        }
        // one octave of convection: domain-warped cells (never convex polygons), a bright upflow dome
        // with a dark rim, thin anti-aliased intergranular lanes and magnetic bright points
        float granule(vec3 p, float aa, float t){
          vec3 w = p + 0.6 * vec3(snoise(p * 0.45 + t), snoise(p * 0.45 + 17.0 - t), snoise(p * 0.45 + 31.0));
          vec3 g = gcell(w + vec3(0.0, 0.0, t * 2.0));
          float edge = g.y - g.x;
          float lw = 0.05 + 0.07 * g.z;
          float lane = smoothstep(lw - aa, lw + aa * 1.5 + 0.06, edge);
          float dome = 1.0 - smoothstep(0.0, 0.8, g.x);
          float cellT = 0.84 + 0.3 * g.z;
          float sub = snoise(w * 2.3 + t * 3.0);
          float gr = cellT * (0.3 + 0.7 * dome * dome) * mix(0.18, 1.0, lane) * (0.93 + 0.07 * sub);
          return gr + (1.0 - lane) * 0.14 * smoothstep(0.55, 0.9, snoise(w * 6.0));
        }
        // photospheric colour ramp by local brightness: cool lanes deep orange-red, hot granule tops yellow-white
        vec3 ramp(float x){
          vec3 a = vec3(0.5, 0.08, 0.01), b = vec3(1.0, 0.34, 0.04), c = vec3(1.0, 0.68, 0.26), d = vec3(1.0, 0.9, 0.7);
          return x < 0.5 ? mix(a, b, smoothstep(0.0, 0.5, x)) : x < 0.8 ? mix(b, c, (x - 0.5) / 0.3) : mix(c, d, smoothstep(0.8, 1.15, x));
        }
        void main(){
          vec3 p = normalize(vObj);
          float lat = p.y;
          vec3 q = rotY(p, uTime * (0.006 + 0.004 * (1.0 - lat * lat)));
          vec3 qs = q + uSeed;
          vec3 V = normalize(cameraPosition - vWP);
          float mu = clamp(dot(normalize(vN), V), 0.0, 1.0);
          // --- granulation: soft convective domes with diffuse lanes; the eye mostly reads the
          // mesogranular / supergranular brightness modulation riding on top (SDO / DKIST look)
          // camera-adaptive granulation: two octaves crossfaded so granules stay ~11 px on screen at any
          // distance, melting into a smooth mottle once even the base octave is sub-pixel
          vec3 wq = qs * uCell;
          float fsh = length(fwidth(wq));
          float lk = clamp(log2(0.09 / max(fsh, 1e-5)), -1.0, 4.0);
          float k0 = floor(lk), kf = lk - k0;
          float s0 = exp2(k0);
          float tg = uTime * 0.015;
          float gA = granule(wq * s0, fsh * s0, tg);
          float gB = granule(wq * s0 * 2.0 + 11.0, fsh * s0 * 2.0, tg * 1.4);
          float gran = mix(gA, gB, smoothstep(0.0, 1.0, kf));
          gran = mix(gran, 0.6, clamp(smoothstep(0.15, 0.6, fsh) * 0.85 + (1.0 - smoothstep(0.05, 0.4, mu)) * 0.7, 0.0, 1.0));
          // supergranulation network (bright chromospheric network edges) and large-scale mottling
          vec3 sq = qs * uCell * 0.1;
          sq += 0.35 * vec3(snoise(sq * 0.7 + 3.0), snoise(sq * 0.7 + 9.0), snoise(sq * 0.7 + 21.0));
          vec2 sg = worley(sq);
          float net = 1.0 - smoothstep(0.0, 0.6, sg.y - sg.x);
          float turb = fbm(qs * 4.0 + vec3(uTime * 0.008), uOct);
          float meso = fbm(qs * uCell * 0.035 + vec3(uTime * 0.01), 4);
          float I = (0.66 + 0.5 * gran) * (1.0 + 0.08 * turb + 0.35 * meso) * (1.0 + 0.12 * net);
          // --- sunspots: umbra, penumbra of radial filaments, plage/faculae around the group
          float umbra = 0.0, pen = 0.0, penI = 1.0, plage = 0.0;
          float spotVis = uSpots * (0.15 + 0.85 * uFilter);
          for (int i = 0; i < 10; i++) {
            vec4 s4 = uSpot[i];
            if (s4.w <= 0.0) continue;
            vec3 o = q - s4.xyz;
            float dd = length(o) / s4.w;
            plage = max(plage, exp(-dd * dd * 0.12) * smoothstep(0.9, 1.6, dd));
            if (dd > 1.6) continue;
            vec3 t1 = normalize(cross(s4.xyz, vec3(0.0, 1.0, 0.0)));
            vec3 t2 = cross(s4.xyz, t1);
            float az = atan(dot(o, t2), dot(o, t1));
            float fi = float(i) * 13.1;
            vec2 cs = vec2(cos(az), sin(az));
            float r = dd * (1.0 + 0.16 * fbm(vec3(cs * 0.8, fi), 2));
            float ru = dd * (1.0 + 0.22 * fbm(vec3(cs * 1.4, fi + 5.0), 3));
            float u = 1.0 - smoothstep(0.32, 0.46, ru);                         // smooth, dark umbra
            vec2 lq = vec2(dot(o, t1), dot(o, t2)) / s4.w;
            u *= 1.0 - 0.45 * smoothstep(0.72, 0.95, snoise(lq * 26.0 + fi));    // sparse umbral dots
            // light bridge: a bright granular lane cutting through the umbra
            float bridge = exp(-pow((lq.x * 0.8 + lq.y * 0.6 + 0.08 * snoise(lq * 6.0 + fi)) / 0.045, 2.0)) * step(0.5, fract(fi * 0.37 + 0.2));
            u *= 1.0 - 0.75 * bridge;
            // feathered outer edge: penumbral filaments finger out into the granulation
            float fing = 0.55 * snoise(vec2(az * 9.0, fi)) + 0.35 * snoise(vec2(az * 27.0, fi + 3.0)) + 0.2 * snoise(vec2(az * 70.0, fi + 7.0));
            float rOut = 1.0 + 0.15 * fing;
            float pp = 1.0 - smoothstep(rOut - 0.18, rOut + 0.03, r);
            // filaments: thin in azimuth, long along the radius, drifting outward (Evershed flow);
            // bright penumbral grains at their inner heads, darker cores toward the outer edge
            float ev = uTime * 0.01;
            float fil = 0.5 + 0.5 * snoise(vec2(az * 70.0, (r - ev) * 2.6 + fi));
            fil = mix(fil, 0.5 + 0.5 * snoise(vec2(az * 160.0, (r - ev) * 4.5 - fi)), 0.45);
            float heads = smoothstep(0.62, 0.9, fil) * (1.0 - smoothstep(0.44, 0.72, r)) * smoothstep(0.36, 0.44, r) * 0.32;
            float pI = mix(0.6, 0.9, smoothstep(0.42, 1.0, r)) * mix(0.62, 1.12, fil) + heads;
            umbra = max(umbra, u);
            if (pp > pen) { pen = pp; penI = pI; }
          }
          umbra *= spotVis; pen *= spotVis; plage *= spotVis;
          float lt = clamp(1.0 - mu, 0.0, 1.0);
          // faculae: bright granular network around active regions, visible toward the limb
          float faculae = plage * (0.3 + 0.7 * gran) * (0.2 + 1.3 * lt * lt);
          // close-up chromospheric texture: dark meandering filaments
          float fr = 1.0 - abs(snoise(qs * 5.0 + vec3(0.0, 0.0, uTime * 0.002) + 0.35 * vec3(fbm(qs * 14.0, 3))));
          float filament = pow(clamp(fr, 0.0, 1.0), 9.0) * smoothstep(0.3, 0.7, fbm(qs * 18.0, 3) + 0.5) * smoothstep(-0.2, 0.3, snoise(qs * 2.2 + 9.0)) * (1.0 - smoothstep(0.75, 0.9, abs(lat)));
          I *= 1.0 - uFilter * 0.07 * filament;
          I *= 1.0 + faculae * 0.55 + plage * 0.06;
          I = mix(I, 0.95 * penI, pen);   // penumbra: filaments replace granulation
          I *= mix(1.0, 0.16, umbra);
          // limb darkening (wavelength dependent: the limb is redder and dimmer)
          vec3 limb = pow(vec3(max(mu, 0.02)), vec3(0.6, 0.9, 1.3) * mix(1.0, 0.55, uHot) * mix(1.0, 1.25, uFilter));
          limb *= 0.55 + 0.45 * smoothstep(0.0, 0.12, mu);
          // far view: true stellar colour; close-up: a warm white-light filter — yellow-white granule tops, amber lanes
          vec3 farTone = uColor * mix(vec3(1.0, 0.78, 0.6), vec3(1.0), clamp(I, 0.0, 1.0)) * I;
          // close-up: each pixel's brightness is a temperature (Stefan-Boltzmann, T ~ I^1/4) through a warm
          // white-light filter: white-gold granule domes, orange lanes, red-brown umbrae
          float Tl = uTeff * pow(max(I * 0.95, 0.02), 0.25) * mix(0.93, 1.0, smoothstep(0.0, 0.6, mu));
          vec3 nearTone = blackbody(Tl) * vec3(1.0, 0.7, 0.34) * pow(max(I, 0.0), 2.6) * 0.62;
          vec3 c = mix(farTone, nearTone, uFilter) * limb * uI;
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
        uHalpha: { value: new THREE.Color().setRGB(1.0, 0.16 + 0.15 * hot, 0.1 + 0.25 * hot) }, uNear: { value: 0 },
        uI: { value: kind === 'neutron' ? 3.0 : 1.0 },
      },
      vertexShader: FACING_VERT,
      fragmentShader: /* glsl */`
        ${NOISE_GLSL}
        uniform float uTime, uDisk, uSeed, uI, uNear; uniform vec3 uColor, uHalpha;
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
          float inner = exp(-x * 14.0) * 1.2;
          float outer = exp(-x * 1.6) * 0.16 * rays * eq * (0.7 + 0.6 * st);
          float halo = 0.03 / (1.0 + x * x * 10.0) + 0.1 * exp(-x * 2.2) + 0.035 / (1.0 + x * x * 1.5);   // warm scattered glow: the star reads as a light source, not a disc
          float chromo = exp(-pow((r - 1.006) / 0.02, 2.0)) * (0.8 + 0.4 * st) * 0.55;
          halo *= 1.0 - 0.75 * uNear;   // close-up: space stays black right beside the limb
          // spicule forest: two frequencies of thin jets with jittered heights fringe the limb
          float sh = 0.004 + 0.009 * (0.5 + 0.5 * snoise(vec2(a * 95.0, 3.0 + uTime * 0.02)));
          float sp1 = smoothstep(0.25, 0.85, snoise(vec2(a * 160.0, uTime * 0.05)));
          float sp2 = smoothstep(0.35, 0.9, snoise(vec2(a * 420.0, 7.0 + uTime * 0.07)));
          float spicules = max(sp1, sp2 * 0.8) * (1.0 - smoothstep(sh * 0.35, sh, x)) * mix(0.6, 1.4, uNear);
          float skirt = exp(-x * 22.0) * 0.14 * (0.6 + 0.8 * st);   // diffuse off-limb H-alpha emission the prominences sit in
          vec3 c = uColor * (inner + outer) * uI + uColor * mix(vec3(1.0), uHalpha, 0.35) * halo * 0.4 * uI + uHalpha * (chromo * 1.3 + spicules * 0.7 + skirt);
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
        ${NOISE_GLSL}
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
          // irregular eyelash rays: lengths and strengths vary around the disc (periodic noise on the circle)
          vec2 cs = vec2(cos(a), sin(a));
          float rn = 0.5 + 0.5 * snoise(cs * 14.0 + 3.1);
          float rn2 = 0.5 + 0.5 * snoise(cs * 41.0 - 7.0);
          float fine = pow(rn2, 9.0) * rn * rn * (0.5 + 1.5 * rn) * exp(-r * (8.0 + 16.0 * (1.0 - rn)));
          float core = 0.10 / (1.0 + pow(r * 26.0, 2.0)) + 0.012 / (1.0 + r * r * 220.0);
          float rays = fine * 0.07;
          // wide veiling glare (scatter in the eye / lens): warm, very low amplitude
          core += 0.006 / (1.0 + r * r * 40.0);
          float ring = 0.0;
          // colour gradient: white-hot core -> stellar colour -> warm scattered halo
          vec3 tint = mix(mix(vec3(1.0), uColor, 0.45), uColor * vec3(1.08, 0.78, 0.5), smoothstep(0.02, 0.35, r));
          vec3 c = tint * (core + spikes * 0.05 + rays) + vec3(0.6, 0.8, 1.0) * ring;
          gl_FragColor = vec4(c * uVis * uI * smoothstep(1.0, 0.8, r), 1.0);
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
    });
    this.glare = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.glareMat);
    this.glare.frustumCulled = false; this.glare.renderOrder = 50;
    this.group.add(this.glare);
  }

  /** Sunspot groups in the royal latitudes: leader + follower spots trailing east. */
  _spots(rng, kind) {
    const out = [];
    for (let i = 0; i < 10; i++) out.push(new THREE.Vector4(0, 1, 0, 0));
    if (kind !== 'main' && kind !== 'giant') return out;
    let n = 0;
    // the first group sits on the close-up shot's face of the star
    const shotDir = new THREE.Vector3(0.05, 0.22, -1).normalize();
    for (let g = 0; g < 4 && n < 10; g++) {
      const lat = (rng.chance(0.5) ? 1 : -1) * rng.range(0.12, 0.5);
      const lon = rng.range(0, Math.PI * 2);
      let c = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
      if (g === 0) c = shotDir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.45).add(new THREE.Vector3(0, 0.12, 0)).normalize();
      const east = new THREE.Vector3(0, 1, 0).cross(c).normalize();
      const big = g === 0 ? 0.036 : rng.range(0.018, 0.035);
      const m = g === 0 ? 5 : 1 + rng.int(1, 3);
      for (let k = 0; k < m && n < 10; k++) {
        const d = c.clone().addScaledVector(east, k * big * rng.range(1.6, 2.6)).add(new THREE.Vector3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).multiplyScalar(big * 0.5 * Math.min(k, 1))).normalize();
        out[n++].set(d.x, d.y, d.z, big * (k === 0 ? 1 : rng.range(0.22, 0.6)));
      }
    }
    return out;
  }

  // Volumetric quiescent prominence for the shot limb: a stack of translucent slices through one
  // coherent 3D emission field: an arched magnetic flux rope over a hedgerow curtain of fine vertical
  // threads, eroded by fbm, with coronal rain beading down the legs. H-alpha, bright enough to bloom.
  _buildSheet(rng, color, dir) {
    const R = this.radius;
    const tan = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
    const side = new THREE.Vector3().crossVectors(dir, tan).normalize();
    const span = R * 0.42, H = R * 0.2, NS = this.engine.quality.pick(6, 8, 12, 14), thick = R * 0.035;
    const pos = [], sl = [], idx = [];
    for (let j = 0; j < NS; j++) {
      const o = ((j + 0.5) / NS - 0.5) * 2 * thick;
      const base = pos.length / 3;
      for (const [x, y] of [[-0.5, -0.03], [0.5, -0.03], [0.5, 0.6], [-0.5, 0.6]]) {
        const v = dir.clone().multiplyScalar(R * (0.985 + y)).addScaledVector(tan, x * R).addScaledVector(side, o);
        pos.push(v.x, v.y, v.z); sl.push(j / NS);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aSlice', new THREE.Float32BufferAttribute(sl, 1));
    g.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color }, uI: { value: 4.6 / NS }, uK: { value: 1 }, uTime: { value: 0 }, uRad: { value: R },
        uDir: { value: dir }, uTan: { value: tan }, uSide: { value: side }, uSpan: { value: span }, uH: { value: H }, uThick: { value: thick } },
      vertexShader: /* glsl */`
        attribute float aSlice; varying float vS; varying vec3 vWP;
        void main(){ vS = aSlice; vec4 wp = modelMatrix * vec4(position, 1.0); vWP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: /* glsl */`
        ${NOISE_GLSL}
        uniform vec3 uColor, uDir, uTan, uSide; uniform float uI, uK, uTime, uRad, uSpan, uH, uThick;
        varying float vS; varying vec3 vWP;
        void main(){
          float hgt = length(vWP) - uRad;                       // height above the photosphere
          float x = dot(vWP, uTan) / (uSpan * 0.5);             // along the filament channel
          float z = dot(vWP, uSide) / uThick;                   // across (slice depth)
          float y = hgt / uH;
          // flux-rope spine: a slightly asymmetric semi-ellipse, sagging in the middle (twisted rope)
          float xx = x + 0.12 * sin(y * 2.0 + 0.6);
          float sp = sqrt(max(1.0 - xx * xx, 0.0)) * (1.0 - 0.18 * exp(-xx * xx * 6.0));
          float t = uTime * 0.02;
          vec3 wq = vec3(x * 3.0, y * 3.0, z * 0.6 + vS * 0.3);
          float warp = fbm(wq * 0.9 + vec3(0.0, -t, 0.0), 3);
          float d = abs(y - sp + 0.12 * warp);
          float knot = 0.45 + 0.9 * smoothstep(-0.3, 0.5, fbm(vec3(x * 4.0 - t * 2.0, y * 1.5, vS), 3));
          float rope = exp(-d * d / 0.03) * step(abs(xx), 1.05) * knot;
          // hedgerow curtain hanging below the rope down to the chromosphere
          float curtain = smoothstep(-0.02, 0.25, sp - y) * smoothstep(1.02, 0.5, abs(xx)) * (0.6 + 0.5 * smoothstep(0.0, 0.8, sp - y + 0.3));
          // fine vertical threads: noise stretched ~1:8 along the local vertical
          // resolvable threads (a few px apart on screen, not sub-pixel cotton), sharpened into strands
          float th1 = 0.5 + 0.5 * snoise(vec3(x * 13.0 + 3.0 * warp, y * 2.2 - t * 3.0, z * 1.2 + vS * 1.5));
          float th2 = 0.5 + 0.5 * snoise(vec3(x * 31.0 + 5.0 * warp, y * 3.0 - t * 4.0, z * 1.5 + vS * 2.0 + 9.0));
          float th = max(pow(th1, 6.0), 0.7 * pow(th2, 7.0)) * 2.2;
          // erosion: large holes and ragged edges
          float er = smoothstep(-0.25, 0.35, fbm(wq * 1.7 + vec3(t, 0.0, 0.0), 4) + 0.25);
          // coronal rain: bright beads streaming down the legs
          float legs = smoothstep(0.55, 0.95, abs(x)) * step(abs(x), 1.0);
          float rain = legs * smoothstep(0.8, 0.98, snoise(vec3(x * 60.0, y * 14.0 + uTime * 0.25, vS * 3.0))) * smoothstep(0.0, 0.3, sp - y + 0.1);
          float slab = exp(-z * z * 1.6);                       // soft volume edge across the slices
          float dens = (max(rope * (0.35 + 0.8 * th), curtain * th * 0.75) * er + rain * 0.8) * slab;
          dens *= smoothstep(-0.02, 0.03, hgt / uRad) ;           // emerges from the chromosphere
          dens *= exp(-max(y - 1.0, 0.0) * 4.0);
          // smooth window inside the slice quads: no slice edge can ever show as a straight cut
          float bx = abs(dot(vWP, uTan)) / (uRad * 0.5), by = hgt / (uRad * 0.6);
          dens *= smoothstep(1.0, 0.72, max(bx, by));
          // against the disk a prominence is an absorbing filament, not emission
          vec3 V = normalize(cameraPosition - vWP);
          float bq = dot(vWP, -V), cq = dot(vWP, vWP) - uRad * uRad;
          float onDisk = step(bq, 0.0) * smoothstep(0.0, 0.03 * uRad * uRad, bq * bq - cq);
          dens *= 1.0 - 0.92 * onDisk;
          vec3 c = uColor * (1.0 + vec3(0.9, 0.55, 0.45) * rope * th);   // hot rope core brightens (blooms)
          gl_FragColor = vec4(c * dens * uI * uK, 1.0);
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false;
    this.loops.add(m);
  }

  _buildLoops(rng, col, hot) {
    const R = this.radius;
    const hAlpha = new THREE.Color().setRGB(1.0, 0.15 + 0.1 * hot, 0.17 + 0.14 * hot);   // H-alpha deep red
    const mkMat = (color, I, flow, H = 0.12) => new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color }, uI: { value: I }, uK: { value: 1 }, uTime: { value: 0 }, uFlow: { value: flow }, uSeed: { value: rng.range(0, 40) }, uR: { value: 9.0 / this.radius }, uRad: { value: R }, uH: { value: H } },
      vertexShader: /* glsl */`
        varying vec2 vUv; varying vec3 vN; varying vec3 vWP;
        void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 wp = modelMatrix * vec4(position, 1.0); vWP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: /* glsl */`
        ${NOISE_GLSL}
        uniform vec3 uColor; uniform float uI, uK, uTime, uFlow, uSeed, uR, uRad, uH;
        varying vec2 vUv; varying vec3 vN; varying vec3 vWP;
        void main(){
          vec3 V = normalize(cameraPosition - vWP);
          float f = abs(dot(normalize(vN), V));
          // soft, fuzzy plasma: a gaussian column density across the tube instead of a hard edge
          float core = exp(-pow(1.0 - f, 2.0) * 9.0) * (0.35 + 0.65 * f);
          // magnetically aligned plasma: 3D turbulence in world space, smeared along the loop
          // threads hang along the local vertical: compress the noise along the radial direction
          vec3 rad = normalize(vWP);
          vec3 wp = vWP * uR;
          wp -= rad * dot(wp, rad) * 0.85;
          wp += uSeed;
          float drift = uTime * uFlow * 0.03;
          float n1 = fbm(wp * 2.2 + vec3(0.0, drift, 0.0), 4);
          float n2 = fbm(wp * 9.0 - vec3(drift, 0.0, drift), 3);
          float knots = 0.55 + 0.9 * smoothstep(-0.1, 0.6, fbm(vec2(vUv.x * 9.0 - uTime * uFlow * 0.4 + uSeed, vUv.y * 3.0), 3));
          float cloudy = smoothstep(-0.15, 0.5, n1 + 0.7 * n2) * (0.35 + 0.65 * smoothstep(-0.1, 0.45, n2));
          float strand = pow(cloudy, 1.6) * knots;
          float ends = smoothstep(0.0, 0.07, vUv.x) * smoothstep(1.0, 0.93, vUv.x);
          // footpoints glow hotter where the plasma drains back into the chromosphere
          float foot = 1.0 + 1.4 * (exp(-vUv.x * 14.0) + exp(-(1.0 - vUv.x) * 14.0));
          // tops dissolve: emission measure falls off with height above the photosphere
          float hgt = max(length(vWP) / uRad - 1.0, 0.0);
          float fade = exp(-hgt / uH);
          // seen against the photosphere a prominence is a dark filament, not emission: the view ray
          // continuing past this fragment hits the star -> suppress (no comb streaks on the disk)
          vec3 rd = -V;
          float bq = dot(vWP, rd), cq = dot(vWP, vWP) - uRad * uRad;
          float disc = bq * bq - cq;
          float onDisk = step(bq, 0.0) * smoothstep(0.0, 0.03 * uRad * uRad, disc);
          fade *= 1.0 - 0.9 * onDisk;
          gl_FragColor = vec4(uColor * uI * uK * core * strand * foot * fade * (0.35 + 0.65 * ends), 1.0);
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide,
    });
    const geoms = [];
    const flush = (mat) => {
      if (!geoms.length) return;
      const m = new THREE.Mesh(mergeGeometries(geoms.splice(0)), mat); m.frustumCulled = false;
      this.loops.add(m);
    };
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
      geoms.push(new THREE.TubeGeometry(curve, 40, thick, 5, false));
    };
    const randDir = (latMax) => {
      const lat = rng.range(-latMax, latMax), lon = rng.range(0, Math.PI * 2);
      return new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
    };
    const tangentOf = (dir) => new THREE.Vector3(rng.range(-1, 1), rng.range(-0.3, 0.3), rng.range(-1, 1)).cross(dir).normalize();
    // Quiescent prominences: translucent hedgerows of very fine magnetic threads, H-alpha pink,
    // much dimmer than the disk. One is placed on the shot limb (+x side).
    const nProm = 5;
    for (let k = 0; k < nProm; k++) {
      if (k === 0) { this._buildSheet(rng, hAlpha, new THREE.Vector3(0.05, 0.22, -1).normalize()); continue; }
      const dir = k === 0 ? new THREE.Vector3(0.05, 0.22, -1).normalize() : randDir(0.9);
      const tan = k === 0 ? new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y).normalize() : tangentOf(dir);
      const mat = mkMat(hAlpha, 0.55, 0.25, 0.1);
      const span = R * rng.range(0.16, 0.3) * (k === 0 ? 1.2 : 1), height = R * rng.range(0.12, 0.26) * (k === 0 ? 1.25 : 1);
      const side = new THREE.Vector3().crossVectors(dir, tan).normalize();
      const nThreads = k === 0 ? 90 : 50;
      for (let s = 0; s < nThreads; s++) {
        const off = side.clone().multiplyScalar(R * rng.range(-0.03, 0.03)).addScaledVector(tan, R * rng.range(-0.05, 0.05));
        if (s % 3 === 2) {
          // hedgerow pillars: short, near-vertical threads hanging between the arches' legs
          const sp2 = span * rng.range(0.04, 0.12);
          arch(dir.clone().multiplyScalar(R).add(off).addScaledVector(tan, span * rng.range(-0.35, 0.35)), tan, sp2, height * rng.range(0.3, 0.8), R * rng.range(0.002, 0.005), mat, R * rng.range(-0.01, 0.01));
        } else {
          arch(dir.clone().multiplyScalar(R).add(off), tan, span * rng.range(0.6, 1.2), height * rng.range(0.45, 1.1), R * (s < 8 ? rng.range(0.008, 0.014) : rng.range(0.002, 0.006)), mat, R * rng.range(-0.05, 0.05));
        }
      }
      flush(mat);
    }
    // Active-region arcades: nested hot loops.
    const hotCol = col.clone().multiply(new THREE.Color(1.0, 0.72, 0.42));
    for (let k = 0; k < 3; k++) {
      const dir = k === 0 ? new THREE.Vector3(-0.15, 0.3, -1).normalize() : randDir(0.5);
      const tan = tangentOf(dir);
      const mat = mkMat(hotCol, 0.4, 0.6, 0.06);
      const base = R * rng.range(0.05, 0.1);
      for (let s = 0; s < 7; s++) {
        const off = new THREE.Vector3().crossVectors(dir, tan).normalize().multiplyScalar((s - 3) * R * 0.012);
        arch(dir.clone().multiplyScalar(R).add(off), tan, base * (1 + s * 0.05), base * 0.55 * (1 + s * 0.04), R * 0.0025, mat);
      }
      flush(mat);
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
    const k = THREE.MathUtils.clamp(Math.pow((d / R) / 10, 1.2), 0.26, 1);
    this.surfMat.uniforms.uI.value = this.baseI * k;
    this.surfMat.uniforms.uFilter.value = THREE.MathUtils.smoothstep(1 - k, 0.2, 0.75);
    this.coronaMat.uniforms.uI.value = this.baseCorona * (0.12 + 0.88 * k);
    this.coronaMat.uniforms.uNear.value = this.surfMat.uniforms.uFilter.value;
    for (const m of this.loops.children) m.material.uniforms.uK.value = 0.5 + 0.5 * k;
    if (this.pulsarSpin) { this.pulsarSpin.rotation.y = t * 2.6; }
  }

  dispose() { this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); }
}
