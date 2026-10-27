# OVER THE HILL — the valley map's terrain (Blender's Python + numpy; no scipy needed).
#
#   blender -b --factory-startup --python scripts/oth/terrain.py -- [OUT=public/oth/valley] [PREVIEW=<dir>] [SEED=1]
#
# A 4 km playable valley inside a 16 km world: rolling meadow hills, a river winding south out of a mountain lake, a
# few massifs to climb inside the box and a ring of big ridged mountains round it for the skyline. Built as real
# terrain (macro shape → droplet erosion → 2 m detail → valley / river / lake carving), then baked to:
#   height.bin  Uint16 2049², 2 m, the playable box [-2048, 2048]²        m = v / 65535 · range + min
#   far.bin     Uint16 1025², 16 m, the whole world [-8192, 8192]²       (inside the box: the box's own heights)
#   trail.bin   R8 2049², 2 m, the box: distance to the nearest dirt track's centre line (0..8 m)
#   mask.bin    RGBA8 1025², 4 m, the box: R rock, G dryness (0 lush green → 1 golden straw), B wet / flow (≤ 0.85;
#               1 = open water), A forest
#   meta.json   grids, water (lake + river centre line with its surface heights), spawn
# PREVIEW=<dir> also writes top-down hillshades (inner.png, far.png) through Blender's image API.
import sys, os, json, time, math
import numpy as np

ARGS = dict(a.split('=', 1) for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []) if '=' in a)
OUT = ARGS.get('OUT', 'public/oth/valley')
PREVIEW = ARGS.get('PREVIEW')
SEED = int(ARGS.get('SEED', 1))
T0 = time.time()
def log(*a): print(f'[{time.time() - T0:5.1f}s]', *a, flush=True)

HALF = 2048.0          # the box
FAR_HALF = 8192.0      # the world
N_IN = 2049            # 2 m
N_MID = 1025           # 4 m (erosion, masks)
N_FAR = 1025           # 16 m
LAKE_LEVEL = 58.0

# ---------------------------------------------------------------------------------------------------------- noise
def hash2(ix, iz, s):
    h = (ix * 374761393 + iz * 668265263 + (s * 144665 + 7)) & 0xffffffff
    h = ((h ^ (h >> 13)) * 1274126177) & 0xffffffff
    return h ^ (h >> 16)

def gnoise(x, z, s):
    """Gradient noise, ~[-1, 1]."""
    fx0 = np.floor(x); fz0 = np.floor(z)
    fx = x - fx0; fz = z - fz0
    ix = fx0.astype(np.int64); iz = fz0.astype(np.int64)
    def g(dx, dz):
        a = (hash2(ix + dx, iz + dz, s) & 1023) * (2 * np.pi / 1024)
        return np.cos(a) * (fx - dx) + np.sin(a) * (fz - dz)
    ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
    uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10)
    a = g(0, 0); b = g(1, 0); a += (b - a) * ux
    c = g(0, 1); d = g(1, 1); c += (d - c) * ux
    return (a + (c - a) * uz) * 1.4

_C, _S = math.cos(0.65), math.sin(0.65)
def fbm(x, z, s, octaves, gain=0.5, lac=2.03):
    tot = 0.0; amp = 1.0; norm = 0.0
    for o in range(octaves):
        tot = tot + amp * gnoise(x, z, s + o * 101)
        norm += amp
        x, z = (x * _C - z * _S) * lac, (x * _S + z * _C) * lac
        amp *= gain
    return tot / norm

def ridged(x, z, s, octaves, gain=0.5, lac=2.03):
    """Ridged multifractal, 0..1 (sharp crests, eroded-looking valleys between)."""
    tot = 0.0; amp = 0.5; w = 1.0; norm = 0.0
    for o in range(octaves):
        n = 1.0 - np.abs(gnoise(x, z, s + o * 131))
        n = n * n * w
        w = np.clip(n * 2.0, 0.0, 1.0)
        tot = tot + n * amp
        norm += amp
        x, z = (x * _C - z * _S) * lac, (x * _S + z * _C) * lac
        amp *= gain
    return tot / norm

def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)

def blur(a, r):
    """Box blur, radius r cells, twice (≈ gaussian), edges clamped."""
    for _ in range(2):
        for ax in (0, 1):
            p = np.pad(a, [((r + 1, r) if k == ax else (0, 0)) for k in range(2)], mode='edge')
            c = np.cumsum(p, axis=ax)
            if ax == 0: a = (c[2 * r + 1:] - c[:-2 * r - 1]) / (2 * r + 1)
            else: a = (c[:, 2 * r + 1:] - c[:, :-2 * r - 1]) / (2 * r + 1)
    return a

def grid(n, half):
    v = np.linspace(-half, half, n)
    return np.meshgrid(v, v)  # X[j, i] = x_i, Z[j, i] = z_j

def bilinear(H, half, x, z):
    n = H.shape[0]; step = 2 * half / (n - 1)
    fx = np.clip((x + half) / step, 0, n - 1.0001); fz = np.clip((z + half) / step, 0, n - 1.0001)
    i = fx.astype(np.int64); j = fz.astype(np.int64); tx = fx - i; tz = fz - j
    a = H[j, i] * (1 - tx) + H[j, i + 1] * tx
    b = H[j + 1, i] * (1 - tx) + H[j + 1, i + 1] * tx
    return a * (1 - tz) + b * tz

def up2(H):
    """2× upsample (n → 2n−1) with Catmull–Rom midpoints, separable."""
    def axis(a, ax):
        a = np.moveaxis(a, ax, 0)
        n = a.shape[0]
        out = np.empty((2 * n - 1,) + a.shape[1:], a.dtype)
        out[0::2] = a
        p = np.concatenate([a[:1], a, a[-1:]], 0)
        out[1::2] = (-p[0:n - 1] + 9 * p[1:n] + 9 * p[2:n + 1] - p[3:n + 2]) / 16
        return np.moveaxis(out, 0, ax)
    return axis(axis(H, 0), 1)

# ---------------------------------------------------------------------------------------------------------- layout
# The valley: south (s = 0, outside the box) → north, ending in the lake. x east, z south (forward −z = north).
VALLEY = np.array([(420, 2600), (300, 2050), (150, 1550), (-120, 980), (20, 420), (-60, -120), (-280, -560),
                   (-180, -1000), (-330, -1380)], float)
LAKE = dict(cx=-380.0, cz=-1520.0, rx=360.0, rz=250.0, rot=0.35)
# TREKKING HILLS (the user, 2026-10-26: "hills trekking places like exactly in OTH"): big rocky hills inside the box
# (x, z, rise m, radius m) — their upper slopes stepped into crawlable rock LEDGES at 2 m (below), tracks up to them.
TREK = [(840, -560, 135, 380), (-1150, -640, 150, 400), (920, 1000, 115, 340), (-1000, 260, 110, 320)]
MASSIFS = [(1250, -980, 400, 430), (-1380, -1150, 330, 380), (-1480, 900, 250, 360), (1380, 1150, 230, 380),
           (650, -1800, 300, 340), (-900, 1750, 170, 300), (1650, 150, 210, 330)]

def spline(P, step=8.0):
    """Catmull–Rom through P, resampled every ~step m."""
    pts = []
    Q = np.vstack([P[0] * 2 - P[1], P, P[-1] * 2 - P[-2]])
    for k in range(1, len(Q) - 2):
        p0, p1, p2, p3 = Q[k - 1], Q[k], Q[k + 1], Q[k + 2]
        m = max(2, int(np.hypot(*(p2 - p1)) / step))
        for t in np.linspace(0, 1, m, endpoint=False):
            t2, t3 = t * t, t * t * t
            pts.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    pts.append(P[-1])
    return np.array(pts)

def polyline_field(X, Z, L, reach):
    """Distance to the polyline L and the arc length of the nearest point, for the grid X, Z (windowed per segment)."""
    D = np.full(X.shape, 1e9); S = np.zeros(X.shape)
    acc = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(L, axis=0).T))])
    xs = X[0]; zs = Z[:, 0]
    for k in range(len(L) - 1):
        a, b = L[k], L[k + 1]
        i0, i1 = np.searchsorted(xs, min(a[0], b[0]) - reach), np.searchsorted(xs, max(a[0], b[0]) + reach)
        j0, j1 = np.searchsorted(zs, min(a[1], b[1]) - reach), np.searchsorted(zs, max(a[1], b[1]) + reach)
        if i1 <= i0 or j1 <= j0: continue
        x = X[j0:j1, i0:i1]; z = Z[j0:j1, i0:i1]
        ab = b - a; l2 = ab @ ab
        t = np.clip(((x - a[0]) * ab[0] + (z - a[1]) * ab[1]) / l2, 0, 1)
        d = np.hypot(x - a[0] - t * ab[0], z - a[1] - t * ab[1])
        dd = D[j0:j1, i0:i1]; m = d < dd
        dd[m] = d[m]
        S[j0:j1, i0:i1][m] = (acc[k] + t * np.sqrt(l2))[m]
    return D, S, acc[-1]

# THE VALLEY BENDS (2026-10-27, the user: "ours look flat, all places visible — they have something different"): a
# straight 3 km corridor showed the whole valley from anywhere in it. It now swings ±120 m (a ~1 km wavelength, a
# shorter harmonic over it) and a SPUR of the hillside reaches into the inside of every bend (below): rounding each
# one opens the next reach — Over the Hill's (and every real river valley's) interlocking spurs. The ends stay put.
def meander(L):
    t = np.gradient(L, axis=0); t /= np.linalg.norm(t, axis=1)[:, None]
    nrm = np.stack([-t[:, 1], t[:, 0]], 1)
    s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(L, axis=0).T))])
    fade = smoothstep(150, 650, s) * (1 - smoothstep(s[-1] - 520, s[-1] - 120, s))
    off = (120 * np.sin(s / 1000 * 2 * np.pi + 1.9) + 40 * np.sin(s / 430 * 2 * np.pi + 0.4)) * fade
    return L + nrm * off[:, None], off, nrm, s
VALLEY_L, VALLEY_OFF, VALLEY_N, VALLEY_S = meander(spline(VALLEY))
VALLEY_C = meander(spline(VALLEY, 40.0))[0]  # (coarse: wide distance fields)
# the river meanders inside the valley floor (two harmonics; flat into the lake)
def river_line():
    L = VALLEY_L
    t = np.gradient(L, axis=0); t /= np.linalg.norm(t, axis=1)[:, None]
    nrm = np.stack([-t[:, 1], t[:, 0]], 1)
    s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(L, axis=0).T))])
    fade = smoothstep(0, 200, s) * (1 - smoothstep(s[-1] - 260, s[-1], s))
    off = (22 * np.sin(s / 410 * 2 * np.pi + 0.7) + 9 * np.sin(s / 150 * 2 * np.pi + 2.1)) * fade  # (the valley bends now: the river keeps to its floor)
    return L + nrm * off[:, None]
RIVER_L = river_line()
_racc = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(RIVER_L, axis=0).T))])
RIVER_LEN = _racc[-1]
def river_surface(s):
    """The river's water level along its length: 24 m at the south exit → the lake's level at the north end."""
    u = np.clip(s / RIVER_LEN, 0, 1)
    return 24.0 + (LAKE_LEVEL - 0.15 - 24.0) * u ** 1.25
def river_halfwidth(s):
    return 6.5 + 3.5 * np.clip(1 - s / RIVER_LEN, 0, 1)

# ---------------------------------------------------------------------------------------------------------- shape
def macro(X, Z, octave_cut=0):
    """The landform before erosion: rolling hills everywhere, mountain RANGES where an irregular low-frequency mask
    says so (a few inside the box, all of the world round it), the valley corridor kept open."""
    wx = X + 650 * fbm(X / 4200, Z / 4200, SEED + 11, 3) + 140 * fbm(X / 900, Z / 900, SEED + 13, 2)
    wz = Z + 650 * fbm(X / 4200 + 5.2, Z / 4200 + 1.3, SEED + 12, 3) + 140 * fbm(X / 900 + 2.7, Z / 900, SEED + 14, 2)
    r = np.hypot(wx, wz * 0.92)
    Dv, _, _ = polyline_field(X, Z, VALLEY_C, 1200)
    # rolling hills (soft, broad)
    roll = 95 + 85 * fbm(wx / 1500, wz / 1500, SEED + 1, 4, gain=0.4) + 26 * fbm(wx / 560, wz / 560, SEED + 2, 2, gain=0.4)
    # where the ranges stand: blobs of a low-frequency noise inside, everything beyond the ring; never the valley
    ring = smoothstep(1700, 4600, r)
    blob = smoothstep(-0.12, 0.55, fbm(wx / 2100 + 3.1, wz / 2100 - 1.7, SEED + 6, 3))
    mask = np.clip(blob * 0.85 + ring, 0, 1) * smoothstep(260, 1100, Dv)
    # the ranges themselves: ridged crests (distinct peaks, deep saddles), much taller beyond the box
    rid = ridged(wx / 2900, wz / 2900, SEED + 3, 5 + octave_cut)  # (big simple peaks and ridges; the erosion carves the rest)
    tall = 380 + 1150 * ring
    mount = 100 + tall * (0.18 * mask + 0.82 * rid ** 1.7) + 50 * fbm(wx / 900, wz / 900, SEED + 4, 2)
    h = roll + mask * np.maximum(mount - roll, 0)
    for cx, cz, Hh, R in TREK:
        q = ((X - cx) ** 2 + (Z - cz) ** 2) / (R * R)
        h = h + Hh * np.exp(-1.4 * q) * (0.75 + 0.45 * ridged((X - cx) / 260, (Z - cz) / 260, SEED + 61, 3))
    # far beyond: let it settle into lower ranges (no wall at the world's edge)
    h = h - 500 * smoothstep(6200, 8200, np.maximum(np.abs(X), np.abs(Z)))
    return h

