// Halo finder on the coarse PM density grid: periodic local maxima of the
// mass field, masses from the 3³ neighbourhood (≈ the virialised region at this
// resolution), mass-weighted centroids. Deterministic ordering by mass gives
// the catalogue ids (most massive = 0 = the home galaxy's host).

/**
 * @param {Float32Array} grid  H³ coarse density (sum of mean-normalised fine cells)
 * @param {number} H           coarse grid size
 * @param {number} L           box size (Mpc/h)
 * @param {number} unitMass    M☉/h per grid unit
 * @param {number} max         max halos returned
 */
export function findHalos(grid, H, L, unitMass, max = 160) {
  const idx = (x, y, z) => ((((z + H) % H) * H + ((y + H) % H)) * H + ((x + H) % H));
  const mean = 8; // coarse cell = 2³ fine cells of mean 1
  const thr = mean * 5;
  const out = [];
  const cell = L / H;
  for (let z = 0; z < H; z++) for (let y = 0; y < H; y++) for (let x = 0; x < H; x++) {
    const v = grid[(z * H + y) * H + x];
    if (v < thr) continue;
    let peak = true, mass = 0, cx = 0, cy = 0, cz = 0;
    for (let dz = -1; dz <= 1 && peak; dz++) for (let dy = -1; dy <= 1 && peak; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy && !dz) continue;
      const w = grid[idx(x + dx, y + dy, z + dz)];
      if (w > v || (w === v && (dz * H + dy) * H + dx < 0)) { peak = false; break; }
    }
    if (!peak) continue;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const w = grid[idx(x + dx, y + dy, z + dz)];
      mass += w; cx += w * dx; cy += w * dy; cz += w * dz;
    }
    const px = (x + 0.5 + cx / mass) * cell, py = (y + 0.5 + cy / mass) * cell, pz = (z + 0.5 + cz / mass) * cell;
    out.push({ x: ((px % L) + L) % L, y: ((py % L) + L) % L, z: ((pz % L) + L) % L, mass: mass * unitMass, peak: v / mean });
  }
  out.sort((a, b) => b.mass - a.mass);
  return out.slice(0, max);
}

/** Periodic distance². */
export function pdist2(a, b, L) {
  let dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y), dz = Math.abs(a.z - b.z);
  dx = Math.min(dx, L - dx); dy = Math.min(dy, L - dy); dz = Math.min(dz, L - dz);
  return dx * dx + dy * dy + dz * dz;
}

/** Give each halo a stable id from a reference catalogue (nearest within r). */
export function assignIds(halos, ref, L, r = 6) {
  const used = new Set();
  let extra = 0;
  for (const h of halos) {
    let best = -1, bd = r * r;
    for (let i = 0; i < ref.length; i++) {
      if (used.has(i)) continue;
      const d = pdist2(h, ref[i], L);
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) { used.add(best); h.id = ref[best].id; } else h.id = 4096 + extra++;
  }
  return halos;
}

/** "2.3 × 10¹⁴" */
export function sci(v, digits = 1) {
  if (!(v > 0)) return '0';
  const e = Math.floor(Math.log10(v));
  const m = v / 10 ** e;
  const sup = String(e).split('').map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+c] ?? c).join('');
  return `${m.toFixed(digits)} × 10${sup}`;
}
