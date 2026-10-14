// CellLayer — streams deterministic scatter cells in rings around a focus.
//
// Each layer has a cell size, a radius and a tier function (distance → detail
// tier; lower = finer, -1 = not needed). Cells are built through `build(cell,
// tier)` on a per-frame time budget (nearest first), cached in a small LRU when
// they leave the ring, and `dirty` is raised whenever the active set or a
// cell's data changes so the owner can repack its instance buffers.
import * as THREE from 'three';
import { gridN, cellsAround, cellKey } from './scatter.js';

const _d = new THREE.Vector3();

export class CellLayer {
  /**
   * o = { R, cellSize, radius, moveThresh, cacheMax, tierOf(dmin), covers(cell, tier), build(cell, tier) }
   */
  constructor(o) {
    Object.assign(this, { moveThresh: 4, cacheMax: 400 }, o);
    this.N = gridN(o.R, o.cellSize);
    this.cellM = (Math.PI * 0.5 * o.R) / this.N;
    this.active = new Map();
    this.cache = new Map();
    this.queue = [];
    this.lastFocus = new THREE.Vector3(1e12, 0, 0);
    this.dirty = false;
    this.pending = 0;
  }

  reset() { this.active.clear(); this.cache.clear(); this.queue.length = 0; this.lastFocus.set(1e12, 0, 0); this.dirty = true; }

  _cachePut(k, c) {
    if (!c.data) return;
    this.cache.set(k, c);
    if (this.cache.size > this.cacheMax) { const first = this.cache.keys().next().value; this.cache.delete(first); }
  }

  /** Re-evaluate the ring (if the focus moved) and build queued cells within budgetMs. */
  update(focus, budgetMs = 3, force = false) {
    if (force || focus.distanceToSquared(this.lastFocus) > this.moveThresh * this.moveThresh) {
      this.lastFocus.copy(focus);
      _d.copy(focus).normalize();
      const want = new Map();
      const half = this.cellM * 0.72;
      cellsAround(_d.x, _d.y, _d.z, this.R, this.N, this.radius, (f, i, j, dist) => {
        const tier = this.tierOf(Math.max(0, dist - half), dist);
        if (tier < 0) return;
        want.set(cellKey(f, i, j, this.N), { f, i, j, dist, tier });
      });
      for (const [k, c] of this.active) if (!want.has(k)) { this.active.delete(k); this._cachePut(k, c); this.dirty = true; }
      this.queue.length = 0;
      for (const [k, w] of want) {
        let c = this.active.get(k);
        if (!c) { c = this.cache.get(k); if (c) { this.cache.delete(k); this.active.set(k, c); this.dirty = true; } }
        if (c) {
          c.dist = w.dist;
          if (c.tier !== w.tier) {
            if (c.data && this.covers(c, w.tier)) { c.tier = w.tier; this.dirty = true; }
            else { c.wantTier = w.tier; this.queue.push(c); }
          }
        } else {
          c = { key: k, face: w.f, i: w.i, j: w.j, N: this.N, dist: w.dist, tier: -1, wantTier: w.tier, data: null };
          this.active.set(k, c); this.queue.push(c);
        }
      }
      this.queue.sort((a, b) => a.dist - b.dist);
    }
    const t0 = performance.now();
    let n = 0;
    while (this.queue.length) {
      if (n > 0 && performance.now() - t0 > budgetMs) break;
      const c = this.queue.shift();
      if (this.active.get(c.key) !== c) continue;
      this.build(c, c.wantTier);
      c.tier = c.wantTier; this.dirty = true; n++;
    }
    this.pending = this.queue.length;
    return this.dirty;
  }
}
