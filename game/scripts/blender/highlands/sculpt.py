# THE HIGHLANDS — SCULPTED and ERODED like Zhangjiajie (2026-10-24, the user: "it must have the erosion like map 3, the
# same style"). Zhangjiajie's recipe (scripts/blender/zhangjiajie/terrain.py) on the Highlands' built relief:
#   blender -b --factory-startup --python scripts/blender/highlands/sculpt.py -- MAP=<abs>/public/maps/highlands OUT=<dir> [RENDER=1] [WRITE=1]
#
#  1. STRATA: the rock is bedded — hard beds (×0.45) and soft ones (×1.8) every ~26 m, warped: soft beds wear back into
#     ledges and overhung bands, the hard ones stand out as steps on every wall.
#  2. DROPLETS (Lague-style, vectorised, a 5×5 brush): rain runs off the tops, carves gullies and flutes down the walls,
#     notches the rims and drops its load as talus fans at the feet.
#  3. RIVERS + SCREE (what A.N.T. Landscape's eroder does in terrain.py, in numpy here): D8 flow accumulation incises
#     K·A^0.45·S^0.8 along the drainage (rills → gullies → ravines, sharp spurs between), loose ground steeper than
#     ~40° avalanches to its feet.
#  4. FLUTES + RIMS: ridged flutes on the steep rock, a jagged crest line.
#  5. PROTECTED (unchanged): 9 m round every road's edge (blended out over 12 m: the graded beds and their verges stay),
#     10 m round every set piece, 30 m round the spawn; water stays water, land stays land.
#  6. RENDER=1: Cycles views of the result in the map's colours (lime meadow, darker green banks, grey granite with
#     streaks and moss on the walls, the roads in their dirt) — in a scratch scene of a fresh (background) Blender.
#  WRITE=1 writes MAP/heights.bin (the game's format); always OUT/H0.npy, H1.npy, roads.npy.
import json, math, os, sys, time
import numpy as np
import bpy

ARGS = dict(a.split('=', 1) for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []))
MAP = ARGS['MAP']; OUT = ARGS['OUT']; os.makedirs(OUT, exist_ok=True)
t0 = time.time()
meta = json.load(open(os.path.join(MAP, 'map.json')))
G = meta['grid']; N = G['n']; ST = G['step']; OX, OZ = G['origin']; OFF = meta['heightOffset']
WATER = -6.0
raw = np.fromfile(os.path.join(MAP, 'heights.bin'), dtype='<u2').reshape(N, N)
H0 = (G['min'] + raw.astype(np.float64) / 65535.0 * G['range']) + OFF   # world metres, [z, x]
H = H0.copy()
xs = OX + np.arange(N) * ST
X, Z = np.meshgrid(xs, OZ + np.arange(N) * ST)
rng = np.random.default_rng(int(ARGS.get('SEED', 24)))

# ---------------------------------------------------------------- helpers (as zhangjiajie/build.py)
def box(a, r, axis):
    if r <= 0: return a
    p = np.pad(a, [(r + 1, r) if k == axis else (0, 0) for k in range(a.ndim)], mode='edge')
    c = np.cumsum(p, axis=axis); n = a.shape[axis]
    return (np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis) - np.take(c, np.arange(0, n), axis=axis)) / (2 * r + 1)
def blur(a, s):
    if s <= 0: return a
    r = max(1, int(round((math.sqrt(4 * s * s + 1) - 1) / 2)))
    for ax in (0, 1):
        for _ in range(3): a = box(a, r, ax)
    return a
def maxf(a, r):
    from numpy.lib.stride_tricks import sliding_window_view as sw
    p = np.pad(a, r, mode='edge'); a = sw(p, 2 * r + 1, axis=1).max(-1); return sw(a, 2 * r + 1, axis=0).max(-1)
