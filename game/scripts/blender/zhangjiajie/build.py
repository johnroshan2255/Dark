# ZHANGJIAJIE & WULINGYUAN — a fixed map of sandstone PILLARS, RECONSTRUCTED from the user's height-map render
# (ref/heightmap_original.png) and coloured from their "Terrain Design Atlas" (ref/terrain_design_atlas.png). Runs in
# Blender's Python (numpy only):
#   blender -b --factory-startup --python scripts/blender/zhangjiajie/build.py -- OUT=<abs>/public/maps/zhangjiajie [DEBUG=<dir>] [STAGE=n]
# then (as for the Highlands):
#   blender -b … scripts/blender/island/roads.py -- MAP=public/maps/zhangjiajie WRITE=1   (grade the roads, carve beds)
#   blender -b … scripts/blender/island/map_preview.py -- MAP=… OUT=…/preview.jpg          (card; TILT=0 FULL=1: minimap)
#
# The height map is a tilted (from the south), lit relief RENDER with a height tint — not a DEM: a spire is a bright tip
# with its sunlit face smeared DOWN the image to its foot, a mesa a white table with its cliff below it. (2026-10-23:
# the first build read it only for "structure" and synthesised the rest — "1 % of the height map, a cheap copy"; a
# pixel-by-pixel un-projection is noise, the image is generated, its faces aren't consistent.) So the SCENE is
# reconstructed feature by feature, where the render puts it:
#  1. READ (image space, 2048 px): MESAS = the bright smooth tables (connected components) and each one's cliff = the
#     length of the face run below it; SPIRES = the local brightness maxima standing clear of the local ground grey that
#     have a face below them (≈ 950); RIVERS = the darkest path between hand-picked points along the dark channels.
#  2. UN-PROJECT: a thing h px tall in the render stands h px further SOUTH than its top shows. Faces fall at ≈ KT px
#     per unit of grey above the ground (measured on the spires' streaks) and MV m per px of face sets the scale:
#     a spire's foot = its tip + KT·Δgrey px south, its height = KT·Δgrey·MV m (≈ 60–240 m); a mesa's table = its white
#     shifted south by its own cliff, height = cliff·MV (≈ 190–250 m). Valley floors rise gently from the rivers; the
#     spire clusters stand on shared rocky MASSIFS (the density of their feet), as in the render.
#  3. ROADS (the atlas's routes: a scenic loop round the map, side roads through the valleys) — the Highlands'
#     heading-aware, grade-costed A* over the relief, threading BETWEEN the spires (a cost round each one); water
#     crossings become level bridges. Spires still on a road are dropped.
#  4. PILLARS: the columns are meshes in the game (src/world/map/PillarField.ts); the grid keeps their talus.
#  5. PROPS + WRITE: trees on every gentle surface (the forest that fills the atlas's valleys, ledges and tops), a start
#     base, viewpoints, camps; map.json (the atlas palette), heights.bin, biome.bin, props.json.
import json, math, os, sys, heapq
import numpy as np
import bpy

ARGS = dict(a.split('=', 1) for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []))
HERE = os.path.dirname(os.path.abspath(__file__))
HMAP = ARGS.get('HMAP') or os.path.join(HERE, 'ref', 'heightmap_original.png'); OUT = ARGS.get('OUT'); DEBUG = ARGS.get('DEBUG')
STAGE = int(ARGS.get('STAGE', 9))

HALF = float(ARGS.get('HALF', 2000)); ST = 2.0; N = int(2 * HALF / ST) + 1  # 4 km since 2026-10-23 (2001², 2 m; the other maps 1201²)
WATER = -6.0                                           # WorldFields.WATER (world metres)
OFF = -6.0                                             # map units = world − OFF
rng = np.random.default_rng(23)
# the un-projection (2048 px image): face px per unit of grey a spire tip stands above its ground (the streaks' slope,
# median over the spires), and metres of height per px of face (the scale: mesas ≈ 200 m over the gorges)
KT = float(ARGS.get('KT', 170)); MV = float(ARGS.get('MV', 1.7))

# ---------------------------------------------------------------- helpers
def box(a, r, axis):
    """Box mean of width 2r+1 along an axis (edge-padded, cumulative sums: O(n) whatever r)."""
    if r <= 0: return a
    p = np.pad(a, [(r + 1, r) if k == axis else (0, 0) for k in range(a.ndim)], mode='edge')
    c = np.cumsum(p, axis=axis)
    n = a.shape[axis]
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis); lo = np.take(c, np.arange(0, n), axis=axis)
    return (hi - lo) / (2 * r + 1)

def blur(a, s):
    """≈ Gaussian (σ = s cells): three box passes per axis."""
    if s <= 0: return a
    r = max(1, int(round((math.sqrt(4 * s * s + 1) - 1) / 2)))
    for ax in (0, 1):
        for _ in range(3): a = box(a, r, ax)
    return a

def maxf(a, r):
    """Square max filter (radius r)."""
    from numpy.lib.stride_tricks import sliding_window_view as sw
    p = np.pad(a, r, mode='edge')
    a = sw(p, 2 * r + 1, axis=1).max(-1)
    return sw(a, 2 * r + 1, axis=0).max(-1)

def minf(a, r): return -maxf(-a, r)

def label(mask):
    """4-connected components of a boolean image (row runs + union-find). 0 = background."""
    H_, W_ = mask.shape
    lab = np.zeros((H_, W_), np.int32); parent = [0]
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    for v in range(H_):
        row = mask[v]
        if not row.any(): continue
        d = np.diff(np.r_[0, row.astype(np.int8), 0]); s0 = np.nonzero(d == 1)[0]; e0 = np.nonzero(d == -1)[0]
        for a, b in zip(s0, e0):
            above = lab[v - 1, a:b] if v else np.zeros(0, np.int32)
            ids = np.unique(above[above > 0])
            if len(ids) == 0:
                parent.append(len(parent)); lab[v, a:b] = len(parent) - 1
            else:
                r_ = min(find(int(i)) for i in ids)
                for i in ids: parent[find(int(i))] = r_
                lab[v, a:b] = r_
    par = np.array([find(i) for i in range(len(parent))])
    _, inv = np.unique(par, return_inverse=True)
    return inv[lab].astype(np.int32)

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

def dots(col, x, z, c, r=2):
    """Paint (x, z) points into a ground-space debug image."""
    ii = np.clip(((np.asarray(x) + HALF) / ST).astype(int), 0, N - 1); jj = np.clip(((np.asarray(z) + HALF) / ST).astype(int), 0, N - 1)
    for dj in range(-r, r + 1):
        for di in range(-r, r + 1): col[np.clip(jj + dj, 0, N - 1), np.clip(ii + di, 0, N - 1)] = c
    return col

xs = -HALF + np.arange(N) * ST
X, Z = np.meshgrid(xs, xs)  # [j, i]: z rows (north = −z at the top), x columns

