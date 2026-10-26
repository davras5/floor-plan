# Code review: correctness, graphics fidelity, performance, structure

Reviewed 26 October 2026, against three.js r170.

The review had three parts:

1. My review of the whole repository.
2. A graphics-focused pass after the user reported light leaks near the ceiling.
3. An independent graphics review by a second engineer, who read the code and the r170 engine
   source without seeing my conclusions. Their findings are marked **(R)**.

Every finding below is either fixed or listed as open with a recommendation. `npm test` (the
headless smoke test added in this review) passes after all changes.

## 1. Bugs

| # | Finding | Where | Status |
|---|---|---|---|
| B1 | **Light leak under the ceiling.** When the sun's shadow range grew to 230 m (for the neighbourhood), `shadow.bias = -0.0004` became 9 cm, because bias is a fraction of the depth range. Every wall point within 9 cm of the ceiling counted as unshadowed, which made a bright band that moved with the time of day. | lighting.js | **Fixed.** Bias is set in metres ÷ range (0.5–2 mm). |
| B2 | **One-texel contact leak** at wall/ceiling junctions: the stored occluder was the slab's thin inner face. | room.js | **Fixed.** Walls and ceiling cast with `shadowSide: DoubleSide`, so the occluder is the outer face 15–30 cm away. Verified by **(R)** at 8× gain over 27 sun positions. |
| B3 | **(R)** **Ceiling artefact as the time changes.** The pendant shade, cord and canopy, the ceiling canopy, the corner pipe, the door levers and the curtains didn't *receive* shadows. three only applies the shadow map to receivers, so they were sunlit straight through the walls, and their lit side swung round with the sun. | pendant.js, room.js, curtains.js | **Fixed.** All of them receive. The curtains get a 4 cm extra bias on their own material, so their folds don't self-shadow into dots. |
| B4 | **(R)** **The neighbourhood never cast shadows in 3D or Plan.** r170 picks shadow casters by the *viewing* camera's layers (WebGLShadowMap.js:179/335), and `shadow.camera.layers` does nothing. The surroundings are on layer 1, which is only visible in Walk. | lighting.js, main.js | **Fixed.** Shadows render with a camera that sees all layers but nothing in view; the frame then reuses the maps. The neighbours' shade now shows in every view. |
| B5 | Dev server: a malformed escape (`/%E0`) threw out of the handler and stopped the server, and the root check `startsWith(root)` let a sibling folder through (`../living-room-x`). | scripts/serve.mjs | **Fixed.** |
| B6 | `compact-obj.mjs` rounded texture coordinates to 1 decimal, which wrecks 0–1 UVs (the chair), and dropped `usemtl`-only part names. | scripts | **Fixed.** UV precision is chosen from their range, and material names become groups. The sofa asset is reproduced byte for byte. |
| B7 | Test harness: `proc.kill()` on Windows only stops Edge's launcher, which leaked about 550 headless processes over the session. | scratch harness | **Fixed** (`taskkill /T`). The new smoke test does the same. |
| B8 | **(R)** **Light capture depended on history.** Each capture started from the previous environment, so big changes (Evening, scrubbing past sunset) carried old light over and popped. | indirect.js | **Fixed.** Each capture starts from no indirect light (two passes: direct, then one bounce), there is at most one white-balance re-capture, and exposure eases in over about 0.3 s. |
| B9 | **(R)** Sun shone from up to 1° *below* the horizon, upward through the floor. | lighting.js | **Fixed.** It fades in from 0.3° to 6°. |
| B10 | **(R)** **Wrong colour space:** `setHSL` defaults to linear in r170, so the tree crowns came out pastel mint and the low sun not warm enough. | surroundings.js, lighting.js | **Fixed.** Crowns use sRGB HSL; the sun uses a colour-temperature lerp (about 5700 K overhead to 3000 K at the horizon). |
| B11 | **(R)** The sky shader skipped tone mapping (no `tonemapping_fragment`), so the windows ignored exposure. | room.js | **Fixed.** |
| B12 | **(R)** The curtains drew before the window glass, so from inside the glass tinted the voile. | curtains.js | **Fixed** (renderOrder 3). |
| B13 | Walk eye height of 1.7 m against a shade bottom of 1.68 m: you walked into the lamp. | main.js | **Fixed.** The shade is an obstacle when it hangs below eye height. |
| B14 | 3D labels painted over the room card and toolbar: three.js gives each label a z-index from its distance, up to millions, and the page had no explicit layers. | index.html | **Fixed** (design review R4). |

## 2. Graphics fidelity

