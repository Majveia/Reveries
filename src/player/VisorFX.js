// First-person helmet glass: the world seen through a curved visor.
// A whisper-subtle HDR pass (runs after the atmosphere): slight barrel
// refraction and chromatic fringe toward the glass edge, a soft rounded
// aperture falloff (never black, never obscuring), a faint sky reflection
// sheen across the top of the glass and a hairline heading arc with a compass
// tick at the bottom — the HUD lives on the visor, not on the screen.

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
          // barrel refraction + chromatic fringe grow toward the rim
          float k = 0.018 * uAmount * r * r;
          vec2 dir = p * k * 0.5;
          vec3 col;
          col.r = texture2D(tInput, vUv - dir * 1.25).r;
          col.g = texture2D(tInput, vUv - dir).g;
          col.b = texture2D(tInput, vUv - dir * 0.75).b;
          // rounded aperture falloff (glass thickening), gentle
          vec2 a = abs(p) - vec2(0.82, 0.72);
          float box = length(max(a, 0.0)) + min(max(a.x, a.y), 0.0);
          float edge = smoothstep(-0.05, 0.42, box);
          col *= 1.0 - 0.38 * edge * uAmount;
          // sky sheen reflected on the upper glass
          float sheen = smoothstep(0.35, 1.0, p.y) * (0.6 + 0.4 * sin(p.x * 1.7 + 0.6)) * 0.022;
          col += uSheen * sheen * uAmount;
          // HUD: hairline heading arc + ticks at the bottom of the glass
          float arcY = -0.84 + 0.06 * p.x * p.x;
          float arc = (1.0 - smoothstep(0.0, 0.0035, abs(p.y - arcY))) * smoothstep(0.42, 0.18, abs(p.x));
          float hx = p.x * 3.0 + uHeading * 3.0 / 6.2831853 * 8.0;
          float tick = (1.0 - smoothstep(0.0, 0.012, abs(fract(hx) - 0.5) * 0.33)) * step(abs(p.y - arcY - 0.012), 0.012) * smoothstep(0.42, 0.15, abs(p.x));
          float center = (1.0 - smoothstep(0.0, 0.004, abs(p.x))) * step(abs(p.y - arcY + 0.022), 0.018);
          col += uTint * (arc * 0.35 + tick * 0.25 + center * 0.9) * uAmount;
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
