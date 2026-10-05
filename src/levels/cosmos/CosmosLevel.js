// STUB cosmos level (placeholder) — replaced by the cosmic-web sub-project
// (GPU particle-mesh N-body in an expanding ΛCDM universe).
import * as THREE from 'three';
import { OrbitRig } from '../../core/OrbitRig.js';

export default class CosmosLevel {
  constructor(engine, addr, opts) { this.engine = engine; this.opts = opts; }
  async load() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 5000);
    const n = 60000, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) pos.set([(Math.random() - .5) * 200, (Math.random() - .5) * 200, (Math.random() - .5) * 200], i * 3);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.6, color: 0x88aaff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.scene.add(this.points);
    this.rig = new OrbitRig(this.camera, { distance: 260, minDistance: 20, maxDistance: 800 });
    this.grade = { bloomStrength: 0.12 };
  }
  enter() { this.engine.input.setMode('orbit'); this.engine.ui.setMode('map'); this.engine.ui.hint('Click anywhere to enter a galaxy', 5000); }
  update(dt) {
    this.rig.update(dt, this.engine.input);
    if (this.engine.input.click) this.engine.go('galaxy', { g: 0 });
  }
  onResize(w, h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
  dispose() { this.points.geometry.dispose(); this.points.material.dispose(); }
}
