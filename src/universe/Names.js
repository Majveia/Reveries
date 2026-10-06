// Procedural names with distinct "languages", so a world's cities, its sun and
// its myths sound like they belong to the same culture.

import { Random } from '../core/Random.js';

const LANGS = {
  // soft, flowing (Miyazaki / Le Guin)
  aether: { on: ['', '', 'l', 'v', 's', 'th', 'n', 'm', 'r', 'y', 'el', 'a'], nu: ['a', 'e', 'i', 'o', 'ae', 'ia', 'ei', 'ou', 'u'], co: ['l', 'n', 'r', 's', 'th', 'v', 'ri', 'la', 'm', 'nd', 'ss'], end: ['', '', 'a', 'el', 'is', 'eth', 'ara', 'ien', 'or', 'wyn', 'ys'] },
  // hard, ancient (Dune / Hyperion)
  dune: { on: ['k', 'q', 'z', 'kh', 'd', 'g', 'r', 'ar', 'sh', 'j', 't'], nu: ['a', 'aa', 'u', 'i', 'ai', 'e'], co: ['r', 'k', 'q', 'z', 'dh', 'n', 'kr', 'sh', 'rr', 'th', 'm'], end: ['', 'ak', 'ar', 'is', 'un', 'ath', 'ir', 'oon', 'esh', 'az'] },
  // lyrical (Tolkien-ish elvish)
  sylvan: { on: ['', 'gal', 'el', 'ith', 'lor', 'cel', 'fae', 'ny', 'thal', 'mir', 'ar'], nu: ['a', 'e', 'i', 'ie', 'ae', 'o', 'ui'], co: ['l', 'nd', 'th', 'r', 'n', 'ss', 'dh', 'ri', 'v'], end: ['iel', 'ion', 'wen', 'dor', 'las', 'ril', 'eth', 'ath', 'ë', 'in'] },
  // clipped futurist (Bebop / Cyberpunk)
  neon: { on: ['v', 'x', 'k', 'z', 'n', 't', 'r', 'ky', 'jo', 'ra'], nu: ['o', 'a', 'e', 'i', 'u', 'y'], co: ['x', 'k', 'n', 't', 'z', 'r', 'v', 'g', 'ck'], end: ['', 'o', 'ex', 'ix', 'on', 'a', 'ko', 'ra', 'en'] },
  // deep, guttural (Lovecraft / Giger)
  void: { on: ['', 'ph', 'gh', 'th', 'n', 'cth', 'y', 'az', 'hr', 'z'], nu: ['u', 'o', 'a', 'ua', 'oo', 'ü', 'y'], co: ['l', 'gh', 'th', 'n', 'gg', 'th', 'lh', 'rr', 'q'], end: ['', 'oth', 'ul', 'a', 'uth', 'agg', 'yr', 'on'] },
  // Japanese-like (Ghibli / Sekiro)
  kaze: { on: ['k', 's', 't', 'n', 'h', 'm', 'y', 'r', 'w', 'sh', 'ch', 'ts', ''], nu: ['a', 'i', 'u', 'e', 'o'], co: [''], end: ['', '', 'n', 'ra', 'shi', 'to', 'ka', 'mi', 'ru'] },
  // Latin/Greek scientific (Kubrick / Clarke)
  classic: { on: ['', 'h', 'c', 'p', 'th', 'l', 'm', 'v', 'aur', 'ast', 'pr'], nu: ['a', 'e', 'i', 'o', 'u', 'ae', 'eu', 'y'], co: ['r', 'l', 'n', 's', 'st', 'ct', 'ph', 'rd', 'x', 'nt'], end: ['us', 'a', 'is', 'on', 'ium', 'ea', 'ix', 'or', 'ae', 'es'] },
};
export const LANGUAGES = Object.keys(LANGS);

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Generate a name. rng: Random; lang: key of LANGS; syl: syllable count. */
export function makeName(rng, lang = 'aether', syl = null) {
  const L = LANGS[lang] || LANGS.aether;
  const n = syl ?? rng.weighted([0, 3, 5, 3, 1]);
  let s = rng.pick(L.on);
  for (let i = 0; i < n; i++) {
    s += rng.pick(L.nu);
    if (i < n - 1) s += rng.pick(L.co) || rng.pick(L.on);
  }
  s += rng.pick(L.end);
  s = s.replace(/(.)\1\1+/g, '$1$1');
  if (s.length < 3) s += rng.pick(L.nu) + rng.pick(L.co);
  return cap(s);
}

/** Catalog designations like real astronomy: "HD 40307", "NGC 4414", "Kepler-442". */
export function catalogName(rng, kind) {
  switch (kind) {
    case 'galaxy': return rng.pick(['NGC', 'UGC', 'IC', 'PGC', 'ESO']) + ' ' + rng.int(100, 9999);
    case 'star': return rng.pick(['HD', 'HIP', 'Gliese', 'Kepler-', 'TOI-', 'LHS', 'Wolf', 'Ross']) + (rng.chance(0.5) ? ' ' : '') + rng.int(10, 99999);
    case 'nebula': return rng.pick(['NGC', 'IC', 'Sh2-', 'M', 'RCW']) + ' ' + rng.int(1, 3000);
    default: return 'X-' + rng.int(1000, 9999);
  }
}

/** "Eloh-Vara", "the Shattered Reach", poetic place names for features. */
export function epithet(rng) {
  const adj = ['Silent', 'Drowned', 'Burning', 'Hollow', 'Shattered', 'Singing', 'Pale', 'Gilded', 'Sleeping', 'Weeping', 'Endless', 'Hidden', 'Crimson', 'Ashen', 'Verdant', 'Lantern', 'Forgotten', 'Glass', 'Iron', 'Last'];
  const noun = ['Reach', 'Spire', 'Expanse', 'Sea', 'Choir', 'Gate', 'Garden', 'Throne', 'Crown', 'Veil', 'Basin', 'Steppe', 'Archive', 'Cradle', 'Halls', 'Shore', 'Wastes', 'Vale', 'Lighthouse', 'Orchard'];
  return `the ${rng.pick(adj)} ${rng.pick(noun)}`;
}

export { Random };
