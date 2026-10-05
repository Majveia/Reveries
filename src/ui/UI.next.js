// Reveries interface — minimal, immersive, device-aware.
//
// Everything is tiny and quiet and lives at the edges of the frame: nothing is
// ever drawn over the centre of the screen except a 3 px reticle. Typography
// does the work (Inter hairlines, JetBrains Mono micro-caps, a serif italic for
// myths); motion is slow blur/tracking reveals rather than slides and boxes.
//
// API (stable — levels/player/vehicles call these):
//   ui.setLocation(crumbs)        crumbs from universe.crumbs(addr)
//   ui.info(card|null)            { title, subtitle, rows: [[k, v]], text, actions: [{label, onClick, primary}] }
//   ui.hint(text, ms)             transient bottom hint; "Key action · Key action" segments render as keycaps
//   ui.prompt(key, text)|prompt(null)   contextual action; key may be a key label ('E') or an action name ('interact')
//   ui.toast(title, text, ms, opts?)    discoveries / lore; long text (or opts.kind 'lore') → cinematic lore reveal
//   ui.telemetry(obj|null)        tiny readout, e.g. { SPD: '312 m/s', ALT: '1.2 km' }
//   ui.setProgress(p, label)      loading veil (p in 0..1, or null to hide)
//   ui.setMode(mode)              'map' | 'onfoot' | 'bike' | 'ship' ('vehicle' = bike) — touch layout + help
//   ui.setVisible(bool)           photo mode
//   ui.showTitle(onBegin)         title screen
// Additions:
//   ui.label(id, x, y, text, opts) world-space label at CSS pixel (x, y); opts { sub, hover, kind, color, align, persist }
//                                 labels not refreshed for 2 frames fade out (unless opts.persist)
//   ui.labelWorld(id, vec3, camera, text, opts)  same, projected from a world position
//   ui.unlabel(id) / ui.clearLabels()
//   ui.arrival({ kicker, title, text, ms })      cinematic place-name reveal (upper third)
//   ui.glyph(action)              HTML glyph for an action on the current device
//   ui.toggleHelp(force?)         controls overlay for the current context ('help' action, / key)
//   ui.settings                   persisted settings object (quality, mouse, touch, pad, invertY, volume, muted, haptics)

import './ui.next.css';

