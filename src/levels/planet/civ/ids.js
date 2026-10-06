// Shared ids for the civilization shaders (materials.js) and generators.

/** Surface material ids (aMat.x). */
export const M = {
  PLASTER: 0, STONE: 1, BRICK: 2, WOOD: 3, TILE: 4, METAL: 5, CONCRETE: 6, GLASS: 7,
  SHELL: 8, NEON: 9, LACQUER: 10, TEMPLE_TILE: 11, SLATE: 12, CLOTH: 13, EMISSIVE: 14,
  GOLD: 15, BRONZE: 16, ADOBE: 17, SOLAR: 18, BLACK: 19, ROCK: 20, GRASS: 21, FOLIAGE: 22,
  PAPER: 23, IRON: 24, MARBLE: 25, HOLO: 26, RUST: 27, MOSSSTONE: 28, WATERFALL: 29,
};

/** Window styles (aMat.z). */
export const W = { NONE: 0, HOUSE: 1, LANCET: 2, LATTICE: 3, SLIT: 4, GRID: 5, PORTHOLE: 6, STRIP: 7, ARCADE: 8, SCREEN: 9 };

/** Face flags (aExt.z, bit field). */
export const F = { FRONT: 1, GABLE: 2, NOWIN: 4, SHOP: 8, CLOTH: 16, ROOF: 32, LIT: 64 };

/** Ground surface ids (aMat.x in the ground material). */
export const G = { COBBLE: 0, FLAG: 1, DIRT: 2, PLANK: 3, PAD: 4, SANDSTONE: 5, GRAVEL: 6, DECK: 7, FIELD: 8, TERRACE: 9 };