def erode(H, cell, drops, batch=60000, steps=48, inertia=0.12, cap=1.4, min_slope=0.02, erode_r=0.035,
          depo_r=0.08, evap=0.025, grav=6.0, seed=1):
    """Vectorised droplet erosion (heights in m, one cell per step). Returns (H, flow) — flow = water passed per cell."""
    rng = np.random.default_rng(seed)
    n = H.shape[0]
    H = H.copy()
    flow = np.zeros_like(H)
    done = 0
    while done < drops:
        N = min(batch, drops - done); done += N
        before = H.copy()
        px = rng.uniform(1, n - 2, N); pz = rng.uniform(1, n - 2, N)
        dx = np.zeros(N); dz = np.zeros(N); vel = np.ones(N); water = np.ones(N); sed = np.zeros(N)
        live = np.ones(N, bool)
        for _ in range(steps):
            idx = np.nonzero(live)[0]
            if len(idx) == 0: break
            x = px[idx]; z = pz[idx]
            i = x.astype(np.int64); j = z.astype(np.int64); fx = x - i; fz = z - j
            h00 = H[j, i]; h10 = H[j, i + 1]; h01 = H[j + 1, i]; h11 = H[j + 1, i + 1]
            gx = (h10 - h00) * (1 - fz) + (h11 - h01) * fz
            gz = (h01 - h00) * (1 - fx) + (h11 - h10) * fx
            h = (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz
            ddx = dx[idx] * inertia - gx * (1 - inertia); ddz = dz[idx] * inertia - gz * (1 - inertia)
            L = np.hypot(ddx, ddz); flat = L < 1e-9
            L[flat] = 1; ang = rng.uniform(0, 2 * np.pi, flat.sum()); ddx[flat] = np.cos(ang); ddz[flat] = np.sin(ang)
            ddx /= L; ddz /= L
            nx = x + ddx; nz = z + ddz
            out = (nx < 1) | (nx > n - 2) | (nz < 1) | (nz > n - 2)
            nxc = np.clip(nx, 1, n - 2.001); nzc = np.clip(nz, 1, n - 2.001)
            i2 = nxc.astype(np.int64); j2 = nzc.astype(np.int64); fx2 = nxc - i2; fz2 = nzc - j2
            nh = (H[j2, i2] * (1 - fx2) + H[j2, i2 + 1] * fx2) * (1 - fz2) + (H[j2 + 1, i2] * (1 - fx2) + H[j2 + 1, i2 + 1] * fx2) * fz2
            dh = nh - h
            w = water[idx]; v = vel[idx]; s = sed[idx]
            capc = np.maximum(-dh, min_slope * cell) * v * w * cap
            dep = (s > capc) | (dh > 0)
            amt = np.where(dep, np.where(dh > 0, np.minimum(dh, s), (s - capc) * depo_r),
                           -np.minimum((capc - s) * erode_r, np.maximum(-dh, 0)))
            s = s - amt
            w00 = (1 - fx) * (1 - fz); w10 = fx * (1 - fz); w01 = (1 - fx) * fz; w11 = fx * fz
            np.add.at(H, (j, i), amt * w00); np.add.at(H, (j, i + 1), amt * w10)
            np.add.at(H, (j + 1, i), amt * w01); np.add.at(H, (j + 1, i + 1), amt * w11)
            np.add.at(flow, (j, i), w)
            vel[idx] = np.minimum(np.sqrt(np.maximum(v * v - dh * grav / cell, 0.0)), 6.0)  # (capped: no runaway)
            water[idx] = w * (1 - evap)
            sed[idx] = s
            dx[idx] = ddx; dz[idx] = ddz; px[idx] = nx; pz[idx] = nz
            live[idx[out]] = False
        # a brush: spread this batch's change over its neighbours (no single-cell pits / spikes)
        # (and clamped: many droplets of one vectorised batch can hit one channel cell at once and overshoot)
        d = np.clip(H - before, -0.08 * cell, 0.08 * cell)
        H = before + blur(d, 1)
    return H, flow

def carve(X, Z, H):
    """Valley floor, river channel, lake — on any grid (the box at 2 m, the world at 16 m)."""
    reach = 700
    Dv, Sv, Lv = polyline_field(X, Z, VALLEY_L, reach)
    Dr, Sr, _ = polyline_field(X, Z, RIVER_L, 120)
    surf = river_surface(Sr)
    # valley: a wide meadow floor a little above the river, rising gently, then the hills
    wobble = 50 * fbm(X / 900, Z / 900, SEED + 21, 3)
    # (INCLINED, not a flat floor — the user: "all so plain, the terrain needs an inclined look"): a narrow flat strip
    # by the river, then the valley's sides rise steadily (~9–14 %, the grade wandering) into the hills
    inner = 40 + 0.4 * wobble
    w = 1 - smoothstep(inner + 60, inner + 520, Dv)
    grade = 0.115 + 0.035 * fbm(X / 400, Z / 400, SEED + 24, 2)
    floor = river_surface(np.clip(Sv * RIVER_LEN / Lv, 0, RIVER_LEN)) + 1.6 + grade * np.maximum(Dv - inner, 0) \
        + 3.0 * fbm(X / 140, Z / 140, SEED + 22, 3) * smoothstep(15, 60, Dr)
    w = w * w * (3 - 2 * w)
    H = H + (floor - H) * w
    # river channel + banks
    hw = river_halfwidth(Sr)
    u = Dr / hw
    # one continuous profile (m over the water): deep in the middle, a SLOPED bank through the water line at u ≈ 1.2
    # (~0.3 m per m — on a flat shore a few cm of mesh error become a zigzag water line), then the meadow
    cut = surf - 1.9 + 1.0 * smoothstep(0.0, 0.75, u) + 1.7 * smoothstep(0.7, 1.7, u) + 1.1 * smoothstep(1.6, 3.2, u)
    k = 1 - smoothstep(2.2, 3.6, u)  # fades out: no step where the banks meet the floor
    H = H + (np.minimum(H, cut) - H) * k
    # lake: an elliptic bowl with a ragged shore
    c, s = math.cos(LAKE['rot']), math.sin(LAKE['rot'])
    lx = (X - LAKE['cx']) * c + (Z - LAKE['cz']) * s; lz = -(X - LAKE['cx']) * s + (Z - LAKE['cz']) * c
    q = np.hypot(lx / LAKE['rx'], lz / LAKE['rz']) * (1 + 0.13 * fbm(X / 260, Z / 260, SEED + 23, 3))
    # (in metres from the shore: a bowl ~11 m deep, a sloped beach through the water line, then the meadow)
    d = (q - 1) * math.sqrt(LAKE['rx'] * LAKE['rz'])
    # (beyond the beach the cut keeps climbing at ~25 %: it only trims ground steeper than that — no rim, no cliff)
    cut = LAKE_LEVEL - 0.8 - 10.5 * smoothstep(-8, -170, d) + 1.7 * smoothstep(-8, 7, d) + 7.5 * smoothstep(5, 160, d) ** 1.3 \
        + 0.25 * np.maximum(d - 60, 0)
    k = 1 - smoothstep(220, 340, d)
    H = H + (np.minimum(H, cut) - H) * k
    return H, Dv, Dr, q, hw

# ---------------------------------------------------------------------------------------------------------- build
log('box macro (4 m)')
Xm, Zm = grid(N_MID, HALF)
Hm0 = macro(Xm, Zm)
Hm = Hm0
log(f'  range {Hm.min():.0f}..{Hm.max():.0f}')
Hm, flow_m = erode(Hm, 4.0, int(ARGS.get('DROPS', 1600000)), seed=SEED)
# (the Over-the-Hill look: gullies, ridges and fans on the steep and high ground; the gentle hills keep only the
#  erosion's broad shaping — on a soft slope the droplets' parallel channels read as ripples, not erosion)
_gz, _gx = np.gradient(Hm0, 4.0)
_w = np.clip(smoothstep(0.12, 0.4, np.hypot(_gx, _gz)) + smoothstep(180, 340, Hm0), 0, 1)
_d = Hm - Hm0
Hm = Hm0 + blur(_d, 1) * _w + blur(_d, 4) * (1 - _w)
log(f'  eroded: range {Hm.min():.0f}..{Hm.max():.0f}')

log('box detail (2 m)')
Hi = up2(Hm)
Xi, Zi = grid(N_IN, HALF)
gy, gx = np.gradient(Hi, 2.0)
slope = np.hypot(gx, gy)
del gx, gy
Hi, Dv, Dr, Lq, Hw = carve(Xi, Zi, Hi)

# INTERLOCKING SPURS: at each bend's apex a ridge runs down from the hillside on the INSIDE of the bend to a rounded
# nose ~70 m from the valley's line (the river wraps round it): 16 m over the valley side at the nose, ~50 m at the
# shoulder, 55–100 m half width, bending a little downstream; the alternate sides' spurs overlap in plan, so the valley
# is never seen end to end. Kept off the water and out of the spawn's surroundings.
log('valley spurs')
_ss = np.searchsorted(_racc, RIVER_LEN * 0.38)
_sp_est = RIVER_L[_ss]
_ext = [k for k in range(1, len(VALLEY_OFF) - 1) if abs(VALLEY_OFF[k]) > 55
        and abs(VALLEY_OFF[k]) >= abs(VALLEY_OFF[k - 1]) and abs(VALLEY_OFF[k]) >= abs(VALLEY_OFF[k + 1])
        and max(abs(VALLEY_L[k, 0]), abs(VALLEY_L[k, 1])) < 1850]
SPURS = []
rng_s = np.random.default_rng(SEED + 121)
spur_add = np.zeros_like(Hi)
for k in _ext:
    A = VALLEY_L[k]; side = -np.sign(VALLEY_OFF[k]); n_ = VALLEY_N[k] * side
    tg = VALLEY_L[min(k + 1, len(VALLEY_L) - 1)] - VALLEY_L[max(k - 1, 0)]; tg = tg / np.linalg.norm(tg)
    nose_d = rng_s.uniform(62, 85); L_ = rng_s.uniform(380, 520)
    nose = A + n_ * nose_d
    root = A + n_ * (nose_d + L_) + tg * rng_s.uniform(-60, 90)  # (the crest leans a little downstream)
    SPURS.append((float(nose[0]), float(nose[1]), float(root[0]), float(root[1])))
    W = 140
    lo = np.minimum(nose, root) - W; hi_ = np.maximum(nose, root) + W
    i0, i1 = np.searchsorted(Xi[0], lo[0]), np.searchsorted(Xi[0], hi_[0])
    j0, j1 = np.searchsorted(Zi[:, 0], lo[1]), np.searchsorted(Zi[:, 0], hi_[1])
    Xw, Zw = Xi[j0:j1, i0:i1], Zi[j0:j1, i0:i1]
    ax = (root - nose) / np.linalg.norm(root - nose)
    u = (Xw - nose[0]) * ax[0] + (Zw - nose[1]) * ax[1]          # along the crest, 0 at the nose
    v = -(Xw - nose[0]) * ax[1] + (Zw - nose[1]) * ax[0]         # across it
    v = v - 18 * np.sin(np.clip(u / L_, 0, 1) * np.pi) * side    # (the crest bows: no ruler-straight ridge)
    t = np.clip(u / L_, 0, 1)
    hs = (14 + 32 * smoothstep(0.0, 0.55, t)) * (0.85 + 0.3 * fbm(Xw / 90, Zw / 90, SEED + 122 + k, 2))
    w = 70 + 60 * t  # (flanks ≤ ~45 %: rolling, and a track can climb one without switchbacks the smoothing would cut)
    prof = np.exp(-1.4 * (v / w) ** 2) * smoothstep(-40, 30, u) * (1 - smoothstep(0.78, 1.0, u / L_))
    spur_add[j0:j1, i0:i1] = np.maximum(spur_add[j0:j1, i0:i1], hs * prof)
spur_keep = smoothstep(24, 75, Dr) * smoothstep(1.2, 1.7, Lq) * smoothstep(140, 260, np.hypot(Xi - _sp_est[0], Zi - _sp_est[1]))
# (and clear of the three river bridges (below): their ramps and the tracks up from them stay on the valley floor — a
#  spur beside one had its connecting track climbing its flank at 78 %)
for _f in (0.2, 0.47, 0.74):
    _bp = RIVER_L[np.searchsorted(_racc, RIVER_LEN * _f)]
    spur_keep = spur_keep * smoothstep(150, 300, np.hypot(Xi - _bp[0], Zi - _bp[1]))
Hi = Hi + spur_add * spur_keep
log(f'  {len(SPURS)} spurs')

# RIDGES across the side country (the same ask): long, bending ridges (350–800 m, crests 28–55 m over the ground,
# 70–120 m half width) that cut the land beside the valley into pockets — each with a SADDLE or two (a dip to ~40 %
# of its height) where a track goes over: the next pocket only shows from the top of the pass.
log('ridges')
rng_r = np.random.default_rng(SEED + 125)
RIDGES = []
ridge_add = np.zeros_like(Hi)
tries = 0
while len(RIDGES) < 12 and tries < 400:
    tries += 1
    cx, cz = rng_r.uniform(-1750, 1750, 2)
    jj, ii = int(round((cz + HALF) / 2)), int(round((cx + HALF) / 2))
    if Dv[jj, ii] < 330 or Dr[jj, ii] < 260 or Lq[jj, ii] < 2.0: continue
    if math.hypot(cx - _sp_est[0], cz - _sp_est[1]) < 420: continue
    if any(math.hypot(cx - a, cz - b) < 520 for a, b, _ in RIDGES): continue
    if any(math.hypot(cx - a, cz - b) < R * 1.1 for a, b, _, R in TREK): continue
    L_ = rng_r.uniform(350, 800); th = rng_r.uniform(0, math.pi)
    # the crest: 6 points along th, each nudged sideways (a bending ridge)
    P = []
    for k in range(6):
        s_ = (k / 5 - 0.5) * L_
        P.append((cx + math.cos(th) * s_ - math.sin(th) * rng_r.uniform(-45, 45), cz + math.sin(th) * s_ + math.cos(th) * rng_r.uniform(-45, 45)))
    crest = spline(np.array(P), 8.0)
    h_ = rng_r.uniform(28, 55); w_ = max(rng_r.uniform(70, 120), 2.3 * h_)  # (flanks ≤ ~45 %)
    D_, S_, Lc = polyline_field(Xi, Zi, crest, w_ * 2.2)
    u = np.clip(S_ / Lc, 0, 1)
    env = np.sin(np.pi * u) ** 0.6
    sad = np.ones_like(u)
    for _ in range(1 + int(rng_r.integers(2))):
        s0 = rng_r.uniform(0.25, 0.75)
        sad = sad * (1 - 0.6 * np.exp(-((u - s0) * Lc / 55) ** 2))
    hc = h_ * env * sad * (0.85 + 0.3 * fbm(Xi / 110, Zi / 110, SEED + 126 + len(RIDGES), 2))
    ridge_add = np.maximum(ridge_add, np.where(D_ < 1e8, hc * np.exp(-1.3 * (D_ / w_) ** 2), 0))
    RIDGES.append((cx, cz, L_))
ridge_keep = smoothstep(60, 200, Dr) * smoothstep(1.5, 2.2, Lq) * smoothstep(300, 450, np.hypot(Xi - _sp_est[0], Zi - _sp_est[1]))
Hi = Hi + ridge_add * ridge_keep
log(f'  {len(RIDGES)} ridges')

# KNOLLS + HUMMOCKS (the user: "it's like a desert — nothing around him for 500 m; need more hills, bumps"): OTH's
# ground is never flat — small rounded knolls (4–14 m, 20–60 m across) scattered over the meadows and hummocks
# (~1–2.5 m, 10–40 m) everywhere, all kept off the water (the tracks are carved later, over them)
log('knolls + hummocks')
rng_k = np.random.default_rng(SEED + 131)
bump = 3.3 * fbm(Xi / 28, Zi / 28, SEED + 132, 2) + 1.6 * fbm(Xi / 11, Zi / 11, SEED + 133, 2) + 5.0 * fbm(Xi / 70, Zi / 70, SEED + 134, 2)
for _ in range(420):  # (the user, 2026-10-26: "more bumps and small hills all over the place")
    kx, kz = rng_k.uniform(-1850, 1850, 2)
    kr, kh = rng_k.uniform(20, 60), rng_k.uniform(4, 14)
    i0, i1 = np.searchsorted(Xi[0], kx - kr * 2), np.searchsorted(Xi[0], kx + kr * 2)
    j0, j1 = np.searchsorted(Zi[:, 0], kz - kr * 2), np.searchsorted(Zi[:, 0], kz + kr * 2)
    q = ((Xi[j0:j1, i0:i1] - kx) ** 2 + (Zi[j0:j1, i0:i1] - kz) ** 2) / (kr * kr)
    bump[j0:j1, i0:i1] += kh * np.exp(-1.8 * q)
dry_ = smoothstep(18, 70, Dr) * smoothstep(1.15, 1.6, Lq)  # (never into the river or the lake)
Hi = Hi + bump * dry_

# MORE HILLS + CLIFFS (the user: "need multiple hills and cliffs, like OTH"): ~30 rounded hills (20–70 m, 110–260 m
# across) off the valley floor, and ~14 CLIFFS — an escarpment: one side of a line raised 12–30 m into a plateau that
# runs back 50–110 m and slopes away, the step between them a near-vertical rock face (4 m wide in a 2 m grid), its
# edge wandering, its ends fading — OTH's grey rock walls. The tracks (routed later, ≤ 30 % grade) never cross them.
log('hills + cliffs')
rng_h = np.random.default_rng(SEED + 141)
ok_ = (Dv > 170) & (Dr > 90) & (Lq > 1.8) & (np.maximum(np.abs(Xi), np.abs(Zi)) < 1800)
okj, oki = np.nonzero(ok_[::16, ::16])
def pick():
    k = rng_h.integers(len(okj)); return float(Xi[0, oki[k] * 16]), float(Zi[okj[k] * 16, 0])
HILLS, PLATEAUS = [], []
for _ in range(30):
    cx, cz = pick(); R, H_ = rng_h.uniform(110, 260), rng_h.uniform(20, 70)
    HILLS.append((cx, cz, R))
    i0, i1 = np.searchsorted(Xi[0], cx - R * 2), np.searchsorted(Xi[0], cx + R * 2)
    j0, j1 = np.searchsorted(Zi[:, 0], cz - R * 2), np.searchsorted(Zi[:, 0], cz + R * 2)
    Xw, Zw = Xi[j0:j1, i0:i1], Zi[j0:j1, i0:i1]
    q = ((Xw - cx) ** 2 + (Zw - cz) ** 2) / (R * R)
    Hi[j0:j1, i0:i1] += H_ * np.exp(-1.5 * q) * (0.8 + 0.35 * fbm(Xw / 120, Zw / 120, SEED + 150, 2)) * dry_[j0:j1, i0:i1]
# THE SPAWN'S SURROUNDINGS (the user: "the hills are still too far — I need small hills near me, rock cliffs"): a
# ring of small hills and knolls 50–380 m round the spawn and 3 low rock bluffs, all kept off the river and out of a
# 20 m pad where the car starts
_si = np.searchsorted(_racc, RIVER_LEN * 0.38)
_p = RIVER_L[_si]; _t = RIVER_L[_si + 1] - RIVER_L[_si - 1]; _t /= np.linalg.norm(_t)
SP0 = _p + np.array([-_t[1], _t[0]]) * 55
if bilinear(Hi, HALF, np.array([SP0[0]]), np.array([SP0[1]]))[0] < river_surface(RIVER_LEN * 0.38) + 0.6:
    SP0 = _p - np.array([-_t[1], _t[0]]) * 55
pad = smoothstep(18, 40, np.hypot(Xi - SP0[0], Zi - SP0[1]))
keep_ = smoothstep(26, 60, Dr) * smoothstep(1.2, 1.6, Lq) * pad
near_spots = []
for _ in range(400):
    a, d_ = rng_h.uniform(0, 2 * math.pi), rng_h.uniform(55, 380)
    x, z = SP0[0] + math.cos(a) * d_, SP0[1] + math.sin(a) * d_
    jj, ii = int(round((z + HALF) / 2)), int(round((x + HALF) / 2))
    if 0 <= jj < N_IN and 0 <= ii < N_IN and Dr[jj, ii] > 45 and Lq[jj, ii] > 1.7: near_spots.append((x, z, d_))
for k, (x, z, d_) in enumerate(near_spots[:16]):
    R, H_ = rng_h.uniform(30, 90), rng_h.uniform(6, 22) * (0.6 + 0.4 * min(1, d_ / 200))
    i0, i1 = np.searchsorted(Xi[0], x - R * 2), np.searchsorted(Xi[0], x + R * 2)
    j0, j1 = np.searchsorted(Zi[:, 0], z - R * 2), np.searchsorted(Zi[:, 0], z + R * 2)
    Xw, Zw = Xi[j0:j1, i0:i1], Zi[j0:j1, i0:i1]
    q = ((Xw - x) ** 2 + (Zw - z) ** 2) / (R * R)
    Hi[j0:j1, i0:i1] += H_ * np.exp(-1.6 * q) * (0.8 + 0.3 * fbm(Xw / 60, Zw / 60, SEED + 190 + k, 2)) * keep_[j0:j1, i0:i1]
    if k < 6: HILLS.append((x, z, R * 1.6))
NEAR_CLIFFS = [(x, z) for x, z, d_ in near_spots[16:40] if 90 < d_ < 320][:3]
CLIFFZ = np.zeros_like(Hi)
# PROPER CLIFFS (the user, 2026-10-26): 22 of them, the big ones 20–46 m tall and up to 320 m long, their edge
# bending; the FACE LAYERED — 3–5 strata, each a near-vertical riser and a narrow ledge (rock bands, like OTH's
# grey walls) — and a SCREE apron at the foot
N_CLIFF = 22
for ci_ in range(N_CLIFF + len(NEAR_CLIFFS)):
    if ci_ < N_CLIFF:
        cx, cz = pick(); th = rng_h.uniform(0, math.pi)
        big_ = ci_ < 9
        L_ = rng_h.uniform(180, 320) if big_ else rng_h.uniform(90, 230)
        h_ = rng_h.uniform(24, 46) if big_ else rng_h.uniform(12, 30)
        back = rng_h.uniform(70, 140) if big_ else rng_h.uniform(50, 110)
    else:  # (a low bluff near the spawn)
        cx, cz = NEAR_CLIFFS[ci_ - N_CLIFF]; th = rng_h.uniform(0, math.pi)
        L_, h_, back = rng_h.uniform(50, 95), rng_h.uniform(6, 12), rng_h.uniform(25, 45)
    # (the plateau's middle, behind the cliff's edge: a rock formation goes there)
    PLATEAUS.append((cx - math.sin(th) * back * 0.45, cz + math.cos(th) * back * 0.45, L_))
    W = L_ / 2 + back + 40
    i0, i1 = np.searchsorted(Xi[0], cx - W), np.searchsorted(Xi[0], cx + W)
    j0, j1 = np.searchsorted(Zi[:, 0], cz - W), np.searchsorted(Zi[:, 0], cz + W)
    Xw, Zw = Xi[j0:j1, i0:i1] - cx, Zi[j0:j1, i0:i1] - cz
    a = Xw * math.cos(th) + Zw * math.sin(th)          # along the cliff
    b = -Xw * math.sin(th) + Zw * math.cos(th)         # across it (+ = the raised side)
    b = b + rng_h.uniform(-1.6, 1.6) / L_ * a * a       # (the edge bends: a curved wall, not a ruler line)
    b = b + 7 * fbm(a / 45, b / 45 + ci_, SEED + 160 + ci_, 2) + 2.5 * fbm(a / 12, b / 12, SEED + 170 + ci_, 2)
    ends = smoothstep(L_ / 2, L_ / 2 - 35, np.abs(a))
    # the wall: n strata over a face W m deep — a riser (~1 m: near vertical) then a ledge, the bands' heights uneven
    n_ = int(min(5, 2 + h_ // 10))
    W_ = 3.0 * n_
    t_ = np.clip((b + W_ * 0.5) / W_, 0.0, 1.0)
    t_ = np.clip(t_ + 0.08 * fbm(a / 30, t_ * 3 + ci_, SEED + 175 + ci_, 2), 0.0, 1.0)
    st_ = t_ * n_; fl_ = np.floor(st_)
    face = np.minimum(1.0, (fl_ + smoothstep(0.5, 0.85, st_ - fl_)) / n_)
    plateau = smoothstep(back + 40, back, b)            # the top runs back, then slopes away
    talus = 0.15 * smoothstep(-W_ * 0.5 - 24, -W_ * 0.5, b) * (1 - face)  # (scree heaped at the foot)
    raise_ = h_ * (face * plateau + talus) * ends * (0.85 + 0.25 * fbm(a / 60, b / 60, SEED + 180 + ci_, 2))
    Hi[j0:j1, i0:i1] += raise_ * (dry_ if ci_ < N_CLIFF else keep_)[j0:j1, i0:i1]
    CLIFFZ[j0:j1, i0:i1] = np.maximum(CLIFFZ[j0:j1, i0:i1], np.maximum(
        smoothstep(-W_ * 0.5 - 3, -W_ * 0.5, b) * (1 - smoothstep(W_ * 0.5 + 1, W_ * 0.5 + 4, b)),
        0.7 * smoothstep(-W_ * 0.5 - 16, -W_ * 0.5 - 4, b) * (1 - smoothstep(W_ * 0.5 + 1, W_ * 0.5 + 4, b))) * ends)

# PONDS AND SMALL LAKES (the user, 2026-10-26: "random ponds and lakes, tracks near them, some with trees and hills
# round them — make it fuller, all explorable"): ~10 ponds (16–40 m) and 3 small lakes (55–110 m) on gentle ground
# away from the river and the big lake, one within sight of the spawn. Chosen here (the hills keep clear of them),
# carved after the hills (below): a bowl under the level its own rim allows, a sloped beach, the water a flat disc.
log('ponds + small lakes: sites')
rng_p = np.random.default_rng(SEED + 171)
H8p = blur(Hi[::4, ::4], 3)
g8pz, g8px = np.gradient(H8p, 8.0)
slope8p = blur(np.hypot(g8px, g8pz), 3)
X8p, Z8p = Xi[::4, ::4], Zi[::4, ::4]
okp = (slope8p < 0.18) & (Dr[::4, ::4] > 85) & (Lq[::4, ::4] > 2.0) & (np.maximum(np.abs(X8p), np.abs(Z8p)) < 1700) \
    & (blur(CLIFFZ[::4, ::4], 4) < 0.005)
pj_, pi_ = np.nonzero(okp)
PONDS = []  # (cx, cz, rx, rz, rot)
def try_pond(R, near=None, flat=0.085):
    for k in rng_p.permutation(len(pj_)):
        x, z = float(X8p[pj_[k], pi_[k]]), float(Z8p[pj_[k], pi_[k]])
        if slope8p[pj_[k], pi_[k]] > flat: continue
        if Dr[::4, ::4][pj_[k], pi_[k]] < 110 + R: continue
        dsp_ = math.hypot(x - SP0[0], z - SP0[1])
        if near is not None and not (near[0] <= dsp_ <= near[1]): continue
        if dsp_ < 70 + R: continue
        if any(math.hypot(x - a, z - b) < 170 + R + max(rx, rz) for a, b, rx, rz, _ in PONDS): continue
        if any(math.hypot(x - hx, z - hz) < hr * 0.7 + R for hx, hz, hr in HILLS): continue
        u_ = rng_p.random()
        PONDS.append((x, z, R * (1 + 0.25 * u_), R * (1 - 0.18 * u_), rng_p.uniform(0, math.pi)))
        return True
    return False
# (near the spawn the valley side is inclined ~12 %: those ponds sit in a hollow dug into the slope)
try_pond(24.0, (110, 340), flat=0.17)
try_pond(30.0, (300, 650), flat=0.17)
try_pond(20.0, (300, 700), flat=0.17)
for R in rng_p.uniform(55, 110, 3): try_pond(float(R), flat=0.06)
for R in rng_p.uniform(16, 40, 10): try_pond(float(R))
log(f'  {len(PONDS)} ponds / lakes')

# HIDDEN PLACES (2026-10-27, the user: "cliffs, valleys, waterfalls and hidden beautiful places, like Over the Hill and
# Genshin"): basins only seen from inside. Two FALLS BASINS — a bowl 60–75 m in radius cut into a hillside, ringed by a
# cliff wall (a banded rock riser, ~26–44 m at the back), its one way in a narrow GORGE (~24 m) facing downhill; a
# spring-fed stream on the rim spills over the back wall — from a notch the water has cut, the face behind it sheer —
# into a turquoise pool, the floor a lush flower meadow. One FLOWER HOLLOW — a soft grassy ring of hills round a meadow
# of wildflowers, its gap a grassy pass. From outside a basin is a horseshoe hill, grass and forest on its outer slopes;
# a track reaches each through its gap (below). meta.hidden: { kind, name, x, z, r, ro, open, gw, fall?, stream?, pool? }
log('hidden places')
rng_x = np.random.default_rng(SEED + 211)
HIDDEN = []
HIDZ = np.zeros_like(Hi)     # inside a basin (floor + walls): no hills, outcrops, streams
HROCK = np.zeros_like(Hi)    # the cliff walls and the gorge's walls: bare rock
HLUSH = np.zeros_like(Hi)    # the floors: lush green, no forest
HMEAD = np.zeros_like(Hi)    # a flower hollow, banks and all: grass, never the slope's bare rock
HRING = np.zeros_like(Hi)    # its rim: a ring of trees
Hb16 = blur(Hi[::8, ::8], 3)
gbz, gbx = np.gradient(Hb16, 16.0)
X16, Z16 = Xi[::8, ::8], Zi[::8, ::8]
sl16 = np.hypot(gbx, gbz)
cand_h = (Dr[::8, ::8] > 280) & (Lq[::8, ::8] > 2.3) & (Dv[::8, ::8] > 230) & (np.maximum(np.abs(X16), np.abs(Z16)) < 1600) \
    & (blur(CLIFFZ[::8, ::8], 3) < 0.003) & (sl16 > 0.06) & (sl16 < 0.22)
ch_j, ch_i = np.nonzero(cand_h)
def seg_dist(x, z, ax_, az_, bx_, bz_):
    abx, abz = bx_ - ax_, bz_ - az_; l2 = abx * abx + abz * abz or 1.0
    t = min(1.0, max(0.0, ((x - ax_) * abx + (z - az_) * abz) / l2))
    return math.hypot(x - ax_ - t * abx, z - az_ - t * abz)
def site_ok(x, z, Ro):
    if any(math.hypot(x - a, z - b) < max(rx, rz) + Ro + 120 for a, b, rx, rz, _ in PONDS): return False
    if any(math.hypot(x - a, z - b) < R * 1.25 + Ro for a, b, _, R in TREK): return False
    if any(math.hypot(x - a, z - b) < r_ * 0.6 + Ro * 0.6 for a, b, r_ in HILLS): return False
    if any(math.hypot(x - h['x'], z - h['z']) < 700 for h in HIDDEN): return False
    if any(seg_dist(x, z, *s_) < Ro + 80 for s_ in SPURS): return False
    return True
def basin(x, z, kind, name, Ri, Hb, Ro, seed_, hw_f=3.5):
    jj, ii = int(round((z + HALF) / 16)), int(round((x + HALF) / 16))
    gl = math.hypot(gbx[jj, ii], gbz[jj, ii]) or 1.0
    ox, oz = -gbx[jj, ii] / gl, -gbz[jj, ii] / gl  # (the gap faces downhill)
    cliff = kind == 'falls'
    Wr = 4.0 if cliff else 42.0                     # the riser: a banded rock wall, or a grassy bank
    cw = 16.0 if cliff else 12.0                    # the rim's flat top
    gw = 12.0 if cliff else 18.0                    # the gap's half width
    W = Ro + 30
    i0, i1 = np.searchsorted(Xi[0], x - W), np.searchsorted(Xi[0], x + W)
    j0, j1 = np.searchsorted(Zi[:, 0], z - W), np.searchsorted(Zi[:, 0], z + W)
    Xw, Zw = Xi[j0:j1, i0:i1] - x, Zi[j0:j1, i0:i1] - z
    N_ = Hi[j0:j1, i0:i1].copy()
    r = np.hypot(Xw, Zw)
    # (an irregular ring: bays and buttresses, gullies between them — no quarry-round wall)
    rr = r / (1 + 0.13 * fbm(Xw / 45, Zw / 45, SEED + seed_, 2) + 0.05 * fbm(Xw / 12, Zw / 12, SEED + seed_ + 5, 2))
    cosd = (Xw * ox + Zw * oz) / np.maximum(r, 1e-3)        # 1 toward the gap, −1 at the back
    perp = np.abs(-Xw * oz + Zw * ox)                       # off the gap's axis (front) / the fall's (back)
    back = 0.5 * (1 - cosd)
    F = float(np.median(N_[r < Ri * 0.5])) - 2.0
    # (the way out must stay drivable: the floor no more than 20 % of the gorge's length above the hillside at its mouth)
    ex_ = float(bilinear(Hi, HALF, np.array([x + ox * Ro]), np.array([z + oz * Ro]))[0])
    F = min(F, ex_ + 0.2 * (Ro - Ri))
    hvar = lambda a, b: 0.8 + 0.36 * fbm(a / 60, b / 60, SEED + seed_ + 1, 2) + 0.1 * fbm(a / 17, b / 17, SEED + seed_ + 4, 2)
    Hw = Hb * (0.6 + 0.4 * back) * hvar(Xw, Zw)  # (the rim's height wandering: crags and dips, not a level ring)
    # the waterfall's NOTCH (falls only): the floor runs on under the fall, the face behind it sheer
    alc = (1 - smoothstep(hw_f + 2, hw_f + 5, perp)) * smoothstep(-0.8, -0.95, cosd) if cliff else np.zeros_like(r)
    Rin = Ri + (Wr + 2.0) * alc
    Wre = Wr - (Wr - 1.0) * alc
    t_ = np.clip((rr - Rin) / Wre, 0, 1)
    if cliff:
        st_ = t_ * 3; fl_ = np.floor(st_)
        face = np.minimum(1.0, (fl_ + smoothstep(0.45, 0.85, st_ - fl_)) / 3)
    else:
        face = smoothstep(0, 1, t_)
    Rc = Rin + Wre + cw
    o_ = smoothstep(Rc, Ro, rr)
    wall = np.where(rr < Rc, F + Hw * face, N_ + (F + Hw - N_) * (1 - o_) ** 1.3)
    wall = wall + 2.5 * fbm(Xw / 14, Zw / 14, SEED + seed_ + 6, 2) * smoothstep(Rin + Wre * 0.8, Rin + Wre + 3, rr) * (1 - o_)
    floor = F - 0.8 * np.clip(1 - (rr / Ri) ** 2, 0, 1) + 0.5 * fbm(Xw / 25, Zw / 25, SEED + seed_ + 2, 2)
    # (the riser climbs from the floor to the rim OR the hillside, whichever stands higher — dug into a slope, the
    #  uphill bank is a steeper climb, never a sheer cut at the floor's edge; a cliff's riser is near-vertical anyway)
    top_ = np.maximum(N_, F + Hw)
    tgt = np.where(rr < Rin, floor, np.where(rr < Rin + Wre, F + (top_ - F) * face, np.maximum(N_, wall)))
    # the GAP: a gorge (sheer walls) or a grassy pass, its floor easing from the basin's down to the hillside's
    G = (1 - smoothstep(gw, gw + (4.0 if cliff else 22.0), perp)) * smoothstep(0.05, 0.35, cosd) * smoothstep(Ri * 0.4, Ri * 0.8, rr)
    gf = F + (np.minimum(N_, F) - F) * np.clip((rr - Ri) / (Ro - Ri), 0, 1)  # (an even grade: ≤ 20 %, never a 1.5× steeper middle)
    tgt = tgt + (np.where(rr < Rin, floor, gf) - tgt) * G
    wgt = 1 - smoothstep(Ro - 5, Ro + 15, rr)
    Hi[j0:j1, i0:i1] = N_ + (tgt - N_) * wgt
    HIDZ[j0:j1, i0:i1] = np.maximum(HIDZ[j0:j1, i0:i1], 1 - smoothstep(Ro - 20, Ro + 10, rr))
    HLUSH[j0:j1, i0:i1] = np.maximum(HLUSH[j0:j1, i0:i1], np.maximum(1 - smoothstep(Rin - 3, Rin + 1, rr), G * (1 - smoothstep(Ro - 30, Ro, rr))))
    if not cliff:
        HMEAD[j0:j1, i0:i1] = np.maximum(HMEAD[j0:j1, i0:i1], 1 - smoothstep(Ro - 30, Ro, rr))
        HRING[j0:j1, i0:i1] = np.maximum(HRING[j0:j1, i0:i1], smoothstep(Rin + Wre * 0.6, Rin + Wre + 4, rr) * (1 - smoothstep(Rc + 10, Rc + 40, rr)) * (1 - G))
    if cliff:
        riser = smoothstep(Rin - 1.5, Rin, rr) * (1 - smoothstep(Rin + Wre + 1, Rin + Wre + 4, rr)) * (1 - G)
        gorge = smoothstep(gw - 1, gw + 1, perp) * (1 - smoothstep(gw + 7, gw + 10, perp)) * smoothstep(0.15, 0.35, cosd) \
            * smoothstep(Ri - 4, Ri, rr) * (1 - smoothstep(Ro - 45, Ro - 15, rr))
        HROCK[j0:j1, i0:i1] = np.maximum(HROCK[j0:j1, i0:i1], np.maximum(riser, gorge))
    h = {'kind': kind, 'name': name, 'x': round(x, 1), 'z': round(z, 1), 'r': round(Ri, 1), 'ro': round(Ro, 1),
         'open': round(math.atan2(ox, oz), 3), 'ox': ox, 'oz': oz, 'gw': gw, 'F': round(F, 2)}
    if cliff:
        # the POOL under the fall (in the notch), carved here — not with the ponds: their trim would cut the wall
        hb_ = float(Hb)
        lipr = Ri + Wr + 3.3  # (the notch's sheer face: 2 … 3 m behind the wall's foot; the sheet clears it)
        px_, pz_ = x - ox * (Ri + Wr - 6), z - oz * (Ri + Wr - 6)
        rx_, rz_ = 12.0, 8.0                     # across the axis, along it
        rot_ = math.atan2(oz, ox)                # (the ellipse's x axis along the gap's axis)
        level = F - 0.45
        c_, s_ = math.cos(rot_), math.sin(rot_)
        lx = (Xi[j0:j1, i0:i1] - px_) * c_ + (Zi[j0:j1, i0:i1] - pz_) * s_
        lz = -(Xi[j0:j1, i0:i1] - px_) * s_ + (Zi[j0:j1, i0:i1] - pz_) * c_
        q = np.hypot(lx / rz_, lz / rx_) * (1 + 0.08 * fbm(Xw / 9, Zw / 9, SEED + seed_ + 3, 2))
        d = (q - 1) * math.sqrt(rx_ * rz_)
        cut = level - 0.5 - 2.4 * smoothstep(-1.5, -6, d) + 0.9 * smoothstep(-1.5, 3, d) + 0.6 * smoothstep(3, 9, d)
        hw2 = Hi[j0:j1, i0:i1]
        Hi[j0:j1, i0:i1] = hw2 + (np.minimum(hw2, cut) - hw2) * (1 - smoothstep(5, 9, d))
        PQ_HIDDEN.append((j0, j1, i0, i1, q))
        h['pool'] = {'cx': round(px_, 1), 'cz': round(pz_, 1), 'rx': round(rz_ * 1.16, 1), 'rz': round(rx_ * 1.16, 1), 'rot': round(rot_, 3), 'level': round(level, 2)}
        # the FALL: from the rim's edge in the notch down into the pool; the spring-fed STREAM on the rim behind it
        lx_, lz_ = x - ox * lipr, z - oz * lipr
        top = F + hb_ * float(hvar(np.array([-ox * lipr]), np.array([-oz * lipr]))[0])
        sx, sz, sy = [], [], []
        y_ = top
        for k in range(15):
            # (the stream's last point 1.2 m short of the lip: its ribbon doesn't jut out over the edge)
            qx, qz = lx_ - ox * (4 * k + 1.2), lz_ - oz * (4 * k + 1.2)
            g_ = float(bilinear(Hi, HALF, np.array([qx]), np.array([qz]))[0])
            if k > 3 and g_ < y_ - 0.2: break  # (where the rim falls away behind: the spring)
            y_ = max(y_, g_ - 0.5)
            sx.append(qx); sz.append(qz); sy.append(y_)
        # carve the channel (a flat bed 0.5 m under the water, banks 1.4 m) and set the lip at the water
        T_ = np.array([sx, sz]).T
        if len(T_) >= 2:
            Dc, Sc, _ = polyline_field(Xi, Zi, T_, 12)
            ss_ = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(T_, axis=0).T))])
            yb = np.interp(Sc, ss_, np.array(sy)) - 0.5
            kk = (1 - smoothstep(hw_f * 0.9, hw_f * 0.9 + 1.4, Dc)) * (Sc > 0.5)
            Hi[:] = np.where(kk > 0, Hi + (np.minimum(Hi, yb) - Hi) * kk, Hi)
        h['fall'] = {'x': round(lx_, 1), 'z': round(lz_, 1), 'y': round(sy[0] + 0.05, 2), 'bx': round(px_, 1), 'bz': round(pz_, 1), 'by': round(level, 2), 'hw': hw_f}
        # (index 0 downstream — the lip — like every stream run)
        h['stream'] = {'x': [round(v, 1) for v in sx], 'z': [round(v, 1) for v in sz], 'y': [round(v, 2) for v in sy], 'hw': [hw_f / 1.6] * len(sx)}  # (the renderer widens a stream 1.6×: as wide as the fall at the lip)
    HIDDEN.append(h)
    log(f'  {kind} "{name}" at ({x:.0f}, {z:.0f}) r {Ri:.0f}, walls {Hb:.0f} m, floor {F:.1f}, {math.hypot(x - SP0[0], z - SP0[1]):.0f} m from the spawn')