const h = (tag, cls, parent, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---- glyphs -----------------------------------------------------------------
const KEY_LABEL = {
  forward: 'W', back: 'S', left: 'A', right: 'D', move: 'WASD', look: 'mouse', jump: 'Space', sprint: 'Shift',
  crouch: 'C', interact: 'E', toggleView: 'V', map: 'M', escape: 'Esc', travel: 'Enter', rollLeft: 'Q',
  rollRight: 'R', photo: 'H', timeFaster: '.', timeSlower: ',', light: 'L', help: '/', primary: 'click',
  secondary: 'rclick', brake: 'X', zoom: 'scroll', orbit: 'drag',
};
const PAD_LABEL = {
  jump: 'A', crouch: 'B', interact: 'X', toggleView: 'Y', rollLeft: 'LB', rollRight: 'RB', brake: 'LT',
  sprint: 'RT', map: 'view', escape: 'menu', photo: 'R3', move: 'LS', look: 'RS', orbit: 'RS', zoom: 'dpad',
  primary: 'A', travel: 'A', help: 'view', timeFaster: 'RB', timeSlower: 'LB', forward: 'LS', back: 'LS', left: 'LS', right: 'LS',
};
const SVG = {
  mouse: '<svg viewBox="0 0 16 16"><rect x="4.5" y="1.5" width="7" height="13" rx="3.5"/><path d="M8 4v2.5"/></svg>',
  click: '<svg viewBox="0 0 16 16"><rect x="4.5" y="1.5" width="7" height="13" rx="3.5"/><path d="M8 1.5V7H4.6" class="f"/></svg>',
  drag: '<svg viewBox="0 0 16 16"><rect x="5" y="3" width="6" height="11" rx="3"/><path d="M1.5 8h2M12.5 8h2M2.5 7l-1 1 1 1M13.5 7l1 1-1 1"/></svg>',
  scroll: '<svg viewBox="0 0 16 16"><rect x="4.5" y="1.5" width="7" height="13" rx="3.5"/><path d="M8 3.6v3.2M6.8 4.6 8 3.4l1.2 1.2M6.8 5.8 8 7l1.2-1.2"/></svg>',
  up: '<svg viewBox="0 0 20 20"><path d="M5 12.5 10 7.5l5 5"/></svg>',
  down: '<svg viewBox="0 0 20 20"><path d="M5 7.5 10 12.5l5-5"/></svg>',
  sprint: '<svg viewBox="0 0 20 20"><path d="M5 5.5 9.5 10 5 14.5M10.5 5.5 15 10l-4.5 4.5"/></svg>',
  boost: '<svg viewBox="0 0 20 20"><path d="M4 6l4 4-4 4M9 6l4 4-4 4M14 6l2.5 4L14 14"/></svg>',
  brake: '<svg viewBox="0 0 20 20"><path d="M7.5 5v10M12.5 5v10"/></svg>',
  view: '<svg viewBox="0 0 20 20"><path d="M2.5 10s3-5 7.5-5 7.5 5 7.5 5-3 5-7.5 5-7.5-5-7.5-5z"/><circle cx="10" cy="10" r="2.2"/></svg>',
  exit: '<svg viewBox="0 0 20 20"><path d="M8 4.5H4.5v11H8M9 10h7.5M13.5 7l3 3-3 3"/></svg>',
  gear: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.2v2.3M10 15.5v2.3M2.2 10h2.3M15.5 10h2.3M4.5 4.5l1.6 1.6M13.9 13.9l1.6 1.6M4.5 15.5l1.6-1.6M13.9 6.1l1.6-1.6"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  diamond: '<svg viewBox="0 0 10 10"><path d="M5 .8 9.2 5 5 9.2.8 5z"/></svg>',
};
// hint-text tokens that are keys (→ action, so they can switch to gamepad glyphs)
const KEY_TOKENS = {
  WASD: 'move', Shift: 'sprint', Space: 'jump', V: 'toggleView', E: 'interact', F: 'interact', Esc: 'escape', M: 'map',
  Tab: 'map', Q: 'rollLeft', R: 'rollRight', H: 'photo', C: 'crouch', L: 'light', Enter: 'travel', '/': 'help',
  Drag: 'orbit', drag: 'orbit', Scroll: 'zoom', scroll: 'zoom', Click: 'primary', click: 'primary', X: 'brake',
};

// ---- controls per context (help overlay + first-use hints) -------------------
const CONTROLS = {
  map: [['orbit', 'Orbit'], ['zoom', 'Zoom'], ['primary', 'Select · travel'], ['escape', 'Up one scale'], ['timeSlower', 'Slower time'], ['timeFaster', 'Faster time'], ['photo', 'Photo mode']],
  onfoot: [['move', 'Move'], ['look', 'Look'], ['sprint', 'Sprint'], ['jump', 'Jump · hold to glide'], ['crouch', 'Crouch'], ['interact', 'Interact'], ['toggleView', 'First / third person'], ['map', 'Leave world'], ['photo', 'Photo mode']],
  bike: [['move', 'Steer · throttle'], ['sprint', 'Boost'], ['brake', 'Brake'], ['jump', 'Hop'], ['interact', 'Dismount'], ['toggleView', 'Camera'], ['photo', 'Photo mode']],
  ship: [['move', 'Pitch · yaw'], ['sprint', 'Boost'], ['jump', 'Ascend'], ['crouch', 'Descend'], ['rollLeft', 'Roll left'], ['rollRight', 'Roll right'], ['interact', 'Land · exit'], ['toggleView', 'Camera']],
};
const VEHICLE_HINT = {
  bike: [['move', 'steer'], ['sprint', 'boost'], ['brake', 'brake'], ['interact', 'dismount']],
  ship: [['move', 'fly'], ['jump', 'up'], ['crouch', 'down'], ['sprint', 'boost'], ['interact', 'exit']],
};

const SETTINGS_KEY = 'reveries.settings.v1';
const TIERS = ['low', 'medium', 'high', 'ultra'];
const DEFAULTS = { quality: null, mouse: 1, touch: 1, pad: 1, invertY: false, volume: 0.8, muted: false, haptics: true };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export class UI {
  constructor(engine) {
    this.engine = engine;
    this.input = engine.input;
    this.mode = 'map';
    this.device = this.input.lastDevice;
    this._frame = 0;
    this._hintTimer = 0;
    this._labels = new Map();
    this._arrivalQ = [];
    this._seenVehicle = new Set();

    const root = (this.root = h('div', 'rvu', document.body));
    root.setAttribute('data-ui', '');
    // top-left: breadcrumb + discovery toasts
    this.crumbs = h('nav', 'rvu-crumbs', root);
    this.crumbs.setAttribute('data-ui', '');
    this.toasts = h('div', 'rvu-toasts', root);
    // top-centre: compass (planet surface only)
    this._buildCompass();
    // top-right: settings gear + telemetry
    this.tele = h('div', 'rvu-tele', root);
    this.gear = h('button', 'rvu-gear', root, SVG.gear);
    this.gear.setAttribute('data-ui', ''); this.gear.setAttribute('aria-label', 'Settings');
    this.gear.addEventListener('click', (e) => { e.stopPropagation(); this.toggleSettings(); });
    // world labels
    this.labelLayer = h('div', 'rvu-labels', root);
    // upper third: arrival / lore reveal
    this.arrivalEl = h('div', 'rvu-arrival', root);
    // centre: 3 px reticle
    this.reticle = h('div', 'rvu-reticle', root);
    // bottom stack: prompt · pointer-lock hint · hint
    this.stack = h('div', 'rvu-stack', root);
    this.promptEl = h('div', 'rvu-prompt', this.stack);
    this.lockEl = h('div', 'rvu-lock', this.stack);
    this.hintEl = h('div', 'rvu-hint', this.stack);
    // bottom-right: info card
    this.card = h('aside', 'rvu-card', root);
    this.card.setAttribute('data-ui', '');
    // help overlay + settings panel
    this.helpEl = h('div', 'rvu-help', root);
    this.helpEl.setAttribute('data-ui', '');
    this.helpEl.addEventListener('click', () => this.toggleHelp(false));
    this.settingsEl = h('div', 'rvu-settings', root);
    this.settingsEl.setAttribute('data-ui', '');
    this.settingsEl.addEventListener('pointerdown', (e) => e.stopPropagation());

    // loading veil
    this.veil = h('div', 'rvu-veil', document.body);
    h('div', 'rvu-veil-orbit', this.veil, '<i></i>');
    this.veilLabel = h('div', 'rvu-veil-label', this.veil);
    const vb = h('div', 'rvu-veil-track', this.veil);
    this.veilBar = h('div', 'rvu-veil-bar', vb);

    // touch layer
    this.touch = h('div', 'rvu-touch', document.body);
    this.ghost = h('div', 'rvu-ghost', this.touch, '<i></i>');
    this.stickRing = h('div', 'rvu-stick', this.touch);
    this.stickKnob = h('div', 'rvu-knob', this.stickRing);
    this.buttons = h('div', 'rvu-buttons', this.touch);
    this.buttons.setAttribute('data-ui', '');
    this._buildTouchButtons();

    this._loadSettings();
    this._buildSettings();
    document.body.dataset.device = this.device;
    document.body.dataset.mode = 'map';

    // arrival captions for map scales
    engine.on?.('entered', ({ name, addr }) => {
      this.clearLabels();
      this.toggleHelp(false);
      if (name === 'galaxy' || name === 'system') {
        let crumbs = [];
        try { crumbs = engine.universe.crumbs(addr) || []; } catch { /* ignore */ }
        const last = crumbs[crumbs.length - 1];
        if (last) this.arrival({ kicker: name === 'system' ? 'Star system' : 'Galaxy', title: last.label, ms: 5200 });
      }
      if (engine.shotMode && engine.params.get('title') === '1' && !this._shotTitle) {
        this._shotTitle = true;
        this.showTitle(null, { static: true });
      }
    });
    window.addEventListener('keydown', (e) => {
      if (this.titleEl && !this._titleGone && e.code !== 'Tab') { this._beginTitle?.(); return; }
      if (e.code === 'Escape' && this.settingsEl.classList.contains('is-open')) this.toggleSettings(false);
    });
    // clicks outside close the settings panel
    window.addEventListener('pointerdown', (e) => {
      if (!this.settingsEl.classList.contains('is-open')) return;
      if (e.target.closest?.('.rvu-settings, .rvu-gear')) return;
      this.toggleSettings(false);
    });
  }

  // ---- breadcrumb -------------------------------------------------------------
  setLocation(crumbs) {
    this.crumbs.innerHTML = '';
    (crumbs || []).forEach((c, i) => {
      const here = i === crumbs.length - 1;
      const a = h('button', 'rvu-crumb' + (here ? ' is-here' : ''), this.crumbs, esc(c.label));
      a.setAttribute('data-ui', '');
      if (!here) {
        a.onclick = (e) => { e.stopPropagation(); this.engine.go(c.level, c.addr, { transition: 'warp-out' }); };
        h('span', 'rvu-sep', this.crumbs, '<i></i>');
      }
    });
    this.crumbs.classList.remove('is-in'); void this.crumbs.offsetWidth; this.crumbs.classList.add('is-in');
  }

  // ---- info card --------------------------------------------------------------
  info(card) {
    if (!card) { this.card.classList.remove('is-open'); return; }
    const rows = (card.rows || []).map(([k, v]) => `<div class="rvu-row"><span>${esc(k)}</span><b>${v}</b></div>`).join('');
    this.card.innerHTML = `
      <button class="rvu-card-x" data-ui aria-label="Close">${SVG.close}</button>
      ${card.subtitle ? `<div class="rvu-card-sub">${card.subtitle}</div>` : ''}
      <h2>${card.title ?? ''}</h2>
      ${rows ? `<div class="rvu-rows">${rows}</div>` : ''}
      ${card.text ? `<p>${card.text}</p>` : ''}
      <div class="rvu-actions"></div>`;
    this.card.querySelector('.rvu-card-x').onclick = (e) => { e.stopPropagation(); this.info(null); };
    const act = this.card.querySelector('.rvu-actions');
    for (const a of card.actions || []) {
      const b = h('button', 'rvu-btn' + (a.primary ? ' is-primary' : ''), act, esc(a.label));
      b.setAttribute('data-ui', '');
      if (a.primary && this.device !== 'touch') b.insertAdjacentHTML('afterbegin', this.glyph('travel') + ' ');
      b.onclick = (e) => { e.stopPropagation(); this.input.rumble?.(0.3, 12); a.onClick?.(); };
    }
    if (!act.children.length) act.remove();
    this.card.classList.remove('is-open'); void this.card.offsetWidth;
    this.card.classList.add('is-open');
  }

  // ---- hint -------------------------------------------------------------------
  hint(text, ms = 4200) {
    this._hintText = text;
    this._renderHint();
    this.hintEl.classList.add('is-on');
    clearTimeout(this._hintTimer);
    if (ms > 0) this._hintTimer = setTimeout(() => { this.hintEl.classList.remove('is-on'); this._hintText = null; }, ms);
  }
  _renderHint() {
    const text = this._hintText;
    if (text == null) return;
    if (Array.isArray(text)) { // [[action, label], ...]
      this.hintEl.innerHTML = text.map(([a, l]) => `<span class="rvu-seg">${this.glyph(a)}<em>${esc(l)}</em></span>`).join('<i class="rvu-dot"></i>');
      return;
    }
    const segs = String(text).split(/\s+·\s+/);
    this.hintEl.innerHTML = segs.map((seg) => {
      const m = seg.match(/^(\S+)\s+(.*)$/);
      const act = m && KEY_TOKENS[m[1]];
      if (act && this.device !== 'touch') return `<span class="rvu-seg">${this.glyph(act)}<em>${esc(m[2])}</em></span>`;
      return `<span class="rvu-seg"><em>${esc(seg)}</em></span>`;
    }).join('<i class="rvu-dot"></i>');
  }

  // ---- contextual prompt ------------------------------------------------------
  prompt(key, text) {
    if (!key) {
      this.promptEl.classList.remove('is-on'); this._promptKey = null; this._syncTouchAction(); return;
    }
    this._promptKey = key; this._promptText = text || '';
    this._promptAction = KEY_LABEL[key] ? key : ({ E: 'interact', F: 'interact', X: 'interact', A: 'jump', Space: 'jump', Enter: 'travel', M: 'map', V: 'toggleView' }[key] || null);
    this._renderPrompt();
    this.promptEl.classList.add('is-on');
    this._syncTouchAction();
    this.input.rumble?.(0.15, 10);
  }
  _renderPrompt() {
    if (!this._promptKey) return;
    const g = this._promptAction ? this.glyph(this._promptAction) : `<kbd>${esc(this._promptKey)}</kbd>`;
    this.promptEl.innerHTML = `${g}<span>${esc(this._promptText)}</span>`;
  }

  // ---- toasts: discovery + lore -------------------------------------------------
  toast(title, text, ms = 7000, opts = {}) {
    const lore = opts.kind === 'lore' || (opts.kind == null && text && String(text).length > 70);
    if (lore) { this.arrival({ kicker: opts.kicker || 'World', title, text, ms }); return; }
    const t = h('div', 'rvu-toast', this.toasts, `<i>${SVG.diamond}</i><div><b>${esc(text ? title : 'Note')}</b><span>${esc(text || title)}</span></div>`);
    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('is-on')));
    this.input.rumble?.(0.25, 30);
    while (this.toasts.children.length > 3) this.toasts.firstChild.remove();
    if (!(this.engine.shotMode && ms >= 3000)) setTimeout(() => { t.classList.remove('is-on'); setTimeout(() => t.remove(), 900); }, ms);
  }

  /** Cinematic place-name / myth reveal in the upper third. */
  arrival({ kicker = '', title = '', text = '', ms = 7000 } = {}) {
    if (this._arrivalBusy) { this._arrivalQ.push({ kicker, title, text, ms }); return; }
    this._arrivalBusy = true;
    const a = this.arrivalEl;
    const letters = [...String(title)].map((c, i) => `<span style="--i:${i}">${c === ' ' ? '&nbsp;' : esc(c)}</span>`).join('');
    a.innerHTML = `${kicker ? `<div class="rvu-arr-kick">${esc(kicker)}</div>` : ''}<h3>${letters}</h3><i class="rvu-arr-line"></i>${text ? `<p>${text}</p>` : ''}`;
    a.classList.remove('is-on', 'is-out'); void a.offsetWidth;
    a.classList.toggle('is-static', !!this.engine.shotMode);
    a.classList.add('is-on');
    const hold = this.engine.shotMode ? 1e9 : ms;
    clearTimeout(this._arrTimer);
    this._arrTimer = setTimeout(() => {
      a.classList.add('is-out');
      this._arrTimer = setTimeout(() => {
        a.classList.remove('is-on', 'is-out'); this._arrivalBusy = false;
        const n = this._arrivalQ.shift(); if (n) this.arrival(n);
      }, 1400);
    }, hold);
  }

  // ---- telemetry ----------------------------------------------------------------
  telemetry(obj) {
    if (!obj) { this.tele.classList.remove('is-on'); this._teleKeys = ''; return; }
    const keys = Object.keys(obj).join('|');
    if (keys !== this._teleKeys) {
      this._teleKeys = keys;
      this.tele.innerHTML = Object.keys(obj).map((k) => `<div><span>${esc(k)}</span><b></b></div>`).join('');
      this._teleVals = [...this.tele.querySelectorAll('b')];
    }
    Object.values(obj).forEach((v, i) => { const s = String(v); if (this._teleVals[i].textContent !== s) this._teleVals[i].textContent = s; });
    this.tele.classList.add('is-on');
  }

  // ---- loading veil ---------------------------------------------------------------
  setProgress(p, label = '') {
    if (p == null) { this.veil.classList.remove('is-on'); document.body.classList.remove('rvu-loading'); return; }
    this.veil.classList.add('is-on');
    document.body.classList.add('rvu-loading');
    this.veilBar.style.transform = `scaleX(${clamp(p, 0.02, 1)})`;
    const l = String(label || '');
    if (this.veilLabel.textContent !== l) this.veilLabel.textContent = l;
  }

  // ---- modes ------------------------------------------------------------------------
  setMode(mode) {
    if (mode === 'vehicle') mode = 'bike';
    const prev = this.mode;
    this.mode = mode;
    document.body.dataset.mode = mode;
    this.reticle.classList.toggle('is-on', mode === 'onfoot' || mode === 'ship');
    this._layoutTouch();
    if (this.helpEl.classList.contains('is-open')) this._renderHelp();
    // first-use controls for vehicles
    if ((mode === 'bike' || mode === 'ship') && prev !== mode && !this._seenVehicle.has(mode)) {
      this._seenVehicle.add(mode);
      const key = 'reveries.seen.' + mode;
      if (!store.get(key) || this.engine.shotMode) { store.set(key, '1'); setTimeout(() => this.hint(VEHICLE_HINT[mode], 6500), 400); }
    }
  }

  setVisible(v) {
    this._visible = v;
    this.root.classList.toggle('is-hidden', !v);
    this.touch.classList.toggle('is-hidden', !v);
  }

  // ---- title screen -------------------------------------------------------------------
  showTitle(onBegin, opts = {}) {
    const touch = this.device === 'touch';
    const word = 'REVERIES';
    const letters = [...word].map((c, i) => `<span style="--i:${i}">${c}</span>`).join('');
    const t = h('div', 'rvu-title' + (opts.static ? ' is-static' : ''), document.body, `
      <div class="rvu-title-vignette"></div>
      <div class="rvu-title-inner">
        <div class="rvu-title-kick">a playable universe</div>
        <h1 aria-label="Reveries">${letters}</h1>
        <i class="rvu-title-line"></i>
        <p class="rvu-title-tag">from the first fluctuations to the last city lights</p>
      </div>
      <div class="rvu-title-begin">${touch ? '' : `<span class="rvu-begin-g">${this.device === 'gamepad' ? this._padGlyph('A') : SVG.click.replace('<svg', '<svg class="rvu-ico"')}</span>`}<span>${touch ? 'touch to begin' : this.device === 'gamepad' ? 'press to begin' : 'click to begin'}</span></div>
      <div class="rvu-title-foot rvu-title-l">ΛCDM&ensp;Ω<sub>m</sub> 0.31&ensp;Ω<sub>Λ</sub> 0.69&ensp;H<sub>0</sub> 67.7</div>
      <div class="rvu-title-foot rvu-title-r">z 49 → 0&ensp;·&ensp;13.8 Gyr</div>`);
    t.setAttribute('data-ui', '');
    document.body.classList.add('rvu-titling');
    this._titleGone = false;
    const go = () => {
      if (this._titleGone) return;
      this._titleGone = true;
      this.input.rumble?.(0.4, 30);
      t.classList.add('is-out');
      document.body.classList.remove('rvu-titling');
      setTimeout(() => { t.remove(); if (this.titleEl === t) this.titleEl = null; }, 2200);
      onBegin?.();
    };
    this._beginTitle = opts.static ? null : go;
    if (!opts.static) {
      t.addEventListener('click', go);
      t.addEventListener('touchend', (e) => { e.preventDefault(); go(); }, { passive: false });
    }
    this.titleEl = t;
  }

  // ---- world-space labels ---------------------------------------------------------------
  label(id, x, y, text, opts = {}) {
    let L = this._labels.get(id);
    if (!L) {
      const e = h('div', 'rvu-label', this.labelLayer, '<i class="rvu-label-pt"></i><i class="rvu-label-ln"></i><div class="rvu-label-t"><b></b><span></span></div>');
      L = { e, b: e.querySelector('b'), s: e.querySelector('span'), text: null, sub: null, hover: null, kind: null, seen: 0, x: -1, y: -1, align: null };
      this._labels.set(id, L);
      requestAnimationFrame(() => e.classList.add('is-on'));
    }
    L.seen = this._frame;
    L.persist = !!opts.persist;
    if (L.text !== text) { L.text = text; L.b.textContent = text; }
    const sub = opts.sub || '';
    if (L.sub !== sub) { L.sub = sub; L.s.textContent = sub; }
    const hov = !!opts.hover;
    if (L.hover !== hov) { L.hover = hov; L.e.classList.toggle('is-hover', hov); }
    const kind = opts.kind || '';
    if (L.kind !== kind) { L.kind = kind; L.e.dataset.kind = kind; }
    const align = opts.align || (x > window.innerWidth - 180 ? 'left' : 'right');
    if (L.align !== align) { L.align = align; L.e.dataset.align = align; }
    if (opts.color && L.color !== opts.color) { L.color = opts.color; L.e.style.setProperty('--c', opts.color); }
    const rx = Math.round(x * 2) / 2, ry = Math.round(y * 2) / 2;
    if (rx !== L.x || ry !== L.y) { L.x = rx; L.y = ry; L.e.style.transform = `translate3d(${rx}px, ${ry}px, 0)`; }
    if (L.gone) { L.gone = false; L.e.classList.add('is-on'); }
    return L.e;
  }
  labelWorld(id, v, camera, text, opts = {}) {
    const p = (this._proj ||= { x: 0, y: 0, z: 0 });
    const e = camera.matrixWorldInverse.elements, pe = camera.projectionMatrix.elements;
    // view space
    const vx = e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12];
    const vy = e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13];
    const vz = e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14];
    if (vz > -1e-6) { this.unlabel(id, true); return null; } // behind the camera
    const cx = pe[0] * vx + pe[4] * vy + pe[8] * vz + pe[12];
    const cy = pe[1] * vx + pe[5] * vy + pe[9] * vz + pe[13];
    const cw = pe[3] * vx + pe[7] * vy + pe[11] * vz + pe[15];
    p.x = (cx / cw * 0.5 + 0.5) * window.innerWidth; p.y = (-cy / cw * 0.5 + 0.5) * window.innerHeight;
    if (p.x < -40 || p.y < -40 || p.x > window.innerWidth + 40 || p.y > window.innerHeight + 40) { this.unlabel(id, true); return null; }
    return this.label(id, p.x, p.y, text, opts);
  }
  unlabel(id, soft = false) {
    const L = this._labels.get(id);
    if (!L) return;
    if (soft) { if (!L.gone) { L.gone = true; L.e.classList.remove('is-on'); } return; }
    L.e.remove(); this._labels.delete(id);
  }
  clearLabels() { for (const L of this._labels.values()) L.e.remove(); this._labels.clear(); }

  // ---- glyphs -----------------------------------------------------------------------------
  glyph(action, device = this.device) {
    if (device === 'gamepad') {
      const p = PAD_LABEL[action];
      return p ? this._padGlyph(p) : '';
    }
    if (device === 'touch') return '';
    const k = KEY_LABEL[action] || action;
    if (k === 'mouse' || k === 'click' || k === 'drag' || k === 'scroll') return SVG[k].replace('<svg', '<svg class="rvu-ico"');
    if (k === 'rclick') return SVG.click.replace('<svg', '<svg class="rvu-ico is-r"');
    if (k === 'WASD') return '<span class="rvu-wasd"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span>';
    return `<kbd${k.length > 2 ? ' class="is-wide"' : ''}>${esc(k)}</kbd>`;
  }
  _padGlyph(p) {
    if (p === 'LS' || p === 'RS') return `<span class="rvu-pad is-stick"><i></i><em>${p[0]}</em></span>`;
    if (p === 'dpad') return '<span class="rvu-pad is-dpad"><i></i></span>';
    if (p === 'view') return '<span class="rvu-pad is-sys">⧉</span>';
    if (p === 'menu') return '<span class="rvu-pad is-sys">≡</span>';
    if (p.length === 2) return `<span class="rvu-pad is-sh">${p}</span>`;
    return `<span class="rvu-pad is-${p.toLowerCase()}">${p}</span>`;
  }

  // ---- help overlay ---------------------------------------------------------------------------
  toggleHelp(force) {
    const open = force ?? !this.helpEl.classList.contains('is-open');
    if (open) this._renderHelp();
    this.helpEl.classList.toggle('is-open', open);
  }
  _renderHelp() {
    const list = CONTROLS[this.mode] || CONTROLS.map;
    const touch = this.device === 'touch';
    const rows = list.map(([a, l]) => `<div class="rvu-help-row"><span class="rvu-help-g">${touch ? this._touchWord(a) : this.glyph(a)}</span><em>${esc(l)}</em></div>`).join('');
    const title = { map: 'Navigation', onfoot: 'On foot', bike: 'Hover bike', ship: 'Ship' }[this.mode] || 'Controls';
    this.helpEl.innerHTML = `<div class="rvu-help-in"><div class="rvu-help-h"><b>${title}</b><span>${touch ? 'tap to close' : this.device === 'gamepad' ? 'controller' : 'keyboard · mouse'}</span></div><div class="rvu-help-grid">${rows}</div></div>`;
  }
  _touchWord(a) {
    return `<span class="rvu-tw">${{ move: 'left thumb', look: 'right thumb', orbit: 'drag', zoom: 'pinch', primary: 'tap', escape: 'crumbs', map: 'crumbs' }[a] || (KEY_LABEL[a] || a)}</span>`;
  }

  // ---- settings -----------------------------------------------------------------------------------
  _loadSettings() {
    let s = {};
    try { s = JSON.parse(store.get(SETTINGS_KEY) || '{}') || {}; } catch { s = {}; }
    this.settings = { ...DEFAULTS, ...s };
    this._applySettings(true);
  }
  _saveSettings() { store.set(SETTINGS_KEY, JSON.stringify(this.settings)); }
  _applySettings(boot = false) {
    const S = this.settings, I = this.input, A = this.engine.audio;
    I.setSensitivity?.({ mouse: S.mouse, touch: S.touch, pad: S.pad });
    I.invertY = !!S.invertY;
    I.hapticsOff = !S.haptics;
    if (A) {
      A.setVolume?.(S.volume);
      if (!!A.muted !== !!S.muted) A.toggleMute?.();
    }
    // quality: an explicit ?q= wins; otherwise a stored tier is applied before
    // the first level loads (the engine constructs the UI before sizing/loading)
    if (boot && S.quality && !this.engine.params.has('q') && !this.engine.shotMode) this._setQualityTier(S.quality);
  }
  _setQualityTier(tier) {
    const q = this.engine.quality;
    const i = TIERS.indexOf(tier);
    if (i < 0 || !q) return;
    const dpr = window.devicePixelRatio || 1;
    q.level = i; q.tier = tier;
    q.maxDpr = Math.min(dpr, [1.0, 1.5, 2.0, 2.0][i]);
    q.minDpr = Math.min(q.maxDpr, [0.5, 0.6, 0.75, 1.0][i]);
    q.msaa = [0, 0, 4, 4][i];
    q.shadowMapSize = [1024, 2048, 2048, 4096][i];
  }
  toggleSettings(force) {
    const open = force ?? !this.settingsEl.classList.contains('is-open');
    if (open) this._syncSettingsUI();
    this.settingsEl.classList.toggle('is-open', open);
    this.gear.classList.toggle('is-open', open);
  }
  _buildSettings() {
    const el = this.settingsEl;
    el.innerHTML = `
      <div class="rvu-set-h">Settings</div>
      <div class="rvu-set-row"><span>Quality</span><div class="rvu-seg-ctl" data-k="quality">${TIERS.map((t) => `<button data-v="${t}">${t === 'medium' ? 'med' : t}</button>`).join('')}</div></div>
      <div class="rvu-set-note" data-note="quality"></div>
      <label class="rvu-set-row"><span data-sens>Look speed</span><input type="range" min="0.3" max="2.5" step="0.05" data-k="sens"></label>
      <div class="rvu-set-row"><span>Invert Y</span><button class="rvu-tog" data-k="invertY"><i></i></button></div>
      <label class="rvu-set-row"><span>Volume</span><input type="range" min="0" max="1" step="0.02" data-k="volume"></label>
      <div class="rvu-set-row"><span>Mute</span><button class="rvu-tog" data-k="muted"><i></i></button></div>
      <div class="rvu-set-row"><span>Haptics</span><button class="rvu-tog" data-k="haptics"><i></i></button></div>
      <button class="rvu-set-help" data-k="help">Controls <span>${this.glyph('help', 'keyboard')}</span></button>`;
    el.querySelectorAll('button, input').forEach((b) => b.setAttribute('data-ui', ''));
    el.querySelector('[data-k="quality"]').addEventListener('click', (e) => {
      const v = e.target.closest('button')?.dataset.v; if (!v) return;
      this.settings.quality = v; this._saveSettings(); this._syncSettingsUI();
      if (v !== this.engine.quality?.tier) {
        // levels size their workloads at load: reload into the same place
        const p = new URLSearchParams(location.search); p.set('q', v); p.delete('shot');
        el.querySelector('[data-note="quality"]').textContent = 'reloading…';
        setTimeout(() => { location.search = p.toString(); }, 250);
      }
    });
    const sens = el.querySelector('[data-k="sens"]');
    sens.addEventListener('input', () => {
      const k = this.device === 'touch' ? 'touch' : this.device === 'gamepad' ? 'pad' : 'mouse';
      this.settings[k] = parseFloat(sens.value); this._applySettings(); this._saveSettings();
    });
    const vol = el.querySelector('[data-k="volume"]');
    vol.addEventListener('input', () => { this.settings.volume = parseFloat(vol.value); this._applySettings(); this._saveSettings(); });
    for (const k of ['invertY', 'muted', 'haptics']) {
      el.querySelector(`[data-k="${k}"]`).addEventListener('click', () => { this.settings[k] = !this.settings[k]; this._applySettings(); this._saveSettings(); this._syncSettingsUI(); });
    }
    el.querySelector('[data-k="help"]').addEventListener('click', () => { this.toggleSettings(false); this.toggleHelp(true); });
  }
  _syncSettingsUI() {
    const el = this.settingsEl, S = this.settings;
    const tier = this.engine.quality?.tier || 'high';
    el.querySelectorAll('[data-k="quality"] button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === tier));
    const k = this.device === 'touch' ? 'touch' : this.device === 'gamepad' ? 'pad' : 'mouse';
    el.querySelector('[data-sens]').textContent = { touch: 'Touch look', pad: 'Stick look', mouse: 'Mouse look' }[k];
    el.querySelector('[data-k="sens"]').value = S[k];
    el.querySelector('[data-k="volume"]').value = S.volume;
    for (const t of ['invertY', 'muted', 'haptics']) el.querySelector(`[data-k="${t}"]`).classList.toggle('is-on', !!S[t]);
    el.querySelector('[data-note="quality"]').textContent = '';
  }

  // ---- compass (planet surface) ---------------------------------------------------------------------
  _buildCompass() {
    const c = (this.compass = h('div', 'rvu-compass', this.root));
    const strip = (this.compassStrip = h('div', 'rvu-compass-strip', c));
    this._ppd = 1.6; // px per degree (set in CSS width: 288px ≈ 180°)
    const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    let html = '';
    for (let d = -360; d <= 720; d += 15) {
      const n = names[((d % 360) + 360) % 360];
      const x = (d + 360) * this._ppd;
      html += n ? `<b style="left:${x}px" class="${n.length === 1 ? 'is-card' : ''}">${n}</b>` : `<i style="left:${x}px"></i>`;
    }
    strip.innerHTML = html;
    this.compassMarks = h('div', 'rvu-compass-marks', c);
    this.compassCap = h('div', 'rvu-compass-cap', c);
    this._marks = [];
  }
  _updateCompass() {
    const E = this.engine, L = E.level;
    const on = E.levelName === 'planet' && L && L.mode && L.mode !== 'orbit' && L.camera && L.world;
    if (!on) { if (this._compassOn) { this._compassOn = false; this.compass.classList.remove('is-on'); } return; }
    if (!this._compassOn) { this._compassOn = true; this.compass.classList.add('is-on'); }
    const cam = L.camera, p = cam.position;
    const pl = Math.hypot(p.x, p.y, p.z) || 1;
    const ux = p.x / pl, uy = p.y / pl, uz = p.z / pl;
    // forward projected on the tangent plane
    const q = cam.quaternion;
    // (0,0,-1) rotated by q
    const fx0 = -(2 * (q.x * q.z + q.w * q.y)), fy0 = -(2 * (q.y * q.z - q.w * q.x)), fz0 = -(1 - 2 * (q.x * q.x + q.y * q.y));
    let d = fx0 * ux + fy0 * uy + fz0 * uz;
    let fx = fx0 - ux * d, fy = fy0 - uy * d, fz = fz0 - uz * d;
    // north = +Y projected; east = north × up
    let nx = -ux * uy, ny = 1 - uy * uy, nz = -uz * uy;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-4) { nx = 0; ny = 0; nz = 1; } else { nx /= nl; ny /= nl; nz /= nl; }
    const ex = ny * uz - nz * uy, ey = nz * ux - nx * uz, ez = nx * uy - ny * ux;
    const heading = Math.atan2(fx * ex + fy * ey + fz * ez, fx * nx + fy * ny + fz * nz);
    const hdeg = heading * 180 / Math.PI;
    const W = this.compass.clientWidth || 288;
    const tx = -(hdeg + 360) * this._ppd + W / 2;
    this.compassStrip.style.transform = `translate3d(${tx.toFixed(1)}px,0,0)`;

    // settlement markers (every 4th frame)
    if (this._frame % 4 !== 0) return;
    const sites = L.world.sites || [];
    const cand = [];
    for (const s of sites) {
      const sp = s.position; if (!sp) continue;
      const dx = sp.x - p.x, dy = sp.y - p.y, dz = sp.z - p.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 60000) continue;
      const dd = dx * ux + dy * uy + dz * uz;
      const tx2 = dx - ux * dd, ty2 = dy - uy * dd, tz2 = dz - uz * dd;
      const b = Math.atan2(tx2 * ex + ty2 * ey + tz2 * ez, tx2 * nx + ty2 * ny + tz2 * nz);
      let rel = b - heading; rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      cand.push({ s, dist, rel });
    }
    cand.sort((a, b) => a.dist - b.dist);
    const show = cand.slice(0, 5);
    while (this._marks.length < show.length) this._marks.push(h('i', 'rvu-cmark', this.compassMarks, SVG.diamond));
    let best = null;
    this._marks.forEach((m, i) => {
      const c = show[i];
      const vis = c && Math.abs(c.rel) < Math.PI / 2 * 0.98;
      m.style.opacity = vis ? (c.dist < 1500 ? 1 : 0.75) : 0;
      if (!vis) return;
      m.style.transform = `translate3d(${(W / 2 + c.rel * 180 / Math.PI * this._ppd).toFixed(1)}px,0,0)`;
      m.className = 'rvu-cmark is-' + (c.s.kind || 'site');
      if (Math.abs(c.rel) < 0.14 && (!best || c.dist < best.dist)) best = c;
    });
    const cap = best ? `${best.s.name || best.s.kind} · ${best.dist < 1000 ? Math.round(best.dist) + ' m' : (best.dist / 1000).toFixed(1) + ' km'}` : '';
    if (cap !== this._cap) { this._cap = cap; this.compassCap.textContent = cap; this.compassCap.classList.toggle('is-on', !!cap); }
  }

  // ---- per frame --------------------------------------------------------------------------------------
  /** Called every frame by the engine. */
  update() {
    this._frame++;
    const I = this.input;
    const game = this.mode === 'onfoot' || this.mode === 'bike' || this.mode === 'ship';
    // device switch → re-render glyphs
    if (I.lastDevice !== this.device) {
      this.device = I.lastDevice;
      document.body.dataset.device = this.device;
      this._renderHint(); this._renderPrompt(); this._syncTouchAction();
      if (this.helpEl.classList.contains('is-open')) this._renderHelp();
    }
    // title: begin with gamepad / keyboard actions too
    if (this.titleEl && !this._titleGone && this._beginTitle && (I.pressed('jump') || I.pressed('interact') || I.pressed('travel') || I.pressed('escape'))) this._beginTitle();
    if (I.pressed('help')) this.toggleHelp();

    // joystick
    const st = I.touch?.stick;
    if (st && st.active && game) {
      if (!this._stickOn) { this._stickOn = true; this.stickRing.classList.add('is-on'); this.touch.classList.add('used-stick'); }
      this.stickRing.style.transform = `translate3d(${st.ox}px, ${st.oy}px, 0)`;
      let dx = st.x - st.ox, dy = st.y - st.oy; const l = Math.hypot(dx, dy), R = st.radius * 0.72;
      if (l > R) { dx *= R / l; dy *= R / l; }
      this.stickKnob.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    } else if (this._stickOn) { this._stickOn = false; this.stickRing.classList.remove('is-on'); }
    const showTouch = (I.isTouch || this.device === 'touch') && game;
    if (showTouch !== this._touchOn) { this._touchOn = showTouch; this.touch.classList.toggle('is-touch', showTouch); }

    // pointer-lock affordance (desktop, game modes)
    let lock = '';
    if (game && !I.isTouch && this.device === 'keyboard' && !this.titleEl) {
      if (!I.pointerLocked) lock = 'free';
      else if (!this._wasLocked) this._lockedAt = performance.now();
      if (I.pointerLocked && performance.now() - (this._lockedAt || 0) < 2600) lock = 'locked';
    }
    this._wasLocked = I.pointerLocked;
    if (lock !== this._lock) {
      this._lock = lock;
      if (lock === 'free') this.lockEl.innerHTML = `${SVG.click.replace('<svg', '<svg class="rvu-ico"')}<em>Click to look</em>`;
      else if (lock === 'locked') this.lockEl.innerHTML = `<kbd class="is-wide">Esc</kbd><em>releases the cursor</em>`;
      this.lockEl.classList.toggle('is-on', !!lock);
    }

    // labels not refreshed this frame or last → fade
    for (const [id, L] of this._labels) {
      if (L.persist || L.gone) continue;
      if (this._frame - L.seen > 2) { L.gone = true; L.e.classList.remove('is-on'); L.goneAt = this._frame; }
    }
    if (this._frame % 120 === 0) for (const [id, L] of this._labels) if (L.gone && this._frame - (L.goneAt || L.seen) > 90) { L.e.remove(); this._labels.delete(id); }

    this._updateCompass();
  }

  // ---- touch buttons -------------------------------------------------------------------------------------
  _buildTouchButtons() {
    const input = this.input;
    const mk = (slot, action) => {
      const b = h('button', 'rvu-tbtn ' + slot, this.buttons);
      b.setAttribute('data-ui', '');
      b.dataset.action = action;
      const down = (e) => {
        e.preventDefault(); e.stopPropagation();
        input.setVirtual(b.dataset.action, true); b.classList.add('is-down'); input.rumble?.(0.25, 12);
      };
      const up = (e) => { e.preventDefault(); e.stopPropagation(); input.setVirtual(b.dataset.action, false); b.classList.remove('is-down'); };
      b.addEventListener('touchstart', down, { passive: false });
      b.addEventListener('touchend', up, { passive: false });
      b.addEventListener('touchcancel', up, { passive: false });
      return b;
    };
    this.tA = mk('is-a', 'jump');        // primary, thumb rest
    this.tB = mk('is-b', 'sprint');      // left of primary
    this.tC = mk('is-c', 'crouch');      // above primary
    this.tAction = mk('is-act', 'interact'); // contextual pill on the arc
    this.tView = mk('is-view', 'toggleView');
    this.tView.innerHTML = SVG.view;
    this._layoutTouch();
  }
  _layoutTouch() {
    if (!this.tA) return;
    const m = this.mode;
    const set = (b, action, icon, on = true, label = '') => {
      b.dataset.action = action;
      b.innerHTML = SVG[icon] + (label ? `<em>${label}</em>` : '');
      b.classList.toggle('is-off', !on);
    };
    if (m === 'ship') {
      set(this.tA, 'jump', 'up'); set(this.tB, 'sprint', 'boost'); set(this.tC, 'crouch', 'down');
    } else if (m === 'bike') {
      set(this.tA, 'sprint', 'boost'); set(this.tB, 'brake', 'brake'); set(this.tC, 'jump', 'up');
    } else {
      set(this.tA, 'jump', 'up'); set(this.tB, 'sprint', 'sprint'); set(this.tC, 'crouch', 'down', false);
    }
    this.touch.dataset.layout = m;
    this._syncTouchAction();
  }
  _syncTouchAction() {
    const b = this.tAction;
    if (!b) return;
    const vehicle = this.mode === 'bike' || this.mode === 'ship';
    let label = '';
    if (this._promptKey) label = (this._promptText || '').split(' ')[0] || 'Use';
    else if (vehicle) label = this.mode === 'ship' ? 'Exit' : 'Dismount';
    b.innerHTML = label ? `${vehicle && !this._promptKey ? SVG.exit : ''}<em>${esc(label)}</em>` : '';
    b.classList.toggle('is-on', !!label);
  }
}
