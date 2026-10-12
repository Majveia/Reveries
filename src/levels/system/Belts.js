// Asteroid and Kuiper belts: thousands of instanced, procedurally deformed
// rocks on Keplerian orbits — inner rocks visibly overtake outer ones
// (differential rotation, computed on the GPU) — plus a faint dust torus that
// glows when you look toward the star through it.

import * as THREE from 'three';
import { Random, seedFrom } from '../../core/Random.js';
import { SimplexNoise } from '../../core/Noise.js';
import { NOISE_GLSL } from '../../core/glsl/noise.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function rockGeometry(seed, detail) {
  const src = new THREE.IcosahedronGeometry(1, detail);
  src.deleteAttribute('normal'); src.deleteAttribute('uv');
  const g = mergeVertices(src);
  src.dispose();
  const n = new SimplexNoise(seed);
  const rng = new Random(seed);
  const pos = g.getAttribute('position');
  const v = new THREE.Vector3();
  const sx = rng.range(0.55, 1.0), sy = rng.range(0.4, 0.85), sz = 1.0;
  // impact craters (power-law sizes) and fracture planes: rubble piles are faceted, not blobs
  const craters = [];
  const nc = 4 + detail * 3;
  for (let i = 0; i < nc; i++) { const [x, y, z] = rng.unitVector(); const rad = 0.12 + 0.5 * Math.pow(rng.float(), 2.2); craters.push([new THREE.Vector3(x, y, z), rad, rad * rng.range(0.25, 0.45)]); }
  const planes = [];
  const np = rng.int(1, 4);
  for (let i = 0; i < np; i++) { const [x, y, z] = rng.unitVector(); planes.push([new THREE.Vector3(x, y, z), rng.range(0.62, 0.86)]); }
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let r = 1 + 0.3 * n.fbm3(v.x * 1.2, v.y * 1.2, v.z * 1.2, 4) + 0.1 * n.ridged3(v.x * 3, v.y * 3, v.z * 3, 4) - 0.06;
    if (detail >= 3) r += 0.025 * n.ridged3(v.x * 9, v.y * 9, v.z * 9, 3) + 0.012 * n.fbm3(v.x * 22, v.y * 22, v.z * 22, 2);
    for (const [c, rad, depth] of craters) {
      const d = v.distanceTo(c) / rad;
      if (d < 1.3) r += d < 1 ? -depth * (1 - d * d) * 0.9 : depth * 0.5 * (1 - (d - 1) / 0.3);
    }
    // fracture faces: clamp the radius against a few planes (soft-min keeps edges crisp but not knife-sharp)
    for (const [pn, off] of planes) {
      const c = v.dot(pn);
      if (c > 0.05) { const lim = off / c; if (r > lim) r = lim + (r - lim) * 0.12; }
    }
    pos.setXYZ(i, v.x * r * sx, v.y * r * sy, v.z * r * sz);
  }
  g.computeVertexNormals();
  return g;
}

const ROCK_VERT = /* glsl */`
attribute vec4 aOrbit;   // r, theta0, y, omega (rad/day)
attribute vec4 aRock;    // scale, spin (rad/s), seed, tint
attribute vec3 aAxis;
uniform float uDays, uTime;
varying vec3 vWP; varying vec3 vN; varying vec3 vLP; varying float vSeed; varying float vTint; varying float vScale;
vec3 rotAxis(vec3 v, vec3 k, float a){ float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }
void main(){
  float th = aOrbit.y + aOrbit.w * uDays;
  vec3 c = vec3(cos(th) * aOrbit.x, aOrbit.z, sin(th) * aOrbit.x);
  float sa = aRock.y * uTime + aRock.z * 6.0;
  vec3 lp = rotAxis(position, aAxis, sa) * aRock.x;
  vN = rotAxis(normal, aAxis, sa);
  vLP = position; vSeed = aRock.z; vTint = aRock.w; vScale = aRock.x;
  vWP = c + lp;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWP, 1.0);
}`;

