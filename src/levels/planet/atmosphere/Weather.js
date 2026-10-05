// Weather — the mood of the sky, per the world's aesthetic.
//
// A weather state (clear, cumulus, rain, storm, fog, snow, dust, ash, spores,
// aurora) drives every atmosphere system coherently:
//   • the cloud field (coverage / type / wetness preset → Clouds),
//   • the atmosphere medium (ground fog banks, dust/ash aerosols → the LUTs
//     and aerial perspective, so distant mountains dissolve into the haze),
//   • aurora curtains in the night sky (→ Sky),
//   • GPU particles around the camera: rain streaks, snowflakes, blowing dust,
//     falling ash with drifting embers, bioluminescent spores. Instanced quads
//     wrapped in a box that follows the camera, animated entirely in the
//     vertex shader, lit by the current key light + sky ambient, soft-depth
//     tested against the scene, composited after the clouds.
//
// level.weatherState = { kind, aurora, wetness, precipitation, fog, dust } for
// other modules (wet materials, audio). ?weather=rain overrides the choice.

import * as THREE from 'three';
import { AtmosphereModel } from './AtmosphereModel.js';
import { Random, seedFrom } from '../../../core/Random.js';
import { DEPTH_GLSL, FULLSCREEN_VERT } from '../../../core/glsl/common.js';

// kind → medium + particles
const KINDS = {
  clear: { clouds: 'clear', fog: 0.0, fogH: 120, dust: 0.0, particles: null },
  cumulus: { clouds: 'cumulus', fog: 0.0, fogH: 140, dust: 0.0, particles: null },
  rain: { clouds: 'rain', fog: 0.00025, fogH: 260, dust: 0.0, overcast: 0.5, particles: 'rain', wet: 1 },
  storm: { clouds: 'storm', fog: 0.0004, fogH: 300, dust: 0.0, overcast: 0.8, particles: 'rain', wet: 1 },
  fog: { clouds: 'fog', fog: 0.0014, fogH: 110, dust: 0.0, overcast: 0.2, particles: null, wet: 0.3 },
  snow: { clouds: 'snow', fog: 0.0003, fogH: 220, dust: 0.0, overcast: 0.3, particles: 'snow' },
  dust: { clouds: 'dust', fog: 0.00018, fogH: 240, dust: 0.3, particles: 'dust' },
  ash: { clouds: 'ash', fog: 0.0003, fogH: 320, dust: 0.45, particles: 'ash' },
  spores: { clouds: 'spores', fog: 0.0002, fogH: 160, dust: 0.0, particles: 'spores' },
  aurora: { clouds: 'aurora', fog: 0.0, fogH: 120, dust: 0.0, particles: 'snowlight', aurora: 1 },
};

// What a screenshot of each aesthetic should show by default.
const SHOT_WEATHER = { dune: 'dust', ghibli: 'cumulus', pandora: 'cumulus', glacier: 'aurora', inferno: 'ash', tarkovsky: 'fog', ueda: 'fog', wukong: 'fog', nausicaa: 'spores' };

