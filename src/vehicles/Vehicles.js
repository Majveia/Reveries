// Vehicles subsystem — hover bikes and starships, from orbit to the ground.
//
// Contract (docs/ARCHITECTURE.md › Player ⇄ vehicles):
//   level.vehicles = this; list; nearest(pos, maxDist)
//   vehicle: { type, object3d, position, quaternion, velocity, seat, cameraProfile,
//              canBoard(pos), enter(player), exit() → Vector3, update(dt, input|null) }
// The player boards with player.board(vehicle) and calls exit() on interact.
//
// This module also owns:
//   - placement: a hover bike beside the player's spawn, the ship on the first
//     settlement's landing pad (or the flattest spot at its edge), bikes at towns;
//     spawn 'orbit' puts the ship ~2.5 R from the planet centre, nose on the world;
//   - the ship chase camera (bank-following, orientation-lagged, FOV kick) — it
//     drives the camera through level.freeCam so the player's horizon-locked rig
//     stands down while flying (the bike uses the player's rig via cameraProfile);
//   - flight UX: telemetry, prompts (land / exit / leave orbit), interact while
//     airborne = automatic landing, climbing above 3 R → engine.up();
//   - shared VFX pools (dust, spray), boost speed streaks, audio engine layers;
//   - screenshot presets: bike, ship, orbit.

import * as THREE from 'three';
import { vehicleMaterials } from './Materials.js';
import { Bike } from './Bike.js';
import { Ship } from './Ship.js';
import { Particles, Streaks } from './VFX.js';
import { Random, seedFrom } from '../core/Random.js';

const clamp = THREE.MathUtils.clamp, smooth = THREE.MathUtils.smoothstep;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

/** Minimal input stand-in for scripted driving (screenshots). */
class ScriptInput {
  constructor() { this.move = { x: 0, y: 0 }; this.look = { x: 0, y: 0 }; this.throttle = 0; this.zoom = 0; this.held = new Set(); }
  down(a) { return this.held.has(a); }
  pressed() { return false; }
  released() { return false; }
}

export default class Vehicles {
  static order = 10;

  constructor(level) {
    this.level = level;
    this.engine = level.engine;
    this.world = level.world;
    this.list = [];
    this.time = 0;
    this.autopilot = null; this.apParams = null;
    this.shotDrive = null; this.shotCam = null;
    this.forceVortex = 0; this.forceContrail = 0;
    this.ambientLight = new THREE.Color(1, 1, 1);
    this.dustColor = new THREE.Color(0.6, 0.52, 0.42);
    this.fxScale = this.engine.quality.pick(0.4, 0.7, 1, 1.3);
    this._shake = 0;
    this._prompt = null;
    this._telT = 0;
    // shot tuning from the URL (?vp=head:1.9;tod:0.74) — harness only
    this.shotParams = {};
    for (const kv of (this.engine.params.get('vp') || '').split(';')) { const [k, v] = kv.split(':'); if (k && v != null && !isNaN(+v)) this.shotParams[k] = +v; }
    level.vehicles = this;
  }

