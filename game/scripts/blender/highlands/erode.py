# THE HIGHLANDS — EROSION pass over the built heightmap (2026-10-24, the user: "use proper erosion to make it look real,
# not a lot of stones — actual terrain"). Runs inside Blender (numpy only), through the MCP socket or headless:
#   node scripts/blender/bl.mjs scripts/blender/highlands/erode.py MAP=public/maps/highlands OUT=<dir> [WRITE=1] [PREVIEW=1]
#
#  1. HYDRAULIC: ~600 k rain droplets (Beyer / Lague particle erosion, all droplets stepped together in numpy): each runs
#     downhill with inertia, picks up sediment where it speeds up (capacity ∝ slope × speed × water) and drops it where it
#     slows — dendritic GULLIES down every slope and cliff, fans of silt at their feet, softened valley floors.
#  2. THERMAL (12 gentle passes): material steeper than the talus angle (~42°, 1.8 m per 2 m cell) slides to its lower neighbours — the
#     terrace walls keep their cliffs but break into scree slopes at their base.
#  3. PROTECTED: within 9 m of every road's edge, 10 m of every set piece and 30 m of the spawn nothing changes (blended
#     out over the next 12 m — the graded road beds and the placed props keep their heights); water stays water and dry
#     land stays above it.
#  OUT/heights_eroded.bin (same format as heights.bin) and, with PREVIEW=1, OUT/erosion_preview.png (before | after,
#  two views, rendered in a scratch scene — the user's scenes are untouched). WRITE=1 replaces MAP/heights.bin.
import json, math, os
import numpy as np

MAP = globals().get('MAP', 'public/maps/highlands'); OUT = globals().get('OUT', '.')
WRITE = globals().get('WRITE', '0') == '1'; PREVIEW = globals().get('PREVIEW', '1') == '1'
ROOT = globals().get('ROOT', os.getcwd())
MAP = os.path.join(ROOT, MAP) if not os.path.isabs(MAP) else MAP
os.makedirs(OUT, exist_ok=True)
meta = json.load(open(os.path.join(MAP, 'map.json')))
G = meta['grid']; N = G['n']; ST = G['step']; OX, OZ = G['origin']; OFF = meta['heightOffset']
WATER = -6.0
raw = np.fromfile(os.path.join(MAP, 'heights.bin'), dtype='<u2').reshape(N, N)
H0 = (G['min'] + raw.astype(np.float64) / 65535.0 * G['range']) + OFF  # world metres, [z, x]
H = H0.copy()

# ---- protection mask (1 = free to erode, 0 = keep) ----
X = OX + np.arange(N) * ST; Z = OZ + np.arange(N) * ST
XX, ZZ = np.meshgrid(X, Z)
dist = np.full((N, N), 1e9)
def stamp(px, pz, r):
    """distance field from points (each a disc of radius r), on the grid (cells within r + 21 m only)."""
    global dist
    R = r + 21.0
    for x, z in zip(px, pz):
        i0 = max(0, int((z - R - OZ) / ST)); i1 = min(N, int((z + R - OZ) / ST) + 2)
        j0 = max(0, int((x - R - OX) / ST)); j1 = min(N, int((x + R - OX) / ST) + 2)
        if i0 >= i1 or j0 >= j1: continue
        d = np.hypot(XX[i0:i1, j0:j1] - x, ZZ[i0:i1, j0:j1] - z) - r
        dist[i0:i1, j0:j1] = np.minimum(dist[i0:i1, j0:j1], d)
for rd in meta['roads']:
    xs, zs = np.array(rd['x'], float), np.array(rd['z'], float)
    # densify to ≤ 2 m so the discs make a continuous band
    px, pz = [], []
    for k in range(len(xs) - 1):
        n = max(1, int(math.hypot(xs[k + 1] - xs[k], zs[k + 1] - zs[k]) / 2))
        t = np.arange(n) / n
        px.extend(xs[k] + (xs[k + 1] - xs[k]) * t); pz.extend(zs[k] + (zs[k + 1] - zs[k]) * t)
    px.append(xs[-1]); pz.append(zs[-1])
    stamp(px, pz, rd.get('halfWidth', 4) + 9)
ROADS = dist <= -9.0  # (the road beds themselves — dist is from the protected band, 9 m past the edge: drawn in the preview)
props = json.load(open(os.path.join(MAP, 'props.json')))
pp = []
def walk(o, key=''):
    if isinstance(o, dict):
        for k, v in o.items(): walk(v, k)
    elif isinstance(o, list) and len(o) >= 5 and all(isinstance(v, (int, float)) for v in o[:5]):
        if key == 'pine': return  # (the game seats its trees on the ground: only the set pieces keep a height)
        for k in range(0, len(o) - 4, 5): pp.append((o[k], o[k + 2]))
    elif isinstance(o, list):
        for v in o: walk(v, key)