def minf(a, r): return -maxf(-a, r)
def sstep(a, b, x): t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)
_vn = {}
def vnoise(x, z, scale, seed):
    """Smooth value noise (−1..1) over the map at `scale` m (a lattice per seed)."""
    if (scale, seed) not in _vn:
        m = int((N * ST + 800) / scale) + 4; _vn[(scale, seed)] = np.random.default_rng(seed).uniform(-1, 1, (m, m))
    g = _vn[(scale, seed)]
    u = (x - OX + 400) / scale; v = (z - OZ + 400) / scale
    i = np.floor(u).astype(int); j = np.floor(v).astype(int); fu = u - i; fv = v - j
    fu = fu * fu * (3 - 2 * fu); fv = fv * fv * (3 - 2 * fv)
    return (g[j, i] * (1 - fu) + g[j, i + 1] * fu) * (1 - fv) + (g[j + 1, i] * (1 - fu) + g[j + 1, i + 1] * fu) * fv
def bilinear(img, u, v):
    h, w = img.shape
    u = np.clip(u, 0, w - 1.001); v = np.clip(v, 0, h - 1.001)
    i = u.astype(int); j = v.astype(int); fu = u - i; fv = v - j
    return (img[j, i] * (1 - fu) + img[j, i + 1] * fu) * (1 - fv) + (img[j + 1, i] * (1 - fu) + img[j + 1, i + 1] * fu) * fv

# ---------------------------------------------------------------- 5. protection (roads, set pieces, spawn)
dist = np.full((N, N), 1e9)
def stamp(px, pz, r):
    R = r + 21.0
    for x, z in zip(px, pz):
        i0 = max(0, int((z - R - OZ) / ST)); i1 = min(N, int((z + R - OZ) / ST) + 2)
        j0 = max(0, int((x - R - OX) / ST)); j1 = min(N, int((x + R - OX) / ST) + 2)
        if i0 >= i1 or j0 >= j1: continue
        d = np.hypot(X[i0:i1, j0:j1] - x, Z[i0:i1, j0:j1] - z) - r
        dist[i0:i1, j0:j1] = np.minimum(dist[i0:i1, j0:j1], d)
for rd in meta['roads']:
    rx, rz = np.array(rd['x'], float), np.array(rd['z'], float)
    px, pz = [], []
    for k in range(len(rx) - 1):
        n = max(1, int(math.hypot(rx[k + 1] - rx[k], rz[k + 1] - rz[k]) / 2)); t = np.arange(n) / n
        px.extend(rx[k] + (rx[k + 1] - rx[k]) * t); pz.extend(rz[k] + (rz[k + 1] - rz[k]) * t)
    px.append(rx[-1]); pz.append(rz[-1])
    stamp(px, pz, rd.get('halfWidth', 4) + 9)
ROADS = dist <= -9.0
props = json.load(open(os.path.join(MAP, 'props.json')))
pp = []
def walk(o, key=''):
    if isinstance(o, dict):
        for k, v in o.items(): walk(v, k)
    elif isinstance(o, list) and len(o) >= 5 and all(isinstance(v, (int, float)) for v in o[:5]):
        if key == 'pine': return  # (the game seats its trees on the ground)
        for k in range(0, len(o) - 4, 5): pp.append((o[k], o[k + 2]))
    elif isinstance(o, list):
        for v in o: walk(v, key)
walk(props['placements'])
stamp([p[0] for p in pp], [p[1] for p in pp], 10)
sp = meta['spawn']; stamp([sp[0]], [sp[1]], 30)
FREE = sstep(0, 12, dist)
fixed = FREE < 0.02
print(f'[{time.time() - t0:.0f}s] protected {100 * (FREE < 0.99).mean():.1f} %')

# the valley floor under every slope (the lowest ground within ~120 m, smoothed): "above" = height over it
floor = blur(minf(H0, 30), 20)
above = lambda Hh: Hh - floor

# ---------------------------------------------------------------- 1. strata
def hardness_at(h, x, z):
    ph = np.sin((h + 5 * vnoise(x, z, 110, 60)) * 2 * math.pi / 26.0)
    return 0.45 + 1.35 * sstep(0.2, 0.75, ph)

