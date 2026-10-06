// The Universe catalog: a deterministic, lazily-evaluated hierarchy
//   cosmos → galaxies → stars → planets (→ moons, rings, belts, comets)
// Every object is a pure function of its address, so the universe is
// effectively infinite yet perfectly reproducible and shareable by URL.
//
// Address: { g: galaxyId, s: starIndex, p: planetIndex }

import { Random, seedFrom } from '../core/Random.js';
import { makeName, catalogName, epithet } from './Names.js';
import { AESTHETICS, aestheticFor } from './Aesthetics.js';
import {
  SPECTRAL, massLuminosity, massRadius, effectiveTemp, habitableZone, equilibriumTemp,
  blackbodyColor, rockyRadius, msLifetime,
} from './Astro.js';

const PLANET_KINDS = ['terran', 'ocean', 'desert', 'ice', 'lava', 'jungle', 'toxic', 'barren', 'exotic', 'gas'];
const LANG_FOR = { dune: 'dune', ghibli: 'kaze', moebius: 'aether', kubrick: 'classic', tarkovsky: 'classic', ueda: 'sylvan', pandora: 'aether', bebop: 'neon', erdtree: 'sylvan', wukong: 'kaze', interstellar: 'classic', rick: 'neon', nausicaa: 'kaze', frontier: 'neon', inferno: 'void', glacier: 'sylvan' };

const cache = new Map();
const memo = (key, fn) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };

export class Universe {
  constructor(seed = 'reveries') {
    this.seed = typeof seed === 'number' ? seed : seedFrom(seed);
    this.name = 'Reveries';
  }

  // ---- galaxies ---------------------------------------------------------------
  /** Galaxy id 0 is the home galaxy (a grand-design barred spiral). */
  galaxy(id) {
    return memo(`g${id}`, () => {
      const rng = new Random(seedFrom(this.seed, 'galaxy', id));
      const type = id === 0 ? 'barred' : rng.pick(['spiral', 'spiral', 'barred', 'barred', 'elliptical', 'irregular', 'lenticular', 'ring']);
      const spiralish = type === 'spiral' || type === 'barred' || type === 'ring';
      const radiusKpc = id === 0 ? 16 : rng.logRange(4, 30);
      const hueCore = rng.range(0.06, 0.12), hueArms = rng.range(0.55, 0.66);
      const g = {
        id, seed: rng.seed, type,
        name: id === 0 ? 'The Reverie' : makeName(rng, rng.pick(['classic', 'sylvan', 'aether'])),
        designation: catalogName(rng, 'galaxy'),
        arms: spiralish ? (id === 0 ? 2 : rng.weighted({ 2: 5, 3: 2, 4: 2, 5: 1 }) * 1) : 0,
        pitch: spiralish ? rng.range(11, 24) : 0, // degrees
        radiusKpc,
        thicknessKpc: radiusKpc * rng.range(0.02, 0.05),
        bulge: type === 'elliptical' ? 1 : type === 'lenticular' ? 0.6 : rng.range(0.15, 0.4),
        bar: type === 'barred' ? rng.range(0.25, 0.45) : 0,
        dust: type === 'elliptical' ? 0.05 : rng.range(0.5, 1.0),
        starFormation: type === 'elliptical' ? 0.05 : rng.range(0.4, 1.0),
        armWinding: rng.range(0.85, 1.25),
        colorCore: hslToRgb(hueCore, 0.55, 0.72),
        colorArms: hslToRgb(hueArms, rng.range(0.4, 0.7), 0.7),
        colorHII: hslToRgb(rng.range(0.92, 0.99), 0.7, 0.62),
        massSun: rng.logRange(1e10, 1e12),
        blackHoleMassSun: rng.logRange(1e6, 1e9),
        tilt: rng.range(0, Math.PI), // inclination for cosmos rendering
        starCatalogSize: 4096,
      };
      return g;
    });
  }