| # | Finding | Status |
|---|---|---|
| G1 | **The floor looked dark (materials, not lighting).** It had two glossy layers (base specular plus clearcoat), both reflecting a generic studio environment, which made a milky haze at low angles. The texture had been darkened about 20% to cancel it, so seen from above it read dark and reddish. Floor/wall luminance was 0.27 from above and 0.5–0.9 at low angles, against 0.33–0.38 in the photo. | **Fixed.** The albedo is calibrated against the white wall from four photo pairs: luminance ratio 0.31, then desaturated a third because phone JPEGs boost saturation. One satin lacquer layer with `specularIntensity` 0.4. |
| G2 | **Ambient light didn't come from the room.** It was a generic RoomEnvironment plus a hemisphere light plus a fake floor-bounce light. | **Replaced.** The room is captured from inside as a light probe after each change (indirect.js): bounced light off the oak and walls, and real reflections. Exposure is metered from the same capture like an incident-light meter, with a partial white balance (otherwise the oak bounce turns the room orange). Outdoor materials use a separate sky environment. |
| G3 | **(R)** One central probe sees about 80% floor looking down, so the ceiling came out dark and orange. My first patch, an upward floor-sized light, also lit furniture undersides and the hallway. | **Fixed.** The ceiling has its own 64² probe 30 cm below it, and the patch light is removed. |
| G4 | **(R)** Reflections came from the room centre, so the window reflections slid across the floor as you walked. | **Fixed.** Box-projected environment lookup on the floor (shader-hooks.js). |
| G5 | No ambient occlusion, so inside corners looked flat. | **Added.** Analytic corner darkening from the room box (corner-ao.js); no extra pass. **(R)**: it no longer darkens sun or lamp light, only indirect light and the window area lights. |
| G6 | Shadow frustum fixed at ±6 m, 5.9 mm texels. | **Fixed.** Refitted to the room and balcony for each sun direction: 3.4 mm texels, with normal bias at 1.5 texels. |
| G7 | **(R)** The normal-offset bias detached low-sun shadows from furniture legs (about 4 cm at 10° elevation). | **Fixed.** No normal offset on the floor, which casts nothing. |
| G8 | **(R)** Colour banding on walls and ceiling. | **Fixed** (`dithering`). |
| G9 | **(R)** Window light emitted equally up and down. | **Fixed.** The window area lights tilt 25° down, as sky light falls. |
| G10 | Dusk went near-black navy, because exposure was capped at 6 and the window colour was saturated blue. | **Fixed.** Day cap 10, desaturated dusk colour. |
| G11 | Cut walls showed only their inner faces as a grey band. | **Replaced** by flat black section caps in 3D and Plan (user request). |
| G12 | **Open.** Ceiling/wall brightness is 0.64 against the photo's 0.80, and the floor 0.19 against 0.28. A single probe per surface can't fully stand in for global illumination, and the photo was taken in different light (March, 12:35). Next steps: probes per wall, or baked lightmaps for the static shell (offline, in a build step). |
| G13 | **(R) Open.** No contact shadows under furniture: the probe and window lights ignore it. Cheapest fix: a soft footprint decal per piece. |
| G14 | **(R) Open (engine limit).** Area lights give no clearcoat, sheen or shadows in r170, and they reach the hallway through the wall. Strip the area-light loop from the hallway materials. |
| G15 | **(R) Open.** Terrain doesn't cast and only covers ±250 m, so the Uetliberg skyline doesn't end winter afternoons early (unverified estimate). Precompute a horizon-angle table per azimuth in scripts/surroundings.py. |
| G16 | **(R) Open.** Nothing outdoors receives shadows, so the view out looks flat. Use cascaded shadows in Walk only, or a cached top-down shadow texture per sun change. |
| G17 | **(R) Open.** Tree crowns are solid spheres that cast 100% shadow. Give them a hashed-alpha shadow material with month-dependent opacity, as the curtains have. |

## 3. Performance

A later, deeper performance review, with measurements and the fixes made since, is in
[performance-review.md](performance-review.md).

