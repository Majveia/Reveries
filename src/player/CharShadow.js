// Character self-shadowing.
//
// The planet's sun shadow map covers hundreds of meters (≈ 10 cm texels and a
// large normal bias), so on its own a 1.8 m character gets no self-shadowing:
// arms don't shade the torso, the helmet doesn't shade the shoulders. This pass
// renders a tight orthographic depth map of the explorer (+ scarf) from the key
// light (sun or moon) at millimetre resolution; the explorer's materials sample it
// (PCF) and attenuate their direct light. Cost: one tiny scene of ~5 draw calls.
//
// Depth is stored linearly along the light (float RT), sampled in view space so
// precision is independent of the planet-scale world coordinates.

import * as THREE from 'three';

export const CHAR_SHADOW_GLSL = /* glsl */`
uniform sampler2D uCSMap; uniform mat4 uCSMat; uniform float uCSHalf; uniform float uCSOn; uniform float uCSTexel;
float rvCharShadow(vec3 viewPos, vec3 viewN) {
  if (uCSOn < 0.5) return 1.0;
  vec4 sp = uCSMat * vec4(viewPos + viewN * 0.005, 1.0);
  vec2 uv = sp.xy / uCSHalf * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  float d = -sp.z;
  float s = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    float st = texture2D(uCSMap, uv + vec2(float(i), float(j)) * uCSTexel * 1.3).r;
    s += smoothstep(st + 0.006, st + 0.02, d);
  }
  return 1.0 - s / 9.0;
}
`;

export const CHAR_SHADOW_APPLY = /* glsl */`
  {
    float rvCS = rvCharShadow(-vViewPosition, normal);
    reflectedLight.directDiffuse *= rvCS;
    reflectedLight.directSpecular *= rvCS;
    #ifdef USE_SHEEN
      sheenSpecularDirect *= rvCS;
    #endif
    #ifdef USE_CLEARCOAT
      clearcoatSpecularDirect *= rvCS;
    #endif
  }
`;

const FAR_COLOR = new THREE.Color(1e4, 1e4, 1e4);

export class CharShadow {
  constructor(renderer, size = 1024) {
    this.renderer = renderer;
    this.size = size;
    const type = renderer.extensions.has('EXT_color_buffer_float') ? THREE.FloatType : THREE.HalfFloatType;
    this.rt = new THREE.WebGLRenderTarget(size, size, { type, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, generateMipmaps: false });
    this.half = 1.3; // frustum half size (m)
    this.cam = new THREE.OrthographicCamera(-this.half, this.half, this.half, -this.half, 0.1, 14);
    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = false;
    this.material = new THREE.ShaderMaterial({
      vertexShader: /* glsl */`
        #include <common>
        #include <skinning_pars_vertex>
        varying float vDepth;
        void main() {
          #include <skinbase_vertex>
          #include <begin_vertex>
          #include <skinning_vertex>
          vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: 'varying float vDepth; void main(){ gl_FragColor = vec4(vDepth, 0.0, 0.0, 1.0); }',
      side: THREE.DoubleSide,
    });
    this.uniforms = {
      uCSMap: { value: this.rt.texture },
      uCSMat: { value: new THREE.Matrix4() },
      uCSHalf: { value: this.half },
      uCSOn: { value: 0 },
      uCSTexel: { value: 1 / size },
    };
    this._clear = new THREE.Color();
    this._m = new THREE.Matrix4();
    this._lightDir = new THREE.Vector3();
  }

  /**
   * objects: Object3Ds to render (temporarily re-parented into the shadow scene).
   * center: world point to centre the frustum on; lightDir: unit vector toward the light.
   * viewCamera: the main camera (for the view-space lookup matrix).
   */
  render(objects, center, lightDir, up, viewCamera, enabled = true) {
    const U = this.uniforms;
    U.uCSOn.value = enabled ? 1 : 0;
    if (!enabled) return;
    const r = this.renderer;
    const cam = this.cam;
    cam.position.copy(center).addScaledVector(lightDir, 7);
    cam.up.copy(Math.abs(lightDir.dot(up)) > 0.98 ? this._lightDir.set(1, 0, 0) : up);
    cam.lookAt(center);
    cam.updateMatrixWorld(true);
    // re-parent into the private scene
    const parents = this._parents || (this._parents = []);
    parents.length = 0;
    for (const o of objects) { parents.push(o.parent); this.scene.add(o); }
    const prevOverride = this.scene.overrideMaterial;
    this.scene.overrideMaterial = this.material;
    const prevTarget = r.getRenderTarget();
    r.getClearColor(this._clear); const prevAlpha = r.getClearAlpha();
    const prevAuto = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(this.rt);
    r.setClearColor(FAR_COLOR, 1);
    r.clear(true, true, false);
    r.render(this.scene, cam);
    r.setRenderTarget(prevTarget);
    r.setClearColor(this._clear, prevAlpha);
    r.shadowMap.autoUpdate = prevAuto;
    this.scene.overrideMaterial = prevOverride;
    for (let i = 0; i < objects.length; i++) { const p = parents[i]; if (p) p.add(objects[i]); else this.scene.remove(objects[i]); }
    // view space → light view (ortho): M = lightView · cameraWorld
    viewCamera.updateMatrixWorld();
    U.uCSMat.value.multiplyMatrices(cam.matrixWorldInverse, viewCamera.matrixWorld);
  }

  dispose() { this.rt.dispose(); this.material.dispose(); }
}
