// Atmosphere — the HDR aerial-perspective / sky post effect, from orbit to the ground.
//
// For every pixel: the view ray is clipped to the atmosphere shell and to the
// scene depth (reversed-Z aware). Then
//   • sky pixels seen from inside the air → sky-view LUT (Hillaire 2020) +
//     LUT transmittance applied to the space radiance drawn by the Sky dome
//     (sun disk, moons, stars, galaxy);
//   • everything else (terrain, cities, the planet seen from orbit, the limb)
//     → per-pixel integration of Rayleigh + Mie + ozone + weather fog with the
//     transmittance and multiple-scattering LUTs, step count proportional to
//     the optical path. Cloud shadows darken the ground and carve
//     crepuscular shafts into the in-scattered light.
//
// Pass chain owned here (in this order): air → clouds → weather overlays.

import * as THREE from 'three';
import { AtmosphereModel, ATMO_PARS, ATMO_FUNCS, SKYVIEW_FUNCS } from './AtmosphereModel.js';
import { CLOUD_UNIFORMS_GLSL, CLOUD_FUNCS_GLSL } from './CloudShared.js';
import { DEPTH_GLSL, FULLSCREEN_VERT } from '../../../core/glsl/common.js';

const AP_FRAG = /* glsl */ `
${ATMO_PARS}
#ifdef CLOUDS
${CLOUD_UNIFORMS_GLSL}
${CLOUD_FUNCS_GLSL}
uniform float uShadowAmt;
#ifdef ATMO_SUN_SHADOW
float atmoSunShadow(vec3 P){ return mix(1.0, cloudShadow(P, uSunDir), uShadowAmt); }
#endif
#endif
${ATMO_FUNCS}
${SKYVIEW_FUNCS}
${DEPTH_GLSL}
uniform sampler2D tInput, tDepth;
uniform float uNear, uFar, uRev;
uniform mat4 uProjInv, uViewInv;
uniform vec3 uCam;
uniform float uMaxSteps;
uniform float uMarchSky;
uniform float uGroundShadow;
uniform float uFrameJit;
varying vec2 vUv;

void main(){
  vec3 col = texture2D(tInput, vUv).rgb;
  float depth = texture2D(tDepth, vUv).r;
  bool far = isFarDepth(depth, uRev);
  vec3 vp = viewPosFromDepth(vUv, far ? 0.5 : depth, uProjInv, uRev);
  vec3 rd = normalize((uViewInv * vec4(vp, 1.0)).xyz - uCam);
  float dist = far ? 1e12 : length(viewPosFromDepth(vUv, depth, uProjInv, uRev));
  vec3 ro = uCam;
  float r = length(ro);
  vec2 ta = raySphere(ro, rd, uRt);
  if (ta.y <= 0.0) { gl_FragColor = vec4(col, 1.0); return; }
  float t0 = max(ta.x, 0.0);
  float t1 = min(ta.y, dist);
  bool groundHit = false;
  if (far) {
    vec2 tg = raySphere(ro, rd, uRb - 30.0);
    if (tg.x > 0.0) { t1 = min(t1, tg.x); groundHit = true; col = vec3(0.0); }
  }
  if (t1 <= t0) { gl_FragColor = vec4(col, 1.0); return; }
  vec3 L, T;
  bool inside = r < uRt - 1.0;
  if (far && inside && !groundHit && uMarchSky < 0.5) {
    vec4 sv = skyViewLookup(rd);
    L = sv.rgb;
    T = atmoTransmittance(r, dot(ro / r, rd));
  } else {
    float path = (t1 - t0) / (uRt - uRb);
    float N = clamp(6.0 + path * 7.0, 6.0, uMaxSteps);
#ifdef ATMO_SUN_SHADOW
    // decorrelate the shaft sampling per pixel (no stair-stepped rings)
    gAtmoJitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uFrameJit);
#endif
    atmoIntegrate(ro, rd, t0, t1, int(N), 0, L, T);
  }
#ifdef CLOUDS
  if (!far && uGroundShadow > 0.0) {
    vec3 P = ro + rd * dist;
    float s = cloudShadow(P, uSunDir);
    col *= mix(1.0, s, uGroundShadow);
  }
#endif
  gl_FragColor = vec4(col * T + L, 1.0);
}`;

const COPY_FRAG = /* glsl */ `uniform sampler2D tInput; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tInput, vUv); }`;

