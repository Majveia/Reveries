// Procedural foliage atlas (canvas → DataTexture with colour-dilated alpha so
// mipmapped alpha-tested cards never grow dark fringes). 4×2 tiles:
//   0 broadleaf cluster   1 conifer needle spray   2 maple cluster   3 palm frond
//   4 small round leaves  5 hanging strands/fronds 6 fern / scrub    7 solid
// Tiles are near-white luminance with gentle variation; plant colour comes from
// vertex/instance colours so one atlas serves every species and palette.
import * as THREE from 'three';
import { Random } from '../../../core/Random.js';

export const TILE = { broad: 0, needle: 1, maple: 2, frond: 3, small: 4, strand: 5, fern: 6, solid: 7 };
export const ATLAS_COLS = 4, ATLAS_ROWS = 2;

/** uv rect of a tile: [u0, v0, u1, v1] (with a half-texel inset). */
export function tileRect(t) {
  const c = t % ATLAS_COLS, r = Math.floor(t / ATLAS_COLS);
  const e = 1.5 / 1024;
  return [c / ATLAS_COLS + e, 1 - (r + 1) / ATLAS_ROWS + e, (c + 1) / ATLAS_COLS - e, 1 - r / ATLAS_ROWS - e];
}

function leafPath(ctx, len, wid, tipSharp = 0.5) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(wid * 0.9, len * 0.15, wid * 0.8, len * (0.75 - tipSharp * 0.2), 0, len);
  ctx.bezierCurveTo(-wid * 0.8, len * (0.75 - tipSharp * 0.2), -wid * 0.9, len * 0.15, 0, 0);
  ctx.closePath();
}

function shadeLeaf(ctx, rng, len, wid, base) {
  const l = base * (0.82 + rng.float() * 0.3);
  const g = ctx.createLinearGradient(-wid, 0, wid, len);
  const c1 = Math.round(255 * Math.min(1, l * 1.05)), c0 = Math.round(255 * l * 0.78);
  g.addColorStop(0, `rgb(${c0},${c0},${Math.round(c0 * 0.92)})`);
  g.addColorStop(1, `rgb(${c1},${c1},${Math.round(c1 * 0.9)})`);
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = `rgba(255,255,240,0.35)`; ctx.lineWidth = Math.max(0.6, wid * 0.08);
  ctx.beginPath(); ctx.moveTo(0, len * 0.04); ctx.lineTo(0, len * 0.92); ctx.stroke();
}

function drawBroad(ctx, S, rng, small = false) {
  const cx = S / 2, cy = S / 2;
  const n = small ? 70 : 46;
  for (let i = 0; i < n; i++) {
    const a = rng.float() * Math.PI * 2, r = Math.sqrt(rng.float()) * S * 0.36;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.9;
    ctx.save(); ctx.translate(x, y); ctx.rotate(a + Math.PI / 2 + (rng.float() - 0.5) * 1.6);
    const len = (small ? 0.075 : 0.13) * S * (0.75 + rng.float() * 0.5), wid = len * (small ? 0.5 : 0.42);
    leafPath(ctx, len, wid, small ? 0.2 : 0.6);
    shadeLeaf(ctx, rng, len, wid, 0.6 + 0.4 * (r / (S * 0.36)));
    ctx.restore();
  }
}

