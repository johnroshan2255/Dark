# THE ISLAND — desert rebuild (2026-10-21). Runs inside Blender (numpy) through the MCP socket:
#   node scripts/blender/bl.mjs scripts/blender/island/desert.py ORIG=<dir> MAP=public/maps/island \
#        ROUTES=scripts/blender/island/desert_routes.json [WRITE=1] [OUTH=<preview heights .bin>]
# ORIG = the map as The-Land exported it (before this rebuild: `git show 695a1f4:public/maps/island/<file>` for
# heights.bin, map.json, props.json, biome.bin). It always starts from those, so it can be re-run while tuning
# (deterministic: fixed seeds). Without WRITE it only reports (and writes OUTH + OUTH.roads.json for the previews:
# render_preview.py = a 3D Eevee view, topdown.py = a hillshaded map, preview_composite.py = the map card).
#
#   * irregular layered-sandstone MESAS (stepped cliffs: ledges + sheer risers, talus aprons, a higher cap tier)
#     instead of the four perfect cylinder mesas, BUTTES, rolling sand HILLS and DUNES on the floor, the Dune Dome
#   * new roads (desert_routes.json): dune_dome_switchbacks (a hill road up the Dune Dome), mesa_cliff_road (a shelf
#     cut into the Grand Mesa's cliff, from mesa_trail round its south-west face onto the top and across it) and
#     canyon_road (through the East mesa's slot canyon, mesa_trail → desert_edge)
#   * every road (old and new) is cut / filled through the new relief (sand banks under the crag slope; the cliff and
#     canyon roads sheer); camps, the stunt park and the race tracks keep their ground; set pieces are re-seated on
#     the new ground (props.json y)
import json, os, math
import numpy as np

ORIG = globals()['ORIG']; MAP = globals()['MAP']; WRITE = globals().get('WRITE', '0') == '1'
meta = json.load(open(os.path.join(ORIG, 'map.json')))
props = json.load(open(os.path.join(ORIG, 'props.json')))
g = meta['grid']; N = g['n']; ST = g['step']; OFF = meta['heightOffset']
H0 = np.fromfile(os.path.join(ORIG, 'heights.bin'), dtype='<u2').reshape(N, N).astype(np.float64) / 65535 * g['range'] + g['min'] + OFF
bg = meta['biomeGrid']; BN = bg['n']
BIO = np.fromfile(os.path.join(ORIG, 'biome.bin'), dtype=np.uint8).reshape(BN, BN, 2).astype(np.float64) / 255
xs = -1200 + np.arange(N) * ST
X, Z = np.meshgrid(xs, xs)  # X[j, i] = x_i, Z[j, i] = z_j

def blur(a, r):
    """Box blur ×3 (≈ gaussian), radius r cells."""
    if r < 1: return a
    out = a
    for _ in range(3):
        c = np.cumsum(np.pad(out, ((0, 0), (r + 1, r)), mode='edge'), axis=1)
        out = (c[:, 2 * r + 1:] - c[:, :-2 * r - 1]) / (2 * r + 1)
        c = np.cumsum(np.pad(out, ((r + 1, r), (0, 0)), mode='edge'), axis=0)
        out = (c[2 * r + 1:, :] - c[:-2 * r - 1, :]) / (2 * r + 1)
    return out

def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)

def vnoise(x, z, scale, seed):
    """Smooth value noise in −1..1 (lattice from a fixed seed)."""
    rng = np.random.default_rng(seed)
    m = int(2600 / scale) + 4
    lat = rng.uniform(-1, 1, (m, m))
    u = (x + 1300) / scale; v = (z + 1300) / scale
    i = np.floor(u).astype(int); j = np.floor(v).astype(int)
    fu = u - i; fv = v - j
    fu = fu * fu * fu * (fu * (fu * 6 - 15) + 10); fv = fv * fv * fv * (fv * (fv * 6 - 15) + 10)
    i = np.clip(i, 0, m - 2); j = np.clip(j, 0, m - 2)
    a = lat[j, i]; b = lat[j, i + 1]; c = lat[j + 1, i]; d = lat[j + 1, i + 1]
    return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv

