# Performance review

A second review, focused on performance. It follows [code-review.md](code-review.md), whose items
P1–P10 it builds on.

**How it was measured.** Headless Edge with software rendering (SwiftShader), driven over the
DevTools protocol. The harness counted:
- WebGL draws, vertices, shader program links and time spent waiting for compiles;
- live GPU memory;
- long-frame attribution, CPU profiles and network timings.

There were two profiles: desktop at 1400 × 900, and a phone at 390 × 844, pixel ratio 2, with 4×
CPU and 10 Mbit/s throttling. **Milliseconds are software-rendering numbers: compare them with
each other, not with a real GPU.** Counts (programs, captures, draws, bytes) carry over as they are.

## Results

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

## Fixed

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

## Open

Ordered by expected payoff.

| # | What | Where | Notes |
|---|---|---|---|
| O1 | **Adaptive resolution.** Frame time is set by fill rate: a pixel ratio of 2 costs 3× a ratio of 1. | main.js | Render at about 1–1.25 while orbiting, walking or dragging, and at full resolution once still. On-demand rendering makes that cheap, but it needs a separate low-resolution target, because resizing the canvas each time is expensive. High payoff on phones. |
| O2 | **Neighbourhood geometry.** Nothing of it can be culled (one mesh per kind, bounding spheres of 350–450 m). The 124k-triangle terrain alone is 29% of a Walk frame. | surroundings.py / .js | Cut into roughly 50 m tiles so frustum culling works; decimate the terrain with distance; build a separate, smaller caster set for the sun; use a cheaper material outdoors (both window area lights are evaluated on every outdoor pixel today). |
| O3 | **Furniture as glTF with meshopt.** The startup models are 4.9 MB raw and unindexed (3–5× vertex reuse is possible), with 13 meshes per chair. | furniture | `gltfpack -cc`, merged meshes per part, the selection outline precomputed. About 10× smaller (an estimate), and 3–5× fewer vertices in every pass. |
| O4 | **Picking.** 14 ms per pick on the In Situ sofa, run on every mouse move. | furniture.js | Use three-mesh-bvh on the shared template geometry: under 0.1 ms. |
| O5 | **Furniture changes re-render shadows.** Choosing a finish or swatch only changes colour, but runs the shadow pass. Every drag frame re-renders it too: 20% of a day frame, 40% in the evening. | furniture.js | Split `onChange` into "light changed" and "shadows changed". |
| O6 | **Downloads wait for the options files.** The model downloads start only after their options JSON has arrived. The pouf (681 KB) is downloaded even when it's not in the room. | furniture.js | Start the model fetches alongside the options; load optional pieces on first use. |
| O7 | **The white-balance re-capture doubles the captures.** | lighting.js | Apply white balance as a per-channel gain before tone mapping, instead of re-colouring every light and capturing again. |
| O8 | **The light meter reads 786 KB to use 1/37 of it.** In software rendering the "async" read-back still blocked for 0.9–1.9 s; not confirmed on real GPUs. | indirect.js | Meter from a small downsample (about 1.5 KB). Spread a capture's faces over several frames so input stays responsive on phones. |
| O9 | **About 130 tiny room meshes.** 173 draws per frame and about 1,050 per capture. | room.js | Merge the boxes per material inside each wall group (doors and sashes stay separate): about 60 draws per frame. |
| O10 | **The parquet texture is generated before the first frame.** 150 ms on desktop, probably 0.5–0.8 s on phones, and 15.6 MB of GPU memory. | textures.js | It comes from a fixed seed, so bake it at build time (KTX2 or WebP), or generate it in a worker after the first frame. |
| O11 | **GPU memory on phones.** About 85 MB of textures after load. | | Aerial photo to 1024² (−16 MB), and the sun's shadow map at 1024 on phones (−24 MB; texels go from 4.5 to 9 mm, which the soft shadows hide). |
| O12 | **Finish textures are never freed.** Browsing all 27 upholstery families added 33 MB. Each swatch change re-uploads the shared image. | furniture.js | Cache textures by image and tiling, and evict families that haven't been used recently. |
| O13 | **Smaller items.** | | Precompute the selection outline hull (50–85 ms on first select). Draw the curtains and balcony panels in one pass instead of two. Stop the animation loop when idle (it wakes every frame). Self-host the fonts and add `modulepreload` hints. Cache static files with hashed names. |

## Checked and fine

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

The measurement scripts and raw results live in the session's scratch folder: `perf-review/`
(the review) and `perf-mine/` (the before/after runs).
