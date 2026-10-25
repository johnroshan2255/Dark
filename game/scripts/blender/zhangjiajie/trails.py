# ZHANGJIAJIE — OFF-ROAD TRACKS up every hill, PONDS and LAKES, BRIDGES (2026-10-24, the user: "map 3 is perfect, just
# add off-road / trucking roads to almost all hills, nothing else changes; add some lakes and ponds and bridges too; make
# sure they are actually drivable, not 90 % straight up"). Runs in Blender's Python (numpy only) on the BUILT map:
#   blender -b --factory-startup --python scripts/blender/zhangjiajie/trails.py -- MAP=<abs>/public/maps/zhangjiajie [WRITE=1]
# then scripts/blender/island/roads.py -- MAP=… WRITE=1 grades every road and carves the beds (as for the map's own roads).
#
#  1. PONDS + LAKES: on the flat valley floors (≤ ~12 m over the water, gentle, clear of every road by 30 m) a few
#     irregular basins (a noise-warped outline, 25–70 m; two lakes 110–150 m) dug below the map's one water level
#     (WorldFields.WATER), shelving shores. heights.bin.
#  2. HILLS: every hill top ≥ RISE m over its valley floor (one per hill: the highest point of each connected high area),
#     not already near a road.
#  3. SHELF TRACKS: the Zhangjiajie hills are towers — stepped walls all round, no line up them under ~40 %. So each track
#     is a MOUNTAIN SHELF ROAD, as real ones are: from the nearest road it runs to the hill's foot, then winds up ROUND
#     the hill at a steady GRADE (15 %) following the hill's own contour at the height it has reached (the outward-first
#     crossing of that height on the ray from the top, set CUT_IN m into the slope: the bed is cut into the flank, its
#     outer edge on the ground), and pulls in onto the top at the end. Both directions round are tried; the one with
#     the smaller cuts / fills wins. Never steeper than GRADE (roads.py re-grades ≤ the trail class's 22 % and carves).
#  4. BRIDGES: where a track crosses water (a river, a pond) its samples are decked level from bank to bank (the road's
#     `bridge` flags: the game builds the deck), the approaches ramped at the grade.
#  5. map.json: each track {'class': 'trail', halfWidth HW} — drawn as the TRAIL type (ruts, grassy hump, mud).
import json, math, os, sys, time
import numpy as np

ARGS = dict(a.split('=', 1) for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []))
MAP = ARGS['MAP']; WRITE = ARGS.get('WRITE') == '1'
RISE = float(ARGS.get('RISE', 30)); GRADE = float(ARGS.get('GRADE', 0.15)); HW = float(ARGS.get('HW', 3.2))
CUT_IN = float(ARGS.get('CUT_IN', 4.0)); MAXN = int(ARGS.get('MAXN', 40)); PONDS = int(ARGS.get('PONDS', 9))
t0 = time.time()
rng = np.random.default_rng(int(ARGS.get('SEED', 77)))
meta = json.load(open(os.path.join(MAP, 'map.json')))
g = meta['grid']; N = g['n']; ST = g['step']; OFF = meta['heightOffset']; HALF = meta['half']
H = np.fromfile(os.path.join(MAP, 'heights.bin'), dtype='<u2').reshape(N, N).astype(np.float64) / 65535 * g['range'] + g['min'] + OFF
WATER = -6.0
meta['roads'] = [r for r in meta['roads'] if not r['name'].startswith('trail_')]   # (re-runnable: replaces earlier tracks)
xs = -HALF + np.arange(N) * ST
X, Z = np.meshgrid(xs, xs)

def box(a, r, axis):
    if r <= 0: return a
    p = np.pad(a, [(r + 1, r) if k == axis else (0, 0) for k in range(a.ndim)], mode='edge')
    c = np.cumsum(p, axis=axis); n = a.shape[axis]
    return (np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis) - np.take(c, np.arange(0, n), axis=axis)) / (2 * r + 1)
def blur(a, s):
    r = max(1, int(round((math.sqrt(4 * s * s + 1) - 1) / 2)))
    for ax in (0, 1):
        for _ in range(3): a = box(a, r, ax)
    return a
def maxf(a, r):
    from numpy.lib.stride_tricks import sliding_window_view as sw
    p = np.pad(a, r, mode='edge'); a = sw(p, 2 * r + 1, axis=1).max(-1); return sw(a, 2 * r + 1, axis=0).max(-1)