const PART_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uCam, uEast, uUp, uNorth;
uniform float uTime, uBox, uSize, uStretch, uFall, uSwirl;
uniform vec3 uWind;
varying vec2 vUv;
varying float vFade;
varying float vSeed;
varying float vViewZ;
void main(){
  vUv = uv;
  vSeed = aSeed.w;
  // local (east, up, north) coordinates, wrapped in a box around the camera
  vec3 vel = vec3(uWind.x, -uFall * (0.75 + 0.5 * aSeed.w), uWind.z);
  float tt = uTime * (0.8 + 0.4 * aSeed.w);
  vec3 swirl = uSwirl * vec3(sin(tt * 1.3 + aSeed.x * 40.0), 0.4 * sin(tt * 0.9 + aSeed.y * 30.0), cos(tt * 1.1 + aSeed.z * 50.0));
  vec3 camL = vec3(dot(uCam, uEast), dot(uCam, uUp), dot(uCam, uNorth));
  vec3 p = aSeed.xyz * uBox + vel * uTime + swirl;
  p = mod(p - camL, uBox) - 0.5 * uBox;
  vec3 world = uCam + uEast * p.x + uUp * p.y + uNorth * p.z;
  vec3 velW = normalize(uEast * vel.x + uUp * vel.y + uNorth * vel.z + 1e-4);
  // camera-facing quad; rain stretches along its velocity
  vec3 toCam = normalize(cameraPosition - world);
  vec3 side = normalize(cross(velW, toCam));
  vec3 along = uStretch > 0.0 ? velW : normalize(cross(toCam, side));
  float size = uSize * (0.6 + 0.8 * fract(aSeed.w * 7.31));
  vec3 pos = world + side * (uv.x - 0.5) * size + along * (uv.y - 0.5) * size * max(uStretch, 1.0);
  float d = length(p);
  vFade = smoothstep(0.5 * uBox, 0.32 * uBox, d) * smoothstep(0.6, 3.0, length(cameraPosition - world));
  vec4 mv = viewMatrix * vec4(pos, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const PART_FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uNear, uFar, uRev;
uniform vec3 uColor, uGlow;
uniform float uAlpha, uGlowAmt, uShape, uTime;
varying vec2 vUv;
varying float vFade;
varying float vSeed;
varying float vViewZ;
void main(){
  vec2 c = vUv - 0.5;
  float a;
  if (uShape < 0.5) a = (1.0 - smoothstep(0.0, 0.5, abs(c.x) * 2.0)) * smoothstep(0.5, 0.15, abs(c.y)); // streak
  else if (uShape < 1.5) a = smoothstep(0.5, 0.1, length(c)); // soft dot
  else { // flake: soft dot with a brighter core
    float r = length(c);
    a = smoothstep(0.5, 0.25, r) * 0.6 + smoothstep(0.22, 0.0, r) * 0.6;
  }
  // soft depth test against the scene
  float d = texture2D(tDepth, gl_FragCoord.xy / uRes).r;
  float sceneZ = isFarDepth(d, uRev) ? 1e9 : -depthToViewZ(d, uNear, uFar, uRev);
  float soft = clamp((sceneZ - vViewZ) / 0.6, 0.0, 1.0);
  a *= vFade * soft * uAlpha;
  if (a < 0.002) discard;
  // a few particles glow (embers, spores)
  float glowSel = step(1.0 - uGlowAmt, fract(vSeed * 13.7));
  float flick = 0.6 + 0.4 * sin(uTime * (3.0 + vSeed * 9.0) + vSeed * 50.0);
  vec3 col = mix(uColor, uGlow * flick, glowSel);
  gl_FragColor = vec4(col * a, a * (1.0 - glowSel * 0.85));
}`;

const COPY_FRAG = /* glsl */ `uniform sampler2D tInput; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tInput, vUv); }`;

// particle looks: count scale, box (m), size (m), stretch, fall (m/s), swirl, shape (0 streak, 1 dot, 2 flake), alpha
const LOOKS = {
  rain: { n: 1.0, box: 34, size: 0.012, stretch: 55, fall: 9.5, swirl: 0.05, shape: 0, alpha: 0.32, color: [0.62, 0.68, 0.75], glow: 0 },
  snow: { n: 0.7, box: 28, size: 0.035, stretch: 0, fall: 1.1, swirl: 0.6, shape: 2, alpha: 0.85, color: [0.95, 0.97, 1.0], glow: 0 },
  snowlight: { n: 0.18, box: 30, size: 0.03, stretch: 0, fall: 0.7, swirl: 0.5, shape: 2, alpha: 0.75, color: [0.95, 0.97, 1.0], glow: 0 },
  dust: { n: 0.6, box: 30, size: 0.014, stretch: 14, fall: 0.25, swirl: 1.4, shape: 0, alpha: 0.12, color: [0.62, 0.46, 0.3], glow: 0 },
  ash: { n: 0.5, box: 32, size: 0.05, stretch: 0, fall: 0.7, swirl: 0.9, shape: 2, alpha: 0.7, color: [0.22, 0.2, 0.19], glow: 0.07 },
  spores: { n: 0.14, box: 30, size: 0.06, stretch: 0, fall: -0.12, swirl: 0.9, shape: 1, alpha: 0.9, color: [0.7, 0.9, 0.8], glow: 0.55 },
};

export default class Weather {
  static order = 88;
  constructor(level) {
    this.level = level;
    this.engine = level.engine;
    this.world = level.world;
    this.model = AtmosphereModel.get(level);
    this.ready = false;
    this.active = false;
    const A = level.aesthetic;
    this.options = (A?.weather?.length ? A.weather : ['clear']).filter((k) => KINDS[k]);
    if (!this.options.length) this.options = ['clear'];
    this.rng = new Random(seedFrom(level.planet.seed, 'weather'));
    const forced = this.engine.params.get('weather');
    this.forced = forced && KINDS[forced] ? forced : null;
    let kind = this.forced || (this.engine.shotMode ? (SHOT_WEATHER[level.planet.aesthetic] || this.options[0]) : this.options[0]);
    if (!KINDS[kind]) kind = 'clear';
    // An aesthetic without atmosphere has no weather at all.
    if (!this.model.present) kind = 'clear';
    this.kind = kind;
    this.timer = this.rng.range(240, 480);
    this.state = level.weatherState = { kind, aurora: 0, wetness: 0, precipitation: 0, fog: 0, dust: 0 };
    this.fogColor = new THREE.Color(A?.palette?.fog || '#c8d0d8');
  }

  async init() {
    this._buildParticles();
    this.ready = true;
    this._apply(this.kind, true);
  }

  _buildParticles() {
    const q = this.engine.quality;
    const maxN = q.pick(2500, 6000, 12000, 18000);
    this.maxN = maxN;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    const seeds = new Float32Array(maxN * 4);
    const rng = new Random(seedFrom(this.level.planet.seed, 'particles'));
    for (let i = 0; i < maxN * 4; i++) seeds[i] = rng.float();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = 0;
    this.pu = {
      uCam: { value: new THREE.Vector3() }, uEast: { value: new THREE.Vector3(1, 0, 0) }, uUp: { value: new THREE.Vector3(0, 1, 0) }, uNorth: { value: new THREE.Vector3(0, 0, 1) },
      uTime: { value: 0 }, uBox: { value: 30 }, uSize: { value: 0.02 }, uStretch: { value: 0 }, uFall: { value: 1 }, uSwirl: { value: 0 }, uWind: { value: new THREE.Vector3() },
      tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.1 }, uFar: { value: 1e7 }, uRev: { value: 1 },
      uColor: { value: new THREE.Vector3(1, 1, 1) }, uGlow: { value: new THREE.Vector3() }, uAlpha: { value: 0.5 }, uGlowAmt: { value: 0 }, uShape: { value: 1 },
    };
    this.pmat = new THREE.ShaderMaterial({
      vertexShader: PART_VERT, fragmentShader: PART_FRAG, uniforms: this.pu,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.points = new THREE.Mesh(geo, this.pmat);
    this.points.frustumCulled = false;
    this.pscene = new THREE.Scene();
    this.pscene.add(this.points);
    this.copyMat = new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader: COPY_FRAG, uniforms: { tInput: { value: null } }, depthTest: false, depthWrite: false });
  }

  /** Screenshot presets: pick the most telling weather for the moment (never moves the camera). */
  // (PlanetLevel stops delegating at the first subsystem that poses the camera,
  // so the choice is made from the situation each frame in shot mode instead.)
  _shotAuto() {
    const a = this.level.planet.aesthetic;
    let kind = SHOT_WEATHER[a] || this.options[0];
    const night = this.level.lighting ? this.level.lighting.night > 0.6 : false;
    if (night && a === 'pandora') kind = 'spores';
    if (!this.model.present) kind = 'clear';
    if (kind !== this.kind) this._apply(kind, true);
  }

  /** Switch weather (instant in shots, the medium eases in otherwise). */
  setKind(kind, instant = false) {
    if (!KINDS[kind]) return;
    this._apply(kind, instant);
  }

  _apply(kind, instant) {
    this.kind = kind;
    this.state.kind = kind;
    const K = KINDS[kind];
    this.target = { fog: K.fog, fogH: K.fogH, dust: K.dust, overcast: K.overcast || 0, aurora: K.aurora || 0, wet: K.wet || 0 };
    if (instant || !this.cur) this.cur = { ...this.target };
    const clouds = this.level.sys?.clouds;
    if (clouds) clouds.setPreset(K.clouds);
    else this._pendingClouds = K.clouds;
    const look = K.particles ? LOOKS[K.particles] : null;
    this.look = look;
    if (look) {
      const p = this.pu;
      p.uBox.value = look.box; p.uSize.value = look.size; p.uStretch.value = look.stretch; p.uFall.value = look.fall; p.uSwirl.value = look.swirl;
      p.uShape.value = look.shape; p.uAlpha.value = look.alpha; p.uGlowAmt.value = look.glow;
      const glow = this.level.aesthetic?.palette?.glow;
      if (kind === 'ash') p.uGlow.value.set(3.2, 0.9, 0.18);
      else if (glow) { const g = new THREE.Color(glow[0]); p.uGlow.value.set(g.r * 2.2, g.g * 2.2, g.b * 2.2); }
      else p.uGlow.value.set(1.6, 1.4, 0.8);
      this.points.geometry.instanceCount = Math.round(this.maxN * look.n);
    } else if (this.points) this.points.geometry.instanceCount = 0;
    this.active = !!look;
    // ash/dust tint the medium; fog keeps the aesthetic's fog colour
    if (kind === 'dust') this.fogColor.set(this.level.aesthetic?.palette?.fog || '#caa27a');
    if (kind === 'ash') this.fogColor.set('#5a4a42');
    this._pushMedium();
  }

  _pushMedium() {
    const c = this.cur, w = this.world;
    const focus = this.level.player?.position || this.level.camera.position;
    const groundH = w.heightAt(_v.copy(focus).normalize());
    const m = this.model;
    // fog banks hug the terrain around the player (base relative to the bottom radius)
    const base = Math.max(0, (w.radius + Math.max(groundH, w.hasOcean ? w.seaLevel : -1e9)) - m.Rb - 40);
    m.setWeather({ fog: c.fog, fogHeight: c.fogH, fogBase: base, fogColor: this.fogColor, dust: c.dust, overcast: c.overcast });
    this.state.fog = c.fog; this.state.dust = c.dust; this.state.aurora = c.aurora; this.state.wetness = c.wet;
    this.state.precipitation = this.look && (this.kind === 'rain' || this.kind === 'storm' || this.kind === 'snow') ? 1 : 0;
  }

  update(dt, t) {
    if (!this.ready) return;
    if (this.engine.shotMode && !this.forced) this._shotAuto();
    if (this._pendingClouds && this.level.sys?.clouds?.ready) { this.level.sys.clouds.setPreset(this._pendingClouds); this._pendingClouds = null; }
    // weather cycle (not in shots, not when forced)
    if (!this.engine.shotMode && !this.forced && this.options.length > 1) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.timer = this.rng.range(240, 540);
        let next = this.rng.pick(this.options);
        if (next === this.kind) next = this.rng.pick(this.options);
        this.setKind(next);
      }
    }
    // ease the medium
    const k = 1 - Math.exp(-dt / 12);
    let changed = false;
    for (const key of Object.keys(this.target)) {
      const d = this.target[key] - this.cur[key];
      if (Math.abs(d) > 1e-7) { this.cur[key] += d * k; changed = true; }
    }
    this._fogTimer = (this._fogTimer || 0) - dt;
    if (changed || this._fogTimer <= 0) { this._pushMedium(); this._fogTimer = 2; }
  }

  render(renderer, input, output, ctx) {
    this.copyMat.uniforms.tInput.value = input;
    ctx.fullscreen(this.copyMat, output);
    const p = this.pu, L = this.level, cam = ctx.cameraPosition;
    p.uCam.value.copy(cam);
    const up = p.uUp.value.copy(cam).normalize();
    const ref = Math.abs(up.y) < 0.95 ? _v.set(0, 1, 0) : _v.set(1, 0, 0);
    p.uEast.value.crossVectors(ref, up).normalize();
    p.uNorth.value.crossVectors(up, p.uEast.value).normalize();
    p.uTime.value = ctx.time;
    const w = this.world.wind, ws = this.world.windStrength;
    const windK = this.kind === 'dust' ? 9 : this.kind === 'rain' || this.kind === 'storm' ? 3.5 : 1.5;
    p.uWind.value.set(w.dot(p.uEast.value), 0, w.dot(p.uNorth.value)).multiplyScalar(ws * windK);
    p.tDepth.value = ctx.depthTexture; p.uRes.value.set(ctx.width, ctx.height);
    p.uNear.value = ctx.near; p.uFar.value = ctx.far; p.uRev.value = ctx.reversed;
    // lit by the key light + sky ambient (radiance of a small diffuse particle)
    const lt = L.lighting;
    if (lt && this.look) {
      const c = this.look.color;
      const kc = lt.keyColor, sky = lt.skyColor;
      const amb = 2.2;
      p.uColor.value.set(
        c[0] * (kc.r * 0.32 + sky.r * amb),
        c[1] * (kc.g * 0.32 + sky.g * amb),
        c[2] * (kc.b * 0.32 + sky.b * amb),
      );
    }
    const alt = this.world.altitude(cam);
    this.points.visible = alt < 400;
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(output);
    renderer.render(this.pscene, ctx.camera);
    renderer.autoClear = prevAuto;
  }

  dispose() {
    this.points?.geometry.dispose(); this.pmat?.dispose(); this.copyMat?.dispose();
  }
}

const _v = new THREE.Vector3();