def fbm(x, z, scale, seed, oct=4):
    s = 0; amp = 1; tot = 0
    for o in range(oct):
        s = s + amp * vnoise(x, z, scale / 2 ** o, seed + o * 17)
        tot += amp; amp *= 0.5
    return s / tot

# ---------------------------------------------------------------- region
D = np.repeat(np.repeat(BIO[:, :, 0], 2, axis=0), 2, axis=1)[:N, :N]
D = blur(D, 6)
border = np.minimum(1200 - np.abs(X), 1200 - np.abs(Z))
# The desert quadrant only (the beach is desert biome too — leave it), away from the map's edge cliffs.
WD = sstep(0.35, 0.8, D) * sstep(-140, -60, -Z) * sstep(-160, -60, X) * sstep(6, 40, border)

# ---------------------------------------------------------------- floor (old mesas removed)
old_mesa = (H0 > 66) & (X > 250) & (Z < -150)
w = (1.0 - old_mesa) * (H0 > 5)
FLOOR = blur(H0 * w, 30) / np.maximum(blur(w, 30), 1e-3)
FLOOR = np.where(old_mesa, FLOOR, blur(H0, 6))
FLOOR = blur(FLOOR, 8)

# rolling hills + dunes (wind from the west-north-west: crests run NNE)
hills = np.maximum(0, fbm(X, Z, 330, 11) + 0.12) * 34 + np.maximum(0, fbm(X, Z, 150, 13)) * 12 + fbm(X, Z, 90, 23) * 3
wx, wz = 0.92, 0.38
along = X * wx + Z * wz; across = -X * wz + Z * wx
dn = vnoise(along * 0.35, across, 70, 31)  # stretched across the wind
dunes = (1 - np.abs(dn)) ** 2.2 * 7 * (0.4 + 0.6 * np.maximum(0, fbm(X, Z, 300, 37)))
RELIEF = FLOOR + hills + dunes

# ---------------------------------------------------------------- mesas / buttes
def mesa(cx, cz, R, top, seed, k=3, band=30, aspect=1.0, rot=0.0, irr=0.16, talus=0.14, dome=4.0):
    """Height field of one layered mesa (−inf outside its reach)."""
    c, s = math.cos(rot), math.sin(rot)
    dx = X - cx; dz = Z - cz
    lx = (dx * c + dz * s) / aspect; lz = -dx * s + dz * c
    th = np.arctan2(lz, lx)
    rng = np.random.default_rng(seed)
    r = np.ones_like(th)
    for kk, a in ((2, irr), (3, irr * 0.7), (5, irr * 0.45), (8, irr * 0.25), (13, irr * 0.12)):
        r = r + a * np.sin(kk * th + rng.uniform(0, 6.283))
    dist = np.hypot(lx, lz) + fbm(X, Z, 45, seed + 5, 3) * 9  # ragged rim
    e = dist - R * r  # m outside the rim (− = on top)
    base = FLOOR
    Hm = top - base
    # top: a gentle dome + noise
    h_top = top + dome * np.clip(-e / R, 0, 1) ** 0.5 + fbm(X, Z, 70, seed + 9, 3) * 2.5 + np.maximum(0, fbm(X, Z, 140, seed + 13, 3)) * 9 * np.clip(-e / 30, 0, 1)
    # cliff band: k strata, each a flat ledge then a sheer riser
    f = np.clip(e / band, 0, 1) * k
    step = np.floor(np.minimum(f, k - 1e-6)); u = f - step
    drop = (step + sstep(0.38, 0.86, u)) / k
    tal = talus * Hm
    h_cliff = top - drop * (Hm - tal)
    # talus apron beyond the band
    h_apron = base + tal * np.exp(-np.maximum(0, e - band) / (0.5 * band + 6))
    h = np.where(e < 0, h_top, np.where(e < band, h_cliff, h_apron))
    return np.where(e < band + 6 * band, h, -1e9), e

