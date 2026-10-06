// Civilization materials.
//
// Architecture is drawn with ONE uber-material per settlement: a
// MeshStandardMaterial (so it gets the sun, sky light, three's shadows and any
// IBL) patched with procedural surfaces chosen per vertex (aMat.x):
// plaster, ashlar, brick, wood, lacquer, roof tiles (terracotta / temple barrel
// tiles / slate), concrete, metal panels, shell, glass, gold, bronze …
// Facades get procedural windows (aMat.z) laid out in facade space (aFac, meters)
// with frames, sills, shutters, flower boxes, doors — lit warm at dusk with
// per-window variation and box-filtered so distant cities do not shimmer.
//
// A city-scale sun shadow map (CityShadow) covers the whole settlement so long
// golden-hour shadows read from far away; the ground receives them through a
// multiplicative shadow catcher draped over the terrain.

import * as THREE from 'three';

export const CIV_COMMON_GLSL = /* glsl */`
uniform float uCivTime, uCivNight, uCivDay, uCivLitP, uCivWinI;
uniform vec3 uCivSkyZ, uCivSkyH, uCivUpV, uCivLamp, uCivSunL, uCivMoss, uCivSand, uCivAccent;
uniform sampler2D uCivShadow; uniform mat4 uCivShadowM; uniform vec4 uCivShadowP; uniform float uCivShadowOn;
uniform float uCivNearFade; uniform float uCivSnow; uniform vec3 uCivBounce;
varying vec2 vFac; varying vec4 vMat; varying vec4 vExt; varying vec3 vLoc; varying vec3 vLocN; varying float vCivDist;

float civH12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float civH13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 civH22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float civN2(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(civH12(i), civH12(i + vec2(1.0, 0.0)), u.x), mix(civH12(i + vec2(0.0, 1.0)), civH12(i + vec2(1.0, 1.0)), u.x), u.y); }
float civF2(vec2 p){ return (civN2(p) * 0.5 + civN2(p * 2.07 + 13.7) * 0.25 + civN2(p * 4.13 + 5.3) * 0.125) / 0.875; }
float civBox(vec2 p, vec2 hs, vec2 fw){ vec2 d = clamp((hs - abs(p)) / max(fw, vec2(1e-4)) + 0.5, 0.0, 1.0); return d.x * d.y; }
float civPulseI(float x, float w){ return floor(x) * w + min(fract(x), w); }
// Box-filtered coverage of lines of thickness 'width' every 'period' (line starts at multiples of period).
float civLines(float x, float period, float width, float fw){
  float xp = x / period, w = width / period, f = max(fw / period, 1e-4);
  return clamp((civPulseI(xp + 0.5 * f, w) - civPulseI(xp - 0.5 * f, w)) / f, 0.0, 1.0);
}
bool civFlag(float f, float bit){ return mod(floor(f / bit + 0.001), 2.0) > 0.5; }
float civUnpack(vec4 c){ return dot(c, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0)); }

// City-scale sun shadow (settlement-local position & normal).
float civShadowAt(vec3 lp, vec3 ln){
  if (uCivShadowOn < 0.5) return 1.0;
  float ndl = dot(ln, uCivSunL);
  if (ndl <= 0.0) return 1.0;
  vec3 sp = (uCivShadowM * vec4(lp + ln * uCivShadowP.x * 1.2, 1.0)).xyz;
  if (sp.x <= 0.0 || sp.y <= 0.0 || sp.x >= 1.0 || sp.y >= 1.0 || sp.z >= 1.0) return 1.0;
  float bias = uCivShadowP.y * (1.0 + 1.5 * min(sqrt(max(1.0 - ndl * ndl, 0.0)) / max(ndl, 0.05), 6.0));
  // 4x4-texel tent-filtered PCF (bilinear 3x3 kernel): soft, stair-free edges
  float t = uCivShadowP.z;
  vec2 tc = sp.xy / t - 0.5;
  vec2 b = floor(tc);
  float s = 0.0, ws = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 uv = (b + vec2(float(i) - 1.0, float(j) - 1.0) + 0.5) * t;
      vec2 dd = abs(b + vec2(float(i) - 1.0, float(j) - 1.0) - tc);
      float w = max(0.0, 1.5 - dd.x) * max(0.0, 1.5 - dd.y);
      s += w * step(sp.z - bias, civUnpack(texture2D(uCivShadow, uv)));
      ws += w;
    }
  }
  return s / max(ws, 1e-5);
}
`;

