// Flora — the living layer of a world: grass & wildflowers, trees & giant
// plants, rocks & boulders, and colossal landmark trees.
//
//   • Everything is placed deterministically on cube-sphere cells (planet seed
//     + cell coords) and streamed in rings around the camera (grass 8 m cells,
//     rocks 48 m, trees 128 m with mesh → impostor LOD out to the horizon).
//   • Floating origin: all flora lives in one group positioned at a snapped
//     anchor near the camera, so instance data stays small and precise on a
//     70 km planet; the anchor hops every 256 m and instances are repacked.
//   • Look comes from aesthetic.flora (profiles.js) and the world palette;
//     placement follows world.terrain.sample (moisture, temperature, rock,
//     snow, sand, rivers, biome), avoids water (reeds at the shore), steep
//     slopes (rocks instead) and settlement interiors (clearings).
//   • Lighting: every plant is a patched MeshStandardMaterial (sun, sky IBL,
//     shadows) plus backlit translucency from level.lighting.keyDir/keyColor
//     and HDR bioluminescence at night.
import * as THREE from 'three';
import { seedFrom } from '../../../core/Random.js';
import { floraProfile } from './profiles.js';
import { Grass } from './grass.js';
import { Trees } from './trees.js';
import { Rocks } from './rocks.js';
import { Motes } from './motes.js';

const ANCHOR_SNAP = 256;
// per-shot flora stats in the harness console: --extra "florastats=1"
const FLORA_STATS = typeof location !== 'undefined' && /[?&]florastats=/.test(location.search);
const _v = new THREE.Vector3(), _cam = new THREE.Vector3();

export default class Flora {
  static order = 50;

  constructor(level) {
    this.level = level;
    this.world = level.world;
    this.engine = level.engine;
    this.aesthetic = level.aesthetic;
    this.kind = this.aesthetic?.flora || 'lush';
    this.seed = seedFrom(level.planet.seed, 'flora') >>> 0;
    this.profile = floraProfile(this.kind, this.aesthetic);
    this.group = new THREE.Group();
    this.group.name = 'flora';
    this.anchor = new THREE.Vector3();
    this.reanchored = false;
    this.uniforms = {
      uAnchor: { value: this.anchor },
      uKeyColor: { value: new THREE.Color(1, 1, 1) },
      uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
      uNight: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uPlayer: { value: new THREE.Vector3(1e9, 0, 0) },
      uDitherT: { value: 0 }, // per-frame dither offset (TAA resolves crossfades)
      // nearest glowing trees (xyz rel. anchor, w = pool radius m): light pools
      // on the grass beneath bioluminescent crowns at night
      uGlowPts: { value: Array.from({ length: 16 }, () => new THREE.Vector4(1e9, 0, 0, 1)) },
    };
    this.noiseScale = { patch: 1 / 9, color: 1 / 46, flower: 1 / 30, forest: 1 / 240 };
    // view cone for instance culling (grass cells, tree / rock instances): the
    // camera frustum's bounding cone + a margin larger than the re-pack trigger,
    // so turning the camera never reveals an empty edge before the next pack
    this.view = { on: false, fwd: new THREE.Vector3(0, 0, -1), packFwd: new THREE.Vector3(), half: Math.PI, near: 14, changed: true, shadow: new THREE.Vector3(), sinAlt: 1 };
    this.sites = this.world.sites || [];
    this.parts = [];
  }

  async init(progress) {
    if (!this.profile) return; // barren world
    this.level.scene.add(this.group);
    this.level.flora = this;
    this.level.floraClear = (pos, r) => this.clear(pos, r);
    const q = this.engine.quality;
    const P = this.profile;
    const steps = [];
    if (P.grass && q.level >= 0) steps.push(['grass', () => (this.grass = new Grass(this))]);
    if (P.trees) steps.push(['trees', () => (this.trees = new Trees(this))]);
    if (P.rocks) steps.push(['rocks', () => (this.rocks = new Rocks(this))]);
    for (const m of P.motes || []) steps.push(['motes', () => { const x = new Motes(this, m); (this.motes ||= []).push(x); return x; }]);
    let k = 0;
    for (const [name, make] of steps) {
      try { const p = make(); p.init(); this.parts.push(p); }
      catch (e) { console.warn(`[flora] ${name} failed:`, e); this[name] = null; }
      progress?.(++k / steps.length);
      await new Promise((r) => setTimeout(r, 0));
    }
    this._first = true;
  }