# ---------------------------------------------------------------- 1. read the render (image space)
im = bpy.data.images.load(HMAP); iw, ih = im.size
G0 = np.array(im.pixels[:], dtype=np.float32).reshape(ih, iw, 4)[::-1, :, :3].mean(2).astype(np.float64)  # row 0 = top
bpy.data.images.remove(im)
S = iw / 2048.0                                          # (coordinates below are on the 2048 px original)
# the relief inside the dark frame: its west / east edges, its far (north) edge and the top of its front (south) face
C0X, C1X, R0Y, R1Y = 69 * S, 1978 * S, 64 * S, 1880 * S
# the GROUND window (rows at ground level): everything stands south of where its top shows, so the map's square is the
# frame moved down by about a table's cliff (the far strip had only the backs of things; the front tables' feet lie
# under the block's front face)
C0Y, C1Y = 130 * S, 1990 * S
# not relief: the streaky band along the bottom edge (the block's front face), the legend (bottom left), the watermark
# (bottom right) — each replaced by the relief just above it, mirrored (keeps the spire texture)
G = G0.copy()
def mirror_up(y0, x0=0, x1=None):
    y0 = int(y0 * S); x0 = int(x0 * S); x1 = iw if x1 is None else int(x1 * S)
    for y in range(y0, ih): G[y, x0:x1] = G[max(0, 2 * y0 - y - 1), x0:x1]
mirror_up(1880)
mirror_up(1570, 0, 312)
mirror_up(1822, 1826)
G[:, :int(C0X)] = G[:, int(C0X):int(C0X) + 1]; G[:, int(C1X):] = G[:, int(C1X) - 1:int(C1X)]

def img_uv(x, z):
    """Map metres → render pixel (u, v) of a point at GROUND level."""
    return C0X + (x + HALF) / (2 * HALF) * (C1X - C0X), C0Y + (z + HALF) / (2 * HALF) * (C1Y - C0Y)
def P(px, py):
    """Render pixel (2048 px original, x right / y down) at ground level → map metres (x, z)."""
    return ((px * S - C0X) / (C1X - C0X) * 2 * HALF - HALF, (py * S - C0Y) / (C1Y - C0Y) * 2 * HALF - HALF)
MPX = 2 * HALF / (C1Y - C0Y)                              # metres of ground per px down the image

gs = blur(G, 2.0 * S)
# the local GROUND grey: a low envelope (¼ res: it is smooth)
q = 4
gq = gs[::q, ::q]
floor_img = blur(minf(gq, int(40 * S / q)), 30 * S / q)
floor_img = bilinear(floor_img, *np.meshgrid(np.arange(iw) / q, np.arange(ih) / q))
sd = np.sqrt(np.maximum(0, blur(G * G, 6.0 * S) - blur(G, 6.0 * S) ** 2))
gxi = np.zeros_like(G); gyi = np.zeros_like(G)
gxi[:, 1:-1] = (G[:, 2:] - G[:, :-2]) / 2; gyi[1:-1] = (G[2:] - G[:-2]) / 2
streak = blur(np.abs(gxi), 3 * S) / (blur(np.abs(gyi), 3 * S) + 0.004)   # sunlit faces: vertical streaks
st6 = blur(streak, 6 * S)

# MESAS: bright, smooth tables (opened / closed with blurs: no specks, no pinholes), one component each
m0 = (blur(G, 4 * S) > 0.85) & (sd < 0.06)
mesa_img = blur(blur(m0.astype(float), 8 * S) > 0.6, 6 * S) > 0.4
mesa_img[:int(R0Y) - 4] = False; mesa_img[int(R1Y):] = False
lab = label(mesa_img)
MESAS = []                                               # (component id, cliff px, area px)
for k in range(1, lab.max() + 1):
    vv, uu = np.nonzero(lab == k)
    if len(vv) < 3000 * S * S: continue
    Ls = []
    for u in np.unique(uu)[::4]:                          # the face run below the table's south edge, per column
        vb = vv[uu == u].max(); L = 0; prev = gs[vb, u]
        for v in range(vb + 1, min(ih - 1, vb + int(500 * S))):
            x = gs[v, u]
            if x < floor_img[v, u] + 0.07 or x > prev + 0.06: break
            prev = min(prev, x); L += 1
        if vb < R1Y - 10 * S: Ls.append(L / S)
    cl = float(np.clip(np.percentile(Ls, 60) if Ls else 120, 95, 150))   # (the edge tables' runs are cut by the frame)
    MESAS.append((k, cl, len(vv)))
    print(f'mesa {k}: centre {P(uu.mean() / S, vv.mean() / S)}, cliff {cl:.0f} px → {cl * MV:.0f} m')

# SPIRES: brightness maxima well above the local ground grey, a summit (darker just above it), a face below it,
# off the mesa tables
mx = maxf(gs, int(7 * S))
pk = (gs >= mx - 1e-9) & (gs > floor_img + 0.15)
above = np.full_like(gs, 1.0); above[int(8 * S):] = gs[:-int(8 * S)]
below = np.zeros_like(st6); below[:-int(20 * S)] = st6[int(20 * S):]
pk &= (above < gs - 0.015) & (below > 1.0)
pk &= ~(blur(mesa_img.astype(float), 4 * S) > 0.2)
pk[:int(R0Y) - int(30 * S)] = False; pk[int(R1Y):] = False; pk[:, :int(C0X) + 4] = False; pk[:, int(C1X) - 4:] = False
tv, tu = np.nonzero(pk)
dg = gs[tv, tu] - floor_img[tv, tu]
print('spire tips', len(tv), 'Δgrey', np.round(np.percentile(dg, [5, 50, 95]), 2))