MESAS = [
    # Grand Mesa (NE, the biggest; the cliff road climbs its south face)
    dict(cx=900, cz=-950, R=215, top=118, seed=101, k=3, band=34, aspect=1.25, rot=0.25),
    # North mesa
    dict(cx=560, cz=-1075, R=120, top=96, seed=202, k=3, band=26, aspect=1.6, rot=-0.15),
    # East mesa (split by a canyon below)
    dict(cx=1010, cz=-420, R=150, top=98, seed=303, k=2, band=28, aspect=0.85, rot=0.4),
    # NE corner tower
    dict(cx=1100, cz=-1110, R=60, top=126, seed=404, k=3, band=22),
    # caps: a second, higher tier on the big tops
    dict(cx=975, cz=-1010, R=78, top=138, seed=111, k=2, band=16, aspect=1.3, rot=0.6, talus=0.0, dome=2.0),
    dict(cx=610, cz=-1085, R=44, top=110, seed=222, k=2, band=12, aspect=1.5, rot=-0.1, talus=0.0, dome=1.0),
]
BUTTES = [
    (470, -520, 26, 40, 505), (620, -470, 18, 34, 506), (1100, -640, 30, 42, 507), (560, -870, 22, 38, 508),
    (380, -980, 16, 30, 509), (330, -560, 20, 32, 510), (900, -300, 22, 36, 511), (1110, -230, 26, 44, 512),
    (250, -1100, 24, 36, 513),
]
def rim_xz(m, th, e):
    """World (x, z) of the point at local angle th, e m outside mesa m's rim (no ragged noise)."""
    rng = np.random.default_rng(m['seed']); irr = m.get('irr', 0.16)
    r = 1.0
    for kk, a in ((2, irr), (3, irr * 0.7), (5, irr * 0.45), (8, irr * 0.25), (13, irr * 0.12)):
        r += a * math.sin(kk * th + rng.uniform(0, 6.283))
    rad = m['R'] * r + e
    lx = math.cos(th) * rad * m.get('aspect', 1.0); lz = math.sin(th) * rad
    c, s_ = math.cos(m.get('rot', 0.0)), math.sin(m.get('rot', 0.0))
    return (m['cx'] + lx * c - lz * s_, m['cz'] + lx * s_ + lz * c)

TOWER = np.full_like(X, -1e9)
for m in MESAS:
    h, _ = mesa(**m)
    TOWER = np.maximum(TOWER, h)
for (bx, bz, R, ht, sd) in BUTTES:
    base = float(FLOOR[int((bz + 1200) / 2), int((bx + 1200) / 2)])
    h, _ = mesa(bx, bz, R, base + ht, sd, k=2, band=max(8, R * 0.45), irr=0.22, talus=0.18, dome=1.0)
    TOWER = np.maximum(TOWER, h)

# A slot canyon through the East mesa (NW → SE): the floor runs through between sheer walls.
cx0, cz0, cx1, cz1 = 900, -520, 1120, -330
t = np.clip(((X - cx0) * (cx1 - cx0) + (Z - cz0) * (cz1 - cz0)) / ((cx1 - cx0) ** 2 + (cz1 - cz0) ** 2), 0, 1)
px = cx0 + t * (cx1 - cx0) + np.sin(t * 9) * 14; pz = cz0 + t * (cz1 - cz0) + np.cos(t * 7) * 10
dc = np.hypot(X - px, Z - pz)
canyon = sstep(26, 12, dc)
TOWER = np.where(canyon > 0, TOWER * (1 - canyon) + (RELIEF - 2) * canyon, TOWER)

RELIEF = np.maximum(RELIEF, TOWER)