PQ_HIDDEN = []
for kind, name, dmin, dmax in (('falls', 'Hidden Falls', 450, 950), ('meadow', 'Flower Hollow', 500, 1400), ('falls', 'Veil Falls', 900, 1900)):
    Ri = float(rng_x.uniform(60, 72)) if kind == 'falls' else float(rng_x.uniform(70, 85))
    Ro = Ri + (125 if kind == 'falls' else 100)
    for k in rng_x.permutation(len(ch_j)):
        x, z = float(X16[ch_j[k], ch_i[k]]), float(Z16[ch_j[k], ch_i[k]])
        if not (dmin < math.hypot(x - SP0[0], z - SP0[1]) < dmax) or not site_ok(x, z, Ro): continue
        basin(x, z, kind, name, Ri, float(rng_x.uniform(30, 40)) if kind == 'falls' else float(rng_x.uniform(14, 19)), Ro, 230 + len(HIDDEN) * 10,
              hw_f=6.0 if name == 'Veil Falls' else 3.6)  # (Veil Falls: a wide curtain)
        break
    else:
        log(f'  no site for {name}')
def basin_clear(x, z, R):
    return all(math.hypot(x - h['x'], z - h['z']) > h['ro'] + R * 1.2 + 10 for h in HIDDEN)

# THE HILL FIELD (the user, 2026-10-26: "more bumps and small hills all over the place — bit bigger hills and smaller;
# some with rocks, some just the rock texture on the ground — the congested feel of OTH"): ~250 more hills, small
# (18–45 m across, 3–12 m), medium (45–100 m, 8–28 m) and big (100–190 m, 18–50 m), each an ellipse at its own angle
# with a lumpy top; some gathered round the ponds. A third get a ROCK FORMATION (an outcrop site, below), a third a
# cap of BARE ROCK (paint only, mask R: no grass), the rest stay grass.
log('hill field')
rng_f = np.random.default_rng(SEED + 181)
okf = (Dr > 55) & (Lq > 1.45) & (np.maximum(np.abs(Xi), np.abs(Zi)) < 1880)
okfj, okfi = np.nonzero(okf[::8, ::8])
padf = smoothstep(26, 70, np.hypot(Xi - SP0[0], Zi - SP0[1]))
ROCKTEX = np.zeros_like(Hi)
FIELD = []  # (x, z, R, kind)
def pond_clear(x, z, R):
    return all(math.hypot(x - a, z - b) > max(rx, rz) + R * 0.85 + 12 for a, b, rx, rz, _ in PONDS)
