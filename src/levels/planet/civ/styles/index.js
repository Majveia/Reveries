// Style registry: architecture key (Aesthetics.architecture) → generator module.
// Each module exports: palette(A, rng), building(ctx, lot), plaza(ctx, pz),
// extras(ctx), landmark(ctx), roadMat(road, zone), plazaMat(pz), reserve(ctx)
// and optionally wall(ctx, wall, gates), shot {…}, shotSun, people (false).
import * as pastoral from './pastoral.js';
import * as temple from './temple.js';
import * as monolithic from './monolithic.js';
import * as organic from './organic.js';
import * as outpost from './outpost.js';
import * as gothic from './gothic.js';
import * as neon from './neon.js';
import * as ruins from './ruins.js';

export const STYLES = { pastoral, temple, monolithic, organic, outpost, gothic, neon, ruins };
