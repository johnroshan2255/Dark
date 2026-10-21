# THE ISLAND — road beds (2026-10-21). Re-grades every road of the map and carves a drivable bed for it into the
# heightfield, so no road runs along a hill face, into a cut wall or up a step. Runs in Blender's Python (numpy):
#   blender -b --factory-startup --python scripts/blender/island/roads.py -- MAP=public/maps/island [WRITE=1] [OUT=<dir>]
# Run once on the desert rebuild's output (git 7cd78ee); re-running on its own output is a near no-op.
# (or through the MCP socket: node scripts/blender/bl.mjs scripts/blender/island/roads.py MAP=… WRITE=1).
# Without WRITE it reports and, with OUT, writes heights.bin + map.json there (for previews / the audit).
#
# Why: on a fixed map the terrain grid IS the road surface (the ribbon drapes it, WorldFields.height = the grid), so
# a road is only as good as the bed carved under it. The export's beds drifted off some centrelines (summit_road by
# the lake), roads met inside each other's cut walls (summit_west → coast_highway) and the desert rebuild mixed two
# height references (its new roads stored world heights, the old ones map heights: 6–10 m steps where they meet).
#
#   1. PROFILE per road (on its 4 m samples): the ground under the centreline where it agrees with the road's own
#      graded heights (after a local, slowly varying bias: the desert's 6 m), the graded heights where it doesn't
#      (walls / holes), median-filtered, ends snapped onto the road they join (highways → tracks → trails), smoothed
#      and grade-limited (GMAX per class). Bridge samples keep their deck heights.
#   2. BED: every grid cell within BED_PAD of a road (half width + BED_PAD) takes the road's height (flat across; the
#      higher class wins where beds overlap). Round it each road sample opens a cone — cut CUT m/m up, fill FILL m/m
#      down, opening quadratically past CONE_T m so far cliffs stay cliffs — and the ground is clipped into all cones
#      (where two stacked roads' cones disagree, a distance-weighted blend: a steep bank between switchback legs).
#   3. map.json heights = the profiles (map units), set pieces re-seated on the new ground (props.json y).
import copy, json, os, sys
import numpy as np

ARGS = dict(a.split('=', 1) for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []))
G = globals()
def arg(k, d=None): return ARGS.get(k, G.get(k, d))
MAP = arg('MAP'); WRITE = arg('WRITE', '0') == '1'; OUT = arg('OUT')

meta = json.load(open(os.path.join(MAP, 'map.json')))
props = json.load(open(os.path.join(MAP, 'props.json')))
g = meta['grid']; N = g['n']; ST = g['step']; OFF = meta['heightOffset']; HALF = meta['half']
H0 = np.fromfile(os.path.join(MAP, 'heights.bin'), dtype='<u2').reshape(N, N).astype(np.float64) / 65535 * g['range'] + g['min'] + OFF
xs = -HALF + np.arange(N) * ST
X, Z = np.meshgrid(xs, xs)  # X[j, i] = x_i, Z[j, i] = z_j

RANK = {'highway': 3, 'track': 2, 'pump': 1, 'trail': 1}
GMAX = {'highway': 0.12, 'track': 0.10, 'pump': 0.25, 'trail': 0.22}
BED_PAD = 1.0          # flat bed past the map's half width (m)
CUT, FILL = 1.25, 0.95 # bank slopes next to the bed (m/m): ~51° cut, ~44° fill
SHEER = {'mesa_cliff_road': (2.2, 2.4), 'canyon_road': (2.2, 2.4)}  # cliff shelf / slot canyon: sheer walls
CONE_T, CONE_K = 2.0, 1.0  # past CONE_T m off the bed the banks open by CONE_K·(t − CONE_T)²: only the first few m
                           # are re-sloped, a cliff beyond stays a cliff (no mountainside shaved off)
REACH = 24.0           # m: no cone binds further out

def sample(Hf, x, z):
    gx = np.clip((np.asarray(x) + HALF) / ST, 0, N - 1.001); gz = np.clip((np.asarray(z) + HALF) / ST, 0, N - 1.001)
    i = gx.astype(int); j = gz.astype(int); fx = gx - i; fz = gz - j
    return Hf[j, i] * (1 - fx) * (1 - fz) + Hf[j, i + 1] * fx * (1 - fz) + Hf[j + 1, i] * (1 - fx) * fz + Hf[j + 1, i + 1] * fx * fz

def wins(a, r, closed):
    """Sliding windows of ±r samples (wrapping on closed roads, edge-padded on open ones)."""
    p = np.pad(a, r, mode='wrap' if closed else 'edge')
    return np.lib.stride_tricks.sliding_window_view(p, 2 * r + 1)