# (2026-10-27, "ours look flat, all places visible": more and taller big hills — the ground between you and the far
#  side of the box rises often enough to hide it)
want = [(18, 45, 3, 12)] * 140 + [(45, 100, 8, 28)] * 95 + [(100, 190, 22, 60)] * 40
spots = []
for a, b, rx, rz, _ in PONDS:  # (hills by some of the ponds: 1–3 each, 40–130 m from the shore)
    if rng_f.random() < 0.75:
        for _ in range(1 + int(rng_f.integers(3))):
            an, dd = rng_f.uniform(0, 2 * math.pi), max(rx, rz) + rng_f.uniform(40, 130)
            spots.append((a + math.cos(an) * dd, b + math.sin(an) * dd))
for k_, (rmin, rmax, hmin, hmax) in enumerate(want):
    R = float(rng_f.uniform(rmin, rmax)); Hh = float(rng_f.uniform(hmin, hmax))
    if k_ < len(spots) and rmin < 100: x, z = spots[k_]
    else:
        kk = rng_f.integers(len(okfj)); x, z = float(Xi[0, okfi[kk] * 8]), float(Zi[okfj[kk] * 8, 0])
    if not pond_clear(x, z, R) or not basin_clear(x, z, R): continue
    if not (-1880 < x < 1880 and -1880 < z < 1880): continue
    th = rng_f.uniform(0, math.pi); asp = rng_f.uniform(0.6, 1.0)
    W = R * 2.2
    i0, i1 = np.searchsorted(Xi[0], x - W), np.searchsorted(Xi[0], x + W)
    j0, j1 = np.searchsorted(Zi[:, 0], z - W), np.searchsorted(Zi[:, 0], z + W)
    if i1 <= i0 or j1 <= j0: continue
    Xw, Zw = Xi[j0:j1, i0:i1] - x, Zi[j0:j1, i0:i1] - z
    u_ = (Xw * math.cos(th) + Zw * math.sin(th)) / R; v_ = (-Xw * math.sin(th) + Zw * math.cos(th)) / (R * asp)
    q = u_ * u_ + v_ * v_
    prof = np.exp(-1.7 * q) * (0.82 + 0.3 * fbm(Xw / (R * 0.55), Zw / (R * 0.55), SEED + 500 + k_, 2))
    Hi[j0:j1, i0:i1] += Hh * prof * dry_[j0:j1, i0:i1] * padf[j0:j1, i0:i1]
    r_ = rng_f.random()
    kind = 'rock' if r_ < 0.33 else 'bare' if r_ < 0.64 else 'grass'
    if kind == 'bare':
        cap = smoothstep(0.42, 0.7, prof + 0.3 * fbm(Xw / 14, Zw / 14, SEED + 700 + k_, 2))
        ROCKTEX[j0:j1, i0:i1] = np.maximum(ROCKTEX[j0:j1, i0:i1], cap * dry_[j0:j1, i0:i1])
    FIELD.append((x, z, R, kind))