def minf(a, r): return -maxf(-a, r)
def sstep(a, b, x): t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)
def hs(x, z, Hh=None):
    Hh = H if Hh is None else Hh
    fx = (np.asarray(x, float) + HALF) / ST; fz = (np.asarray(z, float) + HALF) / ST
    i = np.clip(fx.astype(int), 0, N - 2); j = np.clip(fz.astype(int), 0, N - 2); tx = fx - i; tz = fz - j
    return Hh[j, i] * (1 - tx) * (1 - tz) + Hh[j, i + 1] * tx * (1 - tz) + Hh[j + 1, i] * (1 - tx) * tz + Hh[j + 1, i + 1] * tx * tz
def road_dist_grid(roads, step=4):
    """distance (m) to the nearest road centreline on a coarse grid (chamfer), upsampled."""
    nc = N // step + 1; D = np.full((nc, nc), 1e9)
    for r in roads:
        for x, z in zip(r['x'], r['z']):
            j, i = int(round((z + HALF) / (ST * step))), int(round((x + HALF) / (ST * step)))
            if 0 <= j < nc and 0 <= i < nc: D[j, i] = 0
    c = ST * step; d2 = c * math.sqrt(2)
    for _ in range(2):
        for j in range(1, nc): D[j] = np.minimum(D[j], D[j - 1] + c)
        for j in range(nc - 2, -1, -1): D[j] = np.minimum(D[j], D[j + 1] + c)
        for i in range(1, nc): D[:, i] = np.minimum(D[:, i], D[:, i - 1] + c)
        for i in range(nc - 2, -1, -1): D[:, i] = np.minimum(D[:, i], D[:, i + 1] + c)
    return np.kron(D, np.ones((step, step)))[:N, :N]
DR = road_dist_grid(meta['roads'])
floor = blur(minf(H, 45), 25)                    # (the valley floor within ~90 m, smoothed)
gz_, gx_ = np.gradient(H, ST); SL = np.hypot(gx_, gz_)

# ---------------------------------------------------------------- 1. ponds + lakes
def noise_ring(seed, n=24):
    r_ = np.random.default_rng(seed); a = r_.uniform(0.75, 1.25, n)
    for _ in range(2): a = 0.5 * a + 0.25 * (np.roll(a, 1) + np.roll(a, -1))
    return a
sites = (H > WATER + 1.5) & (H < WATER + 14) & (blur(SL, 4) < 0.08) & (DR > 70)
cand = np.argwhere(sites[::10, ::10]) * 10
rng.shuffle(cand)
ponds = []
for j, i in cand:
    if len(ponds) >= PONDS: break
    x, z = xs[i], xs[j]
    big = len(ponds) < 2
    R = rng.uniform(110, 150) if big else rng.uniform(25, 70)
    if any(math.hypot(x - p[0], z - p[1]) < R + p[2] + 220 for p in ponds): continue
    # the whole basin must sit on low, gentle ground clear of the roads
    rr = np.hypot(X - x, Z - z); inside = rr < R * 1.3
    if not inside.any() or DR[inside].min() < 30 + (15 if big else 0) or H[inside].max() > WATER + 22 or np.percentile(SL[inside], 90) > 0.35: continue
    ponds.append((x, z, R))
H_before = H.copy()
for k, (x, z, R) in enumerate(ponds):
    ring = noise_ring(500 + k)
    ang = np.arctan2(Z - z, X - x); rr = np.hypot(X - x, Z - z)
    sel = rr < R * 1.6
    a = (ang[sel] + math.pi) / (2 * math.pi) * len(ring)
    i0 = a.astype(int) % len(ring); f = a - np.floor(a)
    Rr = R * (ring[i0] * (1 - f) + ring[(i0 + 1) % len(ring)] * f)
    t = rr[sel] / Rr                             # 0 at the centre, 1 at the shore line
    depth = WATER - (2.0 + 3.5 * min(1.0, R / 80)) * (1 - sstep(0.0, 1.0, t))   # bed: 2–5.5 m under the water
    shore = WATER + 0.6 + (H[sel] - WATER - 0.6) * sstep(1.0, 1.45, t)       # shelving bank up to the old ground
    newh = np.where(t < 1.0, np.minimum(H[sel], np.maximum(depth, WATER - 0.4 - 3 * (1 - t))), np.minimum(H[sel], shore))
    H[sel] = newh
print(f'[{time.time() - t0:.0f}s] {len(ponds)} ponds / lakes: ' + ', '.join(f'({x:.0f},{z:.0f}) r{R:.0f}' for x, z, R in ponds))

