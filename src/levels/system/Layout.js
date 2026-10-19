// Visual layout of a star system: real Kepler orbits (Astro.orbitPosition, in
// AU and days) mapped onto a logarithmically compressed radius so a whole
// system — from a scorched inner world to the Kuiper belt — reads in one frame.
// Angles, eccentricities and relative speeds stay physical; only radii and
// body sizes are compressed.

import { orbitPosition } from '../../universe/Astro.js';

/** Simulated days per real second at 1x time warp. */
export const DAYS_PER_SEC = 2.0;

const S = 26; // scene units per e-fold of (1 + a/a0)
const A0 = 0.35; // AU (luminosity-normalised)

export function makeLayout(sys) {
  const star = sys.star;
  const sl = Math.sqrt(Math.max(1e-5, star.lumSun));
  const massSun = Math.max(0.05, star.massSun);
  /** Map a true orbital radius (AU) to scene units. */
  const rv = (aAU) => S * Math.log(1 + aAU / sl / A0);
  /** Inverse of rv. */
  const ra = (r) => (Math.exp(r / S) - 1) * A0 * sl;
  /** Orbital period (days) for a radius in AU. */
  const periodDays = (aAU) => 365.25 * Math.sqrt((aAU * aAU * aAU) / massSun);

  const peri0 = sys.planets.length ? Math.min(...sys.planets.map((p) => p.orbit.a * (1 - p.orbit.e))) : sl;
  let starR = 3.0 * Math.pow(Math.max(star.radiusSun, 1e-4), 0.4);
  if (star.kind === 'whiteDwarf') starR = 0.55;
  if (star.kind === 'neutron') starR = 0.22;
  starR = Math.min(starR, rv(peri0) * 0.45);

  const planetR = (p) => (p.kind === 'gas' ? 0.78 * Math.pow(p.radiusEarth, 0.45) : 0.42 * Math.pow(p.radiusEarth, 0.55));

  const _o = [0, 0, 0];
  /** Scene position of a body on orbit `el` (a in AU, period in days) at `days`. */
  function position(el, days, out) {
    orbitPosition(el, days, _o);
    const r = Math.hypot(_o[0], _o[1], _o[2]) || 1e-9;
    const k = rv(r) / r;
    out.set(_o[0] * k, _o[1] * k, _o[2] * k);
    return out;
  }
  const planetEl = (p) => ({ a: p.orbit.a, e: p.orbit.e, i: p.orbit.i, node: p.orbit.node, peri: p.orbit.peri, M0: p.orbit.M0, period: p.orbit.periodDays });

  return { rv, ra, periodDays, starR, planetR, position, planetEl, scale: S, sl, massSun };
}