log(f'  {len(FIELD)} hills: {sum(1 for f in FIELD if f[3] == "rock")} rock, {sum(1 for f in FIELD if f[3] == "bare")} bare')

# the trekking hills' LEDGES: their upper slopes terraced into steps of 3.5–6 m — a flat ledge, then a short steep
# riser (~45°: a 4×4 crawls it) — the steps' height wandering with a noise (no contour-line regularity)
log('trekking hills: ledges')
TREKZ = np.zeros_like(Hi)
for ti_, (cx, cz, Hh, R) in enumerate(TREK):
    W = R * 1.3
    i0, i1 = np.searchsorted(Xi[0], cx - W), np.searchsorted(Xi[0], cx + W)
    j0, j1 = np.searchsorted(Zi[:, 0], cz - W), np.searchsorted(Zi[:, 0], cz + W)
    Xw, Zw = Xi[j0:j1, i0:i1], Zi[j0:j1, i0:i1]
    d = np.hypot(Xw - cx, Zw - cz) / (R * (1 + 0.25 * fbm(Xw / 160, Zw / 160, SEED + 70 + ti_, 2)))
    w = smoothstep(1.05, 0.6, d)
    hw_ = Hi[j0:j1, i0:i1]
    step = 5.0 + 1.2 * fbm(Xw / 90, Zw / 90, SEED + 80 + ti_, 2)
    off = 2.5 * fbm(Xw / 55, Zw / 55, SEED + 85 + ti_, 2)
    f = (hw_ + off) / step
    fl = np.floor(f)
    # (a grassy SHELF, then a rocky RISER ≈ 45°: the hill reads as bands of ledges, and a 4×4 still crawls it)
    terr = (fl + smoothstep(0.45, 1.0, f - fl)) * step - off
    Hi[j0:j1, i0:i1] = hw_ + (terr - hw_) * w
    TREKZ[j0:j1, i0:i1] = np.maximum(TREKZ[j0:j1, i0:i1], w)

# the PONDS carved: the level just under the lowest point of its rim (the water never spills), a bowl 2–5 m deep
# under it, a sloped beach through the water line, the ground round it trimmed into the bowl (no rim, no wall)
log('ponds + small lakes: carve')
PONDW = []
PQ = np.full(Hi.shape, 9.0)  # (each cell's shore distance in shore radii: < 1 = water — the masks read it)
for pi2, (cx, cz, rx, rz, rot) in enumerate(PONDS):
    R = math.sqrt(rx * rz); W = max(rx, rz) * 1.75 + 110  # (wide enough for the trim to fade out inside it)
    i0, i1 = np.searchsorted(Xi[0], cx - W), np.searchsorted(Xi[0], cx + W)
    j0, j1 = np.searchsorted(Zi[:, 0], cz - W), np.searchsorted(Zi[:, 0], cz + W)
    Xw, Zw = Xi[j0:j1, i0:i1], Zi[j0:j1, i0:i1]
    c, s_ = math.cos(rot), math.sin(rot)
    lx = (Xw - cx) * c + (Zw - cz) * s_; lz = -(Xw - cx) * s_ + (Zw - cz) * c
    q = np.hypot(lx / rx, lz / rz) * (1 + 0.12 * fbm(Xw / (0.7 * R), Zw / (0.7 * R), SEED + 400 + pi2, 2))
    d = (q - 1) * R
    hw_ = Hi[j0:j1, i0:i1]
    rim = hw_[(q > 1.05) & (q < 1.35)]
    level = float(np.percentile(rim, 2)) - 0.45
    depth = 1.8 + 0.032 * R
    cut = level - 0.55 - depth * smoothstep(-3, -0.55 * R, d) + 0.9 * smoothstep(-3, 4, d) + 2.0 * smoothstep(3, 35, d) \
        + 0.22 * np.maximum(d - 20, 0)
    k = 1 - smoothstep(0.5 * R + 40, 0.5 * R + 90, d)
    Hi[j0:j1, i0:i1] = hw_ + (np.minimum(hw_, cut) - hw_) * k
    PQ[j0:j1, i0:i1] = np.minimum(PQ[j0:j1, i0:i1], q)
    PONDW.append({'cx': round(cx, 1), 'cz': round(cz, 1), 'rx': round(rx * 1.16, 1), 'rz': round(rz * 1.16, 1), 'rot': round(rot, 3), 'level': round(level, 2)})
# the hidden basins' pools (carved with their basins): water to the masks, the trails' walls and the renderer
for j0, j1, i0, i1, q in PQ_HIDDEN: PQ[j0:j1, i0:i1] = np.minimum(PQ[j0:j1, i0:i1], q)
for h in HIDDEN:
    if 'pool' in h: PONDW.append(h['pool'])

# ---------------------------------------------------------------------------------------------------------- rocks
# ROCK OUTCROPS (the user, 2026-10-26: "places with huge rock — the terrain itself, rock texture, no grass there"):
# ~12 sites on the hill flanks (2 within sight of the spawn), each a cluster of fused BLOCKS raised out of the slope —
# Voronoi cells, each its own tilted flat top, the crevices between them rounded (OTH's soft grey slabs) — inside an
# irregular outline. It is real ground (the height grid: the car climbs and hits it, the shadows fall from it), and
# `ROCKZ` paints it rock (mask R): no grass, trees or bushes grow there.
log('rock outcrops')
def ihash(a, b, s):
    h = (a.astype(np.int64) * 374761393 + b.astype(np.int64) * 668265263 + s * 144665 + 7) & 0xffffffff
    h = ((h ^ (h >> 13)) * 1274126177) & 0xffffffff
    return ((h ^ (h >> 16)) & 0xffff) / 65535.0
rng_o = np.random.default_rng(SEED + 91)
H8o = blur(Hi[::4, ::4], 2)
g8z, g8x = np.gradient(H8o, 8.0)
slope8 = np.hypot(g8x, g8z)
X8o, Z8o = Xi[::4, ::4], Zi[::4, ::4]
cand = (slope8 > 0.1) & (slope8 < 0.55) & (Dv[::4, ::4] > 150) & (Dr[::4, ::4] > 110) & (Lq[::4, ::4] > 1.7) \
    & (np.abs(X8o) < 1720) & (np.abs(Z8o) < 1720)
cy_, cx_ = np.nonzero(cand)
spawn_pt = RIVER_L[np.searchsorted(_racc, RIVER_LEN * 0.38)]
dsp = np.hypot(X8o[cy_, cx_] - spawn_pt[0], Z8o[cy_, cx_] - spawn_pt[1])
sites = []
for want_near in (True, False):
    for k in rng_o.permutation(len(cy_)):
        if len(sites) >= (2 if want_near else 12): break
        if want_near and not (220 < dsp[k] < 560): continue
        x, z = float(X8o[cy_[k], cx_[k]]), float(Z8o[cy_[k], cx_[k]])
        if all(math.hypot(x - a, z - b) > 380 for a, b, _ in sites): sites.append((x, z, 45 + 70 * rng_o.random()))
