// Quality tiers. Levels scale their workloads from these numbers so the same
// universe runs on a phone (tier 0–1) and a desktop GPU (tier 2–3).
//
// Override with ?q=low|medium|high|ultra

const TIERS = ['low', 'medium', 'high', 'ultra'];

export class Quality {
  constructor(params) {
    const forced = params.get('q');
    const coarse = matchMedia('(pointer: coarse)').matches;
    const small = Math.min(screen.width, screen.height) < 820;
    this.mobile = coarse && small;
    let tier = this.mobile ? 1 : 2;
    if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4 && this.mobile) tier = 1;
    if (forced && TIERS.includes(forced)) tier = TIERS.indexOf(forced);
    this.level = tier;
    this.tier = TIERS[tier];
    // Device pixel ratio bounds for adaptive resolution.
    const dpr = window.devicePixelRatio || 1;
    this.maxDpr = Math.min(dpr, [1.0, 1.5, 2.0, 2.0][tier]);
    this.minDpr = Math.min(this.maxDpr, [0.5, 0.6, 0.75, 1.0][tier]);
    this.msaa = [0, 0, 4, 4][tier];
    this.shadowMapSize = [1024, 2048, 2048, 4096][tier];
  }
  /** Pick a value per tier: q.pick(low, medium, high, ultra). */
  pick(...v) { return v[Math.min(this.level, v.length - 1)]; }
  /** Scale a base count for the tier (low 0.25x … ultra 1.5x). */
  scale(n) { return Math.round(n * [0.25, 0.5, 1, 1.5][this.level]); }
}
