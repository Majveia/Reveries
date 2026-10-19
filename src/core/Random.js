// Deterministic randomness. Everything in Reveries derives from seeds so that
// every galaxy, star, world and city is reproducible from its address.

/** 32-bit string hash (FNV-1a, then avalanche). */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return avalanche(h);
}

/** Final mix (murmur3 fmix32). */
export function avalanche(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Combine any number of numbers/strings into one 32-bit seed. */
export function seedFrom(...parts) {
  let h = 0x9e3779b9;
  for (const p of parts) {
    const v = typeof p === 'number' ? (Number.isInteger(p) ? p | 0 : Math.floor(p * 1e6) | 0) : hashString(String(p));
    h = avalanche((h ^ v) + 0x9e3779b9 + (h << 6) + (h >>> 2));
  }
  return h >>> 0;
}

/** Integer lattice hashes → uint32. Useful for cell-based scatter. */
export function hash2i(x, y, seed = 0) {
  let h = seed >>> 0;
  h = avalanche(h ^ Math.imul(x | 0, 0x27d4eb2d));
  h = avalanche(h ^ Math.imul(y | 0, 0x165667b1));
  return h;
}
export function hash3i(x, y, z, seed = 0) {
  let h = seed >>> 0;
  h = avalanche(h ^ Math.imul(x | 0, 0x27d4eb2d));
  h = avalanche(h ^ Math.imul(y | 0, 0x165667b1));
  h = avalanche(h ^ Math.imul(z | 0, 0x9e3779b1));
  return h;
}
/** uint32 → [0,1) */
export const u01 = (h) => (h >>> 0) / 4294967296;

/** Small fast seeded PRNG (sfc32) with convenience helpers. */
export class Random {
  constructor(seed = 1) {
    if (typeof seed === 'string') seed = hashString(seed);
    this.seed = seed >>> 0;
    this.a = 0x9e3779b9 ^ this.seed;
    this.b = 0x243f6a88 ^ avalanche(this.seed + 1);
    this.c = 0xb7e15162 ^ avalanche(this.seed + 2);
    this.d = 1;
    for (let i = 0; i < 12; i++) this.nextU32();
  }
  nextU32() {
    let { a, b, c, d } = this;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return t >>> 0;
  }
  /** [0,1) */
  float() { return this.nextU32() / 4294967296; }
  range(a, b) { return a + (b - a) * this.float(); }
  int(a, b) { return a + Math.floor(this.float() * (b - a + 1)); } // inclusive
  chance(p) { return this.float() < p; }
  sign() { return this.float() < 0.5 ? -1 : 1; }
  pick(arr) { return arr[Math.floor(this.float() * arr.length)]; }
  /** weights: array of numbers, or object {key: weight} → returns index or key */
  weighted(weights) {
    if (Array.isArray(weights)) {
      let total = 0; for (const w of weights) total += w;
      let r = this.float() * total;
      for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
      return weights.length - 1;
    }
    const keys = Object.keys(weights);
    return keys[this.weighted(keys.map((k) => weights[k]))];
  }
  /** Standard normal (Box–Muller). */
  gaussian(mean = 0, sd = 1) {
    let u = 0, v = 0;
    while (u === 0) u = this.float();
    v = this.float();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** Log-uniform between a and b (both > 0). */
  logRange(a, b) { return Math.exp(this.range(Math.log(a), Math.log(b))); }
  /** Uniform unit vector as [x,y,z]. */
  unitVector() {
    const z = this.range(-1, 1), t = this.range(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
    return [r * Math.cos(t), r * Math.sin(t), z];
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(this.float() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }
  /** Independent child stream, stable for a given label. */
  fork(label) { return new Random(seedFrom(this.seed, label)); }
}
