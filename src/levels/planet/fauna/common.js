// Fauna shared helpers: GPU-rigged materials, geometry primitives, tangent frames.
//
// Every creature is an InstancedMesh whose vertices carry a small "rig"
// (attribute aRig) and whose instances carry an animation state (attribute
// aAnim). A GLSL function `rig(inout vec3 p, inout vec3 n)` injected into a
// patched MeshStandardMaterial poses each vertex on the GPU (walk cycles, wing
// flaps, swimming undulation) so creatures receive the same sun, sky IBL and
// shadows as the terrain and cost no CPU skinning.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const TAU = Math.PI * 2;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const lerp = (a, b, t) => a + (b - a) * t;

const GLSL_COMMON = /* glsl */ `
attribute vec4 aRig;
attribute vec4 aAnim;
attribute float aGlow;
uniform float uFTime;
uniform vec3 uGlowColor;
varying float vGlow;
vec2 fa_rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
`;

/**
 * Patch a MeshStandardMaterial (and build its matching depth material) with a
 * rig function body. `rigGLSL` must define `void rig(inout vec3 p, inout vec3 n)`.
 * Extra uniforms are shared by reference.
 */
export function rigMaterial(params, rigGLSL, uniforms, key) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, ...params });
  const head = GLSL_COMMON + (uniforms.__decl || '') + rigGLSL;
  const U = { ...uniforms }; delete U.__decl;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + head)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(normal);\nvec3 faPos = position;\nrig(faPos, objectNormal);\nvGlow = aGlow;')
      .replace('#include <begin_vertex>', 'vec3 transformed = faPos;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uGlowColor;\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uGlowColor * vGlow;');
  };
  mat.customProgramCacheKey = () => 'fauna-' + key;
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + head)
      .replace('#include <begin_vertex>', 'vec3 transformed = position; vec3 faN = vec3(0.0, 1.0, 0.0); rig(transformed, faN); vGlow = aGlow;');
  };
  depth.customProgramCacheKey = () => 'fauna-depth-' + key;
  return { mat, depth };
}

// ---------------------------------------------------------------------------------
// Geometry building. Each piece is a non-indexed-or-indexed BufferGeometry with
// position, normal, color, aRig, aGlow; merge them with `mergeParts`.
// ---------------------------------------------------------------------------------

/** Assign constant/functional attributes to a geometry: color fn(p,n)->[r,g,b], rig fn(p)->[x,y,z,w], glow fn(p)->f. */
export function paint(geo, colorFn, rigFn, glowFn) {
  const pos = geo.attributes.position, nor = geo.attributes.normal, n = pos.count;
  const col = new Float32Array(n * 3), rig = new Float32Array(n * 4), glow = new Float32Array(n);
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i); q.fromBufferAttribute(nor, i);
    const c = colorFn(p, q); col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    const r = rigFn ? rigFn(p, q) : [0, 0, 0, 0]; rig[i * 4] = r[0]; rig[i * 4 + 1] = r[1]; rig[i * 4 + 2] = r[2]; rig[i * 4 + 3] = r[3];
    glow[i] = glowFn ? glowFn(p, q) : 0;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aRig', new THREE.BufferAttribute(rig, 4));
  geo.setAttribute('aGlow', new THREE.BufferAttribute(glow, 1));
  return geo;
}

export function mergeParts(parts) {
  const norm = parts.map((g) => {
    const x = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(x.attributes)) if (!['position', 'normal', 'color', 'aRig', 'aGlow'].includes(k)) x.deleteAttribute(k);
    return x;
  });
  const m = mergeGeometries(norm, false);
  for (const g of parts) g.dispose();
  return m;
}

/**
 * Ellipsoid-ish blob: a sphere scaled by (rx, ry, rz) with an optional profile
 * function along z (t in -1..1) multiplying the cross-section.
 */
export function blob(rx, ry, rz, profile = null, ws = 16, hs = 12) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  g.rotateX(Math.PI / 2); // poles on ±z
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i); const z = pos.getZ(i);
    const k = profile ? profile(z, x, y) : 1;
    x *= k; y *= k;
    pos.setXYZ(i, x * rx, y * ry, z * rz);
  }
  g.computeVertexNormals();
  return g;
}

