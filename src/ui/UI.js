// Minimal, immersive interface. Everything is tiny, quiet, and gets out of the
// way: a breadcrumb, a hint line, an info card, a contextual prompt, and touch
// controls that only appear where your thumbs are.
//
// API (stable — levels/player/vehicles call these):
//   ui.setLocation(crumbs)        crumbs from universe.crumbs(addr)
//   ui.info(card|null)            { title, subtitle, rows: [[k, v]], text, actions: [{label, onClick, primary}] }
//   ui.hint(text, ms)             transient bottom hint
//   ui.prompt(key, text)|prompt(null)   contextual action ("E", "Board ship")
//   ui.toast(title, text, ms)     discoveries / lore
//   ui.telemetry(obj|null)        tiny readout, e.g. { SPD: '312 m/s', ALT: '1.2 km' }
//   ui.setProgress(p, label)      loading veil (p in 0..1, or null to hide)
//   ui.setMode(mode)              'map' | 'onfoot' | 'vehicle' | 'ship' (touch layout)
//   ui.setVisible(bool)           photo mode
//   ui.showTitle(onBegin)         title screen

import './ui.css';

const el = (tag, cls, parent, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
};

export class UI {
  constructor(engine) {
    this.engine = engine;
    this.root = el('div', 'rv-ui', document.body);
    this.root.dataset.ui = '';
    this.root.setAttribute('data-ui', '');
    this.crumbs = el('nav', 'rv-crumbs', this.root);
    this.crumbs.setAttribute('data-ui', '');
    this.tele = el('div', 'rv-tele', this.root);
    this.hintEl = el('div', 'rv-hint', this.root);
    this.promptEl = el('div', 'rv-prompt', this.root);
    this.card = el('aside', 'rv-card', this.root);
    this.card.setAttribute('data-ui', '');
    this.toasts = el('div', 'rv-toasts', this.root);
    this.veil = el('div', 'rv-veil', document.body);
    this.veilBar = el('div', 'rv-veil-bar', this.veil);
    this.veilLabel = el('div', 'rv-veil-label', this.veil);
    this.reticle = el('div', 'rv-reticle', this.root);
    this.touch = el('div', 'rv-touch', document.body);
    this.stickRing = el('div', 'rv-stick', this.touch);
    this.stickKnob = el('div', 'rv-knob', this.stickRing);
    this.buttons = el('div', 'rv-buttons', this.touch);
    this.buttons.setAttribute('data-ui', '');
    this.mode = 'map';
    this._hintTimer = 0;
    this._buildTouchButtons();
  }

  setLocation(crumbs) {
    this.crumbs.innerHTML = '';
    crumbs.forEach((c, i) => {
      const a = el('button', 'rv-crumb' + (i === crumbs.length - 1 ? ' is-here' : ''), this.crumbs, c.label);
      if (i < crumbs.length - 1) a.onclick = () => this.engine.go(c.level, c.addr, { transition: 'warp-out' });
      if (i < crumbs.length - 1) el('span', 'rv-sep', this.crumbs, '/');
    });
  }

  info(card) {
    if (!card) { this.card.classList.remove('is-open'); return; }
    const rows = (card.rows || []).map(([k, v]) => `<div class="rv-row"><span>${k}</span><b>${v}</b></div>`).join('');
    this.card.innerHTML = `
      ${card.subtitle ? `<div class="rv-card-sub">${card.subtitle}</div>` : ''}
      <h2>${card.title}</h2>
      ${rows ? `<div class="rv-rows">${rows}</div>` : ''}
      ${card.text ? `<p>${card.text}</p>` : ''}
      <div class="rv-actions"></div>`;
    const act = this.card.querySelector('.rv-actions');
    for (const a of card.actions || []) {
      const b = el('button', 'rv-btn' + (a.primary ? ' is-primary' : ''), act, a.label);
      b.onclick = (e) => { e.stopPropagation(); a.onClick?.(); };
    }
    this.card.classList.add('is-open');
  }

  hint(text, ms = 4200) {
    this.hintEl.textContent = text;
    this.hintEl.classList.add('is-on');
    clearTimeout(this._hintTimer);
    if (ms > 0) this._hintTimer = setTimeout(() => this.hintEl.classList.remove('is-on'), ms);
  }

