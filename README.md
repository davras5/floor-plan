# Floor plan

An interactive three.js model of a living room, built from photos, for trying out furniture:
real Muuto products in every finish Muuto sells, the real sun, and the real neighbourhood
outside the window (swisstopo).

## Demo

**[davras5.github.io/floor-plan](https://davras5.github.io/floor-plan/)**

A preset can be linked directly, e.g. [`#preset=wood-white`](https://davras5.github.io/floor-plan/#preset=wood-white).

## Use

- **3D, Plan, Walk:** orbit the room, see it as a floor plan, or walk through it at eye height
  (mouse and WASD like a PC game; two thumbs on a phone).
- **Presets** (top right): whole-room looks and layouts in one tap, each with its layout-check
  score; **None** for the empty room.
- **Layout check** (the card top left): the room scored against the layout review's rules
  (a commanding seat, clear doors and lane, head room, dining clearances, a yoga practice zone
  and a free wall). Open the card for the reasons; the zone is drawn on the floor meanwhile.
- **Tap a piece** for what it is, its price and a link to that configuration at muuto.com. Tap the
  light, a door, the window or the curtains to switch or open them.
- **Edit:** move and turn furniture, and change any finish.
- **Sun** (in the toolbar): day or evening in one tap; the chevron next to it opens the time of
  day and the month. The ceiling light comes on by itself after sunset.
- **Settings** (the gear): show measurements, and the rendering quality: Auto picks one for
  the device; Battery saver for older phones, High for desktops.

## Run locally

```sh
npm start        # http://localhost:5173 (any static server works; not from file://)
npm test         # catalog check + headless browser smoke test
```

## Project

- `src/`: the app (plain ES modules, three.js from a CDN, no build step).
- `assets/catalog/`: every product and the presets, as data ([docs/catalog.md](docs/catalog.md)).
- `assets/`: models, finishes, plants, the processed neighbourhood.
- `docs/`: the full [guide](docs/guide.md) and the design, code, performance, layout and presets reviews.

## Licence

The code is MIT ([LICENSE](LICENSE)). The furniture models, textures and product data belong to
Muuto, and the neighbourhood data to swisstopo; see [THIRD_PARTY.md](THIRD_PARTY.md).
