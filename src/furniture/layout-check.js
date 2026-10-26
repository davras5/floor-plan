// The layout check: the room's furniture against the rules of docs/layout-review.md, the way an
// interior designer and a feng shui practitioner would look at it, for a room that is also a yoga
// studio. Pure geometry over footprints (no three.js, no DOM), so the same check runs for the room
// as it is, for a preset before it's applied (the score in the Presets panel), and in tests.
//
// createLayoutCheck(room) → check(pieces, art, pendant)
//   room    { W, L, entry: { x0, x1 }, balcony: { x0, x1 }, swings: [rect], entrySwing: rect,
//             openings: { wall: [[a, b]] }, pendant: { x, z, radius, bottom } }: the entry door is in
//           the wall z = L, the balcony door in the wall z = 0; swings are the floor the doors sweep
//           (furniture keeps out of them; a mat keeps out of the entry door's); openings are the
//           stretches of each wall (along it) that a window or door takes, so they can't be a yoga
//           wall; pendant is where the shade hangs by default, and `pendant` to check() where it
//           hangs now (a preset can swag it).
//   pieces  what stands on the floor and is in the room: { id, label, category, x0, x1, z0, z1,
//           rotation, host } (host: the id of the table a chair stands around).
//   art     the pictures: { wall, from, to } along that wall ('north' = window wall, 'south' = entry
//           wall, 'west' = left, 'east' = right).
// Returns { score, total, checks, zone, line }: checks are [{ id, label, status, reason }] with
// status 'pass', 'warn', 'fail' or 'skip' (nothing to check: no sofa, no chairs); score counts the
// passes out of `total` (the checks that apply); zone is the practice zone found, if any
// ({ x0, x1, z0, z1, wall, inLane, mat }), and line the straight line between the two doors as a
// strip ({ ax, az, bx, bz, width }), both for drawing on the floor.

const GRID = 0.05; // m: the floor is rasterised at this step for the zone search and the lane
const MAT = { long: 2.0, across: 0.8 };
// The practice zone: clear floor around a free-standing mat (40 cm either side, 30 cm at each end),
// or with the mat's head at a wall (30 cm either side: inversions and legs up the wall spread
// little more than the shoulders); and, for the free-wall check alone, standing poses along a wall
// (a stretch of wall with a metre in front).
const ZONE = { free: { long: 2.6, across: 1.6 }, wallEnd: { out: 2.3, along: 1.4 }, standing: { out: 1.0, along: 1.4 } };
const LANE = 0.9; // m: the width a path needs, and the strip either side of the line between the doors
const HEAD = 2.0; // m: nothing should hang lower over a walkway
const OVERHEAD = 2.2; // m: nor over the practice zone (arms overhead)
const CORNER = 0.6; // m: a table corner closer than this to a seat points at it
const CHAIR = { sit: 0.75, pass: 0.9, tight: 0.6 }; // m from the table edge behind a chair

export const WALL_NAMES = { north: 'window wall', south: 'entry wall', west: 'left wall', east: 'right wall' };

