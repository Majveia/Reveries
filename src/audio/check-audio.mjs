#!/usr/bin/env node
// Offline level check for the procedural audio (you can't listen in CI, so measure).
// Renders N seconds of every scene's music (space scenes + every aesthetic, day
// and night), the planet ambience beds and every SFX through the real master
// chain in an OfflineAudioContext inside headless Chromium, then reports
// peak / RMS (dBFS), silent windows, clipping and NaNs.
//
//   node src/audio/check-audio.mjs [--secs 10] [--only cosmos,jazz] [--module /src/audio/Audio.js]
// Needs the Vite dev server on :5173 (tools/shoot.mjs starts it).
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SECS = parseFloat(arg('secs', '10'));
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const MOD = arg('module', '/src/audio/Audio.js');
const URL = arg('url', 'http://localhost:5173');

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(URL + '/src/audio/Theory.js');

const res = await page.evaluate(async ({ SECS, ONLY, MOD }) => {
  const { AudioEngine } = await import(MOD);
  const { AESTHETICS } = await import('/src/universe/Aesthetics.js');
  const SR = 44100;
  const stats = (buf, skip = 0) => {
    let peak = 0, sum = 0, n = 0, nan = 0, clip = 0;
    const win = Math.floor(SR * 0.5), wins = [];
    let wsum = 0, wn = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = Math.floor(skip * SR); i < d.length; i++) {
        const x = d[i];
        if (!Number.isFinite(x)) { nan++; continue; }
        const a = Math.abs(x); if (a > peak) peak = a; if (a >= 0.999) clip++;
        sum += x * x; n++;
        if (c === 0) { wsum += x * x; wn++; if (wn === win) { wins.push(Math.sqrt(wsum / wn)); wsum = 0; wn = 0; } }
      }
    }
    const db = (x) => (x > 0 ? 20 * Math.log10(x) : -999);
    const rms = Math.sqrt(sum / Math.max(1, n));
    const mi = wins.indexOf(Math.min(...wins));
    return { minAt: +(skip + mi * 0.5).toFixed(1), peakDb: +db(peak).toFixed(1), rmsDb: +db(rms).toFixed(1), minWinDb: +db(Math.min(...wins)).toFixed(1), maxWinDb: +db(Math.max(...wins)).toFixed(1), clip, nan };
  };
  const make = (secs) => {
    const ctx = new OfflineAudioContext(2, Math.floor(SR * secs), SR);
    const ae = new AudioEngine({ level: null, shotMode: true });
    ae.fadeIn = 0.5;
    ae.attach(ctx);
    return { ctx, ae };
  };
  const out = [];
  const specs = [['cosmos', null], ['galaxy', null], ['system', null]];
  for (const [id, a] of Object.entries(AESTHETICS)) specs.push([`planet:${id}`, a.music]);
  for (const [name, music] of specs) {
    for (const night of [0, 1]) {
      if (night && !name.startsWith('planet')) continue;
      const tag = `${name}${night ? ' (night)' : ''} ${music ? music.timbre + '/' + music.scale : ''}`;
      if (ONLY.length && !ONLY.some((o) => tag.includes(o))) continue;
      const { ctx, ae } = make(SECS);
      const t0 = performance.now();
      ae.setScene(name.split(':')[0], music);
      ae.music.setNight(night);
      // pump like the realtime engine does (0.6 s lookahead), via suspend/resume
      for (let t = 0.25; t < SECS; t += 0.25) ctx.suspend(t).then(() => { ae.music.pump(t, t + 0.6); ctx.resume(); });
      ae.music.pump(0, 0.6);
      const buf = await ctx.startRendering();
      out.push({ tag, ms: Math.round(performance.now() - t0), ...stats(buf, Math.min(4, SECS * 0.3)) });
    }
  }
  if (!ONLY.length || ONLY.includes('xfade')) {
    // scene changes: warp whoosh + crossfade + arrival swell, twice, through the master chain
    const secs = 22, { ctx, ae } = make(secs);
    ae.setScene('cosmos');
    const plan = [[5, () => { ae.fx.play('warp', {}, 5); ae.setScene('galaxy'); }], [12, () => { ae.fx.play('warp', {}, 12); ae.setScene('planet', AESTHETICS.bebop.music); }]];
    for (let t = 0.25; t < secs; t += 0.25) ctx.suspend(t).then(() => { for (const [pt, fn] of plan) if (Math.abs(pt - t) < 0.01) fn(); ae.music.pump(t, t + 0.6); ae._old.forEach((m) => m.pump(t, t + 0.6)); ctx.resume(); });
    ae.music.pump(0, 0.6);
    const buf = await ctx.startRendering();
    out.push({ tag: 'xfade cosmos>galaxy>bebop', ...stats(buf, 3) });
  }
  if (!ONLY.length || ONLY.includes('amb')) {
    // planet ambience beds at full drive
    for (const [k, p] of [['wind', { wind: 1 }], ['surf', { surf: 1 }], ['birds', { birds: 1 }], ['insects', { insects: 1 }], ['city', { city: 1 }], ['rain', { rain: 1, storm: 1 }], ['all', { wind: 0.8, surf: 1, birds: 1, insects: 0.5, city: 1, rain: 1, storm: 1 }]]) {
      const { ctx, ae } = make(SECS);
      
      ae.ambBus.gain.value = 1; ae._ensureAmb();
      Object.assign(ae.amb.p, p); Object.assign(ae.amb.cur, p);
      for (let t = 0; t < SECS; t += 0.05) ae.amb.update(0.05, t);
      const buf = await ctx.startRendering();
      out.push({ tag: `ambience:${k}`, ...stats(buf, 0.5) });
    }
    // SFX one-shots
    for (const s of ['hover', 'ui', 'select', 'discover', 'warp', 'arrive', 'takeoff', 'boost', 'jump', 'land', 'step:grass', 'step:rock', 'step:snow', 'step:water', 'step:metal', 'step:sand', 'step:wet', 'board', 'alight']) {
      const { ctx, ae } = make(4);
      
      const [n, surface] = s.split(':');
      ae.fx.play(n, { intensity: 1, surface }, 0.05);
      const buf = await ctx.startRendering();
      out.push({ tag: `sfx:${s}`, ...stats(buf, 0) });
    }
    for (const [kind, th] of [['bike', 0.3], ['bike', 1], ['ship', 0.3], ['ship', 1.2]]) {
      const { ctx, ae } = make(3);
      
      ae.motors.set(kind, th);
      for (let t = 0; t < 3; t += 0.05) ae.motors.update(t, th);
      const buf = await ctx.startRendering();
      out.push({ tag: `motor:${kind}@${th}`, ...stats(buf, 1) });
    }
  }
  return out;
}, { SECS, ONLY, MOD });

let bad = 0;
for (const r of res) {
  const flags = [];
  if (r.nan) flags.push('NaN');
  if (r.clip) flags.push('CLIP');
  if (r.peakDb > -0.5) flags.push('HOT');
  if (r.tag.startsWith('sfx') ? r.peakDb < -40 : r.rmsDb < -45) flags.push('SILENT');
  if (!r.tag.startsWith('sfx') && r.minWinDb < -60) flags.push('GAP');
  if (flags.some((f) => f !== 'GAP')) bad++;
  console.log(`${r.tag.padEnd(46)} peak ${String(r.peakDb).padStart(6)}  rms ${String(r.rmsDb).padStart(6)}  win ${String(r.minWinDb).padStart(6)}..${String(r.maxWinDb).padStart(6)} @${String(r.minAt).padStart(4)}s ${r.ms != null ? (r.ms + 'ms').padStart(7) : ''} ${flags.join(' ')}`);
}
await browser.close();
console.log(bad ? `[audio-check] ${bad} problem(s)` : '[audio-check] ok');
process.exit(bad ? 1 : 0);
