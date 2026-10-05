// STUB sky (placeholder): starfield + sun disc. Replaced by the atmosphere sub-project.
import * as THREE from 'three';

export default class Sky {
  static order = 80;
  constructor(level) { this.level = level; }
  async init() {
    const n = 6000, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const z = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, r = Math.sqrt(1 - z * z);
      pos.set([r * Math.cos(t) * 1e6, z * 1e6, r * Math.sin(t) * 1e6], i * 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.5, sizeAttenuation: false, color: 0xffffff, depthWrite: false }));
    this.stars.renderOrder = -10; this.stars.frustumCulled = false;
    this.level.scene.add(this.stars);
  }
  update() { this.stars.position.copy(this.level.camera.position); }
  dispose() {}
}
