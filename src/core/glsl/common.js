// Shared GLSL helpers.
//
// DEPTH: the engine uses a REVERSED depth buffer when EXT_clip_control is
// available (engine.reversedDepth === true): 1.0 = near plane, 0.0 = far plane,
// stored in a 32-bit float depth texture → near-uniform precision from 5 cm to
// 1e6 m. Post effects that read depth MUST use these helpers with the
// `uReversedDepth` (0.0/1.0) uniform supplied in the effect context.

export const DEPTH_GLSL = /* glsl */ `
// Perspective depth-buffer value → view-space Z (negative in front of camera).
float depthToViewZ(float depth, float near, float far, float reversed){
  if (reversed > 0.5) {
    // reversed: depth = (c*z + d) / -z, c = n/(f-n), d = f*n/(f-n)
    return -(far * near) / (depth * (far - near) + near);
  }
  float ndc = depth * 2.0 - 1.0;
  return (2.0 * near * far) / (ndc * (far - near) - (far + near));
}
// True when nothing was rendered at this pixel (background / sky).
bool isFarDepth(float depth, float reversed){
  return reversed > 0.5 ? depth <= 0.0 : depth >= 1.0;
}
// View-space position from uv + depth, using the inverse projection matrix.
vec3 viewPosFromDepth(vec2 uv, float depth, mat4 projInv, float reversed){
  float z = reversed > 0.5 ? depth : depth * 2.0 - 1.0;
  vec4 clip = vec4(uv * 2.0 - 1.0, z, 1.0);
  vec4 v = projInv * clip;
  return v.xyz / v.w;
}
`;

export const COLOR_GLSL = /* glsl */ `
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// Approximate blackbody color (linear sRGB, normalized) for 1000K..40000K.
vec3 blackbody(float t){
  t = clamp(t, 1000.0, 40000.0) / 100.0;
  vec3 c;
  c.r = t <= 66.0 ? 1.0 : clamp(1.29293618606 * pow(t - 60.0, -0.1332047592), 0.0, 1.0);
  c.g = t <= 66.0 ? clamp(0.39008157876 * log(t) - 0.63184144378, 0.0, 1.0) : clamp(1.12989086089 * pow(t - 60.0, -0.0755148492), 0.0, 1.0);
  c.b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : clamp(0.54320678911 * log(t - 10.0) - 1.19625408914, 0.0, 1.0));
  return pow(c, vec3(2.2)); // to linear
}
vec3 srgbToLinear(vec3 c){ return pow(c, vec3(2.2)); }
// Interleaved gradient noise (Jimenez) for dithering / jittering ray starts.
float ign(vec2 fragCoord){ return fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715)))); }
`;

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
