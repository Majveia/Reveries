// Explorer materials — physically based (three's MeshPhysicalMaterial lighting,
// shadows and image-based reflections) extended through onBeforeCompile with:
//   · per-vertex material data baked by the SDF sculptor (roughness, metalness,
//     sheen, accent-line + panel-seam signed distances, SDF ambient occlusion),
//   · procedural micro-surface (fabric weave, ribbing, quilting, boot tread,
//     panel grooves, smudges, dust near the ground) as derivative bump maps,
//   · emissive accent lines / visor HUD / scarf glyphs that bloom in HDR,
//   · a sun-aware rim light so the silhouette reads against any background.
// A tiny procedural environment (PMREM of a sky gradient oriented to the local
// "up" on the sphere + the sun) gives the hard shell its reflections.

import * as THREE from 'three';
import { PALETTE } from './Explorer.js';
import { CHAR_SHADOW_GLSL, CHAR_SHADOW_APPLY } from './CharShadow.js';

const COMMON_GLSL = /* glsl */`
uniform vec3 uRim;
uniform vec3 uSunView;
uniform float uTime;
uniform float uGlow;
uniform vec3 uDust;
float rvHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float rvNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rvHash(i), rvHash(i + vec3(1,0,0)), f.x), mix(rvHash(i + vec3(0,1,0)), rvHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(rvHash(i + vec3(0,0,1)), rvHash(i + vec3(1,0,1)), f.x), mix(rvHash(i + vec3(0,1,1)), rvHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float rvFbm(vec3 p) { return rvNoise(p) * 0.55 + rvNoise(p * 2.03) * 0.28 + rvNoise(p * 4.1) * 0.17; }
// derivative bump: h in meters, n in view space
vec3 rvBump(vec3 n, float h) {
  vec3 p = -vViewPosition;
  vec3 dpdx = dFdx(p), dpdy = dFdy(p);
  vec3 r1 = cross(dpdy, n), r2 = cross(n, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * n - grad);
}
// fade a pattern of the given period (m) when it gets smaller than a few pixels
float rvAA(float period, float px) { return 1.0 - smoothstep(period * 0.22, period * 0.6, px); }
`;

const RIM_GLSL = /* glsl */`
  {
    vec3 V = normalize(vViewPosition);
    float fres = pow(1.0 - saturate(dot(normal, V)), 4.0);
    // stronger when the sun is behind the character (back/edge light)
    float back = 0.35 + 0.65 * saturate(dot(uSunView, -V) * 0.5 + 0.5);
    outgoingLight += uRim * fres * back * rvAO;
  }
`;

function aoBlock(aoExpr) {
  return /* glsl */`
  float rvAO = ${aoExpr};
  reflectedLight.indirectDiffuse *= rvAO;
  reflectedLight.indirectSpecular *= rvAO * rvAO;
  reflectedLight.directDiffuse *= mix(0.55, 1.0, rvAO);
  reflectedLight.directSpecular *= mix(0.4, 1.0, rvAO);
  #ifdef USE_SHEEN
    sheenSpecularIndirect *= rvAO;
    sheenSpecularDirect *= mix(0.55, 1.0, rvAO);
  #endif
  #ifdef USE_CLEARCOAT
    clearcoatSpecularIndirect *= rvAO * rvAO;
  #endif
`;
}