| # | Finding | Status |
|---|---|---|
| P1 | The render loop ran every frame. | It already drew on demand. Shadows are now cached too (`shadowMap.autoUpdate = false`) and re-render only when the sun, lights, doors or furniture change. |
| P2 | 1,021 tree crowns at icosphere detail 3 came to 1.3 M triangles. | **Fixed.** Detail 2 within 60 m, detail 1 beyond: about 110 k. |
| P3 | **(R)** The capture read back six faces synchronously, stalling the GPU. | **Fixed.** `readRenderTargetPixelsAsync`, and the sky environment only re-filters when its colours change. |
| P4 | **(R)** The lamp's shadow map was 1024² (a 4096 × 2048 cube unwrap plus depth, about 64 MB). | **Fixed:** 512², about 16 MB. |
| P5 | The surroundings received shadows outside the shadow frustum: wasted lookups on about 50 k triangles. | **Fixed:** they cast only. |
| P6 | Walk allocated vectors every frame. | **Fixed** (scratch vectors). |
| P7 | `scripts/surroundings.py` took 3 minutes per run and used deprecated `np.fromstring`. | **Fixed:** a cached area parse keyed by an md5 of the inputs (`hash()` is salted per process), and `np.loadtxt`. Reruns take about 1 s with identical output. |
| P8 | **(R) Open.** All 1,021 trees and both building meshes draw into every shadow update, since there's one 500 m bounding sphere. Cull trees to the shadow frustum on the CPU per sun change, and tile the buildings at about 50 m. |
| P9 | **(R) Open.** Phones run pixel ratio 2 with MSAA, physical materials, three area lights and PCF-soft shadows. Render at a lower ratio while the camera moves and redraw at full ratio when idle. This needs a separate low-resolution target, because resizing the drawing buffer each time is expensive. |
| P10 | **(R) Open (low).** The walk camera's near plane is now 0.1 (was 0.05) for depth precision outdoors. Reversed depth is an option on desktop. |

## 4. Structure and duplication

`main.js` had grown to 1,260 lines with nine loosely related sections. It is now 614 lines, and
the new modules each take their dependencies explicitly:

| Module | What | Lines |
|---|---|---|
| `editor.js` | select, drag, nudge, rotate, undo; the edit panel, finish pickers, looks; info card | 467 |
| `accessibility.js` | announcer, folding card, More menu, views radio group, 3D keyboard navigation, room in words | 180 |
| `cutaway.js` | walls cut down to a stub, plan section, caps and dimension visibility | 52 |
| `indirect.js` | room light probe, ceiling probe, exposure and white-balance meter | 138 |
| `shader-hooks.js` | composable `onBeforeCompile` patches: chunk editing, room-space varyings, box projection, per-material shadow bias | 91 |
| `corner-ao.js` | corner darkening (uses shader-hooks) | 51 |
| `util.js` | seeded random numbers, `damp`, easing (replaced copies in walk.js, textures.js, surroundings.js) | 16 |

Other merges:

- **Shader patches** used to be one `onBeforeCompile` per material, so a second feature would
  silently overwrite the first. They now stack by name with a combined program cache key, and an
  edit that no longer matches the three.js chunk throws instead of compiling the wrong shader.
- **Cut heights** (`SECTION`) and **probe positions** (`PROBE`, `CEILING_PROBE`) are defined
  once in room.js and shared by the cutaway, the caps, the shaders and the capture.
- **The sun shadow range** (`SUN_SHADOW`) is defined once. The bias arithmetic in lighting.js
  and curtains.js derives from it.
- **CSS:** the three copies of the outlined pill button in the edit panel are one rule.
  **Open:** the frosted panel surface (background, border, blur, shadow) is still repeated in
  12 rules and could become one class.

### Folder layout

The 17 modules used to sit side by side in `src/`, and the project root held the photos, the
manufacturer downloads (several hundred MB) and the swisstopo tiles. They're now grouped by
what they do, and everything not needed at runtime is out of the way:

| Folder | Contents |
|---|---|
| `src/` | `main.js` (wiring), `config.js` (measurements), `util.js` |
| `src/scene/` | room, textures, pendant, curtains, annotations, cutaway, surroundings, fixtures (the fittings you can tap) |
| `src/lighting/` | lighting, indirect, sun, corner-ao, shader-hooks |
| `src/furniture/` | furniture (catalog, layout, looks), editor |
| `src/controls/` | walk |
| `src/ui/` | accessibility, loading |
| `assets/` | only what the page loads: `catalog/` (products and presets, see catalog.md), `furniture/`, `plants/`, `surroundings/`; and `incoming/`, a drop folder that isn't published |
| `docs/` | reviews, `photos/` (the five reference photos) |
| `raw/` | not in git: `downloads/` (manufacturer files), `swisstopo/` (tiles, cache) |

Imports only point down or sideways (`main.js` → folders → `config.js`/`util.js`); no module
imports `main.js`. The second copy of the seeded random generator in textures.js now comes from
util.js.

## 5. Tooling added

- `npm test` (`scripts/smoke.mjs`):
  - opens the app in headless Chrome or Edge on its own port and goes through every view,
    Evening, the doors, the sun slider, Edit, rotate and undo
  - checks that a drag outside Edit never moves furniture and that phones don't scroll sideways
  - fails on any console error or uncaught exception
- `npm run surroundings`: rebuilds the swisstopo data, cached.
- `npm run build:artifact`: also writes `dist/files.json`, the list of every runtime file, so a
  publish can't miss an asset.
