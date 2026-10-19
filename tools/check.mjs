#!/usr/bin/env node
// Fast safety check before handing work back:
//   1) `node --check` every src/**/*.js (syntax)
//   2) a full Vite production build into a temp dir (resolves every import)
// Usage: node tools/check.mjs [--no-build]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } })(path.join(ROOT, 'src'));
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { bad++; console.log(`SYNTAX ${path.relative(ROOT, f)}\n${String(e.stderr).split('\n').slice(0, 6).join('\n')}`); }
}
console.log(`[check] syntax: ${files.length - bad}/${files.length} ok`);
if (!process.argv.includes('--no-build')) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-build-'));
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'pipe' });
    console.log('[check] vite build: ok');
  } catch (e) { bad++; console.log('[check] vite build FAILED:\n' + String(e.stdout || '') + String(e.stderr || '').slice(0, 4000)); }
  fs.rmSync(out, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);
