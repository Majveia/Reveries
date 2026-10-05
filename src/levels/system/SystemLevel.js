// STUB system level (placeholder) — replaced by the star-system sub-project.
import * as THREE from 'three';
import { OrbitRig } from '../../core/OrbitRig.js';
import { orbitPosition } from '../../universe/Astro.js';

export default class SystemLevel {
  constructor(engine, addr) { this.engine = engine; this.addr = addr; }
  async load() {
    const sys = this.engine.universe.system(this.addr.g ?? 0, this.addr.s ?? 0);
    this.sys = sys;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.01, 5000);
    const star = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(...sys.star.color).multiplyScalar(6) }));
    this.scene.add(star);
    this.scene.add(new THREE.PointLight(0xffffff, 3, 0, 0));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.05));
    this.planets = sys.planets.map((p) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.15 + Math.min(0.6, p.radiusEarth * 0.06), 32, 16), new THREE.MeshStandardMaterial({ color: new THREE.Color(p.palette?.ground?.[0] || '#c8b89a'), roughness: 0.8 }));
      m.userData.planet = p; this.scene.add(m); return m;
    });
    this.rig = new OrbitRig(this.camera, { distance: 40, minDistance: 2, maxDistance: 400, pitch: 0.5 });
    this.raycaster = new THREE.Raycaster();
  }
  enter() { this.engine.input.setMode('orbit'); this.engine.ui.setMode('map'); this.engine.ui.hint('Click a planet to land', 5000); }
  update(dt, t) {
    const tmp = [0, 0, 0];
    this.planets.forEach((m, i) => { const p = m.userData.planet; orbitPosition({ ...p.orbit, a: 4 + i * 3.2, period: 20 + i * 12 }, t, tmp); m.position.set(...tmp); });
    this.rig.update(dt, this.engine.input);
    const c = this.engine.input.click;
    if (c) {
      this.raycaster.setFromCamera({ x: c.ndcX, y: c.ndcY }, this.camera);
      const hit = this.raycaster.intersectObjects(this.planets)[0];
      if (hit) this.engine.go('planet', { ...this.addr, p: hit.object.userData.planet.index });
    }
    if (this.engine.input.pressed('escape') || this.engine.input.pressed('map')) this.engine.up();
  }
  onResize(w, h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
  dispose() {}
}
