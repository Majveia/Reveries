// STUB terrain (placeholder) — replaced by the terrain sub-project with a
// cube-sphere quadtree LOD that streams chunks from workers.
//
// Until then: a coarse displaced icosphere for the whole planet plus an accurate
// high-resolution patch (≈5 km, 9 m spacing) around the first settlement, where
// every screenshot preset is staged — so other sub-projects can place things at
// world.heightAt() and see them sit on the ground.
import * as THREE from 'three';

export default class Terrain {
  static order = 30;
  constructor(level) { this.level = level; }

  _color(h, w, c, lo, hi, sand, snow) {
    const t = THREE.MathUtils.clamp(h / (w.terrainParams.relief * 0.8), 0, 1);
    c.copy(lo).lerp(hi, t * t);
    if (w.hasOcean && h < w.seaLevel + 6) c.copy(sand);
    if (h > w.terrainParams.relief * 0.85) c.lerp(snow, 0.7);
    return c;
  }

  async init() {
    const w = this.level.world;
    const P = w.palette;
    const lo = new THREE.Color(P?.ground?.[0] || '#6a8a4a'), hi = new THREE.Color(P?.rock || '#888'), sand = new THREE.Color(P?.sand || '#cbb'), snow = new THREE.Color('#f4f6fa');
    const c = new THREE.Color(), v = new THREE.Vector3();
    const center = (w.sites[0]?.dir || new THREE.Vector3(0.3, 0.5, 0.8)).clone().normalize();
    const PATCH = 2600; // half-size in meters
    const cutAngle = (PATCH * 0.92) / w.radius;

    // Global coarse sphere (faces inside the patch are removed to avoid overlap).
    const ico = new THREE.IcosahedronGeometry(1, 80);
    const pos = ico.attributes.position;
    const keep = [];
    const cols = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); d.fromBufferAttribute(pos, i + 2);
      const cen = v.copy(a).add(b).add(d).normalize();
      if (cen.angleTo(center) < cutAngle) continue;
      for (const p of [a, b, d]) {
        const dir = p.clone().normalize();
        const h = w.heightAt(dir);
        keep.push(...dir.multiplyScalar(w.radius + h).toArray());
        this._color(h, w, c, lo, hi, sand, snow);
        cols.push(c.r, c.g, c.b);
      }
    }
    const g1 = new THREE.BufferGeometry();
    g1.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
    g1.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    g1.computeVertexNormals();

    // High-res local patch.
    const N = this.level.engine.quality.pick(300, 420, 560, 560);
    const t1 = new THREE.Vector3(0, 1, 0).cross(center).normalize();
    if (t1.lengthSq() < 0.5) t1.set(1, 0, 0);
    const t2 = center.clone().cross(t1).normalize();
    const verts = new Float32Array((N + 1) * (N + 1) * 3), vcol = new Float32Array((N + 1) * (N + 1) * 3);
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const u = (i / N - 0.5) * 2 * PATCH, vv = (j / N - 0.5) * 2 * PATCH;
      const dir = v.copy(center).addScaledVector(t1, u / w.radius).addScaledVector(t2, vv / w.radius).normalize();
      const h = w.heightAt(dir);
      const k = (j * (N + 1) + i) * 3;
      const p = dir.clone().multiplyScalar(w.radius + h);
      verts[k] = p.x; verts[k + 1] = p.y; verts[k + 2] = p.z;
      this._color(h, w, c, lo, hi, sand, snow);
      vcol[k] = c.r; vcol[k + 1] = c.g; vcol[k + 2] = c.b;
    }
    const idx = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const q = j * (N + 1) + i;
      idx.push(q, q + N + 1, q + 1, q + 1, q + N + 1, q + N + 2);
    }
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g2.setAttribute('color', new THREE.BufferAttribute(vcol, 3));
    g2.setIndex(idx);
    g2.computeVertexNormals();
    // make winding face outward
    const n0 = new THREE.Vector3().fromBufferAttribute(g2.attributes.normal, (N >> 1) * (N + 1) + (N >> 1));
    if (n0.dot(center) < 0) { const ix = g2.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } g2.computeVertexNormals(); }

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide });
    this.coarse = new THREE.Mesh(g1, mat);
    this.patch = new THREE.Mesh(g2, mat);
    this.coarse.receiveShadow = true;
    this.patch.receiveShadow = true; this.patch.castShadow = true;
    this.level.scene.add(this.coarse, this.patch);
  }
  update() {}
  dispose() { for (const m of [this.coarse, this.patch]) { m?.geometry.dispose(); } this.coarse?.material.dispose(); }
}
