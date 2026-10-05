#!/usr/bin/env node
// Screenshot harness — renders Reveries headlessly (SwiftShader WebGL2) and
// captures named camera presets ("shots") defined by each level.
//
//   node tools/shoot.mjs --scene planet --p 2 --shots vista,city --out shots/
//   node tools/shoot.mjs --scene cosmos --shots hero --w 1600 --h 900
//   node tools/shoot.mjs --scene planet --shots character --mobile --ui 1
//
// Options:
//   --scene cosmos|galaxy|system|planet   level to load (default cosmos)
//   --g --s --p                            universe address
//   --shots a,b,c                          shot presets (default: "default" = no preset)
//   --out DIR|FILE.png                     output (default shots/)
//   --w --h                                viewport (default 1280x720)
//   --q low|medium|high|ultra              quality tier (default high)
//   --frames N                             frames to render after each preset (default 24)
//   --time T                               planet time of day 0..1
//   --spawn orbit|surface|…                planet spawn
//   --ui 0|1                               show UI (default 0)
//   --mobile                               emulate a phone (390x844, touch)
//   --eval "js"                            run JS in page after ready (before shots)
//   --timeout SEC                          max wait for ready (default 300)
//   --extra "k=v&k2=v2"                    extra URL params
//
// Uses one shared Vite dev server on :5173 (auto-started) and a global lock so
// parallel agents queue for the (CPU-bound) software renderer.

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
    args[k] = v;
  }
}
const PORT = 5173;
const BASE = `http://localhost:${PORT}/`;
const LOCK = '/tmp/reveries-shoot.lock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverUp() {
  try { const r = await fetch(BASE, { signal: AbortSignal.timeout(3000) }); return r.ok; } catch { return false; }
}

async function ensureServer() {
  if (await serverUp()) return;
  const lock = '/tmp/reveries-vite.lock';
  let owner = false;
  try { fs.mkdirSync(lock); owner = true; } catch { /* someone else is starting it */ }
  if (owner) {
    const log = fs.openSync('/tmp/reveries-vite.log', 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '0.0.0.0', '--port', String(PORT), '--strictPort'], { cwd: ROOT, detached: true, stdio: ['ignore', log, log] });
    child.unref();
  }
  for (let i = 0; i < 120; i++) { if (await serverUp()) break; await sleep(500); }
  if (owner) try { fs.rmdirSync(lock); } catch { /* ignore */ }
  if (!(await serverUp())) throw new Error('Vite dev server did not start (see /tmp/reveries-vite.log)');
}

async function acquire() {
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid));
      return;
    } catch {
      // stale lock?
      try {
        const pid = parseInt(fs.readFileSync(path.join(LOCK, 'pid'), 'utf8'), 10);
        const st = fs.statSync(LOCK);
        let alive = true;
        try { process.kill(pid, 0); } catch { alive = false; }
        if (!alive || Date.now() - st.mtimeMs > 15 * 60 * 1000) { fs.rmSync(LOCK, { recursive: true, force: true }); continue; }
      } catch { /* lock dir without pid yet */ }
      if ((Date.now() - start) % 30000 < 1000) console.error(`[shoot] waiting for renderer lock… ${Math.round((Date.now() - start) / 1000)}s`);
      await sleep(1000);
    }
  }
}
function release() { try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* ignore */ } }

async function main() {
  await ensureServer();
  const scene = args.scene || 'cosmos';
  const shots = (args.shots || 'default').split(',').filter(Boolean);
  const W = parseInt(args.w || (args.mobile ? 390 : 1280), 10), H = parseInt(args.h || (args.mobile ? 844 : 720), 10);
  const params = new URLSearchParams();
  params.set('scene', scene); params.set('shot', '1');
  for (const k of ['g', 's', 'p', 'time', 'spawn']) if (args[k] != null) params.set(k, args[k]);
  params.set('q', args.q || 'high');
  params.set('ui', args.ui || '0');
  if (args.extra) for (const [k, v] of new URLSearchParams(args.extra)) params.set(k, v);
  const url = `${BASE}?${params}`;
  let out = args.out || 'shots/';
  const outIsFile = out.endsWith('.png') || out.endsWith('.jpg');
  if (!outIsFile) fs.mkdirSync(path.resolve(ROOT, out), { recursive: true });
  else fs.mkdirSync(path.dirname(path.resolve(ROOT, out)), { recursive: true });

  await acquire();
  const t0 = Date.now();
  const logs = [];
  let browser;
  try {
    browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, ignoreHTTPSErrors: true, deviceScaleFactor: 1, isMobile: !!args.mobile, hasTouch: !!args.mobile });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`.slice(0, 600)); });
    page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e.stack || e).slice(0, 1200)}`));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const timeout = parseInt(args.timeout || '300', 10) * 1000;
    const start = Date.now();
    for (;;) {
      const st = await page.evaluate(() => ({ ready: !!window.__REVERIES__?.ready, err: window.__REVERIES__?.error || null })).catch(() => ({ ready: false }));
      if (st.ready) break;
      if (Date.now() - start > timeout) throw new Error(`timeout waiting for ready (${timeout / 1000}s). last error: ${st.err}`);
      await sleep(500);
    }
    if (args.eval) await page.evaluate(args.eval);
    const results = [];
    for (const shot of shots) {
      let ok = true;
      if (shot !== 'default') ok = await page.evaluate((s) => window.__REVERIES__.shot(s), shot);
      if (!ok) { logs.push(`[shoot] level has no shot "${shot}" (available: ${await page.evaluate(() => window.__REVERIES__.shots().join(','))})`); }
      const frames = parseInt(args.frames || '24', 10);
      await page.evaluate((n) => window.__REVERIES__.frames(n), frames);
      const file = outIsFile ? path.resolve(ROOT, out) : path.resolve(ROOT, out, `${scene}${args.p != null ? '-p' + args.p : ''}-${shot}${args.mobile ? '-mobile' : ''}.png`);
      await page.screenshot({ path: file, type: 'png' });
      results.push(file);
      console.log(`[shoot] ${shot} → ${path.relative(ROOT, file)}`);
    }
    const err = await page.evaluate(() => window.__REVERIES__?.error);
    if (err) logs.push(`[engine-error] ${err}`);
    const info = await page.evaluate(() => { const r = window.__REVERIES__?.engine?.renderer?.info; return r ? { calls: r.render.calls, triangles: r.render.triangles, textures: r.memory.textures, geometries: r.memory.geometries } : null; });
    console.log(`[shoot] done in ${((Date.now() - t0) / 1000).toFixed(1)}s ${info ? JSON.stringify(info) : ''}`);
  } finally {
    await browser?.close().catch(() => {});
    release();
  }
  if (logs.length) { console.log('[shoot] console:'); for (const l of [...new Set(logs)].slice(0, 40)) console.log('  ' + l); }
}

main().catch((e) => { console.error('[shoot] FAILED:', e.message); release(); process.exit(1); });
