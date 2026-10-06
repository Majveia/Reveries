// Ocean, coasts & lava seas — the planet's sea at world.seaLevel.
//
//   • camera-centred spherical-cap mesh (geometric rings out to the sea horizon,
//     the whole visible disc from orbit) displaced by a 16-wave directional
//     Gerstner spectrum with deep-water dispersion (ω² = g·k), choppy crests and
//     analytic normals; per-pixel spectrum filtering into GGX roughness
//   • optics from the atmosphere model: sky-view LUT reflections, transmittance-
//     coloured sun/moon glints, Fresnel, crest SSS, depth absorption /
//     transparency from baked terrain heights (global equirect + local map
//     around the camera, baked in a worker), foam, surf, swash, caustics
//   • lava worlds: the same sea becomes a molten ocean of cooling crust plates
//     over HDR melt, plus heat haze (OceanFX)
//   • underwater: fog, tint and caustics (OceanFX), Snell's window from below
//
// Public: level.ocean = this; ocean.seaRadius, ocean.isLava,
// ocean.surfaceHeight(pos) → wave height (m) above the sea sphere at pos.
import * as THREE from 'three';
import { Random, seedFrom } from '../../../core/Random.js';
import { AtmosphereModel } from '../atmosphere/AtmosphereModel.js';
import { OCEAN_VERT, OCEAN_FRAG, NW } from './OceanShader.js';
import { detailTexture, plateTexture, foamTexture } from './OceanTextures.js';
import { bakeGlobal, bakeLocal } from './heightBake.js';
import { createTerrain } from '../terrain/TerrainHeight.js';
import { OceanFX } from './OceanFX.js';

const TAU = Math.PI * 2;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _q = new THREE.Quaternion();

function toHalf(f32) {
  const out = new Uint16Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = THREE.DataUtils.toHalfFloat(Math.max(-60000, Math.min(60000, f32[i])));
  return out;
}

export default class Ocean {
  static order = 40;

  constructor(level) {
    this.level = level;
    this.engine = level.engine;
    this.world = level.world;
    this.effects = [];
    this.enabled = false;
    level.ocean = this;
  }