# ---------------------------------------------------------------- 2. hill tops
hi = (H - floor > RISE) & (SL < 0.6)
lab = np.zeros(H.shape, np.int32)
# connected high areas (4-connected, on a 4 m grid for speed)
hs4 = hi[::2, ::2]; lab4 = np.zeros(hs4.shape, np.int32); nl = 0
for j in range(hs4.shape[0]):
    for i in range(hs4.shape[1]):
        if hs4[j, i] and not lab4[j, i]:
            nl += 1; st = [(j, i)]; lab4[j, i] = nl
            while st:
                a, b = st.pop()
                for c_, d_ in ((a + 1, b), (a - 1, b), (a, b + 1), (a, b - 1)):
                    if 0 <= c_ < hs4.shape[0] and 0 <= d_ < hs4.shape[1] and hs4[c_, d_] and not lab4[c_, d_]:
                        lab4[c_, d_] = nl; st.append((c_, d_))
tops = []
H4 = H[::2, ::2]; F4 = floor[::2, ::2]; D4 = DR[::2, ::2]
for l in range(1, nl + 1):
    m = lab4 == l
    if m.sum() < 120: continue                   # (≥ ~2000 m²: a hill, not a boulder of the relief)
    k = np.argmax(np.where(m, H4, -1e9)); j, i = np.unravel_index(k, m.shape)
    if D4[j, i] < 60: continue                    # (a road already runs past it)
    tops.append((float(H4[j, i] - F4[j, i]), float(xs[i * 2]), float(xs[j * 2]), float(H4[j, i])))
tops.sort(reverse=True)
print(f'[{time.time() - t0:.0f}s] {len(tops)} hills to climb')

# ---------------------------------------------------------------- 3. shelf tracks
road_pts = np.concatenate([np.stack([r['x'], r['z'], np.array(r['h']) + OFF], 1) for r in meta['roads']])
def contour_r(cx, cz, ang, y, rmax=320.0):
    """Outward-first distance from the top where the ground falls below y along the ray (None: never in rmax)."""
    d = np.arange(2.0, rmax, 2.0)
    h = hs(cx + np.cos(ang) * d, cz + np.sin(ang) * d)
    k = np.nonzero(h < y)[0]
    return float(d[k[0]]) if len(k) else None
RMIN = float(ARGS.get('RMIN', 9.0))   # (a truck's turning circle at a crawl; ≥ 0.75 × kept)
def shelf(cx, cz, ytop, x0, z0, y0, sense):
    """The spiral from the hill's foot (x0, z0) at y0 round the top (cx, cz) up onto it; sense ±1 (round the clock or
    against). Each 4 m sample sits on the hill's CONTOUR at the height reached, CUT_IN m into the slope (radii median-
    filtered and smoothed over 5 samples: a ledge of the stepped walls is no jump); on the summit it runs on along the
    rim, level, for 24 m (no straight pull-in: that was a right-angle bend). None: no climbable flank."""
    ang = math.atan2(z0 - cz, x0 - cx); y = y0; A = []; R = []; Y = []
    while y < ytop - 1.0:
        if len(A) > 650: return None             # (≈ 2.6 km: no climbable flank)
        rc = contour_r(cx, cz, ang, y)
        if rc is None: return None
        r = max(9.0, rc - CUT_IN)
        A.append(ang); R.append(r); Y.append(y)
        ang += sense * 4.0 / r
        y += GRADE * 4.0
    if not A: return None
    for k in range(6):
        A.append(ang); R.append(max(9.0, R[-1] * 0.97)); Y.append(Y[-1]); ang += sense * 4.0 / R[-1]
    Rm = np.array(R)
    if len(Rm) >= 5: Rm = np.median(np.stack([np.r_[Rm[:1].repeat(2), Rm[:-2]], np.r_[Rm[:1], Rm[:-1]], Rm, np.r_[Rm[1:], Rm[-1:]], np.r_[Rm[2:], Rm[-1:].repeat(2)]]), 0)
    Rm = np.convolve(np.pad(Rm, 2, mode='edge'), np.ones(5) / 5, 'valid')
    pts = np.array([(cx + math.cos(a_) * r_, cz + math.sin(a_) * r_, y_) for a_, r_, y_ in zip(A, Rm, Y)])
    if (pts[:-6, 2] - hs(pts[:-6, 0], pts[:-6, 1])).max() > 6.0: return None
    return pts
def cost(pts):
    g_ = hs(pts[:, 0], pts[:, 1])
    return float(np.mean(np.abs(g_ - pts[:, 2]))) + 0.02 * len(pts)
