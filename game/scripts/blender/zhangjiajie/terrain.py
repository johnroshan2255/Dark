# ZHANGJIAJIE — THE TERRAIN, sculpted and ERODED in Blender (2026-10-23, the user: "still too narrow, need 5 times
# width with more height, so that it can have a lot of natural erosion; it must be made with Blender; show me the image
# of the terrain first"). Runs in Blender's Python (numpy only) and renders the result with Cycles for approval:
#   blender -b --factory-startup --python scripts/blender/zhangjiajie/terrain.py -- OUT=<dir> [RENDER=1] [DROPS=600000]
# writes <OUT>/terrain.npy (1201² heights, 2 m, world metres) and, with RENDER=1, <OUT>/render_*.png.
#
#  1. LAYOUT from the reference (build.py's reading of ref/heightmap_original.png): where the render's spire field is,
#     where its white tables (mesas) are, the rivers. The spire field is re-seeded at ~5× the spacing of the render's
#     tips (~170 m): each seed a TOWER MASSIF 120–220 m wide, 200–520 m above the valley floor (the render's local tip
#     height × 2), neighbours of like height fused; the tables 420–560 m.
#  2. BLOCKS: a warped, blocky Voronoi of the seeds — sheer walls, 25–40 m gorges between massifs, rounded tops.
#  3. STRATA: the sandstone is layered — alternate hard / soft beds every ~25–45 m (warped): soft beds erode faster
#     (ledges, overhung bands, the stepped profile of the photos).
#  4. EROSION: rain droplets (hydraulic, Lague-style, vectorised in numpy): they run off the tops, carve gullies and
#     flutes down the walls, notch the rims, and drop their load as talus fans at the feet; then a little thermal
#     settling of loose ground (not of the walls).
#  5. RENDER (RENDER=1): the heightfield as a Blender mesh, a slope / height material in the atlas's colours (forest
#     green on everything gentle, tan sandstone with rust streaks and hanging green on the walls), a sky, low mist in
#     the gorges — aerial, oblique and gorge views.
import math, os, sys, time
import numpy as np
import bpy

ARGS = dict(a.split('=', 1) for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []))
OUT = ARGS.get('OUT') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'terrain')
os.makedirs(OUT, exist_ok=True)
HERE = os.path.dirname(os.path.abspath(__file__))
t0 = time.time()

# ---------------------------------------------------------------- 1. the reference's layout (build.py stage 1)
_argv = sys.argv
sys.argv = [_argv[0], '--', 'STAGE=1', f"HALF={ARGS.get('HALF', 2000)}"]
B = {'__file__': os.path.join(HERE, 'build.py'), '__name__': 'build'}
try:
    exec(compile(open(os.path.join(HERE, 'build.py')).read(), os.path.join(HERE, 'build.py'), 'exec'), B)
except SystemExit:
    pass
sys.argv = _argv
HALF, ST, N, WATER = B['HALF'], B['ST'], B['N'], B['WATER']
X, Z, xs = B['X'], B['Z'], B['xs']
blur, sstep, vnoise, bilinear, maxf, minf = B['blur'], B['sstep'], B['vnoise'], B['bilinear'], B['maxf'], B['minf']
P, KT, MV, S = B['P'], B['KT'], B['MV'], B['S']
rng = np.random.default_rng(int(ARGS.get('SEED', 31)))

def hs(x, z, H):
    fx = (np.asarray(x, float) + HALF) / ST; fz = (np.asarray(z, float) + HALF) / ST
    i = np.clip(fx.astype(int), 0, N - 2); j = np.clip(fz.astype(int), 0, N - 2); tx = fx - i; tz = fz - j
    return H[j, i] * (1 - tx) * (1 - tz) + H[j, i + 1] * tx * (1 - tz) + H[j + 1, i] * (1 - tx) * tz + H[j + 1, i + 1] * tx * tz

# rivers, valley floors (as build.py)
def seg_dist(Xa, Za, ax, az, bx, bz):
    dx, dz = bx - ax, bz - az; l2 = dx * dx + dz * dz + 1e-9
    t = np.clip(((Xa - ax) * dx + (Za - az) * dz) / l2, 0, 1)
    return np.hypot(Xa - (ax + dx * t), Za - (az + dz * t))
def coarse_dist(paths, step=4):
    Xc, Zc = X[::step, ::step], Z[::step, ::step]
    d = np.full(Xc.shape, np.inf)
    for p in paths:
        q = p[::2]
        for a in range(len(q) - 1): d = np.minimum(d, seg_dist(Xc, Zc, q[a][0], q[a][1], q[a + 1][0], q[a + 1][1]))
    jj = np.arange(N) / step; return bilinear(d, *np.meshgrid(jj, jj))
RIVERS = B['RIVERS']
d_riv = coarse_dist([p for p, _ in RIVERS.values()])
d_main = coarse_dist([RIVERS['main'][0]]); d_ne = coarse_dist([RIVERS['northeast'][0]])
half_w = np.where(d_main <= d_ne, RIVERS['main'][1], RIVERS['northeast'][1]) / 2 * (1 + 0.25 * vnoise(X, Z, 60, 3))
U, V = B['img_uv'](X, Z)
fl_g = bilinear(B['floor_img'], U, V)
floor = WATER + 3.0 + 26 * sstep(0, 340, d_riv) + 22 * sstep(0.3, 0.62, fl_g) * sstep(20, 160, d_riv) \
        + vnoise(X, Z, 140, 4) * 5 + vnoise(X, Z, 40, 5) * 1.5
floor = np.maximum(floor, WATER + 1.5)
bank = sstep(half_w, half_w + 9, d_riv)
floor = (WATER - 2.6) * (1 - bank) + floor * bank

# the tables (shifted south by their cliffs, as build.py)
G, lab = B['G'], B['lab']
msh = np.zeros_like(G)
for k, cl, _ in B['MESAS']:
    sh = int(round(cl * S))
    m = blur((lab == k).astype(float), 2 * S)
    mm = np.zeros_like(m); mm[sh:] = m[:-sh]
    msh = np.maximum(msh, mm)
mesa = bilinear(msh, U, V) + 0.2 * vnoise(X, Z, 60, 7) + 0.08 * vnoise(X, Z, 17, 8)