# ---------------------------------------------------------------- Dune Dome (the switchback hill)
DOME = (205, -505)
dd = np.hypot((X - DOME[0]) / 1.1, Z - DOME[1])
dome_h = 74 * np.exp(-(dd / 125) ** 2.0) + fbm(X, Z, 60, 77, 3) * 3 * sstep(160, 40, dd)
RELIEF = np.maximum(RELIEF, FLOOR + dome_h)

# ---------------------------------------------------------------- protection (camps, stunt park, tracks)
NATURE = {'pine', 'pine_snow', 'oak', 'birch', 'cherry', 'palm', 'rock', 'rock_snow', 'rock_red', 'bush', 'grass_tuft', 'cactus', 'log', 'stump', 'boulder', 'dead_tree'}
DECOR = {'pillar', 'arch', 'signpost', 'b_pole', 'b_bench', 'b_lantern', 'flag', 'ice_block'}
P = np.zeros_like(X)
stride = props['stride']
for tile in props['placements'].values():
    for tp, a in tile.items():
        if tp in NATURE or tp in DECOR: continue
        r0 = {'stunt_loop': 45, 'quarterpipe': 22, 'campfire': 26}.get(tp, 14)
        for o in range(0, len(a), stride):
            x, z = a[o], a[o + 2]
            i, j = int((x + 1200) / 2), int((z + 1200) / 2)
            R = int((r0 + 30) / 2)
            sl = (slice(max(0, j - R), j + R + 1), slice(max(0, i - R), i + R + 1))
            d = np.hypot(X[sl] - x, Z[sl] - z)
            P[sl] = np.maximum(P[sl], sstep(r0 + 30, r0, d))
# closed tracks: inside + 40 m
def inside_poly(px, pz, X, Z):
    res = np.zeros(X.shape, bool)
    n = len(px)
    for k in range(n):
        x1, z1, x2, z2 = px[k], pz[k], px[(k + 1) % n], pz[(k + 1) % n]
        cond = ((z1 > Z) != (z2 > Z)) & (X < (x2 - x1) * (Z - z1) / (z2 - z1 + 1e-12) + x1)
        res ^= cond
    return res
for r in meta['roads']:
    if r['closed'] and r['class'] == 'track':
        ins = inside_poly(r['x'], r['z'], X, Z).astype(np.float64)
        P = np.maximum(P, blur(ins, 8))
P = np.clip(P, 0, 1)

HD = RELIEF * WD + H0 * (1 - WD)
HD = HD * (1 - P) + H0 * P

# ---------------------------------------------------------------- roads
def resample(xp, zp, step):
    xp = np.asarray(xp, float); zp = np.asarray(zp, float)
    seg = np.hypot(np.diff(xp), np.diff(zp)); s = np.concatenate([[0], np.cumsum(seg)])
    L = s[-1]; m = max(2, int(round(L / step)) + 1)
    ss = np.linspace(0, L, m)
    return np.interp(ss, s, xp), np.interp(ss, s, zp), ss

def catmull(pts, per=12):
    """Smooth a waypoint list (x, z) with a centripetal-ish Catmull-Rom (per points per span)."""
    P_ = [pts[0]] + pts + [pts[-1]]
    out = []
    for k in range(1, len(P_) - 2):
        p0, p1, p2, p3 = map(np.array, (P_[k - 1], P_[k], P_[k + 1], P_[k + 2]))
        for t in np.linspace(0, 1, per, endpoint=False):
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(np.array(pts[-1]))
    return [tuple(p) for p in out]

def sample(Hf, x, z):
    gx = np.clip((np.asarray(x) + 1200) / 2, 0, N - 1.001); gz = np.clip((np.asarray(z) + 1200) / 2, 0, N - 1.001)
    i = gx.astype(int); j = gz.astype(int); fx = gx - i; fz = gz - j
    return Hf[j, i] * (1 - fx) * (1 - fz) + Hf[j, i + 1] * fx * (1 - fz) + Hf[j + 1, i] * (1 - fx) * fz + Hf[j + 1, i + 1] * fx * fz

