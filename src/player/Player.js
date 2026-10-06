// Player subsystem — the explorer, its controller, camera and interactions.
//
//   level.player = this  ·  position / velocity / up / mode / cameraRig
//   spawn(kind)  'orbit' | 'surface' | 'bike' | 'ship'
//   board(vehicle) · alight() · handlesEscape()
//   shot(name, spot)  'character' | 'fp' | 'vista' | 'night'
//
// Files: Explorer.js (SDF-sculpted skinned character), Materials.js (PBR +
// procedural micro-surface), Animator.js (procedural locomotion + IK),
// Scarf.js (Verlet cloth), Controller.js (spherical-world physics),
// CameraRig.js (third/first person + vehicle chase cam).

import * as THREE from 'three';
import { buildExplorerData, createExplorer, B } from './Explorer.js';
import { createExplorerMaterials } from './Materials.js';
import { Animator } from './Animator.js';
import { Scarf } from './Scarf.js';
import { Controller, SPEED } from './Controller.js';
import { CameraRig } from './CameraRig.js';
import { VisorFX } from './VisorFX.js';
import { CharShadow } from './CharShadow.js';
import { Dust, ContactShadow, ShadowCatcher } from './FX.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
/** THREE.Color has no addScaledVector: c += o·s */
const addSc = (c, o, s) => { c.r += o.r * s; c.g += o.g * s; c.b += o.b * s; return c; };
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
const _c = new THREE.Color(), _c2 = new THREE.Color(), _c3 = new THREE.Color();

function buildData(quality) {
  return new Promise((resolve) => {
    let worker = null;
    const fallback = (why) => {
      if (why) console.warn('[player] worker build failed, building on the main thread:', why);
      try { worker?.terminate(); } catch { /* ignore */ }
      resolve(buildExplorerData(quality));
    };
    try { worker = new Worker(new URL('./ExplorerWorker.js', import.meta.url), { type: 'module' }); } catch (e) { fallback(e); return; }
    worker.onmessage = (e) => { worker.terminate(); if (e.data?.ok) resolve(e.data.data); else fallback(e.data?.error); };
    worker.onerror = (e) => { e.preventDefault?.(); fallback(e.message || 'error'); };
    worker.postMessage({ quality });
  });
}

export default class Player {
  static order = 20;

  constructor(level) {
    this.level = level;
    this.engine = level.engine;
    this.world = null;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.vehicle = null;
    this.ready = false;
    this.shotPose = null;
    this._prompt = null;
    this._card = null;
    this._stepOff = 0;
    this._lastR = 0;
    this._wasGrounded = false;
    this._jet = 0;
    this._glow = 0;
    this.effects = [];
    this.visorFX = new VisorFX();
    this._fwd = new THREE.Vector3(); this._right = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._eyeBind = new THREE.Vector3(0, 1.672, 0.06);
  }

  get mode() { return this.level.mode; }
  get cameraRig() { return this.cam; }