const BUILDING_FRAG = /* glsl */`
struct CivS { vec3 alb; float rough; float metal; float h; vec3 emit; float ao; float glass; };

vec3 civWinColor(float r){
  vec3 c = mix(vec3(1.0, 0.50, 0.20), vec3(1.0, 0.70, 0.42), r);
  c = mix(c, vec3(1.0, 0.84, 0.66), step(0.88, r));
  c = mix(c, vec3(0.78, 0.88, 1.0), step(0.975, r));
  return mix(c, uCivLamp, 0.3);
}
vec3 civShutter(float seed){
  float k = fract(seed * 31.7);
  vec3 c = vec3(0.10, 0.36, 0.34);                    // teal
  c = mix(c, vec3(0.16, 0.30, 0.12), step(0.25, k));  // green
  c = mix(c, vec3(0.10, 0.20, 0.38), step(0.45, k));  // blue
  c = mix(c, vec3(0.45, 0.10, 0.07), step(0.62, k));  // red
  c = mix(c, vec3(0.40, 0.27, 0.12), step(0.78, k));  // wood
  c = mix(c, vec3(0.62, 0.62, 0.55), step(0.92, k));  // grey-white
  return c;
}
float civInterior(vec2 p, vec2 hs, float r){
  vec2 q = p / max(hs, vec2(0.01));
  float g = 0.5 + 0.5 * smoothstep(-1.0, 0.9, q.y);
  float cur = smoothstep(0.5, 0.8, abs(q.x + (r - 0.5) * 0.7)) * step(0.35, r);
  g *= 1.0 - 0.6 * cur;
  float sil = step(0.7, civH12(vec2(floor(q.x * 2.2 + r * 13.0), 7.0))) * step(q.y, -0.25 + 0.5 * r);
  g *= 1.0 - 0.55 * sil;
  return g;
}

// ---------------------------------------------------------------- windows
void civWindows(inout CivS s, vec2 uv, vec2 fw, float fwm, vec3 wall){
  float style = vMat.z;
  if (style < 0.5) return;
  float flags = vExt.z;
  if (civFlag(flags, 4.0)) return;
  float W = vExt.y, H = vExt.w, seed = vMat.y;
  if (W < 1.3 || H < 1.8) return;
  int st = int(style + 0.5);
  bool gable = civFlag(flags, 2.0), front = civFlag(flags, 1.0), shop = civFlag(flags, 8.0);
  float F = max(vMat.w, 2.2);
  float nf = max(1.0, floor(H / F + 0.3));
  float Fh = H / nf;
  float litP = uCivLitP;
  vec3 frameC = vec3(0.86, 0.84, 0.78);
  vec3 glassC = vec3(0.03, 0.035, 0.04);

  if (uv.y > H - 0.02) {
    // gable: round attic window
    if (!gable || W < 4.5 || (st != 1 && st != 2)) return;
    vec2 p = vec2(uv.x, uv.y - H - 1.25);
    float r = 0.36;
    float d = length(p);
    float win = clamp((r - d) / max(fwm, 1e-4) + 0.5, 0.0, 1.0);
    float frm = clamp((r + 0.09 - d) / max(fwm, 1e-4) + 0.5, 0.0, 1.0) - win;
    float far = smoothstep(0.12, 0.4, fwm);
    float lit = step(civH12(vec2(seed * 91.0, W)), litP * 0.7);
    s.alb = mix(s.alb, frameC, frm * (1.0 - far));
    s.alb = mix(s.alb, glassC, win * (1.0 - far));
    s.glass = max(s.glass, win * (1.0 - far));
    s.emit += civWinColor(fract(seed * 7.0)) * lit * win * uCivWinI * 0.8 * (1.0 - far);
    s.h += (frm * 0.03 - win * 0.05) * (1.0 - far);
    return;
  }
  if (uv.y < 0.0) return;

  if (st == 1 || st == 8) {
    // ---- European house windows: frame, sill, lintel, shutters, flower boxes, door
    float B = 2.5 + 0.9 * fract(seed * 7.13);
    float nb = max(1.0, floor(W / B)); float Bw = W / nb;
    float xu = uv.x + W * 0.5;
    float bi = clamp(floor(xu / Bw), 0.0, nb - 1.0), fi = clamp(floor(uv.y / Fh), 0.0, nf - 1.0);
    vec2 c = vec2(xu - (bi + 0.5) * Bw, uv.y - fi * Fh);
    float r1 = civH13(vec3(bi, fi, seed * 97.0 + W * 1.7));
    float r2 = civH13(vec3(bi + 17.0, fi * 3.0 + 1.0, seed * 61.0));
    float ww = min(Bw * 0.2 + 0.2, 0.62), wh = min(Fh * 0.27, 0.8);
    vec2 wc = vec2(0.0, Fh * 0.55);
    bool door = front && fi < 0.5 && abs(bi - floor(nb * 0.5)) < 0.5;
    bool isShop = shop && fi < 0.5 && !door;
    if (door) { ww = 0.62; wh = 1.12; wc.y = 1.14; }
    else if (isShop) { ww = Bw * 0.38; wh = min(Fh * 0.33, 1.1); wc.y = Fh * 0.46; }
    vec2 p = c - wc;
    float far = smoothstep(ww * 0.3, ww * 1.1, fwm);
    float win = civBox(p, vec2(ww, wh), fw);
    float frm = civBox(p, vec2(ww + 0.08, wh + 0.08), fw) - win;
    float sill = door ? 0.0 : civBox(p - vec2(0.0, -wh - 0.11), vec2(ww + 0.15, 0.05), fw);
    float lint = civBox(p - vec2(0.0, wh + 0.13), vec2(ww + 0.12, 0.07), fw);
    float hasSh = step(fract(seed * 13.7), 0.62) * ((door || isShop) ? 0.0 : 1.0);
    vec2 sp = vec2(abs(p.x) - (ww + 0.1 + ww * 0.5), p.y);
    float shut = civBox(sp, vec2(ww * 0.5, wh), fw) * hasSh;
    float closed = step(r2, 0.14) * hasSh;
    vec3 shC = civShutter(seed);
    float slats = civLines(p.y, 0.09, 0.025, fw.y);
    vec3 shA = shC * (1.0 - 0.35 * slats * (1.0 - far));
    float mull = (civBox(p, vec2(0.022, wh), fw) + civBox(p - vec2(0.0, wh * 0.28), vec2(ww, 0.022), fw)) * win * (door ? 0.0 : 1.0);
    vec3 doorC = mix(vec3(0.20, 0.11, 0.06), shC * 0.9, step(0.5, fract(seed * 5.3)));
    float fb = step(r2, 0.55) * step(0.5, fi) * step(fract(seed * 3.3), 0.55) * (1.0 - closed) * (door ? 0.0 : 1.0);
    float fbox = civBox(p - vec2(0.0, -wh - 0.24), vec2(ww + 0.04, 0.1), fw) * fb;
    float fl = civBox(p - vec2(0.0, -wh - 0.06), vec2(ww + 0.02, 0.1), fw) * fb * step(0.42, civN2(c * 21.0 + seed * 9.0));
    vec3 flC = mix(vec3(0.75, 0.08, 0.10), vec3(0.95, 0.55, 0.65), step(0.5, fract(r2 * 9.0)));
    flC = mix(flC, vec3(0.95, 0.85, 0.2), step(0.8, fract(r2 * 9.0)));
    float streak = civBox(p - vec2(0.0, -wh - 0.75), vec2(ww * 0.75, 0.6), fw) * civN2(vec2(p.x * 9.0 + bi * 3.1, 0.5)) * (door ? 0.0 : 1.0);

    vec3 a = wall * (1.0 - 0.16 * streak);
    a = mix(a, frameC, frm);
    a = mix(a, frameC * 0.92, max(sill, lint) * 0.9);
    a = mix(a, shA, shut * (1.0 - closed * 0.0));
    a = mix(a, door ? doorC : glassC, win);
    a = mix(a, shA, win * closed);
    a = mix(a, frameC, mull * (1.0 - closed));
    a = mix(a, vec3(0.22, 0.13, 0.07), fbox);
    a = mix(a, flC, fl);
    float glass = win * (1.0 - closed) * (door ? 0.0 : 1.0) * (1.0 - mull);
    float lit = step(r1, litP) * (1.0 - closed) * (door ? 0.0 : 1.0);
    vec3 eD = civWinColor(fract(r1 * 7.31 + r2)) * civInterior(p, vec2(ww, wh), r2) * lit * glass;
    if (isShop) eD *= 1.4;
    float cov = clamp((4.0 * ww * wh) / (Bw * Fh), 0.0, 0.6);
    vec3 eA = civWinColor(0.4) * cov * litP * 0.8;
    vec3 aA = mix(wall, glassC, cov * 0.85);
    aA = mix(aA, shC, hasSh * cov * 0.7);
    s.alb = mix(a, aA, far);
    s.emit += mix(eD, eA, far) * uCivWinI;
    s.glass = max(s.glass, mix(glass, cov * 0.6, far));
    s.rough = mix(s.rough, 0.12, glass * (1.0 - far));
    s.h += (frm * 0.035 - win * 0.07 + sill * 0.06 + lint * 0.03 + shut * 0.02 + fbox * 0.08) * (1.0 - far);
    s.ao *= 1.0 - 0.3 * win * (1.0 - far) * (1.0 - closed);
  } else if (st == 9) {
    // ---- East-Asian screens: dark timber frames with lattice over warm paper, double doors
    float B = 2.6 + 0.8 * fract(seed * 5.7);
    float nb = max(1.0, floor(W / B)); float Bw = W / nb;
    float xu = uv.x + W * 0.5;
    float bi = clamp(floor(xu / Bw), 0.0, nb - 1.0), fi = clamp(floor(uv.y / Fh), 0.0, nf - 1.0);
    vec2 c = vec2(xu - (bi + 0.5) * Bw, uv.y - fi * Fh);
    float r1 = civH13(vec3(bi, fi, seed * 71.0 + W));
    bool door = front && fi < 0.5 && abs(bi - floor(nb * 0.5)) < 0.5;
    float has = door ? 1.0 : step(r1, 0.78);
    float ww = door ? 0.75 : min(Bw * 0.24 + 0.15, 0.7), wh = door ? 1.2 : min(Fh * 0.22, 0.62);
    vec2 wc = vec2(0.0, door ? 1.22 : Fh * 0.58);
    vec2 p = c - wc;
    float far = smoothstep(ww * 0.3, ww * 1.1, fwm);
    float win = civBox(p, vec2(ww, wh), fw) * has;
    float frm = (civBox(p, vec2(ww + 0.1, wh + 0.1), fw) - civBox(p, vec2(ww, wh), fw)) * has;
    vec2 lp = p * (door ? 1.0 : 1.0);
    float lat = max(civLines(lp.x + 0.5, 0.14, 0.025, fw.x), civLines(lp.y + 0.5, 0.14, 0.025, fw.y));
    if (door) lat = max(civBox(vec2(p.x, 0.0), vec2(0.03, 1e3), fw), civLines(p.y + 2.0, 0.6, 0.05, fw.y));
    vec3 woodC = vec3(0.10, 0.065, 0.04);
    vec3 paper = door ? vec3(0.16, 0.09, 0.05) : vec3(0.78, 0.7, 0.55);
    float lit = step(fract(r1 * 13.1), litP * 1.15) * (door ? 0.0 : 1.0);
    vec3 a = wall;
    a = mix(a, woodC, frm);
    a = mix(a, mix(paper, woodC, lat), win);
    float lintel = civBox(p - vec2(0.0, wh + 0.2), vec2(ww + 0.3, 0.08), fw) * has;
    a = mix(a, woodC * 1.4, lintel);
    float cov = clamp((4.0 * ww * wh) / (Bw * Fh), 0.0, 0.5) * 0.78;
    s.alb = mix(a, mix(wall, woodC, cov * 0.7), far);
    s.emit += mix(vec3(1.0, 0.6, 0.28) * win * (1.0 - lat) * lit * 0.7 * civInterior(p, vec2(ww, wh), r1), vec3(1.0, 0.6, 0.28) * cov * litP * 0.35, far) * uCivWinI;
    s.h += (frm * 0.03 - win * 0.04 + lintel * 0.04) * (1.0 - far);
    s.ao *= 1.0 - 0.25 * win * (1.0 - far);
  } else if (st == 2) {
    // ---- Gothic lancets with tracery and stained glass
    float B = 3.0 + 1.0 * fract(seed * 5.1);
    float nb = max(1.0, floor(W / B)); float Bw = W / nb;
    float xu = uv.x + W * 0.5;
    float bi = clamp(floor(xu / Bw), 0.0, nb - 1.0);
    bool tall = H > 11.0;
    float fi = tall ? 0.0 : clamp(floor(uv.y / Fh), 0.0, nf - 1.0);
    float y0 = tall ? 2.6 : fi * Fh + Fh * 0.22;
    float y1 = tall ? H - 2.2 : fi * Fh + Fh * 0.86;
    float ww = tall ? min(Bw * 0.3, 1.5) : min(Bw * 0.2 + 0.15, 0.55);
    float ys = y1 - ww * 1.732;
    vec2 q = vec2(xu - (bi + 0.5) * Bw, uv.y);
    float sdR = max(abs(q.x) - ww, max(y0 - q.y, q.y - ys));
    vec2 qa = vec2(q.x, q.y - ys);
    float sdA = max(max(length(qa + vec2(ww, 0.0)), length(qa - vec2(ww, 0.0))) - 2.0 * ww, -qa.y);
    float sd = min(sdR, sdA);
    float aa = max(fwm, 1e-4);
    float win = clamp(-sd / aa + 0.5, 0.0, 1.0);
    float frm = clamp((0.14 - sd) / aa + 0.5, 0.0, 1.0) - win;
    float far = smoothstep(ww * 0.25, ww * 1.0, fwm);
    float mull = civBox(vec2(q.x, 0.0), vec2(0.03, 1e3), fw) * win;
    float ocul = abs(length(vec2(q.x, q.y - (ys + ww * 0.8))) - ww * 0.45);
    float trac = clamp((0.03 - ocul) / aa + 0.5, 0.0, 1.0) * win * step(ys, q.y);
    float bars = civLines(q.y, 0.6, 0.03, fw.y) * win;
    float lead = max(max(mull, trac), bars);
    vec2 cell = floor(vec2(q.x * 3.0, q.y * 2.5));
    float hc = civH12(cell + seed * 11.0 + bi);
    vec3 jewel = mix(vec3(0.7, 0.08, 0.06), vec3(0.08, 0.2, 0.75), step(0.4, hc));
    jewel = mix(jewel, vec3(0.9, 0.65, 0.12), step(0.75, hc));
    jewel = mix(jewel, vec3(0.1, 0.5, 0.25), step(0.9, hc));
    float lit = step(civH12(vec2(bi, seed * 41.0)), max(litP * 1.2, 0.0));
    vec3 a = mix(wall, wall * 0.8, frm);
    a = mix(a, mix(glassC, jewel * 0.15, 0.6), win);
    a = mix(a, vec3(0.05), lead);
    vec3 eD = (tall ? jewel * 1.3 + 0.15 : civWinColor(hc)) * lit * win * (1.0 - lead) * civInterior(vec2(q.x, q.y - (y0 + y1) * 0.5), vec2(ww, (y1 - y0) * 0.5), hc);
    float cov = clamp(((y1 - y0) * 2.0 * ww) / (Bw * (tall ? H : Fh)), 0.0, 0.6);
    vec3 eA = (tall ? vec3(0.9, 0.45, 0.3) : civWinColor(0.4)) * cov * litP * 0.6;
    s.alb = mix(a, mix(wall, glassC, cov * 0.8), far);
    s.emit += mix(eD, eA, far) * uCivWinI;
    s.glass = max(s.glass, win * (1.0 - lead) * (1.0 - far) * 0.6);
    s.h += (-win * 0.12 - frm * 0.05) * (1.0 - far);
    s.ao *= 1.0 - 0.35 * frm * (1.0 - far);
  } else if (st == 3) {
    // ---- Temple lattice panels: wooden lattice over glowing paper, solid dado, stiles
    float B = 1.6 + 0.6 * fract(seed * 4.7);
    float nb = max(1.0, floor(W / B)); float Bw = W / nb;
    float xu = uv.x + W * 0.5;
    float bi = clamp(floor(xu / Bw), 0.0, nb - 1.0);
    float cx = xu - (bi + 0.5) * Bw;
    float y0 = 0.85, y1 = H - 0.5;
    float panel = civBox(vec2(cx, uv.y - (y0 + y1) * 0.5), vec2(Bw * 0.5 - 0.1, (y1 - y0) * 0.5), fw);
    float far = smoothstep(0.03, 0.12, fwm);
    float diag = step(0.5, fract(seed * 9.1));
    vec2 lu = diag > 0.5 ? vec2(uv.x + uv.y, uv.x - uv.y) * 0.7071 : uv;
    vec2 lfw = diag > 0.5 ? vec2(fwm) : fw;
    float lat = max(civLines(lu.x, 0.16, 0.025, lfw.x), civLines(lu.y, 0.16, 0.025, lfw.y));
    lat = mix(lat, 0.3, far);
    vec3 paper = vec3(0.86, 0.80, 0.64);
    vec3 wood = wall;
    float dado = civBox(vec2(cx, uv.y - y0 * 0.5), vec2(Bw * 0.5 - 0.1, y0 * 0.5 - 0.04), fw);
    float lit = step(civH12(vec2(bi, seed * 23.0 + W)), litP * 1.25 + 0.05);
    vec3 a = wood;
    a = mix(a, mix(paper, wood * 0.9, lat), panel);
    a = mix(a, wood * 0.7, dado * 0.6);
    s.alb = a;
    s.emit += vec3(1.0, 0.62, 0.3) * panel * (1.0 - lat) * lit * uCivWinI * 0.55 * mix(1.0, 0.7, far) * (0.7 + 0.3 * smoothstep(y0, y1, uv.y));
    s.h += (panel * (lat - 1.0) * 0.02 - dado * 0.01) * (1.0 - far);
    s.rough = mix(s.rough, 0.8, panel);
  } else if (st == 4) {
    // ---- Brutalist slits
    float B = 3.4 + 3.0 * fract(seed * 3.3);
    float nb = max(1.0, floor(W / B)); float Bw = W / nb;
    float xu = uv.x + W * 0.5;
    float bi = clamp(floor(xu / Bw), 0.0, nb - 1.0), fi = clamp(floor(uv.y / Fh), 0.0, nf - 1.0);
    vec2 c = vec2(xu - (bi + 0.5) * Bw, uv.y - fi * Fh);
    float r1 = civH13(vec3(bi, fi, seed * 53.0));
    float has = step(r1, 0.62);
    float sw = 0.16 + 0.1 * fract(seed * 17.0);
    float sl = civBox(c - vec2(0.0, Fh * 0.5), vec2(sw, Fh * 0.38), fw) * has;
    float band = civLines(uv.y + 0.2, Fh, 0.18, fw.y) * 0.6;
    float far = smoothstep(0.08, 0.3, fwm);
    float lit = step(fract(r1 * 13.7), litP * 0.75) * has;
    s.alb = mix(s.alb, s.alb * 0.45, band);
    s.alb = mix(s.alb, vec3(0.02), sl);
    s.emit += vec3(1.0, 0.55, 0.22) * mix(sl * lit * 1.4, (2.0 * sw * Fh * 0.76) / (Bw * Fh) * 0.62 * litP * 0.75 * 1.4, far) * uCivWinI;
    s.h += (-sl * 0.25 - band * 0.06) * (1.0 - far);
    s.ao *= 1.0 - 0.4 * sl;
  } else if (st == 5) {
    // ---- Office / neon tower grid
    float fi = clamp(floor(uv.y / Fh), 0.0, nf - 1.0);
    float cy = uv.y - fi * Fh;
    float band = civBox(vec2(0.0, cy - Fh * 0.56), vec2(1e4, Fh * 0.34), fw);
    float xu = uv.x + W * 0.5;
    float mull = civLines(xu + 0.04, 1.45, 0.08, fw.x);
    float room = floor(xu / 4.35);
    float r = civH13(vec3(room, fi, seed * 31.0));
    float lit = step(r, litP * 1.1);
    vec3 lc = civWinColor(fract(r * 5.7));
    lc = mix(lc, vec3(0.55, 0.9, 1.0), step(0.82, fract(r * 3.1)));
    lc = mix(lc, vec3(1.0, 0.45, 0.8), step(0.94, fract(r * 3.1)));
    float blinds = civLines(cy, 0.12, 0.04, fw.y) * step(0.6, fract(r * 9.0));
    float far = smoothstep(0.15, 0.5, fwm);
    float g = band * (1.0 - mull);
    s.alb = mix(s.alb, glassC * 1.5, band);
    s.alb = mix(s.alb, vec3(0.08), band * mull);
    s.glass = max(s.glass, g * 0.9);
    s.rough = mix(s.rough, 0.1, g);
    s.metal = mix(s.metal, 0.0, g);
    vec3 eD = lc * lit * g * (1.0 - 0.6 * blinds) * (0.6 + 0.4 * civN2(vec2(xu * 0.7, cy * 3.0)));
    vec3 eA = civWinColor(0.5) * 0.62 * 0.9 * litP;
    s.emit += mix(eD, eA, far) * uCivWinI;
    s.h += (-band * 0.05) * (1.0 - far);
  } else if (st == 6) {
    // ---- Portholes
    float B = 2.6 + 1.2 * fract(seed * 6.1);
    float nb = max(1.0, floor(W / B)); float Bw = W / nb;
    float xu = uv.x + W * 0.5;
    float bi = clamp(floor(xu / Bw), 0.0, nb - 1.0), fi = clamp(floor(uv.y / Fh), 0.0, nf - 1.0);
    vec2 c = vec2(xu - (bi + 0.5) * Bw, uv.y - fi * Fh - Fh * 0.55);
    float r1 = civH13(vec3(bi, fi, seed * 19.0));
    float rad = min(0.5, Bw * 0.2);
    float d = length(c);
    float aa = max(fwm, 1e-4);
    float win = clamp((rad - d) / aa + 0.5, 0.0, 1.0);
    float frm = clamp((rad + 0.1 - d) / aa + 0.5, 0.0, 1.0) - win;
    float far = smoothstep(rad * 0.3, rad * 1.2, fwm);
    float lit = step(r1, litP);
    vec3 lc = mix(civWinColor(r1), uCivAccent * 1.2 + 0.1, step(0.6, fract(seed * 2.9)));
    s.alb = mix(s.alb, s.alb * 0.6, frm * (1.0 - far));
    s.alb = mix(s.alb, glassC, win * (1.0 - far));
    s.glass = max(s.glass, win * (1.0 - far));
    float cov = 3.14159 * rad * rad / (Bw * Fh);
    s.emit += mix(lc * lit * win * (0.7 + 0.3 * smoothstep(-rad, rad, c.y)), lc * cov * litP, far) * uCivWinI;
    s.h += (frm * 0.05 - win * 0.06) * (1.0 - far);
  } else if (st == 7) {
    // ---- Outpost strip windows
    float fi = clamp(floor(uv.y / Fh), 0.0, nf - 1.0);
    float cy = uv.y - fi * Fh;
    float xu = uv.x + W * 0.5;
    float band = civBox(vec2(0.0, cy - 1.55), vec2(W * 0.5 - 0.6, 0.38), vec2(fw.y, fw.y)) * civBox(vec2(uv.x, 0.0), vec2(W * 0.5 - 0.5, 1.0), fw);
    float mull = civLines(xu + 0.04, 1.1, 0.08, fw.x);
    float frm = civBox(vec2(0.0, cy - 1.55), vec2(1e4, 0.48), fw) * civBox(vec2(uv.x, 0.0), vec2(W * 0.5 - 0.4, 1.0), fw) - band;
    float r = civH13(vec3(floor(xu / 3.3), fi, seed * 7.0));
    float lit = step(r, litP * 1.2 + 0.08);
    float far = smoothstep(0.15, 0.45, fwm);
    float g = band * (1.0 - mull);
    s.alb = mix(s.alb, vec3(0.12), frm);
    s.alb = mix(s.alb, glassC, band);
    s.glass = max(s.glass, g);
    s.rough = mix(s.rough, 0.1, g);
    vec3 lc = mix(vec3(0.85, 0.93, 1.0), civWinColor(r), 0.35);
    s.emit += mix(lc * lit * g, lc * 0.2 * litP, far) * uCivWinI;
    s.h += (frm * 0.03 - band * 0.05) * (1.0 - far);
  }
}

// ---------------------------------------------------------------- macro weathering
// Ages every building: per-building value/hue jitter, metre-scale mottling in
// settlement space, rain/soot streaks hanging from the eaves, a damp or sandy
// ground-contact band with contact occlusion, and per-window light variance.
void civWeather(inout CivS s, int id, float seed, vec2 uv, float fwm, float up, float H, bool roof, bool wallLike){
  if (id == 7 || id == 9 || id == 14 || id == 15 || id == 23 || id == 26 || id == 29 || id == 19) return;
  float hb = fract(seed * 113.7 + 0.31);
  float hb2 = fract(seed * 71.3 + 0.77);
  // per-building value (+-14%) and a slight warm/cool cast
  s.alb *= (0.86 + 0.28 * hb) * mix(vec3(0.97, 0.99, 1.03), vec3(1.04, 1.0, 0.94), hb2);
  // metre-scale mottling in settlement space (breaks up identical walls across the town)
  float m1 = civF2(vLoc.xz * 0.045 + vLoc.y * 0.03 + 7.1);
  float m2 = civN2(vLoc.xz * 0.21 + vLoc.y * 0.17);
  s.alb *= 0.84 + 0.24 * m1 + 0.08 * m2;
  if (wallLike) {
    float far = smoothstep(0.08, 0.5, fwm);
    // rain / soot streaks under the eaves and sills
    // sparse clusters of run-off (metres wide) with fine drip texture inside: never a plank-like comb
    float sx = uv.x + seed * 37.0;
    float cluster = smoothstep(0.55, 0.85, civN2(vec2(sx * 0.32, uv.y * 0.012 + seed)));
    float drip = civN2(vec2(sx * 2.7, uv.y * 0.06)) * 0.6 + civN2(vec2(sx * 7.3, uv.y * 0.11)) * 0.4;
    float st = cluster * mix(0.55, 1.0, mix(drip, 0.5, far));
    float fromTop = clamp((H - uv.y) / max(H, 1.0), 0.0, 1.0);
    float streak = st * (1.0 - smoothstep(0.0, 0.85, fromTop) * 0.6) * step(uv.y, H);
    float k = id == 6 ? 0.42 : (id == 17 ? 0.22 : 0.3);
    s.alb *= 1.0 - k * streak * mix(1.0, 0.6, far);
    s.rough = mix(s.rough, s.rough * 0.85, streak * 0.4);
    // ground-contact band: damp/moss in green worlds, sand drift in deserts
    float bandH = 0.9 + 1.4 * civN2(vec2(uv.x * 0.35 + seed * 9.0, 3.0));
    float band = (1.0 - smoothstep(0.0, bandH, uv.y)) * step(-0.5, uv.y);
    vec3 bandC = (id == 6 || id == 17) ? uCivSand * 0.82 : s.alb * mix(vec3(0.5, 0.48, 0.42), uCivMoss * 1.4, 0.35 * (1.0 - uCivSnow));
    s.alb = mix(s.alb, bandC, band * (id == 6 || id == 17 ? 0.7 : 0.5));
    // contact occlusion at the wall foot (alley/ground junction)
    s.ao *= mix(0.42, 1.0, smoothstep(0.0, 2.6, uv.y + 0.2));
    // edge darkening near the top (parapet run-off)
    s.alb *= 1.0 - 0.12 * (1.0 - smoothstep(0.0, 0.7, H - uv.y)) * step(uv.y, H);
    // per-window light variance: some brighter, some dim, a few cool; lanterns breathe
    // (only where single windows resolve: at range the window shaders emit a facade average,
    //  and a per-cell gain there turns whole walls into an emissive checkerboard)
    float wc = civH12(floor(vec2(uv.x / 2.7, uv.y / 3.1)) + seed * 17.0);
    float wNear = 1.0 - smoothstep(0.03, 0.09, fwm);
    float gain = mix(1.0, 0.35 + 2.2 * wc * wc, wNear);
    vec3 tint = mix(vec3(1.0), vec3(0.75, 0.85, 1.15), step(0.94, fract(wc * 13.7)) * wNear);
    float flick = 1.0 + 0.12 * sin(uCivTime * (2.0 + 5.0 * wc) + wc * 40.0) * step(0.8, fract(wc * 7.3));
    s.emit *= gain * tint * flick;
  }
  if (roof || id == 4 || id == 11 || id == 12) {
    // roofs: sun-bleached patches and dark dirt lines in the valleys
    float b = civF2(vLoc.xz * 0.12 + seed * 3.0);
    s.alb *= 0.82 + 0.3 * b;
  }
}

// ---------------------------------------------------------------- base surfaces
CivS civSurface(){
  CivS s;
  s.alb = vColor.rgb; s.rough = 0.88; s.metal = 0.0; s.h = 0.0; s.emit = vec3(0.0); s.ao = vExt.x; s.glass = 0.0;
  int id = int(vMat.x + 0.5);
  float seed = vMat.y;
  vec2 uv = vFac;
  vec2 fw = fwidth(uv);
  float fwm = max(max(fw.x, fw.y), 1e-5);
  float up = clamp(normalize(vLocN).y, -1.0, 1.0);
  float H = vExt.w;
  bool roof = civFlag(vExt.z, 32.0);
  bool wallLike = false;

  if (id == 0 || id == 17) {
    // plaster / adobe
    float n1 = civF2(uv * vec2(0.3, 0.45) + seed * 17.0);
    float n2 = civN2(uv * 3.1 + seed * 5.0);
    s.alb *= 0.9 + 0.16 * n1 + 0.04 * n2 * (1.0 - smoothstep(0.02, 0.1, fwm));
    float streak = civN2(vec2(uv.x * 1.4 + seed * 31.0, uv.y * 0.07));
    s.alb *= 1.0 - 0.12 * smoothstep(0.55, 0.95, streak) * smoothstep(0.0, 3.0, H - uv.y);
    float grime = 1.0 - smoothstep(0.0, 1.4 + 0.9 * n1, uv.y);
    s.alb = mix(s.alb, s.alb * vec3(0.62, 0.57, 0.5), grime * 0.55);
    float eave = smoothstep(H - 1.0, H, uv.y) * step(uv.y, H + 0.01);
    s.alb *= 1.0 - 0.18 * eave;
    s.h = (n1 * 0.008 + n2 * 0.002) * (1.0 - smoothstep(0.02, 0.1, fwm));
    s.rough = 0.93;
    if (id == 17) { s.alb *= 0.96 + 0.08 * civN2(uv * 9.0); s.h += civN2(uv * 2.0) * 0.02; }
    wallLike = true;
  } else if (id == 1 || id == 28 || id == 25) {
    // ashlar stone (28 = mossy ruin stone, 25 = marble)
    float rh = 0.4 + 0.22 * fract(seed * 7.3);
    float row = floor(uv.y / rh);
    float bl = rh * (1.6 + 1.2 * fract(seed * 3.1));
    float off = civH12(vec2(row, seed * 13.0)) * bl;
    float col = floor((uv.x + off) / bl);
    float hb = civH12(vec2(row, col) + seed * 7.0);
    float far = smoothstep(0.04, 0.16, fwm);
    s.alb *= mix(0.8 + 0.34 * hb, 0.97, far);
    float mw = 0.03;
    float mort = max(civLines(uv.x + off + mw * 0.5, bl, mw, fw.x), civLines(uv.y + mw * 0.5, rh, mw, fw.y));
    s.alb = mix(s.alb, s.alb * 0.58, mort * 0.85);
    float wn = civF2(uv * 0.35 + seed * 3.0);
    s.alb *= 0.86 + 0.24 * wn;
    float grime = 1.0 - smoothstep(0.0, 1.2 + wn, uv.y);
    s.alb = mix(s.alb, s.alb * vec3(0.6, 0.6, 0.52), grime * 0.45);
    s.h = ((1.0 - mort) * 0.025 + (civN2(uv * 4.0 + hb * 7.0) - 0.5) * 0.012) * (1.0 - far);
    s.rough = 0.9;
    if (id == 25) { s.rough = 0.45; s.alb *= 1.05; }
    if (id == 28 || up > 0.55) {
      float moss = smoothstep(0.45, 0.75, civF2(uv * 0.6 + seed * 9.0) + up * 0.35 - (id == 28 ? 0.0 : 0.25));
      s.alb = mix(s.alb, uCivMoss * (0.7 + 0.4 * civN2(uv * 5.0)), moss * 0.85);
    }
    wallLike = true;
  } else if (id == 2) {
    // brick
    float rh = 0.075, bl = 0.24;
    float row = floor(uv.y / rh);
    float off = mod(row, 2.0) * bl * 0.5;
    float col = floor((uv.x + off) / bl);
    float hb = civH12(vec2(row, col) + seed * 3.0);
    float far = smoothstep(0.015, 0.06, fwm);
    s.alb *= mix(0.72 + 0.45 * hb, 0.95, far);
    float mort = max(civLines(uv.x + off + 0.006, bl, 0.012, fw.x), civLines(uv.y + 0.006, rh, 0.012, fw.y));
    s.alb = mix(s.alb, vec3(0.42, 0.4, 0.36), mort * 0.8);
    s.alb *= 0.88 + 0.2 * civF2(uv * 0.4 + seed);
    s.h = (1.0 - mort) * 0.01 * (1.0 - far);
    s.rough = 0.88;
    wallLike = true;
  } else if (id == 3 || id == 10) {
    // wood planks / lacquered wood
    bool lac = id == 10;
    float pw = 0.19;
    float vert = step(0.5, fract(seed * 3.7));
    float x = vert > 0.5 ? uv.x : uv.y;
    float y = vert > 0.5 ? uv.y : uv.x;
    float fx = vert > 0.5 ? fw.x : fw.y;
    float pl = floor(x / pw);
    float far = smoothstep(0.02, 0.08, fwm);
    float gr = civN2(vec2(x * 22.0 + pl * 3.0, y * 0.9 + pl));
    float hp = civH12(vec2(pl, seed * 11.0));
    float seam = civLines(x + 0.006, pw, 0.012, fx);
    if (lac) {
      s.alb *= 0.9 + 0.12 * civF2(uv * vec2(0.6, 0.2) + seed);
      float wear = smoothstep(0.62, 0.85, civF2(uv * 1.7 + seed * 3.0));
      s.alb = mix(s.alb, vec3(0.18, 0.1, 0.06), wear * 0.45);
      s.rough = 0.42 + 0.3 * wear;
      s.h = (gr - 0.5) * 0.002;
    } else {
      s.alb *= mix(0.78 + 0.3 * hp, 0.92, far) * (0.9 + 0.15 * gr);
      s.alb = mix(s.alb, s.alb * 0.45, seam * 0.7);
      s.h = ((1.0 - seam) * 0.008 + gr * 0.002) * (1.0 - far);
      s.rough = 0.82;
    }
    float grime = 1.0 - smoothstep(0.0, 1.0, uv.y);
    s.alb *= 1.0 - 0.25 * grime * step(0.0, uv.y);
    wallLike = true;
  } else if (id == 4 || id == 12) {
    // terracotta tiles (4) / slate (12): rows along the slope (v from the eave)
    bool slate = id == 12;
    float tw = slate ? 0.3 : 0.24, th = slate ? 0.2 : 0.28;
    float row = floor(uv.y / th);
    float x = uv.x / tw + mod(row, 2.0) * 0.5;
    float ti = floor(x), tx = fract(x);
    float ht = civH12(vec2(ti, row) + seed * 9.0);
    float far = smoothstep(0.03, 0.14, fwm);
    float farR = smoothstep(0.05, 0.25, fw.y);
    s.alb *= mix(0.74 + 0.48 * ht, 0.97, far);
    float rv = fract(uv.y / th);
    float prof = slate ? 0.0 : sin(tx * 3.14159);
    float gap = slate ? civLines(uv.x + mod(row, 2.0) * tw * 0.5 + 0.01, tw, 0.02, fw.x) : 0.0;
    float lip = mix(1.0 - 0.45 * smoothstep(0.62, 1.0, rv), 0.86, farR);
    s.ao *= lip;
    s.alb *= 1.0 - gap * 0.5 * (1.0 - far);
    s.h = (prof * 0.035 + (1.0 - rv) * 0.025) * (1.0 - far) + (1.0 - rv) * 0.02 * (1.0 - farR);
    float L = H;
    float moss = smoothstep(0.55, 0.85, civF2(uv * 0.45 + seed * 4.0) + 0.25 * (1.0 - smoothstep(0.0, L * 0.6 + 0.1, uv.y)));
    s.alb = mix(s.alb, uCivMoss * (0.7 + 0.5 * civN2(uv * 6.0)), moss * 0.55);
    float streak = civN2(vec2(uv.x * 2.3 + seed * 5.0, uv.y * 0.18));
    s.alb *= 1.0 - 0.18 * smoothstep(0.55, 0.9, streak);
    s.rough = slate ? 0.62 : 0.78;
  } else if (id == 11) {
    // temple barrel tiles
    float P = 0.36;
    float xr = fract(uv.x / P) - 0.5;
    float far = smoothstep(0.03, 0.14, fwm);
    float ax = abs(xr) / 0.3;
    float barrel = clamp((0.3 - abs(xr)) * P / max(fw.x, 1e-4) + 0.5, 0.0, 1.0);
    float prof = sqrt(max(0.0, 1.0 - ax * ax));
    float seg = fract(uv.y / 0.38);
    float hb = civH12(vec2(floor(uv.x / P), floor(uv.y / 0.38)) + seed);
    vec3 base = s.alb * (0.92 + 0.16 * hb * (1.0 - far));
    s.alb = mix(base * 0.5, base * mix(0.85, 1.12, prof), mix(barrel, 0.62, far));
    s.ao *= mix(0.72 + 0.28 * barrel, 0.88, far) * mix(1.0 - 0.25 * smoothstep(0.85, 1.0, seg), 1.0, far);
    s.h = (barrel * prof * 0.06 + (1.0 - seg) * 0.01) * (1.0 - far);
    float cap = step(uv.y, 0.22) * barrel;
    s.alb = mix(s.alb, base * 1.15, cap * (1.0 - far));
    float moss = smoothstep(0.6, 0.85, civF2(uv * 0.5 + seed * 2.0));
    s.alb = mix(s.alb, uCivMoss * 0.8, moss * 0.4);
    s.rough = 0.55;
  } else if (id == 5 || id == 27) {
    // painted metal panels (27 = rust)
    float pw = 1.4 + 1.4 * fract(seed * 5.0), ph = 1.0 + 1.0 * fract(seed * 11.0);
    float far = smoothstep(0.04, 0.15, fwm);
    float seams = max(civLines(uv.x + 0.012, pw, 0.024, fw.x), civLines(uv.y + 0.012, ph, 0.024, fw.y));
    float cell = civH12(floor(vec2(uv.x / pw, uv.y / ph)) + seed * 3.0);
    s.alb *= mix(0.9 + 0.16 * cell, 1.0, far);
    s.alb = mix(s.alb, s.alb * 0.35, seams * 0.8);
    float sy = 1.0 + floor(fract(seed * 7.7) * 3.0) * 1.1;
    float stripe = civBox(vec2(0.0, uv.y - sy), vec2(1e4, 0.16), fw) * step(0.35, fract(seed * 2.3));
    s.alb = mix(s.alb, uCivAccent, stripe);
    float dirt = (1.0 - smoothstep(0.0, 1.6, uv.y)) * 0.5 + smoothstep(0.6, 0.95, civN2(vec2(uv.x * 1.7, uv.y * 0.12) + seed)) * 0.25;
    s.alb *= 1.0 - dirt * 0.5;
    s.h = (1.0 - seams) * 0.008 * (1.0 - far);
    s.rough = 0.45; s.metal = 0.1;
    if (id == 27) {
      float rust = smoothstep(0.35, 0.8, civF2(uv * 0.5 + seed) + (1.0 - smoothstep(0.0, 4.0, uv.y)) * 0.3);
      s.alb = mix(s.alb, vec3(0.32, 0.12, 0.05) * (0.7 + 0.6 * civN2(uv * 7.0)), rust);
      s.rough = mix(0.45, 0.9, rust);
    }
    wallLike = true;
  } else if (id == 6) {
    // board-formed concrete, sand-scoured
    float far = smoothstep(0.05, 0.2, fwm);
    float fx = civLines(uv.x + 0.006, 2.4, 0.012, fw.x), fy = civLines(uv.y + 0.006, 1.2, 0.012, fw.y);
    float seams = max(fx, fy) * 0.55;
    vec2 tc = fract(vec2(uv.x / 0.6, uv.y / 0.6)) - 0.5;
    float tie = (1.0 - smoothstep(0.03, 0.06, length(tc * 0.6))) * (1.0 - far);
    float big = civF2(uv * 0.06 + seed * 3.0);
    float streak = civN2(vec2(uv.x * 0.21 + seed * 7.0, uv.y * 0.02)) * (0.7 + 0.3 * civN2(vec2(uv.x * 3.3, uv.y * 0.07)));
    // wind-scoured horizontal strata: pale sand-blasted bands and darker sheltered lifts
    float strata = civN2(vec2(uv.x * 0.015 + seed, uv.y * 0.32));
    float lift = civLines(uv.y + 0.03, 6.0, 0.06, fw.y);
    s.alb *= 0.8 + 0.3 * big - 0.16 * smoothstep(0.55, 0.9, streak) + 0.12 * (strata - 0.5);
    s.alb *= 1.0 - 0.35 * lift;
    s.alb = mix(s.alb, s.alb * 0.6, seams + tie * 0.5);
    float sand = 1.0 - smoothstep(0.0, 2.0 + 3.0 * civN2(vec2(uv.x * 0.12, seed)), uv.y);
    s.alb = mix(s.alb, uCivSand, sand * 0.65);
    if (up > 0.6) s.alb = mix(s.alb, uCivSand, smoothstep(0.4, 0.8, civF2(uv * 0.2 + seed)) * 0.6);
    s.h = ((1.0 - seams) * 0.004 - tie * 0.02) * (1.0 - far) + big * 0.01;
    s.rough = 0.95;
    wallLike = true;
  } else if (id == 7) {
    s.alb = vec3(0.04, 0.045, 0.05); s.rough = 0.07; s.glass = 1.0;
  } else if (id == 8) {
    // organic shell: veins, iridescence, bioluminescent freckles
    float vein = 1.0 - smoothstep(0.0, 0.05, abs(civF2(uv * 0.35 + seed * 5.0) - 0.5));
    float far = smoothstep(0.05, 0.25, fwm);
    s.alb *= 1.0 - 0.18 * vein * (1.0 - far);
    float ndv = abs(dot(normalize(vNormal), normalize(vViewPosition)));
    vec3 irid = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + (1.0 - ndv) * 0.8 + seed));
    s.alb = mix(s.alb, s.alb * (0.6 + 0.8 * irid), (1.0 - ndv) * 0.35);
    s.rough = 0.32;
    s.h = vein * 0.01 * (1.0 - far);
    vec2 fc = fract(uv * 1.3) - 0.5;
    float fr = (1.0 - smoothstep(0.04, 0.1, length(fc))) * step(0.72, civH12(floor(uv * 1.3) + seed * 13.0)) * (1.0 - far);
    s.emit += uCivAccent * fr * uCivNight * 2.2;
    wallLike = true;
  } else if (id == 9 || id == 26) {
    // neon signage (9) / hologram (26)
    vec2 g = uv * vec2(2.2, 2.2);
    vec2 ci = floor(g); vec2 cf = fract(g) - 0.5;
    float hh = civH12(ci + seed * 9.0);
    float seg = step(abs(cf.x), 0.32) * step(abs(cf.y), 0.36) * step(0.35, civH12(floor((cf + 0.5) * 3.0) + ci * 7.0));
    float fl = 0.85 + 0.15 * sin(uCivTime * (13.0 + hh * 20.0) + hh * 40.0);
    s.alb = vec3(0.03);
    s.emit += vColor.rgb * (0.25 + seg * 2.8) * fl * (0.35 + 0.65 * uCivNight) * 2.2;
    s.rough = 0.3;
  } else if (id == 14 || id == 23) {
    // emissive bodies (lamps, lantern paper)
    s.alb = vColor.rgb * 0.6;
    float paperRibs = id == 23 ? civLines(uv.y, 0.12, 0.02, fw.y) : 0.0;
    s.emit += vColor.rgb * (1.0 - 0.6 * paperRibs) * (0.06 + uCivNight) * 4.0 * (id == 23 ? 0.6 : 1.0);
    s.rough = 0.6;
  } else if (id == 15) {
    s.alb = vec3(1.0, 0.74, 0.32) * (0.85 + 0.2 * civF2(uv * 2.0 + seed)); s.metal = 1.0; s.rough = 0.28;
  } else if (id == 16) {
    float verd = smoothstep(0.45, 0.8, civF2(uv * 0.5 + seed) + up * 0.3);
    s.alb = mix(vec3(0.42, 0.26, 0.13), vec3(0.22, 0.5, 0.42), verd);
    s.metal = mix(0.9, 0.1, verd); s.rough = mix(0.4, 0.85, verd);
  } else if (id == 18) {
    // solar panels
    float far = smoothstep(0.03, 0.12, fwm);
    float grid = max(civLines(uv.x, 0.6, 0.03, fw.x), civLines(uv.y, 0.6, 0.03, fw.y));
    s.alb = mix(vec3(0.02, 0.04, 0.1), vec3(0.6), mix(grid, 0.12, far));
    s.rough = 0.18; s.metal = 0.3; s.glass = 0.5;
  } else if (id == 19) {
    s.alb = vec3(0.006); s.rough = 0.12; s.glass = 0.35;
  } else if (id == 20) {
    // floating island rock: strata
    float st = civN2(vec2(uv.x * 0.05, uv.y * 0.45 + seed));
    float n = civF2(uv * 0.12 + seed * 3.0);
    s.alb *= 0.72 + 0.42 * n;
    s.alb = mix(s.alb, s.alb * 0.62, smoothstep(0.55, 0.75, st));
    float moss = smoothstep(0.4, 0.75, up * 0.8 + civF2(uv * 0.3) * 0.5);
    s.alb = mix(s.alb, uCivMoss, moss * 0.8);
    s.h = n * 0.3 + st * 0.15;
    s.rough = 0.95;
  } else if (id == 21 || id == 22) {
    // grass tops / foliage masses
    float n = civF2(uv * (id == 21 ? 0.25 : 0.6) + seed * 3.0);
    s.alb *= 0.7 + 0.5 * n;
    s.h = n * (id == 21 ? 0.1 : 0.4);
    s.rough = 0.9;
    if (id == 22) {
      // leaf clumps: dark gaps between sunlit tufts, cooler deep inside, lighter tips on top
      float far = smoothstep(0.08, 0.4, fwm);
      float cl = civN2(uv * 2.6 + seed * 11.0) * 0.6 + civN2(uv * 6.3 + seed * 5.0) * 0.4;
      float gap = smoothstep(0.5, 0.25, cl) * (1.0 - far);
      s.alb *= mix(1.0, 0.45, gap);
      s.ao *= mix(1.0, 0.55, gap) * (0.75 + 0.25 * clamp(up * 0.5 + 0.5, 0.0, 1.0));
      s.alb *= mix(vec3(0.8, 0.9, 1.0), vec3(1.12, 1.08, 0.9), clamp(up * 0.5 + 0.5, 0.0, 1.0));
      s.h += cl * 0.25 * (1.0 - far);
    }
  } else if (id == 13) {
    // cloth banners: woven + emblem
    float weave = civLines(uv.x * 7.0, 1.0, 0.5, fw.x * 7.0) * 0.5 + civLines(uv.y * 7.0, 1.0, 0.5, fw.y * 7.0) * 0.5;
    s.alb *= 0.9 + 0.1 * weave;
    float W2 = vExt.y;
    vec2 ec = vec2(uv.x - W2 * 0.5, uv.y - vExt.w * 0.6);
    float em = abs(length(ec) - min(W2, vExt.w) * 0.22);
    float emb = clamp((0.06 - em) / max(fwm, 1e-4) + 0.5, 0.0, 1.0);
    float dia = clamp((min(W2, vExt.w) * 0.12 - (abs(ec.x) + abs(ec.y))) / max(fwm, 1e-4) + 0.5, 0.0, 1.0);
    s.alb = mix(s.alb, vec3(0.85, 0.7, 0.3), max(emb, dia) * step(0.3, fract(seed * 3.0)));
    float hem = civBox(vec2(0.0, uv.y - 0.06), vec2(1e3, 0.05), fw);
    s.alb = mix(s.alb, s.alb * 0.6, hem);
    s.rough = 0.95;
  } else if (id == 24) {
    s.alb = vec3(0.05, 0.05, 0.055) * (0.8 + 0.4 * civN2(uv * 3.0)); s.metal = 0.7; s.rough = 0.55;
  } else if (id == 29) {
    // falling water
    float n = civN2(vec2(uv.x * 3.0, uv.y * 0.6 + uCivTime * 2.5));
    s.alb = vec3(0.75, 0.82, 0.85) * (0.6 + 0.4 * n);
    s.rough = 0.3;
    s.emit += vec3(0.6, 0.7, 0.75) * n * 0.08 * uCivDay;
  }

  if (wallLike) civWindows(s, uv, fw, fwm, s.alb);
  civWeather(s, id, seed, uv, fwm, up, H, roof, wallLike);
  // snow settles on up-facing surfaces (ice worlds)
  if (uCivSnow > 0.0 && id != 14 && id != 9 && id != 26 && id != 23) {
    float sn = smoothstep(0.3, 0.7, up + (civF2(vLoc.xz * 0.35) - 0.5) * 0.5) * uCivSnow;
    s.alb = mix(s.alb, vec3(0.86, 0.9, 0.96), sn); s.rough = mix(s.rough, 0.7, sn); s.metal *= 1.0 - sn; s.glass *= 1.0 - sn;
  }
  return s;
}
`;

