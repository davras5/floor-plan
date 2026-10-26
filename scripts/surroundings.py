"""Builds the flat's real surroundings from swisstopo open data.

Downloads (cached in raw/swisstopo/) and processes:
  - swissBUILDINGS3D 2.0  buildings with roofs (DXF polyface meshes)
  - swissALTI3D           terrain, 0.5 m
  - swissSURFACE3D Raster surface incl. trees, 0.5 m (trees = surface minus terrain)
  - SWISSIMAGE            aerial photo for the ground, 25 cm

and writes assets/surroundings/ for src/surroundings.js. Coordinates in the output are
"site" coordinates: metres from the map pin, x = east, y = up (from the building's base),
z = south (so it's a right-handed, y-up frame like three.js).

usage: python -I scripts/surroundings.py
Data © swisstopo, free to use with attribution (https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-ogd).
"""
import hashlib
import io
import json
import math
import os
import pickle
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'raw' / 'swisstopo'
OUT = ROOT / 'assets' / 'surroundings'

# The flat's map pin in LV95 (swisstopo's Swiss coordinates), from a Google Maps link converted
# with swisstopo's REFRAME service. It's an address, so it's kept out of git: put it in
# raw/site-pin.json as {"E": 2600000.0, "N": 1200000.0}, or set SITE_PIN="E,N".
def _pin():
    env = os.environ.get('SITE_PIN')
    if env:
        e, n = (float(v) for v in env.split(','))
        return e, n
    f = ROOT / 'raw' / 'site-pin.json'
    if not f.exists():
        raise SystemExit('No map pin: create raw/site-pin.json ({"E": …, "N": …}, LV95) or set SITE_PIN="E,N".')
    d = json.loads(f.read_text(encoding='utf-8'))
    return float(d['E']), float(d['N'])


PIN_E, PIN_N = _pin()
HALF = 250.0  # metres around the pin
MESH_STEP = 2.0  # terrain mesh spacing (m)
ORTHO_LEVEL, ORTHO_RES = 27, 0.25  # WMTS level 27 = 25 cm per pixel
ORTHO_SIZE = 2048

STAC = 'https://data.geo.admin.ch/api/stac/v1/collections'
SOURCES = {
    'buildings': 'ch.swisstopo.swissbuildings3d_2',
    'terrain': 'ch.swisstopo.swissalti3d',
    'surface': 'ch.swisstopo.swisssurface3d-raster',
}

E0, E1, N0, N1 = PIN_E - HALF, PIN_E + HALF, PIN_N - HALF, PIN_N + HALF


def lv95_to_wgs84(e, n):
    """swisstopo's approximate formulas (good to about a metre)."""
    y, x = (e - 2600000) / 1e6, (n - 1200000) / 1e6
    lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3
    lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.0140 * x ** 3
    return lon * 100 / 36, lat * 100 / 36


def fetch(url, dest):
    if dest.exists():
        return dest
    print('  downloading', url.rsplit('/', 1)[-1])
    tmp = dest.with_suffix(dest.suffix + '.part')
    with urllib.request.urlopen(url, timeout=60) as r, open(tmp, 'wb') as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    tmp.rename(dest)
    return dest


def latest_tiles(collection, suffix):
    """Most recent per-tile asset ending in `suffix` for every tile touching the area."""
    lon0, lat0 = lv95_to_wgs84(E0, N0)
    lon1, lat1 = lv95_to_wgs84(E1, N1)
    url = f'{STAC}/{collection}/items?bbox={lon0},{lat0},{lon1},{lat1}&limit=100'
    items = json.load(urllib.request.urlopen(url, timeout=30))['features']
    best = {}
    for it in items:
        b = it['bbox']
        if (b[2] - b[0]) * (b[3] - b[1]) > 0.5:  # skip whole-country releases
            continue
        for a in it['assets'].values():
            if a['href'].endswith(suffix):
                tile = tuple(round(v, 3) for v in b)
                if tile not in best or it['properties']['datetime'] > best[tile][0]:
                    best[tile] = (it['properties']['datetime'], a['href'])
    return [href for _, href in best.values()]