  /**
   * Sample a position (kpc, galaxy plane = xz, y up) inside a galaxy using its
   * morphology: exponential disk + log-spiral arm density + bar + bulge.
   * Returns { x, y, z, arm (0..1 arm proximity), r }.
   */
  galaxySample(g, rng) {
    const R = g.radiusKpc, h = R * 0.28; // disk scale length
    if (g.type === 'elliptical' || rng.chance(g.bulge * 0.35)) {
      // de Vaucouleurs-ish bulge / elliptical: concentrated, flattened
      const r = R * 0.18 * Math.pow(rng.float(), 2.2) * (g.type === 'elliptical' ? 3 : 1);
      const [ux, uy, uz] = rng.unitVector();
      return { x: ux * r, y: uy * r * (g.type === 'elliptical' ? 0.7 : 0.55), z: uz * r, arm: 0, r };
    }
    if (g.bar > 0 && rng.chance(0.12)) {
      const along = rng.gaussian(0, R * g.bar * 0.45), across = rng.gaussian(0, R * 0.04);
      return { x: along, y: rng.gaussian(0, g.thicknessKpc * 0.6), z: across, arm: 0.6, r: Math.abs(along) };
    }
    // radius from exponential disk (Gamma(2) for surface density × r)
    let r = -h * Math.log(rng.float() * rng.float() + 1e-9);
    r = Math.min(r, R * 1.15);
    let theta = rng.float() * Math.PI * 2;
    let arm = 0;
    if (g.arms > 0) {
      // Pull toward the nearest log-spiral arm: θ_arm(r) = ln(r)/tan(pitch) + 2πk/arms
      const k = 1 / Math.tan((g.pitch * Math.PI) / 180) * g.armWinding;
      const armIdx = Math.floor(rng.float() * g.arms);
      const base = Math.log(Math.max(r, 0.3) / (R * 0.12)) * k + (armIdx * 2 * Math.PI) / g.arms + (g.bar > 0 ? 0 : 0);
      const spread = rng.gaussian(0, 0.32 + 0.25 * (1 - g.starFormation));
      const pull = rng.float() < 0.78 ? 1 : 0; // 22% inter-arm population
      theta = pull ? base + spread : theta;
      arm = pull ? Math.exp(-spread * spread * 6) : 0;
    }
    const y = rng.gaussian(0, g.thicknessKpc * (1 - 0.5 * Math.min(1, r / R)));
    return { x: Math.cos(theta) * r, y, z: Math.sin(theta) * r, arm, r };
  }

  // ---- stars ------------------------------------------------------------------
  star(gid, index) {
    return memo(`g${gid}s${index}`, () => {
      const g = this.galaxy(gid);
      const rng = new Random(seedFrom(g.seed, 'star', index));
      const pos = this.galaxySample(g, rng.fork('pos'));
      // Spectral class by abundance, but bias the catalog toward interesting stars.
      const weights = SPECTRAL.map((s) => (s.cls === 'M' ? s.abundance * 0.25 : s.cls === 'G' || s.cls === 'K' ? s.abundance * 2.5 : s.abundance * (pos.arm > 0.5 ? 40 : 6)));
      let sp = SPECTRAL[rng.weighted(weights)];
      if (gid === 0 && index === 0) sp = SPECTRAL[4]; // home star: G
      const t = rng.float();
      let mass = sp.mass[0] + (sp.mass[1] - sp.mass[0]) * t;
      let kind = 'main';
      const roll = rng.float();
      if (index !== 0 && roll < 0.025) kind = 'giant';
      else if (index !== 0 && roll < 0.035) kind = 'whiteDwarf';
      else if (index !== 0 && roll < 0.04) kind = 'neutron';
      let L = massLuminosity(mass), Rr = massRadius(mass);
      if (kind === 'giant') { Rr *= rng.range(10, 80); L *= rng.range(30, 300); }
      if (kind === 'whiteDwarf') { Rr = 0.012; L = 0.002; mass = rng.range(0.5, 1.2); }
      if (kind === 'neutron') { Rr = 1.5e-5; L = 0.0005; mass = rng.range(1.3, 2.1); }
      const temp = kind === 'neutron' ? 600000 : kind === 'giant' ? rng.range(3200, 4800) : effectiveTemp(L, Rr);
      const sub = Math.min(9, Math.floor((1 - t) * 10));
      const lumClass = kind === 'giant' ? 'III' : kind === 'whiteDwarf' ? '' : 'V';
      const cls = kind === 'whiteDwarf' ? 'DA' : kind === 'neutron' ? 'NS' : `${kind === 'giant' ? (temp < 4000 ? 'M' : 'K') : sp.cls}${sub}${lumClass}`;
      const lang = rng.pick(['classic', 'aether', 'sylvan', 'dune', 'kaze', 'neon']);
      return {
        id: `g${gid}-s${index}`, galaxyId: gid, index, seed: rng.seed, kind, cls,
        name: gid === 0 && index === 0 ? 'Aurelia' : makeName(rng, lang),
        designation: catalogName(rng, 'star'), lang,
        temp, massSun: mass, radiusSun: Rr, lumSun: L,
        color: blackbodyColor(Math.min(temp, 40000)),
        ageGyr: Math.min(13, rng.range(0.1, 1) * msLifetime(mass)),
        position: [pos.x, pos.y, pos.z], arm: pos.arm,
        hz: habitableZone(L),
        planetCount: kind === 'neutron' ? rng.int(0, 2) : gid === 0 && index === 0 ? 7 : rng.weighted([1, 3, 5, 6, 6, 5, 4, 3, 2, 1]),
      };
    });
  }