  async init(progress) {
    const w = this.world, level = this.level, P = level.planet;
    if (!w.hasOcean) return;
    this.enabled = true;
    this.isLava = P.kind === 'lava' || level.planet.aesthetic === 'inferno';
    this.seaRadius = w.radius + w.seaLevel;
    this.model = level.atmoModel || AtmosphereModel.get(level);
    const q = this.engine.quality, shot = this.engine.shotMode;
    const pal = level.aesthetic?.palette || w.palette || {};

    // ---- anchor frame (wave plane) ----
    const startDir = (w.sites[0]?.dir || new THREE.Vector3(0.3, 0.5, 0.8)).clone().normalize();
    this.anchorU = startDir.clone();
    this.anchor = startDir.clone().multiplyScalar(this.seaRadius);
    const ref = Math.abs(startDir.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    this.T1 = ref.clone().cross(startDir).normalize();
    this.T2 = this.T1.clone().cross(startDir).normalize();
    this.anchorGen = 0;

    // ---- wave spectrum ----
    this._buildSpectrum();
    progress?.(0.1);

    // ---- textures ----
    this.tDetail = detailTexture(seedFrom(P.seed, 'oceanDetail'));
    this.tFoam = foamTexture(seedFrom(P.seed, 'oceanFoam'));
    this.tPlates = this.isLava ? plateTexture(seedFrom(P.seed, 'lavaPlates')) : null;
    progress?.(0.25);

    // ---- terrain height maps ----
    this.gw = shot ? 1024 : q.pick(256, 512, 1024, 1024);
    this.gh = this.gw / 2;
    this.localN = shot ? 256 : q.pick(128, 160, 256, 256);
    this.localExtent = 1400; // half span (m)
    this._jobs = new Map(); this._jobId = 0;
    this._initWorker();
    let gdata = null;
    if (this.worker && !shot) {
      try { gdata = await Promise.race([this._job({ type: 'global', w: this.gw, h: this.gh }), new Promise((r) => setTimeout(() => r(null), 12000))]); }
      catch (e) { console.warn('[ocean] global bake failed in worker', e); }
    }
    if (!gdata) gdata = bakeGlobal(this._terrain(), w.seaLevel, this.gw, this.gh);
    this.tGlobal = new THREE.DataTexture(toHalf(gdata), this.gw, this.gh, THREE.RedFormat, THREE.HalfFloatType);
    Object.assign(this.tGlobal, { wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false, needsUpdate: true });
    this.tLocal = new THREE.DataTexture(new Uint16Array(8), 2, 2, THREE.RGFormat, THREE.HalfFloatType);
    Object.assign(this.tLocal, { magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false, needsUpdate: true });
    this.localCenter = new THREE.Vector2(1e9, 1e9);
    this.localPending = false;
    progress?.(0.7);

    // ---- mesh ----
    this.rings = shot ? 256 : q.pick(96, 144, 200, 256);
    this.segs = shot ? 384 : q.pick(128, 192, 300, 384);
    this.mesh = new THREE.Mesh(this._capGeometry(this.rings, this.segs), this._material(pal));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'ocean';
    level.scene.add(this.mesh);

    this.fx = new OceanFX(this);
    this.effects = [this.fx];
    this.under = false;
    progress?.(1);
  }

  // ------------------------------------------------------------------------------
  _terrain() { return this._T || (this._T = this.world.terrain || createTerrain(this.world.terrainParams)); }

  _initWorker() {
    try {
      const wk = new Worker(new URL('./HeightWorker.js', import.meta.url), { type: 'module' });
      wk.onmessage = (e) => {
        const m = e.data;
        const j = this._jobs.get(m.id);
        if (!j) return;
        this._jobs.delete(m.id);
        if (m.type === 'done') j.resolve(m.data); else j.reject(new Error(m.message));
      };
      wk.onerror = (e) => { console.warn('[ocean] height worker error', e.message || e); this.worker = null; for (const j of this._jobs.values()) j.reject(e); this._jobs.clear(); };
      wk.postMessage({ type: 'init', params: this.world.terrainParams, sea: this.world.seaLevel });
      this.worker = wk;
    } catch (e) { this.worker = null; }
  }

  _job(msg) {
    return new Promise((resolve, reject) => {
      const id = ++this._jobId;
      this._jobs.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  _buildSpectrum() {
    const w = this.world, P = this.level.planet;
    const rng = new Random(seedFrom(P.seed, 'oceanWaves'));
    const lava = this.isLava;
    // wind direction in the anchor plane
    const wd = w.wind;
    const wa = Math.atan2(wd.dot(this.T2), wd.dot(this.T1)) || 0;
    this.windAngle = wa;
    const lamMax = lava ? 38 : rng.range(44, 64);
    const lamMin = lava ? 2.5 : 0.75;
    const lamP = lava ? 22 : lamMax * 0.55;
    const total = lava ? 0.16 : 0.74;
    const waves = [];
    let ssum = 0;
    for (let i = 0; i < NW; i++) {
      const f = i / (NW - 1);
      const lam = lamMax * Math.pow(lamMin / lamMax, f) * rng.range(0.92, 1.08);
      const k = TAU / lam;
      const spread = 0.28 + 0.95 * f;
      const ang = wa + (i % 2 ? 1 : -1) * spread * rng.range(0.15, 1.0) + rng.range(-0.1, 0.1);
      const s = lam >= lamP ? Math.exp(-Math.pow(Math.log(lam / lamP), 2) / 0.45) : 0.4 + 0.6 * Math.pow(lam / lamP, 0.35);
      ssum += s;
      const omega = Math.sqrt(w.gravity * k) * (lava ? 0.16 : 1);
      waves.push({ dx: Math.cos(ang), dz: Math.sin(ang), k, s, omega, base: rng.float() * TAU });
    }
    this.maxAmp = 0;
    for (const wv of waves) { wv.s *= total / ssum; wv.a = wv.s / wv.k; this.maxAmp += wv.a; }
    this.waves = waves;
    this.uWave = waves.map((wv) => new THREE.Vector4(wv.dx, wv.dz, wv.k, wv.a));
    this.uPhase = waves.map(() => 0);
  }

  _capGeometry(N, M) {
    const pos = new Float32Array((N + 1) * (M + 1) * 3);
    let o = 0;
    for (let i = 0; i <= N; i++) for (let j = 0; j <= M; j++) { pos[o++] = i / N; pos[o++] = (j / M) * TAU; pos[o++] = 0; }
    const idx = new Uint32Array(N * M * 6);
    o = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) {
      const a = i * (M + 1) + j, b = a + 1, c = a + M + 1, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), this.seaRadius * 2);
    return g;
  }

  _material(pal) {
    const w = this.world, lava = this.isLava;
    const lin = (hex, d) => new THREE.Color(hex || d);
    const water = lin(pal.water, '#2a6a8a');
    const sand = lin(pal.sand, '#d8c8a0');
    // deep body albedo: the palette's water, darkened (open ocean reflects ~3-6 %)
    const deep = water.clone().multiplyScalar(0.11);
    deep.lerp(new THREE.Color(0.004, 0.02, 0.05), 0.25);
    // shallow: turquoise over sand
    const shallow = new THREE.Color(0.04, 0.3, 0.3).lerp(water, 0.25).multiplyScalar(0.4);
    const sss = new THREE.Color(0.08, 0.55, 0.42).lerp(water, 0.2);
    const u = this.uniforms = {
      ...this.model.uniforms,
      uTime: w.uniforms.uTime,
      uWave: { value: this.uWave }, uPhase: { value: this.uPhase }, uChop: { value: lava ? 0.4 : 1.25 },
      uRs: { value: this.seaRadius },
      uAnchor: { value: this.anchor }, uT1: { value: this.T1 }, uT2: { value: this.T2 },
      tGlobal: { value: this.tGlobal }, tLocal: { value: this.tLocal }, uLocal: { value: new THREE.Vector4(0, 0, 1, 0) },
      uSwash: { value: lava ? 0.05 : 0.22 }, uWaveScale: { value: 1 },
      uSurf: { value: new THREE.Vector4(1, 30, TAU / 8.5, lava ? 0 : 1) },
      uCapU: { value: new THREE.Vector3(0, 1, 0) }, uCapE: { value: new THREE.Vector3(1, 0, 0) }, uCapN: { value: new THREE.Vector3(0, 0, 1) },
      uCapD0: { value: 1 }, uCapDmax: { value: 1000 }, uRings: { value: this.rings }, uSegs: { value: this.segs },
      tDetail: { value: this.tDetail }, tFoam: { value: this.tFoam }, tPlates: { value: this.tPlates || this.tDetail },
      uDetail: { value: new THREE.Vector4(Math.cos(this.windAngle), Math.sin(this.windAngle), 0.22, 0) },
      uPixelAngle: { value: 0.002 }, uLutW: { value: 0 }, uUseTrans: { value: 0 },
      uSkyZenith: { value: new THREE.Color() }, uSkyHorizon: { value: new THREE.Color() }, uSkyIrr: { value: new THREE.Color() },
      uDeep: { value: deep }, uShallow: { value: shallow }, uSSS: { value: sss },
      uAbsorb: { value: new THREE.Vector3(0.42, 0.075, 0.055) }, uBed: { value: sand.clone().multiplyScalar(0.5) },
      uMaxAmp: { value: this.maxAmp }, uFoam: { value: 0.62 }, uSparkle: { value: 1 }, uUnder: { value: 0 },
      uBio: { value: new THREE.Vector4(0, 0, 0, 0) },
      uLava: { value: new THREE.Vector4(70, 0.35, 1.0, 14.0) },
      tSunVis: { value: null }, uSunVisM: { value: new THREE.Matrix4() }, uSunVisOn: { value: 0 }, uSunVisParams: { value: new THREE.Vector4() },
    };
    this._pal = { zenith: lin(pal.zenith, '#3b6dd8'), horizon: lin(pal.horizon, '#cfe4ff') };
    // bioluminescent worlds: the surf glows at dusk and by night
    const A = this.level.aesthetic;
    this._bio = !lava && A && (A.flora === 'bioluminescent' || /biolum/.test(A.mood || '')) ? lin((pal.glow && pal.glow[0]) || pal.accent, '#38f6ff') : null;
    const m = new THREE.ShaderMaterial({
      vertexShader: OCEAN_VERT, fragmentShader: OCEAN_FRAG, uniforms: u,
      defines: Object.assign(lava ? { LAVA: 1 } : {}, { ODBG: +(this.engine.params?.get?.('odbg') || 0) }),
      side: THREE.DoubleSide, depthWrite: true, depthTest: true,
      transparent: !lava,
    });
    if (!lava) {
      m.blending = THREE.CustomBlending;
      m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
      m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    }
    m.extensions = { derivatives: true };
    return m;
  }

  // ------------------------------------------------------------------------------
  /** Plane coords (anchor frame) of a world position projected on the sea sphere. */
  _planeXZ(pos, out = new THREE.Vector2()) {
    const p = _v3.copy(pos).setLength(this.seaRadius).sub(this.anchor);
    return out.set(p.dot(this.T1), p.dot(this.T2));
  }

  /** Wave height (m) above the sea sphere at a world position (deep-water approx). */
  surfaceHeight(pos) {
    if (!this.enabled) return -Infinity;
    const xz = this._planeXZ(pos, this._xz || (this._xz = new THREE.Vector2()));
    let h = 0;
    const sc = this.uniforms.uWaveScale.value;
    for (let i = 0; i < NW; i++) { const wv = this.waves[i]; h += wv.a * Math.sin(wv.k * (wv.dx * xz.x + wv.dz * xz.y) + this.uPhase[i]); }
    return h * sc;
  }

  _reanchor(nadirDir) {
    // parallel-transport the frame, keep every wave's phase continuous at the new anchor
    const oldXZ = this._planeXZ(_v.copy(nadirDir).multiplyScalar(this.seaRadius), new THREE.Vector2());
    _q.setFromUnitVectors(this.anchorU, nadirDir);
    this.T1.applyQuaternion(_q);
    this.T1.addScaledVector(nadirDir, -this.T1.dot(nadirDir)).normalize();
    this.T2.copy(this.T1).cross(nadirDir).normalize();
    this.anchorU.copy(nadirDir);
    this.anchor.copy(nadirDir).multiplyScalar(this.seaRadius);
    for (const wv of this.waves) wv.base = (wv.base + wv.k * (wv.dx * oldXZ.x + wv.dz * oldXZ.y)) % TAU;
    this.anchorGen++;
    this.uniforms.uLocal.value.w = 0;
    this.localCenter.set(1e9, 1e9);
    this.localPending = false;
  }

  _requestLocal(cx, cz) {
    const n = this.localN, ext = this.localExtent;
    const msg = { n, A: this.anchor.toArray(), T1: this.T1.toArray(), T2: this.T2.toArray(), U: this.anchorU.toArray(), Rs: this.seaRadius, cx, cz, extent: ext };
    const apply = (data) => {
      const t = this.tLocal;
      if (t.image.width !== n) { t.dispose(); this.tLocal = new THREE.DataTexture(toHalf(data), n, n, THREE.RGFormat, THREE.HalfFloatType); Object.assign(this.tLocal, { magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping }); this.uniforms.tLocal.value = this.tLocal; }
      else t.image.data = toHalf(data);
      this.tLocal.needsUpdate = true;
      this.uniforms.uLocal.value.set(cx, cz, 1 / (2 * ext), 1);
      this.localCenter.set(cx, cz);
    };
    if (this.engine.shotMode || !this.worker) { apply(bakeLocal(this._terrain(), this.world.seaLevel, msg)); return; }
    const gen = this.anchorGen;
    this.localPending = true;
    this._job({ type: 'local', ...msg }).then((data) => { this.localPending = false; if (gen === this.anchorGen) apply(data); })
      .catch(() => { this.localPending = false; });
  }

  update(dt, t) {
    if (!this.enabled) return;
    const w = this.world, cam = this.level.camera, u = this.uniforms;
    cam.updateMatrixWorld();
    const cp = cam.position;
    const r = cp.length();
    const nadir = _v2.copy(cp).normalize();
    const alt = r - this.seaRadius;

    // re-anchor the wave plane when the camera has travelled far from it
    const far = nadir.angleTo(this.anchorU) * this.seaRadius;
    if (far > (alt > 1500 ? 2500 : 4000)) this._reanchor(nadir.clone());

    // wave phases (CPU, double precision, wrapped)
    const time = t;
    for (let i = 0; i < NW; i++) { const wv = this.waves[i]; this.uPhase[i] = ((wv.base - wv.omega * time) % TAU + TAU) % TAU; }
    const ws = w.windStrength ?? 0.5;
    u.uWaveScale.value = this.isLava ? 1 : 0.85 + 0.5 * ws;
    u.uDetail.value.z = this.isLava ? 0.1 : 0.2 + 0.15 * ws;
    u.uDetail.value.w = time;
    u.uSurf.value.x = 0.55 + 0.9 * ws;

    // cap: the visible sea disc
    const ref = Math.abs(nadir.y) < 0.95 ? _v.set(0, 1, 0) : _v.set(1, 0, 0);
    u.uCapU.value.copy(nadir);
    u.uCapE.value.copy(ref).cross(nadir).normalize();
    u.uCapN.value.copy(nadir).cross(u.uCapE.value).normalize();
    const Rs = this.seaRadius, A4 = 4 * this.maxAmp * 1.3 + 2;
    const h = Math.max(Math.abs(alt), 0.5);
    const th = Math.acos(Math.min(1, Rs / (Rs + h + A4))) + Math.acos(Math.min(1, Rs / (Rs + A4)));
    const dmax = Math.max(400, Math.min(Rs * th * 1.04 + 60, Rs * Math.PI * 0.5));
    u.uCapDmax.value = dmax;
    u.uCapD0.value = Math.min(Math.max(h * 0.5, 0.5), dmax * 0.5);

    // local terrain map
    if (alt < 4000) {
      const c = this._planeXZ(cp, this._c2 || (this._c2 = new THREE.Vector2()));
      const snap = this.localExtent / 16;
      const cx = Math.round(c.x / snap) * snap, cz = Math.round(c.y / snap) * snap;
      if (!this.localPending && (Math.abs(cx - this.localCenter.x) > this.localExtent * 0.3 || Math.abs(cz - this.localCenter.y) > this.localExtent * 0.3)) this._requestLocal(cx, cz);
    }

    // optics
    const rt = this.engine.renderer;
    const hpx = rt.domElement.height || 1080;
    u.uPixelAngle.value = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5) / hpx;
    const m = this.model;
    const lutOK = !!(m.ready && m.present && m.uniforms.tSkyView.value);
    u.uLutW.value = lutOK ? 1 - 0.5 * THREE.MathUtils.smoothstep(alt, m.thickness * 0.3, m.thickness) : 0;
    u.uUseTrans.value = m.ready && m.uniforms.tTransmittance.value ? 1 : 0;
    const L = this.level.lighting;
    const sky = L?.skyColor || _v.set(0.3, 0.45, 0.7);
    u.uSkyIrr.value.setRGB(sky.r * Math.PI, sky.g * Math.PI, sky.b * Math.PI);
    const k = 0.02 + 0.9 * w.daylight;
    u.uSkyZenith.value.copy(this._pal.zenith).multiplyScalar(k);
    u.uSkyHorizon.value.copy(this._pal.horizon).multiplyScalar(k);
    u.uSparkle.value = this.engine.quality.level >= 1 ? 1 : 0;
    if (this._bio) {
      const night = 1 - THREE.MathUtils.smoothstep(w.daylight, 0.04, 0.55);
      u.uBio.value.set(this._bio.r, this._bio.g, this._bio.b, 1.6 * night);
    }

    // far terrain sun shadow (shared with the terrain material)
    const ter = this.level.sys?.terrain, tu = ter?.uniforms;
    if (tu?.tSunVis && tu.tSunVis.value && ter.sunShadow?.matrix) {
      u.tSunVis.value = tu.tSunVis.value;
      u.uSunVisOn.value = tu.uSunVisOn?.value ?? 0;
      u.uSunVisParams.value.copy(tu.uSunVisParams.value);
      u.uSunVisM.value.copy(ter.sunShadow.matrix);
    } else u.uSunVisOn.value = 0;

    // underwater?
    this.under = !this.isLava && alt < this.surfaceHeight(cp) - 0.05;
    u.uUnder.value = this.under ? 1 : 0;
  }

  // ------------------------------------------------------------------------------
  /** Screenshot preset: a coast at golden hour, the sea toward the sun. */
  async shot(name, spot) {
    if (name !== 'ocean' || !this.enabled) return false;
    const pose = this._findCoast();
    if (!pose) return false;
    const w = this.world, level = this.level;
    w.setTimeOfDay(pose.time, pose.dir);
    level.freeCam = { position: pose.position, target: pose.target, up: pose.dir.clone() };
    level.player?.shotPose && (level.player.shotPose = null);
    void spot;
    return true;
  }

  _findCoast() {
    // Golden-hour beach: camera a few metres above the sand at the waterline,
    // looking out over open sea toward a low sun (glitter path through the
    // frame), the shore sweeping in from one side, surf in the foreground.
    const w = this.world, R = w.radius, sea = w.seaLevel;
    const sites = w.sites.length ? w.sites : [{ dir: new THREE.Vector3(0.3, 0.5, 0.8).normalize() }];
    const lava = this.isLava;
    const cands = [];
    const tg1 = new THREE.Vector3(), tg2 = new THREE.Vector3(), d = new THREE.Vector3(), p = new THREE.Vector3();
    const offs = (up, fwd, side, along, lateral, out) => out.copy(up).multiplyScalar(R).addScaledVector(fwd, along).addScaledVector(side, lateral).normalize();
    const step = 30;
    const H = (dir) => w.heightAt(dir);
    // sun time: the moment the sun stands ~6–9° over the horizon at dir
    const goldenTime = (dir) => {
      let best = lava ? 0.76 : 0.72, be = 1e9;
      for (let t = 0.66; t <= 0.8; t += 0.005) {
        w.setTimeOfDay(t, dir);
        const el = Math.asin(THREE.MathUtils.clamp(w.sunDir.dot(dir), -1, 1));
        const e = Math.abs(el - (lava ? 0.25 : 0.13));
        if (e < be) { be = e; best = t; }
      }
      w.setTimeOfDay(best, dir);
      return best;
    };
    for (const s of sites.slice(0, 8)) {
      const base = s.dir.clone().normalize();
      tg1.set(0, 1, 0).cross(base).normalize(); tg2.copy(base).cross(tg1).normalize();
      for (let a = 0; a < 36; a++) {
        const ang = (a / 36) * TAU;
        const g = tg1.clone().multiplyScalar(Math.cos(ang)).addScaledVector(tg2, Math.sin(ang));
        let lastLand = null;
        for (let i = 3; i < 120; i++) {
          d.copy(base).addScaledVector(g, (i * step) / R).normalize();
          const h = H(d);
          if (h > sea + 0.6) { lastLand = i * step; continue; }
          if (h < sea - 0.5 && lastLand !== null && i * step - lastLand < 70) {
            // walk back to the waterline: lowest dry point, 0.3–2.5 m above the sea
            let camD = null;
            for (let b = 0; b <= 20; b++) {
              const dd = i * step - b * 3;
              p.copy(base).addScaledVector(g, dd / R).normalize();
              const hh = H(p);
              if (hh > sea + 0.3 && hh < sea + (lava ? 2.5 : 1.4)) { camD = { dir: p.clone(), h: hh, dist: dd }; break; }
            }
            if (!camD) break;
            const up = camD.dir;
            const seaH = g.clone().addScaledVector(up, -g.dot(up)).normalize();
            // a beach, not a cliff: gentle ground 40 m inland, gentle seabed 40 m out
            p.copy(up).multiplyScalar(R).addScaledVector(seaH, -40).normalize();
            const inland = H(p) - camD.h;
            p.copy(up).multiplyScalar(R).addScaledVector(seaH, 40).normalize();
            const seabed = camD.h - H(p);
            const slope = Math.max(0, inland) / 40 + Math.max(0, seabed - 6) / 40;
            const t = goldenTime(up);
            const sunH = w.sunDir.clone().addScaledVector(up, -w.sunDir.dot(up)).normalize();
            cands.push({ dir: up.clone(), h: camD.h, seaH, sunH, t, slope });
            break;
          }
          if (h < sea - 0.5) break;
        }
      }
    }
    if (!cands.length) return null;
    // score each candidate × yaw: open sea in the frame, sun inside the frame,
    // some coast at one edge for depth
    const side = new THREE.Vector3(), fwd = new THREE.Vector3();
    let best = null;
    for (const c of cands) {
      const up = c.dir;
      w.setTimeOfDay(c.t, up);
      for (const yawDeg of [-22, -14, -7, 0, 7, 14, 22]) {
        const yaw = THREE.MathUtils.degToRad(yawDeg);
        // look = sun azimuth rotated by yaw (water only: lava looks seaward)
        const baseDir = lava ? c.seaH : c.sunH;
        fwd.copy(baseDir).applyAxisAngle(up, yaw).normalize();
        side.copy(fwd).cross(up).normalize();
        let water = 0, n = 0, landL = 0, landR = 0;
        for (const fa of [-26, -13, 0, 13, 26]) {
          const ca = Math.cos(THREE.MathUtils.degToRad(fa)), sa = Math.sin(THREE.MathUtils.degToRad(fa));
          for (const dist of [70, 180, 420, 900, 2000, 4000]) {
            offs(up, fwd, side, dist * ca, dist * sa, p);
            const wet = H(p) < sea - 0.3;
            water += wet ? 1 : 0; n++;
          }
        }
        for (const dist of [60, 200, 600]) {
          const ca = Math.cos(0.75), sa = Math.sin(0.75);
          if (H(offs(up, fwd, side, dist * ca, -dist * sa, p)) > sea + 0.5) landL++;
          if (H(offs(up, fwd, side, dist * ca, dist * sa, p)) > sea + 0.5) landR++;
        }
        const wf = water / n;
        const sunIn = lava ? 1 : Math.max(0, Math.cos(yaw));
        const edge = (landL > 0) !== (landR > 0) ? 1 : 0;
        // the shoreline should run diagonally through the frame (beach on one
        // side, open sea and sun on the other): ~40° between view and shore normal
        const offShore = Math.acos(THREE.MathUtils.clamp(c.seaH.dot(fwd), -1, 1));
        const diag = lava ? 0 : 1 - Math.min(1, Math.abs(offShore - 0.7) / 0.7);
        const score = wf * 6 + sunIn * 3 + edge * 1.5 + diag * 2 - c.slope * 10 - Math.abs(yawDeg) * 0.02 + (lava ? 2 * Math.max(0, c.seaH.dot(fwd)) : 0);
        if (!best || score > best.score) best = { score, c, fwd: fwd.clone() };
      }
    }
    // the sun must actually be visible over the sea (not behind a headland)
    const camH = lava ? 7.5 : 2.2;
    if (!lava) {
      const ranked = [];
      for (const c of cands) ranked.push(c);
      w.setTimeOfDay(best.c.t, best.c.dir);
      const pos = best.c.dir.clone().multiplyScalar(R + best.c.h + camH);
      if (w.raycast(pos, w.sunDir.clone(), 8000)) {
        // try the next-best candidates with the sun in view
        let alt = null;
        for (const c of cands) {
          if (c === best.c) continue;
          w.setTimeOfDay(c.t, c.dir);
          const pp = c.dir.clone().multiplyScalar(R + c.h + camH);
          if (w.raycast(pp, w.sunDir.clone(), 8000)) continue;
          const sc = -c.slope * 10 + Math.max(0, c.seaH.dot(c.sunH)) * 4;
          if (!alt || sc > alt.sc) alt = { sc, c };
        }
        if (alt) best = { c: alt.c, fwd: alt.c.sunH.clone().applyAxisAngle(alt.c.dir, THREE.MathUtils.degToRad(12)) };
      }
    }
    let up = best.c.dir;
    w.setTimeOfDay(best.c.t, up);
    let position = up.clone().multiplyScalar(R + best.c.h + camH);
    if (!lava) {
      // wade into the surf a few metres off the beach (the dune grass stays
      // behind the lens): breakers roll in around the camera, the shore sweeps
      // away diagonally on one side, the glitter path runs out to a low sun
      const sh = best.c.seaH;
      for (const out of [12, 18, 8, 26]) {
        const pd = up.clone().multiplyScalar(R).addScaledVector(sh, out).normalize();
        if (w.heightAt(pd) < sea - 0.25) { up = pd; position = pd.clone().multiplyScalar(R + sea + 1.9); break; }
      }
    }
    const target = position.clone().addScaledVector(best.fwd, 200).addScaledVector(up, lava ? -30 : -21);
    return { position, target, dir: up, time: best.c.t };
  }

  onModeChange() {}

  dispose() {
    this.worker?.terminate();
    this.mesh?.geometry.dispose();
    this.mesh?.material.dispose();
    this.tDetail?.dispose(); this.tFoam?.dispose(); this.tPlates?.dispose(); this.tGlobal?.dispose(); this.tLocal?.dispose();
    this.fx?.dispose();
    if (this.level.ocean === this) this.level.ocean = null;
  }
}