/** Build the set of materials for the explorer. Returns { body, hard, visor, collar, scarf, flame, uniforms, env }. */
export function createExplorerMaterials(renderer, quality = 2, shadowUniforms = null) {
  const U = {
    uRim: { value: new THREE.Color(0, 0, 0) },
    uSunView: { value: new THREE.Vector3(0, 0, 1) },
    uTime: { value: 0 },
    uGlow: { value: 0 },
    uDust: { value: new THREE.Color('#8a7a62') },
    uAccent: { value: new THREE.Color(PALETTE.accent).multiplyScalar(5.0) },
    uGlyph: { value: new THREE.Color(PALETTE.glyph).multiplyScalar(3.0) },
    uVisorGlow: { value: 1 },
    uJet: { value: 0 },
  };
  const env = new CharacterEnv(renderer);
  const SU = shadowUniforms || { uCSMap: { value: null }, uCSMat: { value: new THREE.Matrix4() }, uCSHalf: { value: 1 }, uCSOn: { value: 0 }, uCSTexel: { value: 1 } };
  const bind = (sh, extra = {}) => {
    for (const k of ['uRim', 'uSunView', 'uTime', 'uGlow', 'uDust']) sh.uniforms[k] = U[k];
    Object.assign(sh.uniforms, SU, extra);
    // character self-shadow on every explorer material
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + CHAR_SHADOW_GLSL)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + CHAR_SHADOW_APPLY);
  };

  // ---- under-suit (skinned fabric) --------------------------------------------------
  const body = new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.8, metalness: 0, sheen: 1, sheenRoughness: 0.55,
    sheenColor: new THREE.Color('#5a6170'), envMap: env.texture, envMapIntensity: 0.6,
  });
  body.onBeforeCompile = (sh) => {
    bind(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aMat;\nvarying vec4 vMat;\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMat = aMat; vBind = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vMat;\nvarying vec3 vBind;\n' + COMMON_GLSL)
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
      vec3 bp = vBind;
      float px = length(fwidth(bp));
      float pat = vMat.z;
      float bumpH = 0.0;
      float macro = rvFbm(bp * 34.0);
      // technical fabric: soft macro wrinkles + fine weave
      bumpH += (macro - 0.5) * 0.0026;
      float weave = sin(bp.x * 2400.0) * sin(bp.y * 2400.0 + bp.z * 1700.0);
      bumpH += weave * 0.00005 * rvAA(0.0026, px);
      if (pat > 0.5 && pat < 1.5) { // ribbed
        float r = abs(sin(bp.y * 3.14159 / 0.0105));
        bumpH += sqrt(r) * 0.0016 * rvAA(0.0105, px);
        diffuseColor.rgb *= 0.86 + 0.14 * r;
      } else if (pat > 1.5 && pat < 2.5) { // quilted
        float a = abs(fract((bp.y + bp.z * 0.7 + abs(bp.x) * 0.7) / 0.034) - 0.5);
        float b = abs(fract((bp.y - bp.z * 0.7 - abs(bp.x) * 0.7) / 0.034) - 0.5);
        float st = smoothstep(0.0, 0.12, min(a, b));
        bumpH += st * 0.0022 * rvAA(0.034, px);
        diffuseColor.rgb *= 0.8 + 0.2 * st;
      } else if (pat > 2.5 && pat < 3.5) { // glove grip
        bumpH += (rvNoise(bp * 900.0) - 0.5) * 0.0005 * rvAA(0.002, px);
      } else if (pat > 3.5) { // boot tread / sole
        float r = abs(sin((bp.y + bp.z * 0.25) * 3.14159 / 0.008));
        bumpH += r * 0.0012 * rvAA(0.008, px);
      }
      // dust: settles on the shins and boots
      float dust = smoothstep(0.42, 0.02, bp.y) * (0.55 + 0.45 * rvFbm(bp * 40.0));
      diffuseColor.rgb = mix(diffuseColor.rgb, uDust, dust * 0.38);
      diffuseColor.rgb *= 0.9 + 0.2 * macro;
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`#include <roughnessmap_fragment>
      roughnessFactor = clamp(vMat.x + (macro - 0.5) * 0.12 + dust * 0.15, 0.25, 1.0);`)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = rvBump(normal, bumpH);')
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + aoBlock('vMat.w'))
      .replace('#include <opaque_fragment>', RIM_GLSL + '#include <opaque_fragment>');
  };

  // ---- hard-shell armour (rigid) ---------------------------------------------------------
  const hard = new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.3, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.22,
    envMap: env.texture, envMapIntensity: 1.0, specularIntensity: 0.6,
  });
  hard.onBeforeCompile = (sh) => {
    bind(sh, { uAccent: U.uAccent, uJet: U.uJet, uColB: { value: new THREE.Color().setRGB(...PALETTE.graphite) } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aMat;\nattribute vec3 aAO;\nvarying vec4 vMat;\nvarying vec3 vAO;\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMat = aMat; vAO = aAO; vBind = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uAccent;\nuniform float uJet;\nuniform vec3 uColB;\nvarying vec4 vMat;\nvarying vec3 vAO;\nvarying vec3 vBind;\n' + COMMON_GLSL)
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
      vec3 bp = vBind;
      float px = length(fwidth(bp));
      float lineD = vMat.z, seamD = vMat.w;
      // two-tone split (crisp, anti-aliased boundary from an interpolated signed distance)
      float splitD = vAO.z;
      float splitW = max(fwidth(splitD), 1e-5);
      float isB = 1.0 - smoothstep(-splitW, splitW, splitD);
      diffuseColor.rgb = mix(diffuseColor.rgb, uColB, isB);
      float splitGroove = (1.0 - smoothstep(0.0, max(splitW * 1.5, 0.0012), abs(splitD))) * step(abs(splitD), 0.9);
      float lineW = max(px * 0.75, 0.0018);
      float seamW = max(px * 0.6, 0.0011);
      // panel seams: a recessed groove with a dark core
      float groove = max(1.0 - smoothstep(seamW * 0.4, seamW * 1.6, abs(seamD)), splitGroove * 0.8);
      float bumpH = -groove * 0.0013;
      // smudges / micro wear
      float smudge = rvFbm(bp * 22.0);
      float scratch = rvNoise(vec3(bp.x * 1400.0, bp.y * 60.0, bp.z * 1400.0));
      bumpH += (smudge - 0.5) * 0.00045;
      diffuseColor.rgb *= 1.0 - groove * 0.55;
      diffuseColor.rgb *= 0.94 + 0.1 * smudge;
      // edge wear: paint chipped off convex edges reveals brushed metal; grime settles in creases
      float curv = vAO.y;
      float chips = rvFbm(bp * 160.0);
      float wear = smoothstep(0.45, 0.85, curv * 0.9 + (chips - 0.5) * 0.7) * step(0.3, max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b)));
      float grime = smoothstep(-0.08, -0.5, curv) * 0.5 + (1.0 - vAO.x) * 0.25;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.42, 0.44), wear * 0.75);
      diffuseColor.rgb *= 1.0 - grime * 0.45;
      float dust = smoothstep(0.36, 0.03, bp.y) * (0.5 + 0.5 * rvFbm(bp * 30.0));
      diffuseColor.rgb = mix(diffuseColor.rgb, uDust, dust * 0.45);
      // accent emissive core + soft halo
      float core = 1.0 - smoothstep(lineW * 0.5, lineW * 1.25, abs(lineD));
      float halo = exp(-abs(lineD) / 0.0045) * 0.18;
      float isLine = step(abs(lineD), 0.9);
      vec3 rvEmit = uAccent * (core + halo) * isLine;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03), core * isLine * 0.7);
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`#include <roughnessmap_fragment>
      roughnessFactor = clamp(mix(vMat.x, 0.44, isB) + (smudge - 0.5) * 0.16 + scratch * 0.06 * rvAA(0.003, px) + groove * 0.3 + dust * 0.3 + grime * 0.2 - wear * 0.05, 0.08, 1.0);`)
      .replace('#include <metalnessmap_fragment>', /* glsl */`#include <metalnessmap_fragment>
      metalnessFactor = clamp(max(mix(vMat.y, 0.45, isB), wear * 0.9), 0.0, 1.0);`)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = rvBump(normal, bumpH);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += rvEmit;')
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + aoBlock('vAO.x * (1.0 - groove * 0.5)'))
      .replace('#include <opaque_fragment>', RIM_GLSL + '#include <opaque_fragment>');
  };

  // ---- visor glass ------------------------------------------------------------------
  const visor = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#0d1418'), roughness: 0.06, metalness: 0.65, clearcoat: 1, clearcoatRoughness: 0.03,
    envMap: env.texture, envMapIntensity: 1.5, iridescence: 0.18, iridescenceIOR: 1.5,
  });
  visor.onBeforeCompile = (sh) => {
    bind(sh, { uVisorGlow: U.uVisorGlow, uAccent: U.uAccent });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vVis;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvVis = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uVisorGlow;\nuniform vec3 uAccent;\nvarying vec2 vVis;\n' + COMMON_GLSL)
      .replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
      {
        vec2 q = vVis;
        float edge = max(abs(q.x), abs(q.y));
        // inner light pooled at the lower edge of the visor, a thin HUD arc, a faint scan
        float pool = smoothstep(-0.2, -1.05, q.y) * (1.0 - smoothstep(0.6, 1.0, abs(q.x)));
        float rim = smoothstep(0.86, 0.99, edge);
        float arc = 1.0 - smoothstep(0.0, 0.05, abs(q.y + 0.55 - q.x * q.x * 0.2));
        arc *= smoothstep(0.75, 0.2, abs(q.x));
        float scan = 0.5 + 0.5 * sin(q.y * 80.0 - uTime * 3.0);
        vec3 glow = uAccent * (pool * 0.05 + rim * 0.06 + arc * 0.16);
        totalEmissiveRadiance += glow * uVisorGlow;
      }`)
      .replace('#include <opaque_fragment>', /* glsl */`
      { float rvAO = 1.0; ${RIM_GLSL} }
      #include <opaque_fragment>`);
  };

  // ---- cloth (scarf + collar) -------------------------------------------------------------
  const clothShader = (isScarf) => (sh) => {
    bind(sh, { uGlyph: U.uGlyph });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${isScarf ? 'attribute vec3 aCloth;' : 'attribute float aAO;'}\nvarying vec3 vCloth;\nvarying vec3 vBind;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${isScarf ? 'vCloth = aCloth;' : 'vCloth = vec3(uv, aAO);'}\nvBind = position;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uGlyph;\nvarying vec3 vCloth;\nvarying vec3 vBind;\n' + COMMON_GLSL)
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
      // vCloth: scarf → (across 0..1, along meters, ao); collar → (angle, height, ao)
      vec2 cuv = vCloth.xy;
      float px = length(fwidth(vBind)) + 1e-5;
      float bumpH = 0.0;
      vec3 rvEmit = vec3(0.0);
      ${isScarf ? /* glsl */`
      float across = cuv.x, along = cuv.y;
      float px2 = fwidth(along) + fwidth(across) * 0.16;
      // woven texture
      float warp = sin(across * 3.14159 * 64.0), weft = sin(along * 3.14159 / 0.0042);
      bumpH += (warp * 0.5 + weft * 0.5) * 0.00018 * rvAA(0.008, px2);
      // soft folds baked into the albedo
      float tone = 0.86 + 0.14 * rvFbm(vec3(across * 3.0, along * 6.0, 0.0));
      diffuseColor.rgb *= tone;
      // embroidered borders
      float border = smoothstep(0.075, 0.06, abs(across - 0.1)) + smoothstep(0.075, 0.06, abs(across - 0.9));
      border = min(border, 1.0) * (1.0 - smoothstep(0.035, 0.0, abs(abs(across - 0.5) - 0.4) - 0.01));
      float bline = 1.0 - smoothstep(0.012, 0.03, abs(abs(across - 0.5) - 0.4));
      // glyph band: one glyph every 9 cm, a 3x4 bit pattern per glyph
      float gi = floor(along / 0.12);
      float gl = fract(along / 0.12);
      vec2 cell = vec2((across - 0.34) / 0.32, (gl - 0.2) / 0.6);
      float glyph = 0.0;
      if (cell.x > 0.0 && cell.x < 1.0 && cell.y > 0.0 && cell.y < 1.0) {
        // calligraphic rune: a spine, hash-chosen bars and a diagonal (thin strokes)
        float sw = 0.075;
        vec2 c = cell - 0.5;
        float spine = smoothstep(sw, sw * 0.5, abs(c.x)) * step(abs(c.y), 0.46);
        float bars = 0.0;
        for (int k = 0; k < 3; k++) {
          float fk = float(k);
          float on = step(0.4, rvHash(vec3(gi, fk, 1.7)));
          float side = rvHash(vec3(gi, fk, 4.1)) > 0.5 ? 1.0 : -1.0;
          float yk = -0.32 + fk * 0.32;
          float len = 0.18 + 0.22 * rvHash(vec3(gi, fk, 9.2));
          float inX = step(0.0, c.x * side) * step(c.x * side, len);
          bars += on * inX * smoothstep(sw, sw * 0.5, abs(c.y - yk));
        }
        float dg = step(0.55, rvHash(vec3(gi, 5.0, 2.2))) * smoothstep(sw * 1.2, sw * 0.6, abs(c.y - c.x * 1.4)) * step(abs(c.x), 0.3);
        glyph = clamp(spine + bars + dg, 0.0, 1.0);
      }
      float band = smoothstep(0.45, 0.6, along) * (1.0 - smoothstep(1.15, 1.3, along)) * step(0.5, rvHash(vec3(gi, 3.1, 7.7)) + 0.35);
      glyph *= band;
      vec3 gold = vec3(0.62, 0.42, 0.14);
      diffuseColor.rgb = mix(diffuseColor.rgb, gold, max(bline, glyph) * 0.85);
      rvEmit = uGlyph * (glyph * (0.25 + 1.75 * uGlow) + bline * 0.04 * uGlow);
      // frayed tip
      ` : /* glsl */`
      float ang = cuv.x, hh = cuv.y;
      float folds = rvFbm(vec3(ang * 6.0, hh * 3.0, 0.0));
      bumpH += (folds - 0.5) * 0.004 + sin(ang * 40.0 + hh * 8.0) * 0.0008;
      bumpH += sin(ang * 3.14159 * 90.0) * 0.00015 * rvAA(0.006, px);
      diffuseColor.rgb *= 0.78 + 0.32 * folds;
      `}
      `)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = 0.82;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = rvBump(normal, bumpH);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += rvEmit;')
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + aoBlock(isScarf ? 'vCloth.z' : 'vCloth.z'))
      .replace('#include <opaque_fragment>', RIM_GLSL + '#include <opaque_fragment>');
  };
  const scarfColor = new THREE.Color().setRGB(...PALETTE.scarf);
  const clothParams = {
    color: scarfColor, roughness: 0.82, metalness: 0, sheen: 1, sheenRoughness: 0.45,
    sheenColor: new THREE.Color('#ff8a6a'), envMap: env.texture, envMapIntensity: 0.45,
  };
  const collar = new THREE.MeshPhysicalMaterial(clothParams);
  collar.onBeforeCompile = clothShader(false);
  const scarf = new THREE.MeshPhysicalMaterial({ ...clothParams, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide });
  scarf.onBeforeCompile = clothShader(true);
  scarf.customProgramCacheKey = () => 'rv-scarf';
  collar.customProgramCacheKey = () => 'rv-collar';
  body.customProgramCacheKey = () => 'rv-body';
  hard.customProgramCacheKey = () => 'rv-hard';
  visor.customProgramCacheKey = () => 'rv-visor';

  // ---- thruster flame (additive, HDR) --------------------------------------------------
  const flame = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uJet: U.uJet },
    vertexShader: /* glsl */`
      varying vec3 vP; varying vec3 vN; varying vec3 vV;
      void main() {
        vP = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform float uJet;
      varying vec3 vP; varying vec3 vN; varying vec3 vV;
      float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        float t = clamp(-vP.y / 0.42, 0.0, 1.0); // 0 at the nozzle, 1 at the tip
        float fres = abs(dot(normalize(vN), normalize(vV)));
        float flick = 0.75 + 0.25 * h(vec2(floor(uTime * 40.0), floor(t * 6.0)));
        float core = pow(fres, 2.0) * (1.0 - t) * (1.0 - t);
        vec3 hot = vec3(0.65, 0.85, 1.0) * 9.0, mid = vec3(0.2, 0.55, 1.0) * 3.0, tail = vec3(1.0, 0.45, 0.15) * 1.2;
        vec3 c = mix(hot, mix(mid, tail, smoothstep(0.35, 1.0, t)), smoothstep(0.0, 0.35, t));
        float a = core * flick * uJet;
        gl_FragColor = vec4(c * a, 1.0);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });

  env.materials.push(body, hard, visor, collar, scarf);
  return { body, hard, visor, collar, scarf, flame, uniforms: U, env };
}