  /**
   * 0 inside a settlement's built-up core → 1 in the open land around it
   * (k scales the cleared radius). site.radius is the settlement's whole
   * zone; houses occupy roughly its inner half, fields and gardens the rest.
   */
  siteClear(x, y, z, k = 1) {
    let c = 1;
    for (const s of this.sites) {
      const dx = x - s.position.x, dy = y - s.position.y, dz = z - s.position.z;
      const d2 = dx * dx + dy * dy + dz * dz, r = s.radius * k;
      if (d2 > r * r * 0.5) continue;
      c = Math.min(c, THREE.MathUtils.smoothstep(Math.sqrt(d2), r * 0.42, r * 0.62));
    }
    return c;
  }

  _syncLight() {
    const L = this.level.lighting, U = this.uniforms;
    if (L) {
      U.uKeyColor.value.copy(L.keyColor);
      U.uKeyDir.value.copy(L.keyDir);
      U.uNight.value = L.night ?? (1 - this.world.daylight);
    } else {
      U.uKeyDir.value.copy(this.world.sunDir);
      U.uNight.value = 1 - this.world.daylight;
    }
  }

  _updateView(cam) {
    const V = this.view;
    cam.getWorldDirection(V.fwd);
    const tv = Math.tan(THREE.MathUtils.degToRad(cam.fov || 60) * 0.5), th = tv * (cam.aspect || 1);
    V.half = Math.atan(Math.hypot(tv, th)) + 0.32; // diagonal half-angle + ~18° margin
    V.on = V.half < 2.6;
    V.changed = V.packFwd.dot(V.fwd) < Math.cos(0.2); // re-pack after ~11° of rotation
    if (V.changed) V.packFwd.copy(V.fwd);
    // shadows fall along -keyDir: casters outside the cone can shade what is inside it
    const kd = this.uniforms.uKeyDir.value, up = _v.copy(cam.position).normalize();
    V.sinAlt = Math.max(0.12, kd.dot(up));
    V.shadow.copy(kd).multiplyScalar(-1 / V.sinAlt);
  }

  /** Is a sphere (offset from the camera, radius r) inside the culling cone? */
  inView(dx, dy, dz, r, near = this.view.near) {
    const V = this.view;
    if (!V.on) return true;
    const d2 = dx * dx + dy * dy + dz * dz, nr = near + r;
    if (d2 < nr * nr) return true;
    const d = Math.sqrt(d2);
    const c = (dx * V.fwd.x + dy * V.fwd.y + dz * V.fwd.z) / d;
    return Math.acos(c > 1 ? 1 : c < -1 ? -1 : c) <= V.half + Math.asin(Math.min(1, r / d));
  }

  /** Like inView, but also keeps casters whose shadow (height h) reaches into the cone. */
  castsInView(dx, dy, dz, r, h) {
    if (this.inView(dx, dy, dz, r)) return true;
    const S = this.view.shadow, L = Math.min(h, 160 * this.view.sinAlt);
    return this.inView(dx + S.x * L * 0.5, dy + S.y * L * 0.5, dz + S.z * L * 0.5, r + L * 0.3) || this.inView(dx + S.x * L, dy + S.y * L, dz + S.z * L, r);
  }

  update() {}

  /** Plant world-species trees for other modules (see Trees.plant). */
  plant(list) { try { return this.trees?.plant(list) || 0; } catch (e) { this._err('plant', e); return 0; } }

  // 'flora' screenshot preset: the landmark tree from ~170 m across its
  // meadow (forest, undergrowth and rocks in the foreground)
  /** Keep trees out of a sphere (vehicles, cameras, set pieces): level.floraClear(pos, r). */
  clear(pos, r) { (this.clearZones ||= []).push({ p: pos.clone(), r2: r * r }); if (this.trees?.layer) this.trees.layer.dirty = true; }

  // true when a tree base at (x,y,z) sits in a cleared zone or the shot sightline
  blocked(x, y, z) {
    const S = this.sight;
    if (S) {
      const dx = x - S.a.x, dy = y - S.a.y, dz = z - S.a.z;
      const t = Math.max(0, Math.min(S.len, dx * S.d.x + dy * S.d.y + dz * S.d.z));
      const ex = dx - S.d.x * t, ey = dy - S.d.y * t, ez = dz - S.d.z * t, r = S.r0 + S.k * t;
      if (t < S.len - S.stop && ex * ex + ey * ey + ez * ez < r * r) return true;
    }
    for (const Z of this.clearZones || []) { const dx = x - Z.p.x, dy = y - Z.p.y, dz = z - Z.p.z; if (dx * dx + dy * dy + dz * dz < Z.r2) return true; }
    return false;
  }