# ---- buildings -----------------------------------------------------------------

def read_buildings(path):
    """Polyface meshes from a swissBUILDINGS3D DXF, keeping those that touch the area."""
    z = zipfile.ZipFile(path)
    lines = io.TextIOWrapper(z.open(z.namelist()[0]), encoding='latin-1')
    out, cur, ent, rec = [], None, None, {}

    def end_record():
        if ent == 'VERTEX' and cur is not None:
            flags = int(rec.get('70', 0))
            if flags & 64:  # a corner
                cur['v'].append((float(rec['10']), float(rec['20']), float(rec['30'])))
            elif flags & 128:  # a face: 1-based corner indices, negative = hidden edge
                idx = [abs(int(rec[k])) - 1 for k in ('71', '72', '73', '74') if k in rec and int(rec[k]) != 0]
                if len(idx) >= 3:
                    cur['f'].append(idx)

    for code in lines:
        code = code.strip()
        value = next(lines).strip()
        if code == '0':
            end_record()
            ent, rec = value, {}
            if value == 'POLYLINE':
                cur = {'layer': '', 'v': [], 'f': []}
            elif value == 'SEQEND' and cur is not None:
                v = np.array(cur['v']) if cur['v'] else np.zeros((0, 3))
                if len(v) and v[:, 0].max() > E0 and v[:, 0].min() < E1 and v[:, 1].max() > N0 and v[:, 1].min() < N1:
                    out.append({'layer': cur['layer'], 'v': v, 'f': cur['f']})
                cur = None
            continue
        rec[code] = value
        if ent == 'POLYLINE' and code == '8' and cur is not None:
            cur['layer'] = value
    return out


def triangles(b):
    tris = []
    for f in b['f']:
        for i in range(1, len(f) - 1):
            tris.append((f[0], f[i], f[i + 1]))
    return b['v'][np.array(tris)] if tris else np.zeros((0, 3, 3))  # (n, 3 corners, xyz)


# ---- rasters -------------------------------------------------------------------

def read_grid(paths, res=0.5):
    """0.5 m XYZ tiles → one grid over the area; row 0 is the north edge, NaN where missing."""
    nx, ny = int(round((E1 - E0) / res)), int(round((N1 - N0) / res))
    grid = np.full((ny, nx), np.nan, dtype=np.float32)
    for p in paths:
        z = zipfile.ZipFile(p)
        with z.open(z.namelist()[0]) as f:
            data = np.loadtxt(io.TextIOWrapper(f, encoding='utf-8-sig'), skiprows=1, dtype=np.float64)
        col = np.floor((data[:, 0] - E0) / res).astype(int)
        row = np.floor((N1 - data[:, 1]) / res).astype(int)
        ok = (col >= 0) & (col < nx) & (row >= 0) & (row < ny)
        grid[row[ok], col[ok]] = data[ok, 2]
    return grid


def sample(grid, e, n, res=0.5):
    c = int(np.clip((e - E0) / res, 0, grid.shape[1] - 1))
    r = int(np.clip((N1 - n) / res, 0, grid.shape[0] - 1))
    return float(grid[r, c])


def rasterize(buildings, shape, res=0.5):
    """Building id (1-based) per 0.5 m cell, from each building's triangles seen from above."""
    label = np.zeros(shape, dtype=np.int32)
    for bi, b in enumerate(buildings, 1):
        for t in triangles(b):
            cx = (t[:, 0] - E0) / res
            cy = (N1 - t[:, 1]) / res
            x0, x1 = int(max(cx.min(), 0)), int(min(cx.max() + 1, shape[1]))
            y0, y1 = int(max(cy.min(), 0)), int(min(cy.max() + 1, shape[0]))
            if x0 >= x1 or y0 >= y1:
                continue
            gx, gy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
            (ax, bx, ccx), (ay, by, ccy) = cx, cy
            d = (by - ccy) * (ax - ccx) + (ccx - bx) * (ay - ccy)
            if abs(d) < 1e-9:
                continue
            l1 = ((by - ccy) * (gx - ccx) + (ccx - bx) * (gy - ccy)) / d
            l2 = ((ccy - ay) * (gx - ccx) + (ax - ccx) * (gy - ccy)) / d
            inside = (l1 >= 0) & (l2 >= 0) & (l1 + l2 <= 1)
            label[y0:y1, x0:x1][inside] = bi
    return label


