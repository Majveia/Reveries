# Reveries — Architecture & Contracts

Reveries is a playable, procedurally generated universe in **Three.js (WebGL2)**:
an evolving cosmic web → galaxies → star systems → seamless planets you can
walk, ride and fly across. Everything is procedural and deterministic from seeds:
**no external assets** (no model/texture files). Textures come from shaders or
canvas, geometry from code.

Run it: `npm install && npm run dev` → http://localhost:5173

## Scales (levels)

| Level | Module | Units | What it is |
|---|---|---|---|
| `cosmos` | `src/levels/cosmos/CosmosLevel.js` | Mpc (comoving) | GPU N-body cosmic web in an expanding ΛCDM universe; the title screen lives here |
| `galaxy` | `src/levels/galaxy/GalaxyLevel.js` | kpc | A galaxy: stars, dust lanes, nebulae, central black hole |
| `system` | `src/levels/system/SystemLevel.js` | scene units (compressed AU) | Star, planets on Kepler orbits, belts, comets |
| `planet` | `src/levels/planet/PlanetLevel.js` | **meters**, planet at origin | One seamless world from orbit to the ground: terrain, ocean, sky, life, cities, player, vehicles |

Navigation: `engine.go(level, addr, opts)` with cinematic warp transitions.
`engine.up()` goes up one scale. Address `addr = { g, s, p }` (galaxy id, star
index, planet index). URL: `?scene=planet&g=0&s=0&p=2`.

## Core (owned by core — additive changes only, never restructure)

- `src/core/Engine.js` — renderer (reversed-Z float depth when available), loop,
  adaptive DPR, level lifecycle, transitions, harness API (`window.__REVERIES__`).
- `src/core/PostFX.js` — HDR pipeline: scene → level effects → bloom → AgX/ACES
  tonemap → grade → FXAA. **Owned by the postfx sub-project.**
- `src/core/Input.js` — unified keyboard/mouse/gamepad/touch. **Owned by the ui sub-project.**
- `src/core/OrbitRig.js` — inertial orbit camera for map levels.
- `src/core/Random.js` — `Random` (seeded sfc32), `seedFrom`, `hash2i/hash3i`, `u01`.
- `src/core/Noise.js` — `SimplexNoise(seed)` with `noise2/3/4`, `fbm3`, `ridged3`, `billow3`, `warped3`, `worley3`; `clamp/lerp/smoothstep/remap`. Worker-safe.
- `src/core/glsl/noise.js` — GLSL `snoise(vec2|vec3)`, `fbm`, `ridged`, `worley`, `hash*`. Export `NOISE_GLSL`.
- `src/core/glsl/common.js` — `DEPTH_GLSL` (`depthToViewZ`, `isFarDepth`, `viewPosFromDepth`), `COLOR_GLSL` (`blackbody`, `luma`, `ign`), `FULLSCREEN_VERT`.
- `src/universe/Universe.js` — deterministic catalog: `galaxy(id)`, `galaxySample(g, rng)`, `star(g, i)`, `system(g, s)`, `planet(g, s, p)`, `crumbs(addr)`.
- `src/universe/Astro.js` — real physics: ΛCDM `E(a)`, `growthFactor`, `growthRate`, `ageAt`, `powerSpectrum`; stellar `massLuminosity`, `blackbodyColor`, `habitableZone`; `solveKepler`, `orbitPosition`.
- `src/universe/Aesthetics.js` — the art direction of every world (palette, atmosphere, terrain style, architecture, flora, fauna, weather, grade, music) — homages to Villeneuve, Miyazaki, Moebius, Kubrick, Tarkovsky, Ueda, Cameron, Watanabe, FromSoftware, Black Myth/Sekiro, Nolan, Rick & Morty, Nausicaä, NASA-punk, Mustafar, Hoth.

## Rendering rules everyone must follow

1. **Reversed depth.** `engine.reversedDepth` is usually `true`: depth 1 = near,
   0 = far, 32-bit float depth texture. Built-in materials just work. In post
   effects use `DEPTH_GLSL` helpers with the `ctx.reversed` flag — never assume
   standard depth. For backgrounds (skies, starfields) use `depthWrite:false`,
   a low `renderOrder`, and keep them inside the far plane; do not use the
   `gl_Position.z = gl_Position.w` trick.
2. **HDR linear.** The scene renders to a HalfFloat target. Output linear,
   physically plausible radiance; emissive things can exceed 1.0 (they bloom).
   No tonemapping in materials (`toneMapped` is irrelevant; PostFX tonemaps).
   Colors from hex go through `THREE.Color` (sRGB → linear).