def grade(h, ds, gmax, fixed, closed, k=3, passes=3):
    """Smooth (box ±k samples) and limit the grade to gmax keeping `fixed` indices (forward / back clamp sweeps)."""
    h = h.copy()
    def clamp(h):
        for i, v in fixed.items(): h[i] = v
        n = len(h)
        for _ in range(40):
            ch = 0.0
            for i in range(1, n) if not closed else range(n):
                if i in fixed: continue
                v = min(max(h[i], h[i - 1] - gmax * ds[i - 1]), h[i - 1] + gmax * ds[i - 1]); ch = max(ch, abs(v - h[i])); h[i] = v
            for i in range(n - 2, -1, -1):
                if i in fixed: continue
                j = (i + 1) % n
                v = min(max(h[i], h[j] - gmax * ds[i]), h[j] + gmax * ds[i]); ch = max(ch, abs(v - h[i])); h[i] = v
            if ch < 1e-3: break
        return h
    for _ in range(passes):
        h = clamp(h)
        h = wins(h, k, closed).mean(1)
        for i, v in fixed.items(): h[i] = v
    return clamp(h)

def cut_road(r, a, b):
    r = dict(r)
    for k in ('x', 'z', 'h', 'bridge'): r[k] = r[k][a:b]
    return r

def seg_cross(r, o):
    """Sample indices k of r where r's segment k → k+1 crosses o's centreline."""
    ox, oz = np.array(o['x']), np.array(o['z'])
    out = []
    for k in range(len(r['x']) - 1):
        ax, az, bx, bz = r['x'][k], r['z'][k], r['x'][k + 1], r['z'][k + 1]
        cx, cz, dx, dz = ox[:-1], oz[:-1], ox[1:], oz[1:]
        den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx)
        with np.errstate(divide='ignore', invalid='ignore'):
            t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den
            u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den
        if np.any((t >= 0) & (t <= 1) & (u >= 0) & (u <= 1)): out.append(k)
    return out

# summit_road left lake_road at the lake's south shore, ran 90 m beside it and CROSSED it 13 m higher (no bridge):
# a ramp up lake_road's cut wall. It now starts where it crossed: an at-grade junction on lake_road.
START_AT_CROSSING = {'summit_road': 'lake_road'}
byname = {r['name']: r for r in meta['roads']}
for nm, onm in START_AT_CROSSING.items():
    if nm not in byname or onm not in byname: continue  # (the island's roads; other maps don't have them)
    ks = [k for k in seg_cross(byname[nm], byname[onm]) if k > 2]
    if ks: byname[nm] = cut_road(byname[nm], ks[0] + 1, None); print(nm, 'starts at its crossing with', onm, '(dropped', ks[0] + 1, 'samples)')

def min_dist(o, x, z):
    ox, oz = np.array(o['x']), np.array(o['z'])
    return float(np.min(np.hypot(ox - x, oz - z)))

# An end that runs ALONGSIDE the road it joins (summit_west beside coast_highway) has its bed inside the other's:
# trim it back to the first sample that comes within both half widths of that road.
RANK0 = {'highway': 3, 'track': 2, 'pump': 1, 'trail': 1}
for nm, r in list(byname.items()):
    if r['closed']: continue
    for end in (0, -1):
        n = len(r['x']); ex, ez = r['x'][end], r['z'][end]
        o = min((o for o in byname.values() if o is not r and RANK0.get(o['class'], 1) >= RANK0.get(r['class'], 1)),
                key=lambda o: min_dist(o, ex, ez))
        if min_dist(o, ex, ez) > o['halfWidth'] + 3: continue
        lim = o['halfWidth'] + r['halfWidth']
        order = range(n) if end == 0 else range(n - 1, -1, -1)
        first = None
        for k in order:
            if min_dist(o, r['x'][k], r['z'][k]) < lim: first = k
            else: break
        if first is None: continue
        keep = abs(first - (0 if end == 0 else n - 1))
        if keep >= 4:  # ≥ 16 m alongside (a normal junction just arrives); end on the joined centreline again
            r = cut_road(r, first, None) if end == 0 else cut_road(r, 0, first + 1)
            ox, oz = np.array(o['x']), np.array(o['z']); kk = int(np.argmin(np.hypot(ox - r['x'][end], oz - r['z'][end])))
            pt = {'x': float(ox[kk]), 'z': float(oz[kk]), 'h': float(o['h'][kk]), 'bridge': 0}
            for f in ('x', 'z', 'h', 'bridge'): r[f] = ([pt[f]] + r[f]) if end == 0 else (r[f] + [pt[f]])
            byname[nm] = r
            print(nm, 'end', end, 'beside', o['name'], ': trimmed', keep, 'samples')
meta['roads'] = [byname[r['name']] for r in meta['roads']]

