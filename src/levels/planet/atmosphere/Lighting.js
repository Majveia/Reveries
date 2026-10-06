// PlanetLighting — scene lights that agree with the sky.
//
//   • Key light: the sun, coloured by the true atmospheric transmittance at the
//     focus point (white noon → amber golden hour → crimson sunset → gone at the
//     planet's shadow). At night the same light becomes the brightest moon
//     (phase- and size-weighted), so there is always exactly one shadow caster
//     and no pop at the hand-over (both are ~0 at the switch).
//   • Ambient / IBL: a small HDR cubemap of the sky is ray-marched through the
//     physical atmosphere from the focus point (ground bounce below the
//     horizon), prefiltered with PMREM and set as scene.environment, so every
//     MeshStandardMaterial (terrain, buildings, characters) gets matching
//     diffuse sky light and glossy reflections. Regenerated when the sun or
//     the focus moves noticeably.
//   • Shadows: one camera-fitted, texel-snapped shadow frustum around the
//     focus, biased toward the view direction (stable, no shimmering).
//
// Public state for other modules (level.lighting):
//   keyDir (Vector3, toward the light), keyColor (Color, rgb × intensity),
//   sunTransmittance (Vector3), skyColor / groundColor (Color, mean radiance),
//   night (0..1), envMap (PMREM texture or null)

import * as THREE from 'three';
import { AtmosphereModel, ATMO_PARS, ATMO_FUNCS } from './AtmosphereModel.js';
import { Celestial } from './Celestial.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _c = new THREE.Color();
const _m4 = new THREE.Matrix4();

const ENV_FRAG = /* glsl */ `
${ATMO_PARS}
${ATMO_FUNCS}
uniform vec3 uEnvOrigin;
uniform float uGroundR;
uniform vec3 uGroundLum;
uniform vec3 uNightFloor;
varying vec3 vDir;
void main(){
  vec3 rd = normalize(vDir);
  vec3 ro = uEnvOrigin;
  vec3 L = vec3(0.0), T = vec3(1.0);
  vec2 tg = raySphere(ro, rd, uGroundR);
  bool ground = tg.x > 0.0;
  vec2 ta = raySphere(ro, rd, uRt);
  if (ta.y > 0.0) {
    float t0 = max(ta.x, 0.0);
    float t1 = ground ? min(ta.y, tg.x) : ta.y;
    atmoIntegrate(ro, rd, t0, t1, 14, 0, L, T);
  }
  if (ground) L += T * uGroundLum;
  // faint starlight / airglow so nights are never pitch black indoors
  L += uNightFloor * (ground ? 0.25 : 1.0);
  gl_FragColor = vec4(L, 1.0);
}`;

