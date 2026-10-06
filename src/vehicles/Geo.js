// Geometry kit for procedural hard-surface vehicles.
//
// Every part is built as an ordinary BufferGeometry, then `finish()`ed into a
// common attribute layout (non-indexed position/normal/uv/color) so whole
// vehicles merge into one draw call per material:
//   loft(sections)        superellipse cross-sections lofted along +Z (hulls, pods)
//   lathe(profile)        revolved profile around +Z (nozzles, intakes, rings)
//   plate(planform, t)    bevelled extruded planform in the XZ plane (wings, fins)
//   box(...) / cyl(...)   greebles, struts
//   finish(geo, colorFn)  box-projected UVs (panel texture density is uniform in
//                         meters on every part) + per-vertex paint
//   merge(list)
//
// Vehicle convention (matches the player): +Z forward, +Y up, +X left.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const _c = new THREE.Color();

function se(t, n) {
  const c = Math.cos(t), s = Math.sin(t);
  return [Math.sign(c) * Math.pow(Math.abs(c), 2 / n), Math.sign(s) * Math.pow(Math.abs(s), 2 / n)];
}

/**
 * Loft superellipse rings. section = { z, w, h, x?, y?, n?, top?, bot? }
 * (w/h half extents, n superellipse exponent, top/bot scale the upper/lower half).
 */