export default class Atmosphere {
  static order = 90;
  constructor(level) {
    this.level = level;
    this.engine = level.engine;
    this.world = level.world;
    this.model = AtmosphereModel.get(level);
    this.ready = false;
    const self = this;
    // Proxies in the order they must composite. Clouds and Weather never expose
    // their own `effects` so PlanetLevel cannot reorder them.
    this.airPass = {
      get enabled() { return self.ready && self.model.present; },
      render: (r, input, output, ctx) => self._timed('air', r, () => self._renderAir(r, input, output, ctx)),
    };
    this.cloudPass = {
      get enabled() { const c = self.level.sys?.clouds; return !!(c && c.ready && c.enabled && c.visible !== false); },
      render: (r, input, output, ctx) => self._timed('clouds', r, () => self.level.sys.clouds.render(r, input, output, ctx)),
    };
    this.weatherPass = {
      get enabled() { const w = self.level.sys?.weather; return !!(w && w.ready && w.active); },
      render: (r, input, output, ctx) => self.level.sys.weather.render(r, input, output, ctx),
    };
    // debug toggles: ?atmo=noair,noclouds,noweather,noshafts
    const dbg = (this.engine.params.get('atmo') || '').split(',');
    this.dbg = new Set(dbg);
    this.effects = [this.dbg.has('noair') ? null : this.airPass, this.dbg.has('noclouds') ? null : this.cloudPass, this.dbg.has('noweather') ? null : this.weatherPass].filter(Boolean);
  }

  async init() {
    await this.model.init();
    this.mat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: AP_FRAG, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: {
        ...this.model.uniforms,
        tInput: { value: null }, tDepth: { value: null },
        uNear: { value: 0.1 }, uFar: { value: 1e7 }, uRev: { value: 1 },
        uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() },
        uMaxSteps: { value: this.engine.quality.pick(16, 24, 40, 56) },
        uMarchSky: { value: 0 }, uGroundShadow: { value: 0 }, uShadowAmt: { value: 0 }, uFrameJit: { value: 0 },
      },
    });
    this.ready = true;
  }

  _hookClouds() {
    // Once clouds are ready, recompile with cloud shadows (+ shafts on high quality).
    const c = this.level.sys?.clouds;
    if (!c || !c.ready || this._cloudsHooked) return;
    this._cloudsHooked = true;
    Object.assign(this.mat.uniforms, c.uniforms);
    this.mat.defines = { CLOUDS: 1 };
    if (this.engine.quality.level >= 2) this.mat.defines.ATMO_SUN_SHADOW = 1;
    this.mat.needsUpdate = true;
  }

  update() {}

  // TEMP profiling (shot mode, first frames)
  _timed(name, r, fn) {
    this._dbg = this._dbg || {};
    const n = this._dbg[name] = (this._dbg[name] || 0) + 1;
    if (!this.engine.shotMode || n > 8) return fn();
    const gl = r.getContext(); gl.finish();
    const t0 = performance.now(); fn(); gl.finish();
    console.warn(`[atmo] ${name} ms`, Math.round(performance.now() - t0));
  }

  _renderAir(renderer, input, output, ctx) {
    const m = this.model;
    this._hookClouds();
    m.renderSkyView(ctx.cameraPosition);
    const u = this.mat.uniforms;
    u.tInput.value = input; u.tDepth.value = ctx.depthTexture;
    u.uNear.value = ctx.near; u.uFar.value = ctx.far; u.uRev.value = ctx.reversed;
    u.uProjInv.value.copy(ctx.projInv); u.uViewInv.value.copy(ctx.viewInv); u.uCam.value.copy(ctx.cameraPosition);
    const c = this.level.sys?.clouds;
    if (this._cloudsHooked && c) {
      const L = this.level.lighting;
      const sunKey = L ? !L.keyIsMoon : true;
      const cov = c.uniforms.uCloudCov.value;
      u.uGroundShadow.value = sunKey ? 0.72 * Math.min(1, cov) * (L ? L.sunVisible : 1) : 0;
      u.uShadowAmt.value = 0.7;
      u.uFrameJit.value = this.engine.shotMode ? 0 : ((this._jf = ((this._jf || 0) + 1) % 64) * 0.618034) % 1;
      // march the sky (for crepuscular shafts) only when inside the air and the sun is low-ish
      const up = _v.copy(ctx.cameraPosition).normalize();
      const el = up.dot(this.world.sunDir);
      // Full-res sky marching for shafts banded badly (few steps over 100+ km); the sky now always
      // comes from the sky-view LUT. Opt back in for experiments with ?atmo=shafts.
      u.uMarchSky.value = this.dbg.has('shafts') && this.engine.quality.level >= 2 && el > -0.05 && el < 0.5 && ctx.cameraPosition.length() < m.Rt ? 1 : 0;
    }
    ctx.fullscreen(this.mat, output);
  }

  dispose() { this.mat?.dispose(); }
}

const _v = new THREE.Vector3();
export { COPY_FRAG };
