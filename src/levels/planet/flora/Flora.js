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
    };
    this.noiseScale = { patch: 1 / 9, color: 1 / 46, flower: 1 / 16, forest: 1 / 240 };
    this.sites = this.world.sites || [];
    this.parts = [];
  }

  async init(progress) {
    if (!this.profile) return; // barren world
    this.level.scene.add(this.group);
    this.level.flora = this;
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

  update() {}

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
    const player = this.level.player?.position;
    if (player && this.level.mode === 'onfoot') U.uPlayer.value.copy(player).sub(this.anchor);
    else U.uPlayer.value.set(1e9, 0, 0);
    this._syncLight();

    const force = this._first || shot;
    const budget = shot ? 1e6 : this._first ? 40 : 2.5;
    const col = player || _cam;
    try { if (this.grass && alt < 400) { this.grass.mesh.visible = true; this.grass.update(_cam, budget * 0.8, force); } else if (this.grass) this.grass.mesh.visible = false; }
    catch (e) { this._err('grass', e); }
    if (this.grass?.fmesh) this.grass.fmesh.visible = this.grass.mesh.visible;
    if (this.grass?.lmesh) this.grass.lmesh.visible = this.grass.mesh.visible;
    try { this.trees?.update(_cam, _cam, col, budget * 0.6, force); } catch (e) { this._err('trees', e); }
    try { if (this.rocks && alt < 1500) this.rocks.update(_cam, col, budget * 0.4, force); } catch (e) { this._err('rocks', e); }
    for (const m of this.motes || []) { try { m.update(_cam); } catch (e) { this._err('motes', e); } }
    this._first = false;
    if (shot && (this._logN || 0) < 4 && (!this._logAt || this._logAt.distanceTo(_cam) > 50)) { this._logN = (this._logN || 0) + 1; (this._logAt ||= new THREE.Vector3()).copy(_cam); console.warn(`[flora] ${this.kind}: grass ${this.grass?.count | 0}, trees ${this.trees?.meshCount | 0}+${this.trees?.impCount | 0} imp, under ${this.trees?.underCount | 0}, rocks ${this.rocks?.count | 0}, landmark ${this.trees?.landmark ? Math.round(this.trees.landmark.position.distanceTo(_cam)) + ' m' : '-'}`); }
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
