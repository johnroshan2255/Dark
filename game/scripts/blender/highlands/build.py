# THE HIGHLANDS — a fixed map built from a reference HEIGHTMAP (2026-10-21: the user's "Terrain Heightmap and Palette
# Guide": a grayscale relief render, its colour concept and palette). Runs in Blender's Python (numpy only):
#   blender -b --factory-startup --python scripts/blender/highlands/build.py -- OUT=public/maps/highlands [GUIDE=<png>] [DEBUG=<dir>]
#   (GUIDE defaults to the concept sheet kept beside this script, guide.png)
# then:  blender -b … roads.py -- MAP=public/maps/highlands WRITE=1   (grade the roads, carve their beds)
#        blender -b … map_preview.py -- MAP=public/maps/highlands OUT=…/preview.jpg (and the minimap)
#
#  1. RELIEF: the guide's height-map panel (a tilted relief render) is cropped, stretched back to plan view (×1.3
#     vertically: the render's ~40° tilt), blurred past its trees / texture, and mapped grey → metres (dark grey =
#     valleys, light grey = plateaus, white = the north-east peak). A TERRACE curve turns the soft relief into flat
#     shelves with steep cliffs — the concept's plateaus — plus a little noise.
#  2. WATER (from the colour concept; the game has ONE water level, WorldFields.WATER): the central LAKE with its
#     island, the streams that fall into it from the west, north and east plateaus and the RIVER that leaves it to the
#     south are carved below the water as gorges through the cliffs; the land falls to the sea round the coast.
#  3. ROADS: a node graph read off the guide (spawn meadow, plateaus, the north gap, the summit, the cave, the east
#     coast, the lake shores, the south bridge, the two loops) joined by a slope-aware A* on the new terrain (6 m
#     cells: grade, cliffs and water cost; short water crossings become bridges) → winding, drivable roads. roads.py
#     then grades them and carves their beds.
#  4. PROPS: pine placements by a forest mask (they set the forest density: Dark grows its own trees, rocks, plants),
#     set pieces — a lookout on the summit, camps, cabins, a dock and boat on the lake, a windmill, signposts.
#  5. map.json, heights.bin (Uint16, map units = world + 6), biome.bin (all forest: the bright green palette),
#     props.json; the set-piece models (props.glb, bruno/) are the island's (copied by the caller).
import json, math, os, sys, heapq
import numpy as np
import bpy

ARGS = dict(a.split('=', 1) for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []))
GUIDE = ARGS.get('GUIDE') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'guide.png'); OUT = ARGS['OUT']; DEBUG = ARGS.get('DEBUG')

HALF = 1200.0; ST = 2.0; N = int(2 * HALF / ST) + 1  # 1201 × 1201, 2 m — the island's grid
WATER = -6.0                                           # WorldFields.WATER (world metres)
OFF = -6.0                                             # map units = world − OFF (the island's convention)
CROP = (167, 14, 786, 480)                             # the height-map panel in the guide (x, y, w, h px)
LAND_W = 2300.0; TILT = 1.3                            # land width (m), the render's vertical foreshortening
LAND_H = CROP[3] * TILT * (LAND_W / CROP[2])           # ≈ 1826 m
rng = np.random.default_rng(11)

def P(cx, cy):
    """Guide height-map panel pixel → map metres (x, z; north = −z at the top)."""
    return (cx / CROP[2] * LAND_W - LAND_W / 2, cy / CROP[3] * LAND_H - LAND_H / 2)

def load_gray(path):
    im = bpy.data.images.load(path); w, h = im.size
    px = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1, :, :3].mean(2)  # row 0 = top
    x, y, cw, ch = CROP
    return px[y:y + ch, x:x + cw].astype(np.float64)

def blur(a, s):
    if s <= 0: return a
    r = int(3 * s); k = np.exp(-0.5 * (np.arange(-r, r + 1) / s) ** 2); k /= k.sum()
    p = np.pad(a, r, mode='edge')
    a = np.apply_along_axis(lambda v: np.convolve(v, k, 'valid'), 1, p)
    return np.apply_along_axis(lambda v: np.convolve(v, k, 'valid'), 0, a)