const GROUND_FRAG = /* glsl */`
struct CivS { vec3 alb; float rough; float metal; float h; vec3 emit; float ao; float glass; };
CivS civSurface(){
  CivS s;
  s.alb = vColor.rgb; s.rough = 0.9; s.metal = 0.0; s.h = 0.0; s.emit = vec3(0.0); s.ao = vExt.x; s.glass = 0.0;
  int id = int(vMat.x + 0.5);
  vec2 p = vFac;
  vec2 fw = fwidth(p);
  float fwm = max(max(fw.x, fw.y), 1e-5);
  float seed = vMat.y, edge = vMat.z;
  if (id == 0 || id == 9) {
    // cobbles (Voronoi setts)
    float sc = id == 9 ? 0.55 : 0.3;
    vec2 g = p / sc;
    vec2 i = floor(g), f = fract(g);
    float d1 = 8.0, d2 = 8.0; vec2 cid = vec2(0.0);
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 b = vec2(float(x), float(y));
      vec2 o = b + 0.2 + 0.6 * civH22(i + b) - f;
      float d = dot(o, o);
      if (d < d1) { d2 = d1; d1 = d; cid = i + b; } else if (d < d2) { d2 = d; }
    }
    float gap = sqrt(d2) - sqrt(d1);
    float far = smoothstep(0.03, 0.12, fwm / sc * 0.3);
    float stone = smoothstep(0.03, 0.18, gap);
    float hv = civH12(cid + seed * 3.0);
    vec3 st = vColor.rgb * (0.68 + 0.55 * hv);
    s.alb = mix(mix(vColor.rgb * 0.45, st, stone), vColor.rgb * 0.88, far);
    s.h = sqrt(stone) * 0.03 * (1.0 - far);
    s.rough = mix(0.95, 0.72, stone * (1.0 - far));
  } else if (id == 1 || id == 5) {
    // flagstones (1) / big sandstone pavers (5)
    vec2 sz = id == 5 ? vec2(2.4, 1.6) : vec2(1.1, 0.7);
    float row = floor(p.y / sz.y);
    float off = civH12(vec2(row, seed)) * sz.x;
    vec2 cell = vec2(floor((p.x + off) / sz.x), row);
    float hv = civH12(cell + seed * 5.0);
    float far = smoothstep(0.04, 0.2, fwm);
    float j = max(civLines(p.x + off + 0.015, sz.x, 0.03, fw.x), civLines(p.y + 0.015, sz.y, 0.03, fw.y));
    s.alb *= mix(0.78 + 0.4 * hv, 0.96, far);
    s.alb = mix(s.alb, s.alb * 0.45, j * 0.8);
    s.h = (1.0 - j) * 0.012 * (1.0 - far) + civN2(p * 3.0) * 0.004;
    s.rough = 0.8;
    if (id == 5) {
      float drift = smoothstep(0.45, 0.75, civF2(p * 0.08 + seed));
      s.alb = mix(s.alb, uCivSand, drift * 0.8);
    }
  } else if (id == 2 || id == 6 || id == 8) {
    // packed dirt (2) / gravel (6) / tilled field (8)
    float n = civF2(p * 0.6 + seed * 7.0);
    float fine = civN2(p * 9.0);
    s.alb *= 0.78 + 0.32 * n + 0.08 * fine * (1.0 - smoothstep(0.02, 0.08, fwm));
    if (id == 6) s.alb *= 0.85 + 0.3 * civH12(floor(p * 18.0));
    if (id == 8) {
      float furrow = 0.5 + 0.5 * sin(p.x * 6.2831 / 0.9);
      s.alb *= mix(0.75 + 0.35 * furrow, 0.92, smoothstep(0.08, 0.3, fwm));
      s.h = furrow * 0.05 * (1.0 - smoothstep(0.08, 0.3, fwm));
    }
    float rut = smoothstep(0.35, 0.0, abs(abs(edge * 2.0 - 1.0) - 0.45)) * 0.18;
    s.alb *= 1.0 - rut * step(float(id), 2.5);
    s.h += n * 0.03;
    s.rough = 0.97;
  } else if (id == 3) {
    // planks (docks / boardwalks) along p.y
    float pl = floor(p.x / 0.24);
    float far = smoothstep(0.03, 0.1, fwm);
    float gr = civN2(vec2(p.x * 20.0, p.y * 0.8 + pl * 3.0));
    float seam = civLines(p.x + 0.01, 0.24, 0.02, fw.x);
    s.alb *= mix(0.75 + 0.35 * civH12(vec2(pl, seed)), 0.9, far) * (0.9 + 0.15 * gr);
    s.alb = mix(s.alb, s.alb * 0.3, seam * 0.9);
    s.h = (1.0 - seam) * 0.01 * (1.0 - far);
    s.rough = 0.85;
  } else if (id == 4 || id == 7) {
    // landing pad / metal deck: panel seams + painted markings (uv = pad-local for pads)
    float far = smoothstep(0.04, 0.15, fwm);
    float seams = max(civLines(p.x + 0.02, 3.0, 0.04, fw.x), civLines(p.y + 0.02, 3.0, 0.04, fw.y));
    s.alb *= 0.88 + 0.16 * civH12(floor(p / 3.0) + seed);
    s.alb = mix(s.alb, s.alb * 0.5, seams * 0.7);
    if (id == 4) {
      float R = max(vExt.y, 4.0);
      float r = length(p);
      float ring = clamp((0.35 - abs(r - R * 0.72)) / max(fwm, 1e-4) + 0.5, 0.0, 1.0);
      float ring2 = clamp((0.2 - abs(r - R * 0.92)) / max(fwm, 1e-4) + 0.5, 0.0, 1.0);
      float hb = max(civBox(p - vec2(R * 0.18, 0.0), vec2(0.4, R * 0.3), fw), civBox(p + vec2(R * 0.18, 0.0), vec2(0.4, R * 0.3), fw));
      hb = max(hb, civBox(p, vec2(R * 0.18, 0.4), fw));
      float hz = civBox(vec2(r - R * 0.97, 0.0), vec2(R * 0.03, 1.0), fw) * step(0.5, fract(atan(p.y, p.x) * 6.0));
      vec3 paint = mix(vec3(0.85, 0.85, 0.8), uCivAccent, 0.3);
      s.alb = mix(s.alb, paint, max(max(ring, ring2), hb) * 0.9);
      s.alb = mix(s.alb, vec3(0.9, 0.7, 0.1), hz);
      float lights = (1.0 - smoothstep(0.1, 0.25, length(vec2(r - R * 0.985, 0.0)))) * step(0.85, fract(atan(p.y, p.x) * 24.0 / 6.2831));
      s.emit += vec3(1.0, 0.75, 0.4) * lights * (0.3 + uCivNight) * 4.0;
    }
    s.h = (1.0 - seams) * 0.005 * (1.0 - far);
    s.rough = 0.6; s.metal = 0.2;
  }
  // wear, dirt and wet edges
  float dn = civF2(p * 0.05 + seed * 2.0);
  s.alb *= 0.86 + 0.22 * dn;
  float curb = smoothstep(0.84, 0.9, edge) * (1.0 - smoothstep(0.98, 1.0, edge)) * step(float(id), 1.5);
  s.alb = mix(s.alb, s.alb * 1.18 + 0.03, curb * 0.8);
  s.h += curb * 0.06;
  // gutters darken, the trodden centre is polished lighter, shallow puddles collect in the dips
  float ec = abs(edge * 2.0 - 1.0);
  s.alb *= 1.0 - 0.28 * smoothstep(0.72, 0.95, ec) * (1.0 - curb);
  s.alb *= 1.0 + 0.1 * (1.0 - smoothstep(0.0, 0.45, ec));
  s.ao *= 1.0 - 0.3 * smoothstep(0.8, 1.0, ec);
  float pud = smoothstep(0.62, 0.7, civF2(p * 0.09 + seed * 5.0) + smoothstep(0.6, 1.0, ec) * 0.12) * step(float(id), 6.5);
  s.rough = mix(s.rough, 0.08, pud * 0.85);
  s.alb *= 1.0 - 0.35 * pud;
  s.h *= 1.0 - pud;
  if (uCivSnow > 0.0) {
    float sn = smoothstep(0.35, 0.75, civF2(p * 0.12 + seed) + (1.0 - abs(edge * 2.0 - 1.0)) * -0.25 + 0.2) * uCivSnow;
    s.alb = mix(s.alb, vec3(0.85, 0.89, 0.95), sn); s.rough = mix(s.rough, 0.75, sn); s.h += sn * 0.02;
  }
  // lantern light pools (albedo-modulated, warm)
  s.emit += s.alb * uCivLamp * vMat.w * uCivNight * 3.0;
  return s;
}
`;