roads = meta['roads']
R = []
for r in roads:
    x = np.array(r['x'], float); z = np.array(r['z'], float); h = np.array(r['h'], float) + OFF
    terr = sample(H0, x, z)
    br = np.array(r['bridge'], bool)
    # The desert rebuild's new roads stored world heights (the rest: map heights) — undo it.
    if abs(np.median(terr - h) + OFF) < 0.6 and abs(OFF) > 1: h = h - OFF
    nxt = np.roll(np.stack([x, z], 1), -1, 0) if r['closed'] else np.vstack([np.stack([x, z], 1)[1:], [[x[-1] + 1e-3, z[-1]]]])
    ds = np.maximum(0.5, np.hypot(nxt[:, 0] - x, nxt[:, 1] - z))
    R.append(dict(r=r, name=r['name'], cls=r['class'], closed=r['closed'], x=x, z=z, href=h, terr=terr, br=br, ds=ds,
                  hw=r['halfWidth'], rank=RANK.get(r['class'], 1),
                  # never steeper than the class allows, but never flatter than the export graded it (re-grading a
                  # whole road would re-carve it; only the broken spots should move)
                  gmax=min(0.3, max(GMAX.get(r['class'], 0.2), float(np.max((np.abs(np.diff(h)) / ds[:len(h) - 1])[1:-1])) + 0.01))))

def base_profile(q):
    """Ground under the centreline where it agrees with the road's own graded heights (after the slowly varying
    local bias), the graded heights where the ground is a wall or a hole; then a ±3 sample median."""
    d = q['terr'] - q['href']
    d = np.where(q['br'], np.nan, d)
    bias = np.nanmedian(wins(d, 25, q['closed']), 1)  # ±100 m
    bias = np.where(np.isnan(bias), 0, bias)
    init = q['href'] + bias
    p = np.where(np.abs(q['terr'] - init) < 1.5, q['terr'], init)
    p = np.median(wins(p, 3, q['closed']), 1)
    return np.where(q['br'], q['href'], p)

for q in R: q['p'] = base_profile(q); q['h'] = q['p'].copy()

def nearest_on(q, x, z):
    """Nearest point of road q to (x, z): (distance, height there)."""
    px, pz = q['x'], q['z']
    ax, az = px[:-1], pz[:-1]; bx, bz = px[1:], pz[1:]
    if q['closed']: ax, az, bx, bz = px, pz, np.roll(px, -1), np.roll(pz, -1)
    ex, ez = bx - ax, bz - az; L2 = np.maximum(1e-9, ex * ex + ez * ez)
    t = np.clip(((x - ax) * ex + (z - az) * ez) / L2, 0, 1)
    d = np.hypot(ax + ex * t - x, az + ez * t - z)
    k = int(np.argmin(d)); hh = q['h']
    h1 = hh[(k + 1) % len(hh)]
    return float(d[k]), float(hh[k] + (h1 - hh[k]) * t[k])

# Junctions: an open road's end within the joined road's bed takes its height (the joined road is of the same or a
# higher class). Three sweeps settle chains (trail → trail → highway).
JOIN = {}
for q in R:
    if q['closed']: continue
    for end in (0, len(q['x']) - 1):
        best = None
        for o in R:
            if o is q or o['rank'] < q['rank']: continue
            d, _ = nearest_on(o, q['x'][end], q['z'][end])
            if d < o['hw'] + 3 and (best is None or (o['rank'], -d) > (best[0]['rank'], -best[1])): best = (o, d)
        if best: JOIN[(q['name'], end)] = best[0]
for sweep in range(3):
    for q in sorted(R, key=lambda q: -q['rank']):
        fixed = {}
        for end in (0, len(q['x']) - 1):
            o = JOIN.get((q['name'], end))
            if o is not None: fixed[end] = nearest_on(o, q['x'][end], q['z'][end])[1]
        for i in np.nonzero(q['br'])[0]: fixed[int(i)] = q['href'][i]
        q['h'] = grade(q['p'], q['ds'], q['gmax'], fixed, q['closed'])