// =====================================================================================
// Character environment: a tiny sky/ground gradient PMREM oriented to the local up.
// =====================================================================================
const _up = new THREE.Vector3(), _sun = new THREE.Vector3();
class CharacterEnv {
  constructor(renderer) {
    this.renderer = renderer;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.scene = new THREE.Scene();
    this.uniforms = {
      uUp: { value: new THREE.Vector3(0, 1, 0) },
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uSky: { value: new THREE.Color('#7fb8ec') },
      uZenith: { value: new THREE.Color('#3b7dd8') },
      uHorizon: { value: new THREE.Color('#d6ecff') },
      uGround: { value: new THREE.Color('#4a5a3a') },
      uSunCol: { value: new THREE.Color('#fff4dc') },
      uDay: { value: 1 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false,
      vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */`
        uniform vec3 uUp, uSun, uSky, uZenith, uHorizon, uGround, uSunCol; uniform float uDay;
        varying vec3 vD;
        void main() {
          vec3 d = normalize(vD);
          float e = dot(d, uUp);
          vec3 sky = mix(uHorizon, uSky, smoothstep(0.0, 0.25, e));
          sky = mix(sky, uZenith, smoothstep(0.25, 0.95, e));
          vec3 gnd = mix(uHorizon * 0.45, uGround, smoothstep(0.0, -0.3, e));
          vec3 c = e > 0.0 ? sky : gnd;
          float s = max(dot(d, uSun), 0.0);
          c += uSunCol * (pow(s, 600.0) * 60.0 + pow(s, 12.0) * 0.6) * step(-0.02, e);
          c *= uDay;
          // a faint cool skylight that never quite disappears (night: starlight / moon)
          c += vec3(0.010, 0.014, 0.024) * smoothstep(-0.2, 0.6, e);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), mat));
    this.rt = null;
    this.texture = null;
    this.materials = [];
    this._lastUp = new THREE.Vector3(9, 9, 9);
    this._lastSun = new THREE.Vector3(9, 9, 9);
    this._build();
  }
  setPalette(P) {
    if (!P) return;
    const u = this.uniforms;
    if (P.sky) u.uSky.value.set(P.sky);
    if (P.zenith) u.uZenith.value.set(P.zenith);
    if (P.horizon) u.uHorizon.value.set(P.horizon);
    if (P.sun) u.uSunCol.value.set(P.sun);
    const g = Array.isArray(P.ground) ? P.ground[0] : P.ground;
    if (g) u.uGround.value.set(g).multiplyScalar(0.6);
  }
  /** Re-render when the local up or the sun moved noticeably. */
  update(up, sunDir, daylight, force = false) {
    _up.copy(up); _sun.copy(sunDir);
    if (!force && _up.dot(this._lastUp) > 0.99995 && _sun.dot(this._lastSun) > 0.9995 && Math.abs(daylight - this.uniforms.uDay.value) < 0.03) return false;
    this._lastUp.copy(_up); this._lastSun.copy(_sun);
    this.uniforms.uUp.value.copy(_up);
    this.uniforms.uSun.value.copy(_sun);
    this.uniforms.uDay.value = daylight;
    this._build();
    return true;
  }
  _build() {
    const prev = this.rt;
    this.rt = this.pmrem.fromScene(this.scene, 0, 0.1, 100, { size: 64 });
    this.texture = this.rt.texture;
    for (const m of this.materials) m.envMap = this.texture;
    if (prev) prev.dispose();
  }
  dispose() { this.rt?.dispose(); this.pmrem.dispose(); }
}
