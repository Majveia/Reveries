// Unified input: keyboard + mouse (pointer lock) + gamepad + touch.
//
// Consumers read *intent*, never raw devices:
//   input.move.x / input.move.y  — strafe / forward in [-1,1] (+y = forward)
//   input.look.x / input.look.y  — radians this frame (+x = right, +y = up)
//   input.zoom                    — zoom delta this frame (+ = zoom out / farther)
//   input.down('jump'), input.pressed('interact'), input.released('sprint')
//   input.click → {x, y, ndcX, ndcY} | null for a tap/click this frame
//   input.doubleClick → same, for double click / double tap
//
// Modes (set by the active level / controller):
//   'orbit' — map levels: drag rotates, wheel/pinch zooms, right-drag pans, tap selects
//   'game'  — on foot / vehicles: pointer-lock mouse look, touch = floating
//             joystick (left) + look pad (right)

const BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['KeyC', 'ControlLeft'],
  interact: ['KeyE', 'KeyF'],
  toggleView: ['KeyV'],
  map: ['KeyM', 'Tab'],
  escape: ['Escape', 'Backspace'],
  travel: ['Enter', 'NumpadEnter'],
  rollLeft: ['KeyQ'],
  rollRight: ['KeyR'],
  photo: ['KeyH'],
  timeFaster: ['Period'],
  timeSlower: ['Comma'],
  light: ['KeyL'],
  help: ['Slash'],
  brake: ['KeyX'],
};

// Standard gamepad mapping → actions
const PAD_BUTTONS = {
  0: 'jump', 1: 'crouch', 2: 'interact', 3: 'toggleView',
  4: 'rollLeft', 5: 'rollRight', 6: 'brake', 7: 'sprint',
  8: 'map', 9: 'escape', 10: 'sprint', 11: 'photo',
  14: 'timeSlower', 15: 'timeFaster',
};
// D-pad up/down zoom in map levels; in game modes they are help / light.
const PAD_DPAD_GAME = { 12: 'help', 13: 'light' };

