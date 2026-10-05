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

  // ---- panels: recursive subdivision (tiles because it starts from the full square).
  // Scale: vehicles map ~2.4 m (ship) / ~1.1 m (bike) onto one tile, so panels are
  // 25 cm – 1.2 m and grooves (8 px) stay 1–2 cm wide: they read at chase distance.
  const panels = [];
  const split = (x, y, w, h, d) => {
    if (d > 4 || (d > 2 && rng.chance(0.3)) || w < 220 || h < 220) { panels.push([x, y, w, h]); return; }
    if (w > h * (0.7 + rng.float() * 0.6)) { const s = Math.round(w * rng.range(0.32, 0.68) / 16) * 16; split(x, y, s, h, d + 1); split(x + s, y, w - s, h, d + 1); }
    else { const s = Math.round(h * rng.range(0.32, 0.68) / 16) * 16; split(x, y, w, s, d + 1); split(x, y + s, w, h - s, d + 1); }
  };
  split(0, 0, N, N, 0);
  for (const [x, y, w, h] of panels) {
    const t = 206 + rng.range(-22, 16);
    a.fillStyle = `rgb(${t},${t},${t})`; a.fillRect(x, y, w, h);
    // subtle oil-canning: each panel slightly domed (lighter centre)
    const gr = a.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) * 0.7);
    gr.addColorStop(0, 'rgba(255,255,255,0.06)'); gr.addColorStop(1, 'rgba(0,0,0,0.07)');
    a.fillStyle = gr; a.fillRect(x, y, w, h);
    const ro = 64 + rng.range(-14, 30);
    r.fillStyle = `rgb(${ro},${ro},${ro})`; r.fillRect(x, y, w, h);
    const bg = b.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) * 0.7);
    bg.addColorStop(0, 'rgb(150,150,150)'); bg.addColorStop(1, 'rgb(128,128,128)');
    b.fillStyle = bg; b.fillRect(x, y, w, h);
    // inset hatch / access panel
    if (w > 160 && h > 160 && rng.chance(0.4)) {
      const iw = w * rng.range(0.3, 0.55), ih = h * rng.range(0.3, 0.55), ix = x + rng.range(20, w - iw - 20), iy = y + rng.range(20, h - ih - 20);
      a.strokeStyle = 'rgba(40,40,40,0.8)'; a.lineWidth = 4; a.strokeRect(ix, iy, iw, ih);
      b.strokeStyle = 'rgb(60,60,60)'; b.lineWidth = 5; b.strokeRect(ix, iy, iw, ih);
      r.strokeStyle = 'rgb(200,200,200)'; r.lineWidth = 4; r.strokeRect(ix, iy, iw, ih);
      for (const [cx, cy] of [[ix + 10, iy + 10], [ix + iw - 10, iy + 10], [ix + 10, iy + ih - 10], [ix + iw - 10, iy + ih - 10]]) {
        a.fillStyle = 'rgba(55,55,55,0.9)'; a.beginPath(); a.arc(cx, cy, 4.5, 0, 7); a.fill();
        b.fillStyle = 'rgb(200,200,200)'; b.beginPath(); b.arc(cx, cy, 4.5, 0, 7); b.fill();
      }
    }
    // vents (louvres)
    if (w > 140 && h > 100 && rng.chance(0.18)) {
      const n = 4 + rng.int(0, 5), vx = x + rng.range(18, w * 0.4), vy = y + rng.range(18, h * 0.45), vw = Math.min(w * 0.5, 160);
      for (let k = 0; k < n; k++) {
        a.fillStyle = 'rgba(18,18,18,0.92)'; a.fillRect(vx, vy + k * 13, vw, 7);
        b.fillStyle = 'rgb(30,30,30)'; b.fillRect(vx, vy + k * 13, vw, 7);
        b.fillStyle = 'rgb(190,190,190)'; b.fillRect(vx, vy + k * 13 + 7, vw, 3);
        r.fillStyle = 'rgb(210,210,210)'; r.fillRect(vx, vy + k * 13, vw, 7);
      }
    }
    // stencil marks and warning chevrons
    if (rng.chance(0.25)) {
      const sx = x + rng.range(16, Math.max(17, w - 140)), sy = y + rng.range(16, Math.max(17, h - 40));
      a.fillStyle = 'rgba(25,25,25,0.75)';
      for (let k = 0, cx = sx; k < 5 + rng.int(0, 7); k++) { const lw = rng.range(6, 16); a.fillRect(cx, sy, lw, 8); cx += lw + 4; }
      if (rng.chance(0.5)) for (let k = 0, cx = sx; k < 4 + rng.int(0, 6); k++) { const lw = rng.range(4, 10); a.fillRect(cx, sy + 13, lw, 5); cx += lw + 4; }
    }
    if (rng.chance(0.06) && w > 120) {
      const sx = x + 12, sy = y + h - 30;
      for (let k = 0; k < Math.min(10, w / 26); k++) { a.fillStyle = k % 2 ? 'rgba(30,30,30,0.85)' : 'rgba(240,190,40,0.9)'; a.beginPath(); a.moveTo(sx + k * 24, sy); a.lineTo(sx + k * 24 + 16, sy); a.lineTo(sx + k * 24 + 4, sy + 20); a.lineTo(sx + k * 24 - 12, sy + 20); a.fill(); }
    }
    // rivet rows along some edges
    if (rng.chance(0.55)) {
      const horiz = rng.chance(0.5), n = Math.floor((horiz ? w : h) / 24);
      for (let k = 1; k < n; k++) {
        const px = horiz ? x + k * 24 : x + 14, py = horiz ? y + 14 : y + k * 24;
        a.fillStyle = 'rgba(70,70,70,0.7)'; a.beginPath(); a.arc(px, py, 3, 0, 7); a.fill();
        b.fillStyle = 'rgb(185,185,185)'; b.beginPath(); b.arc(px, py, 3, 0, 7); b.fill();
      }
    }
  }
  // panel lines: dark 8 px groove with a soft occlusion halo + a light catching lip
  for (const [x, y, w, h] of panels) {
    a.strokeStyle = 'rgba(0,0,0,0.14)'; a.lineWidth = 16; a.strokeRect(x, y, w, h);
    a.strokeStyle = 'rgb(88,88,88)'; a.lineWidth = 7; a.strokeRect(x, y, w, h);
    a.strokeStyle = 'rgba(255,255,255,0.22)'; a.lineWidth = 2; a.strokeRect(x + 6, y + 6, w - 12, h - 12);
    r.strokeStyle = 'rgb(220,220,220)'; r.lineWidth = 10; r.strokeRect(x, y, w, h);
  }
  b.filter = 'blur(2px)';
  for (const [x, y, w, h] of panels) { b.strokeStyle = 'rgb(10,10,10)'; b.lineWidth = 10; b.strokeRect(x, y, w, h); }
  b.filter = 'none';
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
  // lacquered paint: roughness comes straight from the map (≈0.25 panels, 0.85 grooves) under a glossy clear coat
  const paint = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, map, roughnessMap, bumpMap, bumpScale: 2.2,
    metalness: 0.08, roughness: 1.0, clearcoat: 0.9, clearcoatRoughness: 0.08, envMapIntensity: 0.9,
    sheen: 0.0, specularIntensity: 0.8,
  });
  const metal = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, map, roughnessMap, bumpMap, bumpScale: 1.6,
    metalness: 0.88, roughness: 1.15, envMapIntensity: 1.3,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x0b1820, metalness: 0.0, roughness: 0.05, clearcoat: 1.0, clearcoatRoughness: 0.03,
    envMapIntensity: 2.4, specularIntensity: 1.0, ior: 1.5,
  });
  // canopy: tinted, semi-transparent so the pilot reads through it; strong clear-coat reflections
  const canopy = new THREE.MeshPhysicalMaterial({
    color: 0x16303c, metalness: 0.0, roughness: 0.04, clearcoat: 1.0, clearcoatRoughness: 0.02,
    envMapIntensity: 2.6, transparent: true, opacity: 0.34, depthWrite: false, side: THREE.FrontSide,
  });
  // hot nozzle interiors: vertex-colour gradient × per-vehicle intensity (color)
  const hot = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, fog: false, side: THREE.DoubleSide });
  const glows = new Map();
  const glow = (hex, k = 1) => {
    const key = hex + ':' + k;
    if (!glows.has(key)) glows.set(key, new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), fog: false }));
    return glows.get(key);
  };
  _cache = { engine, paint, metal, glass, canopy, glow, hot, textures: [map, roughnessMap, bumpMap] };
  return _cache;
}