# the spire field: the render's tips (their feet) and their heights
tu, tv, dg = B['tu'], B['tv'], B['dg']
hp_px = KT * dg
cx, cz = P(tu / S, tv / S + hp_px)
hp = hp_px * MV
ok = (np.abs(cx) < HALF - 10) & (np.abs(cz) < HALF - 10)
cx, cz, hp = cx[ok], cz[ok], hp[ok]
cnt = np.zeros((N, N)); cnth = np.zeros((N, N))
ii = np.clip(((cx + HALF) / ST).astype(int), 0, N - 1); jj = np.clip(((cz + HALF) / ST).astype(int), 0, N - 1)
np.add.at(cnt, (jj, ii), 1.0); np.add.at(cnth, (jj, ii), hp)
field = blur(cnt, 45)                                     # tip density (the spire field)
tipH = blur(cnth, 45) / np.maximum(1e-9, field)          # their mean height round about
field = field * 2 * math.pi * 45 ** 2                     # ≈ tips within ~90 m
in_field = (sstep(0.6, 2.0, field) * sstep(30, 90, d_riv - half_w) * sstep(0.45, 0.3, mesa))
print(f'[{time.time() - t0:.0f}s] reference read: {len(cx)} tips, field share {float((in_field > 0.5).mean()):.2f}')

# ---------------------------------------------------------------- 2. the plateau, dissected by RIVER EROSION
# Zhangjiajie is a sandstone PLATEAU cut by water along its joints: a dendritic net of deep narrow gorges, the towers
# and blocks what is left between them. So: (a) the plateau over the render's spire field, 200–540 m above the valley
# floors (the render's local tip height × TH), its tables higher; (b) two warped JOINT sets ~JS m apart (5× the
# render's tip spacing) that erode several times faster; (c) STREAM-POWER erosion on an 8 m grid (flow accumulation,
# E = K·A^½·S, base level = the valley floors and rivers) — the gorges grow headward up the joints and branch; (d) back
# on the 2 m grid the incision is SHARPENED into sheer walls (ragged by noise), the tops kept, aprons at the feet.
TH = float(ARGS.get('TH', 1.8))
HS = float(ARGS.get('HS', 0.55))                           # 2026-10-23: the user — lower (3/4, then lower again: ~0.55 of the approved height)
fieldm = sstep(0.3, 0.6, blur(in_field, 12))            # (a plateau with sharp edges, not a dome)
Hp = np.clip(blur(tipH, 90) * TH, 200, 540) * fieldm
Hp += (18 * vnoise(X, Z, 320, 61) + 7 * vnoise(X, Z, 90, 62)) * fieldm
cliffm = sstep(0.46, 0.54, mesa)
MT = 470 + 50 * vnoise(X, Z, 400, 9) + 10 * vnoise(X, Z, 80, 10)
P0 = np.maximum(floor + Hp, floor + (MT - floor) * cliffm)
P0 = np.where(d_riv < half_w + 2, floor, P0)

JS = float(ARGS.get('JS', 180))
th = math.radians(22)
WX = X + 70 * vnoise(X, Z, 420, 41) + 25 * vnoise(X, Z, 120, 42) + 8 * vnoise(X, Z, 35, 47)
WZ = Z + 70 * vnoise(X, Z, 420, 43) + 25 * vnoise(X, Z, 120, 44) + 8 * vnoise(X, Z, 35, 48)
ju = (WX * math.cos(th) + WZ * math.sin(th)) / JS; jv = (-WX * math.sin(th) + WZ * math.cos(th)) / (JS * 1.15)
du = np.abs(ju - np.round(ju)) * JS; dv = np.abs(jv - np.round(jv)) * JS * 1.15
gate_u = sstep(-0.25, 0.15, vnoise(X, Z, 300, 63)); gate_v = sstep(-0.25, 0.15, vnoise(X, Z, 300, 64))   # (joints die out: fused blocks)
J = np.maximum(np.exp(-(du / 14) ** 2) * gate_u, np.exp(-(dv / 14) ** 2) * gate_v)
# minor joints between them (sub-columns of a block)
J2 = np.maximum(np.exp(-((np.abs(ju * 2 - np.round(ju * 2)) * JS / 2) / 6) ** 2), np.exp(-((np.abs(jv * 2 - np.round(jv * 2)) * JS * 0.575) / 6) ** 2)) * sstep(0.1, 0.5, vnoise(X, Z, 150, 65))
Kf = (1 + 2.2 * J + 0.8 * J2) * (1 + 0.6 * vnoise(X, Z, 200, 70))

C = 4                                                     # coarse = every 4th cell (8 m)
Hc = P0[::C, ::C].copy() + rng.uniform(0, 0.05, P0[::C, ::C].shape)
Fc = floor[::C, ::C]; Kc = blur(Kf, 1.5)[::C, ::C]; nc = Hc.shape[0]; DX = ST * C
base = (P0[::C, ::C] - Fc < 4) | (d_riv[::C, ::C] < half_w[::C, ::C] + 4)
base[0, :] = base[-1, :] = base[:, 0] = base[:, -1] = True
nbr = [(-1, -1, 1.414), (-1, 0, 1), (-1, 1, 1.414), (0, -1, 1), (0, 1, 1), (1, -1, 1.414), (1, 0, 1), (1, 1, 1.414)]
flat_i = np.arange(nc * nc).reshape(nc, nc)
BASEM = ARGS.get('BASE', 'massif')
K0 = float(ARGS.get('K', 0.2)); ITER = int(ARGS.get('ITER', 300 if BASEM == 'plateau' else 0)); AMIN = float(ARGS.get('AMIN', 40000))
import heapq
def fill_pits(Hh):
    """Priority-flood (+ ε): every cell drains to the base level — rain on the plateau gathers into streams instead
    of pooling in its little hollows."""
    Hf = Hh.copy(); seen = base.copy(); pq = [(float(Hf[j, i]), j, i) for j, i in zip(*np.nonzero(base))]
    heapq.heapify(pq)
    while pq:
        h, j, i = heapq.heappop(pq)
        for dj, di, _ in nbr:
            nj, ni = j + dj, i + di
            if 0 <= nj < nc and 0 <= ni < nc and not seen[nj, ni]:
                seen[nj, ni] = True
                if Hf[nj, ni] <= h + 1e-3: Hf[nj, ni] = h + 1e-3
                heapq.heappush(pq, (float(Hf[nj, ni]), nj, ni))
    return Hf
