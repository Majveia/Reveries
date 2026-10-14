#!/usr/bin/env node
// Package a production build for publishing as a hosted page.
//
//   node tools/artifact.mjs <outDir>
//
// Builds with Vite into <outDir>, then writes <outDir>/reveries.html: the same
// page as index.html but without the document skeleton (the host wraps the
// page in its own <html>/<head>/<body>), with a dark color-scheme so the
// host's light default never shows around the canvas. Prints the asset list.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));
execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });

const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/i)[1];
const keep = head
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !/^<meta (charset|name="viewport")/i.test(l));
const page = [
  ...keep.filter((l) => l.startsWith('<title')),
  '<style>:root{color-scheme:dark}html,body{background:#000;color:#eef2ff;height:100%;margin:0;overflow:hidden}</style>',
  ...keep.filter((l) => !l.startsWith('<title') && !l.startsWith('<style')),
].join('\n');
fs.writeFileSync(path.join(out, 'reveries.html'), page + '\n');

const assets = fs.readdirSync(path.join(out, 'assets')).map((f) => `assets/${f}`);
console.log(JSON.stringify({ page: path.join(out, 'reveries.html'), root: out, assets }, null, 1));
