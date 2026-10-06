// Music theory for the generative score: modes, functional progressions per mode,
// tertian / quartal / jazz chord construction, voice leading by minimal motion,
// and motif development (sequence, inversion, retrograde, augmentation,
// fragmentation, ornament). Pure JS — no WebAudio here.

export function rng32(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  const f = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (lo, hi) => lo + (hi - lo) * f();
  f.int = (lo, hi) => lo + Math.floor(f() * (hi - lo + 1));
  f.pick = (arr) => arr[Math.floor(f() * arr.length) % arr.length];
  f.chance = (p) => f() < p;
  f.weighted = (items, weights) => {
    let s = 0; for (const w of weights) s += w;
    let r = f() * s;
    for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
    return items[items.length - 1];
  };
  return f;
}

export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const SCALES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  pentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  wholetone: [0, 2, 4, 6, 8, 10],
  jazz: [0, 2, 4, 5, 7, 9, 11],
};

// Functional progressions (0-based scale degrees), chosen to show each mode's
// characteristic colour: lydian's major II, dorian's major IV, phrygian's bII,
// mixolydian's bVII, harmonic minor's major V (leading tone).
const PROGRESSIONS = {
  ionian: [[0, 5, 3, 4], [0, 3, 0, 4], [0, 2, 5, 4], [5, 3, 0, 4]],
  lydian: [[0, 1, 0, 1], [0, 1, 5, 1], [0, 2, 1, 0], [0, 1, 6, 4], [5, 1, 0, 0]],
  dorian: [[0, 3, 0, 3], [0, 3, 6, 0], [0, 1, 3, 0], [0, 6, 3, 4], [0, 2, 3, 0]],
  phrygian: [[0, 1, 0, 1], [0, 1, 6, 0], [0, 5, 1, 0], [0, 6, 5, 1], [0, 3, 1, 0]],
  mixolydian: [[0, 6, 3, 0], [0, 4, 6, 3], [0, 6, 0, 3], [0, 3, 6, 0]],
  aeolian: [[0, 5, 6, 0], [0, 3, 5, 4], [0, 5, 2, 6], [0, 6, 5, 6], [0, 2, 5, 3]],
  locrian: [[0, 1, 0, 6], [0, 4, 1, 0]],
  harmonicMinor: [[0, 3, 4, 0], [0, 5, 3, 4], [0, 5, 1, 4], [0, 3, 5, 4]],
  pentatonic: [[0, 3, 4, 0], [0, 4, 1, 3], [0, 2, 3, 0], [3, 4, 0, 0]],
  minorPentatonic: [[0, 3, 2, 0], [0, 2, 4, 0]],
  wholetone: [[0, 1, 0, 2], [0, 5, 4, 0], [0, 1, 2, 1], [0, 3, 0, 1]],
};
PROGRESSIONS.major = PROGRESSIONS.ionian;
PROGRESSIONS.minor = PROGRESSIONS.aeolian;
PROGRESSIONS.jazz = PROGRESSIONS.ionian;

export function scaleOf(name) { return SCALES[name] || SCALES.aeolian; }
export function progressionsOf(name) { return PROGRESSIONS[name] || PROGRESSIONS.aeolian; }

/** Scale degree (any integer, may be negative) → semitones above the key root. */
export function degSemi(scale, deg) {
  const n = scale.length;
  const o = Math.floor(deg / n);
  return o * 12 + scale[deg - o * n];
}

/** Nearest scale degree to a semitone offset (relative to key root). */
export function nearestDeg(scale, semi) {
  const n = scale.length;
  let best = 0, bd = 1e9;
  const o = Math.floor(semi / 12);
  for (let oo = o - 1; oo <= o + 1; oo++) {
    for (let i = 0; i < n; i++) {
      const s = oo * 12 + scale[i];
      const d = Math.abs(s - semi);
      if (d < bd) { bd = d; best = oo * n + i; }
    }
  }
  return best;
}

/**
 * Chord on a scale degree. Returns { deg, root (semitones above key root, 0..11),
 * tones: semitone offsets from the key root (root position, ascending),
 * pcs: pitch classes relative to the key root, essential: pcs that define it }.
 */
