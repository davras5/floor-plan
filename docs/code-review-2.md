# Code review 2: bugs, performance, robustness

Reviewed 26 October 2026, against three.js r170, after the layout check, the Sun switch and the
pendant swag went in. The first review is [code-review.md](code-review.md), the performance
work [performance-review.md](performance-review.md); their open items are picked up below where
they still apply.

**How.** Every module was read again with three questions: what breaks, what costs more than it
should per frame or per interaction, and what happens when something fails (a file missing, the
GPU gone, a thrown error). Findings were checked by reading the three.js r170 source where the
engine's behaviour mattered (texture sharing, raycasting, shadow passes), and by `npm test`
after the fixes. Everything below is fixed unless marked **open**.

## Bugs

| # | Finding | Where | Status |
|---|---|---|---|
| B21 | **One error stopped the render loop for good.** `tick()` called `loop()` and then asked for the next frame; an exception in `loop()` (a shader the GPU rejects, a bug in a new feature) threw out of the callback, so no next frame was requested, while `looping` stayed `true`, so `wake()` on the next input did nothing either. The view froze with only the generic error panel. | main.js `tick` | **Fixed.** The loop runs in a try/catch: on an error it stops cleanly (`looping = false`), the diagnostics panel says so, and the next tap or key starts it again. |
| B22 | **A blank frame between a shadow pass and a capture.** `renderShadows()` renders the scene with a camera that sees nothing, which also cleared the canvas. In the frame loop the real render followed at once, but `capture()` (on a timer, after a drag on Battery saver) could run the pass with nothing drawn after it until the next frame: a flash. | main.js `renderShadows` | **Fixed.** `autoClear` is off for the pass. |
| B23 | **The pendant's swag outlived the layout it belonged to.** It was saved under its own key, so when the default layout changed (and the saved places were dropped for it) the hook stayed, over nothing. | furniture.js | **Fixed.** The hang is saved with the places, under the layout's signature. |
| B24 | **A failed load inside an edit was an unhandled rejection.** A finish, a model, undo, "Apply to all" or "Match the sofa" that couldn't load (offline, a missing file) threw to the diagnostics panel as "Something went wrong" and left the edit panel stale. | editor.js | **Fixed.** Each such action catches, redraws the panel from what the room has, and announces what didn't work. |
| B25 | **The loading bar hid on the first failed file** while the others were still loading: `onError` was treated like `onLoad`. | loading.js | **Fixed.** `onLoad` comes when all are done, errors included. |
| B26 | **A model that left a piece kept its materials.** Switching the sofa's model (or a size, or castors) dropped the old object but not the copy's own fallback materials. Small, but it grew with every switch. | furniture.js `loadInto` | **Fixed.** A copy's own materials are disposed with it; the finishes, shared by every copy, stay. |
| B27 | **A thrown layout check would have taken the panel with it.** The check is new code over user-made layouts. | main.js, editor.js | **Fixed.** Caught and logged; the card and the scores just don't update. |
| B29 | **A frame between a lost context and the event that reports it threw inside three.** `loseContext` takes effect at once, but three only learns of it from the `webglcontextlost` event, a task later; a frame drawn in between compiled its programs against a dead context and threw on a null shader log (`getProgramInfoLog(...).trim()`). Before B21 that killed the loop silently; the smoke test's lose-and-restore step found it once the loop reported errors. | main.js `loop` | **Fixed.** No frame is drawn while `gl.isContextLost()`; an error thrown while the context is lost is logged as a consequence, not reported as a bug (the context panel says it all), and the restore redraws. |
| B28 | **Open.** `hover()` runs `pickAny()` in Walk as well, on every mouse move, for a pointer cursor nobody looks at while walking. Harmless with fast picking (P12), a few milliseconds a frame without it. | main.js | Open: skip hover picking in Walk unless Edit is on. |

## Performance

