// Ocean post effects (HDR, before the atmosphere pass):
//   • underwater: wavelength-dependent absorption + in-scattering fog, seabed
//     caustics on every surface below the waterline, surface light falloff
//   • lava worlds: heat haze — refraction shimmer in the air layer over the melt
import * as THREE from 'three';
import { DEPTH_GLSL, FULLSCREEN_VERT } from '../../../core/glsl/common.js';

const FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform sampler2D tInput, tDepth, tDetail;
uniform float uNear, uFar, uRev, uTime, uRs;
uniform mat4 uProjInv, uViewInv;
uniform vec3 uCam, uSunDir;
uniform float uUnder, uHaze;
uniform vec2 uFume;          // density at the surface (1/m), scale height (m)
uniform vec3 uGlow;          // radiance of the lit fumes
uniform vec3 uAbsorb, uScatter, uLight;
uniform vec3 uE, uN;         // tangent axes at the camera (plume coordinates)
uniform vec2 uWindXZ;
uniform vec2 uPlume;         // plume density at the root (1/m), scale height (m)
varying vec2 vUv;
float luma3(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main(){
  vec2 uv = vUv;
  float depth = texture2D(tDepth, uv).r;
  bool far = isFarDepth(depth, uRev);
  vec3 vp = viewPosFromDepth(uv, far ? 0.5 : depth, uProjInv, uRev);
  vec3 rd = normalize((uViewInv * vec4(vp, 1.0)).xyz - uCam);
  float dist = far ? 1e6 : length(viewPosFromDepth(uv, depth, uProjInv, uRev));
  vec3 P = uCam + rd * dist;

  if (uHaze > 0.0) {
    float hAbove = length(P) - uRs;
    float camAbove = length(uCam) - uRs;
    // shimmer strongest just above the melt and for rays skimming over it
    float layer = exp(-max(hAbove, 0.0) / 30.0) + exp(-max(camAbove, 0.0) / 40.0) * 0.5;
    float s = uHaze * layer * smoothstep(4.0, 40.0, dist) * (1.0 - smoothstep(1500.0, 6000.0, dist));
    vec2 n = texture2D(tDetail, uv * vec2(3.0, 1.6) + vec2(0.0, -uTime * 0.09)).rg + texture2D(tDetail, uv * vec2(5.3, 2.7) + vec2(uTime * 0.013, -uTime * 0.15)).rg - 1.0;
    uv += n * s * 0.006;
  }
  vec3 col = texture2D(tInput, uv).rgb;

  if (uHaze > 0.0) {
    // incandescent fumes: a low exponential layer over the melt, lit from below.
    // Rays that climb leave it at once (black sky stays black); rays skimming the
    // sea gather a molten horizon glow. Out of it rise smoke / steam plumes off
    // the rifts: columns that lean downwind and billow as they climb, their
    // roots lit blood-orange by the melt, their tops ash-dark against the sky.
    float tEnd = far ? 30000.0 : dist;
    float trBg = 1.0, trG = 1.0, prev = 0.0;
    vec3 acc = vec3(0.0);
    float plOD = 0.0;
    for (int i = 1; i <= FUME_STEPS; i++) {
      float f = float(i) / float(FUME_STEPS);
      float t = tEnd * f * f;
      float tm = 0.5 * (t + prev), dt = t - prev;
      prev = t;
      vec3 X = uCam + rd * tm;
      float hh = max(length(X) - uRs, 0.0);
      // the first tens of metres stay clear: near crust reads black, not orange
      float nearK = smoothstep(20.0, 140.0, tm);
      float base = exp(-hh / uFume.y) * uFume.x;
      float plume = 0.0;
      // ember-lit root fades to grey-black smoke higher up
      float lit = exp(-hh / 170.0) * 2.4 + 0.04;
      float eG = (base + plume) * dt * nearK;
      acc += trG * uGlow * (base + plume * lit) * dt * nearK * (eG > 1e-4 ? (1.0 - exp(-eG)) / eG : 1.0);
      trG *= exp(-eG);
      plOD += base * dt * nearK;
      trBg *= exp(-(base * 0.35 + plume * 1.3) * dt * nearK);
    }
    col = col * trBg + acc;
    // plumes: discrete smoke / steam columns over vents on a jittered grid in
    // the camera's tangent plane, integrated analytically per column (closest
    // approach of the ray to each column's leaning axis) — no aliasing at any
    // distance, ~a dozen columns per ray
    if (uPlume.x > 0.0) {
      vec2 o2 = vec2(dot(uCam, uE), dot(uCam, uN));
      vec2 d2 = vec2(dot(rd, uE), dot(rd, uN));
      float hl = length(d2);
      if (hl > 1e-3) {
        vec2 dd = d2 / hl;
        float sMax = min(tEnd * hl, 16000.0);
        const float C = 950.0;
        vec2 vis0 = vec2(1e9), vis1 = vec2(1e9), vis2 = vec2(1e9), vis3 = vec2(1e9);
        float Tp = 1.0; vec3 ap = vec3(0.0);
        for (int i = 0; i < 26; i++) {
          float sx = float(i) * C * 0.45;
          if (sx > sMax + C) break;
          vec2 cell = floor((o2 + dd * sx) / C);
          for (int k = 0; k < 2; k++) {
            // also visit the side-neighbour the ray is drifting toward
            vec2 ck = cell;
            if (k == 1) { vec2 fr = fract((o2 + dd * sx) / C) - 0.5; ck = cell + (abs(fr.x) > abs(fr.y) ? vec2(sign(fr.x), 0.0) : vec2(0.0, sign(fr.y))); }
            if (ck == vis0 || ck == vis1 || ck == vis2 || ck == vis3) continue;
            vis3 = vis2; vis2 = vis1; vis1 = vis0; vis0 = ck;
            vec3 hv = fract(sin(vec3(dot(ck, vec2(127.1, 311.7)), dot(ck, vec2(269.5, 183.3)), dot(ck, vec2(419.2, 371.9)))) * 43758.5453);
            if (hv.z < 0.42) continue;
            vec2 v = (ck + 0.5 + (hv.xy - 0.5) * 0.5) * C;
            float sc = clamp(dot(v - o2, dd), 0.0, sMax);
            vec3 X = uCam + rd * (sc / hl);
            float hh = max(length(X) - uRs, 0.0);
            v += uWindXZ * hh * 0.45;
            sc = clamp(dot(v - o2, dd), 0.0, sMax);
            X = uCam + rd * (sc / hl);
            hh = max(length(X) - uRs, 0.0);
            vec2 rel = o2 + dd * sc - v;
            float dmin = length(rel);
            float r = (45.0 + 0.3 * hh) * (0.7 + 0.6 * hv.x);
            if (dmin > 2.5 * r) continue;
            float bil = texture2D(tDetail, vec2(hv.y + dot(rel, vec2(-dd.y, dd.x)) / (r * 3.0), (hh - uTime * (6.0 + 5.0 * hv.z)) / (180.0 + 0.4 * hh))).a;
            float bil2 = texture2D(tDetail, vec2(hv.x * 3.0 + dmin / (r * 1.7), (hh - uTime * 9.0) / 90.0) + 0.37).a;
            float rho = uPlume.x * exp(-hh / uPlume.y) * (0.35 + 1.3 * smoothstep(0.3, 0.75, bil * 0.65 + bil2 * 0.45)) * (0.5 + hv.y);
            float od = rho * 1.7725 * r * exp(-dmin * dmin / (r * r)) / max(hl, 0.12) * smoothstep(60.0, 260.0, sc / hl);
            float lit = exp(-hh / 420.0) * 2.2 + 0.1;
            ap += Tp * uGlow * lit * (1.0 - exp(-od));
            Tp *= exp(-od);
          }
        }
        col = col * Tp + ap;
      }
    }
#if FXDBG == 7
    gl_FragColor = vec4(plOD, 1.0 - trBg, luma3(acc), 1.0); return;
#endif
  }

  if (uUnder > 0.5) {
    float d = min(dist, 4000.0);
    vec3 T = exp(-uAbsorb * d);
    // light reaching the camera depth, falling off with depth below the surface
    float camDepth = max(uRs - length(uCam), 0.0);
    vec3 Lz = uLight * exp(-uAbsorb * camDepth * 1.2);
    float up = dot(rd, normalize(uCam));
    vec3 fogc = uScatter * Lz * (0.55 + 0.45 * smoothstep(-0.5, 1.0, up));
    if (!far) {
      float pd = uRs - length(P);
      if (pd > 0.0) {
        vec2 cxz = vec2(dot(P, vec3(1.0, 0.0, 0.0)), dot(P, vec3(0.0, 0.0, 1.0))) * 0.45;
        float c1 = texture2D(tDetail, cxz + vec2(uTime * 0.031, uTime * 0.017)).b;
        float c2 = texture2D(tDetail, cxz * 1.31 + vec2(-uTime * 0.023, uTime * 0.029)).b;
        float caus = pow(c1 * c2 * 1.7, 2.5) * exp(-pd * 0.12);
        col += col * caus * 2.5 * max(dot(normalize(P), uSunDir), 0.0);
      }
    }
    col = col * T + fogc * (1.0 - T);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export class OceanFX {
  constructor(ocean) {
    this.ocean = ocean;
    const w = ocean.world;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: FRAG, defines: { FUME_STEPS: ocean.engine.quality.pick(10, 12, 18, 22), FXDBG: +(ocean.engine.params?.get?.('odbg') || 0) }, depthTest: false, depthWrite: false,
      uniforms: {
        tInput: { value: null }, tDepth: { value: null }, tDetail: { value: ocean.tDetail },
        uNear: { value: 0.1 }, uFar: { value: 1e7 }, uRev: { value: 1 }, uTime: w.uniforms.uTime, uRs: { value: ocean.seaRadius },
        uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() }, uSunDir: w.uniforms.uSunDir,
        uUnder: { value: 0 }, uHaze: { value: 0 }, uFume: { value: new THREE.Vector2(1 / 6500, 50) }, uGlow: { value: new THREE.Vector3(0.75, 0.085, 0.008) },
        uAbsorb: { value: new THREE.Vector3(0.32, 0.075, 0.06) }, uScatter: { value: new THREE.Vector3(0.02, 0.16, 0.2) }, uLight: { value: new THREE.Vector3(1, 1, 1) },
        uE: { value: new THREE.Vector3(1, 0, 0) }, uN: { value: new THREE.Vector3(0, 0, 1) }, uWindXZ: { value: new THREE.Vector2(1, 0) },
        // plumes are off until this pass can run after the atmosphere pass, which
        // repaints far-depth (sky) pixels and hid every column in testing; enable
        // with ?plumes=1 to experiment
        uPlume: { value: new THREE.Vector2(ocean.engine.params?.get?.('plumes') === '1' && ocean.engine.quality.level >= 1 ? 1 / 260 : 0, 2600) },
      },
    });
  }

  get enabled() { const o = this.ocean; return !!o.enabled && (o.under || o.isLava); }

  render(renderer, input, output, ctx) {
    const o = this.ocean, u = this.mat.uniforms;
    u.tInput.value = input; u.tDepth.value = ctx.depthTexture;
    u.uNear.value = ctx.near; u.uFar.value = ctx.far; u.uRev.value = ctx.reversed ? 1 : 0;
    u.uProjInv.value.copy(ctx.projInv); u.uViewInv.value.copy(ctx.viewInv); u.uCam.value.copy(ctx.cameraPosition);
    u.uUnder.value = o.under ? 1 : 0;
    u.uHaze.value = o.isLava ? 1 : 0;
    if (o.isLava) {
      const up = _n.copy(ctx.cameraPosition).normalize();
      u.uE.value.set(0, 1, 0).cross(up);
      if (u.uE.value.lengthSq() < 1e-6) u.uE.value.set(1, 0, 0);
      u.uE.value.normalize();
      u.uN.value.copy(up).cross(u.uE.value).normalize();
      const wd = o.world.wind;
      if (wd) u.uWindXZ.value.set(wd.dot(u.uE.value), wd.dot(u.uN.value));
      const wl = u.uWindXZ.value.length();
      if (wl > 1e-6) u.uWindXZ.value.multiplyScalar(1 / wl); else u.uWindXZ.value.set(1, 0);
    }
    const L = o.level.lighting;
    if (L) {
      const k = L.keyColor, s = L.skyColor, c = Math.max(0, o.world.sunDir.dot(_n.copy(ctx.cameraPosition).normalize()));
      u.uLight.value.set(k.r * c + s.r * Math.PI, k.g * c + s.g * Math.PI, k.b * c + s.b * Math.PI);
    }
    ctx.fullscreen(this.mat, output);
  }

  dispose() { this.mat.dispose(); }
}

const _n = new THREE.Vector3();