# ---------------------------------------------------------------- 2. droplets (zhangjiajie/terrain.py erode())
def erode(H, n_drops, steps=48, inertia=0.06, cap=5.0, min_cap=0.02, erode_r=0.35, depo_r=0.25, evap=0.02,
          grav=9.0, max_ero=1.5, batch=60000, seed=1):
    r_ = np.random.default_rng(seed)
    offs = [(dj, di) for dj in range(-2, 3) for di in range(-2, 3)]
    wts = np.array([math.exp(-(dj * dj + di * di) / 2.5) for dj, di in offs]); wts /= wts.sum()
    NE = H.shape[0]; done = 0
    flat = H.reshape(-1)
    while done < n_drops:
        n = min(batch, n_drops - done); done += n
        px = r_.uniform(2, NE - 3, n); pz = r_.uniform(2, NE - 3, n)
        dx = np.zeros(n); dz = np.zeros(n); sp_ = np.ones(n); wa = np.ones(n); sed = np.zeros(n)
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
            dh = bilinear(H, nx, nz) - hcur
            c = np.maximum(-dh * sp_ * wa * cap / 10.0, min_cap)
            k = hardness_at(hcur, OX + px * ST, OZ + pz * ST)
            depo = np.where((sed > c) | (dh > 0), np.where(dh > 0, np.minimum(dh, sed), (sed - c) * depo_r), 0.0)
            ero = np.where((sed <= c) & (dh <= 0), np.minimum(np.minimum((c - sed) * erode_r * k, -dh), max_ero), 0.0)
            f = FREE[j, i]
            depo *= alive * f; ero *= alive * f
            sed = sed - depo + ero
            idx = np.concatenate([j * NE + i, j * NE + i + 1, (j + 1) * NE + i, (j + 1) * NE + i + 1])
            np.add.at(flat, idx, np.concatenate([depo * (1 - fx) * (1 - fz), depo * fx * (1 - fz), depo * (1 - fx) * fz, depo * fx * fz]))
            sel = ero > 1e-6
            if sel.any():
                ie, je, ev = i[sel], j[sel], ero[sel]
                bi = np.concatenate([np.clip(je + dj, 0, NE - 1) * NE + np.clip(ie + di, 0, NE - 1) for dj, di in offs])
                np.subtract.at(flat, bi, np.concatenate([ev * w for w in wts]))
            sp_ = np.minimum(np.sqrt(np.maximum(0.0, sp_ * sp_ + (-dh) * grav / 10.0)), 12.0)
            wa *= (1 - evap)
            px, pz = nx, nz
            if not alive.any(): break
        print(f'  [{time.time() - t0:.0f}s] {done} drops')
    return H
H = erode(H, int(ARGS.get('DROPS', 900000)))
H = np.where(fixed, H0, H)

# ---------------------------------------------------------------- 3. rivers (flow accumulation) + scree
gz_, gx_ = np.gradient(H, ST); sl = np.hypot(gx_, gz_)
Hr_ = H + 2.5 * vnoise(X, Z, 18, 94) + 1.0 * vnoise(X, Z, 6, 95)   # (a rough surface: the runoff converges into rills)
Hp_ = np.pad(Hr_, 1, mode='edge')
best = np.zeros_like(H); rec = np.arange(N * N).reshape(N, N); idx_ = rec.copy()
for dj, di in ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)):
    d_ = (Hr_ - Hp_[1 + dj:1 + dj + N, 1 + di:1 + di + N]) / (math.hypot(dj, di) * ST)
    u_ = d_ > best
    best = np.where(u_, d_, best); rec = np.where(u_, np.clip(idx_ + dj * N + di, 0, N * N - 1), rec)