def grade(h, ds, gmax, fixed):
    """Limit the grade to gmax (rise/run) keeping the `fixed` indices: smooth, then forward/back clamp passes."""
    h = h.copy()
    def clamp(h):
        for i, v in fixed.items(): h[i] = v
        for _ in range(30):
            for i in range(1, len(h)):
                if i not in fixed: h[i] = min(max(h[i], h[i - 1] - gmax * ds), h[i - 1] + gmax * ds)
            for i in range(len(h) - 2, -1, -1):
                if i not in fixed: h[i] = min(max(h[i], h[i + 1] - gmax * ds), h[i + 1] + gmax * ds)
        return h
    k = 4
    for _ in range(3):
        h = clamp(h)
        hs = np.convolve(np.pad(h, k, mode='edge'), np.ones(2 * k + 1) / (2 * k + 1), mode='valid')
        h = hs
        for i, v in fixed.items(): h[i] = v
    return clamp(h)

NEW_ROADS = []
EXTRA_PTS = []
def road_from(name, cls, hw, wps, heights=None, gmax=0.11, smooth_win=0):
    """wps: waypoints (x, z); heights: dict waypoint index → height (others follow the relief, graded)."""
    pts = catmull(wps, 14)
    x4, z4, s4 = resample([p[0] for p in pts], [p[1] for p in pts], 4)
    h = sample(HD, x4, z4)
    if smooth_win:
        k = smooth_win
        h = np.convolve(np.pad(h, k, mode='edge'), np.ones(2 * k + 1) / (2 * k + 1), mode='valid')
    fixed = {}
    if heights:
        # waypoint → nearest resampled index
        for wi, hv in heights.items():
            wx_, wz_ = wps[wi]
            idx = int(np.argmin(np.hypot(x4 - wx_, z4 - wz_)))
            fixed[idx] = hv
        # piecewise-linear between fixed points
        ks = sorted(fixed)
        if len(ks) >= 2:
            lin = np.interp(np.arange(len(h)), ks, [fixed[k] for k in ks])
            inner = (np.arange(len(h)) >= ks[0]) & (np.arange(len(h)) <= ks[-1])
            h = np.where(inner, lin, h)
    h = grade(h, 4, gmax, fixed)
    NEW_ROADS.append(dict(name=name, **{'class': cls}, halfWidth=hw, closed=False, x=[round(v, 2) for v in x4], z=[round(v, 2) for v in z4], h=[round(v, 2) for v in h], bridge=[0] * len(x4)))

def road_pt(name, frac=None, near=None):
    r = next(r for r in meta['roads'] if r['name'] == name)
    if near is not None:
        k = int(np.argmin(np.hypot(np.array(r['x']) - near[0], np.array(r['z']) - near[1])))
    else:
        k = int(frac * (len(r['x']) - 1))
    return (r['x'][k], r['z'][k]), r['h'][k]

ROUTES = globals().get('ROUTES')  # json file with the road waypoints (iterated with previews)
if ROUTES and os.path.exists(ROUTES):
    for rd in json.load(open(ROUTES)):
        if 'mesa' in rd:  # a ledge along mesa rd['mesa']'s cliff: angles th0 → th1 (deg), offset e0 → e1 (m)
            mm = MESAS[rd['mesa']]; ns = rd.get('steps', 24)
            ring = [rim_xz(mm, math.radians(rd['th0'] + (rd['th1'] - rd['th0']) * q / ns), rd['e0'] + (rd['e1'] - rd['e0']) * q / ns) for q in range(ns + 1)]
            rd['wps'] = rd.get('pre', []) + [list(p) for p in ring] + rd.get('post', [])
            print('ledge', rd['name'], 'from', ring[0], 'to', ring[-1])
        wps = [tuple(p) for p in rd['wps']]
        hts = {int(k): v for k, v in rd.get('h', {}).items()}
        for k, v in list(hts.items()):
            if isinstance(v, str):  # "road:<name>" → join height of that road at the waypoint
                (_, hv) = road_pt(v.split(':')[1], near=wps[k])
                hts[k] = hv
        road_from(rd['name'], rd.get('class', 'trail'), rd.get('hw', 4), wps, hts, rd.get('gmax', 0.11), rd.get('smooth', 0))