  shot(name, spot) {
    this.sight = null;
    if (name !== 'flora' || !this.trees?.landmark) return false;
    const w = this.world, L = this.trees.landmark;
    const up = L.position.clone().normalize();
    const away = spot.position.clone().sub(L.position); away.addScaledVector(up, -away.dot(up)).normalize();
    const side = away.clone().cross(up).normalize();
    const dist = Math.max(150, L.height * 1.9);
    let best = null;
    for (let k = 0; k < 12; k++) {
      const a = (k % 2 ? 1 : -1) * Math.floor((k + 1) / 2) * 0.3;
      const d = away.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
      const dir = L.position.clone().addScaledVector(d, dist).normalize();
      const h = w.heightAt(dir);
      if (w.hasOcean && h < w.seaLevel + 1) continue;
      const n = w.normalAt(dir).dot(dir);
      if (!best || n > best.n) best = { dir, h, n };
      if (n > 0.97) break;
    }
    if (!best) return false;
    const pos = best.dir.clone().multiplyScalar(w.radius + best.h + 1.8);
    const tgt = L.position.clone().addScaledVector(up, L.height * 0.42);
    this.level.freeCam = { position: pos, target: tgt };
    // a meadow opens between the lens and the giant: no ordinary tree may
    // stand in the sightline cone (it widens toward the landmark's crown)
    const base = L.position.clone(), d = base.clone().sub(pos), len = d.length();
    this.sight = { a: pos.clone(), d: d.normalize(), len, r0: 6, k: Math.max(0.1, (L.crown || L.height * 0.5) / len), stop: 0 };
    if (this.trees.layer) this.trees.layer.dirty = true;
    return true;
  }

  // Night on a bioluminescent world: two glowing groves flank the sky-first
  // sightline (Pandora framing), giant glowing fungi close by, so the frame's
  // light comes from the forest itself. Deterministic per planet seed.
  // level.flora.heroGrove(spotPosition, viewDir) — called by the night preset.
  heroGrove(P, dir) { try { if (this.profile?.glowPools) this._heroGrove(P, dir); } catch (e) { this._err('grove', e); } }

  _heroGrove(P, dir) {
    if (this._grove || !this.trees?.species?.length) return;
    this._grove = true;
    const w = this.world, up = P.clone().normalize();
    const fw = dir.clone(); fw.addScaledVector(up, -fw.dot(up));
    if (fw.lengthSq() < 1e-6) return; fw.normalize();
    const side = fw.clone().cross(up).normalize();
    // the level clears trees along the view: radius by distance along fw
    const CR = [[-8, 9], [0, 10], [14, 15], [34, 24], [64, 34], [104, 46], [160, 60]];
    const clearR = (d) => { for (let k = 1; k < CR.length; k++) if (d <= CR[k][0]) { const [d0, r0] = CR[k - 1], [d1, r1] = CR[k]; return r0 + (r1 - r0) * Math.max(0, (d - d0) / (d1 - d0)); } return 60; };
    let s = (this.seed ^ 0x9e3779b9) >>> 0;
    const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const has = (k) => this.trees.species.some((sp) => sp.kind === k);
    const list = [], d0 = new THREE.Vector3();
    const put = (kind, d, lat, scale) => {
      if (!has(kind)) return;
      d0.copy(P).addScaledVector(fw, d).addScaledVector(side, lat).normalize();
      const h = w.heightAt(d0);
      if (w.hasOcean && h < w.seaLevel + 0.8) return;
      list.push({ kind, position: d0.clone().multiplyScalar(w.radius + h - 0.2), scale, seed: rnd() * 1000 });
    };
    // the shot camera sits ~6.5 m behind the spot looking along fw: place the
    // groves by view angle so they frame the sky from both edges of the frame
    for (const sgn of [-1, 1]) {
      // the glowing wood: a loose grove along each flank, layered in depth
      for (let k = 0; k < 10; k++) {
        const D = 30 + k * 13 + rnd() * 9, th = (0.36 + 0.24 * rnd()) * (k < 4 ? 1 : 0.9);
        put('biolum', D - 6.5, sgn * D * Math.tan(th), 0.9 + rnd() * 0.5);
      }
      // giant glowing fungi and coral at the grove's feet, closer to the lens
      for (let k = 0; k < 4; k++) {
        const D = 14 + k * 8 + rnd() * 5, th = 0.42 + 0.2 * rnd();
        put(k % 2 ? 'coral' : 'fungus', D - 6.5, sgn * D * Math.tan(th), 0.5 + rnd() * 0.3);
      }
    }
    void clearR;
    const n = this.trees.plant(list);
    if (FLORA_STATS) console.warn(`[flora] night grove: ${n} planted`);
  }

