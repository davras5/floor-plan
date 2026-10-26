# Guide

The full guide to the living-room planner: views and controls, light, the furniture and its finishes, the
catalog, tests and files. The short version is the [README](../README.md).

An interactive three.js model of the living room, built from the photos in [docs/photos/](photos/).
It starts as an empty room so furniture can be added and compared later.

## Run it

```sh
npm start
```

Then open <http://localhost:5173>. (Any static server works, for example `python -m http.server`.
Opening `index.html` straight from disk won't work, because browsers block ES modules on `file://`.)

## Views and controls

| View | How to move |
| --- | --- |
| **3D** | Drag to orbit, scroll or pinch to zoom (toward the pointer), right-drag to pan. Double-click to glide to a spot. Walls facing you drop to a low cut so you can see in. |
| **Plan** | Top-down, cut at 1.2 m like an architectural plan. Drag to pan, scroll or pinch to zoom. |
| **Walk** | Eyes at 1.59 m, as for a 1.70 m person (`person` in `src/config.js`). Like a PC game: hold the left mouse button and drag to look around (right turns right, up looks up); WASD walks and strafes, Shift runs, Q/E or ←/→ turn. Otherwise the mouse is an ordinary pointer: a click on a piece or fitting opens its card, a click on the floor walks you there. On touch screens, twin-stick: the left thumb is a joystick that walks you (push further to go faster), the right thumb drags to look, and a tap on the floor walks you there. You walk around furniture, not through it. |

Press the active view's button again to reset its camera (Walk goes back to the entry door).
Panning can't lose the room: the camera's focus point stays in or near it.

- **Edit** lets you move and rotate furniture (see below). Outside Edit, furniture ignores taps
  and drags, so looking around never moves anything by accident.
- **Sun** (in the toolbar): one tap switches between day (13:00) and evening (just after dusk for
  the chosen month, when the ceiling light comes on by itself); the icon shows which. The chevron
  next to it (or a long press on the narrowest phones, where the chevron is hidden) opens a panel
  with the time of day (6:00–23:00) and the month. The sun is where it really is over the flat at
  that moment, and the neighbours' buildings and trees cast their real shadows into the room. After
  sunset the sky fades to dusk.
- **The room's fittings** can be tapped like furniture. Each card says what it is and can do:
  - the **ceiling light**: *Turn on* / *Turn off*, and *Automatic* (on once the sun is down) after
    you've switched it by hand;
  - the **entry door**, the **balcony door** and the **window** (both sashes): *Open* / *Close*, to
    check clearances;
  - the **curtains**: *Close* draws both panels across the rail; *Open* gathers them again.
- **Presets** (top right): whole-room looks and layouts, one tap each, each with its layout-check
  score; **None** shows the empty room. See Furniture below.
