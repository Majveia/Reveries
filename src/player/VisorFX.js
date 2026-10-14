// First-person helmet glass: the world seen through a curved visor.
// A whisper-subtle HDR pass (runs after the atmosphere): slight barrel
// refraction and chromatic fringe toward the glass edge, a soft rounded
// aperture falloff (never black, never obscuring), a faint sky reflection
// sheen across the top of the glass and faint compass ticks along the top edge.

import * as THREE from 'three';

export class VisorFX {
  constructor() {
    this.enabled = false;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uAspect: { value: 1 },
        uTime: { value: 0 },
        uHeading: { value: 0 },
        uTint: { value: new THREE.Color(0.55, 0.85, 1.0) },
        uSheen: { value: new THREE.Color(0.6, 0.7, 0.8) },
        uAmount: { value: 1 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        uniform sampler2D tInput; uniform float uAspect, uTime, uHeading, uAmount; uniform vec3 uTint, uSheen;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          vec2 q = vec2(p.x * uAspect, p.y);
          float r = length(p * vec2(0.92, 1.0));
          // barrel refraction + chromatic fringe grow toward the rim (kept very low)
          float k = 0.004 * uAmount * r * r * smoothstep(0.6, 1.05, r); // clean centre, sub-pixel fringe only at the glass edge
          vec2 dir = p * k * 0.5;
          vec3 col;
          col.r = texture2D(tInput, vUv - dir * 1.2).r;
          col.g = texture2D(tInput, vUv - dir).g;
          col.b = texture2D(tInput, vUv - dir * 0.8).b;
          // rounded aperture falloff (glass thickening), gentle
          vec2 a = abs(p) - vec2(0.84, 0.74);
          float box = length(max(a, 0.0)) + min(max(a.x, a.y), 0.0);
          float edge = smoothstep(-0.05, 0.42, box);
          col *= 1.0 - 0.32 * edge * uAmount;
          // helmet shell: a soft, out-of-focus curved rim just entering the far corners
          // (biased up: the chin / cheek guards enter the lower corners more than the brow does,
          // the diegetic cue that you are inside a helmet — still never across the view)
          float rimD = length((p - vec2(0.0, 0.1)) * vec2(0.8, 1.0));
          float shell = smoothstep(1.08, 1.36, rimD) * (0.6 + 0.4 * smoothstep(0.2, 1.0, abs(p.x)));
          col = mix(col, col * 0.12 + uSheen * 0.005, shell * 0.9 * uAmount);
          // glass smudges / micro-scratches only show where bright light crosses them
          vec2 sp = vUv * vec2(uAspect, 1.0) * 7.0;
          vec2 si = floor(sp), sf = fract(sp); sf = sf * sf * (3.0 - 2.0 * sf);
          float h00 = fract(sin(dot(si, vec2(127.1, 311.7))) * 43758.55), h10 = fract(sin(dot(si + vec2(1, 0), vec2(127.1, 311.7))) * 43758.55);
          float h01 = fract(sin(dot(si + vec2(0, 1), vec2(127.1, 311.7))) * 43758.55), h11 = fract(sin(dot(si + vec2(1, 1), vec2(127.1, 311.7))) * 43758.55);
          float smudge = smoothstep(0.55, 0.95, mix(mix(h00, h10, sf.x), mix(h01, h11, sf.x), sf.y)) * smoothstep(0.3, 1.0, r);
          float lumC = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col += vec3(1.0, 0.97, 0.92) * smudge * min(lumC, 4.0) * 0.035 * uAmount;
          // inner edge of the glass catches the sky: a thin luminous lip along the shell boundary
          float lip = exp(-pow((rimD - 1.15) / 0.08, 2.0)) * smoothstep(0.0, 0.6, p.y + 0.4);
          col += uSheen * lip * 0.03 * uAmount;
          // sky sheen reflected on the upper glass + a slow drifting glint
          float sheen = smoothstep(0.35, 1.0, p.y) * (0.6 + 0.4 * sin(p.x * 1.7 + 0.6)) * 0.022;
          float glint = exp(-pow((p.x * 0.7 + p.y * 0.45 - 0.55 - 0.05 * sin(uTime * 0.2)) / 0.035, 2.0)) * smoothstep(0.1, 0.8, p.y) * 0.02;
          col += uSheen * (sheen + glint) * uAmount;
          // HUD: a single hairline compass tick at the very top of the glass (never over the view)
          float hx = p.x * 3.0 + uHeading * 3.0 / 6.2831853 * 8.0;
          float topY = 0.93 - 0.03 * p.x * p.x;
          float fadeX = smoothstep(0.3, 0.08, abs(p.x));
          float tick = (1.0 - smoothstep(0.0, 0.01, abs(fract(hx) - 0.5) * 0.33)) * step(abs(p.y - topY), 0.008) * fadeX;
          col += uTint * tick * 0.05 * uAmount;
          // faint warm cast of the smoked-gold glass
          col *= mix(vec3(1.0), vec3(1.03, 1.0, 0.95), uAmount);
          gl_FragColor = vec4(col, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
  }

  render(renderer, input, output, ctx) {
    const u = this.material.uniforms;
    u.tInput.value = input;
    u.uAspect.value = ctx.width / Math.max(1, ctx.height);
    u.uTime.value = ctx.time;
    ctx.fullscreen(this.material, output);
  }

  dispose() { this.material.dispose(); }
}