# + two small ones right by the spawn (70–200 m: the first view has rock in it), off the water
near_c = []
for a in np.linspace(0, 2 * np.pi, 24, endpoint=False):
    for d_ in (90.0, 140.0, 190.0):
        x, z = spawn_pt[0] + math.cos(a) * d_, spawn_pt[1] + math.sin(a) * d_
        jj, ii = int(round((z + HALF) / 2)), int(round((x + HALF) / 2))
        if Dr[jj, ii] > 45 and Lq[jj, ii] > 1.7: near_c.append((x, z))
rng_o.shuffle(near_c)
added = 0
for x, z in near_c:
    if added >= 2: break
    if all(math.hypot(x - a, z - b) > 110 for a, b, _ in sites):
        sites.append((x, z, 28 + 14 * rng_o.random())); added += 1
# + FORMATIONS ON THE HILLS AND THE CLIFF PLATEAUS (the user: "on cliffs and hills put terrain-based rock formations")
for cx, cz, R in HILLS:
    if rng_o.random() < 0.7:
        a = rng_o.random() * 2 * math.pi; off = R * 0.25 * rng_o.random()
        sites.append((cx + math.cos(a) * off, cz + math.sin(a) * off, 32 + 0.18 * R))
for cx, cz, L_ in PLATEAUS:
    sites.append((cx, cz, 26 + 0.15 * L_))
for cx, cz, R, kind in FIELD:
    if kind == 'rock':
        a = rng_o.random() * 2 * math.pi; off = R * 0.3 * rng_o.random()
        sites.append((cx + math.cos(a) * off, cz + math.sin(a) * off, min(60.0, 10 + 0.45 * R)))
sites = [s_ for s_ in sites if basin_clear(s_[0], s_[1], s_[2])]  # (no rock formation inside a hidden basin)
add = np.zeros_like(Hi)
ROCKZ = np.zeros_like(Hi)
for si_, (sx, sz, R) in enumerate(sites):
    W = R * 1.4
    i0, i1 = np.searchsorted(Xi[0], sx - W), np.searchsorted(Xi[0], sx + W)
    j0, j1 = np.searchsorted(Zi[:, 0], sz - W), np.searchsorted(Zi[:, 0], sz + W)
    Xw, Zw = Xi[j0:j1, i0:i1], Zi[j0:j1, i0:i1]
    # an irregular outline, a dome envelope (taller in the middle)
    wob = 1 + 0.32 * fbm(Xw / (R * 0.6), Zw / (R * 0.6), SEED + 300 + si_, 3)
    d = np.hypot(Xw - sx, Zw - sz) / (R * wob)
    env = smoothstep(1.0, 0.5, d)
    cell = 11 + 9 * rng_o.random()
    amp = 7 + 11 * rng_o.random()
    u, w = (Xw - sx) / cell, (Zw - sz) / cell
    iu, iw = np.floor(u), np.floor(w)
    F1 = np.full(u.shape, 9.0); F2 = np.full(u.shape, 9.0); top = np.zeros(u.shape)
    for du in (-1, 0, 1):
        for dw in (-1, 0, 1):
            cu, cw = iu + du, iw + dw
            px = cu + 0.15 + 0.7 * ihash(cu, cw, si_ * 7 + 1); pz = cw + 0.15 + 0.7 * ihash(cu, cw, si_ * 7 + 2)
            dd = np.hypot(u - px, w - pz)
            # the block's own top: a height and a gentle tilt
            t = (0.2 + 0.8 * ihash(cu, cw, si_ * 7 + 3)) + (ihash(cu, cw, si_ * 7 + 4) - 0.5) * 0.25 * (u - px) \
                + (ihash(cu, cw, si_ * 7 + 5) - 0.5) * 0.25 * (w - pz)
            closer = dd < F1
            F2 = np.where(closer, F1, np.minimum(F2, dd))
            top = np.where(closer, t, top)
            F1 = np.where(closer, dd, F1)
    # rounded crevices between the blocks (the edge distance ≈ (F2 − F1) / 2 cells)
    edge = (F2 - F1) * 0.5 * cell
    # (flat tops, steep sides: a block keeps its top to ~1.5 m from its edge, then drops into the crevice)
    blocks = amp * top * (0.35 + 0.65 * smoothstep(0.2, 1.6, edge)) * (0.45 + 0.55 * env)
    add[j0:j1, i0:i1] = np.maximum(add[j0:j1, i0:i1], blocks * smoothstep(0.0, 0.2, env))
    ROCKZ[j0:j1, i0:i1] = np.maximum(ROCKZ[j0:j1, i0:i1], smoothstep(0.08, 0.3, env))
Hi = Hi + add
# (rock wherever a block stands ≥ 0.6 m proud of the ground, not only inside the envelope)
ROCKZ = np.maximum(ROCKZ, smoothstep(0.3, 0.9, add))
log(f'  {len(sites)} outcrops, {float((ROCKZ > 0.5).mean()) * 100:.1f} % of the box')

log('world (16 m)')
Xf, Zf = grid(N_FAR, FAR_HALF)
Hf = macro(Xf, Zf, octave_cut=1)
Hf0 = Hf
Hf, _ = erode(Hf, 16.0, int(ARGS.get('FAR_DROPS', 2400000)), cap=2.2, erode_r=0.06, seed=SEED + 7)
log(f'  far eroded: range {np.nanmin(Hf):.0f}..{np.nanmax(Hf):.0f}, nan {int(np.isnan(Hf).sum())}')
Hf, _, _, _, _ = carve(Xf, Zf, Hf)
# the box's rim follows the world (both carved the same valley), then the world takes the box's own heights
edge = np.maximum(np.abs(Xi), np.abs(Zi))
b = smoothstep(HALF - 320, HALF - 8, edge)
Hi = Hi + (bilinear(Hf, FAR_HALF, Xi, Zi) - Hi) * b
k0 = int(round((FAR_HALF - HALF) / 16))
Hf[k0:k0 + 257, k0:k0 + 257] = Hi[::8, ::8]

# ---------------------------------------------------------------------------------------------------------- spawn
# on the meadow east of the river, ~1.4 km south of the lake, looking north up the valley
si = np.searchsorted(_racc, RIVER_LEN * 0.38)
p = RIVER_L[si]; tng = RIVER_L[si + 1] - RIVER_L[si - 1]; tng /= np.linalg.norm(tng)
sp = p + np.array([-tng[1], tng[0]]) * 55
if bilinear(Hi, HALF, np.array([sp[0]]), np.array([sp[1]]))[0] < river_surface(RIVER_LEN * 0.38) + 0.6:
    sp = p - np.array([-tng[1], tng[0]]) * 55
spawn = dict(x=float(sp[0]), z=float(sp[1]), yaw=0.0)

SPAWN_XZ = (spawn['x'], spawn['z'])

# ---------------------------------------------------------------------------------------------------------- trails
# DIRT TRACKS to drive (the OTH trails): A* on an 8 m grid — cost = length × (1 + 25·grade²), steeper than 30 % is a
# wall, the lake is a wall, the river a ford (costly but open), existing track cells at 45 % (routes MERGE into one
# network instead of running side by side). Spawn ↔ the lake, the south exit, and the box's prominent hilltops.
# Each route is smoothed (Chaikin), resampled every 4 m, given a smoothed height profile, and CARVED: the ground
# within its half width + 5 m eases onto that profile (no cross slope, a slight dip in the middle).
import heapq
log('trails')
TRAIL_HW = 2.8  # (the user: "the road is too narrow" — 1.8 → 2.8, two cars wide; height.bin is still the 1.8 bake: its
#  bed is level to ±2.3 m and blends out by 7.3, so the new edge sits a few cm off level until the next bake)
C8 = 8.0
Hc = Hi[::4, ::4]
n8 = Hc.shape[0]
X8 = Xi[::4, ::4]; Z8 = Zi[::4, ::4]
lake8 = (Lq[::4, ::4] < 1.08) | (PQ[::4, ::4] < 1.12)  # (the big lake and the ponds: walls)
river8 = Dr[::4, ::4] < Hw[::4, ::4] * 1.6
edge8 = np.maximum(np.abs(X8), np.abs(Z8)) > HALF - 120
Hl = Hc.ravel().tolist()
wall_basic = (lake8 | edge8).ravel().tolist()
wall = (lake8 | edge8 | (ROCKZ[::4, ::4] > 0.15)).ravel().tolist()  # (the ordinary tracks go round the outcrops)
ford = river8.ravel().tolist()
# (a gently varying cost so the routes wander like real tracks instead of running grid-straight)
mult = (1.0 + 0.9 * np.clip(fbm(X8 / 170, Z8 / 170, SEED + 71, 3) + 0.5, 0, 1.2)).ravel().tolist()
NB = [(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0), (1, 1, 1.4142), (1, -1, 1.4142), (-1, 1, 1.4142), (-1, -1, 1.4142)]

def cell_of(x, z):
    return int(round((x + HALF) / C8)), int(round((z + HALF) / C8))

def astar(a, b, maxg=0.3, walls=None):
    walls = walls or wall
    n = n8
    s0 = a[1] * n + a[0]; g0 = b[1] * n + b[0]
    gx, gz = b
    INF = 1e30
    g = {s0: 0.0}; came = {}
    pq = [(0.0, s0)]
    closed = set()
    while pq:
        f, u = heapq.heappop(pq)
        if u == g0: break
        if u in closed: continue
        closed.add(u)
        ux, uz = u % n, u // n
        hu = Hl[u]; gu = g[u]
        for dx, dz, dl in NB:
            vx, vz = ux + dx, uz + dz
            if vx < 0 or vz < 0 or vx >= n or vz >= n: continue
            v = vz * n + vx
            if v in closed or walls[v]: continue
            L = dl * C8
            gr = abs(Hl[v] - hu) / L
            if gr > maxg: continue
            c = L * (1 + 25 * gr * gr) * mult[v] + (420.0 if ford[v] else 0.0)
            ng = gu + c
            if ng < g.get(v, INF):
                g[v] = ng; came[v] = u
                heapq.heappush(pq, (ng + math.hypot(vx - gx, vz - gz) * C8 * 0.45, v))
    if g0 not in came and g0 != s0: return None
    path = [g0]
    while path[-1] != s0: path.append(came[path[-1]])
    return path[::-1]

def nearest_dry(x, z):
    i, j = cell_of(x, z)
    best = None
    for r in range(0, 40):
        for jj in range(j - r, j + r + 1):
            for ii in range(i - r, i + r + 1):
                if 0 <= ii < n8 and 0 <= jj < n8 and not wall[jj * n8 + ii] and not ford[jj * n8 + ii]:
                    d = (ii - i) ** 2 + (jj - j) ** 2
                    if best is None or d < best[0]: best = (d, ii, jj)
        if best: return best[1], best[2]
    return i, j

def chaikin(P, k=3):
    for _ in range(k):
        Q = [P[0]]
        for a, b in zip(P[:-1], P[1:]):
            Q.append(a * 0.75 + b * 0.25); Q.append(a * 0.25 + b * 0.75)
        Q.append(P[-1]); P = np.array(Q)
    return P

def rdp(P, eps):
    if len(P) < 3: return P
    a, b = P[0], P[-1]
    ab = b - a; L = np.hypot(*ab) or 1.0
    d = np.abs(np.cross(ab, P - a)) / L
    i = int(np.argmax(d))
    if d[i] <= eps: return np.array([a, b])
    return np.vstack([rdp(P[:i + 1], eps)[:-1], rdp(P[i:], eps)])

def smooth_path(P):
    """Grid path → its few key points (RDP, 10 m) → a Catmull-Rom curve through them → 2 Chaikin passes."""
    K = rdp(P, 10.0)
    if len(K) < 3: return chaikin(K, 2)
    return chaikin(spline(K, 6.0), 2)

def resample(P, step=4.0):
    d = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
    t = np.arange(0, d[-1], step)
    return np.stack([np.interp(t, d, P[:, 0]), np.interp(t, d, P[:, 1])], 1)

# destinations: the box's prominent hilltops (spread out, reachable, not by the lake)
Hs = blur(Hc, 4)
def maxf(a, r):
    from numpy.lib.stride_tricks import sliding_window_view as sw
    p_ = np.pad(a, r, mode='edge')
    return sw(sw(p_, 2 * r + 1, axis=0).max(-1), 2 * r + 1, axis=1).max(-1)
peak = (Hs >= maxf(Hs, 18) - 1e-6) & (Hs - blur(Hs, 20) > 8) & (np.abs(X8) < 1700) & (np.abs(Z8) < 1700) & ~lake8 \
    & (ROCKZ[::4, ::4] < 0.05)
pj, pi = np.nonzero(peak)
order = np.argsort(-Hs[pj, pi])
tops = []
for k in order:
    x, z = float(X8[pj[k], pi[k]]), float(Z8[pj[k], pi[k]])
    if all(math.hypot(x - a, z - b) > 600 for a, b in tops): tops.append((x, z))
    if len(tops) >= 8: break
LAKE_SHORE = (LAKE['cx'] + 60.0, LAKE['cz'] + LAKE['rz'] + 70.0)
SOUTH = (330.0, HALF - 140.0)
TRAILS = []
TREKS = []
def steepest(T):
    hs = bilinear(Hi, HALF, T[:, 0], T[:, 1])
    return float(np.max(np.abs(hs[2:] - hs[:-2])) / 8.0) if len(hs) > 2 else 0.0