const SEATS = new Set(['sofa', 'pouf']);
const TABLES = new Set(['dining-table', 'side-table']);
const fmt = (m) => (m >= 1 ? `${m.toFixed(2).replace(/0$/, '')} m` : `${Math.round(m * 100)} cm`);
const overlaps = (a, b, tol = 0.01) => a.x0 < b.x1 - tol && a.x1 > b.x0 + tol && a.z0 < b.z1 - tol && a.z1 > b.z0 + tol;
const contains = (r, x, z, inset = 0) => x > r.x0 + inset && x < r.x1 - inset && z > r.z0 + inset && z < r.z1 - inset;
const pointRectDist = (x, z, r) => Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.z0 - z, 0, z - r.z1));
function segRectDist(line, r) {
  let d = Infinity;
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    d = Math.min(d, pointRectDist(line.ax + (line.bx - line.ax) * t, line.az + (line.bz - line.az) * t, r));
  }
  return d;
}
// Which way a piece faces, from its quarter turn (0: back to the window wall, so it faces +z).
const FACING = { 0: [0, 1], 90: [1, 0], 180: [0, -1], 270: [-1, 0] };
const facing = (p) => FACING[((p.rotation % 360) + 360) % 360] ?? [0, 1];
const centre = (r) => [(r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2];

export function createLayoutCheck(room) {
  const { W, L } = room;
  const line = { ax: (room.entry.x0 + room.entry.x1) / 2, az: L, bx: (room.balcony.x0 + room.balcony.x1) / 2, bz: 0, width: LANE };
  const cols = Math.round(W / GRID), rows = Math.round(L / GRID);
  const openings = room.openings ?? {};
  const wallLength = (wall) => (wall === 'west' || wall === 'east' ? L : W);
  // A wall stretch [a, b] that a mat's head or a standing pose can use: no window, door, or picture there.
  const wallUsable = (wall, a, b, art) =>
    !(openings[wall] ?? []).some(([o0, o1]) => a < o1 - 0.01 && b > o0 + 0.01) &&
    !art.some((p) => p.wall === wall && a < p.to - 0.01 && b > p.from + 0.01);
  const wallRect = (wall, pos, out, along) =>
    wall === 'west' ? { x0: 0, x1: out, z0: pos, z1: pos + along } :
    wall === 'east' ? { x0: W - out, x1: W, z0: pos, z1: pos + along } :
    wall === 'north' ? { x0: pos, x1: pos + along, z0: 0, z1: out } : { x0: pos, x1: pos + along, z0: L - out, z1: L };

  return function check(pieces, art = [], pendant = room.pendant) {
    const floor = pieces.filter((p) => p.x1 > p.x0 && p.z1 > p.z0);
    const sofa = floor.find((p) => p.category === 'sofa');
    const seats = floor.filter((p) => SEATS.has(p.category));
    const chairs = floor.filter((p) => p.category === 'chair');
    const inLane = (r) => segRectDist(line, r) < LANE / 2;

    // ---- The floor as a grid: what's blocked for a mat (pieces, door swings, the pendant's shade) ----
    const blocked = new Uint8Array(cols * rows);
    const swings = room.swings ?? [];
    const keepClear = room.entrySwing ? [room.entrySwing] : [];
    for (let j = 0; j < rows; j++) {
      const cz = (j + 0.5) * GRID;
      for (let i = 0; i < cols; i++) {
        const cx = (i + 0.5) * GRID;
        let b = 0;
        if (floor.some((p) => contains(p, cx, cz, -0.01))) b |= 1; // a piece blocks any cell it reaches 1 cm into
        if (keepClear.some((s) => contains(s, cx, cz, 0.01))) b |= 2;
        if (pendant.bottom < OVERHEAD && Math.hypot(cx - pendant.x, cz - pendant.z) < pendant.radius) b |= 4;
        blocked[j * cols + i] = b;
      }
    }
    // Summed-area table, so "is this rectangle clear?" is four lookups.
    const S = new Int32Array((cols + 1) * (rows + 1));
    for (let j = 0; j < rows; j++) {
      let run = 0;
      for (let i = 0; i < cols; i++) {
        run += blocked[j * cols + i] ? 1 : 0;
        S[(j + 1) * (cols + 1) + i + 1] = S[j * (cols + 1) + i + 1] + run;
      }
    }
    const cell = (v) => Math.round(v / GRID);
    function clear(r) {
      const i0 = cell(r.x0), i1 = cell(r.x1), j0 = cell(r.z0), j1 = cell(r.z1);
      if (i0 < 0 || j0 < 0 || i1 > cols || j1 > rows || i1 <= i0 || j1 <= j0) return false;
      return S[j1 * (cols + 1) + i1] - S[j0 * (cols + 1) + i1] - S[j1 * (cols + 1) + i0] + S[j0 * (cols + 1) + i0] === 0;
    }

    const checks = [];
    const add = (id, label, status, reason) => checks.push({ id, label, status, reason });

    // 1. The commanding seat: the sofa's back on a wall, the door in view, not straight ahead.
    if (!sofa) add('seat', 'Commanding seat', 'skip', 'No sofa in the room.');
    else {
      const f = facing(sofa), [cx, cz] = centre(sofa);
      const gap = { 0: sofa.z0, 90: sofa.x0, 180: L - sofa.z1, 270: W - sofa.x1 }[sofa.rotation] ?? Infinity;
      const walled = gap <= 0.08;
      const vx = line.ax - cx, vz = line.az - cz, len = Math.hypot(vx, vz);
      const cos = (f[0] * vx + f[1] * vz) / len, cross = f[0] * vz - f[1] * vx;
      const angle = Math.round((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
      const side = cross > 0 ? 'right' : 'left';
      const straight = sofa.rotation === 0 && line.ax > sofa.x0 && line.ax < sofa.x1;
      if (cos < 0.17) add('seat', 'Commanding seat', 'fail', `The entry door is ${angle >= 150 ? 'behind' : 'beside'} the sofa, out of view: you hear people come in rather than see them.`);
      else if (!walled) add('seat', 'Commanding seat', 'warn', `The sofa sees the door, but has no wall behind it (${fmt(gap)} off).`);
      else if (straight) add('seat', 'Commanding seat', 'warn', 'The sofa has a wall behind it, but the door is straight ahead of it.');
      else add('seat', 'Commanding seat', 'pass', `A wall behind the sofa, the door in view ${angle}° to the ${side}.`);
    }

    // 2. The doors: nothing in a swing, nothing on the straight line between the two doors.
    {
      const inSwing = floor.find((p) => swings.some((s) => overlaps(p, s)));
      const onLine = floor.find((p) => inLane(p));
      if (inSwing) add('doors', 'Doors clear', 'fail', `The ${inSwing.label} stands in a door's swing.`);
      else if (onLine) add('doors', 'Doors clear', 'warn', `The ${onLine.label} stands in the straight line between the entry door and the balcony door.`);
      else add('doors', 'Doors clear', 'pass', 'Both doors swing free, and nothing stands in the line between them.');
    }

    // 3. Head room under the pendant.
    {
      const under = floor.find((p) => contains(p, pendant.x, pendant.z));
      if (pendant.bottom >= HEAD) add('headroom', 'Head room', 'pass', `The pendant's shade hangs ${fmt(pendant.bottom)} up, clear of heads.`);
      else if (under && TABLES.has(under.category)) add('headroom', 'Head room', 'pass', `The pendant hangs over the ${under.label}, where a low shade belongs.`);
      else if (under) add('headroom', 'Head room', 'warn', `The pendant hangs ${fmt(pendant.bottom)} up over the ${under.label}: mind your head getting up.`);
      else add('headroom', 'Head room', 'fail', `The pendant's shade hangs ${fmt(pendant.bottom)} up over open floor, at head height: swag it over a table, or hang a flatter one.`);
    }

    // 4. Sharp corners: a dining table's corner pointing at a seat.
    {
      let worst = null;
      for (const t of floor.filter((p) => p.category === 'dining-table')) {
        for (const [x, z] of [[t.x0, t.z0], [t.x1, t.z0], [t.x0, t.z1], [t.x1, t.z1]]) {
          for (const s of seats) {
            const d = pointRectDist(x, z, s);
            if (d < CORNER && (!worst || d < worst.d)) worst = { d, t, s };
          }
        }
      }
      if (worst) add('corners', 'Soft corners', 'warn', `A corner of the ${worst.t.label} points at the ${worst.s.label}, ${fmt(worst.d)} away.`);
      else add('corners', 'Soft corners', 'pass', 'No table corner within 60 cm of a seat.');
    }

    // 5. The lane from the entry door to the balcony door: how wide at its narrowest.
    {
      const lane = laneWidth();
      const by = lane.by ? `, by the ${lane.by}` : '';
      if (lane.width <= 0.05) add('lane', 'Lane', 'fail', `No way from the entry door to the balcony door${lane.by ? `: the ${lane.by} blocks it` : ''}.`);
      else if (lane.width < CHAIR.sit - 0.05) add('lane', 'Lane', 'fail', `Only ${fmt(lane.width)} wide at the narrowest${by}.`);
      else if (lane.width < LANE) add('lane', 'Lane', 'warn', `${fmt(lane.width)} wide at the narrowest${by}: enough to pass, not to carry things.`);
      else add('lane', 'Lane', 'pass', `${fmt(lane.width)} wide at the narrowest${by}.`);
    }

    // 6. Room behind the dining chairs: from the table's edge to whatever is behind.
    if (!chairs.length) add('chairs', 'Dining chairs', 'skip', 'No chairs in the room.');
    else {
      let worst = null;
      for (const c of chairs) {
        const t = floor.find((p) => p.id === c.host) ?? floor.find((p) => p.category === 'dining-table' && overlaps(p, c, -0.05));
        const f = facing(c), back = [-f[0], -f[1]];
        const from = t ?? c; // the table's edge on the chair's side, or the chair itself
        const others = floor.filter((p) => p !== t && !(t && p.host === t.id) && p !== c);
        let free;
        if (back[0] < 0) free = from.x0 - Math.max(0, ...others.filter((p) => p.z0 < c.z1 && p.z1 > c.z0 && p.x1 <= from.x0 + 0.01).map((p) => p.x1));
        else if (back[0] > 0) free = Math.min(W, ...others.filter((p) => p.z0 < c.z1 && p.z1 > c.z0 && p.x0 >= from.x1 - 0.01).map((p) => p.x0)) - from.x1;
        else if (back[1] < 0) free = from.z0 - Math.max(0, ...others.filter((p) => p.x0 < c.x1 && p.x1 > c.x0 && p.z1 <= from.z0 + 0.01).map((p) => p.z1));
        else free = Math.min(L, ...others.filter((p) => p.x0 < c.x1 && p.x1 > c.x0 && p.z0 >= from.z1 - 0.01).map((p) => p.z0)) - from.z1;
        if (!worst || free < worst.free) worst = { free, c };
      }
      const { free, c } = worst;
      if (free < CHAIR.tight) add('chairs', 'Dining chairs', 'fail', `Only ${fmt(free)} behind ${c.label}: not enough to sit down.`);
      else if (free < CHAIR.sit) add('chairs', 'Dining chairs', 'warn', `${fmt(free)} behind ${c.label}: tight to sit down.`);
      else if (free < CHAIR.pass) add('chairs', 'Dining chairs', 'pass', `${fmt(free)} behind ${c.label}: room to sit, not to pass behind.`);
      else add('chairs', 'Dining chairs', 'pass', `${fmt(free)} behind every chair: room to sit and to pass.`);
    }

    // 7. The practice zone, and 8. a free wall for wall work.
    const zone = findZone();
    {
      const size = (z) => (z.wall ? `${ZONE.wallEnd.out} × ${ZONE.wallEnd.along} m` : `${ZONE.free.long} × ${ZONE.free.across} m`);
      if (!zone) add('zone', 'Practice zone', 'fail', `No clear floor of ${ZONE.free.long} × ${ZONE.free.across} m (${ZONE.wallEnd.out} × ${ZONE.wallEnd.along} m with the mat's head at a wall), with nothing lower than ${fmt(OVERHEAD)} over it.`);
      else if (zone.inLane) add('zone', 'Practice zone', 'warn', `${size(zone)}${zone.wall ? `, head to the ${WALL_NAMES[zone.wall]}` : ''}, but in the line between the doors: the balcony is cut off while you practise.`);
      else add('zone', 'Practice zone', 'pass', `${size(zone)}${zone.wall ? `, head to the ${WALL_NAMES[zone.wall]}` : ''}, out of the lane.`);
    }
    {
      const wallEnd = zone?.wall ? zone : bestWall(ZONE.wallEnd.out);
      const standing = wallEnd ? null : bestWall(ZONE.standing.out);
      if (wallEnd) add('wall', 'Free wall', 'pass', `The ${WALL_NAMES[wallEnd.wall]}: ${ZONE.wallEnd.along} m of wall with ${ZONE.wallEnd.out} m of floor in front, for inversions and legs up the wall.`);
      else if (standing) add('wall', 'Free wall', 'warn', `The ${WALL_NAMES[standing.wall]} is free, but with only ${fmt(ZONE.standing.out)} of floor in front: standing poses, no inversions.`);
      else add('wall', 'Free wall', 'fail', 'No stretch of wall is free of furniture, doors, windows and pictures.');
    }

    const counted = checks.filter((c) => c.status !== 'skip');
    return { score: counted.filter((c) => c.status === 'pass').length, total: counted.length, checks, zone, line };

    // ---- helpers over this call's grid ----

    // The lane from the entry door to the balcony door: row by row across the room, the free
    // stretch that the straight line between the doors runs through (or, where a piece stands on
    // that line, the widest stretch in the row), bounded by pieces, the pendant's shade when it
    // hangs at head height, and the walls; the narrowest row is the lane's width. Doors count as
    // open floor: this is about the furniture, not the doorways.
    function laneWidth() {
      let width = Infinity, by = null;
      for (let j = 0; j < rows; j++) {
        const z0 = j * GRID, z1 = z0 + GRID, cz = z0 + GRID / 2;
        const bars = floor.filter((p) => p.z0 < z1 - 0.005 && p.z1 > z0 + 0.005).map((p) => ({ x0: p.x0, x1: p.x1, label: p.label }));
        if (pendant.bottom < HEAD && Math.abs(cz - pendant.z) < pendant.radius) {
          const half = Math.sqrt(pendant.radius ** 2 - (cz - pendant.z) ** 2);
          bars.push({ x0: pendant.x - half, x1: pendant.x + half, label: 'pendant' });
        }
        bars.sort((p, q) => p.x0 - q.x0);
        // Free stretches between the bars (and the walls), each with what bounds it.
        const free = [];
        let x = 0, left = null;
        for (const bar of bars) {
          if (bar.x0 > x + 0.005) free.push({ x0: x, x1: bar.x0, by: left ?? bar });
          x = Math.max(x, bar.x1);
          left = bar;
        }
        if (W > x + 0.005) free.push({ x0: x, x1: W, by: left });
        if (!free.length) return { width: 0, by: bars[0]?.label ?? null };
        const lineX = line.ax + (line.bx - line.ax) * ((L - cz) / L);
        const gap = free.find((g) => lineX >= g.x0 && lineX <= g.x1) ?? free.reduce((p, q) => (q.x1 - q.x0 > p.x1 - p.x0 ? q : p));
        const w = gap.x1 - gap.x0;
        if (w < width) {
          width = w;
          by = gap.by?.label ?? null;
        }
      }
      return { width: Math.round(width * 100) / 100, by };
    }

    // Every place a practice zone fits, the best first: out of the lane, then with the mat's head
    // at a wall, then farthest from the line between the doors.
    function findZone() {
      let best = null;
      const consider = (r, wall) => {
        const lane = inLane(r);
        const score = (lane ? 0 : 10) + (wall ? 3 : 0) + Math.min(segRectDist(line, r), 1.5);
        if (!best || score > best.score) best = { ...r, wall, inLane: lane, score };
      };
      for (const [a, b] of [[ZONE.free.long, ZONE.free.across], [ZONE.free.across, ZONE.free.long]]) {
        for (let j = 0; j + cell(b) <= rows; j++) {
          for (let i = 0; i + cell(a) <= cols; i++) {
            const r = { x0: i * GRID, x1: i * GRID + a, z0: j * GRID, z1: j * GRID + b };
            if (clear(r)) consider(r, null);
          }
        }
      }
      for (const wall of ['west', 'east', 'north', 'south']) {
        for (let k = 0; k + cell(ZONE.wallEnd.along) <= cell(wallLength(wall)); k++) {
          const pos = k * GRID;
          if (!wallUsable(wall, pos, pos + ZONE.wallEnd.along, art)) continue;
          const r = wallRect(wall, pos, ZONE.wallEnd.out, ZONE.wallEnd.along);
          if (clear(r)) consider(r, wall);
        }
      }
      if (!best) return null;
      const { score, ...zone } = best;
      // The mat inside it: head at the wall, or in the middle, along the zone's long side.
      const w = zone.wall, m = MAT;
      const [cx, cz] = centre(zone);
      zone.mat =
        w === 'west' ? { x0: 0, x1: m.long, z0: cz - m.across / 2, z1: cz + m.across / 2 } :
        w === 'east' ? { x0: W - m.long, x1: W, z0: cz - m.across / 2, z1: cz + m.across / 2 } :
        w === 'north' ? { x0: cx - m.across / 2, x1: cx + m.across / 2, z0: 0, z1: m.long } :
        w === 'south' ? { x0: cx - m.across / 2, x1: cx + m.across / 2, z0: L - m.long, z1: L } :
        zone.x1 - zone.x0 > zone.z1 - zone.z0
          ? { x0: cx - m.long / 2, x1: cx + m.long / 2, z0: cz - m.across / 2, z1: cz + m.across / 2 }
          : { x0: cx - m.across / 2, x1: cx + m.across / 2, z0: cz - m.long / 2, z1: cz + m.long / 2 };
      return zone;
    }

    // A usable wall stretch with `out` metres of clear floor in front, if any (the first found).
    function bestWall(out) {
      for (const wall of ['west', 'east', 'north', 'south']) {
        for (let k = 0; k + cell(ZONE.wallEnd.along) <= cell(wallLength(wall)); k++) {
          const pos = k * GRID;
          if (!wallUsable(wall, pos, pos + ZONE.wallEnd.along, art)) continue;
          const r = wallRect(wall, pos, out, ZONE.wallEnd.along);
          if (clear(r)) return { ...r, wall };
        }
      }
      return null;
    }
  };
}