export function chordOn(scaleName, deg, ext = 4) {
  const scale = scaleOf(scaleName);
  const n = scale.length;
  let degs;
  if (scaleName === 'pentatonic' || scaleName === 'minorPentatonic') degs = [0, 2, 4, 6].slice(0, Math.min(ext, 4)); // open, quartal-ish stacks
  else if (scaleName === 'wholetone') degs = [0, 2, 4, 1].slice(0, Math.min(ext, 4)); // augmented + added 9th
  else degs = [0, 2, 4, 6, 8].slice(0, ext);
  const tones = degs.map((d) => degSemi(scale, deg + d));
  const root = ((degSemi(scale, deg) % 12) + 12) % 12;
  const pcs = [...new Set(tones.map((t) => ((t % 12) + 12) % 12))];
  const essential = pcs.slice(0, Math.min(pcs.length, 3)).filter((_, i) => i !== 2 || n === 7); // root, 3rd (and 7th for diatonic)
  if (n === 7 && tones.length > 3) essential.push(((tones[3] % 12) + 12) % 12);
  return { deg, root, tones, pcs, essential: [...new Set(essential)] };
}

// ---- jazz -------------------------------------------------------------------------------------
const QUALITY = {
  maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], m11: [0, 3, 7, 10, 14, 17], 13: [0, 4, 10, 14, 21],
  '7b9': [0, 4, 7, 10, 13], '7alt': [0, 4, 10, 15, 20], m7b5: [0, 3, 6, 10], 69: [0, 4, 7, 9, 14],
  maj7s11: [0, 4, 7, 11, 18], '13sus': [0, 5, 10, 14, 21],
};
// Rootless voicing pcs (what the rhodes plays): guide tones first.
const ROOTLESS = {
  maj9: [4, 11, 14, 7], m9: [3, 10, 14, 7], m11: [3, 10, 14, 17], 13: [4, 10, 14, 21],
  '7b9': [4, 10, 13, 7], '7alt': [4, 10, 15, 20], m7b5: [3, 10, 6, 14], 69: [4, 9, 14, 7],
  maj7s11: [4, 11, 18, 14], '13sus': [5, 10, 14, 21],
};
// Lounge form (AABA, 4 beats per chord, in semitones above the key root) —
// ii–V–I cells, a VI7b9 turnaround, a backdoor bVII13 and a tritone-sub bII13.
const JAZZ_A1 = [[2, 'm9'], [7, '13'], [0, 'maj9'], [9, '7b9'], [2, 'm9'], [7, '7alt'], [0, 'maj9'], [0, '69']];
const JAZZ_A2 = [[2, 'm9'], [7, '13'], [4, 'm9'], [9, '7b9'], [2, 'm9'], [1, '13'], [0, 'maj9'], [0, 'maj9']];
const JAZZ_B = [[4, 'm7b5'], [9, '7b9'], [2, 'm11'], [2, 'm9'], [5, 'maj7s11'], [10, '13'], [4, 'm9'], [7, '13sus']];
export const JAZZ_FORM = [JAZZ_A1, JAZZ_A2, JAZZ_B, JAZZ_A2];

export function jazzChord(rootSemi, q) {
  const tones = QUALITY[q].map((x) => rootSemi + x);
  const rl = ROOTLESS[q].map((x) => rootSemi + x);
  const pcs = [...new Set(tones.map((t) => ((t % 12) + 12) % 12))];
  const rpcs = [...new Set(rl.map((t) => ((t % 12) + 12) % 12))];
  return { root: ((rootSemi % 12) + 12) % 12, quality: q, tones, pcs, rootless: rpcs, essential: rpcs.slice(0, 2) };
}

// ---- voice leading ----------------------------------------------------------------------------
/**
 * Choose n MIDI notes (ascending, no crossing) from the pitch classes `pcs`
 * (absolute 0..11) inside [lo, hi], minimizing motion from `prev` while
 * covering the essential tones and avoiding low-register mud.
 */
export function voiceLead(prev, pcs, n, lo, hi, essential = []) {
  const set = new Set(pcs);
  const pool = [];
  for (let m = lo; m <= hi; m++) if (set.has(m % 12)) pool.push(m);
  if (!pool.length) return [];
  const targets = prev && prev.length === n ? prev : Array.from({ length: n }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / n);
  const cands = targets.map((t) => pool.slice().sort((a, b) => Math.abs(a - t) - Math.abs(b - t)).slice(0, 4));
  let best = null, bs = 1e9;
  const cur = new Array(n);
  const rec = (i) => {
    if (i === n) {
      let s = 0;
      const have = new Set();
      for (let k = 0; k < n; k++) {
        s += Math.abs(cur[k] - targets[k]) * (prev ? 1 : 0.3);
        have.add(cur[k] % 12);
        if (k > 0) {
          const iv = cur[k] - cur[k - 1];
          if (iv <= 0) return;
          if (iv < 3 && cur[k - 1] < 55) s += 6; // mud
          if (iv === 1 && cur[k] > 74) s += 1; // tolerate bright clusters a bit
          if (iv > 12 && k < n - 1) s += 2;
        }
      }
      for (const e of essential) if (!have.has(e)) s += 5;
      s += (n - have.size) * (pcs.length >= n ? 3 : 1); // doubled pcs (only when a full chord fits)
      if (s < bs) { bs = s; best = cur.slice(); }
      return;
    }
    for (const c of cands[i]) { cur[i] = c; rec(i + 1); }
  };
  rec(0);
  if (best) return best;
  // fallback: close position from the bottom
  const out = [];
  for (const m of pool) { if (!out.length || m > out[out.length - 1]) out.push(m); if (out.length === n) break; }
  return out;
}