def bilinear(img, u, v):
    h, w = img.shape
    u = np.clip(u, 0, w - 1.001); v = np.clip(v, 0, h - 1.001)
    i = u.astype(int); j = v.astype(int); fu = u - i; fv = v - j
    return img[j, i] * (1 - fu) * (1 - fv) + img[j, i + 1] * fu * (1 - fv) + img[j + 1, i] * (1 - fu) * fv + img[j + 1, i + 1] * fu * fv

def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)

def vnoise(x, z, scale, seed):
    r_ = np.random.default_rng(seed); m = int(2 * (HALF + 400) / scale) + 4
    lat = r_.uniform(-1, 1, (m, m))
    u = (x + HALF + 400) / scale; v = (z + HALF + 400) / scale
    i = np.clip(np.floor(u).astype(int), 0, m - 2); j = np.clip(np.floor(v).astype(int), 0, m - 2)
    fu = u - i; fv = v - j; fu = fu * fu * (3 - 2 * fu); fv = fv * fv * (3 - 2 * fv)
    a = lat[j, i]; b = lat[j, i + 1]; c = lat[j + 1, i]; d = lat[j + 1, i + 1]
    return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv

def seg_dist(X, Z, ax, az, bx, bz):
    dx, dz = bx - ax, bz - az; l2 = dx * dx + dz * dz + 1e-9
    t = np.clip(((X - ax) * dx + (Z - az) * dz) / l2, 0, 1)
    return np.hypot(X - (ax + dx * t), Z - (az + dz * t))

def poly_dist(X, Z, pts, closed=False):
    d = np.full(X.shape, np.inf)
    segs = len(pts) if closed else len(pts) - 1
    for k in range(segs):
        a = pts[k]; b = pts[(k + 1) % len(pts)]
        d = np.minimum(d, seg_dist(X, Z, a[0], a[1], b[0], b[1]))
    return d

def inside_poly(X, Z, pts):
    ins = np.zeros(X.shape, bool)
    n = len(pts)
    for k in range(n):
        (x1, z1), (x2, z2) = pts[k], pts[(k + 1) % n]
        crosses = ((z1 > Z) != (z2 > Z)) & (X < (x2 - x1) * (Z - z1) / (z2 - z1 + 1e-12) + x1)
        ins ^= crosses
    return ins

def save_png(path, a, lo=None, hi=None):
    """Grayscale (or H×W×3) float array → PNG (row 0 = top)."""
    if a.ndim == 2:
        lo = a.min() if lo is None else lo; hi = a.max() if hi is None else hi
        g = np.clip((a - lo) / max(1e-9, hi - lo), 0, 1); a = np.stack([g, g, g], 2)
    h, w, _ = a.shape
    rgba = np.concatenate([a, np.ones((h, w, 1))], 2)[::-1].astype(np.float32)
    im = bpy.data.images.new('dbg', w, h); im.pixels[:] = rgba.ravel(); im.filepath_raw = path; im.file_format = 'PNG'; im.save()
    bpy.data.images.remove(im)

xs = -HALF + np.arange(N) * ST
X, Z = np.meshgrid(xs, xs)  # [j, i]: z rows (north = −z at the top), x columns

# ---------------------------------------------------------------- 1. relief
g0 = load_gray(GUIDE)
gs = blur(g0, 3.6)                       # the relief past its trees
gl = blur(g0, 12.0)                      # the big shapes
tex = blur(np.abs(g0 - blur(g0, 1.5)), 4.0)
u = (X + LAND_W / 2) / LAND_W * CROP[2]; v = (Z + LAND_H / 2) / LAND_H * CROP[3]
G = bilinear(gs, u, v); GL = bilinear(gl, u, v); T = bilinear(tex, u, v)
inside = (u >= 0) & (u <= CROP[2] - 1) & (v >= 0) & (v <= CROP[3] - 1)
r = np.clip((G * 0.55 + GL * 0.45 - 0.17) / 0.6, 0, 1)
h = 4 + 165 * r ** 1.5
TER = 32.0
q = h / TER; fq = q - np.floor(q)
h = (np.floor(q) + sstep(0.66, 0.9, fq)) * TER * 0.85 + h * 0.15   # broad flat shelves, tall steep cliffs between
h = blur(h, 1.2) + vnoise(X, Z, 60, 5) * 2.2 + vnoise(X, Z, 14, 6) * 0.5

