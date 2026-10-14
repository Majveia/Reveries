// Terrain chunk worker (module worker). Holds its own copy of the height field
// (createTerrain is pure + deterministic, so every worker and the main thread
// agree bit-for-bit) and builds chunk meshes on request.
//
//   → { type: 'init', params }
//   → { type: 'build', id, job: { face, level, ix, iy, N, radius } }
//   ← { type: 'chunk', id, data }   (typed arrays transferred)
import { createTerrain } from './TerrainHeight.js';
import { buildChunk, transferables } from './ChunkBuilder.js';

let T = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    T = createTerrain(m.params);
    self.postMessage({ type: 'ready' });
    return;
  }
  if (m.type === 'build') {
    try {
      const data = buildChunk(T, m.job);
      self.postMessage({ type: 'chunk', id: m.id, data }, transferables(data));
    } catch (err) {
      self.postMessage({ type: 'error', id: m.id, message: String(err && err.stack || err) });
    }
  }
};