- **The room card** (top left) folds to its title line: the room's size and the **layout check**'s
  score. Open it for the eight rules with a reason each; while it's open the practice zone and the
  line between the doors are drawn on the floor. See [Layout check](#layout-check).
- **Settings** (the gear in the toolbar) opens a small panel:
  - **Show measurements** (off at first): wall dimensions, door and window swings, and the
    ceiling-light position.
  - **Rendering quality**: how much the app draws. See [Rendering quality](#rendering-quality).
- Hover (or tap) the floor in 3D or Plan to read the distance to all four walls.

### Rendering quality

**Auto**, the default, picks a level for the device; or choose **Battery saver**, **Balanced** or
**High**. The choice is remembered in the browser (`src/quality.js`).

| | Battery saver | Balanced | High |
| --- | --- | --- | --- |
| Resolution, device pixels per CSS pixel (never more than the screen has) | 1 | 1.5 | 2 |
| … while the view moves (orbit, pan, walk, a drag); full again once it's still | 0.75 | 1 | 1.5 |
| Edge smoothing (antialiasing) | off | off | on |
| Shadows | simple | simple | real (shadow maps) |
| Sun shadow map | — | — | 2048 px |
| Lamp shadow map, per cube face | — | — | 512 px |
| Second light capture for the white balance after a big change of light | no | yes | yes |
| A dragged piece's shadow | follows when it's put down | follows it | follows it |
| Texture filtering (anisotropy) | 2× | 4× | 16× |
| Parquet texture | 280 px/m | 400 px/m | 400 px/m |
| Neighbourhood (Walk, shadows, light capture) | coarser terrain and trees, 1024 px aerial photo | full, 1024 px photo | full, 2048 px photo |
| GPU memory on a phone (390 × 844, pixel ratio 3), by day / at night, measured with 1024 px shadow maps on every level | about 71 / 76 MB | about 83 / 87 MB | about 162 / 179 MB |

- **Simple shadows** (Battery saver and Balanced, so phones and tablets): no shadow maps. The sun
  comes into the room only where its ray leaves through a pane of the window or the balcony door,
  past the wall opening, the balcony above, its parapet and the screen to the neighbour's
  (`src/lighting/window-sun.js`); the neighbours' buildings and trees dim each pane by a few rays
  toward the sun. Furniture casts no sun shadows and stands on soft contact shadows instead
  (`src/scene/contact-shadows.js`). The lamp lights the room without shadows.
- **Shadow maps are never used** on Imagination PowerVR graphics (Pixel 10: they crash Chrome's
  graphics process within seconds; [performance-review.md](performance-review.md), round 3), nor on
  a device where the 3D view once stopped with them on. High then draws simple shadows too, and
  the settings panel says why.
- **Auto** starts with Balanced on phones (Battery saver where the browser reports at most 4 GB of
  memory or 4 cores), Balanced on tablets and High on computers (Balanced with at most 4 GB or 4
  cores). Once the room has loaded it watches the frames while the view moves, and steps down a
  level if they come slower than about 22 a second (the median of 24). A step down is remembered
  for the next visit; choosing Auto again starts over.
- A new level applies at once. Edge smoothing is the exception: a WebGL page can only choose it
  when it starts, so the panel offers **Reload now**, which keeps the view and the time of day.
- Measured costs of each setting are in [performance-review.md](performance-review.md).
- **When something goes wrong** (the phone's graphics memory runs out and the 3D view stops, a
  shader doesn't compile on the graphics chip, an error), a small panel at the top says so and
  offers what helps: Reload, or Battery saver and reload. **Copy details** gives the graphics chip
  and its limits, the screen, the quality level, the browser and the errors, for a bug report
  (`src/ui/diagnostics.js`).

## Light and surroundings

- **Direct light:** the sun (with shadows), the sky through the window and balcony door, and the
  pendant in the evening. The sun's position comes from the date and time ([src/lighting/sun.js](../src/lighting/sun.js)).
- **Indirect light:** whenever the light changes (sun, lamp, doors, furniture), the room is
  captured from its middle and that capture lights everything as bounced light and reflections
  (the windows in the lacquered floor). The same capture meters exposure and a partial white
  balance, like a camera ([src/lighting/indirect.js](../src/lighting/indirect.js)).
- **Inside corners** darken softly, the way light falls off where surfaces meet ([src/lighting/corner-ao.js](../src/lighting/corner-ao.js)).
- **The neighbourhood** within 250 m comes from swisstopo open data: terrain with the aerial photo,
  buildings with roofs, and trees found in the surface model. `npm run surroundings` rebuilds
  `assets/surroundings/` from `scripts/surroundings.py` (downloads ~150 MB once, into `raw/swisstopo/`).
  The flat's window wall sits on its building's garden facade, which faces 209° (SSW).
- **Curtains:** the sheer white voile panels from the photos, gathered at both ends of the rail
  (`curtains` in [src/config.js](../src/config.js)).
- **Cut walls** in the 3D view and in Plan show a black section cap, like an architect's drawing.

## Layout check

The room is scored against the rules of the [layout review](layout-review.md), the way an interior
designer and a feng shui practitioner would look at it, for a room that is also a yoga studio
(`src/furniture/layout-check.js`). It runs on the room as it is (so it follows a drag in Edit and
Custom), and on each preset before it's applied, for the score in the Presets panel. Each rule
passes, warns or fails; the score counts the passes.

| Rule | Passes when |
| --- | --- |
| Commanding seat | The sofa has a wall within 8 cm behind it and sees the entry door (within 80° of straight ahead), not straight in line with it. |
| Doors clear | Nothing stands in either door's swing (a fail), nor on the straight line between the two doors (a warning). |
| Head room | Nothing hangs below 2.0 m over open floor: the pendant passes over a table, warns over a seat, fails over open floor. |
| Soft corners | No dining-table corner within 60 cm of a sofa or pouf (a warning). |
| Lane | The way from the entry door to the balcony door is at least 90 cm wide at its narrowest, measured row by row across the room between furniture, the pendant at head height, and the walls; 70 cm warns. |
| Dining chairs | At least 75 cm from the table's edge behind every chair to a wall or another piece; 60–75 cm warns. 90 cm or more is room to pass as well as sit. |
| Practice zone | Clear floor for a 2.0 × 0.8 m mat: 2.6 × 1.6 m free-standing, or 2.3 m out from a wall × 1.4 m along it with the mat's head at that wall (30 cm either side of the mat), with nothing below 2.2 m over it and not in the entry door's swing. A zone only in the line between the doors warns (the balcony is cut off while you practise). |
| Free wall | A stretch of wall 1.4 m long with 2.3 m of clear floor in front, free of furniture, door swings, the window and pictures, for inversions; 1 m of floor in front warns (standing poses only). |

The floor is rasterised at 5 cm for the zone search; a piece blocks any cell it reaches 1 cm into.
Pictures count for the wall they hang on (a wall used for inversions must have nothing where
hands and feet go). The practice zone found is the best one: out of the lane first, then with the
mat's head at a wall, then farthest from the line between the doors.

Presets can swag the pendant (`pendant` in [presets.json](../assets/catalog/presets.json)): the
cord runs along the ceiling from the outlet to a hook and drops from there, the lamp's light moves
with the shade, and the check sees it where it hangs. The recommended layout hangs it over the
dining table.

## Tests and tools

- `npm test` checks the catalog (`scripts/check-catalog.mjs`), then opens the app in headless Chrome
  or Edge, goes through every view, Edit, the lamp, the doors, window and curtains and the sun, checks that furniture only moves in Edit and that phones don't scroll
  sideways, and fails on any console error. It also opens the settings panel: dialog semantics,
  Esc and focus, Show measurements, a quality level applied live, arrow keys between levels, and
  on phones (360 and 390 px) that the panel fits, its targets are 44 px and the toolbar stays one
  row. It checks the layout check too: the card's score and its eight rules, the zone drawn on the
  floor while the card is open, a score next to every preset that equals the card's once that
  preset is applied, the layouts' ranking, the recommended layout's swagged pendant, and the Sun
  switch (evening with the light on, day again, the panel opened by its chevron and closed by Esc).
  Screenshots land in `test-output/`.
- `npm start` (`scripts/serve.mjs`) serves text files compressed (brotli or gzip, like a real host;
  `COMPRESS=0` to turn it off) with ETags, so reloads only fetch what changed.
- `npm run build:artifact` writes `dist/index.html` plus `dist/files.json`, the list of every file
  the page loads, for publishing it as a claude.ai artifact.
- Picking furniture under the pointer uses [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)
  (from the CDN, loaded once the furniture is in; without it, picking works as before, just slower).
  [code-review-2.md](code-review-2.md) has the second code review: bugs, performance and robustness.

## Measurements

Every size lives in [src/config.js](../src/config.js). The current values were **measured from the
photos** (each photo's camera calibrated from the room's straight lines, scaled by the 2.50 m
ceiling): a few cm on the window wall, ±15 cm on the room's length. Measure the
room and update that file; the model, the dimension lines and the info card all follow.

The **balcony** (`balcony` in the same file) comes from a later set of photos taken on it and
looking out at it (not in the repo): each camera's position was solved from the window panes, whose
sizes the model knows, and the parapet, floor and screen were found along the cameras' rays, to
about ±10 cm. It's a
concrete slab 12 cm below the room's floor, 1.50 m deep inside a solid parapet 80 cm high (a dark
capping along the front, a stone coping on the short side parapet at the right-hand end, 3.93 m
from the left corner). A 2.2 m dark metal screen on the party-wall line parts it from the
neighbour's balcony, and the balcony above, 2.55 m over the room's floor, is its roof (Walk only).

The most useful numbers to measure first:

1. Room width (window wall) and length (long walls), wall to wall
2. Ceiling height
3. Window: distance from the left corner, width, sill height
4. Balcony door: width
5. Entry door: distance from the right-hand wall, width

## Files

```
index.html                 page, styles, UI
src/main.js                renderer, cameras, views, render loop, picking, light capture, wiring
src/quality.js             rendering quality: the levels, Auto, remembering the choice
src/config.js              room measurements
src/util.js                small shared helpers (seeded random numbers, smoothing)
src/scene/                 room.js (walls, openings, window, doors), textures.js (parquet),
                           pendant.js (hung from the outlet or swagged), curtains.js,
                           annotations.js (dimensions, swings), cutaway.js (cut walls, plan
                           section), surroundings.js (swisstopo), fixtures.js (the light, doors,
                           window, curtains you can tap), layout-overlay.js (the practice zone
                           and the door line on the floor)
src/lighting/              lighting.js (sun, windows, lamp, exposure, white balance),
                           indirect.js (light probes), sun.js (sun position),
                           corner-ao.js, shader-hooks.js (stackable shader patches)
src/furniture/             furniture.js (loads the catalog; finishes, placing, outline, card),
                           editor.js (Edit: select, drag, undo, edit panel, info card, presets),
                           layout-check.js (the room against the layout review's rules)
src/controls/walk.js       first-person walking
src/ui/                    accessibility.js (keyboard 3D view, room in words, folding panels),
                           loading.js (loading bar and status), popover.js (a panel next to a
                           button), settings.js (the gear's panel), sun.js (the Sun switch and
                           its panel), layout-card.js (the layout check in the room card),
                           diagnostics.js (the panel that reports problems)
assets/catalog/            products.json, presets.json and their schemas (docs/catalog.md)
assets/furniture/          web-ready models, finishes (options.json) and swatches
assets/plants/             the plants (GLB) and where they come from (info.json)
assets/art/                the framed prints: frame models (GLB), print images, options.json
assets/garden/             the balcony's table and chairs (GLB, made for this planner), options.json
assets/surroundings/       processed swisstopo data
assets/incoming/           drop folder for new downloads (not published, not in git)
scripts/                   serve.mjs (dev server), smoke.mjs and check-catalog.mjs (npm test),
                           compact-obj.mjs, surroundings.py, build-artifact.mjs, plants/,
                           art/frames.mjs (the print frames), garden/askholmen.mjs (balcony)
docs/                      catalog.md, code-review.md, performance-review.md, design-review.md,
                           photos/ (the reference photos)
raw/                       not in git: manufacturer downloads (raw/downloads/) and swisstopo
                           tiles (raw/swisstopo/)
```

## Furniture

Everything that can stand in the room, where it stands, and the presets are data, not code:
[assets/catalog/products.json](../assets/catalog/products.json) (one uniform spec per product) and
[assets/catalog/presets.json](../assets/catalog/presets.json) (the room's pieces and the presets, with
places and rotations). [docs/catalog.md](catalog.md) describes both; JSON schemas next to them
let an editor check them as you type, and `npm test` checks that every preset only picks options
the maker sells.

A first visit starts with the **Outline 2-seater + pouf, Steelcut 220** preset (`#preset=wood-white`):

- **Muuto Outline Soft Sofa, 2-seater** (170 × 84 cm, Steelcut 220 on polished aluminium legs), back
  against the left wall, 45 cm from the window wall.
- **Muuto Outline Pouf** (111 × 78 cm, 40 cm high), turned as a chaise in front of the sofa's
  window-end seat, 25 cm off the seat front and 15 cm past the sofa's end, so the two make an L.
  Sofa z 0.45–2.15 m, pouf x 1.15–2.26, z 0.30–1.08 m, clear of the balcony door and the curtains.
  It follows the sofa's upholstery and base (**Match the sofa**) until you give it its own. Muuto has
  no 3D model of the pouf on castors, so that option is shown with legs.
- **Muuto Soft Side Table, Ø 48 cm, 40 cm high** (oak top on the grey base, the palest Muuto sells),
  as the coffee table: centred on the sofa's door-side seat, 30 cm off its front, x 1.19–1.67,
  z 1.39–1.87 m. All four of Muuto's sizes are there (Ø 41 or 48, 40 or 48 cm high, one model each):
  **Size** under Finish.
- **Muuto Workshop Table, 130 × 65 cm** (Warm Grey linoleum, oak frame; 73 cm high): where the dining
  table stands in the photos, in front of the poster on the entry-door wall, its long side running
  away from that wall, 20 cm off it.
- **4 × Muuto Fiber Side Chair, wood base** (Natural White shell, oak legs), two along each long side
  of the table, placed relative to it. One model shared by all four; each chair's finish is its own.
- **Three small plants on the windowsill** (y 0.84 m, in the window recess, behind the curtain line):
  a zebra haworthia in a white glazed pot (Poly Haven, CC0) at x 0.98 m, a young rubber plant in a
  terracotta pot at 1.55 m and a snake plant in a charcoal pot at 2.10 m, both made for this planner
  (CC0, `scripts/plants/`). They stay where they are in Edit; **Remove** takes one out.
- **Two framed art prints**, both late Lake Geneva landscapes by Ferdinand Hodler (public domain),
  sold as giclée prints on cotton paper by the Fondation Beyeler's shop (CHF, delivered in
  Switzerland):
  - over the sofa, *Le Grammont après la pluie* (1917), sheet 60 × 80 cm, 83 × 63 cm framed: its
    bottom edge 1.05 m up (25 cm above the Outline's back), centred on the sofa;
  - over the dining table, *Le Mont Blanc aux nuages roses* (1918), sheet 50 × 70 cm, 73 × 53 cm
    framed, centred on the table, its middle at 1.49 m.

  **Frame** under Finish: white wood (the Beyeler's own frames, collected at the museum), oak
  or black (boesner Quadro for the 60 × 80; Moebe Frame, posted by Connox, for the 50 × 70), with
  the frame's price added to the print's. The card names the shop for each, and **Model** hangs
  the other print instead. They stay where they are in Edit; **Remove** takes one off the wall.
  The models are made by `scripts/art/frames.mjs`; the images and their licence are in
  [THIRD_PARTY.md](../THIRD_PARTY.md).
- **On the balcony, IKEA ASKHOLMEN**, folding and in dark brown stained acacia like the chairs in
  the balcony photos: the table (60 × 62 cm, 73 cm high, CHF 39.95) 5 cm from the parapet in
  front of the window, and two chairs (36 × 49 × 87 cm, CHF 30 each) facing each other across it
  (x 0.38–2.02 m, z -1.75 to -1.15 m, on the balcony floor 12 cm below the room's), so the way
  from the balcony door along the facade stays 85 cm wide. **Cushion** under Finish adds IKEA's
  KUDDARNA chair pad (light grey-beige, CHF 7.50; the *Ecriture 210* preset has them). IKEA has
  no 3D model of either: `scripts/garden/askholmen.mjs` builds them, slat by slat, to IKEA's
  dimension drawings. They stay put in Edit; **Remove** takes them away.
- **The existing pendant**, traced from the photos and hung from the ceiling outlet (one of the
  room's fittings, see Views and controls).

Also available: the **Muuto In Situ 2-seater, configuration 7** (216 × 169 cm, Clay 12, black frame;
the manufacturer's model) and the **Outline Soft 3-seater** (220 × 84 cm), under **Model** with the
sofa selected, or with a preset. Every sofa keeps its corner, back to the left wall and 15 cm from
the window wall (45 cm with the pouf). The coffee table follows the sofa (another model, the pouf
coming or going) unless you've moved it; in front of the In Situ, whose chaise reaches 60 cm
further than its seat, it stands 5 cm past the chaise.

Tap or click a piece in any view to see what it is: a card next to it gives the product (linked to
its page), its finish, its size (W × D × H), Muuto's price and item number for that configuration,
and **Shop**, a link to exactly that configuration at muuto.com. A plant's card says where its model
comes from. In Walk the tap also walks you up to it. **Change finish** on the card, or Esc / × / a tap
elsewhere to close it. The selection gets a yellow outline around its silhouette.

**Presets**, top right, set the whole room in one tap, in any view and without Edit. Seven looks
keep today's layout and are named by product, configuration and fabric, with the rest below in the
same order (legs or frame · side table · chairs · lamp): *Outline 2-seater + pouf, Steelcut 220*
(the default), *Outline 2-seater + pouf, Clay 12*, *Outline 2-seater, Steelcut 220* (no pouf; the
side table stands in front of the window-end seat instead), *Outline 3-seater, Steelcut 220* (the
220 cm sofa, for the size question), *Outline 2-seater, Remix 183* (charcoal: the dark look),
*In Situ 2-seater with chaise, Clay 12* and *In Situ 2-seater with chaise, Ecriture 210*. Three
layouts from the [layout review](layout-review.md) move the furniture as well, each in two looks:
*Dining at the window* (the recommended one: the table by the window, the sofa at the entry end
seeing the door with the lamp in the corner behind it, the middle of the room open as the practice
zone, the pendant swagged over the table) in dusty blue Ecriture 760 or moss green Hallingdal 960;
*Everything on the left wall* (the smallest change from today) in Clay 12 or cognac Refine Leather;
and *Sofa facing the view* in sand Ecriture 210 or rust Steelcut Trio 533. Why these finishes, and
what the catalog still lacks, is in [presets-review.md](presets-review.md). Each shows its colours
(sofa, chair shell, wood, table top) and its layout-check score, and the one the room matches has a
check. If you've made your own changes, picking a preset keeps
them under **Custom**, so you can go back to them. **None** shows the empty room (the furniture is
hidden, not changed). Each pick is one undo step. The preset is in the page's link
(`#preset=wood-white`, or `#preset=none`), so a link opens the room that way; on a first visit it
loads directly, otherwise it's applied over your own room, which stays under Custom. On phones the
list folds to one line, "Presets · Outline 2-seater + pouf, Steelcut 220".

Turn on **Edit** (works in every view, including Walk). Then tap or click a piece, or pick it from
the list in the edit bar, and:

- drag it to move it; it snaps to 2 cm off a wall when you get close
- use **Rotate 90°** or press R (Shift+R turns the other way)
- use the arrow keys to nudge it 1 cm (Shift: 10 cm); ↑ moves it away from you on screen
- use **Reset** to put it back where `presets.json` places it
- use **Undo** or Ctrl/Cmd+Z to step back through moves, turns and resets
- press Esc to put the piece down (Esc again leaves Edit)
- **Remove** takes out the pouf, the coffee table or a plant; **+ Pouf**, **+ Coffee table** and so on
  in the edit bar put them back (adding the pouf moves the sofa to make room, unless you've moved it)
- under **Finish**, pick any colour or material Muuto sells for it: all 878 In Situ upholsteries
  (27 fabric and leather families, chosen from the list, with their price), the 1,005 for the Outline
  pieces (30 families), the Outline base, the Fiber shell, base and glides, the Workshop table's
  finishes, and the Soft Side Table's size, top and base. Arrow keys move along a row of swatches.
  **Apply to all 4 chairs** copies one chair's finish to the others; **Default finish** goes back to the
  one in `options.json`. **Reset** only moves the piece back, so the finish you picked stays.

In Edit the selected piece's footprint is tinted and dashed lines show its clear distance to each
wall. Moves and finishes are remembered in your browser (finishes survive a change to the default
layout).

#### Where the finishes come from

Each piece's `assets/furniture/<name>/options.json` lists every option of Muuto's online configurator
(muuto.com, EU shop, fetched 2026-10-26: names, codes, item numbers and EUR prices). The swatches are
Muuto's own swatch images, packed into one sprite sheet per fabric family; the sheets and textures in
`assets/furniture/muuto-upholstery/` are shared by every upholstered piece. The materials draw each
option in its swatch's average colour. Fabric and leather families add a weave or grain texture
taken from Muuto's AR models (Cylindo), at the scale those use. Where Cylindo has none, the texture
comes from Muuto's swatch scan, made tileable. The chair bases and the table use the textures in
Muuto's 3D downloads. 32 upholstery colours have no swatch from Muuto (31 Illusion leathers and Easy
Leather Sea Breeze); their colour is guessed from the name and their swatch is hatched. The Workshop
table's Black and Oak finishes are sold only in the bigger sizes, so they're struck through and have no
price.

The Soft Side Table's options are everything its configurator sells: 6 tops (Black Nanolaminate, Grey
Linoleum, Beige Green and Orange Laminate, Solid Oak, Solid Smoked Oak) with 4 bases (Black, Grey, Beige
Green, Orange), every combination in every size. The price depends on the size and the top: EUR 425
(Ø 41) or 495 (Ø 48), and EUR 495 or 569 in oak. Muuto sells no white base in any of its shops; Grey,
the palest, is the default. The oak textures and the black and grey colours are from Muuto's 3D
download; Beige Green and Orange are matched to Muuto's photos, since the download's colours render
far too saturated. The size swatches are the four models seen from the side, at one scale.

### Adding another piece

1. Put the manufacturer's download in `assets/incoming/` (a drop folder, not published or in git).
   Compact its OBJ: `node scripts/compact-obj.mjs "path/to/model.obj" assets/furniture/<name>/model.obj`
   (it turns `usemtl` materials into groups and keeps 4 decimals for 0–1 texture coordinates), or
   use a GLB. Then move the download to `raw/downloads/`.
2. Add the product to [assets/catalog/products.json](../assets/catalog/products.json): maker, name,
   category, its page and the page of one configuration (`itemUrl`), the listed size, the model
   file and its unit (`scale: 0.001` for millimetres), and which OBJ groups make which part, each
   with a fallback material. [docs/catalog.md](catalog.md) has the details.
3. If Muuto sells it in several finishes, make its `options.json` from the configurator; the format
   is in the comment above `loadOptions` in [src/furniture/furniture.js](../src/furniture/furniture.js).
4. Add a piece for it to [assets/catalog/presets.json](../assets/catalog/presets.json) (where it stands)
   and, if you like, to the presets. `npm run check:catalog` checks it all.

The original manufacturer downloads (several hundred MB of .max/.skp/.dwg/.obj files and zips)
live in `raw/downloads/`. The app doesn't need them, and `raw/` is in `.gitignore`.