def bend_radii(p):
    a_ = p[2:, :2] - p[1:-1, :2]; b_ = p[1:-1, :2] - p[:-2, :2]
    L_ = 0.5 * (np.hypot(*a_.T) + np.hypot(*b_.T))
    return L_ / np.maximum(np.abs(np.arctan2(a_[:, 0] * b_[:, 1] - a_[:, 1] * b_[:, 0], (a_ * b_).sum(1))), 1e-4)
def resample4(p):
    sd = np.r_[0, np.cumsum(np.hypot(*np.diff(p[:, :2], axis=0).T))]
    t = np.arange(0, sd[-1] + 1e-6, 4.0)
    return np.stack([np.interp(t, sd, p[:, 0]), np.interp(t, sd, p[:, 1]), np.interp(t, sd, p[:, 2])], 1)
added = []
ends = []
for rise, cx, cz, ytop in tops:
    if len(added) >= MAXN: break
    if abs(cx) > HALF - 150 or abs(cz) > HALF - 150: continue       # (the map's rim: off the edge of the play area)
    if any(math.hypot(cx - ex, cz - ez) < 220 for ex, ez in ends): continue   # (a track already tops out here)
    # the start: the nearest point of a road (the map's or an earlier track's) — the track leaves it toward the hill
    d = np.hypot(road_pts[:, 0] - cx, road_pts[:, 1] - cz)
    k = int(np.argmin(d)); sx, sz, sy = road_pts[k]
    if d[k] > 700 or d[k] < 60: continue
    # connector: from the road to the hill's foot on that side (the contour at the road's height), on the ground
    ang0 = math.atan2(sz - cz, sx - cx)
    rf = contour_r(cx, cz, ang0, max(sy, WATER + 1.0) + 0.5) or math.hypot(sx - cx, sz - cz)
    rf = min(rf, math.hypot(sx - cx, sz - cz))
    fx, fz = cx + math.cos(ang0) * rf, cz + math.sin(ang0) * rf
    L = math.hypot(fx - sx, fz - sz)
    tt = np.linspace(0, 1, max(2, int(L / 4.0) + 1))
    con = [(sx + (fx - sx) * t, sz + (fz - sz) * t, float(hs(sx + (fx - sx) * t, sz + (fz - sz) * t)) if 0 < t < 1 else sy) for t in tt]
    y_foot = max(sy, float(hs(fx, fz)))
    best = None
    for sense in (1, -1):
        sp = shelf(cx, cz, ytop, fx, fz, y_foot, sense)
        if sp is None: continue
        c = cost(sp)
        if best is None or c < best[0]: best = (c, sp)
    if best is None:
        print(f'  hill ({cx:.0f}, {cz:.0f}) +{rise:.0f} m: no shelf round it'); continue
    pts = np.concatenate([np.array(con[:-1]).reshape(-1, 3), best[1]])
    sd = np.r_[0, np.cumsum(np.hypot(*np.diff(pts[:, :2], axis=0).T))]
    tt_ = np.arange(0, sd[-1], 4.0)
    pts = np.stack([np.interp(tt_, sd, pts[:, 0]), np.interp(tt_, sd, pts[:, 1]), np.interp(tt_, sd, pts[:, 2])], 1)
    # DRIVABLE BENDS: where the connector meets the shelf (a right angle) or a ledge kinks it, relax the centreline
    # LOCALLY (±4 samples round each bend under RMIN; a whole-loop relaxation shrinks the spiral and tightens it)
    for it in range(120):
        rad_ = bend_radii(pts)
        tight = np.nonzero(rad_ < RMIN)[0] + 1
        if not len(tight): break
        m_ = np.zeros(len(pts), bool)
        for t_ in tight: m_[max(1, t_ - 4):min(len(pts) - 1, t_ + 5)] = True
        m_[-8:] = False                          # (the summit tail: relaxing a loop's end shrinks it onto the top)
        if not m_.any(): break
        sm = pts.copy(); sm[1:-1, :2] = 0.5 * pts[1:-1, :2] + 0.25 * (pts[:-2, :2] + pts[2:, :2])
        pts[m_, :2] = sm[m_, :2]
        if it % 10 == 9: pts = resample4(pts)
    pts = resample4(pts)
    # the profile: never steeper than the grade either way (up and down passes round the plan)
    y = pts[:, 2].copy()
    for _ in range(2):
        for k in range(1, len(y)): y[k] = min(max(y[k], y[k - 1] - GRADE * 4.0), y[k - 1] + GRADE * 4.0)
        for k in range(len(y) - 2, -1, -1): y[k] = min(max(y[k], y[k + 1] - GRADE * 4.0), y[k + 1] + GRADE * 4.0)
    y[0] = sy
    # 4. bridges: over water, decked level from bank to bank
    gnd = hs(pts[:, 0], pts[:, 1])
    wv = gnd < WATER + 0.8
    br = np.zeros(len(y), int); k = 0
    while k < len(y):
        if wv[k]:
            a = k
            while k < len(y) and wv[k]: k += 1
            L_, R_ = max(0, a - 1), min(len(y) - 1, k)
            y0 = max(y[L_], y[R_], WATER + 2.5); y[L_:R_ + 1] = y0; br[L_:R_ + 1] = 1; k = R_ + 1
        else: k += 1
    for _ in range(3):   # (the decks lifted to their banks: the approaches ramp down to them at the grade)
        for k in range(1, len(y)):
            if not br[k]: y[k] = max(y[k], y[k - 1] - GRADE * 4.0)
        for k in range(len(y) - 2, -1, -1):
            if not br[k]: y[k] = max(y[k], y[k + 1] - GRADE * 4.0)
    y = np.maximum(y, WATER + 0.9)
    # DRIVABLE or dropped: never steeper than the grade, cuts ≤ 25 m into the flank, fills ≤ 8 m, and it reaches the top
    cut = gnd - y; land = ~br.astype(bool)
    why = []
    if np.abs(np.diff(y)).max() / 4.0 > GRADE + 0.005: why.append(f'grade {np.abs(np.diff(y)).max() / 4.0:.2f}')
    if cut[land].max() > 25: why.append(f'cut {cut[land].max():.0f} m')
    if -cut[land].min() > 8: why.append(f'fill {-cut[land].min():.0f} m at {int(np.argmin(np.where(land, cut, 1e9))) * 4}/{len(y) * 4} m (ground {gnd[int(np.argmin(np.where(land, cut, 1e9)))]:.0f}, road {y[int(np.argmin(np.where(land, cut, 1e9)))]:.0f}, start {y[0]:.0f})')
    if y[-1] < ytop - 6: why.append(f'ends {ytop - y[-1]:.0f} m under the top')
    rmin = float(bend_radii(pts).min())
    # clear of every other road past its start (a crossing or an end beside one: roads.py levels and snaps them there —
    # a kink and a 30 % ramp)
    dmin = float(np.sqrt(((pts[6:, None, :2] - road_pts[None, ::2, :2]) ** 2).sum(-1)).min()) if len(pts) > 6 else 1e9
    if dmin < 14: why.append(f'runs {dmin:.0f} m from another road')
    if rmin < RMIN * 0.75: why.append(f'bend radius {rmin:.0f} m')
    if why:
        print(f'  hill ({cx:.0f}, {cz:.0f}) +{rise:.0f} m: dropped — ' + ', '.join(why)); continue
    name = f'trail_{len(added) + 1}'
    meta['roads'].append({'name': name, 'class': 'trail', 'halfWidth': HW, 'closed': False,
                          'x': [round(float(v), 2) for v in pts[:, 0]], 'z': [round(float(v), 2) for v in pts[:, 1]],
                          'h': [round(float(v - OFF), 2) for v in y], 'bridge': [int(b) for b in br]})
    added.append(name); ends.append((cx, cz))
    road_pts = np.concatenate([road_pts, np.stack([pts[:, 0], pts[:, 1], y], 1)])
    print(f'  {name}: hill ({cx:.0f}, {cz:.0f}) +{rise:.0f} m · {len(y) * 4} m · climb {y.max() - y[0]:.0f} m · max grade {np.abs(np.diff(y)).max() / 4:.2f} · cut ≤ {cut.max():.0f} m fill ≤ {-cut.min():.0f} m · {int(br.sum())} bridge samples · tightest bend {rmin:.0f} m')
print(f'[{time.time() - t0:.0f}s] {len(added)} tracks, {sum(len(r["x"]) * 4 for r in meta["roads"] if r["name"] in added) / 1000:.1f} km')
if WRITE:
    # (the pond beds go below the old encoded range: widen it — map.json grid.min / range, read by the game and the server)
    lo = min(g['min'], math.floor((H.min() - OFF) * 10) / 10); hi_ = max(g['min'] + g['range'], H.max() - OFF)
    g['min'] = round(lo, 3); g['range'] = round(hi_ - lo + 0.001, 3)
    q = np.clip((H - OFF - g['min']) / g['range'], 0, 1)
    (q * 65535).round().astype('<u2').tofile(os.path.join(MAP, 'heights.bin'))
    json.dump(meta, open(os.path.join(MAP, 'map.json'), 'w'), separators=(',', ':'))
    print('wrote heights.bin + map.json')