const VERT_PARS = /* glsl */`
attribute vec2 aFac; attribute vec4 aMat; attribute vec4 aExt;
varying vec2 vFac; varying vec4 vMat; varying vec4 vExt; varying vec3 vLoc; varying vec3 vLocN; varying float vCivDist;
uniform float uCivTime; uniform vec4 uCivWind; uniform float uCivPull;
`;

const VERT_MAIN = /* glsl */`
vFac = aFac; vMat = aMat; vExt = aExt;
if (aExt.z >= 16.0 && civFlagV(aExt.z, 16.0)) {
  // cloth: waves grow with distance from the pole (aFac.x from the hoist)
  float k = clamp(aFac.x / max(aExt.y, 0.01), 0.0, 1.0);
  float ph = aMat.y * 40.0;
  float w = sin(aFac.x * 2.1 - uCivTime * 4.3 + ph) * 0.6 + sin(aFac.x * 3.9 + aFac.y * 1.7 - uCivTime * 6.7 + ph) * 0.3;
  transformed += objectNormal * w * k * (0.12 + 0.3 * uCivWind.w) * min(aExt.y, 3.0) * 0.35;
  transformed.y -= k * k * 0.15 * (1.0 - uCivWind.w);
}
vec4 civL = vec4(transformed, 1.0);
vec3 civN = objectNormal;
#ifdef USE_INSTANCING
  civL = instanceMatrix * civL;
  civN = mat3(instanceMatrix) * civN;
#endif
vLoc = civL.xyz;
vLocN = civN;
`;