export function loft(sections, { seg = 28, caps = true } = {}) {
  const pos = [], idx = [], uvm = [];
  const R = sections.length, S1 = seg + 1;
  for (let i = 0; i < R; i++) {
    const S = sections[i];
    let arc = 0, px = 0, py = 0;
    // start the seam at the keel (t = -π/2) so it hides under the belly
    for (let j = 0; j <= seg; j++) {
      const t = (j / seg) * Math.PI * 2 - Math.PI / 2;
      const [c, s] = se(t, S.n ?? 2.5);
      const hh = s > 0 ? S.h * (S.top ?? 1) : S.h * (S.bot ?? 1);
      const x = (S.x || 0) + c * S.w, y = (S.y || 0) + s * hh;
      if (j) arc += Math.hypot(x - px, y - py);
      px = x; py = y;
      pos.push(x, y, S.z);
      uvm.push(arc, S.z);
    }
  }
  for (let i = 0; i < R - 1; i++) for (let j = 0; j < seg; j++) {
    const a = i * S1 + j, b = a + S1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uvm', new THREE.Float32BufferAttribute(uvm, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // weld the seam normals (j = 0 and j = seg share a position)
  const n = g.attributes.normal;
  for (let i = 0; i < R; i++) {
    const a = i * S1, b = a + seg;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(b, x / l, y / l, z / l);
  }
  const parts = [g.toNonIndexed()];
  if (caps) {
    for (const end of [0, R - 1]) {
      const S = sections[end];
      const cp = [], dir = end === 0 ? -1 : 1;
      const cx = S.x || 0, cy = S.y || 0;
      for (let j = 0; j < seg; j++) {
        const a = end * S1 + j, b = a + 1;
        const ax = pos[a * 3], ay = pos[a * 3 + 1], bx = pos[b * 3], by = pos[b * 3 + 1];
        if (dir > 0) cp.push(cx, cy, S.z, ax, ay, S.z, bx, by, S.z);
        else cp.push(cx, cy, S.z, bx, by, S.z, ax, ay, S.z);
      }
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
      cg.setAttribute('uvm', new THREE.Float32BufferAttribute(cp.filter((_, i) => i % 3 !== 2), 2));
      cg.computeVertexNormals();
      parts.push(cg);
    }
  }
  return parts.length > 1 ? mergeGeometries(parts.map(strip)) : parts[0];
}

/** Revolve a profile [[r, z], …] around +Z. */
export function lathe(profile, seg = 28) {
  const pts = profile.map(([r, z]) => new THREE.Vector2(Math.max(r, 1e-4), z));
  const g = new THREE.LatheGeometry(pts, seg);
  // LatheGeometry revolves around Y; turn Y into Z
  g.rotateX(Math.PI / 2);
  const uv = g.attributes.uv, p = g.attributes.position, m = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { const r = Math.hypot(p.getX(i), p.getY(i)); m[i * 2] = uv.getX(i) * Math.PI * 2 * Math.max(r, 0.05); m[i * 2 + 1] = p.getZ(i); }
  g.setAttribute('uvm', new THREE.BufferAttribute(m, 2));
  return g;
}

/**
 * Bevelled plate from a planform [[x, z], …] (counter-clockwise seen from +Y),
 * thickness t centred on y = 0.
 */
export function plate(planform, t, bevel = 0.04) {
  const sh = new THREE.Shape();
  planform.forEach(([x, z], i) => (i ? sh.lineTo(x, -z) : sh.moveTo(x, -z)));
  sh.closePath();
  const b = Math.min(bevel, t * 0.45);
  const g = new THREE.ExtrudeGeometry(sh, { depth: Math.max(0.001, t - 2 * b), bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 2, steps: 1, curveSegments: 4 });
  g.translate(0, 0, -(t - 2 * b) / 2);
  g.rotateX(-Math.PI / 2); // shape (x, -z) → (x, ·, z), extrusion along +Y
  return g;
}

export function box(w, h, d, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g;
}

/** Cylinder between two points. */
export function cyl(a, b, r0, r1 = r0, seg = 10) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const L = A.distanceTo(B);
  const g = new THREE.CylinderGeometry(r1, r0, L, seg, 1, false);
  g.translate(0, L / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  g.applyQuaternion(q); g.translate(A.x, A.y, A.z);
  return g;
}

function strip(g) {
  let n = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uvm') n.deleteAttribute(k);
  if (!n.attributes.normal) n.computeVertexNormals();
  return n;
}

/**
 * Normalize a part: non-indexed, box-projected UVs (uvScale per meter), vertex
 * colors from `paint` (hex, THREE.Color or fn(x,y,z,nx,ny,nz) → Color).
 */
export function finish(g, paint = 0xffffff, uvScale = 0.5, emissiveMask = 0, ao = 0.3) {
  g = strip(g);
  const p = g.attributes.position, nrm = g.attributes.normal, um = g.attributes.uvm;
  const N = p.count;
  const uv = new Float32Array(N * 2), col = new Float32Array(N * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), fn = new THREE.Vector3();
  const fixed = typeof paint === 'function' ? null : (paint?.isColor ? paint.clone() : new THREE.Color(paint));
  for (let i = 0; i < N; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    fn.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    const ax = Math.abs(fn.x), ay = Math.abs(fn.y), az = Math.abs(fn.z);
    for (let k = 0; k < 3; k++) {
      const v = i + k;
      const x = p.getX(v), y = p.getY(v), z = p.getZ(v);
      let u, w;
      if (um) { u = um.getX(v); w = um.getY(v); }
      else if (ax >= ay && ax >= az) { u = z; w = y; } else if (ay >= az) { u = x; w = z; } else { u = x; w = y; }
      uv[v * 2] = u * uvScale; uv[v * 2 + 1] = w * uvScale;
      const C = fixed || paint(x, y, z, nrm.getX(v), nrm.getY(v), nrm.getZ(v), _c);
      // baked sky occlusion: undersides and inward faces darker (cheap cavity AO)
      const occ = 1 - ao * (0.5 - 0.5 * nrm.getY(v));
      col[v * 3] = C.r * occ; col[v * 3 + 1] = C.g * occ; col[v * 3 + 2] = C.b * occ;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (um) g.deleteAttribute('uvm');
  return g;
}

export function merge(list) {
  const g = mergeGeometries(list.filter(Boolean));
  g.computeBoundingSphere();
  return g;
}

/** Mirror a geometry across X (left/right symmetric parts). */
export function mirrorX(g) {
  const m = g.clone();
  m.scale(-1, 1, 1);
  // flip winding
  const p = m.attributes.position, n = m.attributes.normal;
  if (!m.index) {
    for (let i = 0; i < p.count; i += 3) {
      for (const attr of Object.values(m.attributes)) {
        const s = attr.itemSize;
        for (let k = 0; k < s; k++) {
          const t = attr.array[(i + 1) * s + k]; attr.array[(i + 1) * s + k] = attr.array[(i + 2) * s + k]; attr.array[(i + 2) * s + k] = t;
        }
      }
    }
  } else {
    const ix = m.index.array;
    for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
  }
  if (n) n.needsUpdate = true;
  return m;
}

export const col = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);