A = np.ones(nc * nc) * DX * DX
for it in range(ITER):
    if it % 25 == 0: Hc = fill_pits(Hc)
    Hpad = np.pad(Hc, 1, mode='edge')
    best = np.zeros((nc, nc)); rec = flat_i.copy()
    for dj, di, L in nbr:
        sl = (Hc - Hpad[1 + dj:1 + dj + nc, 1 + di:1 + di + nc]) / (L * DX)
        upd = sl > best
        best = np.where(upd, sl, best)
        rec = np.where(upd, np.clip(flat_i + dj * nc + di, 0, nc * nc - 1), rec)
    rec = np.where(base, flat_i, rec).ravel()
    order = np.argsort(-Hc.ravel())
    A = np.ones(nc * nc)
    recl = rec.tolist(); Al = A.tolist()
    for k in order.tolist():
        r_ = recl[k]
        if r_ != k: Al[r_] += Al[k]
    A = np.array(Al).reshape(nc, nc) * DX * DX
    E = K0 * Kc * np.sqrt(A) * best * (A > AMIN)          # (streams only: no rills on every slope)
    Hr = Hc.ravel()[rec].reshape(nc, nc)
    dh = np.minimum(E, np.maximum(0, Hc - Hr - 0.01))      # (never below its receiver: no pits)
    Hc = np.where(base, Hc, np.maximum(Fc, Hc - dh))
    if it % 40 == 0 or it == ITER - 1:
        print(f'  [{time.time() - t0:.0f}s] stream power {it}: incised share {float(((P0[::C, ::C] - Hc) > 0.5 * (P0[::C, ::C] - Fc + 1e-3)).mean()):.2f}')
# the gorges WIDEN with their stream (lateral erosion: a bigger stream, a wider floor): the floor spreads 1–3 cells
Ac = A.reshape(nc, nc)
Hg = Hc.copy()
for rad, amin in ((1, AMIN), (2, AMIN * 4), (3, AMIN * 16)):
    lowr = minf(np.where(Ac > amin, Hc, 1e9), rad)
    Hg = np.minimum(Hg, np.where(lowr < 1e8, np.maximum(lowr, Fc), Hg))
Hg = blur(Hg, 0.6)
# back to 2 m: the incision fraction, sharpened into walls
jj = np.arange(N) / C
Hcf = bilinear(Hg, *np.meshgrid(jj, jj))
r = (Hcf - floor) / np.maximum(1.0, P0 - floor)
r = r + 0.07 * vnoise(X, Z, 23, 66) + 0.035 * vnoise(X, Z, 8, 67)        # ragged outlines, sub-pillars at the edges
f = sstep(0.42, 0.52, r)                                   # sheer walls
dome = sstep(0.5, 0.9, r)                                  # tops round off toward their rims
H = floor + (P0 - floor) * (0.9 * f + 0.1 * dome * f) + (6 * vnoise(X, Z, 45, 68) + 3 * vnoise(X, Z, 13, 69)) * f
apron = (30 + 15 * vnoise(X, Z, 80, 50)) * sstep(0.12, 0.42, r) * (1 - f)   # scree and forest at the feet
H = H + apron
H = np.where(d_riv < half_w + 2, floor, H)
print(f'[{time.time() - t0:.0f}s] dissected plateau: relief {H.min():.0f} … {H.max():.0f} m, rock share {float((f > 0.5).mean()):.2f}')

