# ZHANGJIAJIE & WULINGYUAN — a fixed map of sandstone PILLARS (2026-10-23: the user's height-map render + "Terrain
# Design Atlas": colour concept, palette, drivable routes). Runs in Blender's Python (numpy only):
#   blender -b --factory-startup --python scripts/blender/zhangjiajie/build.py -- OUT=public/maps/zhangjiajie [DEBUG=<dir>]
# then (as for the Highlands):
#   blender -b … scripts/blender/island/roads.py -- MAP=public/maps/zhangjiajie WRITE=1   (grade the roads, carve beds)
#   blender -b … scripts/blender/island/map_preview.py -- MAP=… OUT=…/preview.jpg          (card; TILT=0 FULL=1: minimap)
#
# The height map (heightmap.png beside this script) is a tilted, shaded relief RENDER, not a DEM: a pillar's grey is
# its lighting, its tall faces smear downward. Read pixel by pixel it would be noise. So it is read for its STRUCTURE
# and the landforms are built:
#  1. READ: the legend, the watermark and the streaky bottom band are filled in from round about; MESAS = bright,
#     smooth areas (the flat white tables round the edge); RIVERS = the darkest path between hand-picked points along
#     the dark channels (main river north → south-west, its north-east branch); the rest is PILLAR FOREST, its local
#     brightness = how tall the pillars there stand.
#  2. BASE RELIEF: valley floors rising gently from the rivers (≈ 0–30 m), mesas ≈ 140–175 m with sheer ragged cliffs.
#     Heights are the real landscape's shapes at game scale (the render's legend says 1300 m; a 2.4 km map with 1.3 km
#     towers would be a wall of cliffs): pillars 40–210 m, like Wulingyuan's.
#  3. ROADS (before the pillars, over the base relief): the scenic loop through the valleys, side roads along the
#     rivers, and a switchback road up the north-west mesa to its viewpoint (a ramp cut into its flank — Tianmen's bends)
#     — the Highlands' heading-aware, grade-costed A*. Water crossings become level bridges.
#  4. PILLARS: thousands of fluted columns (sheer sides, rounded flat tops, a talus skirt) on the floors of the pillar
#     forest, clear of rivers and roads; mesa rims break up into them.
#  5. PROPS: trees on every ledge and pillar top (they set the forest density), a start base, viewpoints with lookouts,
#     camps, signposts; map.json (the atlas palette), heights.bin, biome.bin, props.json.
import json, math, os, sys, heapq
import numpy as np
import bpy

ARGS = dict(a.split('=', 1) for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []))
HERE = os.path.dirname(os.path.abspath(__file__))
HMAP = ARGS.get('HMAP') or os.path.join(HERE, 'heightmap.png'); OUT = ARGS.get('OUT'); DEBUG = ARGS.get('DEBUG')
STAGE = int(ARGS.get('STAGE', 9))

HALF = 1200.0; ST = 2.0; N = int(2 * HALF / ST) + 1  # 1201 × 1201, 2 m — the other maps' grid
WATER = -6.0                                           # WorldFields.WATER (world metres)
OFF = -6.0                                             # map units = world − OFF
rng = np.random.default_rng(23)

# ---------------------------------------------------------------- helpers
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
    d = np.full(np.shape(X), np.inf)
    segs = len(pts) if closed else len(pts) - 1
    for k in range(segs):
        a = pts[k]; b = pts[(k + 1) % len(pts)]
        d = np.minimum(d, seg_dist(X, Z, a[0], a[1], b[0], b[1]))
    return d

def save_png(path, a, lo=None, hi=None):
    """Grayscale (or H×W×3) float array → PNG (row 0 = top)."""
    if a.ndim == 2:
        lo = a.min() if lo is None else lo; hi = a.max() if hi is None else hi
        g = np.clip((a - lo) / max(1e-9, hi - lo), 0, 1); a = np.stack([g, g, g], 2)
    h, w, _ = a.shape
    rgba = np.concatenate([a, np.ones((h, w, 1))], 2)[::-1].astype(np.float32)
    im = bpy.data.images.new('dbg', w, h); im.pixels[:] = rgba.ravel(); im.filepath_raw = path; im.file_format = 'PNG'; im.save()
    bpy.data.images.remove(im)

def smooth(pts, it=3):
    p = np.array(pts, float)
    for _ in range(it):
        q = np.empty((2 * len(p) - 2, 2)); q[0::2] = 0.75 * p[:-1] + 0.25 * p[1:]; q[1::2] = 0.25 * p[:-1] + 0.75 * p[1:]
        p = np.vstack([p[:1], q, p[-1:]])
    return p

def resample(p, step=4.0):
    p = np.asarray(p, float)
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
    t = np.arange(0, d[-1] + 1e-6, step)
    return np.stack([np.interp(t, d, p[:, 0]), np.interp(t, d, p[:, 1])], 1)