const VERT_PROJECT = /* glsl */`
#include <project_vertex>
vCivDist = length(mvPosition.xyz);
if (uCivPull > 0.0) { mvPosition.xyz *= (1.0 - uCivPull); gl_Position = projectionMatrix * mvPosition; }
`;

function civFlagVGLSL() { return 'bool civFlagV(float f, float bit){ return mod(floor(f / bit + 0.001), 2.0) > 0.5; }\n'; }

/** Create the shared uniform set for one settlement. */
export function createCivUniforms(world, palette = {}) {
  const C = (hex, fb) => new THREE.Color(hex || fb);
  return {
    uCivTime: world.uniforms.uTime,
    uCivWind: world.uniforms.uWind,
    uCivNight: { value: 0 },
    uCivDay: { value: 1 },
    uCivLitP: { value: 0 },
    uCivWinI: { value: 3.0 },
    uCivSkyZ: { value: C(palette.zenith, '#3b7dd8') },
    uCivSkyH: { value: C(palette.horizon, '#d6ecff') },
    uCivUpV: { value: new THREE.Vector3(0, 1, 0) },
    uCivLamp: { value: C(palette.lights, '#ffcf87') },
    uCivSunL: { value: new THREE.Vector3(0, 1, 0) },
    uCivMoss: { value: C('#4a5a2a') },
    uCivSand: { value: C(palette.sand, '#d8ae76') },
    uCivAccent: { value: C(palette.accent, '#d8432f') },
    uCivShadow: { value: null },
    uCivShadowM: { value: new THREE.Matrix4() },
    uCivShadowP: { value: new THREE.Vector4(1, 0.001, 1 / 2048, 0) },
    uCivShadowOn: { value: 0 },
    uCivNearFade: { value: 70 },
    uCivSnow: { value: 0 },
    uCivBounce: { value: new THREE.Vector3() },
    uCivPull: { value: 0 },
  };
}