  async init(progress) {
    const level = this.level, engine = this.engine;
    this.world = level.world;
    const q = engine.quality.level;
    progress?.(0.05);
    const data = await buildData(q);
    progress?.(0.8);
    this.data = data;
    this.charShadow = new CharShadow(engine.renderer, q >= 2 ? 1024 : 512);
    this.mats = createExplorerMaterials(engine.renderer, q, this.charShadow.uniforms);
    const P = level.aesthetic?.palette;
    this.mats.env.setPalette(P);
    const dust = Array.isArray(P?.ground) ? P.ground[0] : P?.ground;
    if (dust) this.mats.uniforms.uDust.value.set(dust).lerp(_c.set('#8a7a62'), 0.4);
    this.rig = createExplorer(data, { body: this.mats.body, hard: this.mats.hard, visor: this.mats.visor, collar: this.mats.collar });
    for (const m of Object.values(this.rig.meshes)) { m.castShadow = true; m.receiveShadow = true; }
    this.group = this.rig.group;
    level.scene.add(this.group);
    this.anim = new Animator(this.rig);
    this.scarf = new Scarf(this.mats.scarf, q);
    level.scene.add(this.scarf.object);
    this._makeFlames();
    const gcol = new THREE.Color(dust || '#9a8a70').lerp(_c.set('#b8ab92'), 0.45);
    this.dust = new Dust(gcol);
    level.scene.add(this.dust.object);
    this.contact = new ContactShadow();
    level.scene.add(this.contact.object);
    this.catcher = new ShadowCatcher(this.charShadow.uniforms, q >= 2 ? 9 : 7);
    level.scene.add(this.catcher.object);
    this.ctl = new Controller(this.world);
    this.cam = new CameraRig(level.camera, this.world);
    // bind-space attachment points
    this.anchorsBind = [data.anchors.long, data.anchors.short].map((A) => A.map((p) => new THREE.Vector3(...p)));
    this.anchorsWorld = this.anchorsBind.map((A) => A.map(() => new THREE.Vector3()));
    this.proxies = data.proxies.map((p) => ({ bone: p.bone, a: new THREE.Vector3(...p.a), b: new THREE.Vector3(...p.b), r: p.r }));
    this.scarf.capsules = this.proxies.map((p) => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: p.r }));
    this.group.visible = false;
    this.scarf.object.visible = false;
    level.player = this;
    this.ready = true;
    progress?.(1);
  }

  _makeFlames() {
    // thruster plumes hang from the jetpack nozzles (children of the chest bone)
    const geo = new THREE.CylinderGeometry(0.03, 0.006, 0.42, 16, 6, true).translate(0, -0.21, 0);
    this.flames = [];
    const chest = this.rig.bones[B.chest];
    for (const n of this.data.nozzles) {
      const m = new THREE.Mesh(geo, this.mats.flame);
      // chest bind rotation is identity: local offset = bind − joint
      m.position.set(n[0], n[1], n[2]).sub(new THREE.Vector3(...this.data.spec.J.chest));
      m.renderOrder = 5;
      m.frustumCulled = false;
      m.visible = false;
      chest.add(m);
      this.flames.push(m);
    }
  }

  // =====================================================================================
  // Spawning / vehicles
  // =====================================================================================
  spawn(kind = 'surface') {
    this._ensureEffects();
    const V = this.level.vehicles;
    const list = V?.list || [];
    if (kind === 'orbit') {
      const ship = list.find((v) => v.type === 'ship');
      if (ship) { this.board(ship); return; }
      kind = 'surface';
    }
    if (kind === 'bike' || kind === 'ship') {
      const v = list.find((x) => x.type === kind);
      if (v) { this.board(v); return; }
      kind = 'surface';
    }
    const spot = this._surfaceSpot();
    this.ctl.place(spot.position, spot.facing);
    this._afterTeleport();
    this.cam.view = 'third';
    this.cam.snap(this.ctl.pos.clone().addScaledVector(this.ctl.up, this.cam.pivotHeight), this.ctl.up, this.ctl.facing, -0.1);
    this.vehicle = null;
    this.level.setMode('onfoot');
    if (this.engine.input.isTouch) this.engine.ui.hint('Left thumb to move · right to look · tap ⤒ to jump, hold to fly', 6000);
    else this.engine.ui.hint('WASD move · Shift sprint · Space jump (hold in air to fly) · V view · E interact', 6000);
  }

  /** A dry, gentle spot just outside the first settlement, facing it. */
  _surfaceSpot() {
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
    const facing = target.clone().sub(position);
    return { position, facing };
  }

  board(v) {
    if (!v) return;
    try { v.enter?.(this); } catch (e) { console.warn('[player] vehicle enter failed', e); }
    this.vehicle = v;
    this.cam.initialized = false;
    this.cam.idleLook = 10;
    this.cam.view = 'third';
    this.level.setMode(v.type === 'ship' ? 'ship' : 'bike');
    this.engine.audio.sfx?.('board');
    this._setPrompt(null);
  }

  alight() {
    const v = this.vehicle;
    if (!v) return;
    let exit = null;
    try { exit = v.exit?.(); } catch (e) { console.warn('[player] vehicle exit failed', e); }
    this.vehicle = null;
    const pos = exit?.isVector3 ? exit : (v.position || v.object3d?.position || this.position).clone().add(_v.set(2, 0, 0));
    const fwd = _v2.set(0, 0, 1).applyQuaternion(v.quaternion || v.object3d?.quaternion || _q.identity());
    this.ctl.place(pos, fwd);
    this._afterTeleport();
    this.cam.initialized = false;
    this.level.setMode('onfoot');
    this.engine.audio.sfx?.('alight');
  }

  /** The visor pass must run last in the HDR chain (after atmosphere/fog), so it is appended after collection. */
  _ensureEffects() {
    const fx = this.level.effects;
    if (Array.isArray(fx) && !fx.includes(this.visorFX)) fx.push(this.visorFX);
  }

  _afterTeleport() {
    this.position.copy(this.ctl.pos);
    this.up.copy(this.ctl.up);
    this._stepOff = 0;
    this._lastR = this.ctl.pos.length();
    this.scarf.ready = false;
  }

  handlesEscape() {
    if (this._card) { this.engine.ui.info(null); this._card = null; return true; }
    if (this.cam?.view === 'first' && this.engine.input.lastDevice === 'gamepad') { this.cam.view = 'third'; return true; }
    return false;
  }

  // =====================================================================================
  // Frame
  // =====================================================================================
  update(dt) {
    if (!this.ready) return;
    const input = this.engine.input;
    const level = this.level;
    const ctl = this.ctl;
    if (this.vehicle) {
      const v = this.vehicle;
      this.position.copy(v.position || v.object3d.position);
      this.velocity.copy(v.velocity || _v.set(0, 0, 0));
      this.up.copy(this.position).normalize();
      if (input.pressed('interact')) this.alight();
      return;
    }
    if (level.mode !== 'onfoot') return;

    if (input.pressed('toggleView')) {
      this.cam.view = this.cam.view === 'first' ? 'third' : 'first';
      this.cam.initialized = false;
    }
    // movement input (camera-relative)
    this.cam._transport(ctl.up);
    this.cam.basis(this._fwd, this._right);
    const analog = input.lastDevice === 'gamepad' || input.lastDevice === 'touch';
    const inp = {
      mx: input.move.x, my: input.move.y,
      sprint: input.down('sprint'), walk: input.down('crouch'),
      jumpPressed: input.pressed('jump'), jumpHeld: input.down('jump'),
      analog, touchFull: input.lastDevice === 'touch' && input.touch?.stick?.active,
    };
    if (this.shotPose && (Math.abs(inp.mx) + Math.abs(inp.my) > 0.05 || inp.jumpPressed)) this._endShotPose();
    ctl.frozen = !!this.shotPose;
    ctl.update(dt, inp, this._fwd, this._right);
    for (const e of ctl.events) this._onEvent(e);
    this.position.copy(ctl.pos);
    this.up.copy(ctl.up);
    this.velocity.copy(ctl.vel).addScaledVector(ctl.up, ctl.vUp);

    // camera look
    if (!level.freeCam) this.cam.look(input.look.x, input.look.y, dt);

    this._interactions(input);
  }

  _onEvent(e) {
    const audio = this.engine.audio;
    if (e.type === 'jump') { audio.sfx?.('jump'); }
    else if (e.type === 'land') {
      const imp = e.impact;
      if (imp > 3) {
        const r = this.anim.land(imp, e.speed);
        this.cam.addShake(clamp((imp - 4) / 14, 0, 1) * (r === 'roll' ? 0.6 : 1));
        audio.sfx?.('land', { intensity: clamp(imp / 15, 0, 1) });
      }
    } else if (e.type === 'splash') { audio.sfx?.('land', { intensity: 0.4 }); }
  }

  _setPrompt(key, text) {
    const id = key ? key + text : null;
    if (id === this._prompt) return;
    this._prompt = id;
    this.engine.ui.prompt(key || null, text);
  }

  _interactions(input) {
    const w = this.world;
    const pos = this.ctl.pos;
    const key = input.lastDevice === 'gamepad' ? 'X' : 'E';
    const V = this.level.vehicles;
    let veh = null;
    try { veh = V?.nearest?.(pos, 5) || null; } catch { veh = null; }
    if (veh && veh.canBoard && !veh.canBoard(pos)) veh = null;
    let poi = null;
    if (!veh) {
      poi = w.nearestPOI(pos, 40);
      if (poi && poi.position.distanceTo(pos) > Math.min(poi.radius ?? 30, 16)) poi = null;
    }
    if (veh) this._setPrompt(key, `Board ${veh.type === 'ship' ? 'ship' : 'bike'}`);
    else if (poi) this._setPrompt(key, `Read ${poi.title || 'inscription'}`);
    else this._setPrompt(null);
    if (input.pressed('interact')) {
      if (veh) this.board(veh);
      else if (poi) this._readPOI(poi);
    }
    // close the lore card when walking away
    if (this._card && this._card.position.distanceTo(pos) > 30) { this.engine.ui.info(null); this._card = null; }
  }

  _readPOI(poi) {
    const ui = this.engine.ui;
    ui.info({ subtitle: poi.kind || 'lore', title: poi.title || 'Inscription', text: poi.text || '' });
    this._card = poi;
    if (!poi.discovered) {
      poi.discovered = true;
      ui.toast('Discovered', poi.title || '', 4000);
      this.engine.audio.sfx?.('discover');
    }
  }

  // =====================================================================================
  // Late update: animation, cloth, camera, materials
  // =====================================================================================
  lateUpdate(dt, t) {
    if (!this.ready) return;
    const level = this.level, w = this.world;
    const U = this.mats.uniforms;
    U.uTime.value = t;
    if (this.vehicle || level.mode !== 'onfoot') this.contact.object.visible = false;
    if (this.vehicle) {
      this._teleOff = null;
      this._seatOnVehicle(dt);
      if (!level.freeCam) {
        const v = this.vehicle;
        this.cam.look(this.engine.input.look.x, this.engine.input.look.y, dt);
        this.cam.updateVehicle(v, v.cameraProfile, dt, this.up, this.engine.input.zoom);
      }
      this._updateMaterials(dt);
      this._renderShadow();
      return;
    }
    if (level.mode !== 'onfoot') { this.group.visible = false; this.scarf.object.visible = false; return; }
    const ctl = this.ctl;
    // on foot the HUD stays clean: drop any vehicle telemetry (ALT/THR) left behind
    if (this._teleOff !== level.mode) { this._teleOff = level.mode; this.engine.ui.telemetry?.(null); }
    const fpView = this.cam.view === 'first' && !level.freeCam;
    // first person: the eye sits where the helmet is, so the whole explorer is hidden
    // (a per-vertex cut leaves a jagged collar ring in view); the visor pass sells the helmet
    this.group.visible = !fpView;
    this.scarf.object.visible = !fpView;
    this.rig.meshes.visor.visible = !fpView;
    this.rig.meshes.collar.visible = !fpView;
    this.mats.uniforms.uFPHide.value = fpView ? 1 : 0;

    // ---- visual root (smoothed step-ups) ------------------------------------------------
    const r = ctl.pos.length();
    if (ctl.grounded && this._wasGrounded) {
      const dr = r - this._lastR;
      if (Math.abs(dr) < 0.7 && Math.abs(dr) > 0.03) this._stepOff -= dr;
    }
    this._stepOff *= Math.exp(-14 * dt);
    this._lastR = r; this._wasGrounded = ctl.grounded;
    const up = ctl.up, fwd = ctl.facing, left = ctl.left;
    this.group.position.copy(ctl.pos).addScaledVector(up, this._stepOff);
    _m.makeBasis(left, up, fwd);
    this.group.quaternion.setFromRotationMatrix(_m);
    this.group.updateMatrixWorld(true);

    // ---- animation ---------------------------------------------------------------------
    const sp = this.shotPose;
    const state = sp ? sp.state : (ctl.state === 'ground' ? 'ground' : ctl.state);
    // head look toward the camera aim (third person only when it's roughly ahead)
    const head = this.cam.heading;
    let lookYaw = Math.atan2(_v.crossVectors(fwd, head).dot(up), fwd.dot(head));
    if (Math.abs(lookYaw) > 1.9) lookYaw = 0;
    let lookPitch = this.cam.view === 'first' ? this.cam.pitch : this.cam.pitch * 0.45 + 0.05;
    if (sp?.look) { lookYaw = sp.look[0]; lookPitch = sp.look[1]; }
    const groundPos = this.group.position;
    const g = {};
    const self = this;
    this.anim.update({
      dt, speed: sp ? sp.speed : Math.hypot(ctl.vel.dot(fwd), ctl.vel.dot(left)),
      state, vy: ctl.vUp, accel: sp ? { x: 0, z: 0 } : ctl.accelLocal, turnRate: sp ? 0 : ctl.turnRate, leanAdd: sp?.leanAdd || 0,
      lookYaw, lookPitch, lookFree: !sp,
      groundFn(footPos, outN) {
        _v3.copy(groundPos).addScaledVector(left, footPos.x).addScaledVector(fwd, footPos.z).addScaledVector(up, 0.3);
        const gq = w.groundAt(_v3, g);
        outN.set(gq.normal.dot(left), gq.normal.dot(up), gq.normal.dot(fwd));
        return gq.radius - (r + self._stepOff);
      },
    });
    this.group.updateMatrixWorld(true);

    // ---- scarf ---------------------------------------------------------------------------
    this._stepScarf(dt);
    this._fx(dt, r);

    // ---- camera --------------------------------------------------------------------------
    if (!level.freeCam) {
      this.anim.pointOn(B.head, this._eyeBind, this._eye);
      this.group.localToWorld(this._eye);
      const glide = ctl.state === 'glide' ? 1 : ctl.state === 'jet' ? 0.4 : 0;
      this._glideF = (this._glideF || 0) + (glide - (this._glideF || 0)) * (1 - Math.exp(-3 * dt));
      this.cam.update({
        dt, pos: this.group.position, up, vel: ctl.vel, speed: ctl.speed,
        sprint: clamp((ctl.speed - SPEED.run) / (SPEED.sprint - SPEED.run), 0, 1), glide: this._glideF,
        eye: this._eye, zoom: this.engine.input.zoom, freeze: !!sp,
      });
    }
    this._updateMaterials(dt);
    this._renderShadow();
  }

  _renderShadow() {
    const sun = this.level.sun;
    if (this.catcher) this.catcher.object.visible = false;
    if (!sun || !this.group.visible || this.mats.uniforms.uFPHide.value > 0.5) { this.charShadow.uniforms.uCSOn.value = 0; return; }
    const L = _v.copy(sun.position).sub(sun.target.position);
    if (L.lengthSq() < 1e-8) { this.charShadow.uniforms.uCSOn.value = 0; return; }
    L.normalize();
    const on = sun.intensity > 0.02 && L.dot(this.up) > -0.05;
    for (const f of this.flames) f.userData.v = f.visible, f.visible = false;
    this.charShadow.render([this.group, this.scarf.object], _v2.copy(this.group.position).addScaledVector(this.up, 0.95), L, this.up, this.level.camera, on);
    for (const f of this.flames) f.visible = f.userData.v;
    // ground shadow catcher (on foot only): centred between the feet and the shadow tip
    const cat = this.catcher;
    const onFoot = on && !this.vehicle && this.level.mode === 'onfoot' && this.ctl.state !== 'swim';
    const alt = this.ctl.pos.length() - this.ctl.groundRadius;
    cat.object.visible = onFoot && alt < 4;
    if (cat.object.visible) {
      const up = this.ctl.up;
      const elev = clamp(L.dot(up), 0.05, 1);
      const sd = _v3.copy(L).negate().addScaledVector(up, elev);
      if (sd.lengthSq() < 1e-6) sd.copy(this.ctl.facing); else sd.normalize();
      const off = Math.min(1.5, 0.9 * Math.sqrt(1 - elev * elev) / elev);
      const ctr = _v2.copy(this.ctl.pos).addScaledVector(sd, off);
      const right = _v.crossVectors(sd, up).normalize();
      cat.update(this.world, ctr, up, right, sd);
      cat.material.uniforms.uStrength.value = 0.72 * THREE.MathUtils.smoothstep(elev, 0.05, 0.2) * clamp(this.world.daylight * 1.4, 0, 1) * clamp(1 - alt / 4, 0, 1);
    }
  }

  _fx(dt, r) {
    const ctl = this.ctl, w = this.world, anim = this.anim, up = ctl.up;
    // footstep dust + sounds
    const dry = !(ctl.waterRadius > r - 0.05);
    for (const e of anim.stepEvents) {
      if (!this.shotPose) this.engine.audio.sfx?.('step', { intensity: clamp(e.speed / 11, 0.2, 1) });
      if (!dry || e.speed < 3.2) continue;
      const fb = e.foot === 0 ? B.footL : B.footR;
      const p = this.group.localToWorld(_v.copy(anim.P[fb]).setY(0.03));
      this.dust.emit(p, up, e.speed > 8 ? 6 : 3, 0.5 + e.speed * 0.08, 0.2 + e.speed * 0.012, 1.1, _v2.copy(ctl.vel).multiplyScalar(0.12));
    }
    for (const e of ctl.events) if (e.type === 'land' && e.impact > 5 && dry) this.dust.emit(_v.copy(ctl.pos).addScaledVector(up, 0.05), up, Math.min(18, 6 + e.impact), 1.6 + e.impact * 0.08, 0.32, 1.4);
    if (ctl.state === 'slide' && dry && Math.random() < dt * 30) this.dust.emit(_v.copy(ctl.pos).addScaledVector(up, 0.05), up, 1, 0.6, 0.35, 1.2, _v2.copy(ctl.vel).multiplyScalar(0.3));
    this.dust.uniforms.uLight.value.setScalar(0.12 + 1.5 * w.daylight);
    this.dust.update(dt, ctl.pos, w.wind);
    // contact shadow
    const alt = r - ctl.groundRadius;
    const cs = this.contact;
    const k = clamp(1 - alt / 2.2, 0, 1) * (ctl.state === 'swim' ? 0 : 1) * (0.7 + 0.3 * w.daylight);
    cs.object.visible = k > 0.01;
    if (cs.object.visible) {
      const n = ctl.groundNormal;
      const fwd = _v.copy(ctl.facing).addScaledVector(n, -ctl.facing.dot(n)).normalize();
      const left = _v2.crossVectors(n, fwd).normalize();
      _m.makeBasis(left, n, fwd);
      cs.object.quaternion.setFromRotationMatrix(_m);
      cs.object.position.copy(ctl.pos).setLength(ctl.groundRadius + 0.02);
      // ambient-occlusion footprint: stretched along the stride
      const s = 1.2 * (1 + alt * 0.25);
      const str = 1 + clamp(anim.speed / 8, 0, 0.45);
      cs.object.scale.set(s, 1, s * str);
      const fl = anim.P[B.footL], fr = anim.P[B.footR];
      cs.material.uniforms.uFeet.value.set(fl.x / (0.5 * s), -fl.z / (0.5 * s * str), fr.x / (0.5 * s), -fr.z / (0.5 * s * str));
      cs.material.uniforms.uStrength.value = 0.95 * k;
    }
  }

  _stepScarf(dt) {
    const anim = this.anim, grp = this.group, ctl = this.ctl, w = this.world;
    for (let k = 0; k < 2; k++) {
      for (let j = 0; j < this.anchorsBind[k].length; j++) {
        const o = this.anchorsWorld[k][j];
        anim.pointOn(B.chest, this.anchorsBind[k][j], o);
        grp.localToWorld(o);
      }
    }
    for (let i = 0; i < this.proxies.length; i++) {
      const p = this.proxies[i], c = this.scarf.capsules[i];
      grp.localToWorld(anim.pointOn(p.bone, p.a, c.a));
      grp.localToWorld(anim.pointOn(p.bone, p.b, c.b));
    }
    const S = this.scarf;
    S.up.copy(ctl.up);
    S.gravity = w.gravity;
    const ws = 1.0 + w.windStrength * 3.0;
    S.wind.copy(w.wind).addScaledVector(ctl.up, -w.wind.dot(ctl.up));
    if (S.wind.lengthSq() > 1e-8) S.wind.normalize().multiplyScalar(ws); else S.wind.set(0, 0, 0);
    S.gust = 0.45;
    S.groundR = ctl.state === 'swim' ? 0 : ctl.groundRadius;
    if (this.shotPose) {
      // posed "running": the air streams from the front; ambient wind only adds a sideways lift
      const sp = this.shotPose.air ?? this.shotPose.speed;
      S.airOffset.copy(ctl.facing).multiplyScalar(-sp * 0.95);
      const along = S.wind.dot(ctl.facing);
      S.wind.addScaledVector(ctl.facing, -along);
      const cap = 0.3 * Math.max(sp, 1.5);
      if (S.wind.length() > cap) S.wind.setLength(cap);
    } else S.airOffset.set(0, 0, 0);
    // screenshot poses: once settled the cloth holds its (rippled) instant, so temporal AA
    // never smears a moving ribbon across a frozen frame
    const hold = this.shotPose && this.engine.shotMode && S.ready && this._scarfHeld;
    if (!S.ready || this._scarfTeleport()) {
      S.reset(this.anchorsWorld, _v.copy(ctl.facing).negate(), ctl.up);
      this._scarfRef = this.anchorsWorld[0][0].clone();
      // settle
      for (let i = 0; i < (this.engine.shotMode ? 150 : 30); i++) S.step(1 / 60, this.anchorsWorld);
      this._scarfHeld = !!this.shotPose;
    }
    if (!this.shotPose) this._scarfHeld = false;
    if (!hold) S.step(dt, this.anchorsWorld);
    this._scarfRef = (this._scarfRef || new THREE.Vector3()).copy(this.anchorsWorld[0][0]);
    S.updateGeometry(this.group.position);
  }

  _scarfTeleport() {
    return this._scarfRef && this._scarfRef.distanceToSquared(this.anchorsWorld[0][0]) > 9;
  }

  _seatOnVehicle(dt) {
    const v = this.vehicle;
    const obj = v.object3d;
    if (!obj || v.type === 'ship' || !v.seat) { this.group.visible = false; this.scarf.object.visible = false; return; }
    obj.updateMatrixWorld();
    this.group.visible = true;
    this.scarf.object.visible = true;
    this.rig.meshes.visor.visible = true; this.rig.meshes.collar.visible = true;
    this.mats.uniforms.uFPHide.value = 0;
    this.group.position.copy(v.seat).applyMatrix4(obj.matrixWorld);
    this.group.quaternion.copy(obj.getWorldQuaternion(_q));
    this.group.updateMatrixWorld(true);
    this.anim.update({ dt, speed: 0, state: 'ride', vy: 0, accel: { x: 0, z: 0 }, turnRate: 0, lookYaw: 0, lookPitch: 0 });
    this.ctl.up.copy(this.position).normalize();
    this.ctl.facing.set(0, 0, 1).applyQuaternion(this.group.quaternion);
    this._stepScarf(dt);
  }

  _updateMaterials(dt) {
    const U = this.mats.uniforms, w = this.world, cam = this.level.camera;
    // first-person visor pass
    const fp = !this.vehicle && this.level.mode === 'onfoot' && this.cam.view === 'first' && !this.level.freeCam;
    this.visorFX.enabled = fp;
    if (fp) {
      const up = this.up, north = _v.set(0, 1, 0).addScaledVector(up, -up.y);
      if (north.lengthSq() < 1e-6) north.set(1, 0, 0);
      north.normalize();
      const east = _v2.crossVectors(north, up);
      const h = this.cam.heading;
      this.visorFX.material.uniforms.uHeading.value = Math.atan2(h.dot(east), h.dot(north));
      const sky = this.level.lighting?.skyColor;
      if (sky) this.visorFX.material.uniforms.uSheen.value.copy(sky).multiplyScalar(1.5);
    }
    const st = this.vehicle ? 'ride' : this.ctl.state;
    const jet = st === 'jet' ? 1 : st === 'glide' ? 0.12 : 0;
    this._jet += (jet - this._jet) * (1 - Math.exp(-10 * dt));
    U.uJet.value = this._jet;
    for (const f of this.flames) f.visible = this._jet > 0.02 && !fp;
    const night = 1 - w.daylight;
    const glow = st === 'glide' ? 1 : st === 'jet' ? 0.5 : 0.08 + night * 0.35;
    this._glow += (glow - this._glow) * (1 - Math.exp(-4 * dt));
    U.uGlow.value = this._glow;
    // rim: sun-tinted by day, a cool sliver of sky light at night
    const sun = this.level.sun;
    const L = this.level.lighting;
    const key = L?.keyColor ? _c2.copy(L.keyColor) : _c2.copy(sun.color).multiplyScalar(sun.intensity);
    const skyC = L?.skyColor || _c3.setRGB(0.3, 0.45, 0.7).multiplyScalar(w.daylight);
    // rim: key-tinted by day, sky-fed under overcast, a cool sliver of sky light at night
    addSc(U.uRim.value.copy(key).multiplyScalar(0.16), skyC, 0.5).add(_c.setRGB(0.012, 0.018, 0.03).multiplyScalar(0.4 + night));
    // character kicker: behind-side, on the sun's side of the frame (view space)
    const sv = _v3.copy(w.sunDir).transformDirection(cam.matrixWorldInverse);
    const side = sv.x >= 0 ? 1 : -1;
    U.uKickDir.value.set(0.78 * side, 0.42, -0.46).normalize();
    addSc(U.uKick.value.copy(key).multiplyScalar(0.24), skyC, 0.45).add(_c.setRGB(0.02, 0.03, 0.05).multiplyScalar(night));
    U.uSunView.value.copy(w.sunDir).transformDirection(cam.matrixWorldInverse);
    // accent lines read stronger at night
    // ...and breathe slowly (0.25 Hz), flaring while sprinting / flying
    const spr = this.vehicle ? 0 : clamp((this.ctl.speed - SPEED.run) / (SPEED.sprint - SPEED.run), 0, 1);
    const breathe = 1 + 0.14 * Math.sin(U.uTime.value * Math.PI * 0.5) + 0.35 * spr + 0.5 * this._jet;
    U.uAccent.value.copy(this.mats.accentBase || (this.mats.accentBase = U.uAccent.value.clone())).multiplyScalar((0.8 + night * 0.6) * breathe);
    // Image-based light: prefer the level's sky-derived environment (physically
    // consistent with the atmosphere); fall back to our small gradient sky.
    const ext = this.level.lighting?.envMap || null;
    if (ext) {
      if (this._extEnv !== ext) { for (const m of this.mats.env.materials) m.envMap = ext; this._extEnv = ext; }
    } else {
      if (this._extEnv) { this._extEnv = null; this.mats.env.update(this.up, w.sunDir, w.daylight, true); }
      else this.mats.env.update(this.up, w.sunDir, w.daylight);
    }
  }

  // =====================================================================================
  // Screenshot presets
  // =====================================================================================
  /** Pick a camera yaw around the settlement direction that gives a clean, open hero frame. */
  _searchHeroYaw(siteDir, up, target, dist, pivotH, shoulder) {
    const w = this.world, pos = this.ctl.pos;
    const cands = [0.32, 0.22, 0.44, 0.12, 0.56, 0.0, 0.7, -0.15, 0.86, -0.3, 1.05];
    let best = null;
    const dir = new THREE.Vector3(), cp = new THREE.Vector3(), right = new THREE.Vector3();
    for (const a of cands) {
      const camH = siteDir.clone().applyAxisAngle(up, a);
      right.crossVectors(camH, up).normalize();
      const piv = pos.clone().addScaledVector(up, pivotH).addScaledVector(right, shoulder);
      cp.copy(piv).addScaledVector(camH, -dist);
      let score = -Math.abs(a - 0.3) * 1.5;
      // the spring arm itself must be clear
      const back = w.raycast(piv, dir.copy(camH).negate(), dist + 0.4);
      if (back) score -= 3;
      // near occluders across the frame (cliffs, walls): 5 x 3 grid of terrain rays
      for (let i = -2; i <= 2; i++) for (let j = 0; j < 3; j++) {
        dir.copy(camH).applyAxisAngle(up, -i * 0.28).addScaledVector(up, 0.02 + j * 0.16).normalize();
        const h = w.raycast(cp, dir, 30);
        if (h) score -= ((30 - h.distance) / 30) * (j === 0 ? 0.5 : 1.0);
      }
      // the settlement should rise above the horizon line, not hide behind a hill
      const toT = dir.copy(target).addScaledVector(up, 12).sub(cp);
      const tl = toT.length();
      const hs = w.raycast(cp, toT.normalize(), tl);
      if (hs && hs.distance < tl * 0.9) score -= 2.5;
      if (!best || score > best.score) best = { score, camH };
    }
    return best.camH;
  }

  _endShotPose() {
    this.shotPose = null;
    if (this._shotPivot != null) { this.cam.pivotHeight = this._shotPivot; this._shotPivot = null; }
    this.cam.distance = 3.6; this.cam.shoulder = 0.38;
    this.anim.freezePhase = false;
    this.ctl.frozen = false;
  }

  async shot(name, spot) {
    if (!this.ready || !spot) return false;
    if (!['character', 'fp', 'vista', 'night'].includes(name)) return false;
    this._ensureEffects();
    const level = this.level, w = this.world;
    level.freeCam = null;
    if (this.vehicle) {
      const v = this.vehicle;
      this.vehicle = null;
      try { v.exit?.(); } catch { /* ignore */ }
      this.engine.ui.telemetry?.(null);
    }
    const target = (spot.site?.position || spot.lookAt).clone();
    const toSite = target.clone().sub(spot.position);
    this.ctl.place(spot.position, toSite);
    this._afterTeleport();
    level.setMode('onfoot');
    const up = this.ctl.up;
    const siteDir = toSite.clone().addScaledVector(up, -toSite.dot(up)).normalize();
    const turn = (v, a) => v.clone().applyAxisAngle(up, a);
    const cam = this.cam;
    cam.initialized = false;
    if (this._shotPivot != null) { cam.pivotHeight = this._shotPivot; this._shotPivot = null; }
    this.anim.freezePhase = false;
    if (name === 'character') {
      // 3/4-rear hero framing (Jedi Survivor / Death Stranding): the explorer jogs on the
      // left third toward the settlement on the right third, caught at foot contact (one
      // heel planted, rear foot just off the ground), leaning into the stride, scarf
      // streaming back toward the lens. The camera yaw is searched for a clean frame:
      // no near cliffs / walls filling the view, settlement visible over the terrain.
      const portrait = this.level.camera.aspect < 1;
      const speed = 3.7;
      const gait = THREE.MathUtils.smoothstep(speed, 2.6, 4.6);
      const duty = THREE.MathUtils.lerp(0.6, 0.29, gait);
      this.shotPose = { state: 'ground', speed, look: [-0.5, 0.02], leanAdd: 0.06, air: 4.4 };
      cam.view = 'third';
      cam.distance = portrait ? 3.1 : 2.85; cam.shoulder = portrait ? 0.1 : 0.82;
      this._shotPivot = this._shotPivot ?? cam.pivotHeight;
      cam.pivotHeight = portrait ? 1.3 : 1.22;
      const camH = this._searchHeroYaw(siteDir, up, target, cam.distance, cam.pivotHeight, cam.shoulder);
      this.ctl.setFacing(turn(camH, -0.62));
      this.anim.phase = duty * 0.14;
      this.anim.freezePhase = true;
      cam.snap(this.ctl.pos, up, camH, -0.02);
    } else if (name === 'fp') {
      this.shotPose = { state: 'ground', speed: 0, look: [0, -0.05] };
      this.ctl.setFacing(siteDir);
      cam.view = 'first';
      cam.snap(this.ctl.pos, up, siteDir, -0.06);
    } else if (name === 'vista') {
      this.shotPose = { state: 'ground', speed: 0, look: [0.35, 0.08] };
      this.ctl.setFacing(turn(siteDir, 0.15));
      this.anim.idleTime = 0;
      cam.view = 'third'; cam.distance = 5.2; cam.shoulder = 0.9;
      cam.snap(this.ctl.pos, up, turn(siteDir, -0.18), 0.02);
    } else if (name === 'night') {
      this.shotPose = { state: 'ground', speed: 0, look: [0.5, 0.45] };
      this.ctl.setFacing(turn(siteDir, 0.6));
      cam.view = 'third'; cam.distance = 3.4; cam.shoulder = 0.5;
      cam.snap(this.ctl.pos, up, turn(siteDir, -0.3), 0.28);
    }
    this.ctl.frozen = true;
    this.ctl.vel.set(0, 0, 0); this.ctl.vUp = 0;
    // converge the animation (smoothed params), the cloth and the environment
    const a = this.anim;
    a.speed = this.shotPose.speed; a.gait = THREE.MathUtils.smoothstep(a.speed, 2.6, 4.6); a.sprint = 0;
    a.lean = clamp(a.speed * 0.045 + (this.shotPose.leanAdd || 0), -0.25, 0.42); a.bank = 0;
    a.lookYaw = this.shotPose.look[0]; a.lookPitch = this.shotPose.look[1];
    for (const k in a.w) a.w[k] = k === 'loco' ? 1 : 0;
    this.scarf.ready = false;
    this.mats.env.update(up, w.sunDir, w.daylight, true);
    for (let i = 0; i < 3; i++) this.lateUpdate(1 / 60, this.engine.time);
    return true;
  }

  dispose() {
    this.level.scene.remove(this.group);
    this.level.scene.remove(this.scarf?.object);
    this.scarf?.dispose();
    this.mats?.env.dispose();
    this.charShadow?.dispose();
    this.dust?.dispose(); this.contact?.dispose(); this.catcher?.dispose();
    if (this.catcher) this.level.scene.remove(this.catcher.object);
    if (this.dust) this.level.scene.remove(this.dust.object);
    if (this.contact) this.level.scene.remove(this.contact.object);
    this.visorFX.dispose();
    const fx = this.level.effects; if (Array.isArray(fx)) { const i = fx.indexOf(this.visorFX); if (i >= 0) fx.splice(i, 1); }
    for (const m of Object.values(this.rig?.meshes || {})) m.geometry.dispose();
    this.engine.ui.prompt(null);
    if (this.level.player === this) this.level.player = null;
  }
}