3. **OLED black.** Space must be true black. Keep fog/haze/grain from lifting
   pure-black regions. Bloom is energy-conserving; don't add flat ambient glow.
4. **Performance budget.** Desktop `high` ≈ 60 fps on a mid-range laptop GPU;
   phones run `low`/`medium`. Scale counts/steps with `engine.quality`
   (`.level` 0–3, `.pick(low, med, high, ultra)`, `.scale(n)`). Instancing,
   GPU animation, workers for heavy CPU work. Avoid per-frame allocations.
5. **Determinism.** Use `Random`/`seedFrom` from seeds in the universe catalog,
   never `Math.random()` for world content (fine for transient VFX).
6. **Post effects** a level/subsystem adds implement
   `{ enabled, render(renderer, inputTexture, outputTarget, ctx) }` where ctx has
   `depthTexture, camera, near, far, reversed, time, width, height, projInv,
   viewInv, cameraPosition, fullscreen(material, target)`.
   Also `ctx.frame` and `ctx.jitter` (TAA sub-pixel NDC offset already baked
   into this frame's projection and `projInv`).
7. **PostFX grade keys** (levels pass a partial `grade`; it is reset to the
   defaults on every level change, so keys never leak between levels). Beyond
   exposure/tonemap/colour: `look` (film look by aesthetic id, e.g. `'ghibli'`,
   `'dune'`, or `'filmic' 'cosmic' 'blockbuster' 'bleach' 'noir'`) + `lookStrength`;
   `autoExposure` (0 = manual; planets 0.7) with `aeKey aeMin aeMax aeDarkComp`
   and `purkinje` (night vision); `bloomStrength/Radius` (energy-conserving
   veil) + `bloomHighlights` (glow of exposed highlights: windows, lava);
   `flare`/`flareThreshold` (aperture ghosts + halo), `streak`/`streakTint`
   (anamorphic); `ao`/`aoRadius`/`aoDistance` (GTAO, world units); `dof`,
   `dofFocus` (0 = autofocus), `dofAperture`; `motionBlur` (shutter 0–1),
   `motionBlurNear`; `sharpen`, `grain`, `chroma`, `halation`, `taa` (0 = FXAA).
   Animate with `engine.postfx.setGrade(partial, seconds)`; call
   `engine.postfx.resetHistory?.()` on hard camera cuts. Debug: `?pfx=ao|exposure|flare|nolut|noaa`.

## Level contract

```js
export default class XLevel {
  constructor(engine, addr, opts)
  async load(progress)        // progress(p01, label)
  enter(prevLevelName)
  update(dt, t)               // read engine.input; call engine.go / engine.up
  render?()                   // default: engine.postfx.render(scene, camera, effects, {time, dt})
  exit(); dispose()
  scene; camera; effects = []; grade = { ...partial PostFX grade }
  shots = { name: async () => {...} }   // camera presets for screenshots (harness)
  onResize(w, h)
  onBegin?()                  // cosmos only: user clicked the title screen
}
```

## Planet subsystems

`PlanetLevel` loads every module in `SUBSYSTEMS` (dynamic import, failures
isolated). Each default-exports a class:

```js
export default class X {
  static order = 30;                 // update order (lower first)
  constructor(level)                 // level.world, .scene, .camera, .engine, .planet, .star, .aesthetic, .sun, .hemi
  async init(progress)
  update(dt, t)
  lateUpdate?(dt, t)                 // after all updates (camera rigs, LOD selection)
  effects?                           // array of PostFX effects (collected in order)
  shot?(name, spot) → bool           // pose for a screenshot preset; return true if handled
  onModeChange?(mode)                // 'orbit' | 'onfoot' | 'bike' | 'ship'
  dispose()
}
```

| Order | Subsystem | Module | Owner |
|---|---|---|---|
| 10 | vehicles | `src/vehicles/Vehicles.js` (+ files in `src/vehicles/`) | vehicles |
| 20 | player | `src/player/Player.js` (+ `src/player/`) | player |
| 30 | terrain | `src/levels/planet/terrain/Terrain.js`, `TerrainHeight.js` | terrain |
| 40 | ocean | `src/levels/planet/ocean/Ocean.js` | ocean |
| 50 | flora | `src/levels/planet/flora/Flora.js` | flora |
| 60 | fauna | `src/levels/planet/fauna/Fauna.js` | fauna |
| 70 | civ | `src/levels/planet/civ/Civilization.js` | civ |
| 80 | sky | `src/levels/planet/atmosphere/Sky.js` | atmosphere |
| 85 | clouds | `src/levels/planet/atmosphere/Clouds.js` | atmosphere |
| 88 | weather | `src/levels/planet/atmosphere/Weather.js` | atmosphere |
| 90 | atmosphere | `src/levels/planet/atmosphere/Atmosphere.js` | atmosphere |

### World (`src/levels/planet/World.js`) — the physical truth

Planet centered at origin, meters, radius 22–70 km (`world.radius`). The planet
does not rotate; `world.sunDir` orbits. Everyone queries terrain through World so
physics and visuals agree:

- `heightAt(dir)`, `sample(dir)` → `{h, moisture, temp, rock, biome}`, `surfaceRadius(dir)`
- `groundAt(pos)` → `{height, radius, point, normal, water, waterDepth, waterRadius, colliderTop}`
- `normalAt(dir)`, `up(pos)`, `frame(pos, forwardHint)` → `{up, forward, right}`, `altitude(pos)`, `raycast(origin, dir, max)`
- Colliders: `addCollider({type:'box', center, quaternion, half})`, `{type:'cylinder', center, up, radius, height}`, `{type:'sphere', center, radius}`; `collide(pos, radius, height)` pushes a capsule out; `colliderTopAt(pos)` for walkable roofs/platforms.
- POIs: `addPOI({position, radius, title, text, kind})`, `nearestPOI(pos, maxDist)`
- `sites[]`: settlements `{dir, position, height, radius, kind: 'megacity'|'city'|'town'|'village'|'outpost'|'spaceport'|'ruins', name, style}`
- Time: `setTimeOfDay(t, atDir)` (0 midnight, .25 sunrise, .5 noon, .75 sunset), `timeOfDay`, `daylight`, `sunDir`
- `seaLevel` (m above base radius, `-Infinity` if no ocean), `hasOcean`, `gravity`, `atmosphereRadius`, `wind`, `windStrength`
- `uniforms`: shared `{uTime, uSunDir, uPlanetRadius, uSeaLevel, uAtmoRadius, uDaylight, uWind, uCameraPos}` — bind the same objects in your materials.

`terrain/TerrainHeight.js` is **pure and worker-safe**: `terrainParams(planet)`
→ JSON; `createTerrain(params)` → `{height(x,y,z), sample(x,y,z)}` on unit
directions. Main thread and workers must produce identical heights.

### Player ⇄ vehicles contract

- Player subsystem sets `level.player = this` and exposes `position` (Vector3,
  feet), `velocity`, `up`, `mode`, `cameraRig`, `spawn(kind)` (`'orbit'|'surface'|'ship'|'bike'`),
  `board(vehicle)`, `alight()`, `handlesEscape()` (return true if it consumed Esc).
- Vehicles subsystem sets `level.vehicles = this` with `list` (array) and
  `nearest(pos, maxDist)`. Each vehicle: `{ type: 'bike'|'ship', object3d,
  position, quaternion, velocity, seat (Vector3 local), cameraProfile:
  {distance, height, fov, lag}, canBoard(pos), enter(player), exit() → exit
  position, update(dt, input|null) }` — `input` is non-null only while the
  player drives it.
- `level.setMode(mode)` broadcasts `onModeChange`; `ui.setMode` switches touch layouts.
- When `level.freeCam` is set (screenshot/debug), camera rigs must not move the camera.

## UI, input, audio

- `engine.ui`: `setLocation(crumbs)`, `info(card)`, `hint(text, ms)`, `prompt(key, text)`,
  `toast(title, text)`, `telemetry(obj)`, `setProgress(p, label)`, `setMode(mode)`, `setVisible(bool)`.
  Elements that take pointer input carry `data-ui`.
- `engine.input`: `move{x,y}`, `look{x,y}` (radians/frame), `pan`, `zoom`, `throttle`,
  `down/pressed/released(action)`, `click`, `doubleClick`, `setMode('orbit'|'game')`,
  `isTouch`, `lastDevice`, `pointerLocked`, `requestPointerLock()`.
  Actions: `forward back left right jump sprint crouch interact toggleView map escape travel rollLeft rollRight photo timeFaster timeSlower light help primary secondary brake`.
- UI additions (additive, all optional):
  - `ui.label(id, x, y, text, {sub, hover, kind, color, align:'left'|'right'|'center', persist})` —
    world-space name tag at CSS pixel (x, y); call every frame while visible (labels not
    refreshed for 2 frames fade out unless `persist`). `ui.labelWorld(id, vec3, camera, text, opts)`
    projects for you (hides behind camera / off screen). `ui.unlabel(id)`, `ui.clearLabels()`
    (labels are cleared automatically on level change). Use for hover names in galaxy/system.
  - `ui.toast(title, text, ms, {kind:'lore'|'note', kicker})` — short text → discovery note under
    the breadcrumb; long text (>70 chars) or `kind:'lore'` → cinematic serif myth reveal (upper third).
  - `ui.arrival({kicker, title, text, ms})` — place-name reveal (queued, one at a time).
  - `ui.hint(text|[[action, label], …], ms)` — `"Key label · Key label"` segments render key
    tokens (WASD, Shift, Space, E, V, Esc, Drag, Scroll, Click…) as keycaps that switch to gamepad
    glyphs automatically; or pass `[[action, label]]` pairs. `ui.prompt(keyOrAction, text)` likewise.
  - `ui.glyph(action)` → HTML glyph for the current device; `ui.toggleHelp()` (help action `/`,
    d-pad up on a gamepad) shows the controls for the current mode; `ui.settings` (persisted in
    localStorage `reveries.settings.v1`: quality, mouse/touch/pad sensitivity, invertY, volume, muted, haptics).
  - `ui.setMode('map'|'onfoot'|'bike'|'ship')` (`'vehicle'` = bike) switches touch layouts and help.
  - Title screen in shot mode: `?shot=1&title=1` (harness `--extra "title=1"`).
- Input additions: `input.setSensitivity({mouse, touch, pad})` (multipliers), `input.invertY`,
  `input.rumble(intensity, ms)` (gamepad rumble / phone vibration, respects the haptics setting),
  `input.gamepadId`. Gamepad: radial dead zones, look-stick turn acceleration; d-pad zooms in map
  levels, d-pad up/down = help/light and left/right = time slower/faster in game modes. Touch look
  has a flick-acceleration curve. Esc while the pointer is locked only releases the cursor.
- `engine.audio`: `setScene(name, music)`, `setTimeOfDay`, `setFlight`, `setEngine`, `sfx(name)`.

## Screenshots (the harness)

```
node tools/shoot.mjs --scene planet --p 2 --shots vista,city --out shots/mine/
```
Renders headless via SwiftShader (software — slow but faithful). One shared Vite
dev server on :5173 and a global lock serialize renders across agents. Prints
console errors — **read them**. Planet shots: `orbit approach vista character
fp city night ocean bike ship`. Each level defines its own `shots`.
Home system planets (g0 s0): p0 Ember (lava/inferno), p1 Arrakeen (desert/dune),
p2 Laputa (terran/ghibli), p3 Huaguo (terran/wukong), p4 Eywa (jungle/pandora),
p5 Saturnine (gas giant, rings), p6 Isolde (ice/glacier).

## Collaboration rules (parallel sub-projects)

- Only edit files you own. Shared files (`Engine.js`, `PlanetLevel.js`,
  `World.js`, `Universe.js`, `Aesthetics.js`): **small additive edits only**,
  re-read right before editing, never reformat or restructure.
- Never run `git` commands that change state (commit/checkout/reset/stash) — the
  lead commits.
- Do not delete or rename other modules' exports.
- Keep shaders compiling on WebGL2/GLSL ES 3.0 via three's ShaderMaterial
  (`gl_FragColor`/`texture2D` are fine — three aliases them).

## Harness etiquette (parallel agents share one software renderer)

- Use ONLY `tools/shoot.mjs` from the repo — never a private copy. It is the
  single queue for the software renderer (4 CPUs); copies that skip the lock
  make every render slower for everyone. It already stubs Vite's HMR client
  so other agents' edits can't reload a render mid-flight.
- At most 3 shots per invocation while iterating (`--w 960 --h 540 --frames 6`);
  long multi-shot batches hold the queue for everyone else.
- Run the harness with a long Bash timeout (`timeout: 600000`) — renders queue
  behind a global lock and SwiftShader is slow. Never kill the Vite dev server
  or other agents' processes; the harness starts the server if it is down.
- Keep a single shot render under ~2 minutes: use `--w 960 --h 540 --frames 6`
  while iterating, 1280×720 for final checks. In `engine.shotMode` temporal
  effects (auto-exposure, TAA history, cloud reprojection, LOD streaming) must
  converge immediately or within a few frames.
- Statically imported core files (`Engine.js`, `PostFX.js`, `Input.js`,
  `UI.js`, `ui.css`, `Audio.js`) must never be left broken: develop the new
  version as `src/core/PostFX.next.js` / `src/core/Input.next.js` /
  `src/ui/UI.next.js` / `src/audio/Audio.next.js`, test with
  `--extra "next=postfx"` (comma-separate several), then swap it in with a
  single `cp` and delete the `.next.js` file.
- Before finishing: `node tools/check.mjs` must pass (syntax + full Vite build).
