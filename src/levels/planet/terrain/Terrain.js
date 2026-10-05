// Planet terrain subsystem — seamless from orbit to the player's feet.
//
//   • cube-sphere quadtree (6 faces), chunks of N×N cells + skirts, CDLOD
//     geomorphing in the vertex shader
//   • split by projected vertex spacing (screen-space error), frustum-aware,
//     horizon culling against the planet's minimum-radius sphere
//   • chunk meshes built in a pool of module workers (TerrainWorker.js) from
//     the same pure height field World uses (TerrainHeight.js) → the rendered
//     surface agrees with world.heightAt within centimetres near the camera
//   • pooled geometries (no GL buffer churn), budgeted uploads per frame,
//     LRU chunk cache
//   • far-terrain shadow map: the terrain itself rendered from the sun into a
//     depth texture covering the vista → mountains cast long shadows across
//     valleys at dawn/dusk (complements the engine's near shadow map)
//   • shot mode converges synchronously so screenshots are always complete
//
// Public: terrain.ready (bool), terrain.whenReady (Promise), terrain.settle()
// (async: stream until the current view is complete), terrain.group,
// terrain.material, terrain.sunShadow { texture, matrix, enabled } for other
// materials that want terrain shadows on themselves.
import * as THREE from 'three';
import { buildChunk, buildIndex, faceDir, vertexCount } from './ChunkBuilder.js';
import { createTerrainMaterial } from './TerrainMaterial.js';

const N = 64; // cells per chunk edge (65² vertices + skirts, 16-bit indices)
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _m = new THREE.Matrix4();
const _frustum = new THREE.Frustum(), _sphere = new THREE.Sphere();

class Node {
  constructor(face, level, ix, iy, parent) {
    this.face = face; this.level = level; this.ix = ix; this.iy = iy; this.parent = parent;
    this.children = null;
    this.chunk = null;        // { mesh, minH, maxH, radius }
    this.pending = false;
    this.lastUsed = 0;
    this.center = new THREE.Vector3();
    this.radius = 0;
    this.minH = 0; this.maxH = 0;
  }
}

export default class Terrain {
  static order = 30;

  constructor(level) {
    this.level = level;
    this.world = level.world;
    this.engine = level.engine;
    this.ready = false;
    this.whenReady = new Promise((r) => { this._resolveReady = r; });
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this.frame = 0;
    try { self.__PLANET_LOADING__ = level; } catch { /* debug */ }
  }