# MASSIFS (BASE=massif, the default): the blocking-out — the spire field re-seeded at ~5× the render's tip spacing,
# each seed a tower massif 120–250 m wide (some fused, a few small pillars broken off at the gorge edges), sheer walls,
# rounded tops, 25–40 m gorges; the erosion (ANT Landscape's eroder, below) does the rest
if BASEM == 'massif':
    SP = float(ARGS.get('SP', 300))
    seeds = []; small = []
    for x, z in rng.uniform(-HALF + 40, HALF - 40, (60000, 2)):
        w_ = hs(x, z, in_field)
        if w_ < 0.5 or rng.uniform() > w_: continue
        d_ = np.min(np.hypot(np.array(seeds)[:, 0] - x, np.array(seeds)[:, 1] - z)) if seeds else 1e9
        if d_ < SP * rng.uniform(0.8, 1.25): continue
        seeds.append((x, z))
    seeds = np.array(seeds); ns = len(seeds); sx, sz = seeds[:, 0], seeds[:, 1]
    top = np.clip(hs(sx, sz, tipH) * TH * rng.uniform(0.55, 1.35, ns) * np.where(rng.uniform(0, 1, ns) < 0.15, 0.45, 1.0), 120, 560) * HS
    dd = np.hypot(sx[:, None] - sx[None], sz[:, None] - sz[None]); np.fill_diagonal(dd, 1e9)
    nn = np.sort(dd, 1)[:, :3].mean(1)
    par = list(range(ns))
    def find(a):
        while par[a] != a: par[a] = par[par[a]]; a = par[a]
        return a
    for i in range(ns):
        for j in np.nonzero(dd[i] < 1.15 * nn[i])[0]:
            if j > i and rng.uniform() < 0.3 and abs(top[i] - top[j]) < 0.25 * max(top[i], top[j]):
                a, b = find(i), find(int(j))
                if a != b: par[a] = b
    grp = np.array([find(i) for i in range(ns)])
    WX = X + 26 * vnoise(X, Z, 130, 41) + 10 * vnoise(X, Z, 40, 42) + 4 * vnoise(X, Z, 12, 52)
    WZ = Z + 26 * vnoise(X, Z, 130, 43) + 10 * vnoise(X, Z, 40, 44) + 4 * vnoise(X, Z, 12, 53)
    F1 = np.full((N, N), 1e9); ID = np.full((N, N), -1); G1 = np.full((N, N), -1); F2o = np.full((N, N), 1e9); F2a = np.full((N, N), 1e9)
    rot = rng.uniform(0, math.pi / 2, ns)
    for s_ in range(ns):
        R = 1.5 * nn[s_] + 60
        i0 = max(0, int((sx[s_] - R + HALF) / ST)); i1 = min(N, int((sx[s_] + R + HALF) / ST) + 1)
        j0 = max(0, int((sz[s_] - R + HALF) / ST)); j1 = min(N, int((sz[s_] + R + HALF) / ST) + 1)
        dx = WX[j0:j1, i0:i1] - sx[s_]; dz = WZ[j0:j1, i0:i1] - sz[s_]
        u_ = dx * math.cos(rot[s_]) + dz * math.sin(rot[s_]); v_ = -dx * math.sin(rot[s_]) + dz * math.cos(rot[s_])
        d = 0.45 * np.maximum(np.abs(u_), np.abs(v_)) + 0.55 * np.hypot(u_, v_) * 0.86
        f1 = F1[j0:j1, i0:i1]; id1 = ID[j0:j1, i0:i1]; g1 = G1[j0:j1, i0:i1]; f2o = F2o[j0:j1, i0:i1]; f2a = F2a[j0:j1, i0:i1]
        g = grp[s_]; better = d < f1
        f2a[:] = np.where(better, f1, np.minimum(f2a, d))
        f2o[:] = np.where(better & (g1 != g), np.minimum(f1, f2o), np.where(~better & (g1 != g), np.minimum(f2o, d), f2o))
        f1[:] = np.where(better, d, f1); id1[:] = np.where(better, s_, id1); g1[:] = np.where(better, g, g1)
    has = ID >= 0; idc = np.where(has, ID, 0)
    e = np.where(has, np.minimum((F2o - F1) / 2, np.minimum(0.62 * nn[idc] + 30, 260) - F1), -80)
    T = top[idc]
    gw = float(ARGS.get('GAP', 26)) + 8 * (vnoise(X, Z, 90, 45) * 0.5 + 0.5)   # half the gap between hills (flat, drivable floors)
    # SCULPT: (a) COLUMNS — inside each massif a second, finer Voronoi (~45 m) splits it into columns of different
    # heights (35–100 % of the massif's), clefts between them; (b) FLUTES — the outline pushed in and out every
    # ~10 m (vertical grooves down the walls) and notched at ~30 m; (c) TIERS — the column narrows upward in 2–4 steps
    # (strata ledges, each set back 3–9 m); (d) a domed, lumpy crown
    CS = float(ARGS.get('CS', 85))
    cu = (WX / CS); cv = (WZ / CS)
    ci = np.floor(cu).astype(int); cj = np.floor(cv).astype(int)
    c1 = np.full(X.shape, 1e9); c2 = np.full(X.shape, 1e9); cid = np.zeros(X.shape)
    def chash(a, b, k): return (np.sin(a * 127.1 + b * 311.7 + k * 74.7) * 43758.5453) % 1.0
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1):
            a_, b_ = ci + di, cj + dj
            px_ = a_ + chash(a_, b_, 1); pz_ = b_ + chash(a_, b_, 2)
            d_ = np.hypot(cu - px_, cv - pz_) * CS
            nb = d_ < c1
            c2 = np.where(nb, c1, np.minimum(c2, d_)); c1 = np.where(nb, d_, c1); cid = np.where(nb, chash(a_, b_, 3), cid)
    colh = 0.6 + 0.4 * cid ** 0.45                          # each column's share of the massif height
    colh = np.where(cid > 0.5, 1.0, colh)                    # (half the columns at full height: fused blocks)
    ccleft = sstep(5, 1.5, (c2 - c1) / 2)                    # the cleft between two columns
    flute = 2.5 * np.sin((np.arctan2(WZ - sz[idc], WX - sx[idc]) * (nn[idc] / 14.0))) + 3 * vnoise(X, Z, 14, 74) + 10 * vnoise(X, Z, 45, 71)
    ee = e - gw + flute
    Tc = T * colh
    # TAPERED HILLS (the user: "wider bottom, narrower as it goes up, erosion shapes on some sides"): the height
    # climbs from the gorge edge at a wall steepness that changes round the hill (side by side: 2.2–6 m of rise per m,
    # ~65–80°), with strata LEDGES on some sides (the slope pauses, a shelf 0–12 m wide), deep erosion GULLIES and
    # alcoves cut into the sides, and an uneven domed top (sub-peaks, saddles) — no two parts at the same height
    side = vnoise(X, Z, 70, 80) * 0.6 + vnoise(X, Z, 28, 81) * 0.4               # which side: steep / stepped / gullied
    Sw = float(ARGS.get('SW0', 1.8)) + float(ARGS.get('SW1', 2.6)) * sstep(-0.5, 0.6, side)   # wall steepness (rise per m inward: ~61–77°)
    gully = np.maximum(0, vnoise(X, Z, 32, 82)) ** 1.5 * 24 + np.maximum(0, vnoise(X, Z, 14, 83)) ** 2 * 6
    e2 = ee - gully * sstep(0.3, -0.2, side)                                     # gullies on the softer sides
    Tl = Tc * (1 + 0.16 * vnoise(X, Z, 60, 84) + 0.07 * vnoise(X, Z, 20, 85))   # an uneven top
    e_ = np.maximum(0, e2).copy()
    for k in range(4):                                                           # LEDGES at the strata
        bk = Tl * (0.2 + 0.2 * k + 0.06 * vnoise(X, Z, 120, 86 + k))
        wk = np.maximum(0, 9 * vnoise(X, Z, 55, 90 + k) + 1.5) * sstep(-0.1, 0.4, -side)
        e_ = e_ - np.clip(e_ - bk / Sw, 0, wk)
    h = e_ * Sw
    tower = np.minimum(h, Tl)
    # the top: domed and lumpy (it keeps rising a little inward past where the walls stop)
    crown = (0.08 * Tl * sstep(0, 1, (e2 * Sw - Tl) / (0.35 * Tl)) + 6 * vnoise(X, Z, 30, 48) + 3 * vnoise(X, Z, 11, 75)) * (h >= Tl)
    tower = tower + crown
    cleft = ccleft * 0.12 * Tc * (tower > 0) + sstep(7, 1, (F2a - F1) / 2) * 0.18 * Tc * (tower > 0)
    tower = np.maximum(0, tower - cleft)
    wall = sstep(0.0, 4.0, ee)
    apron = (12 + 8 * vnoise(X, Z, 80, 50)) * sstep(-8, 4, ee) * has          # scree at the foot (the gorge floor stays flat)
    # pillars broken off the massifs: small columns in the gorges by the walls (the photos' foreground spires)
    pil = np.zeros_like(X)
    for k in range(int(ARGS.get('PILLARS', 60))):
        j_, i_ = rng.integers(0, N, 2)
        if not has[j_, i_] or not (-14 < ee[j_, i_] < -4) or in_field[j_, i_] < 0.5: continue
        x0, z0 = xs[i_], xs[j_]; r0 = rng.uniform(16, 30); h0 = T[j_, i_] * rng.uniform(0.35, 0.7)
        i0 = max(0, i_ - 30); i1 = min(N, i_ + 31); j0 = max(0, j_ - 30); j1 = min(N, j_ + 31)
        dd_ = np.hypot(X[j0:j1, i0:i1] - x0, Z[j0:j1, i0:i1] - z0) + 5 * vnoise(X[j0:j1, i0:i1], Z[j0:j1, i0:i1], 9, 72 + k % 5)
        pil[j0:j1, i0:i1] = np.maximum(pil[j0:j1, i0:i1], np.minimum(h0, np.maximum(0, r0 - dd_) * 4.5))   # (tapered too)
    TW = np.maximum(tower + apron, pil) * in_field.clip(0, 1) ** 0.5
    MT = (450 + 60 * vnoise(X, Z, 400, 9) + 40 * vnoise(X, Z, 120, 10) + 12 * vnoise(X, Z, 35, 76)) * HS
    cliffm = sstep(0.4, 0.62, mesa + 0.06 * vnoise(X, Z, 25, 73) + 0.04 * vnoise(X, Z, 9, 77))   # (a tapered, ragged edge)
    H = np.maximum(floor + TW, floor + (MT - floor) * cliffm + 45 * sstep(0.2, 0.46, mesa) * (1 - cliffm))
    H = np.where(d_riv < half_w + 2, floor, H)
    print(f'[{time.time() - t0:.0f}s] massifs: {ns} in {len(np.unique(grp))} groups, tops {np.round(np.percentile(top, [5, 50, 95]))} m, spacing {np.round(np.percentile(nn, [5, 50, 95]))} m')