// ---- motifs -----------------------------------------------------------------------------------
const RHYTHM_CELLS = [
  [1, 1], [1.5, 0.5], [2], [0.5, 0.5, 1], [3, 1], [1, 0.5, 0.5], [0.75, 0.25, 1], [2, 1, 1], [1, 2, 1],
];

/** A motif: [{t, d, s}] — onset & duration in beats, s = scale-step offset from the anchor. */
export function makeMotif(rng, beats = 8, sparse = 0) {
  const notes = [];
  let t = 0, s = 0, lastLeap = 0;
  while (t < beats - 1.5) {
    const cell = rng.pick(RHYTHM_CELLS);
    for (const d of cell) {
      if (t + d > beats - 1) break;
      if (notes.length && rng.chance(sparse * 0.5)) { t += d; continue; } // breath
      notes.push({ t, d, s });
      let step;
      if (lastLeap) { step = -Math.sign(lastLeap) * rng.int(1, 2); lastLeap = 0; } // gap-fill after a leap
      else if (rng.chance(0.22)) { step = rng.pick([-4, -3, 3, 4, 5]); lastLeap = step; }
      else step = rng.pick([-2, -1, -1, 1, 1, 2]);
      if (Math.abs(s + step) > 6) step = -step;
      s += step;
      t += d;
    }
  }
  // cadence: a long note to close
  notes.push({ t: Math.max(t, beats - 2), d: 2, s: Math.round(s / 2) });
  return notes;
}

export const transform = {
  sequence: (m, k) => m.map((n) => ({ ...n, s: n.s + k })),
  invert: (m) => m.map((n) => ({ ...n, s: -n.s })),
  retrograde: (m) => {
    const end = Math.max(...m.map((n) => n.t + n.d));
    return m.map((n) => ({ ...n, t: end - n.t - n.d })).sort((a, b) => a.t - b.t);
  },
  augment: (m, f = 2, maxBeats = 8) => m.map((n) => ({ ...n, t: n.t * f, d: n.d * f })).filter((n) => n.t < maxBeats),
  fragment: (m) => {
    const half = m.slice(0, Math.max(2, Math.ceil(m.length / 2)));
    const span = Math.max(...half.map((n) => n.t + n.d));
    return [...half, ...half.map((n) => ({ ...n, t: n.t + span, s: n.s - 1 }))];
  },
  ornament: (m, rng) => {
    const out = [];
    for (const n of m) {
      if (n.d >= 1 && rng.chance(0.3)) {
        out.push({ ...n, d: 0.25, grace: true, s: n.s + 1 });
        out.push({ ...n, t: n.t + 0.25, d: n.d - 0.25 });
      } else out.push(n);
    }
    return out;
  },
};

/**
 * Realize a motif over a chord: anchor scale degree + steps; notes on strong
 * beats snap to chord tones, others stay diatonic. Returns [{t, d, midi}].
 */
export function realize(motif, { scale, keyRoot, anchorDeg, chordPcs, lo, hi, beatsPerBar = 4 }) {
  const out = [];
  for (const n of motif) {
    let semi = degSemi(scale, anchorDeg + n.s);
    const strong = !n.grace && (Math.abs(n.t % (beatsPerBar / 2)) < 1e-3);
    if (strong && chordPcs?.length) {
      let best = semi, bd = 99;
      for (let d = -3; d <= 3; d++) {
        const c = semi + d;
        if (chordPcs.includes(((c % 12) + 12) % 12) && Math.abs(d) < bd && scale.includes(((c % 12) + 12) % 12)) { bd = Math.abs(d); best = c; }
      }
      semi = best;
    }
    let midi = keyRoot + semi;
    while (midi > hi) midi -= 12;
    while (midi < lo) midi += 12;
    out.push({ t: n.t, d: n.d, midi });
  }
  return out;
}

export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
