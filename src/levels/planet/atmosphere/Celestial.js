// Celestial — where everything in the sky is, for one planet.
//
// The World keeps the planet fixed and swings the sun around the +Y axis
// (world.dayAngle). Equivalently the whole celestial sphere turns with it, so
// one rotation maps "celestial" coordinates (stars, galaxy, planets, moons) to
// world space:   world = R_y(dayAngle) · cel.
//
// In the celestial frame the sun sits at s0 = (0, sin tilt, cos tilt); the
// ecliptic is the plane through s0 with normal nE. Moons orbit close to that
// plane (with their own inclination) and are real 3D bodies at `distance`
// planet radii, so the sky shows true parallax, phases and moonrise.
//
// Shared by Sky (drawing), Lighting (moonlight) and Clouds/Weather (key light).

import * as THREE from 'three';
import { Random, seedFrom } from '../../../core/Random.js';
import { orbitPosition } from '../../../universe/Astro.js';

export const MAX_MOONS = 4;
export const MAX_PLANETS = 6;

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _m = new THREE.Matrix4();

export class Celestial {
  constructor(level) {
    this.level = level;
    this.world = level.world;
    const P = level.planet, w = this.world;
    const R = w.radius;
    this.rng = new Random(seedFrom(P.seed, 'celestial'));
    const tilt = w.sunElevationTilt;
    this.s0 = new THREE.Vector3(0, Math.sin(tilt), Math.cos(tilt));
    this.nE = new THREE.Vector3(0, Math.cos(tilt), -Math.sin(tilt));
    this.w0 = new THREE.Vector3().crossVectors(this.nE, this.s0).normalize();

    // world <-> celestial
    this.celToWorld = new THREE.Matrix3();
    this.worldToCel = new THREE.Matrix3();

    // ---- moons --------------------------------------------------------------
    // The epoch is arbitrary; choose it so the first moon rises as a waxing
    // gibbous in the evening of the first settlement (a pleasant first night).
    const moons = (P.moons || []).slice(0, MAX_MOONS);
    const ph0 = moons[0]?.phase ?? 0;
    this.moons = moons.map((m, i) => {
      const dist = m.distance * R;
      // angular radius at mean distance, kept in a cinematic but believable range
      const radius = THREE.MathUtils.clamp(m.radiusRel * R * 0.62, R * 0.012, R * 0.2);
      const periodDays = 2.2 * Math.pow(m.distance / 3.2, 1.5) * (1 + i * 0.35);
      const albedo = m.kind === 'ice' ? 0.62 : m.kind === 'lava' ? 0.16 : 0.24;
      return {
        index: i, name: m.name, kind: m.kind,
        color: new THREE.Color(m.color[0], m.color[1], m.color[2]),
        albedo, dist, radius, incl: m.incl,
        theta0: 2.55 + (m.phase - ph0) + i * 0.0,
        periodDays,
        seed: (this.rng.int(0, 1e6)),
        // per frame
        pos: new THREE.Vector3(), dir: new THREE.Vector3(), angRadius: 0.01, illum: 0, elev: -1, phaseCos: 0,
      };
    });

    // ---- other planets of the system as wandering stars ---------------------
    const sys = level.engine.universe.system(P.galaxyId ?? 0, P.starIndex ?? 0);
    const me = P.orbit;
    const meEl = { ...me, period: me.periodDays };
    const pm = orbitPosition(meEl, 0, [0, 0, 0]);
    const pmV = new THREE.Vector3(pm[0], pm[1], pm[2]);
    const toSun = pmV.clone().negate().normalize(); // ecliptic coords
    const eUp = new THREE.Vector3(0, 1, 0);
    const eSide = new THREE.Vector3().crossVectors(eUp, toSun).normalize();
    this.planets = [];
    for (const o of sys.planets) {
      if (o.index === P.index || this.planets.length >= MAX_PLANETS) continue;
      const q = orbitPosition({ ...o.orbit, period: o.orbit.periodDays }, 0, [0, 0, 0]);
      const d = new THREE.Vector3(q[0], q[1], q[2]).sub(pmV);
      const dist = d.length();
      d.normalize();
      // map ecliptic → celestial
      const cel = new THREE.Vector3()
        .addScaledVector(this.s0, d.dot(toSun))
        .addScaledVector(this.w0, d.dot(eSide))
        .addScaledVector(this.nE, d.dot(eUp)).normalize();
      // apparent brightness: size × phase / distance²
      const rE = o.radiusEarth || 1;
      const phaseAngle = Math.acos(THREE.MathUtils.clamp(-d.dot(new THREE.Vector3(q[0], q[1], q[2]).normalize()), -1, 1));
      const phase = 0.5 * (1 + Math.cos(phaseAngle));
      const mag = (rE * rE) / Math.max(0.05, dist * dist) * (0.35 + 0.65 * phase) / Math.max(0.3, Math.hypot(q[0], q[2]) ** 2);
      const col = o.gasBands ? o.gasBands.colors[0] : o.palette ? hexToRgb(o.palette.sky) : [0.9, 0.85, 0.8];
      this.planets.push({ cel, brightness: THREE.MathUtils.clamp(mag * 40, 0.4, 14), color: new THREE.Color(...col).lerp(new THREE.Color(1, 1, 1), 0.45) });
    }

    // ---- galactic frame -------------------------------------------------------
    // We live inside the home barred spiral at the star's galactocentric
    // position. Orient the galactic plane so the band arcs high across the
    // night sky of the first settlement (deterministic; any orientation is real).
    const star = level.star;
    const gal = level.engine.universe.galaxy(P.galaxyId ?? 0);
    this.galaxy = gal;
    const sp = star.position || [8, 0, 0];
    this.starGal = new THREE.Vector3(sp[0], sp[1], sp[2]); // kpc, galaxy frame (plane = xz)
    const siteDir = (w.sites[0]?.dir || new THREE.Vector3(0.3, 0.5, 0.8)).clone().normalize();
    // Midnight zenith at the site in celestial coords: world→cel at the dayAngle where t = 0.
    const lon = Math.atan2(siteDir.x, siteDir.z);
    const aMid = lon + (0.0 - 0.5) * Math.PI * 2;
    const zen = siteDir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -aMid);
    // galactic plane contains zen; tilt it by a seeded angle around zen
    const helper = Math.abs(zen.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const a1 = new THREE.Vector3().crossVectors(zen, helper).normalize();
    const a2 = new THREE.Vector3().crossVectors(zen, a1).normalize();
    const rot = this.rng.range(0, Math.PI);
    const gN = a1.clone().multiplyScalar(Math.cos(rot)).addScaledVector(a2, Math.sin(rot)).normalize(); // galactic north (cel)
    // galactic centre direction within the plane, ~40° from the midnight zenith
    const inPlane = new THREE.Vector3().crossVectors(gN, zen).normalize();
    const gC = zen.clone().multiplyScalar(Math.cos(0.75)).addScaledVector(inPlane, Math.sin(0.75)).normalize();
    // Galaxy frame (x toward centre from us is -starGal dir; y = north).
    const starDirGal = this.starGal.clone().setY(0).normalize();
    const toCentreGal = starDirGal.clone().negate();
    const gX = gC, gY = gN, gZ = new THREE.Vector3().crossVectors(gX, gY).normalize();
    const gxG = toCentreGal, gyG = new THREE.Vector3(0, 1, 0), gzG = new THREE.Vector3().crossVectors(gxG, gyG).normalize();
    // celToGal: maps celestial dir → galaxy-frame dir
    const mCel = new THREE.Matrix3().set(gX.x, gY.x, gZ.x, gX.y, gY.y, gZ.y, gX.z, gY.z, gZ.z); // columns: gal axes in cel
    const mGal = new THREE.Matrix3().set(gxG.x, gyG.x, gzG.x, gxG.y, gyG.y, gzG.y, gxG.z, gyG.z, gzG.z);
    this.celToGal = mGal.clone().multiply(mCel.clone().transpose());
    this.galNorth = gN; this.galCentre = gC;

    this.keyDir = new THREE.Vector3(0, 1, 0);
    this._frame = -1;
    this.update(0, true);
  }