# ---------------------------------------------------------------- 3. strata (hard / soft beds) + 4. erosion
bed = np.sin((H + 6 * vnoise(X, Z, 120, 60)) * 2 * math.pi / 34.0)      # (bed phase follows the original surface)
def hardness_at(h, x, z):
    """Erodibility multiplier at height h: soft beds (×1.8) between hard ones (×0.45), warped."""
    ph = np.sin((h + 6 * vnoise(x, z, 120, 60)) * 2 * math.pi / 34.0)
    return 0.45 + 1.35 * sstep(0.2, 0.75, ph)

H0 = H.copy()
NE = H.shape[0]
fixed = (d_riv < half_w + 4)                              # (the rivers keep their beds)

def erode(H, n_drops, steps=48, inertia=0.06, cap=5.0, min_cap=0.02, erode_r=0.35, depo_r=0.25, evap=0.02,
          grav=9.0, max_ero=2.5, batch=120000, seed=1):
    r_ = np.random.default_rng(seed)
    # brush: 5×5 gaussian-ish weights
    offs = [(dj, di) for dj in range(-2, 3) for di in range(-2, 3)]
    wts = np.array([math.exp(-(dj * dj + di * di) / 2.5) for dj, di in offs]); wts /= wts.sum()
    done = 0
    while done < n_drops:
        n = min(batch, n_drops - done); done += n
        # rain falls where it can run off: tops and walls (weighted toward high ground)
        px = r_.uniform(2, NE - 3, n); pz = r_.uniform(2, NE - 3, n)
        dx = np.zeros(n); dz = np.zeros(n); sp = np.ones(n); wa = np.ones(n); sed = np.zeros(n)
        alive = np.ones(n, bool)
        for _ in range(steps):
            i = px.astype(int); j = pz.astype(int); fx = px - i; fz = pz - j
            h00 = H[j, i]; h10 = H[j, i + 1]; h01 = H[j + 1, i]; h11 = H[j + 1, i + 1]
            gx = ((h10 - h00) * (1 - fz) + (h11 - h01) * fz) / ST
            gz = ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) / ST
            hcur = h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz
            dx = dx * inertia - gx * (1 - inertia); dz = dz * inertia - gz * (1 - inertia)
            L = np.hypot(dx, dz) + 1e-12; dx /= L; dz /= L
            nx = px + dx; nz = pz + dz
            out = (nx < 2) | (nz < 2) | (nx > NE - 3) | (nz > NE - 3)
            alive &= ~out
            nx = np.clip(nx, 2, NE - 3); nz = np.clip(nz, 2, NE - 3)
            hnew = bilinear(H, nx, nz)
            dh = hnew - hcur
            c = np.maximum(-dh * sp * wa * cap / 10.0, min_cap)
            k = hardness_at(hcur, (px * ST - HALF), (pz * ST - HALF))
            depo = np.where((sed > c) | (dh > 0), np.where(dh > 0, np.minimum(dh, sed), (sed - c) * depo_r), 0.0)
            ero = np.where((sed <= c) & (dh <= 0), np.minimum(np.minimum((c - sed) * erode_r * k, -dh), max_ero), 0.0)
            depo *= alive; ero *= alive * ~fixed[j, i]
            sed = sed - depo + ero
            # deposit bilinearly at the old position, erode with the brush round it
            idx = np.concatenate([j * NE + i, j * NE + i + 1, (j + 1) * NE + i, (j + 1) * NE + i + 1])
            wdp = np.concatenate([depo * (1 - fx) * (1 - fz), depo * fx * (1 - fz), depo * (1 - fx) * fz, depo * fx * fz])
            flat = H.reshape(-1)
            np.add.at(flat, idx, wdp)
            sel = ero > 1e-6
            if sel.any():
                ie, je, ev = i[sel], j[sel], ero[sel]
                bi = np.concatenate([np.clip(je + dj, 0, NE - 1) * NE + np.clip(ie + di, 0, NE - 1) for dj, di in offs])
                bw = np.concatenate([ev * w for w in wts])
                np.subtract.at(flat, bi, bw)
            sp = np.sqrt(np.maximum(0.0, sp * sp + (-dh) * grav / 10.0))
            sp = np.minimum(sp, 12.0)
            wa *= (1 - evap)
            px, pz = nx, nz
            if not alive.any(): break
        print(f'  [{time.time() - t0:.0f}s] {done} drops')
    return H