  async init(progress) {
    const w = this.world, q = this.engine.quality;
    this.R = w.radius;
    this.faceSize = (Math.PI * 0.5) * this.R;
    // deepest level: vertex spacing ≈ 0.35–0.5 m
    const targetSpacing = q.pick(0.6, 0.5, 0.4, 0.33);
    this.maxLevel = Math.max(4, Math.ceil(Math.log2(this.faceSize / (N * targetSpacing))));
    this.pixelError = this.engine.shotMode ? 5 : q.pick(10, 8, 6, 4.5); // allowed projected vertex spacing (px)
    this.uploadBudget = q.pick(3, 5, 8, 12);
    this.maxChunks = q.pick(220, 320, 420, 600);
    this.relief = w.terrainParams.relief;
    // conservative height range for nodes without data
    this.hMin = -this.relief * 1.2; this.hMax = this.relief * 1.6;

    const { material, uniforms } = createTerrainMaterial(w, w.terrainParams.style);
    this.material = material; this.uniforms = uniforms;
    uniforms.uFaceSize.value = this.faceSize;
    // wind for sand ripples
    uniforms.uWindDir.value.copy(w.wind);

    this.index = new THREE.BufferAttribute(buildIndex(N), 1);
    this.VC = vertexCount(N);
    this.pool = [];
    this.meshes = new Set();
    this.level.scene.add(this.group);

    // Detail-space origin (snapped camera position; see TerrainMaterial)
    this.detailOrigin = new THREE.Vector3();

    // ---- worker pool ----
    const hc = navigator.hardwareConcurrency || 4;
    const nw = this.engine.shotMode ? Math.max(2, Math.min(hc - 1, 6)) : Math.max(1, Math.min(hc - 2, q.pick(2, 3, 4, 6)));
    this.workers = [];
    this.jobs = new Map();
    this.jobId = 0;
    this.results = [];
    try {
      for (let i = 0; i < nw; i++) {
        const wk = new Worker(new URL('./TerrainWorker.js', import.meta.url), { type: 'module' });
        wk.busy = 0;
        wk.onmessage = (e) => this._onWorker(wk, e.data);
        wk.onerror = (e) => { console.warn('[terrain] worker error', e.message || e); this._failWorker(wk); };
        wk.readyP = new Promise((r) => { wk._ready = r; });
        wk.postMessage({ type: 'init', params: w.terrainParams });
        this.workers.push(wk);
      }
    } catch (e) {
      console.warn('[terrain] workers unavailable, building on the main thread', e);
      this.workers = [];
    }
    this._dbg('workers starting');
    // workers that do not come up in time are retired (their jobs run on the main thread)
    if (this.workers.length) {
      await Promise.race([Promise.all(this.workers.map((wk) => wk.readyP)), new Promise((r) => setTimeout(r, 12000))]);
      for (const wk of this.workers) if (!wk.ready) { console.warn('[terrain] worker did not start; using main thread'); this._failWorker(wk); }
    }
    this._dbg('workers ready');

    // ---- roots + first rings (whole planet, readable from orbit) ----
    this.roots = [];
    for (let f = 0; f < 6; f++) { const n = new Node(f, 0, 0, 0, null); this._bounds(n); this.roots.push(n); }
    const initial = [];
    const walk = (n, depth) => { initial.push(n); if (depth > 0) { this._split(n); for (const c of n.children) walk(c, depth - 1); } };
    const preDepth = this.engine.shotMode ? 1 : q.pick(1, 2, 2, 2);
    for (const r of this.roots) walk(r, preDepth);
    let done = 0;
    await Promise.all(initial.map((n) => this._request(n, true).then(() => { done++; progress?.(done / initial.length); this._dbg(`chunks ${done}/${initial.length}`); })));
    // apply everything immediately (no budget at load)
    this._applyResults(Infinity);

    // ---- far-terrain sun shadow ----
    this._setupSunShadow();

    this.ready = true;
    this._resolveReady();
    this._dbg('init done');
  }

  // ---------------------------------------------------------------- geometry
  _bounds(n) {
    // approximate bounds from the face patch corners + center (refined by data)
    const total = 1 << n.level;
    const a0 = -1 + (2 * n.ix) / total, a1 = -1 + (2 * (n.ix + 1)) / total;
    const b0 = -1 + (2 * n.iy) / total, b1 = -1 + (2 * (n.iy + 1)) / total;
    const d = [0, 0, 0];
    faceDir(n.face, (a0 + a1) / 2, (b0 + b1) / 2, d);
    const lo = this.R + (n.parent ? n.parent.minH : this.hMin), hi = this.R + (n.parent ? n.parent.maxH : this.hMax);
    const rMid = (lo + hi) / 2;
    n.center.set(d[0], d[1], d[2]).multiplyScalar(rMid);
    let rad = 0;
    for (const [a, b] of [[a0, b0], [a1, b0], [a0, b1], [a1, b1], [(a0 + a1) / 2, b0], [(a0 + a1) / 2, b1], [a0, (b0 + b1) / 2], [a1, (b0 + b1) / 2]]) {
      faceDir(n.face, a, b, d);
      for (const r of [lo, hi]) { const dx = d[0] * r - n.center.x, dy = d[1] * r - n.center.y, dz = d[2] * r - n.center.z; rad = Math.max(rad, Math.hypot(dx, dy, dz)); }
    }
    n.radius = rad;
    n.minH = n.parent ? n.parent.minH : this.hMin; n.maxH = n.parent ? n.parent.maxH : this.hMax;
    n.spacing = this.faceSize / (N * total);
  }

