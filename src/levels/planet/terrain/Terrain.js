// STUB terrain (placeholder) — replaced by the terrain sub-project with a
// cube-sphere quadtree LOD that streams chunks from workers.
import * as THREE from 'three';

export default class Terrain {
  static order = 30;
  constructor(level) { this.level = level; }
  async init() {
    const w = this.level.world;
    const geo = new THREE.IcosahedronGeometry(1, 80);
    const pos = geo.attributes.position, v = new THREE.Vector3();
    const colors = new Float32Array(pos.count * 3);
    const P = w.palette, c = new THREE.Color(), lo = new THREE.Color(P?.ground?.[0] || '#6a8a4a'), hi = new THREE.Color(P?.rock || '#888'), sand = new THREE.Color(P?.sand || '#cbb');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).normalize();
      const h = w.heightAt(v);
      pos.setXYZ(i, ...v.multiplyScalar(w.radius + h).toArray());
      const t = THREE.MathUtils.clamp(h / (w.terrainParams.relief * 0.8), 0, 1);
      c.copy(lo).lerp(hi, t);
      if (w.hasOcean && h < w.seaLevel + 15) c.copy(sand);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    this.mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    this.mesh.receiveShadow = true;
    this.level.scene.add(this.mesh);
  }
  update() {}
  dispose() { this.mesh?.geometry.dispose(); this.mesh?.material.dispose(); }
}
