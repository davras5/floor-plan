# The catalog: products and presets

Everything the planner can put in the room, and the ready-made looks, are data in
[assets/catalog/](../assets/catalog/):

| File | What it holds | Schema |
|---|---|---|
| `products.json` | Every product, described the same way: what it is, its 3D model, its parts, and where its options are. | `products.schema.json` |
| `presets.json` | The room's pieces (each a slot one product stands in, and how it's placed), and the presets: for each piece, its product, finish, and place and rotation. | `presets.schema.json` |
| `assets/furniture/<product>/options.json` | Every configuration the maker sells for one product: groups, options, codes, names and prices. | the comment above `loadOptions` in `src/furniture/furniture.js` |

Both JSON files name their schema (`"$schema"`), so VS Code checks them as you type.
`npm test` runs `scripts/check-catalog.mjs` before the browser test. It checks:
- that every file exists;
- that every reference resolves;
- that every option group's default is an option it sells;
- that every choice a preset makes is an option of that product that's actually sold
  (`offered` isn't `false`).

The option lists are kept per product, because they are long: up to 1,005 upholstery colours.

## Units and directions

- Metres. `x` runs from the left wall, `z` from the window wall, and `y` is up.
- Rotation is in degrees: 0 means back toward the window wall, 90 back against the left wall,
  180 back toward the door wall, 270 back against the right wall.

## products.json

```json
{
  "$schema": "./products.schema.json",
  "partSets": { "outline": [ … ], "soft-side": [ … ] },
  "products": {
    "muuto-soft-side-table": {
      "maker": "Muuto",
      "name": "Soft Side Table",
      "category": "side-table",
      "url": "https://www.muuto.com/product/Soft-Side-Table/",
      "itemUrl": "https://www.muuto.com/product/Soft-Side-Table--SOSIT{size}/{item}/",
      "size": {"width": 0.48, "depth": 0.48, "height": 0.4},
      "finish": "Solid Oak top, grey base",
      "options": "assets/furniture/muuto-soft-side-table/options.json",
      "model": {
        "file": "assets/furniture/muuto-soft-side-table/d48-h40.obj",
        "scale": 0.001,
        "parts": "soft-side",
        "variants": { "d41-h40": {"file": "…/d41-h40.obj"}, … }
      }
    }
  }
}
```

| Field | | Meaning |
|---|---|---|
| key | required | The product id, `maker-product-variant`: lower case, used by pieces and presets. |
| `maker`, `name` | required | As the maker sells it, with the size where there are several. |
| `category` | required | `sofa`, `pouf`, `dining-table`, `chair`, `side-table`, `plant`, `lamp` or `art` (a framed print). Plants and art aren't counted among a preset's makers. |
| `url` | `url` or `source` | The product's page. The info card's product name links there. |
| `itemUrl` | optional | The page of one configuration. `{item}` becomes the configured item number (built from the options file's `item` pattern), and `{<group>}` that group's code. The card's **Shop** link goes there. |
| `size` | required | The maker's listed W × D × H. The room uses the model's own box, which can differ by a few centimetres. |
| `footprint` | optional | What stands on the floor, when smaller than the whole model (a plant's pot under its crown). It's used for walls and collisions, and the model's origin is its centre. |
| `finish` | optional | The default finish in words, shown until the options load. |
| `options` | optional | Path of the product's options file. Without one, the finish is fixed. |
| `source` | optional | `{ url?, name?, author?, licence }`, for a model that isn't the maker's (the plants), or a print's artwork (shown as **Image** on the card). `name` is the link's text (e.g. Wikimedia Commons), the maker if left out. |
| `model` | required | `file` (`.obj` or `.glb`), `scale` (model units to metres), `parts` (or the name of a `partSets` list), and `variants`: other models of the product that an option switches to (`model` on an option), such as the Outline on castors or another size. |

A part is `{ id, match, material, uvPerM?, planarUV?, boxUV?, rotate? }`:
- `match` is a regular expression for the model's group names.
- `id` is what option groups colour.
- `material` is the fallback until options load: `{ color, roughness }`, or `{ texture, tile }`, or
  `{ fabric, tileMm }`.
- `uvPerM` says how many texture units make a metre, so wood and fabric come out at their real scale.

GLB models without parts keep their own materials (the plants).

## presets.json

```json
{
  "$schema": "./presets.schema.json",
  "default": "wood-white",
  "palette": [["sofa", "upholstery"], ["muuto-fiber-side-chair-wood", "shell"], …],
  "pieces": [
    { "id": "sofa", "label": "Sofa", "product": "muuto-in-situ-2-seater-7",
      "alternatives": ["muuto-in-situ-2-seater-7", "muuto-outline-soft-2-seater", "muuto-outline-soft-3-seater"],
      "place": {"left": 0.02, "window": 0.15, "rotation": 90} },
    { "id": "pouf", "label": "Pouf", "product": "muuto-outline-pouf", "present": false, "optional": true, "match": "sofa",
      "attach": {"to": "sofa", "front": 0.25, "past": 0.15, "hostWindow": 0.45, "rotation": 0} },
    { "id": "chair-1", "label": "Chair 1", "product": "muuto-fiber-side-chair-wood",
      "around": {"to": "table", "dx": -0.49, "dz": -0.28, "rotation": 90} },
    { "id": "sill-rubber-plant", "label": "Rubber plant", "product": "made-rubber-plant", "optional": true,
      "movable": false, "place": {"x": 1.55, "z": -0.085, "y": 0.84, "rotation": 0} },
    …
  ],
  "presets": [
    { "id": "wood-white", "name": "Wood & white", "summary": "Outline + pouf · Steelcut 220", "note": "…",
      "pieces": {
        "sofa": { "product": "muuto-outline-soft-2-seater", "choices": {"upholstery": "SA08", "base": "aluminium"},
                  "place": {"left": 0.02, "window": 0.45, "rotation": 90} },
        "pouf": { "present": true, "place": {"left": 1.147, "window": 0.3, "rotation": 0} },
        "muuto-fiber-side-chair-wood": { "choices": {"shell": "04", "base": "04", "glides": "1"} },
        …
      } }
  ]
}
```

### Pieces

A piece is a slot in the room: what stands there to begin with, what it may be switched to, and
how it's placed when nothing else says where.

- **`place`** sets the clear distances from the piece's footprint to the walls: one of `left`,
  `right` or `x` (the centre), and one of `window`, `door` or `z`. Distances to walls keep a piece
  where it belongs when the room's measurements or the piece's model change. For example, the
  dining table is 20 cm from the door wall in any room length. `y` stands it on something
  (the windowsill), or for a picture, is the height of its frame's bottom edge. A picture
  (`category: "art"`) is turned to face into the room and placed 0–5 cm from the wall behind it
  (`left: 0.002` with rotation 90, `door: 0.002` with 180), so it goes with that wall when the 3D
  view cuts it away; the check makes sure of both.
- **`attach`** places it by another piece. By default it goes in front of that piece's window end
  (the pouf):
  - `front`: the gap from that piece's front;
  - `past`: how far it reaches beyond that piece's end;
  - `hostWindow`: while it's in the room, the other piece moves this far from the window wall to
    make room.

  With `end: "door"` it goes in front of the seat at the other end (the coffee table):
  - `seat`: centred this far from that end;
  - `front`: off the seat, as measured on the model;
  - `clear`: at least this far past that piece's footprint.
- **`around`** sets an offset from another piece's centre (the chairs around the table), so the
  set moves together.
- **`present`**, **`optional`** (can be added and removed in Edit), **`match`** (follows another
  piece's finish until given its own), and **`movable: false`** (stays put in Edit and isn't kept
  inside the walls: the windowsill plant, the pictures).

A piece placed relative to another comes after it in the list.

### Presets

A preset names pieces by piece id, or by product id for every piece of that product (the four
chairs share one finish). For each it may set:
- `product`: one of the piece's alternatives;
- `present`;
- `choices`: option group to option id. Groups left out take the product's default. A matching
  piece without choices follows the piece it matches.
- `place`: where it stands, in the same form as a piece's `place`.

Pieces a preset doesn't name keep what they have. Applying a preset is one undo step.

`default` is the preset a first visit starts with. `palette` lists the colours each preset is
shown with in the panel.

A preset's id is also its link: `…#preset=wood-white`. `none` is reserved for the empty room.

## How the options were checked

Every option in the options files was checked against Muuto's live configurator (EU shop, sales
code 102) on 2026-10-26. The check walked every configurator step for each product, covering:
- every option group and code;
- every price at every step;
- every base or size combination rule;
- every default;
- the item-number pattern, against 30 live spot checks.

Every option exists at Muuto for that product and size, and nothing Muuto sells is missing. The
only differences were names (" - " in the Illusion leathers, and the Outline base names), and
those now use Muuto's own wording. Muuto sells no white base for the Soft Side Table; its bases are
Black, Grey, Beige Green and Orange.

The configurator API, for re-checking:

```
GET https://www.muuto.com/api/configurator/products/<Product-Slug>?salesCode=102
GET https://www.muuto.com/api/configurator/configure/<MASTER>?product=<Product-Slug>&salesCode=102&selection1=…&selection2=…
```

- An incomplete answer lists the next step's options in `nextSelection`; a complete one has
  `itemNumber` and `totalPrice`.
- The endpoint doesn't validate selections, so only values listed for a step are real.
- `raw/downloads/api/fetch-configurator.mjs` saves a product's whole tree.