const ROCK_FRAG = /* glsl */`
${NOISE_GLSL}
uniform vec3 uCol; uniform vec3 uSun; uniform float uIce;
varying vec3 vWP; varying vec3 vN; varying vec3 vLP; varying float vSeed; varying float vTint; varying float vScale;
void main(){
  vec3 Ng = normalize(vN);
  vec3 lp = vLP + vSeed * 17.0;
  float h = fbm(lp * 2.6, 4);
  float spk = fbm(lp * 12.0, 3);
  // small craters and boulders resolved in the shader
  vec2 cr = worley(lp * 6.0);
  float crater = smoothstep(0.35, 0.05, cr.x) * -0.6 + smoothstep(0.3, 0.42, cr.x) * smoothstep(0.55, 0.42, cr.x) * 0.25;
  vec2 cr2 = worley(lp * 17.0 + 3.0);
  float crater2 = smoothstep(0.3, 0.05, cr2.x) * -0.5 + smoothstep(0.28, 0.4, cr2.x) * smoothstep(0.5, 0.4, cr2.x) * 0.2;
  float hb = (h * 0.9 + spk * 0.35 + crater * 0.35 + crater2 * 0.15) * vScale * 0.09;
  vec3 dpdx = dFdx(vWP), dpdy = dFdy(vWP);
  float dhdx = dFdx(hb), dhdy = dFdy(hb);
  vec3 r1 = cross(dpdy, Ng), r2 = cross(Ng, dpdx);
  float det = dot(dpdx, r1);
  vec3 N = normalize(abs(det) * Ng - sign(det) * (dhdx * r1 + dhdy * r2));
  if (dot(N, Ng) < 0.2) N = Ng;
  vec3 L = normalize(-vWP);
  vec3 V = normalize(cameraPosition - vWP);
  float ndlG = dot(Ng, L);
  // rough regolith: Oren-Nayar-ish flattening + a hard terminator (no air, no fill light)
  float ndl = max(dot(N, L), 0.0);
  ndl = mix(ndl, sqrt(ndl), 0.35) * smoothstep(-0.08, 0.12, ndlG);
  vec3 alb = uCol * (0.6 + 0.55 * vTint) * (0.72 + 0.4 * h + 0.16 * spk);
  // space weathering: mature reddish-brown regolith vs fresh grey-white ejecta around young craters
  float fresh = smoothstep(0.2, 0.0, cr.x) * 0.5 + smoothstep(0.12, 0.0, cr2.x) * 0.35;
  alb = mix(alb, alb * vec3(1.18, 0.95, 0.78), smoothstep(0.1, 0.6, fbm(lp * 1.5, 3)) * (1.0 - uIce));
  alb = mix(alb, vec3(dot(alb, vec3(0.33))) * 1.5, fresh * (1.0 - uIce * 0.5));
  // crater floors sit in shadow-dark material
  alb *= 1.0 - 0.25 * smoothstep(0.25, 0.0, cr.x);
  float opp = 1.0 + 0.5 * pow(max(dot(V, L), 0.0), 10.0);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 60.0) * (0.04 + 0.5 * uIce) * ndl;
  vec3 c = alb * uSun * (ndl * opp) + uSun * spec + alb * vec3(0.012, 0.014, 0.02) * (0.6 + 0.4 * max(dot(N, -L), 0.0));
  gl_FragColor = vec4(c, 1.0);
}`;