  // ---- systems & planets ---------------------------------------------------------
  system(gid, sIndex) {
    return memo(`g${gid}s${sIndex}sys`, () => {
      const star = this.star(gid, sIndex);
      const rng = new Random(seedFrom(star.seed, 'system'));
      const planets = [];
      for (let i = 0; i < star.planetCount; i++) planets.push(this.planet(gid, sIndex, i));
      const belts = [];
      // Asteroid belt beyond the last rocky planet / frost line.
      const frost = 2.7 * Math.sqrt(star.lumSun);
      if (rng.chance(0.75)) belts.push({ inner: frost * 0.75, outer: frost * 1.05, count: 4000, color: [0.55, 0.5, 0.45], kind: 'asteroid' });
      if (rng.chance(0.5)) belts.push({ inner: frost * 12, outer: frost * 18, count: 2500, color: [0.6, 0.66, 0.75], kind: 'kuiper' });
      const comets = [];
      const nc = rng.int(1, 4);
      for (let c = 0; c < nc; c++) {
        comets.push({ name: `C/${2026 + c} ${makeName(rng, 'classic', 1)}`, a: frost * rng.range(4, 14), e: rng.range(0.82, 0.97), i: rng.range(0, 0.9), node: rng.range(0, 6.283), peri: rng.range(0, 6.283), M0: rng.range(0, 6.283) });
      }
      return { star, planets, belts, comets };
    });
  }

