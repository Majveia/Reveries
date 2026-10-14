// Builds the explorer's SDF meshes off the main thread.
import { buildExplorerData } from './Explorer.js';

self.onmessage = (e) => {
  try {
    const d = buildExplorerData(e.data.quality);
    const transfer = [];
    const collect = (o) => {
      for (const v of Object.values(o)) if (ArrayBuffer.isView(v)) transfer.push(v.buffer);
    };
    for (const k of ['body', 'hard', 'visor', 'collar']) collect(d[k]);
    self.postMessage({ ok: true, data: d }, transfer);
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.stack || err) });
  }
};