  // Streaming runs after camera rigs have placed the camera this frame.
  lateUpdate() {
    if (!this.profile || !this.parts.length) return;
    const cam = this.level.camera;
    _cam.copy(cam.position);
    const shot = this.engine.shotMode;
    const alt = this.world.altitude(_cam);
    // high above the world, flora is invisible: freeze streaming, hide meshes
    const visible = alt < 6000;
    this.group.visible = visible;
    if (!visible) return;

    // floating origin
    this.reanchored = false;
    if (this._first || _v.copy(_cam).sub(this.anchor).lengthSq() > ANCHOR_SNAP * ANCHOR_SNAP) {
      this.anchor.set(Math.round(_cam.x / 64) * 64, Math.round(_cam.y / 64) * 64, Math.round(_cam.z / 64) * 64);
      this.group.position.copy(this.anchor);
      this.group.updateMatrixWorld(true);
      this.reanchored = true;
    }
    const U = this.uniforms;
    U.uCam.value.copy(_cam).sub(this.anchor);
    this._fr = ((this._fr || 0) + 1) % 16;
    U.uDitherT.value = this.engine.quality.level >= 2 && this.level.grade?.taa !== 0 ? this._fr : 0;
    const player = this.level.player?.position;
    if (player && this.level.mode === 'onfoot') U.uPlayer.value.copy(player).sub(this.anchor);
    else U.uPlayer.value.set(1e9, 0, 0);
    this._syncLight();
    this._updateView(cam);

    const force = this._first || shot;
    const budget = shot ? 1e6 : this._first ? 40 : 2.5;
    const col = player || _cam;
    try { if (this.grass && alt < 400) { this.grass.mesh.visible = true; this.grass.update(_cam, budget * 0.8, force); } else if (this.grass) this.grass.mesh.visible = false; }
    catch (e) { this._err('grass', e); }
    if (this.grass?.fmesh) this.grass.fmesh.visible = this.grass.mesh.visible;
    if (this.grass?.fmesh2) this.grass.fmesh2.visible = this.grass.mesh.visible;
    if (this.grass?.lmesh) this.grass.lmesh.visible = this.grass.mesh.visible;
    if (this.grass?.meshFar) this.grass.meshFar.visible = this.grass.mesh.visible;
    if (this.grass?.meshMid) this.grass.meshMid.visible = this.grass.mesh.visible;
    try { this.trees?.update(_cam, _cam, col, budget * 0.6, force); } catch (e) { this._err('trees', e); }
    // biolum worlds: the sward flares softly where the player walks (the
    // last glow-pool slot follows them every frame)
    if (this.profile.glowPools && player && this.level.mode === 'onfoot') {
      const G = U.uGlowPts.value, pu = _v.copy(player).normalize();
      G[G.length - 1].set(player.x - this.anchor.x + pu.x * 0.3, player.y - this.anchor.y + pu.y * 0.3, player.z - this.anchor.z + pu.z * 0.3, 1.7);
    }
    try { if (this.rocks && alt < 1500) this.rocks.update(_cam, col, budget * 0.4, force); } catch (e) { this._err('rocks', e); }
    for (const m of this.motes || []) { try { m.update(_cam); } catch (e) { this._err('motes', e); } }
    this._first = false;
    if (shot && FLORA_STATS && (this._logN || 0) < 8 && (!this._logAt || this._logAt.distanceTo(_cam) > 50 || this.view.changed)) { this._logN = (this._logN || 0) + 1; (this._logAt ||= new THREE.Vector3()).copy(_cam); const sm = this.world.terrain?.sample?.(..._cam.clone().normalize().toArray()); console.warn(`[flora] cam alt ${alt.toFixed(1)} m, ground ${sm ? `rock ${sm.rock?.toFixed(2)} cliff ${sm.cliff?.toFixed(2)} moist ${sm.moisture?.toFixed(2)} sand ${sm.sand?.toFixed(2)} snow ${sm.snow?.toFixed(2)} biome ${sm.biome} h ${sm.h?.toFixed(1)} sea ${this.world.seaLevel?.toFixed?.(1)}` : '-'}, site ${this.siteClear(_cam.x, _cam.y, _cam.z, 0.78).toFixed(2)}, grass ${this.grass?.stats?.()}`); console.warn(`[flora] ${this.kind}: grass ${this.grass?.count | 0}, trees ${this.trees?.meshCount | 0}+${this.trees?.impCount | 0} imp, under ${this.trees?.underCount | 0}, rocks ${this.rocks?.count | 0}, landmark ${this.trees?.landmark ? Math.round(this.trees.landmark.position.distanceTo(_cam)) + ' m' : '-'}`); }
  }

  _err(name, e) {
    this._errs = (this._errs || 0) + 1;
    if (this._errs < 4) console.error(`[flora] ${name}:`, e);
  }

  dispose() {
    for (const p of this.parts) { try { p.dispose(); } catch (e) { console.warn(e); } }
    this.group.removeFromParent();
    if (this.level.flora === this) this.level.flora = null;
  }
}