walk(props['placements'])
stamp([p[0] for p in pp], [p[1] for p in pp], 10)
sp = meta['spawn']; stamp([sp[0]], [sp[1]], 30)
FREE = np.clip(dist / 12.0, 0, 1); FREE = FREE * FREE * (3 - 2 * FREE)
print('protected cells: %.1f %%, props %d' % (100 * (FREE < 0.99).mean(), len(pp)))

# ---- 0. ROUGH WALLS: the terrace curve left smooth, even walls — ridged noise (36 / 14 / 6 m) on the steep faces only
#      (BUTTRESSES and COULOIRS, ±~6 m) gives the water channels to follow, so the gullies cut real rock ribs ----
rng = np.random.default_rng(24)
def vnoise_grid(scale):
    m = int(N * ST / scale) + 3
    g = rng.random((m, m))
    u = np.arange(N) * ST / scale
    i = u.astype(int); f = u - i; f = f * f * (3 - 2 * f)
    a = g[i][:, i] * (1 - f)[None, :] + g[i][:, i + 1] * f[None, :]
    b = g[i + 1][:, i] * (1 - f)[None, :] + g[i + 1][:, i + 1] * f[None, :]
    return a * (1 - f)[:, None] + b * f[:, None]
ridged = sum(w * (1 - np.abs(vnoise_grid(s) * 2 - 1)) for s, w in ((36, 0.55), (14, 0.3), (6, 0.15)))
gz0, gx0 = np.gradient(H0, ST)
steep = np.clip((np.degrees(np.arctan(np.hypot(gx0, gz0))) - 28) / 17, 0, 1)
H += (ridged - 0.55) * 12.0 * steep * FREE * (H0 > WATER + 1)
# ---- 0b. ROLLING SHELVES: the terrace curve left every plateau dead flat — low swells and hollows (160 / 70 / 30 m,
#      ±~5 m) on the gentle ground, so the tops read as real upland, not a table ----
fbm = sum(w * (vnoise_grid(s) * 2 - 1) for s, w in ((160, 0.55), (70, 0.3), (30, 0.15)))
gentle0 = 1 - np.clip((np.degrees(np.arctan(np.hypot(gx0, gz0))) - 10) / 15, 0, 1)
H += fbm * 5.0 * gentle0 * FREE * (H0 > WATER + 2)

# ---- 1. hydraulic droplets (cell units: 1 cell = ST m; heights in m) ----
INERTIA, CAP, MIN_SLOPE, ERODE, DEPOSIT, EVAP, GRAV, STEPS = 0.08, 6.0, 0.02, 0.45, 0.25, 0.02, 4.0, 80
def drops(n):
    global H
    px = rng.uniform(1, N - 2, n); pz = rng.uniform(1, N - 2, n)
    dx = np.zeros(n); dz = np.zeros(n); vel = np.ones(n); water = np.ones(n); sed = np.zeros(n)
    alive = np.ones(n, bool)
    flat = H.ravel()
    for _ in range(STEPS):
        idx = np.nonzero(alive)[0]
        if idx.size == 0: break
        x, z = px[idx], pz[idx]
        i = z.astype(int); j = x.astype(int); fz = z - i; fx = x - j
        h00 = H[i, j]; h01 = H[i, j + 1]; h10 = H[i + 1, j]; h11 = H[i + 1, j + 1]
        gx = (h01 - h00) * (1 - fz) + (h11 - h10) * fz
        gz = (h10 - h00) * (1 - fx) + (h11 - h01) * fx
        h = h00 * (1 - fx) * (1 - fz) + h01 * fx * (1 - fz) + h10 * (1 - fx) * fz + h11 * fx * fz
        ndx = dx[idx] * INERTIA - gx * (1 - INERTIA); ndz = dz[idx] * INERTIA - gz * (1 - INERTIA)
        l = np.hypot(ndx, ndz); still = l < 1e-9
        l[still] = 1
        ndx /= l; ndz /= l
        nx = x + ndx; nz = z + ndz
        out = still | (nx < 1) | (nz < 1) | (nx >= N - 2) | (nz >= N - 2)
        nxc = np.clip(nx, 1, N - 2.001); nzc = np.clip(nz, 1, N - 2.001)
        ii = nzc.astype(int); jj = nxc.astype(int); gz2 = nzc - ii; gx2 = nxc - jj
        nh = H[ii, jj] * (1 - gx2) * (1 - gz2) + H[ii, jj + 1] * gx2 * (1 - gz2) + H[ii + 1, jj] * (1 - gx2) * gz2 + H[ii + 1, jj + 1] * gx2 * gz2
        dh = nh - h
        s = sed[idx]; w = water[idx]; v = vel[idx]
        cap = np.maximum(-dh, MIN_SLOPE) * v * w * CAP
        dep = (s > cap) | (dh > 0)
        amt = np.where(dep, np.where(dh > 0, np.minimum(dh, s), (s - cap) * DEPOSIT), -np.minimum((cap - s) * ERODE, -dh))
        # (droplets step together: many can hit one cell at once — each moves ≤ 0.08 m per step, or they dig runaway pits)
        amt = np.clip(np.where(out, 0.0, amt), -0.12, 0.1)
        # the four corners at the OLD position, bilinear weights, protected cells untouched
        f = FREE[i, j]
        amt = amt * f
        wts = ((1 - fx) * (1 - fz), fx * (1 - fz), (1 - fx) * fz, fx * fz)
        for (oi, oj), wt in zip(((0, 0), (0, 1), (1, 0), (1, 1)), wts):
            np.add.at(flat, (i + oi) * N + (j + oj), amt * wt)
        sed[idx] = s - amt
        vel[idx] = np.minimum(np.sqrt(np.maximum(0.0, v * v - dh * GRAV)), 6.0)
        water[idx] = w * (1 - EVAP)
        px[idx] = nx; pz[idx] = nz; dx[idx] = ndx; dz[idx] = ndz
        alive[idx[out]] = False