# ---------------------------------------------------------------- cut / fill every road through the desert
ALL = meta['roads'] + NEW_ROADS
DIST = np.full_like(X, 1e9); RH = np.zeros_like(X); RHW = np.zeros_like(X); CUT = np.ones_like(X)
for r in ALL:
    rx, rz, _ = resample(r['x'], r['z'], 2)
    rh = np.interp(np.linspace(0, 1, len(rx)), np.linspace(0, 1, len(r['h'])), r['h'])
    hw = r['halfWidth'] * 0.75  # as drawn in Dark
    cut = 2.2 if r['name'] in ('mesa_cliff_road', 'canyon_road') else 0.8  # sand banks stay under the crag slope (0.95)
    for k in range(len(rx)):
        x, z = rx[k], rz[k]
        if x < -200 or z > 120: continue
        i, j = int((x + 1200) / 2), int((z + 1200) / 2)
        R = 34
        sl = (slice(max(0, j - R), j + R + 1), slice(max(0, i - R), i + R + 1))
        d = np.hypot(X[sl] - x, Z[sl] - z)
        better = d < DIST[sl]
        DIST[sl] = np.where(better, d, DIST[sl]); RH[sl] = np.where(better, rh[k], RH[sl])
        RHW[sl] = np.where(better, hw, RHW[sl]); CUT[sl] = np.where(better, cut, CUT[sl])
near = DIST < 1e8
tt = np.maximum(0, DIST - RHW - 1.5)
lo = RH - tt * np.where(CUT > 2, 2.4, 0.7)  # fill slope (cliff road: a sheer drop)
hi = RH + tt * CUT  # cut slope
HC = np.where(near, np.clip(HD, lo, hi), HD)
HC = np.where(near & (DIST <= RHW + 1.5), RH, HC)
WEIGHT = WD * (1 - P)
HF = H0 + (HC - H0) * WEIGHT
# existing roads keep exactly their old surface
HF = np.where(near & (DIST <= RHW + 1.0) & (WEIGHT < 0.999), H0 + (RH - H0) * WEIGHT, HF)

# ---------------------------------------------------------------- report / write
dif = HF - H0
print('changed cells', int((np.abs(dif) > 0.5).sum()), 'max raise', float(dif.max()), 'max cut', float(dif.min()))
for r in NEW_ROADS:
    hh = np.array(r['h']); L = 4 * (len(hh) - 1)
    gr = np.abs(np.diff(hh)) / 4
    print('road', r['name'], 'len', L, 'h', hh.min().round(1), hh.max().round(1), 'max grade', gr.max().round(3))
OUTH = globals().get('OUTH')
def enc(Hf):
    v = np.round((Hf - g['min'] - OFF) / g['range'] * 65535)
    return np.clip(v, 0, 65535).astype('<u2')
if OUTH:
    enc(HF).tofile(OUTH)
    json.dump(NEW_ROADS, open(OUTH + '.roads.json', 'w'))
if WRITE:
    enc(HF).tofile(os.path.join(MAP, 'heights.bin'))
    m2 = dict(meta); m2['roads'] = meta['roads'] + NEW_ROADS
    json.dump(m2, open(os.path.join(MAP, 'map.json'), 'w'), separators=(',', ':'))
    # re-seat set pieces on the new ground
    for tile in props['placements'].values():
        for tp, a in tile.items():
            if tp in NATURE: continue
            for o in range(0, len(a), stride):
                a[o + 1] = round(a[o + 1] + float(sample(dif, a[o], a[o + 2])), 2)
    json.dump(props, open(os.path.join(MAP, 'props.json'), 'w'), separators=(',', ':'))
    print('written to', MAP)
