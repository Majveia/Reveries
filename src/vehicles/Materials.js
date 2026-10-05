// Shared vehicle materials + procedural hull textures (canvas, generated once).
//
// One 1024² tiling "hull detail" atlas drives every vehicle surface:
//   map        — panel tone variation, panel-line grooves, rivets, vents,
//                stencils, grime and edge wear (multiplies the vertex paint)
//   roughness  — clear-coated panels vs. worn/grimy areas and grooves
//   bump       — recessed panel lines, raised rivets
// Paint color comes from vertex colors, so a single material covers a whole
// livery (one draw call per material per vehicle).

import * as THREE from 'three';
import { Random } from '../core/Random.js';

let _cache = null;

function hullCanvases(seed = 7) {
  const N = 1024;
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = N; return c; };
  const A = mk(), Rg = mk(), B = mk();
  const a = A.getContext('2d'), r = Rg.getContext('2d'), b = B.getContext('2d');
  const rng = new Random(seed);
  a.fillStyle = 'rgb(214,214,214)'; a.fillRect(0, 0, N, N);
  r.fillStyle = 'rgb(118,118,118)'; r.fillRect(0, 0, N, N);
  b.fillStyle = 'rgb(128,128,128)'; b.fillRect(0, 0, N, N);

  // ---- panels: recursive subdivision (tiles because it starts from the full square)
  const panels = [];
  const split = (x, y, w, h, d) => {
    if (d > 5 || (d > 2 && rng.chance(0.28)) || w < 40 || h < 40) { panels.push([x, y, w, h]); return; }
    if (w > h * (0.7 + rng.float() * 0.6)) { const s = Math.round(w * rng.range(0.3, 0.7) / 8) * 8; split(x, y, s, h, d + 1); split(x + s, y, w - s, h, d + 1); }
    else { const s = Math.round(h * rng.range(0.3, 0.7) / 8) * 8; split(x, y, w, s, d + 1); split(x, y + s, w, h - s, d + 1); }
  };
  split(0, 0, N, N, 0);
  for (const [x, y, w, h] of panels) {
    const t = 205 + rng.range(-14, 10);
    a.fillStyle = `rgb(${t},${t},${t})`; a.fillRect(x + 2, y + 2, w - 3, h - 3);
    const ro = 110 + rng.range(-20, 26);
    r.fillStyle = `rgb(${ro},${ro},${ro})`; r.fillRect(x + 2, y + 2, w - 3, h - 3);
    // inset hatch / access panel
    if (w > 90 && h > 90 && rng.chance(0.35)) {
      const iw = w * rng.range(0.3, 0.55), ih = h * rng.range(0.3, 0.55), ix = x + rng.range(12, w - iw - 12), iy = y + rng.range(12, h - ih - 12);
      a.strokeStyle = 'rgba(40,40,40,0.55)'; a.lineWidth = 1.5; a.strokeRect(ix, iy, iw, ih);
      b.strokeStyle = 'rgb(70,70,70)'; b.lineWidth = 2; b.strokeRect(ix, iy, iw, ih);
      // fasteners at the corners
      for (const [cx, cy] of [[ix + 5, iy + 5], [ix + iw - 5, iy + 5], [ix + 5, iy + ih - 5], [ix + iw - 5, iy + ih - 5]]) {
        a.fillStyle = 'rgba(60,60,60,0.8)'; a.beginPath(); a.arc(cx, cy, 2.2, 0, 7); a.fill();
        b.fillStyle = 'rgb(190,190,190)'; b.beginPath(); b.arc(cx, cy, 2.2, 0, 7); b.fill();
      }
    }
    // vents
    if (w > 70 && h > 50 && rng.chance(0.16)) {
      const n = 4 + rng.int(0, 6), vx = x + rng.range(10, w * 0.4), vy = y + rng.range(10, h * 0.5), vw = Math.min(w * 0.5, 80);
      for (let k = 0; k < n; k++) {
        a.fillStyle = 'rgba(25,25,25,0.85)'; a.fillRect(vx, vy + k * 6, vw, 3);
        b.fillStyle = 'rgb(40,40,40)'; b.fillRect(vx, vy + k * 6, vw, 3);
        r.fillStyle = 'rgb(200,200,200)'; r.fillRect(vx, vy + k * 6, vw, 3);
      }
    }
    // stencil marks (tiny "text" dashes) and warning chevrons
    if (rng.chance(0.22)) {
      const sx = x + rng.range(8, Math.max(9, w - 70)), sy = y + rng.range(8, Math.max(9, h - 20));
      a.fillStyle = 'rgba(30,30,30,0.7)';
      for (let k = 0, cx = sx; k < 5 + rng.int(0, 8); k++) { const lw = rng.range(3, 9); a.fillRect(cx, sy, lw, 4); cx += lw + 2; }
      if (rng.chance(0.5)) for (let k = 0, cx = sx; k < 4 + rng.int(0, 6); k++) { const lw = rng.range(2, 6); a.fillRect(cx, sy + 7, lw, 3); cx += lw + 2; }
    }
    if (rng.chance(0.05) && w > 60) {
      const sx = x + 6, sy = y + h - 16;
      for (let k = 0; k < Math.min(10, w / 14); k++) { a.fillStyle = k % 2 ? 'rgba(30,30,30,0.8)' : 'rgba(240,190,40,0.9)'; a.beginPath(); a.moveTo(sx + k * 12, sy); a.lineTo(sx + k * 12 + 8, sy); a.lineTo(sx + k * 12 + 2, sy + 10); a.lineTo(sx + k * 12 - 6, sy + 10); a.fill(); }
    }
    // rivet rows along some edges
    if (rng.chance(0.5)) {
      const horiz = rng.chance(0.5), n = Math.floor((horiz ? w : h) / 14);
      for (let k = 1; k < n; k++) {
        const px = horiz ? x + k * 14 : x + 6, py = horiz ? y + 6 : y + k * 14;
        a.fillStyle = 'rgba(80,80,80,0.6)'; a.fillRect(px - 1, py - 1, 2.5, 2.5);
        b.fillStyle = 'rgb(175,175,175)'; b.fillRect(px - 1, py - 1, 2.5, 2.5);
      }
    }
  }
  // panel lines (grooves): dark core + soft light lip
  for (const [x, y, w, h] of panels) {
    a.strokeStyle = 'rgba(28,28,28,0.95)'; a.lineWidth = 2; a.strokeRect(x + 0.5, y + 0.5, w, h);
    a.strokeStyle = 'rgba(255,255,255,0.18)'; a.lineWidth = 1; a.strokeRect(x + 2.5, y + 2.5, w - 4, h - 4);
    r.strokeStyle = 'rgb(225,225,225)'; r.lineWidth = 2.5; r.strokeRect(x + 0.5, y + 0.5, w, h);
    b.strokeStyle = 'rgb(20,20,20)'; b.lineWidth = 3; b.strokeRect(x + 0.5, y + 0.5, w, h);
  }
  // grime streaks, wear and scratches (soft, wrap-safe because they are small)
  for (let k = 0; k < 140; k++) {
    const x = rng.range(0, N), y = rng.range(0, N), rr = rng.range(10, 70);
    const g = a.createRadialGradient(x, y, 0, x, y, rr);
    g.addColorStop(0, `rgba(40,34,28,${rng.range(0.05, 0.16)})`); g.addColorStop(1, 'rgba(40,34,28,0)');
    a.fillStyle = g; a.fillRect(x - rr, y - rr, rr * 2, rr * 2);
    const gr = r.createRadialGradient(x, y, 0, x, y, rr);
    gr.addColorStop(0, `rgba(230,230,230,${rng.range(0.1, 0.3)})`); gr.addColorStop(1, 'rgba(230,230,230,0)');
    r.fillStyle = gr; r.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  for (let k = 0; k < 260; k++) {
    const x = rng.range(0, N), y = rng.range(0, N), L = rng.range(6, 40), ang = rng.range(-0.4, 0.4) + (rng.chance(0.5) ? 0 : Math.PI / 2);
    a.strokeStyle = `rgba(255,255,255,${rng.range(0.08, 0.25)})`; a.lineWidth = rng.range(0.5, 1.3);
    a.beginPath(); a.moveTo(x, y); a.lineTo(x + Math.cos(ang) * L, y + Math.sin(ang) * L); a.stroke();
    r.strokeStyle = 'rgba(200,200,200,0.5)'; r.beginPath(); r.moveTo(x, y); r.lineTo(x + Math.cos(ang) * L, y + Math.sin(ang) * L); r.stroke();
  }
  // vertical rain/grime streaks
  for (let k = 0; k < 90; k++) {
    const x = rng.range(0, N), y = rng.range(0, N), L = rng.range(20, 120);
    const g = a.createLinearGradient(x, y, x, y + L);
    g.addColorStop(0, `rgba(30,26,22,${rng.range(0.06, 0.18)})`); g.addColorStop(1, 'rgba(30,26,22,0)');
    a.fillStyle = g; a.fillRect(x, y, rng.range(1, 4), L);
  }
  return { A, Rg, B };
}