// Radial dead zone with a smooth response curve (no axis snapping, no
// "square gate" diagonals). Returns [x, y] in the unit disc.
const RADIAL_INNER = 0.14, RADIAL_OUTER = 0.94;
function radial(x, y, expo) {
  const l = Math.hypot(x, y);
  if (l < RADIAL_INNER) return [0, 0];
  const n = Math.min(1, (l - RADIAL_INNER) / (RADIAL_OUTER - RADIAL_INNER));
  const c = expo ? n * (0.35 + 0.65 * n) : n; // blend linear → quadratic for fine aim
  const k = c / l;
  return [x * k, y * k];
}
export { BINDINGS, PAD_BUTTONS };

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.mode = 'orbit';
    this.isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.lastDevice = this.isTouch ? 'touch' : 'keyboard'; // 'keyboard' | 'touch' | 'gamepad'
    this.sensitivity = { mouse: 0.0022, touch: 0.0058, pad: 2.8 };
    this.baseSensitivity = { ...this.sensitivity };
    this.invertY = false;
    this.touchAccel = 0.9; // extra gain for fast flicks on the look pad
    this._padHold = 0; // seconds the look stick has been pinned (turn acceleration)
    this._lockReleasedAt = -1e9;
    this.gamepadId = '';

    this.move = { x: 0, y: 0 };
    this.look = { x: 0, y: 0 };
    this.pan = { x: 0, y: 0 };
    this.zoom = 0;
    this.throttle = 0; // gamepad triggers (RT - LT) for vehicles
    this.click = null;
    this.doubleClick = null;
    this.pointer = { x: 0, y: 0, ndcX: 0, ndcY: 0, inside: false, buttons: 0 };
    this.pointerLocked = false;
    this.enabled = true;

    this._keys = new Set();
    this._down = new Map(); // action → count of sources holding it
    this._pressed = new Set();
    this._released = new Set();
    this._virtual = new Set();
    this._padPrev = new Set();
    this._lookAcc = { x: 0, y: 0 };
    this._panAcc = { x: 0, y: 0 };
    this._zoomAcc = 0;
    this._lastClickTime = 0;
    this._lastClickPos = { x: -1e4, y: -1e4 };

    // Touch state (exposed for the UI to draw the joystick).
    this.touch = {
      stick: { active: false, id: -1, ox: 0, oy: 0, x: 0, y: 0, radius: 54 },
      lookId: -1, lookX: 0, lookY: 0,
      pinch: null, // {d, cx, cy}
      points: new Map(),
    };

    this._keyToActions = new Map();
    for (const [action, keys] of Object.entries(BINDINGS)) for (const k of keys) {
      if (!this._keyToActions.has(k)) this._keyToActions.set(k, []);
      this._keyToActions.get(k).push(action);
    }
    this._bind();
  }

  // ---- public API -----------------------------------------------------------
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== 'game' && this.pointerLocked) document.exitPointerLock?.();
    this._resetTouch();
  }
  down(action) { return (this._down.get(action) || 0) > 0 || this._virtual.has(action); }
  pressed(action) { return this._pressed.has(action); }
  released(action) { return this._released.has(action); }
  /** UI touch buttons call this. */
  setVirtual(action, isDown) {
    if (isDown && !this._virtual.has(action)) { this._virtual.add(action); this._pressed.add(action); }
    else if (!isDown && this._virtual.has(action)) { this._virtual.delete(action); this._released.add(action); }
  }
  tapVirtual(action) { this._pressed.add(action); this._released.add(action); }
  requestPointerLock() {
    if (this.isTouch || this.pointerLocked) return;
    try { const p = this.canvas.requestPointerLock?.({ unadjustedMovement: true }); p?.catch?.(() => this.canvas.requestPointerLock?.()); } catch { /* ignore */ }
  }
  exitPointerLock() { if (this.pointerLocked) document.exitPointerLock?.(); }
  /** Sensitivity multipliers (1 = default) — settings menu. */
  setSensitivity({ mouse, touch, pad } = {}) {
    const b = this.baseSensitivity;
    if (mouse != null) this.sensitivity.mouse = b.mouse * mouse;
    if (touch != null) this.sensitivity.touch = b.touch * touch;
    if (pad != null) this.sensitivity.pad = b.pad * pad;
  }
  /** Haptics: phone vibration or gamepad rumble. intensity 0..1, ms duration. */
  rumble(intensity = 0.5, ms = 40) {
    if (this.hapticsOff) return;
    try {
      if (this.lastDevice === 'gamepad') {
        const gp = [...(navigator.getGamepads?.() || [])].find((p) => p && p.connected);
        gp?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: intensity, weakMagnitude: Math.min(1, intensity * 1.4) })?.catch?.(() => {});
      } else if (this.lastDevice === 'touch' && navigator.vibrate) navigator.vibrate(Math.max(8, Math.round(ms * (0.4 + intensity * 0.6))));
    } catch { /* haptics are best effort */ }
  }

  /** Call once per frame before game logic. */
  update(dt) {
    this._pollGamepad(dt);
    // keyboard move vector
    let mx = 0, my = 0;
    if (this.down('right')) mx += 1;
    if (this.down('left')) mx -= 1;
    if (this.down('forward')) my += 1;
    if (this.down('back')) my -= 1;
    // touch joystick
    const st = this.touch.stick;
    if (st.active) {
      const vx = (st.x - st.ox) / st.radius, vy = -(st.y - st.oy) / st.radius;
      const len = Math.hypot(vx, vy);
      const k = len > 1 ? 1 / len : 1;
      const dead = 0.12;
      const l2 = Math.min(1, len);
      const s = l2 < dead ? 0 : (l2 - dead) / (1 - dead) / Math.max(l2, 1e-5);
      mx += vx * k * s * l2; my += vy * k * s * l2;
    }
    mx += this._padMove?.x || 0; my += this._padMove?.y || 0;
    const ml = Math.hypot(mx, my);
    if (ml > 1) { mx /= ml; my /= ml; }
    this.move.x = mx; this.move.y = my;

    this.look.x = this._lookAcc.x + (this._padLook?.x || 0);
    this.look.y = (this._lookAcc.y + (this._padLook?.y || 0)) * (this.invertY ? -1 : 1);
    this.pan.x = this._panAcc.x; this.pan.y = this._panAcc.y;
    this.zoom = this._zoomAcc + (this._padZoom || 0);
  }

  /** Call once per frame after everything consumed input. */
  endFrame() {
    this._pressed.clear();
    this._released.clear();
    this._lookAcc.x = this._lookAcc.y = 0;
    this._panAcc.x = this._panAcc.y = 0;
    this._zoomAcc = 0;
    this.click = null;
    this.doubleClick = null;
  }

  // ---- internals ------------------------------------------------------------
  _isUI(target) { return target && target.closest && target.closest('[data-ui]'); }

  _actionDown(action) {
    const c = this._down.get(action) || 0;
    if (c === 0) this._pressed.add(action);
    this._down.set(action, c + 1);
  }
  _actionUp(action) {
    const c = this._down.get(action) || 0;
    if (c <= 1) { this._down.delete(action); if (c === 1) this._released.add(action); }
    else this._down.set(action, c - 1);
  }

  _emitClick(x, y) {
    const r = this.canvas.getBoundingClientRect();
    const c = { x, y, ndcX: ((x - r.left) / r.width) * 2 - 1, ndcY: -((y - r.top) / r.height) * 2 + 1 };
    const now = performance.now();
    if (now - this._lastClickTime < 340 && Math.hypot(x - this._lastClickPos.x, y - this._lastClickPos.y) < 28) {
      this.doubleClick = c; this._lastClickTime = 0;
    } else { this._lastClickTime = now; this._lastClickPos = { x, y }; }
    this.click = c;
  }

  _setPointer(x, y) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.x = x; this.pointer.y = y;
    this.pointer.ndcX = ((x - r.left) / r.width) * 2 - 1;
    this.pointer.ndcY = -((y - r.top) / r.height) * 2 + 1;
  }

  _bind() {
    const opts = { passive: false };
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || e.target?.tagName === 'INPUT') return;
      this.lastDevice = 'keyboard';
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (e.repeat || this._keys.has(e.code)) return;
      // Esc while the mouse is captured only releases the pointer — it must not
      // also leave the planet.
      if (e.code === 'Escape' && (this.pointerLocked || performance.now() - this._lockReleasedAt < 300)) return;
      this._keys.add(e.code);
      const acts = this._keyToActions.get(e.code);
      if (acts) for (const a of acts) this._actionDown(a);
    });
    window.addEventListener('keyup', (e) => {
      if (!this._keys.has(e.code)) return;
      this._keys.delete(e.code);
      const acts = this._keyToActions.get(e.code);
      if (acts) for (const a of acts) this._actionUp(a);
    });
    window.addEventListener('blur', () => {
      for (const k of this._keys) { const acts = this._keyToActions.get(k); if (acts) for (const a of acts) this._actionUp(a); }
      this._keys.clear(); this._virtual.clear(); this._resetTouch();
    });

    document.addEventListener('pointerlockchange', () => {
      const was = this.pointerLocked;
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (was && !this.pointerLocked) this._lockReleasedAt = performance.now();
    });

    // ---- mouse ----
    let dragStart = null, dragMoved = 0;
    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this.lastDevice = 'keyboard';
      this.pointer.buttons = e.buttons;
      dragStart = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button };
      dragMoved = 0;
      if (e.button === 0) this._actionDown('primary');
      if (e.button === 2) this._actionDown('secondary');
    });
    window.addEventListener('mouseup', (e) => {
      this.pointer.buttons = e.buttons;
      if (e.button === 0) this._actionUp('primary');
      if (e.button === 2) this._actionUp('secondary');
      if (dragStart && e.button === dragStart.button && e.button === 0 && dragMoved < 6 && performance.now() - dragStart.t < 450) {
        if (this.mode === 'game' && !this.pointerLocked && !this.isTouch) this.requestPointerLock();
        else this._emitClick(e.clientX, e.clientY);
      }
      dragStart = null;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      this._setPointer(e.clientX, e.clientY);
      const s = this.sensitivity.mouse;
      if (this.pointerLocked) {
        this._lookAcc.x += e.movementX * s;
        this._lookAcc.y -= e.movementY * s;
        return;
      }
      if (dragStart) {
        dragMoved += Math.abs(e.movementX) + Math.abs(e.movementY);
        if (dragStart.button === 0) { this._lookAcc.x += e.movementX * s * 1.6; this._lookAcc.y -= e.movementY * s * 1.6; }
        else { this._panAcc.x += e.movementX; this._panAcc.y += e.movementY; }
      }
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this._zoomAcc += Math.max(-3, Math.min(3, d / 100));
    }, opts);

    // ---- touch ----
    this.canvas.addEventListener('touchstart', (e) => this._onTouchStart(e), opts);
    this.canvas.addEventListener('touchmove', (e) => this._onTouchMove(e), opts);
    this.canvas.addEventListener('touchend', (e) => this._onTouchEnd(e), opts);
    this.canvas.addEventListener('touchcancel', (e) => this._onTouchEnd(e), opts);

    window.addEventListener('gamepadconnected', () => { this.lastDevice = 'gamepad'; });
  }

  _resetTouch() {
    const t = this.touch;
    t.stick.active = false; t.stick.id = -1; t.lookId = -1; t.pinch = null; t.points.clear();
  }

  _onTouchStart(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this.isTouch = true; this.lastDevice = 'touch';
    const t = this.touch, W = window.innerWidth;
    for (const tc of e.changedTouches) {
      t.points.set(tc.identifier, { x: tc.clientX, y: tc.clientY, sx: tc.clientX, sy: tc.clientY, t0: performance.now(), moved: 0 });
      this._setPointer(tc.clientX, tc.clientY);
      if (this.mode === 'game') {
        if (tc.clientX < W * 0.42 && !t.stick.active) {
          Object.assign(t.stick, { active: true, id: tc.identifier, ox: tc.clientX, oy: tc.clientY, x: tc.clientX, y: tc.clientY });
        } else if (t.lookId === -1) {
          t.lookId = tc.identifier; t.lookX = tc.clientX; t.lookY = tc.clientY;
        }
      }
    }
    const pts = [...t.points.values()];
    if (pts.length === 2 && (this.mode === 'orbit' || (t.lookId !== -1 && !t.stick.active))) {
      const [a, b] = pts;
      t.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    }
  }

  _onTouchMove(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const t = this.touch, s = this.sensitivity.touch;
    for (const tc of e.changedTouches) {
      const p = t.points.get(tc.identifier);
      if (!p) continue;
      const dx = tc.clientX - p.x, dy = tc.clientY - p.y;
      p.moved += Math.abs(dx) + Math.abs(dy);
      p.x = tc.clientX; p.y = tc.clientY;
      if (t.stick.active && tc.identifier === t.stick.id) {
        t.stick.x = tc.clientX; t.stick.y = tc.clientY;
        // Floating stick: drag the origin along if finger goes far beyond radius.
        const vx = t.stick.x - t.stick.ox, vy = t.stick.y - t.stick.oy, l = Math.hypot(vx, vy), R = t.stick.radius * 1.35;
        if (l > R) { t.stick.ox += (vx / l) * (l - R); t.stick.oy += (vy / l) * (l - R); }
      } else if (!t.pinch && (this.mode === 'orbit' || tc.identifier === t.lookId)) {
        // Acceleration curve: slow drags stay precise, fast flicks turn far.
        const now = performance.now(), dtm = Math.max(4, now - (p.tm || now - 16)); p.tm = now;
        const speed = Math.hypot(dx, dy) / dtm; // px per ms
        const g = this.mode === 'game' ? 1 + this.touchAccel * Math.min(1, Math.max(0, (speed - 0.25) / 1.6)) ** 1.5 : 1;
        this._lookAcc.x += dx * s * g; this._lookAcc.y -= dy * s * g;
      }
    }
    if (t.pinch) {
      const pts = [...t.points.values()];
      if (pts.length >= 2) {
        const [a, b] = pts;
        const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        if (d > 0 && t.pinch.d > 0) this._zoomAcc += Math.log(t.pinch.d / d) * 4.0;
        this._panAcc.x += cx - t.pinch.cx; this._panAcc.y += cy - t.pinch.cy;
        t.pinch.d = d; t.pinch.cx = cx; t.pinch.cy = cy;
      }
    }
  }

  _onTouchEnd(e) {
    e.preventDefault();
    const t = this.touch;
    for (const tc of e.changedTouches) {
      const p = t.points.get(tc.identifier);
      t.points.delete(tc.identifier);
      if (tc.identifier === t.stick.id) { t.stick.active = false; t.stick.id = -1; }
      else if (tc.identifier === t.lookId) t.lookId = -1;
      if (p && p.moved < 12 && performance.now() - p.t0 < 350 && !t.pinch && tc.identifier !== t.stick.id) {
        this._emitClick(tc.clientX, tc.clientY);
      }
    }
    if (t.points.size < 2) t.pinch = null;
  }

  _pollGamepad(dt) {
    this._padMove = null; this._padLook = null; this._padZoom = 0; this.throttle = 0;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = [...pads].find((p) => p && p.connected);
    const now = new Set();
    if (gp) {
      const ax = gp.axes;
      this.gamepadId = gp.id || '';
      const [mx, my0] = radial(ax[0] || 0, ax[1] || 0, false);
      const [lx, ly0] = radial(ax[2] || 0, ax[3] || 0, true);
      const my = -my0, ly = -ly0;
      if (mx || my || lx || ly) this.lastDevice = 'gamepad';
      this._padMove = { x: mx, y: my };
      // Turn acceleration: holding the look stick at the rim ramps up yaw speed.
      const ll = Math.hypot(lx, ly);
      this._padHold = ll > 0.92 ? Math.min(0.6, this._padHold + dt) : Math.max(0, this._padHold - dt * 3);
      const boost = 1 + Math.max(0, this._padHold - 0.2) * 1.6;
      this._padLook = { x: lx * this.sensitivity.pad * boost * dt, y: ly * this.sensitivity.pad * 0.8 * dt };
      gp.buttons.forEach((b, i) => {
        const a = PAD_BUTTONS[i];
        if (a && (b.pressed || b.value > 0.5)) now.add(a);
        if (b.pressed) this.lastDevice = 'gamepad';
      });
      this.throttle = (gp.buttons[7]?.value || 0) - (gp.buttons[6]?.value || 0);
      if (this.mode === 'orbit') {
        if (gp.buttons[12]?.pressed) this._padZoom -= 4 * dt;
        if (gp.buttons[13]?.pressed) this._padZoom += 4 * dt;
      } else {
        for (const i in PAD_DPAD_GAME) if (gp.buttons[i]?.pressed) now.add(PAD_DPAD_GAME[i]);
      }
      if (gp.buttons[0]?.pressed && !this._padPrev.has('__a')) {
        // A also acts as "select" in map levels: click at screen center.
        if (this.mode === 'orbit') this._emitClick(window.innerWidth / 2, window.innerHeight / 2);
      }
      if (gp.buttons[0]?.pressed) now.add('__a');
    }
    for (const a of now) if (!this._padPrev.has(a) && !a.startsWith('__')) this._actionDown(a);
    for (const a of this._padPrev) if (!now.has(a) && !a.startsWith('__')) this._actionUp(a);
    this._padPrev = now;
  }
}