DROPS = int(ARGS.get('DROPS', 0))
H = erode(H, DROPS)
H = np.where(fixed, H0, H)
# ANT LANDSCAPE's ERODER (Blender extension: hydraulic river erosion, avalanching scree, thermal diffusion) on a 4 m
# grid (the grid in cell units: x, y = column, row, z = height / 4 m, so its talus angle is real)
if ARGS.get('ANT', '1') == '1':
    import addon_utils
    addon_utils.enable('bl_ext.blender_org.antlandscape', default_set=True)
    CE = int(ARGS.get('CE', 2)); He = H[::CE, ::CE]; ne = He.shape[0]; cell = ST * CE
    ii_, jj_ = np.meshgrid(np.arange(ne, dtype=float), np.arange(ne, dtype=float))
    vv = np.stack([ii_.ravel(), jj_.ravel(), He.ravel() / cell], 1)
    q_ = np.arange(ne * ne).reshape(ne, ne)
    ff = np.stack([q_[:-1, :-1].ravel(), q_[:-1, 1:].ravel(), q_[1:, 1:].ravel(), q_[1:, :-1].ravel()], 1)
    me_ = bpy.data.meshes.new('erode')
    me_.vertices.add(len(vv)); me_.vertices.foreach_set('co', vv.astype(np.float32).ravel())
    me_.loops.add(ff.size); me_.loops.foreach_set('vertex_index', ff.astype(np.int32).ravel())
    me_.polygons.add(len(ff)); me_.polygons.foreach_set('loop_start', (np.arange(len(ff)) * 4).astype(np.int32))
    me_.polygons.foreach_set('loop_total', np.full(len(ff), 4, np.int32)); me_.update()
    obe = bpy.data.objects.new('erode', me_); bpy.context.scene.collection.objects.link(obe)
    bpy.context.view_layer.objects.active = obe; obe.select_set(True)
    vg = obe.vertex_groups.new(name='rainmap')
    vg.add(list(range(len(vv))), 1.0, 'REPLACE')
    with bpy.context.temp_override(active_object=obe, object=obe, selected_objects=[obe]):
        bpy.ops.mesh.eroder(Iterations=int(ARGS.get('EIT', 3)), IterRiver=int(ARGS.get('ERIV', 30)), IterAva=int(ARGS.get('EAVA', 6)),
                            IterDiffuse=2, Ef=0.6, Kd=float(ARGS.get('KD', 0.02)), Kt=math.radians(float(ARGS.get('KT_', 58))),
                            Kr=float(ARGS.get('KR', 0.02)), Kv=0.3, userainmap=False, Ks=0.5, Kdep=0.1, Kz=float(ARGS.get('KZ', 0.06)),
                            Kc=0.9, Ka=1.0, Kev=0.5, numexpr=False, Pd=0.2, Pa=0.5, Pw=1.0, smooth=False)
    co = np.zeros(len(obe.data.vertices) * 3, np.float32); obe.data.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    Ee = np.zeros((ne, ne)); Ee[np.clip(np.round(co[:, 1]).astype(int), 0, ne - 1), np.clip(np.round(co[:, 0]).astype(int), 0, ne - 1)] = co[:, 2] * cell
    dE = Ee - He
    print(f'[{time.time() - t0:.0f}s] ANT eroder: mean change {np.abs(dE).mean():.2f} m, cut {(-dE).max():.0f} m, fill {dE.max():.0f} m')
    jj = np.arange(N) / CE
    H = H + bilinear(np.clip(dE, -float(ARGS.get('ECUT', 90)), float(ARGS.get('EFILL', 45))), *np.meshgrid(jj, jj))
    H = np.where(fixed, H0, np.maximum(H, floor - 2))
    bpy.data.objects.remove(obe)
print(f'[{time.time() - t0:.0f}s] eroded: relief {H.min():.0f} … {H.max():.0f} m, mean change {np.abs(H - H0).mean():.2f} m, max cut {(H0 - H).max():.0f} m, max fill {(H - H0).max():.0f} m')
# GULLIES + FLUTES at the full 2 m (2026-10-23, the user: "feels like a soft hill, we need erosion"): the eroder
# works on 4 m and is upsampled — soft. Here every slope is carved by the water that runs off it: D8 flow
# accumulation on the 2 m grid, each cell cut by K·A^0.45·S^0.8 (capped), so rills join into gullies and gullies into
# ravines down every face (a dendritic net with sharp spurs between); then narrow FLUTES on the steep rock (ridged
# noise, deepest on the walls) and a jagged crest line.
if ARGS.get('GULLY', '1') == '1':
    gz_, gx_ = np.gradient(H, ST); sl = np.hypot(gx_, gz_)
    Hr_ = H + 3.0 * vnoise(X, Z, 18, 94) + 1.2 * vnoise(X, Z, 6, 95)   # (a rough surface: the runoff converges into rills)
    Hp_ = np.pad(Hr_, 1, mode='edge'); nn_ = H.shape[0]
    best = np.zeros_like(H); rec = np.arange(nn_ * nn_).reshape(nn_, nn_)
    idx_ = rec.copy()
    for dj, di in ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)):
        L = math.hypot(dj, di) * ST
        d_ = (Hr_ - Hp_[1 + dj:1 + dj + nn_, 1 + di:1 + di + nn_]) / L
        u_ = d_ > best
        best = np.where(u_, d_, best); rec = np.where(u_, np.clip(idx_ + dj * nn_ + di, 0, nn_ * nn_ - 1), rec)
    order = np.argsort(-Hr_.ravel()).tolist(); recl = rec.ravel().tolist(); Al = [1.0] * (nn_ * nn_)
    for k in order:
        r_ = recl[k]
        if r_ != k: Al[r_] += Al[k]
    A = np.array(Al).reshape(nn_, nn_) * ST * ST
    above = H - floor
    KG = float(ARGS.get('KG', 0.25)); GMAX = float(ARGS.get('GMAX', 14))
    cut = np.minimum(GMAX, KG * A ** 0.45 * np.minimum(sl, 3.0) ** 0.8) * sstep(4, 25, above) * sstep(0.15, 0.4, sl)
    cut = np.maximum(cut, 0.6 * maxf(cut, 1) * (A > 400))            # (a gully a few cells wide, not a 2 m slit)
    cut = blur(cut, 0.7)
    # flutes: ridged noise across the slope, on the steep faces
    fl = 1 - np.abs(vnoise(X, Z, 7, 91) * 0.7 + vnoise(X, Z, 3, 92) * 0.3)
    flute = (fl ** 3) * 3.5 * sstep(0.6, 1.4, sl) * sstep(8, 30, above)
    crest = np.maximum(0, vnoise(X, Z, 5, 93)) * 2.5 * sstep(0.1, 0.5, sl) * sstep(20, 60, above)   # jagged rims
    dG = cut + flute + crest
    H = np.where(fixed, H, np.maximum(floor - 1, H - dG))
    print(f'[{time.time() - t0:.0f}s] gullies: mean cut {dG[above > 10].mean():.2f} m, max {dG.max():.0f} m, gully cells {int((cut > 2).sum())}')