  planet(gid, sIndex, pIndex) {
    return memo(`g${gid}s${sIndex}p${pIndex}`, () => {
      const star = this.star(gid, sIndex);
      const rng = new Random(seedFrom(star.seed, 'planet', pIndex));
      const home = gid === 0 && sIndex === 0;
      // Titius–Bode-like spacing with jitter.
      const a = (0.32 + 0.33 * Math.pow(1.72, pIndex) * rng.range(0.85, 1.15)) * Math.sqrt(star.lumSun) * (home ? 1 : rng.range(0.7, 1.3));
      const Teq = equilibriumTemp(star.lumSun, a, 0.3);
      const [hzIn, hzOut] = star.hz;
      const inHZ = a >= hzIn && a <= hzOut;
      const frost = 2.7 * Math.sqrt(star.lumSun);

      let kind;
      const HOME_KINDS = [['lava', 'inferno'], ['desert', 'dune'], ['terran', 'ghibli'], ['terran', 'wukong'], ['jungle', 'pandora'], ['gas', null], ['ice', 'glacier']];
      let aesthetic = null;
      if (home) { [kind, aesthetic] = HOME_KINDS[pIndex % HOME_KINDS.length]; }
      else if (a > frost * 1.1 && rng.chance(0.65)) kind = 'gas';
      else if (Teq > 700) kind = 'lava';
      else if (Teq > 330) kind = rng.pick(['desert', 'desert', 'barren', 'toxic', 'exotic']);
      else if (inHZ) kind = rng.pick(['terran', 'terran', 'ocean', 'jungle', 'jungle', 'exotic', 'toxic', 'desert']);
      else if (Teq < 200) kind = rng.pick(['ice', 'ice', 'barren', 'exotic']);
      else kind = rng.pick(['barren', 'desert', 'ice', 'toxic', 'exotic']);
      if (!aesthetic && kind !== 'gas') aesthetic = aestheticFor(kind, rng.fork('aesthetic'));
      const A = aesthetic ? AESTHETICS[aesthetic] : null;

      const gas = kind === 'gas';
      const massEarth = gas ? rng.logRange(15, 900) : rng.logRange(0.08, 6);
      const radiusEarth = gas ? Math.min(11.5, 3.5 + Math.pow(massEarth, 0.32)) : rockyRadius(massEarth);
      const gravityG = massEarth / (radiusEarth * radiusEarth);
      const lang = A ? (LANG_FOR[aesthetic] || 'aether') : star.lang;
      const name = home ? ['Ember', 'Arrakeen', 'Laputa', 'Huaguo', 'Eywa', 'Saturnine', 'Isolde'][pIndex] : makeName(rng, lang);
      const life = kind === 'gas' ? 0 : inHZ || ['jungle', 'terran', 'ocean'].includes(kind) ? rng.range(0.55, 1) : kind === 'toxic' || kind === 'exotic' ? rng.range(0.25, 0.8) : rng.range(0, 0.25);
      let civLevel = 0;
      if (!gas) {
        const p = life * 0.9 + 0.15;
        civLevel = rng.chance(p) ? rng.weighted([0, 2, 3, 3, 2, 1]) : rng.chance(0.4) ? 1 : 0; // 1 = ruins only
        if (home && pIndex >= 1 && pIndex <= 4) civLevel = [0, 2, 3, 3, 2][pIndex];
        if (home && pIndex === 0) civLevel = 1;
        if (home && pIndex === 6) civLevel = 2;
        if (A && A.architecture === 'outpost') civLevel = Math.max(civLevel, 2);
      }
      const hasRings = gas ? rng.chance(0.55) || (home && pIndex === 5) : rng.chance(0.06);
      const moons = [];
      const nm = gas ? rng.int(2, 6) : rng.weighted([5, 4, 2, 1]);
      for (let m = 0; m < nm; m++) {
        moons.push({
          name: makeName(rng, lang, 1), radiusRel: gas ? rng.range(0.02, 0.08) : rng.range(0.08, 0.32),
          distance: (gas ? 2.2 : 3.2) + m * rng.range(1.2, 2.4), color: hslToRgb(rng.range(0, 1), rng.range(0, 0.25), rng.range(0.45, 0.8)),
          phase: rng.range(0, 6.283), incl: rng.range(-0.25, 0.25), kind: rng.pick(['barren', 'ice', 'barren', 'lava']),
        });
      }
      const culture = A ? makeName(rng.fork('culture'), lang, 2) : null;
      const planet = {
        id: `g${gid}-s${sIndex}-p${pIndex}`, galaxyId: gid, starIndex: sIndex, index: pIndex, seed: rng.seed,
        name, designation: `${star.designation} ${'bcdefghijk'[pIndex]}`,
        kind, aesthetic, landable: !gas,
        massEarth, radiusEarth, gravityG, tempK: Teq, inHabitableZone: inHZ,
        dayLengthHours: rng.logRange(8, 60), axialTiltDeg: rng.range(0, 35),
        orbit: { a, e: rng.range(0, 0.12) * (home ? 0.4 : 1), i: rng.range(0, 0.06), node: rng.range(0, 6.283), peri: rng.range(0, 6.283), M0: rng.range(0, 6.283), periodDays: 365.25 * Math.sqrt((a * a * a) / star.massSun) },
        world: gas ? null : {
          radius: Math.round(THREE_CLAMP(36000 * Math.pow(radiusEarth, 0.6), 22000, 70000)), // playable radius (m)
          relief: (A?.terrain.relief ?? 0.6) * rng.range(1600, 2600), // peak height scale (m)
          seaLevel: A?.terrain.ocean ?? 0.2, // fraction of surface under water (approx)
          atmosphereHeight: 0, // filled below
        },
        atmosphere: A ? { ...A.atmo, present: A.atmo.density > 0.05 } : { present: gas, rayleigh: [0.3, 0.35, 0.5], density: 1, mie: 0.3, mieColor: '#ffffff', haze: 0.2 },
        gasBands: gas ? { colors: [hslToRgb(rng.range(0.02, 0.15), rng.range(0.3, 0.6), rng.range(0.45, 0.75)), hslToRgb(rng.range(0.05, 0.6), rng.range(0.2, 0.5), rng.range(0.55, 0.85)), hslToRgb(rng.range(0, 1), rng.range(0.2, 0.5), rng.range(0.3, 0.6))], storms: rng.int(0, 3), turbulence: rng.range(0.3, 1) } : null,
        rings: hasRings ? { inner: rng.range(1.3, 1.6), outer: rng.range(2.0, 2.8), color: hslToRgb(rng.range(0.05, 0.12), rng.range(0.1, 0.35), rng.range(0.6, 0.85)), opacity: rng.range(0.4, 0.85), tilt: rng.range(-0.5, 0.5) } : null,
        moons,
        life,
        civ: { level: civLevel, culture, lang, settlements: civLevel <= 1 ? (civLevel === 1 ? rng.int(2, 5) : 0) : rng.int(3, 4 + civLevel * 2), population: civLevel >= 2 ? Math.round(Math.pow(10, 3 + civLevel * 1.4 + rng.range(-0.5, 0.5))) : 0 },
        palette: A ? A.palette : null,
        lore: null,
      };
      if (planet.world) planet.world.atmosphereHeight = planet.atmosphere.present ? Math.round(planet.world.radius * 0.12) : 0;
      planet.lore = makeLore(planet, rng.fork('lore'));
      return planet;
    });
  }