/**
 * Patch a MeshStandardMaterial into a civ material.
 * kind: 'building' | 'ground'
 */
export function makeCivMaterial(uniforms, kind = 'building', opts = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0, side: opts.side ?? THREE.FrontSide });
  const pull = opts.pull ?? 0;
  const ground = kind === 'ground';
  const shadowNear = ground; // ground: city shadow only in the near field (the catcher does far)
  const dynamic = !!opts.dynamic; // moving objects: no city shadow lookup (their local space moves)
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, { uCivPull: { value: pull } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}\n${civFlagVGLSL()}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN}`)
      .replace('#include <project_vertex>', VERT_PROJECT);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <clipping_planes_pars_fragment>', `#include <clipping_planes_pars_fragment>\n${CIV_COMMON_GLSL}\n${ground ? GROUND_FRAG : BUILDING_FRAG}
vec3 civPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir){
  vec3 sx = dFdx(surf_pos), sy = dFdy(surf_pos);
  vec3 R1 = cross(sy, surf_norm), R2 = cross(surf_norm, sx);
  float det = dot(sx, R1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(det) * surf_norm - grad);
}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\nCivS civS = civSurface();\ndiffuseColor.rgb = civS.alb;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = civS.rough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = civS.metal;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{ float hh = civS.h; vec2 dH = vec2(dFdx(hh), dFdy(hh)); if (abs(dH.x) + abs(dH.y) > 1e-7) normal = civPerturb(-vViewPosition, normal, dH * 1.4, faceDirection); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += civS.emit;
if (civS.glass > 0.001) {
  vec3 cv = normalize(vViewPosition);
  vec3 cr = reflect(-cv, normal);
  float cu = dot(cr, uCivUpV);
  vec3 sky = mix(uCivSkyH, uCivSkyZ, smoothstep(0.0, 0.65, cu)) * smoothstep(-0.25, 0.04, cu);
  float fres = 0.05 + 0.95 * pow(1.0 - clamp(dot(normal, cv), 0.0, 1.0), 5.0);
  totalEmissiveRadiance += civS.glass * sky * fres;
}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
{
  float civSh = ${dynamic ? '1.0' : 'civShadowAt(vLoc, normalize(vLocN))'};
  ${shadowNear ? 'civSh = mix(civSh, 1.0, smoothstep(uCivNearFade * 0.6, uCivNearFade, vCivDist));' : ''}
  reflectedLight.directDiffuse *= civSh; reflectedLight.directSpecular *= civSh;
  // warm bounce from the sunlit ground onto walls and under the eaves
  float civUpN = clamp(normalize(vLocN).y, -1.0, 1.0);
  reflectedLight.indirectDiffuse += BRDF_Lambert(diffuseColor.rgb) * uCivBounce * (0.5 - 0.5 * civUpN) * (1.0 - smoothstep(25.0, 90.0, vLoc.y)) * civS.ao;
}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
{ float civAo = civS.ao; ${ground ? 'civAo = mix(civAo, 1.0, smoothstep(uCivNearFade * 0.6, uCivNearFade, vCivDist));' : ''}
  reflectedLight.indirectDiffuse *= civAo; reflectedLight.indirectSpecular *= civAo; reflectedLight.directDiffuse *= mix(1.0, civAo, 0.35); }`);
  };
  m.customProgramCacheKey = () => `civ-${kind}-${pull > 0 ? 1 : 0}-${dynamic ? 1 : 0}`;
  if (pull > 0) { m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = 0; }
  return m;
}

// ---------------------------------------------------------------- shadows

const DEPTH_VERT = /* glsl */`
uniform mat4 uCivShadowM;
varying float vZ;
void main(){
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
  #endif
  vZ = (uCivShadowM * p).z;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * p;
}`;
const DEPTH_FRAG = /* glsl */`
varying float vZ;
vec4 civPack(float v){ vec4 e = fract(vec4(1.0, 255.0, 65025.0, 16581375.0) * clamp(v, 0.0, 0.99999)); e -= e.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0); return e; }
void main(){ gl_FragColor = civPack(vZ); }`;

/**
 * A sun shadow map covering a whole settlement (settlement-local space).
 * Casters are proxies sharing geometry with the visible meshes.
 */
export class CityShadow {
  constructor(renderer, size, uniforms) {
    this.renderer = renderer;
    this.size = size;
    this.uniforms = uniforms;
    this.rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, generateMipmaps: false });
    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.mat = new THREE.ShaderMaterial({ vertexShader: DEPTH_VERT, fragmentShader: DEPTH_FRAG, uniforms: { uCivShadowM: uniforms.uCivShadowM }, side: THREE.DoubleSide });
    this.scene.overrideMaterial = this.mat;
    this.center = new THREE.Vector3();
    this.radius = 100;
    this.lastSun = new THREE.Vector3();
    this.dirty = true;
    uniforms.uCivShadow.value = this.rt.texture;
  }
  addCaster(mesh) {
    const p = mesh.isInstancedMesh ? new THREE.InstancedMesh(mesh.geometry, this.mat, mesh.count) : new THREE.Mesh(mesh.geometry, this.mat);
    if (mesh.isInstancedMesh) { p.instanceMatrix = mesh.instanceMatrix; p.count = mesh.count; }
    p.matrixAutoUpdate = false;
    p.matrix.copy(mesh.matrix); p.matrixWorld.copy(mesh.matrix);
    p.frustumCulled = false;
    this.scene.add(p);
    this.dirty = true;
    return p;
  }
  setBounds(center, radius) { this.center.copy(center); this.radius = radius; this.dirty = true; }

  /** sunL: sun direction in settlement-local space (unit). */
  update(sunL, force = false) {
    const u = this.uniforms;
    if (sunL.y < -0.02) { u.uCivShadowOn.value = 0; return; }
    if (!force && !this.dirty && sunL.angleTo(this.lastSun) < 0.003) return;
    this.lastSun.copy(sunL);
    this.dirty = false;
    const R = this.radius, c = this.center;
    const L = sunL.clone().normalize();
    // keep the light from grazing to avoid infinite shadows at sunset
    const Ls = L.clone(); if (Ls.y < 0.035) { Ls.y = 0.035; Ls.normalize(); }
    const right = new THREE.Vector3(0, 1, 0).cross(Ls); if (right.lengthSq() < 1e-6) right.set(1, 0, 0); right.normalize();
    const upv = Ls.clone().cross(right).normalize();
    const dist = R * 2.5;
    const cam = this.cam;
    cam.position.copy(c).addScaledVector(Ls, dist);
    const m = new THREE.Matrix4().makeBasis(right, upv, Ls);
    cam.quaternion.setFromRotationMatrix(m);
    cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R;
    cam.near = 1; cam.far = dist * 2;
    cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    // settlement-local → (u, v, depth01)
    const S = u.uCivShadowM.value;
    const near = cam.near, far = cam.far;
    // rows: u = dot(p - c, right)/(2R) + 0.5 ; v = dot(p - c, upv)/(2R) + 0.5 ; z = (dist - dot(p - c, Ls) - near)/(far - near)
    S.set(
      right.x / (2 * R), right.y / (2 * R), right.z / (2 * R), 0.5 - right.dot(c) / (2 * R),
      upv.x / (2 * R), upv.y / (2 * R), upv.z / (2 * R), 0.5 - upv.dot(c) / (2 * R),
      -Ls.x / (far - near), -Ls.y / (far - near), -Ls.z / (far - near), (dist + Ls.dot(c) - near) / (far - near),
      0, 0, 0, 1,
    );
    const texel = (2 * R) / this.size;
    u.uCivShadowP.value.set(texel, (texel * 1.5) / (far - near), 1 / this.size, 0);
    const r = this.renderer;
    const prevRT = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    const prevAuto = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(this.rt);
    r.setClearColor(0xffffff, 1);
    r.clear(true, true, false);
    r.render(this.scene, cam);
    r.setRenderTarget(prevRT);
    r.setClearColor(prevClear, prevAlpha);
    r.shadowMap.autoUpdate = prevAuto;
    u.uCivShadowOn.value = 1;
  }
  dispose() { this.rt.dispose(); this.mat.dispose(); }
}

// ---------------------------------------------------------------- shadow catcher (terrain receives city shadows + AO)

export function makeCatcherMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...uniforms,
      uStrength: { value: 0.62 },
    },
    vertexShader: /* glsl */`
      attribute float aAO;
      varying vec3 vLoc; varying vec3 vLocN; varying float vAO; varying float vDist;
      void main(){
        vLoc = position; vLocN = normal; vAO = aAO;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDist = length(mv.xyz);
        mv.xyz *= 1.0 - 0.0016;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uCivShadow; uniform mat4 uCivShadowM; uniform vec4 uCivShadowP; uniform float uCivShadowOn;
      uniform vec3 uCivSunL; uniform float uCivDay; uniform float uStrength; uniform float uCivNearFade;
      varying vec3 vLoc; varying vec3 vLocN; varying float vAO; varying float vDist;
      float civUnpack(vec4 c){ return dot(c, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0)); }
      void main(){
        vec3 n = normalize(vLocN);
        float ndl = dot(n, uCivSunL);
        float sh = 1.0;
        if (uCivShadowOn > 0.5 && ndl > 0.0) {
          vec3 sp = (uCivShadowM * vec4(vLoc + n * uCivShadowP.x * 1.5, 1.0)).xyz;
          if (sp.x > 0.0 && sp.y > 0.0 && sp.x < 1.0 && sp.y < 1.0) {
            float bias = uCivShadowP.y * 3.0;
            float t = uCivShadowP.z; float s = 0.0;
            s += step(sp.z - bias, civUnpack(texture2D(uCivShadow, sp.xy + vec2(-t, -t))));
            s += step(sp.z - bias, civUnpack(texture2D(uCivShadow, sp.xy + vec2(t, -t))));
            s += step(sp.z - bias, civUnpack(texture2D(uCivShadow, sp.xy + vec2(-t, t))));
            s += step(sp.z - bias, civUnpack(texture2D(uCivShadow, sp.xy + vec2(t, t))));
            s += 2.0 * step(sp.z - bias, civUnpack(texture2D(uCivShadow, sp.xy)));
            sh = s / 6.0;
          }
        }
        float near = smoothstep(uCivNearFade * 0.6, uCivNearFade, vDist);
        float dark = (1.0 - sh) * smoothstep(0.0, 0.12, ndl) * uStrength * smoothstep(0.0, 0.25, uCivDay) * near;
        float ao = (1.0 - vAO) * 0.6 * near;
        float k = clamp(dark + ao - dark * ao, 0.0, 0.85);
        gl_FragColor = vec4(vec3(1.0 - k), 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    toneMapped: false,
  });
}

