// Ocean height-bake worker (module worker). Holds its own copy of the pure
// terrain height field and bakes "terrain height − sea level" maps:
//
//   → { type: 'init', params, sea }
//   → { type: 'global', id, w, h }                       equirect map (lon × lat)
//   → { type: 'local', id, n, A:[x,y,z], T1, T2, U, Rs, cx, cz, extent }
//                                                       anchor-plane map around (cx, cz)
//   ← { type: 'done', id, data: Float32Array }
import { createTerrain } from '../terrain/TerrainHeight.js';
import { bakeGlobal, bakeLocal } from './heightBake.js';

let T = null, sea = 0;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { T = createTerrain(m.params); sea = m.sea; self.postMessage({ type: 'ready' }); return; }
  try {
    const data = m.type === 'global' ? bakeGlobal(T, sea, m.w, m.h) : bakeLocal(T, sea, m);
    self.postMessage({ type: 'done', id: m.id, data }, [data.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.stack || err) });
  }
};