# ---------------------------------------------------------------- carve
BED = np.full(H0.shape, np.nan); BEDD = np.full(H0.shape, np.inf); BEDR = np.zeros(H0.shape)
LO = np.full(H0.shape, -np.inf); LOT = np.ones(H0.shape); HI = np.full(H0.shape, np.inf); HIT = np.ones(H0.shape)
RC = int(REACH / ST) + 1
for q in sorted(R, key=lambda q: q['rank']):
    x, z, h = q['x'], q['z'], q['h']
    if q['closed']: x, z, h, br = np.r_[x, x[:1]], np.r_[z, z[:1]], np.r_[h, h[:1]], np.r_[q['br'], q['br'][:1]]
    else: br = q['br']
    seg = np.hypot(np.diff(x), np.diff(z)); s = np.r_[0, np.cumsum(seg)]
    ss = np.arange(0, s[-1] + 1e-6, 1.0)
    rx, rz, rh = np.interp(ss, s, x), np.interp(ss, s, z), np.interp(ss, s, h)
    # the deck span only (between bridge samples): the banks up to the first / last one are carved to the deck
    # height (a ±4 m margin left a 3 m bank lip above the deck start on river_bend: the car high-centred on it)
    rb = np.interp(ss, s, br.astype(float)) > 0.999
    bw = q['hw'] + BED_PAD
    cut, fill = SHEER.get(q['name'], (CUT, FILL))
    for k in range(len(rx)):
        if rb[k]: continue
        i, j = int(round((rx[k] + HALF) / ST)), int(round((rz[k] + HALF) / ST))
        sl = (slice(max(0, j - RC), j + RC + 1), slice(max(0, i - RC), i + RC + 1))
        d = np.hypot(X[sl] - rx[k], Z[sl] - rz[k])
        inb = (d <= bw) & ((q['rank'] > BEDR[sl]) | (d < BEDD[sl]))
        BED[sl] = np.where(inb, rh[k], BED[sl]); BEDD[sl] = np.where(inb, d, BEDD[sl]); BEDR[sl] = np.where(inb, q['rank'], BEDR[sl])
        t = np.maximum(0, d - bw)
        open_ = CONE_K * np.maximum(0, t - CONE_T) ** 2
        lo = np.where(d < REACH, rh[k] - fill * t - open_, -np.inf); hi = np.where(d < REACH, rh[k] + cut * t + open_, np.inf)
        up = lo > LO[sl]; LO[sl] = np.where(up, lo, LO[sl]); LOT[sl] = np.where(up, t + 0.5, LOT[sl])
        dn = hi < HI[sl]; HI[sl] = np.where(dn, hi, HI[sl]); HIT[sl] = np.where(dn, t + 0.5, HIT[sl])
ok = LO <= HI
LOc = np.where(np.isfinite(LO), LO, H0); HIc = np.where(np.isfinite(HI), HI, H0)
blend = (LOc / LOT + HIc / HIT) / (1 / LOT + 1 / HIT)
HF = np.where(ok, np.clip(H0, LO, HI), blend)
HF = np.where(np.isnan(BED), HF, BED)

# ---------------------------------------------------------------- report
dif = HF - H0
print('cells changed > 0.5 m', int((np.abs(dif) > 0.5).sum()), 'max raise', round(float(dif.max()), 1), 'max cut', round(float(dif.min()), 1),
      'cone conflicts', int((~ok).sum()))
for q in R:
    hh = q['h']; dh = np.abs(np.diff(hh)) / q['ds'][:-1] if not q['closed'] else np.abs(np.roll(hh, -1) - hh) / q['ds']
    moved = np.abs(hh - q['href']); joins = [JOIN[(q['name'], e)]['name'] for e in (0, len(hh) - 1) if (q['name'], e) in JOIN]
    print(f"{q['name']:22s} max grade {dh.max():.2f}  moved from export: median {np.median(moved):4.1f} max {moved.max():5.1f}  joins {joins}")

def enc(Hf):
    v = np.round((Hf - g['min'] - OFF) / g['range'] * 65535)
    if v.min() < 0 or v.max() > 65535: print('WARNING: heights clipped to the grid range')
    return np.clip(v, 0, 65535).astype('<u2')

def save(dst):
    os.makedirs(dst, exist_ok=True)
    enc(HF).tofile(os.path.join(dst, 'heights.bin'))
    m2 = dict(meta)
    m2['roads'] = []
    for q in R:
        r2 = dict(q['r']); r2['h'] = [round(float(v) - OFF, 2) for v in q['h']]; m2['roads'].append(r2)
    json.dump(m2, open(os.path.join(dst, 'map.json'), 'w'), separators=(',', ':'))
    NATURE = {'pine', 'pine_snow', 'oak', 'birch', 'cherry', 'palm', 'rock', 'rock_snow', 'rock_red', 'bush', 'grass_tuft', 'cactus', 'log', 'stump', 'boulder', 'dead_tree'}
    pr = copy.deepcopy(props); st = pr['stride']
    for tile in pr['placements'].values():
        for tp, a in tile.items():
            if tp in NATURE: continue
            for o in range(0, len(a), st):
                a[o + 1] = round(a[o + 1] + float(sample(dif, a[o], a[o + 2])), 2)
    json.dump(pr, open(os.path.join(dst, 'props.json'), 'w'), separators=(',', ':'))
    print('written to', dst)

if OUT: save(OUT)
if WRITE: save(MAP)
