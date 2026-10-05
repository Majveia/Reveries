// Flora profiles — one per aesthetic.flora value. Pure data (+ palette-aware
// colour helpers): grass, wildflowers, tree species and rocks for each world.
//
// grass:   density (×62 blades/m² near the camera at 'high'), colors (meadow
//          palette, blended by macro noise), dry, reed, h/w ranges (m), stiff,
//          cover (patchiness bias), far (range ×), needsWater, glow
// flowers: density, colors, h, size (head radius m), patch, scatter, glow
// trees:   density (trees/m² in forest patches), species [{kind, w, pal, cold,
//          wet, shore, sizeK, tints}], biome weights (grassland/arid/…),
//          cover, snowLine, glowCol, landmark
// rocks:   density (per m²), color, moss (0..1), mossCol, lichen, size
import * as THREE from 'three';

const C = (h) => new THREE.Color(h);
const mix = (a, b, t) => C(a).lerp(C(b), t);

export function floraProfile(kind, A) {
  const pal = A?.palette || {};
  const ground = pal.ground || ['#5f8a3c', '#4f7a34', '#7a9a4a', '#9aa86a'];
  const fol = pal.foliage || ['#4e8a3c', '#6a9a44'];
  const rock = pal.rock || '#7a766e';
  const hex = (c) => '#' + c.getHexString();
  // meadow colours sit between the ground palette and the foliage palette so
  // grass reads as the same land the terrain shader paints
  const meadow = (n = 4, k = 0.45) => Array.from({ length: n }, (_, i) => hex(mix(ground[i % ground.length], fol[i % fol.length], k)));

  switch (kind) {
    case 'lush': return {
      grass: { density: 1.0, colors: meadow(4, 0.35).concat(['#8fb04a']), dry: '#c2b46a', reed: '#5f7f3a', h: [0.2, 0.78], w: [0.026, 0.048], stiff: 1, cover: 0.55, needsWater: 0.6, rockVeg: 0.35 },
      flowers: { style: 'spike', density: 1.0, colors: ['#ffe14d', '#f6f3ea', '#a98cf0', '#fff27a', '#f9b3cf'], h: [0.4, 0.85], size: 0.05, patch: 0.05, scatter: 0.05 },
      trees: {
        density: 0.007, cover: 0.05, lone: 0.05, grassland: 0.6, arid: 0.08, wet: 0.5, rocky: 0.12, cliffTrees: 0.25, snowy: 0.02, snowLine: 0.4,
        species: [
          { kind: 'broad', w: 1.0, pal: (k) => ({ leaf: C(['#3f7a30', '#4f8a36', '#356a2c', '#5a9438', '#44803a'][k % 5]), leaf2: C('#7aa848'), bark: C('#57493c') }), tints: [C('#ffffff'), C('#e8ffd8'), C('#fff2c8')] },
          { kind: 'conifer', w: 0.22, cold: 0.8, pal: () => ({ leaf: C('#2c4a2e'), bark: C('#4a3a30') }) },
          { kind: 'birch', w: 0.25, pal: () => ({ leaf: C('#86ac46'), bark: C('#ddd8cc') }) },
          { kind: 'willow', w: 0.08, wet: 1.5, shore: 1.5, pal: () => ({ leaf: C('#7aa04a'), bark: C('#4a4238') }) },
          { kind: 'scrub', w: 0.9, sizeK: 1.0, pal: () => ({ leaf: C('#4f7f36'), bark: C('#4a3e30') }) },
        ],
        landmark: { style: 'broad', H: 64, name: 'The Old Camphor', text: 'Spirits are said to sleep in its crown.', pal: { leaf: C('#4a8a36'), leaf2: C('#7ab04a'), bark: C('#5a4c3e') } },
      },
      motes: [{ type: 'petals', colors: ['#f4f0e4', '#f2d24a'] }, { type: 'flies', colors: ['#d8ff6a', '#ffe08a'], glow: 0.7 }],
      rocks: { density: 0.0045, color: rock, moss: 0.75, mossCol: '#4e6e2c', size: 1 },
    };
    case 'maple': return {
      grass: { density: 1.25, colors: meadow(4, 0.3).concat(['#7a8440', '#8a8a48']), dry: '#c0a060', reed: '#6a6a3a', h: [0.14, 0.55], w: [0.028, 0.05], stiff: 0.9, cover: 0.62, needsWater: 0.5, dryBias: 0.22, rockVeg: 0.55 },
      flowers: { density: 0.5, colors: ['#d8342a', '#e8e0d0', '#c8282a', '#f0a030'], h: [0.35, 0.7], size: 0.05, patch: 0.15, scatter: 0.02 },
      trees: {
        density: 0.0072, cover: 0.2, lone: 0.06, grassland: 0.65, arid: 0.15, wet: 0.5, rocky: 0.4, cliffTrees: 0.55, snowy: 0.05, snowLine: 0.45,
        species: [
          { kind: 'maple', w: 1.0, pal: (k) => ({ leaf: C(['#c8302a', '#b82a26', '#d8502a', '#e07a2a', '#a82424'][k % 5]), leaf2: C(['#e8a03a', '#d8642a'][k % 2]), bark: C('#3a302c') }), tints: [C('#ffffff'), C('#ffd8c8'), C('#ffe8b0')] },
          { kind: 'pine', w: 0.55, cold: 0.6, rock: 1.2, pal: () => ({ leaf: C('#2a3a28'), bark: C('#4a3a32') }) },
          { kind: 'golden', w: 0.25, pal: () => ({ leaf: C('#e0a83a'), leaf2: C('#f0c050'), bark: C('#4a4038') }) },
          { kind: 'scrub', w: 0.6, rock: 0.8, pal: (k) => ({ leaf: C(['#8a3a26', '#a8482a', '#6a5a2a'][k % 3]), leaf2: C('#c8602a'), bark: C('#3a302c') }) },
        ],
        landmark: { style: 'maple', H: 58, name: 'The Crimson Elder', text: 'Its leaves fall like embers and never touch the ground.', pal: { leaf: C('#c42a24'), leaf2: C('#e8702a'), bark: C('#3a302c') } },
      },
      motes: [{ type: 'leaves', colors: ['#c8302a', '#e0702a'] }],
      litter: { density: 7, colors: ['#b8282a', '#d8502a', '#e08a2a', '#9a2020'], size: 0.13, cover: 0.1 },
      rocks: { density: 0.007, color: rock, moss: 0.55, mossCol: '#4a5a32', size: 1.2 },
    };
    case 'bioluminescent': return {
      grass: { density: 1.0, colors: ['#1f5a46', '#2a6a4a', '#1a4a40', '#3a7a5a'], dry: '#4a6a4a', reed: '#2a5a4a', h: [0.3, 1.1], w: [0.04, 0.075], stiff: 0.8, cover: 0.6, glow: 0.55, glowCol: '#4fe8ff', needsWater: 0.3, rockVeg: 0.85 },
      flowers: { density: 1.2, colors: ['#7f6aff', '#36d8ff', '#ff5ad8', '#b8ff6a'], h: [0.25, 0.7], size: 0.06, patch: 0.0, scatter: 0.08, glow: 1.4, glowCol: '#6fd8ff' },
      trees: {
        density: 0.0085, cover: 0.25, grassland: 0.7, arid: 0.2, wet: 0.7, rocky: 0.5, cliffTrees: 0.75, snowy: 0.05, glowCol: '#5ae8ff',
        species: [
          { kind: 'biolum', w: 1.0, pal: (k) => ({ leaf: C(['#1f6a4e', '#2a7a5e', '#1a5a50', '#2f6a6a'][k % 4]), leaf2: C('#3a8a6a'), bark: C('#3a3440'), glow: C(['#5ae0ff', '#a07aff', '#5affc8'][k % 3]), glowAmt: 0.65 }) },
          { kind: 'fungus', w: 0.16, pal: (k) => ({ leaf: C(['#5a3a98', '#2a6a98', '#98407a'][k % 3]), leaf2: C('#7ae8ff'), bark: C('#a8a0b8'), glowAmt: 1.0 }) },
          { kind: 'palm', w: 0.3, wet: 1, pal: () => ({ leaf: C('#2a7a5a'), bark: C('#4a4440') }) },
          { kind: 'coral', w: 0.25, pal: () => ({ leaf: C('#ff7ad8'), bark: C('#6a4a8a'), glowAmt: 0.8 }) },
        ],
        landmark: { style: 'biolum', H: 70, name: 'Tree of Voices', text: 'Every root hums with the memory of the forest.', pal: { leaf: C('#1f6a5e'), leaf2: C('#3a8a7a'), bark: C('#3a3448'), glow: C('#7ae0ff'), glowAmt: 0.7 } },
      },
      motes: [{ type: 'flies', colors: ['#7af0ff', '#c0a0ff'], glow: 2.2, size: 1.7, height: 6, n: 1.3 }],
      rocks: { density: 0.004, color: rock, moss: 0.85, mossCol: '#1f5a4a', size: 1.1, glowMoss: 0.25 },
    };
    case 'golden': return {
      grass: { density: 0.9, colors: ['#a8984a', '#c0a85a', '#8a8a42', '#b8a050'], dry: '#d8c07a', reed: '#8a8040', h: [0.3, 0.9], w: [0.03, 0.055], stiff: 0.9, cover: 0.45, needsWater: 0.3 },
      flowers: { density: 0.6, colors: ['#f2d24a', '#f4f0e4', '#e8b83a'], h: [0.3, 0.6], size: 0.04, patch: 0.15, scatter: 0.03 },
      trees: {
        density: 0.0035, cover: 0.0, grassland: 0.4, arid: 0.12, wet: 0.4, rocky: 0.08, glowCol: '#ffd27a',
        species: [
          { kind: 'golden', w: 1.0, pal: (k) => ({ leaf: C(['#e0a83a', '#d89a2a', '#f0c050', '#c8902a'][k % 4]), leaf2: C('#f8d878'), bark: C('#5a5248'), glowAmt: 0.12 }) },
          { kind: 'broad', w: 0.3, pal: () => ({ leaf: C('#7a8a3a'), bark: C('#4a4238') }) },
          { kind: 'scrub', w: 0.6, pal: () => ({ leaf: C('#a89040'), bark: C('#4a4038') }) },
        ],
        landmark: { style: 'golden', H: 160, name: 'The Erdtree', text: 'Its light is the grace that guides the lost.', pal: { leaf: C('#ffc850'), leaf2: C('#fff0a0'), bark: C('#8a7a5a'), glowAmt: 3.6, glow: C('#ffd27a') } },
      },
      motes: [{ type: 'leaves', colors: ['#e8b040', '#f8d878'], size: 0.9 }, { type: 'flies', colors: ['#ffd27a', '#fff0b0'], glow: 0.9, always: true }],
      litter: { density: 5, colors: ['#e0a83a', '#f0c050', '#c8902a'], size: 0.12 },
      rocks: { density: 0.005, color: rock, moss: 0.2, mossCol: '#6a6a3a', size: 1.2 },
    };
    case 'boreal': return {
      grass: { density: 0.75, colors: ['#5a6a3e', '#6a7a46', '#4a5a38', '#7a7a4e'], dry: '#a89a6a', reed: '#5a6a3a', h: [0.2, 0.7], w: [0.025, 0.05], stiff: 1, cover: 0.35, needsWater: 0.4 },
      flowers: { density: 0.3, colors: ['#f4f0e4', '#c8b8e8', '#e8d050'], h: [0.25, 0.5], size: 0.03, patch: 0.25, scatter: 0.02 },
      trees: {
        density: 0.006, cover: 0.15, grassland: 0.4, arid: 0.15, wet: 0.5, rocky: 0.1, snowy: 0.15, snowLine: 0.55,
        species: [
          { kind: 'conifer', w: 1.0, pal: (k) => ({ leaf: C(['#2a4430', '#24402c', '#30482e'][k % 3]), bark: C('#4a3a30'), snow: A?.terrain?.style === 'glacier' ? 0.35 : 0 }) },
          { kind: 'birch', w: 0.6, pal: (k) => ({ leaf: C(['#8aa83a', '#b8a83a', '#9ab048'][k % 3]), bark: C('#e0dcd0') }) },
          { kind: 'pine', w: 0.3, pal: () => ({ leaf: C('#2a3a28'), bark: C('#5a4034') }) },
        ],
      },
      motes: [{ type: 'leaves', colors: ['#c8b040', '#a8a038'], size: 0.6 }],
      litter: { density: 3, colors: ['#c8a83a', '#a89a3a', '#8a6a2a'], size: 0.07, cover: -0.1 },
      rocks: { density: 0.006, color: rock, moss: 0.7, mossCol: '#4a5a34', size: 1.1 },
    };
    case 'palms': return {
      grass: { density: 0.7, colors: meadow(4, 0.4), dry: '#c8b47a', reed: '#5a7a3a', h: [0.2, 0.6], w: [0.03, 0.06], stiff: 1, cover: 0.3, needsWater: 0.5 },
      flowers: { density: 0.4, colors: ['#ff5a8a', '#ffd84a', '#ff8a3a'], h: [0.3, 0.6], size: 0.06, patch: 0.2, scatter: 0.02 },
      trees: {
        density: 0.003, cover: 0.0, grassland: 0.4, arid: 0.2, sandy: 0.25, wet: 0.5,
        species: [
          { kind: 'palm', w: 1.0, shore: 2, pal: (k) => ({ leaf: C(['#4a8a3a', '#5a9a3e', '#3e7a34'][k % 3]), bark: C('#7a6a52') }) },
          { kind: 'broad', w: 0.3, pal: () => ({ leaf: C('#3e7a34'), bark: C('#5a4a3c') }) },
          { kind: 'scrub', w: 0.5, pal: () => ({ leaf: C('#5a8a3a'), bark: C('#5a4a3a') }) },
        ],
      },
      rocks: { density: 0.003, color: rock, moss: 0.2, mossCol: '#4a6a34', size: 1 },
    };
    case 'alien': return {
      grass: { density: 0.6, colors: ['#c87a8a', '#d8a07a', '#a87aa8', '#e0b090'], dry: '#e0c0a0', reed: '#a86a9a', h: [0.15, 0.55], w: [0.04, 0.08], stiff: 1.3, cover: 0.25, needsWater: 0 },
      flowers: { density: 0.5, colors: ['#5ae0d8', '#ffd86a', '#ff8ab8'], h: [0.3, 0.8], size: 0.08, patch: 0.2, scatter: 0.03, glow: 0.3 },
      trees: {
        density: 0.0022, cover: 0.0, grassland: 0.6, arid: 0.4, sandy: 0.2, wet: 0.6, rocky: 0.2,
        species: [
          { kind: 'fungus', w: 1.0, pal: (k) => ({ leaf: C(['#e88a6a', '#f0c070', '#8ac8c8', '#d07ab0'][k % 4]), leaf2: C('#fff0d0'), bark: C('#f0e0d0'), glowAmt: 0.15 }) },
          { kind: 'coral', w: 0.7, pal: (k) => ({ leaf: C(['#ffd8a0', '#a0f0e0'][k % 2]), bark: C(['#d8708a', '#7a8ad8'][k % 2]), glowAmt: 0.25 }) },
        ],
      },
      rocks: { density: 0.004, color: rock, moss: 0, size: 1.4 },
    };
    case 'fungal': return {
      grass: { density: 0.8, colors: ['#6a7a4a', '#7a8a52', '#5a6a42', '#8a8a5a'], dry: '#a8a07a', reed: '#5a6a4a', h: [0.2, 0.6], w: [0.03, 0.06], stiff: 1, cover: 0.4, needsWater: 0.3 },
      flowers: { density: 0.3, colors: ['#e8e0c8', '#d8c8a0'], h: [0.15, 0.35], size: 0.04, patch: 0.25, scatter: 0.02 },
      trees: {
        density: 0.0045, cover: 0.1, grassland: 0.5, arid: 0.2, wet: 0.7, rocky: 0.1,
        species: [
          { kind: 'fungus', w: 1.0, sizeK: 1.6, pal: (k) => ({ leaf: C(['#c8b48a', '#a89a7a', '#d8c8a0', '#8a7a6a'][k % 4]), leaf2: C('#f0e0b0'), bark: C('#e0d8c4'), glowAmt: 0.08 }) },
          { kind: 'conifer', w: 0.3, pal: () => ({ leaf: C('#3a4a34'), bark: C('#4a3e34') }) },
          { kind: 'scrub', w: 0.4, pal: () => ({ leaf: C('#6a7a4a'), bark: C('#4a3e34') }) },
        ],
      },
      motes: [{ type: 'spores', colors: ['#f0e8d0', '#d8f0e0'], glow: 0.5, always: true }],
      rocks: { density: 0.004, color: rock, moss: 0.6, mossCol: '#6a7a44', size: 1 },
    };
    case 'sparse': return {
      grass: { density: 0.35, colors: ['#8a8050', '#9a8a58', '#7a7448', '#a8986a'], dry: '#c8b07a', reed: '#6a7040', h: [0.15, 0.5], w: [0.02, 0.04], stiff: 1.2, cover: -0.05, needsWater: 0.7, dryBias: 0.4 },
      flowers: { density: 0.1, colors: ['#e8c050', '#d87a4a'], h: [0.15, 0.35], size: 0.03, patch: 0.35, scatter: 0.01 },
      trees: {
        density: 0.0012, cover: -0.05, grassland: 0.6, arid: 0.6, sandy: 0.3, wet: 0.6, rocky: 0.3,
        species: [
          { kind: 'scrub', w: 1.0, pal: (k) => ({ leaf: C(['#6a7040', '#7a7448', '#5a6438'][k % 3]), bark: C('#5a4a3a') }) },
          { kind: 'cactus', w: 0.5, pal: () => ({ bark: C('#5a7044') }) },
          { kind: 'pine', w: 0.15, pal: () => ({ leaf: C('#3a4430'), bark: C('#5a4a3a') }) },
        ],
      },
      rocks: { density: 0.008, color: rock, moss: 0, size: 1.4 },
    };
    case 'grassland': return {
      grass: { density: 1.1, colors: ['#8a9a4a', '#a8a85a', '#7a8a44', '#b8b070'], dry: '#d0c080', reed: '#6a7a3a', h: [0.45, 1.3], w: [0.03, 0.05], stiff: 0.75, cover: 0.7, far: 1.2, needsWater: 0.2 },
      flowers: { density: 0.35, colors: ['#f4f0e4', '#e8d050'], h: [0.5, 0.9], size: 0.035, patch: 0.25, scatter: 0.02 },
      trees: {
        density: 0.0005, cover: -0.1, grassland: 0.3, arid: 0.1, wet: 0.4,
        species: [
          { kind: 'broad', w: 0.6, pal: () => ({ leaf: C('#5a7a3a'), bark: C('#5a4c3e') }) },
          { kind: 'scrub', w: 1.0, pal: () => ({ leaf: C('#7a8a44'), bark: C('#5a4a3a') }) },
        ],
      },
      rocks: { density: 0.004, color: rock, moss: 0.4, mossCol: '#6a7a44', size: 1.6 },
    };
    default: return null; // 'none'
  }
}
