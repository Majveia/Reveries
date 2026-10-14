// Lore — every world tells a fable. Inscriptions for settlements, landmarks,
// shrines, statues and murals, woven from the planet's myth, its culture's
// name, the architecture and the site itself. Deterministic per seed.

const STYLE_VOICE = {
  pastoral: { people: 'the wind-folk', craft: 'windmills and white walls', virtue: 'kindness', season: 'the long summer', sky: 'cumulus towers', relic: 'a bell cast from a fallen star' },
  monolithic: { people: 'the sand-keepers', craft: 'walls that outlast the dunes', virtue: 'patience', season: 'the dry centuries', sky: 'the white sun', relic: 'a blade of black glass' },
  temple: { people: 'the mountain monks', craft: 'roofs that curve like a brushstroke', virtue: 'stillness', season: 'the season of falling maples', sky: 'the mist', relic: 'a staff that weighs as much as a mountain' },
  organic: { people: 'the grown ones', craft: 'houses that are coaxed, not built', virtue: 'listening', season: 'the bloom', sky: 'the drifting spores', relic: 'a seed that hums' },
  outpost: { people: 'the settlers', craft: 'hulls, cables and patience', virtue: 'endurance', season: 'the long night', sky: 'the ships overhead', relic: 'the first landing beacon, still blinking' },
  gothic: { people: 'the oathbound', craft: 'spires and buttresses', virtue: 'devotion', season: 'the age of the golden tree', sky: 'the gilded haze', relic: 'a crown no one may wear' },
  neon: { people: 'the night crews', craft: 'light and rust', virtue: 'nerve', season: 'the rains', sky: 'the smog and the signs', relic: 'a song nobody remembers writing' },
  ruins: { people: 'the vanished', craft: 'stones too large for hands', virtue: 'memory', season: 'the age before ages', sky: 'the pale light', relic: 'a face worn smooth by wind' },
};

const SETTLEMENT = [
  (c) => `${c.name} was founded where ${c.voice.people} first saw ${c.voice.sky} part. They say ${c.epithet} can be heard from its square at dusk.`,
  (c) => `Carved over the gate of ${c.name}: "We are ${c.culture}. We keep ${c.voice.virtue} the way others keep gold."`,
  (c) => `${c.name}, a ${c.kind} of ${c.culture}. Its people are known across ${c.planet} for ${c.voice.craft}.`,
  (c) => `The elders of ${c.name} still count the years from ${c.voice.season}. The children no longer ask what came before.`,
  (c) => `${c.name} — "the place that stayed". When the others left for ${c.epithet}, its founders lit a lantern and remained.`,
];
const LANDMARK = [
  (c) => `${c.title}. ${c.myth}`,
  (c) => `${c.title}. No record says who raised it. ${c.culture} songs call it the last gift of ${c.epithet}.`,
  (c) => `${c.title}. Pilgrims touch it once and do not speak until they reach home. ${c.myth}`,
  (c) => `${c.title}. It was here before ${c.culture}, and it will be here after. The wind around it never quite stops.`,
];
const SHRINE = [
  (c) => `A small shrine, worn by hands. The inscription reads: "For ${c.voice.relic}, which we lost, and will find again."`,
  (c) => `Offerings of bread and paper flowers. A plaque: "${c.culture} remember the ones who crossed ${c.epithet}."`,
  (c) => `A mural, sun-faded: ${c.voice.people} holding up ${c.voice.relic} beneath ${c.voice.sky}.`,
  (c) => `A statue of the founder of ${c.name}. Someone has left a lit lantern at its feet, as someone always does.`,
  (c) => `Chalk marks on the stone count something — days, ships, the dead. The last mark is fresh.`,
  (c) => `"Here ${c.voice.people} first agreed to stay." The words are carved low, at a child's height, on purpose.`,
  (c) => `A basin of rainwater and a single coin at the bottom. Local custom: you may take the coin only if you leave a story.`,
  (c) => `A painted map of ${c.planet} that is wrong in every detail but one: the road to ${c.epithet}.`,
  (c) => `Ribbons tied to an iron ring, faded to every colour. Each is a promise. Most, the ${c.culture} say, were kept.`,
  (c) => `A verse cut into the lintel: "Build slowly. The sky is patient, and so is ${c.voice.season}."`,
];

function ctxFor(o) {
  const P = o.planet;
  return {
    name: o.site?.name || P.name, planet: P.name, culture: P.civ?.culture || 'the first ones',
    epithet: P.lore?.epithet || 'the far shore', myth: P.lore?.myth || '', kind: o.kind || o.site?.kind || 'town',
    voice: STYLE_VOICE[o.style] || STYLE_VOICE.pastoral, title: o.title || '',
  };
}

/** Deterministic inscription text for a POI kind: 'settlement' | 'landmark' | 'shrine' | … */
export function inscription(rng, kind, o) {
  const c = ctxFor(o);
  const pool = kind === 'settlement' ? SETTLEMENT : kind === 'landmark' ? LANDMARK : SHRINE;
  // rotate through the pool so neighbouring shrines never repeat
  const used = (rng.__lore ||= {});
  const start = used[kind] ?? Math.floor(rng.float() * pool.length);
  used[kind] = start + 1;
  return pool[start % pool.length](c);
}
