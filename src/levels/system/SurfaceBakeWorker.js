// Bakes a planet's real surface (the same TerrainHeight the planet level walks
// on) into small equirectangular maps, so the world you see from the orrery is
// the world you land on: same continents, seas, deserts and ice caps.
//   in : { id, params, W, H, pal: {name: [r,g,b] sRGB 0..1}, kind }
//   out: { id, albedo: Uint8Array RGBA (sRGB), data: Uint8Array RGBA (h, snow, cityPotential, roughness) }
import { createTerrain } from '../planet/terrain/TerrainHeight.js';

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const cl = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

self.onmessage = (e) => {
  const { id, params, W, H, pal, kind } = e.data;
  try {
    const T = createTerrain(params);
    T.setLod?.(params.radius * 2 * Math.PI / W);
    const rel = params.relief || 1500;
    const albedo = new Uint8Array(W * H * 4), data = new Uint8Array(W * H * 4);
    const ocean = T.seaLevel === 0;
    for (let j = 0; j < H; j++) {
      const lat = ((j + 0.5) / H - 0.5) * Math.PI;
      const cy = Math.sin(lat), cr = Math.cos(lat);
      for (let i = 0; i < W; i++) {
        const lon = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
        const x = cr * Math.cos(lon), z = cr * Math.sin(lon);
        const s = T.evaluate(x, cy, z, true);
        const h = s.h;
        const m = cl(s.moisture), tmp = cl(s.temp);
        let c;
        switch (s.biome) {
          case 1: c = mix(mix(pal.g0, pal.f1, 0.55), pal.g3, (1 - m) * 0.5); break;
          case 2: c = mix(pal.f0, pal.f2, m * 0.6).map((v) => v * 0.78); break;
          case 3: c = mix(pal.g1, pal.sand, 0.35); break;
          case 4: c = [0.86, 0.9, 0.95]; break;
          case 5: c = mix(pal.sand, pal.g3, 0.25 * (1 - tmp)); break;
          case 6: c = mix(pal.rock, pal.g2, 0.25); break;
          case 7: c = mix(pal.f2, pal.water, 0.3).map((v) => v * 0.8); break;
          case 8: c = mix(pal.rock, [0.1, 0.09, 0.09], 0.65); break;
          default: c = ocean ? mix(pal.sand, pal.rock, 0.5) : mix(pal.g2, pal.rock, 0.4);
        }
        if (kind === 'desert') c = mix(c, mix(pal.sand, pal.g1, cl(0.5 + (h / rel) * 0.8)), 0.55);
        if (kind === 'ice' && s.biome !== 4) c = mix(c, [0.7, 0.76, 0.82], 0.35);
        // rock showing on cliffs, sand on shores
        c = mix(c, pal.rock, cl(s.rock) * 0.4 * (s.biome === 8 ? 0 : 1));
        if (s.river > 0.5 && ocean) c = mix(c, pal.water, 0.5);
        const o = (j * W + i) * 4;
        albedo[o] = Math.round(cl(c[0]) * 255); albedo[o + 1] = Math.round(cl(c[1]) * 255); albedo[o + 2] = Math.round(cl(c[2]) * 255); albedo[o + 3] = 255;
        data[o] = Math.round(cl(0.5 + h / (rel * 2.8)) * 255);
        data[o + 1] = Math.round(cl(s.biome === 4 ? 1 : s.snow) * 255);
        const habitable = (s.biome === 1 || s.biome === 3 || s.biome === 5 || s.biome === 7 || s.biome === 2) && h > 0 ? 1 : 0;
        data[o + 2] = Math.round(habitable * cl(1 - Math.abs(h / rel) * 0.8) * cl(1 - s.snow) * 255);
        data[o + 3] = Math.round(cl(0.4 + s.rock * 0.5) * 255);
      }
    }
    // soften texel-scale biome classification steps (separable blur, wraps in longitude)
    blur(albedo, W, H, 2); blur(data, W, H, 1);
    self.postMessage({ id, albedo, data }, [albedo.buffer, data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack || err) });
  }
};

function blur(a, W, H, passes) {
  const tmp = new Uint8Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const o = (j * W + i) * 4, l = (j * W + (i + W - 1) % W) * 4, r = (j * W + (i + 1) % W) * 4;
      for (let c = 0; c < 4; c++) tmp[o + c] = (a[l + c] + 2 * a[o + c] + a[r + c] + 2) >> 2;
    }
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const o = (j * W + i) * 4, u = (Math.max(0, j - 1) * W + i) * 4, d = (Math.min(H - 1, j + 1) * W + i) * 4;
      for (let c = 0; c < 4; c++) a[o + c] = (tmp[u + c] + 2 * tmp[o + c] + tmp[d + c] + 2) >> 2;
    }
  }
}
