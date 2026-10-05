// Planet height field — the single source of truth for terrain shape.
// PURE + WORKER-SAFE: imported by the main thread (physics, placement) AND by
// terrain workers (mesh generation). Both must produce identical numbers.
//
//   const params = terrainParams(planet)          // plain JSON, postMessage-able
//   const T = createTerrain(params)
//   T.height(x, y, z)  → meters above base radius for unit direction (x,y,z)
//   T.sample(x, y, z)  → { h, moisture, temp, rock, biome }
//
// Owned by the terrain sub-project (they will make this far richer).

import { SimplexNoise, clamp, smoothstep } from '../../../core/Noise.js';

export function terrainParams(planet) {
  const A = planet.terrainStyle || null;
  return {
    seed: planet.seed >>> 0,
    radius: planet.world.radius,
    relief: planet.world.relief,
    oceanFraction: planet.world.seaLevel,
    style: planet.styleTerrain || 'rolling',
    kind: planet.kind,
    aesthetic: planet.aesthetic,
    tempK: planet.tempK,
    ...(A || {}),
  };
}

export function createTerrain(p) {
  const n1 = new SimplexNoise(p.seed);
  const n2 = new SimplexNoise(p.seed ^ 0x5bd1e995);
  const n3 = new SimplexNoise(p.seed ^ 0x1b873593);
  const R = p.radius, relief = p.relief;

  function height(x, y, z) {
    // continents
    const cs = 1.6;
    let c = n1.fbm3(x * cs, y * cs, z * cs, 5);
    c = c * 0.9 + 0.08;
    // mountains: ridged, masked by continents
    const ms = 5.5;
    const m = n2.ridged3(x * ms + 3.1, y * ms, z * ms, 6);
    const mountainMask = smoothstep(0.05, 0.45, c);
    // hills
    const hs = 22;
    const hl = n3.fbm3(x * hs, y * hs, z * hs, 4);
    // detail (meters-scale)
    const ds = 180;
    const d = n1.fbm3(x * ds, y * ds, z * ds, 3);
    let h = c * relief * 0.55 + Math.pow(m, 2.2) * relief * 1.1 * mountainMask + hl * relief * 0.06 + d * 6;
    return h;
  }

  function sample(x, y, z) {
    const h = height(x, y, z);
    const moisture = clamp(0.5 + 0.5 * n3.fbm3(x * 3 + 7, y * 3, z * 3, 3));
    const lat = Math.abs(y);
    const temp = clamp(1 - lat * 0.9 - Math.max(0, h) / (relief * 1.6));
    const rock = clamp(h / relief - 0.45);
    let biome = 0;
    if (h < 0) biome = 0; // seabed
    else if (temp < 0.18) biome = 4; // snow
    else if (moisture < 0.35) biome = 3; // arid
    else if (moisture > 0.62) biome = 2; // forest
    else biome = 1; // grassland
    return { h, moisture, temp, rock, biome };
  }

  return { params: p, height, sample, radius: R };
}
