// GLSL noise library (string chunks). Include in shaders via template literals:
//   fragmentShader: `${NOISE_GLSL} void main(){ float n = snoise(p); }`
// Simplex implementations adapted from Ashima Arts / Stefan Gustavson (MIT).
// Hashes from Dave Hoskins "Hash without Sine" (MIT) — stable on mobile GPUs.

export const HASH_GLSL = /* glsl */ `
float hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash33(vec3 p3){ p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
vec3 hash32(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
`;

export const SIMPLEX_GLSL = /* glsl */ `
vec3 _sn_mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 _sn_mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 _sn_mod289(vec2 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 _sn_permute(vec4 x){ return _sn_mod289(((x * 34.0) + 10.0) * x); }
vec3 _sn_permute(vec3 x){ return _sn_mod289(((x * 34.0) + 10.0) * x); }
vec4 _sn_taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

// 3D simplex noise, range ~[-1,1]
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = _sn_mod289(i);
  vec4 p = _sn_permute(_sn_permute(_sn_permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = _sn_taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

// 2D simplex noise, range ~[-1,1]
float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = _sn_mod289(i);
  vec3 p = _sn_permute(_sn_permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
  m = m*m; m = m*m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float fbm(vec3 p, int octaves){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 10; i++) { if (i >= octaves) break; s += a * snoise(p); n += a; p = p * 2.03 + vec3(1.7, -3.1, 2.3); a *= 0.5; }
  return s / n;
}
float fbm(vec2 p, int octaves){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 10; i++) { if (i >= octaves) break; s += a * snoise(p); n += a; p = p * 2.03 + vec2(1.7, -3.1); a *= 0.5; }
  return s / n;
}
float ridged(vec3 p, int octaves){
  float s = 0.0, a = 0.5, w = 1.0, n = 0.0;
  for (int i = 0; i < 10; i++) { if (i >= octaves) break; float r = 1.0 - abs(snoise(p)); r *= r * w; w = clamp(r * 2.0, 0.0, 1.0); s += r * a; n += a; p = p * 2.07 + vec3(4.1, 1.3, -2.2); a *= 0.5; }
  return s / n;
}
`;

export const WORLEY_GLSL = /* glsl */ `
// Cellular noise: returns vec2(F1, F2) distances. Requires HASH_GLSL.
vec2 worley(vec3 p){
  vec3 id = floor(p), f = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 b = vec3(float(i), float(j), float(k));
    vec3 r = b + hash33(id + b) - f;
    float d = dot(r, r);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
  }
  return sqrt(vec2(f1, f2));
}
vec2 worley(vec2 p){
  vec2 id = floor(p), f = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 b = vec2(float(i), float(j));
    vec2 r = b + hash22(id + b) - f;
    float d = dot(r, r);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
  }
  return sqrt(vec2(f1, f2));
}
`;

/** Everything at once (hash + simplex + fbm + worley). */
export const NOISE_GLSL = HASH_GLSL + SIMPLEX_GLSL + WORLEY_GLSL;
