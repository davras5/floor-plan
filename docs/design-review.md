# Design review: accessibility, user flow, responsive design

Reviewed 26 October 2026, against WCAG 2.2 AA (and AAA target size where it's cheap).

**How:** I ran axe-core 4.10 in four states (view mode, Edit with a piece selected, info card
open, dark theme). I walked the page with the keyboard and dumped the browser's accessibility
tree. I measured layout and touch targets at seven viewports, using headless Edge with touch
emulation:

- 320 × 568 and 390 × 844 (phones, portrait)
- 844 × 390 (phone, landscape)
- 768 × 1024 and 1024 × 768 (tablet, both orientations)
- 640 × 400 (a 1280 laptop at 200% zoom)
- 1440 × 900 (desktop)

The audit script is `scratchpad/design/audit.mjs`; `npm test` covers the main flows.

## Results at a glance

| | Before | After |
|---|---|---|
| axe violations | 1 rule (landmarks) in all 4 states | **0** in all 4 states |
| 3D view by keyboard | not reachable | focusable; arrows orbit or pan, +/− zoom, Home resets |
| Furniture without a pointer | not possible | a "room in words" list; each piece opens its info card |
| Free height for the model: phone 320 × 568 | 188 px | **361 px** |
| Free height: phone 390 × 844 | 513 px | **655 px** |
| Free height: phone landscape 844 × 390 | 104 px | **232 px** |
| Free height: 200% zoom (640 × 400) | 67 px | **255 px** |
| Toolbar rows on a phone | 3 | **1** |
| Touch targets (toolbar, card, editor) | 30–31 px | **≥ 44 px** on touch screens |
| 3D labels over the UI | yes (three.js z-indexes) | no (explicit layers) |

## Accessibility

| # | Finding | WCAG | Status |
|---|---|---|---|
| A1 | The 3D view couldn't take focus, and there was no keyboard way to orbit, pan or zoom. | 2.1.1 Keyboard | **Fixed.** The canvas is in the tab order as `role="application"`, and its label explains the keys for the current view. Orbit: arrows orbit, Shift+arrows pan, +/− zoom, Home resets. Plan: arrows pan. Walk keeps WASD/Q/E. |
| A2 | The scene had no text alternative: a screen-reader user learned nothing about the room or its furniture. | 1.1.1 Non-text content | **Fixed.** "The room in words" gives the size, the openings and every piece with its distances to the four walls. Each piece is a button that opens its info card. It stays current as things move. |
| A3 | Screen readers read the 3D dimension labels as loose numbers ("0.55 1.45 WINDOW…"). | 1.3.1 Info and relationships | **Fixed.** The labels are `aria-hidden`; A2 gives the same information in sentences. |
| A4 | No landmarks: the canvas, readout and toolbars sat outside any region. | 1.3.1, best practice | **Fixed.** `<header>` (room card), `<main>` (3D view), and a labelled "Controls" region. |
| A5 | Views were toggle buttons (`aria-pressed`), so "3D, toggle button, pressed" didn't say it's one of three. | 4.1.2 Name, role, value | **Fixed.** A radio group: the selected view is the single tab stop and arrow keys move the choice. The "press again to reset" tip is in `aria-describedby`; before, it was only a hover title. |
| A6 | The sun slider was announced as "13.25", and its target was 16 px tall. | 4.1.2; 2.5.8 Target size | **Fixed.** `aria-valuetext` says "13:15", or "18:30, after sunset". The track is 24 px, 44 px on touch. |
| A7 | Touch targets were 30–31 px (toolbar), 26 px (info card ×) and 30 px (swatches). | 2.5.8 AA passes at 24 px; 2.5.5 AAA needs 44 px | **Fixed** on touch (`pointer: coarse`): 44 px controls and 40 px swatches. A mouse keeps the compact sizes. |
| A8 | On iOS, selects with 12 px text zoom the page when tapped. | (usability) | **Fixed:** form controls use 16 px text on touch screens. |
| A9 | Results that only showed in the 3D view weren't announced: a view change, a nudged piece, a new finish, a preset applied. | 4.1.3 Status messages | **Fixed.** A polite live region (`roomApp.announce`) is used by views, nudges, finishes, presets, adding and removing pieces, and Undo. |
| A10 | The info card was `role="dialog"` but didn't manage focus. | 2.4.3 Focus order | **Fixed** (furniture agent): it's a non-modal dialog. Opened from a control, it focuses its title; Esc or × returns focus to that control. |
| A11 | Loading and error messages weren't announced. | 4.1.3 | **Fixed.** The loading box is `role="status"`, and the furniture load error is announced. |
| A12 | Gliding motion with `prefers-reduced-motion` on: walking to a tapped point, focusing a spot. | 2.3.3 Animation from interactions (AAA) | **Fixed:** with reduced motion, tap-to-walk jumps and focus is instant. Door swings and exposure easing already respected it. |
| A13 | The on/off states of the switches and the selected view used colour only. | 1.4.1 Use of colour | **Fixed.** Switches show a check mark. Under `forced-colors` (Windows high contrast), selected and on states get an outline. |
| A14 | Focus visibility | 2.4.7 | Every control had a visible 2 px outline. The new canvas focus ring is a 3 px inset accent outline. |
| A15 | Contrast | 1.4.3 | It passes: soft text #5a6470 on the panel is about 5.6:1 in light mode; #9ba5b0 on the dark panel is about 6.5:1. Small caps labels (8.5–10 px) are legible but small; see R6. |

## User flow

| # | Finding | Status |
|---|---|---|
| U1 | The card said "edit `src/config.js` once you've measured": developer instructions in the UI of something people share. | **Fixed.** It now explains the app ("Tap a piece to see what it is. Turn on Edit to move it or change its finish."). Developer notes stay in the README. |
| U2 | Every pressed control was filled yellow: the active view, Edit, and Measurements and Furniture (on by default). Three yellow pills at once, so you couldn't tell which view you were in. | **Fixed.** One look per kind of control: the chosen view and Edit are filled; the scene switches show a check and a light tint. |
| U3 | On a phone in Edit, the room card plus the edit panel left a sliver of the piece being edited. | **Fixed.** The card folds away while editing on small screens. The edit panel (furniture agent) is a bottom sheet of at most 40% height with its own scroll; Finish starts collapsed. |
| U4 | The walk hint said "WASD" on phones. | **Fixed:** touch screens get "Drag to look around · Tap the floor to walk there". |
| U5 | "Press the view again to reset" and "double-click to focus" were only hover titles, so touch users never see them. | **Partly fixed:** the reset tip is now in the accessible description. **Open:** a visible reset control. A small ⟲ button next to the views would make it discoverable. |
| U6 | Nothing for first-time visitors: the key features (Edit, Looks, finishes, Walk) are found by trial. | **Open.** I recommend a dismissible three-step tip strip on first visit ("Tap a piece", "Try Walk", "Edit → Look"), remembered per browser. |
| U7 | The sun slider lives in the room card, while Evening lives in the toolbar. Both are about light. | **Open (low).** Merge them into one "Light" control: the time slider plus a lamp switch, with evening as a point on the time scale rather than a separate mode. |
| U8 | You can't share a particular state, such as a view, time or look. | **Partly fixed:** the preset is in the link (`#preset=wood-white`, `#preset=none`), and a link opens the room that way, keeping the viewer's own room under Custom. **Open:** the view and the time. |
| U9 | Loading was only visible at boot ("Building the room…" over the empty view). Later loads gave no sign: the furniture (12 MB) streaming in after the room appeared, the neighbourhood, a new look or model, an Outline fabric texture, the light capture. A tap on a look seemed to do nothing for a second or two. | **Fixed** ([src/ui/loading.js](../src/ui/loading.js)). One global indicator for everything: a slim accent bar along the top edge of the screen, plus a labelled pill with a spinner in the status row ("Loading furniture · 3 of 7…", "Applying Wood & white…", "Loading the finish…", "Lighting the room…"). three.js's loading manager feeds it every model and texture automatically; other work registers with `track(label, promise)`. It appears only after 250 ms, so quick swatch changes don't flash it, and it's announced (`role="status"`, `aria-busy` on the 3D view). The bar fills by finished files when the count is known and sweeps otherwise. With reduced motion the spinner and sweep stop and the bar just fades. |
| U10 | The toolbar mixed views, a mode and four scene switches (Evening, Doors open, Measurements, Furniture), two of them behind More on phones. Light and doors are things in the room, not view settings. | **Fixed.** The room's fittings are tappable like furniture, and their cards act on them: the ceiling light (*Turn on* / *off*, *Automatic*: it comes on after sunset by itself), the doors and the window (*Open* / *Close*), the curtains (*Close* / *Open*). The empty room is the **None** preset. The toolbar is the views, Edit and Measurements, one row at 360 px, so More is gone. |
| U11 | The selection outline drew every part's edge (the table's top over its stem, the sofa's cushions). | **Fixed.** One line around the whole silhouette: the piece marks its pixels in the stencil buffer and the outline is drawn only outside them. Fittings get the same outline. |

## Responsive design

| # | Finding | Status |
|---|---|---|
| R1 | The room card took 190–210 px at every size, which was half the screen on a landscape phone. | **Fixed.** It folds to its title line. That's the default on phones and short screens, and it follows the screen when the phone turns, until the viewer picks a state themselves. |
| R2 | The toolbar wrapped to three rows on phones, plus a status line. | **Fixed.** First with a **More** popover for the scene switches; since U10 there's only Measurements left and the toolbar is one row without it. The idle "how to measure" line hides on short screens. |
| R3 | 200% zoom (640 × 400): the editor overlapped the room card, and the info card's × floated on top of it (1.4.10 Reflow). | **Fixed.** The editor is capped by the actual free space, and the info card moves beside or below the room card. |
| R4 | 3D labels painted over the card and toolbar. three.js gives each label a z-index from its distance, up to millions, and the page had no explicit layers. | **Fixed.** Explicit layers: the 3D view (`isolation: isolate`, z 0), loading (5), card and dock (10), the "room in words" panel (30). Labels can't leave the 3D layer. Verified with `elementsFromPoint` over the dock. |
| R5 | Horizontal scrolling | Never, at any of the seven viewports. |
| R6 | Small type: 8.5 px uppercase labels on the floor ("CEILING LIGHT", "ENTRY DOOR") and 10 px group labels. | **Open (low).** Raise to ≥ 10 px, and 11 px on phones. They're decorative and duplicated in A2, so it's legibility rather than access. |

## Content

- The measurement labels give metres without a unit; only totals say "m". It's the convention
  on plans, but a short "all sizes in metres" in the card would help non-architects. **Open.**
- The "Furniture" and "Measurements" switches are named for what they show; with the check
  mark that now reads clearly.

## What changed, by file

- **index.html**:
  - landmarks, radio-group views, the collapsible card, the More popover
  - "the room in words", the live region, touch and keyboard hints
  - layer z-indexes, touch sizing and 16 px form text, forced-colors outlines
- **src/ui/accessibility.js** (split out of main.js):
  - views as a radio group with arrow keys; keyboard navigation of the 3D view and its label
  - card folding with the resize-follow logic, the More menu
  - the room-in-words list, which updates in place so focus survives
  - `announce()`
- **src/main.js:** slider value text, reduced-motion walking.
- **src/ui/loading.js:** the global loading bar and status (U9).
- **src/scene/annotations.js:** 3D labels are `aria-hidden`.
- **src/controls/walk.js:** `instant` mode (reduced motion).
- **Furniture agent's areas:** editor bottom sheet, info card focus management, swatch and button
  touch sizes, clearance labels hidden from screen readers, announcements.