  _split(n) {
    if (n.children) return;
    n.children = [];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const c = new Node(n.face, n.level + 1, n.ix * 2 + i, n.iy * 2 + j, n);
      this._bounds(c);
      n.children.push(c);
    }
  }

  _job(n) { return { face: n.face, level: n.level, ix: n.ix, iy: n.iy, N, radius: this.R }; }

  /** Request a chunk build. Returns a promise resolved when data has arrived (queued for upload). */
  _request(n, awaitable = false) {
    if (n.chunk || n.pending) return n._promise || Promise.resolve();
    n.pending = true;
    const live = this.workers.filter((w) => !w.dead);
    if (!live.length) {
      const data = buildChunk(this.world.terrain, this._job(n));
      this.results.push({ node: n, data });
      n._promise = Promise.resolve();
      return n._promise;
    }
    let wk = live[0];
    for (const w of live) if (w.busy < wk.busy) wk = w;
    const id = ++this.jobId;
    wk.busy++;
    n._promise = new Promise((res) => { this.jobs.set(id, { node: n, res, wk }); });
    wk.postMessage({ type: 'build', id, job: this._job(n) });
    return n._promise;
  }

  _dbg(msg) { try { self.__TERRAIN_DBG__ = msg; } catch { /* ignore */ } }

  _failWorker(wk) {
    if (wk.dead) return;
    wk.dead = true;
    try { wk.terminate(); } catch { /* ignore */ }
    for (const [id, j] of this.jobs) {
      if (j.wk !== wk) continue;
      this.jobs.delete(id);
      const data = buildChunk(this.world.terrain, this._job(j.node));
      this.results.push({ node: j.node, data });
      j.res();
    }
  }

  _onWorker(wk, m) {
    if (m.type === 'ready') { wk.ready = true; wk._ready?.(); return; }
    const j = this.jobs.get(m.id);
    if (!j) return;
    this.jobs.delete(m.id);
    wk.busy = Math.max(0, wk.busy - 1);
    if (m.type === 'error') {
      console.warn('[terrain] chunk build failed', m.message);
      j.node.pending = false; j.res(); return;
    }
    if (j.node.dead) { j.node.pending = false; j.res(); return; }
    this.results.push({ node: j.node, data: m.data });
    j.res();
  }

  _applyResults(budget) {
    let n = 0;
    // closest/coarsest first: sort by level (coarse first keeps fallbacks complete)
    if (this.results.length > budget) this.results.sort((a, b) => a.node.level - b.node.level);
    while (this.results.length && n < budget) {
      const { node, data } = this.results.shift();
      node.pending = false;
      if (node.dead) continue;
      this._attach(node, data);
      n++;
    }
  }

  _mesh() {
    let m = this.pool.pop();
    if (m) return m;
    const g = new THREE.BufferGeometry();
    const VC = this.VC;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(VC * 3), 3));
    g.setAttribute('aMorph', new THREE.BufferAttribute(new Float32Array(VC * 3), 3));
    g.setAttribute('aNrm', new THREE.BufferAttribute(new Int8Array(VC * 4), 4, true));
    g.setAttribute('aNrm2', new THREE.BufferAttribute(new Int8Array(VC * 4), 4, true));
    g.setAttribute('aMatA', new THREE.BufferAttribute(new Uint8Array(VC * 4), 4, true));
    g.setAttribute('aMatB', new THREE.BufferAttribute(new Uint8Array(VC * 4), 4, true));
    g.setAttribute('aHgt', new THREE.BufferAttribute(new Float32Array(VC), 1));
    g.setIndex(this.index);
    g.boundingSphere = new THREE.Sphere();
    g.boundingBox = new THREE.Box3();
    m = new THREE.Mesh(g, this.material);
    m.matrixAutoUpdate = false;
    m.receiveShadow = true;
    m.castShadow = false;
    m.visible = false;
    this.group.add(m);
    return m;
  }

  _attach(node, d) {
    const m = this._mesh();
    const g = m.geometry, A = g.attributes;
    A.position.array.set(d.position); A.position.needsUpdate = true;
    A.aMorph.array.set(d.morph); A.aMorph.needsUpdate = true;
    A.aNrm.array.set(d.nrm); A.aNrm.needsUpdate = true;
    A.aNrm2.array.set(d.nrm2); A.aNrm2.needsUpdate = true;
    A.aMatA.array.set(d.matA); A.aMatA.needsUpdate = true;
    A.aMatB.array.set(d.matB); A.aMatB.needsUpdate = true;
    A.aHgt.array.set(d.hgt); A.aHgt.needsUpdate = true;
    g.boundingSphere.center.set(d.center[0], d.center[1], d.center[2]);
    g.boundingSphere.radius = d.radius;
    m.position.set(d.origin[0], d.origin[1], d.origin[2]);
    m.updateMatrix(); m.updateMatrixWorld(true);
    node.chunk = { mesh: m };
    node.minH = d.minH; node.maxH = d.maxH;
    node.center.set(d.center[0] + d.origin[0], d.center[1] + d.origin[1], d.center[2] + d.origin[2]);
    node.radius = d.radius;
    // near chunks cast shadows into the engine's near shadow map
    m.castShadow = node.spacing < 3;
    m.visible = false;
    m.userData.node = node;
    this.meshes.add(m);
    this.chunkCount = (this.chunkCount || 0) + 1;
  }

  _release(node) {
    if (!node.chunk) return;
    const m = node.chunk.mesh;
    m.visible = false;
    this.meshes.delete(m);
    this.pool.push(m);
    node.chunk = null;
    this.chunkCount--;
  }

  // ---------------------------------------------------------------- LOD selection
  _prepareView() {
    const cam = this.level.camera;
    cam.updateMatrixWorld();
    _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_m, THREE.WebGLCoordinateSystem, cam.reversedDepth);
    this.camPos = cam.getWorldPosition(this._camPos || (this._camPos = new THREE.Vector3()));
    const H = this.engine.height || innerHeight;
    const fov = THREE.MathUtils.degToRad(cam.fov);
    this.pxPerRad = (H * 0.5) / Math.tan(fov * 0.5);
    this.uniforms.uPixelAngle.value = 1 / this.pxPerRad;
    // horizon: sphere of minimum terrain radius
    const d = this.camPos.length();
    this.Ro = this.R + Math.min(0, this.hMinSeen ?? this.hMin);
    this.camDist = d;
    this.horizon = d > this.Ro ? Math.sqrt(d * d - this.Ro * this.Ro) : 0;
  }

  _visibleHorizon(n) {
    if (this.camDist <= this.Ro + 1) return true;
    const dc = n.center.distanceTo(this.camPos) - n.radius;
    const rmax = this.R + n.maxH;
    const reach = this.horizon + Math.sqrt(Math.max(0, rmax * rmax - this.Ro * this.Ro));
    return dc <= reach;
  }

  _wantsSplit(n) {
    if (n.level >= this.maxLevel) return false;
    let d = Math.max(0, n.center.distanceTo(this.camPos) - n.radius);
    _sphere.center.copy(n.center); _sphere.radius = n.radius * 1.15;
    if (!_frustum.intersectsSphere(_sphere)) d = d * 12 + n.radius * 2; // off-screen: much coarser
    // projected vertex spacing in pixels
    const px = (n.spacing * this.pxPerRad) / Math.max(d, 1e-3);
    return px > this.pixelError;
  }

  _select() {
    this.frame++;
    const want = [];
    const draw = this._draw || (this._draw = []);
    draw.length = 0;
    const visit = (n) => {
      n.lastUsed = this.frame;
      if (!this._visibleHorizon(n)) return;
      if (this._wantsSplit(n)) {
        this._split(n);
        let ready = true;
        for (const c of n.children) { c.lastUsed = this.frame; if (!c.chunk) { ready = false; if (!c.pending) want.push(c); } }
        if (ready) { for (const c of n.children) visit(c); return; }
      }
      if (n.chunk) draw.push(n);
      else if (!n.pending) want.push(n);
    };
    for (const r of this.roots) visit(r);
    // visibility
    for (const m of this.meshes) m.visible = false;
    for (const n of draw) n.chunk.mesh.visible = true;
    this.drawCount = draw.length;
    return want;
  }

  _dispatch(want) {
    if (!want.length) return;
    // urgency: projected size (coarse + near first)
    for (const n of want) n._prio = Math.max(0, n.center.distanceTo(this.camPos) - n.radius) / n.spacing;
    want.sort((a, b) => a._prio - b._prio);
    const live = this.workers.filter((w) => !w.dead);
    const cap = live.length ? live.length * 2 : 2;
    let inflight = this.jobs.size;
    for (const n of want) {
      if (inflight >= cap) break;
      this._request(n);
      inflight++;
    }
  }

  _evict() {
    if (this.chunkCount <= this.maxChunks) return;
    // candidates: cached chunks not used this frame whose children hold no data
    const cands = [];
    for (const m of this.meshes) {
      const n = m.userData.node;
      if (n.level === 0 || n.lastUsed === this.frame) continue;
      if (n.children && n.children.some((c) => c.chunk || c.children)) continue;
      cands.push(n);
    }
    cands.sort((a, b) => a.lastUsed - b.lastUsed || b.level - a.level);
    let over = this.chunkCount - this.maxChunks * 0.9;
    for (const n of cands) {
      if (over <= 0) break;
      this._release(n);
      // prune empty child arrays so the tree does not grow unbounded
      if (n.parent && n.parent.children.every((c) => !c.chunk && !c.children && !c.pending)) { for (const c of n.parent.children) c.dead = true; n.parent.children = null; }
      over--;
    }
  }

  /** Synchronous convergence (screenshots): build every missing chunk on the main thread. */
  _converge() {
    for (let it = 0; it < 40; it++) {
      this._applyResults(Infinity);
      const want = this._select();
      if (!want.length) return;
      for (const n of want) {
        if (n.pending) continue;
        const data = buildChunk(this.world.terrain, this._job(n));
        this._attach(n, data);
      }
    }
  }

  /** Stream until the current view needs nothing more (async, uses workers). */
  async settle(maxMs = 20000) {
    const t0 = performance.now();
    for (;;) {
      this._prepareView();
      this._applyResults(Infinity);
      const want = this._select();
      if (!want.length && !this.jobs.size) return true;
      await Promise.all(want.map((n) => this._request(n)));
      if (performance.now() - t0 > maxMs) return false;
    }
  }

  update() {}

  lateUpdate() {
    if (!this.ready) return;
    this._prepareView();
    // detail-space origin: camera snapped to 4096 m (all detail frequencies are k/4096 m⁻¹)
    const S = 4096;
    const o = this.detailOrigin.set(Math.round(this.camPos.x / S) * S, Math.round(this.camPos.y / S) * S, Math.round(this.camPos.z / S) * S);
    this.uniforms.uDetailOrigin.value.copy(o);
    this.uniforms.uLodK.value = this.pxPerRad / this.pixelError / N;
    if (this.engine.shotMode) {
      this._converge();
    } else {
      this._applyResults(this.uploadBudget);
      const want = this._select();
      this._dispatch(want);
      this._evict();
    }
    this._updateSunShadow();
    this._syncSunMatrix();
  }

  // ---------------------------------------------------------------- far sun shadow
  _setupSunShadow() {
    const q = this.engine.quality;
    this.sunShadow = { enabled: q.level >= 1, texture: null, matrix: new THREE.Matrix4(), extent: 0 };
    if (!this.sunShadow.enabled) return;
    const size = q.pick(1024, 1024, 2048, 2048);
    const rt = new THREE.WebGLRenderTarget(size, size, { depthBuffer: true });
    rt.depthTexture = new THREE.DepthTexture(size, size, THREE.FloatType);
    rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter;
    this._sunRT = rt;
    this._sunCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1e5);
    this._depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    this._sunState = { pos: new THREE.Vector3(1e9, 0, 0), sun: new THREE.Vector3(), t: -1 };
    this.sunShadow.texture = rt.depthTexture;
    this.uniforms.tSunVis.value = rt.depthTexture;
  }

  _updateSunShadow() {
    const ss = this.sunShadow;
    if (!ss?.enabled) return;
    const w = this.world;
    const cam = this.camPos;
    const alt = w.altitude(cam);
    // the far shadow matters for vistas near the surface
    const extent = THREE.MathUtils.clamp(alt * 6 + 6000, 6000, 26000);
    const st = this._sunState;
    const up = _v.copy(cam).normalize();
    const sunUp = up.dot(w.sunDir);
    if (sunUp < -0.25 || alt > 60000 || !this.meshes.size) { this.uniforms.uSunVisOn.value = 0; return; }
    const moved = st.pos.distanceTo(cam) > extent * 0.08 || st.sun.angleTo(w.sunDir) > 0.004 || Math.abs(st.extent - extent) > extent * 0.2;
    if (!moved && !this._sunDirty) { this.uniforms.uSunVisOn.value = 1; return; }
    this._sunDirty = false;
    st.pos.copy(cam); st.sun.copy(w.sunDir); st.extent = extent;
    // center the map a bit ahead of the camera so the visible vista is covered
    const camDir = this.level.camera.getWorldDirection(_v2);
    camDir.addScaledVector(up, -camDir.dot(up));
    const center = new THREE.Vector3().copy(cam).addScaledVector(camDir, extent * 0.45);
    center.setLength(this.R + Math.max(0, w.heightAt(_v.copy(center).normalize())));
    const sc = this._sunCam;
    const far = extent * 2 + this.relief * 4;
    sc.left = -extent; sc.right = extent; sc.top = extent; sc.bottom = -extent;
    sc.near = 1; sc.far = far * 2;
    // up vector for the ortho camera: anything not parallel to sunDir
    sc.up.copy(Math.abs(w.sunDir.y) > 0.9 ? _v.set(1, 0, 0) : _v.set(0, 1, 0));
    sc.position.copy(center).addScaledVector(w.sunDir, far);
    sc.lookAt(center);
    sc.updateMatrixWorld(); sc.updateProjectionMatrix();
    // render terrain depth: the terrain group alone, as its own render root
    // (own render state → the main scene's light setup is untouched)
    const r = this.engine.renderer;
    const prevRT = r.getRenderTarget(), prevAuto = r.autoClear;
    const sm = r.shadowMap.enabled;
    for (const m of this.meshes) m.material = this._depthMat;
    r.shadowMap.enabled = false;
    r.autoClear = true;
    r.setRenderTarget(this._sunRT);
    r.render(this.group, sc);
    r.setRenderTarget(prevRT);
    r.autoClear = prevAuto;
    r.shadowMap.enabled = sm;
    for (const m of this.meshes) m.material = this.material;
    // world → shadow uv / depth. Reversed depth: z already in [0, 1] (near = 1).
    const rev = !!sc.reversedDepth;
    const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, rev ? 1 : 0.5, rev ? 0 : 0.5, 0, 0, 0, 1);
    ss.matrix.copy(bias).multiply(sc.projectionMatrix).multiply(sc.matrixWorldInverse);
    ss.reversed = rev;
    const texel = (2 * extent) / this._sunRT.width;
    const range = sc.far - sc.near;
    this.uniforms.uSunVisParams.value.set(rev ? 1 : 0, (texel * 2.5 + 15) / range, texel * 1.2, 0);
    this.uniforms.uSunVisOn.value = 1;
    ss.extent = extent;
  }

  _syncSunMatrix() {
    // shader samples with detail-space coordinates: D = world - detailOrigin
    if (!this.sunShadow?.enabled) return;
    const o = this.detailOrigin;
    this.uniforms.uSunVisMatrix.value.copy(this.sunShadow.matrix).multiply(_m.makeTranslation(o.x, o.y, o.z));
  }

  dispose() {
    for (const w of this.workers || []) w.terminate();
    for (const m of [...(this.meshes || []), ...(this.pool || [])]) m.geometry.dispose();
    this.material?.dispose();
    this._sunRT?.dispose();
    this.group?.removeFromParent();
  }
}
