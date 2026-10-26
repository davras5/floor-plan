// Room measurements, in metres.
//
// These were measured from the photos (vanishing-point calibration of each photo, scaled by a
// 2.50 m ceiling; cross-checked against the entry door, ~1.98 m clear). Expect errors of a few cm
// on the window wall and ±10–15 cm on the room length. Measure the real room with a tape and
// replace the numbers here; the whole model rebuilds from this file.
//
// Orientation, as seen standing in the entry door looking into the room. These compass
// names are only labels for the walls in this file; on the real map the window wall faces
// south-south-west (see `site` below).
//   north = window wall (window + balcony door), straight ahead
//   south = entry door wall, behind you
//   west  = left long wall (sofa today)
//   east  = right long wall (shelf today)
//
// Origin is the inside north-west corner at floor level.
// +x runs east along the window wall, +z runs south toward the entry door, +y is up.

export const ROOM = {
  width: 4.04, // inside, along the window wall
  length: 4.75, // inside, along the long walls (least certain: ±0.15; the ceiling outlet sits at its middle)
  height: 2.50, // floor to ceiling

  wallThickness: { north: 0.30, south: 0.15, west: 0.18, east: 0.15 },

  // Window and balcony door are two frames coupled side by side, with one head height.
  window: {
    offset: 0.44, // left corner → left edge of the outer frame (behind the curtain in every photo: +0.02/−0.08)
    width: 1.91, // outer frame width; its right edge is the joint with the balcony-door frame
    sill: 0.84, // floor → top of the wooden sill (= bottom of the frame)
    head: 2.25, // floor → top of the frame
    leftSash: 0.665, // left frame edge → the joint where the two sashes meet (there is no fixed mullion)
    reveal: 0.23, // depth from the wall face back to the frame
    sillDepth: 0.06, // how far the wooden sill sticks out past the wall face
    handle: 1.50, // floor → handle on the wide sash's meeting stile (hidden by plants in the photos: assumed)
  },

  balconyDoor: {
    offset: 2.35, // left corner → left edge of the door frame (= right edge of the window frame)
    width: 0.87, // outer frame width
    head: 2.25,
    panel: 0.34, // floor → top of the solid panel at the bottom (the glass starts 6 cm higher)
    handle: 1.19, // floor → handle on the left stile (the sash is hinged on the right)
  },

  entryDoor: {
    offsetFromEast: 0.10, // right-hand wall → hinge side of the opening
    width: 0.79, // clear opening
    height: 1.98, // clear opening
    casing: 0.04, // width of the frame's face trim; with the 2 cm lining the frame reads 6 cm wide
  },

  ceilingOutlet: { x: 2.02, z: 2.37 }, // where the pendant hangs
  pendant: { width: 0.44, height: 0.33, bottom: 1.68 }, // the opal-glass shade; bottom = floor → underside of the shade
  // The rail's left end is hidden behind the pendant in every photo; `from` is where the left curtain stack starts.
  curtainRail: { from: 0.37, to: 3.40, height: 2.22 },
  // Sheer white voile, gathered at both ends of the rail as in the photos: stack = how much
  // wall each gathered panel covers, hem = gap above the floor, inFront = rail face → wall.
  curtains: { stack: 0.42, hem: 0.015, inFront: 0.05 },
  switchHeight: 1.34, // light switch beside the entry door (centre of the plate)
  // Who walks through the room in Walk: a 1.70 m person, whose eyes are about 11 cm below the
  // top of the head (eye height ≈ 93.5% of stature).
  person: { height: 1.7, eye: 1.59 },
  pipeX: 0.07, // vertical white pipe in the window-wall corner

  // Where the flat sits in its building, for the real surroundings (scripts/surroundings.py).
  // The window wall is lined up with the building's garden facade, which faces 209° (SSW).
  site: {
    lat: 47.38, lon: 8.52, // Zürich, for the sun's position (a kilometre either way makes no difference)
    floorAboveGround: 3.2, // first floor: garden ground → the flat's floor
    alongFacade: 0, // slide the flat along the facade (m, + = toward the right-hand wall); 0 = level with the map pin
  },

  baseboard: { height: 0.06, thickness: 0.012 },
  balcony: { depth: 1.60, drop: 0.08 },
  hallway: { width: 1.90, depth: 1.60 }, // only shown in Walk view, through the door
};