# RIVERS: the darkest path along the dark channels (A* on a 4 px grid, cost ~ brightness³), hand-picked waypoints
RS = int(4 * S)
gr = blur(G, 2.5 * S)[::RS, ::RS]; nrv_h, nrv_w = gr.shape
def dark_path(pts):
    out = []
    cost = 0.02 + gr ** 3
    for a, b in zip(pts[:-1], pts[1:]):
        sj, si = int(round(a[1] * S / RS)), int(round(a[0] * S / RS)); gj, gi = int(round(b[1] * S / RS)), int(round(b[0] * S / RS))
        best = {(sj, si): 0.0}; came = {}; hq = [(0.0, sj, si)]
        while hq:
            f, j, i = heapq.heappop(hq)
            if (j, i) == (gj, gi): break
            c0 = best[(j, i)]
            for dj, di, L in ((1, 0, 1), (-1, 0, 1), (0, 1, 1), (0, -1, 1), (1, 1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (-1, -1, 1.414)):
                nj, ni = j + dj, i + di
                if nj < 0 or ni < 0 or nj >= nrv_h or ni >= nrv_w: continue
                nc = c0 + L * cost[nj, ni]
                if nc < best.get((nj, ni), 1e18):
                    best[(nj, ni)] = nc; came[(nj, ni)] = (j, i)
                    heapq.heappush(hq, (nc + 0.02 * math.hypot(nj - gj, ni - gi), nj, ni))
        path = [(gj, gi)]
        while path[-1] in came: path.append(came[path[-1]])
        path.reverse()
        leg = [P(i * RS / S, j * RS / S) for j, i in path]
        out.extend(leg if not out else leg[1:])
    return resample(smooth(resample(out, 8.0), 3), 6.0)
# (2048 px original) the main river north → south-west, its north-east branch
RIVER_PTS = {
    'main': ([(784, 92), (812, 420), (840, 760), (910, 1000), (880, 1180), (790, 1290), (660, 1400), (600, 1640), (636, 1880), (640, 2000)], 26.0),
    'northeast': ([(910, 1000), (1060, 820), (1240, 640), (1420, 540), (1600, 500), (1976, 470)], 18.0),
}
RIVERS = {k: (dark_path(pts), w) for k, (pts, w) in RIVER_PTS.items()}
for k, (p, w) in RIVERS.items(): print('river', k, round(len(p) * 6.0), 'm')

if DEBUG:
    os.makedirs(DEBUG, exist_ok=True)
    col = np.stack([G, G, G], 2) * 0.8
    col[mesa_img] = col[mesa_img] * 0.5 + np.array([0.9, 0.6, 0.2]) * 0.5
    for dv in range(-3, 4):
        for du in range(-3, 4): col[np.clip(tv + dv, 0, ih - 1), np.clip(tu + du, 0, iw - 1)] = [1, 0.1, 0.1]
    for k, (pts, w) in RIVER_PTS.items():
        p = np.array(pts) * S
        for a, b in zip(p[:-1], p[1:]):
            for t in np.linspace(0, 1, 200):
                col[int(a[1] + (b[1] - a[1]) * t), int(a[0] + (b[0] - a[0]) * t)] = [0.1, 0.5, 1.0]
    save_png(os.path.join(DEBUG, '1_read.png'), col[::2, ::2])
if STAGE <= 1: sys.exit(0)

# ---------------------------------------------------------------- 2. un-project: the relief and the spires (ground space)
def coarse_dist(paths, step=4):
    """Distance (m) to the nearest of the polylines, on every `step`-th cell, bilinearly upsampled."""
    Xc, Zc = X[::step, ::step], Z[::step, ::step]
    d = np.full(Xc.shape, np.inf)
    for p in paths:
        q_ = p[::2]
        for a in range(len(q_) - 1): d = np.minimum(d, seg_dist(Xc, Zc, q_[a][0], q_[a][1], q_[a + 1][0], q_[a + 1][1]))
    jj = np.arange(N) / step; return bilinear(d, *np.meshgrid(jj, jj))
d_riv = coarse_dist([p for p, _ in RIVERS.values()])
d_main = coarse_dist([RIVERS['main'][0]]); d_ne = coarse_dist([RIVERS['northeast'][0]])
half_w = np.where(d_main <= d_ne, RIVERS['main'][1], RIVERS['northeast'][1]) / 2 * (1 + 0.25 * vnoise(X, Z, 60, 3))
U, V = img_uv(X, Z)

# MESA TABLES: each component's white shifted SOUTH by its own cliff (where the render's table really stands), its top
# that cliff × MV above the gorges; a gentle roll on top
msh = np.zeros_like(G); mtop = np.zeros_like(G)
for k, cl, _ in MESAS:
    sh = int(round(cl * S))
    m = blur((lab == k).astype(float), 2 * S)
    mm = np.zeros_like(m); mm[sh:] = m[:-sh]
    top = (22 + cl * MV) * float(ARGS.get('TS', 1.35))
    mtop = np.where(mm > msh, top, mtop); msh = np.maximum(msh, mm)
mesa_soft = bilinear(msh, U, V)
table = bilinear(blur(mtop, 20 * S), U, V)
table = np.where(table > 1, table / np.maximum(1e-3, bilinear(blur((mtop > 0).astype(float), 20 * S), U, V)), 0)
table += 10 * vnoise(X, Z, 300, 9) + 4 * vnoise(X, Z, 60, 10) + 1.2 * vnoise(X, Z, 15, 11)

# VALLEY FLOORS: low by the rivers, rising away from them, a little higher where the render's ground is lighter
fl_g = bilinear(floor_img, U, V)
floor = WATER + 3.0 + 26 * sstep(0, 340, d_riv) + 22 * sstep(0.3, 0.62, fl_g) * sstep(20, 160, d_riv) \
        + vnoise(X, Z, 140, 4) * 5 + vnoise(X, Z, 40, 5) * 1.5
floor = np.maximum(floor, WATER + 1.5)
bank = sstep(half_w, half_w + 9, d_riv)
floor = (WATER - 2.6) * (1 - bank) + floor * bank

def hsample(x, z, H):
    fx = (np.asarray(x, float) + HALF) / ST; fz = (np.asarray(z, float) + HALF) / ST
    i = np.clip(fx.astype(int), 0, N - 2); j = np.clip(fz.astype(int), 0, N - 2); tx = fx - i; tz = fz - j
    return H[j, i] * (1 - tx) * (1 - tz) + H[j, i + 1] * tx * (1 - tz) + H[j + 1, i] * (1 - tx) * tz + H[j + 1, i + 1] * tx * tz

# THE TERRAIN (2026-10-23, approved by the user from its renders): sculpted and eroded by terrain.py (Blender, ANT
# Landscape's eroder) — TERRAIN=<dir with terrain.npy + floor.npy>, default ./terrain. Without it (TERRAIN=0) the
# older procedural towers below.
TERRAIN = ARGS.get('TERRAIN', os.path.join(HERE, 'terrain'))
TS = float(ARGS.get('TS', 1.35))
if TERRAIN == '0':
    # TOWERS — the spires are TERRAIN (2026-10-23, "use blender to make actual terrain … in the reference images it may
    # seem like small pillars but actually it's hills with much height"): every tip of the render seeds a sandstone TOWER
    # hill of the height field — sheer walls, a treed ledge part way up, a forested crown — Voronoi cells of the tips'
    # feet, so the towers stand shoulder to shoulder with narrow forested GORGES between them; neighbours FUSE into
    # massifs (one block, a shallow cleft between its columns, stepped tops); a tower reaches only so far from its tip
    # (open valleys stay open). Heights TS × the render's (the user: "more height"), 110–380 m over the valley floors.
    TS = float(ARGS.get('TS', 1.35))
    hp_px = KT * dg
    cx, cz = P(tu / S, tv / S + hp_px)
    hp = hp_px * MV * TS
    inside = (np.abs(cx) < HALF - 14) & (np.abs(cz) < HALF - 14)
    cx, cz, hp = cx[inside], cz[inside], hp[inside]
    s_mesa = hsample(cx, cz, mesa_soft); s_riv = hsample(cx, cz, d_riv); s_hw = hsample(cx, cz, half_w)
    ok = (s_mesa < 0.35) & (s_riv > s_hw + 26)
    cx, cz, hp = cx[ok], cz[ok], np.clip(hp[ok], 110, 380)
    ns = len(cx)
    dd = np.hypot(cx[:, None] - cx[None], cz[:, None] - cz[None]); np.fill_diagonal(dd, 1e9)
    nn = np.sort(dd, 1)[:, :3].mean(1)                      # the spacing round each tip
    # FUSED MASSIFS: union close neighbours of like height (≈ 55 % of the pairs), so the hills come as single towers and
    # as blocks of 2–5 columns
    par = list(range(ns))
    def find(a_):
        while par[a_] != a_: par[a_] = par[par[a_]]; a_ = par[a_]
        return a_
    for i in range(ns):
        for j in np.nonzero(dd[i] < 1.1 * nn[i])[0]:
            if j > i and rng.uniform() < 0.55 and abs(hp[i] - hp[j]) < 0.35 * max(hp[i], hp[j]):
                ri, rj = find(i), find(int(j))
                if ri != rj: par[ri] = rj
    grp = np.array([find(i) for i in range(ns)])
    print('towers', ns, 'massifs', len(np.unique(grp)), 'height', np.round(np.percentile(hp, [5, 50, 95])), 'spacing', np.round(np.percentile(nn, [5, 50, 95])))
    # Voronoi in a WARPED, BLOCKY metric (joint-controlled sandstone: angular faces, ragged fissured outlines): per cell
    # the nearest tip (F1, id), the nearest of ANOTHER massif (F2o → the gorge) and the second nearest of any (F2a → a
    # cleft between fused columns)
    WX = X + 9 * vnoise(X, Z, 46, 41) + 3 * vnoise(X, Z, 13, 42); WZ = Z + 9 * vnoise(X, Z, 46, 43) + 3 * vnoise(X, Z, 13, 44)
    F1 = np.full((N, N), 1e9); ID = np.full((N, N), -1); G1 = np.full((N, N), -1); F2o = np.full((N, N), 1e9); F2a = np.full((N, N), 1e9)
    rot = rng.uniform(0, math.pi / 2, ns)
    for s_ in range(ns):
        R = 1.4 * nn[s_] + 40
        i0 = max(0, int((cx[s_] - R + HALF) / ST)); i1 = min(N, int((cx[s_] + R + HALF) / ST) + 1)
        j0 = max(0, int((cz[s_] - R + HALF) / ST)); j1 = min(N, int((cz[s_] + R + HALF) / ST) + 1)
        dx = WX[j0:j1, i0:i1] - cx[s_]; dz = WZ[j0:j1, i0:i1] - cz[s_]
        u_ = dx * math.cos(rot[s_]) + dz * math.sin(rot[s_]); v_ = -dx * math.sin(rot[s_]) + dz * math.cos(rot[s_])
        d = 0.5 * np.maximum(np.abs(u_), np.abs(v_)) + 0.5 * np.hypot(u_, v_) * 0.86
        f1 = F1[j0:j1, i0:i1]; id1 = ID[j0:j1, i0:i1]; g1 = G1[j0:j1, i0:i1]; f2o = F2o[j0:j1, i0:i1]; f2a = F2a[j0:j1, i0:i1]
        g = grp[s_]
        better = d < f1
        # the old best moves down: to F2a always, to F2o when it was another massif's
        f2a[:] = np.where(better, f1, np.minimum(f2a, d))
        f2o[:] = np.where(better & (g1 != g), np.minimum(f1, f2o), np.where(~better & (g1 != g), np.minimum(f2o, d), f2o))
        f1[:] = np.where(better, d, f1); id1[:] = np.where(better, s_, id1); g1[:] = np.where(better, g, g1)
    has = ID >= 0
    idc = np.where(has, ID, 0)
    e_gorge = (F2o - F1) / 2                                 # ≈ distance to the massif's edge
    e_cleft = (F2a - F1) / 2                                 # ≈ distance to the next column of the same massif
    e_reach = (np.minimum(1.0 * nn[idc] + 6, 75) - F1)       # a tower reaches only so far from its tip
    e = np.where(has, np.minimum(e_gorge, e_reach), -50)
    T = hp[idc]                                              # each column its own top (stepped tops in a massif)
    # per-massif profile: gorge half width, ledge height / width
    gw = 4.0 + 3.0 * (vnoise(X, Z, 70, 45) * 0.5 + 0.5)   # gorge half width 4–7 m: broad towers, narrow slots
    hs = np.random.default_rng(46).uniform(0, 1, ns); ls = np.random.default_rng(47).uniform(0, 1, ns)
    ms2 = np.random.default_rng(51).uniform(0, 1, ns)
    f1 = (0.22 + 0.22 * hs)[idc]                             # TWO treed ledges: at 22–44 % and 55–78 % of the height
    f2 = (0.55 + 0.23 * ms2)[idc]
    w1 = np.where(ls[idc] < 0.12, 0.0, 2.5 + 4 * ls[idc])    # 2.5–6.5 m wide (a few towers go up sheer)
    w2 = np.where(ms2[idc] < 0.3, 0.0, 2 + 3 * ms2[idc])
    ee = e - gw
    b1 = sstep(0.0, 2.5, ee)                                 # the lower block: sheer
    b2 = sstep(2.5 + w1, 5.0 + w1, ee)                       # the middle one, set back by the first ledge
    b3 = sstep(5.0 + w1 + w2, 7.5 + w1 + w2, ee)             # the top one
    crown = 6 * sstep(7.5 + w1 + w2, 30 + w1 + w2, ee) + 3 * vnoise(X, Z, 11, 48)   # a rounded, forested crown
    tower = T * (f1 * b1 + (f2 - f1) * b2 + (1 - f2) * b3) + crown * b3
    upper = b3
    # fused columns: a cleft 2–4 m wide, a fifth to a third of the shorter column deep
    cleft = sstep(3.5, 0.5, e_cleft) * (0.2 + 0.15 * (vnoise(X, Z, 50, 49) * 0.5 + 0.5)) * T * upper
    tower = np.maximum(0, tower - cleft)
    # the gorge floors: forested talus rising to the walls (a V between the towers)
    talus_t = (14 + 8 * vnoise(X, Z, 60, 50)) * sstep(-gw - 4, 0.5, ee) * has
    towers = np.where(has, tower, 0) + talus_t
    print('tower relief max', round(float(towers.max())))

ms = mesa_soft + 0.2 * vnoise(X, Z, 46, 7) + 0.08 * vnoise(X, Z, 13, 8)
cliff = sstep(0.47, 0.53, ms)
talus = 30 * sstep(0.12, 0.47, ms)                       # scree and wooded slopes at the cliff foot
riv_clear = sstep(4, 22, d_riv - half_w)                 # (the towers stand back from the water)
BASE = floor + (towers * riv_clear if TERRAIN == '0' else 0)
BASE = np.maximum(BASE, np.minimum(table * cliff + BASE * (1 - cliff), table)) + talus * (1 - cliff)
BASE = np.where(d_riv < half_w + 2, floor, BASE)          # (a river runs past a mesa: the water wins)
if TERRAIN != '0':
    BASE = np.load(os.path.join(TERRAIN, 'terrain.npy')).astype(np.float64)
    floor = np.load(os.path.join(TERRAIN, 'floor.npy')).astype(np.float64)
    assert BASE.shape == (N, N), f'terrain.npy is {BASE.shape}, the map grid {N}² — run terrain.py with the same HALF'
    # HILLS (2026-10-23, the user: "reduce the height of each hill to 30 % of what it is now"): every hill's rise over
    # its valley floor × HILLS — the eroded shapes (walls, gullies, ledges, talus) kept, the valleys and rivers where
    # they were; the roads below are routed and graded on the lower relief
    HILLS = float(ARGS.get('HILLS', 0.3))
    BASE = floor + np.maximum(BASE - floor, 0) * HILLS + np.minimum(BASE - floor, 0)
    cx = cz = np.zeros(0); r_p = np.zeros(0)
else:
    r_p = np.clip(0.5 * nn, 12, 40)                      # (for the debug render and the road router)
print('base relief', round(float(BASE.min()), 1), '…', round(float(BASE.max()), 1), 'mesa share', round(float((cliff > 0.5).mean()), 3))

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
def stamp(H_, px, pz, pr, ptop):
    """The heights WITH the columns (debug renders only: the game draws them as meshes) — a tapering spire each."""
    Hc = H_.copy()
    for x0, z0, r, top in zip(px, pz, pr, ptop):
        i0 = max(0, int((x0 - r * 1.2 + HALF) / ST)); i1 = min(N, int((x0 + r * 1.2 + HALF) / ST) + 2)
        j0 = max(0, int((z0 - r * 1.2 + HALF) / ST)); j1 = min(N, int((z0 + r * 1.2 + HALF) / ST) + 2)
        d = np.hypot(X[j0:j1, i0:i1] - x0, Z[j0:j1, i0:i1] - z0) / r
        Hc[j0:j1, i0:i1] = np.maximum(Hc[j0:j1, i0:i1], np.where(d < 1.0, top - (top - Hc[j0:j1, i0:i1]) * 0.35 * d ** 3, -1e9))
    return Hc
def oblique(Hc):
    """Re-render the relief the way the reference was drawn (from the south, faces KT px per grey, MV m per px, a
    height tint + light) — for a side-by-side with ref/heightmap_original.png at half its size."""
    Wo = int(round((C1X - C0X) / S / 2)); Ho = 1024; nz = 1100
    ii = np.clip((np.arange(Wo) + 0.5) / Wo * (N - 1), 0, N - 1).astype(int)
    jj = np.clip((np.arange(nz) + 0.5) / nz * (N - 1), 0, N - 1).astype(int)
    gz, gx = np.gradient(Hc, ST)
    nrm = np.stack([-gx, np.ones_like(Hc), -gz], 2); nrm /= np.linalg.norm(nrm, axis=2, keepdims=True)
    L_ = np.array([-0.35, 0.6, 0.72]); L_ /= np.linalg.norm(L_)
    tint = np.clip(0.36 + (Hc - 8) / (KT * MV * TS), 0.08, 1.0)
    shade = np.where(Hc < WATER, 0.1, tint * (0.55 + 0.45 * np.clip(nrm @ L_, 0, 1)))
    img = np.full((Ho, Wo), 0.08); ybuf = np.full(Wo, Ho, float)
    rows = np.arange(Ho)[:, None]
    for j in jj[::-1]:                                    # front (south) to back
        v = (C0Y + (xs[j] + HALF) / (2 * HALF) * (C1Y - C0Y)) / S / 2 - (Hc[j, ii] - 8) / (MV * TS) / 2
        m = (rows >= v[None]) & (rows < ybuf[None])
        img = np.where(m, shade[j, ii][None], img)
        ybuf = np.minimum(ybuf, v)
    return img
if DEBUG:
    save_png(os.path.join(DEBUG, '2_base.png'), dots(grid_lines(hshade(BASE)), cx, cz, [0.85, 0.2, 0.2], 2)[::2, ::2])
    ob = oblique(BASE)
    ref = G[::2, ::2][:, int(C0X / 2):int(C0X / 2) + ob.shape[1]]
    save_png(os.path.join(DEBUG, '2_oblique.png'), np.concatenate([ref[:ob.shape[0]], ob], 1), 0, 1)
if STAGE <= 2: sys.exit(0)

# ---------------------------------------------------------------- 3. roads (the atlas's routes, cut into the relief)
# The valleys between the tables and the spire massifs don't all connect (as in the render: gorges end in walls), so a
# grade-limited router either detours for kilometres or climbs the massifs. Instead each route is found as the LOWEST
# CORRIDOR between its waypoints (A*, cost ∝ height above the valley floor, the spires and the water dear), then cut in:
# its profile is the ground's lower envelope at a drivable grade (cuts only, never fills), and the ground round it
# is lowered to it with steep walls — where a route crosses a massif it runs in a slot gorge, Zhangjiajie-style.
RC = 8.0                                    # corridor grid (m)
idx = np.arange(0, N, int(RC / ST)); nr = len(idx); xr = xs[idx]
def cell(x, z): return int(round((z + HALF) / RC)), int(round((x + HALF) / RC))
HR = minf(BASE, 3)[np.ix_(idx, idx)]         # (the lowest ground round each corridor cell: the gorges between the
WR = BASE[np.ix_(idx, idx)] < WATER + 0.6     # towers are 10–20 m wide, a point sample on an 8 m grid misses them)
ABOVE = np.maximum(0, HR - floor[np.ix_(idx, idx)])
PIL = np.zeros((nr, nr), bool)              # (the towers are terrain: their height above the floor keeps the routes out)
EDGE = np.minimum.outer(np.minimum(np.arange(nr), nr - 1 - np.arange(nr)), np.minimum(np.arange(nr), nr - 1 - np.arange(nr))) * RC
USED = np.zeros((nr, nr))
CC = 1 + 0.06 * ABOVE + 0.0004 * ABOVE ** 2 + 14 * PIL + 25 * WR + 10 * sstep(170, 50, EDGE) + 40 * (cliff[np.ix_(idx, idx)] > 0.3)   # (never through a table)
D8 = [(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0), (1, 1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (-1, -1, 1.414),
      (2, 1, 2.236), (1, 2, 2.236), (-2, 1, 2.236), (-1, 2, 2.236), (2, -1, 2.236), (1, -2, 2.236), (-2, -1, 2.236), (-1, -2, 2.236)]
def corridor(a, b):
    sj, si = cell(*a); gj, gi = cell(*b)
    best = {(sj, si): 0.0}; came = {}; hq = [(0.0, sj, si)]
    while hq:
        f, j, i = heapq.heappop(hq)
        if (j, i) == (gj, gi): break
        c0 = best[(j, i)]
        if f - math.hypot(j - gj, i - gi) * RC > c0 + 1e-6: continue
        for dj, di, L in D8:
            nj, ni = j + dj, i + di
            if nj < 1 or ni < 1 or nj >= nr - 1 or ni >= nr - 1: continue
            nc = c0 + L * RC * (0.5 * (CC[j, i] + CC[nj, ni]) + 10 * USED[nj, ni])
            if nc < best.get((nj, ni), 1e18):
                best[(nj, ni)] = nc; came[(nj, ni)] = (j, i)
                heapq.heappush(hq, (nc + math.hypot(nj - gj, ni - gi) * RC, nj, ni))
    path = [(gj, gi)]
    while path[-1] in came: path.append(came[path[-1]])
    path.reverse()
    return [(xr[i], xr[j]) for j, i in path]

# THE ATLAS'S ROUTES: the scenic loop round the map inside its ring of tables (the green start at the south), the
# valley road up the main river, a cross road west → east through the middle. Waypoints snap to the best open, low,
# dry ground within SNAP m (off the spires, out of the water).
SNAP = 130.0 * HALF / 1200
def snap(p):
    j, i = cell(*p); k = int(SNAP / RC)
    j0, j1, i0, i1 = max(3, j - k), min(nr - 3, j + k + 1), max(3, i - k), min(nr - 3, i + k + 1)
    jj_, ii_ = np.mgrid[j0:j1, i0:i1]
    d = np.hypot(jj_ - j, ii_ - i) * RC
    c = ABOVE[j0:j1, i0:i1] * 2 + PIL[j0:j1, i0:i1] * 400 + WR[j0:j1, i0:i1] * 400 + (d > SNAP) * 1e6 + d * 0.15
    m = np.unravel_index(np.argmin(c), c.shape)
    return float(xr[ii_[m]]), float(xr[jj_[m]])
NODES0 = {
    'base': (-100, 1080), 'w': (-900, 370), 'nw': (-860, -420), 'n': (-240, -800), 'ne': (430, -750),
    'e': (830, -260), 'e2': (870, 370), 'se': (450, 850),
    'centre': (40, -10), 'w_cross': (-490, 270), 'river_n': (-270, -430), 'river_s': (-400, 600),
}
NODES = {k: snap((v[0] * HALF / 1200, v[1] * HALF / 1200)) for k, v in NODES0.items()}
ROUTES = [  # name, class, half width, nodes, closed, grade
    ('scenic_loop', 'highway', 5.0, ['base', 'w', 'nw', 'n', 'e', 'e2', 'se', 'base'], True, 0.09),
    ('valley_road', 'track', 4.5, ['base', 'river_s', 'river_n', 'n'], False, 0.11),
    ('cross_road', 'track', 4.5, ['w', 'w_cross', 'centre', 'e'], False, 0.11),
]
roads = []; CUT = BASE.copy()
for name, cls, hw, nodes, closed, gmax in ROUTES:
    pts = []
    for a, b in zip(nodes[:-1], nodes[1:]):
        leg = corridor(NODES[a], NODES[b])
        ll = float(np.sum(np.hypot(*np.diff(np.array(leg), axis=0).T)))
        print(f'  leg {a} → {b}: {ll:.0f} m (straight {math.dist(NODES[a], NODES[b]):.0f})')
        if ARGS.get('DBGLEG') == f'{a}-{b}': print('   raw', [(round(x), round(z)) for x, z in leg[::3]])
        pts.extend(leg if not pts else leg[1:])
    for x, z in pts:                         # (the next routes cross this one, they don't run along it)
        j, i = cell(x, z); USED[max(0, j - 4):j + 5, max(0, i - 4):i + 5] = 1
    # SPURS: where a leg runs out to its waypoint and back the same way (a waypoint snapped beside the corridor), cut
    # the out-and-back; then relax the centreline (Laplacian, ends fixed) — bends of a road, not grid corners
    q_ = resample(pts, 8.0)
    k = 0
    while k < len(q_):
        w_ = q_[k + 8:k + 80]                         # (an out-and-back is short: ≤ ~600 m of path)
        far_ = np.nonzero(np.hypot(w_[:, 0] - q_[k, 0], w_[:, 1] - q_[k, 1]) < 24)[0]
        if len(far_): q_ = np.vstack([q_[:k + 1], q_[k + 8 + far_[-1]:]])
        k += 1
    # (anchored to the corridor — it drifted into a table and along into the river — and never into water or a
    # table the corridor kept out of)
    o_ = q_.copy()
    def blocked(q):                            # water, a table, a tower (> 25 m above the valley floor)
        return (hsample(q[:, 0], q[:, 1], BASE) < WATER + 1.0) | (hsample(q[:, 0], q[:, 1], cliff) > 0.3) \
            | (hsample(q[:, 0], q[:, 1], BASE) - hsample(q[:, 0], q[:, 1], floor) > 25)
    bad0 = blocked(o_)
    bad0 = np.convolve(bad0.astype(float), np.ones(13), 'same') > 0      # (a crossing may slide a little along)
    for _ in range(int(ARGS.get('RELAX', 60))):
        r_ = q_.copy()
        if closed: r_ = 0.5 * q_ + 0.25 * (np.roll(q_, 1, 0) + np.roll(q_, -1, 0))
        else: r_[1:-1] = 0.5 * q_[1:-1] + 0.25 * (q_[:-2] + q_[2:])
        bad = blocked(r_) & ~bad0
        a_ = np.where(bad, 0.5, 0.03)[:, None]
        q_ = r_ * (1 - a_) + o_ * a_
    # an open route's ends sit ON the roads before it (a junction, not a dead end beside the loop): the stretch it
    # shares with one at either end is trimmed (it leaves that road where it last runs in its bed) and the end
    # moved onto it
    if not closed and roads:
        prev = np.concatenate([np.stack([r2['x'], r2['z']], 1) for r2 in roads])
        dprev = np.sqrt(((q_[:, None, :] - prev[None]) ** 2).sum(-1)).min(1)
        on = np.nonzero(dprev[:len(q_) // 3] < hw + 8)[0]
        if len(on): q_ = q_[on[-1]:]; dprev = dprev[on[-1]:]
        on = np.nonzero(dprev[-(len(q_) // 3):] < hw + 8)[0]
        if len(on): q_ = q_[:len(q_) - len(q_) // 3 + on[0] + 1]
        for e_ in (0, -1):
            dd_ = np.hypot(prev[:, 0] - q_[e_, 0], prev[:, 1] - q_[e_, 1])
            if dd_.min() < 60: q_[e_] = prev[int(np.argmin(dd_))]
    p = resample(q_, 4.0)
    if closed and np.hypot(*(p[0] - p[-1])) < 8: p = p[:-1]
    # the profile: the ground's lower envelope at ≤ gmax (water: deck height), lightly smoothed
    g0 = np.convolve(np.pad(hsample(p[:, 0], p[:, 1], BASE), 3, mode='edge'), np.ones(7) / 7, 'valid')
    wv = (hsample(p[:, 0], p[:, 1], BASE) < WATER + 0.8)
    y = np.where(wv, WATER + 2.5, np.maximum(g0, WATER + 0.9))
    n_ = len(y)
    if closed: y = np.tile(y, 3)                     # (a loop: the envelope wraps round — no step where it closes)
    for _ in range(2):
        for k in range(1, len(y)): y[k] = min(y[k], y[k - 1] + gmax * 4.0)
        for k in range(len(y) - 2, -1, -1): y[k] = min(y[k], y[k + 1] + gmax * 4.0)
    if closed: y = y[n_:2 * n_]
    y = np.maximum(y, np.where(wv, WATER + 2.5, WATER + 0.9))
    br = np.zeros(len(p), int)
    k = 0
    while k < len(p):   # BRIDGES (the Highlands'): runs over water decked level from bank top to bank top
        if wv[k]:
            a = k
            while k < len(p) and wv[k]: k += 1
            L_ = max(0, a - 1); R_ = min(len(p) - 1, k)
            y0 = max(y[L_], y[R_], WATER + 2.5)
            y[L_:R_ + 1] = y0
            br[L_:R_ + 1] = 1
            k = R_ + 1
        else:
            k += 1
    for _ in range(2):   # (the decks lifted to their banks: ramp the approaches down at the grade — fills)
        for k in range(1, len(y)): y[k] = max(y[k], y[k - 1] - gmax * 4.0)
        for k in range(len(y) - 2, -1, -1): y[k] = max(y[k], y[k + 1] - gmax * 4.0)
    # where it meets or runs beside an earlier road: that road's height (a junction is one surface — two profiles
    # cut separately disagreed by metres there), ramped in and out at the grade
    if roads:
        prev = np.concatenate([np.stack([r_['x'], r_['z'], np.array(r_['h']) + OFF], 1) for r_ in roads])
        d2 = (p[:, None, 0] - prev[None, :, 0]) ** 2 + (p[:, None, 1] - prev[None, :, 1]) ** 2
        kmin = d2.argmin(1); near = np.sqrt(d2[np.arange(len(p)), kmin]) < hw + 9
        fix = prev[kmin, 2]
        y = np.where(near, fix, y)
        for _ in range(4):
            for k in range(1, len(y)):
                if not near[k]: y[k] = min(max(y[k], y[k - 1] - gmax * 4.0), y[k - 1] + gmax * 4.0)
            for k in range(len(y) - 2, -1, -1):
                if not near[k]: y[k] = min(max(y[k], y[k + 1] - gmax * 4.0), y[k + 1] + gmax * 4.0)
    # cut the bed: flat across the road + a shoulder, then walls 6:1 up to the ground
    for (x0, z0), y0, b0 in zip(p, y, br):
        if b0: continue
        R = hw + 3 + 45
        i0 = max(0, int((x0 - R + HALF) / ST)); i1 = min(N, int((x0 + R + HALF) / ST) + 2)
        j0 = max(0, int((z0 - R + HALF) / ST)); j1 = min(N, int((z0 + R + HALF) / ST) + 2)
        d = np.hypot(X[j0:j1, i0:i1] - x0, Z[j0:j1, i0:i1] - z0)
        CUT[j0:j1, i0:i1] = np.minimum(CUT[j0:j1, i0:i1], y0 - 0.1 + np.maximum(0, d - hw - 3) * 6.0)   # (6:1 — a tower's wall)
    roads.append({'name': name, 'class': cls, 'halfWidth': hw, 'closed': closed, 'x': [round(float(v), 2) for v in p[:, 0]],
                  'z': [round(float(v), 2) for v in p[:, 1]], 'h': [round(float(v - OFF), 2) for v in y], 'bridge': [int(b) for b in br]})
    gr_max = float(np.max(np.abs(np.diff(y)) / 4.0))
    deep = np.nonzero(g0 - y > 30)[0]
    if len(deep):
        runs = np.split(deep, np.nonzero(np.diff(deep) > 1)[0] + 1)
        for r_ in runs: print(f'    cut {len(r_) * 4} m long, {float(np.max(g0[r_] - y[r_])):.0f} m deep at ({p[r_[len(r_) // 2], 0]:.0f}, {p[r_[len(r_) // 2], 1]:.0f})')
    print(f'road {name}: {len(p) * 4} m, {sum(br)} bridge samples, max grade {gr_max:.2f}, deepest cut {float(np.max(g0 - y)):.0f} m')
cut_depth = BASE - CUT
BASE = np.where(d_riv < half_w + 2, BASE, CUT)   # (the rivers keep their beds)
print('road cuts: cells', int((cut_depth > 1).sum()), 'deepest', round(float(cut_depth.max())))

def draw_roads(col):
    for r_ in roads:
        c = [0.95, 0.75, 0.1] if r_['class'] == 'highway' else [1, 1, 1] if r_['class'] == 'track' else [0.9, 0.3, 0.9]
        dots(col, r_['x'], r_['z'], c, 2)
    return col
if DEBUG:
    hh_ = np.clip((BASE - WATER) / 120, 0, 1)
    hyp = np.stack([0.2 + 0.8 * hh_, 0.55 + 0.25 * hh_ - 0.5 * hh_ ** 2 + 0.2 * (hh_ > 0.9), 0.25 + 0.2 * hh_], 2)
    hyp *= (0.75 + 0.25 * np.clip(hshade(BASE)[..., 1:2], 0, 1))
    hyp[BASE < WATER] = [0.15, 0.45, 0.85]
    cont = (np.floor((BASE - WATER) / 20) != np.floor((np.roll(BASE, 1, 0) - WATER) / 20)) | (np.floor((BASE - WATER) / 20) != np.floor((np.roll(BASE, 1, 1) - WATER) / 20))
    hyp[cont] *= 0.6
    save_png(os.path.join(DEBUG, '3_hyp.png'), dots(grid_lines(hyp), cx, cz, [0.9, 0.1, 0.9], 1)[::2, ::2])
    save_png(os.path.join(DEBUG, '3_roads.png'), draw_roads(dots(grid_lines(hyp), cx, cz, [0.85, 0.2, 0.2], 1))[::2, ::2])
if STAGE <= 3: sys.exit(0)

# ---------------------------------------------------------------- 4. finish the relief
def road_dist(x, z):
    d = np.full(np.shape(x), np.inf)
    for r_ in roads:
        px_ = np.array(r_['x'])[::2]; pz_ = np.array(r_['z'])[::2]
        for a in range(len(px_) - 1):
            d = np.minimum(d, seg_dist(x, z, px_[a], pz_[a], px_[a + 1], pz_[a + 1]))
    return d
H = BASE.copy()
# the mesa rims break up: the cliff faces fluted and notched (the tables keep their tops)
rim = sstep(0.0, 0.5, cliff) * sstep(1.0, 0.6, cliff)
H -= rim * 14 * np.clip(vnoise(X, Z, 9, 31) + 0.4 * vnoise(X, Z, 4, 32), 0, 1)
H = np.where(d_riv < half_w + 1, np.minimum(H, BASE), H)    # (the water stays clear)
print('relief', round(float(H.min()), 1), '…', round(float(H.max()), 1))
if DEBUG:
    ob = oblique(H)
    ref = G[::2, ::2][:, int(C0X / 2):int(C0X / 2) + ob.shape[1]]
    save_png(os.path.join(DEBUG, '4_oblique.png'), np.concatenate([ref[:ob.shape[0]], ob], 1), 0, 1)
if STAGE <= 4: sys.exit(0)
# ---------------------------------------------------------------- 5. props
gz, gx = np.gradient(H, ST)
slope = np.hypot(gx, gz)
# trees on every gentle surface: the valley floors (groves), the talus, the ledges and the pillar / mesa tops
grove = vnoise(X, Z, 70, 21) * 0.55 + vnoise(X, Z, 22, 22) * 0.45
high = sstep(30, 70, H - floor)                         # up on a pillar / mesa: the green caps of the concept
# (the massifs' flanks too — in the atlas everything but bare rock is forest — but not the cliffs: up to ~45°)
forest = np.clip(1.0 + 0.45 * grove + 0.35 * high, 0, 1) * sstep(1.15, 0.7, slope) * (H > WATER + 1.0)
CELL = 6
cand = rng.uniform(0, 1, (N // CELL, N // CELL))
TI, TJ = np.meshgrid(np.arange(0, N - CELL, CELL), np.arange(0, N - CELL, CELL))
TI = TI + rng.integers(0, CELL, TI.shape); TJ = TJ + rng.integers(0, CELL, TJ.shape)
# (was 0.8, a closed canopy; 2026-10-23 the user: "too many trees — reduce them": the lower hills left ~45 % more gentle
#  ground to plant, every one a full pine near the player, a shade image and a server collider — ~ −37 %)
keep = cand[:TJ.shape[0], :TJ.shape[1]] < forest[TJ, TI] * float(ARGS.get('TREES', 0.5))
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
x, z, yaw = clear_spot('base', 16, 1, 10); put('flag', x + 8, z + 4, 0, 1)   # (no cabins: their painted box read as a green crate here)
camp('base', -1); camp('w', 1); camp('se', -1)
# VIEWPOINTS (the atlas's red dots): lookouts by the loop where it opens onto the spires, signposts at the junctions
for node in ('n', 'ne'):
    vx, vz, _ = clear_spot(node, 16, -1, 10); put('water_tower', vx, vz, 0.4, 1.2); put('flag', vx + 4, vz + 3, 0, 1)
for node in ('centre', 'n', 'w', 'e', 'river_s', 'river_n', 'se'):
    x, z, yaw = near_road_spot(node, 7, 1); put('signpost', x, z, yaw, 1)

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
            # the ATLAS's colour theme (its swatches: vegetation 2a4e35 446c41 678859 89a772, rock 5d544c 827465 a49580
            # cdbca5, water 205f7b 3a84a6 5ea8c8, sky 4e7295 7ea8d1 b3d0e9 e0eefa): lush mid-green forest and meadow,
            # mossy green talus (`rock` = the ground on slopes), grey-tan sandstone walls (`cliff`), blue water, a soft
            # blue sky over a pale blue-white haze
            # the PHOTOS' colour theme (2026-10-23, after the user's in-game look check): warm grey-beige sandstone with
            # rust and wet streaks (the shader's natural stone), deep jade / emerald forest, mossy green talus, a pale
            # hazy blue sky, jade-blue water; a neutral sun with a cool pale fill and soft shading (`light`)
            'palette': {'grass': '3d6436', 'grassDark': '22422a', 'flowers': '567a3e', 'dirt': '857563', 'rock': '34522e',
                        'cliff': 'b8b1a6', 'stone': '74706a', 'cliffMoss': '2a4e35', 'sand': 'b3a58e', 'water': '3d7f8a', 'waterDeep': '1f5562',
                        'skyZenith': '86a8c8', 'skyHaze': 'd2dee8', 'leafLight': '7fae4a', 'leafMid': '3f8a3a', 'leafDark': '143a1e'},
            'light': {'sun': 'fff4e4', 'fill': 'b4c8dc', 'bounce': '4e5e44', 'tint': 'f6f8fa', 'toon': 0.3, 'split': 0.08, 'saturation': 0.95},
            # Zhangjiajie's trees (2026-10-23, the user: "remove all trees and use the pine trees, a bit darker; images
            # as shadows and for far trees; optimize it"): the TIERED PINES only (`conifer`, the Highlands' — its broad
            # twisted pines and broadleaves were the frame cost), their leaves ~25 % darker than the default (palette
            # leafLight / Mid / Dark; default a8e063 5dbb4a 1b4a26), shading the ground with IMAGES on every tier and
            # never in the sun shadow map (`imageTreeShadows`); far trees are impostor images (every map). The forest
            # floor (little grass), the cloud SHEETS in the gorges (MistSheets: height, density — lowered with the
            # hills) over a light height haze, the distance layers (`aerial`), a finer horizon
            # (then: "make the pine tree like this", the Autumn Pine sheet — the conifer slots grow the Blender
            #  autumn pines, scripts/blender/autumn_pine.py: green, one in five golden-orange; LOD0 382 tris)
            'trees': 'conifer', 'pines': 'autumn', 'climate': 'subtropical', 'imageTreeShadows': True, 'grass': 0.3, 'mist': [0.0015, 25.0, 0.04], 'mistSheets': [[32, 0.6], [46, 0.42], [62, 0.26]],
            'horizonRes': 160, 'crags': True, 'cragScale': 0.75, 'rocks': 6, 'bigRocks': 0.06, 'naturalStone': True, 'peakLod': True, 'cliffMoss': 0.38, 'treeLine': 1000, 'aerial': [200, 2600, 0.45],
            'roads': roads, 'bridges': []}
    json.dump(meta, open(os.path.join(OUT, 'map.json'), 'w'))
    json.dump({'chunkSize': 200.0, 'half': HALF, 'stride': 5, 'types': {}, 'placements': placements, 'features': {}, 'clay': []},
              open(os.path.join(OUT, 'props.json'), 'w'))
    print('wrote', OUT, 'heights', round(lo + OFF, 1), '…', round(hi + OFF, 1), 'water share', round(float((H < WATER).mean()), 3))