for b in range(120):
    drops(30000)
    if b % 20 == 19: print('droplets batch', b + 1, 'max change %.2f m' % np.abs(H - H0).max())

# ---- 2. thermal (talus) ----
TALUS = math.tan(math.radians(42)) * ST
for it in range(12):
    moved = np.zeros_like(H)
    for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nb = np.roll(np.roll(H, di, 0), dj, 1)
        d = H - nb - TALUS
        m = np.where(d > 0, d * 0.08, 0.0) * FREE
        moved -= m
        moved += np.roll(np.roll(m, -di, 0), -dj, 1)
    H += moved
# (edges: the rolls wrapped — keep the border as built)
H[:2, :] = H0[:2, :]; H[-2:, :] = H0[-2:, :]; H[:, :2] = H0[:, :2]; H[:, -2:] = H0[:, -2:]

# ---- the droplets pit gentle ground in 2–4 m dimples: there the change is blurred (~6 m) — gullies stay on the slopes ----
def blur(a, s):
    r = int(3 * s); k = np.exp(-0.5 * (np.arange(-r, r + 1) / s) ** 2); k /= k.sum()
    a = np.apply_along_axis(lambda v: np.convolve(np.pad(v, r, mode='edge'), k, 'valid'), 1, a)
    return np.apply_along_axis(lambda v: np.convolve(np.pad(v, r, mode='edge'), k, 'valid'), 0, a)
dH = H - H0
gentle = 1 - np.clip((np.degrees(np.arctan(np.hypot(gx0, gz0))) - 12) / 16, 0, 1)
H = H0 + dH * (1 - gentle) + blur(dH, 3.0) * gentle
# ---- water stays water, land stays land, protected cells exact ----
wet = H0 < WATER
H = np.where(wet, np.minimum(H, WATER - 0.3), np.maximum(H, WATER + 0.3))
H = H0 + (H - H0) * FREE
d = H - H0
print('change: mean |dh| %.2f m, p99 %.2f m, max cut %.2f m, max fill %.2f m' % (np.abs(d).mean(), np.percentile(np.abs(d), 99), -d.min(), d.max()))
lo, rngH = G['min'], G['range']
q = np.clip((H - OFF - lo) / rngH, 0, 1)
(q * 65535).round().astype('<u2').tofile(os.path.join(OUT, 'heights_eroded.bin'))
np.save(os.path.join(OUT, 'H0.npy'), H0.astype(np.float32)); np.save(os.path.join(OUT, 'H1.npy'), H.astype(np.float32)); np.save(os.path.join(OUT, 'roads.npy'), ROADS)
if WRITE:
    (q * 65535).round().astype('<u2').tofile(os.path.join(MAP, 'heights.bin'))
    print('wrote', os.path.join(MAP, 'heights.bin'))
print('done ->', OUT)