def build(a, b, trek=False, rocky=False):
    # (a trucking track — up a trekking hill, through a rock formation — may climb ledges and blocks: steeper steps
    #  allowed, the rock not a wall, and it isn't graded smooth below)
    ca, cb = (cell_of(*a) if rocky else nearest_dry(*a)), nearest_dry(*b)
    path = astar(ca, cb, 0.62 if (trek or rocky) else 0.3, wall_basic if rocky else None)
    trek = trek or rocky
    if not path: log('  no route', a, b); return
    if len(path) < 2: return  # (already on the network: nothing to build)
    for u in path: mult[u] = 0.4
    P = np.array([[X8[u // n8, u % n8], Z8[u // n8, u % n8]] for u in path], float)
    T_ = resample(smooth_path(P))
    # (on steep ground the route zig-zags to keep ≤ 30 %; the smoothing can cut the zig-zag into a straight climb —
    #  then keep the route's own corners, only rounded)
    if not trek and steepest(T_) > 0.36:
        T2 = resample(chaikin(P, 3))
        if steepest(T2) < steepest(T_): T_ = T2
    TRAILS.append(T_)
    TREKS.append(trek)

build(SPAWN_XZ, LAKE_SHORE)
build(SOUTH, SPAWN_XZ)
for t in sorted(tops, key=lambda q: math.hypot(q[0] - SPAWN_XZ[0], q[1] - SPAWN_XZ[1])):
    pts = np.concatenate(TRAILS)
    k = int(np.argmin(np.hypot(pts[:, 0] - t[0], pts[:, 1] - t[1])))
    ti, tj = int(round((t[0] + HALF) / 2)), int(round((t[1] + HALF) / 2))
    build(t, (float(pts[k, 0]), float(pts[k, 1])), trek=TREKZ[tj, ti] > 0.2)
# TRUCKING ROUTES (the user: "through rock formations and normal hills I need connected roads, so I can do trucking
# like OTH"): from the network INTO each formation (nearest first, up to 18) and on THROUGH to a neighbouring one —
# rock crawling, every route joined to the tracks
rs = sorted(sites, key=lambda q: math.hypot(q[0] - SPAWN_XZ[0], q[1] - SPAWN_XZ[1]))[:24]
for x, z, R in rs:
    pts = np.concatenate(TRAILS)
    k = int(np.argmin(np.hypot(pts[:, 0] - x, pts[:, 1] - z)))
    build((x, z), (float(pts[k, 0]), float(pts[k, 1])), rocky=True)
for i_, (x, z, R) in enumerate(rs):
    nb_ = [q for q in rs[i_ + 1:] if 150 < math.hypot(q[0] - x, q[1] - z) < 650]
    if nb_ and rng_o.random() < 0.6:
        q = min(nb_, key=lambda q: math.hypot(q[0] - x, q[1] - z))
        build((x, z), (q[0], q[1]), rocky=True)
# BRIDGES (the user, 2026-10-26: "bridges like in OTH"): three plank bridges over the river, a track over each —
# the deck bank to bank (its ends on dry ground, ≥ 1.6 m over the water), an earth ramp up to it each side, both
# ends joined to the network
BRIDGES = []
BRIDGE_T = set()
BRIDGE_SEG = []
BRIDGE_R = []  # (each bridge's two ramp lengths)
def ramp_len(E, dv, deck):
    # (2026-10-27: a fixed 30 m ramp came down a 10 m bank at 42 % and flipped the car onto its nose: as long as
    #  the height it climbs needs for ≤ 12 % on average — ≤ 18 % at the steepest — 30 … 110 m)
    r = 30.0
    for _ in range(4):
        g = float(bilinear(Hi, HALF, np.array([E[0] + dv[0] * r]), np.array([E[1] + dv[1] * r]))[0])
        r = float(np.clip(abs(g - deck) / 0.12, 30.0, 110.0))
    return r
for frac in (0.2, 0.47, 0.74):
    s_ = RIVER_LEN * frac
    k_ = int(np.searchsorted(_racc, s_))
    P_ = RIVER_L[k_]; t_ = RIVER_L[min(k_ + 1, len(RIVER_L) - 1)] - RIVER_L[max(k_ - 1, 0)]; t_ = t_ / np.linalg.norm(t_)
    n_ = np.array([-t_[1], t_[0]])
    span = river_halfwidth(s_) * 2.1 + 3.0
    E1 = P_ - n_ * span; E2 = P_ + n_ * span
    y1, y2 = bilinear(Hi, HALF, np.array([E1[0], E2[0]]), np.array([E1[1], E2[1]]))
    line_ = np.linspace(0, 1, 60)[:, None] * (E2 - E1) + E1
    under_ = bilinear(Hi, HALF, line_[:, 0], line_[:, 1])  # (the banks under the deck never poke through it)
    deck = float(max(y1, y2, river_surface(s_) + 1.6, under_.max() + 0.3))
    r1_, r2_ = ramp_len(E1, -n_, deck), ramp_len(E2, n_, deck)
    BRIDGE_R.append((r1_, r2_))
    A1 = E1 - n_ * r1_; A2 = E2 + n_ * r2_
    BRIDGES.append({'x0': round(float(E1[0]), 2), 'z0': round(float(E1[1]), 2), 'x1': round(float(E2[0]), 2), 'z1': round(float(E2[1]), 2),
                    'y': round(deck, 2), 'w': 4.6})
    BRIDGE_SEG.append((E1.copy(), E2.copy()))
    BRIDGE_T.add(len(TRAILS))
    TRAILS.append(resample(np.array([A1, E1, E2, A2]))); TREKS.append(False)
    # (later routes cross ON it: no ford cost, a track's cost, and the route-finder sees the deck's and the ramps'
    #  heights, not the river channel's — else it fords the river beside the bridge)
    LA = float(np.hypot(*(A2 - A1))); ha1, ha2 = bilinear(Hi, HALF, np.array([A1[0], A2[0]]), np.array([A1[1], A2[1]]))
    for x_, z_ in resample(np.array([A1, A2]), C8 / 2):
        ii, jj = cell_of(x_, z_)
        if not (0 <= ii < n8 and 0 <= jj < n8): continue
        v = jj * n8 + ii
        tt = math.hypot(x_ - A1[0], z_ - A1[1])
        Hl[v] = ha1 + (deck - ha1) * min(1.0, tt / r1_) if tt < r1_ else (ha2 + (deck - ha2) * min(1.0, (LA - tt) / r2_) if tt > LA - r2_ else deck)
        ford[v] = False; mult[v] = 0.4
    for A in (A1, A2):
        pts = np.concatenate([T for t_i, T in enumerate(TRAILS) if t_i not in BRIDGE_T])
        k = int(np.argmin(np.hypot(pts[:, 0] - A[0], pts[:, 1] - A[1])))
        build((float(A[0]), float(A[1])), (float(pts[k, 0]), float(pts[k, 1])))
# TRACKS TO THE PONDS: one to a shore point of most ponds (the side facing the network), round the small lakes a
# second one along the far shore
for pi2, (cx, cz, rx, rz, rot) in enumerate(PONDS):
    if pi2 > 0 and rng_p.random() < 0.2: continue
    pts = np.concatenate(TRAILS)
    k = int(np.argmin(np.hypot(pts[:, 0] - cx, pts[:, 1] - cz)))
    dx_, dz_ = pts[k, 0] - cx, pts[k, 1] - cz; L_ = math.hypot(dx_, dz_) or 1.0
    off = max(rx, rz) * 1.25 + 14
    S1 = (cx + dx_ / L_ * off, cz + dz_ / L_ * off)
    build(S1, (float(pts[k, 0]), float(pts[k, 1])))
    if max(rx, rz) > 50:
        S2 = (cx - dx_ / L_ * off, cz - dz_ / L_ * off)
        build(S1, S2)
# TRACKS INTO THE HIDDEN BASINS: from a point on the floor in front of the pool out through the gap to the network
# (the walls are too steep for a route: it can only come in through the gorge / the pass)
for h in HIDDEN:
    pts = np.concatenate(TRAILS)
    ex, ez = h['x'] + h['ox'] * (h['ro'] + 40), h['z'] + h['oz'] * (h['ro'] + 40)
    k = int(np.argmin(np.hypot(pts[:, 0] - ex, pts[:, 1] - ez)))
    build((h['x'] + h['ox'] * h['r'] * 0.25, h['z'] + h['oz'] * h['r'] * 0.25), (float(pts[k, 0]), float(pts[k, 1])))
log(f'  {len(TRAILS)} trails, {sum(len(t) for t in TRAILS) * 4 / 1000:.1f} km, {len(BRIDGES)} bridges, tops {[(round(a), round(b)) for a, b in tops]}')
# carve them (2 m grid), and the distance-to-track field the ground shader paints with
Dt = np.full(Hi.shape, 99.0)
BedH = np.zeros(Hi.shape)  # (each carved cell: its nearest track's bed height — the junctions match it)
# UNDER A BRIDGE no track carves the river (a route that crosses on the bridge would fill the channel in: a sandbar
# under the deck); the deck's footprint on the banks is track earth (no grass up through the planks)
UNDER = np.zeros(Hi.shape, bool); DECK = np.zeros(Hi.shape, bool)
ROUGHB = np.zeros(Hi.shape, bool)  # (the rock-crawling routes' beds: their ledges are meant)
for (E1_, E2_), B_ in zip(BRIDGE_SEG, BRIDGES):
    Db, Sb, Lb = polyline_field(Xi, Zi, np.array([E1_, E2_]), 14)
    on = (Db < TRAIL_HW + 6.5) & (Sb > 0.5) & (Sb < Lb - 0.5)  # (≥ a track's carving reach, hw + 5.5 m)
    UNDER |= on & (Dr < Hw * 2.05)
    DECK |= (Db < B_['w'] / 2 + 1.0) & (Sb > -1) & (Sb < Lb + 1)
for ti_, (T, trek) in enumerate(zip(TRAILS, TREKS)):
    hs_ = bilinear(Hi, HALF, T[:, 0], T[:, 1])
    ss = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(T, axis=0).T))])
    if ti_ in BRIDGE_T:
        # A → E: an earth ramp from the ground up to the deck; E → E: the deck (no carving: the river runs under it)
        B_ = BRIDGES[sorted(BRIDGE_T).index(ti_)]
        r1_, r2_ = BRIDGE_R[sorted(BRIDGE_T).index(ti_)]
        e0 = r1_; e1 = ss[-1] - r2_
        # (the ramp ends 15 cm under the deck's top: the planks lie on it, no ground shows through them)
        hc = np.where(ss < e0, hs_[0] + (B_['y'] - 0.15 - hs_[0]) * smoothstep(0, e0, ss),
                      np.where(ss > e1, hs_[-1] + (B_['y'] - 0.15 - hs_[-1]) * smoothstep(ss[-1], e1, ss), B_['y'] - 0.3))
    else:
        k = 9
        hc = np.convolve(np.pad(hs_, k, mode='edge'), np.ones(2 * k + 1) / (2 * k + 1), mode='same')[k:-k]
        # JUNCTIONS (2026-10-27: four tracks met 20 m from the spawn, each carving its own smoothed profile over the
        # last — a 3.4 m step and a 2.3 m side lean that rolled the car): near a bed already carved (within reach of
        # this track's shoulders: crossing, joining or running beside it) its profile takes THAT bed's height (BedH:
        # every carved cell keeps the height of its nearest track's bed), easing back to its own over 40 m along it
        pin = 1 - smoothstep(TRAIL_HW + 1, TRAIL_HW + 7, bilinear(Dt, HALF, T[:, 0], T[:, 1]))
        if (pin > 0).any():
            src = np.nonzero(pin > 0)[0]; Bs = bilinear(BedH, HALF, T[src, 0], T[src, 1])
            Wm = pin[src][None, :] * (1 - smoothstep(0, 40, np.abs(ss[:, None] - ss[src][None, :])))
            j_ = Wm.argmax(1); P_ = Wm[np.arange(len(ss)), j_]
            hc = hc + (Bs[j_] - hc) * P_
    D, S, _ = polyline_field(Xi, Zi, T, 16)
    target = np.interp(S, ss, hc) - 0.12 * (1 - smoothstep(0, TRAIL_HW, D))
    w = 1 - smoothstep(TRAIL_HW + 0.5, TRAIL_HW + 5.5, D)
    w = np.where((Lq < 1.05) | (PQ < 1.02), 0, w)
    under = UNDER | ((Dr < Hw * 2.05) if ti_ in BRIDGE_T else False)  # (the channel and its banks under the deck)
    w = np.where(under, 0, w)
    D = np.where(under, 99.0, D)
    if trek:
        w = w * (1 - 0.85 * np.maximum(TREKZ, ROCKZ))  # (over ledges and blocks the track keeps them: rock crawling)
        ROUGHB |= (D < TRAIL_HW + 1) & (np.maximum(TREKZ, ROCKZ) > 0.1)  # (only where it crawls rock: not its way there)
    # (a bed already carved is never carved again: this track's shoulders can't tilt it, its bed joins it level)
    if ti_ not in BRIDGE_T: w = w * smoothstep(TRAIL_HW - 0.5, TRAIL_HW + 1.5, Dt)
    Hi = Hi + (target - Hi) * w
    BedH = np.where(D < Dt, target, BedH)
    Dt = np.minimum(Dt, D)