export class Belt {
  constructor(engine, belt, layout, starColor, rIn, rOut, seedKey) {
    const q = engine.quality;
    const rng = new Random(seedFrom(seedKey, 'belt', belt.kind));
    this.group = new THREE.Group();
    const kuiper = belt.kind === 'kuiper';
    const total = Math.round(q.scale(kuiper ? 1600 : 4200) * (engine.shotMode ? 1 : 1));
    const thick = (rOut - rIn) * (kuiper ? 0.22 : 0.055);
    this.rIn = rIn; this.rOut = rOut;
    // LOD by size class: the few big rocks get detailed meshes
    const classes = [
      { detail: 1, variants: 6, frac: 0.92, size: [0.012, 0.09] },
      { detail: q.level >= 2 ? 3 : 2, variants: 4, frac: 0.075, size: [0.09, 0.42] },
      // a handful of large worldlets with full detail
      { detail: q.level >= 2 ? 5 : 4, variants: 2, frac: 0.005, size: [0.42, 0.9] },
    ];
    const sun = starColor.clone().multiplyScalar(1.4);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uDays: { value: 0 }, uTime: { value: 0 }, uCol: { value: new THREE.Color().setRGB(belt.color[0], belt.color[1], belt.color[2], THREE.SRGBColorSpace).multiplyScalar(kuiper ? 0.9 : 0.62).lerp(new THREE.Color(0.3, 0.27, 0.24), kuiper ? 0 : 0.35) }, uSun: { value: sun }, uIce: { value: kuiper ? 1 : 0.15 } },
      vertexShader: ROCK_VERT, fragmentShader: ROCK_FRAG,
    });
    this.instances = []; // CPU copy (for shots / picking)
    // collisional families: clumps of debris sharing an orbit around a large parent body
    const fams = [];
    const nF = kuiper ? 10 : 28;
    for (let f = 0; f < nF; f++) {
      const x = kuiper ? rng.float() : THREE.MathUtils.clamp(0.5 + rng.gaussian(0, 0.17), 0, 1);
      fams.push({ r: rIn + (rOut - rIn) * x, th: rng.range(0, Math.PI * 2), y: rng.gaussian(0, thick * 0.4), used: 0 });
    }
    for (const cls of classes) {
      const nCls = Math.max(cls.variants, Math.round(total * cls.frac));
      const per = Math.ceil(nCls / cls.variants);
      for (let v = 0; v < cls.variants; v++) {
        const geo = rockGeometry(rng.int(1, 1e9), cls.detail);
        const ig = new THREE.InstancedBufferGeometry();
        ig.index = geo.index; ig.attributes.position = geo.attributes.position; ig.attributes.normal = geo.attributes.normal;
        const orb = new Float32Array(per * 4), rock = new Float32Array(per * 4), axis = new Float32Array(per * 3);
        for (let i = 0; i < per; i++) {
          // radial distribution: Kirkwood-like gaps for the main belt
          let x = rng.float();
          if (!kuiper) x = THREE.MathUtils.clamp(0.5 + rng.gaussian(0, 0.17), 0, 1);
          let r = rIn + (rOut - rIn) * x;
          let th = rng.range(0, Math.PI * 2);
          let y = rng.gaussian(0, thick * 0.5);
          // the largest bodies anchor the families; a share of the rest swarms around them
          const big = cls.size[0] >= 0.4;
          let fam = null;
          if (big || rng.chance(kuiper ? 0.15 : 0.32)) {
            const F = fam = big ? fams[fams.findIndex((q) => !q.used) >= 0 ? fams.findIndex((q) => !q.used) : rng.int(0, nF - 1)] : fams[rng.int(0, nF - 1)];
            if (big) { F.used = 1; r = F.r; th = F.th; y = F.y; }
            else { const sp = rng.range(0.4, 2.2); r = F.r + rng.gaussian(0, sp); th = F.th + rng.gaussian(0, sp * 1.6) / F.r; y = F.y + rng.gaussian(0, sp * 0.4); }
          }
          // family members co-orbit with their parent (the clump persists); field rocks shear differentially
          const omega = (Math.PI * 2) / layout.periodDays(layout.ra(fam ? fam.r : r));
          // power-law sizes: many pebbles, few boulders
          const s = cls.size[0] + (cls.size[1] - cls.size[0]) * Math.pow(rng.float(), 3.2);
          orb.set([r, th, y, omega], i * 4);
          rock.set([s * (kuiper ? 1.2 : 1), rng.range(-0.6, 0.6), rng.float(), rng.float()], i * 4);
          const [ax, ay, az] = rng.unitVector();
          axis.set([ax, ay, az], i * 3);
          this.instances.push({ r, th, y, omega, s });
        }
        ig.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(orb, 4));
        ig.setAttribute('aRock', new THREE.InstancedBufferAttribute(rock, 4));
        ig.setAttribute('aAxis', new THREE.InstancedBufferAttribute(axis, 3));
        ig.instanceCount = per;
        const mesh = new THREE.Mesh(ig, this.mat);
        mesh.frustumCulled = false;
        this.group.add(mesh);
      }
    }

    // ---- dust torus ----------------------------------------------------------------
    const nd = q.scale(kuiper ? 6000 : 26000);
    const dp = new Float32Array(nd * 4);
    for (let i = 0; i < nd; i++) {
      const x = kuiper ? rng.float() : THREE.MathUtils.clamp(0.5 + rng.gaussian(0, 0.26), 0, 1);
      const r = rIn + (rOut - rIn) * x;
      dp.set([r, rng.range(0, Math.PI * 2), rng.gaussian(0, thick * 0.8), (Math.PI * 2) / layout.periodDays(layout.ra(r))], i * 4);
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nd * 3), 3));
    dg.setAttribute('aOrbit', new THREE.BufferAttribute(dp, 4));
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: { uDays: { value: 0 }, uSun: { value: sun }, uDpr: { value: 1 }, uK: { value: kuiper ? 0.25 : 1 } },
      vertexShader: /* glsl */`
        attribute vec4 aOrbit; uniform float uDays, uDpr, uK; uniform vec3 uSun; varying vec3 vC;
        void main(){
          float th = aOrbit.y + aOrbit.w * uDays;
          vec3 p = vec3(cos(th) * aOrbit.x, aOrbit.z, sin(th) * aOrbit.x);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          vec3 V = normalize(cameraPosition - p), L = normalize(-p);
          float fwd = pow(max(dot(-V, L), 0.0), 6.0);
          float dist = -mv.z;
          // soft, overlapping motes: from afar they merge into a faint dusty band instead of salt noise
          float sz = clamp(70.0 / dist, 2.0, 5.0);
          vC = uSun * (0.0022 + 0.07 * fwd) * uK * smoothstep(0.3, 3.0, dist) / max(1.0, dist * 0.04) * (2.6 / sz);
          gl_PointSize = sz * uDpr;
        }`,
      fragmentShader: /* glsl */`varying vec3 vC; void main(){ vec2 c = gl_PointCoord * 2.0 - 1.0; float a = exp(-dot(c, c) * 3.0); gl_FragColor = vec4(vC * a, 1.0); }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });
    const dust = new THREE.Points(dg, this.dustMat);
    dust.frustumCulled = false;
    this.group.add(dust);
  }

  update(days, t, dpr) {
    this.mat.uniforms.uDays.value = days;
    this.mat.uniforms.uTime.value = t;
    this.dustMat.uniforms.uDays.value = days;
    this.dustMat.uniforms.uDpr.value = dpr;
  }

  /** World position of instance i at `days`. */
  instancePosition(inst, days, out) {
    const th = inst.th + inst.omega * days;
    return out.set(Math.cos(th) * inst.r, inst.y, Math.sin(th) * inst.r);
  }

  dispose() { this.group.traverse((o) => { o.geometry?.dispose(); }); this.mat.dispose(); this.dustMat.dispose(); }
}