// ---------------------------------------------------------------- glow billboards (lanterns, beacons, far city lights)

export function makeGlowMaterial(uniforms, opts = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCivNight: uniforms.uCivNight, uCivTime: uniforms.uCivTime,
      uSize: { value: opts.size ?? 1.2 }, uMinPx: { value: opts.minPx ?? 2.0 }, uPxAngle: { value: 0.0015 },
      uGain: { value: opts.gain ?? 6.0 }, uDayVis: { value: opts.dayVis ?? 0.0 }, uFarOnly: { value: opts.farOnly ?? 0 },
      uNearCut: { value: opts.nearCut ?? 0 },
    },
    vertexShader: /* glsl */`
      attribute vec4 aGlow; // rgb color, w = phase/blink
      uniform float uSize, uMinPx, uPxAngle, uCivNight, uCivTime, uGain, uDayVis, uFarOnly, uNearCut;
      varying vec3 vCol; varying vec2 vUv; varying float vA;
      void main(){
        vec4 c = vec4(0.0, 0.0, 0.0, 1.0);
        #ifdef USE_INSTANCING
          c = instanceMatrix * c;
          float sc = length(instanceMatrix[0].xyz);
        #else
          float sc = 1.0;
        #endif
        vec4 mv = modelViewMatrix * c;
        float d = length(mv.xyz);
        float s = max(uSize * sc, d * uPxAngle * uMinPx);
        mv.xy += position.xy * s;
        gl_Position = projectionMatrix * mv;
        vUv = position.xy;
        float blink = aGlow.w > 1.5 ? step(0.5, fract(uCivTime * 0.5 + aGlow.w)) : 1.0;
        float flick = aGlow.w > 0.0 && aGlow.w <= 1.5 ? 0.85 + 0.15 * sin(uCivTime * 9.0 + aGlow.w * 50.0) * sin(uCivTime * 4.3 + aGlow.w * 21.0) : 1.0;
        float vis = max(uCivNight, uDayVis);
        float farK = uFarOnly > 0.5 ? smoothstep(uFarOnly * 0.5, uFarOnly, d) : 1.0;
        float nearK = uNearCut > 0.0 ? smoothstep(uNearCut * 0.5, uNearCut, d) : 1.0;
        // keep total energy ~constant when the sprite is clamped to a minimum pixel size
        float e = (uSize * sc) / s;
        vA = vis * blink * flick * farK * nearK * mix(1.0, e * e, 0.75);
        vCol = aGlow.rgb * uGain;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol; varying vec2 vUv; varying float vA;
      void main(){
        float r = length(vUv);
        if (r > 1.0) discard;
        float g = exp(-r * r * 9.0) + 0.25 * exp(-r * r * 2.5) * (1.0 - r);
        gl_FragColor = vec4(vCol * g * vA, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
}

/** Instanced billboard quads: positions[] (Vector3, local), colors (Color), phase. */
export function makeGlowMesh(material, items) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const n = items.length;
  const glow = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { const it = items[i]; glow[i * 4] = it.color.r; glow[i * 4 + 1] = it.color.g; glow[i * 4 + 2] = it.color.b; glow[i * 4 + 3] = it.phase ?? 0; }
  g.setAttribute('aGlow', new THREE.InstancedBufferAttribute(glow, 4));
  const mesh = new THREE.InstancedMesh(g, material, n);
  const m = new THREE.Matrix4();
  const box = new THREE.Box3();
  for (let i = 0; i < n; i++) {
    const it = items[i];
    m.makeScale(it.scale ?? 1, it.scale ?? 1, it.scale ?? 1).setPosition(it.position);
    mesh.setMatrixAt(i, m);
    box.expandByPoint(it.position);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
  mesh.boundingSphere.radius += 10;
  mesh.geometry.boundingSphere = mesh.boundingSphere.clone();
  mesh.renderOrder = 5;
  return mesh;
}