function drawNeedles(ctx, S, rng) {
  // a flat fir spray: central twig with dense needles, side twiglets
  const twig = (x0, y0, ang, len, w) => {
    const dx = Math.cos(ang), dy = Math.sin(ang);
    ctx.strokeStyle = 'rgb(120,105,90)'; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + dx * len, y0 + dy * len); ctx.stroke();
    const n = Math.floor(len / 1.5);
    for (let i = 2; i < n; i++) {
      const t = i / n, px = x0 + dx * len * t, py = y0 + dy * len * t;
      const nl = (1 - t * 0.55) * S * 0.07 * (0.8 + rng.float() * 0.4);
      for (const s of [-1, 1]) {
        const na = ang + s * (0.95 + rng.float() * 0.3);
        const l = 0.55 + rng.float() * 0.4;
        const c = Math.round(255 * l);
        ctx.strokeStyle = `rgb(${c},${c},${Math.round(c * 0.9)})`; ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl); ctx.stroke();
      }
    }
  };
  twig(S * 0.5, S * 0.97, -Math.PI / 2, S * 0.92, 3);
  for (let k = 0; k < 7; k++) {
    const t = 0.15 + k * 0.11, y = S * (0.97 - 0.92 * t);
    for (const s of [-1, 1]) twig(S * 0.5, y, -Math.PI / 2 + s * (0.9 + rng.float() * 0.25), S * 0.36 * (1 - t * 0.6), 1.6);
  }
}

function drawMaple(ctx, S, rng) {
  const cx = S / 2, cy = S / 2;
  for (let i = 0; i < 34; i++) {
    const a = rng.float() * Math.PI * 2, r = Math.sqrt(rng.float()) * S * 0.36;
    ctx.save(); ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.9); ctx.rotate(rng.float() * Math.PI * 2);
    const s = S * 0.075 * (0.8 + rng.float() * 0.45);
    ctx.beginPath();
    for (let k = 0; k <= 10; k++) {
      const ang = (k / 10) * Math.PI * 2 - Math.PI / 2;
      const lobe = k % 2 === 0 ? 1 : 0.42;
      const rr = s * lobe * (k === 0 || k === 10 ? 1.1 : k === 4 || k === 6 ? 0.75 : 1);
      if (k === 0) ctx.moveTo(Math.cos(ang) * rr, Math.sin(ang) * rr); else ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
    }
    ctx.closePath();
    const l = 0.62 + rng.float() * 0.38, c = Math.round(255 * l);
    ctx.fillStyle = `rgb(${c},${c},${c})`; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1;
    for (let k = 0; k < 5; k++) { const ang = (k / 5) * Math.PI * 2 - Math.PI / 2; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(ang) * s * 0.8, Math.sin(ang) * s * 0.8); ctx.stroke(); }
    ctx.restore();
  }
}

function drawFrond(ctx, S, rng) {
  // u (x) runs along the frond: rachis down the middle, leaflets angled to the tip
  const y0 = S / 2;
  ctx.strokeStyle = 'rgb(200,190,150)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(2, y0); ctx.lineTo(S - 2, y0); ctx.stroke();
  for (let i = 0; i < 44; i++) {
    const t = i / 44, x = 4 + t * (S - 10);
    const L = S * 0.46 * Math.sin(Math.PI * (0.12 + t * 0.88)) * (0.85 + rng.float() * 0.2);
    for (const s of [-1, 1]) {
      const l = 0.6 + rng.float() * 0.35, c = Math.round(255 * l);
      ctx.strokeStyle = `rgb(${c},${c},${Math.round(c * 0.88)})`; ctx.lineWidth = 3.2 * (1 - t * 0.5);
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.quadraticCurveTo(x + L * 0.3, y0 + s * L * 0.5, x + L * 0.55, y0 + s * L * 0.95); ctx.stroke();
    }
  }
}

