# Performance review

Two rounds of performance work, following [code-review.md](code-review.md), whose items P1–P10
they build on: [round 1](#round-1-shaders-captures-and-shadows) (the morning: shader compiles,
light captures, shadow passes) and [round 2](#round-2-loading-phones-and-a-rendering-quality-setting)
(the afternoon: loading, phones, GPU memory and a rendering-quality setting).

## Round 1: shaders, captures and shadows

**How it was measured.** Headless Edge with software rendering (SwiftShader), driven over the
DevTools protocol. The harness counted:
- WebGL draws, vertices, shader program links and time spent waiting for compiles;
- live GPU memory;
- long-frame attribution, CPU profiles and network timings.

There were two profiles: desktop at 1400 × 900, and a phone at 390 × 844, pixel ratio 2, with 4×
CPU and 10 Mbit/s throttling. **Milliseconds are software-rendering numbers: compare them with
each other, not with a real GPU.** Counts (programs, captures, draws, bytes) carry over as they are.

### Results

The same session before and after the fixes: load, Plan, Walk, 3D, Evening on and off, then the
sun to 20:30 and back to 13:00.

| Step | Programs before → after | Light captures before → after | Time before → after |
|---|---|---|---|
| After load | 65 → 42 | 3 → 2 | |
| Switch to Plan | +15 → +0 | 2 → 0 | 1.43 → 0.36 s |
| Switch to Walk | +7 → +6 | 1 → 0 | 0.72 → 0.90 s |
| Back to 3D | +0 → +0 | 1 → 0 | 2.29 → 0.77 s |
| Evening on, first time | +44 → +29 | 2 → 1 | see 4 below |
| Sun past sunset (20:30) | +38 → +0 | 2 → 2 | 1.58 → 0.26 s |
| **Whole session** | **175 → 80** | **15 → 10** | |

Each light capture means 18 cube-face renders and 55 filter passes, about 1,050 draw calls and
18 M vertices.

### Fixed

1. **A light capture ran on every view switch, during drags and while loading.**
   - Why it was waste: the capture sees the same room in every view (walls uncut, no overlays).
   - Now: view switches only redraw. A capture waits 600 ms after the last change (it was 350),
     never runs while a pointer is held (dragging a piece or the sun slider), and waits until
     the furniture and the neighbourhood are loaded.
   - That also takes the first capture off the loading critical path. Before, it blocked the
     main thread for about a second before the furniture models even started downloading.
   - Code: `scheduleCapture()` in `src/main.js`.
2. **Shadow maps were re-rendered twice per capture and once per view switch.**
   - The only part of the scene that changed between views and casts shadows is the hallway behind the entry door, and it can't shade the room.
   - It no longer casts, so shadows are the same in every view. A capture now reuses the current
     maps (`renderShadows()` runs first only if they're out of date).
3. **Each sunset recompiled every shader.**
   - The sun was hidden (`visible = false`) when it set, which changes every program's light count.
   - It now stays in the scene, dark, and only its shadow pass stops (`shadow.autoUpdate`).
     Scrubbing past sunset compiles nothing; it was 38 programs before.
4. **Evening's lamp still needs its own shaders the first time.**
   - Where the GPU compiles in the background (`KHR_parallel_shader_compile`, which Chrome has on
     most systems), those shaders are compiled while the page is idle after the first capture,
     for the screen and for the capture (`prewarmEvening()`).
   - Without that extension, as in the software renderer used here, the first Evening switch
     still pays for it: about 2.4 s there, a fraction of that on a real GPU. Later switches cost
     nothing new.
5. **The stand-in environment was the wrong size, so the first shaders were thrown away and it
   was never freed.**
   - It was made at 256 px; the capture is 128 px, and the size is part of every shader's key.
   - It's now rendered at the capture's size into the target that the captures then refill in
     place. That's about 10 fewer compiles at load and about 15 MB less GPU memory.
6. **The first bounce of each capture used its own family of shaders.**
   - The environment was unbound for the first pass (33 extra programs at the first capture).
   - It's now kept bound and dimmed to 0 (`scene.environmentIntensity`). The result is
     identical, with no new shaders.
7. **The filter was rebuilt in every capture, and outputs were reallocated.**
   - One PMREMGenerator served both the 128 px and 64 px probes, so its blur shader was rebuilt
     twice per capture.
   - Each probe now has its own generator and keeps one output target. The sky environment is
     filtered from a 32 px cube into a reused target; before, a new 768 × 1024 target was made at
     256 px each time the sky changed.
8. **Plan compiled a second version of every material.**
   - Its cut at 1.2 m used a global clipping plane (15 programs, about 0.8 s on the first switch).
   - The plan camera looks straight down from 30 m, so its near plane at 28.8 m makes the same
     cut for free.
9. **The neighbourhood was drawn into the lamp's shadow cube.**
   - With the sun down it can't cast anything that matters, yet nothing of it could be culled,
     so it went into all six faces (3.6 M vertices against 0.6 M without it).
   - It now stops casting whenever the sun is down (`setCasting()` in `surroundings.js`).
10. **Downloads.**
    - The minified three.js build: 171 KB instead of 257 KB, brotli.
    - The unused Clay 12 image is gone from the published files.

### Open

Ordered by expected payoff.

Status after [round 2](#round-2-loading-phones-and-a-rendering-quality-setting) in the last column.

| # | What | Where | Notes | Status |
|---|---|---|---|---|
| O1 | **Adaptive resolution.** Frame time is set by fill rate: a pixel ratio of 2 costs 3× a ratio of 1. | main.js | Render at about 1–1.25 while orbiting, walking or dragging, and at full resolution once still. On-demand rendering makes that cheap, but it needs a separate low-resolution target, because resizing the canvas each time is expensive. High payoff on phones. | **Done**, per quality level, by resizing the drawing buffer twice per gesture (a separate target would need a second set of shaders). |
| O2 | **Neighbourhood geometry.** Nothing of it can be culled (one mesh per kind, bounding spheres of 350–450 m). The 124k-triangle terrain alone is 29% of a Walk frame. | surroundings.py / .js | Cut into roughly 50 m tiles so frustum culling works; decimate the terrain with distance; build a separate, smaller caster set for the sun; use a cheaper material outdoors (both window area lights are evaluated on every outdoor pixel today). | **Done** in `surroundings.js` (no data change): tiles, terrain by distance (124k → 34k triangles), no area lights outdoors. With tiles the sun's shadow camera culls on its own, so no separate caster set. |
| O3 | **Furniture as glTF with meshopt.** The startup models are 4.9 MB raw and unindexed (3–5× vertex reuse is possible), with 13 meshes per chair. | furniture | `gltfpack -cc`, merged meshes per part, the selection outline precomputed. About 10× smaller (an estimate), and 3–5× fewer vertices in every pass. | Open (data, assets/furniture). |
| O4 | **Picking.** 14 ms per pick on the In Situ sofa, run on every mouse move. | furniture.js | Use three-mesh-bvh on the shared template geometry: under 0.1 ms. | **Partly:** hover picks once per frame instead of per mouse event. The BVH is open: the slowest pick is now the zebra haworthia's (3 ms, 8 ms with the phone's CPU), whose quantized geometry is decoded vertex by vertex. |
| O5 | **Furniture changes re-render shadows.** Choosing a finish or swatch only changes colour, but runs the shadow pass. Every drag frame re-renders it too: 20% of a day frame, 40% in the evening. | furniture.js | Split `onChange` into "light changed" and "shadows changed". | **Done:** a finish only re-captures the light. On Battery saver a dragged piece's shadow follows when it's put down. |
| O6 | **Downloads wait for the options files.** The model downloads start only after their options JSON has arrived. The pouf (681 KB) is downloaded even when it's not in the room. | furniture.js | Start the model fetches alongside the options; load optional pieces on first use. | **Done** for the waterfall (and the downloads no longer wait for the first frame, B17). The pouf when absent: open. |
| O7 | **The white-balance re-capture doubles the captures.** | lighting.js | Apply white balance as a per-channel gain before tone mapping, instead of re-colouring every light and capturing again. | **Partly:** Battery saver skips it. The gain: open. |
| O8 | **The light meter reads 786 KB to use 1/37 of it.** In software rendering the "async" read-back still blocked for 0.9–1.9 s; not confirmed on real GPUs. | indirect.js | Meter from a small downsample (about 1.5 KB). Spread a capture's faces over several frames so input stays responsive on phones. | Open. |
| O9 | **About 130 tiny room meshes.** 173 draws per frame and about 1,050 per capture. | room.js | Merge the boxes per material inside each wall group (doors and sashes stay separate): about 60 draws per frame. | **Done:** about 35 meshes; see round 2 for the draws. |
| O10 | **The parquet texture is generated before the first frame.** 150 ms on desktop, probably 0.5–0.8 s on phones, and 15.6 MB of GPU memory. | textures.js | It comes from a fixed seed, so bake it at build time (KTX2 or WebP), or generate it in a worker after the first frame. | **Done:** after the first frame, a row of staves at a time; 8 MB less on Battery saver. |
| O11 | **GPU memory on phones.** About 85 MB of textures after load. | | Aerial photo to 1024² (−16 MB), and the sun's shadow map at 1024 on phones (−24 MB; texels go from 4.5 to 9 mm, which the soft shadows hide). | **Done**, per level: 71–83 MB on phones against 162 MB before (MSAA canvas included). |
| O12 | **Finish textures are never freed.** Browsing all 27 upholstery families added 33 MB. Each swatch change re-uploads the shared image. | furniture.js | Cache textures by image and tiling, and evict families that haven't been used recently. | Open. |
| O13 | **Smaller items.** | | Precompute the selection outline hull (50–85 ms on first select). Draw the curtains and balcony panels in one pass instead of two. Stop the animation loop when idle (it wakes every frame). Self-host the fonts and add `modulepreload` hints. Cache static files with hashed names. | **Partly:** one-pass curtains and panels, the idle loop stops, `modulepreload`, revalidated caching in the dev server. Fonts and the hull: open. |

### Checked and fine

- **No leaks from repeated use.** Cycling the looks, views and Evening, programs, geometries,
  textures, GPU memory and the JS heap (about 30 MB) all stay flat after the first round.
  Light-probe targets are freed (now they're reused).
- **Shared resources.** The chairs share geometry and materials; event listeners are registered once.
- **Not worth changing.**
  - Removing the window area lights saves only 10–15% of a frame.
  - Standard instead of physical materials, and PCF instead of PCF-soft shadows, made no
    measurable difference.
- **The sun slider** gives one shadow pass per frame while you drag it, and now no captures until
  you let go.

The measurement scripts and raw results of round 1 live in the session's scratch folder:
`perf-review/` (the review) and `perf-mine/` (the before/after runs).

## Round 2: loading, phones and a rendering-quality setting

Reviewed the same afternoon, after the first round's fixes. The aims: measure loading and frame
times on a phone as well as a desktop, implement the open items that pay off, and give viewers a
**rendering-quality setting** (a gear in the toolbar), with **Auto** choosing for the device.
A report of the scene crashing on an Android phone came in during this round, which made GPU
memory the main concern for phones; see [Phones and GPU memory](#phones-and-gpu-memory).

### How it was measured

- Headless Edge with software rendering (SwiftShader), over the DevTools protocol, as in round 1.
  The scripts are in the session's scratch folder, `perf-review-2/`: `measure.mjs` (loading,
  frames, captures), `ab-builds.mjs` (before and after interleaved), `levers.mjs` (what each
  quality setting costs), `memory.mjs` (GPU memory per level), `limits.mjs` (shader limits).
- **Desktop:** 1400 × 900, pixel ratio 1. **Phone:** 390 × 844 at pixel ratio 3, touch, a 4× slower
  CPU, and a mediocre 4G connection: 5 Mbit/s down, 1 Mbit/s up, 150 ms round trip.
- **Before** is a copy of the code as it was at the start of this round, served by the old dev
  server; **after** is the code now. Both were measured on the same machine. Other agents' work
  ran at times, so the main comparisons were repeated interleaved (before, after, after, before…).
- **Frames:** still frames are synced (the GPU's work included), the median of three. Moving
  frames are the median time between frames while a real drag (mouse or touch events) or a held
  key goes on, so they include everything a viewer waits for.
- **Read the milliseconds as relative.** SwiftShader renders on the CPU, so a frame takes far longer
  than on any GPU; compare the numbers with each other. Counts (requests, bytes, draws, shader
  programs, MB) carry over as they are. The CPU slowdown applies to the page's main thread, not to
  SwiftShader's GPU process: phone frame times reflect the number of pixels, phone load times the
  slower JavaScript and network.

### Results

**Phone.** "After" is Balanced, what Auto gives a phone, unless a column says otherwise. High is the
same settings phones got before, so that column shows what the code changes alone do.

| Loading, phone | Before | After, uncompressed | After |
|---|---|---|---|
| All modules loaded | 1.62 s | 1.65 s | 1.26 s |
| Catalog requested → arrived | 2.75 → 2.96 s | 0.24 → 1.49 s | 0.21 → 1.10 s |
| First model requested | 4.67 s, after the first frame | 2.39 s | 2.23 s, before the first frame |
| First frame | 4.60 s | 3.80 s | 4.01 s |
| Furniture ready | 19.1 s | 13.0 s | **7.5 s** |
| Neighbourhood ready | 18.9 s | 17.0 s | **8.9 s** |
| First light capture | 23.7 s | 19.6 s | **12.1 s** |
| Transferred | 8.9 MB, 67 requests | 9.1 MB, 70 | **3.8 MB**, 70 |
| Main-thread long tasks, in all | 11.9 s | 5.3 s | 7.7 s |

"Uncompressed" is the new code from the new server with compression off (`COMPRESS=0`): the
difference to "before" is the code's, the rest is compression, which any real host does. High and
Battery saver load in the same time as Balanced, within the noise (furniture ready at 7.1 s).
The module evaluation's long task is 0.8 s instead of 1.1 s (the parquet), and the first frame's
compile 1.7 s instead of 1.8 s; the downloads now run during both.

| Frames, phone (ms) | Before | After, High | **After, Balanced** | After, Battery saver |
|---|---|---|---|---|
| 3D, still | 212 | 226 | **62** | 30 |
| 3D, orbiting | 265 | 213 | **45** | 23 |
| 3D, dragging a piece (Edit) | 819 | 363 | **101** | 50 |
| Plan, still | 549 | 271 | **48** | 31 |
| Plan, panning | no frames (B15) | 285 | **66** | 51 |
| Walk, still, toward the window | 844 | 642 | **272** | 90 |
| Walk, still, into the room | 715 | 521 | **283** | 73 |
| Walk, turning | 868 | 491 | **109** | 72 |
| Night, lamp on: 3D still | 310 | 296 | **63** | 36 |
| Night, lamp on: orbiting | 300 | 252 | **34** | 26 |
| Night, lamp on: Walk still | 1,159 | 970 | **372** | 114 |

| Other costs, phone | Before | After |
|---|---|---|
| Light capture, by day | 0.91 s; 1,038 draws, 17.6 M vertices | 0.60–0.69 s at High, 0.37–0.48 s at Balanced; 1,257 draws, 6.2 M vertices (4.2 M on Battery saver) |
| Light capture, at night | 0.87 s | 0.77 s at High, 0.51 s at Balanced |
| Sun shadow pass | 46 ms; 163 draws, 838 k vertices | 28 ms; 129 draws, 470 k vertices |
| Draw calls in a 3D frame | 193 | 126 |
| Room meshes | 132 | 68 (26 of them the stand-in scenery, hidden once the neighbourhood is in) |
| Neighbourhood | 6 meshes, 290 k triangles, none culled | 77 tiles, 200 k triangles at full detail, 113 k coarse, culled per camera |
| Shader programs, after load / after the whole session | 47 / 109 | 47 / 109 |
| GPU memory, phone resolution, day / night | 162 / 179 MB | 83 / 87 MB (Battery saver 71 / 76) |

The light capture now makes more draw calls (each cube face draws the tiles it sees) but a third
of the vertices; that is the trade the tiles make, and the time says it pays.

Interleaved runs (before, after, after, before, before, after; medians of three) confirm the phone
results: first frame 4.6 → 3.2 s, furniture ready 17.5 → 6.8 s, neighbourhood 18.8 → 8.3 s, first
light capture 22.5 → 10.8 s; orbiting 263 → 29 ms a frame, a 3D still 246 → 48 ms, Walk 835 →
220 ms, a light capture 1.77 → 0.48 s; GPU memory (WebGL allocations, canvas not included)
117 → 77 MB.

**Desktop** (1400 × 900, pixel ratio 1, High), interleaved runs, medians of three:

| Desktop | Before | After |
|---|---|---|
| First model requested | 2.8 s | 1.4 s |
| First frame | 2.8 s | 3.4 s |
| Furniture ready | 6.3 s | 5.6 s |
| Neighbourhood ready | 3.2 s | 4.2 s |
| First light capture | 10.7 s | 9.8 s |
| Transferred | 8.9 MB | 3.8 MB |
| Light capture | 0.84 s (1.04 s in the single run) | 0.75 s (0.66 s) |
| Sun shadow pass (single runs) | 51 ms | 36 ms |
| Walk, still, toward the window (single runs) | 1,983 ms | 910 ms |

- The neighbourhood is ready later because its data now arrive before the first frame, and the
  furniture's parsing, queued at the same moment, goes first; the first light capture, which needs
  both, comes sooner.
- At pixel ratio 1 the adaptive resolution has nothing to lower, and here this machine's noise
  (other agents' browsers and the virus scanner ran meanwhile) was larger than what's left: still
  3D frames of the same build varied from 232 to 604 ms between runs, so the desktop's frame times
  are not conclusive. A paired script (both builds in one browser, alternating tabs,
  `paired.mjs`) is written but wasn't run. The counts are unambiguous: 126 draw calls instead of
  193 in a 3D frame, a third of the vertices in a capture and a little over half in the shadow
  pass.

### What each quality setting costs

Measured on the phone profile, one setting changed at a time from High, each after the light had
settled and two warm-up frames (median of five). A 3D frame with everything at High takes about
110–190 ms here at pixel ratio 1.

| Setting | Values | Effect |
|---|---|---|
| **Antialiasing (MSAA)** | on → off | 3D frame at ratio 1: about 150 → **36 ms** (3–5×). In memory, 4× MSAA multiplies the canvas: 45 MB against 5 MB at ratio 2 on this phone. The biggest single lever. |
| **Pixel ratio** | 2 / 1.5 / 1 / 0.75 (no MSAA) | 108 / 45 / 36 / **18 ms**. With MSAA: 364 / 237 / 193 / 154 ms. Fill rate dominates. |
| **Sun shadow map** | 2048 → 1024 px | −24 MB of GPU memory; its shadow pass 42 → 20 ms. The frame itself barely changes. |
| **Lamp shadow map** (night) | 512 → 256 px a face | −12 MB; its shadow pass 41 → 18 ms; frame 54 → 41 ms. |
| **Texture filtering** | 16× / 4× / 1× | Walk frame 176 / 162 / 144 ms (the floor at a grazing angle); 275 / 222 / 147 ms with MSAA. |
| **Neighbourhood** | full → coarse terrain and trees | Walk toward the window 364 → 255 ms with MSAA, 207 → 197 without; capture and shadow pass unchanged (they only draw the tiles they see). |
| **Aerial photo** | 2048 → 1024 px | −16 MB (21 → 5 MB). It's seen from 3 m up and far off; the difference doesn't show from the flat. |
| **Parquet texture** | 400 → 280 px/m | −8 MB. |
| Soft shadows | PCF-soft → PCF | No difference (45 vs 46 ms), as in round 1. **Left out:** changing it recompiles every shader. |
| Light-capture size | 128 → 64 px a face | No difference in capture time (382 vs 375 ms; it isn't fill-bound), −3.5 MB. **Left out**, for the same reason. |

### The quality levels

`src/quality.js`; the panel is `src/ui/settings.js`.

| | Battery saver | Balanced | High |
|---|---|---|---|
| Pixel ratio, still (never more than the screen's) | 1 | 1.5 | 2 |
| … while the view moves | 0.75 | 1 | 1.5 |
| Antialiasing | off | off | on |
| Sun / lamp shadow maps | 1024 / 256 px | 1024 / 256 px | 2048 / 512 px |
| Texture filtering | 2× | 4× | 16× |
| Parquet | 280 px/m | 400 px/m | 400 px/m |
| Neighbourhood | coarser terrain (4–16 m grid) and trees, 1024 px photo | full, 1024 px photo | full, 2048 px photo |
| Second capture for white balance | no | yes | yes |
| A dragged piece's shadow | when it's put down | live | live |
| **GPU memory, phone** (by day / at night) | **71 / 76 MB** | **83 / 87 MB** | **162 / 179 MB** |

- **Auto** (the default) starts phones (a touch screen under 600 px on its short side) on
  Balanced, or Battery saver where the browser reports at most 4 GB of memory or 4 cores; tablets
  on Balanced; computers on High (Balanced with at most 4 GB or 4 cores). `deviceMemory` is
  Chromium-only and other browsers cap the core count, so the core count only counts alongside it,
  and unknown devices start optimistic.
- Once the room has loaded, Auto watches the frames while the view moves and steps down a level
  when the median of 24 is slower than 45 ms (about 22 a second), leaving out frames with a light
  capture or a shader compile in between. A step down is remembered for the next visit; choosing
  Auto again starts over.
- Everything changes live except antialiasing: a WebGL context can't switch it, so the panel says
  so and offers **Reload now**, which keeps the view, measurements and time of day
  (sessionStorage).
- The panel: a labelled non-modal `role="dialog"`, opened by a gear with an accessible name and
  `aria-expanded`; focus moves to the chosen level, arrow keys move between levels (native radios),
  Esc or × close it and focus goes back to the gear; a press outside closes it. 44 px targets on
  touch screens, both themes, and it places itself next to the gear wherever that sits. It also
  holds **Show measurements**, which replaced the toolbar button.

### Phones and GPU memory

Before this round every phone got what is now High: pixel ratio 2 with 4× MSAA, a 2048 px sun
shadow and the 2048 px aerial photo. That is about **162 MB of GPU memory by day and 179 MB at night**
at 390 × 844 (pixel ratio 3), of which the MSAA canvas alone is 45 MB, the sun's shadow map 32 MB
and the photo 21 MB. A phone browser can lose the WebGL context well below that when other tabs
and the system share the memory. Auto now gives phones Balanced (83 / 87 MB) or Battery saver
(71 / 76 MB).

Shader limits were ruled out early: every one of the app's 110 shader programs (every view, the
lamp, all presets, outlines, a light capture) is well inside the common mobile limits. (The crash
on the user's phone, a Pixel 10 Pro with a PowerVR GPU, was later traced to the GPU driver crashing
in draws that use shadow maps; a simplified mobile path without them follows separately. The
memory per level above still applies to every other phone.)

| | Highest in the app | Common mobile limit |
|---|---|---|
| Fragment uniform vectors | about 50 (83 for both stages together) | 256 (Adreno), 224 as a safe line |
| Varying vectors | 9 (the haworthia's soil: five map UVs, normal, view position, two shadow coordinates) | 15 |
| Fragment texture units | 10 (the same material: five maps, environment, two area-light tables, two shadow maps) | 16 |
| Texture size | 2048 px (aerial photo, sun shadow) | 4096 |

**Diagnostics** (`src/ui/diagnostics.js`) now make a phone's problems visible. A lost WebGL
context shows "The 3D view stopped", with Reload and Battery saver and reload; when the context
comes back the panel goes and the room is lit again. A shader that doesn't compile on the GPU, an
uncaught error and a failed furniture load show too. **Copy details** gives the GPU and its limits,
the screen and pixel ratio, the quality level, the browser and the errors, for a bug report.
The smoke test loses and restores the context to check this.

### What changed

**Loading**
1. **Downloads no longer wait for the first frame.** The first frame compiles the room's shaders,
   which held the main thread for 1.8 s on the phone profile. The catalog had arrived by then, but
   no model was requested until the frame was done (4.7 s after the start). Now:
   - `index.html` preloads the three small JSON files that name the other downloads
     (`products.json`, `presets.json`, `site.json`) and every module (`modulepreload`), so the module
     graph no longer takes one round trip per level of imports;
   - each piece's model is fetched alongside its options file instead of after it (O6);
   - the first frame waits (at most 0.5 s) until the furniture's and the neighbourhood's requests
     are out (`FIRST_FRAME_WAIT` in `main.js`).
2. **The parquet is drawn after the first frame**, one row of staves at a time (O10). Until then
   the floor shows the parquet's average colour through a 1 px stand-in, so the floor's shader is
   the same either way. Its size follows the quality level.
3. **Shaders compile in the background where the GPU can** (`KHR_parallel_shader_compile`, most
   GPUs in Chrome): the first frame's and the first light capture's (the capture's linear
   variants) go through `compileAsync`. SwiftShader doesn't have the extension, so this can't be
   measured here.
4. **The dev server compresses** (brotli or gzip, like any real host: the OBJ models shrink 5×,
   the neighbourhood's geometry 4×) and answers reloads with 304s (ETags). `COMPRESS=0` turns
   compression off.

**Frames**
5. **Adaptive resolution (O1).** While the view keeps moving (orbit, pan, walk, a drag, a door
   swinging), frames are drawn at the level's lower pixel ratio; 0.2 s after it stops, one frame at
   full ratio. A single changed frame (a view switch, a nudge) is drawn at full size at once.
   Changing the ratio resizes the drawing buffer twice per gesture, which is cheaper than drawing
   every moving frame at full size (the separate low-resolution target that round 1 suggested
   would have needed a second set of shaders: render targets use linear output).
6. **The render loop sleeps.** It used to wake every frame for nothing; it now stops after half a
   second without a change, and input or `invalidate()` starts it again. A phone left on the page
   no longer runs anything. It runs on its own `requestAnimationFrame` chain: three's
   `setAnimationLoop(null)` called from inside the loop doesn't stop it (three asks for the next
   frame after the callback returns), and starting it again then adds a second loop. The smoke
   test checks that an idle page asks for no frames after a few rounds of waking and sleeping.
7. **The neighbourhood is tiled (O2).** Terrain in 5 × 5 tiles, buildings and trees in 4 × 4, each
   with its own bounds, so three draws only what a camera sees: the sun's shadow camera the few
   tiles along its narrow box, each face of the light capture its quarter, Walk what's in front.
   The terrain is drawn more coarsely with distance from the flat (2 m up to 50 m, then 4 m, then
   8 m), with skirts so tiles of different steps don't show cracks: 124 k → about 35 k triangles.
   Walls and roofs are one mesh per tile (vertex colours). The trees keep their sizes and colours
   (the same random sequence).
8. **The window area lights are left out outdoors.** They face into the room, but every outdoor
   pixel (terrain, buildings, trees, the balcony) still evaluated both: `noAreaLights()` in
   `shader-hooks.js`.
9. **The room's boxes are merged (O9).** Its 132 meshes become 68, of which 26 are the stand-in
   scenery that hides once the neighbourhood is in: within each wall, door, sash, the ceiling,
   hallway and balcony, boxes of one material are one mesh. Moving parts keep their pivots, cut
   walls their clipped materials, fittings their outline and picking. A 3D frame takes 126 draw
   calls instead of 193.
10. **A new finish doesn't redraw the shadows (O5).** Furniture now says whether only its materials
    changed; then only the light is captured again. On Battery saver a dragged piece's shadow
    follows when it's put down.
11. **The curtains and the balcony's mesh panels draw in one pass** (O13): three draws transparent
    two-sided materials twice (back faces, then front), and compiles two shaders for them.
12. **Hover picking runs once per frame** (O4, in part): mice report 125–1000 moves a second, and
    each pick tests the piece's triangles.

**Memory**
13. Per level, as in the table above (O11): shadow maps, aerial photo, parquet, no MSAA on phones.
    Battery saver uses 56% less GPU memory than High at phone resolution.

### Bugs found

| # | Bug | Status |
|---|---|---|
| B15 | **Plan didn't redraw while you panned or zoomed.** OrbitControls apply a drag or wheel inside their own event handlers; the plan has no damping, so the render loop's `plan.update()` never saw a change, and the view jumped only at the next hover. | **Fixed:** the controls' `change` event redraws. |
| B16 | **`npm test` left about nine Edge processes behind on every run on Windows** (`taskkill /T` doesn't reach the re-parented renderer and GPU processes). About 200 had piled up and held the CPU at 97%. | **Fixed:** the smoke test stops every browser process whose command line names its own profile folder. |
| B17 | **All asset downloads waited for the first frame** (see Loading, 1). | **Fixed.** |
| B18 | A light capture whose read-back failed (the context lost meanwhile) was an unhandled rejection. | **Fixed.** |
| B19 | A lost WebGL context left a blank view without a word, and errors after the first frame were invisible on phones. | **Fixed:** diagnostics. |
| B20 | **In Walk, the arrow keys (and WASD, Q, E) are taken from whatever has focus:** `walk.js` listens on the window and calls `preventDefault()`, so the sun slider, the month and a swatch row can't be used from the keyboard in Walk. | **Open.** Ignore keys whose target is a form control or inside a panel. |

### Open

- **O3, furniture as glTF with meshopt** (data): converting the OBJ files with `gltfpack -cc`
  quantizes and compresses the geometry and skips the text parser. OBJ parsing is the largest
  main-thread cost after the first frame on the phone (the long tasks of 100–350 ms each). The
  size gain over brotli-compressed OBJ isn't measured here.
- **O4, a BVH for picking** (three-mesh-bvh): with picks once per frame, the slowest is the zebra
  haworthia (3 ms, 8 ms with the phone's CPU; its quantized geometry is decoded vertex by vertex).
- **O6, the pouf when it's not in the room:** still downloaded (682 KB, 140 KB compressed) for the
  presets that leave it out. Loading optional pieces on first use needs the furniture's layout code
  to cope with a piece without a model.
- **O7, white balance as a gain before tone mapping** instead of a second capture; Battery saver
  skips the second capture for now.
- **O8, metering from a small read-back.**
- **O12, finish textures are never freed.**
- **O13, the rest:** self-hosted fonts (assets aren't this round's to change), and the selection
  outline's hull precomputed.
- **The artifact host's compression:** the published page's download size depends on it; check
  that it serves `.obj`, `.bin` and `.js` compressed.

## Round 3: the Android crash, and a simple render path

**Symptom.** On a Pixel 10 Pro (Android 17, Chrome 155) the room appeared, then went blank within
1–14 s. Desktop browsers were fine.

**Device.**
- GPU: ANGLE on the Imagination PowerVR D-Series DXT-48-1536 driver (OpenGL ES 3.2, build 25.3).
- Chrome's own workarounds for this driver: virtualized GL contexts shared with the compositor
  (Skia on GL), because "Imagination drivers are buggy with context switching", and texture units
  capped at 13.

**Debugged on the phone itself** (USB, Chrome DevTools protocol, logcat), not in an emulator.
- **The crash is in the graphics driver.** Chrome's GPU process segfaults in
  `libGLESv2_powervr.so` (`LoadTextureState ← LoadConstants ← GLES3EmitState ←
  DrawArraysAutoIndices`). One run ended in a GPU reset instead.
- **The diagnostics panel's shader errors were fallout.** It showed shader compile errors with
  empty logs, but every program linked after the GPU process died fails that way.
- **Ruled out, one experiment each:**
  - texture units, uniforms and varyings (at most 9 samplers, 6 varying rows, 68 uniform
    vectors, against 13, 15 and 1024);
  - the light meter's pixel read-backs;
  - the canvas's alpha and stencil;
  - the panels' backdrop blur;
  - mipmap generation;
  - unindexed draws (all converted to indexed);
  - every WebGL call after the first frame (frozen).
- **Shadow maps are the trigger.**
  - three.js's own `webgl_shadowmap` example (latest three.js) crashes the phone the same way,
    so a three.js upgrade doesn't help. The plain environment and area-light examples run.
  - With shadow maps forced off (and nothing else changed) the planner ran 90 and 120 s, with
    40–46k draws, two light captures and all furniture, without a crash.

**What changed** (`src/quality.js`, `src/main.js`):
- **Battery saver and Balanced draw without shadow maps** (`shadows: false`); High keeps them.
  Auto gives phones and tablets one of the first two.
- **Shadow maps are never used on PowerVR or Imagination GPUs** (the WebGL renderer string), nor
  where a WebGL context was once lost with them on (remembered in localStorage
  `living-room.no-shadows`). After such a loss the room continues on the simple path once the
  context is back.
- **The simple path's sun** is calculated per pixel: `lighting/window-sun.js` is a shader hook on
  every lit material indoors that traces the ray toward the sun through the window panes, the
  wall opening, under the balcony above and past its parapet and screen. On High it stays compiled
  in and lets everything through, so switching levels doesn't change the shader code beyond the
  shadow-map defines. The neighbourhood dims each pane by the share of 5 rays per pane toward the
  sun that miss its buildings and trees, cast on the CPU 150 ms after the sun stops moving.
- **Contact shadows:** soft dark footprints under each floor-standing piece, one 64 px gradient
  texture shared (`scene/contact-shadows.js`).

**Verified on the phone:** the unmodified app detects the GPU, draws the simple path, and ran
2 minutes (about 103k draws, two light captures) without a crash.

- **The balcony** gets the same calculation without the panes: its floor and the facade are shaded
  by the balcony above, the parapet and the screen. On High the hook adds only the balcony
  above's shade, the one shadow the maps can't have (it's hidden outside Walk), so the top of the
  window is shaded on both paths. The parapet and the screen cast shadows on High.

**Open:** beyond the balcony, the simple path's sun has no shadows at all, so the trees seen from
Walk come out very bright.

