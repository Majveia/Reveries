// SiteFrame — a settlement's local tangent space, wrapped onto the sphere.
//
// Local axes: X = east, Y = up (radial at the site center), Z = south-ish
// (X × Y). A local plan coordinate (x, z) maps onto the planet by a gnomonic
// projection, so streets and buildings follow the curvature (≈14 m of drop
// 1 km out on a 36 km world). All civ meshes live in this space as children
// of `group` so float32 vertex positions stay small and precise.

import * as THREE from 'three';

const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();

export class SiteFrame {
  constructor(world, site) {
    this.world = world;
    this.site = site;
    this.R = world.radius;
    const up = site.dir.clone().normalize();
    const east = new THREE.Vector3(0, 1, 0).cross(up);
    if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
    east.normalize();
    const south = east.clone().cross(up).normalize();
    this.up = up; this.east = east; this.south = south;
    this.h0 = world.heightAt(up);
    this.origin = up.clone().multiplyScalar(this.R + this.h0);
    this.matrix = new THREE.Matrix4().makeBasis(east, up, south).setPosition(this.origin);
    this.inverse = this.matrix.clone().invert();
    this.quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, up, south));
    this.invQuat = this.quaternion.clone().invert();
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(this.matrix);
    this.group.matrixWorld.copy(this.matrix);
    this.sea = world.hasOcean ? world.seaLevel : -Infinity;
    this._hc = new Map();
  }

  /** Unit planet direction under local plan point (x, z). */
  dirAt(x, z, out = new THREE.Vector3()) {
    return out.copy(this.up).addScaledVector(this.east, x / this.R).addScaledVector(this.south, z / this.R).normalize();
  }

  /** Terrain height (m above base radius) at plan point; cached on a 0.5 m lattice. */
  hAt(x, z) {
    const kx = Math.round(x * 2), kz = Math.round(z * 2);
    const key = kx * 73856093 + kz * 19349663;
    let h = this._hc.get(key);
    if (h === undefined) {
      h = this.world.heightAt(this.dirAt(kx * 0.5, kz * 0.5, _d));
      if (this._hc.size > 400000) this._hc.clear();
      this._hc.set(key, h);
    }
    return h;
  }
  /** Exact (uncached) height. */
  hExact(x, z) { return this.world.heightAt(this.dirAt(x, z, _d)); }

  /** Is the plan point under water? */
  wet(x, z, margin = 0) { return this.hAt(x, z) < this.sea + margin; }

  /** Local-space point at plan (x, z) with height h above base radius. */
  point(x, z, h, out = new THREE.Vector3()) {
    this.dirAt(x, z, _d);
    return out.copy(_d).multiplyScalar(this.R + h).applyMatrix4(this.inverse);
  }
  /** Local-space radial up at plan (x, z). */
  upAt(x, z, out = new THREE.Vector3()) { return out.copy(this.dirAt(x, z, _d)).applyQuaternion(this.invQuat); }
  /** Ground point (local) at plan (x, z). */
  ground(x, z, out = new THREE.Vector3(), lift = 0) { return this.point(x, z, this.hAt(x, z) + lift, out); }

  /**
   * Matrix (local space) for an object standing at plan (x, z), base height h
   * (m above base radius), yaw angle (radians; 0 = front faces +Z/south).
   */
  placement(x, z, h, yaw = 0, out = new THREE.Matrix4(), scale = 1) {
    const up = this.upAt(x, z, _y);
    // forward on the tangent plane
    _z.set(Math.sin(yaw), 0, Math.cos(yaw));
    _z.addScaledVector(up, -_z.dot(up)).normalize();
    _x.copy(up).cross(_z).normalize();
    out.makeBasis(_x, up, _z);
    if (scale !== 1) out.scale(_p.set(scale, scale, scale));
    this.point(x, z, h, _p);
    out.setPosition(_p);
    return out;
  }

  /** Local → world position. */
  toWorld(v, out = new THREE.Vector3()) { return out.copy(v).applyMatrix4(this.matrix); }
  /** World → local position. */
  toLocal(v, out = new THREE.Vector3()) { return out.copy(v).applyMatrix4(this.inverse); }
  /** World-space quaternion for a local placement matrix. */
  worldQuat(localMatrix, out = new THREE.Quaternion()) {
    _m.multiplyMatrices(this.matrix, localMatrix);
    _m.decompose(_p, out, _x);
    return out;
  }

  /** Min / max / mean terrain height over an oriented rectangle footprint. */
  footprint(x, z, w, d, yaw, n = 3) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let mn = Infinity, mx = -Infinity, sum = 0, k = 0, wet = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const u = (i / (n - 1) - 0.5) * w, v = (j / (n - 1) - 0.5) * d;
      const px = x + u * c + v * s, pz = z - u * s + v * c;
      const h = this.hAt(px, pz);
      mn = Math.min(mn, h); mx = Math.max(mx, h); sum += h; k++;
      if (h < this.sea + 0.6) wet++;
    }
    return { min: mn, max: mx, mean: sum / k, wet: wet / k };
  }

  /** Sun direction expressed in local space. */
  sunLocal(sunDir, out = new THREE.Vector3()) { return out.copy(sunDir).applyQuaternion(this.invQuat); }
}

/** Rotate plan offset (u along the front, v toward the back) by yaw into plan (x, z). */
export function planRot(u, v, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [u * c + v * s, -u * s + v * c];
}