  /** Recompute positions (idempotent per engine frame). */
  update(t, force = false) {
    const f = this.level.engine.frame;
    if (!force && f === this._frame) return;
    this._frame = f;
    const w = this.world;
    const a = w.dayAngle;
    this.celToWorld.setFromMatrix4(_m.makeRotationY(a));
    this.worldToCel.copy(this.celToWorld).transpose();
    const days = (this.level.engine.time || 0) / Math.max(60, w.dayLength) * (w.timeScale ?? 1);
    const cam = this.level.camera.position;
    const focus = this.level.player?.position || cam;
    const up = _v2.copy(focus).normalize();
    for (const m of this.moons) {
      const th = m.theta0 + (2 * Math.PI * days) / m.periodDays;
      const ci = Math.cos(m.incl), si = Math.sin(m.incl);
      _v.copy(this.s0).multiplyScalar(Math.cos(th)).addScaledVector(this.w0, Math.sin(th) * ci).addScaledVector(this.nE, Math.sin(th) * si).normalize();
      m.pos.copy(_v).applyMatrix3(this.celToWorld).multiplyScalar(m.dist);
      m.dir.copy(m.pos).sub(cam);
      const d = m.dir.length();
      m.dir.multiplyScalar(1 / d);
      m.angRadius = Math.asin(Math.min(0.5, m.radius / d));
      // illuminated fraction seen from the camera
      const toSunFromMoon = w.sunDir;
      m.phaseCos = -m.dir.dot(toSunFromMoon); // 1 = full
      m.illum = 0.5 * (1 + m.phaseCos);
      m.elev = _v.copy(m.pos).sub(focus).normalize().dot(up);
    }
  }

  /** Brightest moon above the horizon at the focus → { moon, E } (E: artistic illuminance). */
  moonlight() {
    let best = null, bestE = 0, total = 0;
    for (const m of this.moons) {
      const vis = THREE.MathUtils.smoothstep(m.elev, -0.04, 0.12);
      const size = Math.min(1.6, m.angRadius / 0.028);
      const E = vis * Math.pow(m.illum, 1.6) * size * (0.35 + m.albedo);
      total += E;
      if (E > bestE) { bestE = E; best = m; }
    }
    return { moon: best, E: Math.min(total, 1.4) };
  }
}

function hexToRgb(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}