function drawStrands(ctx, S, rng) {
  // hanging strands with beads (willow / Tree-of-Souls / glowing vines)
  for (let i = 0; i < 26; i++) {
    const x = S * (0.08 + 0.84 * rng.float()), len = S * (0.55 + rng.float() * 0.42);
    const l = 0.5 + rng.float() * 0.18, c = Math.round(255 * l);
    ctx.strokeStyle = `rgb(${c},${c},${c})`; ctx.lineWidth = 3.2;
    ctx.beginPath(); ctx.moveTo(x, 0);
    const sw = (rng.float() - 0.5) * S * 0.08;
    ctx.quadraticCurveTo(x + sw, len * 0.5, x + sw * 0.4, len); ctx.stroke();
    for (let k = 0; k < 9; k++) {
      const t = rng.float(), px = x + sw * (2 * t * (1 - t)) + sw * 0.4 * t * t, py = len * t;
      ctx.fillStyle = `rgb(255,255,255)`; ctx.beginPath(); ctx.ellipse(px, py, 2.2 + rng.float() * 2.5, 3 + rng.float() * 3, 0, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function drawFern(ctx, S, rng) {
  for (let f = 0; f < 7; f++) {
    const ang = -Math.PI / 2 + (f - 3) * 0.32 + (rng.float() - 0.5) * 0.15;
    const len = S * (0.62 + rng.float() * 0.3);
    const x0 = S / 2, y0 = S * 0.98;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    ctx.strokeStyle = 'rgb(170,170,140)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + dx * len, y0 + dy * len); ctx.stroke();
    for (let i = 1; i < 18; i++) {
      const t = i / 18, px = x0 + dx * len * t, py = y0 + dy * len * t, L = S * 0.09 * Math.sin(Math.PI * (0.15 + 0.85 * t));
      for (const s of [-1, 1]) {
        const na = ang + s * 1.1, l = 0.6 + rng.float() * 0.35, c = Math.round(255 * l);
        ctx.save(); ctx.translate(px, py); ctx.rotate(na - Math.PI / 2);
        leafPath(ctx, L, L * 0.35, 0.3); ctx.fillStyle = `rgb(${c},${c},${Math.round(c * 0.9)})`; ctx.fill(); ctx.restore();
      }
    }
  }
}

let _atlas = null;
/** Shared foliage atlas (built once per page). */
export function foliageAtlas() {
  if (_atlas) return _atlas;
  const S = 256, W = S * ATLAS_COLS, H = S * ATLAS_ROWS;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const rng = new Random(9127);
  const draw = [drawBroad, drawNeedles, drawMaple, drawFrond, (c, s, r) => drawBroad(c, s, r, true), drawStrands, drawFern, null];
  for (let t = 0; t < draw.length; t++) {
    const c = t % ATLAS_COLS, r = Math.floor(t / ATLAS_COLS);
    ctx.save(); ctx.translate(c * S, r * S);
    ctx.beginPath(); ctx.rect(0, 0, S, S); ctx.clip();
    if (draw[t]) draw[t](ctx, S, rng); else { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, S, S); }
    ctx.restore();
  }
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  // dilate colour into transparent texels (per tile mean) to keep mip edges clean
  for (let t = 0; t < 8; t++) {
    const c0 = (t % ATLAS_COLS) * S, r0 = Math.floor(t / ATLAS_COLS) * S;
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let y = r0; y < r0 + S; y++) for (let x = c0; x < c0 + S; x++) { const k = (y * W + x) * 4; if (d[k + 3] > 128) { sr += d[k]; sg += d[k + 1]; sb += d[k + 2]; n++; } }
    if (!n) continue;
    sr /= n; sg /= n; sb /= n;
    for (let y = r0; y < r0 + S; y++) for (let x = c0; x < c0 + S; x++) {
      const k = (y * W + x) * 4, a = d[k + 3] / 255;
      if (a < 1) { d[k] = d[k] * a + sr * (1 - a); d[k + 1] = d[k + 1] * a + sg * (1 - a); d[k + 2] = d[k + 2] * a + sb * (1 - a); }
      if (a > 0.08 && a < 0.6) d[k + 3] = Math.min(255, d[k + 3] * 1.6); // fatter edges survive mips
    }
  }
  // canvas rows are top-down; flip so v=1 is the top row (three convention, flipY off for DataTexture)
  const flipped = new Uint8Array(d.length);
  for (let y = 0; y < H; y++) flipped.set(d.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  const tex = new THREE.DataTexture(flipped, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  _atlas = tex;
  return tex;
}