const ENV_VERT = /* glsl */ `
varying vec3 vDir;
void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// Moonlit sky scattering is kept below the physical ratio so nights stay OLED-deep
// (the moon still keys the ground at full strength).
const MOON_SKY = 0.4;

export class PlanetLighting {
  constructor(level) {
    this.level = level;
    this.engine = level.engine;
    this.world = level.world;
    this.model = AtmosphereModel.get(level);
    this.celestial = level.celestial || (level.celestial = new Celestial(level));
    const q = this.engine.quality;

    const sc = level.star?.color || [1, 1, 1];
    this.starColor = new THREE.Color(sc[0], sc[1], sc[2]);
    const sun = new THREE.DirectionalLight(this.starColor.clone(), 3.2);
    sun.castShadow = true;
    // one wide, texel-snapped frustum pushed ahead of the camera: ~0.14 m texels near the player,
    // long raking shadows across a few hundred metres of valley at golden hour
    const sm = q.pick(1024, 2048, 3072, 4096);
    sun.shadow.mapSize.set(sm, sm);
    this.shadowRadius = q.pick(70, 140, 220, 300);
    const s = this.shadowRadius;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 6000 });
    sun.shadow.bias = -0.00025;
    sun.shadow.normalBias = 0.05 * s / 70 + 0.25;
    sun.shadow.radius = 2;
    this.sun = sun;

    const P = level.aesthetic?.palette;
    this.hemi = new THREE.HemisphereLight(new THREE.Color(P?.sky || '#9fc4ff'), new THREE.Color(P?.ground?.[0] || '#55503a'), 0.5);

    // public state
    this.keyDir = new THREE.Vector3(0, 1, 0);
    this.keyColor = new THREE.Color(1, 1, 1);
    this.sunTransmittance = new THREE.Vector3(1, 1, 1);
    this.skyColor = new THREE.Color(0.3, 0.45, 0.7);
    this.groundColor = new THREE.Color(0.1, 0.1, 0.08);
    this.night = 0;
    this.keyIsMoon = false;
    this.envMap = null;
    this.sunVisible = 1;

    const g0 = new THREE.Color(P?.ground?.[0] || '#6a6a5a');
    const g1 = new THREE.Color(P?.ground?.[1] || P?.ground?.[0] || '#6a6a5a');
    this.groundAlbedo = g0.lerp(g1, 0.5).multiplyScalar(0.85);

    this._envState = { sun: new THREE.Vector3(9, 9, 9), pos: new THREE.Vector3(1e9, 0, 0), moonE: -1, frames: 0 };
    this._envFrame = 0;
  }

  attach(scene) {
    scene.add(this.sun, this.sun.target, this.hemi);
  }

  _initEnv() {
    const r = this.engine.renderer;
    const size = this.engine.quality.pick(16, 32, 32, 64);
    this.envScene = new THREE.Scene();
    this.envMat = new THREE.ShaderMaterial({
      vertexShader: ENV_VERT, fragmentShader: ENV_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: false,
      uniforms: {
        ...this.model.uniforms,
        uEnvOrigin: { value: new THREE.Vector3() }, uGroundR: { value: this.model.Rb },
        uGroundLum: { value: new THREE.Vector3() }, uNightFloor: { value: new THREE.Vector3() },
      },
    });
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.envMat);
    box.frustumCulled = false;
    this.envScene.add(box);
    this.cubeRT = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.cubeCam = new THREE.CubeCamera(0.1, 10, this.cubeRT);
    this.pmrem = new THREE.PMREMGenerator(r);
    this.envRT = null;
  }

  _regenEnv(focus) {
    if (!this.envScene) this._initEnv();
    const u = this.envMat.uniforms;
    const w = this.world;
    const up = _v.copy(focus).normalize();
    const groundR = w.radius + Math.max(w.heightAt(up), w.hasOcean ? w.seaLevel : -1e9);
    const pos = u.uEnvOrigin.value.copy(up).multiplyScalar(Math.max(focus.length(), groundR + 2));
    u.uGroundR.value = Math.min(groundR, pos.length() - 1);
    // Ground radiance: albedo/π × (direct + sky) irradiance at the focus.
    const kc = this.keyColor;
    const cosK = Math.max(0, up.dot(this.keyDir));
    const sky = this.skyColor;
    const ga = this.groundAlbedo;
    u.uGroundLum.value.set(
      ga.r * (kc.r * cosK + sky.r * Math.PI) / Math.PI,
      ga.g * (kc.g * cosK + sky.g * Math.PI) / Math.PI,
      ga.b * (kc.b * cosK + sky.b * Math.PI) / Math.PI,
    );
    const nf = 0.0016 * this.night;
    u.uNightFloor.value.set(nf * 0.6, nf * 0.75, nf * 1.2);
    const r = this.engine.renderer;
    const prevTarget = r.getRenderTarget();
    this.cubeCam.update(r, this.envScene);
    this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.envRT);
    r.setRenderTarget(prevTarget);
    this.envMap = this.envRT.texture;
    if (this.level.scene.environment !== this.envMap) this.level.scene.environment = this.envMap;
  }

  /** CPU single-scattering estimate of sky radiance (used for ambient colours). */
  _skyRadiance(pos, dir, out) {
    const m = this.model;
    if (!m.present) return out.set(0, 0, 0);
    const Rb = m.Rb, Rt = m.Rt;
    const r0 = Math.max(pos.length(), Rb + 1);
    const p0 = _v2.copy(pos).setLength(r0);
    const mu = p0.dot(dir) / r0;
    const disc = (Rt - r0) * (Rt + r0) + r0 * r0 * mu * mu;
    let dist = Math.max(0, -r0 * mu + Math.sqrt(Math.max(0, disc)));
    const gd = r0 * r0 * mu * mu - (r0 - Rb) * (r0 + Rb);
    if (mu < 0 && gd > 0) dist = Math.min(dist, -r0 * mu - Math.sqrt(gd));
    const N = 10, dt = dist / N;
    const pr = m._prof, cp = m._cpu, u = m.uniforms;
    const bR = u.uBetaR.value, bMs = u.uBetaMs.value;
    const cosS = dir.dot(m.sunDir), cosM = dir.dot(m.moonDir);
    const pR = (c) => 0.0596831 * (1 + c * c);
    const g = u.uMieG.value;
    const pM = (c) => { const g2 = g * g; return 0.1193662 * (1 - g2) / (2 + g2) * (1 + c * c) / Math.pow(Math.max(1 + g2 - 2 * g * c, 1e-4), 1.5); };
    const sE = m.sunE, mE = m.moonE;
    let odR = 0, odM = 0;
    let Lr = 0, Lg = 0, Lb = 0;
    const p = _v3;
    const Ts = new THREE.Vector3(), Tm = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) * dt;
      p.copy(p0).addScaledVector(dir, t);
      const h = Math.max(0, p.length() - Rb);
      const dR = Math.max(0, (Math.exp(-h / pr.HR) - pr.topR) * pr.normR);
      const dM = Math.max(0, (Math.exp(-h / pr.HM) - pr.topM) * pr.normM);
      odR += dR * dt; odM += dM * dt;
      const tv = [Math.exp(-(bR.x * odR + cp.betaMe * odM)), Math.exp(-(bR.y * odR + cp.betaMe * odM)), Math.exp(-(bR.z * odR + cp.betaMe * odM))];
      m.transmittance(p, m.sunDir, Ts, 10);
      m.transmittance(p, m.moonDir, Tm, 10);
      const sRs = pR(cosS), sMs = pM(cosS), sRm = pR(cosM), sMm = pM(cosM);
      const ms = 1.6; // multiple-scattering boost
      Lr += tv[0] * dt * ((bR.x * sRs + bMs.x * sMs) * sE.x * Ts.x * ms + (bR.x * sRm + bMs.x * sMm) * mE.x * Tm.x * ms);
      Lg += tv[1] * dt * ((bR.y * sRs + bMs.y * sMs) * sE.y * Ts.y * ms + (bR.y * sRm + bMs.y * sMm) * mE.y * Tm.y * ms);
      Lb += tv[2] * dt * ((bR.z * sRs + bMs.z * sMs) * sE.z * Ts.z * ms + (bR.z * sRm + bMs.z * sMm) * mE.z * Tm.z * ms);
    }
    return out.set(Lr, Lg, Lb);
  }

  update() {
    const L = this.level, w = this.world, m = this.model, cel = this.celestial;
    cel.update(this.engine.time);
    const focus = L.player?.position || L.camera.position;
    const up = _v.copy(focus).normalize();
    const alt = w.altitude(focus);

    // ---- sun ------------------------------------------------------------------
    const T = this.sunTransmittance;
    const probe = _probe.copy(focus).addScaledVector(up, 1.5);
    m.transmittance(probe, w.sunDir, T, 32);
    const sunElev = up.dot(w.sunDir);
    const E0 = m.sunE0;
    // ---- moon -----------------------------------------------------------------
    const ml = cel.moonlight();
    const moonFade = THREE.MathUtils.smoothstep(-sunElev, 0.03, 0.16);
    const moon = ml.moon;
    const moonE = ml.E * 0.34 * moonFade;
    // Atmosphere model light sources (sky scattering).
    m.sunE.set(this.starColor.r, this.starColor.g, this.starColor.b).multiplyScalar(E0);
    if (moon) {
      m.moonDir.copy(moon.pos).normalize();
      const mc = moon.color;
      m.moonE.set(0.78 + 0.1 * mc.r, 0.86 + 0.08 * mc.g, 1.0).multiplyScalar(moonE * MOON_SKY);
    } else m.moonE.set(0, 0, 0);
    this.night = 1 - THREE.MathUtils.smoothstep(sunElev, -0.14, 0.02);
    // airglow: faint green/blue emission so moonless nights keep a horizon line
    m.uniforms.uNightGlow.value.set(0.0009, 0.0016, 0.0024).multiplyScalar(this.night * (m.present ? 1 : 0));
    // bioluminescent worlds: the glowing forest lights the low haze (emissive → medium)
    if (this._bio === undefined) {
      const A = L.aesthetic, g = A?.palette?.glow?.[0];
      this._bio = A && g && (/pandora|eywa/i.test(A.name || '') || (A.kinds || []).includes('jungle')) ? new THREE.Color(g) : null;
    }
    // (bio-glow no longer lifts the sky dome: the zenith stays OLED black; it lights the cloud bases instead)

    // ---- key light ------------------------------------------------------------
    const sun = this.sun;
    const useMoon = sunElev < -0.035 && moon && moonE > 1e-4;
    this.keyIsMoon = !!useMoon;
    if (!useMoon) {
      this.keyDir.copy(w.sunDir);
      this.keyColor.setRGB(this.starColor.r * T.x, this.starColor.g * T.y, this.starColor.b * T.z).multiplyScalar(E0);
    } else {
      this.keyDir.copy(moon.pos).sub(focus).normalize();
      const Tm = m.transmittance(probe, this.keyDir, _v3, 20);
      this.keyColor.setRGB(m.moonE.x * Tm.x, m.moonE.y * Tm.y, m.moonE.z * Tm.z).multiplyScalar(1 / MOON_SKY);
    }
    const kI = Math.max(this.keyColor.r, this.keyColor.g, this.keyColor.b);
    sun.intensity = kI;
    if (kI > 0) sun.color.setRGB(this.keyColor.r / kI, this.keyColor.g / kI, this.keyColor.b / kI);
    this.sunVisible = THREE.MathUtils.clamp((T.x + T.y + T.z) / 3, 0, 1);

    // ---- shadow frustum: fitted around the focus, pushed toward the view ------
    const R = this.shadowRadius;
    const camDir = L.camera.getWorldDirection(_v3);
    camDir.addScaledVector(up, -camDir.dot(up));
    if (camDir.lengthSq() > 1e-6) camDir.normalize();
    const center = _c3.copy(focus).addScaledVector(camDir, R * 0.6);
    // snap to shadow texels in light space
    const lightPos = _c4.copy(this.keyDir).multiplyScalar(3000);
    _m4.lookAt(lightPos, _c5.set(0, 0, 0), Math.abs(this.keyDir.y) > 0.99 ? _c6.set(1, 0, 0) : _c6.set(0, 1, 0));
    const inv = _m4i.copy(_m4).invert();
    center.applyMatrix4(inv);
    const texel = (2 * R) / sun.shadow.mapSize.x;
    center.x = Math.round(center.x / texel) * texel;
    center.y = Math.round(center.y / texel) * texel;
    center.applyMatrix4(_m4);
    sun.target.position.copy(center);
    sun.position.copy(center).addScaledVector(this.keyDir, 3000);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
    sun.castShadow = kI > 0.02 && alt < 2500;

    // ---- ambient colours (CPU) -------------------------------------------------
    this._ambFrame = (this._ambFrame || 0) + 1;
    const moved = this._envState.pos.distanceTo(focus) > 250;
    const sunMoved = this._envState.sun.angleTo(w.sunDir) > 0.004;
    const moonChanged = Math.abs(this._envState.moonE - moonE) > 0.003;
    const shot = this.engine.shotMode;
    const due = moved || sunMoved || moonChanged || this._envFrame < 3 || (shot && this._envState.frames < 4) || this._ambFrame % 90 === 0;
    if (due) {
      // mean sky radiance from 5 directions (zenith + 4 at 25° elevation)
      const ref = Math.abs(up.y) < 0.95 ? _c5.set(0, 1, 0) : _c5.set(1, 0, 0);
      const t1 = _c6.crossVectors(ref, up).normalize();
      const t2 = _c7.crossVectors(up, t1).normalize();
      const acc = _acc.set(0, 0, 0), tmp = _tmp;
      const dirs = [[0, 1], [1, 0.42], [-1, 0.42], [0, 0.42], [0, 0.42]];
      for (let i = 0; i < 5; i++) {
        const d = _c8.copy(up).multiplyScalar(i === 0 ? 1 : 0.42);
        if (i === 1) d.addScaledVector(t1, 0.9); else if (i === 2) d.addScaledVector(t1, -0.9); else if (i === 3) d.addScaledVector(t2, 0.9); else if (i === 4) d.addScaledVector(t2, -0.9);
        d.normalize();
        this._skyRadiance(probe, d, tmp);
        acc.add(tmp);
      }
      acc.multiplyScalar(1 / 5);
      // night floor (starlight + airglow)
      const nf = 0.0012 * this.night;
      this.skyColor.setRGB(acc.x + nf * 0.6, acc.y + nf * 0.75, acc.z + nf * 1.2);
      const cosK = Math.max(0, up.dot(this.keyDir));
      const ga = this.groundAlbedo;
      this.groundColor.setRGB(
        ga.r * (this.keyColor.r * cosK / Math.PI + this.skyColor.r),
        ga.g * (this.keyColor.g * cosK / Math.PI + this.skyColor.g),
        ga.b * (this.keyColor.b * cosK / Math.PI + this.skyColor.b),
      );
      if (m.ready && !(this.engine.params.get('atmo') || '').includes('noenv')) {
        this._regenEnv(focus);
        this._envState.pos.copy(focus); this._envState.sun.copy(w.sunDir); this._envState.moonE = moonE; this._envState.frames++;
        this._envFrame++;
      }
    }
    // Hemisphere light: a fallback until the IBL exists, then off.
    const hemi = this.hemi;
    hemi.position.copy(up);
    if (this.envMap) hemi.intensity = 0;
    else {
      hemi.color.copy(this.skyColor).multiplyScalar(3);
      hemi.groundColor.copy(this.groundColor).multiplyScalar(3);
      hemi.intensity = 1.0;
    }
  }

  dispose() {
    this.cubeRT?.dispose(); this.envRT?.dispose(); this.pmrem?.dispose(); this.envMat?.dispose();
  }
}

const _c3 = new THREE.Vector3(), _c4 = new THREE.Vector3(), _c5 = new THREE.Vector3(), _c6 = new THREE.Vector3(), _c7 = new THREE.Vector3(), _c8 = new THREE.Vector3();
const _m4i = new THREE.Matrix4();
const _bioV = new THREE.Vector3();
const _acc = new THREE.Vector3(), _tmp = new THREE.Vector3(), _probe = new THREE.Vector3();
