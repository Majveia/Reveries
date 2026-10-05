// STUB galaxy level (placeholder) — replaced by the galaxy sub-project.
import * as THREE from 'three';
import { OrbitRig } from '../../core/OrbitRig.js';
import { Random } from '../../core/Random.js';

export default class GalaxyLevel {
  constructor(engine, addr) { this.engine = engine; this.addr = addr; }
  async load() {
    const U = this.engine.universe, g = U.galaxy(this.addr.g ?? 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.01, 1000);
    const n = 80000, pos = new Float32Array(n * 3), rng = new Random(g.seed);
    for (let i = 0; i < n; i++) { const p = U.galaxySample(g, rng); pos.set([p.x, p.y, p.z], i * 3); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.05, color: 0xffeedd, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.scene.add(this.points);
    this.rig = new OrbitRig(this.camera, { distance: g.radiusKpc * 2.4, minDistance: 0.5, maxDistance: 100, pitch: 0.8 });
  }
  enter() { this.engine.input.setMode('orbit'); this.engine.ui.setMode('map'); this.engine.ui.hint('Click to visit a star system', 5000); }
  update(dt) {
    this.rig.update(dt, this.engine.input);
    if (this.engine.input.click) this.engine.go('system', { g: this.addr.g ?? 0, s: 0 });
    if (this.engine.input.pressed('escape') || this.engine.input.pressed('map')) this.engine.up();
  }
  onResize(w, h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
  dispose() { this.points.geometry.dispose(); this.points.material.dispose(); }
}