/** Tapered tube between points a and b (radii ra, rb), with rounded ends. */
export function limb(a, b, ra, rb, seg = 8, rings = 4) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(rb, ra, len, seg, rings, false);
  g.translate(0, len / 2, 0);
  // round the ends a little
  const cap1 = new THREE.SphereGeometry(ra, seg, 4, 0, TAU, Math.PI / 2, Math.PI / 2);
  const cap2 = new THREE.SphereGeometry(rb, seg, 4, 0, TAU, 0, Math.PI / 2); cap2.translate(0, len, 0);
  const m = mergeGeometries([g.toNonIndexed(), cap1.toNonIndexed(), cap2.toNonIndexed()].map((x) => { x.deleteAttribute('uv'); return x; }));
  g.dispose(); cap1.dispose(); cap2.dispose();
  const dir = b.clone().sub(a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  m.applyQuaternion(q); m.translate(a.x, a.y, a.z);
  return m;
}

/** A flat (slightly cambered) membrane polygon in the XZ plane from an outline [[x,z],...] (fan from first point). */
export function membrane(outline, thickness = 0.01) {
  const verts = [];
  const c = outline.reduce((s, p) => [s[0] + p[0] / outline.length, s[1] + p[1] / outline.length], [0, 0]);
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    verts.push(c[0], thickness, c[1], a[0], 0, a[1], b[0], 0, b[1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.computeVertexNormals();
  // force normals to point up (double-sided material lights both faces)
  const n = g.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g;
}

export function hexColor(h) { return new THREE.Color(h); }
export function mixColor(a, b, t) { return [lerp(a.r, b.r, t), lerp(a.g, b.g, t), lerp(a.b, b.b, t)]; }

/** Cheap deterministic hash noise in JS (for vertex color patterns). */
export function hnoise(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}
export function vnoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  let r = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
    r += hnoise(ix + dx, iy + dy, iz + dz) * (dx ? ux : 1 - ux) * (dy ? uy : 1 - uy) * (dz ? uz : 1 - uz);
  }
  return r;
}

/** Tangent basis at a unit direction. */
export function tangentBasis(dir, t1 = new THREE.Vector3(), t2 = new THREE.Vector3()) {
  t1.set(0, 1, 0); if (Math.abs(dir.y) > 0.9) t1.set(1, 0, 0);
  t1.cross(dir).normalize(); t2.copy(dir).cross(t1).normalize();
  return [t1, t2];
}

const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
/**
 * Write a TRS matrix (forward = +Z, up = +Y) into an InstancedMesh array at index i,
 * position relative to anchor.
 */
export function writeInstance(arr, i, pos, anchor, fwd, up, s) {
  _y.copy(up).normalize();
  _z.copy(fwd).addScaledVector(_y, -fwd.dot(_y));
  if (_z.lengthSq() < 1e-8) _z.set(1, 0, 0).addScaledVector(_y, -_y.x);
  _z.normalize();
  _x.copy(_y).cross(_z);
  const o = i * 16;
  arr[o] = _x.x * s; arr[o + 1] = _x.y * s; arr[o + 2] = _x.z * s; arr[o + 3] = 0;
  arr[o + 4] = _y.x * s; arr[o + 5] = _y.y * s; arr[o + 6] = _y.z * s; arr[o + 7] = 0;
  arr[o + 8] = _z.x * s; arr[o + 9] = _z.y * s; arr[o + 10] = _z.z * s; arr[o + 11] = 0;
  arr[o + 12] = pos.x - anchor.x; arr[o + 13] = pos.y - anchor.y; arr[o + 14] = pos.z - anchor.z; arr[o + 15] = 1;
}
void _m;

/** Create an InstancedMesh with an aAnim instanced attribute. */
export function makeInstanced(geo, mats, max, { shadow = true } = {}) {
  const anim = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
  anim.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aAnim', anim);
  const mesh = new THREE.InstancedMesh(geo, mats.mat, max);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.customDepthMaterial = mats.depth;
  mesh.castShadow = shadow; mesh.receiveShadow = shadow;
  mesh.frustumCulled = false;
  mesh.count = 0;
  return { mesh, anim };
}