order = np.argsort(-Hr_.ravel()).tolist(); recl = rec.ravel().tolist(); Al = [1.0] * (N * N)
for k in order:
    r_ = recl[k]
    if r_ != k: Al[r_] += Al[k]
A = np.array(Al).reshape(N, N) * ST * ST
ab = above(H)
KG = float(ARGS.get('KG', 0.22)); GMAX = float(ARGS.get('GMAX', 10))
cut = np.minimum(GMAX, KG * A ** 0.45 * np.minimum(sl, 3.0) ** 0.8) * sstep(3, 18, ab) * sstep(0.15, 0.4, sl)
cut = np.maximum(cut, 0.6 * maxf(cut, 1) * (A > 400))
cut = blur(cut, 0.7)
# ---------------------------------------------------------------- 4. flutes + rims
fl = 1 - np.abs(vnoise(X, Z, 7, 91) * 0.7 + vnoise(X, Z, 3, 92) * 0.3)
flute = (fl ** 3) * 2.8 * sstep(0.6, 1.4, sl) * sstep(5, 20, ab)
crest = np.maximum(0, vnoise(X, Z, 5, 93)) * 1.8 * sstep(0.1, 0.5, sl) * sstep(12, 40, ab)
H = H - (cut + flute + crest) * FREE
# scree: loose ground over ~40° slides down (a few passes; not the bare walls: only where the slope is moderate already)
TAL = math.tan(math.radians(40)) * ST
for it in range(8):
    mv = np.zeros_like(H)
    for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nb = np.roll(np.roll(H, di, 0), dj, 1)
        d = H - nb - TAL
        m = np.where((d > 0) & (d < 2.5), d * 0.1, 0.0) * FREE
        mv -= m; mv += np.roll(np.roll(m, -di, 0), -dj, 1)
    H += mv
H[:2, :] = H0[:2, :]; H[-2:, :] = H0[-2:, :]; H[:, :2] = H0[:, :2]; H[:, -2:] = H0[:, -2:]
# water stays water, land stays land, the protected band exact
wet = H0 < WATER
H = np.where(wet, np.minimum(H, WATER - 0.3), np.maximum(H, WATER + 0.3))
H = H0 + (H - H0) * FREE
d = H - H0
print(f'[{time.time() - t0:.0f}s] sculpted: mean |dh| {np.abs(d).mean():.2f} m, p99 {np.percentile(np.abs(d), 99):.1f} m, cut {-d.min():.0f} m, fill {d.max():.0f} m')
np.save(os.path.join(OUT, 'H0.npy'), H0.astype(np.float32)); np.save(os.path.join(OUT, 'H1.npy'), H.astype(np.float32)); np.save(os.path.join(OUT, 'roads.npy'), ROADS)
if ARGS.get('WRITE') == '1':
    q = np.clip((H - OFF - G['min']) / G['range'], 0, 1)
    (q * 65535).round().astype('<u2').tofile(os.path.join(MAP, 'heights.bin'))
    print('wrote', os.path.join(MAP, 'heights.bin'))

# ---------------------------------------------------------------- 6. render (Cycles, as zhangjiajie/terrain.py)
if ARGS.get('RENDER', '0') != '1': sys.exit(0)
for o in list(bpy.data.objects): bpy.data.objects.remove(o)   # (a fresh background Blender: its default cube etc.)
def srgb(h):
    c = [int(h[k:k + 2], 16) / 255 for k in (0, 2, 4)]
    return [(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) for v in c] + [1]