  prompt(key, text) {
    if (!key) { this.promptEl.classList.remove('is-on'); this._promptKey = null; this._syncTouchAction(); return; }
    const k = this.engine.input.lastDevice === 'touch' ? '' : `<kbd>${key}</kbd>`;
    this.promptEl.innerHTML = `${k}<span>${text}</span>`;
    this.promptEl.classList.add('is-on');
    this._promptKey = key; this._promptText = text;
    this._syncTouchAction();
  }

  toast(title, text, ms = 7000) {
    const t = el('div', 'rv-toast', this.toasts, `<b>${title}</b>${text ? `<span>${text}</span>` : ''}`);
    requestAnimationFrame(() => t.classList.add('is-on'));
    setTimeout(() => { t.classList.remove('is-on'); setTimeout(() => t.remove(), 900); }, ms);
  }

  telemetry(obj) {
    if (!obj) { this.tele.classList.remove('is-on'); return; }
    this.tele.innerHTML = Object.entries(obj).map(([k, v]) => `<div><span>${k}</span>${v}</div>`).join('');
    this.tele.classList.add('is-on');
  }

  setProgress(p, label = '') {
    if (p == null) { this.veil.classList.remove('is-on'); return; }
    this.veil.classList.add('is-on');
    this.veilBar.style.transform = `scaleX(${Math.max(0.02, Math.min(1, p))})`;
    this.veilLabel.textContent = label;
  }

  setMode(mode) {
    this.mode = mode;
    document.body.dataset.mode = mode;
    this.reticle.classList.toggle('is-on', mode === 'onfoot' || mode === 'ship');
  }

  setVisible(v) { this.root.classList.toggle('is-hidden', !v); this.touch.classList.toggle('is-hidden', !v); }

  showTitle(onBegin) {
    const t = el('div', 'rv-title', document.body, `
      <div class="rv-title-inner">
        <h1>REVERIES</h1>
        <p class="rv-tag">a universe, dreaming</p>
        <p class="rv-begin">${this.engine.input.isTouch ? 'tap' : 'click'} to begin</p>
      </div>`);
    t.setAttribute('data-ui', '');
    const go = () => { t.classList.add('is-out'); setTimeout(() => t.remove(), 1600); onBegin?.(); };
    t.addEventListener('click', go, { once: true });
    t.addEventListener('touchend', (e) => { e.preventDefault(); go(); }, { once: true });
    this.titleEl = t;
  }

  /** Called every frame by the engine. */
  update() {
    const st = this.engine.input.touch.stick;
    if (st.active && (this.mode === 'onfoot' || this.mode === 'vehicle' || this.mode === 'ship')) {
      this.stickRing.classList.add('is-on');
      this.stickRing.style.transform = `translate(${st.ox}px, ${st.oy}px)`;
      let dx = st.x - st.ox, dy = st.y - st.oy; const l = Math.hypot(dx, dy), R = st.radius;
      if (l > R) { dx *= R / l; dy *= R / l; }
      this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    } else this.stickRing.classList.remove('is-on');
    this.touch.classList.toggle('is-touch', this.engine.input.isTouch && this.mode !== 'map');
  }

  _buildTouchButtons() {
    const input = this.engine.input;
    const mk = (cls, label, action, hold = true) => {
      const b = el('button', 'rv-tbtn ' + cls, this.buttons, label);
      b.setAttribute('data-ui', '');
      const down = (e) => { e.preventDefault(); e.stopPropagation(); input.setVirtual(action, true); b.classList.add('is-down'); };
      const up = (e) => { e.preventDefault(); e.stopPropagation(); input.setVirtual(action, false); b.classList.remove('is-down'); };
      b.addEventListener('touchstart', down, { passive: false });
      b.addEventListener('touchend', up, { passive: false });
      b.addEventListener('touchcancel', up, { passive: false });
      return b;
    };
    this.tJump = mk('is-jump', '<i></i>', 'jump');
    this.tSprint = mk('is-sprint', '<i></i>', 'sprint');
    this.tAction = mk('is-action', '', 'interact');
    this.tView = mk('is-view', '<i></i>', 'toggleView');
    this.tMap = mk('is-map', '<i></i>', 'map');
    this._syncTouchAction();
  }
  _syncTouchAction() {
    if (!this.tAction) return;
    this.tAction.textContent = this._promptKey ? (this._promptText || '').split(' ')[0] : '';
    this.tAction.classList.toggle('is-on', !!this._promptKey);
  }
}
