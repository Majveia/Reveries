// STUB ocean (placeholder) — replaced by the ocean sub-project.
import * as THREE from 'three';

export default class Ocean {
  static order = 40;
  constructor(level) { this.level = level; }
  async init() {
    const w = this.level.world;
    if (!w.hasOcean) return;
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(w.radius + w.seaLevel, 128, 64),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(w.palette?.water || '#2a6a8a'), roughness: 0.15, metalness: 0.0, transparent: true, opacity: 0.85 }));
    this.level.scene.add(this.mesh);
  }
  update() {}
  dispose() {}
}