function tex(canvas, srgb, aniso) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Shared materials (cached per engine; vehicles never dispose them individually). */
export function vehicleMaterials(engine) {
  if (_cache && _cache.engine === engine) return _cache;
  const aniso = Math.min(8, engine.renderer.capabilities.getMaxAnisotropy?.() || 4);
  const { A, Rg, B } = hullCanvases(11);
  const map = tex(A, true, aniso), roughnessMap = tex(Rg, false, aniso), bumpMap = tex(B, false, aniso);
  const paint = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, map, roughnessMap, bumpMap, bumpScale: 1.2,
    metalness: 0.18, roughness: 0.62, clearcoat: 0.55, clearcoatRoughness: 0.22, envMapIntensity: 1.0,
  });
  const metal = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, map, roughnessMap, bumpMap, bumpScale: 1.0,
    metalness: 0.85, roughness: 0.55, envMapIntensity: 1.1,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x0b1820, metalness: 0.0, roughness: 0.05, clearcoat: 1.0, clearcoatRoughness: 0.03,
    envMapIntensity: 2.4, specularIntensity: 1.0, ior: 1.5,
  });
  const glows = new Map();
  const glow = (hex, k = 1) => {
    const key = hex + ':' + k;
    if (!glows.has(key)) glows.set(key, new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), fog: false }));
    return glows.get(key);
  };
  _cache = { engine, paint, metal, glass, glow, textures: [map, roughnessMap, bumpMap] };
  return _cache;
}