  async init(progress) {
    const level = this.level, w = this.world, engine = this.engine;
    this.mats = vehicleMaterials(engine);
    this.dust = new Particles(engine.quality.pick(400, 800, 1400, 2000));
    this.spray = new Particles(engine.quality.pick(300, 600, 1000, 1400));
    level.scene.add(this.dust.points, this.spray.points);
    this.streaks = new Streaks(engine.quality.pick(40, 60, 90, 120));
    level.camera.add(this.streaks.mesh);
    const P = level.planet;
    const rng = new Random(seedFrom(P.seed ?? 1, 'vehicles'));
    this.rng = rng;
    const g = level.lighting?.groundAlbedo;
    if (g) this.dustColor.copy(g).multiplyScalar(1.25).lerp(new THREE.Color(0.75, 0.68, 0.58), 0.35);

    // ---- the hero ship + its spawn
    const spawn = level.opts?.spawn || engine.params.get('spawn') || 'orbit';
    this.spawnKind = spawn;
    const site0 = w.sites[0];
    const siteDir = site0 ? site0.dir.clone() : w.focus.clone().normalize();
    const hero = new Ship(this, { seed: rng.int(1, 1e6), livery: 0 });
    hero.addTo(level.scene); this.list.push(hero);
    this.hero = hero;
    const spawnSpot = this._playerSpawnSpot();
    // bike right beside the player's spawn, angled toward the settlement
    const bike = new Bike(this, { seed: rng.int(1, 1e6), livery: 0 });
    bike.addTo(level.scene); this.list.push(bike);
    {
      const up = spawnSpot.position.clone().normalize();
      const f = spawnSpot.facing.clone().addScaledVector(up, -spawnSpot.facing.dot(up)).normalize();
      const right = _v.crossVectors(f, up).normalize();
      const d = spawnSpot.position.clone().addScaledVector(right, 4.5).addScaledVector(f, 2.5).normalize();
      bike.place(d, f.clone().applyAxisAngle(up, -0.5));
    }
    if (spawn === 'orbit') {
      this._orbitPose(hero, siteDir);
      // a second ship waits on the pad
      const parked = new Ship(this, { seed: rng.int(1, 1e6), livery: 2 });
      parked.addTo(level.scene); this.list.push(parked);
      this.parkedShip = parked;
    } else this.parkedShip = hero;
    this._parkAtSettlement(this.parkedShip, site0, spawnSpot);
    // bikes at other towns
    const extra = engine.quality.pick(1, 2, 3, 4);
    for (const s of w.sites.slice(1)) {
      if (this.list.filter((v) => v.type === 'bike').length > extra) break;
      if (!['town', 'city', 'village', 'megacity', 'spaceport', 'outpost'].includes(s.kind)) continue;
      const b = new Bike(this, { seed: rng.int(1, 1e6), livery: rng.int(0, 3) });
      b.addTo(level.scene); this.list.push(b);
      const spot = this._edgeSpot(s.dir, clamp(s.radius * 0.5, 80, 500), rng);
      b.place(spot.dir, _v.copy(s.dir).sub(spot.dir));
    }
    progress?.(1);
  }