def terrain_object(Hh, name):
    DEC = int(ARGS.get('DEC', 1))
    Hd = Hh[::DEC, ::DEC]; n = Hd.shape[0]; xd = xs[::DEC]
    XX, ZZ = np.meshgrid(xd, OZ + np.arange(0, N, DEC) * ST)
    verts = np.stack([XX.ravel(), -ZZ.ravel(), Hd.ravel()], 1)
    q = np.arange(n * n).reshape(n, n)
    faces = np.stack([q[:-1, :-1].ravel(), q[1:, :-1].ravel(), q[1:, 1:].ravel(), q[:-1, 1:].ravel()], 1)
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(verts)); me.vertices.foreach_set('co', verts.astype(np.float32).ravel())
    me.loops.add(faces.size); me.loops.foreach_set('vertex_index', faces.astype(np.int32).ravel())
    me.polygons.add(len(faces)); me.polygons.foreach_set('loop_start', (np.arange(len(faces)) * 4).astype(np.int32))
    me.polygons.foreach_set('loop_total', np.full(len(faces), 4, np.int32))
    me.update(); me.validate(); me.shade_flat()
    at = me.attributes.new('road', 'FLOAT', 'POINT'); at.data.foreach_set('value', ROADS[::DEC, ::DEC].ravel().astype(np.float32))
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    return ob
mat = bpy.data.materials.new('highlands'); mat.use_nodes = True
nt = mat.node_tree; N_ = nt.nodes; L_ = nt.links
for nd in list(N_): N_.remove(nd)
outn = N_.new('ShaderNodeOutputMaterial'); bsdf = N_.new('ShaderNodeBsdfPrincipled'); bsdf.inputs['Roughness'].default_value = 0.9
L_.new(bsdf.outputs['BSDF'], outn.inputs['Surface'])
geo = N_.new('ShaderNodeNewGeometry'); sep = N_.new('ShaderNodeSeparateXYZ'); L_.new(geo.outputs['Normal'], sep.inputs['Vector'])
tc = N_.new('ShaderNodeTexCoord')
def noise(scale, detail=4, rough=0.6, vec=None):
    nz = N_.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = scale; nz.inputs['Detail'].default_value = detail
    nz.inputs['Roughness'].default_value = rough
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
mapv = N_.new('ShaderNodeMapping'); L_.new(tc.outputs['Object'], mapv.inputs['Vector']); mapv.inputs['Scale'].default_value = (1.0, 1.0, 0.35)
rn = noise(0.06, 6, 0.65, mapv.outputs['Vector'])
rock = ramp(rn.outputs['Fac'], [(0.3, srgb('4d4f52')), (0.45, srgb('7d8085')), (0.58, srgb('a3a7ad')), (0.7, srgb('b8bcc2')), (0.8, srgb('8b7f6b'))])
vn = noise(0.04, 5, 0.6, mapv.outputs['Vector'])
vmask = ramp(vn.outputs['Fac'], [(0.5, (0, 0, 0, 1)), (0.56, (1, 1, 1, 1))])
gn = noise(0.05, 4, 0.7)
meadow = ramp(gn.outputs['Fac'], [(0.35, srgb('5dbb4a')), (0.55, srgb('8fd157')), (0.7, srgb('a8e063'))])
moss = ramp(gn.outputs['Fac'], [(0.3, srgb('2f5a22')), (0.7, srgb('4f8a34'))])
wallcol = mix(rock.outputs['Color'], moss.outputs['Color'], vmask.outputs['Color'])
slope = ramp(sep.outputs['Z'], [(0.62, (0, 0, 0, 1)), (0.75, (1, 1, 1, 1))])
col = mix(wallcol, meadow.outputs['Color'], slope.outputs['Color'])
atn = N_.new('ShaderNodeAttribute'); atn.attribute_name = 'road'
dirt = N_.new('ShaderNodeRGB'); dirt.outputs[0].default_value = srgb('b49a6a')
col = mix(col, dirt.outputs[0], atn.outputs['Fac'])
L_.new(col, bsdf.inputs['Base Color'])
bn = noise(0.5, 4, 0.75); bump = N_.new('ShaderNodeBump'); bump.inputs['Strength'].default_value = 0.4; bump.inputs['Distance'].default_value = 2.0
L_.new(bn.outputs['Fac'], bump.inputs['Height']); L_.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
wmat = bpy.data.materials.new('water'); wmat.use_nodes = True
wb = wmat.node_tree.nodes['Principled BSDF']; wb.inputs['Base Color'].default_value = srgb('2e7fb8'); wb.inputs['Roughness'].default_value = 0.08
bpy.ops.mesh.primitive_plane_add(size=N * ST + 400, location=(0, 0, WATER)); bpy.context.active_object.data.materials.append(wmat)