def smooth(pts, it=3):
    p = np.array(pts, float)
    for _ in range(it):
        q = np.empty((2 * len(p) - 2, 2)); q[0::2] = 0.75 * p[:-1] + 0.25 * p[1:]; q[1::2] = 0.25 * p[:-1] + 0.75 * p[1:]
        p = np.vstack([p[:1], q, p[-1:]])
    return p

def resample(p, step=4.0):
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
    t = np.arange(0, d[-1] + 1e-6, step)
    return np.stack([np.interp(t, d, p[:, 0]), np.interp(t, d, p[:, 1])], 1)

# ---------------------------------------------------------------- 2. water
# the coast: the land box with a ragged edge (the guide's dark margin), falling to the sea floor
# (a rounded box — a superellipse — not a rectangle: the coast curves round the corners)
_a, _b = LAND_W / 2, LAND_H / 2
edge = (1 - ((np.abs(X) / _a) ** 5 + (np.abs(Z) / _b) ** 5) ** 0.2) * min(_a, _b)
coast_n = vnoise(X, Z, 90, 7) * 70 + vnoise(X, Z, 28, 8) * 18
dark_edge = sstep(0.24, 0.16, GL)            # the guide's sea bays reach in where its margin is dark
sea = np.clip(sstep(70, 0, edge + coast_n) + dark_edge * sstep(260, 60, edge), 0, 1)
# the lake (centre), its island, the streams and the south river (guide panel pixels → metres)
LAKE = [P(*p) for p in [(210, 280), (250, 268), (290, 272), (330, 262), (380, 256), (420, 262), (455, 280), (482, 300),
                         (492, 324), (474, 344), (432, 352), (385, 362), (330, 366), (282, 354), (240, 334), (216, 308)]]
ISLE = P(385, 307); ISLE_R = 52.0
RIVERS = [  # (points, width m)
    ([P(*p) for p in [(482, 318), (505, 345), (528, 375), (546, 405), (560, 440), (574, 480), (590, 520)]], 30.0),   # south river → the sea
    ([P(*p) for p in [(150, 200), (172, 228), (196, 255), (218, 285)]], 22.0),                                     # west falls
    ([P(*p) for p in [(548, 214), (528, 244), (502, 272), (478, 300)]], 22.0),                                     # east falls
    ([P(*p) for p in [(352, 168), (366, 200), (380, 232), (388, 260)]], 18.0),                                     # north stream
]
def meander(pts, amp, seed):
    p = resample(smooth(pts, 2), 6.0)
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
    t = np.gradient(p, axis=0); t /= np.linalg.norm(t, axis=1, keepdims=True) + 1e-9
    nrm_ = np.stack([-t[:, 1], t[:, 0]], 1)
    r_ = np.random.default_rng(seed); ph = r_.uniform(0, 6.28, 3)
    off = (np.sin(d / 70 + ph[0]) * 0.6 + np.sin(d / 31 + ph[1]) * 0.3 + np.sin(d / 13 + ph[2]) * 0.1) * amp
    off *= np.clip(d / 40, 0, 1) * np.clip((d[-1] - d) / 40, 0, 1)  # ends stay on their marks
    return [tuple(v) for v in p + nrm_ * off[:, None]]
# the lake's shore: ragged (bays and points), not a polygon
LAKE = [tuple(v) for v in resample(np.array(LAKE + LAKE[:1]), 8.0)]
cx_, cz_ = np.mean(LAKE, axis=0)
LAKE = [(cx_ + (x - cx_) * (1 + 0.09 * math.sin(k * 0.21) + 0.05 * math.sin(k * 0.67 + 1)), cz_ + (z - cz_) * (1 + 0.09 * math.sin(k * 0.21) + 0.05 * math.sin(k * 0.67 + 1))) for k, (x, z) in enumerate(LAKE)]
dl = poly_dist(X, Z, LAKE, closed=True)
inl = inside_poly(X, Z, LAKE)
rise = np.maximum(0, h - WATER)
# (valley walls no steeper than ~0.45: the higher the ground, the wider the slope down to the water — roads can
# wind down to a river and cross it on a low bridge, like the concept's)
lake_w = np.where(inl, 1.0, sstep(16 + 2.2 * rise, 0, dl))
isle = np.hypot(X - ISLE[0], Z - ISLE[1])
lake_w *= sstep(ISLE_R - 14, ISLE_R + 10, isle)
riv_w = np.zeros_like(X)
for k_, (pts, w) in enumerate(RIVERS):
    pts = meander(pts, 26 if w > 25 else 14, 40 + k_)
    d = poly_dist(X, Z, pts) + vnoise(X, Z, 30, 50 + k_) * w * 0.18
    riv_w = np.maximum(riv_w, sstep(w / 2 + 10 + 2.2 * rise, w / 2, d))