  // =====================================================================================
  // Placement helpers
  // =====================================================================================
  /** Mirrors the player's _surfaceSpot so the bike waits right next to the player. */
  _playerSpawnSpot() {
    const w = this.world;
    const site = w.sites[0];
    const base = site ? site.dir.clone() : w.focus.clone().normalize();
    const t1 = new THREE.Vector3(0, 1, 0).cross(base); if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0); t1.normalize();
    const t2 = base.clone().cross(t1).normalize();
    const dist = site ? clamp(site.radius * 0.55, 90, 420) : 0;
    let best = null;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const dir = base.clone().addScaledVector(t1, Math.cos(a) * dist / w.radius).addScaledVector(t2, Math.sin(a) * dist / w.radius).normalize();
      const h = w.heightAt(dir);
      if (w.hasOcean && h < w.seaLevel + 1) continue;
      const n = w.normalAt(dir);
      const score = n.dot(dir) * 10 - Math.abs(h - (site?.height ?? h)) * 0.02;
      if (!best || score > best.score) best = { dir, h, score };
    }
    if (!best) best = { dir: base, h: w.heightAt(base) };
    const position = best.dir.clone().multiplyScalar(w.radius + best.h);
    const target = site ? site.position : position.clone().add(t1);
    return { position, facing: target.clone().sub(position), dir: best.dir };
  }

  /** Flattest dry spot on a ring around `center`. */
  _edgeSpot(center, dist, rng, avoid = null) {
    const w = this.world;
    const t1 = new THREE.Vector3(0, 1, 0).cross(center); if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0); t1.normalize();
    const t2 = center.clone().cross(t1).normalize();
    let best = null;
    const a0 = rng ? rng.float() * 6.28 : 0;
    for (let k = 0; k < 20; k++) {
      const a = a0 + (k / 20) * Math.PI * 2;
      const dir = center.clone().addScaledVector(t1, Math.cos(a) * dist / w.radius).addScaledVector(t2, Math.sin(a) * dist / w.radius).normalize();
      const h = w.heightAt(dir);
      if (w.hasOcean && h < w.seaLevel + 1.5) continue;
      const n = w.normalAt(dir, _v, 3);
      let score = n.dot(dir) * 20;
      if (avoid && dir.angleTo(avoid) * w.radius < 40) score -= 30;
      // free of colliders
      _p.copy(dir).multiplyScalar(w.radius + h + 1);
      _v3.copy(_p);
      if (w.collide(_v3, 8, 4)) score -= 15;
      if (!best || score > best.score) best = { dir, score };
    }
    return best || { dir: center.clone(), score: 0 };
  }

  _parkAtSettlement(ship, site, spawnSpot) {
    const dir = site ? site.dir : spawnSpot.dir;
    const spot = this._edgeSpot(dir, site ? clamp(site.radius * 0.42, 70, 360) : 30, this.rng, spawnSpot.dir);
    ship.park(spot.dir, _v.copy(dir).sub(spot.dir).normalize());
    this._padPending = !!site; // re-seat on a civ landing pad once the settlement exists
  }

  /** Try to move the parked ship onto a landing pad built by the civ subsystem. */
  _seatOnPad() {
    const civ = this.level.sys?.civ || this.level.civilization;
    const main = civ?.settlements?.[0];
    const pads = main?.ctx?.pads;
    if (!main || !main.built) return main ? false : true;
    this._padPending = false;
    if (!pads?.length) return true;
    const ship = this.parkedShip;
    if (!ship || ship.rider || !ship.landed) return true;
    const pad = pads.reduce((a, b) => (b.R > a.R ? b : a));
    const dir = main.frame.dirAt(pad.x, pad.z, new THREE.Vector3());
    ship.park(dir, _v.copy(main.frame.origin).normalize().sub(dir));
    return true;
  }

  _orbitPose(ship, siteDir) {
    const w = this.world;
    // above the morning side, a little off the settlement, nose on the world
    const side = new THREE.Vector3(0, 1, 0).cross(siteDir).normalize();
    const pos = siteDir.clone().addScaledVector(side, -0.55).addScaledVector(Y, 0.2).normalize().multiplyScalar(w.radius * 2.5);
    const target = siteDir.clone().multiplyScalar(w.radius);
    ship.fly(pos, target, 0, siteDir.clone().addScaledVector(side, 0.5));
    ship.thrSet = 0.25;
  }

  // =====================================================================================
  // Contract
  // =====================================================================================
  nearest(pos, maxDist = 6) {
    let best = null, bd = Infinity;
    for (const v of this.list) {
      const reach = v.type === 'ship' ? maxDist + 5 : maxDist;
      const d = v.position.distanceTo(pos);
      if (d < reach && d < bd) { bd = d; best = v; }
    }
    return best;
  }

  onBoard(v) {
    this._shipCamInit = false;
    if (v.type === 'ship') v.thrSet = v.landed ? 0 : Math.max(v.thrSet, 0.3);
  }
  onAlight(v) {
    if (this.level.freeCam && this.level.freeCam._vehicles) this.level.freeCam = null;
    this.engine.audio.setEngine?.(null, 0);
    this.engine.ui.telemetry?.(null);
    this._setPrompt(null);
    this.streaks.mesh.visible = false;
    void v;
  }

  shake(k) { this._shake = Math.max(this._shake, k); }

  // =====================================================================================
  // Frame
  // =====================================================================================
  update(dt, t) {
    this.time = t;
    const level = this.level, engine = this.engine;
    if (this._padPending && (this._padTry = (this._padTry || 0) + 1) % 30 === 1) { try { this._seatOnPad(); } catch (e) { this._padPending = false; console.warn('[vehicles] pad', e); } }
    // light for particles / trails from the planet's lighting model
    const L = level.lighting;
    if (L) {
      const k = L.keyColor, s = L.skyColor;
      this.ambientLight.setRGB(k.r * 0.22 + s.r * 0.9, k.g * 0.22 + s.g * 0.9, k.b * 0.22 + s.b * 0.9);
      for (const P of [this.dust, this.spray]) {
        P.uniforms.uLight.value.setRGB(k.r * 0.3, k.g * 0.3, k.b * 0.3);
        P.uniforms.uAmb.value.copy(s).multiplyScalar(0.9);
        P.uniforms.uUp.value.copy(level.camera.position).normalize();
      }
    }
    const player = level.player;
    const driving = player?.vehicle || null;
    for (const v of this.list) {
      let input = null;
      if (this.shotDrive === v) input = this.shotInput;
      else if (driving === v) input = engine.input;
      try { v.update(dt, input, t); } catch (e) { if (!v._err) { v._err = true; console.error('[vehicles]', e); } }
    }
    const h = engine.renderer.domElement.height || innerHeight;
    this.dust.update(t, level.camera, h);
    this.spray.update(t, level.camera, h);

    const camVeh = this.shotCam?.vehicle || driving;
    level.maxNear = camVeh && camVeh.type === 'ship' ? 0.5 : 0;
    if (driving && this.list.includes(driving) && !this.shotCam) this._drive(dt, driving);
    else if (!driving) { this.streaks.mesh.visible = false; }
    if (this.shotCam) this._updateShotCam();
  }

  _drive(dt, v) {
    const engine = this.engine, ui = engine.ui, input = engine.input, w = this.world;
    const key = input.lastDevice === 'gamepad' ? 'X' : 'E';
    const r = v.position.length();
    // ---- prompts & interact routing
    if (v.type === 'ship') {
      const leave = r > w.radius * 3;
      if (leave) this._setPrompt(key, 'Leave orbit');
      else if (v.landed) this._setPrompt(key, 'Exit ship');
      else if (v.autoland) this._setPrompt(null);
      else if (v.alt < 2500) this._setPrompt(key, 'Land');
      else this._setPrompt(null);
      if (input.pressed('interact') && !v.landed) {
        input._pressed?.delete?.('interact'); // consumed: the player must not alight mid-air
        if (leave) { engine.audio.sfx?.('warp'); engine.up(); return; }
        v.autoland = true;
        ui.hint?.('Landing assist engaged', 2500);
      }
      if (!this.level.freeCam || this.level.freeCam._vehicles) this._shipCam(dt, v);
    } else {
      this._setPrompt(key, 'Dismount');
      // FOV kick on boost (the player's rig reads cameraProfile.fov)
      v.cameraProfile.fov = v.baseFov + v.boost * 14;
    }
    // ---- speed streaks
    const sp = v.velocity.length();
    const si = v.type === 'bike' ? v.boost * smooth(sp, 30, 90) : smooth(sp, 150, 600) * (1 - v.space * 0.7) * (0.4 + v.boost);
    this.streaks.mesh.visible = si > 0.02;
    this.streaks.uniforms.uI.value = si;
    this.streaks.uniforms.uTime.value = this.time;
    this.streaks.uniforms.uSpeed.value = 1 + v.boost * 1.5;
    // ---- audio & telemetry
    engine.audio.setEngine?.(v.type, clamp(v.throttle + v.boost * 0.5, 0, 1));
    if (v.type === 'ship') engine.audio.setFlight?.(clamp(sp / 600, 0, 1), clamp(v.alt / (v.atmosphereHeight * 2), 0, 1));
    if ((this._telT -= dt) <= 0) {
      this._telT = 0.12;
      const kmh = Math.round(sp * 3.6);
      if (v.type === 'ship') {
        const alt = v.alt;
        ui.telemetry?.({ SPD: sp > 2000 ? `${(sp / 1000).toFixed(1)} km/s` : `${kmh} km/h`, ALT: alt > 9999 ? `${(alt / 1000).toFixed(1)} km` : `${Math.round(alt)} m`, THR: `${Math.round(v.thrSet * 100)}%` });
      } else ui.telemetry?.({ SPD: `${kmh} km/h` });
    }
  }

  _setPrompt(key, text) {
    const id = key ? key + text : null;
    if (id === this._prompt) return;
    this._prompt = id;
    this.engine.ui.prompt(key || null, text);
  }

  // ---- ship chase camera: orientation-lagged, follows the bank, FOV kick
  _shipCam(dt, v) {
    const level = this.level, cam = level.camera, input = this.engine.input;
    const st = this._sc || (this._sc = { q: new THREE.Quaternion(), lagV: new THREE.Vector3(), pos: new THREE.Vector3(), tgt: new THREE.Vector3(), up: new THREE.Vector3(), zoom: 1, fov: 62 });
    if (!this._shipCamInit) { st.q.copy(v.quaternion); st.lagV.copy(v.velocity); this._shipCamInit = true; }
    st.q.slerp(v.quaternion, 1 - Math.exp(-(v.landed ? 2 : 4.5) * dt));
    if (input.zoom) st.zoom = clamp(st.zoom * Math.exp(input.zoom * 0.14), 0.45, 4);
    st.lagV.lerp(v.velocity, 1 - Math.exp(-3 * dt));
    const fwd = _v.copy(Z).applyQuaternion(st.q);
    const sUp = _v2.copy(Y).applyQuaternion(st.q);
    const pUp = _v3.copy(v.position).normalize();
    const air = 1 - v.space;
    // camera roll: follows ~half the bank in air, fully in space
    st.up.copy(sUp).lerp(pUp, air * 0.5).normalize();
    const P = v.cameraProfile;
    const dist = P.distance * st.zoom * (1 + v.boost * 0.18);
    st.pos.copy(v.position).addScaledVector(fwd, -dist).addScaledVector(st.up, P.height * st.zoom);
    // acceleration lag (the camera falls back when boosting, swings in turns)
    _p.copy(v.velocity).sub(st.lagV).multiplyScalar(0.06);
    if (_p.length() > dist * 0.5) _p.setLength(dist * 0.5);
    st.pos.sub(_p);
    // shake
    if (this._shake > 0.001) {
      const s = this._shake * 0.35;
      st.pos.x += (Math.random() - 0.5) * s; st.pos.y += (Math.random() - 0.5) * s; st.pos.z += (Math.random() - 0.5) * s;
      this._shake *= Math.exp(-5 * dt);
    }
    // re-entry buffeting
    if (v.reentry > 0.05) { const s = v.reentry * 0.25; st.pos.x += (Math.random() - 0.5) * s; st.pos.y += (Math.random() - 0.5) * s; }
    // stay above the ground
    const g = this.world.groundAt(st.pos, this._cg || (this._cg = {}));
    const minR = Math.max(g.radius, g.water ? g.waterRadius : -Infinity) + 1.5;
    if (st.pos.length() < minR) st.pos.setLength(minR);
    st.tgt.copy(v.position).addScaledVector(fwd, 30).addScaledVector(st.up, 1.2);
    const fc = level.freeCam && level.freeCam._vehicles ? level.freeCam : (level.freeCam = { position: new THREE.Vector3(), target: new THREE.Vector3(), up: new THREE.Vector3(), _vehicles: true });
    fc.position.copy(st.pos); fc.target.copy(st.tgt); fc.up.copy(st.up);
    const fovT = P.fov + Math.min(16, v.speed * 0.02) + v.boost * 10;
    st.fov += (fovT - st.fov) * (1 - Math.exp(-3 * dt));
    if (Math.abs(cam.fov - st.fov) > 0.01) { cam.fov = st.fov; cam.updateProjectionMatrix(); }
  }

  // =====================================================================================
  // Screenshots
  // =====================================================================================
  _updateShotCam() {
    const sc = this.shotCam, v = sc.vehicle, level = this.level;
    let up, f, left;
    if (sc.frame === 'ship') {
      // rigid in the vehicle frame (space shots: no meaningful local horizon)
      up = _v.copy(Y).applyQuaternion(v.quaternion);
      f = _v2.copy(Z).applyQuaternion(v.quaternion);
      left = _v3.copy(X).applyQuaternion(v.quaternion);
    } else {
      up = _v.copy(v.position).normalize();
      f = _v2.copy(Z).applyQuaternion(v.quaternion);
      f.addScaledVector(up, -f.dot(up)).normalize();
      left = _v3.crossVectors(up, f).normalize();
    }
    const fc = level.freeCam && level.freeCam._shot ? level.freeCam : (level.freeCam = { position: new THREE.Vector3(), target: new THREE.Vector3(), up: new THREE.Vector3(), _shot: true });
    const o = sc.offset, tg = sc.target;
    fc.position.copy(v.position).addScaledVector(left, o.x).addScaledVector(up, o.y).addScaledVector(f, o.z);
    fc.target.copy(v.position).addScaledVector(left, tg.x).addScaledVector(up, tg.y).addScaledVector(f, tg.z);
    fc.up.copy(up);
    const roll = (sc.roll || 0) + (sc.bankRoll ? (v.bank || 0) * sc.bankRoll : 0);
    if (roll) fc.up.applyAxisAngle(_p.copy(fc.target).sub(fc.position).normalize(), roll);
    if (sc.minClear) {
      const g = this.world.groundAt(fc.position, this._cg || (this._cg = {}));
      const minR = Math.max(g.radius, g.water ? g.waterRadius : -Infinity) + sc.minClear;
      if (fc.position.length() < minR) fc.position.setLength(minR);
    }
    if (sc.fov && level.camera.fov !== sc.fov) { level.camera.fov = sc.fov; level.camera.updateProjectionMatrix(); }
  }

  _boardForShot(v) {
    const pl = this.level.player;
    if (!pl) { this.level.setMode(v.type); return; }
    if (pl.vehicle && pl.vehicle !== v) { pl.vehicle.rider = null; pl.vehicle = null; }
    if (pl.vehicle !== v) pl.board(v);
  }

  _simulate(steps, dt = 1 / 60) {
    for (let i = 0; i < steps; i++) {
      this.time += dt;
      for (const v of this.list) v.update(dt, this.shotDrive === v ? this.shotInput : null, this.time);
    }
  }

  /** Unit tangent at `dir` pointing toward `target` (any tangent if degenerate). */
  _tangentTo(dir, target) {
    const t = target.clone().normalize().sub(dir);
    t.addScaledVector(dir, -t.dot(dir));
    if (t.lengthSq() < 1e-12) t.set(0, 1, 0).cross(dir);
    return t.normalize();
  }

  async shot(name, spot) {
    if (!['bike', 'ship', 'orbit'].includes(name)) return false;
    const level = this.level, w = this.world;
    level.freeCam = null;
    this.shotCam = null; this.autopilot = null; this.shotDrive = null;
    this.forceVortex = 0; this.forceContrail = 0;
    for (const v of this.list) v._holdForShot = false;
    this.engine.ui.telemetry?.(null);
    this._t0 = this.time = this.engine.time;
    const site = spot?.site || w.sites[0];
    const sdir = (spot?.dir || site?.dir || w.focus.clone()).clone().normalize();

    if (name === 'bike') {
      const bike = this.list.find((v) => v.type === 'bike');
      w.setTimeOfDay(0.3, sdir);
      // race past the settlement on the flat, dry ground where the player spawns (not off a crest)
      const ss = this._playerSpawnSpot();
      const sd = ss.dir.clone().normalize();
      const center = site?.dir || sdir;
      const radial = this._tangentTo(sd, center.clone().multiplyScalar(w.radius)).negate();
      const head = radial.clone().cross(sd).normalize().applyAxisAngle(sd, -0.25); // tangent to the town ring
      const start = sd.clone().addScaledVector(head, -60 / w.radius).normalize();
      bike.place(start, head);
      this._boardForShot(bike);
      const inp = this.shotInput = new ScriptInput();
      inp.move.y = 1; inp.move.x = 0.2; if (!this.shotParams?.noboost) inp.held.add('sprint');
      this.shotDrive = bike;
      bike.velocity.copy(head).multiplyScalar(55);
      bike._s = 55;
      this._simulate(70);
      this.shotCam = { vehicle: bike, offset: new THREE.Vector3(-(this.shotParams?.bx ?? 2.3), this.shotParams?.by ?? 0.95, -(this.shotParams?.bz ?? 5.0)), target: new THREE.Vector3(0.9, 0.55, 6), fov: 56, minClear: 0.25, bankRoll: 0.3 };
      this._updateShotCam();
      return true;
    }
    if (name === 'ship') {
      const ship = this.hero;
      w.setTimeOfDay(this.shotParams?.tod ?? 0.743, sdir);
      const sun = w.sunDir.clone();
      const sunT = sun.addScaledVector(sdir, -sun.dot(sdir)).normalize();
      // fly across the low sun so the hull is side-lit gold; the camera rides ahead on the sun side
      const head = sunT.clone().applyAxisAngle(sdir, this.shotParams?.head ?? 2.2);
      const start = sdir.clone().addScaledVector(head, -1400 / w.radius).normalize();
      const pos = start.clone().multiplyScalar(w.surfaceRadius(start) + 80);
      this._boardForShot(ship);
      ship.fly(pos, pos.clone().addScaledVector(head, 100), 170, start);
      this.autopilot = ship; this.apParams = { alt: 75, throttle: 0.75, yaw: -0.2 };
      this.forceVortex = 0.3;
      this._simulate(160);
      const fw = _v.copy(Z).applyQuaternion(ship.quaternion), upS = ship.position.clone().normalize();
      const lft = _v2.crossVectors(upS, fw).normalize();
      const sideSign = Math.sign(lft.dot(w.sunDir)) || 1;
      this.shotCam = { vehicle: ship, offset: new THREE.Vector3(12.5 * sideSign, 2.6, 8.5), target: new THREE.Vector3(-0.5 * sideSign, 0.4, -3.5), fov: 50, minClear: 2 };
      this._updateShotCam();
      return true;
    }
    if (name === 'orbit') {
      const ship = this.hero;
      w.setTimeOfDay(0.66, sdir);
      // low orbit above the afternoon side; nose toward the limb, sun off to the side
      const side = new THREE.Vector3(0, 1, 0).cross(sdir).normalize();
      const p = sdir.clone().addScaledVector(side, 0.35).normalize();
      const rOrb = w.radius * (this.shotParams?.orbitR ?? 1.7);
      const pos = p.clone().multiplyScalar(rOrb);
      const sunT = w.sunDir.clone().addScaledVector(p, -w.sunDir.dot(p)).normalize();
      const T = sunT.clone().applyAxisAngle(p, this.shotParams?.orbitAz ?? 1.15);
      const dep = Math.acos(w.radius / rOrb) - 0.2; // nose just above the limb: the curved horizon sweeps across the lower frame
      const look = T.clone().multiplyScalar(Math.cos(dep)).addScaledVector(p, -Math.sin(dep)).normalize();
      this._boardForShot(ship);
      ship.fly(pos, pos.clone().add(look), 0, p);
      ship.thrSet = 0.7; ship.throttle = 0.8; ship.boost = 0; ship.gearT = 0;
      this._simulate(2);
      ship.position.copy(pos); ship.velocity.set(0, 0, 0);
      ship._holdForShot = true;
      this.shotCam = { vehicle: ship, frame: 'ship', offset: new THREE.Vector3(-6.5, 3.4, -19), target: new THREE.Vector3(2.5, -1.5, 40), fov: 55 };
      this._updateShotCam();
      return true;
    }
    return false;
  }

  dispose() {
    for (const v of this.list) v.dispose();
    this.list.length = 0;
    this.dust.dispose(); this.spray.dispose(); this.streaks.dispose();
    this.dust.points.removeFromParent(); this.spray.points.removeFromParent(); this.streaks.mesh.removeFromParent();
    if (this.level.vehicles === this) this.level.vehicles = null;
  }
}