sc = bpy.context.scene
w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
wn = w.node_tree.nodes; wl = w.node_tree.links
for nd in list(wn): wn.remove(nd)
sky = wn.new('ShaderNodeTexSky')
for k, v in (('sun_elevation', math.radians(38)), ('sun_rotation', math.radians(140)), ('air_density', 1.4), ('dust_density', 2.0)):
    if hasattr(sky, k): setattr(sky, k, v)
bg = wn.new('ShaderNodeBackground'); bg.inputs['Strength'].default_value = 0.25
wo = wn.new('ShaderNodeOutputWorld'); wl.new(sky.outputs['Color'], bg.inputs['Color']); wl.new(bg.outputs['Background'], wo.inputs['Surface'])
sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = 3.0; sun.angle = math.radians(1.5)
so = bpy.data.objects.new('sun', sun); so.rotation_euler = (math.radians(52), 0, math.radians(140)); sc.collection.objects.link(so)
sc.render.engine = 'CYCLES'
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for dt in ('OPTIX', 'CUDA'):
        try:
            prefs.compute_device_type = dt; prefs.get_devices()
            if any(d.type == dt for d in prefs.devices): break
        except Exception: pass
    for d in prefs.devices: d.use = True
    sc.cycles.device = 'GPU'
except Exception as ex:
    print('cpu render', ex)
sc.cycles.samples = int(ARGS.get('SAMPLES', 48)); sc.cycles.use_denoising = True
sc.render.resolution_x = int(ARGS.get('W', 1280)); sc.render.resolution_y = int(ARGS.get('H', 720))
sc.view_settings.view_transform = 'AgX'
sc.view_settings.exposure = float(ARGS.get('EXPOSURE', -0.6))  # (the Nishita sky over a pale meadow washed out to white)

def hs(x, z, Hh):
    return float(bilinear(Hh, np.array([(x - OX) / ST]), np.array([(z - OZ) / ST]))[0])
def shot(name, loc, target, lens=35):
    cam = bpy.data.cameras.new(name); cam.lens = lens; cam.clip_end = 20000
    co = bpy.data.objects.new(name, cam); sc.collection.objects.link(co)
    co.location = loc
    dd = np.array(target, float) - np.array(loc, float)
    co.rotation_euler = (math.pi / 2 + math.atan2(dd[2], math.hypot(dd[0], dd[1])), 0, math.atan2(dd[1], dd[0]) - math.pi / 2)
    sc.camera = co
    sc.render.filepath = os.path.join(OUT, f'{name}.png')
    bpy.ops.render.render(write_still=True)
    print(f'[{time.time() - t0:.0f}s] rendered', sc.render.filepath)
# views (map x, z; Blender y = −z): the spawn valley, the north-west cliffs, the summit, an aerial
VIEWS = [('spawn', (-930, -230), (-820, -300), 14), ('cliffs', (-850, 470), (-850, 650), 60), ('summit', (-300, -330), (-450, -550), 90),
         ('aerial', (-1000, 900), (-300, 200), 650)]
terr = {}
for tag, Hh in (('after', H), ('before', H0)):
    for o in list(sc.collection.objects):
        if o.name.startswith('terrain'): bpy.data.objects.remove(o)
    ob = terrain_object(Hh, 'terrain_' + tag); ob.data.materials.append(mat)
    for name, (ex, ez), (tx, tz), up in VIEWS:
        eh = hs(ex, ez, Hh) + up; th = hs(tx, tz, Hh) + 5
        shot(f'{name}_{tag}', (ex, -ez, eh), (tx, -tz, th), 26 if up < 30 else 30)