wet = np.clip(np.maximum.reduce([sea, lake_w, riv_w]), 0, 1)
depth_l = np.where(inl, np.clip(dl / 70, 0, 1), 0)
# the sea shelves off: ~3 m by the shore, ~24 m a few hundred metres out (as deep as past the map's edge)
open_sea = sstep(0.55, 0.97, blur(np.where(inside, sea, 1.0)[::4, ::4], 12).repeat(4, 0).repeat(4, 1)[:N, :N])  # far from any land → 1
bed = WATER - 2.2 - 5.5 * depth_l - (1.5 + 20 * open_sea) * sea
H = h * (1 - wet) + bed * wet
# the island in the lake: a low wooded knoll
H = np.where(isle < ISLE_R + 10, np.maximum(H, WATER + 3 + 9 * sstep(ISLE_R + 6, 6, isle)), H)
H = np.where(inside, H, WATER - 24)

# ---------------------------------------------------------------- 3. roads
RC = 6.0                                    # A* cell (m)
idx = np.arange(0, N, int(RC / ST)); nr = len(idx)
HR = H[np.ix_(idx, idx)]
WR = HR < WATER + 0.6                         # water: crossed on a (low) bridge
HE = np.maximum(HR, WATER + 2.5)              # grades are measured to the deck over water
xr = xs[idx]
def cell(x, z): return int(round((z + HALF) / RC)), int(round((x + HALF) / RC))
def astar(a, b, grade_max=0.17, hard=0.3):
    """Cells a → b over HR: length × (1 + grade penalty) + water (bridges) — returns [(x, z)]."""
    sj, si = cell(*a); gj, gi = cell(*b)
    INF = 1e18; cost = {}; came = {}
    hq = [(0.0, sj, si)]; cost[(sj, si)] = 0.0
    nbr = [(1, 0, 1), (-1, 0, 1), (0, 1, 1), (0, -1, 1), (1, 1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (-1, -1, 1.414),
           (2, 1, 2.236), (1, 2, 2.236), (-2, 1, 2.236), (-1, 2, 2.236), (2, -1, 2.236), (1, -2, 2.236), (-2, -1, 2.236), (-1, -2, 2.236)]
    it = 0
    while hq:
        f, j, i = heapq.heappop(hq)
        if (j, i) == (gj, gi): break
        c0 = cost[(j, i)]
        it += 1
        if it > 600000: break
        h0 = HE[j, i]
        for dj, di, L in nbr:
            nj, ni = j + dj, i + di
            if nj < 2 or ni < 2 or nj >= nr - 2 or ni >= nr - 2: continue
            h1 = HE[nj, ni]
            run = L * RC
            wetc = bool(WR[nj, ni])
            gr = abs(h1 - h0) / run
            if gr > hard: continue
            c = run * (1 + 22 * max(0.0, gr - 0.05) + 60 * max(0.0, gr - grade_max)) + (run * 40 if wetc else 0)
            nc = c0 + c
            if nc < cost.get((nj, ni), INF):
                cost[(nj, ni)] = nc; came[(nj, ni)] = (j, i)
                heapq.heappush(hq, (nc + math.hypot(nj - gj, ni - gi) * RC, nj, ni))
    if (gj, gi) not in came:
        # no way within the grade: a steeper climb (switchbacks the bed carving will smooth), else a straight line
        if hard < 0.75: return astar(a, b, grade_max, hard + 0.15)
        return [a, b]
    path = [(gj, gi)]
    while path[-1] in came: path.append(came[path[-1]])
    path.reverse()
    return [(xr[i], xr[j]) for j, i in path]

def smooth(pts, it=3):
    p = np.array(pts, float)
    for _ in range(it):
        q = np.empty((2 * len(p) - 2, 2)); q[0::2] = 0.75 * p[:-1] + 0.25 * p[1:]; q[1::2] = 0.25 * p[:-1] + 0.75 * p[1:]
        p = np.vstack([p[:1], q, p[-1:]])
    return p

def resample(p, step=4.0):
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
    t = np.arange(0, d[-1] + 1e-6, step)
    return np.stack([np.interp(t, d, p[:, 0]), np.interp(t, d, p[:, 1])], 1)

def hsample(x, z):
    fx = (x + HALF) / ST; fz = (z + HALF) / ST
    i = np.clip(fx.astype(int), 0, N - 2); j = np.clip(fz.astype(int), 0, N - 2); tx = fx - i; tz = fz - j
    return H[j, i] * (1 - tx) * (1 - tz) + H[j, i + 1] * tx * (1 - tz) + H[j + 1, i] * (1 - tx) * tz + H[j + 1, i + 1] * tx * tz

NODES = {k: P(*p) for k, p in {
    'spawn': (100, 165), 'nw': (150, 70), 'n_mid': (265, 75), 'n_gap': (410, 100), 'summit': (530, 40), 'summit_e': (600, 72),
    'cave': (655, 100), 'e_plat': (712, 190), 'e_coast': (748, 262), 'se_loop': (668, 412), 's_bridge': (585, 382), 's_mid': (430, 392),
    's_coast': (300, 398), 'sw': (122, 372), 'sw_loop': (112, 300), 'falls_w': (178, 212), 'lake_w': (228, 268), 'lake_n': (382, 240),
    'lake_e': (500, 286), 'centre': (462, 214),
}.items()}
ROUTES = [  # name, class, half width, nodes (closed = a loop)
    ('ring_road', 'highway', 5.0, ['spawn', 'nw', 'n_mid', 'n_gap', 'summit_e', 'cave', 'e_plat', 'e_coast', 'se_loop', 's_bridge', 's_mid', 's_coast', 'sw', 'sw_loop', 'spawn'], True),
    ('lake_road', 'track', 4.5, ['falls_w', 'lake_w', 'lake_n', 'centre', 'n_gap'], False),
    ('lake_east', 'track', 4.5, ['lake_n', 'lake_e', 's_bridge'], False),
    ('falls_trail', 'trail', 4.0, ['spawn', 'falls_w'], False),
    ('summit_trail', 'trail', 4.0, ['summit_e', 'summit'], False),
    ('east_trail', 'trail', 4.0, ['centre', 'e_plat'], False),
    ('south_trail', 'trail', 4.0, ['lake_w', 's_coast'], False),
]
roads = []
for name, cls, hw, nodes, closed in ROUTES:
    pts = []
    for a, b in zip(nodes[:-1], nodes[1:]):
        leg = astar(NODES[a], NODES[b], 0.12 if cls == 'highway' else 0.17)
        pts.extend(leg if not pts else leg[1:])
    p = resample(smooth(pts, 3), 4.0)
    if closed and np.hypot(*(p[0] - p[-1])) < 8: p = p[:-1]
    y = hsample(p[:, 0], p[:, 1])
    wv = (y < WATER + 0.8).astype(float)
    br = np.zeros(len(p), int)
    # BRIDGES: every run over water / down a gorge wall, widened to the bank tops (where the ground stops falling
    # toward the gap), decked straight from top to top, ≥ 2.5 m over the water
    k = 0
    while k < len(p):
        if wv[k] > 0.04:
            a = k
            while k < len(p) and wv[k] > 0.04: k += 1
            L_ = max(0, a - 1); R_ = min(len(p) - 1, k)   # the bank tops: just outside the gorge
            # the deck: level-ish (≤ 8 %) from the LOWER bank; roads.py cuts the higher bank's approach down to it
            ya, yb = y[L_], y[R_]; span = (R_ - L_) * 4.0
            lowL = ya <= yb
            dy = float(np.clip(yb - ya, -0.08 * span, 0.08 * span))
            y0 = ya if lowL else yb - dy
            for t in range(L_ + 1, R_): y[t] = max(WATER + 2.5, y0 + dy * (t - L_) / (R_ - L_))
            if lowL: y[R_] = min(y[R_], y0 + dy)
            else: y[L_] = min(y[L_], y0)
            br[L_:R_ + 1] = 1
            k = R_ + 1
        else:
            k += 1
    roads.append({'name': name, 'class': cls, 'halfWidth': hw, 'closed': closed, 'x': [round(float(v), 2) for v in p[:, 0]],
                  'z': [round(float(v), 2) for v in p[:, 1]], 'h': [round(float(v - OFF), 2) for v in y], 'bridge': [int(b) for b in br]})
    print(f'road {name}: {len(p)} samples, {sum(br)} bridge')

# ---------------------------------------------------------------- 4. props
def road_dist(x, z):
    d = np.full(np.shape(x), np.inf)
    for r_ in roads:
        px_ = np.array(r_['x'])[::3]; pz_ = np.array(r_['z'])[::3]
        for a in range(len(px_) - 1):
            d = np.minimum(d, seg_dist(x, z, px_[a], pz_[a], px_[a + 1], pz_[a + 1]))
    return d
gz, gx = np.gradient(H, ST)
slope = np.hypot(gx, gz)
# forest: dense on the shelves and valley floors, thin on the risers, none in the water; groves, not a carpet
grove = vnoise(X, Z, 70, 21) * 0.6 + vnoise(X, Z, 22, 22) * 0.4
forest = np.clip(0.55 + grove, 0, 1) * sstep(0.9, 0.35, slope) * (H > WATER + 1.2)
cand = rng.uniform(0, 1, (N // 5, N // 5))
TI, TJ = np.meshgrid(np.arange(0, N - 5, 5), np.arange(0, N - 5, 5))
TI = TI + rng.integers(0, 5, TI.shape); TJ = TJ + rng.integers(0, 5, TJ.shape)
keep = cand[:TJ.shape[0], :TJ.shape[1]] < forest[TJ, TI] * 0.62
tx = xs[TI[keep]]; tz = xs[TJ[keep]]
far = road_dist(tx, tz) > 10
tx, tz = tx[far], tz[far]
placements = {}
def put(t, x, z, rot=None, scale=1.0):
    key = f'{int((x + HALF) // 200)}_{int((z + HALF) // 200)}'
    y = float(hsample(np.array([x]), np.array([z]))[0]) - OFF
    placements.setdefault(key, {}).setdefault(t, []).extend([round(float(x), 2), round(y, 2), round(float(z), 2), round(float(rng.uniform(0, 6.283) if rot is None else rot), 3), round(float(scale), 2)])
for x, z in zip(tx, tz): put('pine', x, z, None, rng.uniform(0.8, 1.3))
print('trees', len(tx))
# set pieces: off the road a little, on gentle ground
def near_road_spot(node, off=14, side=1):
    x, z = NODES[node]
    best = None
    for r_ in roads:
        px_ = np.array(r_['x']); pz_ = np.array(r_['z'])
        k = int(np.argmin(np.hypot(px_ - x, pz_ - z)))
        d = math.hypot(px_[k] - x, pz_[k] - z)
        if best is None or d < best[0]:
            k2 = min(len(px_) - 1, k + 1); k1 = max(0, k - 1)
            dx, dz = px_[k2] - px_[k1], pz_[k2] - pz_[k1]; L = math.hypot(dx, dz) + 1e-9
            best = (d, px_[k] - dz / L * off * side, pz_[k] + dx / L * off * side, math.atan2(-dx, -dz))
    return best[1], best[2], best[3]
def camp(node, side=1):
    x, z, yaw = near_road_spot(node, 18, side)
    put('campfire', x, z, 0, 1)
    for k, t in enumerate(['tent_orange', 'tent_blue', 'picnic_table', 'crate', 'barrel']):
        a = k * 1.25 + 0.4
        put(t, x + math.cos(a) * 6.5, z + math.sin(a) * 6.5, a + math.pi, 1)
camp('lake_n', 1); camp('sw_loop', -1); camp('e_plat', 1)
for node, side in (('spawn', 1), ('se_loop', -1), ('s_mid', 1)):
    x, z, yaw = near_road_spot(node, 16, side); put('cabin', x, z, yaw, 1)
sx, sz = NODES['summit']; put('water_tower', sx, sz, 0.4, 1.2); put('flag', sx + 4, sz + 3, 0, 1)
x, z, yaw = near_road_spot('nw', 26, 1); put('windmill', x, z, yaw, 1)
for node in ('n_gap', 'lake_w', 's_bridge', 'centre', 'cave'):
    x, z, yaw = near_road_spot(node, 7, 1); put('signpost', x, z, yaw, 1)
# a dock on the lake's north shore (its end over the water) and a boat at it
lx, lz = P(382, 262)
put('dock', lx, lz, math.pi, 1); put('boat', lx + 6, lz + 8, 0.3, 1)

# ---------------------------------------------------------------- 5. write
os.makedirs(OUT, exist_ok=True)
Hm = H - OFF
lo, hi = float(Hm.min()), float(Hm.max())
((Hm - lo) / (hi - lo) * 65535).round().astype('<u2').tofile(os.path.join(OUT, 'heights.bin'))
BN = 601
np.zeros((BN, BN, 2), np.uint8).tofile(os.path.join(OUT, 'biome.bin'))   # all forest (bright green)
sx_, sz_ = np.array(roads[0]['x'][0]), np.array(roads[0]['z'][0])
r0 = roads[0]
spawn_yaw = math.atan2(-(r0['x'][2] - r0['x'][0]), -(r0['z'][2] - r0['z'][0]))
meta = {'id': 'highlands', 'name': 'The Highlands', 'size': 2 * HALF, 'half': HALF, 'heightOffset': OFF,
        'grid': {'n': N, 'step': ST, 'min': round(lo, 3), 'range': round(hi - lo, 3), 'origin': [-HALF, -HALF]},
        'biomeGrid': {'n': BN, 'step': 4.0, 'origin': [-HALF, -HALF]}, 'seaLevel': 0.0,
        'spawn': [round(float(sx_), 2), round(float(sz_), 2), round(spawn_yaw, 3)],
        # the guide's palette (its swatches): grass bright / dark, water / deep, dirt road, rock, cliffs, flowers
        'palette': {'grass': 'a8e063', 'grassDark': '5dbb4a', 'water': '3ec1d8', 'waterDeep': '2e7fb8', 'dirt': 'd9c38a',
                    'rock': '8b7f6b', 'cliff': 'b8bcc2', 'flowers': 'ffe08a', 'sand': 'd9c38a'},
        'trees': 'conifer', 'roads': roads, 'bridges': []}
json.dump(meta, open(os.path.join(OUT, 'map.json'), 'w'))
json.dump({'chunkSize': 200.0, 'half': HALF, 'stride': 5, 'types': {}, 'placements': placements, 'features': {}, 'clay': []},
          open(os.path.join(OUT, 'props.json'), 'w'))
print('wrote', OUT, 'heights', round(lo + OFF, 1), '…', round(hi + OFF, 1), 'water share', round(float((H < WATER).mean()), 3))
if DEBUG:
    os.makedirs(DEBUG, exist_ok=True)
    nrm = np.stack([-gx, np.ones_like(H), -gz], 2); nrm /= np.linalg.norm(nrm, axis=2, keepdims=True)
    L_ = np.array([-0.5, 0.75, -0.45]); L_ /= np.linalg.norm(L_)
    shade = np.clip(nrm @ L_, 0, 1)
    col = np.stack([shade * 0.55 + 0.25, shade * 0.75 + 0.2, shade * 0.4 + 0.15], 2)
    col = np.where((H < WATER)[..., None], np.array([0.15, 0.55, 0.75]), col)
    for r_ in roads:
        ii = np.clip(((np.array(r_['x']) + HALF) / ST).astype(int), 0, N - 1); jj = np.clip(((np.array(r_['z']) + HALF) / ST).astype(int), 0, N - 1)
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                col[np.clip(jj + dj, 0, N - 1), np.clip(ii + di, 0, N - 1)] = [0.85, 0.7, 0.45]
    save_png(os.path.join(DEBUG, 'hillshade.png'), col[::2, ::2])