xs = -HALF + np.arange(N) * ST
X, Z = np.meshgrid(xs, xs)  # [j, i]: z rows (north = −z at the top), x columns

# ---------------------------------------------------------------- 1. read the height map
im = bpy.data.images.load(HMAP); iw, ih = im.size
G0 = np.array(im.pixels[:], dtype=np.float32).reshape(ih, iw, 4)[::-1, :, :3].mean(2).astype(np.float64)  # row 0 = top
S = iw / 2048.0                                         # (coordinates below are on the 2048 px original)
C0X, C0Y, C1X, C1Y = 69 * S, 64 * S, 1978 * S, 1956 * S  # the relief inside the dark frame
# not relief: the streaky band along the bottom edge, the legend (bottom left), the watermark (bottom right) — each
# replaced by the relief just above it, mirrored (keeps the pillar texture; a smooth fill would read as a table)
G = G0.copy()
def mirror_up(y0, x0=0, x1=None):
    y0 = int(y0 * S); x0 = int(x0 * S); x1 = iw if x1 is None else int(x1 * S)
    for y in range(y0, ih): G[y, x0:x1] = G[max(0, 2 * y0 - y - 1), x0:x1]
mirror_up(1880)
mirror_up(1570, 0, 312)
mirror_up(1822, 1826)

def img_uv(x, z):
    """Map metres → height-map pixel (u, v)."""
    return C0X + (x + HALF) / (2 * HALF) * (C1X - C0X), C0Y + (z + HALF) / (2 * HALF) * (C1Y - C0Y)
def P(px, py):
    """Height-map pixel (2048 px original, x right / y down) → map metres (x, z)."""
    return ((px * S - C0X) / (C1X - C0X) * 2 * HALF - HALF, (py * S - C0Y) / (C1Y - C0Y) * 2 * HALF - HALF)

U, V = img_uv(X, Z)
g = bilinear(G, U, V)                 # the render's grey on the map grid
gb = blur(g, 3.0)                     # past its texture
gl = blur(g, 14.0)                    # the big shapes
sd = np.sqrt(np.maximum(0, blur(g * g, 6.0) - blur(g, 6.0) ** 2))  # local roughness: pillars are rough, tables smooth
# MESAS: bright and smooth, a few hundred metres across (opened / closed with blurs: no specks, no pinholes)
m0 = sstep(0.80, 0.9, blur(g, 5.0)) * sstep(0.09, 0.05, sd)
m1 = blur(m0, 6.0) > 0.55             # opening (drop specks)
mesa_soft = blur(m1.astype(float), 7.0)
mesa = mesa_soft > 0.5               # closing (fill pinholes)
print('mesa share', round(float(mesa.mean()), 3))