np.save(os.path.join(OUT, 'terrain.npy'), H.astype(np.float32))
np.save(os.path.join(OUT, 'floor.npy'), floor.astype(np.float32))
def hshade(Hh):
    gz_, gx_ = np.gradient(Hh, ST)
    nrm = np.stack([-gx_, np.ones_like(Hh), -gz_], 2); nrm /= np.linalg.norm(nrm, axis=2, keepdims=True)
    Lv = np.array([-0.5, 0.75, -0.45]); Lv /= np.linalg.norm(Lv)
    s_ = np.clip(nrm @ Lv, 0, 1); t_ = np.clip((Hh - WATER) / 560, 0, 1)
    return np.stack([s_ * (0.45 + 0.4 * t_) + 0.1, s_ * (0.55 + 0.2 * t_) + 0.12, s_ * (0.35 + 0.3 * t_) + 0.08], 2)
B['save_png'](os.path.join(OUT, 'top_before.png'), hshade(H0)[::2, ::2])
B['save_png'](os.path.join(OUT, 'top_after.png'), hshade(H)[::2, ::2])
B['save_png'](os.path.join(OUT, 'top_zoom.png'), hshade(H)[500:800, 500:800])

# ---------------------------------------------------------------- 5. render (Cycles)
if ARGS.get('RENDER', '0') != '1': sys.exit(0)
for o in list(bpy.data.objects): bpy.data.objects.remove(o)
DEC = int(ARGS.get('DEC', 1))
Hd = H[::DEC, ::DEC]; n = Hd.shape[0]; xd = xs[::DEC]
XX, ZZ = np.meshgrid(xd, xd)
verts = np.stack([XX.ravel(), -ZZ.ravel(), Hd.ravel()], 1)            # Blender: z up, -y = north
q = np.arange(n * n).reshape(n, n)
faces = np.stack([q[:-1, :-1].ravel(), q[1:, :-1].ravel(), q[1:, 1:].ravel(), q[:-1, 1:].ravel()], 1)
me = bpy.data.meshes.new('terrain')
me.vertices.add(len(verts)); me.vertices.foreach_set('co', verts.astype(np.float32).ravel())
me.loops.add(faces.size); me.loops.foreach_set('vertex_index', faces.astype(np.int32).ravel())
me.polygons.add(len(faces)); me.polygons.foreach_set('loop_start', (np.arange(len(faces)) * 4).astype(np.int32))
me.polygons.foreach_set('loop_total', np.full(len(faces), 4, np.int32))
me.update(); me.validate()
me.shade_flat()
ob = bpy.data.objects.new('terrain', me); bpy.context.scene.collection.objects.link(ob)
# per-vertex data for the material: height over the valley floor, river water
fl = floor[::DEC, ::DEC].ravel()
attr = me.attributes.new('above', 'FLOAT', 'POINT'); attr.data.foreach_set('value', (Hd.ravel() - fl).astype(np.float32))

def srgb(h):
    c = [int(h[k:k + 2], 16) / 255 for k in (0, 2, 4)]
    return [(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) for v in c] + [1]
mat = bpy.data.materials.new('zjj'); mat.use_nodes = True
nt = mat.node_tree; N_ = nt.nodes; L_ = nt.links
for nd in list(N_): N_.remove(nd)
outn = N_.new('ShaderNodeOutputMaterial'); bsdf = N_.new('ShaderNodeBsdfPrincipled'); bsdf.inputs['Roughness'].default_value = 0.9
L_.new(bsdf.outputs['BSDF'], outn.inputs['Surface'])
geo = N_.new('ShaderNodeNewGeometry'); sep = N_.new('ShaderNodeSeparateXYZ'); L_.new(geo.outputs['Normal'], sep.inputs['Vector'])
tc = N_.new('ShaderNodeTexCoord')
def noise(scale, detail=4, rough=0.6, vec=None, dist=0.0):
    nz = N_.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = scale; nz.inputs['Detail'].default_value = detail
    nz.inputs['Roughness'].default_value = rough
    if 'Distortion' in nz.inputs: nz.inputs['Distortion'].default_value = dist
    L_.new(vec if vec is not None else tc.outputs['Object'], nz.inputs['Vector']); return nz
def ramp(inp, stops):
    r = N_.new('ShaderNodeValToRGB'); cr = r.color_ramp
    for k, (pos, col) in enumerate(stops):
        el = cr.elements[k] if k < 2 else cr.elements.new(pos)
        el.position = pos; el.color = col
    L_.new(inp, r.inputs['Fac']); return r
def mix(a, b, fac):
    m = N_.new('ShaderNodeMix'); m.data_type = 'RGBA'
    L_.new(fac, m.inputs['Factor']); L_.new(a, m.inputs[6]); L_.new(b, m.inputs[7]); return m.outputs[2]
# rock: tan sandstone, streaked vertically (stretched noise), rust and dark wet streaks
mapv = N_.new('ShaderNodeMapping'); L_.new(tc.outputs['Object'], mapv.inputs['Vector']); mapv.inputs['Scale'].default_value = (1.0, 1.0, 0.35)
rn = noise(0.06, 6, 0.65, mapv.outputs['Vector'])
rock = ramp(rn.outputs['Fac'], [(0.3, srgb('4a4338')), (0.45, srgb('857563')), (0.58, srgb('9c8a72')), (0.66, srgb('a8743f')), (0.78, srgb('b3a58e'))])
# hanging vegetation on the walls: patches stretched downward
vn = noise(0.035, 5, 0.6, mapv.outputs['Vector'])
vmask = ramp(vn.outputs['Fac'], [(0.46, (0, 0, 0, 1)), (0.52, (1, 1, 1, 1))])
green_n = noise(0.08, 4, 0.7)
green = ramp(green_n.outputs['Fac'], [(0.3, srgb('0a200a')), (0.5, srgb('163a12')), (0.7, srgb('2a5a18'))])
wallcol = mix(rock.outputs['Color'], green.outputs['Color'], vmask.outputs['Color'])
# gentle ground = forest (canopy bumps), steep = wall
slope = ramp(sep.outputs['Z'], [(0.45, (0, 0, 0, 1)), (0.62, (1, 1, 1, 1))])
col = mix(wallcol, green.outputs['Color'], slope.outputs['Color'])
# river water
atn = N_.new('ShaderNodeAttribute'); atn.attribute_name = 'above'
wz = N_.new('ShaderNodeSeparateXYZ'); L_.new(geo.outputs['Position'], wz.inputs['Vector'])
wmask = ramp(wz.outputs['Z'], [(0.0, (1, 1, 1, 1)), (0.001, (0, 0, 0, 1))])
mr = N_.new('ShaderNodeMath'); mr.operation = 'LESS_THAN'; mr.inputs[1].default_value = WATER + 0.2; L_.new(wz.outputs['Z'], mr.inputs[0])
wcol = N_.new('ShaderNodeRGB'); wcol.outputs[0].default_value = srgb('2f7a92')
col = mix(col, wcol.outputs[0], mr.outputs[0])
L_.new(col, bsdf.inputs['Base Color'])
# canopy bump on the forest
bn = noise(0.35, 4, 0.75); bump = N_.new('ShaderNodeBump'); bump.inputs['Strength'].default_value = 1.0; bump.inputs['Distance'].default_value = 6.0
L_.new(bn.outputs['Fac'], bump.inputs['Height']); L_.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
ob.data.materials.append(mat)