| # | Finding | Where | Status |
|---|---|---|---|
| P11 | **A drag placed the piece once per mouse event.** Mice report 125–1000 moves a second; each `place()` told the whole app (materials patched, contact shadows synced, piece lights re-applied, shadows flagged, the check re-timed). At 1000 Hz that was a tenth of the main thread. | editor.js, main.js, furniture.js | **Fixed.** Moves are applied once per frame, from the latest event (the last one on release), and a move says it's a move: `onChange('move')` skips the material patching, contact-shadow sync and light sync, which all hang from the piece's pivot and come along anyway. |
| P12 | **Picking a dense model cost milliseconds a ray** (the In Situ: 14 ms in the first review; three's `Mesh.raycast` tests every triangle), and hovering picks every frame. Open since the first review (O4). | furniture.js | **Fixed** with [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) 0.9.16 from the CDN, loaded once the furniture is in so it doesn't compete with the models, resolving `three` through the import map to the one copy on the page. Each OBJ model's bounds tree is built in idle time after it loads; `raycaster.firstHitOnly` stops at the nearest hit. If the library can't load, picking works as before. (The plants' quantized GLB geometry keeps three's raycast: it isn't float, and it's the cheapest model anyway.) |
| P13 | **The first selection of a piece paused for its outline.** The silhouette hull (a weld of every mesh's vertices) took up to 85 ms for a sofa, on the first click. Open since the first review (O13). | furniture.js | **Fixed.** Hulls are made in idle time once a model has loaded, one mesh at a time, alongside the bounds trees. |
| P14 | **Finish materials and their textures were never freed.** Browsing the upholstery families added about 33 MB of textures that stayed for the session. Open since the first review (O12). | furniture.js | **Fixed.** Materials no piece shows are let go of beyond the 24 most recently used (switching back is still instant); a texture's GPU copy goes when its last material does, which three refcounts per source. |
| P15 | **Open.** The light meter reads 786 KB back from the GPU to use 1/37 of it (O8). On a real GPU the asynchronous read is cheap; it wasn't measured here. | indirect.js | Open: meter from a 16 px downsample. |
| P16 | **Open.** `renderEditor()` rebuilds the pieces' buttons and runs `currentPreset()` on every call, and it's called on every selection, fixture change and sun change that switches a light. Cheap (about a millisecond), but it's the kind of thing that grows. | editor.js | Open: rebuild the buttons only when the pieces change. |
| P17 | **Open.** The CSS2D label renderer walks the whole scene (about 300 objects) on every drawn frame to find its few labels. | main.js | Open: give the labels their own small scene. |

## Robustness

| # | Finding | Where | Status |
|---|---|---|---|
| R1 | The render loop survives an error (B21). | main.js | Fixed. |
| R2 | Edits survive a failed load (B24). | editor.js | Fixed. |
| R3 | The layout check can't take the panel down (B27). | main.js, editor.js | Fixed. |
| R4 | Fast picking is optional: without the library, or if a bounds tree can't be built for a geometry, picking stays as it was. | furniture.js | Fixed, by design. |
| R5 | **Open.** The furniture's option files and models come from the same origin, three.js and three-mesh-bvh from jsDelivr with pinned versions. There are no `integrity` hashes on the module preloads: a CDN that served something else would be run. | index.html | Open: add `integrity` to the three.js and three-mesh-bvh preloads (and the import map's entries can't carry one, so the preloads are the check). |
| R6 | **Open.** `applyPreset` is a sequence of awaits; a model that fails halfway leaves the room half-applied (the catch in `pickPreset` logs it). | furniture.js | Open: snapshot before, restore on failure. |
| R7 | Checked and fine: `localStorage` is guarded everywhere and ignored when the layout's signature changes; a lost WebGL context is handled and shadow maps are remembered as unsafe; a missing options file leaves the default finish; a piece whose model can't load is left out and the rest loads; the loop sleeps when idle; `requestIdleCallback` has a fallback; no listener is added per frame; no vector is allocated per frame in the loop, walk or drag. | | |

## What changed, by file

- `src/main.js`: the loop's try/catch and its pause while the context is lost; `onChange('move')` fast path; `autoClear` off in the shadow pass; `firstHitOnly` on the picking raycaster; the layout check caught.
- `src/furniture/editor.js`: drag moves once per frame; `failed()` for every loading edit; a preset's check caught.
- `src/furniture/furniture.js`: `place()` says 'move'; the hang saved with the layout; own materials disposed on a model change; `pruneMaterials()`; `prepareTemplate()` (hulls and bounds trees in idle time); `enableFastPicking()`.
- `scripts/smoke.mjs`: waits for the picking bounds trees, so a broken library load fails the test.
- `src/ui/loading.js`: `onError` no longer ends the batch.
- `index.html`: `three-mesh-bvh` in the import map.
- `THIRD_PARTY.md`, `docs/guide.md`: the library.