# RIVERS: the darkest path along the dark channels (A* on a 4 m grid, cost ~ brightness³)
RS = 2                                  # river grid = every 2nd cell (4 m)
gr = blur(g, 2.5)[::RS, ::RS]; nrv = gr.shape[0]
def dark_path(pts):
    out = []
    cost = 0.02 + gr ** 3
    for a, b in zip(pts[:-1], pts[1:]):
        sj, si = int(round((a[1] + HALF) / (ST * RS))), int(round((a[0] + HALF) / (ST * RS)))
        gj, gi = int(round((b[1] + HALF) / (ST * RS))), int(round((b[0] + HALF) / (ST * RS)))
        best = {(sj, si): 0.0}; came = {}; hq = [(0.0, sj, si)]
        while hq:
            f, j, i = heapq.heappop(hq)
            if (j, i) == (gj, gi): break
            c0 = best[(j, i)]
            for dj, di, L in ((1, 0, 1), (-1, 0, 1), (0, 1, 1), (0, -1, 1), (1, 1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (-1, -1, 1.414)):
                nj, ni = j + dj, i + di
                if nj < 0 or ni < 0 or nj >= nrv or ni >= nrv: continue
                nc = c0 + L * cost[nj, ni]
                if nc < best.get((nj, ni), 1e18):
                    best[(nj, ni)] = nc; came[(nj, ni)] = (j, i)
                    heapq.heappush(hq, (nc + 0.02 * math.hypot(nj - gj, ni - gi), nj, ni))
        path = [(gj, gi)]
        while path[-1] in came: path.append(came[path[-1]])
        path.reverse()
        leg = [(-HALF + i * ST * RS, -HALF + j * ST * RS) for j, i in path]
        out.extend(leg if not out else leg[1:])
    return resample(smooth(resample(out, 8.0), 3), 6.0)

# hand-picked points along the render's dark channels (2048 px original)
RIVER_PTS = {
    'main': ([(784, 92), (812, 420), (840, 760), (910, 1000), (880, 1180), (790, 1290), (660, 1400), (600, 1640), (636, 1880)], 26.0),
    'northeast': ([(910, 1000), (1060, 820), (1240, 640), (1420, 540), (1600, 500), (1976, 470)], 18.0),
}
RIVERS = {k: (dark_path([P(*p) for p in pts]), w) for k, (pts, w) in RIVER_PTS.items()}
for k, (p, w) in RIVERS.items(): print('river', k, len(p), 'samples', round(len(p) * 6.0), 'm')

if DEBUG:
    os.makedirs(DEBUG, exist_ok=True)
    col = np.stack([g, g, g], 2) * 0.8
    col[mesa] = col[mesa] * 0.5 + np.array([0.9, 0.75, 0.3]) * 0.5
    for k, (p, w) in RIVERS.items():
        ii = np.clip(((p[:, 0] + HALF) / ST).astype(int), 0, N - 1); jj = np.clip(((p[:, 1] + HALF) / ST).astype(int), 0, N - 1)
        for dj in range(-2, 3):
            for di in range(-2, 3): col[np.clip(jj + dj, 0, N - 1), np.clip(ii + di, 0, N - 1)] = [0.1, 0.5, 1.0]
    save_png(os.path.join(DEBUG, '1_read.png'), col[::2, ::2])
if STAGE <= 1: sys.exit(0)

# ---------------------------------------------------------------- 2. base relief (no pillars yet)
def coarse_dist(paths, step=4):
    """Distance (m) to the nearest of the polylines, on every `step`-th cell, bilinearly upsampled."""
    Xc, Zc = X[::step, ::step], Z[::step, ::step]
    d = np.full(Xc.shape, np.inf)
    for p in paths:
        q = p[::2]
        for a in range(len(q) - 1): d = np.minimum(d, seg_dist(Xc, Zc, q[a][0], q[a][1], q[a + 1][0], q[a + 1][1]))
    jj = np.arange(N) / step; return bilinear(d, *np.meshgrid(jj, jj))
d_riv = coarse_dist([p for p, _ in RIVERS.values()])
# each river's own half width at every cell (the nearest river's)
d_main = coarse_dist([RIVERS['main'][0]]); d_ne = coarse_dist([RIVERS['northeast'][0]])
half_w = np.where(d_main <= d_ne, RIVERS['main'][1], RIVERS['northeast'][1]) / 2 * (1 + 0.25 * vnoise(X, Z, 60, 3))
# valley floor: low by the rivers, rising gently away (terraced fields of the valleys), a little roll
floor = WATER + 3.0 + 24 * sstep(0, 320, d_riv) + vnoise(X, Z, 140, 4) * 6 + vnoise(X, Z, 40, 5) * 1.5
floor = np.maximum(floor, WATER + 1.5)
# river channels: bed below the water, banks sloping up to the floor
bank = sstep(half_w, half_w + 9, d_riv)
floor = (WATER - 2.6) * (1 - bank) + floor * bank
# MESAS: ragged sheer cliffs (the mask's edge pushed in and out by noise), tables ~140–175 m, a gentle roll on top
ms = mesa_soft + 0.22 * vnoise(X, Z, 46, 7) + 0.09 * vnoise(X, Z, 13, 8)
cliff = sstep(0.47, 0.53, ms)
table = 150 + 18 * vnoise(X, Z, 300, 9) + 4 * vnoise(X, Z, 60, 10) + 1.2 * vnoise(X, Z, 15, 11)
talus = 26 * sstep(0.18, 0.47, ms)             # scree and wooded slopes at the cliff foot
BASE = np.maximum(floor, np.minimum(table * cliff + floor * (1 - cliff), table)) + talus * (1 - cliff)
BASE = np.where(d_riv < half_w + 2, floor, BASE)   # (a river runs past a mesa: the water wins)
print('base relief', round(float(BASE.min()), 1), '…', round(float(BASE.max()), 1))

def hshade(H):
    gz, gx = np.gradient(H, ST)
    nrm = np.stack([-gx, np.ones_like(H), -gz], 2); nrm /= np.linalg.norm(nrm, axis=2, keepdims=True)
    L_ = np.array([-0.5, 0.75, -0.45]); L_ /= np.linalg.norm(L_)
    s = np.clip(nrm @ L_, 0, 1)
    col = np.stack([s * 0.55 + 0.25, s * 0.75 + 0.2, s * 0.4 + 0.15], 2)
    return np.where((H < WATER)[..., None], np.array([0.15, 0.55, 0.75]), col)
def grid_lines(col, every=200.0):
    for v in np.arange(-HALF, HALF + 1, every):
        k = int((v + HALF) / ST); w = 2 if abs(v) < 1 else 1
        col[:, max(0, k - w):k + w] = [1, 0.2, 0.2] if abs(v) < 1 else [0.9, 0.6, 0.1]
        col[max(0, k - w):k + w, :] = [1, 0.2, 0.2] if abs(v) < 1 else [0.9, 0.6, 0.1]
    return col
if DEBUG:
    save_png(os.path.join(DEBUG, '2_base.png'), grid_lines(hshade(BASE))[::2, ::2])
if STAGE <= 2: sys.exit(0)

# ---------------------------------------------------------------- 3. roads (over the base relief)
# THE MESA ROAD (Tianmen's bends): a long ramp cut into the north-west mesa's east flank — from the valley at RAMP_A
# up to the table at RAMP_B, RAMP_W wide — that the router climbs in switchbacks at a drivable grade
RAMP_A, RAMP_B, RAMP_W = (-430.0, -640.0), (-700.0, -960.0), 240.0
ax_, az_ = RAMP_B[0] - RAMP_A[0], RAMP_B[1] - RAMP_A[1]; rl = math.hypot(ax_, az_)
t_r = ((X - RAMP_A[0]) * ax_ + (Z - RAMP_A[1]) * az_) / rl ** 2
s_r = np.abs((X - RAMP_A[0]) * -az_ + (Z - RAMP_A[1]) * ax_) / rl
in_r = sstep(RAMP_W / 2 + 30, RAMP_W / 2 - 10, s_r) * sstep(-0.12, 0.0, t_r) * sstep(1.12, 1.0, t_r)

def hsample(x, z, H):
    fx = (np.asarray(x, float) + HALF) / ST; fz = (np.asarray(z, float) + HALF) / ST
    i = np.clip(fx.astype(int), 0, N - 2); j = np.clip(fz.astype(int), 0, N - 2); tx = fx - i; tz = fz - j
    return H[j, i] * (1 - tx) * (1 - tz) + H[j, i + 1] * tx * (1 - tz) + H[j + 1, i] * (1 - tx) * tz + H[j + 1, i + 1] * tx * tz

y0r = float(hsample([RAMP_A[0]], [RAMP_A[1]], BASE)[0]); y1r = float(hsample([RAMP_B[0]], [RAMP_B[1]], BASE)[0])
ramp_h = y0r + (y1r - y0r) * np.clip(t_r, 0, 1)
# (cut only: a ravine notched into the mesa, climbing to its top — the valley outside stays as it is)
BASE = BASE * (1 - in_r) + np.minimum(BASE, np.maximum(ramp_h, floor)) * in_r
print('mesa ramp', round(y0r, 1), '→', round(y1r, 1), 'm over', round(rl), 'm')

RC = 6.0                                    # A* cell (m)
idx = np.arange(0, N, int(RC / ST)); nr = len(idx)
SIG = float(ARGS.get('SIG', 6))
HS = blur(BASE, SIG)
HR = HS[np.ix_(idx, idx)]
WR = BASE[np.ix_(idx, idx)] < WATER + 0.6        # water: crossed on a (low) bridge
HE = np.maximum(HR, WATER + 2.5)
xr = xs[idx]
def cell(x, z): return int(round((z + HALF) / RC)), int(round((x + HALF) / RC))
DIRS = sorted([(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0), (1, 1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (-1, -1, 1.414),
               (2, 1, 2.236), (1, 2, 2.236), (-2, 1, 2.236), (-1, 2, 2.236), (2, -1, 2.236), (1, -2, 2.236), (-2, -1, 2.236), (-1, -2, 2.236)],
              key=lambda d: math.atan2(d[0], d[1]))
ND = len(DIRS); TURN = 1; TURN_EVERY = 2
NEAR_R, NEAR_PEN, NEAR_END = 3, 4.0, 5
USED = np.zeros((nr, nr), bool)
def mark_used(path):
    for x, z in path:
        j, i = cell(x, z)
        USED[max(0, j - NEAR_R):j + NEAR_R + 1, max(0, i - NEAR_R):i + NEAR_R + 1] = True
# keep the roads in the valleys, off the mesa tables (but the mesa road): a cost for height above the valley floor
ABOVE = np.maximum(0, HR - floor[np.ix_(idx, idx)])

def astar_h(a, b, grade_max=0.12, hard=0.3, k0=None, climb=False):
    """(cell, heading) A* a → b (the Highlands' router). Returns ([(x, z)], end heading)."""
    sj, si = cell(*a); gj, gi = cell(*b)
    INF = 1e18; cost = {}; came = {}
    hq = []
    for k in (range(ND) if k0 is None else [k0]):
        cost[(sj, si, k, TURN_EVERY - 1)] = 0.0; heapq.heappush(hq, (0.0, sj, si, k, TURN_EVERY - 1))
    end = None; it = 0
    while hq:
        f, j, i, k, cd = heapq.heappop(hq)
        if (j, i) == (gj, gi): end = (j, i, k, cd); break
        c0 = cost[(j, i, k, cd)]
        if f - math.hypot(j - gj, i - gi) * RC > c0 + 1e-6: continue
        it += 1
        if it > 5000000: break
        h0 = HE[j, i]
        for t in range(-TURN, TURN + 1):
            if t and cd < TURN_EVERY - 1: continue
            kk = (k + t) % ND
            nd = 0 if t else min(cd + 1, TURN_EVERY - 1)
            dj, di, L = DIRS[kk]
            nj, ni = j + dj, i + di
            if nj < 2 or ni < 2 or nj >= nr - 2 or ni >= nr - 2: continue
            run = L * RC
            gr_ = abs(HE[nj, ni] - h0) / run
            if gr_ > hard: continue
            near = USED[nj, ni] and math.hypot(nj - sj, ni - si) > NEAR_END and math.hypot(nj - gj, ni - gi) > NEAR_END
            up = 0.0 if climb else 0.02 * min(ABOVE[nj, ni], 60)
            c = run * (1 + 22 * max(0.0, gr_ - 0.05) + 60 * max(0.0, gr_ - grade_max) + 0.15 * abs(t) + (NEAR_PEN if near else 0) + up) + (run * 40 if WR[nj, ni] else 0)
            nc = c0 + c
            if nc < cost.get((nj, ni, kk, nd), INF):
                cost[(nj, ni, kk, nd)] = nc; came[(nj, ni, kk, nd)] = (j, i, k, cd)
                heapq.heappush(hq, (nc + math.hypot(nj - gj, ni - gi) * RC, nj, ni, kk, nd))
    if end is None:
        if hard < 0.45: return astar_h(a, b, grade_max, hard + 0.05, k0, climb)
        if k0 is not None: return astar_h(a, b, grade_max, 0.3, None, climb)
        print('  no route', a, b); return [a, b], None
    path = [end]
    while path[-1] in came: path.append(came[path[-1]])
    path.reverse()
    return [(xr[i], xr[j]) for j, i, _, _ in path], end[2]

NODES = {
    'base': (-230, 1060), 'sw_bank': (-620, 760), 'w_valley': (-660, 380), 'w_mesa': (-560, -60), 'nw_valley': (-420, -500),
    'ramp_foot': RAMP_A, 'viewpoint': (-720, -990), 'n_bridge': (-120, -840), 'n_mid': (300, -800), 'ne_river': (700, -700),
    'e_valley': (620, -280), 'e_mid': (620, 220), 'se_valley': (520, 560), 's_mid': (60, 560), 's_gate': (-60, 860),
    'centre': (60, 120), 'w_cross': (-400, 240), 'ne_cross': (330, -300),
}
ROUTES = [  # name, class, half width, nodes, closed, climb
    ('scenic_loop', 'highway', 5.0, ['base', 'sw_bank', 'w_valley', 'w_mesa', 'nw_valley', 'ramp_foot', 'n_bridge', 'n_mid', 'ne_river',
                                     'e_valley', 'e_mid', 'se_valley', 's_mid', 's_gate', 'base'], True, False),
    ('cross_road', 'track', 4.5, ['w_valley', 'w_cross', 'centre', 'ne_cross', 'e_valley'], False, False),
    ('valley_road', 'track', 4.5, ['s_mid', 'centre', 'n_bridge'], False, False),
    ('mesa_road', 'trail', 4.0, ['ramp_foot', 'viewpoint'], False, True),
]
roads = []
for name, cls, hw, nodes, closed, climb in ROUTES:
    pts = []; kh = None
    for a, b in zip(nodes[:-1], nodes[1:]):
        leg, kh = astar_h(NODES[a], NODES[b], 0.10 if climb else (0.09 if cls == 'highway' else 0.12), k0=kh, climb=climb)
        pts.extend(leg if not pts else leg[1:])
        mark_used(leg)
    p = resample(smooth(pts, 3), 4.0)
    if closed and np.hypot(*(p[0] - p[-1])) < 8: p = p[:-1]
    y = np.maximum(hsample(p[:, 0], p[:, 1], HS), WATER + 0.9)
    wv = (hsample(p[:, 0], p[:, 1], BASE) < WATER + 0.8).astype(float)
    br = np.zeros(len(p), int)
    k = 0
    while k < len(p):   # BRIDGES (the Highlands'): runs over water decked level from bank top to bank top
        if wv[k] > 0.04:
            a = k
            while k < len(p) and wv[k] > 0.04: k += 1
            L_ = max(0, a - 1); R_ = min(len(p) - 1, k)
            ya, yb = y[L_], y[R_]; span = (R_ - L_) * 4.0
            lowL = ya <= yb
            dy = float(np.clip(yb - ya, -0.08 * span, 0.08 * span))
            y0 = ya if lowL else yb - dy
            for t in range(L_ + 1, R_): y[t] = max(WATER + 2.5, y0 + dy * (t - L_) / (R_ - L_))
            if lowL: y[R_] = min(y[R_], y0 + dy)
            else: y[L_] = min(y[L_], y0)
            # (the deck's WATER + 2.5 floor can sit above a low bank: lift the bank ends to it, the grader ramps the
            # approach — a 1.6 m step at the deck start stopped the probe car on cross_road)
            if R_ - L_ > 1: y[L_], y[R_] = max(y[L_], y[L_ + 1]), max(y[R_], y[R_ - 1])
            br[L_:R_ + 1] = 1
            k = R_ + 1
        else:
            k += 1
    roads.append({'name': name, 'class': cls, 'halfWidth': hw, 'closed': closed, 'x': [round(float(v), 2) for v in p[:, 0]],
                  'z': [round(float(v), 2) for v in p[:, 1]], 'h': [round(float(v - OFF), 2) for v in y], 'bridge': [int(b) for b in br]})
    gr_max = float(np.max(np.abs(np.diff(y)) / 4.0))
    print(f'road {name}: {len(p) * 4} m, {sum(br)} bridge samples, max grade {gr_max:.2f}')

def draw_roads(col):
    for r_ in roads:
        ii = np.clip(((np.array(r_['x']) + HALF) / ST).astype(int), 0, N - 1); jj = np.clip(((np.array(r_['z']) + HALF) / ST).astype(int), 0, N - 1)
        c = [0.95, 0.75, 0.1] if r_['class'] == 'highway' else [1, 1, 1] if r_['class'] == 'track' else [0.9, 0.3, 0.9]
        for dj in (-2, -1, 0, 1, 2):
            for di in (-2, -1, 0, 1, 2): col[np.clip(jj + dj, 0, N - 1), np.clip(ii + di, 0, N - 1)] = c
    return col
if DEBUG:
    save_png(os.path.join(DEBUG, '3_roads.png'), draw_roads(grid_lines(hshade(BASE)))[::2, ::2])
if STAGE <= 3: sys.exit(0)

# ---------------------------------------------------------------- 4. pillars
def road_dist(x, z):
    d = np.full(np.shape(x), np.inf)
    for r_ in roads:
        px_ = np.array(r_['x'])[::2]; pz_ = np.array(r_['z'])[::2]
        for a in range(len(px_) - 1):
            d = np.minimum(d, seg_dist(x, z, px_[a], pz_[a], px_[a + 1], pz_[a + 1]))
    return d
d_road = coarse_dist([np.stack([r_['x'], r_['z']], 1) for r_ in roads], 2)
H = BASE.copy()
# candidates: a jittered grid (SP m), kept by the pillar forest's strength there
SP = float(ARGS.get('PILLAR_SP', 32))
gx_ = np.arange(-HALF + SP / 2, HALF, SP)
cx, cz = np.meshgrid(gx_, gx_)
cx = (cx + rng.uniform(-0.42, 0.42, cx.shape) * SP).ravel(); cz = (cz + rng.uniform(-0.42, 0.42, cz.shape) * SP).ravel()
r_p = 5.0 + 16.0 * rng.uniform(0, 1, cx.shape) ** 1.8      # mostly slender, a few massive
s_cliff = hsample(cx, cz, cliff); s_riv = hsample(cx, cz, d_riv); s_hw = hsample(cx, cz, half_w); s_road = hsample(cx, cz, d_road)
s_gb = hsample(cx, cz, gb); s_gl = hsample(cx, cz, gl); s_rmp = hsample(cx, cz, in_r)
near_node = np.min([np.hypot(cx - NODES[k][0], cz - NODES[k][1]) for k in ('base', 'viewpoint', 'centre')], axis=0)
inside = (np.abs(cx) < HALF - 12) & (np.abs(cz) < HALF - 12)
# the forest of pillars thins out by the rivers (wide valley floors) and where the render shows open ground, and
# stands in GROVES with wooded clearings between (not an even carpet)
grove_p = sstep(-0.3, 0.3, vnoise(cx, cz, 160, 61) + 0.35 * vnoise(cx, cz, 55, 62))
p_keep = 0.9 * sstep(0.22, 0.5, s_gl) * sstep(25, 90, s_riv) * (0.25 + 0.75 * grove_p)
keep = inside & (s_cliff < 0.35) & (s_riv > s_hw + 14 + r_p) & (s_road > r_p * 1.5 + 13) & (s_rmp < 0.05) & (near_node > 70) \
       & (rng.uniform(0, 1, cx.shape) < p_keep)
cx, cz, r_p, s_gb, s_gl = cx[keep], cz[keep], r_p[keep], s_gb[keep], s_gl[keep]
# height above the floor: the render's brightness there (bright = tall), varied; by a mesa they rise to its table
tall = sstep(0.28, 0.85, 0.5 * s_gb + 0.5 * s_gl)
hp = (30 + 180 * tall) * rng.uniform(0.45, 1.12, cx.shape)
hp = np.minimum(np.maximum(hp, r_p * 3.2), 215)                  # (a column, not a stump: ≥ ~1.6 × its width)
print('pillars', len(cx), 'height', round(float(hp.min())), '…', round(float(hp.max())), 'm')
# The COLUMNS are meshes in the game (world/map/PillarField.ts: the terrain's coarse LODs and horizon would turn them
# into cones); the ground grid gets only their TALUS mound. Each: [x, base y (world), z, radius, height, rotation,
# variant] — the base the lowest ground under its footprint, a little sunk.
pillars = []
for x0, z0, r, h0 in zip(cx, cz, r_p, hp):
    R = r * 3.0                                        # the window: the talus reaches ~2.4 r
    i0 = max(0, int((x0 - R + HALF) / ST)); i1 = min(N, int((x0 + R + HALF) / ST) + 2)
    j0 = max(0, int((z0 - R + HALF) / ST)); j1 = min(N, int((z0 + R + HALF) / ST) + 2)
    d = np.hypot(X[j0:j1, i0:i1] - x0, Z[j0:j1, i0:i1] - z0)
    under = BASE[j0:j1, i0:i1][d < r * 1.25]
    y_b = float(under.min() if under.size else hsample([x0], [z0], BASE)[0]) - 1.2
    h0 = float(min(h0, 240 - y_b))                                            # (by a mesa: no taller than its table and a bit)
    skirt = h0 * 0.1 * sstep(r * 2.4, r * 1.1, d)                            # talus at the foot, wooded
    H[j0:j1, i0:i1] = np.maximum(H[j0:j1, i0:i1], hsample(X[j0:j1, i0:i1], Z[j0:j1, i0:i1], BASE) + skirt)
    pillars += [round(float(x0), 2), round(y_b, 2), round(float(z0), 2), round(float(r), 2), round(h0, 1), round(float(rng.uniform(0, 6.283)), 3), int(rng.integers(0, 5))]
# the mesa rims break up: the cliff faces fluted and notched (the tables keep their tops)
rim = sstep(0.0, 0.5, cliff) * sstep(1.0, 0.6, cliff)
H -= rim * 14 * np.clip(vnoise(X, Z, 9, 31) + 0.4 * vnoise(X, Z, 4, 32), 0, 1)
H = np.where(d_riv < half_w + 1, np.minimum(H, BASE), H)    # (the water stays clear)
print('relief', round(float(H.min()), 1), '…', round(float(H.max()), 1))
def stamp_pillars(H_):
    """The heights WITH the columns (previews / debug only: the game draws them as meshes)."""
    Hc = H_.copy()
    for k in range(0, len(pillars), 7):
        x0, y_b, z0, r, h0 = pillars[k:k + 5]
        i0 = max(0, int((x0 - r * 1.4 + HALF) / ST)); i1 = min(N, int((x0 + r * 1.4 + HALF) / ST) + 2)
        j0 = max(0, int((z0 - r * 1.4 + HALF) / ST)); j1 = min(N, int((z0 + r * 1.4 + HALF) / ST) + 2)
        d = np.hypot(X[j0:j1, i0:i1] - x0, Z[j0:j1, i0:i1] - z0)
        Hc[j0:j1, i0:i1] = np.maximum(Hc[j0:j1, i0:i1], np.where(d < r * 1.1, y_b + h0, -1e9))
    return Hc
if DEBUG:
    save_png(os.path.join(DEBUG, '4_pillars.png'), draw_roads(hshade(stamp_pillars(H)))[::2, ::2])
    save_png(os.path.join(DEBUG, '4_pillars_zoom.png'), hshade(H)[700:1000, 400:700])
if STAGE <= 4: sys.exit(0)

# ---------------------------------------------------------------- 5. props
gz, gx = np.gradient(H, ST)
slope = np.hypot(gx, gz)
# trees on every gentle surface: the valley floors (groves), the talus, the ledges and the pillar / mesa tops
grove = vnoise(X, Z, 70, 21) * 0.55 + vnoise(X, Z, 22, 22) * 0.45
high = sstep(30, 70, H - floor)                         # up on a pillar / mesa: the green caps of the concept
forest = np.clip(0.5 + grove + 0.35 * high, 0, 1) * sstep(0.95, 0.4, slope) * (H > WATER + 1.0)
CELL = 6
cand = rng.uniform(0, 1, (N // CELL, N // CELL))
TI, TJ = np.meshgrid(np.arange(0, N - CELL, CELL), np.arange(0, N - CELL, CELL))
TI = TI + rng.integers(0, CELL, TI.shape); TJ = TJ + rng.integers(0, CELL, TJ.shape)
keep = cand[:TJ.shape[0], :TJ.shape[1]] < forest[TJ, TI] * 0.42
tx = xs[TI[keep]]; tz = xs[TJ[keep]]
far = road_dist(tx, tz) > 9
tx, tz = tx[far], tz[far]
placements = {}
def put(t, x, z, rot=None, scale=1.0):
    key = f'{int((x + HALF) // 200)}_{int((z + HALF) // 200)}'
    y = float(hsample([x], [z], H)[0]) - OFF
    placements.setdefault(key, {}).setdefault(t, []).extend([round(float(x), 2), round(y, 2), round(float(z), 2), round(float(rng.uniform(0, 6.283) if rot is None else rot), 3), round(float(scale), 2)])
for x, z in zip(tx, tz): put('pine', x, z, None, rng.uniform(0.8, 1.3))
print('trees', len(tx))
# set pieces, off the road on gentle ground (the Highlands' helpers)
def gap(x, z):
    return min(float(np.min(np.hypot(np.array(r_['x']) - x, np.array(r_['z']) - z))) for r_ in roads)
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
def flat_ok(x, z):
    return float(hsample([x], [z], slope)[0]) < 0.35 and float(hsample([x], [z], H)[0]) > WATER + 1.5
def clear_spot(node, off, side, clear):
    for o in (off, off + 6, off + 12, off + 20):
        for sd in (side, -side):
            x, z, yaw = near_road_spot(node, o, sd)
            if gap(x, z) > clear and flat_ok(x, z): return x, z, yaw
    nx, nz = NODES[node]
    for rad in range(20, 90, 8):
        for k in range(16):
            a = k * math.pi / 8; x, z = nx + math.cos(a) * rad, nz + math.sin(a) * rad
            if gap(x, z) > clear and flat_ok(x, z): return x, z, math.atan2(nx - x, nz - z)
    return x, z, yaw
def camp(node, side=1):
    x, z, yaw = clear_spot(node, 18, side, 20)
    put('campfire', x, z, 0, 1)
    for k, t in enumerate(['tent_orange', 'tent_blue', 'picnic_table', 'crate', 'barrel']):
        a = k * 1.25 + 0.4
        put(t, x + math.cos(a) * 6.5, z + math.sin(a) * 6.5, a + math.pi, 1)
# the START BASE (green dot of the concept): cabins, a camp, the flag
x, z, yaw = clear_spot('base', 16, 1, 10); put('cabin', x, z, yaw, 1); put('flag', x + 8, z + 4, 0, 1)
camp('base', -1); camp('w_valley', 1); camp('e_mid', -1)
# VIEWPOINTS (red dots): the lookout on the north-west mesa at the mesa road's end, signposts at the junctions
vx, vz, _ = clear_spot('viewpoint', 10, 1, 8); put('water_tower', vx, vz, 0.4, 1.2); put('flag', vx + 4, vz + 3, 0, 1)
for node in ('centre', 'n_bridge', 'ramp_foot', 'e_valley', 'w_valley', 's_mid'):
    x, z, yaw = near_road_spot(node, 7, 1); put('signpost', x, z, yaw, 1)
for node, side in (('n_mid', 1), ('se_valley', -1)):
    x, z, yaw = clear_spot(node, 16, side, 10); put('cabin', x, z, yaw, 1)

# ---------------------------------------------------------------- 6. write
if OUT:
    os.makedirs(OUT, exist_ok=True)
    Hm = H - OFF
    lo, hi = float(Hm.min()), float(Hm.max())
    ((Hm - lo) / (hi - lo) * 65535).round().astype('<u2').tofile(os.path.join(OUT, 'heights.bin'))
    BN = 601
    np.zeros((BN, BN, 2), np.uint8).tofile(os.path.join(OUT, 'biome.bin'))   # all forest
    r0 = roads[0]
    spawn_yaw = math.atan2(-(r0['x'][2] - r0['x'][0]), -(r0['z'][2] - r0['z'][0]))
    meta = {'id': 'zhangjiajie', 'name': 'Zhangjiajie & Wulingyuan', 'size': 2 * HALF, 'half': HALF, 'heightOffset': OFF,
            'grid': {'n': N, 'step': ST, 'min': round(lo, 3), 'range': round(hi - lo, 3), 'origin': [-HALF, -HALF]},
            'biomeGrid': {'n': BN, 'step': 4.0, 'origin': [-HALF, -HALF]}, 'seaLevel': 0.0,
            'spawn': [round(float(r0['x'][0]), 2), round(float(r0['z'][0]), 2), round(spawn_yaw, 3)],
            # the atlas's palette (its swatches, sampled): vegetation greens, sandstone rock / cliffs, soil, river blues
            'palette': {'grass': '678859', 'grassDark': '2a4e35', 'water': '3a84a6', 'waterDeep': '205f7b', 'dirt': 'aa8560',
                        'rock': '827465', 'cliff': 'a49580', 'flowers': 'cdbca5', 'sand': 'ceb38f'},
            'trees': 'conifer', 'roads': roads, 'bridges': [], 'pillars': pillars}
    json.dump(meta, open(os.path.join(OUT, 'map.json'), 'w'))
    json.dump({'chunkSize': 200.0, 'half': HALF, 'stride': 5, 'types': {}, 'placements': placements, 'features': {}, 'clay': []},
              open(os.path.join(OUT, 'props.json'), 'w'))
    print('wrote', OUT, 'heights', round(lo + OFF, 1), '…', round(hi + OFF, 1), 'water share', round(float((H < WATER).mean()), 3))