Dt = np.where(DECK & ~UNDER, np.minimum(Dt, 0.4), Dt)
# GRADING, a last pass: where an ordinary track's bed still steps (> 35 % over a metre — a switchback's legs carving
# each other, a pond's bowl, two beds meeting at an angle) that stretch is re-graded onto its own bed smoothed ±16 m,
# easing out over 12 m; the rock-crawling routes keep their ledges, the water its banks
graded = 0
# (a bed once graded is LOCKED: two tracks sharing a stretch each graded the shared cells onto their own smoothed
#  profile in turn — a 0.6 m step where the second one's reach ended; now the later one keeps the earlier's bed)
GL = np.zeros(Hi.shape, bool)
for ti_, (T, trek) in enumerate(zip(TRAILS, TREKS)):
    if trek or ti_ in BRIDGE_T: continue
    T1 = resample(T, 1.0)
    if len(T1) < 8: continue
    hs_ = bilinear(Hi, HALF, T1[:, 0], T1[:, 1])
    bad = np.abs(np.diff(hs_, append=hs_[-1])) > 0.35
    if not bad.any(): continue
    graded += 1
    k = 16
    sm = np.convolve(np.pad(hs_, k, mode='edge'), np.ones(2 * k + 1) / (2 * k + 1), mode='same')[k:-k]
    near_bad = np.convolve(bad.astype(float), np.ones(2 * k + 1), mode='full')[k:k + len(bad)] > 0  # (a track shorter than the window too)
    ss1 = np.arange(len(T1), dtype=float)
    src = ss1[near_bad]
    gap = np.abs(ss1[:, None] - src[None, :]).min(1)
    along = 1 - smoothstep(0, 12, gap)
    D, S, _ = polyline_field(Xi, Zi, T1, 10)
    w = (1 - smoothstep(TRAIL_HW + 0.3, TRAIL_HW + 3.5, D)) * np.interp(S, ss1, along)
    w = np.where((Lq < 1.05) | (PQ < 1.02) | UNDER | GL, 0, w)
    Hi = Hi + (np.interp(S, ss1, sm) - Hi) * w
    GL |= (w > 0.5) & (D < TRAIL_HW)
log(f'  graded {graded} tracks')
# JUNCTION RELAX, the very last: where two beds still meet at different heights (a track's end stops a few metres short
# of the bed it joins — 1.8 m over 2 m, 140 m from the spawn, 2026-10-27) the step is eased out: on the ordinary beds
# only, wherever the bed is steeper than 36 %, toward its 3 × 3 neighbourhood, until none is (a ramp over ~10–15 m)
bedm = (Dt < TRAIL_HW + 0.5) & ~ROUGHB & ~UNDER & ~DECK & (Lq >= 1.05) & (PQ >= 1.02)
relaxed = 0
for it_ in range(60):
    gz_, gx_ = np.gradient(Hi, 2.0)
    st_ = bedm & (np.hypot(gx_, gz_) > 0.36)
    if not st_.any(): break
    relaxed = max(relaxed, int(st_.sum()))
    st_ = np.pad(st_, 1)[1:-1, 1:-1] | np.roll(st_, 1, 0) | np.roll(st_, -1, 0) | np.roll(st_, 1, 1) | np.roll(st_, -1, 1)
    st_ &= bedm
    avg = blur(Hi, 1)
    Hi = np.where(st_, Hi + (avg - Hi) * 0.7, Hi)
log(f'  junction relax: {relaxed} steep bed cells, {it_ + 1} rounds')
k0 =int(round((FAR_HALF - HALF) / 16))
Hf[k0:k0 + 257, k0:k0 + 257] = Hi[::8, ::8]

log('masks (4 m)')
H4 = Hi[::2, ::2]
X4, Z4 = Xm, Zm
gz4, gx4 = np.gradient(H4, 4.0)
sl = np.hypot(gx4, gz4)
erosion_cut = blur(np.minimum(Hm - Hm0, 0), 1)
# (the user: "more rock texture in the terrain, it's so plain"): bare rock on the steeper ground, EXPOSED BEDROCK
# patches on the hillsides, the trekking hills' ledges mostly rock with grass pockets
patch = fbm(X4 / 110, Z4 / 110, SEED + 93, 3) + 0.4 * fbm(X4 / 35, Z4 / 35, SEED + 94, 2)
TZ4 = TREKZ[::2, ::2]
rock = np.clip(smoothstep(0.48, 0.85, sl) + 0.5 * smoothstep(0.35, 0.7, sl) * smoothstep(-6, -16, erosion_cut)
               + smoothstep(330, 520, H4) * smoothstep(0.3, 0.6, sl)
               + smoothstep(0.18, 0.4, patch) * smoothstep(0.14, 0.3, sl)
               + TZ4 * (smoothstep(0.32, 0.6, sl) + 0.25 * smoothstep(0.0, 0.3, fbm(X4 / 45, Z4 / 45, SEED + 95, 2))), 0, 1)
fl = np.log1p(blur(flow_m, 5))
wet = np.clip(smoothstep(np.percentile(fl, 80), np.percentile(fl, 99.3), fl), 0, 1)
Dr4 = Dr[::2, ::2]; Dv4 = Dv[::2, ::2]; Lq4 = Lq[::2, ::2]; Hw4 = Hw[::2, ::2]
PQ4 = PQ[::2, ::2]
near_water = np.maximum(np.maximum(1 - smoothstep(10, 70, Dr4), 1 - smoothstep(1.0, 1.35, Lq4)), 1 - smoothstep(1.0, 1.6, PQ4))
wet = np.maximum(wet, near_water)
# dryness: golden straw on the open slopes, green in the wet bottoms and patches (south faces drier: +z is south)
# (broad soft fields — no small blotches)
dry = 0.62 + 0.45 * fbm(X4 / 650, Z4 / 650, SEED + 41, 2) + 0.15 * np.clip(-gz4 / np.maximum(sl, 1e-3), -1, 1) * smoothstep(0.05, 0.3, sl)
dry = dry - 0.6 * wet - 0.3 * (1 - smoothstep(60, 300, Dv4))
dry = np.clip(blur(dry, 4), 0, 1)
# forest: big stands on the hills and massifs, clearings, none on rock, water or the valley meadow
fpatch = fbm(X4 / 560, Z4 / 560, SEED + 51, 3) + 0.2 * fbm(X4 / 180, Z4 / 180, SEED + 52, 2)
forest = smoothstep(-0.05, 0.25, fpatch) * (1 - smoothstep(0.25, 0.7, rock)) * smoothstep(90, 240, Dv4) \
    * (1 - smoothstep(0.8, 1.05, sl)) * (1 - near_water)
forest = np.clip(blur(forest, 2), 0, 1)
rock = np.clip(blur(rock, 1), 0, 1)
rock = np.maximum(rock, np.clip(CLIFFZ[::2, ::2] * 1.4, 0, 1))  # (the cliffs' faces: bare rock)
# BARE ROCK ON ORDINARY GROUND, often (the user: "I need the rock-coloured terrain with no grass, often"): patches of
# exposed bedrock 6–60 m across over the meadows and slopes — more on the rises and the knolls' tops, none in the
# water, on a track's earth or under the forest
pr = fbm(X4 / 70, Z4 / 70, SEED + 96, 3) + 0.45 * fbm(X4 / 22, Z4 / 22, SEED + 97, 2) + 0.25 * fbm(X4 / 8, Z4 / 8, SEED + 98, 2)
rise = np.clip((H4 - blur(H4, 12)) / 6, -1, 1)  # (+ on a local top)
bare = smoothstep(0.42, 0.5, pr + 0.18 * rise + 0.25 * smoothstep(0.08, 0.3, sl))
bare *= (1 - smoothstep(0.55, 0.85, wet)) * (1 - smoothstep(0.35, 0.6, forest))
rock = np.maximum(rock, bare)
# (the tracks stay earth — except up a trekking hill, where they crawl the rock)
Dt4 = Dt[::2, ::2]
rock = rock * (1 - (1 - np.maximum(TZ4, ROCKZ[::2, ::2])) * smoothstep(TRAIL_HW + 5, TRAIL_HW + 1.5, Dt4))
# the hill field's BARE ROCK caps (paint only: rock-coloured ground, no grass)
rock = np.maximum(rock, np.clip(blur(ROCKTEX[::2, ::2], 1), 0, 1) * (1 - smoothstep(TRAIL_HW + 4, TRAIL_HW + 1, Dt4)))
# the outcrops: rock, a ragged painted edge
rock = np.maximum(rock, np.maximum(ROCKZ[::2, ::2], ROCKZ[1::2, 1::2] if ROCKZ[1::2, 1::2].shape == ROCKZ[::2, ::2].shape else ROCKZ[::2, ::2]))
# the hidden basins: sheer rock walls, a lush floor (green, never straw, no forest — a clearing), the gorge rock too
HL4 = HLUSH[::2, ::2]
rock = np.maximum(rock * (1 - HL4), HROCK[::2, ::2])
dry = dry * (1 - 0.9 * HL4)
forest = forest * (1 - HL4)
HM4 = HMEAD[::2, ::2]
rock = rock * (1 - HM4)
dry = dry * (1 - 0.6 * HM4)
forest = np.maximum(forest, np.clip(HRING[::2, ::2] * 1.2, 0, 1))

# ---------------------------------------------------------------------------------------------------------- write
os.makedirs(OUT, exist_ok=True)
def u16(H):
    lo, hi = float(H.min()), float(H.max())
    return np.round((H - lo) / (hi - lo) * 65535).astype('<u2'), lo, hi - lo
q_in, in_min, in_range = u16(Hi)
q_far, far_min, far_range = u16(Hf)
q_in.tofile(os.path.join(OUT, 'height.bin'))
q_far.tofile(os.path.join(OUT, 'far.bin'))
# B: wet 0..0.85, and 1 = open water and its gravel edge (river channel, lake) — the grass and the bed paint read it
water4 = (Dr4 < Hw4 * 1.35) | (Lq4 < 1.003) | (PQ4 < 1.06)  # (the water + a strip of wet gravel: no grass at the water's edge)
wetb = np.where(water4, 1.0, 0.85 * wet)
mask = np.stack([rock, dry, wetb, forest], -1)
np.round(np.clip(mask, 0, 1) * 255).astype(np.uint8).tofile(os.path.join(OUT, 'mask.bin'))
# trail.bin: R8 on the 2 m grid — distance to the nearest track's centre line, 0..8 m (255 = 8 m or more)
np.round(np.clip(Dt / 8.0, 0, 1) * 255).astype(np.uint8).tofile(os.path.join(OUT, 'trail.bin'))
rv = RIVER_L[::3]
rs = _racc[::3]
meta = {
    'rocks': [[round(a, 1), round(b, 1), round(r, 1)] for a, b, r in sites],
    'id': 'valley', 'name': 'The Valley',
    'inner': {'n': N_IN, 'step': 2.0, 'origin': -HALF, 'min': in_min, 'range': in_range},
    'far': {'n': N_FAR, 'step': 16.0, 'origin': -FAR_HALF, 'min': far_min, 'range': far_range},
    'mask': {'n': N_MID, 'step': 4.0, 'origin': -HALF},
    'water': {
        'lake': {'cx': LAKE['cx'], 'cz': LAKE['cz'], 'rx': LAKE['rx'], 'rz': LAKE['rz'], 'rot': LAKE['rot'], 'level': LAKE_LEVEL},
        'ponds': PONDW,
        'river': {'x': [round(float(v), 2) for v in rv[:, 0]], 'z': [round(float(v), 2) for v in rv[:, 1]],
                  'y': [round(float(v), 3) for v in river_surface(rs)], 'hw': [round(float(v), 2) for v in river_halfwidth(rs)]},
    },
    'spawn': spawn,
    'hidden': [{k_: v_ for k_, v_ in h.items() if k_ not in ('ox', 'oz')} for h in HIDDEN],
    'spurs': [[round(v, 1) for v in s_] for s_ in SPURS],
    'bridges': BRIDGES,
    'trails': {'hw': TRAIL_HW, 'lines': [[[round(float(a), 1), round(float(b), 1)] for a, b in T[::2]] for T in TRAILS],
               'rough': [i for i, t in enumerate(TREKS) if t]},  # (the rock-crawling routes: ledges and blocks kept)
}
with open(os.path.join(OUT, 'meta.json'), 'w') as f: json.dump(meta, f)
log(f'wrote {OUT}: box {in_min:.1f}..{in_min + in_range:.1f} m, world {far_min:.1f}..{far_min + far_range:.1f} m, spawn {spawn}')
log(f'  rock {rock.mean():.2f}  dry {dry.mean():.2f}  wet {wet.mean():.2f}  forest {forest.mean():.2f}')

# ---------------------------------------------------------------------------------------------------------- preview
if PREVIEW:
    import bpy
    os.makedirs(PREVIEW, exist_ok=True)
    def shade(H, cell):
        gz, gx = np.gradient(H, cell)
        nx, ny, nz = -gx, np.ones_like(H), -gz
        L = np.array([-0.5, 0.6, -0.62]); L /= np.linalg.norm(L)
        return np.clip((nx * L[0] + ny * L[1] + nz * L[2]) / np.sqrt(nx * nx + 1 + nz * nz), 0, 1)
    def save(name, rgb):
        n = rgb.shape[0]
        img = bpy.data.images.new(name, n, n, alpha=False)
        px = np.concatenate([rgb[::-1], np.ones(rgb.shape[:2] + (1,))], -1).astype(np.float32)  # row 0 = north (top)
        img.pixels.foreach_set(px.ravel())
        img.filepath_raw = os.path.join(PREVIEW, name + '.png'); img.file_format = 'PNG'; img.save()
    s4 = shade(H4, 4.0)[..., None]
    straw = np.array([0.85, 0.62, 0.25]); green = np.array([0.33, 0.52, 0.22]); rk = np.array([0.6, 0.58, 0.62])
    fo = np.array([0.12, 0.3, 0.14]); wat = np.array([0.25, 0.55, 0.65])
    col = green + (straw - green) * dry[..., None]
    col = col + (fo - col) * (forest[..., None] * 0.8)
    col = col + (rk - col) * rock[..., None]
    water = (Lq4 < 1) | (Dr4 < river_halfwidth(0) * 0.9) | (PQ4 < 1)
    col[water] = wat
    col[Dt[::2, ::2] < TRAIL_HW] = np.array([0.95, 0.8, 0.6])
    save('inner', col * (0.35 + 0.75 * s4))
    sf = shade(Hf, 16.0)[..., None]
    hn = ((Hf - Hf.min()) / (Hf.max() - Hf.min()))[..., None]
    save('far', (0.3 + 0.7 * hn) * (0.3 + 0.8 * sf) * np.array([1.0, 0.95, 0.9]))
    log('preview written to', PREVIEW)