  /** Human-readable breadcrumb for an address. */
  crumbs(addr = {}) {
    const out = [{ label: 'Universe', level: 'cosmos', addr: {} }];
    if (addr.g != null) out.push({ label: this.galaxy(addr.g).name, level: 'galaxy', addr: { g: addr.g } });
    if (addr.s != null) out.push({ label: this.star(addr.g, addr.s).name, level: 'system', addr: { g: addr.g, s: addr.s } });
    if (addr.p != null) out.push({ label: this.planet(addr.g, addr.s, addr.p).name, level: 'planet', addr: { g: addr.g, s: addr.s, p: addr.p } });
    return out;
  }
}

function THREE_CLAMP(x, a, b) { return Math.max(a, Math.min(b, x)); }

/** HSL (0..1) → linear-ish RGB array (sRGB values; convert with THREE.Color). */
export function hslToRgb(h, s, l) {
  const k = (n) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

const MYTH = [
  (n, c, e) => `The ${c} say ${n} was sung into being by a whale that swam between stars, and that ${e} is where its song still echoes.`,
  (n, c, e) => `Every ${c} child learns the first rule: never sleep in ${e} when both moons are full.`,
  (n, c, e) => `Before the cities, the ${c} were wind. They remember it in the way they build — open to the sky, unafraid of falling.`,
  (n, c, e) => `Pilgrims cross ${e} carrying a single lantern. If it is still lit when they arrive, they are forgiven.`,
  (n, c, e) => `The ${c} keep no calendar. They count time by the slow turning of the great light above ${n}.`,
  (n, c, e) => `Something older than the ${c} built the stones in ${e}. No one has ever reached the top.`,
  (n, c, e) => `On ${n}, the dead are not buried but planted. Every forest is an ancestor; every flower, a name.`,
  (n, c, e) => `The ${c} believe the sky is a sea seen from below, and that ships are only boats that remembered how.`,
  (n, c, e) => `In ${e} the wind carries voices. The ${c} say they are the voices of everyone who will ever live here.`,
];
function makeLore(planet, rng) {
  const e = epithet(rng);
  const c = planet.civ.culture || 'first ones';
  return { epithet: e, myth: rng.pick(MYTH)(planet.name, c, e) };
}

export const PLANET_KIND_LIST = PLANET_KINDS;