# world: sky + sun, gorge mist (a low volume slab)
sc = bpy.context.scene
w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
wn = w.node_tree.nodes; wl = w.node_tree.links
for nd in list(wn): wn.remove(nd)
sky = wn.new('ShaderNodeTexSky')
try: sky.sky_type = 'NISHITA'
except Exception: pass
for k, v in (('sun_elevation', math.radians(38)), ('sun_rotation', math.radians(140)), ('air_density', 1.6), ('dust_density', 3.0)):
    if hasattr(sky, k): setattr(sky, k, v)
bg = wn.new('ShaderNodeBackground'); bg.inputs['Strength'].default_value = 0.7
wo = wn.new('ShaderNodeOutputWorld'); wl.new(sky.outputs['Color'], bg.inputs['Color']); wl.new(bg.outputs['Background'], wo.inputs['Surface'])
sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = 4.0; sun.angle = math.radians(1.5)
so = bpy.data.objects.new('sun', sun); so.rotation_euler = (math.radians(52), 0, math.radians(140)); sc.collection.objects.link(so)
bpy.ops.mesh.primitive_cube_add(size=1)
mist = bpy.context.active_object; mist.name = 'mist'
mist.scale = (2 * HALF + 400, 2 * HALF + 400, 60); mist.location = (0, 0, 20)
mm = bpy.data.materials.new('mist'); mm.use_nodes = True
mn = mm.node_tree.nodes; ml = mm.node_tree.links
for nd in list(mn): mn.remove(nd)
vol = mn.new('ShaderNodeVolumePrincipled'); vol.inputs['Density'].default_value = float(ARGS.get('MIST', 0.003)); vol.inputs['Color'].default_value = (0.92, 0.95, 1.0, 1)
mo = mn.new('ShaderNodeOutputMaterial'); ml.new(vol.outputs['Volume'], mo.inputs['Volume'])
mist.data.materials.append(mm)

sc.render.engine = 'CYCLES'
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'; prefs.get_devices()
    for d in prefs.devices: d.use = True
    sc.cycles.device = 'GPU'
except Exception as ex:
    print('cpu render', ex)
sc.cycles.samples = int(ARGS.get('SAMPLES', 48)); sc.cycles.use_denoising = True
sc.render.resolution_x = int(ARGS.get('W', 1600)); sc.render.resolution_y = int(ARGS.get('H', 900))
sc.view_settings.view_transform = 'AgX'
try: sc.view_settings.look = 'AgX - Punchy'
except Exception: pass
sc.cycles.volume_step_rate = 4.0

def shot(name, loc, target, lens=35):
    cam = bpy.data.cameras.new(name); cam.lens = lens; cam.clip_end = 20000
    co = bpy.data.objects.new(name, cam); sc.collection.objects.link(co)
    co.location = loc
    d = np.array(target, float) - np.array(loc, float)
    yaw = math.atan2(d[1], d[0]); pitch = math.atan2(d[2], math.hypot(d[0], d[1]))
    co.rotation_euler = (math.pi / 2 + pitch, 0, yaw - math.pi / 2)
    sc.camera = co
    sc.render.filepath = os.path.join(OUT, f'render_{name}.png')
    bpy.ops.render.render(write_still=True)
    print(f'[{time.time() - t0:.0f}s] rendered', sc.render.filepath)
def z_at(x, y): return float(hs(x, -y, H))
# aerial over the field from the south-west (the photos' bird's-eye), oblique from the south (the reference render's
# angle), and in a gorge
shot('aerial', (-1500, -2500, 1900), (250, 250, 120), 32)
shot('photo', (-250, -1900, 900), (250, 500, 150), 30)
shot('oblique', (0, -3800, 2700), (0, 250, 0), 30)
# a tower top near the middle: the lookout, looking out across the field
jm, im = np.unravel_index(np.argmax(np.where((np.abs(X) < 500) & (np.abs(Z) < 500), H, -1)), H.shape)
lx_, ly_ = float(xs[im]), -float(xs[jm])
shot('lookout', (lx_, ly_, float(H[jm, im]) + 25), (lx_ + 900, ly_ + 700, 120), 28)
# on the gorge floor, driver's eye height (~3 m), looking up a gap between hills
rise_ = np.where((in_field > 0.9) & (np.abs(X) < 500) & (np.abs(Z) < 500) & (d_riv > 60), maxf(H, 4) - floor, 1e9)
print('gorge floor: lowest ground over the valley floor', float(rise_.min()))
jg, ig = np.unravel_index(np.argmin(rise_), rise_.shape)
gx0, gz0 = float(xs[ig]), float(xs[jg])
best = None
for ang in np.linspace(0, 2 * math.pi, 36, endpoint=False):   # the direction with the longest open run
    run = 0
    for r_ in range(10, 600, 10):
        if hs(gx0 + math.cos(ang) * r_, gz0 + math.sin(ang) * r_, H) - hs(gx0, gz0, H) > 6: break
        run = r_
    if best is None or run > best[0]: best = (run, ang)
ang = best[1]
shot('ground', (gx0, -gz0, float(hs(gx0, gz0, H)) + 3), (gx0 + math.cos(ang) * 400, -(gz0 + math.sin(ang) * 400), float(hs(gx0, gz0, H)) + 60), 26)
