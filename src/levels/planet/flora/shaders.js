// Shared GLSL for flora materials (patched into MeshStandardMaterial so every
// plant gets the same sun, sky IBL and shadows as terrain and buildings).

export const WIND_GLSL = /* glsl */ `
uniform float uTime;
uniform vec4 uWind;          // xyz direction, w strength 0..1
uniform vec3 uAnchor;        // world position of the flora anchor (mesh origin)
uniform vec3 uKeyColor;      // sun/moon irradiance (rgb × intensity)
uniform vec3 uKeyDir;        // toward the key light
uniform float uNight;        // 0 day … 1 night
float fl_hash(float n) { return fract(sin(n) * 43758.5453123); }
float fl_hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
// rolling gusts: bands of stronger wind travelling downwind across the land
float fl_gust(vec3 wp, vec3 wd, float t) {
  float ph = dot(wp, wd);
  vec3 side = normalize(cross(wd, normalize(wp)) + 1e-5);
  float lat = dot(wp, side);
  float g = sin(ph * 0.045 - t * 1.35 + sin(lat * 0.021 + t * 0.13) * 2.2);
  g = g * 0.5 + 0.5;
  float g2 = sin(ph * 0.11 - t * 2.4 + lat * 0.05) * 0.5 + 0.5;
  return g * g * (0.65 + 0.35 * g2);
}
`;

/** Remove three's back-face normal flip (soft, volumetric foliage lighting). */
export const NO_FLIP_NORMAL = /* glsl */ `
#include <normal_fragment_begin>
#ifndef FLAT_SHADED
normal = normalize( vNormal );
#endif
`;

/** Common uniforms object for flora materials (shares world uniforms by reference). */
export function floraUniforms(world, extra = {}) {
  const U = world.uniforms;
  return {
    uTime: U.uTime,
    uWind: U.uWind,
    uAnchor: extra.uAnchor,
    uKeyColor: extra.uKeyColor,
    uKeyDir: extra.uKeyDir,
    uNight: extra.uNight,
    ...extra,
  };
}

/** Attach uniforms + a shader patch to a material via onBeforeCompile. */
export function patchMaterial(mat, uniforms, patch, key) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    patch(sh);
  };
  mat.customProgramCacheKey = () => key;
  mat.userData.floraUniforms = uniforms;
  return mat;
}
