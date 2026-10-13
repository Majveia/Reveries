# Reveries

A playable, procedurally generated universe in Three.js — from the cosmic web
forming under gravity in an expanding ΛCDM universe, down through galaxies and
star systems, to living worlds you can walk, ride and fly across.

```
npm install
npm run dev        # http://localhost:5173
npm run build      # static build in dist/
```

## The journey

| Scale | What you see | Physics |
| --- | --- | --- |
| Cosmos | The cosmic web condensing from the first fluctuations, z 49 → 0 | Planck 2018 ΛCDM, BBKS spectrum, Zel'dovich initial conditions, GPU particle-mesh N-body (FFT Poisson) |
| Galaxy | Spiral arms, dust lanes, nebulae and a central black hole | Density-wave arms, volumetric dust, Schwarzschild lensing |
| Star system | A star, its planets, belts and comets | Kepler orbits, blackbody colours, ring shadows |
| Planet | Terrain, sky, ocean, forests, wildlife and cities you can walk, ride and fly through | Rayleigh/Mie sky, volumetric clouds, Gerstner ocean, day/night cycle |

Select a filament node, a star or a planet to travel down one scale; press
Esc to go back up. On a world you start in orbit in your ship and can fly
straight down to the surface.

## Controls

Hints fade in when you need them; press `/` (or the D-pad up) for a controls
card for the current mode.

**Maps (cosmos, galaxy, star system)**

| Action | Keyboard / mouse | Gamepad | Touch |
| --- | --- | --- | --- |
| Orbit | drag | right stick | one-finger drag |
| Zoom | wheel | D-pad up/down | pinch |
| Select / travel | click, `Enter` | A | tap |
| Up one scale | `Esc` / `Backspace` | Menu | tap the breadcrumb |
| Slower / faster time | `,` / `.` | D-pad left/right | — |
| Photo mode | `H` | right stick click | — |

**On foot**

| Action | Keyboard / mouse | Gamepad |
| --- | --- | --- |
| Move / look | `WASD` + mouse (click to capture, `Esc` releases) | left / right stick |
| Sprint | `Shift` | RT or left stick click |
| Jump, hold to glide | `Space` | A |
| Crouch | `C` | B |
| Interact, board vehicles | `E` / `F` | X |
| First / third person | `V` | Y |
| Lamp | `L` | D-pad down |
| Leave the world | `M` / `Tab` | View |

**Hover bike**: `WASD` steer and throttle, `Shift` boost, `X` brake, `Space`
hop, `E` dismount, `V` camera.

**Ship**: mouse or `WASD` pitch and yaw, `Shift` boost, `Space` / `C` ascend
and descend, `Q` / `R` roll, `E` land or exit, `V` camera. Climb above the
atmosphere to leave orbit.

**Controllers**: Xbox pads and other standard gamepads work out of the box. On a
PlayStation pad (DualSense, DualSense Edge, DualShock 4), the on-screen glyphs
switch to ✕ ○ □ △, L1/R1, L2/R2 and Create/Options. The gamepad column above maps
like this: A = ✕, B = ○, X = □, Y = △, LB/RB = L1/R1, LT/RT = L2/R2, View = Create,
Menu = Options. Firefox and other browsers that report the pad's raw button order
are remapped to that layout. A touchpad click opens the controls card. On a
DualSense Edge, the back paddles act as ○ (crouch / descend) and ✕ (jump /
ascend) when the browser reports them as buttons of their own. Landings,
touchdowns, takeoffs, warps and bumps rumble the pad in Chromium browsers.

**Touch**: a floating joystick appears under your left thumb. Drag the right
side of the screen to look. Small context buttons for jump, sprint, interact
and vehicle controls sit along the right edge and appear only when they apply.

The gear in the top-right corner holds the settings: quality tier,
sensitivity, invert Y, volume and haptics. They are saved per browser.

## URL options

| Parameter | Meaning |
| --- | --- |
| `scene=cosmos\|galaxy\|system\|planet` | Start at a scale; this skips the title |
| `g`, `s`, `p` | Galaxy, star-system and planet indices |
| `q=low\|medium\|high\|ultra` | Force a quality tier. By default phones get `medium` and desktops `high` |
| `seed=…` | A different universe |
| `time=0..1` | Planet time of day |
| `spawn=orbit\|surface` | Planet arrival |
| `ui=0` | Hide the interface |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the engine, the scales of
the universe and the contracts between subsystems. `node tools/shoot.mjs`
renders screenshot presets headlessly, and `node tools/check.mjs` runs the
syntax check and a full build.
