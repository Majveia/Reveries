// Reveries — a playable universe.
//
// `?next=postfx,input,ui,audio` loads `src/core/PostFX.next.js` (etc.) instead
// of the live module, so sub-projects can test replacements of statically
// imported core files without breaking everyone else, then swap atomically.
import { Engine } from './core/Engine.js';

const params = new URLSearchParams(location.search);
const overrides = {};
const NEXT = {
  postfx: ['./core/PostFX.next.js', 'PostFX'],
  input: ['./core/Input.next.js', 'Input'],
  ui: ['./ui/UI.next.js', 'UI'],
  audio: ['./audio/Audio.next.js', 'AudioEngine'],
};
for (const key of (params.get('next') || '').split(',').filter(Boolean)) {
  const spec = NEXT[key];
  if (!spec) continue;
  try { overrides[spec[1]] = (await import(/* @vite-ignore */ spec[0]))[spec[1]]; }
  catch (e) { console.error(`[next] failed to load ${spec[0]}`, e); }
}

const engine = new Engine(params, overrides);
engine.start();