def find_trees(dsm, dtm, label):
    """Crown tops: local maxima of (surface − terrain) away from buildings."""
    chm = np.nan_to_num(dsm - dtm, nan=0.0)
    blocked = label > 0
    for _ in range(3):  # grow the building mask by 1.5 m so roof edges don't count
        blocked = blocked | np.roll(blocked, 1, 0) | np.roll(blocked, -1, 0) | np.roll(blocked, 1, 1) | np.roll(blocked, -1, 1)
    w = 7
    pad = np.pad(chm, w // 2, mode='edge')
    windows = np.lib.stride_tricks.sliding_window_view(pad, (w, w))
    peaks = (chm >= windows.max(axis=(2, 3))) & (chm > 3.5) & (chm < 40) & ~blocked
    rows, cols = np.nonzero(peaks)
    order = np.argsort(-chm[rows, cols])
    kept = []
    for i in order:
        r, c, h = rows[i], cols[i], float(chm[rows[i], cols[i]])
        e, n = E0 + (c + 0.5) * 0.5, N1 - (r + 0.5) * 0.5
        spacing = max(2.5, 0.25 * h)
        if all((e - k[0]) ** 2 + (n - k[1]) ** 2 > spacing ** 2 for k in kept):
            kept.append((e, n, float(dtm[r, c]), h))
        if len(kept) >= 1500:
            break
    return kept


# ---- the flat's own building and facade ----------------------------------------

def facade(buildings, label):
    r = int((N1 - PIN_N) / 0.5)
    c = int((PIN_E - E0) / 0.5)
    own = int(label[r, c])
    if not own:  # the pin can sit just outside the footprint: take the nearest building
        ys, xs = np.nonzero(label)
        k = np.argmin((ys - r) ** 2 + (xs - c) ** 2)
        own = int(label[ys[k], xs[k]])
    b = buildings[own - 1]
    centre = b['v'][:, :2].mean(axis=0)
    best = None
    for t in triangles(b):
        nrm = np.cross(t[1] - t[0], t[2] - t[0])
        area = np.linalg.norm(nrm) / 2
        if area < 0.5 or abs(nrm[2]) / (2 * area) > 0.2:
            continue  # roofs, floors and slivers
        h = nrm[:2] / np.linalg.norm(nrm[:2])
        ctr = t.mean(axis=0)
        # Outward = away from the building's centre. (Probing the footprint doesn't work:
        # the roof's eaves overhang the walls, so just outside a wall still looks "inside".)
        if (ctr[:2] - centre) @ h < 0:
            h = -h
        bearing = math.degrees(math.atan2(h[0], h[1])) % 360
        if abs(bearing - 180) > 50:
            continue  # only the south side
        along = np.array([-h[1], h[0]])
        offs = (t[:, :2] - ctr[:2]) @ along
        pin_along = (np.array([PIN_E, PIN_N]) - ctr[:2]) @ along
        dist = (np.array([PIN_E, PIN_N]) - ctr[:2]) @ h  # negative: pin is inside
        covers = offs.min() - 1 <= pin_along <= offs.max() + 1
        score = (0 if covers else 1000) + abs(dist) - 0.01 * area
        if best is None or score < best[0]:
            foot = np.array([PIN_E, PIN_N]) - dist * h
            best = (score, foot, bearing, h)
    _, foot, bearing, h = best
    # How far this facade runs either side of the foot point, along the room's +x axis
    # (to the right when facing the window): all walls of the building in the same plane.
    right = np.array([h[1], -h[0]])  # (east, north) components; outward normal h turned 90° clockwise
    ext = [0.0, 0.0]
    for t in triangles(b):
        nrm = np.cross(t[1] - t[0], t[2] - t[0])
        if np.linalg.norm(nrm[:2]) < 1e-6:
            continue
        hh = nrm[:2] / np.linalg.norm(nrm[:2])
        if abs(abs(hh @ h) - 1) > 1e-3 or abs((t[:, :2].mean(axis=0) - foot) @ h) > 0.3:
            continue  # not in the facade plane
        a = (t[:, :2] - foot) @ right
        ext = [min(ext[0], a.min()), max(ext[1], a.max())]
    return own, b, foot, bearing, h, ext


# ---- aerial photo ----------------------------------------------------------------

def ortho():
    tile = 256 * ORTHO_RES
    c0, c1 = int((E0 - 2420000) // tile), int((E1 - 2420000) // tile)
    r0, r1 = int((1350000 - N1) // tile), int((1350000 - N0) // tile)
    cache = RAW / 'ortho'
    cache.mkdir(exist_ok=True)
    mosaic = Image.new('RGB', ((c1 - c0 + 1) * 256, (r1 - r0 + 1) * 256))
    for row in range(r0, r1 + 1):
        for col in range(c0, c1 + 1):
            url = f'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/2056/{ORTHO_LEVEL}/{col}/{row}.jpeg'
            p = fetch(url, cache / f'{ORTHO_LEVEL}_{col}_{row}.jpeg')
            mosaic.paste(Image.open(p), ((col - c0) * 256, (row - r0) * 256))
    left = (E0 - (2420000 + c0 * tile)) / ORTHO_RES
    top = ((1350000 - r0 * tile) - N1) / ORTHO_RES
    size = (E1 - E0) / ORTHO_RES
    img = mosaic.crop((round(left), round(top), round(left + size), round(top + size)))
    return img.resize((ORTHO_SIZE, ORTHO_SIZE), Image.LANCZOS)


# ---- main ------------------------------------------------------------------------

def main():
    RAW.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)

    print('Finding tiles…')
    srcs = {
        'buildings': latest_tiles(SOURCES['buildings'], '.dxf.zip'),
        'terrain': latest_tiles(SOURCES['terrain'], '_0.5_2056_5728.xyz.zip'),
        'surface': latest_tiles(SOURCES['surface'], '_0.5_2056_5728.xyz.zip'),
    }
    files = {k: [fetch(u, RAW / u.rsplit('/', 1)[-1]) for u in v] for k, v in srcs.items()}

    # Parsing ~1.5 GB of DXF/XYZ takes minutes, so the cropped results are cached per area
    # and source files; delete raw/swisstopo/area_*.pkl to force a fresh parse.
    names = '|'.join(sorted(p.name for v in files.values() for p in v))
    key = f'{PIN_E:.0f}_{PIN_N:.0f}_{HALF:.0f}_' + hashlib.md5(names.encode()).hexdigest()[:8]  # stable, unlike hash()
    cache = RAW / f'area_{key}.pkl'
    if cache.exists():
        print('Reading cached area…')
        dtm, dsm, buildings, label = pickle.loads(cache.read_bytes())
    else:
        print('Reading terrain and surface…')
        dtm = read_grid(files['terrain'])
        dsm = read_grid(files['surface'])
        dtm = np.where(np.isnan(dtm), np.nanmean(dtm), dtm)
        print('Reading buildings…')
        buildings = [b for p in files['buildings'] for b in read_buildings(p)]
        label = rasterize(buildings, dtm.shape)
        cache.write_bytes(pickle.dumps((dtm, dsm, buildings, label)))
    print(f'  {len(buildings)} buildings in the area')

    own, own_b, foot, bearing, outward, extent = facade(buildings, label)
    print(f'  facade runs {extent[0]:.1f} … {extent[1]:.1f} m either side of the pin')
    base = float(own_b['v'][:, 2].min())
    # Ground in front of the facade (the model's walls can reach below the terrain).
    ground = sample(dtm, *(foot + 3.0 * outward))
    print(f'  own building: {own_b["layer"]}, walls from {base:.1f} m, top {own_b["v"][:, 2].max():.1f} m, '
          f'ground outside {ground:.1f} m; facade faces {bearing:.1f}°')

    to_site = lambda e, n, h: (e - PIN_E, h - base, -(n - PIN_N))

    # Buildings → two triangle soups (walls, roofs), skipping the flat's own building.
    walls, roofs = [], []
    for bi, b in enumerate(buildings, 1):
        if bi == own:
            continue
        t = triangles(b)
        if not len(t):
            continue
        nrm = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
        ln = np.linalg.norm(nrm, axis=1)
        keep = ln > 1e-6
        t, nz = t[keep], nrm[keep, 2] / ln[keep]
        site = np.stack([t[..., 0] - PIN_E, t[..., 2] - base, -(t[..., 1] - PIN_N)], axis=-1)
        walls.append(site[np.abs(nz) <= 0.3])
        roofs.append(site[nz > 0.3])  # faces pointing down (floors) are never seen
    walls = np.concatenate(walls).astype(np.float32).ravel()
    roofs = np.concatenate(roofs).astype(np.float32).ravel()

    # Terrain mesh heights every MESH_STEP metres.
    k = int(MESH_STEP / 0.5)
    hgrid = dtm[k // 2::k, k // 2::k] - base
    terrain = hgrid.astype(np.float32)

    trees = [[round(v, 2) for v in to_site(e, n, g)] + [round(h, 1)] for e, n, g, h in find_trees(dsm, dtm, label)]
    print(f'  {len(trees)} trees')

    with open(OUT / 'buildings.bin', 'wb') as f:
        f.write(walls.tobytes())
        f.write(roofs.tobytes())
    with open(OUT / 'terrain.bin', 'wb') as f:
        f.write(terrain.tobytes())

    print('Fetching aerial photo…')
    ortho().save(OUT / 'ortho.jpg', quality=82, optimize=True)

    fx, _, fz = to_site(foot[0], foot[1], base)
    site = {
        # Deliberately no absolute coordinates in here: this file is published with the app.
        'attribution': '© swisstopo (swissBUILDINGS3D, swissALTI3D, swissSURFACE3D, SWISSIMAGE)',
        'half': HALF,
        'facade': {
            'x': round(fx, 3), 'z': round(fz, 3), 'bearing': round(bearing, 2),
            'ground': round(ground - base, 2),  # terrain just outside the facade, site y
            # extent of this building's facade along the room's +x axis, relative to (x, z)
            'extent': [round(float(extent[0]), 2), round(float(extent[1]), 2)],
        },
        'ownBuilding': {'layer': own_b['layer'], 'height': round(float(own_b['v'][:, 2].max()) - base, 2)},
        'buildings': {'file': 'buildings.bin', 'walls': int(walls.size), 'roofs': int(roofs.size)},
        # first sample sits at the centre of 0.5 m cell k // 2
        'terrain': {'file': 'terrain.bin', 'cols': terrain.shape[1], 'rows': terrain.shape[0], 'step': MESH_STEP,
                    'x0': -HALF + (k // 2 + 0.5) * 0.5, 'z0': -HALF + (k // 2 + 0.5) * 0.5},
        'ortho': {'file': 'ortho.jpg', 'size': 2 * HALF},
        'trees': trees,  # [x, ground y, z, height]
    }
    (OUT / 'site.json').write_text(json.dumps(site, separators=(',', ':')))
    print('Wrote', OUT)


if __name__ == '__main__':
    main()
